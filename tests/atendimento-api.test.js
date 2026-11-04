const { test, afterEach } = require('node:test'); const assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock'; process.env.MCP_API_KEY = 'mock';
const handler = require('../api/atendimento'); const orig = global.fetch; afterEach(() => { global.fetch = orig; });
const res = () => ({ code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const req = body => ({ method: 'POST', headers: { authorization: 'Bearer t' }, body });
function mocks({ role = 'portal', cfgs, log } = {}) {
  const calls = []; global.fetch = async (url, init = {}) => {
    calls.push({ url, init }); const ok = d => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
    if (url.endsWith('/auth/v1/user')) return ok({ id: 'u', email: 'Cliente@Loja.com' });
    if (url.endsWith('/rpc/glr_acesso')) return ok({ role, portal: { email: 'cliente@loja.com' } });
    if (url.includes('chave=eq.glr_portal_configs')) return ok([{ dados: cfgs }]);
    if (url.includes('glr_agente_log?id=eq.') && (!init.method || init.method === 'GET')) return ok(log ? [log] : []);
    if (url.includes('glr_agente_log?tipo=eq.atendimento')) return ok([]);
    if (url.includes('mcp.tiops.com.br')) return ok({ ok: true });
    if (init.method === 'PATCH') return ok(null);
    throw new Error('inesperado ' + url);
  }; return calls;
}
test('cliente sem o módulo liberado não vê atendimentos', async () => {
  mocks({ cfgs: [{ id: 'p1', email: 'cliente@loja.com', contaIds: ['1'] }] }); const r = res();
  await handler(req({ acao: 'listar' }), r); assert.deepEqual(r.body, { liberado: false, itens: [] });
});
test('cliente liberado lista só as próprias contas', async () => {
  const calls = mocks({ cfgs: [{ id: 'p1', email: 'cliente@loja.com', contaIds: ['1', '2'], atendimentoIA: true }] }); const r = res();
  await handler(req({ acao: 'listar', contas: ['999'] }), r);
  assert.equal(r.body.liberado, true);
  const q = decodeURIComponent(calls.find(c => c.url.includes('tipo=eq.atendimento')).url);
  assert.match(q, /conta_id=in\.\("1","2"\)/); assert.doesNotMatch(q, /999/);
});
test('cliente não responde atendimento de conta que não é dele', async () => {
  const calls = mocks({ cfgs: [{ id: 'p1', email: 'cliente@loja.com', contaIds: ['1'], atendimentoIA: true }], log: { id: 'L', conta_id: '2', dados: { status: 'pendente', envio: { tipo: 'ml_pergunta', question_id: '9' } } } }); const r = res();
  await handler(req({ acao: 'responder', id: 'L', texto: 'oi' }), r);
  assert.equal(r.code, 404); assert.ok(!calls.some(c => c.url.includes('tiops')));
});
test('cliente responde pendente da própria conta: envia e marca respondida', async () => {
  const calls = mocks({ cfgs: [{ id: 'p1', email: 'cliente@loja.com', contaIds: ['1'], atendimentoIA: true }], log: { id: 'L', conta_id: '1', dados: { status: 'pendente', envio: { tipo: 'ml_pergunta', question_id: '9' } } } }); const r = res();
  await handler(req({ acao: 'responder', id: 'L', texto: 'Olá! Sim.' }), r);
  assert.equal(r.code, 200); assert.equal(r.body.item.dados.status, 'respondida_cliente'); assert.equal(r.body.item.dados.envio, undefined);
  assert.deepEqual(JSON.parse(calls.find(c => c.url.includes('tiops')).init.body), { action: 'ml_answer_question', params: { meliUserId: '1', question_id: '9', text: 'Olá! Sim.' } });
});
