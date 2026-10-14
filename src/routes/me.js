const express = require('express');
const db = require('../config/db');
const { getAuth } = require('../config/firebase');
const { authenticate } = require('../middleware/auth');
const { wrap, HttpError } = require('../utils/errors');
const v = require('../utils/validate');
const audit = require('../services/audit');

const router = express.Router();
router.use(authenticate);

const pub = (u) => ({
  id: u.id, display_name: u.display_name, email: u.email, role: u.role, status: u.status,
  email_verified: u.email_verified, must_change_password: u.must_change_password,
});

router.get('/me', wrap(async (req, res) => {
  const out = pub(req.user);
  if (req.user.role === 'host') {
    out.host_games = (await db.query(
      `SELECT g.id, g.slug, g.name, p.publish_policy, p.can_manage_results, p.can_finalize_results
       FROM host_game_permissions p JOIN games g ON g.id=p.game_id WHERE p.user_id=$1`, [req.user.id]
    )).rows;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ user: out });
}));

router.patch('/me', wrap(async (req, res) => {
  const name = v.str(req.body.display_name, 'display_name', { min: 2, max: 40 });
  const { rows } = await db.query('UPDATE users SET display_name=$2, updated_at=now() WHERE id=$1 RETURNING *', [req.user.id, name]);
  res.json({ user: pub(rows[0]) });
}));

// Password is changed on the server so the "must change initial password" flag cannot be cleared by the client alone.
router.post('/me/change-password', wrap(async (req, res) => {
  const pw = v.str(req.body.new_password, 'new_password', { min: 10, max: 128 });
  if (pw.toLowerCase().includes('admin143')) throw new HttpError(400, 'WEAK_PASSWORD', 'Choose a different password.');
  await getAuth().updateUser(req.user.firebase_uid, { password: pw });
  await getAuth().revokeRefreshTokens(req.user.firebase_uid);
  await db.query('UPDATE users SET must_change_password=false, updated_at=now() WHERE id=$1', [req.user.id]);
  await audit(db, { actor: req.user.id, action: 'user.password_changed', type: 'user', id: req.user.id });
  res.json({ ok: true, sign_in_again: true });
}));

router.get('/me/registrations', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.id, r.status, r.slot_number, r.entry_fee_paise, r.payment_method, r.registered_at,
            t.id AS tournament_id, t.title, t.status AS tournament_status, t.scheduled_start_at, g.name AS game_name, g.slug AS game_slug
     FROM registrations r JOIN tournaments t ON t.id=r.tournament_id JOIN games g ON g.id=t.game_id
     WHERE r.player_id=$1 ORDER BY t.scheduled_start_at DESC LIMIT 100`, [req.user.id]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ registrations: rows });
}));

module.exports = router;
