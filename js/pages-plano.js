// ============================================================
// GLR Consultoria — Plano de ação (Gerente de Conta)
// ------------------------------------------------------------
// Tela interna do agente central (api/_gerente.js, todo dia às 08:00): por
// cliente, o semáforo, o diagnóstico, até 7 ações priorizadas (hoje / esta
// semana / pedir ao cliente) e a pauta do dia para conversar com o cliente.
// Nada vira tarefa sozinho: "Virar tarefa" cria na Gestão de Tarefas para o
// gestor do cliente; "Feito" e "Descartar" ficam guardados por ação
// (glr_plano_status, sincronizado) e a ação não volta no dia seguinte.
// ============================================================
Router.register('plano-acao', (params, el) => {
  const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const R$ = v => v == null ? '—' : 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const pct = v => v == null ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')}%`;
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const maisDias = n => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  const st = {
    planos: [], aberto: (() => { try { return localStorage.getItem('glr_plano_cliente') || ''; } catch (e) { return ''; } })(),
    filtro: (() => { try { return localStorage.getItem('glr_plano_filtro') || 'todos'; } catch (e) { return 'todos'; } })(),
    meuGestor: null, carregando: true, erro: null, gerando: false, copiado: false,
  };
  const status = () => lerJSON('glr_plano_status', {});
  const salvarStatus = (id, v) => { const s = status(); if (v) s[id] = v; else delete s[id]; localStorage.setItem('glr_plano_status', JSON.stringify(s)); };

  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('conta_id,ultimo_sucesso,cursor').eq('marketplace', 'sistema').eq('recurso', 'plano');
      if (error) throw error;
      st.planos = (data || []).map(r => r.cursor).filter(Boolean);
      try {
        const { data: { user } } = await _sb.auth.getUser();
        const email = String(user?.email || '').toLowerCase();
        const g = (window.GLR?.gestores || []).find(x => [x.email, x.loginEmail].some(e => e && String(e).toLowerCase() === email));
        st.meuGestor = g ? g.id : null;
      } catch (e) {}
      if (st.aberto && !st.planos.some(p => String(p.cliente.id) === st.aberto)) st.aberto = '';
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  const SEM = { vermelho: ['Precisa de atenção hoje', 'var(--red)', 0], amarelo: ['Atenção', 'var(--yellow)', 1], verde: ['Em dia', 'var(--green)', 2] };
  const QUEM = { analista: 'Analista', cliente: 'Cliente', agente: 'Agente' };
  const pendentesDe = p => (p.acoes || []).filter(a => !status()[a.id]);

  function lista() {
    let ps = st.planos.slice();
    if (st.filtro === 'meus' && st.meuGestor != null) ps = ps.filter(p => String(p.cliente.gestorId) === String(st.meuGestor));
    return ps.sort((a, b) => SEM[a.semaforo][2] - SEM[b.semaforo][2] || pendentesDe(b).filter(x => x.quando === 'hoje').length - pendentesDe(a).filter(x => x.quando === 'hoje').length || a.cliente.nome.localeCompare(b.cliente.nome));
  }

  function renderLista() {
    const ps = lista();
    const cont = k => st.planos.filter(p => p.semaforo === k).length;
    return `
      <div class="pl-topo">
        <div class="pl-chips">
          <button class="${st.filtro === 'todos' ? 'on' : ''}" onclick="window._plFiltro('todos')">Todos os clientes <b>${st.planos.length}</b></button>
          <button class="${st.filtro === 'meus' ? 'on' : ''}" ${st.meuGestor == null ? 'disabled title="Seu e-mail não está no cadastro de gestores"' : ''} onclick="window._plFiltro('meus')">Meus clientes</button>
        </div>
        <span class="pl-sub"><b style="color:var(--red)">${cont('vermelho')}</b> precisam de atenção hoje · <b style="color:var(--yellow)">${cont('amarelo')}</b> em atenção · <b style="color:var(--green)">${cont('verde')}</b> em dia</span>
      </div>
      <div class="pl-grid">${ps.map(p => {
        const s = SEM[p.semaforo], pend = pendentesDe(p), hoje = pend.filter(a => a.quando === 'hoje').length, m = p.metricas || {};
        return `<button class="pl-card" style="--c:${s[1]}" onclick="window._plAbrir('${h(p.cliente.id)}')">
          <div class="pl-card-top"><b>${h(p.cliente.nome)}</b><span class="pl-sem"><i></i>${s[0]}</span></div>
          <div class="pl-sub">${h(p.cliente.gestor || 'sem gestor')} · ${m.lojas || 0} loja(s)</div>
          <div class="pl-card-num"><span>Projeção <b>${R$(m.projecao)}</b>${m.pctMeta != null ? ` · ${pct(m.pctMeta)} da meta` : ''}</span><span>TACOS <b>${pct(m.tacos)}</b></span></div>
          <div class="pl-card-diag">${h(String(p.diagnostico || '').slice(0, 170))}${String(p.diagnostico || '').length > 170 ? '…' : ''}</div>
          <div class="pl-card-rod"><span><b>${hoje}</b> para hoje</span><span><b>${pend.length}</b> ação(ões) abertas</span></div>
        </button>`;
      }).join('') || '<div class="pl-sub" style="padding:20px">Nenhum cliente neste filtro.</div>'}</div>`;
  }

  function renderAcao(p, a) {
    const s = status()[a.id];
    return `<div class="pl-acao ${s ? 'resolvida' : ''}" style="--q:${a.quem === 'cliente' ? 'var(--purple)' : 'var(--accent)'}">
      <span class="pl-quem">${QUEM[a.quem] || a.quem}</span>
      <div class="pl-acao-txt"><div class="pl-acao-tit">${h(a.titulo)}</div><div class="pl-sub">${h(a.porque)}</div><div class="pl-sub">${h(a.loja || '')}${a.impacto ? ` · impacto: <b>${h(a.impacto)}</b>` : ''}</div></div>
      <div class="pl-acao-bt">${s ? `<span class="pl-sub">${s.st === 'feito' ? 'Feito' : s.st === 'tarefa' ? 'Virou tarefa' : 'Descartada'}${s.motivo ? ` — ${h(s.motivo)}` : ''}</span><button class="pl-x" title="Reabrir" onclick="window._plReabrir('${h(a.id)}')">↺</button>`
        : `${a.tela ? `<button class="btn btn-secondary btn-sm" onclick="window._plIr('${h(a.tela)}')">Fazer agora</button>` : ''}<button class="btn btn-primary btn-sm" onclick="window._plTarefa('${h(p.cliente.id)}','${h(a.id)}')">Virar tarefa</button><button class="btn btn-secondary btn-sm" onclick="window._plFeito('${h(a.id)}')">Feito</button><button class="pl-x" title="Descartar" onclick="window._plDescartar('${h(a.id)}')">✕</button>`}</div>
    </div>`;
  }

  // Raio-X do faturamento: o que puxou e o que derrubou nas últimas 2 semanas
  function renderRaioX(rx, m) {
    if (!rx) return `<div class="card pl-bloco"><div class="pl-bloco-t">Raio-X do faturamento</div><div class="pl-sub">Sem pedidos suficientes na base para comparar as últimas 2 semanas.</div></div>`;
    const sinal = v => v == null ? '' : `<span style="color:${v >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:650">${v >= 0 ? '+' : ''}${pct(v)}</span>`;
    const linhaCaiu = x => `<tr><td><b>${h(x.nome)}</b><div class="pl-sub">${h(x.loja)}</div></td><td class="n">${R$(x.antes)}</td><td class="n">${R$(x.agora)}</td><td class="n" style="color:var(--red);font-weight:650">−${R$(x.perdaSem)}</td>
      <td>${x.causas.length ? x.causas.map(c => `<span class="pl-causa pl-c-${h(c.tipo)}">${h(c.t)}</span>`).join(' ') : '<span class="pl-sub">sem causa clara nos dados — conferir concorrência, posição e avaliações</span>'}</td></tr>`;
    const linhaSubiu = x => `<tr><td><b>${h(x.nome)}</b><div class="pl-sub">${h(x.loja)}</div></td><td class="n">${R$(x.antes)}</td><td class="n">${R$(x.agora)}</td><td class="n" style="color:var(--green);font-weight:650">+${R$(x.ganhoSem)}</td>
      <td>${x.novo ? '<span class="pl-causa">começou a vender agora</span> ' : ''}${x.alerta ? `<span class="pl-causa pl-c-estoque">${h(x.alerta)}</span>` : '<span class="pl-sub">manter o que está funcionando</span>'}</td></tr>`;
    const cab = `<thead><tr><th>Produto</th><th class="n">Antes /sem</th><th class="n">Agora /sem</th><th class="n">Diferença</th><th>Por quê</th></tr></thead>`;
    return `<div class="card pl-bloco">
      <div class="pl-bloco-t">Raio-X do faturamento <span class="pl-sub">${h(rx.periodo.agora)} × ${h(rx.periodo.antes)} · pedidos válidos, por semana</span></div>
      <div class="pl-mets" style="margin-top:0">
        <div><span>Faturamento por semana</span><b>${R$(rx.semanaAgora)}</b><small>antes ${R$(rx.semanaAntes)} ${sinal(rx.var)}</small></div>
        ${m.faltaPorDia ? `<div><span>Para bater a meta</span><b>${R$(m.faltaPorDia)}/dia</b><small>hoje faz ${R$(m.ritmoDia)}/dia</small></div>` : ''}
        <div><span>Concentração</span><b>${pct(rx.concentracaoTop5)}</b><small>do faturamento em 5 produtos</small></div>
        <div><span>Produtos que pararam</span><b>${rx.produtosQueZeraram}</b><small>vendiam (3+ un.) e zeraram</small></div>
      </div>
      ${rx.lojas.length > 1 ? `<div class="pl-lojas">${rx.lojas.map(l => `<span>${h(l.loja)}: ${R$(l.agora)}/sem ${sinal(l.var)}</span>`).join('')}</div>` : ''}
      ${rx.caiu.length ? `<div class="pl-rx-t">O que derrubou</div><div style="overflow-x:auto"><table class="pl-rx">${cab}<tbody>${rx.caiu.map(linhaCaiu).join('')}</tbody></table></div>` : '<div class="pl-sub" style="margin-top:8px">Nenhum produto com queda relevante.</div>'}
      ${rx.subiu.length ? `<div class="pl-rx-t">O que puxou</div><div style="overflow-x:auto"><table class="pl-rx">${cab}<tbody>${rx.subiu.map(linhaSubiu).join('')}</tbody></table></div>` : ''}
    </div>`;
  }

  function renderPlano(p) {
    const s = SEM[p.semaforo], m = p.metricas || {};
    const grupos = [['Fazer hoje', a => a.quando === 'hoje' && a.quem !== 'cliente'], ['Esta semana', a => a.quando !== 'hoje' && a.quem !== 'cliente'], ['Pedir ao cliente', a => a.quem === 'cliente']];
    const quando = p.em ? new Date(p.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    return `
      <div class="pl-head">
        <button class="btn btn-secondary btn-sm" onclick="window._plAbrir('')">← Todos</button>
        <select class="form-control" style="max-width:280px" onchange="window._plAbrir(this.value)">${lista().map(x => `<option value="${h(x.cliente.id)}" ${String(x.cliente.id) === String(p.cliente.id) ? 'selected' : ''}>${h(x.cliente.nome)}</option>`).join('')}</select>
        <span class="pl-sub" style="flex:1">plano de ${quando}${p.fonteTexto === 'ia' ? ' · texto escrito com IA a partir dos números' : ''}</span>
        <button class="btn btn-secondary btn-sm" ${st.gerando ? 'disabled' : ''} onclick="window._plGerar('${h(p.cliente.id)}')">${st.gerando ? 'Gerando…' : 'Gerar plano agora'}</button>
      </div>
      <div class="card pl-diag" style="--c:${s[1]}">
        <div class="pl-diag-top"><b>${h(p.cliente.nome)}</b><span class="pl-sem"><i></i>${s[0]}</span><span class="pl-sub">${h(p.cliente.gestor || '')}</span></div>
        <div class="pl-diag-txt">${h(p.diagnostico)}</div>
        <div class="pl-mets">
          <div><span>Faturamento do mês</span><b>${R$(m.faturamento)}</b><small>até ontem · dia ${m.dia}/${m.diasMes}</small></div>
          <div><span>Projeção</span><b>${R$(m.projecao)}</b><small>${m.meta ? `meta ${R$(m.meta)} · ${pct(m.pctMeta)}` : 'sem meta cadastrada'}</small></div>
          <div><span>TACOS do mês</span><b style="color:${m.metaTacos && m.tacos > m.metaTacos ? 'var(--red)' : 'inherit'}">${pct(m.tacos)}</b><small>${m.metaTacos ? `meta ${pct(m.metaTacos)}` : ''}</small></div>
          <div><span>Contra o mês passado</span><b>${m.varMes == null ? '—' : `${m.varMes >= 0 ? '+' : ''}${pct(m.varMes)}`}</b><small>mesmo período</small></div>
          <div><span>Resultados medidos (7 d)</span><b>${p.resultados?.medidas || 0}</b><small>${p.resultados?.melhoraram || 0} melhoraram</small></div>
        </div>
      </div>
      ${renderRaioX(p.raioX, m)}
      <div class="pl-cols">
        <div>${grupos.map(([t, fn]) => { const as = (p.acoes || []).filter(fn); return as.length ? `<div class="card pl-bloco"><div class="pl-bloco-t">${t} <span class="pl-sub">${as.filter(a => !status()[a.id]).length} aberta(s)</span></div>${as.map(a => renderAcao(p, a)).join('')}</div>` : ''; }).join('') || '<div class="card pl-bloco"><div class="pl-sub">Nenhuma ação hoje — os agentes não encontraram nada urgente.</div></div>'}</div>
        <div class="card pl-pauta">
          <div class="pl-bloco-t">Pauta do dia com o cliente <span class="pl-sub">interna — revise antes de enviar</span></div>
          <textarea id="pl-pauta" class="form-control" rows="14">${h(p.pauta)}</textarea>
          <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="window._plCopiar()">${st.copiado ? 'Copiado' : 'Copiar pauta'}</button>
        </div>
      </div>`;
  }

  function render() {
    const root = document.getElementById('pl-root'); if (!root) return;
    if (st.carregando && !st.planos.length) { root.innerHTML = '<div class="pl-sub" style="padding:30px">Carregando…</div>'; return; }
    if (!st.planos.length) { root.innerHTML = `<div class="card" style="padding:22px"><b>O Gerente de Conta ainda não montou planos.</b><div class="pl-sub" style="margin-top:6px">Ele roda todo dia às 08:00, depois da revisão dos agentes de ADS, para cada cliente com lojas na sincronização automática.</div>${st.erro ? `<div class="pl-sub" style="color:var(--red)">${h(st.erro)}</div>` : ''}</div>`; return; }
    const p = st.aberto && st.planos.find(x => String(x.cliente.id) === st.aberto);
    root.innerHTML = p ? renderPlano(p) : renderLista();
  }

  window._plFiltro = k => { st.filtro = k; try { localStorage.setItem('glr_plano_filtro', k); } catch (e) {} render(); };
  window._plAbrir = id => { st.aberto = String(id || ''); st.copiado = false; try { localStorage.setItem('glr_plano_cliente', st.aberto); } catch (e) {} render(); window.scrollTo?.(0, 0); };
  window._plIr = tela => Router.navigate(tela);
  window._plFeito = id => { salvarStatus(id, { st: 'feito', em: Date.now() }); render(); };
  window._plReabrir = id => { salvarStatus(id, null); render(); };
  window._plDescartar = id => { const motivo = prompt('Por que descartar esta ação? (opcional)'); if (motivo === null) return; salvarStatus(id, { st: 'descartado', em: Date.now(), motivo: motivo.slice(0, 140) }); render(); };
  window._plTarefa = (cid, id) => {
    const p = st.planos.find(x => String(x.cliente.id) === String(cid)), a = p?.acoes.find(x => x.id === id); if (!a) return;
    const cli = (window.GLR?.clientes || []).find(c => String(c.id) === String(cid));
    const resp = (window.GLR?.gestores || []).find(g => g.id === (cli?.gestorId ?? p.cliente.gestorId))?.nome || p.cliente.gestor || '';
    const tarefa = { id: GLR.nextId(GLR.tarefas), titulo: a.quem === 'cliente' ? `Pedir ao cliente: ${a.titulo}` : a.titulo, cliente: p.cliente.nome, clienteId: cli ? cli.id : p.cliente.id,
      responsavel: resp, status: 'pendente', prioridade: a.quando === 'hoje' ? 'alta' : 'media', prazo: a.quando === 'hoje' ? hojeISO() : maisDias(7),
      categoria: 'Plano de ação', notas: `${a.porque}${a.impacto ? ` · Impacto: ${a.impacto}` : ''} · ${a.loja || ''} (Gerente de Conta, ${new Date(p.em).toLocaleDateString('pt-BR')})` };
    GLR.tarefas.push(tarefa);
    localStorage.setItem('glr_tarefas', JSON.stringify(GLR.tarefas)); // sincroniza (supabase-init)
    salvarStatus(id, { st: 'tarefa', em: Date.now(), tarefaId: tarefa.id });
    render();
  };
  window._plCopiar = () => { const t = document.getElementById('pl-pauta')?.value || ''; navigator.clipboard?.writeText(t).then(() => { st.copiado = true; render(); }, () => alert('Não consegui copiar — selecione o texto e copie.')); };
  window._plGerar = async cid => {
    st.gerando = true; render();
    try {
      const r = await fetch(`/api/agente-cron?rodada=gerente&cliente_id=${encodeURIComponent(cid)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    } catch (e) { alert('Não consegui gerar o plano agora: ' + (e.message || e)); }
    st.gerando = false; await carregar();
  };

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <h1 style="font-size:22px;font-weight:650;letter-spacing:-.02em;margin:0">Plano de ação</h1>
      <span class="pl-sub">o Gerente de Conta junta o que todos os agentes viram e diz o que fazer em cada cliente hoje — uso interno</span>
    </div>
    <div id="pl-root"></div>
  </div>
  <style>
    .pl-sub{font-size:12px;color:var(--text-muted)}
    .pl-topo{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .pl-chips{display:flex;gap:6px} .pl-chips button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
    .pl-chips button.on{background:var(--text-primary);border-color:var(--text-primary);color:var(--bg-card)} .pl-chips button:disabled{opacity:.5;cursor:default}
    .pl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
    .pl-card{all:unset;box-sizing:border-box;cursor:pointer;display:flex;flex-direction:column;gap:6px;background:var(--bg-card);border:1px solid var(--border);border-left:4px solid var(--c);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow-xs)}
    .pl-card:hover{box-shadow:var(--shadow-sm)} .pl-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .pl-card-top{display:flex;justify-content:space-between;gap:8px;align-items:center} .pl-card-top b{font-size:14.5px;color:var(--text-primary)}
    .pl-sem{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:var(--c);white-space:nowrap} .pl-sem i{width:8px;height:8px;border-radius:50%;background:var(--c)}
    .pl-card-num{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--text-secondary);flex-wrap:wrap} .pl-card-num b{color:var(--text-primary);font-variant-numeric:tabular-nums}
    .pl-card-diag{font-size:12.5px;color:var(--text-secondary);line-height:1.45}
    .pl-card-rod{display:flex;gap:14px;font-size:12px;color:var(--text-muted)} .pl-card-rod b{color:var(--text-primary)}
    .pl-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .pl-diag{padding:14px 16px;margin-bottom:14px;border-left:4px solid var(--c)} .pl-diag-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px} .pl-diag-top b{font-size:16px}
    .pl-diag-txt{font-size:13.5px;line-height:1.55;color:var(--text-primary);max-width:900px}
    .pl-mets{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}
    .pl-mets>div{background:var(--bg-subtle);border-radius:10px;padding:8px 11px;display:flex;flex-direction:column;gap:1px} .pl-mets span{font-size:12px;color:var(--text-secondary)} .pl-mets b{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums} .pl-mets small{font-size:11px;color:var(--text-muted)}
    .pl-cols{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(300px,1fr);gap:14px;align-items:start} @media (max-width:1050px){.pl-cols{grid-template-columns:1fr}}
    .pl-rx{width:100%;border-collapse:collapse;font-size:12.5px} .pl-rx th{font-size:11px;font-weight:600;color:var(--text-muted);text-align:left;padding:5px 8px} .pl-rx td{padding:7px 8px;border-top:1px solid var(--border);vertical-align:top} .pl-rx .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    .pl-rx-t{font-weight:650;font-size:13px;margin:14px 0 4px} .pl-lojas{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;margin-top:10px;color:var(--text-secondary)}
    .pl-causa{display:inline-block;font-size:11.5px;padding:2px 7px;border-radius:6px;background:var(--bg-subtle);margin:1px 0} .pl-c-estoque{background:color-mix(in srgb,var(--orange) 15%,transparent)} .pl-c-ads{background:color-mix(in srgb,var(--accent) 14%,transparent)} .pl-c-preco{background:color-mix(in srgb,var(--purple) 14%,transparent)} .pl-c-anuncio,.pl-c-qualidade{background:color-mix(in srgb,var(--red) 12%,transparent)}
    .pl-bloco{padding:12px 14px;margin-bottom:12px} .pl-bloco-t{font-weight:650;font-size:14px;margin-bottom:8px;display:flex;gap:8px;align-items:baseline}
    .pl-acao{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:6px 12px;align-items:center;padding:9px 0;border-top:1px solid var(--border)}
    .pl-acao.resolvida{opacity:.55} .pl-quem{font-size:11px;font-weight:650;color:var(--q)}
    .pl-acao-tit{font-size:13px;font-weight:600;color:var(--text-primary)} .pl-acao-txt .pl-sub{line-height:1.45}
    .pl-acao-bt{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
    .pl-x{border:1px solid var(--border);background:none;border-radius:8px;width:28px;height:28px;cursor:pointer;color:var(--text-muted)}
    @media (max-width:760px){.pl-acao{grid-template-columns:1fr}.pl-acao-bt{justify-content:flex-start}}
    .pl-pauta{padding:12px 14px;position:sticky;top:12px} .pl-pauta textarea{font-size:13px;line-height:1.5;resize:vertical}
  </style>`;
  carregar();
});
