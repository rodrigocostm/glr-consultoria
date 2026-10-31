// ============================================================
// GLR Consultoria — Chat central com os agentes (tela "Chat")
// ------------------------------------------------------------
// Uma conversa só para a carteira inteira: o modelo enxerga o que todos os
// agentes sabem (plano do Gerente com meta, funil e raio-x; vendas, produtos,
// curva ABC e ADS da base; estoque e margem; campanhas ao vivo da Shopee e do
// ML; o que os agentes fizeram e o que está na Caixa de decisões) e ajuda o
// analista a decidir rápido. Só LÊ — mudança vira sugestão na Caixa de
// decisões (propor_acao), que o analista aprova. Promoção e ADS do ML nunca
// são aplicados por aqui (ML não libera escrita; promoção é sempre manual).
// Conversas por usuário em glr_sync_estado (marketplace 'sistema', recurso
// 'chat', conta_id 'chat:<usuário>:<conversa>').
// ============================================================
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;
const { base } = require('./agente-chat');
const { sbSelect, sbTodos, mcpCall, usuarioLogado, lerStorage, nomesDasLojas, hojeBRT, MKT, NOME_MKT, r2 } = base;

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MODELO = 'claude-sonnet-5-5';
const ORCAMENTO_MS = 230000; // folga dentro do maxDuration (300s) do vercel.json
const MAX_RODADAS = 12;
const LIMITE_RESULTADO = 16000;

