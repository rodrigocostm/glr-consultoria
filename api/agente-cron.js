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

// Ferramentas compartilhadas que o agente do ML (api/_agente-ml.js) usa.
function ajudantesML() {
  return { sbSelect, sbInsert, sbUpdate, lerSinais, lerBase, baseCobre, baseCobreAds, somarBase, isoMenos, dataBRT, R$, mcpCall };
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

  // Gerente de Conta: ?rodada=gerente (agenda das 08:00, uma vez por dia) ou
  // ?rodada=gerente&cliente_id=X ("Gerar plano agora" na tela Plano de ação)
  if (req.query?.rodada === 'gerente') {
    const ajud = { sbSelect, sbUpsert, lerStorage, anthropicKey, Anthropic };
    try {
      // a tela manda a meta que acabou de salvar (o glr_storage pode ainda não ter recebido)
      const metaNova = req.query?.meta != null || req.query?.meta_pedidos != null ? { cliente: req.query.cliente_id, meta: req.query.meta, metaPedidos: req.query.meta_pedidos } : null;
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
      waitUntil(Promise.all(configs.map(cfg => ehML(cfg)
        ? processarContaML(cfg, mcApiKey, ajudantesML())
        : rodada === 'completa'
          ? processarConta(cfg, mcApiKey, anthropicKey, ontem, dataBRT(Math.max(1, cfg.regra_pausa_dias || 3)))
          : processarAcompanhamento(cfg, mcApiKey)))
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

    // Contas em paralelo — sequencial estourava os 60s do plano com mais de
    // 1 conta ativa (cada conta já faz vários round-trips pra Tiops).
    const resultados = await Promise.all(configs.map(cfg => {
      if (ehML(cfg)) return processarContaML(cfg, mcApiKey, ajudantesML());
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
    const colaboracoes = []; // o que mudou por causa do Estoque/Margem (vai para o registro e o Escritório)
    // ── Freio de volume (conversa com o Raio-X do faturamento do Gerente) ──
    // Apertar ROAS/orçamento melhora o ACOS, mas pode derrubar a VENDA do produto
    // (o Raio-X de 28/10 achou 22 das maiores quedas logo depois de apertos do
    // próprio agente). Antes de conter, olha a venda do produto na loja inteira
    // (orgânico + ADS): últimos 7 dias × 7 anteriores, e os apertos dos últimos 21 dias.
    const vendasProd = new Map();
    try {
      const d7 = isoMenos(ontem.iso, 6), d14 = isoMenos(ontem.iso, 13);
      for (let off = 0; off < 40000; off += 1000) {
        const rows = await sbSelect('glr_pedidos', `marketplace=eq.shopee&conta_id=eq.${encodeURIComponent(shopId)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(new Date(`${d14}T03:00:00Z`).toISOString())}&select=criado_em,itens&order=criado_em.asc&limit=1000&offset=${off}`);
        for (const p of rows) {
          const dia = new Date(Date.parse(p.criado_em) - 3 * 3600e3).toISOString().slice(0, 10);
          if (dia > ontem.iso) continue;
          for (const i of (p.itens || [])) {
            const v = vendasProd.get(String(i.item_id)) || { a: 0, b: 0 };
            v[dia >= d7 ? 'b' : 'a'] += (parseFloat(i.preco) || 0) * (parseInt(i.qtd) || 1);
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
    const voltaPendente = new Set((await sbSelect('glr_agente_log', `conta_id=eq.${encodeURIComponent(shopId)}&tipo=eq.alerta&resultado=eq.so_alerta&criado_em=gte.${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}&select=dados&limit=300`).catch(() => []))
      .filter(l => l.dados?.freio_volume).map(l => String(l.dados.campaign_id)));
    function quedaDeVenda(itemIds) {
      if (!vendasProd.size) return null;
      let a = 0, b = 0;
      for (const id of (itemIds || [])) { const v = vendasProd.get(String(id)); if (v) { a += v.a; b += v.b; } }
      return a >= 300 && b < a * 0.75 ? { a, b, pct: (1 - b / a) * 100 } : null;
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
    const tacosDentroDaMeta = !cfg.meta_acos || tacosConta <= cfg.meta_acos * 1.1; // 10% de folga antes de travar aumento de orçamento

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

      // Regra 3: ACOS da campanha bem abaixo da meta E a conta como um todo
      // ainda tem folga de TACOS → aumenta orçamento (ou baixa a meta de ROAS,
      // pra campanha automática — mesmo espírito, alavanca diferente). Sem
      // folga de TACOS, não aumenta automaticamente mesmo com campanha
      // eficiente — a conta como um todo já estaria investindo mais que o
      // saudável em ADS.
      if (cfg.meta_acos && acosJanela !== null && acosJanela !== Infinity && acosJanela * 100 <= metaEf * 0.7 && (budgetAtual > 0 || temRoas)) {
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
            `ACOS da campanha (${acosTxt}) sugeriria acelerar a campanha, mas o ${rotuloTacos} (${tacosConta.toFixed(1)}%) já está acima da meta (${cfg.meta_acos}%) — não aumenta automaticamente enquanto isso não normalizar.`,
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
      if (cfg.meta_acos && acosJanela !== null && acosJanela !== Infinity && acosJanela * 100 > metaEf && !emMaturacao) {
        const queda = quedaDeVenda(settings.item_id_list);
        if (queda) {
          const ap = apertos.get(String(c.campaign_id));
          const quedaTxt = `as vendas do produto na loja (orgânico + ADS) caíram de ${R$(queda.a)} para ${R$(queda.b)} na última semana (−${queda.pct.toFixed(0)}%)`;
          if (ap && !voltaPendente.has(String(c.campaign_id)) && ((ap.roasAntes && temRoas && settings.roas_target > ap.roasAntes) || (ap.budgetAntes && budgetAtual < ap.budgetAntes))) {
            const dia = new Date(Date.parse(ap.desde) - 3 * 3600e3).toISOString().slice(5, 10).split('-').reverse().join('/');
            const voltaRoas = ap.roasAntes && temRoas && settings.roas_target > ap.roasAntes;
            await logar('alerta', `Sugestão de ${voltaRoas ? 'baixar meta de ROI' : 'aumento de orçamento'} — ${nome} (freio de volume)`,
              `Desde ${dia} o agente apertou esta campanha (${voltaRoas ? `meta de ROAS de ${ap.roasAntes}x para ${settings.roas_target}x` : `orçamento de ${R$(ap.budgetAntes)} para ${R$(budgetAtual)}`}) por causa do ACOS (${acosTxt}), e ${quedaTxt}. Apertar mais derruba ainda mais a venda — a sugestão é voltar ${voltaRoas ? `a meta para ${ap.roasAntes}x` : `o orçamento para ${R$(ap.budgetAntes)}`} e acompanhar o faturamento do produto, não só o ACOS.`,
              voltaRoas ? { campaign_id: c.campaign_id, roas_atual: settings.roas_target, roas_sugerido: ap.roasAntes, freio_volume: true, venda_antes: Math.round(queda.a), venda_agora: Math.round(queda.b), colaboracao: { de: 'faturamento' } }
                : { campaign_id: c.campaign_id, budget_atual: budgetAtual, budget_sugerido: ap.budgetAntes, freio_volume: true, venda_antes: Math.round(queda.a), venda_agora: Math.round(queda.b), colaboracao: { de: 'faturamento' } }, 'so_alerta');
            alertas.push(nome);
            colaboracoes.push({ de: 'faturamento', campanha: nome, texto: `sugeri desfazer o aperto de "${nome}": ${quedaTxt}` });
          } else {
            colaboracoes.push({ de: 'faturamento', campanha: nome, texto: `não apertei "${nome}" (ACOS ${acosTxt}): ${quedaTxt}` });
          }
          continue;
        }
        if (metaMargem != null && acosJanela * 100 <= cfg.meta_acos) colaboracoes.push({ de: aviso.promo ? 'promocoes' : 'margem', campanha: nome, texto: `contive "${nome}": ACOS ${acosTxt} cabe na meta da conta, mas passa do limite da margem do produto (${metaEf}%)` });
        const forte = !!cfg.regra_pausa_acos && acosJanela * 100 > cfg.regra_pausa_acos;
        const passo = forte ? 0.25 : 0.15;
        const motivoConter = forte ? `bem acima da meta (${cfg.meta_acos}%) e do limite de contenção forte (${cfg.regra_pausa_acos}%), mas a campanha vende — então contenho com mais força em vez de pausar` : `acima da ${txtMeta}, mas a campanha vende — contenho o gasto em vez de pausar`;
        if (usarRoasConter) {
          const roasAtual = settings.roas_target;
          const novoRoas = Math.min(SHOPEE_ROAS_TARGET_MAX, Math.round(roasAtual * (1 + passo) * 10) / 10);
          const variacaoPct = Math.abs((novoRoas - roasAtual) / roasAtual) * 100;
          const explicacao = `ACOS de ${acosTxt} ${motivoConter}. Campanha usa lance automático — subindo a meta de ROI de ${roasAtual}x pra ${novoRoas}x pra deixar o lance mais conservador.`;
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
            const explicacao = `ACOS de ${acosTxt} ${motivoConter}. Reduzindo orçamento de ${R$(budgetAtual)} pra ${R$(novoBudget)} sem desligar a campanha.`;
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
    const tacosOk = tacos7 == null || !cfg.meta_acos || tacos7 <= cfg.meta_acos * 1.1;

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
          if (!titulosHoje.has(titulo)) await logar('sistema', titulo, `Já gastou ${R$(h.gasto)} de ${R$(budget)} até as ${hora}h com ACOS de ${acosHoje.toFixed(1)}% hoje, mas o ${rotuloTacosA} (${tacos7.toFixed(1)}%) está acima da meta (${cfg.meta_acos}%). Não aumentei.`, { campaign_id: id, gasto_hoje: h.gasto, budget, tacos_7d: tacos7 }, 'so_alerta');
        } else if (!cfg.orcamento_max || budget < cfg.orcamento_max) {
          const novo = Math.round(Math.min(cfg.orcamento_max || Infinity, budget * 1.2) * 100) / 100;
          const varPct = ((novo - budget) / budget) * 100;
          const explicacao = `Até as ${hora}h já gastou ${R$(h.gasto)} de ${R$(budget)} (${Math.round(h.gasto / budget * 100)}% do orçamento) com ACOS de ${acosHoje.toFixed(1)}% hoje, bem abaixo da meta (${cfg.meta_acos}%)${tacos7 != null ? `, e o ${rotuloTacosA} está em ${tacos7.toFixed(1)}%` : ''}. Sem aumento, a campanha sai do ar antes do fim do dia. Orçamento ${R$(budget)} → ${R$(novo)}.`;
          if (cfg.alerta_variacao_pct && varPct > cfg.alerta_variacao_pct) {
            await logar('alerta', `Sugestão de aumento de orçamento — ${nome}`, explicacao + ' Variação acima do limite configurado pra execução automática — precisa de aprovação manual.', { campaign_id: id, budget_atual: budget, budget_sugerido: novo }, 'so_alerta');
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
