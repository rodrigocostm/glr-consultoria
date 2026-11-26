const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aplicarIds } = require('../api/_custos-cliente');

test('catalog merge keeps other ids and never stores the product name', () => {
  const base = { MLB1: 10, 'Camiseta Azul': 99, MLB2: 4 };
  const out = aplicarIds(base, [['MLB1', 12], ['MLB9', 3], ['MLB2', 0]]);
  assert.equal(out.MLB1, 12);
  assert.equal(out.MLB9, 3);
  assert.equal(out.MLB2, undefined);
  assert.equal(out['Camiseta Azul'], 99);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'MLB2'), false);
});

test('empty catalog and invalid id are ignored', () => {
  assert.deepEqual(aplicarIds(null, [['', 5], ['MLB1', 2]]), { MLB1: 2 });
});
