// ============================================================
// GLR Consultoria — Estoque único por produto, espelhado nos marketplaces
// ------------------------------------------------------------
// Produto = SKU (de anúncio ou de variação) igual entre as lojas do cliente; sem
// SKU, o anúncio/variação é um produto sozinho. O estoque do produto é gravado em
// TODOS os anúncios ligados a ele (Mercado Livre e Shopee, variação por variação).
// Espelho (só se o cliente ATIVAR): a cada 15 min (api/agente-cron.js ?rodada=
// estoque) as vendas novas da base (glr_pedidos) descontam do produto e o número
// novo vai para as outras lojas — a loja que vendeu já desconta sozinha.
// Ao ativar, cada produto começa com o MENOR estoque entre as lojas.
// Full/fulfillment fica de fora (estoque no armazém do marketplace).
// Estado: glr_sync_estado sistema / cliente:<id> / estoque. Uso: /api/mcp (portal)
// e agente-cron (espelho). Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const svc = () => { const key = process.env.SUPABASE_SERVICE_ROLE_KEY; return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }; };
const normSku = s => String(s || '').trim().toUpperCase();
const dados = r => r?.data && typeof r.data === 'object' && !Array.isArray(r.data) && (r.status != null || r.data.results || r.data.response) ? r.data : r;
const skuAttr = b => (b?.attributes || b?.attribute_combinations || []).find(a => a?.id === 'SELLER_SKU')?.value_name || '';

