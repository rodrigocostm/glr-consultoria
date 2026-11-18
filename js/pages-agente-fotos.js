// ============================================================
// GLR Consultoria — Agente de Fotos
// ------------------------------------------------------------
// Por loja: os anúncios que mais convertem (campeões), o padrão visual das fotos
// deles (análise com IA) e os anúncios com visita boa e conversão baixa. Para
// cada um, "Gerar foto no padrão" cria uma foto principal nova seguindo o padrão
// dos campeões (api/generate-photo.js stage 'padrao'). Nada vai para o anúncio:
// o analista revisa, baixa e decide se publica.
// Quem analisa é o servidor (api/_agente-fotos.js, 1x por semana por loja;
// "Analisar agora" roda na hora) → glr_sync_estado recurso 'fotos'.
// ============================================================
Router.register('agente-fotos', (params, el) => {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const R0 = v => v == null ? '—' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
  const pct = v => v == null ? '—' : String(Math.round(v * 100) / 100).replace('.', ',') + '%';
  const num = v => v == null ? '—' : Number(v).toLocaleString('pt-BR');
  const NOME_MKT = { shopee: 'Shopee', ml: 'Mercado Livre' };
  const lerJ = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (e) { return d; } };
  const st = { lojas: [], sel: params.conta ? `${params.mkt || 'shopee'}:${params.conta}` : (lerJ('glr_af_sel', '') || ''), carregando: true, analisando: false, erro: null, geradas: {}, gerando: {} };

  const idDe = c => String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.external_id);
  const mktDe = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : null; };
  const quando = ms => { if (!ms) return 'nunca'; const d = Math.round((Date.now() - ms) / 864e5); return d <= 0 ? 'hoje' : d === 1 ? 'ontem' : `há ${d} dias`; };

  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('marketplace,conta_id,cursor').eq('recurso', 'fotos').in('marketplace', ['shopee', 'ml']);
      if (error) throw error;
      const analises = new Map((data || []).map(x => [`${x.marketplace}:${x.conta_id}`, x.cursor]));
      // lojas: as do cliente em foco (vínculo) ou todas as já analisadas
      const foco = GLR.ctx?.cliente?.(), vinc = lerJ('glr_mc_vinculos', {}) || {};
      const lista = new Map();
      const add = (mkt, id) => { if (!mkt || !id) return; const k = `${mkt}:${id}`; lista.set(k, { k, mkt, id, nome: GLR.nomeConta(mkt, id), a: analises.get(k) || null }); };
      if (foco) for (const c of (vinc[String(foco)] || [])) add(mktDe(c.marketplace), idDe(c));
      else for (const k of analises.keys()) { const [mkt, id] = k.split(':'); add(mkt, id); }
      const ganho = l => (l.a?.candidatos || []).reduce((s, c) => s + (c.ganhoSem || 0), 0);
      st.lojas = [...lista.values()].sort((a, b) => ganho(b) - ganho(a) || a.nome.localeCompare(b.nome));
      if (!st.lojas.some(l => l.k === st.sel)) st.sel = st.lojas[0]?.k || '';
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }
  async function analisarAgora() {
    const l = st.lojas.find(x => x.k === st.sel); if (!l) return;
    st.analisando = true; render();
    try {
      const r = await window.glrApiFetch(`/api/agente-cron?rodada=fotos&conta=${encodeURIComponent(l.id)}&mkt=${l.mkt}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    } catch (e) { alert('Não consegui analisar agora: ' + (e.message || e)); }
    st.analisando = false;
    await carregar();
  }
  async function gerar(itemId) {
    const l = st.lojas.find(x => x.k === st.sel), a = l?.a, c = a?.candidatos?.find(x => x.id === itemId);
    if (!c?.foto) return;
    st.gerando[itemId] = true; render();
    try {
      const p = a.padrao || {};
      const estilo = [p.prompt, p.fundo && `Fundo: ${p.fundo}`, p.iluminacao && `Luz: ${p.iluminacao}`, p.enquadramento && `Enquadramento: ${p.enquadramento}`, p.angulo && `Ângulo: ${p.angulo}`, p.ambientacao && `Ambientação: ${p.ambientacao}`, c.sugestao && `Corrigir: ${c.sugestao}`].filter(Boolean).join('. ');
      const refs = (a.referencias || []).map(r => r.foto).filter(Boolean).slice(0, 2);
      const r = await window.glrApiFetch('/api/generate-photo', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: c.foto, product_name: c.n, stage: 'padrao', estilo, estilo_urls: refs }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.images?.[0]?.url) (st.geradas[itemId] = st.geradas[itemId] || []).unshift(j.images[0].url);
    } catch (e) { alert('Não consegui gerar a foto: ' + (e.message || e)); }
    delete st.gerando[itemId]; render();
  }
  function ampliar(src) {
    const d = document.createElement('div'); d.className = 'af-lb'; d.innerHTML = `<img src="${h(src)}" alt="">`;
    const fechar = () => { d.remove(); document.removeEventListener('keydown', esc); };
    const esc = e => { if (e.key === 'Escape') fechar(); };
    d.onclick = fechar; document.addEventListener('keydown', esc);
    document.body.appendChild(d);
  }

  const mini = (src, extra = '') => src ? `<button type="button" class="af-mini ${extra}" onclick="window._afAmpliar(this.querySelector('img').src)" title="Ampliar"><img src="${h(src)}" alt="" loading="lazy"></button>` : '<span class="af-mini af-sem">sem foto</span>';
  function render() {
    const root = el.querySelector('#af-root'); if (!root) return;
    if (st.carregando && !st.lojas.length) { root.innerHTML = '<div class="card af-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card af-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    if (!st.lojas.length) { root.innerHTML = `<div class="card af-vazio">${GLR.ctx?.cliente?.() ? 'Este cliente não tem loja Shopee ou Mercado Livre vinculada.' : 'Nenhuma loja analisada ainda. A análise roda de madrugada, 1x por semana — ou escolha um cliente na barra de cima e clique em "Analisar agora".'}</div>`; return; }
    const l = st.lojas.find(x => x.k === st.sel) || st.lojas[0], a = l.a, p = a?.padrao;
    root.innerHTML = `
      <div class="af-topo">
        <label class="af-loja"><span>Loja</span><select class="form-input" onchange="window._afSel(this.value)">${st.lojas.map(x => `<option value="${h(x.k)}" ${x.k === l.k ? 'selected' : ''}>${h(NOME_MKT[x.mkt])} · ${h(x.nome)}${x.a?.candidatos?.length ? ` — ${x.a.candidatos.length} para melhorar` : ''}</option>`).join('')}</select></label>
        <span style="flex:1"></span>
        <span class="af-sub">${a ? `analisado ${quando(a.em)} · ${num(a.analisados)} anúncios com visita suficiente · últimos ${a.janela || '—'} dias` : 'ainda não analisada'}</span>
        <button class="btn btn-secondary btn-sm" ${st.analisando ? 'disabled' : ''} onclick="window._afAnalisar()">${st.analisando ? 'Analisando… (até 1 min)' : '↻ Analisar agora'}</button>
      </div>
      ${!a ? '<div class="card af-vazio">Esta loja ainda não foi analisada. Clique em "Analisar agora".</div>' : `
      ${a.erro ? `<div class="card af-aviso">${h(a.erro)}</div>` : ''}
      ${(a.referencias || []).length ? `<div class="card af-bloco">
        <div class="af-tit">Padrão das fotos que mais vendem <span class="af-sub">conversão mediana da loja ${pct(a.medianaConv)}</span></div>
        ${p ? `<p class="af-resumo">${h(p.resumo || '')}</p>
        <dl class="af-padrao">${[['Fundo', p.fundo], ['Luz', p.iluminacao], ['Enquadramento', p.enquadramento], ['Ângulo', p.angulo], ['Ambientação', p.ambientacao], ['Elementos', p.elementos]].filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${h(v)}</dd></div>`).join('')}</dl>
        ${(p.sequencia || []).length ? `<div class="af-seq"><b>Sequência de fotos:</b> ${p.sequencia.map(h).join(' · ')}</div>` : ''}` : '<p class="af-sub">Sem análise visual (ver aviso acima).</p>'}
        <div class="af-refs">${a.referencias.map(r => `<div class="af-ref">
          <div class="af-fotos">${(r.fotos || []).slice(0, 4).map(f => mini(f)).join('') || mini(null)}</div>
          <div class="af-ref-txt"><b>${h(r.n)}</b><span><em class="af-conv ok">${pct(r.conv)}</em> conversão · ${num(r.visitas)} visitas · ${num(r.un)} vendidos</span>${r.link ? `<a href="${h(r.link)}" target="_blank" rel="noopener">ver anúncio</a>` : ''}</div>
        </div>`).join('')}</div>
      </div>` : ''}
      <div class="af-tit" style="margin:18px 0 8px">Anúncios para trocar a foto principal <span class="af-sub">visita boa, conversão abaixo da metade da mediana</span></div>
      ${(a.candidatos || []).length ? a.candidatos.map(c => `<div class="card af-cand">
        <div class="af-cand-foto">${mini(c.foto, 'grande')}<span class="af-sub">foto atual</span></div>
        <div class="af-cand-txt">
          <b>${h(c.n)}</b>
          <div class="af-nums"><span><em class="af-conv ruim">${pct(c.conv)}</em> conversão <small>(loja ${pct(a.medianaConv)})</small></span><span>${num(c.visitas)} visitas</span><span>${num(c.un)} vendidos</span><span title="Se convertesse como a mediana da loja, com o mesmo preço">~${R0(c.ganhoSem)}/sem a mais</span></div>
          ${c.diferenca ? `<div class="af-dif"><b>O que difere:</b> ${h(c.diferenca)}</div>` : ''}
          ${c.sugestao ? `<div class="af-dif"><b>O que mudar:</b> ${h(c.sugestao)}</div>` : ''}
          <div class="af-acoes">
            <button class="btn btn-primary btn-sm" ${st.gerando[c.id] || !c.foto ? 'disabled' : ''} onclick="window._afGerar('${h(c.id)}')">${st.gerando[c.id] ? 'Gerando… (~30 s)' : (st.geradas[c.id]?.length ? 'Gerar outra' : 'Gerar foto no padrão')}</button>
            ${c.link ? `<a class="btn btn-secondary btn-sm" href="${h(c.link)}" target="_blank" rel="noopener">Ver anúncio</a>` : ''}
          </div>
          ${(st.geradas[c.id] || []).length ? `<div class="af-geradas">${st.geradas[c.id].map((u, i) => `<div class="af-gerada">${mini(u, 'grande')}<a class="af-baixar" href="${h(u)}" download="${h(`foto-${c.id}-${i + 1}.png`)}">Baixar</a></div>`).join('')}</div>
          <div class="af-sub">Revise antes de usar: confira se o produto ficou fiel (cor, formato, detalhes). A foto não vai para o anúncio sozinha.</div>` : ''}
        </div>
      </div>`).join('') : '<div class="card af-vazio">Nenhum anúncio com conversão muito abaixo da loja — as fotos estão no padrão.</div>'}`}`;
  }

  window._afSel = k => { st.sel = k; try { localStorage.setItem('glr_af_sel', JSON.stringify(k)); } catch (e) {} render(); };
  window._afAnalisar = analisarAgora;
  window._afGerar = gerar;
  window._afAmpliar = ampliar;

  el.innerHTML = `<div class="page">
    <div class="ajuda">O Agente de Fotos compara a conversão (vendas ÷ visitas) dos anúncios de cada loja, olha com IA as fotos dos que mais vendem e mostra o padrão visual deles. Para os anúncios com muita visita e pouca venda, gera uma foto principal nova nesse padrão. Nada é publicado sozinho: revise, baixe e use no anúncio.</div>
    <div id="af-root"></div>
  </div>
  <style>
    .af-sub{font-size:12px;color:var(--text-muted);font-weight:400}
    .af-vazio{padding:24px;text-align:center;color:var(--text-muted);margin-bottom:12px}
    .af-aviso{padding:12px 16px;margin-bottom:12px;border-left:3px solid var(--yellow);font-size:13px}
    .af-topo{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
    .af-loja{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text-muted)} .af-loja select{min-width:280px;max-width:100%}
    .af-bloco{padding:16px 18px}
    .af-tit{font-weight:700;font-size:15px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
    .af-resumo{margin:8px 0 10px;font-size:14px}
    .af-padrao{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px 18px;margin:0 0 10px}
    .af-padrao dt{font-size:11.5px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.03em} .af-padrao dd{margin:2px 0 0;font-size:13px}
    .af-seq{font-size:13px;margin-bottom:12px}
    .af-refs{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
    .af-ref{border:1px solid var(--border);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}
    .af-ref-txt{display:flex;flex-direction:column;gap:3px;font-size:12.5px} .af-ref-txt b{font-size:13px}
    .af-fotos{display:flex;gap:6px;flex-wrap:wrap}
    .af-mini{padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;width:64px;height:64px;background:#fff;cursor:zoom-in;display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:var(--text-muted)}
    .af-mini img{width:100%;height:100%;object-fit:cover} .af-mini.grande{width:132px;height:132px} .af-mini:focus-visible{outline:2px solid var(--accent)}
    .af-sem{cursor:default}
    .af-conv{font-style:normal;font-weight:700} .af-conv.ok{color:var(--green)} .af-conv.ruim{color:var(--red)}
    .af-cand{display:flex;gap:16px;padding:14px 16px;margin-bottom:10px;flex-wrap:wrap}
    .af-cand-foto{display:flex;flex-direction:column;gap:4px;align-items:center}
    .af-cand-txt{flex:1;min-width:240px;display:flex;flex-direction:column;gap:6px} .af-cand-txt>b{font-size:14px}
    .af-nums{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums}
    .af-dif{font-size:13px}
    .af-acoes{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
    .af-geradas{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
    .af-gerada{display:flex;flex-direction:column;gap:4px;align-items:center} .af-baixar{font-size:12px}
    .af-lb{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:24px}
    .af-lb img{max-width:100%;max-height:100%;border-radius:8px;background:#fff}
  </style>`;
  carregar();
});
