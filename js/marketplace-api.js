// ============================================================
// GLR Consultoria — Marketplace Connect API Integration
// Base URL: https://mcp.tiops.com.br
// Docs: https://marketplaces.tiops.com.br/docs/api.html
// ============================================================

console.log('[marketplace-api.js] Carregando...');
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

  // Visitas ML
  async mlVisitas(meliUserId, dateFrom, dateTo) {
    try {
      const r = await this.call('ml_visits', { meliUserId, date_from: dateFrom, date_to: dateTo });
      const data = r.data || {};
      const visitas = parseInt(data.unique_visitors) || parseInt(data.visits) || 0;
      return visitas;
    } catch(e) {
      console.warn('[ML] erro ao puxar visitas:', e.message);
      return 0;
    }
  },

  // Métricas detalhadas de ADS ML (cliques, impressões, CTR, etc)
  async mlAdsMetricsDetailed(meliUserId, dateFrom, dateTo) {
    try {
      const r = await this.call('ml_ads_metrics', { meliUserId, date_from: dateFrom, date_to: dateTo });
      const data = r.data || {};
      return {
        investimento: parseFloat(data.cost) || 0,
        cliques: parseInt(data.clicks) || 0,
        impressoes: parseInt(data.impressions) || 0,
        vendas: parseInt(data.sales) || 0,
        faturamentoAds: parseFloat(data.revenue) || 0,
        ctr: parseFloat(data.ctr) || 0,
        cpc: parseFloat(data.cpc) || 0,
        roas: parseFloat(data.roas) || 0,
      };
    } catch(e) {
      console.warn('[ML] erro ao puxar métricas ADS detalhadas:', e.message);
      return {};
    }
  },

  // Custos de envio por shipment (Mercado Livre)
  async mlShipmentCosts(shipmentId) {
    try {
      const r = await this.call('get_shipment_costs', { shipment_id: shipmentId });
      return r.data || {};
    } catch(e) {
      console.warn('[ML] erro ao puxar custos envio:', e.message);
      return {};
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

  // Visitas Shopee
  async shopeeVisitas(shopId, dias = 30) {
    try {
      const diasLimitado = Math.min(dias, 90);
      const r = await this.call('shopee_traffic', { shopId, days: diasLimitado });
      const data = r.data || {};
      const visitas = parseInt(data.unique_visitors) || parseInt(data.visits) || parseInt(data.shop_visits) || 0;
      return visitas;
    } catch(e) {
      console.warn('[SHOPEE] erro ao puxar visitas:', e.message);
      return 0;
    }
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

  // Performance da loja Shopee
  async shopeePerformance(shopId) {
    try {
      const r = await this.call('shopee_get_shop_performance', { shopId });
      return r.data || {};
    } catch(e) { return {}; }
  },

  // Receita detalhada por pedido (com taxas, comissões, etc) - SHOPEE
  async shopeeIncomeDetail(shopId, orderSn) {
    try {
      const r = await this.call('shopee_income', { shopId, order_sn: orderSn });
      const data = r.data || {};
      return {
        bruto: parseFloat(data.revenue) || 0,
        taxaPlatforma: parseFloat(data.platform_fee) || 0,
        taxaServico: parseFloat(data.service_fee) || 0,
        comissao: parseFloat(data.commission) || 0,
        freteDescontado: parseFloat(data.shipping_fee) || 0,
        voucher: parseFloat(data.voucher) || 0,
        outro: parseFloat(data.other_fee) || 0,
        liquido: parseFloat(data.net_revenue) || 0,
      };
    } catch(e) {
      console.warn('[SHOPEE] erro ao puxar receita detalhada:', e.message);
      return {};
    }
  },

  // Detalhes de Escrow (garantia/bloqueio) - SHOPEE - importante para taxas
  async shopeeEscrowDetail(shopId, orderSn) {
    try {
      const r = await this.call('shopee_get_escrow_detail', { shopId, order_sn: orderSn });
      const data = r.data || {};
      return {
        bruto: parseFloat(data.gross_amount) || 0,
        comissao: parseFloat(data.commission) || 0,
        taxaServico: parseFloat(data.service_fee) || 0,
        taxaFrete: parseFloat(data.shipping_fee) || 0,
        voucher: parseFloat(data.voucher_from_seller) || 0,
        imposto: parseFloat(data.tax) || 0,
        liquido: parseFloat(data.net_amount) || 0,
        status: data.status || 'unknown',
        dataLiberacao: data.release_time || null,
      };
    } catch(e) {
      console.warn('[SHOPEE] erro ao puxar escrow:', e.message);
      return {};
    }
  },

  // Informações de pagamento/payout - SHOPEE
  async shopeePayout(shopId) {
    try {
      const r = await this.call('shopee_get_payout_info', { shopId });
      return r.data || {};
    } catch(e) {
      console.warn('[SHOPEE] erro ao puxar payout:', e.message);
      return {};
    }
  },

  // Saldo da carteira - SHOPEE
  async shopeeWallet(shopId) {
    try {
      const r = await this.call('shopee_get_wallet_transactions', { shopId, page_size: 1 });
      const data = r.data || {};
      return {
        saldo: parseFloat(data.wallet_balance) || 0,
        totalReceito: parseFloat(data.total_received) || 0,
        totalSacado: parseFloat(data.total_withdrawn) || 0,
      };
    } catch(e) {
      console.warn('[SHOPEE] erro ao puxar carteira:', e.message);
      return {};
    }
  },

  // Métricas de ADS Shopee detalhadas
  async shopeeAdsMetricsDetailed(shopId, dateFrom, dateTo) {
    try {
      console.log('[SHOPEE ADS] Chamando API com:', { shopId, dateFrom, dateTo });
      const r = await this.call('shopee_ads_daily_performance', { shopId, start_date: dateFrom, end_date: dateTo });
      console.log('[SHOPEE ADS] Resposta bruta:', JSON.stringify(r).substring(0, 500));

      // Tentar diferentes caminhos para os dados
      let dias = [];
      if (Array.isArray(r.data)) dias = r.data;
      else if (Array.isArray(r.data?.response)) dias = r.data.response;
      else if (Array.isArray(r.data?.data)) dias = r.data.data;
      else if (r.data?.response && Array.isArray(r.data.response.daily_metrics)) dias = r.data.response.daily_metrics;

      console.log('[SHOPEE ADS] Dias encontrados:', dias.length);

      let totalInvest = 0, totalClicks = 0, totalImp = 0, totalSales = 0;
      dias.forEach(c => {
        totalInvest += parseFloat(c.cost) || parseFloat(c.expense) || 0;
        totalClicks += parseInt(c.clicks) || 0;
        totalImp += parseInt(c.impressions) || 0;
        totalSales += parseFloat(c.gmv) || 0;
      });
      console.log(`[SHOPEE ADS] ✓ Invest: ${totalInvest}, Clicks: ${totalClicks}, Imp: ${totalImp}, Sales: ${totalSales}`);
      return {
        investimento: totalInvest,
        cliques: totalClicks,
        impressoes: totalImp,
        vendas: totalSales,
        campanhas: dias.length,
      };
    } catch(e) {
      console.error('[SHOPEE ADS] ✗ Erro:', e.message, e);
      return {};
    }
  },

  // Relatórios de Afiliados (comissões) - SHOPEE
  async affiliateReports(dateFrom, dateTo) {
    try {
      console.log('[AFILIADOS API] Chamando com:', { dateFrom, dateTo });
      const r = await this.call('affiliate_reports', { start_date: dateFrom, end_date: dateTo });
      console.log('[AFILIADOS API] Resposta bruta:', JSON.stringify(r).substring(0, 500));

      // Tentar diferentes caminhos para os dados
      let data = {};
      if (r.data?.response && typeof r.data.response === 'object') data = r.data.response;
      else if (typeof r.data === 'object') data = r.data;

      console.log('[AFILIADOS API] Data extraída:', data);

      const resultado = {
        totalComissao: parseFloat(data.total_commission) || 0,
        totalVendas: parseFloat(data.total_sales) || 0,
        totalPedidos: parseInt(data.total_orders) || 0,
        totalAfiliados: parseInt(data.total_affiliates) || 0,
        taxaMedia: parseFloat(data.average_rate) || 0,
      };
      console.log('[AFILIADOS API] ✓ Resultado:', resultado);
      return resultado;
    } catch(e) {
      console.error('[AFILIADOS API] ✗ Erro:', e.message, e);
      return {};
    }
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

  async affiliateOffers(params = {}) {
    return await this.call('affiliate_offers', params);
  }

  async affiliateProducts(params = {}) {
    return await this.call('affiliate_products', params);
  }

  async affiliateShops(params = {}) {
    return await this.call('affiliate_shops', params);
  }

  async affiliateShortLink(params = {}) {
    return await this.call('affiliate_short_link', params);
  }

  async mlAcceptPreNegotiated(params = {}) {
    return await this.call('ml_accept_pre_negotiated', params);
  }

  async mlAcceptUnhealthyStock(params = {}) {
    return await this.call('ml_accept_unhealthy_stock', params);
  }

  async mlAddDodItem(params = {}) {
    return await this.call('ml_add_dod_item', params);
  }

  async mlAddLightningItem(params = {}) {
    return await this.call('ml_add_lightning_item', params);
  }

  async mlAddPixCampaignItem(params = {}) {
    return await this.call('ml_add_pix_campaign_item', params);
  }

  async mlAddPriceMatchingItem(params = {}) {
    return await this.call('ml_add_price_matching_item', params);
  }

  async mlAddPromotionItems(params = {}) {
    return await this.call('ml_add_promotion_items', params);
  }

  async mlAddSellerCampaignItem(params = {}) {
    return await this.call('ml_add_seller_campaign_item', params);
  }

  async mlAddSmartCampaignItem(params = {}) {
    return await this.call('ml_add_smart_campaign_item', params);
  }

  async mlAdsAddItems(params = {}) {
    return await this.call('ml_ads_add_items', params);
  }

  async mlAdsCampaignItems(params = {}) {
    return await this.call('ml_ads_campaign_items', params);
  }

  async mlAdsCampaigns(params = {}) {
    return await this.call('ml_ads_campaigns', params);
  }

  async mlAdsCreateCampaign(params = {}) {
    return await this.call('ml_ads_create_campaign', params);
  }

  async mlAdsGetAd(params = {}) {
    return await this.call('ml_ads_get_ad', params);
  }

  async mlAdsMetrics(params = {}) {
    return await this.call('ml_ads_metrics', params);
  }

  async mlAdsRemoveItems(params = {}) {
    return await this.call('ml_ads_remove_items', params);
  }

  async mlAdsUpdateAd(params = {}) {
    return await this.call('ml_ads_update_ad', params);
  }

  async mlAdsUpdateCampaign(params = {}) {
    return await this.call('ml_ads_update_campaign', params);
  }

  async mlBrandCentral(params = {}) {
    return await this.call('ml_brand_central', params);
  }

  async mlCatalogBuybox(params = {}) {
    return await this.call('ml_catalog_buybox', params);
  }

  async mlCatalogEligibility(params = {}) {
    return await this.call('ml_catalog_eligibility', params);
  }

  async mlCatalogEligibleItems(params = {}) {
    return await this.call('ml_catalog_eligible_items', params);
  }

  async mlCatalogForewarningDate(params = {}) {
    return await this.call('ml_catalog_forewarning_date', params);
  }

  async mlCatalogForewarningItems(params = {}) {
    return await this.call('ml_catalog_forewarning_items', params);
  }

  async mlCatalogListedItems(params = {}) {
    return await this.call('ml_catalog_listed_items', params);
  }

  async mlCatalogNotListed(params = {}) {
    return await this.call('ml_catalog_not_listed', params);
  }

  async mlCatalogOptin(params = {}) {
    return await this.call('ml_catalog_optin', params);
  }

  async mlCatalogPriceToWin(params = {}) {
    return await this.call('ml_catalog_price_to_win', params);
  }

  async mlCatalogSearchProducts(params = {}) {
    return await this.call('ml_catalog_search_products', params);
  }

  async mlCatalogSuggestionsQuota(params = {}) {
    return await this.call('ml_catalog_suggestions_quota', params);
  }

  async mlCatalogSuggestionsSearch(params = {}) {
    return await this.call('ml_catalog_suggestions_search', params);
  }

  async mlCouponItems(params = {}) {
    return await this.call('ml_coupon_items', params);
  }

  async mlCreateCoupon(params = {}) {
    return await this.call('ml_create_coupon', params);
  }

  async mlCreateKit(params = {}) {
    return await this.call('ml_create_kit', params);
  }

  async mlCreatePromotion(params = {}) {
    return await this.call('ml_create_promotion', params);
  }

  async mlCreateSellerCampaign(params = {}) {
    return await this.call('ml_create_seller_campaign', params);
  }

  async mlDeleteAutomation(params = {}) {
    return await this.call('ml_delete_automation', params);
  }

  async mlDeleteCoupon(params = {}) {
    return await this.call('ml_delete_coupon', params);
  }

  async mlDeleteCouponItem(params = {}) {
    return await this.call('ml_delete_coupon_item', params);
  }

  async mlDeleteDodItem(params = {}) {
    return await this.call('ml_delete_dod_item', params);
  }

  async mlDeleteItemPromotions(params = {}) {
    return await this.call('ml_delete_item_promotions', params);
  }

  async mlDeleteLightningItem(params = {}) {
    return await this.call('ml_delete_lightning_item', params);
  }

  async mlDeletePromotionItems(params = {}) {
    return await this.call('ml_delete_promotion_items', params);
  }

  async mlDeleteSellerCampaign(params = {}) {
    return await this.call('ml_delete_seller_campaign', params);
  }

  async mlDeleteSellerCampaignItem(params = {}) {
    return await this.call('ml_delete_seller_campaign_item', params);
  }

  async mlDodItems(params = {}) {
    return await this.call('ml_dod_items', params);
  }

  async mlExclusionListItem(params = {}) {
    return await this.call('ml_exclusion_list_item', params);
  }

  async mlExclusionListSeller(params = {}) {
    return await this.call('ml_exclusion_list_seller', params);
  }

  async mlGetAutomation(params = {}) {
    return await this.call('ml_get_automation', params);
  }

  async mlGetCoupon(params = {}) {
    return await this.call('ml_get_coupon', params);
  }

  async mlGetKit(params = {}) {
    return await this.call('ml_get_kit', params);
  }

  async mlGetPixCampaign(params = {}) {
    return await this.call('ml_get_pix_campaign', params);
  }

  async mlGetPreNegotiated(params = {}) {
    return await this.call('ml_get_pre_negotiated', params);
  }

  async mlGetPriceMatchingCampaign(params = {}) {
    return await this.call('ml_get_price_matching_campaign', params);
  }

  async mlGetPriceRules(params = {}) {
    return await this.call('ml_get_price_rules', params);
  }

  async mlGetProductIdentifiers(params = {}) {
    return await this.call('ml_get_product_identifiers', params);
  }

  async mlGetPromotion(params = {}) {
    return await this.call('ml_get_promotion', params);
  }

  async mlGetSellerCampaign(params = {}) {
    return await this.call('ml_get_seller_campaign', params);
  }

  async mlGetSmartCampaign(params = {}) {
    return await this.call('ml_get_smart_campaign', params);
  }

  async mlGetUnhealthyStock(params = {}) {
    return await this.call('ml_get_unhealthy_stock', params);
  }

  async mlItemPromotions(params = {}) {
    return await this.call('ml_item_promotions', params);
  }

  async mlLightningItems(params = {}) {
    return await this.call('ml_lightning_items', params);
  }

  async mlListAutomatedItems(params = {}) {
    return await this.call('ml_list_automated_items', params);
  }

  async mlListPromotions(params = {}) {
    return await this.call('ml_list_promotions', params);
  }

  async mlListingFees(params = {}) {
    return await this.call('ml_listing_fees', params);
  }

  async mlMessagesAttachment(params = {}) {
    return await this.call('ml_messages_attachment', params);
  }

  async mlMessagesGet(params = {}) {
    return await this.call('ml_messages_get', params);
  }

  async mlMessagesSend(params = {}) {
    return await this.call('ml_messages_send', params);
  }

  async mlMessagesUnread(params = {}) {
    return await this.call('ml_messages_unread', params);
  }

  async mlPixCampaignItems(params = {}) {
    return await this.call('ml_pix_campaign_items', params);
  }

  async mlPreNegotiatedItems(params = {}) {
    return await this.call('ml_pre_negotiated_items', params);
  }

  async mlPriceMatchingItems(params = {}) {
    return await this.call('ml_price_matching_items', params);
  }

  async mlPromotionCandidate(params = {}) {
    return await this.call('ml_promotion_candidate', params);
  }

  async mlPromotionItems(params = {}) {
    return await this.call('ml_promotion_items', params);
  }

  async mlPromotionOffer(params = {}) {
    return await this.call('ml_promotion_offer', params);
  }

  async mlRelist(params = {}) {
    return await this.call('ml_relist', params);
  }

  async mlSearchKitComponents(params = {}) {
    return await this.call('ml_search_kit_components', params);
  }

  async mlSellerCampaignItems(params = {}) {
    return await this.call('ml_seller_campaign_items', params);
  }

  async mlSetAutomation(params = {}) {
    return await this.call('ml_set_automation', params);
  }

  async mlSetExclusionItem(params = {}) {
    return await this.call('ml_set_exclusion_item', params);
  }

  async mlSetExclusionSeller(params = {}) {
    return await this.call('ml_set_exclusion_seller', params);
  }

  async mlSetProductIdentifiers(params = {}) {
    return await this.call('ml_set_product_identifiers', params);
  }

  async mlSmartCampaignItems(params = {}) {
    return await this.call('ml_smart_campaign_items', params);
  }

  async mlUnhealthyStockItems(params = {}) {
    return await this.call('ml_unhealthy_stock_items', params);
  }

  async mlUpdateCoupon(params = {}) {
    return await this.call('ml_update_coupon', params);
  }

  async mlUpdateSellerCampaign(params = {}) {
    return await this.call('ml_update_seller_campaign', params);
  }

  async shopeeAdsAddKeywords(params = {}) {
    return await this.call('shopee_ads_add_keywords', params);
  }

  async shopeeAdsBalance(params = {}) {
    return await this.call('shopee_ads_balance', params);
  }

  async shopeeAdsCampaignPerformance(params = {}) {
    return await this.call('shopee_ads_campaign_performance', params);
  }

  async shopeeAdsCreateCampaign(params = {}) {
    return await this.call('shopee_ads_create_campaign', params);
  }

  async shopeeAdsDailyPerformance(params = {}) {
    return await this.call('shopee_ads_daily_performance', params);
  }

  async shopeeAdsHourlyPerformance(params = {}) {
    return await this.call('shopee_ads_hourly_performance', params);
  }

  async shopeeAdsListCampaigns(params = {}) {
    return await this.call('shopee_ads_list_campaigns', params);
  }

  async shopeeAdsListKeywords(params = {}) {
    return await this.call('shopee_ads_list_keywords', params);
  }

  async shopeeAdsSuggestedBid(params = {}) {
    return await this.call('shopee_ads_suggested_bid', params);
  }

  async shopeeAdsSuggestedKeywords(params = {}) {
    return await this.call('shopee_ads_suggested_keywords', params);
  }

  async shopeeAdsUpdateBid(params = {}) {
    return await this.call('shopee_ads_update_bid', params);
  }

  async shopeeAdsUpdateCampaign(params = {}) {
    return await this.call('shopee_ads_update_campaign', params);
  }

  async shopeeAttributes(params = {}) {
    return await this.call('shopee_attributes', params);
  }

  async shopeeBilling(params = {}) {
    return await this.call('shopee_billing', params);
  }

  async shopeeBrands(params = {}) {
    return await this.call('shopee_brands', params);
  }

  async shopeeCancelOrder(params = {}) {
    return await this.call('shopee_cancel_order', params);
  }

  async shopeeCategories(params = {}) {
    return await this.call('shopee_categories', params);
  }

  async shopeeConfirmReturn(params = {}) {
    return await this.call('shopee_confirm_return', params);
  }

  async shopeeConversations(params = {}) {
    return await this.call('shopee_conversations', params);
  }

  async shopeeCreateItem(params = {}) {
    return await this.call('shopee_create_item', params);
  }

  async shopeeDisputeReturn(params = {}) {
    return await this.call('shopee_dispute_return', params);
  }

  async shopeeEscrow(params = {}) {
    return await this.call('shopee_escrow', params);
  }

  async shopeeGetItem(params = {}) {
    return await this.call('shopee_get_item', params);
  }

  async shopeeGetVideoList(params = {}) {
    return await this.call('shopee_get_video_list', params);
  }

  async shopeeIncome(params = {}) {
    return await this.call('shopee_income', params);
  }

  async shopeeListItems(params = {}) {
    return await this.call('shopee_list_items', params);
  }

  async shopeeMessages(params = {}) {
    return await this.call('shopee_messages', params);
  }

  async shopeeOrderDetail(params = {}) {
    return await this.call('shopee_order_detail', params);
  }

  async shopeeOrders(params = {}) {
    return await this.call('shopee_orders', params);
  }

  async shopeePayout(params = {}) {
    return await this.call('shopee_payout', params);
  }

  async shopeeReturnDetail(params = {}) {
    return await this.call('shopee_return_detail', params);
  }

  async shopeeReturnsList(params = {}) {
    return await this.call('shopee_returns_list', params);
  }

  async shopeeSalesSummary(params = {}) {
    return await this.call('shopee_sales_summary', params);
  }

  async shopeeSendMessage(params = {}) {
    return await this.call('shopee_send_message', params);
  }

  async shopeeSetOrderNote(params = {}) {
    return await this.call('shopee_set_order_note', params);
  }

  async shopeeShipOrder(params = {}) {
    return await this.call('shopee_ship_order', params);
  }

  async shopeeTracking(params = {}) {
    return await this.call('shopee_tracking', params);
  }

  async shopeeUpdateItem(params = {}) {
    return await this.call('shopee_update_item', params);
  }

  async shopeeUpdatePrice(params = {}) {
    return await this.call('shopee_update_price', params);
  }

  async shopeeUpdateStock(params = {}) {
    return await this.call('shopee_update_stock', params);
  }

  async shopeeUploadVideo(params = {}) {
    return await this.call('shopee_upload_video', params);
  }

  async shopeeVideoStatus(params = {}) {
    return await this.call('shopee_video_status', params);
  }

  async shopeeWallet(params = {}) {
    return await this.call('shopee_wallet', params);
  }

};
console.log('[marketplace-api.js] ✓ Carregado com sucesso!');
