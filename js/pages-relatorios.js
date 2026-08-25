// ============================================================
// GLR Consultoria — Relatórios (Relatório Diário de Ações dos Analistas)
// ============================================================

const ICONE_ACAO_REL = { Reunião:'🤝', Campanha:'📣', Otimização:'⚡', Precificação:'💲', Estratégia:'♟️', Análise:'🔍', Onboarding:'🚀', Relatório:'📄', Catálogo:'📂', NPS:'⭐', Interno:'🏠' };

function _relHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

Router.register('relatorios', (params, el) => {
  if (!GLR.gestores.length) {
    el.innerHTML = `<div class="page">
      <div style="text-align:center;padding:80px 24px;">
        <div style="font-size:52px;margin-bottom:16px;">📋</div>
        <div style="font-size:20px;font-weight:800;color:var(--text-primary);margin-bottom:8px;">Nenhum gestor cadastrado ainda</div>
        <div style="font-size:14px;color:var(--text-muted);max-width:420px;margin:0 auto 24px;">O relatório diário mostra as ações registradas por cada gestor. Cadastre pelo menos um gestor antes de continuar.</div>
        <button class="btn btn-primary" onclick="Router.navigate('gestores')">Cadastrar gestor</button>
      </div>
    </div>`;
    return;
  }

  let dataSel = _relHojeISO();

  function fmtDataBR(iso) {
    const [y,m,d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }
  function addDias(iso, n) {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function acoesDoDia() {
    return GLR.acoes.filter(a => a.data === dataSel);
  }
  function agruparPorGestor(acoes) {
    const porGestor = {};
    GLR.gestores.forEach(g => { porGestor[g.nome] = []; });
    acoes.forEach(a => {
      if (!porGestor[a.responsavel]) porGestor[a.responsavel] = [];
      porGestor[a.responsavel].push(a);
    });
    return porGestor;
  }

  function montarTexto() {
    const acoes = acoesDoDia();
    const porGestor = agruparPorGestor(acoes);
    const clientesUnicos = new Set(acoes.map(a => a.clienteId).filter(Boolean)).size;
    const ativos = Object.values(porGestor).filter(l => l.length > 0).length;

    let txt = `📋 Relatório Diário de Ações — ${fmtDataBR(dataSel)}\n\n`;
    txt += `Total: ${acoes.length} ${acoes.length !== 1 ? 'ações' : 'ação'} · ${ativos}/${GLR.gestores.length} analistas ativos · ${clientesUnicos} cliente${clientesUnicos !== 1 ? 's' : ''} atendido${clientesUnicos !== 1 ? 's' : ''}\n\n`;
    Object.entries(porGestor).forEach(([nome, lista]) => {
      txt += `👤 ${nome} (${lista.length})\n`;
      if (!lista.length) {
        txt += `   ⚠️ Sem atividade registrada\n`;
      } else {
        lista.forEach(a => {
          const c = GLR.clientes.find(cl => cl.id === a.clienteId);
          const icone = ICONE_ACAO_REL[a.categoria] || '📌';
          txt += `   ${icone} [${a.categoria}]${c ? ` ${c.nome} —` : ''} ${a.descricao}\n`;
        });
      }
      txt += `\n`;
    });
    return txt;
  }

  function renderCorpo() {
    const acoes = acoesDoDia();
    const porGestor = agruparPorGestor(acoes);
    const clientesUnicos = new Set(acoes.map(a => a.clienteId).filter(Boolean)).size;
    const ativos = Object.values(porGestor).filter(l => l.length > 0).length;
    const contagemCat = {};
    acoes.forEach(a => { contagemCat[a.categoria] = (contagemCat[a.categoria] || 0) + 1; });
    const catTop = Object.entries(contagemCat).sort((a, b) => b[1] - a[1])[0];

    document.getElementById('rel-kpis').innerHTML = `
      ${kpiCard('Ações no Dia', acoes.length, acoes.length ? 'registradas' : 'nenhuma ainda', acoes.length > 0, 'rgba(99,102,241,0.15)', '📋', '#6366f1')}
      ${kpiCard('Analistas Ativos', `${ativos}/${GLR.gestores.length}`, ativos === GLR.gestores.length ? 'todos registraram' : `${GLR.gestores.length - ativos} sem registro`, ativos === GLR.gestores.length, 'rgba(16,185,129,0.12)', '👥', '#10b981')}
      ${kpiCard('Clientes Atendidos', clientesUnicos, 'clientes únicos no dia', clientesUnicos > 0, 'rgba(245,158,11,0.12)', '🏢', '#f59e0b')}
      ${kpiCard('Categoria Mais Comum', catTop ? catTop[0] : '—', catTop ? `${catTop[1]} ação${catTop[1] !== 1 ? 'ões' : ''}` : 'sem dados', !!catTop, 'rgba(139,92,246,0.12)', '🏷️', '#8b5cf6')}
    `;

    document.getElementById('rel-lista').innerHTML = GLR.gestores.map(g => {
      const lista = porGestor[g.nome] || [];
      const semAtividade = lista.length === 0;
      return `
        <div class="card" style="margin-bottom:14px;${semAtividade ? 'opacity:.7;' : ''}">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${lista.length ? '14px' : '0'};">
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="width:34px;height:34px;border-radius:50%;background:${g.cor || '#6366f1'}22;color:${g.cor || '#6366f1'};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${g.avatar || g.nome?.slice(0,2).toUpperCase() || ''}</div>
              <div style="font-size:14px;font-weight:700;color:var(--text-primary);">${g.nome}</div>
            </div>
            <span class="badge" style="background:${semAtividade ? 'var(--red-bg)' : 'var(--green-bg)'};color:${semAtividade ? 'var(--red)' : 'var(--green)'};">${lista.length} ${lista.length === 1 ? 'ação' : 'ações'}</span>
          </div>
          ${semAtividade
            ? `<div style="font-size:12.5px;color:var(--text-muted);padding:4px 0 2px;">⚠️ Nenhuma ação registrada nesse dia.</div>`
            : lista.map(a => {
                const c = GLR.clientes.find(cl => cl.id === a.clienteId);
                const cor = GLR.tipoAcaoColor[a.categoria] || '#6366f1';
                const icone = ICONE_ACAO_REL[a.categoria] || '📌';
                return `
                  <div style="display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--border);">
                    <div style="font-size:16px;">${icone}</div>
                    <div style="flex:1;min-width:0;">
                      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <span class="badge" style="background:${cor}20;color:${cor};">${a.categoria}</span>
                        ${c ? `<span style="font-size:12px;color:var(--text-muted);">${c.nome}</span>` : ''}
                        <span class="badge ${a.status === 'concluida' ? 'status-crescimento' : 'status-ativo'}" style="margin-left:auto;">${a.status === 'concluida' ? 'Concluída' : 'Em andamento'}</span>
                        <button onclick="openModalNovaAcao(${a.clienteId ?? 'null'}, ${a.id})" title="Editar ação" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:12px;padding:2px 4px;">✏️</button>
                      </div>
                      <div style="font-size:13px;color:var(--text-primary);margin-top:4px;">${a.descricao}</div>
                    </div>
                  </div>
                `;
              }).join('')
          }
        </div>
      `;
    }).join('');

    const labelEl = document.getElementById('rel-data-label');
    if (labelEl) labelEl.textContent = dataSel === _relHojeISO() ? `Hoje, ${fmtDataBR(dataSel)}` : fmtDataBR(dataSel);
    const inputEl = document.getElementById('rel-data-input');
    if (inputEl) inputEl.value = dataSel;
  }

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="_relDia(-1)">‹</button>
        <div style="text-align:center;min-width:150px;">
          <div id="rel-data-label" style="font-size:15px;font-weight:700;color:var(--text-primary);"></div>
          <input type="date" id="rel-data-input" style="background:none;border:none;color:var(--text-muted);font-size:11px;cursor:pointer;">
        </div>
        <button class="btn btn-ghost btn-sm" onclick="_relDia(1)">›</button>
        <button class="btn btn-ghost btn-sm" onclick="_relHoje()">Hoje</button>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary btn-sm" id="rel-btn-copiar" onclick="_relCopiar()">📋 Copiar Relatório</button>
        <button class="btn btn-primary btn-sm" onclick="_relNovaAcao()">+ Registrar Ação</button>
      </div>
    </div>

    <div id="rel-kpis" class="kpi-grid" style="margin-bottom:24px;"></div>

    <div class="section-title mb-16">👥 Ações por Analista</div>
    <div id="rel-lista"></div>
  </div>`;

  document.getElementById('rel-data-input').addEventListener('change', e => {
    dataSel = e.target.value;
    renderCorpo();
  });

  window._relDia = (delta) => {
    dataSel = addDias(dataSel, delta);
    renderCorpo();
  };
  window._relHoje = () => {
    dataSel = _relHojeISO();
    renderCorpo();
  };
  window._relNovaAcao = () => {
    if (!GLR.clientes.length) { alert('Cadastre um cliente antes de registrar uma ação.'); return; }
    openModalNovaAcao(GLR.clientes[0].id);
  };
  window._relCopiar = () => {
    const txt = montarTexto();
    navigator.clipboard.writeText(txt).then(() => {
      const btn = document.getElementById('rel-btn-copiar');
      if (!btn) return;
      const original = btn.textContent;
      btn.textContent = '✅ Copiado!';
      setTimeout(() => { btn.textContent = original; }, 1800);
    }).catch(() => alert('Não foi possível copiar automaticamente. Copie o texto manualmente.'));
  };

  renderCorpo();
});
