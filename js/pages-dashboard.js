// ============================================================
// GLR Consultoria — Dashboard (Executivo + Diretoria unificados)
// ============================================================

// ---- Helpers visuais ----
function sparkline(data, color = '#6366f1') {
  const max = Math.max(...data);
  return `<div class="sparkline">${data.map(v => `
    <div class="spark-bar" style="height:${Math.round((v/max)*100)}%;background:${color};opacity:0.8;"></div>
  `).join('')}</div>`;
}

function delta(val, suffix = '%') {
  const up = val >= 0;
  return `<span class="kpi-delta ${up ? 'up' : 'down'}">
    ${up ? '▲' : '▼'} ${Math.abs(val)}${suffix}
  </span>`;
}

function scoreColor(s) {
  if (s >= 80) return '#10b981';
  if (s >= 60) return '#6366f1';
  if (s >= 40) return '#f59e0b';
  return '#ef4444';
}

// ---- Dashboard (Executivo + Diretoria fundidos numa página só) ----
// Fonte de dados: glr_analytics_dados (cache do Painel Executivo do Analytics,
// que já tem busca real via API com botão "Atualizar dados" funcional) — não
// depende mais do cache do Financeiro, que ficava velho e deixava o dashboard
// parecendo vazio.
function _dashAnalyticsCache() {
  try { return JSON.parse(localStorage.getItem('glr_analytics_dados') || 'null'); } catch(e) { return null; }
}

function _dashStatusDe(compMesAnt, pctMeta) {
  if (compMesAnt == null && pctMeta == null) return 'ativo';
  if (pctMeta != null && pctMeta < 80) return 'risco';
  if (compMesAnt != null && compMesAnt <= -10) return 'queda';
  if (compMesAnt != null && compMesAnt >= 10) return 'crescimento';
  return 'ativo';
}

// Junta o cache do Analytics com o cadastro de clientes (gestor, valorPorVenda etc.)
function computarClientesAPI() {
  const cache = _dashAnalyticsCache();
  const porCliente = {};
  (cache?.dados || []).forEach(d => { porCliente[d.clienteId] = d; });

  return GLR.clientes.map(c => {
    const d = porCliente[c.id];
    const temAPI = !!d?.temConta;
    const faturamento = d ? d.projecao : (c.faturamento || 0);
    const crescimento = d?.compMesAnt != null ? parseFloat(d.compMesAnt.toFixed(1)) : (c.crescimento || 0);
    const status = d ? _dashStatusDe(d.compMesAnt, d.pctMeta) : (c.status || 'ativo');
    return { ...c, faturamento, crescimento, status, _temAPI: temAPI, _pctMeta: d?.pctMeta ?? null, _meta: d?.meta ?? 0 };
  });
}

// Executa promessas com concorrência limitada (mesmo padrão usado em Vendas/Analytics)
async function _mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { ret[i] = await fn(items[i], i); } catch(e) { ret[i] = undefined; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return ret;
}

// ── Vendas por dia + Comissão GLR por dia ──────────────────────────────────
// Soma pedidos de TODAS as contas vinculadas a TODOS os clientes, dia a dia,
// no mês corrente. Comissão GLR usa o mesmo campo "valorPorVenda" (R$ por
// venda) já cadastrado em Carteira de Clientes — não existe ainda um modelo
// de mensalidade fixa salvo por cliente, só esse valor por venda.
const STORAGE_VENDAS_DIA = 'glr_dashboard_vendas_dia';

