const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ncmDe } = require('../api/_nfe');

test('NCM prefers the account key and still reads a legacy id', () => {
  const cat = { 'lojaA:10': '94036000', '10': '11111111', 'lojaB:10': '22022202' };
  assert.equal(ncmDe(cat, 'lojaA', '10'), '94036000');
  assert.equal(ncmDe(cat, 'lojaC', '10'), '11111111');
  assert.equal(ncmDe(cat, 'lojaB', '99'), '');
});
