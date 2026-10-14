const payments = require('../services/paymentService');
const regs = require('../services/registrationService');
const log = require('../utils/logger');

// Durable by design: all state lives in PostgreSQL (orders.next_check_at), so a Render restart loses nothing.
let running = false;
let timer = null;

async function tick() {
  if (running) return;
  running = true;
  try {
    await regs.expireReservations();
    for (const id of await payments.claimDue(20)) {
      try { await payments.verifyOrder(id, 'job'); } catch (e) { log.error('job: payment verification failed', e, { order_id: id }); }
    }
  } catch (e) {
    log.error('job: background tick failed', e);
  } finally {
    running = false;
  }
}

function start() { tick(); timer = setInterval(tick, 60 * 1000); }
function stop() { if (timer) clearInterval(timer); }

module.exports = { start, stop, tick };
