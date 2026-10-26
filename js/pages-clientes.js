// ============================================================
// GLR Consultoria — Gestão de Clientes + Perfil do Cliente
// ============================================================

// ---- Persistência ----
function salvarClientes() {
  localStorage.setItem('glr_clientes', JSON.stringify(GLR.clientes));
}

function nomeGestor(gestorId) {
  const g = GLR.gestores.find(g => g.id === gestorId);
  return g ? g.nome : '—';
}
function corGestor(gestorId) {
  return GLR.gestores.find(g => g.id === gestorId)?.cor || 'var(--accent)';
}
function iniciaisGestor(gestorId) {
  const n = nomeGestor(gestorId);
  return n.split(' ').slice(0,2).map(w => w[0]).join('');
}

// ---- Carteira de Clientes ----
Router.register('clientes', (params, el) => {
  let filtroGestor = params.gestor || '';
  let filtroStatus = params.status || '';

  if (!GLR.clientes.length) {
    el.innerHTML = `<div class="page">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <div style="font-size:13px;color:var(--text-muted);">0 clientes na carteira</div>
        <button class="btn btn-primary" onclick="openModalNovoCliente()">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          Novo Cliente
        </button>
      </div>
      <div style="text-align:center;padding:60px 24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);">
        <div style="font-size:40px;margin-bottom:12px;">🏢</div>
        <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Nenhum cliente cadastrado</div>
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">Adicione o primeiro cliente para começar a acompanhar a carteira.</div>
        ${!GLR.gestores.length ? `<div style="font-size:12px;color:var(--yellow);background:var(--yellow-bg);padding:8px 14px;border-radius:var(--radius-sm);display:inline-block;margin-bottom:16px;">⚠️ Cadastre pelo menos um gestor antes de adicionar clientes.</div><br>
        <button class="btn btn-secondary" onclick="Router.navigate('gestores')">Cadastrar Gestor</button>` :
        `<button class="btn btn-primary" onclick="openModalNovoCliente()">+ Novo Cliente</button>`}
      </div>
    </div>`;
    setupClienteHandlers();
    return;
  }

  function renderClientes() {
    // Enriquece com dados da API (faturamento, crescimento, status reais)
    const clientesAPI = typeof computarClientesAPI === 'function' ? computarClientesAPI() : GLR.clientes;
    const mapaAPI = {};
    clientesAPI.forEach(c => { mapaAPI[c.id] = c; });

    let lista = GLR.clientes.map(c => mapaAPI[c.id] || c);
    if (filtroGestor) lista = lista.filter(c => c.gestorId === parseInt(filtroGestor));
    if (filtroStatus) lista = lista.filter(c => c.status === filtroStatus);

    if (!lista.length) return `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted);">Nenhum cliente encontrado com os filtros aplicados.</td></tr>`;

    return lista.map(c => {
      const temAPI = c._temAPI === true;
      const fat  = temAPI ? (c.faturamento || 0) : null;
      const cresc = temAPI ? (c.crescimento || 0) : null;

      return `<tr onclick="Router.navigate('cliente-perfil', {id: ${c.id}})">
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:36px;height:36px;border-radius:var(--radius-sm);background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:white;flex-shrink:0;">${c.nome.charAt(0)}</div>
            <div>
              <div style="font-size:14px;font-weight:600;color:var(--text-primary);">${c.nome}</div>
              <div style="font-size:11.5px;color:var(--text-muted);">${c.categoria || ''}</div>
            </div>
          </div>
        </td>
        <td>
          ${c.gestorId ? `<div style="display:flex;align-items:center;gap:8px;">
            <div style="width:28px;height:28px;border-radius:50%;background:color-mix(in srgb,${corGestor(c.gestorId)} 13%,transparent);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:${corGestor(c.gestorId)};">${iniciaisGestor(c.gestorId)}</div>
            <span style="font-size:13px;">${nomeGestor(c.gestorId)}</span>
          </div>` : '<span style="color:var(--text-muted);">—</span>'}
        </td>
        <td>
          ${GLR.comissao.temComissao(c) ? `<span style="font-size:13px;font-weight:600;color:var(--green);">${GLR.comissao.descricao(c, true)}</span>` : '<span style="color:var(--text-muted);">—</span>'}
        </td>
        <td><span class="badge ${GLR.statusColor[c.status] || 'status-ativo'}">${GLR.statusLabel[c.status] || c.status}</span></td>
        <td>${fat !== null && fat > 0 ? GLR.formatCurrency(fat) : '<span style="color:var(--text-muted);">—</span>'}</td>
        <td>
          ${cresc !== null
            ? `<span class="fw-700 ${cresc >= 0 ? 'text-green' : 'text-red'}">${cresc >= 0 ? '+' : ''}${cresc}%</span>`
            : '<span style="color:var(--text-muted);">—</span>'}
        </td>
      </tr>`;
    }).join('');
  }

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <div style="font-size:13px;color:var(--text-muted);">${GLR.clientes.length} cliente${GLR.clientes.length !== 1 ? 's' : ''} na carteira</div>
      <button class="btn btn-primary" onclick="openModalNovoCliente()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        Novo Cliente
      </button>
    </div>

    <div class="filters">
      <select class="filter-select" id="filter-gestor" onchange="filterClientes()">
        <option value="">Todos os gestores</option>
        ${GLR.gestores.map(g => `<option value="${g.id}" ${filtroGestor == g.id ? 'selected' : ''}>${g.nome}</option>`).join('')}
      </select>
      <select class="filter-select" id="filter-status" onchange="filterClientes()">
        <option value="">Todos os status</option>
        <option value="crescimento">Em Crescimento</option>
        <option value="ativo">Ativo</option>
        <option value="queda">Em Queda</option>
        <option value="risco">Em Risco</option>
      </select>
      <button class="btn btn-ghost btn-sm" onclick="clearFiltersClientes()">Limpar filtros</button>
    </div>

    <div class="card" style="padding:0;overflow:hidden;">
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Empresa</th>
              <th>Gestor GLR</th>
              <th>Valor por Venda</th>
              <th>Status</th>
              <th>Faturamento</th>
              <th>Crescimento</th>
            </tr>
          </thead>
          <tbody id="clientes-tbody">${renderClientes()}</tbody>
        </table>
      </div>
    </div>
  </div>`;

  window.filterClientes = () => {
    filtroGestor = document.getElementById('filter-gestor').value;
    filtroStatus = document.getElementById('filter-status').value;
    document.getElementById('clientes-tbody').innerHTML = renderClientes();
  };

  window.clearFiltersClientes = () => {
    filtroGestor = ''; filtroStatus = '';
    document.getElementById('filter-gestor').value = '';
    document.getElementById('filter-status').value = '';
    document.getElementById('clientes-tbody').innerHTML = renderClientes();
  };

  setupClienteHandlers();
});

// ---- Modal Novo/Editar Cliente ----
function setupClienteHandlers() {
  // ── Formulário: modelo de comissão (venda / fixo mensal / faixa de ticket) ──
  window._cliComLer = () => {
    const v = id => parseFloat(document.getElementById(id)?.value) || 0;
    const modelo = document.getElementById('c-com-modelo')?.value || 'venda';
    if (modelo === 'fixo') return { valorPorVenda: 0, comissao: { modelo, fixo: v('c-com-fixo-v'), franquia: Math.round(v('c-com-franquia')), excedente: v('c-com-exc') } };
    if (modelo === 'ticket') {
      const ac = [...document.querySelectorAll('#c-com-faixas .c-fx-acima')].map(i => parseFloat(i.value) || 0), vl = [...document.querySelectorAll('#c-com-faixas .c-fx-valor')].map(i => parseFloat(i.value) || 0);
      const faixas = ac.map((a, i) => ({ acima: a, valor: vl[i] })).filter((f, i, arr) => arr.findIndex(x => x.acima === f.acima) === i).sort((a, b) => b.acima - a.acima);
      if (!faixas.some(f => f.acima === 0)) faixas.push({ acima: 0, valor: 0 });
      return { valorPorVenda: 0, comissao: { modelo, faixas } };
    }
    return { valorPorVenda: v('c-valor-venda'), comissao: { modelo: 'venda', valor: v('c-valor-venda') } };
  };
  window._cliComModelo = () => {
    const m = document.getElementById('c-com-modelo').value;
    ['venda', 'fixo', 'ticket'].forEach(k => { const el = document.getElementById(`c-com-${k}`); if (el) el.hidden = k !== m; });
    window._cliComPrevia();
  };
  window._cliComFaixa = () => {
    const box = document.getElementById('c-com-faixas'); if (!box) return;
    const d = document.createElement('div'); d.className = 'cli-faixa';
    d.innerHTML = `<label>Pedido a partir de R$ <input class="form-input c-fx-acima" type="number" step="0.01" min="0" value="100" oninput="window._cliComPrevia()"></label><label>R$ por pedido <input class="form-input c-fx-valor" type="number" step="0.01" min="0" value="1.5" oninput="window._cliComPrevia()"></label>`;
    box.insertBefore(d, box.firstChild); window._cliComPrevia();
  };
  window._cliComPrevia = () => {
    const el = document.getElementById('c-com-previa'); if (!el) return;
    const c = window._cliComLer(), m = GLR.comissao.modelo(c), R = x => 'R$ ' + x.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (m.modelo === 'fixo') { const n1 = Math.max(1, Math.round(m.franquia * 0.6)), n2 = Math.round(m.franquia * 1.2) || 1; el.textContent = `Ex.: ${n1} pedidos no mês → ${R(GLR.comissao.fixoDoMes(m, n1))} · ${n2} pedidos → ${R(GLR.comissao.fixoDoMes(m, n2))}`; }
    else if (m.modelo === 'ticket') el.textContent = `Ex.: pedido de R$ 35 → ${R(GLR.comissao.dePedido(c, 35, 1))} · pedido de R$ 120 → ${R(GLR.comissao.dePedido(c, 120, 1))}`;
    else el.textContent = m.valor ? `Ex.: 100 unidades vendidas → ${R(100 * m.valor)}` : '';
  };
  window.openModalNovoCliente = (clienteId = null) => {
    const c = clienteId ? GLR.clientes.find(cl => cl.id === clienteId) : null;

    if (!GLR.gestores.length) {
      alert('Cadastre pelo menos um gestor antes de adicionar clientes.');
      Router.navigate('gestores');
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" style="max-width:600px;">
      <div class="modal-header">
        <div class="modal-title">${c ? 'Editar Cliente' : 'Novo Cliente'}</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group" style="grid-column:1/-1;">
          <label class="form-label">Nome da Empresa *</label>
          <input class="form-input" id="c-nome" placeholder="Ex: Gama Móveis Ltda" value="${c?.nome || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Responsável (cliente)</label>
          <input class="form-input" id="c-responsavel" placeholder="Nome do contato" value="${c?.responsavel || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Segmento / Categoria</label>
          <input class="form-input" id="c-categoria" placeholder="Ex: Móveis, Eletrônicos" value="${c?.categoria || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Gestor GLR Responsável *</label>
          <select class="form-select" id="c-gestor">
            <option value="">Selecione o gestor</option>
            ${GLR.gestores.map(g => `<option value="${g.id}" ${c?.gestorId === g.id ? 'selected' : ''}>${g.nome}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">Comissão GLR</label>
          ${(() => {
            const m = GLR.comissao.modelo(c || {}), cm = c?.comissao || {};
            const fx = (cm.modelo === 'ticket' ? cm.faixas : null) || [{ acima: 50, valor: 1 }, { acima: 0, valor: 0.3 }];
            return `<select class="form-select" id="c-com-modelo" onchange="window._cliComModelo()">
              <option value="venda" ${m.modelo === 'venda' ? 'selected' : ''}>Por venda — R$ por unidade vendida</option>
              <option value="fixo" ${m.modelo === 'fixo' ? 'selected' : ''}>Fixo mensal — até uma quantidade de pedidos, depois por pedido</option>
              <option value="ticket" ${m.modelo === 'ticket' ? 'selected' : ''}>Por faixa de ticket — R$ por pedido conforme o valor do pedido</option>
            </select>
            <div id="c-com-venda" class="cli-com" ${m.modelo === 'venda' ? '' : 'hidden'}>
              <label>R$ por venda <input class="form-input" id="c-valor-venda" type="number" step="0.01" min="0" placeholder="Ex: 2.00" value="${m.modelo === 'venda' && m.valor ? m.valor : (c?.valorPorVenda || '')}" oninput="window._cliComPrevia()"></label>
            </div>
            <div id="c-com-fixo" class="cli-com" ${m.modelo === 'fixo' ? '' : 'hidden'}>
              <label>Fixo por mês (R$) <input class="form-input" id="c-com-fixo-v" type="number" step="0.01" min="0" placeholder="1500" value="${cm.modelo === 'fixo' ? cm.fixo : ''}" oninput="window._cliComPrevia()"></label>
              <label>Até quantos pedidos <input class="form-input" id="c-com-franquia" type="number" step="1" min="0" placeholder="500" value="${cm.modelo === 'fixo' ? cm.franquia : ''}" oninput="window._cliComPrevia()"></label>
              <label>Acima disso, R$ por pedido <input class="form-input" id="c-com-exc" type="number" step="0.01" min="0" placeholder="3.00" value="${cm.modelo === 'fixo' ? cm.excedente : ''}" oninput="window._cliComPrevia()"></label>
            </div>
            <div id="c-com-ticket" class="cli-com" ${m.modelo === 'ticket' ? '' : 'hidden'}>
              <div id="c-com-faixas">${fx.map((f, i) => `<div class="cli-faixa"><label>Pedido a partir de R$ <input class="form-input c-fx-acima" type="number" step="0.01" min="0" value="${f.acima}" ${i === fx.length - 1 && +f.acima === 0 ? 'readonly title="faixa de baixo: todo o resto"' : ''} oninput="window._cliComPrevia()"></label><label>R$ por pedido <input class="form-input c-fx-valor" type="number" step="0.01" min="0" value="${f.valor}" oninput="window._cliComPrevia()"></label></div>`).join('')}</div>
              <button type="button" class="btn btn-secondary btn-sm" onclick="window._cliComFaixa()">+ faixa</button>
            </div>
            <div id="c-com-previa" class="cli-com-previa"></div>
            <style>.cli-com{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}.cli-com label,.cli-faixa label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--text-secondary);min-width:150px}.cli-faixa{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px}.cli-com-previa{font-size:12px;color:var(--text-muted);margin-top:6px}</style>`;
          })()}
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="c-status">
            <option value="ativo" ${(!c || c.status==='ativo')?'selected':''}>Ativo</option>
            <option value="crescimento" ${c?.status==='crescimento'?'selected':''}>Em Crescimento</option>
            <option value="queda" ${c?.status==='queda'?'selected':''}>Em Queda</option>
            <option value="risco" ${c?.status==='risco'?'selected':''}>Em Risco</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Meta Mensal (R$)</label>
          <input class="form-input" id="c-meta-mensal" type="number" step="0.01" min="0"
            placeholder="Ex: 100000.00" value="${c?.metaMensal || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">ADS Ideal (% do faturamento)</label>
          <input class="form-input" id="c-ads-ideal" type="number" step="0.1" min="0" max="100"
            placeholder="Ex: 4 (padrão)" value="${c?.adsIdeal != null ? (c.adsIdeal*100) : ''}">
        </div>
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
        ${c ? `<button class="btn btn-ghost btn-sm" style="color:var(--red);margin-right:auto;" onclick="removerCliente(${c.id})">Remover</button>` : ''}
        <button class="btn btn-primary" onclick="salvarCliente(${c?.id || 'null'})">
          ${c ? 'Salvar alterações' : 'Cadastrar Cliente'}
        </button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    window._cliComPrevia();
  };

  window.salvarCliente = (id) => {
    const nome = document.getElementById('c-nome').value.trim();
    const gestorId = parseInt(document.getElementById('c-gestor').value);
    if (!nome) { alert('Informe o nome da empresa.'); return; }
    if (!gestorId) { alert('Selecione o gestor responsável.'); return; }

    const existente = id ? GLR.clientes.find(c => c.id === id) : null;

    const cliente = {
      id: id || GLR.nextId(GLR.clientes),
      nome,
      responsavel:  document.getElementById('c-responsavel').value.trim(),
      categoria:    document.getElementById('c-categoria').value.trim(),
      gestorId,
      ...window._cliComLer(),
      status:       document.getElementById('c-status').value,
      metaMensal:   parseFloat(document.getElementById('c-meta-mensal').value) || 0,
      adsIdeal:     document.getElementById('c-ads-ideal').value !== '' ? parseFloat(document.getElementById('c-ads-ideal').value)/100 : 0.04,
      // Preserva dados existentes ou inicia zerado
      faturamento:  existente?.faturamento  || 0,
      crescimento:  existente?.crescimento  || 0,
      score:        existente?.score        || 0,
      historico:    existente?.historico    || [],
      scoreDetalhes: existente?.scoreDetalhes || { precificacao:0, rentabilidade:0, crescimento:0, execucao:0, conversao:0, organizacao:0 },
    };

    if (id) {
      const idx = GLR.clientes.findIndex(c => c.id === id);
      if (idx >= 0) GLR.clientes[idx] = cliente;
    } else {
      GLR.clientes.push(cliente);
    }

    salvarClientes();
    document.querySelector('.modal-overlay')?.remove();
    Router.navigate('clientes');
  };

  window.removerCliente = (id) => {
    const c = GLR.clientes.find(cl => cl.id === id);
    if (!confirm(`Remover o cliente "${c?.nome}"? Esta ação não pode ser desfeita.`)) return;
    GLR.clientes = GLR.clientes.filter(cl => cl.id !== id);
    salvarClientes();
    document.querySelector('.modal-overlay')?.remove();
    Router.navigate('clientes');
  };
}

