const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === '@vercel/functions') return { waitUntil() {} };
  if (name === '@anthropic-ai/sdk') return class { constructor() { throw new Error('Paid SDK must not run'); } };
  return originalLoad.call(this, name, ...args);
};
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service';
process.env.ANTHROPIC_API_KEY = 'mock-ai';
process.env.GEMINI_API_KEY = 'mock-ai';
process.env.MCP_API_KEY = 'mock-mcp';
const auth = require('../api/_auth');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; delete process.env.CRON_SECRET; delete process.env.GLR_INTERNAL_ORIGIN; });
function res() { return { code: 200, status(n) { this.code = n; return this; }, json(data) { this.body = data; return this; } }; }
function mockRole(role) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(String(url));
    if (url.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user1', email: 'user@example.test' }) };
    if (url.endsWith('/rpc/glr_acesso')) return { ok: true, json: async () => role };
    if (url.includes('/rest/v1/glr_conhecimento?')) return { ok: true, json: async () => [] };
    if (url.includes('/rest/v1/glr_sync_estado')) return { ok: true, json: async () => (init?.method === 'POST' ? null : []) };
    if (url === 'https://api.anthropic.com/v1/messages') return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) };
    if (url === 'https://mcp.tiops.com.br') return { ok: true, status: 200, json: async () => ({ data: { accounts: [{external_id:'own'}, {external_id:'other'}] } }) };
    throw new Error('Unexpected external request: ' + url);
  };
  return calls;
}
const req = body => ({ method: 'POST', headers: { authorization: 'Bearer mock-session' }, body });
test('forged Vercel headers never authenticate a cron, even without CRON_SECRET', () => {
  const r = { headers: { 'x-vercel-cron': '1', 'x-vercel-cron-signature': 'anything' } };
  assert.equal(auth.cronAuthorized(r), false);
  process.env.CRON_SECRET = 'mock-secret';
  assert.equal(auth.cronAuthorized(r), false);
  assert.equal(auth.cronAuthorized({ headers: { authorization: 'Bearer wrong' } }), false);
  assert.equal(auth.cronAuthorized({ headers: { authorization: 'Bearer mock-secret' } }), true);
});
for (const name of ['chat', 'analyze-photo', 'generate-photo']) {
  test(`${name}: anonymous request never reaches a paid API`, async () => {
    let calls = 0; global.fetch = async () => { calls++; throw Error('Unexpected fetch'); };
    const r = res(); await require(`../api/${name}`)({ method: 'POST', headers: {}, body: {} }, r);
    assert.equal(r.code, 401); assert.equal(calls, 0);
  });
  // generate-photo é liberado ao portal (Criar anúncio) só nos tipos prontos — testado abaixo
  for (const role of name === 'generate-photo' ? ['denied'] : ['portal', 'denied']) test(`${name}: ${role} cannot use staff IA`, async () => {
    const calls = mockRole({ role }); const r = res();
    await require(`../api/${name}`)(req({}), r);
    assert.equal(r.code, 403); assert.equal(calls.length, 2);
  });
}
test('generate-photo: portal só usa os tipos prontos do Criar anúncio, nunca prompt livre', async () => {
  let calls = mockRole({ role: 'portal', portal: { contaIds: ['own'] } }); let r = res();
  await require('../api/generate-photo')(req({ stage: 'custom', prompt: 'qualquer coisa' }), r);
  assert.equal(r.code, 403); assert.equal(calls.length, 2);
  calls = mockRole({ role: 'portal', portal: { contaIds: ['own'] } }); r = res();
  await require('../api/generate-photo')(req({ stage: 'tipo', tipo: 'fundo_branco' }), r);
  assert.equal(r.code, 400); assert.equal(calls.length, 4); assert.equal(calls.some(u => u.includes('generativelanguage.googleapis.com')), false);
});
test('mcp: portal cria anúncio só na própria conta', async () => {
  let calls = mockRole({ role: 'portal', portal: { contaIds: ['own'] } }); let r = res();
  await require('../api/mcp')(req({ action: 'create_item', params: { meliUserId: 'other', price: 10, category_id: 'MLB1', available_quantity: 1 } }), r);
  assert.equal(r.code, 403); assert(!calls.includes('https://mcp.tiops.com.br'));
  calls = mockRole({ role: 'portal', portal: { contaIds: ['own'] } }); r = res();
  await require('../api/mcp')(req({ action: 'tiktok_create_product', params: { open_id: 'other', body: {} } }), r);
  assert.equal(r.code, 403); assert(!calls.includes('https://mcp.tiops.com.br'));
});
test('staff chat still works with a verified staff session', async () => {
  const calls = mockRole({ role: 'staff' }); const r = res();
  await require('../api/chat')(req({ messages: [{ role: 'user', content: 'test' }] }), r);
  assert.equal(r.code, 200); assert.equal(r.body.content, 'ok'); assert.equal(calls.length, 4); assert(calls[2].includes('/glr_conhecimento?'));
});
test('authorization outage fails closed', async () => {
  global.fetch = async () => { throw Error('offline'); };
  const r = res(); await require('../api/chat')(req({}), r); assert.equal(r.code, 503);
});
test('missing authorization migration fails closed', async () => {
  global.fetch = async url => url.endsWith('/auth/v1/user')
    ? { ok: true, json: async () => ({ id: 'user1' }) } : { ok: false };
  const r = res(); await require('../api/chat')(req({}), r); assert.equal(r.code, 503);
});
test('agent chat and central chat deny portal before reading account data', async () => {
  for (const name of ['agente-chat', 'chat-central']) {
    const calls = mockRole({ role: 'portal', portal: { contaIds: ['own'] } });
    const r = res(); await require(`../api/${name}`)(req({ conta_id: 'other', acao: 'listar' }), r);
    assert.equal(r.code, 401); assert.equal(calls.length, 2);
  }
});
test('portal MCP rejects another account, raw and unknown actions', async () => {
  const handler = require('../api/mcp');
  for (const body of [
    { action: 'list_orders_detail', params: { meliUserId: 'other' } },
    { action: 'raw', params: { meliUserId: 'own', path: '/orders/other' } },
    { action: 'new_admin_action', params: { meliUserId: 'own' } },
    { action: 'list_orders_detail', params: {} },
    { action: 'list_orders_detail', params: { meliUserId: 'own', shopId: 'other' } },
  ]) {
    const calls = mockRole({ role: 'portal', portal: { contaIds: ['own'] } });
    const r = res(); await handler(req(body), r); assert.equal(r.code, 403); assert.equal(calls.length, 2);
  }
});
test('unknown/disabled MCP user cannot fall through to staff', async () => {
  const calls = mockRole({ role: 'denied' }); const r = res();
  await require('../api/mcp')(req({ action: 'list_accounts' }), r);
  assert.equal(r.code, 403); assert.equal(calls.length, 2);
});
test('portal account listing returns only linked accounts', async () => {
  mockRole({ role: 'portal', portal: { contaIds: ['own'] } }); const r = res();
  await require('../api/mcp')(req({ action: 'list_accounts' }), r);
  assert.equal(r.code, 200); assert.deepEqual(r.body.data.accounts, [{external_id:'own'}]);
});
test('internal origin cannot derive from request headers and must be HTTPS', () => {
  assert.equal(auth.internalOrigin(), 'https://consultoriaglr.com.br');
  process.env.GLR_INTERNAL_ORIGIN = 'http://attacker.test';
  assert.throws(() => auth.internalOrigin());
  process.env.GLR_INTERNAL_ORIGIN = 'https://preview.example.test';
  assert.equal(auth.internalOrigin(), 'https://preview.example.test');
});
test('browser helper attaches the session only to same-origin API requests', async () => {
  const vm = require('node:vm');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../js/supabase-init.js'), 'utf8');
  const helper = source.slice(source.indexOf('window.glrApiFetch ='), source.indexOf('// Chaves gerenciadas'));
  const sent = [];
  const context = { URL, Headers, window: { location: { origin: 'https://app.example.test' } },
    _sb: { auth: { getSession: async () => ({ data: { session: { access_token: 'mock-browser' } } }) } },
    fetch: async (url, init) => { sent.push({ url, init }); return { ok: true }; } };
  vm.runInNewContext(helper, context);
  await context.window.glrApiFetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  assert.equal(sent[0].init.headers.get('Authorization'), 'Bearer mock-browser');
  assert.equal(sent[0].init.headers.get('Content-Type'), 'application/json');
  await assert.rejects(context.window.glrApiFetch('https://external.example.test/api/chat'));
  await assert.rejects(context.window.glrApiFetch('/landing.html'));
  assert.equal(sent.length, 1);
  context._sb.auth.getSession = async () => ({ data: { session: null } });
  await assert.rejects(context.window.glrApiFetch('/api/chat'));
  assert.equal(sent.length, 1);
});

