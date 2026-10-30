// ============================================================
// GLR Consultoria — Agente do Mercado Livre (modo COPILOTO)
// ------------------------------------------------------------
// Separado do agente da Shopee (pedido do analista). O ML não libera escrita
// em Product Ads para integrações (testado em 14/10/2026: 401 "User does not
// have permission to write"), então este agente só ANALISA e SUGERE — cada
// sugestão vira um card na aba "Agente Mercado Livre" e o analista aplica no
// painel do ML e marca "Já apliquei". Dados: API do Tiops + base sincronizada.
//
// Como o analista otimiza ADS no ML (e o agente segue):
//  • Campanha = vários produtos. Otimiza-se a campanha (ROAS objetivo e
//    orçamento) E os produtos dentro dela (tirar, colocar, trocar de campanha).
//  • Produto é analisado por FAMÍLIA (variações de cor/tamanho do mesmo
//    produto somadas — family_id do ML), numa janela maior (≥14 dias), porque
//    produto isolado tem pouca venda por semana.
//  • Ordem de decisão: primeiro os produtos (tirar o que gasta sem retorno,
//    mandar o que puxa o ACOS pra uma campanha mais conservadora), depois a
//    campanha com o que sobra — assim não se aperta a campanha inteira por
//    causa de 1 produto ruim.
//  • TACOS do MÊS (faturamento sem cancelados) decide se há folga pra acelerar;
//    ACOS sempre SEM cancelados; pausar campanha é último recurso.
//  • Produto que vende bem na loja (base) e não está em nenhuma campanha ativa
//    → sugerir colocar numa campanha que está dentro da meta e tem verba.
//
// Arquivo com "_" na frente: não vira rota na Vercel; usado por agente-cron.js.
// ============================================================

const MAX_SUGESTOES = 15;
const curvaABC = require('./_curva-abc');
const medicaoAds = require('./_medicao-ads');
const estoqueMargem = require('./_estoque-margem');
const especialista = require('./_especialista-ml');

async function listarCampanhasML(mcpCall, apiKey, meliUserId, de, ate) {
  const todas = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const r = await mcpCall(apiKey, 'ml_ads_campaigns', { meliUserId, date_from: de, date_to: ate, limit: 50, offset, status: 'ALL' });
    const d = r.data || r;
    const res = d.results || [];
    todas.push(...res);
    const total = parseInt(d.paging?.total) || 0;
    if (res.length < 50 || (total && offset + 50 >= total)) break;
  }
  return todas;
}

async function listarAnunciosML(mcpCall, apiKey, meliUserId, campaignId, de, ate) {
  const todos = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const r = await mcpCall(apiKey, 'ml_ads_items', { meliUserId, campaign_id: String(campaignId), date_from: de, date_to: ate, limit: 100, offset });
    const d = r.data || r;
    const res = d.results || [];
    todos.push(...res);
    const total = parseInt(d.paging?.total) || 0;
    if (res.length < 100 || (total && offset + 100 >= total)) break;
  }
  return normalizarAnuncios(todos, campaignId);
}

// O ML continua listando na campanha antiga o anúncio que foi movido — às vezes
// duas vezes: um "deleted" da campanha antiga e um "idle" já com o campaign_id
// novo, os dois com o mesmo gasto. Fica 1 registro por anúncio (o da própria
// campanha quando existir, gasto contado uma vez) e quem foi para outra campanha
// vem com status 'moved' e movido_para.
function normalizarAnuncios(lista, campaignId) {
  const cid = String(campaignId), por = new Map();
  const daqui = a => a.campaign_id == null || String(a.campaign_id) === cid;
  const peso = a => (daqui(a) ? 2 : 0) + (a.status === 'active' ? 1 : 0);
  for (const a of lista) {
    const k = String(a.item_id), o = por.get(k);
    por.set(k, { a: !o || peso(a) > peso(o.a) ? a : o.a, fora: daqui(a) ? o?.fora : String(a.campaign_id) });
  }
  return [...por.values()].map(({ a, fora }) => a.status === 'active' && daqui(a) ? a : fora ? { ...a, status: 'moved', movido_para: fora } : a);
}

// Soma os anúncios por família (variações do mesmo produto)
function agruparFamilias(anuncios, taxaCancel) {
  const fam = new Map();
  for (const a of anuncios) {
    const k = String(a.family_id || a.item_id);
    const f = fam.get(k) || { chave: k, nome: a.family_name || a.title || a.item_id, itens: [], ativos: [], gasto: 0, vendas: 0, unidades: 0, cliques: 0, impressoes: 0, precoSoma: 0, recomendado: false, semBuybox: false, parados: 0, organico: 0 };
    const m = a.metrics || {};
    f.itens.push(a.item_id);
    if (a.status === 'active') f.ativos.push(a.item_id);
    f.gasto += parseFloat(m.cost) || 0;
    f.vendas += parseFloat(m.total_amount) || 0;
    f.unidades += parseInt(m.units_quantity) || 0;
    f.cliques += parseInt(m.clicks) || 0;
    f.impressoes += parseInt(m.prints) || 0;
    f.precoSoma += parseFloat(a.price) || 0;
    f.recomendado = f.recomendado || !!a.recommended;
    if (a.status === 'active' && a.catalog_listing && a.buy_box_winner === false) f.semBuybox = true; // catálogo sem buy box: perde exposição
    if (a.status === 'idle') f.parados++;
    f.organico += parseInt(m.organic_units_quantity) || 0;
    fam.set(k, f);
  }
  for (const f of fam.values()) {
    f.preco = f.itens.length ? f.precoSoma / f.itens.length : 0;
    f.vendasAj = f.vendas * (1 - taxaCancel);
    f.acos = f.vendasAj > 0 ? f.gasto / f.vendasAj * 100 : (f.gasto > 0 ? Infinity : null);
  }
  return [...fam.values()];
}

// Vendas por anúncio na loja inteira (base, pedidos válidos) — orgânico + ADS
async function vendasPorItem(sbSelect, contaId, desdeIso) {
  const mapa = new Map();
  for (let off = 0; off < 20000; off += 1000) {
    const rows = await sbSelect('glr_pedidos', `marketplace=eq.ml&conta_id=eq.${encodeURIComponent(contaId)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(desdeIso)}&select=itens&limit=1000&offset=${off}`).catch(() => []);
    for (const p of rows) for (const i of (p.itens || [])) {
      if (!i.item_id) continue;
      const v = mapa.get(i.item_id) || { item_id: i.item_id, nome: i.nome || i.item_id, unidades: 0, receita: 0 };
      const q = parseInt(i.qtd) || 1;
      v.unidades += q; v.receita += (parseFloat(i.preco) || 0) * q;
      mapa.set(i.item_id, v);
    }
    if (rows.length < 1000) break;
  }
  return mapa;
}

// Revisão de 3 dias: venda de cada anúncio nos últimos 3 dias (b) × os 3 anteriores (a)
async function vendas3x3(sbSelect, contaId, ontem, isoMenos) {
  const d3 = isoMenos(ontem, 2), d6 = isoMenos(ontem, 5), mapa = new Map();
  for (let off = 0; off < 20000; off += 1000) {
    const rows = await sbSelect('glr_pedidos', `marketplace=eq.ml&conta_id=eq.${encodeURIComponent(contaId)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(new Date(`${d6}T03:00:00Z`).toISOString())}&select=criado_em,itens&limit=1000&offset=${off}`).catch(() => []);
    for (const p of rows) {
      const dia = new Date(Date.parse(p.criado_em) - 3 * 3600e3).toISOString().slice(0, 10);
      if (dia > ontem) continue;
      for (const i of (p.itens || [])) {
        if (!i.item_id) continue;
        const v = mapa.get(String(i.item_id)) || { a: 0, b: 0 };
        v[dia >= d3 ? 'b' : 'a'] += (parseFloat(i.preco) || 0) * (parseInt(i.qtd) || 1);
        mapa.set(String(i.item_id), v);
      }
    }
    if (rows.length < 1000) break;
  }
  return mapa;
}

