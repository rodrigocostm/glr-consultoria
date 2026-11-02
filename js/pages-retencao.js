// ============================================================
// GLR Consultoria — Retenção
// ------------------------------------------------------------
// Tela do Agente de Retenção (api/_retencao.js, todo dia às 07:00): risco de
// cada cliente cancelar (0–100), os motivos, o plano de recuperação (uma ação
// por motivo, na ordem do peso) e os produtos que mais caíram. A comissão em
// risco é a do mês do cliente pelo modelo de comissão dele (GLR.comissao).
// "Registrar contato" guarda quando o gestor falou com o cliente
// (glr_retencao_acomp, sincronizado) — a tela mostra há quantos dias.
// Só lê: nada aqui muda o cliente nem o marketplace.
// ============================================================
Router.register('retencao', (params, el) => {
  const R$ = v => 'R$ ' + (Math.round(parseFloat(v) || 0)).toLocaleString('pt-BR');
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const NIVEL = { alto: { t: 'Risco alto', c: 'var(--red)' }, medio: { t: 'Risco médio', c: '#d98b00' }, ok: { t: 'Sem risco', c: 'var(--green)' } };
  const NOME_MKT = { ml: 'ML', shopee: 'Shopee', amazon: 'Amazon', tiktok: 'TikTok', magalu: 'Magalu', shein: 'Shein' };
  const K_ACOMP = 'glr_retencao_acomp';
  const st = { em: null, clientes: [], carregando: true, erro: null, gestor: 'todos', verOk: false, abertos: new Set(), atualizando: false, copiado: null };
  window._rtSt = st;

  const cliente = id => (GLR.clientes || []).find(c => String(c.id) === String(id));
  const comissaoMes = x => { const c = cliente(x.id); return c && GLR.comissao?.temComissao(c) ? GLR.comissao.estimar(c, x.ped30 || 0, x.fat30 || 0) : 0; };
  const acomp = () => lerJSON(K_ACOMP, {});
  const diasDesde = iso => Math.floor((Date.now() - Date.parse(iso)) / 864e5);

  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('cursor').eq('marketplace', 'sistema').eq('conta_id', 'retencao').eq('recurso', 'todas').maybeSingle();
      if (error) throw error;
      st.em = data?.cursor?.em || null;
      st.clientes = Object.entries(data?.cursor?.clientes || {}).map(([id, x]) => ({ id, ...x }));
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
    GLR.quandoClientes(render);
  }

  function plano(x) { // texto para copiar e mandar ao gestor / usar na conversa com o cliente
    const L = [`Plano de recuperação — ${cliente(x.id)?.nome || x.nome} (risco ${x.score}/100)`, '', 'Por que está em risco:'];
    x.motivos.forEach(m => L.push(`• ${m.texto}`));
    L.push('', 'O que fazer:');
    x.motivos.forEach((m, i) => L.push(`${i + 1}. ${m.acao}`));
    if (x.produtos?.length) { L.push('', 'Produtos que mais caíram (14 dias contra os 14 anteriores):'); x.produtos.forEach(p => L.push(`• ${p.nome} (${NOME_MKT[p.mkt] || p.mkt}): ${R$(p.agora)} contra ${R$(p.antes)}`)); }
    return L.join('\n');
  }

  function render() {
    if (window._rtSt !== st) return;
    const root = document.getElementById('rt-root'); if (!root) return;
    if (st.carregando && !st.clientes.length) { root.innerHTML = '<div class="card rt-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card rt-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    if (!st.em) { root.innerHTML = `<div class="card rt-vazio"><b>O agente ainda não avaliou a carteira.</b><span>Ele roda todo dia às 7h.</span><button class="btn btn-primary btn-sm" style="margin-top:10px" ${st.atualizando ? 'disabled' : ''} onclick="window._rtAtualizar()">${st.atualizando ? 'Avaliando…' : 'Avaliar agora'}</button></div>`; return; }
    const foco = GLR.ctx?.cliente();
    const base = st.clientes.filter(x => !foco || x.id === String(foco)).map(x => ({ ...x, nome: cliente(x.id)?.nome || x.nome, com: comissaoMes(x) }));
    const risco = base.filter(x => x.nivel !== 'ok');
    const gestores = [...new Set(risco.map(x => x.gestor || 'Sem gestor'))].sort();
    const lista = base.filter(x => (st.verOk || x.nivel !== 'ok') && (st.gestor === 'todos' || (x.gestor || 'Sem gestor') === st.gestor))
      .sort((a, b) => b.score - a.score || b.com - a.com);
    const alto = risco.filter(x => x.nivel === 'alto'), comRisco = risco.reduce((s, x) => s + x.com, 0);
    root.innerHTML = `
      <div class="rt-topo">
        <div class="rt-num" style="--c:var(--red)"><b>${alto.length}</b><span>cliente(s) em risco alto</span></div>
        <div class="rt-num" style="--c:#d98b00"><b>${risco.length - alto.length}</b><span>em risco médio</span></div>
        <div class="rt-num"><b>${R$(comRisco)}</b><span>de comissão por mês nesses clientes</span></div>
        <span style="flex:1"></span>
        <span class="rt-sub">Avaliado ${new Date(st.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
        <button class="btn btn-secondary btn-sm" ${st.atualizando ? 'disabled' : ''} onclick="window._rtAtualizar()">${st.atualizando ? 'Avaliando…' : 'Avaliar agora'}</button>
      </div>
      <div class="rt-chips">
        ${[['todos', 'Todos os gestores', risco.length], ...gestores.map(g => [g, g, risco.filter(x => (x.gestor || 'Sem gestor') === g).length])].map(([k, t, n]) => `<button class="rt-chip ${st.gestor === k ? 'on' : ''}" onclick="window._rtGestor('${h(k)}')">${h(t)} <b>${n}</b></button>`).join('')}
        <label class="rt-ok"><input type="checkbox" id="rt-ver-ok" ${st.verOk ? 'checked' : ''} onchange="window._rtVerOk(this.checked)"> mostrar clientes sem risco</label>
      </div>
      ${lista.length ? `<div class="rt-lista">${lista.map(card).join('')}</div>` : `<div class="card rt-vazio"><b>Nenhum cliente em risco${st.gestor !== 'todos' ? ` de ${h(st.gestor)}` : ''}.</b><span>Os sinais de venda, meta, saldo, conexão e reputação estão em ordem.</span></div>`}`;
  }

  function card(x) {
    const N = NIVEL[x.nivel], aberto = st.abertos.has(x.id), a = acomp()[x.id];
    const tend = x.score_antes == null ? '' : x.score > x.score_antes ? `<span class="rt-tend pior" title="ontem ${x.score_antes}">▲ ${x.score - x.score_antes}</span>` : x.score < x.score_antes ? `<span class="rt-tend melhor" title="ontem ${x.score_antes}">▼ ${x.score_antes - x.score}</span>` : '';
    return `<div class="card rt-c" style="--c:${N.c}">
      <button type="button" class="rt-c-cab" aria-expanded="${aberto}" onclick="window._rtAbrir('${h(x.id)}')">
        <span class="rt-score"><b>${x.score}</b>${tend}</span>
        <span class="rt-c-nome"><b>${h(x.nome)}</b><span class="rt-sub">${h(x.gestor || 'Sem gestor')}${x.nivel === 'alto' && x.desde ? ` · em risco alto há ${Math.max(0, diasDesde(x.desde))} dia(s)` : ''}${a ? ` · contato há ${diasDesde(a.em)} dia(s)` : ''}</span></span>
        <span class="rt-pill">${N.t}</span>
        <span class="rt-motivos">${x.motivos.slice(0, 3).map(m => `<span>${h(m.texto)}</span>`).join('')}${x.motivos.length > 3 ? `<span>+${x.motivos.length - 3}</span>` : ''}</span>
        <span class="rt-c-res">${x.var14 != null ? `<span><b style="color:${x.var14 < 0 ? 'var(--red)' : 'var(--green)'}">${x.var14 > 0 ? '+' : ''}${x.var14}%</b> em 14 dias</span>` : ''}${x.meta_pct != null ? `<span><b>${x.meta_pct}%</b> da meta</span>` : ''}<span><b>${R$(x.com)}</b>/mês de comissão</span></span>
      </button>
      ${aberto ? `<div class="rt-det">
        <div class="rt-plano">
          <div class="rt-tit">Plano de recuperação</div>
          <ol>${x.motivos.map(m => `<li><b>${h(m.texto)}</b><span>${h(m.acao)}</span></li>`).join('')}</ol>
        </div>
        ${x.produtos?.length ? `<div class="rt-tit" style="padding:0 16px">Produtos que mais caíram — 14 dias contra os 14 anteriores</div>
          <div style="overflow-x:auto;padding:4px 16px 0"><table class="rt-tab" data-todas-colunas><thead><tr><th>Produto</th><th>Canal</th><th class="n">Antes</th><th class="n">Agora</th><th class="n">Diferença</th></tr></thead>
          <tbody>${x.produtos.map(p => `<tr><td>${h(p.nome)}</td><td>${NOME_MKT[p.mkt] || h(p.mkt)}</td><td class="n">${R$(p.antes)}<small>${p.un_antes} un.</small></td><td class="n">${R$(p.agora)}<small>${p.un_agora} un.</small></td><td class="n" style="color:var(--red);font-weight:650">${R$(p.delta)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="rt-acoes">
          <button class="btn btn-primary btn-sm" onclick="window._rtCopiar('${h(x.id)}')">${st.copiado === x.id ? 'Copiado' : 'Copiar plano'}</button>
          <button class="btn btn-secondary btn-sm" onclick="window._rtIr('${h(x.id)}', 'plano-acao')">Abrir Plano de ação</button>
          <button class="btn btn-secondary btn-sm" onclick="window._rtIr('${h(x.id)}', 'cliente-perfil')">Perfil do cliente</button>
          <span style="flex:1"></span>
          ${a ? `<span class="rt-sub">Contato registrado em ${new Date(a.em).toLocaleDateString('pt-BR')}${a.nota ? `: ${h(a.nota)}` : ''}</span>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="window._rtContato('${h(x.id)}')">Registrar contato</button>
        </div>
      </div>` : ''}
    </div>`;
  }

  window._rtAbrir = id => { st.abertos.has(id) ? st.abertos.delete(id) : st.abertos.add(id); render(); };
  window._rtGestor = g => { st.gestor = g; render(); };
  window._rtVerOk = v => { st.verOk = !!v; render(); };
  window._rtIr = (id, tela) => { GLR.ctx?.definir(id, true); Router.navigate(tela, tela === 'cliente-perfil' ? { id } : {}); };
  window._rtCopiar = async id => {
    const x = st.clientes.find(c => c.id === id); if (!x) return;
    const txt = plano(x);
    try { await navigator.clipboard.writeText(txt); st.copiado = id; render(); setTimeout(() => { if (st.copiado === id) { st.copiado = null; render(); } }, 2500); }
    catch (e) { prompt('Copie o plano:', txt); }
  };
  window._rtContato = id => {
    const nota = prompt('O que foi combinado com o cliente? (opcional)', '');
    if (nota === null) return;
    const m = acomp(); m[id] = { em: new Date().toISOString(), nota: nota.trim().slice(0, 200) };
    localStorage.setItem(K_ACOMP, JSON.stringify(m)); render();
  };
  window._rtAtualizar = async () => {
    if (st.atualizando) return;
    st.atualizando = true; render();
    try {
      const r = await window.glrApiFetch('/api/agente-cron?rodada=retencao&agora=1');
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      await carregar();
    } catch (e) { alert('Não consegui avaliar: ' + (e.message || e)); }
    st.atualizando = false; render();
  };

  el.innerHTML = `<div class="page">
    <div class="ajuda">Quais clientes podem cancelar, por quê e o que fazer. O agente soma os sinais todo dia às 7h — loja sem venda, queda de faturamento, meta, saldo de ADS, conexão e reputação — e monta o plano de recuperação. Cliente que entra em risco alto também chega no celular e na Caixa de decisões.</div>
    <div id="rt-root"></div>
  </div>
  <style>
    .rt-sub{font-size:12px;color:var(--text-muted);line-height:1.45}
    .rt-vazio{padding:28px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:4px} .rt-vazio span{font-size:13px;color:var(--text-muted)}
    .rt-topo{display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:12px}
    .rt-num{display:flex;flex-direction:column} .rt-num b{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1;color:var(--c,var(--text-primary))} .rt-num span{font-size:12px;color:var(--text-muted)}
    .rt-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
    .rt-chip{border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
    .rt-chip b{color:var(--text-primary);font-weight:650;margin-left:2px} .rt-chip.on{border-color:var(--accent);background:var(--accent-glow);color:var(--accent-light)}
    .rt-ok{margin-left:auto;font-size:12.5px;color:var(--text-secondary);display:flex;gap:6px;align-items:center;cursor:pointer}
    .rt-lista{display:flex;flex-direction:column;gap:10px}
    .rt-c{padding:0;overflow:hidden;border-left:3px solid var(--c)}
    .rt-c-cab{display:grid;grid-template-columns:54px minmax(150px,1.1fr) auto minmax(0,2fr) auto;gap:14px;align-items:center;width:100%;padding:12px 16px;border:0;background:none;cursor:pointer;text-align:left;font-family:inherit;color:var(--text-primary)}
    .rt-c-cab:hover{background:var(--bg-subtle)} .rt-c-cab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
    .rt-score{display:flex;flex-direction:column;align-items:center;line-height:1} .rt-score b{font-size:22px;font-weight:700;color:var(--c);font-variant-numeric:tabular-nums}
    .rt-tend{font-size:10.5px;font-weight:650;margin-top:3px} .rt-tend.pior{color:var(--red)} .rt-tend.melhor{color:var(--green)}
    .rt-c-nome{display:flex;flex-direction:column;min-width:0} .rt-c-nome b{font-size:14.5px;font-weight:650}
    .rt-pill{font-size:11.5px;font-weight:650;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);border-radius:99px;padding:2px 9px;white-space:nowrap}
    .rt-motivos{display:flex;gap:5px;flex-wrap:wrap;min-width:0} .rt-motivos span{font-size:11.5px;color:var(--text-secondary);background:var(--bg-subtle);border-radius:6px;padding:2px 7px}
    .rt-c-res{display:flex;gap:12px;font-size:12.5px;color:var(--text-muted);white-space:nowrap;justify-content:flex-end;flex-wrap:wrap} .rt-c-res b{color:var(--text-primary);font-variant-numeric:tabular-nums}
    .rt-det{border-top:1px solid var(--border);background:var(--bg-subtle);padding-bottom:12px}
    .rt-tit{font-size:12px;font-weight:650;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em;margin:12px 0 6px}
    .rt-plano{padding:0 16px} .rt-plano ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px}
    .rt-plano li{font-size:13px;line-height:1.45} .rt-plano li b{display:block;font-weight:650} .rt-plano li span{color:var(--text-secondary)}
    .rt-tab{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--bg-surface);border-radius:8px;overflow:hidden}
    .rt-tab th{padding:7px 10px;text-align:left;font-size:11.5px;font-weight:600;color:var(--text-muted);white-space:nowrap}
    .rt-tab td{padding:7px 10px;border-top:1px solid var(--border)} .rt-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums} .rt-tab small{display:block;font-size:11px;color:var(--text-muted)}
    .rt-acoes{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 16px 0}
    @media (max-width:900px){.rt-c-cab{grid-template-columns:48px minmax(0,1fr)}.rt-pill,.rt-motivos,.rt-c-res{grid-column:2;justify-content:flex-start}}
  </style>`;
  carregar();
});
