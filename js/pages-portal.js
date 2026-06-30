// ============================================================
// GLR — Portal do Cliente (Dashboard | Vendas | Curva ABC)
// ============================================================

const _PORTAL_CFG_KEY = 'glr_portal_configs';

// ── Utilitários ───────────────────────────────────────────────
const _pR$ = v => 'R$ ' + (parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const _pN  = (v,d=0) => (parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d});
const _pPad = n => String(n).padStart(2,'0');
const _pCorMargem = m => m >= 15 ? '#16a34a' : m >= 5 ? '#d97706' : '#dc2626';

// glr_vendas_cache traz pedidos com nome de produto e itens — fonte certa para o portal
// (glr_fin_cache só tem totais por pedido, sem nome de produto)
function _portalCache() {
  try { return JSON.parse(localStorage.getItem('glr_vendas_cache')||'null'); } catch(e) { return null; }
}

function _portalFinCache() {
  try { return JSON.parse(localStorage.getItem('glr_fin_cache')||'null'); } catch(e) { return null; }
}

function _portalCustos() {
  try { return JSON.parse(localStorage.getItem('glr_vendas_custos')||'{}'); } catch(e) { return {}; }
}

// ── Filtro de data (compartilhado entre as páginas do portal) ─
function _portalFiltroDefault() {
  const hoje = new Date();
  const ate  = hoje.toISOString().slice(0,10);
  const d30  = new Date(hoje); d30.setDate(d30.getDate()-29);
  const de   = d30.toISOString().slice(0,10);
  return { de, ate };
}

function _portalFiltroData() {
  try {
    const f = JSON.parse(localStorage.getItem('glr_portal_filtro_data')||'null');
    if (f && f.de && f.ate) return f;
  } catch {}
  return _portalFiltroDefault();
}

window._portalAplicarFiltro = function(de, ate) {
  localStorage.setItem('glr_portal_filtro_data', JSON.stringify({ de, ate }));
  if (typeof Router !== 'undefined' && Router.resolve) Router.resolve();
};

window._portalFiltroRapido = function(dias) {
  const hoje = new Date();
  const ate = hoje.toISOString().slice(0,10);
  let de;
  if (dias === 'mes') {
    de = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0,10);
  } else if (dias === 'tudo') {
    de = '2020-01-01';
  } else {
    const d = new Date(hoje); d.setDate(d.getDate()-(dias-1));
    de = d.toISOString().slice(0,10);
  }
  window._portalAplicarFiltro(de, ate);
};

function _portalFiltroBar(pageAtual) {
  const f = _portalFiltroData();
  return `
    <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span style="font-size:12px;font-weight:700;color:var(--text-secondary);">📅 Período:</span>
      <input type="date" id="pf-de" value="${f.de}" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-primary);font-size:12px;">
      <span style="color:var(--text-secondary);font-size:12px;">até</span>
      <input type="date" id="pf-ate" value="${f.ate}" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-primary);font-size:12px;">
      <button onclick="window._portalAplicarFiltro(document.getElementById('pf-de').value, document.getElementById('pf-ate').value)"
        style="background:var(--primary);color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;">Aplicar</button>
      <div style="display:flex;gap:6px;margin-left:auto;flex-wrap:wrap;">
        <button onclick="window._portalFiltroRapido(7)" style="font-size:11px;background:var(--bg-base);border:1px solid var(--border);border-radius:99px;padding:5px 12px;cursor:pointer;color:var(--text-secondary);">7 dias</button>
        <button onclick="window._portalFiltroRapido(30)" style="font-size:11px;background:var(--bg-base);border:1px solid var(--border);border-radius:99px;padding:5px 12px;cursor:pointer;color:var(--text-secondary);">30 dias</button>
        <button onclick="window._portalFiltroRapido('mes')" style="font-size:11px;background:var(--bg-base);border:1px solid var(--border);border-radius:99px;padding:5px 12px;cursor:pointer;color:var(--text-secondary);">Mês atual</button>
        <button onclick="window._portalFiltroRapido('tudo')" style="font-size:11px;background:var(--bg-base);border:1px solid var(--border);border-radius:99px;padding:5px 12px;cursor:pointer;color:var(--text-secondary);">Tudo</button>
      </div>
    </div>`;
}

