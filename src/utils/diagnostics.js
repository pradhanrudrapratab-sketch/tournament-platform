// Startup self-check. Prints a clear report in the Render logs. Never prints secret values.
const db = require('../config/db');
const log = require('./logger');

const REQUIRED = [
  ['DATABASE_URL', 'PostgreSQL connection string'],
  ['ROOM_CRED_KEY', 'encrypts room ID and password (16+ characters)'],
  ['FIREBASE_PROJECT_ID', 'Firebase Admin SDK (server)'],
  ['FIREBASE_CLIENT_EMAIL', 'Firebase Admin SDK (server)'],
  ['FIREBASE_PRIVATE_KEY', 'Firebase Admin SDK (server)'],
  ['FIREBASE_WEB_API_KEY', 'browser sign-in'],
  ['FIREBASE_AUTH_DOMAIN', 'browser sign-in'],
  ['FIREBASE_APP_ID', 'browser sign-in'],
];
const OPTIONAL = [
  ['PAYMENT_GATEWAY_BASE_URL', 'deposits and UPI entry payments'],
  ['PAYMENT_GATEWAY_API_KEY', 'payment provider login'],
  ['PAYMENT_GATEWAY_WEBHOOK_SECRET', 'payment webhooks (optional)'],
  ['APP_BASE_URL', 'CORS allow-list'],
  ['DISCORD_INVITE_URL', 'default Discord button'],
];

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);

async function run() {
  const problems = [];
  const bad = (msg) => { problems.push(msg); console.error(`[PROBLEM] ${msg}`); };
  console.log('==================== Crown Arena startup check ====================');
  console.log(`Node ${process.version} | NODE_ENV=${process.env.NODE_ENV || '(not set)'} | PORT=${process.env.PORT || '(default 10000)'}`);

  for (const [k, why] of REQUIRED) {
    if (!process.env[k]) bad(`${k} is not set (${why})`); else console.log(`[ok] ${k} is set`);
  }
  for (const [k, why] of OPTIONAL) if (!process.env[k]) console.warn(`[note] ${k} is not set (${why})`);

  if (process.env.ROOM_CRED_KEY && process.env.ROOM_CRED_KEY.length < 16) bad('ROOM_CRED_KEY is shorter than 16 characters');
  const pk = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (process.env.FIREBASE_PRIVATE_KEY && !(pk.includes('BEGIN PRIVATE KEY') && pk.includes('END PRIVATE KEY'))) bad('FIREBASE_PRIVATE_KEY does not look like a private key (missing BEGIN/END PRIVATE KEY lines)');
  if (/^["']/.test(process.env.FIREBASE_PRIVATE_KEY || '')) bad('FIREBASE_PRIVATE_KEY starts with a quote character. Paste it without surrounding quotes');
  const pid = process.env.FIREBASE_PROJECT_ID, dom = process.env.FIREBASE_AUTH_DOMAIN;
  if (pid && dom && !dom.includes(pid)) console.warn(`[note] FIREBASE_AUTH_DOMAIN (${dom}) does not contain FIREBASE_PROJECT_ID (${pid}). Fine if you use a custom domain, otherwise check both come from the same project.`);

  let dbOk = false;
  if (process.env.DATABASE_URL) {
    try {
      const u = new URL(process.env.DATABASE_URL);
      console.log(`[info] Database target: host=${u.hostname} port=${u.port || '5432'} db=${u.pathname.slice(1)} ssl=${process.env.DATABASE_SSL === 'true' ? 'on' : 'off'}`);
      if (u.hostname.endsWith('.render.com') && process.env.DATABASE_SSL !== 'true') console.warn('[note] External Render database detected but DATABASE_SSL is not true. Set DATABASE_SSL=true.');
      if (!u.hostname.includes('.')) console.warn('[note] DATABASE_URL uses a short Internal hostname. It only resolves when this web service and the database are in the same region/workspace. If you see ENOTFOUND, switch to the External Database URL.');
    } catch (_) { bad('DATABASE_URL is not a valid URL'); }
    try {
      await withTimeout(db.query('SELECT 1'), 10000, 'Database connection');
      dbOk = true;
      console.log('[ok] Database is reachable');
    } catch (e) { bad('Cannot connect to the database'); log.error('startup: database connection', e); }
  }

  const haveAdmin = process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && pk.includes('BEGIN PRIVATE KEY');
  if (haveAdmin) {
    try {
      await withTimeout(require('../config/firebase').getAuth().listUsers(1), 15000, 'Firebase check');
      console.log('[ok] Firebase Admin credentials accepted');
    } catch (e) { bad('Firebase Admin check failed (sign-in will not work)'); log.error('startup: firebase admin', e); }
  }

  if (problems.length) {
    console.error(`==================== ${problems.length} PROBLEM(S) FOUND ====================`);
    problems.forEach((p, i) => console.error(` ${i + 1}. ${p}`));
  } else console.log('==================== All startup checks passed ====================');
  return { dbOk, problems };
}

module.exports = { run };
