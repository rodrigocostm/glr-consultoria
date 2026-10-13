// ============================================================
// GLR Consultoria — Motor de sincronização de dados (Shopee + Mercado Livre)
// ------------------------------------------------------------
// Chamado pelo agendador do próprio Supabase (pg_cron, ver
// supabase-motor-dados.sql): a cada 15 min ("incremental") e toda noite
// ("reprocessar" os últimos 45 dias, pra pegar cancelamento tardio).
// Grava pedidos normalizados em glr_pedidos e ADS por dia em
// glr_ads_diario — a fonte única que as telas e o Agente vão ler.
//
// Regra de valor e de cancelado = a mesma da tela de Vendas (a referência
// que hoje traz os números corretos): valor do pedido = soma dos produtos
// (sem o frete do comprador); cancelado = status com "CANCEL". Pedido não
// pago (UNPAID) não entra — Vendas também não conta.
// ============================================================
const { waitUntil } = require('@vercel/functions');

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORCAMENTO_MS = 270000;     // dentro do maxDuration (300s)
const CONCORRENCIA = 10;         // lojas em paralelo (dentro da loja é sequencial)
const DIAS_HISTORICO = 90;       // histórico inicial carregado aos poucos
const DIAS_REPROCESSAR = 45;     // rede de segurança diária (cancelamento/devolução tardia)
const TEMPO_FUNDO_POR_CONTA_MS = 60000; // histórico/reprocesso: no máx. 1 min por loja por rodada
const SEG = 1000;
const DIA = 86400;

const sbHeaders = extra => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...extra });
async function sbSelect(table, qs) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase select ${table}: HTTP ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}
async function sbUpsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
    if (!r.ok) throw new Error(`Supabase upsert ${table}: HTTP ${r.status} ${await r.text().catch(() => '')}`);
  }
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
async function comRetry(fn, tentativas = 3) {
  let erro;
  for (let t = 0; t < tentativas; t++) {
    try { return await fn(); } catch (e) { erro = e; await new Promise(r => setTimeout(r, 800 * (t + 1))); }
  }
  throw erro;
}

