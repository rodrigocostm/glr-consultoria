// Casa do cliente (perfil com abas) + correções que ela precisou:
// GLR.ctx.definir re-desenha a tela (Router é const global, não window.Router)
// e Router.estaEm() vale para tela embutida no perfil.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const raiz = path.join(__dirname, '..');
const ler = f => fs.readFileSync(path.join(raiz, f), 'utf8');

test('trocar o cliente em foco re-desenha a tela atual', () => {
  const store = new Map();
  let resolves = 0; const eventos = [];
  const ctx = { console, JSON, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    window: { dispatchEvent: e => eventos.push(e) }, // window SEM Router, como no navegador
    Router: { resolve: () => resolves++ } };
  vm.createContext(ctx);
  vm.runInContext(ler('js/data.js') + ';this.G = GLR;', ctx);
  ctx.G.ctx.definir('7');
  assert.equal(resolves, 1);
  assert.equal(eventos[0].detail.id, '7');
  ctx.G.ctx.definir('8', true);
  assert.equal(resolves, 1, 'silencioso não re-desenha');
});

test('Router.estaEm vale para a tela atual e para a embutida', () => {
  const ctx = { console, window: { addEventListener() {}, location: { hash: '' } }, document: {} };
  vm.createContext(ctx);
  vm.runInContext(ler('js/router.js') + ';this.R = Router;', ctx);
  const R = ctx.R;
  R.currentPage = 'cliente-perfil';
  assert.equal(R.estaEm('financeiro'), false);
  R.embutida = 'financeiro';
  assert.equal(R.estaEm('financeiro'), true);
  assert.equal(R.estaEm('cliente-perfil'), true);
});

test('as abas do perfil apontam para telas que existem e são únicas', () => {
  const html = ler('index.html');
  const js = [...html.matchAll(/<script src="js\/([\w.-]+\.js)/g)].map(m => ler('js/' + m[1])).join('\n');
  const registradas = new Set([...js.matchAll(/Router\.register\('([^']+)'/g)].map(m => m[1]));
  const win = {};
  vm.runInNewContext(ler('js/pages-clientes.js').split('// Trocou o cliente na barra')[0].replace(/^[\s\S]*?(window\.GLR_PERFIL_ABAS =)/m, '$1'), { window: win });
  const abas = win.GLR_PERFIL_ABAS;
  assert.deepEqual(Array.from(abas, a => a.nome), ['Visão geral', 'Vendas', 'ADS', 'Anúncios e preços', 'Saúde', 'Financeiro', 'Relatórios']);
  const ids = new Set();
  for (const a of abas) {
    assert.ok(a.subs.length >= 1, a.id);
    for (const s of a.subs) {
      assert.ok(!ids.has(a.id + '/' + s.id), 'sub repetida ' + s.id); ids.add(a.id + '/' + s.id);
      if (s.rota) assert.ok(registradas.has(s.rota), `rota ${s.rota} não está registrada`);
    }
  }
  // as telas que checavam "estou nesta tela?" passam a aceitar a versão embutida
  for (const [f, r] of [['js/pages-financeiro.js', 'financeiro'], ['js/pages-dre.js', 'dre'], ['js/pages-agente.js', 'agente']]) {
    assert.doesNotMatch(ler(f), new RegExp(`Router\\.currentPage === '${r}'`), f);
  }
});
