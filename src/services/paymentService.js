const crypto = require('crypto');
const db = require('../config/db');
const gateway = require('./gateway');
const ledger = require('./ledger');
const audit = require('./audit');
const log = require('../utils/logger');
const { HttpError } = require('../utils/errors');

const TERMINAL = ['success', 'failed', 'expired'];
const regs = () => require('./registrationService'); // lazy: avoids circular import

function newOrderId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `ORD${d}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

/** Creates the local order row (inside the caller's transaction). First automatic check is due after 15 minutes. */
async function insertOrder(c, { userId, purpose, referenceId = null, amount }) {
  const orderId = newOrderId();
  const { rows } = await c.query(
    `INSERT INTO orders(order_id,user_id,purpose,reference_id,amount_paise,status,expires_at,next_check_at)
     VALUES($1,$2,$3,$4,$5,'pending', now() + interval '24 hours', now() + interval '15 minutes') RETURNING *`,
    [orderId, userId, purpose, referenceId, amount]
  );
  if (purpose === 'entry' && referenceId) await c.query('UPDATE registrations SET order_id=$1 WHERE id=$2', [orderId, referenceId]);
  return rows[0];
}

/** Asks the gateway for a payment link. Only a definitive provider rejection fails the order; a timeout does not. */
async function attachGateway(orderId) {
  const o = (await db.query('SELECT * FROM orders WHERE order_id=$1', [orderId])).rows[0];
  if (!o || o.provider_order_id || o.status !== 'pending') return o;
  try {
    const g = await gateway.createOrder({ amountPaise: Number(o.amount_paise) });
    const { rows } = await db.query(
      'UPDATE orders SET provider_order_id=$2, payment_url=$3, qr_url=$4, updated_at=now() WHERE order_id=$1 RETURNING *',
      [orderId, g.providerOrderId, g.paymentUrl, g.qrUrl]
    );
    return rows[0];
  } catch (e) {
    log.error('payment gateway: could not create an order', e, { order_id: orderId, definitive: !!e.definitive });
    if (e.definitive) {
      await markTerminal(o, 'failed', 'gateway rejected order creation');
      throw new HttpError(502, 'GATEWAY_REJECTED', 'The payment provider rejected this request. Please try again.');
    }
    throw new HttpError(502, 'GATEWAY_UNAVAILABLE', 'Payment link is not ready yet. Tap Refresh status in a moment.');
  }
}

async function schedule(o, status) {
  await db.query(
    `UPDATE orders SET last_checked_at=now(), check_count=check_count+1, next_check_at=now() + interval '5 minutes',
       status=COALESCE($2,status), updated_at=now()
     WHERE order_id=$1 AND status IN ('pending','processing')`,
    [o.order_id, status || null]
  );
}

async function markTerminal(o, status, note) {
  await db.tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE orders SET status=$2, note=COALESCE($3,note), updated_at=now()
       WHERE order_id=$1 AND status IN ('pending','processing') RETURNING *`,
      [o.order_id, status, note || null]
    );
    if (rows[0] && rows[0].purpose === 'entry' && rows[0].reference_id) {
      await regs().release(c, rows[0].reference_id, 'cancelled');
    }
  });
}

async function applySuccess(orderId, res, source) {
  return db.tx(async (c) => {
    const o = (await c.query('SELECT * FROM orders WHERE order_id=$1 FOR UPDATE', [orderId])).rows[0];
    if (o.status === 'success') return o; // idempotent
    await c.query(
      `INSERT INTO payments(order_id,provider,provider_transaction_id,amount_paise,currency,status,verification_source,raw)
       VALUES($1,'gateway',$2,$3,$4,'success',$5,$6)`,
      [orderId, res.transactionId, o.amount_paise, o.currency, source, JSON.stringify(res.raw || {})]
    );
    const amount = Number(o.amount_paise);
    if (o.purpose === 'deposit') {
      await ledger.apply(c, { userId: o.user_id, type: 'deposit', direction: 'credit', amount, txType: 'deposit', refType: 'order', refId: orderId, key: `order:${orderId}:credit`, description: 'Wallet top-up' });
    } else {
      const ok = await regs().confirmPaid(c, o.reference_id);
      if (!ok) {
        // Late payment policy: the slot is gone, so the money goes to the deposit wallet. It is never lost or silently re-assigned.
        await ledger.apply(c, { userId: o.user_id, type: 'deposit', direction: 'credit', amount, txType: 'late_payment_credit', refType: 'order', refId: orderId, key: `order:${orderId}:credit`, description: 'Entry payment received after the slot hold expired' });
        await audit(c, { action: 'payment.late_credit', type: 'order', id: orderId });
      }
    }
    const { rows } = await c.query(
      "UPDATE orders SET status='success', applied_at=now(), updated_at=now() WHERE order_id=$1 RETURNING *",
      [orderId]
    );
    return rows[0];
  });
}

/** Same logic for the background job, manual refresh and webhooks. */
async function verifyOrder(orderId, source = 'job') {
  const get = async () => (await db.query('SELECT * FROM orders WHERE order_id=$1', [orderId])).rows[0];
  const o = await get();
  if (!o) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
  if (TERMINAL.includes(o.status)) return o;

  if (!o.provider_order_id) {
    try { await attachGateway(orderId); } catch (_) { /* retried on next check */ }
    await schedule(o);
    return get();
  }

  let res;
  try {
    res = await gateway.checkStatus(o.provider_order_id);
  } catch (e) {
    log.error('payment gateway: status check failed (will retry)', e, { order_id: orderId });
    await schedule(o); // timeout or provider error: NOT a failed payment, just retry later
    return get();
  }
  if (res.providerOrderId && res.providerOrderId !== o.provider_order_id) { await schedule(o); return get(); }

  if (res.status === 'success') {
    const needAmount = process.env.PAYMENT_REQUIRE_AMOUNT_MATCH !== 'false';
    const amountOk = res.amountPaise === Number(o.amount_paise) || (!needAmount && res.amountPaise == null);
    const currencyOk = res.currency === o.currency;
    if (!amountOk || !currencyOk) {
      await audit(db, { action: 'payment.mismatch', type: 'order', id: orderId, meta: { expected: Number(o.amount_paise), got: res.amountPaise, currency: res.currency } });
      await schedule(o, 'processing'); // held for manual review, never credited
      return get();
    }
    return applySuccess(orderId, res, source);
  }
  if (res.status === 'failed' || res.status === 'expired') {
    await markTerminal(o, res.status, 'provider reported ' + res.status);
    return get();
  }
  if (new Date(o.expires_at) < new Date()) { await markTerminal(o, 'expired', 'no payment before expiry'); return get(); }
  await schedule(o, res.status === 'processing' ? 'processing' : null);
  return get();
}

/** Claims due orders atomically so several instances never double-check the same order. */
async function claimDue(limit = 20) {
  const { rows } = await db.query(
    `UPDATE orders SET next_check_at = now() + interval '2 minutes'
     WHERE order_id IN (
       SELECT order_id FROM orders WHERE status IN ('pending','processing') AND next_check_at <= now()
       ORDER BY next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING order_id`,
    [limit]
  );
  return rows.map((r) => r.order_id);
}

module.exports = { insertOrder, attachGateway, verifyOrder, claimDue, markTerminal };
