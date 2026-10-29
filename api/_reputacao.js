// ============================================================
// GLR Consultoria — Agente de Reputação e Atendimento
// ------------------------------------------------------------
// Roda no sincronizador (a cada 30 min por loja; métricas da conta a cada 6 h)
// e grava em glr_sync_estado, recurso 'reputacao':
//  • Mercado Livre: perguntas sem resposta (com RASCUNHO de resposta feito por
//    IA só com os dados do anúncio — o analista revisa e envia), reclamações
//    abertas (com prazo de ação obrigatória e o produto, pelo pedido), mensagens
//    pós-venda não lidas e a reputação (nível, reclamações, atrasos, cancelamentos).
//  • Shopee: saúde da loja (métricas × meta da Shopee) e devoluções dos últimos
//    30 dias por produto (as que pedem resposta da loja ficam em destaque).
// Colaboração: conta com reputação em risco → os agentes de ADS não aceleram
// a conta; produto com reclamações/devoluções repetidas → ADS não acelera nem
// coloca no ADS (vende mais um produto que está gerando reclamação).
// Não guarda nome, e-mail ou foto de comprador — só motivo, produto e prazos.
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;

const METRICAS_A_CADA_MS = 6 * 3600 * 1000;
const RASCUNHOS_POR_RODADA = 6;
const PROBLEMA_ML = 2;      // reclamações abertas no mesmo produto
const PROBLEMA_SHOPEE = 3;  // devoluções do mesmo produto em 30 dias
const NIVEL = { '5_green': ['Verde', 5], '4_light_green': ['Verde-claro', 4], '3_yellow': ['Amarelo', 3], '2_orange': ['Laranja', 2], '1_red': ['Vermelho', 1] };
const corta = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Rascunho de resposta com IA — só com os dados do anúncio; sem dado, devolve null (precisa de humano)
async function rascunhar(anthropicKey, pergunta, anuncio) {
  if (!anthropicKey || !anuncio) return null;
  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const r = await client.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 300,
      system: 'Você responde perguntas de compradores no Mercado Livre em nome de uma loja brasileira. Responda em português do Brasil, cordial e direto, em no máximo 3 frases, começando por "Olá!" e terminando com "Atenciosamente, equipe." quando couber. Use SOMENTE as informações do anúncio fornecidas (título, preço, estoque, atributos, variações e descrição). Nunca invente medida, prazo, cor, compatibilidade ou política que não esteja nos dados. Não peça nem passe contato externo, link, telefone ou e-mail (o Mercado Livre proíbe). Se a resposta não estiver nos dados, responda exatamente: PRECISA_HUMANO',
      messages: [{ role: 'user', content: `ANÚNCIO:\n${anuncio}\n\nPERGUNTA DO COMPRADOR:\n${pergunta}` }],
    });
    const txt = r.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    if (!txt || /PRECISA_HUMANO/.test(txt)) return { texto: null, motivo: 'a resposta não está no anúncio' };
    return { texto: txt.slice(0, 2000), motivo: null };
  } catch (e) { return null; }
}

async function dadosDoAnuncio(mcpCall, apiKey, conta, itemId) {
  const [it, desc] = await Promise.all([
    mcpCall(apiKey, 'get_items', { meliUserId: conta, ids: [itemId], attributes: 'id,title,price,available_quantity,attributes,variations' }).catch(() => null),
    mcpCall(apiKey, 'get_description', { meliUserId: conta, item_id: itemId }).catch(() => null),
  ]);
  const lista = it?.data?.items || it?.items || (Array.isArray(it?.data) ? it.data : []);
  const b = (lista[0]?.body || lista[0]) || null;
  if (!b?.id) return null;
  const attrs = (b.attributes || []).filter(a => a.value_name).slice(0, 40).map(a => `${a.name}: ${a.value_name}`).join('; ');
  const vars = (b.variations || []).slice(0, 15).map(v => `${(v.attribute_combinations || []).map(c => c.value_name).join('/')} (${v.available_quantity} em estoque)`).join('; ');
  const d = desc?.data?.plain_text || desc?.plain_text || '';
  return { titulo: b.title, texto: `Título: ${b.title}\nPreço: R$ ${b.price}\nEstoque: ${b.available_quantity}\nAtributos: ${attrs || '—'}\nVariações: ${vars || '—'}\nDescrição: ${corta(d, 1800) || '—'}` };
}

