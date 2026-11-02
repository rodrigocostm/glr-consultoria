// ============================================================
// GLR Consultoria — Agente de Expansão de canais
// ------------------------------------------------------------
// Para cada cliente: os produtos que mais venderam nos últimos 30 dias (base
// glr_pedidos, todas as lojas) e em quais canais eles ainda NÃO estão —
// Mercado Livre, Shopee, TikTok Shop, Amazon e Magalu. A comissão GLR é por
// venda/pedido, então produto que já vende num canal e falta no outro é pedido
// novo no mesmo cliente.
//  • "Já está no canal": vendeu lá nos últimos 30 dias, ou (ML e Shopee, onde
//    o agente lê o catálogo) existe anúncio ativo com o mesmo SKU ou título
//    parecido. TikTok/Amazon/Magalu só sabem pela venda — a tela deixa marcar
//    "Já existe".
//  • Estimativa no canal novo = unidades/mês do produto × fator do canal. Se o
//    cliente já vende no canal, o fator é a proporção real dele (vendas no canal ÷
//    nos outros, entre 10% e 80%); sem conta, um fator conservador (FATOR).
// Não publica nada: a tela (js/pages-expansao.js) abre a Central de Anúncios
// já preenchida com o anúncio de origem e o analista publica.
// Estado: glr_sync_estado sistema / cliente:<id> / expansao. Rodada pelo
// agente-cron (?rodada=expansao; de madrugada, cliente analisado há mais de 3 dias).
// ============================================================

const estoque = require('./_estoque');

const MKT = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : m === 'amazon' ? 'amazon' : ['tiktok', 'tiktok_shop', 'tiktokshop'].includes(m) ? 'tiktok' : m === 'magalu' ? 'magalu' : m === 'shein' ? 'shein' : null; };
const ALVOS = ['ml', 'shopee', 'tiktok', 'amazon', 'magalu'];
const FATOR = { ml: 0.6, shopee: 0.5, tiktok: 0.15, amazon: 0.15, magalu: 0.12 }; // canal sem conta: fração das vendas atuais do produto
const COM_CATALOGO = { ml: estoque.anunciosML, shopee: estoque.anunciosShopee };
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;

const PARADAS = new Set('com para sem por dos das uma uns kit cor tamanho novo nova original promocao oferta frete gratis envio imediato pronta entrega'.split(' '));
const tokens = t => new Set(String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 3 && !PARADAS.has(w)));
const normSku = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
// título parecido: Jaccard ≥ 0,55 ou o menor contido ≥ 80% no maior (títulos do ML são curtos, os da Shopee longos)
function parecido(a, b) {
  if (!a.size || !b.size) return false;
  let i = 0; for (const w of a) if (b.has(w)) i++;
  const menor = Math.min(a.size, b.size);
  return i / (a.size + b.size - i) >= 0.55 || (menor >= 3 && i / menor >= 0.8);
}
const contaDe = ct => String(ct.param_to_use?.shopId || ct.param_to_use?.meliUserId || ct.param_to_use?.amazon_account_id || ct.param_to_use?.magalu_account_id || ct.param_to_use?.shein_supplier_id || ct.external_id || '');

