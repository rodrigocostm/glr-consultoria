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

function causasDaQueda(x, L, mudancas) {
  const c = [];
  const sn = L.sinais?.itens?.[x.id];
  if (sn?.ne === 'zerado') c.push({ t: 'ficou sem estoque', tipo: 'estoque' });
  else if (sn?.ne === 'critico') c.push({ t: `estoque acabando (~${Math.round(sn.d)} d)`, tipo: 'estoque' });
  if (sn?.st && !/active|normal/i.test(sn.st)) c.push({ t: `anúncio ${String(sn.st).toLowerCase() === 'paused' ? 'pausado' : String(sn.st).toLowerCase()}`, tipo: 'anuncio' });
  const pa = x.a.un ? x.a.rec / x.a.un : null, pb = x.b.un ? x.b.rec / x.b.un : null;
  if (pa && pb && pb > pa * 1.05) c.push({ t: `preço vendido subiu de ${R$(pa)} para ${R$(pb)} (+${pct((pb / pa - 1) * 100)})`, tipo: 'preco' });
  for (const m of mudancas) c.push(m);
  const qa = L.qualidade?.itens?.[x.id]?.qa;
  if (qa) c.push({ t: corta(qa, 90), tipo: 'qualidade' });
  if (pa && pb && pb < pa * 0.95 && !c.length) c.push({ t: `caiu mesmo com o preço ${pct((1 - pb / pa) * 100)} menor — olhar concorrência e posição`, tipo: 'preco' });
  return c;
}

// mudanças de ADS no período que tocam o produto (Shopee: campanha = produto, pelo nome;
// ML: sugestão aplicada com o anúncio na lista)
function mudancasAds(x, L, medidos, desdeIso) {
  const out = [], nx = norm(x.nome).slice(0, 28);
  for (const l of medidos) {
    if (String(l.conta_id) !== L.conta || !l.criado_em || diaDe(l.criado_em) < desdeIso) continue;
    const d = l.dados || {}, quando = dm(diaDe(d.aplicado_em || l.criado_em));
    const ids = (d.item_ids || []).map(String);
    if (L.mkt === 'ml' && ids.includes(String(x.id))) {
      const t = { retirar_produto: 'saiu da campanha', mover_produto: `foi movido para ${d.destino || 'outra campanha'}`, pausar: 'campanha pausada' }[d.acao];
      if (t) out.push({ t: `${t} em ${quando}`, tipo: 'ads' });
      continue;
    }
    if (L.mkt !== 'shopee') continue;
    const camp = norm(String(l.titulo || '').split(' — ').slice(1).join(' ')).slice(0, 28);
    if (!camp || nx.length < 12 || !(camp.startsWith(nx.slice(0, 20)) || nx.startsWith(camp.slice(0, 20)))) continue;
    if (d.roas_para != null && d.roas_de != null && +d.roas_para > +d.roas_de) out.push({ t: `ROAS da campanha subiu de ${r1(d.roas_de)}x para ${r1(d.roas_para)}x em ${quando} (lance mais conservador)`, tipo: 'ads' });
    else if (d.budget_para != null && d.budget_de != null && +d.budget_para < +d.budget_de) out.push({ t: `orçamento cortado de ${R$(d.budget_de)} para ${R$(d.budget_para)}/dia em ${quando}`, tipo: 'ads' });
    else if (/^Campanha pausada/.test(l.titulo || '') || d.pausada) out.push({ t: `campanha pausada em ${quando}`, tipo: 'ads' });
  }
  return out.slice(-2);
}

