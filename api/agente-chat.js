// ============================================================
// GLR Consultoria — Chat do Agente com ferramentas (Shopee + base sincronizada)
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

// ── Base sincronizada (glr_pedidos / vw_vendas_dia / glr_ads_diario) ──────
// O motor de dados (api/sync-dados.js) grava a cada 15 min os pedidos e o
// ADS de todas as lojas Shopee e Mercado Livre. Ler daqui é instantâneo e
// permite enxergar o CLIENTE inteiro (todas as lojas/plataformas), não só
// esta loja Shopee. Mesma regra de faturamento da tela de Vendas.
const MKT = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : null; };
const NOME_MKT = { shopee: 'Shopee', ml: 'Mercado Livre' };
const inicioDiaBRT = iso => `${iso}T00:00:00-03:00`;

async function sbTodos(table, qs, max = 30000) {
  const out = [];
  for (let off = 0; off < max; off += 1000) {
    const rows = await sbSelect(table, `${qs}&limit=1000&offset=${off}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const lerStorage = async chave => (await sbSelect('glr_storage', `chave=eq.${chave}&select=dados`).catch(() => []))[0]?.dados;

// Nome da LOJA pela etiqueta da conta no conector ("Home 3B"), não "Shopee 1744094948".
async function nomesDasLojas() {
  const nomes = {};
  const contas = await lerStorage('glr_mc_contas');
  for (const c of (Array.isArray(contas) ? contas : (contas?.accounts || []))) {
    const tag = (c.tags || []).find(t => t && typeof t === 'object' && t.name);
    if (tag) nomes[String(c.external_id)] = String(tag.name).replace(/\s*[-–]\s*(shopee|ml|mercado livre)\s*$/i, '').trim();
  }
  return nomes;
}

// Lojas da análise: só esta loja, ou todas as lojas do mesmo cliente (Integrações).
async function lojasDoEscopo(ctx, escopo) {
  const nomes = await nomesDasLojas();
  const propria = [{ marketplace: 'shopee', conta_id: ctx.shopId, nome: nomes[ctx.shopId] || ctx.nome || ctx.shopId }];
  if (escopo !== 'cliente') return { lojas: propria, cliente: null };
  const vinc = (await lerStorage('glr_mc_vinculos')) || {};
  const clientes = (await lerStorage('glr_clientes')) || [];
  for (const [cid, lista] of Object.entries(vinc)) {
    if (!(lista || []).some(c => String(c.external_id) === ctx.shopId)) continue;
    const cliente = (Array.isArray(clientes) ? clientes : []).find(c => String(c.id) === String(cid))?.nome || null;
    const lojas = lista.map(c => ({ marketplace: MKT(c.marketplace), conta_id: String(c.external_id), nome: nomes[String(c.external_id)] || c.nickname || c.external_id })).filter(l => l.marketplace);
    const fora = lista.filter(c => !MKT(c.marketplace)).map(c => c.marketplace);
    return { lojas, cliente, aviso: fora.length ? `Lojas em ${[...new Set(fora.map(m => String(m || '?').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())))].join(', ')} ainda não estão na base sincronizada (só Shopee e Mercado Livre por enquanto).` : null };
  }
  return { lojas: propria, cliente: null, aviso: 'Esta loja não está vinculada a um cliente em Integrações — mostrando só ela.' };
}

const listaIn = lojas => encodeURIComponent(`(${[...new Set(lojas.map(l => l.conta_id))].join(',')})`);
const daLoja = lojas => { const ok = new Set(lojas.map(l => `${l.marketplace}:${l.conta_id}`)); return r => ok.has(`${r.marketplace}:${r.conta_id}`); };

// Até que data cada loja já tem histórico completo na base, e quando sincronizou.
async function coberturaBase(lojas, inicio) {
  const est = await sbSelect('glr_sync_estado', `recurso=eq.pedidos&conta_id=in.${listaIn(lojas)}&select=marketplace,conta_id,ultimo_sucesso,ultimo_erro,cursor`).catch(() => []);
  const porLoja = {};
  for (const e of est.filter(daLoja(lojas))) porLoja[`${e.marketplace}:${e.conta_id}`] = e;
  const avisos = [];
  for (const l of lojas) {
    const e = porLoja[`${l.marketplace}:${l.conta_id}`];
    if (!e) { avisos.push(`${l.nome} (${NOME_MKT[l.marketplace]}): ainda não sincronizada — sem dados na base.`); continue; }
    const desde = e.cursor?.historico_ate ? isoDe(new Date((e.cursor.historico_ate - 3 * 3600) * 1000)) : null;
    if (desde && desde > inicio) avisos.push(`${l.nome} (${NOME_MKT[l.marketplace]}): histórico na base só a partir de ${paraBR(desde)} (ainda carregando) — antes disso o número está incompleto${l.marketplace === 'shopee' ? '; para esse trecho use faturamento_loja' : ''}.`);
    if (e.ultimo_erro) avisos.push(`${l.nome}: última sincronização com erro (${String(e.ultimo_erro).slice(0, 120)}).`);
  }
  return avisos;
}

function agruparSerie(linhas, campoData, modo, campos) {
  const chave = d => modo === 'mes' ? d.slice(0, 7) : modo === 'semana' ? (() => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return 'sem. ' + paraBR(isoDe(x)); })() : d;
  const mapa = new Map();
  for (const r of linhas) {
    const k = chave(String(r[campoData]).slice(0, 10));
    const acc = mapa.get(k) || Object.fromEntries(campos.map(c => [c, 0]));
    for (const c of campos) acc[c] += parseFloat(r[c]) || 0;
    mapa.set(k, acc);
  }
  return [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([periodo, v]) => ({ periodo, ...Object.fromEntries(Object.entries(v).map(([c, x]) => [c, r2(x)])) }));
}
const modoSerie = (n, pedido) => ['dia', 'semana', 'mes'].includes(pedido) ? pedido : n <= 45 ? 'dia' : n <= 200 ? 'semana' : 'mes';

async function vendasBase(ctx, { inicio, fim, escopo, agrupar }) {
  validarPeriodo(inicio, fim);
  const { lojas, cliente, aviso } = await lojasDoEscopo(ctx, escopo);
  const linhas = (await sbTodos('vw_vendas_dia', `conta_id=in.${listaIn(lojas)}&dia=gte.${inicio}&dia=lte.${fim}&select=marketplace,conta_id,dia,pedidos_validos,faturamento_valido,faturamento_bruto,cancelado,devolvido,pedidos_total`)).filter(daLoja(lojas));
  const n = diasEntre(inicio, fim);
  const soma = (rs, c) => rs.reduce((s, r) => s + (parseFloat(r[c]) || 0), 0);
  const fatValido = soma(linhas, 'faturamento_valido');
  const porLoja = lojas.map(l => {
    const rs = linhas.filter(r => r.marketplace === l.marketplace && r.conta_id === l.conta_id);
    const f = soma(rs, 'faturamento_valido');
    return { loja: l.nome, marketplace: NOME_MKT[l.marketplace], conta_id: l.conta_id, faturamento_valido: r2(f), pedidos_validos: soma(rs, 'pedidos_validos'), cancelado: r2(soma(rs, 'cancelado')), participacao_pct: fatValido > 0 ? r2(f / fatValido * 100) : 0 };
  }).sort((a, b) => b.faturamento_valido - a.faturamento_valido);
  const avisos = [aviso, ...(await coberturaBase(lojas, inicio))].filter(Boolean);
  if (fim === hojeBRT()) avisos.push('O período inclui hoje, que ainda está em andamento.');
  return {
    escopo: escopo === 'cliente' ? `cliente${cliente ? ` ${cliente}` : ''} (${lojas.length} lojas)` : 'esta loja',
    periodo: { inicio, fim, dias: n },
    total: { faturamento_valido: r2(fatValido), faturamento_bruto: r2(soma(linhas, 'faturamento_bruto')), cancelado: r2(soma(linhas, 'cancelado')), pedidos_validos: soma(linhas, 'pedidos_validos'), media_dia_valido: r2(fatValido / n), ticket_medio: soma(linhas, 'pedidos_validos') ? r2(fatValido / soma(linhas, 'pedidos_validos')) : null },
    por_loja: porLoja,
    serie: agruparSerie(linhas, 'dia', modoSerie(n, agrupar), ['faturamento_valido', 'pedidos_validos', 'cancelado']),
    avisos,
    regra: 'Faturamento válido = sem cancelados (mesma regra da tela de Vendas). Bruto inclui cancelados (base do TACOS do agente).',
  };
}

async function produtosBase(ctx, { inicio, fim, escopo, limite }) {
  validarPeriodo(inicio, fim);
  const n = diasEntre(inicio, fim);
  if (n > 62) throw new Error('Para produtos use no máximo 62 dias por período (ele já compara com o período anterior do mesmo tamanho).');
  const antInicio = somarDias(inicio, -n), antFim = somarDias(inicio, -1);
  const { lojas, cliente, aviso } = await lojasDoEscopo(ctx, escopo);
  const pedidos = (await sbTodos('glr_pedidos', `conta_id=in.${listaIn(lojas)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(inicioDiaBRT(antInicio))}&criado_em=lt.${encodeURIComponent(inicioDiaBRT(somarDias(fim, 1)))}&select=marketplace,conta_id,criado_em,itens`, 60000)).filter(daLoja(lojas));
  const limiteAtual = new Date(inicioDiaBRT(inicio)).getTime();
  const nomeLoja = Object.fromEntries(lojas.map(l => [`${l.marketplace}:${l.conta_id}`, l.nome]));
  const mapa = new Map();
  for (const p of pedidos) {
    const lado = new Date(p.criado_em).getTime() >= limiteAtual ? 'atual' : 'anterior';
    for (const it of (p.itens || [])) {
      const k = `${p.marketplace}:${p.conta_id}:${it.item_id || it.sku || it.nome}`;
      const acc = mapa.get(k) || { produto: String(it.nome || it.sku || it.item_id).slice(0, 70), item_id: it.item_id || null, sku: it.sku || null, loja: nomeLoja[`${p.marketplace}:${p.conta_id}`], marketplace: NOME_MKT[p.marketplace], atual: { fat: 0, qtd: 0 }, anterior: { fat: 0, qtd: 0 } };
      acc[lado].fat += (parseFloat(it.preco) || 0) * (parseInt(it.qtd) || 1);
      acc[lado].qtd += parseInt(it.qtd) || 1;
      mapa.set(k, acc);
    }
  }
  const todos = [...mapa.values()].map(a => ({ ...a, atual: { fat: r2(a.atual.fat), qtd: a.atual.qtd }, anterior: { fat: r2(a.anterior.fat), qtd: a.anterior.qtd }, variacao_pct: a.anterior.fat > 0 ? r2((a.atual.fat - a.anterior.fat) / a.anterior.fat * 100) : (a.atual.fat > 0 ? 'novo' : null), diferenca: r2(a.atual.fat - a.anterior.fat) }));
  const totalAtual = todos.reduce((s, a) => s + a.atual.fat, 0);
  let acum = 0;
  const ranking = [...todos].sort((a, b) => b.atual.fat - a.atual.fat).map(a => { acum += a.atual.fat; return { ...a, curva: totalAtual ? (acum / totalAtual <= 0.8 ? 'A' : acum / totalAtual <= 0.95 ? 'B' : 'C') : 'C', participacao_pct: totalAtual ? r2(a.atual.fat / totalAtual * 100) : 0 }; });
  const lim = Math.min(Math.max(parseInt(limite) || 15, 5), 40);
  const curvaDe = Object.fromEntries(ranking.map(r => [`${r.marketplace}:${r.item_id || r.sku || r.produto}`, r.curva]));
  const comCurva = a => ({ ...a, curva: curvaDe[`${a.marketplace}:${a.item_id || a.sku || a.produto}`] || 'C' });
  return {
    escopo: escopo === 'cliente' ? `cliente${cliente ? ` ${cliente}` : ''} (${lojas.length} lojas)` : 'esta loja',
    periodo_atual: { inicio, fim }, periodo_anterior: { inicio: antInicio, fim: antFim },
    faturamento_produtos: { atual: r2(totalAtual), anterior: r2(todos.reduce((s, a) => s + a.anterior.fat, 0)) },
    curva_a: ranking.filter(r => r.curva === 'A').length,
    mais_vendidos: ranking.slice(0, lim),
    maiores_quedas: todos.filter(a => a.diferenca < 0).sort((a, b) => a.diferenca - b.diferenca).slice(0, lim).map(comCurva),
    maiores_altas: todos.filter(a => a.diferenca > 0).sort((a, b) => b.diferenca - a.diferenca).slice(0, lim).map(comCurva),
    avisos: [aviso, ...(await coberturaBase(lojas, antInicio))].filter(Boolean),
    regra: 'Valor por produto = preço praticado × quantidade, só pedidos válidos. Curva A = produtos que somam os primeiros 80% do faturamento do período atual.',
  };
}

async function adsBase(ctx, { inicio, fim, escopo, agrupar }) {
  validarPeriodo(inicio, fim);
  const { lojas, cliente, aviso } = await lojasDoEscopo(ctx, escopo);
  const [ads, vendas] = await Promise.all([
    sbTodos('glr_ads_diario', `conta_id=in.${listaIn(lojas)}&data=gte.${inicio}&data=lte.${fim}&select=marketplace,conta_id,data,gasto,gmv_ads,pedidos_ads,impressoes,cliques`),
    sbTodos('vw_vendas_dia', `conta_id=in.${listaIn(lojas)}&dia=gte.${inicio}&dia=lte.${fim}&select=marketplace,conta_id,dia,faturamento_valido,faturamento_bruto`),
  ]);
  const a = ads.filter(daLoja(lojas)), v = vendas.filter(daLoja(lojas));
  const soma = (rs, c) => rs.reduce((s, r) => s + (parseFloat(r[c]) || 0), 0);
  const gasto = soma(a, 'gasto'), gmv = soma(a, 'gmv_ads'), fv = soma(v, 'faturamento_valido'), fb = soma(v, 'faturamento_bruto');
  const n = diasEntre(inicio, fim);
  const modo = modoSerie(n, agrupar);
  const sAds = agruparSerie(a, 'data', modo, ['gasto', 'gmv_ads', 'pedidos_ads']);
  const sVen = Object.fromEntries(agruparSerie(v, 'dia', modo, ['faturamento_valido', 'faturamento_bruto']).map(x => [x.periodo, x]));
  const porLoja = lojas.map(l => {
    const fa = a.filter(r => r.marketplace === l.marketplace && r.conta_id === l.conta_id), fvv = v.filter(r => r.marketplace === l.marketplace && r.conta_id === l.conta_id);
    const g = soma(fa, 'gasto'), b = soma(fvv, 'faturamento_bruto');
    return { loja: l.nome, marketplace: NOME_MKT[l.marketplace], gasto: r2(g), gmv_ads: r2(soma(fa, 'gmv_ads')), tacos_bruto_pct: b > 0 ? r2(g / b * 100) : null };
  });
  return {
    escopo: escopo === 'cliente' ? `cliente${cliente ? ` ${cliente}` : ''} (${lojas.length} lojas)` : 'esta loja',
    periodo: { inicio, fim, dias: n },
    total: { gasto_ads: r2(gasto), gmv_ads: r2(gmv), acos_pct: gmv > 0 ? r2(gasto / gmv * 100) : null, roas: gasto > 0 ? r2(gmv / gasto) : null, faturamento_valido: r2(fv), faturamento_bruto: r2(fb), tacos_bruto_pct: fb > 0 ? r2(gasto / fb * 100) : null, tacos_valido_pct: fv > 0 ? r2(gasto / fv * 100) : null },
    por_loja: porLoja,
    serie: sAds.map(x => ({ ...x, faturamento_valido: sVen[x.periodo]?.faturamento_valido ?? 0, tacos_bruto_pct: sVen[x.periodo]?.faturamento_bruto > 0 ? r2(x.gasto / sVen[x.periodo].faturamento_bruto * 100) : null })),
    avisos: [aviso, ...(await coberturaBase(lojas, inicio))].filter(Boolean),
    regra: 'GMV de ADS é a atribuição da plataforma (pode passar do faturamento). TACOS = gasto ÷ faturamento total da loja. No ML, pedidos_ads = unidades vendidas via ADS.',
  };
}

const ESCOPO = { type: 'string', enum: ['loja', 'cliente'], description: 'loja = só esta loja Shopee; cliente = todas as lojas do mesmo cliente (Shopee + Mercado Livre)' };
const FERRAMENTAS = [
  {
    name: 'vendas_base',
    description: 'INSTANTÂNEO. Faturamento válido (sem cancelados), bruto, cancelado, pedidos e ticket médio num período, com série por dia/semana/mês e quebra por loja — da base sincronizada a cada 15 min. Com escopo "cliente" soma TODAS as lojas do cliente (Shopee e Mercado Livre). Primeira escolha para saber se a conta/cliente cresce ou cai e para comparar períodos. Leia os avisos de cobertura: se o histórico de uma loja ainda não cobre o período, use faturamento_loja para o trecho que falta.',
    input_schema: { type: 'object', properties: { inicio: { type: 'string', description: 'AAAA-MM-DD' }, fim: { type: 'string', description: 'AAAA-MM-DD (no máximo hoje)' }, escopo: ESCOPO, agrupar: { type: 'string', enum: ['dia', 'semana', 'mes'] } }, required: ['inicio', 'fim'] },
  },
  {
    name: 'produtos_base',
    description: 'INSTANTÂNEO. Produtos do período comparados com o período anterior do mesmo tamanho: mais vendidos (com curva ABC), maiores quedas e maiores altas em R$ e quantidade. Use para explicar POR QUE o faturamento mudou e para achar produto curva A em queda. Máx. 62 dias por período.',
    input_schema: { type: 'object', properties: { inicio: { type: 'string', description: 'AAAA-MM-DD' }, fim: { type: 'string', description: 'AAAA-MM-DD' }, escopo: ESCOPO, limite: { type: 'integer', description: 'itens por lista (5 a 40, padrão 15)' } }, required: ['inicio', 'fim'] },
  },
  {
    name: 'ads_base',
    description: 'INSTANTÂNEO. ADS por dia/semana/mês da base sincronizada cruzado com o faturamento: gasto, GMV atribuído, ACOS, ROAS, TACOS bruto e válido, por loja. Com escopo "cliente" inclui o ADS do Mercado Livre. Para detalhe por campanha use campanhas.',
    input_schema: { type: 'object', properties: { inicio: { type: 'string', description: 'AAAA-MM-DD' }, fim: { type: 'string', description: 'AAAA-MM-DD' }, escopo: ESCOPO, agrupar: { type: 'string', enum: ['dia', 'semana', 'mes'] } }, required: ['inicio', 'fim'] },
  },
  {
    name: 'faturamento_loja',
    description: 'LENTO (direto na API da Shopee, alguns segundos por chamada). Faturamento TOTAL desta loja Shopee num período, com quebra por status. Use só quando vendas_base avisar que o histórico da loja ainda não cobre o período pedido, ou para conferir um número.',
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
  vendas_base: vendasBase,
  produtos_base: produtosBase,
  ads_base: adsBase,
  faturamento_loja: faturamentoLoja,
  desempenho_ads: desempenhoAds,
  campanhas,
  historico_relatorios: historicoRelatorios,
  registro_agente: registroAgente,
  consultar_api_shopee: consultarApi,
};

function resumoEntrada(nome, input) {
  const i = input || {};
  if (i.inicio && i.fim) return `${nome.replace(/_base$/, '').replace(/_/g, ' ')} ${paraBR(i.inicio)} a ${paraBR(i.fim)}${i.escopo === 'cliente' ? ' (cliente inteiro)' : ''}${i.filtro && i.filtro !== 'todas' ? ` (${i.filtro})` : ''}`;
  if (nome === 'consultar_api_shopee') return `API Shopee: ${i.acao}`;
  if (i.dias) return `${nome.replace(/_/g, ' ')} (${i.dias} dias)`;
  return nome.replace(/_/g, ' ');
}

function guiaFerramentas(hoje, shopId, nome) {
  return `\n\nFERRAMENTAS E DADOS AO VIVO\nHoje é ${hoje} (horário de Brasília). Conta Shopee ${shopId}${nome ? ` (${nome})` : ''}.\nO contexto acima é só um retrato rápido do período aberto na tela. Quando a pergunta precisar de qualquer dado que não esteja nele — outro período, mês atual contra mês passado, tendência semana a semana, uma campanha ou produto específico, o que o agente fez — BUSQUE com as ferramentas antes de responder. Nunca responda que não consegue confirmar algo que uma ferramenta pode buscar.\nComo analisar:\n- Compare períodos do mesmo tamanho. "Este mês vs mês passado" = do dia 1 até ontem deste mês contra os mesmos dias do mês anterior (e, se ajudar, também o mês passado inteiro e a média por dia).\n- Comece SEMPRE pela base sincronizada (vendas_base, produtos_base, ads_base): é instantânea e cobre todas as lojas do cliente na Shopee e no Mercado Livre (escopo \"cliente\"). Para dizer se a conta cresce ou cai, use o faturamento TOTAL (vendas_base), não só o ADS; explique a variação pelos produtos (produtos_base: curva A em queda, produtos novos) e separe o efeito do ADS (ads_base / campanhas) e de pausas/ajustes (registro_agente). TACOS = gasto de ADS ÷ faturamento total.\n- Olhe também o cliente inteiro quando fizer sentido: a queda desta loja pode ser compensada (ou agravada) por outra loja ou pelo Mercado Livre.\n- Respeite os avisos de cobertura das ferramentas da base: se o histórico de uma loja ainda está carregando, diga isso e complete com faturamento_loja (API, lenta).\n- Seja eficiente: as ferramentas da base são instantâneas; as da API levam segundos (até ~8 chamadas de API no total).\n- Na resposta, mostre os números e os períodos exatos que usou, e a conclusão em linguagem direta.\n- As ferramentas só leem. Mudanças continuam sendo propostas no bloco \`\`\`json do formato combinado, para o analista aprovar.`;
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

  const ctx = { mcKey, shopId: String(conta_id), nome: cfg.cliente_nome || null };
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
