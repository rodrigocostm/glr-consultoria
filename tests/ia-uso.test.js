const test = require('node:test');
const assert = require('node:assert');
const { medir, cacheNaConversa, linha, registrar } = require('../api/_ia-uso');

test('cacheNaConversa marca só o último bloco e não altera o original', () => {
  const msgs = [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }, { type: 'tool_result', tool_use_id: 't2', content: 'b' }] },
  ];
  const antes = JSON.stringify(msgs);
  const out = cacheNaConversa(msgs);
  assert.strictEqual(JSON.stringify(msgs), antes);
  assert.deepStrictEqual(out[2].content[1].cache_control, { type: 'ephemeral' });
  assert.strictEqual(out[2].content[0].cache_control, undefined);
  assert.strictEqual(out[0], msgs[0]);
  // rodadas seguintes: a marca antiga não acumula (no máximo 1 na conversa)
  const depois = cacheNaConversa([...msgs, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'e agora?' }]);
  const marcas = JSON.stringify(depois).match(/cache_control/g) || [];
  assert.strictEqual(marcas.length, 1);
  assert.deepStrictEqual(depois[4].content, [{ type: 'text', text: 'e agora?', cache_control: { type: 'ephemeral' } }]);
});

test('cacheNaConversa deixa vazios como estão', () => {
  assert.deepStrictEqual(cacheNaConversa([]), []);
  const vazio = [{ role: 'user', content: '' }];
  assert.strictEqual(cacheNaConversa(vazio), vazio);
});

test('linha traduz o usage da API para a tabela', () => {
  const l = linha('agente-chat', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 }, { usuario: 'a@b', conta_id: 123, agente: 'copiloto' });
  assert.deepStrictEqual(l, { origem: 'agente-chat', modelo: 'claude-sonnet-5-5', entrada: 10, saida: 5, cache_leitura: 900, cache_escrita: 100, usuario: 'a@b', conta_id: '123', extra: { agente: 'copiloto' } });
  assert.strictEqual(linha('x', null, {}, null).extra, null);
});

test('medir grava os tokens de create e de stream sem mudar a resposta', async () => {
  const gravados = [];
  const fetchOrig = global.fetch, chaveOrig = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'teste';
  global.fetch = async (url, init) => { gravados.push({ url, corpo: JSON.parse(init.body)[0] }); return { ok: true }; };
  try {
    const ouvintes = {};
    const msg = { model: 'claude-sonnet-5-5', usage: { input_tokens: 7, output_tokens: 3 }, content: [] };
    const fake = {
      messages: { create: async () => msg },
      beta: { messages: { create: async () => ({ ...msg, model: 'claude-haiku-5-5' }), stream: () => ({ on: (ev, fn) => { ouvintes[ev] = fn; } }) } },
    };
    medir(fake, 'chat-central', { usuario: 'u@glr' });
    medir(fake, 'chat-central'); // embrulhar duas vezes não duplica
    assert.strictEqual(await fake.messages.create({}), msg);
    await fake.beta.messages.create({});
    fake.beta.messages.stream({});
    ouvintes.finalMessage({ model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 50 } });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(gravados.length, 3);
    assert.ok(gravados.every(g => g.url.endsWith('/rest/v1/glr_ia_uso') && g.corpo.origem === 'chat-central' && g.corpo.usuario === 'u@glr'));
    assert.deepStrictEqual(gravados.map(g => g.corpo.modelo), ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
    assert.strictEqual(gravados[2].corpo.cache_leitura, 50);
  } finally {
    global.fetch = fetchOrig;
    if (chaveOrig === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = chaveOrig;
  }
});

test('falha ao gravar nunca derruba a chamada', async () => {
  const fetchOrig = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'teste';
  global.fetch = async () => { throw new Error('fora do ar'); };
  try {
    assert.strictEqual(await registrar('x', 'm', { input_tokens: 1 }), false);
    const fake = { messages: { create: async () => ({ model: 'm', usage: { input_tokens: 1 } }) } };
    medir(fake, 'x');
    assert.strictEqual((await fake.messages.create({})).model, 'm');
    assert.strictEqual(await registrar('x', 'm', null), false);
  } finally { global.fetch = fetchOrig; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('os chats com ferramentas usam cache na conversa e todos os clientes da IA são medidos', () => {
  const fs = require('node:fs');
  for (const f of ['agente-chat', 'chat-central', 'portal-chat']) assert.match(fs.readFileSync(`api/${f}.js`, 'utf8'), /cacheNaConversa\(mensagens\)/, f);
  const pastas = fs.readdirSync('api').filter(f => f.endsWith('.js'));
  for (const f of pastas) {
    const s = fs.readFileSync(`api/${f}`, 'utf8');
    const novos = (s.match(/new Anthropic\(/g) || []).length;
    const medidos = (s.match(/medir\(new Anthropic\(/g) || []).length;
    assert.strictEqual(novos, medidos, `${f}: cliente da Anthropic sem medir()`);
    if (/api\.anthropic\.com\/v1\/messages/.test(s)) assert.match(s, /_ia-uso'\)\.registrar\(/, `${f}: chamada por fetch sem registrar()`);
  }
});