function _portalPedidos() {
  const cfg = window._portalConfig;
  if (!cfg) return [];
  const cache = _portalCache();
  if (!cache?.pedidos) return [];
  const ids = (cfg.contaIds||[]).map(String);
  const f = _portalFiltroData();
  const deTs  = f.de  ? new Date(`${f.de}T00:00:00`).getTime()  : -Infinity;
  const ateTs = f.ate ? new Date(`${f.ate}T23:59:59`).getTime() : Infinity;
  return cache.pedidos.filter(p =>
    ids.includes(String(p.contaId)) &&
    (!p.dataTs || (p.dataTs >= deTs && p.dataTs <= ateTs))
  );
}

const _isCancelPortal = s => {
  const v = (s||'').toLowerCase();
  return v.includes('cancel')||v.includes('refund')||v.includes('devol')||v==='invalid'||v.includes('return');
};

// Explode pedidos em itens individuais (nome do produto, qtd, valor proporcional)
// — essencial para a Curva ABC agrupar corretamente por produto, não por pedido
function _portalItens(pedidos) {
  const out = [];
  for (const p of pedidos) {
    const itens = p.itens && p.itens.length ? p.itens : null;
    if (itens) {
      const totalQtd = itens.reduce((s,i)=>s+(i.qtd||1), 0) || 1;
      for (const it of itens) {
        const fracao = (it.qtd||1) / totalQtd;
        out.push({
          nome:   it.nome || p.produto || `Pedido ${p.id}`,
          qtd:    it.qtd || 1,
          valor:  (it.preco != null ? it.preco * (it.qtd||1) : (parseFloat(p.valor)||0) * fracao),
          status: p.status, dataTs: p.dataTs, contaId: p.contaId, plataforma: p.plataforma,
        });
      }
    } else {
      out.push({
        nome: p.produto || `Pedido ${p.id}`, qtd: p.qtd || 1, valor: parseFloat(p.valor)||0,
        status: p.status, dataTs: p.dataTs, contaId: p.contaId, plataforma: p.plataforma,
      });
    }
  }
  return out;
}

