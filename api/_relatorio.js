// ============================================================
// GLR Consultoria — Resumo da manhã (celular) e relatório semanal do cliente
// ------------------------------------------------------------
// • resumoDaManha: todo dia às 08:00 um aviso só no celular com o que precisa de
//   você hoje — vendas de ontem × mesmo dia da semana passada, saldo de ADS da
//   Shopee, conexões com problema e a Caixa de decisões. Os avisos urgentes
//   (saldo zerado/acabando, conexão que caiu) continuam saindo na hora.
// • relatoriosSemanais: toda segunda às 08:00, por cliente (todas as lojas), a
//   semana passada (segunda a domingo) × a anterior: faturamento, pedidos, ADS e
//   TACOS por marketplace, o que os agentes aplicaram e o resultado medido, e o
//   que ficou pendente. Texto pronto para você revisar e mandar ao cliente —
//   nada é enviado. Grava em glr_sync_estado (sistema / cliente:<id> /
//   relatorio_semana); a tela Relatório semanal lê dali.
// Tudo por regra, com os números da base sincronizada — nada é inventado.
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

const MKT = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : m === 'amazon' ? 'amazon' : ['tiktok', 'tiktok_shop', 'tiktokshop'].includes(m) ? 'tiktok' : m === 'magalu' ? 'magalu' : m === 'shein' ? 'shein' : null; };
const NOME_MKT = { shopee: 'Shopee', ml: 'Mercado Livre', amazon: 'Amazon', tiktok: 'TikTok Shop', magalu: 'Magalu', shein: 'Shein' };
const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const mil = v => v >= 1000 ? `R$ ${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace('.', ',')} mil` : R$(v);
const pct = v => v == null || !isFinite(v) ? '—' : `${(Math.round(v * 10) / 10).toString().replace('.', ',')}%`;
const varTxt = (a, b) => b > 0 ? `${a >= b ? '+' : '−'}${pct(Math.abs((a - b) / b * 100))}` : null;
const isoBRT = (diasAtras = 0) => { const d = new Date(Date.now() - 3 * 3600e3); d.setUTCDate(d.getUTCDate() - diasAtras); return d.toISOString().slice(0, 10); };
const isoMais = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dm = iso => iso.split('-').reverse().slice(0, 2).join('/');
const DIA_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function somar(dias, de, ate) {
  const t = { faturamento: 0, ads: 0, pedidos: 0, cobre: false };
  for (const [d, v] of Object.entries(dias || {})) {
    if (d < de || d > ate) continue;
    t.cobre = true; t.faturamento += parseFloat(v.faturamento) || 0; t.ads += parseFloat(v.ads) || 0; t.pedidos += parseInt(v.pedidos) || 0;
  }
  return t;
}
async function lerBases(sbSelect) {
  const rows = await sbSelect('glr_sync_estado', 'recurso=eq.resumo&select=marketplace,conta_id,dias:cursor->dias').catch(() => []);
  return new Map(rows.map(r => [`${r.marketplace}:${r.conta_id}`, r.dias || {}]));
}
async function lerSistema(sbSelect, conta, recurso) {
  return (await sbSelect('glr_sync_estado', `marketplace=eq.sistema&conta_id=eq.${encodeURIComponent(conta)}&recurso=eq.${recurso}&select=cursor`).catch(() => []))[0]?.cursor || null;
}

