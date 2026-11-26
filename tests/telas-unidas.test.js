// Telas unidas: a tela nova abre na aba pedida, embutindo a original, e o
// endereço antigo leva para ela na aba certa.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function carregar(portal) {
  const chamadas = [], navs = [];
  const Router = { routes: {}, currentParams: {}, embutida: null, register(p, f) { this.routes[p] = f; }, navigate: (p, q) => navs.push([p, q]) };
  for (const id of ['integracoes', 'conexoes', 'saude-api', 'diagnostico', 'precos-ml', 'precos-shopee', 'criar-anuncio', 'anuncios-novos']) Router.routes[id] = (params, el) => { chamadas.push([id, params]); el.innerHTML = 'tela ' + id; };
  const window = portal ? { _portalConfig: {} } : {};
  const ctx = { Router, window, console, history: { replaceState: (_, __, h) => { window.hash = h; } }, setTimeout: f => f() };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/telas-unidas.js'), 'utf8'), ctx);
  return { Router, chamadas, navs, window };
}
function elFalso() {
  const botoes = [];
  const corpo = { innerHTML: '' };
  return { botoes, corpo, set innerHTML(v) { this._h = v; botoes.length = 0; for (const m of v.matchAll(/data-aba="([^"]+)"/g)) botoes.push({ dataset: { aba: m[1] }, classList: { toggle() {} }, setAttribute() {}, onclick: null }); },
    get innerHTML() { return this._h; }, querySelector: s => s === '.tela-unida-corpo' ? corpo : null, querySelectorAll: () => botoes };
}

test('Sistema abre na aba pedida e embute a tela original', () => {
  const { Router, chamadas, window } = carregar();
  const el = elFalso();
  Router.routes.sistema({ aba: 'saude-api' }, el);
  assert.match(el.innerHTML, /Integrações[\s\S]*Conexões[\s\S]*Saúde da API[\s\S]*Diagnóstico/);
  assert.equal(chamadas.at(-1)[0], 'saude-api');
  assert.equal(chamadas.at(-1)[1].embed, true);
  assert.equal(el.corpo.innerHTML, 'tela saude-api');
  assert.equal(Router.embutida, 'saude-api');
  assert.equal(window.hash, '#sistema?aba=saude-api');
  el.botoes.find(b => b.dataset.aba === 'diagnostico').onclick();
  assert.equal(chamadas.at(-1)[0], 'diagnostico');
  assert.equal(window.hash, '#sistema?aba=diagnostico');
});

test('sem aba (ou aba desconhecida) abre a primeira', () => {
  const { Router, chamadas } = carregar();
  Router.routes.sistema({ aba: 'xyz' }, elFalso());
  assert.equal(chamadas.at(-1)[0], 'integracoes');
});

test('endereço antigo leva para a tela nova na aba certa', () => {
  const { Router, navs } = carregar();
  Router.routes.conexoes({ x: '1' }, elFalso());
  assert.equal(navs.at(-1)[0], 'sistema'); assert.deepEqual({ ...navs.at(-1)[1] }, { x: '1', aba: 'conexoes' });
  assert.equal(typeof Router.embutiveis.conexoes, 'function', 'a original continua disponível para embutir');
  assert.deepEqual(Array.from(Router.unidas.sistema), ['integracoes', 'conexoes', 'saude-api', 'diagnostico']);
});

test('Preços e Anúncios também viram uma tela só', () => {
  const { Router } = carregar();
  assert.deepEqual(Array.from(Router.unidas.precos), ['precos-ml', 'precos-shopee']);
  assert.deepEqual(Array.from(Router.unidas.anuncios), ['criar-anuncio', 'anuncios-novos']);
});

test('no portal do cliente o endereço antigo abre a tela solta (o menu dele lista cada uma)', () => {
  const { Router, chamadas, navs } = carregar(true);
  Router.routes['criar-anuncio']({}, elFalso());
  assert.deepEqual(navs, []);
  assert.equal(chamadas.at(-1)[0], 'criar-anuncio');
});
