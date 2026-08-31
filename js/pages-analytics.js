// ============================================================
// GLR Consultoria — Analytics (Painel Executivo do Portfólio)
// Baseado no Dashboard Executivo de referência do usuário, mas
// 100% alimentado por dados reais puxados via API (ML/Shopee) —
// nada é lido de planilha.
// ============================================================

// Registrado como 'analytics-conteudo' (não 'analytics') — essa página agora vive
// dentro do Dashboard unificado, como a aba "Análises da Carteira". A rota
// 'analytics' virou um redirecionamento (ver pages-dashboard.js), mantido só
// pra não quebrar links/atalhos antigos.
Router.register('analytics-conteudo', async (params, el) => {
  const R$  = v => 'R$ '+(parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pad = n => String(n).padStart(2,'0');
  const hoje  = new Date();
  const ontem = new Date(hoje); ontem.setDate(hoje.getDate()-1);
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  const STORAGE_DADOS = 'glr_analytics_dados';
  // Cache separado pra faturamento dos 2 meses FECHADOS (M1/M2) — usado só pra
  // montar a comparação de tendência. Mês fechado não muda mais depois de
  // encerrado, então não precisa refazer essa busca a cada ciclo de 5 min como
  // o mês atual — 24h de validade é de sobra (a "chave" já invalida sozinha
  // se o mês virar, então nem precisa esperar o TTL nesse caso).
  const STORAGE_MESES_FECHADOS = 'glr_analytics_meses_fechados';
  const TTL_MESES_FECHADOS_MS = 24 * 60 * 60 * 1000;
  function _lerCacheMesesFechados() {
    try { return JSON.parse(localStorage.getItem(STORAGE_MESES_FECHADOS) || '{}'); } catch(e) { return {}; }
  }
  function _salvarCacheMesesFechados(obj) {
    try { localStorage.setItem(STORAGE_MESES_FECHADOS, JSON.stringify(obj)); } catch(e) {}
  }
  const STORAGE_QUEDA = 'glr_analytics_queda';
  const STORAGE_PLANO = 'glr_plano_acao';
  const STORAGE_CHECK = 'glr_checklist_diario';

  const LIMITE_SAUDAVEL = 100; // % da meta — status Saudável
  const LIMITE_ATENCAO  = 80;  // % da meta — status Atenção (abaixo disso = Crítico)
  const QUEDA_MIN_PCT   = 30;  // queda mínima (%) pra um produto entrar na lista
  const QUEDA_MIN_VALOR = 150; // faturamento mínimo no período anterior — evita ruído de produto pequeno

  const CHECKLIST_ITENS_PADRAO = [
    'Conferir estoque de todas as variações dos produtos Curva A',
    'Verificar anúncios pausados por falta de estoque',
    'Checar pedidos com risco de atraso de envio',
    'Revisar ROAS/ACOS das campanhas ativas — sinalizar anomalias',
    'Conferir se algum anúncio Curva A ficou sem tráfego/impressões',
    'Validar que campanhas de afiliados estão ativas nas contas elegíveis',
    'Registrar GMV do dia por conta',
  ];

  let abaAtiva = 'executivo'; // executivo | queda | plano | checklist
  let dadosClientes = [];
  let carregandoExec = false;
  let produtosQueda = [];
  let carregandoQueda = false;
  let atualizadoExecEm = null;
  let atualizadoQuedaEm = null;
  let filtroClienteQueda = 'todos';    // id do cliente ou 'todos'
  let filtroPlataformaQueda = 'todas'; // 'todas' | 'Mercado Livre' | 'Shopee' | 'Amazon' | ...

  let planoAcao = [];
  try { planoAcao = JSON.parse(localStorage.getItem(STORAGE_PLANO)||'[]'); } catch(e) {}
  let checklistTodos = {};
  try { checklistTodos = JSON.parse(localStorage.getItem(STORAGE_CHECK)||'{}'); } catch(e) {}
  let checklistDataRef = fmtDate(hoje);

  try {
    const cache = JSON.parse(localStorage.getItem(STORAGE_DADOS)||'null');
    const mesKey = `${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}`;
    if (cache && cache.mesKey === mesKey) { dadosClientes = cache.dados || []; atualizadoExecEm = cache.atualizadoEm; }
  } catch(e) {}
  try {
    const cacheQ = JSON.parse(localStorage.getItem(STORAGE_QUEDA)||'null');
    const produtosCache = cacheQ?.produtos || [];
    // Formato antigo (antes da reformulação por semana) não tem "semanas" — ignora
    // esse cache velho em vez de deixar renderQueda() quebrar tentando usar um
    // campo que não existe.
    const formatoValido = produtosCache.every(p => Array.isArray(p.semanas));
    if (cacheQ && formatoValido) { produtosQueda = produtosCache; atualizadoQuedaEm = cacheQ.atualizadoEm; }
  } catch(e) {}

  async function _mapLimit(items, limit, fn) {
    const ret = [];
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        ret[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
    return ret;
  }

  function statusDe(pctMeta) {
    if (pctMeta === null) return { label: 'Sem meta', cor: 'var(--text-muted)', bg: 'rgba(148,163,184,0.12)' };
    if (pctMeta >= LIMITE_SAUDAVEL) return { label: 'Saudável', cor: '#10b981', bg: 'rgba(16,185,129,0.12)' };
    if (pctMeta >= LIMITE_ATENCAO)  return { label: 'Atenção',  cor: '#f59e0b', bg: 'rgba(245,158,11,0.12)' };
    return { label: 'Crítico', cor: '#ef4444', bg: 'rgba(239,68,68,0.12)' };
  }

  function fmtQtdeDias() {
    return Math.max(ontem.getDate(), 1);
  }

  // ── Painel Executivo: soma faturamento/ADS reais do mês (via API) por cliente,
  // projeta pelo ritmo linear (mesma fórmula da Projeção de Crescimento) ──
  async function buscarDadosExecutivo(forcarTudo = false) {
    if (carregandoExec) return;
    carregandoExec = true;
    render();

    // Cache incremental por cliente: só refaz a busca (pesada — pedidos + ADS por
    // conta) de quem já venceu o TTL ou nunca foi buscado neste mês. Quem ainda
    // está fresco é reaproveitado do cache sem chamar API nenhuma — é o que
    // permite rodar isso automático a cada poucos minutos sem recalcular a
    // carteira inteira toda vez (e sem nunca travar a tela: o que já tem em
    // cache aparece na hora, o resto atualiza por trás).
    const TTL_CLIENTE_MS = 5 * 60 * 1000;
    const mesKeyAgora = `${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}`;
    const cacheAtual = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_DADOS) || 'null'); } catch(e) { return null; } })();
    const cacheDoMes = cacheAtual?.mesKey === mesKeyAgora ? cacheAtual : null;
    const porIdCache = {};
    (cacheDoMes?.dados || []).forEach(d => { porIdCache[d.clienteId] = d; });

    let vinculos = {};
    try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos')||'{}'); } catch(e) {}

    const ano = ontem.getFullYear(), mesN = ontem.getMonth()+1;
    const primeiroDia = `${ano}-${pad(mesN)}-01`;
    const dataTo = fmtDate(ontem);
    const tsFrom = new Date(`${primeiroDia}T00:00:00`).getTime();
    const tsTo   = new Date(`${dataTo}T23:59:59`).getTime();
    const diasNoMes = new Date(ano, mesN, 0).getDate();
    const diasDecorridos = fmtQtdeDias();
    const toShopeeDate = iso => iso.split('-').reverse().join('-');

    // Meses anteriores completos (M1, M2) — só faturamento, pra tendência e diagnóstico.
    // Reaproveita a mesma chamada de pedidos, sem custo extra de ADS.
    function mesCompletoOffset(offset) {
      const d = new Date(ano, mesN-1-offset, 1);
      const y = d.getFullYear(), m = d.getMonth()+1;
      const diasMes = new Date(y, m, 0).getDate();
      return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(diasMes)}`, label: `${['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][d.getMonth()]}/${y}` };
    }
    const m1 = mesCompletoOffset(1), m2 = mesCompletoOffset(2);

    const clientesTodos = GLR.clientes.slice();
    const agora = Date.now();
    const clientes = forcarTudo ? clientesTodos : clientesTodos.filter(c => {
      const cached = porIdCache[c.id];
      return !cached || !cached._atualizadoEm || (agora - cached._atualizadoEm) > TTL_CLIENTE_MS;
    });

    // Ninguém venceu o TTL — reaproveita tudo do cache, zero chamada de API.
    if (!clientes.length && clientesTodos.length) {
      dadosClientes = clientesTodos.map(c => porIdCache[c.id]).filter(Boolean);
      carregandoExec = false;
      render();
      return;
    }

    const resultados = [];
    let doneN = 0;
    const chaveMesesAgora = `${m1.from.slice(0,7)}_${m2.from.slice(0,7)}`;
    const cacheMesesFechados = _lerCacheMesesFechados();

    await _mapLimit(clientes, 3, async (c) => {
      const contasVinc = vinculos[String(c.id)] || [];
      let fatBase = 0, adsBase = 0, fatM1 = 0, fatM2 = 0;
      const canais = new Set();

      const entradaMeses = cacheMesesFechados[c.id];
      const mesesFrescos = !!entradaMeses && entradaMeses.chave === chaveMesesAgora
        && (Date.now() - entradaMeses.atualizadoEm) < TTL_MESES_FECHADOS_MS;
      if (mesesFrescos) { fatM1 = entradaMeses.fatM1 || 0; fatM2 = entradaMeses.fatM2 || 0; }

      await _mapLimit(contasVinc, 3, async (conta) => {
        const mkt = (conta.marketplace||'').toLowerCase();
        try {
          if (['meli','ml','mercadolivre'].includes(mkt)) {
            canais.add('Mercado Livre');
            const meliId = conta.param_to_use?.meliUserId || conta.external_id;
            const somaFat = os => os.reduce((s,o)=> ['cancelled','invalid'].includes((o.status||'').toLowerCase()) ? s : s+(parseFloat(o.total_amount)||0), 0);

            // As 3 janelas de data (mês atual, M1, M2) e a paginação de ADS são
            // independentes entre si — rodar em paralelo em vez de uma esperar a
            // outra corta o tempo por conta de ~4x pra ~1x.
            const tarefas = [
              MarketplaceAPI.mlOrders(meliId, primeiroDia, dataTo).then(os => { fatBase += somaFat(os); }).catch(()=>{}),
              (async () => {
                try {
                  let adsTotal = 0, off = 0;
                  while (true) {
                    const ra = await MarketplaceAPI.call('ml_ads_campaigns', { meliUserId: meliId, date_from: primeiroDia, date_to: dataTo, limit: 50, offset: off });
                    const res = ra.data?.results || [];
                    adsTotal += res.reduce((s,cc) => s + (parseFloat(cc.metrics?.cost)||0), 0);
                    if (res.length < 50) break;
                    off += 50;
                  }
                  adsBase += adsTotal;
                } catch(e) {}
              })(),
            ];
            if (!mesesFrescos) {
              tarefas.push(MarketplaceAPI.mlOrders(meliId, m1.from, m1.to).then(os => { fatM1 += somaFat(os); }).catch(()=>{}));
              tarefas.push(MarketplaceAPI.mlOrders(meliId, m2.from, m2.to).then(os => { fatM2 += somaFat(os); }).catch(()=>{}));
            }
            await Promise.all(tarefas);
          } else if (mkt === 'shopee') {
            canais.add('Shopee');
            const shopId = conta.param_to_use?.shopId || conta.external_id;
            async function subtotalShopeePeriodo(tsF, tsT) {
              let total = 0;
              const sns = await MarketplaceAPI.shopeeListOrderSns(shopId, tsF, tsT);
              for (let i=0; i<sns.length; i+=50) {
                const lote = sns.slice(i,i+50).map(o=>o.sn);
                try {
                  const rd = await MarketplaceAPI.call('shopee_get_order_detail',{shopId, order_sn_list:lote});
                  const orderList = rd.data?.response?.order_list || rd.data?.order_list || [];
                  for (const ord of orderList) {
                    // Blindagem: status tipo READY_TO_SHIP é fila (fica até despachar), não
                    // evento datado — a API pode devolver pedido fora do período pedido
                    // quando o resultado precisa paginar (contas com volume alto,
                    // confirmado com pedido real). Confere o create_time de verdade.
                    if (ord.create_time && (ord.create_time < tsF || ord.create_time > tsT)) continue;
                    const items = ord.item_list || ord.items || [];
                    const subtotal = items.reduce((s,it) => {
                      const p = parseFloat(it.model_discounted_price)||parseFloat(it.item_price)||0;
                      const q = parseInt(it.model_quantity_purchased)||parseInt(it.quantity)||1;
                      return s + p*q;
                    }, 0);
                    total += subtotal > 0 ? subtotal : (parseFloat(ord.total_amount)||0);
                  }
                } catch(e) {}
              }
              return total;
            }
            const tarefasShopee = [
              subtotalShopeePeriodo(Math.floor(tsFrom/1000), Math.floor(tsTo/1000)).then(v => { fatBase += v; }).catch(()=>{}),
              (async () => {
                try {
                  const r = await MarketplaceAPI.call('shopee_ads_daily_performance', { shopId, start_date: toShopeeDate(primeiroDia), end_date: toShopeeDate(dataTo) });
                  const dias = r?.data?.response || [];
                  adsBase += Array.isArray(dias) ? dias.reduce((s,d) => s + (parseFloat(d.expense)||0), 0) : 0;
                } catch(e) {}
              })(),
            ];
            if (!mesesFrescos) {
              tarefasShopee.push(subtotalShopeePeriodo(Math.floor(new Date(`${m1.from}T00:00:00`).getTime()/1000), Math.floor(new Date(`${m1.to}T23:59:59`).getTime()/1000)).then(v => { fatM1 += v; }).catch(()=>{}));
              tarefasShopee.push(subtotalShopeePeriodo(Math.floor(new Date(`${m2.from}T00:00:00`).getTime()/1000), Math.floor(new Date(`${m2.to}T23:59:59`).getTime()/1000)).then(v => { fatM2 += v; }).catch(()=>{}));
            }
            await Promise.all(tarefasShopee);
          }
        } catch(e) { console.warn('[Analytics] erro conta', conta.nickname, e.message); }
      });

      if (!mesesFrescos) {
        cacheMesesFechados[c.id] = { chave: chaveMesesAgora, fatM1, fatM2, atualizadoEm: Date.now() };
      }

      const fatProj = diasDecorridos>0 ? (fatBase/diasDecorridos)*diasNoMes : 0;
      const adsProj = diasDecorridos>0 ? (adsBase/diasDecorridos)*diasNoMes : 0;
      const meta = parseFloat(c.metaMensal)||0;
      const adsIdeal = c.adsIdeal!=null ? c.adsIdeal : 0.04;
      const pctMeta = meta>0 ? (fatProj/meta)*100 : null;
      const pctAdsAtual = fatBase>0 ? (adsBase/fatBase) : 0;
      const gapAds = (pctAdsAtual - adsIdeal) * 100; // pontos percentuais
      const compMesAnt = fatM1>0 ? ((fatProj-fatM1)/fatM1)*100 : null;

      resultados.push({
        clienteId: c.id, nome: c.nome, canal: [...canais].join(' + ') || '—',
        meta, projecao: fatProj, adsProj, pctMeta, pctAdsAtual, adsIdeal, gapAds,
        fatM1, fatM2, compMesAnt, labelM1: m1.label, labelM2: m2.label,
        temConta: contasVinc.length>0,
        _atualizadoEm: Date.now(),
      });

      doneN++;
      const statusEl = document.getElementById('analytics-status');
      if (statusEl) statusEl.textContent = `⏳ Buscando dados reais via API... ${doneN}/${clientes.length} clientes`;
    });

    // Junta quem acabou de ser buscado com quem foi reaproveitado do cache
    // (clientes que ainda estavam dentro do TTL nesta rodada).
    const mapaNovo = {};
    resultados.forEach(r => { mapaNovo[r.clienteId] = r; });
    dadosClientes = clientesTodos.map(c => mapaNovo[c.id] || porIdCache[c.id]).filter(Boolean);

    atualizadoExecEm = Date.now();
    const mesKey = mesKeyAgora;
    localStorage.setItem(STORAGE_DADOS, JSON.stringify({ mesKey, dados: dadosClientes, atualizadoEm: atualizadoExecEm }));
    _salvarCacheMesesFechados(cacheMesesFechados);

    carregandoExec = false;
    render();
  }

  // ── Produtos em Queda: quantidade vendida por produto em 4 semanas do mês
  // corrente (01–07, 08–14, 15–21, 22–fim), pra ver a tendência semana a semana
  // em vez de só comparar dois períodos. Busca tudo de uma vez (todos os
  // clientes/contas); o filtro por Cliente/Plataforma acontece na exibição,
  // sem precisar buscar de novo a cada troca de filtro. ──
  function _semanasDoMes(ano, mesN) {
    const ultimoDia = new Date(ano, mesN, 0).getDate();
    return [
      { de:1, ate:7,  label:'01–07'  },
      { de:8, ate:14, label:'08–14'  },
      { de:15,ate:21, label:'15–21'  },
      { de:22,ate:ultimoDia, label:`22–${pad(ultimoDia)}` },
    ];
  }
  function _semanaDoDia(dia, semanas) {
    for (let i=0;i<semanas.length;i++) if (dia>=semanas[i].de && dia<=semanas[i].ate) return i;
    return semanas.length-1;
  }
  // Classifica a tendência a partir das 4 semanas (unidades vendidas)
  function _tendenciaDe(semanas) {
    const pico = Math.max(...semanas);
    const ultima = semanas[semanas.length-1];
    const primeira = semanas[0];
    if (pico === 0) return null; // nunca vendeu no mês — não é "queda"
    if (ultima === 0 && semanas.slice(0,-1).some(v=>v>0)) return { label:'Zerou', cor:'#ef4444' };
    // Queda contínua: cada semana <= anterior, com pelo menos uma queda real
    const monotonicaQueda = semanas.every((v,i) => i===0 || v <= semanas[i-1]) && ultima < primeira;
    if (monotonicaQueda && primeira > 0) return { label:'Queda contínua', cor:'#f97316' };
    // Despencou: teve um pico bem maior que a última semana (queda abrupta ≥70% do pico)
    if (pico > 0 && ultima <= pico*0.3 && pico >= 4) return { label:'Despencou', cor:'#ef4444' };
    // Queda forte: última semana bem menor que a média das anteriores (≥40% abaixo)
    const mediaAnteriores = semanas.slice(0,-1).reduce((s,v)=>s+v,0) / (semanas.length-1);
    if (mediaAnteriores > 0 && ultima <= mediaAnteriores*0.6) return { label:'Queda forte', cor:'#f59e0b' };
    return null; // sem queda relevante — não entra na lista
  }

  async function buscarProdutosQueda() {
    if (carregandoQueda) return;
    carregandoQueda = true;
    render();

    let vinculos = {};
    try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos')||'{}'); } catch(e) {}

    const ano = ontem.getFullYear(), mesN = ontem.getMonth()+1;
    const primeiroDia = `${ano}-${pad(mesN)}-01`;
    const dataTo = fmtDate(ontem);
    const semanas = _semanasDoMes(ano, mesN);
    const toShopeeTsIni = iso => Math.floor(new Date(`${iso}T00:00:00`).getTime()/1000);
    const toShopeeTsFim = iso => Math.floor(new Date(`${iso}T23:59:59`).getTime()/1000);
    const tsFrom = toShopeeTsIni(primeiroDia), tsTo = toShopeeTsFim(dataTo);

    // key -> { nome, semanas:[0,0,0,0] }
    async function unidadesPorSemanaML(meliUserId) {
      const mapa = {};
      const orders = await MarketplaceAPI.mlOrders(meliUserId, primeiroDia, dataTo);
      for (const o of orders) {
        if (['cancelled','invalid'].includes((o.status||'').toLowerCase())) continue;
        const dt = new Date(o.date_created||0);
        if (isNaN(dt)) continue;
        const sem = _semanaDoDia(dt.getDate(), semanas);
        for (const i of (o.order_items||[])) {
          const nome = i.item?.title || '—';
          const key = i.item?.id || nome;
          const qtd = parseInt(i.quantity)||1;
          if (!mapa[key]) mapa[key] = { nome, semanas:[0,0,0,0] };
          mapa[key].semanas[sem] += qtd;
        }
      }
      return mapa;
    }

    async function unidadesPorSemanaShopee(shopId) {
      const mapa = {};
      let snsList = [];
      try { snsList = await MarketplaceAPI.shopeeListOrderSns(shopId, tsFrom, tsTo); } catch(e) { return mapa; }
      for (let i=0; i<snsList.length; i+=50) {
        const lote = snsList.slice(i,i+50).map(o=>o.sn);
        try {
          const rd = await MarketplaceAPI.call('shopee_get_order_detail',{shopId, order_sn_list:lote});
          const orderList = rd.data?.response?.order_list || rd.data?.order_list || [];
          for (const ord of orderList) {
            // Blindagem: descarta pedido fora do período pedido (create_time real) —
            // status tipo READY_TO_SHIP não é confiável no filtro de data da API.
            if (!ord.create_time || ord.create_time < tsFrom || ord.create_time > tsTo) continue;
            const dt = new Date(ord.create_time*1000);
            const sem = _semanaDoDia(dt.getDate(), semanas);
            const items = ord.item_list || ord.items || [];
            for (const it of items) {
              const nome = it.item_name || it.model_name || '—';
              const key = it.item_id || nome;
              const qtd = parseInt(it.model_quantity_purchased)||parseInt(it.quantity)||1;
              if (!mapa[key]) mapa[key] = { nome, semanas:[0,0,0,0] };
              mapa[key].semanas[sem] += qtd;
            }
          }
        } catch(e) {}
      }
      return mapa;
    }

    const clientesComConta = GLR.clientes.filter(c => (vinculos[String(c.id)]||[]).length>0);
    const resultado = [];
    let doneN = 0;
    const NOME_CANAL = { meli:'Mercado Livre', ml:'Mercado Livre', mercadolivre:'Mercado Livre', shopee:'Shopee', amazon:'Amazon' };

    await _mapLimit(clientesComConta, 2, async (c) => {
      const contasVinc = vinculos[String(c.id)] || [];

      await _mapLimit(contasVinc, 2, async (conta) => {
        const mkt = (conta.marketplace||'').toLowerCase();
        const canal = NOME_CANAL[mkt] || conta.marketplace || 'Outro';
        try {
          let mapa = null;
          if (['meli','ml','mercadolivre'].includes(mkt)) {
            const meliId = conta.param_to_use?.meliUserId || conta.external_id;
            mapa = await unidadesPorSemanaML(meliId);
          } else if (mkt === 'shopee') {
            const shopId = conta.param_to_use?.shopId || conta.external_id;
            mapa = await unidadesPorSemanaShopee(shopId);
          }
          if (!mapa) return;
          for (const k in mapa) {
            const tendencia = _tendenciaDe(mapa[k].semanas);
            if (!tendencia) continue;
            resultado.push({
              clienteId: c.id, cliente: c.nome, plataforma: canal,
              nome: mapa[k].nome, semanas: mapa[k].semanas, semanasLabels: semanas.map(s=>s.label),
              tendencia,
            });
          }
        } catch(e) { console.warn('[Analytics] queda erro conta', conta.nickname, e.message); }
      });

      doneN++;
      const statusEl = document.getElementById('analytics-status');
      if (statusEl) statusEl.textContent = `⏳ Analisando produtos... ${doneN}/${clientesComConta.length} clientes`;
    });

    resultado.sort((a,b)=>b.semanas[0]+b.semanas[1]+b.semanas[2]+b.semanas[3]-(a.semanas[0]+a.semanas[1]+a.semanas[2]+a.semanas[3]));
    produtosQueda = resultado;
    atualizadoQuedaEm = Date.now();
    localStorage.setItem(STORAGE_QUEDA, JSON.stringify({ produtos: produtosQueda, atualizadoEm: atualizadoQuedaEm }));

    carregandoQueda = false;
    render();
  }

  function salvarPlano() { localStorage.setItem(STORAGE_PLANO, JSON.stringify(planoAcao)); }
  function salvarChecklist() { localStorage.setItem(STORAGE_CHECK, JSON.stringify(checklistTodos)); }

  window._analyticsAddAcao = () => {
    const clienteId = parseInt(document.getElementById('pa-cliente').value) || null;
    const canal   = document.getElementById('pa-canal').value.trim();
    const acao    = document.getElementById('pa-acao').value.trim();
    const prazo   = document.getElementById('pa-prazo').value;
    if (!clienteId || !acao) { alert('Selecione o cliente e descreva a ação.'); return; }
    planoAcao.unshift({ id: Date.now(), clienteId, canal, acao, prazo, concluido:false, observacao:'' });
    salvarPlano();
    render();
  };
  window._analyticsToggleAcao = (id) => {
    const item = planoAcao.find(a=>a.id===id);
    if (item) { item.concluido = !item.concluido; salvarPlano(); render(); }
  };
  window._analyticsRemoverAcao = (id) => {
    planoAcao = planoAcao.filter(a=>a.id!==id);
    salvarPlano(); render();
  };
  window._analyticsObsAcao = (id, valor) => {
    const item = planoAcao.find(a=>a.id===id);
    if (item) { item.observacao = valor; salvarPlano(); }
  };

  window._analyticsToggleCheck = (idx) => {
    const dia = checklistTodos[checklistDataRef];
    if (dia?.itens?.[idx]) { dia.itens[idx].concluido = !dia.itens[idx].concluido; salvarChecklist(); render(); }
  };
  window._analyticsObsCheck = (valor) => {
    const dia = checklistTodos[checklistDataRef];
    if (dia) { dia.obs = valor; salvarChecklist(); }
  };
  window._analyticsMudarDataCheck = (valor) => {
    checklistDataRef = valor;
    render();
  };

  function checklistDoDia() {
    if (!checklistTodos[checklistDataRef]) {
      checklistTodos[checklistDataRef] = { itens: CHECKLIST_ITENS_PADRAO.map(t=>({texto:t, concluido:false})), obs:'' };
      salvarChecklist();
    }
    return checklistTodos[checklistDataRef];
  }

  // ── Diagnóstico narrativo automático — gerado a partir dos números
  // já buscados via API (sem texto manual) ──
  function diagnostico(d) {
    const linhas = [];
    if (!d.temConta) { linhas.push('Nenhuma conta vinculada — conecte em Integrações para o Analytics acompanhar esta conta.'); return linhas; }
    if (!d.meta || d.meta <= 0) { linhas.push('Sem meta cadastrada — defina em Carteira de Clientes para calcular %Meta e status.'); }
    else if (d.pctMeta >= LIMITE_SAUDAVEL) linhas.push(`Batendo a meta (${d.pctMeta.toFixed(0)}% projetado).`);
    else if (d.pctMeta >= LIMITE_ATENCAO)  linhas.push(`Perto da meta, mas ainda abaixo (${d.pctMeta.toFixed(0)}% projetado) — atenção no restante do mês.`);
    else linhas.push(`Abaixo da meta (${d.pctMeta.toFixed(0)}% projetado) — risco de não bater o mês.`);

    if (d.compMesAnt != null) {
      if (d.compMesAnt >= 10) linhas.push(`Crescendo ${d.compMesAnt.toFixed(0)}% vs ${d.labelM1}.`);
      else if (d.compMesAnt <= -10) linhas.push(`Queda de ${Math.abs(d.compMesAnt).toFixed(0)}% vs ${d.labelM1} — investigar causa.`);
      else linhas.push(`Estável vs ${d.labelM1} (${d.compMesAnt>=0?'+':''}${d.compMesAnt.toFixed(0)}%).`);
    }

    if (d.pctAdsAtual > 0) {
      if (d.gapAds > 3) linhas.push(`ADS acima do ideal em ${d.gapAds.toFixed(1)} p.p. — revisar eficiência das campanhas.`);
      else if (d.gapAds < -3) linhas.push(`ADS bem abaixo do ideal (${(d.pctAdsAtual*100).toFixed(1)}%) — possível subinvestimento.`);
    }

    const quedasCliente = produtosQueda.filter(p => p.clienteId === d.clienteId);
    if (quedasCliente.length) linhas.push(`${quedasCliente.length} produto${quedasCliente.length>1?'s':''} em queda identificado${quedasCliente.length>1?'s':''} (aba Produtos em Queda).`);

    return linhas;
  }

  // ── Renders ──────────────────────────────────────────────────

  function renderExecutivo() {
    const comMeta = dadosClientes.filter(d => d.meta > 0);
    const metaTotal = comMeta.reduce((s,d)=>s+d.meta, 0);
    const projTotal = dadosClientes.reduce((s,d)=>s+d.projecao, 0);
    const pctMetaPortfolio = metaTotal>0 ? (comMeta.reduce((s,d)=>s+d.projecao,0)/metaTotal)*100 : null;
    const fatTotalReal = dadosClientes.reduce((s,d)=>s+ (d.pctAdsAtual>0 || d.projecao>0 ? d.projecao : 0), 0);
    const adsTotal = dadosClientes.reduce((s,d)=>s+d.adsProj, 0);
    const adsMedio = projTotal>0 ? (adsTotal/projTotal)*100 : 0;
    const contasSaudaveis = comMeta.filter(d => statusDe(d.pctMeta).label==='Saudável').length;

    if (!dadosClientes.length) {
      return `<div style="text-align:center;padding:60px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:12px;">📊</div>
        Nenhum dado carregado ainda. Clique em <strong>🔄 Atualizar dados</strong> para puxar as vendas reais do mês via API.
      </div>`;
    }

    return `
    <div class="kpi-grid mb-24" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));">
      <div class="kpi-card">
        <div class="kpi-icon" style="background:rgba(99,102,241,0.12);"><span style="font-size:18px;">🎯</span></div>
        <div class="kpi-label">Meta Total</div>
        <div class="kpi-value">${R$(metaTotal)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:rgba(16,185,129,0.12);"><span style="font-size:18px;">📈</span></div>
        <div class="kpi-label">Projeção Total</div>
        <div class="kpi-value">${R$(projTotal)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:${statusDe(pctMetaPortfolio).bg};"><span style="font-size:18px;">📊</span></div>
        <div class="kpi-label">% da Meta (Portfólio)</div>
        <div class="kpi-value" style="color:${statusDe(pctMetaPortfolio).cor};">${pctMetaPortfolio!=null?pctMetaPortfolio.toFixed(1)+'%':'—'}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:rgba(245,158,11,0.12);"><span style="font-size:18px;">📢</span></div>
        <div class="kpi-label">ADS Médio</div>
        <div class="kpi-value">${adsMedio.toFixed(1)}%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:rgba(16,185,129,0.12);"><span style="font-size:18px;">✅</span></div>
        <div class="kpi-label">Contas Saudáveis</div>
        <div class="kpi-value">${contasSaudaveis} / ${comMeta.length}</div>
      </div>
    </div>

    ${(() => {
      const comMetaOrdenado = comMeta.slice().sort((a,b)=>(b.pctMeta??-999)-(a.pctMeta??-999));
      const melhor = comMetaOrdenado[0];
      const pior = comMetaOrdenado[comMetaOrdenado.length-1];
      const criticas = dadosClientes.filter(d => statusDe(d.pctMeta).label==='Crítico');
      const saudaveis = dadosClientes.filter(d => statusDe(d.pctMeta).label==='Saudável');
      return `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:24px;">
        <div class="card">
          <div class="section-title mb-10" style="font-size:13px;">🔴 Contas Críticas (${criticas.length})</div>
          ${criticas.length ? criticas.map(d=>`<div style="padding:6px 0;font-size:13px;border-bottom:1px solid var(--border);cursor:pointer;" onclick="Router.navigate('cliente-perfil',{id:${d.clienteId}})">${d.nome} <span style="float:right;color:#ef4444;font-weight:700;">${d.pctMeta!=null?d.pctMeta.toFixed(0)+'%':'—'}</span></div>`).join('') : '<div style="color:var(--text-muted);font-size:12px;">Nenhuma 🎉</div>'}
        </div>
        <div class="card">
          <div class="section-title mb-10" style="font-size:13px;">🟢 Contas Saudáveis (${saudaveis.length})</div>
          ${saudaveis.length ? saudaveis.map(d=>`<div style="padding:6px 0;font-size:13px;border-bottom:1px solid var(--border);cursor:pointer;" onclick="Router.navigate('cliente-perfil',{id:${d.clienteId}})">${d.nome} <span style="float:right;color:#10b981;font-weight:700;">${d.pctMeta!=null?d.pctMeta.toFixed(0)+'%':'—'}</span></div>`).join('') : '<div style="color:var(--text-muted);font-size:12px;">Nenhuma ainda</div>'}
        </div>
        <div class="card">
          <div class="section-title mb-10" style="font-size:13px;">🏆 Ranking Rápido</div>
          <div style="padding:8px 0;font-size:13px;">Melhor: <strong style="color:#10b981;cursor:pointer;" onclick="Router.navigate('cliente-perfil',{id:${melhor?.clienteId||0}})">${melhor ? `${melhor.nome} (${melhor.pctMeta.toFixed(0)}%)` : '—'}</strong></div>
          <div style="padding:8px 0;font-size:13px;border-top:1px solid var(--border);">Pior: <strong style="color:#ef4444;cursor:pointer;" onclick="Router.navigate('cliente-perfil',{id:${pior?.clienteId||0}})">${pior && pior!==melhor ? `${pior.nome} (${pior.pctMeta.toFixed(0)}%)` : '—'}</strong></div>
        </div>
      </div>`;
    })()}

    <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:24px;">
      <div class="card">
        <div class="section-title mb-10" style="font-size:13px;">📊 Meta vs Projeção (todas as contas)</div>
        <div style="height:260px;"><canvas id="analytics-chart-meta"></canvas></div>
      </div>
      <div class="card">
        <div class="section-title mb-10" style="font-size:13px;">🚦 Distribuição por Status</div>
        <div style="height:260px;"><canvas id="analytics-chart-status"></canvas></div>
      </div>
    </div>

    <div class="card" style="padding:0;overflow:hidden;">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);font-weight:700;">🚦 Semáforo por Conta</div>
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:800px;">
        <thead>
          <tr style="background:#1a2744;color:white;">
            <th style="padding:10px 12px;text-align:left;">Conta</th>
            <th style="padding:10px 8px;text-align:left;">Canal</th>
            <th style="padding:10px 8px;text-align:right;">Meta</th>
            <th style="padding:10px 8px;text-align:right;">Projeção</th>
            <th style="padding:10px 8px;text-align:center;">% Meta</th>
            <th style="padding:10px 8px;text-align:right;">Tendência</th>
            <th style="padding:10px 8px;text-align:right;">ADS Atual</th>
            <th style="padding:10px 8px;text-align:right;">ADS Ideal</th>
            <th style="padding:10px 8px;text-align:right;">GAP ADS</th>
            <th style="padding:10px 8px;text-align:center;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${dadosClientes.slice().sort((a,b)=>(a.pctMeta??999)-(b.pctMeta??999)).map((d,i) => {
            const st = statusDe(d.pctMeta);
            return `
            <tr style="background:${i%2===0?'var(--bg-card)':'var(--bg-surface)'};cursor:pointer;"
                onclick="Router.navigate('cliente-perfil',{id:${d.clienteId}})">
              <td style="padding:9px 12px;font-weight:600;border-left:3px solid ${st.cor};">${d.nome}${!d.temConta?' <span style="font-size:10px;color:var(--text-muted);font-weight:400;">(sem conta vinculada)</span>':''}</td>
              <td style="padding:9px 8px;color:var(--text-secondary);">${d.canal}</td>
              <td style="padding:9px 8px;text-align:right;">${d.meta>0?R$(d.meta):'<span style="color:var(--text-muted);">sem meta</span>'}</td>
              <td style="padding:9px 8px;text-align:right;font-weight:600;color:var(--accent-light);">${R$(d.projecao)}</td>
              <td style="padding:9px 8px;text-align:center;">
                ${d.pctMeta!=null?`<span style="background:${st.bg};color:${st.cor};font-weight:700;padding:3px 8px;border-radius:99px;font-size:11px;">${d.pctMeta.toFixed(1)}%</span>`:'<span style="color:var(--text-muted);">—</span>'}
              </td>
              <td style="padding:9px 8px;text-align:right;font-weight:600;color:${d.compMesAnt==null?'var(--text-muted)':d.compMesAnt>=0?'#10b981':'#ef4444'};">${d.compMesAnt!=null?(d.compMesAnt>=0?'▲ +':'▼ ')+d.compMesAnt.toFixed(1)+'%':'—'}</td>
              <td style="padding:9px 8px;text-align:right;">${(d.pctAdsAtual*100).toFixed(1)}%</td>
              <td style="padding:9px 8px;text-align:right;color:var(--text-muted);">${(d.adsIdeal*100).toFixed(1)}%</td>
              <td style="padding:9px 8px;text-align:right;color:${d.gapAds<=0?'#10b981':'#ef4444'};font-weight:600;">${d.gapAds>=0?'+':''}${d.gapAds.toFixed(1)} p.p.</td>
              <td style="padding:9px 8px;text-align:center;"><span style="background:${st.bg};color:${st.cor};font-weight:700;padding:3px 10px;border-radius:99px;font-size:11px;">${st.label}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;padding:10px 4px;font-size:11px;color:var(--text-muted);margin-bottom:20px;">
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#10b981;border-radius:3px;"></span> Saudável (≥${LIMITE_SAUDAVEL}% da meta)</span>
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#f59e0b;border-radius:3px;"></span> Atenção (${LIMITE_ATENCAO}–${LIMITE_SAUDAVEL}%)</span>
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#ef4444;border-radius:3px;"></span> Crítico (&lt;${LIMITE_ATENCAO}%)</span>
      <span style="margin-left:auto;">🎯 Configure Meta e ADS Ideal em Carteira de Clientes → editar cliente</span>
    </div>

    <div class="card" style="padding:0;overflow:hidden;">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);font-weight:700;">🔍 Diagnóstico Automático por Conta</div>
      ${dadosClientes.slice().sort((a,b)=>(a.pctMeta??999)-(b.pctMeta??999)).map(d => `
        <div style="padding:12px 18px;border-bottom:1px solid var(--border);cursor:pointer;" onclick="Router.navigate('cliente-perfil',{id:${d.clienteId}})">
          <div style="font-weight:700;font-size:13px;margin-bottom:4px;color:${statusDe(d.pctMeta).cor};">${d.nome}</div>
          <ul style="margin:0;padding-left:18px;font-size:12px;color:var(--text-secondary);">
            ${diagnostico(d).map(l=>`<li>${l}</li>`).join('')}
          </ul>
        </div>`).join('')}
    </div>`;
  }

  function renderQueda() {
    if (!produtosQueda.length) {
      return `<div style="text-align:center;padding:60px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:12px;">📉</div>
        ${carregandoQueda ? 'Analisando produtos...' : 'Nenhum dado carregado ainda. Clique em <strong>🔄 Atualizar dados</strong> para ver a tendência semana a semana, produto a produto.'}
      </div>`;
    }

    const clientesOpts = [...new Set(produtosQueda.map(p=>p.clienteId))]
      .map(id => GLR.clientes.find(c=>c.id===id))
      .filter(Boolean)
      .sort((a,b)=>a.nome.localeCompare(b.nome));

    const filtrados1 = filtroClienteQueda === 'todos'
      ? produtosQueda
      : produtosQueda.filter(p => String(p.clienteId) === String(filtroClienteQueda));

    const plataformasOpts = [...new Set(filtrados1.map(p=>p.plataforma))].sort();

    const filtrados = filtroPlataformaQueda === 'todas'
      ? filtrados1
      : filtrados1.filter(p => p.plataforma === filtroPlataformaQueda);

    return `
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">
      <select id="qd-filtro-cliente" class="form-input" style="width:220px;" onchange="_analyticsFiltrarQuedaCliente(this.value)">
        <option value="todos" ${filtroClienteQueda==='todos'?'selected':''}>Todos os clientes</option>
        ${clientesOpts.map(c=>`<option value="${c.id}" ${String(filtroClienteQueda)===String(c.id)?'selected':''}>${c.nome}</option>`).join('')}
      </select>
      <select id="qd-filtro-plataforma" class="form-input" style="width:180px;" onchange="_analyticsFiltrarQuedaPlataforma(this.value)">
        <option value="todas" ${filtroPlataformaQueda==='todas'?'selected':''}>Todas plataformas</option>
        ${plataformasOpts.map(p=>`<option value="${p}" ${filtroPlataformaQueda===p?'selected':''}>${p}</option>`).join('')}
      </select>
      <div style="font-size:11px;color:var(--text-muted);">Quantidade vendida por semana no mês corrente · ${filtrados.length} produto${filtrados.length!==1?'s':''} em queda</div>
    </div>
    <div class="card" style="padding:0;overflow:hidden;">
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:760px;">
        <thead>
          <tr style="background:#1a2744;color:white;">
            <th style="padding:10px 12px;text-align:left;">Produto</th>
            ${filtroClienteQueda==='todos' ? '<th style="padding:10px 8px;text-align:left;">Cliente</th>' : ''}
            <th style="padding:10px 8px;text-align:left;">Canal</th>
            ${(filtrados[0]?.semanasLabels||['01–07','08–14','15–21','22–fim']).map(l=>`<th style="padding:10px 8px;text-align:center;">${l}</th>`).join('')}
            <th style="padding:10px 8px;text-align:center;">Tendência</th>
          </tr>
        </thead>
        <tbody>
          ${filtrados.length ? filtrados.map((p,i) => `
            <tr style="background:${i%2===0?'var(--bg-card)':'var(--bg-surface)'};cursor:pointer;" onclick="Router.navigate('cliente-perfil',{id:${p.clienteId}})">
              <td style="padding:9px 12px;font-weight:600;max-width:280px;">${p.nome}</td>
              ${filtroClienteQueda==='todos' ? `<td style="padding:9px 8px;color:var(--text-secondary);">${p.cliente}</td>` : ''}
              <td style="padding:9px 8px;color:var(--text-secondary);">${p.plataforma}</td>
              ${p.semanas.map((v,idx)=>`<td style="padding:9px 8px;text-align:center;${idx===p.semanas.length-1?'font-weight:700;':''}">${v} un.</td>`).join('')}
              <td style="padding:9px 8px;text-align:center;">
                <span style="display:inline-flex;align-items:center;gap:5px;color:${p.tendencia.cor};font-weight:700;">
                  <span style="width:8px;height:8px;border-radius:50%;background:${p.tendencia.cor};display:inline-block;"></span>
                  ${p.tendencia.label}
                </span>
              </td>
            </tr>`).join('') : `<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--text-muted);">Nenhum produto em queda pra esse filtro.</td></tr>`}
        </tbody>
      </table>
      </div>
    </div>`;
  }

  function renderPlano() {
    const clientesOpts = GLR.clientes.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
    const porCliente = {};
    for (const a of planoAcao) { (porCliente[a.clienteId] = porCliente[a.clienteId]||[]).push(a); }
    const nomeCliente = id => GLR.clientes.find(c=>c.id===id)?.nome || '—';

    return `
    <div class="card mb-16">
      <div class="section-title mb-10" style="font-size:13px;">➕ Nova Ação</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 2fr 1fr auto;gap:8px;align-items:end;">
        <div><div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px;">Cliente</div>
          <select id="pa-cliente" class="form-input" style="width:100%;"><option value="">Selecione</option>${clientesOpts}</select></div>
        <div><div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px;">Canal</div>
          <input id="pa-canal" class="form-input" placeholder="Ex: Mercado Livre"></div>
        <div><div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px;">Ação</div>
          <input id="pa-acao" class="form-input" placeholder="Descreva a ação recomendada"></div>
        <div><div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px;">Prazo</div>
          <input id="pa-prazo" type="date" class="form-input" style="width:100%;"></div>
        <button class="btn-primary" style="padding:9px 16px;" onclick="_analyticsAddAcao()">+ Add</button>
      </div>
    </div>

    ${!planoAcao.length ? `<div style="text-align:center;padding:40px;color:var(--text-muted);">Nenhuma ação cadastrada ainda.</div>` :
      Object.keys(porCliente).map(cid => `
      <div class="card mb-12" style="padding:0;overflow:hidden;">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-weight:700;">${nomeCliente(parseInt(cid))}</div>
        ${porCliente[cid].map(a => `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);${a.concluido?'opacity:.55;':''}">
            <input type="checkbox" ${a.concluido?'checked':''} onchange="_analyticsToggleAcao(${a.id})" style="margin-top:3px;">
            <div style="flex:1;">
              <div style="font-size:13px;${a.concluido?'text-decoration:line-through;':''}">${a.acao}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${a.canal||'—'} ${a.prazo?' · Prazo: '+formatDate(a.prazo):''}</div>
              <input class="form-input" placeholder="Observação..." value="${a.observacao||''}"
                style="margin-top:6px;font-size:11px;padding:5px 8px;" onchange="_analyticsObsAcao(${a.id}, this.value)">
            </div>
            <button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="_analyticsRemoverAcao(${a.id})">🗑️</button>
          </div>`).join('')}
      </div>`).join('')}
    `;
  }

  function renderChecklist() {
    const dia = checklistDoDia();
    const feitos = dia.itens.filter(i=>i.concluido).length;
    return `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
      <input type="date" class="form-input" value="${checklistDataRef}" style="width:160px;" onchange="_analyticsMudarDataCheck(this.value)">
      <div style="font-size:13px;color:var(--text-muted);">Progresso: <strong style="color:var(--text-primary);">${feitos}/${dia.itens.length}</strong></div>
    </div>
    <div class="card" style="padding:0;overflow:hidden;">
      ${dia.itens.map((it,idx) => `
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);">
          <input type="checkbox" ${it.concluido?'checked':''} onchange="_analyticsToggleCheck(${idx})">
          <div style="flex:1;font-size:13px;${it.concluido?'text-decoration:line-through;color:var(--text-muted);':''}">${it.texto}</div>
        </div>`).join('')}
    </div>
    <div class="card mt-16">
      <div class="section-title mb-10" style="font-size:13px;">Observações do dia</div>
      <textarea class="form-input" rows="3" style="width:100%;box-sizing:border-box;" onchange="_analyticsObsCheck(this.value)">${dia.obs||''}</textarea>
    </div>`;
  }

  function tabBtn(id, label) {
    const ativo = abaAtiva === id;
    return `<button id="analytics-tab-${id}" style="padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-weight:${ativo?'700':'600'};font-size:13px;background:${ativo?'#6366f1':'var(--bg-card-hover)'};color:${ativo?'var(--text-primary)':'var(--text-secondary)'};">${label}</button>`;
  }

  function render() {
    el.innerHTML = `
    <div class="page">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
        <div>
          <h1 style="font-size:20px;font-weight:800;margin:0;">📊 Analytics — Painel Executivo</h1>
          <div id="analytics-status" style="font-size:12px;color:var(--text-muted);margin-top:4px;">
            ${abaAtiva==='executivo' ? (atualizadoExecEm?`Atualizado em ${new Date(atualizadoExecEm).toLocaleString('pt-BR')}`:'Nenhum dado carregado ainda') : ''}
            ${abaAtiva==='queda' ? (atualizadoQuedaEm?`Atualizado em ${new Date(atualizadoQuedaEm).toLocaleString('pt-BR')}`:'Nenhum dado carregado ainda') : ''}
          </div>
        </div>
        ${abaAtiva==='executivo' ? `<button class="btn-primary" style="padding:8px 16px;" ${carregandoExec?'disabled':''} onclick="_analyticsBuscarExec()">${carregandoExec?'⏳ Buscando...':'🔄 Atualizar dados'}</button>` : ''}
        ${abaAtiva==='queda' ? `<button class="btn-primary" style="padding:8px 16px;" ${carregandoQueda?'disabled':''} onclick="_analyticsBuscarQueda()">${carregandoQueda?'⏳ Analisando...':'🔄 Atualizar dados'}</button>` : ''}
      </div>

      <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;">
        ${tabBtn('executivo','🚦 Painel Executivo')}
        ${tabBtn('queda','📉 Produtos em Queda')}
        ${tabBtn('plano','✅ Plano de Ação')}
        ${tabBtn('checklist','☑ Checklist Diário')}
      </div>

      <div id="analytics-conteudo">
        ${abaAtiva==='executivo' ? renderExecutivo() : ''}
        ${abaAtiva==='queda' ? renderQueda() : ''}
        ${abaAtiva==='plano' ? renderPlano() : ''}
        ${abaAtiva==='checklist' ? renderChecklist() : ''}
      </div>
    </div>`;

    ['executivo','queda','plano','checklist'].forEach(id => {
      document.getElementById(`analytics-tab-${id}`)?.addEventListener('click', () => { abaAtiva = id; render(); });
    });

    if (abaAtiva === 'executivo' && dadosClientes.length) {
      setTimeout(() => {
        const ctxMeta = document.getElementById('analytics-chart-meta');
        if (ctxMeta) {
          const ord = dadosClientes.slice().sort((a,b)=>(a.pctMeta??999)-(b.pctMeta??999));
          new Chart(ctxMeta, {
            type: 'bar',
            data: {
              labels: ord.map(d=>d.nome),
              datasets: [
                { label: 'Meta', data: ord.map(d=>d.meta), backgroundColor: 'rgba(245,158,11,0.5)', borderRadius: 4 },
                { label: 'Projeção', data: ord.map(d=>d.projecao), backgroundColor: 'rgba(99,102,241,0.7)', borderRadius: 4 },
              ]
            },
            options: { ...chartDefaults(), plugins: { legend: { display: true, labels: { color: '#9192a8', font: { size: 11 }, boxWidth: 12 } }, tooltip: tooltipStyle() } }
          });
        }
        const ctxStatus = document.getElementById('analytics-chart-status');
        if (ctxStatus) {
          const cont = { Saudável:0, Atenção:0, Crítico:0, 'Sem meta':0 };
          dadosClientes.forEach(d => { const l = statusDe(d.pctMeta).label; cont[l==='Sem meta'?'Sem meta':l] = (cont[l==='Sem meta'?'Sem meta':l]||0)+1; });
          new Chart(ctxStatus, {
            type: 'doughnut',
            data: {
              labels: Object.keys(cont),
              datasets: [{ data: Object.values(cont), backgroundColor: ['#10b981','#f59e0b','#ef4444','#64748b'] }]
            },
            options: { responsive:true, maintainAspectRatio:false, plugins: { legend: { position:'bottom', labels: { color: '#9192a8', font: { size: 11 }, boxWidth: 12 } }, tooltip: tooltipStyle() } }
          });
        }
      }, 50);
    }
  }

  window._analyticsBuscarExec  = () => buscarDadosExecutivo();
  window._analyticsBuscarQueda = () => buscarProdutosQueda();
  window._analyticsFiltrarQuedaCliente = (valor) => {
    filtroClienteQueda = valor;
    filtroPlataformaQueda = 'todas'; // trocar de cliente reseta o filtro de plataforma (opções mudam)
    render();
  };
  window._analyticsFiltrarQuedaPlataforma = (valor) => {
    filtroPlataformaQueda = valor;
    render();
  };

  render();
});
