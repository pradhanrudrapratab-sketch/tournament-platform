const express = require('express');
const db = require('../config/db');
const { authenticate, requireActive, requireRole } = require('../middleware/auth');
const { wrap, HttpError } = require('../utils/errors');
const v = require('../utils/validate');
const audit = require('../services/audit');
const regs = require('../services/registrationService');
const ledger = require('../services/ledger');
const settings = require('../services/settings');
const { encrypt } = require('../utils/crypto');

const router = express.Router();
const guard = [authenticate, requireActive, requireRole('host', 'super_admin')];
router.use('/tournaments', guard);
router.use('/registrations', guard);

async function perm(user, gameId) {
  if (user.role === 'super_admin') return { publish_policy: 'direct', can_manage_results: true, can_finalize_results: true };
  const { rows } = await db.query('SELECT * FROM host_game_permissions WHERE user_id=$1 AND game_id=$2', [user.id, gameId]);
  if (!rows[0]) throw new HttpError(403, 'NO_GAME_PERMISSION', 'You are not assigned to this game.');
  return rows[0];
}

async function loadOwned(user, id, client = db) {
  const { rows } = await client.query('SELECT * FROM tournaments WHERE id=$1', [id]);
  const t = rows[0];
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Tournament not found');
  if (user.role !== 'super_admin') {
    if (t.host_id !== user.id) throw new HttpError(403, 'NOT_YOUR_TOURNAMENT', 'This tournament belongs to another host.');
    await perm(user, t.game_id);
  }
  return t;
}

const TRANSITIONS = {
  draft: ['published', 'cancelled'],
  published: ['registration_closed', 'full', 'scheduled', 'live', 'cancelled'],
  full: ['published', 'scheduled', 'live', 'cancelled'],
  registration_closed: ['published', 'live', 'cancelled'],
  scheduled: ['live', 'cancelled'],
  live: ['pending_result', 'cancelled'],
  pending_result: ['completed'],
};
function assertTransition(t, to) {
  if (!(TRANSITIONS[t.status] || []).includes(to)) throw new HttpError(409, 'BAD_TRANSITION', `Cannot move from ${t.status} to ${to}.`);
}

async function setStatus(id, to, extra = '') {
  try {
    await db.query(`UPDATE tournaments SET status=$2, updated_at=now() ${extra} WHERE id=$1`, [id, to]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'HOST_ACTIVE_LIMIT', 'A host can run only one active tournament at a time.');
    throw e;
  }
}

router.get('/tournaments', wrap(async (req, res) => {
  const where = req.user.role === 'super_admin' ? '' : 'WHERE t.host_id=$1';
  const { rows } = await db.query(
    `SELECT t.id, t.title, t.status, t.approval_requested, t.entry_fee_paise, t.prize_pool_paise, t.capacity, t.scheduled_start_at,
            g.name AS game_name, u.display_name AS host_name,
            (SELECT count(*) FROM registrations r WHERE r.tournament_id=t.id AND r.status IN ('reserved','confirmed'))::int AS filled
     FROM tournaments t JOIN games g ON g.id=t.game_id JOIN users u ON u.id=t.host_id ${where}
     ORDER BY t.created_at DESC LIMIT 100`, where ? [req.user.id] : []
  );
  res.json({ tournaments: rows });
}));

function readFields(b, partial) {
  const f = {};
  const set = (k, val) => { f[k] = val; };
  if (!partial || b.title !== undefined) set('title', v.str(b.title, 'title', { min: 3, max: 80 }));
  if (!partial || b.description !== undefined) set('description', v.optStr(b.description, 'description', 1000));
  if (!partial || b.rules !== undefined) set('rules', v.optStr(b.rules, 'rules', 4000));
  if (!partial || b.entry_fee_paise !== undefined) set('entry_fee_paise', v.int(b.entry_fee_paise ?? 0, 'entry_fee_paise', { max: 10000000 }));
  if (!partial || b.prize_pool_paise !== undefined) set('prize_pool_paise', v.int(b.prize_pool_paise ?? 0, 'prize_pool_paise', { max: 100000000 }));
  if (!partial || b.capacity !== undefined) set('capacity', v.int(b.capacity, 'capacity', { min: 2, max: 1000 }));
  if (!partial || b.scheduled_start_at !== undefined) set('scheduled_start_at', v.date(b.scheduled_start_at, 'scheduled_start_at'));
  if (b.registration_opens_at !== undefined) set('registration_opens_at', v.optDate(b.registration_opens_at, 'registration_opens_at'));
  if (b.registration_closes_at !== undefined) set('registration_closes_at', v.optDate(b.registration_closes_at, 'registration_closes_at'));
  return f;
}

