const db = require('../config/db');
const { HttpError } = require('../utils/errors');
const ledger = require('./ledger');
const settings = require('./settings');
const payments = require('./paymentService');
const referral = require('./referralService');

const ACTIVE = "('reserved','confirmed')";

async function refreshFull(c, tournamentId) {
  const t = (await c.query('SELECT id,status,capacity FROM tournaments WHERE id=$1', [tournamentId])).rows[0];
  const n = (await c.query(`SELECT count(*)::int AS n FROM registrations WHERE tournament_id=$1 AND status IN ${ACTIVE}`, [tournamentId])).rows[0].n;
  if (t.status === 'published' && n >= t.capacity) await c.query("UPDATE tournaments SET status='full', updated_at=now() WHERE id=$1", [tournamentId]);
  else if (t.status === 'full' && n < t.capacity) await c.query("UPDATE tournaments SET status='published', updated_at=now() WHERE id=$1", [tournamentId]);
}

async function confirm(c, regId) {
  const reg = (await c.query(
    "UPDATE registrations SET status='confirmed', confirmed_at=now(), reservation_expires_at=NULL WHERE id=$1 RETURNING *", [regId]
  )).rows[0];
  if (reg.resale_id) {
    await c.query("UPDATE slot_resales SET status='assigned', replacement_registration_id=$2, assigned_at=now() WHERE id=$1", [reg.resale_id, reg.id]);
  }
  await refreshFull(c, reg.tournament_id);
  await referral.rewardOnEntry(c, reg); // first qualifying paid entry pays both sides, once
  return reg;
}

/** Payment verified: confirm only if the reservation is still held. Returns false when the hold already ended. */
async function confirmPaid(c, regId) {
  const reg = (await c.query('SELECT * FROM registrations WHERE id=$1 FOR UPDATE', [regId])).rows[0];
  if (!reg || reg.status !== 'reserved') return false;
  await confirm(c, regId);
  return true;
}

async function release(c, regId, status) {
  const reg = (await c.query(
    "UPDATE registrations SET status=$2, cancelled_at=now() WHERE id=$1 AND status='reserved' RETURNING *", [regId, status]
  )).rows[0];
  if (!reg) return null;
  if (reg.resale_id) {
    await c.query("UPDATE slot_resales SET status='open', replacement_registration_id=NULL WHERE id=$1 AND status='claimed'", [reg.resale_id]);
  }
  await refreshFull(c, reg.tournament_id);
  return reg;
}

