// ============================================================
// GLR Consultoria — Agentes de Estoque e de Margem por produto
// ------------------------------------------------------------
// Rodam dentro do sincronizador (a cada 3 h e sempre antes da revisão das
// 07:00) e publicam o "mural de avisos" que os agentes de ADS leem antes de
// decidir: glr_sync_estado, recurso 'sinais', um registro por loja.
//
// Estoque — produtos que venderam nos últimos 30 dias:
//   venda/dia (últimos 14 dias; com pouca venda, 30 dias) × estoque atual do
//   anúncio (ML: get_items; Shopee: get_item_base_info) = dias de cobertura.
//   zerado (sem estoque) · critico (≤ 7 dias) · baixo (≤ 15 dias) · ok.
// Margem — mesma base de pedidos:
//   preço médio × (líquido/bruto do marketplace) − custo do cadastro − imposto
//   da conta = margem antes do ADS. Ela é o ACOS de equilíbrio (gastar mais que
//   isso em ADS dá prejuízo); o ACOS alvo deixa uma margem mínima de lucro.
//   Líquido/bruto: do próprio produto quando há pedidos com repasse; senão a
//   média da conta; senão (ML) a tarifa de venda do pedido (sem frete).
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

const MARGEM_MINIMA_PADRAO = 5; // % de lucro que o ADS deve preservar (ACOS alvo = margem − isto)
const MAX_PRODUTOS = 200;       // os que mais vendem; o resto não muda decisão de ADS

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

async function lerPedidos(sbSelect, mkt, conta, desdeIso) {
  const rows = [];
  for (let off = 0; off < 10000; off += 1000) {
    const lote = await sbSelect('glr_pedidos', `marketplace=eq.${mkt}&conta_id=eq.${encodeURIComponent(conta)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(desdeIso)}&select=criado_em,valor_bruto,liquido,taxas,itens&limit=1000&offset=${off}`).catch(() => []);
    rows.push(...lote);
    if (lote.length < 1000) break;
  }
  return rows;
}

// Estoque atual dos anúncios (lotes de 20 no ML, 50 na Shopee)
async function lerEstoque(mcpCall, apiKey, mkt, conta, ids, prazo) {
  const out = {};
  if (mkt === 'ml') {
    for (let i = 0; i < ids.length && Date.now() < prazo; i += 20) {
      const r = await mcpCall(apiKey, 'get_items', { meliUserId: conta, ids: ids.slice(i, i + 20), attributes: 'id,title,price,available_quantity,status,variations' }).catch(() => null);
      const lista = r?.data?.items || r?.items || (Array.isArray(r?.data) ? r.data : []) || [];
      for (const x of lista) {
        const b = x?.body || x; if (!b?.id) continue;
        const vars = Array.isArray(b.variations) ? b.variations : [];
        out[String(b.id)] = { e: parseInt(b.available_quantity) || 0, st: b.status || '', vz: vars.filter(v => !(parseInt(v.available_quantity) > 0)).length, vt: vars.length };
      }
    }
  } else if (mkt === 'shopee') {
    for (let i = 0; i < ids.length && Date.now() < prazo; i += 50) {
      const r = await mcpCall(apiKey, 'shopee_get_items_batch', { shopId: conta, item_id_list: ids.slice(i, i + 50).map(Number) }).catch(() => null);
      for (const d of (r?.data?.response?.item_list || r?.response?.item_list || [])) {
        const modelos = Array.isArray(d.models) ? d.models : [];
        const estModelo = m => parseInt(m?.stock_info_v2?.summary_info?.total_available_stock) || 0;
        const e = d.total_stock != null ? parseInt(d.total_stock) || 0
          : d.stock_info_v2?.summary_info ? parseInt(d.stock_info_v2.summary_info.total_available_stock) || 0
          : modelos.reduce((s, m) => s + estModelo(m), 0);
        out[String(d.item_id)] = { e, st: d.item_status || '', vz: modelos.filter(m => estModelo(m) <= 0).length, vt: modelos.length };
      }
    }
  }
  return out;
}

