// ============================================================
// GLR Consultoria — Score de saúde da conta (loja de marketplace)
// ------------------------------------------------------------
// Uma nota de 0 a 100 por loja, a partir de 8 critérios. Tudo vem do que os
// agentes do sincronizador já gravam em glr_sync_estado (nenhuma chamada nova
// ao marketplace) e do resumo diário da BaseDados:
//   qualidade     agente de Qualidade (recurso 'qualidade'): % dos anúncios
//                 analisados sem pendência (nem "ruim" nem "melhorar").
//   ads           TACOS dos últimos 30 dias = ADS ÷ faturamento (BaseDados).
//   preco         agente de Conversão (recurso 'conversao', só ML): % dos
//                 anúncios de catálogo lidos que estão ganhando o Buy Box.
//   margem        agente de Margem (recurso 'sinais'): % dos produtos com custo
//                 cuja margem antes do ADS não está negativa nem apertada.
//   reputacao     agente de Reputação (recurso 'reputacao'): ML termômetro
//                 (vermelho 0 … verde 100); Shopee nota da loja 1–4 → 0–100.
//   semCampanha   oportunidades de ADS (recurso 'oportunidades'): % dos
//                 produtos vendidos em 30 dias que estão FORA do ADS (GMV Max
//                 da loja inteira na Shopee = 0%).
//   semPromocao   agente de Promoções (recurso 'promocoes'): % dos produtos
//                 analisados que NÃO estão em promoção.
//   malAvaliados  ML: % dos anúncios com experiência de compra < 50 (agente de
//                 Qualidade); Shopee: % dos produtos com nota < 4,5 e pelo
//                 menos 5 avaliações (recurso 'funil').
// Cada critério vira nota 0–100 por uma faixa linear: "nota 0 em" e "nota 100
// em" (vale nos dois sentidos — para TACOS, 0 em 20% e 100 em 8%). O score é a
// média ponderada dos critérios que têm dado; critério sem dado fica de fora
// (não conta como zero) e a tela mostra quantos entraram.
// Pesos, faixas e as cores do score ficam em glr_dc_score (GLR_KEYS), editáveis
// pelo botão "Pesos do score" da página Score da operação — iguais para a equipe toda.
// Histórico: um registro por dia em glr_storage, chave glr_score_dia_AAAA-MM-DD =
// { v: 1, em, ids: [critérios], lojas: { 'mkt:conta': [valor bruto de cada critério] } }.
// Guarda o valor bruto (não a nota) para a evolução refazer a nota com os pesos
// atuais. Grava o cron api/score-cron.js (23:50, horário de Brasília) e, se o
// dia ainda não tem registro, a própria página ao abrir.
// ============================================================
const GLRScoreContas = (() => {
  const CRITERIOS = [
    { id: 'qualidade', nome: 'Qualidade de anúncio', peso: 15, zero: 30, cem: 80, ajuda: '% dos anúncios analisados sem pendência' },
    { id: 'ads', nome: 'ADS (TACOS 30 dias)', peso: 15, zero: 20, cem: 8, ajuda: 'ADS ÷ faturamento dos últimos 30 dias' },
    { id: 'preco', nome: 'Preço (Buy Box)', peso: 10, zero: 30, cem: 80, ajuda: '% dos anúncios de catálogo ganhando o Buy Box (só Mercado Livre)' },
    { id: 'margem', nome: 'Margem', peso: 15, zero: 50, cem: 90, ajuda: '% dos produtos com custo cuja margem antes do ADS está acima da mínima' },
    { id: 'reputacao', nome: 'Reputação da loja', peso: 15, zero: 25, cem: 100, ajuda: 'ML: termômetro (vermelho 0 … verde 100); Shopee: nota da loja 1–4 em 0–100' },
    { id: 'semCampanha', nome: 'Produtos sem campanha', peso: 10, zero: 60, cem: 10, ajuda: '% dos produtos vendidos em 30 dias que estão fora do ADS' },
    { id: 'semPromocao', nome: 'Produtos sem promoção', peso: 10, zero: 90, cem: 40, ajuda: '% dos produtos analisados que não estão em promoção' },
    { id: 'malAvaliados', nome: 'Anúncios mal avaliados', peso: 10, zero: 20, cem: 2, ajuda: 'ML: % com experiência de compra abaixo de 50; Shopee: % com nota abaixo de 4,5 (5+ avaliações)' },
  ];
  const FAIXAS_PADRAO = { limites: [50, 75], cores: ['#ef4444', '#facc15', '#22c55e'] };
  const NOTA_RUIM_SHOPEE = 4.5, MIN_AVALIACOES = 5;
  const VALIDADE_MS = 7 * 864e5; // dado de agente mais velho que isto não entra
  const r1 = v => Math.round(v * 10) / 10;
  const n = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };
  const pctDe = (a, b) => b > 0 && a != null ? r1(Math.max(0, Math.min(100, a / b * 100))) : null;
  const hex = c => /^#[0-9a-f]{6}$/i.test(String(c || ''));

  // config salva (glr_dc_score) + padrão para o que faltar ou vier inválido
  function config(salva) {
    const s = salva && typeof salva === 'object' ? salva : {};
    const criterios = {};
    for (const c of CRITERIOS) {
      const x = (s.criterios || {})[c.id] || {};
      const peso = n(x.peso), zero = n(x.zero), cem = n(x.cem);
      criterios[c.id] = {
        peso: peso != null && peso >= 0 ? peso : c.peso,
        zero: zero != null && cem != null && zero !== cem ? zero : c.zero,
        cem: zero != null && cem != null && zero !== cem ? cem : c.cem,
      };
    }
    const f = s.faixas || {};
    const lim = Array.isArray(f.limites) && f.limites.length === 2 && f.limites.every(v => n(v) != null) && +f.limites[0] <= +f.limites[1] ? f.limites.map(Number) : FAIXAS_PADRAO.limites;
    const cores = Array.isArray(f.cores) && f.cores.length === 3 && f.cores.every(hex) ? f.cores : FAIXAS_PADRAO.cores;
    return { criterios, faixas: { limites: lim, cores } };
  }

  // valor bruto de cada critério (null = sem dado) a partir do que os agentes gravaram
  //   d = { mkt, qualidade, promocoes, sinais, conversao (resumos), reputacao (cursor.reputacao),
  //         oport: { vendidos_30d, vendidos_em_ads, gmv_loja }, funil (itens Shopee), ads: { ads, fat } }
  function metricas(d) {
    const m = {}, q = d.qualidade || null;
    m.qualidade = q && q.analisados > 0 ? pctDe(q.analisados - (q.ruins || 0) - (q.melhorar || 0), q.analisados) : null;
    m.ads = d.ads && d.ads.fat > 0 && d.ads.ads != null ? r1(d.ads.ads / d.ads.fat * 100) : null;
    const cv = d.conversao, lidos = cv ? (cv.ganhando || 0) + (cv.perdendo || 0) + (cv.dividindo || 0) : 0;
    m.preco = lidos > 0 ? pctDe(cv.ganhando || 0, lidos) : null;
    const s = d.sinais;
    m.margem = s && s.comCusto > 0 ? pctDe(s.comCusto - (s.negativos || 0) - (s.apertados || 0), s.comCusto) : null;
    const rep = d.reputacao;
    if (d.mkt === 'ml') { const x = n(rep?.nota); m.reputacao = x >= 1 ? r1((Math.min(5, x) - 1) / 4 * 100) : null; }
    else if (d.mkt === 'shopee') { const x = n(rep?.notaLoja); m.reputacao = x >= 1 ? r1((Math.min(4, x) - 1) / 3 * 100) : null; }
    else m.reputacao = null;
    const o = d.oport;
    m.semCampanha = o && o.gmv_loja === true ? 0 : o && o.vendidos_30d > 0 ? pctDe(o.vendidos_30d - (o.vendidos_em_ads || 0), o.vendidos_30d) : null;
    const p = d.promocoes;
    m.semPromocao = p && p.analisados > 0 ? pctDe(p.analisados - (p.emPromo || 0), p.analisados) : null;
    if (d.mkt === 'ml') m.malAvaliados = q && q.analisados > 0 && q.expRuim != null ? pctDe(q.expRuim, q.analisados) : null;
    else if (d.mkt === 'shopee' && d.funil) {
      const av = Object.values(d.funil).filter(x => n(x?.r) != null && (parseInt(x?.nr) || 0) >= MIN_AVALIACOES);
      m.malAvaliados = av.length ? pctDe(av.filter(x => +x.r < NOTA_RUIM_SHOPEE).length, av.length) : null;
    } else m.malAvaliados = null;
    return m;
  }

  // nota 0–100 de um valor na faixa linear zero → cem (serve para "maior é melhor" e "menor é melhor")
  function nota(v, f) {
    if (v == null || !isFinite(v) || f.zero === f.cem) return null;
    const t = (v - f.zero) / (f.cem - f.zero);
    return Math.round(Math.max(0, Math.min(1, t)) * 100);
  }

  // { score, usados, total, itens: [{ id, nome, ajuda, valor, nota, peso }] }
  function calcular(d, cfg) { return deMetricas(metricas(d), cfg); }
  // mesmo cálculo a partir dos valores brutos já medidos (histórico)
  function deMetricas(m, cfg) {
    const c = cfg || config(null);
    let soma = 0, pesos = 0, usados = 0;
    const itens = CRITERIOS.map(k => {
      const f = c.criterios[k.id], nt = nota(m[k.id], f);
      if (nt != null && f.peso > 0) { soma += nt * f.peso; pesos += f.peso; usados++; }
      return { id: k.id, nome: k.nome, ajuda: k.ajuda, valor: m[k.id], nota: nt, peso: f.peso };
    });
    return { score: pesos > 0 ? Math.round(soma / pesos) : null, usados, total: CRITERIOS.length, itens };
  }

  const cor = (score, cfg) => {
    if (score == null) return null;
    const { limites: [a, b], cores } = (cfg || config(null)).faixas;
    return score < a ? cores[0] : score < b ? cores[1] : cores[2];
  };

  // TACOS dos 30 dias completos antes de hoje, se a base cobre o período (mesma regra
  // de BaseDados.cobre/cobreAds). info = { dias, historicoAte, resumoEm, adsHistAte }
  const inicioDiaBRT = iso => new Date(`${iso}T00:00:00-03:00`).getTime() / 1000;
  const diaMenos = (iso, k) => new Date(Date.parse(iso + 'T12:00:00Z') - k * 864e5).toISOString().slice(0, 10);
  const hojeBRT = (agora = Date.now()) => new Date(agora - 3 * 3600e3).toISOString().slice(0, 10);
  function ads30(info, hojeIso) {
    const ini = diaMenos(hojeIso, 30), fim = diaMenos(hojeIso, 1), t0 = inicioDiaBRT(ini);
    if (!info || !info.resumoEm || !info.historicoAte || info.historicoAte > t0 || !info.adsHistAte || info.adsHistAte > t0) return null;
    let ads = 0, fat = 0;
    for (const [dia, v] of Object.entries(info.dias || {})) if (dia >= ini && dia <= fim) { ads += parseFloat(v?.ads) || 0; fat += parseFloat(v?.faturamento) || 0; }
    return { ads, fat };
  }

  // linhas de glr_sync_estado por recurso → { 'mkt:conta': dados dos agentes }
  //   rows = { qualidade, promocoes, sinais, conversao, reputacao, oportunidades, funil }
  function mapaAgentes(rows, agora = Date.now()) {
    const mapa = {}, valido = r => r.ultimo_sucesso && agora - new Date(r.ultimo_sucesso).getTime() < VALIDADE_MS;
    const por = (lista, campo, fn) => { for (const r of lista || []) if (valido(r)) { const k = `${r.marketplace}:${r.conta_id}`; (mapa[k] = mapa[k] || { mkt: r.marketplace })[campo] = fn(r); } };
    por(rows.qualidade, 'qualidade', r => r.resumo); por(rows.promocoes, 'promocoes', r => r.resumo); por(rows.sinais, 'sinais', r => r.resumo);
    por(rows.conversao, 'conversao', r => r.resumo); por(rows.reputacao, 'reputacao', r => r.rep);
    por(rows.oportunidades, 'oport', r => ({ vendidos_30d: r.vendidos_30d, vendidos_em_ads: r.vendidos_em_ads, gmv_loja: r.gmv_loja }));
    por(rows.funil, 'funil', r => r.itens);
    return mapa;
  }
  // o que cada recurso precisa ler (colunas no formato do select do Supabase/PostgREST)
  const LEITURAS = {
    qualidade: 'resumo:cursor->resumo', promocoes: 'resumo:cursor->resumo', sinais: 'resumo:cursor->resumo',
    conversao: 'resumo:cursor->resumo', reputacao: 'rep:cursor->reputacao',
    oportunidades: 'vendidos_30d:cursor->vendidos_30d,vendidos_em_ads:cursor->vendidos_em_ads,gmv_loja:cursor->gmv_loja',
    funil: 'itens:cursor->itens',
  };

  // registro do dia: valores brutos de cada loja ML/Shopee
  //   agentes = mapaAgentes(...), base = { 'mkt:conta': info da BaseDados }
  function registroDoDia(agentes, base, hojeIso, agora = Date.now()) {
    const lojas = {};
    const chaves = new Set([...Object.keys(agentes || {}), ...Object.keys(base || {})]);
    for (const k of chaves) {
      const mkt = k.split(':')[0]; if (mkt !== 'ml' && mkt !== 'shopee') continue;
      const m = metricas({ ...((agentes || {})[k] || {}), mkt, ads: ads30((base || {})[k], hojeIso) });
      const vals = CRITERIOS.map(c => m[c.id] ?? null);
      if (vals.some(v => v != null)) lojas[k] = vals;
    }
    return { v: 1, em: new Date(agora).toISOString(), ids: CRITERIOS.map(c => c.id), lojas };
  }
  // valores brutos de uma loja num registro → { criterio: valor }
  function metricasDoRegistro(reg, chave) {
    const vals = reg?.lojas?.[chave]; if (!Array.isArray(vals)) return null;
    const ids = reg.ids || CRITERIOS.map(c => c.id), m = {};
    ids.forEach((id, i) => { m[id] = vals[i] == null ? null : +vals[i]; });
    return m;
  }
  const CHAVE_DIA = 'glr_score_dia_';

  // ── leitura (navegador): o que os agentes gravaram, por loja "mkt:conta" ──
  let cache = null, cacheEm = 0, emAndamento = null;
  async function carregar(forcar) {
    if (!forcar && cache && Date.now() - cacheEm < 5 * 60e3) return cache;
    if (emAndamento) return emAndamento;
    const ler = (recurso, campos, filtro) => {
      let q = _sb.from('glr_sync_estado').select(`marketplace,conta_id,ultimo_sucesso,${campos}`).eq('recurso', recurso);
      if (filtro) q = q.eq('marketplace', filtro);
      return q.then(r => (r.error ? [] : r.data || []));
    };
    emAndamento = (async () => {
      const ids = Object.keys(LEITURAS);
      const listas = await Promise.all(ids.map(id => ler(id, LEITURAS[id], id === 'funil' ? 'shopee' : null)));
      const rows = {}; ids.forEach((id, i) => { rows[id] = listas[i]; });
      cache = mapaAgentes(rows); cacheEm = Date.now();
      return cache;
    })().finally(() => { emAndamento = null; });
    return emAndamento;
  }

  // histórico (navegador): registros de deIso até ateIso → { 'AAAA-MM-DD': registro }
  async function historico(deIso, ateIso) {
    const r = await _sb.from('glr_storage').select('chave,dados').gte('chave', CHAVE_DIA + deIso).lte('chave', CHAVE_DIA + ateIso);
    if (r.error) throw r.error;
    const out = {};
    for (const x of r.data || []) if (x.dados && x.dados.lojas) out[x.chave.slice(CHAVE_DIA.length)] = x.dados;
    return out;
  }
  // grava o registro de hoje se ainda não existe (o cron da noite atualiza depois)
  async function gravarHojeSeFaltar(base) {
    const hoje = hojeBRT(), chave = CHAVE_DIA + hoje;
    const ja = await _sb.from('glr_storage').select('chave').eq('chave', chave).maybeSingle();
    if (ja.error || ja.data) return null;
    const reg = registroDoDia(await carregar(), base, hoje);
    if (!Object.keys(reg.lojas).length) return null;
    const w = await _sb.from('glr_storage').upsert({ chave, dados: reg, atualizado_em: new Date().toISOString() }, { onConflict: 'chave', ignoreDuplicates: true });
    return w.error ? null : reg;
  }

  return { CRITERIOS, FAIXAS_PADRAO, LEITURAS, CHAVE_DIA, config, metricas, nota, calcular, deMetricas, cor, ads30, hojeBRT, diaMenos, mapaAgentes, registroDoDia, metricasDoRegistro, carregar, historico, gravarHojeSeFaltar };
})();
if (typeof window !== 'undefined') window.GLRScoreContas = GLRScoreContas;
if (typeof module !== 'undefined') module.exports = GLRScoreContas;
