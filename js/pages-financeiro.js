// ============================================================
// GLR Consultoria — Financeiro (DRE Cascata direto da API)
// ============================================================

Router.register('financeiro', async (params, el) => {
  const pad   = n => String(n).padStart(2,'0');
  const hoje  = new Date();
  const R$    = v => 'R$ ' + (parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const R$s   = v => { const n=parseFloat(v)||0; return (n<0?'-R$ ':'R$ ')+Math.abs(n).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); };

  const STORAGE_MANUAL = 'glr_fin_manual';
  const STORAGE_CACHE  = 'glr_fin_cache';

  const custosVendas = JSON.parse(localStorage.getItem('glr_vendas_custos')||'{}');
  const linhasExt    = JSON.parse(localStorage.getItem('glr_vendas_linhas')||'[]');
  const aliquotas    = JSON.parse(localStorage.getItem('glr_aliquotas')||'{}');

  // Mês selecionado persiste entre recarregamentos (não volta sozinho pro mês atual)
  let mesSel   = localStorage.getItem('glr_fin_mes') || `${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}`;
  let contaSel = 'todas';
  let incluirReemb = true;
  let pedidos  = [];
  let contas   = [];
  let aberto   = {};
  let adsAPI   = {};  // investimento em ADS vindo da API, por plataforma
  let adsDetalhados = {};  // dados detalhados de ADS: cliques, impressões, ROI, etc
  let afiliados = {};  // dados de afiliados: comissão, etc
  let payout = {};  // dados de payout/carteira

  let manualAll = JSON.parse(localStorage.getItem(STORAGE_MANUAL)||'{}');
  function manual() {
    if (!manualAll[mesSel]) {
      manualAll[mesSel] = {
        armazenamento:{},
        ads:{},
        receitas:[],
        despesas:[]
      };
      // Inicializa taxas adicionais para cada plataforma conhecida
      for (const n of nomes) {
        manualAll[mesSel][n] = manualAll[mesSel][n] || { taxaMoedas: 0, taxaCartao: 0 };
      }
    }
    return manualAll[mesSel];
  }
  const salvarManual = () => localStorage.setItem(STORAGE_MANUAL, JSON.stringify(manualAll));

  const CACHE_VER = 24; // bump quando a estrutura de taxas muda — invalida caches antigos
  function salvarCache() {
    try {
      const cache = { ver: CACHE_VER, mesKey: mesSel, pedidos, adsAPI, adsDetalhados, afiliados, payout, at: Date.now() };
      localStorage.setItem(STORAGE_CACHE, JSON.stringify(cache));
      console.log('[Cache] Salvou', pedidos.length, 'pedidos +', Object.keys(adsAPI).length, 'plataformas de ADS + afiliados + payout');
    } catch(e){}
  }
  function carregarCache() {
    try {
      const c = JSON.parse(localStorage.getItem(STORAGE_CACHE)||'null');
      if (c && c.ver === CACHE_VER && c.mesKey === mesSel) {
        pedidos = c.pedidos||[];
        adsAPI = c.adsAPI||{};
        adsDetalhados = c.adsDetalhados||{};
        afiliados = c.afiliados||{};
        payout = c.payout||{};
        console.log('[Cache] Carregou', pedidos.length, 'pedidos + dados complementares');
        return c.at;
      }
    } catch(e){}
    return null;
  }

  // ── Cálculos ──────────────────────────────────────────────
  function pedidosFiltrados() {
    return pedidos.filter(p => contaSel==='todas' || p.contaId===contaSel);
  }

  function isReembolsado(p) {
    const st = (p.status||'').toLowerCase();
    return st.includes('cancel') || st.includes('refund') || st.includes('devol') || st==='invalid';
  }

  function custoExtrasPedido(p) {
    const c = custosVendas[p.id]||{};
    let extra = parseFloat(c.outros)||0;
    for (const l of linhasExt)
      extra += l.tipo==='pct' ? (parseFloat(p.valor)||0)*(parseFloat(l.valor)||0)/100 : (parseFloat(l.valor)||0);
    return extra;
  }

  function impostoPedido(p) {
    const tx = p.taxas||{};
    const impAPI = tx.imposto != null ? parseFloat(tx.imposto) : 0;
    if (impAPI > 0) return impAPI;
    const c = custosVendas[p.id]||{};
    const pctImp = parseFloat(c.imposto) || parseFloat(aliquotas[p.contaId]||0);
    return (parseFloat(p.valor)||0) * pctImp / 100;
  }

  function calcularTudo() {
    const lista = pedidosFiltrados();
    console.log('[Calc] Total pedidos:', pedidos.length, 'Filtrados:', lista.length, 'Conta:', contaSel);
    const plats = {};
    for (const p of lista) {
      const nome = p.plataforma;
      if (!plats[nome]) plats[nome] = {
        fat:0, liquido:0,
        frete:0,        // frete descontado do vendedor
        comissao:0,     // comissão % (sale_fee / commission_fee)
        taxaServico:0,  // taxa de serviço / taxa fixa
        voucher:0,      // voucher da plataforma (positivo)
        outras:0,       // residual não identificado
        custoProd:0, custoProdReemb:0, custoExtra:0, custoExtraReemb:0, imposto:0,
        taxaMoedas:0,   // taxa de conversão de moedas
        taxaCartao:0,   // taxa de cartão de crédito
        nReemb:0,       // número de reembolsos
        valorReemb:0,   // valor total reembolsado
        n:0
      };
      const a  = plats[nome];
      const tx = p.taxas||{};
      const reemb = isReembolsado(p);
      const valor = parseFloat(p.valor)||0;
      const liq   = tx.liquido!=null ? parseFloat(tx.liquido) : valor;
      const c     = custosVendas[p.id]||{};
      const custo = parseFloat(c.custo)||0;
      const extra = custoExtrasPedido(p);

      if (reemb) {
        a.nReemb++;
        a.valorReemb += valor;
        if (incluirReemb) { a.custoProdReemb += custo; a.custoExtraReemb += extra; }
        continue;
      }
      a.n++;
      a.fat         += valor;
      a.liquido     += liq;
      a.frete       += parseFloat(tx.frete)||0;
      a.comissao    += parseFloat(tx.comissao)||0;
      a.taxaServico += parseFloat(tx.taxaServico)||0;
      a.voucher     += parseFloat(tx.voucher)||0;
      a.custoProd   += custo;
      a.custoExtra  += extra;
      a.imposto     += impostoPedido(p);
    }
    // Residual: diferença não explicada pelas taxas conhecidas
    for (const nome in plats) {
      const a = plats[nome];
      const conhecidas = a.frete + a.comissao + a.taxaServico - a.voucher;
      a.outras = Math.max(0, (a.fat - a.liquido) - conhecidas);
    }

    // DEBUG: mostra totais
    console.log('[Calc] Resultados:', Object.fromEntries(
      Object.entries(plats).map(([n, a]) => [n, {
        fat: a.fat,
        nReemb: a.nReemb,
        valorReemb: a.valorReemb,
        comissao: a.comissao,
        adsAPI: adsAPI[n] || 0
      }])
    ));
    return plats;
  }

  // ── Render ────────────────────────────────────────────────
  function secao(id, titulo, valor, corpo, negativo) {
    const isOpen = aberto[id] !== false;
    const num = parseFloat(valor.num)||0;
    const corVal = num >= 0 && !negativo ? 'var(--green)' : 'var(--red)';
    return `
    <div class="fin-card">
      <div class="fin-head" onclick="finToggle('${id}')">
        <span class="fin-ico" style="background:${negativo?'var(--red)':'var(--green)'};">${negativo?'−':'+'}</span>
        <span class="fin-titulo">${titulo}</span>
        <span class="fin-valor" style="color:${corVal};">${valor.txt}</span>
      </div>
      <div class="fin-body" id="fin-body-${id}" style="display:${isOpen?'block':'none'};">${corpo}</div>
    </div>`;
  }

  const linha    = (lbl,v)       => `<div class="fin-row"><span>${lbl}:</span><strong>${R$(v)}</strong></div>`;
  const sublinha = (lbl,v,sinal) => `<div class="fin-sub"><span>${lbl}:</span><em>${sinal==='+'?'+ ':'− '}${R$(Math.abs(v))}</em></div>`;
  const subfinal = v             => `<div class="fin-sub fin-final"><span>Valor Final:</span><em>${R$(v)}</em></div>`;

  function renderConteudo() {
    const cont = document.getElementById('fin-conteudo');
    if (!cont) return;
    if (!pedidos.length) {
      cont.innerHTML = `<div style="text-align:center;padding:48px;color:var(--text-muted);">⏳ Nenhum dado carregado. Clique em Atualizar.</div>`;
      return;
    }

    const plats = calcularTudo();
    const nomes = Object.keys(plats).sort();
    const m = manual();

    const totFat = nomes.reduce((s,n)=>s+plats[n].fat,0);
    const totLiq = nomes.reduce((s,n)=>s+plats[n].liquido,0);

    const lucroPlat = {};
    for (const n of nomes) {
      const a = plats[n];
      lucroPlat[n] = a.liquido - a.custoProd - a.custoProdReemb - a.custoExtra - a.custoExtraReemb - a.imposto;
    }
    const totLucroBruto = nomes.reduce((s,n)=>s+lucroPlat[n],0);
    const pctLucroBruto = totFat>0 ? (totLucroBruto/totFat)*100 : 0;

    const totArmaz = nomes.reduce((s,n)=>s+(parseFloat(m.armazenamento[n])||0),0);
    // ADS: manual sobrescreve quando > 0; senão usa o valor automático da API
    const adsEfetivo = n => {
      const man = parseFloat(m.ads[n])||0;
      const api = parseFloat(adsAPI[n])||0;
      return man > 0 ? man : api;
    };
    const totAds   = nomes.reduce((s,n)=>s+adsEfetivo(n),0);
    console.log('[Render] totAds=', totAds, 'adsAPI=', adsAPI, 'manual=', m.ads);
    const lucroDepoisAds = totLucroBruto - totArmaz - totAds;
    const pctDepoisAds   = totFat>0 ? (lucroDepoisAds/totFat)*100 : 0;

    const totReceitas  = (m.receitas||[]).reduce((s,r)=>s+(parseFloat(r.valor)||0),0);
    const totDespesas  = (m.despesas||[]).reduce((s,d)=>s+(parseFloat(d.valor)||0),0);
    const lucroLiquido = lucroDepoisAds + totReceitas - totDespesas;
    const pctLiquido   = totFat>0 ? (lucroLiquido/totFat)*100 : 0;

    // Totais de deduções para header de líquido
    const totFrete    = nomes.reduce((s,n)=>s+plats[n].frete,0);
    const totComissao = nomes.reduce((s,n)=>s+plats[n].comissao,0);
    const totTaxaSvc  = nomes.reduce((s,n)=>s+plats[n].taxaServico,0);
    const totOutras   = nomes.reduce((s,n)=>s+plats[n].outras,0);
    const totDeducoes = totFat - totLiq;

    // ── 1. Faturamento ──
    const sFat = secao('fat','Faturamento',{num:totFat,txt:R$(totFat)},
      nomes.map(n=>linha(n, plats[n].fat)).join('') +
      (nomes.length>1 ? `<div class="fin-row" style="border-top:1px solid var(--border);margin-top:6px;"><span>Total:</span><strong>${R$(totFat)}</strong></div>` : '')
    );

    // ── 2. Líquido Marketplace ──
    const sLiq = secao('liq','Líquido Marketplace',{num:totLiq,txt:R$(totLiq)},
      nomes.map(n=>{
        const a = plats[n];
        const rows = [linha(n, a.fat)];

        if (n==='Mercado Livre') {
          const totalTaxasML = a.fat - a.liquido;
          if (a.comissao > 0.01)    rows.push(sublinha('Comissão Mercado Livre', a.comissao));
          if (a.frete > 0.01)       rows.push(sublinha('Frete descontado (vendedor)', a.frete));
          if (a.taxaServico > 0.01) rows.push(sublinha('Taxa fixa / serviço', a.taxaServico));
          const residualML = totalTaxasML - a.comissao - a.frete - a.taxaServico;
          if (residualML > 1) rows.push(sublinha(
            a.comissao > 0.01 ? 'Frete e outras taxas ML' : 'Comissão + Frete + Taxas ML',
            residualML
          ));
          if (totalTaxasML < 1) rows.push(sublinha('Sem deduções registradas', 0));
        } else if (n==='Shopee') {
          const totalTaxasSh = a.fat - a.liquido;
          if (a.comissao > 0.01)    rows.push(sublinha('Comissão Shopee', a.comissao));
          if (a.taxaServico > 0.01) rows.push(sublinha('Taxa de serviço', a.taxaServico));
          if (a.frete > 0.01)       rows.push(sublinha('Frete descontado (vendedor)', a.frete));
          if (a.voucher > 0.01)     rows.push(sublinha('Voucher Shopee', a.voucher, '+'));
          const residualSh = totalTaxasSh - a.comissao - a.taxaServico - a.frete + a.voucher;
          if (residualSh > 1) rows.push(sublinha(
            a.comissao > 0.01 ? 'Outras deduções Shopee' : 'Comissão + Frete + Taxas Shopee',
            residualSh
          ));
          if (totalTaxasSh < 1) rows.push(sublinha('Taxas disponíveis após entrega dos pedidos', 0));
        } else {
          if (a.comissao > 0.01)    rows.push(sublinha('Comissão', a.comissao));
          if (a.taxaServico > 0.01) rows.push(sublinha('Taxa de serviço', a.taxaServico));
          if (a.frete > 0.01)       rows.push(sublinha('Frete descontado', a.frete));
          if (a.voucher > 0.01)     rows.push(sublinha('Voucher', a.voucher, '+'));
          if (a.outras > 1)         rows.push(sublinha('Outras taxas', a.outras));
        }
        rows.push(subfinal(a.liquido));
        return `<div class="fin-grupo">${rows.join('')}</div>`;
      }).join('') +
      (nomes.length>1 ? `<div class="fin-row" style="border-top:1px solid var(--border);margin-top:6px;">
        <span>Total deduções plataforma:</span><strong style="color:var(--red);">- ${R$(totDeducoes)}</strong>
      </div>
      <div class="fin-row"><span>Total líquido:</span><strong>${R$(totLiq)}</strong></div>` : '')
    );

    // ── 3. DETALHAMENTO COMPLETO DE TAXAS ──
    const sDetalheTaxas = secao('detalhe-taxas', '📊 Detalhamento Completo de Taxas',
      {num:-(totDeducoes + totArmaz), txt:R$s(-(totDeducoes + totArmaz))},
      `<div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;padding:10px;background:rgba(99,102,241,0.05);border-radius:8px;">
        <strong>Aviso:</strong> Este detalhamento mostra todas as taxas e deduções aplicadas. Valores negativos representam custos.
      </div>` +
      nomes.map(n => {
        const a = plats[n];
        const totalTaxas = a.fat - a.liquido;
        const numPedidos = Object.values(plats[n]).filter((v, i) => typeof v === 'number' && i === 0).length || 1;

        return `
          <div class="fin-grupo">
            <div class="fin-row"><span style="font-weight:600;">${n}</span><span style="font-weight:600;">TOTAL: ${R$s(-(totalTaxas))}</span></div>

            <div style="padding-left:16px;border-left:2px solid rgba(99,102,241,0.3);margin:8px 0;">
              <div class="fin-row"><span>Faturamento Bruto:</span><strong>${R$(a.fat)}</strong></div>

              <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(99,102,241,0.2);">
                <div style="font-size:10px;color:var(--orange);font-weight:600;margin-bottom:6px;">TAXAS MARKETPLACE:</div>
                ${a.comissao > 0.01 ? `<div class="fin-row"><span style="padding-left:12px;">💳 Comissão:</span><strong style="color:var(--red);">- ${R$(a.comissao)}</strong></div>` : ''}
                ${a.taxaServico > 0.01 ? `<div class="fin-row"><span style="padding-left:12px;">⚙️ Taxa de Serviço:</span><strong style="color:var(--red);">- ${R$(a.taxaServico)}</strong></div>` : ''}
                ${a.frete > 0.01 ? `<div class="fin-row"><span style="padding-left:12px;">🚚 Frete Descontado:</span><strong style="color:var(--red);">- ${R$(a.frete)}</strong></div>` : ''}
                ${a.voucher > 0.01 ? `<div class="fin-row"><span style="padding-left:12px;">🎟️ Voucher Plataforma:</span><strong style="color:var(--green);">+ ${R$(a.voucher)}</strong></div>` : ''}
              </div>

              <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(99,102,241,0.2);">
                <div style="font-size:10px;color:var(--blue);font-weight:600;margin-bottom:6px;">CUSTOS OPERACIONAIS:</div>
                ${a.custoProd > 0 ? `<div class="fin-row"><span style="padding-left:12px;">📦 Custo dos Produtos:</span><strong style="color:var(--red);">- ${R$(a.custoProd)}</strong></div>` : ''}
                ${a.custoExtra > 0 ? `<div class="fin-row"><span style="padding-left:12px;">📋 Custos Variáveis/Extras:</span><strong style="color:var(--red);">- ${R$(a.custoExtra)}</strong></div>` : ''}
                ${a.imposto > 0 ? `<div class="fin-row"><span style="padding-left:12px;">📊 Impostos:</span><strong style="color:var(--red);">- ${R$(a.imposto)}</strong></div>` : ''}
              </div>

              <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(99,102,241,0.2);">
                <div class="fin-row"><span style="font-weight:500;">Líquido após taxas:</span><strong style="color:var(--green);">${R$(a.liquido)}</strong></div>
              </div>
            </div>
          </div>
        `;
      }).join(''), true
    );

    // ── 3b. Pedidos Cancelados/Reembolsados ──
    const sPedidosCancelados = secao('cancelados', '❌ Pedidos Cancelados/Reembolsados',
      {num:nomes.reduce((s,n)=>s+plats[n].nReemb,0), txt:R$(nomes.reduce((s,n)=>s+plats[n].valorReemb, 0))},
      nomes.map(n => {
        const a = plats[n];
        if (a.nReemb === 0) return `<div style="padding:10px;text-align:center;color:var(--text-muted);font-size:12px;">Sem cancelamentos em ${n}</div>`;
        const custoReemb = a.custoProdReemb + a.custoExtraReemb;
        return `
          <div class="fin-grupo">
            <div class="fin-row"><span style="font-weight:600;">${n}</span></div>
            <div style="padding-left:16px;border-left:2px solid rgba(239,68,68,0.3);">
              <div class="fin-row"><span>📦 Pedidos cancelados:</span><strong>${a.nReemb}</strong></div>
              <div class="fin-row"><span>💰 Valor cancelado:</span><strong style="color:var(--red);">- ${R$(a.valorReemb)}</strong></div>
              <div class="fin-row"><span>📊 Custo dos produtos:</span><strong style="color:var(--red);">- ${R$(custoReemb)}</strong></div>
            </div>
          </div>
        `;
      }).join(''), true
    );


    // ── 4. Lucro Bruto ──
    const sLucro = secao('lucro',`Lucro Bruto`,
      {num:totLucroBruto, txt:`${R$(totLucroBruto)} (${pctLucroBruto.toFixed(2).replace('.',',')}%)`},
      nomes.map(n=>{
        const a = plats[n];
        const rows = [linha(n, a.liquido)];
        if (a.custoProd>0)                          rows.push(sublinha('Custo dos produtos', a.custoProd));
        if (incluirReemb && a.custoProdReemb>0)     rows.push(sublinha('Custo produtos reembolsados', a.custoProdReemb));
        if (a.custoExtra>0)                         rows.push(sublinha('Custos extras / variáveis', a.custoExtra));
        if (incluirReemb && a.custoExtraReemb>0)    rows.push(sublinha('Custos extras reembolsados', a.custoExtraReemb));
        if (a.imposto>0)                            rows.push(sublinha('Impostos', a.imposto));
        rows.push(subfinal(lucroPlat[n]));
        return `<div class="fin-grupo">${rows.join('')}</div>`;
      }).join('')
    );

    // ── 4. Armazenamento FULL/FBA (manual) ──
    const sArmaz = secao('armaz','Custo de Armazenamento FULL/FBA',{num:-totArmaz,txt:R$s(-totArmaz)},
      nomes.map(n=>`
        <div class="fin-row"><span>${n}:</span>
          <input class="fin-inp" data-tipo="armazenamento" data-plat="${n}" type="number" min="0" step="0.01"
            value="${m.armazenamento[n]||''}" placeholder="0,00">
        </div>`).join(''), true);

    // ── 5. ADS (API + sobrescrita manual) ──
    const adsRows = nomes.map(n=>{
      const api = parseFloat(adsAPI[n])||0;
      const man = parseFloat(m.ads[n])||0;
      const efetivo = adsEfetivo(n);
      const statusAds = api > 0 ? '✅ API' : (man > 0 ? '📝 Manual' : '⚠️ Sem dados');
      const corStatus = api > 0 ? 'var(--green)' : (man > 0 ? 'var(--blue)' : 'var(--orange)');
      return `
        <div class="fin-grupo">
          <div class="fin-row">
            <span>${n}</span>
            <strong style="color:${efetivo>0?'var(--red)':'var(--text-secondary)'};">− ${R$(efetivo)}</strong>
          </div>
          <div class="fin-sub"><em style="color:${corStatus};font-weight:500;">${statusAds}${api>0?` R$ ${R$(api)}`:(man>0?` R$ ${R$(man)}`:'')}</em></div>
          <div style="padding:6px 0;"><input class="fin-inp" data-tipo="ads" data-plat="${n}" type="number" min="0" step="0.01"
            value="${man>0?man:''}" placeholder="${api>0?'API: '+R$(api):'Manual'}" style="width:100%;"></div>
        </div>`;
    }).join('');
    const sAds = secao('ads','💰 Investimento em ADS',{num:-totAds,txt:R$s(-totAds)},
      `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;padding:8px;background:rgba(99,102,241,0.05);border-radius:8px;">
        Valores puxados automaticamente da API. Edite para sobrescrever.
      </div>${adsRows}`, true);

    // ── 5b. ADS Detalhados (cliques, impressões, ROI, etc) ──
    const sAdsDetalhados = secao('ads-det','📈 Métricas Detalhadas de ADS',
      {num:0, txt:''},
      Object.keys(adsDetalhados).length > 0
        ? Object.entries(adsDetalhados).map(([plat, dados]) => `
            <div class="fin-grupo">
              <div class="fin-row" style="font-weight:600;"><span>${plat}</span></div>
              ${dados.investimento ? `<div class="fin-row"><span style="padding-left:12px;">💰 Investimento:</span><strong>${R$(dados.investimento)}</strong></div>` : ''}
              ${dados.cliques ? `<div class="fin-row"><span style="padding-left:12px;">🖱️ Cliques:</span><strong>${dados.cliques}</strong></div>` : ''}
              ${dados.impressoes ? `<div class="fin-row"><span style="padding-left:12px;">👁️ Impressões:</span><strong>${dados.impressoes}</strong></div>` : ''}
              ${dados.ctr ? `<div class="fin-row"><span style="padding-left:12px;">📊 CTR:</span><strong>${dados.ctr.toFixed(2)}%</strong></div>` : ''}
              ${dados.cpc ? `<div class="fin-row"><span style="padding-left:12px;">💵 CPC:</span><strong>${R$(dados.cpc)}</strong></div>` : ''}
              ${dados.vendas ? `<div class="fin-row"><span style="padding-left:12px;">🛒 Vendas ADS:</span><strong>${dados.vendas}</strong></div>` : ''}
              ${dados.faturamentoAds ? `<div class="fin-row"><span style="padding-left:12px;">💸 Faturamento ADS:</span><strong>${R$(dados.faturamentoAds)}</strong></div>` : ''}
              ${dados.roas ? `<div class="fin-row"><span style="padding-left:12px;">📈 ROAS:</span><strong style="color:var(--green);">${dados.roas.toFixed(2)}</strong></div>` : ''}
            </div>
          `).join('')
        : '<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:10px;">Nenhum dado de ADS detalhado disponível</div>',
      true
    );

    // ── 5c. Afiliados (comissão) ──
    const sAfiliados = secao('afil','👥 Comissão de Afiliados',
      {num:afiliados.totalComissao||0, txt:R$(afiliados.totalComissao||0)},
      afiliados.totalComissao > 0
        ? `
          <div class="fin-grupo">
            <div class="fin-row"><span>💰 Total Comissão:</span><strong style="color:var(--green);">${R$(afiliados.totalComissao)}</strong></div>
            <div class="fin-row"><span>🛍️ Total Vendas:</span><strong>${R$(afiliados.totalVendas||0)}</strong></div>
            <div class="fin-row"><span>📦 Total Pedidos:</span><strong>${afiliados.totalPedidos||0}</strong></div>
            <div class="fin-row"><span>👤 Total Afiliados:</span><strong>${afiliados.totalAfiliados||0}</strong></div>
            <div class="fin-row"><span>📊 Taxa Média:</span><strong>${(afiliados.taxaMedia||0).toFixed(2)}%</strong></div>
          </div>
        `
        : '<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:10px;">Nenhuma comissão de afiliado registrada</div>',
      true
    );

    // ── 5d. Payout/Carteira ──
    const sPayout = secao('payout','💳 Payout & Carteira',
      {num:0, txt:''},
      Object.keys(payout).length > 0
        ? Object.entries(payout).map(([chave, dados]) => `
            <div class="fin-grupo">
              <div class="fin-row" style="font-weight:600;"><span>${chave}</span></div>
              ${dados.saldo != null ? `<div class="fin-row"><span style="padding-left:12px;">💵 Saldo:</span><strong style="color:var(--green);">${R$(dados.saldo)}</strong></div>` : ''}
              ${dados.totalReceito ? `<div class="fin-row"><span style="padding-left:12px;">✅ Total Recebido:</span><strong>${R$(dados.totalReceito)}</strong></div>` : ''}
              ${dados.totalSacado ? `<div class="fin-row"><span style="padding-left:12px;">🏦 Total Sacado:</span><strong>${R$(dados.totalSacado)}</strong></div>` : ''}
              ${dados.bank_name ? `<div class="fin-row"><span style="padding-left:12px;">🏪 Banco:</span><strong>${dados.bank_name}</strong></div>` : ''}
              ${dados.bank_account_number ? `<div class="fin-row"><span style="padding-left:12px;">🔐 Conta:</span><strong>***${String(dados.bank_account_number).slice(-4)}</strong></div>` : ''}
            </div>
          `).join('')
        : '<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:10px;">Nenhuma informação de payout disponível</div>',
      true
    );

    // ── 6. Lucro depois de ADS ──
    const sDepois = `
    <div class="fin-card fin-resumo" style="background:linear-gradient(135deg, ${lucroDepoisAds>=0?'rgba(16,185,129,0.08)':'rgba(239,68,68,0.08)'} 0%, transparent 100%);border-color:${lucroDepoisAds>=0?'rgba(16,185,129,0.3)':'rgba(239,68,68,0.3)'};border-width:2px;">
      <div class="fin-head" style="cursor:default;flex-direction:column;align-items:flex-start;gap:8px;">
        <div style="display:flex;align-items:center;gap:12px;width:100%;">
          <span class="fin-ico" style="background:${lucroDepoisAds>=0?'var(--green)':'var(--red)'};">${lucroDepoisAds>=0?'+':'−'}</span>
          <span class="fin-titulo" style="font-size:17px;">📊 Lucro Bruto depois de ADS</span>
        </div>
        <span class="fin-valor" style="color:${lucroDepoisAds>=0?'var(--green)':'var(--red)'};;font-size:22px;align-self:flex-end;">${R$(lucroDepoisAds)} <span style="font-size:13px;">(${pctDepoisAds.toFixed(2).replace('.',',')}%)</span></span>
      </div>
    </div>`;

    // ── 7. Receita extra / Despesas ──
    const linhasCustom = (arr, tipo) => `
      ${!arr.length ? `<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:10px;">Nenhuma ${tipo==='receitas'?'receita extra':'despesa operacional'} cadastrada</div>` : ''}
      ${arr.map((l,i)=>`
        <div class="fin-row">
          <span>${l.nome}:</span>
          <span style="display:flex;align-items:center;gap:8px;">
            <strong>${R$(l.valor)}</strong>
            <button onclick="finRemoverLinha('${tipo}',${i})" style="border:none;background:none;color:var(--red);cursor:pointer;font-size:16px;line-height:1;">×</button>
          </span>
        </div>`).join('')}
      <div style="display:flex;gap:6px;margin-top:10px;">
        <input id="fin-nome-${tipo}" class="form-input" placeholder="Descrição" style="flex:2;padding:6px 10px;font-size:12px;">
        <input id="fin-valor-${tipo}" class="form-input" type="number" min="0" step="0.01" placeholder="Valor" style="flex:1;padding:6px 10px;font-size:12px;">
        <button onclick="finAddLinha('${tipo}')" class="btn-primary" style="padding:5px 12px;font-size:12px;">+ Add</button>
      </div>`;

    const sReceita  = secao('receita','Receita Extra',{num:totReceitas,txt:R$(totReceitas)}, linhasCustom(m.receitas||[],'receitas'));
    const sDespesas = secao('despesa','Despesas Operacionais',{num:totDespesas,txt:R$(totDespesas)}, linhasCustom(m.despesas||[],'despesas'), true);

    // ── 8. Lucro Líquido Operacional ──
    const sFinal = `
    <div class="fin-card fin-resumo fin-resultado">
      <div class="fin-head" style="cursor:default;padding:18px 20px;">
        <span class="fin-ico" style="background:${lucroLiquido>=0?'var(--green)':'var(--red)'};width:22px;height:22px;">${lucroLiquido>=0?'+':'−'}</span>
        <span class="fin-titulo" style="font-size:17px;">Lucro Líquido Operacional</span>
        <span class="fin-valor" style="font-size:18px;color:${lucroLiquido>=0?'var(--green)':'var(--red)'};">${R$(lucroLiquido)} <span style="font-size:13px;">(${pctLiquido.toFixed(2).replace('.',',')}%)</span></span>
      </div>
    </div>`;

    cont.innerHTML = sFat + sLiq + sDetalheTaxas + sPedidosCancelados + sLucro + sArmaz + sAds + sAdsDetalhados + sAfiliados + sPayout + sDepois + sReceita + sDespesas + sFinal;

    cont.querySelectorAll('.fin-inp').forEach(inp=>{
      inp.addEventListener('change', ()=>{
        const tipo = inp.dataset.tipo, plat = inp.dataset.plat;
        manual()[tipo][plat] = parseFloat(inp.value)||0;
        salvarManual(); renderConteudo();
      });
    });
  }

  // ── Buscar da API ─────────────────────────────────────────
  let buscando = false; // trava: impede duas buscas simultâneas (zera/mistura dados)
  let forceReprocess = false; // força reprocessamento mesmo se tiver cache
  let contaReprocess = null; // se setado, reprocessa apenas essa conta

  async function buscar() {
    console.log('[BUSCAR] Iniciado | forceReprocess:', forceReprocess);
    const statusEl = document.getElementById('fin-status');
    const btnEl    = document.getElementById('fin-btn-atualizar');
    const reprocessBtn = document.getElementById('fin-btn-reprocessar');
    const apiKey   = localStorage.getItem('glr_mc_apikey')||'';
    if (!apiKey) { if(statusEl) statusEl.textContent='⚠️ Configure a API Key nas Integrações.'; return; }
    if (buscando) { if(statusEl) statusEl.textContent='⏳ Aguarde a busca atual terminar...'; return; }

    // Verificar cache se não for reprocessamento
    console.log('[BUSCAR] Checando cache | !forceReprocess:', !forceReprocess, '| cache existe:', !!carregarCache());
    let tempoCache = null;
    if (!forceReprocess && (tempoCache = carregarCache())) {
      // ✅ OTIMIZAÇÃO: Mostrar cache IMEDIATAMENTE (sem esperar a busca nova)
      if (statusEl) {
        const cacheTime = new Date(tempoCache).toLocaleTimeString('pt-BR');
        statusEl.textContent = `✓ Cache (${cacheTime})... atualizando em background`;
      }
      renderConteudo();
      // Continua a função para buscar novos dados em background
      buscando = false; // Permite que o usuário interaja
    }

    // IMPORTANTE: Guardar contaReprocess ANTES de resetar flags
    const contaReprocessLocal = contaReprocess;

    forceReprocess = false; // reseta flag
    contaReprocess = null; // reseta conta a reprocessar
    buscando = true;
    if (btnEl) { btnEl.disabled=true; btnEl.textContent='⏳ Buscando...'; }
    if (reprocessBtn) { reprocessBtn.disabled=true; reprocessBtn.textContent='⏳ Reprocessando...'; }

    try {
      const [ano, mes] = mesSel.split('-').map(Number);
      const primeiroDia = `${ano}-${pad(mes)}-01`;
      const ultimoDia   = new Date(ano, mes, 0).getDate();
      const ehMesAtual  = ano===hoje.getFullYear() && mes===hoje.getMonth()+1;
      // Mês atual: até HOJE (igual aos painéis ML/Shopee). Mês fechado: até o último dia.
      const dataTo      = ehMesAtual
        ? `${ano}-${pad(mes)}-${pad(hoje.getDate())}`
        : `${ano}-${pad(mes)}-${pad(ultimoDia)}`;
      const tsFrom = new Date(`${primeiroDia}T00:00:00`).getTime();
      const tsTo   = new Date(`${dataTo}T23:59:59`).getTime();

      if (statusEl) statusEl.textContent = 'Buscando contas...';
      const r = await MarketplaceAPI.call('list_accounts');
      contas = r.data?.accounts||[];
      renderFiltroContas();

      // Se está reprocessando uma conta específica, buscar APENAS dela
      const contasParaBuscar = contaReprocessLocal ? contas.filter(c => c.external_id === contaReprocessLocal) : contas;
      if (contaReprocessLocal) {
        console.log(`[Buscar] Reprocessando apenas conta: ${contaReprocessLocal} (${contasParaBuscar.length} contas)`);
      }

      // Se não está reprocessando, limpar pedidos. Se é reprocessamento parcial, manter os outros
      if (!contaReprocessLocal) {
        pedidos = [];
      } else {
        // Remove pedidos dessa conta para reprocessar
        pedidos = pedidos.filter(p => p.contaId !== contaReprocessLocal);
      }

      const errosConta = [];
      const log = [];

      for (const conta of contasParaBuscar) {
        try {

          // ── Mercado Livre ──────────────────────────────────
          if (['meli','ml','mercadolivre'].includes(conta.marketplace)) {
            const meliId = conta.param_to_use?.meliUserId||conta.external_id;
            if (statusEl) statusEl.textContent=`📦 Mercado Livre (${conta.nickname||meliId}): buscando pedidos...`;

            const orders = await MarketplaceAPI.mlOrders(meliId, primeiroDia, dataTo);

            // Filtrar cancelados/inválidos
            const ordensValidas = orders.filter(o => {
              const st = (o.status||'').toLowerCase();
              return !['cancelled','invalid'].includes(st);
            });
            const cancelados = orders.length - ordensValidas.length;
            if (cancelados > 0) console.log(`[ML] Ignorando ${cancelados} pedidos cancelados/inválidos`);

            // Log do primeiro pedido ML para diagnóstico de campos
            if (ordensValidas.length > 0) {
              const sample = ordensValidas[0];
              console.log('[ML order sample] order_items:', JSON.stringify(sample.order_items||[]).substring(0,400));
              console.log('[ML order sample] payments:', JSON.stringify(sample.payments||[]).substring(0,200));
            }

            const mlPedidos = ordensValidas.map(o=>{
              // sale_fee é POR UNIDADE — multiplica pela quantidade
              const itens = (o.order_items||o.items||[]).map(i=>({
                qtd: i.quantity||1,
                saleFee: (parseFloat(i.sale_fee)||0) * (i.quantity||1),
              }));
              const comissaoTotal = itens.reduce((s,i)=>s+i.saleFee, 0);
              return {
                id: String(o.id),
                plataforma: 'Mercado Livre',
                contaId: conta.external_id,
                dataTs: new Date(o.date_created||0).getTime(),
                valor: parseFloat(o.total_amount)||0,
                status: o.status||'',
                paymentId:  o.payments?.[0]?.id||null,
                shippingId: o.shipping?.id||null,
                taxas: {
                  liquido:      null,    // preenchido depois
                  comissao:     comissaoTotal,
                  taxaServico:  0,
                  imposto:      0,
                  frete:        null,    // preenchido depois
                  voucher:      0,
                },
              };
            });

            // Adiciona os pedidos IMEDIATAMENTE (por referência) — assim o faturamento
            // fica garantido mesmo se a busca de taxas falhar logo abaixo.
            pedidos.push(...mlPedidos);
            log.push(`ML: ${mlPedidos.length} pedidos`);

            if (statusEl) statusEl.textContent=`📦 ML: buscando taxas (${mlPedidos.length} pedidos)...`;

            // Busca net_received_amount com concorrência limitada a 3 para não sobrecarregar a API.
            // Tudo aqui é best-effort: qualquer falha NÃO afeta o faturamento já contabilizado.
            try {
            const collectionsMap = {};
            const pedidosComPayment = mlPedidos.filter(p=>p.paymentId);
            let colLogFeito = false;
            const COL_CONC = 20; // Aumentado de 8 para 20 requisições simultâneas
            let colAtivos = 0, colIdx = 0, colDone = 0;
            await new Promise(colResolve => {
              if (!pedidosComPayment.length) { colResolve(); return; }
              const colNext = () => {
                while (colAtivos < COL_CONC && colIdx < pedidosComPayment.length) {
                  const p = pedidosComPayment[colIdx++];
                  colAtivos++;
                  MarketplaceAPI.call('raw',{method:'GET',path:`/collections/${p.paymentId}`})
                    .then(r2 => {
                      if (!colLogFeito) {
                        colLogFeito = true;
                        console.log('[ML collection sample]', JSON.stringify(r2).substring(0, 600));
                      }
                      const net = parseFloat(
                        r2.data?.net_received_amount ??
                        r2.data?.collection?.net_received_amount ??
                        r2.data?.transaction?.net_received_amount
                      );
                      if (!isNaN(net) && net > 0) collectionsMap[String(p.paymentId)] = net;
                    })
                    .catch(()=>{})
                    .finally(()=>{
                      colAtivos--; colDone++;
                      if (statusEl && colDone % 25 === 0)
                        statusEl.textContent = `📦 ML: taxas ${colDone}/${pedidosComPayment.length}...`;
                      if(colIdx>=pedidosComPayment.length&&colAtivos===0) colResolve(); else colNext();
                    });
                }
                if(colIdx>=pedidosComPayment.length&&colAtivos===0) colResolve();
              };
              colNext();
            });

            for (const p of mlPedidos) {
              const net = collectionsMap[String(p.paymentId)];
              if (net != null) {
                // liquido real do MP; frete = o que sobrou além da comissão
                p.taxas.liquido = net;
                p.taxas.frete   = Math.max(0, p.valor - net - p.taxas.comissao);
              } else {
                // sem collection: estima líquido descontando só a comissão conhecida
                p.taxas.liquido = p.valor - p.taxas.comissao;
                p.taxas.frete   = 0;
              }
            }
            } catch(eTaxasML) {
              console.warn('[ML] Falha ao buscar taxas (faturamento preservado):', eTaxasML.message);
              // Sem dados de taxa: usa valor como líquido estimado
              for (const p of mlPedidos) if (p.taxas.liquido == null) p.taxas.liquido = p.valor;
            }
          }

          // ── Shopee ────────────────────────────────────────
          if (conta.marketplace==='shopee') {
            const shopId = conta.param_to_use?.shopId||conta.external_id;
            if (statusEl) statusEl.textContent=`🛒 Shopee (${conta.nickname||shopId}): listando pedidos...`;

            const snsList = await MarketplaceAPI.shopeeListOrderSns(
              shopId,
              Math.floor(tsFrom/1000),
              Math.floor(tsTo/1000)
            );

            if (!snsList.length) {
              log.push(`Shopee: 0 pedidos no período`);
              console.warn('[Shopee] Nenhum order_sn retornado para o período');
              continue;
            }

            if (statusEl) statusEl.textContent=`🛒 Shopee: detalhes (${snsList.length} pedidos)...`;

            // Detalhes em lotes de 50 — extrai dados financeiros direto do order_detail
            const uniq = [];
            for (let i=0; i<snsList.length; i+=50) {
              const lote = snsList.slice(i,i+50).map(o=>o.sn);
              try {
                const rd = await MarketplaceAPI.call('shopee_get_order_detail',{shopId, order_sn_list:lote});
                const orderList = rd.data?.response?.order_list || rd.data?.order_list || [];
                for (const ord of orderList) {
                  const totalPedido = parseFloat(ord.total_amount)||0;
                  const itemList    = ord.item_list || ord.items || [];
                  const subtotal    = itemList.reduce((s,it)=>{
                    const preco = parseFloat(it.model_discounted_price) || parseFloat(it.item_price) || 0;
                    const qtd   = parseInt(it.model_quantity_purchased)  || parseInt(it.quantity)    || 1;
                    return s + preco * qtd;
                  }, 0);

                  uniq.push({
                    id:             ord.order_sn,
                    plataforma:     'Shopee',
                    contaId:        conta.external_id,
                    dataTs:         (ord.create_time||0)*1000,
                    valor:          subtotal > 0 ? subtotal : totalPedido,
                    freteComprador: Math.max(0, totalPedido - subtotal),
                    status:         ord.order_status || '',
                    taxas:          {}, // preenchido pelo escrow abaixo
                  });
                }
              } catch(e) {
                console.warn('[Shopee] Erro ao buscar detalhes do lote', i, e.message);
              }
            }

            if (statusEl) statusEl.textContent=`🛒 Shopee: escrow (${uniq.length} pedidos COMPLETED)...`;

            // Busca escrow só para pedidos COMPLETED — sobrescreve com dados precisos
            const parseEscrow = oi => {
              // Log do primeiro escrow para diagnóstico de campos
              if (!parseEscrow._logged) {
                parseEscrow._logged = true;
                console.log('[Shopee escrow fields]', JSON.stringify(oi).substring(0, 500));
              }
              const n = v => parseFloat(v)||0;
              // Frete que sobra pro vendedor = custo real − pago pelo comprador − rebate Shopee
              const freteVendedor = Math.max(0,
                n(oi.actual_shipping_fee) - n(oi.buyer_paid_shipping_fee) - n(oi.shopee_shipping_rebate)
              );
              return {
                liquido:     n(oi.escrow_amount),
                comissao:    n(oi.commission_fee),
                taxaServico: n(oi.service_fee),
                imposto:     n(oi.seller_transaction_fee) + n(oi.buyer_tax_amount) + n(oi.seller_coin_cash_back),
                frete:       freteVendedor + n(oi.shipping_seller_protection_fee_amount),
                voucher:     n(oi.voucher_from_shopee),
              };
            };

            const completed = uniq.filter(o => (o.status||'').toUpperCase() === 'COMPLETED');
            if (completed.length) {
              for (let i=0; i<completed.length; i+=50) {
                const lote    = completed.slice(i,i+50);
                const loteSns = lote.map(o=>o.id);
                try {
                  const re = await MarketplaceAPI.call('shopee_get_escrow_detail_batch',{shopId, order_sn_list:loteSns});
                  const resultList =
                    re.data?.response?.result_list ||
                    re.data?.result_list           ||
                    (Array.isArray(re.data?.response) ? re.data.response : null) || [];
                  for (const item of resultList) {
                    const sn = item.escrow_detail?.order_sn || item.order_sn || item.result?.order_sn;
                    const oi = item.escrow_detail?.order_income || item.result?.escrow_detail?.order_income || item.order_income || {};
                    const parsed = parseEscrow(oi);
                    if (sn && parsed.liquido > 0) {
                      const ord = uniq.find(o=>o.id===sn);
                      if (ord) ord.taxas = parsed; // só as taxas — o valor de venda fica o do pedido
                    }
                  }
                } catch(e) {
                  // Batch falhou: tenta individual para pedidos COMPLETED
                  await Promise.allSettled(loteSns.map(async sn => {
                    try {
                      const re2 = await MarketplaceAPI.call('shopee_get_escrow_detail',{shopId, order_sn:sn});
                      const oi  = re2.data?.response?.escrow_detail?.order_income
                               || re2.data?.response?.order_income
                               || re2.data?.escrow_detail?.order_income
                               || re2.data?.order_income || {};
                      const parsed = parseEscrow(oi);
                      if (parsed.liquido > 0) {
                        const ord = uniq.find(o=>o.id===sn);
                        if (ord) ord.taxas = parsed;
                      }
                    } catch(e2){}
                  }));
                }
              }
            }

            // Aplica taxas: escrow para pedidos com dados, valor bruto para os sem escrow
            // IMPORTANTE: sem escrow → liquido = valor, taxas = 0 (evita inconsistência fat ≠ liquido)
            let comEscrow = 0;
            for (const o of uniq) {
              if (o.taxas.liquido > 0) {
                comEscrow++;
                // Se valor ainda é 0 mas temos líquido do escrow, recalcula valor como líquido + taxas
                if (o.valor === 0 && o.taxas.liquido > 0) {
                  const totalTaxas = (o.taxas.comissao||0) + (o.taxas.taxaServico||0) - (o.taxas.voucher||0) + (o.taxas.imposto||0);
                  o.valor = o.taxas.liquido + totalTaxas;
                  console.log(`[Shopee] Recalculado valor para pedido ${o.id}: R$ ${o.valor.toFixed(2)}`);
                }
              } else {
                // Sem escrow: usa valor como líquido estimado, sem taxas (dados incompletos)
                o.taxas = { liquido: o.valor, comissao:0, taxaServico:0, imposto:0, frete:0, voucher:0 };
              }
              pedidos.push(o);
            }
            log.push(`Shopee: ${uniq.length} pedidos (${comEscrow} com escrow)`);
            console.log(`[Shopee] ${uniq.length} pedidos, ${comEscrow} com dados de escrow`);

            // Buscar devoluções/reembolsos Shopee
            if (statusEl) statusEl.textContent = `🛒 Shopee (${conta.nickname||shopId}): buscando devoluções...`;
            try {
              const retUrl = await MarketplaceAPI.call('shopee_returns_list', { shopId, page_size: 100 });
              const returns = retUrl.data?.response?.returns || retUrl.data?.returns || [];
              if (returns.length > 0) {
                console.log(`[Shopee Returns] ${returns.length} devoluções encontradas`);
              }
            } catch(eRet) {
              console.warn('[Shopee Returns] Erro ao buscar devoluções:', eRet.message);
            }
          }

        } catch(eConta) {
          console.error('[Financeiro] Falha na conta', conta.nickname||conta.external_id, eConta);
          errosConta.push(`${conta.nickname||conta.marketplace}: ${eConta.message}`);
        }
        // Render parcial: mostra o que já foi carregado sem esperar as outras contas
        if (pedidos.length) renderConteudo();
      } // fim loop contas

      console.log('[✓] Pedidos carregados:', pedidos.length, 'pedidos. Buscando ADS e Afiliados...');

      // ── ADS: investimento + métricas detalhadas ──
      adsAPI = {};
      adsDetalhados = {};
      console.log('[ADS] Iniciando busca para', contas.length, 'contas');
      if (statusEl) statusEl.textContent = '📢 Buscando investimento em ADS...';
      for (const conta of contas) {
        try {
          if (['meli','ml','mercadolivre'].includes(conta.marketplace)) {
            try {
              const meliId = conta.param_to_use?.meliUserId||conta.external_id;
              let custo = 0, off = 0, campanhas = 0;
              while (true) {
                const ra = await MarketplaceAPI.call('ml_ads_campaigns',
                  { meliUserId: meliId, date_from: primeiroDia, date_to: dataTo, limit: 50, offset: off });
                const res = ra.data?.results || [];
                campanhas += res.length;
                custo += res.reduce((s,c)=>s+(parseFloat(c.metrics?.cost)||0), 0);
                if (res.length < 50) break;
                off += 50;
              }
              adsAPI['Mercado Livre'] = custo;

              // Puxar métricas detalhadas de ML ADS
              try {
                const det = await MarketplaceAPI.mlAdsMetricsDetailed(meliId, primeiroDia, dataTo);
                adsDetalhados['Mercado Livre'] = det;
                console.log(`[ADS] ML Detalhado:`, det);
              } catch(e) {
                console.warn('[ADS] Erro ao puxar métricas detalhadas ML:', e.message);
              }

              console.log(`[ADS] ML: R$ ${custo.toFixed(2)} (${campanhas} campanhas)`);
            } catch(eML) {
              console.error('[ADS] ML falhou:', eML.message);
            }
          }
          if (conta.marketplace==='shopee') {
            try {
              const shopId = conta.param_to_use?.shopId||conta.external_id;
              let totalCusto = 0;

              // Tentar: shopeeAdsBalance (saldo de créditos)
              try {
                const balance = await MarketplaceAPI.shopeeAdsBalance({ shopId });
                if (balance && balance.data?.balance) {
                  totalCusto = parseFloat(balance.data.balance) || 0;
                  console.log(`[ADS] Shopee Balance: R$ ${totalCusto.toFixed(2)}`);
                }
              } catch(eBalance) {
                console.warn('[ADS] Shopee Balance falhou');
              }

              // Se não conseguiu saldo, tentar Daily Performance
              if (totalCusto === 0) {
                try {
                  const perf = await MarketplaceAPI.shopeeAdsDailyPerformance({
                    shopId, start_date: primeiroDia, end_date: dataTo
                  });
                  const dias = perf?.data?.response || perf?.data || [];
                  if (Array.isArray(dias) && dias.length > 0) {
                    totalCusto = dias.reduce((s,d)=>s+(parseFloat(d.expense)||parseFloat(d.cost)||0), 0);
                    console.log(`[ADS] Shopee Daily: ${dias.length} dias, R$ ${totalCusto.toFixed(2)}`);
                  }
                } catch(ePerf) {
                  console.warn('[ADS] Shopee Daily Performance falhou:', ePerf.message);
                }
              }

              adsAPI['Shopee'] = totalCusto;

              // Puxar métricas detalhadas de Shopee ADS
              try {
                const det = await MarketplaceAPI.shopeeAdsMetricsDetailed(shopId, primeiroDia, dataTo);
                adsDetalhados['Shopee'] = det;
              } catch(e) {
                console.warn('[ADS] Shopee métricas detalhadas:', e.message);
              }

              console.log(`[ADS] Shopee: R$ ${totalCusto.toFixed(2)}`);
            } catch(eSh) {
              console.error(`[ADS] ✗ Shopee falhou:`, eSh.message, eSh);
            }
          }
        } catch(eAds) {
          console.error('[ADS] Erro geral em', conta.nickname||conta.marketplace, eAds.message);
        }
      }
      if (Object.keys(adsAPI).length === 0) {
        console.warn('[ADS] Nenhuma plataforma retornou ADS');
      }

      // ── Afiliados: comissão via API (best-effort) ──
      afiliados = {};
      if (statusEl) statusEl.textContent = '👥 Buscando dados de afiliados...';
      try {
        console.log('[Afiliados] Chamando API:', primeiroDia, 'a', dataTo);
        const af = await MarketplaceAPI.affiliateReports(primeiroDia, dataTo);
        console.log('[Afiliados] Resposta da API:', af);
        if (af.totalComissao > 0) {
          afiliados = af;
          console.log(`[Afiliados] ✓ Comissão: R$ ${af.totalComissao.toFixed(2)} | Pedidos: ${af.totalPedidos}`);
        } else {
          console.log('[Afiliados] Nenhuma comissão encontrada');
        }
      } catch(eAf) {
        console.warn('[Afiliados] ✗ Erro ao puxar dados:', eAf.message);
      }

      // ── Payout/Carteira: informações de pagamento ──
      payout = {};
      if (statusEl) statusEl.textContent = '💳 Buscando informações de payout...';
      for (const conta of contas) {
        try {
          if (conta.marketplace === 'shopee') {
            const shopId = conta.param_to_use?.shopId||conta.external_id;
            try {
              const py = await MarketplaceAPI.shopeePayout(shopId);
              if (py.bank_account_number) payout['Shopee'] = py;
            } catch(e) {}
            try {
              const wl = await MarketplaceAPI.shopeeWallet(shopId);
              if (wl.saldo != null) payout['Shopee Carteira'] = wl;
            } catch(e) {}
          }
        } catch(ePay) {
          console.warn('[Payout] Erro em', conta.nickname, ePay.message);
        }
      }

      console.log('[FLUXO] ADS e Afiliados carregados. Salvando cache...');
      console.log('[FLUXO] adsAPI:', adsAPI, '| afiliados:', afiliados);
      salvarCache();

      console.log('[FLUXO] Renderizando conteúdo...');
      if (statusEl) {
        const erroHtml = errosConta.length
          ? ` <span style="font-size:10px;background:rgba(239,68,68,0.15);color:var(--red);padding:2px 8px;border-radius:8px;">⚠️ ${errosConta.join(' · ')}</span>`
          : ` <span style="font-size:10px;background:rgba(16,185,129,0.15);color:var(--green);padding:2px 8px;border-radius:8px;">✓ salvo</span>`;
        statusEl.innerHTML = `${pedidos.length} pedidos · ${log.join(' | ')} · ${primeiroDia} a ${dataTo}${erroHtml}`;
      }
      renderConteudo();
      console.log('[FLUXO] ✓ Concluído!');

    } catch(e) {
      console.error('[Financeiro] Erro geral:', e);
      if (statusEl) statusEl.textContent=`Erro: ${e.message}`;
      if (pedidos.length) renderConteudo();
    } finally {
      buscando = false;
      if (btnEl){ btnEl.disabled=false; btnEl.textContent='🔄 Atualizar'; }
      const reprocessBtn = document.getElementById('fin-btn-reprocessar');
      if (reprocessBtn){ reprocessBtn.disabled=false; reprocessBtn.textContent='♻️ Reprocessar'; }
    }
  }

  function renderFiltroContas() {
    const sel = document.getElementById('fin-sel-conta');
    if (!sel || !contas.length) return;
    const atual = sel.value;
    sel.innerHTML = `<option value="todas">Todas</option>` +
      contas.map(c=>`<option value="${c.external_id}">${c.nickname||c.external_id}</option>`).join('');
    if ([...sel.options].some(o=>o.value===atual)) sel.value = atual;
  }

  // ── Globais ───────────────────────────────────────────────
  window.finToggle = id => {
    aberto[id] = aberto[id]===false;
    const b = document.getElementById('fin-body-'+id);
    if (b) b.style.display = aberto[id] ? 'none' : 'block';
  };
  window.finAddLinha = tipo => {
    const nome  = document.getElementById('fin-nome-'+tipo)?.value?.trim();
    const valor = parseFloat(document.getElementById('fin-valor-'+tipo)?.value);
    if (!nome || isNaN(valor)) { alert('Preencha descrição e valor.'); return; }
    manual()[tipo].push({nome, valor});
    salvarManual(); renderConteudo();
  };
  window.finRemoverLinha = (tipo,i) => {
    manual()[tipo].splice(i,1);
    salvarManual(); renderConteudo();
  };

  // ── HTML base ─────────────────────────────────────────────
  el.innerHTML = `<div class="page" style="max-width:1000px;margin:0 auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <label class="fin-switch">
          <input type="checkbox" id="fin-chk-reemb" ${incluirReemb?'checked':''}>
          <span class="fin-slider"></span>
        </label>
        <span style="font-size:13px;font-weight:600;color:var(--text-primary);">Incluir custos de produtos reembolsados</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span id="fin-status" style="font-size:11px;color:var(--text-muted);margin-right:4px;"></span>
        <button onclick="window.print()" class="btn" style="border:1px solid var(--border);background:var(--bg-card);padding:7px 14px;border-radius:99px;font-size:13px;">📥 PDF</button>
        <select id="fin-sel-conta" class="form-input" style="border-radius:99px;padding:7px 14px;width:130px;">
          <option value="todas">Todas</option>
        </select>
        <input type="month" id="fin-sel-mes" class="form-input" value="${mesSel}" style="border-radius:99px;padding:6px 14px;width:150px;">
        <button id="fin-btn-atualizar" class="btn-primary" style="padding:7px 16px;border-radius:99px;">🔄 Atualizar</button>
        <button id="fin-btn-reprocessar" class="btn-primary" style="padding:7px 16px;border-radius:99px;background:rgba(249,115,22,0.15);border:1px solid rgba(249,115,22,0.3);color:var(--orange);" title="Força reprocessamento mesmo com dados em cache">♻️ Reprocessar</button>
      </div>
    </div>
    <div id="fin-conteudo"></div>
  </div>

  <style>
    .fin-card {
      background: linear-gradient(135deg, var(--bg-card) 0%, rgba(255,255,255,0.02) 100%);
      border: 1px solid var(--border);
      border-radius: 14px;
      margin-bottom: 16px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      transition: all 0.3s ease;
    }
    .fin-card:hover {
      box-shadow: 0 8px 16px rgba(0,0,0,0.1);
      transform: translateY(-2px);
    }
    .fin-resultado {
      border-width: 2px;
      border-color: var(--accent);
      background: linear-gradient(135deg, rgba(99,102,241,0.05) 0%, rgba(255,255,255,0.02) 100%);
    }
    .fin-head {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 18px 20px;
      cursor: pointer;
      border-bottom: 1px solid rgba(0,0,0,0.05);
      background: linear-gradient(90deg, rgba(255,255,255,0.02) 0%, transparent 100%);
    }
    .fin-resumo .fin-head { border-bottom: none; }
    .fin-ico {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      color: white;
      font-size: 18px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      line-height: 1;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .fin-titulo {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
      flex: 1;
    }
    .fin-valor {
      font-size: 18px;
      font-weight: 800;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--text-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .fin-body { padding: 18px 20px; }
    .fin-grupo {
      margin-bottom: 16px;
      border-bottom: 1px solid rgba(0,0,0,0.05);
      padding-bottom: 12px;
    }
    .fin-grupo:last-child { margin-bottom: 0; border-bottom: none; padding-bottom: 0; }
    .fin-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0;
      font-size: 14px;
      color: var(--text-primary);
    }
    .fin-row span:first-child { font-weight: 600; }
    .fin-sub {
      display: flex;
      justify-content: space-between;
      padding: 8px 0 8px 20px;
      font-size: 13px;
      color: var(--text-secondary);
      border-left: 3px solid var(--accent);
      margin-left: 8px;
    }
    .fin-sub em { font-style: italic; color: var(--green); font-weight: 600; }
    .fin-sub em[style*="color:var(--red)"] { color: var(--red) !important; }
    .fin-final {
      font-weight: 700;
      color: var(--text-primary);
      border-bottom: none!important;
      border-top: 2px solid var(--accent);
      padding-top: 12px!important;
      margin-top: 6px;
      font-size: 15px;
    }
    .fin-final em { font-weight: 700; font-style: normal; color: var(--text-primary); }
    .fin-inp {
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 13px;
      padding: 8px 12px;
      text-align: right;
      width: 140px;
      outline: none;
      transition: all 0.2s ease;
    }
    .fin-inp:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
    }
    .fin-switch {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 28px;
      flex-shrink: 0;
    }
    .fin-switch input { opacity: 0; width: 0; height: 0; }
    .fin-slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background: var(--border);
      border-radius: 99px;
      transition: 0.3s;
    }
    .fin-slider:before {
      content: '';
      position: absolute;
      height: 22px;
      width: 22px;
      left: 3px;
      bottom: 3px;
      background: white;
      border-radius: 50%;
      transition: 0.3s;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .fin-switch input:checked + .fin-slider {
      background: linear-gradient(135deg, var(--green), #10b981);
    }
    .fin-switch input:checked + .fin-slider:before {
      transform: translateX(20px);
    }
    @media print {
      #sidebar,#header,.btn,.btn-primary,#fin-sel-conta,#fin-sel-mes,#fin-btn-atualizar,#fin-btn-reprocessar,#fin-status,.fin-switch{display:none!important;}
      .fin-card{break-inside:avoid;border-color:#ccc!important;background:white!important;box-shadow:none!important;}
      .fin-titulo,.fin-row,.fin-sub,.fin-final{color:#111!important;}
    }
  </style>`;

  document.getElementById('fin-chk-reemb').addEventListener('change', e=>{ incluirReemb=e.target.checked; renderConteudo(); });
  document.getElementById('fin-sel-conta').addEventListener('change', e=>{ contaSel=e.target.value; renderConteudo(); });
  document.getElementById('fin-sel-mes').addEventListener('change', e=>{
    mesSel = e.target.value;
    localStorage.setItem('glr_fin_mes', mesSel);
    const at = carregarCache();
    if (at) {
      renderConteudo();
      const s=document.getElementById('fin-status');
      if(s) s.textContent=`${pedidos.length} pedidos (cache)`;
    } else {
      buscar();
    }
  });
  document.getElementById('fin-btn-atualizar').addEventListener('click', buscar);
  document.getElementById('fin-btn-reprocessar').addEventListener('click', () => {
    forceReprocess = true;
    // Se uma conta específica está selecionada, reprocessa APENAS ela
    contaReprocess = contaSel !== 'todas' ? contaSel : null;
    if (contaSel !== 'todas') {
      console.log('[Reprocessar] Apenas conta:', contaSel);
    } else {
      console.log('[Reprocessar] Todas as contas');
    }
    buscar();
  });

  // Início: cache ou busca
  const at = carregarCache();
  if (at) {
    const s = document.getElementById('fin-status');
    if (s) s.textContent = `${pedidos.length} pedidos (cache)`;
    try {
      const r2 = await MarketplaceAPI.call('list_accounts');
      contas = r2.data?.accounts||[];
      renderFiltroContas();
    } catch(e){}
    renderConteudo();
  } else {
    buscar();
  }
});
