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
//  • equipe GLR precisa de cadastro explícito em glr_staff.

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';

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

// ── Login de cliente do portal pelo servidor (só a equipe, glr_staff) ──
// 'criar'     → cria o login já com o e-mail confirmado (o cliente entra sem o e-mail
//               de confirmação); se o login já existir e não for da equipe: confirma e
//               define a senha informada.
// 'confirmar' → só marca o e-mail como confirmado (libera quem ficou preso nisso).
// Nunca mexe em login da equipe (glr_staff) e não muda papel: quem é equipe continua
// sendo só quem está em glr_staff. Troca de senha de acesso existente: /api/portal-password.
async function loginPortal({ tipo, email, senha }) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada');
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 160) throw new Error('E-mail inválido');
  if (tipo === 'criar' && (typeof senha !== 'string' || senha.length < 8 || senha.length > 128)) throw new Error('Use uma senha entre 8 e 128 caracteres');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const ir = (path, init = {}) => fetch(`${SUPABASE_URL}${path}`, { ...init, headers, signal: AbortSignal.timeout(10000) });
  const achar = async () => {
    for (let page = 1; page <= 20; page++) {
      const r = await ir(`/auth/v1/admin/users?page=${page}&per_page=100`);
      if (!r.ok) throw new Error('Não consegui consultar os logins');
      const lista = (await r.json()).users || [];
      const u = lista.find(x => String(x.email || '').toLowerCase() === email);
      if (u || lista.length < 100) return u || null;
    }
    return null;
  };
  const daEquipe = async id => { const r = await ir(`/rest/v1/glr_staff?user_id=eq.${encodeURIComponent(id)}&select=user_id`); if (!r.ok) throw new Error('Não consegui conferir a equipe'); return (await r.json()).length > 0; };
  const atualizar = async (id, campos) => { const r = await ir(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(campos) }); if (!r.ok) throw new Error('O provedor recusou a alteração'); };
  if (tipo === 'criar') {
    const r = await ir('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password: senha, email_confirm: true }) });
    if (r.ok) return { ok: true, criado: true };
    const u = await achar();
    if (!u) throw new Error('Não consegui criar o login');
    if (await daEquipe(u.id)) throw new Error('Este e-mail é de um login da equipe GLR.');
    await atualizar(u.id, { password: senha, email_confirm: true });
    return { ok: true, criado: false, atualizado: true };
  }
  if (tipo === 'confirmar') {
    const u = await achar();
    if (!u) throw new Error('Não existe login com esse e-mail. Edite o acesso e defina uma senha para criá-lo.');
    if (await daEquipe(u.id)) throw new Error('Este e-mail é de um login da equipe GLR.');
    if (!u.email_confirmed_at) await atualizar(u.id, { email_confirm: true });
    return { ok: true, ja_estava: !!u.email_confirmed_at };
  }
  throw new Error('tipo inválido');
}

