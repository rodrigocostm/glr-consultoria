// ============================================================
// GLR Consultoria — Catálogo e Buy Box (Mercado Livre)
// ------------------------------------------------------------
// Tela do Agente de Conversão no ML (api/_conversao.js, de madrugada, cada
// conta uma vez por dia): anúncios de catálogo perdendo ou dividindo a Buy Box,
// com o preço que ganha e a margem nesse preço, e anúncios elegíveis que estão
// fora do catálogo. "Aplicar" muda o preço no ML e "Entrar no catálogo" publica
// a versão de catálogo — sempre com confirmação, pela mesma regra de aprovação
// da Caixa de decisões (js/acoes-agente.js). Preço que vem de promoção não é
// aplicado daqui: o caminho é ajustar a promoção.
// ============================================================
Router.register('conversao-ml', (params, el) => {
  const R$ = v => v == null || isNaN(v) ? '—' : 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const R0 = v => 'R$ ' + Math.round(parseFloat(v) || 0).toLocaleString('pt-BR');
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = v => v == null ? '—' : `${String(v).replace('.', ',')}%`;
  const BOOST = { free_installments: 'parcelamento sem juros', fulfillment: 'Full', same_day_shipping: 'envio no dia', free_shipping: 'frete grátis', shipping_collect: 'coleta' };
  const ABAS = [['perdendo', 'Perdendo o catálogo'], ['dividindo', 'Dividindo o 1º lugar'], ['elegiveis', 'Fora do catálogo']];
  const st = { contas: [], carregando: true, erro: null, aba: 'perdendo', proc: {}, feitos: new Set(), analisando: false };
  window._cvSt = st;

  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('conta_id,cursor').eq('marketplace', 'ml').eq('recurso', 'conversao');
      if (error) throw error;
      st.contas = (data || []).filter(r => r.cursor?.resumo).map(r => ({ conta: String(r.conta_id), ...r.cursor }));
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
    GLR.quandoClientes(render);
  }

  const doFoco = () => { const foco = GLR.ctx?.cliente(); return st.contas.filter(c => !foco || GLR.ctx.clienteDaConta('ml', c.conta) === String(foco)); };
  const linhas = aba => doFoco().flatMap(c => (c[aba] || []).map(x => ({ ...x, conta: c.conta, loja: GLR.nomeConta('ml', c.conta), margem_minima: c.margem_minima }))).sort((a, b) => b.receita30 - a.receita30 || (b.u30 || 0) - (a.u30 || 0));
  const chave = (x, aba) => `${aba}:${x.conta}:${x.item_id}`;

  function render() {
    if (window._cvSt !== st) return;
    const root = document.getElementById('cv-root'); if (!root) return;
    if (st.carregando && !st.contas.length) { root.innerHTML = '<div class="card cv-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card cv-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    const cs = doFoco(), foco = GLR.ctx?.cliente();
    const soma = k => cs.reduce((s, c) => s + (c.resumo?.[k] || 0), 0);
    const perd = linhas('perdendo'), eleg = linhas('elegiveis');
    const lidos = soma('lidos'), ganh = soma('ganhando');
    const ultima = cs.reduce((m, c) => c.em > m ? c.em : m, '');
    root.innerHTML = `
      <div class="cv-topo">
        <div class="cv-num"><b>${lidos ? Math.round(ganh / lidos * 100) : 0}%</b><span>ganhando o catálogo (${ganh} de ${lidos} conferidos)</span></div>
        <div class="cv-num" style="--c:var(--red)"><b>${perd.length}</b><span>perdendo · ${R0(perd.reduce((s, x) => s + x.receita30, 0))}/mês de venda neles</span></div>
        <div class="cv-num" style="--c:#d98b00"><b>${eleg.length}</b><span>fora do catálogo podendo entrar</span></div>
        <span style="flex:1"></span>
        <span class="cv-sub">${cs.length} conta(s) ML${ultima ? ` · lido ${new Date(ultima).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
        ${foco ? `<button class="btn btn-secondary btn-sm" ${st.analisando ? 'disabled' : ''} onclick="window._cvAnalisar()">${st.analisando ? 'Analisando…' : 'Analisar agora'}</button>` : ''}
      </div>
      <div class="cv-abas" role="tablist">${ABAS.map(([k, t]) => `<button role="tab" aria-selected="${st.aba === k}" class="cv-aba ${st.aba === k ? 'on' : ''}" onclick="window._cvAba('${k}')">${t} <b>${linhas(k).length}</b></button>`).join('')}</div>
      ${!cs.length ? `<div class="card cv-vazio"><b>O agente ainda não leu ${foco ? 'as contas ML deste cliente' : 'as contas ML'}.</b><span>Ele roda de madrugada (5h e 6h).${foco ? ' Use "Analisar agora" para ver já.' : ' Coloque um cliente em foco para analisar agora.'}</span></div>` : tabela(st.aba)}`;
  }

  function tabela(aba) {
    const ls = linhas(aba);
    if (!ls.length) return `<div class="card cv-vazio"><b>${aba === 'perdendo' ? 'Nenhum anúncio perdendo o catálogo' : aba === 'dividindo' ? 'Nenhum anúncio dividindo o 1º lugar' : 'Nenhum anúncio elegível fora do catálogo'}.</b></div>`;
    const cab = aba === 'elegiveis'
      ? '<th>Produto</th><th class="n">Preço</th><th class="n">Vendas 30 dias</th><th class="n">Já vendeu</th><th></th>'
      : `<th>Produto</th><th class="n">Preço hoje</th><th class="n">Preço que ganha</th><th class="n">Margem hoje → no preço novo</th><th class="n">Vendas 30 dias</th><th>Ajuda a ganhar</th><th></th>`;
    return `<div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="cv-tab" data-todas-colunas><thead><tr>${cab}</tr></thead><tbody>${ls.slice(0, 150).map(x => linha(x, aba)).join('')}</tbody></table></div>
      ${ls.length > 150 ? `<div class="cv-sub" style="padding:10px 14px">e mais ${ls.length - 150} com venda menor</div>` : ''}</div>`;
  }

  function linha(x, aba) {
    const k = chave(x, aba), proc = st.proc[k], feito = st.feitos.has(k);
    const prod = `<td><div class="cv-prod">${x.foto ? `<img src="${h(x.foto)}" alt="" loading="lazy">` : ''}<div><b>${h(x.titulo)}</b><small>${h(x.loja)} · ${h(x.item_id)}</small></div></div></td>`;
    const bt = feito ? '<span class="cv-ok">Feito</span>' : proc ? `<span class="cv-sub">${h(proc)}</span>` : null;
    if (aba === 'elegiveis') return `<tr>${prod}<td class="n">${R$(x.preco)}</td><td class="n">${x.u30 || 0} un.<small>${R0(x.receita30)}</small></td><td class="n">${x.vendidos || 0} un.</td>
      <td class="n">${bt || `<button class="btn btn-primary btn-sm" onclick="window._cvOptin('${h(k)}')">Entrar no catálogo</button>`}</td></tr>`;
    const novo = x.preco_ganhar;
    const marg = `${x.margem != null ? pct(x.margem) : 'sem custo'}${novo ? ` → <b style="color:${x.margem_nova == null ? 'var(--text-muted)' : x.margem_nova >= x.margem_minima ? 'var(--green)' : 'var(--red)'}">${x.margem_nova != null ? pct(x.margem_nova) : '?'}</b>` : ''}`;
    const acao = bt || (!novo ? '<span class="cv-sub">sem preço do ML</span>'
      : x.promo ? '<span class="cv-sub" title="O preço de hoje vem de uma promoção">ajuste a promoção</span>'
      : x.cabe === false ? `<span class="cv-sub" title="Margem mínima da conta: ${pct(x.margem_minima)}">não cabe na margem</span>`
      : `<button class="btn btn-primary btn-sm" onclick="window._cvPreco('${h(k)}')">Aplicar ${R$(novo)}</button>`);
    return `<tr>${prod}
      <td class="n">${R$(x.preco)}${x.promo ? `<small>promoção (cheio ${R$(x.preco_cheio)})</small>` : ''}</td>
      <td class="n"><b>${R$(novo)}</b>${x.queda_pct != null ? `<small>−${pct(x.queda_pct)}</small>` : x.vencedor ? `<small>1º lugar a ${R$(x.vencedor)}</small>` : ''}</td>
      <td class="n">${marg}</td>
      <td class="n">${x.u30 || 0} un.<small>${R0(x.receita30)}</small></td>
      <td>${(x.boosts || []).length ? `<div class="cv-boosts">${x.boosts.map(b => `<span>${h(BOOST[b] || b)}</span>`).join('')}</div>` : '<span class="cv-sub">—</span>'}</td>
      <td class="n">${acao}</td></tr>`;
  }

  // aprovação: usa o aviso pendente da Caixa de decisões se houver (fecha junto); senão aplica e registra a decisão
  async function executar(k, dados, titulo) {
    const { data } = await _sb.from('glr_agente_log').select('id,conta_id,cliente_nome,titulo,explicacao,dados').eq('conta_id', dados.conta).eq('tipo', 'alerta').eq('resultado', 'so_alerta').eq('dados->>chave', dados.chave).limit(1);
    const log = data?.[0] || { id: 0, conta_id: dados.conta, titulo, explicacao: 'Aplicado na tela Catálogo e Buy Box.', dados };
    await GLRAcoes.executar({ ...log, dados: { ...dados, ...(log.dados || {}) } }, (GLR.clientes || []).find(c => String(c.id) === String(GLR.ctx?.clienteDaConta('ml', dados.conta)))?.nome);
    st.feitos.add(k);
  }
  const achar = k => { const [aba] = k.split(':'); return linhas(aba).find(x => chave(x, aba) === k); };
  window._cvPreco = async k => {
    const x = achar(k); if (!x) return;
    const aviso = x.margem_nova == null ? '\n\nAtenção: o produto não tem custo cadastrado — confira a margem antes.' : `\n\nMargem: ${pct(x.margem)} → ${pct(x.margem_nova)} (mínima ${pct(x.margem_minima)}).`;
    if (!confirm(`Mudar o preço no Mercado Livre?\n\n${x.titulo}\n${R$(x.preco)} → ${R$(x.preco_ganhar)}${aviso}`)) return;
    st.proc[k] = 'Aplicando…'; render();
    try { await executar(k, { marketplace: 'ml', acao: 'buybox_preco', chave: `bb:${x.item_id}`, conta: x.conta, item_id: x.item_id, preco_atual: x.preco, preco_sugerido: x.preco_ganhar, tem_variacao: x.tem_variacao, margem_atual: x.margem, margem_nova: x.margem_nova, produto: x.titulo }, `Ganhar o catálogo — ${x.titulo}`); }
    catch (e) { alert('O ML não aceitou: ' + (e.message || e)); }
    delete st.proc[k]; render();
  };
  window._cvOptin = async k => {
    const x = achar(k); if (!x) return;
    if (!confirm(`Publicar no catálogo do Mercado Livre?\n\n${x.titulo}\nProduto de catálogo ${x.catalog_product_id}, mesmo preço (${R$(x.preco)}).`)) return;
    st.proc[k] = 'Publicando…'; render();
    try { await executar(k, { marketplace: 'ml', acao: 'catalogo_optin', chave: `cat:${x.item_id}`, conta: x.conta, item_id: x.item_id, catalog_product_id: x.catalog_product_id, produto: x.titulo }, `Entrar no catálogo — ${x.titulo}`); }
    catch (e) { alert('O ML não aceitou: ' + (e.message || e)); }
    delete st.proc[k]; render();
  };
  window._cvAba = k => { st.aba = k; render(); };
  window._cvAnalisar = async () => {
    const foco = GLR.ctx?.cliente(); if (!foco || st.analisando) return;
    let vinc = {}; try { vinc = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch (e) {}
    const contas = (vinc[String(foco)] || []).filter(c => /meli|mercado|^ml$/i.test(c.marketplace || '')).map(c => String(c.param_to_use?.meliUserId || c.external_id));
    if (!contas.length) return alert('Este cliente não tem conta do Mercado Livre vinculada.');
    st.analisando = true; render();
    try {
      for (const c of contas) {
        const r = await window.glrApiFetch(`/api/agente-cron?rodada=conversao&conta=${encodeURIComponent(c)}`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      }
      await carregar();
    } catch (e) { alert('Não consegui analisar: ' + (e.message || e)); }
    st.analisando = false; render();
  };

  el.innerHTML = `<div class="page">
    <div class="ajuda">Anúncios de catálogo do Mercado Livre que estão perdendo ou dividindo a vitrine, com o preço que ganha e a margem nesse preço (custo da tela Produtos), e anúncios que podem entrar no catálogo e ainda não entraram. O ML também mostra o que ajuda a ganhar sem baixar preço. Nada muda sem você confirmar; os melhores casos de cada conta também vão para a Caixa de decisões.</div>
    <div id="cv-root"></div>
  </div>
  <style>
    .cv-sub{font-size:12px;color:var(--text-muted);line-height:1.45}
    .cv-vazio{padding:28px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:4px} .cv-vazio span{font-size:13px;color:var(--text-muted)}
    .cv-topo{display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:12px}
    .cv-num{display:flex;flex-direction:column} .cv-num b{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1;color:var(--c,var(--text-primary))} .cv-num span{font-size:12px;color:var(--text-muted)}
    .cv-abas{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
    .cv-aba{border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
    .cv-aba b{color:var(--text-primary);font-weight:650;margin-left:2px} .cv-aba.on{border-color:var(--accent);background:var(--accent-glow);color:var(--accent-light)}
    .cv-tab{width:100%;border-collapse:collapse;font-size:13px}
    .cv-tab th{padding:9px 12px;text-align:left;font-size:11.5px;font-weight:600;color:var(--text-muted);background:var(--bg-card-hover);white-space:nowrap}
    .cv-tab td{padding:9px 12px;border-top:1px solid var(--border);vertical-align:middle}
    .cv-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums} .cv-tab td small{display:block;font-size:11.5px;color:var(--text-muted)}
    .cv-prod{display:flex;gap:10px;align-items:center;min-width:260px;max-width:440px} .cv-prod img{width:40px;height:40px;object-fit:cover;border-radius:6px;flex:none;background:var(--bg-subtle)}
    .cv-prod b{font-weight:600;line-height:1.35;display:block}
    .cv-boosts{display:flex;gap:4px;flex-wrap:wrap} .cv-boosts span{font-size:11px;font-weight:600;color:var(--accent);background:var(--accent-glow);border-radius:6px;padding:1px 6px;white-space:nowrap}
    .cv-ok{font-size:12px;font-weight:650;color:var(--green)}
  </style>`;
  carregar();
});
