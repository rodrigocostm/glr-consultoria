const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pedidoLongo } = require('../api/chat-central').interno;

test('fala do escritório e análise longa vão para segundo plano; cumprimento não', () => {
  assert.equal(pedidoLongo('oi', false), false);
  assert.equal(pedidoLongo('qual o semáforo?', false), false);
  assert.equal(pedidoLongo('oi', true), true);
  assert.equal(pedidoLongo('monta o plano do mês', false), true);
  assert.equal(pedidoLongo('x'.repeat(281), false), true);
  assert.equal(pedidoLongo('x'.repeat(280), false), false);
});
