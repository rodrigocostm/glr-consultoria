// ============================================================
// GLR Consultoria — Qualidade dos anúncios
// ------------------------------------------------------------
// Tela do Agente de Qualidade de Anúncio (api/_qualidade.js, 1x por dia):
// experiência de compra e qualidade do anúncio no ML, conversão (vendas ÷
// visitas) contra a mediana da conta, diagnóstico de conteúdo na Shopee, e as
// pendências que se repetem na conta (problema de operação, não de um anúncio).
// Anúncio "a consertar" não é acelerado pelos agentes de ADS.
// ============================================================
Router.register('qualidade-anuncios', (params, el) => {
  const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = v => v == null ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')}%`;
  const N = v => v == null ? '—' : (parseFloat(v) || 0).toLocaleString('pt-BR');
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const st = { contas: [], conta: (() => { try { return localStorage.getItem('glr_qa_conta') || ''; } catch (e) { return ''; } })(), dados: null, carregando: true, erro: null, filtro: 'ruim' };
  window._qaSt = st;

  async function carregarContas() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('marketplace,conta_id,ultimo_sucesso,resumo:cursor->resumo').eq('recurso', 'qualidade');
      if (error) throw error;
      const vinc = lerJSON('glr_mc_vinculos', {}), nomes = new Map();
      for (const c of (window.GLR?.clientes || [])) for (const ct of (vinc[String(c.id)] || [])) [ct.external_id, ct.param_to_use?.shopId, ct.param_to_use?.meliUserId].filter(Boolean).forEach(i => nomes.set(String(i), `${c.nome} · ${ct.nickname || ct.external_id}`));
      st.contas = (data || []).map(r => ({ ...r, nome: GLR.nomeConta(r.marketplace, r.conta_id) })).sort((a, b) => (b.resumo?.ruins || 0) - (a.resumo?.ruins || 0) || a.nome.localeCompare(b.nome));
      { const p = GLR.ctx?.escolher(st.contas.map(c => ({ k: `${c.marketplace}:${c.conta_id}`, mkt: c.marketplace, id: c.conta_id })), st.conta); if (p) st.conta = p; } // cliente em foco
      if (!st.contas.some(c => `${c.marketplace}:${c.conta_id}` === st.conta)) st.conta = st.contas[0] ? `${st.contas[0].marketplace}:${st.contas[0].conta_id}` : '';
      GLR.quandoClientes(() => { st.contas.forEach(c => { c.nome = GLR.nomeConta(c.marketplace, c.conta_id); }); render(); });
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    await carregarConta();
  }
  async function carregarConta() {
    st.dados = null;
    if (!st.conta) { st.carregando = false; render(); return; }
    st.carregando = true; render();
    const [mkt, id] = st.conta.split(':');
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('cursor').eq('recurso', 'qualidade').eq('marketplace', mkt).eq('conta_id', id).limit(1);
      if (error) throw error;
      st.dados = data?.[0]?.cursor || null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  const NIVEL = { ruim: ['A consertar', 'var(--red)'], melhorar: ['Pode melhorar', 'var(--yellow)'], ok: ['Em dia', 'var(--green)'] };
  const chip = (c, t) => `<span class="qa-chip" style="--c:${c}">${t}</span>`;

  function render() {
    if (window._qaSt !== st) return; // tela já foi redesenhada (ex.: troca do cliente em foco): carregamento antigo não pinta por cima
    const root = document.getElementById('qa-root'); if (!root) return;
    if (st.carregando && !st.contas.length) { root.innerHTML = '<div class="qa-sub" style="padding:30px">Carregando…</div>'; return; }
    if (!st.contas.length) { root.innerHTML = `<div class="card" style="padding:22px"><b>O agente de Qualidade ainda não rodou.</b><div class="qa-sub" style="margin-top:6px">Ele analisa cada loja uma vez por dia, depois das 06:00, começando pelos anúncios que mais vendem.</div>${st.erro ? `<div class="qa-sub" style="color:var(--red)">${h(st.erro)}</div>` : ''}</div>`; return; }
    const d = st.dados, ml = d?.mkt === 'ml', r = d?.resumo || {};
    const itens = d ? Object.entries(d.itens || {}).map(([id, x]) => ({ id, ...x })) : [];
    const lista = itens.filter(x => st.filtro === 'todos' || x.nivel === st.filtro).sort((a, b) => ({ ruim: 0, melhorar: 1, ok: 2 }[a.nivel] - { ruim: 0, melhorar: 1, ok: 2 }[b.nivel]) || (b.u30 || 0) - (a.u30 || 0));
    const link = id => ml ? `https://produto.mercadolivre.com.br/${String(id).replace(/^MLB/, 'MLB-')}` : `https://shopee.com.br/product/${h(d?.conta)}/${h(id)}`;
    const quando = d?.em ? new Date(d.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    root.innerHTML = `
      <div class="card qa-topo">
        <select class="form-control" style="max-width:340px" onchange="window._qaConta(this.value)">
          ${st.contas.map(c => { const k = `${c.marketplace}:${c.conta_id}`; return `<option value="${h(k)}" ${k === st.conta ? 'selected' : ''}>${h(c.nome)}${c.resumo?.ruins ? ` — ${c.resumo.ruins} a consertar` : ''}</option>`; }).join('')}
        </select>
        <span class="qa-sub">analisado em ${quando}${ml ? ` · cada anúncio é revisto a cada 3 dias · conversão média da conta ${pct(d?.mediana_conversao)}` : ''}</span>
      </div>
      ${!d ? `<div class="qa-sub" style="padding:20px">${st.carregando ? 'Carregando…' : 'Sem dados desta conta.'}</div>` : `
      <div class="qa-kpis">
        <div><span>Anúncios analisados</span><b>${N(r.analisados)}</b><small>os que mais vendem</small></div>
        <div><span>A consertar</span><b style="color:${r.ruins ? 'var(--red)' : 'inherit'}">${N(r.ruins)}</b><small>o ADS não acelera estes</small></div>
        ${ml ? `<div><span>Experiência de compra ruim</span><b>${N(r.expRuim)}</b><small>nota abaixo de 50 · ${N(r.pausados)} pausado(s) pelo ML</small></div>
        <div><span>Muita visita, pouca venda</span><b>${N(r.convBaixa)}</b><small>menos de 40% da conversão da conta</small></div>` : `<div><span>Podem melhorar</span><b>${N(r.melhorar)}</b><small>pendências no conteúdo</small></div>`}
      </div>
      ${(d.destaques?.comuns || []).length ? `<div class="card qa-card"><div class="qa-tit">Pendências que se repetem na conta <span class="qa-sub">quando o mesmo ponto aparece em vários anúncios, o conserto é de processo</span></div>
        <div class="qa-comuns">${d.destaques.comuns.map(c => `<span><b>${c.n}</b> ${h(c.t)}</span>`).join('')}</div></div>` : ''}
      <div class="card qa-card">
        <div class="qa-filtros">${[['ruim', 'A consertar'], ['melhorar', 'Pode melhorar'], ['ok', 'Em dia'], ['todos', 'Todos']].map(([k, t]) => `<button class="${st.filtro === k ? 'on' : ''}" onclick="window._qaFiltro('${k}')">${t} <b>${k === 'todos' ? itens.length : itens.filter(x => x.nivel === k).length}</b></button>`).join('')}</div>
        <div style="overflow-x:auto"><table class="qa-tab"><thead><tr><th>Anúncio</th><th>Vendas 30 d</th>${ml ? '<th>Visitas 30 d</th><th>Conversão</th><th>Experiência de compra</th><th>Qualidade</th>' : '<th>Conteúdo</th>'}<th>O que fazer</th><th></th></tr></thead><tbody>
          ${lista.slice(0, 300).map(x => `<tr>
            <td class="qa-prod"><a href="${link(x.id)}" target="_blank" rel="noopener">${h(x.n)}</a><div class="qa-sub">${h(x.id)}${x.pausado ? ' · <b style="color:var(--red)">pausado pelo ML</b>' : x.congelado ? ' · <b style="color:var(--red)">congelado pelo ML</b>' : ''}</div></td>
            <td>${N(x.u30)}</td>
            ${ml ? `<td>${N(x.vis)}</td><td style="color:${/conversão/.test(x.qa || '') ? 'var(--red)' : 'inherit'}">${pct(x.conv)}</td>
            <td>${x.nota == null || x.nota < 0 ? '<span class="qa-sub">sem nota ainda</span>' : `<b style="color:${x.nota < 50 ? 'var(--red)' : x.nota < 70 ? 'var(--yellow)' : 'var(--green)'}">${x.nota}/100</b>`}${x.causa ? `<div class="qa-sub">${h(x.causa)}</div>` : ''}</td>
            <td>${x.score == null ? '—' : `${x.score}/100`}${x.nivelAnuncio ? `<div class="qa-sub">${h(x.nivelAnuncio)}</div>` : ''}</td>` : `<td>${h(x.nivelTxt || '—')}</td>`}
            <td class="qa-prod">${x.qa ? `<div style="color:var(--red);font-size:12.5px">${h(x.qa)}</div>` : ''}${x.remedio ? `<div class="qa-sub">${h(x.remedio)}</div>` : ''}${(x.pend || []).length ? `<ul class="qa-pend">${x.pend.map(p => `<li>${h(p)}</li>`).join('')}</ul>` : (!x.qa && !x.remedio ? '<span class="qa-sub">nada pendente</span>' : '')}</td>
            <td>${chip(NIVEL[x.nivel][1], NIVEL[x.nivel][0])}</td>
          </tr>`).join('') || `<tr><td colspan="8" class="qa-sub" style="padding:18px;text-align:center">Nenhum anúncio neste filtro.</td></tr>`}
        </tbody></table></div>
      </div>`}`;
  }
  window._qaConta = k => { st.conta = k; GLR.ctx?.definirPorConta(k.split(':')[0], k.split(':')[1]); try { localStorage.setItem('glr_qa_conta', k); } catch (e) {} carregarConta(); };
  window._qaFiltro = k => { st.filtro = k; render(); };

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <h1 style="font-size:22px;font-weight:650;letter-spacing:-.02em;margin:0">Qualidade dos anúncios</h1>
      <span class="qa-sub">o que derruba a exposição e a conversão de cada anúncio — e o que consertar primeiro</span>
    </div>
    <div id="qa-root"></div>
  </div>
  <style>
    .qa-sub{font-size:12px;color:var(--text-muted)} .qa-topo{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:12px 16px;margin-bottom:14px}
    .qa-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:14px}
    .qa-kpis>div{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius,14px);padding:12px 16px;display:flex;flex-direction:column;gap:2px}
    .qa-kpis span{font-size:12.5px;color:var(--text-secondary)} .qa-kpis b{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums} .qa-kpis small{font-size:11.5px;color:var(--text-muted)}
    .qa-card{padding:14px 16px;margin-bottom:14px} .qa-tit{font-weight:650;font-size:14px;margin-bottom:10px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
    .qa-comuns{display:flex;gap:8px;flex-wrap:wrap} .qa-comuns span{font-size:12.5px;background:var(--bg-subtle);border-radius:99px;padding:4px 12px;color:var(--text-secondary)} .qa-comuns b{color:var(--text-primary)}
    .qa-filtros{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
    .qa-filtros button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:4px 11px;font-size:12px;cursor:pointer;font-family:inherit} .qa-filtros button.on{background:var(--text-primary);border-color:var(--text-primary);color:var(--bg-card)}
    .qa-tab{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums} .qa-tab th,.qa-tab td{padding:8px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap;vertical-align:top}
    .qa-prod{white-space:normal!important;min-width:220px;max-width:380px} .qa-prod a{color:var(--text-primary);text-decoration:none;font-weight:550}
    .qa-pend{margin:4px 0 0;padding-left:16px;font-size:12px;color:var(--text-secondary)}
    .qa-chip{display:inline-block;font-size:11px;font-weight:600;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);border-radius:99px;padding:1px 8px}
  </style>`;
  carregarContas();
});
