// Cron do Agente Autônomo de ADS — rodadas automáticas várias vezes por dia
// (agenda em api/_agenda-agente.js, disparadas por api/sync-dados.js a cada
// 15 min; a cron da Vercel ficou como reserva da revisão completa):
//   07:00  revisão completa do dia anterior (regras 1-5 + relatório com IA)
//   12/16/20h acompanhamento do dia em andamento (processarAcompanhamento)
// Números de faturamento/ADS vêm da base sincronizada (glr_sync_estado resumo,
// mesmo motor das telas) quando ela cobre o período — antes eram 5 consultas
// lentas e sequenciais à API por conta. Sem cobertura, cai na API como antes.
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

const { waitUntil } = require('@vercel/functions');
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;
const { agoraBRT } = require('./_agenda-agente');
const consumo = require('./_consumo');
// Agente do Mercado Livre (copiloto) — código separado do da Shopee
const { processarContaML } = require('./_agente-ml');
// Curva ABC semana a semana (mesma regra da aba Vendas) — alertas diários dos agentes
const curvaABC = require('./_curva-abc');
// Medição de resultado (7 dias antes × 7 dias depois) — mesma régua do ML
const medicaoAds = require('./_medicao-ads');
// Mural dos agentes de Estoque e de Margem (calculado pelo sincronizador)
const estoqueMargem = require('./_estoque-margem');
// Gerente de Conta: plano do dia por cliente (rodada 'gerente', 08:00)
const gerente = require('./_gerente');
async function lerSinais(mkt, conta) {
  const rows = await sbSelect('glr_sync_estado', `marketplace=eq.${mkt}&conta_id=eq.${encodeURIComponent(conta)}&recurso=in.(sinais,promocoes,reputacao,qualidade)&select=recurso,cursor`).catch(() => []);
  const c = rows.find(r => r.recurso === 'sinais')?.cursor;
  if (!c || Date.now() - (c.em || 0) > 12 * 3600 * 1000) return null; // aviso velho não decide nada
  // Agente de Promoções: produto em promoção usa a margem NO PREÇO DA PROMOÇÃO (menor)
  const pr = rows.find(r => r.recurso === 'promocoes')?.cursor;
  if (pr && Date.now() - (pr.em || 0) < 36 * 3600 * 1000) {
    for (const [id, x] of Object.entries(pr.itens || {})) {
      const it = c.itens?.[id], ep = x.emPromo;
      if (!it || !ep || ep.aa == null) continue;
      if (it.aa == null || ep.aa < it.aa) { it.aa = ep.aa; it.m = ep.m; it.nm = ep.m <= 0 ? 'negativa' : ep.aa < 3 ? 'apertada' : 'ok'; }
      it.pr = { tipo: ep.tipo, preco: ep.preco, fim: ep.fim || null };
    }
  }
  // Agente de Reputação: conta em risco e produtos com reclamação/devolução repetida
  const rp = rows.find(r => r.recurso === 'reputacao')?.cursor;
  if (rp && Date.now() - (rp.em || 0) < 24 * 3600 * 1000) {
    c.reputacao = { risco: rp.risco || null, motivo: rp.riscoMotivo || '' };
    c.itens = c.itens || {};
    for (const [id, x] of Object.entries(rp.itens || {})) { c.itens[id] = c.itens[id] || { n: x.produto || id, vd: 0 }; c.itens[id].rp = x.motivo; }
  }
  // Agente de Qualidade: anúncio que não converte / experiência ruim / pausado pelo ML
  const qa = rows.find(r => r.recurso === 'qualidade')?.cursor;
  if (qa && Date.now() - (qa.em || 0) < 4 * 86400000) {
    for (const [id, x] of Object.entries(qa.itens || {})) if (x.qa && c.itens?.[id]) c.itens[id].qa = x.qa;
  }
  return c;
}
const ehML = cfg => String(cfg.marketplace || '').toLowerCase() === 'ml';

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

// Atualiza linhas existentes (PATCH) — usado pelo agente do ML para marcar
// sugestão aplicada (detectada pela leitura das campanhas) e gravar a medição.
async function sbUpdate(table, qs, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Supabase update ${table} falhou: HTTP ${r.status} ${t}`);
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
  consumo.contar(action);
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
const gravarConsumo = () => consumo.gravar(sbSelect, (t, rows, oc) => sbUpsert(t, rows, oc), 'agentes');

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

// ── Base sincronizada (motor de dados, a cada 15 min) ──────────────────────
const inicioDiaUnix = iso => Math.floor(new Date(`${iso}T00:00:00-03:00`).getTime() / 1000);
const isoMenos = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const mktDe = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : null; };
async function lerBase(mkt, contaId) {
  const rows = await sbSelect('glr_sync_estado', `marketplace=eq.${mkt}&conta_id=eq.${encodeURIComponent(contaId)}&select=recurso,cursor,ultimo_sucesso`).catch(() => []);
  const por = Object.fromEntries(rows.map(r => [r.recurso, r]));
  const ok = !!(por.resumo?.ultimo_sucesso && por.pedidos?.ultimo_sucesso);
  return {
    dias: por.resumo?.cursor?.dias || {},
    pedidosDesde: ok ? por.pedidos?.cursor?.historico_ate || null : null,
    adsDesde: ok && por.ads?.ultimo_sucesso ? por.ads?.cursor?.hist_ate || null : null,
    // GMV Max da Loja à parte (já está DENTRO do total diário de ADS — só separa)
    gmvMax: por.ads?.cursor?.versao === 2 ? por.ads?.cursor?.gmv_max || {} : {},
    gmvMaxVendas: por.ads?.cursor?.versao === 2 ? por.ads?.cursor?.gmv_max_vendas || {} : {},
  };
}
const baseCobre = (b, iso) => !!(b?.pedidosDesde && b.pedidosDesde <= inicioDiaUnix(iso));
const baseCobreAds = (b, iso) => !!(b?.adsDesde && b.adsDesde <= inicioDiaUnix(iso));
function somarBase(b, de, ate) {
  const t = { pedidos: 0, faturamento: 0, unidades: 0, valor_cancelado: 0, valor_devolvido: 0, ads: 0, ads_gmv: 0 };
  for (const [dia, v] of Object.entries(b?.dias || {})) {
    if (dia < de || dia > ate) continue;
    for (const c of Object.keys(t)) t[c] += parseFloat(v[c]) || 0;
  }
  t.bruto = t.faturamento + t.valor_cancelado + t.valor_devolvido; // com cancelados — só referência; o TACOS usa t.faturamento (sem cancelados)
  return t;
}
const variacao = (a, b) => b > 0 ? ((a - b) / b) * 100 : null;
async function sbCount(table, qs) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}&select=pedido_id&limit=1`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'count=exact' },
  });
  if (!r.ok) throw new Error(`Supabase count ${table}: HTTP ${r.status}`);
  return parseInt(String(r.headers.get('content-range') || '').split('/')[1]) || 0;
}
async function lerStorage(chave) {
  return (await sbSelect('glr_storage', `chave=eq.${chave}&select=dados`).catch(() => []))[0]?.dados;
}

// Contexto de negócio que só a base dá: o cliente inteiro (todas as lojas,
// Shopee + ML) e os produtos que mais caíram/subiram — 7 dias vs 7 anteriores.
async function contextoNegocio(shopId, ontemIso) {
  const ctx = {};
  const de7 = isoMenos(ontemIso, 6), de14 = isoMenos(ontemIso, 13), ate14 = isoMenos(ontemIso, 7);
  try {
    const vinc = (await lerStorage('glr_mc_vinculos')) || {};
    const clientes = (await lerStorage('glr_clientes')) || [];
    const contas = (await lerStorage('glr_mc_contas')) || [];
    const nomes = {};
    for (const c of (Array.isArray(contas) ? contas : [])) {
      const tag = (c.tags || []).find(t => t && typeof t === 'object' && t.name);
      if (tag) nomes[String(c.external_id)] = String(tag.name).replace(/\s*[-–]\s*(shopee|ml|mercado livre)\s*$/i, '').trim();
    }
    for (const [cid, lista] of Object.entries(vinc)) {
      if (!(lista || []).some(c => String(c.external_id) === String(shopId))) continue;
      const lojas = [];
      for (const c of lista) {
        const mkt = mktDe(c.marketplace);
        if (!mkt) continue;
        const b = await lerBase(mkt, String(c.external_id));
        if (!baseCobre(b, de14)) continue;
        const a = somarBase(b, de7, ontemIso), p = somarBase(b, de14, ate14);
        lojas.push({ loja: nomes[String(c.external_id)] || c.nickname || c.external_id, mkt, fat7: a.faturamento, fatAnt: p.faturamento, var: variacao(a.faturamento, p.faturamento), ads7: a.ads });
      }
      if (lojas.length) {
        const f7 = lojas.reduce((s, l) => s + l.fat7, 0), fa = lojas.reduce((s, l) => s + l.fatAnt, 0);
        ctx.cliente = { nome: (Array.isArray(clientes) ? clientes : []).find(x => String(x.id) === String(cid))?.nome || null, lojas, fat7: f7, fatAnt: fa, var: variacao(f7, fa) };
      }
      break;
    }
  } catch (e) { /* contexto é bônus */ }
  try {
    const desde = new Date(`${de14}T00:00:00-03:00`).toISOString();
    const limite7 = new Date(`${de7}T00:00:00-03:00`).getTime();
    const ate = new Date(new Date(`${ontemIso}T00:00:00-03:00`).getTime() + 86400000).toISOString();
    const mapa = new Map();
    for (let off = 0; off < 30000; off += 1000) {
      const rows = await sbSelect('glr_pedidos', `marketplace=eq.shopee&conta_id=eq.${encodeURIComponent(shopId)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(desde)}&criado_em=lt.${encodeURIComponent(ate)}&select=criado_em,itens&limit=1000&offset=${off}`);
      for (const r of rows) {
        const lado = new Date(r.criado_em).getTime() >= limite7 ? 'a' : 'p';
        for (const it of (r.itens || [])) {
          const k = String(it.item_id || it.sku || it.nome);
          const acc = mapa.get(k) || { nome: String(it.nome || k).slice(0, 60), a: 0, p: 0 };
          acc[lado] += (parseFloat(it.preco) || 0) * (parseInt(it.qtd) || 1);
          mapa.set(k, acc);
        }
      }
      if (rows.length < 1000) break;
    }
    const lista = [...mapa.values()];
    const total = lista.reduce((s, x) => s + x.a, 0);
    let acum = 0;
    const curvaA = new Set();
    for (const x of [...lista].sort((m, n) => n.a - m.a)) { acum += x.a; curvaA.add(x.nome); if (total && acum / total >= 0.8) break; }
    ctx.quedas = lista.filter(x => x.p - x.a > 0).sort((m, n) => (n.p - n.a) - (m.p - m.a)).slice(0, 3).map(x => ({ ...x, curvaA: curvaA.has(x.nome) }));
    ctx.altas = lista.filter(x => x.a - x.p > 0).sort((m, n) => (n.a - n.p) - (m.a - m.p)).slice(0, 3);
  } catch (e) { /* idem */ }
  return ctx;
}

// O agente do ML recebe o teto de ADS do cliente junto com a configuração da conta
const comTetoML = async cfg => ({ ...cfg, teto_tacos: (await contratoDaConta(cfg.conta_id).catch(() => ({}))).tetoTacos || null });

// Ferramentas compartilhadas que o agente do ML (api/_agente-ml.js) usa.
function ajudantesML() {
  return { sbSelect, sbInsert, sbUpdate, sbUpsert, lerSinais, lerBase, baseCobre, baseCobreAds, somarBase, isoMenos, dataBRT, R$, mcpCall, Anthropic, anthropicKey: process.env.ANTHROPIC_API_KEY };
}

