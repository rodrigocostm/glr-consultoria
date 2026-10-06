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
// Meta de ROAS máxima aceita pela Shopee pra campanha individual em lance
// automático — nunca propor um valor acima disso.
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
  // raw_read (e outras ações "cruas") costuma devolver HTTP 200 com o erro
  // real só no campo json.error, sem json.status — confirmado ao vivo que
  // isso fazia a paginação de campanhas parar sempre em exatamente 100
  // (tratava erro real como "acabaram as campanhas", nunca chegava nas
  // campanhas ongoing de verdade que ficam depois da página 1).
  if (!r.ok || (json.status && json.status !== 200) || (json.error && String(json.error).trim())) {
    throw new Error(json.error || json.message || `Erro na ação ${action}`);
  }
  return json;
}

// Converte um timestamp unix (segundos) pro formato "AAAA-MM-DD HH:MM:SS" em
// horário de Brasília — é o formato que shopee_sales_summary espera no
// end_date quando a gente continua uma busca parcial (campo continuar_de).
function brtDatetimeDe(unixSegundos) {
  const d = new Date(unixSegundos * 1000 - 3 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Faturamento de um período/status, com paginação de verdade. Confirmado ao
// vivo: numa loja de volume médio, um período de só 27 dias já veio com
// parcial=true (800 de 1229 pedidos somados) — usar só o 1º total_revenue
// sem continuar a paginação SUBESTIMA o faturamento real, o que é crítico
// porque TACOS e Saúde do Negócio se baseiam nesse número. Continua
// chamando com end_date=continuar_de até parcial=false, somando cada
// total_revenue (janelas disjuntas, nunca conta o mesmo pedido 2x).
async function shopeeFaturamentoPeriodo(apiKey, shopId, startDate, endDate, orderStatus) {
  let total = 0;
  let end = endDate;
  for (let i = 0; i < 40; i++) { // teto de segurança
    // A falha aqui NÃO é sempre um erro de rede — confirmado ao vivo que às
    // vezes a chamada "funciona" (sem lançar exceção) mas devolve uma
    // resposta sem total_orders, como se não tivesse pedido nenhum, quando
    // na verdade tem centenas. Trata resposta sem total_orders como falha
    // e tenta de novo (até 3 tentativas no total).
    let r, ultimoErro;
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      try {
        r = await mcpCall(apiKey, 'shopee_sales_summary', { shopId, start_date: startDate, end_date: end, order_status: orderStatus });
        const dd = r.data || r || {};
        if (dd.total_orders != null) break;
        ultimoErro = new Error('resposta sem total_orders (provável falha silenciosa da API)');
        r = null;
      } catch (e) {
        ultimoErro = e;
        r = null;
      }
    }
    if (!r) throw ultimoErro || new Error(`Não consegui buscar ${orderStatus} depois de 3 tentativas`);
    total += parseFloat(r.data?.total_revenue ?? r.total_revenue) || 0;
    const parcial = r.data?.parcial ?? r.parcial;
    const continuarDe = r.data?.continuar_de ?? r.continuar_de;
    if (!parcial || !continuarDe) break;
    end = brtDatetimeDe(continuarDe);
  }
  return total;
}

// Lista TODAS as campanhas individuais de uma loja. Até 29/09/2026,
// "shopee_ads_campaigns" só devolvia a primeira leva (~100) e a gente tinha
// que complementar via raw_read paginado à mão — instável ("Falha ao
// renovar token Meli", causa raiz: o backend do conector roteava errado
// quando o campo marketplace vinha vazio em alguns casos). O Tiops corrigiu
// dos dois lados: shopee_ads_campaigns agora pagina sozinha e devolve a
// loja inteira numa chamada só (confirmado ao vivo: conta com 205
// campanhas, has_next_page:false, total:205). Não precisa mais de
// complemento nenhum.
async function listarTodasCampanhas(apiKey, shopId) {
  const base = await mcpCall(apiKey, 'shopee_ads_campaigns', { shopId });
  return base.data?.response?.campaign_list || base.response?.campaign_list || [];
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
    // ?conta_id=X — disparo manual pra 1 conta só ("Rodar agente agora" no
    // painel), roda mesmo que o piloto esteja desligado (o analista decidiu
    // rodar agora, não precisa estar em modo automático pra isso). Sem esse
    // parâmetro, comportamento normal do cron: todas as contas ativo=true.
    const contaIdFiltro = req.query?.conta_id;
    const configs = contaIdFiltro
      ? await sbSelect('glr_agente_config', `conta_id=eq.${encodeURIComponent(contaIdFiltro)}`)
      : await sbSelect('glr_agente_config', 'ativo=eq.true');
    if (!configs.length) {
      return res.status(200).json({ ok: true, skip: contaIdFiltro ? `conta ${contaIdFiltro} não tem configuração salva` : 'nenhuma conta piloto ativa em glr_agente_config' });
    }

    const ontem = dataBRT(1);

    // Contas em paralelo — sequencial estourava os 60s do plano com mais de
    // 1 conta ativa (cada conta já faz vários round-trips pra Tiops).
    const resultados = await Promise.all(configs.map(cfg => {
      const inicioJanela = dataBRT(Math.max(1, cfg.regra_pausa_dias || 3));
      return processarConta(cfg, mcApiKey, anthropicKey, ontem, inicioJanela);
    }));
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

  // As 3 funções de execução gravam o campaign_id junto dos dados da decisão
  // — a tela usa isso pra ligar cada decisão à linha da campanha (antes só
  // tinha o nome no título). Só acrescenta informação ao log.
  async function executarPausa(campaignId, nome, explicacao, dadosBase) {
    const dados = { campaign_id: Number(campaignId), ...dadosBase };
    try {
      await mcpCall(mcApiKey, 'shopee_ads_pause_campaign', { shopId, campaign_id: Number(campaignId) });
      await logar('decisao', `Campanha pausada — ${nome}`, explicacao, dados, 'executado');
      decisoes.push(nome);
    } catch (e) {
      await logar('decisao', `Falha ao pausar — ${nome}`, `Tentei pausar por: ${explicacao} — mas deu erro: ${e.message}`, dados, 'erro');
    }
  }

  async function executarOrcamento(campaignId, nome, novoBudget, explicacao, dadosBase) {
    const dados = { campaign_id: Number(campaignId), ...dadosBase };
    try {
      // shopee_ads_edit_campaign é passthrough cru pra edit_manual_product_ads
      // — confirmado ao vivo que exige params.edit_action="change_budget",
      // params.budget (não campaign_budget) e um params.reference_id único.
      // Sem isso a Shopee rejeita com "Invalid param type" / "EditAction is
      // required" — essa função vinha falhando silenciosamente (cai no catch,
      // loga 'erro') toda vez que a Regra 3/4 tentava ajustar orçamento.
      await mcpCall(mcApiKey, 'shopee_ads_edit_campaign', {
        shopId,
        params: {
          campaign_id: Number(campaignId),
          budget: novoBudget,
          edit_action: 'change_budget',
          reference_id: `glr-agente-${Date.now()}-${campaignId}`,
        },
      });
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
  async function executarRoasTarget(campaignId, nome, novoRoasTarget, explicacao, dadosBase) {
    const dados = { campaign_id: Number(campaignId), ...dadosBase };
    try {
      await mcpCall(mcApiKey, 'shopee_ads_roi_target', { shopId, campaign_id: Number(campaignId), roas_target: novoRoasTarget });
      await logar('decisao', `Meta de ROAS ajustada — ${nome}`, explicacao, dados, 'executado');
      decisoes.push(nome);
    } catch (e) {
      await logar('decisao', `Falha ao ajustar meta de ROAS — ${nome}`, `Tentei ajustar por: ${explicacao} — mas deu erro: ${e.message}`, dados, 'erro');
    }
  }

  try {
    // 1) Lista campanhas (só id/ad_type — nome vem do settings mais abaixo)
    const campanhas = await listarTodasCampanhas(mcApiKey, shopId);
    if (!campanhas.length) {
      await logar('sistema', 'Nenhuma campanha encontrada', 'Conta não tem campanhas de ADS ativas na Shopee — nada pra avaliar hoje.', {}, 'so_alerta');
      return { conta_id: shopId, campanhas: 0 };
    }

    const settingsPorId = {};
    const diarioPorId = {}; // soma da janela (regra_pausa_dias) por campanha

    // Etapa 1: settings de TODAS as campanhas listadas — é o único jeito de
    // saber o status (ongoing/closed/ended) de cada uma antes de decidir o
    // que mais buscar. Em paralelo por lote de 20.
    await Promise.all(chunk(campanhas.map(c => c.campaign_id), 20).map(async (lote) => {
      const settingsResp = await mcpCall(mcApiKey, 'shopee_ads_campaign_settings', { shopId, campaign_id_list: lote.join(',') }).catch(() => null);
      (settingsResp?.data?.response?.campaign_list || settingsResp?.response?.campaign_list || []).forEach(c => {
        settingsPorId[c.campaign_id] = { ...(c.common_info || {}), roas_target: c.auto_bidding_info?.roas_target ?? null };
      });
    }));

    // Etapa 2: performance diária só das campanhas 'ongoing' — contas
    // grandes (200+) têm a maioria das campanhas closed/ended (histórico de
    // anos), e buscar performance dessas é trabalho jogado fora. Confirmado
    // ao vivo: era isso que estourava os 60s do plano na Vercel mesmo em
    // conta pequena (settings+daily pra TODAS, em vez de só ongoing).
    const idsOngoing = campanhas.map(c => c.campaign_id).filter(id => (settingsPorId[id]?.campaign_status || '').toLowerCase() === 'ongoing');
    await Promise.all(chunk(idsOngoing, 20).map(async (lote) => {
      const diarioResp = await mcpCall(mcApiKey, 'shopee_ads_campaign_daily', { shopId, campaign_id_list: lote.join(','), start_date: inicioJanela.ddmmyyyy, end_date: ontem.ddmmyyyy }).catch(() => null);
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
    }));

    // Faturamento TOTAL da loja na mesma janela (não só o atribuído ao ADS) —
    // é a base do TACOS. Mesmos status usados no resto do app (shopeeFaturamento
    // em marketplace-api.js): COMPLETED + READY_TO_SHIP + PROCESSED + SHIPPED +
    // CANCELLED. Bruto de propósito (inclui CANCELLED): é o que bate com o
    // "Gestor Seller" (ferramenta terceira que a GLR usa de referência) —
    // confirmado ao vivo que excluir CANCELLED deixava o número ~40% menor
    // que a referência real da conta.
    // Sequencial, NUNCA em paralelo — confirmado ao vivo que disparar as chamadas
    // de status ao mesmo tempo faz o conector devolver dado incompleto pra
    // algumas delas (sem erro, só um total_revenue menor). Mais lento, mas o
    // único jeito confirmado de pegar o valor certo.
    let faturamentoTotalLoja = 0;
    for (const st of ['COMPLETED', 'READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'CANCELLED']) {
      try {
        faturamentoTotalLoja += await shopeeFaturamentoPeriodo(mcApiKey, shopId, inicioJanela.iso, ontem.iso, st);
      } catch (e) {}
    }

    // Escopo do agente é só campanhas individuais (inclusive as em modo
    // "GMV Max - Meta de ROAS", que é um bidding automático DENTRO de uma
    // campanha individual — bem diferente do GMV Max da Loja, que é uma
    // campanha guarda-chuva separada por conta inteira). GMV Max da Loja foi
    // tirado do escopo por decisão do usuário: como o formato de escrita
    // (edit_gms_product_campaign) nunca foi validado com segurança, o agente
    // nunca conseguia agir nele mesmo — só gerava alerta que ninguém ia
    // resolver. Total vem de shopee_ads_daily_performance (agregado da loja
    // inteira), não da lista de campanhas — confirmado ao vivo: a lista de
    // campanhas às vezes devolve só campanhas antigas encerradas enquanto o
    // painel da Shopee mostra investimento ativo real.
    let gastoTotalOntem = 0, gmvTotalJanela = 0, gastoTotalJanela = 0;
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
    } catch (e) { /* sem dados de performance na janela — segue com 0 */ }

    const diasMaturacao = cfg.dias_maturacao_campanha ?? 7;
    const agoraTs = Date.now() / 1000;

    // TACOS da conta = investimento total em ADS ÷ faturamento TOTAL da loja
    // (não só a venda atribuída ao ADS) — é o critério principal, do jeito que
    // a GLR se baseia pra decisão, não ACOS isolado por campanha (esse mede
    // eficiência daquela campanha específica, útil pra comparar campanhas
    // entre si, mas não pra dizer se a conta como um todo está saudável).
    const tacosConta = faturamentoTotalLoja > 0 ? (gastoTotalJanela / faturamentoTotalLoja) * 100 : (gastoTotalJanela > 0 ? Infinity : 0);
    const tacosDentroDaMeta = !cfg.meta_acos || tacosConta <= cfg.meta_acos * 1.1; // 10% de folga antes de travar aumento de orçamento

    // Conta quantas das campanhas listadas estão realmente 'ongoing' — a
    // listagem bruta (campanhas.length) mistura campanhas ativas com anos de
    // histórico morto (closed/ended), então "campanhas revisadas" mostrando
    // o total bruto é enganoso (confirmado ao vivo: conta com só ~11 ongoing
    // reais, mas listagem bruta de 100+ campanhas antigas). Mostra só a
    // contagem de ativas de verdade pro usuário.
    let campanhasAtivas = 0;
    for (const c of campanhas) {
      const settings = settingsPorId[c.campaign_id];
      const diario = diarioPorId[c.campaign_id];
      if (!settings || !diario) continue;
      const status = (settings.campaign_status || '').toLowerCase();
      const budgetAtual = parseFloat(settings.campaign_budget) || 0;
      if (status !== 'ongoing') continue;
      campanhasAtivas++;

      const acosJanela = diario.gmv > 0 ? diario.gasto / diario.gmv : (diario.gasto > 0 ? Infinity : null);
      const nome = settings.ad_name?.slice(0, 70) || `Campanha ${c.campaign_id}`;
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

      // Campanha de lance automático tem DUAS alavancas ao mesmo tempo: orçamento
      // diário (teto de gasto) e meta de ROAS (agressividade do lance). Antes só
      // mexia no ROAS quando o orçamento era 0, então nas campanhas reais (que
      // têm os dois) o ROAS nunca era ajustado. Agora escolhe a alavanca pela
      // estratégia: pra acelerar, se o orçamento já está sendo consumido (>=80%)
      // ele é o gargalo e sobe; senão subir orçamento não muda nada e o certo é
      // baixar a meta de ROAS. Pra conter gasto, aperta a meta de ROAS primeiro
      // (corta lance caro sem tirar a campanha do ar) e só corta orçamento se o
      // ROAS já estiver no teto da Shopee.
      const temRoas = settings.roas_target != null && settings.roas_target > 0;
      const gastoMedioDia = diario.gasto / Math.max(1, diario.diasComGasto || 1);
      const orcamentoSaturado = budgetAtual > 0 && gastoMedioDia >= budgetAtual * 0.8;
      const tetoOrcamentoAtingido = !!cfg.orcamento_max && budgetAtual >= cfg.orcamento_max;
      const usarRoasAcelerar = temRoas && (budgetAtual === 0 || !orcamentoSaturado || tetoOrcamentoAtingido);
      const usarRoasConter = temRoas && settings.roas_target < SHOPEE_ROAS_TARGET_MAX;

      // Regra 3: ACOS da campanha bem abaixo da meta E a conta como um todo
      // ainda tem folga de TACOS → aumenta orçamento (ou baixa a meta de ROAS,
      // pra campanha automática — mesmo espírito, alavanca diferente). Sem
      // folga de TACOS, não aumenta automaticamente mesmo com campanha
      // eficiente — a conta como um todo já estaria investindo mais que o
      // saudável em ADS.
      if (cfg.meta_acos && acosJanela !== null && acosJanela !== Infinity && acosJanela * 100 <= cfg.meta_acos * 0.7 && (budgetAtual > 0 || temRoas)) {
        if (!tacosDentroDaMeta) {
          await logar('sistema', `Aumento represado por TACOS — ${nome}`,
            `ACOS da campanha (${(acosJanela * 100).toFixed(1)}%) sugeriria acelerar a campanha, mas o TACOS da conta (${tacosConta.toFixed(1)}%) já está acima da meta (${cfg.meta_acos}%) — não aumenta automaticamente enquanto isso não normalizar.`,
            { acos: acosJanela * 100, tacos_conta: tacosConta }, 'so_alerta');
          continue;
        }
        if (usarRoasAcelerar) {
          // Meta de ROI menor = lance mais agressivo = mais gasto/volume.
          // Nunca desce abaixo da meta de ROI da própria conta (100/meta_acos)
          // nem abaixo de 1.0 (mínimo aceito pela Shopee).
          const metaRoasConta = 100 / cfg.meta_acos;
          const roasAtual = settings.roas_target;
          const novoRoas = Math.round(Math.max(1, metaRoasConta, roasAtual * 0.85) * 10) / 10;
          if (novoRoas < roasAtual) {
            const variacaoPct = Math.abs((novoRoas - roasAtual) / roasAtual) * 100;
            const explicacao = `ACOS de ${(acosJanela * 100).toFixed(1)}% está bem abaixo da meta, e o TACOS da conta (${tacosConta.toFixed(1)}%) ainda tem folga. ${budgetAtual > 0 && !orcamentoSaturado ? `O orçamento diário (${R$(budgetAtual)}) não está sendo consumido por completo (média de ${R$(gastoMedioDia)}/dia), então subir orçamento não ajudaria — o limitador é o lance.` : 'Campanha usa lance automático.'} Baixando a meta de ROI de ${roasAtual}x pra ${novoRoas}x pra deixar o lance mais agressivo e captar mais volume.`;
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
        if (usarRoasConter) {
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

    // Regra 5 — saúde do negócio: as Regras 1-4 acima só reagem ao ACOS de
    // cada campanha isolada. Pedido explícito do analista: "se a conta está
    // em queda, precisa fazer alguma coisa pra avaliar melhora" — sem
    // depender dele perguntar no chat toda vez. Compara faturamento total da
    // loja dos últimos 7 dias vs os 7 dias anteriores (mesma janela que o
    // card "Saúde do negócio" usa) e, se caiu de forma relevante (≥15%),
    // sugere reforçar a campanha ativa mais eficiente (menor ACOS) — sempre
    // como alerta pendente de aprovação, nunca executa sozinho. Quando a
    // conta está em crescimento ou estável, não faz nada aqui: a Regra 3
    // já acelera sozinha (sem esperar pergunta) qualquer campanha com ACOS
    // bem abaixo da meta, que é o "acelerar ainda mais" que crescimento pede.
    try {
      // Zero chamadas novas à Shopee de propósito — as 2 primeiras versões
      // desta regra buscavam faturamento de novo (10 chamadas, depois 6),
      // e mesmo a versão "leve" ainda estourava os 60s do plano na Vercel
      // (confirmado ao vivo, timeout em doce festa — conta pequena, então
      // não era sobre volume de campanha, era sobre chamada extra nenhuma).
      // faturamentoTotalLoja (acima) já é o faturamento da janela atual
      // (inicioJanela..ontem) — compara com o mesmo campo já salvo no
      // relatório de exatamente 1 janela atrás (glr_agente_relatorios),
      // puramente uma leitura no Supabase, sem custo de API externa.
      const diasJanela = Math.max(1, cfg.regra_pausa_dias || 3);
      const dataRelatorioAnterior = dataBRT(1 + diasJanela).iso;
      const relatorioAnterior = await sbSelect('glr_agente_relatorios', `conta_id=eq.${encodeURIComponent(shopId)}&data=eq.${dataRelatorioAnterior}&select=metricas&limit=1`).catch(() => []);
      const faturamentoSaudeAnterior = relatorioAnterior[0]?.metricas?.faturamento_total_loja;
      const variacaoSaude = faturamentoSaudeAnterior > 0 ? ((faturamentoTotalLoja - faturamentoSaudeAnterior) / faturamentoSaudeAnterior) * 100 : null;

      // Evita empilhar o mesmo alerta toda vez que o agente roda (cron diário
      // + cliques manuais no mesmo dia) — só sugere de novo se a pendência
      // anterior já foi resolvida (aprovada/descartada).
      const jaTemAlertaPendente = (await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(shopId)}&titulo=like.*Queda%20de%20faturamento*&resultado=eq.so_alerta&select=id&limit=1`).catch(() => [])).length > 0;

      if (!jaTemAlertaPendente && variacaoSaude != null && variacaoSaude <= -15) {
        let melhor = null;
        for (const c of campanhas) {
          const settings = settingsPorId[c.campaign_id], diario = diarioPorId[c.campaign_id];
          if (!settings || !diario) continue;
          if ((settings.campaign_status || '').toLowerCase() !== 'ongoing') continue;
          const acosC = diario.gmv > 0 ? (diario.gasto / diario.gmv) * 100 : (diario.gasto > 0 ? Infinity : null);
          if (acosC == null || acosC === Infinity) continue;
          if (!melhor || acosC < melhor.acos) melhor = { id: c.campaign_id, nome: (settings.ad_name || `Campanha ${c.campaign_id}`).slice(0, 70), acos: acosC, budget: parseFloat(settings.campaign_budget) || 0, roasTarget: settings.roas_target };
        }
        if (melhor) {
          const usaRoas = melhor.budget === 0 && melhor.roasTarget != null;
          const dadosSug = { campaign_id: melhor.id };
          let titulo = null, explicacao = '';
          if (usaRoas) {
            const metaRoasConta = 100 / (cfg.meta_acos || 8);
            const novoRoas = Math.round(Math.max(1, metaRoasConta, melhor.roasTarget * 0.85) * 10) / 10;
            if (novoRoas < melhor.roasTarget) {
              dadosSug.roas_atual = melhor.roasTarget; dadosSug.roas_sugerido = novoRoas;
              titulo = `Queda de faturamento — reforçar ${melhor.nome}`;
              explicacao = `Faturamento total da loja caiu ${Math.abs(variacaoSaude).toFixed(1)}% na janela de ${diasJanela} dia(s) vs a janela anterior equivalente (${R$(faturamentoTotalLoja)} vs ${R$(faturamentoSaudeAnterior)}). "${melhor.nome}" é a campanha ativa mais eficiente (ACOS ${melhor.acos.toFixed(1)}%) — baixando meta de ROAS de ${melhor.roasTarget}x pra ${novoRoas}x pra tentar puxar mais volume e ajudar a reverter a queda.`;
            }
          } else if (melhor.budget > 0) {
            const novoBudget = Math.round(Math.min(cfg.orcamento_max || Infinity, melhor.budget * 1.2) * 100) / 100;
            if (novoBudget > melhor.budget) {
              dadosSug.budget_atual = melhor.budget; dadosSug.budget_sugerido = novoBudget;
              titulo = `Queda de faturamento — reforçar ${melhor.nome}`;
              explicacao = `Faturamento total da loja caiu ${Math.abs(variacaoSaude).toFixed(1)}% na janela de ${diasJanela} dia(s) vs a janela anterior equivalente (${R$(faturamentoTotalLoja)} vs ${R$(faturamentoSaudeAnterior)}). "${melhor.nome}" é a campanha ativa mais eficiente (ACOS ${melhor.acos.toFixed(1)}%) — subindo orçamento de ${R$(melhor.budget)} pra ${R$(novoBudget)} pra tentar puxar mais volume e ajudar a reverter a queda.`;
            }
          }
          if (titulo) {
            await logar('alerta', titulo, explicacao, dadosSug, 'so_alerta');
            alertas.push(titulo);
          }
        }
      }
    } catch (e) { /* saúde do negócio é bônus — não derruba a revisão diária se falhar */ }

    // Resumo de execução do dia (sempre grava, mesmo sem nenhuma ação — é o
    // registro de que o agente rodou e revisou a conta)
    await logar('sistema', `Revisão diária concluída — ${decisoes.length} ação(ões), ${alertas.length} alerta(s)`,
      `Revisadas ${campanhasAtivas} campanhas ativas (de ${campanhas.length} listadas, incluindo histórico antigo). TACOS da conta: ${tacosConta === Infinity ? '∞' : tacosConta.toFixed(1) + '%'} (meta: ${cfg.meta_acos ?? '—'}%). ${decisoes.length} decisão(ões) executada(s) automaticamente, ${alertas.length} alerta(s) aguardando aprovação manual.`,
      { campanhas: campanhasAtivas, campanhas_listadas: campanhas.length, decisoes: decisoes.length, alertas: alertas.length, tacos_conta: tacosConta === Infinity ? null : tacosConta }, 'executado');

    // 2) Relatório diário com IA
    const metricas = { gasto_ontem: gastoTotalOntem, gmv_janela: gmvTotalJanela, gasto_janela: gastoTotalJanela, faturamento_total_loja: faturamentoTotalLoja, tacos_conta: tacosConta === Infinity ? null : tacosConta, acos_janela: gastoTotalJanela > 0 ? (gastoTotalJanela / (gmvTotalJanela || 1)) * 100 : 0, decisoes: decisoes.length, alertas: alertas.length, campanhas_revisadas: campanhasAtivas, campanhas_listadas: campanhas.length };
    const resumo = await gerarRelatorio(anthropicKey, cfg, metricas, decisoes, alertas, ontem);
    await sbUpsert('glr_agente_relatorios', { data: ontem.iso, conta_id: shopId, cliente_nome: cfg.cliente_nome || null, resumo, metricas }, 'data,conta_id');

    return { conta_id: shopId, campanhas: campanhasAtivas, campanhas_listadas: campanhas.length, decisoes: decisoes.length, alertas: alertas.length, tacos_conta: tacosConta === Infinity ? null : tacosConta };
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
