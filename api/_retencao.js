// ============================================================
// GLR Consultoria — Agente de Retenção
// ------------------------------------------------------------
// Todo dia (07:00, antes do resumo das 8h) dá a cada cliente ativo um risco de
// cancelar, somando sinais que a base já tem — cliente que perde venda, não bate
// meta ou fica com pendência parada é o que cancela; cliente perdido leva a
// comissão inteira:
//  • loja sem venda nos últimos 3 dias (vendia antes)         até 40 pts
//  • queda de faturamento: 14 dias contra a média das 6       até 40 pts
//    semanas antes (dilui um pico de data especial, como o 10.10)
//  • queda contra o mesmo período do mês passado              até 15 pts
//  • projeção do mês abaixo da meta                           até 20 pts
//  • ADS da Shopee sem saldo em dias da última semana         até 15 pts
//  • conta desconectada / sem permissão de Ads                até 15 pts
//  • reputação em risco                                       até 10 pts
// Risco alto ≥ 50, médio ≥ 30. Loja parada só conta para quem vendia ≥ 10
// pedidos a cada 14 dias (cliente pequeno fica dias sem vender e é normal). Para cada motivo, uma ação de recuperação; para
// os clientes em risco, os produtos que mais caíram (glr_pedidos, 14 × 14 dias).
// Cliente que ENTRA em risco alto: aviso no celular + Caixa de decisões
// (glr_agente_log alerta, dados.acao 'retencao'); quando sai do risco alto, o
// aviso pendente fecha sozinho. Estado: glr_sync_estado sistema / retencao / todas.
// Tela: js/pages-retencao.js. Só lê — não mexe em nada no marketplace.
// ============================================================

