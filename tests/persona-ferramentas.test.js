const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ferramentasDaPersona, acharPersona, consultarColega, FERRAMENTAS } = require('../api/chat-central').interno;

const nomes = id => ferramentasDaPersona(id).map(f => f.name);

test('cada persona só recebe as ferramentas da área, mais consultar_colega', () => {
  assert.ok(nomes('estoque').includes('estoque_margem'));
  assert.ok(nomes('estoque').includes('consultar_colega'));
  assert.ok(!nomes('estoque').includes('campanhas_ml'));
  assert.ok(!nomes('estoque').includes('campanhas_shopee'));
  assert.ok(nomes('shopee').includes('campanhas_shopee'));
  assert.ok(!nomes('shopee').includes('campanhas_ml'));
  assert.ok(nomes('ml').includes('campanhas_ml'));
  assert.ok(!nomes('gerente').includes('consultar_mercado_tiops'));
  assert.ok(!nomes('rel').includes('propor_acao'));
  const conhecidas = new Set(FERRAMENTAS.map(f => f.name));
  for (const id of ['gerente', 'sync', 'precos', 'estoque', 'margem', 'promo', 'rep', 'qa', 'oport', 'shopee', 'ml', 'rel']) {
    for (const n of nomes(id)) assert.ok(conhecidas.has(n), `${id} ${n}`);
  }
});

test('o colega é achado pelo id ou pelo nome, e a consulta recusa laço e limite', async () => {
  assert.equal(acharPersona('estoque').id, 'estoque');
  assert.equal(acharPersona('Margem').id, 'margem');
  assert.equal(acharPersona('Copiloto ADS ML').id, 'ml');
  assert.equal(acharPersona('ninguém'), null);
  await assert.rejects(() => consultarColega({ handoffs: 0, personaId: 'estoque', client: {} }, { colega: 'estoque', pergunta: 'oi' }), /si mesmo/);
  await assert.rejects(() => consultarColega({ handoffs: 2, personaId: 'gerente', client: {} }, { colega: 'estoque', pergunta: 'oi' }), /Limite/);
  await assert.rejects(() => consultarColega({ handoffs: 0, personaId: 'gerente', client: null }, { colega: 'estoque', pergunta: 'quanto estoque' }), /indisponível/);
});

test('o portal não ganha consultar_colega', () => {
  const src = fs.readFileSync(path.join(__dirname, '../api/portal-chat.js'), 'utf8');
  const m = src.match(/const PERMITIDAS = \[([^\]]*)\]/);
  assert.ok(m);
  assert.ok(!m[1].includes('consultar_colega'));
});
