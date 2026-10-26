// Proxy serverless para MarketplaceConnect (tiops.com.br) — usado pelo Portal do Cliente.
// A API key fica no ambiente Vercel — nunca exposta ao browser do cliente.
//
// Segurança (17/10/2026): antes este proxy não exigia login nem conferia a
// conta — qualquer pessoa na internet podia ler pedidos/anúncios de qualquer
// cliente com a chave da GLR. Agora:
//  • exige o token de login do Supabase (Authorization: Bearer ...);
//  • usuário que é cliente do portal (glr_portal_configs) só acessa as contas
//    vinculadas a ele: a lista de contas volta filtrada e toda ação precisa
//    dizer a conta (meliUserId/shopId/...) — sem conta, o Tiops usaria a conta
//    "atual" da GLR, então é recusada;
//  • equipe GLR (logado e fora da lista do portal) segue sem restrição de conta.

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
// Chave pública (anon) do projeto — a mesma que vai no front; só serve para validar o token
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJyb2RxbGVqcXlhb29tdXRyaWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjU5NjUsImV4cCI6MjA5NjQ0MTk2NX0.JaKQHoGH8S3ZdLQInLErpC21SZ0j4FmIGtvWKcBes-A';

const ALLOWED_ACTIONS = new Set([
  'list_accounts','credits_status',
  'list_orders_detail',           // ML paginado (mlOrders)
  'get_item','get_items','product_items','raw',
  'shopee_list_orders','shopee_get_order_detail',
  'shopee_get_escrow_detail','shopee_get_escrow_detail_batch',
  'shopee_list_items','shopee_get_items_batch',
  'low_stock_items','list_items',
  'shopee_search_items','search',
  'shopee_ads_daily_performance','shopee_ads_campaigns',
  'shopee_ads_campaign_settings','shopee_ads_campaign_daily',
  'shopee_ads_balance',
  'ml_ads_campaigns',
]);

// Portal: ações administrativas da GLR nunca; escrita livre nunca.
const BLOQUEADAS_PORTAL = /^(credits_status|ai_credits_status|me|raw_write|marketplace_action|billing_.*|suporte_.*|agente_.*|link_.*|anuncio_.*|photo_.*|video_.*|gerar_prompt|bling_.*|olist_.*|upload_clip.*|delete_clip|get_clips)$/;
// Consultas de catálogo (categorias/atributos) não são de conta nenhuma
const CATALOGO_LIVRE = new Set(['search_categories', 'ml_site_categories', 'ml_category_detail', 'category_attributes', 'ml_catalog_domain_categories', 'ml_category_sale_terms', 'ml_listing_fees', 'ml_lookup_ncm', 'tiktok_get_categories', 'tiktok_category_rules', 'tiktok_get_category_attributes', 'tiktok_recommend_category']);

const CAMPOS_CONTA = ['meliUserId', 'meli_user_id', 'account_id', 'shopId', 'shop_id', 'seller_id', 'amazon_account_id', 'magalu_account_id'];

async function usuarioDoToken(token) {
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.email ? u : null;
}