async function reputacaoML(ctx, conta, ant) {
  const { mcpCall, apiKey, sbSelect, anthropicKey, prazo } = ctx;
  const out = { ...ant };
  // 1) perguntas sem resposta (mais antigas primeiro) + rascunhos
  const rq = await mcpCall(apiKey, 'ml_list_questions', { meliUserId: conta, status: 'UNANSWERED', limit: 50, sort_fields: 'date_created', sort_types: 'ASC' }).catch(() => null);
  const qs = rq?.questions || rq?.data?.questions;
  if (Array.isArray(qs)) {
    const antPorId = new Map((ant?.perguntas || []).map(p => [String(p.id), p]));
    const perguntas = qs.map(q => {
      const a = antPorId.get(String(q.id));
      return { id: String(q.id), item: q.item_id, texto: corta(q.text, 500), criada: q.date_created, titulo: a?.titulo || null, rascunho: a?.rascunho || null, semResposta: a?.semResposta || null };
    });
    let feitos = 0;
    for (const p of perguntas) {
      if (feitos >= RASCUNHOS_POR_RODADA || Date.now() > prazo) break;
      if (p.rascunho || p.semResposta) continue;
      const an = await dadosDoAnuncio(mcpCall, apiKey, conta, p.item);
      if (an) p.titulo = corta(an.titulo, 90);
      const r = await rascunhar(anthropicKey, p.texto, an?.texto);
      if (r) { if (r.texto) p.rascunho = r.texto; else p.semResposta = r.motivo; feitos++; }
    }
    out.perguntas = perguntas;
    out.perguntasTotal = parseInt(rq.total ?? rq.data?.total) || perguntas.length;
  }
  // 2) mensagens pós-venda não lidas
  const mu = await mcpCall(apiKey, 'ml_messages_unread', { meliUserId: conta }).catch(() => null);
  if (mu && (mu.total != null || mu.data?.total != null)) out.mensagensNaoLidas = parseInt(mu.total ?? mu.data.total) || 0;
  // 3) reclamações abertas → produto pelo pedido
  const rc = await mcpCall(apiKey, 'ml_claims_search', { meliUserId: conta, status: 'opened', limit: 50 }).catch(() => null);
  const claims = rc?.data && Array.isArray(rc.data) ? rc.data : Array.isArray(rc?.data?.data) ? rc.data.data : null;
  if (claims) {
    const pedidos = [...new Set(claims.map(c => String(c.resource_id)).filter(Boolean))];
    const itensPed = new Map();
    for (let i = 0; i < pedidos.length; i += 40) {
      const rows = await sbSelect('glr_pedidos', `marketplace=eq.ml&conta_id=eq.${encodeURIComponent(conta)}&pedido_id=in.(${pedidos.slice(i, i + 40).join(',')})&select=pedido_id,itens`).catch(() => []);
      rows.forEach(r => itensPed.set(String(r.pedido_id), (r.itens || []).map(x => ({ id: String(x.item_id), n: x.nome }))));
    }
    out.reclamacoes = claims.map(c => {
      const vend = (c.players || []).find(p => p.role === 'respondent');
      const obrig = (vend?.available_actions || []).filter(a => a.mandatory && a.due_date).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))[0];
      const its = itensPed.get(String(c.resource_id)) || [];
      return { id: String(c.id), pedido: String(c.resource_id), etapa: c.stage, tipo: c.type, motivo: c.reason_id, criada: c.date_created, prazo: obrig?.due_date || null, acao: obrig?.action || null, item: its[0]?.id || null, produto: its[0]?.n ? corta(its[0].n, 90) : null };
    });
    out.reclamacoesTotal = parseInt(rc?.paging?.total ?? rc?.data?.paging?.total) || out.reclamacoes.length;
  }
  // 4) reputação da conta (a cada 6 h)
  if (!ant?.metricasEm || Date.now() - ant.metricasEm > METRICAS_A_CADA_MS) {
    const m = await mcpCall(apiKey, 'get_seller_metrics', { meliUserId: conta }).catch(() => null);
    const d = m?.data?.metrics ? m.data : m;
    if (d?.metrics) {
      const nv = NIVEL[d.level_id] || [d.level_id || '—', 0];
      out.reputacao = {
        nivel: nv[0], nota: nv[1], medalha: d.power_seller_status || null,
        reclamacoes: d.metrics.claims ? { taxa: d.metrics.claims.rate, n: d.metrics.claims.value } : null,
        atrasos: d.metrics.delayed_handling_time ? { taxa: d.metrics.delayed_handling_time.rate, n: d.metrics.delayed_handling_time.value } : null,
        cancelamentos: d.metrics.cancellations ? { taxa: d.metrics.cancellations.rate, n: d.metrics.cancellations.value } : null,
        vendas60: d.metrics.sales?.completed ?? null,
      };
      out.metricasEm = Date.now();
    }
  }
  // produtos com reclamação repetida e risco da conta
  const porItem = {};
  for (const c of out.reclamacoes || []) if (c.item) { const x = porItem[c.item] = porItem[c.item] || { rec: 0, produto: c.produto }; x.rec++; }
  out.itens = Object.fromEntries(Object.entries(porItem).filter(([, x]) => x.rec >= PROBLEMA_ML).map(([id, x]) => [id, { ...x, motivo: `${x.rec} reclamações abertas` }]));
  const rep = out.reputacao;
  const maisAntiga = (out.perguntas || [])[0]?.criada ? (Date.now() - new Date(out.perguntas[0].criada).getTime()) / 3600e3 : null;
  out.risco = !rep ? null : rep.nota && rep.nota <= 3 ? 'alto' : (rep.nota === 4 || (maisAntiga != null && maisAntiga > 24)) ? 'atencao' : 'ok';
  out.riscoMotivo = !rep ? null : rep.nota && rep.nota <= 4 ? `reputação ${rep.nivel.toLowerCase()}` : maisAntiga > 24 ? `pergunta sem resposta há ${maisAntiga >= 48 ? `${Math.round(maisAntiga / 24)} dias` : `${Math.round(maisAntiga)} h`}` : '';
  return out;
}