// ---- Perfil do Cliente ----
Router.register('cliente-perfil', (params, el) => {
  setupClienteHandlers(); // "Editar" funciona mesmo abrindo o perfil direto
  const clienteId = parseInt(params.id);

  // Sempre relê do localStorage para garantir dados atualizados
  function getCliente() {
    try {
      const saved = localStorage.getItem('glr_clientes');
      if (saved) GLR.clientes = JSON.parse(saved);
    } catch(e) {}
    return GLR.clientes.find(cl => cl.id === clienteId);
  }

  if (!getCliente()) {
    el.innerHTML = `<div class="page">
      <div style="text-align:center;padding:60px;">
        <div style="font-size:36px;margin-bottom:12px;">🔍</div>
        <div style="font-size:16px;font-weight:700;margin-bottom:16px;">Cliente não encontrado</div>
        <button class="btn btn-primary" onclick="Router.navigate('clientes')">← Voltar para Clientes</button>
      </div>
    </div>`;
    return;
  }

  let activeTab = 'overview';

  function renderTab() {
    // Relê o cliente sempre com dados frescos
    const c = getCliente();
    if (!c) return;

    const acoes        = GLR.acoes.filter(a => a.clienteId === c.id);
    const tarefas      = GLR.tarefas.filter(t => t.clienteId === c.id);

    const tabContent = document.getElementById('tab-content');
    if (!tabContent) return;

    if (activeTab === 'overview') {
      const fat   = c.faturamento || 0;
      const cresc = c.crescimento || 0;

      // Investimento em Mídia — vem da projeção (adsBase ou adsProj)
      let investMidia = 0;
      try {
        const projs = JSON.parse(localStorage.getItem('glr_projecoes') || '[]');
        const proj  = projs.find(p => parseInt(p.chave) === c.id);
        if (proj?.plataformas) {
          const dd = Math.max(parseInt(proj.diasDecorridos)||1,1);
          const dm = Math.max(parseInt(proj.diasNoMes)||30,1);
          investMidia = proj.plataformas.reduce((s,p) => s + (parseFloat(p.adsBase)||0)/dd*dm, 0);
        }
      } catch(e) {}

      // ROAS = faturamento / investimento em ADS
      const roas = fat > 0 && investMidia > 0 ? (fat / investMidia).toFixed(1) : null;

      tabContent.innerHTML = `
        <div class="grid-2 mb-16">
          <div class="card">
            <div class="section-title mb-16">Indicadores</div>
            <div class="grid-2" style="gap:12px;">
              ${indicadorCard('Faturamento', fat ? GLR.formatCurrencyFull(fat) : '—', cresc >= 0 ? 'text-green' : 'text-red', `${cresc >= 0 ? '+' : ''}${cresc}% vs mês ant.`)}
              ${indicadorCard('Comissão GLR', GLR.comissao.temComissao(c) ? GLR.comissao.descricao(c, true) : '—', 'text-green', (() => { const cts = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}')[String(c.id)] || []; const fora = cts.filter(ct => !GLR.contaGeraComissao(ct)).length; return fora ? `Por venda · ${cts.length - fora} de ${cts.length} contas contam comissão` : 'Por venda realizada'; })())}
              ${indicadorCard('Invest. Mídia (ADS)', investMidia > 0 ? GLR.formatCurrencyFull(investMidia) : '—', 'text-accent', roas ? `ROAS: ${roas}x` : 'Da projeção do mês')}
              ${indicadorCard('Status', GLR.statusLabel[c.status] || '—', c.status === 'crescimento' ? 'text-green' : c.status === 'risco' ? 'text-red' : 'text-accent', 'Atualizado pela projeção')}
            </div>
          </div>
        </div>

        <!-- Contas Marketplace vinculadas -->
        ${(() => {
          const vinc      = JSON.parse(localStorage.getItem('glr_mc_vinculos')   || '{}');
          const aliquotas = JSON.parse(localStorage.getItem('glr_aliquotas')      || '{}');
          const contas = vinc[c.id] || [];
          if (!contas.length) return '';
          const platIcon  = { meli:'🟡', ml:'🟡', mercadolivre:'🟡', shopee:'🟠' };
          const platNome  = { meli:'Mercado Livre', ml:'Mercado Livre', mercadolivre:'Mercado Livre', shopee:'Shopee' };
          const platColor = { meli:'#f59e0b', ml:'#f59e0b', mercadolivre:'#f59e0b', shopee:'#f97316' };
          return `<div class="card mb-16" id="card-contas-mp">
            <div class="section-header" style="margin-bottom:12px;">
              <div class="section-title">Contas Marketplace</div>
              <button onclick="window.carregarDadosContas(${c.id})" class="btn btn-secondary btn-sm" id="btn-carregar-contas">Carregar dados</button>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;" id="contas-mp-grid">
              ${contas.map(ct => {
                const mp   = ct.marketplace || ct.plataforma || '';
                const extId = ct.external_id || ct.id || '';
                const icon = platIcon[mp] || '🏪';
                const nome = ct.nickname || platNome[mp] || mp;
                const cor  = platColor[mp] || 'var(--text-muted)';
                const aliq = aliquotas[extId] || '';
                const contaCom = GLR.contaGeraComissao(ct);
                return `<div id="conta-card-${extId}" class="${contaCom ? '' : 'conta-sem-comissao'}" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px;">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
                    <span style="font-size:20px;">${icon}</span>
                    <div style="flex:1;min-width:0;">
                      <div style="font-size:13px;font-weight:700;color:${cor};">${nome}</div>
                      <div style="font-size:10px;color:var(--text-muted);">${extId}</div>
                    </div>
                  </div>

                  <!-- Alíquota de imposto -->
                  <div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;padding:8px 10px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:7px;">
                    <span style="font-size:11px;color:var(--yellow);font-weight:600;white-space:nowrap;">Imposto</span>
                    <input type="number" min="0" max="100" step="0.1" placeholder="0"
                      value="${aliq}"
                      id="aliq-${extId}"
                      onchange="window.salvarAliquota('${extId}', this.value)"
                      style="flex:1;background:var(--bg-subtle);border:1px solid rgba(251,191,36,0.3);border-radius:5px;padding:4px 8px;color:var(--yellow);font-size:13px;font-weight:700;text-align:right;width:100%;box-sizing:border-box;">
                    <span style="font-size:12px;color:var(--yellow);font-weight:600;">%</span>
                  </div>

                  <!-- Comissão GLR nesta conta -->
                  <label class="conta-comissao" title="Desmarque se as vendas desta conta não entram na comissão (valor por venda) da GLR">
                    <input type="checkbox" id="com-${extId}" ${contaCom ? 'checked' : ''} onchange="window.salvarComissaoConta('${extId}', this.checked)">
                    <span>Conta comissão GLR</span>
                    <small id="com-txt-${extId}">${contaCom ? (GLR.comissao.temComissao(c) ? GLR.comissao.descricao(c) : 'sem comissão no cadastro') : 'vendas desta conta não geram comissão'}</small>
                  </label>

                  <div id="dados-${extId}" style="font-size:12px;color:var(--text-muted);">Clique em "Carregar dados"</div>
                </div>`;
              }).join('')}
            </div>
          </div>`;
        })()}

        ${c.historico?.length ? `<div class="card mb-16">
          <div class="section-header">
            <div class="section-title">Evolução de Faturamento</div>
          </div>
          <div class="chart-wrapper-lg">
            <canvas id="chart-cliente-evolucao"></canvas>
          </div>
        </div>` : ''}

        <div class="grid-2">
          <div class="card">
            <div class="section-title mb-16">Tarefas Ativas</div>
            ${tarefas.filter(t=>t.status!=='concluida').length
              ? tarefas.filter(t=>t.status!=='concluida').slice(0,4).map(t => `
                <div class="task-card">
                  <div style="display:flex;justify-content:space-between;gap:8px;">
                    <div class="task-title">${t.titulo}</div>
                    <span class="badge ${GLR.prioridadeColor[t.prioridade]}">${t.prioridade}</span>
                  </div>
                  <div class="task-meta"><span>${t.responsavel}</span><span>${formatDate(t.prazo)}</span></div>
                </div>
              `).join('')
              : '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">Nenhuma tarefa ativa</div>'}
            <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="openModalNovaTarefa(${c.id})">+ Nova tarefa</button>
          </div>
        </div>
      `;

      setTimeout(() => {
        const ctx = document.getElementById('chart-cliente-evolucao');
        if (ctx && c.historico?.length) {
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: c.historico.map(h => h.mes),
              datasets: [
                { label: 'Realizado', data: c.historico.map(h => h.faturamento), backgroundColor: 'rgba(99,102,241,0.7)', borderRadius: 4, order: 2 },
                { label: 'Meta', data: c.historico.map(h => h.meta), type: 'line', borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 2, borderDash: [4,4], pointRadius: 3, pointBackgroundColor: '#f59e0b', tension: 0.3, order: 1 }
              ]
            },
            options: { ...chartDefaults(), plugins: { legend: { display: true, labels: { color: '#9192a8', font: { size: 12 }, boxWidth: 12 } }, tooltip: tooltipStyle() } }
          });
        }
      }, 50);

    } else if (activeTab === 'timeline') {
      tabContent.innerHTML = `
        <div class="timeline">
          ${acoes.length ? acoes.sort((a,b) => new Date(b.data)-new Date(a.data)).map(a => {
            const cor = GLR.tipoAcaoColor[a.categoria] || 'var(--accent)';
            const icons = { Reunião:'🤝', Campanha:'📣', Otimização:'⚡', Precificação:'💲', Estratégia:'♟️', Análise:'🔍', Onboarding:'🚀', Relatório:'📄', Catálogo:'📂', NPS:'⭐', Interno:'🏠' };
            return `<div class="timeline-item">
              <div class="timeline-dot" style="background:color-mix(in srgb,${cor} 13%,transparent);color:${cor};">${icons[a.categoria] || '📌'}</div>
              <div class="timeline-content">
                <div class="timeline-header">
                  <span class="badge" style="background:color-mix(in srgb,${cor} 13%,transparent);color:${cor};">${a.categoria}</span>
                  <span class="badge ${a.status === 'concluida' ? 'status-crescimento' : 'status-ativo'}">${a.status === 'concluida' ? 'Concluída' : 'Em andamento'}</span>
                </div>
                <div style="font-size:13.5px;color:var(--text-primary);margin:8px 0;">${a.descricao}</div>
                <div class="timeline-meta"><span>${a.responsavel}</span><span>${formatDate(a.data)}</span></div>
              </div>
            </div>`;
          }).join('') : '<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-title">Nenhuma ação registrada</div></div>'}
        </div>
        <div style="margin-top:16px;">
          <button class="btn btn-secondary" onclick="openModalNovaAcao(${c.id})">+ Registrar Ação</button>
        </div>
      `;
    }

    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === activeTab));
  }

  // Monta o HTML estático do cabeçalho usando dados frescos
  const ci = getCliente(); // leitura fresca para o header
  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px;font-size:13px;color:var(--text-muted);">
      <span style="cursor:pointer;color:var(--accent-light);" onclick="Router.navigate('clientes')">Clientes</span>
      <span>›</span><span id="perfil-nome">${ci.nome}</span>
    </div>

    <div class="card mb-16" id="perfil-header">
      <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap;">
        <div style="width:60px;height:60px;border-radius:var(--radius);background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:white;flex-shrink:0;">${ci.nome.charAt(0)}</div>
        <div style="flex:1;min-width:200px;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
            <h2 style="font-size:20px;font-weight:700;">${ci.nome}</h2>
            <span class="badge ${GLR.statusColor[ci.status] || 'status-ativo'}" id="perfil-status-badge">${GLR.statusLabel[ci.status] || ci.status}</span>
            ${GLR.comissao.temComissao(ci) ? `<span style="font-size:12px;padding:3px 10px;border-radius:99px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.2);color:var(--green);font-weight:600;">${GLR.comissao.descricao(ci, true)}</span>` : ''}
          </div>
          <div style="font-size:13px;color:var(--text-muted);display:flex;gap:16px;flex-wrap:wrap;">
            ${ci.responsavel ? `<span>${ci.responsavel}</span>` : ''}
            ${ci.gestorId ? `<span>🧑‍💼 ${nomeGestor(ci.gestorId)}</span>` : ''}
            ${ci.categoria ? `<span>${ci.categoria}</span>` : ''}
            <span id="perfil-fat-header" style="color:var(--green);font-weight:600;">${ci.faturamento ? '💰 ' + GLR.formatCurrency(ci.faturamento) : ''}</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" onclick="openModalNovaAcao(${clienteId})">+ Ação</button>
          <button class="btn btn-secondary btn-sm" onclick="openModalNovoCliente(${clienteId})">Editar</button>
          <button class="btn btn-primary btn-sm" onclick="openModalNovaTarefa(${clienteId})">+ Tarefa</button>
        </div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab-btn active" data-tab="overview" onclick="switchTab('overview')">Visão Geral</button>
      <button class="tab-btn" data-tab="timeline" onclick="switchTab('timeline')">Timeline</button>
    </div>

    <div id="tab-content"></div>
  </div>`;

  window.switchTab = (tab) => { activeTab = tab; renderTab(); };

  // ── Salvar alíquota de imposto por conta ────────────────────
  window.salvarComissaoConta = (extId, conta) => {
    const m = GLR.comissaoContas();
    if (conta) delete m[extId]; else m[extId] = false;
    localStorage.setItem('glr_comissao_contas', JSON.stringify(m));
    const c = GLR.clientes.find(x => (JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}')[String(x.id)] || []).some(ct => String(ct.external_id || ct.id) === String(extId)));
    const t = document.getElementById(`com-txt-${extId}`);
    if (t) t.textContent = conta ? (c && GLR.comissao.temComissao(c) ? GLR.comissao.descricao(c) : 'sem comissão no cadastro') : 'vendas desta conta não geram comissão';
    const card = document.getElementById(`conta-card-${extId}`); if (card) card.classList.toggle('conta-sem-comissao', !conta);
  };

  window.salvarAliquota = (extId, valor) => {
    const aliquotas = JSON.parse(localStorage.getItem('glr_aliquotas') || '{}');
    aliquotas[extId] = parseFloat(valor) || 0;
    localStorage.setItem('glr_aliquotas', JSON.stringify(aliquotas));
    // Feedback visual
    const inp = document.getElementById(`aliq-${extId}`);
    if (inp) {
      inp.style.borderColor = 'var(--green)';
      setTimeout(() => { inp.style.borderColor = 'rgba(251,191,36,0.3)'; }, 1000);
    }
  };

  // ── Carregar dados das contas marketplace ───────────────────
  window.carregarDadosContas = async (cid) => {
    const apiKey = localStorage.getItem('glr_mc_apikey') || '';
    if (!apiKey) { alert('Configure a API Key nas Integrações primeiro.'); return; }

    const btn = document.getElementById('btn-carregar-contas');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Carregando...'; }

    const vinc  = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}');
    const contas = vinc[cid] || [];
    const hoje   = new Date();
    const ontem  = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
    const pad    = n => String(n).padStart(2,'0');
    const fmtD   = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const R$     = v => 'R$ ' + (parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

    // Mês atual: 01/mês até ontem
    const dataFrom = `${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}-01`;
    const dataTo   = fmtD(ontem);
    const diasDec  = ontem.getDate();
    const diasMes  = new Date(hoje.getFullYear(), hoje.getMonth()+1, 0).getDate();

    for (const ct of contas) {
      const extId = ct.external_id || ct.id || '';
      const mp    = ct.marketplace || ct.plataforma || '';
      const elId  = `dados-${extId}`;
      const elDiv = document.getElementById(elId);
      if (elDiv) elDiv.innerHTML = `<span style="color:var(--text-muted);">⏳ Buscando...</span>`;

      try {
        let fat = 0, pedidos = 0, ads = 0;

        if (['meli','ml','mercadolivre'].includes(mp)) {
          const orders = await MarketplaceAPI.mlOrders(extId, dataFrom, dataTo);
          pedidos = orders.length;
          fat = orders.reduce((s,o) => s + (parseFloat(o.total_amount)||0), 0);
          try {
            const adsr = await MarketplaceAPI.call('ml_ads_campaigns', { meliUserId: extId, date_from: dataFrom, date_to: dataTo });
            const camps = adsr.data || [];
            ads = camps.reduce((s,c) => s + (parseFloat(c.cost)||0), 0);
          } catch(e) {}
        }

        if (mp === 'shopee') {
          for (const st of ['COMPLETED','READY_TO_SHIP','SHIPPED']) {
            try {
              const rs = await MarketplaceAPI.call('shopee_sales_summary', { shopId: extId, days: diasDec, order_status: st });
              const d  = rs.data || rs;
              fat     += parseFloat(d.total_revenue || 0);
              pedidos += parseInt(d.total_orders || 0);
            } catch(e) {}
          }
        }

        const projecao = diasDec > 0 ? (fat / diasDec) * diasMes : 0;
        const adsPct   = fat > 0 && ads > 0 ? (ads/fat*100).toFixed(1) : null;

        if (elDiv) elDiv.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div>
              <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Faturamento (mês)</div>
              <div style="font-size:14px;font-weight:700;color:#60a5fa;">${R$(fat)}</div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Pedidos</div>
              <div style="font-size:14px;font-weight:700;color:#e5e7eb;">${pedidos}</div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Projeção mês</div>
              <div style="font-size:13px;font-weight:600;color:var(--purple);">${R$(projecao)}</div>
            </div>
            ${adsPct ? `<div>
              <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">ADS%</div>
              <div style="font-size:13px;font-weight:600;color:var(--yellow);">${adsPct}%</div>
            </div>` : ''}
          </div>
          <div style="margin-top:8px;font-size:10px;color:var(--text-secondary);">Base: 01/${pad(hoje.getMonth()+1)} até ${pad(ontem.getDate())}/${pad(ontem.getMonth()+1)}</div>`;

      } catch(e) {
        if (elDiv) elDiv.innerHTML = `<span style="color:var(--red);font-size:12px;">Erro: ${e.message}</span>`;
      }
    }

    if (btn) { btn.disabled = false; btn.textContent = 'Atualizar'; }
  };

  setupClienteHandlers();
  renderTab();
});