const nfeMod = require('./_nfe');
const estoqueMod = require('./_estoque');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'MCP_API_KEY não configurada no servidor' });

  const { action, params } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action obrigatória' });

  let identity;
  try { identity = await require('./_auth').access(req); }
  catch { return res.status(503).json({ error: 'Não foi possível verificar as permissões.' }); }
  if (!identity) return res.status(401).json({ error: 'Faça login para continuar.' });
  if (!['staff', 'portal'].includes(identity.role)) return res.status(403).json({ error: 'Acesso não autorizado.' });
  const contasPermitidas = identity.role === 'portal' ? new Set((identity.portal?.contaIds || []).map(String)) : null;

  if (action === 'glr_login_portal') {
    if (identity.role !== 'staff') return res.status(403).json({ error: 'Acesso restrito à equipe GLR.' });
    try { return res.status(200).json(await loginPortal(params || {})); }
    catch (e) { return res.status(400).json({ error: e.message || String(e) }); }
  }

  if (!contasPermitidas && !ALLOWED_ACTIONS.has(action)) return res.status(403).json({ error: `Ação '${action}' não permitida via proxy` });
  const p = params || {};
  if (contasPermitidas) {
    // Portal: apenas consultas explicitamente permitidas e custo validado.
    if ((!ALLOWED_ACTIONS.has(action) && action !== 'glr_portal_salvar_custo' && action !== 'glr_portal_produtos' && !/^glr_nfe_|^glr_estoque_|^glr_portal_(ncm|salvar_ncm)$/.test(action) && !CATALOGO_LIVRE.has(action)) || action === 'raw' || BLOQUEADAS_PORTAL.test(action)) return res.status(403).json({ error: 'Ação não disponível no portal' });
    if (action !== 'list_accounts' && action !== 'glr_portal_produtos' && !/^glr_nfe_|^glr_estoque_|^glr_portal_(ncm|salvar_ncm)$/.test(action) && !CATALOGO_LIVRE.has(action)) { // as ações glr_nfe_*/ncm conferem a conta por conta própria
      const contas = CAMPOS_CONTA.map(k => p[k]).filter(v => v != null && v !== '').map(String);
      if (!contas.length) return res.status(403).json({ error: 'Informe a conta da consulta' });
      if (contas.some(c => !contasPermitidas.has(c))) return res.status(403).json({ error: 'Conta não vinculada ao seu acesso' });
    }
  }

  // Custo do produto lançado pelo cliente no portal (tela Produtos). O banco não
  // deixa o portal gravar; aqui o servidor confere que cada anúncio é da conta
  // do cliente e grava só essas chaves no catálogo de custos.
  // ── Notas fiscais e NCM (api/_nfe.js) — só o portal, cada cliente com a própria chave do emissor ──
  if (/^glr_nfe_|^glr_estoque_|^glr_portal_(ncm|salvar_ncm)$/.test(action)) {
    if (!contasPermitidas) return res.status(403).json({ error: 'Somente para o portal do cliente' });
    const cli = String(identity.portal?.clienteId ?? '');
    if (!cli) return res.status(403).json({ error: 'Acesso sem cliente vinculado' });
    const t = async (a, q) => { const j = await tiops(apiKey, a, q); if (typeof j?.error === 'string' && j.error.trim()) throw new Error(j.error); if (j?.status && j.status !== 200 && j?.data?.error) throw new Error(j.data.error); return j; };
    const minhaConta = (mkt, conta) => ['ml', 'shopee'].includes(mkt) && contasPermitidas.has(String(conta));
    try {
      if (/^glr_estoque_/.test(action)) {
        const lc = await t('list_accounts', {});
        const contas = (lc?.data?.accounts || lc?.accounts || []).filter(c => contasPermitidas.has(String(c.external_id)))
          .map(c => ({ mkt: /shopee/i.test(c.marketplace) ? 'shopee' : /meli|mercado|^ml$/i.test(c.marketplace) ? 'ml' : null, id: String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.external_id) })).filter(c => c.mkt);
        if (action === 'glr_estoque_listar') return res.status(200).json(await estoqueMod.listar(t, cli, contas));
        // anúncios vêm da tela: só passa o que for das contas do cliente
        const limpa = arr => (Array.isArray(arr) ? arr : []).filter(a => minhaConta(a?.mkt, a?.conta)).slice(0, 50).map(a => ({ mkt: a.mkt, conta: String(a.conta), id: String(a.id), var: a.var ? String(a.var) : null, full: !!a.full, estoque: a.estoque == null ? null : Number(a.estoque) }));
        if (action === 'glr_estoque_salvar') {
          const anuncios = limpa(p.anuncios);
          if (!anuncios.length) return res.status(403).json({ error: 'Nenhum anúncio das suas contas' });
          return res.status(200).json(await estoqueMod.salvarProduto(t, cli, { chave: String(p.chave || '').slice(0, 200), nome: p.nome, sku: p.sku, estoque: p.estoque, anuncios }));
        }
        if (action === 'glr_estoque_ativar') {
          const produtos = (Array.isArray(p.produtos) ? p.produtos : []).slice(0, 5000).map(x => ({ chave: String(x.chave || '').slice(0, 200), nome: x.nome, sku: x.sku, anuncios: limpa(x.anuncios) })).filter(x => x.chave && x.anuncios.length);
          return res.status(200).json(await estoqueMod.ativar(t, cli, !!p.ativo, produtos));
        }
      }
      if (action === 'glr_nfe_status') return res.status(200).json(await nfeMod.status(cli));
      if (action === 'glr_nfe_chave') return res.status(200).json(p.remover ? await nfeMod.removerChave(cli) : await nfeMod.salvarChave(cli, p.chave));
      if (action === 'glr_nfe_pedidos') {
        const lc = await t('list_accounts', {});
        const contas = (lc?.data?.accounts || lc?.accounts || []).filter(c => contasPermitidas.has(String(c.external_id)))
          .map(c => ({ mkt: /shopee/i.test(c.marketplace) ? 'shopee' : /meli|mercado|^ml$/i.test(c.marketplace) ? 'ml' : null, id: String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.external_id) }))
          .filter(c => c.mkt && (!p.conta || c.id === String(p.conta)));
        return res.status(200).json(await nfeMod.pedidosAEnviar(t, cli, contas));
      }
      if (action === 'glr_nfe_previa' || action === 'glr_nfe_emitir') {
        if (!minhaConta(p.mkt, p.conta)) return res.status(403).json({ error: 'Conta não vinculada ao seu acesso' });
        return res.status(200).json(await nfeMod.previaOuEmitir(t, cli, { mkt: p.mkt, conta: String(p.conta), pedido: String(p.pedido || ''), orderIds: (Array.isArray(p.orderIds) ? p.orderIds : []).map(String).slice(0, 20), empresaId: String(p.empresaId || ''), ambiente: p.ambiente === 'producao' ? 'producao' : 'homologacao' }, action === 'glr_nfe_emitir'));
      }
      if (action === 'glr_nfe_nota') return res.status(200).json(await nfeMod.consultarNota(cli, String(p.id || '')));
      if (action === 'glr_nfe_danfe') return res.status(200).json(await nfeMod.danfe(cli, String(p.id || ''), p.formato));
      if (action === 'glr_portal_ncm') {
        const cat = await nfeMod.lerNcm(), ids = (Array.isArray(p.ids) ? p.ids : []).slice(0, 3000).map(String);
        return res.status(200).json({ ncm: Object.fromEntries(ids.filter(id => cat[id]).map(id => [id, cat[id]])) });
      }
      if (action === 'glr_portal_salvar_ncm') { // confere que cada anúncio é da conta do cliente (como o custo)
        const conta = String(p.meliUserId || p.shopId || '');
        if (!contasPermitidas.has(conta)) return res.status(403).json({ error: 'Conta não vinculada ao seu acesso' });
        const pedidos = new Map((Array.isArray(p.itens) ? p.itens : []).slice(0, 100).map(x => [String(x.id), String(x.ncm || '')]));
        const ok = [];
        const ids = [...pedidos.keys()];
        if (p.meliUserId) for (let i = 0; i < ids.length; i += 20) {
          const r = await t('get_items', { meliUserId: conta, ids: ids.slice(i, i + 20) });
          for (const e of (Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : []))) { const b = e?.body || e; if (b?.id && String(b.seller_id) === conta && pedidos.has(String(b.id))) ok.push({ id: String(b.id), ncm: pedidos.get(String(b.id)) }); }
        } else for (let i = 0; i < ids.length; i += 50) {
          const r = await t('shopee_get_items_batch', { shopId: conta, item_id_list: ids.slice(i, i + 50).map(Number) });
          for (const d of (r?.data?.response?.item_list || r?.response?.item_list || [])) if (pedidos.has(String(d.item_id))) ok.push({ id: String(d.item_id), ncm: pedidos.get(String(d.item_id)) });
        }
        if (!ok.length) return res.status(400).json({ error: 'Nenhum anúncio desta conta encontrado' });
        await nfeMod.salvarNcm(ok);
        return res.status(200).json({ ok: true, salvos: ok.length });
      }
      return res.status(400).json({ error: 'Ação de nota inválida' });
    } catch (e) { return res.status(400).json({ error: e.message || String(e) }); }
  }

  // Produtos cadastrados pela equipe (custo, foto, SKU) — só os do cliente logado e só
  // os anúncios das contas dele. O banco não deixa o portal ler glr_produtos inteiro.
  if (action === 'glr_portal_produtos') {
    if (!contasPermitidas) return res.status(403).json({ error: 'Somente para o portal do cliente' });
    try {
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?chave=eq.glr_produtos&select=dados`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('Não consegui ler os produtos');
      const todos = (await r.json())[0]?.dados;
      const cli = String(identity.portal?.clienteId ?? '');
      const produtos = (Array.isArray(todos) ? todos : []).filter(x => cli && String(x?.clienteId) === cli).map(x => ({
        id: x.id, clienteId: x.clienteId, sku: x.sku || '', nome: x.nome || '', imagem: x.imagem || '', custo: x.custo || 0, custoExtra: x.custoExtra || 0,
        anuncios: (x.anuncios || []).filter(a => contasPermitidas.has(String(a.conta))),
      }));
      return res.status(200).json({ produtos });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

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