async function vendas30(sbSelect, mkt, conta, desde) {
  const out = [];
  for (let off = 0; off < 20000; off += 1000) {
    const r = await sbSelect('glr_pedidos', `marketplace=eq.${mkt}&conta_id=eq.${encodeURIComponent(conta)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(desde)}&select=itens&limit=1000&offset=${off}`);
    out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function analisarCliente({ sbSelect, sbUpsert, t }, cli, vinculos, limiteMs = 120000) {
  const ini = Date.now();
  const contas = (vinculos || []).map(ct => ({ mkt: MKT(ct.marketplace), id: contaDe(ct) })).filter(x => x.mkt && x.id);
  const desde = new Date(Date.now() - 30 * 864e5).toISOString();
  const erros = [];

  // 1) produtos vendidos por canal (mesmo anúncio somado; o anúncio de origem é o da conta que mais vendeu)
  const porItem = new Map();
  for (const ct of contas) {
    let peds = [];
    try { peds = await vendas30(sbSelect, ct.mkt, ct.id, desde); } catch (e) { erros.push(`${ct.mkt} ${ct.id}: ${e.message}`); continue; }
    for (const p of peds) for (const i of (Array.isArray(p.itens) ? p.itens : [])) {
      const k = `${ct.mkt}:${ct.id}:${i.item_id || i.sku || i.nome}`;
      const x = porItem.get(k) || { mkt: ct.mkt, conta: ct.id, item_id: String(i.item_id || ''), nome: String(i.nome || ''), sku: String(i.sku || ''), unid: 0, receita: 0 };
      const q = parseInt(i.qtd) || 1; x.unid += q; x.receita += q * (parseFloat(i.preco) || 0);
      porItem.set(k, x);
    }
  }
  // 2) junta o mesmo produto entre canais (SKU igual ou título parecido), do que mais fatura para o que menos
  const produtos = [];
  for (const x of [...porItem.values()].sort((a, b) => b.receita - a.receita)) {
    const tk = tokens(x.nome), sku = normSku(x.sku);
    let p = produtos.find(p => (sku && p.skus.has(sku)) || parecido(p.tk, tk));
    if (!p) { p = { nome: x.nome, tk, skus: new Set(), canais: {}, unid: 0, receita: 0, fonte: x }; produtos.push(p); }
    if (sku) p.skus.add(sku);
    const c = p.canais[x.mkt] = p.canais[x.mkt] || { unid: 0, receita: 0 };
    c.unid += x.unid; c.receita += x.receita; p.unid += x.unid; p.receita += x.receita;
    if (['ml', 'shopee'].includes(x.mkt) && !['ml', 'shopee'].includes(p.fonte.mkt)) p.fonte = x; // origem com foto e descrição lidas pela integração
  }
  const totMkt = {}; for (const x of porItem.values()) totMkt[x.mkt] = (totMkt[x.mkt] || 0) + x.unid;
  const totUnid = Object.values(totMkt).reduce((s, v) => s + v, 0);

  // 3) catálogo ativo do ML e da Shopee (produto que existe sem ter vendido no mês também conta como "já está")
  const catalogo = {};
  for (const ct of contas.filter(c => COM_CATALOGO[c.mkt])) {
    if (Date.now() - ini > limiteMs * 0.6) { erros.push(`${ct.mkt} ${ct.id}: catálogo não lido (tempo)`); continue; }
    try {
      const ans = await COM_CATALOGO[ct.mkt](t, ct.id);
      const cat = catalogo[ct.mkt] = catalogo[ct.mkt] || { skus: new Set(), tks: [], n: 0 };
      const vistos = new Set();
      for (const a of ans) {
        if (a.sku) cat.skus.add(normSku(a.sku));
        if (!vistos.has(a.id)) { vistos.add(a.id); cat.tks.push(tokens(String(a.nome).split(' — ')[0])); cat.n++; }
      }
    } catch (e) { erros.push(`${ct.mkt} ${ct.id}: ${e.message}`); }
  }

  // 4) oportunidades: produto com venda (≥ 2 un. no mês) que falta num canal
  const temConta = m => contas.some(c => c.mkt === m);
  const fatorDe = m => {
    if (!temConta(m) || !totMkt[m]) return FATOR[m];
    const outros = totUnid - totMkt[m];
    return outros > 0 ? Math.min(0.8, Math.max(0.1, totMkt[m] / outros)) : FATOR[m];
  };
  const oportunidades = [];
  for (const p of produtos.filter(p => p.unid >= 2).slice(0, 80)) {
    for (const m of ALVOS) {
      if (p.canais[m]) continue;
      const cat = catalogo[m];
      if (cat && ([...p.skus].some(s => cat.skus.has(s)) || cat.tks.some(tk => parecido(tk, p.tk)))) continue;
      const f = fatorDe(m);
      oportunidades.push({
        nome: p.nome.slice(0, 120), alvo: m, temConta: temConta(m), confere: !cat && temConta(m), // conta sem catálogo lido: pode já existir sem venda
        canais: Object.fromEntries(Object.entries(p.canais).map(([k, c]) => [k, { unid: c.unid, receita: Math.round(c.receita) }])),
        fonte: { mkt: p.fonte.mkt, conta: p.fonte.conta, item_id: p.fonte.item_id, sku: p.fonte.sku, preco: p.fonte.unid ? r2(p.fonte.receita / p.fonte.unid) : null },
        unid30: p.unid, receita30: Math.round(p.receita), fator: r2(f), unid_est: r1(p.unid * f), receita_est: Math.round(p.receita * f),
      });
    }
  }
  oportunidades.sort((a, b) => b.receita_est - a.receita_est);

  const canais = Object.fromEntries(ALVOS.map(m => [m, { conta: temConta(m), contas: contas.filter(c => c.mkt === m).map(c => c.id), unid30: totMkt[m] || 0, catalogo: catalogo[m]?.n ?? null }]));
  const resumo = { unid_est: 0, receita_est: 0, porAlvo: {} }; // a tela lista os clientes só com isto (as oportunidades carregam ao abrir)
  for (const o of oportunidades) {
    const r = resumo.porAlvo[o.alvo] = resumo.porAlvo[o.alvo] || { n: 0, unid_est: 0, receita_est: 0 };
    r.n++; r.unid_est = r1(r.unid_est + o.unid_est); r.receita_est += o.receita_est;
    resumo.unid_est = r1(resumo.unid_est + o.unid_est); resumo.receita_est += o.receita_est;
  }
  const cursor = { em: new Date().toISOString(), cliente: { id: String(cli.id), nome: cli.nome || '' }, base: { unid30: totUnid, receita30: Math.round([...porItem.values()].reduce((s, x) => s + x.receita, 0)), produtos: produtos.length }, canais, resumo, oportunidades: oportunidades.slice(0, 200), total: oportunidades.length, erros: erros.slice(0, 10), ms: Date.now() - ini };
  await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: `cliente:${cli.id}`, recurso: 'expansao', ultima_tentativa: cursor.em, ultimo_sucesso: cursor.em, cursor }, 'marketplace,conta_id,recurso');
  return { cliente: cli.nome, oportunidades: oportunidades.length, unid_est: r1(oportunidades.reduce((s, o) => s + o.unid_est, 0)), erros: erros.length, ms: cursor.ms };
}

