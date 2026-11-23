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

  return { carregar, cobre, cobreAds, somar, invalidar, iniciarTempoReal, mktDe, chave, chaveProduto, chavesProduto, custoProdutosPedido };
})();
window.BaseDados = BaseDados;
BaseDados.iniciarTempoReal();