async function register(user, tournamentId, { method, resaleId }) {
  const s = await settings.all();
  const out = await db.tx(async (c) => {
    const t = (await c.query(
      `SELECT t.*, g.enabled AS game_enabled FROM tournaments t JOIN games g ON g.id=t.game_id WHERE t.id=$1 FOR UPDATE OF t`,
      [tournamentId]
    )).rows[0];
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'Tournament not found');
    if (!t.game_enabled) throw new HttpError(409, 'GAME_DISABLED', 'This game is not open for registration yet.');
    const now = (await c.query('SELECT now() AS n')).rows[0].n;

    const prior = await c.query(
      "SELECT 1 FROM registrations WHERE tournament_id=$1 AND player_id=$2 AND status IN ('reserved','confirmed','absent')",
      [t.id, user.id]
    );
    if (prior.rowCount) throw new HttpError(409, 'ALREADY_REGISTERED', 'You already have a slot in this tournament.');

    let price = Number(t.entry_fee_paise);
    let slot;
    let resale = null;
    if (resaleId) {
      if (!['live', 'scheduled', 'published', 'full'].includes(t.status)) throw new HttpError(409, 'NOT_OPEN', 'Registration is closed.');
      resale = (await c.query('SELECT * FROM slot_resales WHERE id=$1 AND tournament_id=$2 FOR UPDATE', [resaleId, t.id])).rows[0];
      if (!resale || resale.status !== 'open') throw new HttpError(409, 'RESALE_UNAVAILABLE', 'This slot is no longer available.');
      price = Number(resale.resale_price_paise);
      slot = resale.slot_number;
    } else {
      if (!['published', 'full'].includes(t.status)) throw new HttpError(409, 'NOT_OPEN', 'Registration is not open for this tournament.');
      if (t.registration_opens_at && now < t.registration_opens_at) throw new HttpError(409, 'NOT_OPEN', 'Registration has not opened yet.');
      if ((t.registration_closes_at && now > t.registration_closes_at) || now >= t.scheduled_start_at) throw new HttpError(409, 'CLOSED', 'Registration has closed.');
      const used = (await c.query(`SELECT slot_number FROM registrations WHERE tournament_id=$1 AND status IN ${ACTIVE}`, [t.id])).rows.map((r) => r.slot_number);
      if (used.length >= t.capacity) throw new HttpError(409, 'SLOTS_FULL', 'SLOTS FULL');
      const taken = new Set(used);
      slot = 1;
      while (taken.has(slot)) slot += 1;
    }

    const free = price === 0;
    const holdMinutes = Number(s.reservation_minutes) || 30;
    const reg = (await c.query(
      `INSERT INTO registrations(tournament_id,player_id,status,slot_number,entry_fee_paise,payment_method,resale_id,reservation_expires_at)
       VALUES($1,$2,'reserved',$3,$4,$5,$6, now() + ($7 || ' minutes')::interval) RETURNING *`,
      [t.id, user.id, slot, price, free ? 'free' : method, resale ? resale.id : null, String(holdMinutes)]
    )).rows[0];
    if (resale) await c.query("UPDATE slot_resales SET status='claimed', replacement_registration_id=$2 WHERE id=$1", [resale.id, reg.id]);

    if (free) { await confirm(c, reg.id); return { registration_id: reg.id, order: null }; }
    if (method === 'wallet') {
      await ledger.apply(c, { userId: user.id, type: 'deposit', direction: 'debit', amount: price, txType: 'entry_fee', refType: 'registration', refId: reg.id, key: `reg:${reg.id}:entry`, description: `Entry: ${t.title}` });
      await confirm(c, reg.id);
      return { registration_id: reg.id, order: null };
    }
    const order = await payments.insertOrder(c, { userId: user.id, purpose: 'entry', referenceId: reg.id, amount: price });
    await refreshFull(c, t.id);
    return { registration_id: reg.id, order };
  });

  let order = out.order;
  if (order) order = await payments.attachGateway(order.order_id); // outside the lock: slow network calls never hold the tournament row
  const reg = (await db.query('SELECT * FROM registrations WHERE id=$1', [out.registration_id])).rows[0];
  return { registration: reg, order };
}

/** Frees reservations that were not paid in time; the order stays checkable so a late payment is still honoured. */
async function expireReservations() {
  await db.tx(async (c) => {
    const { rows } = await c.query(
      "UPDATE registrations SET status='expired', cancelled_at=now() WHERE status='reserved' AND reservation_expires_at < now() RETURNING id, tournament_id, resale_id"
    );
    for (const r of rows) {
      if (r.resale_id) await c.query("UPDATE slot_resales SET status='open', replacement_registration_id=NULL WHERE id=$1 AND status='claimed'", [r.resale_id]);
    }
    for (const tid of new Set(rows.map((r) => r.tournament_id))) await refreshFull(c, tid);
  });
}

/** Cancellation policy: confirmed entries are refunded to the deposit wallet (idempotent); unpaid holds are released. */
async function refundTournament(c, tournamentId) {
  const { rows } = await c.query("SELECT * FROM registrations WHERE tournament_id=$1 AND status IN ('reserved','confirmed') FOR UPDATE", [tournamentId]);
  for (const r of rows) {
    if (r.status === 'confirmed' && Number(r.entry_fee_paise) > 0) {
      await ledger.apply(c, { userId: r.player_id, type: 'deposit', direction: 'credit', amount: Number(r.entry_fee_paise), txType: 'refund', refType: 'registration', refId: r.id, key: `refund:reg:${r.id}`, description: 'Tournament cancelled' });
      await c.query("UPDATE registrations SET status='refunded', cancelled_at=now() WHERE id=$1", [r.id]);
    } else {
      await c.query("UPDATE registrations SET status='cancelled', cancelled_at=now() WHERE id=$1", [r.id]);
    }
  }
  await c.query("UPDATE slot_resales SET status='cancelled' WHERE tournament_id=$1 AND status IN ('open','claimed')", [tournamentId]);
}

module.exports = { register, confirmPaid, release, refreshFull, expireReservations, refundTournament };
