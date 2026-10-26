// ============================================================
// GLR Consultoria — Dashboard (Executivo + Diretoria unificados)
// ============================================================

// ---- Helpers visuais ----
function sparkline(data, color = 'var(--accent)') {
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
  if (s >= 80) return 'var(--green)';
  if (s >= 60) return 'var(--accent)';
  if (s >= 40) return 'var(--yellow)';
  return 'var(--red)';
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
    return { ...c, faturamento, crescimento, status, _temAPI: temAPI, _pctMeta: d?.pctMeta ?? null, _meta: d?.meta ?? 0, _fatM1: d?.fatM1 || 0 };
  });
}

// Crescimento de um grupo de clientes = projeção do mês somada × mês passado
// fechado somado (só quem tem mês passado). Média simples das % deixava um
// cliente que começou no fim do mês passado (R$ 150 → R$ 22 mil = +14.622%)
// puxar a carteira inteira do gestor para +1.000%.
function _dashCrescGrupo(lista) {
  const comp = lista.filter(c => c._fatM1 > 0);
  const ant = comp.reduce((s, c) => s + c._fatM1, 0), atual = comp.reduce((s, c) => s + (c.faturamento || 0), 0);
  return ant > 0 ? { pct: (atual - ant) / ant * 100, ganho: atual - ant } : null;
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
  if (!c?.atualizadoEm) return '⏳ Carregando da base automática...';
  const fonte = c.lojasBase != null ? ` · ${c.lojasBase} loja${c.lojasBase !== 1 ? 's' : ''} da base automática${c.lojasAPI ? `, ${c.lojasAPI} pela API (histórico ainda carregando ou marketplace fora da base)` : ''}` : '';
  return `Atualizado em ${new Date(c.atualizadoEm).toLocaleString('pt-BR')}${fonte}`;
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
  // No dia 1 do mês, "ontem" pertence ao mês ANTERIOR — usar ontem como dataTo
  // nesse caso inverte o período (de 01/09 até 31/08) e a busca sai vazia/errada.
  // Se ontem já saiu do mês atual, usa hoje mesmo (é o único dia válido até agora).
  const ontem = new Date(hoje); ontem.setDate(hoje.getDate()-1);
  const dataToDate = ontem < new Date(`${primeiroDia}T00:00:00`) ? hoje : ontem;
  const dataTo = `${dataToDate.getFullYear()}-${pad(dataToDate.getMonth()+1)}-${pad(dataToDate.getDate())}`;
  const tsFrom = Math.floor(new Date(`${primeiroDia}T00:00:00`).getTime()/1000);
  const tsTo   = Math.floor(new Date(`${dataTo}T23:59:59`).getTime()/1000);

  const porDia = {}; // 'DD/MM' -> { pedidos, comissao, faturamento }
  const porCanal = {}; // 'Mercado Livre'/'Shopee'/'Amazon'/... -> { pedidos, comissao, faturamento }
  // Crescimento por canal: mesmo período do mês anterior (dia 1 até o mesmo dia),
  // só com lojas da base que cobrem os dois meses — loja nova ou sem histórico
  // entrando de um lado só faria o canal "crescer" sem ter crescido.
  const cmpCanal = {}; // canal -> { atual, ant, lojas }
  const iniAntD = new Date(ano, mesN - 2, 1), fimAntD = new Date(ano, mesN - 1, 0);
  const iniAnt = `${iniAntD.getFullYear()}-${pad(iniAntD.getMonth()+1)}-01`;
  const fimAnt = `${iniAntD.getFullYear()}-${pad(iniAntD.getMonth()+1)}-${pad(Math.min(parseInt(dataTo.slice(8)), fimAntD.getDate()))}`;
  const NOME_CANAL = { meli:'Mercado Livre', ml:'Mercado Livre', mercadolivre:'Mercado Livre', shopee:'Shopee', amazon:'Amazon', magalu:'Magalu' };
  // Comissão da GLR é por UNIDADE vendida (valorPorVenda × quantidade), não um valor
  // fixo por pedido — um pedido com 3 unidades do mesmo produto conta 3x, não 1x.
  // Comissão por cliente conforme o modelo dele (GLR.comissao: por venda, fixo
  // mensal com franquia ou por faixa de ticket). Cada pedido de conta que conta
  // comissão vai para um "balde" (cliente, dia, canal); no fim o fixo é rateado
  // pelos pedidos do mês e os outros modelos somam pedido a pedido.
  const baldes = {}; // clienteId → { cli, b: { 'dia|canal': { n, var } }, n }
  const balde = (cli, dataStr, canal) => { const B = baldes[cli.id] = baldes[cli.id] || { cli, b: {}, n: 0 }; const k = `${dataStr}|${canal}`; return (B.b[k] = B.b[k] || { n: 0, var: 0 }); };
  const addPedido = (dataStr, unidades, ctxCom, valorPedido, mkt) => {
    if (!porDia[dataStr]) porDia[dataStr] = { pedidos: 0, comissao: 0, faturamento: 0 };
    porDia[dataStr].pedidos += 1;
    porDia[dataStr].faturamento += valorPedido || 0;

    const canal = NOME_CANAL[mkt] || mkt || 'Outro';
    if (!porCanal[canal]) porCanal[canal] = { pedidos: 0, comissao: 0, faturamento: 0 };
    porCanal[canal].pedidos += 1;
    porCanal[canal].faturamento += valorPedido || 0;
    if (ctxCom?.com) { const x = balde(ctxCom.cli, dataStr, canal); x.n += 1; x.var += GLR.comissao.dePedido(ctxCom.cli, valorPedido, unidades); baldes[ctxCom.cli.id].n += 1; }
  };

  const clientesComConta = GLR.clientes.filter(c => (vinculos[String(c.id)]||[]).length > 0);
  let doneN = 0;

  // Base sincronizada (Shopee/ML): resumo diário pronto — instantâneo, mesma
  // regra (sem cancelados e sem devolução aceita). Loja cujo histórico ainda
  // não cobre o começo do mês cai na busca antiga pela API, abaixo.
  let base = null;
  try { base = window.BaseDados ? await BaseDados.carregar() : null; } catch(e) { console.warn('[Dashboard] base indisponível:', e.message); }
  let lojasBase = 0, lojasAPI = 0;

  await _mapLimit(clientesComConta, 3, async (c) => {
    const contas = vinculos[String(c.id)] || [];
    await _mapLimit(contas, 3, async (conta) => {
      const ctxCom = { cli: c, com: GLR.contaGeraComissao(conta) && GLR.comissao.temComissao(c) };
      const mkt = (conta.marketplace||'').toLowerCase();
      const infoBase = base && BaseDados.mktDe(mkt) ? base[BaseDados.chave(mkt, conta.param_to_use?.shopId || conta.param_to_use?.meliUserId || conta.external_id)] : null;
      if (infoBase && BaseDados.cobre(infoBase, primeiroDia)) {
        lojasBase++;
        if (BaseDados.cobre(infoBase, iniAnt)) {
          const x = cmpCanal[NOME_CANAL[mkt] || mkt] = cmpCanal[NOME_CANAL[mkt] || mkt] || { atual: 0, ant: 0, lojas: 0 };
          x.atual += BaseDados.somar(infoBase, primeiroDia, dataTo).faturamento || 0;
          x.ant += BaseDados.somar(infoBase, iniAnt, fimAnt).faturamento || 0;
          x.lojas++;
        }
        for (const [dia, v] of Object.entries(infoBase.dias || {})) {
          if (dia < primeiroDia || dia > dataTo || !(v.pedidos > 0)) continue;
          const [, mm, dd] = dia.split('-');
          const dataStr = `${dd}/${mm}`;
          if (!porDia[dataStr]) porDia[dataStr] = { pedidos: 0, comissao: 0, faturamento: 0 };
          porDia[dataStr].pedidos += v.pedidos;
          porDia[dataStr].faturamento += v.faturamento || 0;
          const canal = NOME_CANAL[mkt] || mkt;
          if (!porCanal[canal]) porCanal[canal] = { pedidos: 0, comissao: 0, faturamento: 0 };
          porCanal[canal].pedidos += v.pedidos;
          porCanal[canal].faturamento += v.faturamento || 0;
          if (ctxCom.com) {
            const x = balde(c, dataStr, canal); x.n += v.pedidos; baldes[c.id].n += v.pedidos;
            if (GLR.comissao.modelo(c).modelo === 'venda') x.var += (v.unidades || v.pedidos) * GLR.comissao.modelo(c).valor;
          }
        }
        // Comissão por faixa de ticket precisa do valor de cada pedido (o resumo é por dia)
        if (ctxCom.com && GLR.comissao.modelo(c).modelo === 'ticket') {
          const idB = String(conta.param_to_use?.shopId || conta.param_to_use?.meliUserId || conta.external_id);
          for (let off = 0; off < 50000; off += 1000) {
            const { data } = await _sb.from('glr_pedidos').select('criado_em,valor_bruto').eq('marketplace', BaseDados.mktDe(mkt)).eq('conta_id', idB).eq('situacao', 'valido')
              .gte('criado_em', new Date(`${primeiroDia}T00:00:00-03:00`).toISOString()).lt('criado_em', new Date(new Date(`${dataTo}T00:00:00-03:00`).getTime() + 864e5).toISOString()).range(off, off + 999);
            for (const p of data || []) {
              const d = new Date(new Date(p.criado_em).getTime() - 3 * 3600e3);
              balde(c, `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`, NOME_CANAL[mkt] || mkt).var += GLR.comissao.dePedido(c, p.valor_bruto, 1);
            }
            if (!data || data.length < 1000) break;
          }
        }
        return;
      }
      lojasAPI++;
      try {
        if (['meli','ml','mercadolivre'].includes(mkt)) {
          const meliId = conta.param_to_use?.meliUserId || conta.external_id;
          const orders = await MarketplaceAPI.mlOrders(meliId, primeiroDia, dataTo);
          for (const o of orders) {
            // Cancelamento cobre a maioria dos casos. Devolução/reembolso no ML é um
            // fluxo separado (claims/mediations) que não muda o status do pedido —
            // verificar isso exigiria uma chamada por pedido, inviável neste loop
            // (dezenas de contas por atualização). Limitação conhecida, não corrigida.
            if (['cancelled','invalid'].includes((o.status||'').toLowerCase())) continue;
            const d = new Date(o.date_created||0);
            if (isNaN(d)) continue;
            const unidades = (o.order_items||[]).reduce((s,i) => s + (parseInt(i.quantity)||1), 0) || 1;
            const valorPedido = parseFloat(o.total_amount) || 0;
            addPedido(`${pad(d.getDate())}/${pad(d.getMonth()+1)}`, unidades, ctxCom, valorPedido, mkt);
          }
        } else if (mkt === 'shopee') {
          const shopId = conta.param_to_use?.shopId || conta.external_id;
          const sns = await MarketplaceAPI.shopeeListOrderSns(shopId, tsFrom, tsTo);

          // Pedido cancelado ou com devolução/reembolso aceito não gera comissão.
          // order_status CANCELLED/IN_CANCEL cobre cancelamento; devolução/reembolso
          // é um fluxo separado da Shopee (o pedido original continua COMPLETED) —
          // por isso cruza com a lista de devoluções (get_return_list) pelo order_sn.
          // status ACCEPTED = reembolso já confirmado; outros status (JUDGING,
          // PROCESSING, CANCELLED da devolução) ainda não tiraram a venda, então não
          // são descontados aqui (confirmado com dados reais de conta ativa).
          const orderSnsReembolsados = new Set();
          try {
            let pagina = 1;
            let temMais = true;
            while (temMais && pagina <= 5) {
              const rl = await MarketplaceAPI.call('shopee_get_return_list', { shopId, create_time_from: tsFrom, create_time_to: tsTo, page_size: 50, page_no: pagina });
              const devolucoes = rl.data?.response?.return || rl.response?.return || [];
              devolucoes.forEach(r => { if (r.status === 'ACCEPTED' && r.order_sn) orderSnsReembolsados.add(r.order_sn); });
              temMais = !!(rl.data?.response?.more || rl.response?.more);
              pagina++;
            }
          } catch(e) {}

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
                const orderStatus = (ord.order_status || '').toUpperCase();
                if (['CANCELLED','IN_CANCEL'].includes(orderStatus)) continue;
                if (orderSnsReembolsados.has(ord.order_sn)) continue;
                const d = new Date(ord.create_time*1000);
                const itens = ord.item_list || ord.items || [];
                const unidades = itens.reduce((s,it) => s + (parseInt(it.model_quantity_purchased)||parseInt(it.quantity)||1), 0) || 1;
                const subtotal = itens.reduce((s,it) => {
                  const p = parseFloat(it.model_discounted_price)||parseFloat(it.item_price)||0;
                  const q = parseInt(it.model_quantity_purchased)||parseInt(it.quantity)||1;
                  return s + p*q;
                }, 0);
                const valorPedido = subtotal > 0 ? subtotal : (parseFloat(ord.total_amount)||0);
                addPedido(`${pad(d.getDate())}/${pad(d.getMonth()+1)}`, unidades, ctxCom, valorPedido, mkt);
              }
            } catch(e) {}
          }
        } else if (mkt === 'magalu') {
          const magaluAccountId = conta.param_to_use?.magalu_account_id || conta.external_id;
          const orders = await MarketplaceAPI.magaluOrders(magaluAccountId, primeiroDia, dataTo);
          for (const o of orders) {
            // Mesma limitação do ML: devolução/reembolso na Magalu é rastreado via
            // tickets separados (magalu_ticket_returns), não no status do pedido —
            // checagem por pedido inviável neste loop. Só cancelamento é filtrado.
            if (['canceled','cancelled'].includes((o.status||'').toLowerCase())) continue;
            const d = new Date(o.purchased_at || o.created_at || 0);
            if (isNaN(d)) continue;
            const unidades = (o.deliveries||[]).reduce((s,dl) => s + (dl.items||[]).reduce((s2,it) => s2 + (parseInt(it.quantity)||1), 0), 0) || 1;
            // Valores da API Magalu vêm em centavos (normalizer:100)
            const valorPedido = (parseFloat(o.amounts?.total) || 0) / 100;
            addPedido(`${pad(d.getDate())}/${pad(d.getMonth()+1)}`, unidades, ctxCom, valorPedido, mkt);
          }
        }
      } catch(e) { console.warn('[Dashboard] vendas/dia erro conta', conta.nickname, e.message); }
    });
    doneN++;
    if (status) status.textContent = `⏳ Buscando... ${doneN}/${clientesComConta.length} clientes`;
  });

  // Fecha a comissão de cada cliente: fixo mensal rateado pelos pedidos; os demais, pedido a pedido
  for (const B of Object.values(baldes)) {
    const m = GLR.comissao.modelo(B.cli);
    const totalFixo = m.modelo === 'fixo' ? GLR.comissao.fixoDoMes(m, B.n) : 0;
    const entradas = Object.entries(B.b);
    if (m.modelo === 'fixo' && !B.n) entradas.push([`01/${pad(mesN)}|${Object.keys(porCanal)[0] || 'Outro'}`, { n: 0, var: 0 }]);
    for (const [k, x] of entradas) {
      const [dataStr, canal] = k.split('|');
      const v = m.modelo === 'fixo' ? (B.n ? totalFixo * x.n / B.n : totalFixo) : x.var;
      if (!porDia[dataStr]) porDia[dataStr] = { pedidos: 0, comissao: 0, faturamento: 0 };
      porDia[dataStr].comissao += v;
      if (!porCanal[canal]) porCanal[canal] = { pedidos: 0, comissao: 0, faturamento: 0 };
      porCanal[canal].comissao += v;
    }
  }

  const dias = Object.keys(porDia).sort((a,b) => {
    const [da,ma] = a.split('/').map(Number), [db,mb] = b.split('/').map(Number);
    return new Date(ano, ma-1, da) - new Date(ano, mb-1, db);
  });

  const atualizadoEm = Date.now();
  const mesKey = `${ano}-${pad(mesN)}`;
  localStorage.setItem(STORAGE_VENDAS_DIA, JSON.stringify({
    mesKey, atualizadoEm, lojasBase, lojasAPI, periodoAnt: { de: iniAnt, ate: fimAnt },
    dias: dias.map(d => ({ data: d, pedidos: porDia[d].pedidos, comissao: porDia[d].comissao, faturamento: porDia[d].faturamento })),
    canais: Object.keys(porCanal).map(nome => ({ nome, pedidos: porCanal[nome].pedidos, comissao: porCanal[nome].comissao, faturamento: porCanal[nome].faturamento, cmp: cmpCanal[nome] || null })),
  }));

  window._dashBuscandoVendasDia = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Atualizar'; }
  // Só redesenha se ainda estiver no Dashboard (a busca pode terminar depois
  // que o usuário já foi para outra tela — não pode redesenhar a tela dele).
  if (Router.currentPage === 'dashboard') Router.resolve();
}