function _dashVendasDiaCache() {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_VENDAS_DIA) || 'null');
    const mesKey = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}`;
    return (c && c.mesKey === mesKey) ? c : null;
  } catch(e) { return null; }
}

function _dashVendasDiaTxt() {
  const c = _dashVendasDiaCache();
  return c?.atualizadoEm ? `Atualizado em ${new Date(c.atualizadoEm).toLocaleString('pt-BR')}` : 'Nenhum dado ainda — clique em Atualizar';
}

async function _dashBuscarVendasPorDia() {
  if (window._dashBuscandoVendasDia) return;
  window._dashBuscandoVendasDia = true;
  const btn = document.getElementById('btn-dash-vendas-dia');
  const status = document.getElementById('dash-vd-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Buscando...'; }

  let vinculos = {};
  try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch(e) {}

  const hoje = new Date();
  const pad = n => String(n).padStart(2,'0');
  const ano = hoje.getFullYear(), mesN = hoje.getMonth()+1;
  const primeiroDia = `${ano}-${pad(mesN)}-01`;
  const ontem = new Date(hoje); ontem.setDate(hoje.getDate()-1);
  const dataTo = `${ontem.getFullYear()}-${pad(ontem.getMonth()+1)}-${pad(ontem.getDate())}`;
  const tsFrom = Math.floor(new Date(`${primeiroDia}T00:00:00`).getTime()/1000);
  const tsTo   = Math.floor(new Date(`${dataTo}T23:59:59`).getTime()/1000);

  const porDia = {}; // 'DD/MM' -> { pedidos, comissao, faturamento }
  const porCanal = {}; // 'Mercado Livre'/'Shopee'/'Amazon'/... -> { pedidos, comissao, faturamento }
  const NOME_CANAL = { meli:'Mercado Livre', ml:'Mercado Livre', mercadolivre:'Mercado Livre', shopee:'Shopee', amazon:'Amazon', magalu:'Magalu' };
  // Comissão da GLR é por UNIDADE vendida (valorPorVenda × quantidade), não um valor
  // fixo por pedido — um pedido com 3 unidades do mesmo produto conta 3x, não 1x.
  const addPedido = (dataStr, unidades, valorPorVenda, valorPedido, mkt) => {
    if (!porDia[dataStr]) porDia[dataStr] = { pedidos: 0, comissao: 0, faturamento: 0 };
    porDia[dataStr].pedidos += 1;
    porDia[dataStr].comissao += unidades * valorPorVenda;
    porDia[dataStr].faturamento += valorPedido || 0;

    const canal = NOME_CANAL[mkt] || mkt || 'Outro';
    if (!porCanal[canal]) porCanal[canal] = { pedidos: 0, comissao: 0, faturamento: 0 };
    porCanal[canal].pedidos += 1;
    porCanal[canal].comissao += unidades * valorPorVenda;
    porCanal[canal].faturamento += valorPedido || 0;
  };

  const clientesComConta = GLR.clientes.filter(c => (vinculos[String(c.id)]||[]).length > 0);
  let doneN = 0;

  await _mapLimit(clientesComConta, 3, async (c) => {
    const valorPorVenda = parseFloat(c.valorPorVenda) || 0;
    const contas = vinculos[String(c.id)] || [];
    await _mapLimit(contas, 3, async (conta) => {
      const mkt = (conta.marketplace||'').toLowerCase();
      try {
        if (['meli','ml','mercadolivre'].includes(mkt)) {
          const meliId = conta.param_to_use?.meliUserId || conta.external_id;
          const orders = await MarketplaceAPI.mlOrders(meliId, primeiroDia, dataTo);
          for (const o of orders) {
            if (['cancelled','invalid'].includes((o.status||'').toLowerCase())) continue;
            const d = new Date(o.date_created||0);
            if (isNaN(d)) continue;
            const unidades = (o.order_items||[]).reduce((s,i) => s + (parseInt(i.quantity)||1), 0) || 1;
            const valorPedido = parseFloat(o.total_amount) || 0;
            addPedido(`${pad(d.getDate())}/${pad(d.getMonth()+1)}`, unidades, valorPorVenda, valorPedido, mkt);
          }
        } else if (mkt === 'shopee') {
          const shopId = conta.param_to_use?.shopId || conta.external_id;
          const sns = await MarketplaceAPI.shopeeListOrderSns(shopId, tsFrom, tsTo);
          for (let i=0; i<sns.length; i+=50) {
            const lote = sns.slice(i,i+50).map(o=>o.sn);
            try {
              const rd = await MarketplaceAPI.call('shopee_get_order_detail', { shopId, order_sn_list: lote });
              const lista = rd.data?.response?.order_list || rd.data?.order_list || [];
              for (const ord of lista) {
                if (!ord.create_time) continue;
                // Blindagem: descarta pedido fora do período pedido — status tipo
                // READY_TO_SHIP não é confiável no filtro de data da API em contas
                // com volume alto (confirmado com pedido real).
                if (ord.create_time < tsFrom || ord.create_time > tsTo) continue;
                const d = new Date(ord.create_time*1000);
                const itens = ord.item_list || ord.items || [];
                const unidades = itens.reduce((s,it) => s + (parseInt(it.model_quantity_purchased)||parseInt(it.quantity)||1), 0) || 1;
                const subtotal = itens.reduce((s,it) => {
                  const p = parseFloat(it.model_discounted_price)||parseFloat(it.item_price)||0;
                  const q = parseInt(it.model_quantity_purchased)||parseInt(it.quantity)||1;
                  return s + p*q;
                }, 0);
                const valorPedido = subtotal > 0 ? subtotal : (parseFloat(ord.total_amount)||0);
                addPedido(`${pad(d.getDate())}/${pad(d.getMonth()+1)}`, unidades, valorPorVenda, valorPedido, mkt);
              }
            } catch(e) {}
          }
        } else if (mkt === 'magalu') {
          const magaluAccountId = conta.param_to_use?.magalu_account_id || conta.external_id;
          const orders = await MarketplaceAPI.magaluOrders(magaluAccountId, primeiroDia, dataTo);
          for (const o of orders) {
            if (['canceled','cancelled'].includes((o.status||'').toLowerCase())) continue;
            const d = new Date(o.purchased_at || o.created_at || 0);
            if (isNaN(d)) continue;
            const unidades = (o.deliveries||[]).reduce((s,dl) => s + (dl.items||[]).reduce((s2,it) => s2 + (parseInt(it.quantity)||1), 0), 0) || 1;
            // Valores da API Magalu vêm em centavos (normalizer:100)
            const valorPedido = (parseFloat(o.amounts?.total) || 0) / 100;
            addPedido(`${pad(d.getDate())}/${pad(d.getMonth()+1)}`, unidades, valorPorVenda, valorPedido, mkt);
          }
        }
      } catch(e) { console.warn('[Dashboard] vendas/dia erro conta', conta.nickname, e.message); }
    });
    doneN++;
    if (status) status.textContent = `⏳ Buscando... ${doneN}/${clientesComConta.length} clientes`;
  });

  const dias = Object.keys(porDia).sort((a,b) => {
    const [da,ma] = a.split('/').map(Number), [db,mb] = b.split('/').map(Number);
    return new Date(ano, ma-1, da) - new Date(ano, mb-1, db);
  });

  const atualizadoEm = Date.now();
  const mesKey = `${ano}-${pad(mesN)}`;
  localStorage.setItem(STORAGE_VENDAS_DIA, JSON.stringify({
    mesKey, atualizadoEm,
    dias: dias.map(d => ({ data: d, pedidos: porDia[d].pedidos, comissao: porDia[d].comissao, faturamento: porDia[d].faturamento })),
    canais: Object.keys(porCanal).map(nome => ({ nome, pedidos: porCanal[nome].pedidos, comissao: porCanal[nome].comissao, faturamento: porCanal[nome].faturamento })),
  }));

  window._dashBuscandoVendasDia = false;
  if (btn) { btn.disabled = false; btn.textContent = '🔄 Atualizar'; }
  Router.resolve();
}

// Dashboard unificado: Visão Geral e Análises da Carteira (antigo Analytics —
// Painel Executivo, Produtos em Queda, Plano de Ação, Checklist Diário) ficam
// empilhados na mesma página, uma rolagem só.

Router.register('dashboard', (params, el) => {
  if (!GLR.clientes.length) {
    el.innerHTML = `<div class="page">
      <div style="text-align:center;padding:80px 24px;">
        <div style="font-size:52px;margin-bottom:16px;">🚀</div>
        <div style="font-size:22px;font-weight:800;color:var(--text-primary);margin-bottom:8px;">Bem-vindo ao GLR Centro de Operações</div>
        <div style="font-size:14px;color:var(--text-muted);max-width:420px;margin:0 auto 28px;">Nenhum dado cadastrado ainda. Comece cadastrando gestores e clientes para visualizar o dashboard.</div>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="Router.navigate('clientes')">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
            Cadastrar primeiro cliente
          </button>
          <button class="btn btn-secondary" onclick="Router.navigate('analytics')">📊 Ir pro Analytics</button>
        </div>
      </div>
    </div>`;
    return;
  }

  // Página única — Visão Geral e Análises da Carteira ficam empilhadas na mesma
  // rolagem, não mais em abas separadas.
  el.innerHTML = `<div class="page">
    <div id="dash-aba-conteudo"></div>
    <div style="margin:40px 0 20px;padding-top:20px;border-top:1px solid var(--border);">
      <div class="section-title" style="font-size:18px;">🚦 Análises da Carteira</div>
      <div class="section-subtitle">Painel Executivo, Produtos em Queda, Plano de Ação e Checklist Diário</div>
    </div>
    <div id="dash-analises-conteudo"></div>
  </div>`;

  const contAba = document.getElementById('dash-aba-conteudo');
  const contAnalises = document.getElementById('dash-analises-conteudo');
  Router.routes['analytics-conteudo'](params, contAnalises);

  const analyticsCache = _dashAnalyticsCache();
  const clientesTodos  = computarClientesAPI();
  const clientes       = clientesTodos.filter(c => c._temAPI); // só quem tem conta vinculada e dado real

  const ativos      = clientes.filter(c => c.status === 'ativo').length;
  const crescimento = clientes.filter(c => c.status === 'crescimento').length;
  const queda       = clientes.filter(c => c.status === 'queda').length;
  const risco       = clientes.filter(c => c.status === 'risco').length;
  const tarefasPendentes = GLR.tarefas.filter(t => t.status !== 'concluida').length;
  const tasksConc    = GLR.tarefas.filter(t => t.status === 'concluida').length;
  const hojeIsoDash  = new Date().toISOString().slice(0,10);
  const tasksAtras   = GLR.tarefas.filter(t => t.status !== 'concluida' && (t.status === 'atrasada' || (t.prazo && t.prazo < hojeIsoDash))).length;
  const reunioesSemana = GLR.eventos.filter(e => e.tipo === 'reuniao').length;

  const faturamentoTotal = clientes.reduce((s, c) => s + (c.faturamento || 0), 0);
  const metaTotal = clientes.reduce((s, c) => s + (c._meta || 0), 0);
  const crescMedioAPI = clientes.length
    ? (clientes.reduce((s, c) => s + (c.crescimento || 0), 0) / clientes.length)
    : null;

  // Receita GLR = soma real da comissão dia a dia (gráfico "Vendas por Dia &
  // Comissão GLR" logo abaixo) — trocado da fonte antiga (Projeção de Crescimento),
  // que dependia de cada cliente ter sido buscado manualmente lá e ficava vazia
  // ("—") na maioria das vezes. Esse valor é real (mês até o último dia buscado),
  // não projetado.
  const vendasDiaCache = _dashVendasDiaCache();
  const receitaGLR = (vendasDiaCache?.dias || []).reduce((s, d) => s + (parseFloat(d.comissao) || 0), 0);
  const faturamentoAtual = (vendasDiaCache?.dias || []).reduce((s, d) => s + (parseFloat(d.faturamento) || 0), 0);
  const qtdPedidosAtual  = (vendasDiaCache?.dias || []).reduce((s, d) => s + (parseInt(d.pedidos) || 0), 0);

  const comAPI = clientes.length;
  const semAPI = clientesTodos.length - comAPI;

  // Gestores com dados reais
  const gestoresComDados = GLR.gestores.map(g => {
    const clientesDoGestor = clientes.filter(c => c.gestor === g.nome);
    const crescMedioG = clientesDoGestor.length
      ? (clientesDoGestor.reduce((s,c)=>s+(c.crescimento||0),0)/clientesDoGestor.length) : 0;
    const tarefasG  = GLR.tarefas.filter(t=>t.responsavel===g.nome&&t.status!=='concluida').length;
    const fatG      = clientesDoGestor.reduce((s,c)=>s+(c.faturamento||0),0);
    const avatar    = g.nome.split(' ').map(n=>n[0]).slice(0,2).join('').toUpperCase();
    return { ...g, avatar, qtdClientes: clientesDoGestor.length, crescMedio: crescMedioG, tarefasPend: tarefasG, fat: fatG };
  }).filter(g => g.qtdClientes > 0 || GLR.gestores.length <= 5);

  const clientesAtencao = clientes.filter(c=>c.status==='risco'||c.status==='queda')
    .sort((a,b)=>(a.crescimento||0)-(b.crescimento||0));

  const concentracao = [...clientes].sort((a,b)=>(b.faturamento||0)-(a.faturamento||0)).slice(0,8);

  const atualizadoTxt = analyticsCache?.atualizadoEm
    ? `Atualizado em ${new Date(analyticsCache.atualizadoEm).toLocaleString('pt-BR')}`
    : 'Nenhum dado do Analytics ainda — clique em Atualizar dados';

  contAba.innerHTML = `
    <div style="margin-bottom:20px;padding:16px 20px;background:linear-gradient(135deg,rgba(99,102,241,0.15),rgba(139,92,246,0.1));border:1px solid rgba(99,102,241,0.2);border-radius:var(--radius);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:24px;">📊</span>
        <div>
          <div style="font-size:16px;font-weight:700;">Dashboard — Visão Geral da Carteira</div>
          <div style="font-size:12px;color:var(--text-secondary);" id="dash-status-txt">${atualizadoTxt}</div>
        </div>
      </div>
      <button class="btn btn-primary" id="btn-dash-atualizar" style="padding:8px 16px;">🔄 Atualizar dados</button>
    </div>

    <!-- KPIs -->
    <div class="kpi-grid">
      ${kpiCard('Clientes na Carteira', clientesTodos.length, `${comAPI} com dados reais`, comAPI > 0, 'rgba(99,102,241,0.15)', '👥', '#6366f1')}
      ${kpiCard('Meta Total', metaTotal>0?GLR.formatCurrency(metaTotal):'—', 'soma das metas', metaTotal>0, 'rgba(245,158,11,0.12)', '🎯', '#f59e0b')}
      ${kpiCard('Faturamento Atual', faturamentoAtual > 0 ? GLR.formatCurrency(faturamentoAtual) : '—', faturamentoAtual > 0 ? 'real, mês até agora' : 'clique em Atualizar no gráfico abaixo', faturamentoAtual > 0, 'rgba(99,102,241,0.15)', '💵', '#6366f1')}
      ${kpiCard('Projeção de Faturamento', GLR.formatCurrency(faturamentoTotal), crescMedioAPI!=null?`${crescMedioAPI>=0?'+':''}${crescMedioAPI.toFixed(1)}% vs mês ant.`:(semAPI>0?'vincule contas p/ ver dados reais':''), true, 'rgba(99,102,241,0.12)', '🏆', '#6366f1', comAPI>0)}
      ${kpiCard('Receita GLR', receitaGLR > 0 ? GLR.formatCurrency(receitaGLR) : '—', receitaGLR > 0 ? 'real, mês até agora' : 'clique em Atualizar no gráfico abaixo', receitaGLR > 0, 'rgba(16,185,129,0.15)', '💰', '#10b981')}
      ${kpiCard('Quantidade de Pedidos', qtdPedidosAtual > 0 ? qtdPedidosAtual.toLocaleString('pt-BR') : '—', qtdPedidosAtual > 0 ? 'real, mês até agora' : 'clique em Atualizar no gráfico abaixo', qtdPedidosAtual > 0, 'rgba(6,182,212,0.15)', '📦', '#06b6d4')}
      ${kpiCard('Em Crescimento', crescimento, `${clientes.length ? Math.round(crescimento/clientes.length*100) : 0}% da carteira`, true, 'rgba(16,185,129,0.12)', '📈', '#10b981')}
      ${kpiCard('Em Risco / Queda', risco+queda, `${risco} em risco · ${queda} em queda`, (risco+queda)===0, 'rgba(239,68,68,0.12)', '⚠️', '#ef4444')}
      ${kpiCard('Tarefas Pendentes', tarefasPendentes, `${tasksAtras} atrasadas`, tarefasPendentes === 0, 'rgba(245,158,11,0.12)', '✅', '#f59e0b')}
      ${kpiCard('Reuniões na Semana', reunioesSemana, 'próximos 7 dias', true, 'rgba(6,182,212,0.12)', '📅', '#06b6d4')}
    </div>

    <!-- Vendas por dia + Comissão GLR por dia -->
    <div class="card mb-24">
      <div class="section-header">
        <div>
          <div class="section-title">🛒 Vendas por Dia & Comissão GLR</div>
          <div class="section-subtitle" id="dash-vd-status">${_dashVendasDiaTxt()}</div>
        </div>
        <button class="btn btn-secondary btn-sm" id="btn-dash-vendas-dia">🔄 Atualizar</button>
      </div>
      <div class="chart-wrapper">
        <canvas id="chart-vendas-dia"></canvas>
      </div>
    </div>

    <!-- Concentração por canal -->
    <div class="card mb-24">
      <div class="section-header">
        <div>
          <div class="section-title">📊 Faturamento & Comissão GLR por Canal</div>
          <div class="section-subtitle">Concentração — Mercado Livre, Shopee, Amazon etc. · mesmo período do gráfico acima</div>
        </div>
      </div>
      <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
        <div style="flex:1;min-width:220px;max-width:260px;">
          <canvas id="chart-canal"></canvas>
        </div>
        <div style="flex:2;min-width:260px;" id="dash-canal-legenda"></div>
      </div>
    </div>

    <!-- Gráficos principais -->
    <div class="grid-2 mb-24">
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Evolução da Carteira</div>
            <div class="section-subtitle">Faturamento total — últimos meses · dados API</div>
          </div>
        </div>
        <div class="chart-wrapper">
          <canvas id="chart-evolucao"></canvas>
        </div>
      </div>
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Distribuição por Status</div>
            <div class="section-subtitle">Situação atual da carteira</div>
          </div>
        </div>
        <div style="display:flex;gap:24px;align-items:center;">
          <div style="flex:1;max-width:180px;">
            <canvas id="chart-status"></canvas>
          </div>
          <div style="flex:1;">
            ${['crescimento','ativo','queda','risco'].map(s => {
              const count = clientes.filter(c => c.status === s).length;
              const pct = clientes.length ? Math.round(count / clientes.length * 100) : 0;
              return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                <div style="width:10px;height:10px;border-radius:50%;background:${{'crescimento':'#10b981','ativo':'#6366f1','queda':'#f97316','risco':'#ef4444'}[s]};flex-shrink:0;"></div>
                <span style="flex:1;font-size:13px;color:var(--text-secondary);text-transform:capitalize;">${GLR.statusLabel[s]}</span>
                <span style="font-weight:700;font-size:13px;">${count}</span>
                <span style="color:var(--text-muted);font-size:12px;">${pct}%</span>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>

    <!-- Ranking + Gestores -->
    <div class="grid-2 mb-24">
      <div class="card">
        <div class="section-header">
          <div class="section-title">🏆 Ranking — Melhor Desempenho</div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('clientes')">Ver todos</button>
        </div>
        ${clientes.length === 0
          ? `<div style="color:var(--text-muted);font-size:13px;padding:16px 0;text-align:center;">Nenhum cliente com dados ainda</div>`
          : [...clientes].sort((a,b) => (b.crescimento||0) - (a.crescimento||0)).slice(0,6).map((c, i) => `
          <div class="ranking-item" onclick="Router.navigate('cliente-perfil', {id: ${c.id}})" style="cursor:pointer;">
            <span class="ranking-num">#${i+1}</span>
            <div style="flex:1;">
              <div class="ranking-name">${c.nome}</div>
              <div style="font-size:11px;color:var(--text-muted);">${c.gestor || ''}</div>
            </div>
            <div style="text-align:right;">
              <div class="ranking-val ${(c.crescimento||0) >= 0 ? 'text-green' : 'text-red'}">${(c.crescimento||0) >= 0 ? '+' : ''}${c.crescimento||0}%</div>
              <div style="font-size:11px;color:var(--text-muted);">${GLR.formatCurrency(c.faturamento||0)}</div>
            </div>
            <span class="badge ${GLR.statusColor[c.status]}" style="margin-left:8px;">${GLR.statusLabel[c.status]}</span>
          </div>
        `).join('')}
      </div>

      <div class="card">
        <div class="section-header">
          <div class="section-title">👨‍💼 Performance dos Gestores</div>
        </div>
        ${gestoresComDados.length===0
          ? `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Nenhum gestor cadastrado</div>`
          : gestoresComDados.map(g=>`
          <div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--border);">
            <div style="width:40px;height:40px;border-radius:50%;background:${g.cor||'#6366f1'}22;border:2px solid ${g.cor||'#6366f1'}44;
                        display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:${g.cor||'#6366f1'};flex-shrink:0;">${g.avatar}</div>
            <div style="flex:1;">
              <div style="font-size:14px;font-weight:600;">${g.nome}</div>
              <div style="font-size:12px;color:var(--text-muted);">${g.cargo||''} · ${g.qtdClientes} cliente${g.qtdClientes!==1?'s':''} · ${g.tarefasPend} tarefa${g.tarefasPend!==1?'s':''} pendente${g.tarefasPend!==1?'s':''}</div>
            </div>
            <div style="text-align:right;">
              <div class="ranking-val ${g.crescMedio>=0?'text-green':'text-red'}">${g.crescMedio>=0?'+':''}${g.crescMedio.toFixed(1)}%</div>
              <div style="font-size:11px;color:var(--text-muted);">${GLR.formatCurrency(g.fat)}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Clientes em atenção + Alertas -->
    <div class="grid-2 mb-24">
      <div class="card">
        <div class="section-header">
          <div class="section-title">🚨 Clientes em Risco ou Queda</div>
        </div>
        ${clientesAtencao.length===0
          ? `<div style="padding:32px;text-align:center;">
               <div style="font-size:32px;margin-bottom:8px;">✅</div>
               <div style="font-size:14px;font-weight:600;color:var(--green);">Nenhum cliente em risco</div>
               <div style="font-size:13px;color:var(--text-muted);margin-top:4px;">Carteira saudável</div>
             </div>`
          : clientesAtencao.map(c=>`
          <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;"
               onclick="Router.navigate('cliente-perfil',{id:${c.id}})">
            <div style="flex:1;">
              <div style="font-size:14px;font-weight:600;">${c.nome}</div>
              <div style="font-size:12px;color:var(--text-muted);">Gestor: ${c.gestor||'—'} · ${GLR.formatCurrency(c.faturamento||0)}</div>
            </div>
            <div style="text-align:right;">
              <div class="ranking-val text-red">${c.crescimento||0}%</div>
              <span class="badge ${GLR.statusColor[c.status]}">${GLR.statusLabel[c.status]}</span>
            </div>
          </div>`).join('')}
      </div>

      <div class="card">
        <div class="section-header">
          <div class="section-title">🔔 Alertas Recentes</div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('alertas')">Ver todos</button>
        </div>
        ${(() => {
          const cores  = { risco:'#ef4444', queda:'#f97316', atrasada:'#f59e0b', meta:'#6366f1', positivo:'#10b981' };
          const icons  = { risco:'🚨', queda:'📉', atrasada:'⏰', meta:'🎯', positivo:'✅' };
          const alertas = typeof gerarAlertasAutomaticos === 'function' ? gerarAlertasAutomaticos() : [];
          const criticos = alertas.filter(a => a.tipo === 'risco' || a.tipo === 'queda');
          const outros   = alertas.filter(a => a.tipo !== 'risco' && a.tipo !== 'queda');
          const lista    = [...criticos, ...outros].slice(0, 5);
          if (!lista.length) return '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">Nenhum alerta no momento. ✅</div>';
          return lista.map(a => {
            const cor = cores[a.tipo] || '#6366f1';
            return `<div class="alert-card" onclick="Router.navigate('alertas')" style="margin-bottom:8px;cursor:pointer;">
              <div class="alert-icon" style="background:${cor}20;">
                <span style="font-size:16px;">${icons[a.tipo] || '🔔'}</span>
              </div>
              <div style="min-width:0;">
                <div class="alert-title">${a.titulo}</div>
                <div class="alert-desc" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.descricao.substring(0, 90)}${a.descricao.length > 90 ? '…' : ''}</div>
              </div>
            </div>`;
          }).join('');
        })()}
      </div>
    </div>

    <!-- Concentração de receita -->
    ${concentracao.some(c=>c.faturamento>0) ? `
    <div class="card mb-24">
      <div class="section-header">
        <div class="section-title">💼 Concentração de Faturamento</div>
        <div class="section-subtitle">Participação de cada cliente</div>
      </div>
      <div class="chart-wrapper">
        <canvas id="chart-concentracao"></canvas>
      </div>
    </div>` : ''}

    <!-- Tarefas urgentes + Próximos eventos -->
    <div class="grid-2 mb-24">
      <div class="card">
        <div class="section-header">
          <div class="section-title">⚡ Tarefas Urgentes</div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('tarefas')">Ver todas</button>
        </div>
        ${GLR.tarefas.filter(t => t.status !== 'concluida' && (t.status === 'atrasada' || (t.prazo && t.prazo < hojeIsoDash) || t.prioridade === 'urgente')).slice(0,5).map(t => `
          <div class="task-card" onclick="Router.navigate('tarefas')">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
              <div class="task-title">${t.titulo}</div>
              <span class="badge ${GLR.prioridadeColor[t.prioridade]}">${t.prioridade}</span>
            </div>
            <div class="task-meta">
              <span>👤 ${t.responsavel}</span>
              <span>📅 ${formatDate(t.prazo)}</span>
              ${t.status === 'atrasada' || (t.prazo && t.prazo < hojeIsoDash) ? '<span style="color:var(--red);font-weight:600;">ATRASADA</span>' : ''}
            </div>
          </div>
        `).join('')}
      </div>

      <div class="card">
        <div class="section-header">
          <div class="section-title">📅 Próximos Eventos</div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('calendario')">Ver calendário</button>
        </div>
        ${GLR.eventos.slice(0,5).map(e => {
          const cor = GLR.eventoColor[e.tipo];
          return `<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border);">
            <div style="width:38px;height:38px;border-radius:var(--radius-sm);background:${cor}20;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">
              ${{ reuniao: '🤝', followup: '📞', entrega: '📦', visita: '🏢', interno: '🏠' }[e.tipo]}
            </div>
            <div style="flex:1;">
              <div style="font-size:13.5px;font-weight:600;color:var(--text-primary);margin-bottom:2px;">${e.titulo}</div>
              <div style="font-size:12px;color:var(--text-muted);">${formatDate(e.data)} às ${e.hora} · ${e.responsavel}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- Carteira completa -->
    <div class="card">
      <div class="section-header">
        <div class="section-title">📋 Carteira Completa</div>
        <button class="btn btn-ghost btn-sm" onclick="Router.navigate('clientes')">Gerenciar</button>
      </div>
      <table class="table" style="font-size:13px;">
        <thead><tr>
          <th>Cliente</th><th>Gestor</th><th>Status</th>
          <th style="text-align:right;">Faturamento</th>
          <th style="text-align:right;">Crescimento</th>
          <th></th>
        </tr></thead>
        <tbody>
        ${[...clientesTodos].sort((a,b)=>(b.faturamento||0)-(a.faturamento||0)).map(c=>`
          <tr style="cursor:pointer;" onclick="Router.navigate('cliente-perfil',{id:${c.id}})">
            <td style="font-weight:600;">${c.nome}</td>
            <td style="color:var(--text-muted);">${c.gestor||'—'}</td>
            <td><span class="badge ${GLR.statusColor[c.status]}">${GLR.statusLabel[c.status]}</span></td>
            <td style="text-align:right;">${c._temAPI ? GLR.formatCurrency(c.faturamento||0) : '<span style="color:var(--text-muted);">sem dados</span>'}</td>
            <td style="text-align:right;color:${(c.crescimento||0)>=0?'var(--green)':'var(--red)'};">${c._temAPI ? `${(c.crescimento||0)>=0?'+':''}${c.crescimento||0}%` : '—'}</td>
            <td style="text-align:right;"><button class="btn btn-ghost btn-sm">Ver perfil →</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  document.getElementById('btn-dash-atualizar')?.addEventListener('click', _dashAtualizarTudo);
  document.getElementById('btn-dash-vendas-dia')?.addEventListener('click', _dashBuscarVendasPorDia);

  // Charts
  setTimeout(() => {
    const ctxVD = document.getElementById('chart-vendas-dia');
    if (ctxVD) {
      const vd = _dashVendasDiaCache();
      const dias = vd?.dias || [];
      if (!dias.length) {
        ctxVD.parentElement.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:32px 0;">Sem dados ainda.<br>Clique em "Atualizar" pra somar as vendas de todos os clientes, dia a dia.</div>';
      } else {
        new Chart(ctxVD, {
          data: {
            labels: dias.map(d => d.data),
            datasets: [
              { type: 'bar', label: 'Nº de vendas', data: dias.map(d => d.pedidos), backgroundColor: 'rgba(99,102,241,0.55)', borderRadius: 4, yAxisID: 'y' },
              { type: 'line', label: 'Comissão GLR (R$)', data: dias.map(d => d.comissao), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', borderWidth: 2, tension: 0.35, pointRadius: 3, pointBackgroundColor: '#10b981', yAxisID: 'y1' },
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: true, labels: { color: '#9192a8', font: { size: 11 }, boxWidth: 12 } },
              tooltip: {
                ...tooltipStyle(),
                callbacks: {
                  label: ctx => ctx.dataset.yAxisID === 'y1' ? ` R$ ${ctx.raw.toLocaleString('pt-BR',{minimumFractionDigits:2})}` : ` ${ctx.raw} venda${ctx.raw!==1?'s':''}`
                }
              }
            },
            scales: {
              x: { grid: { color: 'rgba(255,255,255,0.04)', drawBorder:false }, ticks: { color:'#5a5b72', font:{size:11} } },
              y:  { position:'left',  grid: { color: 'rgba(255,255,255,0.04)', drawBorder:false }, ticks: { color:'#5a5b72', font:{size:11}, precision:0 }, title:{display:true,text:'Nº de vendas',color:'#5a5b72',font:{size:10}} },
              y1: { position:'right', grid: { drawOnChartArea:false }, ticks: { color:'#5a5b72', font:{size:11}, callback: v => 'R$ '+v }, title:{display:true,text:'Comissão GLR',color:'#5a5b72',font:{size:10}} },
            }
          }
        });
      }
    }

    const ctxCanal = document.getElementById('chart-canal');
    const legendaCanal = document.getElementById('dash-canal-legenda');
    if (ctxCanal && legendaCanal) {
      const vd = _dashVendasDiaCache();
      const canais = (vd?.canais || []).filter(c => c.faturamento > 0).sort((a,b) => b.faturamento - a.faturamento);
      if (!canais.length) {
        ctxCanal.parentElement.parentElement.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:32px 0;">Sem dados ainda.<br>Clique em "Atualizar" no gráfico "Vendas por Dia" acima.</div>';
      } else {
        const coresCanal = { 'Mercado Livre':'#fbbf24', 'Shopee':'#f97316', 'Amazon':'#94a3b8', 'Magalu':'#0086ff' };
        const paletaExtra = ['#6366f1','#8b5cf6','#06b6d4','#10b981','#ec4899'];
        const corDe = (nome, i) => coresCanal[nome] || paletaExtra[i % paletaExtra.length];
        new Chart(ctxCanal, {
          type: 'doughnut',
          data: {
            labels: canais.map(c => c.nome),
            datasets: [{
              data: canais.map(c => c.faturamento),
              backgroundColor: canais.map((c,i) => corDe(c.nome, i)),
              borderWidth: 0, hoverOffset: 4,
            }]
          },
          options: {
            cutout: '68%', responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                ...tooltipStyle(),
                callbacks: {
                  label: ctx => {
                    const c = canais[ctx.dataIndex];
                    return [
                      ` Faturamento: R$ ${c.faturamento.toLocaleString('pt-BR',{minimumFractionDigits:2})}`,
                      ` Comissão GLR: R$ ${c.comissao.toLocaleString('pt-BR',{minimumFractionDigits:2})}`,
                      ` ${c.pedidos} pedido${c.pedidos!==1?'s':''}`,
                    ];
                  }
                }
              }
            }
          }
        });
        const totalFat = canais.reduce((s,c)=>s+c.faturamento,0);
        legendaCanal.innerHTML = canais.map((c,i) => {
          const pct = totalFat>0 ? (c.faturamento/totalFat*100) : 0;
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            <div style="width:10px;height:10px;border-radius:50%;background:${corDe(c.nome,i)};flex-shrink:0;"></div>
            <div style="flex:1;font-size:13px;font-weight:600;">${c.nome}</div>
            <div style="text-align:right;">
              <div style="font-size:13px;font-weight:700;">${GLR.formatCurrency(c.faturamento)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${pct.toFixed(1)}% · comissão ${GLR.formatCurrency(c.comissao)}</div>
            </div>
          </div>`;
        }).join('');
      }
    }

    const ctx1 = document.getElementById('chart-evolucao');
    if (ctx1) {
      // 3 pontos reais vindos do Analytics: 2 meses anteriores + mês atual (projeção)
      const d0 = analyticsCache?.dados || [];
      const somaCampo = campo => d0.reduce((s,d)=>s+(parseFloat(d[campo])||0),0);
      const labelM1 = d0.find(d=>d.labelM1)?.labelM1 || 'Mês ant.';
      const labelM2 = d0.find(d=>d.labelM2)?.labelM2 || 'Mês retrasado';
      const evolucao = [
        { mes: labelM2, total: somaCampo('fatM2') },
        { mes: labelM1, total: somaCampo('fatM1') },
        { mes: 'Atual (projeção)', total: somaCampo('projecao') },
      ].filter(d => d.total > 0);

      if (evolucao.length === 0) {
        ctx1.parentElement.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:32px 0;">Sem histórico ainda.<br>Clique em "Atualizar dados" pra buscar via API.</div>';
      } else {
        new Chart(ctx1, {
          type: 'line',
          data: {
            labels: evolucao.map(d => d.mes),
            datasets: [{
              data: evolucao.map(d => d.total),
              borderColor: '#6366f1',
              backgroundColor: 'rgba(99,102,241,0.1)',
              borderWidth: 2,
              fill: true,
              tension: 0.4,
              pointRadius: 3,
              pointHoverRadius: 5,
              pointBackgroundColor: '#6366f1',
            }]
          },
          options: {
            ...chartDefaults(),
            plugins: {
              ...(chartDefaults().plugins || {}),
              tooltip: {
                callbacks: {
                  label: ctx => ' R$ ' + ctx.raw.toLocaleString('pt-BR', {minimumFractionDigits:0})
                }
              }
            }
          }
        });
      }
    }

    const ctx2 = document.getElementById('chart-status');
    if (ctx2) {
      new Chart(ctx2, {
        type: 'doughnut',
        data: {
          labels: ['Crescimento', 'Ativo', 'Queda', 'Risco'],
          datasets: [{
            data: [crescimento, ativos, queda, risco],
            backgroundColor: ['#10b981', '#6366f1', '#f97316', '#ef4444'],
            borderWidth: 0,
            hoverOffset: 4,
          }]
        },
        options: {
          cutout: '72%',
          plugins: { legend: { display: false }, tooltip: tooltipStyle() },
          responsive: true,
          maintainAspectRatio: false,
        }
      });
    }

    const ctx3 = document.getElementById('chart-concentracao');
    if (ctx3 && concentracao.some(c=>c.faturamento>0)) {
      new Chart(ctx3, {
        type: 'bar',
        data: {
          labels: concentracao.map(c=>c.nome.split(' ').slice(0,2).join(' ')),
          datasets: [{
            data: concentracao.map(c=>c.faturamento||0),
            backgroundColor: ['#6366f1','#8b5cf6','#06b6d4','#10b981','#f59e0b','#f97316','#ef4444','#ec4899'],
            borderRadius: 4,
          }]
        },
        options: { ...chartDefaults(), indexAxis:'y', plugins:{legend:{display:false},tooltip:tooltipStyle()} }
      });
    }
  }, 50);
});

