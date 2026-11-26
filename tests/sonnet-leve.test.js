const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ajusteDoPedido } = require('../api/chat-central').interno;

test('o escritório fica em 3000 tokens e a pergunta curta usa effort low', () => {
  assert.deepEqual(ajusteDoPedido('qual o semáforo?', true), { max_tokens: 3000, effort: 'low' });
  assert.deepEqual(ajusteDoPedido('qual o semáforo?', false), { max_tokens: 4000, effort: 'low' });
  assert.deepEqual(ajusteDoPedido('Monte o plano completo da carteira inteira com diagnóstico', true), { max_tokens: 3000, effort: 'medium' });
  assert.deepEqual(ajusteDoPedido('Compare a carteira inteira e monte a estratégia do mês', false), { max_tokens: 16000, effort: 'medium' });
  assert.equal(ajusteDoPedido('x'.repeat(401), false).max_tokens, 16000);
  assert.equal(ajusteDoPedido('x'.repeat(401), false).effort, 'medium');
});
