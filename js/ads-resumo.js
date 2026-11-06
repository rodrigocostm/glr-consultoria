// ============================================================
// GLR Consultoria — Resumo de ADS (faixa de métricas + gráfico por dia)
// ------------------------------------------------------------
// O mesmo formato do "Resumo de Product Ads" da tela ADS Mercado Livre, para
// usar em outras telas (ADS Shopee → Campanhas). Cada métrica é um botão: ao
// clicar, o gráfico troca para ela. Linha cheia = este mês, tracejada = mês
// anterior no mesmo dia, linha laranja = meta (ACOS/TACOS) ou objetivo (ROAS).
//
// AdsResumo.render({
//   chave,                     // identifica o bloco (guarda a métrica escolhida)
//   titulo, sub,               // título e subtítulo
//   cor,                       // cor da marca (linha e métrica escolhida)
//   aoMudar,                   // função que redesenha a tela ao trocar a métrica
//   mets: [{ k, rot, val, sub, cor }],
//   series: { k: { rot, fmt, eixo, cur: [...], prev: [...], meta, metaRot, vazio } },
//   nomeCur, nomePrev, diasMes, diasAnt,
// }) → HTML
// ============================================================
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const escolha = {}, graf = {}, redesenhar = {};

  function css() {
    if (document.getElementById('ads-resumo-css')) return;
    const st = document.createElement('style'); st.id = 'ads-resumo-css';
    st.textContent = `
      .ar-card{padding:16px 20px 6px;margin-bottom:18px;}
      .ar-t{font-size:16px;font-weight:600;color:var(--text-primary);display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:12px;}
      .ar-sub{font-size:12.5px;color:var(--text-muted);font-weight:400;}
      .ar-mets{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));}
      button.ar-met{background:none;border:none;border-top:3px solid transparent;border-left:1px solid var(--border);text-align:left;font:inherit;color:inherit;cursor:pointer;padding:8px 14px 12px;border-radius:0;min-width:0;}
      button.ar-met:first-child{border-left:none;}
      button.ar-met:hover{background:var(--bg-subtle);}
      button.ar-met:focus-visible{outline:2px solid var(--ar-cor);outline-offset:-2px;}
      button.ar-met.sel{border-top-color:var(--ar-cor);background:color-mix(in srgb,var(--ar-cor) 6%,transparent);}
      button.ar-met.sel .ar-met-rot{color:var(--ar-cor);font-weight:600;}
      .ar-met-rot{font-size:13px;color:var(--text-secondary);margin-bottom:4px;}
      .ar-met-val{font-size:19px;font-weight:600;color:var(--text-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere;line-height:1.3;}
      .ar-met-sub{font-size:12px;color:var(--text-muted);margin-top:2px;}
      @media (max-width:640px){.ar-mets{grid-template-columns:1fr 1fr} button.ar-met{border-left:none;}}
      .ar-graf{border-top:1px solid var(--border);margin-top:4px;padding:12px 0 8px;}
      .ar-leg{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--text-secondary);margin-bottom:6px;}
      .ar-leg span,.ar-tip div{display:inline-flex;align-items:center;gap:6px;}
      .ar-l1,.ar-l2,.ar-l3{display:inline-block;width:16px;height:0;border-top:2px solid var(--ar-cor);}
      .ar-l2{border-top:2px dashed var(--text-muted);} .ar-l3{border-top:2px dashed var(--yellow);}
      .ar-area{position:relative;}
      .ar-area svg{display:block;width:100%;height:auto;overflow:visible;}
      .ar-grade{stroke:var(--border);stroke-width:1;}
      .ar-txt{fill:var(--text-muted);font-size:11px;font-variant-numeric:tabular-nums;}
      .ar-cur{fill:none;stroke:var(--ar-cor);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round;}
      .ar-fill{fill:var(--ar-cor);opacity:.1;stroke:none;}
      .ar-prev{fill:none;stroke:var(--text-muted);stroke-width:1.5;stroke-dasharray:5 4;stroke-linecap:round;}
      .ar-meta{stroke:var(--yellow);stroke-width:1.5;stroke-dasharray:3 4;}
      .ar-pt{fill:var(--ar-cor);stroke:var(--bg-card);stroke-width:2;}
      .ar-guia{stroke:var(--text-muted);stroke-width:1;opacity:0;pointer-events:none;}
      .ar-tip{position:absolute;top:4px;min-width:150px;background:var(--bg-card);border:1px solid var(--border);box-shadow:0 4px 14px rgba(0,0,0,.12);border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.6;pointer-events:none;color:var(--text-primary);}
      .ar-tip div{display:flex;}
      .ar-vazio{border-top:1px solid var(--border);margin-top:4px;padding:28px 0;text-align:center;font-size:13px;color:var(--text-muted);}`;
    document.head.appendChild(st);
  }

  function grafico(o, k) {
    const S = o.series[k];
    if (!S || S.vazio) return `<div class="ar-vazio">${esc(S?.vazio || 'Sem dados por dia para esta métrica.')}</div>`;
    const cur = S.cur || [], prev = S.prev || [], meta = S.meta ?? null;
    const todos = [...cur, ...prev, meta].filter(v => v != null && isFinite(v));
    if (!todos.length) return '<div class="ar-vazio">Sem dados por dia para esta métrica.</div>';
    const bruto = Math.max(...todos) * 1.1 || 1, mag = 10 ** Math.floor(Math.log10(bruto)), topo = [1, 2, 4, 8, 10].map(x => x * mag).find(x => x >= bruto);
    const W = 760, H = 210, L = 64, R = 14, T = 12, B = 26, nDias = Math.max(o.diasMes, o.diasAnt), passo = (W - L - R) / (nDias - 1);
    const X = i => L + i * passo, Y = v => T + (H - T - B) * (1 - v / topo);
    const linha = arr => arr.map((v, i) => v == null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).reduce((acc, p) => { if (p == null) acc.push([]); else acc[acc.length - 1].push(p); return acc; }, [[]]).filter(s => s.length).map(s => s.length === 1 ? `M${s[0]}h0.01` : `M${s.join('L')}`).join('');
    const ultimo = cur.length - 1, cheio = cur.filter(v => v != null).length;
    const area = cheio > 1 ? `M${X(0)},${Y(0)}L${cur.map((v, i) => `${X(i).toFixed(1)},${Y(v || 0).toFixed(1)}`).join('L')}L${X(ultimo)},${Y(0)}Z` : '';
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * topo), xs = [1, 5, 10, 15, 20, 25, 30].filter(x => x <= nDias);
    graf[o.chave] = { W, L, passo, nDias, cur, prev, fmt: S.fmt, nomeCur: o.nomeCur, nomePrev: o.nomePrev };
    const ch = esc(o.chave);
    return `<div class="ar-graf">
      <div class="ar-leg"><span><i class="ar-l1"></i>${esc(S.rot)} em ${esc(o.nomeCur)} (hoje parcial)</span><span><i class="ar-l2"></i>${esc(o.nomePrev)}</span>${meta != null ? `<span><i class="ar-l3"></i>${esc(S.metaRot || 'meta')} ${S.fmt(meta)}</span>` : ''}</div>
      <div class="ar-area">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(S.rot)} por dia" onmousemove="window._arMove(event,this,'${ch}')" onmouseleave="window._arSai(this)">
          ${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" class="ar-grade"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end" class="ar-txt">${S.eixo(t)}</text>`).join('')}
          ${xs.map(x => `<text x="${X(x - 1)}" y="${H - 6}" text-anchor="middle" class="ar-txt">${x}</text>`).join('')}
          ${meta != null ? `<line x1="${L}" x2="${W - R}" y1="${Y(meta)}" y2="${Y(meta)}" class="ar-meta"/>` : ''}
          <path d="${linha(prev)}" class="ar-prev"/>
          ${area ? `<path d="${area}" class="ar-fill"/>` : ''}
          <path d="${linha(cur)}" class="ar-cur"/>
          ${cur[ultimo] != null ? `<circle cx="${X(ultimo)}" cy="${Y(cur[ultimo])}" r="4" class="ar-pt"/>` : ''}
          <line x1="0" x2="0" y1="${T}" y2="${H - B}" class="ar-guia"/>
        </svg>
        <div class="ar-tip" hidden></div>
      </div>
    </div>`;
  }

  function render(o) {
    css();
    redesenhar[o.chave] = o.aoMudar;
    const k = o.series[escolha[o.chave]] ? escolha[o.chave] : o.mets[0].k, ch = esc(o.chave);
    const met = m => `<button type="button" class="ar-met${k === m.k ? ' sel' : ''}" onclick="window._arMet('${ch}','${esc(m.k)}')" aria-pressed="${k === m.k}"><div class="ar-met-rot">${esc(m.rot)}</div><div class="ar-met-val"${m.cor ? ` style="color:${m.cor}"` : ''}>${m.val}</div><div class="ar-met-sub">${m.sub || '&nbsp;'}</div></button>`;
    return `<div class="card ar-card" style="--ar-cor:${o.cor || 'var(--accent)'}">
      <div class="ar-t">${esc(o.titulo)} <span class="ar-sub">${esc(o.sub || '')}</span></div>
      <div class="ar-mets">${o.mets.map(met).join('')}</div>
      ${grafico(o, k)}
    </div>`;
  }

  window._arMet = (chave, k) => { escolha[chave] = k; if (redesenhar[chave]) redesenhar[chave](); };
  window._arMove = (ev, svgEl, chave) => {
    const g = graf[chave]; if (!g) return;
    const box = svgEl.getBoundingClientRect(), x = (ev.clientX - box.left) / box.width * g.W;
    const dia = Math.min(g.nDias, Math.max(1, Math.round((x - g.L) / g.passo) + 1)), cx = g.L + (dia - 1) * g.passo;
    const guia = svgEl.querySelector('.ar-guia'); guia.setAttribute('x1', cx); guia.setAttribute('x2', cx); guia.style.opacity = 1;
    const tip = svgEl.parentNode.querySelector('.ar-tip'), v = g.cur[dia - 1], p = g.prev[dia - 1];
    tip.innerHTML = `<b>Dia ${dia}</b><div><i class="ar-l1"></i>${esc(g.nomeCur)}: <b>${v == null ? '—' : g.fmt(v)}</b></div><div><i class="ar-l2"></i>${esc(g.nomePrev)}: <b>${p == null ? '—' : g.fmt(p)}</b></div>`;
    tip.style.left = `${Math.min(cx / g.W * box.width + 12, box.width - 170)}px`; tip.hidden = false;
  };
  window._arSai = svgEl => { svgEl.querySelector('.ar-guia').style.opacity = 0; svgEl.parentNode.querySelector('.ar-tip').hidden = true; };
  window.AdsResumo = { render };
})();
