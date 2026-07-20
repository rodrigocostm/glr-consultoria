// ============================================================
// GLR Consultoria — Conciliação Financeira
// Confere, pedido a pedido: as taxas calculadas batem com o que a
// API realmente descontou, e se/quando o dinheiro caiu na carteira.
// ============================================================

Router.register('conciliacao', async (params, el) => {
  const STORAGE_CACHE = 'glr_conciliacao_cache';
  const pad     = n => String(n).padStart(2,'0');
  const hoje    = new Date();
  const ontem   = new Date(hoje); ontem.setDate(hoje.getDate()-1);
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const R$      = v => 'R$ '+(parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

  // Mesmo tradutor/varredor de campos usado no Financeiro (já testado e corrigido
  // lá) — garante que nenhuma taxa Shopee fique sem nome quando a conta não bater.
  const SHOPEE_FEE_LABELS = {
    buyer_total_amount: 'Total pago pelo comprador', original_price: 'Preço original do produto',
    seller_discount: 'Desconto concedido pelo vendedor', voucher_from_seller: 'Voucher do vendedor',
    seller_voucher_code: 'Voucher do vendedor (código)', shopee_voucher_code: 'Voucher Shopee (código)',
    seller_return_refund_fee: 'Taxa de devolução/reembolso', original_shipping_fee: 'Frete original',
    estimated_shipping_fee: 'Frete estimado', shipping_fee_discount_from_3pl: 'Desconto de frete (transportadora)',
    buyer_transaction_fee: 'Taxa de transação do comprador', cross_border_tax: 'Imposto cross-border',
    payment_promotion: 'Promoção de pagamento', final_shipping_fee: 'Frete final cobrado',
    final_product_protection: 'Proteção de produto', delivery_seller_protection_fee_premium_amount: 'Prêmio de proteção de entrega',
    final_escrow_product_gst: 'GST do produto (escrow)', order_ams_commission_fee: 'Comissão AMS (anúncios de afiliados)',
    drc_adjustable_refund: 'Ajuste de reembolso DRC', final_product_vat_tax: 'Imposto VAT do produto',
    order_seller_discount_refund: 'Reembolso de desconto do vendedor', seller_shipping_discount: 'Desconto de frete do vendedor',
    escrow_tax: 'Imposto sobre o escrow', prorated_coins_value_offset_shipping_fee: 'Moedas usadas para abater frete',
    non_chargeable_coins: 'Moedas não cobráveis', chargeable_coins: 'Moedas cobráveis',
    bundle_deal_seller_absorbed: 'Combo/kit absorvido pelo vendedor', buyer_paid_extra_fee: 'Taxa extra paga pelo comprador',
    seller_capped_commission_fee: 'Comissão com teto (capped)', seller_lost_compensation: 'Compensação por perda/extravio',
    order_refund_amount: 'Valor reembolsado do pedido', reverse_shipping_fee: 'Frete reverso (devolução)',
    insurance_premium: 'Prêmio de seguro', final_shopee_subsidy: 'Subsídio Shopee',
    seller_voucher_amount: 'Valor do voucher do vendedor', bundle_deal_indemnify: 'Indenização de combo/kit',
    drc_deduction: 'Dedução DRC', pix_discount: 'Ajuste por pagamento via PIX', campaign_fee: 'Rebate de ação comercial',
  };
  function _shopeeFeeLabel(key) {
    if (SHOPEE_FEE_LABELS[key]) return SHOPEE_FEE_LABELS[key];
    return key.split('.').map(p => SHOPEE_FEE_LABELS[p] || p.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase())).join(' — ');
  }
  const SHOPEE_FEE_SKIP = new Set([
    'order_chargeable_weight','final_height','final_width','final_length',
    'buyer_payment_method','order_sn','escrow_release_time','order_income_struct',
    'is_paid_by_credit_card','shopee_voucher_code','seller_voucher_code',
    'reverse_shipping_fee_confirmed','tax_payment_method',
  ]);
  const SHOPEE_USED_KEYS = new Set([
    'actual_shipping_fee','buyer_paid_shipping_fee','shopee_shipping_rebate',
    'net_commission_fee','commission_fee','net_service_fee','service_fee',
    'seller_product_rebate','shopee_discount','escrow_amount','escrow_amount_after_adjustment',
    'seller_transaction_fee','buyer_tax_amount','seller_coin_cash_back',
    'shipping_seller_protection_fee_amount','voucher_from_shopee',
    'credit_card_promotion_fee','credit_card_promotion','coins','shopee_coins_cash_back',
    'buyer_total_amount','cost_of_goods_sold','original_cost_of_goods_sold',
    'order_discounted_price','order_original_price','order_selling_price',
    'original_price','original_shopee_discount','estimated_shipping_fee',
    'remaining_voucher','net_commission_fee_info_list','net_service_fee_info_list',
    'tenure_info_list','items','seller_voucher_code','buyer_payment_method','instalment_plan',
    'final_shipping_fee','order_seller_discount','credit_card_transaction_fee',
  ]);
  function _shopeeVarrer(oi) {
    const detalhes = {};
    const rec = (obj, prefixo) => {
      for (const [k, v] of Object.entries(obj||{})) {
        if (SHOPEE_USED_KEYS.has(k) || SHOPEE_FEE_SKIP.has(k)) continue;
        if (v && typeof v === 'object' && !Array.isArray(v)) { rec(v, prefixo ? `${prefixo}.${k}` : k); continue; }
        const num = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
        if (!isNaN(num) && Math.abs(num) > 0.001) detalhes[prefixo ? `${prefixo}.${k}` : k] = num;
      }
    };
    rec(oi, '');
    return detalhes;
  }

  let filtroPeriodo = 'mes'; // 'mes' | 'mes-passado' | '7' | '15' | '30' | 'custom'
  let customFrom = fmtDate(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  let customTo   = fmtDate(ontem);
  let contaSel   = null; // external_id da conta escolhida, ou null = nenhuma ainda
  let contas     = [];
  let pedidos    = [];
  let carregando = false;
  let atualizadoEm = null;
  let vinculos = {};
  try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos')||'{}'); } catch(e) {}

  function contaEmpresa(extId) {
    for (const [cid, arr] of Object.entries(vinculos)) {
      if ((arr||[]).some(c => String(c.external_id) === String(extId))) {
        try {
          const clientes = JSON.parse(localStorage.getItem('glr_clientes')||'[]');
          return clientes.find(c => c.id === parseInt(cid))?.nome || '';
        } catch(e) { return ''; }
      }
    }
    return '';
  }

  function _periodoParaDatas() {
    const y = hoje.getFullYear(), m = hoje.getMonth();
    switch (filtroPeriodo) {
      case 'mes':         return { dataFrom: fmtDate(new Date(y, m, 1)), dataTo: fmtDate(ontem) };
      case 'mes-passado': return { dataFrom: fmtDate(new Date(y, m-1, 1)), dataTo: fmtDate(new Date(y, m, 0)) };
      case 'custom':       return { dataFrom: customFrom, dataTo: customTo };
      default: {
        const dias = parseInt(filtroPeriodo) || 15;
        const d = new Date(ontem); d.setDate(d.getDate()-(dias-1));
        return { dataFrom: fmtDate(d), dataTo: fmtDate(ontem) };
      }
    }
  }

  try {
    const cache = JSON.parse(localStorage.getItem(STORAGE_CACHE)||'null');
    if (cache) { pedidos = cache.pedidos||[]; contaSel = cache.contaSel||null; atualizadoEm = cache.at||null; filtroPeriodo = cache.filtroPeriodo||filtroPeriodo; customFrom = cache.customFrom||customFrom; customTo = cache.customTo||customTo; }
  } catch(e) {}

  async function _mapLimit(items, limit, fn) {
    const ret = []; let idx = 0;
    async function worker() { while (idx < items.length) { const i = idx++; ret[i] = await fn(items[i], i); } }
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
    return ret;
  }

  async function carregarContas() {
    try {
      const r = await MarketplaceAPI.call('list_accounts');
      contas = r.data?.accounts || [];
    } catch(e) { contas = []; }
  }

  // ── Mercado Livre: bruto, comissão (sale_fee), líquido real via /collections,
  // data de repasse (best-effort — os nomes de campo do Mercado Pago variam) ──
  async function conciliarML(conta) {
    const meliId = conta.param_to_use?.meliUserId || conta.external_id;
    const { dataFrom, dataTo } = _periodoParaDatas();
    const orders = await MarketplaceAPI.mlOrders(meliId, dataFrom, dataTo);
    const validos = orders.filter(o => !['cancelled','invalid'].includes((o.status||'').toLowerCase()));

    return await _mapLimit(validos, 5, async o => {
      const itens = o.order_items||o.items||[];
      const bruto = parseFloat(o.total_amount)||0;
      const comissao = itens.reduce((s,i)=>s+(parseFloat(i.sale_fee)||0)*(i.quantity||1),0);
      const liquidoEsperado = bruto - comissao;
      const paymentId = o.payments?.[0]?.id || null;

      let liquidoReal = null, dataRepasse = null, statusPag = null;
      if (paymentId) {
        try {
          const r = await MarketplaceAPI.call('raw', { method:'GET', path:`/collections/${paymentId}`, meliUserId: meliId });
          const d = r.data || {};
          liquidoReal = parseFloat(d.net_received_amount ?? d.collection?.net_received_amount ?? d.transaction?.net_received_amount);
          dataRepasse = d.money_release_date || d.date_released || d.collection?.money_release_date || null;
          statusPag = d.status || d.collection?.status || null;
        } catch(e) {}
      }
      if (isNaN(liquidoReal)) liquidoReal = null;
      const diff = liquidoReal!=null ? (liquidoReal - liquidoEsperado) : null;

      return {
        id: String(o.id), plataforma: 'Mercado Livre', contaId: conta.external_id,
        data: o.date_created ? new Date(o.date_created).toLocaleDateString('pt-BR') : '—',
        dataTs: new Date(o.date_created||0).getTime(),
        bruto, taxasEsperadas: comissao, liquidoEsperado,
        breakdown: [{ nome: 'Comissão', valor: comissao }],
        liquidoReal, diff, bate: diff!=null ? Math.abs(diff)<1 : null,
        dataRepasse: dataRepasse ? new Date(dataRepasse).toLocaleDateString('pt-BR') : null,
        statusPagamentoRaw: statusPag,
      };
    });
  }

  // ── Shopee: bruto, taxas conhecidas (comissão+serviço+frete+cartão), líquido
  // real do escrow, data/hora de liberação (escrow_release_time) ──
  async function conciliarShopee(conta) {
    const shopId = conta.param_to_use?.shopId || conta.external_id;
    const { dataFrom, dataTo } = _periodoParaDatas();
    const tsFrom = Math.floor(new Date(`${dataFrom}T00:00:00`).getTime()/1000);
    const tsTo   = Math.floor(new Date(`${dataTo}T23:59:59`).getTime()/1000);
    const snsList = await MarketplaceAPI.shopeeListOrderSns(shopId, tsFrom, tsTo);
    const completed = snsList; // já filtra por status relevante dentro do helper

    // Bruto = subtotal dos itens (mesma convenção já validada no Financeiro/Vendas) —
    // NÃO usa buyer_total_amount do escrow, que inclui frete pago pelo comprador e
    // faria a conta "não bater" mesmo com todas as taxas certas.
    const subtotalMap = {}, dataMap = {};
    for (let i=0; i<completed.length; i+=50) {
      const lote = completed.slice(i,i+50).map(o=>o.sn);
      try {
        const rd = await MarketplaceAPI.call('shopee_get_order_detail', { shopId, order_sn_list: lote });
        const lista = rd.data?.response?.order_list || rd.data?.order_list || [];
        for (const ord of lista) {
          const itens = ord.item_list || ord.items || [];
          const subtotal = itens.reduce((s,it) => {
            const preco = parseFloat(it.model_discounted_price) || parseFloat(it.item_price) || 0;
            const qtd   = parseInt(it.model_quantity_purchased)  || parseInt(it.quantity)    || 1;
            return s + preco*qtd;
          }, 0);
          subtotalMap[ord.order_sn] = subtotal > 0 ? subtotal : (parseFloat(ord.total_amount)||0);
          dataMap[ord.order_sn] = ord.create_time ? new Date(ord.create_time*1000).toLocaleDateString('pt-BR') : '—';
        }
      } catch(e) {}
    }

    const resultado = [];
    for (let i=0; i<completed.length; i+=50) {
      const lote = completed.slice(i,i+50).map(o=>o.sn);
      try {
        const re = await MarketplaceAPI.call('shopee_get_escrow_detail_batch', { shopId, order_sn_list: lote });
        const lista = re.data?.response?.result_list || re.data?.response || re.data?.result_list || [];
        for (const item of lista) {
          const sn = item.escrow_detail?.order_sn || item.order_sn;
          const oi = item.escrow_detail?.order_income || item.order_income || {};
          if (!sn || !oi.escrow_amount) continue;
          const n = v => parseFloat(v)||0;
          const bruto = subtotalMap[sn] ?? (n(oi.order_original_price) || (n(oi.escrow_amount)+n(oi.commission_fee)+n(oi.service_fee)));
          const freteVendedor = Math.max(0, n(oi.actual_shipping_fee)-n(oi.buyer_paid_shipping_fee)-n(oi.shopee_shipping_rebate));
          const comissao = n(oi.commission_fee), taxaServico = n(oi.service_fee), taxaCartao = n(oi.credit_card_promotion);
          const detalhes = _shopeeVarrer(oi);
          const detEntries = Object.entries(detalhes).filter(([,v]) => Math.abs(v) > 0.01);
          const somaDetalhes = detEntries.reduce((s,[,v]) => s+v, 0);
          const taxasEsperadas = comissao + taxaServico + freteVendedor + taxaCartao - somaDetalhes;
          const liquidoEsperado = bruto - taxasEsperadas;
          const liquidoReal = n(oi.escrow_amount);
          const diff = liquidoReal - liquidoEsperado;
          const releaseTs = oi.escrow_release_time;
          const breakdown = [
            { nome: 'Comissão', valor: comissao },
            { nome: 'Taxa de serviço', valor: taxaServico },
            { nome: 'Frete descontado', valor: freteVendedor },
            { nome: 'Taxa de cartão', valor: taxaCartao },
            ...detEntries.map(([k,v]) => ({ nome: _shopeeFeeLabel(k), valor: -v })), // detEntries são créditos (reduzem a taxa) — inverte o sinal pra exibir como "a favor"
          ].filter(x => Math.abs(x.valor) > 0.01);
          resultado.push({
            id: sn, plataforma: 'Shopee', contaId: conta.external_id,
            data: dataMap[sn] || '—', dataTs: releaseTs ? releaseTs*1000 : 0,
            bruto, taxasEsperadas, liquidoEsperado, breakdown,
            liquidoReal, diff, bate: Math.abs(diff) < 1,
            dataRepasse: releaseTs ? new Date(releaseTs*1000).toLocaleDateString('pt-BR') : null,
            statusPagamentoRaw: releaseTs && releaseTs*1000 <= Date.now() ? 'released' : (releaseTs ? 'scheduled' : null),
          });
        }
      } catch(e) {}
    }
    return resultado;
  }

  async function buscar() {
    if (carregando || !contaSel) return;
    carregando = true;
    render();
    const conta = contas.find(c => String(c.external_id) === String(contaSel));
    if (!conta) { carregando = false; render(); return; }
    const mkt = (conta.marketplace||'').toLowerCase();
    try {
      pedidos = ['meli','ml','mercadolivre'].includes(mkt) ? await conciliarML(conta) : await conciliarShopee(conta);
      pedidos.sort((a,b)=>(b.dataTs||0)-(a.dataTs||0));
      atualizadoEm = Date.now();
      const { dataFrom, dataTo } = _periodoParaDatas();
      localStorage.setItem(STORAGE_CACHE, JSON.stringify({ pedidos, contaSel, filtroPeriodo, customFrom, customTo, at: atualizadoEm, dataFrom, dataTo }));
    } catch(e) {
      console.warn('[Conciliação] erro:', e.message);
    }
    carregando = false;
    render();
  }

  function statusRepasseLabel(p) {
    if (p.plataforma === 'Mercado Livre') {
      if (p.dataRepasse) return { label: `Pago em ${p.dataRepasse}`, cor: '#10b981' };
      return { label: 'Sem data (API não retornou)', cor: 'var(--text-muted)' };
    }
    if (p.statusPagamentoRaw === 'released') return { label: `Liberado em ${p.dataRepasse}`, cor: '#10b981' };
    if (p.statusPagamentoRaw === 'scheduled') return { label: `Agendado p/ ${p.dataRepasse}`, cor: '#f59e0b' };
    return { label: 'Sem previsão', cor: 'var(--text-muted)' };
  }

  function render() {
    const nomesContas = contas.map(c => {
      const mp = (c.marketplace||'').toLowerCase().includes('shopee') ? '🟠' : '🟡';
      const emp = contaEmpresa(c.external_id);
      return { id: c.external_id, label: `${mp} ${emp ? emp+' — ' : ''}${c.nickname||c.external_id}` };
    });

    const totalPedidos = pedidos.length;
    const totalBatem = pedidos.filter(p=>p.bate===true).length;
    const totalDivergem = pedidos.filter(p=>p.bate===false).length;
    const totalSemComparar = pedidos.filter(p=>p.bate==null).length;
    const totalPago = pedidos.filter(p => p.plataforma==='Mercado Livre' ? !!p.dataRepasse : p.statusPagamentoRaw==='released').length;
    const totalPendente = totalPedidos - totalPago;
    const somaDiff = pedidos.filter(p=>p.diff!=null).reduce((s,p)=>s+p.diff,0);

    el.innerHTML = `
    <div class="page">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
        <div>
          <h1 style="font-size:20px;font-weight:800;margin:0;">🧾 Conciliação Financeira</h1>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${atualizadoEm?`Atualizado em ${new Date(atualizadoEm).toLocaleString('pt-BR')}`:'Selecione uma conta e clique em Buscar.'}</div>
        </div>
        <button class="btn-primary" style="padding:8px 16px;" ${carregando||!contaSel?'disabled':''} onclick="_conciliacaoBuscar()">${carregando?'⏳ Buscando...':'🔄 Buscar'}</button>
      </div>

      <div class="card mb-16">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <select id="conc-sel-periodo" class="form-input" style="width:170px;">
            <option value="mes" ${filtroPeriodo==='mes'?'selected':''}>Esse mês</option>
            <option value="mes-passado" ${filtroPeriodo==='mes-passado'?'selected':''}>Mês passado</option>
            <option value="7" ${filtroPeriodo==='7'?'selected':''}>Últimos 7 dias</option>
            <option value="15" ${filtroPeriodo==='15'?'selected':''}>Últimos 15 dias</option>
            <option value="30" ${filtroPeriodo==='30'?'selected':''}>Últimos 30 dias</option>
            <option value="custom" ${filtroPeriodo==='custom'?'selected':''}>📅 Personalizado</option>
          </select>
          <div id="conc-custom-range" style="display:${filtroPeriodo==='custom'?'flex':'none'};align-items:center;gap:6px;">
            <input type="date" id="conc-date-from" class="form-input" value="${customFrom}" style="width:140px;">
            <span style="color:var(--text-secondary);">até</span>
            <input type="date" id="conc-date-to" class="form-input" value="${customTo}" style="width:140px;">
          </div>
          <select id="conc-sel-conta" class="form-input" style="min-width:220px;">
            <option value="">— Selecione a conta —</option>
            ${nomesContas.map(c=>`<option value="${c.id}" ${String(c.id)===String(contaSel)?'selected':''}>${c.label}</option>`).join('')}
          </select>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:10px;">
          Compara, pedido a pedido, as taxas calculadas com o que a API realmente descontou (escrow/collections), e mostra se/quando o dinheiro foi liberado.
          Mercado Livre: repasse depende do que o Mercado Pago retorna em <code>/collections</code> — nem sempre a data vem preenchida.
        </div>
      </div>

      ${!pedidos.length ? `<div style="text-align:center;padding:60px;color:var(--text-muted);">
        ${carregando ? 'Buscando...' : (contaSel ? 'Nenhum pedido no período.' : 'Selecione uma conta pra começar.')}
      </div>` : `
      <div class="kpi-grid mb-24" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr));">
        <div class="kpi-card"><div class="kpi-label">Pedidos</div><div class="kpi-value">${totalPedidos}</div></div>
        <div class="kpi-card"><div class="kpi-label">✅ Batem</div><div class="kpi-value" style="color:#10b981;">${totalBatem}</div></div>
        <div class="kpi-card"><div class="kpi-label">⚠️ Divergem</div><div class="kpi-value" style="color:#ef4444;">${totalDivergem}</div></div>
        <div class="kpi-card"><div class="kpi-label">💰 Pagos</div><div class="kpi-value" style="color:#10b981;">${totalPago}</div></div>
        <div class="kpi-card"><div class="kpi-label">⏳ Pendentes</div><div class="kpi-value" style="color:#f59e0b;">${totalPendente}</div></div>
        <div class="kpi-card"><div class="kpi-label">Diferença total</div><div class="kpi-value" style="color:${Math.abs(somaDiff)<1?'#10b981':'#ef4444'};font-size:15px;">${R$(somaDiff)}</div></div>
      </div>

      <div class="card" style="padding:0;overflow:hidden;">
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:900px;">
          <thead>
            <tr style="background:#1a2744;color:white;">
              <th style="padding:10px 12px;text-align:left;">Pedido</th>
              <th style="padding:10px 8px;text-align:right;">Bruto</th>
              <th style="padding:10px 8px;text-align:right;">Taxas Esperadas</th>
              <th style="padding:10px 8px;text-align:right;">Líquido Esperado</th>
              <th style="padding:10px 8px;text-align:right;">Líquido Real (API)</th>
              <th style="padding:10px 8px;text-align:right;">Diferença</th>
              <th style="padding:10px 8px;text-align:center;">Taxas Batem?</th>
              <th style="padding:10px 8px;text-align:left;">Repasse (Carteira)</th>
            </tr>
          </thead>
          <tbody>
            ${pedidos.map((p,i) => {
              const st = statusRepasseLabel(p);
              return `
              <tr style="background:${i%2===0?'var(--bg-card)':'var(--bg-surface)'};">
                <td style="padding:9px 12px;font-weight:600;">${p.id}<div style="font-size:10px;color:var(--text-muted);">${p.data}</div></td>
                <td style="padding:9px 8px;text-align:right;">${R$(p.bruto)}</td>
                <td style="padding:9px 8px;text-align:right;color:#ef4444;">
                  - ${R$(p.taxasEsperadas)}
                  ${p.breakdown?.length ? `<div style="font-size:9.5px;color:var(--text-muted);font-weight:400;text-align:right;margin-top:2px;">${p.breakdown.map(b=>`${b.nome}: ${b.valor>=0?'-':'+'}${R$(Math.abs(b.valor))}`).join('<br>')}</div>` : ''}
                </td>
                <td style="padding:9px 8px;text-align:right;">${R$(p.liquidoEsperado)}</td>
                <td style="padding:9px 8px;text-align:right;font-weight:600;">${p.liquidoReal!=null?R$(p.liquidoReal):'—'}</td>
                <td style="padding:9px 8px;text-align:right;color:${p.diff==null?'var(--text-muted)':Math.abs(p.diff)<1?'#10b981':'#ef4444'};">
                  ${p.diff!=null?R$(p.diff):'—'}
                  ${p.diff!=null && Math.abs(p.diff)>=1 ? `<div style="font-size:9.5px;color:#ef4444;font-weight:400;">não identificado</div>` : ''}
                </td>
                <td style="padding:9px 8px;text-align:center;">${p.bate==null?'<span style="color:var(--text-muted);">—</span>':p.bate?'<span style="color:#10b981;">✅</span>':'<span style="color:#ef4444;">⚠️</span>'}</td>
                <td style="padding:9px 8px;color:${st.cor};">${st.label}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        </div>
      </div>`}
    </div>`;

    document.getElementById('conc-sel-periodo')?.addEventListener('change', e => {
      filtroPeriodo = e.target.value;
      document.getElementById('conc-custom-range').style.display = filtroPeriodo==='custom'?'flex':'none';
      render();
    });
    document.getElementById('conc-date-from')?.addEventListener('change', e => { customFrom = e.target.value; });
    document.getElementById('conc-date-to')?.addEventListener('change', e => { customTo = e.target.value; });
    document.getElementById('conc-sel-conta')?.addEventListener('change', e => { contaSel = e.target.value || null; pedidos=[]; atualizadoEm=null; render(); });
  }

  window._conciliacaoBuscar = () => buscar();

  render();
  carregarContas().then(render);
});
