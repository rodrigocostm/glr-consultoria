// ============================================================
// GLR Consultoria — Histórico de Alterações
// Página própria, separada das outras — não mexe em Central de ADS,
// Vendas nem em nenhuma outra aba. Detecta mudança comparando o
// estado atual (buscado ao vivo) com o último retrato salvo; só
// enxerga diferença entre uma visita/atualização e outra, não é
// tempo real (a API dos marketplaces não expõe log de alterações).
// ============================================================
(function() {

let contasAds = [];   // contas ML + Shopee, pra rastreio de campanhas
let contasTodas = []; // todas as contas, pra rastreio de preço

const K_ADS_SNAP   = 'glr_track_ads_snap';
const K_ADS_LOG     = 'glr_track_ads_log';
const K_PRECO_SNAP  = 'glr_track_precos_snap';
const K_PRECO_LOG   = 'glr_track_precos_log';
const K_PREVENDA_SNAP = 'glr_track_prevenda_snap';
const K_PREVENDA_LOG  = 'glr_track_prevenda_log';

function lerJSON(key, def) { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? def; } catch(e) { return def; } }
function salvarJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
function novoId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fmtR(v) { return (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function fmtQuando(iso) { return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }

function renderPage(params, container) {
  container.innerHTML = `<div id="track-root" style="padding:24px;max-width:1200px;margin:0 auto;"></div>`;
  renderShell();
  carregarContas();
}

function renderShell() {
  const root = document.getElementById('track-root');
  if (!root) return;
  root.innerHTML = `
    <div style="margin-bottom:24px;">
      <h2 style="font-size:20px;font-weight:700;color:var(--text-primary);margin:0;">Histórico de Alterações</h2>
      <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 0;">
        Compara o estado atual com o último retrato salvo pra detectar mudanças de orçamento/status de ADS e de preço.
        Só enxerga diferença entre uma atualização e outra — os marketplaces não têm log de alterações pra consultar.
      </p>
    </div>

    <!-- ADS -->
    <div class="card" style="padding:20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:6px;">
        <div class="section-title" style="font-size:15px;">Campanhas de ADS</div>
        <button class="btn btn-secondary btn-sm" id="track-btn-ads" title="Compara orçamento, status e meta ROAS de agora com a última verificação — pega mudança feita direto no painel do marketplace" onclick="window._trackEscanearAds()">Procurar mudanças feitas fora do sistema</button>
      </div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:0 0 12px;">Tudo que o agente mudou (e quando o analista aprovou ou executou pelo sistema) entra aqui sozinho, com a hora certa e o motivo. No Mercado Livre entra o que o agente conferiu que foi aplicado no painel. O botão ao lado procura o que foi mexido direto no Seller Center / Publicidade.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <select id="track-ads-f-conta" class="form-input" style="min-width:220px;" onchange="window._trackAdsFiltro()"><option value="">Todas as contas</option></select>
        <select id="track-ads-f-campo" class="form-input" onchange="window._trackAdsFiltro()"><option value="">Tudo</option><option>Meta ROAS</option><option>Orçamento diário</option><option>Status</option><option>Produto na campanha</option></select>
        <select id="track-ads-f-quem" class="form-input" onchange="window._trackAdsFiltro()"><option value="">Qualquer autor</option><option value="agente">Agente</option><option value="analista">Analista</option><option value="fora">Fora do sistema</option></select>
        <select id="track-ads-f-dias" class="form-input" onchange="window._trackAdsFiltro()"><option value="7">Últimos 7 dias</option><option value="30" selected>Últimos 30 dias</option><option value="60">Últimos 60 dias</option></select>
        <input id="track-ads-f-busca" class="form-input" placeholder="Buscar campanha…" style="min-width:180px;flex:1;" oninput="window._trackAdsFiltro()">
      </div>
      <div id="track-ads-status" style="font-size:12px;color:var(--text-muted);margin-bottom:10px;"></div>
      <div id="track-ads-log"></div>
    </div>

    <!-- Preços -->
    <div class="card" style="padding:20px;margin-bottom:20px;">
      <div class="section-title" style="font-size:15px;margin-bottom:4px;">Preços monitorados</div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:0 0 14px;">
        Selecione a conta — busca automaticamente o preço de todos os anúncios ativos dela (até 100 do ML, 50 da Shopee) e compara
        com a última verificação. Sem precisar digitar ID de anúncio nenhum. Atualização manual (sem robô automático nem notificação por enquanto).
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
        <select id="track-preco-conta" class="form-input" style="min-width:220px;"><option value="">Carregando contas...</option></select>
        <button class="btn btn-primary btn-sm" id="track-btn-precos" onclick="window._trackEscanearPrecos()" disabled>Verificar mudanças agora</button>
      </div>
      <div id="track-preco-status" style="font-size:12px;color:var(--text-muted);margin-bottom:10px;"></div>
      <div id="track-preco-log"></div>
    </div>

    <!-- Pré-venda -->
    <div class="card" style="padding:20px;">
      <div class="section-title" style="font-size:15px;margin-bottom:4px;">Entrada/saída de pré-venda</div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:0 0 14px;">
        <b>Shopee:</b> confirmado — a API expõe <code>pre_order.is_pre_order</code> por anúncio/variação. O botão abaixo escaneia
        automaticamente todos os anúncios ativos de <b>todas as contas Shopee conectadas</b>.<br/>
        <b>Mercado Livre:</b> confirmado — o campo "Prazo de disponibilidade do produto" da tela do vendedor é o
        <code>product_release_date</code> de <code>ml_user_product_stock</code>. O escaneio abaixo verifica esse campo (quando o
        anúncio tem esse recurso), mais o <b>título</b> (palavras como "pré-venda"/"chega em breve") e <b>estoque zerado com
        anúncio ativo</b> — sem precisar informar ID nenhum. Use o botão de estoque completo se quiser conferir manualmente.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <button class="btn btn-primary btn-sm" id="track-btn-prevenda-shopee" onclick="window._trackEscanearPrevendaShopee()">Verificar pré-venda Shopee (todas as contas)</button>
        <button class="btn btn-primary btn-sm" id="track-btn-prevenda-ml" onclick="window._trackEscanearPrevendaML()">Verificar pré-venda ML (todas as contas)</button>
        <button class="btn btn-secondary btn-sm" id="track-btn-estoque-ml" onclick="window._trackListarEstoqueML()">Ver estoque de todos os anúncios ML</button>
      </div>
      <div id="track-prevenda-status-shopee" style="font-size:12px;color:var(--text-muted);margin-bottom:4px;"></div>
      <div id="track-prevenda-status-ml" style="font-size:12px;color:var(--text-muted);margin-bottom:10px;"></div>
      <div id="track-prevenda-atual"></div>
      <div id="track-prevenda-log"></div>
      <div id="track-estoque-ml" style="margin-top:14px;"></div>

      <div style="border-top:1px solid var(--border);margin:16px 0;padding-top:14px;">
        <p style="font-size:11.5px;color:var(--text-muted);margin:0 0 8px;">Ou, se você tiver um anúncio específico e quiser ver os campos brutos dele (pra a gente confirmar um sinal de API melhor no futuro):</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <input type="text" id="track-ml-item-id" class="form-input" placeholder="MLB... ou link do anúncio" style="min-width:260px;flex:1;">
          <button class="btn btn-secondary btn-sm" onclick="window._trackInspecionarML()">Inspecionar anúncio ML</button>
        </div>
        <div id="track-ml-resultado" style="font-size:12.5px;margin-top:10px;"></div>
      </div>
    </div>
  `;
  renderPrecoLog();
  renderPrevendaAtual();
  renderPrevendaLog();
}

async function carregarContas() {
  try {
    let contas = [];
    try {
      contas = await MarketplaceAPI.listAccounts();
      localStorage.setItem('glr_mc_accounts', JSON.stringify(contas));
    } catch(e) {
      const raw = localStorage.getItem('glr_mc_accounts');
      contas = raw ? JSON.parse(raw) : [];
    }
    contasTodas = contas;
    contasAds = contas.filter(c => ['shopee','mercadolivre','ml','meli'].includes(c.marketplace));

    const nicks = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();
    const nomeConta = c => {
      const tag = c.tags?.[0]?.name || '';
      return nicks[c.external_id] || tag || c.nickname || c.name || c.external_id;
    };
    window._trackNomeConta = nomeConta;

    const selPreco = document.getElementById('track-preco-conta');
    if (selPreco) {
      selPreco.innerHTML = `<option value="">— Conta —</option>` + contasAds.map((c, i) => {
        const mp = c.marketplace === 'shopee' ? '🟠' : '🟡';
        return `<option value="${i}">${mp} ${nomeConta(c)}</option>`;
      }).join('');
      selPreco.addEventListener('change', () => {
        const btn = document.getElementById('track-btn-precos');
        if (btn) btn.disabled = selPreco.value === '';
        if (selPreco.value !== '') window._trackEscanearPrecos();
      });
    }

    const selC = document.getElementById('track-ads-f-conta');
    if (selC) selC.innerHTML = `<option value="">Todas as contas</option>` + contasAds.map(c => `<option value="${c.external_id}">${c.marketplace === 'shopee' ? 'Shopee' : 'ML'} · ${nomeAdsConta(c.external_id)}</option>`).sort((a, b) => a.replace(/<[^>]+>/g, '').localeCompare(b.replace(/<[^>]+>/g, ''))).join('');
    renderAdsLog();
    carregarAlteracoesServidor();
  } catch(e) {
    console.warn('[Track] Erro ao carregar contas:', e.message);
  }
}

// ── ADS: escaneia campanhas de todas as contas, compara com o snapshot salvo ──
window._trackEscanearAds = async function() {
  const btn = document.getElementById('track-btn-ads');
  const statusEl = document.getElementById('track-ads-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Verificando...'; }

  const snap = lerJSON(K_ADS_SNAP, {});
  const log  = lerJSON(K_ADS_LOG, {});
  const logArr = Array.isArray(log) ? log : [];
  let contasVerificadas = 0;
  const totalAntes = logArr.length;

  for (const conta of contasAds) {
    const contaId = conta.external_id;
    const contaNome = window._trackNomeConta ? window._trackNomeConta(conta) : contaId;
    const snapConta = snap[contaId] || {};
    const novoSnapConta = {};

    try {
      if (conta.marketplace === 'shopee') {
        const shopId = conta.param_to_use?.shopId || conta.external_id;
        const listResp = await MarketplaceAPI.call('shopee_ads_campaigns', { shopId, state_filter: 'ongoing' });
        const campList = listResp?.data?.response?.campaign_list || listResp?.data?.campaign_list || [];
        if (!campList.length) { contasVerificadas++; continue; }
        const ids = campList.map(c => c.campaign_id || c.id).join(',');
        const cfgResp = await MarketplaceAPI.call('shopee_ads_campaign_settings', { shopId, campaign_id_list: ids });
        const cfgList = cfgResp?.data?.response?.campaign_list || [];
        cfgList.forEach(c => {
          const cid = String(c.campaign_id);
          const atual = {
            nome: c.common_info?.ad_name || `#${cid}`,
            budget: parseFloat(c.common_info?.campaign_budget) || 0,
            status: c.common_info?.campaign_status || '',
            roasTarget: c.auto_bidding_info?.roas_target ?? null,
          };
          novoSnapConta[cid] = atual;
          const antes = snapConta[cid];
          if (antes) {
            if (antes.budget !== atual.budget) logArr.unshift({ id: novoId(), contaId, contaNome, campanhaId: cid, campanhaNome: atual.nome, campo: 'Orçamento diário', de: fmtR(antes.budget), para: fmtR(atual.budget), quando: new Date().toISOString() });
            if (antes.status !== atual.status) logArr.unshift({ id: novoId(), contaId, contaNome, campanhaId: cid, campanhaNome: atual.nome, campo: 'Status', de: antes.status, para: atual.status, quando: new Date().toISOString() });
            if (antes.roasTarget !== atual.roasTarget) logArr.unshift({ id: novoId(), contaId, contaNome, campanhaId: cid, campanhaNome: atual.nome, campo: 'Meta ROAS', de: antes.roasTarget != null ? antes.roasTarget+'x' : '—', para: atual.roasTarget != null ? atual.roasTarget+'x' : '—', quando: new Date().toISOString() });
          }
        });
      } else {
        const meliId = conta.param_to_use?.meliUserId || conta.external_id;
        const r = await MarketplaceAPI.call('ml_ads_campaigns', { meliUserId: meliId, limit: 50 });
        const camps = r?.data?.results || r?.results || [];
        camps.forEach(c => {
          const cid = String(c.id);
          const atual = {
            nome: c.name || `#${cid}`,
            budget: parseFloat(c.daily_budget ?? c.budget) || 0,
            status: c.status || '',
            roasTarget: c.roas_target ?? null,
          };
          novoSnapConta[cid] = atual;
          const antes = snapConta[cid];
          if (antes) {
            if (antes.budget !== atual.budget) logArr.unshift({ id: novoId(), contaId, contaNome, campanhaId: cid, campanhaNome: atual.nome, campo: 'Orçamento diário', de: fmtR(antes.budget), para: fmtR(atual.budget), quando: new Date().toISOString() });
            if (antes.status !== atual.status) logArr.unshift({ id: novoId(), contaId, contaNome, campanhaId: cid, campanhaNome: atual.nome, campo: 'Status', de: antes.status, para: atual.status, quando: new Date().toISOString() });
            if (antes.roasTarget !== atual.roasTarget) logArr.unshift({ id: novoId(), contaId, contaNome, campanhaId: cid, campanhaNome: atual.nome, campo: 'Meta ROAS', de: antes.roasTarget != null ? antes.roasTarget+'x' : '—', para: atual.roasTarget != null ? atual.roasTarget+'x' : '—', quando: new Date().toISOString() });
          }
        });
      }
      snap[contaId] = novoSnapConta;
      contasVerificadas++;
    } catch(e) {
      console.warn('[Track] Erro na conta', contaId, e.message);
    }
  }

  salvarJSON(K_ADS_SNAP, snap);
  const logFinal = logArr.slice(0, 3000); // guarda só as 3000 mudanças mais recentes
  salvarJSON(K_ADS_LOG, logFinal);

  if (btn) { btn.disabled = false; btn.textContent = 'Procurar mudanças feitas fora do sistema'; }
  const novasMudancas = logArr.length - totalAntes;
  renderAdsLog();
  if (statusEl) statusEl.textContent = `Verificado em ${new Date().toLocaleString('pt-BR')} — ${contasVerificadas} conta(s), ${novasMudancas} mudança(s) nova(s) achada(s) fora do registro do agente.`;
};

// ── ADS: alterações registradas no servidor (glr_agente_log) ──
// O agente grava cada mudança que faz (e o analista, quando aprova ou executa
// pelo sistema) — com hora exata, de → para e o motivo. No ML a integração não
// altera, mas o agente confere e marca o que foi aplicado no painel.
let adsServidor = [];
const mktDaConta = id => { const c = contasAds.find(x => String(x.external_id) === String(id)); return c ? (c.marketplace === 'shopee' ? 'shopee' : 'ml') : null; };
function nomeAdsConta(id) {
  const mkt = mktDaConta(id);
  const n = window.GLR?.nomeConta ? GLR.nomeConta(mkt || 'ml', id) : '';
  if (n && !/sem cliente/.test(n)) return n;
  const c = contasAds.find(x => String(x.external_id) === String(id));
  return c && window._trackNomeConta ? window._trackNomeConta(c) : String(id);
}
const xRoas = v => v == null || v === '' ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')}x`;
function alteracoesDoLog(l) {
  const d = l.dados || {}, out = [];
  const camp = String(d.campaign_id ?? d.campanha_id ?? '');
  const nomeTit = String(l.titulo || '').split(' — ').slice(1).join(' — ');
  const base = { id: 'srv-' + (l.id || Math.random()), quando: d.aplicado_em || l.criado_em, contaId: String(l.conta_id), campanhaId: camp, campanhaNome: d.campanha || nomeTit || (camp ? `#${camp}` : '—'), porque: l.explicacao || '' };
  if (l.tipo === 'decisao') {
    const quem = l.origem === 'analista' ? 'Analista (pelo sistema)' : l.origem === 'aprovacao_manual' ? 'Agente · aprovado pelo analista' : 'Agente';
    const tipoQuem = l.origem === 'analista' ? 'analista' : 'agente';
    if (d.roas_para != null) out.push({ ...base, campo: 'Meta ROAS', de: xRoas(d.roas_de), para: xRoas(d.roas_para), quem, tipoQuem });
    if (d.budget_para != null) out.push({ ...base, campo: 'Orçamento diário', de: d.budget_de != null ? fmtR(d.budget_de) : '—', para: fmtR(d.budget_para), quem, tipoQuem });
    if (d.pausada || /^Campanha pausada/.test(l.titulo || '') || /Aprovado manualmente — .*paus/i.test(l.titulo || '')) out.push({ ...base, campo: 'Status', de: 'ativa', para: 'pausada', quem, tipoQuem });
    if (d.retomada) out.push({ ...base, campo: 'Status', de: 'pausada', para: 'ativa', quem, tipoQuem });
    return out;
  }
  // ML: sugestão do agente que foi aplicada no painel (conferida ou marcada como feita)
  const quem = d.aplicado_por === 'detectado' ? 'Analista no ML · conferido pelo agente' : 'Analista no ML · marcado como feito';
  const tipoQuem = 'analista';
  const porque = base.porque + (d.deteccao ? ` (o agente conferiu: ${d.deteccao})` : '');
  const prod = d.produto ? `"${String(d.produto).slice(0, 50)}"` : 'produto';
  switch (d.acao) {
    case 'roas_target': out.push({ ...base, porque, campo: 'Meta ROAS', de: xRoas(d.de), para: xRoas(d.para), quem, tipoQuem }); break;
    case 'orcamento': out.push({ ...base, porque, campo: 'Orçamento diário', de: d.de != null ? fmtR(d.de) : '—', para: d.para != null ? fmtR(d.para) : '—', quem, tipoQuem }); break;
    case 'pausar': out.push({ ...base, porque, campo: 'Status', de: 'ativa', para: 'pausada', quem, tipoQuem }); break;
    case 'retirar_produto': out.push({ ...base, porque, campo: 'Produto na campanha', de: prod, para: 'retirado', quem, tipoQuem }); break;
    case 'mover_produto': out.push({ ...base, porque, campo: 'Produto na campanha', de: prod, para: `movido para ${d.destino || 'outra campanha'}`, quem, tipoQuem }); break;
    case 'adicionar_produto': out.push({ ...base, porque, campo: 'Produto na campanha', de: prod, para: `adicionado${d.destino ? ` em ${d.destino}` : ''}`, quem, tipoQuem }); break;
  }
  return out;
}
async function carregarAlteracoesServidor() {
  const statusEl = document.getElementById('track-ads-status');
  if (typeof _sb === 'undefined') return; // _sb é const global (não fica em window)
  try {
    const desde = new Date(Date.now() - 60 * 864e5).toISOString();
    const linhas = [];
    for (let off = 0; off < 6000; off += 1000) {
      const { data, error } = await _sb.from('glr_agente_log').select('id,conta_id,tipo,titulo,explicacao,criado_em,dados,origem')
        .eq('resultado', 'executado').in('tipo', ['decisao', 'alerta']).gte('criado_em', desde).order('criado_em', { ascending: false }).range(off, off + 999);
      if (error) throw error;
      linhas.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    adsServidor = linhas.flatMap(alteracoesDoLog);
    renderAdsLog();
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Não consegui ler as alterações do agente: ' + (e.message || e);
  }
}
window._trackAdsFiltro = () => renderAdsLog();

function renderAdsLog() {
  const el = document.getElementById('track-ads-log');
  if (!el) return;
  const num = t => parseFloat(String(t).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.'));
  // Mudança achada pela comparação de retratos que é a mesma que o agente já
  // registrou (mesma campanha, mesmo campo, mesmo valor final, até 3 dias depois) sai da lista
  const doServidor = adsServidor;
  const locais = lerJSON(K_ADS_LOG, []).filter(l => !doServidor.some(s => s.campanhaId === String(l.campanhaId) && s.campo === l.campo
    && (num(s.para) === num(l.para) || s.para === l.para) && Math.abs(new Date(l.quando) - new Date(s.quando)) < 3 * 864e5))
    .map(l => ({ ...l, quem: 'Fora do sistema · achado na verificação', tipoQuem: 'fora', porque: 'Mudança encontrada comparando com a verificação anterior — a hora é a da verificação, não a da mudança.' }));
  const v = id => document.getElementById(id)?.value || '';
  const fConta = v('track-ads-f-conta'), fCampo = v('track-ads-f-campo'), fQuem = v('track-ads-f-quem'), fDias = parseInt(v('track-ads-f-dias')) || 30, fBusca = v('track-ads-f-busca').toLowerCase().trim();
  const corte = Date.now() - fDias * 864e5;
  const todas = [...doServidor, ...locais].filter(l => new Date(l.quando).getTime() >= corte
    && (!fConta || String(l.contaId) === fConta) && (!fCampo || l.campo === fCampo) && (!fQuem || l.tipoQuem === fQuem)
    && (!fBusca || String(l.campanhaNome || '').toLowerCase().includes(fBusca) || String(l.campanhaId).includes(fBusca)))
    .sort((a, b) => new Date(b.quando) - new Date(a.quando));
  const statusEl = document.getElementById('track-ads-status');
  if (statusEl && !statusEl.dataset.fixo) statusEl.textContent = `${todas.length} alteração(ões) no período${todas.length > 2000 ? " — mostrando as 2000 mais recentes (use os filtros)" : ""}.`;
  if (!todas.length) {
    el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px;background:var(--bg-card);border-radius:10px;">Nenhuma alteração no período com esses filtros.</div>`;
    return;
  }
  const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const corQuem = { agente: 'var(--accent)', analista: 'var(--green)', fora: 'var(--orange)' };
  el.innerHTML = `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">
    <thead><tr style="font-size:10.5px;color:var(--text-muted);text-transform:none;">
      <th style="text-align:left;padding:6px 8px;">Quando</th><th style="text-align:left;padding:6px 8px;">Conta</th><th style="text-align:left;padding:6px 8px;">Campanha</th><th style="text-align:left;padding:6px 8px;">O que mudou</th><th style="text-align:right;padding:6px 8px;">De</th><th style="text-align:right;padding:6px 8px;">Para</th><th style="text-align:left;padding:6px 8px;">Quem</th>
    </tr></thead>
    <tbody>${todas.slice(0, 2000).map(l => `<tr style="border-top:1px solid var(--border);" title="${esc(l.porque)}">
      <td style="padding:6px 8px;font-size:12px;color:var(--text-muted);white-space:nowrap;">${fmtQuando(l.quando)}</td>
      <td style="padding:6px 8px;font-size:12px;">${esc(l.contaNome || nomeAdsConta(l.contaId))}</td>
      <td style="padding:6px 8px;font-size:12px;max-width:320px;">${esc(l.campanhaNome)}${l.campanhaId ? ` <span style="color:var(--text-muted);font-size:11px;">#${esc(l.campanhaId)}</span>` : ''}${l.porque ? `<div style="font-size:11px;color:var(--text-muted);white-space:normal;max-height:2.6em;overflow:hidden;">${esc(l.porque)}</div>` : ''}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap;">${esc(l.campo)}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;color:var(--text-muted);">${esc(l.de)}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;font-weight:600;">${esc(l.para)}</td>
      <td style="padding:6px 8px;font-size:11.5px;white-space:nowrap;color:${corQuem[l.tipoQuem] || 'inherit'};font-weight:600;">${esc(l.quem || 'Fora do sistema')}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ── Preços: watchlist manual + escaneio ──
// Escaneia TODOS os anúncios ativos da conta selecionada (sem precisar digitar ID
// de anúncio nenhum) e compara com o preço salvo na última verificação dessa
// mesma conta. Manual — dispara ao selecionar a conta ou clicar no botão.
window._trackEscanearPrecos = async function() {
  const selIdx = document.getElementById('track-preco-conta').value;
  if (selIdx === '') { alert('Selecione a conta primeiro.'); return; }
  const conta = contasAds[parseInt(selIdx)];
  const btn = document.getElementById('track-btn-precos');
  const statusEl = document.getElementById('track-preco-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Verificando...'; }

  const snapPorConta = lerJSON(K_PRECO_SNAP, {});
  const snap = snapPorConta[conta.external_id] || {};
  const logArr = lerJSON(K_PRECO_LOG, []);
  const nomeConta = window._trackNomeConta ? window._trackNomeConta(conta) : conta.external_id;
  let ok = 0, mudancas = 0, erro = '';

  try {
    if (conta.marketplace === 'shopee') {
      const shopId = conta.param_to_use?.shopId || conta.external_id;
      const rl = await MarketplaceAPI.call('shopee_list_items', { shopId, item_status: 'NORMAL', page_size: 50 });
      const idsRaw = rl?.data?.response?.item || rl?.data?.item || [];
      const ids = idsRaw.map(x => x.item_id).filter(Boolean);
      if (ids.length) {
        const rd = await MarketplaceAPI.call('shopee_get_items_batch', { shopId, item_id_list: ids });
        const detalhes = rd?.data?.response?.item_list || [];
        for (const it of detalhes) {
          // Itens com variação (has_model) não trazem price_info no nível do item —
          // o preço real (já refletindo promoção) fica em price_min/price_max.
          const precoAtual = it.has_model ? (parseFloat(it.price_min) || 0) : (it.price_info?.[0]?.current_price || 0);
          const antes = snap[it.item_id];
          if (antes != null && antes !== precoAtual) {
            logArr.unshift({ id: novoId(), itemId: it.item_id, apelido: (it.item_name || String(it.item_id)).slice(0,60), de: fmtR(antes), para: fmtR(precoAtual), quando: new Date().toISOString() });
            mudancas++;
          }
          snap[it.item_id] = precoAtual;
          ok++;
        }
      }
    } else {
      const meliId = conta.param_to_use?.meliUserId || conta.external_id;
      const r = await MarketplaceAPI.call('list_items', { meliUserId: meliId, status: 'active', limit: 100 });
      const itens = (r?.data?.results || r?.results || []).map(x => x.body).filter(Boolean);
      for (const it of itens) {
        const precoAtual = parseFloat(it.price) || 0;
        const antes = snap[it.id];
        if (antes != null && antes !== precoAtual) {
          logArr.unshift({ id: novoId(), itemId: it.id, apelido: (it.title || it.id).slice(0,60), de: fmtR(antes), para: fmtR(precoAtual), quando: new Date().toISOString() });
          mudancas++;
        }
        snap[it.id] = precoAtual;
        ok++;
      }
    }
  } catch(e) {
    erro = e.message;
  }

  snapPorConta[conta.external_id] = snap;
  salvarJSON(K_PRECO_SNAP, snapPorConta);
  salvarJSON(K_PRECO_LOG, logArr.slice(0, 3000));

  if (btn) { btn.disabled = false; btn.textContent = 'Verificar mudanças agora'; }
  if (statusEl) {
    statusEl.innerHTML = erro
      ? `<span style="color:var(--red);">⚠️ Erro em ${nomeConta}: ${erro}</span>`
      : `${nomeConta} — verificado em ${new Date().toLocaleString('pt-BR')}: ${ok} anúncio(s), ${mudancas} mudança(s) nova(s)${ok === 0 ? ' (nenhum anúncio ativo encontrado)' : ''}.`;
  }
  renderPrecoLog();
};

function renderPrecoLog() {
  const el = document.getElementById('track-preco-log');
  if (!el) return;
  const logArr = lerJSON(K_PRECO_LOG, []);
  if (!logArr.length) {
    el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px;background:var(--bg-card);border-radius:10px;">Nenhuma mudança de preço registrada ainda.</div>`;
    return;
  }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;">
    <thead><tr style="font-size:10.5px;color:var(--text-muted);text-transform:none;">
      <th style="text-align:left;padding:6px 8px;">Quando</th><th style="text-align:left;padding:6px 8px;">Anúncio</th><th style="text-align:right;padding:6px 8px;">De</th><th style="text-align:right;padding:6px 8px;">Para</th>
    </tr></thead>
    <tbody>${logArr.slice(0, 150).map(l => `<tr style="border-top:1px solid var(--border);">
      <td style="padding:6px 8px;font-size:12px;color:var(--text-muted);white-space:nowrap;">${fmtQuando(l.quando)}</td>
      <td style="padding:6px 8px;font-size:12px;">${l.apelido}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;color:var(--text-muted);">${l.de}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;font-weight:600;">${l.para}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

// ── Pré-venda Shopee: escaneia TODAS as contas Shopee conectadas automaticamente,
// sem precisar selecionar conta. Compara pre_order.is_pre_order (confirmado ao
// vivo na API) com o último retrato salvo, conta por conta.
window._trackEscanearPrevendaShopee = async function() {
  const statusEl = document.getElementById('track-prevenda-status-shopee');
  const btn = document.getElementById('track-btn-prevenda-shopee');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Verificando...'; }

  const snapPorConta = lerJSON(K_PREVENDA_SNAP, {});
  const logArr = lerJSON(K_PREVENDA_LOG, []);
  const contasShopee = contasAds.filter(c => c.marketplace === 'shopee');
  let contasVerificadas = 0, totalItens = 0, mudancas = 0, erro = '';

  for (const conta of contasShopee) {
    const snap = snapPorConta[conta.external_id] || {};
    const nomeConta = window._trackNomeConta ? window._trackNomeConta(conta) : conta.external_id;
    try {
      const shopId = conta.param_to_use?.shopId || conta.external_id;
      const rl = await MarketplaceAPI.call('shopee_list_items', { shopId, item_status: 'NORMAL', page_size: 50 });
      const idsRaw = rl?.data?.response?.item || rl?.data?.item || [];
      const ids = idsRaw.map(x => x.item_id).filter(Boolean);
      if (ids.length) {
        const rd = await MarketplaceAPI.call('shopee_get_items_batch', { shopId, item_id_list: ids });
        const detalhes = rd?.data?.response?.item_list || [];
        for (const it of detalhes) {
          // Item com variação: pré-venda se QUALQUER modelo estiver em pré-venda.
          const emPrevenda = it.has_model
            ? (it.models || []).some(m => m.pre_order?.is_pre_order)
            : !!it.pre_order?.is_pre_order;
          const nomeItem = (it.item_name || String(it.item_id)).slice(0,60);
          const antes = lerEstadoPrevenda(snap[it.item_id]);
          if (antes != null && antes !== emPrevenda) {
            logArr.unshift({ id: novoId(), itemId: it.item_id, apelido: `${nomeConta} — ${nomeItem}`, de: antes ? 'Em pré-venda' : 'Normal', para: emPrevenda ? 'Em pré-venda' : 'Normal', quando: new Date().toISOString() });
            mudancas++;
          }
          snap[it.item_id] = { emPrevenda, nome: nomeItem, conta: nomeConta, marketplace: 'shopee', itemId: String(it.item_id) };
          totalItens++;
        }
      }
      snapPorConta[conta.external_id] = snap;
      contasVerificadas++;
    } catch(e) {
      erro = e.message;
      console.warn('[Track] Erro pré-venda Shopee na conta', conta.external_id, e.message);
    }
  }

  salvarJSON(K_PREVENDA_SNAP, snapPorConta);
  salvarJSON(K_PREVENDA_LOG, logArr.slice(0, 3000));

  if (btn) { btn.disabled = false; btn.textContent = 'Verificar pré-venda Shopee (todas as contas)'; }
  if (statusEl) {
    statusEl.innerHTML = erro
      ? `<span style="color:var(--red);">⚠️ ${contasVerificadas}/${contasShopee.length} conta(s) Shopee verificada(s), ${totalItens} anúncio(s) — último erro: ${erro}</span>`
      : `${contasVerificadas} conta(s) Shopee verificada(s) em ${new Date().toLocaleString('pt-BR')} — ${totalItens} anúncio(s), ${mudancas} mudança(s) nova(s) de pré-venda.`;
  }
  renderPrevendaAtual();
  renderPrevendaLog();
};

// Aceita tanto o formato antigo (booleano puro) quanto o novo ({emPrevenda, nome, conta}).
function lerEstadoPrevenda(v) {
  if (v == null) return null;
  return typeof v === 'object' ? !!v.emPrevenda : !!v;
}

// Lista os anúncios que estão em pré-venda AGORA (não só as mudanças) — lê o
// retrato salvo de todas as contas, Shopee e ML juntas.
function renderPrevendaAtual() {
  const el = document.getElementById('track-prevenda-atual');
  if (!el) return;
  const snapPorConta = lerJSON(K_PREVENDA_SNAP, {});
  const atuais = [];
  Object.values(snapPorConta).forEach(snap => {
    Object.entries(snap || {}).forEach(([itemId, v]) => {
      if (v && typeof v === 'object' && v.emPrevenda) atuais.push({ itemId: v.itemId || itemId, nome: v.nome || itemId, conta: v.conta || '', marketplace: v.marketplace || '' });
    });
  });
  if (!atuais.length) {
    el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-secondary);font-size:12.5px;background:var(--bg-card);border-radius:10px;margin-bottom:14px;">Nenhum anúncio em pré-venda no momento (ou ainda não verificado).</div>`;
    return;
  }
  const badge = mp => mp === 'shopee' ? '<span style="color:#ee4d2d;font-weight:600;">🟠 Shopee</span>' : mp === 'ml' ? '<span style="color:#ffd100;background:#3483fa;padding:1px 6px;border-radius:3px;font-weight:600;">ML</span>' : '—';
  el.innerHTML = `<div style="margin-bottom:14px;">
    <div style="font-size:11px;color:var(--text-muted);text-transform:none;margin-bottom:6px;">Em pré-venda agora (${atuais.length})</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="font-size:10.5px;color:var(--text-muted);text-transform:none;">
        <th style="text-align:left;padding:6px 8px;">Plataforma</th><th style="text-align:left;padding:6px 8px;">ID</th><th style="text-align:left;padding:6px 8px;">Conta</th><th style="text-align:left;padding:6px 8px;">Anúncio</th>
      </tr></thead>
      <tbody>${atuais.map(a => `<tr style="border-top:1px solid var(--border);">
        <td style="padding:6px 8px;font-size:12px;white-space:nowrap;">${badge(a.marketplace)}</td>
        <td style="padding:6px 8px;font-size:11.5px;color:var(--text-muted);white-space:nowrap;font-family:monospace;">${a.itemId}</td>
        <td style="padding:6px 8px;font-size:12px;color:var(--text-muted);white-space:nowrap;">${a.conta}</td>
        <td style="padding:6px 8px;font-size:12px;">${a.nome}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

function renderPrevendaLog() {
  const el = document.getElementById('track-prevenda-log');
  if (!el) return;
  const logArr = lerJSON(K_PREVENDA_LOG, []);
  if (!logArr.length) {
    el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px;background:var(--bg-card);border-radius:10px;">Nenhuma mudança de pré-venda registrada ainda.</div>`;
    return;
  }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;">
    <thead><tr style="font-size:10.5px;color:var(--text-muted);text-transform:none;">
      <th style="text-align:left;padding:6px 8px;">Quando</th><th style="text-align:left;padding:6px 8px;">Anúncio</th><th style="text-align:right;padding:6px 8px;">De</th><th style="text-align:right;padding:6px 8px;">Para</th>
    </tr></thead>
    <tbody>${logArr.slice(0, 150).map(l => `<tr style="border-top:1px solid var(--border);">
      <td style="padding:6px 8px;font-size:12px;color:var(--text-muted);white-space:nowrap;">${fmtQuando(l.quando)}</td>
      <td style="padding:6px 8px;font-size:12px;">${l.apelido}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;color:var(--text-muted);">${l.de}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;font-weight:600;">${l.para}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

// ── Pré-venda ML: escaneia TODAS as contas ML conectadas automaticamente, sem
// precisar de ID. O ML não tem campo de API pra pré-venda (confirmado ao vivo:
// testei get_item, ml_item_prices e listagens reais em várias contas e nenhuma
// trouxe um sinal dedicado) — por isso o sinal usado aqui é o próprio título do
// anúncio conter palavras que vendedores usam pra marcar pré-venda manualmente.
const PREVENDA_PALAVRAS = /pr[eé][\s-]?venda|chega(m)?\s+em\s+breve|dispon[ií]vel\s+em\s+breve|encomenda/i;

window._trackEscanearPrevendaML = async function() {
  const btn = document.getElementById('track-btn-prevenda-ml');
  const statusEl = document.getElementById('track-prevenda-status-ml');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Verificando...'; }

  const snapPorConta = lerJSON(K_PREVENDA_SNAP, {});
  const logArr = lerJSON(K_PREVENDA_LOG, []);
  const contasML = contasTodas.filter(c => ['mercadolivre','ml','meli'].includes(c.marketplace));
  let contasVerificadas = 0, totalItens = 0, mudancas = 0, erro = '';

  for (const conta of contasML) {
    const snap = snapPorConta[conta.external_id] || {};
    const nomeConta = window._trackNomeConta ? window._trackNomeConta(conta) : conta.external_id;
    try {
      const meliId = conta.param_to_use?.meliUserId || conta.external_id;
      const r = await MarketplaceAPI.call('list_items', { meliUserId: meliId, status: 'active', limit: 100 });
      const itens = (r?.data?.results || r?.results || []).map(x => x.body).filter(Boolean);
      for (const it of itens) {
        // Campo confirmado ao vivo: product_release_date em ml_user_product_stock
        // é o "Prazo de disponibilidade do produto" da tela do vendedor — quando
        // preenchido com data futura, o anúncio está em pré-venda. Só existe pra
        // anúncios com a tag user_product_listing (evita 2 chamadas extras por
        // anúncio nos que nem têm esse recurso).
        let emPrevendaEstoque = false;
        if (Array.isArray(it.tags) && it.tags.includes('user_product_listing')) {
          try {
            const gi = await MarketplaceAPI.call('get_item', { meliUserId, item_id: it.id });
            const giBody = gi?.data || gi;
            const upId = giBody?.user_product_id;
            if (upId) {
              const se = await MarketplaceAPI.call('ml_user_product_stock', { meliUserId, user_product_id: upId });
              const seBody = se?.data || se;
              const dataLancamento = seBody?.product_release_date;
              if (dataLancamento && new Date(dataLancamento) > new Date()) emPrevendaEstoque = true;
            }
          } catch(e) { /* segue sem esse sinal se der erro num item específico */ }
        }
        // Estoque zerado com anúncio ativo também é um sinal real de pré-venda.
        const emPrevenda = PREVENDA_PALAVRAS.test(it.title || '') || (it.status === 'active' && it.available_quantity === 0) || emPrevendaEstoque;
        const nomeItem = (it.title || it.id).slice(0,50);
        const antes = lerEstadoPrevenda(snap[it.id]);
        if (antes != null && antes !== emPrevenda) {
          logArr.unshift({ id: novoId(), itemId: it.id, apelido: `${nomeConta} — ${nomeItem}`, de: antes ? 'Em pré-venda' : 'Normal', para: emPrevenda ? 'Em pré-venda' : 'Normal', quando: new Date().toISOString() });
          mudancas++;
        }
        snap[it.id] = { emPrevenda, nome: nomeItem, conta: nomeConta, marketplace: 'ml', itemId: String(it.id) };
        totalItens++;
      }
      snapPorConta[conta.external_id] = snap;
      contasVerificadas++;
    } catch(e) {
      erro = e.message;
      console.warn('[Track] Erro pré-venda ML na conta', conta.external_id, e.message);
    }
  }

  salvarJSON(K_PREVENDA_SNAP, snapPorConta);
  salvarJSON(K_PREVENDA_LOG, logArr.slice(0, 3000));

  if (btn) { btn.disabled = false; btn.textContent = 'Verificar pré-venda ML (todas as contas)'; }
  if (statusEl) {
    statusEl.innerHTML = erro
      ? `<span style="color:var(--red);">⚠️ ${contasVerificadas}/${contasML.length} conta(s) ML verificada(s), ${totalItens} anúncio(s) — último erro: ${erro} (contas com esse erro específico precisam reconectar em marketplaces.tiops.com.br)</span>`
      : `${contasVerificadas} conta(s) ML verificada(s) em ${new Date().toLocaleString('pt-BR')} — ${totalItens} anúncio(s), ${mudancas} mudança(s) nova(s) de pré-venda.`;
  }
  renderPrevendaAtual();
  renderPrevendaLog();
};

// ── Estoque completo ML: lista TODOS os anúncios ativos de todas as contas com a
// disponibilidade de estoque de cada um, ordenados do menor pro maior — pra você
// apontar visualmente qual está em pré-venda, já que não achei um campo de API
// dedicado nem um padrão de estoque zerado nos anúncios amostrados até agora.
window._trackListarEstoqueML = async function() {
  const btn = document.getElementById('track-btn-estoque-ml');
  const el = document.getElementById('track-estoque-ml');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Buscando...'; }
  el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-muted);font-size:12.5px;">Buscando anúncios de todas as contas ML...</div>`;

  const contasML = contasTodas.filter(c => ['mercadolivre','ml','meli'].includes(c.marketplace));
  const todos = [];
  let erro = '';

  for (const conta of contasML) {
    const nomeConta = window._trackNomeConta ? window._trackNomeConta(conta) : conta.external_id;
    try {
      const meliId = conta.param_to_use?.meliUserId || conta.external_id;
      const r = await MarketplaceAPI.call('list_items', { meliUserId: meliId, status: 'active', limit: 100 });
      const itens = (r?.data?.results || r?.results || []).map(x => x.body).filter(Boolean);
      itens.forEach(it => todos.push({ id: it.id, nome: (it.title || it.id).slice(0,60), conta: nomeConta, estoque: it.available_quantity ?? '—', status: it.status, subStatus: (it.sub_status || []).join(', ') }));
    } catch(e) {
      erro = e.message;
    }
  }

  todos.sort((a, b) => (typeof a.estoque === 'number' ? a.estoque : 999999) - (typeof b.estoque === 'number' ? b.estoque : 999999));
  const mostrar = todos.slice(0, 300);

  if (btn) { btn.disabled = false; btn.textContent = 'Ver estoque de todos os anúncios ML'; }

  if (!todos.length) {
    el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--red);font-size:12.5px;">Nenhum anúncio encontrado${erro ? ' — ' + erro : ''}.</div>`;
    return;
  }

  el.innerHTML = `
    <div style="font-size:11px;color:var(--text-muted);text-transform:none;margin-bottom:6px;">
      Estoque de todos os anúncios ML (${todos.length} total, mostrando os ${mostrar.length} com menor estoque)${erro ? ' — algumas contas deram erro' : ''}
    </div>
    <div style="max-height:400px;overflow-y:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="font-size:10.5px;color:var(--text-muted);text-transform:none;position:sticky;top:0;background:var(--bg-card);">
          <th style="text-align:left;padding:6px 8px;">MLB</th><th style="text-align:left;padding:6px 8px;">Conta</th><th style="text-align:left;padding:6px 8px;">Anúncio</th><th style="text-align:right;padding:6px 8px;">Estoque</th><th style="text-align:left;padding:6px 8px;">Sub-status</th>
        </tr></thead>
        <tbody>${mostrar.map(it => `<tr style="border-top:1px solid var(--border);${it.estoque === 0 ? 'background:rgba(220,38,38,0.08);' : ''}">
          <td style="padding:6px 8px;font-size:11.5px;font-family:monospace;color:var(--text-muted);white-space:nowrap;">${it.id}</td>
          <td style="padding:6px 8px;font-size:12px;color:var(--text-muted);white-space:nowrap;">${it.conta}</td>
          <td style="padding:6px 8px;font-size:12px;">${it.nome}</td>
          <td style="padding:6px 8px;font-size:12px;text-align:right;font-weight:${it.estoque === 0 ? '700' : '400'};color:${it.estoque === 0 ? 'var(--red)' : 'inherit'};">${it.estoque}</td>
          <td style="padding:6px 8px;font-size:11px;color:var(--text-muted);">${it.subStatus}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
};

// ── Inspeção manual ML: mostra os campos brutos do anúncio pra identificar
// juntos o sinal de pré-venda — o ML não documenta um campo público confirmado. ──
window._trackInspecionarML = async function() {
  const raw = (document.getElementById('track-ml-item-id').value || '').trim();
  const resEl = document.getElementById('track-ml-resultado');
  if (!raw) { alert('Cole o ID (MLB...) ou o link do anúncio.'); return; }
  const m = raw.match(/MLB-?\d+/i);
  const itemId = m ? m[0].replace('-', '').toUpperCase() : raw.toUpperCase();
  resEl.innerHTML = `<span style="color:var(--text-muted);">⏳ Buscando ${itemId}...</span>`;

  const contasML = contasTodas.filter(c => ['mercadolivre','ml','meli'].includes(c.marketplace));
  let item = null, erroFinal = '';
  for (const conta of contasML) {
    try {
      const meliId = conta.param_to_use?.meliUserId || conta.external_id;
      const r = await MarketplaceAPI.call('get_item', { meliUserId: meliId, item_id: itemId });
      const body = r?.data || r;
      if (body && !body.error && body.id) { item = body; break; }
      erroFinal = body?.message || body?.error || 'sem resposta';
    } catch(e) {
      erroFinal = e.message;
    }
  }

  if (!item) {
    resEl.innerHTML = `<span style="color:var(--red);">⚠️ Não consegui acessar esse anúncio em nenhuma conta ML conectada (${erroFinal}). Confirme o ID/link ou se a conta dona dele está vinculada aqui.</span>`;
    return;
  }

  const campos = {
    status: item.status, sub_status: item.sub_status, tags: item.tags,
    available_quantity: item.available_quantity, sold_quantity: item.sold_quantity,
    shipping: item.shipping, date_created: item.date_created,
    catalog_listing: item.catalog_listing, catalog_product_id: item.catalog_product_id,
  };
  resEl.innerHTML = `
    <div style="background:var(--bg-card);border-radius:8px;padding:12px;">
      <div style="font-weight:600;margin-bottom:6px;">${item.title || itemId}</div>
      <pre style="white-space:pre-wrap;font-size:11.5px;color:var(--text-secondary);margin:0;">${JSON.stringify(campos, null, 2)}</pre>
      <p style="font-size:11.5px;color:var(--text-muted);margin:8px 0 0;">Procure aqui algo que mude quando o anúncio sai/entra de pré-venda (ex.: em <code>tags</code>, <code>sub_status</code> ou <code>shipping</code>) e me avisa qual campo é — eu ligo a detecção automática nele.</p>
    </div>`;
};

if (typeof Router !== 'undefined') {
  Router.register('rastreamento', renderPage);
}

})();
