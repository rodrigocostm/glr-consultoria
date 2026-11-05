// ============================================================
// GLR Consultoria — Atendimento com IA (módulo do Portal do Cliente)
// ------------------------------------------------------------
// Só para os clientes que a GLR LIBEROU no admin do portal (cfg.atendimentoIA,
// em glr_portal_configs) — cada resposta gasta tokens da IA. Roda no
// sincronizador (api/sync-dados.js), a cada visita da loja (~15 min), e
// RESPONDE SOZINHO ao comprador (decisão do analista, 04/11/2026):
//  • Mercado Livre — perguntas nos anúncios (com os dados do anúncio) e
//    mensagens pós-venda (com o status do pedido e do envio);
//  • Magalu — conversas com compradores (chamadas no formato PLANO: conta e campos no mesmo nível).
// Shopee (a Shopee só libera o chat para sistema próprio do vendedor) e TikTok
// Shop (chat ainda não liberado para a integração) não têm API de chat.
// A IA só responde com o que está nos dados: reclamação, defeito, troca,
// devolução, cancelamento, reembolso, negociação, anexo ou informação que não
// está no anúncio/pedido ficam "para você responder" no portal, com o motivo.
// Registro em glr_agente_log (tipo 'atendimento'): canal, pergunta, resposta,
// status e tokens — sem nome, e-mail ou telefone do comprador.
// ============================================================
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;
const { dadosDoAnuncio } = require('./_reputacao');

const MODELO = 'claude-haiku-5-5';
const POR_RODADA = 8;          // respostas por loja a cada visita (controle de custo e de tempo)
const corta = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ── Quem está liberado: conta → { cfgId, cliente } ──
async function contasLiberadas(lerStorage) {
  const cfgs = await lerStorage('glr_portal_configs').catch(() => null);
  const mapa = new Map();
  for (const c of (Array.isArray(cfgs) ? cfgs : [])) {
    if (!c?.atendimentoIA || c.ativo === false) continue;
    for (const id of (c.contaIds || [])) mapa.set(String(id), { cfgId: c.id, cliente: c.clienteNome || null });
  }
  return mapa;
}

const SISTEMA = `Você atende compradores em nome de uma loja brasileira que vende em marketplace. Escreva em português do Brasil, cordial, claro e curto.
Use SOMENTE as informações dos DADOS recebidos (anúncio, pedido, envio, conversa). Nunca invente medidas, cores, estoque, prazo, garantia, nota fiscal, compatibilidade ou promessa.
Decida a ação:
- "responder": a resposta está nos dados, ou é uma dúvida simples de atendimento.
- "humano": reclamação, produto com defeito/avaria/faltando peça, troca, devolução, cancelamento, reembolso, pedido atrasado ou não entregue que o rastreio não explica, negociação de preço/desconto, pedido de contato fora da plataforma, assunto jurídico/Procon, comprador irritado, mensagem só com foto/anexo, ou quando a informação não está nos dados.
- "nada": o comprador só agradeceu, confirmou o recebimento ou encerrou a conversa e não espera resposta.
Regras do texto: não passe telefone, e-mail, WhatsApp, redes sociais nem links; não peça dados pessoais; não mencione que é uma IA; respeite o limite de caracteres informado.
Responda APENAS com JSON: {"acao":"responder|humano|nada","texto":"...","motivo":"frase curta para o lojista quando a ação não for responder"}`;

