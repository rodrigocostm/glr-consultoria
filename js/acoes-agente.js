// ============================================================
// GLR Consultoria — Executar / descartar sugestões dos agentes
// ------------------------------------------------------------
// Uma regra só para aprovar uma sugestão (glr_agente_log tipo 'alerta',
// resultado 'so_alerta'): a tela do ADS Shopee e a Caixa de decisões chamam
// daqui. Executa no marketplace, marca a sugestão como executada e grava a
// decisão no formato "de → para" (o mesmo das decisões do cron), com
// origem 'aprovacao_manual'.
// ============================================================
window.GLRAcoes = (function () {
  // ads (campanha Shopee), estoque e preço — o resto é informativo
  function tipoDe(d) {
    d = d || {};
    if (d.campaign_id != null && (d.roas_sugerido != null || d.budget_sugerido != null || d.pausar === true || d.retomar === true)) return 'ads';
    if (d.item_id != null && d.estoque_sugerido != null) return 'estoque';
    if (d.item_id != null && d.preco_sugerido != null) return 'preco';
    return null;
  }

  async function executar(l, clienteNome) {
    const d = l.dados || {};
    const tipo = tipoDe(d);
    if (!tipo) throw new Error('sugestão informativa — não tem ação automática para aprovar');
    if (tipo === 'ads' && !Number.isFinite(Number(d.campaign_id))) throw new Error(`a sugestão não tem uma campanha válida (campaign_id "${d.campaign_id}"). Rejeite e peça de novo ao agente.`);
    if (tipo === 'ads') {
      if (d.retomar === true) {
        // reativar de verdade; se veio também uma meta de ROAS nova ("reativar e apertar ROAS"), aplica depois
        await MarketplaceAPI.call('shopee_ads_resume_campaign', { shopId: l.conta_id, campaign_id: Number(d.campaign_id) });
        if (d.roas_sugerido != null) await MarketplaceAPI.call('shopee_ads_roi_target', { shopId: l.conta_id, campaign_id: Number(d.campaign_id), roas_target: d.roas_sugerido });
      } else if (d.pausar === true) {
        await MarketplaceAPI.call('shopee_ads_pause_campaign', { shopId: l.conta_id, campaign_id: Number(d.campaign_id) });
      } else if (d.roas_sugerido != null) {
        await MarketplaceAPI.call('shopee_ads_roi_target', { shopId: l.conta_id, campaign_id: Number(d.campaign_id), roas_target: d.roas_sugerido });
      } else {
        await MarketplaceAPI.call('shopee_ads_edit_campaign', {
          shopId: l.conta_id,
          campaign_id: Number(d.campaign_id), // conector valida no nível de cima também
          params: { campaign_id: Number(d.campaign_id), budget: d.budget_sugerido, edit_action: 'change_budget', reference_id: `glr-aprovado-${Date.now()}-${d.campaign_id}` },
        });
      }
    } else if (tipo === 'estoque') {
      if (d.marketplace === 'ml') await MarketplaceAPI.call('ml_update_variation_stock', { item_id: d.item_id, variation_id: d.model_id, available_quantity: d.estoque_sugerido });
      else await MarketplaceAPI.call('shopee_update_stock', { shopId: l.conta_id, item_id: Number(d.item_id), model_id: d.model_id ? Number(d.model_id) : undefined, stock: d.estoque_sugerido });
    } else if (tipo === 'preco') {
      if (d.marketplace === 'ml') await MarketplaceAPI.call('ml_update_variations_price', { item_id: d.item_id, price: d.preco_sugerido });
      else await MarketplaceAPI.call('shopee_update_price', { shopId: l.conta_id, item_id: Number(d.item_id), model_id: d.model_id ? Number(d.model_id) : undefined, price: d.preco_sugerido });
    }
    // decisão no formato "de → para" (igual às do cron) — senão o card continuava com selo de "Sugestão"
    const dadosExec = { ...d };
    if (d.roas_sugerido != null) { dadosExec.roas_de = d.roas_atual; dadosExec.roas_para = d.roas_sugerido; delete dadosExec.roas_atual; delete dadosExec.roas_sugerido; }
    if (d.budget_sugerido != null) { dadosExec.budget_de = d.budget_atual; dadosExec.budget_para = d.budget_sugerido; delete dadosExec.budget_atual; delete dadosExec.budget_sugerido; }
    if (d.retomar === true) { dadosExec.retomada = true; delete dadosExec.retomar; }
    if (d.pausar === true) { dadosExec.pausada = true; delete dadosExec.pausar; }
    await _sb.from('glr_agente_log').update({ resultado: 'executado' }).eq('id', l.id);
    await _sb.from('glr_agente_log').insert({
      conta_id: l.conta_id, cliente_nome: clienteNome || l.cliente_nome || null, tipo: 'decisao',
      titulo: `Aprovado manualmente — ${(l.titulo || '').replace(/^Sugestão de /, '')}`,
      explicacao: `Alerta aprovado pelo analista. ${l.explicacao || ''}`, dados: dadosExec, resultado: 'executado', origem: 'aprovacao_manual',
    });
  }

  // 'descartado' (não fazer) ou 'executado' (o analista já aplicou por fora — ex.: painel do ML)
  async function marcar(l, resultado) {
    const extra = resultado === 'executado' ? { dados: { ...(l.dados || {}), aplicado_em: new Date().toISOString(), aplicado_por: 'analista' } } : {};
    const { error } = await _sb.from('glr_agente_log').update({ resultado, ...extra }).eq('id', l.id);
    if (error) throw error;
  }

  return { tipoDe, executar, marcar };
})();
