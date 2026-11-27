// Sessão apagada no servidor (mesmo login saiu em outro computador): glrApiFetch
// renova uma vez e, se não der, pede login de novo em vez de repetir o 401.
const { test } = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync('js/supabase-init.js', 'utf8');
function setup({ refreshOk, statuses }) {
  const nodes = new Map(), calls = [], signouts = [];
  const element = id => ({ id, style: {}, innerHTML: '', textContent: '', remove() { nodes.delete(this.id); }, querySelector() { return { textContent: '' }; }, focus() {} });
  const client = { auth: {
    getSession: async () => ({ data: { session: { access_token: 'velho' } } }),
    refreshSession: async () => refreshOk ? { data: { session: { access_token: 'novo' } }, error: null } : { data: { session: null }, error: { message: 'Session not found' } },
    signOut: async opts => { signouts.push(opts); }, onAuthStateChange() {}, getUser: async () => ({ data: {} }) },
    rpc: async () => ({}), from: () => ({}), channel: () => ({ on() { return this; }, subscribe() {} }) };
  const fila = [...statuses];
  const context = { console: { log() {}, warn() {}, error() {} }, URL, Headers, AbortController, Map, Set, Promise,
    fetch: async (url, init) => { calls.push(init.headers.get('Authorization')); return { status: fila.shift() }; },
    setTimeout: () => 0, clearTimeout() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { origin: 'https://consultoriaglr.com.br', hash: '', search: '' },
    document: { addEventListener() {}, getElementById: id => nodes.get(id) || null, querySelector: () => null, createElement: () => element(''), body: { appendChild: n => nodes.set(n.id, n) } },
    supabase: { createClient: () => client }, addEventListener() {}, GLR: {} };
  context.window = context; vm.runInNewContext(source, context);
  return { context, nodes, calls, signouts };
}
test('401 com sessão renovável repete com o token novo', async () => {
  const x = setup({ refreshOk: true, statuses: [401, 200] });
  const r = await x.context.glrApiFetch('/api/agente-cron?rodada=saldo&agora=1');
  assert.equal(r.status, 200);
  assert.equal(x.calls.join(), 'Bearer velho,Bearer novo');
  assert.equal(x.signouts.length, 0);
});
test('401 com sessão apagada pede login de novo e sai só deste navegador', async () => {
  const x = setup({ refreshOk: false, statuses: [401] });
  await assert.rejects(x.context.glrApiFetch('/api/agente-cron?rodada=saldo&agora=1'), /sessão foi encerrada/);
  assert.equal(JSON.stringify(x.signouts), '[{"scope":"local"}]');
  assert.ok(x.nodes.has('glr-login-overlay'));
});
test('sair do sistema não derruba o mesmo login em outros computadores', () => {
  assert.match(source, /fazerLogout[\s\S]{0,400}signOut\(\{ scope: 'local' \}\)/);
});