// Soma investimento em ADS (varre glr_ads_cache_{contaId}_{ano}_{mes}) no período filtrado
function _portalAdsInvestimento(contaIds) {
  const f = _portalFiltroData();
  const deTs  = new Date(`${f.de}T00:00:00`).getTime();
  const ateTs = new Date(`${f.ate}T23:59:59`).getTime();
  const ids = new Set((contaIds||[]).map(String));
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('glr_ads_cache_')) continue;
    const partes = key.replace('glr_ads_cache_','').split('_');
    if (partes.length < 3) continue;
    const mes = parseInt(partes[partes.length-1]);
    const ano = parseInt(partes[partes.length-2]);
    const contaId = partes.slice(0, partes.length-2).join('_');
    if (!ids.has(contaId)) continue;
    const mesStart = new Date(ano, mes, 1).getTime();
    const mesEnd   = new Date(ano, mes+1, 0, 23,59,59).getTime();
    if (mesEnd < deTs || mesStart > ateTs) continue;
    try {
      const raw = JSON.parse(localStorage.getItem(key)||'null');
      const inv = raw?.dados?.resumo?.investimento;
      if (inv) total += parseFloat(inv)||0;
    } catch {}
  }
  return total;
}

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
  const finCache = _portalFinCache();
  const custos = _portalCustos();
  const todos = _portalPedidos();
  const ativos = todos.filter(p => !_isCancelPortal(p.status));
  const filtro = _portalFiltroData();

  const fat      = ativos.reduce((s,p) => s+(parseFloat(p.valor)||0), 0);
  const qtd      = ativos.length;
  const ticket   = qtd > 0 ? fat/qtd : 0;
  const unidades = ativos.reduce((s,p) => s+(parseFloat(p.qtd)||1), 0);
  const cancelados = todos.filter(p => _isCancelPortal(p.status)).length;
  const txCancel = todos.length > 0 ? (cancelados/todos.length*100) : 0;

  // Líquido do marketplace — casa pelo ID do pedido com glr_fin_cache (que tem taxas.liquido)
  const finPorId = {};
  (finCache?.pedidos||[]).forEach(p => { finPorId[String(p.id)] = p; });
  let liquido = 0, temLiquido = false;
  for (const p of ativos) {
    const fp = finPorId[String(p.id)];
    const liq = fp?.taxas?.liquido ?? p?.taxas?.liquido;
    if (liq != null) { liquido += parseFloat(liq)||0; temLiquido = true; }
  }
  if (!temLiquido) liquido = fat; // fallback se ainda não processado no financeiro

  // Custo de produto (preenchido na página Vendas) → lucro bruto
  let custoTotal = 0, temCusto = false;
  for (const p of ativos) {
    const c = custos[p.id];
    if (c?.custo) { custoTotal += (parseFloat(c.custo)||0) * (parseFloat(p.qtd)||1); temCusto = true; }
  }
  const lucroBruto = liquido - custoTotal;
  const margem = fat > 0 ? (lucroBruto/fat*100) : 0;

  // ADS — investimento no período + margem pós-ADS
  const adsInvestimento = _portalAdsInvestimento(cfg.contaIds);
  const roas = adsInvestimento > 0 ? fat/adsInvestimento : 0;
  const lucroPosAds = lucroBruto - adsInvestimento;
  const margemPosAds = fat > 0 ? (lucroPosAds/fat*100) : 0;

  // Top 5 produtos — agrupado por ITEM real (corrige pedidos com múltiplos produtos)
  const itensAtivos = _portalItens(ativos);
  const prodMap = {};
  for (const it of itensAtivos) {
    if (!prodMap[it.nome]) prodMap[it.nome] = {fat:0, qtd:0};
    prodMap[it.nome].fat += it.valor;
    prodMap[it.nome].qtd += it.qtd;
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

  el.innerHTML = `
    <div style="padding:24px;max-width:1200px;margin:0 auto;">
      <div style="margin-bottom:16px;">
        <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">📊 Dashboard de Vendas</h2>
        <div style="font-size:13px;color:var(--text-secondary);">${cfg.clienteNome || 'Minha Conta'}</div>
      </div>

      ${_portalFiltroBar()}

      <!-- KPIs principais -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:16px;">
        ${_pKpi('💰 Faturamento', _pR$(fat), `${_pN(qtd)} pedidos`, '#16a34a')}
        ${_pKpi('🏦 Líq. do Marketplace', _pR$(liquido), temLiquido?'após taxas':'estimado', '#0ea5e9')}
        ${_pKpi('📈 Lucro Bruto', _pR$(lucroBruto), temCusto?'líquido − custo produto':'sem custo cadastrado', lucroBruto>=0?'#16a34a':'#dc2626')}
        ${_pKpi('🎯 Margem', _pN(margem,1)+'%', 'lucro bruto / faturamento', _pCorMargem(margem))}
      </div>

      <!-- KPIs ADS -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:16px;">
        ${_pKpi('📢 Investimento em ADS', _pR$(adsInvestimento), 'no período selecionado', '#9333ea')}
        ${_pKpi('🎯 ROAS', adsInvestimento>0?_pN(roas,2)+'x':'—', 'receita / investido em ADS', roas>=3?'#16a34a':roas>0?'#d97706':'#6366f1')}
        ${_pKpi('📉 Lucro Pós-ADS', _pR$(lucroPosAds), 'lucro bruto − investimento ADS', lucroPosAds>=0?'#16a34a':'#dc2626')}
        ${_pKpi('🧮 Margem Pós-ADS', _pN(margemPosAds,1)+'%', 'considerando o gasto com anúncios', _pCorMargem(margemPosAds))}
      </div>

      <!-- KPIs secundários -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px;">
        ${_pKpi('🛒 Número de Vendas', _pN(qtd), `cancelados: ${_pN(cancelados)}`, '#6366f1')}
        ${_pKpi('📦 Unidades Vendidas', _pN(unidades), 'itens despachados', '#8b5cf6')}
        ${_pKpi('🎫 Ticket Médio', _pR$(ticket), 'por pedido', '#0ea5e9')}
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
            </div>` : `<div style="text-align:center;padding:40px;color:var(--text-secondary);font-size:13px;">Nenhum dado no período</div>`}
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
                  <span style="color:var(--text-primary);font-weight:600;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${nome}">${i+1}. ${nome}</span>
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
          <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Nenhum dado disponível no período</div>
          <div style="font-size:13px;">Tente ampliar o período ou aguarde a atualização dos dados pela consultoria.</div>
        </div>` : ''}

      ${!temCusto && ativos.length > 0 ? `
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;margin-top:16px;font-size:12px;color:#92400e;">
          ℹ️ Lucro Bruto e Margem ficam mais precisos quando o custo dos produtos é cadastrado na página Vendas.
        </div>` : ''}
    </div>
  `;
});

