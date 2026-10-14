require('dotenv').config();
const log = require('./utils/logger');

process.on('unhandledRejection', (r) => log.error('unhandledRejection (a promise failed and nothing caught it)', r instanceof Error ? r : new Error(String(r))));
process.on('uncaughtException', (e) => { log.error('uncaughtException (the process will exit)', e); setTimeout(() => process.exit(1), 100); });

const app = require('./app');
const db = require('./config/db');
const jobs = require('./jobs/jobRunner');
const diagnostics = require('./utils/diagnostics');
const migrate = require('./database/migrate');

const port = process.env.PORT || 10000;
const server = app.listen(port, () => {
  log.info(`Listening on ${port}`);
  startup().catch((e) => log.error('startup failed', e));
});

async function applyMigrations() {
  if (process.env.AUTO_MIGRATE === 'false') return;
  try {
    const applied = await migrate.run();
    log.info(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date');
  } catch (e) { log.error('database migration FAILED (the app cannot work until this is fixed)', e); }
}

async function startup() {
  const { dbOk } = await diagnostics.run();
  if (dbOk) await applyMigrations();
  else {
    // Database may still be starting or misconfigured: keep retrying so a fix needs no redeploy of code.
    const timer = setInterval(async () => {
      try { await db.query('SELECT 1'); clearInterval(timer); log.info('Database is reachable now'); await applyMigrations(); }
      catch (e) { log.error('database still unreachable (retrying every 30s)', e); }
    }, 30000);
    timer.unref();
  }
  jobs.start();
}

function shutdown() {
  log.info('Shutting down');
  jobs.stop();
  server.close(async () => { await db.pool.end().catch(() => {}); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