function scoreClass(s) {
  if (s >= 80) return 'text-green';
  if (s >= 60) return 'text-accent';
  if (s >= 40) return 'text-yellow';
  return 'text-red';
}
function scoreLabel(s) {
  if (s >= 80) return 'Excelente';
  if (s >= 60) return 'Bom';
  if (s >= 40) return 'Regular';
  if (s > 0) return 'Crítico';
  return 'Não calculado';
}

function indicadorCard(label, value, colorClass, sub) {
  return `<div style="background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;">
    <div style="font-size:11px;color:var(--text-muted);text-transform:none;letter-spacing:0;margin-bottom:6px;">${label}</div>
    <div style="font-size:20px;font-weight:700;margin-bottom:4px;" class="${colorClass}">${value}</div>
    <div style="font-size:11.5px;color:var(--text-muted);">${sub}</div>
  </div>`;
}

// acaoId opcional: quando informado, abre em modo edição (pré-preenchido,
// atualiza a ação existente em vez de criar uma nova, e mostra "Excluir").
function openModalNovaAcao(clienteId, acaoId) {
  const acaoExistente = acaoId != null ? GLR.acoes.find(a => a.id === acaoId) : null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const hojeIso = new Date().toISOString().split('T')[0];
  const clienteIdInicial = acaoExistente ? acaoExistente.clienteId : clienteId;
  overlay.innerHTML = `<div class="modal">
    <div class="modal-header">
      <div class="modal-title">${acaoExistente ? 'Editar Ação' : 'Registrar Ação'}</div>
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button>
    </div>
    <div class="grid-2" style="gap:12px;">
      <div class="form-group"><label class="form-label">Cliente</label>
        <select class="form-select" id="a-cliente">
          <option value="">Interno (sem cliente)</option>
          ${GLR.clientes.map(cl => `<option value="${cl.id}" ${cl.id === clienteIdInicial ? 'selected' : ''}>${cl.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Data</label>
        <input class="form-input" id="a-data" type="date" value="${acaoExistente?.data || hojeIso}">
      </div>
    </div>
    <div class="form-group"><label class="form-label">Categoria</label>
      <select class="form-select" id="a-cat">
        ${['Reunião','Campanha','Otimização','Precificação','Estratégia','Análise','Relatório','Onboarding'].map(cat =>
          `<option ${acaoExistente?.categoria === cat ? 'selected' : ''}>${cat}</option>`).join('')}
      </select>
    </div>
    <div class="form-group"><label class="form-label">Descrição</label>
      <textarea class="form-textarea" id="a-desc" placeholder="Descreva a ação executada...">${acaoExistente?.descricao || ''}</textarea>
    </div>
    <div class="grid-2" style="gap:12px;">
      <div class="form-group"><label class="form-label">Responsável</label>
        <select class="form-select" id="a-resp">
          ${GLR.gestores.map(g => `<option ${acaoExistente?.responsavel === g.nome ? 'selected' : ''}>${g.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Status</label>
        <select class="form-select" id="a-status">
          <option value="concluida" ${acaoExistente?.status === 'concluida' ? 'selected' : ''}>Concluída</option>
          <option value="em_andamento" ${acaoExistente?.status === 'em_andamento' ? 'selected' : ''}>Em andamento</option>
        </select>
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:${acaoExistente ? 'space-between' : 'flex-end'};">
      ${acaoExistente ? `<button class="btn btn-ghost" style="color:var(--red);" onclick="(function(){
        if(!confirm('Excluir esta ação?'))return;
        GLR.acoes = GLR.acoes.filter(a => a.id !== ${acaoExistente.id});
        localStorage.setItem('glr_acoes',JSON.stringify(GLR.acoes));
        document.querySelector('.modal-overlay').remove();
        Router.resolve();
      })()">Excluir</button>` : ''}
      <div style="display:flex;gap:10px;">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="(function(){
          const clienteSel = document.getElementById('a-cliente').value;
          const cliente = clienteSel ? GLR.clientes.find(cl => cl.id === parseInt(clienteSel)) : null;
          const data = document.getElementById('a-data').value;
          const dados = {
            clienteId: cliente ? cliente.id : null,
            data: data || new Date().toISOString().split('T')[0],
            categoria: document.getElementById('a-cat').value,
            descricao: document.getElementById('a-desc').value.trim(),
            responsavel: document.getElementById('a-resp').value,
            status: document.getElementById('a-status').value,
          };
          if(!dados.descricao){alert('Informe a descrição.');return;}
          ${acaoExistente
            ? `const idx = GLR.acoes.findIndex(a => a.id === ${acaoExistente.id});
               if (idx >= 0) GLR.acoes[idx] = { ...GLR.acoes[idx], ...dados };`
            : `GLR.acoes.push({ id: GLR.nextId(GLR.acoes), ...dados });`
          }
          localStorage.setItem('glr_acoes',JSON.stringify(GLR.acoes));
          this.closest('.modal-overlay').remove();
          Router.resolve();
        }).call(this)">${acaoExistente ? 'Salvar Alterações' : 'Salvar Ação'}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  setTimeout(() => document.getElementById('a-desc')?.focus(), 50);
}
