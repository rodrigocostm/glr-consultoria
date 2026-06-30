// ============================================================
// GLR — Portal do Cliente (Dashboard | Vendas | Curva ABC)
// ============================================================

const _PORTAL_CFG_KEY = 'glr_portal_configs';

// ── Utilitários ───────────────────────────────────────────────
const _pR$ = v => 'R$ ' + (parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const _pN  = (v,d=0) => (parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d});
const _pPad = n => String(n).padStart(2,'0');

function _portalCache() {
  try { return JSON.parse(localStorage.getItem('glr_fin_cache')||'null'); } catch(e) { return null; }
}

function _portalPedidos() {
  const cfg = window._portalConfig;
  if (!cfg) return [];
  const cache = _portalCache();
  if (!cache?.pedidos) return [];
  const ids = (cfg.contaIds||[]).map(String);
  return cache.pedidos.filter(p => ids.includes(String(p.contaId)));
}

const _isCancelPortal = s => {
  const v = (s||'').toLowerCase();
  return v.includes('cancel')||v.includes('refund')||v.includes('devol')||v==='invalid'||v.includes('return');
};

// ── Inicializar portal cliente ────────────────────────────────
window._initPortalCliente = function(cfg) {
  window._portalConfig = cfg;
  _configurarSidebarCliente(cfg);
  if (typeof Router !== 'undefined') Router.navigate('portal-dashboard');
};

function _configurarSidebarCliente(cfg) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // Esconde toda a navegação admin
  sidebar.querySelectorAll('.sidebar-section').forEach(s => s.style.display='none');

  // Injeta menu do portal
  const logo = sidebar.querySelector('.sidebar-logo');
  const nav = document.createElement('div');
  nav.id = 'portal-nav';
  nav.innerHTML = `
    <div class="sidebar-section" style="display:block!important;">
      <div class="sidebar-section-title">Meu Painel</div>
      <button class="nav-item" data-page="portal-dashboard" onclick="Router.navigate('portal-dashboard')">
        <svg class="nav-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        Dashboard de Vendas
      </button>
      <button class="nav-item" data-page="portal-vendas" onclick="Router.navigate('portal-vendas')">
        <svg class="nav-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
        Minhas Vendas
      </button>
      <button class="nav-item" data-page="portal-abc" onclick="Router.navigate('portal-abc')">
        <svg class="nav-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        Curva ABC
      </button>
    </div>
  `;
  if (logo) logo.after(nav); else sidebar.prepend(nav);

  // Atualiza info do usuário na sidebar
  const nome = sidebar.querySelector('.user-info strong');
  const cargo = sidebar.querySelector('.user-info span');
  if (nome)  nome.textContent  = cfg.clienteNome || 'Cliente';
  if (cargo) cargo.textContent = 'Portal do Cliente';
}

