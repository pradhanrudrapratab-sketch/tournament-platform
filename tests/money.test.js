const test = require('node:test');
const assert = require('node:assert');
const { calcWithdrawal } = require('../src/utils/money');
const { mapStatus } = require('../src/services/gateway');

test('10% fee on Rs 100 is Rs 10, net Rs 90', () => {
  assert.deepStrictEqual(calcWithdrawal(10000, 1000), { fee: 1000, net: 9000 });
});
test('fee rounds half up in integer paise', () => {
  assert.strictEqual(calcWithdrawal(10005, 1000).fee, 1001);
  assert.strictEqual(calcWithdrawal(10004, 1000).fee, 1000);
  assert.strictEqual(calcWithdrawal(12345, 1000).fee + calcWithdrawal(12345, 1000).net, 12345);
});
test('unknown gateway status is never success or failure', () => {
  assert.strictEqual(mapStatus('???'), 'pending');
  assert.strictEqual(mapStatus('PAID'), 'success');
  assert.strictEqual(mapStatus(undefined), 'pending');
});
