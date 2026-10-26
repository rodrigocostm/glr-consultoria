// ============================================================
// GLR Consultoria — Agente de Promoções
// ------------------------------------------------------------
// Roda 1x por dia por loja (sincronizador, depois das 06:00), em cima do mural
// de Estoque e Margem (recurso 'sinais'), e grava o seu resultado em
// glr_sync_estado, recurso 'promocoes':
//  • Mercado Livre: para os produtos que mais vendem (com custo cadastrado),
//    lê as promoções em que o anúncio pode entrar (ml_item_promotions) e
//    escolhe a de menor preço que ainda deixa a margem mínima de lucro. Em
//    campanha co-participada (SMART etc.) o vendedor recebe o preço + a parte
//    que o ML banca — é sobre esse valor que a margem é calculada.
//  • Shopee: identifica quem já está com desconto (margem no preço atual) e
//    sugere desconto para estoque parado (mais de 60 dias) com margem de sobra.
// Colaboração: não sugere promoção para produto que acaba em até 10 dias
// (agente de Estoque), dá prioridade a estoque parado, e publica o ACOS alvo no
// preço da promoção — os agentes de ADS usam esse teto enquanto ela durar.
// A margem é ESTIMADA com o repasse médio do produto (o agente de Margem); o
// valor exato (tarifa e frete do preço novo) aparece na Central de Promoções.
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

const MAX_ITENS_ML = 60;
const ESTOQUE_PARADO_DIAS = 60;
const DESCONTO_MAX_SUGERIDO = 15; // Shopee: desconto sugerido para girar estoque parado
const FOLGA_ADS = 3;              // a promoção precisa deixar pelo menos 3 pontos de ACOS para o ADS (senão o ADS para)
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const TIPO = { LIGHTNING: 'Relâmpago', SMART_LIGHTNING: 'Relâmpago', PRICE_DISCOUNT: 'Desconto próprio', DEAL: 'Campanha do ML', SELLER_CAMPAIGN: 'Campanha própria', SMART: 'Campanha co-participada', PRICE_MATCHING: 'Preço competitivo', DOD: 'Oferta do dia', MARKETPLACE_CAMPAIGN: 'Campanha do ML', UNHEALTHY_STOCK: 'Estoque parado', VOLUME: 'Desconto por volume', PRE_NEGOTIATED: 'Pré-negociada' };
const PRECO_FIXO = new Set(['SMART', 'SMART_LIGHTNING', 'PRICE_MATCHING', 'PRE_NEGOTIATED', 'UNHEALTHY_STOCK']); // preço definido pelo ML

// margem (%) antes do ADS num preço recebido pelo vendedor, com o repasse/custo/imposto do produto
const margemNo = (x, recebido, aliq) => recebido > 0 && x.rz != null && x.c ? r1((recebido * x.rz - x.c - recebido * aliq / 100) / recebido * 100) : null;
// menor preço que ainda deixa a margem m (%)
const precoParaMargem = (x, m, aliq) => { const den = x.rz - aliq / 100 - m / 100; return den > 0 && x.c ? Math.ceil(x.c / den * 100) / 100 : null; };

async function mapLimit(lista, lim, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(lim, lista.length) }, async () => { while (i < lista.length) { const k = i++; await fn(lista[k], k); } }));
}

