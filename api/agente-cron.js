// Cron do Agente Autônomo de ADS — roda 1x/dia às 07:00 BRT (vercel.json).
// Para cada conta marcada como piloto (glr_agente_config.ativo=true — hoje é
// sempre 1 conta só, de propósito, é o teste controlado), avalia as campanhas
// Shopee do dia anterior contra as metas configuradas, executa pausar/retomar/
// ajustar orçamento quando a decisão é clara, registra TUDO em glr_agente_log
// (mesmo quando não age) e fecha com um relatório diário em português gerado
// por IA, salvo em glr_agente_relatorios.
//
// Por que só Shopee: é o único marketplace com execução automática validada
// nesta integração (pausar/retomar/orçamento testados ao vivo). ML/TikTok/
// Amazon ficam de fora da execução autônoma até serem validados do mesmo jeito.
//
// Autenticação Tiops: usa MC_API_KEY (env var), não glr_storage — o RLS de
// glr_storage foi travado pra "authenticated" nesta mesma sessão (correção de
// segurança), e um cron sem usuário logado não tem esse papel. Reabrir leitura
// anônima só pra essa chave reabriria exatamente o buraco que foi fechado.

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJyb2RxbGVqcXlhb29tdXRyaWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjU5NjUsImV4cCI6MjA5NjQ0MTk2NX0.JaKQHoGH8S3ZdLQInLErpC21SZ0j4FmIGtvWKcBes-A';

async function sbSelect(table, qs) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase select ${table} falhou: HTTP ${r.status}`);
  return r.json();
}

async function sbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Supabase insert ${table} falhou: HTTP ${r.status} ${t}`);
  }
}

async function mcpCall(apiKey, action, params) {
  const r = await fetch('https://mcp.tiops.com.br', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ action, params: params || {} }),
  });
  const json = await r.json();
  if (!r.ok || (json.status && json.status !== 200)) {
    throw new Error(json.error || json.message || `Erro na ação ${action}`);
  }
  return json;
}

