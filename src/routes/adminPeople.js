const express = require('express');
const db = require('../config/db');
const { authenticate, requireActive, requireRole } = require('../middleware/auth');
const { wrap, HttpError } = require('../utils/errors');
const v = require('../utils/validate');
const audit = require('../services/audit');
const settings = require('../services/settings');

const router = express.Router();
const superOnly = [authenticate, requireActive, requireRole('super_admin')];
for (const p of ['/overview', '/players', '/settings', '/games', '/audit', '/referrals']) router.use(p, superOnly);

router.get('/overview', wrap(async (req, res) => {
  const { rows } = await db.query(`SELECT
    (SELECT count(*) FROM users)::int AS players,
    (SELECT count(*) FROM users WHERE status='active')::int AS active_players,
    (SELECT count(*) FROM users WHERE status='suspended')::int AS suspended_players,
    (SELECT count(*) FROM users WHERE role='host')::int AS hosts,
    (SELECT count(*) FROM games WHERE enabled)::int AS enabled_games,
    (SELECT count(*) FROM tournaments WHERE status IN ('published','full','scheduled','registration_closed'))::int AS upcoming,
    (SELECT count(*) FROM tournaments WHERE status='live')::int AS live,
    (SELECT count(*) FROM tournaments WHERE status='completed')::int AS completed,
    (SELECT count(*) FROM registrations WHERE status='reserved')::int AS awaiting_payment,
    (SELECT count(*) FROM registrations WHERE status='confirmed')::int AS verified_registrations,
    (SELECT count(*) FROM withdrawal_requests WHERE status='pending')::int AS withdrawals_pending,
    (SELECT count(*) FROM withdrawal_requests WHERE status IN ('approved','processing'))::int AS withdrawals_processing,
    (SELECT COALESCE(sum(amount_paise),0) FROM payments WHERE status='success')::bigint AS verified_payments_paise,
    (SELECT COALESCE(sum(prize_paise),0) FROM result_entries re JOIN tournament_results tr ON tr.id=re.result_id AND tr.status='finalized')::bigint AS finalized_prizes_paise`);
  const recent = (await db.query(
    'SELECT a.action, a.resource_type, a.resource_id, a.created_at, u.display_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.id DESC LIMIT 8'
  )).rows;
  res.json({ stats: rows[0], recent });
}));

router.get('/players', wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const { rows } = await db.query(
    `SELECT id, display_name, email, role, status, created_at FROM users
     WHERE ($1 = '' OR display_name ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%' OR id::text = $1)
     ORDER BY id DESC LIMIT 50`, [q]
  );
  res.json({ players: rows });
}));

router.patch('/players/:id/status', wrap(async (req, res) => {
  const id = v.int(req.params.id, 'id', { min: 1 });
  const status = v.oneOf(req.body.status, 'status', ['active', 'suspended', 'disabled']);
  const reason = status === 'active' ? null : v.str(req.body.reason, 'reason', { min: 3, max: 300 });
  if (id === req.user.id) throw new HttpError(400, 'SELF_ACTION', 'You cannot change your own status.');
  const target = (await db.query('SELECT role FROM users WHERE id=$1', [id])).rows[0];
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  if (target.role === 'super_admin') throw new HttpError(403, 'PROTECTED', 'Super Admin accounts are protected.');
  await db.query(
    `UPDATE users SET status=$2, suspended_at=CASE WHEN $2='active' THEN NULL ELSE now() END, suspension_reason=$3, updated_at=now() WHERE id=$1`,
    [id, status, reason]
  );
  await audit(db, { actor: req.user.id, action: `user.${status}`, type: 'user', id, reason });
  res.json({ ok: true });
}));