async function sbEscrever(method, table, qs, body, prefer) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${qs ? `?${qs}` : ''}`, {
    method, headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: prefer || 'return=minimal' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}
const sbUpsert = (table, rows, conflito) => sbEscrever('POST', table, `on_conflict=${conflito}`, rows, 'resolution=merge-duplicates,return=minimal');

const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const corta = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ── Carteira: clientes com conta vinculada e as lojas de cada um ──
async function carregarCarteira() {
  const [clientes, vinc, gestores, nomes] = await Promise.all([lerStorage('glr_clientes'), lerStorage('glr_mc_vinculos'), lerStorage('glr_gestores'), nomesDasLojas()]);
  const gNome = id => ((Array.isArray(gestores) ? gestores : []).find(g => String(g.id) === String(id)) || {}).nome || '';
  return (Array.isArray(clientes) ? clientes : []).map(c => {
    const lojas = ((vinc || {})[String(c.id)] || []).map(ct => ({ marketplace: MKT(ct.marketplace), conta_id: String(ct.param_to_use?.shopId || ct.param_to_use?.meliUserId || ct.external_id), nome: nomes[String(ct.external_id)] || ct.nickname || String(ct.external_id) })).filter(l => l.marketplace);
    return { id: String(c.id), nome: c.nome, gestor: gNome(c.gestorId), lojas };
  }).filter(c => c.lojas.length);
}
function acharCliente(carteira, ref) {
  if (ref == null || ref === '') throw new Error('Informe o cliente (nome ou id).');
  const r = String(ref), n = norm(r);
  const c = carteira.find(x => x.id === r) || carteira.find(x => norm(x.nome) === n) || carteira.find(x => norm(x.nome).includes(n)) || carteira.find(x => n.includes(norm(x.nome)));
  if (!c) throw new Error(`Cliente "${r}" não encontrado. Clientes: ${carteira.map(x => x.nome).join(', ')}`);
  return c;
}
const ctxDo = c => ({ lojas: c.lojas, cliente: c.nome });
const todasLojas = S => S.carteira.flatMap(c => c.lojas.map(l => ({ ...l, cliente: c.nome })));

// ── Ferramentas ──────────────────────────────────────────────
async function planoDe(cid) {
  return (await sbSelect('glr_sync_estado', `marketplace=eq.sistema&recurso=eq.plano&conta_id=eq.${encodeURIComponent(`cliente:${cid}`)}&select=cursor`).catch(() => []))[0]?.cursor || null;
}

async function carteira(S) {
  const planos = await sbSelect('glr_sync_estado', 'marketplace=eq.sistema&recurso=eq.plano&select=cursor').catch(() => []);
  const porCli = Object.fromEntries(planos.map(p => p.cursor).filter(p => p?.cliente).map(p => [String(p.cliente.id), p]));
  const pend = await sbSelect('glr_agente_log', `tipo=eq.alerta&resultado=eq.so_alerta&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 10 * 864e5).toISOString())}&select=conta_id&limit=5000`).catch(() => []);
  const nPend = {}; for (const l of pend) nPend[l.conta_id] = (nPend[l.conta_id] || 0) + 1;
  return {
    clientes: S.carteira.map(c => {
      const p = porCli[c.id], m = p?.metricas || {}, rx = p?.raioX;
      return { cliente: c.nome, id: c.id, gestor: c.gestor, lojas: c.lojas.map(l => `${l.nome} (${NOME_MKT[l.marketplace]}, conta ${l.conta_id})`), semaforo: p?.semaforo || null,
        faturamento_mes: m.faturamento ?? null, projecao_mes: m.projecao ?? null, meta: m.meta ?? null, pct_meta: m.pctMeta ?? null, tacos_mes: m.tacos ?? null, teto_tacos: m.tetoTacos || m.metaTacos || null, var_mes_passado_pct: m.varMes ?? null,
        semana_agora: rx?.semanaAgora ?? null, semana_antes: rx?.semanaAntes ?? null, var_semana_pct: rx?.var ?? null, maior_queda: rx?.caiu?.[0] ? `${rx.caiu[0].nome} (−R$ ${rx.caiu[0].perdaSem}/sem)` : null,
        decisoes_pendentes: c.lojas.reduce((s, l) => s + (nPend[l.conta_id] || 0), 0) };
    }).sort((a, b) => (b.projecao_mes || 0) - (a.projecao_mes || 0)),
    regra: 'Números do plano do Gerente (gerado todo dia às 08:00): mês até ontem, projeção pelo ritmo, TACOS = ADS ÷ faturamento total. semana_* = média semanal das últimas 2 semanas × 2 anteriores.',
  };
}

async function planoCliente(S, { cliente }) {
  const c = acharCliente(S.carteira, cliente);
  const p = await planoDe(c.id);
  if (!p) return { cliente: c.nome, lojas: c.lojas, aviso: 'Ainda não há plano do Gerente para este cliente. Use vendas/produtos/ads para analisar.' };
  const status = (await lerStorage('glr_plano_status')) || {};
  return { cliente: c.nome, gestor: c.gestor, lojas: c.lojas, gerado_em: p.em ? new Date(p.em).toISOString() : null, semaforo: p.semaforo, diagnostico: p.diagnostico, metricas: p.metricas,
    caminho_para_meta: p.caminho, raio_x: p.raioX, acoes_abertas: (p.acoes || []).filter(a => !status[a.id]).map(a => ({ quando: a.quando, quem: a.quem, titulo: a.titulo, porque: a.porque, impacto: a.impacto, loja: a.loja })),
    resultados_7_dias: p.resultados };
}

const periodo = i => ({ ...i, escopo: 'cliente' });
async function vendas(S, i) { return base.vendasBase(ctxDo(acharCliente(S.carteira, i.cliente)), periodo(i)); }
async function produtos(S, i) { return base.produtosBase(ctxDo(acharCliente(S.carteira, i.cliente)), periodo(i)); }
async function curvaAbc(S, i) { return base.curvaAbcSemanal(ctxDo(acharCliente(S.carteira, i.cliente)), periodo(i)); }
async function ads(S, i) { return base.adsBase(ctxDo(acharCliente(S.carteira, i.cliente)), periodo(i)); }

async function estoqueMargem(S, { cliente, limite }) {
  const c = acharCliente(S.carteira, cliente);
  const est = await sbSelect('glr_sync_estado', `recurso=eq.sinais&conta_id=in.(${c.lojas.map(l => l.conta_id).join(',')})&select=marketplace,conta_id,cursor`).catch(() => []);
  const lim = Math.min(Math.max(parseInt(limite) || 25, 5), 60), out = [];
  for (const e of est) {
    const loja = c.lojas.find(l => l.conta_id === String(e.conta_id) && l.marketplace === e.marketplace); if (!loja) continue;
    for (const [id, x] of Object.entries(e.cursor?.itens || {})) out.push({ loja: `${loja.nome} (${NOME_MKT[loja.marketplace]})`, conta_id: loja.conta_id, item_id: id, produto: corta(x.n, 70), preco: x.p ?? null, custo: x.c ?? null, margem_pct: x.m ?? null, acos_limite_margem_pct: x.aa ?? null,
      vendas_dia: x.vd ?? null, estoque: x.e ?? null, dias_de_estoque: x.d == null ? null : Math.round(x.d), estoque_nivel: x.ne || null, status: x.st || null });
  }
  out.sort((a, b) => (b.vendas_dia || 0) * (b.preco || 0) - (a.vendas_dia || 0) * (a.preco || 0));
  return { cliente: c.nome, produtos: out.slice(0, lim), sem_custo: out.filter(x => !(x.custo > 0)).length,
    regra: 'Agente de Estoque e Margem (a cada 3 h). margem_pct já desconta tarifa, frete, custo e imposto; acos_limite_margem_pct = ACOS máximo que a margem aguenta. Sem custo cadastrado (em Produtos) não há margem.' };
}

async function campanhasShopee(S, { conta_id, inicio, fim, filtro }) {
  const loja = todasLojas(S).find(l => l.conta_id === String(conta_id) && l.marketplace === 'shopee');
  if (!loja) throw new Error(`Loja Shopee ${conta_id} não está na carteira.`);
  return { loja: loja.nome, cliente: loja.cliente, ...(await base.campanhas({ mcKey: S.mcKey, shopId: loja.conta_id }, { inicio, fim, filtro })) };
}

async function campanhasML(S, { conta_id, inicio, fim }) {
  const loja = todasLojas(S).find(l => l.conta_id === String(conta_id) && l.marketplace === 'ml');
  if (!loja) throw new Error(`Conta do Mercado Livre ${conta_id} não está na carteira.`);
  const todas = [];
  for (let offset = 0; offset < 300; offset += 50) {
    const r = await mcpCall(S.mcKey, 'ml_ads_campaigns', { meliUserId: loja.conta_id, date_from: inicio, date_to: fim, limit: 50, offset, status: 'ALL' });
    const d = r.data || r, res = d.results || [];
    todas.push(...res);
    if (res.length < 50) break;
  }
  const linhas = todas.filter(x => ['active', 'paused'].includes(String(x.status || '').toLowerCase())).map(x => {
    const m = x.metrics || {}, g = parseFloat(m.cost) || 0, v = parseFloat(m.total_amount) || 0;
    return { id: x.id, nome: corta(x.name, 60), status: x.status, estrategia: x.strategy || null, orcamento_dia: parseFloat(x.budget) || 0, roas_objetivo: x.roas_target ?? null, acos_objetivo: x.acos_target ?? null, gasto: r2(g), vendas: r2(v), acos_pct: v > 0 ? r2(g / v * 100) : null, unidades: parseInt(m.units_quantity) || 0 };
  }).sort((a, b) => b.gasto - a.gasto);
  return { loja: loja.nome, cliente: loja.cliente, periodo: { inicio, fim }, campanhas: linhas.slice(0, 50), aviso: 'O Mercado Livre não libera escrita de Product Ads para integrações: mudanças no ADS do ML são aplicadas pelo analista no painel do Mercado Ads.' };
}

async function decisoesPendentes(S, { cliente }) {
  const lojas = cliente ? acharCliente(S.carteira, cliente).lojas : S.carteira.flatMap(c => c.lojas);
  const ids = [...new Set(lojas.map(l => l.conta_id))];
  const rows = await sbTodos('glr_agente_log', `tipo=eq.alerta&resultado=eq.so_alerta&conta_id=in.(${ids.join(',')})&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 10 * 864e5).toISOString())}&order=criado_em.desc&select=conta_id,cliente_nome,criado_em,titulo,explicacao,dados`, 3000).catch(() => []);
  return { total: rows.length, decisoes: rows.slice(0, 60).map(l => ({ cliente: l.cliente_nome, conta_id: l.conta_id, quando: l.criado_em, titulo: l.titulo, explicacao: corta(l.explicacao, 280), impacto: l.dados?.impacto ?? null, tipo_impacto: l.dados?.impacto_tipo || null })) };
}

async function historicoAgentes(S, { cliente, dias, tipo }) {
  const c = acharCliente(S.carteira, cliente);
  const n = Math.min(Math.max(parseInt(dias) || 14, 1), 60);
  let qs = `conta_id=in.(${c.lojas.map(l => l.conta_id).join(',')})&criado_em=gte.${encodeURIComponent(new Date(Date.now() - n * 864e5).toISOString())}&order=criado_em.desc&limit=120&select=conta_id,criado_em,tipo,resultado,origem,titulo,explicacao,dados`;
  if (['decisao', 'alerta', 'sistema'].includes(tipo)) qs += `&tipo=eq.${tipo}`;
  const rows = await sbSelect('glr_agente_log', qs).catch(() => []);
  return { cliente: c.nome, registros: rows.map(r => ({ quando: r.criado_em, loja: c.lojas.find(l => l.conta_id === r.conta_id)?.nome || r.conta_id, tipo: r.tipo, resultado: r.resultado, titulo: r.titulo, explicacao: corta(r.explicacao, 260), medicao: r.dados?.medicao?.veredito || null })) };
}

// Única ferramenta que grava: uma sugestão na Caixa de decisões, para o analista aprovar.
// Shopee com campaign_id + valor vira "Aprovar com 1 clique"; o resto é informativa.
async function proporAcao(S, i) {
  const loja = todasLojas(S).find(l => l.conta_id === String(i.conta_id));
  if (!loja) throw new Error(`Loja ${i.conta_id} não está na carteira — use o conta_id que aparece nas ferramentas.`);
  if (S.criadas >= 20) throw new Error('Limite de 20 sugestões por resposta — peça o resto na próxima mensagem.');
  const titulo = corta(i.titulo, 120), explicacao = corta(i.explicacao, 900);
  if (!titulo || !explicacao) throw new Error('titulo e explicacao são obrigatórios.');
  const dados = { via: 'chat', marketplace: loja.marketplace };
  if (i.impacto != null) { dados.impacto = Math.max(0, Math.round(+i.impacto)); dados.impacto_tipo = i.tipo_impacto === 'economia' ? 'economia' : 'ganho'; }
  if (loja.marketplace === 'shopee' && i.campaign_id != null && i.acao && i.acao !== 'informativa') {
    const cid = Number(i.campaign_id); if (!Number.isFinite(cid)) throw new Error('campaign_id inválido.');
    if (i.acao === 'roas') { if (!(i.valor_sugerido >= 1 && i.valor_sugerido <= 50)) throw new Error('Meta de ROAS da Shopee vai de 1 a 50.'); Object.assign(dados, { campaign_id: cid, roas_atual: i.valor_atual ?? null, roas_sugerido: Math.round(i.valor_sugerido * 10) / 10 }); }
    else if (i.acao === 'orcamento') { if (!(i.valor_sugerido > 0)) throw new Error('Orçamento sugerido precisa ser maior que zero.'); Object.assign(dados, { campaign_id: cid, budget_atual: i.valor_atual ?? null, budget_sugerido: Math.round(i.valor_sugerido * 100) / 100 }); }
    else if (i.acao === 'pausar') Object.assign(dados, { campaign_id: cid, pausar: true });
    else if (i.acao === 'retomar') Object.assign(dados, { campaign_id: cid, retomar: true, ...(i.valor_sugerido ? { roas_atual: i.valor_atual ?? null, roas_sugerido: i.valor_sugerido } : {}) });
  }
  await sbEscrever('POST', 'glr_agente_log', '', [{ conta_id: loja.conta_id, cliente_nome: loja.cliente, tipo: 'alerta', titulo: `Sugestão: ${titulo}`, explicacao: `${explicacao} (proposta no Chat por ${S.usuario})`, dados, resultado: 'so_alerta', origem: 'analista' }]);
  S.criadas++;
  return { ok: true, criada: titulo, onde: 'Caixa de decisões', aprovar_com_1_clique: dados.campaign_id != null };
}

const CLI = { type: 'string', description: 'Nome ou id do cliente (como aparece na carteira)' };
const DATA = { type: 'string', description: 'AAAA-MM-DD' };
const FERRAMENTAS = [
  { name: 'carteira', description: 'Visão da carteira inteira: cada cliente com gestor, lojas (com conta_id), semáforo, faturamento e projeção do mês, meta e % da meta, TACOS e teto, variação contra o mês passado e semana a semana, maior queda e quantas decisões esperam na Caixa. Comece por aqui para perguntas sobre vários clientes ("quem tem mais potencial", "quem está pior").', input_schema: { type: 'object', properties: {} } },
  { name: 'plano_cliente', description: 'Plano do Gerente de um cliente (todo dia às 08:00): lojas com conta_id, diagnóstico, métricas do mês, caminho para a meta com alavancas e valores, raio-x das últimas 2 semanas (o que caiu e subiu e por quê, funil de visitas × conversão × preço, oportunidades do funil) e as ações abertas. Primeira escolha para entender um cliente.', input_schema: { type: 'object', properties: { cliente: CLI }, required: ['cliente'] } },
  { name: 'vendas', description: 'INSTANTÂNEO. Faturamento válido, pedidos, ticket e cancelado de TODAS as lojas do cliente num período, com série por dia/semana/mês e quebra por loja.', input_schema: { type: 'object', properties: { cliente: CLI, inicio: DATA, fim: DATA, agrupar: { type: 'string', enum: ['dia', 'semana', 'mes'] } }, required: ['cliente', 'inicio', 'fim'] } },
  { name: 'produtos', description: 'Produtos do cliente num período (até 62 dias) contra o período anterior do mesmo tamanho: mais vendidos com curva, maiores quedas e maiores altas.', input_schema: { type: 'object', properties: { cliente: CLI, inicio: DATA, fim: DATA, limite: { type: 'integer' } }, required: ['cliente', 'inicio', 'fim'] } },
  { name: 'curva_abc', description: 'Curva ABC semana a semana (8 semanas) do cliente com tendência de cada produto. filtro: atencao (A caindo e B/C subindo), queda, alta, A, B, C, todos.', input_schema: { type: 'object', properties: { cliente: CLI, filtro: { type: 'string', enum: ['atencao', 'queda', 'alta', 'A', 'B', 'C', 'todos'] }, limite: { type: 'integer' } }, required: ['cliente'] } },
  { name: 'ads', description: 'INSTANTÂNEO. ADS do cliente num período: gasto, GMV de ADS, ACOS, ROAS, TACOS por loja e série.', input_schema: { type: 'object', properties: { cliente: CLI, inicio: DATA, fim: DATA, agrupar: { type: 'string', enum: ['dia', 'semana', 'mes'] } }, required: ['cliente', 'inicio', 'fim'] } },
  { name: 'estoque_margem', description: 'Produtos do cliente com preço, custo, margem, ACOS que a margem aguenta, vendas/dia, estoque e dias de estoque (agente de Estoque e Margem). Use antes de sugerir acelerar (não acelerar produto acabando ou sem margem).', input_schema: { type: 'object', properties: { cliente: CLI, limite: { type: 'integer' } }, required: ['cliente'] } },
  { name: 'campanhas_shopee', description: 'LENTO (API ao vivo). Campanhas de ADS de uma loja Shopee com status, orçamento, meta de ROAS e métricas no período (máx. 30 dias). Necessário para propor ajuste com campaign_id e valor atual.', input_schema: { type: 'object', properties: { conta_id: { type: 'string', description: 'shopId da loja Shopee' }, inicio: DATA, fim: DATA, filtro: { type: 'string', enum: ['todas', 'ativas', 'pausadas'] } }, required: ['conta_id', 'inicio', 'fim'] } },
  { name: 'campanhas_ml', description: 'LENTO (API ao vivo). Campanhas de Product Ads de uma conta do Mercado Livre com estratégia, orçamento, ROAS/ACOS objetivo e métricas no período. Só leitura: o ML não libera escrita de ADS para integrações.', input_schema: { type: 'object', properties: { conta_id: { type: 'string', description: 'meliUserId da conta' }, inicio: DATA, fim: DATA }, required: ['conta_id', 'inicio', 'fim'] } },
  { name: 'decisoes_pendentes', description: 'O que está esperando aprovação na Caixa de decisões (últimos 10 dias), de um cliente ou da carteira inteira.', input_schema: { type: 'object', properties: { cliente: CLI } } },
  { name: 'historico_agentes', description: 'O que os agentes e o analista fizeram nas lojas do cliente (decisões, alertas, revisões), com o resultado medido quando houver.', input_schema: { type: 'object', properties: { cliente: CLI, dias: { type: 'integer' }, tipo: { type: 'string', enum: ['todos', 'decisao', 'alerta', 'sistema'] } }, required: ['cliente'] } },
  { name: 'propor_acao', description: 'Cria UMA sugestão na Caixa de decisões para o analista aprovar (nada é aplicado agora). Use só quando o analista pedir para preparar/criar/aplicar ações. Shopee: com campaign_id + acao (roas|orcamento|pausar|retomar) + valor_atual/valor_sugerido vira "aprovar com 1 clique" — pegue os valores atuais em campanhas_shopee. Mercado Livre e qualquer outra coisa (preço, estoque, anúncio, promoção): acao "informativa" com o passo a passo na explicacao. Até 20 por resposta.', input_schema: { type: 'object', properties: {
    conta_id: { type: 'string', description: 'conta da loja (shopId ou meliUserId)' }, titulo: { type: 'string', description: 'curto, ex.: "Baixar meta de ROI — Nome da campanha"' }, explicacao: { type: 'string', description: 'motivo com os números + o que fazer' },
    acao: { type: 'string', enum: ['roas', 'orcamento', 'pausar', 'retomar', 'informativa'] }, campaign_id: { type: 'string' }, valor_atual: { type: 'number' }, valor_sugerido: { type: 'number' },
    impacto: { type: 'number', description: 'R$ por semana estimado' }, tipo_impacto: { type: 'string', enum: ['ganho', 'economia'] } }, required: ['conta_id', 'titulo', 'explicacao'] } },
];
const EXEC = { carteira, plano_cliente: planoCliente, vendas, produtos, curva_abc: curvaAbc, ads, estoque_margem: estoqueMargem, campanhas_shopee: campanhasShopee, campanhas_ml: campanhasML, decisoes_pendentes: decisoesPendentes, historico_agentes: historicoAgentes, propor_acao: proporAcao };
const ROTULO = { carteira: 'carteira', plano_cliente: 'plano do Gerente', vendas: 'vendas', produtos: 'produtos', curva_abc: 'curva ABC', ads: 'ADS', estoque_margem: 'estoque e margem', campanhas_shopee: 'campanhas Shopee', campanhas_ml: 'campanhas ML', decisoes_pendentes: 'Caixa de decisões', historico_agentes: 'histórico dos agentes', propor_acao: 'sugestão criada' };
const dm = iso => `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}`;
const resumo = (n, i) => `${ROTULO[n] || n}${i?.cliente ? ` · ${i.cliente}` : ''}${i?.inicio && i?.fim ? ` · ${dm(i.inicio)} a ${dm(i.fim)}` : ''}${n === 'propor_acao' && i?.titulo ? ` · ${corta(i.titulo, 50)}` : ''}`;

function sistema(S, foco) {
  return `Você é o copiloto da GLR Consultoria, uma consultoria que opera contas de clientes no Mercado Livre e na Shopee. Conversa com os analistas da GLR, em português do Brasil, direto e prático, como um analista sênior que entende o cenário completo da conta: faturamento, meta, visitas, conversão, preço, margem, estoque, ADS, reputação.
