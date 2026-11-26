const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bloco(arquivo) {
  const src = fs.readFileSync(path.join(__dirname, '..', arquivo), 'utf8');
  const ini = src.indexOf('// GLR-SSE-INICIO');
  const fim = src.indexOf('// GLR-SSE-FIM');
  assert(ini >= 0 && fim > ini, arquivo);
  return src.slice(ini, fim);
}
function parserDe(arquivo) {
  const contexto = { module: { exports: {} } };
  vm.runInNewContext(bloco(arquivo) + '\nmodule.exports = { consumirSSE };', contexto);
  return contexto.module.exports.consumirSSE;
}

test('o chat e o escritório leem o mesmo formato de SSE', () => {
  assert.equal(bloco('js/pages-chat.js'), bloco('js/pages-escritorio.js'));
});

test('eventos SSE do servidor são lidos na ordem, com pulso e corte no meio', () => {
  const { eventoSSE } = require('../api/chat-central').interno;
  const consumirSSE = parserDe('js/pages-chat.js');
  const fluxo = eventoSSE('status', { texto: 'Pensando…' })
    + ':\n\n'
    + eventoSSE('ferramenta', { nome: 'vendas', rotulo: 'vendas · Loja', estado: 'consultando' })
    + eventoSSE('texto', { delta: 'Olá' }).slice(0, 12);
  const vistos = [];
  const resto = consumirSSE(fluxo, (ev, data) => vistos.push([ev, data]));
  assert.equal(JSON.stringify(vistos), JSON.stringify([
    ['status', { texto: 'Pensando…' }],
    ['ferramenta', { nome: 'vendas', rotulo: 'vendas · Loja', estado: 'consultando' }],
  ]));
  const fim = consumirSSE(resto + eventoSSE('texto', { delta: 'Olá' }).slice(12) + eventoSSE('fim', { resposta: 'Olá' }), (ev, data) => vistos.push([ev, data]));
  assert.equal(fim, '');
  assert.equal(vistos[2][0], 'texto');
  assert.equal(vistos[2][1].delta, 'Olá');
  assert.equal(vistos[3][1].resposta, 'Olá');
});

test('texto_limpar chega como evento próprio', () => {
  const { eventoSSE } = require('../api/chat-central').interno;
  const consumirSSE = parserDe('js/pages-escritorio.js');
  const vistos = [];
  consumirSSE(eventoSSE('texto_limpar', {}) + eventoSSE('erro', { error: 'falhou' }), (ev, data) => vistos.push([ev, data]));
  assert.equal(JSON.stringify(vistos), JSON.stringify([['texto_limpar', {}], ['erro', { error: 'falhou' }]]));
});
