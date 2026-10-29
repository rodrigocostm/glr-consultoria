// ============================================================
// GLR Consultoria — Motor de sincronização de dados (Shopee, Mercado Livre, Amazon, TikTok Shop, Magalu e Shein)
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
const { AGENDA_AGENTE, agoraBRT } = require('./_agenda-agente');
const consumo = require('./_consumo');
// Agentes de Estoque e de Margem por produto (mural que os agentes de ADS leem)
const estoqueMargem = require('./_estoque-margem');
const SINAIS_A_CADA_MS = 3 * 3600 * 1000;
// Agente de Promoções (1x por dia por loja, em cima do mural de Estoque e Margem)
const promocoesAg = require('./_promocoes');
const funilAg = require('./_funil');
// Agente de Reputação e Atendimento (a cada 30 min por loja; métricas da conta a cada 6 h)
const reputacaoAg = require('./_reputacao');
const REPUTACAO_A_CADA_MS = 60 * 60 * 1000; // era 30 min — 1.571 chamadas/dia de cada ação (medidor de 28/10)
// Taxas reais (líquido ML / acerto TikTok / escrow): quando a rodada anterior não
// conseguiu nenhum pedido novo (o marketplace ainda não liberou), espera 2 h —
// antes perguntava os mesmos pedidos a cada 15 min (38 mil chamadas/dia só no ML)
const TAXAS_ESPERA_MS = 2 * 3600 * 1000;
const GMV_RECENTE_A_CADA_MS = 2 * 3600 * 1000; // GMV Max dos últimos dias (17 mil chamadas/dia a cada 15 min)
// Agente de Qualidade de Anúncio (1x por dia por loja, depois das 06:00)
const qualidadeAg = require('./_qualidade');

// Dispara a rodada do Agente nos horários da agenda (o próprio agente trava
// pelo horário, então disparo repetido não roda duas vezes).
async function dispararAgente(req, tipo) {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'consultoriaglr.com.br';
    const headers = process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {};
    const r = await fetch(`https://${host}/api/agente-cron?rodada=${tipo}`, { headers, signal: AbortSignal.timeout(25000) });
    console.log('[sync-dados] agente', tipo, r.status, await r.text().catch(() => ''));
  } catch (e) { console.warn('[sync-dados] não consegui disparar o agente:', e.message); }
}

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORCAMENTO_MS = 270000;     // dentro do maxDuration (300s)
const CONCORRENCIA = 10;         // lojas em paralelo (dentro da loja é sequencial)
const DIAS_HISTORICO = 90;       // histórico inicial carregado aos poucos
const DIAS_REPROCESSAR = 45;     // rede de segurança diária (cancelamento/devolução tardia)
const TEMPO_FUNDO_POR_CONTA_MS = 60000; // histórico/reprocesso: no máx. 1 min por loja por rodada
const TEMPO_TAXAS_POR_CONTA_MS = 25000; // taxas reais por pedido: no máx. 25 s por loja por rodada
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
  // Cota do plano estourou nesta rodada: não gasta mais chamada até a próxima
  if (consumo.limiteAtingido()) throw new Error('Limite diário do plano atingido (Tiops) — aguardando renovação às 21h');
  consumo.contar(action);
  const r = await fetch('https://mcp.tiops.com.br', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ action, params: params || {} }),
  });
  const json = await r.json();
  if (!r.ok || (json.status && json.status !== 200) || (json.error && String(json.error).trim())) {
    if (json.code === 'PLAN_LIMIT_REACHED' || consumo.ehLimite(json.error)) consumo.marcarLimite();
    throw new Error(json.error || json.message || `Erro na ação ${action}`);
  }
  return json;
}
async function comRetry(fn, tentativas = 3) {
  let erro;
  for (let t = 0; t < tentativas; t++) {
    try { return await fn(); } catch (e) { erro = e; if (consumo.limiteAtingido()) break; await new Promise(r => setTimeout(r, 800 * (t + 1))); }
  }
  throw erro;
}

