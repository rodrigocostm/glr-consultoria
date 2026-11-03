const { test, afterEach } = require('node:test'); const assert = require('node:assert/strict');
const blog = require('../api/_blog'); const handler = require('../api/blog');
const original = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock'; afterEach(() => global.fetch = original);
const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; } });
const posts = [{ id: '1', slug: 'publicado', titulo: 'Post no ar', resumo: 'r', corpo: 'texto', status: 'publicado', publicado_em: '2026-11-02T10:00:00Z', fonte: { nome: 'F', url: 'https://f.com/a' } },
  { id: '2', slug: 'rascunho', titulo: 'Rascunho secreto', resumo: 'r', corpo: 'x', status: 'rascunho', fonte: { nome: 'F', url: 'https://f.com/b' } }];
const mock = () => { global.fetch = async () => ({ ok: true, text: async () => JSON.stringify([{ dados: { posts, usadas: {} } }]) }); };
test('public list and pages never show drafts', async () => {
  mock(); let r = res(); await handler({ method: 'GET', query: {} }, r);
  assert.equal(r.code, 200); assert.match(r.body, /Post no ar/); assert.doesNotMatch(r.body, /Rascunho secreto/);
  mock(); r = res(); await handler({ method: 'GET', query: { slug: 'rascunho' } }, r);
  assert.equal(r.code, 404); assert.doesNotMatch(r.body, /Rascunho secreto/);
});
test('anonymous cannot list or publish', async () => { global.fetch = () => { throw Error('unexpected'); }; const r = res(); await handler({ method: 'POST', headers: {}, body: { acao: 'listar' } }, r); assert.equal(r.code, 401); });
test('post text cannot inject HTML or script links', () => {
  const html = blog.mdParaHtml('<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.com)');
  assert.doesNotMatch(html, /<script>/); assert.doesNotMatch(html, /href="javascript/); assert.match(html, /href="https:\/\/a\.com"/);
});