function calcularRaioX(lojas, pedidosPor, medidos) {
  const bIni = isoBRT(JANELA), bFim = isoBRT(1), aIni = isoBRT(JANELA * 2), aFim = isoBRT(JANELA + 1);
  const itens = new Map(), porLoja = [];
  let totA = 0, totB = 0, lojasComp = 0;
  for (const L of lojas) {
    const peds = pedidosPor.get(L.conta);
    if (!peds) continue;
    // loja sem pedido antes da janela A (histórico ainda carregando) não entra na comparação
    const temA = peds.some(p => diaDe(p.criado_em) <= aFim);
    if (!temA) continue;
    lojasComp++;
    let la = 0, lb = 0;
    for (const p of peds) {
      const dia = diaDe(p.criado_em);
      const lado = dia >= bIni && dia <= bFim ? 'b' : dia >= aIni && dia <= aFim ? 'a' : null;
      if (!lado) continue;
      for (const i of (p.itens || [])) {
        if (!i.item_id) continue;
        const q = parseInt(i.qtd) || 1, v = (parseFloat(i.preco) || 0) * q;
        const k = `${L.conta}:${i.item_id}`;
        const x = itens.get(k) || { id: String(i.item_id), nome: i.nome || String(i.item_id), L, a: { rec: 0, un: 0 }, b: { rec: 0, un: 0 } };
        x[lado].rec += v; x[lado].un += q;
        if (lado === 'a') la += v; else lb += v;
        itens.set(k, x);
      }
    }
    totA += la; totB += lb;
    porLoja.push({ loja: nomeLoja(L), mkt: L.mkt, antes: Math.round(la / 2), agora: Math.round(lb / 2), var: la > 0 ? r1((lb - la) / la * 100) : null });
  }
  if (!lojasComp) return null;
  const sem = v => Math.round(v / 2); // 14 dias → por semana
  const lista = [...itens.values()].map(x => ({ ...x, delta: x.b.rec - x.a.rec }));
  const minRelev = Math.max(150, (totA + totB) / 4 * 0.01); // ≥ 1% do faturamento semanal
  const caiu = lista.filter(x => x.delta < 0 && -sem(x.delta) >= minRelev).sort((a, b) => a.delta - b.delta).slice(0, 6).map(x => ({
    id: x.id, nome: corta(x.nome, 70), loja: nomeLoja(x.L), conta: x.L.conta, mkt: x.L.mkt, antes: sem(x.a.rec), agora: sem(x.b.rec), perdaSem: -sem(x.delta), unAntes: x.a.un, unAgora: x.b.un,
    causas: causasDaQueda(x, x.L, mudancasAds(x, x.L, medidos, aIni)),
  }));
  const subiu = lista.filter(x => x.delta > 0 && sem(x.delta) >= minRelev).sort((a, b) => b.delta - a.delta).slice(0, 5).map(x => {
    const sn = x.L.sinais?.itens?.[x.id];
    return { id: x.id, nome: corta(x.nome, 70), loja: nomeLoja(x.L), antes: sem(x.a.rec), agora: sem(x.b.rec), ganhoSem: sem(x.delta), novo: x.a.rec === 0,
      alerta: sn?.ne === 'zerado' || sn?.ne === 'critico' ? `estoque ${sn.ne === 'zerado' ? 'zerado' : `para ~${Math.round(sn.d)} d`} — repor antes de acelerar` : null };
  });
  const topB = lista.slice().sort((a, b) => b.b.rec - a.b.rec);
  const conc = totB > 0 ? r1(topB.slice(0, 5).reduce((s, x) => s + x.b.rec, 0) / totB * 100) : null;
  return {
    periodo: { antes: `${dm(aIni)} a ${dm(aFim)}`, agora: `${dm(bIni)} a ${dm(bFim)}` },
    semanaAntes: sem(totA), semanaAgora: sem(totB), var: totA > 0 ? r1((totB - totA) / totA * 100) : null,
    lojas: porLoja.sort((a, b) => (a.agora - a.antes) - (b.agora - b.antes)), caiu, subiu, concentracaoTop5: conc,
    produtosVendendo: lista.filter(x => x.b.un > 0).length, produtosQueZeraram: lista.filter(x => x.a.un >= 3 && x.b.un === 0).length,
  };
}

