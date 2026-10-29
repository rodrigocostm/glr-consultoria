// ============================================================
// GLR Consultoria — Caixa de decisões
// ------------------------------------------------------------
// Tudo que pede uma decisão do analista, de todos os agentes e clientes, numa
// fila só — ordenada pelo que vence primeiro e depois pelo R$ em jogo:
//  • ADS Shopee: sugestões fora do limite automático (inclusive o freio de
//    volume) → Aprovar executa na Shopee (mesma regra do ADS Shopee, js/acoes-agente.js);
//  • ADS Mercado Livre: passos do pacote → aplicar no painel do ML e marcar Feito;
//  • Faturamento: as quedas do Raio-X do Gerente (Plano de ação);
//  • Reputação: reclamação com prazo vencendo;
//  • Promoções: promoções que cabem na margem.
// "Abrir" leva para a tela certa já no cliente da decisão (cliente em foco).
// ============================================================
Router.register('decisoes', (params, el) => {
  const R$ = v => 'R$ ' + (Math.round(parseFloat(v) || 0)).toLocaleString('pt-BR');
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const corta = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const dataCurta = iso => iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';
  const TIPOS = {
    'reputacao': { t: 'Reputação', c: 'var(--red)' },
    'ads-shopee': { t: 'ADS Shopee', c: '#eb6834' },
    'ads-ml': { t: 'ADS ML', c: '#d9a400' },
    'faturamento': { t: 'Faturamento', c: 'var(--accent)' },
    'promocoes': { t: 'Promoções', c: 'var(--purple)' },
  };
  const ACAO_REC = { send_attachments: 'Enviar provas', send_message_to_mediator: 'Responder ao mediador', refund: 'Resolver reembolso' };
  const st = { itens: [], carregando: true, erro: null, filtro: 'todos', abertos: new Set(), sel: new Set(), proc: {}, lote: null, limite: 120 };
  window._dcSt = st;

  // decisões que não ficam no registro dos agentes (plano, reputação, promoções): feito/descartado por aqui
  const K_OK = 'glr_decisoes_ok';
  const resolvidasLocais = () => lerJSON(K_OK, {});
  const resolverLocal = id => { const m = resolvidasLocais(); m[id] = Date.now(); for (const k of Object.keys(m)) if (Date.now() - m[k] > 30 * 864e5) delete m[k]; localStorage.setItem(K_OK, JSON.stringify(m)); };

  function acaoShopee(d) {
    if (d.retomar) return `Reativar${d.roas_sugerido != null ? ` com ROAS ${d.roas_sugerido}x` : ''}`;
    if (d.pausar) return 'Pausar campanha';
    if (d.roas_sugerido != null) return `ROAS ${d.roas_atual ?? '?'}x → ${d.roas_sugerido}x`;
    if (d.budget_sugerido != null) return `Orçamento ${R$(d.budget_atual)} → ${R$(d.budget_sugerido)}/dia`;
    return '';
  }

  async function carregar() {
    st.carregando = true; render();
    try {
      const desde = new Date(Date.now() - 10 * 864e5).toISOString();
      const [logs, planos, reps, promos] = await Promise.all([
        _sb.from('glr_agente_log').select('id,conta_id,cliente_nome,titulo,explicacao,dados,criado_em').eq('tipo', 'alerta').eq('resultado', 'so_alerta').gte('criado_em', desde).order('criado_em', { ascending: false }).limit(3000),
        _sb.from('glr_sync_estado').select('conta_id,cursor').eq('marketplace', 'sistema').eq('recurso', 'plano'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,rec:cursor->reclamacoes').eq('recurso', 'reputacao'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,res:cursor->resumo,dest:cursor->destaques').eq('recurso', 'promocoes'),
      ]);
      for (const r of [logs, planos, reps, promos]) if (r.error) throw r.error;
      const itens = [], locais = resolvidasLocais(), planoSt = lerJSON('glr_plano_status', {});
      for (const l of logs.data || []) {
        const d = l.dados || {};
        if (d.acao === 'abc_queda') continue; // informativo: já aparece no Raio-X do Plano de ação
        const mkt = d.marketplace === 'ml' ? 'ml' : 'shopee';
        const impacto = d.impacto != null ? parseFloat(d.impacto) : d.freio_volume ? Math.max(0, (d.venda_antes || 0) - (d.venda_agora || 0)) : null;
        itens.push({
          id: 'log:' + l.id, log: l, tipo: mkt === 'ml' ? 'ads-ml' : 'ads-shopee', mkt, conta: String(l.conta_id),
          titulo: String(l.titulo || '').replace(/^Sugestão:\s*/, '').replace(/^Sugestão de /, ''), acao: mkt === 'shopee' ? acaoShopee(d) : '',
          porque: String(l.explicacao || '').replace(/\s*Como fazer no ML:[^]*$/, ''), impacto, impactoTipo: d.impacto_tipo || (d.freio_volume ? 'ganho' : null),
          exec: mkt === 'shopee' && !!GLRAcoes.tipoDe(d), tela: mkt === 'ml' ? 'agente-ml' : 'agente', quando: l.criado_em, freio: !!d.freio_volume,
        });
      }
      for (const r of planos.data || []) {
        const p = r.cursor; if (!p?.acoes) continue;
        for (const a of p.acoes.filter(a => a.tipo === 'faturamento')) {
          if (planoSt[a.id] || locais['fat:' + a.id]) continue;
          itens.push({ id: 'fat:' + a.id, tipo: 'faturamento', mkt: a.mkt, conta: String(a.conta), cliente: p.cliente?.nome, titulo: a.titulo, porque: a.porque, impacto: a.valor, impactoTipo: 'ganho', tela: a.tela, quando: p.em ? new Date(p.em).toISOString() : null, planoId: a.id });
        }
      }
      for (const r of reps.data || []) {
        for (const c of (r.rec || []).filter(c => c.prazo)) {
          const dias = (new Date(c.prazo).getTime() - Date.now()) / 864e5;
          const id = `rec:${r.conta_id}:${c.id}`;
          if (dias > 3 || locais[id]) continue;
          itens.push({ id, tipo: 'reputacao', mkt: r.marketplace, conta: String(r.conta_id), titulo: `${ACAO_REC[c.acao] || 'Agir'} na reclamação${c.produto ? ` — ${corta(c.produto, 50)}` : ''}`,
            porque: `${c.etapa === 'dispute' ? 'Mediação' : 'Reclamação'} do pedido ${c.pedido}. Perder o prazo derruba a reputação e trava o ADS da conta.`, prazo: c.prazo, urgente: true, tela: 'atendimento' });
        }
      }
      const hoje = new Date().toISOString().slice(0, 10);
      for (const r of promos.data || []) {
        const n = r.res?.sugeridas || 0, id = `promo:${r.conta_id}:${hoje}`;
        if (!n || locais[id]) continue;
        const ex = r.dest?.sugeridas?.[0];
        itens.push({ id, tipo: 'promocoes', mkt: r.marketplace, conta: String(r.conta_id), titulo: `Aplicar ${n} promoção(ões) que cabem na margem`,
          porque: ex ? `Ex.: ${corta(ex.n, 60)} — ${ex.rot}${ex.m != null ? `, margem ${String(ex.m).replace('.', ',')}%` : ''}${r.res.parados ? ` · ${r.res.parados} giram estoque parado` : ''}` : '', tela: 'promocoes' });
      }
      for (const it of itens) {
        it.loja = GLR.nomeConta(it.mkt, it.conta);
        it.clienteId = GLR.ctx?.clienteDaConta(it.mkt, it.conta) || '';
      }
      itens.sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0) || (a.urgente && b.urgente ? new Date(a.prazo) - new Date(b.prazo) : 0)
        || (b.impacto || 0) - (a.impacto || 0) || String(b.quando || '').localeCompare(String(a.quando || '')));
      st.itens = itens; st.erro = null;
      GLR.quandoClientes(() => { st.itens.forEach(it => { it.loja = GLR.nomeConta(it.mkt, it.conta); it.clienteId = GLR.ctx?.clienteDaConta(it.mkt, it.conta) || ''; }); render(); });
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
    window.dispatchEvent(new CustomEvent('glr:decisoes', { detail: { n: st.itens.length } }));
  }

  const visiveis = () => {
    const foco = GLR.ctx?.cliente();
    return st.itens.filter(it => (!foco || it.clienteId === foco) && (st.filtro === 'todos' || it.tipo === st.filtro || (st.filtro === 'aprovar' && it.exec)));
  };

  function render() {
    if (window._dcSt !== st) return;
    const root = document.getElementById('dc-root'); if (!root) return;
    if (st.carregando && !st.itens.length) { root.innerHTML = '<div class="card" style="padding:18px">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card" style="padding:18px;color:var(--red)">Não consegui carregar as decisões: ${h(st.erro)} <button class="btn btn-secondary btn-sm" onclick="window._dcRecarregar()">Tentar de novo</button></div>`; return; }
    const foco = GLR.ctx?.cliente();
    const base = st.itens.filter(it => !foco || it.clienteId === foco);
    const lista = visiveis();
    const emJogo = lista.reduce((s, it) => s + (it.impacto || 0), 0);
    const nExec = base.filter(it => it.exec).length;
    const selExec = lista.filter(it => it.exec && st.sel.has(it.id));
    const chips = [['todos', 'Tudo', base.length], ['aprovar', 'Aprovar com 1 clique', nExec], ...Object.entries(TIPOS).map(([k, v]) => [k, v.t, base.filter(it => it.tipo === k).length])].filter(([k, , n]) => k === 'todos' || n);
    root.innerHTML = `
      <div class="dc-topo">
        <div class="dc-num"><b>${lista.length}</b><span>decisão(ões)${foco ? ' deste cliente' : ''}</span></div>
        ${emJogo > 0 ? `<div class="dc-num"><b>${R$(emJogo)}</b><span>por semana em jogo</span></div>` : ''}
        <div class="dc-num"><b>${lista.filter(it => it.urgente).length}</b><span>com prazo vencendo</span></div>
        <span style="flex:1"></span>
        ${selExec.length ? `<button class="btn btn-primary btn-sm" ${st.lote ? 'disabled' : ''} onclick="window._dcAprovarSel()">${st.lote ? h(st.lote) : `Aprovar ${selExec.length} selecionada(s)`}</button>` : ''}
        <button class="btn btn-secondary btn-sm" ${st.carregando ? 'disabled' : ''} onclick="window._dcRecarregar()" title="Buscar de novo">↻</button>
      </div>
      <div class="dc-chips">${chips.map(([k, t, n]) => `<button class="dc-chip ${st.filtro === k ? 'on' : ''}" onclick="window._dcFiltro('${k}')">${h(t)} <b>${n}</b></button>`).join('')}</div>
      ${lista.length ? `<div class="card dc-lista">${lista.slice(0, st.limite).map(linha).join('')}</div>
        ${lista.length > st.limite ? `<div style="text-align:center;margin-top:10px"><button class="btn btn-secondary btn-sm" onclick="window._dcMais()">Mostrar mais ${Math.min(120, lista.length - st.limite)}</button></div>` : ''}`
        : `<div class="card dc-vazio"><b>Nada esperando você${foco ? ' neste cliente' : ''}.</b><span>Os agentes não encontraram nada que precise de decisão agora.</span></div>`}`;
  }

  function linha(it) {
    const T = TIPOS[it.tipo], proc = st.proc[it.id], aberto = st.abertos.has(it.id);
    const prazo = it.prazo ? (() => { const d = Math.round((new Date(it.prazo).getTime() - Date.now()) / 864e5); return d <= 0 ? 'vence hoje' : `vence em ${d} dia(s)`; })() : '';
    return `<div class="dc-li ${it.urgente ? 'urgente' : ''}" style="--c:${T.c}">
      <div class="dc-sel">${it.exec ? `<input type="checkbox" aria-label="Selecionar" ${st.sel.has(it.id) ? 'checked' : ''} onchange="window._dcMarcarSel('${h(it.id)}', this.checked)">` : ''}</div>
      <div class="dc-txt" onclick="window._dcAbrirTxt('${h(it.id)}')">
        <div class="dc-meta"><span class="dc-tipo">${T.t}</span><span>${h(it.loja || it.cliente || '')}</span>${prazo ? `<span class="dc-prazo">${prazo}</span>` : ''}${it.freio ? '<span class="dc-freio" title="O agente parou de apertar porque a venda do produto caiu">freio de volume</span>' : ''}${it.quando && !prazo ? `<span>${dataCurta(it.quando)}</span>` : ''}</div>
        <div class="dc-tit">${h(it.titulo)}${it.acao ? ` <span class="dc-acao">${h(it.acao)}</span>` : ''}</div>
        ${it.porque ? `<div class="dc-porque ${aberto ? 'aberto' : ''}">${h(it.porque)}</div>` : ''}
      </div>
      <div class="dc-imp">${it.impacto ? `<b>${R$(it.impacto)}</b><small>${it.impactoTipo === 'economia' ? 'a cortar/sem' : 'por semana'}</small>` : ''}</div>
      <div class="dc-bt">${proc ? `<span class="dc-proc">${h(proc)}</span>` : `
        ${it.exec ? `<button class="btn btn-primary btn-sm" onclick="window._dcAprovar('${h(it.id)}')">Aprovar</button>` : `<button class="btn btn-secondary btn-sm" onclick="window._dcIr('${h(it.id)}')">Abrir</button>`}
        ${it.exec ? `<button class="btn btn-ghost btn-sm" title="Abrir na tela do ADS" onclick="window._dcIr('${h(it.id)}')">↗</button>` : `<button class="btn btn-ghost btn-sm" title="Já fiz" onclick="window._dcFeito('${h(it.id)}')">Feito</button>`}
        <button class="dc-x" title="Descartar" aria-label="Descartar" onclick="window._dcDescartar('${h(it.id)}')">✕</button>`}</div>
    </div>`;
  }

  const achar = id => st.itens.find(x => x.id === id);
  const tirar = id => { st.itens = st.itens.filter(x => x.id !== id); st.sel.delete(id); window.dispatchEvent(new CustomEvent('glr:decisoes', { detail: { n: st.itens.length } })); };
  window._dcRecarregar = () => carregar();
  window._dcFiltro = k => { st.filtro = k; st.limite = 120; render(); };
  window._dcMais = () => { st.limite += 120; render(); };
  window._dcAbrirTxt = id => { st.abertos.has(id) ? st.abertos.delete(id) : st.abertos.add(id); render(); };
  window._dcMarcarSel = (id, on) => { on ? st.sel.add(id) : st.sel.delete(id); render(); };
  window._dcIr = id => { const it = achar(id); if (!it) return; if (it.clienteId) GLR.ctx?.definir(it.clienteId, true); Router.navigate(it.tela); };
  window._dcAprovar = async id => {
    const it = achar(id); if (!it?.exec) return;
    st.proc[id] = 'Executando…'; render();
    try { await GLRAcoes.executar(it.log); tirar(id); }
    catch (e) { alert('Não consegui executar: ' + (e.message || e)); }
    delete st.proc[id]; render();
  };
  window._dcAprovarSel = async () => {
    const sel = visiveis().filter(it => it.exec && st.sel.has(it.id));
    if (!sel.length || st.lote) return;
    if (!confirm(`Aprovar e executar agora ${sel.length} sugestão(ões) na Shopee?\n\n${sel.slice(0, 12).map(it => `• ${it.acao || ''} — ${corta(it.titulo, 60)}`).join('\n')}${sel.length > 12 ? `\n… e mais ${sel.length - 12}` : ''}`)) return;
    const falhas = []; let n = 0;
    for (const it of sel) {
      st.lote = `Executando ${++n} de ${sel.length}…`; render();
      try { await GLRAcoes.executar(it.log); tirar(it.id); } catch (e) { falhas.push(`${corta(it.titulo, 50)}: ${e.message || e}`); }
    }
    st.lote = null; render();
    if (falhas.length) alert(`Executei ${sel.length - falhas.length} de ${sel.length}. Falharam:\n${falhas.slice(0, 8).join('\n')}`);
  };
  async function resolver(id, resultado) {
    const it = achar(id); if (!it) return;
    st.proc[id] = resultado === 'executado' ? 'Marcando…' : 'Descartando…'; render();
    try {
      if (it.log) await GLRAcoes.marcar(it.log, resultado);
      else if (it.planoId) { const s = lerJSON('glr_plano_status', {}); s[it.planoId] = { st: resultado === 'executado' ? 'feito' : 'descartada', em: Date.now() }; localStorage.setItem('glr_plano_status', JSON.stringify(s)); }
      else resolverLocal(id);
      tirar(id);
    } catch (e) { alert('Não consegui salvar: ' + (e.message || e)); }
    delete st.proc[id]; render();
  }
  window._dcFeito = id => resolver(id, 'executado');
  window._dcDescartar = id => resolver(id, 'descartado');

  el.innerHTML = `<div class="page"><div id="dc-root"></div></div>
  <style>
    .dc-topo{display:flex;align-items:center;gap:22px;flex-wrap:wrap;margin-bottom:12px}
    .dc-num{display:flex;flex-direction:column} .dc-num b{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1} .dc-num span{font-size:12px;color:var(--text-muted)}
    .dc-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
    .dc-chip{border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
    .dc-chip b{color:var(--text-primary);font-weight:650;margin-left:2px} .dc-chip.on{border-color:var(--accent);background:var(--accent-glow);color:var(--accent-light)}
    .dc-lista{padding:4px 0}
    .dc-li{display:grid;grid-template-columns:28px minmax(0,1fr) 110px auto;gap:12px;align-items:start;padding:12px 16px;border-top:1px solid var(--border);border-left:3px solid transparent}
    .dc-li:first-child{border-top:0} .dc-li.urgente{border-left-color:var(--red);background:color-mix(in srgb,var(--red) 4%,transparent)}
    .dc-li:hover{background:var(--bg-subtle)}
    .dc-sel{padding-top:2px} .dc-sel input{width:16px;height:16px;cursor:pointer;accent-color:var(--accent)}
    .dc-txt{cursor:pointer;min-width:0}
    .dc-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--text-muted);margin-bottom:3px}
    .dc-tipo{color:var(--c);font-weight:650}
    .dc-prazo{color:var(--red);font-weight:650} .dc-freio{color:var(--accent);font-weight:600}
    .dc-tit{font-size:13.5px;font-weight:600;color:var(--text-primary);line-height:1.4}
    .dc-acao{display:inline-block;font-size:12px;font-weight:600;color:var(--text-secondary);background:var(--bg-subtle);border-radius:6px;padding:1px 7px;margin-left:4px}
    .dc-porque{font-size:12.5px;color:var(--text-secondary);line-height:1.5;margin-top:3px;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
    .dc-porque.aberto{-webkit-line-clamp:unset;display:block}
    .dc-imp{text-align:right;display:flex;flex-direction:column} .dc-imp b{font-size:14px;font-weight:650;font-variant-numeric:tabular-nums} .dc-imp small{font-size:11px;color:var(--text-muted)}
    .dc-bt{display:flex;gap:6px;align-items:center;justify-content:flex-end;white-space:nowrap}
    .dc-x{border:0;background:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:4px 6px;border-radius:6px} .dc-x:hover{color:var(--red);background:var(--bg-subtle)}
    .dc-proc{font-size:12px;color:var(--text-muted)}
    .dc-vazio{padding:28px;text-align:center;display:flex;flex-direction:column;gap:4px} .dc-vazio span{font-size:13px;color:var(--text-muted)}
    @media (max-width:760px){.dc-li{grid-template-columns:24px minmax(0,1fr);}.dc-imp{text-align:left;grid-column:2}.dc-bt{grid-column:2;justify-content:flex-start}}
  </style>`;
  carregar();
});
