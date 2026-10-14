const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./config/db');
const log = require('./utils/logger');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const authHost = process.env.FIREBASE_AUTH_DOMAIN ? [`https://${process.env.FIREBASE_AUTH_DOMAIN}`] : [];
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", 'https://www.gstatic.com', 'https://apis.google.com', 'https://www.google.com', 'https://www.recaptcha.net'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'", 'https://*.googleapis.com', 'https://*.firebaseapp.com', 'https://www.gstatic.com', ...authHost],
      'frame-src': ["'self'", 'https://*.firebaseapp.com', 'https://*.web.app', 'https://accounts.google.com', 'https://*.googleapis.com', 'https://www.google.com', 'https://www.recaptcha.net', ...authHost],
    },
  },
}));
const origin = process.env.APP_BASE_URL;
app.use(cors({ origin: origin ? [origin] : false }));

// Webhook needs the RAW body for signature verification, so it is registered before express.json().
const payments = require('./routes/payments');
app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '100kb' }), (req, res, next) => payments.webhook(req, res).catch(next));

app.use(express.json({ limit: '100kb' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const strict = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
app.use(['/api/payments/orders', '/api/wallet/withdrawals', '/api/tournaments/:id/registrations'], strict);

app.get('/health', async (req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true }); } catch (e) { log.error('health check: database unreachable', e); res.status(503).json({ ok: false }); }
});

app.use('/api', require('./routes/public'));
app.use('/api', require('./routes/me'));
app.use('/api', require('./routes/referrals'));
app.use('/api', require('./routes/registrations'));
app.use('/api', payments);
app.use('/api', require('./routes/wallet'));
app.use('/api/admin', require('./routes/adminTournaments'));
app.use('/api/admin', require('./routes/adminFinance'));
app.use('/api/admin', require('./routes/adminPeople'));
app.use('/api', (req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Not found' }));

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ code: err.code, message: err.message, ...err.extra });
  if (err.code === '23505') return res.status(409).json({ code: 'CONFLICT', message: 'That already exists.' });
  if (err.code === '23514') return res.status(409).json({ code: 'RULE_VIOLATION', message: 'That change is not allowed.' });
  const where = `${req.method} ${String(req.originalUrl).split('?')[0]}`;
  log.error(`request failed: ${where}`, err, { user_id: req.user ? req.user.id : null }); // never logs bodies, headers or tokens
  const dbDown = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', '28P01', '28000', '3D000', '57P03', '08006', '08001'].includes(err.code);
  if (dbDown) return res.status(503).json({ code: 'DB_UNAVAILABLE', message: 'We cannot reach our database right now. Please try again in a minute.' });
  if (err.code === '42P01') return res.status(503).json({ code: 'SETUP_INCOMPLETE', message: 'The service is still being set up. Please try again shortly.' });
  return res.status(500).json({ code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
});

module.exports = app;
