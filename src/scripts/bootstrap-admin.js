// One-time Super Admin setup. Run manually: BOOTSTRAP_ADMIN_ENABLED=true npm run bootstrap-admin
// Never runs automatically on server start. Afterwards set BOOTSTRAP_ADMIN_ENABLED=false and delete the password variable.
require('dotenv').config();
const db = require('../config/db');
const { getAuth } = require('../config/firebase');
const audit = require('../services/audit');

(async () => {
  if (process.env.BOOTSTRAP_ADMIN_ENABLED !== 'true') throw new Error('Bootstrap is disabled. Set BOOTSTRAP_ADMIN_ENABLED=true for this one run.');
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_INITIAL_PASSWORD || '';
  if (!email || password.length < 8) throw new Error('ADMIN_EMAIL and BOOTSTRAP_ADMIN_INITIAL_PASSWORD (8+ chars) are required.');
  const existing = await db.query("SELECT 1 FROM users WHERE role='super_admin' LIMIT 1");
  if (existing.rowCount) throw new Error('A Super Admin already exists. Refusing to create another.');

  const auth = getAuth();
  let fb;
  try { fb = await auth.getUserByEmail(email); await auth.updateUser(fb.uid, { password, emailVerified: true }); }
  catch (e) { if (e.code !== 'auth/user-not-found') throw e; fb = await auth.createUser({ email, password, emailVerified: true, displayName: 'Admin' }); }

  const { rows } = await db.query(
    `INSERT INTO users(firebase_uid,username,display_name,email,email_verified,role,must_change_password)
     VALUES($1,$2,'Admin',$3,true,'super_admin',true) RETURNING id`,
    [fb.uid, process.env.ADMIN_USERNAME || 'admin', email]
  );
  await audit(db, { actor: rows[0].id, action: 'bootstrap.super_admin_created', type: 'user', id: rows[0].id });
  console.log('Super Admin created. Sign in, change the password immediately, then set BOOTSTRAP_ADMIN_ENABLED=false.');
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
