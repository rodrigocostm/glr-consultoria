// ============================================================
// GLR Consultoria — Central de ADS
// ============================================================

(function() {

const ADS_CACHE_KEY = 'glr_ads_cache';
const ADS_CACHE_VER = 1;

let contasSel   = [];   // contas carregadas
let contaAtual  = null; // conta selecionada
let mesSel      = new Date().getMonth();
let anoSel      = new Date().getFullYear();
let dadosADS    = null; // dados carregados
let carregando  = false;

// ─── Helpers ─────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');

function periodoAtual() {
  const hoje   = new Date();
  const mesAtual = mesSel === hoje.getMonth() && anoSel === hoje.getFullYear();
  const ontem  = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
  const primeiroDia = `${anoSel}-${pad(mesSel + 1)}-01`;
  const ultimoDia  = mesAtual
    ? `${anoSel}-${pad(mesSel + 1)}-${pad(ontem.getDate())}`
    : `${anoSel}-${pad(mesSel + 1)}-${pad(new Date(anoSel, mesSel + 1, 0).getDate())}`;
  return { primeiroDia, ultimoDia };
}

function fmt(v) {
  return (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtN(v, dec = 0) {
  return (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function nomeMes(m, a) {
  return new Date(a, m, 1).toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
}

function statusBadge(ativo) {
  return ativo
    ? `<span style="background:#dcfce7;color:#16a34a;padding:2px 10px;border-radius:99px;font-size:11px;font-weight:600;">Ativa</span>`
    : `<span style="background:#fee2e2;color:#dc2626;padding:2px 10px;border-radius:99px;font-size:11px;font-weight:600;">Pausada</span>`;
}

// ─── Cache ────────────────────────────────────────────────────
function cacheKey() {
  const c = contaAtual;
  return `${ADS_CACHE_KEY}_${c?.id||c?.external_id}_${anoSel}_${mesSel}`;
}

function lerCache() {
  try {
    const raw = localStorage.getItem(cacheKey());
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c.ver !== ADS_CACHE_VER) return null;
    if (Date.now() - c.at > 15 * 60 * 1000) return null; // 15 min
    return c.dados;
  } catch { return null; }
}

function salvarCache(dados) {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({ ver: ADS_CACHE_VER, at: Date.now(), dados }));
  } catch {}
}

// ─── Busca de dados ───────────────────────────────────────────
async function buscarDados(forcar = false) {
  if (!contaAtual) return;
  if (carregando) return;

  if (!forcar) {
    const cache = lerCache();
    if (cache) { dadosADS = cache; renderConteudo(); return; }
  }

  carregando = true;
  renderLoading();

  const { primeiroDia, ultimoDia } = periodoAtual();
  const mp = contaAtual.marketplace;

  try {
    let resultado = {
      marketplace: mp,
      conta: contaAtual.nickname || contaAtual.name,
      periodo: { de: primeiroDia, ate: ultimoDia },
      resumo: { investimento: 0, cliques: 0, impressoes: 0, pedidos: 0, receita: 0 },
      campanhas: [],
      diario: [],
      saldo: 0,
    };

    if (mp === 'shopee') {
      const shopId = contaAtual.param_to_use?.shopId || contaAtual.external_id;
      resultado._erros = [];

      // Shopee ADS exige formato DD-MM-YYYY
      const toShopeeDate = iso => iso.split('-').reverse().join('-');
      const sdFrom = toShopeeDate(primeiroDia);
      const sdTo   = toShopeeDate(ultimoDia);

      // Busca paralela: diário + campanhas + saldo
      const [perfResp, campResp, balResp] = await Promise.allSettled([
        MarketplaceAPI.shopeeAdsDailyPerformance({ shopId, start_date: sdFrom, end_date: sdTo }),
        MarketplaceAPI.shopeeAdsCampaigns({ shopId }),
        MarketplaceAPI.shopeeAdsBalance({ shopId }),
      ]);

      // Diário
      if (perfResp.status === 'fulfilled') {
        const r = perfResp.value;
        resultado._rawPerf = r; // guarda raw para diagnóstico
        // Tenta todas as estruturas possíveis de resposta
        const dias = r?.data?.response?.daily_performance_list
          || r?.data?.response
          || r?.data?.data
          || r?.data
          || r?.response
          || [];
        if (Array.isArray(dias) && dias.length > 0) {
          resultado.diario = dias.map(d => ({
            data:       d.date || d.day || d.report_time || '',
            gasto:      parseFloat(d.expense) || parseFloat(d.cost) || parseFloat(d.total_cost) || 0,
            cliques:    parseInt(d.clicks) || parseInt(d.click) || 0,
            impressoes: parseInt(d.impressions) || parseInt(d.impression) || 0,
            pedidos:    parseInt(d.orders) || parseInt(d.conversions) || parseInt(d.order_count) || 0,
            receita:    parseFloat(d.gmv) || parseFloat(d.revenue) || parseFloat(d.gmv_from_ads) || 0,
          }));
          resultado.resumo.investimento = resultado.diario.reduce((s, d) => s + d.gasto, 0);
          resultado.resumo.cliques      = resultado.diario.reduce((s, d) => s + d.cliques, 0);
          resultado.resumo.impressoes   = resultado.diario.reduce((s, d) => s + d.impressoes, 0);
          resultado.resumo.pedidos      = resultado.diario.reduce((s, d) => s + d.pedidos, 0);
          resultado.resumo.receita      = resultado.diario.reduce((s, d) => s + d.receita, 0);
        } else {
          resultado._erros.push(`Daily Performance: API retornou estrutura inesperada — ${JSON.stringify(r).slice(0, 200)}`);
        }
      } else {
        resultado._erros.push(`Daily Performance falhou: ${perfResp.reason?.message || perfResp.reason}`);
      }

      // Campanhas
      if (campResp.status === 'fulfilled') {
        const camps = campResp.value;
        resultado._rawCamps = camps;
        const campList = camps?.campaign_list || camps?.data?.campaign_list || camps?.data?.response?.campaign_list || (Array.isArray(camps) ? camps : null);
        if (Array.isArray(campList) && campList.length > 0) {
          resultado.campanhas = campList.map(c => ({
            id:         c.campaign_id || c.id,
            nome:       c.campaign_name || c.name || `Campanha ${c.campaign_id || c.id}`,
            tipo:       c.ad_type || c.campaign_type || c.type || '',
            ativa:      c.state === 'ongoing' || c.status === 'active' || c.is_active,
            orcamento:  parseFloat(c.daily_budget) || parseFloat(c.budget) || 0,
            gasto:      parseFloat(c.expense) || parseFloat(c.cost) || 0,
            cliques:    parseInt(c.clicks) || 0,
            impressoes: parseInt(c.impressions) || 0,
            pedidos:    parseInt(c.orders) || parseInt(c.conversions) || 0,
            receita:    parseFloat(c.gmv) || parseFloat(c.revenue) || 0,
          }));
        } else if (!campList) {
          resultado._erros.push(`Campanhas: formato inesperado — ${JSON.stringify(camps).slice(0, 200)}`);
        }
      }

      // Saldo
      if (balResp.status === 'fulfilled') {
        const b = balResp.value;
        resultado.saldo = parseFloat(b?.data?.balance) || parseFloat(b?.data?.current_balance) || parseFloat(b?.data?.response?.balance) || 0;
      } else {
        resultado._erros.push(`Saldo ADS falhou: ${balResp.reason?.message || balResp.reason}`);
      }

    } else if (['mercadolivre', 'ml', 'meli'].includes(mp)) {
      const meliId = contaAtual.param_to_use?.meliUserId || contaAtual.external_id;

      const [campResp] = await Promise.allSettled([
        MarketplaceAPI.mlAdsCampaigns({ meliUserId: meliId, date_from: primeiroDia, date_to: ultimoDia }),
      ]);

      if (campResp.status === 'fulfilled') {
        const camps = Array.isArray(campResp.value) ? campResp.value : [];
        resultado.campanhas = camps.map(c => ({
          id:         c.id,
          nome:       c.name || `Campanha ${c.id}`,
          tipo:       c.type || '',
          ativa:      c.status === 'active' || c.status === 'enabled',
          orcamento:  parseFloat(c.daily_budget) || 0,
          gasto:      parseFloat(c.cost) || parseFloat(c.spend) || 0,
          cliques:    parseInt(c.clicks) || 0,
          impressoes: parseInt(c.impressions) || 0,
          pedidos:    parseInt(c.orders) || parseInt(c.conversions) || 0,
          receita:    parseFloat(c.revenue) || 0,
        }));
        resultado.resumo.investimento = resultado.campanhas.reduce((s, c) => s + c.gasto, 0);
        resultado.resumo.cliques      = resultado.campanhas.reduce((s, c) => s + c.cliques, 0);
        resultado.resumo.impressoes   = resultado.campanhas.reduce((s, c) => s + c.impressoes, 0);
        resultado.resumo.pedidos      = resultado.campanhas.reduce((s, c) => s + c.pedidos, 0);
        resultado.resumo.receita      = resultado.campanhas.reduce((s, c) => s + c.receita, 0);
      }
    }

    dadosADS = resultado;
    salvarCache(resultado);
    renderConteudo();
  } catch(e) {
    renderErro(e.message);
  } finally {
    carregando = false;
  }
}

// ─── Render principal ─────────────────────────────────────────
function renderPage(params, container) {
  container.innerHTML = `
    <div id="ads-root" style="padding:24px;max-width:1400px;margin:0 auto;"></div>
  `;
  renderShell();
  carregarContas();
}

function renderShell() {
  const root = document.getElementById('ads-root');
  if (!root) return;

  const meses = [];
  const hoje = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    meses.push({ v: `${d.getMonth()}_${d.getFullYear()}`, l: nomeMes(d.getMonth(), d.getFullYear()) });
  }

  root.innerHTML = `
    <!-- Cabeçalho -->
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:24px;">
      <div>
        <h2 style="font-size:20px;font-weight:700;color:var(--text-primary);margin:0;">📢 Central de ADS</h2>
        <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 0;">Gerencie e otimize suas campanhas de anúncios</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <select id="ads-sel-mes" class="form-input" style="border-radius:99px;padding:7px 14px;">
          ${meses.map(m => `<option value="${m.v}" ${m.v===`${mesSel}_${anoSel}`?'selected':''}>${m.l}</option>`).join('')}
        </select>
        <select id="ads-sel-conta" class="form-input" style="border-radius:99px;padding:7px 14px;min-width:160px;">
          <option value="">Carregando contas...</option>
        </select>
        <button id="ads-btn-atualizar" onclick="window._adsAtualizar()" style="background:var(--primary);color:#fff;border:none;border-radius:99px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;">
          🔄 Atualizar
        </button>
      </div>
    </div>

    <!-- Conteúdo dinâmico -->
    <div id="ads-body">
      <div style="text-align:center;padding:80px;color:var(--text-secondary);">
        <div style="font-size:48px;margin-bottom:12px;">📢</div>
        <div style="font-size:16px;font-weight:600;">Selecione uma conta para ver os dados de ADS</div>
      </div>
    </div>
  `;

  // Eventos
  document.getElementById('ads-sel-mes').addEventListener('change', e => {
    const [m, a] = e.target.value.split('_');
    mesSel = parseInt(m); anoSel = parseInt(a);
    buscarDados(false);
  });

  window._adsAtualizar = () => buscarDados(true);
}

async function carregarContas() {
  try {
    const raw = localStorage.getItem('glr_mc_accounts');
    let contas = raw ? JSON.parse(raw) : [];
    if (!contas.length) {
      contas = await MarketplaceAPI.listAccounts();
      localStorage.setItem('glr_mc_accounts', JSON.stringify(contas));
    }
    contasSel = contas.filter(c => ['shopee','mercadolivre','ml','meli'].includes(c.marketplace));

    const sel = document.getElementById('ads-sel-conta');
    if (!sel) return;
    sel.innerHTML = `<option value="">— Selecione a conta —</option>` +
      contasSel.map((c, i) => {
        const mp = c.marketplace === 'shopee' ? '🟠 Shopee' : '🟡 ML';
        return `<option value="${i}">${mp} — ${c.nickname || c.name || c.external_id}</option>`;
      }).join('');

    sel.addEventListener('change', e => {
      const idx = parseInt(e.target.value);
      contaAtual = isNaN(idx) ? null : contasSel[idx];
      dadosADS = null;
      if (contaAtual) buscarDados(false);
    });
  } catch(e) {
    console.warn('[ADS] Erro ao carregar contas:', e.message);
  }
}

// ─── Loading & Erro ───────────────────────────────────────────
function renderLoading() {
  const body = document.getElementById('ads-body');
  if (!body) return;
  body.innerHTML = `
    <div style="text-align:center;padding:80px;color:var(--text-secondary);">
      <div style="font-size:32px;margin-bottom:16px;animation:spin 1s linear infinite;display:inline-block;">⟳</div>
      <div style="font-size:15px;font-weight:600;">Buscando dados de ADS...</div>
      <div style="font-size:13px;margin-top:8px;">Isso pode levar alguns segundos</div>
    </div>
    <style>@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}</style>
  `;
}

function renderErro(msg) {
  const body = document.getElementById('ads-body');
  if (!body) return;
  body.innerHTML = `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:24px;text-align:center;color:#dc2626;">
      <div style="font-size:28px;margin-bottom:8px;">⚠️</div>
      <div style="font-weight:600;font-size:15px;">Erro ao buscar dados de ADS</div>
      <div style="font-size:13px;margin-top:8px;">${msg}</div>
      <button onclick="window._adsAtualizar()" style="margin-top:16px;background:#dc2626;color:#fff;border:none;border-radius:99px;padding:8px 20px;cursor:pointer;font-weight:600;">Tentar novamente</button>
    </div>
  `;
}

// ─── Render conteúdo ──────────────────────────────────────────
function renderConteudo() {
  const body = document.getElementById('ads-body');
  if (!body || !dadosADS) return;

  const d = dadosADS;
  const inv = d.resumo.investimento;
  const rec = d.resumo.receita;
  const cli = d.resumo.cliques;
  const imp = d.resumo.impressoes;
  const ped = d.resumo.pedidos;

  const roas    = inv > 0 ? rec / inv : 0;
  const ctr     = imp > 0 ? (cli / imp) * 100 : 0;
  const cpc     = cli > 0 ? inv / cli : 0;
  const acos    = rec > 0 ? (inv / rec) * 100 : 0;
  const cpa     = ped > 0 ? inv / ped : 0;

  // Mostra erros de API diretamente na tela
  const erros = d._erros || [];
  const blocoErros = erros.length > 0 ? `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:16px;margin-bottom:20px;">
      <div style="font-weight:700;font-size:13px;color:#92400e;margin-bottom:8px;">⚠️ Erros ao buscar dados da API (${erros.length})</div>
      ${erros.map(e => `<div style="font-size:12px;color:#78350f;padding:4px 0;border-bottom:1px solid #fde68a;word-break:break-all;">${e}</div>`).join('')}
    </div>
  ` : '';

  body.innerHTML = blocoErros + `
    <!-- KPIs principais -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px;">
      ${kpiCard('💰 Investimento', fmt(inv), '', '#f0f9ff', '#0ea5e9')}
      ${kpiCard('📈 Receita ADS', fmt(rec), '', '#f0fdf4', '#16a34a')}
      ${kpiCard('🎯 ROAS', fmtN(roas, 2) + 'x', roas >= 3 ? '✅ Bom' : roas >= 1.5 ? '⚠️ Regular' : '❌ Baixo', roas >= 3 ? '#f0fdf4' : roas >= 1.5 ? '#fffbeb' : '#fef2f2', roas >= 3 ? '#16a34a' : roas >= 1.5 ? '#d97706' : '#dc2626')}
      ${kpiCard('📊 ACoS', fmtN(acos, 1) + '%', acos <= 30 ? '✅ Bom' : acos <= 50 ? '⚠️ Regular' : '❌ Alto', acos <= 30 ? '#f0fdf4' : acos <= 50 ? '#fffbeb' : '#fef2f2', acos <= 30 ? '#16a34a' : acos <= 50 ? '#d97706' : '#dc2626')}
      ${kpiCard('🖱️ Cliques', fmtN(cli), '', '#faf5ff', '#9333ea')}
      ${kpiCard('👁️ Impressões', fmtN(imp), '', '#fff7ed', '#ea580c')}
      ${kpiCard('📉 CTR', fmtN(ctr, 2) + '%', '', '#f0f9ff', '#0284c7')}
      ${kpiCard('💵 CPC Médio', fmt(cpc), '', '#fdf4ff', '#c026d3')}
      ${d.saldo > 0 ? kpiCard('🏦 Saldo ADS', fmt(d.saldo), '', '#f0fdf4', '#15803d') : ''}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;">
      <!-- Gráfico diário -->
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;">
        <h3 style="font-size:14px;font-weight:700;margin:0 0 16px;color:var(--text-primary);">📅 Gasto Diário</h3>
        ${renderGraficoDiario(d.diario)}
      </div>

      <!-- Métricas de eficiência -->
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;">
        <h3 style="font-size:14px;font-weight:700;margin:0 0 16px;color:var(--text-primary);">🎯 Eficiência das Campanhas</h3>
        ${renderEficiencia(d)}
      </div>
    </div>

    <!-- Tabela de campanhas -->
    <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 style="font-size:14px;font-weight:700;margin:0;color:var(--text-primary);">🗂️ Campanhas (${d.campanhas.length})</h3>
        <div style="display:flex;gap:8px;">
          <span style="font-size:12px;color:var(--text-secondary);">Ordenado por investimento</span>
        </div>
      </div>
      ${renderTabelaCampanhas(d.campanhas)}
    </div>

    <!-- Sugestões de otimização -->
    ${renderOtimizacoes(d)}
  `;
}

function kpiCard(titulo, valor, sub, bg, cor) {
  return `
    <div style="background:${bg};border:1px solid ${cor}22;border-radius:12px;padding:16px;">
      <div style="font-size:11px;font-weight:600;color:${cor};text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">${titulo}</div>
      <div style="font-size:22px;font-weight:700;color:var(--text-primary);">${valor}</div>
      ${sub ? `<div style="font-size:11px;margin-top:4px;color:${cor};">${sub}</div>` : ''}
    </div>
  `;
}

function renderGraficoDiario(diario) {
  if (!diario || diario.length === 0) {
    return `<div style="text-align:center;padding:40px;color:var(--text-secondary);font-size:13px;">Sem dados diários disponíveis</div>`;
  }

  const maxGasto = Math.max(...diario.map(d => d.gasto), 0.01);
  const bars = diario.slice(-30).map(d => {
    const pct = Math.max((d.gasto / maxGasto) * 100, 1);
    const dataFmt = d.data ? d.data.slice(5) : '';
    return `
      <div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1;min-width:0;" title="${dataFmt}: ${fmt(d.gasto)}">
        <div style="width:100%;background:var(--primary);border-radius:3px 3px 0 0;height:${pct}%;min-height:2px;opacity:0.85;"></div>
        ${diario.length <= 15 ? `<div style="font-size:9px;color:var(--text-secondary);writing-mode:vertical-lr;transform:rotate(180deg);">${dataFmt}</div>` : ''}
      </div>
    `;
  }).join('');

  return `
    <div style="display:flex;align-items:flex-end;gap:2px;height:140px;padding-bottom:4px;">
      ${bars}
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:var(--text-secondary);">
      <span>${diario[0]?.data?.slice(5) || ''}</span>
      <span>Total: ${fmt(diario.reduce((s, d) => s + d.gasto, 0))}</span>
      <span>${diario[diario.length - 1]?.data?.slice(5) || ''}</span>
    </div>
  `;
}

function renderEficiencia(d) {
  const inv  = d.resumo.investimento;
  const rec  = d.resumo.receita;
  const roas = inv > 0 ? rec / inv : 0;
  const acos = rec > 0 ? (inv / rec) * 100 : 0;
  const ctr  = d.resumo.impressoes > 0 ? (d.resumo.cliques / d.resumo.impressoes) * 100 : 0;
  const cpc  = d.resumo.cliques > 0 ? inv / d.resumo.cliques : 0;
  const cpa  = d.resumo.pedidos > 0 ? inv / d.resumo.pedidos : 0;

  const metrica = (icon, nome, valor, meta, atingido) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:16px;">${icon}</span>
        <span style="font-size:13px;color:var(--text-secondary);">${nome}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:14px;font-weight:700;color:var(--text-primary);">${valor}</span>
        <span style="font-size:11px;">${atingido}</span>
      </div>
    </div>
  `;

  return `
    <div>
      ${metrica('🎯', 'ROAS', fmtN(roas, 2) + 'x', '≥ 3x', roas >= 3 ? '✅' : roas >= 1.5 ? '⚠️' : '❌')}
      ${metrica('📊', 'ACoS', fmtN(acos, 1) + '%', '≤ 30%', acos <= 30 ? '✅' : acos <= 50 ? '⚠️' : '❌')}
      ${metrica('🖱️', 'CTR', fmtN(ctr, 2) + '%', '≥ 1%', ctr >= 1 ? '✅' : ctr >= 0.5 ? '⚠️' : '❌')}
      ${metrica('💵', 'CPC Médio', fmt(cpc), '', '')}
      ${metrica('🛒', 'CPA (Custo/Pedido)', fmt(cpa), '', '')}
      ${metrica('💰', 'Investimento Total', fmt(inv), '', '')}
    </div>
  `;
}

function renderTabelaCampanhas(campanhas) {
  if (!campanhas || campanhas.length === 0) {
    return `<div style="text-align:center;padding:32px;color:var(--text-secondary);font-size:13px;">Nenhuma campanha encontrada neste período</div>`;
  }

  const ordenadas = [...campanhas].sort((a, b) => b.gasto - a.gasto);

  const linhas = ordenadas.map(c => {
    const roas = c.gasto > 0 && c.receita > 0 ? c.receita / c.gasto : 0;
    const acos = c.receita > 0 ? (c.gasto / c.receita) * 100 : 0;
    const ctr  = c.impressoes > 0 ? (c.cliques / c.impressoes) * 100 : 0;

    const roasCor = roas >= 3 ? '#16a34a' : roas >= 1.5 ? '#d97706' : roas > 0 ? '#dc2626' : 'var(--text-secondary)';

    return `
      <tr>
        <td style="padding:10px 12px;font-size:13px;font-weight:600;color:var(--text-primary);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.nome}</td>
        <td style="padding:10px 12px;font-size:12px;color:var(--text-secondary);">${c.tipo || '—'}</td>
        <td style="padding:10px 12px;">${statusBadge(c.ativa)}</td>
        <td style="padding:10px 12px;font-size:13px;font-weight:600;color:var(--text-primary);text-align:right;">${fmt(c.gasto)}</td>
        <td style="padding:10px 12px;font-size:13px;text-align:right;color:var(--text-secondary);">${fmtN(c.cliques)}</td>
        <td style="padding:10px 12px;font-size:13px;text-align:right;color:var(--text-secondary);">${fmtN(c.impressoes)}</td>
        <td style="padding:10px 12px;font-size:13px;text-align:right;color:var(--text-secondary);">${fmtN(ctr, 2)}%</td>
        <td style="padding:10px 12px;font-size:13px;font-weight:700;text-align:right;color:${roasCor};">${roas > 0 ? fmtN(roas, 2) + 'x' : '—'}</td>
        <td style="padding:10px 12px;font-size:13px;text-align:right;color:var(--text-secondary);">${acos > 0 ? fmtN(acos, 1) + '%' : '—'}</td>
      </tr>
    `;
  }).join('');

  return `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:var(--bg-base);">
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:left;text-transform:uppercase;">Campanha</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:left;text-transform:uppercase;">Tipo</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:left;text-transform:uppercase;">Status</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">Investido</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">Cliques</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">Impressões</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">CTR</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">ROAS</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">ACoS</th>
          </tr>
        </thead>
        <tbody>
          ${linhas}
        </tbody>
      </table>
    </div>
  `;
}

function renderOtimizacoes(d) {
  const sugestoes = [];

  const inv  = d.resumo.investimento;
  const rec  = d.resumo.receita;
  const roas = inv > 0 ? rec / inv : 0;
  const acos = rec > 0 ? (inv / rec) * 100 : 0;
  const ctr  = d.resumo.impressoes > 0 ? (d.resumo.cliques / d.resumo.impressoes) * 100 : 0;

  if (roas > 0 && roas < 1.5)
    sugestoes.push({ icon: '❌', cor: '#dc2626', bg: '#fef2f2', titulo: 'ROAS crítico', desc: `ROAS de ${fmtN(roas,2)}x está muito abaixo do ideal (≥3x). Revise os produtos anunciados e ajuste os lances para produtos de maior margem.` });
  else if (roas < 3)
    sugestoes.push({ icon: '⚠️', cor: '#d97706', bg: '#fffbeb', titulo: 'ROAS pode melhorar', desc: `ROAS de ${fmtN(roas,2)}x está abaixo do ideal. Considere pausar campanhas com baixo retorno e aumentar budget nas mais rentáveis.` });

  if (acos > 50)
    sugestoes.push({ icon: '⚠️', cor: '#d97706', bg: '#fffbeb', titulo: 'ACoS elevado', desc: `ACoS de ${fmtN(acos,1)}% significa que você gasta R$${fmtN(acos/100,2)} para cada R$1 gerado. Reduza lances ou filtre produtos com baixa conversão.` });

  if (ctr > 0 && ctr < 0.5)
    sugestoes.push({ icon: '📉', cor: '#7c3aed', bg: '#faf5ff', titulo: 'CTR muito baixo', desc: `CTR de ${fmtN(ctr,2)}% indica que os anúncios não estão atraentes. Melhore as imagens principais, títulos e preços dos produtos anunciados.` });

  const campPausadas = d.campanhas.filter(c => !c.ativa).length;
  if (campPausadas > 0)
    sugestoes.push({ icon: '⏸️', cor: '#64748b', bg: '#f8fafc', titulo: `${campPausadas} campanha(s) pausada(s)`, desc: `Você tem campanhas pausadas. Verifique se elas foram pausadas intencionalmente ou se precisam ser reativadas.` });

  if (d.saldo > 0 && d.saldo < inv * 0.3)
    sugestoes.push({ icon: '🏦', cor: '#dc2626', bg: '#fef2f2', titulo: 'Saldo ADS baixo', desc: `Saldo de ${fmt(d.saldo)} pode interromper as campanhas. Recarregue o saldo para garantir continuidade dos anúncios.` });

  if (sugestoes.length === 0) {
    if (inv === 0) return '';
    sugestoes.push({ icon: '✅', cor: '#16a34a', bg: '#f0fdf4', titulo: 'Campanhas saudáveis', desc: `As métricas estão dentro dos parâmetros ideais. Continue monitorando para manter a performance.` });
  }

  return `
    <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;">
      <h3 style="font-size:14px;font-weight:700;margin:0 0 16px;color:var(--text-primary);">💡 Sugestões de Otimização</h3>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${sugestoes.map(s => `
          <div style="background:${s.bg};border-left:4px solid ${s.cor};border-radius:0 8px 8px 0;padding:12px 16px;display:flex;gap:12px;align-items:flex-start;">
            <span style="font-size:20px;flex-shrink:0;">${s.icon}</span>
            <div>
              <div style="font-size:13px;font-weight:700;color:${s.cor};margin-bottom:4px;">${s.titulo}</div>
              <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">${s.desc}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ─── Registro da rota ─────────────────────────────────────────
if (typeof Router !== 'undefined') {
  Router.register('ads', renderPage);
}

})();