// ── Atualização automática (sem clicar) ─────────────────────────────────────
// Roda ao abrir o Dashboard, a cada minuto enquanto ele está aberto e quando o
// servidor termina uma rodada de sincronização (aviso em tempo real). Lojas da
// base são instantâneas; as que ainda dependem da API são refeitas no máximo a
// cada 10 min. Controle por horário da última tentativa (não pela idade do
// cache) para nunca entrar em laço de redesenho.
async function _dashAutoAtualizar(motivo) {
  if (Router.currentPage !== 'dashboard' || window._dashAtualizando || window._dashBuscandoVendasDia) return;
  if (window._dashAutoDesligado && motivo === 'timer') return;
  const agora = Date.now();
  const vd = _dashVendasDiaCache();
  const intervaloVD = vd?.lojasAPI ? 10 * 60e3 : 60e3;
  const precisaVD = motivo === 'base' || !vd || agora - (window._dashUltVD || 0) >= intervaloVD;
  const precisaExec = motivo === 'base' || agora - (window._dashUltExec || 0) >= 5 * 60e3;
  if (!precisaVD && !precisaExec) return;
  window._dashAtualizando = true;
  try {
    if (precisaExec && typeof window._analyticsBuscarExec === 'function') {
      window._dashUltExec = agora;
      await window._analyticsBuscarExec();
    }
  } catch(e) { console.warn('[Dashboard] atualização automática (painel):', e.message); }
  window._dashAtualizando = false;
  if (precisaVD) { window._dashUltVD = agora; await _dashBuscarVendasPorDia(); }
  else if (Router.currentPage === 'dashboard') Router.resolve();
}
if (!window._dashOuvindoBase) {
  window._dashOuvindoBase = true;
  window.addEventListener('glr-base-atualizada', () => _dashAutoAtualizar('base'));
}

