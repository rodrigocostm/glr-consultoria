// Dashboard com cliente em foco: soma só as contas do cliente (glr_mc_vinculos) e guarda num cache próprio
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function montar(foco) {
  const hoje = new Date(), pad = n => String(n).padStart(2, '0');
  const dia1 = `${hoje.getFullYear()}-${pad(hoje.getMonth() + 1)}-01`;
  const store = new Map([['glr_mc_vinculos', JSON.stringify({
    1: [{ marketplace: 'shopee', external_id: 'S1', param_to_use: { shopId: 'S1' } }],
    2: [{ marketplace: 'shopee', external_id: 'S2', param_to_use: { shopId: 'S2' } }],
  })]]);
  const info = fat => ({ desde: '2020-01-01', dias: { [dia1]: { pedidos: 2, faturamento: fat, unidades: 2 } } });
  const base = { 'shopee:S1': info(100), 'shopee:S2': info(900) };
  const ctx = {
    console, Date, JSON, Math, Object, Array, String, Number, parseInt, parseFloat, isNaN, Promise, Set, Map,
    setTimeout: () => 0, setInterval: () => 0,
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    document: { getElementById: () => null, querySelectorAll: () => [] },
    Router: { register() {}, routes: {}, currentPage: 'outra', resolve() {} },
    BaseDados: { carregar: async () => base, mktDe: m => m, chave: (m, id) => `${m}:${id}`, cobre: () => true, somar: () => ({ faturamento: 0 }) },
    GLR: {
      clientes: [{ id: 1, nome: 'Loja Um' }, { id: 2, nome: 'Loja Dois' }],
      ctx: { cliente: () => foco },
      contaGeraComissao: () => false,
      comissao: { temComissao: () => false, modelo: () => ({ modelo: 'venda', valor: 0 }) },
    },
  };
  ctx.window = ctx; ctx.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(require.resolve('../js/pages-dashboard.js'), 'utf8'), ctx);
  return { ctx, store };
}
const total = c => (c?.dias || []).reduce((s, d) => s + d.faturamento, 0);

test('sem cliente em foco o Dashboard soma a carteira toda', async () => {
  const { ctx, store } = montar('');
  await ctx._dashBuscarVendasPorDia();
  const c = JSON.parse(store.get('glr_dashboard_vendas_dia'));
  assert.equal(total(c), 1000);
  assert.equal(total(ctx._dashVendasDiaCache()), 1000);
});

test('com cliente em foco soma só as contas dele, num cache separado', async () => {
  const { ctx, store } = montar('2');
  await ctx._dashBuscarVendasPorDia();
  assert.equal(store.has('glr_dashboard_vendas_dia'), false, 'não sobrescreve o cache da carteira');
  assert.equal(total(JSON.parse(store.get('glr_dashboard_vendas_dia:2'))), 900);
  assert.equal(total(ctx._dashVendasDiaCache()), 900);
});
