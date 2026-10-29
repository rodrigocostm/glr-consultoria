// ============================================================
// GLR Consultoria — Estoque e margem por produto
// ------------------------------------------------------------
// Mostra o "mural" dos agentes de Estoque e de Margem (api/_estoque-margem.js,
// calculado pelo sincronizador a cada 3 h): em quantos dias cada produto acaba
// e quanto de ACOS a margem dele aguenta. É isso que os agentes de ADS leem
// antes de decidir. A margem mínima de lucro por conta é definida aqui
// (glr_margem_minima, sincronizada) e vale no próximo cálculo.
// ============================================================
Router.register('estoque-margem', (params, el) => {
  const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const R$ = v => v == null ? '—' : 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = v => v == null ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')}%`;
  const N = v => (parseFloat(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };

  const st = {
    contas: [], conta: (() => { try { return localStorage.getItem('glr_em_conta') || ''; } catch (e) { return ''; } })(),
    dados: null, carregando: true, erro: null, filtro: 'risco', busca: '',
  };


  async function carregarContas() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('marketplace,conta_id,ultimo_sucesso,ultimo_erro,resumo:cursor->resumo').eq('recurso', 'sinais');
      if (error) throw error;
      st.contas = (data || []).map(r => ({ ...r, nome: GLR.nomeConta(r.marketplace, r.conta_id) }))
        .sort((a, b) => ((b.resumo?.zerados || 0) + (b.resumo?.criticos || 0) + (b.resumo?.negativos || 0)) - ((a.resumo?.zerados || 0) + (a.resumo?.criticos || 0) + (a.resumo?.negativos || 0)) || a.nome.localeCompare(b.nome));
      { const p = GLR.ctx?.escolher(st.contas.map(c => ({ k: `${c.marketplace}:${c.conta_id}`, mkt: c.marketplace, id: c.conta_id })), st.conta); if (p) st.conta = p; } // cliente em foco
      if (!st.contas.some(c => `${c.marketplace}:${c.conta_id}` === st.conta)) st.conta = st.contas[0] ? `${st.contas[0].marketplace}:${st.contas[0].conta_id}` : '';
      // nomes de novo quando os clientes terminarem de carregar
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
      const { data, error } = await _sb.from('glr_sync_estado').select('cursor,ultimo_sucesso').eq('recurso', 'sinais').eq('marketplace', mkt).eq('conta_id', id).limit(1);
      if (error) throw error;
      st.dados = data?.[0]?.cursor || null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  const CHIP_E = { zerado: ['Sem estoque', 'var(--red)'], critico: ['Acaba em até 7 dias', 'var(--red)'], baixo: ['Até 15 dias', 'var(--yellow)'], ok: ['Em dia', 'var(--green)'] };
  const CHIP_M = { negativa: ['Negativa', 'var(--red)'], apertada: ['Apertada', 'var(--yellow)'], ok: ['Com folga', 'var(--green)'] };
  const chip = (c, t) => `<span class="em-chip" style="--c:${c}">${t}</span>`;
  const FILTROS = [
    ['risco', 'Precisa de atenção', i => ['zerado', 'critico', 'baixo'].includes(i.ne) || ['negativa', 'apertada'].includes(i.nm)],
    ['zerado', 'Sem estoque', i => i.ne === 'zerado'], ['critico', 'Acaba em até 7 dias', i => i.ne === 'critico'], ['baixo', 'Até 15 dias', i => i.ne === 'baixo'],
    ['negativa', 'Margem negativa', i => i.nm === 'negativa'], ['apertada', 'Margem apertada', i => i.nm === 'apertada'], ['semcusto', 'Sem custo', i => !i.c], ['todos', 'Todos', () => true],
  ];

  function render() {
    const root = document.getElementById('em-root'); if (!root) return;
    if (st.carregando && !st.contas.length) { root.innerHTML = '<div class="em-sub" style="padding:30px">Carregando…</div>'; return; }
    if (!st.contas.length) { root.innerHTML = `<div class="card" style="padding:24px"><b>Ainda não há cálculo de estoque e margem.</b><div class="em-sub" style="margin-top:6px">Os agentes calculam a cada 3 horas, para as lojas da Shopee e do Mercado Livre que já estão na sincronização automática. Volte depois da próxima rodada.</div>${st.erro ? `<div class="em-sub" style="color:var(--red);margin-top:6px">${h(st.erro)}</div>` : ''}</div>`; return; }
    const d = st.dados, conta = st.contas.find(c => `${c.marketplace}:${c.conta_id}` === st.conta);
    const itens = d ? Object.entries(d.itens || {}).map(([id, x]) => ({ id, ...x })) : [];
    const f = FILTROS.find(x => x[0] === st.filtro) || FILTROS[0];
    const q = st.busca.trim().toLowerCase();
    const lista = itens.filter(f[2]).filter(i => !q || String(i.n).toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
      .sort((a, b) => ({ zerado: 0, critico: 1, baixo: 2 }[a.ne] ?? 5) - ({ zerado: 0, critico: 1, baixo: 2 }[b.ne] ?? 5) || (a.m ?? 999) - (b.m ?? 999) || b.vd - a.vd);
    const r = d?.resumo || {};
    const margMin = lerJSON('glr_margem_minima', {})[conta?.conta_id] ?? d?.margem_minima ?? 5;
    const quando = d?.em ? new Date(d.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const link = i => d?.mkt === 'ml' ? `https://produto.mercadolivre.com.br/${String(i.id).replace(/^MLB/, 'MLB-')}` : `https://shopee.com.br/product/${h(conta?.conta_id)}/${h(i.id)}`;
    const fonte = { produto: 'repasse do próprio produto', conta: 'média de repasse da conta', tarifa: 'tarifa de venda do ML (sem frete)' };

    root.innerHTML = `
      <div class="em-topo card">
        <select class="form-control" style="max-width:340px" onchange="window._emConta(this.value)">
          ${st.contas.map(c => { const k = `${c.marketplace}:${c.conta_id}`, rr = c.resumo || {}, n = (rr.zerados || 0) + (rr.criticos || 0) + (rr.negativos || 0); return `<option value="${h(k)}" ${k === st.conta ? 'selected' : ''}>${h(c.nome)}${n ? ` — ${n} alerta(s)` : ''}</option>`; }).join('')}
        </select>
        <span class="em-sub">calculado em ${quando} · últimos ${d?.dias || 30} dias de pedidos${d?.aliquota ? ` · imposto da conta ${pct(d.aliquota)}` : ''}</span>
        <label class="em-margem" title="O ACOS alvo de cada produto deixa esse lucro (vale no próximo cálculo)">Margem mínima de lucro <input id="em-margem-min" class="form-control" inputmode="decimal" value="${String(margMin).replace('.', ',')}" onchange="window._emMargemMin(this.value)"> %</label>
      </div>
      ${!d ? `<div class="em-sub" style="padding:20px">${st.carregando ? 'Carregando…' : 'Sem dados desta conta.'}</div>` : `
      <div class="em-kpis">
        <div><span>Produtos analisados</span><b>${N(r.produtos)}</b><small>os que venderam nos últimos 30 dias</small></div>
        <div><span>Sem estoque</span><b style="color:${r.zerados ? 'var(--red)' : 'inherit'}">${N(r.zerados)}</b><small>${N(r.criticos)} acabam em até 7 dias · ${N(r.baixos)} em até 15</small></div>
        <div><span>Margem negativa</span><b style="color:${r.negativos ? 'var(--red)' : 'inherit'}">${N(r.negativos)}</b><small>${N(r.apertados)} com margem apertada</small></div>
        <div><span>Com custo cadastrado</span><b>${N(r.comCusto)}<small>/${N(r.produtos)}</small></b><small>${r.produtos - r.comCusto > 0 ? 'sem custo não dá para calcular a margem' : 'todos com custo'}</small></div>
      </div>
      ${r.produtos && !r.comCusto ? `<div class="em-aviso">Nenhum produto desta conta tem custo cadastrado — por isso as colunas de margem e ACOS alvo não aparecem. <button class="btn btn-secondary btn-sm" onclick="Router.navigate('produtos')">Cadastrar custos</button></div>` : ''}
      <div class="card em-card">
        <div class="em-filtros">
          ${FILTROS.map(([k, t, fn]) => `<button class="${st.filtro === k ? 'on' : ''}" onclick="window._emFiltro('${k}')">${t} <b>${itens.filter(fn).length}</b></button>`).join('')}
          <input class="form-control em-busca" placeholder="Buscar produto ou ID" value="${h(st.busca)}" oninput="window._emBusca(this.value)">
        </div>
        <div style="overflow-x:auto"><table class="em-tab"><thead><tr>
          <th>Produto</th><th>Vendas/dia</th><th>Estoque</th><th>Cobre</th><th>Situação do estoque</th>
          <th>Preço médio</th><th>Custo</th><th>Margem antes do ADS</th><th title="Gastar mais que isto em ADS dá prejuízo">ACOS de equilíbrio</th><th title="ACOS que ainda deixa a margem mínima de lucro — o limite que os agentes de ADS usam">ACOS alvo</th>
        </tr></thead><tbody>
          ${lista.slice(0, 300).map(i => `<tr>
            <td class="em-prod"><a href="${link(i)}" target="_blank" rel="noopener">${h(i.n)}</a><div class="em-sub">${h(i.id)}${i.vz ? ` · ${i.vz} de ${i.vt} variação(ões) sem estoque` : ''}</div></td>
            <td>${N(i.vd)}</td><td>${i.e == null ? '—' : N(i.e)}</td><td>${i.e == null || i.ne === 'zerado' ? '—' : i.d == null ? 'sem venda recente' : i.d > 365 ? '+1 ano' : `${Math.round(i.d)} dia(s)`}</td>
            <td>${i.ne ? chip(CHIP_E[i.ne][1], CHIP_E[i.ne][0]) : '<span class="em-sub">não lido</span>'}</td>
            <td>${R$(i.p)}</td><td>${i.c ? R$(i.c) : '—'}</td>
            <td title="${h(i.fr ? 'Taxas pelo ' + fonte[i.fr] : '')}">${i.m == null ? '—' : `${pct(i.m)} ${chip(CHIP_M[i.nm][1], CHIP_M[i.nm][0])}`}</td>
            <td>${pct(i.ac)}</td><td><b>${pct(i.aa)}</b></td>
          </tr>`).join('') || `<tr><td colspan="10" class="em-sub" style="padding:18px;text-align:center">Nenhum produto neste filtro.</td></tr>`}
        </tbody></table></div>
        <div class="ajuda">Margem antes do ADS = preço médio × repasse do marketplace − custo − imposto. O repasse vem dos pedidos já pagos do próprio produto; sem isso, da média da conta. Os agentes de ADS não aceleram produto que acaba em até 10 dias, sugerem pausar/tirar da campanha o que está sem estoque e usam o ACOS alvo como teto quando ele é menor que a meta da conta.</div>
      </div>`}`;
  }

  window._emConta = k => { st.conta = k; GLR.ctx?.definirPorConta(k.split(':')[0], k.split(':')[1]); try { localStorage.setItem('glr_em_conta', k); } catch (e) {} carregarConta(); };
  window._emFiltro = k => { st.filtro = k; render(); };
  let tBusca = null;
  window._emBusca = v => { st.busca = v; clearTimeout(tBusca); tBusca = setTimeout(() => { render(); const i = document.querySelector('.em-busca'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } }, 250); };
  window._emMargemMin = v => {
    const n = parseFloat(String(v).replace(',', '.'));
    const conta = st.conta.split(':')[1]; if (!conta) return;
    const m = lerJSON('glr_margem_minima', {});
    if (isNaN(n) || n < 0 || n > 80) { alert('Use um número entre 0 e 80.'); render(); return; }
    m[conta] = n; localStorage.setItem('glr_margem_minima', JSON.stringify(m)); // sincroniza (supabase-init)
    const i = document.getElementById('em-margem-min'); if (i) { i.style.borderColor = 'var(--green)'; setTimeout(() => { i.style.borderColor = ''; }, 1200); }
  };

  el.innerHTML = `<div class="page">
    <div id="em-root"></div>
  </div>
  <style>
    .em-sub{font-size:12px;color:var(--text-muted)}
    .em-aviso{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:13px;color:var(--text-secondary);background:color-mix(in srgb,var(--yellow) 10%,var(--bg-surface));border:1px solid color-mix(in srgb,var(--yellow) 35%,var(--border));border-radius:10px;padding:10px 14px;margin-bottom:12px}
    .em-topo{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:12px 16px;margin-bottom:14px}
    .em-margem{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-secondary);flex-wrap:wrap;margin-left:auto}
    .em-margem input{width:64px;text-align:right}
    .em-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:14px}
    .em-kpis>div{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius,14px);padding:12px 16px;display:flex;flex-direction:column;gap:2px}
    .em-kpis span{font-size:12.5px;color:var(--text-secondary)} .em-kpis b{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums} .em-kpis b small{font-size:13px;color:var(--text-muted);font-weight:500} .em-kpis>div>small{font-size:11.5px;color:var(--text-muted)}
    .em-card{padding:14px 16px}
    .em-filtros{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
    .em-filtros button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:4px 11px;font-size:12px;cursor:pointer;font-family:inherit}
    .em-filtros button.on{background:var(--text-primary);border-color:var(--text-primary);color:var(--bg-card)}
    .em-busca{max-width:240px;margin-left:auto}
    .em-tab{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
    .em-tab th,.em-tab td{padding:8px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap;vertical-align:middle}
    .em-prod{white-space:normal!important;min-width:240px;max-width:380px} .em-prod a{color:var(--text-primary);text-decoration:none;font-weight:550} .em-prod a:hover{text-decoration:underline}
    .em-chip{display:inline-block;font-size:11px;font-weight:600;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);border-radius:99px;padding:1px 8px}
  </style>`;
  carregarContas();
});
