// ============================================================
// GLR Consultoria — Agente do Mercado Livre (modo COPILOTO)
// ------------------------------------------------------------
// Separado do agente da Shopee (pedido do analista). O ML não libera escrita
// em Product Ads para integrações (testado em 14/10/2026: 401 "User does not
// have permission to write" pelo Tiops E pelo app próprio da GLR), então este
// agente só ANALISA e SUGERE — cada sugestão vira um card na aba "Agente
// Mercado Livre" e o analista aplica no painel do ML e marca "Já apliquei".
//
// Mesma lógica de decisão do agente da Shopee:
//  • TACOS do MÊS (base sincronizada, faturamento sem cancelados) decide se a
//    conta tem folga pra acelerar;
//  • ACOS da campanha SEM cancelados (o ML atribui ao anúncio pedidos que
//    depois foram cancelados);
//  • PAUSAR é último recurso: só gasto alto sem retorno (sem venda ou vendendo
//    menos do que gasta, acima do limite de ~3 vendas no ticket médio × meta);
//  • ACOS alto com venda → conter: baixar a meta de ACOS da campanha
//    (estratégia Rentabilidade) ou cortar orçamento — nunca pausar.
// Alavancas do ML: orçamento diário, meta de ACOS (acos_target), status.
//
// Arquivo com "_" na frente: não vira rota na Vercel; usado por agente-cron.js.
// ============================================================

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