// ── Resumo da manhã ──
async function resumoDaManha({ sbSelect }, simular = false) {
  const ontem = isoBRT(1), semanaPassada = isoMais(ontem, -7);
  const [bases, saldo, conex, pend] = await Promise.all([
    lerBases(sbSelect), lerSistema(sbSelect, 'saldo_ads', 'shopee'), lerSistema(sbSelect, 'conexoes', 'todas'),
    sbSelect('glr_agente_log', `tipo=eq.alerta&resultado=eq.so_alerta&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 10 * 864e5).toISOString())}&select=dados&limit=5000`).catch(() => []),
  ]);
  let v1 = 0, v0 = 0, p1 = 0;
  for (const dias of bases.values()) { const a = somar(dias, ontem, ontem), b = somar(dias, semanaPassada, semanaPassada); v1 += a.faturamento; p1 += a.pedidos; v0 += b.faturamento; }
  const lojas = Object.values(saldo?.lojas || {}), n = k => lojas.filter(s => s.nivel === k).length;
  const contas = Object.values(conex?.contas || {}), probl = contas.filter(c => c.status === 'erro' || c.status === 'ads').length;
  const pendentes = pend.filter(l => l.dados?.acao !== 'abc_queda');
  const promo = pendentes.filter(l => l.dados?.promo_aprovar).length;
  const linhas = [];
  linhas.push(`Vendas ontem: ${mil(v1)} em ${p1} pedido(s)${varTxt(v1, v0) ? ` (${varTxt(v1, v0)} vs ${DIA_SEMANA[new Date(`${semanaPassada}T12:00:00Z`).getUTCDay()]} passado)` : ''}`);
  if (n('zerado') + n('critico') + n('baixo')) linhas.push(`Saldo de ADS Shopee: ${[n('zerado') ? `${n('zerado')} zerada(s)` : '', n('critico') ? `${n('critico')} acaba(m) hoje` : '', n('baixo') ? `${n('baixo')} baixa(s)` : ''].filter(Boolean).join(', ')}`);
  if (probl) linhas.push(`Conexões: ${probl} com problema`);
  linhas.push(`Caixa de decisões: ${pendentes.length} pendente(s)${promo ? `, ${promo} promoção(ões) para aprovar` : ''}`);
  const titulo = '☀️ Bom dia — o que precisa de você hoje';
  if (simular) return { simulacao: true, titulo, linhas };
  const enviados = await require('./_alerta').avisar(sbSelect, titulo, linhas.join('\n'), 'resumo-manha', '/#decisoes').catch(() => 0);
  return { titulo, linhas, enviados };
}

