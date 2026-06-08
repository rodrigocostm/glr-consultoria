// ============================================================
// GLR Consultoria — Dashboard Executivo + Dashboard Diretoria
// ============================================================

// ---- Helpers visuais ----
function sparkline(data, color = '#6366f1') {
  const max = Math.max(...data);
  return `<div class="sparkline">${data.map(v => `
    <div class="spark-bar" style="height:${Math.round((v/max)*100)}%;background:${color};opacity:0.8;"></div>
  `).join('')}</div>`;
}

function delta(val, suffix = '%') {
  const up = val >= 0;
  return `<span class="kpi-delta ${up ? 'up' : 'down'}">
    ${up ? '▲' : '▼'} ${Math.abs(val)}${suffix}
  </span>`;
}

function scoreColor(s) {
  if (s >= 80) return '#10b981';
  if (s >= 60) return '#6366f1';
  if (s >= 40) return '#f59e0b';
  return '#ef4444';
}

// ---- Dashboard Executivo ----
Router.register('dashboard', (params, el) => {
  if (!GLR.clientes.length) {
    el.innerHTML = `<div class="page">
      <div style="text-align:center;padding:80px 24px;">
        <div style="font-size:52px;margin-bottom:16px;">🚀</div>
        <div style="font-size:22px;font-weight:800;color:var(--text-primary);margin-bottom:8px;">Bem-vindo ao GLR Centro de Operações</div>
        <div style="font-size:14px;color:var(--text-muted);max-width:420px;margin:0 auto 28px;">Nenhum dado cadastrado ainda. Comece cadastrando gestores e clientes para visualizar o dashboard.</div>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="Router.navigate('clientes')">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
            Cadastrar primeiro cliente
          </button>
          <button class="btn btn-secondary" onclick="Router.navigate('projecao')">📊 Inserir projeção</button>
        </div>
      </div>
    </div>`;
    return;
  }

  const ativos    = GLR.clientes.filter(c => c.status === 'ativo').length;
  const crescimento = GLR.clientes.filter(c => c.status === 'crescimento').length;
  const queda     = GLR.clientes.filter(c => c.status === 'queda').length;
  const risco     = GLR.clientes.filter(c => c.status === 'risco').length;
  const tarefasPendentes = GLR.tarefas.filter(t => t.status === 'pendente' || t.status === 'atrasada').length;
  const reunioesSemana   = GLR.eventos.filter(e => e.tipo === 'reuniao').length;

  const faturamentoTotal = GLR.clientes.reduce((s, c) => s + (c.faturamento || 0), 0);
  const crescimentoMedio = GLR.clientes.length
    ? (GLR.clientes.reduce((s, c) => s + (c.crescimento || 0), 0) / GLR.clientes.length).toFixed(1)
    : '0.0';

  // Receita GLR = soma de (vendas projetadas × valor por venda) de cada cliente
  // Usa os dados das projeções salvas
  let receitaGLR = 0;
  try {
    const projs = JSON.parse(localStorage.getItem('glr_projecoes') || '[]');
    GLR.clientes.forEach(c => {
      const proj = projs.find(p => parseInt(p.chave) === c.id);
      if (!proj || !c.valorPorVenda) return;
      const dd = proj.diasDecorridos || 2;
      const dm = proj.diasNoMes     || 30;
      const vendas = proj.plataformas?.reduce((s, p) => {
        const base = parseFloat(p.vendasBase) || 0;
        return s + (base && dd ? (base / dd) * dm : 0);
      }, 0) || 0;
      receitaGLR += Math.round(vendas) * parseFloat(c.valorPorVenda);
    });
  } catch(e) {}

  el.innerHTML = `<div class="page">
    <!-- KPIs -->
    <div class="kpi-grid">
      ${kpiCard('Clientes Ativos', GLR.clientes.length, '+2 este mês', true, 'rgba(99,102,241,0.15)', '👥', '#6366f1')}
      ${kpiCard('Em Crescimento', crescimento, '+1 este mês', true, 'rgba(16,185,129,0.12)', '📈', '#10b981')}
      ${kpiCard('Em Queda', queda, 'vs mês anterior', false, 'rgba(249,115,22,0.12)', '📉', '#f97316')}
      ${kpiCard('Em Risco', risco, 'atenção imediata', false, 'rgba(239,68,68,0.12)', '⚠️', '#ef4444')}
      ${kpiCard('Tarefas Pendentes', tarefasPendentes, `${GLR.tarefas.filter(t=>t.status==='atrasada').length} atrasadas`, false, 'rgba(245,158,11,0.12)', '✅', '#f59e0b')}
      ${kpiCard('Reuniões na Semana', reunioesSemana, 'próximos 7 dias', true, 'rgba(6,182,212,0.12)', '📅', '#06b6d4')}
      ${kpiCard('Receita GLR', receitaGLR > 0 ? GLR.formatCurrency(receitaGLR) : '—', 'vendas × valor por venda', true, 'rgba(16,185,129,0.15)', '💰', '#10b981')}
      ${kpiCard('Fat. Carteira', GLR.formatCurrency(faturamentoTotal), `${delta(parseFloat(crescimentoMedio))}`, true, 'rgba(99,102,241,0.12)', '🏆', '#6366f1', true)}
    </div>

    <!-- Gráficos principais -->
    <div class="grid-2 mb-24">
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Evolução da Carteira</div>
            <div class="section-subtitle">Faturamento total — últimos 20 meses</div>
          </div>
          <span class="badge status-crescimento">+16.4%</span>
        </div>
        <div class="chart-wrapper">
          <canvas id="chart-evolucao"></canvas>
        </div>
      </div>
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Distribuição por Status</div>
            <div class="section-subtitle">Situação atual da carteira</div>
          </div>
        </div>
        <div style="display:flex;gap:24px;align-items:center;">
          <div style="flex:1;max-width:180px;">
            <canvas id="chart-status"></canvas>
          </div>
          <div style="flex:1;">
            ${['crescimento','ativo','queda','risco'].map(s => {
              const count = GLR.clientes.filter(c => c.status === s).length;
              const pct = GLR.clientes.length ? Math.round(count / GLR.clientes.length * 100) : 0;
              return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                <div style="width:10px;height:10px;border-radius:50%;background:${{'crescimento':'#10b981','ativo':'#6366f1','queda':'#f97316','risco':'#ef4444'}[s]};flex-shrink:0;"></div>
                <span style="flex:1;font-size:13px;color:var(--text-secondary);text-transform:capitalize;">${GLR.statusLabel[s]}</span>
                <span style="font-weight:700;font-size:13px;">${count}</span>
                <span style="color:var(--text-muted);font-size:12px;">${pct}%</span>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>

    <!-- Ranking + Alertas -->
    <div class="grid-2 mb-24">
      <div class="card">
        <div class="section-header">
          <div class="section-title">🏆 Ranking — Melhor Desempenho</div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('clientes')">Ver todos</button>
        </div>
        ${GLR.clientes.length === 0
          ? `<div style="color:var(--text-muted);font-size:13px;padding:16px 0;text-align:center;">Nenhum cliente cadastrado</div>`
          : [...GLR.clientes].sort((a,b) => (b.crescimento||0) - (a.crescimento||0)).slice(0,6).map((c, i) => `
          <div class="ranking-item" onclick="Router.navigate('cliente-perfil', {id: ${c.id}})" style="cursor:pointer;">
            <span class="ranking-num">#${i+1}</span>
            <div style="flex:1;">
              <div class="ranking-name">${c.nome}</div>
              <div style="font-size:11px;color:var(--text-muted);">${c.gestor || ''} · ${c.plano || ''}</div>
            </div>
            <div style="text-align:right;">
              <div class="ranking-val ${(c.crescimento||0) >= 0 ? 'text-green' : 'text-red'}">${(c.crescimento||0) >= 0 ? '+' : ''}${c.crescimento||0}%</div>
              <div style="font-size:11px;color:var(--text-muted);">${GLR.formatCurrency(c.faturamento||0)}</div>
            </div>
            <span class="badge ${GLR.statusColor[c.status]}" style="margin-left:8px;">${GLR.statusLabel[c.status]}</span>
          </div>
        `).join('')}
      </div>

      <div class="card">
        <div class="section-header">
          <div class="section-title">🔔 Alertas Recentes</div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('alertas')">Ver todos</button>
        </div>
        ${(() => {
          const cores  = { risco:'#ef4444', queda:'#f97316', atrasada:'#f59e0b', meta:'#6366f1', positivo:'#10b981' };
          const icons  = { risco:'🚨', queda:'📉', atrasada:'⏰', meta:'🎯', positivo:'✅' };
          const alertas = typeof gerarAlertasAutomaticos === 'function' ? gerarAlertasAutomaticos() : [];
          const criticos = alertas.filter(a => a.tipo === 'risco' || a.tipo === 'queda');
          const outros   = alertas.filter(a => a.tipo !== 'risco' && a.tipo !== 'queda');
          const lista    = [...criticos, ...outros].slice(0, 5);
          if (!lista.length) return '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">Nenhum alerta no momento. ✅</div>';
          return lista.map(a => {
            const cor = cores[a.tipo] || '#6366f1';
            return `<div class="alert-card" onclick="Router.navigate('alertas')" style="margin-bottom:8px;cursor:pointer;">
              <div class="alert-icon" style="background:${cor}20;">
                <span style="font-size:16px;">${icons[a.tipo] || '🔔'}</span>
              </div>
              <div style="min-width:0;">
                <div class="alert-title">${a.titulo}</div>
                <div class="alert-desc" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.descricao.substring(0, 90)}${a.descricao.length > 90 ? '…' : ''}</div>
              </div>
            </div>`;
          }).join('');
        })()}
      </div>
    </div>

    <!-- Tarefas urgentes + Próximos eventos -->
    <div class="grid-2">
      <div class="card">
        <div class="section-header">
          <div class="section-title">⚡ Tarefas Urgentes</div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('tarefas')">Ver todas</button>
        </div>
        ${GLR.tarefas.filter(t => t.status === 'atrasada' || t.prioridade === 'urgente').slice(0,5).map(t => `
          <div class="task-card" onclick="Router.navigate('tarefas')">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
              <div class="task-title">${t.titulo}</div>
              <span class="badge ${GLR.prioridadeColor[t.prioridade]}">${t.prioridade}</span>
            </div>
            <div class="task-meta">
              <span>👤 ${t.responsavel}</span>
              <span>📅 ${formatDate(t.prazo)}</span>
              ${t.status === 'atrasada' ? '<span style="color:var(--red);font-weight:600;">ATRASADA</span>' : ''}
            </div>
          </div>
        `).join('')}
      </div>

      <div class="card">
        <div class="section-header">
          <div class="section-title">📅 Próximos Eventos</div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('calendario')">Ver calendário</button>
        </div>
        ${GLR.eventos.slice(0,5).map(e => {
          const cor = GLR.eventoColor[e.tipo];
          return `<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border);">
            <div style="width:38px;height:38px;border-radius:var(--radius-sm);background:${cor}20;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">
              ${{ reuniao: '🤝', followup: '📞', entrega: '📦', visita: '🏢', interno: '🏠' }[e.tipo]}
            </div>
            <div style="flex:1;">
              <div style="font-size:13.5px;font-weight:600;color:var(--text-primary);margin-bottom:2px;">${e.titulo}</div>
              <div style="font-size:12px;color:var(--text-muted);">${formatDate(e.data)} às ${e.hora} · ${e.responsavel}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;

  // ── Constrói evolucaoCarteira a partir de historico + DRE reais ──
  (function() {
    const mesesNomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                        'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mapa = {}; // chave: "Mês Ano" → total faturamento

    // 1. Soma historico de cada cliente
    GLR.clientes.forEach(c => {
      (c.historico || []).forEach(h => {
        const fat = parseFloat(h.faturamento) || 0;
        if (fat > 0 && h.mes) {
          mapa[h.mes] = (mapa[h.mes] || 0) + fat;
        }
      });
    });

    // 2. Soma DRE lançados (têm prioridade / complementam historico)
    let dres = [];
    try { dres = JSON.parse(localStorage.getItem('glr_dre') || '[]'); } catch(e) {}
    dres.forEach(d => {
      const fat = parseFloat(d.valores?.faturamento) || 0;
      if (fat <= 0) return;
      const nomeMes = mesesNomes[parseInt(d.mes)] + ' ' + d.ano;
      // DRE substitui qualquer valor do historico para esse mês
      // (acumula por cliente para não somar duas vezes)
      mapa['_dre_' + nomeMes] = (mapa['_dre_' + nomeMes] || 0) + fat;
    });

    // Mescla: para cada mês com DRE, usa o DRE; senão usa historico
    const merged = {};
    Object.keys(mapa).forEach(k => {
      if (k.startsWith('_dre_')) {
        const mes = k.replace('_dre_', '');
        merged[mes] = mapa[k]; // DRE tem prioridade
      } else {
        if (!merged[k]) merged[k] = mapa[k]; // historico só se não tem DRE
      }
    });

    // 3. Ordena cronologicamente
    const ordenado = Object.entries(merged)
      .map(([mes, total]) => {
        const partes = mes.split(' ');
        const nomeMes = partes[0];
        const ano = parseInt(partes[1]) || 2025;
        const idxMes = mesesNomes.indexOf(nomeMes);
        return { mes, total, ordem: ano * 12 + idxMes };
      })
      .filter(d => d.ordem >= 0)
      .sort((a, b) => a.ordem - b.ordem)
      .slice(-12); // últimos 12 meses

    GLR.evolucaoCarteira = ordenado;
  })();

  // Charts
  setTimeout(() => {
    // Evolução carteira
    const ctx1 = document.getElementById('chart-evolucao');
    if (ctx1) {
      const evolucao = GLR.evolucaoCarteira;
      if (evolucao.length === 0) {
        ctx1.parentElement.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:32px 0;">Nenhum histórico de faturamento encontrado.<br>Insira dados no histórico dos clientes ou lance o DRE.</div>';
      } else {
        new Chart(ctx1, {
          type: 'line',
          data: {
            labels: evolucao.map(d => d.mes),
            datasets: [{
              data: evolucao.map(d => d.total),
              borderColor: '#6366f1',
              backgroundColor: 'rgba(99,102,241,0.1)',
              borderWidth: 2,
              fill: true,
              tension: 0.4,
              pointRadius: 3,
              pointHoverRadius: 5,
              pointBackgroundColor: '#6366f1',
            }]
          },
          options: {
            ...chartDefaults(),
            plugins: {
              ...(chartDefaults().plugins || {}),
              tooltip: {
                callbacks: {
                  label: ctx => ' R$ ' + ctx.raw.toLocaleString('pt-BR', {minimumFractionDigits:0})
                }
              }
            }
          }
        });
      }
    }

    // Donut status
    const ctx2 = document.getElementById('chart-status');
    if (ctx2) {
      new Chart(ctx2, {
        type: 'doughnut',
        data: {
          labels: ['Crescimento', 'Ativo', 'Queda', 'Risco'],
          datasets: [{
            data: [crescimento, ativos, queda, risco],
            backgroundColor: ['#10b981', '#6366f1', '#f97316', '#ef4444'],
            borderWidth: 0,
            hoverOffset: 4,
          }]
        },
        options: {
          cutout: '72%',
          plugins: { legend: { display: false }, tooltip: tooltipStyle() },
          responsive: true,
          maintainAspectRatio: false,
        }
      });
    }
  }, 50);
});