async function processarContaML(cfg, mcApiKey, h, opc = {}) {
  const { sbSelect, sbInsert, sbUpdate, sbUpsert, lerBase, baseCobre, baseCobreAds, somarBase, isoMenos, dataBRT, R$, mcpCall } = h;
  const contaId = String(cfg.conta_id);
  const sugestoes = [];
  async function logar(tipo, titulo, explicacao, dados, resultado) {
    try {
      await sbInsert('glr_agente_log', { conta_id: contaId, cliente_nome: cfg.cliente_nome || null, tipo, titulo, explicacao, dados: { marketplace: 'ml', ...(dados || {}) }, resultado: resultado || 'executado', origem: 'cron' });
    } catch (e) {}
  }
  const instrucao = ' Aplique no painel do Mercado Livre (Publicidade → Product Ads) e marque "Já apliquei" aqui — o ML não libera essa alteração por integração.';
  const r1 = v => Math.round(v * 10) / 10;
  const pctTxt = v => v == null ? '—' : v === Infinity ? '∞' : `${r1(v)}%`;
  const roasTxt = v => v ? `${r1(v)}x` : '—';

  try {
    const ontem = dataBRT(1).iso;
    const dias = Math.max(3, cfg.regra_pausa_dias || 7);
    const inicio = isoMenos(ontem, dias - 1);
    const diasProd = Math.max(14, dias);
    const inicioProd = isoMenos(ontem, diasProd - 1);
    const meta = cfg.meta_acos || null;
    const roasMeta = meta ? 100 / meta : null; // ROAS equivalente à meta de ACOS

    // Base sincronizada (ML): taxa de cancelamento, ticket médio e TACOS do mês
    const base = await lerBase('ml', contaId);
    let taxaCancel = 0, ticketRef = null, tacosMes = null;
    if (baseCobre(base, inicioProd)) {
      const t = somarBase(base, inicioProd, ontem);
      const b = t.faturamento + t.valor_cancelado + t.valor_devolvido;
      taxaCancel = b > 0 ? Math.min(0.6, (t.valor_cancelado + t.valor_devolvido) / b) : 0;
    }
    const de30 = isoMenos(ontem, 29);
    if (baseCobre(base, de30)) { const t30 = somarBase(base, de30, ontem); if (t30.pedidos > 0) ticketRef = t30.faturamento / t30.pedidos; }
    const mesIni = ontem.slice(0, 8) + '01';
    if (baseCobre(base, mesIni) && baseCobreAds(base, mesIni)) { const sm = somarBase(base, mesIni, ontem); if (sm.faturamento > 0) tacosMes = sm.ads / sm.faturamento * 100; }
    // teto de ADS do cliente (Plano de ação) manda; sem ele, a meta da conta com 10% de folga
    const tacosOk = tacosMes == null || (cfg.teto_tacos ? tacosMes <= cfg.teto_tacos : (!meta || tacosMes <= meta * 1.1));
    // Mural dos agentes de Estoque e de Margem (calculado pelo sincronizador)
    const sinais = h.lerSinais ? await h.lerSinais('ml', contaId).catch(() => null) : null;
    const avisoDe = ids => sinais ? estoqueMargem.avisosDe(sinais, ids) : null;
    const seguraEstoque = a => a && (a.ne === 'zerado' || a.ne === 'critico' || (a.dias != null && a.dias <= 10));
    const estoqueTxt = a => a.ne === 'zerado' ? 'está sem estoque' : `acaba em ~${Math.round(a.dias)} dia(s)`;
    const colaboracoes = [];
    // Agente de Reputação: conta em risco / produto com reclamações repetidas não acelera
    const repConta = sinais?.reputacao?.risco === 'alto' ? `a reputação da conta está em risco (${sinais.reputacao.motivo})` : null;
    const repTxt = a => repConta || (a?.rp ? `${String(a.nome).slice(0, 40)} tem ${a.rp}` : null);
    // Agente de Qualidade: anúncio que não converte não recebe mais verba — conserta o anúncio antes
    const qaTxt = a => a?.qa ? `o anúncio precisa de conserto antes (${a.qa})` : null;
    const limitePausa = Math.round(Math.max(50, ticketRef && meta ? ticketRef * (meta / 100) * 3 : 0) * 100) / 100;

    // Sugestões dos últimos 45 dias: pendentes (conferir se já foram aplicadas),
    // aplicadas (medir o resultado) e as recentes (não repetir)
    const logs = await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(contaId)}&tipo=eq.alerta&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 45 * 86400000).toISOString())}&select=id,titulo,resultado,criado_em,dados&order=criado_em.desc&limit=800`).catch(() => []);
    const ocupadas = new Set();
    const livre = chave => !ocupadas.has(chave) && sugestoes.length < MAX_SUGESTOES;
    // Prioridade: primeiro estancar gasto (economia/semana), depois ganhar venda
    // (vendas/semana em jogo valem ~10% — margem aproximada do que voltaria)
    // Nas regras de produto e de campanha (1 e 2), sugerir só PROPÕE (candidatos); o especialista
    // escolhe o pacote do dia e só as escolhidas vão para a Caixa de decisões.
    const candidatos = [];
    let coletando = false;
    async function sugerir(chave, titulo, explicacao, dados) {
      if (dados && dados.impacto != null) {
        dados.impacto = Math.max(0, Math.round(dados.impacto));
        dados.prioridade = Math.round(dados.impacto * (dados.impacto_tipo === 'economia' ? 1 : 0.1));
      }
      if (coletando) {
        if ((ocupadas.has(chave) && !opc.simular) || candidatos.some(c => c.chave === chave)) return false; // simulação: considera também o que já está pendente
        candidatos.push({ id: chave, chave, titulo, explicacao, dados });
        return true;
      }
      if (!livre(chave)) return false;
      ocupadas.add(chave);
      await logar('alerta', titulo, explicacao + instrucao, { chave, ...dados }, 'so_alerta');
      sugestoes.push(titulo);
      return true;
    }

    // Campanhas (janela da campanha) + anúncios de cada campanha ativa (janela de produto)
    const hojeMom = dataBRT(0).iso;
    const estMom = (await sbSelect('glr_sync_estado', `marketplace=eq.sistema&conta_id=eq.${encodeURIComponent(`momento:${contaId}`)}&recurso=eq.momento&select=cursor`).catch(() => []))[0]?.cursor;
    const momentoHoje = !!opc.soMomento || !estMom?.dia || (Date.parse(`${hojeMom}T12:00:00Z`) - Date.parse(`${estMom.dia}T12:00:00Z`)) / 864e5 >= 3;
    const mom = { aceleradas: [], recuperadas: [], seguradas: [], motivos: {} };
    async function registrarMomento() {
      const lista = (t, xs) => xs.length ? `${t}: ${xs.slice(0, 6).join(', ')}${xs.length > 6 ? ` e mais ${xs.length - 6}` : ''}.` : '';
      await logar('sistema', `Revisão de 3 dias — ${mom.aceleradas.length + mom.recuperadas.length} sugestão(ões) de acelerar`,
        `Comparei a venda dos anúncios de cada campanha nos últimos 3 dias com os 3 anteriores. ${[lista('Subindo, sugeri acelerar', mom.aceleradas), lista('Caindo, sugeri reforçar a exposição', mom.recuperadas), lista('Subindo mas segurada por limite', mom.seguradas), mom.seguradas.length ? `Por que seguradas: ${Object.entries(mom.motivos).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${n} por ${m}`).join(', ')}.` : ''].filter(Boolean).join(' ') || 'Nenhuma campanha com variação relevante (±20% e R$ 100).'} Próxima revisão em 3 dias.`,
        { momento: true, aceleradas: mom.aceleradas.length, recuperadas: mom.recuperadas.length, seguradas: mom.seguradas.length, motivos: mom.motivos }, 'executado');
      if (sbUpsert) await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: `momento:${contaId}`, recurso: 'momento', ultima_tentativa: new Date().toISOString(), ultimo_sucesso: new Date().toISOString(), cursor: { dia: hojeMom, aceleradas: mom.aceleradas.length, recuperadas: mom.recuperadas.length } }, 'marketplace,conta_id,recurso').catch(() => {});
    
    }
    const [campanhas, vendasLoja, v3] = await Promise.all([
      listarCampanhasML(mcpCall, mcApiKey, contaId, inicio, ontem),
      vendasPorItem(sbSelect, contaId, new Date(`${de30}T00:00:00-03:00`).toISOString()),
      momentoHoje ? vendas3x3(sbSelect, contaId, ontem, isoMenos) : Promise.resolve(new Map()),
    ]);
    const ativas = campanhas.filter(c => String(c.status || '').toLowerCase() === 'active');
    const anunciosPor = await Promise.all(ativas.map(c => listarAnunciosML(mcpCall, mcApiKey, contaId, c.id, inicioProd, ontem).catch(() => [])));

    const agora = Date.now();
    const C = ativas.map((c, i) => {
      const m = c.metrics || {};
      const gasto = parseFloat(m.cost) || 0, vendas = parseFloat(m.total_amount) || 0;
      const vendasAj = vendas * (1 - taxaCancel);
      const budget = parseFloat(c.budget) || 0;
      const roasAlvo = parseFloat(c.roas_target) || (parseFloat(c.acos_target) ? 100 / parseFloat(c.acos_target) : 0);
      return {
        c, id: Number(c.id), nome: String(c.name || `Campanha ${c.id}`).trim().slice(0, 70),
        gasto, vendas, vendasAj, unidades: parseInt(m.units_quantity) || 0,
        acos: vendasAj > 0 ? gasto / vendasAj * 100 : (gasto > 0 ? Infinity : null),
        budget, gastoDia: gasto / dias, roasAlvo,
        rentab: String(c.strategy || '').toUpperCase() === 'PROFITABILITY',
        madura: (c.date_created ? (agora - new Date(c.date_created).getTime()) / 86400000 : Infinity) >= (cfg.dias_maturacao_campanha ?? 7),
        familias: agruparFamilias(anunciosPor[i] || [], taxaCancel),
        anuncios: anunciosPor[i] || [],
      };
    });
    const anunciados = new Set(C.flatMap(x => x.anuncios.filter(a => a.status === 'active').map(a => a.item_id)));
    // Diagnóstico de escala do Mercado Ads (detalhe de cada campanha): quanto das impressões possíveis
    // ganha e por que perde o resto — orçamento × classificação — mais o ACOS de referência da categoria.
    // Aprendizado: o Mercado Ads recomenda 30 dias sem mexer; mudança recente espera o efeito (atribuição de 14 dias).
    const DIAS_APRENDIZADO = 30, DIAS_DESDE_MUDANCA = 10;
    const comGasto = C.filter(x => x.gasto > 0).slice(0, 30);
    for (let i = 0; i < comGasto.length; i += 5) {
      await Promise.all(comGasto.slice(i, i + 5).map(async x => {
        try {
          const r = await mcpCall(mcApiKey, 'raw', { method: 'GET', meliUserId: contaId, path: `/advertising/MLB/product_ads/campaigns/${x.id}?date_from=${inicio}&date_to=${ontem}&metrics=impression_share,top_impression_share,lost_impression_share_by_budget,lost_impression_share_by_ad_rank,acos_benchmark` });
          const m = (r.data || r)?.metrics || {};
          if (m.impression_share != null) x.share = { ganha: +m.impression_share || 0, topo: +m.top_impression_share || 0, orcamento: +m.lost_impression_share_by_budget || 0, classificacao: +m.lost_impression_share_by_ad_rank || 0, benchmark: m.acos_benchmark != null ? +m.acos_benchmark : null };
        } catch (e) { /* sem o detalhe, a campanha segue só pelas regras de ACOS */ }
      }));
    }
    // "última alteração" do ML muda sozinha todo dia (rotinas do próprio ML) — a mudança que conta é a
    // que o analista aplicou a partir de uma recomendação (marcada ou detectada pela leitura das campanhas)
    const ultimaMudanca = new Map();
    for (const l of logs) {
      const d = l.dados || {};
      if (l.resultado !== 'executado' || d.campaign_id == null || !['roas_target', 'orcamento', 'pausar', 'acos_target'].includes(d.acao)) continue;
      const t = Date.parse(d.aplicado_em || l.criado_em), k = String(d.campaign_id);
      if (t && (!ultimaMudanca.has(k) || t > ultimaMudanca.get(k))) ultimaMudanca.set(k, t);
    }
    for (const x of C) {
      x.idadeDias = x.c.date_created ? (agora - new Date(x.c.date_created).getTime()) / 864e5 : Infinity;
      x.mudouHa = ultimaMudanca.has(String(x.id)) ? (agora - ultimaMudanca.get(String(x.id))) / 864e5 : Infinity;
      x.aprendendo = x.idadeDias < DIAS_APRENDIZADO;
      x.recente = x.mudouHa < DIAS_DESDE_MUDANCA;
    }
    const pc = v => `${Math.round((v || 0) * 100)}%`;

    // ── 0) ACOMPANHAMENTO — o ML não deixa a integração aplicar, mas deixa LER:
    //  • confere sozinho o que o analista já aplicou no painel (sem precisar marcar "Feito");
    //  • sugestão pendente há mais de 7 dias vence (números velhos) e é refeita se ainda valer;
    //  • 7 dias depois de aplicada, compara a campanha 7 dias antes × 7 dias depois.
    const hojeIso = dataBRT(0).iso;
    const diaBRT = iso => new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
    const campPorId = new Map(campanhas.map(c => [String(c.id), c]));
    const xPorId = new Map(C.map(x => [String(x.id), x]));
    const roasDe = c => parseFloat(c?.roas_target) || (parseFloat(c?.acos_target) ? 100 / parseFloat(c.acos_target) : 0);
    const ativa = c => String(c?.status || '').toLowerCase() === 'active';
    // anúncios ativos de uma campanha (null = não consegui ler → não conclui nada)
    const ativosEm = id => { const x = xPorId.get(String(id)); return x && x.anuncios.length ? new Set(x.anuncios.filter(a => a.status === 'active').map(a => String(a.item_id))) : null; };
    const anunciadosStr = new Set([...anunciados].map(String));
    // valor andou pelo menos metade do caminho sugerido (ou chegou no sugerido)
    const andou = (atual, de, para) => atual > 0 && de > 0 && para > 0 && (Math.abs(atual - para) <= Math.max(0.15, para * 0.03) || ((atual - de) * (para - de) > 0 && Math.abs(atual - de) >= Math.abs(para - de) * 0.5));
    function conferir(d) {
      const camp = campPorId.get(String(d.campaign_id));
      const ids = (d.item_ids || []).map(String);
      switch (d.acao) {
        case 'pausar': return camp && !ativa(camp) ? 'campanha pausada' : null;
        case 'roas_target': return camp && andou(roasDe(camp), +d.de, +d.para) ? `ROAS objetivo agora ${r1(roasDe(camp))}x` : null;
        case 'orcamento': return camp && andou(parseFloat(camp.budget) || 0, +d.de, +d.para) ? `orçamento agora ${R$(camp.budget)}/dia` : null;
        case 'retirar_produto': {
          if (!ids.length || !camp) return null;
          if (!ativa(camp)) return 'campanha pausada';
          const at = ativosEm(d.campaign_id);
          return at && ids.every(i => !at.has(i)) ? 'anúncio fora da campanha' : null;
        }
        case 'mover_produto': {
          if (!ids.length || !camp) return null;
          const at = ativa(camp) ? ativosEm(d.campaign_id) : new Set();
          if (!at || ids.some(i => at.has(i))) return null;
          const dest = d.destino_id ? ativosEm(d.destino_id) : anunciadosStr;
          return dest && ids.some(i => dest.has(i)) ? (d.destino_id ? 'anúncio na campanha de destino' : 'anúncio em outra campanha') : null;
        }
        case 'adicionar_produto': return ids.length && ids.some(i => anunciadosStr.has(i)) ? 'anúncio em campanha ativa' : null;
      }
      return null;
    }
    let detectadas = 0, expiradas = 0, medidas = 0;
    for (const l of logs) {
      if (l.resultado !== 'so_alerta' || !l.id) continue;
      const d = l.dados || {};
      const obs = d.acao && d.acao !== 'abc_queda' ? conferir(d) : null;
      try {
        if (obs) {
          // aplicado entre a sugestão e esta leitura — a análise roda 1x por dia, então "ontem"
          const dados = { ...d, aplicado_em: new Date().toISOString(), aplicado_dia: diaBRT(l.criado_em) < ontem ? ontem : hojeIso, aplicado_por: 'detectado', deteccao: obs };
          await sbUpdate('glr_agente_log', `id=eq.${l.id}`, { resultado: 'executado', dados });
          l.resultado = 'executado'; l.dados = dados; detectadas++;
        } else if (Date.now() - new Date(l.criado_em).getTime() > 7 * 86400000) {
          const dados = { ...d, expirado_em: new Date().toISOString() };
          await sbUpdate('glr_agente_log', `id=eq.${l.id}`, { resultado: 'expirado', dados });
          l.resultado = 'expirado'; l.dados = dados; expiradas++;
        }
      } catch (e) { /* segue: tenta de novo na próxima análise */ }
    }

    // Medição: campanha 7 dias antes × 7 dias depois do dia aplicado
    const CONTER = d => ['pausar', 'retirar_produto', 'mover_produto'].includes(d.acao) || (d.acao === 'roas_target' && +d.para > +d.de) || (d.acao === 'orcamento' && +d.para < +d.de);
    const aMedir = logs.filter(l => {
      const d = l.dados || {};
      if (l.resultado !== 'executado' || d.medicao || !d.acao || d.acao === 'abc_queda') return false;
      const ap = d.aplicado_dia || (d.aplicado_em ? diaBRT(d.aplicado_em) : null);
      return ap && isoMenos(ap, -7) <= ontem;
    });
    const porDia = new Map();
    for (const l of aMedir) { const d = l.dados; const ap = d.aplicado_dia || diaBRT(d.aplicado_em); (porDia.get(ap) || porDia.set(ap, []).get(ap)).push(l); }
    for (const ap of [...porDia.keys()].sort().slice(0, 4)) {
      try {
        const [antes, depois] = await Promise.all([
          listarCampanhasML(mcpCall, mcApiKey, contaId, isoMenos(ap, 7), isoMenos(ap, 1)),
          listarCampanhasML(mcpCall, mcApiKey, contaId, isoMenos(ap, -1), isoMenos(ap, -7)),
        ]);
        const met = (lista, id) => {
          const c = lista.find(x => String(x.id) === String(id)); if (!c) return null;
          const m = c.metrics || {};
          return medicaoAds.metricas(parseFloat(m.cost) || 0, (parseFloat(m.total_amount) || 0) * (1 - taxaCancel));
        };
        for (const l of porDia.get(ap)) {
          const d = l.dados;
          const alvo = d.acao === 'adicionar_produto' ? (d.destino_id || d.campaign_id) : d.campaign_id;
          const a = met(antes, alvo), b = met(depois, alvo);
          const { veredito, resumo } = medicaoAds.avaliar(d.acao === 'pausar' ? 'pausar' : CONTER(d) ? 'conter' : 'acelerar', a, b, meta, R$);
          const dados = { ...d, medicao: { campaign_id: alvo, aplicado_dia: ap, antes: a, depois: b, veredito, resumo, medido_em: new Date().toISOString() } };
          try { await sbUpdate('glr_agente_log', `id=eq.${l.id}`, { dados }); l.dados = dados; medidas++; } catch (e) {}
        }
      } catch (e) { /* medição é bônus — tenta de novo amanhã */ }
    }

    // O que está pendente / foi aplicado nos últimos 3 dias não é sugerido de novo
    const desde3d = new Date(Date.now() - 3 * 86400000).toISOString();
    logs.filter(l => l.resultado === 'so_alerta' || (l.resultado === 'executado' && (l.dados?.aplicado_em || l.criado_em) >= desde3d))
      .forEach(l => { const k = l.dados?.chave || (l.dados?.campaign_id != null ? `c:${l.dados.campaign_id}` : null); if (k) ocupadas.add(k); });
    // Avisos da curva ABC: um por produto a cada 7 dias (mesmo se descartado)
    const desde7d = new Date(Date.now() - 6.5 * 86400000).toISOString();
    logs.filter(l => String(l.dados?.chave || '').startsWith('abc:') && l.criado_em >= desde7d).forEach(l => ocupadas.add(l.dados.chave));

    const naLoja = item => vendasLoja.get(item) || null;
    const lojaFam = f => f.itens.reduce((s, it) => { const v = naLoja(it); return v ? { un: s.un + v.unidades, rec: s.rec + v.receita } : s; }, { un: 0, rec: 0 });
    const comFolga = x => x.budget > 0 && x.gastoDia < x.budget * 0.7;
    const dentroMeta = x => meta && x.acos != null && x.acos !== Infinity && x.acos <= meta;

    const excluido = new Map(); // campanha → gasto/vendas de produtos já tratados
    const tiradas = new Set(); // famílias já sugeridas para sair da campanha
    const tirar = (x, f) => { tiradas.add(f.chave); const e = excluido.get(x.id) || { gasto: 0, vendasAj: 0 }; e.gasto += f.gasto; e.vendasAj += f.vendasAj; excluido.set(x.id, e); };

    coletando = !opc.soMomento;
    // ── 1) PRODUTOS dentro das campanhas ── (fora da rodada só da revisão de 3 dias)
    for (const x of (opc.soMomento ? [] : C)) {
      if (!x.madura) continue;
      for (const f of [...x.familias].sort((a, b) => b.gasto - a.gasto)) {
        if (!f.ativos.length || f.gasto <= 0) continue;
        const chave = `p:${f.chave}`;
        const aviso = avisoDe(f.itens);
        const metaMargem = aviso?.aa != null && meta && aviso.aa < meta ? Math.max(0.5, aviso.aa) : null;
        const metaFam = metaMargem ?? meta;
        // 1-0) Sem estoque e ainda gastando → tirar da campanha até repor
        if (aviso?.ne === 'zerado') {
          const ok = await sugerir(chave, `Sugestão: tirar produto sem estoque da campanha — ${f.nome.slice(0, 50)}`,
            `O agente de Estoque avisou que "${f.nome.slice(0, 70)}" está sem estoque, mas o anúncio segue na campanha "${x.nome}" e gastou ${R$(f.gasto)} em ${diasProd} dias. Tirar da campanha até repor — clique pago em anúncio sem estoque não vira venda.`,
            { campaign_id: x.id, campanha: x.nome, familia: f.chave, produto: f.nome.slice(0, 90), item_ids: f.ativos, gasto: r1(f.gasto), unidades: f.unidades, janela_dias: diasProd, acao: 'retirar_produto', impacto: f.gasto / diasProd * 7, impacto_tipo: 'economia', colaboracao: { de: 'estoque' } });
          if (ok) { tirar(x, f); colaboracoes.push({ de: 'estoque', texto: `sugeri tirar "${f.nome.slice(0, 50)}" de "${x.nome}": está sem estoque` }); }
          continue;
        }
        const custoVenda = f.preco * ((metaFam || 10) / 100); // ADS aceitável por venda deste produto (limitado pela margem)
        const limProd = Math.max(15, custoVenda * 2);
        // 1-cat) Catálogo sem buy box: o clique pago leva para a oferta de outro vendedor
        if (f.semBuybox && f.gasto >= limProd * 0.5 && f.unidades === 0) {
          const ok = await sugerir(chave, `Sugestão: pausar anúncio de catálogo sem buy box — ${f.nome.slice(0, 50)}`,
            `"${f.nome.slice(0, 70)}" é anúncio de catálogo e não está ganhando o buy box; gastou ${R$(f.gasto)} em ${diasProd} dias na campanha "${x.nome}" sem venda pelo ADS. Pausar este anúncio até ganhar o buy box (preço, frete, reputação) — sem buy box o clique leva para a oferta de outro vendedor.`,
            { campaign_id: x.id, campanha: x.nome, familia: f.chave, produto: f.nome.slice(0, 90), item_ids: f.ativos, gasto: r1(f.gasto), unidades: f.unidades, janela_dias: diasProd, acao: 'retirar_produto', impacto: f.gasto / diasProd * 7, impacto_tipo: 'economia' });
          if (ok) tirar(x, f);
          continue;
        }
        const loja = lojaFam(f);
        const lojaTxt = loja.un > 0 ? ` Na loja inteira (orgânico + ADS) vendeu ${loja.un} un. nos últimos 30 dias.` : ' Também não vendeu na loja nos últimos 30 dias.';
        const base0 = { campaign_id: x.id, campanha: x.nome, familia: f.chave, produto: f.nome.slice(0, 90), item_ids: f.ativos, gasto: r1(f.gasto), vendas_sem_cancelados: r1(f.vendasAj), unidades: f.unidades, acos: f.acos === Infinity ? null : f.acos && r1(f.acos), janela_dias: diasProd };

        // 1a) Tirar da campanha — gasta sem retorno
        if (f.gasto >= limProd && (f.unidades === 0 || f.vendasAj < f.gasto)) {
          const ok = await sugerir(chave, `Sugestão: tirar produto da campanha — ${f.nome.slice(0, 60)}`,
            `Na campanha "${x.nome}", ${f.itens.length > 1 ? `as ${f.ativos.length} variações ativas deste produto gastaram` : 'este anúncio gastou'} ${R$(f.gasto)} em ${diasProd} dias com ${f.unidades === 0 ? 'nenhuma venda pelo ADS' : `só ${R$(f.vendasAj)} em vendas sem cancelados`} — mais que ${R$(limProd)} (ADS de ~2 vendas no preço de ${R$(f.preco)}).${lojaTxt}${loja.un >= 5 ? ' Vende sem o ADS — o anúncio pago não está somando.' : ''} Tirar da campanha (pausar o anúncio) para o orçamento ir para quem vende.`,
            { ...base0, acao: 'retirar_produto', impacto: f.gasto / diasProd * 7, impacto_tipo: 'economia' });
          if (ok) tirar(x, f);
          continue;
        }
        if (!meta || f.acos == null || f.acos === Infinity) continue;
        const roasMetaFam = 100 / metaFam;

        // 1b) Produto que puxa o ACOS da campanha → campanha mais conservadora
        const pesado = f.gasto >= Math.max(limProd, x.gasto * 0.3);
        const limiteMover = metaMargem != null ? Math.max(metaFam * 1.2, 1) : Math.max(meta * 1.5, cfg.regra_pausa_acos || 0);
        if (pesado && f.acos > limiteMover && f.unidades > 0) {
          if (metaMargem != null && f.acos <= Math.max(meta * 1.5, cfg.regra_pausa_acos || 0)) colaboracoes.push({ de: aviso.promo ? 'promocoes' : 'margem', texto: `"${f.nome.slice(0, 50)}" tem ACOS de ${pctTxt(f.acos)}: cabe na meta da conta, mas passa do que a margem aguenta (${metaFam}%)` });
          // destino precisa ser pelo menos 20% mais conservador — 12,5x → 12,9x não muda o lance;
          // sem campanha assim, a sugestão é criar uma nova só para o produto
          const destino = C.filter(o => o.id !== x.id && o.roasAlvo >= x.roasAlvo * 1.2 && o.rentab).sort((a, b) => a.roasAlvo - b.roasAlvo)[0];
          const roasNova = r1(Math.max(roasMetaFam, x.roasAlvo * 1.25)); // campanha nova: sempre mais conservadora que a atual (e dentro da margem)
          const ok = await sugerir(chave, `Sugestão: mover produto para campanha mais conservadora — ${f.nome.slice(0, 50)}`,
            `"${f.nome.slice(0, 70)}" vende, mas com ACOS de ${pctTxt(f.acos)} (sem cancelados) em ${diasProd} dias — bem acima da ${metaMargem != null ? `meta do produto (${metaFam}%, limite da margem de ${aviso.m}%${aviso.promo ? ' no preço da promoção — agente de Promoções' : ' calculada pelo agente de Margem'})` : `meta (${meta}%)`} — e responde por ${Math.round(f.gasto / (x.gasto || f.gasto) * 100)}% do gasto da campanha "${x.nome}" (ROAS objetivo ${roasTxt(x.roasAlvo)}). Em vez de apertar a campanha inteira, ${destino ? `mover este produto para "${destino.nome}" (ROAS objetivo ${roasTxt(destino.roasAlvo)}, lance mais conservador)` : `criar uma campanha só para ele com ROAS objetivo de ${roasTxt(roasNova)} (lance mais conservador)`}. Não pausar: o produto vende.`,
            { ...base0, acao: 'mover_produto', destino_id: destino?.id || null, destino: destino?.nome || null, de: x.roasAlvo, para: destino ? destino.roasAlvo : roasNova, impacto: Math.max(0, f.gasto - f.vendasAj * meta / 100) / diasProd * 7, impacto_tipo: 'economia' });
          if (ok) tirar(x, f);
          continue;
        }

        // 1c) Produto campeão travado por verba → campanha com folga
        const travada = x.budget > 0 && x.gastoDia >= x.budget * 0.85;
        const semComoSubir = cfg.orcamento_max && x.budget >= cfg.orcamento_max;
        if (tacosOk && travada && semComoSubir && f.unidades >= 3 && f.acos <= metaFam * 0.6) {
          if (seguraEstoque(aviso)) { colaboracoes.push({ de: 'estoque', texto: `não sugeri dar mais verba a "${f.nome.slice(0, 50)}": ${estoqueTxt(aviso)}` }); continue; }
          if (repTxt(aviso)) { colaboracoes.push({ de: 'reputacao', texto: `não sugeri dar mais verba a "${f.nome.slice(0, 50)}": ${repTxt(aviso)}` }); continue; }
          if (qaTxt(aviso)) { colaboracoes.push({ de: 'qualidade', texto: `não sugeri dar mais verba a "${f.nome.slice(0, 50)}": ${qaTxt(aviso)}` }); continue; }
          const destino = C.filter(o => o.id !== x.id && comFolga(o) && (dentroMeta(o) || !o.gasto) && o.roasAlvo <= x.roasAlvo).sort((a, b) => (b.budget - b.gastoDia) - (a.budget - a.gastoDia))[0];
          if (destino) {
            const ok = await sugerir(chave, `Sugestão: mover produto campeão para campanha com verba — ${f.nome.slice(0, 50)}`,
              `"${f.nome.slice(0, 70)}" vendeu ${f.unidades} un. pelo ADS com ACOS de ${pctTxt(f.acos)} em ${diasProd} dias, mas "${x.nome}" já gasta todo o orçamento (${R$(x.gastoDia)}/dia de ${R$(x.budget)}, no teto configurado). Mover para "${destino.nome}", que usa só ${R$(destino.gastoDia)}/dia de ${R$(destino.budget)}.`,
              { ...base0, acao: 'mover_produto', destino_id: destino.id, destino: destino.nome, de: x.roasAlvo, para: destino.roasAlvo, impacto: f.vendasAj / diasProd * 7, impacto_tipo: 'ganho' });
            if (ok) tirar(x, f);
          }
        }
      }
    }

    // ── 2) CAMPANHAS (descontando os produtos já tratados acima) ──
    for (const x of C) {
      if (x.gasto <= 0) continue;
      const chave = `c:${x.id}`;
      const ex = excluido.get(x.id) || { gasto: 0, vendasAj: 0 };
      const gasto = Math.max(0, x.gasto - ex.gasto * (dias / diasProd));
      const vendasAj = Math.max(0, x.vendasAj - ex.vendasAj * (dias / diasProd));
      const acos = vendasAj > 0 ? gasto / vendasAj * 100 : (gasto > 0 ? Infinity : null);
      const acosTxt = `${pctTxt(acos)}${taxaCancel > 0.005 && x.vendas > 0 ? ` (sem cancelados; ${r1(x.gasto / x.vendas * 100)}% no ML)` : ''}${ex.gasto > 0 ? ', sem contar os produtos já sugeridos acima' : ''}`;
      const base0 = { campaign_id: x.id, campanha: x.nome, gasto: r1(x.gasto), vendas: r1(x.vendas), vendas_sem_cancelados: r1(x.vendasAj), acos: acos === Infinity ? null : acos && r1(acos), roas_objetivo: x.roasAlvo ? r1(x.roasAlvo) : null, estrategia: x.c.strategy || null };

      // 2a) Pausar campanha — último recurso: gasto alto sem retorno
      if (!opc.soMomento && x.madura && gasto >= limitePausa && (x.unidades === 0 || vendasAj < gasto) && !ex.gasto) {
        await sugerir(chave, `Sugestão: pausar campanha — ${x.nome}`,
          x.unidades === 0
            ? `Gastou ${R$(x.gasto)} nos últimos ${dias} dias sem nenhuma venda atribuída — acima do limite de ${R$(limitePausa)} (ADS de ~3 vendas no ticket médio${ticketRef ? ` de ${R$(ticketRef)}` : ''}). Gasta muito sem retorno.`
            : `Gastou ${R$(x.gasto)} e vendeu só ${R$(x.vendasAj)} sem cancelados nos últimos ${dias} dias — gasta mais do que vende, acima do limite de ${R$(limitePausa)}.`,
          { ...base0, acao: 'pausar', impacto: x.gasto / dias * 7, impacto_tipo: 'economia' });
        continue;
      }
      if (!meta || acos == null || acos === Infinity) continue;

      // 2b) Conter — ACOS acima da meta com venda: subir ROAS objetivo (ou cortar orçamento)
      if (!opc.soMomento && x.madura && acos > meta) {
        const forte = !!cfg.regra_pausa_acos && acos > cfg.regra_pausa_acos;
        // campanha aprendendo ou mexida há pouco espera (Mercado Ads: 30 dias; efeito de uma mudança leva 1–2 semanas)
        if (!forte && (x.aprendendo || x.recente)) { colaboracoes.push({ de: 'faturamento', texto: `não sugeri apertar "${x.nome}" (ACOS ${acosTxt}): ${x.aprendendo ? `campanha com ${Math.floor(x.idadeDias)} dia(s) — o Mercado Ads recomenda 30 dias de aprendizado sem mexer` : `alterada há ${Math.floor(x.mudouHa)} dia(s) — esperar o efeito da mudança`}` }); continue; }
        // quem governa é o TACOS: dentro do limite, ACOS um pouco acima da meta não pede aperto
        if (!forte && tacosMes != null && tacosOk && acos <= meta * 1.3) { colaboracoes.push({ de: 'faturamento', texto: `não sugeri apertar "${x.nome}" (ACOS ${acosTxt}): o TACOS do mês (${r1(tacosMes)}%) está dentro ${cfg.teto_tacos ? `do teto de ADS do cliente (${cfg.teto_tacos}%)` : `do limite (meta ${meta}% com 10% de folga)`}` }); continue; }
        const passo = forte ? 0.25 : 0.15;
        if (x.rentab && x.roasAlvo > 0) {
          const novo = r1(x.roasAlvo / (1 - passo));
          await sugerir(chave, `Sugestão: subir ROAS objetivo — ${x.nome}`,
            `ACOS de ${acosTxt} nos últimos ${dias} dias, acima da meta (${meta}%, equivale a ROAS ${roasTxt(roasMeta)})${forte ? ` e da contenção forte (${cfg.regra_pausa_acos}%)` : ''}, mas a campanha vende — conter em vez de pausar. Subir o ROAS objetivo de ${roasTxt(x.roasAlvo)} para ${roasTxt(novo)} (lance mais conservador).`,
            { ...base0, acao: 'roas_target', de: r1(x.roasAlvo), para: novo, impacto: Math.max(0, gasto - vendasAj * meta / 100) / dias * 7, impacto_tipo: 'economia' });
        } else if (x.budget > (cfg.orcamento_min || 0)) {
          const novo = Math.max(cfg.orcamento_min || 0, Math.round(x.budget * (1 - passo) * 100) / 100);
          if (novo < x.budget) await sugerir(chave, `Sugestão: reduzir orçamento — ${x.nome}`,
            `ACOS de ${acosTxt} nos últimos ${dias} dias, acima da meta (${meta}%), mas a campanha vende — conter em vez de pausar. Reduzir o orçamento diário de ${R$(x.budget)} para ${R$(novo)}.`,
            { ...base0, acao: 'orcamento', de: x.budget, para: novo, impacto: Math.max(0, gasto - vendasAj * meta / 100) / dias * 7, impacto_tipo: 'economia' });
        }
        continue;
      }

      // 2c) Acelerar — ACOS bem abaixo da meta e TACOS do mês com folga
      //     (não acelera campanha cujo produto principal está acabando — agente de Estoque)
      const principal = x.familias.filter(f => !tiradas.has(f.chave)).sort((a, b) => b.vendasAj - a.vendasAj)[0];
      const avisoCamp = principal ? avisoDe(principal.itens) : null;
      const podeMexer = !x.aprendendo && !x.recente;
      if (!podeMexer && !opc.soMomento && acos <= meta) colaboracoes.push({ de: 'faturamento', texto: `não sugeri mexer em "${x.nome}": ${x.aprendendo ? `campanha com ${Math.floor(x.idadeDias)} dia(s), em aprendizado (Mercado Ads: 30 dias)` : `alterada há ${Math.floor(x.mudouHa)} dia(s) — esperar o efeito`}` });

      // 2d) Escala (Mercado Ads): perde impressão por ORÇAMENTO → subir orçamento; por CLASSIFICAÇÃO →
      //     baixar o ROAS objetivo se a margem deixa, senão melhorar o anúncio (lance não resolve)
      const limiteCamp = avisoCamp?.aa != null && avisoCamp.aa < meta ? Math.max(0.5, avisoCamp.aa) : meta;
      const roasPiso = 100 / limiteCamp;
      if (x.share && podeMexer && !opc.soMomento) {
        const sh = x.share;
        const shTxt = `ganha ${pc(sh.ganha)} das impressões possíveis e perde ${pc(sh.orcamento)} por orçamento e ${pc(sh.classificacao)} por classificação${sh.benchmark ? ` (ACOS de referência da categoria no ML: ${r1(sh.benchmark)}%)` : ''}`;
        const bloqEsc = seguraEstoque(avisoCamp) ? `o principal produto ${estoqueTxt(avisoCamp)}` : repTxt(avisoCamp) || qaTxt(avisoCamp) || (!tacosOk ? `o TACOS do mês (${r1(tacosMes)}%) está acima do limite` : null);
        const baseEsc = { ...base0, share: sh, limite_acos: r1(limiteCamp) };
        let feitoEsc = false;
        if (acos <= limiteCamp && !bloqEsc) {
          if (sh.orcamento >= 0.15 && x.budget > 0 && (!cfg.orcamento_max || x.budget < cfg.orcamento_max)) {
            const novo = Math.round(Math.min(cfg.orcamento_max || Infinity, x.budget * 1.25) * 100) / 100;
            feitoEsc = await sugerir(chave, `Sugestão: aumentar orçamento — ${x.nome} (perde impressões por orçamento)`,
              `A campanha ${shTxt}, com ACOS de ${acosTxt} dentro do limite (${r1(limiteCamp)}%). O Mercado Ads recomenda não deixar o orçamento limitar a campanha: aumentar o orçamento diário de ${R$(x.budget)} para ${R$(novo)}.`,
              { ...baseEsc, acao: 'orcamento', de: x.budget, para: novo, impacto: vendasAj / dias * 7 * Math.min(1, sh.orcamento / Math.max(0.05, sh.ganha)), impacto_tipo: 'ganho' });
          } else if (sh.classificacao >= 0.5 && sh.ganha < 0.4 && x.roasAlvo > roasPiso * 1.05) {
            const novo = r1(Math.max(roasPiso, x.roasAlvo * 0.85));
            if (novo < x.roasAlvo) feitoEsc = await sugerir(chave, `Sugestão: baixar ROAS objetivo — ${x.nome} (perde impressões por classificação)`,
              `A campanha ${shTxt}, com ACOS de ${acosTxt} abaixo do limite (${r1(limiteCamp)}%): o ROAS objetivo de ${roasTxt(x.roasAlvo)} deixa o lance fraco no leilão. Baixar para ${roasTxt(novo)} (sem passar de ${roasTxt(roasPiso)}, o ROAS que o limite de ACOS aguenta).`,
              { ...baseEsc, acao: 'roas_target', de: r1(x.roasAlvo), para: novo, impacto: vendasAj / dias * 7 * 0.3, impacto_tipo: 'ganho' });
          }
        }
        if (!feitoEsc && sh.classificacao >= 0.6 && acos > limiteCamp * 0.9) {
          const fracos = x.familias.filter(f => f.ativos.length && (f.semBuybox || f.parados)).slice(0, 3).map(f => `"${f.nome.slice(0, 40)}"${f.semBuybox ? ' (catálogo sem buy box)' : ' (anúncio sem impressão)'}`);
          await sugerir(`q:${x.id}`, `Melhorar os anúncios — ${x.nome} (perde ${pc(sh.classificacao)} das impressões por classificação)`,
            `A campanha ${shTxt}, e o ACOS (${acosTxt}) já está perto do limite que a margem aguenta (${r1(limiteCamp)}%): baixar o ROAS não cabe. O Mercado Ads indica melhorar o anúncio — fotos, título, ficha técnica, envio/frete e, no catálogo, ganhar o buy box.${fracos.length ? ` Comece por ${fracos.join(', ')}.` : ''}`,
            { ...baseEsc, acao: 'informativa', impacto: vendasAj / dias * 7 * 0.2, impacto_tipo: 'ganho' });
        }
        if (feitoEsc) continue;
      }

      // Revisão de 3 dias: venda dos anúncios da campanha (orgânico + ADS) nos últimos 3 dias × 3 anteriores.
      // Subindo (ou caindo) com ACOS dentro da meta e TACOS com folga → sugere acelerar dentro dos limites.
      if (momentoHoje && x.madura && podeMexer) {
        let a3 = 0, b3 = 0;
        for (const an of x.anuncios) if (an.status === 'active') { const v = v3.get(String(an.item_id)); if (v) { a3 += v.a; b3 += v.b; } }
        const subindo = a3 + b3 >= 200 && b3 >= a3 * 1.2 && b3 - a3 >= 100, caindo = a3 + b3 >= 200 && b3 <= a3 * 0.8 && a3 - b3 >= 100;
        const bloq = seguraEstoque(avisoCamp) ? `o principal produto ${estoqueTxt(avisoCamp)}` : repTxt(avisoCamp) || qaTxt(avisoCamp) || (!tacosOk ? `o TACOS do mês (${r1(tacosMes)}%) está acima ${cfg.teto_tacos ? `do teto de ADS do cliente (${cfg.teto_tacos}%)` : `da meta (${meta}%)`}` : null);
        if ((subindo || caindo) && acos <= meta && !bloq) {
          const moTxt = `a venda dos anúncios da campanha (orgânico + ADS) foi de ${R$(a3)} nos 3 dias anteriores para ${R$(b3)} nos últimos 3 (${b3 >= a3 ? '+' : '−'}${Math.abs(a3 > 0 ? (b3 / a3 - 1) * 100 : 100).toFixed(0)}%)`;
          const porque = subindo ? `${moTxt}, com ACOS de ${acosTxt} dentro da meta (${meta}%) e TACOS com folga — acelerar para vender mais` : `${moTxt}, com ACOS de ${acosTxt} dentro da meta (${meta}%) — reforçar a exposição antes que a queda continue`;
          let ok = false;
          if (x.budget > 0 && x.gastoDia >= x.budget * 0.8 && (!cfg.orcamento_max || x.budget < cfg.orcamento_max)) {
            const novo = Math.round(Math.min(cfg.orcamento_max || Infinity, x.budget * 1.15) * 100) / 100;
            ok = await sugerir(chave, `Sugestão: aumentar orçamento — ${x.nome} (revisão de 3 dias)`, `Revisão de 3 dias: ${porque}. O orçamento está quase todo consumido (média de ${R$(x.gastoDia)}/dia de ${R$(x.budget)}): aumentar para ${R$(novo)}.`,
              { ...base0, acao: 'orcamento', de: x.budget, para: novo, momento: { a: Math.round(a3), b: Math.round(b3) }, impacto: Math.max(0, b3 - a3) / 3 * 7, impacto_tipo: 'ganho' });
          } else if (x.rentab && x.roasAlvo > roasMeta * 1.02) {
            const novo = r1(Math.max(roasMeta, x.roasAlvo * 0.9));
            if (novo < x.roasAlvo) ok = await sugerir(chave, `Sugestão: baixar ROAS objetivo — ${x.nome} (revisão de 3 dias)`, `Revisão de 3 dias: ${porque}. Baixar o ROAS objetivo de ${roasTxt(x.roasAlvo)} para ${roasTxt(novo)} (sem passar do ROAS ${roasTxt(roasMeta)} da meta).`,
              { ...base0, acao: 'roas_target', de: r1(x.roasAlvo), para: novo, momento: { a: Math.round(a3), b: Math.round(b3) }, impacto: Math.max(0, b3 - a3) / 3 * 7, impacto_tipo: 'ganho' });
          }
          if (ok) { (subindo ? mom.aceleradas : mom.recuperadas).push(x.nome); continue; }
        } else if (subindo) {
          mom.seguradas.push(x.nome);
          const mot = !bloq ? 'ACOS acima da meta' : seguraEstoque(avisoCamp) ? 'estoque' : repTxt(avisoCamp) ? 'reputação' : qaTxt(avisoCamp) ? 'anúncio a consertar' : 'TACOS acima do limite';
          mom.motivos[mot] = (mom.motivos[mot] || 0) + 1;
          colaboracoes.push({ de: 'faturamento', texto: `revisão de 3 dias: "${x.nome}" está subindo, mas não sugeri acelerar — ${bloq || `ACOS de ${acosTxt} acima da meta (${meta}%)`}` });
        }
      }
      if (opc.soMomento || !podeMexer) continue; // rodada só da revisão de 3 dias / campanha que precisa esperar
      if (acos <= meta * 0.7 && tacosOk && seguraEstoque(avisoCamp)) {
        colaboracoes.push({ de: 'estoque', texto: `segurei a aceleração de "${x.nome}": o principal produto dela, "${String(principal.nome).slice(0, 40)}", ${estoqueTxt(avisoCamp)}` });
      } else if (acos <= meta * 0.7 && tacosOk && repTxt(avisoCamp)) {
        colaboracoes.push({ de: 'reputacao', texto: `segurei a aceleração de "${x.nome}": ${repTxt(avisoCamp)}` });
      } else if (acos <= meta * 0.7 && tacosOk && qaTxt(avisoCamp)) {
        colaboracoes.push({ de: 'qualidade', texto: `segurei a aceleração de "${x.nome}": ${qaTxt(avisoCamp)}` });
      } else if (acos <= meta * 0.7 && tacosOk) {
        if (x.budget > 0 && x.gastoDia >= x.budget * 0.8 && (!cfg.orcamento_max || x.budget < cfg.orcamento_max)) {
          const novo = Math.round(Math.min(cfg.orcamento_max || Infinity, x.budget * 1.2) * 100) / 100;
          await sugerir(chave, `Sugestão: aumentar orçamento — ${x.nome}`,
            `ACOS de ${acosTxt}, bem abaixo da meta (${meta}%)${tacosMes != null ? `, TACOS do mês em ${r1(tacosMes)}%` : ''}, e o orçamento está quase todo consumido (média de ${R$(x.gastoDia)}/dia de ${R$(x.budget)}). Aumentar o orçamento diário para ${R$(novo)}.`,
            { ...base0, acao: 'orcamento', de: x.budget, para: novo, impacto: vendasAj / dias * 7, impacto_tipo: 'ganho' });
        } else if (x.rentab && x.roasAlvo > roasMeta * 1.02) {
          const novo = r1(Math.max(roasMeta, x.roasAlvo / 1.15));
          if (novo < x.roasAlvo) await sugerir(chave, `Sugestão: baixar ROAS objetivo — ${x.nome}`,
            `ACOS de ${acosTxt}, bem abaixo da meta (${meta}%)${tacosMes != null ? ` e TACOS do mês em ${r1(tacosMes)}%` : ''}. Baixar o ROAS objetivo de ${roasTxt(x.roasAlvo)} para ${roasTxt(novo)} para o ML disputar mais leilões e trazer volume (sem passar do ROAS ${roasTxt(roasMeta)} da meta).`,
            { ...base0, acao: 'roas_target', de: r1(x.roasAlvo), para: novo, impacto: vendasAj / dias * 7, impacto_tipo: 'ganho' });
        }
      }
    }

    if (opc.soMomento) {
      await registrarMomento();
      return { conta_id: contaId, marketplace: 'ml', momento: { aceleradas: mom.aceleradas.length, recuperadas: mom.recuperadas.length, seguradas: mom.seguradas.length } };
    }

    // ── Especialista em Mercado Ads: revisa as candidatas das regras e monta o pacote do dia ──
    coletando = false;
    if (opc.simular && !candidatos.length) return { conta_id: contaId, marketplace: 'ml', simulacao: true, candidatos: [], revisao: null, colaboracoes: colaboracoes.map(c => c.texto) };
    let revisao = null;
    if (candidatos.length) {
      const conta = {
        cliente: cfg.cliente_nome || null, hoje: hojeIso, janela_campanhas_dias: dias, janela_produtos_dias: diasProd,
        meta_acos_conta: meta, teto_tacos_cliente: cfg.teto_tacos || null, tacos_mes: tacosMes == null ? null : r1(tacosMes), taxa_cancelamento_pct: r1(taxaCancel * 100),
        campanhas: C.map(x => ({ id: x.id, nome: x.nome, estrategia: x.c.strategy || null, roas_objetivo: x.roasAlvo ? r1(x.roasAlvo) : null, orcamento_dia: x.budget, gasto_janela: r1(x.gasto), acos_sem_cancelados: x.acos == null || x.acos === Infinity ? null : r1(x.acos), unidades_ads: x.unidades,
          idade_dias: Number.isFinite(x.idadeDias) ? Math.floor(x.idadeDias) : null, alterada_ha_dias: Number.isFinite(x.mudouHa) ? Math.floor(x.mudouHa) : null, em_aprendizado: x.aprendendo, alterada_recente: x.recente,
          impressoes: x.share ? { ganha_pct: Math.round(x.share.ganha * 100), topo_pct: Math.round(x.share.topo * 100), perdida_orcamento_pct: Math.round(x.share.orcamento * 100), perdida_classificacao_pct: Math.round(x.share.classificacao * 100), acos_referencia_categoria: x.share.benchmark } : null })),
      };
      revisao = await especialista.revisar({ Anthropic: h.Anthropic, anthropicKey: h.anthropicKey, conta, candidatos });
      // simulação (?simular=1): mostra o pacote que o especialista montaria, sem criar nada na Caixa
      if (opc.simular) return { conta_id: contaId, marketplace: 'ml', simulacao: true, candidatos: candidatos.map(c => ({ id: c.id, titulo: c.titulo, explicacao: String(c.explicacao).slice(0, 400) })), revisao };
      const porId = new Map(candidatos.map(c => [c.id, c])), usadas = new Set();
      for (const e of revisao.escolhidas) {
        const c = porId.get(e.id); if (!c) continue;
        if (await sugerir(c.chave, c.titulo, `${c.explicacao}${e.porque ? ` Leitura do especialista: ${e.porque}` : ''}`, { ...c.dados, especialista: { prioridade: e.prioridade, fonte: revisao.fonte } })) usadas.add(c.dados?.campanha);
      }
      // a revisão de 3 dias só conta o que entrou no pacote
      mom.aceleradas = mom.aceleradas.filter(n => usadas.has(n)); mom.recuperadas = mom.recuperadas.filter(n => usadas.has(n));
      const descartadas = candidatos.filter(c => !revisao.escolhidas.some(e => e.id === c.id));
      await logar('sistema', `Especialista Mercado Ads — pacote do dia com ${revisao.escolhidas.length} de ${candidatos.length} recomendação(ões)`,
        [revisao.estrategia, ...revisao.esperar.map(x => `Esperar: ${x}`), descartadas.length ? `Ficaram de fora hoje: ${descartadas.slice(0, 6).map(c => c.titulo.replace(/^Sugestão:\s*/, '')).join('; ')}${descartadas.length > 6 ? ` e mais ${descartadas.length - 6}` : ''}.` : ''].filter(Boolean).join('\n') || 'Pacote montado pela ordem das regras (especialista indisponível).',
        { especialista: true, fonte: revisao.fonte, erro: revisao.erro || null, estrategia: revisao.estrategia, esperar: revisao.esperar, escolhidas: revisao.escolhidas, descartadas: descartadas.map(c => ({ id: c.id, titulo: c.titulo })).slice(0, 30) }, 'executado');
    }

    // ── 3) CURVA ABC semana a semana (mesma regra da aba Vendas) ──
    //  • curva A em queda/parou → alerta com a situação no ADS (o analista decide junto);
    //  • B/C subindo fora de campanha → colocar numa campanha dentro da meta;
    //    dentro de campanha travada por verba → reforço já sai pela regra da campanha.
    try {
      if (baseCobre(base, isoMenos(ontem, curvaABC.NSEM * 7 - 1))) {
        const curva = curvaABC.curvaSemanal(await curvaABC.lerPedidosCurva(sbSelect, 'ml', contaId, ontem), ontem);
        const campDoItem = {};
        for (const x of C) for (const a of x.anuncios) if (a.status === 'active') campDoItem[a.item_id] = x;
        const linhaSemana = p => `${p.ult} un. na última semana contra média de ${curvaABC.n1(p.media)} nas 3 anteriores (${curvaABC.varTxt(p.var)}; ${R$(p.ultRs)} vs ${R$(p.mediaRs)})`;
        const base1 = p => ({ produto: p.nome, item_ids: p.item_id ? [p.item_id] : [], classe: p.classe, tendencia: p.tend, unidades_ultima: p.ult, media_3_semanas: r1(p.media), variacao_pct: p.var == null ? null : Math.round(p.var) });
        for (const p of curva.aCaindo.slice(0, 4)) {
          const camp = campDoItem[p.item_id];
          const ads = camp ? `Está na campanha "${camp.nome}" (ROAS objetivo ${roasTxt(camp.roasAlvo)}, ACOS da campanha ${pctTxt(camp.acos)}).` : 'Não está em nenhuma campanha ativa de Product Ads.';
          await sugerir(`abc:${p.chave}`, `Curva A ${p.tend === 'parou' ? 'parou de vender' : 'em queda'} — ${p.nome.slice(0, 60)}`,
            `Produto curva A (${curvaABC.n1(p.part)}% do faturamento das últimas 4 semanas): ${linhaSemana(p)}. ${ads} Vale revisar juntos: estoque, preço/concorrência, anúncio e ADS${camp ? '' : ' — se o resto estiver ok, colocar numa campanha ajuda a recuperar'}.`,
            { ...base1(p), acao: 'abc_queda', ...(camp ? { campaign_id: camp.id, campanha: camp.nome } : {}), impacto: Math.max(0, (p.mediaRs || 0) - (p.ultRs || 0)), impacto_tipo: 'risco' });
        }
        if (tacosOk && meta) {
          const destino = C.filter(o => comFolga(o) && dentroMeta(o)).sort((a, b) => a.acos - b.acos)[0] || C.filter(o => dentroMeta(o)).sort((a, b) => a.acos - b.acos)[0];
          for (const p of curva.sobeBC.slice(0, 4)) {
            if (campDoItem[p.item_id] || !destino || !p.item_id) continue;
            const av = avisoDe([p.item_id]);
            if (seguraEstoque(av) || av?.nm === 'negativa') { colaboracoes.push({ de: av?.nm === 'negativa' ? 'margem' : 'estoque', texto: `não sugeri colocar "${String(p.nome).slice(0, 50)}" no ADS: ${av?.nm === 'negativa' ? `margem negativa (${av.m}%)` : estoqueTxt(av)}` }); continue; }
            if (repTxt(av) || qaTxt(av)) { colaboracoes.push({ de: repTxt(av) ? 'reputacao' : 'qualidade', texto: `não sugeri colocar "${String(p.nome).slice(0, 50)}" no ADS: ${repTxt(av) || qaTxt(av)}` }); continue; }
            const ok = await sugerir(`p:${p.item_id}`, `Curva ${p.classe} subindo — colocar em campanha: ${p.nome.slice(0, 50)}`,
              `Produto curva ${p.classe} em ${curvaABC.TEND_TXT[p.tend]}: ${linhaSemana(p)} — candidato a virar curva A e está fora de campanha. Colocar na campanha "${destino.nome}" (ACOS de ${pctTxt(destino.acos)}, dentro da meta${comFolga(destino) ? `, usando ${R$(destino.gastoDia)}/dia de ${R$(destino.budget)}` : ''}) para aproveitar a alta. Confira o estoque antes.`,
              { ...base1(p), acao: 'adicionar_produto', destino_id: destino.id, destino: destino.nome, campaign_id: destino.id, campanha: destino.nome, impacto: p.ultRs || 0, impacto_tipo: 'ganho' });
            if (ok) ocupadas.add(`abc:${p.chave}`);
          }
        }
      }
    } catch (e) { /* curva ABC é bônus — não derruba a análise */ }

    // ── 4) COLOCAR produtos que vendem na loja e não estão em campanha ativa ──
    let colocados = 0;
    if (tacosOk && meta) {
      const destino = C.filter(o => comFolga(o) && dentroMeta(o)).sort((a, b) => a.acos - b.acos)[0]
        || C.filter(o => dentroMeta(o)).sort((a, b) => a.acos - b.acos)[0];
      const candidatos = [...vendasLoja.values()].filter(v => !anunciados.has(v.item_id) && v.unidades >= 3).sort((a, b) => b.receita - a.receita);
      for (const v of candidatos) {
        if (!destino || colocados >= 5) break;
        const av = avisoDe([v.item_id]);
        if (seguraEstoque(av) || av?.nm === 'negativa') { colaboracoes.push({ de: av?.nm === 'negativa' ? 'margem' : 'estoque', texto: `não sugeri colocar "${String(v.nome).slice(0, 50)}" no ADS: ${av?.nm === 'negativa' ? `margem negativa (${av.m}%)` : estoqueTxt(av)}` }); continue; }
        if (repTxt(av) || qaTxt(av)) { colaboracoes.push({ de: repTxt(av) ? 'reputacao' : 'qualidade', texto: `não sugeri colocar "${String(v.nome).slice(0, 50)}" no ADS: ${repTxt(av) || qaTxt(av)}` }); continue; }
        const ok = await sugerir(`p:${v.item_id}`, `Sugestão: colocar produto em campanha — ${String(v.nome).slice(0, 60)}`,
          `"${String(v.nome).slice(0, 80)}" (${v.item_id}) vendeu ${v.unidades} un. (${R$(v.receita)}) na loja nos últimos 30 dias e não está em nenhuma campanha ativa de Product Ads. Colocar na campanha "${destino.nome}" (ACOS de ${pctTxt(destino.acos)}, dentro da meta${comFolga(destino) ? `, usando ${R$(destino.gastoDia)}/dia de ${R$(destino.budget)}` : ''}). Confira o estoque antes.`,
          { acao: 'adicionar_produto', item_ids: [v.item_id], produto: String(v.nome).slice(0, 90), unidades_loja_30d: v.unidades, receita_loja_30d: r1(v.receita), destino_id: destino.id, destino: destino.nome, campaign_id: destino.id, campanha: destino.nome, impacto: v.receita / 30 * 7, impacto_tipo: 'ganho' });
        if (ok) colocados++;
      }
    }

    if (momentoHoje) await registrarMomento();
    if (colaboracoes.length) {
      await logar('sistema', `Colaboração com Estoque e Margem — ${colaboracoes.length} decisão(ões)`,
        colaboracoes.slice(0, 12).map(x => `• ${x.texto}`).join('\n'), { colaboracoes: colaboracoes.slice(0, 30) }, 'executado');
    }
    const nProdutos = C.reduce((s, x) => s + x.familias.length, 0);
    await logar('sistema', `Análise ML concluída — ${sugestoes.length} sugestão(ões)`,
      `Analisadas ${C.length} campanhas ativas e ${nProdutos} produtos dentro delas (campanhas: ${dias} dias; produtos: ${diasProd} dias; ${R$(C.reduce((s, x) => s + x.gasto, 0))} investidos na janela da campanha). ${tacosMes != null ? `TACOS do mês: ${r1(tacosMes)}% (meta ${meta ?? '—'}%). ` : ''}${taxaCancel > 0.005 ? `ACOS sem cancelados (cancelamentos/devoluções da loja: ${r1(taxaCancel * 100)}%). ` : ''}${sugestoes.length >= MAX_SUGESTOES ? `Parou em ${MAX_SUGESTOES} sugestões para não lotar a fila — o resto vem na próxima análise. ` : ''}${detectadas ? `${detectadas} sugestão(ões) já aplicada(s) no painel detectada(s) pela leitura das campanhas. ` : ''}${medidas ? `${medidas} resultado(s) medido(s) (7 dias antes × 7 dias depois). ` : ''}${expiradas ? `${expiradas} sugestão(ões) com mais de 7 dias venceram e foram refeitas com números novos quando ainda valiam. ` : ''}Modo copiloto: aplique no painel do ML.`,
      { campanhas: C.length, produtos: nProdutos, sugestoes: sugestoes.length, tacos_mes: tacosMes, limite_pausa: limitePausa, taxa_cancelamento: taxaCancel, detectadas, medidas, expiradas }, 'executado');
    return { conta_id: contaId, marketplace: 'ml', campanhas: C.length, produtos: nProdutos, sugestoes: sugestoes.length, tacos_mes: tacosMes, detectadas, medidas, expiradas };
  } catch (e) {
    await logar('sistema', 'Erro na análise ML', e.message || String(e), {}, 'erro');
    return { conta_id: contaId, marketplace: 'ml', erro: e.message };
  }
}

module.exports = { processarContaML, agruparFamilias, listarAnunciosML, normalizarAnuncios };
