// ============================================================
// GLR Copiloto ADS — inteligência de ADS (etapa 1, sem servidor)
// ------------------------------------------------------------
// Busca, com a sessão do usuário (via ponte.js), os mesmos dados que o Mercado
// Ads usa nas telas — campanhas com métricas por janela, métricas por dia,
// histórico de alterações e anúncios com diagnóstico — e aplica as regras da GLR:
//  • escada 7/15/30 dias terminando em D-2 (atribuição dos últimos dias ainda incompleta);
//    só decide quando as janelas concordam;
//  • confiança pelo volume (vendas) define o tamanho do ajuste;
//  • aguardar: campanha criada há < 14 dias ou ROAS/orçamento mudado há < 7 dias;
//  • gargalo: orçamento (gasto/dia perto do orçamento) × lance (ROAS objetivo) × mercado (SOV alto);
//  • orgânico forte: o ADS pode estar pagando venda que viria de graça;
//  • anúncio: conversão esperada pela CVR da campanha, buy box, estoque, foto, experiência.
// Expõe window.__glrIA.analisar(cfg) → mesma forma da análise da tela, com campos extras.
// ============================================================
(function () {
  if (window.__glrIA) return;
  let seq = 0; const pend = new Map();
  window.addEventListener('message', e => { const m = e.data; if (e.source === window && m && m.glr === 'resp' && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const get = caminho => new Promise(res => {
    const id = `g${++seq}`, t = setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({ ok: false, erro: 'tempo esgotado' }); } }, 20000);
    pend.set(id, r => { clearTimeout(t); res(r); }); window.postMessage({ glr: 'req', id, caminho }, '*');
  });
  const diasAtras = n => { const d = new Date(Date.now() - 3 * 3600e3); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const ATE = () => diasAtras(2); // D-2
  const JAN = [7, 15, 30];
  const cache = new Map();
  async function getJ(caminho, ttl = 10 * 60e3) {
    const c = cache.get(caminho); if (c && Date.now() - c.em < ttl) return c.j;
    const r = await get(caminho); if (!r.ok || !r.json) throw new Error(r.erro || `Mercado Ads respondeu ${r.status}`);
    cache.set(caminho, { em: Date.now(), j: r.json }); return r.json;
  }
  const anunciante = () => { const q = new URLSearchParams(location.search); return q.get('advertiser_id') || q.get('advertiserId') || ''; };
  const linkCampanha = id => { const adv = anunciante(); return `${location.origin}${location.pathname.replace(/\/campaigns.*$/, '')}/campaigns/${id}/dashboard${adv ? `?advertiser_id=${adv}` : ''}`; };
  const r1 = v => Math.round(v * 10) / 10, br = v => String(r1(v)).replace('.', ',');

  async function campanhasJanela(dias) {
    const de = diasAtras(dias + 1), ate = ATE(), out = [];
    for (let off = 0; off < 300; off += 50) {
      const j = await getJ(`/campaigns/search?dateFrom=${de}&dateTo=${ate}&limit=50&offset=${off}`);
      out.push(...(j.results || [])); if ((j.results || []).length < 50) break;
    }
    return out;
  }
  async function ultimaMudanca(id) {
    try {
      const j = await getJ(`/campaigns/${id}/events?dateFrom=${diasAtras(45)}&dateTo=${diasAtras(0)}&isCbt=false`, 30 * 60e3);
      const ev = (j.result || []).map(e => ({ t: Date.parse(e.eventTime), tipo: e.eventType, de: e.eventData?.[0]?.prevValue, para: e.eventData?.[0]?.newValue })).filter(e => e.t).sort((a, b) => b.t - a.t)[0];
      return ev || null;
    } catch (e) { return null; }
  }
  const classe = (m, meta) => {
    if (!m) return 'pouco';
    const vend = m.unitsQuantity || 0, cli = m.clicks || 0;
    if (vend < 2 && cli < 40) return 'pouco';
    if (!vend) return (m.cost || 0) > 0 ? 'alto' : 'pouco';
    const acos = m.acos ?? (m.totalAmount ? m.cost / m.totalAmount * 100 : null);
    return acos == null ? 'pouco' : acos > meta * 1.2 ? 'alto' : acos < meta * 0.8 ? 'folga' : 'ok';
  };
  const conf = m30 => (m30?.unitsQuantity || 0) >= 15 ? 'alta' : (m30?.unitsQuantity || 0) >= 5 ? 'média' : 'baixa';

  async function decidirCampanha(c, w, metaCfg) {
    const meta = metaCfg || c.acosTarget || (c.roasTarget ? 100 / c.roasTarget : 10);
    const esc = JAN.map(d => ({ d, cl: classe(w[d], meta), acos: w[d]?.unitsQuantity ? (w[d].acos ?? null) : null }));
    const [e7, e15, e30] = esc, m7 = w[7] || {}, m30 = w[30] || {};
    const orc = c.budget || c.dailyBudget || 0, uso = orc ? (m7.cost || 0) / 7 / orc : null;
    const sov = m30.sov ?? null, org = m30.organicUnitsQuantity || 0, adsU = m30.unitsQuantity || 0;
    const notas = [], cf = conf(m30);
    if (org >= 2 * Math.max(1, adsU) && org >= 4) notas.push(`Orgânico forte: ${org} vendas orgânicas dos anúncios contra ${adsU} pelo ADS — parte do ADS pode estar pagando venda que viria de graça.`);
    if (sov != null) notas.push(`SOV ${br(sov)}% (espaço que a campanha ocupa no leilão).`);
    const idade = c.dateCreated ? (Date.now() - Date.parse(c.dateCreated)) / 864e5 : 99;
    const base = { meta, esc, uso, sov, conf: cf, notas, roasObj: c.roasTarget, orc };
    if (c.status !== 'active') return { ...base, v: 'semdados', motivo: 'Campanha pausada.', acao: e30.cl === 'folga' ? 'Vendia com folga: vale reativar.' : 'Sem mudança.' };
    if (!m30.cost && !adsU) return { ...base, v: 'semdados', motivo: 'Sem investimento em 30 dias.', acao: (c.visibleAdGroupCount || 0) ? 'Confira se os anúncios competem e se o ROAS objetivo não está alto demais.' : 'Campanha sem anúncios.' };
    if ((w[15]?.cost || 0) >= 40 && !(w[15]?.unitsQuantity)) return { ...base, v: 'corrigir', motivo: `Investiu R$ ${br(w[15].cost)} em 15 dias sem venda atribuída.`, acao: 'Abra a campanha e retire os anúncios que gastam sem vender; se nenhum vende, pause.' };
    const mudou = await ultimaMudanca(c.id), diasMud = mudou ? (Date.now() - mudou.t) / 864e5 : 99;
    const oQue = !mudou ? '' : /roas|acos/i.test(mudou.tipo) && mudou.para != null ? `ROAS objetivo mudado de ${br(mudou.de)}x para ${br(mudou.para)}x` : /budget/i.test(mudou.tipo) && mudou.para != null ? `Orçamento mudado de R$ ${mudou.de} para R$ ${mudou.para}` : 'Campanha alterada';
    const forte = e7.cl === 'alto' && e15.cl === 'alto' && (e15.acos || 0) > meta * 2;
    if (!forte && (idade < 14 || diasMud < 7)) return { ...base, v: 'aguardar', motivo: idade < 14 ? `Campanha criada há ${Math.floor(idade)} dias: o Mercado Ads ainda está aprendendo.` : `${oQue} há ${Math.floor(diasMud)} dia(s): o efeito leva de 7 a 14 dias.`, acao: 'Espere antes de mexer de novo.' };
    const lim = cf === 'alta' ? 0.25 : cf === 'média' ? 0.15 : 0.08;
    if ((e15.cl === 'alto' && e30.cl === 'alto' && e7.cl !== 'folga') || forte) {
      const acosRef = e15.acos || e30.acos || meta, fator = Math.min(1 + lim, Math.max(1.05, acosRef / meta));
      const novo = c.roasTarget ? r1(c.roasTarget * fator) : null;
      return { ...base, v: 'conter', motivo: e15.acos == null && e30.acos == null ? `Cliques sem venda em 15 e 30 dias (investiu R$ ${br(m30.cost || 0)} em 30 dias).` : `ACOS acima da meta (${br(meta)}%) em 15 e 30 dias: ${e15.acos != null ? br(e15.acos) + '%' : 'sem venda'} e ${e30.acos != null ? br(e30.acos) + '%' : 'sem venda'}.`, acao: novo ? `Subir o ROAS objetivo de ${br(c.roasTarget)}x para ${br(novo)}x.` : 'Reduzir o orçamento.', novoRoas: novo };
    }
    if (e7.cl === 'folga' && e15.cl === 'folga' && e30.cl !== 'alto') {
      if (uso != null && uso >= 0.85) { const novoOrc = Math.round(orc * (1 + Math.min(0.3, lim + 0.05))); return { ...base, v: 'escalar', gargalo: 'orçamento', motivo: `ACOS com folga em 7 e 15 dias (${br(e7.acos ?? 0)}% e ${br(e15.acos ?? 0)}%, meta ${br(meta)}%) e o gasto já usa ${Math.round(uso * 100)}% do orçamento.`, acao: `Aumentar o orçamento de R$ ${orc} para R$ ${novoOrc}/dia.`, novoOrc }; }
      if (sov != null && sov >= 80) return { ...base, v: 'escalar', gargalo: 'mercado', motivo: `ACOS com folga, mas a campanha já ocupa ${br(sov)}% do espaço do leilão.`, acao: 'Baixar o ROAS rende pouco aqui: para crescer, coloque mais anúncios (produtos) nesta campanha.' };
      const acosRef = e15.acos || meta * 0.7, fator = Math.max(1 - lim, Math.min(0.95, acosRef / meta)), piso = metaCfg ? 100 / metaCfg : 1;
      const novo = c.roasTarget ? r1(Math.max(1, piso, c.roasTarget * fator)) : null;
      return { ...base, v: 'escalar', gargalo: 'lance', motivo: `ACOS com folga em 7 e 15 dias (${br(e7.acos ?? 0)}% e ${br(e15.acos ?? 0)}%, meta ${br(meta)}%) e o orçamento sobra (${uso != null ? Math.round(uso * 100) + '% usado' : 'sem orçamento'}).`, acao: novo && novo < c.roasTarget ? `Baixar o ROAS objetivo de ${br(c.roasTarget)}x para ${br(novo)}x (lance mais agressivo).` : 'O ROAS objetivo já está no piso da meta.', novoRoas: novo && novo < c.roasTarget ? novo : null };
    }
    const div = esc.filter(x => x.cl !== 'pouco').map(x => x.cl);
    const motivo = !div.length ? 'Pouco volume em 7, 15 e 30 dias para decidir (menos de 2 vendas e 40 cliques em cada janela).'
      : new Set(div).size > 1 ? `Sinais divergentes: ${esc.filter(x => x.cl !== 'pouco').map(x => `${x.d} dias ${x.cl === 'folga' ? 'com folga' : x.cl === 'alto' ? 'acima' : 'na meta'}`).join(', ')}. Melhor não mexer ainda.`
      : div.length < 2 ? `Só a janela de ${esc.find(x => x.cl !== 'pouco').d} dias tem volume (${div[0] === 'alto' ? 'acima da meta' : div[0] === 'folga' ? 'com folga' : 'na meta'}): pouco dado recente para mexer.`
      : `ACOS perto da meta (${br(meta)}%).`;
    return { ...base, v: 'manter', motivo, acao: 'Sem mudança agora.' };
  }

  async function analisarLista(cfg) {
    const metaCfg = parseFloat(cfg?.metaAcos) || null;
    const por = new Map(), listas = await Promise.all(JAN.map(campanhasJanela));
    JAN.forEach((d, i) => { for (const c of listas[i]) { const x = por.get(c.id) || { c, w: {} }; x.w[d] = c.metrics || null; if (d === 30) x.c = c; por.set(c.id, x); } });
    const itens = [], fila = [...por.values()];
    await Promise.all(Array.from({ length: 6 }, async () => { while (fila.length) { const { c, w } = fila.shift();
      const dec = await decidirCampanha(c, w, metaCfg);
      itens.push({ id: String(c.id), nome: c.name, href: linkCampanha(c.id),
        invest: { v: w[30]?.cost || 0 }, receita: { v: w[30]?.totalAmount || 0 }, vendas: { v: w[30]?.unitsQuantity || 0 }, acos: { v: w[30]?.acos ?? null }, roas: { v: w[30]?.roas ?? null }, ...dec });
    } }));
    const PR = { corrigir: 0, conter: 1, escalar: 2, aguardar: 3, manter: 4, semdados: 5 };
    itens.sort((a, b) => PR[a.v] - PR[b.v] || (b.invest.v || 0) - (a.invest.v || 0));
    const tot = itens.reduce((s, x) => ({ invest: s.invest + x.invest.v, receita: s.receita + x.receita.v, vendas: s.vendas + x.vendas.v }), { invest: 0, receita: 0, vendas: 0 });
    return { tipo: 'lista', fonte: 'api', dias: 30, ate: ATE(), metaCfg, tot, itens };
  }

  async function analisarCampanha(id, cfg) {
    const metaCfg = parseFloat(cfg?.metaAcos) || null;
    const adv0 = anunciante();
    const jan = {}, listas = await Promise.all(JAN.map(campanhasJanela)); JAN.forEach((d, i) => { jan[d] = listas[i].find(c => String(c.id) === String(id)); });
    const c = jan[30] || jan[15] || jan[7]; if (!c) throw new Error('campanha não encontrada');
    const w = {}; for (const d of JAN) w[d] = jan[d]?.metrics || null;
    const vc = await decidirCampanha(c, w, metaCfg);
    try {
      const ds = (await getJ(`/campaigns/metrics?dateFrom=${diasAtras(15)}&dateTo=${ATE()}&campaignId=${id}`)).daily?.results || [];
      const orc = c.budget || 0, cheios = orc ? ds.filter(d => d.cost >= orc * 0.9).length : 0;
      if (orc && ds.length) vc.notas.push(`Bateu o orçamento em ${cheios} de ${ds.length} dias.`);
      const semVenda = ds.slice(-7).filter(d => d.cost > 0 && !d.unitsQuantity).length; if (semVenda >= 5) vc.notas.push(`${semVenda} dos últimos 7 dias gastaram sem vender.`);
    } catch (e) {}
    const meta = vc.meta, cvrCamp = w[30]?.clicks ? (w[30].unitsQuantity || 0) / w[30].clicks : 0;
    // a API de anúncios aceita no máximo 50 por página
    const a30 = { results: [] };
    for (let off = 0; off < 500; off += 50) {
      const j = await getJ(`/ads?dateFrom=${diasAtras(31)}&dateTo=${ATE()}&limit=50&offset=${off}&advertiserId=${adv0 || c.advertiserId || ''}&campaignId=${id}`);
      a30.results.push(...(j.results || [])); if ((j.results || []).length < 50) break;
    }
    const ticket = w[30]?.unitsQuantity ? w[30].totalAmount / w[30].unitsQuantity : null;
    const itens = (a30.results || []).map(a => {
      const sold = a.soldQuantityTotal || 0, cli = a.clicks || 0, cost = a.cost || 0, imp = a.impressions || 0, acos = a.amountTotal ? cost / a.amountTotal * 100 : null;
      const esperado = cli * cvrCamp, limite = Math.max(40, ticket && meta ? ticket * meta / 100 * 1.5 : 0), vr = a.variants || {}, prob = [];
      if (vr.noImmediateStock) prob.push('sem estoque imediato'); if (vr.poorImageQuality) prob.push('foto de baixa qualidade'); if (vr.badExperience) prob.push('experiência ruim');
      const ptw = a.item?.priceToWin; if (a.catalogListing && ptw && ptw.status && ptw.status !== 'winning') prob.push(`perdendo a buy box do catálogo${ptw.price_to_win || ptw.price ? ` (preço para ganhar R$ ${ptw.price_to_win || ptw.price})` : ''}`);
      if (/RED/i.test(a.currentLevel || '')) prob.push('competitividade baixa');
      const ctr = imp ? cli / imp * 100 : null, conv = cli ? sold / cli * 100 : null;
      const base = { id: a.externalId || a.id, nome: a.title, status: a.status, imp: { v: imp }, cli: { v: cli }, cpc: { v: a.cpc }, vendas: { v: sold }, receita: { v: a.amountTotal || 0 }, invest: { v: cost }, acos: { v: acos }, ctr, conv, prob };
      if (!imp && !cost) return { ...base, v: 'semdados', motivo: prob.length ? `Não aparece: ${prob.join(', ')}.` : a.status !== 'A' ? 'Anúncio pausado ou inativo.' : 'Sem impressões em 30 dias.', acao: 'Confira estoque, preço e se o anúncio está ativo.' };
      if (!sold && cost >= limite && (esperado >= 1.5 || cli >= 40)) return { ...base, v: 'retirar', motivo: `Investiu R$ ${br(cost)} com ${cli} cliques e nenhuma venda (pela conversão da campanha, eram esperadas ~${br(esperado)}).${prob.length ? ` Atenção: ${prob.join(', ')}.` : ''}`, acao: prob.length ? `Resolva primeiro: ${prob.join(', ')}; se não der, pause o anúncio.` : 'Pausar o anúncio nesta campanha.' };
      if (!sold && esperado >= 1) return { ...base, v: 'avaliar', motivo: `${cli} cliques sem venda (esperadas ~${br(esperado)}): atrai, mas não converte.${prob.length ? ` ${prob.join(', ')}.` : ''}`, acao: 'Revise preço, frete, fotos e ficha antes de investir mais.' };
      if (prob.length && cost > 0) return { ...base, v: 'avaliar', motivo: `Anúncio com problema: ${prob.join(', ')}.`, acao: 'Corrija para o ADS render mais.' };
      if (ctr != null && imp >= 3000 && ctr < 0.25) return { ...base, v: 'avaliar', motivo: `CTR de ${br(ctr)}% em ${imp.toLocaleString('pt-BR')} impressões: aparece, mas quase ninguém clica.`, acao: 'Melhore a foto principal, o título e o preço.' };
      if (meta && acos != null && sold >= 2 && acos > meta * 1.5) return { ...base, v: 'mover', motivo: `ACOS de ${br(acos)}% com ${sold} vendas: muito acima da meta (${br(meta)}%).`, acao: 'Mover para uma campanha com ROAS objetivo maior (mais conservadora).' };
      if (meta && acos != null && sold >= 3 && acos <= meta * 0.6) return { ...base, v: 'escalar', motivo: `ACOS de ${br(acos)}% com ${sold} vendas: bem abaixo da meta (${br(meta)}%).`, acao: 'Candidato a uma campanha própria, mais agressiva.' };
      return { ...base, v: 'manter', motivo: sold ? `${sold} venda(s) com ACOS de ${acos != null ? br(acos) + '%' : '—'}.` : 'Ainda pouco clique para concluir.', acao: 'Sem mudança agora.' };
    });
    const PR = { retirar: 0, mover: 1, avaliar: 2, escalar: 3, manter: 4, semdados: 5 };
    itens.sort((a, b) => PR[a.v] - PR[b.v] || (b.invest.v || 0) - (a.invest.v || 0));
    const tot = itens.reduce((s, a) => ({ invest: s.invest + a.invest.v, receita: s.receita + a.receita.v, vendas: s.vendas + a.vendas.v, cli: s.cli + a.cli.v, imp: s.imp + a.imp.v }), { invest: 0, receita: 0, vendas: 0, cli: 0, imp: 0 });
    return { tipo: 'campanha', fonte: 'api', campanha: id, dias: 30, ate: ATE(), cab: { roasObj: c.roasTarget, orc: c.budget, diag: '' }, meta, tot, vc, itens };
  }

  async function analisar(cfg) {
    const camp = (location.pathname.match(/campaigns\/(\d+)\/dashboard/) || [])[1];
    if (camp) return analisarCampanha(camp, cfg);
    if (/\/product-ads\/admin\/campaigns\/?$/.test(location.pathname)) return analisarLista(cfg);
    return null;
  }
  window.__glrIA = { analisar, limparCache: () => cache.clear() };
})();
