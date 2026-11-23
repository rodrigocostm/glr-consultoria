// ============================================================
// GLR Consultoria — Base sincronizada (leitura compartilhada pelas telas)
// ------------------------------------------------------------
// O motor do servidor (api/sync-dados.js) grava a cada 15 min, por loja
// Shopee e Mercado Livre, um resumo por dia (pedidos, faturamento válido,
// unidades, cancelados, devolvidos, líquido) em glr_sync_estado, recurso
// "resumo". As telas leem daqui em vez de buscar pedido a pedido na API.
//
// Regra = a mesma da tela de Vendas: faturamento válido sem cancelados e sem
// devoluções aceitas. Uma loja só é usada para um período se o histórico dela
// já cobre o início desse período (senão a tela cai na busca antiga pela API).
//
// Quando uma sincronização termina, o Supabase avisa em tempo real e as telas
// recebem o evento "glr-base-atualizada" para se redesenhar sozinhas.
// ============================================================
const BaseDados = (() => {
  const TTL_MS = 60 * 1000;
  let cache = null, cacheEm = 0, emAndamento = null, avisoTimer = null, canal = null;

  const mktDe = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : m === 'amazon' ? 'amazon' : ['tiktok', 'tiktok_shop', 'tiktokshop'].includes(m) ? 'tiktok' : m === 'magalu' ? 'magalu' : m === 'shein' ? 'shein' : null; };
  const chave = (mkt, id) => `${mktDe(mkt)}:${id}`;
  const inicioDiaBRT = iso => new Date(`${iso}T00:00:00-03:00`).getTime() / 1000;

  // { "shopee:123": { dias: {AAAA-MM-DD: {...}}, historicoAte (unix), ultimoSucesso, erro, resumoEm } }
  async function carregar(forcar = false) {
    if (!forcar && cache && Date.now() - cacheEm < TTL_MS) return cache;
    if (emAndamento) return emAndamento;
    emAndamento = (async () => {
      const [res, ped, ads] = await Promise.all([
        _sb.from('glr_sync_estado').select('marketplace,conta_id,cursor,ultimo_sucesso').eq('recurso', 'resumo'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,cursor,ultimo_sucesso,ultimo_erro').eq('recurso', 'pedidos'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,cursor,ultimo_sucesso').eq('recurso', 'ads'),
      ]);
      if (res.error) throw res.error;
      if (ped.error) throw ped.error;
      const mapa = {};
      for (const e of (ped.data || [])) {
        mapa[`${e.marketplace}:${e.conta_id}`] = { dias: {}, historicoAte: e.cursor?.historico_ate || null, ultimoSucesso: e.ultimo_sucesso, erro: e.ultimo_erro || null };
      }
      for (const e of (res.data || [])) {
        const k = `${e.marketplace}:${e.conta_id}`;
        mapa[k] = mapa[k] || { historicoAte: null };
        mapa[k].dias = e.cursor?.dias || {};
        mapa[k].resumoEm = e.ultimo_sucesso;
      }
      // ADS: até onde o histórico diário (Shopee já com GMV Max) foi gravado
      for (const e of (ads.data || [])) {
        const k = `${e.marketplace}:${e.conta_id}`;
        if (mapa[k] && e.ultimo_sucesso) mapa[k].adsHistAte = e.cursor?.hist_ate || null;
      }
      cache = mapa; cacheEm = Date.now();
      return mapa;
    })().finally(() => { emAndamento = null; });
    return emAndamento;
  }

  // A loja tem na base TODOS os pedidos a partir do dia `desdeIso`?
  function cobre(info, desdeIso) {
    return !!(info && info.historicoAte && info.resumoEm && info.historicoAte <= inicioDiaBRT(desdeIso));
  }

  // O ADS por dia da loja (Shopee: ADS + GMV Max) cobre a partir de `desdeIso`?
  function cobreAds(info, desdeIso) {
    return !!(info && info.adsHistAte && info.resumoEm && info.adsHistAte <= inicioDiaBRT(desdeIso));
  }

  // Soma o resumo diário de uma loja entre duas datas (inclusive).
  function somar(info, deIso, ateIso) {
    const t = { pedidos: 0, faturamento: 0, unidades: 0, cancelados: 0, valor_cancelado: 0, devolvidos: 0, valor_devolvido: 0, liquido: 0, com_liquido: 0, ads: 0, ads_gmv: 0 };
    for (const [dia, v] of Object.entries(info?.dias || {})) {
      if (dia < deIso || dia > ateIso) continue;
      for (const c of Object.keys(t)) t[c] += parseFloat(v[c]) || 0;
    }
    return t;
  }

  // Chave do produto no catálogo de custo (glr_vendas_custo_catalogo) para um pedido
  // da base — mesma regra de pedidoDaBaseVendas (pages-vendas.js), que é onde o
  // custo é lançado: ML usa o item_id; demais usam o nome do produto.
  function chaveProduto(mkt, itensBrutos, pedidoId) {
    const itens = Array.isArray(itensBrutos) ? itensBrutos : [];
    if (mkt === 'ml') return String(itens[0]?.item_id || itens[0]?.nome || '—');
    const nomes = itens.map(i => i.nome || '—');
    return nomes.length > 1 ? `${nomes[0]} (+${nomes.length - 1})` : (nomes[0] || String(pedidoId || ''));
  }

  // Todas as chaves a tentar no catálogo, em ordem: a da página Vendas e, na Shopee,
  // também o id do anúncio (a página Produtos grava id E nome) — cobre anúncio
  // renomeado e pedido com vários itens ("Nome (+1)").
  function chavesProduto(mkt, itensBrutos, pedidoId) {
    const itens = Array.isArray(itensBrutos) ? itensBrutos : [];
    const ks = [chaveProduto(mkt, itens, pedidoId)];
    if (mkt !== 'ml' && itens[0]?.item_id) ks.push(String(itens[0].item_id));
    return [...new Set(ks.filter(Boolean))];
  }

  // Custo dos produtos de UM pedido = custo unitário × quantidade, item a item.
  // O custo do catálogo (página Produtos/Vendas) é por unidade, e o lançado no pedido
  // pela página Vendas (custo por produto / "Aplicar a todos") também grava o valor
  // de uma unidade — por isso os dois são multiplicados pela quantidade.
  //   itens: [{ item_id, nome, qtd }]   custoManual: glr_vendas_custos[pedido].custo
  function custoProdutosPedido(mkt, itensBrutos, custoManual, catalogo, pedidoId) {
    const itens = Array.isArray(itensBrutos) ? itensBrutos : [];
    const qtdDe = i => parseInt(i?.qtd) || 1;
    const qtdTotal = itens.reduce((s, i) => s + qtdDe(i), 0) || 1;
    const manual = parseFloat(custoManual) || 0;
    if (manual > 0) return manual * qtdTotal;
    const cat = catalogo || {};
    const unit = keys => { for (const k of keys) { const v = parseFloat(cat[k]) || 0; if (v > 0) return v; } return 0; };
    let total = 0;
    for (const it of itens) {
      const keys = (mkt === 'ml' ? [it.item_id, it.nome] : [it.nome, it.item_id]).filter(Boolean).map(String);
      total += unit(keys) * qtdDe(it);
    }
    if (total > 0) return total;
    // Pedido sem itens, ou custo gravado só na chave do pedido inteiro ("Nome (+1)")
    return unit([chavesProduto(mkt, itens, pedidoId)].filter(Boolean)) * qtdTotal;
  }

  // Recarga de ADS que a Shopee tira do repasse do pedido (escrow) para o saldo de ADS.
  // Não é taxa: o gasto de ADS já entra inteiro em "Investimento em ADS" — descontar
  // também do líquido contava o mesmo dinheiro duas vezes (comparado com o Gestor Seller,
  // Zion nov/2026: R$ 4.097,84). As telas somam isto de volta ao líquido.
  function recargaAdsDoRepasse(taxas) {
    return parseFloat(taxas?.detalhes?.ads_escrow_top_up_fee_or_technical_support_fee) || 0;
  }

  // Taxa média real de cada conta (1 − Σlíquido/Σvalor) a partir dos pedidos que já têm a
  // taxa do marketplace. Usada no lugar de "líquido = valor cheio" dos pedidos que ainda
  // não têm (lucro aparecia inflado). Precisa de pelo menos 10 pedidos com taxa real.
  //   lista: [{ conta, valor, liquido }] (só pedidos com taxa real)
  function taxaMediaPorConta(lista) {
    const soma = {};
    for (const x of lista || []) {
      const v = parseFloat(x.valor) || 0, l = parseFloat(x.liquido);
      if (v <= 0 || !Number.isFinite(l)) continue;
      const s = soma[x.conta] = soma[x.conta] || { v: 0, l: 0, n: 0 };
      s.v += v; s.l += l; s.n++;
    }
    const out = {};
    for (const [c, s] of Object.entries(soma)) if (s.n >= 10 && s.v > 0) out[c] = Math.min(0.9, Math.max(0, 1 - s.l / s.v));
    return out;
  }

  // Carteira Shopee (shopee_get_wallet_transactions) → cobranças que saem DEPOIS do repasse
  // do pedido e não aparecem nele (ex.: devolução aprovada depois do repasse, multa, ajuste).
  // Fora: saque/PIX, renda de pedido e recarga de ADS (SPM_DEDUCT, já contada em ADS).
  // Mesma regra do agente (api/_saude-taxas.js somarCarteiraShopee).
  const CARTEIRA_NAO_CUSTO = /^(PIX_TRANSFER|WITHDRAWAL|ESCROW_VERIFIED_ADD|ESCROW_ADD|TRANSFER_TO_BANK|AUTO_WITHDRAWAL|SPM_DEDUCT)/;
  const CARTEIRA_ROTULOS = {
    ADJUSTMENT_FOR_RR_AFTER_ESCROW_VERIFIED: 'Devolução descontada depois do repasse',
    ESCROW_VERIFIED_MINUS: 'Ajuste negativo na renda de pedido',
    ADJUSTMENT_CENTER_DEDUCT: 'Débito de ajuste da Shopee (ex.: DIFAL de ICMS)',
  };
  //   devolvidos: Set de order_sn que a base já trata como devolvidos (não contar de novo)
  function cobrancasCarteiraShopee(lista, devolvidos) {
    const porTipo = {};
    let total = 0;
    for (const t of lista || []) {
      const v = parseFloat(t.amount) || 0;
      if (v >= 0 || (t.status && t.status !== 'COMPLETED')) continue;
      const tipo = String(t.transaction_type || 'SEM_TIPO');
      if (CARTEIRA_NAO_CUSTO.test(tipo)) continue;
      if (t.order_sn && devolvidos?.has(String(t.order_sn))) continue;
      const x = porTipo[tipo] = porTipo[tipo] || { valor: 0, n: 0, rotulo: CARTEIRA_ROTULOS[tipo] || t.description || tipo };
      x.valor = Math.round((x.valor - v) * 100) / 100; x.n++;
      total -= v;
    }
    return { total: Math.round(total * 100) / 100, porTipo };
  }

  function invalidar() { cache = null; }

  function iniciarTempoReal() {
    if (canal || typeof _sb === 'undefined') return;
    canal = _sb.channel('glr_base_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'glr_sync_estado' }, () => {
        cache = null;
        // várias lojas terminam em sequência numa rodada — avisa uma vez só
        clearTimeout(avisoTimer);
        avisoTimer = setTimeout(() => window.dispatchEvent(new CustomEvent('glr-base-atualizada')), 20000);
      })
      .subscribe();
  }

  return { carregar, cobre, cobreAds, somar, invalidar, iniciarTempoReal, mktDe, chave, chaveProduto, chavesProduto, custoProdutosPedido, recargaAdsDoRepasse, taxaMediaPorConta, cobrancasCarteiraShopee };
})();
window.BaseDados = BaseDados;
BaseDados.iniciarTempoReal();