async function promocoesML(ctx, conta, sinais) {
  const { mcpCall, apiKey, prazo } = ctx;
  const aliq = sinais.aliquota || 0, mMin = sinais.margem_minima ?? 5;
  const base = Object.entries(sinais.itens || {}).map(([id, x]) => ({ id, ...x }))
    .filter(x => x.c && x.rz != null && x.ne !== 'zerado')
    .sort((a, b) => ((b.d ?? 0) >= ESTOQUE_PARADO_DIAS) - ((a.d ?? 0) >= ESTOQUE_PARADO_DIAS) || b.vd * b.p - a.vd * a.p)
    .slice(0, MAX_ITENS_ML);
  const itens = {}, colab = [];
  await mapLimit(base, 4, async x => {
    if (Date.now() > prazo) return;
    const r = await mcpCall(apiKey, 'ml_item_promotions', { meliUserId: conta, item_id: x.id }).catch(() => null);
    const promos = r?.data?.items || r?.items || (Array.isArray(r?.data) ? r.data : []);
    if (!Array.isArray(promos)) return;
    const parado = (x.d ?? 0) >= ESTOQUE_PARADO_DIAS;
    const acabando = x.ne === 'critico' || (x.d != null && x.d <= 10);
    const original = x.p;
    // em vigor
    const ativa = promos.find(p => p.status === 'started' && parseFloat(p.price) > 0);
    let emPromo = null;
    if (ativa) {
      const preco = parseFloat(ativa.price), meli = (parseFloat(ativa.meli_percentage) || 0) * (parseFloat(ativa.original_price) || original) / 100;
      const m = margemNo(x, preco + meli, aliq);
      emPromo = { tipo: TIPO[ativa.type] || ativa.type, nome: ativa.name || '', preco: r2(preco), recebido: r2(preco + meli), m, aa: m == null ? null : Math.max(0, r1(m - mMin)), fim: ativa.finish_date || null };
    }
    // candidatas que cabem na margem
    const opcoes = [];
    for (const p of promos.filter(p => p.status === 'candidate')) {
      if (/COUPON/.test(p.type)) continue; // cupom não muda o preço do anúncio
      const orig = parseFloat(p.original_price) || original;
      const meli = (parseFloat(p.meli_percentage) || 0) * orig / 100;
      let preco;
      if (PRECO_FIXO.has(p.type) && parseFloat(p.price) > 0) preco = parseFloat(p.price);
      else {
        const min = parseFloat(p.min_discounted_price) || 0, max = parseFloat(p.max_discounted_price) || 0;
        if (!max) continue;
        const alvo = precoParaMargem(x, mMin + FOLGA_ADS, aliq);
        if (alvo == null || alvo > max) continue;            // nem o menor desconto permitido deixa a margem mínima
        const sug = parseFloat(p.suggested_discounted_price) || max;
        preco = Math.min(max, Math.max(min, alvo, parado ? alvo : Math.min(sug, max)));
      }
      if (/LIGHTNING/.test(p.type) && p.stock?.min && (x.e == null || x.e < p.stock.min)) continue; // relâmpago pede estoque mínimo
      const recebido = preco + meli, m = margemNo(x, recebido, aliq);
      if (m == null || m < mMin + FOLGA_ADS - 0.05) continue;
      opcoes.push({ id: p.id || null, ref: p.ref_id || null, tipo: p.type, rot: TIPO[p.type] || p.type, nome: p.name || '', preco: r2(preco), recebido: r2(recebido),
        desconto: orig > 0 ? r1((1 - preco / orig) * 100) : null, m, aa: Math.max(0, r1(m - mMin)), fim: p.finish_date || null, ini: p.start_date || null });
    }
    // a mais competitiva que ainda deixa a margem: menor preço ao comprador
    opcoes.sort((a, b) => a.preco - b.preco);
    const melhor = opcoes[0] || null;
    if (melhor && acabando) colab.push({ de: 'estoque', texto: `não sugeri promoção para "${x.n.slice(0, 50)}": acaba em ~${Math.round(x.d)} dia(s)` });
    itens[x.id] = { n: x.n, p: original, e: x.e, d: x.d, parado, emPromo, opcoes: opcoes.slice(0, 4), melhor: acabando || emPromo ? null : melhor, motivo: melhor ? (parado ? 'estoque parado' : 'cabe na margem') : null };
  });
  return { itens, colab };
}