// Trava de rodada agendada: a mesma rodada (dia + horário) roda uma vez só,
// mesmo que o disparo chegue duas vezes (agendador do Supabase + reserva da Vercel).
async function reservarRodada(slot) {
  const rows = await sbSelect('glr_sync_estado', 'marketplace=eq.sistema&conta_id=eq.agente&recurso=eq.agenda&select=cursor').catch(() => []);
  const feitas = { ...(rows[0]?.cursor?.rodadas || {}) };
  if (feitas[slot]) return false;
  feitas[slot] = new Date().toISOString();
  const ultimas = Object.fromEntries(Object.keys(feitas).sort().slice(-60).map(k => [k, feitas[k]]));
  const agoraIso = new Date().toISOString();
  await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: 'agente', recurso: 'agenda', ultima_tentativa: agoraIso, ultimo_sucesso: agoraIso, cursor: { rodadas: ultimas } }, 'marketplace,conta_id,recurso');
  return true;
}

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

  // ?rodada=sombra — mede agora as sugestões não aplicadas de todas as contas Shopee ativas (só lê campanha)
  if (req.query?.rodada === 'sombra') {
    try {
      const cfgs = (await sbSelect('glr_agente_config', 'ativo=eq.true')).filter(c => !ehML(c));
      const n = await Promise.all(cfgs.map(c => medirSombraShopee(c, mcApiKey, c.conta_id, 0).catch(() => 0)));
      return res.status(200).json({ ok: true, contas: cfgs.length, medidas: n.reduce((a, b) => a + b, 0) });
    } catch (e) { return res.status(500).json({ error: e.message || String(e) }); }
  }
  // ?rodada=meta — situação da meta de cada cliente (só lê); ?rodada=promo-meta — prepara as promoções pela meta (vão para aprovação; &simular=1 só lista)
  if (req.query?.rodada === 'meta') {
    try { _metaCache.clear(); const vinc = await lerStorage('glr_mc_vinculos') || {}; const out = []; for (const cli of Object.keys(vinc)) { const s2 = await situacaoMeta(cli); if (s2) out.push(s2); } return res.status(200).json({ ok: true, clientes: out }); } catch (e) { return res.status(500).json({ error: e.message || String(e) }); }
  }
  if (req.query?.rodada === 'promo-meta') {
    try { return res.status(200).json({ ok: true, ...(await promocoesPelaMeta(mcApiKey, req.query?.simular === '1')) }); } catch (e) { return res.status(500).json({ error: e.message || String(e) }); }
  }
  // ?rodada=momento — roda agora só a revisão de 3 dias de todas as contas ativas (Shopee aplica; ML sugere)
  if (req.query?.rodada === 'momento') {
    try {
      const cfgs = await sbSelect('glr_agente_config', 'ativo=eq.true');
      const ontem = dataBRT(1);
      waitUntil(Promise.all(cfgs.map(cfg => (ehML(cfg)
        ? comTetoML(cfg).then(c => processarContaML(c, mcApiKey, ajudantesML(), { soMomento: true }))
        : processarConta(cfg, mcApiKey, anthropicKey, ontem, dataBRT(Math.max(1, cfg.regra_pausa_dias || 3)), { soMomento: true })).catch(e => ({ conta_id: cfg.conta_id, erro: e.message }))))
        .then(r => console.log('[momento]', JSON.stringify(r))).finally(gravarConsumo).catch(e => console.error('[momento] falhou', e)));
      return res.status(202).json({ ok: true, rodada: 'momento', contas: cfgs.length });
    } catch (e) { return res.status(500).json({ error: e.message || String(e) }); }
  }
  // ?rodada=autonomia — recalcula os níveis de autonomia pelo resultado medido (não mexe em campanha)
  if (req.query?.rodada === 'autonomia') {
    try { return res.status(200).json({ ok: true, ...(await avaliarAutonomia()) }); } catch (e) { return res.status(500).json({ error: e.message || String(e) }); }
  }

  // Gerente de Conta: ?rodada=gerente (agenda das 08:00, uma vez por dia) ou
  // ?rodada=gerente&cliente_id=X ("Gerar plano agora" na tela Plano de ação)
  if (req.query?.rodada === 'gerente') {
    const ajud = { sbSelect, sbUpsert, lerStorage, anthropicKey, Anthropic };
    try {
      // a tela manda a meta que acabou de salvar (o glr_storage pode ainda não ter recebido)
      const metaNova = req.query?.meta != null || req.query?.meta_pedidos != null || req.query?.meta_tacos != null ? { cliente: req.query.cliente_id, meta: req.query.meta, metaPedidos: req.query.meta_pedidos, metaTacos: req.query.meta_tacos } : null;
      if (req.query?.cliente_id) return res.status(200).json({ ok: true, planos: await gerente.gerarPlanos(ajud, req.query.cliente_id, metaNova) });
      const slot = `${agoraBRT().dia}-gerente`;
      if (!(await reservarRodada(slot))) return res.status(200).json({ ok: true, skip: `rodada ${slot} já executada` });
      waitUntil(gerente.gerarPlanos(ajud).then(r => console.log('[gerente]', JSON.stringify(r))).catch(e => console.error('[gerente] falhou', e)));
      return res.status(202).json({ ok: true, rodada: 'gerente', slot });
    } catch (e) { return res.status(500).json({ error: e.message || String(e) }); }
  }

  // Rodada agendada (?rodada=completa|acompanhamento, ou a cron da Vercel =
  // completa): trava pelo horário, responde na hora e trabalha em segundo plano.
  const contaIdFiltro = req.query?.conta_id;
  const rodada = ['completa', 'acompanhamento'].includes(req.query?.rodada) ? req.query.rodada : (isVercelCron ? 'completa' : null);
  if (rodada && !contaIdFiltro) {
    try {
      const { dia, hora } = agoraBRT();
      const slot = rodada === 'completa' ? `${dia}-completa` : `${dia}-${String(hora).padStart(2, '0')}h`;
      if (!(await reservarRodada(slot))) return res.status(200).json({ ok: true, skip: `rodada ${slot} já executada` });
      const todas = await sbSelect('glr_agente_config', 'ativo=eq.true');
      // ML (copiloto) só na revisão completa das 07h; acompanhamentos são da Shopee
      const configs = todas.filter(cfg => rodada === 'completa' || !ehML(cfg));
      const ontem = dataBRT(1);
      // Cada conta do ML vai numa chamada própria (?conta_id=X&fundo=1, com os
      // próprios 300s) — dezenas de contas juntas aqui estourariam o tempo. Sai
      // uma a cada 1,5s para não despejar tudo na Tiops ao mesmo tempo.
      const base = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
      let filaML = 0;
      const dispararML = cfg => new Promise(ok => setTimeout(ok, 1500 * filaML++))
        .then(() => fetch(`${base}/api/agente-cron?conta_id=${encodeURIComponent(cfg.conta_id)}&fundo=1`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} }))
        .then(r => ({ conta_id: cfg.conta_id, marketplace: 'ml', disparada: r.status }))
        .catch(e => ({ conta_id: cfg.conta_id, marketplace: 'ml', erro: e.message }));
      waitUntil((rodada === 'completa' ? avaliarAutonomia().catch(e => console.error('[autonomia]', e)).then(() => promocoesPelaMeta(mcApiKey).catch(e => console.error('[promo-meta]', e))) : Promise.resolve()).then(() => Promise.all(configs.map(cfg => ehML(cfg)
        ? dispararML(cfg)
        : rodada === 'completa'
          ? processarConta(cfg, mcApiKey, anthropicKey, ontem, dataBRT(Math.max(1, cfg.regra_pausa_dias || 3)))
          : processarAcompanhamento(cfg, mcApiKey))))
        .then(r => console.log('[agente]', slot, JSON.stringify(r)))
        .finally(gravarConsumo)
        .catch(e => console.error('[agente] rodada falhou', slot, e)));
      return res.status(202).json({ ok: true, rodada, slot, contas: configs.length });
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  try {
    // ?conta_id=X — disparo manual pra 1 conta só ("Rodar agente agora" no
    // painel), roda mesmo que o piloto esteja desligado (o analista decidiu
    // rodar agora, não precisa estar em modo automático pra isso). Sem esse
    // parâmetro, comportamento normal do cron: todas as contas ativo=true.
    // ?conta_id=X&rodada=acompanhamento roda só o acompanhamento do dia.
    const configs = contaIdFiltro
      ? await sbSelect('glr_agente_config', `conta_id=eq.${encodeURIComponent(contaIdFiltro)}`)
      : await sbSelect('glr_agente_config', 'ativo=eq.true');
    if (!configs.length) {
      return res.status(200).json({ ok: true, skip: contaIdFiltro ? `conta ${contaIdFiltro} não tem configuração salva` : 'nenhuma conta piloto ativa em glr_agente_config' });
    }

    const ontem = dataBRT(1);

    // &fundo=1 (disparo da rodada das 07h, 1 conta do ML): responde na hora e analisa em segundo plano
    if (contaIdFiltro && req.query?.fundo === '1' && ehML(configs[0])) {
      waitUntil(comTetoML(configs[0]).then(c => processarContaML(c, mcApiKey, ajudantesML()))
        .then(r => console.log('[agente-ml]', contaIdFiltro, JSON.stringify(r).slice(0, 2000)))
        .finally(gravarConsumo)
        .catch(e => console.error('[agente-ml] falhou', contaIdFiltro, e)));
      return res.status(202).json({ ok: true, conta_id: contaIdFiltro, fundo: true });
    }

    // Contas em paralelo — sequencial estourava os 60s do plano com mais de
    // 1 conta ativa (cada conta já faz vários round-trips pra Tiops).
    const resultados = await Promise.all(configs.map(cfg => {
      if (ehML(cfg)) return comTetoML(cfg).then(c => processarContaML(c, mcApiKey, ajudantesML(), { simular: req.query?.simular === '1' }));
      if (req.query?.rodada === 'acompanhamento') return processarAcompanhamento(cfg, mcApiKey);
      const inicioJanela = dataBRT(Math.max(1, cfg.regra_pausa_dias || 3));
      return processarConta(cfg, mcApiKey, anthropicKey, ontem, inicioJanela);
    }));
    await gravarConsumo();
    return res.status(200).json({ ok: true, processadas: resultados.length, resultados });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};

// Resultado das ações que o agente (ou o analista) aplicou na Shopee: a campanha
// 7 dias antes × 7 dias depois do dia da ação. Mede ações de 8 a 45 dias atrás
// ainda sem medição — até 4 dias de ação por revisão, para não pesar o cron.
function tipoAcaoShopee(l) {
  const d = l.dados || {};
  if (d.pausada === true || /pausad/i.test(l.titulo || '')) return 'pausar';
  if (d.retomada === true) return 'acelerar';
  if (d.roas_de != null && d.roas_para != null && +d.roas_de !== +d.roas_para) return +d.roas_para > +d.roas_de ? 'conter' : 'acelerar';
  if (d.budget_de != null && d.budget_para != null && +d.budget_de !== +d.budget_para) return +d.budget_para < +d.budget_de ? 'conter' : 'acelerar';
  return null;
}
// ── Modo sombra: sugestão que NÃO foi aplicada também é medida ──
// 7 dias depois da sugestão (descartada, vencida ou ainda parada), olha a
// campanha mesmo assim e diz se o agente estava certo — e quanto custou não
// aplicar. Esses casos entram na promoção da autonomia (avaliarAutonomia): uma
// ação em "Só sugerir" ganha "Executar" provando que acerta, sem ter executado.
function tipoSugestao(d) {
  if (d.pausar === true) return 'pausar';
  if (d.retomar === true) return 'acelerar';
  if (d.roas_sugerido != null && d.roas_atual != null && +d.roas_sugerido !== +d.roas_atual) return +d.roas_sugerido > +d.roas_atual ? 'conter' : 'acelerar';
  if (d.budget_sugerido != null && d.budget_atual != null && +d.budget_sugerido !== +d.budget_atual) return +d.budget_sugerido < +d.budget_atual ? 'conter' : 'acelerar';
  return null;
}
function avaliarSombra(tipo, a, b, meta) {
  if (!b || (b.gastoDia <= 0 && (!a || a.gastoDia <= 0))) return { veredito: 'sem_dados', resumo: 'campanha sem ADS na semana seguinte', custo: 0 };
  const acosB = b.semVenda ? Infinity : b.acos;
  const acima = v => Math.max(0, (b.gastoDia - b.vendasDia * (meta || 0) / 100) * 7);
  if (tipo === 'pausar') {
    const ruim = b.semVenda || b.vendasDia < b.gastoDia;
    return { veredito: ruim ? 'certo' : 'desnecessario', resumo: ruim ? `seguiu gastando ${R$(b.gastoDia * 7)}/sem com ${R$(b.vendasDia * 7)} de venda` : 'a campanha voltou a vender sozinha', custo: ruim ? Math.round(Math.max(0, (b.gastoDia - b.vendasDia) * 7)) : 0 };
  }
  if (tipo === 'conter') {
    if (!meta) return { veredito: 'neutro', resumo: 'conta sem meta de ACOS', custo: 0 };
    if (acosB > meta * 1.05) return { veredito: 'certo', resumo: `o ACOS seguiu em ${acosB === Infinity ? '∞' : `${acosB.toFixed(1)}%`} (meta ${meta}%)`, custo: Math.round(acima()) };
    if (acosB <= meta) return { veredito: 'desnecessario', resumo: `o ACOS voltou para ${acosB.toFixed(1)}% sozinho`, custo: 0 };
    return { veredito: 'neutro', resumo: `ACOS ${acosB.toFixed(1)}%, perto da meta`, custo: 0 };
  }
  // acelerar: ACOS bom e venda parada = oportunidade perdida
  const bom = meta ? acosB <= meta : true, parada = a ? b.vendasDia <= a.vendasDia * 1.05 : true;
  if (bom && parada) return { veredito: 'certo', resumo: `ACOS bom (${acosB.toFixed(1)}%) e a venda não cresceu sem o aumento`, custo: 0 };
  if (!bom) return { veredito: 'desnecessario', resumo: `o ACOS subiu para ${acosB === Infinity ? '∞' : `${acosB.toFixed(1)}%`} — acelerar teria piorado`, custo: 0 };
  return { veredito: 'neutro', resumo: 'a venda cresceu mesmo sem o aumento', custo: 0 };
}
async function medirSombraShopee(cfg, mcApiKey, shopId, taxaCancel) {
  const diaBRT = iso => new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
  const ddmm = iso => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
  const isoDe = dd => `${dd.slice(6, 10)}-${dd.slice(3, 5)}-${dd.slice(0, 2)}`;
  const desde = new Date(Date.now() - 45 * 864e5).toISOString(), ate = new Date(Date.now() - 7.5 * 864e5).toISOString();
  const logs = await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(shopId)}&tipo=eq.alerta&resultado=in.(so_alerta,expirado,descartado)&criado_em=gte.${encodeURIComponent(desde)}&criado_em=lte.${encodeURIComponent(ate)}&select=id,titulo,criado_em,dados&limit=500`).catch(() => []);
  const ontem = dataBRT(1).iso, porDia = new Map();
  for (const l of logs) {
    const d = l.dados || {}, tipo = tipoSugestao(d);
    if (!d.campaign_id || d.sombra || !tipo || d.marketplace === 'ml') continue;
    const dia = diaBRT(l.criado_em);
    if (isoMenos(dia, -7) > ontem) continue;
    (porDia.get(dia) || porDia.set(dia, []).get(dia)).push({ l, tipo });
  }
  let n = 0;
  for (const dia of [...porDia.keys()].sort().slice(0, 4)) {
    const itens = porDia.get(dia), ids = [...new Set(itens.map(x => String(x.l.dados.campaign_id)))], met = {};
    await Promise.all(chunk(ids, 20).map(async lote => {
      const r = await mcpCall(mcApiKey, 'shopee_ads_campaign_daily', { shopId, campaign_id_list: lote.join(','), start_date: ddmm(isoMenos(dia, 7)), end_date: ddmm(isoMenos(dia, -7)) }).catch(() => null);
      (r?.data?.response?.campaign_list || r?.response?.campaign_list || []).forEach(c => {
        const soma = { a: { g: 0, v: 0 }, b: { g: 0, v: 0 } };
        for (const x of c.metrics_list || []) {
          const dd = isoDe(String(x.date || '')), lado = dd < dia ? soma.a : dd > dia ? soma.b : null;
          if (!lado) continue;
          lado.g += parseFloat(x.expense) || 0; lado.v += (parseFloat(x.broad_gmv) || 0) * (1 - taxaCancel);
        }
        met[String(c.campaign_id)] = { a: medicaoAds.metricas(soma.a.g, soma.a.v), b: medicaoAds.metricas(soma.b.g, soma.b.v) };
      });
    }));
    for (const { l, tipo } of itens) {
      const m = met[String(l.dados.campaign_id)];
      const r = avaliarSombra(tipo, m?.a, m?.b, cfg.meta_acos);
      try { await sbUpdate('glr_agente_log', `id=eq.${l.id}`, { dados: { ...l.dados, sombra: { tipo, ...r, antes: m?.a || null, depois: m?.b || null, medido_em: new Date().toISOString() } } }); n++; } catch (e) {}
    }
  }
  return n;
}

async function medirResultadosShopee(cfg, mcApiKey, shopId, taxaCancel) {
  const ontem = dataBRT(1).iso;
  const diaBRT = iso => new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
  const ddmm = iso => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
  const isoDe = dd => `${dd.slice(6, 10)}-${dd.slice(3, 5)}-${dd.slice(0, 2)}`;
  const desde = new Date(Date.now() - 45 * 86400000).toISOString(), ate = new Date(Date.now() - 7.5 * 86400000).toISOString();
  const logs = await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(shopId)}&tipo=eq.decisao&resultado=eq.executado&criado_em=gte.${encodeURIComponent(desde)}&criado_em=lte.${encodeURIComponent(ate)}&select=id,titulo,criado_em,dados&limit=500`).catch(() => []);
  const porDia = new Map();
  for (const l of logs) {
    const tipo = tipoAcaoShopee(l);
    if (!l.dados?.campaign_id || l.dados.medicao || !tipo) continue;
    const ap = diaBRT(l.criado_em);
    if (isoMenos(ap, -7) > ontem) continue;
    (porDia.get(ap) || porDia.set(ap, []).get(ap)).push({ l, tipo });
  }
  let medidas = 0;
  for (const ap of [...porDia.keys()].sort().slice(0, 4)) {
    const itens = porDia.get(ap);
    const ids = [...new Set(itens.map(x => String(x.l.dados.campaign_id)))];
    const met = {};
    await Promise.all(chunk(ids, 20).map(async lote => {
      const r = await mcpCall(mcApiKey, 'shopee_ads_campaign_daily', { shopId, campaign_id_list: lote.join(','), start_date: ddmm(isoMenos(ap, 7)), end_date: ddmm(isoMenos(ap, -7)) }).catch(() => null);
      (r?.data?.response?.campaign_list || r?.response?.campaign_list || []).forEach(c => {
        const soma = { a: { g: 0, v: 0 }, b: { g: 0, v: 0 } };
        for (const d of c.metrics_list || []) {
          const dia = isoDe(String(d.date || ''));
          const lado = dia < ap ? soma.a : dia > ap ? soma.b : null;
          if (!lado) continue;
          lado.g += parseFloat(d.expense) || 0; lado.v += (parseFloat(d.broad_gmv) || 0) * (1 - taxaCancel);
        }
        met[String(c.campaign_id)] = { a: medicaoAds.metricas(soma.a.g, soma.a.v), b: medicaoAds.metricas(soma.b.g, soma.b.v) };
      });
    }));
    for (const { l, tipo } of itens) {
      const m = met[String(l.dados.campaign_id)];
      const { veredito, resumo } = medicaoAds.avaliar(tipo, m?.a, m?.b, cfg.meta_acos, R$);
      const dados = { ...l.dados, medicao: { campaign_id: l.dados.campaign_id, tipo, aplicado_dia: ap, antes: m?.a || null, depois: m?.b || null, veredito, resumo, medido_em: new Date().toISOString() } };
      try { await sbUpdate('glr_agente_log', `id=eq.${l.id}`, { dados }); medidas++; } catch (e) {}
    }
  }
  return medidas;
}

