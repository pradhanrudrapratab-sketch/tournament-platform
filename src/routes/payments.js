const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const { authenticate, requireActive, requireVerified } = require('../middleware/auth');
const { wrap, HttpError } = require('../utils/errors');
const v = require('../utils/validate');
const settings = require('../services/settings');
const pay = require('../services/paymentService');
const log = require('../utils/logger');

const router = express.Router();

const view = (o) => ({
  order_id: o.order_id, purpose: o.purpose, amount_paise: Number(o.amount_paise), status: o.status,
  payment_url: o.payment_url, qr_url: o.qr_url, created_at: o.created_at,
});

// Wallet top-up. The amount is validated here; the browser is never trusted for what is owed.
router.post('/payments/orders', authenticate, requireActive, requireVerified, wrap(async (req, res) => {
  const s = await settings.all();
  const amount = v.int(req.body.amount_paise, 'amount_paise', { min: s.min_deposit_paise, max: s.max_deposit_paise });
  const order = await db.tx((c) => pay.insertOrder(c, { userId: req.user.id, purpose: 'deposit', amount }));
  const withLink = await pay.attachGateway(order.order_id);
  res.status(201).json({ order: view(withLink) });
}));

// Manual "Refresh status": reuses the SAME order and the SAME verification logic as the background job.
router.get('/payments/orders/:orderId/status', authenticate, wrap(async (req, res) => {
  const orderId = v.str(req.params.orderId, 'orderId', { max: 64 });
  let o = (await db.query('SELECT * FROM orders WHERE order_id=$1', [orderId])).rows[0];
  if (!o || (o.user_id !== req.user.id && req.user.role !== 'super_admin')) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
  const recent = o.last_checked_at && Date.now() - new Date(o.last_checked_at).getTime() < 10000;
  if (!recent) o = await pay.verifyOrder(orderId, 'manual');
  res.set('Cache-Control', 'no-store');
  res.json({ order: view(o) });
}));

router.get('/payments/orders', authenticate, wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.user.id]);
  res.json({ orders: rows.map(view) });
}));

// Webhook (mounted with a RAW body parser in app.js). The payload is only a hint: we re-verify with the provider.
async function webhook(req, res) {
  const secret = process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET;
  if (!secret) return res.status(501).json({ code: 'WEBHOOK_DISABLED' });
  const raw = req.body;
  const sig = String(req.headers['x-signature'] || '');
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ code: 'BAD_SIGNATURE' });
  let evt;
  try { evt = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ code: 'BAD_JSON' }); }
  const eventId = String(evt.event_id || '');
  const providerOrderId = String(evt.order_id || '');
  if (!eventId || !providerOrderId) return res.status(400).json({ code: 'MISSING_FIELDS' });
  const ins = await db.query(
    'INSERT INTO payment_webhook_events(event_id, provider_order_id, payload) VALUES($1,$2,$3) ON CONFLICT (event_id) DO NOTHING RETURNING id',
    [eventId, providerOrderId, JSON.stringify(evt)]
  );
  if (ins.rowCount) {
    const o = (await db.query('SELECT order_id FROM orders WHERE provider_order_id=$1', [providerOrderId])).rows[0];
    if (o) await pay.verifyOrder(o.order_id, 'webhook').catch((e) => log.error('webhook: verification failed', e, { provider_order_id: providerOrderId }));
  }
  return res.json({ ok: true });
}

module.exports = router;
module.exports.webhook = webhook;
