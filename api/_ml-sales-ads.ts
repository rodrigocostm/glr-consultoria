const { randomUUID } = require('node:crypto');

const ACCOUNT = '802228249';
const DATABASE = 'https://rrodqlejqyaoomutriiw.supabase.co';
const MERCADO_LIVRE = 'https://api.mercadolibre.com';
const TOOL = 'get_ml_sales_ads_summary';
const PAGE_SIZE = 50;
const MAX_ORDERS = 1000;

const tool = {
  name: TOOL,
  description: 'Resume pedidos e Product Ads da Expresso Móveis para datas inclusivas no horário de Brasília.',
  inputSchema: {
    type: 'object',
    required: ['conta_id', 'inicio', 'fim'],
    additionalProperties: false,
    properties: {
      conta_id: { type: 'string', enum: [ACCOUNT] },
      inicio: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      fim: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

class ConsultationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function dateMs(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const valueMs = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(valueMs) && new Date(valueMs).toISOString().slice(0, 10) === value ? valueMs : NaN;
}

type Parameters = { conta_id: string; inicio: string; fim: string };
function validate(params: Parameters) {
  const start = dateMs(params?.inicio);
  const end = dateMs(params?.fim);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start >= 31 * 86400000 || params.fim > today) {
    throw new ConsultationError(400, 'Informe datas válidas, até hoje, em um intervalo de no máximo 31 dias.');
  }
}

function dbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new ConsultationError(503, 'Armazenamento da GLR indisponível.');
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

async function grantForAccount(signal: AbortSignal) {
  const response = await fetch(DATABASE + '/rest/v1/glr_config_privada?chave=eq.ml_oauth:' + ACCOUNT + '&select=valor', {
    headers: dbHeaders(), signal, redirect: 'error',
  });
  if (!response.ok) throw new ConsultationError(503, 'Não foi possível consultar a autorização da loja.');
  const row = (await response.json())[0];
  const grant = row && JSON.parse(row.valor);
  if (String(grant?.user_id) !== ACCOUNT || typeof grant?.access_token !== 'string' || !(Date.parse(grant.expira_em) > Date.now())) {
    throw new ConsultationError(409, 'Reconecte a Expresso Móveis antes de consultar.');
  }
  return grant.access_token as string;
}

async function mlGet(token: string, signal: AbortSignal, path: string, params: Record<string, string> = {}, version?: string) {
  const url = new URL(path, MERCADO_LIVRE);
  url.search = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  if (version) headers['api-version'] = version;
  const response = await fetch(url, { headers, signal, redirect: 'error' });
  if (response.status !== 200) {
    throw new ConsultationError(502, 'Mercado Livre retornou HTTP ' + response.status + ' em ' + path.split('/').at(-1) + '.');
  }
  return response.json();
}

type Getter = (path: string, params?: Record<string, string>, version?: string) => Promise<any>;
function cents(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100))) {
    throw new ConsultationError(502, 'O Mercado Livre retornou um valor monetário inválido.');
  }
  return Math.round(value * 100);
}

