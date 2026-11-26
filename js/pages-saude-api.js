// ============================================================
// GLR Consultoria — Saúde da API (Agente Saúde da API)
// ------------------------------------------------------------
// Os pedidos da base batem com o marketplace? Por cliente e por loja: conexão,
// sincronização em dia, histórico do mês completo e a conferência diária
// (ontem e anteontem: pedidos na API × na base). Pedido que faltava já foi
// buscado e gravado pelo agente. Quem calcula é o servidor, de hora em hora
// (api/sync-dados.js saudeAPI → glr_sync_estado sistema / saude_api / todas).
// Esta tela só lê e mostra; "Conferir agora" roda o agente na hora.
// ============================================================
Router.register('saude-api', (params, el) => {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const NOME_MKT = { shopee: 'Shopee', ml: 'Mercado Livre', amazon: 'Amazon', tiktok: 'TikTok Shop', magalu: 'Magalu', shein: 'Shein' };
  // ordem = gravidade (o cliente fica com o pior status das lojas dele)
  const ST = {
    erro: { t: 'Sem dados', c: 'var(--red)', o: 0, d: 'conexão ou busca com erro' },
    travado: { t: 'Histórico travado', c: 'var(--red)', o: 1, d: 'o mês não está completo e não avança' },
    divergente: { t: 'Diverge da API', c: 'var(--red)', o: 2, d: 'marketplace e base com números diferentes' },
    recuperando: { t: 'Completando o mês', c: 'var(--yellow)', o: 3, d: 'histórico sendo buscado' },
    atrasada: { t: 'Atrasada', c: 'var(--yellow)', o: 4, d: 'sem atualizar há 2 h+' },
    sem_sync: { t: 'Nunca sincronizou', c: 'var(--text-muted)', o: 5, d: '' },
    corrigido: { t: 'Corrigido hoje', c: 'var(--accent)', o: 6, d: 'faltavam pedidos — já gravados' },
    ok: { t: 'Confiável', c: 'var(--green)', o: 7, d: 'base igual ao marketplace' },
  };
  const DUVIDA = s => ST[s] && ST[s].o <= 4;
  const st = { dados: null, carregando: true, conferindo: false, erro: null, filtro: 'duvida', busca: '', abertos: new Set() };

  const quando = ms => {
    if (!ms) return '—';
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 60) return `há ${Math.max(1, min)} min`;
    if (min < 48 * 60) return `há ${Math.round(min / 60)} h`;
    return `há ${Math.round(min / 1440)} dias`;
  };
  const dm = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '';
  const num = v => v == null ? '—' : Number(v).toLocaleString('pt-BR');

  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('cursor').eq('marketplace', 'sistema').eq('conta_id', 'saude_api').eq('recurso', 'todas').maybeSingle();
      if (error) throw error;
      st.dados = data?.cursor || null; st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }
  async function conferirAgora() {
    st.conferindo = true; render();
    try {
      const r = await window.glrApiFetch('/api/agente-cron?rodada=saude-api&agora=1&forcar=1');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    } catch (e) { GLR.avisar('Não consegui conferir agora: ' + (e.message || e), 'erro'); }
    st.conferindo = false;
    await carregar();
  }

  // lojas → clientes (mesmo vínculo da Projeção e dos Gestores)
  function agrupar(contas) {
    let vinc = {}; try { vinc = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch (e) {}
    const cliDe = new Map();
    for (const [cid, lista] of Object.entries(vinc)) for (const c of (lista || [])) {
      const id = String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.param_to_use?.amazon_account_id || c.param_to_use?.magalu_account_id || c.param_to_use?.shein_supplier_id || c.external_id);
      cliDe.set(id, cid);
    }
    const grupos = new Map();
    for (const x of contas) {
      const cid = cliDe.get(String(x.id)) || 'sem';
      if (!grupos.has(cid)) {
        const cli = (GLR.clientes || []).find(c => String(c.id) === cid);
        grupos.set(cid, { id: cid, nome: cid === 'sem' ? 'Lojas sem cliente vinculado' : (cli?.nome || `Cliente ${cid}`), lojas: [] });
      }
      grupos.get(cid).lojas.push(x);
    }
    for (const g of grupos.values()) {
      g.lojas.sort((a, b) => (ST[a.status]?.o ?? 9) - (ST[b.status]?.o ?? 9) || String(a.nome).localeCompare(String(b.nome)));
      g.status = g.lojas[0]?.status || 'ok';
    }
    return [...grupos.values()].sort((a, b) => (a.id === 'sem') - (b.id === 'sem') || (ST[a.status]?.o ?? 9) - (ST[b.status]?.o ?? 9) || a.nome.localeCompare(b.nome));
  }

  const pill = s => { const x = ST[s] || ST.ok; return `<span class="sa-pill" style="--c:${x.c}">${x.t}</span>`; };
  function linhaConferencia(x) {
    const c = x.conferido;
    if (!c) return '<span class="sa-sub">ainda não conferida</span>';
    if (c.erro) return `<span class="sa-sub" style="color:var(--red)">conferência falhou: ${h(c.erro)}</span>`;
    if (!c.dias?.length) return `<span class="sa-sub">conferida ${quando(Date.parse(c.em))} (sem dia fechado para comparar)</span>`;
    return c.dias.map(d => {
      const ok = x.mkt === 'ml' ? !d.pendentes : true;
      return `<span class="sa-dia ${ok ? '' : 'ruim'}" title="API: ${num(d.api)} pedidos · base: ${num(d.base)} (${num(d.validos)} válidos)${d.resumo != null ? ` · resumo: ${num(d.resumo)}` : ''}${d.pendentes && x.mkt === 'shopee' ? ` · ${d.pendentes} não pagos (não entram)` : ''}">${dm(d.dia)}: API ${num(d.api)} · base ${num(d.base)}${d.corrigidos ? ` <b>+${d.corrigidos} gravados</b>` : ''}</span>`;
    }).join('') + `<span class="sa-sub"> · ${quando(Date.parse(c.em))}</span>`;
  }

  function render() {
    const root = document.getElementById('sa-root'); if (!root) return;
    if (st.carregando && !st.dados) { root.innerHTML = '<div class="card sa-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card sa-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    const contas = Object.values(st.dados?.contas || {});
    if (!contas.length) {
      root.innerHTML = `<div class="card sa-vazio">A primeira conferência ainda não rodou (ela roda de hora em hora).<div style="margin-top:12px"><button class="btn btn-primary btn-sm" ${st.conferindo ? 'disabled' : ''} onclick="window._saConferir()">${st.conferindo ? 'Conferindo… (até 4 min)' : 'Conferir agora'}</button></div></div>`;
      return;
    }
    const grupos = agrupar(contas);
    const q = st.busca.trim().toLowerCase();
    const visiveis = grupos.filter(g => (st.filtro === 'todos' || (st.filtro === 'duvida' ? DUVIDA(g.status) : g.lojas.some(l => l.status === 'corrigido')))
      && (!q || `${g.nome} ${g.lojas.map(l => `${l.nome} ${l.id}`).join(' ')}`.toLowerCase().includes(q)));
    const nDuv = grupos.filter(g => g.id !== 'sem' && DUVIDA(g.status)).length, nCli = grupos.filter(g => g.id !== 'sem').length;
    const r = st.dados.resumo || {};
    root.innerHTML = `
      <div class="sa-topo">
        <div class="sa-veredito" style="--c:${nDuv ? 'var(--red)' : 'var(--green)'}">
          <b>${nDuv ? `${nDuv} de ${nCli} clientes com pedidos em dúvida` : `Todos os ${nCli} clientes com pedidos conferidos`}</b>
          <span>${nDuv ? 'Os números de vendas e projeção desses clientes podem estar incompletos até resolver.' : 'Vendas, projeção e comissão estão usando a base completa.'}</span>
        </div>
        <span style="flex:1"></span>
        <div class="sa-sub" style="text-align:right">conferido ${quando(st.dados.em)} · roda de hora em hora<br>${num(r.conferidas)} loja(s) conferidas na última rodada${r.corrigidos ? ` · ${num(r.corrigidos)} pedido(s) que faltavam foram gravados` : ''}${r.faltam_conferir ? ` · ${num(r.faltam_conferir)} ficam para a próxima` : ''}</div>
        <button class="btn btn-secondary btn-sm" ${st.conferindo ? 'disabled' : ''} onclick="window._saConferir()" title="Confere agora os pedidos de ontem e anteontem de todas as lojas na API × base (até 4 min)">${st.conferindo ? 'Conferindo… (até 4 min)' : '↻ Conferir agora'}</button>
      </div>
      <div class="sa-nums">
        ${Object.entries(ST).map(([k, v]) => { const n = contas.filter(x => x.status === k).length; return n ? `<div class="sa-num" style="--c:${v.c}" title="${h(v.d)}"><b>${n}</b><span>${v.t.toLowerCase()}</span></div>` : ''; }).join('')}
      </div>
      <div class="sa-filtros">
        <button class="sa-chip ${st.filtro === 'duvida' ? 'on' : ''}" onclick="window._saFiltro('duvida')">Em dúvida <b>${grupos.filter(g => DUVIDA(g.status)).length}</b></button>
        <button class="sa-chip ${st.filtro === 'corrigido' ? 'on' : ''}" onclick="window._saFiltro('corrigido')">Corrigidos hoje <b>${grupos.filter(g => g.lojas.some(l => l.status === 'corrigido')).length}</b></button>
        <button class="sa-chip ${st.filtro === 'todos' ? 'on' : ''}" onclick="window._saFiltro('todos')">Todos <b>${grupos.length}</b></button>
        <input id="sa-busca" class="form-control sa-busca" placeholder="Buscar cliente ou loja…" value="${h(st.busca)}" oninput="window._saBusca(this.value)">
      </div>
      ${visiveis.length ? visiveis.map(g => {
        const aberto = st.abertos.has(g.id) || (st.filtro === 'duvida' && visiveis.length <= 6);
        const ruins = g.lojas.filter(l => DUVIDA(l.status)).length;
        return `<div class="card sa-cli" style="--c:${(ST[g.status] || ST.ok).c}">
          <button class="sa-cli-top" onclick="window._saAbrir('${h(g.id)}')">
            <b>${h(g.nome)}</b>${pill(g.status)}
            <span class="sa-sub">${g.lojas.length} loja(s)${ruins ? ` · ${ruins} em dúvida` : ''}</span>
            <span style="flex:1"></span><span class="sa-seta">${aberto ? '▾' : '▸'}</span>
          </button>
          ${aberto ? `<div class="sa-lojas">${g.lojas.map(x => `<div class="sa-loja">
            <div class="sa-loja-top"><b>${h(x.nome)}</b><span class="sa-mkt">${h(NOME_MKT[x.mkt] || x.mkt)}</span><span class="sa-sub">${h(x.id)}</span>${pill(x.status)}${x.desde && x.status !== 'ok' ? `<span class="sa-sub">desde ${new Date(x.desde).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>` : ''}</div>
            ${(x.problemas || []).map(p => `<div class="sa-prob">${h(p)}</div>`).join('')}
            <div class="sa-conf">${linhaConferencia(x)}${x.ultimo_dado ? `<span class="sa-sub"> · último dado ${quando(Date.parse(x.ultimo_dado))}</span>` : ''}</div>
          </div>`).join('')}
          ${g.lojas.some(l => l.status === 'erro') ? '<a class="btn btn-primary btn-sm" style="margin:4px 0 2px;display:inline-block" href="https://marketplaces.tiops.com.br" target="_blank" rel="noopener">Abrir a Tiops para reconectar</a>' : ''}</div>` : ''}
        </div>`;
      }).join('') : `<div class="card sa-vazio" style="color:var(--green)">${st.filtro === 'duvida' ? 'Nenhum cliente com pedidos em dúvida.' : 'Nada por aqui.'}</div>`}`;
  }

  window._saConferir = conferirAgora;
  window._saFiltro = f => { st.filtro = f; render(); };
  window._saAbrir = id => { st.abertos.has(id) ? st.abertos.delete(id) : st.abertos.add(id); render(); };
  window._saBusca = v => {
    st.busca = v; clearTimeout(window._saT);
    window._saT = setTimeout(() => { render(); const b = document.getElementById('sa-busca'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 200);
  };

  el.innerHTML = `<div class="page">
    <div class="ajuda">O Agente Saúde da API confere, de hora em hora, se os pedidos da base batem com o marketplace: conexão, sincronização em dia, mês completo e — uma vez por dia — os pedidos de ontem e anteontem na API × na base. Pedido que faltava é buscado e gravado na hora. Cliente "em dúvida" tem vendas e projeção possivelmente incompletas até resolver.</div>
    <div id="sa-root"></div>
  </div>
  <style>
    .sa-sub{font-size:12px;color:var(--text-muted)}
    .sa-vazio{padding:24px;text-align:center;color:var(--text-muted);margin-bottom:14px}
    .sa-topo{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .sa-veredito{display:flex;flex-direction:column;gap:2px;border-left:4px solid var(--c);padding:4px 0 4px 12px}
    .sa-veredito b{font-size:17px;color:var(--text-primary)} .sa-veredito span{font-size:13px;color:var(--text-secondary)}
    .sa-nums{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px}
    .sa-num{display:flex;flex-direction:column;line-height:1.2} .sa-num b{font-size:20px;color:var(--c);font-variant-numeric:tabular-nums} .sa-num span{font-size:12px;color:var(--text-muted)}
    .sa-filtros{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
    .sa-chip{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12px;cursor:pointer}
    .sa-chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
    .sa-busca{max-width:240px;margin-left:auto}
    .sa-cli{padding:0;margin-bottom:8px;border-left:3px solid var(--c);overflow:hidden}
    .sa-cli-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;width:100%;padding:12px 16px;background:none;border:0;cursor:pointer;text-align:left;color:inherit;font:inherit}
    .sa-cli-top:hover{background:var(--bg-card-hover)}
    .sa-cli-top:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
    .sa-seta{color:var(--text-muted)}
    .sa-lojas{padding:0 16px 10px}
    .sa-loja{padding:10px 0;border-top:1px solid var(--border)}
    .sa-loja-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .sa-prob{font-size:13px;color:var(--text-primary);margin-top:4px}
    .sa-conf{margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .sa-dia{font-size:12px;font-variant-numeric:tabular-nums;background:var(--bg-subtle);border-radius:5px;padding:2px 8px;color:var(--text-secondary)}
    .sa-dia.ruim{color:var(--red);background:color-mix(in srgb,var(--red) 10%,transparent)}
    .sa-dia b{color:var(--accent)}
    .sa-mkt{font-size:11.5px;color:var(--text-secondary);background:var(--bg-subtle);border-radius:5px;padding:1px 7px}
    .sa-pill{display:inline-block;font-size:11.5px;font-weight:650;padding:2px 8px;border-radius:99px;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);white-space:nowrap}
    @media (max-width:640px){.sa-busca{max-width:none;margin-left:0;flex:1 1 100%}}
  </style>`;
  carregar();
});
