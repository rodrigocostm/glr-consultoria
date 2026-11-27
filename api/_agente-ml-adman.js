// ============================================================
// GLR Consultoria — Agente de ADS AUTÔNOMO do Mercado Livre (via Adman)
// ------------------------------------------------------------
// Igual ao agente da Shopee: analisa as campanhas todo dia e AGE SOZINHO,
// sem pedir aprovação a cada mudança, mas só dentro dos LIMITES abaixo.
// Tudo que ele faz (ou faria, em simulação) vai para glr_agente_log com o
// motivo, o valor antes e o valor depois.
//
// Liga/desliga e modo ficam na tabela glr_ads_autonomo (uma linha por conta):
//   ligado=false            → não faz nada (chave de desligar)
//   modo='simulacao'        → só registra o que faria (padrão)
//   modo='execucao'         → aplica no Mercado Livre pela Adman
// Chave geral de emergência: env ADS_AUTONOMO_DESLIGADO=1 desliga para todas.
//
// O QUE ELE PODE FAZER (e nada além disso):
//   1. Pausar ANÚNCIO (grupo de anúncios) que gastou e não vendeu nada
//   2. Pausar CAMPANHA inteira que gastou e não vendeu nada
//   3. Subir o ROAS alvo (apertar) de campanha com ACOS acima do alvo
//   4. Baixar o ROAS alvo (soltar) de campanha muito abaixo do alvo e
//      perdendo exposição por ranking, com a conta dentro da meta
//   5. Subir orçamento de campanha que perde exposição por falta de verba
//      e está dentro do alvo
//   6. Baixar orçamento de campanha muito acima do alvo que já está no
//      ROAS máximo (não dá para apertar mais pelo ROAS)
// O QUE ELE NUNCA FAZ: criar campanha, reativar campanha/anúncio pausado,
// mover anúncio de campanha, mexer em campanha pausada/eliminada, mudar
// regra de anúncio, aceitar ou rejeitar alertas da Adman.
//
// Arquivo com "_" na frente: não vira rota na Vercel; usado por agente-cron.js.
// ============================================================

const LIMITES_PADRAO = {
  // gerais
  max_acoes_dia: 6,             // ações por conta por dia (somando tudo)
  max_pausas_dia: 3,            // pausas (anúncio + campanha) por conta por dia
  espera_dias: 3,               // mesma campanha/anúncio só mexe de novo depois disso
  // orçamento diário
  orcamento_var_max_pct: 20,    // no máximo ±20% por dia por campanha
  orcamento_min: 10,            // nunca abaixo de R$ 10/dia
  orcamento_teto_conta: 1000,   // soma dos orçamentos das campanhas ativas nunca passa disso (R$/dia)
  perda_verba_min_pct: 10,      // só sobe verba se perde ≥10% das impressões por orçamento
  // ROAS alvo
  roas_subir_max_pct: 20,       // apertar: no máximo +20% por vez
  roas_descer_max_pct: 10,      // soltar: no máximo −10% por vez
  roas_min: 4,                  // nunca abaixo (ACOS alvo de 25%)
  roas_max: 35,                 // nunca acima
  roas_piso_meta_fator: 1.5,    // soltar nunca leva o ACOS alvo acima de meta da conta × 1,5
  // gatilhos de campanha (janela de 7 dias)
  janela_campanha_dias: 7,
  gasto_min_campanha: 70,       // precisa ter gastado isso na janela para mexer em ROAS/orçamento
  vendas_min_campanha: 3,       // e vendido pelo menos isso
  apertar_se_acos_acima: 1.3,   // ACOS > alvo × 1,3 → apertar
  soltar_se_acos_abaixo: 0.7,   // ACOS < alvo × 0,7 → pode soltar
  perda_ranking_min_pct: 50,    // ...e só se perde ≥50% por ranking
  cortar_verba_se_acos_acima: 2, // ACOS > alvo × 2 com ROAS já no máximo → corta verba
  // pausas (janela de 14 dias, zero venda)
  janela_pausa_dias: 14,
  pausa_anuncio_gasto_min: 50,  // anúncio: gastou ≥ R$ 50 ...
  pausa_anuncio_cliques_min: 80, // ... com ≥ 80 cliques e 0 venda em 14 dias
  pausa_campanha_gasto_min: 100, // campanha: gastou ≥ R$ 100 e 0 venda em 14 dias
  idade_min_campanha_dias: 14,  // campanha nova não é pausada antes disso
  // datas em que o agente só observa (AAAA-MM-DD), ex. pico de Black Friday
  datas_congeladas: [],
};