// ─────────────────────────────────────────────────────────────
// PÁGINA: Minhas Vendas — mesmo padrão detalhado da Central (somente leitura)
// ─────────────────────────────────────────────────────────────
const _PORTAL_PLAT_COR = { 'Shopee':'#f97316', 'Mercado Livre':'#fbbf24' };
let _portalVendasExpandido = null;

function _portalCalcLucro(p, custos) {
  const c = custos[p.id] || {};
  const custo    = parseFloat(c.custo) || 0;
  const receita  = parseFloat(p.valor) || 0;
  const liquido  = p.taxas?.liquido != null ? parseFloat(p.taxas.liquido) : null;
  const base     = liquido != null ? liquido : receita;
  const lucro    = base - custo;
  const margem   = receita > 0 ? (lucro/receita*100) : 0;
  return { receita, liquido, custo, lucro, margem };
}

Router.register('portal-vendas', (params, el) => {
  const cfg = window._portalConfig || {};
  const custos = _portalCustos();
  const todos = _portalPedidos();

  const fat = todos.filter(p=>!_isCancelPortal(p.status)).reduce((s,p)=>s+(parseFloat(p.valor)||0),0);

  el.innerHTML = `
    <div style="padding:24px;max-width:1300px;margin:0 auto;">
      <div style="margin-bottom:16px;">
        <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">🛒 Minhas Vendas</h2>
        <div style="font-size:13px;color:var(--text-secondary);">${todos.length} pedidos · Faturamento: ${_pR$(fat)}</div>
      </div>

      ${_portalFiltroBar()}

      <div id="portal-vendas-lista"></div>
    </div>
  `;

  _renderPortalVendasLista(todos, custos);
});

function _renderPortalVendasLista(todos, custos) {
  const cont = document.getElementById('portal-vendas-lista');
  if (!cont) return;

  if (!todos.length) {
    cont.innerHTML = `
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:60px;text-align:center;color:var(--text-secondary);">
        <div style="font-size:40px;margin-bottom:12px;">📦</div>
        <div style="font-size:15px;font-weight:600;">Nenhuma venda no período</div>
      </div>`;
    return;
  }

  // Agrupa por data (campo p.data já vem formatado de glr_vendas_cache)
  const grupos = {};
  for (const p of todos) { const k = p.data || '—'; if (!grupos[k]) grupos[k] = []; grupos[k].push(p); }

  // Ordena grupos por data desc
  const gruposOrdenados = Object.entries(grupos).sort(([,a],[,b]) => (b[0]?.dataTs||0)-(a[0]?.dataTs||0));

  cont.innerHTML = `<div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
    ${gruposOrdenados.map(([data, peds]) => {
      const fatGrupo = peds.filter(p=>!_isCancelPortal(p.status)).reduce((s,p)=>s+(parseFloat(p.valor)||0),0);
      const lucroGrupo = peds.filter(p=>!_isCancelPortal(p.status)).reduce((s,p)=>s+_portalCalcLucro(p,custos).lucro,0);
      const margemGrupo = fatGrupo > 0 ? (lucroGrupo/fatGrupo*100) : 0;
      return `
      <div>
        <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--bg-base);border-bottom:1px solid var(--border);">
          <span style="font-size:13px;font-weight:700;color:var(--text-primary);">📅 ${data}</span>
          <span style="font-size:11px;color:var(--text-secondary);">${peds.length} pedidos</span>
          <span style="margin-left:auto;font-size:12px;color:#0ea5e9;font-weight:600;">${_pR$(fatGrupo)}</span>
          <span style="font-size:12px;font-weight:700;color:${_pCorMargem(margemGrupo)};">Lucro ${_pR$(lucroGrupo)} · ${_pN(margemGrupo,1)}%</span>
        </div>
        <div style="display:grid;grid-template-columns:2fr 50px 105px 105px 90px 90px;padding:6px 16px;background:var(--bg-base);border-bottom:1px solid var(--border);">
          ${['ITEM','QTD','TOTAL','LÍQ. MP','LUCRO','MARGEM'].map((h,i)=>
            `<div style="font-size:10px;color:var(--text-secondary);font-weight:700;text-align:${i<=1?'left':'right'};white-space:nowrap;">${h}</div>`).join('')}
        </div>
        ${peds.map(p => _renderPortalVendaRow(p, custos)).join('')}
      </div>`;
    }).join('')}
  </div>`;

  cont.querySelectorAll('.portal-row-click').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      _portalVendasExpandido = _portalVendasExpandido === id ? null : id;
      _renderPortalVendasLista(todos, custos);
    });
  });
}

