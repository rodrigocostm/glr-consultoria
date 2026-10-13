// ============================================================
// GLR Consultoria — Chat do Agente com ferramentas (Shopee)
// ------------------------------------------------------------
// O chat antigo (/api/chat) recebia só um retrato fixo do período da tela e
// respondia "não consigo confirmar" para qualquer coisa fora dele (ex.: "a
// conta está em queda contra o mês passado?"). Aqui o modelo tem ferramentas
// de LEITURA que buscam o que precisar na hora: faturamento de qualquer
// período, desempenho de ADS dia a dia, campanhas, histórico de relatórios,
// registro do agente e, como último recurso, qualquer ação de leitura da API
// da Shopee no conector. Nenhuma ferramenta altera nada — mudanças continuam
// virando sugestão (bloco ```json) que o analista aprova na tela.
// ============================================================
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MODELO = 'claude-opus-5-5';
const ORCAMENTO_MS = 230000; // folga dentro do maxDuration (300s) do vercel.json
const MAX_RODADAS = 10;
const LIMITE_RESULTADO = 14000; // caracteres por resultado de ferramenta

async function sbSelect(table, qs) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase select ${table} falhou: HTTP ${r.status}`);
  return r.json();
}

async function mcpCall(apiKey, action, params) {
  const r = await fetch('https://mcp.tiops.com.br', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ action, params: params || {} }),
  });
  const json = await r.json();
  if (!r.ok || (json.status && json.status !== 200) || (json.error && String(json.error).trim())) {
    throw new Error(json.error || json.message || `Erro na ação ${action}`);
  }
  return json;
}

// Só usuários logados no sistema da GLR (sessão Supabase) podem usar o chat:
// ele lê dados de vendas de clientes.
async function usuarioLogado(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}

const r2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const ehData = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const paraBR = iso => iso.split('-').reverse().join('-');
function isoDe(d) { const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; }
function hojeBRT() { return isoDe(new Date(Date.now() - 3 * 3600 * 1000)); }
function somarDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return isoDe(d); }
function diasEntre(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000) + 1; }
function brtDatetimeDe(unixSegundos) {
  const d = new Date(unixSegundos * 1000 - 3 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function validarPeriodo(inicio, fim) {
  if (!ehData(inicio) || !ehData(fim)) throw new Error('Use datas no formato AAAA-MM-DD.');
  if (inicio > fim) throw new Error('inicio não pode ser depois de fim.');
  if (fim > hojeBRT()) throw new Error(`fim não pode passar de hoje (${hojeBRT()}).`);
}

// ── Ferramentas ─────────────────────────────────────────────

// Faturamento de um status com paginação real (continuar_de) e retry: o
// conector às vezes devolve resposta "vazia" sem total_orders — isso é falha
// silenciosa, não zero. Status sempre em sequência (em paralelo o conector
// devolve dado incompleto — confirmado ao vivo).
async function somaStatus(apiKey, shopId, inicio, fim, status) {
  let total = 0, pedidos = 0, end = fim;
  for (let pagina = 0; pagina < 40; pagina++) {
    let r = null, erro = null;
    for (let t = 0; t < 3 && !r; t++) {
      try {
        const x = await mcpCall(apiKey, 'shopee_sales_summary', { shopId, start_date: inicio, end_date: end, order_status: status });
        const d = x.data || x;
        if (d.total_orders != null) r = d; else erro = new Error('resposta sem total_orders');
      } catch (e) { erro = e; }
    }
    if (!r) throw erro || new Error('falhou');
    total += parseFloat(r.total_revenue) || 0;
    pedidos += parseInt(r.total_orders) || 0;
    if (!r.parcial || !r.continuar_de) break;
    end = brtDatetimeDe(r.continuar_de);
  }
  return { total, pedidos };
}

async function faturamentoLoja(ctx, { inicio, fim }) {
  validarPeriodo(inicio, fim);
  const porStatus = {}, falhas = [];
  let total = 0, pedidos = 0;
  for (const st of ['COMPLETED', 'READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'CANCELLED']) {
    try {
      const r = await somaStatus(ctx.mcKey, ctx.shopId, inicio, fim, st);
      porStatus[st] = { faturamento: r2(r.total), pedidos: r.pedidos };
      total += r.total; pedidos += r.pedidos;
    } catch (e) { falhas.push(`${st}: ${e.message}`); }
  }
  const cancelado = porStatus.CANCELLED?.faturamento || 0;
  return {
    periodo: { inicio, fim, dias: diasEntre(inicio, fim) },
    faturamento_bruto: r2(total),
    faturamento_sem_cancelados: r2(total - cancelado),
    pedidos,
    media_por_dia: r2(total / diasEntre(inicio, fim)),
    por_status: porStatus,
    falhas,
    observacao: falhas.length ? 'ATENÇÃO: algum status falhou — o total está subestimado; diga isso ao analista.' : 'Bruto inclui cancelados (é a base usada no TACOS da GLR); use sem_cancelados para receita efetiva.',
  };
}

async function desempenhoAds(ctx, { inicio, fim }) {
  validarPeriodo(inicio, fim);
  const dias = [];
  // A API de ADS recusa janela maior que 1 mês — busca em blocos de 30 dias.
  for (let de = inicio; de <= fim; de = somarDias(de, 30)) {
    const ate = somarDias(de, 29) < fim ? somarDias(de, 29) : fim;
    const r = await mcpCall(ctx.mcKey, 'shopee_ads_daily_performance', { shopId: ctx.shopId, start_date: paraBR(de), end_date: paraBR(ate) });
    for (const d of (r.data?.response || r.response || [])) {
      dias.push({ data: d.date, gasto: r2(d.expense), gmv_ads: r2(d.broad_gmv), pedidos_ads: parseInt(d.broad_order) || 0, impressoes: parseInt(d.impression) || 0, cliques: parseInt(d.clicks) || 0 });
    }
  }
  const t = dias.reduce((s, d) => ({ gasto: s.gasto + d.gasto, gmv: s.gmv + d.gmv_ads, pedidos: s.pedidos + d.pedidos_ads, imp: s.imp + d.impressoes, cl: s.cl + d.cliques }), { gasto: 0, gmv: 0, pedidos: 0, imp: 0, cl: 0 });
  let serie = dias;
  if (dias.length > 62) { // período longo: agrega por semana pra caber
    serie = [];
    for (let i = 0; i < dias.length; i += 7) {
      const b = dias.slice(i, i + 7);
      serie.push({ semana_de: b[0].data, ate: b[b.length - 1].data, gasto: r2(b.reduce((s, d) => s + d.gasto, 0)), gmv_ads: r2(b.reduce((s, d) => s + d.gmv_ads, 0)), pedidos_ads: b.reduce((s, d) => s + d.pedidos_ads, 0) });
    }
  }
  return {
    periodo: { inicio, fim, dias: diasEntre(inicio, fim) },
    total: { gasto_ads: r2(t.gasto), vendas_atribuidas_ads_gmv: r2(t.gmv), pedidos_ads: t.pedidos, impressoes: t.imp, cliques: t.cl, acos_pct: t.gmv > 0 ? r2(t.gasto / t.gmv * 100) : null, ctr_pct: t.imp > 0 ? r2(t.cl / t.imp * 100) : null },
    serie,
    observacao: 'GMV de ADS é atribuição da Shopee (compras de qualquer produto após clique, antes de descontos) — pode passar do faturamento.',
  };
}

async function campanhas(ctx, { inicio, fim, filtro }) {
  validarPeriodo(inicio, fim);
  let de = inicio, nota = '';
  if (diasEntre(inicio, fim) > 30) { de = somarDias(fim, -29); nota = 'Métricas por campanha limitadas aos últimos 30 dias do período (limite da Shopee).'; }
  const base = await mcpCall(ctx.mcKey, 'shopee_ads_campaigns', { shopId: ctx.shopId });
  const ids = (base.data?.response?.campaign_list || base.response?.campaign_list || []).map(c => c.campaign_id);
  const settings = {};
  for (let i = 0; i < ids.length; i += 20) {
    const r = await mcpCall(ctx.mcKey, 'shopee_ads_campaign_settings', { shopId: ctx.shopId, campaign_id_list: ids.slice(i, i + 20).join(',') }).catch(() => null);
    for (const c of (r?.data?.response?.campaign_list || r?.response?.campaign_list || [])) settings[c.campaign_id] = { ...(c.common_info || {}), roas: c.auto_bidding_info?.roas_target ?? null };
  }
  const relevantes = ids.filter(id => ['ongoing', 'paused'].includes(String(settings[id]?.campaign_status || '').toLowerCase()));
  const metricas = {};
  for (let i = 0; i < relevantes.length; i += 20) {
    const r = await mcpCall(ctx.mcKey, 'shopee_ads_campaign_daily', { shopId: ctx.shopId, campaign_id_list: relevantes.slice(i, i + 20).join(','), start_date: paraBR(de), end_date: paraBR(fim) }).catch(() => null);
    for (const c of (r?.data?.response?.campaign_list || r?.response?.campaign_list || [])) {
      const m = c.metrics_list || [];
      metricas[c.campaign_id] = { gasto: m.reduce((s, d) => s + (parseFloat(d.expense) || 0), 0), gmv: m.reduce((s, d) => s + (parseFloat(d.broad_gmv) || 0), 0), pedidos: m.reduce((s, d) => s + (parseInt(d.broad_order) || 0), 0) };
    }
  }
  let linhas = relevantes.map(id => {
    const s = settings[id], m = metricas[id] || { gasto: 0, gmv: 0, pedidos: 0 };
    return { id, nome: String(s.ad_name || '').slice(0, 60), status: s.campaign_status, orcamento_dia: parseFloat(s.campaign_budget) || 0, meta_roas: s.roas, gasto: r2(m.gasto), gmv: r2(m.gmv), pedidos: m.pedidos, acos_pct: m.gmv > 0 ? r2(m.gasto / m.gmv * 100) : (m.gasto > 0 ? 'sem venda' : null) };
  });
  if (filtro === 'ativas') linhas = linhas.filter(l => l.status === 'ongoing');
  if (filtro === 'pausadas') linhas = linhas.filter(l => l.status === 'paused');
  linhas.sort((a, b) => b.gasto - a.gasto);
  return { periodo_metricas: { inicio: de, fim }, total_campanhas: linhas.length, campanhas: linhas.slice(0, 60), nota };
}

async function historicoRelatorios(ctx, { dias }) {
  const n = Math.min(Math.max(parseInt(dias) || 30, 1), 90);
  const rows = await sbSelect('glr_agente_relatorios', `conta_id=eq.${encodeURIComponent(ctx.shopId)}&order=data.desc&limit=${n}&select=data,metricas,resumo`);
  return rows.map(r => ({ data: r.data, metricas: r.metricas, resumo: String(r.resumo || '').slice(0, 400) }));
}

async function registroAgente(ctx, { dias, tipo }) {
  const n = Math.min(Math.max(parseInt(dias) || 14, 1), 90);
  const desde = new Date(Date.now() - n * 86400000).toISOString();
  let qs = `conta_id=eq.${encodeURIComponent(ctx.shopId)}&criado_em=gte.${encodeURIComponent(desde)}&order=criado_em.desc&limit=80&select=criado_em,tipo,resultado,origem,titulo,explicacao,dados`;
  if (['decisao', 'alerta', 'sistema', 'chat'].includes(tipo)) qs += `&tipo=eq.${tipo}`;
  const rows = await sbSelect('glr_agente_log', qs);
  return rows.map(r => ({ quando: r.criado_em, tipo: r.tipo, resultado: r.resultado, origem: r.origem, titulo: r.titulo, explicacao: String(r.explicacao || '').slice(0, 300), dados: r.dados }));
}

// Qualquer ação de LEITURA da Shopee no conector. Bloqueia tudo que escreve.
const ACAO_ESCRITA = /(pause|resume|edit|update|create|delete|add_|remove|set_|ship|cancel|confirm|dispute|accept|offer|boost|unlist|upload|publish|register|reply|handle|toggle|roi_target|init_|end_|terminate|generate|post|batch_)/i;
async function consultarApi(ctx, { acao, parametros }) {
  const a = String(acao || '');
  if (!/^shopee_/.test(a)) throw new Error('Só ações da Shopee (prefixo shopee_) são permitidas aqui.');
  if (ACAO_ESCRITA.test(a)) throw new Error(`"${a}" altera dados — proibido no chat. Proponha a mudança como sugestão no bloco json.`);
  const params = { ...(parametros && typeof parametros === 'object' ? parametros : {}), shopId: ctx.shopId };
  return mcpCall(ctx.mcKey, a, params);
}

const FERRAMENTAS = [
  {
    name: 'faturamento_loja',
    description: 'Faturamento TOTAL da loja Shopee (todas as vendas, não só ADS) num período, com pedidos, média por dia e quebra por status. Use para saber se a conta está crescendo ou caindo e para comparar períodos (ex.: mês atual até ontem vs mesmos dias do mês anterior). Cada chamada leva alguns segundos.',
    input_schema: { type: 'object', properties: { inicio: { type: 'string', description: 'AAAA-MM-DD' }, fim: { type: 'string', description: 'AAAA-MM-DD (no máximo hoje)' } }, required: ['inicio', 'fim'] },
  },
  {
    name: 'desempenho_ads',
    description: 'Desempenho de ADS da conta dia a dia num período (gasto, vendas atribuídas/GMV, pedidos, impressões, cliques) com totais, ACOS e CTR. Períodos acima de 62 dias voltam agregados por semana.',
    input_schema: { type: 'object', properties: { inicio: { type: 'string', description: 'AAAA-MM-DD' }, fim: { type: 'string', description: 'AAAA-MM-DD' } }, required: ['inicio', 'fim'] },
  },
  {
    name: 'campanhas',
    description: 'Campanhas de ADS (ativas e pausadas) com status, orçamento, meta de ROAS e métricas no período (gasto, GMV, pedidos, ACOS), ordenadas por gasto. Use para achar quais campanhas explicam uma variação ou quais pausadas valem reativar.',
    input_schema: { type: 'object', properties: { inicio: { type: 'string', description: 'AAAA-MM-DD' }, fim: { type: 'string', description: 'AAAA-MM-DD' }, filtro: { type: 'string', enum: ['todas', 'ativas', 'pausadas'] } }, required: ['inicio', 'fim'] },
  },
  {
    name: 'historico_relatorios',
    description: 'Relatórios diários que o agente gravou (um por dia): TACOS da conta, faturamento total da loja na janela, gasto, decisões e resumo. Rápido — bom para ver tendência dia a dia sem chamar a Shopee.',
    input_schema: { type: 'object', properties: { dias: { type: 'integer', description: 'Quantos dias para trás (1 a 90)' } }, required: ['dias'] },
  },
  {
    name: 'registro_agente',
    description: 'Registro do que o agente e o analista fizeram na conta (decisões, alertas, sistema, chat), com motivo e dados. Use para relacionar uma variação com pausas/ajustes feitos.',
    input_schema: { type: 'object', properties: { dias: { type: 'integer', description: '1 a 90' }, tipo: { type: 'string', enum: ['todos', 'decisao', 'alerta', 'sistema', 'chat'] } }, required: ['dias'] },
  },
  {
    name: 'consultar_api_shopee',
    description: 'Último recurso: chama qualquer ação de LEITURA da API da Shopee no conector quando as ferramentas acima não cobrem (ações que alteram algo são bloqueadas; a loja já vai preenchida). Exemplos: shopee_get_shop_performance {}, shopee_ads_hourly_performance {date:"DD-MM-AAAA"}, shopee_ads_campaign_settings {campaign_id_list:"1,2"}, shopee_list_items {}, shopee_get_item {item_id}, shopee_sales_by_item {item_id, start_date, end_date}, shopee_get_return_list {}, shopee_ads_balance {}.',
    input_schema: { type: 'object', properties: { acao: { type: 'string' }, parametros: { type: 'object' } }, required: ['acao'] },
  },
];

const EXECUTORES = {
  faturamento_loja: faturamentoLoja,
  desempenho_ads: desempenhoAds,
  campanhas,
  historico_relatorios: historicoRelatorios,
  registro_agente: registroAgente,
  consultar_api_shopee: consultarApi,
};

function resumoEntrada(nome, input) {
  const i = input || {};
  if (i.inicio && i.fim) return `${nome.replace(/_/g, ' ')} ${paraBR(i.inicio)} a ${paraBR(i.fim)}${i.filtro && i.filtro !== 'todas' ? ` (${i.filtro})` : ''}`;
  if (nome === 'consultar_api_shopee') return `API Shopee: ${i.acao}`;
  if (i.dias) return `${nome.replace(/_/g, ' ')} (${i.dias} dias)`;
  return nome.replace(/_/g, ' ');
}

function guiaFerramentas(hoje, shopId, nome) {
  return `\n\nFERRAMENTAS E DADOS AO VIVO\nHoje é ${hoje} (horário de Brasília). Conta Shopee ${shopId}${nome ? ` (${nome})` : ''}.\nO contexto acima é só um retrato rápido do período aberto na tela. Quando a pergunta precisar de qualquer dado que não esteja nele — outro período, mês atual contra mês passado, tendência semana a semana, uma campanha ou produto específico, o que o agente fez — BUSQUE com as ferramentas antes de responder. Nunca responda que não consegue confirmar algo que uma ferramenta pode buscar.\nComo analisar:\n- Compare períodos do mesmo tamanho. "Este mês vs mês passado" = do dia 1 até ontem deste mês contra os mesmos dias do mês anterior (e, se ajudar, também o mês passado inteiro e a média por dia).\n- Para dizer se a conta cresce ou cai, use o faturamento TOTAL da loja (faturamento_loja), não só o ADS; depois separe o efeito do ADS (desempenho_ads) e de pausas/ajustes (registro_agente). TACOS = gasto de ADS ÷ faturamento total.\n- Seja eficiente: cada faturamento leva alguns segundos; escolha poucas consultas certeiras (até ~8 no total).\n- Na resposta, mostre os números e os períodos exatos que usou, e a conclusão em linguagem direta.\n- As ferramentas só leem. Mudanças continuam sendo propostas no bloco \`\`\`json do formato combinado, para o analista aprovar.`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const mcKey = process.env.MCP_API_KEY;
  if (!process.env.ANTHROPIC_API_KEY || !mcKey || !SUPABASE_KEY) return res.status(500).json({ error: 'Chaves do servidor não configuradas (ANTHROPIC_API_KEY, MCP_API_KEY, SUPABASE_SERVICE_ROLE_KEY).' });

  const usuario = await usuarioLogado(req).catch(() => null);
  if (!usuario) return res.status(401).json({ error: 'Sessão expirada — entre de novo no sistema.' });

  const { conta_id, system, messages } = req.body || {};
  if (!conta_id) return res.status(400).json({ error: 'conta_id obrigatório' });
  const cfg = (await sbSelect('glr_agente_config', `conta_id=eq.${encodeURIComponent(conta_id)}&select=conta_id,cliente_nome&limit=1`).catch(() => []))[0];
  if (!cfg) return res.status(404).json({ error: 'Conta sem piloto configurado.' });

  const historico = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content }));
  if (!historico.length || historico[historico.length - 1].role !== 'user') return res.status(400).json({ error: 'A última mensagem precisa ser do analista.' });
  while (historico.length && historico[0].role !== 'user') historico.shift();

  const ctx = { mcKey, shopId: String(conta_id) };
  const client = new Anthropic();
  const sistema = String(system || 'Você é o Agente Autônomo de ADS da GLR Consultoria. Responda em português.') + guiaFerramentas(hojeBRT(), ctx.shopId, cfg.cliente_nome);
  const mensagens = [...historico];
  const usadas = [];
  const inicio = Date.now();

  try {
    let resposta = null;
    for (let rodada = 0; rodada < MAX_RODADAS + 1; rodada++) {
      const semTempo = Date.now() - inicio > ORCAMENTO_MS || rodada >= MAX_RODADAS;
      resposta = await client.beta.messages.create({
        model: MODELO,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: sistema,
        tools: FERRAMENTAS,
        tool_choice: semTempo ? { type: 'none' } : { type: 'auto' },
        messages: mensagens,
      });

      if (resposta.stop_reason === 'pause_turn') { mensagens.push({ role: 'assistant', content: resposta.content }); continue; }
      if (resposta.stop_reason !== 'tool_use') break;

      mensagens.push({ role: 'assistant', content: resposta.content });
      const resultados = [];
      // Em sequência (não em paralelo): o conector corrompe respostas simultâneas.
      for (const bloco of resposta.content.filter(b => b.type === 'tool_use')) {
        const exec = EXECUTORES[bloco.name];
        const passouTempo = Date.now() - inicio > ORCAMENTO_MS;
        try {
          if (!exec) throw new Error(`Ferramenta desconhecida: ${bloco.name}`);
          if (passouTempo) throw new Error('Tempo de consulta esgotado — responda com o que já tem.');
          const saida = await exec(ctx, bloco.input || {});
          let texto = JSON.stringify(saida);
          if (texto.length > LIMITE_RESULTADO) texto = texto.slice(0, LIMITE_RESULTADO) + '… [resultado cortado por tamanho — refine a consulta se precisar do resto]';
          resultados.push({ type: 'tool_result', tool_use_id: bloco.id, content: texto });
          usadas.push({ ferramenta: bloco.name, resumo: resumoEntrada(bloco.name, bloco.input) });
        } catch (e) {
          resultados.push({ type: 'tool_result', tool_use_id: bloco.id, content: `Erro: ${e.message || e}`, is_error: true });
          usadas.push({ ferramenta: bloco.name, resumo: resumoEntrada(bloco.name, bloco.input), erro: true });
        }
      }
      mensagens.push({ role: 'user', content: resultados });
    }

    if (resposta.stop_reason === 'refusal') {
      return res.status(200).json({ content: 'Não consegui responder a essa pergunta. Tente reformular.', ferramentas: usadas });
    }
    const texto = resposta.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return res.status(200).json({
      content: texto || 'Sem resposta.',
      ferramentas: usadas,
      cortada: resposta.stop_reason === 'max_tokens',
      modelo: resposta.model,
      segundos: Math.round((Date.now() - inicio) / 1000),
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'Muitas perguntas ao mesmo tempo — espere alguns segundos e tente de novo.' });
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: `Falha no modelo (${e.status}): ${e.message}` });
    return res.status(500).json({ error: e.message || String(e) });
  }
};
