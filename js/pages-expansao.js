// ============================================================
// GLR Consultoria — Expansão de canais
// ------------------------------------------------------------
// Tela do Agente de Expansão de canais (api/_expansao.js, de madrugada; cada
// cliente a cada 3 dias ou "Analisar agora"): produtos que já vendem num canal
// e faltam em outro (ML, Shopee, TikTok Shop, Amazon, Magalu), com a venda
// estimada no canal novo e a comissão GLR que ela traria (modelo de comissão do
// cliente, GLR.comissao). "Preparar anúncio" lê o anúncio de origem (fotos,
// título, descrição, preço, SKU, medidas) e abre a Central de Anúncios do canal
// já preenchida — o analista confere e publica; nada é publicado daqui.
// "Já existe" tira o produto da lista (glr_expansao_ignorar, sincronizado).
// ============================================================
Router.register('expansao', (params, el) => {
  const R$ = v => 'R$ ' + (Math.round(parseFloat(v) || 0)).toLocaleString('pt-BR');
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const num = v => (Math.round((parseFloat(v) || 0) * 10) / 10).toLocaleString('pt-BR');
  const NOME = { ml: 'Mercado Livre', shopee: 'Shopee', tiktok: 'TikTok Shop', amazon: 'Amazon', magalu: 'Magalu' };
  const COR = { ml: '#d9a400', shopee: '#eb6834', tiktok: '#7a7a85', amazon: '#ff9900', magalu: '#0086ff' };
  const COM_CRIADOR = new Set(['ml', 'shopee', 'tiktok']); // canais com Central de Anúncios pronta
  const K_IGN = 'glr_expansao_ignorar';
  const st = { lista: [], carregando: true, erro: null, aberto: null, ops: {}, filtro: 'todos', proc: {}, analisando: null, preparando: null };
  window._exSt = st;

  const cliente = id => (GLR.clientes || []).find(c => String(c.id) === String(id));
  const chaveIgn = (cid, o) => `${cid}|${o.alvo}|${String(o.nome).toLowerCase().slice(0, 80)}`;
  const ignorados = () => lerJSON(K_IGN, {});
  // comissão a mais por mês: modelo do cliente com as vendas de hoje + as do canal novo
  function comissaoExtra(cid, base, unid, receita) {
    const c = cliente(cid); if (!c || !GLR.comissao?.temComissao(c)) return 0;
    const b = base?.unid30 || 0, f = base?.receita30 || 0;
    return Math.max(0, GLR.comissao.estimar(c, b + unid, f + receita) - GLR.comissao.estimar(c, b, f));
  }

  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('conta_id,em:cursor->>em,cli:cursor->cliente,canais:cursor->canais,base:cursor->base,resumo:cursor->resumo,erros:cursor->erros')
        .eq('marketplace', 'sistema').eq('recurso', 'expansao');
      if (error) throw error;
      st.lista = (data || []).filter(r => r.cli).map(r => ({ id: String(r.cli.id), nome: r.cli.nome, em: r.em, canais: r.canais || {}, base: r.base || {}, resumo: r.resumo || { porAlvo: {} }, erros: r.erros || [] }));
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
    GLR.quandoClientes(render);
  }
  async function carregarOps(cid) {
    st.ops[cid] = { carregando: true }; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('ops:cursor->oportunidades').eq('marketplace', 'sistema').eq('recurso', 'expansao').eq('conta_id', `cliente:${cid}`).maybeSingle();
      if (error) throw error;
      st.ops[cid] = { itens: data?.ops || [] };
    } catch (e) { st.ops[cid] = { erro: e.message || String(e) }; }
    render();
  }

  // estimativa por cliente (comissão a mais/mês) — com o filtro de canal, só aquele canal
  function linhaCliente(c) {
    const alvos = st.filtro === 'todos' ? Object.keys(c.resumo.porAlvo || {}) : [st.filtro];
    const unid = alvos.reduce((s, a) => s + (c.resumo.porAlvo?.[a]?.unid_est || 0), 0);
    const receita = alvos.reduce((s, a) => s + (c.resumo.porAlvo?.[a]?.receita_est || 0), 0);
    const n = alvos.reduce((s, a) => s + (c.resumo.porAlvo?.[a]?.n || 0), 0);
    return { ...c, unid, receita, n, com: comissaoExtra(c.id, c.base, unid, receita) };
  }

  function render() {
    if (window._exSt !== st) return;
    const root = document.getElementById('ex-root'); if (!root) return;
    if (st.carregando && !st.lista.length) { root.innerHTML = '<div class="card ex-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card ex-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    const foco = GLR.ctx?.cliente();
    const linhas = st.lista.filter(c => !foco || c.id === String(foco)).map(linhaCliente).filter(c => c.n).sort((a, b) => b.com - a.com || b.receita - a.receita);
    const tot = linhas.reduce((t, c) => ({ com: t.com + c.com, receita: t.receita + c.receita, n: t.n + c.n }), { com: 0, receita: 0, n: 0 });
    const semConta = m => st.lista.filter(c => !c.canais?.[m]?.conta).length;
    const chips = [['todos', 'Todos os canais'], ...Object.keys(NOME).map(m => [m, NOME[m]])];
    const focoSemAnalise = foco && !st.lista.some(c => c.id === String(foco));
    root.innerHTML = `
      <div class="ex-topo">
        <div class="ex-num"><b>${R$(tot.com)}</b><span>de comissão a mais por mês (estimativa)</span></div>
        <div class="ex-num"><b>${R$(tot.receita)}</b><span>de venda nova por mês nos clientes</span></div>
        <div class="ex-num"><b>${tot.n}</b><span>produto(s) para levar a outro canal</span></div>
        <span style="flex:1"></span>
        <button class="btn btn-secondary btn-sm" onclick="window._exRecarregar()" title="Buscar de novo">↻</button>
      </div>
      <div class="ex-chips">${chips.map(([k, t]) => `<button class="ex-chip ${st.filtro === k ? 'on' : ''}" onclick="window._exFiltro('${k}')">${h(t)}${k !== 'todos' ? ` <small>${semConta(k)} sem conta</small>` : ''}</button>`).join('')}</div>
      ${linhas.length ? `<div class="ex-lista">${linhas.map(cardCliente).join('')}</div>`
        : `<div class="card ex-vazio"><b>${st.lista.length && !focoSemAnalise ? 'Nenhum produto para levar a outro canal' + (st.filtro !== 'todos' ? ` em ${NOME[st.filtro]}` : '') : focoSemAnalise ? 'O agente ainda não analisou este cliente.' : 'O agente ainda não analisou os clientes.'}</b>
          <span>${st.lista.length && !focoSemAnalise ? '' : 'Ele roda de madrugada (cada cliente a cada 3 dias). Para ver agora, coloque um cliente em foco e use "Analisar agora".'}</span>
          ${focoSemAnalise ? `<button class="btn btn-primary btn-sm" style="margin-top:10px" ${st.analisando ? 'disabled' : ''} onclick="window._exAnalisar('${h(foco)}')">${st.analisando ? 'Analisando… (até 3 min)' : 'Analisar agora'}</button>` : ''}</div>`}`;
  }

  function cardCliente(c) {
    const aberto = st.aberto === c.id, ops = st.ops[c.id];
    const canais = Object.keys(NOME).map(m => { const x = c.canais?.[m] || {}; return `<span class="ex-canal ${x.conta ? 'tem' : 'falta'}" style="--c:${COR[m]}" title="${x.conta ? `conta conectada · ${x.unid30 || 0} un. em 30 dias` : 'sem conta'}">${x.conta ? '✓' : '+'} ${NOME[m]}</span>`; }).join('');
    const em = c.em ? new Date(c.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    return `<div class="card ex-c ${aberto ? 'aberto' : ''}">
      <button type="button" class="ex-c-cab" aria-expanded="${aberto}" onclick="window._exAbrir('${h(c.id)}')">
        <span class="ex-seta">▸</span>
        <span class="ex-c-nome">${h(cliente(c.id)?.nome || c.nome)}</span>
        <span class="ex-canais">${canais}</span>
        <span class="ex-c-res"><span><b>${c.n}</b> produto(s)</span><span><b>${R$(c.receita)}</b>/mês de venda</span><span class="ex-com"><b>${R$(c.com)}</b>/mês de comissão</span></span>
      </button>
      ${aberto ? `<div class="ex-det">
        <div class="ex-det-cab"><span class="ex-sub">Analisado em ${em} · ${num(c.base?.unid30)} un. vendidas em 30 dias em ${c.base?.produtos || 0} produto(s)${c.erros?.length ? ` · ${c.erros.length} conta(s) com leitura incompleta` : ''}</span><span style="flex:1"></span>
          <button class="btn btn-secondary btn-sm" ${st.analisando ? 'disabled' : ''} onclick="window._exAnalisar('${h(c.id)}')">${st.analisando === c.id ? 'Analisando… (até 3 min)' : 'Analisar agora'}</button></div>
        ${!ops || ops.carregando ? '<div class="ex-sub" style="padding:14px 16px">Carregando produtos…</div>' : ops.erro ? `<div class="ex-sub" style="padding:14px 16px;color:var(--red)">${h(ops.erro)}</div>` : gruposCanal(c, ops.itens)}
      </div>` : ''}
    </div>`;
  }

  function gruposCanal(c, itens) {
    const ign = ignorados();
    const vis = itens.filter(o => !ign[chaveIgn(c.id, o)] && (st.filtro === 'todos' || o.alvo === st.filtro));
    if (!vis.length) return '<div class="ex-sub" style="padding:14px 16px">Nada a levar para outro canal neste filtro.</div>';
    const porAlvo = {}; vis.forEach(o => (porAlvo[o.alvo] = porAlvo[o.alvo] || []).push(o));
    const soma = os => os.reduce((s, o) => s + o.receita_est, 0);
    return Object.entries(porAlvo).sort((a, b) => soma(b[1]) - soma(a[1])).map(([m, os]) => {
      const conta = c.canais?.[m]?.conta, receita = soma(os), unid = os.reduce((s, o) => s + o.unid_est, 0);
      return `<div class="ex-g" style="--c:${COR[m]}">
        <div class="ex-g-cab"><b>${NOME[m]}</b>
          <span class="ex-sub">${conta ? 'conta conectada' : '<b style="color:var(--text-primary)">sem conta</b> — o primeiro passo é o cliente abrir a loja'} · ${os.length} produto(s) · ~${num(unid)} un./mês · ${R$(receita)}/mês · <b style="color:var(--green)">${R$(comissaoExtra(c.id, c.base, unid, receita))}</b>/mês de comissão</span></div>
        <div style="overflow-x:auto"><table class="ex-tab" data-todas-colunas>
          <thead><tr><th>Produto</th><th>Vende hoje</th><th class="n">Estimativa em ${NOME[m]}</th><th class="n">Comissão/mês</th><th></th></tr></thead>
          <tbody>${os.slice(0, 40).map(o => linhaOp(c, o, conta)).join('')}</tbody>
        </table></div>
        ${os.length > 40 ? `<div class="ex-sub" style="padding:8px 16px">e mais ${os.length - 40} produto(s) com venda menor</div>` : ''}
      </div>`;
    }).join('');
  }

  function linhaOp(c, o, conta) {
    const k = chaveIgn(c.id, o), proc = st.proc[k];
    const vende = Object.entries(o.canais || {}).map(([m, x]) => `<span class="ex-v" style="--c:${COR[m] || 'var(--text-muted)'}">${NOME[m] || m} ${x.unid} un.</span>`).join('');
    const pode = conta && COM_CRIADOR.has(o.alvo) && ['ml', 'shopee'].includes(o.fonte?.mkt);
    return `<tr>
      <td class="ex-prod"><b>${h(o.nome)}</b>${o.confere ? '<small>a integração não lê o catálogo deste canal: confira se já existe</small>' : ''}</td>
      <td><div class="ex-vs">${vende}</div><small class="ex-sub">${R$(o.receita30)} em 30 dias</small></td>
      <td class="n">~${num(o.unid_est)} un. · ${R$(o.receita_est)}<small>${Math.round(o.fator * 100)}% das vendas de hoje</small></td>
      <td class="n" style="font-weight:650">${R$(comissaoExtra(c.id, c.base, o.unid_est, o.receita_est))}</td>
      <td class="n"><div class="ex-bts">${proc ? `<span class="ex-sub">${h(proc)}</span>` : `
        ${pode ? `<button class="btn btn-primary btn-sm" ${st.preparando ? 'disabled' : ''} onclick="window._exPreparar('${h(c.id)}', '${h(encodeURIComponent(k))}')">Preparar anúncio</button>`
          : conta && !COM_CRIADOR.has(o.alvo) ? `<span class="ex-sub" title="A Central de Anúncios deste canal ainda não está pronta">criar no painel ${o.alvo === 'amazon' ? 'da Amazon' : 'do Magalu'}</span>` : ''}
        <button class="btn btn-ghost btn-sm" title="Já existe neste canal ou não serve" onclick="window._exIgnorar('${h(c.id)}', '${h(encodeURIComponent(k))}')">Já existe</button>`}</div></td>
    </tr>`;
  }

  // ── Rascunho: lê o anúncio de origem e abre a Central de Anúncios do canal ──
  const corpo = r => r?.data?.body || r?.body || r?.data || r;
  async function paraDataURL(url) {
    try {
      const b = await (await fetch(url)).blob();
      if (!b.type.startsWith('image/')) return null;
      return await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result)); fr.onerror = () => ok(null); fr.readAsDataURL(b); });
    } catch (e) { return null; }
  }
  async function rascunhoDe(o) {
    const f = o.fonte, r = { titulo: o.nome, descricao: '', preco: f.preco || '', estoque: '', sku: f.sku || '', peso: '', compr: '', larg: '', alt: '' };
    let fotos = [];
    if (f.mkt === 'ml') {
      const [it, ds] = await Promise.all([MarketplaceAPI.call('get_item', { meliUserId: f.conta, item_id: f.item_id }), MarketplaceAPI.call('get_description', { meliUserId: f.conta, item_id: f.item_id }).catch(() => null)]);
      const b = corpo(it) || {}, d = corpo(ds) || {};
      Object.assign(r, { titulo: b.title || r.titulo, descricao: d.plain_text || d.text || '', preco: b.price ?? r.preco, estoque: b.available_quantity ?? '',
        sku: b.seller_custom_field || (b.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || r.sku });
      const dim = String(b.shipping?.dimensions || '').match(/^(\d+)x(\d+)x(\d+),(\d+)/); // "CxLxA,gramas"
      if (dim) Object.assign(r, { compr: dim[1], larg: dim[2], alt: dim[3], peso: String(Math.round(+dim[4] / 10) / 100) });
      else { // anúncio novo do ML: embalagem nos atributos SELLER_PACKAGE_* ("115 cm", "36400 g")
        const at = id => { const m = String((b.attributes || []).find(a => a.id === id)?.value_name || '').replace(',', '.').match(/([\d.]+)\s*(mm|cm|m|g|kg)?/i); if (!m) return ''; const v = +m[1], u = (m[2] || '').toLowerCase(); return String(u === 'mm' ? v / 10 : u === 'm' ? v * 100 : u === 'g' ? Math.round(v / 10) / 100 : v); };
        Object.assign(r, { compr: at('SELLER_PACKAGE_LENGTH'), larg: at('SELLER_PACKAGE_WIDTH'), alt: at('SELLER_PACKAGE_HEIGHT'), peso: at('SELLER_PACKAGE_WEIGHT') });
      }
      fotos = (b.pictures || []).map(p => p.secure_url || p.url);
    } else if (f.mkt === 'shopee') {
      const x = await MarketplaceAPI.call('shopee_get_items_batch', { shopId: f.conta, item_id_list: [Number(f.item_id)] });
      const b = ((x?.data?.response || x?.response || x?.data?.data?.response)?.item_list || [])[0] || {};
      Object.assign(r, { titulo: b.item_name || r.titulo, descricao: b.description || '', preco: b.price_min ?? b.price_info?.[0]?.current_price ?? r.preco, estoque: b.total_stock ?? '',
        sku: b.item_sku || r.sku, peso: b.weight || '', compr: b.dimension?.package_length || '', larg: b.dimension?.package_width || '', alt: b.dimension?.package_height || '' });
      fotos = b.image?.image_url_list || [];
    }
    r.fotos = (await Promise.all(fotos.slice(0, 8).map(paraDataURL))).filter(Boolean);
    return r;
  }

  const achar = (cid, kEnc) => { const k = decodeURIComponent(kEnc); return { k, o: (st.ops[cid]?.itens || []).find(o => chaveIgn(cid, o) === k) }; };
  window._exRecarregar = () => { st.ops = {}; carregar().then(() => { if (st.aberto) carregarOps(st.aberto); }); };
  window._exFiltro = k => { st.filtro = k; render(); };
  window._exAbrir = id => { st.aberto = st.aberto === id ? null : id; render(); if (st.aberto && !st.ops[id]) carregarOps(id); };
  window._exIgnorar = (cid, kEnc) => { const { k } = achar(cid, kEnc); const m = ignorados(); m[k] = Date.now(); localStorage.setItem(K_IGN, JSON.stringify(m)); render(); };
  window._exAnalisar = async cid => {
    if (st.analisando) return;
    st.analisando = String(cid); render();
    try {
      const r = await window.glrApiFetch(`/api/agente-cron?rodada=expansao&cliente_id=${encodeURIComponent(cid)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      const a = j.analisados?.[0]; if (a?.erro) throw new Error(a.erro);
      delete st.ops[cid]; await carregar(); st.aberto = String(cid); carregarOps(cid);
    } catch (e) { alert('Não consegui analisar: ' + (e.message || e)); }
    st.analisando = null; render();
  };
  window._exPreparar = async (cid, kEnc) => {
    const { k, o } = achar(cid, kEnc); if (!o || st.preparando) return;
    const c = st.lista.find(x => x.id === String(cid));
    st.preparando = k; st.proc[k] = 'Lendo o anúncio de origem…'; render();
    try {
      const r = await rascunhoDe(o);
      if (!r.fotos.length) throw new Error('não consegui copiar as fotos do anúncio de origem');
      window._glrRascunhoAnuncio = { alvo: o.alvo, conta: c?.canais?.[o.alvo]?.contas?.[0] || '', origem: `${NOME[o.fonte.mkt]} · ${o.fonte.item_id} (${GLR.nomeConta(o.fonte.mkt, o.fonte.conta)})`, ...r };
      delete st.proc[k]; st.preparando = null;
      Router.navigate(`anuncios-${o.alvo}`);
      return;
    } catch (e) { alert('Não consegui preparar o anúncio: ' + (e.message || e)); }
    delete st.proc[k]; st.preparando = null; render();
  };

  el.innerHTML = `<div class="page">
    <div class="ajuda">Produtos que já vendem num canal e faltam em outro, por cliente. A estimativa usa a venda dos últimos 30 dias e a proporção que o cliente já tem no canal (sem conta, uma fração conservadora); a comissão segue o modelo de cada cliente. "Preparar anúncio" abre a Central de Anúncios já preenchida com o anúncio de origem — você confere e publica.</div>
    <div id="ex-root"></div>
  </div>
  <style>
    .ex-sub{font-size:12px;color:var(--text-muted);line-height:1.45}
    .ex-vazio{padding:28px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:4px} .ex-vazio span{font-size:13px;color:var(--text-muted)}
    .ex-topo{display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:12px}
    .ex-num{display:flex;flex-direction:column} .ex-num b{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1} .ex-num span{font-size:12px;color:var(--text-muted)}
    .ex-num:first-child b{color:var(--green)}
    .ex-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
    .ex-chip{border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
    .ex-chip small{color:var(--text-muted);margin-left:2px} .ex-chip.on{border-color:var(--accent);background:var(--accent-glow);color:var(--accent-light)}
    .ex-lista{display:flex;flex-direction:column;gap:10px}
    .ex-c{padding:0;overflow:hidden}
    .ex-c-cab{display:flex;align-items:center;gap:12px;flex-wrap:wrap;width:100%;padding:13px 16px;border:0;background:none;cursor:pointer;text-align:left;font-family:inherit;color:var(--text-primary)}
    .ex-c-cab:hover{background:var(--bg-subtle)} .ex-c-cab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
    .ex-seta{color:var(--text-muted);transition:transform .15s;display:inline-block} .ex-c.aberto .ex-seta{transform:rotate(90deg)}
    .ex-c-nome{font-size:14.5px;font-weight:650;min-width:120px}
    .ex-canais{display:flex;gap:5px;flex-wrap:wrap}
    .ex-canal{font-size:11px;font-weight:600;border-radius:99px;padding:2px 8px;white-space:nowrap}
    .ex-canal.tem{color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent)} .ex-canal.falta{color:var(--text-muted);border:1px dashed var(--border)}
    .ex-c-res{margin-left:auto;display:flex;gap:14px;font-size:12.5px;color:var(--text-muted);white-space:nowrap;flex-wrap:wrap} .ex-c-res b{color:var(--text-primary);font-variant-numeric:tabular-nums} .ex-com b{color:var(--green) !important}
    .ex-det{border-top:1px solid var(--border)}
    .ex-det-cab{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 16px;background:var(--bg-subtle)}
    .ex-g{border-top:1px solid var(--border);border-left:3px solid var(--c)}
    .ex-g-cab{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:11px 16px 6px} .ex-g-cab > b{font-size:13.5px}
    .ex-tab{width:100%;border-collapse:collapse;font-size:13px}
    .ex-tab th{padding:7px 12px;text-align:left;font-size:11.5px;font-weight:600;color:var(--text-muted);white-space:nowrap}
    .ex-tab td{padding:9px 12px;border-top:1px solid var(--border);vertical-align:top}
    .ex-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums} .ex-tab td small{display:block;font-size:11.5px;color:var(--text-muted);font-weight:400}
    .ex-prod{min-width:220px;max-width:420px} .ex-prod b{font-weight:600;line-height:1.4}
    .ex-vs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:2px} .ex-v{font-size:11px;font-weight:600;color:var(--c);background:color-mix(in srgb,var(--c) 10%,transparent);border-radius:6px;padding:1px 6px;white-space:nowrap}
    .ex-bts{display:flex;gap:6px;justify-content:flex-end;align-items:center}
    @media (max-width:760px){.ex-c-res{margin-left:0}}
  </style>`;
  carregar();
});