// ── Contrato do cliente (Plano de ação → "Contrato e autonomia"; glr_contratos) ──
// perfil muda o quanto o agente acelera/contém e quando o freio de volume age;
// autonomia diz, por tipo de ação, se o agente executa sozinho ou só sugere
// (a sugestão vai para a Caixa de decisões). Sem contrato = Equilíbrio + Executar
// (exatamente o comportamento de antes).
const PERFIS = {
  crescer:    { acelera: 0.85, contem: 1.15, freio: 15, nome: 'Crescer' },
  equilibrio: { acelera: 0.7,  contem: 1.0,  freio: 25, nome: 'Equilíbrio' },
  lucrar:     { acelera: 0.6,  contem: 1.0,  freio: 35, nome: 'Lucrar' },
};
let _contratosCache = null;
async function contratoDaConta(contaId) {
  if (!_contratosCache || Date.now() - _contratosCache.em > 5 * 60e3) { // instância quente da Vercel: no máx. 5 min de atraso
    const [ctr, vinc, aut, tetos] = await Promise.all([lerStorage('glr_contratos').catch(() => null), lerStorage('glr_mc_vinculos').catch(() => null), lerStorage('glr_autonomia_auto').catch(() => null), lerStorage('glr_metas_tacos').catch(() => null)]);
    _contratosCache = { ctr: ctr || {}, vinc: vinc || {}, aut: aut || {}, tetos: tetos || {}, em: Date.now() };
  }
  const { ctr, vinc, aut, tetos } = _contratosCache;
  let cli = null;
  for (const [cid, arr] of Object.entries(vinc)) if ((arr || []).some(c => [c.external_id, c.param_to_use?.shopId, c.param_to_use?.meliUserId].filter(Boolean).map(String).includes(String(contaId)))) { cli = cid; break; }
  const c = (cli && ctr[cli]) || {};
  const perfil = PERFIS[c.perfil] ? c.perfil : 'equilibrio';
  // nível de cada ação: o do contrato quando "fixo"; senão o que o resultado medido decidiu (avaliarAutonomia)
  const nivel = k => (!c.fixo && aut?.[cli]?.[k]?.nivel) || (c.autonomia?.[k] === 'sugerir' ? 'sugerir' : 'executar');
  // teto de ADS do cliente (Plano de ação → meta): TACOS acima dele trava qualquer aceleração, sem a folga de 10% da meta da conta
  const tetoTacos = (cli && parseFloat(tetos[cli])) || null;
  return { cliente: cli, perfil, P: PERFIS[perfil], ajuste: nivel('ajuste'), pausar: nivel('pausar'), desfazer: nivel('desfazer'), tetoTacos }; // promoção: sempre aprovação manual (não tem nível)
}

// ── Situação da meta do cliente: o que todos os agentes leem ──
// Meta (Plano de ação / Projeção / cadastro) × projeção do mês somando todas as
// lojas do cliente (resumo diário da base). Abaixo do ritmo (< 97%) os agentes
// trabalham para a meta: o ADS acelera com mais facilidade e segura menos, as
// Promoções entram no que cabe na margem. Acima (≥ 105%) o ADS protege a margem.
const _metaCache = new Map();
async function situacaoMeta(cli) {
  if (!cli) return null;
  const c0 = _metaCache.get(cli);
  if (c0 && Date.now() - c0.em < 10 * 60e3) return c0.sit; // instância quente: no máx. 10 min
  const [metas, metasPed, clientes, vinc] = await Promise.all([lerStorage('glr_metas'), lerStorage('glr_metas_pedidos'), lerStorage('glr_clientes'), lerStorage('glr_mc_vinculos')]);
  const c = (clientes || []).find(x => String(x.id) === String(cli)) || {};
  const meta = parseFloat((metas || {})[cli]) || parseFloat(c.metaMensal) || null, metaPedidos = parseFloat((metasPed || {})[cli]) || null;
  if (!meta && !metaPedidos) { _metaCache.set(cli, { sit: null, em: Date.now() }); return null; }
  const contas = ((vinc || {})[cli] || []).map(x => String(x.param_to_use?.shopId || x.param_to_use?.meliUserId || x.external_id));
  const rows = contas.length ? await sbSelect('glr_sync_estado', `recurso=eq.resumo&conta_id=in.(${contas.map(encodeURIComponent).join(',')})&select=conta_id,dias:cursor->dias`).catch(() => []) : [];
  const ontem = dataBRT(1).iso, ini = ontem.slice(0, 8) + '01', dd = +ontem.slice(8, 10), dm = new Date(Date.UTC(+ontem.slice(0, 4), +ontem.slice(5, 7), 0)).getUTCDate();
  let fat = 0, ped = 0;
  for (const r of rows) for (const [d, v] of Object.entries(r.dias || {})) if (d >= ini && d <= ontem) { fat += parseFloat(v.faturamento) || 0; ped += parseInt(v.pedidos) || 0; }
  const proj = dd ? fat / dd * dm : 0, projPed = dd ? ped / dd * dm : 0;
  const pct = meta ? proj / meta * 100 : projPed / metaPedidos * 100;
  const sit = { cliente: cli, nome: c.nome || '', meta, metaPedidos, proj: Math.round(proj), pct: Math.round(pct * 10) / 10, abaixo: pct < 97, acima: pct >= 105,
    faltaDia: meta && dm > dd ? Math.round(Math.max(0, meta - fat) / (dm - dd)) : null, ritmoDia: dd ? Math.round(fat / dd) : null };
  _metaCache.set(cli, { sit, em: Date.now() });
  return sit;
}

// ── Promoções pela meta (SEMPRE com aprovação manual) ──
// Cliente abaixo do ritmo da meta: o agente PREPARA a entrada nas promoções do
// ML que cabem na margem mínima (+2 p.p.) — só produto com custo cadastrado, com
// o lucro por venda em R$ — e manda para a Caixa de decisões. Nada entra no ML
// sem o analista aprovar (regra da GLR: promoção nunca é automática).
// Até 5 por loja por dia, pelo que mais vende; produto que acaba em 10 dias fica de fora.
const PROMO_POR_DIA = 5;
async function promocoesPelaMeta(mcApiKey, simular) {
  _metaCache.clear(); _contratosCache = null;
  const vinc = await lerStorage('glr_mc_vinculos') || {};
  const feitas = [];
  const desde14 = encodeURIComponent(new Date(Date.now() - 14 * 864e5).toISOString());
  const jaTem = new Set((await sbSelect('glr_agente_log', `titulo=like.${encodeURIComponent('*promoção pela meta*')}&criado_em=gte.${desde14}&select=dados&limit=3000`).catch(() => [])).map(l => String(l.dados?.item_id)));
  for (const [cli, arr] of Object.entries(vinc)) {
    const sit = await situacaoMeta(cli);
    if (!sit?.abaixo) continue;
    const contasMl = (arr || []).filter(x => ['meli', 'ml', 'mercadolivre'].includes(String(x.marketplace || '').toLowerCase())).map(x => String(x.param_to_use?.meliUserId || x.external_id));
    for (const conta of contasMl) {
      const [pr, sn] = await Promise.all([
        sbSelect('glr_sync_estado', `marketplace=eq.ml&conta_id=eq.${encodeURIComponent(conta)}&recurso=eq.promocoes&select=cursor`).then(r => r[0]?.cursor).catch(() => null),
        sbSelect('glr_sync_estado', `marketplace=eq.ml&conta_id=eq.${encodeURIComponent(conta)}&recurso=eq.sinais&select=itens:cursor->itens`).then(r => r[0]?.itens || {}).catch(() => ({})),
      ]);
      const mMin = pr?.margem_minima ?? 5;
      const cand = Object.entries(pr?.itens || {}).map(([id, x]) => ({ id, ...x, vd: sn[id]?.vd || 0, custo: sn[id]?.c || null }))
        .filter(x => x.melhor && x.custo > 0 && !/COUPON/.test(x.melhor.tipo) && x.melhor.m != null && x.melhor.m >= mMin + 2 && !jaTem.has(x.id) && (x.e == null || x.e > 0) && (x.d == null || x.d > 10))
        .sort((a, b) => b.vd * b.p - a.vd * a.p).slice(0, PROMO_POR_DIA);
      for (const x of cand) {
        const op = x.melhor;
        const lucro = Math.round(op.preco * op.m / 100 * 100) / 100; // margem já desconta tarifa, frete, custo e imposto
        const aprovar = op.tipo === 'PRICE_DISCOUNT' ? { promotion_type: op.tipo, deal_price: op.preco, dias: 13 }
          : ['SMART', 'PRICE_MATCHING', 'PRE_NEGOTIATED', 'UNHEALTHY_STOCK'].includes(op.tipo) ? { promotion_type: op.tipo, promotion_id: op.id, offer_id: op.ref }
          : { promotion_type: op.tipo, promotion_id: op.id, deal_price: op.preco, offer_id: op.ref || null };
        const dados = { marketplace: 'ml', item_id: x.id, produto: String(x.n || '').slice(0, 90), promo: op.rot, preco: op.preco, preco_cheio: x.p, desconto: op.desconto, margem: op.m, lucro_venda: lucro, custo: x.custo, margem_minima: mMin, meta_pct: sit.pct,
          promo_aprovar: aprovar, impacto: Math.round((x.vd || 0) * op.preco * 7 * 0.15), impacto_tipo: 'ganho', colaboracao: { de: 'meta' } };
        if (simular) { feitas.push({ cliente: sit.nome, ...dados }); continue; }
        await sbInsert('glr_agente_log', { conta_id: conta, cliente_nome: sit.nome || null, tipo: 'alerta',
          titulo: `Sugestão: entrar em promoção pela meta — ${String(x.n || x.id).slice(0, 60)}`,
          explicacao: `${sit.nome || 'O cliente'} está em ${String(sit.pct).replace('.', ',')}% da meta do mês. "${op.rot}" a ${R$(op.preco)}${op.desconto ? ` (−${String(op.desconto).replace('.', ',')}%)` : ''}: com o custo de ${R$(x.custo)}, sobra ${R$(lucro)} de lucro por venda (margem ${String(op.m).replace('.', ',')}%, mínima ${mMin}%). Só entra no ML se você aprovar.`,
          dados, resultado: 'so_alerta', origem: 'cron' }).catch(() => {});
        feitas.push(x.id);
      }
    }
  }
  return simular ? { simulacao: true, entraria: feitas } : { sugeridas: feitas.length };
}

// ── Autonomia que sobe e desce pelo resultado medido ("Deu resultado?") ──
// Por cliente e por tipo de ação (ajuste, pausar, desfazer), olhando os últimos
// 30 casos medidos (decisões do agente e as aprovadas pelo analista):
//  • rebaixa para "Só sugerir" quando 10+ casos e metade ou mais pioraram;
//  • promove para "Executar" quando 30+ casos, 70%+ melhoraram e até 15% pioraram.
// O contrato com "fixo" não muda sozinho. Resultado em glr_storage
// 'glr_autonomia_auto' (só o servidor grava; a tela lê) — o agente usa no lugar
// do que está no contrato.
const CHAVE_AUT = l => (l.dados?.desfeito_auto ? 'desfazer' : tipoAcaoShopee(l) === 'pausar' ? 'pausar' : tipoAcaoShopee(l) ? 'ajuste' : null);
const ROT_AUT = { ajuste: 'ajustar ROAS/orçamento', pausar: 'pausar campanha', desfazer: 'desfazer aperto' };
async function avaliarAutonomia() {
  const [vinc, contratos, antes, clientes] = await Promise.all([lerStorage('glr_mc_vinculos'), lerStorage('glr_contratos'), lerStorage('glr_autonomia_auto'), lerStorage('glr_clientes')]);
  const clienteDe = {};
  for (const [cid, arr] of Object.entries(vinc || {})) for (const c of (arr || [])) for (const id of [c.external_id, c.param_to_use?.shopId].filter(Boolean)) clienteDe[String(id)] = cid;
  const logs = await sbSelect('glr_agente_log', `tipo=eq.decisao&resultado=eq.executado&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 75 * 864e5).toISOString())}&select=conta_id,titulo,dados&order=criado_em.desc&limit=8000`).catch(() => []);
  // sombra: sugestões não aplicadas medidas (certo = o agente acertou)
  const sombras = await sbSelect('glr_agente_log', `tipo=eq.alerta&dados->sombra=not.is.null&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 75 * 864e5).toISOString())}&select=conta_id,titulo,dados&limit=8000`).catch(() => []);
  const grupos = {};
  for (const l of sombras) {
    const sv = l.dados?.sombra?.veredito; if (!['certo', 'desnecessario', 'neutro'].includes(sv)) continue;
    const cli = clienteDe[String(l.conta_id)], k = l.dados?.freio_volume ? 'desfazer' : l.dados?.pausar ? 'pausar' : 'ajuste'; if (!cli) continue;
    ((grupos[cli] = grupos[cli] || {})[k] = grupos[cli][k] || []).push({ v: sv === 'certo' ? 'melhorou' : sv === 'desnecessario' ? 'piorou' : 'neutro', em: l.dados.sombra.medido_em || '', sombra: true, custo: l.dados.sombra.custo || 0 });
  }
  for (const l of logs) {
    const v = l.dados?.medicao?.veredito; if (!['melhorou', 'piorou', 'neutro'].includes(v) || l.dados?.marketplace === 'ml') continue;
    const cli = clienteDe[String(l.conta_id)], k = CHAVE_AUT(l); if (!cli || !k) continue;
    ((grupos[cli] = grupos[cli] || {})[k] = grupos[cli][k] || []).push({ v, em: l.dados.medicao.medido_em || '' });
  }
  const novo = {}, mudancas = [];
  const nomeCli = cid => ((clientes || []).find(c => String(c.id) === String(cid)) || {}).nome || `cliente ${cid}`;
  for (const [cli, porK] of Object.entries(grupos)) for (const [k, casos] of Object.entries(porK)) {
    const ult = casos.sort((a, b) => String(b.em).localeCompare(String(a.em))).slice(0, 30);
    const n = ult.length, mel = ult.filter(x => x.v === 'melhorou').length, pio = ult.filter(x => x.v === 'piorou').length;
    const sb = ult.filter(x => x.sombra), sombra = sb.length ? { n: sb.length, certo: sb.filter(x => x.v === 'melhorou').length, custo: Math.round(sb.reduce((s2, x) => s2 + (x.custo || 0), 0)) } : null;
    const ctr = (contratos || {})[cli] || {}, base = ctr.autonomia?.[k] === 'sugerir' ? 'sugerir' : 'executar';
    const prev = antes?.[cli]?.[k];
    let nivel = ctr.fixo ? base : (prev?.nivel || base), motivo = prev?.motivo || null, mudouEm = prev?.mudou_em || null;
    if (!ctr.fixo) {
      if (nivel === 'executar' && n >= 10 && pio / n >= 0.5) { nivel = 'sugerir'; motivo = `${pio} de ${n} casos medidos pioraram`; mudouEm = new Date().toISOString(); mudancas.push({ cli, k, nivel, motivo }); }
      else if (nivel === 'sugerir' && n >= 30 && mel / n >= 0.7 && pio / n <= 0.15) { nivel = 'executar'; motivo = `${mel} de ${n} casos medidos melhoraram`; mudouEm = new Date().toISOString(); mudancas.push({ cli, k, nivel, motivo }); }
    }
    (novo[cli] = novo[cli] || {})[k] = { nivel, base, n, melhorou: mel, piorou: pio, sombra, motivo: nivel !== base ? motivo : null, mudou_em: nivel !== base ? mudouEm : null, em: new Date().toISOString() };
  }
  await sbUpsert('glr_storage', { chave: 'glr_autonomia_auto', dados: novo, atualizado_em: new Date().toISOString() }, 'chave').catch(() => {});
  _contratosCache = null;
  for (const m of mudancas) {
    const txt = `${nomeCli(m.cli)}: ${ROT_AUT[m.k]} passou para "${m.nivel === 'executar' ? 'Executar' : 'Só sugerir'}" — ${m.motivo}.`;
    await sbInsert('glr_agente_log', { conta_id: `cliente:${m.cli}`, cliente_nome: nomeCli(m.cli), tipo: 'sistema', titulo: `Autonomia ${m.nivel === 'executar' ? 'promovida' : 'rebaixada'} — ${ROT_AUT[m.k]}`, explicacao: txt, dados: { autonomia: m }, resultado: 'executado', origem: 'cron' }).catch(() => {});
  }
  if (mudancas.length) await require('./_alerta').avisar(sbSelect, mudancas.length === 1 ? '🤖 Autonomia do agente mudou' : `🤖 Autonomia mudou em ${mudancas.length} caso(s)`, mudancas.slice(0, 3).map(m => `${nomeCli(m.cli)}: ${ROT_AUT[m.k]} → ${m.nivel === 'executar' ? 'Executar' : 'Só sugerir'} (${m.motivo})`).join('\n'), 'autonomia').catch(() => {});
  return { clientes: Object.keys(novo).length, mudancas: mudancas.length };
}

