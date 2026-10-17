// ============================================================
// GLR Consultoria — Gerenciamento de Produtos
// ------------------------------------------------------------
// Produtos por cliente (SKU interno, foto, título, custo, custo extra) e
// ASSOCIAÇÃO dos anúncios de cada marketplace a eles — mesma lógica do Gestor
// Seller. Ao escolher o cliente a lista monta sozinha a partir dos anúncios:
//  • produtos já cadastrados (glr_produtos);
//  • anúncios ainda sem produto, agrupados pelo SKU que já têm (sem SKU = uma
//    linha por anúncio) — viram produto cadastrado quando o custo é lançado;
//  • custo atual = o do produto ou, se não tiver, o já lançado no anúncio
//    (glr_vendas_custo_catalogo, o mesmo de Vendas/Financeiro/DRE/Promoções).
// O custo do produto (custo + custo extra) é gravado no catálogo de custos na
// chave de cada anúncio associado: ML = id do anúncio; Shopee = id e nome.
// No portal do cliente a tela é só de consulta (contas do próprio cliente).
// ============================================================
Router.register('produtos', (params, el) => {
  const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch (e) { return d; } };
  const normSku = s => String(s || '').trim().toUpperCase();
  const num = v => { const x = parseFloat(String(v ?? '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isNaN(x) ? 0 : x; };
  const dec = v => (num(v) > 0 ? num(v).toFixed(2).replace('.', ',') : '');
  const clone = o => JSON.parse(JSON.stringify(o));
  const MKT = { ml: { nome: 'Mercado Livre', cor: '#d9a400', sigla: 'ML' }, shopee: { nome: 'Shopee', cor: '#eb6834', sigla: 'SH' } };
  const mktDe = m => { m = String(m || '').toLowerCase(); return m.includes('shopee') ? 'shopee' : (['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : null); };
  const POR_PAGINA = 25;
  const cfgPortal = window._portalConfig || null;
  const portal = !!cfgPortal;

  const st = {
    cliente: portal ? String(cfgPortal.clienteId) : (() => { try { return localStorage.getItem('glr_prod_cliente') || ''; } catch (e) { return ''; } })(),
    busca: '', pagina: 0, filtro: 'todos', carregando: false, progresso: '', anuncios: [], contas: [], erro: null, modal: null,
    rows: [], materializados: {}, // linha virtual -> id do produto criado ao lançar o custo
  };

  // ── Dados ──
  const todos = () => lerJSON('glr_produtos', []);
  const doCliente = () => portal ? [] : todos().filter(p => String(p.clienteId) === String(st.cliente));
  function salvarTodos(lista) { localStorage.setItem('glr_produtos', JSON.stringify(lista)); } // sync item a item (supabase-init)
  function salvarProduto(prod, anterior) {
    const lista = todos();
    const i = lista.findIndex(p => p.id === prod.id);
    prod.atualizadoEm = new Date().toISOString();
    if (i >= 0) lista[i] = prod; else lista.push(prod);
    salvarTodos(lista);
    sincronizarCatalogo(prod, anterior);
  }
  function excluirProduto(prod) {
    salvarTodos(todos().filter(p => p.id !== prod.id));
    sincronizarCatalogo(null, prod);
  }
  const novoId = () => Date.now() * 100 + Math.floor(Math.random() * 100);

  // Chaves do catálogo de custos para um anúncio (as que Vendas/Promoções procuram)
  const chavesCatalogo = a => a.mkt === 'shopee' ? [String(a.id), a.nome].filter(Boolean) : [String(a.id)];
  const custoTotal = p => (num(p.custo) + num(p.custoExtra));
  // Grava o custo do produto em cada anúncio associado; tira dos que saíram
  // (só se o valor ainda for o do produto — não apaga custo lançado à mão)
  function sincronizarCatalogo(prod, anterior) {
    const cat = lerJSON('glr_vendas_custo_catalogo', {});
    let mudou = false;
    const novo = prod ? new Set(prod.anuncios.flatMap(chavesCatalogo)) : new Set();
    if (anterior) {
      const vAnt = custoTotal(anterior);
      for (const k of anterior.anuncios.flatMap(chavesCatalogo)) if (!novo.has(k) && Math.abs(num(cat[k]) - vAnt) < 0.005) { delete cat[k]; mudou = true; }
    }
    if (prod && custoTotal(prod) > 0) {
      const v = Math.round(custoTotal(prod) * 100) / 100;
      for (const k of novo) if (cat[k] !== v) { cat[k] = v; mudou = true; }
    }
    if (mudou) localStorage.setItem('glr_vendas_custo_catalogo', JSON.stringify(cat));
  }

  // ── Contas e anúncios do cliente (cache de 6 h) ──
  async function obterContas() {
    if (portal) {
      const ids = new Set((cfgPortal.contaIds || []).map(String));
      const lista = await MarketplaceAPI.listAccounts();
      return (lista || []).filter(c => ids.has(String(c.external_id))).map(c => ({
        mkt: mktDe(c.marketplace), id: String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.external_id), nome: c.nickname || c.external_id,
      })).filter(c => c.mkt);
    }
    const vinc = lerJSON('glr_mc_vinculos', {});
    return (vinc[String(st.cliente)] || []).map(c => ({
      mkt: mktDe(c.marketplace), id: String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.external_id), nome: c.tags?.[0]?.name || c.nickname || c.external_id,
    })).filter(c => c.mkt);
  }
  async function tentar(fn, n = 3) {
    for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n - 1) throw e; await new Promise(r => setTimeout(r, 700 * (i + 1))); } }
  }
  async function buscarAnunciosConta(c) {
    const out = [];
    if (c.mkt === 'ml') {
      for (let off = 0; off < 3000; off += 100) {
        st.progresso = `${c.nome}: anúncios ${off}…`; render();
        const r = await tentar(() => MarketplaceAPI.call('list_items', { meliUserId: c.id, status: 'active', limit: 100, offset: off, com_atributos: true }));
        const lote = r?.results || r?.data?.results || [];
        for (const e of lote) {
          const b = e && typeof e === 'object' ? (e.body || e) : null; if (!b?.id) continue;
          const skuAttr = (b.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name;
          out.push({ mkt: 'ml', conta: c.id, contaNome: c.nome, id: String(b.id), nome: b.title, sku: skuAttr || b.seller_custom_field || '', imagem: (b.thumbnail || '').replace(/^http:/, 'https:'), preco: b.price });
        }
        if (lote.length < 100) break;
      }
    } else {
      const ids = [];
      for (let off = 0; off < 5000; off += 100) {
        st.progresso = `${c.nome}: itens ${off}…`; render();
        const r = await tentar(() => MarketplaceAPI.call('shopee_list_items', { shopId: c.id, item_status: 'NORMAL', offset: off, page_size: 100 }));
        const resp = r?.data?.response || r?.response || {};
        (resp.item || []).forEach(i => ids.push(i.item_id));
        if (!resp.has_next_page) break;
      }
      for (let i = 0; i < ids.length; i += 50) {
        st.progresso = `${c.nome}: detalhes ${i}/${ids.length}…`; render();
        const r = await tentar(() => MarketplaceAPI.call('shopee_get_items_batch', { shopId: c.id, item_id_list: ids.slice(i, i + 50) }));
        for (const d of (r?.data?.response?.item_list || r?.response?.item_list || r?.data?.item_list || [])) {
          out.push({ mkt: 'shopee', conta: c.id, contaNome: c.nome, id: String(d.item_id), nome: d.item_name, sku: d.item_sku || '', imagem: d.image?.image_url_list?.[0] || '', preco: d.price_info?.[0]?.current_price ?? null });
        }
      }
    }
    return out;
  }
  let geracao = 0; // troca de cliente no meio da busca: descarta a busca antiga
  async function carregarAnuncios(forcar) {
    if (!st.cliente) return;
    const minha = ++geracao;
    const chave = `glr_prod_anuncios_${st.cliente}`;
    const cache = lerJSON(chave, null);
    st.carregando = true; st.erro = null; render();
    try {
      st.contas = await obterContas();
      if (minha !== geracao) return;
      if (!forcar && cache && Date.now() - cache.em < 6 * 3600000) { st.anuncios = cache.lista; return; }
      const lista = [];
      for (const c of st.contas) {
        try { lista.push(...await buscarAnunciosConta(c)); }
        catch (e) { st.erro = `${c.nome}: ${e.message}`; }
        if (minha !== geracao) return;
      }
      st.anuncios = lista;
      try { localStorage.setItem(chave, JSON.stringify({ em: Date.now(), lista })); } catch (e) {}
    } catch (e) { if (minha === geracao) st.erro = e.message; }
    finally {
      if (minha === geracao) { st.carregando = false; st.progresso = ''; associarPeloSku(); render(); }
    }
  }

  // ── Associação ──
  const chaveAnuncio = a => `${a.mkt}:${a.id}`;
  function mapaAssociados() {
    const m = new Map();
    for (const p of doCliente()) for (const a of (p.anuncios || [])) m.set(chaveAnuncio(a), p);
    return m;
  }
  const enxuto = a => ({ mkt: a.mkt, conta: a.conta, contaNome: a.contaNome, id: a.id, nome: a.nome, sku: a.sku, imagem: a.imagem });

  // Anúncio novo com o SKU de um produto já cadastrado entra nele sozinho
  function associarPeloSku() {
    if (portal) return;
    const prods = doCliente(); if (!prods.length) return;
    const assoc = mapaAssociados();
    const porSku = new Map(prods.filter(p => normSku(p.sku)).map(p => [normSku(p.sku), p]));
    const novos = new Map();
    for (const a of st.anuncios) {
      const p = porSku.get(normSku(a.sku));
      if (!p || assoc.has(chaveAnuncio(a))) continue;
      if (!novos.has(p.id)) novos.set(p.id, []);
      novos.get(p.id).push(a);
    }
    if (!novos.size) return;
    const lista = todos();
    for (const [id, ans] of novos) {
      const p = lista.find(x => x.id === id); const ant = clone(p);
      p.anuncios = [...(p.anuncios || []), ...ans.map(enxuto)]; p.atualizadoEm = new Date().toISOString();
      sincronizarCatalogo(p, ant);
    }
    salvarTodos(lista);
  }

  // ── Linhas da tabela: produtos cadastrados + anúncios ainda sem produto ──
  function montarLinhas() {
    const cat = lerJSON('glr_vendas_custo_catalogo', {});
    const custoDoAnuncio = a => { for (const k of chavesCatalogo(a)) { const v = num(cat[k]); if (v > 0) return v; } return 0; };
    const prods = doCliente();
    const assoc = new Set(prods.flatMap(p => (p.anuncios || []).map(chaveAnuncio)));
    const rows = prods.map(p => {
      const proprio = custoTotal(p) > 0;
      const cats = proprio ? [] : (p.anuncios || []).map(custoDoAnuncio).filter(v => v > 0);
      return { id: String(p.id), sku: p.sku, nome: p.nome, imagem: p.imagem, anuncios: p.anuncios || [],
        custo: proprio ? num(p.custo) : (cats[0] || 0), custoExtra: proprio ? num(p.custoExtra) : 0,
        origem: proprio ? 'produto' : (cats.length ? 'anuncio' : ''), diverge: new Set(cats).size > 1 };
    });
    const grupos = new Map();
    for (const a of st.anuncios) {
      if (assoc.has(chaveAnuncio(a))) continue;
      const k = normSku(a.sku) ? 'sku:' + normSku(a.sku) : 'an:' + chaveAnuncio(a);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(a);
    }
    for (const [k, ans] of grupos) {
      const base = ans.find(a => a.imagem) || ans[0];
      const cats = ans.map(custoDoAnuncio).filter(v => v > 0);
      rows.push({ id: 'v:' + k, virtual: true, sku: normSku(ans[0].sku) ? String(ans[0].sku).trim() : '', nome: base.nome, imagem: base.imagem, anuncios: ans,
        custo: cats[0] || 0, custoExtra: 0, origem: cats.length ? 'anuncio' : '', diverge: new Set(cats).size > 1 });
    }
    return rows.sort((a, b) => (a.sku ? 0 : 1) - (b.sku ? 0 : 1) || String(a.sku || a.nome).localeCompare(String(b.sku || b.nome), 'pt-BR', { numeric: true }));
  }
  const temCusto = r => r.custo + r.custoExtra > 0;
  const materializar = r => ({ id: novoId(), clienteId: st.cliente, sku: r.sku, nome: r.nome, imagem: r.imagem, custo: r.custo, custoExtra: r.custoExtra,
    anuncios: r.anuncios.map(enxuto), criadoEm: new Date().toISOString() });
  const linha = i => st.rows[i]; // índice em st.rows (refeito a cada render)
  const prodPorId = id => todos().find(p => String(p.id) === String(id));
  // Produto cadastrado da linha (cria na hora se a linha ainda é só anúncio)
  function produtoDaLinha(r) {
    const idReal = r.virtual ? st.materializados[r.id] : r.id;
    const p = idReal ? prodPorId(idReal) : null;
    if (p) return { p, ant: clone(p) };
    return { p: materializar(r), ant: null };
  }

  // ── Planilha ──
  function exportarCsv() {
    const linhas = [['sku', 'nome', 'custo', 'custo_extra', 'anuncios'].join(';')];
    for (const r of montarLinhas()) linhas.push([r.sku, `"${String(r.nome || '').replace(/"/g, '""')}"`, num(r.custo).toFixed(2).replace('.', ','), num(r.custoExtra).toFixed(2).replace('.', ','), r.anuncios.map(a => `${a.mkt}:${a.id}`).join(' ')].join(';'));
    const blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `produtos_${(GLR.clientes.find(c => String(c.id) === String(st.cliente))?.nome || st.cliente).replace(/\s+/g, '_')}.csv`; a.click();
  }
  function importarCsv(arquivo) {
    const leitor = new FileReader();
    leitor.onload = () => {
      const txt = String(leitor.result || '').replace(/^﻿/, '');
      const primeira = txt.split('\n')[0];
      const sep = (primeira.match(/;/g) || []).length >= (primeira.match(/,/g) || []).length ? ';' : ',';
      const linhas = txt.split(/\r?\n/).filter(l => l.trim());
      const cab = linhas[0].toLowerCase().split(sep).map(c => c.replace(/"/g, '').trim());
      const iSku = cab.findIndex(c => c.startsWith('sku')), iNome = cab.findIndex(c => c === 'nome' || c === 'titulo' || c === 'título');
      const iCusto = cab.findIndex(c => ['custo', 'custo unitario', 'custo unitário', 'preço de custo', 'preco de custo'].includes(c));
      const iExtra = cab.findIndex(c => c.startsWith('custo_extra') || c.startsWith('custo extra'));
      if (iSku < 0 || iCusto < 0) { alert('A planilha precisa das colunas "sku" e "custo" (opcionais: "nome", "custo_extra"). Separador ; ou ,'); return; }
      const virtuais = new Map(montarLinhas().filter(r => r.virtual && r.sku).map(r => [normSku(r.sku), r]));
      const lista = todos(); let criados = 0, atualizados = 0;
      for (const l of linhas.slice(1)) {
        const c = l.split(sep).map(x => x.replace(/^"|"$/g, '').trim());
        const sku = c[iSku]; if (!sku) continue;
        let p = lista.find(x => String(x.clienteId) === String(st.cliente) && normSku(x.sku) === normSku(sku));
        const ant = p ? clone(p) : null;
        if (!p) {
          const v = virtuais.get(normSku(sku));
          p = v ? materializar(v) : { id: novoId() + lista.length, clienteId: st.cliente, sku, nome: sku, imagem: '', custo: 0, custoExtra: 0, anuncios: [], criadoEm: new Date().toISOString() };
          p.id += lista.length; lista.push(p); criados++;
        } else atualizados++;
        p.custo = num(c[iCusto]); p.custoExtra = iExtra >= 0 ? num(c[iExtra]) : (ant ? num(p.custoExtra) : 0);
        if (iNome >= 0 && c[iNome]) p.nome = c[iNome];
        p.atualizadoEm = new Date().toISOString();
        sincronizarCatalogo(p, ant);
      }
      salvarTodos(lista);
      alert(`Planilha importada: ${atualizados} produto(s) atualizado(s), ${criados} criado(s).`);
      render();
    };
    leitor.readAsText(arquivo, 'utf-8');
  }

  // ── Telas ──
  function renderModal() {
    const m = st.modal; if (!m) return '';
    if (m.tipo === 'editar') {
      const p = m.prod;
      return `<div class="pr-fundo" onclick="if(event.target===this)window._prFechar()"><div class="pr-modal">
        <div class="pr-modal-t">${m.novo ? 'Novo produto' : 'Editar produto'}</div>
        <div class="pr-campos">
          <label>SKU interno<input id="pr-sku" value="${h(p.sku)}" placeholder="ex.: JC-002"></label>
          <label class="pr-larga">Título<input id="pr-nome" value="${h(p.nome)}" placeholder="Nome do produto"></label>
          <label>Custo do produto (R$)<input id="pr-custo" inputmode="decimal" value="${dec(p.custo)}" placeholder="0,00"></label>
          <label>Custo extra (R$)<input id="pr-extra" inputmode="decimal" value="${dec(p.custoExtra)}" placeholder="embalagem, etiqueta…"></label>
          <label class="pr-larga">Foto (link)<input id="pr-img" value="${h(p.imagem)}" placeholder="https://…"></label>
        </div>
        <div class="pr-mut">O custo + custo extra vale para todos os anúncios associados (Vendas, Financeiro, DRE, Promoções e portal).</div>
        <div class="pr-modal-b"><button class="btn btn-secondary" onclick="window._prFechar()">Cancelar</button><button class="btn btn-primary" onclick="window._prSalvarEdicao()">Salvar</button></div>
      </div></div>`;
    }
    // associar
    const p = m.prod, assoc = mapaAssociados(), sel = new Set(m.sel);
    const q = (m.q || '').toLowerCase();
    const livres = st.anuncios.filter(a => !sel.has(chaveAnuncio(a)) && (!assoc.has(chaveAnuncio(a)) || assoc.get(chaveAnuncio(a)).id === p.id))
      .filter(a => !q || `${a.nome} ${a.sku} ${a.id}`.toLowerCase().includes(q))
      .sort((a, b) => (normSku(b.sku) === normSku(p.sku)) - (normSku(a.sku) === normSku(p.sku)));
    const dosSel = m.sel.map(k => st.anuncios.find(a => chaveAnuncio(a) === k) || p.anuncios.find(a => chaveAnuncio(a) === k)).filter(Boolean);
    const card = (a, acao) => `<div class="pr-an"><img src="${h(a.imagem)}" alt="" loading="lazy"><div><div class="pr-an-n">${h(a.nome)}</div>
      <div class="pr-mut"><span class="pr-mkt" style="--c:${MKT[a.mkt].cor}">${MKT[a.mkt].sigla}</span> ${h(a.contaNome || '')} · ${h(a.id)}${a.sku ? ` · SKU ${h(a.sku)}` : ''}</div></div>${acao}</div>`;
    return `<div class="pr-fundo" onclick="if(event.target===this)window._prFechar()"><div class="pr-modal pr-modal-g">
      <div class="pr-modal-t">Associar anúncios</div>
      <div class="pr-prod">${p.imagem ? `<img src="${h(p.imagem)}" alt="">` : ''}<div><b>${h(p.nome)}</b><div class="pr-mut">SKU interno: ${h(p.sku || '—')}</div></div></div>
      <div class="pr-assoc">
        <div><div class="pr-col-t">Anúncios não associados ${st.carregando ? '⏳' : `(${livres.length})`}</div>
          <input class="pr-busca" placeholder="Pesquisar por título, SKU ou código…" value="${h(m.q || '')}" oninput="window._prBuscaAssoc(this.value)">
          <div class="pr-lista">${livres.slice(0, 200).map(a => card(a, `<button class="btn btn-sm btn-secondary" onclick="window._prMarcar('${chaveAnuncio(a)}')">Associar</button>`)).join('') || `<div class="pr-mut" style="padding:16px">${st.anuncios.length ? 'Nada encontrado.' : 'Nenhum anúncio carregado — confira as contas vinculadas ao cliente.'}</div>`}</div></div>
        <div><div class="pr-col-t">Anúncios associados (${dosSel.length})</div>
          <div class="pr-lista">${dosSel.map(a => card(a, `<button class="btn btn-sm pr-des" onclick="window._prDesmarcar('${chaveAnuncio(a)}')">Desassociar</button>`)).join('') || '<div class="pr-mut" style="padding:16px">Nenhum anúncio associado.</div>'}</div></div>
      </div>
      <div class="pr-modal-b"><button class="btn btn-secondary" onclick="window._prFechar()">Fechar</button><button class="btn btn-primary" onclick="window._prConfirmarAssoc()">Confirmar</button></div>
    </div></div>`;
  }

  const F = { todos: () => true, semcusto: r => !temCusto(r), comcusto: temCusto, semanuncio: r => !r.anuncios.length };
  function renderChips() {
    const rows = st.rows;
    const chip = (k, t, n) => `<button class="pr-chip ${st.filtro === k ? 'on' : ''}" onclick="window._prFiltro('${k}')">${t} <b>${n}</b></button>`;
    const semAn = rows.filter(F.semanuncio).length;
    return chip('todos', 'Todos', rows.length) + chip('semcusto', 'Sem custo', rows.filter(F.semcusto).length) + chip('comcusto', 'Com custo', rows.filter(F.comcusto).length) + (semAn ? chip('semanuncio', 'Sem anúncio', semAn) : '');
  }
  function celulaCusto(r, campo, i) {
    const v = r[campo];
    if (portal) return campo === 'custo' && !temCusto(r) ? '<span class="pr-sem">sem custo</span>' : R$(v);
    return `<input class="pr-in ${campo === 'custo' && !temCusto(r) ? 'vazio' : ''}" id="pr-${campo}-${i}" inputmode="decimal" placeholder="${campo === 'custo' ? 'sem custo' : '0,00'}" value="${dec(v)}"
      onchange="window._prCusto(${st.rows.indexOf(r)},'${campo}',this)" onkeydown="if(event.key==='Enter')this.blur()">`;
  }

  function render() {
    const box = document.getElementById('pr-root'); if (!box) return;
    const clientes = [...(GLR.clientes || [])].sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
    const vinc = lerJSON('glr_mc_vinculos', {});
    const selCliente = portal ? '' : `<select class="pr-sel" onchange="window._prCliente(this.value)"><option value="">— Escolha o cliente —</option>${clientes.map(c => `<option value="${c.id}" ${String(c.id) === String(st.cliente) ? 'selected' : ''}>${h(c.nome)}${(vinc[String(c.id)] || []).length ? '' : ' (sem contas)'}</option>`).join('')}</select>`;
    if (!st.cliente) { box.innerHTML = `<div class="card pr-vazio">Escolha o cliente para carregar os produtos dele.${selCliente}</div>`; return; }

    st.rows = montarLinhas(); st.materializados = {};
    const q = st.busca.toLowerCase();
    const lista = st.rows.filter(F[st.filtro] || F.todos).filter(r => !q || `${r.sku} ${r.nome} ${r.anuncios.map(a => a.id + ' ' + a.sku).join(' ')}`.toLowerCase().includes(q));
    const pags = Math.max(1, Math.ceil(lista.length / POR_PAGINA)); st.pagina = Math.min(st.pagina, pags - 1);
    const pagina = lista.slice(st.pagina * POR_PAGINA, (st.pagina + 1) * POR_PAGINA);
    const carregandoVazio = st.carregando && !st.anuncios.length;
    box.innerHTML = `
      <div class="pr-topo">
        ${selCliente}
        <input class="pr-busca" style="max-width:320px" placeholder="Pesquisar SKU, título ou anúncio…" value="${h(st.busca)}" oninput="window._prBusca(this.value)">
        <span style="flex:1"></span>
        ${portal ? '' : `<button class="btn btn-secondary btn-sm" onclick="document.getElementById('pr-arquivo').click()">⬆ Importar planilha</button>
        <button class="btn btn-secondary btn-sm" onclick="window._prExportar()">⬇ Exportar</button>
        <button class="btn btn-primary btn-sm" onclick="window._prNovo()">+ Novo produto</button>
        <input type="file" id="pr-arquivo" accept=".csv,text/csv" style="display:none" onchange="if(this.files[0])window._prImportar(this.files[0]);this.value=''">`}
      </div>
      <div class="pr-info">
        <span id="pr-chips" style="display:contents">${renderChips()}</span>
        <span class="pr-mut">${st.contas.length || st.carregando ? `${st.anuncios.length} anúncios em ${st.contas.length} conta(s)` : (portal ? 'nenhuma conta encontrada' : '⚠️ nenhuma conta vinculada a este cliente (vincule na Projeção)')}
        ${st.carregando ? ` · ⏳ ${h(st.progresso || 'carregando…')}` : ` · <a href="#" onclick="window._prRecarregar();return false;">atualizar anúncios</a>`}${st.erro ? ` · <span style="color:#dc2626">${h(st.erro)}</span>` : ''}</span>
      </div>
      <div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto">
        <table class="pr-tab"><thead><tr><th>SKU interno</th><th>Imagem</th><th>Título</th><th class="pr-n">Preço de custo</th><th class="pr-n">Custo extra</th><th>Marketplaces associados</th>${portal ? '' : '<th></th>'}</tr></thead>
        <tbody>${pagina.map((r, i) => {
          const por = {}; r.anuncios.forEach(a => { por[a.mkt] = (por[a.mkt] || 0) + 1; });
          const nota = r.diverge ? '<div class="pr-nota" style="color:#d97706">⚠ custo diferente entre os anúncios</div>'
            : r.virtual && r.origem === 'anuncio' && !portal ? '<div class="pr-nota">custo já lançado em Vendas</div>' : '';
          return `<tr>
            <td class="pr-sku">${h(r.sku || '—')}${r.virtual && !r.sku ? '<div class="pr-nota">anúncio sem SKU</div>' : ''}</td>
            <td>${r.imagem ? `<img class="pr-img" src="${h(r.imagem)}" alt="" loading="lazy">` : '<span class="pr-img"></span>'}</td>
            <td class="pr-tit">${h(r.nome)}</td>
            <td class="pr-n">${celulaCusto(r, 'custo', i)}${nota}</td>
            <td class="pr-n">${celulaCusto(r, 'custoExtra', i)}</td>
            <td>${Object.keys(por).length ? Object.entries(por).map(([k, n]) => `<span class="pr-mkt" style="--c:${MKT[k].cor}" title="${MKT[k].nome}">${MKT[k].sigla} ${n}</span>`).join(' ') : '<span class="pr-mut">nenhum</span>'}</td>
            ${portal ? '' : `<td class="pr-acoes"><button title="Associar anúncios" onclick="window._prAssociar(${st.rows.indexOf(r)})">🔗</button><button title="Editar" onclick="window._prEditar(${st.rows.indexOf(r)})">✎</button>${r.virtual ? '' : `<button title="Excluir" onclick="window._prExcluir(${st.rows.indexOf(r)})">🗑</button>`}</td>`}
          </tr>`;
        }).join('') || `<tr><td colspan="7" class="pr-mut" style="padding:28px;text-align:center">${carregandoVazio ? '⏳ Carregando os produtos das contas…' : st.rows.length ? 'Nada neste filtro.' : 'Nenhum anúncio ativo encontrado nas contas do cliente.'}</td></tr>`}</tbody></table>
      </div>
      ${pags > 1 ? `<div class="pr-pag"><button ${st.pagina === 0 ? 'disabled' : ''} onclick="window._prPagina(-1)">‹</button><span>${st.pagina + 1} de ${pags}</span><button ${st.pagina >= pags - 1 ? 'disabled' : ''} onclick="window._prPagina(1)">›</button></div>` : ''}
      </div>
      ${renderModal()}`;
  }

  // ── Ações ──
  window._prCliente = v => { st.cliente = v; st.anuncios = []; st.contas = []; st.pagina = 0; st.filtro = 'todos'; try { localStorage.setItem('glr_prod_cliente', v); } catch (e) {} render(); carregarAnuncios(false); };
  window._prBusca = v => { st.busca = v; st.pagina = 0; clearTimeout(window._prT); window._prT = setTimeout(() => { render(); const b = document.querySelector('.pr-topo .pr-busca'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 200); };
  window._prFiltro = f => { st.filtro = f; st.pagina = 0; render(); };
  window._prPagina = d => { st.pagina += d; render(); };
  window._prRecarregar = () => carregarAnuncios(true);
  window._prExportar = exportarCsv;
  window._prImportar = importarCsv;
  window._prFechar = () => { st.modal = null; render(); };
  // Custo direto na tabela: salva sem redesenhar (o cursor segue para o próximo campo)
  window._prCusto = (id, campo, inp) => {
    const valor = inp.value;
    if (portal) return;
    const r = linha(id); if (!r) return;
    const { p, ant } = produtoDaLinha(r);
    if (!ant || !(custoTotal(ant) > 0)) { p.custo = r.custo; p.custoExtra = r.custoExtra; } // parte do custo já lançado no anúncio
    p[campo] = num(valor); r[campo] = p[campo];
    salvarProduto(p, ant);
    if (r.virtual) st.materializados[r.id] = p.id;
    r.origem = 'produto'; r.diverge = false;
    inp.closest('tr')?.querySelector('[id^="pr-custo-"]')?.classList.toggle('vazio', !temCusto(r));
    const chips = document.getElementById('pr-chips'); if (chips) chips.innerHTML = renderChips();
  };
  window._prNovo = () => { st.modal = { tipo: 'editar', novo: true, prod: { id: novoId(), clienteId: st.cliente, sku: '', nome: '', imagem: '', custo: 0, custoExtra: 0, anuncios: [], criadoEm: new Date().toISOString() } }; render(); };
  window._prEditar = id => {
    const r = linha(id); if (!r) return;
    const { p, ant } = produtoDaLinha(r);
    if (!ant || !(custoTotal(ant) > 0)) { p.custo = r.custo; p.custoExtra = r.custoExtra; }
    st.modal = { tipo: 'editar', novo: !ant, prod: p, anterior: ant }; render();
  };
  window._prSalvarEdicao = () => {
    const p = st.modal.prod, v = id => document.getElementById(id)?.value?.trim() || '';
    p.sku = v('pr-sku'); p.nome = v('pr-nome'); p.custo = num(v('pr-custo')); p.custoExtra = num(v('pr-extra')); p.imagem = v('pr-img');
    if (!p.nome && !p.sku) { alert('Preencha ao menos o SKU ou o título.'); return; }
    if (p.sku && doCliente().some(x => x.id !== p.id && normSku(x.sku) === normSku(p.sku))) { alert('Já existe um produto com esse SKU neste cliente.'); return; }
    salvarProduto(p, st.modal.anterior || null); st.modal = null; render();
  };
  window._prExcluir = i => { const p = st.rows[i] && prodPorId(st.rows[i].id); if (p && confirm(`Excluir o produto "${p.nome}"? Os anúncios voltam a aparecer como anúncios sem produto.`)) { excluirProduto(p); render(); } };
  window._prAssociar = id => {
    const r = linha(id); if (!r) return;
    const { p, ant } = produtoDaLinha(r);
    if (!ant || !(custoTotal(ant) > 0)) { p.custo = r.custo; p.custoExtra = r.custoExtra; }
    st.modal = { tipo: 'assoc', prod: p, anterior: ant, sel: (p.anuncios || []).map(chaveAnuncio), q: '' }; render();
  };
  window._prBuscaAssoc = v => { st.modal.q = v; clearTimeout(window._prT2); window._prT2 = setTimeout(() => { render(); const b = document.querySelector('.pr-modal .pr-busca'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 200); };
  window._prMarcar = k => { if (!st.modal.sel.includes(k)) st.modal.sel.push(k); render(); };
  window._prDesmarcar = k => { st.modal.sel = st.modal.sel.filter(x => x !== k); render(); };
  window._prConfirmarAssoc = () => {
    const { prod, anterior } = st.modal;
    const p = clone(prod);
    p.anuncios = st.modal.sel.map(k => st.anuncios.find(a => chaveAnuncio(a) === k) || prod.anuncios.find(a => chaveAnuncio(a) === k)).filter(Boolean).map(enxuto);
    if (!p.imagem) p.imagem = p.anuncios.find(a => a.imagem)?.imagem || '';
    salvarProduto(p, anterior || null); st.modal = null; render();
  };

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px"><div style="font-size:22px;font-weight:800;color:var(--text-primary)">📦 ${portal ? 'Meus produtos' : 'Produtos'}</div></div>
    <div class="pr-mut" style="margin-bottom:16px;max-width:900px">${portal
      ? 'Seus produtos com o custo cadastrado pela GLR. Produto <b>sem custo</b> deixa a margem e o lucro incompletos — fale com a GLR para cadastrar.'
      : 'Escolha o cliente: os produtos carregam das contas dele com o custo atual. Lance o custo direto na tabela — ele vale para todos os anúncios associados (Vendas, Financeiro, DRE, Promoções e portal do cliente).'}</div>
    <div id="pr-root"></div>
  </div>
  <style>
    .pr-mut{font-size:12px;color:var(--text-muted)}
    .pr-nota{font-size:10.5px;color:var(--text-muted);font-weight:400;margin-top:2px;white-space:nowrap}
    .pr-topo{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .pr-sel,.pr-busca{background:var(--bg-card);border:1px solid var(--border);border-radius:9px;color:var(--text-primary);padding:8px 11px;font-size:13px}
    .pr-busca{width:100%}
    .pr-info{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .pr-chip{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12px;cursor:pointer}
    .pr-chip.on{background:#2a78d6;border-color:#2a78d6;color:#fff}
    .pr-tab{width:100%;border-collapse:collapse;font-size:13px}
    .pr-tab th{padding:10px 12px;text-align:left;font-size:10.5px;text-transform:uppercase;color:var(--text-secondary);background:var(--bg-card-hover);white-space:nowrap}
    .pr-tab td{padding:9px 12px;border-bottom:1px solid var(--border);color:var(--text-secondary);vertical-align:middle}
    .pr-n{text-align:right!important;white-space:nowrap;font-variant-numeric:tabular-nums}
    .pr-sku{font-family:ui-monospace,monospace;font-size:12px;color:var(--text-primary)!important;white-space:nowrap}
    .pr-img{width:40px;height:40px;border-radius:8px;object-fit:cover;display:block;background:var(--bg-card-hover)}
    .pr-tit{color:var(--text-primary)!important;font-weight:600;min-width:240px}
    .pr-in{width:96px;text-align:right;background:var(--bg-card-hover);border:1px solid var(--border);border-radius:7px;color:var(--text-primary);padding:6px 8px;font-size:13px;font-variant-numeric:tabular-nums}
    .pr-in:focus{outline:none;border-color:#2a78d6}
    .pr-in.vazio{border-color:#dc2626}.pr-in.vazio::placeholder{color:#dc2626;font-weight:700}
    .pr-sem{color:#dc2626;font-weight:700}
    .pr-mkt{display:inline-block;font-size:11px;font-weight:800;color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent);padding:2px 7px;border-radius:6px}
    .pr-acoes{white-space:nowrap;text-align:right} .pr-acoes button{background:none;border:1px solid var(--border);border-radius:8px;width:30px;height:30px;margin-left:4px;cursor:pointer;color:var(--text-secondary)}
    .pr-acoes button:hover{border-color:#2a78d6}
    .pr-pag{display:flex;gap:10px;justify-content:center;align-items:center;padding:10px;font-size:13px;color:var(--text-secondary)} .pr-pag button{border:1px solid var(--border);background:var(--bg-card);border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text-primary)}
    .pr-vazio{padding:40px;text-align:center;color:var(--text-muted);display:flex;flex-direction:column;gap:12px;align-items:center}
    .pr-fundo{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}
    .pr-modal{background:var(--bg-surface,var(--bg-card));border:1px solid var(--border);border-radius:14px;padding:20px 22px;width:100%;max-width:560px;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.4)}
    .pr-modal-g{max-width:980px}
    .pr-modal-t{font-size:16px;font-weight:800;color:var(--text-primary);margin-bottom:12px}
    .pr-campos{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
    .pr-campos label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)} .pr-larga{grid-column:1/-1}
    .pr-campos input{background:var(--bg-card-hover);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);padding:8px 10px;font-size:13px}
    .pr-modal-b{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
    .pr-prod{display:flex;gap:10px;align-items:center;margin-bottom:12px} .pr-prod img{width:44px;height:44px;border-radius:8px;object-fit:cover}
    .pr-assoc{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media (max-width:760px){.pr-assoc,.pr-campos{grid-template-columns:1fr}}
    .pr-col-t{font-weight:700;font-size:13px;color:var(--text-primary);margin-bottom:6px}
    .pr-lista{border:1px solid var(--border);border-radius:10px;height:380px;overflow:auto;margin-top:6px;padding:6px}
    .pr-an{display:flex;gap:8px;align-items:center;padding:7px;border-bottom:1px solid var(--border)} .pr-an:last-child{border-bottom:none}
    .pr-an img{width:36px;height:36px;border-radius:6px;object-fit:cover;flex:none;background:var(--bg-card-hover)}
    .pr-an>div{flex:1;min-width:0} .pr-an-n{font-size:12.5px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pr-des{border:1px solid #dc2626!important;color:#dc2626!important;background:none!important}
  </style>`;
  render();
  if (st.cliente) carregarAnuncios(false);
});