async function reputacaoShopee(ctx, conta, ant) {
  const { mcpCall, apiKey, prazo } = ctx;
  const out = { ...ant };
  if (!ant?.metricasEm || Date.now() - ant.metricasEm > METRICAS_A_CADA_MS) {
    // saúde da loja
    const r = await mcpCall(apiKey, 'shopee_get_shop_performance', { shopId: conta }).catch(() => null);
    const resp = r?.data?.response || r?.response;
    if (resp?.metric_list) {
      const ok = (v, t) => v == null || !t ? true : t.comparator === '<' ? v < t.value : t.comparator === '<=' ? v <= t.value : t.comparator === '>' ? v > t.value : v >= t.value;
      const NOMES = { late_shipment_rate: 'Envio atrasado', non_fulfillment_rate: 'Não cumprimento', response_rate: 'Taxa de resposta do chat', shop_rating: 'Avaliação da loja', cancellation_rate: 'Cancelamento', return_refund_rate: 'Devolução/reembolso', pre_order_listing_rate: 'Anúncios em pré-venda', avg_preparation_time_ps: 'Tempo de preparo (dias)', saturday_shipment_rate: 'Envio aos sábados' };
      const metricas = resp.metric_list.filter(m => NOMES[m.metric_name]).map(m => ({ nome: NOMES[m.metric_name], atual: m.current_period, anterior: m.last_period, meta: m.target ? `${m.target.comparator} ${m.target.value}` : '', unidade: m.unit === 2 ? '%' : '', ok: ok(m.current_period, m.target) }));
      out.reputacao = { notaLoja: resp.overall_performance?.rating ?? null, falhas: metricas.filter(m => !m.ok).map(m => m.nome), metricas };
    }
    // devoluções dos últimos 30 dias (a Shopee aceita janelas de até 15 dias)
    const agora = Math.floor(Date.now() / 1000), devol = [];
    for (const [de, ate] of [[agora - 15 * 86400, agora], [agora - 30 * 86400, agora - 15 * 86400]]) {
      for (let pg = 1; pg <= 4 && Date.now() < prazo; pg++) {
        const rl = await mcpCall(apiKey, 'shopee_get_return_list', { shopId: conta, page_no: pg, page_size: 50, create_time_from: de, create_time_to: ate }).catch(() => null);
        const lista = rl?.data?.response?.return || rl?.response?.return || [];
        for (const x of lista) devol.push({ id: x.return_sn, motivo: x.reason, texto: corta(x.text_reason, 160), status: x.status, negociacao: x.negotiation_status || '', prazo: x.return_seller_due_date ? new Date(x.return_seller_due_date * 1000).toISOString() : null, valor: x.refund_amount, item: String(x.item?.[0]?.item_id || ''), produto: corta(x.item?.[0]?.name, 90), criada: new Date(x.create_time * 1000).toISOString() });
        if (!(rl?.data?.response?.more || rl?.response?.more)) break;
      }
    }
    out.devolucoes = devol.sort((a, b) => b.criada.localeCompare(a.criada));
    out.metricasEm = Date.now();
  }
  const porItem = {};
  for (const d of out.devolucoes || []) if (d.item) { const x = porItem[d.item] = porItem[d.item] || { rec: 0, produto: d.produto, motivos: {} }; x.rec++; x.motivos[d.motivo] = (x.motivos[d.motivo] || 0) + 1; }
  out.itens = Object.fromEntries(Object.entries(porItem).filter(([, x]) => x.rec >= PROBLEMA_SHOPEE).map(([id, x]) => [id, { rec: x.rec, produto: x.produto, motivo: `${x.rec} devoluções em 30 dias` }]));
  out.pedemResposta = (out.devolucoes || []).filter(d => /PENDING/.test(d.negociacao) || (d.prazo && d.status === 'PROCESSING')).length;
  const rep = out.reputacao;
  // Só as métricas que penalizam a loja seguram o ADS; as operacionais (sábado,
  // tempo de preparo, pré-venda, resposta do chat) viram só atenção.
  const GRAVES = new Set(['Não cumprimento', 'Envio atrasado', 'Avaliação da loja', 'Cancelamento', 'Devolução/reembolso']);
  const graves = (rep?.falhas || []).filter(f => GRAVES.has(f)), leves = (rep?.falhas || []).filter(f => !GRAVES.has(f));
  out.risco = !rep ? null : (rep.notaLoja != null && rep.notaLoja <= 1) || graves.length ? 'alto' : leves.length ? 'atencao' : 'ok';
  out.riscoMotivo = graves.length ? `fora da meta da Shopee: ${graves.join(', ')}` : rep?.notaLoja != null && rep.notaLoja <= 1 ? 'nota geral da loja no mínimo' : leves.length ? `fora da meta (operação): ${leves.join(', ')}` : '';
  return out;
}

