const express = require('express');
const db = require('../config/db');
const { authenticate, requireActive, requireRole } = require('../middleware/auth');
const { wrap, HttpError } = require('../utils/errors');
const v = require('../utils/validate');
const audit = require('../services/audit');
const ledger = require('../services/ledger');

const router = express.Router();
router.use('/withdrawals', authenticate, requireActive, requireRole('super_admin')); // hosts can never touch withdrawals

router.get('/withdrawals', wrap(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const { rows } = await db.query(
    `SELECT w.*, u.display_name, u.email FROM withdrawal_requests w JOIN users u ON u.id=w.user_id
     WHERE ($1::text IS NULL OR w.status=$1) ORDER BY w.created_at DESC LIMIT 100`, [status]
  );
  res.json({ withdrawals: rows });
}));

async function transition(req, res, { from, to, release, extra }) {
  const id = v.int(req.params.id, 'id', { min: 1 });
  await db.tx(async (c) => {
    const w = (await c.query('SELECT * FROM withdrawal_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!w) throw new HttpError(404, 'NOT_FOUND', 'Withdrawal not found');
    if (!from.includes(w.status)) throw new HttpError(409, 'BAD_TRANSITION', `Cannot move from ${w.status} to ${to}.`);
    const e = extra ? extra(w) : {};
    await c.query(
      `UPDATE withdrawal_requests SET status=$2, approved_by=COALESCE($3, approved_by), approved_at=CASE WHEN $2='approved' THEN now() ELSE approved_at END,
         completed_at=CASE WHEN $2='success' THEN now() ELSE completed_at END,
         payout_reference=COALESCE($4, payout_reference), failure_reason=COALESCE($5, failure_reason) WHERE id=$1`,
      [id, to, req.user.id, e.payout_reference || null, e.failure_reason || null]
    );
    if (release) {
      // Rejected/failed: reserved funds go back to winnings exactly once (idempotent key).
      await ledger.apply(c, { userId: w.user_id, type: 'winnings', direction: 'credit', amount: Number(w.requested_amount_paise), txType: 'withdrawal_release', refType: 'withdrawal', refId: id, key: `wd:${id}:release`, description: 'Withdrawal returned' });
    }
    await audit(c, { actor: req.user.id, action: `withdrawal.${to}`, type: 'withdrawal', id, reason: e.failure_reason || null, meta: e.payout_reference ? { payout_reference: e.payout_reference } : null });
  });
  res.json({ ok: true });
}

// Approval does NOT mean the money was paid.
router.post('/withdrawals/:id/approve', wrap((req, res) => transition(req, res, { from: ['pending'], to: 'approved' })));
router.post('/withdrawals/:id/processing', wrap((req, res) => transition(req, res, { from: ['approved'], to: 'processing' })));
router.post('/withdrawals/:id/reject', wrap((req, res) => transition(req, res, {
  from: ['pending', 'approved'], to: 'rejected', release: true,
  extra: () => ({ failure_reason: v.str(req.body.reason, 'reason', { min: 3, max: 300 }) }),
})));
router.post('/withdrawals/:id/fail', wrap((req, res) => transition(req, res, {
  from: ['approved', 'processing'], to: 'failed', release: true,
  extra: () => ({ failure_reason: v.str(req.body.reason, 'reason', { min: 3, max: 300 }) }),
})));
// Success only after the payout was really made; a reference (UTR) is mandatory.
router.post('/withdrawals/:id/confirm-payout', wrap((req, res) => transition(req, res, {
  from: ['approved', 'processing'], to: 'success',
  extra: () => ({ payout_reference: v.str(req.body.payout_reference, 'payout_reference', { min: 4, max: 80 }) }),
})));

module.exports = router;