// ctx: { sbSelect, mcpCall, apiKey, lerStorage, prazo }
async function calcularSinais(ctx, mkt, conta) {
  const { sbSelect, mcpCall, apiKey, lerStorage, prazo } = ctx;
  const agora = Date.now();
  const d30 = new Date(agora - 30 * 864e5).toISOString(), d14 = new Date(agora - 14 * 864e5).toISOString();
  const pedidos = await lerPedidos(sbSelect, mkt, conta, d30);

  // Vendas, receita e repasse por produto (pedido com vários itens: repasse dividido pela receita de cada um)
  const P = new Map();
  let brutoLiq = 0, liqConta = 0;
  for (const p of pedidos) {
    const itens = (p.itens || []).filter(i => i.item_id);
    const recPed = itens.reduce((s, i) => s + (parseFloat(i.preco) || 0) * (parseInt(i.qtd) || 1), 0) || parseFloat(p.valor_bruto) || 0;
    const temLiq = p.liquido != null && parseFloat(p.valor_bruto) > 0;
    if (temLiq) { brutoLiq += parseFloat(p.valor_bruto); liqConta += parseFloat(p.liquido); }
    for (const i of itens) {
      const id = String(i.item_id), q = parseInt(i.qtd) || 1, rec = (parseFloat(i.preco) || 0) * q;
      const x = P.get(id) || { id, nome: i.nome || id, u30: 0, u14: 0, rec: 0, recLiq: 0, liq: 0, tarifa: 0, nPed: 0, nLiq: 0 };
      x.u30 += q; x.rec += rec; x.nPed++;
      if (p.criado_em >= d14) x.u14 += q;
      if (temLiq && recPed > 0) { x.recLiq += rec; x.liq += parseFloat(p.liquido) * (rec / recPed); x.nLiq++; }
      x.tarifa += (parseFloat(i.tarifa_venda) || 0) * q;
      if (i.nome) x.nome = i.nome;
      P.set(id, x);
    }
  }
  const razaoConta = brutoLiq > 0 ? liqConta / brutoLiq : null;
  const produtos = [...P.values()].sort((a, b) => b.rec - a.rec).slice(0, MAX_PRODUTOS);

  const [catalogo, aliquotas, margensMin] = await Promise.all([
    lerStorage('glr_vendas_custo_catalogo').catch(() => null),
    lerStorage('glr_aliquotas').catch(() => null),
    lerStorage('glr_margem_minima').catch(() => null),
  ]);
  const aliq = parseFloat((aliquotas || {})[conta]) || 0;
  const margemMin = parseFloat((margensMin || {})[conta]) || MARGEM_MINIMA_PADRAO;
  const estoque = await lerEstoque(mcpCall, apiKey, mkt, conta, produtos.map(p => p.id), Math.min(prazo, Date.now() + 40000));

  const itens = {};
  const resumo = { produtos: produtos.length, zerados: 0, criticos: 0, baixos: 0, negativos: 0, apertados: 0, comCusto: 0, semEstoqueLido: 0 };
  for (const x of produtos) {
    const vd = x.u14 >= 2 ? x.u14 / 14 : x.u30 / 30;
    const es = estoque[x.id];
    const e = es ? es.e : null;
    const dias = e == null ? null : vd > 0 ? e / vd : null;
    const ne = e == null ? null : e <= 0 ? 'zerado' : dias != null && dias <= 7 ? 'critico' : dias != null && dias <= 15 ? 'baixo' : 'ok';
    if (e == null) resumo.semEstoqueLido++;
    else if (ne === 'zerado') resumo.zerados++; else if (ne === 'critico') resumo.criticos++; else if (ne === 'baixo') resumo.baixos++;

    const preco = x.u30 > 0 ? x.rec / x.u30 : 0;
    let razao = null, fonte = null;
    if (x.nLiq >= 2 && x.recLiq >= x.rec * 0.3) { razao = x.liq / x.recLiq; fonte = 'produto'; }
    else if (razaoConta != null) { razao = razaoConta; fonte = 'conta'; }
    else if (mkt === 'ml' && x.tarifa > 0 && x.rec > 0) { razao = 1 - x.tarifa / x.rec; fonte = 'tarifa'; }
    const custo = parseFloat((catalogo || {})[x.id]) || parseFloat((catalogo || {})[x.nome]) || 0;
    let m = null, ac = null, aa = null, nm = null;
    if (custo > 0 && razao != null && preco > 0) {
      m = r1(((preco * razao) - custo - preco * aliq / 100) / preco * 100);
      ac = Math.max(0, m);                      // ACOS de equilíbrio
      aa = Math.max(0, r1(m - margemMin));      // ACOS alvo (preserva a margem mínima)
      nm = m <= 0 ? 'negativa' : aa < 3 ? 'apertada' : 'ok';
      resumo.comCusto++;
      if (nm === 'negativa') resumo.negativos++; else if (nm === 'apertada') resumo.apertados++;
    }
    itens[x.id] = {
      n: String(x.nome).slice(0, 90), p: r2(preco), u30: x.u30, u14: x.u14, vd: r2(vd),
      e, st: es?.st || null, vz: es?.vz || 0, vt: es?.vt || 0, d: dias == null ? null : r1(dias), ne,
      c: custo || null, rz: razao == null ? null : Math.round(razao * 1000) / 1000, fr: fonte, m, ac, aa, nm,
    };
  }
  // Destaques curtos (o Escritório lê só isto, sem baixar a lista inteira)
  const lista = Object.values(itens);
  const destaques = {
    zerados: lista.filter(i => i.ne === 'zerado').sort((a, b) => b.vd - a.vd).slice(0, 3).map(i => i.n),
    criticos: lista.filter(i => i.ne === 'critico').sort((a, b) => a.d - b.d).slice(0, 3).map(i => ({ n: i.n, d: i.d })),
    negativos: lista.filter(i => i.nm === 'negativa').sort((a, b) => a.m - b.m).slice(0, 3).map(i => ({ n: i.n, m: i.m })),
    apertados: lista.filter(i => i.nm === 'apertada').slice(0, 3).map(i => ({ n: i.n, aa: i.aa })),
  };
  return { em: agora, mkt, conta, dias: 30, aliquota: aliq, destaques, margem_minima: margemMin, razao_conta: razaoConta == null ? null : Math.round(razaoConta * 1000) / 1000, itens, resumo };
}