router.post('/tournaments', wrap(async (req, res) => {
  const b = req.body;
  const game = (await db.query('SELECT * FROM games WHERE id=$1', [v.int(b.game_id, 'game_id', { min: 1 })])).rows[0];
  if (!game || !game.enabled || !game.creation_enabled) throw new HttpError(409, 'GAME_DISABLED', 'This game is not open for tournaments.');
  await perm(req.user, game.id);
  const f = readFields(b, false);
  if (f.scheduled_start_at <= new Date()) throw new HttpError(400, 'INVALID_INPUT', 'Start time must be in the future.');
  if (f.registration_closes_at && f.registration_closes_at > f.scheduled_start_at) throw new HttpError(400, 'INVALID_INPUT', 'Registration must close before the start.');
  const { rows } = await db.query(
    `INSERT INTO tournaments(game_id,host_id,host_limited,title,description,rules,entry_fee_paise,prize_pool_paise,capacity,
        scheduled_start_at,registration_opens_at,registration_closes_at,room_id_enc,room_password_enc)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [game.id, req.user.id, req.user.role === 'host', f.title, f.description, f.rules, f.entry_fee_paise, f.prize_pool_paise, f.capacity,
      f.scheduled_start_at, f.registration_opens_at || null, f.registration_closes_at || null,
      encrypt(v.optStr(b.room_id, 'room_id', 100)), encrypt(v.optStr(b.room_password, 'room_password', 100))]
  );
  await audit(db, { actor: req.user.id, action: 'tournament.created', type: 'tournament', id: rows[0].id });
  res.status(201).json({ id: rows[0].id });
}));

router.patch('/tournaments/:id', wrap(async (req, res) => {
  const t = await loadOwned(req.user, v.int(req.params.id, 'id', { min: 1 }));
  if (['completed', 'cancelled'].includes(t.status)) throw new HttpError(409, 'LOCKED', 'This tournament can no longer be edited.');
  const f = readFields(req.body, true);
  if (t.status !== 'draft') { delete f.entry_fee_paise; delete f.capacity; } // money and capacity are fixed once published
  const cols = [];
  const vals = [t.id];
  for (const [k, val] of Object.entries(f)) { vals.push(val); cols.push(`${k}=$${vals.length}`); }
  let credsChanged = false;
  if (req.body.room_id !== undefined) { vals.push(encrypt(v.optStr(req.body.room_id, 'room_id', 100))); cols.push(`room_id_enc=$${vals.length}`); credsChanged = true; }
  if (req.body.room_password !== undefined) { vals.push(encrypt(v.optStr(req.body.room_password, 'room_password', 100))); cols.push(`room_password_enc=$${vals.length}`); credsChanged = true; }
  if (!cols.length) return res.json({ ok: true });
  await db.query(`UPDATE tournaments SET ${cols.join(',')}, updated_at=now() WHERE id=$1`, vals);
  // Reveal time is derived from scheduled_start_at on every read, so a schedule change recalculates it automatically.
  await audit(db, { actor: req.user.id, action: credsChanged ? 'tournament.room_credentials_changed' : 'tournament.updated', type: 'tournament', id: t.id, meta: { fields: Object.keys(f) } });
  res.json({ ok: true });
}));

router.post('/tournaments/:id/publish', wrap(async (req, res) => {
  const t = await loadOwned(req.user, v.int(req.params.id, 'id', { min: 1 }));
  assertTransition(t, 'published');
  const p = await perm(req.user, t.game_id);
  if (req.user.role === 'host' && p.publish_policy === 'approval') {
    await db.query('UPDATE tournaments SET approval_requested=true, updated_at=now() WHERE id=$1', [t.id]);
    await audit(db, { actor: req.user.id, action: 'tournament.approval_requested', type: 'tournament', id: t.id });
    return res.json({ ok: true, pending_approval: true });
  }
  await setStatus(t.id, 'published', ', approval_requested=false, published_at=now()');
  await audit(db, { actor: req.user.id, action: 'tournament.published', type: 'tournament', id: t.id });
  res.json({ ok: true });
}));

router.post('/tournaments/:id/start', wrap(async (req, res) => {
  const t = await loadOwned(req.user, v.int(req.params.id, 'id', { min: 1 }));
  assertTransition(t, 'live');
  await setStatus(t.id, 'live');
  await audit(db, { actor: req.user.id, action: 'tournament.started', type: 'tournament', id: t.id });
  res.json({ ok: true });
}));

router.post('/tournaments/:id/end', wrap(async (req, res) => {
  const t = await loadOwned(req.user, v.int(req.params.id, 'id', { min: 1 }));
  assertTransition(t, 'pending_result'); // not "completed": a result must be finalized by an authorized admin
  await setStatus(t.id, 'pending_result');
  await audit(db, { actor: req.user.id, action: 'tournament.ended', type: 'tournament', id: t.id });
  res.json({ ok: true });
}));

router.post('/tournaments/:id/cancel', wrap(async (req, res) => {
  const t = await loadOwned(req.user, v.int(req.params.id, 'id', { min: 1 }));
  assertTransition(t, 'cancelled');
  const reason = v.str(req.body.reason, 'reason', { min: 3, max: 300 });
  await db.tx(async (c) => {
    await c.query("UPDATE tournaments SET status='cancelled', updated_at=now() WHERE id=$1", [t.id]);
    await regs.refundTournament(c, t.id); // confirmed entries go back to the deposit wallet, exactly once
    await audit(c, { actor: req.user.id, action: 'tournament.cancelled', type: 'tournament', id: t.id, reason });
  });
  res.json({ ok: true });
}));

router.get('/tournaments/:id/participants', wrap(async (req, res) => {
  const t = await loadOwned(req.user, v.int(req.params.id, 'id', { min: 1 }));
  const { rows } = await db.query(
    `SELECT r.id AS registration_id, r.player_id, r.slot_number, r.status, r.entry_fee_paise, u.display_name,
            (SELECT count(*) FROM slot_resales s WHERE s.tournament_id=r.tournament_id AND s.slot_number=r.slot_number)::int AS resales_used
     FROM registrations r JOIN users u ON u.id=r.player_id
     WHERE r.tournament_id=$1 AND r.status IN ('confirmed','absent') ORDER BY r.slot_number`, [t.id]
  );
  const result = (await db.query('SELECT status FROM tournament_results WHERE tournament_id=$1', [t.id])).rows[0] || null;
  res.json({ tournament: { id: t.id, title: t.title, status: t.status, prize_pool_paise: Number(t.prize_pool_paise) }, participants: rows, result });
}));

// ---- Results: submission and finalization are separate actions ----
router.post('/tournaments/:id/results', wrap(async (req, res) => {
  const t = await loadOwned(req.user, v.int(req.params.id, 'id', { min: 1 }));
  const p = await perm(req.user, t.game_id);
  if (!p.can_manage_results) throw new HttpError(403, 'FORBIDDEN', 'You cannot submit results for this game.');
  if (t.status !== 'pending_result') throw new HttpError(409, 'BAD_STATE', 'End the tournament before submitting results.');
  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
  if (!entries.length || entries.length > 200) throw new HttpError(400, 'INVALID_INPUT', 'Add at least one placement.');
  const seen = new Set();
  let prizeTotal = 0;
  const clean = [];
  const confirmed = (await db.query("SELECT id, player_id FROM registrations WHERE tournament_id=$1 AND status='confirmed'", [t.id])).rows;
  const byPlayer = new Map(confirmed.map((r) => [r.player_id, r.id]));
  for (const e of entries) {
    const pid = v.int(e.player_id, 'player_id', { min: 1 });
    if (!byPlayer.has(pid) || seen.has(pid)) throw new HttpError(400, 'INVALID_INPUT', 'Results can only include each confirmed player once.');
    seen.add(pid);
    const prize = v.int(e.prize_paise ?? 0, 'prize_paise', { max: 100000000 });
    prizeTotal += prize;
    clean.push({ pid, rid: byPlayer.get(pid), placement: v.int(e.placement, 'placement', { min: 1, max: 1000 }), prize });
  }
  if (prizeTotal > Number(t.prize_pool_paise)) throw new HttpError(400, 'PRIZE_EXCEEDS_POOL', 'Prizes add up to more than the prize pool.');
  await db.tx(async (c) => {
    const existing = (await c.query('SELECT * FROM tournament_results WHERE tournament_id=$1 FOR UPDATE', [t.id])).rows[0];
    if (existing && existing.status === 'finalized') throw new HttpError(409, 'FINALIZED', 'Result is already finalized.');
    const rid = existing ? existing.id : (await c.query('INSERT INTO tournament_results(tournament_id, submitted_by) VALUES($1,$2) RETURNING id', [t.id, req.user.id])).rows[0].id;
    await c.query('DELETE FROM result_entries WHERE result_id=$1', [rid]);
    for (const e of clean) {
      await c.query('INSERT INTO result_entries(result_id,player_id,registration_id,placement,prize_paise) VALUES($1,$2,$3,$4,$5)', [rid, e.pid, e.rid, e.placement, e.prize]);
    }
    await audit(c, { actor: req.user.id, action: 'result.submitted', type: 'tournament', id: t.id });
  });
  res.json({ ok: true });
}));

router.post('/tournaments/:id/results/confirm', wrap(async (req, res) => {
  const t = await loadOwned(req.user, v.int(req.params.id, 'id', { min: 1 }));
  const p = await perm(req.user, t.game_id);
  if (!(req.user.role === 'super_admin' || p.can_finalize_results)) throw new HttpError(403, 'FORBIDDEN', 'Only a Super Admin can finalize results.');
  await db.tx(async (c) => {
    const r = (await c.query('SELECT * FROM tournament_results WHERE tournament_id=$1 FOR UPDATE', [t.id])).rows[0];
    if (!r) throw new HttpError(409, 'NO_RESULT', 'Submit a result first.');
    if (r.status === 'finalized') return;
    await c.query("UPDATE tournament_results SET status='finalized', confirmed_by=$2, confirmed_at=now() WHERE id=$1", [r.id, req.user.id]);
    await c.query("UPDATE tournaments SET status='completed', updated_at=now() WHERE id=$1 AND status='pending_result'", [t.id]);
    const entries = (await c.query('SELECT * FROM result_entries WHERE result_id=$1 AND prize_paise > 0', [r.id])).rows;
    for (const e of entries) {
      await ledger.apply(c, { userId: e.player_id, type: 'winnings', direction: 'credit', amount: Number(e.prize_paise), txType: 'prize', refType: 'tournament', refId: t.id, key: `prize:${t.id}:${e.player_id}`, description: `Prize: ${t.title}` });
    }
    await audit(c, { actor: req.user.id, action: 'result.finalized', type: 'tournament', id: t.id });
  });
  res.json({ ok: true });
}));

// ---- Live no-show and slot resale ----
router.post('/registrations/:id/no-show', wrap(async (req, res) => {
  const s = await settings.all();
  const regId = v.int(req.params.id, 'id', { min: 1 });
  await db.tx(async (c) => {
    const reg = (await c.query('SELECT * FROM registrations WHERE id=$1 FOR UPDATE', [regId])).rows[0];
    if (!reg || reg.status !== 'confirmed') throw new HttpError(404, 'NOT_FOUND', 'Active registration not found');
    const t = await loadOwned(req.user, reg.tournament_id, c);
    if (t.status !== 'live') throw new HttpError(409, 'BAD_STATE', 'No-shows can only be marked while the tournament is live.');
    const late = (await c.query("SELECT now() >= $1::timestamptz + ($2 || ' seconds')::interval AS ok", [t.scheduled_start_at, String(s.no_show_delay_seconds)])).rows[0].ok;
    if (!late) throw new HttpError(409, 'TOO_EARLY', 'Wait for the no-show delay before marking a player absent.');
    const used = (await c.query('SELECT count(*)::int AS n FROM slot_resales WHERE tournament_id=$1 AND slot_number=$2', [t.id, reg.slot_number])).rows[0].n;
    if (used >= s.resale_max) throw new HttpError(409, 'RESALE_LIMIT', `This slot has already been resold ${s.resale_max} times.`);
    const price = v.int(req.body.price_paise, 'price_paise', { min: 0 });
    if (price >= Number(t.entry_fee_paise)) throw new HttpError(400, 'PRICE_TOO_HIGH', 'Resale price must be lower than the original entry fee.');
    await c.query("UPDATE registrations SET status='absent', cancelled_at=now() WHERE id=$1", [reg.id]); // no refund, per disclosed policy
    const sale = (await c.query(
      `INSERT INTO slot_resales(tournament_id,slot_number,original_registration_id,resale_number,original_entry_fee_paise,resale_price_paise,confirmed_absent_by)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [t.id, reg.slot_number, reg.id, used + 1, t.entry_fee_paise, price, req.user.id]
    )).rows[0];
    await audit(c, { actor: req.user.id, action: 'resale.opened', type: 'registration', id: reg.id, reason: 'no-show, no refund per policy', meta: { resale_id: sale.id, price_paise: price, resale_number: used + 1 } });
  });
  res.json({ ok: true });
}));

module.exports = router;
