const express = require('express');
const db = require('../config/db');
const settings = require('../services/settings');
const { optionalAuth } = require('../middleware/auth');
const { wrap, HttpError } = require('../utils/errors');

const router = express.Router();

router.get('/config', wrap(async (req, res) => {
  const s = await settings.all();
  const boot = process.env.BOOTSTRAP_ADMIN_ENABLED === 'true' && process.env.ADMIN_EMAIL;
  res.json({
    firebase: {
      apiKey: process.env.FIREBASE_WEB_API_KEY || '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
      projectId: process.env.FIREBASE_PROJECT_ID || '',
      appId: process.env.FIREBASE_APP_ID || '',
    },
    platform_title: s.platform_title,
    discord_invite_url: s.discord_invite_url,
    support_contact: s.support_contact,
    deposit_eta_text: s.deposit_eta_text,
    withdraw_eta_text: s.withdraw_eta_text,
    withdraw_min_paise: s.withdraw_min_paise,
    withdraw_fee_bps: s.withdraw_fee_bps,
    min_deposit_paise: s.min_deposit_paise,
    referral_enabled: s.referral_enabled,
    referral_referrer_reward_paise: s.referral_referrer_reward_paise,
    referral_referee_reward_paise: s.referral_referee_reward_paise,
    referral_min_entry_paise: s.referral_min_entry_paise,
    help_title: s.help_title,
    help_intro: s.help_intro,
    help_faq: s.help_faq,
    // The "admin" username alias only works while one-time bootstrap mode is on.
    admin_alias: boot ? { username: process.env.ADMIN_USERNAME || 'admin', email: process.env.ADMIN_EMAIL } : null,
  });
}));

router.get('/games', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT id, slug, name, enabled, coming_soon FROM games ORDER BY display_order');
  res.json({ games: rows });
}));

const LIST_SQL = `
  SELECT t.id, t.title, t.description, t.status, t.format, t.entry_fee_paise, t.prize_pool_paise, t.capacity,
         t.scheduled_start_at, t.registration_closes_at, t.timezone, t.rules, t.reveal_offset_seconds,
         g.slug AS game_slug, g.name AS game_name,
         (SELECT count(*) FROM registrations r WHERE r.tournament_id=t.id AND r.status IN ('reserved','confirmed'))::int AS filled,
         (SELECT count(*) FROM slot_resales s WHERE s.tournament_id=t.id AND s.status='open')::int AS resale_open
  FROM tournaments t JOIN games g ON g.id=t.game_id`;

async function decorate(rows, user) {
  const s = await settings.all();
  const mine = {};
  if (user && rows.length) {
    const r = await db.query(
      "SELECT tournament_id, status, slot_number FROM registrations WHERE player_id=$1 AND tournament_id = ANY($2) AND status IN ('reserved','confirmed','absent')",
      [user.id, rows.map((x) => x.id)]
    );
    for (const x of r.rows) mine[x.tournament_id] = x;
  }
  return rows.map((t) => {
    const offset = t.reveal_offset_seconds ?? s.reveal_offset_seconds;
    const { reveal_offset_seconds, ...rest } = t;
    return {
      ...rest,
      reveal_at: new Date(new Date(t.scheduled_start_at).getTime() - offset * 1000).toISOString(),
      my_registration: mine[t.id] || null,
    };
  });
}

router.get('/tournaments', optionalAuth, wrap(async (req, res) => {
  const game = typeof req.query.game === 'string' ? req.query.game : null;
  const { rows } = await db.query(
    `${LIST_SQL} WHERE t.status IN ('published','full','registration_closed','scheduled','live') AND ($1::text IS NULL OR g.slug=$1)
     ORDER BY t.scheduled_start_at ASC LIMIT 100`, [game]
  );
  const now = (await db.query('SELECT now() AS n')).rows[0].n;
  res.set('Cache-Control', 'no-store');
  res.json({ server_now: now, tournaments: await decorate(rows, req.user) });
}));

router.get('/tournaments/:id', optionalAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) throw new HttpError(404, 'NOT_FOUND', 'Tournament not found');
  const { rows } = await db.query(`${LIST_SQL} WHERE t.id=$1 AND t.status <> 'draft'`, [id]);
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Tournament not found');
  const resales = (await db.query(
    "SELECT id, slot_number, resale_price_paise FROM slot_resales WHERE tournament_id=$1 AND status='open' ORDER BY slot_number", [id]
  )).rows;
  const now = (await db.query('SELECT now() AS n')).rows[0].n;
  res.set('Cache-Control', 'no-store');
  res.json({ server_now: now, tournament: (await decorate(rows, req.user))[0], resales });
}));

router.get('/leaderboard', wrap(async (req, res) => {
  const game = typeof req.query.game === 'string' && req.query.game !== 'all' ? req.query.game : null;
  const page = Math.max(0, Number(req.query.page) || 0);
  const s = await settings.all();
  // Only FINALIZED results count. Tie-break (documented default): wins, then winnings, then tournaments played, then id.
  const { rows } = await db.query(
    `WITH g AS (SELECT id FROM games WHERE $1::text IS NULL OR slug=$1),
     played AS (
       SELECT r.player_id, count(*)::int AS played FROM registrations r
       JOIN tournaments t ON t.id=r.tournament_id AND t.status='completed' AND t.game_id IN (SELECT id FROM g)
       WHERE r.status='confirmed' GROUP BY r.player_id),
     res AS (
       SELECT re.player_id, count(*) FILTER (WHERE re.placement=1)::int AS wins, COALESCE(sum(re.prize_paise),0)::bigint AS winnings
       FROM result_entries re
       JOIN tournament_results tr ON tr.id=re.result_id AND tr.status='finalized'
       JOIN tournaments t ON t.id=tr.tournament_id AND t.game_id IN (SELECT id FROM g)
       GROUP BY re.player_id)
     SELECT u.id, u.display_name, COALESCE(res.wins,0) AS wins, played.played, COALESCE(res.winnings,0) AS winnings
     FROM users u JOIN played ON played.player_id=u.id LEFT JOIN res ON res.player_id=u.id
     WHERE u.status='active'
     ORDER BY wins DESC, winnings DESC, played.played DESC, u.id ASC LIMIT 50 OFFSET $2`,
    [game, page * 50]
  );
  res.json({
    page,
    players: rows.map((r, i) => ({
      rank: page * 50 + i + 1, id: r.id, display_name: r.display_name, wins: r.wins, played: r.played,
      winnings_paise: s.show_winnings ? Number(r.winnings) : null,
    })),
  });
}));

module.exports = router;
