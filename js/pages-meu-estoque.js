// ============================================================
// GLR Consultoria — Estoque (portal do cliente)
// ------------------------------------------------------------
// Um estoque por produto (SKU igual entre as lojas), gravado em todos os anúncios
// ligados no Mercado Livre e na Shopee. Com o espelho ativado, cada venda desconta
// do produto e o número novo vai para as outras lojas a cada 15 min (api/_estoque.js).
// Ao ativar, cada produto começa no MENOR estoque entre as lojas. Full fica de fora.
// ============================================================
Router.register('meu-estoque', (params, el) => {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MKT = { ml: { s: 'ML', c: '#d9a400' }, shopee: { s: 'SH', c: '#eb6834' } };
  const POR_PAGINA = 30;
  const st = { carregando: true, ativo: false, produtos: [], lista: [], erros: [], erro: null, busca: '', filtro: 'todos', pagina: 0, ocupado: {}, ativando: false };
  const call = (a, p = {}) => MarketplaceAPI.call(a, p);

  async function carregar() {
    st.carregando = true; st.erro = null; render();
    try { const r = await call('glr_estoque_listar'); st.ativo = r.ativo; st.produtos = r.produtos || []; st.erros = r.erros || []; }
    catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }
  async function salvar(i, inp) {
    const p = st.lista[i]; if (!p) return;
    const n = parseInt(String(inp.value).replace(/\D/g, ''), 10);
    if (!(n >= 0)) { inp.classList.add('erro'); return; }
    if (!confirm(`Gravar estoque ${n} em ${p.anuncios.filter(a => !a.full).length} anúncio(s) de "${String(p.nome).slice(0, 60)}"?`)) { inp.value = p.estoque ?? ''; return; }
    st.ocupado[p.chave] = true; render();
    try {
      const r = await call('glr_estoque_salvar', { chave: p.chave, nome: p.nome, sku: p.sku, estoque: n, anuncios: p.anuncios });
      p.estoque = n; p.salvo = true; p.diverge = false;
      p.anuncios.forEach(a => { if (!a.full) a.estoque = n; });
      const erros = (r.gravados || []).filter(x => x.erro);
      if (erros.length) alert(`Gravado, mas ${erros.length} anúncio(s) recusaram:\n${erros.slice(0, 4).map(x => `${x.a}: ${x.erro}`).join('\n')}`);
    } catch (e) { alert('Não consegui gravar: ' + (e.message || e)); }
    delete st.ocupado[p.chave]; render();
  }
  async function alternarEspelho() {
    const ligar = !st.ativo;
    if (ligar && !confirm('Ativar o estoque único?\n\n• Cada produto passa a ter UM estoque, o MENOR entre as lojas, gravado em todos os anúncios dele.\n• A cada venda, o sistema desconta e atualiza as outras lojas (a cada 15 min).\n• Anúncios Full ficam de fora.')) return;
    if (!ligar && !confirm('Desativar o espelho? As lojas voltam a ter estoques independentes.')) return;
    st.ativando = true; render();
    try {
      const r = await call('glr_estoque_ativar', { ativo: ligar, produtos: ligar ? st.produtos.map(p => ({ chave: p.chave, nome: p.nome, sku: p.sku, anuncios: p.anuncios })) : [] });
      st.ativo = r.ativo;
      if (ligar) alert(`Estoque único ativado. ${r.ajustados} anúncio(s) ajustados para o menor estoque${r.erros ? `, ${r.erros} com erro` : ''}.`);
      await carregar();
    } catch (e) { alert('Não consegui: ' + (e.message || e)); }
    st.ativando = false; render();
  }

  function render() {
    const root = document.getElementById('me-root'); if (!root) return;
    if (st.carregando && !st.produtos.length) { root.innerHTML = '<div class="card me-vazio">Lendo o estoque dos anúncios nas lojas…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card me-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    const q = st.busca.trim().toLowerCase();
    const multi = st.produtos.filter(p => p.anuncios.length > 1).length, div = st.produtos.filter(p => p.diverge).length, zer = st.produtos.filter(p => p.estoque === 0).length;
    const F = { todos: () => true, multi: p => p.anuncios.length > 1, diverge: p => p.diverge, zerado: p => p.estoque === 0 };
    st.lista = st.produtos.filter(F[st.filtro] || F.todos).filter(p => !q || `${p.sku} ${p.nome}`.toLowerCase().includes(q));
    const pags = Math.max(1, Math.ceil(st.lista.length / POR_PAGINA)); st.pagina = Math.min(st.pagina, pags - 1);
    const ini = st.pagina * POR_PAGINA, pagina = st.lista.slice(ini, ini + POR_PAGINA);
    const chip = (k, t, n) => `<button class="me-chip ${st.filtro === k ? 'on' : ''}" onclick="window._meFiltro('${k}')">${t} <b>${n}</b></button>`;
    root.innerHTML = `
      <div class="card me-topo">
        <div style="flex:1;min-width:260px"><div class="me-tit">Estoque único ${st.ativo ? '<span class="me-on">ativo</span>' : '<span class="me-off">desativado</span>'}</div>
          <div class="me-sub">${st.ativo ? 'Cada venda desconta do produto e atualiza as outras lojas a cada 15 min. Ajustes feitos aqui vão para todos os anúncios do produto.' : 'Com ele ativo, o mesmo produto em lojas diferentes divide um estoque só — sem vender o que não tem. Ao ativar, cada produto começa no menor estoque entre as lojas.'}</div></div>
        <button class="btn ${st.ativo ? 'btn-secondary' : 'btn-primary'} btn-sm" ${st.ativando || st.carregando ? 'disabled' : ''} onclick="window._meEspelho()">${st.ativando ? 'Aguarde…' : st.ativo ? 'Desativar' : 'Ativar estoque único'}</button>
        <button class="btn btn-secondary btn-sm" ${st.carregando ? 'disabled' : ''} onclick="window._meRecarregar()">${st.carregando ? 'Lendo…' : '↻ Ler das lojas'}</button>
      </div>
      ${st.erros.length ? `<div class="me-sub" style="color:var(--red);margin-bottom:8px">${st.erros.map(h).join(' · ')}</div>` : ''}
      <div class="me-filtros">${chip('todos', 'Todos', st.produtos.length)}${chip('multi', 'Em mais de uma loja', multi)}${chip('diverge', 'Estoque diferente entre lojas', div)}${chip('zerado', 'Zerados', zer)}
        <input id="me-busca" class="form-control me-busca" placeholder="Buscar SKU ou produto…" value="${h(st.busca)}" oninput="window._meBusca(this.value)"></div>
      <div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="me-tab" data-todas-colunas>
        <thead><tr><th>Produto</th><th>Nas lojas</th><th class="n">Estoque</th></tr></thead>
        <tbody>${pagina.map((p, j) => { const i = ini + j; return `<tr>
          <td><div class="me-prod">${p.foto ? `<img src="${h(p.foto)}" alt="" loading="lazy">` : '<span class="me-img"></span>'}<div><b>${h(String(p.nome).slice(0, 90))}</b><div class="me-sub">${p.sku ? `SKU ${h(p.sku)}` : 'sem SKU — não é ligado a outras lojas'}</div></div></div></td>
          <td>${p.anuncios.map(a => `<span class="me-an" style="--c:${MKT[a.mkt].c}" title="${h(a.mkt)} ${h(a.conta)} · ${h(a.id)}${a.var ? ' variação ' + h(a.var) : ''}">${MKT[a.mkt].s} ${a.full ? '<i>Full</i>' : `<b>${a.estoque ?? '—'}</b>`}</span>`).join(' ')}${p.diverge ? '<div class="me-sub" style="color:var(--yellow)">estoque diferente entre as lojas</div>' : ''}</td>
          <td class="n"><input class="me-in" inputmode="numeric" value="${p.estoque ?? ''}" ${st.ocupado[p.chave] ? 'disabled' : ''} onchange="window._meSalvar(${i}, this)" onkeydown="if(event.key==='Enter')this.blur()"></td></tr>`; }).join('') || `<tr><td colspan="3" class="me-vazio">${st.carregando ? 'Lendo…' : 'Nada neste filtro.'}</td></tr>`}</tbody>
      </table></div>
      ${pags > 1 ? `<div class="me-pag"><button ${st.pagina === 0 ? 'disabled' : ''} onclick="window._mePagina(-1)">‹</button><span>${st.pagina + 1} de ${pags}</span><button ${st.pagina >= pags - 1 ? 'disabled' : ''} onclick="window._mePagina(1)">›</button></div>` : ''}</div>`;
  }

  window._meRecarregar = carregar;
  window._meEspelho = alternarEspelho;
  window._meSalvar = salvar;
  window._meFiltro = k => { st.filtro = k; st.pagina = 0; render(); };
  window._mePagina = d => { st.pagina += d; render(); };
  window._meBusca = v => { st.busca = v; st.pagina = 0; clearTimeout(window._meT); window._meT = setTimeout(() => { render(); const b = document.getElementById('me-busca'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 200); };

  el.innerHTML = `<div class="page">
    <div class="ajuda">Um estoque por produto para todas as suas lojas. Produtos com o mesmo SKU no Mercado Livre e na Shopee dividem o estoque: ao mudar aqui, todos os anúncios recebem o número; com o estoque único ativo, cada venda atualiza as outras lojas sozinha.</div>
    <div id="me-root"></div>
  </div>
  <style>
    .me-sub{font-size:12px;color:var(--text-muted);line-height:1.5}
    .me-vazio{padding:24px;text-align:center;color:var(--text-muted)}
    .me-topo{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:14px 16px;margin-bottom:12px}
    .me-tit{font-weight:700;font-size:15px;margin-bottom:3px}
    .me-on,.me-off{font-size:11px;font-weight:650;border-radius:99px;padding:2px 8px;margin-left:6px;vertical-align:2px}
    .me-on{color:var(--green);background:color-mix(in srgb,var(--green) 12%,transparent)} .me-off{color:var(--text-muted);background:var(--bg-subtle)}
    .me-filtros{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
    .me-chip{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12px;cursor:pointer}
    .me-chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
    .me-busca{max-width:240px;margin-left:auto}
    .me-tab{width:100%;border-collapse:collapse;font-size:13px}
    .me-tab th{padding:9px 12px;text-align:left;font-size:11.5px;font-weight:600;color:var(--text-muted);background:var(--bg-card-hover)}
    .me-tab td{padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
    .me-tab .n{text-align:right}
    .me-prod{display:flex;gap:10px;align-items:center;min-width:260px;max-width:480px}
    .me-prod img,.me-img{width:38px;height:38px;border-radius:8px;object-fit:cover;flex:none;background:var(--bg-card-hover);display:block}
    .me-an{display:inline-block;font-size:11.5px;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);border-radius:6px;padding:2px 7px;margin:1px 0;white-space:nowrap}
    .me-an i{font-style:normal;color:var(--text-muted)}
    .me-in{width:84px;text-align:right;background:var(--bg-card-hover);border:1px solid var(--border);border-radius:7px;color:var(--text-primary);padding:6px 8px;font-size:13px;font-variant-numeric:tabular-nums}
    .me-in.erro{border-color:var(--red)}
    .me-pag{display:flex;gap:10px;justify-content:center;align-items:center;padding:10px;font-size:13px}
    .me-pag button{border:1px solid var(--border);background:var(--bg-card);border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text-primary)}
    @media (max-width:640px){.me-busca{max-width:none;margin-left:0;flex:1 1 100%}}
  </style>`;
  carregar();
});