const agora = () => Math.floor(Date.now() / SEG);
const isoDeUnix = s => new Date(s * SEG).toISOString();
const r2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const ddmmyyyy = unix => { const d = new Date((unix - 3 * 3600) * SEG); const p = n => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`; };
const dataBR = unix => { const d = new Date((unix - 3 * 3600) * SEG); const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; };

// ── Contas a sincronizar: TODAS as lojas Shopee e Mercado Livre conectadas
//    no conector + as vinculadas a clientes + as do piloto do Agente ──
const MKT = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : null; };
async function contasParaSincronizar(apiKey) {
  const chaves = new Map(); // "mkt:id" → { mkt, id }
  const add = (m, id) => { const mkt = MKT(m); if (mkt && id) chaves.set(`${mkt}:${id}`, { mkt, id: String(id) }); };
  try {
    const r = await comRetry(() => mcpCall(apiKey, 'list_accounts', {}));
    for (const c of (r.data?.accounts || r.accounts || [])) add(c.marketplace, c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.external_id);
  } catch (e) { console.warn('[sync-dados] list_accounts falhou, seguindo só com os vínculos:', e.message); }
  const vinc = (await sbSelect('glr_storage', 'chave=eq.glr_mc_vinculos&select=dados'))[0]?.dados || {};
  for (const lista of Object.values(vinc)) for (const c of (Array.isArray(lista) ? lista : [])) add(c.marketplace, c.external_id);
  for (const c of await sbSelect('glr_agente_config', 'select=conta_id,marketplace')) add(c.marketplace || 'shopee', c.conta_id);
  return [...chaves.values()];
}

// ── Shopee: lista os order_sn de uma janela (até 15 dias por chamada) ──
const STATUS_SHOPEE = ['READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED', 'INVOICE_PENDING', 'TO_RETURN', 'IN_CANCEL', 'CANCELLED'];
async function listarSns(apiKey, shopId, campo, de, ate) {
  const sns = new Set();
  const varrer = async (status) => {
    let cursor = '';
    for (let pag = 0; pag < 200; pag++) {
      const params = { shopId, time_range_field: campo, time_from: de, time_to: ate, page_size: 100 };
      if (status) params.order_status = status;
      if (cursor) params.cursor = cursor;
      const r = await comRetry(() => mcpCall(apiKey, 'shopee_list_orders', params));
      const resp = r.data?.response || r.response || {};
      for (const o of (resp.order_list || [])) sns.add(o.order_sn);
      cursor = resp.more ? (resp.next_cursor || '') : '';
      if (!cursor) break;
    }
  };
  try {
    await varrer(null); // sem status: traz todos de uma vez (confirmado ao vivo)
  } catch (e) {
    if (!/status/i.test(e.message)) throw e;
    for (const st of STATUS_SHOPEE) await varrer(st); // conector exigiu status: varre um a um
  }
  return [...sns];
}

function mapearPedidoShopee(shopId, o) {
  const status = String(o.order_status || '');
  if (status === 'UNPAID') return null;
  const itens = (o.item_list || []).map(it => ({
    item_id: it.item_id, sku: it.model_sku || it.item_sku || '', nome: it.item_name || '',
    qtd: parseInt(it.model_quantity_purchased) || 1, preco: r2(it.model_discounted_price),
  }));
  const total = r2(o.total_amount);
  const subtotal = r2(itens.reduce((s, i) => s + i.preco * i.qtd, 0));
  return {
    marketplace: 'shopee', conta_id: String(shopId), pedido_id: String(o.order_sn),
    criado_em: isoDeUnix(o.create_time), atualizado_mkt: o.update_time ? isoDeUnix(o.update_time) : null,
    status_original: status,
    situacao: /CANCEL/i.test(status) ? 'cancelado' : 'valido',
    valor_bruto: subtotal > 0 ? subtotal : total,
    valor_itens: subtotal, frete: r2(Math.max(0, total - subtotal)),
    itens, sincronizado_em: new Date().toISOString(),
  };
}

// Grava lote a lote (50 pedidos): o que já foi buscado fica salvo mesmo se o
// tempo da rodada acabar no meio. Devolve { n, completo }.
async function gravarPedidos(apiKey, shopId, sns, prazo) {
  let n = 0;
  for (let i = 0; i < sns.length; i += 50) {
    if (prazo && Date.now() > prazo) return { n, completo: false };
    const lote = sns.slice(i, i + 50);
    const r = await comRetry(() => mcpCall(apiKey, 'shopee_get_order_detail', { shopId, order_sn_list: lote, response_optional_fields: 'total_amount,item_list,order_status,update_time' }));
    const linhas = [];
    for (const o of (r.data?.response?.order_list || r.response?.order_list || [])) {
      const linha = mapearPedidoShopee(shopId, o);
      if (linha) linhas.push(linha);
    }
    if (linhas.length) await sbUpsert('glr_pedidos', linhas, 'marketplace,conta_id,pedido_id');
    n += linhas.length;
  }
  return { n, completo: true };
}

async function gravarAds(apiKey, shopId, de, ate) {
  const linhas = [];
  for (let ini = de; ini <= ate; ini += 30 * 86400) {
    const fim = Math.min(ini + 29 * 86400, ate);
    const r = await comRetry(() => mcpCall(apiKey, 'shopee_ads_daily_performance', { shopId, start_date: ddmmyyyy(ini), end_date: ddmmyyyy(fim) }));
    for (const d of (r.data?.response || r.response || [])) {
      const [dd, mm, aa] = String(d.date || '').split('-');
      if (!aa) continue;
      linhas.push({ marketplace: 'shopee', conta_id: String(shopId), data: `${aa}-${mm}-${dd}`, gasto: r2(d.expense), gmv_ads: r2(d.broad_gmv), pedidos_ads: parseInt(d.broad_order) || 0, impressoes: parseInt(d.impression) || 0, cliques: parseInt(d.clicks) || 0, sincronizado_em: new Date().toISOString() });
    }
  }
  // Um dia por linha (o banco recusa o lote se a mesma chave vier repetida).
  const unicas = [...new Map(linhas.map(l => [l.data, l])).values()];
  if (unicas.length) await sbUpsert('glr_ads_diario', unicas, 'marketplace,conta_id,data');
  return unicas.length;
}

// ── Mercado Livre: mesma regra da tela de Vendas — valor = total_amount;
//    cancelado/inválido fica fora do faturamento válido ──
function mapearPedidoML(contaId, o) {
  const status = String(o.status || '').toLowerCase();
  const itens = (o.order_items || []).map(i => ({
    item_id: i.item?.id || '', sku: i.item?.seller_sku || '', nome: i.item?.title || '',
    qtd: parseInt(i.quantity) || 1, preco: r2(i.unit_price), tarifa_venda: r2(i.sale_fee),
  }));
  return {
    marketplace: 'ml', conta_id: String(contaId), pedido_id: String(o.id),
    criado_em: new Date(o.date_created).toISOString(), atualizado_mkt: o.last_updated ? new Date(o.last_updated).toISOString() : null,
    status_original: o.status || '',
    situacao: status.includes('cancel') || status === 'invalid' ? 'cancelado' : 'valido',
    valor_bruto: r2(o.total_amount),
    valor_itens: r2(itens.reduce((s, i) => s + i.preco * i.qtd, 0)), frete: null,
    taxas: { tarifa_venda: r2(itens.reduce((s, i) => s + i.tarifa_venda * i.qtd, 0)), pack_id: o.pack_id || null },
    itens, sincronizado_em: new Date().toISOString(),
  };
}
// Pedidos criados entre duas datas (AAAA-MM-DD), página de 50, gravando a cada página.
async function gravarPedidosML(apiKey, contaId, dataDe, dataAte, prazo) {
  let n = 0;
  for (let offset = 0; offset < 10000; offset += 50) {
    if (prazo && Date.now() > prazo) return { n, completo: false };
    const r = await comRetry(() => mcpCall(apiKey, 'list_orders_detail', { meliUserId: contaId, date_from: dataDe, date_to: dataAte, limit: 50, offset }));
    const d = r.data || r;
    const res = d.results || [];
    const linhas = res.filter(o => o && o.id && o.date_created).map(o => mapearPedidoML(contaId, o));
    if (linhas.length) await sbUpsert('glr_pedidos', [...new Map(linhas.map(l => [l.pedido_id, l])).values()], 'marketplace,conta_id,pedido_id');
    n += linhas.length;
    const total = parseInt(d.paging?.total) || 0;
    if (res.length < 50 || (total && offset + 50 >= total)) break;
  }
  return { n, completo: true };
}
async function gravarAdsML(apiKey, contaId, de, ate) {
  const linhas = [];
  for (let ini = de; ini <= ate; ini += 30 * DIA) {
    const fim = Math.min(ini + 29 * DIA, ate);
    let r;
    try {
      r = await comRetry(() => mcpCall(apiKey, 'ml_ads_metrics', { meliUserId: contaId, date_from: dataBR(ini), date_to: dataBR(fim), group_by: 'day' }));
    } catch (e) {
      // Conta sem Product Ads não é erro de sincronização — só não tem ADS.
      if (/anunciante|advertiser|product ads|not found|no encontr|não encontr|404/i.test(e.message)) return 0;
      throw e;
    }
    for (const d of ((r.data || r).results || [])) {
      if (!d.date) continue;
      linhas.push({ marketplace: 'ml', conta_id: String(contaId), data: String(d.date).slice(0, 10), gasto: r2(d.cost), gmv_ads: r2(d.total_amount), pedidos_ads: parseInt(d.units_quantity) || 0, impressoes: parseInt(d.prints) || 0, cliques: parseInt(d.clicks) || 0, sincronizado_em: new Date().toISOString() });
    }
  }
  const unicas = [...new Map(linhas.map(l => [l.data, l])).values()];
  if (unicas.length) await sbUpsert('glr_ads_diario', unicas, 'marketplace,conta_id,data');
  return unicas.length;
}

// ── O que muda entre marketplaces fica aqui; o resto do motor é igual ──
const ADAPTADORES = {
  shopee: {
    // Por data de ATUALIZAÇÃO: venda nova, cancelamento e devolução de qualquer data.
    async incremental(apiKey, id, cursor, t, prazo) {
      const desde = Math.max((cursor.ate_update || t - 2 * DIA) - 600, t - 14 * DIA);
      const r = await gravarPedidos(apiKey, id, await listarSns(apiKey, id, 'update_time', desde, t), prazo);
      if (r.completo) cursor.ate_update = t;
      return r.n;
    },
    async bloco(apiKey, id, de, ate, prazo) { return gravarPedidos(apiKey, id, await listarSns(apiKey, id, 'create_time', de, ate), prazo); },
    ads: gravarAds,
  },
  ml: {
    // O conector filtra por data da VENDA: relê ontem e hoje a cada rodada;
    // cancelamento de venda mais antiga é pego pela reconferência diária dos 45 dias.
    async incremental(apiKey, id, cursor, t, prazo) { return (await gravarPedidosML(apiKey, id, dataBR(t - DIA), dataBR(t), prazo)).n; },
    async bloco(apiKey, id, de, ate, prazo) { return gravarPedidosML(apiKey, id, dataBR(de), dataBR(ate), prazo); },
    ads: gravarAdsML,
  },
};

async function salvarEstado(mkt, conta, recurso, campos) {
  await sbUpsert('glr_sync_estado', [{ marketplace: mkt, conta_id: conta, recurso, ultima_tentativa: new Date().toISOString(), ...campos }], 'marketplace,conta_id,recurso');
}

// ── Uma conta por rodada:
//  1) incremental por data de ATUALIZAÇÃO (venda nova, cancelamento, devolução);
//  2) "fila de fundo" em blocos de 1 dia, com tempo máximo por loja: primeiro o
//     histórico de 90 dias (voltando), depois o reprocesso diário dos últimos
//     45 dias (rede de segurança). Cada dia concluído avança o cursor, então
//     loja grande progride aos poucos e nenhuma trava a fila das outras;
//  3) ADS por dia (90 dias na 1ª vez, depois os últimos 3).
async function sincronizarConta(apiKey, mkt, shopId, estadoAtual, prazo) {
  const ad = ADAPTADORES[mkt];
  const cursor = { ...(estadoAtual?.cursor || {}) };
  const t = agora();
  let gravados = 0;
  // Marca a tentativa já no início: a próxima rodada começa por quem está há
  // mais tempo sem ser visitado, mesmo que esta aqui seja cortada no meio.
  await salvarEstado(mkt, shopId, 'pedidos', {}).catch(() => {});
  try {
    gravados += await ad.incremental(apiKey, shopId, cursor, t, prazo);

    // Reprocesso diário: começa uma vez por dia, depois das 03:00 (Brasília).
    const hoje = dataBR(t);
    const horaBRT = new Date((t - 3 * 3600) * SEG).getUTCHours();
    if (horaBRT >= 3 && cursor.reproc_dia !== hoje) {
      cursor.reproc_dia = hoje;
      cursor.reproc_de = t - DIAS_REPROCESSAR * DIA;
      cursor.reproc_ate = t;
    }

    const prazoConta = Math.min(prazo, Date.now() + TEMPO_FUNDO_POR_CONTA_MS);
    const limite = t - DIAS_HISTORICO * DIA;
    while (Date.now() < prazoConta) {
      const histAte = cursor.historico_ate || t;
      let de, ate, tipo;
      if (histAte > limite) { de = Math.max(histAte - DIA, limite); ate = histAte - 1; tipo = 'hist'; }
      else if (cursor.reproc_de && cursor.reproc_de < cursor.reproc_ate) { de = cursor.reproc_de; ate = Math.min(de + DIA, cursor.reproc_ate) - 1; tipo = 'reproc'; }
      else break;
      const r = await ad.bloco(apiKey, shopId, de, ate, prazoConta);
      gravados += r.n;
      if (!r.completo) break; // o dia é refeito na próxima rodada (gravar de novo não duplica)
      if (tipo === 'hist') cursor.historico_ate = de;
      else {
        cursor.reproc_de = ate + 1;
        if (cursor.reproc_de >= cursor.reproc_ate) { delete cursor.reproc_de; delete cursor.reproc_ate; }
      }
    }
    await salvarEstado(mkt, shopId, 'pedidos', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, cursor, registros: gravados });
  } catch (e) {
    await salvarEstado(mkt, shopId, 'pedidos', { ultimo_erro: String(e.message || e).slice(0, 500), cursor }).catch(() => {});
  }

  // ADS é independente dos pedidos (loja autorizada só no app de Ads ainda tem ADS).
  if (Date.now() < prazo) {
    try {
      const estAds = estadoAtual?.ads || {};
      const de = estAds.ultimo_sucesso ? t - 3 * DIA : t - DIAS_HISTORICO * DIA;
      const n = await ad.ads(apiKey, shopId, de, t);
      await salvarEstado(mkt, shopId, 'ads', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: n });
    } catch (e) {
      await salvarEstado(mkt, shopId, 'ads', { ultimo_erro: String(e.message || e).slice(0, 500) }).catch(() => {});
    }
  }
  return { mkt, conta: shopId, pedidos: gravados };
}

async function executar(apiKey, soConta) {
  const prazo = Date.now() + ORCAMENTO_MS;
  let contas = await contasParaSincronizar(apiKey);
  if (soConta) contas = contas.filter(c => c.id === String(soConta));
  const estados = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,recurso,ultimo_sucesso,ultima_tentativa,cursor');
  const porConta = {};
  for (const e of estados) {
    const k = `${e.marketplace}:${e.conta_id}`;
    porConta[k] = porConta[k] || {};
    if (e.recurso === 'pedidos') Object.assign(porConta[k], e);
    if (e.recurso === 'ads') porConta[k].ads = e;
  }
  const chave = c => `${c.mkt}:${c.id}`;
  // Fila justa: quem foi visitado há mais tempo (ou nunca) vai primeiro; o que
  // não couber nesta rodada fica para a próxima, 15 min depois.
  contas.sort((a, b) => String(porConta[chave(a)]?.ultima_tentativa || '').localeCompare(String(porConta[chave(b)]?.ultima_tentativa || '')));
  const resultados = [];
  let i = 0;
  const trabalhador = async () => {
    while (i < contas.length && Date.now() < prazo - 45000) {
      const conta = contas[i++];
      resultados.push(await sincronizarConta(apiKey, conta.mkt, conta.id, porConta[chave(conta)], prazo));
    }
  };
  await Promise.all(Array.from({ length: CONCORRENCIA }, trabalhador));
  return { contas: contas.length, processadas: resultados.length, resultados };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey || !SUPABASE_KEY) return res.status(500).json({ error: 'MCP_API_KEY / SUPABASE_SERVICE_ROLE_KEY não configuradas' });

  // Só o agendador (token privado guardado no banco) dispara a sincronização.
  const token = String(req.headers['x-glr-sync-token'] || '');
  const esperado = (await sbSelect('glr_config_privada', 'chave=eq.sync_token&select=valor').catch(() => []))[0]?.valor;
  if (!token || !esperado || token !== esperado) return res.status(401).json({ error: 'não autorizado' });

  const { modo = 'incremental', conta = null } = req.body || {};
  // O reprocesso diário agora roda dentro das rodadas de 15 min (aos poucos,
  // por loja). A chamada noturna antiga cai no mesmo horário de uma rodada
  // normal — se rodasse junto, as duas disputariam as mesmas lojas.
  if (modo === 'reprocessar') return res.status(202).json({ ok: true, modo, aviso: 'reprocesso agora acontece nas rodadas de 15 min' });
  // Responde já (o pg_net só espera 5 s) e continua trabalhando em segundo plano.
  waitUntil(executar(apiKey, conta)
    .then(r => console.log('[sync-dados]', modo, JSON.stringify({ contas: r.contas, processadas: r.processadas })))
    .catch(e => console.error('[sync-dados] falhou', e)));
  return res.status(202).json({ ok: true, modo });
};
