const { test } = require('node:test'); const assert = require('node:assert/strict');
const ia = require('../api/_atendimento-ia');

function ambiente({ perguntas = [], unread = [], packs = {}, magalu = [], magaluMsgs = {}, vistos = [], falhaEnvio = false } = {}) {
  const chamadas = [], logs = [];
  const mcpCall = async (k, acao, p) => {
    chamadas.push({ acao, p });
    if (acao === 'ml_list_questions') return { questions: perguntas };
    if (acao === 'get_items') return { items: [{ body: { id: 'MLB1', title: 'Mesa de centro', price: 199, available_quantity: 3, attributes: [{ name: 'Cor', value_name: 'Preto' }] } }] };
    if (acao === 'get_description') return { plain_text: 'Mesa em MDF.' };
    if (acao === 'ml_messages_unread') return { results: unread };
    if (acao === 'ml_messages_get') return packs[p.pack_id];
    if (acao === 'raw_read') return { id: 55, status: 'paid', date_created: '2026-11-01', order_items: [{ quantity: 1, item: { title: 'Mesa de centro' } }] };
    if (acao === 'magalu_list_conversations') return { results: magalu };
    if (acao === 'magalu_conversation_messages') return { results: magaluMsgs[p.conversation_id] || [] };
    if (/answer|send/.test(acao)) { if (falhaEnvio) throw new Error('400 bloqueado'); return { ok: true }; }
    throw new Error('ação inesperada ' + acao);
  };
  const ctx = { mcpCall, apiKey: 'k', anthropicKey: 'a', prazo: Date.now() + 60000,
    sbSelect: async () => vistos.map(ref => ({ ref })),
    logar: async (titulo, explicacao, dados, resultado) => logs.push({ titulo, dados, resultado }),
    gerar: async (_k, item) => /troca|defeito/i.test(item.conversa) ? { acao: 'humano', texto: '', motivo: 'pedido de troca', tokens: { entrada: 10, saida: 2 } }
      : /obrigad/i.test(item.conversa) ? { acao: 'nada', texto: '', motivo: 'agradeceu', tokens: { entrada: 5, saida: 1 } }
      : { acao: 'responder', texto: 'Olá! Temos sim, na cor preta.', motivo: null, tokens: { entrada: 100, saida: 20 } } };
  return { ctx, chamadas, logs };
}