async function promocoesShopee(ctx, conta, sinais) {
  const { mcpCall, apiKey, prazo } = ctx;
  const aliq = sinais.aliquota || 0, mMin = sinais.margem_minima ?? 5;
  const base = Object.entries(sinais.itens || {}).map(([id, x]) => ({ id, ...x })).filter(x => x.rz != null).sort((a, b) => b.vd * b.p - a.vd * a.p).slice(0, 100);
  const itens = {}, colab = [];
  for (let i = 0; i < base.length && Date.now() < prazo; i += 50) {
    const lote = base.slice(i, i + 50);
    const r = await mcpCall(apiKey, 'shopee_get_items_batch', { shopId: conta, item_id_list: lote.map(x => Number(x.id)) }).catch(() => null);
    const det = new Map((r?.data?.response?.item_list || r?.response?.item_list || []).map(d => [String(d.item_id), d]));
    for (const x of lote) {
      const d = det.get(x.id); if (!d) continue;
      const pi = d.price_info?.[0] || d.models?.[0]?.price_info?.[0] || {};
      const atual = parseFloat(pi.current_price) || 0, orig = parseFloat(pi.original_price) || atual;
      const emDesconto = d.has_promotion || (d.models || []).some(m => m.has_promotion) || (orig > 0 && atual < orig - 0.01);
      const parado = (x.d ?? 0) >= ESTOQUE_PARADO_DIAS;
      let emPromo = null, melhor = null;
      if (emDesconto && atual > 0) {
        const m = margemNo(x, atual, aliq);
        emPromo = { tipo: 'Desconto da loja', nome: '', preco: r2(atual), recebido: r2(atual), m, aa: m == null ? null : Math.max(0, r1(m - mMin)), desconto: orig > 0 ? r1((1 - atual / orig) * 100) : null };
      } else if (parado && x.c && atual > 0) {
        const piso = precoParaMargem(x, mMin + FOLGA_ADS, aliq);
        if (piso != null && piso < atual) {
          const desc = Math.min(DESCONTO_MAX_SUGERIDO, Math.floor((1 - piso / atual) * 100));
          if (desc >= 5) {
            const preco = r2(atual * (1 - desc / 100)), m = margemNo(x, preco, aliq);
            melhor = { tipo: 'SHOPEE_DISCOUNT', rot: 'Desconto da loja', preco, recebido: preco, desconto: desc, m, aa: Math.max(0, r1(m - mMin)) };
          }
        }
      }
      itens[x.id] = { n: x.n, p: r2(atual || x.p), e: x.e, d: x.d, parado, emPromo, opcoes: melhor ? [melhor] : [], melhor, motivo: melhor ? 'estoque parado' : null };
    }
  }
  return { itens, colab };
}

// ctx: { mcpCall, apiKey, prazo }; sinais: cursor do agente de Estoque/Margem
async function calcularPromocoes(ctx, mkt, conta, sinais) {
  const { itens, colab } = mkt === 'ml' ? await promocoesML(ctx, conta, sinais) : await promocoesShopee(ctx, conta, sinais);
  const lista = Object.entries(itens).map(([id, x]) => ({ id, ...x }));
  const mMin = sinais.margem_minima ?? 5;
  const sugeridas = lista.filter(x => x.melhor).sort((a, b) => (b.parado - a.parado) || (b.melhor.m - a.melhor.m));
  const resumo = {
    analisados: lista.length, sugeridas: sugeridas.length, emPromo: lista.filter(x => x.emPromo).length,
    parados: sugeridas.filter(x => x.parado).length, promoApertada: lista.filter(x => x.emPromo && x.emPromo.m != null && x.emPromo.m < mMin).length,
  };
  const destaques = {
    sugeridas: sugeridas.slice(0, 3).map(x => ({ n: x.n, rot: x.melhor.rot, desconto: x.melhor.desconto, m: x.melhor.m })),
    apertadas: lista.filter(x => x.emPromo?.m != null && x.emPromo.m < mMin).slice(0, 3).map(x => ({ n: x.n, m: x.emPromo.m })),
  };
  return { em: Date.now(), dia: new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), mkt, conta, margem_minima: mMin, itens, resumo, destaques, colab };
}

module.exports = { calcularPromocoes, TIPO, PRECO_FIXO };
