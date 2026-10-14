const { getAuth } = require('../config/firebase');
const db = require('../config/db');
const { HttpError, wrap } = require('../utils/errors');
const log = require('../utils/logger');

async function loadUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(h.slice(7)); // signature, issuer, audience, expiry
  } catch (e) {
    log.warn('auth: Firebase rejected a sign-in token', e);
    throw new HttpError(401, 'INVALID_TOKEN', 'Please sign in again.');
  }
  let user = (await db.query('SELECT * FROM users WHERE firebase_uid=$1', [decoded.uid])).rows[0];
  if (!user) {
    const email = (decoded.email || '').toLowerCase();
    if (!email) throw new HttpError(403, 'NO_EMAIL', 'Your account needs an email address.');
    try {
      user = (await db.query(
        `INSERT INTO users(firebase_uid,email,display_name,email_verified) VALUES($1,$2,$3,$4)
         ON CONFLICT (firebase_uid) DO UPDATE SET updated_at=now() RETURNING *`,
        [decoded.uid, email, (decoded.name || email.split('@')[0]).slice(0, 60), !!decoded.email_verified]
      )).rows[0]; // role is always 'player' here; privileged roles are server-controlled only
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'EMAIL_IN_USE', 'An account with this email already exists.');
      throw e;
    }
  } else if (user.email_verified !== !!decoded.email_verified) {
    user = (await db.query('UPDATE users SET email_verified=$2, updated_at=now() WHERE id=$1 RETURNING *', [user.id, !!decoded.email_verified])).rows[0];
  }
  return user;
}

const authenticate = wrap(async (req, res, next) => {
  const u = await loadUser(req);
  if (!u) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in.');
  if (u.status === 'disabled') throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled.');
  req.user = u;
  next();
});

const optionalAuth = wrap(async (req, res, next) => {
  req.user = (await loadUser(req)) || null;
  next();
});

const requireActive = (req, res, next) =>
  req.user.status === 'active' ? next() : next(new HttpError(403, 'ACCOUNT_SUSPENDED', 'Your account is suspended.'));

const requireVerified = (req, res, next) =>
  req.user.email_verified ? next() : next(new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email to continue.'));

const requireRole = (...roles) => (req, res, next) => {
  if (req.user.must_change_password) return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your initial password first.'));
  return roles.includes(req.user.role) ? next() : next(new HttpError(403, 'FORBIDDEN', 'You do not have access to this.'));
};

module.exports = { authenticate, optionalAuth, requireActive, requireVerified, requireRole };
