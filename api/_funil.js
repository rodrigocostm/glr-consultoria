// ============================================================
// GLR Consultoria — Funil por produto (visitas × conversão)
// ------------------------------------------------------------
// 1x por dia por loja, para os produtos que mais vendem: quantas visitas cada
// um recebeu, para o Gerente separar "perdeu visita" de "perdeu conversão" de
// "subiu o preço" — o que o faturamento sozinho não mostra.
//  • ML: visitas por dia de cada anúncio (/items/{id}/visits/time_window) e da
//    loja inteira (/users/{id}/items_visits/time_window), últimos 28 dias.
//  • Shopee: a API só dá visitas acumuladas do anúncio (get_extra_info), então
//    guarda uma foto por dia e as visitas do período saem da diferença entre
//    fotos (a comparação de semanas fica completa depois de ~15 dias de fotos).
//    Vem junto a nota e o número de avaliações.
// Resultado em glr_sync_estado (recurso 'funil'):
//   { em, dia, conta: { 'AAAA-MM-DD': visitas } (só ML),
//     itens: { item_id: { n, v: { dia: visitas } (ML) | h: { dia: acumulado } (Shopee), r, nr } } }
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================
const DIAS = 28, MAX_ITENS = 40, HIST_DIAS = 35;
const SEG = 1000, DIA = 86400;
const dataBR = t => new Date((t - 3 * 3600) * SEG).toISOString().slice(0, 10);

async function topProdutos(sbSelect, mkt, id, t) {
  const desde = new Date((t - DIAS * DIA) * SEG).toISOString();
  const vendas = new Map();
  for (let off = 0; off < 50000; off += 1000) {
    const rows = await sbSelect('glr_pedidos', `marketplace=eq.${mkt}&conta_id=eq.${encodeURIComponent(id)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(desde)}&select=itens&limit=1000&offset=${off}`);
    for (const p of rows) for (const it of (p.itens || [])) {
      if (!it.item_id) continue;
      const k = String(it.item_id), q = parseInt(it.qtd) || 1;
      const v = vendas.get(k) || { id: k, n: String(it.nome || k).slice(0, 90), rs: 0 };
      v.rs += (parseFloat(it.preco) || 0) * q;
      vendas.set(k, v);
    }
    if (rows.length < 1000) break;
  }
  return [...vendas.values()].sort((a, b) => b.rs - a.rs).slice(0, MAX_ITENS);
}

// resultado do time_window → { 'AAAA-MM-DD': visitas }, sem o dia de hoje (incompleto)
function porDia(r, hoje) {
  const out = {};
  for (const x of ((r?.data || r)?.results || [])) { const d = String(x.date || '').slice(0, 10); if (d && d < hoje) out[d] = parseInt(x.total) || 0; }
  return out;
}

async function calcularFunil({ sbSelect, mcpCall, apiKey, prazo }, mkt, id, anterior) {
  const t = Math.floor(Date.now() / SEG), hoje = dataBR(t);
  const top = await topProdutos(sbSelect, mkt, id, t);
  const itens = {};
  let conta = null;
  if (mkt === 'ml') {
    try { conta = porDia(await mcpCall(apiKey, 'raw', { method: 'GET', path: `/users/${id}/items_visits/time_window?last=${DIAS}&unit=day`, meliUserId: id }), hoje); } catch (e) {}
    for (let i = 0; i < top.length; i += 5) {
      if (Date.now() > prazo) break; // o que faltar entra amanhã — o Gerente usa o que tiver
      await Promise.all(top.slice(i, i + 5).map(async p => {
        try { itens[p.id] = { n: p.n, v: porDia(await mcpCall(apiKey, 'raw', { method: 'GET', path: `/items/${p.id}/visits/time_window?last=${DIAS}&unit=day`, meliUserId: id }), hoje) }; } catch (e) {}
      }));
    }
  } else {
    const corte = dataBR(t - HIST_DIAS * DIA);
    for (let i = 0; i < top.length; i += 50) {
      if (Date.now() > prazo) break;
      const lote = top.slice(i, i + 50);
      const r = await mcpCall(apiKey, 'shopee_get_extra_info', { shopId: id, item_id_list: lote.map(p => p.id).join(',') });
      for (const x of ((r.data || r)?.response?.item_list || [])) {
        const k = String(x.item_id), ant = anterior?.itens?.[k]?.h || {};
        const h = Object.fromEntries(Object.entries(ant).filter(([d]) => d >= corte));
        h[hoje] = parseInt(x.views) || 0; // foto de hoje cedo ≈ acumulado até ontem
        itens[k] = { n: lote.find(p => p.id === k)?.n || k, h, r: x.rating_star ? Math.round(x.rating_star * 100) / 100 : null, nr: parseInt(x.comment_count) || 0, s: parseInt(x.sale) || 0 };
      }
    }
  }
  return { em: Date.now(), dia: hoje, conta, itens };
}

const dataMais = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// foto daquele dia ou de 1 dia depois (a sincronização pode ter pulado um dia)
const fotoPerto = (h, dia) => h[dia] ?? h[dataMais(dia, 1)] ?? null;

// Visitas de um produto no período [ini, fim] (AAAA-MM-DD); null sem dado suficiente
function visitasItem(f, id, ini, fim) {
  const x = f?.itens?.[String(id)];
  if (!x) return null;
  if (x.v) {
    // o time_window só devolve dia com visita: vale se a janela de 28 dias alcança o início
    if (!f.dia || dataMais(f.dia, -DIAS) > ini) return null;
    return Object.entries(x.v).reduce((s, [d, n]) => d >= ini && d <= fim ? s + n : s, 0);
  }
  if (x.h) { // Shopee: foto do dia seguinte ao fim − foto do dia do início
    const a = fotoPerto(x.h, ini), b = fotoPerto(x.h, dataMais(fim, 1));
    return a != null && b != null && b >= a ? b - a : null;
  }
  return null;
}
function visitasConta(f, ini, fim) {
  if (!f?.conta || !f.dia || dataMais(f.dia, -DIAS) > ini) return null;
  return Object.entries(f.conta).reduce((s, [d, n]) => d >= ini && d <= fim ? s + n : s, 0);
}

module.exports = { calcularFunil, visitasItem, visitasConta };
