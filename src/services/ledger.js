const { HttpError } = require('../utils/errors');

async function lockAccount(c, userId, type) {
  await c.query(
    'INSERT INTO wallet_accounts(user_id, account_type) VALUES($1,$2) ON CONFLICT (user_id, account_type) DO NOTHING',
    [userId, type]
  );
  const { rows } = await c.query(
    'SELECT * FROM wallet_accounts WHERE user_id=$1 AND account_type=$2 FOR UPDATE',
    [userId, type]
  );
  return rows[0];
}

/**
 * Applies exactly one ledger entry. Safe to retry: the same idempotency key is a no-op.
 * Must run inside a transaction. The CHECK (balance_paise >= 0) is the last line of defence.
 */
async function apply(c, { userId, type, direction, amount, txType, refType = null, refId = null, key, description = null }) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, 'INVALID_AMOUNT', 'Invalid amount');
  const acct = await lockAccount(c, userId, type);
  const dup = await c.query('SELECT id FROM wallet_transactions WHERE idempotency_key=$1', [key]);
  if (dup.rowCount) return { duplicate: true, balance: Number(acct.balance_paise) };
  const delta = direction === 'credit' ? amount : -amount;
  const next = Number(acct.balance_paise) + delta;
  if (next < 0) throw new HttpError(409, 'INSUFFICIENT_FUNDS', 'Not enough balance');
  await c.query('UPDATE wallet_accounts SET balance_paise=$2 WHERE id=$1', [acct.id, next]);
  await c.query(
    `INSERT INTO wallet_transactions(wallet_account_id,user_id,account_type,transaction_type,direction,amount_paise,balance_after_paise,reference_type,reference_id,idempotency_key,description)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [acct.id, userId, type, txType, direction, amount, next, refType, refId == null ? null : String(refId), key, description]
  );
  return { duplicate: false, balance: next };
}

async function balances(client, userId) {
  const { rows } = await client.query('SELECT account_type, balance_paise FROM wallet_accounts WHERE user_id=$1', [userId]);
  const out = { deposit: 0, winnings: 0 };
  for (const r of rows) out[r.account_type] = Number(r.balance_paise);
  return out;
}

module.exports = { apply, balances };
