// ============================================================
// GLR Consultoria — Central de Promoções: busca rápida no servidor
// ------------------------------------------------------------
// A tela de Promoções por anúncio (js/pages-promocoes.js) buscava pelo
// navegador, 5 de cada vez, os anúncios ativos e as promoções de cada um — com
// 400+ anúncios levava minutos. Aqui o servidor faz isso com muito mais
// chamadas em paralelo, já traz a tarifa do ML por categoria e o frete exato
// dos anúncios que têm custo, e GUARDA o resultado (glr_sync_estado, recurso
// 'promos_ml'): quem abrir a mesma conta depois recebe na hora.
// A margem continua calculada na tela (com o custo, o imposto e o ADS dela).
// POST com login (equipe, ou o cliente do portal só nas contas dele):
//  • carregar { conta, forcar } — anúncios + promoções (guardado até 6 h)
//  • frete { conta, item_id, preco } — frete exato do vendedor num preço
// ============================================================
const SUPA = 'https://rrodqlejqyaoomutriiw.supabase.co';
const VALIDADE_MS = 6 * 3600e3;
const PARALELO = 16;

async function sb(path, init = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Banco indisponível (HTTP ${r.status})`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function mcpCall(apiKey, action, params) {
  const r = await fetch('https://mcp.tiops.com.br', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ action, params: params || {} }), signal: AbortSignal.timeout(30000) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || (json.status && json.status !== 200) || (json.error && String(json.error).trim())) throw new Error(json.error || json.message || json.data?.message || `Erro na ação ${action}`);
  return json;
}
async function tentar(fn, n = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= n - 1 || /404|not.?found/i.test(e.message)) throw e; await new Promise(r => setTimeout(r, 500 * (i + 1))); }
  }
}
async function mapLimit(lista, lim, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(lim, lista.length) }, async () => { while (i < lista.length) { const k = i++; await fn(lista[k], k); } }));
}

// frete que o ML cobra do vendedor naquele preço (Mercado Envios)
async function freteNoPreco(apiKey, conta, item, preco) {
  const r = await tentar(() => mcpCall(apiKey, 'raw', { method: 'GET', path: `/users/${conta}/shipping_options/free?item_id=${encodeURIComponent(item)}&item_price=${Number(preco).toFixed(2)}`, meliUserId: conta }));
  const v = parseFloat((r?.data || r)?.coverage?.all_country?.list_cost);
  if (isNaN(v)) throw new Error('o ML não informou o frete deste anúncio');
  return v;
}

async function montar(apiKey, conta, prazo) {
  // 1) anúncios ativos (corpo completo: categoria, tipo, frete, foto, estoque)
  const anuncios = [];
  for (let off = 0; off < 5000; off += 100) {
    const r = await tentar(() => mcpCall(apiKey, 'list_items', { meliUserId: conta, status: 'active', limit: 100, offset: off }));
    const lote = r?.results || r?.data?.results || [];
    for (const e of lote) { const b = e && typeof e === 'object' ? (e.body || e) : null; if (b?.id) anuncios.push(b); }
    if (lote.length < 100) break;
  }
  const itens = anuncios.map(b => ({
    id: b.id, titulo: b.title, foto: (b.thumbnail || '').replace(/^http:/, 'https:'), link: b.permalink, preco: parseFloat(b.price) || 0,
    estoque: b.available_quantity, vendidos: b.sold_quantity, cat: b.category_id, tipo: b.listing_type_id || 'gold_special',
    mercadoEnvios: String(b.shipping?.mode || 'me2') === 'me2', promos: [],
  }));
  // 2) promoções de cada anúncio, muitas em paralelo
  let falhas = 0;
  await mapLimit(itens, PARALELO, async it => {
    if (Date.now() > prazo) { it.semPromos = true; return; }
    try { const r = await tentar(() => mcpCall(apiKey, 'ml_item_promotions', { meliUserId: conta, item_id: it.id })); it.promos = r?.items || r?.data?.items || (Array.isArray(r?.data) ? r.data : []) || []; }
    catch (e) { it.erroPromo = String(e.message || e).slice(0, 160); falhas++; }
  });
  // 3) tarifa do ML (% por categoria e tipo — o fixo abaixo de R$ 79 a tela consulta no preço)
  const taxas = {};
  const combos = [...new Set(itens.map(it => `${it.cat}|${it.tipo}`))];
  await mapLimit(combos, PARALELO, async c => {
    const [cat, tipo] = c.split('|');
    try {
      const r = await tentar(() => mcpCall(apiKey, 'ml_listing_fees', { meliUserId: conta, price: 150, category_id: cat, listing_type_id: tipo }));
      const d = r?.data || r || {};
      taxas[`${cat}|${tipo}|pct`] = { pct: parseFloat(d.sale_fee_details?.percentage_fee) || 0, fixo: parseFloat(d.sale_fee_details?.fixed_fee) || 0 };
    } catch (e) {}
  });
  // 4) frete exato nos preços das promoções — só de quem tem custo (sem custo não há margem a calcular)
  const custos = (await sb('glr_storage?chave=eq.glr_vendas_custo_catalogo&select=dados').catch(() => null))?.[0]?.dados || {};
  const fretes = {}, pedidos = [];
  for (const it of itens) {
    if (!it.mercadoEnvios || !(parseFloat(custos[it.id]) > 0)) continue;
    const precos = new Set([it.preco]);
    for (const p of it.promos.filter(p => p.status === 'candidate' || p.status === 'started')) for (const v of [p.suggested_discounted_price, p.price, p.max_discounted_price]) if (parseFloat(v) > 0) precos.add(parseFloat(v));
    for (const pr of precos) pedidos.push([it.id, pr]);
  }
  await mapLimit(pedidos, PARALELO, async ([id, pr]) => {
    if (Date.now() > prazo) return;
    try { fretes[`${id}|${pr.toFixed(2)}`] = await freteNoPreco(apiKey, conta, id, pr); } catch (e) {}
  });
  return { em: Date.now(), itens, taxas, fretes, falhas, completo: !itens.some(i => i.semPromos) };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  let identity;
  try { identity = await require('./_auth').access(req); } catch { return res.status(503).json({ error: 'Não foi possível verificar as permissões.' }); }
  if (!identity) return res.status(401).json({ error: 'Faça login para continuar.' });
  if (!['staff', 'portal'].includes(identity.role)) return res.status(403).json({ error: 'Acesso não autorizado.' });
  const b = req.body || {};
  const conta = String(b.conta || '').replace(/[^0-9]/g, '');
  if (!conta) return res.status(400).json({ error: 'Informe a conta do Mercado Livre.' });
  if (identity.role === 'portal' && !(identity.portal?.contaIds || []).map(String).includes(conta)) return res.status(403).json({ error: 'Conta não vinculada ao seu acesso' });
  const apiKey = process.env.MCP_API_KEY; if (!apiKey) return res.status(500).json({ error: 'Integração não configurada.' });
  try {
    if (b.acao === 'frete') {
      const item = String(b.item_id || '').replace(/[^A-Za-z0-9]/g, ''), preco = parseFloat(b.preco);
      if (!item || !(preco > 0)) return res.status(400).json({ error: 'Informe o anúncio e o preço.' });
      return res.status(200).json({ frete: await freteNoPreco(apiKey, conta, item, preco) });
    }
    if (b.acao !== 'carregar') return res.status(400).json({ error: 'Ação inválida.' });
    if (!b.forcar) {
      const row = (await sb(`glr_sync_estado?marketplace=eq.ml&conta_id=eq.${conta}&recurso=eq.promos_ml&select=cursor`).catch(() => null))?.[0];
      if (row?.cursor?.em && Date.now() - row.cursor.em < VALIDADE_MS && row.cursor.completo) return res.status(200).json({ ...row.cursor, guardado: true });
    }
    const cur = await montar(apiKey, conta, Date.now() + 250000);
    await sb('glr_sync_estado?on_conflict=marketplace,conta_id,recurso', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ marketplace: 'ml', conta_id: conta, recurso: 'promos_ml', ultima_tentativa: new Date().toISOString(), ultimo_sucesso: new Date().toISOString(), ultimo_erro: cur.falhas ? `${cur.falhas} anúncio(s) sem resposta do ML` : null, registros: cur.itens.length, cursor: cur }]) }).catch(() => {});
    return res.status(200).json({ ...cur, guardado: false });
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Não consegui buscar as promoções.' });
  }
};
