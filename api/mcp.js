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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'MCP_API_KEY não configurada no servidor' });

  const { action, params } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action obrigatória' });
  if (!ALLOWED_ACTIONS.has(action)) return res.status(403).json({ error: `Ação '${action}' não permitida via portal` });

  // 1) Login obrigatório
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let usuario;
  try { usuario = await usuarioDoToken(token); } catch (e) { usuario = null; }
  if (!usuario) return res.status(401).json({ error: 'Faça login novamente para continuar.' });

  // 2) Cliente do portal: só as contas dele
  let contasPermitidas = null; // null = equipe GLR, sem restrição
  try {
    const cfg = (await configsPortal()).find(c => String(c.email || '').toLowerCase() === usuario.email.toLowerCase() && c.ativo !== false);
    if (cfg) contasPermitidas = new Set((cfg.contaIds || []).map(String));
  } catch (e) { return res.status(500).json({ error: 'Não consegui conferir o acesso: ' + e.message }); }

  const p = params || {};
  if (contasPermitidas) {
    if (action === 'credits_status') return res.status(403).json({ error: 'Ação não disponível no portal' });
    if (action !== 'list_accounts') {
      const contas = CAMPOS_CONTA.map(k => p[k]).filter(v => v != null && v !== '').map(String);
      if (!contas.length) return res.status(403).json({ error: 'Informe a conta da consulta' });
      if (contas.some(c => !contasPermitidas.has(c))) return res.status(403).json({ error: 'Conta não vinculada ao seu acesso' });
      if (action === 'raw' && String(p.method || 'GET').toUpperCase() !== 'GET') return res.status(403).json({ error: 'Somente leitura' });
    }
  }

  try {
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