// ── Leitura pelos agentes de ADS ──
// sinais: cursor salvo. Devolve o aviso consolidado de uma lista de anúncios
// (campanha da Shopee ou família/variações do ML).
function avisosDe(sinais, ids) {
  const its = (ids || []).map(i => sinais?.itens?.[String(i)]).filter(Boolean);
  if (!its.length) return null;
  const ordem = { zerado: 0, critico: 1, baixo: 2, ok: 3 };
  const comEst = its.filter(i => i.ne);
  // estoque do conjunto: pior caso entre os que vendem mais (o que puxa a campanha)
  const principal = its.slice().sort((a, b) => (b.vd || 0) - (a.vd || 0))[0];
  const todosZerados = comEst.length && comEst.every(i => i.ne === 'zerado');
  const ne = todosZerados ? 'zerado' : principal?.ne || (comEst.sort((a, b) => ordem[a.ne] - ordem[b.ne])[0]?.ne ?? null);
  const comMargem = its.filter(i => i.aa != null);
  const aa = comMargem.length ? Math.min(...comMargem.map(i => i.aa)) : null;
  const m = comMargem.length ? Math.min(...comMargem.map(i => i.m)) : null;
  return { ne, dias: principal?.d ?? null, nome: principal?.n || its[0].n, estoque: principal?.e ?? null, aa, m, promo: its.find(i => i.pr)?.pr || null, rp: its.find(i => i.rp)?.rp || null, qa: its.find(i => i.qa)?.qa || null, nm: m == null ? null : m <= 0 ? 'negativa' : aa < 3 ? 'apertada' : 'ok' };
}

module.exports = { calcularSinais, avisosDe, MARGEM_MINIMA_PADRAO };
