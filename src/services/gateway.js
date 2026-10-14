// Adapter for the external payment gateway. The /link and /cheque contract is ILLUSTRATIVE (from the project README):
// confirm the real request/response formats, auth and signatures with your provider and adjust ONLY this file.

const unit = () => (process.env.PAYMENT_GATEWAY_AMOUNT_UNIT === 'rupees' ? 'rupees' : 'paise');
const toGateway = (paise) => (unit() === 'rupees' ? paise / 100 : paise);
const fromGateway = (a) => (a == null || a === '' ? null : unit() === 'rupees' ? Math.round(Number(a) * 100) : Math.round(Number(a)));

function mapStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['success', 'paid', 'completed', 'captured', 'successful'].includes(v)) return 'success';
  if (['failed', 'failure', 'cancelled', 'canceled', 'declined'].includes(v)) return 'failed';
  if (['expired', 'timeout'].includes(v)) return 'expired';
  if (['processing', 'in_progress'].includes(v)) return 'processing';
  return 'pending'; // unknown values are never treated as success OR failure
}

async function call(path, params) {
  const base = process.env.PAYMENT_GATEWAY_BASE_URL;
  if (!base) throw new Error('PAYMENT_GATEWAY_BASE_URL not configured');
  const url = new URL(path, base.replace(/\/?$/, '/'));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const key = process.env.PAYMENT_GATEWAY_API_KEY;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}`, 'x-api-key': key } : {}) },
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(`gateway_http_${res.status}`);
      e.definitive = res.status >= 400 && res.status < 500; // timeouts / 5xx are NOT definitive
      throw e;
    }
    try { return JSON.parse(text); } catch (_) { throw new Error('gateway_bad_json'); }
  } finally {
    clearTimeout(timer);
  }
}

async function createOrder({ amountPaise }) {
  const j = await call('link', { value: toGateway(amountPaise) });
  if (!j.order_id) throw new Error('gateway_missing_order_id');
  return { providerOrderId: String(j.order_id), paymentUrl: j.payment_url || null, qrUrl: j.qr_url || null };
}

async function checkStatus(providerOrderId) {
  const j = await call('cheque', { value: providerOrderId });
  return {
    providerOrderId: j.order_id ? String(j.order_id) : null,
    status: mapStatus(j.status),
    amountPaise: fromGateway(j.amount),
    currency: String(j.currency || 'INR').toUpperCase(),
    transactionId: j.transaction_id || j.utr || null,
    raw: j,
  };
}

module.exports = { createOrder, checkStatus, mapStatus };
