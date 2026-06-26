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
let _aiHistory   = [];
let _aiCarregando = false;

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
            pedidos:    parseInt(d.broad_order) || parseInt(d.direct_order) || parseInt(d.order_count) || parseInt(d.orders) || 0,
            receita:    parseFloat(d.broad_gmv) || parseFloat(d.direct_gmv) || parseFloat(d.order_amount)
                     || parseFloat(d.gmv_from_ads) || parseFloat(d.gmv) || parseFloat(d.revenue) || 0,
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

      // Campanhas — busca somente ativas via state_filter, depois performance
      const [campAtivasResp] = await Promise.allSettled([
        MarketplaceAPI.call('shopee_ads_campaigns', { shopId, state_filter: 'ongoing' })
      ]);

      const campsRaw = campAtivasResp.status === 'fulfilled' ? campAtivasResp.value : (campResp.status === 'fulfilled' ? campResp.value : null);
      const campList = campsRaw?.data?.response?.campaign_list || campsRaw?.data?.campaign_list || campsRaw?.campaign_list || (Array.isArray(campsRaw?.data) ? campsRaw.data : []);

      if (Array.isArray(campList) && campList.length > 0) {
        const LOTE = 20;
        const cfgMap  = {}; // campaign_id → common_info
        const perfMap = {}; // campaign_id → métricas somadas

        // Busca settings e performance em paralelo, em lotes de 20
        for (let i = 0; i < campList.length; i += LOTE) {
          const ids = campList.slice(i, i + LOTE).map(c => c.campaign_id || c.id);
          const [cfgRes, perfRes] = await Promise.allSettled([
            MarketplaceAPI.call('shopee_ads_campaign_settings', { shopId, campaign_id_list: ids }),
            MarketplaceAPI.call('shopee_ads_campaign_daily',    { shopId, campaign_id_list: ids, start_date: sdFrom, end_date: sdTo }),
          ]);

          // Settings → cfgMap (inclui auto_bidding_info para roas_target)
          if (cfgRes.status === 'fulfilled') {
            const lista = cfgRes.value?.data?.response?.campaign_list || [];
            lista.forEach(c => {
              cfgMap[c.campaign_id] = {
                ...(c.common_info || {}),
                roas_target:    c.auto_bidding_info?.roas_target ?? null,
                bidding_method: c.common_info?.bidding_method || 'manual',
              };
            });
          }

          // Daily → perfMap (soma todas as métricas do período)
          if (perfRes.status === 'fulfilled') {
            const lista = perfRes.value?.data?.response?.campaign_list || [];
            lista.forEach(c => {
              const dias = c.metrics_list || [];
              perfMap[c.campaign_id] = {
                nome:       c.ad_name || '',
                gasto:      dias.reduce((s, d) => s + (parseFloat(d.expense) || 0), 0),
                cliques:    dias.reduce((s, d) => s + (parseInt(d.clicks) || 0), 0),
                impressoes: dias.reduce((s, d) => s + (parseInt(d.impression) || 0), 0),
                pedidos:    dias.reduce((s, d) => s + (parseInt(d.broad_order) || 0), 0),
                receita:    dias.reduce((s, d) => s + (parseFloat(d.broad_gmv) || 0), 0),
              };
            });
          }
        }

        resultado.campanhas = campList.map(c => {
          const cid  = c.campaign_id || c.id;
          const cfg  = cfgMap[cid]  || {};
          const perf = perfMap[cid] || {};
          const status = cfg.campaign_status || 'ongoing';

          const orcamento = parseFloat(cfg.campaign_budget) ?? 0;
          return {
            id:             cid,
            nome:           cfg.ad_name || perf.nome || `#${cid}`,
            tipo:           cfg.bidding_method === 'auto' ? 'Automático' : 'Manual',
            ativa:          status === 'ongoing',
            orcamento,
            orcamentoLabel: orcamento === 0 ? 'Ilimitado' : `R$ ${fmtN(orcamento, 2)}/dia`,
            roasTarget:     cfg.roas_target ?? null,
            bidding:        cfg.bidding_method || 'manual',
            gasto:          perf.gasto      || 0,
            cliques:        perf.cliques    || 0,
            impressoes:     perf.impressoes || 0,
            pedidos:        perf.pedidos    || 0,
            receita:        perf.receita    || 0,
          };
        }).filter(c => c.ativa);
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
      resultado._erros = [];

      const [campResp] = await Promise.allSettled([
        MarketplaceAPI.call('ml_ads_campaigns', { meliUserId: meliId, date_from: primeiroDia, date_to: ultimoDia }),
      ]);

      if (campResp.status === 'fulfilled') {
        // API retorna { data: { paging: {...}, results: [...] } }
        const raw = campResp.value;
        const camps = raw?.data?.results || raw?.results || (Array.isArray(raw?.data) ? raw.data : []);

        resultado.campanhas = camps.map(c => {
          const m = c.metrics || {};
          const orca = parseFloat(c.budget) || 0;
          return {
            id:             c.id,
            nome:           c.name || `Campanha ${c.id}`,
            tipo:           c.strategy || 'PROFITABILITY',
            ativa:          c.status === 'active' || c.status === 'enabled',
            orcamento:      orca,
            orcamentoLabel: orca === 0 ? 'Ilimitado' : `R$ ${fmtN(orca, 2)}/dia`,
            roasTarget:     parseFloat(c.roas_target) || null,
            bidding:        'auto',
            gasto:          parseFloat(m.cost)              || 0,
            cliques:        parseInt(m.clicks)              || 0,
            impressoes:     parseInt(m.prints)              || 0,
            pedidos:        parseInt(m.units_quantity)      || 0,
            receita:        parseFloat(m.total_amount)      || 0,
          };
        });

        // Só ativas para o resumo (pausadas têm métricas zeradas de qualquer forma)
        const ativas = resultado.campanhas.filter(c => c.ativa);
        resultado.resumo.investimento = resultado.campanhas.reduce((s, c) => s + c.gasto, 0);
        resultado.resumo.cliques      = resultado.campanhas.reduce((s, c) => s + c.cliques, 0);
        resultado.resumo.impressoes   = resultado.campanhas.reduce((s, c) => s + c.impressoes, 0);
        resultado.resumo.pedidos      = resultado.campanhas.reduce((s, c) => s + c.pedidos, 0);
        resultado.resumo.receita      = resultado.campanhas.reduce((s, c) => s + c.receita, 0);

        // Filtra somente ativas para a tabela (igual Shopee)
        resultado.campanhas = resultado.campanhas.filter(c => c.ativa);
      } else {
        resultado._erros.push(`ML ADS falhou: ${campResp.reason?.message || campResp.reason}`);
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
    // Sempre busca da API para garantir lista atualizada
    let contas = [];
    try {
      contas = await MarketplaceAPI.listAccounts();
      localStorage.setItem('glr_mc_accounts', JSON.stringify(contas));
    } catch(e) {
      // Fallback para cache local se API falhar
      const raw = localStorage.getItem('glr_mc_accounts');
      contas = raw ? JSON.parse(raw) : [];
      console.warn('[ADS] Fallback para cache local:', e.message);
    }
    contasSel = contas.filter(c => ['shopee','mercadolivre','ml','meli'].includes(c.marketplace));

    const nicks = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();
    const nomeConta = c => {
      const tag = c.tags?.[0]?.name || '';
      return nicks[c.external_id] || tag || c.nickname || c.name || c.external_id;
    };

    const sel = document.getElementById('ads-sel-conta');
    if (!sel) return;
    sel.innerHTML = `<option value="">— Selecione a conta —</option>` +
      contasSel.map((c, i) => {
        const mp = c.marketplace === 'shopee' ? '🟠 Shopee' : '🟡 ML';
        return `<option value="${i}">${mp} — ${nomeConta(c)}</option>`;
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

    <!-- Tendências período -->
    ${renderTendencias(d)}

    <!-- Sugestões de otimização -->
    ${renderOtimizacoes(d)}

    <!-- Agente IA -->
    ${renderAgentIA()}
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

  const MAX_H = 120; // px máximo das barras
  const maxGasto = Math.max(...diario.map(d => d.gasto), 0.01);
  const slice = diario.slice(-30);
  const bars = slice.map(d => {
    const h = Math.max(Math.round((d.gasto / maxGasto) * MAX_H), 2);
    // data vem como DD-MM-YYYY → mostra só DD/MM
    const partes = (d.data || '').split('-');
    const dataFmt = partes.length >= 2 ? `${partes[0]}/${partes[1]}` : d.data;
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:2px;flex:1;min-width:0;height:${MAX_H}px;" title="${dataFmt}: ${fmt(d.gasto)}">
        <div style="width:100%;background:var(--primary);border-radius:3px 3px 0 0;height:${h}px;opacity:0.85;"></div>
        ${slice.length <= 15 ? `<div style="font-size:9px;color:var(--text-secondary);writing-mode:vertical-lr;transform:rotate(180deg);margin-top:2px;">${dataFmt}</div>` : ''}
      </div>
    `;
  }).join('');

  return `
    <div style="display:flex;align-items:flex-end;gap:2px;padding-bottom:4px;overflow:hidden;">
      ${bars}
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:var(--text-secondary);">
      <span>${slice[0]?.data?.split('-').slice(0,2).join('/') || ''}</span>
      <span>Total: ${fmt(diario.reduce((s, d) => s + d.gasto, 0))}</span>
      <span>${slice[slice.length-1]?.data?.split('-').slice(0,2).join('/') || ''}</span>
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
    return `<div style="text-align:center;padding:32px;color:var(--text-secondary);font-size:13px;">Nenhuma campanha ativa encontrada neste período</div>`;
  }

  const ordenadas = [...campanhas].sort((a, b) => b.gasto - a.gasto);

  const linhas = ordenadas.map(c => {
    const roas    = c.gasto > 0 && c.receita > 0 ? c.receita / c.gasto : 0;
    const acos    = c.receita > 0 ? (c.gasto / c.receita) * 100 : 0;
    const ctr     = c.impressoes > 0 ? (c.cliques / c.impressoes) * 100 : 0;
    const cpc     = c.cliques > 0 ? c.gasto / c.cliques : 0;

    const roasCor = roas >= 3 ? '#16a34a' : roas >= 1.5 ? '#d97706' : roas > 0 ? '#dc2626' : 'var(--text-muted,#94a3b8)';
    const acosCor = acos === 0 ? 'var(--text-muted,#94a3b8)' : acos <= 30 ? '#16a34a' : acos <= 50 ? '#d97706' : '#dc2626';

    // ROAS target (campanhas auto) — valor direto da Shopee, sem divisão
    const roasTarget = c.roasTarget != null ? fmtN(c.roasTarget, 0) + 'x' : '—';
    const btnRoas = c.bidding === 'auto'
      ? `<button onclick="window._adsEditarRoas(${c.id},'${c.nome.replace(/'/g,'').slice(0,30)}',${c.roasTarget ?? 0})" title="Editar meta ROAS"
          style="background:#f0fdf4;color:#16a34a;border:none;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;">🎯</button>`
      : '';

    const btnPausar = `<button onclick="window._adsPausar(${c.id})" title="Pausar campanha"
      style="background:#fee2e2;color:#dc2626;border:none;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;">⏸</button>`;

    const nomeOrca = c.nome.replace(/'/g,'').slice(0,30);
    const btnOrcamento = `<button onclick="window._adsEditarOrcamento(${c.id},'${nomeOrca}',${c.orcamento})" title="Editar orçamento"
      style="background:#eff6ff;color:#2563eb;border:none;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;">✏️</button>`;

    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px 12px;font-size:13px;font-weight:600;color:var(--text-primary);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${c.nome}">${c.nome}</td>
        <td style="padding:10px 12px;">
          <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:${c.bidding==='auto'?'#f0fdf4':'#eff6ff'};color:${c.bidding==='auto'?'#16a34a':'#2563eb'};font-weight:600;">${c.tipo}</span>
        </td>
        <td style="padding:10px 12px;font-size:13px;font-weight:700;text-align:right;color:var(--text-primary);">${fmt(c.gasto)}</td>
        <td style="padding:10px 12px;font-size:13px;text-align:right;color:var(--text-secondary);">${fmtN(c.cliques)}</td>
        <td style="padding:10px 12px;font-size:13px;text-align:right;color:var(--text-secondary);">${fmtN(c.impressoes)}</td>
        <td style="padding:10px 12px;font-size:13px;text-align:right;color:var(--text-secondary);">${fmtN(ctr, 2)}%</td>
        <td style="padding:10px 12px;font-size:13px;text-align:right;color:var(--text-secondary);">${fmt(cpc)}</td>
        <td style="padding:10px 12px;font-size:13px;font-weight:700;text-align:right;color:${roasCor};">${roas > 0 ? fmtN(roas, 2) + 'x' : '—'}</td>
        <td style="padding:10px 12px;font-size:13px;text-align:right;color:${acosCor};">${acos > 0 ? fmtN(acos, 1) + '%' : '—'}</td>
        <td style="padding:10px 12px;font-size:13px;text-align:right;color:${c.roasTarget!=null?'#16a34a':'var(--text-muted,#94a3b8)'};font-weight:${c.roasTarget!=null?'700':'400'};">${roasTarget}</td>
        <td style="padding:10px 12px;font-size:12px;text-align:right;color:var(--text-secondary);">${c.orcamentoLabel}</td>
        <td style="padding:10px 12px;text-align:right;white-space:nowrap;display:flex;gap:4px;justify-content:flex-end;">${btnRoas}${btnOrcamento}${btnPausar}</td>
      </tr>
    `;
  }).join('');

  return `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:var(--bg-base);">
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:left;text-transform:uppercase;min-width:180px;">Campanha</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:left;text-transform:uppercase;">Tipo</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">Investido</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">Cliques</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">Impressões</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">CTR</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">CPC</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">ROAS Real</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">ACoS</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">Meta ROAS</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">Orçamento</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text-secondary);text-align:right;text-transform:uppercase;">Ações</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
    ${renderModalOrcamento()}
  `;
}

function renderModalOrcamento() {
  return `
    <div id="ads-modal-orc" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;align-items:center;justify-content:center;">
      <div style="background:var(--bg-surface);border-radius:16px;padding:28px;width:360px;box-shadow:0 20px 60px rgba(0,0,0,.3);">
        <h3 style="font-size:15px;font-weight:700;margin:0 0 6px;color:var(--text-primary);">✏️ Editar Orçamento Diário</h3>
        <p id="ads-modal-orc-nome" style="font-size:12px;color:var(--text-secondary);margin:0 0 20px;"></p>
        <label style="font-size:12px;font-weight:600;color:var(--text-secondary);">Novo orçamento diário (R$) — 0 = Ilimitado</label>
        <input id="ads-modal-orc-valor" type="number" min="0" step="0.01"
          style="width:100%;margin-top:8px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--bg-base);color:var(--text-primary);box-sizing:border-box;">
        <div style="display:flex;gap:8px;margin-top:20px;">
          <button onclick="document.getElementById('ads-modal-orc').style.display='none'"
            style="flex:1;padding:10px;background:var(--bg-base);border:1px solid var(--border);border-radius:8px;font-weight:600;cursor:pointer;color:var(--text-secondary);">Cancelar</button>
          <button onclick="window._adsSalvarOrcamento()"
            style="flex:1;padding:10px;background:var(--primary);color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;">Salvar</button>
        </div>
        <p id="ads-modal-orc-msg" style="font-size:12px;text-align:center;margin:10px 0 0;"></p>
      </div>
    </div>

    <div id="ads-modal-roas" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;align-items:center;justify-content:center;">
      <div style="background:var(--bg-surface);border-radius:16px;padding:28px;width:380px;box-shadow:0 20px 60px rgba(0,0,0,.3);">
        <h3 style="font-size:15px;font-weight:700;margin:0 0 6px;color:var(--text-primary);">🎯 Editar Meta de ROAS</h3>
        <p id="ads-modal-roas-nome" style="font-size:12px;color:var(--text-secondary);margin:0 0 4px;"></p>
        <p style="font-size:11px;color:var(--text-secondary);margin:0 0 20px;">Digite o valor de ROAS desejado (ex: 50 = meta de 50x)</p>
        <label style="font-size:12px;font-weight:600;color:var(--text-secondary);">Meta ROAS (ex: 50 = 50x)</label>
        <input id="ads-modal-roas-valor" type="number" min="1" step="1"
          style="width:100%;margin-top:8px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--bg-base);color:var(--text-primary);box-sizing:border-box;">
        <div style="background:#f0fdf4;border-radius:8px;padding:10px 12px;margin-top:12px;font-size:12px;color:#15803d;">
          💡 Shopee ajustará os lances automaticamente para atingir esta meta
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;">
          <button onclick="document.getElementById('ads-modal-roas').style.display='none'"
            style="flex:1;padding:10px;background:var(--bg-base);border:1px solid var(--border);border-radius:8px;font-weight:600;cursor:pointer;color:var(--text-secondary);">Cancelar</button>
          <button onclick="window._adsSalvarRoas()"
            style="flex:1;padding:10px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;">Salvar Meta</button>
        </div>
        <p id="ads-modal-roas-msg" style="font-size:12px;text-align:center;margin:10px 0 0;"></p>
      </div>
    </div>
  `;
}

// ─── Tendências ───────────────────────────────────────────────
function renderTendencias(d) {
  const diario = d.diario || [];
  if (diario.length < 8) return '';

  const ultimos7 = diario.slice(-7);
  const ant7     = diario.slice(-14, -7);
  if (ant7.length < 3) return '';

  const soma = (arr, campo) => arr.reduce((s, x) => s + (x[campo] || 0), 0);

  const inv7  = soma(ultimos7, 'gasto'),   rec7  = soma(ultimos7, 'receita');
  const invA  = soma(ant7,     'gasto'),   recA  = soma(ant7,     'receita');
  const cli7  = soma(ultimos7, 'cliques'), cliA  = soma(ant7,     'cliques');
  const ped7  = soma(ultimos7, 'pedidos'), pedA  = soma(ant7,     'pedidos');
  const roas7 = inv7 > 0 ? rec7 / inv7 : 0;
  const roasA = invA > 0 ? recA / invA : 0;

  const diff = (a, b) => b > 0 ? ((a - b) / b) * 100 : 0;

  const card = (icon, label, valAtual, valAnt, pct, invertColor) => {
    const sobe = pct >= 0;
    const cor  = invertColor
      ? (sobe ? '#d97706'  : '#16a34a')  // gasto: sobe é ruim
      : (sobe ? '#16a34a' : '#dc2626');   // receita/roas/etc: sobe é bom
    return `
      <div style="background:var(--bg-base);border:1px solid var(--border);border-radius:10px;padding:14px;">
        <div style="font-size:11px;color:var(--text-secondary);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">${icon} ${label}</div>
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${valAtual}</div>
        <div style="font-size:12px;font-weight:600;color:${cor};margin-top:4px;">${sobe ? '▲' : '▼'} ${fmtN(Math.abs(pct), 1)}% vs período anterior</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">Anterior: ${valAnt}</div>
      </div>
    `;
  };

  // Alertas automáticos de queda
  const alertas = [];
  const roasDiff = diff(roas7, roasA);
  const recDiff  = diff(rec7,  recA);
  const cliDiff  = diff(cli7,  cliA);
  if (roasDiff < -20) alertas.push(`🚨 ROAS caiu <strong>${fmtN(Math.abs(roasDiff), 1)}%</strong> comparado ao período anterior — revise lances e produtos`);
  if (recDiff  < -15) alertas.push(`📉 Receita ADS caiu <strong>${fmtN(Math.abs(recDiff),  1)}%</strong> — verifique se campanhas estão ativas e com saldo`);
  if (cliDiff  < -20) alertas.push(`👁️ Cliques caíram <strong>${fmtN(Math.abs(cliDiff),  1)}%</strong> — anúncios podem estar perdendo relevância ou orçamento acabou`);
  const invDiff  = diff(inv7, invA);
  if (invDiff > 30 && roas7 < roasA * 0.8) alertas.push(`⚠️ Investimento subiu <strong>${fmtN(invDiff, 1)}%</strong> mas ROAS caiu — eficiência piorando`);

  // Mini gráfico dia-a-dia com ROAS por dia (para ver tendência)
  const diasRecentes = diario.slice(-14);
  const roasPorDia = diasRecentes.map(d => d.gasto > 0 ? d.receita / d.gasto : 0);
  const maxR = Math.max(...roasPorDia, 0.01);
  const sparkline = roasPorDia.map((r, i) => {
    const h = Math.max((r / maxR) * 60, 2);
    const anterior = i > 0 ? roasPorDia[i - 1] : r;
    const cor = r >= anterior ? '#16a34a' : '#dc2626';
    const data = diasRecentes[i]?.data?.slice(5) || '';
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1;" title="${data}: ROAS ${fmtN(r,2)}x">
      <div style="width:100%;background:${cor};border-radius:2px 2px 0 0;height:${h}px;opacity:.8;"></div>
    </div>`;
  }).join('');

  return `
    <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:24px;">
      <h3 style="font-size:14px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">📊 Tendências — Últimos 7 dias vs período anterior</h3>
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 16px;">Comparativo automático para detectar quedas de performance</p>

      ${alertas.length > 0 ? `
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px;margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:#dc2626;margin-bottom:8px;">🚨 Alertas de Queda Detectados</div>
          ${alertas.map(a => `<div style="font-size:12px;color:#7f1d1d;padding:3px 0;line-height:1.5;">${a}</div>`).join('')}
        </div>
      ` : `
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px;margin-bottom:16px;font-size:12px;color:#15803d;font-weight:600;">
          ✅ Nenhuma queda significativa detectada no período
        </div>
      `}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;">
        ${card('💰', 'Investimento', fmt(inv7),  fmt(invA),  invDiff,  true)}
        ${card('📈', 'Receita ADS',  fmt(rec7),  fmt(recA),  recDiff,  false)}
        ${card('🎯', 'ROAS',         fmtN(roas7,2)+'x', fmtN(roasA,2)+'x', roasDiff, false)}
        ${card('🖱️', 'Cliques',      fmtN(cli7), fmtN(cliA), cliDiff,  false)}
        ${card('🛒', 'Pedidos ADS',  fmtN(ped7), fmtN(pedA), diff(ped7,pedA), false)}
      </div>

      <!-- Sparkline ROAS 14 dias -->
      <div>
        <div style="font-size:11px;color:var(--text-secondary);font-weight:600;margin-bottom:8px;">ROAS DIA A DIA — 🟢 subindo  🔴 caindo</div>
        <div style="display:flex;align-items:flex-end;gap:3px;height:64px;padding:0 0 4px;">
          ${sparkline}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-secondary);margin-top:4px;">
          <span>${diasRecentes[0]?.data?.slice(5) || ''}</span>
          <span>${diasRecentes[diasRecentes.length-1]?.data?.slice(5) || ''}</span>
        </div>
      </div>
    </div>
  `;
}

// ─── Agente IA ────────────────────────────────────────────────
function renderAgentIA() {
  return `
    <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:24px;" id="ads-ia-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div>
          <h3 style="font-size:14px;font-weight:700;margin:0 0 2px;color:var(--text-primary);">🤖 Agente IA — Consultoria de ADS</h3>
          <p style="font-size:12px;color:var(--text-secondary);margin:0;">Análise inteligente com dados reais das suas campanhas</p>
        </div>
        <div style="display:flex;gap:6px;">
          <button onclick="window._adsNovaConversa()" style="font-size:11px;color:var(--text-secondary);background:var(--bg-base);border:1px solid var(--border);border-radius:6px;padding:5px 10px;cursor:pointer;">🔄 Nova</button>
        </div>
      </div>

      <!-- Área de mensagens -->
      <div id="ads-ia-msgs" style="background:var(--bg-base);border:1px solid var(--border);border-radius:10px;padding:16px;min-height:160px;max-height:420px;overflow-y:auto;margin-bottom:12px;display:flex;flex-direction:column;gap:10px;">
        <div style="text-align:center;color:var(--text-secondary);padding:24px 0;" id="ads-ia-placeholder">
          <div style="font-size:32px;margin-bottom:8px;">🤖</div>
          <div style="font-size:13px;font-weight:600;margin-bottom:4px;">Agente especialista em ADS pronto</div>
          <div style="font-size:12px;">Clique em uma sugestão ou escreva sua pergunta</div>
        </div>
      </div>

      <!-- Perguntas rápidas -->
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
        ${['📊 Analisar tudo agora', '📉 Quais campanhas pausar?', '📈 Como aumentar ROAS?', '💰 Onde investir mais?', '🔍 Por que os cliques caíram?']
          .map(q => `<button onclick="window._adsEnviarMensagem('${q.replace(/'/g, '')}')"
            style="font-size:11px;background:var(--bg-base);border:1px solid var(--border);border-radius:99px;padding:5px 12px;cursor:pointer;color:var(--text-secondary);">${q}</button>`).join('')}
      </div>

      <!-- Input -->
      <div style="display:flex;gap:8px;">
        <input id="ads-ia-input" type="text" placeholder="Pergunte sobre suas campanhas..."
          onkeydown="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();window._adsEnviarMensagem();}"
          style="flex:1;padding:10px 16px;border:1px solid var(--border);border-radius:99px;background:var(--bg-base);color:var(--text-primary);font-size:13px;outline:none;">
        <button onclick="window._adsEnviarMensagem()" id="ads-ia-btn"
          style="background:var(--primary);color:#fff;border:none;border-radius:99px;padding:10px 22px;font-size:13px;font-weight:600;cursor:pointer;">Enviar</button>
      </div>
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

// ─── Ações de otimização ──────────────────────────────────────
let _adsModalCampId = null;

window._adsPausar = async function(campaignId) {
  if (!confirm('Pausar esta campanha?')) return;
  try {
    await MarketplaceAPI.call('shopee_ads_pause_campaign', { campaign_id: campaignId });
    alert('✅ Campanha pausada com sucesso!');
    buscarDados(true);
  } catch(e) {
    alert('❌ Erro ao pausar: ' + e.message);
  }
};

window._adsEditarOrcamento = function(campaignId, nome, orcamentoAtual) {
  _adsModalCampId = campaignId;
  document.getElementById('ads-modal-orc-nome').textContent = nome;
  document.getElementById('ads-modal-orc-valor').value = orcamentoAtual || 0;
  document.getElementById('ads-modal-orc-msg').textContent = '';
  document.getElementById('ads-modal-orc').style.display = 'flex';
  setTimeout(() => document.getElementById('ads-modal-orc-valor').focus(), 100);
};

window._adsSalvarOrcamento = async function() {
  const novoValor = parseFloat(document.getElementById('ads-modal-orc-valor').value);
  const msg = document.getElementById('ads-modal-orc-msg');
  if (isNaN(novoValor) || novoValor < 0) { msg.textContent = '⚠️ Valor inválido'; msg.style.color = '#dc2626'; return; }
  msg.textContent = 'Salvando...'; msg.style.color = 'var(--text-secondary)';
  try {
    await MarketplaceAPI.call('shopee_ads_edit_campaign', { shopId: contaAtual?.param_to_use?.shopId || contaAtual?.external_id, campaign_id: _adsModalCampId, campaign_budget: novoValor });
    msg.textContent = '✅ Orçamento atualizado!'; msg.style.color = '#16a34a';
    setTimeout(() => { document.getElementById('ads-modal-orc').style.display = 'none'; buscarDados(true); }, 1200);
  } catch(e) { msg.textContent = '❌ Erro: ' + e.message; msg.style.color = '#dc2626'; }
};

window._adsEditarRoas = function(campaignId, nome, roasAtual) {
  _adsModalCampId = campaignId;
  document.getElementById('ads-modal-roas-nome').textContent = nome;
  document.getElementById('ads-modal-roas-valor').value = roasAtual || '';
  document.getElementById('ads-modal-roas-msg').textContent = '';
  document.getElementById('ads-modal-roas').style.display = 'flex';
  setTimeout(() => document.getElementById('ads-modal-roas-valor').focus(), 100);
};

window._adsSalvarRoas = async function() {
  const novoValor = parseInt(document.getElementById('ads-modal-roas-valor').value);
  const msg = document.getElementById('ads-modal-roas-msg');
  if (!novoValor || novoValor < 1) { msg.textContent = '⚠️ Informe um valor válido (ex: 45 para meta 4.5x)'; msg.style.color = '#dc2626'; return; }
  msg.textContent = 'Salvando...'; msg.style.color = 'var(--text-secondary)';
  try {
    await MarketplaceAPI.call('shopee_ads_edit_campaign', { shopId: contaAtual?.param_to_use?.shopId || contaAtual?.external_id, campaign_id: _adsModalCampId, roas_target: novoValor });
    msg.textContent = `✅ Meta ROAS atualizada para ${novoValor}x!`; msg.style.color = '#16a34a';
    setTimeout(() => { document.getElementById('ads-modal-roas').style.display = 'none'; buscarDados(true); }, 1500);
  } catch(e) { msg.textContent = '❌ Erro: ' + e.message; msg.style.color = '#dc2626'; }
};

// ─── Agente IA — funções globais ─────────────────────────────
window._adsNovaConversa = function() {
  _aiHistory = [];
  const msgs = document.getElementById('ads-ia-msgs');
  if (msgs) msgs.innerHTML = `
    <div style="text-align:center;color:var(--text-secondary);padding:24px 0;" id="ads-ia-placeholder">
      <div style="font-size:32px;margin-bottom:8px;">🤖</div>
      <div style="font-size:13px;font-weight:600;">Nova conversa iniciada</div>
    </div>`;
};

window._adsEnviarMensagem = async function(msgPredef) {
  if (_aiCarregando) return;

  const input = document.getElementById('ads-ia-input');
  const msgs  = document.getElementById('ads-ia-msgs');
  const btn   = document.getElementById('ads-ia-btn');
  if (!msgs) return;

  const texto = msgPredef || (input ? input.value.trim() : '');
  if (!texto) return;

  if (input) input.value = '';
  document.getElementById('ads-ia-placeholder')?.remove();

  _aiCarregando = true;
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  // Bolha usuário
  const divU = document.createElement('div');
  divU.style.cssText = 'display:flex;justify-content:flex-end;';
  divU.innerHTML = `<div style="background:var(--primary);color:#fff;border-radius:12px 12px 0 12px;padding:10px 14px;max-width:80%;font-size:13px;line-height:1.5;">${texto}</div>`;
  msgs.appendChild(divU);
  msgs.scrollTop = msgs.scrollHeight;

  // Indicador digitando
  const divT = document.createElement('div');
  divT.id = 'ads-ia-typing';
  divT.innerHTML = `<div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px 12px 12px 0;padding:10px 14px;font-size:13px;color:var(--text-secondary);display:inline-block;">🤖 Analisando dados...</div>`;
  msgs.appendChild(divT);
  msgs.scrollTop = msgs.scrollHeight;

  // Monta contexto com dados reais
  const d = dadosADS;
  const ctx = d ? `
Conta: ${d.conta} | Período: ${d.periodo.de} a ${d.periodo.ate}
Marketplace: ${d.marketplace}

RESUMO DO PERÍODO:
- Investimento total: R$ ${(d.resumo.investimento||0).toFixed(2)}
- Receita via ADS: R$ ${(d.resumo.receita||0).toFixed(2)}
- ROAS: ${d.resumo.investimento > 0 ? (d.resumo.receita/d.resumo.investimento).toFixed(2) : '0'}x
- ACoS: ${d.resumo.receita > 0 ? ((d.resumo.investimento/d.resumo.receita)*100).toFixed(1) : '0'}%
- Cliques: ${d.resumo.cliques} | Impressões: ${d.resumo.impressoes}
- CTR: ${d.resumo.impressoes > 0 ? ((d.resumo.cliques/d.resumo.impressoes)*100).toFixed(2) : '0'}%
- Pedidos via ADS: ${d.resumo.pedidos}
- Saldo ADS: R$ ${(d.saldo||0).toFixed(2)}

CAMPANHAS ATIVAS (top 15 por investimento):
${(d.campanhas||[]).slice(0,15).map(c => {
  const roas = c.gasto > 0 && c.receita > 0 ? (c.receita/c.gasto).toFixed(2) : '—';
  const acos = c.receita > 0 ? ((c.gasto/c.receita)*100).toFixed(1) : '—';
  const ctr  = c.impressoes > 0 ? ((c.cliques/c.impressoes)*100).toFixed(2) : '0';
  const meta = c.bidding === 'auto' && c.roasTarget ? `meta ${c.roasTarget}x` : 'lances manuais';
  return `• ${c.nome}: investido R$${c.gasto.toFixed(2)}, receita R$${c.receita.toFixed(2)}, ROAS ${roas}x, ACoS ${acos}%, CTR ${ctr}%, ${meta}, orçamento: ${c.orcamentoLabel}`;
}).join('\n')}

DADOS DIÁRIOS (últimos 14 dias):
${(d.diario||[]).slice(-14).map(dia => {
  const r = dia.gasto > 0 ? (dia.receita/dia.gasto).toFixed(2) : '—';
  return `${dia.data}: gasto R$${dia.gasto.toFixed(2)}, receita R$${dia.receita.toFixed(2)}, ROAS ${r}x, cliques ${dia.cliques}`;
}).join('\n')}
` : 'Nenhum dado carregado ainda.';

  _aiHistory.push({ role: 'user', content: texto });

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: `Você é um especialista sênior em performance de ADS para marketplaces brasileiros (Shopee, Mercado Livre).
Analise os dados fornecidos e dê recomendações práticas, específicas e acionáveis.
Seja direto. Use bullet points para listas. Destaque campanhas problemáticas pelo nome.
Sugira ações concretas: pausar, aumentar orçamento, ajustar meta ROAS, etc.
Responda em português brasileiro informal mas profissional.

DADOS ATUAIS DAS CAMPANHAS:
${ctx}`,
        messages: _aiHistory,
      }),
    });

    const json = await resp.json();
    if (json.error) throw new Error(json.error);
    const resposta = json.content || 'Sem resposta.';
    _aiHistory.push({ role: 'assistant', content: resposta });

    document.getElementById('ads-ia-typing')?.remove();

    const divR = document.createElement('div');
    divR.style.cssText = 'display:flex;justify-content:flex-start;';
    divR.innerHTML = `<div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px 12px 12px 0;padding:12px 16px;max-width:90%;font-size:13px;color:var(--text-primary);line-height:1.6;white-space:pre-wrap;">${resposta}</div>`;
    msgs.appendChild(divR);
    msgs.scrollTop = msgs.scrollHeight;

  } catch(e) {
    document.getElementById('ads-ia-typing')?.remove();
    const divE = document.createElement('div');
    divE.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px 14px;font-size:12px;color:#dc2626;">❌ Erro: ${e.message}${e.message.includes('401') ? ' — verifique sua API Key' : ''}</div>`;
    msgs.appendChild(divE);
    msgs.scrollTop = msgs.scrollHeight;
  }

  _aiCarregando = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Enviar'; }
};

// ─── Registro da rota ─────────────────────────────────────────
if (typeof Router !== 'undefined') {
  Router.register('ads', renderPage);
}

})();
