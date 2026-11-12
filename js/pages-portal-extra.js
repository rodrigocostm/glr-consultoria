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
  async function lojasDoAcesso() {
    const base = await BaseDados.carregar();
    const cfg = window._portalConfig;
    let alvos = null;
    if (cfg) alvos = new Set((cfg.contaIds || []).map(String));
    else {
      const cli = GLR.ctx?.cliente?.();
      if (!cli) return [];
      let vinc = {}; try { vinc = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch (e) {}
      alvos = new Set((vinc[String(cli)] || []).flatMap(c => [c.external_id, c.param_to_use?.shopId, c.param_to_use?.meliUserId, c.param_to_use?.amazon_account_id].filter(Boolean).map(String)));
    }
    const nomes = Object.fromEntries(((cfg && cfg.contas) || []).map(c => [String(c.id), c.nome]));
    const lojas = [];
    for (const [k, info] of Object.entries(base || {})) {
      const mkt = k.slice(0, k.indexOf(':')), id = k.slice(k.indexOf(':') + 1);
      if (!alvos.has(id)) continue;
      const nome = nomes[id] || (!cfg && GLR.nomeConta ? String(GLR.nomeConta(mkt, id)).replace(/^.*? · /, '') : '') || `${MKT[mkt] || mkt} ${id.slice(-4)}`;
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
    try { lojas = await lojasDoAcesso(); } catch (e) { el.querySelector('#px-root').innerHTML = `<div class="card px-vazio">Não consegui ler os dados: ${h(e.message)}</div>`; return; }
    const root = el.querySelector('#px-root');
    if (semCliente()) { root.innerHTML = vazioSemCliente(); return; }
    if (!lojas.length) { root.innerHTML = '<div class="card px-vazio">Nenhuma loja com dados ainda.</div>'; return; }
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
    const mUlt = meses[atual] || {}, mAnt = meses[ord[ord.length - 2]] || {};
    const tk = x => x.ped > 0 ? x.fat / x.ped : null;
    const vendido = x => (x.fat || 0) + (x.canc || 0) + (x.dev || 0);
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
          <div class="px-tab-w" style="margin-top:8px"><table class="px-tab" data-todas-colunas><thead><tr><th>Marketplace</th><th class="num">Faturamento (período)</th><th class="num">% do total</th></tr></thead><tbody>${Object.entries(porMkt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td><span class="px-tag" style="--c:${COR[k] || 'var(--accent)'}">${h(MKT[k] || k)}</span></td><td class="num">${R$(v)}</td><td class="num">${pct(v / totMkt * 100)}</td></tr>`).join('')}</tbody></table></div></section>
        <section class="card px-card"><h3>Vendas por dia da semana</h3><div class="px-sub">faturamento somado do período</div>${barras(['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].map((r, i) => ({ rot: r, v: semana[i].fat })), { fmt: R0 })}</section>
        <section class="card px-card"><h3>Ticket médio por mês</h3><div class="px-sub">faturamento ÷ pedidos</div>${barras(ord.map(m => ({ rot: rotM(m), v: tk(meses[m]) || 0 })), { fmt: R0, cor: '#8b5cf6' })}</section>
        <section class="card px-card"><h3>Cancelamentos e devoluções por mês</h3><div class="px-leg"><span><i style="background:#f59e0b"></i>cancelado</span><span><i style="background:#ef4444"></i>devolvido/reembolsado</span></div>${barras(ord.map(m => ({ rot: rotM(m), v: meses[m].canc, v2: meses[m].dev })), { fmt: R0, cor: '#f59e0b', cor2: '#ef4444' })}</section>
        <section class="card px-card"><h3>ADS por mês</h3><div class="px-sub">investimento em anúncios (TACOS no rótulo)</div>${barras(ord.map(m => ({ rot: `${rotM(m)} · ${meses[m].fat > 0 ? pct(meses[m].ads / meses[m].fat * 100) : '—'}`, v: meses[m].ads })), { fmt: R0, cor: '#0ea5e9' })}</section>
        <section class="card px-card"><h3>Resumo mês a mês</h3><div class="px-tab-w"><table class="px-tab" data-todas-colunas><thead><tr><th>Mês</th><th class="num">Faturamento</th><th class="num">Pedidos</th><th class="num">Ticket</th><th class="num">ADS</th><th class="num">TACOS</th><th class="num">Recebido líquido</th></tr></thead>
          <tbody>${ord.slice().reverse().map(m => { const x = meses[m]; return `<tr><td>${rotM(m)}</td><td class="num">${R0(x.fat)}</td><td class="num">${N(x.ped)}</td><td class="num">${R$(tk(x))}</td><td class="num">${R0(x.ads)}</td><td class="num">${x.fat > 0 ? pct(x.ads / x.fat * 100) : '—'}</td><td class="num" title="o que cai na conta depois das taxas dos marketplaces (pedidos já conferidos)">${x.comLiq ? R0(x.liq) : '—'}</td></tr>`; }).join('')}</tbody></table></div></section>
      </div>
      <p class="px-nota">Fonte: a base de vendas da GLR, desde ${primeiroDia ? primeiroDia.split('-').reverse().join('/') : '—'} (a base guarda os últimos ~3 meses). Faturamento sem cancelados e devoluções. Para lucro por produto, veja Financeiro.</p>`;
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
            const { data, error } = await _sb.from('glr_pedidos').select('conta_id,situacao,valor_bruto,itens').eq('conta_id', id).in('situacao', ['valido', 'devolvido']).gte('criado_em', desde).range(off, off + 999);
            if (error) throw error;
            linhas.push(...(data || [])); if ((data || []).length < 1000) break;
          }
        }
        const prod = new Map(); let pedDev = 0, valDev = 0, valTot = 0, pedTot = 0;
        for (const p of linhas) {
          const dev = p.situacao === 'devolvido', vb = +p.valor_bruto || 0; pedTot++; valTot += vb; if (dev) { pedDev++; valDev += vb; }
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
      } catch (e) { st.erro = e.message || String(e); }
      st.enviando = false; render();
    };
    render(); abrir();
  });
})();