async function processarConta(cfg, mcApiKey, anthropicKey, ontem, inicioJanela, opc = {}) {
  const shopId = cfg.conta_id;
  const decisoes = [];
  const alertas = [];
  _contratosCache = null; // lê o contrato de novo a cada revisão
  const contrato = await contratoDaConta(shopId);
  // a meta do cliente guia o ADS: abaixo do ritmo acelera com mais facilidade e segura menos; acima protege a margem
  const metaSit = await situacaoMeta(contrato.cliente).catch(() => null);
  const pelaMeta = [];
  if (metaSit?.abaixo) { contrato.P = { ...contrato.P, acelera: Math.max(contrato.P.acelera, 0.85), contem: Math.max(contrato.P.contem, 1.1), freio: Math.min(contrato.P.freio, 15) }; pelaMeta.push(`o cliente está em ${String(metaSit.pct).replace('.', ',')}% da meta (precisa de ${R$(metaSit.faltaDia || 0)}/dia, faz ${R$(metaSit.ritmoDia || 0)}/dia): acelero com ACOS até 15% abaixo da meta, só contenho 10% acima e o freio age com queda de 15%`); }
  else if (metaSit?.acima) { contrato.P = { ...contrato.P, acelera: Math.min(contrato.P.acelera, 0.6) }; pelaMeta.push(`o cliente está em ${String(metaSit.pct).replace('.', ',')}% da meta: protejo a margem e só acelero com ACOS 40% abaixo da meta`); }

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
    if (contrato.pausar === 'sugerir') { // contrato: pausar só com aprovação
      await logar('alerta', `Sugestão de pausar — ${nome}`, `${explicacao} O contrato deste cliente pede aprovação para pausar.`, { ...dados, pausar: true, contrato: 'sugerir' }, 'so_alerta');
      alertas.push(nome); return;
    }
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
    if (contrato.ajuste === 'sugerir' && !dadosBase?.desfeito_auto) { // contrato: ajuste só com aprovação
      await logar('alerta', `Sugestão de ${novoBudget > (dadosBase?.budget_de || 0) ? 'aumento' : 'corte'} de orçamento — ${nome}`, `${explicacao} O contrato deste cliente pede aprovação para ajustar.`, { campaign_id: Number(campaignId), budget_atual: dadosBase?.budget_de, budget_sugerido: novoBudget, contrato: 'sugerir' }, 'so_alerta');
      alertas.push(nome); return;
    }
    try {
      // shopee_ads_edit_campaign é passthrough cru pra edit_manual_product_ads
      // — confirmado ao vivo que exige params.edit_action="change_budget",
      // params.budget (não campaign_budget) e um params.reference_id único.
      // Sem isso a Shopee rejeita com "Invalid param type" / "EditAction is
      // required" — essa função vinha falhando silenciosamente (cai no catch,
      // loga 'erro') toda vez que a Regra 3/4 tentava ajustar orçamento.
      await mcpCall(mcApiKey, 'shopee_ads_edit_campaign', {
        shopId,
        campaign_id: Number(campaignId), // conector valida no nível de cima também (14/10/2026)
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
    if (contrato.ajuste === 'sugerir' && !dadosBase?.desfeito_auto) { // contrato: ajuste só com aprovação
      await logar('alerta', `Sugestão de ${novoRoasTarget > (dadosBase?.roas_de || 0) ? 'subir' : 'baixar'} meta de ROI — ${nome}`, `${explicacao} O contrato deste cliente pede aprovação para ajustar.`, { campaign_id: Number(campaignId), roas_atual: dadosBase?.roas_de, roas_sugerido: novoRoasTarget, contrato: 'sugerir' }, 'so_alerta');
      alertas.push(nome); return;
    }
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
    // é a base do TACOS (regra atual logo abaixo: sem cancelados).
    // Sequencial, NUNCA em paralelo — confirmado ao vivo que disparar as chamadas
    // de status ao mesmo tempo faz o conector devolver dado incompleto pra
    // algumas delas (sem erro, só um total_revenue menor). Mais lento, mas o
    // único jeito confirmado de pegar o valor certo.
    // Faturamento da loja SEM cancelados (e sem devolução aceita), valor dos
    // produtos — a mesma regra de Vendas e do Gestor Seller. Corrigido em
    // 14/10/2026: antes era bruto COM cancelados ("bate com o Gestor Seller"),
    // mas conferindo na EAP o Gestor Seller exclui os cancelados (R$ 142,9 mil
    // vs R$ 193,9 mil com cancelados) — o TACOS saía menor que o real.
    // Base sincronizada primeiro (instantâneo); sem cobertura, API sem CANCELLED.
    const base = await lerBase('shopee', shopId);
    const sinais = await lerSinais('shopee', shopId);
    const colaboracoes = pelaMeta.map(t => ({ de: 'meta', campanha: '', texto: t })); // o que mudou por causa da meta/Estoque/Margem (vai para o registro e o Escritório)
    // ── Freio de volume (conversa com o Raio-X do faturamento do Gerente) ──
    // Apertar ROAS/orçamento melhora o ACOS, mas pode derrubar a VENDA do produto
    // (o Raio-X de 28/10 achou 22 das maiores quedas logo depois de apertos do
    // próprio agente). Antes de conter, olha a venda do produto na loja inteira
    // (orgânico + ADS): últimos 7 dias × 7 anteriores, e os apertos dos últimos 21 dias.
    const vendasProd = new Map();
    // Revisão de 3 dias: a cada 3 dias por loja, a venda de cada produto nos últimos 3 dias × os 3 anteriores
    const MOMENTO_DIAS = 3, hojeMom = dataBRT(0).iso;
    const estMom = (await sbSelect('glr_sync_estado', `marketplace=eq.sistema&conta_id=eq.${encodeURIComponent(`momento:${shopId}`)}&recurso=eq.momento&select=cursor`).catch(() => []))[0]?.cursor;
    const momentoHoje = !!opc.soMomento || !estMom?.dia || (Date.parse(`${hojeMom}T12:00:00Z`) - Date.parse(`${estMom.dia}T12:00:00Z`)) / 864e5 >= MOMENTO_DIAS;
    const mom = { aceleradas: [], recuperadas: [], desfeitas: [], seguradas: [], motivos: {} };
    async function registrarMomento() {
      const lista = (t, xs) => xs.length ? `${t}: ${xs.slice(0, 6).join(', ')}${xs.length > 6 ? ` e mais ${xs.length - 6}` : ''}.` : '';
      await logar('sistema', `Revisão de 3 dias — ${mom.aceleradas.length} acelerada(s), ${mom.recuperadas.length + mom.desfeitas.length} recuperada(s)`,
        `Comparei a venda de cada produto com campanha nos últimos 3 dias com os 3 anteriores. ${[lista('Subindo e acelerada', mom.aceleradas), lista('Caindo, exposição reforçada', mom.recuperadas), lista('Caindo depois de aperto, aperto desfeito', mom.desfeitas), lista('Subindo mas segurada por limite', mom.seguradas), mom.seguradas.length ? `Por que seguradas: ${Object.entries(mom.motivos).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${n} por ${m}`).join(', ')}.` : ''].filter(Boolean).join(' ') || 'Nenhum produto com variação relevante (±20% e R$ 100).'} Próxima revisão em ${MOMENTO_DIAS} dias.`,
        { momento: true, aceleradas: mom.aceleradas.length, recuperadas: mom.recuperadas.length, desfeitas: mom.desfeitas.length, seguradas: mom.seguradas.length, motivos: mom.motivos }, 'executado');
      await sbUpsert('glr_sync_estado', { marketplace: 'sistema', conta_id: `momento:${shopId}`, recurso: 'momento', ultima_tentativa: new Date().toISOString(), ultimo_sucesso: new Date().toISOString(), cursor: { dia: hojeMom, aceleradas: mom.aceleradas.length, recuperadas: mom.recuperadas.length, desfeitas: mom.desfeitas.length } }, 'marketplace,conta_id,recurso').catch(() => {});
    
    }
    try {
      const d7 = isoMenos(ontem.iso, 6), d14 = isoMenos(ontem.iso, 13), d3 = isoMenos(ontem.iso, 2), d6 = isoMenos(ontem.iso, 5);
      for (let off = 0; off < 40000; off += 1000) {
        const rows = await sbSelect('glr_pedidos', `marketplace=eq.shopee&conta_id=eq.${encodeURIComponent(shopId)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(new Date(`${d14}T03:00:00Z`).toISOString())}&select=criado_em,itens&order=criado_em.asc&limit=1000&offset=${off}`);
        for (const p of rows) {
          const dia = new Date(Date.parse(p.criado_em) - 3 * 3600e3).toISOString().slice(0, 10);
          if (dia > ontem.iso) continue;
          for (const i of (p.itens || [])) {
            const v = vendasProd.get(String(i.item_id)) || { a: 0, b: 0, a3: 0, b3: 0 };
            const val = (parseFloat(i.preco) || 0) * (parseInt(i.qtd) || 1);
            v[dia >= d7 ? 'b' : 'a'] += val;
            if (dia >= d3) v.b3 += val; else if (dia >= d6) v.a3 += val;
            vendasProd.set(String(i.item_id), v);
          }
        }
        if (rows.length < 1000) break;
      }
    } catch (e) { vendasProd.clear(); }
    const apertos = new Map(); // campanha → { roasAntes, budgetAntes, desde }
    for (const l of (await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(shopId)}&tipo=eq.decisao&resultado=eq.executado&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 21 * 864e5).toISOString())}&select=criado_em,dados&order=criado_em.asc&limit=1000`).catch(() => []))) {
      const d = l.dados || {}; if (d.campaign_id == null) continue;
      const apertou = (d.roas_para != null && d.roas_de != null && +d.roas_para > +d.roas_de) || (d.budget_para != null && d.budget_de != null && +d.budget_para < +d.budget_de);
      if (!apertou) continue;
      const k = String(d.campaign_id), x = apertos.get(k) || { desde: l.criado_em };
      if (x.roasAntes == null && d.roas_de != null) x.roasAntes = +d.roas_de;
      if (x.budgetAntes == null && d.budget_de != null) x.budgetAntes = +d.budget_de;
      apertos.set(k, x);
    }
    const freiosPend = (await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(shopId)}&tipo=eq.alerta&resultado=eq.so_alerta&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}&select=id,dados&limit=300`).catch(() => []))
      .filter(l => l.dados?.freio_volume);
    const voltaPendente = new Set(freiosPend.map(l => String(l.dados.campaign_id)));
    function momento(itemIds) {
      if (!vendasProd.size) return null;
      let a = 0, b = 0;
      for (const id of (itemIds || [])) { const v = vendasProd.get(String(id)); if (v) { a += v.a3; b += v.b3; } }
      return a + b >= 200 ? { a, b, pct: a > 0 ? (b / a - 1) * 100 : 100 } : null;
    }
    function quedaDeVenda(itemIds) {
      if (!vendasProd.size) return null;
      let a = 0, b = 0;
      for (const id of (itemIds || [])) { const v = vendasProd.get(String(id)); if (v) { a += v.a; b += v.b; } }
      return a >= 300 && b < a * (1 - contrato.P.freio / 100) ? { a, b, pct: (1 - b / a) * 100 } : null; // perfil: Crescer 15%, Equilíbrio 25%, Lucrar 35%
    }
    // sugestão de pausa por estoque ainda pendente não é repetida
    const pausaEstoquePendente = new Set((await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(shopId)}&tipo=eq.alerta&resultado=eq.so_alerta&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 7 * 86400000).toISOString())}&select=dados&limit=300`).catch(() => []))
      .filter(l => l.dados?.pausar === true && l.dados?.colaboracao?.de === 'estoque').map(l => String(l.dados.campaign_id)));
    let faturamentoTotalLoja = 0, fonteFaturamento = 'api';
    if (baseCobre(base, inicioJanela.iso)) {
      faturamentoTotalLoja = somarBase(base, inicioJanela.iso, ontem.iso).faturamento;
      fonteFaturamento = 'base';
    } else {
      for (const st of ['COMPLETED', 'READY_TO_SHIP', 'PROCESSED', 'SHIPPED']) {
        try {
          faturamentoTotalLoja += await shopeeFaturamentoPeriodo(mcApiKey, shopId, inicioJanela.iso, ontem.iso, st);
        } catch (e) {}
      }
    }

    // O agente AJUSTA só campanhas em grupo/individuais (inclusive as em modo
    // "GMV Max - Meta de ROAS", que é lance automático DENTRO de uma campanha
    // individual). O GMV Max da Loja (campanha única que anuncia os produtos que
    // não estão nas individuais) fica fora dos ajustes — formato de escrita
    // nunca validado —, mas o gasto dele ENTRA no TACOS: o total de
    // shopee_ads_daily_performance já soma individuais + GMV Max da Loja
    // (conferido em 14/10/2026 na Mega Fácil, centavo a centavo).
    // Regra da Shopee (confirmada pelo analista): PAUSAR campanha individual só
    // pausa — o produto fica sem anúncio; só ENCERRAR faz o produto cair no GMV
    // Max da Loja. O agente pausa (Regras 1-2); encerrar fica com o analista.
    // Total de ADS da loja = campanhas individuais/grupo + GMV Max da Loja (o
    // relatório diário da Shopee já vem somado). O GMV Max da Loja é separado só
    // pra mostrar quanto foi de cada tipo — o agente não ajusta essa campanha.
    let gastoTotalOntem = 0, gmvTotalJanela = 0, gastoTotalJanela = 0, gmvMaxJanela = 0, gmvMaxVendasJanela = 0, fonteAds = 'api';
    if (baseCobreAds(base, inicioJanela.iso)) {
      const s = somarBase(base, inicioJanela.iso, ontem.iso);
      gastoTotalJanela = s.ads; gmvTotalJanela = s.ads_gmv;
      gastoTotalOntem = parseFloat(base.dias[ontem.iso]?.ads) || 0;
      for (const [d, v] of Object.entries(base.gmvMax)) if (d >= inicioJanela.iso && d <= ontem.iso) gmvMaxJanela += parseFloat(v) || 0;
      for (const [d, v] of Object.entries(base.gmvMaxVendas)) if (d >= inicioJanela.iso && d <= ontem.iso) gmvMaxVendasJanela += parseFloat(v) || 0;
      fonteAds = 'base';
    } else try {
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
    // Carência: campanha com orçamento/ROAS ajustado nas últimas 12h (ex.: no
    // acompanhamento do dia ou num "Rodar agora" anterior) não é ajustada de novo.
    const desde12h = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const recentes = await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(shopId)}&tipo=eq.decisao&resultado=eq.executado&criado_em=gte.${encodeURIComponent(desde12h)}&select=dados&limit=300`).catch(() => []);
    const ajustadasRecentes = new Set(recentes.filter(l => l.dados?.campaign_id != null && (l.dados.budget_para != null || l.dados.roas_para != null)).map(l => String(l.dados.campaign_id)));

    // TACOS da conta = investimento total em ADS ÷ faturamento TOTAL da loja
    // (não só a venda atribuída ao ADS) — é o critério principal, do jeito que
    // a GLR se baseia pra decisão, não ACOS isolado por campanha (esse mede
    // eficiência daquela campanha específica, útil pra comparar campanhas
    // entre si, mas não pra dizer se a conta como um todo está saudável).
    const tacosJanela = faturamentoTotalLoja > 0 ? (gastoTotalJanela / faturamentoTotalLoja) * 100 : (gastoTotalJanela > 0 ? Infinity : 0);
    // A GLR se guia pelo MÊS (e projeção do mês), não por 3-5 dias: o TACOS que
    // decide se a conta tem folga pra acelerar é o do mês até ontem (base). Sem
    // cobertura da base no mês, usa o da janela, como antes.
    const mesIniTacos = ontem.iso.slice(0, 8) + '01';
    let tacosMes = null;
    if (baseCobre(base, mesIniTacos) && baseCobreAds(base, mesIniTacos)) {
      const sm = somarBase(base, mesIniTacos, ontem.iso);
      if (sm.faturamento > 0) tacosMes = (sm.ads / sm.faturamento) * 100;
    }
    const tacosConta = tacosMes ?? tacosJanela;
    const rotuloTacos = tacosMes != null ? 'TACOS do mês' : 'TACOS da conta';
    // com teto de ADS do cliente, o teto manda; senão a meta da conta com 10% de folga antes de travar aumento de orçamento
    const tacosDentroDaMeta = contrato.tetoTacos ? tacosConta <= contrato.tetoTacos : (!cfg.meta_acos || tacosConta <= cfg.meta_acos * 1.1);
    const limiteTacosTxt = contrato.tetoTacos ? `do teto de ADS do cliente (${contrato.tetoTacos}%)` : `da meta (${cfg.meta_acos}%)`;

    // ACOS sem cancelados: a Shopee atribui ao ADS pedidos que depois foram
    // cancelados (na EAP, 24% do valor em out/2026), então o ACOS dela sai menor
    // que o real. Desconta pela taxa de cancelamento da loja na janela (base).
    let taxaCancel = 0, ticketRef = null;
    if (baseCobre(base, inicioJanela.iso)) {
      const t = somarBase(base, inicioJanela.iso, ontem.iso);
      const b = t.faturamento + t.valor_cancelado + t.valor_devolvido;
      taxaCancel = b > 0 ? Math.min(0.6, (t.valor_cancelado + t.valor_devolvido) / b) : 0;
    }
    const de30 = isoMenos(ontem.iso, 29);
    if (baseCobre(base, de30)) { const t30 = somarBase(base, de30, ontem.iso); if (t30.pedidos > 0) ticketRef = t30.faturamento / t30.pedidos; }
    // PAUSAR É ÚLTIMO RECURSO (orientação do analista): só quando a campanha
    // GASTA MUITO SEM RETORNO. "Muito" = custo de ADS de 3 vendas no ticket médio
    // da loja com a meta configurada (mín. R$ 50). ACOS alto com venda não pausa —
    // contém o gasto (meta de ROAS / orçamento), porque pausar antes disso é
    // ineficiente: tira do ar algo que vende.
    const limitePausa = Math.round(Math.max(50, ticketRef && cfg.meta_acos ? ticketRef * (cfg.meta_acos / 100) * 3 : 0) * 100) / 100;
    const explicaLimite = `limite de R$ ${limitePausa.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}${ticketRef && cfg.meta_acos ? ` = custo de ADS de 3 vendas no ticket médio de ${R$(ticketRef)} com meta de ${cfg.meta_acos}%` : ' (mínimo)'}`;

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

      const gmvAj = diario.gmv * (1 - taxaCancel); // vendas via ADS sem cancelados (estimado)
      const acosJanela = gmvAj > 0 ? diario.gasto / gmvAj : (diario.gasto > 0 ? Infinity : null);
      const acosShopee = diario.gmv > 0 ? diario.gasto / diario.gmv : null;
      const acosTxt = acosJanela == null || acosJanela === Infinity ? '∞' : `${(acosJanela * 100).toFixed(1)}%${taxaCancel > 0.005 && acosShopee != null ? ` (sem cancelados; ${(acosShopee * 100).toFixed(1)}% na Shopee)` : ''}`;
      const nome = settings.ad_name?.slice(0, 70) || `Campanha ${c.campaign_id}`;
      const inicioTs = settings.campaign_duration?.start_time || 0;
      const idadeDias = inicioTs ? (agoraTs - inicioTs) / 86400 : Infinity;
      const emMaturacao = idadeDias < diasMaturacao;
      // Estoque e margem dos produtos da campanha (mural): margem vira teto de ACOS
      const aviso = sinais ? estoqueMargem.avisosDe(sinais, settings.item_id_list) : null;
      const metaMargem = aviso?.aa != null && cfg.meta_acos && aviso.aa < cfg.meta_acos ? Math.max(0.5, aviso.aa) : null;
      const metaEf = metaMargem ?? cfg.meta_acos;
      const txtMeta = metaMargem != null ? `meta do produto (${metaEf}% — limite da margem de ${aviso.m}%${aviso.promo ? ' no preço da promoção' : ''}, pelo agente de ${aviso.promo ? 'Promoções' : 'Margem'})` : `meta (${cfg.meta_acos}%)`;
      const estoqueSegura = aviso && (aviso.ne === 'zerado' || aviso.ne === 'critico' || (aviso.dias != null && aviso.dias <= 10));
      // Reputação: conta em risco ou produto com reclamações repetidas não recebe aceleração
      const reputacaoSegura = sinais?.reputacao?.risco === 'alto' ? `a reputação da conta está em risco (${sinais.reputacao.motivo})` : aviso?.rp ? `${aviso.nome} tem ${aviso.rp}` : null;
      const qualidadeSegura = aviso?.qa ? `o anúncio de ${aviso.nome} precisa de conserto antes (${aviso.qa})` : null;

      if (!opc.soMomento) {
      // Produto sem estoque e a campanha ainda gastando → sugere pausar (aprovação)
      if (aviso?.ne === 'zerado' && diario.gastoOntem > 0 && pausaEstoquePendente.has(String(c.campaign_id))) continue;
      if (aviso?.ne === 'zerado' && diario.gastoOntem > 0) {
        await logar('alerta', `Sugestão de pausar — ${nome} (produto sem estoque)`,
          `O agente de Estoque avisou que "${aviso.nome}" está sem estoque, mas a campanha gastou ${R$(diario.gastoOntem)} ontem. Pausar até repor — anúncio sem estoque não converte e o clique é pago.`,
          { campaign_id: c.campaign_id, pausar: true, colaboracao: { de: 'estoque', produto: aviso.nome } }, 'so_alerta');
        alertas.push(nome);
        colaboracoes.push({ de: 'estoque', campanha: nome, texto: `sugeri pausar "${nome}": ${aviso.nome} está sem estoque` });
        continue;
      }

      // Regras 1 e 2 — pausa SÓ por gasto alto sem retorno: gastou acima do
      // limite na janela e (a) não vendeu nada ou (b) vendeu menos do que gastou
      // (ROAS < 1, sem cancelados). Campanha em maturação não é pausada — só
      // registra que o critério bateu.
      const semVenda = diario.pedidos === 0 || gmvAj <= 0;
      const bateuCriterioPausa = !!cfg.regra_pausa_acos
        && diario.gasto >= limitePausa
        && diario.diasComGasto >= Math.min(2, cfg.regra_pausa_dias || 3)
        && (semVenda || gmvAj < diario.gasto);

      if (bateuCriterioPausa) {
        if (emMaturacao) {
          await logar('sistema', `Maturação segurando pausa — ${nome}`,
            `Critério de pausa foi atingido (gastou ${R$(diario.gasto)} ${semVenda ? 'sem nenhuma venda' : `e vendeu só ${R$(gmvAj)} sem cancelados`} — ${explicaLimite}), mas a campanha tem só ${Math.floor(idadeDias)} dia(s) — abaixo dos ${diasMaturacao} dias mínimos de maturação configurados. Não pausada ainda.`,
            { acos: acosJanela === Infinity ? null : acosJanela * 100, idade_dias: Math.floor(idadeDias) }, 'so_alerta');
        } else if (semVenda) {
          await executarPausa(c.campaign_id, nome,
            `Gastou ${R$(diario.gasto)} em ${diario.diasComGasto} dia(s) nos últimos ${cfg.regra_pausa_dias || 3} dias sem gerar NENHUMA venda atribuída — acima do ${explicaLimite}. Campanha já madura (${Math.floor(idadeDias)} dias). Pausada por gastar muito sem retorno.`,
            { gasto: diario.gasto, gmv: 0, pedidos: 0, limite_pausa: limitePausa });
        } else {
          await executarPausa(c.campaign_id, nome,
            `Gastou ${R$(diario.gasto)} e vendeu só ${R$(gmvAj)} (sem cancelados; ${R$(diario.gmv)} na Shopee) nos últimos ${cfg.regra_pausa_dias || 3} dias — gasta mais do que vende (ROAS ${(gmvAj / diario.gasto).toFixed(2)}), acima do ${explicaLimite}. Campanha já madura (${Math.floor(idadeDias)} dias). Pausada por gastar muito sem retorno.`,
            { acos: acosJanela * 100, gasto: diario.gasto, gmv: diario.gmv, gmv_sem_cancelados: gmvAj, limite_pausa: limitePausa });
        }
        continue;
      }
      } // fim das regras de pausa (fora da rodada só da revisão de 3 dias)
      if (ajustadasRecentes.has(String(c.campaign_id))) continue; // ajustada há menos de 12h

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

      // Revisão de 3 dias (a cada 3 dias): venda do produto na loja (orgânico + ADS) nos últimos 3
      // dias × os 3 anteriores. Subindo, com ACOS dentro da meta e TACOS da loja com folga →
      // acelera para vender mais. Caindo → desfaz o aperto do próprio agente, ou, com o ACOS dentro
      // da meta, recupera exposição. Valem os mesmos limites: estoque, reputação, qualidade, TACOS
      // (teto do cliente ou meta), ROAS mínimo da meta, orçamento máximo e o contrato do cliente.
      if (momentoHoje && !emMaturacao) {
        const mo = momento(settings.item_id_list);
        if (mo) {
          const subindo = mo.b >= mo.a * 1.2 && mo.b - mo.a >= 100, caindo = mo.b <= mo.a * 0.8 && mo.a - mo.b >= 100;
          const moTxt = `a venda do produto (orgânico + ADS) foi de ${R$(mo.a)} nos 3 dias anteriores para ${R$(mo.b)} nos últimos 3 (${mo.b >= mo.a ? '+' : '−'}${Math.abs(mo.pct).toFixed(0)}%)`;
          const acosOk = acosJanela != null && acosJanela !== Infinity && acosJanela * 100 <= metaEf;
          const bloqueio = estoqueSegura ? `${aviso.nome} ${aviso.ne === 'zerado' ? 'está sem estoque' : `acaba em ~${Math.round(aviso.dias)} dia(s)`}`
            : reputacaoSegura || qualidadeSegura || (!tacosDentroDaMeta && tacosConta !== Infinity ? `o ${rotuloTacos} da loja (${tacosConta.toFixed(1)}%) está acima ${limiteTacosTxt}` : null);
          const ap = apertos.get(String(c.campaign_id));
          const apertado = ap && ((ap.roasAntes && temRoas && settings.roas_target > ap.roasAntes) || (ap.budgetAntes && budgetAtual < ap.budgetAntes));
          if (caindo && apertado) {
            const voltaRoas = ap.roasAntes && temRoas && settings.roas_target > ap.roasAntes;
            const expl = `Revisão de 3 dias: ${moTxt}, e o agente tinha apertado esta campanha (${voltaRoas ? `ROAS ${ap.roasAntes}x → ${settings.roas_target}x` : `orçamento ${R$(ap.budgetAntes)} → ${R$(budgetAtual)}`}). Voltei ${voltaRoas ? `a meta para ${ap.roasAntes}x` : `o orçamento para ${R$(ap.budgetAntes)}`}.`;
            const base = { freio_volume: true, momento: { a: Math.round(mo.a), b: Math.round(mo.b) }, colaboracao: { de: 'faturamento' } };
            if (contrato.desfazer === 'executar') {
              if (voltaRoas) await executarRoasTarget(c.campaign_id, nome, ap.roasAntes, expl, { ...base, desfeito_auto: true, roas_de: settings.roas_target, roas_para: ap.roasAntes });
              else await executarOrcamento(c.campaign_id, nome, ap.budgetAntes, expl, { ...base, desfeito_auto: true, budget_de: budgetAtual, budget_para: ap.budgetAntes });
              for (const l of freiosPend) if (String(l.dados.campaign_id) === String(c.campaign_id)) await sbUpdate('glr_agente_log', `id=eq.${l.id}`, { resultado: 'expirado' }).catch(() => {});
            } else if (!voltaPendente.has(String(c.campaign_id))) {
              await logar('alerta', `Sugestão de ${voltaRoas ? 'baixar meta de ROI' : 'aumento de orçamento'} — ${nome} (freio de volume)`, expl.replace('Voltei', 'A sugestão é voltar') + ' O contrato deste cliente pede aprovação para desfazer.',
                voltaRoas ? { ...base, campaign_id: c.campaign_id, roas_atual: settings.roas_target, roas_sugerido: ap.roasAntes } : { ...base, campaign_id: c.campaign_id, budget_atual: budgetAtual, budget_sugerido: ap.budgetAntes }, 'so_alerta');
              alertas.push(nome);
            }
            mom.desfeitas.push(nome);
            colaboracoes.push({ de: 'faturamento', campanha: nome, texto: `revisão de 3 dias: desfiz o aperto de "${nome}" — ${moTxt}` });
            continue;
          }
          if ((subindo || caindo) && acosOk && !bloqueio) {
            const motivo = subindo ? `${moTxt}. O produto está ganhando tração, o ACOS da campanha (${acosTxt}) está dentro da ${txtMeta} e o ${rotuloTacos} da loja tem folga — acelero para vender mais`
              : `${moTxt}, com o ACOS da campanha (${acosTxt}) dentro da ${txtMeta} — reforço a exposição antes que a queda continue`;
            const dadosMo = { acos: acosJanela * 100, tacos_conta: tacosConta, momento: { a: Math.round(mo.a), b: Math.round(mo.b), tipo: subindo ? 'subindo' : 'caindo' } };
            let feito = false;
            if (usarRoasAcelerar) {
              const piso = 100 / metaEf, roasAtual = settings.roas_target;
              const novoRoas = Math.round(Math.max(1, piso, roasAtual * 0.9) * 10) / 10; // nunca abaixo do ROAS da meta
              if (novoRoas < roasAtual) {
                const variacaoPct = (roasAtual - novoRoas) / roasAtual * 100;
                const explicacao = `Revisão de 3 dias: ${motivo}. Meta de ROI ${roasAtual}x → ${novoRoas}x (lance mais agressivo; não desce abaixo de ${(Math.round(piso * 10) / 10)}x, o ROAS da meta).`;
                if (cfg.alerta_variacao_pct && variacaoPct > cfg.alerta_variacao_pct) { await logar('alerta', `Sugestão de baixar meta de ROI — ${nome}`, explicacao + ' Variação acima do limite configurado pra execução automática — precisa de aprovação manual.', { campaign_id: c.campaign_id, roas_atual: roasAtual, roas_sugerido: novoRoas, ...dadosMo }, 'so_alerta'); alertas.push(nome); }
                else await executarRoasTarget(c.campaign_id, nome, novoRoas, explicacao, { ...dadosMo, roas_de: roasAtual, roas_para: novoRoas });
                feito = true;
              }
            } else if (budgetAtual > 0 && (!cfg.orcamento_max || budgetAtual < cfg.orcamento_max)) {
              const novoBudget = Math.round(Math.min(cfg.orcamento_max || Infinity, budgetAtual * 1.15) * 100) / 100;
              if (novoBudget > budgetAtual) {
                const variacaoPct = (novoBudget - budgetAtual) / budgetAtual * 100;
                const explicacao = `Revisão de 3 dias: ${motivo}. O orçamento está sendo consumido (média de ${R$(gastoMedioDia)}/dia de ${R$(budgetAtual)}): orçamento ${R$(budgetAtual)} → ${R$(novoBudget)}${cfg.orcamento_max ? ` (máximo da conta ${R$(cfg.orcamento_max)})` : ''}.`;
                if (cfg.alerta_variacao_pct && variacaoPct > cfg.alerta_variacao_pct) { await logar('alerta', `Sugestão de aumento de orçamento — ${nome}`, explicacao + ' Variação acima do limite configurado pra execução automática — precisa de aprovação manual.', { campaign_id: c.campaign_id, budget_atual: budgetAtual, budget_sugerido: novoBudget, ...dadosMo }, 'so_alerta'); alertas.push(nome); }
                else await executarOrcamento(c.campaign_id, nome, novoBudget, explicacao, { ...dadosMo, budget_de: budgetAtual, budget_para: novoBudget });
                feito = true;
              }
            }
            if (feito) {
              (subindo ? mom.aceleradas : mom.recuperadas).push(nome);
              colaboracoes.push({ de: 'faturamento', campanha: nome, texto: `revisão de 3 dias: ${subindo ? 'acelerei' : 'reforcei'} "${nome}" — ${moTxt}` });
              continue;
            }
            colaboracoes.push({ de: 'faturamento', campanha: nome, texto: `revisão de 3 dias: "${nome}" ${subindo ? 'subindo' : 'caindo'}, mas já está no limite (ROAS da meta / orçamento máximo)` });
          } else if (subindo) {
            mom.seguradas.push(nome);
            const mot = !bloqueio ? 'ACOS acima da meta' : estoqueSegura ? 'estoque' : reputacaoSegura ? 'reputação' : qualidadeSegura ? 'anúncio a consertar' : 'TACOS acima do limite';
            mom.motivos[mot] = (mom.motivos[mot] || 0) + 1;
            colaboracoes.push({ de: 'faturamento', campanha: nome, texto: `revisão de 3 dias: "${nome}" está subindo (${moTxt}), mas não acelerei — ${bloqueio || `o ACOS da campanha (${acosTxt}) está acima da ${txtMeta}`}` });
          }
        }
      }
      if (opc.soMomento) continue; // rodada só da revisão de 3 dias: as Regras 3 e 4 já rodaram hoje

      // Regra 3: ACOS da campanha bem abaixo da meta E a conta como um todo
      // ainda tem folga de TACOS → aumenta orçamento (ou baixa a meta de ROAS,
      // pra campanha automática — mesmo espírito, alavanca diferente). Sem
      // folga de TACOS, não aumenta automaticamente mesmo com campanha
      // eficiente — a conta como um todo já estaria investindo mais que o
      // saudável em ADS.
      if (cfg.meta_acos && acosJanela !== null && acosJanela !== Infinity && acosJanela * 100 <= metaEf * contrato.P.acelera && (budgetAtual > 0 || temRoas)) { // perfil: Crescer acelera antes
        if (qualidadeSegura && !reputacaoSegura) {
          colaboracoes.push({ de: 'qualidade', campanha: nome, texto: `segurei o aumento de "${nome}" (ACOS ${acosTxt}): ${qualidadeSegura}` });
          continue;
        }
        if (reputacaoSegura) {
          colaboracoes.push({ de: 'reputacao', campanha: nome, texto: `segurei o aumento de "${nome}" (ACOS ${acosTxt}): ${reputacaoSegura}` });
          continue;
        }
        if (estoqueSegura) {
          colaboracoes.push({ de: 'estoque', campanha: nome, texto: `segurei o aumento de "${nome}" (ACOS ${acosTxt}): ${aviso.nome} ${aviso.ne === 'zerado' ? 'está sem estoque' : `acaba em ~${Math.round(aviso.dias)} dia(s)`}` });
          continue;
        }
        if (!tacosDentroDaMeta) {
          await logar('sistema', `Aumento represado por TACOS — ${nome}`,
            `ACOS da campanha (${acosTxt}) sugeriria acelerar a campanha, mas o ${rotuloTacos} (${tacosConta.toFixed(1)}%) já está acima ${limiteTacosTxt} — não aumenta automaticamente enquanto isso não normalizar.`,
            { acos: acosJanela * 100, tacos_conta: tacosConta }, 'so_alerta');
          continue;
        }
        if (usarRoasAcelerar) {
          // Meta de ROI menor = lance mais agressivo = mais gasto/volume.
          // Nunca desce abaixo da meta de ROI da própria conta (100/meta_acos)
          // nem abaixo de 1.0 (mínimo aceito pela Shopee).
          const metaRoasConta = 100 / metaEf; // com limite de margem, não desce o ROAS abaixo do que a margem aguenta
          const roasAtual = settings.roas_target;
          const novoRoas = Math.round(Math.max(1, metaRoasConta, roasAtual * 0.85) * 10) / 10;
          if (novoRoas < roasAtual) {
            const variacaoPct = Math.abs((novoRoas - roasAtual) / roasAtual) * 100;
            const explicacao = `ACOS de ${acosTxt} está bem abaixo da meta, e o ${rotuloTacos} (${tacosConta.toFixed(1)}%) ainda tem folga. ${budgetAtual > 0 && !orcamentoSaturado ? `O orçamento diário (${R$(budgetAtual)}) não está sendo consumido por completo (média de ${R$(gastoMedioDia)}/dia), então subir orçamento não ajudaria — o limitador é o lance.` : 'Campanha usa lance automático.'} Baixando a meta de ROI de ${roasAtual}x pra ${novoRoas}x pra deixar o lance mais agressivo e captar mais volume.`;
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
            const explicacao = `ACOS de ${acosTxt} está bem abaixo da meta, e o ${rotuloTacos} (${tacosConta.toFixed(1)}%) ainda tem folga em relação à meta (${cfg.meta_acos}%). Orçamento atual ${R$(budgetAtual)}, proposto ${R$(novoBudget)} (+${variacaoPct.toFixed(0)}%).`;
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

      // Regra 4: ACOS acima da meta (com venda) → CONTÉM o gasto em vez de
      // pausar: sobe a meta de ROI (lance automático) ou corta orçamento. Acima
      // do "ACOS de contenção forte" (antigo limite de pausa) o passo é 25% em
      // vez de 15%. Corte é seguro independente do TACOS geral.
      if (cfg.meta_acos && acosJanela !== null && acosJanela !== Infinity && acosJanela * 100 > metaEf * contrato.P.contem && !emMaturacao) { // perfil: Crescer tolera 15% acima da meta antes de conter
        const queda = quedaDeVenda(settings.item_id_list);
        if (queda) {
          const ap = apertos.get(String(c.campaign_id));
          const quedaTxt = `as vendas do produto na loja (orgânico + ADS) caíram de ${R$(queda.a)} para ${R$(queda.b)} na última semana (−${queda.pct.toFixed(0)}%)`;
          if (ap && (contrato.desfazer === 'executar' || !voltaPendente.has(String(c.campaign_id))) && ((ap.roasAntes && temRoas && settings.roas_target > ap.roasAntes) || (ap.budgetAntes && budgetAtual < ap.budgetAntes))) {
            const dia = new Date(Date.parse(ap.desde) - 3 * 3600e3).toISOString().slice(5, 10).split('-').reverse().join('/');
            const voltaRoas = ap.roasAntes && temRoas && settings.roas_target > ap.roasAntes;
            // Nível 2 (contrato "desfazer: executar"): desfaz sozinho o próprio aperto que derrubou a venda
            if (contrato.desfazer === 'executar') {
              const expl = `Desfeito automaticamente: desde ${dia} o agente apertou esta campanha (${voltaRoas ? `ROAS ${ap.roasAntes}x → ${settings.roas_target}x` : `orçamento ${R$(ap.budgetAntes)} → ${R$(budgetAtual)}`}) por causa do ACOS da campanha (${acosTxt}; ${rotuloTacos} da loja: ${tacosConta === Infinity ? '—' : `${tacosConta.toFixed(1)}%`}), e ${quedaTxt}. Voltei ${voltaRoas ? `a meta para ${ap.roasAntes}x` : `o orçamento para ${R$(ap.budgetAntes)}`}; o agente segue acompanhando o faturamento do produto.`;
              const base = { freio_volume: true, desfeito_auto: true, venda_antes: Math.round(queda.a), venda_agora: Math.round(queda.b), colaboracao: { de: 'faturamento' } };
              if (voltaRoas) await executarRoasTarget(c.campaign_id, nome, ap.roasAntes, expl, { ...base, roas_de: settings.roas_target, roas_para: ap.roasAntes });
              else await executarOrcamento(c.campaign_id, nome, ap.budgetAntes, expl, { ...base, budget_de: budgetAtual, budget_para: ap.budgetAntes });
              colaboracoes.push({ de: 'faturamento', campanha: nome, texto: `desfiz o aperto de "${nome}": ${quedaTxt}` });
              // a sugestão de voltar que estava na Caixa de decisões já foi feita pelo agente
              for (const l of freiosPend) if (String(l.dados.campaign_id) === String(c.campaign_id)) await sbUpdate('glr_agente_log', `id=eq.${l.id}`, { resultado: 'expirado' }).catch(() => {});
              continue;
            }
            await logar('alerta', `Sugestão de ${voltaRoas ? 'baixar meta de ROI' : 'aumento de orçamento'} — ${nome} (freio de volume)`,
              `Desde ${dia} o agente apertou esta campanha (${voltaRoas ? `meta de ROAS de ${ap.roasAntes}x para ${settings.roas_target}x` : `orçamento de ${R$(ap.budgetAntes)} para ${R$(budgetAtual)}`}) por causa do ACOS da campanha (${acosTxt}; ${rotuloTacos} da loja: ${tacosConta === Infinity ? '—' : `${tacosConta.toFixed(1)}%`}), e ${quedaTxt}. Apertar mais derruba ainda mais a venda — a sugestão é voltar ${voltaRoas ? `a meta para ${ap.roasAntes}x` : `o orçamento para ${R$(ap.budgetAntes)}`} e acompanhar o faturamento do produto, não só o ACOS.`,
              voltaRoas ? { campaign_id: c.campaign_id, roas_atual: settings.roas_target, roas_sugerido: ap.roasAntes, freio_volume: true, venda_antes: Math.round(queda.a), venda_agora: Math.round(queda.b), colaboracao: { de: 'faturamento' } }
                : { campaign_id: c.campaign_id, budget_atual: budgetAtual, budget_sugerido: ap.budgetAntes, freio_volume: true, venda_antes: Math.round(queda.a), venda_agora: Math.round(queda.b), colaboracao: { de: 'faturamento' } }, 'so_alerta');
            alertas.push(nome);
            colaboracoes.push({ de: 'faturamento', campanha: nome, texto: `sugeri desfazer o aperto de "${nome}": ${quedaTxt}` });
          } else {
            colaboracoes.push({ de: 'faturamento', campanha: nome, texto: `não apertei "${nome}" (ACOS ${acosTxt}): ${quedaTxt}` });
          }
          continue;
        }
        // Quem governa é o TACOS da loja: com ele dentro do limite (teto do cliente ou meta da conta), ACOS
        // um pouco acima da meta numa campanha não é motivo para frear — só se a campanha passar do limite
        // da margem do produto (vende no prejuízo) ou do ACOS de contenção forte.
        const forteAcos = !!cfg.regra_pausa_acos && acosJanela * 100 > cfg.regra_pausa_acos;
        const prejuizo = metaMargem != null && acosJanela * 100 > metaMargem;
        // ...mas campanha a mais que o dobro da meta da conta precisa de otimização mesmo com o TACOS ok
        if (tacosConta !== Infinity && tacosDentroDaMeta && !forteAcos && !prejuizo && acosJanela * 100 <= cfg.meta_acos * 2) {
          colaboracoes.push({ de: 'faturamento', campanha: nome, texto: `não contive "${nome}" (ACOS ${acosTxt}): o ${rotuloTacos} da loja (${tacosConta.toFixed(1)}%) está dentro ${limiteTacosTxt}` });
          continue;
        }
        if (metaMargem != null && acosJanela * 100 <= cfg.meta_acos) colaboracoes.push({ de: aviso.promo ? 'promocoes' : 'margem', campanha: nome, texto: `contive "${nome}": ACOS ${acosTxt} cabe na meta da conta, mas passa do limite da margem do produto (${metaEf}%)` });
        const forte = !!cfg.regra_pausa_acos && acosJanela * 100 > cfg.regra_pausa_acos;
        const passo = forte ? 0.25 : 0.15;
        const tacosTxtC = tacosConta !== Infinity ? ` O ${rotuloTacos} da loja está em ${tacosConta.toFixed(1)}%${tacosDentroDaMeta ? '' : `, acima ${limiteTacosTxt}`}.` : '';
        const motivoConter = forte ? `bem acima da meta (${cfg.meta_acos}%) e do limite de contenção forte (${cfg.regra_pausa_acos}%), mas a campanha vende — então contenho com mais força em vez de pausar` : `acima da ${txtMeta}, mas a campanha vende — contenho o gasto em vez de pausar`;
        if (usarRoasConter) {
          const roasAtual = settings.roas_target;
          const novoRoas = Math.min(SHOPEE_ROAS_TARGET_MAX, Math.round(roasAtual * (1 + passo) * 10) / 10);
          const variacaoPct = Math.abs((novoRoas - roasAtual) / roasAtual) * 100;
          const explicacao = `ACOS da campanha de ${acosTxt} ${motivoConter}.${tacosTxtC} Campanha usa lance automático — subindo a meta de ROI de ${roasAtual}x pra ${novoRoas}x pra deixar o lance mais conservador.`;
          if (cfg.alerta_variacao_pct && variacaoPct > cfg.alerta_variacao_pct) {
            await logar('alerta', `Sugestão de subir meta de ROI — ${nome}`, explicacao + ' Variação acima do limite configurado pra execução automática — precisa de aprovação manual.', { campaign_id: c.campaign_id, roas_atual: roasAtual, roas_sugerido: novoRoas }, 'so_alerta');
            alertas.push(nome);
          } else {
            await executarRoasTarget(c.campaign_id, nome, novoRoas, explicacao, { acos: acosJanela * 100, roas_de: roasAtual, roas_para: novoRoas });
          }
        } else if (budgetAtual > (cfg.orcamento_min || 0)) {
          const novoBudget = Math.max(cfg.orcamento_min || 0, Math.round(budgetAtual * (1 - passo) * 100) / 100);
          if (novoBudget < budgetAtual) {
            const variacaoPct = Math.abs((novoBudget - budgetAtual) / budgetAtual) * 100;
            const explicacao = `ACOS da campanha de ${acosTxt} ${motivoConter}.${tacosTxtC} Reduzindo orçamento de ${R$(budgetAtual)} pra ${R$(novoBudget)} sem desligar a campanha.`;
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

    if (opc.soMomento) {
      await registrarMomento();
      return { conta_id: shopId, momento: { aceleradas: mom.aceleradas.length, recuperadas: mom.recuperadas.length, desfeitas: mom.desfeitas.length, seguradas: mom.seguradas.length } };
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
      // Com a base: últimos 7 dias vs os 7 anteriores, faturamento válido (sem
      // cancelados), direto do resumo diário. Sem a base: o jeito antigo
      // (relatório gravado 1 janela atrás).
      let diasJanela = Math.max(1, cfg.regra_pausa_dias || 3);
      let faturamentoSaudeAtual = faturamentoTotalLoja, faturamentoSaudeAnterior = null;
      if (baseCobre(base, isoMenos(ontem.iso, 13))) {
        diasJanela = 7;
        faturamentoSaudeAtual = somarBase(base, isoMenos(ontem.iso, 6), ontem.iso).faturamento;
        faturamentoSaudeAnterior = somarBase(base, isoMenos(ontem.iso, 13), isoMenos(ontem.iso, 7)).faturamento;
      } else {
        const dataRelatorioAnterior = dataBRT(1 + diasJanela).iso;
        const relatorioAnterior = await sbSelect('glr_agente_relatorios', `conta_id=eq.${encodeURIComponent(shopId)}&data=eq.${dataRelatorioAnterior}&select=metricas&limit=1`).catch(() => []);
        faturamentoSaudeAnterior = relatorioAnterior[0]?.metricas?.faturamento_total_loja;
      }
      const variacaoSaude = faturamentoSaudeAnterior > 0 ? ((faturamentoSaudeAtual - faturamentoSaudeAnterior) / faturamentoSaudeAnterior) * 100 : null;

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
          const gmvC = diario.gmv * (1 - taxaCancel); // sem cancelados
          const acosC = gmvC > 0 ? (diario.gasto / gmvC) * 100 : (diario.gasto > 0 ? Infinity : null);
          if (acosC == null || acosC === Infinity) continue;
          if (cfg.meta_acos && acosC > cfg.meta_acos) continue; // só reforça campanha dentro da meta
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
              explicacao = `Faturamento total da loja caiu ${Math.abs(variacaoSaude).toFixed(1)}% na janela de ${diasJanela} dia(s) vs a janela anterior equivalente (${R$(faturamentoSaudeAtual)} vs ${R$(faturamentoSaudeAnterior)}). "${melhor.nome}" é a campanha ativa mais eficiente (ACOS ${melhor.acos.toFixed(1)}%) — baixando meta de ROAS de ${melhor.roasTarget}x pra ${novoRoas}x pra tentar puxar mais volume e ajudar a reverter a queda.`;
            }
          } else if (melhor.budget > 0) {
            const novoBudget = Math.round(Math.min(cfg.orcamento_max || Infinity, melhor.budget * 1.2) * 100) / 100;
            if (novoBudget > melhor.budget) {
              dadosSug.budget_atual = melhor.budget; dadosSug.budget_sugerido = novoBudget;
              titulo = `Queda de faturamento — reforçar ${melhor.nome}`;
              explicacao = `Faturamento total da loja caiu ${Math.abs(variacaoSaude).toFixed(1)}% na janela de ${diasJanela} dia(s) vs a janela anterior equivalente (${R$(faturamentoSaudeAtual)} vs ${R$(faturamentoSaudeAnterior)}). "${melhor.nome}" é a campanha ativa mais eficiente (ACOS ${melhor.acos.toFixed(1)}%) — subindo orçamento de ${R$(melhor.budget)} pra ${R$(novoBudget)} pra tentar puxar mais volume e ajudar a reverter a queda.`;
            }
          }
          if (titulo) {
            await logar('alerta', titulo, explicacao, dadosSug, 'so_alerta');
            alertas.push(titulo);
          }
        }
      }
    } catch (e) { /* saúde do negócio é bônus — não derruba a revisão diária se falhar */ }

    // Regra 6 — Curva ABC semana a semana (pedido do analista): avisa quando um
    // produto curva A cai (só alerta — pode ser estoque, preço, anúncio; o
    // analista decide junto) e sugere reforçar ADS de produto B/C que está
    // subindo. A sugestão só é aprovável quando o produto está numa campanha
    // individual ativa dentro da meta (orçamento +20% ou ROAS objetivo −15%);
    // sem campanha própria vira recomendação de criar uma. Um aviso por produto
    // a cada 7 dias. Lê só a base — zero chamada nova à Shopee.
    try {
      if (baseCobre(base, isoMenos(ontem.iso, curvaABC.NSEM * 7 - 1))) {
        const curva = curvaABC.curvaSemanal(await curvaABC.lerPedidosCurva(sbSelect, 'shopee', shopId, ontem.iso), ontem.iso);
        const recentes = await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(shopId)}&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 6.5 * 86400000).toISOString())}&select=dados&limit=500`).catch(() => []);
        const avisados = new Set(recentes.map(l => l.dados?.chave).filter(k => String(k || '').startsWith('abc:')));
        // produto → campanha individual ativa que o anuncia
        const campanhaDoItem = {};
        for (const [id, st] of Object.entries(settingsPorId)) {
          if ((st.campaign_status || '').toLowerCase() !== 'ongoing') continue;
          for (const it of (st.item_id_list || [])) campanhaDoItem[String(it)] = { id: Number(id), st };
        }
        const acosDe = id => { const d = diarioPorId[id]; if (!d) return null; const g = d.gmv * (1 - taxaCancel); return g > 0 ? d.gasto / g * 100 : (d.gasto > 0 ? Infinity : null); };
        const fmtAcos = a => a == null ? 'sem dados' : a === Infinity ? '∞' : `${a.toFixed(1)}%`;
        const tacosFolga = tacosMes == null || !cfg.meta_acos || tacosMes <= cfg.meta_acos * 1.1;
        const linhaSemana = x => `${x.ult} un. na última semana contra média de ${curvaABC.n1(x.media)} nas 3 anteriores (${curvaABC.varTxt(x.var)}; ${R$(x.ultRs)} vs ${R$(x.mediaRs)})`;

        for (const x of curva.aCaindo.slice(0, 4)) {
          const chave = `abc:${x.chave}`;
          if (avisados.has(chave)) continue;
          const camp = campanhaDoItem[x.item_id];
          const ads = camp
            ? `Está na campanha individual "${(camp.st.ad_name || camp.id).toString().slice(0, 60)}" (ACOS ${fmtAcos(acosDe(camp.id))} na janela).`
            : 'Não está em campanha individual ativa — só aparece pelo GMV Max da Loja (se estiver ligado).';
          const titulo = `Curva A ${x.tend === 'parou' ? 'parou de vender' : 'em queda'} — ${x.nome.slice(0, 60)}`;
          await logar('alerta', titulo,
            `Produto curva A (${curvaABC.n1(x.part)}% do faturamento das últimas 4 semanas): ${linhaSemana(x)}. ${ads} Vale revisar juntos: estoque, preço/concorrência, anúncio (fotos, avaliações) e ADS antes de mexer no orçamento.`,
            { chave, origem_analise: 'curva_abc_semanal', produto_id: x.item_id, classe: x.classe, tendencia: x.tend, unidades_ultima: x.ult, media_3_semanas: Math.round(x.media * 10) / 10, variacao_pct: x.var == null ? null : Math.round(x.var), perda_semana: Math.round(x.deltaRs * 100) / 100, ...(camp ? { campanha_produto: camp.id } : {}) }, 'so_alerta');
          alertas.push(titulo);
        }

        for (const x of curva.sobeBC.slice(0, 3)) {
          const chave = `abc:${x.chave}`;
          if (avisados.has(chave)) continue;
          const camp = campanhaDoItem[x.item_id];
          const titulo = `Curva ${x.classe} subindo — reforçar ${x.nome.slice(0, 55)}`;
          const base0 = { chave, origem_analise: 'curva_abc_semanal', produto_id: x.item_id, classe: x.classe, tendencia: x.tend, unidades_ultima: x.ult, media_3_semanas: Math.round(x.media * 10) / 10, variacao_pct: x.var == null ? null : Math.round(x.var) };
          if (camp && tacosFolga) {
            const acos = acosDe(camp.id), nome = (camp.st.ad_name || `Campanha ${camp.id}`).slice(0, 70);
            const budget = parseFloat(camp.st.campaign_budget) || 0, roasT = camp.st.roas_target;
            if (acos != null && acos !== Infinity && (!cfg.meta_acos || acos <= cfg.meta_acos)) {
              const dados = { ...base0, campaign_id: camp.id };
              let acao = null;
              if (budget === 0 && roasT) {
                const novo = Math.round(Math.max(1, 100 / (cfg.meta_acos || 8), roasT * 0.85) * 10) / 10;
                if (novo < roasT) { dados.roas_atual = roasT; dados.roas_sugerido = novo; acao = `baixar a meta de ROAS de ${roasT}x para ${novo}x`; }
              } else if (budget > 0) {
                const novo = Math.round(Math.min(cfg.orcamento_max || Infinity, budget * 1.2) * 100) / 100;
                if (novo > budget) { dados.budget_atual = budget; dados.budget_sugerido = novo; acao = `subir o orçamento de ${R$(budget)} para ${R$(novo)}`; }
              }
              if (acao) {
                await logar('alerta', titulo, `Produto curva ${x.classe} em ${curvaABC.TEND_TXT[x.tend]}: ${linhaSemana(x)} — candidato a virar curva A. A campanha "${nome}" está dentro da meta (ACOS ${fmtAcos(acos)})${tacosMes != null ? ` e o TACOS do mês está em ${tacosMes.toFixed(1)}%` : ''}: ${acao} para aproveitar a alta. Confira o estoque antes de aprovar.`, dados, 'so_alerta');
                alertas.push(titulo);
                continue;
              }
            }
          }
          if (!camp) {
            await logar('alerta', titulo, `Produto curva ${x.classe} em ${curvaABC.TEND_TXT[x.tend]}: ${linhaSemana(x)} — candidato a virar curva A, mas não tem campanha individual (só o GMV Max da Loja). Vale criar uma campanha própria para ele${tacosFolga ? '' : ' quando o TACOS do mês voltar para a meta'}. Confira o estoque antes.`, base0, 'so_alerta');
            alertas.push(titulo);
          }
        }
      }
    } catch (e) { /* curva ABC é bônus — não derruba a revisão diária */ }

    // Colaboração com os agentes de Estoque e de Margem (um registro por revisão)
    if (colaboracoes.length) {
      await logar('sistema', `Colaboração com Estoque e Margem — ${colaboracoes.length} decisão(ões)`, // título mantido: o Escritório reconhece por ele
        colaboracoes.slice(0, 12).map(x => `• ${x.texto}`).join('\n'), { colaboracoes: colaboracoes.slice(0, 30) }, 'executado');
    }

    // Resultado das ações de 8+ dias atrás (7 dias antes × 7 depois)
    let medidas = 0;
    try { medidas = await medirResultadosShopee(cfg, mcApiKey, shopId, taxaCancel); } catch (e) { /* medição é bônus */ }
    try { await medirSombraShopee(cfg, mcApiKey, shopId, taxaCancel); } catch (e) { /* modo sombra é bônus */ }

    if (momentoHoje) await registrarMomento();

    // Resumo de execução do dia (sempre grava, mesmo sem nenhuma ação — é o
    // registro de que o agente rodou e revisou a conta)
    await logar('sistema', `Revisão diária concluída — ${decisoes.length} ação(ões), ${alertas.length} alerta(s)`,
      `Revisadas ${campanhasAtivas} campanhas ativas (de ${campanhas.length} listadas, incluindo histórico antigo). ${rotuloTacos}: ${tacosConta === Infinity ? '∞' : tacosConta.toFixed(1) + '%'} (meta: ${cfg.meta_acos ?? '—'}%). ${decisoes.length} decisão(ões) executada(s) automaticamente, ${alertas.length} alerta(s) aguardando aprovação manual.`,
      { campanhas: campanhasAtivas, campanhas_listadas: campanhas.length, decisoes: decisoes.length, alertas: alertas.length, tacos_conta: tacosConta === Infinity ? null : tacosConta, medidas }, 'executado');

    // 2) Relatório diário com IA
    const contexto = await contextoNegocio(shopId, ontem.iso).catch(() => ({}));
    const mesIni = ontem.iso.slice(0, 8) + '01';
    if (baseCobre(base, isoMenos(mesIni, 31))) {
      // Mês até ontem vs os mesmos dias do mês anterior
      const d = parseInt(ontem.iso.slice(8, 10));
      const ini = new Date(`${mesIni}T12:00:00Z`); ini.setUTCMonth(ini.getUTCMonth() - 1);
      const antIni = ini.toISOString().slice(0, 10);
      const antFim = isoMenos(antIni, -(d - 1));
      contexto.mes = { atual: somarBase(base, mesIni, ontem.iso).faturamento, anterior: somarBase(base, antIni, antFim).faturamento };
      contexto.mes.var = variacao(contexto.mes.atual, contexto.mes.anterior);
    }
    const metricas = { gasto_ontem: gastoTotalOntem, gmv_janela: gmvTotalJanela, gasto_janela: gastoTotalJanela, gmv_max_janela: gmvMaxJanela, gmv_max_vendas_janela: gmvMaxVendasJanela, faturamento_total_loja: faturamentoTotalLoja, tacos_conta: tacosConta === Infinity ? null : tacosConta, tacos_mes: tacosMes, tacos_janela: tacosJanela === Infinity ? null : tacosJanela, acos_janela: gastoTotalJanela > 0 ? (gastoTotalJanela / (gmvTotalJanela || 1)) * 100 : 0, decisoes: decisoes.length, alertas: alertas.length, campanhas_revisadas: campanhasAtivas, campanhas_listadas: campanhas.length, fonte_faturamento: fonteFaturamento, fonte_ads: fonteAds, contexto };
    const resumo = await gerarRelatorio(anthropicKey, cfg, metricas, decisoes, alertas, ontem);
    await sbUpsert('glr_agente_relatorios', { data: ontem.iso, conta_id: shopId, cliente_nome: cfg.cliente_nome || null, resumo, metricas }, 'data,conta_id');

    return { conta_id: shopId, campanhas: campanhasAtivas, campanhas_listadas: campanhas.length, decisoes: decisoes.length, alertas: alertas.length, tacos_conta: tacosConta === Infinity ? null : tacosConta };
  } catch (e) {
    await logar('sistema', 'Erro na revisão diária', e.message || String(e), {}, 'erro');
    return { conta_id: shopId, erro: e.message };
  }
}