Hoje é ${hojeBRT()} (horário de Brasília). ${foco ? `Cliente em foco na tela: ${foco.nome} (id ${foco.id}) — se a pergunta não disser outro, é sobre ele.` : 'Sem cliente em foco: a pergunta pode ser sobre a carteira inteira.'}
Clientes da carteira: ${S.carteira.map(c => c.nome).join(', ')}.

O TIME DE AGENTES (o que já roda sozinho):
- Gerente de Conta (08:00): plano por cliente com meta, caminho até a meta, raio-x e funil (plano_cliente).
- ADS Shopee (07:00 + acompanhamentos): ajusta meta de ROAS e orçamento e pausa sozinho dentro dos limites; a revisão de 3 dias acelera o que sobe e desfaz aperto que derrubou venda. Quem governa é o TACOS da loja (teto do cliente ou meta da conta).
- ADS Mercado Livre: só copiloto — o ML não libera escrita de Product Ads para integrações; o analista aplica no painel do Mercado Ads.
- Estoque e Margem, Promoções (sempre com aprovação manual, pelo custo e lucro), Reputação, Qualidade dos anúncios.
- Autonomia: cada cliente tem contrato (Crescer/Equilíbrio/Lucrar) e níveis Executar/Só sugerir; promoção nunca é automática.

