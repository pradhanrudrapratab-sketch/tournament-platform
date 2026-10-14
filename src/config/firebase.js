const admin = require('firebase-admin');
let ready = false;

function init() {
  if (ready) return admin;
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
  ready = true;
  return admin;
}

module.exports = { getAuth: () => init().auth() };
