// ============================================================
// GLR Consultoria — Marketplace Connect API Integration
// Base URL: https://mcp.tiops.com.br
// Docs: https://marketplaces.tiops.com.br/docs/api.html
// ============================================================

const MarketplaceAPI = {
  BASE_URL: 'https://mcp.tiops.com.br',

  // Retorna a API key salva
  getApiKey() {
    return localStorage.getItem('glr_mc_apikey') || '';
  },

  // Chamada genérica à API
  async call(action, params = {}, apiKey = null) {
    const key = apiKey || this.getApiKey();
    if (!key) throw new Error('API key não configurada');

    const res = await fetch(this.BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify({ action, params }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.status && json.status !== 200) throw new Error(json.message || 'Erro na API');
    return json;
  },

  // ── Contas ─────────────────────────────────────────────────
  async listAccounts() {
    const r = await this.call('list_accounts');
    // A API retorna { data: { accounts: [...] } }
    return r.data?.accounts || r.data || [];
  },

  async creditsStatus() {
    const r = await this.call('credits_status');
    return r.data || {};
  },

  // ── Mercado Livre ──────────────────────────────────────────

  // Busca pedidos ML paginando até buscar todos
  async mlOrders(meliUserId, dateFrom, dateTo) {
    const PAGE = 50; // API cap
    let offset = 0;
    let allResults = [];
    let total = null; // só seteado quando a API retornar paging.total

    do {
      // Retry com backoff: uma página instável não pode derrubar o mês inteiro
      let r = null, tent = 0;
      while (tent < 3) {
        try {
          r = await this.call('list_orders_detail', {
            meliUserId,
            date_from: dateFrom,
            date_to:   dateTo,
            limit:     PAGE,
            offset,
          });
          break;
        } catch(e) {
          tent++;
          console.warn(`[ML] offset=${offset} falhou (tentativa ${tent}/3):`, e.message);
          if (tent >= 3) break;
          await new Promise(res=>setTimeout(res, 1500*tent));
        }
      }
      if (!r) {
        // 3 falhas seguidas: mantém o que já baixou em vez de perder tudo
        console.error(`[ML] offset=${offset} falhou 3x — usando ${allResults.length} pedidos parciais`);
        break;
      }
      const data    = r.data || {};
      const results = data.results || [];
      const paging  = data.paging  || {};

      allResults = allResults.concat(results);
      // Só usa paging.total como referência quando a API explicitamente retornar
      if (total === null && paging.total > 0) total = paging.total;

      console.log(`[ML] offset=${offset} | página=${results.length} | total=${total??'?'} | acumulado=${allResults.length}`);

      // Para somente quando a página retornar menos que o limite (última página)
      // OU quando já temos todos os pedidos declarados pelo paging
      if (results.length < PAGE) break;
      if (total !== null && allResults.length >= total) break;
      offset += PAGE;
    } while (true);

    const fat = allResults.reduce((s,o)=>s+(parseFloat(o.total_amount)||0),0);
    console.log(`[ML] ${dateFrom} → ${dateTo}: ${allResults.length} pedidos | fat: R$ ${fat.toFixed(2)}`);
    return allResults;
  },

  // Resumo financeiro: soma total_amount de TODOS os pedidos do período
  async mlFaturamento(meliUserId, dateFrom, dateTo) {
    const orders = await this.mlOrders(meliUserId, dateFrom, dateTo);
    const fat = orders.reduce((s, o) => s + (parseFloat(o.total_amount) || 0), 0);
    return { faturamento: fat, pedidos: orders.length, plataforma: 'Mercado Livre' };
  },

  // Métricas de ADS ML
  async mlAdsMetrics(meliUserId, dateFrom, dateTo) {
    try {
      const r = await this.call('ml_ads_campaigns', { meliUserId, date_from: dateFrom, date_to: dateTo });
      const campaigns = r.data || [];
      const totalCost = campaigns.reduce((s, c) => s + (parseFloat(c.cost) || 0), 0);
      const totalClicks = campaigns.reduce((s, c) => s + (parseInt(c.clicks) || 0), 0);
      return { investimento: totalCost, cliques: totalClicks, campanhas: campaigns.length };
    } catch(e) {
      return { investimento: 0, cliques: 0, campanhas: 0 };
    }
  },

  // ── Shopee ────────────────────────────────────────────────

  // Resumo de vendas Shopee (até 90 dias)
  // Soma COMPLETED + READY_TO_SHIP + SHIPPED (exclui CANCELLED e UNPAID)
  async shopeeFaturamento(shopId, dias = 30) {
    const diasLimitado = Math.min(dias, 90);
    const statuses = ['COMPLETED', 'READY_TO_SHIP', 'SHIPPED'];
    let totalFaturamento = 0;
    let totalPedidos = 0;
    let totalItens = 0;

    for (const st of statuses) {
      try {
        const r = await this.call('shopee_sales_summary', {
          shopId,
          days: diasLimitado,
          order_status: st,
        });
        const d = r.data || r || {};
        totalFaturamento += parseFloat(d.total_revenue) || 0;
        totalPedidos     += parseInt(d.total_orders)    || 0;
        totalItens       += parseInt(d.total_items)     || 0;
      } catch(e) {
        console.warn(`[SHOPEE] erro status ${st}:`, e.message);
      }
    }

    const ticketMedio = totalPedidos > 0 ? totalFaturamento / totalPedidos : 0;
    console.log(`[SHOPEE] ${diasLimitado} dias: ${totalPedidos} pedidos | R$ ${totalFaturamento.toFixed(2)}`);
    return {
      faturamento: totalFaturamento,
      pedidos:     totalPedidos,
      itens:       totalItens,
      ticketMedio,
      plataforma:  'Shopee',
    };
  },

  // Lista TODOS os order_sn da Shopee num intervalo de datas exato (paginado, multi-status)
  // tsFrom/tsTo em segundos (epoch). Retorna [{ sn, status }]
  // A API Shopee limita create_time a 15 dias por request — divide em chunks de 14 dias
  async shopeeListOrderSns(shopId, tsFrom, tsTo, statuses) {
    const sts = statuses || ['COMPLETED','READY_TO_SHIP','PROCESSED','SHIPPED','INVOICE_PENDING'];
    const CHUNK = 14 * 24 * 3600; // 14 dias em segundos (seguro abaixo do limite de 15)
    const out = [];
    const seen = new Set();

    for (let cFrom = tsFrom; cFrom < tsTo; cFrom += CHUNK) {
      const cTo = Math.min(cFrom + CHUNK - 1, tsTo);
      const label = `${new Date(cFrom*1000).toLocaleDateString('pt-BR')}→${new Date(cTo*1000).toLocaleDateString('pt-BR')}`;

      // A API EXIGE order_status — busca por status, um a um
      for (const st of sts) {
        let cursor = '';
        do {
          const params = { shopId, time_range_field:'create_time', time_from:cFrom, time_to:cTo, page_size:100, order_status:st };
          if (cursor) params.cursor = cursor;
          let resp;
          try { resp = await this.call('shopee_list_orders', params); }
          catch(e) { console.warn(`[SHOPEE] ${label} ${st}:`, e.message); break; }
          const r = resp.data?.response || {};
          const orders = r.order_list || [];
          if (orders.length) console.log(`[SHOPEE] ${label} ${st} → ${orders.length} pedidos`);
          for (const o of orders) {
            if (!seen.has(o.order_sn)) { seen.add(o.order_sn); out.push({ sn: o.order_sn, status: st }); }
          }
          cursor = r.more ? (r.next_cursor||'') : '';
        } while (cursor);
      }
    }

    console.log(`[SHOPEE] list_orders ${tsFrom}→${tsTo}: ${out.length} pedidos únicos`);
    return out;
  },

  // Saldo de ADS Shopee
  async shopeeAdsBalance({ shopId }) {
    const r = await this.call('shopee_ads_balance', { shopId });
    return r;
  },

  // Performance diária de ADS Shopee (gasto real por período)
  async shopeeAdsDailyPerformance({ shopId, start_date, end_date }) {
    const r = await this.call('shopee_ads_daily_performance', { shopId, start_date, end_date });
    return r;
  },

  // Métricas detalhadas de ADS Shopee (agrupa diário em resumo)
  async shopeeAdsMetricsDetailed(shopId, start_date, end_date) {
    try {
      const r = await this.call('shopee_ads_daily_performance', { shopId, start_date, end_date });
      const dias = r?.data?.response || r?.data?.data || r?.data || [];
      if (!Array.isArray(dias) || dias.length === 0) return { investimento: 0, cliques: 0, impressoes: 0 };
      return {
        investimento: dias.reduce((s, d) => s + (parseFloat(d.expense) || parseFloat(d.cost) || 0), 0),
        cliques:      dias.reduce((s, d) => s + (parseInt(d.clicks)    || 0), 0),
        impressoes:   dias.reduce((s, d) => s + (parseInt(d.impressions) || 0), 0),
      };
    } catch(e) {
      return { investimento: 0, cliques: 0, impressoes: 0 };
    }
  },

  // Lista campanhas de ADS Shopee
  async shopeeAdsCampaigns({ shopId }) {
    const r = await this.call('shopee_ads_campaigns', { shopId });
    return r?.data?.response || r?.data || [];
  },

  // Performance diária por campanha Shopee
  async shopeeAdsCampaignDaily({ shopId, campaign_id, start_date, end_date }) {
    const r = await this.call('shopee_ads_campaign_daily', { shopId, campaign_id, start_date, end_date });
    return r?.data?.response || r?.data || [];
  },

  // Campanhas ADS Mercado Livre com métricas
  async mlAdsCampaigns({ meliUserId, date_from, date_to }) {
    const r = await this.call('ml_ads_campaigns', { meliUserId, date_from, date_to });
    return r?.data || [];
  },

  // Performance da loja Shopee
  async shopeePerformance(shopId) {
    try {
      const r = await this.call('shopee_get_shop_performance', { shopId });
      return r.data || {};
    } catch(e) { return {}; }
  },

  // ── Importação completa de um cliente ─────────────────────
  // Retorna { ml: {...}, shopee: {...} } para o mês atual
  async importarClienteMes(contas, mes, ano) {
    const resultado  = [];
    const hoje       = new Date();
    const mesAtual   = mes === hoje.getMonth() && ano === hoje.getFullYear();
    const pad        = n => String(n).padStart(2, '0');

    const primeiroDia    = `${ano}-${pad(mes + 1)}-01`;
    const ultimoDiaDoMes = new Date(ano, mes + 1, 0).getDate();
    const diasMes        = ultimoDiaDoMes;

    // Para o mês atual: base sempre até o dia anterior (fechado). Meses passados: último dia do mês.
    const ontem          = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
    const diasDecorridos = mesAtual ? ontem.getDate() : diasMes;
    const dateTo         = mesAtual
      ? `${ano}-${pad(mes + 1)}-${pad(ontem.getDate())}`
      : `${ano}-${pad(mes + 1)}-${pad(ultimoDiaDoMes)}`;

    for (const conta of contas) {
      try {
        if (['mercadolivre','ml','meli'].includes(conta.marketplace)) {
          const meliId = conta.param_to_use?.meliUserId || conta.external_id;
          const fat    = await this.mlFaturamento(meliId, primeiroDia, dateTo);
          const ads    = await this.mlAdsMetrics(meliId, primeiroDia, dateTo);
          resultado.push({ ...fat, ...ads, conta: conta.nickname, diasDecorridos, diasMes });
        }
        if (conta.marketplace === 'shopee') {
          // Shopee usa número de dias — usa diasDecorridos para mês atual
          const fat = await this.shopeeFaturamento(conta.param_to_use?.shopId || conta.external_id, diasDecorridos);
          resultado.push({ ...fat, conta: conta.nickname, diasDecorridos, diasMes });
        }
      } catch(e) {
        resultado.push({ plataforma: conta.nickname, erro: e.message, faturamento: 0, pedidos: 0 });
      }
    }

    return resultado;
  },
};

window.MarketplaceAPI = MarketplaceAPI;