// ── Chat com IA do portal: nunca alcança dados de outro cliente ──
test('portal-chat: equipe ou acesso sem o módulo não usam o chat do portal', async () => {
  const resH = () => Object.assign(res(), { setHeader() {} });
  let calls = mockRole({ role: 'staff' }); let r = resH();
  await require('../api/portal-chat')(req({ acao: 'enviar', mensagem: 'oi' }), r);
  assert.equal(r.code, 403); assert(!calls.includes('https://api.anthropic.com/v1/messages'));
  calls = mockRole({ role: 'portal', portal: { contaIds: ['own'], clienteId: '1', chatIA: false } }); r = resH();
  await require('../api/portal-chat')(req({ acao: 'enviar', mensagem: 'oi' }), r);
  assert.equal(r.code, 403); assert(!calls.includes('https://api.anthropic.com/v1/messages'));
});
test('portal-chat: ferramentas do portal recusam loja e cliente fora do acesso', async () => {
  const { EXEC } = require('../api/chat-central').interno;
  const S = { carteira: [{ id: '1', nome: 'Cliente Um', gestor: '', lojas: [{ marketplace: 'shopee', conta_id: 'own', nome: 'Loja Um' }] }], mcKey: 'mock-mcp' };
  global.fetch = async url => { throw new Error('Unexpected external request: ' + url); };
  await assert.rejects(() => EXEC.campanhas_shopee(S, { conta_id: 'other', inicio: '2026-11-01', fim: '2026-11-15' }), /não está na carteira/);
  await assert.rejects(() => EXEC.campanhas_ml(S, { conta_id: 'other', inicio: '2026-11-01', fim: '2026-11-15' }), /não está na carteira/);
  await assert.rejects(() => EXEC.vendas(S, { cliente: 'Cliente Dois', inicio: '2026-11-01', fim: '2026-11-15' }), /não encontrado/);
});
test('portal-chat: o portal não recebe as ferramentas internas da GLR', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../api/portal-chat.js'), 'utf8');
  const m = src.match(/const PERMITIDAS = \[([^\]]*)\]/); assert(m);
  for (const interna of ['carteira', 'plano_cliente', 'decisoes_pendentes', 'historico_agentes', 'propor_acao', 'anotar_cerebro', 'consultar_mercado_tiops', 'recursos_tiops']) assert(!m[1].includes(`'${interna}'`), interna);
});
test('mcp: notas fiscais só para acesso com o módulo Notas liberado', async () => {
  const calls = mockRole({ role: 'portal', portal: { contaIds: ['own'], clienteId: '1' } }); const r = res();
  await require('../api/mcp')(req({ action: 'glr_nfe_pedidos', params: { shopId: 'own' } }), r);
  assert.equal(r.code, 403); assert.match(r.body.error, /Notas não está liberada/); assert(!calls.includes('https://mcp.tiops.com.br'));
});
