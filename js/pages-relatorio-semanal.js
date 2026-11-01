// ============================================================
// GLR Consultoria — Relatório semanal do cliente
// ------------------------------------------------------------
// Toda segunda às 08:00 o servidor monta, por cliente, o resumo da semana passada
// (api/_relatorio.js → glr_sync_estado sistema / cliente:<id> / relatorio_semana):
// faturamento, pedidos, ADS e TACOS por marketplace × semana anterior, o que os
// agentes aplicaram e o resultado medido, e o que ficou pendente com o cliente.
// Aqui você revisa, edita se quiser e copia para mandar — nada é enviado daqui.
// ============================================================
Router.register('relatorio-semanal', (params, el) => {
  const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = v => v == null || !isFinite(v) ? '—' : `${(Math.round(v * 10) / 10).toString().replace('.', ',')}%`;
  const dm = iso => iso ? iso.split('-').reverse().slice(0, 2).join('/') : '';
  const st = { lista: [], carregando: true, erro: null, aberto: null, gerando: null, copiado: null, editado: {} };

  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('conta_id,cursor').eq('marketplace', 'sistema').eq('recurso', 'relatorio_semana');
      if (error) throw error;
      st.lista = (data || []).map(r => ({ cid: String(r.conta_id).replace(/^cliente:/, ''), ...r.cursor })).filter(r => r.texto);
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  async function gerar(cid) {
    st.gerando = cid || 'todos'; render();
    try {
      const r = await window.glrApiFetch(`/api/agente-cron?rodada=relatorio&${cid ? `cliente_id=${encodeURIComponent(cid)}` : 'agora=1'}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (cid) delete st.editado[cid];
    } catch (e) { alert('Não consegui gerar o relatório: ' + (e.message || e)); }
    st.gerando = null;
    await carregar();
  }

  function render() {
    const root = document.getElementById('rs-root'); if (!root) return;
    if (st.carregando && !st.lista.length) { root.innerHTML = '<div class="card rs-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card rs-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    const foco = GLR.ctx?.cliente();
    const lista = st.lista.filter(r => !foco || String(r.cid) === String(foco))
      .sort((a, b) => (b.numeros?.total?.fat || 0) - (a.numeros?.total?.fat || 0));
    const semana = lista[0] ? `${dm(lista[0].semana_de)} a ${dm(lista[0].semana_ate)}` : '';
    root.innerHTML = `
      <div class="rs-topo">
        <div class="rs-sub">${lista.length ? `Semana de <b>${semana}</b> · ${lista.length} cliente(s) · gerado toda segunda às 08:00` : 'Nenhum relatório gerado ainda — ele sai toda segunda às 08:00.'}</div>
        <span style="flex:1"></span>
        <button class="btn btn-secondary btn-sm" ${st.gerando ? 'disabled' : ''} onclick="window._rsGerar('')">${st.gerando === 'todos' ? 'Gerando…' : `Gerar ${foco ? 'o deste cliente' : 'todos'} agora`}</button>
      </div>
      ${lista.map(r => {
        const n = r.numeros || {}, t = n.total || {}, aberto = st.aberto === r.cid;
        const varF = t.fat0 > 0 ? (t.fat - t.fat0) / t.fat0 * 100 : null, tacos = t.fat > 0 && t.ads > 0 ? t.ads / t.fat * 100 : null;
        const texto = st.editado[r.cid] ?? r.texto;
        return `<div class="card rs-card${aberto ? ' aberto' : ''}">
          <div class="rs-linha" onclick="window._rsAbrir('${h(r.cid)}')">
            <span class="rs-seta">${aberto ? '▾' : '▸'}</span>
            <b class="rs-nome">${h(r.cliente?.nome || r.cid)}</b>
            <span class="rs-met"><b>${R$(t.fat)}</b>${varF != null ? ` <span style="color:${varF >= 0 ? 'var(--green)' : 'var(--red)'}">${varF >= 0 ? '▲' : '▼'} ${pct(Math.abs(varF))}</span>` : ''}</span>
            <span class="rs-met">TACOS <b>${pct(tacos)}</b></span>
            <span class="rs-met">${n.aplicadas || 0} ajuste(s)${n.medidas ? ` · ${n.melhorou}/${n.medidas} melhoraram` : ''}</span>
            ${n.pendencias ? `<span class="rs-pend">${n.pendencias} pendência(s)</span>` : ''}
          </div>
          ${aberto ? `<div class="rs-corpo">
            <textarea id="rs-txt-${h(r.cid)}" class="form-control rs-txt" oninput="window._rsEditar('${h(r.cid)}', this.value)">${h(texto)}</textarea>
            <div class="rs-bts">
              <button class="btn btn-primary btn-sm" onclick="window._rsCopiar('${h(r.cid)}')">${st.copiado === r.cid ? 'Copiado' : 'Copiar texto'}</button>
              <button class="btn btn-secondary btn-sm" ${st.gerando ? 'disabled' : ''} onclick="window._rsGerar('${h(r.cid)}')">${st.gerando === r.cid ? 'Gerando…' : 'Gerar de novo'}</button>
              ${st.editado[r.cid] != null ? '<span class="rs-sub">editado — gerar de novo desfaz a edição</span>' : '<span class="rs-sub">pode editar antes de copiar</span>'}
            </div>
          </div>` : ''}
        </div>`;
      }).join('')}`;
  }

  window._rsAbrir = cid => { st.aberto = st.aberto === cid ? null : cid; render(); };
  window._rsEditar = (cid, v) => { st.editado[cid] = v; };
  window._rsGerar = cid => gerar(cid || (GLR.ctx?.cliente() || ''));
  window._rsCopiar = async cid => {
    const r = st.lista.find(x => x.cid === cid); if (!r) return;
    const txt = document.getElementById(`rs-txt-${cid}`)?.value ?? st.editado[cid] ?? r.texto;
    try { await navigator.clipboard.writeText(txt); st.copiado = cid; render(); setTimeout(() => { if (st.copiado === cid) { st.copiado = null; render(); } }, 2500); }
    catch (e) { const t = document.getElementById(`rs-txt-${cid}`); if (t) { t.select(); document.execCommand('copy'); } }
  };

  el.innerHTML = `<div class="page">
    <div class="ajuda">O resumo da semana passada de cada cliente, pronto para mandar: faturamento e ADS por marketplace contra a semana anterior, o que os agentes ajustaram e o resultado, e o que precisa do cliente (saldo de ADS, conexões). Revise, edite se quiser e copie — nada é enviado daqui.</div>
    <div id="rs-root"></div>
  </div>
  <style>
    .rs-sub{font-size:12.5px;color:var(--text-muted)}
    .rs-vazio{padding:24px;text-align:center;color:var(--text-muted)}
    .rs-topo{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .rs-card{padding:0;margin-bottom:10px;overflow:hidden}
    .rs-linha{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:12px 16px;cursor:pointer}
    .rs-linha:hover,.rs-card.aberto .rs-linha{background:var(--bg-subtle)}
    .rs-seta{width:12px;color:var(--text-muted)}
    .rs-nome{min-width:160px;flex:1 1 160px}
    .rs-met{font-size:13px;color:var(--text-secondary);font-variant-numeric:tabular-nums}
    .rs-pend{font-size:11.5px;font-weight:650;color:var(--red);background:color-mix(in srgb,var(--red) 12%,transparent);border-radius:99px;padding:2px 8px}
    .rs-corpo{padding:12px 16px 16px;border-top:1px solid var(--border)}
    .rs-txt{width:100%;min-height:260px;font-size:13px;line-height:1.55;resize:vertical;white-space:pre-wrap}
    .rs-bts{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
  </style>`;
  carregar();
});