// Rodada: clientes com conta vinculada cuja análise tem mais de 3 dias (ou nunca rodou), até o tempo acabar
async function rodada(h, { clienteId = null, limiteMs = 230000 } = {}) {
  const ini = Date.now();
  const [clientes, vinc, feitos] = await Promise.all([
    h.lerStorage('glr_clientes').then(x => x || []), h.lerStorage('glr_mc_vinculos').then(x => x || {}),
    h.sbSelect('glr_sync_estado', 'marketplace=eq.sistema&recurso=eq.expansao&select=conta_id,ultimo_sucesso').catch(() => []),
  ]);
  const quando = new Map(feitos.map(r => [r.conta_id, r.ultimo_sucesso]));
  const fila = clientes.filter(c => (vinc[String(c.id)] || []).length && (clienteId ? String(c.id) === String(clienteId) : !/inativ|cancel/i.test(c.status || '')))
    .filter(c => clienteId || !quando.get(`cliente:${c.id}`) || Date.now() - Date.parse(quando.get(`cliente:${c.id}`)) > 3 * 864e5)
    .sort((a, b) => String(quando.get(`cliente:${a.id}`) || '').localeCompare(String(quando.get(`cliente:${b.id}`) || '')));
  const feitosAgora = [];
  for (const c of fila) {
    const resta = limiteMs - (Date.now() - ini);
    if (resta < 40000 && feitosAgora.length) break;
    try { feitosAgora.push(await analisarCliente(h, c, vinc[String(c.id)], Math.min(150000, resta))); }
    catch (e) { feitosAgora.push({ cliente: c.nome, erro: e.message }); }
  }
  return { fila: fila.length, analisados: feitosAgora };
}

module.exports = { analisarCliente, rodada, parecido, tokens };