// Only players <-> hosts here. super_admin is assigned exclusively by the one-time bootstrap script.
router.patch('/players/:id/role', wrap(async (req, res) => {
  const id = v.int(req.params.id, 'id', { min: 1 });
  const role = v.oneOf(req.body.role, 'role', ['player', 'host']);
  const reason = v.str(req.body.reason || 'role change', 'reason', { min: 3, max: 300 });
  if (id === req.user.id) throw new HttpError(400, 'SELF_ACTION', 'You cannot change your own role.');
  await db.tx(async (c) => {
    const target = (await c.query('SELECT role FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!target) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    if (target.role === 'super_admin') throw new HttpError(403, 'PROTECTED', 'Super Admin accounts are protected.');
    await c.query('DELETE FROM host_game_permissions WHERE user_id=$1', [id]);
    if (role === 'host') {
      const games = Array.isArray(req.body.games) ? req.body.games : [];
      if (!games.length) throw new HttpError(400, 'INVALID_INPUT', 'Assign at least one game to the host.');
      for (const g of games) {
        await c.query(
          `INSERT INTO host_game_permissions(user_id,game_id,publish_policy,can_manage_results,can_finalize_results,created_by) VALUES($1,$2,$3,$4,$5,$6)`,
          [id, v.int(g.game_id, 'game_id', { min: 1 }), v.oneOf(g.publish_policy || 'approval', 'publish_policy', ['direct', 'approval']),
            v.bool(g.can_manage_results), v.bool(g.can_finalize_results), req.user.id]
        );
      }
    }
    await c.query('UPDATE users SET role=$2, updated_at=now() WHERE id=$1', [id, role]);
    await audit(c, { actor: req.user.id, action: `user.role_${role}`, type: 'user', id, reason });
  });
  res.json({ ok: true });
}));

router.get('/games', wrap(async (req, res) => {
  res.json({ games: (await db.query('SELECT * FROM games ORDER BY display_order')).rows });
}));

router.put('/games/:id', wrap(async (req, res) => {
  const id = v.int(req.params.id, 'id', { min: 1 });
  const b = req.body;
  const { rowCount } = await db.query(
    'UPDATE games SET enabled=$2, creation_enabled=$3, coming_soon=$4 WHERE id=$1', [id, v.bool(b.enabled), v.bool(b.creation_enabled), v.bool(b.coming_soon)]
  );
  if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'Game not found');
  await audit(db, { actor: req.user.id, action: 'game.updated', type: 'game', id, meta: { enabled: v.bool(b.enabled) } });
  res.json({ ok: true });
}));

const SETTING_RULES = {
  platform_title: (x) => v.str(x, 'platform_title', { max: 40 }),
  support_contact: (x) => v.optStr(x, 'support_contact', 120) || '',
  terms_url: (x) => v.optStr(x, 'terms_url', 300) || '',
  discord_invite_url: (x) => { const s = v.optStr(x, 'discord_invite_url', 200) || ''; if (s && !/^https:\/\//.test(s)) throw new HttpError(400, 'INVALID_INPUT', 'Discord link must start with https://'); return s; },
  reveal_offset_seconds: (x) => v.int(x, 'reveal_offset_seconds', { min: 0, max: 3600 }),
  reservation_minutes: (x) => v.int(x, 'reservation_minutes', { min: 5, max: 120 }),
  withdraw_min_paise: (x) => v.int(x, 'withdraw_min_paise', { min: 100 }),
  withdraw_fee_bps: (x) => v.int(x, 'withdraw_fee_bps', { min: 0, max: 5000 }),
  deposit_eta_text: (x) => v.str(x, 'deposit_eta_text', { max: 60 }),
  withdraw_eta_text: (x) => v.str(x, 'withdraw_eta_text', { max: 60 }),
  no_show_delay_seconds: (x) => v.int(x, 'no_show_delay_seconds', { min: 0, max: 3600 }),
  referral_enabled: (x) => v.bool(x),
  referral_referrer_reward_paise: (x) => v.int(x, 'referrer reward', { min: 0, max: 1000000 }),
  referral_referee_reward_paise: (x) => v.int(x, 'friend reward', { min: 0, max: 1000000 }),
  referral_min_entry_paise: (x) => v.int(x, 'minimum entry', { min: 0, max: 10000000 }),
  referral_credit_account: (x) => v.oneOf(x, 'credit account', ['deposit', 'winnings']),
  help_title: (x) => v.str(x, 'help_title', { max: 60 }),
  help_intro: (x) => v.optStr(x, 'help_intro', 400) || '',
  help_faq: (x) => {
    if (!Array.isArray(x) || x.length > 20) throw new HttpError(400, 'INVALID_INPUT', 'FAQ list is invalid');
    return x.map((f) => ({ q: v.str(f.q, 'question', { max: 200 }), a: v.str(f.a, 'answer', { max: 1000 }) }));
  },
};

router.get('/settings', wrap(async (req, res) => res.json({ settings: await settings.all() })));

router.put('/settings', wrap(async (req, res) => {
  const changed = [];
  await db.tx(async (c) => {
    for (const [k, fn] of Object.entries(SETTING_RULES)) {
      if (req.body[k] === undefined) continue;
      await settings.set(c, k, fn(req.body[k]), req.user.id); // applies to FUTURE transactions; each withdrawal stores its own fee snapshot
      changed.push(k);
    }
    await audit(c, { actor: req.user.id, action: 'settings.updated', meta: { keys: changed } });
  });
  res.json({ ok: true, changed });
}));

router.get('/referrals', wrap(async (req, res) => {
  const stats = (await db.query(
    `SELECT count(*)::int AS total, (count(*) FILTER (WHERE status='pending'))::int AS pending,
            (count(*) FILTER (WHERE status='rewarded'))::int AS rewarded, (count(*) FILTER (WHERE status='void'))::int AS void,
            COALESCE(sum(COALESCE(referrer_reward_paise,0)+COALESCE(referee_reward_paise,0)) FILTER (WHERE status='rewarded'),0)::bigint AS paid_paise
     FROM referrals`
  )).rows[0];
  const { rows } = await db.query(
    `SELECT r.id, r.status, r.created_at, r.rewarded_at, a.display_name AS referrer_name, a.email AS referrer_email,
            b.display_name AS referred_name, b.email AS referred_email
     FROM referrals r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referred_id ORDER BY r.id DESC LIMIT 100`
  );
  res.json({ stats: { ...stats, paid_paise: Number(stats.paid_paise) }, referrals: rows });
}));

// Pending referrals can be voided (fraud control). Rewards already paid are never clawed back silently.
router.post('/referrals/:id/void', wrap(async (req, res) => {
  const id = v.int(req.params.id, 'id', { min: 1 });
  const reason = v.str(req.body.reason, 'reason', { min: 3, max: 300 });
  const { rowCount } = await db.query("UPDATE referrals SET status='void' WHERE id=$1 AND status='pending'", [id]);
  if (!rowCount) throw new HttpError(409, 'BAD_STATE', 'Only pending referrals can be voided.');
  await audit(db, { actor: req.user.id, action: 'referral.voided', type: 'referral', id, reason });
  res.json({ ok: true });
}));

router.get('/audit', wrap(async (req, res) => {
  const { rows } = await db.query(
    'SELECT a.id, a.action, a.resource_type, a.resource_id, a.reason, a.created_at, u.display_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.id DESC LIMIT 100'
  );
  res.json({ logs: rows });
}));

module.exports = router;
