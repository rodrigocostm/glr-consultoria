// ============================================================
// GLR Consultoria — Agente de Onboarding
// ------------------------------------------------------------
// Checklist de entrada de cada cliente, para ele gerar comissão já no 1º mês:
// sem conta conectada a venda não entra na base; sem modelo de comissão a GLR
// não cobra; sem custo os agentes de ADS e de promoção trabalham no escuro.
// Passos (essencial = sem ele não há venda/comissão):
//   essenciais: contas vinculadas · conexões funcionando · vendas chegando na
//               base · modelo de comissão
//   importantes: gestor · meta · custos (≥ 80% do faturamento) · agente de ADS
//               ligado com meta de ACOS · permissão de Ads
//   complementares: saldo de ADS da Shopee · portal do cliente · 1º Plano de ação
// "Em implantação" = começou há até 60 dias (1ª venda na base, ou a 1ª vez que o
// agente viu o cliente) ou ainda sem os essenciais. Cliente em implantação com
// essencial pendente há mais de 3 dias → Caixa de decisões (dados.acao
// 'onboarding'); fecha sozinho quando os essenciais ficam prontos.
// Estado: glr_sync_estado sistema / onboarding / todas. Tela: js/pages-onboarding.js.
// Só lê — não mexe em nada no cliente nem no marketplace.
// ============================================================

