// ============================================================
// GLR Consultoria — Curva ABC semana a semana (servidor)
// ------------------------------------------------------------
// Mesma regra da aba Vendas → "Curva ABC Semanal" (js/pages-vendas.js,
// calcularCurvaSemanal), calculada a partir da base (glr_pedidos):
//  • 8 semanas FECHADAS de 7 dias terminando ontem (semana 0 = últimos 7 dias);
//  • curva A/B/C pelo faturamento das últimas 4 semanas (A = até 80% do
//    acumulado, B = até 95%, C = resto);
//  • tendência = última semana × média das 3 anteriores (queda, queda forte,
//    parou, alta, alta forte, novo, estável, pouco volume).
// Usado pelo agente da Shopee e do ML (alertas diários) e pelo chat do agente.
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

const NSEM = 8;
const DIA_MS = 86400000;

// Pedidos válidos das 8 semanas, de uma ou mais lojas do mesmo marketplace
async function lerPedidosCurva(sbSelect, marketplace, contaIds, ontemIso) {
  const fim = new Date(`${ontemIso}T00:00:00-03:00`).getTime() + DIA_MS;
  const ini = new Date(fim - NSEM * 7 * DIA_MS).toISOString();
  const lista = (Array.isArray(contaIds) ? contaIds : [contaIds]).map(String);
  const out = [];
  for (let off = 0; off < 100000; off += 1000) {
    const rows = await sbSelect('glr_pedidos', `marketplace=eq.${marketplace}&conta_id=in.(${lista.map(encodeURIComponent).join(',')})&situacao=eq.valido&criado_em=gte.${encodeURIComponent(ini)}&criado_em=lt.${encodeURIComponent(new Date(fim).toISOString())}&select=conta_id,criado_em,itens&order=criado_em&limit=1000&offset=${off}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

function curvaSemanal(pedidos, ontemIso) {
  const fimTs = new Date(`${ontemIso}T00:00:00-03:00`).getTime() + DIA_MS - 1;
  const prods = new Map();
  for (const p of pedidos) {
    const w = Math.floor((fimTs - new Date(p.criado_em).getTime()) / (7 * DIA_MS));
    if (w < 0 || w >= NSEM) continue;
    for (const it of (p.itens || [])) {
      const id = String(it.item_id || it.sku || it.nome || '');
      if (!id) continue;
      const k = `${p.conta_id}:${id}`;
      const x = prods.get(k) || { chave: k, conta_id: String(p.conta_id), item_id: it.item_id ? String(it.item_id) : null, nome: String(it.nome || id).slice(0, 90), un: Array(NSEM).fill(0), rs: Array(NSEM).fill(0) };
      const q = parseInt(it.qtd) || 1;
      x.un[w] += q; x.rs[w] += (parseFloat(it.preco) || 0) * q;
      prods.set(k, x);
    }
  }
  const lista = [...prods.values()];
  for (const x of lista) x.fat4 = x.rs.slice(0, 4).reduce((a, b) => a + b, 0);
  const total4 = lista.reduce((a, x) => a + x.fat4, 0) || 1;
  let acum = 0;
  for (const x of [...lista].sort((a, b) => b.fat4 - a.fat4)) {
    if (x.fat4 <= 0) { x.classe = '-'; x.part = 0; continue; }
    const antes = acum / total4; acum += x.fat4;
    x.classe = antes < 0.8 ? 'A' : antes < 0.95 ? 'B' : 'C';
    x.part = x.fat4 / total4 * 100;
  }
  for (const x of lista) {
    const ult = x.un[0], media = (x.un[1] + x.un[2] + x.un[3]) / 3;
    x.ult = ult; x.media = media;
    x.ultRs = x.rs[0]; x.mediaRs = (x.rs[1] + x.rs[2] + x.rs[3]) / 3;
    x.deltaRs = x.ultRs - x.mediaRs;
    x.var = media > 0 ? (ult - media) / media * 100 : null;
    const vendiaAntes = x.un.slice(1).some(v => v > 0);
    if (ult > 0 && !vendiaAntes) x.tend = 'novo';
    else if (ult === 0 && media >= 1) x.tend = 'parou';
    else if (media < 1 && ult < 2) x.tend = 'baixo';
    else if (x.var <= -40) x.tend = 'queda_forte';
    else if (x.var <= -20) x.tend = 'queda';
    else if (x.var >= 40) x.tend = 'alta_forte';
    else if (x.var >= 20) x.tend = 'alta';
    else x.tend = 'estavel';
  }
  const caindo = x => ['queda', 'queda_forte', 'parou'].includes(x.tend);
  const subindo = x => ['alta', 'alta_forte'].includes(x.tend);
  return {
    total4, produtos: lista,
    resumo: { A: lista.filter(x => x.classe === 'A').length, B: lista.filter(x => x.classe === 'B').length, C: lista.filter(x => x.classe === 'C').length },
    // Curva A caindo — maior perda em R$ primeiro
    aCaindo: lista.filter(x => x.classe === 'A' && caindo(x)).sort((a, b) => a.deltaRs - b.deltaRs),
    // B/C subindo com volume (≥3 un. na última semana) — candidatos a virar A
    sobeBC: lista.filter(x => (x.classe === 'B' || x.classe === 'C') && subindo(x) && x.ult >= 3).sort((a, b) => b.deltaRs - a.deltaRs),
  };
}

const TEND_TXT = { queda_forte: 'queda forte', queda: 'queda', parou: 'parou de vender', alta_forte: 'alta forte', alta: 'alta', novo: 'novo', estavel: 'estável', baixo: 'pouco volume' };
const varTxt = v => v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}%`;
const n1 = v => (Math.round(v * 10) / 10).toLocaleString('pt-BR');

module.exports = { NSEM, lerPedidosCurva, curvaSemanal, TEND_TXT, varTxt, n1 };