// Queda relevante vira ação, com a causa já apontada
function acoesDoRaioX(rx) {
  if (!rx) return [];
  return rx.caiu.slice(0, 3).map(x => {
    const tipo = x.causas[0]?.tipo;
    const tela = tipo === 'estoque' ? 'estoque-margem' : tipo === 'ads' ? (x.mkt === 'ml' ? 'agente-ml' : 'agente') : tipo === 'preco' ? (x.mkt === 'ml' ? 'precos-ml' : 'vendas') : tipo === 'qualidade' ? 'qualidade-anuncios' : 'vendas';
    return { id: `fat:${x.conta}:${x.id}`, conta: x.conta, mkt: x.mkt, loja: x.loja, tipo: 'faturamento', tela,
      quando: 'hoje', quem: tipo === 'estoque' ? 'cliente' : 'analista',
      titulo: `Recuperar ${corta(x.nome, 50)}: caiu ${R$(x.perdaSem)}/sem`,
      porque: `vendia ${R$(x.antes)}/sem (${x.unAntes} un. em 14 d), agora ${R$(x.agora)}/sem (${x.unAgora} un.) — ${x.causas.length ? x.causas.map(c => c.t).join('; ') : 'sem causa clara nos dados: conferir concorrência, posição na busca e avaliações'}`,
      impacto: `~${R$(x.perdaSem)}/sem em vendas`, valor: x.perdaSem, peso: 1000 + x.perdaSem / 5 };
  });
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
      system: 'Você é o gerente de conta de uma consultoria de marketplaces (Mercado Livre e Shopee). Escreve para o analista da própria consultoria, em português do Brasil, direto e prático. Use SOMENTE os números e fatos do JSON — nunca invente número, produto, prazo ou ação. Responda APENAS um JSON válido: {"diagnostico":"até 4 frases: como o cliente está no mês (faturamento x meta/projeção, TACOS) e, pelo raio_x, DE ONDE o faturamento está vindo e PARA ONDE está indo — os produtos que mais caíram em R$/semana e a causa apontada, e os que mais cresceram. Cite produto e valor.","pauta":"pauta do dia para o analista conversar com o cliente, em tópicos curtos com hífen: 1) como o faturamento andou nas últimas 2 semanas e o que puxou/derrubou (raio_x), 2) o que fizemos e o resultado medido (se houver), 3) o que precisamos do cliente (só as ações com quem=cliente), 4) próximos passos. Tom cordial, pronto para virar mensagem. No máximo 8 tópicos, cada um com até 2 frases."}',
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
async function gerarPlanos(h, filtroCliente) {
  const { sbSelect, sbUpsert, lerStorage, anthropicKey, Anthropic } = h;
  const [clientes, vinc, metas, gestores, estados, configs, pendentes, medidos] = await Promise.all([
    lerStorage('glr_clientes').then(x => x || []), lerStorage('glr_mc_vinculos').then(x => x || {}), lerStorage('glr_metas').then(x => x || {}), lerStorage('glr_gestores').then(x => x || []),
    sbSelect('glr_sync_estado', 'recurso=in.(resumo,sinais,promocoes,reputacao,qualidade)&marketplace=in.(ml,shopee)&select=marketplace,conta_id,recurso,cursor').catch(() => []),
    sbSelect('glr_agente_config', 'select=conta_id,marketplace,meta_acos,cliente_nome').catch(() => []),
    sbSelect('glr_agente_log', `tipo=eq.alerta&resultado=eq.so_alerta&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 10 * 864e5).toISOString())}&select=conta_id,titulo,dados&limit=3000`).catch(() => []),
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
      lojas.push({ mkt, conta, nome: ct.nickname || '', resumo: e.resumo, sinais: e.sinais, promocoes: e.promocoes, reputacao: e.reputacao, qualidade: e.qualidade });
    }
    if (!lojas.length) return;
    // Métricas do mês (todas as lojas)
    let fat = 0, ads = 0, fatAnt = 0, cobreAnt = true;
    for (const L of lojas) {
      const m = somarDias(L.resumo?.dias, mesIni, ontem); fat += m.faturamento; ads += m.ads;
      const a = somarDias(L.resumo?.dias, antIni, antFim); if (!a.cobre) cobreAnt = false; fatAnt += a.faturamento;
    }
    const proj = dd > 0 ? fat / dd * dm : 0;
    const meta = parseFloat(metas[c.id] ?? metas[String(c.id)]) || parseFloat(c.metaMensal) || null; // meta da Projeção ou do cadastro
    const tacos = fat > 0 ? ads / fat * 100 : null;
    const metasTacos = lojas.map(L => parseFloat(cfgDe[L.conta]?.meta_acos)).filter(v => v > 0);
    const metaTacos = metasTacos.length ? Math.min(...metasTacos) : null;
    const varMes = cobreAnt && fatAnt > 0 ? (fat - fatAnt) / fatAnt * 100 : null;
    // Raio-X: pedidos dos últimos 28 dias de cada loja (em paralelo)
    let raioX = null;
    if (Date.now() < prazo) {
      const desde = new Date(`${isoBRT(JANELA * 2)}T03:00:00Z`).toISOString();
      const peds = await Promise.all(lojas.map(L => pedidosDaLoja(sbSelect, L, desde)));
      const pedidosPor = new Map(lojas.map((L, i) => [L.conta, peds[i]]));
      try { raioX = calcularRaioX(lojas, pedidosPor, medidos); } catch (e) { raioX = null; }
    }
    // Ações de todas as lojas, sem repetir, as mais importantes primeiro
    const todas = [...acoesDoRaioX(raioX), ...lojas.flatMap(L => acoesDaLoja(L, { pendentes }))].sort((a, b) => b.peso - a.peso);
    const acoes = []; const vistos = new Set();
    for (const a of todas) { if (vistos.has(a.id)) continue; vistos.add(a.id); acoes.push(a); if (acoes.length >= MAX_ACOES) break; }
    // Resultado medido dos últimos 7 dias (o que levar ao cliente)
    const contasCli = new Set(lojas.map(L => L.conta));
    const med = medidos.filter(l => contasCli.has(String(l.conta_id)) && l.dados?.medicao?.medido_em && new Date(l.dados.medicao.medido_em).getTime() >= desde7 && ['melhorou', 'piorou', 'neutro'].includes(l.dados.medicao.veredito));
    const resultados = { medidas: med.length, melhoraram: med.filter(l => l.dados.medicao.veredito === 'melhorou').length, exemplos: med.filter(l => l.dados.medicao.veredito === 'melhorou').slice(0, 3).map(l => `${corta(String(l.titulo).replace(/^.*? — /, '').replace(/^Sugestão: /, ''), 50)}: ${l.dados.medicao.resumo}`) };
    // Semáforo
    const repAlto = lojas.some(L => L.reputacao?.risco === 'alto');
    const prazoCurto = acoes.some(a => a.id.startsWith('rec:') && a.peso >= 1800);
    const pctMeta = meta ? proj / meta * 100 : null;
    const semaforo = repAlto || prazoCurto || (pctMeta != null && pctMeta < 80) || (metaTacos && tacos != null && tacos > metaTacos * 1.3) ? 'vermelho'
      : (pctMeta != null && pctMeta < 95) || (metaTacos && tacos != null && tacos > metaTacos) || acoes.filter(a => a.quando === 'hoje').length >= 3 ? 'amarelo' : 'verde';
    const metricas = { faturamento: Math.round(fat), projecao: Math.round(proj), meta, pctMeta: pctMeta == null ? null : r1(pctMeta), tacos: tacos == null ? null : r1(tacos), metaTacos, varMes: varMes == null ? null : r1(varMes), lojas: lojas.length, dia: dd, diasMes: dm };
    if (meta && proj < meta && dm > dd) metricas.faltaPorDia = Math.round((meta - fat) / (dm - dd));
    if (dd > 0) metricas.ritmoDia = Math.round(fat / dd);
    const fatos = { cliente: c.nome, metricas, raio_x: raioX && { periodo: raioX.periodo, semana_antes: raioX.semanaAntes, semana_agora: raioX.semanaAgora, variacao_pct: raioX.var,
      caiu: raioX.caiu.map(x => ({ produto: x.nome, loja: x.loja, antes_sem: x.antes, agora_sem: x.agora, perda_sem: x.perdaSem, causas: x.causas.map(c => c.t) })),
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
      semaforo, metricas, acoes, resultados, raioX, diagnostico: txt?.diagnostico || diagRegra, pauta: txt?.pauta || pautaRegra, fonteTexto: txt ? 'ia' : 'regra',
    };
    await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: `cliente:${c.id}`, recurso: 'plano', ultimo_sucesso: new Date().toISOString(), ultima_tentativa: new Date().toISOString(), ultimo_erro: null, registros: acoes.length, cursor: plano }, 'marketplace,conta_id,recurso');
    saida.push({ cliente: c.nome, semaforo, acoes: acoes.length });
  };
  // 2 clientes por vez (a IA leva alguns segundos por cliente; mais que isso esbarra no limite da API)
  await Promise.all(Array.from({ length: Math.min(2, alvo.length) }, async () => { while (iCli < alvo.length) { const c = alvo[iCli++]; try { await processar(c); } catch (e) { saida.push({ cliente: c.nome, erro: e.message }); } } }));
  return saida;
}

module.exports = { gerarPlanos, acoesDaLoja, calcularRaioX };