async function processarContaML(cfg, mcApiKey, h) {
  const { sbSelect, sbInsert, lerBase, baseCobre, baseCobreAds, somarBase, isoMenos, dataBRT, R$, mcpCall } = h;
  const contaId = String(cfg.conta_id);
  const sugestoes = [];
  async function logar(tipo, titulo, explicacao, dados, resultado) {
    try {
      await sbInsert('glr_agente_log', { conta_id: contaId, cliente_nome: cfg.cliente_nome || null, tipo, titulo, explicacao, dados: { marketplace: 'ml', ...(dados || {}) }, resultado: resultado || 'executado', origem: 'cron' });
    } catch (e) {}
  }
  try {
    const ontem = dataBRT(1).iso;
    const dias = Math.max(3, cfg.regra_pausa_dias || 7);
    const inicio = isoMenos(ontem, dias - 1);
    const meta = cfg.meta_acos || null;

    // Base sincronizada (ML): taxa de cancelamento, ticket médio e TACOS do mês
    const base = await lerBase('ml', contaId);
    let taxaCancel = 0, ticketRef = null, tacosMes = null;
    if (baseCobre(base, inicio)) {
      const t = somarBase(base, inicio, ontem);
      const b = t.faturamento + t.valor_cancelado + t.valor_devolvido;
      taxaCancel = b > 0 ? Math.min(0.6, (t.valor_cancelado + t.valor_devolvido) / b) : 0;
    }
    const de30 = isoMenos(ontem, 29);
    if (baseCobre(base, de30)) { const t30 = somarBase(base, de30, ontem); if (t30.pedidos > 0) ticketRef = t30.faturamento / t30.pedidos; }
    const mesIni = ontem.slice(0, 8) + '01';
    if (baseCobre(base, mesIni) && baseCobreAds(base, mesIni)) { const sm = somarBase(base, mesIni, ontem); if (sm.faturamento > 0) tacosMes = sm.ads / sm.faturamento * 100; }
    const tacosOk = tacosMes == null || !meta || tacosMes <= meta * 1.1;
    const limitePausa = Math.round(Math.max(50, ticketRef && meta ? ticketRef * (meta / 100) * 3 : 0) * 100) / 100;

    // O que já está pendente / foi aplicado recentemente não é sugerido de novo
    const desde3d = new Date(Date.now() - 3 * 86400000).toISOString();
    const logs = await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(contaId)}&tipo=eq.alerta&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}&select=resultado,criado_em,dados&limit=500`).catch(() => []);
    const ocupadas = new Set(logs.filter(l => l.dados?.campaign_id != null && (l.resultado === 'so_alerta' || (l.resultado === 'executado' && l.criado_em >= desde3d))).map(l => String(l.dados.campaign_id)));

    const campanhas = await listarCampanhasML(mcpCall, mcApiKey, contaId, inicio, ontem);
    const agora = Date.now();
    const instrucao = ' Aplique no painel do Mercado Livre (Publicidade → Product Ads → campanha) e marque "Já apliquei" aqui — o ML não libera essa alteração por integração.';
    let ativas = 0, gastoTotal = 0;
    for (const c of campanhas) {
      if (String(c.status || '').toLowerCase() !== 'active') continue;
      ativas++;
      const m = c.metrics || {};
      const gasto = parseFloat(m.cost) || 0, vendas = parseFloat(m.total_amount) || 0, unidades = parseInt(m.units_quantity) || 0;
      gastoTotal += gasto;
      if (ocupadas.has(String(c.id)) || gasto <= 0) continue;
      const vendasAj = vendas * (1 - taxaCancel);
      const acos = vendasAj > 0 ? gasto / vendasAj * 100 : Infinity;
      const acosTxt = acos === Infinity ? '∞' : `${acos.toFixed(1)}%${taxaCancel > 0.005 && vendas > 0 ? ` (sem cancelados; ${(gasto / vendas * 100).toFixed(1)}% no ML)` : ''}`;
      const idadeDias = c.date_created ? (agora - new Date(c.date_created).getTime()) / 86400000 : Infinity;
      const madura = idadeDias >= (cfg.dias_maturacao_campanha ?? 7);
      const budget = parseFloat(c.budget) || 0;
      const acosAlvo = parseFloat(c.acos_target) || 0;
      const rentab = String(c.strategy || '').toUpperCase() === 'PROFITABILITY';
      const nome = String(c.name || `Campanha ${c.id}`).slice(0, 70);
      const base0 = { campaign_id: Number(c.id), campanha: nome, gasto, vendas, vendas_sem_cancelados: Math.round(vendasAj * 100) / 100, acos: acos === Infinity ? null : Math.round(acos * 10) / 10, estrategia: c.strategy || null };

      // 1) Pausar — só gasto alto sem retorno, campanha madura
      if (madura && gasto >= limitePausa && (unidades === 0 || vendasAj < gasto)) {
        const exp = unidades === 0
          ? `Gastou ${R$(gasto)} nos últimos ${dias} dias sem nenhuma venda atribuída — acima do limite de ${R$(limitePausa)} (custo de ADS de ~3 vendas no ticket médio${ticketRef ? ` de ${R$(ticketRef)}` : ''}). Gasta muito sem retorno.`
          : `Gastou ${R$(gasto)} e vendeu só ${R$(vendasAj)} sem cancelados nos últimos ${dias} dias — gasta mais do que vende, acima do limite de ${R$(limitePausa)}.`;
        await logar('alerta', `Sugestão: pausar — ${nome}`, exp + instrucao, { ...base0, acao: 'pausar' }, 'so_alerta');
        sugestoes.push(nome); continue;
      }
      if (!meta || acos === Infinity) continue;

      // 2) Conter — ACOS acima da meta com venda (nunca pausa)
      if (madura && acos > meta) {
        const forte = !!cfg.regra_pausa_acos && acos > cfg.regra_pausa_acos;
        const passo = forte ? 0.25 : 0.15;
        if (rentab && acosAlvo > 0) {
          const novo = Math.max(1, Math.round(acosAlvo * (1 - passo) * 100) / 100);
          await logar('alerta', `Sugestão: baixar meta de ACOS — ${nome}`, `ACOS de ${acosTxt} nos últimos ${dias} dias, acima da meta (${meta}%)${forte ? ` e da contenção forte (${cfg.regra_pausa_acos}%)` : ''}, mas a campanha vende — conter em vez de pausar. Baixar a meta de ACOS da campanha de ${acosAlvo}% para ${novo}% (lance mais conservador).` + instrucao, { ...base0, acao: 'acos_target', de: acosAlvo, para: novo }, 'so_alerta');
          sugestoes.push(nome);
        } else if (budget > (cfg.orcamento_min || 0)) {
          const novo = Math.max(cfg.orcamento_min || 0, Math.round(budget * (1 - passo) * 100) / 100);
          if (novo < budget) {
            await logar('alerta', `Sugestão: reduzir orçamento — ${nome}`, `ACOS de ${acosTxt} nos últimos ${dias} dias, acima da meta (${meta}%), mas a campanha vende — conter em vez de pausar. Reduzir o orçamento diário de ${R$(budget)} para ${R$(novo)}.` + instrucao, { ...base0, acao: 'orcamento', de: budget, para: novo }, 'so_alerta');
            sugestoes.push(nome);
          }
        }
        continue;
      }

      // 3) Acelerar — ACOS bem abaixo da meta e TACOS do mês com folga
      if (acos <= meta * 0.7 && tacosOk) {
        const gastoDia = gasto / dias;
        if (budget > 0 && gastoDia >= budget * 0.8 && (!cfg.orcamento_max || budget < cfg.orcamento_max)) {
          const novo = Math.round(Math.min(cfg.orcamento_max || Infinity, budget * 1.2) * 100) / 100;
          await logar('alerta', `Sugestão: aumentar orçamento — ${nome}`, `ACOS de ${acosTxt}, bem abaixo da meta (${meta}%), ${tacosMes != null ? `TACOS do mês em ${tacosMes.toFixed(1)}%, ` : ''}e o orçamento está quase todo consumido (média de ${R$(gastoDia)}/dia de ${R$(budget)}). Aumentar o orçamento diário para ${R$(novo)}.` + instrucao, { ...base0, acao: 'orcamento', de: budget, para: novo }, 'so_alerta');
          sugestoes.push(nome);
        } else if (rentab && acosAlvo > 0 && acosAlvo < meta) {
          const novo = Math.min(meta, Math.round(acosAlvo * 1.15 * 100) / 100);
          if (novo > acosAlvo) {
            await logar('alerta', `Sugestão: subir meta de ACOS — ${nome}`, `ACOS de ${acosTxt}, bem abaixo da meta (${meta}%)${tacosMes != null ? ` e TACOS do mês em ${tacosMes.toFixed(1)}%` : ''}. Subir a meta de ACOS da campanha de ${acosAlvo}% para ${novo}% para o ML disputar mais leilões e trazer volume.` + instrucao, { ...base0, acao: 'acos_target', de: acosAlvo, para: novo }, 'so_alerta');
            sugestoes.push(nome);
          }
        }
      }
    }
    await logar('sistema', `Análise ML concluída — ${sugestoes.length} sugestão(ões)`,
      `Analisadas ${ativas} campanhas ativas de Product Ads (janela de ${dias} dias, ${R$(gastoTotal)} investidos). ${tacosMes != null ? `TACOS do mês: ${tacosMes.toFixed(1)}% (meta ${meta ?? '—'}%). ` : ''}${taxaCancel > 0.005 ? `ACOS sem cancelados (taxa de cancelamento da loja: ${(taxaCancel * 100).toFixed(1)}%). ` : ''}Modo copiloto: ${sugestoes.length} sugestão(ões) para aplicar no painel do ML.`,
      { campanhas: ativas, sugestoes: sugestoes.length, tacos_mes: tacosMes, limite_pausa: limitePausa, taxa_cancelamento: taxaCancel }, 'executado');
    return { conta_id: contaId, marketplace: 'ml', campanhas: ativas, sugestoes: sugestoes.length, tacos_mes: tacosMes };
  } catch (e) {
    await logar('sistema', 'Erro na análise ML', e.message || String(e), {}, 'erro');
    return { conta_id: contaId, marketplace: 'ml', erro: e.message };
  }
}

module.exports = { processarContaML };
