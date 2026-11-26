// Estado único de vazio/carregando/erro (GLR.estado em js/ui.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function carregar() {
  const ctx = { console, setTimeout: () => 0, setInterval: () => 0, MutationObserver: class { observe() {} }, GLR: {} };
  ctx.window = { GLR: ctx.GLR, document: { readyState: 'complete', addEventListener() {}, getElementById: () => null }, setTimeout: () => 0, localStorage: { getItem: () => null } };
  ctx.document = ctx.window.document;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8'), ctx);
  return ctx.GLR;
}

test('erro diz o que fazer, escapa o texto e tem "Tentar de novo"', () => {
  const G = carregar();
  const h = G.estado('erro', { erro: new Error('<img src=x onerror=alert(1)> Failed to fetch'), oque: 'os clientes' });
  assert.match(h, /role="alert"/);
  assert.match(h, /Não consegui carregar os clientes/);
  assert.match(h, /Sem conexão\. Confira a internet/);
  assert.match(h, /data-estado-tentar/);
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img/);
  assert.doesNotMatch(h, /onclick=/, 'sem JS inline (CSP)');
});

test('mensagens técnicas viram explicações', () => {
  const G = carregar();
  assert.equal(G.erroAmigavel('JWT expired').titulo, 'Sua sessão expirou');
  assert.equal(G.erroAmigavel('HTTP 429 Too Many Requests').titulo, 'Limite de consultas atingido');
  assert.equal(G.erroAmigavel('new row violates row-level security policy').titulo, 'Sem acesso a estes dados');
  assert.equal(G.erroAmigavel('HTTP 502 Bad Gateway').acao.aba, 'saude-api');
  assert.equal(G.erroAmigavel('qualquer coisa').acao.aba, 'diagnostico');
});

test('vazio e carregando', () => {
  const G = carregar();
  const v = G.estado('vazio', { titulo: 'Nenhum cliente', texto: 'Cadastre o primeiro.', acao: { rotulo: 'Novo cliente', rota: 'clientes' } });
  assert.match(v, /role="status"/);
  assert.match(v, /data-estado-rota="clientes"/);
  assert.doesNotMatch(v, /Tentar de novo/);
  assert.match(G.estado('carregando'), /aria-busy="true"[\s\S]*Carregando…/);
});

test('as telas mostram erro de carga pelo componente único', () => {
  const dir = path.join(__dirname, '../js');
  const velhos = fs.readdirSync(dir).filter(f => /style="color:var\(--red\)">Não consegui carregar[^`]*\$\{h\(st\.erro\)\}/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(velhos, []);
});
