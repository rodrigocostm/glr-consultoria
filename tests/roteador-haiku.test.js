const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rotaDe, sistemaComCache, ferramentasComCache, MODELO, MODELO_RAPIDO } = require('../api/chat-central').interno;

test('a rota simples só vale com o JSON exato; o resto cai em análise', () => {
  assert.equal(rotaDe('{"rota":"simples"}'), 'simples');
  assert.equal(rotaDe('Claro. {"rota":"simples"}'), 'simples');
  assert.equal(rotaDe('{"rota":"analise"}'), 'analise');
  assert.equal(rotaDe('{"rota":"outra"}'), 'analise');
  assert.equal(rotaDe('sem json'), 'analise');
  assert.equal(rotaDe(''), 'analise');
});

test('o cache fica no system estável e no último schema de ferramenta', () => {
  const system = sistemaComCache('regras fixas', '\nnota');
  assert.equal(system[0].cache_control.type, 'ephemeral');
  assert.equal(system[0].text, 'regras fixas');
  assert.equal(system[1].cache_control, undefined);
  assert.equal(system[1].text, '\nnota');
  const tools = ferramentasComCache([{ name: 'vendas' }, { name: 'ads' }]);
  assert.equal(tools[0].cache_control, undefined);
  assert.equal(tools[1].cache_control.type, 'ephemeral');
  assert.equal(tools[1].name, 'ads');
});

test('os ids são os que o repositório já usa', () => {
  assert.equal(MODELO, 'claude-sonnet-5-5');
  assert.equal(MODELO_RAPIDO, 'claude-haiku-5-5');
});