async function lerEstado(cli) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_sync_estado?marketplace=eq.sistema&conta_id=eq.${encodeURIComponent('cliente:' + cli)}&recurso=eq.estoque&select=cursor`, { headers: svc(), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Não consegui ler o estoque');
  return (await r.json())[0]?.cursor || { ativo: false, produtos: {}, vistos: {} };
}
async function salvarEstado(cli, cursor) {
  const agora = new Date().toISOString();
  const w = await fetch(`${SUPABASE_URL}/rest/v1/glr_sync_estado?on_conflict=marketplace,conta_id,recurso`, { method: 'POST', headers: { ...svc(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ marketplace: 'sistema', conta_id: 'cliente:' + cli, recurso: 'estoque', ultima_tentativa: agora, ultimo_sucesso: agora, cursor }), signal: AbortSignal.timeout(10000) });
  if (!w.ok) throw new Error('Não consegui salvar o estoque');
}

// ── Anúncios (e variações) das contas com o estoque atual de cada um ──
async function anunciosML(t, conta) {
  const out = [];
  for (let off = 0; off < 2000; off += 100) {
    const r = dados(await t('list_items', { meliUserId: conta, status: 'active', limit: 100, offset: off, com_atributos: true }));
    const res = r?.results || [];
    for (const e of res) {
      const b = e?.body || e; if (!b?.id) continue;
      const full = (b.shipping?.logistic_type || b.logistic_type) === 'fulfillment';
      if (Array.isArray(b.variations) && b.variations.length) {
        for (const v of b.variations) out.push({ mkt: 'ml', conta, id: String(b.id), var: String(v.id), nome: `${b.title}${(v.attribute_combinations || []).length ? ' — ' + v.attribute_combinations.map(a => a.value_name).join(' / ') : ''}`, sku: v.seller_custom_field || skuAttr(v) || '', estoque: v.available_quantity ?? null, full, foto: String(b.thumbnail || '').replace(/^http:/, 'https:') });
      } else out.push({ mkt: 'ml', conta, id: String(b.id), var: null, nome: b.title, sku: b.seller_custom_field || skuAttr(b) || '', estoque: b.available_quantity ?? null, full, foto: String(b.thumbnail || '').replace(/^http:/, 'https:') });
    }
    if (res.length < 100 || off + 100 >= (parseInt(r?.paging?.total) || 0)) break;
  }
  return out;
}
async function anunciosShopee(t, conta) {
  const ids = [], out = [];
  for (let off = 0; off < 5000; ) {
    const r = dados(await t('shopee_list_items', { shopId: conta, item_status: 'NORMAL', offset: off, page_size: 100 }));
    const d = r?.response || {};
    (d.item || []).forEach(x => ids.push(Number(x.item_id)));
    if (!d.has_next_page || !(d.item || []).length) break;
    off = d.next_offset || off + 100;
  }
  const estoqueDe = s => s?.summary_info?.total_available_stock ?? s?.seller_stock?.[0]?.stock ?? null;
  for (let i = 0; i < ids.length; i += 50) {
    const r = dados(await t('shopee_get_items_batch', { shopId: conta, item_id_list: ids.slice(i, i + 50) }));
    for (const b of (r?.response?.item_list || [])) {
      const full = !!b.is_fulfillment_by_shopee, foto = b.image?.image_url_list?.[0] || '';
      const models = Array.isArray(b.models) && b.models.length ? b.models : null;
      if (models) for (const m of models) out.push({ mkt: 'shopee', conta, id: String(b.item_id), var: String(m.model_id), nome: `${b.item_name}${m.model_name ? ' — ' + m.model_name : ''}`, sku: m.model_sku || '', estoque: estoqueDe(m.stock_info_v2), full: full || !!m.is_fulfillment_by_shopee, foto });
      else out.push({ mkt: 'shopee', conta, id: String(b.item_id), var: null, nome: b.item_name, sku: b.item_sku || '', estoque: estoqueDe(b.stock_info_v2), full, foto });
    }
  }
  return out;
}
const chaveAnuncio = a => normSku(a.sku) ? 'sku:' + normSku(a.sku) : `an:${a.mkt}:${a.id}:${a.var || ''}`;

async function listar(t, cli, contas) {
  const est = await lerEstado(cli);
  const ans = [];
  for (const c of contas) {
    try { ans.push(...(c.mkt === 'ml' ? await anunciosML(t, c.id) : c.mkt === 'shopee' ? await anunciosShopee(t, c.id) : [])); }
    catch (e) { ans.push({ erro: `${c.mkt} ${c.id}: ${e.message}` }); }
  }
  const prods = new Map();
  for (const a of ans) {
    if (a.erro) continue;
    const k = chaveAnuncio(a);
    const p = prods.get(k) || { chave: k, sku: a.sku || '', nome: a.nome, foto: a.foto, anuncios: [] };
    p.anuncios.push(a); prods.set(k, p);
  }
  const lista = [...prods.values()].map(p => {
    const sincr = p.anuncios.filter(a => !a.full && a.estoque != null).map(a => a.estoque);
    const salvo = est.produtos?.[p.chave];
    return { ...p, estoque: salvo?.estoque ?? (sincr.length ? Math.min(...sincr) : null), salvo: !!salvo, diverge: new Set(sincr).size > 1 };
  }).sort((a, b) => (b.diverge - a.diverge) || String(a.sku || a.nome).localeCompare(String(b.sku || b.nome), 'pt-BR', { numeric: true }));
  return { ativo: !!est.ativo, desde: est.desde || null, produtos: lista, erros: ans.filter(a => a.erro).map(a => a.erro) };
}

// ── Grava o estoque de um produto em todos os anúncios dele ──
async function gravarAnuncio(t, a, n) {
  if (a.full) return { ok: true, pulado: 'full' };
  if (a.mkt === 'ml') {
    if (a.var) await t('ml_update_variation_stock', { meliUserId: a.conta, account_id: a.conta, item_id: a.id, variation_id: a.var, available_quantity: n });
    else await t('update_item', { meliUserId: a.conta, item_id: a.id, available_quantity: n });
  } else {
    await t('shopee_update_stock', { shopId: a.conta, item_id: Number(a.id), ...(a.var ? { model_id: Number(a.var) } : {}), stock: n });
  }
  return { ok: true };
}
async function aplicar(t, anuncios, n, exceto) {
  const res = [];
  for (const a of anuncios) {
    if (exceto && exceto(a)) continue;
    try { res.push({ a: `${a.mkt}:${a.id}${a.var ? ':' + a.var : ''}`, ...(await gravarAnuncio(t, a, n)) }); }
    catch (e) { res.push({ a: `${a.mkt}:${a.id}${a.var ? ':' + a.var : ''}`, erro: String(e.message || e).slice(0, 160) }); }
  }
  return res;
}
// anuncios vêm da tela (lista acabou de ser lida); o servidor confere a conta antes (mcp.js)
async function salvarProduto(t, cli, { chave, nome, sku, estoque, anuncios }) {
  const n = Math.max(0, Math.floor(Number(estoque)));
  if (!isFinite(n) || n > 1e6) throw new Error('Estoque inválido');
  const est = await lerEstado(cli);
  est.produtos = est.produtos || {};
  est.produtos[chave] = { nome: String(nome || '').slice(0, 90), sku: String(sku || ''), estoque: n, anuncios: anuncios.map(a => ({ mkt: a.mkt, conta: a.conta, id: a.id, var: a.var || null, full: !!a.full })), em: Date.now() };
  await salvarEstado(cli, est);
  return { ok: true, estoque: n, gravados: await aplicar(t, anuncios, n) };
}
// Ativar: cada produto com mais de um anúncio começa no MENOR estoque entre as lojas
async function ativar(t, cli, ativo, produtos) {
  const est = await lerEstado(cli);
  est.ativo = !!ativo;
  const res = [];
  if (ativo) {
    est.desde = new Date().toISOString(); est.vistos = {};
    est.produtos = est.produtos || {};
    for (const p of produtos) {
      const sincr = p.anuncios.filter(a => !a.full && a.estoque != null);
      if (!sincr.length) continue;
      const n = est.produtos[p.chave]?.estoque ?? Math.min(...sincr.map(a => a.estoque));
      est.produtos[p.chave] = { nome: String(p.nome || '').slice(0, 90), sku: String(p.sku || ''), estoque: n, anuncios: p.anuncios.map(a => ({ mkt: a.mkt, conta: a.conta, id: a.id, var: a.var || null, full: !!a.full })), em: Date.now() };
      if (new Set(sincr.map(a => a.estoque)).size > 1) res.push(...(await aplicar(t, sincr.filter(a => a.estoque !== n), n)));
    }
  }
  await salvarEstado(cli, est);
  return { ok: true, ativo: est.ativo, ajustados: res.length, erros: res.filter(x => x.erro).length };
}

// ── Espelho das vendas (agente-cron, a cada 15 min) ──
async function espelharCliente(t, cli) {
  const est = await lerEstado(cli);
  if (!est.ativo || !est.desde) return { cliente: cli, ativo: false };
  const prods = est.produtos || {};
  const porAnuncio = new Map(), porSku = new Map(), contas = new Set();
  for (const [k, p] of Object.entries(prods)) {
    if (normSku(p.sku)) porSku.set(normSku(p.sku), k);
    for (const a of p.anuncios || []) { porAnuncio.set(`${a.mkt}:${a.id}`, porAnuncio.get(`${a.mkt}:${a.id}`) || k); contas.add(`${a.mkt}:${a.conta}`); }
  }
  if (!contas.size) return { cliente: cli, ativo: true, vendas: 0 };
  const lista = [...contas].map(x => x.split(':')[1]);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_pedidos?conta_id=in.(${lista.map(encodeURIComponent).join(',')})&marketplace=in.(ml,shopee)&situacao=eq.valido&criado_em=gte.${encodeURIComponent(est.desde)}&select=marketplace,conta_id,pedido_id,itens&order=criado_em.asc&limit=1000`, { headers: svc(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Não consegui ler as vendas');
  const peds = await r.json();
  est.vistos = est.vistos || {};
  const mexidos = new Map(); // produto -> anúncio que vendeu (ele já desconta sozinho)
  let vendas = 0;
  for (const p of peds) {
    const kp = `${p.marketplace}:${p.conta_id}:${p.pedido_id}`;
    if (est.vistos[kp] || !contas.has(`${p.marketplace}:${p.conta_id}`)) continue;
    est.vistos[kp] = Date.now(); vendas++;
    for (const it of (p.itens || [])) {
      const k = (normSku(it.sku) && porSku.get(normSku(it.sku))) || porAnuncio.get(`${p.marketplace}:${it.item_id}`);
      if (!k || !prods[k]) continue;
      prods[k].estoque = Math.max(0, (prods[k].estoque || 0) - (parseInt(it.qtd) || 1));
      mexidos.set(k, { mkt: p.marketplace, conta: String(p.conta_id), item: String(it.item_id) });
    }
  }
  const res = [];
  for (const [k, origem] of mexidos) {
    const p = prods[k];
    res.push(...(await aplicar(t, p.anuncios || [], p.estoque, a => a.mkt === origem.mkt && String(a.conta) === origem.conta && String(a.id) === origem.item)));
  }
  const corte = Date.now() - 3 * 864e5; // guarda só os últimos 3 dias de pedidos vistos
  for (const [k, v] of Object.entries(est.vistos)) if (v < corte) delete est.vistos[k];
  await salvarEstado(cli, est);
  return { cliente: cli, vendas, produtos: mexidos.size, gravados: res.filter(x => x.ok).length, erros: res.filter(x => x.erro).length };
}
async function espelharTodos(t) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_sync_estado?marketplace=eq.sistema&recurso=eq.estoque&select=conta_id,ativo:cursor->ativo`, { headers: svc(), signal: AbortSignal.timeout(10000) });
  const rows = r.ok ? await r.json() : [];
  const out = [];
  for (const x of rows.filter(x => x.ativo === true)) {
    try { out.push(await espelharCliente(t, String(x.conta_id).replace(/^cliente:/, ''))); } catch (e) { out.push({ cliente: x.conta_id, erro: e.message }); }
  }
  return out;
}

module.exports = { listar, salvarProduto, ativar, espelharTodos };
