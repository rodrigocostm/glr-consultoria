// ============================================================
// GLR Consultoria — Gerenciamento de Produtos
// ------------------------------------------------------------
// Cadastro central de produtos por cliente (SKU interno, foto, título, custo,
// custo extra) e ASSOCIAÇÃO dos anúncios de cada marketplace a eles — mesma
// lógica do Gestor Seller. O custo do produto (custo + custo extra) é gravado
// no catálogo de custos que Vendas, Financeiro, DRE, Promoções e o portal já
// usam (glr_vendas_custo_catalogo), na chave de cada anúncio associado:
// ML = id do anúncio; Shopee = id do item e nome (a chave que Vendas usa).
// Produtos: glr_produtos (lista com gravação item a item — vários analistas).
// ============================================================
Router.register('produtos', (params, el) => {
  const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch (e) { return d; } };
  const normSku = s => String(s || '').trim().toUpperCase();
  const num = v => { const x = parseFloat(String(v ?? '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isNaN(x) ? 0 : x; };
  const MKT = { ml: { nome: 'Mercado Livre', cor: '#d9a400', sigla: 'ML' }, shopee: { nome: 'Shopee', cor: '#eb6834', sigla: 'SH' } };
  const POR_PAGINA = 25;

  const st = {
    cliente: (() => { try { return localStorage.getItem('glr_prod_cliente') || ''; } catch (e) { return ''; } })(),
    busca: '', pagina: 0, filtro: 'todos', carregando: false, progresso: '', anuncios: [], erro: null, modal: null,
  };

  // ── Dados ──
  const todos = () => lerJSON('glr_produtos', []);
  const doCliente = () => todos().filter(p => String(p.clienteId) === String(st.cliente));
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

  // ── Anúncios das contas do cliente (cache de 6 h) ──
  function contasDoCliente() {
    const vinc = lerJSON('glr_mc_vinculos', {});
    return (vinc[String(st.cliente)] || []).map(c => ({
      mkt: c.marketplace === 'shopee' ? 'shopee' : (['meli', 'ml', 'mercadolivre'].includes(c.marketplace) ? 'ml' : null),
      id: String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.external_id),
      nome: c.tags?.[0]?.name || c.nickname || c.external_id,
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
  async function carregarAnuncios(forcar) {
    if (!st.cliente) return;
    const chave = `glr_prod_anuncios_${st.cliente}`;
    const cache = lerJSON(chave, null);
    if (!forcar && cache && Date.now() - cache.em < 6 * 3600000) { st.anuncios = cache.lista; render(); return; }
    st.carregando = true; st.erro = null; render();
    const lista = [];
    try {
      for (const c of contasDoCliente()) {
        try { lista.push(...await buscarAnunciosConta(c)); }
        catch (e) { st.erro = `${c.nome}: ${e.message}`; }
      }
      st.anuncios = lista;
      try { localStorage.setItem(chave, JSON.stringify({ em: Date.now(), lista })); } catch (e) {}
    } finally { st.carregando = false; st.progresso = ''; render(); }
  }

  // ── Associação ──
  const chaveAnuncio = a => `${a.mkt}:${a.id}`;
  function mapaAssociados() {
    const m = new Map();
    for (const p of doCliente()) for (const a of (p.anuncios || [])) m.set(chaveAnuncio(a), p);
    return m;
  }
  const enxuto = a => ({ mkt: a.mkt, conta: a.conta, contaNome: a.contaNome, id: a.id, nome: a.nome, sku: a.sku, imagem: a.imagem });

  // Cria/associa produtos pelo SKU dos anúncios ainda sem produto
  function criarPeloSku() {
    const assoc = mapaAssociados();
    const livres = st.anuncios.filter(a => !assoc.has(chaveAnuncio(a)) && normSku(a.sku));
    if (!livres.length) { alert('Nenhum anúncio sem produto com SKU preenchido. Anúncios sem SKU precisam ser associados à mão.'); return; }
    const grupos = new Map();
    for (const a of livres) { const k = normSku(a.sku); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(a); }
    const existentes = new Map(doCliente().map(p => [normSku(p.sku), p]));
    let novos = 0, associadosExist = 0;
    for (const [sku] of grupos) existentes.has(sku) ? associadosExist++ : novos++;
    if (!confirm(`Encontrei ${livres.length} anúncio(s) sem produto, em ${grupos.size} SKU(s):\n\n• ${novos} produto(s) novo(s) serão criados\n• ${associadosExist} SKU(s) já têm produto e só ganham os anúncios\n\nDepois é só preencher o custo. Continuar?`)) return;
    const lista = todos();
    for (const [sku, anuncios] of grupos) {
      const ja = existentes.get(sku);
      if (ja) {
        const p = lista.find(x => x.id === ja.id); const ant = JSON.parse(JSON.stringify(p));
        p.anuncios = [...p.anuncios, ...anuncios.map(enxuto)]; p.atualizadoEm = new Date().toISOString();
        sincronizarCatalogo(p, ant);
      } else {
        const base = anuncios.find(a => a.imagem) || anuncios[0];
        lista.push({ id: novoId() + lista.length, clienteId: st.cliente, sku: anuncios[0].sku.trim(), nome: base.nome, imagem: base.imagem, custo: 0, custoExtra: 0, anuncios: anuncios.map(enxuto), criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString() });
      }
    }
    salvarTodos(lista);
    st.filtro = 'semcusto'; st.pagina = 0;
    render();
  }

  // ── Planilha ──
  function exportarCsv() {
    const linhas = [['sku', 'nome', 'custo', 'custo_extra', 'anuncios'].join(';')];
    for (const p of doCliente()) linhas.push([p.sku, `"${String(p.nome || '').replace(/"/g, '""')}"`, num(p.custo).toFixed(2).replace('.', ','), num(p.custoExtra).toFixed(2).replace('.', ','), (p.anuncios || []).map(a => `${a.mkt}:${a.id}`).join(' ')].join(';'));
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
      const lista = todos(); let criados = 0, atualizados = 0;
      for (const l of linhas.slice(1)) {
        const c = l.split(sep).map(x => x.replace(/^"|"$/g, '').trim());
        const sku = c[iSku]; if (!sku) continue;
        let p = lista.find(x => String(x.clienteId) === String(st.cliente) && normSku(x.sku) === normSku(sku));
        const ant = p ? JSON.parse(JSON.stringify(p)) : null;
        if (!p) { p = { id: novoId() + lista.length, clienteId: st.cliente, sku, nome: iNome >= 0 && c[iNome] ? c[iNome] : sku, imagem: '', custo: 0, custoExtra: 0, anuncios: [], criadoEm: new Date().toISOString() }; lista.push(p); criados++; } else atualizados++;
        p.custo = num(c[iCusto]); if (iExtra >= 0) p.custoExtra = num(c[iExtra]); if (iNome >= 0 && c[iNome]) p.nome = c[iNome];
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
          <label>Custo do produto (R$)<input id="pr-custo" inputmode="decimal" value="${p.custo ? String(p.custo).replace('.', ',') : ''}" placeholder="0,00"></label>
          <label>Custo extra (R$)<input id="pr-extra" inputmode="decimal" value="${p.custoExtra ? String(p.custoExtra).replace('.', ',') : ''}" placeholder="embalagem, etiqueta…"></label>
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

  function render() {
    const box = document.getElementById('pr-root'); if (!box) return;
    const clientes = [...(GLR.clientes || [])].sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
    if (!st.cliente) {
      box.innerHTML = `<div class="card pr-vazio">Escolha o cliente para ver e cadastrar os produtos dele.<select class="pr-sel" onchange="window._prCliente(this.value)"><option value="">— Cliente —</option>${clientes.map(c => `<option value="${c.id}">${h(c.nome)}</option>`).join('')}</select></div>`;
      return;
    }
    const prods = doCliente();
    const assoc = mapaAssociados();
    const semProduto = st.anuncios.filter(a => !assoc.has(chaveAnuncio(a)));
    const q = st.busca.toLowerCase();
    const F = { todos: () => true, semcusto: p => !(custoTotal(p) > 0), semanuncio: p => !(p.anuncios || []).length };
    const lista = prods.filter(F[st.filtro] || F.todos).filter(p => !q || `${p.sku} ${p.nome} ${(p.anuncios || []).map(a => a.id + ' ' + a.sku).join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => String(a.sku || a.nome).localeCompare(String(b.sku || b.nome), 'pt-BR', { numeric: true }));
    const pags = Math.max(1, Math.ceil(lista.length / POR_PAGINA)); st.pagina = Math.min(st.pagina, pags - 1);
    const pagina = lista.slice(st.pagina * POR_PAGINA, (st.pagina + 1) * POR_PAGINA);
    const chip = (k, t, n) => `<button class="pr-chip ${st.filtro === k ? 'on' : ''}" onclick="window._prFiltro('${k}')">${t} <b>${n}</b></button>`;
    const contas = contasDoCliente();
    box.innerHTML = `
      <div class="pr-topo">
        <select class="pr-sel" onchange="window._prCliente(this.value)">${clientes.map(c => `<option value="${c.id}" ${String(c.id) === String(st.cliente) ? 'selected' : ''}>${h(c.nome)}</option>`).join('')}</select>
        <input class="pr-busca" style="max-width:320px" placeholder="Pesquisar SKU, título ou anúncio…" value="${h(st.busca)}" oninput="window._prBusca(this.value)">
        <span style="flex:1"></span>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('pr-arquivo').click()">⬆ Importar planilha</button>
        <button class="btn btn-secondary btn-sm" onclick="window._prExportar()">⬇ Exportar</button>
        <button class="btn btn-secondary btn-sm" ${st.carregando || !st.anuncios.length ? 'disabled' : ''} onclick="window._prCriarSku()">⚡ Criar pelo SKU dos anúncios</button>
        <button class="btn btn-primary btn-sm" onclick="window._prNovo()">+ Novo produto</button>
        <input type="file" id="pr-arquivo" accept=".csv,text/csv" style="display:none" onchange="if(this.files[0])window._prImportar(this.files[0]);this.value=''">
      </div>
      <div class="pr-info">
        ${chip('todos', 'Produtos', prods.length)}${chip('semcusto', 'Sem custo', prods.filter(F.semcusto).length)}${chip('semanuncio', 'Sem anúncio', prods.filter(F.semanuncio).length)}
        <span class="pr-mut">${contas.length ? `${st.anuncios.length} anúncios em ${contas.length} conta(s) · <b style="color:${semProduto.length ? '#d97706' : 'inherit'}">${semProduto.length} sem produto</b>` : '⚠️ nenhuma conta vinculada a este cliente (vincule na Projeção)'}
        ${st.carregando ? ` · ⏳ ${h(st.progresso)}` : ` · <a href="#" onclick="window._prRecarregar();return false;">atualizar anúncios</a>`}${st.erro ? ` · <span style="color:#dc2626">${h(st.erro)}</span>` : ''}</span>
      </div>
      <div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto">
        <table class="pr-tab"><thead><tr><th>SKU interno</th><th>Imagem</th><th>Título</th><th class="pr-n">Preço de custo</th><th class="pr-n">Custo extra</th><th>Marketplaces associados</th><th></th></tr></thead>
        <tbody>${pagina.map(p => {
          const por = {}; (p.anuncios || []).forEach(a => { por[a.mkt] = (por[a.mkt] || 0) + 1; });
          return `<tr>
            <td class="pr-sku">${h(p.sku || '—')}</td>
            <td>${p.imagem ? `<img class="pr-img" src="${h(p.imagem)}" alt="" loading="lazy">` : '<span class="pr-img"></span>'}</td>
            <td class="pr-tit">${h(p.nome)}</td>
            <td class="pr-n">${num(p.custo) > 0 ? R$(p.custo) : '<span style="color:#dc2626;font-weight:700">sem custo</span>'}</td>
            <td class="pr-n">${R$(p.custoExtra)}</td>
            <td>${Object.keys(por).length ? Object.entries(por).map(([k, n]) => `<span class="pr-mkt" style="--c:${MKT[k].cor}" title="${MKT[k].nome}">${MKT[k].sigla} ${n}</span>`).join(' ') : '<span class="pr-mut">nenhum</span>'}</td>
            <td class="pr-acoes"><button title="Associar anúncios" onclick="window._prAssociar(${p.id})">🔗</button><button title="Editar" onclick="window._prEditar(${p.id})">✎</button><button title="Excluir" onclick="window._prExcluir(${p.id})">🗑</button></td>
          </tr>`;
        }).join('') || `<tr><td colspan="7" class="pr-mut" style="padding:28px;text-align:center">${prods.length ? 'Nada neste filtro.' : 'Nenhum produto ainda. Use <b>⚡ Criar pelo SKU dos anúncios</b> para montar o cadastro a partir dos anúncios, ou <b>+ Novo produto</b>.'}</td></tr>`}</tbody></table>
      </div>
      ${pags > 1 ? `<div class="pr-pag"><button ${st.pagina === 0 ? 'disabled' : ''} onclick="window._prPagina(-1)">‹</button><span>${st.pagina + 1} de ${pags}</span><button ${st.pagina >= pags - 1 ? 'disabled' : ''} onclick="window._prPagina(1)">›</button></div>` : ''}
      </div>
      ${renderModal()}`;
  }

  // ── Ações ──
  const prodPorId = id => todos().find(p => String(p.id) === String(id));
  window._prCliente = v => { st.cliente = v; st.anuncios = []; st.pagina = 0; try { localStorage.setItem('glr_prod_cliente', v); } catch (e) {} render(); carregarAnuncios(false); };
  window._prBusca = v => { st.busca = v; st.pagina = 0; clearTimeout(window._prT); window._prT = setTimeout(() => { render(); const b = document.querySelector('.pr-topo .pr-busca'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 200); };
  window._prFiltro = f => { st.filtro = f; st.pagina = 0; render(); };
  window._prPagina = d => { st.pagina += d; render(); };
  window._prRecarregar = () => carregarAnuncios(true);
  window._prCriarSku = criarPeloSku;
  window._prExportar = exportarCsv;
  window._prImportar = importarCsv;
  window._prFechar = () => { st.modal = null; render(); };
  window._prNovo = () => { st.modal = { tipo: 'editar', novo: true, prod: { id: novoId(), clienteId: st.cliente, sku: '', nome: '', imagem: '', custo: 0, custoExtra: 0, anuncios: [], criadoEm: new Date().toISOString() } }; render(); };
  window._prEditar = id => { const p = prodPorId(id); if (!p) return; st.modal = { tipo: 'editar', prod: JSON.parse(JSON.stringify(p)), anterior: JSON.parse(JSON.stringify(p)) }; render(); };
  window._prSalvarEdicao = () => {
    const p = st.modal.prod, v = id => document.getElementById(id)?.value?.trim() || '';
    p.sku = v('pr-sku'); p.nome = v('pr-nome'); p.custo = num(v('pr-custo')); p.custoExtra = num(v('pr-extra')); p.imagem = v('pr-img');
    if (!p.nome && !p.sku) { alert('Preencha ao menos o SKU ou o título.'); return; }
    if (p.sku && doCliente().some(x => x.id !== p.id && normSku(x.sku) === normSku(p.sku))) { alert('Já existe um produto com esse SKU neste cliente.'); return; }
    salvarProduto(p, st.modal.anterior || null); st.modal = null; render();
  };
  window._prExcluir = id => { const p = prodPorId(id); if (p && confirm(`Excluir o produto "${p.nome}"? Os anúncios ficam livres para associar de novo.`)) { excluirProduto(p); render(); } };
  window._prAssociar = id => { const p = prodPorId(id); if (!p) return; st.modal = { tipo: 'assoc', prod: p, sel: (p.anuncios || []).map(chaveAnuncio), q: '' }; render(); if (!st.anuncios.length) carregarAnuncios(false); };
  window._prBuscaAssoc = v => { st.modal.q = v; clearTimeout(window._prT2); window._prT2 = setTimeout(() => { render(); const b = document.querySelector('.pr-modal .pr-busca'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 200); };
  window._prMarcar = k => { if (!st.modal.sel.includes(k)) st.modal.sel.push(k); render(); };
  window._prDesmarcar = k => { st.modal.sel = st.modal.sel.filter(x => x !== k); render(); };
  window._prConfirmarAssoc = () => {
    const ant = JSON.parse(JSON.stringify(st.modal.prod));
    const p = prodPorId(ant.id); if (!p) { st.modal = null; render(); return; }
    p.anuncios = st.modal.sel.map(k => st.anuncios.find(a => chaveAnuncio(a) === k) || ant.anuncios.find(a => chaveAnuncio(a) === k)).filter(Boolean).map(enxuto);
    if (!p.imagem) p.imagem = p.anuncios.find(a => a.imagem)?.imagem || '';
    salvarProduto(p, ant); st.modal = null; render();
  };

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px"><div style="font-size:22px;font-weight:800;color:var(--text-primary)">📦 Produtos</div></div>
    <div class="pr-mut" style="margin-bottom:16px;max-width:900px">Cadastre cada produto uma vez (SKU interno, custo e custo extra) e associe os anúncios dele no Mercado Livre e na Shopee. O custo passa a valer em todos os anúncios associados — Vendas, Financeiro, DRE, Promoções e portal do cliente.</div>
    <div id="pr-root"></div>
  </div>
  <style>
    .pr-mut{font-size:12px;color:var(--text-muted)}
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
