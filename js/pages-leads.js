// ============================================================
// GLR Consultoria — CRM de Leads (landing page / campanhas)
// Lê direto da tabela glr_leads no Supabase (fora do padrão glr_storage/
// localStorage) — usa o cliente _sb já criado em supabase-init.js.
// ============================================================
(function() {

let leads = [];
let filtroStatus = 'todos';

const STATUS_LABEL = { novo: '🆕 Novo', contatado: '📞 Contatado', em_analise: '🔎 Em Análise', reuniao_agendada: '📅 Reunião Agendada', fechado: '✅ Fechado', desqualificado: '🚫 Desqualificado', perdido: '❌ Perdido' };
const STATUS_COR = { novo: '#60a5fa', contatado: '#fbbf24', em_analise: '#a78bfa', reuniao_agendada: '#38bdf8', fechado: '#34d399', desqualificado: '#94a3b8', perdido: '#f87171' };

function renderPage(params, container) {
  container.innerHTML = `<div id="leads-root" style="padding:24px;max-width:1200px;margin:0 auto;"></div>`;
  renderShell();
  carregarLeads();
}

function renderShell() {
  const root = document.getElementById('leads-root');
  if (!root) return;
  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:20px;">
      <div>
        <h2 style="font-size:20px;font-weight:700;color:var(--text-primary);margin:0;">📇 Leads</h2>
        <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 0;">Contatos capturados na landing page e nas páginas de campanha.</p>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="window._leadsRecarregar()">🔄 Atualizar</button>
    </div>

    <div id="leads-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;"></div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;" id="leads-filtros"></div>

    <div id="leads-tabela"></div>
  `;
}

async function carregarLeads() {
  const tabelaEl = document.getElementById('leads-tabela');
  if (tabelaEl) tabelaEl.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text-muted);">⏳ Carregando leads...</div>`;
  try {
    const { data, error } = await _sb.from('glr_leads').select('*').order('criado_em', { ascending: false });
    if (error) throw error;
    leads = data || [];
  } catch (e) {
    if (tabelaEl) tabelaEl.innerHTML = `<div style="padding:30px;text-align:center;color:#dc2626;">⚠️ Erro ao carregar leads: ${e.message}</div>`;
    console.warn('[Leads] Erro:', e.message);
    return;
  }
  renderKpis();
  renderFiltros();
  renderTabela();
}

window._leadsRecarregar = carregarLeads;

function renderKpis() {
  const el = document.getElementById('leads-kpis');
  if (!el) return;
  const total = leads.length;
  const porStatus = {};
  Object.keys(STATUS_LABEL).forEach(k => { porStatus[k] = 0; });
  leads.forEach(l => { const k = l.status || 'novo'; porStatus[k] = (porStatus[k] || 0) + 1; });
  const kpi = (label, val, cor) => `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value" style="color:${cor};font-size:18px;">${val}</div></div>`;
  el.innerHTML = `
    ${kpi('Total de leads', total, 'var(--text-primary)')}
    ${Object.keys(STATUS_LABEL).map(k => kpi(STATUS_LABEL[k], porStatus[k] || 0, STATUS_COR[k])).join('')}
  `;
}

function renderFiltros() {
  const el = document.getElementById('leads-filtros');
  if (!el) return;
  const opcoes = [['todos', 'Todos'], ...Object.entries(STATUS_LABEL)];
  el.innerHTML = opcoes.map(([val, label]) => `
    <button class="btn btn-sm ${filtroStatus === val ? 'btn-primary' : 'btn-secondary'}" onclick="window._leadsFiltrar('${val}')">${label}</button>
  `).join('');
}

window._leadsFiltrar = function(status) {
  filtroStatus = status;
  renderFiltros();
  renderTabela();
};

function fmtQuando(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function waLink(l) {
  const numero = (l.telefone || '').replace(/\D/g, '');
  const msg = `Olá ${l.nome}! Vi que você preencheu nosso formulário e gostaria de continuar a conversa.`;
  return `https://wa.me/55${numero.replace(/^55/, '')}?text=${encodeURIComponent(msg)}`;
}

function renderTabela() {
  const el = document.getElementById('leads-tabela');
  if (!el) return;
  const lista = filtroStatus === 'todos' ? leads : leads.filter(l => (l.status || 'novo') === filtroStatus);
  if (!lista.length) {
    el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-secondary);font-size:13px;background:var(--bg-card);border-radius:10px;">Nenhum lead ${filtroStatus === 'todos' ? 'recebido ainda' : 'nesse status'}.</div>`;
    return;
  }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;">
    <thead><tr style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;">
      <th style="text-align:left;padding:8px;">Quando</th>
      <th style="text-align:left;padding:8px;">Nome</th>
      <th style="text-align:left;padding:8px;">WhatsApp</th>
      <th style="text-align:left;padding:8px;">Marketplace</th>
      <th style="text-align:left;padding:8px;">Nicho</th>
      <th style="text-align:left;padding:8px;">Faturamento</th>
      <th style="text-align:left;padding:8px;">Dificuldade</th>
      <th style="text-align:left;padding:8px;">Origem</th>
      <th style="text-align:left;padding:8px;">Status</th>
      <th style="text-align:center;padding:8px;">Ação</th>
    </tr></thead>
    <tbody>${lista.map(l => `<tr style="border-top:1px solid var(--border);">
      <td style="padding:8px;font-size:12px;color:var(--text-muted);white-space:nowrap;">${fmtQuando(l.criado_em)}</td>
      <td style="padding:8px;font-size:13px;font-weight:600;">${l.nome || '—'}</td>
      <td style="padding:8px;font-size:12.5px;">${l.telefone || '—'}</td>
      <td style="padding:8px;font-size:12.5px;">${l.marketplace || '—'}</td>
      <td style="padding:8px;font-size:12.5px;">${l.nicho || '—'}</td>
      <td style="padding:8px;font-size:12px;color:var(--text-secondary);">${l.faturamento || '—'}</td>
      <td style="padding:8px;font-size:12px;color:var(--text-secondary);">${l.dificuldade || '—'}</td>
      <td style="padding:8px;font-size:11.5px;color:var(--text-muted);">${l.utm_source || '—'}${l.utm_campaign ? ' / ' + l.utm_campaign : ''}</td>
      <td style="padding:8px;">
        <select class="form-input" style="font-size:12px;padding:4px 8px;" onchange="window._leadsMudarStatus('${l.id}', this.value)">
          ${Object.entries(STATUS_LABEL).map(([val, label]) => `<option value="${val}" ${((l.status || 'novo') === val) ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </td>
      <td style="padding:8px;text-align:center;">
        <a href="${waLink(l)}" target="_blank" rel="noopener" class="btn btn-sm btn-secondary" style="white-space:nowrap;">💬 Chamar</a>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}

window._leadsMudarStatus = async function(id, novoStatus) {
  try {
    const { error } = await _sb.from('glr_leads').update({ status: novoStatus }).eq('id', id);
    if (error) throw error;
    const lead = leads.find(l => l.id === id);
    if (lead) lead.status = novoStatus;
    renderKpis();
  } catch (e) {
    alert('Não consegui salvar o status: ' + e.message);
  }
};

if (typeof Router !== 'undefined') {
  Router.register('leads', renderPage);
}

})();
