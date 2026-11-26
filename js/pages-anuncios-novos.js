// ============================================================
// GLR Consultoria — Anúncios novos
// ------------------------------------------------------------
// Mapa de todos os anúncios CRIADOS nas contas dos clientes (Mercado Livre e
// Shopee) no período: quando foi criado, loja, preço, status, estoque e
// primeiras vendas (ML). Serve para acompanhar o que a equipe/cliente lançou e
// se os lançamentos estão saindo do zero.
//  • ML: /users/{id}/items/search?orders=start_time_desc (mais novos primeiro,
//    para de ler quando passa do início do período) + /items?ids=… (date_created).
//  • Shopee: get_item_list com update_time no período (janelas de 15 dias, limite
//    da Shopee) + get_items_batch → fica só o que tem create_time no período.
// Lê direto do navegador (MarketplaceAPI); guarda 1 h no navegador por período.
// ============================================================
Router.register('anuncios-novos', (params, el) => {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const R$ = v => v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const n0 = v => v == null ? '—' : Number(v).toLocaleString('pt-BR');
  const lerJ = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (e) { return d; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const idDe = c => String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.external_id || '');
  const mktDe = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre', 'mercado livre'].includes(m) ? 'ml' : null; };
  const st = { dias: lerJ('glr_an_dias', 15), mkt: 'todos', busca: '', itens: [], erros: [], carregando: false, progresso: '', em: null };
  let geracao = 0;

  function contas() {
    const vinc = lerJ('glr_mc_vinculos', {}) || {}, foco = String(GLR.ctx?.cliente?.() || '');
    const out = new Map();
    for (const [cid, lista] of Object.entries(vinc)) {
      if (foco && cid !== foco) continue;
      const cli = (GLR.clientes || []).find(c => String(c.id) === String(cid));
      for (const c of (lista || [])) {
        const mkt = mktDe(c.marketplace), id = idDe(c); if (!mkt || !id) continue;
        out.set(`${mkt}:${id}`, { mkt, id, cliente: cli?.nome || '', clienteId: cid, nome: GLR.nomeConta ? GLR.nomeConta(mkt, id) : (c.nickname || id) });
      }
    }
    return [...out.values()];
  }

  async function tentar(fn, n = 3) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n - 1) throw e; await new Promise(r => setTimeout(r, 800 * (i + 1))); } } }

  async function novosML(c, desdeMs) {
    const out = [];
    for (let off = 0; off < 1000; off += 50) {
      const r = await tentar(() => MarketplaceAPI.call('raw_read', { path: `/users/${c.id}/items/search?orders=start_time_desc&limit=50&offset=${off}`, meliUserId: c.id }));
      const ids = (r?.results || r?.data?.results || []).map(String);
      if (!ids.length) break;
      let passou = false;
      for (let i = 0; i < ids.length; i += 20) {
        const d = await tentar(() => MarketplaceAPI.call('raw_read', { path: `/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=id,title,price,original_price,date_created,start_time,status,thumbnail,permalink,sold_quantity,available_quantity,listing_type_id,catalog_listing`, meliUserId: c.id }));
        const lista = Array.isArray(d) ? d : (d?.items || d?.data || []);
        for (const x of lista) {
          const b = x?.body || x; if (!b?.id) continue;
          const t = Date.parse(b.date_created || b.start_time);
          if (!(t >= desdeMs)) { passou = true; continue; }
          out.push({ mkt: 'ml', conta: c, id: String(b.id), titulo: b.title, preco: b.price, criado: t, status: b.status, estoque: b.available_quantity, vendidos: b.sold_quantity ?? null,
            foto: String(b.thumbnail || '').replace(/^http:/, 'https:'), link: b.permalink, extra: [b.listing_type_id === 'gold_pro' ? 'Premium' : b.listing_type_id === 'gold_special' ? 'Clássico' : null, b.catalog_listing ? 'Catálogo' : null].filter(Boolean) });
        }
      }
      if (passou || ids.length < 50) break; // a lista vem do mais novo para o mais antigo
    }
    return out;
  }

  async function novosShopee(c, desdeMs) {
    const ids = new Set(), fim = Math.floor(Date.now() / 1000), ini = Math.floor(desdeMs / 1000);
    for (let a = ini; a < fim; a += 15 * 86400) { // a Shopee aceita janelas de até 15 dias
      const b = Math.min(fim, a + 15 * 86400);
      for (const status of ['NORMAL', 'UNLIST']) {
        for (let off = 0; off < 3000; off += 100) {
          const r = await tentar(() => MarketplaceAPI.call('raw_read', { marketplace: 'shopee', shopId: c.id, path: `/api/v2/product/get_item_list?offset=${off}&page_size=100&item_status=${status}&update_time_from=${a}&update_time_to=${b}` }));
          const resp = r?.response || r?.data?.response || {};
          (resp.item || []).forEach(i => ids.add(i.item_id));
          if (!resp.has_next_page) break;
        }
      }
    }
    const out = [], lista = [...ids];
    for (let i = 0; i < lista.length; i += 50) {
      const r = await tentar(() => MarketplaceAPI.call('shopee_get_items_batch', { shopId: c.id, item_id_list: lista.slice(i, i + 50) }));
      for (const d of (r?.data?.response?.item_list || r?.response?.item_list || r?.data?.item_list || [])) {
        const t = (d.create_time || 0) * 1000; if (!(t >= desdeMs)) continue;
        const pi = d.price_info?.[0] || {};
        const est = d.stock_info_v2?.summary_info?.total_available_stock ?? (d.stock_info_v2?.seller_stock || []).reduce((s, x) => s + (x.stock || 0), 0);
        out.push({ mkt: 'shopee', conta: c, id: String(d.item_id), titulo: d.item_name, preco: pi.current_price ?? null, criado: t, status: d.item_status === 'NORMAL' ? 'active' : d.item_status === 'UNLIST' ? 'paused' : String(d.item_status || '').toLowerCase(),
          estoque: d.has_model ? null : est, vendidos: null, foto: d.image?.image_url_list?.[0] || '', link: `https://shopee.com.br/product/${c.id}/${d.item_id}`, extra: d.has_model ? ['Com variações'] : [] });
      }
    }
    return out;
  }

  async function carregar(forcar) {
    const minha = ++geracao, lista = contas();
    const chave = `glr_an_cache_${st.dias}_${GLR.ctx?.cliente?.() || 'todos'}`;
    const cache = lerJ(chave, null);
    if (!forcar && cache && Date.now() - cache.em < 3600e3) {
      st.itens = cache.itens.map(x => ({ ...x, conta: lista.find(c => c.mkt === x.mkt && c.id === x.contaId) || { mkt: x.mkt, id: x.contaId, nome: x.contaNome, cliente: x.cliente } }));
      st.erros = cache.erros || []; st.em = cache.em; st.carregando = false; render(); return;
    }
    const desde = Date.now() - st.dias * 864e5;
    st.carregando = true; st.itens = []; st.erros = []; st.progresso = `0 de ${lista.length} contas`; render();
    let feitas = 0;
    const fila = [...lista];
    async function trabalhador() {
      while (fila.length) {
        const c = fila.shift();
        try { const r = c.mkt === 'ml' ? await novosML(c, desde) : await novosShopee(c, desde); if (minha !== geracao) return; st.itens.push(...r); }
        catch (e) { if (minha === geracao) st.erros.push(`${c.nome}: ${String(e.message || e).slice(0, 120)}`); }
        if (minha !== geracao) return;
        feitas++; st.progresso = `${feitas} de ${lista.length} contas`; render();
      }
    }
    await Promise.all(Array.from({ length: 4 }, trabalhador));
    if (minha !== geracao) return;
    st.carregando = false; st.em = Date.now();
    gravar(chave, { em: st.em, erros: st.erros, itens: st.itens.map(x => ({ ...x, conta: undefined, contaId: x.conta.id, contaNome: x.conta.nome, cliente: x.conta.cliente })) });
    render();
  }

  const diaTxt = t => { const d = new Date(t), hoje = new Date(); const dd = Math.round((new Date(hoje.toDateString()) - new Date(d.toDateString())) / 864e5);
    return dd === 0 ? 'Hoje' : dd === 1 ? 'Ontem' : d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' }); };
  const STATUS = { active: ['Ativo', 'ok'], paused: ['Pausado', 'pausa'], closed: ['Finalizado', 'fim'], under_review: ['Em revisão', 'pausa'], inactive: ['Inativo', 'fim'] };

  function render() {
    if (!Router.estaEm('anuncios-novos')) return;
    const foco = GLR.ctx?.cliente?.();
    const q = st.busca.trim().toLowerCase();
    const vis = st.itens.filter(x => (st.mkt === 'todos' || x.mkt === st.mkt) && (!q || `${x.titulo} ${x.conta.nome} ${x.conta.cliente} ${x.id}`.toLowerCase().includes(q))).sort((a, b) => b.criado - a.criado);
    const comVenda = vis.filter(x => x.vendidos > 0).length, semEst = vis.filter(x => x.estoque === 0).length, parados = vis.filter(x => x.status !== 'active').length;
    const porCli = new Map(); for (const x of vis) { const k = x.conta.cliente || x.conta.nome; porCli.set(k, (porCli.get(k) || 0) + 1); }
    const ranking = [...porCli.entries()].sort((a, b) => b[1] - a[1]);
    const maxCli = ranking[0]?.[1] || 1;
    const grupos = new Map(); for (const x of vis) { const k = new Date(x.criado).toDateString(); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(x); }
    const card = x => { const s = STATUS[x.status] || [x.status || '—', 'fim'];
      return `<a class="an-card" href="${h(x.link)}" target="_blank" rel="noopener">
        ${x.foto ? `<img src="${h(x.foto)}" alt="" loading="lazy">` : '<span class="an-ph"></span>'}
        <div class="an-corpo">
          <div class="an-tit">${h(x.titulo)}</div>
          <div class="an-loja">${GLR.iconeMkt ? GLR.iconeMkt(x.mkt) : ''}<span class="mkt-sem-icone">${h(x.conta.cliente && !String(x.conta.nome).toLowerCase().startsWith(String(x.conta.cliente).toLowerCase()) ? `${x.conta.cliente} · ` : '')}${h(x.conta.nome)}</span></div>
          <div class="an-meta"><b>${R$(x.preco)}</b><span class="an-st ${s[1]}">${h(s[0])}</span>${(x.extra || []).map(e => `<span class="an-tag">${h(e)}</span>`).join('')}</div>
          <div class="an-num"><span>Estoque <b>${x.estoque == null ? '—' : n0(x.estoque)}</b></span>${x.mkt === 'ml' ? `<span>Vendidos <b class="${x.vendidos > 0 ? 'pos' : ''}">${n0(x.vendidos)}</b></span>` : ''}<span>${new Date(x.criado).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span></div>
        </div></a>`; };
    el.innerHTML = `<div class="page an">
      <header class="an-cab"><div><span class="an-eyebrow">Anúncios e produtos</span><h2>Anúncios novos</h2>
        <p>Todos os anúncios criados ${foco ? 'nas contas deste cliente' : 'nas contas dos clientes'} no Mercado Livre e na Shopee — o que foi lançado, quando, e se já está vendendo.</p></div>
        <button class="btn btn-secondary btn-sm" id="an-atualizar" ${st.carregando ? 'disabled' : ''}>${st.carregando ? 'Atualizando…' : 'Atualizar'}</button></header>
      <div class="an-filtros card">
        <div class="an-seg" role="group" aria-label="Período">${[7, 15, 30].map(d => `<button type="button" class="${st.dias === d ? 'on' : ''}" data-dias="${d}">${d} dias</button>`).join('')}</div>
        <div class="an-seg mkt-sem-icone" role="group" aria-label="Marketplace">${[['todos', 'Todos'], ['ml', 'Mercado Livre'], ['shopee', 'Shopee']].map(([k, t]) => `<button type="button" class="${st.mkt === k ? 'on' : ''}" data-mkt="${k}">${t}</button>`).join('')}</div>
        <input id="an-busca" class="form-control" placeholder="Buscar por produto, loja ou código" value="${h(st.busca)}" aria-label="Buscar">
      </div>
      ${st.carregando ? `<div class="card an-carr" role="status"><b>Lendo as contas…</b> <span class="an-sub">${h(st.progresso)} · ${st.itens.length} anúncio(s) novo(s) até agora</span><div class="an-barra"><i></i></div></div>` : ''}
      <div class="an-kpis">
        <div class="card"><b>${n0(vis.length)}</b><span>anúncios novos em ${st.dias} dias</span></div>
        <div class="card"><b>${n0(vis.filter(x => x.mkt === 'ml').length)} · ${n0(vis.filter(x => x.mkt === 'shopee').length)}</b><span class="mkt-sem-icone">Mercado Livre · Shopee</span></div>
        <div class="card"><b class="${comVenda ? 'pos' : ''}">${n0(comVenda)}</b><span>já venderam (ML)</span></div>
        <div class="card"><b class="${parados || semEst ? 'alerta' : ''}">${n0(parados)} · ${n0(semEst)}</b><span>não ativos · sem estoque</span></div>
      </div>
      ${!foco && ranking.length > 1 ? `<div class="card an-rank"><div class="an-sec">Por cliente</div>${ranking.slice(0, 12).map(([n, v]) => `<div class="an-rl"><span>${h(n)}</span><i style="--w:${Math.max(4, v / maxCli * 100)}%"></i><b>${v}</b></div>`).join('')}</div>` : ''}
      ${vis.length ? [...grupos.entries()].map(([k, xs]) => `<section class="an-dia"><div class="an-sec">${h(diaTxt(xs[0].criado))} <span class="an-sub">${xs.length} anúncio(s)</span></div><div class="an-grade">${xs.map(card).join('')}</div></section>`).join('')
        : !st.carregando ? `<div class="card an-vazio">${st.itens.length ? 'Nenhum anúncio com esse filtro.' : `Nenhum anúncio criado nos últimos ${st.dias} dias ${foco ? 'nas contas deste cliente' : 'nas contas vinculadas'}.`}</div>` : ''}
      ${st.erros.length ? `<details class="card an-erros"><summary>${st.erros.length} conta(s) não responderam</summary><ul>${st.erros.map(e => `<li>${h(e)}</li>`).join('')}</ul></details>` : ''}
      ${st.em && !st.carregando ? `<p class="an-sub">Lido em ${new Date(st.em).toLocaleString('pt-BR')} · guardado por 1 hora. Vendas da Shopee por anúncio não vêm nessa leitura.</p>` : ''}
    </div>
    <style>
      .an{display:flex;flex-direction:column;gap:14px;max-width:1240px}
      .an-cab{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
      .an-eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:700}
      .an-cab h2{margin:2px 0 0;font-size:22px;letter-spacing:-.01em} .an-cab p{margin:4px 0 0;color:var(--text-muted);font-size:13.5px;max-width:680px;line-height:1.5}
      .an-filtros{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 14px} .an-filtros input{flex:1;min-width:200px}
      .an-seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--border);border-radius:10px}
      .an-seg button{border:0;background:transparent;color:var(--text-secondary);border-radius:7px;padding:6px 12px;font:600 12.5px/1 inherit;font-family:inherit;cursor:pointer} .an-seg button.on{background:var(--accent);color:#fff} .an-seg button:focus-visible{outline:2px solid var(--accent)}
      .an-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px} .an-kpis .card{padding:14px 16px;display:flex;flex-direction:column;gap:2px}
      .an-kpis b{font-size:22px;font-variant-numeric:tabular-nums;letter-spacing:-.01em} .an-kpis span{font-size:12.5px;color:var(--text-muted)}
      .an .pos{color:var(--green)} .an .alerta{color:var(--yellow)}
      .an-sec{font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:8px} .an-sub{font-size:12px;color:var(--text-muted);font-weight:400}
      .an-rank{padding:14px 16px} .an-rl{display:grid;grid-template-columns:minmax(120px,220px) 1fr 36px;gap:10px;align-items:center;font-size:12.5px;padding:3px 0}
      .an-rl span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .an-rl i{display:block;height:8px;border-radius:4px;background:linear-gradient(90deg,var(--accent) var(--w),var(--bg-subtle) var(--w))} .an-rl b{text-align:right;font-variant-numeric:tabular-nums}
      .an-grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:10px}
      .an-card{display:flex;gap:12px;padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card);color:var(--text-primary);text-decoration:none;transition:border-color .15s}
      .an-card:hover{border-color:var(--accent)} .an-card:focus-visible{outline:2px solid var(--accent)}
      .an-card > img,.an-ph{width:76px;height:76px;flex:none;border-radius:8px;object-fit:contain;background:#fff;border:1px solid var(--border)}
      .an-corpo{min-width:0;display:flex;flex-direction:column;gap:4px}
      .an-tit{font-size:13px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .an-loja{font-size:11.5px;color:var(--text-muted);display:flex;align-items:center;gap:4px;overflow:hidden;white-space:nowrap} .an-loja span{overflow:hidden;text-overflow:ellipsis}
      .an-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px} .an-meta b{font-size:14px;font-variant-numeric:tabular-nums}
      .an-st,.an-tag{font-size:10.5px;font-weight:700;border-radius:5px;padding:1px 6px;background:var(--bg-subtle);color:var(--text-secondary)}
      .an-st.ok{background:color-mix(in srgb,var(--green) 14%,transparent);color:var(--green)} .an-st.pausa{background:color-mix(in srgb,var(--yellow) 18%,transparent);color:var(--yellow)}
      .an-num{display:flex;gap:12px;font-size:11.5px;color:var(--text-muted);font-variant-numeric:tabular-nums} .an-num b{color:var(--text-primary)}
      .an-carr{padding:14px 16px;font-size:13px} .an-barra{height:4px;border-radius:2px;background:var(--bg-subtle);overflow:hidden;margin-top:10px} .an-barra i{display:block;height:100%;width:40%;background:var(--accent);animation:anb 1.4s ease-in-out infinite} @keyframes anb{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
      .an-vazio{padding:24px;text-align:center;color:var(--text-muted);font-size:13.5px} .an-erros{padding:12px 16px;font-size:12.5px} .an-erros summary{cursor:pointer;color:var(--text-secondary);font-weight:600}
      @media (prefers-reduced-motion:reduce){.an-barra i{animation:none}}
      @media (max-width:600px){.an-grade{grid-template-columns:1fr}.an-rl{grid-template-columns:110px 1fr 30px}}
    </style>`;
    el.querySelectorAll('[data-dias]').forEach(b => b.onclick = () => { st.dias = +b.dataset.dias; gravar('glr_an_dias', st.dias); carregar(); });
    el.querySelectorAll('[data-mkt]').forEach(b => b.onclick = () => { st.mkt = b.dataset.mkt; render(); });
    const busca = el.querySelector('#an-busca');
    busca.oninput = () => { st.busca = busca.value; clearTimeout(window._anBusca); window._anBusca = setTimeout(() => { const pos = busca.selectionStart; render(); const b2 = el.querySelector('#an-busca'); b2.focus(); b2.setSelectionRange(pos, pos); }, 300); };
    el.querySelector('#an-atualizar').onclick = () => carregar(true);
  }

  const aoTrocarCliente = () => { if (Router.estaEm('anuncios-novos')) carregar(); else window.removeEventListener('glr:cliente', aoTrocarCliente); };
  window.addEventListener('glr:cliente', aoTrocarCliente);
  carregar();
});