const MKT = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : m === 'amazon' ? 'amazon' : ['tiktok', 'tiktok_shop', 'tiktokshop'].includes(m) ? 'tiktok' : m === 'magalu' ? 'magalu' : m === 'shein' ? 'shein' : null; };
const NOME_MKT = { shopee: 'Shopee', ml: 'Mercado Livre', amazon: 'Amazon', tiktok: 'TikTok Shop', magalu: 'Magalu', shein: 'Shein' };
const contaDe = ct => String(ct.param_to_use?.shopId || ct.param_to_use?.meliUserId || ct.param_to_use?.amazon_account_id || ct.param_to_use?.magalu_account_id || ct.param_to_use?.shein_supplier_id || ct.external_id || '');
const isoBRT = (n = 0) => { const d = new Date(Date.now() - 3 * 3600e3); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const DIAS_IMPLANTACAO = 60, CUSTO_MIN = 80;

function temComissao(c) { // espelha GLR.comissao.temComissao (js/data.js)
  const m = c?.comissao || {};
  if (m.modelo === 'fixo') return (+m.fixo || 0) > 0 || (+m.excedente || 0) > 0;
  if (m.modelo === 'ticket') return (m.faixas || []).some(f => (+f.valor || 0) > 0);
  return (parseFloat(m.modelo === 'venda' && m.valor != null ? m.valor : c?.valorPorVenda) || 0) > 0;
}

async function avaliar({ sbSelect, sbUpsert, sbInsert, sbUpdate, lerStorage }, { simular = false } = {}) {
  const [clientes, vinc, metas, metasPed, portais, cfgs, bases, conex, saldo, sinais, planos, anterior] = await Promise.all([
    lerStorage('glr_clientes').then(x => x || []), lerStorage('glr_mc_vinculos').then(x => x || {}),
    lerStorage('glr_metas').then(x => x || {}), lerStorage('glr_metas_pedidos').then(x => x || {}), lerStorage('glr_portal_configs').then(x => Array.isArray(x) ? x : []),
    sbSelect('glr_agente_config', 'select=conta_id,marketplace,ativo,meta_acos').catch(() => []),
    sbSelect('glr_sync_estado', 'recurso=eq.resumo&select=marketplace,conta_id,dias:cursor->dias').then(rs => new Map(rs.map(r => [`${r.marketplace}:${r.conta_id}`, r.dias || {}]))).catch(() => new Map()),
    sbSelect('glr_sync_estado', 'marketplace=eq.sistema&conta_id=eq.conexoes&recurso=eq.todas&select=cursor').then(r => r[0]?.cursor?.contas || {}).catch(() => ({})),
    sbSelect('glr_sync_estado', 'marketplace=eq.sistema&conta_id=eq.saldo_ads&recurso=eq.shopee&select=cursor').then(r => r[0]?.cursor?.lojas || {}).catch(() => ({})),
    sbSelect('glr_sync_estado', 'recurso=eq.sinais&select=marketplace,conta_id,itens:cursor->itens').then(rs => new Map(rs.map(r => [`${r.marketplace}:${r.conta_id}`, r.itens || {}]))).catch(() => new Map()),
    sbSelect('glr_sync_estado', 'marketplace=eq.sistema&recurso=eq.plano&select=conta_id,ultimo_sucesso').then(rs => new Set(rs.map(r => String(r.conta_id)))).catch(() => new Set()),
    sbSelect('glr_sync_estado', 'marketplace=eq.sistema&conta_id=eq.onboarding&recurso=eq.todas&select=cursor').then(r => r[0]?.cursor || null).catch(() => null),
  ]);
  const primeiraVez = !anterior, ant = anterior?.clientes || {};
  const cfgDe = new Map(cfgs.map(c => [String(c.conta_id), c]));
  const hoje = isoBRT(0), recente = isoBRT(3);
  const saida = {};

  for (const c of clientes) {
    if (/inativ|cancel|encerr/i.test(String(c.status || ''))) continue;
    const cid = String(c.id);
    const contas = (vinc[cid] || []).map(ct => ({ mkt: MKT(ct.marketplace), id: contaDe(ct), ext: String(ct.external_id || '') })).filter(x => x.mkt && x.id);
    const ids = new Set(contas.flatMap(x => [x.id, x.ext]));
    const diasDe = ct => bases.get(`${ct.mkt}:${ct.id}`) || bases.get(`${ct.mkt}:${ct.ext}`) || null;
    const primeiraVenda = contas.map(diasDe).filter(Boolean).flatMap(d => Object.keys(d).filter(k => (parseFloat(d[k]?.faturamento) || 0) > 0)).sort()[0] || null;
    const passos = [];
    const add = (id, titulo, nivel, ok, detalhe, acao, tela) => passos.push({ id, titulo, nivel, ok: !!ok, detalhe, acao: ok ? '' : acao, tela });

    // essenciais
    add('contas', 'Contas dos marketplaces vinculadas', 'essencial', contas.length, contas.length ? `${contas.length} conta(s): ${[...new Set(contas.map(x => NOME_MKT[x.mkt]))].join(', ')}` : 'nenhuma conta vinculada',
      'Vincular as contas do cliente no cadastro (Carteira de Clientes → cliente → contas).', 'clientes');
    const caidas = Object.values(conex).filter(x => ids.has(String(x.id)) && x.status === 'erro');
    add('conexao', 'Conexões funcionando', 'essencial', contas.length && !caidas.length, caidas.length ? `${caidas.map(x => `${NOME_MKT[x.mkt] || x.mkt} ${x.nome || x.id}`).slice(0, 3).join(', ')} com erro` : contas.length ? 'todas respondendo' : 'sem contas',
      'Reconectar as contas com erro junto com o cliente (Saúde das conexões).', 'conexoes');
    const semBase = contas.filter(ct => { const d = diasDe(ct); return !d || !Object.keys(d).some(k => k >= recente); });
    add('vendas', 'Vendas chegando na base', 'essencial', contas.length && !semBase.length, semBase.length ? `${semBase.length} conta(s) sem venda na base nos últimos 3 dias (${semBase.slice(0, 2).map(x => NOME_MKT[x.mkt]).join(', ')})` : contas.length ? 'base atualizada' : 'sem contas',
      'Conferir em Integrações se a conta sincroniza (a base atualiza a cada 15 min); conta nova leva até 1 dia para trazer o histórico.', 'integracoes');
    add('comissao', 'Modelo de comissão', 'essencial', temComissao(c), temComissao(c) ? (c.comissao?.modelo ? `modelo ${c.comissao.modelo}` : `R$ ${String(c.valorPorVenda).replace('.', ',')} por venda`) : 'sem comissão definida',
      'Definir o modelo de comissão no perfil do cliente (por venda, fixo com franquia ou por faixa de ticket).', 'cliente-perfil');
    // importantes
    add('gestor', 'Gestor responsável', 'importante', c.gestorId || c.gestor, c.gestorId || c.gestor ? 'definido' : 'sem gestor', 'Atribuir um gestor no perfil do cliente.', 'cliente-perfil');
    const meta = parseFloat(metas[cid]) || parseFloat(c.metaMensal) || parseFloat(metasPed[cid]) || 0;
    add('meta', 'Meta mensal', 'importante', meta > 0, meta > 0 ? `meta definida` : 'sem meta', 'Combinar a meta do mês com o cliente e lançar na tela Gestores (os agentes aceleram ou seguram pela meta).', 'gestores');
    // custos: parte do faturamento de 30 dias (ML e Shopee, agente de Margem) com custo cadastrado
    let fat = 0, fatCusto = 0, n = 0, nCusto = 0;
    for (const ct of contas.filter(x => x.mkt === 'ml' || x.mkt === 'shopee')) for (const it of Object.values(sinais.get(`${ct.mkt}:${ct.id}`) || {})) {
      const r = (it.u30 || 0) * (it.p || 0); if (!r) continue;
      fat += r; n++; if (it.c > 0) { fatCusto += r; nCusto++; }
    }
    const pctCusto = fat > 0 ? Math.round(fatCusto / fat * 100) : null;
    add('custos', 'Custos dos produtos', 'importante', pctCusto != null && pctCusto >= CUSTO_MIN, pctCusto == null ? 'sem vendas de ML/Shopee lidas pelo agente de Margem' : `${pctCusto}% do faturamento com custo (${nCusto} de ${n} produtos que venderam)`,
      `Cadastrar o custo dos produtos que mais vendem na tela Produtos — sem custo, a margem, o limite de ACOS e as promoções ficam no escuro (meta: ${CUSTO_MIN}% do faturamento).`, 'produtos');
    const adsContas = contas.filter(x => x.mkt === 'shopee' || x.mkt === 'ml');
    const semAgente = adsContas.filter(ct => { const g = cfgDe.get(ct.id); return !g || !g.ativo || !(parseFloat(g.meta_acos) > 0); });
    add('agente', 'Agente de ADS ligado com meta de ACOS', 'importante', adsContas.length && !semAgente.length, !adsContas.length ? 'sem conta Shopee/ML' : semAgente.length ? `${semAgente.length} de ${adsContas.length} conta(s) sem o agente ou sem meta de ACOS` : 'todas as contas',
      'Ligar o agente de ADS em cada conta Shopee/ML e definir a meta de ACOS (telas ADS Shopee e ADS Mercado Livre).', semAgente.some(x => x.mkt === 'shopee') ? 'agente' : 'agente-ml');
    const semAds = Object.values(conex).filter(x => ids.has(String(x.id)) && x.status === 'ads');
    add('ads', 'Permissão de Ads nas contas', 'importante', !semAds.length, semAds.length ? `${semAds.length} conta(s) sem permissão de Ads` : 'ok', 'Pedir ao cliente para liberar a permissão de Ads na conexão (Saúde das conexões).', 'conexoes');
    // complementares
    const lojasShopee = contas.filter(x => x.mkt === 'shopee'), zeradas = lojasShopee.filter(x => saldo[x.id]?.nivel === 'zerado');
    add('saldo', 'Saldo de ADS da Shopee', 'complementar', !zeradas.length, !lojasShopee.length ? 'sem loja Shopee' : zeradas.length ? `${zeradas.length} loja(s) com saldo zerado` : 'com saldo', 'Combinar com o cliente a recarga e um saldo mínimo para os anúncios não pararem.', 'agente');
    const portal = portais.find(p => String(p.clienteId) === cid && p.ativo !== false);
    add('portal', 'Portal do cliente', 'complementar', portal, portal ? 'acesso criado' : 'sem acesso', 'Criar o acesso do cliente ao portal (Portal Clientes) — ele acompanha vendas, estoque e notas sozinho.', 'portal-admin');
    add('plano', '1º Plano de ação', 'complementar', planos.has(`cliente:${cid}`), planos.has(`cliente:${cid}`) ? 'gerado' : 'ainda não gerado', 'Gerar o Plano de ação do cliente (o Gerente monta o Raio-X e as primeiras ações).', 'plano-acao');

    const ess = passos.filter(p => p.nivel === 'essencial'), essOk = ess.every(p => p.ok);
    const peso = { essencial: 3, importante: 2, complementar: 1 }, tot = passos.reduce((s, p) => s + peso[p.nivel], 0), feito = passos.reduce((s, p) => s + (p.ok ? peso[p.nivel] : 0), 0);
    const a = ant[cid] || {};
    // 1ª vez que o agente vê o cliente: na 1ª rodada vale a 1ª venda (cliente antigo não vira "novo")
    const primeiroVisto = a.primeiro_visto || (primeiraVez ? (primeiraVenda || hoje) : hoje);
    const inicio = [primeiraVenda, primeiroVisto].filter(Boolean).sort()[0];
    const dias = Math.floor((Date.parse(`${hoje}T12:00:00Z`) - Date.parse(`${inicio}T12:00:00Z`)) / 864e5);
    saida[cid] = {
      nome: c.nome || '', gestor_id: c.gestorId || null, inicio, primeiro_visto: primeiroVisto, dias, implantacao: dias <= DIAS_IMPLANTACAO || !essOk,
      essenciais_ok: essOk, essenciais_desde: essOk ? (a.essenciais_desde || new Date().toISOString()) : null,
      pct: Math.round(feito / tot * 100), pendentes: passos.filter(p => !p.ok).length, passos, custo_pct: pctCusto,
    };
  }

  // Caixa de decisões: em implantação, essencial pendente e cliente visto há mais de 3 dias
  const alertar = Object.entries(saida).filter(([, x]) => x.implantacao && !x.essenciais_ok && Math.floor((Date.parse(`${hoje}T12:00:00Z`) - Date.parse(`${x.primeiro_visto}T12:00:00Z`)) / 864e5) >= 3);
  const prontos = Object.entries(saida).filter(([cid, x]) => x.essenciais_ok && ant[cid] && !ant[cid].essenciais_ok);
  if (simular) return { simulacao: true, clientes: Object.keys(saida).length, implantacao: Object.values(saida).filter(x => x.implantacao).length, alertaria: alertar.map(([, x]) => x.nome), detalhe: saida };

  const agora = new Date().toISOString();
  await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: 'onboarding', recurso: 'todas', ultima_tentativa: agora, ultimo_sucesso: agora, cursor: { em: agora, clientes: saida } }, 'marketplace,conta_id,recurso');
  const pend = new Set((await sbSelect('glr_agente_log', 'tipo=eq.alerta&resultado=eq.so_alerta&dados->>acao=eq.onboarding&select=dados&limit=500').catch(() => [])).map(l => String(l.dados?.cliente_id)));
  for (const [cid, x] of alertar) {
    if (pend.has(cid)) continue;
    const faltam = x.passos.filter(p => p.nivel === 'essencial' && !p.ok);
    await sbInsert('glr_agente_log', { conta_id: `cliente:${cid}`, cliente_nome: x.nome, tipo: 'alerta', titulo: `Implantação travada — ${x.nome}`,
      explicacao: `Faltam ${faltam.length} passo(s) essencial(is) para o cliente gerar venda e comissão: ${faltam.map(p => `${p.titulo.toLowerCase()} (${p.detalhe})`).join('; ')}. ${faltam.map(p => p.acao).join(' ')}`,
      dados: { acao: 'onboarding', chave: `onb:${cid}`, cliente_id: cid, faltam: faltam.map(p => p.titulo), pct: x.pct }, resultado: 'so_alerta', origem: 'cron' }).catch(() => {});
  }
  for (const [cid] of prontos) // essenciais prontos: fecha o aviso
    await sbUpdate('glr_agente_log', `conta_id=eq.${encodeURIComponent(`cliente:${cid}`)}&tipo=eq.alerta&resultado=eq.so_alerta&dados->>acao=eq.onboarding`, { resultado: 'executado' }).catch(() => {});
  return { clientes: Object.keys(saida).length, implantacao: Object.values(saida).filter(x => x.implantacao).length, travados: alertar.length, prontos: prontos.length };
}

module.exports = { avaliar, temComissao };