// ── Relatório semanal por cliente ──
async function relatoriosSemanais({ sbSelect, sbUpsert, lerStorage }, filtroCliente) {
  // semana passada: segunda a domingo (a última semana fechada)
  const hoje = isoBRT(0), dow = new Date(`${hoje}T12:00:00Z`).getUTCDay();
  const fim = isoMais(hoje, -(dow === 0 ? 7 : dow)), ini = isoMais(fim, -6), antFim = isoMais(ini, -1), antIni = isoMais(antFim, -6);
  const [clientes, vinc, bases, saldo, conex, exec] = await Promise.all([
    lerStorage('glr_clientes').then(x => x || []), lerStorage('glr_mc_vinculos').then(x => x || {}), lerBases(sbSelect),
    lerSistema(sbSelect, 'saldo_ads', 'shopee'), lerSistema(sbSelect, 'conexoes', 'todas'),
    sbSelect('glr_agente_log', `tipo=in.(decisao,alerta)&resultado=eq.executado&criado_em=gte.${encodeURIComponent(new Date(Date.parse(`${antIni}T03:00:00Z`)).toISOString())}&select=conta_id,titulo,dados,criado_em&order=criado_em.desc&limit=8000`).catch(() => []),
  ]);
  const naSemana = iso => { const d = new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10); return d >= ini && d <= fim; };
  const saida = [];
  for (const c of clientes.filter(c => !filtroCliente || String(c.id) === String(filtroCliente))) {
    const contas = (vinc[String(c.id)] || []).map(ct => ({ mkt: MKT(ct.marketplace), id: String(ct.param_to_use?.shopId || ct.param_to_use?.meliUserId || ct.param_to_use?.amazon_account_id || ct.param_to_use?.magalu_account_id || ct.param_to_use?.shein_supplier_id || ct.external_id), ext: String(ct.external_id || '') })).filter(x => x.mkt);
    if (!contas.length) continue;
    const ids = new Set(contas.flatMap(x => [x.id, x.ext]));
    // números por marketplace
    const porMkt = {};
    for (const ct of contas) {
      const dias = bases.get(`${ct.mkt}:${ct.id}`) || bases.get(`${ct.mkt}:${ct.ext}`); if (!dias) continue;
      const a = somar(dias, ini, fim), b = somar(dias, antIni, antFim);
      const m = porMkt[ct.mkt] = porMkt[ct.mkt] || { fat: 0, ped: 0, ads: 0, fat0: 0, ped0: 0, ads0: 0 };
      m.fat += a.faturamento; m.ped += a.pedidos; m.ads += a.ads; m.fat0 += b.faturamento; m.ped0 += b.pedidos; m.ads0 += b.ads;
    }
    const tot = Object.values(porMkt).reduce((t, m) => { for (const k of Object.keys(m)) t[k] = (t[k] || 0) + m[k]; return t; }, {});
    if (!tot.fat && !tot.fat0) continue; // cliente sem dados na base
    // o que os agentes aplicaram na semana e o resultado medido
    const doCli = exec.filter(l => ids.has(String(l.conta_id)));
    const aplicadas = doCli.filter(l => naSemana(l.criado_em) && (l.dados?.acao || l.dados?.campaign_id || l.dados?.pausar != null));
    const medidas = doCli.filter(l => l.dados?.medicao?.veredito && l.dados?.medicao?.medido_em && naSemana(l.dados.medicao.medido_em));
    const melhorou = medidas.filter(l => l.dados.medicao.veredito === 'melhorou').length, piorou = medidas.filter(l => l.dados.medicao.veredito === 'piorou').length;
    // pendências do cliente
    const saldoRuim = contas.filter(ct => ct.mkt === 'shopee').map(ct => saldo?.lojas?.[ct.id]).filter(s => s && ['zerado', 'critico', 'baixo'].includes(s.nivel));
    const conexRuim = Object.values(conex?.contas || {}).filter(x => (x.status === 'erro' || x.status === 'ads') && ids.has(String(x.id)));
    // texto pronto para o cliente
    const L = [];
    L.push(`Olá! Segue o resumo da semana de ${dm(ini)} a ${dm(fim)} — ${c.nome || 'sua loja'}.`);
    L.push('');
    L.push(`Faturamento: ${R$(tot.fat)}${varTxt(tot.fat, tot.fat0) ? ` (${varTxt(tot.fat, tot.fat0)} vs semana anterior)` : ''} em ${tot.ped} pedido(s).`);
    if (tot.ads > 0) L.push(`Investimento em ADS: ${R$(tot.ads)} — TACOS ${pct(tot.fat > 0 ? tot.ads / tot.fat * 100 : null)}${tot.fat0 > 0 && tot.ads0 > 0 ? ` (semana anterior: ${pct(tot.ads0 / tot.fat0 * 100)})` : ''}.`);
    const mkts = Object.entries(porMkt).filter(([, m]) => m.fat || m.fat0).sort((a, b) => b[1].fat - a[1].fat);
    if (mkts.length > 1) {
      L.push('');
      L.push('Por marketplace:');
      for (const [k, m] of mkts) L.push(`• ${NOME_MKT[k]}: ${R$(m.fat)}${varTxt(m.fat, m.fat0) ? ` (${varTxt(m.fat, m.fat0)})` : ''}, ${m.ped} pedido(s)${m.ads > 0 ? `, ADS ${R$(m.ads)} (TACOS ${pct(m.fat > 0 ? m.ads / m.fat * 100 : null)})` : ''}`);
    }
    if (aplicadas.length || medidas.length) {
      L.push('');
      L.push(`Otimizações: ${aplicadas.length} ajuste(s) nas campanhas de ADS nesta semana${medidas.length ? `; dos ajustes medidos (7 dias antes × 7 depois), ${melhorou} melhoraram${piorou ? ` e ${piorou} pioraram (já revisados)` : ''}` : ''}.`);
    }
    const pend = [];
    for (const s of saldoRuim) pend.push(`saldo de ADS da Shopee ${s.nivel === 'zerado' ? 'zerado (anúncios parados)' : s.nivel === 'critico' ? `acabando (${R$(s.saldo)})` : `baixo (${R$(s.saldo)})`} — recarregar em Marketing → Anúncios Shopee`);
    for (const x of conexRuim) pend.push(`reconectar a conta ${NOME_MKT[x.mkt]} (${x.acao ? x.acao.split('. ')[0].replace(/\.$/, '').replace(/^./, ch => ch.toLowerCase()) : 'conexão com problema'})`);
    if (pend.length) { L.push(''); L.push('Precisamos da sua ajuda com:'); for (const p of pend) L.push(`• ${p}`); }
    L.push('');
    L.push('Qualquer dúvida, estamos à disposição!');
    const cursor = { em: Date.now(), semana_de: ini, semana_ate: fim, cliente: { id: c.id, nome: c.nome || '' }, texto: L.join('\n'),
      numeros: { total: tot, porMkt, aplicadas: aplicadas.length, medidas: medidas.length, melhorou, piorou, pendencias: pend.length } };
    await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: `cliente:${c.id}`, recurso: 'relatorio_semana', ultima_tentativa: new Date().toISOString(), ultimo_sucesso: new Date().toISOString(), cursor }, 'marketplace,conta_id,recurso');
    saida.push({ cliente: c.nome, fat: Math.round(tot.fat) });
  }
  return { semana: `${ini} a ${fim}`, clientes: saida.length };
}

module.exports = { resumoDaManha, relatoriosSemanais };
