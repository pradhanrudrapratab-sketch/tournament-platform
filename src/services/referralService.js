const crypto = require('crypto');
const db = require('../config/db');
const ledger = require('./ledger');
const settings = require('./settings');
const audit = require('./audit');
const { HttpError } = require('../utils/errors');

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHA[b % ALPHA.length]).join('');

async function ensureCode(user) {
  if (user.referral_code) return user.referral_code;
  for (let i = 0; i < 6; i += 1) {
    try {
      const { rows } = await db.query('UPDATE users SET referral_code=$2 WHERE id=$1 AND referral_code IS NULL RETURNING referral_code', [user.id, newCode()]);
      if (rows[0]) return rows[0].referral_code;
      return (await db.query('SELECT referral_code FROM users WHERE id=$1', [user.id])).rows[0].referral_code;
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  throw new HttpError(500, 'CODE_FAILED', 'Could not create your referral code. Try again.');
}

/** Attach a referrer to the current user. Only allowed once, and only before their first tournament entry. */
async function apply(user, rawCode) {
  const s = await settings.all();
  if (!s.referral_enabled) throw new HttpError(409, 'REFERRALS_OFF', 'Referrals are not active right now.');
  const code = String(rawCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(code)) throw new HttpError(400, 'INVALID_CODE', 'That referral code is not valid.');
  return db.tx(async (c) => {
    const me = (await c.query('SELECT id, referred_by FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
    if (me.referred_by) throw new HttpError(409, 'ALREADY_REFERRED', 'You already added a referral code.');
    const ref = (await c.query('SELECT id, referred_by, status FROM users WHERE referral_code=$1', [code])).rows[0];
    if (!ref || ref.status !== 'active') throw new HttpError(404, 'INVALID_CODE', 'That referral code is not valid.');
    if (ref.id === me.id) throw new HttpError(400, 'OWN_CODE', 'You cannot use your own code.');
    if (ref.referred_by === me.id) throw new HttpError(400, 'INVALID_CODE', 'That code cannot be used.');
    const used = await c.query('SELECT 1 FROM registrations WHERE player_id=$1 LIMIT 1', [me.id]);
    if (used.rowCount) throw new HttpError(409, 'TOO_LATE', 'A code can only be added before your first tournament entry.');
    await c.query('UPDATE users SET referred_by=$2 WHERE id=$1', [me.id, ref.id]);
    await c.query('INSERT INTO referrals(referrer_id, referred_id) VALUES($1,$2)', [ref.id, me.id]);
    await audit(c, { actor: me.id, action: 'referral.applied', type: 'user', id: me.id, meta: { referrer_id: ref.id } });
  });
}

/**
 * Called inside the transaction that CONFIRMS a paid registration (wallet or verified gateway payment).
 * The referral row is locked and flipped pending -> rewarded exactly once, and both credits use idempotency keys.
 */
async function rewardOnEntry(c, reg) {
  const s = await settings.all();
  if (!s.referral_enabled) return;
  if (Number(reg.entry_fee_paise) < Math.max(1, Number(s.referral_min_entry_paise))) return;
  const r = (await c.query("SELECT * FROM referrals WHERE referred_id=$1 AND status='pending' FOR UPDATE", [reg.player_id])).rows[0];
  if (!r) return;
  const referrer = (await c.query('SELECT status FROM users WHERE id=$1', [r.referrer_id])).rows[0];
  if (!referrer || referrer.status !== 'active') {
    await c.query("UPDATE referrals SET status='void' WHERE id=$1", [r.id]);
    return;
  }
  const a = Number(s.referral_referrer_reward_paise);
  const b = Number(s.referral_referee_reward_paise);
  const type = s.referral_credit_account === 'winnings' ? 'winnings' : 'deposit';
  if (a > 0) await ledger.apply(c, { userId: r.referrer_id, type, direction: 'credit', amount: a, txType: 'referral_bonus', refType: 'referral', refId: r.id, key: `referral:${r.id}:referrer`, description: 'Referral bonus: your friend joined a tournament' });
  if (b > 0) await ledger.apply(c, { userId: r.referred_id, type, direction: 'credit', amount: b, txType: 'referral_bonus', refType: 'referral', refId: r.id, key: `referral:${r.id}:referred`, description: 'Referral bonus: welcome gift' });
  await c.query(
    "UPDATE referrals SET status='rewarded', referrer_reward_paise=$2, referee_reward_paise=$3, qualifying_registration_id=$4, rewarded_at=now() WHERE id=$1",
    [r.id, a, b, reg.id]
  );
  await audit(c, { action: 'referral.rewarded', type: 'referral', id: r.id, meta: { referrer_paise: a, referred_paise: b, account: type } });
}

module.exports = { ensureCode, apply, rewardOnEntry };
