// ============================================================
// GLR Consultoria — Página de Vendas (Detalhamento de Pedidos)
// ============================================================

Router.register('vendas', async (params, el) => {
  const STORAGE_CUSTOS  = 'glr_vendas_custos';
  const STORAGE_LINHAS  = 'glr_vendas_linhas';
  const STORAGE_PEDIDOS = 'glr_vendas_cache'; // { pedidos, dataFrom, dataTo, at }
  const pad     = n => String(n).padStart(2,'0');
  const hoje    = new Date();
  const ontem   = new Date(hoje); ontem.setDate(hoje.getDate()-1);
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const R$      = v  => 'R$ '+(parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pct     = v  => (parseFloat(v)||0).toFixed(1)+'%';

  let custos     = JSON.parse(localStorage.getItem(STORAGE_CUSTOS)||'{}');
  let linhasExt  = JSON.parse(localStorage.getItem(STORAGE_LINHAS)||'[]');
  const aliquotas = JSON.parse(localStorage.getItem('glr_aliquotas')||'{}'); // { [extId]: pct }
  let pedidos   = [];  // { id, plataforma, data, dataTs, produto, imagem, qtd, valor, status, itens[], taxas{} }
  let filtroPeriodo = 'custom'; // padrão: só ontem
  let filtroPlat    = 'todas';
  let customFrom    = fmtDate(ontem); // ontem
  let customTo      = fmtDate(ontem); // ontem
  let expandido     = null;
  let abaAtiva      = 'dashboard'; // 'dashboard' | 'pedidos'

  const salvarCustos  = () => localStorage.setItem(STORAGE_CUSTOS, JSON.stringify(custos));
  const salvarLinhas  = () => localStorage.setItem(STORAGE_LINHAS, JSON.stringify(linhasExt));

  function salvarCache(dataFrom, dataTo) {
    try {
      localStorage.setItem(STORAGE_PEDIDOS, JSON.stringify({ pedidos, dataFrom, dataTo, at: Date.now() }));
    } catch(e) { console.warn('Cache pedidos: erro ao salvar', e); }
  }

  function carregarCache(dataFrom, dataTo) {
    try {
      const raw = localStorage.getItem(STORAGE_PEDIDOS);
      if (!raw) return false;
      const c = JSON.parse(raw);
      if (c.dataFrom !== dataFrom || c.dataTo !== dataTo) return false;
      pedidos = c.pedidos || [];
      return c.at || true;
    } catch(e) { return false; }
  }

  function fmtAgo(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)   return 'agora mesmo';
    if (diff < 3600) return `há ${Math.floor(diff/60)} min`;
    if (diff < 86400)return `há ${Math.floor(diff/3600)}h`;
    return `há ${Math.floor(diff/86400)} dias`;
  }
  const platCor = { 'Mercado Livre':'#f59e0b', 'Shopee':'#f97316' };

  function corMargem(m) {
    if (m>=20) return '#34d399';
    if (m>=10) return '#fbbf24';
    if (m>=0)  return '#f97316';
    return '#ef4444';
  }

  // ── Cálculo de lucro ────────────────────────────────────────
  // Se temos taxas da API (Shopee escrow), usa liquido como base.
  // Senão, usa receita bruta.
  function calcLucro(p) {
    const receita  = parseFloat(p.valor) || 0;
    const tx       = p.taxas || {};
    const liquido  = tx.liquido != null ? parseFloat(tx.liquido) : null;
    const c        = custos[p.id] || {};
    const custo    = parseFloat(c.custo)  || 0;
    const outros   = parseFloat(c.outros) || 0;
    // Imposto: 1) valor da API (escrow), 2) manual por pedido (%), 3) alíquota da conta
    const impAPIRaw= tx.imposto != null ? parseFloat(tx.imposto) : null;
    const impManual= parseFloat(c.imposto) || 0;
    const impAliq  = parseFloat(aliquotas[p.contaId] || 0);
    const impPct   = impManual || impAliq;   // manual tem prioridade sobre alíquota da conta
    // imposto da API (escrow_tax): só usa se > 0, e já está deduzido do liquido
    const impDeEscrow = (impAPIRaw != null && impAPIRaw > 0);
    const impAPI      = impDeEscrow ? impAPIRaw : null;
    // impVal = valor mostrado na coluna imposto
    // Se veio do escrow (já deduzido do liquido): mostramos mas não subtraímos de novo
    // Se veio da alíquota/manual (imposto do vendedor, não no escrow): exibimos E subtraímos
    const impVal   = impAPI != null ? impAPI : (receita * impPct / 100);

    let extra = 0;
    for (const l of linhasExt)
      extra += l.tipo==='pct' ? receita*(parseFloat(l.valor)||0)/100 : (parseFloat(l.valor)||0);

    // Base de lucro
    const base  = liquido != null ? liquido : receita;
    // Se tem liquido do escrow: taxas de marketplace já deduzidas.
    // Mas o imposto do vendedor (alíquota/manual) NÃO está no escrow → sempre subtrair impVal exceto quando veio do escrow_tax
    const impSubtrair = impDeEscrow ? 0 : impVal; // se veio do escrow já está no liquido
    const lucro = base - custo - impSubtrair - outros - extra;

    const margem = receita > 0 ? (lucro/receita)*100 : 0;
    return { receita, liquido, custo, impVal, impPct, outros, extra, lucro, margem,
             comissao: tx.comissao||0, taxaServico: tx.taxaServico||0,
             frete: tx.frete||0, voucher: tx.voucher||0 };
  }

  function calcTotais(lista) {
    let fat=0,liq=0,custo=0,imp=0,out=0,lucro=0,nLiq=0;
    for (const p of lista) {
      const l=calcLucro(p);
      fat+=l.receita; custo+=l.custo; imp+=l.impVal; out+=l.outros+l.extra; lucro+=l.lucro;
      if (l.liquido!=null){ liq+=l.liquido; nLiq++; }
    }
    return { fat, liq: nLiq>0?liq:null, custo, imp, out, lucro, margem: fat>0?(lucro/fat)*100:0 };
  }

  function pedidosFiltrados() {
    return pedidos.filter(p => filtroPlat==='todas' || p.plataforma===filtroPlat);
  }

  // ── Trocar aba ───────────────────────────────────────────────
  async function setAba(aba) {
    abaAtiva = aba;
    ['dashboard','pedidos'].forEach(a => {
      const btn = document.getElementById(`tab-${a}`);
      const sec = document.getElementById(`sec-${a}`);
      if (btn) btn.style.cssText = a===aba
        ? 'padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:13px;background:#6366f1;color:white;'
        : 'padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:13px;background:rgba(255,255,255,0.06);color:#9ca3af;';
      if (sec) sec.style.display = a===aba ? 'block' : 'none';
    });
    if (aba==='dashboard') await renderDashboard();
    if (aba==='pedidos')   renderPedidos();
  }

  // ── Dashboard ────────────────────────────────────────────────
  async function renderDashboard() {
    const sec = document.getElementById('sec-dashboard');
    if (!sec) return;
    const lista = pedidosFiltrados();
    const t     = calcTotais(lista);
    const nVendas = lista.length;
    const unidades = lista.reduce((s,p)=>s+p.qtd,0);
    const ticketMedio = nVendas > 0 ? t.fat/nVendas : 0;
    const liqPct = t.fat > 0 ? t.liq/t.fat*100 : 0;

    // ── Agrupar por dia para o gráfico ──
    const porDia = {};
    for (const p of lista) {
      const dia = p.data || '—';
      if (!porDia[dia]) porDia[dia] = { fat:0, liq:0, lucro:0, n:0 };
      const l = calcLucro(p);
      porDia[dia].fat   += l.receita;
      porDia[dia].liq   += l.liquido||0;
      porDia[dia].lucro += l.lucro;
      porDia[dia].n     += 1;
    }
    const dias = Object.keys(porDia).sort((a,b)=>{
      const pa=a.split('/'), pb=b.split('/');
      return new Date(pa[2],pa[1]-1,pa[0]) - new Date(pb[2],pb[1]-1,pb[0]);
    });

    // ── Top 15 produtos ── inclui ids de pedidos para poder salvar custo
    const prodMap = {};
    for (const p of lista) {
      const key = p.itens?.[0]?.itemId || p.produto;
      if (!prodMap[key]) prodMap[key] = {
        nome: p.produto, imagem: p.imagem,
        fat:0, liq:0, lucro:0, qtd:0, n:0, ids:[]
      };
      const l = calcLucro(p);
      prodMap[key].fat   += l.receita;
      prodMap[key].liq   += l.liquido||0;
      prodMap[key].lucro += l.lucro;
      prodMap[key].qtd   += p.qtd;
      prodMap[key].n     += 1;
      prodMap[key].ids.push(p.id);
    }
    const top15 = Object.values(prodMap).sort((a,b)=>b.fat-a.fat).slice(0,15);

    // ── SVG chart — com fallback para 1 dia (mostra barra) ──
    const W=800, H=160, PAD=8;
    // Se só 1 dia, duplica com 0 para ter linha visível
    let chartDias = dias.length > 0 ? dias : ['—'];
    const singleDay = chartDias.length === 1;
    if (singleDay) chartDias = ['', chartDias[0], ''];
    const fatVals  = chartDias.map(d=>porDia[d]?.fat  ||0);
    const liqVals  = chartDias.map(d=>porDia[d]?.liq  ||0);
    const lucroVals= chartDias.map(d=>porDia[d]?.lucro||0);
    const maxVal   = Math.max(1, ...fatVals, ...liqVals, ...lucroVals);
    const n = chartDias.length;
    const xOf = i => PAD + (i/(n-1)) * (W-PAD*2);
    const yOf = v => H - PAD - ((v/maxVal)*(H-PAD*2));
    const svgPath = vals => vals.map((v,i)=>`${i===0?'M':'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
    const area = vals => `${svgPath(vals)} L${xOf(n-1).toFixed(1)},${(H-PAD).toFixed(1)} L${xOf(0).toFixed(1)},${(H-PAD).toFixed(1)} Z`;
    const labStep = Math.max(1, Math.ceil((singleDay?dias:chartDias).length/7));

    // ── Puxar ADS real da API do Marketplace Connect ──
    let totalAds = 0, adsML = 0, adsShopee = 0;
    try {
      const contas = await MarketplaceAPI.listAccounts();

      // ML ADS
      const mlConta = contas.find(c => c.tipo === 'Mercado Livre' || c.tipo === 'ML');
      if (mlConta?.user_id) {
        try {
          const adsData = await MarketplaceAPI.mlAdsMetrics(mlConta.user_id, customFrom, customTo);
          adsML = parseFloat(adsData.investimento) || 0;
          totalAds += adsML;
        } catch(e) {
          console.warn('[ML] Erro ao puxar ADS:', e.message);
        }
      }

      // Shopee ADS (se houver função disponível)
      const shopeeConta = contas.find(c => c.tipo === 'Shopee');
      if (shopeeConta?.shop_id) {
        try {
          // Tentar chamar API de ADS Shopee se existir
          if (MarketplaceAPI.shopeeAdsMetrics) {
            const adsData = await MarketplaceAPI.shopeeAdsMetrics(shopeeConta.shop_id, customFrom, customTo);
            adsShopee = parseFloat(adsData.investimento) || 0;
            totalAds += adsShopee;
          }
        } catch(e) {
          console.warn('[Shopee] Erro ao puxar ADS:', e.message);
        }
      }
    } catch(e) {
      console.warn('[API] Erro ao puxar contas:', e.message);
    }

    sec.innerHTML = `
    <!-- KPI Cards -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px;">
      ${kpiCard('💰 Faturamento',   R$(t.fat),    `${nVendas} vendas`,  '#60a5fa')}
      ${kpiCard('🏦 Líq. Marketplace', R$(t.liq!=null?t.liq:0), t.fat>0?pct(liqPct)+' do fat.':'—', '#a78bfa')}
      ${kpiCard('✅ Lucro Bruto',    R$(t.lucro),  'Margem: '+pct(t.margem), corMargem(t.margem))}
      ${kpiCard('📊 Margem',         pct(t.margem),'',                   corMargem(t.margem))}
      ${kpiCard('🛒 Nº de Vendas',   nVendas,      `${unidades} unidades`,'#34d399')}
      ${kpiCard('📦 Unidades Vend.', unidades,     '',                   '#34d399')}
      ${kpiCard('🎯 Ticket Médio',   R$(ticketMedio),'',                 '#fbbf24')}
      ${kpiCard('📦 Custo Produto',  R$(t.custo),  '',                   '#f87171')}
    </div>

    <!-- Gráfico -->
    <div class="card" style="margin-bottom:20px;padding:20px;">
      <div style="font-size:14px;font-weight:700;color:#e5e7eb;margin-bottom:16px;">📈 Resumo de Receitas</div>
      <div style="display:flex;gap:16px;margin-bottom:12px;font-size:11px;">
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:3px;background:#60a5fa;display:inline-block;border-radius:2px;"></span> Faturamento</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:3px;background:#a78bfa;display:inline-block;border-radius:2px;"></span> Líquido MP</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:3px;background:#34d399;display:inline-block;border-radius:2px;"></span> Lucro</span>
      </div>
      <div style="overflow-x:auto;background:linear-gradient(135deg,rgba(99,102,241,0.05) 0%,rgba(168,85,247,0.05) 100%);border-radius:12px;padding:16px;">
        <svg viewBox="0 0 ${W} ${H+30}" style="width:100%;min-width:400px;height:${H+30}px;filter:drop-shadow(0 4px 6px rgba(0,0,0,0.1));">
          <defs>
            <linearGradient id="gFat"   x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity=".4"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/></linearGradient>
            <linearGradient id="gLiq"   x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#8b5cf6" stop-opacity=".35"/><stop offset="100%" stop-color="#8b5cf6" stop-opacity="0"/></linearGradient>
            <linearGradient id="gLucro" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#10b981" stop-opacity=".4"/><stop offset="100%" stop-color="#10b981" stop-opacity="0"/></linearGradient>
            <filter id="glow"><feGaussianBlur stdDeviation="1" result="coloredBlur"/><feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>
          <!-- Background gradient -->
          <rect x="${PAD}" y="${PAD}" width="${W-PAD*2}" height="${H-PAD*2}" fill="rgba(255,255,255,0.02)" rx="8"/>
          <!-- Grid lines (subtle) -->
          ${[0.25,0.5,0.75,1].map(f=>`<line x1="${PAD+4}" y1="${yOf(maxVal*f).toFixed(1)}" x2="${W-PAD-4}" y2="${yOf(maxVal*f).toFixed(1)}" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="4,4"/>`).join('')}
          <!-- Areas with blur effect -->
          <path d="${area(fatVals)}"   fill="url(#gFat)" filter="url(#glow)"/>
          <path d="${area(liqVals)}"   fill="url(#gLiq)" filter="url(#glow)"/>
          <path d="${area(lucroVals)}" fill="url(#gLucro)" filter="url(#glow)"/>
          <!-- Lines (thicker, smoother) -->
          <path d="${svgPath(fatVals)}"   fill="none" stroke="#3b82f6" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" filter="url(#glow)"/>
          <path d="${svgPath(liqVals)}"   fill="none" stroke="#8b5cf6" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" filter="url(#glow)"/>
          <path d="${svgPath(lucroVals)}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" filter="url(#glow)"/>
          <!-- Dots with glow -->
          ${fatVals.map((v,i)=>`<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="4" fill="#3b82f6" filter="url(#glow)" opacity="0.8"/>`).join('')}
          ${liqVals.map((v,i)=>v>0?`<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="4" fill="#8b5cf6" filter="url(#glow)" opacity="0.8"/>`:'').join('')}
          ${lucroVals.map((v,i)=>v!==0?`<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3.5" fill="#10b981" filter="url(#glow)" opacity="0.85"/>`:'').join('')}
          <!-- X labels -->
          ${(singleDay?dias:chartDias).filter((_,i)=>i%labStep===0||i===(singleDay?dias:chartDias).length-1).map(d=>{
            const i = chartDias.indexOf(d);
            return i>=0&&d?`<text x="${xOf(i).toFixed(1)}" y="${H+18}" fill="#9ca3af" font-size="11" text-anchor="middle" font-weight="500">${d}</text>`:'';
          }).join('')}
        </svg>
      </div>
    </div>

    <!-- ADS e Lucro pós-ADS -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px;">
      <div class="card" style="padding:20px;background:linear-gradient(135deg,rgba(239,68,68,0.1) 0%,transparent 100%);border:1px solid rgba(239,68,68,0.2);">
        <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">💰 INVESTIMENTO EM ADS</div>
        <div style="font-size:24px;font-weight:800;color:#ef4444;margin-bottom:4px;" id="dashboard-ads">R$ 0,00</div>
        <div style="font-size:11px;color:#9ca3af;" id="dashboard-ads-pct">0% do faturamento</div>
      </div>
      <div class="card" style="padding:20px;background:linear-gradient(135deg,rgba(34,197,94,0.1) 0%,transparent 100%);border:1px solid rgba(34,197,94,0.2);">
        <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">📊 LUCRO DEPOIS ADS</div>
        <div style="font-size:24px;font-weight:800;color:#22c55e;margin-bottom:4px;" id="dashboard-lucro-ads">R$ 0,00</div>
        <div style="font-size:11px;color:#9ca3af;" id="dashboard-lucro-ads-pct">Margem: 0%</div>
      </div>
    </div>

    <!-- Cards: Performance e Métricas -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;">
      <div class="card" style="padding:16px;background:linear-gradient(135deg,rgba(168,85,247,0.1) 0%,transparent 100%);border:1px solid rgba(168,85,247,0.2);">
        <div style="font-size:10px;color:#6b7280;margin-bottom:6px;">📈 CONVERSÃO</div>
        <div style="font-size:22px;font-weight:800;color:#a78bfa;margin-bottom:2px;" id="card-conversao">—</div>
        <div style="font-size:9px;color:#9ca3af;">Vendas / Visitas</div>
      </div>
      <div class="card" style="padding:16px;background:linear-gradient(135deg,rgba(251,146,60,0.1) 0%,transparent 100%);border:1px solid rgba(251,146,60,0.2);">
        <div style="font-size:10px;color:#6b7280;margin-bottom:6px;">🎯 TICKET MÉDIO</div>
        <div style="font-size:22px;font-weight:800;color:#fb923c;margin-bottom:2px;" id="card-ticket">—</div>
        <div style="font-size:9px;color:#9ca3af;">Faturamento / Vendas</div>
      </div>
      <div class="card" style="padding:16px;background:linear-gradient(135deg,rgba(239,68,68,0.1) 0%,transparent 100%);border:1px solid rgba(239,68,68,0.2);">
        <div style="font-size:10px;color:#6b7280;margin-bottom:6px;">💸 ROI ADS</div>
        <div style="font-size:22px;font-weight:800;color:#ef4444;margin-bottom:2px;" id="card-roi-ads">—</div>
        <div style="font-size:9px;color:#9ca3af;">Faturamento / Investimento</div>
      </div>
      <div class="card" style="padding:16px;background:linear-gradient(135deg,rgba(34,197,94,0.1) 0%,transparent 100%);border:1px solid rgba(34,197,94,0.2);">
        <div style="font-size:10px;color:#6b7280;margin-bottom:6px;">💰 CPM ADS</div>
        <div style="font-size:22px;font-weight:800;color:#22c55e;margin-bottom:2px;" id="card-cpm-ads">—</div>
        <div style="font-size:9px;color:#9ca3af;">Custo por 1k visitas</div>
      </div>
    </div>

    <!-- Cards: Visitas / Vendas / Faturamento -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px;">
      <div class="card" style="padding:20px;background:linear-gradient(135deg,rgba(107,114,128,0.1) 0%,transparent 100%);border:1px solid rgba(107,114,128,0.2);">
        <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">👁️ VISITAS TOTAL</div>
        <div style="font-size:28px;font-weight:800;color:#6b7280;margin-bottom:4px;" id="card-visitas">—</div>
        <div style="font-size:10px;color:#9ca3af;"><span id="card-visitas-ml">—</span> ML · <span id="card-visitas-shopee">—</span> Shopee</div>
      </div>
      <div class="card" style="padding:20px;background:linear-gradient(135deg,rgba(59,130,246,0.1) 0%,transparent 100%);border:1px solid rgba(59,130,246,0.2);">
        <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">🛍️ PEDIDOS TOTAL</div>
        <div style="font-size:28px;font-weight:800;color:#3b82f6;margin-bottom:4px;" id="card-vendas">—</div>
        <div style="font-size:10px;color:#9ca3af;"><span id="card-vendas-ml">—</span> ML · <span id="card-vendas-shopee">—</span> Shopee</div>
      </div>
      <div class="card" style="padding:20px;background:linear-gradient(135deg,rgba(52,211,153,0.1) 0%,transparent 100%);border:1px solid rgba(52,211,153,0.2);">
        <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">💵 FATURAMENTO TOTAL</div>
        <div style="font-size:28px;font-weight:800;color:#34d399;margin-bottom:4px;" id="card-fat">—</div>
        <div style="font-size:10px;color:#9ca3af;"><span id="card-fat-ml">—</span> ML · <span id="card-fat-shopee">—</span> Shopee</div>
      </div>
    </div>

    <!-- Tabela: Comparativo por Marketplace -->
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:20px;">
      <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div style="font-size:14px;font-weight:700;color:#e5e7eb;">📊 Comparativo por Marketplace</div>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:rgba(255,255,255,0.03);">
              <th style="padding:12px 16px;text-align:left;color:#6b7280;font-weight:600;">PLATAFORMA</th>
              <th style="padding:12px 12px;text-align:right;color:#6b7280;font-weight:600;">VISITAS</th>
              <th style="padding:12px 12px;text-align:right;color:#6b7280;font-weight:600;">PEDIDOS</th>
              <th style="padding:12px 12px;text-align:right;color:#6b7280;font-weight:600;">FATURAMENTO</th>
              <th style="padding:12px 12px;text-align:right;color:#6b7280;font-weight:600;">TICKET MÉDIO</th>
            </tr>
          </thead>
          <tbody id="marketplace-table-body">
            <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
              <td colspan="5" style="padding:20px;text-align:center;color:#6b7280;">Carregando...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Top 15 Produtos -->
    <div class="card" style="padding:0;overflow:hidden;">
      <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;">
        <div style="font-size:14px;font-weight:700;color:#e5e7eb;">🏆 Top ${top15.length} Produtos</div>
        <div style="font-size:11px;color:#6b7280;">Comparação de vendas nos últimos dias</div>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:rgba(255,255,255,0.03);">
              <th style="padding:10px 16px;text-align:left;color:#6b7280;font-weight:600;white-space:nowrap;">PRODUTO</th>
              <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;white-space:nowrap;">UNID.</th>
              <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;white-space:nowrap;">FATURADO</th>
              <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;white-space:nowrap;">REPRESENT.</th>
              <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;white-space:nowrap;border-left:1px solid rgba(255,255,255,0.06);">30 DIAS</th>
              <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;white-space:nowrap;">60 DIAS</th>
              <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;white-space:nowrap;">90 DIAS</th>
              <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;white-space:nowrap;">120 DIAS</th>
              <th style="padding:10px 12px;text-align:right;color:#fbbf24;font-weight:600;white-space:nowrap;border-left:1px solid rgba(255,255,255,0.06);">💰 CUSTO UNIT.</th>
              <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;white-space:nowrap;">LÍQ. MP</th>
              <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;white-space:nowrap;">LUCRO</th>
              <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;white-space:nowrap;">MARGEM</th>
            </tr>
          </thead>
          <tbody>
            ${top15.map((p,i)=>{
              const margem = p.fat>0 ? p.lucro/p.fat*100 : 0;
              const represent = t.fat>0 ? p.fat/t.fat*100 : 0;
              // Custo atual: pega do primeiro pedido desse produto
              const custoAtual = custos[p.ids[0]]?.custo || '';
              const prodKey = encodeURIComponent(JSON.stringify(p.ids));
              return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);${i%2===0?'':'background:rgba(255,255,255,0.015);'}">
                <td style="padding:10px 16px;">
                  <div style="display:flex;align-items:center;gap:8px;">
                    ${p.imagem ? `<img src="${p.imagem}" style="width:32px;height:32px;border-radius:5px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">` : `<div style="width:32px;height:32px;background:rgba(255,255,255,0.06);border-radius:5px;flex-shrink:0;"></div>`}
                    <div style="min-width:0;">
                      <div style="color:#e5e7eb;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;">${p.nome}</div>
                      <div style="color:#6b7280;font-size:10px;">${p.n} pedido${p.n!==1?'s':''} · ${p.qtd} un.</div>
                    </div>
                  </div>
                </td>
                <td style="padding:10px 12px;text-align:right;color:#d1d5db;">${p.qtd}</td>
                <td style="padding:10px 12px;text-align:right;color:#60a5fa;font-weight:600;">${R$(p.fat)}</td>
                <td style="padding:10px 12px;text-align:right;">
                  <span style="background:rgba(99,102,241,0.15);color:#818cf8;padding:2px 7px;border-radius:10px;font-size:11px;">${pct(represent)}</span>
                </td>
                <td style="padding:10px 12px;text-align:right;color:#9ca3af;border-left:1px solid rgba(255,255,255,0.06);">${(() => pedidos.filter(ped => p.ids.includes(ped.id) && Math.floor((new Date() - new Date(ped.dataTs)) / (1000*60*60*24)) <= 30).length)()}</td>
                <td style="padding:10px 12px;text-align:right;color:#9ca3af;">${(() => pedidos.filter(ped => p.ids.includes(ped.id) && Math.floor((new Date() - new Date(ped.dataTs)) / (1000*60*60*24)) <= 60).length)()}</td>
                <td style="padding:10px 12px;text-align:right;color:#9ca3af;">${(() => pedidos.filter(ped => p.ids.includes(ped.id) && Math.floor((new Date() - new Date(ped.dataTs)) / (1000*60*60*24)) <= 90).length)()}</td>
                <td style="padding:10px 12px;text-align:right;color:#9ca3af;">${(() => pedidos.filter(ped => p.ids.includes(ped.id) && Math.floor((new Date() - new Date(ped.dataTs)) / (1000*60*60*24)) <= 120).length)()}</td>
                <td style="padding:8px 12px;text-align:right;border-left:1px solid rgba(255,255,255,0.06);">
                  <input type="number" min="0" step="0.01" placeholder="R$ 0,00"
                    value="${custoAtual}"
                    data-ids="${p.ids.join(',')}"
                    class="inp-custo-prod"
                    style="width:90px;background:#1a2744;border:1px solid rgba(251,191,36,0.3);border-radius:6px;padding:5px 8px;color:#fbbf24;font-size:12px;text-align:right;"
                    title="Custo unitário — aplica a todos os ${p.n} pedidos deste produto">
                </td>
                <td style="padding:10px 12px;text-align:right;color:#a78bfa;">${p.liq>0?R$(p.liq):'—'}</td>
                <td style="padding:10px 12px;text-align:right;color:${corMargem(margem)};font-weight:600;">${R$(p.lucro)}</td>
                <td style="padding:10px 12px;text-align:right;">
                  <span style="background:${corMargem(margem)}22;color:${corMargem(margem)};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;">${pct(margem)}</span>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

    // ── Preencher ADS e Lucro pós-ADS ──
    const adEl = sec.querySelector('#dashboard-ads');
    const lpEl = sec.querySelector('#dashboard-lucro-ads');
    const lpPctEl = sec.querySelector('#dashboard-lucro-ads-pct');
    if (adEl) adEl.textContent = totalAds > 0 ? R$(totalAds) : 'Sem dados';
    if (lpEl) {
      const lucroPosAds = t.lucro - totalAds;
      lpEl.textContent = R$(lucroPosAds);
      lpEl.style.color = lucroPosAds >= 0 ? '#22c55e' : '#ef4444';
      if (lpPctEl) {
        const pctAds = t.fat > 0 ? (lucroPosAds/t.fat)*100 : 0;
        lpPctEl.textContent = `Margem: ${pctAds.toFixed(1).replace('.',',')}%`;
      }
    }

    // Bind custo-por-produto inputs
    sec.querySelectorAll('.inp-custo-prod').forEach(inp => {
      inp.addEventListener('change', () => {
        const ids = inp.dataset.ids.split(',');
        const val = parseFloat(inp.value) || 0;
        ids.forEach(id => {
          if (!custos[id]) custos[id] = {};
          custos[id].custo = val;
        });
        salvarCustos();
        inp.style.borderColor = '#34d399';
        setTimeout(async () => { inp.style.borderColor = 'rgba(251,191,36,0.3)'; await renderDashboard(); }, 800);
      });
    });

    // Renderizar comparativo de marketplace (com delay para evitar problemas)
    setTimeout(async () => {
      try {
        await renderMarketplaceComparison();
      } catch(e) {
        console.error('Erro ao renderizar marketplace:', e);
      }
    }, 100);

    // Atualizar ADS e Lucro pós-ADS
    const adsEl = sec.querySelector('#dashboard-ads');
    const adsPctEl = sec.querySelector('#dashboard-ads-pct');
    const lucroAdsEl = sec.querySelector('#dashboard-lucro-ads');
    const lucroAdsPctEl = sec.querySelector('#dashboard-lucro-ads-pct');

    if (adsEl && adsPctEl) {
      const adsPct = t.fat > 0 ? (totalAds / t.fat) * 100 : 0;
      adsEl.textContent = R$(totalAds);
      adsPctEl.textContent = `${adsPct.toFixed(1)}% do faturamento`;
    }
    if (lucroAdsEl && lucroAdsPctEl) {
      const lucroPosAds = t.lucro - totalAds;
      lucroAdsEl.textContent = R$(lucroPosAds);
      lucroAdsEl.style.color = lucroPosAds >= 0 ? '#22c55e' : '#ef4444';
      const pctAds = t.fat > 0 ? (lucroPosAds/t.fat)*100 : 0;
      lucroAdsPctEl.textContent = `Margem: ${pctAds.toFixed(1)}%`;
    }

    // Atualizar métricas de performance (com delay para visitas estarem preenchidas)
    setTimeout(() => {
      // Conversão
      const convEl = sec.querySelector('#card-conversao');
      if (convEl) {
        const totalVisitasText = document.querySelector('#card-visitas')?.textContent || '0';
        const totalVisitas = parseInt(totalVisitasText.replace(/\D/g, '')) || 0;
        const conv = totalVisitas > 0 ? (nVendas / totalVisitas) * 100 : 0;
        convEl.textContent = `${conv.toFixed(2)}%`;
      }

      // Ticket Médio
      const ticketEl = sec.querySelector('#card-ticket');
      if (ticketEl) {
        const ticket = nVendas > 0 ? t.fat / nVendas : 0;
        ticketEl.textContent = R$(ticket);
      }

      // ROI ADS
      const roiEl = sec.querySelector('#card-roi-ads');
      if (roiEl) {
        const roi = totalAds > 0 ? (t.fat / totalAds) : 0;
        roiEl.textContent = roi.toFixed(2) + 'x';
        roiEl.style.color = roi >= 2 ? '#22c55e' : roi >= 1.5 ? '#f59e0b' : '#ef4444';
      }

      // CPM ADS (Custo por 1000 visitas)
      const cpmEl = sec.querySelector('#card-cpm-ads');
      if (cpmEl) {
        const totalVisitasText = document.querySelector('#card-visitas')?.textContent || '0';
        const totalVisitas = parseInt(totalVisitasText.replace(/\D/g, '')) || 1;
        const cpm = totalVisitas > 0 ? (totalAds / (totalVisitas / 1000)) : 0;
        cpmEl.textContent = R$(cpm);
      }
    }, 100);
  }
  }

  function kpiCard(label, val, sub, cor) {
    return `<div class="kpi-card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value" style="color:${cor};font-size:18px;">${val}</div>
      ${sub?`<div class="kpi-sub">${sub}</div>`:''}
    </div>`;
  }

  async function renderMarketplaceComparison() {
    const lista = pedidosFiltrados();
    const ml = lista.filter(p => p.plataforma === 'Mercado Livre');
    const shopee = lista.filter(p => p.plataforma === 'Shopee');

    const mlVendas = ml.length;
    const mlFat = ml.reduce((s,p) => s + (parseFloat(p.valor)||0), 0);
    const shopeeVendas = shopee.length;
    const shopeeFat = shopee.reduce((s,p) => s + (parseFloat(p.valor)||0), 0);

    // Puxar visitas reais da API
    let mlVisitas = 0, shopeeVisitas = 0;
    try {
      // Puxar contas
      const contas = await MarketplaceAPI.listAccounts();

      // ML
      const mlConta = contas.find(c => c.tipo === 'Mercado Livre' || c.tipo === 'ML');
      if (mlConta && mlConta.user_id) {
        mlVisitas = await MarketplaceAPI.mlVisitas(mlConta.user_id, customFrom, customTo);
      }

      // Shopee
      const shopeeConta = contas.find(c => c.tipo === 'Shopee');
      if (shopeeConta && shopeeConta.shop_id) {
        const dias = Math.ceil((new Date(customTo) - new Date(customFrom)) / (1000*60*60*24));
        shopeeVisitas = await MarketplaceAPI.shopeeVisitas(shopeeConta.shop_id, dias);
      }
    } catch(e) {
      console.warn('Erro ao puxar visitas:', e.message);
      // Fallback: estimativa
      mlVisitas = mlFat > 0 ? Math.round(mlVendas / 0.03) : 0;
      shopeeVisitas = shopeeFat > 0 ? Math.round(shopeeVendas / 0.03) : 0;
    }
    const totalVisitas = mlVisitas + shopeeVisitas;
    const totalVendas = mlVendas + shopeeVendas;
    const totalFat = mlFat + shopeeFat;

    // Preencher cards grandes
    document.getElementById('card-visitas').textContent = totalVisitas.toLocaleString('pt-BR');
    document.getElementById('card-visitas-ml').textContent = mlVisitas.toLocaleString('pt-BR');
    document.getElementById('card-visitas-shopee').textContent = shopeeVisitas.toLocaleString('pt-BR');

    document.getElementById('card-vendas').textContent = totalVendas.toLocaleString('pt-BR');
    document.getElementById('card-vendas-ml').textContent = mlVendas.toLocaleString('pt-BR');
    document.getElementById('card-vendas-shopee').textContent = shopeeVendas.toLocaleString('pt-BR');

    document.getElementById('card-fat').textContent = R$(totalFat);
    document.getElementById('card-fat-ml').textContent = R$(mlFat);
    document.getElementById('card-fat-shopee').textContent = R$(shopeeFat);

    // Preencher tabela
    const tableBody = document.getElementById('marketplace-table-body');
    const mlTicket = mlVendas > 0 ? mlFat / mlVendas : 0;
    const shopeeTicket = shopeeVendas > 0 ? shopeeFat / shopeeVendas : 0;

    tableBody.innerHTML = `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.04);background:rgba(245,158,11,0.05);">
        <td style="padding:12px 16px;color:#e5e7eb;font-weight:500;">🟧 Mercado Livre</td>
        <td style="padding:12px 12px;text-align:right;color:#9ca3af;">${mlVisitas.toLocaleString('pt-BR')}</td>
        <td style="padding:12px 12px;text-align:right;color:#9ca3af;">${mlVendas}</td>
        <td style="padding:12px 12px;text-align:right;color:#60a5fa;font-weight:600;">${R$(mlFat)}</td>
        <td style="padding:12px 12px;text-align:right;color:#9ca3af;">${R$(mlTicket)}</td>
      </tr>
      <tr style="border-bottom:1px solid rgba(255,255,255,0.04);background:rgba(249,115,22,0.05);">
        <td style="padding:12px 16px;color:#e5e7eb;font-weight:500;">🟧 Shopee</td>
        <td style="padding:12px 12px;text-align:right;color:#9ca3af;">${shopeeVisitas.toLocaleString('pt-BR')}</td>
        <td style="padding:12px 12px;text-align:right;color:#9ca3af;">${shopeeVendas}</td>
        <td style="padding:12px 12px;text-align:right;color:#60a5fa;font-weight:600;">${R$(shopeeFat)}</td>
        <td style="padding:12px 12px;text-align:right;color:#9ca3af;">${R$(shopeeTicket)}</td>
      </tr>
      <tr style="background:rgba(255,255,255,0.04);">
        <td style="padding:12px 16px;color:#e5e7eb;font-weight:700;">📊 TOTAL</td>
        <td style="padding:12px 12px;text-align:right;color:#e5e7eb;font-weight:700;">${totalVisitas.toLocaleString('pt-BR')}</td>
        <td style="padding:12px 12px;text-align:right;color:#e5e7eb;font-weight:700;">${totalVendas}</td>
        <td style="padding:12px 12px;text-align:right;color:#34d399;font-weight:700;">${R$(totalFat)}</td>
        <td style="padding:12px 12px;text-align:right;color:#e5e7eb;font-weight:700;">${R$(totalVendas > 0 ? totalFat / totalVendas : 0)}</td>
      </tr>
    `;
  }

  // ── KPIs (aba pedidos) ───────────────────────────────────────
  function renderKPIs() {
    const lista = pedidosFiltrados();
    const t = calcTotais(lista);
    const el = document.getElementById('vendas-kpis');
    if (!el) return;
    el.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">💰 Faturamento Bruto</div><div class="kpi-value" style="color:#60a5fa;">${R$(t.fat)}</div><div class="kpi-sub">${lista.length} pedidos</div></div>
      ${t.liq!=null?`<div class="kpi-card"><div class="kpi-label">🏦 Líquido Marketplace</div><div class="kpi-value" style="color:#a78bfa;">${R$(t.liq)}</div><div class="kpi-sub">${t.fat>0?pct(t.liq/t.fat*100):''} do fat.</div></div>`:''}
      <div class="kpi-card"><div class="kpi-label">📦 Custo Produto</div><div class="kpi-value" style="color:#f87171;">${R$(t.custo)}</div></div>
      <div class="kpi-card"><div class="kpi-label">➕ Outros Custos</div><div class="kpi-value" style="color:#f97316;">${R$(t.out)}</div></div>
      <div class="kpi-card"><div class="kpi-label">✅ Lucro Bruto</div><div class="kpi-value" style="color:${corMargem(t.margem)};">${R$(t.lucro)}</div><div class="kpi-sub">Margem: ${pct(t.margem)}</div></div>
    `;
  }

  // ── Render lista ─────────────────────────────────────────────
  function renderLista() {
    if (abaAtiva === 'dashboard') await renderDashboard();
    else renderPedidos();
  }

  function renderPedidos() {
    renderKPIs();
    const lista = pedidosFiltrados();
    const cont  = document.getElementById('vendas-lista');
    if (!cont) return;

    if (!lista.length) {
      cont.innerHTML = `<div style="text-align:center;padding:48px;color:#6b7280;">
        ${pedidos.length ? 'Nenhum pedido para este filtro.' : '⏳ Carregando pedidos...'}
      </div>`;
      return;
    }

    // Agrupa por data
    const grupos = {};
    for (const p of lista) { const k=p.data||'—'; if(!grupos[k])grupos[k]=[]; grupos[k].push(p); }

    cont.innerHTML = Object.entries(grupos).map(([data,peds]) => {
      const t = calcTotais(peds);
      return `
      <div style="margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:12px;padding:8px 16px;background:rgba(255,255,255,0.04);border-radius:8px 8px 0 0;border-bottom:1px solid rgba(255,255,255,0.08);">
          <span style="font-size:13px;font-weight:700;color:#e5e7eb;">📅 ${data}</span>
          <span style="font-size:11px;color:#6b7280;">${peds.length} pedidos</span>
          <span style="margin-left:auto;font-size:12px;color:#60a5fa;font-weight:600;">${R$(t.fat)}</span>
          ${t.liq!=null?`<span style="font-size:12px;color:#a78bfa;">Líq. ${R$(t.liq)}</span>`:''}
          <span style="font-size:12px;font-weight:700;color:${corMargem(t.margem)};">Lucro ${R$(t.lucro)} · ${pct(t.margem)}</span>
        </div>
        <div style="display:grid;grid-template-columns:2fr 50px 105px 105px 90px 90px 90px 90px 80px;padding:6px 16px;background:rgba(255,255,255,0.02);border-bottom:1px solid rgba(255,255,255,0.05);">
          ${['ITEM','QTD','TOTAL','LÍQ. MP','CUSTO PROD.','IMPOSTO','OUTROS','LUCRO','MARGEM'].map((h,i)=>
            `<div style="font-size:10px;color:#6b7280;font-weight:600;text-align:${i<=1?'left':'right'};white-space:nowrap;">${h}</div>`).join('')}
        </div>
        ${peds.map(p => renderRow(p)).join('')}
      </div>`;
    }).join('');

    // Event listeners
    cont.querySelectorAll('.btn-exp').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        expandido = expandido===btn.dataset.id ? null : btn.dataset.id;
        renderPedidos();
      });
    });
    cont.querySelectorAll('.inp-custo').forEach(inp => {
      inp.addEventListener('change', () => {
        if (!custos[inp.dataset.id]) custos[inp.dataset.id]={};
        custos[inp.dataset.id][inp.dataset.campo] = parseFloat(inp.value)||0;
        salvarCustos(); renderPedidos();
      });
      inp.addEventListener('click', e => e.stopPropagation());
    });
    cont.querySelectorAll('.row-click').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.dataset.id;
        expandido = expandido===id ? null : id;
        renderPedidos();
      });
    });
  }

  function renderRow(p) {
    const l   = calcLucro(p);
    const c   = custos[p.id]||{};
    const exp = expandido===p.id;
    const cor = platCor[p.plataforma]||'#9ca3af';
    const img = p.imagem
      ? `<img src="${p.imagem}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0;" onerror="this.style.display='none'">`
      : `<div style="width:44px;height:44px;background:rgba(255,255,255,0.07);border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px;">${p.plataforma==='Shopee'?'🟠':'🟡'}</div>`;

    const taxasAuto = p.taxas != null; // tem dados automáticos da API
    const impVeioDeAPI = taxasAuto && (p.taxas?.imposto != null) && parseFloat(p.taxas?.imposto) > 0;

    // Imposto: badge diferente se veio da API real ou da alíquota da conta
    const aliqConta = parseFloat(aliquotas[p.contaId] || 0);
    const impCell = taxasAuto
      ? `<div style="text-align:right;">
           <span style="font-size:12px;color:#fbbf24;font-weight:600;">${R$(l.impVal)}</span><br>
           <span style="font-size:9px;color:#6b7280;">${impVeioDeAPI ? 'escrow' : (l.impPct ? l.impPct+'% conta' : 'escrow')}</span>
         </div>`
      : `<div style="text-align:right;" onclick="event.stopPropagation()">
           <div style="display:flex;align-items:center;justify-content:flex-end;gap:2px;">
             <input type="number" min="0" max="100" step="0.1" placeholder="${aliqConta||'0'}" value="${c.imposto||''}" data-id="${p.id}" data-campo="imposto" class="inp-custo"
               style="width:50px;background:#1a2744;border:1px solid rgba(255,255,255,0.12);border-radius:5px;padding:4px 6px;color:white;font-size:12px;text-align:right;">
             <span style="color:#6b7280;font-size:10px;">%</span>
           </div>
           ${aliqConta && !c.imposto ? `<div style="font-size:9px;color:#fbbf24;text-align:right;">${aliqConta}% (conta)</div>` : ''}
         </div>`;

    const liqCell = l.liquido != null
      ? `<div style="text-align:right;font-size:13px;font-weight:700;color:#a78bfa;">${R$(l.liquido)}<br><span style="font-size:9px;color:#6b7280;font-weight:400;">após taxas</span></div>`
      : `<div style="text-align:right;font-size:12px;color:#4b5563;">—</div>`;

    return `
    <div style="border-bottom:1px solid rgba(255,255,255,0.04);">
      <div class="row-click" data-id="${p.id}" style="display:grid;grid-template-columns:2fr 50px 105px 105px 90px 90px 90px 90px 80px;padding:10px 16px;align-items:center;cursor:pointer;transition:background .15s;"
           onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background=''">

        <!-- Item -->
        <div style="display:flex;align-items:center;gap:10px;min-width:0;">
          ${img}
          <div style="min-width:0;">
            <div style="font-size:12px;font-weight:600;color:#e5e7eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;" title="${(p.produto||'').replace(/"/g,'&quot;')}">${p.produto||'—'}</div>
            <div style="font-size:10px;color:#6b7280;margin-top:2px;display:flex;gap:6px;align-items:center;">
              <span style="color:${cor};font-weight:600;">${p.plataforma}</span>
              <span>${p.id}</span>
              ${taxasAuto ? '<span style="background:rgba(167,139,250,0.15);color:#a78bfa;padding:1px 5px;border-radius:8px;font-size:9px;">taxas auto</span>' : ''}
            </div>
          </div>
        </div>

        <!-- Qtd -->
        <div style="text-align:center;font-size:13px;color:#d1d5db;">${p.qtd||1}</div>

        <!-- Total bruto -->
        <div style="text-align:right;font-size:13px;font-weight:700;color:#60a5fa;">${R$(l.receita)}</div>

        <!-- Líquido MP -->
        ${liqCell}

        <!-- Custo Produto (manual) -->
        <div style="text-align:right;" onclick="event.stopPropagation()">
          <input type="number" min="0" step="0.01" placeholder="0,00" value="${c.custo||''}" data-id="${p.id}" data-campo="custo" class="inp-custo"
            style="width:80px;background:#1a2744;border:1px solid rgba(255,255,255,0.12);border-radius:5px;padding:4px 6px;color:white;font-size:12px;text-align:right;">
        </div>

        <!-- Imposto -->
        ${impCell}

        <!-- Outros (manual) -->
        <div style="text-align:right;" onclick="event.stopPropagation()">
          <input type="number" min="0" step="0.01" placeholder="0,00" value="${c.outros||''}" data-id="${p.id}" data-campo="outros" class="inp-custo"
            style="width:80px;background:#1a2744;border:1px solid rgba(255,255,255,0.12);border-radius:5px;padding:4px 6px;color:white;font-size:12px;text-align:right;">
        </div>

        <!-- Lucro -->
        <div style="text-align:right;font-size:13px;font-weight:700;color:${corMargem(l.margem)};">${R$(l.lucro)}</div>

        <!-- Margem -->
        <div style="text-align:right;">
          <span style="background:${corMargem(l.margem)}22;color:${corMargem(l.margem)};padding:3px 8px;border-radius:20px;font-size:11px;font-weight:700;">${pct(l.margem)}</span>
          <button class="btn-exp" data-id="${p.id}" style="display:none;"></button>
        </div>
      </div>

      ${exp ? renderDetalhe(p, l) : ''}
    </div>`;
  }

  function renderDetalhe(p, l) {
    const tx = p.taxas||{};
    const hasEscrow = p.taxas != null;

    const impDeEscrowDetalhe = hasEscrow && tx.imposto != null && parseFloat(tx.imposto) > 0;
    const isML = p.plataforma === 'Mercado Livre';

    // Para ML: total de taxas = total - net_received. A API não dá o breakdown exato (sale_fee é parcial).
    // Para Shopee: temos comissao + taxaServico + frete + voucher separados do escrow.
    let linhasBreakdown;
    if (hasEscrow && isML) {
      const comissaoML = l.comissao || 0;           // sale_fee da API (pode ser parcial)
      const freteML    = tx.frete   || 0;           // list_cost do shipment
      const totalConhecido = comissaoML + freteML;
      // Se net_received existe, calcula se há outras taxas não mapeadas
      const outrasML = l.liquido != null
        ? Math.max(0, (l.receita - l.liquido) - totalConhecido)
        : 0;
      linhasBreakdown = [
        { label:'💰 Total do Pedido (comprador)',   v: l.receita,        cor:'#60a5fa', sinal:'+' },
        comissaoML>0 ? { label:'🏦 Comissão ML',    v: -comissaoML,      cor:'#f87171', sinal:'-' } : null,
        freteML>0    ? { label:'🚚 Frete (vendedor)',v: -freteML,         cor:'#f97316', sinal:'-' } : null,
        outrasML>0.01? { label:'➕ Outras taxas ML', v: -outrasML,        cor:'#f87171', sinal:'-' } : null,
        l.liquido!=null? { label:'💳 Líquido ML (net_received)', v: l.liquido, cor:'#a78bfa', sinal:'=', bold:true } : null,
        { label:'📦 Custo do Produto',               v: -l.custo,         cor:'#f87171', sinal:'-' },
        l.impVal>0 ? { label:`🧾 Imposto (${l.impPct}%)`,  v: -l.impVal,  cor:'#fbbf24', sinal:'-' } : null,
        l.outros>0 ? { label:'➕ Outros Custos',     v: -l.outros,        cor:'#f97316', sinal:'-' } : null,
        l.extra>0  ? { label:'🔗 Linhas Extras',    v: -l.extra,         cor:'#a78bfa', sinal:'-' } : null,
        { label:'✅ Lucro Bruto',                    v: l.lucro,          cor:corMargem(l.margem), sinal: l.lucro>=0?'+':'-', bold:true },
      ].filter(Boolean);
    } else if (hasEscrow) {
      // Shopee: breakdown completo via escrow
      linhasBreakdown = [
        { label:'💰 Valor dos Produtos',           v: l.receita,            cor:'#60a5fa', sinal:'+' },
        (p.freteComprador||0)>0 ? { label:'🛒 Frete pago pelo comprador (não soma)', v: p.freteComprador, cor:'#6b7280', sinal:'·' } : null,
        l.comissao>0   ? { label:'🏦 Comissão Shopee',            v: -l.comissao,          cor:'#f87171', sinal:'-' } : null,
        l.taxaServico>0? { label:'⚙️ Taxa de Serviço',             v: -l.taxaServico,       cor:'#f87171', sinal:'-' } : null,
        tx.frete>0     ? { label:'🚚 Frete (descontado)',           v: -Math.abs(tx.frete),  cor:'#f97316', sinal:'-' } : null,
        tx.voucher>0   ? { label:'🎟️ Voucher (reembolso)',          v: tx.voucher,           cor:'#34d399', sinal:'+' } : null,
        impDeEscrowDetalhe ? { label:'🧾 Imposto (escrow)',         v: -tx.imposto,          cor:'#fbbf24', sinal:'-' } : null,
        l.liquido!=null? { label:'💳 Líquido Shopee (escrow)',       v: l.liquido,            cor:'#a78bfa', sinal:'=', bold:true } : null,
        { label:'📦 Custo do Produto',              v: -l.custo,             cor:'#f87171', sinal:'-' },
        !impDeEscrowDetalhe && l.impVal>0 ? { label:`🧾 Imposto (${l.impPct}%)`, v: -l.impVal, cor:'#fbbf24', sinal:'-' } : null,
        l.outros>0 ? { label:'➕ Outros Custos',    v: -l.outros,            cor:'#f97316', sinal:'-' } : null,
        l.extra>0  ? { label:'🔗 Linhas Extras',   v: -l.extra,             cor:'#a78bfa', sinal:'-' } : null,
        { label:'✅ Lucro Bruto',                   v: l.lucro,              cor:corMargem(l.margem), sinal: l.lucro>=0?'+':'-', bold:true },
      ].filter(Boolean);
    } else {
      linhasBreakdown = [
        { label:'💰 Total do Pedido',               v: l.receita,            cor:'#60a5fa', sinal:'+' },
        { label:'📦 Custo do Produto',              v: -l.custo,             cor:'#f87171', sinal:'-' },
        l.impVal>0 ? { label:`🧾 Imposto (${l.impPct}%)`, v: -l.impVal,     cor:'#fbbf24', sinal:'-' } : null,
        l.outros>0 ? { label:'➕ Outros Custos',    v: -l.outros,            cor:'#f97316', sinal:'-' } : null,
        l.extra>0  ? { label:'🔗 Linhas Extras',   v: -l.extra,             cor:'#a78bfa', sinal:'-' } : null,
        { label:'✅ Lucro Bruto',                   v: l.lucro,              cor:corMargem(l.margem), sinal: l.lucro>=0?'+':'-', bold:true },
      ].filter(Boolean);
    }

    return `
    <div style="display:flex;background:rgba(255,255,255,0.02);border-top:1px solid rgba(255,255,255,0.06);">
      <!-- Info + itens -->
      <div style="flex:1;padding:16px 20px;border-right:1px solid rgba(255,255,255,0.06);min-width:0;">
        <div style="font-size:10px;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:10px;">Detalhes do Pedido</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
          <div><div style="font-size:10px;color:#6b7280;">ID</div><div style="font-size:12px;color:#e5e7eb;">${p.id}</div></div>
          <div><div style="font-size:10px;color:#6b7280;">Plataforma</div><div style="font-size:12px;color:${platCor[p.plataforma]||'#fff'};font-weight:600;">${p.plataforma}</div></div>
          <div><div style="font-size:10px;color:#6b7280;">Data</div><div style="font-size:12px;color:#e5e7eb;">${p.data}</div></div>
          <div><div style="font-size:10px;color:#6b7280;">Status</div><div style="font-size:12px;color:#e5e7eb;">${p.status||'—'}</div></div>
          ${tx.instalment ? `<div><div style="font-size:10px;color:#6b7280;">Parcelamento</div><div style="font-size:12px;color:#e5e7eb;">${tx.instalment}</div></div>` : ''}
        </div>
        ${p.itens && p.itens.length ? `
        <div style="font-size:10px;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:8px;">Itens</div>
        ${p.itens.map(it=>`
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            ${it.imagem?`<img src="${it.imagem}" style="width:36px;height:36px;object-fit:cover;border-radius:5px;flex-shrink:0;">` : ''}
            <div style="flex:1;font-size:12px;color:#d1d5db;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${it.nome}</div>
            <div style="font-size:11px;color:#9ca3af;flex-shrink:0;">x${it.qtd}</div>
            <div style="font-size:12px;color:#60a5fa;font-weight:600;flex-shrink:0;">${R$(it.preco)}</div>
          </div>`).join('')}` : ''}
      </div>
      <!-- Breakdown financeiro -->
      <div style="width:300px;flex-shrink:0;padding:16px 20px;">
        <div style="font-size:10px;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:10px;">
          Composição do Lucro ${hasEscrow ? '<span style="color:#a78bfa;font-size:9px;background:rgba(167,139,250,0.15);padding:1px 6px;border-radius:8px;margin-left:4px;">dados da API</span>' : ''}
        </div>
        ${linhasBreakdown.map(r=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="font-size:12px;${r.bold?'font-weight:700;color:#e5e7eb;':'color:#9ca3af;'}">${r.label}</span>
            <span style="font-size:13px;font-weight:${r.bold?'800':'600'};color:${r.cor};">
              ${r.sinal==='='?'= ':r.sinal==='+'?'+':'-'}${R$(Math.abs(r.v))}
            </span>
          </div>`).join('')}
        <div style="margin-top:10px;padding-top:10px;border-top:2px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:12px;color:#9ca3af;">Margem s/ receita</span>
          <span style="font-size:18px;font-weight:800;color:${corMargem(l.margem)};">${pct(l.margem)}</span>
        </div>
      </div>
    </div>`;
  }


  // ── Buscar pedidos ───────────────────────────────────────────
  async function buscarPedidos() {
    const apiKey = localStorage.getItem('glr_mc_apikey')||'';
    const statusEl = document.getElementById('vendas-status');
    const btnEl    = document.getElementById('btn-buscar');
    if (!apiKey) { if(statusEl) statusEl.textContent='⚠️ Configure a API Key nas Integrações.'; return; }
    if (btnEl)    { btnEl.disabled=true; btnEl.textContent='⏳ Buscando...'; }
    if (statusEl) statusEl.textContent='Conectando...';

    try {
      const r      = await MarketplaceAPI.call('list_accounts');
      const contas = r.data?.accounts||[];
      let dataFrom, dataTo;
      if (filtroPeriodo==='custom') { dataFrom=customFrom; dataTo=customTo; }
      else {
        const dias=parseInt(filtroPeriodo)||30;
        dataTo=fmtDate(ontem);
        const d=new Date(ontem); d.setDate(ontem.getDate()-dias+1);
        dataFrom=fmtDate(d);
      }

      pedidos = [];

      for (const conta of contas) {
        // ── Mercado Livre ──
        if (['meli','ml','mercadolivre'].includes(conta.marketplace)) {
          if (statusEl) statusEl.textContent='Buscando Mercado Livre...';
          const orders = await MarketplaceAPI.mlOrders(
            conta.param_to_use?.meliUserId||conta.external_id, dataFrom, dataTo
          );
          const mlPedidos = [];
          for (const o of orders) {
            // Exclui cancelados/inválidos do faturamento
            if (['cancelled','invalid'].includes((o.status||'').toLowerCase())) continue;
            const dt = new Date((o.date_created||'').replace('T',' ').replace(/\..*/,''));
            const itens = (o.order_items||[]).map(i=>({
              nome:  i.item?.title||'—', qtd: i.quantity||1,
              preco: parseFloat(i.unit_price)||0, imagem: '',
              itemId: i.item?.id||'',
              saleFee: parseFloat(i.sale_fee)||0,
            }));
            const totalAmount = parseFloat(o.total_amount)||0;
            const comissaoML = itens.reduce((s,i)=>s+i.saleFee, 0);
            const paymentId  = o.payments?.[0]?.id || null;
            const shippingId = o.shipping?.id || null;

            mlPedidos.push({
              id: String(o.id), plataforma:'Mercado Livre',
              contaId: conta.external_id,
              data:   isNaN(dt)?'—':dt.toLocaleDateString('pt-BR'),
              dataTs: new Date(o.date_created||0).getTime(),
              produto: itens[0]?.nome||'—', imagem: '',
              qtd: itens.reduce((s,i)=>s+i.qtd,0),
              valor: totalAmount, status: o.status||'',
              paymentId, shippingId,
              itens,
              taxas: {
                liquido:     null,  // preenchido pelo /collections
                comissao:    comissaoML,
                taxaServico: 0,
                imposto:     0,     // ML não retém → alíquota da conta
                frete:       null,  // preenchido pelo /shipments
                voucher:     0,
              },
            });
          }

          // Buscar em paralelo: thumbnails + net_received (liquido) + frete
          if (statusEl) statusEl.textContent='Buscando detalhes ML (taxas, frete, imagens)...';

          const itemIdsUnicos = [...new Set(mlPedidos.flatMap(p=>p.itens.map(i=>i.itemId)).filter(Boolean))];
          const thumbMap = {};
          const collectionsMap = {}; // paymentId → net_received_amount
          const freteMap = {};       // shippingId → list_cost

          await Promise.allSettled([
            // Thumbnails por item único
            ...itemIdsUnicos.map(async itemId => {
              try {
                const r = await MarketplaceAPI.call('get_item', { itemId });
                const thumb = r.data?.thumbnail || r.data?.pictures?.[0]?.secure_url || '';
                if (thumb) thumbMap[itemId] = thumb;
              } catch(e) {}
            }),
            // Liquido real via /collections/{paymentId}
            ...mlPedidos.filter(p=>p.paymentId).map(async p => {
              try {
                const r = await MarketplaceAPI.call('raw', { method:'GET', path:`/collections/${p.paymentId}` });
                const net = parseFloat(r.data?.net_received_amount);
                if (!isNaN(net)) collectionsMap[p.paymentId] = net;
              } catch(e) {}
            }),
            // Frete vendedor via /shipments/{shippingId}
            ...mlPedidos.filter(p=>p.shippingId).map(async p => {
              try {
                const r = await MarketplaceAPI.call('raw', { method:'GET', path:`/shipments/${p.shippingId}` });
                const s = r.data || {};
                const listCost = parseFloat(s.shipping_option?.list_cost);
                const baseCost = parseFloat(s.base_cost);
                freteMap[p.shippingId] = !isNaN(listCost) ? listCost : (!isNaN(baseCost) ? baseCost : 0);
              } catch(e) {}
            }),
          ]);

          // Aplicar dados buscados em cada pedido
          for (const p of mlPedidos) {
            const firstItemId = p.itens[0]?.itemId;
            if (firstItemId && thumbMap[firstItemId]) {
              p.imagem = thumbMap[firstItemId];
              p.itens.forEach(i => { i.imagem = thumbMap[i.itemId] || ''; });
            }
            if (p.paymentId && collectionsMap[p.paymentId] != null) {
              p.taxas.liquido = collectionsMap[p.paymentId];
            } else if (p.taxas.comissao > 0) {
              // fallback: total - comissao
              p.taxas.liquido = p.valor - p.taxas.comissao;
            }
            if (p.shippingId && freteMap[p.shippingId] != null) {
              p.taxas.frete = freteMap[p.shippingId];
            }
          }
          pedidos.push(...mlPedidos);
        }

        // ── Shopee ── (shopee_list_orders: intervalo exato, paginado, sem corte de 500)
        if (conta.marketplace==='shopee') {
          const shopId = conta.param_to_use?.shopId||conta.external_id;
          if (statusEl) statusEl.textContent='Shopee: listando pedidos...';
          const tsFromSh = Math.floor(new Date(`${dataFrom}T00:00:00`).getTime()/1000);
          const tsToSh   = Math.floor(new Date(`${dataTo}T23:59:59`).getTime()/1000);
          const sns = await MarketplaceAPI.shopeeListOrderSns(shopId, tsFromSh, tsToSh);

          // Detalhes (valor, data, status, itens) em lotes de 50
          if (statusEl) statusEl.textContent=`Shopee: produtos (${sns.length} pedidos)...`;
          const uniq=[];
          const detMap={};
          for (let i=0;i<sns.length;i+=50) {
            const lote=sns.slice(i,i+50).map(o=>o.sn);
            try {
              const rd=await MarketplaceAPI.call('shopee_get_order_detail',{shopId,order_sn_list:lote});
              const lista=rd.data?.response?.order_list||[];
              for (const ord of lista) {
                const itens=(ord.item_list||[]).map(it=>({
                  nome: it.item_name||'—', qtd: it.model_quantity_purchased||1,
                  preco: parseFloat(it.model_discounted_price)||0, imagem: it.image_info?.image_url||'',
                }));
                detMap[ord.order_sn]={ itens, imagem:itens[0]?.imagem||'', produto:itens.length>1?`${itens[0].nome} (+${itens.length-1})`:(itens[0]?.nome||'—') };
                const dt = ord.create_time?new Date(ord.create_time*1000):null;
                // Faturamento = só produtos. Frete do comprador fica separado (não soma).
                const totalPedido = parseFloat(ord.total_amount)||0;
                const subtotal    = itens.reduce((s,it)=>s+it.preco*it.qtd,0);
                uniq.push({
                  id: ord.order_sn, plataforma:'Shopee',
                  contaId: conta.external_id,
                  data:   dt?dt.toLocaleDateString('pt-BR'):'—',
                  dataTs: (ord.create_time||0)*1000,
                  produto:'…', imagem:'',
                  qtd: itens.reduce((s,it)=>s+it.qtd,0)||1,
                  valor: subtotal>0 ? subtotal : totalPedido,
                  valorTotal: totalPedido,
                  freteComprador: Math.max(0, totalPedido - subtotal),
                  status: ord.order_status||'', itens:[], taxas:{},
                });
              }
            } catch(e){ console.warn('detail batch',e); }
          }

          // Busca escrow (taxas) em lotes de 50
          // A API retorna lista na mesma ordem do input — mapeamos por índice
          if (statusEl) statusEl.textContent=`Shopee: taxas (${uniq.length} pedidos)...`;
          const escrowMap={};
          const parseEscrow = oi => ({
            liquido:     parseFloat(oi.escrow_amount)||0,
            comissao:    parseFloat(oi.commission_fee)||0,
            taxaServico: parseFloat(oi.service_fee)||0,
            imposto:     parseFloat(oi.escrow_tax)||0,
            frete:       Math.abs(parseFloat(oi.final_shipping_fee)||0),
            voucher:     parseFloat(oi.voucher_from_shopee)||0,
            instalment:  oi.instalment_plan||'',
          });
          for (let i=0;i<uniq.length;i+=50) {
            const lote = uniq.slice(i,i+50);
            const sns  = lote.map(o=>o.id);
            try {
              const re   = await MarketplaceAPI.call('shopee_get_escrow_detail_batch',{shopId,order_sn_list:sns});
              // response é array sem order_sn — mapeia por posição
              const lista = re.data?.response || re.data?.result_list || [];
              lista.forEach((item, idx) => {
                const oi  = item.escrow_detail?.order_income || item.order_income || {};
                const sn  = sns[idx];
                if (sn) escrowMap[sn] = parseEscrow(oi);
              });
            } catch(e){
              console.warn('escrow batch falhou, tentando individual...',e);
              for (const sn of sns) {
                try {
                  const re2 = await MarketplaceAPI.call('shopee_get_escrow_detail',{shopId,order_sn:sn});
                  const oi  = re2.data?.response?.order_income||{};
                  escrowMap[sn] = parseEscrow(oi);
                } catch(e2){ console.warn('escrow individual',sn,e2); }
              }
            }
          }

          for (const o of uniq) {
            const d=detMap[o.id]||{}; const e=escrowMap[o.id];
            o.produto = d.produto||o.id;
            o.imagem  = d.imagem||'';
            o.itens   = d.itens||[];
            o.taxas   = e||null;
            pedidos.push(o);
          }
        }
      }

      pedidos.sort((a,b)=>b.dataTs-a.dataTs);
      salvarCache(dataFrom, dataTo);
      const nTaxas = pedidos.filter(p=>p.taxas!=null).length;
      if (statusEl) statusEl.innerHTML=`${pedidos.length} pedidos · ${dataFrom} a ${dataTo} · ${nTaxas} com taxas &nbsp;<span style="font-size:10px;background:rgba(16,185,129,0.15);color:#10b981;padding:1px 7px;border-radius:8px;">💾 salvo</span>`;
      renderLista();

    } catch(e) {
      if (statusEl) statusEl.textContent=`Erro: ${e.message}`;
    } finally {
      if (btnEl){ btnEl.disabled=false; btnEl.textContent='🔄 Atualizar'; }
    }
  }

  // ── Funções globais ──────────────────────────────────────────
  window.adicionarLinhaExtra = () => {
    const nome=document.getElementById('inp-linha-nome')?.value?.trim();
    const valor=document.getElementById('inp-linha-valor')?.value;
    const tipo=document.getElementById('sel-linha-tipo')?.value;
    if (!nome||!valor){ alert('Preencha nome e valor.'); return; }
    linhasExt.push({id:Date.now().toString(),nome,valor:parseFloat(valor),tipo});
    salvarLinhas(); renderLinhasExtras(); renderPedidos();
    document.getElementById('inp-linha-nome').value='';
    document.getElementById('inp-linha-valor').value='';
  };
  window.removerLinhaExtra = id => {
    linhasExt=linhasExt.filter(l=>l.id!==id);
    salvarLinhas(); renderLinhasExtras(); renderPedidos();
  };
  window.aplicarCustoGlobal = () => {
    const custo=parseFloat(document.getElementById('inp-global-custo')?.value)||0;
    const imp=parseFloat(document.getElementById('inp-global-imposto')?.value)||0;
    const out=parseFloat(document.getElementById('inp-global-outros')?.value)||0;
    if (!custo&&!imp&&!out){ alert('Preencha ao menos um valor.'); return; }
    for (const p of pedidosFiltrados()) {
      if (!custos[p.id]) custos[p.id]={};
      if (custo) custos[p.id].custo=custo;
      if (imp)   custos[p.id].imposto=imp;
      if (out)   custos[p.id].outros=out;
    }
    salvarCustos(); renderPedidos();
    alert(`Aplicado a ${pedidosFiltrados().length} pedidos!`);
  };

  function renderLinhasExtras() {
    const el=document.getElementById('linhas-extras-lista');
    if (!el) return;
    el.innerHTML=!linhasExt.length
      ? `<div style="color:#6b7280;font-size:13px;padding:6px 0;">Nenhuma linha extra.</div>`
      : linhasExt.map(l=>`
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
          <span style="flex:1;font-size:13px;color:#e5e7eb;">${l.nome}</span>
          <span style="font-size:12px;color:#9ca3af;">${l.tipo==='pct'?l.valor+'%':'R$ '+parseFloat(l.valor).toLocaleString('pt-BR',{minimumFractionDigits:2})}</span>
          <span style="font-size:10px;color:#6b7280;background:rgba(255,255,255,0.08);padding:1px 6px;border-radius:8px;">${l.tipo==='pct'?'% pedido':'fixo'}</span>
          <button onclick="window.removerLinhaExtra('${l.id}')" style="background:rgba(239,68,68,0.15);border:none;color:#ef4444;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:12px;">✕</button>
        </div>`).join('');
  }

  // ── HTML ─────────────────────────────────────────────────────
  el.innerHTML = `<div class="page">
    <!-- Cabeçalho + Filtros -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="section-title" style="font-size:20px;">🛒 Vendas</div>
        <div id="vendas-status" style="font-size:12px;color:#6b7280;margin-top:4px;">Carregando...</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <select id="sel-periodo" class="form-input" style="width:155px;">
          <option value="7">Últimos 7 dias</option>
          <option value="14">Últimos 14 dias</option>
          <option value="30">Últimos 30 dias</option>
          <option value="60">Últimos 60 dias</option>
          <option value="90">Últimos 90 dias</option>
          <option value="custom" selected>📅 Personalizado</option>
        </select>
        <div id="custom-range" style="display:flex;align-items:center;gap:6px;">
          <input type="date" id="inp-date-from" class="form-input" value="${customFrom}" style="width:140px;padding:7px 10px;">
          <span style="color:#9ca3af;">até</span>
          <input type="date" id="inp-date-to" class="form-input" value="${customTo}" style="width:140px;padding:7px 10px;">
        </div>
        <select id="sel-plat" class="form-input" style="width:155px;">
          <option value="todas">Todas plataformas</option>
          <option value="Mercado Livre">🟡 Mercado Livre</option>
          <option value="Shopee">🟠 Shopee</option>
        </select>
        <button id="btn-buscar" class="btn-primary" style="padding:8px 16px;">🔄 Atualizar</button>
      </div>
    </div>

    <!-- Abas -->
    <div style="display:flex;gap:8px;margin-bottom:20px;">
      <button id="tab-dashboard" style="padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:13px;background:#6366f1;color:white;">📊 Dashboard</button>
      <button id="tab-pedidos"   style="padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:13px;background:rgba(255,255,255,0.06);color:#9ca3af;">📋 Pedidos</button>
    </div>

    <!-- Aba Dashboard -->
    <div id="sec-dashboard">
      <div style="text-align:center;padding:48px;color:#6b7280;">Carregando dashboard...</div>
    </div>

    <!-- Aba Pedidos -->
    <div id="sec-pedidos" style="display:none;">
      <div id="vendas-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px;"></div>

      <details style="margin-bottom:16px;">
        <summary style="cursor:pointer;padding:10px 16px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:13px;color:#d1d5db;font-weight:600;list-style:none;display:flex;align-items:center;gap:8px;">
          ⚙️ Configurações de Custo
          <span style="font-size:11px;color:#6b7280;font-weight:400;">Linhas extras e aplicação em massa</span>
        </summary>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px;">
          <div class="card">
            <div class="section-title mb-10" style="font-size:13px;">➕ Linhas de Custo Extra (por pedido)</div>
            <div id="linhas-extras-lista" style="margin-bottom:12px;"></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end;">
              <input id="inp-linha-nome" class="form-input" placeholder="Nome (ex: Taxa ML)" style="flex:2;min-width:100px;">
              <input id="inp-linha-valor" class="form-input" type="number" min="0" step="0.01" placeholder="Valor" style="flex:1;min-width:70px;">
              <select id="sel-linha-tipo" class="form-input" style="flex:1;min-width:90px;">
                <option value="pct">% por pedido</option>
                <option value="fixo">Valor fixo</option>
              </select>
              <button onclick="adicionarLinhaExtra()" class="btn-primary" style="padding:7px 12px;">+ Add</button>
            </div>
          </div>
          <div class="card">
            <div class="section-title mb-10" style="font-size:13px;">⚡ Aplicar em Massa</div>
            <div style="font-size:11px;color:#6b7280;margin-bottom:10px;">Aplica custo a todos os pedidos filtrados.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px;">
              <div><div style="font-size:10px;color:#9ca3af;margin-bottom:3px;">Custo Prod. (R$)</div><input id="inp-global-custo" class="form-input" type="number" min="0" step="0.01" placeholder="0,00" style="width:100%;box-sizing:border-box;"></div>
              <div><div style="font-size:10px;color:#9ca3af;margin-bottom:3px;">Imposto (%)</div><input id="inp-global-imposto" class="form-input" type="number" min="0" max="100" step="0.1" placeholder="0" style="width:100%;box-sizing:border-box;"></div>
              <div><div style="font-size:10px;color:#9ca3af;margin-bottom:3px;">Outros (R$)</div><input id="inp-global-outros" class="form-input" type="number" min="0" step="0.01" placeholder="0,00" style="width:100%;box-sizing:border-box;"></div>
            </div>
            <button onclick="aplicarCustoGlobal()" class="btn-primary" style="padding:7px 16px;">⚡ Aplicar a todos</button>
          </div>
        </div>
      </details>

      <div class="card" style="padding:0;overflow:hidden;">
        <div id="vendas-lista" style="padding:24px;text-align:center;color:#6b7280;">Carregando pedidos...</div>
      </div>
    </div>
  </div>`;

  document.getElementById('sel-periodo').addEventListener('change', e => {
    filtroPeriodo=e.target.value;
    document.getElementById('custom-range').style.display=filtroPeriodo==='custom'?'flex':'none';
  });
  document.getElementById('sel-plat').addEventListener('change', e => { filtroPlat=e.target.value; renderLista(); });
  document.getElementById('inp-date-from').addEventListener('change', e => { customFrom=e.target.value; });
  document.getElementById('inp-date-to').addEventListener('change',   e => { customTo=e.target.value; });
  document.getElementById('btn-buscar').addEventListener('click', buscarPedidos);
  document.getElementById('tab-dashboard').addEventListener('click', () => setAba('dashboard'));
  document.getElementById('tab-pedidos').addEventListener('click',   () => setAba('pedidos'));

  renderLinhasExtras();

  // Ao abrir a página: usa cache se existir para o período atual, senão busca
  (() => {
    let dataFrom, dataTo;
    if (filtroPeriodo === 'custom') { dataFrom = customFrom; dataTo = customTo; }
    else {
      const dias = parseInt(filtroPeriodo) || 30;
      dataTo = fmtDate(ontem);
      const d = new Date(ontem); d.setDate(ontem.getDate() - dias + 1);
      dataFrom = fmtDate(d);
    }
    const at = carregarCache(dataFrom, dataTo);
    if (at) {
      custos = JSON.parse(localStorage.getItem(STORAGE_CUSTOS)||'{}'); // recarrega por garantia
      const nTaxas = pedidos.filter(p=>p.taxas!=null).length;
      const statusEl = document.getElementById('vendas-status');
      if (statusEl) statusEl.innerHTML = `${pedidos.length} pedidos · ${dataFrom} a ${dataTo} · ${nTaxas} com taxas &nbsp;<span style="font-size:10px;background:rgba(99,102,241,0.2);color:#a5b4fc;padding:1px 7px;border-radius:8px;">📦 cache ${fmtAgo(at)}</span>`;
      renderLista();
    } else {
      buscarPedidos();
    }
  })();
});
