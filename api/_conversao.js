// ============================================================
// GLR Consultoria — Agente de Conversão no Mercado Livre
// ------------------------------------------------------------
// Mais pedido nos clientes atuais (a comissão GLR é por venda):
//  1) Catálogo / Buy Box — para os anúncios de catálogo que mais vendem, o preço
//     que ganha (ml_catalog_price_to_win) e a margem nesse preço (custo e taxas
//     do agente de Estoque e Margem, recurso 'sinais'). Perdendo e cabendo na
//     margem mínima → sugestão "baixar para R$ X" na Caixa de decisões; preço
//     vindo de promoção não é mexido (a sugestão diz para ajustar a promoção).
//     O ML também diz o que ajuda a ganhar sem baixar preço (boosts: parcelamento
//     sem juros, Full, envio no dia) — vai junto.
//  2) Elegível e fora do catálogo — anúncio com produto de catálogo
//     (tag catalog_listing_eligible) que não entrou → sugestão "entrar no catálogo".
//  3) Perguntas sem resposta há mais de 1 h (dados do agente de Reputação, a cada
//     30 min) → aviso no celular, de hora em hora, das 8h às 22h.
// NADA muda sozinho: preço e entrada no catálogo só com "Aprovar" (Caixa de
// decisões / tela Catálogo e Buy Box). Estado: glr_sync_estado ml / <conta> /
// conversao; perguntas avisadas em sistema / perguntas / todas.
// ============================================================

const corpo = r => r?.data?.body || r?.body || (r?.data && !Array.isArray(r.data) && (r.data.results || r.data.status) ? r.data : null) || r;
const r1 = v => Math.round(v * 10) / 10;
const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const POR_CONTA = { catalogo: 40, caixaPreco: 3, caixaOptin: 3 };

// margem (%) num preço novo pela mesma conta do agente de Margem: m = (p·rz − custo − p·aliq) / p
function margemNoPreco(s, preco) {
  if (!s || s.c == null || s.rz == null || s.m == null || !(s.p > 0) || !(preco > 0)) return null;
  const aliq = s.rz - s.c / s.p - s.m / 100; // a alíquota sai da margem que o agente já calculou
  return r1((s.rz - s.c / preco - aliq) * 100);
}

async function emLotes(lista, n, fn) { const out = []; for (let i = 0; i < lista.length; i += n) out.push(...await Promise.all(lista.slice(i, i + n).map(fn))); return out; }

