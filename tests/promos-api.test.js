const { test, afterEach } = require('node:test'); const assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock'; process.env.MCP_API_KEY = 'mock';
const handler = require('../api/promos'); const orig = global.fetch; afterEach(() => { global.fetch = orig; });
const res = () => ({ code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const req = body => ({ method: 'POST', headers: { authorization: 'Bearer t' }, body });
function mocks({ role = 'staff', contaIds = [], cache = null, nItens = 3 } = {}) {
  const calls = []; global.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); const ok = d => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
    if (url.endsWith('/auth/v1/user')) return ok({ id: 'u' });
    if (url.endsWith('/rpc/glr_acesso')) return ok({ role, portal: { contaIds } });
    if (url.includes('recurso=eq.promos_ml')) return ok(cache ? [{ cursor: cache }] : []);
    if (url.includes('glr_vendas_custo_catalogo')) return ok([{ dados: { MLB1: 50 } }]);
    if (url.includes('glr_sync_estado?on_conflict')) return ok(null);
    if (url.includes('mcp.tiops.com.br')) {
      const { action, params } = JSON.parse(init.body);
      if (action === 'list_items') return ok({ results: params.offset ? [] : Array.from({ length: nItens }, (_, i) => ({ body: { id: `MLB${i + 1}`, title: 'x', price: 100, category_id: 'C', listing_type_id: 'gold_special', shipping: { mode: 'me2' } } })) });
      if (action === 'ml_item_promotions') return ok({ items: [{ type: 'DEAL', status: 'candidate', suggested_discounted_price: 90, max_discounted_price: 95 }] });
      if (action === 'ml_listing_fees') return ok({ sale_fee_details: { percentage_fee: 16.5, fixed_fee: 0 } });
      if (action === 'raw') return ok({ coverage: { all_country: { list_cost: 20 } } });
    }
    throw new Error('inesperado ' + url);
  }; return calls;
}
test('cliente do portal não busca promoções de conta que não é dele', async () => {
  const calls = mocks({ role: 'portal', contaIds: ['111'] }); const r = res();
  await handler(req({ acao: 'carregar', conta: '999' }), r);
  assert.equal(r.code, 403); assert.ok(!calls.some(c => c.url.includes('tiops')));
});
test('resultado guardado e recente volta sem consultar o ML', async () => {
  const calls = mocks({ cache: { em: Date.now() - 60000, completo: true, itens: [{ id: 'MLB1' }], taxas: {}, fretes: {} } }); const r = res();
  await handler(req({ acao: 'carregar', conta: '111' }), r);
  assert.equal(r.body.guardado, true); assert.ok(!calls.some(c => c.url.includes('tiops')));
});
test('busca nova: promoções de todos, tarifa por categoria, frete só de quem tem custo, e guarda', async () => {
  const calls = mocks(); const r = res();
  await handler(req({ acao: 'carregar', conta: '111', forcar: true }), r);
  assert.equal(r.body.itens.length, 3); assert.equal(r.body.itens[0].promos.length, 1);
  assert.deepEqual(r.body.taxas['C|gold_special|pct'], { pct: 16.5, fixo: 0 });
  const fretes = calls.filter(c => c.body?.action === 'raw').map(c => c.body.params.path);
  assert.ok(fretes.every(p => p.includes('item_id=MLB1'))); assert.equal(r.body.fretes['MLB1|90.00'], 20);
  assert.ok(calls.some(c => c.url.includes('on_conflict') && c.body[0].recurso === 'promos_ml'));
});
