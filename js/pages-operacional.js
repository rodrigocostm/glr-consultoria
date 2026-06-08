// ============================================================
// GLR Consultoria — Tarefas, Calendário, Timeline, Score GLR
// ============================================================

// ---- Gestão de Tarefas ----
Router.register('tarefas', (params, el) => {
  const hoje = '2026-06-04';

  function classify(t) {
    if (t.status === 'concluida') return 'concluidas';
    if (t.status === 'atrasada' || t.prazo < hoje) return 'atrasadas';
    if (t.prazo === hoje) return 'hoje';
    return 'semana';
  }

  const categorias = {
    hoje: { label: 'Hoje', color: '#6366f1', tasks: [] },
    semana: { label: 'Esta Semana', color: '#06b6d4', tasks: [] },
    atrasadas: { label: 'Atrasadas', color: '#ef4444', tasks: [] },
    concluidas: { label: 'Concluídas', color: '#10b981', tasks: [] },
  };

  GLR.tarefas.forEach(t => categorias[classify(t)].tasks.push(t));

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <div style="font-size:13px;color:var(--text-muted);">${GLR.tarefas.filter(t=>t.status!=='concluida').length} tarefas ativas · ${GLR.tarefas.filter(t=>t.status==='atrasada').length} atrasadas</div>
      <button class="btn btn-primary" onclick="openModalNovaTarefa(null)">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        Nova Tarefa
      </button>
    </div>

    <div class="kanban">
      ${Object.entries(categorias).map(([key, cat]) => `
        <div class="kanban-col">
          <div class="kanban-col-header">
            <span class="kanban-col-title" style="color:${cat.color};">${cat.label}</span>
            <span class="kanban-count">${cat.tasks.length}</span>
          </div>
          ${cat.tasks.length ? cat.tasks.map(t => `
            <div class="task-card" onclick="openModalTarefa(${t.id})">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:8px;">
                <div class="task-title">${t.titulo}</div>
                <span class="badge ${GLR.prioridadeColor[t.prioridade]}" style="flex-shrink:0;">${t.prioridade}</span>
              </div>
              ${t.cliente !== 'Interno' ? `<div style="font-size:11.5px;color:var(--text-muted);margin-bottom:6px;display:flex;align-items:center;gap:4px;">
                <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                ${t.cliente}
              </div>` : ''}
              <div class="task-meta">
                <span>👤 ${t.responsavel}</span>
                <span style="color:${t.status==='atrasada' ? 'var(--red)' : 'inherit'};">📅 ${formatDate(t.prazo)}</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:8px;">
                <span style="font-size:11px;padding:2px 7px;border-radius:99px;background:var(--bg-base);border:1px solid var(--border);color:var(--text-muted);">${t.categoria}</span>
                ${t.status === 'atrasada' ? '<span style="font-size:11px;color:var(--red);font-weight:700;margin-left:auto;">⚠ Atrasada</span>' : ''}
              </div>
            </div>
          `).join('') : `<div style="text-align:center;padding:24px 12px;color:var(--text-muted);font-size:12px;">Nenhuma tarefa</div>`}
        </div>
      `).join('')}
    </div>
  </div>`;

  window.openModalTarefa = (id) => {
    const t = GLR.tarefas.find(x => x.id === id);
    if (!t) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal">
      <div class="modal-header">
        <div class="modal-title">Tarefa</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div style="margin-bottom:16px;">
        <div style="font-size:17px;font-weight:700;margin-bottom:8px;">${t.titulo}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <span class="badge ${GLR.prioridadeColor[t.prioridade]}">${t.prioridade}</span>
          <span class="badge ${t.status === 'atrasada' ? 'status-risco' : t.status === 'concluida' ? 'status-crescimento' : 'status-ativo'}">${t.status}</span>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div><div class="form-label">Cliente</div><div style="color:var(--text-primary);">${t.cliente}</div></div>
        <div><div class="form-label">Responsável</div><div style="color:var(--text-primary);">${t.responsavel}</div></div>
        <div><div class="form-label">Prazo</div><div style="color:var(--text-primary);">${formatDate(t.prazo)}</div></div>
        <div><div class="form-label">Categoria</div><div style="color:var(--text-primary);">${t.categoria}</div></div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Fechar</button>
        <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">Marcar Concluída</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  };
});

// ---- Calendário Operacional ----
Router.register('calendario', (params, el) => {
  const today = new Date('2026-06-04');
  let viewDate = new Date(today);
  let viewMode = 'mensal';

  function renderCalendar() {
    const y = viewDate.getFullYear();
    const m = viewDate.getMonth();
    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m+1, 0).getDate();
    const monthName = viewDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    const days = [];
    // Previous month padding
    const prevDays = new Date(y, m, 0).getDate();
    for (let i = firstDay - 1; i >= 0; i--) days.push({ day: prevDays - i, current: false });
    // Current month
    for (let d = 1; d <= daysInMonth; d++) days.push({ day: d, current: true });
    // Next month padding
    const remaining = 42 - days.length;
    for (let d = 1; d <= remaining; d++) days.push({ day: d, current: false });

    function dateStr(d) {
      return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }

    const calHTML = days.map(({ day, current }) => {
      const ds = current ? dateStr(day) : '';
      const eventos = current ? GLR.eventos.filter(e => e.data === ds) : [];
      const isToday = ds === '2026-06-04';
      return `<div class="cal-day ${!current?'other-month':''} ${isToday?'today':''}">
        <div class="cal-day-num">${day}</div>
        ${eventos.slice(0,3).map(ev => `
          <div class="cal-event" style="background:${GLR.eventoColor[ev.tipo]};" title="${ev.titulo}">
            ${ev.hora} ${ev.titulo}
          </div>
        `).join('')}
        ${eventos.length > 3 ? `<div style="font-size:9px;color:var(--text-muted);">+${eventos.length-3} mais</div>` : ''}
      </div>`;
    }).join('');

    document.getElementById('cal-grid').innerHTML = calHTML;
    document.getElementById('cal-month-label').textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  }

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <button class="btn btn-secondary btn-sm" onclick="changeMonth(-1)">‹</button>
        <span id="cal-month-label" style="font-size:16px;font-weight:700;min-width:180px;text-align:center;"></span>
        <button class="btn btn-secondary btn-sm" onclick="changeMonth(1)">›</button>
        <button class="btn btn-ghost btn-sm" onclick="goToday()">Hoje</button>
      </div>
      <button class="btn btn-primary btn-sm" onclick="openModalNovoEvento()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        Novo Evento
      </button>
    </div>

    <!-- Legenda -->
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;">
      ${Object.entries({ reuniao:'Reunião', followup:'Follow-up', entrega:'Entrega', visita:'Visita', interno:'Interno' }).map(([k,v]) =>
        `<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);">
          <div style="width:10px;height:10px;border-radius:2px;background:${GLR.eventoColor[k]};"></div>${v}
        </div>`
      ).join('')}
    </div>

    <!-- Days header -->
    <div class="cal-grid" style="margin-bottom:4px;">
      ${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map(d => `<div class="cal-day-name">${d}</div>`).join('')}
    </div>
    <div id="cal-grid" class="cal-grid"></div>

    <!-- Próximos eventos list -->
    <div class="card" style="margin-top:20px;">
      <div class="section-title mb-16">📋 Próximos Compromissos</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">
        ${GLR.eventos.map(e => {
          const c = GLR.clientes.find(cl => cl.id === e.clienteId);
          return `<div style="display:flex;gap:12px;align-items:flex-start;padding:12px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);">
            <div style="width:10px;height:10px;border-radius:50%;background:${GLR.eventoColor[e.tipo]};margin-top:4px;flex-shrink:0;"></div>
            <div>
              <div style="font-size:13.5px;font-weight:600;color:var(--text-primary);">${e.titulo}</div>
              <div style="font-size:12px;color:var(--text-muted);">${formatDate(e.data)} às ${e.hora}</div>
              <div style="font-size:12px;color:var(--text-muted);">👤 ${e.responsavel}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;

  window.changeMonth = (d) => { viewDate.setMonth(viewDate.getMonth() + d); renderCalendar(); };
  window.goToday = () => { viewDate = new Date(today); renderCalendar(); };
  window.openModalNovoEvento = () => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal">
      <div class="modal-header">
        <div class="modal-title">Novo Evento</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div class="form-group"><label class="form-label">Título</label><input class="form-input" placeholder="Ex: Reunião mensal SportMax"></div>
      <div class="grid-2" style="gap:12px;">
        <div class="form-group"><label class="form-label">Data</label><input class="form-input" type="date" value="2026-06-04"></div>
        <div class="form-group"><label class="form-label">Hora</label><input class="form-input" type="time" value="10:00"></div>
      </div>
      <div class="form-group"><label class="form-label">Tipo</label>
        <select class="form-select"><option value="reuniao">Reunião</option><option value="followup">Follow-up</option><option value="entrega">Entrega</option><option value="visita">Visita</option><option value="interno">Interno</option></select>
      </div>
      <div class="form-group"><label class="form-label">Responsável</label>
        <select class="form-select">${GLR.gestores.map(g=>`<option>${g.nome}</option>`).join('')}</select>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">Salvar</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  };

  renderCalendar();
});

