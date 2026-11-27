const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/contas-inativas');

test('loja inativa é reconhecida por marketplace e id', () => {
  const d = { 'shopee:453420133': { nome: 'V&S Decor' }, 'ml:2434906659': { nome: 'Lumina' } };
  assert.strictEqual(C.inativa(d, 'shopee', '453420133'), true);
  assert.strictEqual(C.inativa(d, 'meli', 2434906659), true);
  assert.strictEqual(C.inativa(d, 'shopee', '393629014'), false);
  assert.strictEqual(C.contaInativa(d, { marketplace: 'shopee', param_to_use: { shopId: 453420133 } }), true);
  assert.strictEqual(C.contaInativa(JSON.stringify(d), { marketplace: 'meli', external_id: '2434906659' }), true);
  assert.strictEqual(C.inativa(null, 'shopee', '1'), false);
});