// Rotas antigas "diretoria" e "analytics" agora só redirecionam pro dashboard
// unificado — evita quebrar qualquer link/atalho salvo de antes da fusão das
// páginas. O conteúdo real do Analytics vive em 'analytics-conteudo'
// (js/pages-analytics.js), renderizado dentro da aba "Análises da Carteira".
Router.register('diretoria', () => Router.navigate('dashboard'));
Router.register('analytics', () => Router.navigate('dashboard'));

// Botão "Atualizar dados": dispara a busca real do Painel Executivo (a página
// já vem toda montada, window._analyticsBuscarExec já existe desde o load) e
// depois a busca de Vendas por Dia & Comissão GLR — sem precisar trocar de aba.
async function _dashAtualizarTudo() {
  if (window._dashAtualizando) return;
  window._dashAtualizando = true;
  const btn = document.getElementById('btn-dash-atualizar');
  const status = document.getElementById('dash-status-txt');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Buscando...'; }
  if (status) status.textContent = 'Buscando dados reais via API (pode levar um tempo)...';
  try {
    if (typeof window._analyticsBuscarExec === 'function') {
      await window._analyticsBuscarExec();
    }
  } catch(e) {
    console.warn('[Dashboard] erro ao atualizar:', e.message);
  }
  window._dashAtualizando = false;
  Router.resolve();

  // Vendas por Dia & Comissão GLR — atualiza junto, sem precisar clicar no
  // botão próprio do gráfico toda vez. Re-busca o elemento de status porque o
  // Router.resolve() acima recriou o DOM (a referência antiga ficou obsoleta).
  const status2 = document.getElementById('dash-status-txt');
  if (status2) status2.textContent = 'Buscando vendas por dia da carteira...';
  await _dashBuscarVendasPorDia();
}


