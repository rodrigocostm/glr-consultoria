const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const ctx = { window: {}, Date }; vm.runInNewContext(fs.readFileSync('js/operacao-metricas.js', 'utf8'), ctx);
const { diario, gestoresDaConta } = ctx.window.GLROperacao;
const base = { mktDe: m => ({ mercadolivre: 'ml', meli: 'ml', ml: 'ml', shopee: 'shopee' })[m] || null,
  cobre: (info, dia) => !!info && info.desde <= dia, cobreAds: (info, dia) => !!info?.adsDesde && info.adsDesde <= dia };
const info = (fat, ads, overrides = {}) => ({ desde: '2026-11-01', adsDesde: '2026-11-01', dias: {
  '2026-11-01': { faturamento: fat, ads }, '2026-11-02': { faturamento: fat * 2, ads: ads * 3 } }, ...overrides });
const plataformas = [{ marketplace: 'shopee', contaId: 'S' }, { marketplace: 'mercadolivre', contaId: 'M' }];
function executar(mapa, plats = plataformas, data = '2026-11-02') { return diario(plats, data, (_, id) => mapa[id], base, '2026-11-11'); }
test('daily platform and general TACOS divide total ADS by total revenue; period is weighted', () => {
  const d = executar({ S: info(100, 10), M: info(900, 9) });
  assert.equal(d.dias.length, 2); assert.equal(d.dias[0].valores[0].fat, 1000);
  assert.equal(d.dias[0].valores[0].ads, 19); assert.equal(d.dias[0].valores[0].tacos, 1.9);
  assert.equal(d.dias[0].valores[1].tacos, 10); assert.equal(d.dias[0].valores[2].tacos, 1);
  assert.equal(d.totais[0].fat, 3000); assert.equal(d.totais[0].ads, 76);
  assert.equal(d.totais[0].tacos, 76 / 3000 * 100);
});
test('missing ADS is unknown, zero ADS is zero, and incomplete general has no TACOS', () => {
  const d = executar({ S: info(100, 0), M: info(900, 9, { adsDesde: null }) });
  assert.equal(d.dias[0].valores[1].tacos, 0); assert.equal(d.dias[0].valores[2].ads, null);
  assert.equal(d.dias[0].valores[0].parcialAds, true); assert.equal(d.totais[0].tacos, null);
});
test('coverage is evaluated for each day; never spreads monthly manual totals into daily data', () => {
  const d = executar({ S: info(100, 10, { desde: '2026-11-02' }) }, [plataformas[0], { nome: 'Amazon', fatBase: 900, adsBase: 100 }]);
  assert.equal(d.dias[0].valores[0].fat, null); assert.equal(d.dias[1].valores[0].fat, 200);
  assert.equal(d.dias[1].valores[0].parcialFat, true); assert.equal(d.dias[1].valores[0].tacos, null);
  assert.equal(d.totais[0].tacos, null);
});
test('canonical platform duplicates are counted once, future dates are not invented, and zero revenue has no ratio', () => {
  const d = executar({ S: info(0, 10), M: info(900, 9) }, [...plataformas, { marketplace: 'ml', contaId: 'M' }], '2026-11-30');
  assert.equal(d.dias.length, 11); assert.equal(d.dias[0].valores[0].fat, 900);
  assert.equal(d.dias[0].valores[1].tacos, null);
  assert.equal(d.dias[2].valores[0].fat, 0); assert.equal(d.dias[2].valores[0].tacos, null);
  assert.equal(executar({}, [], '2026-12-01').dias.length, 0);
});
test('manager lookup handles numeric/string IDs, legacy name, shop aliases and platform collisions', () => {
  const gestores = [{ id: 1, nome: 'Mateus' }, { id: 2, nome: 'Gabriel' }];
  const clientes = [{ id: 10, gestorId: '1' }, { id: 20, gestor: 'Gabriel' }];
  const vinculos = { 10: [{ marketplace: 'shopee', external_id: 'external', param_to_use: { shopId: 'S' } }], 20: [{ marketplace: 'ml', external_id: 'S' }] };
  assert.equal(gestoresDaConta('S', clientes, gestores, vinculos)[0].id, 1);
  assert.equal(gestoresDaConta('external', clientes, gestores, vinculos)[0].id, 1);
  assert.equal(gestoresDaConta('unknown', clientes, gestores, vinculos).length, 0);
  assert.equal(gestoresDaConta('other', clientes, gestores, vinculos, [{ conta_id: 'other', cliente_id: 20 }])[0].id, 2);
});
test('balance selector redraws only the chosen manager, including healthy accounts and unassigned stores', () => {
  const source = fs.readFileSync('js/pages-agente.js', 'utf8');
  const render = source.slice(source.indexOf('    const SALDO_NIV ='), source.indexOf('    window._agSaldosAgora ='));
  const state = { contas: [], saldos: { A: { nome: 'Loja A', nivel: 'ok', saldo: 100 }, B: { nome: 'Loja B', nivel: 'zerado', saldo: 0 }, C: { nome: 'Loja C', nivel: 'baixo', saldo: 5 } } };
  const fixture = { window: {}, GLROperacao: ctx.window.GLROperacao, state, GLR: { gestores: [{ id: 1, nome: 'Mateus' }, { id: 2, nome: 'Gabriel' }], clientes: [{ id: 10, gestorId: 1 }, { id: 20, gestorId: 2 }] },
    h: String, esc: String, R$: String, fmtNum: String, quandoCurto: () => '', configDaConta: () => null,
    localStorage: { getItem: () => JSON.stringify({ 10: [{ marketplace: 'shopee', external_id: 'A' }], 20: [{ marketplace: 'shopee', external_id: 'B' }] }) } };
  fixture.render = () => { fixture.html = vm.runInContext('renderSaldos()', fixture); };
  vm.createContext(fixture); vm.runInContext(render, fixture);
  fixture.window._agSaldosGestor('1'); assert.match(fixture.html, /Loja A/); assert.doesNotMatch(fixture.html, /Loja B|Loja C/);
  assert.equal(state.saldosTodas, true); assert.match(fixture.html, /value="1" selected/);
  fixture.window._agSaldosGestor('2'); assert.match(fixture.html, /Loja B/); assert.doesNotMatch(fixture.html, /Loja A|Loja C/);
  fixture.window._agSaldosGestor('sem'); assert.match(fixture.html, /Loja C/); assert.doesNotMatch(fixture.html, /Loja A|Loja B/);
  fixture.window._agSaldosGestor(''); assert.match(fixture.html, /Loja A/); assert.match(fixture.html, /Loja B/);
  fixture.window._agSaldosGestor('missing'); assert.match(fixture.html, /Nenhuma loja com saldo lido para este gestor/);
});
test('daily table renders exact values, platform selector and partial information from the real component', () => {
  const source = fs.readFileSync('js/pages-avancados.js', 'utf8');
  const render = source.slice(source.indexOf('  function renderDiario()'), source.indexOf('  function calcularPainel()'));
  const mapa = { S: info(100, 10), M: info(900, 9) };
  const fixture = { window: {}, Date, GLROperacao: ctx.window.GLROperacao, BaseDados: base, projecaoAtiva: { plataformas, dataBase: '2026-11-02' }, infoBaseDe: (_, id) => mapa[id], _pnEsc: String, _pnPlataformaDiaria: '', renderTabela: () => {} };
  vm.createContext(fixture); vm.runInContext(render, fixture);
  let html = vm.runInContext('renderDiario()', fixture);
  assert.match(html, /Mercado Livre/); assert.match(html, /Shopee/); assert.match(html, /Geral/); assert.match(html, /1,90%/);
  fixture.window._pnFiltrarDiario('ml'); html = vm.runInContext('renderDiario()', fixture);
  assert.match(html, /value="ml" selected/); assert.doesNotMatch(html, /1,90%/); assert.match(html, /1,00%/);
  mapa.M = info(900, 9, { adsDesde: null }); fixture.window._pnFiltrarDiario('');
  html = vm.runInContext('renderDiario()', fixture); assert.match(html, /pn-diario-parcial">parcial/); assert.match(html, /sem dados/);
});
test('shared operation module loads before both pages and page versions invalidate cache', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.ok(html.indexOf('js/operacao-metricas.js') < html.indexOf('js/pages-avancados.js'));
  assert.ok(html.indexOf('js/operacao-metricas.js') < html.indexOf('js/pages-agente.js'));
  assert.match(html, /pages-avancados.js\?v=diario-tacos-1/); assert.match(html, /pages-agente.js\?v=gestor-saldo-1/);
});