async function analisarConta({ sbSelect, sbUpsert, sbInsert, t }, conta, nomeCliente) {
  const ini = Date.now();
  const sinais = (await sbSelect('glr_sync_estado', `marketplace=eq.ml&conta_id=eq.${encodeURIComponent(conta)}&recurso=eq.sinais&select=cursor`).catch(() => []))[0]?.cursor || {};
  const sItens = sinais.itens || {}, margemMin = parseFloat(sinais.margem_minima) || 5;
  // anúncios ativos, os que mais venderam primeiro (até 600)
  const ans = [];
  for (let off = 0; off < 600; off += 100) {
    const r = await t('list_items', { meliUserId: conta, status: 'active', limit: 100, offset: off, sort: 'total_sold_quantity_desc' });
    const res = (r?.results || r?.data?.results || []).map(e => e?.body || e).filter(b => b?.id);
    ans.push(...res); if (res.length < 100) break;
  }
  const vende = b => sItens[b.id] ? { u30: sItens[b.id].u30 || 0, receita30: (sItens[b.id].u30 || 0) * (sItens[b.id].p || b.price || 0) } : { u30: 0, receita30: 0 };
  const ordem = (a, b) => vende(b).receita30 - vende(a).receita30 || (b.sold_quantity || 0) - (a.sold_quantity || 0);

  // 1) catálogo: preço para ganhar
  const cat = ans.filter(b => b.catalog_listing).sort(ordem);
  const lidos = await emLotes(cat.slice(0, POR_CONTA.catalogo), 5, async b => {
    try { return { b, p: corpo(await t('ml_catalog_price_to_win', { meliUserId: conta, item_id: b.id })) }; } catch (e) { return { b, erro: e.message }; }
  });
  const resumo = { anuncios: ans.length, catalogo: cat.length, lidos: lidos.length, ganhando: 0, perdendo: 0, dividindo: 0, elegiveis: 0 };
  const perdendo = [], dividindo = [];
  for (const { b, p } of lidos) {
    if (!p || !p.status) continue;
    const v = vende(b), s = sItens[b.id];
    const boosts = (p.boosts || []).filter(x => x.status === 'opportunity').map(x => x.id);
    if (p.status === 'winning') { resumo.ganhando++; continue; }
    const atual = parseFloat(p.current_price ?? b.price) || 0, ptw = parseFloat(p.price_to_win) || null;
    const base = { item_id: b.id, titulo: String(b.title || '').slice(0, 90), preco: atual, preco_cheio: parseFloat(b.price) || atual, promo: atual < (parseFloat(b.price) || 0) - 0.01,
      tem_variacao: Array.isArray(b.variations) && b.variations.length > 0, u30: v.u30, receita30: Math.round(v.receita30), boosts, vencedor: parseFloat(p.winner?.price) || null,
      margem: s?.m ?? null, custo: s?.c ?? null, foto: String(b.thumbnail || '').replace(/^http:/, 'https:') };
    if (p.status === 'sharing_first_place') { resumo.dividindo++; dividindo.push({ ...base, preco_ganhar: ptw }); continue; }
    if (p.status !== 'competing') continue;
    resumo.perdendo++;
    const mNova = ptw ? margemNoPreco(s, ptw) : null;
    perdendo.push({ ...base, preco_ganhar: ptw, queda_pct: ptw && atual ? r1((1 - ptw / atual) * 100) : null, margem_nova: mNova,
      cabe: ptw != null && (mNova == null ? null : mNova >= margemMin), margem_minima: margemMin });
  }
  perdendo.sort((a, b) => b.receita30 - a.receita30 || b.u30 - a.u30);
  // 2) elegíveis fora do catálogo
  const elegiveis = ans.filter(b => !b.catalog_listing && b.catalog_product_id && (b.tags || []).includes('catalog_listing_eligible')).sort(ordem).slice(0, 60)
    .map(b => ({ item_id: b.id, titulo: String(b.title || '').slice(0, 90), preco: parseFloat(b.price) || 0, catalog_product_id: b.catalog_product_id, u30: vende(b).u30, receita30: Math.round(vende(b).receita30), vendidos: b.sold_quantity || 0, foto: String(b.thumbnail || '').replace(/^http:/, 'https:') }));
  resumo.elegiveis = elegiveis.length;

  // 3) Caixa de decisões: os melhores de cada conta (o que já está pendente ou foi resolvido há menos de 7 dias não repete)
  const desde = new Date(Date.now() - 7 * 864e5).toISOString();
  const recentes = new Set((await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(conta)}&tipo=eq.alerta&dados->>acao=in.(buybox_preco,catalogo_optin)&or=(resultado.eq.so_alerta,criado_em.gte.${encodeURIComponent(`"${desde}"`)})&select=dados&limit=500`).catch(() => [])).map(l => l.dados?.chave));
  const log = (titulo, explicacao, dados) => sbInsert('glr_agente_log', { conta_id: conta, cliente_nome: nomeCliente || null, tipo: 'alerta', titulo, explicacao, dados: { marketplace: 'ml', ...dados }, resultado: 'so_alerta', origem: 'cron' }).catch(() => {});
  let nPreco = 0, nOptin = 0;
  const BOOST = { free_installments: 'parcelamento sem juros', fulfillment: 'Full', same_day_shipping: 'envio no mesmo dia', free_shipping: 'frete grátis', shipping_collect: 'coleta' };
  for (const x of perdendo.filter(x => x.cabe && !x.promo && x.u30 >= 1)) {
    if (nPreco >= POR_CONTA.caixaPreco) break;
    const chave = `bb:${x.item_id}`; if (recentes.has(chave)) continue;
    await log(`Ganhar o catálogo — ${x.titulo.slice(0, 60)}`,
      `O anúncio está perdendo a Buy Box do catálogo: hoje a ${R$(x.preco)}, ganha a ${R$(x.preco_ganhar)} (−${String(x.queda_pct).replace('.', ',')}%). A margem fica em ${String(x.margem_nova).replace('.', ',')}% (mínima ${margemMin}%). Vendeu ${x.u30} un. em 30 dias perdendo a vitrine.${x.boosts.length ? ` O ML também ajuda a ganhar com: ${x.boosts.map(b => BOOST[b] || b).join(', ')}.` : ''}`,
      { acao: 'buybox_preco', chave, item_id: x.item_id, preco_atual: x.preco, preco_sugerido: x.preco_ganhar, tem_variacao: x.tem_variacao, margem_atual: x.margem, margem_nova: x.margem_nova, produto: x.titulo, impacto: Math.round(x.receita30 / 30 * 7), impacto_tipo: 'ganho' });
    nPreco++;
  }
  for (const x of elegiveis.filter(x => x.u30 >= 2)) {
    if (nOptin >= POR_CONTA.caixaOptin) break;
    const chave = `cat:${x.item_id}`; if (recentes.has(chave)) continue;
    await log(`Entrar no catálogo — ${x.titulo.slice(0, 60)}`,
      `O anúncio pode entrar no catálogo do ML (produto ${x.catalog_product_id}) e ainda não está nele. Vendeu ${x.u30} un. em 30 dias fora da vitrine do catálogo, que concentra a maior parte das vendas desse produto. Ao aprovar, o ML cria a publicação de catálogo ligada a este anúncio, com o mesmo preço.`,
      { acao: 'catalogo_optin', chave, item_id: x.item_id, catalog_product_id: x.catalog_product_id, produto: x.titulo, impacto: Math.round(x.receita30 / 30 * 7 * 0.3), impacto_tipo: 'ganho' });
    nOptin++;
  }

  const cursor = { em: new Date().toISOString(), resumo, margem_minima: margemMin, perdendo, dividindo, elegiveis, ms: Date.now() - ini };
  await sbUpsert('glr_sync_estado', { marketplace: 'ml', conta_id: conta, recurso: 'conversao', ultima_tentativa: cursor.em, ultimo_sucesso: cursor.em, cursor }, 'marketplace,conta_id,recurso');
  return { conta, ...resumo, caixa: nPreco + nOptin, ms: cursor.ms };
}

// Rodada: contas ML ainda não analisadas hoje, até o tempo acabar
async function rodada(h, { conta = null, limiteMs = 240000 } = {}) {
  const ini = Date.now(), hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const [clientes, vinc, feitos] = await Promise.all([
    h.lerStorage('glr_clientes').then(x => x || []), h.lerStorage('glr_mc_vinculos').then(x => x || {}),
    h.sbSelect('glr_sync_estado', 'marketplace=eq.ml&recurso=eq.conversao&select=conta_id,ultimo_sucesso').catch(() => []),
  ]);
  const quando = new Map(feitos.map(r => [String(r.conta_id), r.ultimo_sucesso]));
  const contas = [];
  for (const c of clientes) for (const ct of (vinc[String(c.id)] || [])) {
    if (!['meli', 'ml', 'mercadolivre'].includes(String(ct.marketplace || '').toLowerCase())) continue;
    const id = String(ct.param_to_use?.meliUserId || ct.external_id || ''); if (id && !contas.some(x => x.id === id)) contas.push({ id, nome: c.nome });
  }
  const fila = contas.filter(x => conta ? x.id === String(conta) : !quando.get(x.id) || new Date(Date.parse(quando.get(x.id)) - 3 * 3600e3).toISOString().slice(0, 10) < hoje)
    .sort((a, b) => String(quando.get(a.id) || '').localeCompare(String(quando.get(b.id) || '')));
  const out = [];
  for (const x of fila) {
    if (Date.now() - ini > limiteMs - 45000 && out.length) break;
    try { out.push(await analisarConta(h, x.id, x.nome)); } catch (e) { out.push({ conta: x.id, erro: e.message }); }
  }
  return { fila: fila.length, analisadas: out };
}

// Perguntas sem resposta há mais de 1 h: um aviso por hora com as novas (cada pergunta avisa uma vez)
async function avisarPerguntas({ sbSelect, sbUpsert, lerStorage }, simular = false) {
  const [rows, vinc, clientes, est] = await Promise.all([
    sbSelect('glr_sync_estado', 'marketplace=eq.ml&recurso=eq.reputacao&select=conta_id,perg:cursor->perguntas').catch(() => []),
    lerStorage('glr_mc_vinculos').then(x => x || {}), lerStorage('glr_clientes').then(x => x || []),
    sbSelect('glr_sync_estado', 'marketplace=eq.sistema&conta_id=eq.perguntas&recurso=eq.todas&select=cursor').then(r => r[0]?.cursor || {}).catch(() => ({})),
  ]);
  const nomeDe = new Map();
  for (const [cid, cs] of Object.entries(vinc)) for (const ct of cs || []) nomeDe.set(String(ct.param_to_use?.meliUserId || ct.external_id), clientes.find(c => String(c.id) === String(cid))?.nome || '');
  const avisadas = { ...(est.avisadas || {}) }, agora = Date.now();
  for (const [k, ts] of Object.entries(avisadas)) if (agora - ts > 4 * 864e5) delete avisadas[k];
  const novas = [], esperando = [];
  for (const r of rows) for (const p of (Array.isArray(r.perg) ? r.perg : [])) {
    const h = p.criada ? (agora - Date.parse(p.criada)) / 36e5 : 0;
    if (h < 1) continue;
    esperando.push({ conta: r.conta_id, h });
    if (!avisadas[p.id]) { novas.push({ conta: String(r.conta_id), id: p.id, h, titulo: p.titulo, rascunho: !!p.rascunho }); avisadas[p.id] = agora; }
  }
  const porLoja = {}; novas.forEach(n => { porLoja[n.conta] = (porLoja[n.conta] || 0) + 1; });
  const linhas = Object.entries(porLoja).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${nomeDe.get(c) || `ML ${c}`}: ${n}`);
  const titulo = `❓ ${novas.length} pergunta(s) sem resposta há mais de 1 h no ML`;
  const corpoTxt = `${linhas.join(' · ')}${novas.some(n => n.rascunho) ? ' — rascunhos prontos em Reputação e atendimento' : ''}`;
  if (simular) return { simulacao: true, esperando: esperando.length, novas: novas.length, titulo, corpo: corpoTxt };
  if (novas.length) await require('./_alerta').avisar(sbSelect, titulo, corpoTxt, 'perguntas-ml', '/#atendimento').catch(() => {});
  await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: 'perguntas', recurso: 'todas', ultima_tentativa: new Date().toISOString(), ultimo_sucesso: new Date().toISOString(), cursor: { em: new Date().toISOString(), esperando: esperando.length, avisadas } }, 'marketplace,conta_id,recurso');
  return { esperando: esperando.length, avisadas_agora: novas.length };
}

module.exports = { analisarConta, rodada, avisarPerguntas, margemNoPreco };