// Dashboard unificado: Visão Geral e Análises da Carteira (antigo Analytics —
// Painel Executivo, Produtos em Queda, Plano de Ação, Checklist Diário) ficam
// empilhados na mesma página, uma rolagem só.

Router.register('dashboard', (params, el) => {
  if (!GLR.clientes.length) {
    el.innerHTML = `<div class="page">
      <div style="text-align:center;padding:80px 24px;">
        <div style="font-size:52px;margin-bottom:16px;">🚀</div>
        <div style="font-size:22px;font-weight:650;letter-spacing:-0.02em;color:var(--text-primary);margin-bottom:8px;">Bem-vindo ao GLR Centro de Operações</div>
        <div style="font-size:14px;color:var(--text-muted);max-width:420px;margin:0 auto 28px;">Nenhum dado cadastrado ainda. Comece cadastrando gestores e clientes para visualizar o dashboard.</div>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="Router.navigate('clientes')">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
            Cadastrar primeiro cliente
          </button>
          <button class="btn btn-secondary" onclick="Router.navigate('analytics')">Ir pro Analytics</button>
        </div>
      </div>
    </div>`;
    return;
  }

  // Página única — Visão Geral e Análises da Carteira ficam empilhadas na mesma
  // rolagem, não mais em abas separadas.
  el.innerHTML = `<div class="page dash-v2">
    <div id="dash-aba-conteudo"></div>
    <div style="margin:40px 0 20px;padding-top:20px;border-top:1px solid var(--border);">
      <div class="dx-h1" style="font-size:18px">Análises da carteira</div>
      <div class="section-subtitle">Painel executivo, produtos em queda, plano de ação e checklist diário</div>
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
  const crescMedioAPI = _dashCrescGrupo(clientes)?.pct ?? null;

  // Receita GLR = soma real da comissão dia a dia (gráfico "Vendas por Dia &
  // Comissão GLR" logo abaixo) — trocado da fonte antiga (Projeção de Crescimento),
  // que dependia de cada cliente ter sido buscado manualmente lá e ficava vazia
  // ("—") na maioria das vezes. Esse valor é real (mês até o último dia buscado),
  // não projetado.
  const vendasDiaCache = _dashVendasDiaCache();
  const receitaGLR = (vendasDiaCache?.dias || []).reduce((s, d) => s + (parseFloat(d.comissao) || 0), 0);
  const faturamentoAtual = (vendasDiaCache?.dias || []).reduce((s, d) => s + (parseFloat(d.faturamento) || 0), 0);
  const qtdPedidosAtual  = (vendasDiaCache?.dias || []).reduce((s, d) => s + (parseInt(d.pedidos) || 0), 0);

  // Projeção de Receita GLR — mesmo princípio da "Projeção de Faturamento" (roda
  // o real do mês até agora pelos dias restantes), aplicado à comissão em vez do
  // faturamento bruto. Ticket médio = essa projeção dividida pelos clientes com
  // dado real (mesma base do "X com dados reais" do card Clientes na Carteira).
  const _hojeDash = new Date();
  const diasNoMesDash = new Date(_hojeDash.getFullYear(), _hojeDash.getMonth() + 1, 0).getDate();
  const diasDecorridosDash = (vendasDiaCache?.dias || []).length;
  const projecaoReceitaGLR = diasDecorridosDash > 0 ? (receitaGLR / diasDecorridosDash) * diasNoMesDash : 0;
  const ticketMedioGLR = clientes.length > 0 ? projecaoReceitaGLR / clientes.length : 0;

  const comAPI = clientes.length;
  const semAPI = clientesTodos.length - comAPI;

  // Nome do gestor por id — usado nos lugares que exibem "Gestor: X", já que
  // c.gestor (string) não é gravado pelo formulário de editar cliente (só
  // c.gestorId); sem isso o nome aparecia em branco em todo cliente editado.
  const gestorNomePorId = {};
  GLR.gestores.forEach(g => { gestorNomePorId[g.id] = g.nome; });
  const nomeGestorDe = c => c.gestor || gestorNomePorId[c.gestorId] || '—';

  // Gestores com dados reais — filtra por gestorId (é o que o formulário de
  // editar cliente realmente grava; c.gestor de string nunca é escrito por lá,
  // então filtrar por nome deixava esse painel sempre zerado após qualquer edição).
  const gestoresComDados = GLR.gestores.map(g => {
    const clientesDoGestor = clientes.filter(c => c.gestorId === g.id);
    const cg = _dashCrescGrupo(clientesDoGestor);
    const crescMedioG = cg ? cg.pct : null;
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
    : '⏳ Carregando automaticamente…';

  // Linha de status compacta (indicadores secundários)
  const stat = (rot, val, sub, tom) => `<div class="dx-stat"><span class="dx-stat-rot">${rot}</span><b class="${tom || ''}">${val}</b>${sub ? `<span class="dx-stat-sub">${sub}</span>` : ''}</div>`;
  const vazioTxt = t => `<div class="dx-vazio">${t}</div>`;

  contAba.innerHTML = `
    <div class="dx-topo">
      <div>
        <div class="dx-h1">Visão geral da carteira</div>
        <div class="dx-sub" id="dash-status-txt">${atualizadoTxt}</div>
      </div>
      <div class="dx-acoes">
        <label class="dx-toggle" title="Atualiza sozinho quando o servidor sincroniza novas vendas (a cada 15 min) e a cada minuto enquanto o Dashboard está aberto">
          <input type="checkbox" id="dash-auto-refresh" ${window._dashAutoDesligado ? '' : 'checked'} onchange="window._dashToggleAutoRefresh(this.checked)">
          <span>Atualização automática</span>
        </label>
        <button class="btn btn-primary" id="btn-dash-atualizar">${ICONE_DX.refresh} Atualizar dados</button>
      </div>
    </div>

    <!-- KPIs principais -->
    <div class="kpi-grid dx-kpis">
      <div class="kpi-flash" data-kpi="fatAtual" data-kpi-val="${faturamentoAtual}">${kpiCard('Faturamento do mês', faturamentoAtual > 0 ? GLR.formatCurrency(faturamentoAtual) : '—', faturamentoAtual > 0 ? 'real, mês até agora' : 'carregando…', true, '', '💵', '', false, 'neutro')}</div>
      <div class="kpi-flash" data-kpi="qtdPedidos" data-kpi-val="${qtdPedidosAtual}">${kpiCard('Pedidos', qtdPedidosAtual > 0 ? qtdPedidosAtual.toLocaleString('pt-BR') : '—', qtdPedidosAtual > 0 ? 'real, mês até agora' : 'carregando…', true, '', '📦', '', false, 'neutro')}</div>
      <div class="kpi-flash" data-kpi="receitaGLR" data-kpi-val="${receitaGLR}">${kpiCard('Receita GLR', receitaGLR > 0 ? GLR.formatCurrency(receitaGLR) : '—', receitaGLR > 0 ? 'comissão real do mês' : 'carregando…', true, '', '💰', '', false, 'neutro')}</div>
      ${kpiCard('Projeção de faturamento', GLR.formatCurrency(faturamentoTotal), crescMedioAPI != null ? `${crescMedioAPI >= 0 ? '+' : ''}${crescMedioAPI.toFixed(1).replace('.', ',')}% vs mês anterior` : (semAPI > 0 ? 'vincule contas para ver dados reais' : ''), crescMedioAPI == null || crescMedioAPI >= 0, '', '🏆', '', false, crescMedioAPI == null ? 'neutro' : '')}
      ${kpiCard('Projeção da receita GLR', projecaoReceitaGLR > 0 ? GLR.formatCurrency(projecaoReceitaGLR) : '—', projecaoReceitaGLR > 0 ? 'estimativa para o fim do mês' : 'carregando…', true, '', '📈', '', false, 'neutro')}
      ${kpiCard('Ticket médio por cliente', ticketMedioGLR > 0 ? GLR.formatCurrency(ticketMedioGLR) : '—', ticketMedioGLR > 0 ? `projeção ÷ ${clientes.length} clientes` : 'carregando…', true, '', '🎟️', '', false, 'neutro')}
    </div>

    <!-- Indicadores secundários -->
    <div class="dx-stats">
      ${stat('Clientes na carteira', clientesTodos.length, `${comAPI} com dados reais`)}
      ${stat('Meta total', metaTotal > 0 ? GLR.formatCurrency(metaTotal) : '—', 'soma das metas')}
      ${stat('Em crescimento', crescimento, `${clientes.length ? Math.round(crescimento / clientes.length * 100) : 0}% da carteira`, crescimento ? 'dx-pos' : '')}
      ${stat('Em risco ou queda', risco + queda, `${risco} em risco · ${queda} em queda`, risco + queda ? 'dx-neg' : '')}
      ${stat('Tarefas pendentes', tarefasPendentes, `${tasksAtras} atrasadas`, tasksAtras ? 'dx-neg' : '')}
      ${stat('Reuniões na semana', reunioesSemana, 'próximos 7 dias')}
    </div>

    <!-- Vendas por dia + canais -->
    <div class="dx-linha dx-2-1">
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Vendas por dia e comissão GLR</div>
            <div class="section-subtitle" id="dash-vd-status">${_dashVendasDiaTxt()}</div>
          </div>
          <button class="btn btn-secondary btn-sm" id="btn-dash-vendas-dia">${ICONE_DX.refresh} Atualizar</button>
        </div>
        <div class="dvd-kpis" id="dash-vd-kpis"></div>
        <div class="chart-wrapper" style="height:300px">
          <canvas id="chart-vendas-dia"></canvas>
        </div>
      </div>
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Faturamento por canal</div>
            <div class="section-subtitle" id="dash-canal-sub">Concentração no mesmo período</div>
          </div>
        </div>
        <div class="dx-canal">
          <div class="dx-canal-graf"><canvas id="chart-canal"></canvas></div>
          <div id="dash-canal-legenda"></div>
        </div>
      </div>
    </div>

    <!-- Atenção: risco + alertas -->
    <div class="dx-linha dx-1-1">
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Clientes em risco ou queda</div>
            <div class="section-subtitle">Ordenados pela maior queda</div>
          </div>
          ${clientesAtencao.length ? `<span class="badge status-risco">${clientesAtencao.length}</span>` : ''}
        </div>
        ${clientesAtencao.length === 0
          ? vazioTxt('Nenhum cliente em risco — carteira saudável.')
          : `<div class="dx-lista">${clientesAtencao.map(c => `
          <div class="dx-li" onclick="Router.navigate('cliente-perfil',{id:${c.id}})">
            <div class="dx-li-txt"><b>${c.nome}</b><span>Gestor: ${nomeGestorDe(c)} · ${GLR.formatCurrency(c.faturamento || 0)}</span></div>
            <div class="dx-li-val"><span class="dx-neg">${c.crescimento || 0}%</span><span class="badge ${GLR.statusColor[c.status]}">${GLR.statusLabel[c.status]}</span></div>
          </div>`).join('')}</div>`}
      </div>

      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Alertas recentes</div>
            <div class="section-subtitle">Críticos primeiro</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('alertas')">Ver todos</button>
        </div>
        ${(() => {
          const tom = { risco: 'dx-dot-neg', queda: 'dx-dot-neg', atrasada: 'dx-dot-ate', meta: 'dx-dot-neu', positivo: 'dx-dot-pos' };
          const alertas = typeof gerarAlertasAutomaticos === 'function' ? gerarAlertasAutomaticos() : [];
          const criticos = alertas.filter(a => a.tipo === 'risco' || a.tipo === 'queda');
          const outros = alertas.filter(a => a.tipo !== 'risco' && a.tipo !== 'queda');
          const lista = [...criticos, ...outros].slice(0, 6);
          if (!lista.length) return vazioTxt('Nenhum alerta no momento.');
          return `<div class="dx-lista">${lista.map(a => `<div class="dx-li" onclick="Router.navigate('alertas')">
              <span class="dx-dot ${tom[a.tipo] || 'dx-dot-neu'}"></span>
              <div class="dx-li-txt"><b>${a.titulo}</b><span>${a.descricao.substring(0, 110)}${a.descricao.length > 110 ? '…' : ''}</span></div>
            </div>`).join('')}</div>`;
        })()}
      </div>
    </div>

    <!-- Evolução + status -->
    <div class="dx-linha dx-2-1">
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Evolução da carteira</div>
            <div class="section-subtitle">Faturamento total nos últimos meses</div>
          </div>
        </div>
        <div class="chart-wrapper"><canvas id="chart-evolucao"></canvas></div>
      </div>
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Distribuição por status</div>
            <div class="section-subtitle">Situação atual da carteira</div>
          </div>
        </div>
        <div class="dx-status">
          <div class="dx-status-graf"><canvas id="chart-status"></canvas></div>
          <div>
            ${['crescimento', 'ativo', 'queda', 'risco'].map(s => {
              const count = clientes.filter(c => c.status === s).length;
              const pct = clientes.length ? Math.round(count / clientes.length * 100) : 0;
              return `<div class="dx-leg"><i style="background:${{ crescimento: 'var(--green)', ativo: 'var(--accent)', queda: 'var(--orange)', risco: 'var(--red)' }[s]}"></i><span>${GLR.statusLabel[s]}</span><b>${count}</b><small>${pct}%</small></div>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>

    <!-- Ranking + gestores -->
    <div class="dx-linha dx-1-1">
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Melhor desempenho</div>
            <div class="section-subtitle">Quem mais ganhou faturamento: projeção do mês × mês passado fechado</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('clientes')">Ver todos</button>
        </div>
        ${clientes.length === 0
          ? vazioTxt('Nenhum cliente com dados ainda.')
          : `<div class="dx-lista">${clientes.filter(c => c._fatM1 > 0).sort((a, b) => ((b.faturamento || 0) - b._fatM1) - ((a.faturamento || 0) - a._fatM1)).slice(0, 6).map((c, i) => `
          <div class="dx-li" onclick="Router.navigate('cliente-perfil', {id: ${c.id}})">
            <span class="dx-pos-n">${i + 1}</span>
            <div class="dx-li-txt"><b>${c.nome}</b><span>${nomeGestorDe(c)} · ${GLR.formatCurrency(c.faturamento || 0)}</span></div>
            <div class="dx-li-val" style="flex-direction:column;align-items:flex-end;gap:0" title="Projeção ${GLR.formatCurrencyFull(c.faturamento || 0)} × mês passado ${GLR.formatCurrencyFull(c._fatM1)}"><span class="${(c.faturamento || 0) >= c._fatM1 ? 'dx-pos' : 'dx-neg'}">${(c.faturamento || 0) >= c._fatM1 ? '+' : '−'}${GLR.formatCurrency(Math.abs((c.faturamento || 0) - c._fatM1))}</span><small>${(c.crescimento || 0) >= 0 ? '+' : ''}${(c.crescimento || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</small></div>
          </div>`).join('')}</div>`}
      </div>

      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Desempenho dos gestores</div>
            <div class="section-subtitle">Carteira de cada um somada: projeção do mês × mês passado fechado</div>
          </div>
        </div>
        ${gestoresComDados.length === 0
          ? vazioTxt('Nenhum gestor cadastrado.')
          : `<div class="dx-lista">${gestoresComDados.map(g => `
          <div class="dx-li" style="cursor:default">
            <span class="dx-av">${g.avatar}</span>
            <div class="dx-li-txt"><b>${g.nome}</b><span>${g.cargo ? g.cargo + ' · ' : ''}${g.qtdClientes} cliente${g.qtdClientes !== 1 ? 's' : ''} · ${g.tarefasPend} tarefa${g.tarefasPend !== 1 ? 's' : ''} pendente${g.tarefasPend !== 1 ? 's' : ''}</span></div>
            <div class="dx-li-val" style="flex-direction:column;align-items:flex-end;gap:0">${g.crescMedio == null ? '<span>—</span>' : `<span class="${g.crescMedio >= 0 ? 'dx-pos' : 'dx-neg'}">${g.crescMedio >= 0 ? '+' : ''}${g.crescMedio.toFixed(1).replace('.', ',')}%</span>`}<small>${GLR.formatCurrency(g.fat)}</small></div>
          </div>`).join('')}</div>`}
      </div>
    </div>

    <!-- Tarefas + eventos -->
    <div class="dx-linha dx-1-1">
      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Tarefas urgentes</div>
            <div class="section-subtitle">Atrasadas ou com prioridade urgente</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('tarefas')">Ver todas</button>
        </div>
        ${(() => {
          const urg = GLR.tarefas.filter(t => t.status !== 'concluida' && (t.status === 'atrasada' || (t.prazo && t.prazo < hojeIsoDash) || t.prioridade === 'urgente')).slice(0, 5);
          if (!urg.length) return vazioTxt('Nenhuma tarefa urgente.');
          return `<div class="dx-lista">${urg.map(t => {
            const atras = t.status === 'atrasada' || (t.prazo && t.prazo < hojeIsoDash);
            return `<div class="dx-li" onclick="Router.navigate('tarefas')">
              <div class="dx-li-txt"><b>${t.titulo}</b><span>${t.responsavel || '—'} · ${formatDate(t.prazo)}${atras ? ' · <em class="dx-neg">atrasada</em>' : ''}</span></div>
              <span class="badge ${GLR.prioridadeColor[t.prioridade]}">${t.prioridade}</span>
            </div>`;
          }).join('')}</div>`;
        })()}
      </div>

      <div class="card">
        <div class="section-header">
          <div>
            <div class="section-title">Próximos eventos</div>
            <div class="section-subtitle">Reuniões, follow-ups e entregas</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('calendario')">Ver calendário</button>
        </div>
        ${!GLR.eventos.length ? vazioTxt('Nenhum evento agendado.') : `<div class="dx-lista">${GLR.eventos.slice(0, 5).map(e => `<div class="dx-li" style="cursor:default">
            <span class="dx-dot" style="background:${GLR.eventoColor[e.tipo] || 'var(--accent)'}"></span>
            <div class="dx-li-txt"><b>${e.titulo}</b><span>${formatDate(e.data)} às ${e.hora} · ${e.responsavel}</span></div>
          </div>`).join('')}</div>`}
      </div>
    </div>

    ${concentracao.some(c => c.faturamento > 0) ? `
    <div class="card dx-bloco">
      <div class="section-header">
        <div>
          <div class="section-title">Concentração de faturamento</div>
          <div class="section-subtitle">Participação de cada cliente</div>
        </div>
      </div>
      <div class="chart-wrapper"><canvas id="chart-concentracao"></canvas></div>
    </div>` : ''}

    <!-- Carteira completa -->
    <div class="card dx-bloco" style="padding:0;overflow:hidden">
      <div class="section-header" style="padding:18px 22px 0">
        <div>
          <div class="section-title">Carteira completa</div>
          <div class="section-subtitle">${clientesTodos.length} clientes · ordenados por faturamento</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="form-input" style="width:220px" placeholder="Buscar cliente ou gestor" oninput="window._dashFiltrarCarteira(this.value)">
          <button class="btn btn-secondary btn-sm" onclick="Router.navigate('clientes')">Gerenciar</button>
        </div>
      </div>
      <div class="table-wrapper" style="padding:6px 0 0">
      <table class="table" id="dx-carteira">
        <thead><tr>
          <th style="padding-left:22px">Cliente</th><th>Gestor</th><th>Status</th>
          <th style="text-align:right;">Faturamento</th>
          <th style="text-align:right;">Crescimento</th>
          <th style="padding-right:22px"></th>
        </tr></thead>
        <tbody>
        ${[...clientesTodos].sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0)).map(c => `
          <tr style="cursor:pointer;" data-busca="${String(c.nome + ' ' + nomeGestorDe(c)).toLowerCase().replace(/"/g, '')}" onclick="Router.navigate('cliente-perfil',{id:${c.id}})">
            <td style="font-weight:600;padding-left:22px">${c.nome}</td>
            <td style="color:var(--text-muted);">${nomeGestorDe(c)}</td>
            <td><span class="badge ${GLR.statusColor[c.status]}">${GLR.statusLabel[c.status]}</span></td>
            <td style="text-align:right;">${c._temAPI ? GLR.formatCurrency(c.faturamento || 0) : '<span style="color:var(--text-muted);">sem dados</span>'}</td>
            <td style="text-align:right;" class="${(c.crescimento || 0) >= 0 ? 'dx-pos' : 'dx-neg'}">${c._temAPI ? `${(c.crescimento || 0) >= 0 ? '+' : ''}${c.crescimento || 0}%` : '—'}</td>
            <td style="text-align:right;padding-right:22px"><button class="btn btn-ghost btn-sm">Ver perfil</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      </div>
    </div>`;

  window._dashFiltrarCarteira = q => {
    q = String(q || '').toLowerCase().trim();
    document.querySelectorAll('#dx-carteira tbody tr').forEach(tr => { tr.style.display = !q || tr.dataset.busca.includes(q) ? '' : 'none'; });
  };

  _dashAplicarFlash();

  document.getElementById('btn-dash-atualizar')?.addEventListener('click', _dashAtualizarTudo);
  document.getElementById('btn-dash-vendas-dia')?.addEventListener('click', _dashBuscarVendasPorDia);

  window._dashToggleAutoRefresh = (ligado) => { window._dashAutoDesligado = !ligado; if (ligado) _dashAutoAtualizar('timer'); };
  // Um timer só, global: a cada minuto verifica se precisa atualizar (a função
  // decide e sai na hora se não estiver no Dashboard).
  if (!window._dashAutoTimer) window._dashAutoTimer = setInterval(() => _dashAutoAtualizar('timer'), 60 * 1000);
  setTimeout(() => _dashAutoAtualizar('abrir'), 300);

  // Charts
  setTimeout(() => {
    const ctxVD = document.getElementById('chart-vendas-dia');
    if (ctxVD) {
      const vd = _dashVendasDiaCache();
      const dias = vd?.dias || [];
      if (!dias.length) {
        ctxVD.parentElement.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:32px 0;">⏳ Carregando as vendas da carteira automaticamente…</div>';
      } else {
        _dashGraficoVendasDia(ctxVD, dias);
      }
    }

    const ctxCanal = document.getElementById('chart-canal');
    const legendaCanal = document.getElementById('dash-canal-legenda');
    if (ctxCanal && legendaCanal) {
      const vd = _dashVendasDiaCache();
      const canais = (vd?.canais || []).filter(c => c.faturamento > 0).sort((a,b) => b.faturamento - a.faturamento);
      if (!canais.length) {
        ctxCanal.parentElement.parentElement.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:32px 0;">⏳ Carregando automaticamente…</div>';
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
        const pa = vd.periodoAnt, dm = iso => iso.slice(8) + '/' + iso.slice(5, 7);
        const sub = document.getElementById('dash-canal-sub');
        if (sub && pa) sub.textContent = `Mês atual × mesmo período do mês passado (${dm(pa.de)} a ${dm(pa.ate)})`;
        const variacao = x => {
          if (!x || !(x.ant > 0)) return `<div style="font-size:11px;color:var(--text-muted);">sem histórico para comparar</div>`;
          const v = (x.atual - x.ant) / x.ant * 100, cor = v >= 1 ? 'var(--green)' : v <= -1 ? 'var(--red)' : 'var(--text-muted)';
          return `<div style="font-size:11px;font-weight:700;color:${cor};" title="${x.lojas} loja${x.lojas !== 1 ? 's' : ''} com os dois meses na base: ${GLR.formatCurrencyFull(x.atual)} agora × ${GLR.formatCurrencyFull(x.ant)} no mês passado">${v >= 1 ? '▲' : v <= -1 ? '▼' : '='} ${Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% vs mês passado</div>`;
        };
        legendaCanal.innerHTML = canais.map((c,i) => {
          const pct = totalFat>0 ? (c.faturamento/totalFat*100) : 0;
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            <div style="width:10px;height:10px;border-radius:50%;background:${corDe(c.nome,i)};flex-shrink:0;"></div>
            <div style="flex:1;font-size:13px;font-weight:600;">${c.nome}</div>
            <div style="text-align:right;">
              <div style="font-size:13px;font-weight:700;">${GLR.formatCurrency(c.faturamento)}</div>
              ${variacao(c.cmp)}
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
        ctx1.parentElement.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:32px 0;">⏳ Carregando o histórico automaticamente…</div>';
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

// Assinatura visual do Dashboard v2: quando um KPI marcado com [data-kpi] muda
// de valor entre uma renderização e a próxima (refresh manual ou automático),
// o card pisca uma vez na cor da direção da mudança. window._dashPrevKpiVals
// sobrevive ao Router.resolve() (que recria todo o DOM) porque fica em
// `window`, não numa variável local do handler da rota.
function _dashAplicarFlash() {
  if (!window._dashPrevKpiVals) window._dashPrevKpiVals = {};
  document.querySelectorAll('.dash-v2 .kpi-flash[data-kpi]').forEach(wrap => {
    const id = wrap.dataset.kpi;
    const val = parseFloat(wrap.dataset.kpiVal) || 0;
    const prev = window._dashPrevKpiVals[id];
    const card = wrap.querySelector('.kpi-card');
    if (card && prev != null && val !== prev) {
      card.classList.remove('kpi-flash-up', 'kpi-flash-down');
      void card.offsetWidth; // força reflow pra poder reiniciar a animação
      card.classList.add(val > prev ? 'kpi-flash-up' : 'kpi-flash-down');
      setTimeout(() => card.classList.remove('kpi-flash-up', 'kpi-flash-down'), 1700);
    }
    window._dashPrevKpiVals[id] = val;
  });
}

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
// Ícones discretos (traço) no lugar dos emojis — Design System v2
const _svg = d => `<svg width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">${d}</svg>`;
const ICONE_DX = {
  refresh: _svg('<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>'),
  '💵': _svg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>'),
  '📦': _svg('<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>'),
  '💰': _svg('<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.7-1.5-3-1.5-1.7 0-3 .9-3 2s1.3 1.7 3 2 3 .9 3 2-1.3 2-3 2c-1.4 0-2.6-.6-3-1.6M12 6v2M12 16v2"/>'),
  '🏆': _svg('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
  '📈': _svg('<path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/>'),
  '🎟️': _svg('<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/>'),
};
function kpiCard(label, value, sub, positive, iconBg, icon, iconColor, rawHtml = false, modo = '') {
  const ic = ICONE_DX[icon] ? `<span class="dx-kpi-ic">${ICONE_DX[icon]}</span>` : '';
  const rodape = rawHtml ? sub
    : modo === 'neutro' ? (sub ? `<div class="dx-kpi-sub">${sub}</div>` : '')
    : `<div class="kpi-delta ${positive ? 'up' : 'down'}">${positive ? '▲' : '▼'} ${sub}</div>`;
  return `<div class="kpi-card"><div class="dx-kpi-top"><div class="kpi-label">${label}</div>${ic}</div><div class="kpi-value">${value}</div>${rodape}</div>`;
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

// Vendas por dia & Comissão GLR: resumo do período + comissão em área (eixo da
// direita) sobre as vendas em barras (eixo da esquerda), dica com o dia inteiro
function _dashGraficoVendasDia(canvas, dias) {
  const css = getComputedStyle(document.documentElement);
  const v = (n, d) => (css.getPropertyValue(n) || '').trim() || d;
  const cor = { texto: v('--text-muted', '#8a8ba3'), titulo: v('--text-primary', '#f1f1f8'), grade: 'rgba(140,140,170,0.12)', fundo: v('--bg-card', '#16161f'), borda: v('--border', 'rgba(255,255,255,0.08)') };
  const AZUL = '#2a78d6', VERDE = '#1baf7a';
  const R = (x, c = 0) => 'R$ ' + (x || 0).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
  const curto = x => x >= 1e6 ? (x / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'M' : x >= 1e3 ? (x / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'k' : String(Math.round(x));
  const soma = k => dias.reduce((t, d) => t + (d[k] || 0), 0);
  const ano = new Date().getFullYear();
  const semana = d => { const [dd, mm] = d.split('/').map(Number); return new Date(ano, mm - 1, dd).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''); };
  const melhor = dias.reduce((m, d) => (d.comissao > (m?.comissao ?? -1) ? d : m), null);
  const iMelhor = dias.indexOf(melhor);

  const kpis = document.getElementById('dash-vd-kpis');
  if (kpis) {
    const tPed = soma('pedidos'), tCom = soma('comissao'), tFat = soma('faturamento');
    const item = (rot, val, sub, c) => `<div class="dvd-kpi"><span class="dvd-rot"><i style="background:${c}"></i>${rot}</span><b>${val}</b><small>${sub}</small></div>`;
    kpis.innerHTML = item('Comissão GLR', R(tCom), `média ${R(tCom / dias.length)}/dia`, VERDE)
      + item('Vendas', tPed.toLocaleString('pt-BR'), `média ${Math.round(tPed / dias.length).toLocaleString('pt-BR')}/dia`, AZUL)
      + (tFat > 0 ? item('Faturamento', R(tFat), `ticket ${R(tPed ? tFat / tPed : 0, 2)}`, 'var(--text-muted)') : '')
      + (melhor ? item('Melhor dia', melhor.data, `${R(melhor.comissao)} de comissão`, '#eb6834') : '');
  }

  const grad = (ctx, c, a1, a2) => { const { chartArea } = ctx.chart; if (!chartArea) return c; const g = ctx.chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom); g.addColorStop(0, c + a1); g.addColorStop(1, c + a2); return g; };
  // linha vertical seguindo o mouse
  const guia = { id: 'guiaVD', afterDatasetsDraw(ch) { const a = ch.tooltip?.getActiveElements?.(); if (!a?.length) return; const x = a[0].element.x, { top, bottom } = ch.chartArea, c = ch.ctx; c.save(); c.strokeStyle = cor.borda; c.lineWidth = 1; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke(); c.restore(); } };

  return new Chart(canvas, {
    data: {
      labels: dias.map(d => d.data),
      datasets: [
        { type: 'line', label: 'Comissão GLR', data: dias.map(d => d.comissao), yAxisID: 'y1', order: 0,
          borderColor: VERDE, backgroundColor: ctx => grad(ctx, VERDE, '55', '00'), fill: 'origin', borderWidth: 2.5, tension: 0.4, cubicInterpolationMode: 'monotone',
          pointRadius: dias.map((_, i) => (i === iMelhor || dias.length === 1 ? 5 : 0)), pointBackgroundColor: VERDE, pointBorderColor: cor.fundo, pointBorderWidth: 2,
          pointHoverRadius: 6, pointHoverBorderWidth: 2, pointHoverBorderColor: cor.fundo },
        { type: 'bar', label: 'Vendas', data: dias.map(d => d.pedidos), yAxisID: 'y', order: 1,
          backgroundColor: ctx => grad(ctx, AZUL, 'cc', '40'), hoverBackgroundColor: AZUL, borderRadius: 6, borderSkipped: false, maxBarThickness: 34, categoryPercentage: 0.7 },
      ],
    },
    plugins: [guia],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 500 },
      plugins: {
        legend: { display: true, align: 'end', labels: { color: cor.texto, font: { size: 11 }, usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, padding: 14 } },
        tooltip: {
          backgroundColor: cor.fundo, titleColor: cor.titulo, bodyColor: cor.texto, borderColor: cor.borda, borderWidth: 1, padding: 12, cornerRadius: 10, boxPadding: 4, usePointStyle: true,
          titleFont: { size: 12, weight: '700' }, bodyFont: { size: 12 },
          callbacks: {
            title: it => `${semana(it[0].label)}, ${it[0].label}`,
            label: ctx => ctx.dataset.yAxisID === 'y1' ? ` Comissão GLR: ${R(ctx.raw, 2)}` : ` Vendas: ${(ctx.raw || 0).toLocaleString('pt-BR')}`,
            afterBody: it => { const d = dias[it[0].dataIndex]; return d?.faturamento > 0 ? [` Faturamento: ${R(d.faturamento)}`] : []; },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: cor.texto, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 } },
        y: { position: 'left', beginAtZero: true, grace: '8%', grid: { color: cor.grade, drawTicks: false }, border: { display: false, dash: [3, 4] },
          ticks: { color: cor.texto, font: { size: 11 }, padding: 8, maxTicksLimit: 5, precision: 0, callback: x => curto(x) } },
        y1: { position: 'right', beginAtZero: true, grace: '8%', grid: { display: false }, border: { display: false },
          ticks: { color: VERDE, font: { size: 11 }, padding: 8, maxTicksLimit: 5, callback: x => 'R$ ' + curto(x) } },
      },
    },
  });
}

function tooltipStyle() {
  return {
    backgroundColor: '#16161f',
    borderColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    titleColor: 'var(--bg-subtle)',
    bodyColor: 'var(--text-muted)',
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
