# Crown Arena: setup

## 1. Go live on Render
1. Push this folder to GitHub (`.env` is git-ignored).
2. Render: New > Blueprint > pick the repo (`render.yaml` creates the web service and PostgreSQL).
3. Firebase Console: enable Email/Password and Google, add your Render domain under Authorized domains.
4. In Render env, fill the Firebase values (service account for the Admin SDK, web config for the browser), `ROOM_CRED_KEY` (auto-generated), `PAYMENT_GATEWAY_*`, `DISCORD_INVITE_URL`.
5. Deploy. Tables are created automatically on every start (set `AUTO_MIGRATE=false` to turn this off).

## Reading the Render logs
On every start the server prints a startup check: which env vars are missing, whether the database and Firebase accept your credentials, and a HINT line for the common mistakes. Request errors print the failing route, the error code and a short stack. Repeated identical errors are summarised every 5 minutes so the log stays readable.

## Enable sign-in (Firebase)
1. Firebase Console > Build > Authentication > Get started.
2. Sign-in method tab: enable **Email/Password** and **Google** (set a support email for Google).
3. Authentication > Settings > Authorized domains: add your Render domain (for example `your-app.onrender.com`).
4. Project settings > General > Your apps > add a Web app. Put `apiKey`, `authDomain`, `appId` into `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID`.
5. Project settings > Service accounts > Generate new private key. Put `project_id`, `client_email`, `private_key` into `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
6. All values must come from the SAME Firebase project. Redeploy, then check the startup log for `[ok] Firebase Admin credentials accepted`.

## Database URL on Render
If the log says `ENOTFOUND` for a host like `dpg-xxxx-a`, the Internal URL is not reachable from this service. Use the **External Database URL** (host ends with `.render.com`) and set `DATABASE_SSL=true`, or put the web service and database in the same region.

## 2. Create the Super Admin (one time)
1. In Render env set `ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_INITIAL_PASSWORD`, `BOOTSTRAP_ADMIN_ENABLED=true`.
2. Render Shell: `npm run bootstrap-admin`
3. Immediately set `BOOTSTRAP_ADMIN_ENABLED=false` and delete the password variable.
4. Sign in with the username `admin` (works only while bootstrap is on) or the email. You are forced to change the password before any admin tool unlocks.

## Defaults chosen for the README's open decisions (all changeable)
| Decision | Default |
|---|---|
| Entry payment | UPI gateway or deposit balance (winnings are not spendable on entries) |
| Unpaid slot hold | 30 minutes (Settings) |
| Late payment | Credited to deposit wallet, never silently assigned a slot |
| Room access after end | Hidden once completed |
| Host active statuses | published, registration_closed, full, scheduled, live, pending_result |
| Result finalize | Super Admin; hosts only if given the finalize permission |
| Leaderboard tie-break | wins, then winnings, then tournaments played |
| Cancelled tournament | Confirmed entries refunded to deposit wallet |
| Player messaging | Deposits reflect in 15 to 30 minutes. Withdrawals credited in 2 to 3 business days (editable in Settings) |

## Referral and Help page (all editable in Manage > Settings)
| Setting | Default |
|---|---|
| Referral program | On |
| Referrer gets / friend gets | ₹5 / ₹5 |
| Reward trigger | Friend's first paid entry, confirmed (wallet or verified payment), entry fee at least ₹10 |
| Bonus credited to | Deposit balance (spend on entries, not withdrawable) |
| Help page | Title, intro, Discord button (uses the Discord invite URL), support contact, FAQ list |

Manage > Referrals shows every referral and lets a Super Admin void pending ones (fraud control).
Run `npm run migrate` after pulling this update (adds migration 002).

## Must verify before real money
- `src/services/gateway.js` follows the README's illustrative `/link` and `/cheque` contract. Match it to your real provider (auth, amount unit, signature, statuses). Only that file should need changes.
- Nothing here has run against a live PostgreSQL, Firebase or gateway yet. Test on staging first.
- Legal and payment-provider review of real-money tournaments and the no-refund rule.

## Sign-in troubleshooting
| Symptom | Fix |
|---|---|
| Google: `auth/unauthorized-domain` | Firebase Console > Authentication > Settings > Authorized domains > add your Render domain (no https://, no path) |
| Google: `auth/operation-not-allowed` | Authentication > Sign-in method > enable Google and pick a support email |
| Google popup does nothing | Allow pop-ups, and open the site in Chrome or Safari (not inside Instagram/WhatsApp browsers, Google blocks those) |
| `FIREBASE_AUTH_DOMAIN` | Must be `<project-id>.firebaseapp.com`, NOT your Render URL. No callback route is needed in this app: Firebase hosts the Google callback itself |
| Verification mail missing | Check Spam and Promotions, wait a few minutes, use Resend email. Default sender is Firebase's shared address, so inboxes may filter it; a custom email domain under Authentication > Templates improves delivery |
