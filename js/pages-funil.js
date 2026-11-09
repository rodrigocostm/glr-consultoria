// ============================================================
// GLR Consultoria — Funil de vendas (interno)
// ------------------------------------------------------------
// O fluxo de venda de um dia, etapa por etapa, comparado com o dia anterior:
//   Impressões → Cliques → Visitas → Carrinho → Vendas
// e as taxas de passagem entre elas (CTR, conversão), da carteira, de um
// cliente ou de uma conta. Fontes (base automática, só leitura):
//  • impressões e cliques: anúncios pagos (glr_ads_diario — ML e Shopee);
//  • visitas: Mercado Livre, loja inteira (glr_sync_estado 'funil', 1x/dia);
//  • carrinho: Shopee e Mercado Livre não informam pela API (etapa sinalizada);
//  • vendas: resumo diário por loja da base (BaseDados — o mesmo do Dashboard:
//    pedidos e faturamento válidos) e as atribuídas ao ADS.
// Por padrão mostra ONTEM (dia fechado) × anteontem.
// ============================================================
Router.register('funil', (params, el) => {
  // mora dentro da tela Vendas (aba "Funil de vendas"); quem abre a rota direto vai para lá
  if (el.id !== 'sec-funil') { Router.navigate('vendas', { aba: 'funil' }); return; }
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const N = v => v == null ? '—' : Math.round(v).toLocaleString('pt-BR');
  const R$ = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const P = (v, c = 1) => v == null || !isFinite(v) ? '—' : `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c })}%`;
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (e) { return d; } };
  const isoBRT = (diasAtras = 0) => new Date(Date.now() - 3 * 3600e3 - diasAtras * 864e5).toISOString().slice(0, 10);
  const menos1 = iso => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
  const diaTxt = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).replace('.', '');
  const MKT = { ml: 'Mercado Livre', shopee: 'Shopee' };

  const salvo = lerJSON('glr_funil_sel', {});
  const st = { dia: salvo.dia && salvo.dia < isoBRT(0) && salvo.dia >= isoBRT(27) ? salvo.dia : isoBRT(1), mkt: salvo.mkt || 'todos', cliente: (typeof GLR !== 'undefined' && GLR.ctx?.cliente()) || salvo.cliente || '', conta: salvo.conta || '', dados: null, carregando: true, erro: null };
  window._fnSt = st;
  const guardar = () => { try { localStorage.setItem('glr_funil_sel', JSON.stringify({ dia: st.dia, mkt: st.mkt, cliente: st.cliente, conta: st.conta })); } catch (e) {} };

  // contas da carteira (ML e Shopee): "ml:123" → { cli, mkt, id, nome }
  function carteira() {
    const vinc = lerJSON('glr_mc_vinculos', {}), clientes = new Map((GLR.clientes || []).map(c => [String(c.id), c]));
    const m = new Map();
    for (const [cid, arr] of Object.entries(vinc)) {
      const cli = clientes.get(String(cid)); if (!cli) continue;
      for (const ct of arr || []) {
        const mkt = BaseDados.mktDe(ct.marketplace); if (mkt !== 'ml' && mkt !== 'shopee') continue;
        const id = String(ct.param_to_use?.shopId || ct.param_to_use?.meliUserId || ct.external_id);
        m.set(`${mkt}:${id}`, { cli, mkt, id, nome: GLR.nomeConta?.(mkt, id) || ct.tags?.[0]?.name || id });
      }
    }
    return m;
  }

  async function carregar() {
    st.carregando = true; render();
    const d0 = st.dia, d1 = menos1(d0);
    try {
      // vendas: resumo diário por loja (vw_vendas_dia agrega a tabela inteira e estoura o tempo do banco)
      const [ads, base, fun] = await Promise.all([
        _sb.from('glr_ads_diario').select('marketplace,conta_id,data,impressoes,cliques,pedidos_ads,gmv_ads,gasto').in('data', [d0, d1]),
        BaseDados.carregar(),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,conta:cursor->conta').eq('recurso', 'funil').eq('marketplace', 'ml'),
      ]);
      const erro = ads.error || fun.error; if (erro) throw erro;
      const vendas = [];
      for (const [k, info] of Object.entries(base || {})) {
        const [marketplace, conta_id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
        for (const dia of [d0, d1]) { const v = info.dias?.[dia]; if (v) vendas.push({ marketplace, conta_id, dia, pedidos_validos: +v.pedidos || 0, faturamento_valido: +v.faturamento || 0 }); }
      }
      st.dados = { d0, d1, ads: ads.data || [], vendas, visitas: fun.data || [] };
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  // soma as etapas de um dia para o conjunto de contas escolhido
  function etapas(dia, contas) {
    const ok = (m, id) => contas.has(`${m}:${id}`);
    const e = { imp: 0, cli: 0, pedAds: 0, gmvAds: 0, gasto: 0, vis: null, visPed: 0, ped: 0, fat: 0, temAds: false };
    for (const a of st.dados.ads) if (a.data === dia && ok(a.marketplace, a.conta_id)) { e.imp += +a.impressoes || 0; e.cli += +a.cliques || 0; e.pedAds += +a.pedidos_ads || 0; e.gmvAds += +a.gmv_ads || 0; e.gasto += +a.gasto || 0; e.temAds = true; }
    for (const v of st.dados.vendas) if (String(v.dia).slice(0, 10) === dia && ok(v.marketplace, v.conta_id)) { e.ped += +v.pedidos_validos || 0; e.fat += +v.faturamento_valido || 0; }
    for (const f of st.dados.visitas) {
      if (!ok('ml', f.conta_id)) continue;
      const n = f.conta?.[dia]; if (n == null) continue;
      e.vis = (e.vis || 0) + (+n || 0);
      e.visPed += st.dados.vendas.filter(v => v.marketplace === 'ml' && String(v.conta_id) === String(f.conta_id) && String(v.dia).slice(0, 10) === dia).reduce((s, v) => s + (+v.pedidos_validos || 0), 0);
    }
    return e;
  }
  const varia = (a, b) => a == null || b == null || !b ? null : (a - b) / b;
  const chip = (v, inverso) => {
    if (v == null) return '<span class="fn-var fn-neutro">sem comparação</span>';
    const bom = inverso ? v < 0 : v > 0, txt = `${v > 0 ? '▲' : v < 0 ? '▼' : '='} ${Math.abs(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
    return `<span class="fn-var ${Math.abs(v) < 0.005 ? 'fn-neutro' : bom ? 'fn-bom' : 'fn-ruim'}">${txt}</span>`;
  };

  function render() {
    if (window._fnSt !== st) return;
    const root = document.getElementById('fn-root'); if (!root) return;
    const todas = carteira();
    const clientes = [...new Map([...todas.values()].map(c => [String(c.cli.id), c.cli])).values()].sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
    const doCli = [...todas.entries()].filter(([, c]) => (!st.cliente || String(c.cli.id) === st.cliente) && (st.mkt === 'todos' || c.mkt === st.mkt));
    if (st.conta && !doCli.some(([k]) => k === st.conta)) st.conta = '';
    const sel = new Set(st.conta ? [st.conta] : doCli.map(([k]) => k));
    const filtros = `<div class="fn-filtros">
      <label>Cliente <select id="fn-cli" class="form-control" onchange="window._fnSet('cliente', this.value)"><option value="">Toda a carteira</option>${clientes.map(c => `<option value="${h(c.id)}" ${String(c.id) === st.cliente ? 'selected' : ''}>${h(c.nome)}</option>`).join('')}</select></label>
      <label>Plataforma <select id="fn-mkt" class="form-control" onchange="window._fnSet('mkt', this.value)">${[['todos', 'ML e Shopee'], ['ml', 'Mercado Livre'], ['shopee', 'Shopee']].map(([k, t]) => `<option value="${k}" ${st.mkt === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      ${st.cliente ? `<label>Conta <select id="fn-conta" class="form-control" onchange="window._fnSet('conta', this.value)"><option value="">Todas do cliente</option>${doCli.map(([k, c]) => `<option value="${h(k)}" ${k === st.conta ? 'selected' : ''}>${h(c.nome)} · ${MKT[c.mkt]}</option>`).join('')}</select></label>` : ''}
      <label>Dia <input id="fn-dia" type="date" class="form-control" value="${st.dia}" min="${isoBRT(27)}" max="${isoBRT(1)}" onchange="window._fnSet('dia', this.value)"></label>
    </div>`;
    if (st.carregando && !st.dados) { root.innerHTML = filtros + '<div class="card fn-vazio">Carregando o funil…</div>'; return; }
    if (st.erro) { root.innerHTML = filtros + `<div class="card fn-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    if (!sel.size) { root.innerHTML = filtros + '<div class="card fn-vazio">Nenhuma conta do Mercado Livre ou da Shopee vinculada a este filtro.</div>'; return; }

    const a = etapas(st.dados.d0, sel), b = etapas(st.dados.d1, sel);
    const temML = [...sel].some(k => k.startsWith('ml:'));
    const ETAPAS = [
      { k: 'imp', nome: 'Impressões', fonte: 'anúncios pagos', va: a.temAds ? a.imp : null, vb: b.temAds ? b.imp : null },
      { k: 'cli', nome: 'Cliques', fonte: 'anúncios pagos', va: a.temAds ? a.cli : null, vb: b.temAds ? b.cli : null, taxa: ['CTR', a.imp ? a.cli / a.imp : null, b.imp ? b.cli / b.imp : null] },
      { k: 'vis', nome: 'Visitas', fonte: temML ? 'loja inteira no Mercado Livre' : 'a Shopee não informa visitas', va: a.vis, vb: b.vis, off: !temML || a.vis == null },
      { k: 'car', nome: 'Carrinho', fonte: 'Shopee e Mercado Livre não informam pela API', va: null, vb: null, off: true },
      { k: 'ven', nome: 'Vendas', fonte: `${R$(a.fat)} faturados`, va: a.ped, vb: b.ped, sub: `${N(a.pedAds)} pelo ADS (${R$(a.gmvAds)})`, taxa: ['Conversão do clique', a.cli ? a.pedAds / a.cli : null, b.cli ? b.pedAds / b.cli : null], taxa2: a.vis ? ['Visita → venda (ML)', a.visPed / a.vis, b.vis ? b.visPed / b.vis : null] : null },
    ];
    const maxLog = Math.log10(Math.max(10, ...ETAPAS.map(e => e.va || 0)));
    const larg = v => v == null ? 34 : Math.max(22, Math.min(100, 22 + 78 * Math.log10(Math.max(1, v)) / maxLog));
    const taxaHtml = t => t ? `<div class="fn-taxa"><span>${t[0]}</span><b>${P(t[1], t[1] != null && t[1] < 0.01 ? 2 : 1)}</b><span class="fn-taxa-ant">${diaTxt(st.dados.d1)}: ${P(t[2], t[2] != null && t[2] < 0.01 ? 2 : 1)}</span>${chip(varia(t[1], t[2]))}</div>` : '';

    // por conta (para achar onde o funil quebrou)
    const linhas = [...sel].map(k => { const c = todas.get(k); const x = etapas(st.dados.d0, new Set([k])), y = etapas(st.dados.d1, new Set([k])); return { k, c, x, y }; })
      .filter(r => r.x.imp || r.x.ped || r.y.ped).sort((p, q) => q.x.fat - p.x.fat);

    root.innerHTML = filtros + `
      <div class="fn-cab"><b>${diaTxt(st.dados.d0)}</b> comparado com <b>${diaTxt(st.dados.d1)}</b> · ${sel.size} conta(s)${a.gasto ? ` · ADS investido ${R$(a.gasto)} ${chip(varia(a.gasto, b.gasto), true)}` : ''}</div>
      <section class="card fn-funil" aria-label="Funil de vendas">
        ${ETAPAS.map(e => `
          ${taxaHtml(e.taxa)}${e.taxa2 ? taxaHtml(e.taxa2) : ''}
          <div class="fn-etapa${e.off ? ' fn-off' : ''}">
            <div class="fn-rot"><span class="fn-nome">${e.nome}</span><span class="fn-fonte">${h(e.fonte)}</span></div>
            <div class="fn-barra-wrap"><div class="fn-barra fn-${e.k}" style="width:${larg(e.va)}%"><span>${e.off ? 'indisponível' : N(e.va)}</span></div></div>
            <div class="fn-comp">${e.off ? '' : `<span class="fn-ant">${diaTxt(st.dados.d1)}: ${N(e.vb)}</span>${chip(varia(e.va, e.vb))}`}${e.sub ? `<span class="fn-sub">${h(e.sub)}</span>` : ''}</div>
          </div>`).join('')}
      </section>
      ${linhas.length > 1 ? `<section class="card fn-tab-wrap"><h3>Por conta</h3><div class="fn-tab-scroll"><table class="fn-tab"><thead><tr><th>Conta</th><th>Impressões</th><th>Cliques</th><th>CTR</th><th>Visitas</th><th>Vendas</th><th>vs dia anterior</th><th>Conv. do clique</th></tr></thead><tbody>
        ${linhas.map(r => `<tr><td><b>${h(r.c.nome)}</b><span>${h(r.c.cli.nome)} · ${MKT[r.c.mkt]}</span></td><td>${N(r.x.imp)}</td><td>${N(r.x.cli)}</td><td>${P(r.x.imp ? r.x.cli / r.x.imp : null, 2)}</td><td>${r.c.mkt === 'ml' ? N(r.x.vis) : '—'}</td><td>${N(r.x.ped)}</td><td>${chip(varia(r.x.ped, r.y.ped))}</td><td>${P(r.x.cli ? r.x.pedAds / r.x.cli : null, 2)}</td></tr>`).join('')}
      </tbody></table></div></section>` : ''}
      <p class="fn-nota">Impressões e cliques são dos anúncios pagos (o orgânico não é informado pelas plataformas). Visitas: só Mercado Livre, atualizadas 1x por dia. Carrinho: nem a Shopee nem o Mercado Livre entregam esse número pela API; ele aparece só no painel de cada plataforma.</p>`;
  }

  window._fnSet = (k, v) => {
    st[k] = v;
    if (k === 'cliente') { st.conta = ''; if (GLR.ctx) GLR.ctx.definir(v, true); }
    guardar();
    if (k === 'dia') carregar(); else render();
  };

  el.innerHTML = `<div class="fn-wrap">
    <header class="fn-head"><h2>Funil de vendas</h2><p>O caminho da venda num dia — de quem viu o anúncio até quem comprou — e onde ele melhorou ou piorou em relação ao dia anterior.</p></header>
    <div id="fn-root"></div></div>
  <style>
    .fn-wrap{padding:24px;max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
    .fn-head h2{margin:0 0 4px;font-size:20px} .fn-head p{margin:0;font-size:13px;color:var(--text-secondary);max-width:75ch}
    .fn-filtros{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px} .fn-filtros label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary);min-width:160px}
    .fn-cab{font-size:13px;color:var(--text-secondary);margin-bottom:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    .fn-funil{padding:22px 24px;display:flex;flex-direction:column;gap:6px}
    .fn-etapa{display:grid;grid-template-columns:170px 1fr 220px;gap:16px;align-items:center}
    .fn-rot{display:flex;flex-direction:column} .fn-nome{font-weight:700;font-size:15px} .fn-fonte{font-size:11.5px;color:var(--text-muted)}
    .fn-barra-wrap{display:flex;justify-content:center}
    .fn-barra{height:52px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;font-variant-numeric:tabular-nums;transition:width .4s ease;clip-path:polygon(0 0,100% 0,97% 100%,3% 100%)}
    .fn-imp{background:#1d4ed8}.fn-cli{background:#2563eb}.fn-vis{background:#0891b2}.fn-car{background:#64748b}.fn-ven{background:#059669}
    .fn-off .fn-barra{background:repeating-linear-gradient(135deg,var(--bg-subtle,#eef1f5) 0 8px,transparent 8px 16px);color:var(--text-muted);border:1px dashed var(--border);font-size:13px;font-weight:600;clip-path:none}
    .fn-off .fn-nome{color:var(--text-muted)}
    .fn-comp{display:flex;flex-direction:column;gap:3px;font-size:12.5px} .fn-ant{color:var(--text-secondary);font-variant-numeric:tabular-nums} .fn-sub{color:var(--text-secondary)}
    .fn-taxa{display:flex;gap:10px;align-items:center;justify-content:center;font-size:12.5px;color:var(--text-secondary);padding:2px 0} .fn-taxa b{color:var(--text-primary);font-variant-numeric:tabular-nums} .fn-taxa-ant{font-variant-numeric:tabular-nums}
    .fn-taxa::before{content:"↓";color:var(--text-muted)}
    .fn-var{display:inline-block;font-size:12px;font-weight:700;padding:1px 7px;border-radius:99px;width:max-content;font-variant-numeric:tabular-nums}
    .fn-bom{color:var(--green);background:color-mix(in srgb,var(--green) 12%,transparent)} .fn-ruim{color:var(--red);background:color-mix(in srgb,var(--red) 12%,transparent)} .fn-neutro{color:var(--text-muted);background:var(--bg-subtle,#eef1f5);font-weight:600}
    .fn-tab-wrap{padding:16px 18px} .fn-tab-wrap h3{margin:0 0 10px;font-size:15px} .fn-tab-scroll{overflow-x:auto}
    .fn-tab{width:100%;border-collapse:collapse;font-size:13px} .fn-tab th{text-align:right;font-size:11.5px;color:var(--text-secondary);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--border);white-space:nowrap}
    .fn-tab td{text-align:right;padding:8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;white-space:nowrap} .fn-tab th:first-child,.fn-tab td:first-child{text-align:left} .fn-tab td:first-child span{display:block;font-size:11.5px;color:var(--text-muted)}
    .fn-nota{font-size:12px;color:var(--text-muted);margin:0;max-width:90ch}
    .fn-vazio{padding:28px;text-align:center;color:var(--text-secondary)}
    @media (max-width:760px){.fn-wrap{padding:16px}.fn-etapa{grid-template-columns:1fr;gap:6px}.fn-barra-wrap{justify-content:flex-start}.fn-taxa{justify-content:flex-start;flex-wrap:wrap}}
  </style>`;
  render();
  GLR.quandoClientes(() => { render(); });
  carregar();
});
