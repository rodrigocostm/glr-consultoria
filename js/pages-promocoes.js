// ============================================================
// GLR Consultoria — Central de Promoções
// Primeira versão: só Mercado Livre (Shopee fica pra depois).
// ============================================================
(function() {

let contasSel  = [];   // contas ML carregadas
let contaAtual = null; // conta selecionada
let promocoes  = [];   // últimas promoções buscadas

function renderPage(params, container) {
  container.innerHTML = `<div id="promo-root" style="padding:24px;max-width:1200px;margin:0 auto;"></div>`;
  renderShell();
  carregarContas();
}

function renderShell() {
  const root = document.getElementById('promo-root');
  if (!root) return;
  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:24px;">
      <div>
        <h2 style="font-size:20px;font-weight:700;color:var(--text-primary);margin:0;">🏷️ Central de Promoções</h2>
        <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 0;">Mercado Livre — promoções ativas, desconto em item e cupom de vendedor</p>
      </div>
      <select id="promo-sel-conta" class="form-input" style="border-radius:99px;padding:7px 14px;min-width:200px;">
        <option value="">Carregando contas...</option>
      </select>
    </div>

    <div id="promo-body">
      <div style="text-align:center;padding:80px;color:var(--text-secondary);">
        <div style="font-size:48px;margin-bottom:12px;">🏷️</div>
        <div style="font-size:16px;font-weight:600;">Selecione uma conta Mercado Livre</div>
      </div>
    </div>
  `;
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
    contasSel = contas.filter(c => ['mercadolivre','ml','meli'].includes(c.marketplace));

    const nicks = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();
    const nomeConta = c => {
      const tag = c.tags?.[0]?.name || '';
      return nicks[c.external_id] || tag || c.nickname || c.name || c.external_id;
    };

    const sel = document.getElementById('promo-sel-conta');
    if (!sel) return;
    sel.innerHTML = `<option value="">— Selecione a conta —</option>` +
      contasSel.map((c, i) => `<option value="${i}">🟡 ${nomeConta(c)}</option>`).join('');

    sel.addEventListener('change', e => {
      const idx = parseInt(e.target.value);
      contaAtual = isNaN(idx) ? null : contasSel[idx];
      if (contaAtual) {
        try { localStorage.setItem('glr_promo_ultima_conta', contaAtual.external_id); } catch(e2) {}
        buscarPromocoes();
      } else {
        renderVazio();
      }
    });

    try {
      const ultimaId = localStorage.getItem('glr_promo_ultima_conta');
      if (ultimaId) {
        const idx = contasSel.findIndex(c => String(c.external_id) === String(ultimaId));
        if (idx >= 0) {
          sel.value = String(idx);
          contaAtual = contasSel[idx];
          buscarPromocoes();
        }
      }
    } catch(e2) {}
  } catch(e) {
    console.warn('[Promo] Erro ao carregar contas:', e.message);
  }
}

function renderVazio() {
  const body = document.getElementById('promo-body');
  if (!body) return;
  body.innerHTML = `
    <div style="text-align:center;padding:80px;color:var(--text-secondary);">
      <div style="font-size:48px;margin-bottom:12px;">🏷️</div>
      <div style="font-size:16px;font-weight:600;">Selecione uma conta Mercado Livre</div>
    </div>`;
}

function fmtData(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR');
}

function fmtR(v) {
  return (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const TIPO_LABEL = {
  LIGHTNING: 'Oferta Relâmpago', BANK: 'Desconto no Pagamento', PRICE_MATCHING: 'Price Matching',
  SMART: 'Oferta Inteligente', DEAL: 'Oferta do Dia', SELLER_CAMPAIGN: 'Campanha Própria',
  SELLER_COUPON_CAMPAIGN: 'Cupom Próprio', PRICE_DISCOUNT: 'Desconto de Preço', DOD: 'Deal of the Day',
  MARKETPLACE_CAMPAIGN: 'Campanha do ML',
};

async function buscarPromocoes() {
  const body = document.getElementById('promo-body');
  if (!body || !contaAtual) return;
  body.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);">
    <div style="font-size:32px;margin-bottom:12px;animation:spin 1s linear infinite;display:inline-block;">⟳</div>
    <div style="font-size:15px;font-weight:600;">Buscando promoções...</div>
  </div>
  <style>@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}</style>`;

  const meliId = contaAtual.param_to_use?.meliUserId || contaAtual.external_id;
  try {
    const r = await MarketplaceAPI.call('ml_list_promotions', { meliUserId: meliId, limit: 50 });
    promocoes = r?.data?.results || r?.results || [];
  } catch(e) {
    promocoes = [];
    body.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:24px;text-align:center;color:#dc2626;">
      <div style="font-weight:600;">Erro ao buscar promoções: ${e.message}</div>
    </div>`;
    return;
  }
  renderConteudo();
}

function renderConteudo() {
  const body = document.getElementById('promo-body');
  if (!body) return;

  const ativas = promocoes.filter(p => p.status === 'started' || p.status === 'candidate');
  const outras = promocoes.filter(p => !(p.status === 'started' || p.status === 'candidate'));

  const linhaPromo = p => `
    <div class="card" style="padding:16px 18px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="font-size:14px;font-weight:700;color:var(--text-primary);">${p.name || p.id}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">
            ${TIPO_LABEL[p.type] || p.type}${p.sub_type ? ' · ' + p.sub_type : ''} · ${fmtData(p.start_date)} → ${fmtData(p.finish_date)}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="badge ${p.status==='started'?'badge-green':'badge-yellow'}" style="font-size:11px;">${p.status==='started'?'ativa':p.status}</span>
          <button class="btn btn-secondary btn-sm" onclick="window._promoVerItens('${p.id}','${p.type}')">Ver itens</button>
        </div>
      </div>
      <div id="promo-itens-${p.id.replace(/[^a-zA-Z0-9]/g,'')}" style="margin-top:10px;"></div>
    </div>`;

  body.innerHTML = `
    <!-- Promoções ativas -->
    <div style="margin-bottom:28px;">
      <div class="section-title" style="font-size:15px;margin-bottom:12px;">📣 Promoções Ativas (${ativas.length})</div>
      ${ativas.length ? ativas.map(linhaPromo).join('') : `<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:13px;background:var(--bg-card);border-radius:12px;">Nenhuma promoção ativa nessa conta agora.</div>`}
      ${outras.length ? `
        <details style="margin-top:12px;">
          <summary style="cursor:pointer;font-size:12.5px;color:var(--text-secondary);">Ver ${outras.length} encerradas/outras</summary>
          <div style="margin-top:10px;">${outras.map(linhaPromo).join('')}</div>
        </details>` : ''}
    </div>

    <!-- Criar desconto em item -->
    <div class="card" style="padding:20px;margin-bottom:20px;">
      <div class="section-title" style="font-size:15px;margin-bottom:4px;">💸 Criar Desconto em Item</div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:0 0 16px;">Desconto de preço (PRICE_DISCOUNT) pontual num anúncio — até 14 dias de duração.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group">
          <label class="form-label">ID do Anúncio (MLB...)</label>
          <input class="form-input" id="pd-item" placeholder="MLB1234567890">
        </div>
        <div class="form-group">
          <label class="form-label">Preço Promocional (R$)</label>
          <input class="form-input" id="pd-preco" type="number" step="0.01" min="0" placeholder="0,00">
        </div>
        <div class="form-group">
          <label class="form-label">Início</label>
          <input class="form-input" id="pd-inicio" type="datetime-local">
        </div>
        <div class="form-group">
          <label class="form-label">Fim (máx. 14 dias do início)</label>
          <input class="form-input" id="pd-fim" type="datetime-local">
        </div>
      </div>
      <button class="btn btn-primary" style="margin-top:12px;" onclick="window._promoCriarDesconto()">Aplicar Desconto</button>
      <div id="pd-resultado" style="margin-top:10px;font-size:13px;"></div>
    </div>

    <!-- Criar cupom -->
    <div class="card" style="padding:20px;">
      <div class="section-title" style="font-size:15px;margin-bottom:4px;">🎟️ Criar Cupom de Vendedor</div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:0 0 16px;">Cupom válido pra loja inteira, com código próprio.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group" style="grid-column:1/-1;">
          <label class="form-label">Nome do Cupom</label>
          <input class="form-input" id="cp-nome" placeholder="Ex: Black Friday 10%">
        </div>
        <div class="form-group">
          <label class="form-label">Tipo</label>
          <select class="form-select" id="cp-tipo">
            <option value="FIXED_PERCENTAGE">% de desconto</option>
            <option value="FIXED_AMOUNT">R$ fixo de desconto</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Valor</label>
          <input class="form-input" id="cp-valor" type="number" step="0.01" min="0" placeholder="Ex: 10 (para 10%) ou 20.00">
        </div>
        <div class="form-group">
          <label class="form-label">Compra Mínima (R$)</label>
          <input class="form-input" id="cp-minimo" type="number" step="0.01" min="0" placeholder="0,00">
        </div>
        <div class="form-group">
          <label class="form-label">Orçamento Total (R$)</label>
          <input class="form-input" id="cp-orcamento" type="number" step="0.01" min="0" placeholder="0,00">
        </div>
        <div class="form-group">
          <label class="form-label">Usos por Cliente</label>
          <input class="form-input" id="cp-redeems" type="number" min="1" placeholder="1">
        </div>
        <div class="form-group">
          <label class="form-label">Início</label>
          <input class="form-input" id="cp-inicio" type="datetime-local">
        </div>
        <div class="form-group">
          <label class="form-label">Fim</label>
          <input class="form-input" id="cp-fim" type="datetime-local">
        </div>
      </div>
      <button class="btn btn-primary" style="margin-top:12px;" onclick="window._promoCriarCupom()">Criar Cupom</button>
      <div id="cp-resultado" style="margin-top:10px;font-size:13px;"></div>
    </div>
  `;
}

// Formata "2026-09-08T14:30" (datetime-local) pro formato que o ML espera: sem Z, sem offset.
function _promoDataML(inputId) {
  const v = document.getElementById(inputId).value;
  if (!v) return null;
  return v.length === 16 ? v + ':00' : v;
}

window._promoVerItens = async function(promotionId, promotionType) {
  const safeId = promotionId.replace(/[^a-zA-Z0-9]/g,'');
  const el = document.getElementById(`promo-itens-${safeId}`);
  if (!el || !contaAtual) return;
  if (el.dataset.aberto === '1') { el.innerHTML = ''; el.dataset.aberto = '0'; return; }

  el.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);">Carregando itens...</div>`;
  const meliId = contaAtual.param_to_use?.meliUserId || contaAtual.external_id;
  try {
    const r = await MarketplaceAPI.call('ml_promotion_items', { meliUserId: meliId, promotion_id: promotionId, promotion_type: promotionType, limit: 20 });
    const itens = r?.data?.results || r?.results || [];
    if (!itens.length) { el.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);">Nenhum item participante encontrado.</div>`; return; }
    el.innerHTML = `<table style="width:100%;border-collapse:collapse;margin-top:6px;">
      <thead><tr style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;">
        <th style="text-align:left;padding:4px 8px;">Item</th><th style="text-align:right;padding:4px 8px;">De</th><th style="text-align:right;padding:4px 8px;">Por</th><th style="text-align:right;padding:4px 8px;">Desconto</th>
      </tr></thead>
      <tbody>${itens.map(it => {
        const de = it.original_price || 0, por = it.price || 0;
        const desc = de > 0 ? ((1 - por/de) * 100).toFixed(0) : 0;
        return `<tr style="border-top:1px solid var(--border);">
          <td style="padding:4px 8px;font-size:12px;"><a href="https://produto.mercadolivre.com.br/${it.id}" target="_blank" rel="noopener" style="color:var(--primary);">${it.id}</a></td>
          <td style="padding:4px 8px;font-size:12px;text-align:right;color:var(--text-muted);text-decoration:line-through;">${fmtR(de)}</td>
          <td style="padding:4px 8px;font-size:12px;text-align:right;font-weight:600;">${fmtR(por)}</td>
          <td style="padding:4px 8px;font-size:12px;text-align:right;color:var(--green);">-${desc}%</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
    el.dataset.aberto = '1';
  } catch(e) {
    el.innerHTML = `<div style="font-size:12px;color:#dc2626;">Erro: ${e.message}</div>`;
  }
};

window._promoCriarDesconto = async function() {
  if (!contaAtual) { alert('Selecione uma conta primeiro.'); return; }
  const item = document.getElementById('pd-item').value.trim().toUpperCase();
  const preco = parseFloat(document.getElementById('pd-preco').value);
  const inicio = _promoDataML('pd-inicio');
  const fim = _promoDataML('pd-fim');
  const resDiv = document.getElementById('pd-resultado');

  if (!item || !item.startsWith('MLB')) { alert('Informe o ID do anúncio (formato MLB1234567890).'); return; }
  if (!preco || preco <= 0) { alert('Informe o preço promocional.'); return; }
  if (!inicio || !fim) { alert('Informe início e fim do desconto.'); return; }

  resDiv.innerHTML = '⏳ Aplicando desconto...';
  const meliId = contaAtual.param_to_use?.meliUserId || contaAtual.external_id;
  try {
    const r = await MarketplaceAPI.call('ml_add_promotion_items', {
      meliUserId: meliId, promotion_type: 'PRICE_DISCOUNT',
      items: [item], deal_price: preco, start_date: inicio, finish_date: fim,
    });
    const res = r?.data?.results?.[0] || r?.results?.[0];
    if (res?.aplicado) {
      resDiv.innerHTML = `<span style="color:var(--green);">✅ Desconto aplicado — preço efetivo: ${fmtR(res.aplicado.price)} (original ${fmtR(res.aplicado.original_price)})${res.atencao ? '<br><span style="color:#d97706;">⚠️ ' + res.atencao + '</span>' : ''}</span>`;
    } else {
      resDiv.innerHTML = `<span style="color:var(--green);">✅ Desconto enviado.</span>`;
    }
  } catch(e) {
    resDiv.innerHTML = `<span style="color:#dc2626;">❌ Erro: ${e.message}</span>`;
  }
};

window._promoCriarCupom = async function() {
  if (!contaAtual) { alert('Selecione uma conta primeiro.'); return; }
  const nome = document.getElementById('cp-nome').value.trim();
  const tipo = document.getElementById('cp-tipo').value;
  const valor = parseFloat(document.getElementById('cp-valor').value);
  const minimo = parseFloat(document.getElementById('cp-minimo').value) || undefined;
  const orcamento = parseFloat(document.getElementById('cp-orcamento').value) || undefined;
  const redeems = parseInt(document.getElementById('cp-redeems').value) || undefined;
  const inicio = _promoDataML('cp-inicio');
  const fim = _promoDataML('cp-fim');
  const resDiv = document.getElementById('cp-resultado');

  if (!nome) { alert('Informe o nome do cupom.'); return; }
  if (!valor || valor <= 0) { alert('Informe o valor do desconto.'); return; }

  resDiv.innerHTML = '⏳ Criando cupom...';
  const meliId = contaAtual.param_to_use?.meliUserId || contaAtual.external_id;
  const payload = {
    meliUserId: meliId, name: nome, sub_type: tipo,
    min_purchase_amount: minimo, budget: orcamento, redeems_per_user: redeems,
    start_date: inicio, finish_date: fim,
  };
  if (tipo === 'FIXED_PERCENTAGE') payload.fixed_percentage = valor;
  else payload.fixed_amount = valor;

  try {
    const r = await MarketplaceAPI.call('ml_create_coupon', payload);
    const id = r?.data?.id || r?.id;
    resDiv.innerHTML = `<span style="color:var(--green);">✅ Cupom criado${id ? ' — ID ' + id : ''}.</span>`;
  } catch(e) {
    resDiv.innerHTML = `<span style="color:#dc2626;">❌ Erro: ${e.message}</span>`;
  }
};

if (typeof Router !== 'undefined') {
  Router.register('promocoes', renderPage);
}

})();