async function sales(get: Getter, params: Parameters) {
  const filters = {
    seller: ACCOUNT, limit: String(PAGE_SIZE), sort: 'date_asc',
    'order.date_created.from': params.inicio + 'T00:00:00.000-03:00',
    'order.date_created.to': params.fim + 'T23:59:59.999-03:00',
  };
  const ids = new Set<string>();
  const paymentIds = new Set<string>();
  let total = 0, sold = 0, cancelled = 0, refunded = 0, paidOrders = 0, cancelledOrders = 0, refundsComplete = true;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await get('/orders/search', { ...filters, offset: String(offset) });
    if (!Array.isArray(page?.results) || !Number.isSafeInteger(page?.paging?.total) || page.paging.total < 0) {
      throw new ConsultationError(502, 'Resposta de pedidos sem paginação válida.');
    }
    if (page.paging.total > MAX_ORDERS) throw new ConsultationError(422, 'Mais de 1.000 pedidos no período. Consulte intervalos menores.');
    if (offset === 0) total = page.paging.total;
    if (page.paging.total !== total || page.results.length !== Math.min(PAGE_SIZE, Math.max(total - offset, 0))) {
      throw new ConsultationError(409, 'A listagem de pedidos mudou durante a consulta. Tente novamente.');
    }
    for (const order of page.results) {
      const id = String(order?.id);
      if (!/^\d+$/.test(id) || ids.has(id) || String(order.seller?.id) !== ACCOUNT) {
        throw new ConsultationError(502, 'O Mercado Livre retornou um pedido duplicado ou fora da conta esperada.');
      }
      ids.add(id);
      if (order.status !== 'cancelled' && !order.cancel_detail && !['paid', 'partially_refunded'].includes(order.status)) continue;
      if (order.currency_id !== 'BRL') throw new ConsultationError(502, 'A consulta encontrou pedidos fora de BRL.');
      if (order.status === 'cancelled' || order.cancel_detail) {
        cancelled += cents(order.total_amount);
        cancelledOrders++;
        continue;
      }
      sold += cents(order.total_amount);
      paidOrders++;
      if (!Array.isArray(order.payments) || !order.payments.length) refundsComplete = false;
      for (const payment of Array.isArray(order.payments) ? order.payments : []) {
        if (payment.transaction_amount_refunded == null) {
          refundsComplete = false;
          continue;
        }
        const amount = cents(payment.transaction_amount_refunded);
        if (!amount) continue;
        const paymentId = String(payment.id);
        if (!/^\d+$/.test(paymentId)) {
          refundsComplete = false;
          continue;
        }
        if (!paymentIds.has(paymentId)) refunded += amount;
        paymentIds.add(paymentId);
      }
    }
    if (offset + PAGE_SIZE >= total) break;
  }
  return {
    fonte: 'Mercado Livre /orders/search',
    pedidos_consultados: ids.size,
    pedidos_pagos: paidOrders,
    pedidos_cancelados: cancelledOrders,
    vendas_brutas_pedidos_pagos: sold / 100,
    valor_pedidos_cancelados: cancelled / 100,
    reembolsos_informados_em_pedidos_nao_cancelados: refundsComplete ? refunded / 100 : null,
    criterio: 'Data de criação e situação atual do pedido. Vendas brutas antes dos reembolsos. Reembolsos são os valores informados nos pagamentos; null indica cobertura incompleta.',
  };
}

async function advertising(get: Getter, params: Parameters) {
  const advertiserId = process.env.GLR_ML_MCP_PILOT_ADVERTISER_ID;
  if (!advertiserId || !/^\d+$/.test(advertiserId)) throw new ConsultationError(503, 'Anunciante piloto não configurado.');
  const response = await get('/advertising/advertisers', { product_id: 'PADS' }, '1');
  const advertiser = Array.isArray(response?.advertisers) && response.advertisers.some(a =>
    a?.site_id === 'MLB' && String(a.advertiser_id) === advertiserId);
  if (!advertiser) throw new ConsultationError(422, 'Anunciante MLB da conta não identificado.');
  const summary = await get('/advertising/MLB/advertisers/' + advertiserId + '/product_ads/campaigns/search', {
    limit: '1', offset: '0', date_from: params.inicio, date_to: params.fim,
    metrics: 'cost,total_amount,clicks,prints', metrics_summary: 'true',
  }, '2');
  const metrics = summary?.metrics_summary;
  if (!metrics) throw new ConsultationError(502, 'O Product Ads não retornou o resumo do período.');
  const spend = cents(metrics.cost);
  const attributed = cents(metrics.total_amount);
  return {
    fonte: 'Mercado Livre Product Ads — resumo do anunciante MLB',
    gasto_ads: spend / 100,
    receita_atribuida_ads: attributed / 100,
    cliques: Number.isSafeInteger(metrics.clicks) && metrics.clicks >= 0 ? metrics.clicks : null,
    impressoes: Number.isSafeInteger(metrics.prints) && metrics.prints >= 0 ? metrics.prints : null,
    roas: spend > 0 ? Number((attributed / spend).toFixed(4)) : null,
  };
}