// ---- Timeline de Ações (Global) ----
Router.register('timeline', (params, el) => {
  let filtroCliente = '';
  let filtroCategoria = '';

  function renderTimeline() {
    let acoes = [...GLR.acoes].sort((a,b) => new Date(b.data) - new Date(a.data));
    if (filtroCliente) acoes = acoes.filter(a => a.clienteId === parseInt(filtroCliente));
    if (filtroCategoria) acoes = acoes.filter(a => a.categoria === filtroCategoria);

    return acoes.map(a => {
      const c = GLR.clientes.find(cl => cl.id === a.clienteId);
      const cor = GLR.tipoAcaoColor[a.categoria] || '#6366f1';
      const icons = { Reunião:'🤝', Campanha:'📣', Otimização:'⚡', Precificação:'💲', Estratégia:'♟️', Análise:'🔍', Onboarding:'🚀', Relatório:'📄', Catálogo:'📂', NPS:'⭐', Interno:'🏠' };
      return `<div class="timeline-item">
        <div class="timeline-dot" style="background:${cor}20;color:${cor};">${icons[a.categoria] || '📌'}</div>
        <div class="timeline-content">
          <div class="timeline-header">
            <div>
              <span class="badge" style="background:${cor}20;color:${cor};">${a.categoria}</span>
              ${c ? `<span style="font-size:12px;color:var(--text-muted);margin-left:8px;">${c.nome}</span>` : ''}
            </div>
            <span class="badge ${a.status === 'concluida' ? 'status-crescimento' : 'status-ativo'}">${a.status === 'concluida' ? 'Concluída' : 'Em andamento'}</span>
          </div>
          <div style="font-size:13.5px;color:var(--text-primary);margin:8px 0;">${a.descricao}</div>
          <div class="timeline-meta">
            <span>👤 ${a.responsavel}</span>
            <span>📅 ${formatDate(a.data)}</span>
          </div>
        </div>
      </div>`;
    }).join('') || `<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-title">Nenhuma ação encontrada</div></div>`;
  }

  const categorias = [...new Set(GLR.acoes.map(a => a.categoria))];

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div style="font-size:13px;color:var(--text-muted);">${GLR.acoes.length} ações registradas</div>
      <button class="btn btn-primary" onclick="openModalNovaAcaoGlobal()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        Registrar Ação
      </button>
    </div>

    <div class="filters">
      <select class="filter-select" id="tl-filter-cliente" onchange="filterTimeline()">
        <option value="">Todos os clientes</option>
        ${GLR.clientes.map(c => `<option value="${c.id}">${c.nome}</option>`).join('')}
      </select>
      <select class="filter-select" id="tl-filter-cat" onchange="filterTimeline()">
        <option value="">Todas as categorias</option>
        ${categorias.map(c => `<option value="${c}">${c}</option>`).join('')}
      </select>
    </div>

    <div id="timeline-list" class="timeline">${renderTimeline()}</div>
  </div>`;

  window.filterTimeline = () => {
    filtroCliente = document.getElementById('tl-filter-cliente').value;
    filtroCategoria = document.getElementById('tl-filter-cat').value;
    document.getElementById('timeline-list').innerHTML = renderTimeline();
  };

  window.openModalNovaAcaoGlobal = () => openModalNovaAcao(GLR.clientes[0].id);
});

// ---- Score GLR ----
// ── Calcula Score automaticamente a partir dos dados reais ──────
function calcularScoreCliente(c) {
  let projecoes = [];
  let dres = [];
  try { projecoes = JSON.parse(localStorage.getItem('glr_projecoes') || '[]'); } catch(e) {}
  try { dres      = JSON.parse(localStorage.getItem('glr_dre')       || '[]'); } catch(e) {}

  const proj  = projecoes.find(p => parseInt(p.chave) === c.id);
  const plats = proj?.plataformas || [];
  const dd    = proj?.diasDecorridos || 1;
  const dm    = proj?.diasNoMes || 30;
  const calcP = base => base ? (parseFloat(base)/dd)*dm : 0;

  const fatProj    = plats.reduce((s,p) => s + calcP(p.fatBase), 0);
  const adsProj    = plats.reduce((s,p) => s + calcP(p.adsBase), 0);
  const vendasProj = plats.reduce((s,p) => s + calcP(p.vendasBase), 0);

  // DRE mais recente
  const dreC   = dres.filter(d => parseInt(d.clienteId) === c.id)
                     .sort((a,b) => b.ano!==a.ano ? b.ano-a.ano : b.mes-a.mes)[0];
  const fatDRE = parseFloat(dreC?.valores?.faturamento) || 0;
  const adsDRE = parseFloat(dreC?.valores?.ads)         || 0;
  const lucro  = dreC ? (() => {
    const v = dreC.valores;
    const fat = parseFloat(v.faturamento)||0;
    const custos = ['comissaoFrete','produtos','ads','imposto','juros','custoFixo','comissaoGLR']
                   .reduce((s,k) => s+(parseFloat(v[k])||0), 0);
    return fat - custos;
  })() : 0;
  const margemDRE = fatDRE > 0 ? (lucro / fatDRE) * 100 : null;

  // Tarefas do cliente
  const tarefas     = GLR.tarefas.filter(t => t.cliente === c.nome || String(t.clienteId) === String(c.id));
  const tConc       = tarefas.filter(t => t.status === 'concluida').length;
  const tTotal      = tarefas.length;
  const pctExecucao = tTotal > 0 ? (tConc / tTotal) * 100 : null;

  // ROAS = faturamento / ADS
  const fatRef = fatDRE || fatProj;
  const adsRef = adsDRE || adsProj;
  const roas   = adsRef > 0 ? fatRef / adsRef : null;
  const pctADS = fatRef > 0 ? (adsRef / fatRef) * 100 : null;

  // Conversão: vendas reais (DRE) vs projetadas
  const vendasDRE   = parseFloat(dreC?.valores?.produtosVendidos) || 0;
  const vendasRef   = vendasDRE || vendasProj;
  const pctConversao = vendasProj > 0 ? Math.min((vendasRef / vendasProj) * 100, 100) : null;

  // Crescimento
  const cresc = parseFloat(c.crescimento) || 0;

  // Perfil do cliente completo (organização)
  const camposPreenchidos = ['nome','gestor','responsavel','categoria','valorPorVenda','status']
                            .filter(k => c[k]).length;
  const pctOrganizacao = (camposPreenchidos / 6) * 100;

  // ── Pontuação por critério (0-100 cada) ─────────────────────
  function pts(valor, faixas) { // faixas: [{min, pts}] decrescente
    if (valor === null) return 50; // sem dados = nota média
    for (const f of faixas) { if (valor >= f.min) return f.pts; }
    return faixas[faixas.length-1].pts;
  }

  const scores = {
    Crescimento:   pts(cresc, [{min:20,pts:100},{min:10,pts:80},{min:5,pts:60},{min:0,pts:40},{min:-5,pts:20},{min:-Infinity,pts:0}]),
    Rentabilidade: roas !== null
      ? pts(roas, [{min:15,pts:100},{min:10,pts:85},{min:7,pts:70},{min:5,pts:55},{min:3,pts:35},{min:-Infinity,pts:15}])
      : pts(pctADS, [{min:0,pts:100},{min:5,pts:85},{min:10,pts:70},{min:15,pts:50},{min:20,pts:30},{min:-Infinity,pts:10}]),
    Execução:      pts(pctExecucao, [{min:90,pts:100},{min:75,pts:80},{min:60,pts:60},{min:40,pts:40},{min:20,pts:20},{min:-Infinity,pts:0}]),
    Conversão:     pts(pctConversao, [{min:95,pts:100},{min:80,pts:80},{min:65,pts:60},{min:50,pts:40},{min:30,pts:20},{min:-Infinity,pts:0}]),
    Precificação:  margemDRE !== null
      ? pts(margemDRE, [{min:30,pts:100},{min:20,pts:80},{min:10,pts:60},{min:5,pts:40},{min:0,pts:20},{min:-Infinity,pts:0}])
      : 50,
    Organização:   Math.round(pctOrganizacao),
  };

  // Pesos
  const pesos = { Crescimento:0.20, Rentabilidade:0.20, Execução:0.15, Conversão:0.15, Precificação:0.20, Organização:0.10 };
  const total = Math.round(Object.entries(scores).reduce((s,[k,v]) => s + v * pesos[k], 0));

  return {
    total,
    detalhes: scores,
    meta: { roas, pctADS, margemDRE, pctExecucao, pctConversao, cresc },
  };
}
// Exposição global para outros módulos (ex: pages-clientes.js)
window.calcularScoreCliente = calcularScoreCliente;

Router.register('score', (params, el) => {
  const criterios = [
    { key:'Crescimento',   icon:'📈', peso:20, desc:'Taxa de crescimento mensal do faturamento', fonte:'Campo Crescimento% do cliente' },
    { key:'Rentabilidade', icon:'📊', peso:20, desc:'ROAS (Faturamento ÷ ADS) — quanto retorna por R$ investido', fonte:'Projeção ou DRE' },
    { key:'Precificação',  icon:'💲', peso:20, desc:'Margem de lucro líquida calculada pelo DRE', fonte:'DRE lançado' },
    { key:'Execução',      icon:'⚡', peso:15, desc:'% de tarefas concluídas sobre o total do cliente', fonte:'Gestão de Tarefas' },
    { key:'Conversão',     icon:'🛒', peso:15, desc:'Vendas reais vs projetadas no mês', fonte:'DRE vs Projeção' },
    { key:'Organização',   icon:'📂', peso:10, desc:'Completude do cadastro do cliente no sistema', fonte:'Perfil do cliente' },
  ];

  const resultados = GLR.clientes.map(c => ({ c, r: calcularScoreCliente(c) }))
                                  .sort((a,b) => b.r.total - a.r.total);

  const mediaGeral = resultados.length
    ? Math.round(resultados.reduce((s,x) => s + x.r.total, 0) / resultados.length)
    : 0;

  el.innerHTML = `<div class="page">

    <!-- Metodologia -->
    <div class="card mb-24">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px;">
        <div style="display:flex;align-items:center;gap:14px;">
          <div style="font-size:28px;">🏅</div>
          <div>
            <div class="section-title">Score GLR — Calculado Automaticamente</div>
            <div class="section-subtitle">Pontuação 0–100 atualizada em tempo real com base nos dados do sistema</div>
          </div>
        </div>
        <div style="text-align:center;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius);padding:10px 20px;">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Média da carteira</div>
          <div style="font-size:26px;font-weight:800;color:${scoreColor(mediaGeral)};">${mediaGeral}</div>
          <div style="font-size:10px;color:var(--text-muted);">/ 100</div>
        </div>
      </div>
      <div class="grid-3" style="gap:10px;">
        ${criterios.map(cr => `
          <div style="background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
              <span style="font-size:16px;">${cr.icon}</span>
              <span style="font-size:11px;font-weight:700;color:var(--accent-light);">${cr.peso}%</span>
            </div>
            <div style="font-size:13px;font-weight:700;margin-bottom:3px;">${cr.key}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${cr.desc}</div>
            <div style="font-size:10px;color:var(--text-muted);background:var(--bg-card);padding:2px 7px;border-radius:99px;display:inline-block;">📡 ${cr.fonte}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Ranking -->
    <div class="section-header mb-16">
      <div class="section-title">📊 Ranking da Carteira</div>
      <div class="section-subtitle">${resultados.length} clientes · ordenados por pontuação</div>
    </div>

    <div style="display:flex;flex-direction:column;gap:12px;">
      ${resultados.map(({c, r}, i) => {
        const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
        return `
        <div class="card card-hover" onclick="Router.navigate('cliente-perfil', {id: ${c.id}})">
          <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">

            <!-- Posição + nome -->
            <div style="display:flex;align-items:center;gap:10px;min-width:200px;flex:1;">
              <div style="font-size:16px;font-weight:800;color:var(--text-muted);width:28px;text-align:center;">${medal||('#'+(i+1))}</div>
              <div>
                <div style="font-size:14px;font-weight:700;">${c.nome}</div>
                <div style="font-size:11px;color:var(--text-muted);">Gestor: ${c.gestor||'—'} · ${GLR.statusLabel[c.status]||c.status}</div>
              </div>
            </div>

            <!-- Barra + score -->
            <div style="flex:2;min-width:200px;">
              <div style="display:flex;align-items:center;gap:10px;">
                <div style="flex:1;background:var(--bg-base);border-radius:99px;height:10px;overflow:hidden;">
                  <div style="width:${r.total}%;height:100%;background:${scoreColor(r.total)};border-radius:99px;transition:width .5s;"></div>
                </div>
                <div style="font-size:22px;font-weight:800;color:${scoreColor(r.total)};width:40px;text-align:right;">${r.total}</div>
              </div>
            </div>

            <!-- Detalhes por critério -->
            <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;width:100%;margin-top:10px;">
              ${criterios.map(cr => {
                const v = r.detalhes[cr.key];
                const meta = r.meta;
                let info = '';
                if (cr.key==='Crescimento')   info = meta.cresc !== null ? `${meta.cresc>0?'+':''}${meta.cresc}%` : '—';
                if (cr.key==='Rentabilidade') info = meta.roas  !== null ? `ROAS ${meta.roas.toFixed(1)}x` : meta.pctADS!==null ? `ADS ${meta.pctADS.toFixed(0)}%` : '—';
                if (cr.key==='Precificação')  info = meta.margemDRE !== null ? `Margem ${meta.margemDRE.toFixed(0)}%` : 'Sem DRE';
                if (cr.key==='Execução')      info = meta.pctExecucao !== null ? `${meta.pctExecucao.toFixed(0)}% OK` : 'Sem tarefas';
                if (cr.key==='Conversão')     info = meta.pctConversao !== null ? `${meta.pctConversao.toFixed(0)}% meta` : '—';
                if (cr.key==='Organização')   info = `${v}%`;
                return `
                <div style="background:var(--bg-base);border-radius:var(--radius-sm);padding:8px;text-align:center;border:1px solid ${scoreColor(v)}22;">
                  <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">${cr.icon} ${cr.key}</div>
                  <div style="font-size:13px;font-weight:800;color:${scoreColor(v)};">${v}</div>
                  <div style="font-size:9px;color:var(--text-muted);margin-top:2px;">${info}</div>
                </div>`;
              }).join('')}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
});

// ---- Helpers compartilhados ----
function openModalNovaTarefa(clienteId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">
    <div class="modal-header">
      <div class="modal-title">Nova Tarefa</div>
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button>
    </div>
    <div class="form-group"><label class="form-label">Título</label><input class="form-input" placeholder="Descreva a tarefa..."></div>
    <div class="form-group"><label class="form-label">Cliente</label>
      <select class="form-select">
        <option value="">Interno</option>
        ${GLR.clientes.map(c => `<option value="${c.id}" ${c.id === clienteId ? 'selected' : ''}>${c.nome}</option>`).join('')}
      </select>
    </div>
    <div class="grid-2" style="gap:12px;">
      <div class="form-group"><label class="form-label">Responsável</label>
        <select class="form-select">${GLR.gestores.map(g=>`<option>${g.nome}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label class="form-label">Prazo</label><input class="form-input" type="date" value="2026-06-10"></div>
    </div>
    <div class="grid-2" style="gap:12px;">
      <div class="form-group"><label class="form-label">Prioridade</label>
        <select class="form-select"><option>urgente</option><option>alta</option><option selected>media</option><option>baixa</option></select>
      </div>
      <div class="form-group"><label class="form-label">Categoria</label>
        <select class="form-select"><option>Reunião</option><option>Análise</option><option>Campanha</option><option>Relatório</option><option>Estratégia</option><option>Onboarding</option></select>
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
      <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">Criar Tarefa</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}