const num = v => (v && typeof v === 'object' && 'value' in v ? Number(v.value) : Number(v)) || 0;
const r2 = v => Math.round(v * 100) / 100;
const R$ = v => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = v => `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
const isoMenos = (iso, d) => new Date(Date.parse(`${iso}T12:00:00Z`) - d * 864e5).toISOString().slice(0, 10);

function limitesDe(cfg) { return { ...LIMITES_PADRAO, ...(cfg?.limites || {}) }; }

// ACOS alvo da campanha: o que o ML usa (100 / ROAS alvo)
function alvoAcos(c) {
  if (num(c.targetAcos) > 0) return num(c.targetAcos);
  if (num(c.roasTarget) > 0) return 100 / num(c.roasTarget);
  return null;
}

// ------------------------------------------------------------
// decidir: função pura. Recebe os números já lidos e devolve a lista de ações.
//   dados = { hoje, metaAcos, conta7: {tacos, acos}, campanhas: [{ id, nome, status,
//             criadaEm, m7: <métricas Adman 7d>, m14: <métricas 14d> }],
//             anuncios14: [<adgroup Adman 14d>] }
//   historico = [{ entidade, criado_em, resultado }] ações já executadas (para espera)
// ------------------------------------------------------------
function decidir(dados, cfg = {}, historico = []) {
  const L = limitesDe(cfg);
  const hoje = dados.hoje;
  const acoes = [], ignoradas = [];
  if ((L.datas_congeladas || []).includes(hoje)) return { acoes, ignoradas: [{ motivo: `dia ${hoje} está na lista de datas congeladas: só observa` }], limites: L };

  const metaAcos = Number(dados.metaAcos) || null;
  const tacosConta = dados.conta7 ? num(dados.conta7.tacos) : null;
  const contaNaMeta = metaAcos != null && tacosConta != null && tacosConta <= metaAcos;
  const emEspera = ent => historico.some(h => h.entidade === ent && h.resultado === 'executado' && (Date.parse(`${hoje}T12:00:00Z`) - Date.parse(h.criado_em)) / 864e5 < L.espera_dias);
  const ativas = (dados.campanhas || []).filter(c => String(c.status).toLowerCase() === 'active');
  const somaOrc = ativas.reduce((s, c) => s + num(c.m7?.dailyBudget), 0);
  const tocadas = new Set();

  // 1+2. Pausas (anúncio primeiro: não aperta a campanha inteira por 1 produto ruim)
  for (const a of dados.anuncios14 || []) {
    if (String(a.status).toUpperCase() !== 'ACTIVE') continue;
    const camp = ativas.find(c => c.id === a.campaignId);
    if (!camp) continue; // anúncio em campanha pausada/eliminada: não mexe
    const m = a.metrics || {};
    const gasto = num(m.investment), vendas = num(m.unitsQuantity), receita = num(m.totalAmount), cliques = num(m.clicks);
    if (vendas > 0 || receita > 0 || gasto < L.pausa_anuncio_gasto_min || cliques < L.pausa_anuncio_cliques_min) continue;
    const ent = `adgroup:${a.adgroupId}`;
    if (emEspera(ent)) { ignoradas.push({ entidade: ent, motivo: 'mexido há menos de ' + L.espera_dias + ' dias' }); continue; }
    acoes.push({
      acao: 'pausar_anuncio', entidade: ent, adgroup_id: String(a.adgroupId), campaign_id: a.campaignId, campanha: camp.nome, nome: a.name,
      antes: 'ativo', depois: 'pausado', prioridade: 1, pausa: true,
      motivo: `Gastou ${R$(gasto)} em ${L.janela_pausa_dias} dias, com ${cliques} cliques e nenhuma venda (limite: ${R$(L.pausa_anuncio_gasto_min)} e ${L.pausa_anuncio_cliques_min} cliques sem venda).${a.adGroupType === 'FAMILY' ? ' É uma família: pausa todas as variações juntas.' : ''}`,
      metricas: { gasto, cliques, vendas, receita },
    });
  }
  for (const c of ativas) {
    const m = c.m14 || {};
    const gasto = num(m.investment), vendas = num(m.soldQuantity), receita = num(m.revenue);
    const idade = c.criadaEm ? (Date.parse(`${hoje}T12:00:00Z`) - Date.parse(c.criadaEm)) / 864e5 : Infinity;
    if (vendas > 0 || receita > 0 || gasto < L.pausa_campanha_gasto_min) continue;
    if (idade < L.idade_min_campanha_dias) { ignoradas.push({ entidade: `campanha:${c.id}`, motivo: `campanha com ${Math.floor(idade)} dias: ainda amadurecendo` }); continue; }
    const ent = `campanha:${c.id}`;
    if (emEspera(ent)) { ignoradas.push({ entidade: ent, motivo: 'mexida há menos de ' + L.espera_dias + ' dias' }); continue; }
    // se os anúncios dela já vão ser pausados, a campanha para sozinha
    acoes.push({
      acao: 'pausar_campanha', entidade: ent, campaign_id: c.id, campanha: c.nome, antes: 'ativa', depois: 'pausada', prioridade: 2, pausa: true,
      motivo: `Gastou ${R$(gasto)} em ${L.janela_pausa_dias} dias sem nenhuma venda (limite: ${R$(L.pausa_campanha_gasto_min)}).`,
      metricas: { gasto, vendas, receita },
    });
    tocadas.add(c.id);
  }

  // 3-6. Ajustes de campanha (uma ação por campanha por dia)
  let orcExtra = 0;
  for (const c of ativas) {
    if (tocadas.has(c.id)) continue;
    const m = c.m7 || {};
    const ent = `campanha:${c.id}`;
    const alvo = alvoAcos(m);
    const acos = num(m.acos), gasto = num(m.investment), vendas = num(m.soldQuantity);
    const roas = num(m.roasTarget), orc = num(m.dailyBudget);
    const perdaVerba = num(m.lostImpressionShareByBudget), perdaRank = num(m.lostImpressionShareByAdRank);
    if (!alvo || !roas) { ignoradas.push({ entidade: ent, motivo: 'campanha sem ROAS alvo (estratégia sem alvo): não mexe' }); continue; }
    if (gasto < L.gasto_min_campanha || vendas < L.vendas_min_campanha) { ignoradas.push({ entidade: ent, motivo: `poucos dados em ${L.janela_campanha_dias} dias (${R$(gasto)}, ${vendas} vendas)` }); continue; }
    if (emEspera(ent)) { ignoradas.push({ entidade: ent, motivo: 'mexida há menos de ' + L.espera_dias + ' dias' }); continue; }
    const base = { entidade: ent, campaign_id: c.id, campanha: c.nome, metricas: { acos, alvo: r2(alvo), gasto, vendas, roas_alvo: roas, orcamento: orc, perda_verba: perdaVerba, perda_ranking: perdaRank, tacos_conta: tacosConta } };

    // 3. apertar ROAS
    if (acos > alvo * L.apertar_se_acos_acima) {
      if (roas < L.roas_max) {
        const precisa = acos / alvo - 1;
        const novo = r2(Math.min(L.roas_max, roas * (1 + Math.min(L.roas_subir_max_pct / 100, precisa))));
        acoes.push({ ...base, acao: 'subir_roas', antes: roas, depois: novo, prioridade: 3,
          motivo: `ACOS de ${pct(acos)} em ${L.janela_campanha_dias} dias, acima do alvo de ${pct(r2(alvo))} (gatilho: ${String(L.apertar_se_acos_acima).replace(".", ",")}× o alvo). Aperto o ROAS alvo de ${roas} para ${novo} (máx. +${L.roas_subir_max_pct}% por vez).` });
      } else if (acos > alvo * L.cortar_verba_se_acos_acima && orc > L.orcamento_min) {
        // 6. ROAS já no máximo: corta verba
        const novo = r2(Math.max(L.orcamento_min, orc * (1 - L.orcamento_var_max_pct / 100)));
        acoes.push({ ...base, acao: 'baixar_orcamento', antes: orc, depois: novo, prioridade: 4,
          motivo: `ACOS de ${pct(acos)}, mais que o dobro do alvo (${pct(r2(alvo))}), e o ROAS alvo já está no máximo (${L.roas_max}). Corto o orçamento de ${R$(orc)} para ${R$(novo)}/dia (−${L.orcamento_var_max_pct}%).` });
      }
      continue;
    }
    // 5. subir verba (perde por orçamento e está no alvo)
    if (perdaVerba >= L.perda_verba_min_pct && acos <= alvo) {
      if (!contaNaMeta) { ignoradas.push({ entidade: ent, motivo: `subiria verba, mas o TACOS da conta (${tacosConta ?? '—'}%) está acima da meta (${metaAcos ?? '—'}%)` }); continue; }
      const novo = r2(orc * (1 + L.orcamento_var_max_pct / 100));
      if (somaOrc + orcExtra + (novo - orc) > L.orcamento_teto_conta) { ignoradas.push({ entidade: ent, motivo: `subiria verba, mas passaria do teto da conta (${R$(L.orcamento_teto_conta)}/dia)` }); continue; }
      orcExtra += novo - orc;
      acoes.push({ ...base, acao: 'subir_orcamento', antes: orc, depois: novo, prioridade: 5,
        motivo: `Perde ${pct(perdaVerba)} das impressões por falta de orçamento com ACOS de ${pct(acos)} (alvo ${pct(r2(alvo))}). Subo de ${R$(orc)} para ${R$(novo)}/dia (+${L.orcamento_var_max_pct}%).` });
      continue;
    }
    // 4. soltar ROAS (ganhar exposição)
    if (acos < alvo * L.soltar_se_acos_abaixo && perdaRank >= L.perda_ranking_min_pct) {
      if (!contaNaMeta) { ignoradas.push({ entidade: ent, motivo: `soltaria o ROAS, mas o TACOS da conta (${tacosConta ?? '—'}%) está acima da meta (${metaAcos ?? '—'}%)` }); continue; }
      const piso = Math.max(L.roas_min, metaAcos ? 100 / (metaAcos * L.roas_piso_meta_fator) : L.roas_min);
      const novo = r2(Math.max(piso, roas * (1 - L.roas_descer_max_pct / 100)));
      if (novo >= roas) { ignoradas.push({ entidade: ent, motivo: `soltaria o ROAS, mas ${roas} já está no piso (${r2(piso)})` }); continue; }
      acoes.push({ ...base, acao: 'baixar_roas', antes: roas, depois: novo, prioridade: 6,
        motivo: `ACOS de ${pct(acos)}, bem abaixo do alvo de ${pct(r2(alvo))}, e perde ${pct(perdaRank)} das impressões por ranking, com a conta dentro da meta (TACOS ${pct(tacosConta)} ≤ ${pct(metaAcos)}). Solto o ROAS alvo de ${roas} para ${novo} para ganhar exposição (máx. −${L.roas_descer_max_pct}%).` });
    }
  }

  // limites do dia
  acoes.sort((a, b) => a.prioridade - b.prioridade);
  const feitasHoje = historico.filter(h => h.resultado === 'executado' && String(h.criado_em).slice(0, 10) === hoje);
  let total = feitasHoje.length, pausas = feitasHoje.filter(h => h.pausa).length;
  const finais = [];
  for (const a of acoes) {
    if (total >= L.max_acoes_dia) { ignoradas.push({ entidade: a.entidade, motivo: `limite de ${L.max_acoes_dia} ações por dia`, acao: a.acao }); continue; }
    if (a.pausa && pausas >= L.max_pausas_dia) { ignoradas.push({ entidade: a.entidade, motivo: `limite de ${L.max_pausas_dia} pausas por dia`, acao: a.acao }); continue; }
    finais.push(a); total++; if (a.pausa) pausas++;
  }
  return { acoes: finais, ignoradas, limites: L };
}

// ------------------------------------------------------------
// Coleta (lê tudo pela Adman)
// ------------------------------------------------------------
async function coletar(adman, custId, hoje, L = LIMITES_PADRAO) {
  const ontem = isoMenos(hoje, 1);
  const de7 = isoMenos(ontem, L.janela_campanha_dias - 1), de14 = isoMenos(ontem, L.janela_pausa_dias - 1);
  const lista = await adman.chamar('get_campaigns', { marketplace: 'meli', custId: String(custId) });
  const campanhas = [];
  for (const c of lista.campaigns || []) {
    const x = { id: c.campaignId, nome: String(c.name || '').trim(), status: c.status };
    if (String(c.status).toLowerCase() === 'active') {
      x.m7 = await adman.chamar('get_campaign_metrics', { marketplace: 'meli', custId: String(custId), campaignId: c.campaignId, dateFrom: de7, dateTo: ontem });
      x.m14 = await adman.chamar('get_campaign_metrics', { marketplace: 'meli', custId: String(custId), campaignId: c.campaignId, dateFrom: de14, dateTo: ontem });
      x.criadaEm = x.m7?.createdAt || null;
    }
    campanhas.push(x);
  }
  const anuncios14 = [];
  for (let page = 1; page <= 20; page++) {
    const r = await adman.chamar('get_adgroups_metrics', { marketplace: 'meli', custId: String(custId), dateFrom: de14, dateTo: ontem, itemsPerPage: 49, page });
    anuncios14.push(...(r.adgroups || []));
    if (!r.totalPages || page >= r.totalPages) break;
  }
  const conta = await adman.chamar('get_account_metrics', { marketplace: 'meli', custId: String(custId), dateFrom: de7, dateTo: ontem });
  return { hoje, periodo7: [de7, ontem], periodo14: [de14, ontem], campanhas, anuncios14, conta7: conta.metrics || conta };
}

// Aplica uma ação na Adman (só em modo execução)
async function aplicar(adman, custId, a) {
  const b = { marketplace: 'meli', custId: String(custId) };
  if (a.acao === 'pausar_anuncio') return adman.chamar('update_adgroup_status', { ...b, adgroupId: a.adgroup_id, body: { status: 'paused' } });
  if (a.acao === 'pausar_campanha') return adman.chamar('update_campaign_status', { ...b, campaignId: a.campaign_id, body: { status: 'paused' } });
  if (a.acao === 'subir_roas' || a.acao === 'baixar_roas') return adman.chamar('update_campaign_roas', { ...b, campaignId: a.campaign_id, limitRoas: a.depois });
  if (a.acao === 'subir_orcamento' || a.acao === 'baixar_orcamento') return adman.chamar('update_campaign_budget', { ...b, campaignId: a.campaign_id, body: { budget: a.depois } });
  throw new Error(`ação desconhecida: ${a.acao}`); // nunca deveria chegar aqui
}

const TITULO = {
  pausar_anuncio: a => `Pausar anúncio — ${a.nome}`,
  pausar_campanha: a => `Pausar campanha — ${a.campanha}`,
  subir_roas: a => `Apertar ROAS alvo ${a.antes} → ${a.depois} — ${a.campanha}`,
  baixar_roas: a => `Soltar ROAS alvo ${a.antes} → ${a.depois} — ${a.campanha}`,
  subir_orcamento: a => `Subir orçamento ${R$(a.antes)} → ${R$(a.depois)} — ${a.campanha}`,
  baixar_orcamento: a => `Baixar orçamento ${R$(a.antes)} → ${R$(a.depois)} — ${a.campanha}`,
};

// ------------------------------------------------------------
// Rodada de uma conta: lê config, coleta, decide, aplica (ou simula) e registra
//   h = { sbSelect, sbInsert, adman, hoje }
// ------------------------------------------------------------
async function rodadaConta(cfg, h, opc = {}) {
  const custId = cfg.adman_cust_id || cfg.conta_id;
  if (process.env.ADS_AUTONOMO_DESLIGADO === '1') return { conta_id: cfg.conta_id, skip: 'chave geral ADS_AUTONOMO_DESLIGADO=1' };
  if (!cfg.ligado) return { conta_id: cfg.conta_id, skip: 'agente desligado para esta conta' };
  const executar = cfg.modo === 'execucao' && !opc.simular;
  const L = limitesDe(cfg);
  const dados = await coletar(h.adman, custId, h.hoje, L);
  const desde = new Date(Date.parse(`${h.hoje}T00:00:00-03:00`) - (L.espera_dias + 1) * 864e5).toISOString();
  const hist = (await h.sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(cfg.conta_id)}&origem=eq.adman&criado_em=gte.${encodeURIComponent(desde)}&select=criado_em,resultado,dados&limit=500`).catch(() => []))
    .map(l => ({ criado_em: l.criado_em, resultado: l.resultado, entidade: l.dados?.entidade, pausa: !!l.dados?.pausa }));
  const { acoes, ignoradas } = decidir({ ...dados, metaAcos: cfg.meta_acos }, cfg, hist);
  const saida = [];
  for (const a of acoes) {
    let resultado = executar ? 'executado' : 'simulado', erro = null;
    if (executar) {
      try { await aplicar(h.adman, custId, a); } catch (e) { resultado = 'erro'; erro = String(e.message || e).slice(0, 400); }
    }
    const linha = {
      conta_id: cfg.conta_id, cliente_nome: cfg.cliente_nome || null, tipo: 'decisao',
      titulo: (resultado === 'simulado' ? '[Simulação] ' : '') + TITULO[a.acao](a),
      explicacao: a.motivo + (erro ? ` Falhou: ${erro}` : ''),
      dados: { marketplace: 'ml', fonte: 'adman', modo: executar ? 'execucao' : 'simulacao', acao: a.acao, entidade: a.entidade, pausa: !!a.pausa,
        campaign_id: a.campaign_id, adgroup_id: a.adgroup_id || null, campanha: a.campanha, anuncio: a.nome || null,
        antes: a.antes, depois: a.depois, metricas: a.metricas, periodo7: dados.periodo7, periodo14: dados.periodo14, erro },
      resultado, origem: 'adman',
    };
    if (!opc.semRegistro) await h.sbInsert('glr_agente_log', linha).catch(e => console.warn('[adman] log:', e.message));
    saida.push({ ...a, resultado, erro });
  }
  return { conta_id: cfg.conta_id, modo: executar ? 'execucao' : 'simulacao', acoes: saida, ignoradas, tacos_conta_7d: num(dados.conta7?.tacos), acos_conta_7d: num(dados.conta7?.acos), periodo7: dados.periodo7 };
}

module.exports = { LIMITES_PADRAO, limitesDe, decidir, coletar, aplicar, rodadaConta, alvoAcos };