const agora = () => Math.floor(Date.now() / SEG);
// Dias (de venda, horário de Brasília) que mudaram nesta rodada, por loja —
// só eles têm o resumo diário recalculado.
const TOCADOS = new Map();
const diaBRTdeISO = iso => new Date(new Date(iso).getTime() - 3 * 3600 * SEG).toISOString().slice(0, 10);
function tocar(mkt, conta, iso) {
  if (!iso) return;
  const k = `${mkt}:${conta}`;
  if (!TOCADOS.has(k)) TOCADOS.set(k, new Set());
  TOCADOS.get(k).add(diaBRTdeISO(iso));
}
const isoDeUnix = s => new Date(s * SEG).toISOString();
const r2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const ddmmyyyy = unix => { const d = new Date((unix - 3 * 3600) * SEG); const p = n => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`; };
const dataBR = unix => { const d = new Date((unix - 3 * 3600) * SEG); const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; };

// ── Contas a sincronizar: TODAS as lojas Shopee e Mercado Livre conectadas
//    no conector + as vinculadas a clientes + as do piloto do Agente ──
const MKT = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : m === 'amazon' ? 'amazon' : ['tiktok', 'tiktok_shop', 'tiktokshop'].includes(m) ? 'tiktok' : m === 'magalu' ? 'magalu' : m === 'shein' ? 'shein' : null; };
async function contasParaSincronizar(apiKey) {
  const chaves = new Map(); // "mkt:id" → { mkt, id }
  const add = (m, id) => { const mkt = MKT(m); if (mkt && id) chaves.set(`${mkt}:${id}`, { mkt, id: String(id) }); };
  try {
    const r = await comRetry(() => mcpCall(apiKey, 'list_accounts', {}));
    for (const c of (r.data?.accounts || r.accounts || [])) add(c.marketplace, c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.param_to_use?.amazon_account_id || c.param_to_use?.magalu_account_id || c.param_to_use?.shein_supplier_id || c.external_id);
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
    if (linhas.length) {
      // Devolução aceita vem de outra lista (get_return_list) e o pedido segue
      // COMPLETED — não deixa a releitura do pedido desfazer a marcação.
      const dev = await sbSelect('glr_pedidos', `marketplace=eq.shopee&conta_id=eq.${shopId}&situacao=eq.devolvido&pedido_id=in.(${linhas.map(l => l.pedido_id).join(',')})&select=pedido_id`).catch(() => []);
      const devSet = new Set(dev.map(d => d.pedido_id));
      for (const l of linhas) { if (devSet.has(l.pedido_id) && l.situacao === 'valido') l.situacao = 'devolvido'; tocar('shopee', shopId, l.criado_em); }
      await sbUpsert('glr_pedidos', linhas, 'marketplace,conta_id,pedido_id');
    }
    n += linhas.length;
  }
  return { n, completo: true };
}

// ── Shopee ADS por dia ─────────────────────────────────────────────────────
// Dois tipos de campanha na Shopee:
//   • anúncios em grupo / individuais (inclusive os "GMV Max - Meta de ROAS"
//     por produto) — o agente gerencia campanha por campanha;
//   • GMV Max da Loja — campanha única que anuncia os produtos da loja que NÃO
//     estão nas individuais (manutenção do resto do catálogo).
// shopee_ads_daily_performance JÁ SOMA OS DOIS (conferido em 14/10/2026 na Mega
// Fácil, 01–10/10: 160 campanhas R$ 15.628,81 + GMV Max da Loja R$ 4.630,71 =
// R$ 20.259,53 do total diário). Então o total do dia é gravado como vem; o
// GMV Max da Loja é guardado à parte (cursor.gmv_max / gmv_max_vendas) só para
// separar "individuais" de "loja" nas análises — nunca somado de novo.
const inicioDiaUnix = unix => Math.floor((unix - 3 * 3600) / DIA) * DIA + 3 * 3600; // 00:00 de Brasília
async function gmvMaxDia(apiKey, shopId, diaUnix) {
  const d = ddmmyyyy(diaUnix);
  const r = await comRetry(() => mcpCall(apiKey, 'shopee_ads_gms_performance', { shopId, start_date: d, end_date: d }));
  const resp = r.data?.response || r.response || {};
  const rep = resp.report;
  if (!resp.campaign_id || !rep) return null; // loja sem GMV Max da Loja
  return { gasto: r2(rep.expense), gmv: r2(rep.broad_gmv), campanha: resp.campaign_id };
}
// Total do dia (os dois tipos), direto da Shopee — até 30 dias por chamada.
async function gravarTotaisAdsShopee(apiKey, shopId, de, ate) {
  let n = 0;
  for (let ini = de; ini <= ate; ini += 30 * DIA) {
    const fim = Math.min(ini + 29 * DIA, ate);
    const r = await comRetry(() => mcpCall(apiKey, 'shopee_ads_daily_performance', { shopId, start_date: ddmmyyyy(ini), end_date: ddmmyyyy(fim) }));
    const porDia = {};
    for (let u = ini; u <= fim; u += DIA) porDia[dataBR(u)] = { marketplace: 'shopee', conta_id: String(shopId), data: dataBR(u), gasto: 0, gmv_ads: 0, pedidos_ads: 0, impressoes: 0, cliques: 0 };
    for (const d of (r.data?.response || r.response || [])) {
      const [dd, mm, aa] = String(d.date || '').split('-');
      const l = porDia[`${aa}-${mm}-${dd}`];
      if (!l) continue;
      l.gasto = r2(d.expense); l.gmv_ads = r2(d.broad_gmv); l.pedidos_ads = parseInt(d.broad_order) || 0; l.impressoes = parseInt(d.impression) || 0; l.cliques = parseInt(d.clicks) || 0;
    }
    const linhas = Object.values(porDia).map(l => ({ ...l, sincronizado_em: new Date().toISOString() }));
    if (linhas.length) await sbUpsert('glr_ads_diario', linhas, 'marketplace,conta_id,data');
    n += linhas.length;
  }
  return n;
}
// Cada rodada: totais dos últimos 3 dias + GMV Max da Loja dia a dia (à parte).
// versão 2 (14/10/2026): regrava os 90 dias de uma vez — a versão anterior
// somava o GMV Max da Loja por cima do total (contava duas vezes).
async function gravarAdsShopee(apiKey, shopId, estAds, t, prazo) {
  const cursor = { ...(estAds?.cursor || {}) };
  const hoje0 = inicioDiaUnix(t);
  const limite = hoje0 - DIAS_HISTORICO * DIA;
  let n = 0;
  if (cursor.versao !== 2) {
    n += await gravarTotaisAdsShopee(apiKey, shopId, limite, hoje0);
    cursor.versao = 2; cursor.hist_ate = limite;
    cursor.gmv_max = {}; cursor.gmv_max_vendas = {}; delete cursor.gmv_hist_ate;
  } else {
    n += await gravarTotaisAdsShopee(apiKey, shopId, hoje0 - 2 * DIA, hoje0);
  }
  // GMV Max da Loja à parte: tem? (confere 1x/dia) → últimos 3 dias + 10 dias de histórico por rodada
  if (cursor.gmv_verificado !== dataBR(t)) {
    cursor.tem_gmv_max = !!(await gmvMaxDia(apiKey, shopId, hoje0 - DIA).catch(() => null));
    cursor.gmv_verificado = dataBR(t);
  }
  const gmvRecente = !cursor.gmv_rec_em || Date.now() - cursor.gmv_rec_em > GMV_RECENTE_A_CADA_MS;
  if (cursor.tem_gmv_max && (gmvRecente || (cursor.gmv_hist_ate || hoje0) > limite)) {
    const gasto = { ...(cursor.gmv_max || {}) }, vendas = { ...(cursor.gmv_max_vendas || {}) };
    const dias = gmvRecente ? [hoje0 - 2 * DIA, hoje0 - DIA, hoje0] : [];
    if (gmvRecente) cursor.gmv_rec_em = Date.now();
    const histAte = cursor.gmv_hist_ate || hoje0 - 2 * DIA;
    for (let u = histAte - DIA, k = 0; u >= limite && k < 10; u -= DIA, k++) dias.push(u);
    let menor = histAte;
    for (const u of dias) {
      if (Date.now() > prazo) break;
      const g = await gmvMaxDia(apiKey, shopId, u).catch(() => undefined);
      if (g === undefined) break;
      gasto[dataBR(u)] = g ? g.gasto : 0; vendas[dataBR(u)] = g ? g.gmv : 0;
      if (u < hoje0 - 2 * DIA) menor = Math.min(menor, u);
    }
    cursor.gmv_hist_ate = menor;
    const corte = dataBR(t - DIAS_RESUMO * DIA);
    for (const d of Object.keys(gasto)) if (d < corte) { delete gasto[d]; delete vendas[d]; }
    cursor.gmv_max = gasto; cursor.gmv_max_vendas = vendas;
  }
  return { n, cursor };
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
    valor_itens: r2(itens.reduce((s, i) => s + i.preco * i.qtd, 0)),
    // líquido e frete do vendedor vêm depois, do recebimento (/collections)
    taxas: { tarifa_venda: r2(itens.reduce((s, i) => s + i.tarifa_venda * i.qtd, 0)), pack_id: o.pack_id || null, payment_id: o.payments?.[0]?.id || null },
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
    linhas.forEach(l => tocar('ml', contaId, l.criado_em));
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

// ── Shopee: devoluções/reembolsos ACEITOS tiram o pedido do faturamento
//    válido (mesma regra do Dashboard). A lista é por data de atualização. ──
async function marcarDevolucoesShopee(apiKey, shopId, de, ate, prazo) {
  const sns = new Set();
  for (let ini = de; ini < ate; ini += 14 * DIA) {
    const fim = Math.min(ini + 14 * DIA, ate);
    for (let pagina = 1; pagina <= 20; pagina++) {
      if (Date.now() > prazo) return { n: 0, completo: false };
      const r = await comRetry(() => mcpCall(apiKey, 'shopee_get_return_list', { shopId, update_time_from: ini, update_time_to: fim, page_size: 50, page_no: pagina }));
      const resp = r.data?.response || r.response || {};
      for (const d of (resp.return || [])) if (d.status === 'ACCEPTED' && d.order_sn) sns.add(String(d.order_sn));
      if (!resp.more) break;
    }
  }
  if (!sns.size) return { n: 0, completo: true };
  const lista = [...sns];
  let n = 0;
  for (let i = 0; i < lista.length; i += 100) {
    const lote = lista.slice(i, i + 100);
    const rows = await sbSelect('glr_pedidos', `marketplace=eq.shopee&conta_id=eq.${shopId}&situacao=eq.valido&pedido_id=in.(${lote.join(',')})&select=marketplace,conta_id,pedido_id,criado_em,situacao,valor_bruto`);
    if (!rows.length) continue;
    rows.forEach(r => { r.situacao = 'devolvido'; tocar('shopee', shopId, r.criado_em); });
    await sbUpsert('glr_pedidos', rows, 'marketplace,conta_id,pedido_id');
    n += rows.length;
  }
  return { n, completo: true };
}

// ── Taxas reais por pedido (o que o Financeiro precisa) ──
// Shopee: escrow dos pedidos COMPLETED. Mesma interpretação da tela Financeiro:
// comissão e tarifa de serviço BRUTAS (batem com o escrow_amount), frete do
// vendedor = custo real − pago pelo comprador − subsídio da Shopee.
const ESCROW_USADOS = new Set(['actual_shipping_fee', 'buyer_paid_shipping_fee', 'shopee_shipping_rebate', 'net_commission_fee', 'commission_fee', 'net_service_fee', 'service_fee', 'seller_product_rebate', 'shopee_discount', 'escrow_amount', 'escrow_amount_after_adjustment', 'seller_transaction_fee', 'buyer_tax_amount', 'seller_coin_cash_back', 'shipping_seller_protection_fee_amount', 'voucher_from_shopee', 'credit_card_promotion_fee', 'credit_card_promotion', 'coins', 'shopee_coins_cash_back', 'buyer_total_amount', 'cost_of_goods_sold', 'original_cost_of_goods_sold', 'order_discounted_price', 'order_original_price', 'order_selling_price', 'original_price', 'original_shopee_discount', 'estimated_shipping_fee', 'remaining_voucher', 'net_commission_fee_info_list', 'net_service_fee_info_list', 'tenure_info_list', 'items', 'seller_voucher_code', 'buyer_payment_method', 'instalment_plan', 'final_shipping_fee', 'order_seller_discount', 'credit_card_transaction_fee',
  'order_chargeable_weight', 'final_height', 'final_width', 'final_length', 'order_sn', 'escrow_release_time', 'order_income_struct', 'is_paid_by_credit_card', 'shopee_voucher_code', 'reverse_shipping_fee_confirmed', 'tax_payment_method']);
function taxasDoEscrow(oi) {
  const n = v => parseFloat(v) || 0;
  const detalhes = {};
  const varrer = (obj, pre) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (ESCROW_USADOS.has(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) { varrer(v, pre ? `${pre}.${k}` : k); continue; }
      const num = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
      if (!isNaN(num) && Math.abs(num) > 0.001) detalhes[pre ? `${pre}.${k}` : k] = num;
    }
  };
  varrer(oi, '');
  return {
    liquido: n(oi.escrow_amount), comissao: n(oi.commission_fee), taxaServico: n(oi.service_fee),
    imposto: n(oi.seller_transaction_fee) + n(oi.buyer_tax_amount) + n(oi.seller_coin_cash_back),
    frete: Math.max(0, n(oi.actual_shipping_fee) - n(oi.buyer_paid_shipping_fee) - n(oi.shopee_shipping_rebate)) + n(oi.shipping_seller_protection_fee_amount),
    voucher: n(oi.voucher_from_shopee), rebate: n(oi.seller_product_rebate?.amount),
    taxaCartao: n(oi.credit_card_promotion), moedas: n(oi.coins) + n(oi.shopee_coins_cash_back),
    detalhes,
  };
}
const desdeTaxas = t => encodeURIComponent(new Date((t - 120 * DIA) * SEG).toISOString());
async function enriquecerTaxasShopee(apiKey, shopId, t, prazo) {
  const pend = await sbSelect('glr_pedidos', `marketplace=eq.shopee&conta_id=eq.${shopId}&status_original=eq.COMPLETED&liquido=is.null&criado_em=gte.${desdeTaxas(t)}&order=criado_em.desc&limit=300&select=marketplace,conta_id,pedido_id,criado_em,situacao,valor_bruto`);
  let n = 0;
  for (let i = 0; i < pend.length; i += 50) {
    if (Date.now() > prazo) break;
    const lote = pend.slice(i, i + 50);
    const r = await comRetry(() => mcpCall(apiKey, 'shopee_get_escrow_detail_batch', { shopId, order_sn_list: lote.map(p => p.pedido_id) }));
    const lista = r.data?.response?.result_list || r.response?.result_list || (Array.isArray(r.data?.response) ? r.data.response : null) || (Array.isArray(r.response) ? r.response : []);
    const porSn = {};
    for (const it of lista) {
      const sn = it.escrow_detail?.order_sn || it.order_sn;
      const oi = it.escrow_detail?.order_income || it.order_income;
      if (sn && oi) porSn[sn] = taxasDoEscrow(oi);
    }
    const linhas = lote.filter(p => porSn[p.pedido_id]?.liquido > 0).map(p => ({ ...p, liquido: r2(porSn[p.pedido_id].liquido), taxas: porSn[p.pedido_id] }));
    if (linhas.length) { await sbUpsert('glr_pedidos', linhas, 'marketplace,conta_id,pedido_id'); linhas.forEach(l => tocar('shopee', shopId, l.criado_em)); n += linhas.length; }
  }
  return n;
}
// ML: líquido recebido do pagamento (/collections). Frete do vendedor = o que
// sobra além da tarifa de venda (mesma conta da tela Financeiro).
async function enriquecerTaxasML(apiKey, contaId, t, prazo) {
  const pend = await sbSelect('glr_pedidos', `marketplace=eq.ml&conta_id=eq.${contaId}&situacao=eq.valido&status_original=eq.paid&liquido=is.null&criado_em=gte.${desdeTaxas(t)}&order=criado_em.desc&limit=80&select=marketplace,conta_id,pedido_id,criado_em,situacao,valor_bruto,taxas`);
  const linhas = [];
  let falhas = 0;
  for (const p of pend) {
    if (Date.now() > prazo || falhas >= 3) break;
    const pay = p.taxas?.payment_id;
    if (!pay) continue;
    try {
      const r = await mcpCall(apiKey, 'raw', { method: 'GET', path: `/collections/${pay}`, meliUserId: contaId });
      const d = r.data || r;
      const net = parseFloat(d.net_received_amount ?? d.collection?.net_received_amount);
      if (!isNaN(net) && net > 0) linhas.push({ marketplace: 'ml', conta_id: p.conta_id, pedido_id: p.pedido_id, criado_em: p.criado_em, situacao: p.situacao, valor_bruto: p.valor_bruto, liquido: r2(net), frete: r2(Math.max(0, p.valor_bruto - net - (parseFloat(p.taxas?.tarifa_venda) || 0))) });
    } catch (e) { falhas++; }
  }
  if (linhas.length) { await sbUpsert('glr_pedidos', linhas, 'marketplace,conta_id,pedido_id'); linhas.forEach(l => tocar('ml', contaId, l.criado_em)); }
  return linhas.length;
}

// ── Resumo diário por loja (fica no próprio glr_sync_estado, recurso
//    "resumo"): o Dashboard lê isso em vez de buscar pedido a pedido. ──
const DIAS_RESUMO = 100;
async function atualizarResumo(mkt, conta, resumoAtual, t) {
  const dias = { ...(resumoAtual?.cursor?.dias || {}) };
  const hoje = dataBR(t), ontem = dataBR(t - DIA);
  const tocados = new Set([...(TOCADOS.get(`${mkt}:${conta}`) || []), hoje, ontem]);
  const corte = dataBR(t - DIAS_RESUMO * DIA);
  for (const dia of [...tocados].filter(d => d >= corte).sort().slice(-(DIAS_RESUMO + 2))) {
    const de = new Date(`${dia}T00:00:00-03:00`).toISOString();
    const ate = new Date(new Date(`${dia}T00:00:00-03:00`).getTime() + DIA * SEG).toISOString();
    const rows = [];
    for (let off = 0; off < 20000; off += 1000) {
      const pg = await sbSelect('glr_pedidos', `marketplace=eq.${mkt}&conta_id=eq.${conta}&criado_em=gte.${encodeURIComponent(de)}&criado_em=lt.${encodeURIComponent(ate)}&select=situacao,valor_bruto,liquido,itens&limit=1000&offset=${off}`);
      rows.push(...pg);
      if (pg.length < 1000) break;
    }
    const v = rows.filter(r => r.situacao === 'valido');
    const soma = (rs, f) => r2(rs.reduce((s, r) => s + f(r), 0));
    const comLiq = v.filter(r => r.liquido != null);
    const res = {
      pedidos: v.length, faturamento: soma(v, r => parseFloat(r.valor_bruto) || 0),
      unidades: v.reduce((s, r) => s + (r.itens || []).reduce((a, i) => a + (parseInt(i.qtd) || 1), 0), 0),
      cancelados: rows.filter(r => r.situacao === 'cancelado').length, valor_cancelado: soma(rows.filter(r => r.situacao === 'cancelado'), r => parseFloat(r.valor_bruto) || 0),
      devolvidos: rows.filter(r => r.situacao === 'devolvido').length, valor_devolvido: soma(rows.filter(r => r.situacao === 'devolvido'), r => parseFloat(r.valor_bruto) || 0),
      liquido: soma(comLiq, r => parseFloat(r.liquido) || 0), com_liquido: comLiq.length,
    };
    if (rows.length) dias[dia] = { ...(dias[dia] || {}), ...res }; else if (dias[dia]) Object.assign(dias[dia], res);
  }
  // ADS do dia (já com GMV Max na Shopee) entra no mesmo resumo — TACOS sem consulta extra.
  const ads = await sbSelect('glr_ads_diario', `marketplace=eq.${mkt}&conta_id=eq.${conta}&data=gte.${corte}&select=data,gasto,gmv_ads&limit=200`).catch(() => null);
  if (ads) {
    const porDia = Object.fromEntries(ads.map(a => [a.data, a]));
    for (const d of new Set([...Object.keys(dias), ...Object.keys(porDia)])) {
      const a = porDia[d];
      if (!dias[d]) { if (!a || !(parseFloat(a.gasto) > 0)) continue; dias[d] = { pedidos: 0, faturamento: 0, unidades: 0, cancelados: 0, valor_cancelado: 0, devolvidos: 0, valor_devolvido: 0, liquido: 0, com_liquido: 0 }; }
      dias[d].ads = a ? r2(a.gasto) : 0;
      dias[d].ads_gmv = a ? r2(a.gmv_ads) : 0;
    }
  }
  for (const d of Object.keys(dias)) if (d < corte) delete dias[d];
  await salvarEstado(mkt, conta, 'resumo', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, cursor: { dias }, registros: Object.keys(dias).length });
}

// ── O que muda entre marketplaces fica aqui; o resto do motor é igual ──
// ── Oportunidades de ADS (1x por dia por loja) ─────────────────────────────
// Quais produtos estão no ADS e quais VENDEM FORA dele (últimos 30 dias da
// base). A aba Vendas → Oportunidades lê daqui na hora (sem botão) e os
// agentes usam o mesmo dado. ML: anúncio ativo em campanha de Product Ads +
// visitas de 30 dias dos candidatos. Shopee: produto em campanha individual
// ativa; se o GMV Max da Loja está ligado, o resto entra só por ele.
const DIAS_OPORT = 30;
async function atualizarOportunidades(apiKey, mkt, id, estAds, t, prazo) {
  const emAds = {};      // item_id → campaign_id
  const campanhas = {};  // campaign_id → nome
  if (mkt === 'shopee') {
    const r = await comRetry(() => mcpCall(apiKey, 'shopee_ads_campaigns', { shopId: id }));
    const ids = (r.data?.response?.campaign_list || r.response?.campaign_list || []).map(c => c.campaign_id);
    const lotes = [];
    for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
    for (let i = 0; i < lotes.length; i += 5) {
      if (Date.now() > prazo) return null; // não terminou: tenta na próxima rodada
      await Promise.all(lotes.slice(i, i + 5).map(async lote => {
        const rs = await comRetry(() => mcpCall(apiKey, 'shopee_ads_campaign_settings', { shopId: id, campaign_id_list: lote.join(',') }));
        for (const c of (rs.data?.response?.campaign_list || rs.response?.campaign_list || [])) {
          const ci = c.common_info || {};
          if (String(ci.campaign_status || '').toLowerCase() !== 'ongoing') continue;
          campanhas[c.campaign_id] = String(ci.ad_name || c.campaign_id).slice(0, 70);
          for (const it of (ci.item_id_list || [])) emAds[String(it)] = c.campaign_id;
        }
      }));
    }
  } else {
    let camps = [];
    try {
      for (let off = 0; off < 500; off += 50) {
        const r = await comRetry(() => mcpCall(apiKey, 'ml_ads_campaigns', { meliUserId: id, limit: 50, offset: off, status: 'ALL' }));
        const d = r.data || r, res = d.results || [];
        camps.push(...res);
        if (res.length < 50 || off + 50 >= (parseInt(d.paging?.total) || 0)) break;
      }
    } catch (e) {
      if (!/anunciante|advertiser|product ads|not found|no encontr|não encontr|404/i.test(e.message)) throw e;
      camps = []; // conta sem Product Ads: tudo está fora do ADS
    }
    const ate = dataBR(t), de = dataBR(t - 7 * DIA);
    for (const c of camps.filter(c => String(c.status).toLowerCase() === 'active')) {
      if (Date.now() > prazo) return null;
      campanhas[c.id] = String(c.name || c.id).trim().slice(0, 70);
      for (let off = 0; off < 1000; off += 100) {
        const r = await comRetry(() => mcpCall(apiKey, 'ml_ads_items', { meliUserId: id, campaign_id: String(c.id), date_from: de, date_to: ate, limit: 100, offset: off }));
        const d = r.data || r, res = d.results || [];
        for (const a of res) if (a.status === 'active') emAds[String(a.item_id)] = c.id;
        if (res.length < 100 || off + 100 >= (parseInt(d.paging?.total) || 0)) break;
      }
    }
  }
  // Vendas dos últimos 30 dias por produto (base)
  const desde = new Date((t - DIAS_OPORT * DIA) * SEG).toISOString();
  const vendas = new Map();
  for (let off = 0; off < 50000; off += 1000) {
    const rows = await sbSelect('glr_pedidos', `marketplace=eq.${mkt}&conta_id=eq.${encodeURIComponent(id)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(desde)}&select=itens&limit=1000&offset=${off}`);
    for (const p of rows) for (const it of (p.itens || [])) {
      if (!it.item_id) continue;
      const k = String(it.item_id), q = parseInt(it.qtd) || 1;
      const v = vendas.get(k) || { item_id: k, nome: String(it.nome || k).slice(0, 90), un: 0, rs: 0 };
      v.un += q; v.rs += (parseFloat(it.preco) || 0) * q;
      vendas.set(k, v);
    }
    if (rows.length < 1000) break;
  }
  const candidatos = [...vendas.values()].filter(v => !emAds[v.item_id] && v.un >= 2).sort((a, b) => b.rs - a.rs).slice(0, 40).map(v => ({ ...v, rs: r2(v.rs) }));
  // ML: visitas dos últimos 30 dias dos candidatos (1 chamada por anúncio)
  if (mkt === 'ml') {
    for (let i = 0; i < Math.min(30, candidatos.length); i += 5) {
      if (Date.now() > prazo) break;
      await Promise.all(candidatos.slice(i, i + 5).map(async v => {
        try {
          const r = await mcpCall(apiKey, 'raw', { method: 'GET', path: `/items/${v.item_id}/visits/time_window?last=${DIAS_OPORT}&unit=day`, meliUserId: id });
          const tv = parseInt((r.data || r).total_visits);
          if (!isNaN(tv)) v.visitas = tv;
        } catch (e) {}
      }));
    }
  }
  const vendidosEmAds = [...vendas.values()].filter(v => emAds[v.item_id]);
  return {
    dia: dataBR(t), gmv_loja: mkt === 'shopee' ? !!estAds?.cursor?.tem_gmv_max : null,
    n_campanhas: Object.keys(campanhas).length, n_em_ads: Object.keys(emAds).length,
    vendidos_30d: vendas.size, vendidos_em_ads: vendidosEmAds.length,
    rs_fora_ads: r2(candidatos.reduce((s, v) => s + v.rs, 0)),
    candidatos,
  };
}

// ── TikTok Shop: a busca já devolve o pedido inteiro (itens e pagamento) ──
//    valor = produtos − desconto do vendedor (o subsídio da plataforma é do
//    vendedor; frete do comprador fora — mesma regra de Shopee/ML).
//    UNPAID não entra; CANCELLED = cancelado.
function mapearPedidoTikTok(openId, o) {
  const pg = o.payment || {};
  const grupos = new Map();
  for (const li of (o.line_items || [])) { // a TikTok repete a linha por unidade
    const k = li.sku_id || li.product_id || li.id;
    const g = grupos.get(k) || { item_id: String(li.product_id || ''), sku: li.seller_sku || '', nome: li.product_name || '—', variacao: li.sku_name || '', qtd: 0, preco: r2((parseFloat(li.original_price) || 0) - (parseFloat(li.seller_discount) || 0)), imagem: li.sku_image || '' };
    g.qtd++; grupos.set(k, g);
  }
  const itens = [...grupos.values()];
  const somaItens = r2(itens.reduce((s, i) => s + i.preco * i.qtd, 0));
  const valor = pg.original_total_product_price != null ? r2((parseFloat(pg.original_total_product_price) || 0) - (parseFloat(pg.seller_discount) || 0)) : somaItens;
  const status = String(o.status || '').toUpperCase();
  return {
    marketplace: 'tiktok', conta_id: String(openId), pedido_id: String(o.id),
    criado_em: isoDeUnix(o.create_time), atualizado_mkt: o.update_time ? isoDeUnix(o.update_time) : null,
    status_original: o.status || '', situacao: status === 'CANCELLED' ? 'cancelado' : 'valido',
    valor_bruto: valor, valor_itens: somaItens, frete: null,
    // líquido e taxas NÃO vão aqui: vêm do acerto (enriquecerTaxasTikTok) e não podem ser apagados a cada atualização
    itens, sincronizado_em: new Date().toISOString(),
  };
}
async function gravarPedidosTikTok(apiKey, openId, filtro, prazo) {
  let n = 0, token = null;
  for (let pag = 0; pag < 300; pag++) {
    if (prazo && Date.now() > prazo) return { n, completo: false };
    const r = await comRetry(() => mcpCall(apiKey, 'tiktok_search_orders', { open_id: openId, page_size: 100, ...filtro, ...(token ? { page_token: token } : {}) }));
    const d = r.data?.orders ? r.data : r;
    const orders = d.orders || [];
    const linhas = orders.filter(o => o && o.id && o.create_time && String(o.status || '').toUpperCase() !== 'UNPAID').map(o => mapearPedidoTikTok(openId, o));
    if (linhas.length) {
      await sbUpsert('glr_pedidos', [...new Map(linhas.map(l => [l.pedido_id, l])).values()], 'marketplace,conta_id,pedido_id');
      linhas.forEach(l => tocar('tiktok', openId, l.criado_em));
    }
    n += linhas.length;
    token = d.next_page_token;
    if (!token || !orders.length) break;
  }
  return { n, completo: true };
}

// ── Amazon: a lista traz número, status, total e data; os itens (SKU, nome,
//    preço) vêm de amazon_get_order_items — buscados uma vez por pedido (a
//    Amazon limita as chamadas, então no máx. AMAZON_ITENS_POR_RODADA por loja).
//    valor = soma dos itens (sem frete); sem itens ainda, o total do pedido.
//    Pending (não pago) não entra; Canceled = cancelado.
const AMAZON_ITENS_POR_RODADA = 25;
// Guia da Tiops: com mais de uma conta Amazon, se a conta não for respeitada a
// API responde 200 com dado de OUTRA loja (falha silenciosa). Confere a conta
// que respondeu (conta_usada / selling_partner_id) antes de gravar qualquer coisa.
function conferirContaAmazon(r, accId) {
  const usada = r?.conta_usada?.amazon_account_id || r?.data?.conta_usada?.amazon_account_id || r?.selling_partner_id || r?.data?.selling_partner_id;
  if (usada && String(usada) !== String(accId)) throw new Error(`Amazon respondeu pela conta ${usada}, esperado ${accId} — nada gravado`);
  return r;
}
async function gravarPedidosAmazon(apiKey, accId, deUnix, ateUnix, prazo) {
  let n = 0, token = null, itensFeitos = 0;
  for (let pag = 0; pag < 100; pag++) {
    if (prazo && Date.now() > prazo) return { n, completo: false };
    const params = token ? { amazon_account_id: accId, next_token: token }
      : { amazon_account_id: accId, created_after: new Date(deUnix * SEG).toISOString(), created_before: new Date(Math.min(ateUnix, agora() - 130) * SEG).toISOString(), limit: 100 };
    const r = conferirContaAmazon(await comRetry(() => mcpCall(apiKey, 'amazon_list_orders', params)), accId);
    const d = r.data?.orders ? r.data : r;
    const orders = (d.orders || []).filter(o => o && o.amazon_order_id && o.purchase_date && !/^pending/i.test(o.status || ''));
    if (orders.length) {
      const ids = orders.map(o => `"${o.amazon_order_id}"`).join(',');
      const existentes = new Map((await sbSelect('glr_pedidos', `marketplace=eq.amazon&conta_id=eq.${encodeURIComponent(accId)}&pedido_id=in.(${encodeURIComponent(ids)})&select=pedido_id,itens,valor_bruto,valor_itens,situacao`)).map(x => [x.pedido_id, x]));
      const linhas = [];
      for (const o of orders) {
        const ant = existentes.get(o.amazon_order_id);
        const cancelado = /cancel/i.test(o.status || '');
        let itens = Array.isArray(ant?.itens) && ant.itens.length ? ant.itens : null;
        if (!itens && !cancelado && itensFeitos < AMAZON_ITENS_POR_RODADA && (!prazo || Date.now() < prazo)) {
          try {
            const ri = conferirContaAmazon(await comRetry(() => mcpCall(apiKey, 'amazon_get_order_items', { amazon_account_id: accId, order_id: o.amazon_order_id }), 2), accId);
            const lista = (ri.data?.items || ri.items || []);
            itens = lista.map(i => { const q = parseInt(i.quantity) || 1; return { item_id: i.asin || '', sku: i.seller_sku || '', nome: i.title || '—', qtd: q, preco: r2((parseFloat(i.price) || 0) / q) }; });
            itensFeitos++;
          } catch (e) { /* tenta de novo na próxima rodada */ }
        }
        const somaItens = itens ? r2(itens.reduce((s, i) => s + i.preco * i.qtd, 0)) : null;
        const valor = somaItens || r2(o.total) || r2(ant?.valor_bruto);
        linhas.push({
          marketplace: 'amazon', conta_id: String(accId), pedido_id: String(o.amazon_order_id),
          criado_em: new Date(o.purchase_date).toISOString(), atualizado_mkt: null,
          // reembolso marcado pelos eventos financeiros continua devolvido
          status_original: o.status || '', situacao: cancelado ? 'cancelado' : ant?.situacao === 'devolvido' ? 'devolvido' : 'valido',
          valor_bruto: valor, valor_itens: somaItens, frete: null,
          itens: itens || [], sincronizado_em: new Date().toISOString(),
        });
      }
      await sbUpsert('glr_pedidos', linhas, 'marketplace,conta_id,pedido_id');
      linhas.forEach(l => tocar('amazon', accId, l.criado_em));
      n += linhas.length;
    }
    token = d.next_token;
    if (!token || d.tem_mais === false) break;
  }
  return { n, completo: true };
}

// ── Magalu: o pedido vem inteiro (itens, frete, comissão), valores em centavos ──
//    valor = itens (preço × qtd) − desconto, sem frete; "new" (pagamento não
//    aprovado) não entra; cancelado/não aprovado = cancelado; com devolução = devolvido.
const centavos = o => (parseFloat(o?.value ?? o?.total) || 0) / (parseFloat(o?.normalizer) || 100);
function mapearPedidoMagalu(accId, o) {
  const dels = o.deliveries || [];
  const itens = dels.flatMap(d => (d.items || []).map(i => ({
    item_id: i.info?.id || '', sku: i.info?.sku || '', nome: i.info?.name || '—', qtd: parseInt(i.quantity) || 1,
    preco: r2(centavos(i.unit_price)), imagem: i.info?.images?.[0]?.url || '',
  })));
  const somaItens = r2(itens.reduce((s, i) => s + i.preco * i.qtd, 0));
  const valor = r2(Math.max(0, somaItens - centavos(o.amounts?.discount)));
  const comissao = r2(dels.reduce((s, d) => s + centavos(d.amounts?.commission), 0)) || r2(centavos(o.amounts?.commission));
  const st = String(o.status || '').toLowerCase();
  const devolvido = (o.returns || []).length > 0 || dels.some(d => (d.returns || []).length > 0);
  return {
    marketplace: 'magalu', conta_id: String(accId), pedido_id: String(o.code || o.id),
    criado_em: new Date(o.purchased_at || o.created_at).toISOString(), atualizado_mkt: o.updated_at ? new Date(o.updated_at).toISOString() : null,
    status_original: o.status || '', situacao: /cancel|unapproved/.test(st) ? 'cancelado' : devolvido ? 'devolvido' : 'valido',
    valor_bruto: valor, valor_itens: somaItens, frete: r2(centavos(o.amounts?.freight)),
    taxas: { tarifa_venda: comissao }, liquido: null, itens, sincronizado_em: new Date().toISOString(),
  };
}
async function gravarPedidosMagalu(apiKey, accId, filtro, prazo) {
  let n = 0, primeiroAnt = null;
  for (let off = 0; off < 20000; off += 50) {
    if (prazo && Date.now() > prazo) return { n, completo: false };
    const q = { magalu_account_id: accId, _limit: 50, _offset: off, ...filtro };
    const r = await comRetry(async () => {
      try { return await mcpCall(apiKey, 'magalu_list_orders', { magalu_account_id: accId, params: q }); }
      catch (e) { return await mcpCall(apiKey, 'magalu_list_orders', q); }
    });
    const d = r.data?.results ? r.data : r;
    const res = d.results || [];
    // a API às vezes ignora o _offset e devolve sempre a mesma página — sem isto
    // o laço ia até o fim do tempo (16 mil chamadas/dia para 2 lojas, medidor de 28/10)
    const primeiro = res[0] ? String(res[0].code || res[0].id) : null;
    if (off > 0 && primeiro && primeiro === primeiroAnt) break;
    primeiroAnt = primeiro;
    const linhas = res.filter(o => o && (o.code || o.id) && (o.purchased_at || o.created_at) && !/^new$|pending/i.test(o.status || '')).map(o => mapearPedidoMagalu(accId, o));
    if (linhas.length) {
      await sbUpsert('glr_pedidos', [...new Map(linhas.map(l => [l.pedido_id, l])).values()], 'marketplace,conta_id,pedido_id');
      linhas.forEach(l => tocar('magalu', accId, l.criado_em));
    }
    n += linhas.length;
    if (res.length < 50) break;
  }
  return { n, completo: true };
}

// ── Shein: a lista traz só o cabeçalho; item, valor e taxas vêm do detalhe
//    (lote de 20). Uma linha por unidade. Datas da Shein em UTC+8.
//    valor = preço com desconto; líquido = "estimatedIncome" da própria Shein.
//    Reembolsado antes do envio = cancelado; depois (ou recusado/danificado) = devolvido.
const isoShein = s => new Date(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')).toISOString();
const horaBR = unix => { const d = new Date((unix - 3 * 3600) * SEG); const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };
function mapearPedidoShein(supId, d) {
  const grupos = new Map();
  let comissao = 0, taxa = 0, liquido = 0;
  for (const g of (d.orderGoodsInfoList || [])) {
    const k = g.skuCode || g.sellerSku || g.goodsId;
    const x = grupos.get(k) || { item_id: String(g.skc || g.goodsSn || ''), sku: g.sellerSku || '', nome: g.goodsTitle || '—', qtd: 0, preco: r2(g.sellerCurrencyDiscountPrice ?? g.sellerCurrencyPrice), imagem: g.spuPicURL || '' };
    x.qtd++; grupos.set(k, x);
    comissao += parseFloat(g.commission) || 0; taxa += parseFloat(g.performanceServiceCharge) || 0; liquido += parseFloat(g.estimatedIncome) || 0;
  }
  const itens = [...grupos.values()];
  const valor = r2(itens.reduce((s, i) => s + i.preco * i.qtd, 0));
  const st = parseInt(d.orderStatus);
  const enviado = !!(d.sellerDeliveryTime || d.pickUpTime);
  return {
    marketplace: 'shein', conta_id: String(supId), pedido_id: String(d.orderNo),
    criado_em: isoShein(d.orderTime || d.addTime), atualizado_mkt: d.orderMsgUpdateTime ? isoShein(d.orderMsgUpdateTime) : null,
    status_original: String(d.orderStatus ?? ''), situacao: st === 6 ? (enviado ? 'devolvido' : 'cancelado') : (st === 8 || st === 9) ? 'devolvido' : 'valido',
    valor_bruto: valor, valor_itens: valor, frete: null,
    taxas: { comissao: r2(comissao), taxa_servico: r2(taxa) }, liquido: r2(liquido), itens, sincronizado_em: new Date().toISOString(),
  };
}
async function gravarPedidosShein(apiKey, supId, deUnix, ateUnix, porAtualizacao, prazo) {
  const r = await comRetry(() => mcpCall(apiKey, 'shein_order_list_range', { shein_supplier_id: supId, data_inicio: horaBR(deUnix), data_fim: horaBR(ateUnix), query_type: porAtualizacao ? 2 : 1, query_order_type: 4 }));
  const d = r.data?.pedidos ? r.data : r;
  const nums = [...new Set((d.pedidos || []).map(p => p.orderNo).filter(Boolean))];
  let n = 0;
  for (let i = 0; i < nums.length; i += 20) {
    if (prazo && Date.now() > prazo) return { n, completo: false };
    const rd = await comRetry(() => mcpCall(apiKey, 'shein_order_detail', { shein_supplier_id: supId, orderNoList: nums.slice(i, i + 20) }));
    const info = rd.data?.info || rd.info || [];
    const linhas = info.filter(x => x && x.orderNo && (x.orderTime || x.addTime)).map(x => mapearPedidoShein(supId, x));
    if (linhas.length) {
      await sbUpsert('glr_pedidos', linhas, 'marketplace,conta_id,pedido_id');
      linhas.forEach(l => tocar('shein', supId, l.criado_em));
    }
    n += linhas.length;
  }
  return { n, completo: true };
}

// ── Taxas reais do TikTok: acerto (settlement) por pedido entregue/concluído ──
//    líquido = settlement_amount; comissão = platform_commission; demais = fee − comissão.
async function enriquecerTaxasTikTok(apiKey, openId, t, prazo) {
  const pend = await sbSelect('glr_pedidos', `marketplace=eq.tiktok&conta_id=eq.${openId}&situacao=eq.valido&liquido=is.null&status_original=in.(COMPLETED,DELIVERED)&criado_em=gte.${desdeTaxas(t)}&order=criado_em.asc&limit=60&select=marketplace,conta_id,pedido_id,criado_em,situacao,valor_bruto`);
  const linhas = [];
  for (const p of pend) {
    if (Date.now() > prazo) break;
    try {
      const r = await mcpCall(apiKey, 'tiktok_finance_order_transactions', { open_id: openId, order_id: p.pedido_id });
      const tx = r.statement_transactions || r.data?.statement_transactions || [];
      if (!tx.length) continue; // ainda não acertado
      const soma = k => tx.reduce((s, x) => s + (parseFloat(x[k]) || 0), 0);
      const comissao = -soma('platform_commission_amount'), taxas = -soma('fee_amount');
      linhas.push({ ...p, liquido: r2(soma('settlement_amount')), taxas: { comissao: r2(comissao), taxa_servico: r2(taxas - comissao), frete_vendedor: r2(-soma('shipping_fee_amount') - soma('customer_shipping_fee_amount')) } });
    } catch (e) { /* tenta na próxima rodada */ }
  }
  if (linhas.length) { await sbUpsert('glr_pedidos', linhas, 'marketplace,conta_id,pedido_id'); linhas.forEach(l => tocar('tiktok', openId, l.criado_em)); }
  await estimarTaxas('tiktok', openId, t);
  return linhas.length;
}

// ── Taxas reais da Amazon: eventos financeiros por data de lançamento (janelas
//    de 7 dias, cursor fin_ate). Venda → líquido e comissão; reembolso → devolvido.
async function enriquecerTaxasAmazon(apiKey, accId, t, prazo, cursor) {
  // v2 (19/10/2026): passa a descontar o frete da etiqueta (MFNPostageFee) e a
  // gravar o ADS (cobranças de Product Ads) — relê os 90 dias uma vez
  if (!cursor.fin_v2) { delete cursor.fin_ate; cursor.fin_v2 = 1; }
  let feitos = 0;
  while (Date.now() < prazo) {
    // janelas de 7 dias começando à meia-noite (Brasília): os dias do ADS ficam inteiros
    const de = inicioDiaUnix(Math.max(cursor.fin_ate ? cursor.fin_ate - 2 * DIA : t - DIAS_HISTORICO * DIA, t - DIAS_HISTORICO * DIA));
    const ate = Math.min(de + 7 * DIA, t - 300);
    if (ate <= de) break;
    const vendas = new Map(), envio = new Map(), devolvidos = new Set(), ads = new Map();
    let token = null, completo = true;
    for (let pag = 0; pag < 50; pag++) {
      if (Date.now() > prazo) { completo = false; break; }
      const params = token ? { amazon_account_id: accId, next_token: token } : { amazon_account_id: accId, posted_after: new Date(de * SEG).toISOString(), posted_before: new Date(ate * SEG).toISOString(), max_results: 100 };
      const r = conferirContaAmazon(await comRetry(() => mcpCall(apiKey, 'amazon_list_financial_events', params), 2), accId);
      const d = r.data?.vendas ? r.data : r;
      for (const v of (d.vendas || [])) {
        const x = vendas.get(v.order_id) || { liq: 0, comissao: 0, outras: 0 };
        x.liq += parseFloat(v.liquido) || 0;
        for (const it of (v.itens || [])) for (const [k, val] of Object.entries(it.taxas || {})) { if (k === 'Commission') x.comissao -= parseFloat(val) || 0; else x.outras -= parseFloat(val) || 0; }
        for (const [, val] of Object.entries(v.taxas_pedido || {})) x.outras -= parseFloat(val) || 0;
        vendas.set(v.order_id, x);
      }
      // frete da etiqueta e outras taxas de serviço por pedido (envio próprio)
      for (const v of (d.taxas_servico || [])) {
        if (!v.order_id) continue;
        const soma = Object.values(v.taxas || {}).reduce((s, x) => s - (parseFloat(x) || 0), 0);
        if (soma) envio.set(v.order_id, (envio.get(v.order_id) || 0) + soma);
      }
      for (const v of (d.reembolsos || [])) devolvidos.add(v.order_id);
      // ADS: cobrança de Product Ads, no dia do lançamento
      for (const v of (d.publicidade || [])) {
        const dia = dataBR(Math.floor(Date.parse(v.posted) / SEG));
        ads.set(dia, (ads.get(dia) || 0) - (parseFloat(v.valor) || 0));
      }
      token = d.next_token;
      if (!token) break;
    }
    const ids = [...new Set([...vendas.keys(), ...envio.keys(), ...devolvidos])];
    for (let i = 0; i < ids.length; i += 50) {
      const lista = ids.slice(i, i + 50).map(id => `"${id}"`).join(',');
      const rows = await sbSelect('glr_pedidos', `marketplace=eq.amazon&conta_id=eq.${encodeURIComponent(accId)}&pedido_id=in.(${encodeURIComponent(lista)})&select=marketplace,conta_id,pedido_id,criado_em,situacao,valor_bruto,liquido,taxas`);
      // líquido = líquido da venda − frete da etiqueta (cada parte pode chegar numa janela diferente)
      const comLiq = rows.filter(r => vendas.has(r.pedido_id) || envio.has(r.pedido_id)).map(r => {
        const tx = r.taxas || {}, x = vendas.get(r.pedido_id);
        const liqVenda = x ? x.liq : (tx.liq_venda != null ? tx.liq_venda : (r.liquido != null ? parseFloat(r.liquido) + (parseFloat(tx.envio) || 0) : null));
        const env = envio.has(r.pedido_id) ? envio.get(r.pedido_id) : (parseFloat(tx.envio) || 0);
        const taxas = { comissao: r2(x ? x.comissao : tx.comissao), taxa_servico: r2(x ? x.outras : tx.taxa_servico), envio: r2(env), ...(liqVenda != null ? { liq_venda: r2(liqVenda) } : {}) };
        if (liqVenda == null && tx.tarifa_venda != null) Object.assign(taxas, { tarifa_venda: tx.tarifa_venda, estimado: tx.estimado, taxa_media: tx.taxa_media });
        const { taxas: _t, liquido: _l, ...base } = r;
        return { ...base, liquido: liqVenda != null ? r2(liqVenda - env) : null, taxas };
      });
      if (comLiq.length) await sbUpsert('glr_pedidos', comLiq, 'marketplace,conta_id,pedido_id');
      const dev = rows.filter(r => devolvidos.has(r.pedido_id) && r.situacao === 'valido').map(r => ({ marketplace: r.marketplace, conta_id: r.conta_id, pedido_id: r.pedido_id, criado_em: r.criado_em, situacao: 'devolvido', valor_bruto: r.valor_bruto }));
      if (dev.length) await sbUpsert('glr_pedidos', dev, 'marketplace,conta_id,pedido_id');
      [...comLiq, ...dev].forEach(l => tocar('amazon', accId, l.criado_em));
      feitos += comLiq.length + dev.length;
    }
    if (!completo) break;
    // ADS por dia: só dias inteiros dentro da janela (o de hoje fecha na próxima)
    const linhasAds = [];
    for (let u = de; u + DIA <= ate; u += DIA) {
      const dia = dataBR(u);
      linhasAds.push({ marketplace: 'amazon', conta_id: String(accId), data: dia, gasto: r2(ads.get(dia) || 0), gmv_ads: 0, pedidos_ads: 0, impressoes: 0, cliques: 0, sincronizado_em: new Date().toISOString() });
    }
    if (linhasAds.length) await sbUpsert('glr_ads_diario', linhasAds, 'marketplace,conta_id,data');
    cursor.fin_ate = ate;
    if (ate >= t - 300) {
      // em dia: o ADS da Amazon cobre os últimos 90 dias (cobranças de Product Ads)
      await salvarEstado('amazon', accId, 'ads', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: 0, cursor: { hist_ate: inicioDiaUnix(t) - DIAS_HISTORICO * DIA, fonte: 'cobrancas_product_ads' } }).catch(() => {});
      break;
    }
  }
  await estimarTaxas('amazon', accId, t);
  return feitos;
}

// Pedido ainda não acertado: taxa ESTIMADA pela média real da própria conta
// (últimos 60 dias acertados) — grava taxas.tarifa_venda, as telas usam como
// líquido = valor − tarifa até chegar o valor real.
async function estimarTaxas(mkt, conta, t) {
  const c = encodeURIComponent(conta);
  const desde = encodeURIComponent(new Date((t - 60 * DIA) * SEG).toISOString());
  const ok = await sbSelect('glr_pedidos', `marketplace=eq.${mkt}&conta_id=eq.${c}&situacao=eq.valido&liquido=not.is.null&criado_em=gte.${desde}&select=valor_bruto,liquido&limit=500`);
  const sv = ok.reduce((s, r) => s + (parseFloat(r.valor_bruto) || 0), 0), sl = ok.reduce((s, r) => s + (parseFloat(r.liquido) || 0), 0);
  if (ok.length < 5 || sv <= 0) return;
  const taxa = Math.min(0.6, Math.max(0, 1 - sl / sv));
  const pend = await sbSelect('glr_pedidos', `marketplace=eq.${mkt}&conta_id=eq.${c}&situacao=eq.valido&liquido=is.null&taxas->>tarifa_venda=is.null&criado_em=gte.${desdeTaxas(t)}&select=marketplace,conta_id,pedido_id,criado_em,situacao,valor_bruto&limit=1000`);
  if (!pend.length) return;
  await sbUpsert('glr_pedidos', pend.map(p => ({ ...p, taxas: { tarifa_venda: r2((parseFloat(p.valor_bruto) || 0) * taxa), estimado: true, taxa_media: Math.round(taxa * 10000) / 100 } })), 'marketplace,conta_id,pedido_id');
}

// ── Monitor de preços do ML ──
// O ML não guarda histórico de preço do anúncio. A cada 4 h tira uma "foto" dos
// anúncios ativos (preço, categoria, tipo, frete, foto) e registra no histórico
// `h` só quando o preço muda: [[unix, preço], ...] (últimas 20 mudanças).
// Fica em glr_sync_estado (recurso 'precos'); a tela Monitor de preços lê dali.
const PRECOS_A_CADA_MS = 4 * 3600 * 1000;
async function atualizarPrecosML(apiKey, contaId, prazo) {
  const ant = (await sbSelect('glr_sync_estado', `marketplace=eq.ml&conta_id=eq.${contaId}&recurso=eq.precos&select=cursor`).catch(() => []))[0]?.cursor || {};
  const itensAnt = ant.itens || {};
  const t = agora(), itens = {};
  const guardar = b => {
    if (!b?.id || b.price == null) return;
    const p = r2(b.price), velho = itensAnt[b.id];
    const h = Array.isArray(velho?.h) ? velho.h.slice(-19) : [];
    if (!h.length || Math.abs(h[h.length - 1][1] - p) >= 0.01) h.push([t, p]);
    itens[b.id] = { t: String(b.title || '').slice(0, 90), p, c: b.category_id || null, l: b.listing_type_id || null,
      me: b.shipping?.mode === 'me2' ? 1 : 0, th: String(b.thumbnail || '').replace(/^http:/, 'https:'), v: parseInt(b.sold_quantity) || 0, h };
  };
  const pagina = async params => {
    if (Date.now() > prazo) throw new Error('PRAZO');
    const r = await comRetry(() => mcpCall(apiKey, 'list_items', { meliUserId: contaId, status: 'active', limit: 100, ...params }));
    const d = r.data?.results ? r.data : r;
    (d.results || []).forEach(e => guardar(e?.body || e));
    return d;
  };
  try {
    const p1 = await pagina({ offset: 0 });
    const total = parseInt(p1.paging?.total) || 0;
    if (total <= 1050) {
      // até 1.050 anúncios o ML aceita offset
      for (let off = 100; off < total; off += 100) { const d = await pagina({ offset: off }); if (!(d.results || []).length) break; }
    } else {
      // acima disso só no modo scan (scroll_id), recomeçando do zero
      Object.keys(itens).forEach(k => delete itens[k]);
      let d = await pagina({ search_type: 'scan' });
      for (let i = 0; i < 200 && d.scroll_id && (d.results || []).length; i++) d = await pagina({ scroll_id: d.scroll_id });
    }
  } catch (e) {
    if (e.message === 'PRAZO') return null; // não terminou: tenta na próxima rodada (não grava foto pela metade)
    throw e;
  }
  return { em: Date.now(), itens };
}

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
    async devolucoes(apiKey, id, cursor, t, prazo) {
      const de = Math.max((cursor.dev_ate || t - DIAS_HISTORICO * DIA) - 600, t - DIAS_HISTORICO * DIA);
      const r = await marcarDevolucoesShopee(apiKey, id, de, t, prazo);
      if (r.completo) cursor.dev_ate = t;
      return r.n;
    },
    taxas: enriquecerTaxasShopee,
    adsCompleto: gravarAdsShopee,
    ads: gravarAds,
  },
  ml: {
    // O conector filtra por data da VENDA: relê ontem e hoje a cada rodada;
    // cancelamento de venda mais antiga é pego pela reconferência diária dos 45 dias.
    async incremental(apiKey, id, cursor, t, prazo) { return (await gravarPedidosML(apiKey, id, dataBR(t - DIA), dataBR(t), prazo)).n; },
    async bloco(apiKey, id, de, ate, prazo) { return gravarPedidosML(apiKey, id, dataBR(de), dataBR(ate), prazo); },
    taxas: enriquecerTaxasML,
    ads: gravarAdsML,
  },
  tiktok: {
    // Por data de ATUALIZAÇÃO (pega cancelamento de venda antiga também)
    async incremental(apiKey, id, cursor, t, prazo) {
      const desde = Math.max((cursor.ate_update || t - 2 * DIA) - 600, t - 14 * DIA);
      const r = await gravarPedidosTikTok(apiKey, id, { update_time_ge: desde }, prazo);
      if (r.completo) cursor.ate_update = t;
      return r.n;
    },
    async bloco(apiKey, id, de, ate, prazo) { return gravarPedidosTikTok(apiKey, id, { create_time_ge: de, create_time_lt: ate + 1 }, prazo); },
    taxas: enriquecerTaxasTikTok,
  },
  amazon: {
    // A Amazon filtra só por data da compra: relê os 2 últimos dias a cada rodada;
    // cancelamento mais antigo entra na reconferência diária dos 45 dias.
    async incremental(apiKey, id, cursor, t, prazo) { return (await gravarPedidosAmazon(apiKey, id, t - 2 * DIA, t, prazo)).n; },
    async bloco(apiKey, id, de, ate, prazo) { return gravarPedidosAmazon(apiKey, id, de, ate, prazo); },
    taxas: enriquecerTaxasAmazon,
    blocoDias: 7, // a Amazon limita a listagem — blocos maiores, menos chamadas
  },
  magalu: {
    async incremental(apiKey, id, cursor, t, prazo) {
      const desde = Math.max((cursor.ate_update || t - 2 * DIA) - 600, t - 14 * DIA);
      const r = await gravarPedidosMagalu(apiKey, id, { updated_at__gte: new Date(desde * SEG).toISOString() }, prazo);
      if (r.completo) cursor.ate_update = t;
      return r.n;
    },
    async bloco(apiKey, id, de, ate, prazo) { return gravarPedidosMagalu(apiKey, id, { purchased_at__gte: new Date(de * SEG).toISOString(), purchased_at__lte: new Date(ate * SEG).toISOString() }, prazo); },
    blocoDias: 3,
  },
  shein: {
    async incremental(apiKey, id, cursor, t, prazo) {
      const desde = Math.max((cursor.ate_update || t - 2 * DIA) - 600, t - 14 * DIA);
      const r = await gravarPedidosShein(apiKey, id, desde, t, true, prazo);
      if (r.completo) cursor.ate_update = t;
      return r.n;
    },
    async bloco(apiKey, id, de, ate, prazo) { return gravarPedidosShein(apiKey, id, de, ate, false, prazo); },
    blocoDias: 3,
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
  TOCADOS.delete(`${mkt}:${shopId}`);
  // Marca a tentativa já no início: a próxima rodada começa por quem está há
  // mais tempo sem ser visitado, mesmo que esta aqui seja cortada no meio.
  await salvarEstado(mkt, shopId, 'pedidos', {}).catch(() => {});
  try {
    gravados += await ad.incremental(apiKey, shopId, cursor, t, prazo);
    if (ad.devolucoes) {
      try { await ad.devolucoes(apiKey, shopId, cursor, t, prazo); }
      catch (e) { console.warn('[sync-dados] devoluções', mkt, shopId, e.message); }
    }

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
      const passo = (ad.blocoDias || 1) * DIA;
      if (histAte > limite) { de = Math.max(histAte - passo, limite); ate = histAte - 1; tipo = 'hist'; }
      else if (cursor.reproc_de && cursor.reproc_de < cursor.reproc_ate) { de = cursor.reproc_de; ate = Math.min(de + passo, cursor.reproc_ate) - 1; tipo = 'reproc'; }
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
    // Taxas reais (escrow Shopee / recebimento ML) dos pedidos que ainda não têm.
    const taxasNaVez = !cursor.taxas_em || cursor.taxas_ult > 0 || Date.now() - cursor.taxas_em > TAXAS_ESPERA_MS;
    if (ad.taxas && Date.now() < prazo && taxasNaVez) {
      try { cursor.taxas_ult = await ad.taxas(apiKey, shopId, t, Math.min(prazo, Date.now() + TEMPO_TAXAS_POR_CONTA_MS), cursor); cursor.taxas_em = Date.now(); delete cursor.taxas_erro; }
      catch (e) { cursor.taxas_erro = String(e.message || e).slice(0, 200); }
    }
    await salvarEstado(mkt, shopId, 'pedidos', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, cursor, registros: gravados });
  } catch (e) {
    await salvarEstado(mkt, shopId, 'pedidos', { ultimo_erro: String(e.message || e).slice(0, 500), cursor }).catch(() => {});
  }

  // ADS é independente dos pedidos (loja autorizada só no app de Ads ainda tem ADS).
  // Amazon, TikTok, Magalu e Shein: ainda sem ADS na base.
  if (Date.now() < prazo && (ad.ads || ad.adsCompleto)) {
    try {
      const estAds = estadoAtual?.ads || {};
      if (ad.adsCompleto) {
        const r = await ad.adsCompleto(apiKey, shopId, estAds, t, prazo);
        await salvarEstado(mkt, shopId, 'ads', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: r.n, cursor: r.cursor });
      } else {
        const de = estAds.ultimo_sucesso ? t - 3 * DIA : t - DIAS_HISTORICO * DIA;
        const n = await ad.ads(apiKey, shopId, de, t);
        // ML grava os 90 dias de uma vez na 1ª rodada — histórico de ADS completo desde então
        await salvarEstado(mkt, shopId, 'ads', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: n, cursor: { hist_ate: estAds.cursor?.hist_ate || inicioDiaUnix(t) - DIAS_HISTORICO * DIA } });
      }
    } catch (e) {
      await salvarEstado(mkt, shopId, 'ads', { ultimo_erro: String(e.message || e).slice(0, 500) }).catch(() => {});
    }
  }
  // Monitor de preços do ML — foto dos preços a cada 4 h, registrando o que mudou
  if (mkt === 'ml' && Date.now() - (estadoAtual?.precosEm || 0) > PRECOS_A_CADA_MS && Date.now() < prazo - 30000) {
    try {
      const cur = await atualizarPrecosML(apiKey, shopId, Math.min(prazo - 15000, Date.now() + 45000));
      if (cur) await salvarEstado('ml', shopId, 'precos', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: Object.keys(cur.itens).length, cursor: cur });
    } catch (e) { await salvarEstado('ml', shopId, 'precos', { ultimo_erro: String(e.message || e).slice(0, 300) }).catch(() => {}); }
  }
  // Oportunidades de ADS — 1x por dia por loja, depois das 06:00 (Brasília), se sobrar tempo
  const horaOp = new Date((t - 3 * 3600) * SEG).getUTCHours();
  if ((mkt === 'shopee' || mkt === 'ml') && horaOp >= 6 && estadoAtual?.oport?.dia !== dataBR(t) && Date.now() < prazo - 20000) {
    try {
      const cur = await atualizarOportunidades(apiKey, mkt, shopId, estadoAtual?.ads, t, Math.min(prazo, Date.now() + 40000));
      if (cur) await salvarEstado(mkt, shopId, 'oportunidades', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: cur.candidatos.length, cursor: cur });
    } catch (e) {
      await salvarEstado(mkt, shopId, 'oportunidades', { ultimo_erro: String(e.message || e).slice(0, 300) }).catch(() => {});
    }
  }
  // Estoque e margem por produto — a cada 3 h e sempre antes da revisão das 07:00
  let sinaisAgora = null;
  if ((mkt === 'shopee' || mkt === 'ml') && Date.now() < prazo - 25000) {
    const ultimo = estadoAtual?.sinaisEm || 0;
    const horaBRT = new Date((t - 3 * 3600) * SEG).getUTCHours();
    const inicioDia6h = Date.UTC(...dataBR(t).split('-').map((v, i) => i === 1 ? v - 1 : +v)) + 9 * 3600 * SEG; // 06:00 BRT de hoje
    if (Date.now() - ultimo > SINAIS_A_CADA_MS || (horaBRT === 6 && ultimo < inicioDia6h)) {
      try {
        const lerStorage = async chave => (await sbSelect('glr_storage', `chave=eq.${chave}&select=dados`).catch(() => []))[0]?.dados;
        const cur = await estoqueMargem.calcularSinais({ sbSelect, mcpCall, apiKey, lerStorage, prazo: Math.min(prazo - 10000, Date.now() + 50000) }, mkt, shopId);
        await salvarEstado(mkt, shopId, 'sinais', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: Object.keys(cur.itens).length, cursor: cur });
        sinaisAgora = cur;
      } catch (e) { await salvarEstado(mkt, shopId, 'sinais', { ultimo_erro: String(e.message || e).slice(0, 300) }).catch(() => {}); }
    }
  }
  // Funil (visitas por produto) — 1x por dia, depois das 05:00, antes da revisão das 07:00
  const horaFunil = new Date((t - 3 * 3600) * SEG).getUTCHours();
  if ((mkt === 'shopee' || mkt === 'ml') && horaFunil >= 5 && estadoAtual?.funilDia !== dataBR(t) && Date.now() < prazo - 25000) {
    try {
      // Shopee precisa das fotos anteriores (visitas acumuladas): lê o cursor de antes
      const anterior = mkt === 'shopee' ? (await sbSelect('glr_sync_estado', `marketplace=eq.${mkt}&conta_id=eq.${shopId}&recurso=eq.funil&select=cursor`).catch(() => []))[0]?.cursor : null;
      const cur = await funilAg.calcularFunil({ sbSelect, mcpCall, apiKey, prazo: Math.min(prazo - 10000, Date.now() + 40000) }, mkt, shopId, anterior);
      await salvarEstado(mkt, shopId, 'funil', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: Object.keys(cur.itens).length, cursor: cur });
    } catch (e) { await salvarEstado(mkt, shopId, 'funil', { ultimo_erro: String(e.message || e).slice(0, 300) }).catch(() => {}); }
  }
  // Promoções — 1x por dia, depois das 06:00, com o mural de Estoque e Margem já calculado
  const horaPromo = new Date((t - 3 * 3600) * SEG).getUTCHours();
  if ((mkt === 'shopee' || mkt === 'ml') && horaPromo >= 6 && estadoAtual?.promoDia !== dataBR(t) && Date.now() < prazo - 25000) {
    try {
      const sinais = sinaisAgora || (await sbSelect('glr_sync_estado', `marketplace=eq.${mkt}&conta_id=eq.${shopId}&recurso=eq.sinais&select=cursor`).catch(() => []))[0]?.cursor;
      if (sinais && Date.now() - (sinais.em || 0) < 12 * 3600 * SEG) {
        const cur = await promocoesAg.calcularPromocoes({ mcpCall, apiKey, prazo: Math.min(prazo - 10000, Date.now() + 40000) }, mkt, shopId, sinais);
        await salvarEstado(mkt, shopId, 'promocoes', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: cur.resumo.sugeridas, cursor: cur });
        // registro do dia (Escritório e históricos)
        const r = cur.resumo;
        await sbUpsert('glr_agente_log', [{ conta_id: String(shopId), tipo: 'sistema', origem: 'cron', resultado: 'executado',
          titulo: `Promoções do dia — ${r.sugeridas} sugestão(ões)`,
          explicacao: `Analisei ${r.analisados} produtos: ${r.sugeridas} promoção(ões) cabem na margem mínima de ${cur.margem_minima}%${r.parados ? ` (${r.parados} para girar estoque parado)` : ''}; ${r.emPromo} já estão em promoção${r.promoApertada ? `, ${r.promoApertada} com margem abaixo da mínima no preço da promoção` : ''}.`,
          dados: { agente: 'promocoes', marketplace: mkt, resumo: r, destaques: cur.destaques, colaboracoes: cur.colab.slice(0, 20) } }], 'id').catch(() => {});
      }
    } catch (e) { await salvarEstado(mkt, shopId, 'promocoes', { ultimo_erro: String(e.message || e).slice(0, 300) }).catch(() => {}); }
  }
  // Qualidade de anúncio — 1x por dia, depois das 06:00, com o mural de Estoque e Margem
  if ((mkt === 'shopee' || mkt === 'ml') && horaPromo >= 6 && estadoAtual?.qualDia !== dataBR(t) && Date.now() < prazo - 25000) {
    try {
      const rows = await sbSelect('glr_sync_estado', `marketplace=eq.${mkt}&conta_id=eq.${shopId}&recurso=in.(sinais,qualidade)&select=recurso,cursor`).catch(() => []);
      const sinais = sinaisAgora || rows.find(r => r.recurso === 'sinais')?.cursor, ant = rows.find(r => r.recurso === 'qualidade')?.cursor || null;
      if (sinais && Date.now() - (sinais.em || 0) < 12 * 3600 * SEG) {
        const cur = await qualidadeAg.calcularQualidade({ mcpCall, apiKey, prazo: Math.min(prazo - 10000, Date.now() + 40000) }, mkt, shopId, sinais, ant);
        await salvarEstado(mkt, shopId, 'qualidade', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: cur.resumo.ruins, cursor: cur });
      }
    } catch (e) { await salvarEstado(mkt, shopId, 'qualidade', { ultimo_erro: String(e.message || e).slice(0, 300) }).catch(() => {}); }
  }
  // Reputação e atendimento — perguntas, reclamações, mensagens e saúde da conta
  if ((mkt === 'shopee' || mkt === 'ml') && Date.now() - (estadoAtual?.repEm || 0) > REPUTACAO_A_CADA_MS && Date.now() < prazo - 20000) {
    try {
      const ant = (await sbSelect('glr_sync_estado', `marketplace=eq.${mkt}&conta_id=eq.${shopId}&recurso=eq.reputacao&select=cursor`).catch(() => []))[0]?.cursor || null;
      const cur = await reputacaoAg.calcularReputacao({ mcpCall, apiKey, sbSelect, anthropicKey: process.env.ANTHROPIC_API_KEY, prazo: Math.min(prazo - 10000, Date.now() + 40000) }, mkt, shopId, ant);
      await salvarEstado(mkt, shopId, 'reputacao', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: (cur.resumo.perguntas || 0) + (cur.resumo.reclamacoes || 0), cursor: cur });
    } catch (e) { await salvarEstado(mkt, shopId, 'reputacao', { ultimo_erro: String(e.message || e).slice(0, 300) }).catch(() => {}); }
  }
  try { await atualizarResumo(mkt, shopId, estadoAtual?.resumo, t); }
  catch (e) { await salvarEstado(mkt, shopId, 'resumo', { ultimo_erro: String(e.message || e).slice(0, 300) }).catch(() => {}); }
  return { mkt, conta: shopId, pedidos: gravados };
}

async function executar(apiKey, soConta) {
  const prazo = Date.now() + ORCAMENTO_MS;
  let contas = await contasParaSincronizar(apiKey);
  if (soConta) contas = contas.filter(c => c.id === String(soConta));
  const estados = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,recurso,ultimo_sucesso,ultima_tentativa,cursor&recurso=not.in.(oportunidades,precos,sinais,promocoes,reputacao,qualidade)');
  const qualEst = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,dia:cursor->>dia&recurso=eq.qualidade').catch(() => []);
  const repEst = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,em:cursor->>em&recurso=eq.reputacao').catch(() => []);
  const promoEst = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,dia:cursor->>dia&recurso=eq.promocoes').catch(() => []);
  const funilEst = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,dia:cursor->>dia&recurso=eq.funil').catch(() => []);
  // Estoque e margem: só a hora do último cálculo (o cursor tem todos os produtos)
  const sinaisEst = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,em:cursor->>em&recurso=eq.sinais').catch(() => []);
  // Monitor de preços: só a hora da última foto (o cursor tem todos os anúncios — é grande)
  const precosEst = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,em:cursor->>em&recurso=eq.precos').catch(() => []);
  // Oportunidades: só o dia da última atualização (o resto do cursor é grande e não precisa aqui)
  const oports = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,dia:cursor->>dia&recurso=eq.oportunidades').catch(() => []);
  const porConta = {};
  for (const o of oports) { const k = `${o.marketplace}:${o.conta_id}`; porConta[k] = porConta[k] || {}; porConta[k].oport = { dia: o.dia }; }
  for (const o of qualEst) { const k = `${o.marketplace}:${o.conta_id}`; porConta[k] = porConta[k] || {}; porConta[k].qualDia = o.dia; }
  for (const o of repEst) { const k = `${o.marketplace}:${o.conta_id}`; porConta[k] = porConta[k] || {}; porConta[k].repEm = parseInt(o.em) || 0; }
  for (const o of promoEst) { const k = `${o.marketplace}:${o.conta_id}`; porConta[k] = porConta[k] || {}; porConta[k].promoDia = o.dia; }
  for (const o of funilEst) { const k = `${o.marketplace}:${o.conta_id}`; porConta[k] = porConta[k] || {}; porConta[k].funilDia = o.dia; }
  for (const o of sinaisEst) { const k = `${o.marketplace}:${o.conta_id}`; porConta[k] = porConta[k] || {}; porConta[k].sinaisEm = parseInt(o.em) || 0; }
  for (const o of precosEst) { const k = `${o.marketplace}:${o.conta_id}`; porConta[k] = porConta[k] || {}; porConta[k].precosEm = parseInt(o.em) || 0; }
  for (const e of estados) {
    const k = `${e.marketplace}:${e.conta_id}`;
    porConta[k] = porConta[k] || {};
    if (e.recurso === 'pedidos') Object.assign(porConta[k], e);
    if (e.recurso === 'ads') porConta[k].ads = e;
    if (e.recurso === 'resumo') porConta[k].resumo = e;
  }
  const chave = c => `${c.mkt}:${c.id}`;
  // Fila justa: quem foi visitado há mais tempo (ou nunca) vai primeiro; o que
  // não couber nesta rodada fica para a próxima, 15 min depois.
  contas.sort((a, b) => String(porConta[chave(a)]?.ultima_tentativa || '').localeCompare(String(porConta[chave(b)]?.ultima_tentativa || '')));
  const resultados = [];
  let i = 0;
  const trabalhador = async () => {
    while (i < contas.length && Date.now() < prazo - 45000 && !consumo.limiteAtingido()) {
      const conta = contas[i++];
      resultados.push(await sincronizarConta(apiKey, conta.mkt, conta.id, porConta[chave(conta)], prazo));
    }
  };
  await Promise.all(Array.from({ length: CONCORRENCIA }, trabalhador));
  await consumo.gravar(sbSelect, sbUpsert, 'sync');
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
  // Agenda do Agente (07h completa; 12h, 16h, 20h acompanhamento): na primeira
  // meia hora de cada horário, dispara a rodada — sem depender da cron da Vercel.
  const { hora, minuto } = agoraBRT();
  const naAgenda = AGENDA_AGENTE.find(a => a.hora === hora);
  if (naAgenda && minuto < 30 && !conta) waitUntil(dispararAgente(req, naAgenda.tipo));
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
