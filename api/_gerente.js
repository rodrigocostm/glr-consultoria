// ============================================================
// GLR Consultoria — Gerente de Conta (agente central)
// ------------------------------------------------------------
// Todo dia às 08:00 (depois da revisão dos ADS das 07:00) junta, POR CLIENTE
// (todas as lojas), o que os outros agentes descobriram e monta o plano do dia
// para o analista: semáforo + diagnóstico, até 7 ações priorizadas (hoje /
// esta semana / pedir ao cliente) e a pauta do dia para conversar com o
// cliente. Uso interno da GLR.
//  • As AÇÕES saem por regra, com os números dos agentes (Estoque, Margem,
//    Promoções, Reputação, Qualidade, ADS e as medições de resultado) — nada
//    é inventado. Peso = urgência (prazo) + impacto em R$.
//  • A IA só escreve o diagnóstico e a pauta em português, a partir desses
//    fatos; sem a chave (ou se falhar), o texto sai montado por regra.
// Grava em glr_sync_estado: marketplace 'sistema', conta_id 'cliente:<id>',
// recurso 'plano'. Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

const MAX_ACOES = 7;
const { visitasItem, visitasConta } = require('./_funil');
const r1 = v => Math.round(v * 10) / 10;
const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const pct = v => v == null ? '—' : `${String(r1(v)).replace('.', ',')}%`;
const corta = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const mktDe = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : null; };
const isoBRT = (diasAtras = 0) => { const d = new Date(Date.now() - 3 * 3600e3); d.setUTCDate(d.getUTCDate() - diasAtras); return d.toISOString().slice(0, 10); };
const MKT_NOME = { ml: 'ML', shopee: 'Shopee' };

function somarDias(dias, de, ate) {
  const t = { faturamento: 0, ads: 0, pedidos: 0, cobre: false };
  for (const [d, v] of Object.entries(dias || {})) {
    if (d < de || d > ate) continue;
    t.cobre = true; t.faturamento += parseFloat(v.faturamento) || 0; t.ads += parseFloat(v.ads) || 0; t.pedidos += parseInt(v.pedidos) || 0;
  }
  return t;
}

// Ações candidatas de uma loja (cada agente contribui com o que sabe)
const generico = n => !n || /^(mercado ?livre|meli|ml|shopee)\s*[\d-]*$/i.test(String(n).trim());
const nomeLoja = L => `${MKT_NOME[L.mkt]} ${generico(L.nome) ? `(final ${String(L.conta).slice(-4)})` : L.nome}`;
const horasTxt = h => h == null ? '?' : h >= 48 ? `${Math.round(h / 24)} dias` : `${Math.round(h)} h`;

function acoesDaLoja(L, log) {
  const A = [], tag = nomeLoja(L);
  const add = (a) => A.push({ ...a, conta: L.conta, mkt: L.mkt, loja: tag });
  const rp = L.reputacao, sn = L.sinais, pr = L.promocoes, qa = L.qualidade;
  // Reputação e atendimento
  if (rp) {
    for (const c of (rp.reclamacoes || []).filter(c => c.prazo)) {
      const dias = Math.max(0, Math.round((new Date(c.prazo).getTime() - Date.now()) / 864e5));
      if (dias > 7) continue;
      add({ id: `rec:${L.conta}:${c.id}`, quando: 'hoje', quem: 'analista', tipo: 'reputacao', tela: 'atendimento',
        titulo: `${{ send_attachments: 'Enviar provas', send_message_to_mediator: 'Responder ao mediador', refund: 'Resolver reembolso' }[c.acao] || 'Agir'} na reclamação${c.produto ? ` — ${corta(c.produto, 40)}` : ''}`,
        porque: `prazo ${dias === 0 ? 'hoje' : `em ${dias} dia(s)`} (${c.etapa === 'dispute' ? 'mediação' : 'reclamação'} do pedido ${c.pedido}); perder o prazo derruba a reputação`, impacto: 'reputação', peso: 2000 - dias * 100 });
    }
    const np = rp.resumo?.perguntas || 0;
    if (np) add({ id: `perg:${L.conta}`, quando: 'hoje', quem: 'analista', tipo: 'atendimento', tela: 'atendimento',
      titulo: `Responder ${np} pergunta(s) sem resposta`, porque: `a mais antiga está há ${horasTxt(rp.resumo.perguntaMaisAntigaH)}${rp.resumo.rascunhos ? `; ${rp.resumo.rascunhos} já com rascunho do agente` : ''} — pergunta parada é venda perdida`, impacto: 'conversão', peso: 450 + Math.min(200, np * 40) });
    if (rp.resumo?.pedemResposta) add({ id: `devol:${L.conta}`, quando: 'hoje', quem: 'analista', tipo: 'atendimento', tela: 'atendimento',
      titulo: `Responder ${rp.resumo.pedemResposta} devolução(ões) na Shopee`, porque: 'a Shopee pede resposta da loja dentro do prazo', impacto: 'reputação', peso: 900 });
    if (rp.risco === 'alto') add({ id: `rep:${L.conta}`, quando: 'hoje', quem: 'analista', tipo: 'reputacao', tela: 'atendimento',
      titulo: 'Plano para recuperar a reputação', porque: `${rp.riscoMotivo || 'reputação em risco'} — enquanto isso o ADS não acelera a conta`, impacto: 'exposição', peso: 1500 });
  }
  // Estoque (o que mais vende primeiro)
  if (sn) {
    const its = Object.values(sn.itens || {});
    const acabando = its.filter(i => i.ne === 'zerado' || i.ne === 'critico').sort((a, b) => (b.vd * b.p) - (a.vd * a.p)).slice(0, 4);
    if (acabando.length) {
      const perda = acabando.reduce((s, i) => s + (i.vd || 0) * (i.p || 0) * 7, 0);
      add({ id: `estoque:${L.conta}:${acabando.map(i => i.n).join('|').slice(0, 60)}`, quando: 'semana', quem: 'cliente', tipo: 'estoque', tela: 'estoque-margem',
        titulo: `Repor estoque: ${acabando.map(i => corta(i.n, 28)).join(', ')}`, porque: acabando.map(i => `${corta(i.n, 28)} ${i.ne === 'zerado' ? 'sem estoque' : `acaba em ~${Math.round(i.d)} d`}`).join('; '), impacto: `~${R$(perda)}/sem em vendas`, valor: perda, peso: 500 + perda / 20 });
    }
    const semCusto = its.filter(i => !i.c).sort((a, b) => (b.vd * b.p) - (a.vd * a.p));
    if (semCusto.length >= 3 && (sn.resumo?.comCusto || 0) < (sn.resumo?.produtos || 0) * 0.7) add({ id: `custo:${L.conta}`, quando: 'semana', quem: 'cliente', tipo: 'margem', tela: 'produtos',
      titulo: `Cadastrar o custo dos ${Math.min(20, semCusto.length)} produtos que mais vendem`, porque: `${Math.max(semCusto.length, (sn.resumo?.produtos || its.length) - (sn.resumo?.comCusto || 0))} de ${sn.resumo?.produtos || its.length} produtos sem custo — sem isso a margem, as promoções e o limite de ADS por produto não funcionam`, impacto: 'libera os agentes', peso: 450 });
    const negativos = its.filter(i => i.nm === 'negativa').sort((a, b) => (b.vd * b.p) - (a.vd * a.p)).slice(0, 3);
    if (negativos.length) add({ id: `margem:${L.conta}`, quando: 'semana', quem: 'analista', tipo: 'margem', tela: 'estoque-margem',
      titulo: `Rever preço/custo: ${negativos.map(i => corta(i.n, 28)).join(', ')}`, porque: negativos.map(i => `${corta(i.n, 28)} margem ${pct(i.m)} antes do ADS`).join('; '), impacto: 'cada venda dá prejuízo', peso: 700 });
  }
  // Promoções
  if (pr) {
    const sug = Object.values(pr.itens || {}).filter(x => x.melhor);
    if (sug.length) add({ id: `promo:${L.conta}`, quando: 'semana', quem: 'analista', tipo: 'promocoes', tela: 'promocoes',
      titulo: `Aplicar ${sug.length} promoção(ões) que cabem na margem`, porque: `${sug.filter(x => x.parado).length ? `${sug.filter(x => x.parado).length} giram estoque parado; ` : ''}ex.: ${corta(sug[0].n, 35)} (${sug[0].melhor.rot}, margem ${pct(sug[0].melhor.m)})`, impacto: 'vendas', peso: 350 + sug.length * 20 });
    const aperto = Object.values(pr.itens || {}).filter(x => x.emPromo?.m != null && x.emPromo.m < (pr.margem_minima ?? 5));
    if (aperto.length) add({ id: `promo-aperto:${L.conta}`, quando: 'semana', quem: 'analista', tipo: 'promocoes', tela: 'promocoes',
      titulo: `Rever ${aperto.length} promoção(ões) em vigor com margem abaixo da mínima`, porque: `ex.: ${corta(aperto[0].n, 35)} com margem ${pct(aperto[0].emPromo.m)} no preço da promoção`, impacto: 'margem', peso: 550 });
  }
  // Qualidade de anúncio
  if (qa) {
    const ruins = Object.values(qa.itens || {}).filter(x => x.nivel === 'ruim' && !/experiência de compra -\d/.test(x.qa || '')).sort((a, b) => (b.u30 || 0) - (a.u30 || 0)).slice(0, 3);
    if (ruins.length) add({ id: `qa:${L.conta}`, quando: 'semana', quem: 'analista', tipo: 'qualidade', tela: 'qualidade-anuncios',
      titulo: `Consertar ${ruins.length} anúncio(s): ${ruins.map(x => corta(x.n, 26)).join(', ')}`, porque: ruins.map(x => corta(x.qa, 70)).join('; '), impacto: 'conversão e exposição', peso: 500 });
    const com = (qa.destaques?.comuns || []).find(c => c.n >= 3);
    if (com) add({ id: `qa-comum:${L.conta}:${com.t.slice(0, 30)}`, quando: 'semana', quem: 'cliente', tipo: 'qualidade', tela: 'qualidade-anuncios',
      titulo: `${corta(com.t, 60)} (${com.n} anúncios)`, porque: 'a mesma pendência em vários anúncios é ajuste de processo', impacto: 'conversão', peso: 150 + Math.min(100, com.n * 2) });
  }
  // ADS: o que espera o analista
  const pend = log.pendentes.filter(l => String(l.conta_id) === L.conta);
  if (pend.length) {
    const econ = pend.reduce((s, l) => s + (l.dados?.impacto_tipo === 'economia' ? parseFloat(l.dados?.impacto) || 0 : 0), 0);
    add({ id: `ads:${L.conta}`, quando: 'hoje', quem: 'analista', tipo: 'ads', tela: L.mkt === 'ml' ? 'agente-ml' : 'agente',
      titulo: L.mkt === 'ml' ? `Aplicar o pacote do ADS no painel do ML (${pend.length} passo(s))` : `Aprovar ${pend.length} sugestão(ões) do ADS Shopee`,
      porque: econ > 0 ? `~${R$(econ)}/sem de gasto a cortar` : 'passam do limite que o agente aplica sozinho', impacto: econ > 0 ? `~${R$(econ)}/sem` : 'ADS', valor: econ, peso: 800 + econ / 2 });
  }
  return A;
}

