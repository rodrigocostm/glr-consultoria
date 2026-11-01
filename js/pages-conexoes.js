// ============================================================
// GLR Consultoria — Saúde das conexões
// ------------------------------------------------------------
// Todas as contas de todos os marketplaces numa tela: funcionando, com erro,
// sem permissão de Ads ou atrasada, desde quando e o que fazer. Quem calcula é o
// servidor, de hora em hora (api/agente-cron.js ?rodada=conexoes → glr_sync_estado
// sistema / conexoes / todas): junta a lista de contas da Tiops, o motor de dados
// (último sucesso/erro dos pedidos) e o erro de Ads do monitor de saldo, e avisa
// no celular quando uma conta cai ou volta. Esta tela só lê e mostra.
// ============================================================
Router.register('conexoes', (params, el) => {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const NOME_MKT = { shopee: 'Shopee', ml: 'Mercado Livre', amazon: 'Amazon', tiktok: 'TikTok Shop', magalu: 'Magalu', shein: 'Shein' };
  const ST = {
    erro: { t: 'Com problema', c: 'var(--red)', o: 0 },
    ads: { t: 'Sem permissão de Ads', c: 'var(--yellow)', o: 1 },
    atrasada: { t: 'Sem atualizar há 6 h+', c: 'var(--yellow)', o: 2 },
    sem_sync: { t: 'Ainda não sincronizou', c: 'var(--text-muted)', o: 3 },
    ok: { t: 'Funcionando', c: 'var(--green)', o: 4 },
  };
  const st = { contas: [], em: null, carregando: true, verificando: false, erro: null, mkt: 'todos', busca: '' };

  const quando = iso => {
    if (!iso) return '—';
    const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (min < 60) return `há ${Math.max(1, min)} min`;
    if (min < 48 * 60) return `há ${Math.round(min / 60)} h`;
    return `há ${Math.round(min / 1440)} dias`;
  };
  const dataHora = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('cursor').eq('marketplace', 'sistema').eq('conta_id', 'conexoes').eq('recurso', 'todas').maybeSingle();
      if (error) throw error;
      st.contas = Object.values(data?.cursor?.contas || {});
      st.em = data?.cursor?.em || null; st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  async function verificarAgora() {
    st.verificando = true; render();
    try {
      const r = await window.glrApiFetch('/api/agente-cron?rodada=conexoes&agora=1');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    } catch (e) { alert('Não consegui verificar agora: ' + (e.message || e)); }
    st.verificando = false;
    await carregar();
  }

  function render() {
    const root = document.getElementById('cx-root'); if (!root) return;
    if (st.carregando && !st.contas.length) { root.innerHTML = '<div class="card cx-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card cx-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    if (!st.contas.length) {
      root.innerHTML = `<div class="card cx-vazio">A primeira verificação ainda não rodou (ela roda de hora em hora).<div style="margin-top:12px"><button class="btn btn-primary btn-sm" ${st.verificando ? 'disabled' : ''} onclick="window._cxVerificar()">${st.verificando ? 'Verificando…' : 'Verificar agora'}</button></div></div>`;
      return;
    }
    const cont = k => st.contas.filter(c => c.status === k).length;
    const problemas = st.contas.filter(c => c.status === 'erro' || c.status === 'ads').sort((a, b) => ST[a.status].o - ST[b.status].o || String(a.desde || '').localeCompare(String(b.desde || '')));
    const mkts = [...new Set(st.contas.map(c => c.mkt))].sort((a, b) => (NOME_MKT[a] || a).localeCompare(NOME_MKT[b] || b));
    const q = st.busca.trim().toLowerCase();
    const lista = st.contas.filter(c => (st.mkt === 'todos' || c.mkt === st.mkt) && (!q || `${c.nome} ${c.id}`.toLowerCase().includes(q)))
      .sort((a, b) => (ST[a.status]?.o ?? 9) - (ST[b.status]?.o ?? 9) || (NOME_MKT[a.mkt] || '').localeCompare(NOME_MKT[b.mkt] || '') || String(a.nome).localeCompare(String(b.nome)));
    const pill = c => { const s = ST[c.status] || ST.ok; return `<span class="cx-pill" style="--c:${s.c}">${s.t}</span>`; };
    root.innerHTML = `
      <div class="cx-topo">
        <div class="cx-num" style="--c:var(--red)"><b>${cont('erro')}</b><span>com problema</span></div>
        <div class="cx-num" style="--c:var(--yellow)"><b>${cont('ads')}</b><span>sem permissão de Ads</span></div>
        <div class="cx-num" style="--c:var(--green)"><b>${cont('ok')}</b><span>funcionando</span></div>
        ${cont('atrasada') + cont('sem_sync') ? `<div class="cx-num" style="--c:var(--text-muted)"><b>${cont('atrasada') + cont('sem_sync')}</b><span>atrasadas ou sem sincronizar</span></div>` : ''}
        <span style="flex:1"></span>
        <div class="cx-sub">verificado ${st.em ? quando(new Date(st.em).toISOString()) : '—'} · roda de hora em hora</div>
        <button class="btn btn-secondary btn-sm" ${st.verificando ? 'disabled' : ''} onclick="window._cxVerificar()" title="Verifica todas as contas agora (e avisa no celular se alguma caiu ou voltou)">${st.verificando ? 'Verificando…' : '↻ Verificar agora'}</button>
      </div>
      ${problemas.length ? `<div class="card cx-prob">
        <div class="cx-tit">O que precisa de você</div>
        ${problemas.map(c => `<div class="cx-p" style="--c:${ST[c.status].c}">
          <div class="cx-p-top"><b>${h(c.nome)}</b><span class="cx-mkt">${h(NOME_MKT[c.mkt] || c.mkt)}</span>${pill(c)}<span class="cx-sub">desde ${dataHora(c.desde)}</span></div>
          <div class="cx-acao">${h(c.acao || '')}</div>
          <div class="cx-sub">Último dado recebido: ${c.ultimo_dado ? dataHora(c.ultimo_dado) : 'nunca'}${c.erro ? ` · erro: <span title="${h(c.erro)}">${h(String(c.erro).slice(0, 110))}</span>` : ''}</div>
        </div>`).join('')}
        <a class="btn btn-primary btn-sm" style="margin-top:12px;display:inline-block" href="https://marketplaces.tiops.com.br" target="_blank" rel="noopener">Abrir a Tiops para reconectar</a>
      </div>` : '<div class="card cx-vazio" style="color:var(--green)">Todas as contas estão funcionando.</div>'}
      <div class="cx-filtros">
        <button class="cx-chip ${st.mkt === 'todos' ? 'on' : ''}" onclick="window._cxMkt('todos')">Todas <b>${st.contas.length}</b></button>
        ${mkts.map(m => `<button class="cx-chip ${st.mkt === m ? 'on' : ''}" onclick="window._cxMkt('${m}')">${h(NOME_MKT[m] || m)} <b>${st.contas.filter(c => c.mkt === m).length}</b></button>`).join('')}
        <input id="cx-busca" class="form-control cx-busca" placeholder="Buscar conta…" value="${h(st.busca)}" oninput="window._cxBusca(this.value)">
      </div>
      <div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="cx-tab">
        <thead><tr><th>Conta</th><th>Marketplace</th><th>Situação</th><th>Último dado recebido</th><th>Vence</th></tr></thead>
        <tbody>${lista.map(c => `<tr>
          <td><b>${h(c.nome)}</b><div class="cx-sub">${h(c.id)}</div></td>
          <td>${h(NOME_MKT[c.mkt] || c.mkt)}</td>
          <td>${pill(c)}${c.acao && c.status !== 'erro' && c.status !== 'ads' ? `<div class="cx-sub">${h(c.acao)}</div>` : ''}</td>
          <td>${c.ultimo_dado ? `${dataHora(c.ultimo_dado)} <span class="cx-sub">(${quando(c.ultimo_dado)})</span>` : '<span class="cx-sub">nunca</span>'}</td>
          <td class="cx-sub">${c.vence ? dataHora(c.vence) : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="cx-vazio">Nenhuma conta.</td></tr>'}</tbody>
      </table></div></div>`;
  }

  window._cxVerificar = verificarAgora;
  window._cxMkt = m => { st.mkt = m; render(); };
  window._cxBusca = v => {
    st.busca = v; clearTimeout(window._cxT);
    window._cxT = setTimeout(() => { render(); const b = document.getElementById('cx-busca'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 200);
  };

  el.innerHTML = `<div class="page">
    <div class="ajuda">Todas as contas conectadas e se estão funcionando. Conta com problema para de entrar nas vendas e nos agentes sem ninguém perceber — aqui aparece o que fazer, e o celular avisa quando uma conta cai ou volta (verificação de hora em hora).</div>
    <div id="cx-root"></div>
  </div>
  <style>
    .cx-sub{font-size:12px;color:var(--text-muted)}
    .cx-vazio{padding:24px;text-align:center;color:var(--text-muted);margin-bottom:14px}
    .cx-topo{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
    .cx-num{display:flex;flex-direction:column;line-height:1.2} .cx-num b{font-size:22px;color:var(--c);font-variant-numeric:tabular-nums} .cx-num span{font-size:12px;color:var(--text-muted)}
    .cx-prob{padding:16px 18px;margin-bottom:16px}
    .cx-tit{font-weight:700;font-size:15px;margin-bottom:8px}
    .cx-p{padding:10px 0 10px 12px;border-left:3px solid var(--c);margin-bottom:8px}
    .cx-p-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .cx-acao{font-size:13.5px;color:var(--text-primary);margin:3px 0}
    .cx-mkt{font-size:11.5px;color:var(--text-secondary);background:var(--bg-subtle);border-radius:5px;padding:1px 7px}
    .cx-pill{display:inline-block;font-size:11.5px;font-weight:650;padding:2px 8px;border-radius:99px;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);white-space:nowrap}
    .cx-filtros{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
    .cx-chip{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12px;cursor:pointer}
    .cx-chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
    .cx-busca{max-width:220px;margin-left:auto}
    .cx-tab{width:100%;border-collapse:collapse;font-size:13px}
    .cx-tab th{padding:9px 12px;text-align:left;font-size:11.5px;font-weight:600;color:var(--text-muted);background:var(--bg-card-hover);white-space:nowrap}
    .cx-tab td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
    @media (max-width:640px){.cx-busca{max-width:none;margin-left:0;flex:1 1 100%}}
  </style>`;
  carregar();
});