async function audit(userId: string, params: Parameters, status: number) {
  const response = await fetch(DATABASE + '/rest/v1/glr_config_privada', {
    method: 'POST', headers: dbHeaders(), signal: AbortSignal.timeout(4000), redirect: 'error',
    body: JSON.stringify({
      chave: 'ml_mcp_read_audit:' + ACCOUNT + ':' + randomUUID(),
      valor: JSON.stringify({ user_id: userId, conta_id: ACCOUNT, tool: TOOL, inicio: params.inicio, fim: params.fim, status, em: new Date().toISOString() }),
    }),
  });
  if (!response.ok) throw new ConsultationError(503, 'Não foi possível auditar a consulta.');
}

async function summarize(params: Parameters, userId: string) {
  if (params?.conta_id !== ACCOUNT) throw new ConsultationError(403, 'Conta fora do escopo do piloto.');
  validate(params);
  let status = 200;
  try {
    const signal = AbortSignal.timeout(40000);
    const token = await grantForAccount(signal);
    const get: Getter = (path, query, version) => mlGet(token, signal, path, query, version);
    const identity = await get('/users/me');
    if (String(identity?.id) !== ACCOUNT) throw new ConsultationError(403, 'A autorização pertence a outra conta.');
    const [vendas, ads] = await Promise.all([sales(get, params), advertising(get, params)]);
    return { conta_id: ACCOUNT, loja: 'Expresso Móveis', inicio: params.inicio, fim: params.fim, moeda: 'BRL', vendas, ads };
  } catch (error) {
    status = error instanceof ConsultationError ? error.status : 502;
    throw error;
  } finally {
    await audit(userId, params, status);
  }
}

async function handle(req: any, res: any, identity: any) {
  res.setHeader('Cache-Control', 'no-store');
  const users = (process.env.GLR_ML_MCP_PILOT_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (identity.role !== 'staff' || !users.includes(identity.user?.id)) return res.status(403).json({ error: 'Seu acesso não está autorizado para a conta piloto.' });
  const body = req.body || {};
  const rpc = body.jsonrpc === '2.0';
  const reply = result => res.status(200).json({ jsonrpc: '2.0', id: body.id, result });
  if (rpc) {
    if (body.method === 'notifications/initialized' && body.id === undefined) return res.status(202).end();
    if ((typeof body.id !== 'string' && typeof body.id !== 'number') || typeof body.method !== 'string') {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    if (body.method === 'initialize') {
      const version = body.params?.protocolVersion;
      return reply({ protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25'].includes(version) ? version : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'glr-mercado-livre', version: '0.1.0' } });
    }
    if (body.method === 'ping') return reply({});
    if (body.method === 'tools/list') return reply({ tools: [tool] });
    if (body.method !== 'tools/call' || body.params?.name !== TOOL) {
      return res.status(200).json({ jsonrpc: '2.0', id: body.id, error: { code: body.method === 'tools/call' ? -32602 : -32601, message: 'Método ou ferramenta indisponível.' } });
    }
  }
  try {
    const result = await summarize(rpc ? body.params?.arguments : body.params, identity.user.id);
    return rpc ? reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }) : res.status(200).json(result);
  } catch (error) {
    const status = error instanceof ConsultationError ? error.status : 502;
    const message = error instanceof ConsultationError ? error.message : 'Falha na consulta à API oficial.';
    return rpc ? reply({ isError: true, content: [{ type: 'text', text: message }] }) : res.status(status).json({ error: message });
  }
}

module.exports = { handle };
