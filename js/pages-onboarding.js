// ============================================================
// GLR Consultoria — Implantação de clientes (onboarding)
// ------------------------------------------------------------
// Tela do Agente de Onboarding (api/_onboarding.js, todo dia às 07:00 ou
// "Verificar agora"): o checklist de entrada de cada cliente — essenciais
// (contas, conexões, vendas na base, comissão), importantes (gestor, meta,
// custos, agente de ADS, permissão de Ads) e complementares (saldo, portal,
// Plano de ação) — com o que falta e o atalho para a tela que resolve, já com
// o cliente em foco. Aba "Carteira toda": quantos clientes faltam em cada passo.
// Só lê; os ajustes são feitos nas telas de cada passo.
// ============================================================
Router.register('onboarding', (params, el) => {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const NIVEIS = [['essencial', 'Essenciais — sem eles não há venda nem comissão'], ['importante', 'Importantes — para os agentes trabalharem certo'], ['complementar', 'Complementares']];
  const st = { em: null, clientes: [], carregando: true, erro: null, aba: 'implantacao', abertos: new Set(), verificando: false };
  window._obSt = st;

  const gestorNome = id => (GLR.gestores || []).find(g => String(g.id) === String(id))?.nome || '';
  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('cursor').eq('marketplace', 'sistema').eq('conta_id', 'onboarding').eq('recurso', 'todas').maybeSingle();
      if (error) throw error;
      st.em = data?.cursor?.em || null;
      st.clientes = Object.entries(data?.cursor?.clientes || {}).map(([id, x]) => ({ id, ...x }));
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
    GLR.quandoClientes(render);
  }

  function render() {
    if (window._obSt !== st) return;
    const root = document.getElementById('ob-root'); if (!root) return;
    if (st.carregando && !st.clientes.length) { root.innerHTML = '<div class="card ob-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card ob-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    if (!st.em) { root.innerHTML = `<div class="card ob-vazio"><b>O agente ainda não verificou os clientes.</b><span>Ele roda todo dia às 7h.</span><button class="btn btn-primary btn-sm" style="margin-top:10px" ${st.verificando ? 'disabled' : ''} onclick="window._obVerificar()">${st.verificando ? 'Verificando…' : 'Verificar agora'}</button></div>`; return; }
    const foco = GLR.ctx?.cliente();
    const base = st.clientes.filter(x => !foco || x.id === String(foco)).map(x => ({ ...x, nome: (GLR.clientes || []).find(c => String(c.id) === x.id)?.nome || x.nome }));
    const impl = base.filter(x => x.implantacao).sort((a, b) => (a.essenciais_ok - b.essenciais_ok) || a.pct - b.pct);
    const travados = impl.filter(x => !x.essenciais_ok).length;
    root.innerHTML = `
      <div class="ob-topo">
        <div class="ob-num"><b>${impl.length}</b><span>cliente(s) em implantação</span></div>
        <div class="ob-num" style="--c:var(--red)"><b>${travados}</b><span>com passo essencial faltando</span></div>
        <div class="ob-num"><b>${base.filter(x => x.pendentes).length}</b><span>de ${base.length} com alguma pendência</span></div>
        <span style="flex:1"></span>
        <span class="ob-sub">Verificado ${new Date(st.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
        <button class="btn btn-secondary btn-sm" ${st.verificando ? 'disabled' : ''} onclick="window._obVerificar()">${st.verificando ? 'Verificando…' : 'Verificar agora'}</button>
      </div>
      <div class="ob-abas" role="tablist">
        <button role="tab" aria-selected="${st.aba === 'implantacao'}" class="ob-aba ${st.aba === 'implantacao' ? 'on' : ''}" onclick="window._obAba('implantacao')">Em implantação <b>${impl.length}</b></button>
        <button role="tab" aria-selected="${st.aba === 'carteira'}" class="ob-aba ${st.aba === 'carteira' ? 'on' : ''}" onclick="window._obAba('carteira')">Carteira toda <b>${base.length}</b></button>
      </div>
      ${st.aba === 'carteira' ? carteira(base)
        : impl.length ? `<div class="ob-lista">${impl.map(card).join('')}</div>`
        : '<div class="card ob-vazio"><b>Nenhum cliente em implantação.</b><span>Cliente novo aparece aqui assim que é cadastrado: o agente acompanha os primeiros 60 dias.</span></div>'}`;
  }

  function card(x) {
    const aberto = st.abertos.has(x.id), falta = x.passos.filter(p => !p.ok);
    const cor = !x.essenciais_ok ? 'var(--red)' : x.pct >= 85 ? 'var(--green)' : '#d98b00';
    return `<div class="card ob-c" style="--c:${cor}">
      <button type="button" class="ob-c-cab" aria-expanded="${aberto}" onclick="window._obAbrir('${h(x.id)}')">
        <span class="ob-c-nome"><b>${h(x.nome)}</b><span class="ob-sub">${h(gestorNome(x.gestor_id) || 'Sem gestor')} · ${x.dias <= 60 ? `começou há ${x.dias} dia(s)` : 'na carteira há mais de 60 dias'}</span></span>
        <span class="ob-barra" aria-label="${x.pct}% pronto"><span style="width:${x.pct}%"></span></span>
        <span class="ob-pct">${x.pct}%</span>
        <span class="ob-falta">${falta.slice(0, 3).map(p => `<span class="${p.nivel === 'essencial' ? 'ess' : ''}">${h(p.titulo)}</span>`).join('')}${falta.length > 3 ? `<span>+${falta.length - 3}</span>` : ''}${!falta.length ? '<span class="ok">tudo pronto</span>' : ''}</span>
      </button>
      ${aberto ? `<div class="ob-det">${NIVEIS.map(([n, t]) => `<div class="ob-tit">${t}</div>${x.passos.filter(p => p.nivel === n).map(p => passo(x, p)).join('')}`).join('')}</div>` : ''}
    </div>`;
  }

  function passo(x, p) {
    return `<div class="ob-p ${p.ok ? 'feito' : ''}">
      <span class="ob-check" aria-hidden="true">${p.ok ? '✓' : ''}</span>
      <div class="ob-p-txt"><b>${h(p.titulo)}</b><span>${h(p.detalhe)}</span>${p.ok ? '' : `<span class="ob-acao">${h(p.acao)}</span>`}</div>
      ${p.ok ? '' : `<button class="btn btn-secondary btn-sm" onclick="window._obIr('${h(x.id)}', '${h(p.tela)}')">Abrir</button>`}
    </div>`;
  }

  // visão da carteira: quantos clientes faltam em cada passo (do essencial para o complementar)
  function carteira(base) {
    const passos = base[0]?.passos || [];
    if (!passos.length) return '<div class="card ob-vazio"><b>Sem clientes.</b></div>';
    return `<div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="ob-tab" data-todas-colunas>
      <thead><tr><th>Passo</th><th>Nível</th><th class="n">Clientes faltando</th><th>Quem</th></tr></thead>
      <tbody>${passos.map(pp => {
        const faltam = base.filter(x => !x.passos.find(p => p.id === pp.id)?.ok);
        return `<tr><td><b>${h(pp.titulo)}</b></td><td><span class="ob-nivel ${pp.nivel}">${pp.nivel}</span></td><td class="n">${faltam.length}</td>
          <td><div class="ob-quem">${faltam.slice(0, 8).map(x => `<button type="button" onclick="window._obIr('${h(x.id)}', '${h(pp.tela)}')">${h(x.nome)}</button>`).join('')}${faltam.length > 8 ? `<span class="ob-sub">e mais ${faltam.length - 8}</span>` : ''}${!faltam.length ? '<span class="ob-sub" style="color:var(--green)">todos prontos</span>' : ''}</div></td></tr>`;
      }).join('')}</tbody></table></div></div>`;
  }

  window._obAba = k => { st.aba = k; render(); };
  window._obAbrir = id => { st.abertos.has(id) ? st.abertos.delete(id) : st.abertos.add(id); render(); };
  window._obIr = (id, tela) => { GLR.ctx?.definir(id, true); Router.navigate(tela, tela === 'cliente-perfil' ? { id } : {}); };
  window._obVerificar = async () => {
    if (st.verificando) return;
    st.verificando = true; render();
    try {
      const r = await window.glrApiFetch('/api/agente-cron?rodada=onboarding&agora=1');
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      await carregar();
    } catch (e) { alert('Não consegui verificar: ' + (e.message || e)); }
    st.verificando = false; render();
  };

  el.innerHTML = `<div class="page">
    <div class="ajuda">O que falta para cada cliente gerar venda e comissão: contas conectadas, vendas chegando na base, comissão, meta, custos, agente de ADS e o resto do checklist de entrada. Cliente novo fica aqui nos primeiros 60 dias; se um passo essencial ficar parado mais de 3 dias, ele vai para a Caixa de decisões.</div>
    <div id="ob-root"></div>
  </div>
  <style>
    .ob-sub{font-size:12px;color:var(--text-muted);line-height:1.45}
    .ob-vazio{padding:28px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:4px} .ob-vazio span{font-size:13px;color:var(--text-muted)}
    .ob-topo{display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:12px}
    .ob-num{display:flex;flex-direction:column} .ob-num b{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1;color:var(--c,var(--text-primary))} .ob-num span{font-size:12px;color:var(--text-muted)}
    .ob-abas{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
    .ob-aba{border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
    .ob-aba b{color:var(--text-primary);font-weight:650;margin-left:2px} .ob-aba.on{border-color:var(--accent);background:var(--accent-glow);color:var(--accent-light)}
    .ob-lista{display:flex;flex-direction:column;gap:10px}
    .ob-c{padding:0;overflow:hidden;border-left:3px solid var(--c)}
    .ob-c-cab{display:grid;grid-template-columns:minmax(160px,1fr) 140px 44px minmax(0,2fr);gap:14px;align-items:center;width:100%;padding:12px 16px;border:0;background:none;cursor:pointer;text-align:left;font-family:inherit;color:var(--text-primary)}
    .ob-c-cab:hover{background:var(--bg-subtle)} .ob-c-cab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
    .ob-c-nome{display:flex;flex-direction:column;min-width:0} .ob-c-nome b{font-size:14.5px;font-weight:650}
    .ob-barra{height:6px;border-radius:99px;background:var(--bg-subtle);overflow:hidden} .ob-barra span{display:block;height:100%;background:var(--c);border-radius:99px}
    .ob-pct{font-size:13px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--c)}
    .ob-falta{display:flex;gap:5px;flex-wrap:wrap} .ob-falta span{font-size:11.5px;color:var(--text-secondary);background:var(--bg-subtle);border-radius:6px;padding:2px 7px}
    .ob-falta span.ess{color:var(--red);background:color-mix(in srgb,var(--red) 10%,transparent);font-weight:600} .ob-falta span.ok{color:var(--green);background:color-mix(in srgb,var(--green) 10%,transparent)}
    .ob-det{border-top:1px solid var(--border);background:var(--bg-subtle);padding:4px 16px 12px}
    .ob-tit{font-size:12px;font-weight:650;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em;margin:12px 0 6px}
    .ob-p{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:10px;align-items:start;padding:8px 0;border-top:1px solid var(--border)}
    .ob-check{width:18px;height:18px;border-radius:50%;border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;margin-top:1px}
    .ob-p.feito .ob-check{background:var(--green);border-color:var(--green);color:#fff}
    .ob-p-txt{display:flex;flex-direction:column;gap:1px;font-size:13px;line-height:1.45} .ob-p-txt b{font-weight:600} .ob-p-txt span{color:var(--text-muted);font-size:12.5px}
    .ob-p.feito .ob-p-txt b{color:var(--text-secondary)} .ob-acao{color:var(--text-secondary) !important}
    .ob-tab{width:100%;border-collapse:collapse;font-size:13px}
    .ob-tab th{padding:9px 12px;text-align:left;font-size:11.5px;font-weight:600;color:var(--text-muted);background:var(--bg-card-hover);white-space:nowrap}
    .ob-tab td{padding:9px 12px;border-top:1px solid var(--border);vertical-align:top} .ob-tab .n{text-align:right;font-variant-numeric:tabular-nums;font-weight:650}
    .ob-nivel{font-size:11px;font-weight:650;border-radius:99px;padding:1px 8px} .ob-nivel.essencial{color:var(--red);background:color-mix(in srgb,var(--red) 10%,transparent)} .ob-nivel.importante{color:#d98b00;background:color-mix(in srgb,#d98b00 12%,transparent)} .ob-nivel.complementar{color:var(--text-muted);background:var(--bg-subtle)}
    .ob-quem{display:flex;gap:5px;flex-wrap:wrap} .ob-quem button{border:1px solid var(--border);background:var(--bg-surface);border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer;font-family:inherit;color:var(--text-secondary)} .ob-quem button:hover{border-color:var(--accent);color:var(--accent)}
    @media (max-width:900px){.ob-c-cab{grid-template-columns:minmax(0,1fr) 44px}.ob-barra{grid-column:1/-1;order:3}.ob-falta{grid-column:1/-1;order:4}}
  </style>`;
  carregar();
});
