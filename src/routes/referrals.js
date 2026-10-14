const express = require('express');
const db = require('../config/db');
const { authenticate, requireActive } = require('../middleware/auth');
const { wrap } = require('../utils/errors');
const settings = require('../services/settings');
const referral = require('../services/referralService');

const router = express.Router();
const mask = (n) => `${String(n || '').slice(0, 2)}***`;

router.get('/me/referral', authenticate, wrap(async (req, res) => {
  const s = await settings.all();
  const code = await referral.ensureCode(req.user);
  const stats = (await db.query(
    `SELECT count(*)::int AS invited, (count(*) FILTER (WHERE status='rewarded'))::int AS rewarded,
            COALESCE(sum(referrer_reward_paise) FILTER (WHERE status='rewarded'),0)::bigint AS earned
     FROM referrals WHERE referrer_id=$1`, [req.user.id]
  )).rows[0];
  const list = (await db.query(
    `SELECT r.status, r.created_at, u.display_name FROM referrals r JOIN users u ON u.id=r.referred_id
     WHERE r.referrer_id=$1 ORDER BY r.id DESC LIMIT 20`, [req.user.id]
  )).rows.map((x) => ({ status: x.status, created_at: x.created_at, name: mask(x.display_name) }));
  const hasEntry = (await db.query('SELECT 1 FROM registrations WHERE player_id=$1 LIMIT 1', [req.user.id])).rowCount > 0;
  res.set('Cache-Control', 'no-store');
  res.json({
    enabled: s.referral_enabled, code,
    referrer_reward_paise: s.referral_referrer_reward_paise, referee_reward_paise: s.referral_referee_reward_paise,
    min_entry_paise: s.referral_min_entry_paise, credit_account: s.referral_credit_account,
    stats: { invited: stats.invited, rewarded: stats.rewarded, earned_paise: Number(stats.earned) },
    referrals: list, was_referred: !!req.user.referred_by,
    can_apply: s.referral_enabled && !req.user.referred_by && !hasEntry,
  });
}));

router.post('/me/referral', authenticate, requireActive, wrap(async (req, res) => {
  await referral.apply(req.user, req.body.code);
  res.status(201).json({ ok: true });
}));

module.exports = router;