// ---- Dashboard da Diretoria ----
Router.register('diretoria', (params, el) => {
  // Tudo calculado de dados reais
  const clientes  = GLR.clientes;
  const gestores  = GLR.gestores;
  const tarefas   = GLR.tarefas;

  if (!clientes.length) {
    el.innerHTML = `<div class="page"><div style="text-align:center;padding:80px 24px;">
      <div style="font-size:48px;margin-bottom:16px;">👑</div>
      <div style="font-size:20px;font-weight:700;margin-bottom:8px;">Dashboard da Diretoria</div>
      <div style="font-size:14px;color:var(--text-muted);margin-bottom:24px;">Nenhum dado cadastrado ainda. Cadastre clientes para visualizar os indicadores.</div>
      <button class="btn btn-primary" onclick="Router.navigate('clientes')">Cadastrar clientes</button>
    </div></div>`;
    return;
  }

  // KPIs reais
  const total       = clientes.length;
  const emCrescimento = clientes.filter(c=>c.status==='crescimento').length;
  const emRisco     = clientes.filter(c=>c.status==='risco').length;
  const emQueda     = clientes.filter(c=>c.status==='queda').length;
  const fatTotal    = clientes.reduce((s,c)=>s+(c.faturamento||0),0);
  const crescMedio  = total ? (clientes.reduce((s,c)=>s+(c.crescimento||0),0)/total) : 0;
  const tasksPend   = tarefas.filter(t=>t.status==='pendente'||t.status==='em_andamento').length;
  const tasksConc   = tarefas.filter(t=>t.status==='concluida').length;
  const tasksAtras  = tarefas.filter(t=>t.status==='atrasada').length;

  // Receita GLR real
  let receitaGLR = 0;
  try {
    const projs = JSON.parse(localStorage.getItem('glr_projecoes')||'[]');
    clientes.forEach(c => {
      const proj = projs.find(p=>parseInt(p.chave)===c.id);
      if (!proj||!c.valorPorVenda) return;
      const dd = proj.diasDecorridos||2, dm = proj.diasNoMes||30;
      const vendas = proj.plataformas?.reduce((s,p)=>{
        const b=parseFloat(p.vendasBase)||0;
        return s+(b&&dd?(b/dd)*dm:0);
      },0)||0;
      receitaGLR += Math.round(vendas)*parseFloat(c.valorPorVenda);
    });
  } catch(e){}

  // Performance por gestor (dados reais)
  const gestoresComDados = gestores.map(g => {
    const clientesDoGestor = clientes.filter(c => c.gestor === g.nome);
    const crescMedioG = clientesDoGestor.length
      ? (clientesDoGestor.reduce((s,c)=>s+(c.crescimento||0),0)/clientesDoGestor.length) : 0;
    const tarefasG  = tarefas.filter(t=>t.responsavel===g.nome&&(t.status==='pendente'||t.status==='atrasada')).length;
    const fatG      = clientesDoGestor.reduce((s,c)=>s+(c.faturamento||0),0);
    const avatar    = g.nome.split(' ').map(n=>n[0]).slice(0,2).join('').toUpperCase();
    return { ...g, avatar, qtdClientes: clientesDoGestor.length, crescMedio: crescMedioG, tarefasPend: tarefasG, fat: fatG };
  }).filter(g=>g.qtdClientes>0||gestores.length<=5);

  // Clientes em atenção
  const clientesAtencao = clientes.filter(c=>c.status==='risco'||c.status==='queda')
    .sort((a,b)=>(a.crescimento||0)-(b.crescimento||0));

  // Concentração faturamento (top 8)
  const sorted = [...clientes].sort((a,b)=>(b.faturamento||0)-(a.faturamento||0)).slice(0,8);

  el.innerHTML = `<div class="page">
    <div style="margin-bottom:20px;padding:16px 20px;background:linear-gradient(135deg,rgba(99,102,241,0.15),rgba(139,92,246,0.1));border:1px solid rgba(99,102,241,0.2);border-radius:var(--radius);display:flex;align-items:center;gap:12px;">
      <span style="font-size:24px;">👑</span>
      <div>
        <div style="font-size:16px;font-weight:700;">Diretoria GLR — Visão Estratégica</div>
        <div style="font-size:13px;color:var(--text-secondary);">Dados em tempo real · ${total} clientes na carteira</div>
      </div>
    </div>

    <!-- KPIs -->
    <div class="kpi-grid">
      ${kpiCard('Total de Clientes', total, `${emCrescimento} em crescimento`, true, 'rgba(99,102,241,0.15)', '👥', '#6366f1')}
      ${kpiCard('Faturamento da Carteira', GLR.formatCurrency(fatTotal), 'soma das projeções', true, 'rgba(16,185,129,0.12)', '🏆', '#10b981')}
      ${kpiCard('Receita GLR', receitaGLR>0?GLR.formatCurrency(receitaGLR):'—', 'vendas × valor por venda', true, 'rgba(16,185,129,0.15)', '💰', '#10b981')}
      ${kpiCard('Crescimento Médio', `${crescMedio>=0?'+':''}${crescMedio.toFixed(1)}%`, 'média da carteira', crescMedio>=0, 'rgba(99,102,241,0.12)', '📈', '#6366f1')}
      ${kpiCard('Em Crescimento', emCrescimento, `${Math.round(emCrescimento/total*100)}% da carteira`, true, 'rgba(16,185,129,0.12)', '🚀', '#10b981')}
      ${kpiCard('Em Risco / Queda', emRisco+emQueda, `${emRisco} em risco · ${emQueda} em queda`, false, 'rgba(239,68,68,0.12)', '⚠️', '#ef4444')}
      ${kpiCard('Tarefas Pendentes', tasksPend, `${tasksAtras} atrasadas`, tasksAtras===0, 'rgba(245,158,11,0.12)', '✅', '#f59e0b')}
      ${kpiCard('Tarefas Concluídas', tasksConc, 'total concluídas', true, 'rgba(16,185,129,0.12)', '☑️', '#10b981')}
    </div>

    <!-- Gestores + Clientes atenção -->
    <div class="grid-2 mb-24">
      <div class="card">
        <div class="section-header">
          <div class="section-title">👨‍💼 Performance dos Gestores</div>
        </div>
        ${gestoresComDados.length===0
          ? `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Nenhum gestor cadastrado</div>`
          : gestoresComDados.map(g=>`
          <div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--border);">
            <div style="width:40px;height:40px;border-radius:50%;background:${g.cor||'#6366f1'}22;border:2px solid ${g.cor||'#6366f1'}44;
                        display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:${g.cor||'#6366f1'};flex-shrink:0;">${g.avatar}</div>
            <div style="flex:1;">
              <div style="font-size:14px;font-weight:600;">${g.nome}</div>
              <div style="font-size:12px;color:var(--text-muted);">${g.cargo||''} · ${g.qtdClientes} cliente${g.qtdClientes!==1?'s':''} · ${g.tarefasPend} tarefa${g.tarefasPend!==1?'s':''} pendente${g.tarefasPend!==1?'s':''}</div>
            </div>
            <div style="text-align:right;">
              <div class="ranking-val ${g.crescMedio>=0?'text-green':'text-red'}">${g.crescMedio>=0?'+':''}${g.crescMedio.toFixed(1)}%</div>
              <div style="font-size:11px;color:var(--text-muted);">${GLR.formatCurrency(g.fat)}</div>
            </div>
          </div>`).join('')}
      </div>

      <div class="card">
        <div class="section-header">
          <div class="section-title">🚨 Clientes em Risco ou Queda</div>
        </div>
        ${clientesAtencao.length===0
          ? `<div style="padding:32px;text-align:center;">
               <div style="font-size:32px;margin-bottom:8px;">✅</div>
               <div style="font-size:14px;font-weight:600;color:var(--green);">Nenhum cliente em risco</div>
               <div style="font-size:13px;color:var(--text-muted);margin-top:4px;">Carteira saudável</div>
             </div>`
          : clientesAtencao.map(c=>`
          <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;"
               onclick="Router.navigate('cliente-perfil',{id:${c.id}})">
            <div style="flex:1;">
              <div style="font-size:14px;font-weight:600;">${c.nome}</div>
              <div style="font-size:12px;color:var(--text-muted);">Gestor: ${c.gestor||'—'} · ${GLR.formatCurrency(c.faturamento||0)}</div>
            </div>
            <div style="text-align:right;">
              <div class="ranking-val text-red">${c.crescimento||0}%</div>
              <span class="badge ${GLR.statusColor[c.status]}">${GLR.statusLabel[c.status]}</span>
            </div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Concentração de receita -->
    ${sorted.some(c=>c.faturamento>0) ? `
    <div class="card mb-24">
      <div class="section-header">
        <div class="section-title">💼 Concentração de Faturamento</div>
        <div class="section-subtitle">Participação de cada cliente</div>
      </div>
      <div class="chart-wrapper">
        <canvas id="chart-concentracao"></canvas>
      </div>
    </div>` : ''}

    <!-- Ranking completo -->
    <div class="card">
      <div class="section-header">
        <div class="section-title">📋 Carteira Completa</div>
        <button class="btn btn-ghost btn-sm" onclick="Router.navigate('clientes')">Gerenciar</button>
      </div>
      <table class="table" style="font-size:13px;">
        <thead><tr>
          <th>Cliente</th><th>Gestor</th><th>Status</th>
          <th style="text-align:right;">Faturamento</th>
          <th style="text-align:right;">Crescimento</th>
          <th></th>
        </tr></thead>
        <tbody>
        ${[...clientes].sort((a,b)=>(b.faturamento||0)-(a.faturamento||0)).map(c=>`
          <tr style="cursor:pointer;" onclick="Router.navigate('cliente-perfil',{id:${c.id}})">
            <td style="font-weight:600;">${c.nome}</td>
            <td style="color:var(--text-muted);">${c.gestor||'—'}</td>
            <td><span class="badge ${GLR.statusColor[c.status]}">${GLR.statusLabel[c.status]}</span></td>
            <td style="text-align:right;">${GLR.formatCurrency(c.faturamento||0)}</td>
            <td style="text-align:right;color:${(c.crescimento||0)>=0?'var(--green)':'var(--red)'};">${(c.crescimento||0)>=0?'+':''}${c.crescimento||0}%</td>
            <td style="text-align:right;"><button class="btn btn-ghost btn-sm">Ver perfil →</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

  // Gráfico concentração (só se tiver dados)
  setTimeout(() => {
    const ctx = document.getElementById('chart-concentracao');
    if (ctx && sorted.some(c=>c.faturamento>0)) {
      new Chart(ctx, {
        type: 'bar',
        data: {
          labels: sorted.map(c=>c.nome.split(' ').slice(0,2).join(' ')),
          datasets: [{
            data: sorted.map(c=>c.faturamento||0),
            backgroundColor: ['#6366f1','#8b5cf6','#06b6d4','#10b981','#f59e0b','#f97316','#ef4444','#ec4899'],
            borderRadius: 4,
          }]
        },
        options: { ...chartDefaults(), indexAxis:'y', plugins:{legend:{display:false},tooltip:tooltipStyle()} }
      });
    }
  }, 50);
});

// ---- Shared KPI card builder ----
function kpiCard(label, value, sub, positive, iconBg, icon, iconColor, rawHtml = false) {
  return `<div class="kpi-card">
    <div class="kpi-icon" style="background:${iconBg};">
      <span style="font-size:18px;">${icon}</span>
    </div>
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    ${rawHtml ? sub : `<div class="kpi-delta ${positive ? 'up' : 'down'}">${positive ? '▲' : '▼'} ${sub}</div>`}
  </div>`;
}

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: tooltipStyle(),
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
        ticks: { color: '#5a5b72', font: { size: 11 } },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
        ticks: {
          color: '#5a5b72', font: { size: 11 },
          callback: v => v >= 1000000 ? (v/1000000).toFixed(1)+'M' : v >= 1000 ? (v/1000).toFixed(0)+'k' : v
        },
      }
    }
  };
}

function tooltipStyle() {
  return {
    backgroundColor: '#16161f',
    borderColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    titleColor: '#f1f1f8',
    bodyColor: '#9192a8',
    padding: 10,
    cornerRadius: 8,
    callbacks: {
      label: ctx => {
        const v = ctx.raw;
        if (typeof v === 'number' && v > 1000) return ' R$ ' + v.toLocaleString('pt-BR');
        return ' ' + v;
      }
    }
  };
}