let _cfgCache = { em: 0, lista: [] };
async function configsPortal() {
  if (Date.now() - _cfgCache.em < 60000) return _cfgCache.lista;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?chave=eq.glr_portal_configs&select=dados`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const rows = r.ok ? await r.json() : [];
  const lista = Array.isArray(rows[0]?.dados) ? rows[0].dados : [];
  _cfgCache = { em: Date.now(), lista };
  return lista;
}

// Medidor de consumo da cota (api/_consumo.js): as telas também gastam ações da
// Tiops. Conta em memória e grava no máximo 1x por minuto por instância.
const consumo = require('./_consumo');
const { waitUntil } = require('@vercel/functions');
let ultimaGravacao = Date.now();
const sbSvc = (path, init = {}) => { const key = process.env.SUPABASE_SERVICE_ROLE_KEY; return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } }); };
function gravarConsumoTelas() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || Date.now() - ultimaGravacao < 60000) return;
  ultimaGravacao = Date.now();
  waitUntil(consumo.gravar(
    (t, qs) => sbSvc(`${t}?${qs}`).then(r => r.json()),
    (t, rows, oc) => sbSvc(`${t}?on_conflict=${oc}`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) }),
    'telas').catch(() => {}));
}

async function tiops(apiKey, action, params) {
  consumo.contar(action);
  const r = await fetch('https://mcp.tiops.com.br', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ action, params }) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `Tiops ${r.status}`);
  return j;
}

// params: { meliUserId | shopId, itens: [{ id, valor }] } — valor = custo total
// do produto (0 = apaga). Chaves iguais às da tela: ML = id; Shopee = id e nome.
async function salvarCustoPortal(apiKey, p) {
  const itens = Array.isArray(p.itens) ? p.itens.slice(0, 100) : [];
  if (!itens.length) throw new Error('Nenhum item informado');
  const valorDe = new Map();
  for (const it of itens) {
    const v = Number(it?.valor);
    if (!it?.id || !isFinite(v) || v < 0 || v > 1e6) throw new Error('Valor de custo inválido');
    valorDe.set(String(it.id), Math.round(v * 100) / 100);
  }
  const ids = [...valorDe.keys()];
  const chaves = []; // [chave, valor]
  if (p.meliUserId) {
    for (let i = 0; i < ids.length; i += 20) {
      const r = await tiops(apiKey, 'get_items', { meliUserId: p.meliUserId, ids: ids.slice(i, i + 20) });
      const arr = Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : []);
      for (const e of arr) {
        const b = e?.body || e;
        if (b?.id && String(b.seller_id) === String(p.meliUserId) && valorDe.has(String(b.id))) chaves.push([String(b.id), valorDe.get(String(b.id))]);
      }
    }
  } else if (p.shopId) {
    for (let i = 0; i < ids.length; i += 50) {
      const r = await tiops(apiKey, 'shopee_get_items_batch', { shopId: p.shopId, item_id_list: ids.slice(i, i + 50).map(Number) });
      for (const d of (r?.data?.response?.item_list || r?.response?.item_list || r?.data?.item_list || [])) {
        const v = valorDe.get(String(d.item_id)); if (v == null) continue;
        chaves.push([String(d.item_id), v]);
        if (d.item_name) chaves.push([d.item_name, v]);
      }
    }
  } else throw new Error('Informe a conta');
  if (!chaves.length) throw new Error('Nenhum anúncio desta conta encontrado');

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?chave=eq.glr_vendas_custo_catalogo&select=dados`, { headers: H });
  const rows = r.ok ? await r.json() : null;
  if (!rows) throw new Error('Não consegui ler o catálogo de custos');
  const cat = rows[0]?.dados && typeof rows[0].dados === 'object' && !Array.isArray(rows[0].dados) ? rows[0].dados : {};
  for (const [k, v] of chaves) { if (v > 0) cat[k] = v; else delete cat[k]; }
  const w = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?on_conflict=chave`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ chave: 'glr_vendas_custo_catalogo', dados: cat, atualizado_em: new Date().toISOString() }),
  });
  if (!w.ok) throw new Error('Não consegui salvar o custo');
  return { ok: true, chaves: Object.fromEntries(chaves) };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'MCP_API_KEY não configurada no servidor' });

  const { action, params } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action obrigatória' });

  // 1) Login obrigatório
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let usuario;
  try { usuario = await usuarioDoToken(token); } catch (e) { usuario = null; }
  if (!usuario) return res.status(401).json({ error: 'Faça login novamente para continuar.' });

  // Equipe GLR usa a chave direto no próprio navegador; aqui ela só tem o conjunto antigo
  // 2) Cliente do portal: só as contas dele
  let contasPermitidas = null; // null = equipe GLR, sem restrição
  try {
    const cfg = (await configsPortal()).find(c => String(c.email || '').toLowerCase() === usuario.email.toLowerCase() && c.ativo !== false);
    if (cfg) contasPermitidas = new Set((cfg.contaIds || []).map(String));
  } catch (e) { return res.status(500).json({ error: 'Não consegui conferir o acesso: ' + e.message }); }

  if (!contasPermitidas && !ALLOWED_ACTIONS.has(action)) return res.status(403).json({ error: `Ação '${action}' não permitida via proxy` });
  const p = params || {};
  if (contasPermitidas) {
    // Cliente do portal: qualquer ação da PRÓPRIA conta (promoções, anúncios,
    // financeiro, conciliação), menos as administrativas da GLR
    if (BLOQUEADAS_PORTAL.test(action)) return res.status(403).json({ error: 'Ação não disponível no portal' });
    if (action !== 'list_accounts' && !CATALOGO_LIVRE.has(action)) {
      const contas = CAMPOS_CONTA.map(k => p[k]).filter(v => v != null && v !== '').map(String);
      if (!contas.length) return res.status(403).json({ error: 'Informe a conta da consulta' });
      if (contas.some(c => !contasPermitidas.has(c))) return res.status(403).json({ error: 'Conta não vinculada ao seu acesso' });
      if (action === 'raw' && String(p.method || 'GET').toUpperCase() !== 'GET') return res.status(403).json({ error: 'Somente leitura' });
    }
  }

  // Custo do produto lançado pelo cliente no portal (tela Produtos). O banco não
  // deixa o portal gravar; aqui o servidor confere que cada anúncio é da conta
  // do cliente e grava só essas chaves no catálogo de custos.
  if (action === 'glr_portal_salvar_custo') {
    if (!contasPermitidas) return res.status(403).json({ error: 'Somente para o portal do cliente' });
    try { return res.status(200).json(await salvarCustoPortal(apiKey, p)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }

  try {
    consumo.contar(action); gravarConsumoTelas();
    const resp = await fetch('https://mcp.tiops.com.br', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ action, params: p }),
    });
    const data = await resp.json();
    // Lista de contas: o cliente do portal só enxerga as dele
    if (contasPermitidas && action === 'list_accounts') {
      const filtra = arr => (Array.isArray(arr) ? arr : []).filter(c => contasPermitidas.has(String(c.external_id)));
      if (Array.isArray(data?.accounts)) data.accounts = filtra(data.accounts);
      if (Array.isArray(data?.data?.accounts)) data.data.accounts = filtra(data.data.accounts);
      if (Array.isArray(data?.data)) data.data = filtra(data.data);
      delete data.current;
    }
    return res.status(resp.ok ? 200 : resp.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
