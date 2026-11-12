// Chat do portal: só login do portal, só com o módulo liberado, e só as lojas do acesso
const { test, afterEach } = require('node:test'); const assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock'; process.env.MCP_API_KEY = 'mock'; process.env.ANTHROPIC_API_KEY = 'mock';
const orig = global.fetch; afterEach(() => { global.fetch = orig; });
const ok = d => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
const res = () => ({ code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const req = body => ({ method: 'POST', headers: { authorization: 'Bearer t' }, body });
function mock(acesso) {
  global.fetch = async (url, init = {}) => {
    if (url.endsWith('/auth/v1/user')) return ok({ id: 'u1', email: 'cli@x' });
    if (url.endsWith('/rpc/glr_acesso')) return ok(acesso);
    if (url.includes('glr_storage') && url.includes('glr_clientes')) return ok([{ dados: [{ id: 7, nome: 'Loja X' }, { id: 8, nome: 'Outro' }] }]);
    if (url.includes('glr_storage') && url.includes('glr_mc_vinculos')) return ok([{ dados: { 7: [{ marketplace: 'shopee', external_id: '111', param_to_use: { shopId: '111' } }, { marketplace: 'shopee', external_id: '222', param_to_use: { shopId: '222' } }], 8: [{ marketplace: 'shopee', external_id: '999', param_to_use: { shopId: '999' } }] } }]);
    if (url.includes('glr_storage')) return ok([]);
    return ok([]);
  };
}
const handler = require('../api/portal-chat');
test('equipe não usa o chat do portal', async () => { mock({ role: 'staff' }); const r = res(); await handler(req({ acao: 'enviar', mensagem: 'oi' }), r); assert.equal(r.code, 403); });
test('portal sem o módulo liberado é recusado', async () => { mock({ role: 'portal', portal: { clienteId: 7, contaIds: ['111'] } }); const r = res(); await handler(req({ acao: 'enviar', mensagem: 'oi' }), r); assert.equal(r.code, 403); assert.match(r.body.error, /não está liberado/); });
test('só as ferramentas de leitura das lojas do cliente', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../api/portal-chat.js'), 'utf8');
  for (const proibida of ['carteira', 'propor_acao', 'anotar_cerebro', 'decisoes_pendentes', 'historico_agentes', 'plano_cliente']) assert.ok(!new RegExp(`PERMITIDAS = \\[[^\\]]*'${proibida}'`).test(src), proibida);
  assert.match(src, /filter\(l => contas\.has\(String\(l\.conta_id\)\)\)/);
});
