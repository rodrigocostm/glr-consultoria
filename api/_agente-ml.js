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
  return todos;
}

// Soma os anúncios por família (variações do mesmo produto)
function agruparFamilias(anuncios, taxaCancel) {
  const fam = new Map();
  for (const a of anuncios) {
    const k = String(a.family_id || a.item_id);
    const f = fam.get(k) || { chave: k, nome: a.family_name || a.title || a.item_id, itens: [], ativos: [], gasto: 0, vendas: 0, unidades: 0, cliques: 0, impressoes: 0, precoSoma: 0, recomendado: false };
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

async function processarContaML(cfg, mcApiKey, h) {
  const { sbSelect, sbInsert, lerBase, baseCobre, baseCobreAds, somarBase, isoMenos, dataBRT, R$, mcpCall } = h;
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
    const tacosOk = tacosMes == null || !meta || tacosMes <= meta * 1.1;
    const limitePausa = Math.round(Math.max(50, ticketRef && meta ? ticketRef * (meta / 100) * 3 : 0) * 100) / 100;

    // O que já está pendente / foi aplicado nos últimos 3 dias não é sugerido de novo
    const desde3d = new Date(Date.now() - 3 * 86400000).toISOString();
    const logs = await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(contaId)}&tipo=eq.alerta&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}&select=resultado,criado_em,dados&limit=500`).catch(() => []);
    const ocupadas = new Set(logs
      .filter(l => l.resultado === 'so_alerta' || (l.resultado === 'executado' && l.criado_em >= desde3d))
      .map(l => l.dados?.chave || (l.dados?.campaign_id != null ? `c:${l.dados.campaign_id}` : null)).filter(Boolean));
    // Avisos da curva ABC: um por produto a cada 7 dias (mesmo se descartado)
    const desde7d = new Date(Date.now() - 6.5 * 86400000).toISOString();
    logs.filter(l => String(l.dados?.chave || '').startsWith('abc:') && l.criado_em >= desde7d).forEach(l => ocupadas.add(l.dados.chave));
    const livre = chave => !ocupadas.has(chave) && sugestoes.length < MAX_SUGESTOES;
    async function sugerir(chave, titulo, explicacao, dados) {
      if (!livre(chave)) return false;
      ocupadas.add(chave);
      await logar('alerta', titulo, explicacao + instrucao, { chave, ...dados }, 'so_alerta');
      sugestoes.push(titulo);
      return true;
    }

    // Campanhas (janela da campanha) + anúncios de cada campanha ativa (janela de produto)
    const [campanhas, vendasLoja] = await Promise.all([
      listarCampanhasML(mcpCall, mcApiKey, contaId, inicio, ontem),
      vendasPorItem(sbSelect, contaId, new Date(`${de30}T00:00:00-03:00`).toISOString()),
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
    const naLoja = item => vendasLoja.get(item) || null;
    const lojaFam = f => f.itens.reduce((s, it) => { const v = naLoja(it); return v ? { un: s.un + v.unidades, rec: s.rec + v.receita } : s; }, { un: 0, rec: 0 });
    const comFolga = x => x.budget > 0 && x.gastoDia < x.budget * 0.7;
    const dentroMeta = x => meta && x.acos != null && x.acos !== Infinity && x.acos <= meta;

    const excluido = new Map(); // campanha → gasto/vendas de produtos já tratados
    const tirar = (x, f) => { const e = excluido.get(x.id) || { gasto: 0, vendasAj: 0 }; e.gasto += f.gasto; e.vendasAj += f.vendasAj; excluido.set(x.id, e); };

    // ── 1) PRODUTOS dentro das campanhas ──
    for (const x of C) {
      if (!x.madura) continue;
      for (const f of [...x.familias].sort((a, b) => b.gasto - a.gasto)) {
        if (!f.ativos.length || f.gasto <= 0) continue;
        const chave = `p:${f.chave}`;
        const custoVenda = f.preco * ((meta || 10) / 100); // ADS aceitável por venda deste produto
        const limProd = Math.max(15, custoVenda * 2);
        const loja = lojaFam(f);
        const lojaTxt = loja.un > 0 ? ` Na loja inteira (orgânico + ADS) vendeu ${loja.un} un. nos últimos 30 dias.` : ' Também não vendeu na loja nos últimos 30 dias.';
        const base0 = { campaign_id: x.id, campanha: x.nome, familia: f.chave, produto: f.nome.slice(0, 90), item_ids: f.ativos, gasto: r1(f.gasto), vendas_sem_cancelados: r1(f.vendasAj), unidades: f.unidades, acos: f.acos === Infinity ? null : f.acos && r1(f.acos), janela_dias: diasProd };

        // 1a) Tirar da campanha — gasta sem retorno
        if (f.gasto >= limProd && (f.unidades === 0 || f.vendasAj < f.gasto)) {
          const ok = await sugerir(chave, `Sugestão: tirar produto da campanha — ${f.nome.slice(0, 60)}`,
            `Na campanha "${x.nome}", ${f.itens.length > 1 ? `as ${f.ativos.length} variações ativas deste produto gastaram` : 'este anúncio gastou'} ${R$(f.gasto)} em ${diasProd} dias com ${f.unidades === 0 ? 'nenhuma venda pelo ADS' : `só ${R$(f.vendasAj)} em vendas sem cancelados`} — mais que ${R$(limProd)} (ADS de ~2 vendas no preço de ${R$(f.preco)}).${lojaTxt}${loja.un >= 5 ? ' Vende sem o ADS — o anúncio pago não está somando.' : ''} Tirar da campanha (pausar o anúncio) para o orçamento ir para quem vende.`,
            { ...base0, acao: 'retirar_produto' });
          if (ok) tirar(x, f);
          continue;
        }
        if (!meta || f.acos == null || f.acos === Infinity) continue;

        // 1b) Produto que puxa o ACOS da campanha → campanha mais conservadora
        const pesado = f.gasto >= Math.max(limProd, x.gasto * 0.3);
        if (pesado && f.acos > Math.max(meta * 1.5, cfg.regra_pausa_acos || 0) && f.unidades > 0) {
          const destino = C.filter(o => o.id !== x.id && o.roasAlvo > x.roasAlvo && o.rentab).sort((a, b) => a.roasAlvo - b.roasAlvo)[0];
          const roasNova = r1(Math.max(roasMeta, x.roasAlvo * 1.25)); // campanha nova: sempre mais conservadora que a atual
          const ok = await sugerir(chave, `Sugestão: mover produto para campanha mais conservadora — ${f.nome.slice(0, 50)}`,
            `"${f.nome.slice(0, 70)}" vende, mas com ACOS de ${pctTxt(f.acos)} (sem cancelados) em ${diasProd} dias — bem acima da meta (${meta}%) — e responde por ${Math.round(f.gasto / (x.gasto || f.gasto) * 100)}% do gasto da campanha "${x.nome}" (ROAS objetivo ${roasTxt(x.roasAlvo)}). Em vez de apertar a campanha inteira, ${destino ? `mover este produto para "${destino.nome}" (ROAS objetivo ${roasTxt(destino.roasAlvo)}, lance mais conservador)` : `criar uma campanha só para ele com ROAS objetivo de ${roasTxt(roasNova)} (lance mais conservador)`}. Não pausar: o produto vende.`,
            { ...base0, acao: 'mover_produto', destino_id: destino?.id || null, destino: destino?.nome || null, de: x.roasAlvo, para: destino ? destino.roasAlvo : roasNova });
          if (ok) tirar(x, f);
          continue;
        }

        // 1c) Produto campeão travado por verba → campanha com folga
        const travada = x.budget > 0 && x.gastoDia >= x.budget * 0.85;
        const semComoSubir = cfg.orcamento_max && x.budget >= cfg.orcamento_max;
        if (tacosOk && travada && semComoSubir && f.unidades >= 3 && f.acos <= meta * 0.6) {
          const destino = C.filter(o => o.id !== x.id && comFolga(o) && (dentroMeta(o) || !o.gasto) && o.roasAlvo <= x.roasAlvo).sort((a, b) => (b.budget - b.gastoDia) - (a.budget - a.gastoDia))[0];
          if (destino) {
            const ok = await sugerir(chave, `Sugestão: mover produto campeão para campanha com verba — ${f.nome.slice(0, 50)}`,
              `"${f.nome.slice(0, 70)}" vendeu ${f.unidades} un. pelo ADS com ACOS de ${pctTxt(f.acos)} em ${diasProd} dias, mas "${x.nome}" já gasta todo o orçamento (${R$(x.gastoDia)}/dia de ${R$(x.budget)}, no teto configurado). Mover para "${destino.nome}", que usa só ${R$(destino.gastoDia)}/dia de ${R$(destino.budget)}.`,
              { ...base0, acao: 'mover_produto', destino_id: destino.id, destino: destino.nome, de: x.roasAlvo, para: destino.roasAlvo });
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
      if (x.madura && gasto >= limitePausa && (x.unidades === 0 || vendasAj < gasto) && !ex.gasto) {
        await sugerir(chave, `Sugestão: pausar campanha — ${x.nome}`,
          x.unidades === 0
            ? `Gastou ${R$(x.gasto)} nos últimos ${dias} dias sem nenhuma venda atribuída — acima do limite de ${R$(limitePausa)} (ADS de ~3 vendas no ticket médio${ticketRef ? ` de ${R$(ticketRef)}` : ''}). Gasta muito sem retorno.`
            : `Gastou ${R$(x.gasto)} e vendeu só ${R$(x.vendasAj)} sem cancelados nos últimos ${dias} dias — gasta mais do que vende, acima do limite de ${R$(limitePausa)}.`,
          { ...base0, acao: 'pausar' });
        continue;
      }
      if (!meta || acos == null || acos === Infinity) continue;

      // 2b) Conter — ACOS acima da meta com venda: subir ROAS objetivo (ou cortar orçamento)
      if (x.madura && acos > meta) {
        const forte = !!cfg.regra_pausa_acos && acos > cfg.regra_pausa_acos;
        const passo = forte ? 0.25 : 0.15;
        if (x.rentab && x.roasAlvo > 0) {
          const novo = r1(x.roasAlvo / (1 - passo));
          await sugerir(chave, `Sugestão: subir ROAS objetivo — ${x.nome}`,
            `ACOS de ${acosTxt} nos últimos ${dias} dias, acima da meta (${meta}%, equivale a ROAS ${roasTxt(roasMeta)})${forte ? ` e da contenção forte (${cfg.regra_pausa_acos}%)` : ''}, mas a campanha vende — conter em vez de pausar. Subir o ROAS objetivo de ${roasTxt(x.roasAlvo)} para ${roasTxt(novo)} (lance mais conservador).`,
            { ...base0, acao: 'roas_target', de: r1(x.roasAlvo), para: novo });
        } else if (x.budget > (cfg.orcamento_min || 0)) {
          const novo = Math.max(cfg.orcamento_min || 0, Math.round(x.budget * (1 - passo) * 100) / 100);
          if (novo < x.budget) await sugerir(chave, `Sugestão: reduzir orçamento — ${x.nome}`,
            `ACOS de ${acosTxt} nos últimos ${dias} dias, acima da meta (${meta}%), mas a campanha vende — conter em vez de pausar. Reduzir o orçamento diário de ${R$(x.budget)} para ${R$(novo)}.`,
            { ...base0, acao: 'orcamento', de: x.budget, para: novo });
        }
        continue;
      }

      // 2c) Acelerar — ACOS bem abaixo da meta e TACOS do mês com folga
      if (acos <= meta * 0.7 && tacosOk) {
        if (x.budget > 0 && x.gastoDia >= x.budget * 0.8 && (!cfg.orcamento_max || x.budget < cfg.orcamento_max)) {
          const novo = Math.round(Math.min(cfg.orcamento_max || Infinity, x.budget * 1.2) * 100) / 100;
          await sugerir(chave, `Sugestão: aumentar orçamento — ${x.nome}`,
            `ACOS de ${acosTxt}, bem abaixo da meta (${meta}%)${tacosMes != null ? `, TACOS do mês em ${r1(tacosMes)}%` : ''}, e o orçamento está quase todo consumido (média de ${R$(x.gastoDia)}/dia de ${R$(x.budget)}). Aumentar o orçamento diário para ${R$(novo)}.`,
            { ...base0, acao: 'orcamento', de: x.budget, para: novo });
        } else if (x.rentab && x.roasAlvo > roasMeta * 1.02) {
          const novo = r1(Math.max(roasMeta, x.roasAlvo / 1.15));
          if (novo < x.roasAlvo) await sugerir(chave, `Sugestão: baixar ROAS objetivo — ${x.nome}`,
            `ACOS de ${acosTxt}, bem abaixo da meta (${meta}%)${tacosMes != null ? ` e TACOS do mês em ${r1(tacosMes)}%` : ''}. Baixar o ROAS objetivo de ${roasTxt(x.roasAlvo)} para ${roasTxt(novo)} para o ML disputar mais leilões e trazer volume (sem passar do ROAS ${roasTxt(roasMeta)} da meta).`,
            { ...base0, acao: 'roas_target', de: r1(x.roasAlvo), para: novo });
        }
      }
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
            { ...base1(p), acao: 'abc_queda', ...(camp ? { campaign_id: camp.id, campanha: camp.nome } : {}) });
        }
        if (tacosOk && meta) {
          const destino = C.filter(o => comFolga(o) && dentroMeta(o)).sort((a, b) => a.acos - b.acos)[0] || C.filter(o => dentroMeta(o)).sort((a, b) => a.acos - b.acos)[0];
          for (const p of curva.sobeBC.slice(0, 4)) {
            if (campDoItem[p.item_id] || !destino || !p.item_id) continue;
            const ok = await sugerir(`p:${p.item_id}`, `Curva ${p.classe} subindo — colocar em campanha: ${p.nome.slice(0, 50)}`,
              `Produto curva ${p.classe} em ${curvaABC.TEND_TXT[p.tend]}: ${linhaSemana(p)} — candidato a virar curva A e está fora de campanha. Colocar na campanha "${destino.nome}" (ACOS de ${pctTxt(destino.acos)}, dentro da meta${comFolga(destino) ? `, usando ${R$(destino.gastoDia)}/dia de ${R$(destino.budget)}` : ''}) para aproveitar a alta. Confira o estoque antes.`,
              { ...base1(p), acao: 'adicionar_produto', destino_id: destino.id, destino: destino.nome, campaign_id: destino.id, campanha: destino.nome });
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
        const ok = await sugerir(`p:${v.item_id}`, `Sugestão: colocar produto em campanha — ${String(v.nome).slice(0, 60)}`,
          `"${String(v.nome).slice(0, 80)}" (${v.item_id}) vendeu ${v.unidades} un. (${R$(v.receita)}) na loja nos últimos 30 dias e não está em nenhuma campanha ativa de Product Ads. Colocar na campanha "${destino.nome}" (ACOS de ${pctTxt(destino.acos)}, dentro da meta${comFolga(destino) ? `, usando ${R$(destino.gastoDia)}/dia de ${R$(destino.budget)}` : ''}). Confira o estoque antes.`,
          { acao: 'adicionar_produto', item_ids: [v.item_id], produto: String(v.nome).slice(0, 90), unidades_loja_30d: v.unidades, receita_loja_30d: r1(v.receita), destino_id: destino.id, destino: destino.nome, campaign_id: destino.id, campanha: destino.nome });
        if (ok) colocados++;
      }
    }

    const nProdutos = C.reduce((s, x) => s + x.familias.length, 0);
    await logar('sistema', `Análise ML concluída — ${sugestoes.length} sugestão(ões)`,
      `Analisadas ${C.length} campanhas ativas e ${nProdutos} produtos dentro delas (campanhas: ${dias} dias; produtos: ${diasProd} dias; ${R$(C.reduce((s, x) => s + x.gasto, 0))} investidos na janela da campanha). ${tacosMes != null ? `TACOS do mês: ${r1(tacosMes)}% (meta ${meta ?? '—'}%). ` : ''}${taxaCancel > 0.005 ? `ACOS sem cancelados (cancelamentos/devoluções da loja: ${r1(taxaCancel * 100)}%). ` : ''}${sugestoes.length >= MAX_SUGESTOES ? `Parou em ${MAX_SUGESTOES} sugestões para não lotar a fila — o resto vem na próxima análise. ` : ''}Modo copiloto: aplique no painel do ML.`,
      { campanhas: C.length, produtos: nProdutos, sugestoes: sugestoes.length, tacos_mes: tacosMes, limite_pausa: limitePausa, taxa_cancelamento: taxaCancel }, 'executado');
    return { conta_id: contaId, marketplace: 'ml', campanhas: C.length, produtos: nProdutos, sugestoes: sugestoes.length, tacos_mes: tacosMes };
  } catch (e) {
    await logar('sistema', 'Erro na análise ML', e.message || String(e), {}, 'erro');
    return { conta_id: contaId, marketplace: 'ml', erro: e.message };
  }
}

module.exports = { processarContaML, agruparFamilias, listarAnunciosML };
