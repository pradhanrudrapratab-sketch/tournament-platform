const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const { authenticate, requireActive, requireVerified } = require('../middleware/auth');
const { wrap, HttpError } = require('../utils/errors');
const v = require('../utils/validate');
const ledger = require('../services/ledger');
const settings = require('../services/settings');
const { calcWithdrawal } = require('../utils/money');

const router = express.Router();
router.use(authenticate);

router.get('/wallet', wrap(async (req, res) => {
  const bal = await ledger.balances(db, req.user.id);
  const pend = (await db.query(
    "SELECT COALESCE(sum(requested_amount_paise),0)::bigint AS p FROM withdrawal_requests WHERE user_id=$1 AND status IN ('pending','approved','processing')",
    [req.user.id]
  )).rows[0].p;
  const s = await settings.all();
  res.set('Cache-Control', 'no-store');
  res.json({
    deposit_paise: bal.deposit, winnings_paise: bal.winnings, pending_withdrawal_paise: Number(pend),
    withdraw_min_paise: s.withdraw_min_paise, withdraw_fee_bps: s.withdraw_fee_bps,
    deposit_eta_text: s.deposit_eta_text, withdraw_eta_text: s.withdraw_eta_text,
  });
}));

router.get('/wallet/transactions', wrap(async (req, res) => {
  const before = req.query.before ? v.int(req.query.before, 'before', { min: 1 }) : null;
  const { rows } = await db.query(
    `SELECT id, account_type, transaction_type, direction, amount_paise, balance_after_paise, description, created_at
     FROM wallet_transactions WHERE user_id=$1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 30`,
    [req.user.id, before]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ transactions: rows });
}));

router.get('/wallet/withdrawals', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, requested_amount_paise, fee_paise, net_payout_paise, status, payout_upi, failure_reason, created_at, completed_at
     FROM withdrawal_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 30`, [req.user.id]
  );
  res.json({ withdrawals: rows });
}));

// Only WINNINGS are withdrawable. The request amount is reserved (debited) immediately so it cannot be spent twice.
router.post('/wallet/withdrawals', requireActive, requireVerified, wrap(async (req, res) => {
  const s = await settings.all();
  const amount = v.int(req.body.amount_paise, 'amount_paise', { min: 1 });
  if (amount < s.withdraw_min_paise) throw new HttpError(400, 'BELOW_MINIMUM', 'Minimum withdrawal is ₹' + s.withdraw_min_paise / 100);
  const upi = v.str(req.body.payout_upi, 'payout_upi', { min: 5, max: 100 }).toLowerCase();
  if (!/^[a-z0-9.\-_]{2,64}@[a-z][a-z0-9]{1,30}$/.test(upi)) throw new HttpError(400, 'INVALID_UPI', 'Enter a valid UPI ID like name@bank');
  const key = String(req.get('Idempotency-Key') || crypto.randomUUID()).slice(0, 80);
  const { fee, net } = calcWithdrawal(amount, s.withdraw_fee_bps);

  const out = await db.tx(async (c) => {
    const dup = await c.query('SELECT * FROM withdrawal_requests WHERE idempotency_key=$1 AND user_id=$2', [key, req.user.id]);
    if (dup.rowCount) return dup.rows[0];
    const w = (await c.query(
      `INSERT INTO withdrawal_requests(user_id,requested_amount_paise,fee_paise,net_payout_paise,fee_bps,payout_upi,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.user.id, amount, fee, net, s.withdraw_fee_bps, upi, key]
    )).rows[0];
    await ledger.apply(c, { userId: req.user.id, type: 'winnings', direction: 'debit', amount, txType: 'withdrawal_reserve', refType: 'withdrawal', refId: w.id, key: `wd:${w.id}:reserve`, description: 'Withdrawal requested' });
    return w;
  });
  res.status(201).json({ withdrawal: out });
}));

module.exports = router;