// ctx: { mcpCall, apiKey, sbSelect, anthropicKey, prazo }; ant: cursor anterior (rascunhos e métricas)
async function calcularReputacao(ctx, mkt, conta, ant) {
  const out = mkt === 'ml' ? await reputacaoML(ctx, conta, ant || {}) : await reputacaoShopee(ctx, conta, ant || {});
  out.em = Date.now(); out.mkt = mkt; out.conta = conta;
  out.resumo = {
    perguntas: out.perguntasTotal ?? null, rascunhos: (out.perguntas || []).filter(p => p.rascunho).length,
    perguntaMaisAntigaH: out.perguntas?.[0]?.criada ? Math.round((Date.now() - new Date(out.perguntas[0].criada).getTime()) / 3600e3) : null,
    reclamacoes: out.reclamacoesTotal ?? null, comPrazo: (out.reclamacoes || []).filter(c => c.prazo).length,
    mensagens: out.mensagensNaoLidas ?? null, devolucoes: out.devolucoes ? out.devolucoes.length : null, pedemResposta: out.pedemResposta ?? null,
    produtosProblema: Object.keys(out.itens || {}).length, risco: out.risco, riscoMotivo: out.riscoMotivo, nivel: out.reputacao?.nivel || null,
  };
  return out;
}

module.exports = { calcularReputacao };
