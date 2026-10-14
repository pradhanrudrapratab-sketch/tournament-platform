const express = require('express');
const db = require('../config/db');
const { authenticate, requireActive, requireVerified } = require('../middleware/auth');
const { wrap, HttpError } = require('../utils/errors');
const v = require('../utils/validate');
const regs = require('../services/registrationService');
const settings = require('../services/settings');
const { decrypt } = require('../utils/crypto');

const router = express.Router();

router.post('/tournaments/:id/registrations', authenticate, requireActive, requireVerified, wrap(async (req, res) => {
  const tid = v.int(req.params.id, 'id', { min: 1 });
  const method = v.oneOf(req.body.method || 'gateway', 'method', ['wallet', 'gateway']);
  const resaleId = req.body.resale_id == null ? null : v.int(req.body.resale_id, 'resale_id', { min: 1 });
  if (req.body.accept_policy !== true) {
    throw new HttpError(400, 'POLICY_NOT_ACCEPTED', 'Please accept the no-show and no-refund policy to continue.');
  }
  const out = await regs.register(req.user, tid, { method, resaleId });
  res.status(201).json({
    registration: out.registration,
    order: out.order && {
      order_id: out.order.order_id, amount_paise: Number(out.order.amount_paise), status: out.order.status,
      payment_url: out.order.payment_url, qr_url: out.order.qr_url,
    },
  });
}));

// Room credentials: eligibility and reveal time are decided here, on the server clock.
router.get('/tournaments/:id/room-credentials', authenticate, wrap(async (req, res) => {
  const tid = v.int(req.params.id, 'id', { min: 1 });
  const t = (await db.query('SELECT * FROM tournaments WHERE id=$1', [tid])).rows[0];
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Tournament not found');
  const s = await settings.all();
  res.set('Cache-Control', 'private, no-store');

  const isStaff = req.user.role === 'super_admin' || (req.user.role === 'host' && t.host_id === req.user.id);
  if (!isStaff) {
    if (req.user.status !== 'active') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Your account is suspended.');
    const reg = (await db.query(
      "SELECT 1 FROM registrations WHERE tournament_id=$1 AND player_id=$2 AND status='confirmed'", [tid, req.user.id]
    )).rowCount;
    if (!reg) throw new HttpError(403, 'NOT_REGISTERED', 'Only players with a confirmed slot can see room details.');
    if (['cancelled'].includes(t.status) || (t.status === 'completed' && !s.room_visible_after_end)) {
      throw new HttpError(403, 'ROOM_CLOSED', 'Room details are no longer available.');
    }
    const offset = t.reveal_offset_seconds ?? s.reveal_offset_seconds;
    const { rows } = await db.query('SELECT now() >= ($1::timestamptz - ($2 || \' seconds\')::interval) AS open, $1::timestamptz - ($2 || \' seconds\')::interval AS reveal_at', [t.scheduled_start_at, String(offset)]);
    if (!rows[0].open) throw new HttpError(403, 'NOT_YET', 'Room details are not revealed yet.', { reveal_at: rows[0].reveal_at });
  }
  res.json({ room_id: decrypt(t.room_id_enc), room_password: decrypt(t.room_password_enc) });
}));

module.exports = router;