function _renderPortalVendaRow(p, custos) {
  const l = _portalCalcLucro(p, custos);
  const exp = _portalVendasExpandido === p.id;
  const cor = _PORTAL_PLAT_COR[p.plataforma] || '#9ca3af';
  const isCancelled = _isCancelPortal(p.status);
  const img = p.imagem
    ? `<img src="${p.imagem}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0;" onerror="this.style.display='none'">`
    : `<div style="width:40px;height:40px;background:var(--bg-base);border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px;">${p.plataforma==='Shopee'?'🟠':'🟡'}</div>`;

  return `
  <div style="border-bottom:1px solid var(--border);">
    <div class="portal-row-click" data-id="${p.id}" style="display:grid;grid-template-columns:2fr 50px 105px 105px 90px 90px;padding:10px 16px;align-items:center;cursor:pointer;">
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        ${img}
        <div style="min-width:0;">
          <div style="font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px;" title="${(p.produto||'').replace(/"/g,'&quot;')}">${p.produto||'—'}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px;display:flex;gap:6px;align-items:center;">
            <span style="color:${cor};font-weight:600;">${p.plataforma}</span>
            <span>${p.id}</span>
            ${isCancelled ? '<span style="background:#fef2f2;color:#dc2626;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;">● Cancelado</span>' : ''}
          </div>
        </div>
      </div>
      <div style="text-align:left;font-size:13px;color:var(--text-secondary);">${p.qtd||1}</div>
      <div style="text-align:right;font-size:13px;font-weight:700;color:#0ea5e9;">${_pR$(l.receita)}</div>
      <div style="text-align:right;font-size:13px;font-weight:700;color:#8b5cf6;">${l.liquido!=null?_pR$(l.liquido):'—'}</div>
      <div style="text-align:right;font-size:13px;font-weight:700;color:${_pCorMargem(l.margem)};">${_pR$(l.lucro)}</div>
      <div style="text-align:right;">
        <span style="background:${_pCorMargem(l.margem)}22;color:${_pCorMargem(l.margem)};padding:3px 8px;border-radius:20px;font-size:11px;font-weight:700;">${_pN(l.margem,1)}%</span>
      </div>
    </div>
    ${exp ? _renderPortalVendaDetalhe(p, l) : ''}
  </div>`;
}