// ---- Shared KPI card builder ----
function kpiCard(label, value, sub, positive, iconBg, icon, iconColor, rawHtml = false) {
  return `<div class="kpi-card">
    <div class="kpi-icon" style="background:${iconBg};">
      <span style="font-size:18px;">${icon}</span>
    </div>
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    ${rawHtml ? sub : `<div class="kpi-delta ${positive ? 'up' : 'down'}">${positive ? '▲' : '▼'} ${sub}</div>`}
  </div>`;
}

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: tooltipStyle(),
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
        ticks: { color: '#5a5b72', font: { size: 11 } },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
        ticks: {
          color: '#5a5b72', font: { size: 11 },
          callback: v => v >= 1000000 ? (v/1000000).toFixed(1)+'M' : v >= 1000 ? (v/1000).toFixed(0)+'k' : v
        },
      }
    }
  };
}

function tooltipStyle() {
  return {
    backgroundColor: '#16161f',
    borderColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    titleColor: '#f1f1f8',
    bodyColor: '#9192a8',
    padding: 10,
    cornerRadius: 8,
    callbacks: {
      label: ctx => {
        const v = ctx.raw;
        if (typeof v === 'number' && v > 1000) return ' R$ ' + v.toLocaleString('pt-BR');
        return ' ' + v;
      }
    }
  };
}
