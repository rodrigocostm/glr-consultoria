// ============================================================
// GLR Consultoria — Notas fiscais (NF-e) pelo Emissor NF-e da Tiops
// ------------------------------------------------------------
// Cada cliente tem a PRÓPRIA chave do emissor (nfe.tiops.com.br → Chaves de API).
// Ela é guardada só no servidor (glr_config_privada, sem acesso do navegador) e
// nunca volta para a tela. Usado pelo /api/mcp (ações glr_nfe_*), no portal do
// cliente (as contas dele) e pela equipe.
//  • pedidos a enviar do Mercado Livre e da Shopee (pelo conector da GLR) com a
//    situação da nota de cada um;
//  • monta a nota do pedido: comprador (ML: dados de faturamento do pedido;
//    Shopee: buyer_cpf_id + endereço de entrega), itens com o NCM cadastrado na
//    tela Produtos (glr_ncm_catalogo, por anúncio), frete e desconto;
//  • prévia (sem número, sem SEFAZ), emissão e DANFE (etiqueta 10×15 ou A4).
// Toda nota sai em HOMOLOGAÇÃO, a menos que o pedido peça "producao" — e a
// produção também precisa estar liberada para a empresa no painel do emissor.
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

const NFE = 'https://api.nfe.tiops.com.br';
const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const svc = () => { const key = process.env.SUPABASE_SERVICE_ROLE_KEY; return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }; };
const chaveDe = cli => `nfe_chave:cliente:${cli}`;
const r2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const so = v => String(v ?? '').replace(/\D/g, '');