function _renderPortalVendaDetalhe(p, l) {
  const tx = p.taxas || {};
  const hasEscrow = p.taxas != null;
  const linhas = [
    { label:'💰 Total do Pedido', v: l.receita, cor:'#0ea5e9', sinal:'+' },
    tx.comissao>0    ? { label:'🏦 Comissão',       v:-tx.comissao,    cor:'#dc2626', sinal:'-' } : null,
    tx.taxaServico>0 ? { label:'⚙️ Taxa de Serviço', v:-tx.taxaServico, cor:'#dc2626', sinal:'-' } : null,
    tx.frete>0       ? { label:'🚚 Frete',           v:-Math.abs(tx.frete), cor:'#f97316', sinal:'-' } : null,
    tx.voucher>0     ? { label:'🎟️ Voucher',         v: tx.voucher,     cor:'#16a34a', sinal:'+' } : null,
    l.liquido!=null  ? { label:'💳 Líquido (após taxas)', v:l.liquido, cor:'#8b5cf6', sinal:'=', bold:true } : null,
    { label:'📦 Custo do Produto', v:-l.custo, cor:'#dc2626', sinal:'-' },
    { label:'✅ Lucro Bruto', v:l.lucro, cor:_pCorMargem(l.margem), sinal: l.lucro>=0?'+':'-', bold:true },
  ].filter(Boolean);

  return `
  <div style="display:flex;background:var(--bg-base);border-top:1px solid var(--border);flex-wrap:wrap;">
    <div style="flex:1;min-width:260px;padding:16px 20px;border-right:1px solid var(--border);">
      <div style="font-size:10px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;margin-bottom:10px;">Detalhes do Pedido</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
        <div><div style="font-size:10px;color:var(--text-secondary);">ID</div><div style="font-size:12px;color:var(--text-primary);">${p.id}</div></div>
        <div><div style="font-size:10px;color:var(--text-secondary);">Plataforma</div><div style="font-size:12px;color:var(--text-primary);font-weight:600;">${p.plataforma}</div></div>
        <div><div style="font-size:10px;color:var(--text-secondary);">Data</div><div style="font-size:12px;color:var(--text-primary);">${p.data}</div></div>
        <div><div style="font-size:10px;color:var(--text-secondary);">Status</div><div style="font-size:12px;color:var(--text-primary);">${p.status||'—'}</div></div>
      </div>
      ${p.itens && p.itens.length ? `
      <div style="font-size:10px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;margin-bottom:8px;">Itens</div>
      ${p.itens.map(it=>`
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
          ${it.imagem?`<img src="${it.imagem}" style="width:32px;height:32px;object-fit:cover;border-radius:5px;flex-shrink:0;">` : ''}
          <div style="flex:1;font-size:12px;color:var(--text-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${it.nome}</div>
          <div style="font-size:11px;color:var(--text-secondary);flex-shrink:0;">x${it.qtd}</div>
          <div style="font-size:12px;color:#0ea5e9;font-weight:600;flex-shrink:0;">${_pR$(it.preco)}</div>
        </div>`).join('')}` : ''}
    </div>
    <div style="width:280px;flex-shrink:0;padding:16px 20px;">
      <div style="font-size:10px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;margin-bottom:10px;">
        Composição do Lucro ${hasEscrow ? '<span style="color:#8b5cf6;font-size:9px;background:#8b5cf622;padding:1px 6px;border-radius:8px;margin-left:4px;">dados da API</span>' : ''}
      </div>
      ${linhas.map(r=>`
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:12px;${r.bold?'font-weight:700;color:var(--text-primary);':'color:var(--text-secondary);'}">${r.label}</span>
          <span style="font-size:13px;font-weight:${r.bold?'800':'600'};color:${r.cor};">${r.sinal==='='?'= ':r.sinal==='+'?'+':'-'}${_pR$(Math.abs(r.v))}</span>
        </div>`).join('')}
      <div style="margin-top:10px;padding-top:10px;border-top:2px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;color:var(--text-secondary);">Margem s/ receita</span>
        <span style="font-size:18px;font-weight:800;color:${_pCorMargem(l.margem)};">${_pN(l.margem,1)}%</span>
      </div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// PÁGINA: Curva ABC
// ─────────────────────────────────────────────────────────────
Router.register('portal-abc', (params, el) => {
  const cfg   = window._portalConfig || {};
  const ativos = _portalPedidos().filter(p => !_isCancelPortal(p.status));

  // Agrupa por PRODUTO real (item a item) — corrige pedidos com múltiplos produtos
  const itens = _portalItens(ativos);
  const prodMap = {};
  for (const it of itens) {
    const nome = it.nome;
    if (!prodMap[nome]) prodMap[nome] = { fat:0, qtd:0 };
    prodMap[nome].fat += it.valor;
    prodMap[nome].qtd += it.qtd;
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
      <div style="margin-bottom:16px;">
        <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">📈 Curva ABC de Produtos</h2>
        <div style="font-size:13px;color:var(--text-secondary);">${sorted.length} produtos analisados · Faturamento total: ${_pR$(total)}</div>
      </div>

      ${_portalFiltroBar()}

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
            <div style="font-size:15px;font-weight:600;">Nenhum dado no período</div>
          </div>`}
      </div>

      <div style="margin-top:12px;font-size:11px;color:var(--text-secondary);">
        A = produtos que representam 80% do faturamento · B = próximos 15% · C = últimos 5%
      </div>
    </div>
  `;
});
