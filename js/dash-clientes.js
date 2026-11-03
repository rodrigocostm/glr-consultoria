// ============================================================
// GLR Consultoria — Dashboard: clientes em cards
// ------------------------------------------------------------
// Um card por cliente com a projeção do mês (contra a meta), o ADS do mês com o
// TACOS e se está crescendo ou caindo: últimos 7 dias contra os 7 anteriores
// (firme mesmo no começo do mês) e a projeção contra o mês passado fechado.
// Projeção do mês = realizado até ontem + ritmo dos últimos 7 dias × dias que
// faltam — a mesma regra da Receita GLR do Adviser (api/_adviser-revenue.js).
// Também preenche os indicadores do topo do Dashboard: "Projeção do mês" (soma
// destes cards) e "Receita GLR" (a mesma do Adviser, /api/adviser).
// Fonte: a base automática (BaseDados), a mesma das telas Gestores e
// Rentabilidade. Filtros por gestor e por tendência; o cliente em foco do topo
// também filtra. Montado pelo Dashboard (js/pages-dashboard.js).
// ============================================================
window.GLRDashClientes = (function () {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const R0 = v => 'R$ ' + Math.round(parseFloat(v) || 0).toLocaleString('pt-BR');
  const pct = v => v == null || !isFinite(v) ? '—' : `${(Math.round(v * 10) / 10).toLocaleString('pt-BR')}%`;
  const lerLS = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
  const gravarLS = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const pad2 = n => String(n).padStart(2, '0');
  const isoD = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const diaMais = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const POR_PAGINA = 12;
  const st = { el: null, base: null, erro: null, gestor: lerLS('glr_dashcli_gestor', 'todos'), tend: 'todos', ordem: lerLS('glr_dashcli_ordem', 'projecao'), todos: false };

  function calcular() {
    const ontem = diaMais(new Date(), -1), oIso = isoD(ontem);
    const mesIni = isoD(new Date(ontem.getFullYear(), ontem.getMonth(), 1)), dd = ontem.getDate(), dm = new Date(ontem.getFullYear(), ontem.getMonth() + 1, 0).getDate();
    const a7de = isoD(diaMais(ontem, -6)), b7de = isoD(diaMais(ontem, -13)), b7ate = isoD(diaMais(ontem, -7));
    const m1 = new Date(ontem.getFullYear(), ontem.getMonth() - 1, 1), m1de = isoD(m1), m1ate = isoD(new Date(m1.getFullYear(), m1.getMonth() + 1, 0));
    const vinc = lerJSON('glr_mc_vinculos', {}), metas = lerJSON('glr_metas', {});
    const gest = id => (GLR.gestores || []).find(g => String(g.id) === String(id));
    const out = [];
    for (const c of (GLR.clientes || [])) {
      if (/inativ|cancel|encerr/i.test(String(c.status || ''))) continue;
      const r = { mtd: 0, adsMtd: 0, temAds: false, a7: 0, b7: 0, ads7: 0, m1: 0, temM1: false, tem7: false, serie: {}, cob: 0, ritmo: 0 };
      for (const ct of (vinc[String(c.id)] || [])) {
        const mkt = BaseDados.mktDe(ct.marketplace), id = String(ct.param_to_use?.shopId || ct.param_to_use?.meliUserId || ct.contaId || ct.external_id);
        const info = mkt ? st.base[BaseDados.chave(mkt, id)] : null;
        if (!info || !BaseDados.cobre(info, b7de < mesIni ? b7de : mesIni)) continue;
        r.cob++;
        const mtd = BaseDados.somar(info, mesIni, oIso), a7 = BaseDados.somar(info, a7de, oIso), b7 = BaseDados.somar(info, b7de, b7ate);
        r.mtd += mtd.faturamento; r.a7 += a7.faturamento; r.b7 += b7.faturamento; r.tem7 = true;
        r.ritmo += BaseDados.cobre(info, a7de) ? a7.faturamento / 7 : mtd.faturamento / dd; // venda/dia para os dias que faltam
        if (BaseDados.cobreAds(info, mesIni)) { r.adsMtd += mtd.ads; r.temAds = true; }
        if (BaseDados.cobreAds(info, a7de)) r.ads7 += a7.ads;
        if (BaseDados.cobre(info, m1de)) { r.m1 += BaseDados.somar(info, m1de, m1ate).faturamento; r.temM1 = true; }
        for (let i = 13; i >= 0; i--) { const d = isoD(diaMais(ontem, -i)); r.serie[d] = (r.serie[d] || 0) + (parseFloat(info.dias?.[d]?.faturamento) || 0); }
      }
      if (!r.cob || (r.mtd <= 0 && r.a7 <= 0)) continue;
      const proj = r.mtd + r.ritmo * (dm - dd); // realizado + ritmo de 7 dias nos dias que faltam
      const inicio = dd < 3; // começo do mês: o TACOS sai dos últimos 7 dias (o mês ainda tem 1–2 dias)
      const fatT = inicio ? r.a7 : r.mtd, adsT = inicio ? r.ads7 : r.adsMtd;
      const meta = parseFloat(metas[c.id]) || parseFloat(c.metaMensal) || 0;
      const t7 = r.b7 > 0 ? (r.a7 / r.b7 - 1) * 100 : null;
      const g = gest(c.gestorId);
      out.push({ id: String(c.id), nome: c.nome, gestorId: g ? String(g.id) : 'sem', gestor: g?.nome || c.gestor || 'Sem gestor',
        proj, m1: r.temM1 ? r.m1 : 0, meta, pctMeta: meta > 0 ? proj / meta * 100 : null, ads: r.temAds || inicio ? adsT : null, tacos: (r.temAds || inicio) && fatT > 0 ? adsT / fatT * 100 : null,
        t7, vsM1: r.temM1 && r.m1 > 0 ? (proj / r.m1 - 1) * 100 : null, tend: t7 == null ? 'sem' : t7 >= 5 ? 'cresce' : t7 <= -5 ? 'cai' : 'estavel', serie: Object.values(r.serie), adsLabel: inicio ? 'ADS 7 dias' : 'ADS do mês' });
    }
    return out;
  }

  function spark(vals, cor) {
    const max = Math.max(1, ...vals), w = 120, hh = 32, n = vals.length;
    const pts = vals.map((v, i) => `${(i / (n - 1) * w).toFixed(1)},${(hh - 2 - v / max * (hh - 4)).toFixed(1)}`).join(' ');
    return `<svg class="dc-spark" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${cor}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  const TEND = { cresce: ['Crescendo', 'var(--green)', '▲'], estavel: ['Estável', 'var(--text-muted)', '■'], cai: ['Caindo', 'var(--red)', '▼'], sem: ['Sem comparação', 'var(--text-muted)', '·'] };
  function card(x) {
    const T = TEND[x.tend], pm = x.pctMeta != null ? Math.min(100, x.pctMeta) : null;
    const corMeta = x.pctMeta == null ? 'var(--accent)' : x.pctMeta >= 100 ? 'var(--green)' : x.pctMeta >= 85 ? '#d98b00' : 'var(--red)';
    return `<button type="button" class="dc-card" style="--t:${T[1]}" onclick="GLR.ctx?.definir('${h(x.id)}', true); Router.navigate('cliente-perfil', { id: ${JSON.stringify(x.id)} })">
      <div class="dc-top"><div><b>${h(x.nome)}</b><span>${h(x.gestor)}</span></div><span class="dc-tend" title="Últimos 7 dias contra os 7 anteriores">${T[2]} ${x.t7 != null ? `${x.t7 > 0 ? '+' : ''}${pct(x.t7)}` : T[0]}</span></div>
      <div class="dc-proj"><span>Projeção do mês</span><b>${R0(x.proj)}</b>
        <small>${x.pctMeta != null ? `<b style="color:${corMeta}">${pct(x.pctMeta)}</b> da meta de ${R0(x.meta)}` : 'sem meta'}${x.vsM1 != null ? ` · <span style="color:${x.vsM1 >= 0 ? 'var(--green)' : 'var(--red)'}">${x.vsM1 >= 0 ? '+' : ''}${pct(x.vsM1)}</span> vs mês passado` : ''}</small></div>
      ${pm != null ? `<div class="dc-bar"><i style="width:${pm}%;background:${corMeta}"></i></div>` : ''}
      <div class="dc-rod"><div><span>${x.adsLabel}</span><b>${x.ads != null ? R0(x.ads) : '—'}</b><small>TACOS ${pct(x.tacos)}</small></div>${spark(x.serie, x.tend === 'cai' ? 'var(--red)' : x.tend === 'cresce' ? 'var(--green)' : 'var(--accent)')}</div>
    </button>`;
  }

  // indicadores do topo do Dashboard com os mesmos números (carteira inteira)
  function kpisTopo(todos) {
    const k = document.getElementById('dash-kpi-proj'); if (!k || typeof kpiCard !== 'function') return;
    const tot = todos.reduce((s, x) => s + x.proj, 0), comMeta = todos.filter(x => x.meta > 0), comM1 = todos.filter(x => x.m1 > 0);
    const pm = comMeta.length ? comMeta.reduce((s, x) => s + x.proj, 0) / comMeta.reduce((s, x) => s + x.meta, 0) * 100 : null;
    const vs = comM1.length ? (comM1.reduce((s, x) => s + x.proj, 0) / comM1.reduce((s, x) => s + x.m1, 0) - 1) * 100 : null;
    k.innerHTML = kpiCard('Projeção do mês', GLR.formatCurrency(tot), [vs != null ? `${vs >= 0 ? '+' : ''}${vs.toFixed(1).replace('.', ',')}% vs mês anterior` : '', pm != null ? `${Math.round(pm)}% da meta (${comMeta.length} com meta)` : ''].filter(Boolean).join(' · '), vs == null || vs >= 0, '', '🏆', '', false, vs == null ? 'neutro' : '');
  }
  let receitaEm = 0, receitaDados = null;
  async function receitaTopo() {
    const k = document.getElementById('dash-kpi-receita'); if (!k || typeof kpiCard !== 'function') return;
    const pinta = j => { const rc = j?.receita; if (!rc || rc.projetada == null) return; k.innerHTML = kpiCard('Receita GLR', GLR.formatCurrency(rc.base || 0), `projeção ${GLR.formatCurrency(rc.projetada)} · base até ${rc.dias || 0} dia(s) encerrado(s)${rc.parcial ? " · cobertura parcial" : ""} · ${Math.round(rc.projetada / 2000)}% dos R$ 200 mil`, true, '', '💰', '', false, 'neutro'); };
    if (receitaDados && Date.now() - receitaEm < 120000) return pinta(receitaDados);
    try {
      const mes = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(new Date());
      const r = await window.glrApiFetch(`/api/adviser?mes=${mes}`); if (!r.ok) return;
      receitaDados = await r.json(); receitaEm = Date.now(); pinta(receitaDados);
    } catch (e) {}
  }

  function render() {
    const el = st.el; if (!el || !el.isConnected) return;
    if (st.erro) { el.innerHTML = `<div class="card dc-vazio" style="color:var(--red)">Não consegui carregar os clientes: ${h(st.erro)}</div>`; return; }
    if (!st.base) { el.innerHTML = '<div class="card dc-vazio">Carregando os clientes…</div>'; return; }
    const foco = GLR.ctx?.cliente();
    const carteira = calcular(); kpisTopo(carteira);
    const todos = carteira.filter(x => !foco || x.id === String(foco));
    const doGestor = todos.filter(x => st.gestor === 'todos' || x.gestorId === st.gestor);
    const ORD = { projecao: (a, b) => b.proj - a.proj, queda: (a, b) => (a.t7 ?? 999) - (b.t7 ?? 999), alta: (a, b) => (b.t7 ?? -999) - (a.t7 ?? -999), tacos: (a, b) => (b.tacos ?? -1) - (a.tacos ?? -1), meta: (a, b) => (a.pctMeta ?? 999) - (b.pctMeta ?? 999) };
    const ls = doGestor.filter(x => st.tend === 'todos' || x.tend === st.tend).sort(ORD[st.ordem] || ORD.projecao);
    const n = k => doGestor.filter(x => x.tend === k).length;
    const gestores = [...new Map(todos.map(x => [x.gestorId, x.gestor])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const vis = st.todos ? ls : ls.slice(0, POR_PAGINA);
    el.innerHTML = `<div class="card dc">
      <div class="section-header dc-cab">
        <div><div class="section-title">Clientes</div><div class="section-subtitle">Projeção do mês, ADS e tendência — últimos 7 dias contra os 7 anteriores</div></div>
        <div class="dc-ctrl">
          <select class="form-control" aria-label="Gestor" onchange="GLRDashClientes.gestor(this.value)"><option value="todos">Todos os gestores</option>${gestores.map(([id, nome]) => `<option value="${h(id)}" ${st.gestor === id ? 'selected' : ''}>${h(nome)}</option>`).join('')}</select>
          <select class="form-control" aria-label="Ordenar" onchange="GLRDashClientes.ordem(this.value)">${[['projecao', 'Maior projeção'], ['queda', 'Mais caindo'], ['alta', 'Mais crescendo'], ['meta', 'Mais longe da meta'], ['tacos', 'Maior TACOS']].map(([k, t]) => `<option value="${k}" ${st.ordem === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>
      </div>
      <div class="dc-chips">${[['todos', 'Todos', doGestor.length], ['cresce', 'Crescendo', n('cresce')], ['estavel', 'Estáveis', n('estavel')], ['cai', 'Caindo', n('cai')]].map(([k, t, q]) => `<button class="${st.tend === k ? 'on' : ''} ${k}" onclick="GLRDashClientes.tend('${k}')">${t} <b>${q}</b></button>`).join('')}</div>
      ${vis.length ? `<div class="dc-grade">${vis.map(card).join('')}</div>` : '<div class="dc-vazio">Nenhum cliente neste filtro.</div>'}
      ${ls.length > POR_PAGINA ? `<button class="dc-mais" onclick="GLRDashClientes.verTodos()">${st.todos ? 'Mostrar menos' : `Ver todos os ${ls.length} clientes`}</button>` : ''}
    </div>`;
  }

  async function montar(el, forcar) {
    st.el = el; if (!el) return;
    if (!document.getElementById('dc-css')) document.head.insertAdjacentHTML('beforeend', `<style id="dc-css">
      .dc{margin-bottom:16px} .dc-cab{flex-wrap:wrap;gap:10px} .dc-ctrl{display:flex;gap:8px;flex-wrap:wrap} .dc-ctrl select{width:auto;max-width:200px}
      .dc-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
      .dc-chips button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
      .dc-chips button b{color:var(--text-primary);margin-left:2px} .dc-chips button.on{border-color:var(--accent);background:var(--accent-glow);color:var(--accent-light)}
      .dc-chips button.cresce b{color:var(--green)} .dc-chips button.cai b{color:var(--red)}
      .dc-grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
      .dc-card{all:unset;box-sizing:border-box;cursor:pointer;display:flex;flex-direction:column;gap:9px;padding:13px 15px;border-radius:12px;border:1px solid var(--border);background:var(--bg-surface,var(--bg-card));box-shadow:inset 0 3px 0 var(--t)}
      .dc-card:hover{border-color:color-mix(in srgb,var(--t) 45%,var(--border))} .dc-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
      .dc-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start} .dc-top>div{display:flex;flex-direction:column;min-width:0} .dc-top b{font-size:14px;font-weight:650;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .dc-top span{font-size:11.5px;color:var(--text-muted)}
      .dc-tend{font-size:12px !important;font-weight:700;color:var(--t) !important;white-space:nowrap;background:color-mix(in srgb,var(--t) 12%,transparent);border-radius:99px;padding:2px 8px;font-variant-numeric:tabular-nums}
      .dc-proj{display:flex;flex-direction:column;gap:1px} .dc-proj span{font-size:11px;color:var(--text-muted)} .dc-proj>b{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text-primary)} .dc-proj small{font-size:11.5px;color:var(--text-muted)}
      .dc-bar{height:5px;border-radius:99px;background:var(--bg-subtle);overflow:hidden} .dc-bar i{display:block;height:100%;border-radius:99px}
      .dc-rod{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;padding-top:8px;border-top:1px solid var(--border)}
      .dc-rod>div{display:flex;flex-direction:column} .dc-rod span{font-size:11px;color:var(--text-muted)} .dc-rod b{font-size:14px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--text-primary)} .dc-rod small{font-size:11px;color:var(--text-muted)}
      .dc-spark{width:120px;height:32px;flex:none}
      .dc-vazio{padding:22px;text-align:center;font-size:13px;color:var(--text-muted)}
      .dc-mais{display:block;margin:12px auto 0;border:0;background:none;color:var(--accent);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
    </style>`);
    render(); receitaTopo();
    try { st.base = await BaseDados.carregar(forcar); st.erro = null; } catch (e) { st.erro = e.message || String(e); }
    GLR.quandoClientes(render);
  }

  return {
    montar,
    gestor: v => { st.gestor = v; gravarLS('glr_dashcli_gestor', v); render(); },
    ordem: v => { st.ordem = v; gravarLS('glr_dashcli_ordem', v); render(); },
    tend: v => { st.tend = v; render(); },
    verTodos: () => { st.todos = !st.todos; render(); },
  };
})();
