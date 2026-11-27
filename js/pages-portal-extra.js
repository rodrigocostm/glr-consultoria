// ============================================================
// GLR Consultoria — Portal do cliente: ADS, Analítico, Reembolsos,
// Calculadora e Chat com IA
// ------------------------------------------------------------
// Tudo lê a base automática (BaseDados e glr_pedidos). No portal o banco só
// devolve as contas liberadas para o login do cliente (políticas portal_isolado);
// para a equipe, as telas usam o cliente em foco no topo.
//  • meus-ads        — visão geral do ADS (não é o agente)
//  • meu-analitico   — mês a mês (~3 meses da base), marketplace, dia da semana,
//                      ticket, cancelamentos e devoluções
//  • meus-reembolsos — produtos devolvidos/reembolsados no período, com a %
//  • calculadora     — a Calculadora GLR (calculadora.html) dentro do portal
//  • meu-chat        — conversa com a IA sobre as lojas (api/portal-chat.js),
//                      só quando a GLR libera o módulo (cfg.chatIA)
// ============================================================
(function () {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const R$ = v => v == null || !isFinite(v) ? '—' : 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const R0 = v => v == null || !isFinite(v) ? '—' : 'R$ ' + Math.round(+v).toLocaleString('pt-BR');
  const N = v => v == null || !isFinite(v) ? '—' : Math.round(+v).toLocaleString('pt-BR');
  const pct = (v, c = 1) => v == null || !isFinite(v) ? '—' : `${(+v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c })}%`;
  const roasX = v => v == null || !isFinite(v) ? '—' : `${(+v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x`;
  const hojeIso = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const somaDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dm = iso => iso.split('-').reverse().slice(0, 2).join('/');
  const MKT = { ml: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', tiktok: 'TikTok Shop', magalu: 'Magalu', shein: 'Shein' };
  const COR = { ml: '#d9a400', shopee: '#ee4d2d', amazon: '#ff9900', tiktok: '#06b6d4', magalu: '#0086ff', shein: '#6b7280' };
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const ehPortal = () => !!window._portalConfig;

  // Lojas que o usuário pode ver: portal = as contas do acesso; equipe = o cliente em foco
  // opc.carteira: equipe sem cliente em foco vê todas as lojas da base
  async function lojasDoAcesso(opc = {}) {
    const base = await BaseDados.carregar();
    const cfg = window._portalConfig;
    let alvos = null;
    if (cfg) alvos = new Set((cfg.contaIds || []).map(String));
    else {
      const cli = GLR.ctx?.cliente?.();
      if (!cli && !opc.carteira) return [];
      if (!cli) alvos = null;
      else {
      let vinc = {}; try { vinc = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch (e) {}
      alvos = new Set((vinc[String(cli)] || []).flatMap(c => [c.external_id, c.param_to_use?.shopId, c.param_to_use?.meliUserId, c.param_to_use?.amazon_account_id].filter(Boolean).map(String)));
      }
    }
    const nomes = Object.fromEntries(((cfg && cfg.contas) || []).map(c => [String(c.id), c.nome]));
    const lojas = [];
    for (const [k, info] of Object.entries(base || {})) {
      const mkt = k.slice(0, k.indexOf(':')), id = k.slice(k.indexOf(':') + 1);
      if (alvos && !alvos.has(id)) continue;
      const nome = nomes[id] || (!cfg && GLR.nomeConta ? String(GLR.nomeConta(mkt, id)).replace(alvos ? /^.*? · / : /^$/, '') : '') || `${MKT[mkt] || mkt} ${id.slice(-4)}`;
      lojas.push({ chave: k, mkt, id, nome, info });
    }
    return lojas;
  }
  const vazioSemCliente = () => `<div class="card px-vazio">Escolha um cliente no seletor do topo para ver esta tela.</div>`;
  const semCliente = () => !ehPortal() && !GLR.ctx?.cliente?.();

  // Gráfico de barras simples (SVG) — uma ou duas séries, com rótulo em cima
  function barras(itens, { fmt = N, cor = 'var(--accent)', cor2 = null, alt = 170 } = {}) {
    if (!itens.length) return '<div class="px-vazio">Sem dados.</div>';
    const max = Math.max(1, ...itens.flatMap(i => [i.v || 0, i.v2 || 0]));
    const W = Math.max(320, itens.length * 70), H = alt, B = 24, T = 18, bw = cor2 ? 18 : 30, col = (W - 40) / itens.length;
    const x = i => 20 + i * col + (col - (cor2 ? bw * 2 + 4 : bw)) / 2;
    const y = v => T + (H - T - B) * (1 - (v || 0) / max);
    return `<div class="px-graf"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="gráfico de barras">
      ${itens.map((it, i) => `
        <rect x="${x(i)}" y="${y(it.v)}" width="${bw}" height="${H - B - y(it.v)}" rx="3" fill="${it.cor || cor}"><title>${h(it.rot)}: ${h(fmt(it.v))}</title></rect>
        <text x="${x(i) + bw / 2}" y="${y(it.v) - 4}" text-anchor="middle" class="px-gt">${h(fmt(it.v))}</text>
        ${cor2 ? `<rect x="${x(i) + bw + 4}" y="${y(it.v2)}" width="${bw}" height="${H - B - y(it.v2)}" rx="3" fill="${cor2}"><title>${h(it.rot)}: ${h(fmt(it.v2))}</title></rect>` : ''}
        <text x="${x(i) + (cor2 ? bw + 2 : bw / 2)}" y="${H - 6}" text-anchor="middle" class="px-gx">${h(it.rot)}</text>`).join('')}
    </svg></div>`;
  }
  const kpi = (rot, val, sub, cor) => `<div class="px-kpi"><span>${rot}</span><b${cor ? ` style="color:${cor}"` : ''}>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const estilo = `<style>
    .px-head{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
    .px-head h1{margin:0;font-size:22px;font-weight:650;letter-spacing:-.02em} .px-head p{margin:4px 0 0;font-size:13px;color:var(--text-secondary);max-width:80ch}
    .px-per{display:flex;gap:6px;flex-wrap:wrap} .px-per button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font:inherit;font-size:12.5px;cursor:pointer}
    .px-per button.on{background:var(--text-primary);color:var(--bg-card);border-color:var(--text-primary)}
    .px-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px}
    .px-kpi{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px 16px;display:flex;flex-direction:column;gap:2px}
    .px-kpi span{font-size:12.5px;color:var(--text-secondary)} .px-kpi b{font-size:20px;font-variant-numeric:tabular-nums;color:var(--text-primary)} .px-kpi small{font-size:11.5px;color:var(--text-muted)}
    .px-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px;margin-bottom:14px}
    @media (max-width:640px){.px-grid{grid-template-columns:1fr}}
    .px-card{padding:16px 18px} .px-card h3{margin:0 0 2px;font-size:15px} .px-card .px-sub{font-size:12px;color:var(--text-muted);margin-bottom:8px}
    .px-graf{overflow-x:auto} .px-graf svg{width:100%;min-width:300px;height:auto;display:block}
    .px-gt{font-size:10.5px;fill:var(--text-secondary);font-variant-numeric:tabular-nums} .px-gx{font-size:11px;fill:var(--text-muted)}
    .px-tab-w{overflow-x:auto} .px-tab{width:100%;border-collapse:collapse;font-size:13px}
    .px-tab th{font-size:11.5px;font-weight:600;color:var(--text-secondary);text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
    .px-tab td{padding:8px 10px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums} .px-tab .num,.px-tab th.num{text-align:right}
    .px-tab tr:last-child td{border-bottom:none}
    .px-leg{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary);margin-bottom:6px} .px-leg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
    .px-barra{height:10px;border-radius:99px;background:var(--bg-subtle);overflow:hidden;display:flex} .px-barra i{display:block;height:100%}
    .px-vazio{padding:28px;text-align:center;color:var(--text-secondary)} .px-nota{font-size:12px;color:var(--text-muted);margin:6px 0 0}
    .px-tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:99px;background:color-mix(in srgb,var(--c) 14%,transparent);color:var(--c)}
  </style>`;

  // ── ADS (visão geral) ─────────────────────────────────────────
  Router.register('meus-ads', async (params, el) => {
    const st = { per: (() => { try { return localStorage.getItem('glr_px_ads_per') || 'mes'; } catch (e) { return 'mes'; } })(), lojas: [] };
    el.innerHTML = `<div class="page px">${estilo}<div class="px-head"><div><h1>ADS</h1><p>Quanto foi investido em anúncios pagos, quanto eles venderam e quanto pesam no faturamento das suas lojas.</p></div><div class="px-per" id="px-per"></div></div><div id="px-root"><div class="card px-vazio">Carregando…</div></div></div>`;
    try { st.lojas = await lojasDoAcesso(); } catch (e) { el.querySelector('#px-root').innerHTML = `<div class="card px-vazio">Não consegui ler os dados: ${h(e.message)}</div>`; return; }
    function render() {
      const root = el.querySelector('#px-root'); if (!root) return;
      el.querySelector('#px-per').innerHTML = [['mes', 'Mês atual'], ['30', '30 dias'], ['7', '7 dias']].map(([k, t]) => `<button class="${st.per === k ? 'on' : ''}" onclick="window._pxAdsPer('${k}')">${t}</button>`).join('');
      if (semCliente()) { root.innerHTML = vazioSemCliente(); return; }
      if (!st.lojas.length) { root.innerHTML = '<div class="card px-vazio">Nenhuma loja com dados ainda.</div>'; return; }
      const ate = hojeIso(), de = st.per === 'mes' ? ate.slice(0, 8) + '01' : somaDias(ate, -(parseInt(st.per) - 1));
      const linhas = st.lojas.map(l => ({ ...l, t: BaseDados.somar(l.info, de, ate), comAds: BaseDados.cobreAds(l.info, de) }));
      const T = linhas.reduce((s, l) => ({ ads: s.ads + (l.comAds ? l.t.ads : 0), gmv: s.gmv + (l.comAds ? l.t.ads_gmv : 0), fat: s.fat + l.t.faturamento }), { ads: 0, gmv: 0, fat: 0 });
      const acos = T.gmv > 0 ? T.ads / T.gmv * 100 : null, tacos = T.fat > 0 ? T.ads / T.fat * 100 : null;
      const hj = new Date(`${ate}T12:00:00Z`), ano = hj.getUTCFullYear(), mes = hj.getUTCMonth(), diaH = hj.getUTCDate();
      const diasMes = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate(), diasAnt = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
      const iso = (m, d) => new Date(Date.UTC(ano, mes + m, d, 12)).toISOString().slice(0, 10);
      const diaSoma = d => linhas.reduce((s, l) => { const v = l.info?.dias?.[d] || {}; return { ads: s.ads + (+v.ads || 0), gmv: s.gmv + (+v.ads_gmv || 0), fat: s.fat + (+v.faturamento || 0) }; }, { ads: 0, gmv: 0, fat: 0 });
      const serie = f => ({ cur: Array.from({ length: diaH }, (_, i) => f(diaSoma(iso(0, i + 1)))), prev: Array.from({ length: diasAnt }, (_, i) => f(diaSoma(iso(-1, i + 1)))) });
      const fin = v => v == null || !isFinite(v) ? null : v;
      const compR = v => v >= 1000 ? `R$ ${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace('.', ',')} mil` : `R$ ${Math.round(v)}`;
      const graf = window.AdsResumo ? AdsResumo.render({
        chave: 'portal-ads', titulo: 'Por dia', sub: 'linha cheia = este mês · tracejada = mês passado', cor: 'var(--accent)', aoMudar: render,
        nomeCur: hj.toLocaleString('pt-BR', { month: 'long', timeZone: 'UTC' }), nomePrev: new Date(Date.UTC(ano, mes - 1, 1)).toLocaleString('pt-BR', { month: 'long', timeZone: 'UTC' }), diasMes, diasAnt,
        mets: [{ k: 'invest', rot: 'Investimento', val: R$(T.ads) }, { k: 'vendas', rot: 'Vendas por ADS', val: R$(T.gmv) }, { k: 'acos', rot: 'ACOS', val: pct(acos) }, { k: 'roas', rot: 'ROAS', val: T.ads > 0 ? roasX(T.gmv / T.ads) : '—' }, { k: 'fat', rot: 'Faturamento', val: R$(T.fat) }, { k: 'tacos', rot: 'TACOS', val: pct(tacos) }],
        series: {
          invest: { rot: 'Investimento', fmt: R$, eixo: compR, ...serie(x => fin(x.ads)) },
          vendas: { rot: 'Vendas por ADS', fmt: R$, eixo: compR, ...serie(x => fin(x.gmv)) },
          acos: { rot: 'ACOS', fmt: v => pct(v), eixo: v => `${Math.round(v)}%`, ...serie(x => x.gmv > 0 ? x.ads / x.gmv * 100 : null) },
          roas: { rot: 'ROAS', fmt: roasX, eixo: v => `${Math.round(v)}x`, ...serie(x => x.ads > 0 ? x.gmv / x.ads : null) },
          fat: { rot: 'Faturamento', fmt: R$, eixo: compR, ...serie(x => fin(x.fat)) },
          tacos: { rot: 'TACOS', fmt: v => pct(v), eixo: v => `${Math.round(v)}%`, ...serie(x => x.fat > 0 ? x.ads / x.fat * 100 : null) },
        },
      }) : '';
      root.innerHTML = `
        <div class="px-kpis">
          ${kpi('Investimento em ADS', R$(T.ads), `${dm(de)} a ${dm(ate)}`)}
          ${kpi('Vendas por ADS', R$(T.gmv), 'atribuídas pelos marketplaces')}
          ${kpi('ACOS', pct(acos), 'ADS ÷ vendas por ADS')}
          ${kpi('ROAS', T.ads > 0 ? roasX(T.gmv / T.ads) : '—', 'vendas por ADS ÷ ADS')}
          ${kpi('Faturamento total', R$(T.fat), 'todas as vendas, sem cancelados')}
          ${kpi('TACOS', pct(tacos), 'ADS ÷ faturamento total')}
        </div>
        ${graf}
        <section class="card px-card"><h3>Por loja</h3><div class="px-sub">${dm(de)} a ${dm(ate)}</div><div class="px-tab-w"><table class="px-tab" data-todas-colunas>
          <thead><tr><th>Loja</th><th class="num">Investimento</th><th class="num">Vendas por ADS</th><th class="num">ACOS</th><th class="num">ROAS</th><th class="num">Faturamento</th><th class="num">TACOS</th></tr></thead>
          <tbody>${linhas.sort((a, b) => b.t.ads - a.t.ads).map(l => { const a = l.comAds ? l.t.ads : null, g = l.comAds ? l.t.ads_gmv : null; return `<tr><td><span class="px-tag" style="--c:${COR[l.mkt] || 'var(--accent)'}">${h(MKT[l.mkt] || l.mkt)}</span> ${h(l.nome)}</td><td class="num">${R$(a)}</td><td class="num">${R$(g)}</td><td class="num">${g > 0 ? pct(a / g * 100) : '—'}</td><td class="num">${a > 0 ? roasX(g / a) : '—'}</td><td class="num">${R$(l.t.faturamento)}</td><td class="num">${l.t.faturamento > 0 && a != null ? pct(a / l.t.faturamento * 100) : '—'}</td></tr>`; }).join('')}</tbody>
        </table></div><p class="px-nota">ADS da Shopee inclui o GMV Max. Os ajustes nas campanhas são feitos pela equipe da GLR.</p></section>`;
    }
    window._pxAdsPer = k => { st.per = k; try { localStorage.setItem('glr_px_ads_per', k); } catch (e) {} render(); };
    render();
  });

  // ── Analítico ─────────────────────────────────────────────────
  Router.register('meu-analitico', async (params, el) => {
    el.innerHTML = `<div class="page px">${estilo}<div class="px-head"><div><h1>Analítico</h1><p>Como as suas vendas estão evoluindo mês a mês, em cada marketplace, por dia da semana, e quanto foi cancelado ou devolvido.</p></div></div><div id="px-root"><div class="card px-vazio">Carregando…</div></div></div>`;
    let lojas;
    const carteira = !ehPortal() && !GLR.ctx?.cliente?.();
    try { lojas = await lojasDoAcesso({ carteira: true }); } catch (e) { el.querySelector('#px-root').innerHTML = `<div class="card px-vazio">Não consegui ler os dados: ${h(e.message)}</div>`; return; }
    const root = el.querySelector('#px-root');
    if (!lojas.length) { root.innerHTML = '<div class="card px-vazio">Nenhuma loja com dados ainda.</div>'; return; }
    if (!ehPortal()) el.querySelector('.px-head p').textContent = carteira
      ? `Toda a carteira (${lojas.length} lojas): evolução mês a mês, marketplaces, dia da semana, cancelamentos e devoluções. Escolha um cliente no topo para ver só as lojas dele.`
      : 'As lojas do cliente em foco: evolução mês a mês, marketplaces, dia da semana, cancelamentos e devoluções. É a mesma tela que o cliente vê no portal.';
    const meses = {}, porMkt = {}, semana = Array.from({ length: 7 }, () => ({ fat: 0, ped: 0 }));
    let primeiroDia = null;
    for (const l of lojas) for (const [d, v] of Object.entries(l.info?.dias || {})) {
      if (!BaseDados.cobre(l.info, d)) continue;
      primeiroDia = !primeiroDia || d < primeiroDia ? d : primeiroDia;
      const m = d.slice(0, 7), x = meses[m] || (meses[m] = { fat: 0, ped: 0, un: 0, ads: 0, canc: 0, dev: 0, liq: 0, comLiq: 0, mkt: {} });
      const fat = +v.faturamento || 0;
      x.fat += fat; x.ped += +v.pedidos || 0; x.un += +v.unidades || 0; x.ads += +v.ads || 0; x.canc += +v.valor_cancelado || 0; x.dev += +v.valor_devolvido || 0;
      x.liq += +v.liquido || 0; x.comLiq += +v.com_liquido || 0;
      x.mkt[l.mkt] = (x.mkt[l.mkt] || 0) + fat; porMkt[l.mkt] = (porMkt[l.mkt] || 0) + fat;
      const ds = new Date(`${d}T12:00:00Z`).getUTCDay(); semana[ds].fat += fat; semana[ds].ped += +v.pedidos || 0;
    }
    const ord = Object.keys(meses).sort();
    const rotM = m => `${MESES[+m.slice(5, 7) - 1]}${m.slice(0, 4) !== hojeIso().slice(0, 4) ? '/' + m.slice(2, 4) : ''}`;
    const atual = hojeIso().slice(0, 7), dd = +hojeIso().slice(8, 10), dmes = new Date(Date.UTC(+atual.slice(0, 4), +atual.slice(5, 7), 0)).getUTCDate();
    const ateOntem = dd > 1 ? lojas.reduce((s, l) => s + BaseDados.somar(l.info, atual + '-01', somaDias(hojeIso(), -1)).faturamento, 0) : 0;
    const proj = dd > 1 ? ateOntem / (dd - 1) * dmes : null; // mesma regra da Projeção: faturado até ontem ÷ dias × dias do mês
    const totMkt = Object.values(porMkt).reduce((a, b) => a + b, 0) || 1;
    const contasMkt = {}; for (const l of lojas) if (l.mkt) contasMkt[l.mkt] = (contasMkt[l.mkt] || 0) + 1; // contas carregadas por marketplace
    const mUlt = meses[atual] || {}, mAnt = meses[ord[ord.length - 2]] || {};
    const tk = x => x.ped > 0 ? x.fat / x.ped : null;
    const vendido = x => (x.fat || 0) + (x.canc || 0) + (x.dev || 0);
    // Por loja: mês atual × mesmo período do mês passado (dia 1 até hoje), ticket e perdas
    function porLoja() {
      if (lojas.length < 2) return '';
      const hoje = hojeIso(), ini = atual + '-01';
      const dA = new Date(`${ini}T12:00:00Z`); dA.setUTCMonth(dA.getUTCMonth() - 1);
      const iniAnt = dA.toISOString().slice(0, 10), diasAnt = new Date(Date.UTC(dA.getUTCFullYear(), dA.getUTCMonth() + 1, 0)).getUTCDate();
      const fimAnt = iniAnt.slice(0, 8) + String(Math.min(dd, diasAnt)).padStart(2, '0');
      const ls = lojas.map(l => {
        let canc = 0, dev = 0;
        for (const [d, v] of Object.entries(l.info?.dias || {})) if (d >= ini && d <= hoje) { canc += +v.valor_cancelado || 0; dev += +v.valor_devolvido || 0; }
        const a = BaseDados.somar(l.info, ini, hoje), p = BaseDados.somar(l.info, iniAnt, fimAnt);
        return { l, fat: a.faturamento, ped: a.pedidos, ant: p.faturamento, canc, dev, ads: a.ads };
      }).filter(x => x.fat > 0 || x.ant > 0).sort((a, b) => b.fat - a.fat);
      const varP = x => x.ant > 0 ? (x.fat / x.ant - 1) * 100 : null;
      const corV = v => v == null ? 'var(--text-muted)' : v >= 0 ? 'var(--green)' : 'var(--red)';
      return `<section class="card px-card" style="grid-column:1/-1"><h3>Por loja</h3><div class="px-sub">mês atual (até hoje) contra o mesmo período do mês passado · ${ls.length} lojas com venda</div><div class="px-tab-w"><table class="px-tab" data-todas-colunas>
        <thead><tr><th>Loja</th><th class="num">Faturamento</th><th class="num">Mesmo período mês passado</th><th class="num">Variação</th><th class="num">Pedidos</th><th class="num">Ticket</th><th class="num">TACOS</th><th class="num">Cancel. + devol.</th></tr></thead>
        <tbody>${ls.slice(0, 200).map(x => { const v = varP(x), perda = x.fat + x.canc + x.dev > 0 ? (x.canc + x.dev) / (x.fat + x.canc + x.dev) * 100 : null; return `<tr><td><span class="px-tag" style="--c:${COR[x.l.mkt] || 'var(--accent)'}">${h(MKT[x.l.mkt] || x.l.mkt)}</span> ${h(x.l.nome)}</td><td class="num">${R0(x.fat)}</td><td class="num">${R0(x.ant)}</td><td class="num" style="font-weight:650;color:${corV(v)}">${v == null ? '—' : (v > 0 ? '+' : '') + pct(v)}</td><td class="num">${N(x.ped)}</td><td class="num">${x.ped > 0 ? R$(x.fat / x.ped) : '—'}</td><td class="num">${x.fat > 0 && x.ads ? pct(x.ads / x.fat * 100) : '—'}</td><td class="num" style="color:${perda >= 15 ? 'var(--red)' : 'inherit'}">${pct(perda)}</td></tr>`; }).join('')}</tbody>
      </table></div></section>`;
    }
    root.innerHTML = `
      <div class="px-kpis">
        ${kpi('Faturamento do mês', R$(mUlt.fat), proj ? `projeção ${R0(proj)} no ritmo do mês` : '')}
        ${kpi('Pedidos no mês', N(mUlt.ped), `${N(mUlt.un)} unidades`)}
        ${kpi('Ticket médio', R$(tk(mUlt)), mAnt.ped ? `mês passado ${R$(tk(mAnt))}` : '')}
        ${kpi('ADS no mês', R$(mUlt.ads), mUlt.fat > 0 ? `TACOS ${pct(mUlt.ads / mUlt.fat * 100)}` : '')}
        ${kpi('Cancelado no mês', R$(mUlt.canc), vendido(mUlt) > 0 ? `${pct(mUlt.canc / vendido(mUlt) * 100)} do vendido` : '')}
        ${kpi('Devolvido/reembolsado', R$(mUlt.dev), vendido(mUlt) > 0 ? `${pct(mUlt.dev / vendido(mUlt) * 100)} do vendido` : '')}
      </div>
      <div class="px-grid">
        <section class="card px-card"><h3>Faturamento por mês</h3><div class="px-sub">sem cancelados e devoluções · mês atual parcial</div>${barras(ord.map(m => ({ rot: rotM(m), v: meses[m].fat })), { fmt: R0 })}</section>
        <section class="card px-card"><h3>Pedidos e unidades por mês</h3><div class="px-leg"><span><i style="background:var(--accent)"></i>pedidos</span><span><i style="background:#10b981"></i>unidades</span></div>${barras(ord.map(m => ({ rot: rotM(m), v: meses[m].ped, v2: meses[m].un })), { cor2: '#10b981' })}</section>
        <section class="card px-card"><h3>Faturamento por marketplace</h3><div class="px-sub">mês a mês</div>
          <div class="px-leg">${Object.keys(porMkt).map(k => `<span><i style="background:${COR[k] || '#888'}"></i>${h(MKT[k] || k)}</span>`).join('')}</div>
          ${ord.map(m => { const tot = meses[m].fat || 1; return `<div style="display:grid;grid-template-columns:48px 1fr 90px;gap:8px;align-items:center;margin:6px 0;font-size:12px"><span style="color:var(--text-muted)">${rotM(m)}</span><div class="px-barra">${Object.entries(meses[m].mkt).map(([k, v]) => `<i style="width:${v / tot * 100}%;background:${COR[k] || '#888'}" title="${h(MKT[k] || k)}: ${R0(v)}"></i>`).join('')}</div><span style="text-align:right;font-variant-numeric:tabular-nums">${R0(meses[m].fat)}</span></div>`; }).join('')}
          <div class="px-tab-w" style="margin-top:8px"><table class="px-tab" data-todas-colunas><thead><tr><th>Marketplace</th><th class="num">Contas</th><th class="num">Faturamento (período)</th><th class="num">% do total</th></tr></thead><tbody>${Object.entries(porMkt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td><span class="px-tag" style="--c:${COR[k] || 'var(--accent)'}">${h(MKT[k] || k)}</span></td><td class="num">${contasMkt[k] ? N(contasMkt[k]) : '—'}</td><td class="num">${R$(v)}</td><td class="num">${pct(v / totMkt * 100)}</td></tr>`).join('')}</tbody></table></div></section>
        <section class="card px-card"><h3>Vendas por dia da semana</h3><div class="px-sub">faturamento somado do período</div>${barras(['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].map((r, i) => ({ rot: r, v: semana[i].fat })), { fmt: R0 })}</section>
        <section class="card px-card"><h3>Ticket médio por mês</h3><div class="px-sub">faturamento ÷ pedidos</div>${barras(ord.map(m => ({ rot: rotM(m), v: tk(meses[m]) || 0 })), { fmt: R0, cor: '#8b5cf6' })}</section>
        <section class="card px-card"><h3>Cancelamentos e devoluções por mês</h3><div class="px-leg"><span><i style="background:#f59e0b"></i>cancelado</span><span><i style="background:#ef4444"></i>devolvido/reembolsado</span></div>${barras(ord.map(m => ({ rot: rotM(m), v: meses[m].canc, v2: meses[m].dev })), { fmt: R0, cor: '#f59e0b', cor2: '#ef4444' })}</section>
        <section class="card px-card"><h3>ADS por mês</h3><div class="px-sub">investimento em anúncios (TACOS no rótulo)</div>${barras(ord.map(m => ({ rot: `${rotM(m)} · ${meses[m].fat > 0 ? pct(meses[m].ads / meses[m].fat * 100) : '—'}`, v: meses[m].ads })), { fmt: R0, cor: '#0ea5e9' })}</section>
        <section class="card px-card"><h3>Resumo mês a mês</h3><div class="px-tab-w"><table class="px-tab" data-todas-colunas><thead><tr><th>Mês</th><th class="num">Faturamento</th><th class="num">Pedidos</th><th class="num">Ticket</th><th class="num">ADS</th><th class="num">TACOS</th><th class="num">Recebido líquido</th></tr></thead>
          <tbody>${ord.slice().reverse().map(m => { const x = meses[m]; return `<tr><td>${rotM(m)}</td><td class="num">${R0(x.fat)}</td><td class="num">${N(x.ped)}</td><td class="num">${R$(tk(x))}</td><td class="num">${R0(x.ads)}</td><td class="num">${x.fat > 0 ? pct(x.ads / x.fat * 100) : '—'}</td><td class="num" title="o que cai na conta depois das taxas dos marketplaces (pedidos já conferidos)">${x.comLiq ? R0(x.liq) : '—'}</td></tr>`; }).join('')}</tbody></table></div></section>
        ${porLoja()}
      </div>
      <p class="px-nota">Fonte: a base de vendas da GLR, desde ${primeiroDia ? primeiroDia.split('-').reverse().join('/') : '—'} (a base guarda os últimos ~3 meses). Faturamento sem cancelados e devoluções. Para lucro por produto, veja Financeiro.</p>`;
  });

  // ── Projeção do mês (módulo liberado por acesso: cfg.projecao) ─────
  // Só as lojas do acesso, pela base automática: faturado até ontem ÷ dias decorridos ×
  // dias do mês (mesma regra da Projeção da equipe). A meta vem do acesso (cfg.metaMes),
  // copiada pela GLR ao liberar o módulo — o portal não lê as metas internas.
  Router.register('minha-projecao', async (params, el) => {
    const cfg = window._portalConfig || {};
    el.innerHTML = `<div class="page px">${estilo}<div class="px-head"><div><h1>Projeção do mês</h1><p>Quanto as suas lojas devem faturar até o fim do mês no ritmo atual, contra o mês passado e a meta.</p></div></div><div id="px-root"><div class="card px-vazio">Carregando…</div></div></div>`;
    let lojas;
    try { lojas = await lojasDoAcesso(); } catch (e) { el.querySelector('#px-root').innerHTML = `<div class="card px-vazio">Não consegui ler os dados: ${h(e.message)}</div>`; return; }
    const root = el.querySelector('#px-root');
    if (semCliente()) { root.innerHTML = vazioSemCliente(); return; }
    if (!lojas.length) { root.innerHTML = '<div class="card px-vazio">Nenhuma loja com dados ainda.</div>'; return; }
    const hoje = hojeIso(), ontem = somaDias(hoje, -1);
    const ano = +ontem.slice(0, 4), mes = +ontem.slice(5, 7), dd = +ontem.slice(8, 10);
    const diasMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate(), mesIni = ontem.slice(0, 8) + '01';
    const antIni = new Date(Date.UTC(ano, mes - 2, 1)).toISOString().slice(0, 10), antFim = new Date(Date.UTC(ano, mes - 1, 0)).toISOString().slice(0, 10);
    const antDias = +antFim.slice(8, 10), antMesmo = antIni.slice(0, 8) + String(Math.min(dd, antDias)).padStart(2, '0');
    const soma = (de, ate) => lojas.reduce((t, l) => { const x = BaseDados.somar(l.info, de, ate); for (const k of Object.keys(x)) t[k] = (t[k] || 0) + x[k]; return t; }, {});
    const m = soma(mesIni, ontem), ant = soma(antIni, antFim), antP = soma(antIni, antMesmo);
    const fator = dd > 0 ? diasMes / dd : null;
    const proj = fator ? m.faturamento * fator : null;
    const meta = parseFloat(cfg.metaMes) || 0;
    const pctMeta = proj != null && meta > 0 ? proj / meta * 100 : null;
    const vsAnt = proj != null && ant.faturamento > 0 ? (proj / ant.faturamento - 1) * 100 : null;
    const vsAntP = antP.faturamento > 0 ? (m.faturamento / antP.faturamento - 1) * 100 : null;
    const temAds = lojas.some(l => BaseDados.cobreAds(l.info, mesIni));
    const tacos = temAds && m.faturamento > 0 ? m.ads / m.faturamento * 100 : null;
    const precisaDia = meta > 0 && diasMes - dd > 0 ? Math.max(0, meta - m.faturamento) / (diasMes - dd) : null;
    const corV = v => v == null ? 'var(--text-muted)' : v >= 0 ? 'var(--green)' : 'var(--red)';
    const sinal = v => v == null ? '—' : `${v > 0 ? '+' : ''}${pct(v)}`;
    // ritmo: acumulado por dia (mês atual × mês passado) e a linha da projeção até o fim do mês
    const acum = (de, dias) => { let a = 0; return Array.from({ length: dias }, (_, i) => { const d = somaDias(de, i); a += soma(d, d).faturamento; return a; }); };
    const atual = acum(mesIni, dd), passado = acum(antIni, antDias);
    const W = 960, H = 260, P = 64, maxV = Math.max(1, proj || 0, ...passado, meta || 0) * 1.05;
    const X = i => P + (W - P - 8) * (i / Math.max(1, diasMes - 1)), Y = v => H - 22 - (H - 40) * (v / maxV);
    const linha = (arr, n) => arr.slice(0, n).map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const marcas = [0, 0.5, 1].map(f => maxV / 1.05 * f);
    const graf = `<div class="px-graf"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="faturamento acumulado do mês">
      ${marcas.map(v => `<line x1="${P}" x2="${W - 8}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--border)"/><text x="${P - 6}" y="${Y(v) + 4}" text-anchor="end" class="px-gx">${v >= 1e6 ? `${(v / 1e6).toFixed(1).replace('.', ',')} mi` : v >= 1000 ? `${Math.round(v / 1000)} mil` : Math.round(v)}</text>`).join('')}
      ${meta ? `<line x1="${P}" x2="${W - 8}" y1="${Y(meta)}" y2="${Y(meta)}" stroke="#f59e0b" stroke-dasharray="2 4"/><text x="${W - 10}" y="${Y(meta) - 4}" text-anchor="end" class="px-gt" style="fill:#f59e0b">meta</text>` : ''}
      <path d="${linha(passado, Math.min(passado.length, diasMes))}" fill="none" stroke="var(--text-muted)" stroke-width="1.5"/>
      <path d="${linha(atual, atual.length)}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>
      ${proj && dd ? `<path d="M${X(dd - 1)},${Y(m.faturamento)} L${X(diasMes - 1)},${Y(proj)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 5"/><circle cx="${X(diasMes - 1)}" cy="${Y(proj)}" r="4" fill="var(--accent)"/>` : ''}
      ${[1, 10, 20, diasMes].map(d => `<text x="${X(d - 1)}" y="${H - 6}" text-anchor="middle" class="px-gx">${d}</text>`).join('')}
    </svg></div>`;
    const porLoja = lojas.map(l => { const x = BaseDados.somar(l.info, mesIni, ontem); return { l, fat: x.faturamento, proj: fator ? x.faturamento * fator : null }; }).sort((a, b) => b.fat - a.fat);
    root.innerHTML = `
      <section class="card px-card" style="margin-bottom:14px">
        <div class="px-sub">Projeção de ${['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'][mes - 1]} · faturado até ${dm(ontem)} (dia ${dd} de ${diasMes})</div>
        <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:flex-end">
          <div><div style="font-size:34px;font-weight:750;letter-spacing:-.02em;font-variant-numeric:tabular-nums">${R0(proj)}</div><div class="px-sub" style="margin:0">Faturado até agora: <b style="color:var(--text-primary)">${R0(m.faturamento)}</b></div></div>
          <div class="px-kpis" style="margin:0;flex:1;max-width:620px">
            ${kpi('vs mês passado', `<span style="color:${corV(vsAnt)}">${sinal(vsAnt)}</span>`, ant.faturamento ? `fechou em ${R0(ant.faturamento)}` : '')}
            ${kpi('Mesmos dias do mês passado', `<span style="color:${corV(vsAntP)}">${sinal(vsAntP)}</span>`, `até o dia ${Math.min(dd, antDias)}: ${R0(antP.faturamento)}`)}
            ${meta ? kpi('Da meta', `<span style="color:${pctMeta >= 100 ? 'var(--green)' : pctMeta >= 85 ? 'var(--yellow)' : 'var(--red)'}">${pct(pctMeta, 0)}</span>`, `meta ${R0(meta)}`) : ''}
          </div>
        </div>
        ${meta ? `<div class="px-barra" style="margin-top:12px"><i style="width:${Math.min(100, m.faturamento / meta * 100)}%;background:var(--accent)"></i></div><p class="px-nota">${pct(m.faturamento / meta * 100, 0)} da meta já faturado${precisaDia != null ? ` · para bater a meta: ${R0(precisaDia)} por dia até o fim do mês` : ''}</p>` : ''}
      </section>
      <div class="px-kpis">
        ${kpi('Pedidos projetados', N(fator ? m.pedidos * fator : null), `${N(m.pedidos)} até agora · ticket ${R$(m.pedidos ? m.faturamento / m.pedidos : null)}`)}
        ${kpi('Média por dia', R0(dd ? m.faturamento / dd : null), `mês passado ${R0(antDias ? ant.faturamento / antDias : null)}/dia`)}
        ${temAds ? kpi('ADS projetado', R0(fator ? m.ads * fator : null), `${R0(m.ads)} até agora · TACOS ${pct(tacos)}`) : ''}
      </div>
      <section class="card px-card" style="margin-bottom:14px"><h3>Ritmo do mês</h3><div class="px-leg"><span><i style="background:var(--accent)"></i>este mês (acumulado)</span><span><i style="background:var(--accent);opacity:.5"></i>projeção até o fim do mês</span><span><i style="background:var(--text-muted)"></i>mês passado</span>${meta ? '<span><i style="background:#f59e0b"></i>meta</span>' : ''}</div>${graf}</section>
      ${porLoja.length > 1 ? `<section class="card px-card"><h3>Por loja</h3><div class="px-tab-w"><table class="px-tab" data-todas-colunas><thead><tr><th>Loja</th><th class="num">Faturado</th><th class="num">Projeção</th><th class="num">Participação</th></tr></thead>
        <tbody>${porLoja.map(x => `<tr><td><span class="px-tag" style="--c:${COR[x.l.mkt] || 'var(--accent)'}">${h(MKT[x.l.mkt] || x.l.mkt)}</span> ${h(x.l.nome)}</td><td class="num">${R0(x.fat)}</td><td class="num">${R0(x.proj)}</td><td class="num">${m.faturamento > 0 ? pct(x.fat / m.faturamento * 100) : '—'}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
      <p class="px-nota">Projeção = faturado até ontem ÷ dias decorridos × dias do mês. Faturamento sem cancelados e devoluções. Hoje fica de fora porque ainda está em andamento.</p>`;
  });

  // ── Reembolsos ────────────────────────────────────────────────
  Router.register('meus-reembolsos', async (params, el) => {
    const st = { dias: (() => { try { return +localStorage.getItem('glr_px_reemb_dias') || 30; } catch (e) { return 30; } })(), busca: '', dados: null, erro: null };
    el.innerHTML = `<div class="page px">${estilo}<div class="px-head"><div><h1>Reembolsos</h1><p>Produtos que tiveram devolução ou reembolso ao comprador no período, e quanto isso representa no que cada um vendeu.</p></div><div class="px-per" id="px-per"></div></div><div id="px-root"><div class="card px-vazio">Carregando…</div></div></div>`;
    async function carregar() {
      st.dados = null; render();
      try {
        if (semCliente()) { st.dados = 'semcliente'; render(); return; }
        const lojas = await lojasDoAcesso();
        const ids = lojas.map(l => l.id), lojaDe = Object.fromEntries(lojas.map(l => [l.id, l]));
        const desde = new Date(`${somaDias(hojeIso(), -(st.dias - 1))}T00:00:00-03:00`).toISOString();
        const linhas = [];
        for (const id of ids) {
          for (let off = 0; off < 60000; off += 1000) {
            const { data, error } = await _sb.from('glr_pedidos').select('conta_id,situacao,valor_bruto,itens').eq('conta_id', id).in('situacao', ['valido', 'devolvido', 'reembolsado']).gte('criado_em', desde).range(off, off + 999);
            if (error) throw error;
            linhas.push(...(data || [])); if ((data || []).length < 1000) break;
          }
        }
        const prod = new Map(); let pedDev = 0, valDev = 0, valTot = 0, pedTot = 0;
        for (const p of linhas) {
          const dev = p.situacao === 'devolvido' || p.situacao === 'reembolsado', vb = +p.valor_bruto || 0; pedTot++; valTot += vb; if (dev) { pedDev++; valDev += vb; }
          const itens = (p.itens || []).length ? p.itens : [{ item_id: '?', nome: 'Pedido sem item identificado', qtd: 1, preco: vb }];
          const totalItens = itens.reduce((s, it) => s + (+it.preco || 0) * (+it.qtd || 1), 0) || 1;
          for (const it of itens) {
            const k = `${p.conta_id}:${it.item_id}`, x = prod.get(k) || { nome: it.nome || it.item_id, sku: it.sku || '', loja: lojaDe[p.conta_id], vendidas: 0, reemb: 0, fat: 0, valReemb: 0 };
            const q = +it.qtd || 1, v = vb * ((+it.preco || 0) * q / totalItens);
            x.vendidas += q; x.fat += v; if (dev) { x.reemb += q; x.valReemb += v; }
            prod.set(k, x);
          }
        }
        st.dados = { pedTot, pedDev, valTot, valDev, lista: [...prod.values()].filter(x => x.reemb > 0).sort((a, b) => b.valReemb - a.valReemb) };
      } catch (e) { st.erro = e.message || String(e); st.dados = 'erro'; }
      render();
    }
    function render() {
      el.querySelector('#px-per').innerHTML = [30, 60, 90].map(d => `<button class="${st.dias === d ? 'on' : ''}" onclick="window._pxReembDias(${d})">${d} dias</button>`).join('');
      const root = el.querySelector('#px-root'); if (!root) return;
      if (!st.dados) { root.innerHTML = '<div class="card px-vazio">Carregando os pedidos do período…</div>'; return; }
      if (st.dados === 'semcliente') { root.innerHTML = vazioSemCliente(); return; }
      if (st.dados === 'erro') { root.innerHTML = `<div class="card px-vazio">Não consegui ler os pedidos: ${h(st.erro)}</div>`; return; }
      const d = st.dados, q = st.busca.toLowerCase();
      const lista = d.lista.filter(x => !q || `${x.nome} ${x.sku}`.toLowerCase().includes(q));
      root.innerHTML = `
        <div class="px-kpis">
          ${kpi('Valor reembolsado', R$(d.valDev), `${N(d.pedDev)} pedido(s)`)}
          ${kpi('Taxa de reembolso', pct(d.valTot > 0 ? d.valDev / d.valTot * 100 : null), 'do valor vendido no período', d.valTot > 0 && d.valDev / d.valTot > 0.05 ? 'var(--red)' : null)}
          ${kpi('Pedidos no período', N(d.pedTot), `últimos ${st.dias} dias`)}
          ${kpi('Produtos com reembolso', N(d.lista.length), '')}
        </div>
        <section class="card px-card">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px"><h3>Por produto</h3><input id="px-busca" class="form-input" style="max-width:260px" placeholder="Buscar produto ou SKU…" value="${h(st.busca)}" oninput="window._pxReembBusca(this.value)"></div>
          ${lista.length ? `<div class="px-tab-w"><table class="px-tab" data-todas-colunas><thead><tr><th>Produto</th><th>Loja</th><th class="num">Unid. vendidas</th><th class="num">Unid. reembolsadas</th><th class="num">Total faturado</th><th class="num">Valor reembolsado</th><th class="num">% reembolso</th></tr></thead>
            <tbody>${lista.slice(0, 300).map(x => { const p = x.fat > 0 ? x.valReemb / x.fat * 100 : null; return `<tr><td style="min-width:240px">${h(x.nome)}${x.sku ? `<div style="font-size:11px;color:var(--text-muted)">SKU ${h(x.sku)}</div>` : ''}</td><td>${x.loja ? `<span class="px-tag" style="--c:${COR[x.loja.mkt] || 'var(--accent)'}">${h(MKT[x.loja.mkt] || x.loja.mkt)}</span>` : ''}</td><td class="num">${N(x.vendidas)}</td><td class="num">${N(x.reemb)}</td><td class="num">${R$(x.fat)}</td><td class="num">${R$(x.valReemb)}</td><td class="num" style="font-weight:700;color:${p >= 10 ? 'var(--red)' : p >= 5 ? 'var(--yellow)' : 'var(--text-primary)'}">${pct(p)}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="px-vazio">Nenhum produto com devolução ou reembolso no período.</div>'}
          <p class="px-nota">Reembolso = pedido devolvido ou com o dinheiro devolvido ao comprador (reclamação encerrada a favor dele, devolução aceita). Cancelamentos antes do envio não entram aqui. Valores pelo preço de venda dos itens.</p>
        </section>`;
    }
    window._pxReembDias = n => { st.dias = n; try { localStorage.setItem('glr_px_reemb_dias', String(n)); } catch (e) {} carregar(); };
    window._pxReembBusca = v => { st.busca = v; clearTimeout(window._pxReembT); window._pxReembT = setTimeout(() => { render(); const i = el.querySelector('#px-busca'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } }, 300); };
    carregar();
  });

  // ── Calculadora de precificação ───────────────────────────────
  Router.register('calculadora', (params, el) => {
    el.innerHTML = `<div class="page px">${estilo}<div class="px-head"><div><h1>Calculadora de precificação</h1><p>Preço mínimo, preço sugerido pela margem que você quer e quanto sobra de verdade, com as taxas de cada marketplace, ADS, imposto e rebate.</p></div><a class="btn btn-secondary btn-sm" href="calculadora.html" target="_blank" rel="noopener">Abrir em outra aba</a></div>
      <iframe src="calculadora.html?embed=1" title="Calculadora GLR" style="width:100%;height:calc(100vh - 170px);min-height:900px;border:1px solid var(--border);border-radius:14px;background:#0b0d14"></iframe></div>`;
  });

  // ── Chat com IA ───────────────────────────────────────────────
  Router.register('meu-chat', (params, el) => {
    const cfg = window._portalConfig;
    const K = `glr_px_chat_${cfg?.id || 'equipe'}`;
    const st = { id: (() => { try { return localStorage.getItem(K) || null; } catch (e) { return null; } })(), msgs: [], enviando: false, erro: null, rascunho: '' };
    const md = t => (window.glrMarkdown ? window.glrMarkdown(t) : h(t).replace(/\n/g, '<br>'));
    const SUG = ['Como estão as minhas vendas neste mês contra o mês passado?', 'Quais produtos mais caíram nas últimas semanas e por quê?', 'Meu ADS está valendo a pena? Qual o ACOS e o TACOS?', 'Quais produtos estão acabando o estoque?'];
    async function api(corpo) {
      const r = await window.glrApiFetch('/api/portal-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      const j = await r.json().catch(() => ({ error: `Resposta inválida (HTTP ${r.status}).` }));
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`); return j;
    }
    el.innerHTML = `<div class="page px">${estilo}
      <div class="px-head"><div><h1>Chat com IA</h1><p>Pergunte sobre as suas lojas: vendas, produtos, ADS, estoque. A IA lê os seus dados e responde na hora — ela não muda nada nas contas.</p></div><button class="btn btn-secondary btn-sm" onclick="window._pxChatNova()">Nova conversa</button></div>
      <section class="card px-card" style="display:flex;flex-direction:column;min-height:60vh">
        <div id="px-msgs" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:4px 2px 12px;max-height:calc(100vh - 330px)"></div>
        <form id="px-form" onsubmit="event.preventDefault();window._pxChatEnviar()" style="display:flex;gap:8px;align-items:flex-end;border-top:1px solid var(--border);padding-top:10px">
          <textarea id="px-txt" rows="2" class="form-input" style="flex:1;resize:vertical" aria-label="Sua pergunta" placeholder="Escreva a sua pergunta… (Enter envia)" oninput="window._pxChatRasc(this.value)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window._pxChatEnviar()}"></textarea>
          <button class="btn btn-primary" type="submit" id="px-env">Enviar</button>
        </form>
      </section>
      <style>.px-m{max-width:85%;padding:10px 14px;border-radius:12px;font-size:13.5px;line-height:1.55;overflow-wrap:anywhere}.px-m.u{align-self:flex-end;background:color-mix(in srgb,var(--accent) 14%,var(--bg-card))}.px-m.a{align-self:flex-start;background:var(--bg-subtle)}.px-m p{margin:0 0 6px}.px-m p:last-child{margin:0}.px-m table{border-collapse:collapse;font-size:12.5px;margin:6px 0;display:block;overflow-x:auto}.px-m th,.px-m td{border:1px solid var(--border);padding:4px 8px}.px-sug{display:flex;gap:8px;flex-wrap:wrap}.px-sug button{border:1px solid var(--border);background:var(--bg-card);border-radius:10px;padding:8px 12px;font:inherit;font-size:13px;cursor:pointer;color:var(--text-primary);text-align:left}</style>
    </div>`;
    function render() {
      const box = el.querySelector('#px-msgs'); if (!box) return;
      const form = el.querySelector('#px-form');
      if (!cfg) { box.innerHTML = '<div class="px-vazio">Esta tela é do portal do cliente. Para a equipe, use "Chat com os agentes".</div>'; form.style.display = 'none'; return; }
      if (!cfg.chatIA) { box.innerHTML = '<div class="px-vazio">O Chat com IA ainda não está liberado para o seu acesso. Fale com a equipe da GLR para ativar.</div>'; form.style.display = 'none'; return; }
      box.innerHTML = (st.msgs.length ? st.msgs.map(m => `<div class="px-m ${m.r === 'user' ? 'u' : 'a'}">${m.r === 'user' ? h(m.t).replace(/\n/g, '<br>') : md(m.t)}</div>`).join('') : `<div class="px-vazio" style="text-align:left"><b>Comece por uma destas:</b><div class="px-sug" style="margin-top:10px">${SUG.map(s => `<button type="button" onclick="window._pxChatSug(this.textContent)">${h(s)}</button>`).join('')}</div></div>`)
        + (st.enviando ? '<div class="px-m a" style="color:var(--text-muted);font-style:italic">Analisando os seus dados…</div>' : '')
        + (st.erro ? `<div class="px-m a" style="color:var(--red)">${h(st.erro)}</div>` : '');
      box.scrollTop = box.scrollHeight;
      const b = el.querySelector('#px-env'); if (b) { b.disabled = st.enviando; b.textContent = st.enviando ? 'Respondendo…' : 'Enviar'; }
    }
    async function abrir() {
      if (!st.id || !cfg?.chatIA) { render(); return; }
      try { st.msgs = (await api({ acao: 'abrir', conversa_id: st.id })).conversa.msgs || []; } catch (e) { st.id = null; st.msgs = []; }
      render();
    }
    window._pxChatRasc = v => { st.rascunho = v; };
    window._pxChatSug = t => { const ta = el.querySelector('#px-txt'); if (ta) ta.value = t; st.rascunho = t; window._pxChatEnviar(); };
    window._pxChatNova = () => { st.id = null; st.msgs = []; st.erro = null; try { localStorage.removeItem(K); } catch (e) {} render(); };
    window._pxChatEnviar = async () => {
      const texto = String(st.rascunho || '').trim(); if (!texto || st.enviando) return;
      st.msgs.push({ r: 'user', t: texto }); st.rascunho = ''; st.enviando = true; st.erro = null;
      const ta = el.querySelector('#px-txt'); if (ta) ta.value = '';
      render();
      try {
        const j = await api({ acao: 'enviar', conversa_id: st.id, mensagem: texto });
        st.id = j.conversa_id; try { localStorage.setItem(K, st.id); } catch (e) {}
        st.msgs.push({ r: 'assistant', t: j.resposta });
        if (j.restantes != null && j.restantes <= 5) st.erro = j.restantes ? `Restam ${j.restantes} pergunta(s) hoje.` : 'Esta foi a última pergunta de hoje.';
      } catch (e) { st.erro = e.message || String(e); }
      st.enviando = false; render();
    };
    render(); abrir();
  });
})();
