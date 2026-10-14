const db = require('../config/db');
const log = require('../utils/logger');

const DEFAULTS = {
  platform_title: 'Crown Arena',
  support_contact: '',
  terms_url: '',
  discord_invite_url: process.env.DISCORD_INVITE_URL || '',
  reveal_offset_seconds: 300,
  reservation_minutes: 30,
  withdraw_min_paise: 10000,
  withdraw_fee_bps: 1000,
  min_deposit_paise: 1000,
  max_deposit_paise: 5000000,
  resale_max: 2,
  no_show_delay_seconds: 60,
  room_visible_after_end: false,
  show_winnings: true,
  deposit_eta_text: '15 to 30 minutes',
  withdraw_eta_text: '2 to 3 business days',
  referral_enabled: true,
  referral_referrer_reward_paise: 500,
  referral_referee_reward_paise: 500,
  referral_min_entry_paise: 1000,
  referral_credit_account: 'deposit',
  help_title: 'Help and support',
  help_intro: 'Stuck on something? Check the answers below or ask us on Discord.',
  help_faq: [
    { q: 'How long do deposits take?', a: 'Deposits reflect in your account in 15 to 30 minutes. If it takes longer, tap Refresh status on the payment or message us on Discord.' },
    { q: 'How long do withdrawals take?', a: 'Withdrawals are credited in 2 to 3 business days after approval. Only tournament winnings can be withdrawn.' },
    { q: 'When do I get the room ID and password?', a: 'They unlock automatically a few minutes before the match starts, on the tournament page.' },
    { q: 'What if I miss the match?', a: 'Entry fees are not refunded for no-shows, even if your slot is resold.' },
  ],
};

let cache = null;
let at = 0;

async function all() {
  if (cache && Date.now() - at < 5000) return cache;
  try {
    const { rows } = await db.query('SELECT key, value FROM platform_settings');
    const merged = { ...DEFAULTS };
    for (const r of rows) if (r.key in DEFAULTS) merged[r.key] = r.value;
    cache = merged;
    at = Date.now();
    return merged;
  } catch (e) {
    log.error('settings: could not read platform_settings, using defaults', e);
    return cache || { ...DEFAULTS }; // the site still loads while the database is down
  }
}

async function set(client, key, value, actor) {
  if (!(key in DEFAULTS)) return false;
  await client.query(
    `INSERT INTO platform_settings(key, value, updated_by, updated_at) VALUES($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()`,
    [key, JSON.stringify(value), actor]
  );
  cache = null;
  return true;
}

module.exports = { all, set, DEFAULTS };