COMO TRABALHAR:
- Busque os números com as ferramentas antes de responder; nunca invente número, produto, campanha ou id. As ferramentas da base são instantâneas; as de campanha ao vivo levam segundos — use só quando precisar.
- Para crescer uma conta, pense no funil: faturamento = visitas × conversão × preço médio. Diga qual alavanca está travando e o que fazer (ADS/exposição, preço/frete/fotos/avaliações, estoque, promoção dentro da margem, produtos novos).
- Antes de sugerir acelerar ADS, confira o TACOS da loja contra o teto, o ACOS contra a meta e a margem do produto, e o estoque.
- Responda com a conclusão primeiro, depois os números que a sustentam (com os períodos), e termine com "Próximos passos" numerados e concretos. Use tabelas em markdown quando comparar vários itens. Sem enrolação.
- Quando o analista pedir para preparar, criar ou aplicar ações, use propor_acao (uma por ação) — vão para a Caixa de decisões para aprovação; diga quantas criou. Sem esse pedido, só ofereça criar.
- Nunca diga que aplicou algo: você só lê e cria sugestões. Promoção e ADS do ML ficam sempre para o analista aprovar/aplicar.`;
}

// ── Conversas (por usuário) ──────────────────────────────────
const chaveConv = (uid, id) => `chat:${uid}:${id}`;
async function lerConversa(uid, id) {
  return (await sbSelect('glr_sync_estado', `marketplace=eq.sistema&recurso=eq.chat&conta_id=eq.${encodeURIComponent(chaveConv(uid, id))}&select=cursor`).catch(() => []))[0]?.cursor || null;
}
async function salvarConversa(uid, id, conv) {
  const agora = new Date().toISOString();
  await sbUpsert('glr_sync_estado', [{ marketplace: 'sistema', conta_id: chaveConv(uid, id), recurso: 'chat', cursor: conv, ultima_tentativa: agora, ultimo_sucesso: agora, registros: conv.msgs.length }], 'marketplace,conta_id,recurso');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const mcKey = process.env.MCP_API_KEY;
  if (!process.env.ANTHROPIC_API_KEY || !mcKey || !SUPABASE_KEY) return res.status(500).json({ error: 'Chaves do servidor não configuradas.' });
  const usuario = await usuarioLogado(req).catch(() => null);
  if (!usuario) return res.status(401).json({ error: 'Sessão expirada — entre de novo no sistema.' });
  const uid = usuario.id, { acao, conversa_id, mensagem, cliente_id } = req.body || {};
  const idOk = v => /^[a-z0-9]{6,40}$/i.test(String(v || ''));

  try {
    if (acao === 'listar') {
      const rows = await sbSelect('glr_sync_estado', `marketplace=eq.sistema&recurso=eq.chat&conta_id=like.${encodeURIComponent(`chat:${uid}:*`)}&select=conta_id,ultimo_sucesso,titulo:cursor->>titulo,cliente:cursor->>cliente_nome&order=ultimo_sucesso.desc&limit=60`).catch(() => []);
      return res.status(200).json({ conversas: rows.map(r => ({ id: r.conta_id.split(':').pop(), titulo: r.titulo || 'Conversa', cliente: r.cliente || null, em: r.ultimo_sucesso })) });
    }
    if (acao === 'abrir') {
      const conv = idOk(conversa_id) ? await lerConversa(uid, String(conversa_id)) : null;
      return conv ? res.status(200).json({ conversa: conv }) : res.status(404).json({ error: 'Conversa não encontrada.' });
    }
    if (acao === 'apagar') {
      if (!idOk(conversa_id)) return res.status(400).json({ error: 'Conversa inválida.' });
      await sbEscrever('DELETE', 'glr_sync_estado', `marketplace=eq.sistema&recurso=eq.chat&conta_id=eq.${encodeURIComponent(chaveConv(uid, String(conversa_id)))}`);
      return res.status(200).json({ ok: true });
    }

    // enviar
    const texto = String(mensagem || '').trim().slice(0, 6000);
    if (!texto) return res.status(400).json({ error: 'Mensagem vazia.' });
    const id = idOk(conversa_id) ? String(conversa_id) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const conv = (await lerConversa(uid, id)) || { titulo: corta(texto, 60), criado: new Date().toISOString(), msgs: [] };
    const S = { carteira: await carregarCarteira(), mcKey, usuario: usuario.email || uid, criadas: 0 };
    const foco = cliente_id ? S.carteira.find(c => c.id === String(cliente_id)) || null : null;
    if (foco) { conv.cliente_id = foco.id; conv.cliente_nome = foco.nome; }

    const mensagens = conv.msgs.slice(-20).map(m => ({ role: m.r, content: m.t })).filter(m => m.content);
    while (mensagens.length && mensagens[0].role !== 'user') mensagens.shift();
    mensagens.push({ role: 'user', content: texto });

    const client = new Anthropic();
    const usadas = [], inicio = Date.now();
    let resposta = null;
    for (let rodada = 0; rodada < MAX_RODADAS + 1; rodada++) {
      const semTempo = Date.now() - inicio > ORCAMENTO_MS || rodada >= MAX_RODADAS;
      resposta = await client.beta.messages.create({
        model: MODELO, max_tokens: 16000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'medium' },
        system: sistema(S, foco), tools: FERRAMENTAS, tool_choice: semTempo ? { type: 'none' } : { type: 'auto' }, messages: mensagens,
      });
      if (resposta.stop_reason === 'pause_turn') { mensagens.push({ role: 'assistant', content: resposta.content }); continue; }
      if (resposta.stop_reason !== 'tool_use') break;
      mensagens.push({ role: 'assistant', content: resposta.content });
      const resultados = [];
      // em sequência: o conector corrompe respostas simultâneas
      for (const b of resposta.content.filter(x => x.type === 'tool_use')) {
        try {
          if (!EXEC[b.name]) throw new Error(`Ferramenta desconhecida: ${b.name}`);
          if (Date.now() - inicio > ORCAMENTO_MS) throw new Error('Tempo de consulta esgotado — responda com o que já tem.');
          let t = JSON.stringify(await EXEC[b.name](S, b.input || {}));
          if (t.length > LIMITE_RESULTADO) t = t.slice(0, LIMITE_RESULTADO) + '… [cortado por tamanho — refine a consulta]';
          resultados.push({ type: 'tool_result', tool_use_id: b.id, content: t });
          usadas.push({ f: b.name, r: resumo(b.name, b.input) });
        } catch (e) {
          resultados.push({ type: 'tool_result', tool_use_id: b.id, content: `Erro: ${e.message || e}`, is_error: true });
          usadas.push({ f: b.name, r: resumo(b.name, b.input), erro: true });
        }
      }
      mensagens.push({ role: 'user', content: resultados });
    }
    const final = resposta.stop_reason === 'refusal' ? 'Não consegui responder a essa pergunta. Tente reformular.'
      : resposta.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || 'Sem resposta.';

    conv.msgs.push({ r: 'user', t: texto, em: new Date(inicio).toISOString() }, { r: 'assistant', t: final, em: new Date().toISOString(), ferramentas: usadas, criadas: S.criadas });
    if (conv.msgs.length > 80) conv.msgs = conv.msgs.slice(-80);
    await salvarConversa(uid, id, conv).catch(() => {});
    return res.status(200).json({ conversa_id: id, titulo: conv.titulo, resposta: final, ferramentas: usadas, criadas: S.criadas, cortada: resposta.stop_reason === 'max_tokens', segundos: Math.round((Date.now() - inicio) / 1000) });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'Muitas perguntas ao mesmo tempo — espere alguns segundos e tente de novo.' });
    if (e instanceof Anthropic.APIError && /credit balance is too low/i.test(e.message)) return res.status(402).json({ error: 'Os créditos da API da Anthropic acabaram — recarregue em console.anthropic.com → Plans & Billing e o chat volta na hora.' });
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: `Falha no modelo (${e.status}): ${e.message}` });
    return res.status(500).json({ error: e.message || String(e) });
  }
};
