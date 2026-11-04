// ============================================================
// GLR Consultoria — Atendimento com IA (tela do Portal do Cliente)
// ------------------------------------------------------------
// Só aparece para o cliente com o módulo liberado pela GLR (admin do portal).
// A IA responde sozinha, a cada ~15 min, perguntas e mensagens pós-venda do
// Mercado Livre e conversas da Magalu (api/_atendimento-ia.js); aqui o cliente
// vê o que foi respondido e responde o que ficou com ele (reclamação, troca,
// informação que não está no anúncio…). Servidor: api/atendimento.js.
// ============================================================
Router.register('atendimento-ia', (params, el) => {
  const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const quando = iso => { const d = (Date.now() - new Date(iso).getTime()) / 3600e3; return d < 1 ? 'agora há pouco' : d < 24 ? `há ${Math.round(d)} h` : new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  const ABAS = [['pendente', 'Para você responder'], ['respondida', 'Respondidas'], ['todas', 'Tudo']];
  const STATUS = { respondida_ia: ['Respondida pela IA', 'var(--green)'], respondida_cliente: ['Respondida por você', 'var(--green)'], pendente: ['Para você responder', 'var(--orange, #D9480F)'], sem_resposta: ['Não precisava de resposta', 'var(--text-muted)'], resolvida: ['Resolvida na plataforma', 'var(--text-muted)'] };
  const st = { itens: [], resumo: null, liberado: null, erro: null, carregando: true, aba: 'pendente', proc: {} };
  window._aiaSt = st;

  async function api(corpo) {
    const r = await window.glrApiFetch('/api/atendimento', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  async function carregar() {
    st.carregando = true; render();
    try { const j = await api({ acao: 'listar' }); st.itens = j.itens || []; st.resumo = j.resumo || null; st.liberado = j.liberado; st.erro = null; }
    catch (e) { st.erro = e.message; }
    st.carregando = false; render();
  }
  const naAba = (i, k) => k === 'todas' || (k === 'pendente' ? i.dados?.status === 'pendente' : /^respondida/.test(i.dados?.status || ''));

  function card(i) {
    const d = i.dados || {}, [rot, cor] = STATUS[d.status] || ['—', 'var(--text-muted)'], pend = d.status === 'pendente', proc = st.proc[i.id];
    const limite = /pós-venda/.test(d.canal || '') ? 350 : /Pergunta/.test(d.canal || '') ? 2000 : 1000;
    return `<article class="card aia-card${pend ? ' aia-pend' : ''}">
      <div class="aia-top"><span class="aia-canal">${h(d.canal || 'Atendimento')}</span><span class="aia-st" style="--c:${cor}">${h(rot)}</span><span class="aia-q">${h(quando(i.criado_em))}</span></div>
      ${d.produto ? `<div class="aia-prod">${h(d.produto)}</div>` : ''}
      <div class="aia-msg"><span class="aia-lb">Comprador</span><p>${h(d.pergunta || '—')}</p></div>
      ${d.resposta ? `<div class="aia-msg aia-resp"><span class="aia-lb">${d.status === 'respondida_cliente' ? 'Sua resposta' : 'Resposta enviada'}</span><p>${h(d.resposta)}</p></div>` : ''}
      ${pend ? `<div class="aia-motivo">Ficou com você: ${h(d.motivo || 'precisa de alguém da loja')}.</div>
        <label class="aia-lb" for="aia-tx-${h(i.id)}">Sua resposta${d.rascunho ? ' (sugestão da IA — revise antes de enviar)' : ''}</label>
        <textarea id="aia-tx-${h(i.id)}" class="form-control" rows="3" maxlength="${limite}" placeholder="Escreva a resposta para o comprador">${h(d.rascunho || '')}</textarea>
        <div class="aia-bts"><button class="btn btn-primary btn-sm" ${proc ? 'disabled' : ''} onclick="window._aiaResponder('${h(i.id)}')">${proc === 'enviando' ? 'Enviando…' : 'Enviar resposta'}</button>
        <button class="btn btn-ghost btn-sm" ${proc ? 'disabled' : ''} onclick="window._aiaResolver('${h(i.id)}')">Já respondi na plataforma</button><span class="aia-sub">até ${limite} caracteres</span></div>` : ''}
      ${d.status === 'sem_resposta' && d.motivo ? `<div class="aia-sub">${h(d.motivo)}</div>` : ''}
    </article>`;
  }

  function render() {
    if (window._aiaSt !== st) return;
    const root = document.getElementById('aia-root'); if (!root) return;
    if (st.carregando && !st.itens.length) { root.innerHTML = '<div class="card aia-vazio">Carregando os atendimentos…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card aia-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    if (st.liberado === false) { root.innerHTML = '<div class="card aia-vazio"><b>O Atendimento com IA não está ativo na sua conta.</b><span>Fale com a GLR Consultoria para ativar.</span></div>'; return; }
    const r = st.resumo || {}, n = k => st.itens.filter(i => naAba(i, k)).length;
    const lista = st.itens.filter(i => naAba(i, st.aba));
    root.innerHTML = `
      <div class="aia-kpis">
        <div class="card aia-kpi"><span>Respondidas pela IA no mês</span><b>${r.respondidas_ia ?? 0}</b></div>
        <div class="card aia-kpi"><span>Respondidas por você no mês</span><b>${r.respondidas_cliente ?? 0}</b></div>
        <div class="card aia-kpi${r.pendentes ? ' aia-kpi-at' : ''}"><span>Esperando você</span><b>${r.pendentes ?? 0}</b></div>
      </div>
      <div class="aia-abas" role="tablist">${ABAS.map(([k, t]) => `<button role="tab" aria-selected="${st.aba === k}" class="${st.aba === k ? 'on' : ''}" onclick="window._aiaAba('${k}')">${t} <b>${n(k)}</b></button>`).join('')}
        <span style="flex:1"></span><button class="btn btn-ghost btn-sm" onclick="window._aiaRecarregar()">Atualizar</button></div>
      ${lista.length ? `<div class="aia-lista">${lista.map(card).join('')}</div>`
        : `<div class="card aia-vazio"><b>${st.aba === 'pendente' ? 'Nada esperando você.' : 'Nenhum atendimento nos últimos 30 dias.'}</b><span>A IA confere as perguntas e mensagens a cada 15 minutos, mais ou menos.</span></div>`}`;
  }

  window._aiaAba = k => { st.aba = k; render(); };
  window._aiaRecarregar = () => carregar();
  window._aiaResponder = async id => {
    const texto = (document.getElementById(`aia-tx-${id}`)?.value || '').trim();
    if (!texto) { alert('Escreva a resposta antes de enviar.'); return; }
    st.proc[id] = 'enviando'; render();
    try { const j = await api({ acao: 'responder', id, texto }); const k = st.itens.findIndex(x => x.id === id); if (k >= 0) st.itens[k] = j.item; if (st.resumo) { st.resumo.pendentes = Math.max(0, st.resumo.pendentes - 1); st.resumo.respondidas_cliente++; } }
    catch (e) { alert('Não consegui enviar: ' + e.message); }
    delete st.proc[id]; render();
  };
  window._aiaResolver = async id => {
    st.proc[id] = 'resolvendo'; render();
    try { const j = await api({ acao: 'resolver', id }); const k = st.itens.findIndex(x => x.id === id); if (k >= 0) st.itens[k] = j.item; if (st.resumo) st.resumo.pendentes = Math.max(0, st.resumo.pendentes - 1); }
    catch (e) { alert('Não consegui marcar: ' + e.message); }
    delete st.proc[id]; render();
  };

  el.innerHTML = `<div class="aia-wrap">
    <header class="aia-head"><h2>Atendimento</h2><p>A IA responde sozinha as perguntas e mensagens do Mercado Livre e as conversas da Magalu, só com o que está no anúncio e no pedido. Reclamação, troca, devolução e o que ela não souber ficam aqui para você responder.</p></header>
    <div id="aia-root"></div></div>
  <style>
    .aia-wrap{padding:24px;max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
    .aia-head h2{margin:0 0 4px;font-size:20px} .aia-head p{margin:0;font-size:13px;color:var(--text-secondary);max-width:70ch}
    .aia-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .aia-kpi{padding:14px 16px;display:flex;flex-direction:column;gap:4px} .aia-kpi span{font-size:12px;color:var(--text-secondary)} .aia-kpi b{font-size:22px;font-variant-numeric:tabular-nums}
    .aia-kpi-at b{color:var(--orange,#D9480F)}
    .aia-abas{display:flex;gap:6px;align-items:center;flex-wrap:wrap} .aia-abas [role=tab]{border:1px solid var(--border);background:var(--bg-surface);border-radius:99px;padding:6px 14px;font-size:13px;cursor:pointer;color:var(--text-secondary)}
    .aia-abas [role=tab].on{background:var(--text-primary);color:var(--bg-surface);border-color:var(--text-primary)} .aia-abas [role=tab] b{font-variant-numeric:tabular-nums;margin-left:4px}
    .aia-lista{display:flex;flex-direction:column;gap:10px}
    .aia-card{padding:14px 18px;display:flex;flex-direction:column;gap:8px} .aia-pend{border-left:3px solid var(--orange,#D9480F)}
    .aia-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px} .aia-canal{font-weight:600} .aia-st{color:var(--c);font-weight:600} .aia-q{color:var(--text-muted);margin-left:auto}
    .aia-prod{font-size:12.5px;color:var(--text-secondary)}
    .aia-msg{display:flex;flex-direction:column;gap:2px} .aia-msg p{margin:0;font-size:14px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
    .aia-resp{background:var(--bg-subtle,#f4f6fa);border-radius:8px;padding:8px 10px}
    .aia-lb{font-size:11px;font-weight:600;color:var(--text-secondary);letter-spacing:.02em}
    .aia-motivo{font-size:13px;color:var(--orange,#D9480F)}
    .aia-bts{display:flex;gap:8px;align-items:center;flex-wrap:wrap} .aia-sub{font-size:12px;color:var(--text-muted)}
    .aia-vazio{padding:28px;text-align:center;display:flex;flex-direction:column;gap:6px;color:var(--text-secondary)} .aia-vazio b{color:var(--text-primary)}
    @media (max-width:640px){.aia-wrap{padding:16px}.aia-kpis{grid-template-columns:1fr}}
  </style>`;
  carregar();
});