const MKT = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : m === 'amazon' ? 'amazon' : ['tiktok', 'tiktok_shop', 'tiktokshop'].includes(m) ? 'tiktok' : m === 'magalu' ? 'magalu' : m === 'shein' ? 'shein' : null; };
const NOME_MKT = { shopee: 'Shopee', ml: 'Mercado Livre', amazon: 'Amazon', tiktok: 'TikTok Shop', magalu: 'Magalu', shein: 'Shein' };
const R$ = v => 'R$ ' + Math.round(parseFloat(v) || 0).toLocaleString('pt-BR');
const pct = v => `${v > 0 ? '+' : ''}${Math.round(v)}%`;
const isoBRT = (n = 0) => { const d = new Date(Date.now() - 3 * 3600e3); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const isoMais = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const contaDe = ct => String(ct.param_to_use?.shopId || ct.param_to_use?.meliUserId || ct.param_to_use?.amazon_account_id || ct.param_to_use?.magalu_account_id || ct.param_to_use?.shein_supplier_id || ct.external_id || '');
const ALTO = 50, MEDIO = 30;

function somar(dias, de, ate) {
  const t = { fat: 0, ped: 0 };
  for (const [d, v] of Object.entries(dias)) if (d >= de && d <= ate) { t.fat += parseFloat(v.faturamento) || 0; t.ped += parseInt(v.pedidos) || 0; }
  return t;
}

// produtos que mais perderam faturamento: últimos 14 dias × os 14 anteriores (só para quem está em risco)
async function produtosEmQueda(sbSelect, contas, ontem) {
  const ini = isoMais(ontem, -27), corte = isoMais(ontem, -13);
  const p = new Map();
  for (const ct of contas) {
    for (let off = 0; off < 15000; off += 1000) {
      const rows = await sbSelect('glr_pedidos', `marketplace=eq.${ct.mkt}&conta_id=eq.${encodeURIComponent(ct.id)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(`${ini}T03:00:00Z`)}&select=criado_em,itens&limit=1000&offset=${off}`).catch(() => []);
      for (const r of rows) {
        const recente = new Date(Date.parse(r.criado_em) - 3 * 3600e3).toISOString().slice(0, 10) >= corte;
        for (const i of (Array.isArray(r.itens) ? r.itens : [])) {
          const k = `${ct.mkt}:${i.item_id || i.nome}`, x = p.get(k) || { nome: String(i.nome || '').slice(0, 90), mkt: ct.mkt, a: 0, b: 0, ua: 0, ub: 0 };
          const q = parseInt(i.qtd) || 1, v = q * (parseFloat(i.preco) || 0);
          if (recente) { x.a += v; x.ua += q; } else { x.b += v; x.ub += q; }
          p.set(k, x);
        }
      }
      if (rows.length < 1000) break;
    }
  }
  return [...p.values()].map(x => ({ ...x, delta: Math.round(x.a - x.b) })).filter(x => x.delta < -100).sort((a, b) => a.delta - b.delta).slice(0, 6)
    .map(x => ({ nome: x.nome, mkt: x.mkt, antes: Math.round(x.b), agora: Math.round(x.a), un_antes: x.ub, un_agora: x.ua, delta: x.delta }));
}

async function avaliarCarteira({ sbSelect, sbUpsert, sbInsert, sbUpdate, lerStorage }, { simular = false } = {}) {
  const ontem = isoBRT(1);
  const [clientes, vinc, gestores, metas, metasPed, bases, saldo, conex, reps, zerados, anterior] = await Promise.all([
    lerStorage('glr_clientes').then(x => x || []), lerStorage('glr_mc_vinculos').then(x => x || {}), lerStorage('glr_gestores').then(x => x || []),
    lerStorage('glr_metas').then(x => x || {}), lerStorage('glr_metas_pedidos').then(x => x || {}),
    sbSelect('glr_sync_estado', 'recurso=eq.resumo&select=marketplace,conta_id,dias:cursor->dias').then(rs => new Map(rs.map(r => [`${r.marketplace}:${r.conta_id}`, r.dias || {}]))).catch(() => new Map()),
    sbSelect('glr_sync_estado', 'marketplace=eq.sistema&conta_id=eq.saldo_ads&recurso=eq.shopee&select=cursor').then(r => r[0]?.cursor?.lojas || {}).catch(() => ({})),
    sbSelect('glr_sync_estado', 'marketplace=eq.sistema&conta_id=eq.conexoes&recurso=eq.todas&select=cursor').then(r => r[0]?.cursor?.contas || {}).catch(() => ({})),
    sbSelect('glr_sync_estado', 'recurso=eq.reputacao&select=marketplace,conta_id,res:cursor->resumo').catch(() => []),
    sbSelect('glr_agente_log', `tipo=eq.alerta&dados->>acao=eq.saldo_ads&dados->>nivel=eq.zerado&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}&select=conta_id,criado_em&limit=3000`).catch(() => []),
    sbSelect('glr_sync_estado', 'marketplace=eq.sistema&conta_id=eq.retencao&recurso=eq.todas&select=cursor').then(r => r[0]?.cursor?.clientes || {}).catch(() => ({})),
  ]);
  const diasZerado = new Map(); // loja Shopee → dias distintos com aviso de saldo zerado na última semana
  for (const z of zerados) { const s = diasZerado.get(String(z.conta_id)) || new Set(); s.add(new Date(Date.parse(z.criado_em) - 3 * 3600e3).toISOString().slice(0, 10)); diasZerado.set(String(z.conta_id), s); }
  const repDe = new Map(reps.map(r => [`${r.marketplace}:${r.conta_id}`, r.res || {}]));
  const gestorDe = c => (gestores.find(g => String(g.id) === String(c.gestorId)) || gestores.find(g => g.nome && g.nome === c.gestor))?.nome || c.gestor || '';

  const ini14 = isoMais(ontem, -13), ini56 = isoMais(ontem, -55), fim14b = isoMais(ontem, -14), ini3 = isoMais(ontem, -2), ini30 = isoMais(ontem, -29);
  const dd = +ontem.slice(8, 10), mesIni = ontem.slice(0, 8) + '01', diasMes = new Date(Date.UTC(+ontem.slice(0, 4), +ontem.slice(5, 7), 0)).getUTCDate();
  const antIni = isoMais(mesIni, -1).slice(0, 8) + '01', antDias = new Date(Date.UTC(+antIni.slice(0, 4), +antIni.slice(5, 7), 0)).getUTCDate();
  const antAte = isoMais(antIni, Math.min(dd, antDias) - 1);

  const saida = {};
  for (const c of clientes) {
    if (/inativ|cancel|encerr|pausad/i.test(String(c.status || ''))) continue;
    const contas = (vinc[String(c.id)] || []).map(ct => ({ mkt: MKT(ct.marketplace), id: contaDe(ct), ext: String(ct.external_id || '') })).filter(x => x.mkt && x.id);
    if (!contas.length) continue;
    const dias = {};
    for (const ct of contas) for (const [d, v] of Object.entries(bases.get(`${ct.mkt}:${ct.id}`) || bases.get(`${ct.mkt}:${ct.ext}`) || {})) {
      const x = dias[d] = dias[d] || { faturamento: 0, pedidos: 0 };
      x.faturamento += parseFloat(v.faturamento) || 0; x.pedidos += parseInt(v.pedidos) || 0;
    }
    const a14 = somar(dias, ini14, ontem), b42 = somar(dias, ini56, fim14b), u3 = somar(dias, ini3, ontem), m30 = somar(dias, ini30, ontem);
    const diasB = Object.keys(dias).filter(d => d >= ini56 && d <= fim14b).length; // a base pode ter menos de 6 semanas (cliente novo)
    const b14 = diasB >= 14 ? { fat: b42.fat / diasB * 14, ped: b42.ped / diasB * 14 } : { fat: 0, ped: 0 }; // média de 14 dias das semanas antes
    const mtd = somar(dias, mesIni, ontem), mAnt = somar(dias, antIni, antAte);
    if (!a14.fat && !b14.fat) continue; // cliente sem dados na base
    const motivos = [];
    const add = (tipo, pts, texto, acao) => motivos.push({ tipo, pts, texto, acao });

    // loja parada
    if (u3.fat === 0 && b14.ped >= 10) add('parada', 40, `Sem venda nos últimos 3 dias (vendia ${R$(b14.fat / 14)}/dia)`, 'Ver hoje se a conta caiu, se os anúncios estão pausados ou sem estoque, e ligar para o cliente.');
    // queda de 14 dias (cliente pequeno oscila muito: só a partir de R$ 2 mil nos 14 dias anteriores)
    const q14 = b14.fat >= 2000 ? (a14.fat / b14.fat - 1) * 100 : null;
    if (q14 != null && q14 <= -15 && !motivos.some(m => m.tipo === 'parada')) add('queda', q14 <= -40 ? 40 : q14 <= -25 ? 25 : 12, `Vendas ${pct(q14)} nos últimos 14 dias (${R$(a14.fat)} contra ${R$(b14.fat)} na média das 6 semanas antes)`, 'Revisar com o cliente os produtos que mais caíram (abaixo): estoque, preço contra a concorrência e ADS — o Plano de ação traz o Raio-X.');
    // contra o mesmo período do mês passado (a partir do dia 7)
    const qm = dd >= 7 && mAnt.fat >= 2000 ? (mtd.fat / mAnt.fat - 1) * 100 : null;
    if (qm != null && qm <= -15) add('mes', qm <= -30 ? 15 : 8, `Mês ${pct(qm)} contra o mesmo período do mês passado (${R$(mtd.fat)} contra ${R$(mAnt.fat)})`, 'Mostrar ao cliente o comparativo e o que vai ser feito na semana para recuperar.');
    // meta
    const meta = parseFloat(metas[c.id]) || parseFloat(c.metaMensal) || null, metaPed = parseFloat(metasPed[c.id]) || null;
    const proj = dd ? mtd.fat / dd * diasMes : 0, projPed = dd ? mtd.ped / dd * diasMes : 0;
    const pMeta = dd >= 5 ? (meta ? proj / meta * 100 : metaPed ? projPed / metaPed * 100 : null) : null;
    if (pMeta != null && pMeta < 85) add('meta', pMeta < 70 ? 20 : 10, `Projeção do mês em ${Math.round(pMeta)}% da meta (${meta ? `${R$(proj)} de ${R$(meta)}` : `${Math.round(projPed)} de ${metaPed} pedidos`})`,
      meta && diasMes > dd ? `Alinhar a meta com o cliente: faltam ${R$(Math.max(0, meta - mtd.fat) / (diasMes - dd))}/dia até o fim do mês — combinar as ações que fecham essa diferença.` : 'Alinhar a meta com o cliente e combinar as ações que fecham a diferença.');
    // saldo de ADS da Shopee
    const lojasSemSaldo = contas.filter(ct => ct.mkt === 'shopee').map(ct => ({ ct, n: diasZerado.get(ct.id)?.size || 0, agora: saldo[ct.id]?.nivel === 'zerado' })).filter(x => x.n || x.agora);
    if (lojasSemSaldo.length) {
      const n = Math.max(...lojasSemSaldo.map(x => x.n));
      add('saldo', n >= 3 ? 15 : 5, `ADS da Shopee sem saldo em ${n || 1} dia(s) da última semana${lojasSemSaldo.some(x => x.agora) ? ' (zerado agora)' : ''}`, 'Cobrar a recarga hoje e combinar um valor mínimo de saldo para os anúncios não pararem.');
    }
    // conexões
    const ids = new Set(contas.flatMap(x => [x.id, x.ext]));
    const caidas = Object.values(conex).filter(x => ids.has(String(x.id)) && (x.status === 'erro' || x.status === 'ads'));
    if (caidas.length) {
      const erro = caidas.filter(x => x.status === 'erro'), diasC = Math.max(0, ...erro.map(x => x.desde ? (Date.now() - Date.parse(x.desde)) / 864e5 : 0));
      add('conexao', erro.length ? (diasC >= 2 ? 15 : 8) : 5, erro.length ? `${erro.map(x => `${NOME_MKT[x.mkt] || x.mkt} ${x.nome || x.id}`).slice(0, 2).join(', ')} desconectada${diasC >= 1 ? ` há ${Math.round(diasC)} dia(s)` : ''}` : `${caidas.length} conta(s) sem permissão de Ads`,
        'Reconectar com o cliente (Saúde das conexões) — conta desconectada não entra nas vendas nem nos agentes.');
    }
    // reputação
    const repRuim = contas.map(ct => ({ ct, r: repDe.get(`${ct.mkt}:${ct.id}`) })).filter(x => x.r?.risco === 'alto' || x.r?.risco === 'atencao');
    if (repRuim.length) {
      const alto = repRuim.filter(x => x.r.risco === 'alto'), pior = alto[0] || repRuim[0];
      add('reputacao', alto.length ? 10 : 2, `Reputação ${alto.length ? 'em risco' : 'pedindo atenção'} no ${NOME_MKT[pior.ct.mkt]}${pior.r.riscoMotivo ? ` — ${pior.r.riscoMotivo}` : ''}`, 'Resolver as reclamações e perguntas pendentes (Reputação e atendimento) e mostrar ao cliente o que foi feito.');
    }

    const score = Math.min(100, motivos.reduce((s, m) => s + m.pts, 0));
    const nivel = score >= ALTO ? 'alto' : score >= MEDIO ? 'medio' : 'ok';
    motivos.sort((a, b) => b.pts - a.pts);
    const ant = anterior[String(c.id)] || {};
    saida[String(c.id)] = {
      nome: c.nome || '', gestor: gestorDe(c), nivel, score, score_antes: ant.score ?? null, nivel_antes: ant.nivel || null,
      desde: nivel === 'alto' ? (ant.nivel === 'alto' && ant.desde ? ant.desde : new Date().toISOString()) : null,
      motivos, fat14: Math.round(a14.fat), fat14_antes: Math.round(b14.fat), var14: q14 == null ? null : Math.round(q14), fat30: Math.round(m30.fat), ped30: m30.ped,
      meta_pct: pMeta == null ? null : Math.round(pMeta), contas: contas.map(ct => ({ mkt: ct.mkt, id: ct.id })), produtos: [],
    };
  }
  // produtos em queda: só de quem está em risco (é o que o gestor vai abrir)
  for (const x of Object.values(saida)) if (x.nivel !== 'ok' && x.motivos.some(m => ['queda', 'mes', 'meta'].includes(m.tipo))) x.produtos = await produtosEmQueda(sbSelect, x.contas, ontem);

  const novosAltos = Object.entries(saida).filter(([cid, x]) => x.nivel === 'alto' && anterior[cid]?.nivel !== 'alto');
  const sairam = Object.entries(anterior).filter(([cid, x]) => x.nivel === 'alto' && saida[cid]?.nivel !== 'alto');
  const contar = n => Object.values(saida).filter(x => x.nivel === n).length;
  if (simular) return { simulacao: true, clientes: Object.keys(saida).length, alto: contar('alto'), medio: contar('medio'), entrariam: novosAltos.map(([, x]) => x.nome), sairiam: sairam.map(([, x]) => x.nome), clientes_detalhe: saida };

  const agora = new Date().toISOString();
  await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: 'retencao', recurso: 'todas', ultima_tentativa: agora, ultimo_sucesso: agora, cursor: { em: agora, clientes: saida } }, 'marketplace,conta_id,recurso');
  for (const [cid, x] of novosAltos) {
    await sbInsert('glr_agente_log', { conta_id: `cliente:${cid}`, cliente_nome: x.nome, tipo: 'alerta', titulo: `Cliente em risco de cancelar — ${x.nome}`,
      explicacao: `${x.motivos.map(m => m.texto).join('; ')}. Plano: ${x.motivos.map(m => m.acao).join(' ')}`,
      dados: { acao: 'retencao', chave: `ret:${cid}`, cliente_id: cid, nivel: x.nivel, score: x.score, gestor: x.gestor, motivos: x.motivos.map(m => m.texto) }, resultado: 'so_alerta', origem: 'cron' }).catch(() => {});
  }
  for (const [cid] of sairam) // saiu do risco alto: fecha o aviso pendente
    await sbUpdate('glr_agente_log', `conta_id=eq.${encodeURIComponent(`cliente:${cid}`)}&tipo=eq.alerta&resultado=eq.so_alerta&dados->>acao=eq.retencao`, { resultado: 'executado' }).catch(() => {});
  if (novosAltos.length) await require('./_alerta').avisar(sbSelect, novosAltos.length === 1 ? `🚨 Cliente em risco — ${novosAltos[0][1].nome}` : `🚨 ${novosAltos.length} clientes em risco de cancelar`,
    novosAltos.slice(0, 4).map(([, x]) => `${x.nome}${x.gestor ? ` (${x.gestor})` : ''}: ${x.motivos[0]?.texto || ''}`).join('\n'), 'retencao', '/#retencao').catch(() => {});
  return { clientes: Object.keys(saida).length, alto: contar('alto'), medio: contar('medio'), entraram: novosAltos.map(([, x]) => x.nome), sairam: sairam.map(([, x]) => x.nome) };
}

module.exports = { avaliarCarteira };