async function gerar(anthropicKey, { canal, limite, dados, conversa }) {
  const client = new Anthropic({ apiKey: anthropicKey });
  const r = await client.messages.create({
    model: MODELO, max_tokens: 500, system: SISTEMA,
    messages: [{ role: 'user', content: `CANAL: ${canal}\nLIMITE DO TEXTO: ${limite} caracteres\n\nDADOS:\n${dados || '—'}\n\nCONVERSA (mais antiga primeiro):\n${conversa}` }],
  });
  const tokens = { entrada: r.usage?.input_tokens || 0, saida: r.usage?.output_tokens || 0 };
  const txt = r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  let j = null;
  try { j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch (e) { j = null; }
  const acao = ['responder', 'humano', 'nada'].includes(j?.acao) ? j.acao : 'humano';
  const texto = String(j?.texto || '').trim();
  if (acao === 'responder' && (!texto || texto.length > limite)) return { acao: 'humano', texto: texto.slice(0, limite), motivo: 'a IA não conseguiu uma resposta segura dentro do limite', tokens };
  return { acao, texto, motivo: String(j?.motivo || '').slice(0, 200) || null, tokens };
}

// ── Mercado Livre: contexto do pedido (pós-venda) ──
async function contextoPedidoML(mcpCall, apiKey, conta, pack) {
  const ler = path => mcpCall(apiKey, 'raw_read', { meliUserId: conta, path }).then(r => r?.data || r).catch(() => null);
  let ped = await ler(`/orders/${pack}`);
  if (!ped?.id) { const pk = await ler(`/packs/${pack}`); const oid = pk?.orders?.[0]?.id; if (oid) ped = await ler(`/orders/${oid}`); }
  if (!ped?.id) return null;
  const itens = (ped.order_items || []).map(i => `${i.quantity}x ${corta(i.item?.title, 90)}${i.item?.variation_attributes?.length ? ` (${i.item.variation_attributes.map(a => a.value_name).join('/')})` : ''}`).join('; ');
  let envio = '';
  if (ped.shipping?.id) {
    const s = await ler(`/shipments/${ped.shipping.id}`);
    if (s?.status) envio = `Envio: ${s.status}${s.substatus ? ` / ${s.substatus}` : ''}${s.tracking_number ? ` · rastreio ${s.tracking_number}` : ''}${s.shipping_option?.estimated_delivery_time?.date ? ` · previsão de entrega ${String(s.shipping_option.estimated_delivery_time.date).slice(0, 10)}` : ''}${s.status_history?.date_delivered ? ` · entregue em ${String(s.status_history.date_delivered).slice(0, 10)}` : ''}`;
  }
  return `Pedido ${ped.id} · status ${ped.status} · feito em ${String(ped.date_created || '').slice(0, 10)}\nItens: ${itens || '—'}\n${envio || 'Envio: sem informação'}`;
}

// ── Processa uma conta liberada; devolve { respondidas, pendentes, nada, erros, tokens } ──
// ctx: { mcpCall, apiKey, sbSelect, logar(titulo, explicacao, dados, resultado), anthropicKey, prazo }
async function atenderConta(ctx, mkt, conta) {
  const { mcpCall, apiKey, sbSelect, logar, anthropicKey, prazo } = ctx;
  if (!anthropicKey) return { erro: 'IA não configurada' };
  const desde = new Date(Date.now() - 20 * 864e5).toISOString();
  const vistos = new Set((await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(conta)}&tipo=eq.atendimento&criado_em=gte.${encodeURIComponent(desde)}&select=ref:dados->>ref&limit=2000`).catch(() => [])).map(r => r.ref).filter(Boolean));
  const res = { respondidas: 0, pendentes: 0, nada: 0, erros: 0, tokens: 0 };
  let feitos = 0;
  const tempo = () => feitos < POR_RODADA && Date.now() < prazo;

  async function tratar(item) { // { canal, rotulo, ref, envio, pergunta, produto, dados, conversa, limite, enviar }
    feitos++;
    let g;
    try { g = await (ctx.gerar || gerar)(anthropicKey, item); } catch (e) { res.erros++; return; }
    res.tokens += g.tokens.entrada + g.tokens.saida;
    const base = { marketplace: mkt, canal: item.canal, ref: item.ref, envio: item.envio, pergunta: corta(item.pergunta, 600), produto: item.produto ? corta(item.produto, 120) : null, tokens: g.tokens };
    if (g.acao === 'responder') {
      try {
        await item.enviar(g.texto);
        await logar(`Respondida pela IA — ${item.rotulo}`, g.texto, { ...base, resposta: g.texto, status: 'respondida_ia', respondida_em: new Date().toISOString() }, 'executado');
        res.respondidas++;
      } catch (e) {
        await logar(`Não consegui enviar — ${item.rotulo}`, `A IA escreveu a resposta, mas a plataforma recusou o envio: ${corta(e.message, 200)}`, { ...base, rascunho: g.texto, status: 'pendente', motivo: 'a plataforma recusou o envio' }, 'so_alerta');
        res.erros++; res.pendentes++;
      }
    } else if (g.acao === 'nada') {
      await logar(`Sem resposta necessária — ${item.rotulo}`, g.motivo || 'O comprador não espera resposta.', { ...base, status: 'sem_resposta', motivo: g.motivo }, 'executado');
      res.nada++;
    } else {
      await logar(`Para você responder — ${item.rotulo}`, g.motivo || 'Precisa de alguém da loja.', { ...base, rascunho: g.texto || null, status: 'pendente', motivo: g.motivo }, 'so_alerta');
      res.pendentes++;
    }
  }

  if (mkt === 'ml') {
    // 1) perguntas nos anúncios
    const rq = await mcpCall(apiKey, 'ml_list_questions', { meliUserId: conta, status: 'UNANSWERED', limit: 30, sort_fields: 'date_created', sort_types: 'ASC' }).catch(() => null);
    for (const q of (rq?.questions || rq?.data?.questions || [])) {
      if (!tempo()) break;
      const ref = `ml:q:${q.id}`; if (vistos.has(ref)) continue;
      const an = await dadosDoAnuncio(mcpCall, apiKey, conta, q.item_id).catch(() => null);
      await tratar({ canal: 'Pergunta no anúncio do Mercado Livre', rotulo: 'pergunta no Mercado Livre', ref, envio: { tipo: 'ml_pergunta', question_id: String(q.id) }, pergunta: q.text, produto: an?.titulo || q.item_id,
        dados: an?.texto || null, conversa: `Comprador: ${corta(q.text, 800)}`, limite: 800,
        enviar: texto => mcpCall(apiKey, 'ml_answer_question', { meliUserId: conta, question_id: String(q.id), text: texto }) });
    }
    // 2) mensagens pós-venda não lidas
    const mu = await mcpCall(apiKey, 'ml_messages_unread', { meliUserId: conta }).catch(() => null);
    for (const r of (mu?.results || mu?.data?.results || [])) {
      if (!tempo()) break;
      const pack = String(r.resource || '').match(/packs\/(\d+)/)?.[1]; if (!pack) continue;
      const mg = await mcpCall(apiKey, 'ml_messages_get', { meliUserId: conta, pack_id: pack, mark_as_read: false }).catch(() => null);
      const msgs = (mg?.messages || mg?.data?.messages || []).slice().sort((a, b) => String(a.message_date?.created).localeCompare(String(b.message_date?.created)));
      const ult = msgs[msgs.length - 1]; if (!ult || String(ult.from?.user_id) === String(conta)) continue; // última é da loja: nada a fazer
      const ref = `ml:m:${pack}:${ult.id}`; if (vistos.has(ref)) continue;
      const buyer = String(ult.from?.user_id || '');
      const conversa = msgs.slice(-10).map(m => `${String(m.from?.user_id) === String(conta) ? 'Loja' : 'Comprador'}: ${m.text ? corta(m.text, 600) : ''}${m.message_attachments?.length ? ' [enviou anexo/foto]' : ''}`).join('\n');
      const reclamacao = (mg?.conversation_status?.claim_ids || []).length > 0;
      const ultTexto = ult.text || (ult.message_attachments?.length ? '[foto/anexo]' : '');
      const envio = { tipo: 'ml_mensagem', pack_id: pack, buyer_id: buyer };
      if (reclamacao) { // reclamação aberta: sempre com a loja, sem gastar IA
        await logar('Para você responder — mensagem com reclamação aberta', 'Este pedido tem uma reclamação aberta no Mercado Livre: responda pelo painel da reclamação.', { marketplace: mkt, canal: 'Mensagem pós-venda do Mercado Livre', ref, envio, pergunta: corta(ultTexto, 600), produto: null, status: 'pendente', motivo: 'reclamação aberta' }, 'so_alerta');
        res.pendentes++; feitos++; continue;
      }
      const pedido = await contextoPedidoML(mcpCall, apiKey, conta, pack);
      const limite = Math.min(350, parseInt(mg?.seller_max_message_length) || 350);
      await tratar({ canal: 'Mensagem pós-venda do Mercado Livre', rotulo: 'mensagem pós-venda no Mercado Livre', ref, envio, pergunta: ultTexto, produto: pedido ? (pedido.split('\n')[1] || '').replace(/^Itens: /, '') : null,
        dados: pedido || 'Pedido: sem informação', conversa, limite,
        enviar: texto => mcpCall(apiKey, 'ml_messages_send', { meliUserId: conta, pack_id: pack, buyer_id: buyer, text: texto }) });
    }
  } else if (mkt === 'magalu') {
    const lc = await mcpCall(apiKey, 'magalu_list_conversations', { magalu_account_id: conta, status: 'OPENED', _limit: 30 }).catch(() => null);
    for (const c of (lc?.results || lc?.data?.results || [])) {
      if (!tempo()) break;
      if (c.last_message?.user?.type === 'SELLER') continue; // a loja já respondeu por último
      const mm = await mcpCall(apiKey, 'magalu_conversation_messages', { magalu_account_id: conta, conversation_id: c.id, _limit: 15 }).catch(() => null);
      const msgs = (mm?.results || mm?.data?.results || []).slice().sort((a, b) => String(a.when_at).localeCompare(String(b.when_at)));
      const ult = [...msgs].reverse().find(m => m.content !== 'PRODUCT_MESSAGE');
      if (!ult || ult.from_user?.type !== 'CUSTOMER') continue;
      const ref = `magalu:${c.id}:${ult.id}`; if (vistos.has(ref)) continue;
      const prod = [...msgs].reverse().map(m => (m.custom_fields || []).find(f => f.name === 'productTitle')?.value).find(Boolean) || null;
      const conversa = msgs.filter(m => m.content !== 'PRODUCT_MESSAGE').slice(-10).map(m => `${m.from_user?.type === 'CUSTOMER' ? 'Comprador' : 'Loja'}: ${corta(m.content, 600)}${m.attachments?.length ? ' [enviou anexo/foto]' : ''}`).join('\n');
      await tratar({ canal: 'Conversa com comprador na Magalu', rotulo: 'conversa na Magalu', ref, envio: { tipo: 'magalu', conversation_id: c.id }, pergunta: ult.content, produto: prod,
        dados: prod ? `Produto da conversa: ${prod}` : null, conversa, limite: 1000,
        enviar: texto => mcpCall(apiKey, 'magalu_send_conversation_message', { magalu_account_id: conta, conversation_id: c.id, content: texto }) });
    }
  }
  return res;
}

// Envio manual (o cliente responde no portal o que ficou pendente)
async function enviarManual(mcpCall, apiKey, conta, envio, texto) {
  if (envio?.tipo === 'ml_pergunta') return mcpCall(apiKey, 'ml_answer_question', { meliUserId: conta, question_id: envio.question_id, text: texto });
  if (envio?.tipo === 'ml_mensagem') return mcpCall(apiKey, 'ml_messages_send', { meliUserId: conta, pack_id: envio.pack_id, buyer_id: envio.buyer_id, text: texto });
  if (envio?.tipo === 'magalu') return mcpCall(apiKey, 'magalu_send_conversation_message', { magalu_account_id: conta, conversation_id: envio.conversation_id, content: texto });
  throw new Error('Canal sem envio');
}

module.exports = { contasLiberadas, atenderConta, enviarManual, gerar, SISTEMA };