// ── Raio-X do faturamento ─────────────────────────────────────────────
// De onde a venda veio e para onde foi: últimos 14 dias × os 14 anteriores,
// produto a produto (pedidos válidos da base), e a causa provável de cada queda
// cruzando o que os outros agentes sabem: estoque e status do anúncio (Estoque),
// preço vendido (pedidos), mudança de ADS feita pelo agente ou aplicada no ML
// (registro dos agentes) e qualidade do anúncio.
const JANELA = 14;
const diaDe = iso => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);
const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const dm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const N = v => Math.round(v || 0).toLocaleString('pt-BR');
const pc = v => v == null ? '—' : `${String(Math.round(v * 100) / 100).replace('.', ',')}%`; // conversão: 2 casas
const varTxt = (a, b) => a > 0 ? `${b >= a ? '+' : '−'}${pct(Math.abs(b / a - 1) * 100)}` : '';

async function pedidosDaLoja(sbSelect, L, desdeIso) {
  const rows = [];
  for (let off = 0; off < 80000; off += 1000) {
    const r = await sbSelect('glr_pedidos', `marketplace=eq.${L.mkt}&conta_id=eq.${encodeURIComponent(L.conta)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(desdeIso)}&select=criado_em,itens&order=criado_em.asc&limit=1000&offset=${off}`).catch(() => null);
    if (!r) return null;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  return rows;
}

// Funil do produto: perdeu visita ou perdeu conversão? (null sem visitas nas 2 janelas)
function diagFunil(fn) {
  if (!fn || !(fn.va >= 30) || fn.vb == null) return null;
  const dv = fn.vb / fn.va - 1, dc = fn.ca > 0 && fn.cb != null ? fn.cb / fn.ca - 1 : null;
  const vTxt = `visitas ${N(fn.va)} → ${N(fn.vb)} (${varTxt(fn.va, fn.vb)})`, cTxt = `conversão ${pc(fn.ca)} → ${pc(fn.cb)}`;
  if (dv <= -0.2 && dc != null && dc <= -0.15) return { t: `perdeu visitas e conversão: ${vTxt}, ${cTxt}`, tipo: 'trafego' };
  if (dv <= -0.2) return { t: `perdeu visitas: ${vTxt}, com a conversão estável (${pc(fn.cb)})`, tipo: 'trafego' };
  if (dc != null && dc <= -0.2) return { t: `converte menos: ${cTxt}, com as visitas ${dv >= 0.1 ? 'subindo' : 'estáveis'} (${N(fn.vb)})`, tipo: 'conversao' };
  return null;
}

function causasDaQueda(x, L, mudancas) {
  const base = [];
  const sn = L.sinais?.itens?.[x.id];
  if (sn?.ne === 'zerado') base.push({ t: 'ficou sem estoque', tipo: 'estoque' });
  else if (sn?.ne === 'critico') base.push({ t: `estoque acabando (~${Math.round(sn.d)} d)`, tipo: 'estoque' });
  const ST = { paused: 'pausado', under_review: 'em revisão pelo marketplace', reviewing: 'em revisão pelo marketplace', inactive: 'inativo', closed: 'finalizado', unlist: 'fora do ar', banned: 'bloqueado', deleted: 'excluído' };
  if (sn?.st && !/active|normal/i.test(sn.st)) base.push({ t: `anúncio ${ST[String(sn.st).toLowerCase()] || String(sn.st).toLowerCase()}`, tipo: 'anuncio' });
  const pa = x.a.un ? x.a.rec / x.a.un : null, pb = x.b.un ? x.b.rec / x.b.un : null;
  const precoSubiu = pa && pb && pb > pa * 1.05 ? [{ t: `preço vendido subiu de ${R$(pa)} para ${R$(pb)} (+${pct((pb / pa - 1) * 100)})`, tipo: 'preco' }] : [];
  const funil = diagFunil(x.fn);
  // a explicação vem na frente do sintoma que ela explica: visita caiu → ADS; conversão caiu → preço
  let meio;
  if (funil?.tipo === 'trafego') meio = [...mudancas, funil, ...precoSubiu];
  else if (funil?.tipo === 'conversao') meio = [...precoSubiu, funil, ...mudancas];
  else meio = [...precoSubiu, ...mudancas];
  const c = [...base, ...meio];
  const qa = L.qualidade?.itens?.[x.id]?.qa;
  if (qa) c.push({ t: corta(qa, 90), tipo: 'qualidade' });
  const fi = L.funil?.itens?.[x.id];
  if (funil?.tipo === 'conversao' && fi?.r && fi.r < 4.5) c.push({ t: `nota ${String(fi.r).replace('.', ',')} (${fi.nr} avaliações) — avaliação ruim derruba conversão`, tipo: 'qualidade' });
  if (pa && pb && pb < pa * 0.95 && !c.length) c.push({ t: `caiu mesmo com o preço ${pct((1 - pb / pa) * 100)} menor — olhar concorrência e posição`, tipo: 'preco' });
  return c;
}

// mudanças de ADS no período que tocam o produto (Shopee: campanha = produto, pelo nome;
// ML: sugestão aplicada com o anúncio na lista)
const prefixo = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
function mudancasAds(x, L, medidos, desdeIso) {
  const out = [], nx = norm(x.nome);
  // Shopee: campanha de produto tem o nome do anúncio — fica só a campanha de
  // nome mais parecido (prefixo comum ≥ 30 letras), para não pegar outro produto
  // da mesma linha ("Balcão para Cozinha …")
  let melhorCamp = null, melhorP = 29;
  if (L.mkt === 'shopee') for (const l of medidos) {
    if (String(l.conta_id) !== L.conta) continue;
    const nc = norm(String(l.titulo || '').split(' — ').slice(1).join(' '));
    const pr = prefixo(nx, nc);
    if (pr > melhorP || (pr === melhorP && melhorCamp == null)) { melhorP = pr; melhorCamp = String(l.dados?.campaign_id ?? nc); }
  }
  for (const l of medidos) {
    // só mudança dentro das 2 semanas comparadas (a de hoje ainda não explica queda nenhuma)
    if (String(l.conta_id) !== L.conta || !l.criado_em || diaDe(l.criado_em) < desdeIso || diaDe(l.criado_em) > isoBRT(1)) continue;
    const d = l.dados || {}, quando = dm(diaDe(d.aplicado_em || l.criado_em));
    const ids = (d.item_ids || []).map(String);
    if (L.mkt === 'ml' && ids.includes(String(x.id))) {
      const t = { retirar_produto: 'saiu da campanha', mover_produto: `foi movido para ${d.destino || 'outra campanha'}`, pausar: 'campanha pausada' }[d.acao];
      if (t) out.push({ t: `${t} em ${quando}`, tipo: 'ads' });
      continue;
    }
    if (L.mkt !== 'shopee' || melhorCamp == null) continue;
    if (String(d.campaign_id ?? norm(String(l.titulo || '').split(' — ').slice(1).join(' '))) !== melhorCamp) continue;
    if (d.roas_para != null && d.roas_de != null && +d.roas_para > +d.roas_de) out.push({ t: `ROAS da campanha subiu de ${r1(d.roas_de)}x para ${r1(d.roas_para)}x em ${quando} (lance mais conservador)`, tipo: 'ads' });
    else if (d.budget_para != null && d.budget_de != null && +d.budget_para < +d.budget_de) out.push({ t: `orçamento cortado de ${R$(d.budget_de)} para ${R$(d.budget_para)}/dia em ${quando}`, tipo: 'ads' });
    else if (/^Campanha pausada/.test(l.titulo || '') || d.pausada) out.push({ t: `campanha pausada em ${quando}`, tipo: 'ads' });
  }
  return out.slice(0, 2); // medidos vem do mais recente para o mais antigo
}

function calcularRaioX(lojas, pedidosPor, medidos) {
  const bIni = isoBRT(JANELA), bFim = isoBRT(1), aIni = isoBRT(JANELA * 2), aFim = isoBRT(JANELA + 1), cIni = isoBRT(7);
  const itens = new Map(), porLoja = [], comparadas = [];
  let totA = 0, totB = 0, lojasComp = 0;
  for (const L of lojas) {
    const peds = pedidosPor.get(L.conta);
    if (!peds) continue;
    // loja sem pedido antes da janela A (histórico ainda carregando) não entra na comparação
    const temA = peds.some(p => diaDe(p.criado_em) <= aFim);
    if (!temA) continue;
    lojasComp++;
    let la = 0, lb = 0, ua = 0, ub = 0;
    for (const p of peds) {
      const dia = diaDe(p.criado_em);
      const lado = dia >= bIni && dia <= bFim ? 'b' : dia >= aIni && dia <= aFim ? 'a' : null;
      if (!lado) continue;
      for (const i of (p.itens || [])) {
        if (!i.item_id) continue;
        const q = parseInt(i.qtd) || 1, v = (parseFloat(i.preco) || 0) * q;
        const k = `${L.conta}:${i.item_id}`;
        const x = itens.get(k) || { id: String(i.item_id), nome: i.nome || String(i.item_id), L, a: { rec: 0, un: 0 }, b: { rec: 0, un: 0 }, c: { rec: 0, un: 0 } };
        x[lado].rec += v; x[lado].un += q;
        if (lado === 'b' && dia >= cIni) { x.c.rec += v; x.c.un += q; } // últimos 7 dias (oportunidades)
        if (lado === 'a') { la += v; ua += q; } else { lb += v; ub += q; }
        itens.set(k, x);
      }
    }
    totA += la; totB += lb;
    comparadas.push({ L, la, lb, ua, ub });
    porLoja.push({ loja: nomeLoja(L), mkt: L.mkt, antes: Math.round(la / 2), agora: Math.round(lb / 2), var: la > 0 ? r1((lb - la) / la * 100) : null });
  }
  if (!lojasComp) return null;
  const sem = v => Math.round(v / 2); // 14 dias → por semana
  // funil de cada produto: visitas nas duas janelas e conversão (unidades ÷ visitas)
  const fnDe = x => {
    if (!x.L.funil) return null;
    const va = visitasItem(x.L.funil, x.id, aIni, aFim), vb = visitasItem(x.L.funil, x.id, bIni, bFim);
    if (va == null && vb == null) return null;
    return { va, vb, ca: va > 0 ? x.a.un / va * 100 : null, cb: vb > 0 ? x.b.un / vb * 100 : null };
  };
  const lista = [...itens.values()].map(x => ({ ...x, delta: x.b.rec - x.a.rec, fn: fnDe(x) }));
  const minRelev = Math.max(150, (totA + totB) / 4 * 0.01); // ≥ 1% do faturamento semanal
  const fnOut = fn => fn && { va: fn.va, vb: fn.vb, ca: fn.ca == null ? null : Math.round(fn.ca * 100) / 100, cb: fn.cb == null ? null : Math.round(fn.cb * 100) / 100 };
  const caiu = lista.filter(x => x.delta < 0 && -sem(x.delta) >= minRelev).sort((a, b) => a.delta - b.delta).slice(0, 6).map(x => ({
    id: x.id, nome: corta(x.nome, 70), loja: nomeLoja(x.L), conta: x.L.conta, mkt: x.L.mkt, antes: sem(x.a.rec), agora: sem(x.b.rec), perdaSem: -sem(x.delta), unAntes: x.a.un, unAgora: x.b.un,
    precoAntes: x.a.un ? Math.round(x.a.rec / x.a.un) : null, precoAgora: x.b.un ? Math.round(x.b.rec / x.b.un) : null, fn: fnOut(x.fn),
    causas: causasDaQueda(x, x.L, mudancasAds(x, x.L, medidos, aIni)),
  }));
  const subiu = lista.filter(x => x.delta > 0 && sem(x.delta) >= minRelev).sort((a, b) => b.delta - a.delta).slice(0, 5).map(x => {
    const sn = x.L.sinais?.itens?.[x.id];
    return { id: x.id, nome: corta(x.nome, 70), loja: nomeLoja(x.L), antes: sem(x.a.rec), agora: sem(x.b.rec), ganhoSem: sem(x.delta), novo: x.a.rec === 0, fn: fnOut(x.fn),
      alerta: sn?.ne === 'zerado' || sn?.ne === 'critico' ? `estoque ${sn.ne === 'zerado' ? 'zerado' : `para ~${Math.round(sn.d)} d`} — repor antes de acelerar` : null };
  });
  const topB = lista.slice().sort((a, b) => b.b.rec - a.b.rec);
  const conc = totB > 0 ? r1(topB.slice(0, 5).reduce((s, x) => s + x.b.rec, 0) / totB * 100) : null;

  // ── Funil da conta: faturamento = visitas × conversão × preço médio ──
  // ML: visitas da loja inteira; Shopee: soma dos produtos acompanhados que têm as duas janelas
  const fl = [];
  for (const { L, la, lb, ua, ub } of comparadas) {
    if (!L.funil) continue;
    if (L.mkt === 'ml') {
      const va = visitasConta(L.funil, aIni, aFim), vb = visitasConta(L.funil, bIni, bFim);
      if (va > 0 && vb > 0) fl.push({ L, va, vb, ua, ub, ra: la, rb: lb, base: 'loja' });
    } else {
      const xs = lista.filter(x => x.L === L && x.fn?.va > 0 && x.fn?.vb > 0);
      if (xs.length >= 3) fl.push({ L, va: xs.reduce((s, x) => s + x.fn.va, 0), vb: xs.reduce((s, x) => s + x.fn.vb, 0), ua: xs.reduce((s, x) => s + x.a.un, 0), ub: xs.reduce((s, x) => s + x.b.un, 0), ra: xs.reduce((s, x) => s + x.a.rec, 0), rb: xs.reduce((s, x) => s + x.b.rec, 0), base: `${xs.length} produtos` });
    }
  }
  let funil = null;
  if (fl.length) {
    const S = k => fl.reduce((s, f) => s + f[k], 0);
    const va = S('va'), vb = S('vb'), ua = S('ua'), ub = S('ub'), ra = S('ra'), rb = S('rb');
    if (va > 0 && vb > 0 && ua > 0 && ub > 0) {
      const ca = ua / va * 100, cb = ub / vb * 100, ta = ra / ua, tb = rb / ub;
      const fat = [['visitas', Math.log(vb / va), vb / va - 1], ['conversão', Math.log(cb / ca), cb / ca - 1], ['preço médio', Math.log(tb / ta), tb / ta - 1]];
      const tot = Math.log(rb / ra);
      // o fator que mais empurrou na direção do resultado
      const principal = fat.filter(f => Math.sign(f[1]) === Math.sign(tot) || !tot).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
      const fx = f => `${f[0]} ${f[2] >= 0 ? '+' : '−'}${pct(Math.abs(f[2] * 100))}`;
      const explica = principal ? `${tot < 0 ? 'A queda' : 'O crescimento'} de ${pct(Math.abs((rb / ra - 1) * 100))} veio principalmente de ${fx(principal)}${fat.filter(f => f !== principal && Math.abs(f[2]) >= 0.05).map(f => `; ${fx(f)}`).join('')}.` : '';
      funil = { visitas: { a: Math.round(va / 2), b: Math.round(vb / 2) }, conversao: { a: Math.round(ca * 100) / 100, b: Math.round(cb * 100) / 100 }, precoMedio: { a: Math.round(ta), b: Math.round(tb) },
        explica, lojas: fl.map(f => ({ loja: nomeLoja(f.L), base: f.base, visitasSem: Math.round(f.vb / 2), conv: Math.round(f.ub / f.vb * 10000) / 100, varVisitas: r1((f.vb / f.va - 1) * 100) })),
        cobertura: fl.length < comparadas.length ? `${fl.length} de ${comparadas.length} lojas (a Shopee completa o histórico de visitas em ~15 dias)` : null };
    }
  }

  // ── Oportunidades do funil (últimos 7 dias) ──
  // visita sem venda: tráfego que já existe e não converte; converte bem e quase não aparece: falta exposição
  const semConversao = [], poucaVisita = [];
  for (const { L } of comparadas) {
    const f = L.funil; if (!f?.itens) continue;
    const ps = Object.entries(f.itens).map(([id, fi]) => {
      const v7 = visitasItem(f, id, cIni, bFim); if (v7 == null) return null;
      const x = itens.get(`${L.conta}:${id}`), un = x?.c.un || 0, rec = x?.c.rec || 0;
      const preco = un ? rec / un : (L.sinais?.itens?.[id]?.p || 0);
      return { id, nome: corta(x?.nome || fi.n, 70), v7, un, rec, preco, conv: v7 > 0 ? un / v7 * 100 : null, nota: fi.r, nr: fi.nr };
    }).filter(Boolean);
    const vt = ps.reduce((s, x) => s + x.v7, 0), ut = ps.reduce((s, x) => s + x.un, 0);
    if (ps.length < 5 || !(vt > 0) || !(ut > 0)) continue;
    const ref = ut / vt * 100, medV = ps.map(x => x.v7).sort((a, b) => a - b)[Math.floor(ps.length / 2)];
    const foraAds = new Set((L.oportunidades?.candidatos || []).map(c => String(c.item_id)));
    for (const x of ps) {
      const base = { ...x, conv: x.conv == null ? null : Math.round(x.conv * 100) / 100, convLoja: Math.round(ref * 100) / 100, loja: nomeLoja(L), conta: L.conta, mkt: L.mkt, preco: Math.round(x.preco), foraAds: foraAds.has(x.id) };
      if (x.v7 >= 70 && x.conv < ref * 0.5 && x.preco > 0) {
        const potencial = Math.round(x.v7 * (ref * 0.7 - x.conv) / 100 * x.preco);
        if (potencial >= 150) semConversao.push({ ...base, potencial });
      } else if (x.conv >= ref * 1.6 && x.un >= 3 && x.v7 <= medV) {
        const potencial = Math.round(x.rec * 0.5); // +50% de visitas na mesma conversão
        if (potencial >= 150) poucaVisita.push({ ...base, vezes: r1(x.conv / ref), potencial });
      }
    }
  }
  semConversao.sort((a, b) => b.potencial - a.potencial); poucaVisita.sort((a, b) => b.potencial - a.potencial);

  return {
    periodo: { antes: `${dm(aIni)} a ${dm(aFim)}`, agora: `${dm(bIni)} a ${dm(bFim)}` },
    semanaAntes: sem(totA), semanaAgora: sem(totB), var: totA > 0 ? r1((totB - totA) / totA * 100) : null,
    lojas: porLoja.sort((a, b) => (a.agora - a.antes) - (b.agora - b.antes)), caiu, subiu, concentracaoTop5: conc,
    produtosVendendo: lista.filter(x => x.b.un > 0).length, produtosQueZeraram: lista.filter(x => x.a.un >= 3 && x.b.un === 0).length,
    funil, oportunidades: { semConversao: semConversao.slice(0, 3), poucaVisita: poucaVisita.slice(0, 3) },
  };
}

// ── Caminho para a meta ──────────────────────────────────────────────
// Quanto falta (R$ e pedidos) até o fim do mês e as alavancas que os dados já
// mostram, cada uma com quanto rende até o fim do mês (estimativa conservadora,
// com o grau de confiança). Se a soma não chega, diz quanto falta além disso e
// quanto de ADS a mais seria preciso mantendo o TACOS de hoje.
const FATOR = { estoque: [0.8, 'alta'], anuncio: [0.7, 'alta'], ads: [0.6, 'média'], preco: [0.5, 'média'], trafego: [0.5, 'média'], conversao: [0.4, 'baixa'], qualidade: [0.4, 'baixa'] };
const ROTULO_CAUSA = {
  estoque: n => `Repor o estoque de ${n} produto(s) que pararam de vender`, anuncio: n => `Reativar/consertar ${n} anúncio(s) pausados ou em revisão`,
  ads: n => `Desfazer o aperto de ADS em ${n} produto(s) que perderam venda`, preco: n => `Rever o preço de ${n} produto(s) que subiram e caíram`, qualidade: n => `Consertar o anúncio de ${n} produto(s) com problema de qualidade`,
  trafego: n => `Recuperar as visitas de ${n} produto(s) que perderam exposição`, conversao: n => `Recuperar a conversão de ${n} produto(s) que recebem visita e vendem menos`,
};
const TELA_CAUSA = { estoque: 'estoque-margem', anuncio: 'qualidade-anuncios', ads: 'decisoes', preco: 'precos-ml', qualidade: 'qualidade-anuncios', trafego: 'agente', conversao: 'vendas' };
// Nos últimos 4 dias do mês quase nada mais muda: o caminho passa a ser o do mês
// seguinte (mesma meta), partindo do ritmo diário de hoje.
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function calcularCaminho({ meta, metaPedidos, fat, pedidos, dd, dm, lojas, raioX, pendentes, tacos, mesNum, diasProxMes }) {
  if (!(meta > 0) && !(metaPedidos > 0)) return null;
  const proximo = dm - dd <= 4 && diasProxMes > 0;
  const diasAlvo = proximo ? diasProxMes : dm;
  const diasRest = proximo ? diasProxMes : Math.max(0, dm - dd), semRest = diasRest / 7;
  const ticket = pedidos > 0 ? fat / pedidos : 0;
  const ritmo = dd > 0 ? fat / dd : 0, ritmoPed = dd > 0 ? pedidos / dd : 0;
  const proj = proximo ? ritmo * diasAlvo : ritmo * dm, projPed = proximo ? ritmoPed * diasAlvo : ritmoPed * dm;
  const faltaR = meta > 0 ? Math.max(0, meta - proj) : 0;
  const faltaPed = metaPedidos > 0 ? Math.max(0, metaPedidos - projPed) : 0;
  // o que pesa mais: a meta em R$ ou a de pedidos (convertida pelo ticket do mês)
  const falta = Math.max(faltaR, faltaPed * ticket);
  const jaFeito = proximo ? 0 : fat, jaPed = proximo ? 0 : pedidos;
  const base = { proximo, mesAlvo: MESES[((mesNum || 1) - 1 + (proximo ? 1 : 0)) % 12], diasRest, ticket: Math.round(ticket), proj: Math.round(proj), projPedidos: Math.round(projPed), faltaR: Math.round(faltaR), faltaPedidos: Math.round(faltaPed), falta: Math.round(falta),
    precisaDia: diasRest > 0 && meta > 0 ? Math.round(Math.max(0, meta - jaFeito) / diasRest) : null, ritmoDia: dd > 0 ? Math.round(ritmo) : null,
    precisaPedDia: diasRest > 0 && metaPedidos > 0 ? Math.round(Math.max(0, metaPedidos - jaPed) / diasRest) : null, ritmoPedDia: dd > 0 ? Math.round(ritmoPed) : null };
  if (!falta || !diasRest) return { ...base, atinge: true, alavancas: [], soma: 0, cobertura: 100 };
  const alav = [];
  // 1) recuperar as quedas que têm causa
  const porCausa = {};
  for (const x of raioX?.caiu || []) {
    const t = x.causas?.[0]?.tipo; if (!FATOR[t]) continue;
    (porCausa[t] = porCausa[t] || []).push(x);
  }
  const jaContados = new Set();
  for (const [t, xs] of Object.entries(porCausa)) {
    const v = xs.reduce((s, x) => s + x.perdaSem, 0) * semRest * FATOR[t][0];
    xs.forEach(x => jaContados.add(`${x.conta}:${x.id}`));
    alav.push({ id: `rec-${t}`, titulo: ROTULO_CAUSA[t](xs.length), porque: xs.slice(0, 2).map(x => `${corta(x.nome, 40)} (−${R$(x.perdaSem)}/sem)`).join(', '), valor: Math.round(v), conf: FATOR[t][1], tela: TELA_CAUSA[t] });
  }
  // 2) evitar a ruptura de quem acaba antes do fim do mês
  let rupt = 0, nRupt = 0, exRupt = '';
  for (const L of lojas) for (const [id, i] of Object.entries(L.sinais?.itens || {})) {
    if (jaContados.has(`${L.conta}:${id}`) || !(i.vd > 0) || i.d == null || i.d >= diasRest) continue;
    rupt += i.vd * i.p * (diasRest - Math.max(0, i.d)); nRupt++; if (!exRupt) exRupt = i.d < 1 ? `${corta(i.n, 40)} já está sem estoque` : `${corta(i.n, 40)} acaba em ~${Math.round(i.d)} d`;
  }
  if (rupt > 0) alav.push({ id: 'ruptura', titulo: `Repor ${nRupt} produto(s) que acabam antes do fim de ${base.mesAlvo}`, porque: exRupt, valor: Math.round(rupt * 0.8), conf: 'alta', tela: 'estoque-margem', quem: 'cliente' });
  // 3) acelerar quem está crescendo (sem alerta de estoque)
  const campeoes = (raioX?.subiu || []).filter(x => !x.alerta);
  if (campeoes.length) alav.push({ id: 'campeoes', titulo: `Dar mais ADS/visibilidade aos ${campeoes.length} produto(s) que estão crescendo`, porque: campeoes.slice(0, 2).map(x => `${corta(x.nome, 40)} (+${R$(x.ganhoSem)}/sem)`).join(', '), valor: Math.round(campeoes.reduce((s, x) => s + x.agora, 0) * 0.2 * semRest), conf: 'média', tela: 'agente' });
  // 3b) oportunidades do funil: visita que não converte e produto que converte e não aparece
  const op = [...(raioX?.oportunidades?.semConversao || []), ...(raioX?.oportunidades?.poucaVisita || [])];
  if (op.length) alav.push({ id: 'funil', titulo: `Trabalhar ${op.length} produto(s) do funil (visita sem venda / converte e não aparece)`, porque: op.slice(0, 2).map(x => `${corta(x.nome, 40)} (~${R$(x.potencial)}/sem)`).join(', '), valor: Math.round(op.reduce((s, x) => s + x.potencial, 0) * semRest * 0.4), conf: 'baixa', tela: 'vendas' });
  // 4) sugestões de ADS que ganham venda (esperando aprovação)
  const contas = new Set(lojas.map(L => L.conta));
  const ganho = pendentes.filter(l => contas.has(String(l.conta_id)) && l.dados?.impacto_tipo === 'ganho' && parseFloat(l.dados?.impacto) > 0);
  if (ganho.length) alav.push({ id: 'ads-ganho', titulo: `Aprovar ${ganho.length} sugestão(ões) de ADS para ganhar venda`, porque: corta(String(ganho[0].titulo || '').replace(/^Sugestão:?\s*/, ''), 80), valor: Math.round(ganho.reduce((s, l) => s + parseFloat(l.dados.impacto), 0) * semRest * 0.5), conf: 'média', tela: 'decisoes' });
  // 5) promoções que cabem na margem
  let promo = 0, nPromo = 0;
  for (const L of lojas) for (const [id, x] of Object.entries(L.promocoes?.itens || {})) {
    if (!x.melhor) continue; const sn = L.sinais?.itens?.[id];
    promo += (sn?.vd || 0) * (sn?.p || x.p || 0) * 7 * 0.15 * semRest; nPromo++;
  }
  if (nPromo && promo > 0) alav.push({ id: 'promocoes', titulo: `Aplicar ${nPromo} promoção(ões) que cabem na margem`, porque: 'estimativa de +15% de venda nesses produtos', valor: Math.round(promo), conf: 'baixa', tela: 'promocoes' });
  alav.sort((a, b) => b.valor - a.valor);
  const soma = alav.reduce((s, a) => s + a.valor, 0);
  const resto = Math.max(0, falta - soma);
  return { ...base, atinge: false, alavancas: alav, soma: Math.round(soma), cobertura: Math.round(Math.min(100, soma / falta * 100)),
    resto: Math.round(resto), adsExtra: resto > 0 && tacos > 0 ? Math.round(resto * tacos / 100) : null };
}

// Queda relevante vira ação, com a causa já apontada
const FAZER = {
  trafego: 'o problema é exposição: conferir posição na busca, se perdeu frete grátis/selo ou saiu de campanha do marketplace, e reforçar o ADS do produto',
  conversao: 'as visitas continuam chegando e não compram: comparar preço e frete com o concorrente, conferir fotos, variações sem estoque e avaliações recentes',
  preco: 'o preço subiu e a venda caiu: testar a volta ao preço anterior (ou uma promoção dentro da margem)',
};
function acoesDoRaioX(rx) {
  if (!rx) return [];
  const A = rx.caiu.slice(0, 3).map(x => {
    const tipo = x.causas[0]?.tipo, nome = corta(x.nome, 50);
    const tela = tipo === 'estoque' ? 'estoque-margem' : tipo === 'ads' || tipo === 'trafego' ? (x.mkt === 'ml' ? 'agente-ml' : 'agente') : tipo === 'preco' ? (x.mkt === 'ml' ? 'precos-ml' : 'vendas') : tipo === 'qualidade' ? 'qualidade-anuncios' : 'vendas';
    const titulo = { estoque: `Repor ${nome}`, ads: `Devolver o lance do ADS de ${nome}`, preco: `Rever o preço de ${nome}`, trafego: `Recuperar as visitas de ${nome}`, conversao: `Recuperar a conversão de ${nome}`, anuncio: `Reativar o anúncio de ${nome}` }[tipo] || `Recuperar ${nome}`;
    const fazer = FAZER[tipo] && !(tipo === 'trafego' && x.causas.some(c => c.tipo === 'ads')) ? ` O que fazer: ${FAZER[tipo]}.` : '';
    return { id: `fat:${x.conta}:${x.id}`, conta: x.conta, mkt: x.mkt, loja: x.loja, tipo: 'faturamento', tela,
      quando: 'hoje', quem: tipo === 'estoque' ? 'cliente' : 'analista',
      titulo: `${titulo}: caiu ${R$(x.perdaSem)}/sem`,
      porque: `vendia ${R$(x.antes)}/sem (${x.unAntes} un. em 14 d), agora ${R$(x.agora)}/sem (${x.unAgora} un.) — ${x.causas.length ? x.causas.map(c => c.t).join('; ') : 'sem causa clara nos dados: conferir concorrência, posição na busca e avaliações'}.${fazer}`,
      impacto: `~${R$(x.perdaSem)}/sem em vendas`, valor: x.perdaSem, peso: 1000 + x.perdaSem / 5 };
  });
  for (const x of rx.oportunidades?.semConversao || []) A.push({ id: `conv:${x.conta}:${x.id}`, conta: x.conta, mkt: x.mkt, loja: x.loja, tipo: 'funil', tela: x.mkt === 'ml' ? 'precos-ml' : 'vendas', quando: 'semana', quem: 'analista',
    titulo: `Converter melhor ${corta(x.nome, 45)}: ${N(x.v7)} visitas/sem e conversão de ${pc(x.conv)}`,
    porque: `a loja converte ${pc(x.convLoja)}; chegando a 70% disso, rende ~${R$(x.potencial)}/sem. Revisar preço (${R$(x.preco)}) e frete contra o concorrente, fotos, título e variações${x.nota && x.nota < 4.5 ? `; a nota é ${String(x.nota).replace('.', ',')} (${x.nr} avaliações)` : ''}.`,
    impacto: `~${R$(x.potencial)}/sem`, valor: x.potencial, peso: 600 + x.potencial / 5 });
  for (const x of rx.oportunidades?.poucaVisita || []) A.push({ id: `exp:${x.conta}:${x.id}`, conta: x.conta, mkt: x.mkt, loja: x.loja, tipo: 'funil', tela: x.mkt === 'ml' ? 'agente-ml' : 'agente', quando: 'semana', quem: 'analista',
    titulo: `Dar exposição a ${corta(x.nome, 45)}: converte ${pc(x.conv)} (${String(x.vezes).replace('.', ',')}x a loja) com ${N(x.v7)} visitas/sem`,
    porque: `${x.foraAds ? 'não está em nenhuma campanha de ADS — colocar numa campanha' : 'já está no ADS — subir o lance/orçamento dele'}; +50% de visitas na mesma conversão rende ~${R$(x.potencial)}/sem.`,
    impacto: `~${R$(x.potencial)}/sem`, valor: x.potencial, peso: 600 + x.potencial / 5 });
  return A;
}

// Texto com IA (diagnóstico + pauta) a partir dos fatos; null se não der
async function escrever(Anthropic, anthropicKey, fatos) {
  if (!anthropicKey || !Anthropic) return null;
  // até 3 tentativas: com vários clientes ao mesmo tempo a API pode recusar por limite (429/529)
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const r = await escreverUmaVez(Anthropic, anthropicKey, fatos);
    if (r && !r.falhou) return r;
    if (r?.falhou) return null; // a API respondeu, mas fora do formato: fica o texto por regra
    await new Promise(ok => setTimeout(ok, 1500 * tentativa));
  }
  return null;
}
async function escreverUmaVez(Anthropic, anthropicKey, fatos) {
  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const r = await client.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 2500,
      system: 'Você é o gerente de conta de uma consultoria de marketplaces (Mercado Livre e Shopee). Escreve para o analista da própria consultoria, em português do Brasil, direto e prático. Use SOMENTE os números e fatos do JSON — nunca invente número, produto, prazo ou ação. Responda APENAS um JSON válido: {"diagnostico":"até 4 frases: como o cliente está no mês (faturamento x meta/projeção, TACOS) e, pelo raio_x, DE ONDE o faturamento está vindo e PARA ONDE está indo — os produtos que mais caíram em R$/semana e a causa apontada, e os que mais cresceram. Cite produto e valor. Pense como analista da conta: se houver funil_da_conta, diga se a variação veio de visitas, conversão ou preço médio (use a explicacao), e para os produtos use o funil (visitas e conversão) e o preço antes/agora para dizer se perderam exposição, conversão ou ficaram mais caros. Se houver oportunidades_funil, cite a maior. Se houver caminho_para_meta, diga quanto falta para a meta e se as alavancas cobrem (cobertura_pct), citando as 2 maiores.","pauta":"pauta do dia para o analista conversar com o cliente, em tópicos curtos com hífen: 1) como o faturamento andou nas últimas 2 semanas e o que puxou/derrubou (raio_x), 2) o que fizemos e o resultado medido (se houver), 3) o que precisamos do cliente (só as ações com quem=cliente), 4) próximos passos. Tom cordial, pronto para virar mensagem. No máximo 8 tópicos, cada um com até 2 frases."}',
      messages: [{ role: 'user', content: JSON.stringify(fatos) }],
    });
    const txt = r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let j = null;
    try { j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch (e) { j = null; }
    if (!j) return { falhou: 'resposta fora do formato' };
    return j.diagnostico && j.pauta ? { diagnostico: String(j.diagnostico).slice(0, 900), pauta: String(j.pauta).slice(0, 3000) } : { falhou: 'resposta incompleta' };
  } catch (e) { return null; }
}

