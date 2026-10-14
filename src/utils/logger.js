// Readable, de-duplicated logging for the Render terminal. Never pass request bodies, tokens or secrets in here.
const seen = new Map();
const WINDOW_MS = 5 * 60 * 1000;

function hintFor(err) {
  const m = String((err && err.message) || '');
  const c = String((err && (err.code || (err.errorInfo && err.errorInfo.code))) || '');
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') {
    return 'The database host name could not be resolved. On Render: open your Postgres page and copy DATABASE_URL again. The Internal URL works only when the web service and the database are in the SAME region and workspace; otherwise use the External URL (host ends with .render.com). Also check the database is not suspended or deleted.';
  }
  if (c === 'ECONNREFUSED') return 'The database refused the connection. Check host and port in DATABASE_URL, and that the database is running (free databases can be paused).';
  if (c === 'ETIMEDOUT' || c === 'ECONNRESET') return 'Connection to the database timed out or was reset. Check DATABASE_URL, region, and that the database is running.';
  if (c === '28P01') return 'Database password is wrong. Copy DATABASE_URL again from the Render Postgres page.';
  if (c === '28000' || /no pg_hba\.conf/i.test(m)) return 'The database rejected this connection. Set DATABASE_SSL=true and use the correct URL (Internal vs External).';
  if (c === '3D000') return 'The database name in DATABASE_URL does not exist.';
  if (c === '42P01') return 'A table is missing, so migrations have not run. Keep AUTO_MIGRATE on (default) or run: npm run migrate';
  if (/SSL|self[- ]signed|certificate/i.test(m)) return 'SSL problem talking to the database. Set DATABASE_SSL=true (Render databases require SSL on External URLs).';
  if (/Failed to parse private key|Invalid PEM|DECODER routines/i.test(m)) return 'FIREBASE_PRIVATE_KEY is malformed. Paste the whole private_key value from the service-account JSON, including BEGIN/END lines, without extra quotes. Keep the \\n sequences as they are.';
  if (/invalid_grant|Invalid JWT Signature|invalid_client/i.test(m)) return 'Firebase rejected the service account. The key may be revoked or the clock/credentials wrong. Generate a new private key in Firebase Console > Project settings > Service accounts.';
  if (/CONFIGURATION_NOT_FOUND/i.test(m)) return 'Firebase Authentication is not set up for this project. Firebase Console > Authentication > Get started, then enable Email/Password and Google.';
  if (/PERMISSION_DENIED|has not been used in project|accessNotConfigured/i.test(m)) return 'The Identity Toolkit API is disabled or the service account lacks permission. Enable Authentication in Firebase Console and use a key from the same project.';
  if (/incorrect "aud"|incorrect "iss"/i.test(m)) return 'The sign-in token belongs to a different Firebase project. FIREBASE_PROJECT_ID (server) and the web config (FIREBASE_WEB_API_KEY, FIREBASE_APP_ID, FIREBASE_AUTH_DOMAIN) must come from the SAME project.';
  if (/ROOM_CRED_KEY/.test(m)) return 'Set ROOM_CRED_KEY in Render env to a long random string (16+ characters).';
  if (/PAYMENT_GATEWAY_BASE_URL/.test(m)) return 'Set PAYMENT_GATEWAY_BASE_URL (and PAYMENT_GATEWAY_API_KEY) in Render env.';
  if (/gateway_/.test(m)) return 'The payment provider returned an unexpected response. Check PAYMENT_GATEWAY_* settings and src/services/gateway.js against the provider docs.';
  return null;
}

function emit(level, context, err, extra) {
  const e = err instanceof Error ? err : new Error(String(err));
  const key = `${level}|${context}|${e.message}`;
  const now = Date.now();
  const prev = seen.get(key);
  if (prev && now - prev.at < WINDOW_MS) { prev.n += 1; return; }
  const repeated = prev ? prev.n : 0;
  seen.set(key, { at: now, n: 0 });
  const lines = [`[${level}] ${new Date().toISOString()} ${context}${repeated ? `  (same problem repeated ${repeated} more times since the last report)` : ''}`];
  lines.push(`  message: ${e.message}`);
  const code = e.code || (e.errorInfo && e.errorInfo.code);
  if (code) lines.push(`  code: ${code}`);
  for (const k of ['detail', 'constraint', 'table', 'where']) if (e[k]) lines.push(`  ${k}: ${e[k]}`);
  if (extra) lines.push(`  context: ${JSON.stringify(extra)}`);
  const hint = hintFor(e);
  if (hint) lines.push(`  HINT: ${hint}`);
  if (level === 'ERROR' && e.stack) lines.push('  stack:\n' + e.stack.split('\n').slice(1, 8).map((l) => '  ' + l).join('\n'));
  (level === 'ERROR' ? console.error : console.warn)(lines.join('\n'));
}

module.exports = {
  hintFor,
  error: (context, err, extra) => emit('ERROR', context, err, extra),
  warn: (context, err, extra) => emit('WARN', context, err, extra),
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} ${msg}`),
};
