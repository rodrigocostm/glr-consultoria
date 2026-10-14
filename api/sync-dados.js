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
const { AGENDA_AGENTE, agoraBRT } = require('./_agenda-agente');

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
  if (cursor.tem_gmv_max) {
    const gasto = { ...(cursor.gmv_max || {}) }, vendas = { ...(cursor.gmv_max_vendas || {}) };
    const dias = [hoje0 - 2 * DIA, hoje0 - DIA, hoje0];
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
    // Taxas reais (escrow Shopee / recebimento ML) dos pedidos que ainda não têm.
    if (ad.taxas && Date.now() < prazo) {
      try { cursor.taxas_ult = await ad.taxas(apiKey, shopId, t, Math.min(prazo, Date.now() + TEMPO_TAXAS_POR_CONTA_MS)); }
      catch (e) { cursor.taxas_erro = String(e.message || e).slice(0, 200); }
    }
    await salvarEstado(mkt, shopId, 'pedidos', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, cursor, registros: gravados });
  } catch (e) {
    await salvarEstado(mkt, shopId, 'pedidos', { ultimo_erro: String(e.message || e).slice(0, 500), cursor }).catch(() => {});
  }

  // ADS é independente dos pedidos (loja autorizada só no app de Ads ainda tem ADS).
  if (Date.now() < prazo) {
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
  // Oportunidades de ADS — 1x por dia por loja, depois das 06:00 (Brasília), se sobrar tempo
  const horaOp = new Date((t - 3 * 3600) * SEG).getUTCHours();
  if (horaOp >= 6 && estadoAtual?.oport?.dia !== dataBR(t) && Date.now() < prazo - 20000) {
    try {
      const cur = await atualizarOportunidades(apiKey, mkt, shopId, estadoAtual?.ads, t, Math.min(prazo, Date.now() + 40000));
      if (cur) await salvarEstado(mkt, shopId, 'oportunidades', { ultimo_sucesso: new Date().toISOString(), ultimo_erro: null, registros: cur.candidatos.length, cursor: cur });
    } catch (e) {
      await salvarEstado(mkt, shopId, 'oportunidades', { ultimo_erro: String(e.message || e).slice(0, 300) }).catch(() => {});
    }
  }
  try { await atualizarResumo(mkt, shopId, estadoAtual?.resumo, t); }
  catch (e) { await salvarEstado(mkt, shopId, 'resumo', { ultimo_erro: String(e.message || e).slice(0, 300) }).catch(() => {}); }
  return { mkt, conta: shopId, pedidos: gravados };
}

async function executar(apiKey, soConta) {
  const prazo = Date.now() + ORCAMENTO_MS;
  let contas = await contasParaSincronizar(apiKey);
  if (soConta) contas = contas.filter(c => c.id === String(soConta));
  const estados = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,recurso,ultimo_sucesso,ultima_tentativa,cursor&recurso=neq.oportunidades');
  // Oportunidades: só o dia da última atualização (o resto do cursor é grande e não precisa aqui)
  const oports = await sbSelect('glr_sync_estado', 'select=marketplace,conta_id,dia:cursor->>dia&recurso=eq.oportunidades').catch(() => []);
  const porConta = {};
  for (const o of oports) { const k = `${o.marketplace}:${o.conta_id}`; porConta[k] = porConta[k] || {}; porConta[k].oport = { dia: o.dia }; }
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