// ── Chave do emissor (por cliente) ──
async function lerChave(cli) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_config_privada?chave=eq.${encodeURIComponent(chaveDe(cli))}&select=valor`, { headers: svc(), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Não consegui ler a configuração de notas');
  return (await r.json())[0]?.valor || null;
}
async function nfe(chave, path, init = {}) {
  const r = await fetch(`${NFE}${path}`, { ...init, headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j?.error || {};
    const err = new Error(r.status === 401 ? 'A chave do emissor foi recusada (revogada ou errada). Cadastre de novo.' : r.status === 403 ? 'A chave do emissor não tem permissão para isso (nível da chave).' : (e.message || `Emissor respondeu ${r.status}`));
    err.status = r.status; err.detalhes = e.details || null; err.codigo = e.code || null;
    throw err;
  }
  return j;
}
async function salvarChave(cli, chave) {
  chave = String(chave || '').trim();
  if (!/^nfe_[A-Za-z0-9_\-]{10,200}$/.test(chave)) throw new Error('Chave inválida: ela começa com nfe_ (gere em nfe.tiops.com.br → Chaves de API).');
  const conta = await nfe(chave, '/v1/conta'); // confere antes de guardar
  const w = await fetch(`${SUPABASE_URL}/rest/v1/glr_config_privada?on_conflict=chave`, { method: 'POST', headers: { ...svc(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ chave: chaveDe(cli), valor: chave }), signal: AbortSignal.timeout(10000) });
  if (!w.ok) throw new Error('Não consegui guardar a chave');
  return { ok: true, conta: conta?.nome || conta?.name || null };
}
async function removerChave(cli) {
  await fetch(`${SUPABASE_URL}/rest/v1/glr_config_privada?chave=eq.${encodeURIComponent(chaveDe(cli))}`, { method: 'DELETE', headers: svc(), signal: AbortSignal.timeout(10000) });
  return { ok: true };
}
async function exigirChave(cli) { const c = await lerChave(cli); if (!c) throw new Error('Cadastre a chave do Emissor NF-e da Tiops para emitir notas.'); return c; }

// ── Situação: conta, empresas e lojas do emissor ──
async function status(cli) {
  const chave = await lerChave(cli);
  if (!chave) return { temChave: false };
  const [conta, empresas, lojas] = await Promise.all([
    nfe(chave, '/v1/conta').catch(e => ({ erro: e.message })),
    nfe(chave, '/v1/empresas').catch(e => ({ erro: e.message })),
    nfe(chave, '/v1/lojas').catch(e => ({ erro: e.message })),
  ]);
  const listaEmp = Array.isArray(empresas) ? empresas : (empresas?.empresas || empresas?.data || []);
  return {
    temChave: true, conta: conta?.nome || conta?.name || null, erro: conta?.erro || null,
    empresas: listaEmp.map(e => ({ id: e.id, nome: e.nomeFantasia || e.razaoSocial || e.nome || e.id, cnpj: e.cnpj || null, producao: !!(e.producaoLiberada ?? e.producao ?? e.ambientes?.producao) })),
    lojas: (lojas?.lojas || []).map(l => ({ marketplace: l.marketplace, idExterno: String(l.idExterno ?? l.id ?? ''), empresaId: l.empresaId || l.empresa?.id || null, nome: l.nome || l.apelido || null })),
  };
}

// ── NCM por anúncio (tela Produtos) ──
async function lerNcm() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?chave=eq.glr_ncm_catalogo&select=dados`, { headers: svc(), signal: AbortSignal.timeout(10000) });
  const d = r.ok ? (await r.json())[0]?.dados : null;
  return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
}
async function salvarNcm(itens) { // itens: [{id, ncm}] já conferidos como da conta do cliente
  const cat = await lerNcm();
  for (const { id, ncm } of itens) { const n = so(ncm); if (n.length === 8) cat[String(id)] = n; else if (!n) delete cat[String(id)]; }
  const w = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?on_conflict=chave`, { method: 'POST', headers: { ...svc(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ chave: 'glr_ncm_catalogo', dados: cat, atualizado_em: new Date().toISOString() }) });
  if (!w.ok) throw new Error('Não consegui salvar o NCM');
  return { ok: true };
}

// ── Pedidos a enviar (ML e Shopee) ──
const dados = r => r?.data && typeof r.data === 'object' && !Array.isArray(r.data) && (r.status != null || r.data.results || r.data.response) ? r.data : r;
async function pedidosML(tiops, conta) {
  const desde = new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 19) + '.000-03:00';
  const r = dados(await tiops('raw_read', { meliUserId: conta, path: `/orders/search?seller=${conta}&order.status=paid&order.date_created.from=${encodeURIComponent(desde)}&sort=date_desc&limit=50` }));
  const ords = (r?.results || []).filter(o => o?.shipping?.id);
  const out = [];
  for (let i = 0; i < ords.length; i += 8) {
    await Promise.all(ords.slice(i, i + 8).map(async o => {
      let sh = null;
      try { sh = dados(await tiops('get_shipment', { meliUserId: conta, shipment_id: String(o.shipping.id) })); } catch (e) { return; }
      if (!sh || !['ready_to_ship', 'pending'].includes(sh.status) || /fulfillment/.test(sh.logistic?.type || sh.logistic_type || '')) return;
      out.push({ mkt: 'ml', conta, pedido: String(o.pack_id || o.id), orderId: String(o.id), shipmentId: String(o.shipping.id), data: o.date_created, total: r2(o.total_amount), status: sh.substatus || sh.status,
        itens: (o.order_items || []).map(it => ({ id: String(it.item?.id || ''), nome: it.item?.title || '', qtd: it.quantity })) });
    }));
  }
  // pedidos do mesmo carrinho (pack) viram uma nota só
  const porPack = new Map();
  for (const p of out) { const a = porPack.get(p.pedido); if (!a) porPack.set(p.pedido, { ...p, orderIds: [p.orderId] }); else { a.total = r2(a.total + p.total); a.itens.push(...p.itens); a.orderIds.push(p.orderId); } }
  return [...porPack.values()];
}
async function pedidosShopee(tiops, conta) {
  const agora = Math.floor(Date.now() / 1000), out = [];
  for (const st of ['READY_TO_SHIP', 'PROCESSED']) {
    const r = dados(await tiops('shopee_list_orders', { shopId: conta, params: { time_range_field: 'create_time', time_from: agora - 15 * 86400, time_to: agora, page_size: 100, order_status: st } }));
    for (const o of (r?.response?.order_list || [])) out.push(o.order_sn);
  }
  const lista = [];
  for (let i = 0; i < out.length; i += 50) {
    const d = dados(await tiops('shopee_get_order_detail', { shopId: conta, order_sn: out.slice(i, i + 50).join(','), response_optional_fields: 'item_list,total_amount,create_time,order_status,invoice_data' }));
    for (const o of (d?.response?.order_list || [])) lista.push({ mkt: 'shopee', conta, pedido: o.order_sn, data: new Date((o.create_time || 0) * 1000).toISOString(), total: r2(o.total_amount), status: o.order_status, temNotaShopee: !!o.invoice_data?.number,
      itens: (o.item_list || []).map(it => ({ id: String(it.item_id), nome: it.item_name, qtd: it.model_quantity_purchased })) });
  }
  return lista;
}
async function pedidosAEnviar(tiops, cli, contas) {
  const chave = await lerChave(cli);
  const st = chave ? await status(cli).catch(() => null) : null;
  const ncm = await lerNcm();
  const todos = [];
  for (const c of contas) {
    try { todos.push(...(c.mkt === 'ml' ? await pedidosML(tiops, c.id) : c.mkt === 'shopee' ? await pedidosShopee(tiops, c.id) : [])); }
    catch (e) { todos.push({ mkt: c.mkt, conta: c.id, erro: e.message }); }
  }
  // empresa de cada loja e nota já emitida para o pedido
  for (const p of todos) {
    if (p.erro) continue;
    p.semNcm = p.itens.filter(it => !ncm[it.id]).length;
    p.empresaId = empresaDaLoja(st, p.mkt, p.conta);
    if (chave && p.empresaId) {
      try {
        const n = await nfe(chave, `/v1/notas?empresaId=${encodeURIComponent(p.empresaId)}&referenciaExterna=${encodeURIComponent(refExterna(p.mkt, p.pedido))}`);
        if (n && n.id) p.nota = resumoNota(n);
      } catch (e) { /* sem nota ainda */ }
    }
  }
  return { pedidos: todos.sort((a, b) => String(b.data || '').localeCompare(String(a.data || ''))), emissor: st };
}
const refExterna = (mkt, pedido) => `${mkt === 'ml' ? 'ML' : 'SH'}-${pedido}`;
function empresaDaLoja(st, mkt, conta) {
  if (!st?.temChave) return null;
  const mp = mkt === 'ml' ? /mercado|meli|^ml$/i : /shopee/i;
  const l = (st.lojas || []).find(x => mp.test(String(x.marketplace)) && String(x.idExterno) === String(conta) && x.empresaId);
  if (l) return l.empresaId;
  return (st.empresas || []).length === 1 ? st.empresas[0].id : null; // uma empresa só: é ela
}
const resumoNota = n => ({ id: n.id, situacao: n.situacao, numero: n.numero || null, serie: n.serie || null, chave: n.chave || null, ambiente: n.ambiente, motivo: n.motivo || null, orientacao: n.orientacao || null, valor: n.valor ?? null, envioCanal: n.envioCanal || null });

// ── Monta a nota de um pedido ──
async function montarPedido(tiops, { mkt, conta, pedido, orderIds, empresaId, ambiente }) {
  const ncm = await lerNcm();
  const base = { empresaId, referenciaExterna: refExterna(mkt, pedido), ambiente: ambiente === 'producao' ? 'producao' : 'homologacao', finalidade: 'venda',
    canal: mkt === 'ml' ? 'mercadolivre' : 'shopee', loja: { marketplace: mkt === 'ml' ? 'mercadolivre' : 'shopee', idExterno: String(conta), pedido: String(pedido) } };
  const faltaNcm = [];
  const item = (id, nome, sku, qtd, unit) => { const n = ncm[String(id)]; if (!n) faltaNcm.push(nome || id); return { codigo: String(sku || id).slice(0, 60), descricao: String(nome || id).slice(0, 120), ncm: n || '', quantidade: qtd, valorUnitario: r2(unit) }; };
  if (mkt === 'ml') {
    const ids = orderIds?.length ? orderIds : [pedido];
    const ords = [];
    for (const id of ids) ords.push(dados(await tiops('raw_read', { meliUserId: conta, path: `/orders/${id}` })));
    const o0 = ords[0] || {};
    const bi = dados(await tiops('raw_read', { meliUserId: conta, path: `/orders/${o0.id}/billing_info` }).catch(() => null)) || {};
    const b = bi.buyer?.billing_info || bi.billing_info || {};
    const ident = b.identification || {};
    const doc = so(ident.number || b.doc_number || (Array.isArray(b.additional_info) ? b.additional_info.find(x => x.type === 'DOC_NUMBER')?.value : ''));
    const tipo = String(ident.type || b.doc_type || '').toUpperCase();
    const ad = b.address || {};
    let end = { logradouro: ad.street_name, numero: ad.street_number || 'SN', complemento: ad.comment || '', bairro: ad.neighborhood?.name || ad.neighborhood || '', cep: so(ad.zip_code), cidade: ad.city_name || ad.city?.name || '', uf: String(ad.state?.code || ad.state_name || '').replace(/^BR-/, '') };
    if (!end.logradouro || !end.cep) { // sem endereço de faturamento: usa o de entrega
      const sh = dados(await tiops('get_shipment', { meliUserId: conta, shipment_id: String(o0.shipping?.id) }).catch(() => null)) || {};
      const ra = sh.receiver_address || sh.destination?.shipping_address || {};
      end = { logradouro: ra.street_name || ra.address_line, numero: ra.street_number || 'SN', complemento: ra.comment || '', bairro: ra.neighborhood?.name || '', cep: so(ra.zip_code), cidade: ra.city?.name || '', uf: String(ra.state?.id || ra.state?.code || '').replace(/^BR-/, '') };
    }
    const nome = [b.name, b.last_name].filter(Boolean).join(' ') || [o0.buyer?.first_name, o0.buyer?.last_name].filter(Boolean).join(' ') || o0.buyer?.nickname || 'Consumidor';
    const itens = ords.flatMap(o => (o.order_items || []).map(it => item(it.item?.id, it.item?.title, it.item?.seller_sku || it.item?.seller_custom_field, it.quantity, it.unit_price)));
    return { pedido: { ...base, cliente: { ...(tipo === 'CNPJ' || doc.length === 14 ? { cnpj: doc } : { cpf: doc }), nome, endereco: end }, itens, pagamento: { forma: 'outros', descricao: 'Mercado Pago' } }, faltaNcm };
  }
  // Shopee
  const d = dados(await tiops('shopee_get_order_detail', { shopId: conta, order_sn: String(pedido) }));
  const o = d?.response?.order_list?.[0];
  if (!o) throw new Error('Pedido não encontrado na Shopee');
  const ra = o.recipient_address || {};
  const doc = so(o.buyer_cpf_id);
  if (!doc || /\*/.test(String(o.buyer_cpf_id))) throw new Error('A Shopee não devolveu o CPF do comprador completo (ele só vem enquanto o pedido está a enviar).');
  const itens = (o.item_list || []).map(it => item(it.item_id, it.item_name, it.model_sku || it.item_sku, it.model_quantity_purchased, it.model_discounted_price ?? it.model_original_price));
  return { pedido: { ...base, cliente: { ...(doc.length === 14 ? { cnpj: doc } : { cpf: doc }), nome: ra.name || o.buyer_username || 'Consumidor',
    endereco: { logradouro: ra.full_address ? String(ra.full_address).split(',')[0].slice(0, 60) : (ra.town || ''), numero: 'SN', bairro: ra.district || ra.town || '', cep: so(ra.zipcode), cidade: ra.city || '', uf: ra.state && ra.state.length === 2 ? ra.state : (ra.state || '') } },
    itens, pagamento: { forma: 'outros', descricao: 'Shopee' } }, faltaNcm };
}

async function previaOuEmitir(tiops, cli, p, emitir) {
  const chave = await exigirChave(cli);
  if (!p.empresaId) throw new Error('Escolha a empresa que emite a nota (ou vincule a loja a uma empresa no painel do emissor).');
  const { pedido, faltaNcm } = await montarPedido(tiops, p);
  if (faltaNcm.length) throw new Error(`Falta o NCM de: ${faltaNcm.slice(0, 5).join('; ')}${faltaNcm.length > 5 ? ` e mais ${faltaNcm.length - 5}` : ''}. Cadastre na tela Produtos.`);
  try {
    if (!emitir) return { ok: true, previa: await nfe(chave, '/v1/notas/previa', { method: 'POST', body: JSON.stringify(pedido) }) };
    const n = await nfe(chave, '/v1/notas', { method: 'POST', headers: { 'Idempotency-Key': pedido.referenciaExterna }, body: JSON.stringify(pedido) });
    return { ok: true, nota: resumoNota(n) };
  } catch (e) {
    if (e.detalhes) throw new Error(`${e.message}: ${(Array.isArray(e.detalhes) ? e.detalhes : [e.detalhes]).map(x => x?.message || x?.campo || JSON.stringify(x)).slice(0, 6).join('; ')}`);
    throw e;
  }
}
async function consultarNota(cli, id) { return { ok: true, nota: resumoNota(await nfe(await exigirChave(cli), `/v1/notas/${encodeURIComponent(id)}`)) }; }
async function danfe(cli, id, formato) {
  const j = await nfe(await exigirChave(cli), `/v1/notas/${encodeURIComponent(id)}/danfe?formato=${formato === 'a4' ? 'a4' : 'etiqueta'}`);
  return { ok: true, url: j.url || j.link || j.href };
}

module.exports = { salvarChave, removerChave, status, pedidosAEnviar, previaOuEmitir, consultarNota, danfe, salvarNcm, lerNcm };
