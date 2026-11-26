const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service';
process.env.ANTHROPIC_API_KEY = 'mock-ai';
process.env.MCP_API_KEY = 'mock-mcp';
const { carregarCarteira, limparCacheCarteira, CACHE_CARTEIRA_MS } = require('../api/chat-central').interno;

test('a carteira fica em cache por 45s', async () => {
  assert.equal(CACHE_CARTEIRA_MS, 45000);
  limparCacheCarteira();
  let n = 0;
  global.fetch = async () => { n++; return { ok: true, json: async () => [] }; };
  const a = await carregarCarteira();
  const primeiro = n;
  const b = await carregarCarteira();
  assert.ok(primeiro >= 4);
  assert.equal(n, primeiro);
  assert.equal(a, b);
  limparCacheCarteira();
  await carregarCarteira();
  assert.ok(n > primeiro);
});