// ── Kpi card helper ───────────────────────────────────────────
function _pKpi(label, valor, sub, cor='#6366f1') {
  return `
    <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;">
      <div style="font-size:11px;font-weight:700;color:${cor};text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">${label}</div>
      <div style="font-size:24px;font-weight:700;color:var(--text-primary);">${valor}</div>
      ${sub ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${sub}</div>` : ''}
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// PÁGINA: Dashboard de Vendas
// ─────────────────────────────────────────────────────────────
Router.register('portal-dashboard', (params, el) => {
  const cfg   = window._portalConfig || {};
  const cache = _portalCache();
  const todos = _portalPedidos();
  const ativos = todos.filter(p => !_isCancelPortal(p.status));

  const fat      = ativos.reduce((s,p) => s+(parseFloat(p.valor)||0), 0);
  const qtd      = ativos.length;
  const ticket   = qtd > 0 ? fat/qtd : 0;
  const cancelados = todos.filter(p => _isCancelPortal(p.status)).length;
  const txCancel = todos.length > 0 ? (cancelados/todos.length*100) : 0;

  // Top 5 produtos
  const prodMap = {};
  for (const p of ativos) {
    const nome = p.produto || p.item_name || `Pedido ${p.id}`;
    if (!prodMap[nome]) prodMap[nome] = {fat:0, qtd:0};
    prodMap[nome].fat += parseFloat(p.valor)||0;
    prodMap[nome].qtd += 1;
  }
  const top5 = Object.entries(prodMap).sort((a,b)=>b[1].fat-a[1].fat).slice(0,5);

  // Gráfico diário
  const diaMap = {};
  for (const p of ativos) {
    const d = p.dataTs ? new Date(p.dataTs).toLocaleDateString('pt-BR') : '?';
    diaMap[d] = (diaMap[d]||0) + (parseFloat(p.valor)||0);
  }
  const dias = Object.entries(diaMap).sort(([a],[b]) => {
    const [da,ma,ya] = a.split('/'); const [db,mb,yb] = b.split('/');
    return new Date(`${ya}-${ma}-${da}`) - new Date(`${yb}-${mb}-${db}`);
  }).slice(-30);
  const maxDia = Math.max(...dias.map(([,v])=>v), 0.01);

  const bars = dias.map(([d,v]) => {
    const h = Math.max(Math.round((v/maxDia)*100), 2);
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;flex:1;min-width:0;height:100px;" title="${d}: ${_pR$(v)}">
      <div style="width:100%;background:#6366f1;border-radius:3px 3px 0 0;height:${h}px;opacity:.8;"></div>
    </div>`;
  }).join('');

  const mesLabel = cache?.mesKey ? (() => {
    const [y,m] = cache.mesKey.split('-');
    return new Date(y,parseInt(m)-1,1).toLocaleString('pt-BR',{month:'long',year:'numeric'});
  })() : 'Período atual';

  el.innerHTML = `
    <div style="padding:24px;max-width:1200px;margin:0 auto;">
      <div style="margin-bottom:24px;">
        <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">📊 Dashboard de Vendas</h2>
        <div style="font-size:13px;color:var(--text-secondary);">${cfg.clienteNome || 'Minha Conta'} · ${mesLabel}</div>
      </div>

      <!-- KPIs -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px;">
        ${_pKpi('💰 Faturamento', _pR$(fat), `${_pN(qtd)} pedidos`, '#16a34a')}
        ${_pKpi('🛒 Pedidos', _pN(qtd), `cancelados: ${_pN(cancelados)}`, '#6366f1')}
        ${_pKpi('🎯 Ticket Médio', _pR$(ticket), 'por pedido', '#0ea5e9')}
        ${_pKpi('❌ Cancelamentos', _pN(txCancel,1)+'%', `${_pN(cancelados)} pedidos`, txCancel>10?'#dc2626':'#d97706')}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;">
        <!-- Gráfico diário -->
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;">
          <h3 style="font-size:14px;font-weight:700;margin:0 0 16px;color:var(--text-primary);">📅 Faturamento Diário</h3>
          ${dias.length > 0 ? `
            <div style="display:flex;align-items:flex-end;gap:2px;height:100px;">${bars}</div>
            <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:var(--text-secondary);">
              <span>${dias[0]?.[0]||''}</span><span>Total: ${_pR$(fat)}</span><span>${dias[dias.length-1]?.[0]||''}</span>
            </div>` : `<div style="text-align:center;padding:40px;color:var(--text-secondary);font-size:13px;">Nenhum dado carregado ainda</div>`}
        </div>

        <!-- Top produtos -->
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;">
          <h3 style="font-size:14px;font-weight:700;margin:0 0 16px;color:var(--text-primary);">🏆 Top 5 Produtos</h3>
          ${top5.length > 0 ? top5.map(([nome,d],i) => {
            const pct = fat > 0 ? (d.fat/fat*100) : 0;
            const cores = ['#6366f1','#8b5cf6','#0ea5e9','#16a34a','#d97706'];
            return `
              <div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                  <span style="color:var(--text-primary);font-weight:600;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${i+1}. ${nome}</span>
                  <span style="color:var(--text-secondary);">${_pR$(d.fat)}</span>
                </div>
                <div style="background:var(--border);border-radius:99px;height:4px;">
                  <div style="background:${cores[i]};border-radius:99px;height:4px;width:${pct}%;"></div>
                </div>
              </div>`;
          }).join('') : `<div style="text-align:center;padding:40px;color:var(--text-secondary);font-size:13px;">Nenhum dado</div>`}
        </div>
      </div>

      ${ativos.length === 0 ? `
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:48px;text-align:center;color:var(--text-secondary);">
          <div style="font-size:40px;margin-bottom:12px;">📦</div>
          <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Nenhum dado disponível ainda</div>
          <div style="font-size:13px;">Aguarde a atualização dos dados pela consultoria.</div>
        </div>` : ''}
    </div>
  `;
});

// ─────────────────────────────────────────────────────────────
// PÁGINA: Minhas Vendas
// ─────────────────────────────────────────────────────────────
Router.register('portal-vendas', (params, el) => {
  const cfg   = window._portalConfig || {};
  const todos = _portalPedidos();

  const _fmtData = ts => ts ? new Date(ts).toLocaleDateString('pt-BR') : '—';
  const _statusBadge = s => {
    if (_isCancelPortal(s)) return `<span style="background:#fef2f2;color:#dc2626;border-radius:99px;padding:2px 10px;font-size:11px;font-weight:600;">Cancelado</span>`;
    return `<span style="background:#f0fdf4;color:#16a34a;border-radius:99px;padding:2px 10px;font-size:11px;font-weight:600;">Concluído</span>`;
  };

  const rows = todos.slice().sort((a,b) => (b.dataTs||0)-(a.dataTs||0)).map(p => `
    <tr style="border-bottom:1px solid var(--border);">
      <td style="padding:10px 12px;font-size:12px;color:var(--text-secondary);">${_fmtData(p.dataTs)}</td>
      <td style="padding:10px 12px;font-size:12px;color:var(--text-primary);">${p.plataforma||'—'}</td>
      <td style="padding:10px 12px;font-size:12px;color:var(--text-primary);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.produto||p.item_name||p.id||'—'}</td>
      <td style="padding:10px 12px;font-size:12px;text-align:right;font-weight:600;color:var(--text-primary);">${_pR$(p.valor)}</td>
      <td style="padding:10px 12px;text-align:center;">${_statusBadge(p.status)}</td>
    </tr>
  `).join('');

  const fat = todos.filter(p=>!_isCancelPortal(p.status)).reduce((s,p)=>s+(parseFloat(p.valor)||0),0);

  el.innerHTML = `
    <div style="padding:24px;max-width:1200px;margin:0 auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
        <div>
          <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">🛒 Minhas Vendas</h2>
          <div style="font-size:13px;color:var(--text-secondary);">${todos.length} pedidos · Faturamento: ${_pR$(fat)}</div>
        </div>
      </div>

      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
        ${todos.length > 0 ? `
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="background:var(--bg-base);border-bottom:2px solid var(--border);">
                  <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;">Data</th>
                  <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;">Plataforma</th>
                  <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;">Produto</th>
                  <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;">Valor</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;">Status</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : `
          <div style="text-align:center;padding:60px;color:var(--text-secondary);">
            <div style="font-size:40px;margin-bottom:12px;">📦</div>
            <div style="font-size:15px;font-weight:600;">Nenhuma venda encontrada</div>
          </div>`}
      </div>
    </div>
  `;
});

// ─────────────────────────────────────────────────────────────
// PÁGINA: Curva ABC
// ─────────────────────────────────────────────────────────────
Router.register('portal-abc', (params, el) => {
  const cfg   = window._portalConfig || {};
  const ativos = _portalPedidos().filter(p => !_isCancelPortal(p.status));

  // Agrupa por produto
  const prodMap = {};
  for (const p of ativos) {
    const nome = p.produto || p.item_name || `ID ${p.id}`;
    if (!prodMap[nome]) prodMap[nome] = { fat:0, qtd:0 };
    prodMap[nome].fat += parseFloat(p.valor)||0;
    prodMap[nome].qtd += 1;
  }

  const total = Object.values(prodMap).reduce((s,d)=>s+d.fat, 0);
  const sorted = Object.entries(prodMap).sort((a,b)=>b[1].fat-a[1].fat);

  // Classifica ABC
  let acum = 0;
  const classificados = sorted.map(([nome, d]) => {
    acum += d.fat;
    const pctAcum = total > 0 ? acum/total*100 : 0;
    const pctProd = total > 0 ? d.fat/total*100 : 0;
    const cls = pctAcum <= 80 ? 'A' : pctAcum <= 95 ? 'B' : 'C';
    return { nome, fat: d.fat, qtd: d.qtd, pctProd, pctAcum, cls };
  });

  const countA = classificados.filter(p=>p.cls==='A').length;
  const countB = classificados.filter(p=>p.cls==='B').length;
  const countC = classificados.filter(p=>p.cls==='C').length;
  const fatA   = classificados.filter(p=>p.cls==='A').reduce((s,p)=>s+p.fat,0);
  const fatB   = classificados.filter(p=>p.cls==='B').reduce((s,p)=>s+p.fat,0);
  const fatC   = classificados.filter(p=>p.cls==='C').reduce((s,p)=>s+p.fat,0);

  const clsCfg = {
    A: {cor:'#16a34a', bg:'#f0fdf4', desc:'80% do faturamento'},
    B: {cor:'#d97706', bg:'#fffbeb', desc:'15% do faturamento'},
    C: {cor:'#dc2626', bg:'#fef2f2', desc:'5% do faturamento'},
  };

  const rows = classificados.map((p, i) => {
    const c = clsCfg[p.cls];
    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px 12px;text-align:center;font-size:13px;color:var(--text-secondary);">${i+1}</td>
        <td style="padding:10px 12px;font-size:12px;color:var(--text-primary);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.nome}</td>
        <td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:var(--text-primary);">${_pR$(p.fat)}</td>
        <td style="padding:10px 12px;text-align:center;font-size:12px;color:var(--text-secondary);">${_pN(p.qtd)} un.</td>
        <td style="padding:10px 12px;text-align:center;font-size:12px;color:var(--text-secondary);">${_pN(p.pctProd,1)}%</td>
        <td style="padding:10px 12px;text-align:center;font-size:12px;color:var(--text-secondary);">${_pN(p.pctAcum,1)}%</td>
        <td style="padding:10px 12px;text-align:center;">
          <span style="background:${c.bg};color:${c.cor};border-radius:99px;padding:3px 14px;font-size:12px;font-weight:800;">${p.cls}</span>
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <div style="padding:24px;max-width:1200px;margin:0 auto;">
      <div style="margin-bottom:24px;">
        <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">📈 Curva ABC de Produtos</h2>
        <div style="font-size:13px;color:var(--text-secondary);">${sorted.length} produtos analisados · Faturamento total: ${_pR$(total)}</div>
      </div>

      <!-- Resumo ABC -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px;">
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;text-align:center;">
          <div style="font-size:32px;font-weight:800;color:#16a34a;">A</div>
          <div style="font-size:13px;font-weight:700;color:#16a34a;margin:4px 0;">${countA} produto(s)</div>
          <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${_pR$(fatA)}</div>
          <div style="font-size:11px;color:#16a34a;margin-top:4px;">Foco total — ${_pN(total>0?fatA/total*100:0,1)}% do faturamento</div>
        </div>
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:20px;text-align:center;">
          <div style="font-size:32px;font-weight:800;color:#d97706;">B</div>
          <div style="font-size:13px;font-weight:700;color:#d97706;margin:4px 0;">${countB} produto(s)</div>
          <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${_pR$(fatB)}</div>
          <div style="font-size:11px;color:#d97706;margin-top:4px;">Monitorar — ${_pN(total>0?fatB/total*100:0,1)}% do faturamento</div>
        </div>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:20px;text-align:center;">
          <div style="font-size:32px;font-weight:800;color:#dc2626;">C</div>
          <div style="font-size:13px;font-weight:700;color:#dc2626;margin:4px 0;">${countC} produto(s)</div>
          <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${_pR$(fatC)}</div>
          <div style="font-size:11px;color:#dc2626;margin-top:4px;">Revisar — ${_pN(total>0?fatC/total*100:0,1)}% do faturamento</div>
        </div>
      </div>

      <!-- Tabela -->
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
        ${sorted.length > 0 ? `
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="background:var(--bg-base);border-bottom:2px solid var(--border);">
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);">#</th>
                  <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:var(--text-secondary);">PRODUTO</th>
                  <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:700;color:var(--text-secondary);">FATURAMENTO</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);">QTD</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);">% PRODUTO</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);">% ACUMULADO</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);">CLASSE</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : `
          <div style="text-align:center;padding:60px;color:var(--text-secondary);">
            <div style="font-size:40px;margin-bottom:12px;">📈</div>
            <div style="font-size:15px;font-weight:600;">Nenhum dado disponível ainda</div>
          </div>`}
      </div>

      <div style="margin-top:12px;font-size:11px;color:var(--text-secondary);">
        A = produtos que representam 80% do faturamento · B = próximos 15% · C = últimos 5%
      </div>
    </div>
  `;
});
