// Menu em 2 modos: com cliente em foco, endereço de tela que vive na Casa do
// cliente (#agente, #financeiro…) abre a aba certa do perfil; sem foco, nada muda.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ler = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function montar({ foco = '', hash = '#agente', portal = false } = {}) {
  const trocas = [];
  const casas = { agente: { aba: 'ads', sub: 'ads-shopee' }, financeiro: { aba: 'financeiro', sub: 'financeiro' } };
  const content = { innerHTML: '', classList: { add() {}, remove() {} }, scrollTop: 0, offsetWidth: 0 };
  const window = { addEventListener() {}, scrollTo() {}, location: { hash, replace: h => trocas.push(h) },
    GLRNav: { casaDe: p => casas[p] || null, atualizarModo() {} }, _portalConfig: portal ? {} : undefined };
  const document = { querySelectorAll: () => [], querySelector: () => null, getElementById: id => id === 'page-title' ? { textContent: '' } : id === 'page-content' ? content : null };
  const ctx = { window, document, console, GLR: { ctx: { cliente: () => foco } } };
  vm.createContext(ctx);
  vm.runInContext(ler('js/router.js') + ';this.R = Router;', ctx);
  const renders = [];
  for (const r of ['agente', 'financeiro', 'dashboard', 'cliente-perfil']) ctx.R.register(r, () => renders.push(r));
  ctx.R.resolve();
  return { trocas, renders, R: ctx.R };
}

test('sem cliente em foco, #agente abre a tela de sempre', () => {
  const { trocas, renders } = montar({ hash: '#agente' });
  assert.deepEqual(trocas, []);
  assert.deepEqual(renders, ['agente']);
});

test('com cliente em foco, #agente vai para a aba ADS do perfil', () => {
  const { trocas, renders } = montar({ foco: '7', hash: '#agente' });
  assert.deepEqual(trocas, ['#cliente-perfil?id=7&aba=ads&sub=ads-shopee']);
  assert.deepEqual(renders, []);
});

test('com cliente em foco, tela fora da Casa (Painel) abre normal', () => {
  const { trocas, renders } = montar({ foco: '7', hash: '#dashboard' });
  assert.deepEqual(trocas, []);
  assert.deepEqual(renders, ['dashboard']);
});

test('portal do cliente nunca redireciona', () => {
  const { trocas } = montar({ foco: '7', hash: '#financeiro', portal: true });
  assert.deepEqual(trocas, []);
});

test('nav.js monta o modo Cliente a partir das abas do perfil', () => {
  const nav = ler('js/nav.js');
  assert.match(nav, /function casaDe\(pagina\)/);
  assert.match(nav, /classList\.toggle\('modo-cliente'/);
  assert.match(ler('css/styles.css'), /#sidebar\.modo-cliente \.nav-item\.na-casa/);
  assert.doesNotMatch(nav, /window\.GLR\?/, 'GLR é const global, não fica em window');
});

test('ninguém procura GLR em window (é const global e não fica lá)', () => {
  const dir = path.join(__dirname, '..', 'js');
  const ruins = fs.readdirSync(dir).filter(f => f.endsWith('.js')).filter(f => /window\.GLR\?\.|window\.GLR\s*&&|window\.Router\b/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(ruins, []);
});