test('pergunta do ML com resposta no anúncio: a IA responde sozinha e registra', async () => {
  const { ctx, chamadas, logs } = ambiente({ perguntas: [{ id: 9, item_id: 'MLB1', text: 'Tem na cor preta?' }] });
  const r = await ia.atenderConta(ctx, 'ml', '123');
  assert.equal(r.respondidas, 1);
  const env = chamadas.find(c => c.acao === 'ml_answer_question');
  assert.deepEqual(env.p, { meliUserId: '123', question_id: '9', text: 'Olá! Temos sim, na cor preta.' });
  assert.equal(logs[0].dados.status, 'respondida_ia'); assert.equal(logs[0].dados.ref, 'ml:q:9'); assert.equal(logs[0].resultado, 'executado');
});
test('pergunta já tratada antes não gasta IA de novo', async () => {
  const { ctx, chamadas } = ambiente({ perguntas: [{ id: 9, item_id: 'MLB1', text: 'Tem preta?' }], vistos: ['ml:q:9'] });
  const r = await ia.atenderConta(ctx, 'ml', '123');
  assert.equal(r.respondidas + r.pendentes, 0); assert.ok(!chamadas.some(c => c.acao === 'ml_answer_question'));
});
test('mensagem pós-venda pedindo troca fica para o cliente, sem enviar nada', async () => {
  const pk = { messages: [{ id: 'm1', from: { user_id: 777 }, text: 'Quero trocar, veio com defeito', message_date: { created: '2026-11-04T10:00:00Z' } }], conversation_status: { claim_ids: [] }, seller_max_message_length: 350 };
  const { ctx, chamadas, logs } = ambiente({ unread: [{ resource: '/packs/2000/sellers/123' }], packs: { 2000: pk } });
  const r = await ia.atenderConta(ctx, 'ml', '123');
  assert.equal(r.pendentes, 1); assert.ok(!chamadas.some(c => c.acao === 'ml_messages_send'));
  assert.equal(logs[0].dados.status, 'pendente'); assert.equal(logs[0].resultado, 'so_alerta'); assert.deepEqual(logs[0].dados.envio, { tipo: 'ml_mensagem', pack_id: '2000', buyer_id: '777' });
});
test('reclamação aberta no pedido nem chama a IA', async () => {
  let chamouIA = false;
  const pk = { messages: [{ id: 'm1', from: { user_id: 777 }, text: 'cadê?', message_date: { created: '2026-11-04T10:00:00Z' } }], conversation_status: { claim_ids: [5] } };
  const { ctx, logs } = ambiente({ unread: [{ resource: '/packs/2000/sellers/123' }], packs: { 2000: pk } });
  const g = ctx.gerar; ctx.gerar = async (...a) => { chamouIA = true; return g(...a); };
  await ia.atenderConta(ctx, 'ml', '123');
  assert.equal(chamouIA, false); assert.equal(logs[0].dados.motivo, 'reclamação aberta');
});
test('última mensagem da própria loja: nada a fazer', async () => {
  const pk = { messages: [{ id: 'm2', from: { user_id: 123 }, text: 'Enviado!', message_date: { created: '2026-11-04T11:00:00Z' } }] };
  const { ctx, logs } = ambiente({ unread: [{ resource: '/packs/2000/sellers/123' }], packs: { 2000: pk } });
  await ia.atenderConta(ctx, 'ml', '123'); assert.equal(logs.length, 0);
});
test('Magalu: responde a conversa cuja última mensagem é do comprador', async () => {
  const { ctx, chamadas } = ambiente({ magalu: [{ id: 'c1', last_message: { user: { type: 'CUSTOMER' } } }, { id: 'c2', last_message: { user: { type: 'SELLER' } } }],
    magaluMsgs: { c1: [{ id: 'x1', content: 'PRODUCT_MESSAGE', when_at: '2026-11-04T09:00:00Z', from_user: { type: 'CUSTOMER' }, custom_fields: [{ name: 'productTitle', value: 'Puff' }] }, { id: 'x2', content: 'Tem preto?', when_at: '2026-11-04T09:01:00Z', from_user: { type: 'CUSTOMER' } }] } });
  const r = await ia.atenderConta(ctx, 'magalu', 'GENPUB.x');
  assert.equal(r.respondidas, 1);
  const env = chamadas.find(c => c.acao === 'magalu_send_conversation_message');
  assert.deepEqual(env.p, { magalu_account_id: 'GENPUB.x', conversation_id: 'c1', content: 'Olá! Temos sim, na cor preta.' });
  assert.ok(!chamadas.some(c => c.acao === 'magalu_conversation_messages' && c.p.conversation_id === 'c2'));
});
test('envio recusado pela plataforma vira pendente com o rascunho', async () => {
  const { ctx, logs } = ambiente({ perguntas: [{ id: 9, item_id: 'MLB1', text: 'Tem preta?' }], falhaEnvio: true });
  const r = await ia.atenderConta(ctx, 'ml', '123');
  assert.equal(r.pendentes, 1); assert.equal(logs[0].dados.rascunho, 'Olá! Temos sim, na cor preta.');
});
test('só entram as contas de quem tem o módulo liberado e o portal ativo', async () => {
  const m = await ia.contasLiberadas(async () => [{ id: 'a', atendimentoIA: true, contaIds: ['1', '2'], clienteNome: 'A' }, { id: 'b', contaIds: ['3'] }, { id: 'c', atendimentoIA: true, ativo: false, contaIds: ['4'] }]);
  assert.deepEqual([...m.keys()], ['1', '2']);
});
