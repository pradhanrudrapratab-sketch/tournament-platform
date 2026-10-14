require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

async function run() {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const f of files) {
    const done = await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
    if (done.rowCount) continue;
    await db.tx(async (c) => {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}

module.exports = { run };

if (require.main === module) {
  run()
    .then((a) => { console.log(a.length ? 'Applied: ' + a.join(', ') : 'Migrations up to date'); return db.pool.end(); })
    .catch((e) => { require('../utils/logger').error('migration failed', e); process.exit(1); });
}
