// Cron do Agente Autônomo de ADS — roda 1x/dia às 07:00 BRT (vercel.json).
// Para cada conta marcada como piloto (glr_agente_config.ativo=true — pode
// ser 1 ou várias ao mesmo tempo, o loop abaixo já processa todas), avalia as campanhas
// Shopee do dia anterior contra as metas configuradas, executa pausar/retomar/
// ajustar orçamento quando a decisão é clara, registra TUDO em glr_agente_log
// (mesmo quando não age) e fecha com um relatório diário em português gerado
// por IA, salvo em glr_agente_relatorios.
//
// Por que só Shopee: é o único marketplace com execução automática validada
// nesta integração (pausar/retomar/orçamento testados ao vivo). ML/TikTok/
// Amazon ficam de fora da execução autônoma até serem validados do mesmo jeito.
//
// Autenticação Tiops: usa MCP_API_KEY (env var), não glr_storage — o RLS de
// glr_storage foi travado pra "authenticated" nesta mesma sessão (correção de
// segurança), e um cron sem usuário logado não tem esse papel. Reabrir leitura
// anônima só pra essa chave reabriria exatamente o buraco que foi fechado.
//
// Autenticação Supabase: usa a service role (env var SUPABASE_SERVICE_ROLE_KEY),
// não a anon key. Testado ao vivo e confirmado: mesmo com policy/grant corretos
// pro papel "anon", o INSERT falhava com RLS — anomalia real do lado do Postgres,
// não erro de configuração. Mais correto de qualquer forma: o cron roda no
// servidor, sem usuário logado, então não é um "visitante anônimo" — é um
// processo de confiança, e a service role é o papel certo pra isso, ignorando
// RLS. NUNCA usar essa chave em código que roda no navegador.
// Meta de ROAS máxima aceita pela Shopee (tanto pra campanha individual em
// lance automático quanto pra faixa do GMV Max da Loja) — nunca propor um
// valor acima disso.
const SHOPEE_ROAS_TARGET_MAX = 50;

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// Upsert por (data,conta_id) — se o cron rodar 2x no mesmo dia (reteste manual,
// retry), atualiza o relatório existente em vez de quebrar com 409.
async function sbUpsert(table, row, onConflict) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Supabase upsert ${table} falhou: HTTP ${r.status} ${t}`);
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

  const mcApiKey = process.env.MCP_API_KEY;
  if (!mcApiKey) {
    return res.status(200).json({ ok: true, skip: 'MCP_API_KEY não configurada no Vercel — veja Integrações no app pra pegar a chave.' });
  }
  if (!SUPABASE_KEY) {
    return res.status(200).json({ ok: true, skip: 'SUPABASE_SERVICE_ROLE_KEY não configurada no Vercel — pega em Supabase → Project Settings → API → service_role key.' });
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Headers HTTP só aceitam caracteres Latin1 (código <= 255). Um valor colado
  // com caractere "inteligente" (aspas curvas, bullet •, travessão longo etc,
  // comuns em copiar/colar de campos mascarados) quebra o fetch com um erro
  // genérico de ByteString — aqui identificamos QUAL variável tem o problema
  // antes de deixar isso estourar mais na frente.
  for (const [nome, valor] of [
    ['MCP_API_KEY', mcApiKey],
    ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_KEY],
    ['ANTHROPIC_API_KEY', anthropicKey],
  ]) {
    if (!valor) continue;
    for (let i = 0; i < valor.length; i++) {
      const codigo = valor.charCodeAt(i);
      if (codigo > 255) {
        return res.status(200).json({
          ok: true,
          skip: `A variável ${nome} no Vercel tem um caractere inválido na posição ${i} (código ${codigo}, provavelmente um caractere "esperto" de copiar/colar, tipo aspas curvas ou •). Apaga o valor no Vercel e cola de novo com cuidado pra não pegar caractere extra.`,
        });
      }
    }
  }

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

  // Campanha em lance automático (sem orçamento fixo, campaign_budget=0) é
  // controlada por roas_target: quanto MENOR o alvo, mais agressivo o lance
  // (mais gasto/volume); quanto MAIOR, mais conservador (menos gasto). É o
  // inverso do orçamento — por isso as regras de crescer/reduzir invertem o
  // sinal em relação a executarOrcamento.
  async function executarRoasTarget(campaignId, nome, novoRoasTarget, explicacao, dados) {
    try {
      await mcpCall(mcApiKey, 'shopee_ads_roi_target', { shopId, campaign_id: Number(campaignId), roas_target: novoRoasTarget });
      await logar('decisao', `Meta de ROAS ajustada — ${nome}`, explicacao, dados, 'executado');
      decisoes.push(nome);
    } catch (e) {
      await logar('decisao', `Falha ao ajustar meta de ROAS — ${nome}`, `Tentei ajustar por: ${explicacao} — mas deu erro: ${e.message}`, dados, 'erro');
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
        settingsPorId[c.campaign_id] = { ...(c.common_info || {}), roas_target: c.auto_bidding_info?.roas_target ?? null };
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

    // GMV Max da Loja: produto de ADS separado da Shopee (API própria,
    // shopee_ads_gms_*) — NÃO aparece em shopee_ads_campaigns/campaign_settings
    // (confirmado ao vivo: passar o campaign_id dele pra shopee_ads_campaign_settings
    // dá "invalid campaignIDs"). É uma única campanha guarda-chuva por loja, com
    // faixa de meta de ROAS (não um alvo único) e orçamento ilimitado. O gasto dela
    // é investimento ADS de verdade e entra no TACOS da conta, senão o TACOS fica
    // subestimado de novo (mesma classe de bug já corrigida pras campanhas normais).
    // Por enquanto só monitora e alerta — o formato exato de edit_gms_product_campaign
    // (edit_action, faixa de roas) ainda não foi validado ao vivo com segurança,
    // então não executa ajuste automático nela ainda.
    let gmsAtivo = false, gmsGasto = 0, gmsGmv = 0, gmsAcos = null;
    try {
      const gmsPerf = await mcpCall(mcApiKey, 'shopee_ads_gms_performance', { shopId, start_date: inicioJanela.ddmmyyyy, end_date: ontem.ddmmyyyy });
      const rep = gmsPerf.data?.response?.report || gmsPerf.response?.report;
      if (rep) {
        gmsAtivo = true;
        gmsGasto = parseFloat(rep.expense) || 0;
        gmsGmv = parseFloat(rep.broad_gmv) || 0;
        gmsAcos = gmsGmv > 0 ? (gmsGasto / gmsGmv) * 100 : (gmsGasto > 0 ? Infinity : 0);
      }
    } catch (e) { /* loja pode não ter GMV Max ativo — normal, ignora */ }

    let gastoTotalOntem = 0, gmvTotalJanela = gmsGmv, gastoTotalJanela = gmsGasto;
    const diasMaturacao = cfg.dias_maturacao_campanha ?? 7;
    const agoraTs = Date.now() / 1000;

    // Total de campanhas individuais (inclusive as em modo "GMV Max - Meta de
    // ROAS", que é um bidding automático DENTRO de uma campanha individual —
    // diferente do GMV Max da Loja acima) vem de shopee_ads_daily_performance,
    // que é agregado da loja inteira, não da lista de campanhas. Confirmado
    // ao vivo: shopee_ads_campaigns só lista campanhas ad_type=manual e, numa
    // conta real com campanhas ativas em modo GMV Max por produto, devolveu
    // só campanhas antigas encerradas (0 investimento) — enquanto o painel da
    // Shopee mostrava milhares de reais de investimento ativo. Esse endpoint
    // de performance diária não depende dessa lista incompleta.
    try {
      const perfDiario = await mcpCall(mcApiKey, 'shopee_ads_daily_performance', { shopId, start_date: inicioJanela.ddmmyyyy, end_date: ontem.ddmmyyyy });
      const dias = perfDiario.data?.response || perfDiario.response || [];
      for (const d of dias) {
        const gasto = parseFloat(d.expense) || 0;
        const gmv = parseFloat(d.broad_gmv) || 0;
        gastoTotalJanela += gasto;
        gmvTotalJanela += gmv;
        if (d.date === ontem.ddmmyyyy) gastoTotalOntem += gasto;
      }
    } catch (e) { /* sem dados de performance na janela — segue só com GMV Max da Loja */ }

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

      const usaRoasTarget = budgetAtual === 0 && settings.roas_target != null;

      // Regra 3: ACOS da campanha bem abaixo da meta E a conta como um todo
      // ainda tem folga de TACOS → aumenta orçamento (ou baixa a meta de ROAS,
      // pra campanha automática — mesmo espírito, alavanca diferente). Sem
      // folga de TACOS, não aumenta automaticamente mesmo com campanha
      // eficiente — a conta como um todo já estaria investindo mais que o
      // saudável em ADS.
      if (cfg.meta_acos && acosJanela !== null && acosJanela !== Infinity && acosJanela * 100 <= cfg.meta_acos * 0.7 && (budgetAtual > 0 || usaRoasTarget)) {
        if (!tacosDentroDaMeta) {
          await logar('sistema', `Aumento represado por TACOS — ${nome}`,
            `ACOS da campanha (${(acosJanela * 100).toFixed(1)}%) sugeriria acelerar a campanha, mas o TACOS da conta (${tacosConta.toFixed(1)}%) já está acima da meta (${cfg.meta_acos}%) — não aumenta automaticamente enquanto isso não normalizar.`,
            { acos: acosJanela * 100, tacos_conta: tacosConta }, 'so_alerta');
          continue;
        }
        if (usaRoasTarget) {
          // Meta de ROI menor = lance mais agressivo = mais gasto/volume.
          // Nunca desce abaixo da meta de ROI da própria conta (100/meta_acos)
          // nem abaixo de 1.0 (mínimo aceito pela Shopee).
          const metaRoasConta = 100 / cfg.meta_acos;
          const roasAtual = settings.roas_target;
          const novoRoas = Math.round(Math.max(1, metaRoasConta, roasAtual * 0.85) * 10) / 10;
          if (novoRoas < roasAtual) {
            const variacaoPct = Math.abs((novoRoas - roasAtual) / roasAtual) * 100;
            const explicacao = `ACOS de ${(acosJanela * 100).toFixed(1)}% está bem abaixo da meta, e o TACOS da conta (${tacosConta.toFixed(1)}%) ainda tem folga. Campanha usa lance automático — baixando a meta de ROI de ${roasAtual}x pra ${novoRoas}x pra deixar o lance mais agressivo e captar mais volume.`;
            if (cfg.alerta_variacao_pct && variacaoPct > cfg.alerta_variacao_pct) {
              await logar('alerta', `Sugestão de baixar meta de ROI — ${nome}`, explicacao + ' Variação acima do limite configurado pra execução automática — precisa de aprovação manual.', { campaign_id: c.campaign_id, roas_atual: roasAtual, roas_sugerido: novoRoas, tacos_conta: tacosConta }, 'so_alerta');
              alertas.push(nome);
            } else {
              await executarRoasTarget(c.campaign_id, nome, novoRoas, explicacao, { acos: acosJanela * 100, tacos_conta: tacosConta, roas_de: roasAtual, roas_para: novoRoas });
            }
          }
        } else {
          const tetoOk = !cfg.orcamento_max || budgetAtual < cfg.orcamento_max;
          if (tetoOk) {
            const novoBudget = Math.round(Math.min(cfg.orcamento_max || Infinity, budgetAtual * 1.2) * 100) / 100;
            const variacaoPct = ((novoBudget - budgetAtual) / budgetAtual) * 100;
            const explicacao = `ACOS de ${(acosJanela * 100).toFixed(1)}% está bem abaixo da meta, e o TACOS da conta (${tacosConta.toFixed(1)}%) ainda tem folga em relação à meta (${cfg.meta_acos}%). Orçamento atual ${R$(budgetAtual)}, proposto ${R$(novoBudget)} (+${variacaoPct.toFixed(0)}%).`;
            if (cfg.alerta_variacao_pct && variacaoPct > cfg.alerta_variacao_pct) {
              await logar('alerta', `Sugestão de aumento de orçamento — ${nome}`, explicacao + ' Variação acima do limite configurado pra execução automática — precisa de aprovação manual.', { campaign_id: c.campaign_id, budget_atual: budgetAtual, budget_sugerido: novoBudget, tacos_conta: tacosConta }, 'so_alerta');
              alertas.push(nome);
            } else if (novoBudget > budgetAtual) {
              await executarOrcamento(c.campaign_id, nome, novoBudget, explicacao, { acos: acosJanela * 100, tacos_conta: tacosConta, budget_de: budgetAtual, budget_para: novoBudget });
            }
          }
        }
        continue;
      }

      // Regra 4: ACOS acima da meta mas abaixo do limite de pausa → reduz
      // orçamento (ou sobe a meta de ROI, pra campanha automática) com
      // moderação — corte é seguro independente do TACOS geral.
      if (cfg.meta_acos && acosJanela !== null && acosJanela !== Infinity && acosJanela * 100 > cfg.meta_acos && !emMaturacao) {
        if (usaRoasTarget) {
          const roasAtual = settings.roas_target;
          const novoRoas = Math.min(SHOPEE_ROAS_TARGET_MAX, Math.round(roasAtual * 1.15 * 10) / 10);
          const variacaoPct = Math.abs((novoRoas - roasAtual) / roasAtual) * 100;
          const explicacao = `ACOS de ${(acosJanela * 100).toFixed(1)}% acima da meta (${cfg.meta_acos}%), mas ainda longe do limite de pausa. Campanha usa lance automático — subindo a meta de ROI de ${roasAtual}x pra ${novoRoas}x pra deixar o lance mais conservador e conter o gasto sem pausar.`;
          if (cfg.alerta_variacao_pct && variacaoPct > cfg.alerta_variacao_pct) {
            await logar('alerta', `Sugestão de subir meta de ROI — ${nome}`, explicacao + ' Variação acima do limite configurado pra execução automática — precisa de aprovação manual.', { campaign_id: c.campaign_id, roas_atual: roasAtual, roas_sugerido: novoRoas }, 'so_alerta');
            alertas.push(nome);
          } else {
            await executarRoasTarget(c.campaign_id, nome, novoRoas, explicacao, { acos: acosJanela * 100, roas_de: roasAtual, roas_para: novoRoas });
          }
        } else if (budgetAtual > (cfg.orcamento_min || 0)) {
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
    }

    // GMV Max da Loja: sempre registra o desempenho (visibilidade), e alerta
    // (sem executar) quando o ACOS dela foge muito da meta da conta — decisão
    // de ajustar a faixa de ROAS fica manual até validar o endpoint de escrita.
    if (gmsAtivo) {
      const gmsAcosPct = gmsAcos === Infinity ? null : gmsAcos;
      await logar('sistema', `GMV Max da Loja — desempenho do dia`,
        `Investimento ${R$(gmsGasto)}, vendas (GMV) ${R$(gmsGmv)}, ACOS ${gmsAcos === Infinity ? '∞ (gastou sem vender)' : gmsAcos.toFixed(1) + '%'}. Esse gasto já entra no TACOS da conta acima.`,
        { acos: gmsAcosPct, gasto: gmsGasto, gmv: gmsGmv }, 'executado');

      if (cfg.meta_acos && gmsAcos !== null && (gmsAcos === Infinity || gmsAcos * 1 > cfg.meta_acos * 1.3)) {
        await logar('alerta', `GMV Max acima da meta — considerar subir a faixa de ROAS`,
          `ACOS do GMV Max (${gmsAcos === Infinity ? '∞' : gmsAcos.toFixed(1) + '%'}) está bem acima da meta da conta (${cfg.meta_acos}%). O agente ainda não ajusta a faixa de ROAS do GMV Max automaticamente (endpoint de escrita da Shopee pra essa campanha específica ainda não foi validado) — considere subir manualmente a faixa de Meta de ROAS no painel da Shopee (teto aceito: ${SHOPEE_ROAS_TARGET_MAX}x) pra deixar o lance mais conservador.`,
          { acos: gmsAcosPct, gasto: gmsGasto, gmv: gmsGmv }, 'so_alerta');
        alertas.push('GMV Max da Loja');
      } else if (cfg.meta_acos && gmsAcos !== null && gmsAcos * 1 <= cfg.meta_acos * 0.6) {
        await logar('alerta', `GMV Max com folga — considerar baixar a faixa de ROAS`,
          `ACOS do GMV Max (${gmsAcos.toFixed(1)}%) está bem abaixo da meta (${cfg.meta_acos}%), indicando espaço pra ser mais agressivo. O agente ainda não ajusta a faixa de ROAS do GMV Max automaticamente — considere baixar manualmente a faixa de Meta de ROAS no painel da Shopee pra captar mais volume.`,
          { acos: gmsAcosPct, gasto: gmsGasto, gmv: gmsGmv }, 'so_alerta');
        alertas.push('GMV Max da Loja');
      }
    }

    // Resumo de execução do dia (sempre grava, mesmo sem nenhuma ação — é o
    // registro de que o agente rodou e revisou a conta)
    await logar('sistema', `Revisão diária concluída — ${decisoes.length} ação(ões), ${alertas.length} alerta(s)`,
      `Revisadas ${campanhas.length} campanhas da conta. TACOS da conta: ${tacosConta === Infinity ? '∞' : tacosConta.toFixed(1) + '%'} (meta: ${cfg.meta_acos ?? '—'}%). ${decisoes.length} decisão(ões) executada(s) automaticamente, ${alertas.length} alerta(s) aguardando aprovação manual.`,
      { campanhas: campanhas.length, decisoes: decisoes.length, alertas: alertas.length, tacos_conta: tacosConta === Infinity ? null : tacosConta }, 'executado');

    // 2) Relatório diário com IA
    const metricas = { gasto_ontem: gastoTotalOntem, gmv_janela: gmvTotalJanela, gasto_janela: gastoTotalJanela, faturamento_total_loja: faturamentoTotalLoja, tacos_conta: tacosConta === Infinity ? null : tacosConta, acos_janela: gastoTotalJanela > 0 ? (gastoTotalJanela / (gmvTotalJanela || 1)) * 100 : 0, decisoes: decisoes.length, alertas: alertas.length, campanhas_revisadas: campanhas.length, gms_ativo: gmsAtivo, gms_gasto: gmsGasto, gms_gmv: gmsGmv, gms_acos: gmsAcos === Infinity ? null : gmsAcos };
    const resumo = await gerarRelatorio(anthropicKey, cfg, metricas, decisoes, alertas, ontem);
    await sbUpsert('glr_agente_relatorios', { data: ontem.iso, conta_id: shopId, cliente_nome: cfg.cliente_nome || null, resumo, metricas }, 'data,conta_id');

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
    + `${metricas.alertas} alerta(s) aguardando aprovação: ${alertas.join(', ') || 'nenhum'}.`
    + (metricas.gms_ativo ? ` GMV Max da Loja ativo: investimento ${R$(metricas.gms_gasto)}, vendas ${R$(metricas.gms_gmv)}, ACOS ${metricas.gms_acos == null ? '∞' : metricas.gms_acos.toFixed(1) + '%'} (já incluído no TACOS da conta acima; ajuste de faixa de ROAS ainda é manual).` : '');

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