function dataBRT(diasAtras = 0) {
  const brt = new Date(Date.now() - 3 * 3600 * 1000);
  brt.setUTCDate(brt.getUTCDate() - diasAtras);
  const pad = n => String(n).padStart(2, '0');
  return {
    iso: `${brt.getUTCFullYear()}-${pad(brt.getUTCMonth() + 1)}-${pad(brt.getUTCDate())}`,
    ddmmyyyy: `${pad(brt.getUTCDate())}-${pad(brt.getUTCMonth() + 1)}-${brt.getUTCFullYear()}`,
  };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'];
  const isVercelCron = !!req.headers['x-vercel-cron'] || !!req.headers['x-vercel-cron-signature'];
  if (secret && !isVercelCron && auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const mcApiKey = process.env.MC_API_KEY;
  if (!mcApiKey) {
    return res.status(200).json({ ok: true, skip: 'MC_API_KEY não configurada no Vercel — veja Integrações no app pra pegar a chave.' });
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  try {
    const configs = await sbSelect('glr_agente_config', 'ativo=eq.true');
    if (!configs.length) {
      return res.status(200).json({ ok: true, skip: 'nenhuma conta piloto ativa em glr_agente_config' });
    }

    const ontem = dataBRT(1);

    const resultados = [];
    for (const cfg of configs) {
      const inicioJanela = dataBRT(Math.max(1, cfg.regra_pausa_dias || 3));
      const r = await processarConta(cfg, mcApiKey, anthropicKey, ontem, inicioJanela);
      resultados.push(r);
    }
    return res.status(200).json({ ok: true, processadas: resultados.length, resultados });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};

async function processarConta(cfg, mcApiKey, anthropicKey, ontem, inicioJanela) {
  const shopId = cfg.conta_id;
  const decisoes = [];
  const alertas = [];

  async function logar(tipo, titulo, explicacao, dados, resultado) {
    try {
      await sbInsert('glr_agente_log', {
        conta_id: shopId, cliente_nome: cfg.cliente_nome || null,
        tipo, titulo, explicacao, dados: dados || {}, resultado: resultado || 'executado', origem: 'cron',
      });
    } catch (e) { /* não deixa falha de log derrubar a revisão */ }
  }

  async function executarPausa(campaignId, nome, explicacao, dados) {
    try {
      await mcpCall(mcApiKey, 'shopee_ads_pause_campaign', { shopId, campaign_id: Number(campaignId) });
      await logar('decisao', `Campanha pausada — ${nome}`, explicacao, dados, 'executado');
      decisoes.push(nome);
    } catch (e) {
      await logar('decisao', `Falha ao pausar — ${nome}`, `Tentei pausar por: ${explicacao} — mas deu erro: ${e.message}`, dados, 'erro');
    }
  }

  async function executarOrcamento(campaignId, nome, novoBudget, explicacao, dados) {
    try {
      await mcpCall(mcApiKey, 'shopee_ads_edit_campaign', { shopId, campaign_id: Number(campaignId), campaign_budget: novoBudget });
      await logar('decisao', `Orçamento ajustado — ${nome}`, explicacao, dados, 'executado');
      decisoes.push(nome);
    } catch (e) {
      await logar('decisao', `Falha ao ajustar orçamento — ${nome}`, `Tentei ajustar por: ${explicacao} — mas deu erro: ${e.message}`, dados, 'erro');
    }
  }

  try {
    // 1) Lista campanhas (sem métricas, só id/nome)
    const listaResp = await mcpCall(mcApiKey, 'shopee_ads_campaigns', { shopId });
    const campanhas = listaResp.data?.response?.campaign_list || listaResp.response?.campaign_list || [];
    if (!campanhas.length) {
      await logar('sistema', 'Nenhuma campanha encontrada', 'Conta não tem campanhas de ADS ativas na Shopee — nada pra avaliar hoje.', {}, 'so_alerta');
      return { conta_id: shopId, campanhas: 0 };
    }

    const settingsPorId = {};
    const diarioPorId = {}; // soma da janela (regra_pausa_dias) por campanha

    for (const lote of chunk(campanhas.map(c => c.campaign_id), 20)) {
      const idsStr = lote.join(',');
      const [settingsResp, diarioResp] = await Promise.all([
        mcpCall(mcApiKey, 'shopee_ads_campaign_settings', { shopId, campaign_id_list: idsStr }).catch(() => null),
        mcpCall(mcApiKey, 'shopee_ads_campaign_daily', { shopId, campaign_id_list: idsStr, start_date: inicioJanela.ddmmyyyy, end_date: ontem.ddmmyyyy }).catch(() => null),
      ]);
      (settingsResp?.data?.response?.campaign_list || settingsResp?.response?.campaign_list || []).forEach(c => {
        settingsPorId[c.campaign_id] = c.common_info || {};
      });
      (diarioResp?.data?.response?.campaign_list || diarioResp?.response?.campaign_list || []).forEach(c => {
        const dias = c.metrics_list || [];
        diarioPorId[c.campaign_id] = {
          gasto: dias.reduce((s, d) => s + (parseFloat(d.expense) || 0), 0),
          gmv: dias.reduce((s, d) => s + (parseFloat(d.broad_gmv) || 0), 0),
          pedidos: dias.reduce((s, d) => s + (parseInt(d.broad_order) || 0), 0),
          diasComGasto: dias.filter(d => (parseFloat(d.expense) || 0) > 0).length,
          gastoOntem: parseFloat(dias.find(d => d.date === ontem.ddmmyyyy)?.expense) || 0,
        };
      });
    }

    // Faturamento TOTAL da loja na mesma janela (não só o atribuído ao ADS) —
    // é a base do TACOS. Mesmos status usados no resto do app (shopeeFaturamento
    // em marketplace-api.js): COMPLETED + READY_TO_SHIP + SHIPPED.
    const diasJanela = Math.max(1, cfg.regra_pausa_dias || 3);
    let faturamentoTotalLoja = 0;
    for (const st of ['COMPLETED', 'READY_TO_SHIP', 'SHIPPED']) {
      try {
        const r = await mcpCall(mcApiKey, 'shopee_sales_summary', { shopId, days: diasJanela, order_status: st });
        faturamentoTotalLoja += parseFloat(r.data?.total_revenue || r.total_revenue) || 0;
      } catch (e) {}
    }

    let gastoTotalOntem = 0, gmvTotalJanela = 0, gastoTotalJanela = 0;
    const diasMaturacao = cfg.dias_maturacao_campanha ?? 7;
    const agoraTs = Date.now() / 1000;

    for (const c of campanhas) {
      const settings = settingsPorId[c.campaign_id];
      const diario = diarioPorId[c.campaign_id];
      if (!settings || !diario) continue;
      const status = (settings.campaign_status || '').toLowerCase();
      const budgetAtual = parseFloat(settings.campaign_budget) || 0;
      if (status !== 'ongoing') continue; // só reavalia campanha ativa hoje

      gastoTotalOntem += diario.gastoOntem;
      gmvTotalJanela += diario.gmv;
      gastoTotalJanela += diario.gasto;
    }

    // TACOS da conta = investimento total em ADS ÷ faturamento TOTAL da loja
    // (não só a venda atribuída ao ADS) — é o critério principal, do jeito que
    // a GLR se baseia pra decisão, não ACOS isolado por campanha (esse mede
    // eficiência daquela campanha específica, útil pra comparar campanhas
    // entre si, mas não pra dizer se a conta como um todo está saudável).
    const tacosConta = faturamentoTotalLoja > 0 ? (gastoTotalJanela / faturamentoTotalLoja) * 100 : (gastoTotalJanela > 0 ? Infinity : 0);
    const tacosDentroDaMeta = !cfg.meta_acos || tacosConta <= cfg.meta_acos * 1.1; // 10% de folga antes de travar aumento de orçamento

    for (const c of campanhas) {
      const settings = settingsPorId[c.campaign_id];
      const diario = diarioPorId[c.campaign_id];
      if (!settings || !diario) continue;
      const status = (settings.campaign_status || '').toLowerCase();
      const budgetAtual = parseFloat(settings.campaign_budget) || 0;
      if (status !== 'ongoing') continue;

      const acosJanela = diario.gmv > 0 ? diario.gasto / diario.gmv : (diario.gasto > 0 ? Infinity : null);
      const nome = c.campaign_name?.slice(0, 70) || `Campanha ${c.campaign_id}`;
      const inicioTs = settings.campaign_duration?.start_time || 0;
      const idadeDias = inicioTs ? (agoraTs - inicioTs) / 86400 : Infinity;
      const emMaturacao = idadeDias < diasMaturacao;

      // Regra 1 e 2 (pausar por gasto sem venda / ACOS alto sustentado): uma
      // campanha ainda em maturação não é pausada por isso — só registra que
      // o critério bateu, mas está segurando pra dar tempo de amadurecer.
      const bateuCriterioPausa =
        (cfg.regra_pausa_acos && diario.diasComGasto >= Math.min(2, cfg.regra_pausa_dias || 3) && acosJanela === Infinity) ||
        (cfg.regra_pausa_acos && acosJanela !== null && acosJanela !== Infinity && acosJanela * 100 > cfg.regra_pausa_acos && diario.diasComGasto >= (cfg.regra_pausa_dias || 3));

      if (bateuCriterioPausa) {
        if (emMaturacao) {
          await logar('sistema', `Maturação segurando pausa — ${nome}`,
            `Critério de pausa foi atingido (ACOS ${acosJanela === Infinity ? '∞' : (acosJanela * 100).toFixed(1) + '%'}, gasto ${R$(diario.gasto)}), mas a campanha tem só ${Math.floor(idadeDias)} dia(s) — abaixo dos ${diasMaturacao} dias mínimos de maturação configurados. Não pausada ainda.`,
            { acos: acosJanela === Infinity ? null : acosJanela * 100, idade_dias: Math.floor(idadeDias) }, 'so_alerta');
        } else if (acosJanela === Infinity) {
          await executarPausa(c.campaign_id, nome,
            `Gastou ${R$(diario.gasto)} em ${diario.diasComGasto} dia(s) nos últimos ${cfg.regra_pausa_dias || 3} dias sem gerar NENHUMA venda atribuída, já madura (${Math.floor(idadeDias)} dias). Pausada pra não continuar queimando orçamento.`,
            { gasto: diario.gasto, gmv: 0, pedidos: 0 });
        } else {
          await executarPausa(c.campaign_id, nome,
            `ACOS de ${(acosJanela * 100).toFixed(1)}% nos últimos ${cfg.regra_pausa_dias || 3} dias, acima do limite de pausa configurado (${cfg.regra_pausa_acos}%), campanha já madura (${Math.floor(idadeDias)} dias). Investimento: ${R$(diario.gasto)}, vendas atribuídas: ${R$(diario.gmv)}.`,
            { acos: acosJanela * 100, gasto: diario.gasto, gmv: diario.gmv });
        }
        continue;
      }

      // Regra 3: ACOS da campanha bem abaixo da meta E a conta como um todo
      // ainda tem folga de TACOS → aumenta orçamento. Sem folga de TACOS, não
      // aumenta automaticamente mesmo com campanha eficiente — a conta como um
      // todo já estaria investindo mais que o saudável em ADS.
      if (cfg.meta_acos && acosJanela !== null && acosJanela !== Infinity && acosJanela * 100 <= cfg.meta_acos * 0.7 && budgetAtual > 0) {
        const tetoOk = !cfg.orcamento_max || budgetAtual < cfg.orcamento_max;
        if (tetoOk && tacosDentroDaMeta) {
          const novoBudget = Math.round(Math.min(cfg.orcamento_max || Infinity, budgetAtual * 1.2) * 100) / 100;
          const variacaoPct = ((novoBudget - budgetAtual) / budgetAtual) * 100;
          const explicacao = `ACOS de ${(acosJanela * 100).toFixed(1)}% está bem abaixo da meta, e o TACOS da conta (${tacosConta.toFixed(1)}%) ainda tem folga em relação à meta (${cfg.meta_acos}%). Orçamento atual ${R$(budgetAtual)}, proposto ${R$(novoBudget)} (+${variacaoPct.toFixed(0)}%).`;
          if (cfg.alerta_variacao_pct && variacaoPct > cfg.alerta_variacao_pct) {
            await logar('alerta', `Sugestão de aumento de orçamento — ${nome}`, explicacao + ' Variação acima do limite configurado pra execução automática — precisa de aprovação manual.', { campaign_id: c.campaign_id, budget_atual: budgetAtual, budget_sugerido: novoBudget, tacos_conta: tacosConta }, 'so_alerta');
            alertas.push(nome);
          } else if (novoBudget > budgetAtual) {
            await executarOrcamento(c.campaign_id, nome, novoBudget, explicacao, { acos: acosJanela * 100, tacos_conta: tacosConta, budget_de: budgetAtual, budget_para: novoBudget });
          }
        } else if (tetoOk && !tacosDentroDaMeta) {
          await logar('sistema', `Aumento represado por TACOS — ${nome}`,
            `ACOS da campanha (${(acosJanela * 100).toFixed(1)}%) sugeriria aumentar orçamento, mas o TACOS da conta (${tacosConta.toFixed(1)}%) já está acima da meta (${cfg.meta_acos}%) — não aumenta orçamento automaticamente enquanto isso não normalizar.`,
            { acos: acosJanela * 100, tacos_conta: tacosConta }, 'so_alerta');
        }
        continue;
      }

      // Regra 4: ACOS acima da meta mas abaixo do limite de pausa → reduz
      // orçamento com moderação (corte é seguro independente do TACOS geral).
      if (cfg.meta_acos && acosJanela !== null && acosJanela !== Infinity && acosJanela * 100 > cfg.meta_acos && budgetAtual > (cfg.orcamento_min || 0) && !emMaturacao) {
        const novoBudget = Math.max(cfg.orcamento_min || 0, Math.round(budgetAtual * 0.85 * 100) / 100);
        if (novoBudget < budgetAtual) {
          const variacaoPct = Math.abs((novoBudget - budgetAtual) / budgetAtual) * 100;
          const explicacao = `ACOS de ${(acosJanela * 100).toFixed(1)}% acima da meta (${cfg.meta_acos}%), mas ainda longe do limite de pausa. Reduzindo orçamento de ${R$(budgetAtual)} pra ${R$(novoBudget)} pra conter o gasto sem desligar a campanha.`;
          if (cfg.alerta_variacao_pct && variacaoPct > cfg.alerta_variacao_pct) {
            await logar('alerta', `Sugestão de corte de orçamento — ${nome}`, explicacao + ' Variação acima do limite configurado pra execução automática — precisa de aprovação manual.', { campaign_id: c.campaign_id, budget_atual: budgetAtual, budget_sugerido: novoBudget }, 'so_alerta');
            alertas.push(nome);
          } else {
            await executarOrcamento(c.campaign_id, nome, novoBudget, explicacao, { acos: acosJanela * 100, budget_de: budgetAtual, budget_para: novoBudget });
          }
        }
      }
    }

    // Resumo de execução do dia (sempre grava, mesmo sem nenhuma ação — é o
    // registro de que o agente rodou e revisou a conta)
    await logar('sistema', `Revisão diária concluída — ${decisoes.length} ação(ões), ${alertas.length} alerta(s)`,
      `Revisadas ${campanhas.length} campanhas da conta. TACOS da conta: ${tacosConta === Infinity ? '∞' : tacosConta.toFixed(1) + '%'} (meta: ${cfg.meta_acos ?? '—'}%). ${decisoes.length} decisão(ões) executada(s) automaticamente, ${alertas.length} alerta(s) aguardando aprovação manual.`,
      { campanhas: campanhas.length, decisoes: decisoes.length, alertas: alertas.length, tacos_conta: tacosConta === Infinity ? null : tacosConta }, 'executado');

    // 2) Relatório diário com IA
    const metricas = { gasto_ontem: gastoTotalOntem, gmv_janela: gmvTotalJanela, gasto_janela: gastoTotalJanela, faturamento_total_loja: faturamentoTotalLoja, tacos_conta: tacosConta === Infinity ? null : tacosConta, acos_janela: gastoTotalJanela > 0 ? (gastoTotalJanela / (gmvTotalJanela || 1)) * 100 : 0, decisoes: decisoes.length, alertas: alertas.length, campanhas_revisadas: campanhas.length };
    const resumo = await gerarRelatorio(anthropicKey, cfg, metricas, decisoes, alertas, ontem);
    await sbInsert('glr_agente_relatorios', { data: ontem.iso, conta_id: shopId, cliente_nome: cfg.cliente_nome || null, resumo, metricas });

    return { conta_id: shopId, campanhas: campanhas.length, decisoes: decisoes.length, alertas: alertas.length, tacos_conta: tacosConta === Infinity ? null : tacosConta };
  } catch (e) {
    await logar('sistema', 'Erro na revisão diária', e.message || String(e), {}, 'erro');
    return { conta_id: shopId, erro: e.message };
  }
}

async function gerarRelatorio(anthropicKey, cfg, metricas, decisoes, alertas, ontem) {
  const base = `Resumo do dia ${ontem.iso} para a conta ${cfg.cliente_nome || cfg.conta_id}: `
    + `investimento em ADS ${R$(metricas.gasto_janela)} na janela avaliada, vendas atribuídas ao ADS ${R$(metricas.gmv_janela)}, faturamento TOTAL da loja no período ${R$(metricas.faturamento_total_loja)}. `
    + `TACOS da conta (investimento ADS ÷ faturamento total): ${metricas.tacos_conta == null ? '∞' : metricas.tacos_conta.toFixed(1) + '%'} (meta: ${cfg.meta_acos || '—'}%) — essa é a métrica principal usada pra decisão, não o ACOS isolado por campanha. `
    + `${metricas.decisoes} ação(ões) executada(s): ${decisoes.join(', ') || 'nenhuma'}. `
    + `${metricas.alertas} alerta(s) aguardando aprovação: ${alertas.join(', ') || 'nenhum'}.`;

  if (!anthropicKey) return base;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        system: 'Você escreve relatórios diários curtos e diretos pra um analista de e-commerce sobre um agente autônomo de ADS na Shopee. Português do Brasil, tom objetivo e prático, sem enrolação. A métrica principal de saúde da conta é o TACOS (investimento ADS sobre faturamento TOTAL da loja), não ACOS isolado por campanha — trate ACOS como detalhe de eficiência de campanha individual, não como veredito sobre a conta. Formato: 1 parágrafo de visão geral, depois bullets pras ações tomadas (se houver) e alertas pendentes (se houver). Nunca invente números — use só os dados fornecidos.',
        messages: [{ role: 'user', content: base }],
      }),
    });
    const json = await r.json();
    return json.content?.[0]?.text || base;
  } catch (e) {
    return base;
  }
}
