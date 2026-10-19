// ============================================================
// GLR Consultoria — Monitor de preços do Mercado Livre
// ------------------------------------------------------------
// Por conta: quais anúncios mudaram de preço, de quanto para quanto, quando, e o
// que isso fez com a MARGEM (antes × agora) e com as VENDAS (por dia, antes ×
// depois da mudança).
// De onde vêm as mudanças:
//  • fotos de preço que o servidor tira a cada 4 h (glr_sync_estado, recurso
//    'precos' — api/sync-dados.js atualizarPrecosML), com o histórico de cada anúncio;
//  • antes da primeira foto (e para mudanças mais antigas), o preço das vendas
//    (glr_pedidos dos últimos 60 dias): dia em que o preço vendido mudou ≥ 2%;
//  • "Ver preços agora": confere os preços atuais no ML na hora.
// Margem = mesma conta da aba Promoções/Vendas: preço − tarifa do ML naquele
// preço (ml_listing_fees) − frete exato do vendedor (shipping_options/free) −
// custo (catálogo de Vendas) − imposto da conta − despesas extras − ADS %.
// ============================================================
Router.register('precos-ml', (params, el) => {
  const R$ = v => v == null || isNaN(v) ? '—' : 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v, c = 1) => v == null || !isFinite(v) ? '—' : (+v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }) + '%';
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch (e) { return d; } };
  const num = v => { const x = parseFloat(String(v ?? '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isNaN(x) ? null : x; };
  const DIA = 86400000;
  const isoBRT = ts => new Date(ts - 3 * 3600e3).toISOString().slice(0, 10);
  const dataBR = ts => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  const POR_PAGINA = 25;

  const st = {
    contas: [], conta: lerJSON('glr_pml_conta', '') || '', periodo: lerJSON('glr_pml_periodo', 30) || 30, filtro: 'todos', busca: '', pagina: 0,
    cur: null, curEm: null, vendas: {}, agora: {}, info: {}, calc: {}, carregando: false, verificando: false, progresso: '', erro: null,
  };

  // ── API com retentativa ──
  async function tentar(fn, n = 3) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n - 1) throw e; await new Promise(r => setTimeout(r, 800 * (i + 1))); } } }
  const D = r => (r && r.data && typeof r.data === 'object' && r.status != null) ? r.data : r;
  const call = (a, p) => tentar(() => MarketplaceAPI.call(a, { meliUserId: st.conta, ...p })).then(D);

  // ── Carga: fotos de preço (servidor) + vendas dos últimos 60 dias ──
  async function carregar() {
    if (!st.conta) return;
    st.carregando = true; st.erro = null; st.cur = null; st.vendas = {}; st.agora = {}; st.calc = {}; st.pagina = 0; render();
    try {
      const { data: est } = await _sb.from('glr_sync_estado').select('cursor,ultimo_sucesso').eq('marketplace', 'ml').eq('conta_id', st.conta).eq('recurso', 'precos').maybeSingle();
      st.cur = est?.cursor?.itens || null; st.curEm = est?.cursor?.em || null;
      const desde = new Date(Date.now() - 60 * DIA).toISOString();
      for (let off = 0; off < 100000; off += 1000) {
        const { data, error } = await _sb.from('glr_pedidos').select('criado_em,itens').eq('marketplace', 'ml').eq('conta_id', st.conta)
          .eq('situacao', 'valido').gte('criado_em', desde).order('criado_em').order('pedido_id').range(off, off + 999);
        if (error) throw error;
        for (const p of (data || [])) {
          const dia = isoBRT(Date.parse(p.criado_em));
          for (const it of (p.itens || [])) {
            if (!it.item_id) continue;
            const v = st.vendas[it.item_id] = st.vendas[it.item_id] || { nome: it.nome, dias: {} };
            const d = v.dias[dia] = v.dias[dia] || { un: 0, rs: 0 };
            const q = parseInt(it.qtd) || 1; d.un += q; d.rs += (parseFloat(it.preco) || 0) * q;
          }
        }
        if (!data || data.length < 1000) break;
      }
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  // ── Mudanças de preço ──
  // 1) histórico das fotos; 2) preço das vendas (para antes da 1ª foto); 3) "agora"
  function mudancaPelasVendas(id) {
    const v = st.vendas[id]; if (!v) return null;
    const dias = Object.keys(v.dias).sort().map(d => ({ d, p: v.dias[d].rs / v.dias[d].un }));
    for (let i = dias.length - 1; i > 0; i--) {
      const a = dias[i - 1].p, b = dias[i].p;
      if (a > 0 && Math.abs(b - a) / a >= 0.02 && (i === dias.length - 1 || Math.abs(dias[i + 1].p - b) / b < 0.01)) {
        return { antes: Math.round(a * 100) / 100, agora: Math.round(b * 100) / 100, quando: new Date(`${dias[i].d}T12:00:00-03:00`).getTime(), fonte: 'vendas' };
      }
    }
    return null;
  }
  function mudancas() {
    const out = [], vistos = new Set();
    const primeiraFoto = id => st.cur?.[id]?.h?.[0]?.[0] ? st.cur[id].h[0][0] * 1000 : null;
    for (const [id, it] of Object.entries(st.cur || {})) {
      const hs = it.h || [];
      const ag = st.agora[id];
      if (ag != null && hs.length && Math.abs(ag - hs[hs.length - 1][1]) >= 0.01) {
        out.push({ id, antes: hs[hs.length - 1][1], agora: ag, quando: Date.now(), fonte: 'agora' }); vistos.add(id); continue;
      }
      if (hs.length >= 2) { const a = hs[hs.length - 2], b = hs[hs.length - 1]; out.push({ id, antes: a[1], agora: b[1], quando: b[0] * 1000, fonte: 'anúncio' }); vistos.add(id); }
    }
    for (const id of Object.keys(st.vendas)) {
      if (vistos.has(id)) continue;
      const m = mudancaPelasVendas(id);
      const pf = primeiraFoto(id);
      if (m && (!pf || m.quando < pf)) out.push({ id, ...m });
    }
    for (const [id, ag] of Object.entries(st.agora)) {
      if (vistos.has(id) || st.cur?.[id]) continue;
      const m = out.find(x => x.id === id);
      if (m && Math.abs(m.agora - ag) >= 0.01) { m.antes = m.agora; m.agora = ag; m.quando = Date.now(); m.fonte = 'agora'; }
    }
    const desde = Date.now() - st.periodo * DIA;
    return out.filter(m => m.quando >= desde).sort((a, b) => b.quando - a.quando);
  }

  // ── Dados do anúncio (categoria, tipo, frete, foto) ──
  function infoDe(id) {
    const c = st.cur?.[id];
    if (c) return { id, titulo: c.t, cat: c.c, tipo: c.l, me: !!c.me, foto: c.th };
    return st.info[id] || null;
  }
  async function buscarInfo(ids) {
    const falta = ids.filter(id => !infoDe(id));
    for (let i = 0; i < falta.length; i += 20) {
      try {
        const r = await call('get_items', { ids: falta.slice(i, i + 20) });
        const arr = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : (r?.results || []));
        for (const e of arr) { const b = e?.body || e; if (b?.id) st.info[b.id] = { id: b.id, titulo: b.title, cat: b.category_id, tipo: b.listing_type_id, me: b.shipping?.mode === 'me2', foto: String(b.thumbnail || '').replace(/^http:/, 'https:') }; }
      } catch (e) { /* segue sem */ }
    }
  }

  // ── Margem num preço (mesma conta de Promoções/Vendas) ──
  const taxaCache = {}, freteCache = {};
  async function taxa(it, preco) {
    const k = `${it.cat}|${it.tipo}|${preco < 79 ? preco.toFixed(2) : 'pct'}`;
    if (!taxaCache[k]) {
      const d = await call('ml_listing_fees', { price: preco, category_id: it.cat, listing_type_id: it.tipo });
      taxaCache[k] = { pct: parseFloat(d?.sale_fee_details?.percentage_fee) || 0, fixo: parseFloat(d?.sale_fee_details?.fixed_fee) || 0 };
    }
    return taxaCache[k];
  }
  async function frete(it, preco) {
    if (!it.me) return 0;
    const k = `${it.id}|${preco.toFixed(2)}`;
    if (freteCache[k] == null) {
      const d = await call('raw', { method: 'GET', path: `/users/${st.conta}/shipping_options/free?item_id=${it.id}&item_price=${preco.toFixed(2)}` });
      const v = parseFloat(d?.coverage?.all_country?.list_cost);
      freteCache[k] = isNaN(v) ? 0 : v;
    }
    return freteCache[k];
  }
  function despesas() {
    const aliq = parseFloat(lerJSON('glr_aliquotas', {})[st.conta]) || 0;
    let extraPct = 0, extraFixo = 0;
    for (const l of lerJSON('glr_vendas_linhas', [])) { if (l.tipo === 'pct') extraPct += parseFloat(l.valor) || 0; else extraFixo += parseFloat(l.valor) || 0; }
    const ads = parseFloat(lerJSON('glr_promo_ads_pct', {})[st.conta]) || 0;
    return { aliq, extraPct, extraFixo, ads };
  }
  const custoDe = id => { const v = parseFloat(lerJSON('glr_vendas_custo_catalogo', {})[id]); return v > 0 ? v : null; };
  async function margem(it, preco) {
    const [tx, fr] = await Promise.all([taxa(it, preco), frete(it, preco)]);
    const tarifa = preco * tx.pct / 100 + tx.fixo, d = despesas(), custo = custoDe(it.id);
    if (custo == null) return { tarifa, frete: fr, lucro: null, margem: null };
    const lucro = preco - tarifa - fr - custo - preco * (d.aliq + d.extraPct + d.ads) / 100 - d.extraFixo;
    return { tarifa, frete: fr, lucro, margem: lucro / preco * 100 };
  }
  let calculando = false;
  async function calcularVisiveis(lista) {
    if (calculando) return;
    const fila = lista.filter(m => !st.calc[m.id + '|' + m.antes + '|' + m.agora]);
    if (!fila.length) return;
    calculando = true;
    await buscarInfo(fila.map(m => m.id));
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (fila.length) {
        const m = fila.shift(), it = infoDe(m.id), k = m.id + '|' + m.antes + '|' + m.agora;
        if (!it?.cat) { st.calc[k] = { erro: 'sem dados do anúncio' }; continue; }
        try { const [a, b] = await Promise.all([margem(it, m.antes), margem(it, m.agora)]); st.calc[k] = { a, b }; }
        catch (e) { st.calc[k] = { erro: e.message }; }
        render();
      }
    }));
    calculando = false; render();
  }

  // ── Vendas por dia antes × depois da mudança ──
  function vendasAntesDepois(m) {
    const v = st.vendas[m.id]; if (!v) return null;
    const diaMud = isoBRT(m.quando), hoje = isoBRT(Date.now());
    const diasDepois = Math.max(1, Math.min(14, Math.round((Date.now() - m.quando) / DIA)));
    let antes = 0, depois = 0;
    for (const [d, x] of Object.entries(v.dias)) {
      const dt = new Date(`${d}T12:00:00-03:00`).getTime();
      if (d >= diaMud && d <= hoje && dt < m.quando + 15 * DIA) depois += x.un;
      else if (d < diaMud && dt >= m.quando - diasDepois * DIA - DIA) antes += x.un;
    }
    return { antes: antes / diasDepois, depois: depois / diasDepois, dias: diasDepois };
  }

  // ── Ver preços agora (sem esperar a próxima foto) ──
  async function verAgora() {
    st.verificando = true; st.progresso = 'conferindo preços no ML…'; render();
    try {
      const guardar = r => { (r?.results || []).forEach(e => { const b = e?.body || e; if (b?.id && b.price != null) st.agora[b.id] = Math.round(b.price * 100) / 100; }); };
      const p1 = await call('list_items', { status: 'active', limit: 100, offset: 0 }); guardar(p1);
      const total = parseInt(p1?.paging?.total) || 0;
      if (total <= 1050) for (let off = 100; off < total; off += 100) { guardar(await call('list_items', { status: 'active', limit: 100, offset: off })); st.progresso = `conferindo ${off}/${total}…`; render(); }
      else { let d = await call('list_items', { status: 'active', limit: 100, search_type: 'scan' }); guardar(d); for (let i = 0; i < 200 && d?.scroll_id && (d.results || []).length; i++) { d = await call('list_items', { status: 'active', limit: 100, scroll_id: d.scroll_id }); guardar(d); } }
    } catch (e) { st.erro = 'Não consegui conferir os preços agora: ' + e.message; }
    st.verificando = false; st.progresso = ''; render();
  }

  // ── Tela ──
  function render() {
    const root = document.getElementById('pml-root'); if (!root) return;
    if (!st.contas.length) { root.innerHTML = `<div class="card pml-vazio">${st.erro ? '⚠️ ' + h(st.erro) : '⏳ Carregando contas do Mercado Livre…'}</div>`; return; }
    const todas = mudancas();
    const q = st.busca.toLowerCase();
    const com = todas.map(m => ({ m, c: st.calc[m.id + '|' + m.antes + '|' + m.agora] }));
    const dM = x => x.c?.a?.margem != null && x.c?.b?.margem != null ? x.c.b.margem - x.c.a.margem : null;
    const F = { todos: () => true, subiu: x => dM(x) > 0.05, caiu: x => dM(x) < -0.05, semcusto: x => x.c && !x.c.erro && x.c.b?.margem == null };
    const lista = com.filter(F[st.filtro] || F.todos).filter(x => { if (!q) return true; const it = infoDe(x.m.id); return `${x.m.id} ${it?.titulo || st.vendas[x.m.id]?.nome || ''}`.toLowerCase().includes(q); });
    const pags = Math.max(1, Math.ceil(lista.length / POR_PAGINA)); st.pagina = Math.min(st.pagina, pags - 1);
    const pagina = lista.slice(st.pagina * POR_PAGINA, (st.pagina + 1) * POR_PAGINA);
    setTimeout(() => calcularVisiveis(pagina.map(x => x.m)), 0);
    const n = k => com.filter(F[k]).length;
    const chip = (k, t) => `<button class="pml-chip ${st.filtro === k ? 'on' : ''}" onclick="window._pmlFiltro('${k}')">${t} <b>${k === 'todos' ? com.length : n(k)}</b></button>`;
    const fotoTxt = st.curEm ? `foto de preços às ${new Date(st.curEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} (a cada 4 h)` : 'primeira foto de preços em até 4 h — por enquanto as mudanças vêm do preço das vendas';
    const varTxt = (a, b) => { const v = a > 0 ? (b - a) / a * 100 : 0; return `<span class="${v >= 0 ? 'pml-up' : 'pml-down'}">${v >= 0 ? '▲' : '▼'} ${pct(Math.abs(v))}</span>`; };
    const linha = ({ m, c }) => {
      const it = infoDe(m.id) || { titulo: st.vendas[m.id]?.nome || m.id };
      const va = vendasAntesDepois(m);
      const dm = c?.a?.margem != null && c?.b?.margem != null ? c.b.margem - c.a.margem : null;
      const custo = custoDe(m.id);
      const margemCel = !c ? '<span class="pml-mut">calculando…</span>'
        : c.erro ? `<span class="pml-mut" title="${h(c.erro)}">não calculou</span>`
        : c.b.margem == null ? `<input class="pml-in vazio" inputmode="decimal" placeholder="custo" onchange="window._pmlCusto('${m.id}', this.value)"> <span class="pml-mut">sem custo</span>`
        : `${pct(c.a.margem)} → <b>${pct(c.b.margem)}</b> <span class="${dm >= 0 ? 'pml-up' : 'pml-down'}">${dm >= 0 ? '▲' : '▼'} ${pct(Math.abs(dm))} p.p.</span>`;
      return `<tr>
        <td><div class="pml-prod">${it.foto ? `<img src="${h(it.foto)}" alt="" loading="lazy">` : '<span class="pml-img"></span>'}<div style="min-width:0">
          <div class="pml-tit" title="${h(it.titulo)}">${h(it.titulo)}</div>
          <div class="pml-mut"><a href="https://produto.mercadolivre.com.br/${h(String(m.id).replace(/^MLB(?=\d)/, 'MLB-'))}" target="_blank" rel="noopener">${h(m.id)}</a>${custo ? ` · custo ${R$(custo)}` : ''}</div></div></div></td>
        <td class="n">${R$(m.antes)} → <b>${R$(m.agora)}</b><div>${varTxt(m.antes, m.agora)}</div></td>
        <td class="n">${m.fonte === 'agora' ? 'agora' : dataBR(m.quando)}<div class="pml-mut">${m.fonte === 'vendas' ? 'pelas vendas' : m.fonte === 'agora' ? 'conferido agora' : 'no anúncio'}</div></td>
        <td class="n">${margemCel}</td>
        <td class="n">${c?.b?.lucro != null ? `${R$(c.a.lucro)} → <b>${R$(c.b.lucro)}</b>` : '—'}</td>
        <td class="n">${va ? `${va.antes.toFixed(1).replace('.', ',')} → <b>${va.depois.toFixed(1).replace('.', ',')}</b><div class="pml-mut">un./dia · ${va.dias} dia(s)</div>` : '<span class="pml-mut">sem vendas</span>'}</td>
      </tr>`;
    };
    root.innerHTML = `
      <div class="pml-topo">
        <select class="pml-sel" onchange="window._pmlConta(this.value)">${st.contas.map(c => `<option value="${h(c.id)}" ${c.id === st.conta ? 'selected' : ''}>${h(c.nome)}</option>`).join('')}</select>
        <select class="pml-sel" onchange="window._pmlPeriodo(this.value)">${[7, 15, 30, 60].map(d => `<option value="${d}" ${+st.periodo === d ? 'selected' : ''}>Mudanças dos últimos ${d} dias</option>`).join('')}</select>
        <input class="pml-sel" style="min-width:220px" placeholder="Buscar produto ou MLB…" value="${h(st.busca)}" oninput="window._pmlBusca(this.value)">
        <span style="flex:1"></span>
        <button class="btn btn-secondary btn-sm" ${st.verificando || st.carregando ? 'disabled' : ''} onclick="window._pmlAgora()">${st.verificando ? '⏳ ' + h(st.progresso) : '🔍 Ver preços agora'}</button>
      </div>
      <div class="pml-mut" style="margin-bottom:10px">${h(fotoTxt)} · margem com tarifa e frete exatos do ML em cada preço, custo do produto, imposto${despesas().ads ? `, ADS ${pct(despesas().ads)}` : ''} e despesas de Vendas</div>
      ${st.erro ? `<div class="pml-erro">⚠️ ${h(st.erro)}</div>` : ''}
      <div class="pml-chips">${chip('todos', 'Mudaram de preço')}${chip('caiu', '▼ Margem caiu')}${chip('subiu', '▲ Margem subiu')}${chip('semcusto', 'Sem custo')}</div>
      <div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="pml-tab">
        <thead><tr><th>Produto</th><th class="n">Preço antes → agora</th><th class="n">Quando</th><th class="n">Margem antes → agora</th><th class="n">Lucro/un.</th><th class="n">Vendas/dia antes → depois</th></tr></thead>
        <tbody>${pagina.map(linha).join('') || `<tr><td colspan="6" class="pml-vazio">${st.carregando ? '⏳ Carregando…' : 'Nenhuma mudança de preço neste período.'}</td></tr>`}</tbody>
      </table></div>
      ${pags > 1 ? `<div class="pml-pag"><button ${st.pagina === 0 ? 'disabled' : ''} onclick="window._pmlPagina(-1)">‹</button><span>${st.pagina + 1} de ${pags}</span><button ${st.pagina >= pags - 1 ? 'disabled' : ''} onclick="window._pmlPagina(1)">›</button></div>` : ''}
      </div>`;
  }

  // ── Ações ──
  const salvar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  window._pmlConta = v => { st.conta = v; salvar('glr_pml_conta', v); carregar(); };
  window._pmlPeriodo = v => { st.periodo = +v; st.pagina = 0; salvar('glr_pml_periodo', +v); render(); };
  window._pmlFiltro = k => { st.filtro = k; st.pagina = 0; render(); };
  window._pmlPagina = d => { st.pagina += d; render(); };
  window._pmlAgora = () => verAgora();
  window._pmlBusca = v => { st.busca = v; st.pagina = 0; clearTimeout(window._pmlT); window._pmlT = setTimeout(() => { render(); const b = document.querySelector('.pml-topo input'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 200); };
  window._pmlCusto = (id, v) => {
    const n = num(v); if (n == null || n <= 0) return;
    const cat = lerJSON('glr_vendas_custo_catalogo', {}); cat[id] = Math.round(n * 100) / 100;
    localStorage.setItem('glr_vendas_custo_catalogo', JSON.stringify(cat)); // sincroniza (supabase-init)
    Object.keys(st.calc).filter(k => k.startsWith(id + '|')).forEach(k => delete st.calc[k]);
    render();
  };

  el.innerHTML = `<div class="page">
    <div style="font-size:22px;font-weight:650;letter-spacing:-0.02em;color:var(--text-primary);margin-bottom:4px">Monitor de preços ML</div>
    <div class="pml-mut" style="margin-bottom:16px;max-width:920px">Os anúncios que mudaram de preço na conta, e o efeito disso: margem antes × agora (subiu ou caiu) e vendas por dia antes × depois.</div>
    <div id="pml-root"></div>
  </div>
  <style>
    .pml-mut{font-size:12px;color:var(--text-muted)}
    .pml-topo{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
    .pml-sel{background:var(--bg-card);border:1px solid var(--border);border-radius:9px;color:var(--text-primary);padding:8px 11px;font-size:13px}
    .pml-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
    .pml-chip{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12px;cursor:pointer}
    .pml-chip.on{background:#2a78d6;border-color:#2a78d6;color:#fff}
    .pml-tab{width:100%;border-collapse:collapse;font-size:13px}
    .pml-tab th{padding:10px 12px;text-align:left;font-size:10.5px;text-transform:uppercase;color:var(--text-secondary);background:var(--bg-card-hover);white-space:nowrap}
    .pml-tab td{padding:9px 12px;border-bottom:1px solid var(--border);color:var(--text-secondary);vertical-align:middle}
    .pml-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    .pml-prod{display:flex;gap:10px;align-items:center;min-width:260px;max-width:440px}
    .pml-prod img,.pml-img{width:40px;height:40px;border-radius:8px;object-fit:cover;flex:none;background:var(--bg-card-hover);display:block}
    .pml-tit{font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pml-prod a{color:#2a78d6;text-decoration:none;font-family:ui-monospace,monospace}
    .pml-up{color:#16a34a;font-weight:700;font-size:12px}.pml-down{color:#dc2626;font-weight:700;font-size:12px}
    .pml-in{width:80px;background:var(--bg-card-hover);border:1px solid var(--border);border-radius:7px;color:var(--text-primary);padding:5px 7px;font-size:12.5px;text-align:right}
    .pml-in.vazio{border-color:#dc2626}
    .pml-vazio{padding:28px;text-align:center;color:var(--text-muted)}
    .pml-erro{background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.3);color:#dc2626;border-radius:10px;padding:8px 12px;font-size:12.5px;margin-bottom:10px}
    .pml-pag{display:flex;gap:10px;justify-content:center;align-items:center;padding:10px;font-size:13px;color:var(--text-secondary)}
    .pml-pag button{border:1px solid var(--border);background:var(--bg-card);border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text-primary)}
  </style>`;

  render();
  (async () => {
    try {
      const lista = await MarketplaceAPI.listAccounts();
      st.contas = (lista || []).filter(c => ['meli', 'ml', 'mercadolivre'].includes(String(c.marketplace).toLowerCase())).map(c => ({
        id: String(c.param_to_use?.meliUserId || c.external_id), nome: c.tags?.find?.(t => t?.name)?.name || c.nickname || c.external_id,
      })).sort((a, b) => a.nome.localeCompare(b.nome));
      if (!st.contas.length) { st.erro = 'Nenhuma conta do Mercado Livre conectada.'; render(); return; }
      if (!st.contas.some(c => c.id === st.conta)) st.conta = st.contas[0].id;
      carregar();
    } catch (e) { st.erro = 'Não consegui listar as contas: ' + e.message; render(); }
  })();
});
