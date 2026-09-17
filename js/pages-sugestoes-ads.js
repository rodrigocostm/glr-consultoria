// ============================================================
// GLR Consultoria — Fila de Sugestões de ADS
// A IA (Central de ADS → "Gerar Sugestões") gera sugestões estruturadas e
// grava na tabela glr_ads_sugestoes. Aqui o analista revisa e decide:
// aprovar (executa a ação de verdade no marketplace) ou rejeitar. Nunca
// executa sozinho — sempre passa por aprovação humana explícita.
// ============================================================
(function() {

let sugestoes = [];
let filtroStatus = 'pendente';

const TIPO_LABEL = {
  pausar: '⏸️ Pausar campanha',
  retomar: '▶️ Retomar campanha',
  ajustar_orcamento: '💰 Ajustar orçamento',
  ajustar_roas_target: '🎯 Ajustar meta ROAS',
  outro: '💡 Outro',
};
const PRIORIDADE_COR = { alta: '#dc2626', media: '#d97706', baixa: '#64748b' };
const STATUS_LABEL = { pendente: '🕐 Pendente', aprovado: '✅ Aprovado', rejeitado: '❌ Rejeitado', executado: '🚀 Executado', erro: '⚠️ Erro' };

function renderPage(params, container) {
  container.innerHTML = `<div id="sug-root" style="padding:24px;max-width:1200px;margin:0 auto;"></div>`;
  renderShell();
  carregarSugestoes();
}

function renderShell() {
  const root = document.getElementById('sug-root');
  if (!root) return;
  root.innerHTML = `
    <div style="margin-bottom:20px;">
      <h2 style="font-size:20px;font-weight:700;color:var(--text-primary);margin:0;">🎯 Sugestões de ADS</h2>
      <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 0;">
        Otimizações que a IA identificou na Central de ADS. Nada é executado sozinho — você aprova ou rejeita cada uma.
        Ao aprovar uma ação de pausar/retomar/orçamento, a mudança é feita de verdade na conta.
      </p>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;" id="sug-filtros"></div>

    <div id="sug-lista"></div>
  `;
}

async function carregarSugestoes() {
  const el = document.getElementById('sug-lista');
  if (el) el.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text-muted);">⏳ Carregando...</div>`;
  try {
    const { data, error } = await _sb.from('glr_ads_sugestoes').select('*').order('criado_em', { ascending: false });
    if (error) throw error;
    sugestoes = data || [];
  } catch (e) {
    if (el) el.innerHTML = `<div style="padding:30px;text-align:center;color:#dc2626;">⚠️ Erro ao carregar: ${e.message}</div>`;
    return;
  }
  renderFiltros();
  renderLista();
}

function renderFiltros() {
  const el = document.getElementById('sug-filtros');
  if (!el) return;
  const cont = st => sugestoes.filter(s => st === 'todos' || s.status === st).length;
  const opcoes = [['pendente', `🕐 Pendentes (${cont('pendente')})`], ['aprovado', `✅ Aprovadas (${cont('aprovado')})`], ['executado', `🚀 Executadas (${cont('executado')})`], ['rejeitado', `❌ Rejeitadas (${cont('rejeitado')})`], ['todos', `Todas (${sugestoes.length})`]];
  el.innerHTML = opcoes.map(([val, label]) => `
    <button class="btn btn-sm ${filtroStatus === val ? 'btn-primary' : 'btn-secondary'}" onclick="window._sugFiltrar('${val}')">${label}</button>
  `).join('');
}

window._sugFiltrar = function(st) {
  filtroStatus = st;
  renderFiltros();
  renderLista();
};

function fmtQuando(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderLista() {
  const el = document.getElementById('sug-lista');
  if (!el) return;
  const lista = filtroStatus === 'todos' ? sugestoes : sugestoes.filter(s => s.status === filtroStatus);
  if (!lista.length) {
    el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-secondary);font-size:13px;background:var(--bg-card);border-radius:10px;">Nenhuma sugestão ${filtroStatus === 'todos' ? 'ainda' : 'nesse status'}. Gere na Central de ADS com "🎯 Gerar Sugestões".</div>`;
    return;
  }

  el.innerHTML = lista.map(s => {
    const podeExecutarAuto = ['pausar', 'retomar', 'ajustar_orcamento'].includes(s.tipo);
    const acoes = s.status === 'pendente' ? `
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="btn btn-sm btn-primary" onclick="window._sugAprovar('${s.id}')">✅ Aprovar${podeExecutarAuto ? ' e Executar' : ''}</button>
        <button class="btn btn-sm btn-secondary" onclick="window._sugRejeitar('${s.id}')">❌ Rejeitar</button>
      </div>
    ` : s.status === 'erro' ? `
      <div style="font-size:11.5px;color:#dc2626;margin-top:8px;">Erro: ${s.erro_execucao || 'desconhecido'}</div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn btn-sm btn-primary" onclick="window._sugAprovar('${s.id}')">🔁 Tentar de novo</button>
      </div>
    ` : '';

    return `<div class="card" style="padding:16px 18px;margin-bottom:10px;border-left:3px solid ${PRIORIDADE_COR[s.prioridade] || '#64748b'};">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${fmtQuando(s.criado_em)} · ${s.conta_nome || s.conta_id} · ${s.marketplace === 'shopee' ? '🟠 Shopee' : '🟡 ML'}</div>
          <div style="font-size:14px;font-weight:700;">${TIPO_LABEL[s.tipo] || s.tipo}${s.campanha_nome ? ' — ' + s.campanha_nome : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:${PRIORIDADE_COR[s.prioridade] || '#64748b'};">${s.prioridade || 'media'}</span>
          <span style="font-size:11px;background:var(--bg-card-hover);padding:3px 10px;border-radius:99px;">${STATUS_LABEL[s.status] || s.status}</span>
        </div>
      </div>
      ${s.valor_atual_label || s.valor_sugerido_label ? `
        <div style="font-size:13px;margin-top:8px;">
          <span style="color:var(--text-muted);">${s.valor_atual_label || '—'}</span>
          <span style="margin:0 6px;">→</span>
          <span style="font-weight:700;color:#6366f1;">${s.valor_sugerido_label || '—'}</span>
        </div>` : ''}
      ${s.motivo ? `<div style="font-size:12.5px;color:var(--text-secondary);margin-top:6px;line-height:1.5;">${s.motivo}</div>` : ''}
      ${acoes}
    </div>`;
  }).join('');
}

// ── Executa a ação de verdade no marketplace, usando os mesmos endpoints já
// usados pelos botões manuais da Central de ADS (pausar/orçamento). ──
async function executarSugestao(s) {
  const shopId = s.marketplace === 'shopee' ? s.conta_id : null; // conta_id guarda o external_id/shopId/meliUserId direto
  // campanha_id vem como text da glr_ads_sugestoes — a Shopee exige campaign_id
  // numérico (o botão manual de orçamento já existente sempre manda number, não
  // string; mandar string dava "Invalid param type" na Shopee).
  const campanhaIdShopee = Number(s.campanha_id);
  if (s.tipo === 'pausar') {
    if (s.marketplace === 'shopee') {
      await MarketplaceAPI.call('shopee_ads_pause_campaign', { shopId, campaign_id: campanhaIdShopee });
    } else {
      await MarketplaceAPI.call('ml_ads_update_campaign', { campaign_id: String(s.campanha_id), meliUserId: s.conta_id, status: 'paused' });
    }
  } else if (s.tipo === 'retomar') {
    if (s.marketplace === 'shopee') {
      await MarketplaceAPI.call('shopee_ads_resume_campaign', { shopId, campaign_id: campanhaIdShopee });
    } else {
      await MarketplaceAPI.call('ml_ads_update_campaign', { campaign_id: String(s.campanha_id), meliUserId: s.conta_id, status: 'active' });
    }
  } else if (s.tipo === 'ajustar_orcamento') {
    const novoValor = parseFloat(s.valor_sugerido_numero);
    if (!(novoValor > 0)) throw new Error('valor_sugerido_numero inválido pra orçamento');
    if (s.marketplace === 'shopee') {
      await MarketplaceAPI.call('shopee_ads_edit_campaign', { shopId, campaign_id: campanhaIdShopee, campaign_budget: novoValor });
    } else {
      await MarketplaceAPI.call('ml_ads_update_campaign', { campaign_id: String(s.campanha_id), meliUserId: s.conta_id, budget: novoValor });
    }
  }
  // ajustar_roas_target e outro: não executa automaticamente, só marca aprovado —
  // são ações que exigem contexto que não temos confirmado (ex: ML não expõe
  // edição de roas_target via API testada nesta sessão).
}

window._sugAprovar = async function(id) {
  const s = sugestoes.find(x => x.id === id);
  if (!s) return;
  const precisaExecutar = ['pausar', 'retomar', 'ajustar_orcamento'].includes(s.tipo);

  if (precisaExecutar && !confirm(`Confirma? Isso vai ${TIPO_LABEL[s.tipo].replace(/^\S+\s/, '').toLowerCase()} de verdade na conta ${s.conta_nome || s.conta_id}${s.campanha_nome ? ' (' + s.campanha_nome + ')' : ''}.`)) return;

  try {
    if (precisaExecutar) {
      await executarSugestao(s);
      await _sb.from('glr_ads_sugestoes').update({ status: 'executado', decidido_em: new Date().toISOString(), erro_execucao: null }).eq('id', id);
    } else {
      await _sb.from('glr_ads_sugestoes').update({ status: 'aprovado', decidido_em: new Date().toISOString() }).eq('id', id);
    }
    await carregarSugestoes();
  } catch (e) {
    await _sb.from('glr_ads_sugestoes').update({ status: 'erro', erro_execucao: e.message }).eq('id', id);
    await carregarSugestoes();
  }
};

window._sugRejeitar = async function(id) {
  try {
    await _sb.from('glr_ads_sugestoes').update({ status: 'rejeitado', decidido_em: new Date().toISOString() }).eq('id', id);
    await carregarSugestoes();
  } catch (e) {
    alert('Erro ao rejeitar: ' + e.message);
  }
};

if (typeof Router !== 'undefined') {
  Router.register('sugestoes-ads', renderPage);
}

})();
