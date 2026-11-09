// Mercado Livre: reclamação encerrada a favor do comprador tira o pedido do faturamento;
// reembolso parcial desconta só a parte devolvida; a releitura do pedido não desfaz a marcação.
const { test, afterEach } = require('node:test'); const assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock'; process.env.MCP_API_KEY = 'mock';
const { _teste: S } = require('../api/sync-dados'); const orig = global.fetch; afterEach(() => { global.fetch = orig; });
const ok = d => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });

test('reembolso parcial: valor = total − reembolsado; pedido segue válido', () => {
  const l = S.mapearPedidoML('1', { id: 9, date_created: '2026-11-01T10:00:00Z', status: 'partially_refunded', total_amount: 300, payments: [{ id: 5, transaction_amount_refunded: 100 }], order_items: [] });
  assert.equal(l.situacao, 'valido'); assert.equal(l.valor_bruto, 200); assert.equal(l.taxas.reembolsado, 100);
  const p = S.mapearPedidoML('1', { id: 8, date_created: '2026-11-01T10:00:00Z', status: 'paid', total_amount: 300, payments: [{ id: 6 }], order_items: [] });
  assert.equal(p.valor_bruto, 300); assert.equal(p.taxas.reembolsado, undefined);
});

test('reclamação a favor do comprador marca devolvido (por pedido ou pacote); a favor do vendedor e parcial não', async () => {
  const gravados = []; let path = '';
  global.fetch = async (url, init = {}) => {
    if (url.includes('mcp.tiops.com.br')) {
      path = JSON.parse(init.body).params.path;
      return ok({ paging: { total: 4 }, data: [
        { resource_id: 111, resource: 'order', quantity_type: 'total', resolution: { reason: 'item_returned', benefited: ['complainant'] } },
        { resource_id: 222, resource: 'order', quantity_type: 'total', resolution: { reason: 'no_bpp', benefited: ['respondent'] } },
        { resource_id: 333, resource: 'order', quantity_type: 'partial', resolution: { reason: 'partial_refunded', benefited: ['complainant'] } },
        { resource_id: 444, resource: 'order', quantity_type: 'total', resolution: { reason: 'payment_refunded', benefited: ['complainant'] } },
      ] });
    }
    if (url.includes('/rest/v1/glr_pedidos') && (init.method || 'GET') === 'GET') {
      const q = decodeURIComponent(url);
      assert.ok(!/333|222/.test(q), 'só busca os pedidos a favor do comprador e não parciais');
      if (q.includes('pedido_id=in.')) return ok([{ marketplace: 'ml', conta_id: '1', pedido_id: '111', criado_em: '2026-10-20T12:00:00Z', situacao: 'valido', valor_bruto: 50 }]);
      if (q.includes('pack_id=in.')) return ok([{ marketplace: 'ml', conta_id: '1', pedido_id: '555', criado_em: '2026-10-21T12:00:00Z', situacao: 'valido', valor_bruto: 70 }]);
      return ok([]);
    }
    if (url.includes('/rest/v1/glr_pedidos') && init.method === 'POST') { gravados.push(...JSON.parse(init.body)); return ok(null); }
    return ok([]);
  };
  const t = Math.floor(Date.now() / 1000);
  const r = await S.marcarDevolucoesML('mock', '1', t - 90 * 86400, t, Date.now() + 60000);
  assert.equal(r.completo, true); assert.equal(r.n, 2);
  assert.deepEqual(gravados.map(g => [g.pedido_id, g.situacao]).sort(), [['111', 'devolvido'], ['555', 'devolvido']]);
  assert.match(decodeURIComponent(path), /status=closed&type=mediations&sort=last_updated:desc&range=last_updated:after:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000-03:00/);
});

test('releitura do pedido no ML mantém o devolvido', async () => {
  const gravados = [];
  global.fetch = async (url, init = {}) => {
    if (url.includes('mcp.tiops.com.br')) return ok({ paging: { total: 1 }, results: [{ id: 111, date_created: '2026-10-20T12:00:00Z', status: 'paid', total_amount: 50, payments: [{ id: 1 }], order_items: [] }] });
    if (url.includes('situacao=eq.devolvido')) return ok([{ pedido_id: '111' }]);
    if (init.method === 'POST') { gravados.push(...JSON.parse(init.body)); return ok(null); }
    return ok([]);
  };
  await S.gravarPedidosML('mock', '1', '2026-10-20', '2026-10-20', Date.now() + 60000);
  assert.equal(gravados[0].situacao, 'devolvido');
});
