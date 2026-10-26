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
function acoesDaLoja(L, log) {
  const A = [], tag = `${MKT_NOME[L.mkt]}${L.nome ? ' ' + L.nome : ''}`;
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
      titulo: `Responder ${np} pergunta(s) sem resposta`, porque: `a mais antiga está há ${rp.resumo.perguntaMaisAntigaH ?? '?'} h${rp.resumo.rascunhos ? `; ${rp.resumo.rascunhos} já com rascunho do agente` : ''} — pergunta parada é venda perdida`, impacto: 'conversão', peso: 600 + Math.min(400, (rp.resumo.perguntaMaisAntigaH || 0) * 10) });
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
      titulo: `${corta(com.t, 60)} (${com.n} anúncios)`, porque: 'a mesma pendência em vários anúncios é ajuste de processo', impacto: 'conversão', peso: 300 + com.n * 10 });
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
      max_tokens: 2000,
      system: 'Você é o gerente de conta de uma consultoria de marketplaces (Mercado Livre e Shopee). Escreve para o analista da própria consultoria, em português do Brasil, direto e prático. Use SOMENTE os números e fatos do JSON — nunca invente número, produto, prazo ou ação. Responda APENAS um JSON válido: {"diagnostico":"até 3 frases: como o cliente está no mês (faturamento x meta/projeção, TACOS) e os 1-2 pontos que mais pesam hoje","pauta":"pauta do dia para o analista conversar com o cliente, em tópicos curtos com hífen: 1) o que fizemos e o resultado medido (se houver), 2) o que precisamos do cliente (só as ações com quem=cliente), 3) próximos passos. Tom cordial, pronto para virar mensagem. No máximo 8 tópicos, cada um com até 2 frases."}',
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
    sbSelect('glr_agente_log', `tipo=in.(decisao,alerta)&resultado=eq.executado&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 46 * 864e5).toISOString())}&select=conta_id,titulo,dados&limit=3000`).catch(() => []),
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
    // Ações de todas as lojas, sem repetir, as mais importantes primeiro
    const todas = lojas.flatMap(L => acoesDaLoja(L, { pendentes })).sort((a, b) => b.peso - a.peso);
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
    const fatos = { cliente: c.nome, metricas, acoes: acoes.map(a => ({ quando: a.quando, quem: a.quem, titulo: a.titulo, porque: a.porque, impacto: a.impacto, loja: a.loja })), resultados_7_dias: resultados };
    const txt = await escrever(Anthropic, anthropicKey, fatos);
    const diagRegra = `${pctMeta != null ? `Projeção do mês em ${pct(pctMeta)} da meta (${R$(proj)} de ${R$(meta)})` : `Projeção do mês ${R$(proj)}`}${varMes != null ? `, ${varMes >= 0 ? '+' : ''}${pct(varMes)} contra o mesmo período do mês passado` : ''}${tacos != null ? `; TACOS ${pct(tacos)}${metaTacos ? ` (meta ${pct(metaTacos)})` : ''}` : ''}. ${acoes[0] ? `Prioridade: ${acoes[0].titulo.toLowerCase()}.` : 'Nada urgente hoje.'}`;
    const pautaRegra = [
      resultados.medidas ? `- O que fizemos: ${resultados.medidas} ajuste(s) medido(s) nos últimos 7 dias, ${resultados.melhoraram} melhoraram${resultados.exemplos[0] ? ` (ex.: ${resultados.exemplos[0]})` : ''}.` : '- O que fizemos: acompanhamento diário do ADS e da operação.',
      ...acoes.filter(a => a.quem === 'cliente').map(a => `- Precisamos de você: ${a.titulo} — ${a.porque}.`),
      `- Próximos passos: ${acoes.filter(a => a.quem === 'analista').slice(0, 3).map(a => a.titulo.toLowerCase()).join('; ') || 'seguir o plano da semana'}.`,
    ].join('\n');
    const plano = {
      em: Date.now(), dia: isoBRT(0), cliente: { id: c.id, nome: c.nome, gestorId: c.gestorId ?? null, gestor: gestorNome(c.gestorId) },
      semaforo, metricas, acoes, resultados, diagnostico: txt?.diagnostico || diagRegra, pauta: txt?.pauta || pautaRegra, fonteTexto: txt ? 'ia' : 'regra',
    };
    await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: `cliente:${c.id}`, recurso: 'plano', ultimo_sucesso: new Date().toISOString(), ultima_tentativa: new Date().toISOString(), ultimo_erro: null, registros: acoes.length, cursor: plano }, 'marketplace,conta_id,recurso');
    saida.push({ cliente: c.nome, semaforo, acoes: acoes.length });
  };
  // 2 clientes por vez (a IA leva alguns segundos por cliente; mais que isso esbarra no limite da API)
  await Promise.all(Array.from({ length: Math.min(2, alvo.length) }, async () => { while (iCli < alvo.length) { const c = alvo[iCli++]; try { await processar(c); } catch (e) { saida.push({ cliente: c.nome, erro: e.message }); } } }));
  return saida;
}

module.exports = { gerarPlanos, acoesDaLoja };