// h: { sbSelect, sbUpsert, lerStorage, anthropicKey, Anthropic }
async function gerarPlanos(h, filtroCliente, metaNova) {
  const { sbSelect, sbUpsert, lerStorage, anthropicKey, Anthropic } = h;
  const [clientes, vinc, metas, metasPed, metasTac, gestores, nicks, estados, configs, pendentes, medidos] = await Promise.all([
    lerStorage('glr_clientes').then(x => x || []), lerStorage('glr_mc_vinculos').then(x => x || {}), lerStorage('glr_metas').then(x => x || {}), lerStorage('glr_metas_pedidos').then(x => x || {}), lerStorage('glr_metas_tacos').then(x => x || {}), lerStorage('glr_gestores').then(x => x || []), lerStorage('glr_mc_nicknames').then(x => x || {}),
    sbSelect('glr_sync_estado', 'recurso=in.(resumo,sinais,promocoes,reputacao,qualidade,funil,oportunidades)&marketplace=in.(ml,shopee)&select=marketplace,conta_id,recurso,cursor').catch(() => []),
    sbSelect('glr_agente_config', 'select=conta_id,marketplace,meta_acos,cliente_nome').catch(() => []),
    sbSelect('glr_agente_log', `tipo=eq.alerta&resultado=eq.so_alerta&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 10 * 864e5).toISOString())}&select=conta_id,titulo,dados,criado_em&limit=3000`).catch(() => []),
    sbSelect('glr_agente_log', `tipo=in.(decisao,alerta)&resultado=eq.executado&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 46 * 864e5).toISOString())}&select=conta_id,titulo,dados,criado_em&order=criado_em.desc&limit=6000`).catch(() => []),
  ]);
  const est = {};
  for (const e of estados) { const k = `${e.marketplace}:${e.conta_id}`; (est[k] = est[k] || {})[e.recurso] = e.cursor; }
  const cfgDe = Object.fromEntries(configs.map(c => [String(c.conta_id), c]));
  const desde7 = Date.now() - 7 * 864e5;
  const ontem = isoBRT(1), mesIni = ontem.slice(0, 8) + '01';
  const dd = parseInt(ontem.slice(8, 10)), dm = new Date(Date.UTC(+ontem.slice(0, 4), +ontem.slice(5, 7), 0)).getUTCDate();
  const ant = new Date(`${mesIni}T12:00:00Z`); ant.setUTCMonth(ant.getUTCMonth() - 1);
  const antIni = ant.toISOString().slice(0, 10), antFim = (() => { const d = new Date(`${antIni}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + dd - 1); return d.toISOString().slice(0, 10); })();
  const gestorNome = id => (gestores.find(g => g.id === id) || {}).nome || '';
  const saida = [];
  const prazo = Date.now() + 200000; // raio-x lê pedidos; depois disso os planos saem sem ele
  const alvo = clientes.filter(c => !filtroCliente || String(c.id) === String(filtroCliente));
  let iCli = 0;
  const processar = async (c) => {
    const lojas = [];
    for (const ct of (vinc[String(c.id)] || [])) {
      const mkt = mktDe(ct.marketplace); if (!mkt) continue;
      const conta = String(ct.param_to_use?.shopId || ct.param_to_use?.meliUserId || ct.external_id);
      const e = est[`${mkt}:${conta}`] || est[`${mkt}:${ct.external_id}`]; if (!e) continue;
      lojas.push({ mkt, conta, nome: nicks[ct.external_id] || ct.tags?.[0]?.name || ct.nickname || '', resumo: e.resumo, sinais: e.sinais, promocoes: e.promocoes, reputacao: e.reputacao, qualidade: e.qualidade, funil: e.funil, oportunidades: e.oportunidades });
    }
    if (!lojas.length) return;
    // Métricas do mês (todas as lojas)
    let fat = 0, ads = 0, fatAnt = 0, cobreAnt = true, pedidos = 0;
    for (const L of lojas) {
      const m = somarDias(L.resumo?.dias, mesIni, ontem); fat += m.faturamento; ads += m.ads; pedidos += m.pedidos;
      const a = somarDias(L.resumo?.dias, antIni, antFim); if (!a.cobre) cobreAnt = false; fatAnt += a.faturamento;
    }
    const proj = dd > 0 ? fat / dd * dm : 0;
    // meta da tela do plano (acabou de salvar) > Projeção/Gestores (glr_metas) > cadastro do cliente
    const nova = metaNova && String(metaNova.cliente) === String(c.id) ? metaNova : null;
    const meta = (nova && nova.meta != null ? (parseFloat(nova.meta) || null) : null) ?? (parseFloat(metas[c.id] ?? metas[String(c.id)]) || parseFloat(c.metaMensal) || null);
    const metaPedidos = (nova && nova.metaPedidos != null ? (parseFloat(nova.metaPedidos) || null) : null) ?? (parseFloat(metasPed[c.id] ?? metasPed[String(c.id)]) || null);
    const tacos = fat > 0 ? ads / fat * 100 : null;
    const metasTacos = lojas.map(L => parseFloat(cfgDe[L.conta]?.meta_acos)).filter(v => v > 0);
    // teto de ADS do cliente (Plano de ação) > a menor meta de ACOS das contas
    const tetoTacos = (nova && nova.metaTacos != null ? (parseFloat(nova.metaTacos) || null) : (parseFloat(metasTac[c.id] ?? metasTac[String(c.id)]) || null));
    const metaTacos = tetoTacos || (metasTacos.length ? Math.min(...metasTacos) : null);
    const varMes = cobreAnt && fatAnt > 0 ? (fat - fatAnt) / fatAnt * 100 : null;
    // Raio-X: pedidos dos últimos 28 dias de cada loja (em paralelo)
    let raioX = null;
    if (Date.now() < prazo) {
      const desde = new Date(`${isoBRT(JANELA * 2)}T03:00:00Z`).toISOString();
      const peds = await Promise.all(lojas.map(L => pedidosDaLoja(sbSelect, L, desde)));
      const pedidosPor = new Map(lojas.map((L, i) => [L.conta, peds[i]]));
      try { raioX = calcularRaioX(lojas, pedidosPor, medidos); } catch (e) { raioX = null; }
    }
    const contasCliMeta = new Set(lojas.map(L => L.conta));
    const mesNum = +ontem.slice(5, 7), diasProxMes = new Date(Date.UTC(+ontem.slice(0, 4), mesNum + 1, 0)).getUTCDate();
    // o que os agentes já fizeram pela meta (últimos 7 dias): promoções em que entraram
    const promosMeta = [...pendentes, ...medidos].filter(l => new Set(lojas.map(L => L.conta)).has(String(l.conta_id)) && /promoção pela meta|^Promoção aprovada/.test(l.titulo || '') && l.criado_em && Date.now() - Date.parse(l.criado_em) < 7 * 864e5)
      .map(l => ({ produto: corta(l.dados?.produto || '', 50), promo: l.dados?.promo, preco: l.dados?.preco, margem: l.dados?.margem, em: l.criado_em }));
    const caminho = calcularCaminho({ meta, metaPedidos, fat, pedidos, dd, dm, lojas, raioX, pendentes, tacos: fat > 0 ? ads / fat * 100 : null, mesNum, diasProxMes });
    // teto de ADS: quanto ainda cabe de investimento no mês sem passar do teto (no ritmo de gasto de hoje)
    if (caminho && tetoTacos && meta) { const adsMes = dd > 0 ? ads / dd * dm : 0; caminho.tetoTacos = tetoTacos; caminho.adsMes = Math.round(adsMes); caminho.folgaAds = Math.round(tetoTacos / 100 * meta - adsMes); }
    // as 2 maiores alavancas viram ações do plano (com o R$ que rendem até o fim do mês)
    const acoesMeta = (caminho?.alavancas || []).slice(0, 2).map((a, i) => ({ id: `meta:${c.id}:${a.id}`, tipo: 'meta', quando: 'hoje', quem: a.quem || 'analista', tela: a.tela,
      titulo: `Meta: ${a.titulo}`, porque: `${a.porque ? a.porque + ' — ' : ''}rende ~${R$(a.valor)} até o fim de ${caminho.mesAlvo} (confiança ${a.conf})`, impacto: `~${R$(a.valor)} em ${caminho.mesAlvo}`, valor: a.valor, peso: 1200 + a.valor / 10 - i }));
    // Ações de todas as lojas, sem repetir, as mais importantes primeiro
    const todas = [...acoesMeta, ...acoesDoRaioX(raioX), ...lojas.flatMap(L => acoesDaLoja(L, { pendentes }))].sort((a, b) => b.peso - a.peso);
    const acoes = []; const vistos = new Set();
    for (const a of todas) { if (vistos.has(a.id)) continue; vistos.add(a.id); acoes.push(a); if (acoes.length >= MAX_ACOES) break; }
    // Resultado medido dos últimos 7 dias (o que levar ao cliente)
    const contasCli = new Set(lojas.map(L => L.conta));
    const med = medidos.filter(l => contasCli.has(String(l.conta_id)) && l.dados?.medicao?.medido_em && new Date(l.dados.medicao.medido_em).getTime() >= desde7 && ['melhorou', 'piorou', 'neutro'].includes(l.dados.medicao.veredito));
    const resultados = { medidas: med.length, melhoraram: med.filter(l => l.dados.medicao.veredito === 'melhorou').length, exemplos: med.filter(l => l.dados.medicao.veredito === 'melhorou').slice(0, 3).map(l => `${corta(String(l.titulo).replace(/^.*? — /, '').replace(/^Sugestão: /, ''), 50)}: ${l.dados.medicao.resumo}`) };
    // Semáforo
    const repAlto = lojas.some(L => L.reputacao?.risco === 'alto');
    const prazoCurto = acoes.some(a => a.id.startsWith('rec:') && a.peso >= 1800);
    const projPedidos = dd > 0 ? pedidos / dd * dm : 0;
    const pctMeta = meta ? proj / meta * 100 : metaPedidos ? projPedidos / metaPedidos * 100 : null;
    const semaforo = repAlto || prazoCurto || (pctMeta != null && pctMeta < 80) || (metaTacos && tacos != null && tacos > metaTacos * 1.3) ? 'vermelho'
      : (pctMeta != null && pctMeta < 95) || (metaTacos && tacos != null && tacos > metaTacos) || acoes.filter(a => a.quando === 'hoje').length >= 3 ? 'amarelo' : 'verde';
    const metricas = { faturamento: Math.round(fat), projecao: Math.round(proj), meta, metaPedidos, pedidos, projPedidos: Math.round(projPedidos), pctMetaPedidos: metaPedidos ? r1(projPedidos / metaPedidos * 100) : null, pctMeta: pctMeta == null ? null : r1(pctMeta), tacos: tacos == null ? null : r1(tacos), metaTacos, tetoTacos, varMes: varMes == null ? null : r1(varMes), lojas: lojas.length, dia: dd, diasMes: dm };
    if (meta && proj < meta && dm > dd) metricas.faltaPorDia = Math.round((meta - fat) / (dm - dd));
    if (dd > 0) metricas.ritmoDia = Math.round(fat / dd);
    const fatos = { cliente: c.nome, metricas, caminho_para_meta: caminho && { mes_da_meta: caminho.mesAlvo, falta_rs: caminho.faltaR, falta_pedidos: caminho.faltaPedidos, precisa_por_dia: caminho.precisaDia, ritmo_por_dia: caminho.ritmoDia, alavancas: caminho.alavancas.map(a => ({ o_que: a.titulo, rende_ate_fim_do_mes: a.valor, confianca: a.conf })), soma_alavancas: caminho.soma, cobertura_pct: caminho.cobertura, falta_alem_das_alavancas: caminho.resto, ads_extra_mantendo_tacos: caminho.adsExtra, teto_ads_tacos_pct: caminho.tetoTacos || null, folga_ads_ate_o_teto: caminho.folgaAds ?? null }, raio_x: raioX && { periodo: raioX.periodo, semana_antes: raioX.semanaAntes, semana_agora: raioX.semanaAgora, variacao_pct: raioX.var,
      funil_da_conta: raioX.funil && { visitas_sem: raioX.funil.visitas, conversao_pct: raioX.funil.conversao, preco_medio: raioX.funil.precoMedio, explicacao: raioX.funil.explica },
      oportunidades_funil: raioX.oportunidades,
      caiu: raioX.caiu.map(x => ({ produto: x.nome, loja: x.loja, antes_sem: x.antes, agora_sem: x.agora, perda_sem: x.perdaSem, preco_antes: x.precoAntes, preco_agora: x.precoAgora, funil: x.fn, causas: x.causas.map(c => c.t) })),
      subiu: raioX.subiu.map(x => ({ produto: x.nome, loja: x.loja, antes_sem: x.antes, agora_sem: x.agora, ganho_sem: x.ganhoSem, novo: x.novo, alerta: x.alerta })),
      lojas: raioX.lojas, concentracao_top5_pct: raioX.concentracaoTop5 },
      acoes: acoes.map(a => ({ quando: a.quando, quem: a.quem, titulo: a.titulo, porque: a.porque, impacto: a.impacto, loja: a.loja })), resultados_7_dias: resultados };
    const txt = await escrever(Anthropic, anthropicKey, fatos);
    const rxTxt = raioX ? ` Últimas 2 semanas: ${R$(raioX.semanaAgora)}/sem contra ${R$(raioX.semanaAntes)}/sem antes${raioX.var != null ? ` (${raioX.var >= 0 ? '+' : ''}${pct(raioX.var)})` : ''}${raioX.caiu[0] ? `; maior queda: ${raioX.caiu[0].nome} (−${R$(raioX.caiu[0].perdaSem)}/sem${raioX.caiu[0].causas[0] ? `, ${raioX.caiu[0].causas[0].t}` : ''})` : ''}${raioX.subiu[0] ? `; maior alta: ${raioX.subiu[0].nome} (+${R$(raioX.subiu[0].ganhoSem)}/sem)` : ''}.` : '';
    const diagRegra = `${pctMeta != null ? `Projeção do mês em ${pct(pctMeta)} da meta (${R$(proj)} de ${R$(meta)})` : `Projeção do mês ${R$(proj)}`}${varMes != null ? `, ${varMes >= 0 ? '+' : ''}${pct(varMes)} contra o mesmo período do mês passado` : ''}${tacos != null ? `; TACOS ${pct(tacos)}${metaTacos ? ` (meta ${pct(metaTacos)})` : ''}` : ''}. ${rxTxt} ${acoes[0] ? `Prioridade: ${acoes[0].titulo.toLowerCase()}.` : 'Nada urgente hoje.'}`;
    const pautaRegra = [
      resultados.medidas ? `- O que fizemos: ${resultados.medidas} ajuste(s) medido(s) nos últimos 7 dias, ${resultados.melhoraram} melhoraram${resultados.exemplos[0] ? ` (ex.: ${resultados.exemplos[0]})` : ''}.` : '- O que fizemos: acompanhamento diário do ADS e da operação.',
      ...acoes.filter(a => a.quem === 'cliente').map(a => `- Precisamos de você: ${a.titulo} — ${a.porque}.`),
      `- Próximos passos: ${acoes.filter(a => a.quem === 'analista').slice(0, 3).map(a => a.titulo.toLowerCase()).join('; ') || 'seguir o plano da semana'}.`,
    ].join('\n');
    const plano = {
      em: Date.now(), dia: isoBRT(0), cliente: { id: c.id, nome: c.nome, gestorId: c.gestorId ?? null, gestor: gestorNome(c.gestorId) },
      semaforo, metricas, acoes, resultados, raioX, caminho: caminho ? { ...caminho, promosMeta } : null, diagnostico: txt?.diagnostico || diagRegra, pauta: txt?.pauta || pautaRegra, fonteTexto: txt ? 'ia' : 'regra',
    };
    await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: `cliente:${c.id}`, recurso: 'plano', ultimo_sucesso: new Date().toISOString(), ultima_tentativa: new Date().toISOString(), ultimo_erro: null, registros: acoes.length, cursor: plano }, 'marketplace,conta_id,recurso');
    saida.push({ cliente: c.nome, semaforo, acoes: acoes.length });
  };
  // 2 clientes por vez (a IA leva alguns segundos por cliente; mais que isso esbarra no limite da API)
  await Promise.all(Array.from({ length: Math.min(2, alvo.length) }, async () => { while (iCli < alvo.length) { const c = alvo[iCli++]; try { await processar(c); } catch (e) { saida.push({ cliente: c.nome, erro: e.message }); } } }));
  return saida;
}

module.exports = { gerarPlanos, acoesDaLoja, calcularRaioX, calcularCaminho };
