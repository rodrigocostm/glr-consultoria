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
const K_PRECO_WATCH = 'glr_track_precos_watch';
const K_PRECO_SNAP  = 'glr_track_precos_snap';
const K_PRECO_LOG   = 'glr_track_precos_log';

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
      <h2 style="font-size:20px;font-weight:700;color:var(--text-primary);margin:0;">🕵️ Histórico de Alterações</h2>
      <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 0;">
        Compara o estado atual com o último retrato salvo pra detectar mudanças de orçamento/status de ADS e de preço.
        Só enxerga diferença entre uma atualização e outra — os marketplaces não têm log de alterações pra consultar.
      </p>
    </div>

    <!-- ADS -->
    <div class="card" style="padding:20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:6px;">
        <div class="section-title" style="font-size:15px;">📢 Campanhas de ADS</div>
        <button class="btn btn-primary btn-sm" id="track-btn-ads" onclick="window._trackEscanearAds()">🔄 Verificar mudanças agora</button>
      </div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:0 0 14px;">Varre orçamento, status e meta ROAS de todas as campanhas Mercado Livre e Shopee vinculadas.</p>
      <div id="track-ads-status" style="font-size:12px;color:var(--text-muted);margin-bottom:10px;"></div>
      <div id="track-ads-log"></div>
    </div>

    <!-- Preços -->
    <div class="card" style="padding:20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:6px;">
        <div class="section-title" style="font-size:15px;">💲 Preços monitorados</div>
        <button class="btn btn-primary btn-sm" id="track-btn-precos" onclick="window._trackEscanearPrecos()">🔄 Verificar mudanças agora</button>
      </div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:0 0 14px;">Adicione os anúncios que quer acompanhar — só rastreia os que estão na lista abaixo.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
        <select id="track-preco-conta" class="form-input" style="min-width:200px;"><option value="">Carregando contas...</option></select>
        <input class="form-input" id="track-preco-item" placeholder="ID do anúncio (MLB... ou item Shopee)" style="min-width:220px;">
        <input class="form-input" id="track-preco-apelido" placeholder="Apelido (opcional)" style="min-width:160px;">
        <button class="btn btn-secondary btn-sm" onclick="window._trackAdicionarWatch()">+ Adicionar</button>
      </div>
      <div id="track-preco-watchlist" style="margin-bottom:14px;"></div>
      <div id="track-preco-status" style="font-size:12px;color:var(--text-muted);margin-bottom:10px;"></div>
      <div id="track-preco-log"></div>
    </div>

    <!-- Pré-venda -->
    <div class="card" style="padding:20px;">
      <div class="section-title" style="font-size:15px;margin-bottom:6px;">📦 Entrada em pré-venda</div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:0;">
        Ainda não construí essa parte — preciso confirmar em qual campo da API o Mercado Livre marca um anúncio como pré-venda
        (data de disponibilidade futura). Me manda o ID de um anúncio (MLB...) que esteja assim agora que eu confirmo o campo certo e encaixo aqui.
      </p>
    </div>
  `;
  renderWatchlist();
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
    }

    renderAdsLog();
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
  const logFinal = logArr.slice(0, 300); // guarda só as 300 mudanças mais recentes
  salvarJSON(K_ADS_LOG, logFinal);

  if (btn) { btn.disabled = false; btn.textContent = '🔄 Verificar mudanças agora'; }
  const novasMudancas = logArr.length - totalAntes;
  if (statusEl) statusEl.textContent = `Verificado em ${new Date().toLocaleString('pt-BR')} — ${contasVerificadas} conta(s), ${novasMudancas} mudança(s) nova(s) detectada(s).`;
  renderAdsLog();
};

function renderAdsLog() {
  const el = document.getElementById('track-ads-log');
  if (!el) return;
  const logArr = lerJSON(K_ADS_LOG, []);
  if (!logArr.length) {
    el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px;background:var(--bg-card);border-radius:10px;">Nenhuma mudança registrada ainda. Clique em "Verificar mudanças agora" — a primeira vez só salva o retrato inicial, mudanças aparecem a partir da segunda verificação.</div>`;
    return;
  }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;">
    <thead><tr style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;">
      <th style="text-align:left;padding:6px 8px;">Quando</th><th style="text-align:left;padding:6px 8px;">Conta</th><th style="text-align:left;padding:6px 8px;">Campanha</th><th style="text-align:left;padding:6px 8px;">Campo</th><th style="text-align:right;padding:6px 8px;">De</th><th style="text-align:right;padding:6px 8px;">Para</th>
    </tr></thead>
    <tbody>${logArr.slice(0, 60).map(l => `<tr style="border-top:1px solid var(--border);">
      <td style="padding:6px 8px;font-size:12px;color:var(--text-muted);white-space:nowrap;">${fmtQuando(l.quando)}</td>
      <td style="padding:6px 8px;font-size:12px;">${l.contaNome}</td>
      <td style="padding:6px 8px;font-size:12px;">${l.campanhaNome}</td>
      <td style="padding:6px 8px;font-size:12px;">${l.campo}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;color:var(--text-muted);">${l.de}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;font-weight:600;">${l.para}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

// ── Preços: watchlist manual + escaneio ──
function renderWatchlist() {
  const el = document.getElementById('track-preco-watchlist');
  if (!el) return;
  const watch = lerJSON(K_PRECO_WATCH, []);
  if (!watch.length) {
    el.innerHTML = `<div style="font-size:12.5px;color:var(--text-muted);">Nenhum item na lista ainda.</div>`;
    return;
  }
  el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px;">
    ${watch.map(w => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;background:var(--bg-base);border:1px solid var(--border);border-radius:99px;padding:4px 6px 4px 12px;">
      ${w.apelido || w.itemId}
      <button onclick="window._trackRemoverWatch('${w.id}')" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:14px;line-height:1;">✕</button>
    </span>`).join('')}
  </div>`;
  renderPrecoLog();
}

window._trackAdicionarWatch = function() {
  const selIdx = document.getElementById('track-preco-conta').value;
  const itemId = document.getElementById('track-preco-item').value.trim();
  const apelido = document.getElementById('track-preco-apelido').value.trim();
  if (selIdx === '') { alert('Selecione a conta.'); return; }
  if (!itemId) { alert('Informe o ID do anúncio.'); return; }
  const conta = contasAds[parseInt(selIdx)];
  const watch = lerJSON(K_PRECO_WATCH, []);
  watch.push({ id: novoId(), marketplace: conta.marketplace, contaId: conta.external_id, itemId, apelido: apelido || itemId });
  salvarJSON(K_PRECO_WATCH, watch);
  document.getElementById('track-preco-item').value = '';
  document.getElementById('track-preco-apelido').value = '';
  renderWatchlist();
};

window._trackRemoverWatch = function(id) {
  let watch = lerJSON(K_PRECO_WATCH, []);
  watch = watch.filter(w => w.id !== id);
  salvarJSON(K_PRECO_WATCH, watch);
  renderWatchlist();
};

window._trackEscanearPrecos = async function() {
  const watch = lerJSON(K_PRECO_WATCH, []);
  if (!watch.length) { alert('Adicione pelo menos um anúncio na lista primeiro.'); return; }
  const btn = document.getElementById('track-btn-precos');
  const statusEl = document.getElementById('track-preco-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Verificando...'; }

  const snap = lerJSON(K_PRECO_SNAP, {});
  const logArr = lerJSON(K_PRECO_LOG, []);
  let ok = 0, erros = 0;
  const errosDetalhe = [];

  for (const w of watch) {
    const conta = contasAds.find(c => c.external_id === w.contaId);
    if (!conta) { erros++; errosDetalhe.push(`${w.apelido}: conta não encontrada`); continue; }
    try {
      let precoAtual = null;
      if (w.marketplace === 'shopee') {
        // shopee_get_item não devolve preço — o preço fica em shopee_get_models
        // (por variação/model), já em reais, sem dividir por nada.
        const shopId = conta.param_to_use?.shopId || conta.external_id;
        const r = await MarketplaceAPI.call('shopee_get_models', { shopId, item_id: parseInt(w.itemId) });
        const modelo = (r?.data?.response?.model || [])[0];
        precoAtual = modelo?.price_info?.[0]?.current_price ?? null;
      } else {
        const meliId = conta.param_to_use?.meliUserId || conta.external_id;
        const r = await MarketplaceAPI.call('ml_item_prices', { meliUserId: meliId, item_id: w.itemId });
        const dados = r?.data?.response || r?.data || r?.response;
        precoAtual = dados?.prices?.[0]?.amount ?? dados?.price ?? null;
      }
      if (precoAtual == null) { erros++; errosDetalhe.push(`${w.apelido}: anúncio não encontrado nessa conta (confira o ID e a conta selecionada)`); continue; }
      const antes = snap[w.itemId];
      if (antes != null && antes !== precoAtual) {
        logArr.unshift({ id: novoId(), itemId: w.itemId, apelido: w.apelido, de: fmtR(antes), para: fmtR(precoAtual), quando: new Date().toISOString() });
      }
      snap[w.itemId] = precoAtual;
      ok++;
    } catch(e) {
      erros++;
      errosDetalhe.push(`${w.apelido}: ${e.message}`);
    }
  }

  salvarJSON(K_PRECO_SNAP, snap);
  salvarJSON(K_PRECO_LOG, logArr.slice(0, 300));

  if (btn) { btn.disabled = false; btn.textContent = '🔄 Verificar mudanças agora'; }
  if (statusEl) {
    statusEl.innerHTML = `Verificado em ${new Date().toLocaleString('pt-BR')} — ${ok} item(ns) ok${erros ? `, ${erros} com erro` : ''}.` +
      (errosDetalhe.length ? `<br><span style="color:#dc2626;">${errosDetalhe.map(e => '⚠️ ' + e).join('<br>')}</span>` : '');
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
    <thead><tr style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;">
      <th style="text-align:left;padding:6px 8px;">Quando</th><th style="text-align:left;padding:6px 8px;">Anúncio</th><th style="text-align:right;padding:6px 8px;">De</th><th style="text-align:right;padding:6px 8px;">Para</th>
    </tr></thead>
    <tbody>${logArr.slice(0, 60).map(l => `<tr style="border-top:1px solid var(--border);">
      <td style="padding:6px 8px;font-size:12px;color:var(--text-muted);white-space:nowrap;">${fmtQuando(l.quando)}</td>
      <td style="padding:6px 8px;font-size:12px;">${l.apelido}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;color:var(--text-muted);">${l.de}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;font-weight:600;">${l.para}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

if (typeof Router !== 'undefined') {
  Router.register('rastreamento', renderPage);
}

})();