// ── Acompanhamento do dia em andamento (12h, 16h, 20h) ─────────────────────
// Não refaz as Regras 1-5 da manhã (mesmos dados de ontem = mesma conclusão).
// Olha só o que muda DURANTE o dia:
//   A) campanha eficiente com orçamento quase esgotado cedo → sobe orçamento
//      (dentro dos guardrails; acima do limite de variação vira aprovação)
//   B) campanha gastando sem vender hoje → ALERTA com sugestão de pausa
//      (nunca pausa sozinho no meio do dia)
//   C) vendas da loja hoje vs o mesmo horário dos 7 dias anteriores (base)
// Campanha já ajustada hoje não é mexida de novo.
async function processarAcompanhamento(cfg, mcApiKey) {
  const shopId = cfg.conta_id;
  const { dia: hojeIso, hora } = agoraBRT();
  const hoje = dataBRT(0), ontemIso = dataBRT(1).iso;
  const decisoes = [], alertas = [];
  async function logar(tipo, titulo, explicacao, dados, resultado) {
    try {
      await sbInsert('glr_agente_log', { conta_id: shopId, cliente_nome: cfg.cliente_nome || null, tipo, titulo, explicacao, dados: dados || {}, resultado: resultado || 'executado', origem: 'cron' });
    } catch (e) {}
  }
  try {
    const inicioHoje = new Date(`${hojeIso}T00:00:00-03:00`).toISOString();
    const logsHoje = await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(shopId)}&criado_em=gte.${encodeURIComponent(inicioHoje)}&select=tipo,titulo,resultado,dados&limit=500`).catch(() => []);
    const mexidasHoje = new Set(logsHoje.filter(l => l.tipo === 'decisao' && l.resultado === 'executado' && l.dados?.campaign_id != null).map(l => String(l.dados.campaign_id)));
    const titulosHoje = new Set(logsHoje.map(l => l.titulo));

    // Referência dos últimos 7 dias (base): TACOS e ticket médio
    const base = await lerBase('shopee', shopId);
    const s7 = baseCobre(base, isoMenos(ontemIso, 6)) ? somarBase(base, isoMenos(ontemIso, 6), ontemIso) : null;
    // TACOS de referência = o do MÊS até ontem (a GLR se guia pelo mês); no dia 1
    // (mês ainda sem dia fechado) ou sem base no mês, usa os últimos 7 dias.
    const mesIniA = hojeIso.slice(0, 8) + '01';
    const sMes = ontemIso >= mesIniA && baseCobre(base, mesIniA) && baseCobreAds(base, mesIniA) ? somarBase(base, mesIniA, ontemIso) : null;
    const tacos7 = sMes && sMes.faturamento > 0 ? (sMes.ads / sMes.faturamento) * 100 : (s7 && s7.faturamento > 0 ? (s7.ads / s7.faturamento) * 100 : null);
    const rotuloTacosA = sMes && sMes.faturamento > 0 ? 'TACOS do mês' : 'TACOS dos últimos 7 dias';
    const ticket7 = s7 && s7.pedidos > 0 ? s7.faturamento / s7.pedidos : null;
    const tetoA = (await contratoDaConta(shopId)).tetoTacos;
    const tacosOk = tacos7 == null || (tetoA ? tacos7 <= tetoA : (!cfg.meta_acos || tacos7 <= cfg.meta_acos * 1.1));

    // Campanhas ativas + desempenho de HOJE (parcial)
    const campanhas = await listarTodasCampanhas(mcApiKey, shopId);
    const settingsPorId = {};
    await Promise.all(chunk(campanhas.map(c => c.campaign_id), 20).map(async lote => {
      const r = await mcpCall(mcApiKey, 'shopee_ads_campaign_settings', { shopId, campaign_id_list: lote.join(',') }).catch(() => null);
      (r?.data?.response?.campaign_list || r?.response?.campaign_list || []).forEach(c => { settingsPorId[c.campaign_id] = { ...(c.common_info || {}), roas_target: c.auto_bidding_info?.roas_target ?? null }; });
    }));
    const ativas = campanhas.map(c => c.campaign_id).filter(id => (settingsPorId[id]?.campaign_status || '').toLowerCase() === 'ongoing');
    const hojePorId = {};
    await Promise.all(chunk(ativas, 20).map(async lote => {
      const r = await mcpCall(mcApiKey, 'shopee_ads_campaign_daily', { shopId, campaign_id_list: lote.join(','), start_date: hoje.ddmmyyyy, end_date: hoje.ddmmyyyy }).catch(() => null);
      (r?.data?.response?.campaign_list || r?.response?.campaign_list || []).forEach(c => {
        const d = (c.metrics_list || []).find(x => x.date === hoje.ddmmyyyy) || {};
        hojePorId[c.campaign_id] = { gasto: parseFloat(d.expense) || 0, gmv: parseFloat(d.broad_gmv) || 0, pedidos: parseInt(d.broad_order) || 0 };
      });
    }));

    const diasMaturacao = cfg.dias_maturacao_campanha ?? 7;
    const agoraTs = Date.now() / 1000;
    let gastoHojeTotal = 0;
    for (const id of ativas) {
      const st = settingsPorId[id], h = hojePorId[id];
      if (!st || !h) continue;
      gastoHojeTotal += h.gasto;
      if (mexidasHoje.has(String(id))) continue;
      const nome = (st.ad_name || `Campanha ${id}`).slice(0, 70);
      const budget = parseFloat(st.campaign_budget) || 0;
      const acosHoje = h.gmv > 0 ? (h.gasto / h.gmv) * 100 : null;
      const inicioTs = st.campaign_duration?.start_time || 0;
      const emMaturacao = inicioTs ? (agoraTs - inicioTs) / 86400 < diasMaturacao : false;

      // A) orçamento quase esgotado antes das 18h, campanha eficiente hoje
      if (budget > 0 && hora < 18 && h.gasto >= budget * 0.9 && acosHoje != null && cfg.meta_acos && acosHoje <= cfg.meta_acos * 0.8) {
        if (!tacosOk) {
          const titulo = `Orçamento esgotando, aumento represado por TACOS — ${nome}`;
          if (!titulosHoje.has(titulo)) await logar('sistema', titulo, `Já gastou ${R$(h.gasto)} de ${R$(budget)} até as ${hora}h com ACOS de ${acosHoje.toFixed(1)}% hoje, mas o ${rotuloTacosA} (${tacos7.toFixed(1)}%) está acima ${tetoA ? `do teto de ADS do cliente (${tetoA}%)` : `da meta (${cfg.meta_acos}%)`}. Não aumentei.`, { campaign_id: id, gasto_hoje: h.gasto, budget, tacos_7d: tacos7 }, 'so_alerta');
        } else if (!cfg.orcamento_max || budget < cfg.orcamento_max) {
          const novo = Math.round(Math.min(cfg.orcamento_max || Infinity, budget * 1.2) * 100) / 100;
          const varPct = ((novo - budget) / budget) * 100;
          const explicacao = `Até as ${hora}h já gastou ${R$(h.gasto)} de ${R$(budget)} (${Math.round(h.gasto / budget * 100)}% do orçamento) com ACOS de ${acosHoje.toFixed(1)}% hoje, bem abaixo da meta (${cfg.meta_acos}%)${tacos7 != null ? `, e o ${rotuloTacosA} está em ${tacos7.toFixed(1)}%` : ''}. Sem aumento, a campanha sai do ar antes do fim do dia. Orçamento ${R$(budget)} → ${R$(novo)}.`;
          const ctrA = await contratoDaConta(shopId);
          if ((cfg.alerta_variacao_pct && varPct > cfg.alerta_variacao_pct) || ctrA.ajuste === 'sugerir') {
            await logar('alerta', `Sugestão de aumento de orçamento — ${nome}`, explicacao + (ctrA.ajuste === 'sugerir' ? ' O contrato deste cliente pede aprovação para ajustar.' : ' Variação acima do limite configurado pra execução automática — precisa de aprovação manual.'), { campaign_id: id, budget_atual: budget, budget_sugerido: novo }, 'so_alerta');
            alertas.push(nome);
          } else if (novo > budget) {
            try {
              await mcpCall(mcApiKey, 'shopee_ads_edit_campaign', { shopId, campaign_id: Number(id), params: { campaign_id: Number(id), budget: novo, edit_action: 'change_budget', reference_id: `glr-agente-${Date.now()}-${id}` } });
              await logar('decisao', `Orçamento ajustado — ${nome}`, explicacao, { campaign_id: Number(id), budget_de: budget, budget_para: novo, gasto_hoje: h.gasto, acos_hoje: acosHoje, rodada: `${hora}h` }, 'executado');
              decisoes.push(nome);
            } catch (e) {
              await logar('decisao', `Falha ao ajustar orçamento — ${nome}`, `Tentei ajustar por: ${explicacao} — mas deu erro: ${e.message}`, { campaign_id: Number(id) }, 'erro');
            }
          }
        }
        continue;
      }

      // B) gastando sem vender hoje — só alerta (pausa precisa de aprovação)
      const limiteSemVenda = Math.max(20, ticket7 && cfg.meta_acos ? ticket7 * (cfg.meta_acos / 100) * 2 : 0);
      if (!emMaturacao && h.pedidos === 0 && h.gmv === 0 && h.gasto >= limiteSemVenda) {
        const titulo = `Gastando sem vender hoje — ${nome}`;
        if (!titulosHoje.has(titulo)) {
          await logar('alerta', titulo, `Até as ${hora}h gastou ${R$(h.gasto)} hoje sem nenhuma venda atribuída — acima de ${R$(limiteSemVenda)} (o custo de ADS de 2 vendas no ticket médio de ${ticket7 ? R$(ticket7) : '—'} com a meta de ${cfg.meta_acos ?? '—'}%). Sugestão: pausar e revisar; aprove se concordar.`, { campaign_id: Number(id), pausar: true, gasto_hoje: h.gasto }, 'so_alerta');
          alertas.push(nome);
        }
      }
    }

    // C) ritmo de vendas da loja hoje vs o mesmo horário dos 7 dias anteriores
    let ritmo = null;
    if (baseCobre(base, isoMenos(hojeIso, 7))) {
      const agoraMs = Date.now();
      const decorridoMs = agoraMs - new Date(`${hojeIso}T00:00:00-03:00`).getTime();
      const contar = async diaIso => {
        const ini = new Date(`${diaIso}T00:00:00-03:00`).getTime();
        return sbCount('glr_pedidos', `marketplace=eq.shopee&conta_id=eq.${encodeURIComponent(shopId)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(new Date(ini).toISOString())}&criado_em=lt.${encodeURIComponent(new Date(ini + decorridoMs).toISOString())}`);
      };
      const hojeN = await contar(hojeIso);
      const anteriores = [];
      for (let k = 1; k <= 7; k++) anteriores.push(await contar(isoMenos(hojeIso, k)));
      const media = anteriores.reduce((a, b) => a + b, 0) / anteriores.length;
      ritmo = { hoje: hojeN, media: Math.round(media * 10) / 10, var: variacao(hojeN, media) };
      if (media >= 5 && hojeN <= media * 0.7) {
        const titulo = `Vendas de hoje abaixo do ritmo (${hora}h)`;
        if (![...titulosHoje].some(t => t.startsWith('Vendas de hoje abaixo do ritmo'))) {
          await logar('alerta', titulo, `Até as ${hora}h a loja teve ${hojeN} pedido(s) válidos, contra média de ${ritmo.media} no mesmo horário dos últimos 7 dias (${ritmo.var.toFixed(0)}%). ADS gasto hoje até agora: ${R$(gastoHojeTotal)}. Vale olhar estoque, preço e campanhas principais antes do fim do dia.`, { pedidos_hoje: hojeN, media_7d: ritmo.media, gasto_ads_hoje: gastoHojeTotal }, 'so_alerta');
          alertas.push(titulo);
        }
      }
    }

    const ritmoTxt = ritmo ? ` Vendas até agora: ${ritmo.hoje} pedido(s) vs média de ${ritmo.media} no mesmo horário (${ritmo.var == null ? '—' : `${ritmo.var >= 0 ? '+' : ''}${ritmo.var.toFixed(0)}%`}).` : '';
    // GMV Max da Loja hoje (base; só reporta — o agente não ajusta essa campanha)
    const gmvLojaHoje = parseFloat(base.gmvMax?.[hojeIso]);
    const gmvLojaVendasHoje = parseFloat(base.gmvMaxVendas?.[hojeIso]) || 0;
    const gmvTxt = !isNaN(gmvLojaHoje) ? ` GMV Max da Loja hoje: ${R$(gmvLojaHoje)} investidos, ${R$(gmvLojaVendasHoje)} em vendas (ROAS ${gmvLojaHoje > 0 ? (gmvLojaVendasHoje / gmvLojaHoje).toFixed(1) : '—'}).` : '';
    await logar('sistema', `Acompanhamento das ${hora}h — ${decisoes.length} ação(ões), ${alertas.length} alerta(s)`,
      `Acompanhamento do dia: ${ativas.length} campanhas individuais ativas, ADS gasto hoje nelas ${R$(gastoHojeTotal)}.${gmvTxt}${ritmoTxt}${tacos7 != null ? ` ${rotuloTacosA}: ${tacos7.toFixed(1)}%.` : ''}`,
      { rodada: `${hora}h`, campanhas: ativas.length, gasto_hoje: gastoHojeTotal, gmv_loja_hoje: isNaN(gmvLojaHoje) ? null : gmvLojaHoje, gmv_loja_vendas_hoje: gmvLojaVendasHoje, ritmo, tacos_7d: tacos7, decisoes: decisoes.length, alertas: alertas.length }, 'executado');
    return { conta_id: shopId, rodada: `${hora}h`, decisoes: decisoes.length, alertas: alertas.length, ritmo };
  } catch (e) {
    await logar('sistema', `Erro no acompanhamento das ${hora}h`, e.message || String(e), {}, 'erro');
    return { conta_id: shopId, erro: e.message };
  }
}

function textoContexto(ctx) {
  const pct = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const partes = [];
  if (ctx?.mes) partes.push(`Mês até ontem: ${R$(ctx.mes.atual)} vs ${R$(ctx.mes.anterior)} nos mesmos dias do mês anterior (${pct(ctx.mes.var)}).`);
  if (ctx?.cliente) partes.push(`Cliente${ctx.cliente.nome ? ` ${ctx.cliente.nome}` : ''} inteiro (${ctx.cliente.lojas.length} lojas): ${R$(ctx.cliente.fat7)} nos últimos 7 dias vs ${R$(ctx.cliente.fatAnt)} nos 7 anteriores (${pct(ctx.cliente.var)}). Por loja: ${ctx.cliente.lojas.map(l => `${l.loja} (${l.mkt === 'ml' ? 'Mercado Livre' : 'Shopee'}) ${pct(l.var)}`).join('; ')}.`);
  if (ctx?.quedas?.length) partes.push(`Produtos que mais caíram (7 dias vs 7 anteriores): ${ctx.quedas.map(q => `${q.nome}${q.curvaA ? ' [curva A]' : ''} ${R$(q.p)} → ${R$(q.a)}`).join('; ')}.`);
  if (ctx?.altas?.length) partes.push(`Produtos que mais subiram: ${ctx.altas.map(q => `${q.nome} ${R$(q.p)} → ${R$(q.a)}`).join('; ')}.`);
  return partes.join(' ');
}

async function gerarRelatorio(anthropicKey, cfg, metricas, decisoes, alertas, ontem) {
  const base = `Resumo do dia ${ontem.iso} para a conta ${cfg.cliente_nome || cfg.conta_id}: `
    + `investimento total em ADS ${R$(metricas.gasto_janela)} na janela avaliada${metricas.gmv_max_janela ? ` — ${R$(metricas.gasto_janela - metricas.gmv_max_janela)} nas campanhas em grupo/individuais (que o agente gerencia) e ${R$(metricas.gmv_max_janela)} no GMV Max da Loja (campanha de manutenção que anuncia os produtos fora das individuais; vendas ${R$(metricas.gmv_max_vendas_janela)}, ROAS ${metricas.gmv_max_janela > 0 ? (metricas.gmv_max_vendas_janela / metricas.gmv_max_janela).toFixed(1) : '—'}; o agente só acompanha, não ajusta)` : ''}, vendas atribuídas ao ADS ${R$(metricas.gmv_janela)}, faturamento TOTAL da loja no período ${R$(metricas.faturamento_total_loja)}. `
    + `TACOS da conta (investimento ADS ÷ faturamento total): ${metricas.tacos_conta == null ? '∞' : metricas.tacos_conta.toFixed(1) + '%'} (meta: ${cfg.meta_acos || '—'}%) — essa é a métrica principal usada pra decisão, não o ACOS isolado por campanha. `
    + `${metricas.decisoes} ação(ões) executada(s): ${decisoes.join(', ') || 'nenhuma'}. `
    + `${metricas.alertas} alerta(s) aguardando aprovação: ${alertas.join(', ') || 'nenhum'}. `
    + textoContexto(metricas.contexto);

  if (!anthropicKey) return base;

  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const r = await client.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 900,
      system: 'Você escreve relatórios diários curtos e diretos pra um analista de e-commerce sobre um agente autônomo de ADS na Shopee. Português do Brasil, tom objetivo e prático, sem enrolação. A métrica principal de saúde da conta é o TACOS (investimento ADS sobre faturamento TOTAL da loja), não ACOS isolado por campanha — trate ACOS como detalhe de eficiência de campanha individual, não como veredito sobre a conta. Quando houver contexto do negócio (mês contra mês anterior, cliente inteiro com todas as lojas, produtos que caíram/subiram), use-o para dizer se a conta está crescendo ou caindo e por quê — destaque produto curva A em queda. Formato: 1 parágrafo de visão geral, depois bullets pras ações tomadas (se houver) e alertas pendentes (se houver). Nunca invente números — use só os dados fornecidos.',
      messages: [{ role: 'user', content: base }],
    });
    return r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || base;
  } catch (e) {
    return base;
  }
}
