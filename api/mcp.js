// Proxy serverless para MarketplaceConnect (tiops.com.br)
// A API key fica no ambiente Vercel — nunca exposta ao browser do cliente

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'MCP_API_KEY não configurada no servidor' });

  const { action, params } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action obrigatória' });

  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(403).json({ error: `Ação '${action}' não permitida via portal` });
  }

  try {
    const resp = await fetch('https://mcp.tiops.com.br', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ action, params: params || {} }),
    });

    const data = await resp.json();
    return res.status(resp.ok ? 200 : resp.status).json(data);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
