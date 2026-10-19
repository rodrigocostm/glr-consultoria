// ============================================================
// GLR Consultoria — Amazon (Buy Box, Promoções e Margem)
// ------------------------------------------------------------
// Na Amazon existe um anúncio por produto (ASIN) e todos os vendedores daquele
// item disputam a mesma página: o que importa é ficar com a Buy Box sem perder
// dinheiro. Três abas, com os mesmos anúncios carregados uma vez:
//  • Buy Box — preço atual × preço que ganha (amazon_price_to_win); onde perde,
//    quanto baixar e a margem nesse preço; onde não há concorrente, preço livre.
//  • Promoções — preço promocional com data (amazon_set_sale_price; cupom,
//    Lightning e Best Deal não existem na API), com a margem calculada na hora.
//  • Margem — taxa estimada da Amazon (amazon_estimate_fees) + custo + imposto,
//    do pior para o melhor.
// Sempre informa amazon_account_id e confere a conta que respondeu (com mais de
// uma conta, a API pode devolver 200 com dado de OUTRA loja).
// Custo: glr_vendas_custo_catalogo pelo título (a mesma chave da tela Vendas).
// ============================================================
Router.register('anuncios-amazon', (params, el) => {
  const R$ = v => v == null || isNaN(v) ? '—' : 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = v => v == null || !isFinite(v) ? '—' : (+v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch (e) { return d; } };
  const num = v => { const x = parseFloat(String(v ?? '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isNaN(x) ? null : x; };
  const dec = v => v == null ? '' : (+v).toFixed(2).replace('.', ',');
  const hojeIso = (d = 0) => { const x = new Date(Date.now() - 3 * 3600e3 + d * 86400e3); return x.toISOString().slice(0, 10); };
  const CACHE_H = 6;

  const st = {
    contas: [], conta: lerJSON('glr_amz_conta', '') || '', aba: lerJSON('glr_amz_aba', 'buybox') || 'buybox',
    itens: [], carregando: false, progresso: '', erro: null, busca: '', filtro: 'todos',
    margemMin: num(lerJSON('glr_amz_margem_min', 15)) ?? 15, promo: {}, aplicando: {},
  };

  // ── API (sempre com a conta + conferência de quem respondeu) ──
  const D = r => (r && r.data && typeof r.data === 'object' && r.status != null) ? r.data : r;
  async function amz(action, params) {
    const r = D(await MarketplaceAPI.call(action, { amazon_account_id: st.conta, ...params }));
    const usada = r?.conta_usada?.amazon_account_id || r?.selling_partner_id;
    if (usada && String(usada) !== String(st.conta)) throw new Error(`a Amazon respondeu pela conta ${usada} (esperado ${st.conta})`);
    return r;
  }
  async function tentar(fn, n = 3) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n - 1) throw e; await new Promise(r => setTimeout(r, 900 * (i + 1))); } } }
  async function emLotes(lista, conc, fn) { const fila = [...lista]; await Promise.all(Array.from({ length: conc }, async () => { while (fila.length) await fn(fila.shift()); })); }

  // ── Leitura de um anúncio (get_listing) ──
  function lerListing(r) {
    const sum = (r.summaries || [])[0] || {};
    const off = (r.attributes?.purchasable_offer || [])[0] || {};
    const val = k => off[k]?.[0]?.schedule?.[0]?.value_with_tax;
    const preco = parseFloat(val('our_price') ?? r.offers?.[0]?.price?.amount) || null;
    const ds = off.discounted_price?.[0]?.schedule?.[0];
    const agora = Date.now();
    const promoAtiva = ds && ds.value_with_tax != null && preco && +ds.value_with_tax < preco - 0.004
      && (!ds.start_at || Date.parse(ds.start_at) <= agora) && (!ds.end_at || Date.parse(ds.end_at) >= agora);
    return {
      tipo: sum.productType || '', imagem: sum.mainImage?.link || '', titulo: sum.itemName || '',
      preco, minimo: parseFloat(val('minimum_seller_allowed_price')) || null, maximo: parseFloat(val('maximum_seller_allowed_price')) || null,
      promo: promoAtiva ? { preco: +ds.value_with_tax, ate: ds.end_at && !String(ds.end_at).startsWith('29') ? String(ds.end_at).slice(0, 10) : null } : null,
      estoque: r.fulfillment?.[0]?.quantity ?? r.attributes?.fulfillment_availability?.[0]?.quantity ?? null,
    };
  }

  // ── Carga dos anúncios ativos da conta (cache de 6 h) ──
  async function carregar(forcar) {
    if (!st.conta) return;
    const chave = `glr_amz_cache_${st.conta}`;
    const cache = lerJSON(chave, null);
    if (!forcar && cache && Date.now() - cache.em < CACHE_H * 3600e3) { st.itens = cache.itens; render(); return; }
    st.carregando = true; st.erro = null; st.progresso = 'listando anúncios…'; render();
    try {
      const lista = [];
      let token = null;
      for (let pag = 0; pag < 50; pag++) {
        const r = await tentar(() => amz('amazon_search_listings', { status: 'BUYABLE', page_size: 20, ...(token ? { next_token: token } : {}) }));
        (r.items || []).forEach(i => lista.push({ sku: i.sku, asin: i.asin, titulo: i.title }));
        token = r.next_token || r.nextToken || null;
        st.progresso = `${lista.length} anúncios…`; render();
        if (!token) break;
      }
      // detalhe de cada anúncio (preço, tipo, estoque, promoção)
      let feitos = 0;
      await emLotes(lista, 4, async it => {
        try { Object.assign(it, lerListing(await tentar(() => amz('amazon_get_listing', { sku: it.sku }), 2)), { titulo: it.titulo }); }
        catch (e) { it.erro = e.message; }
        st.progresso = `detalhes ${++feitos}/${lista.length}…`; if (feitos % 5 === 0) render();
      });
      // preço que ganha a Buy Box (40 por chamada)
      for (let i = 0; i < lista.length; i += 40) {
        st.progresso = `Buy Box ${Math.min(i + 40, lista.length)}/${lista.length}…`; render();
        try {
          const r = await tentar(() => amz('amazon_price_to_win', { skus: lista.slice(i, i + 40).map(x => x.sku) }), 2);
          for (const p of (r.precos || [])) { const it = lista.find(x => x.sku === p.sku); if (it) { it.ganhar = p.preco_para_ganhar != null ? +p.preco_para_ganhar : null; it.bbStatus = p.status || null; } }
        } catch (e) { st.erro = 'Buy Box: ' + e.message; }
      }
      // taxa estimada da Amazon no preço atual → % aplicada nos outros preços
      feitos = 0;
      await emLotes(lista.filter(x => x.preco), 4, async it => {
        try {
          const r = await tentar(() => amz('amazon_estimate_fees', { sku: it.sku, price: it.preco }), 2);
          it.taxa = r.total_taxas != null ? +r.total_taxas : null;
          it.taxaPct = it.taxa != null && it.preco ? it.taxa / it.preco : null;
        } catch (e) { /* segue sem taxa */ }
        st.progresso = `taxas ${++feitos}…`; if (feitos % 5 === 0) render();
      });
      st.itens = lista;
      try { localStorage.setItem(chave, JSON.stringify({ em: Date.now(), itens: lista })); } catch (e) {}
    } catch (e) { st.erro = e.message; }
    finally { st.carregando = false; st.progresso = ''; render(); }
  }

  // ── Margem ──
  const custoDe = it => num(lerJSON('glr_vendas_custo_catalogo', {})[it.titulo]);
  const aliquota = () => num(lerJSON('glr_aliquotas', {})[st.conta]) || 0;
  function conta(it, preco) {
    if (!preco) return null;
    const taxa = it.taxaPct != null ? preco * it.taxaPct : null;
    const custo = custoDe(it), imposto = preco * aliquota() / 100;
    if (taxa == null || custo == null) return { taxa, custo, imposto, lucro: null, margem: null };
    const lucro = preco - taxa - custo - imposto;
    return { taxa, custo, imposto, lucro, margem: lucro / preco * 100 };
  }
  // preço que dá a margem pedida: p = custo / (1 − taxa% − imposto% − margem%)
  function precoParaMargem(it, margem) {
    const c = custoDe(it); if (c == null || it.taxaPct == null) return null;
    const den = 1 - it.taxaPct - aliquota() / 100 - margem / 100;
    return den > 0 ? Math.ceil(c / den * 100) / 100 : null;
  }
  const corMargem = m => m == null ? 'var(--text-muted)' : m < 0 ? '#dc2626' : m < st.margemMin ? '#d97706' : '#16a34a';

  // ── Situação da Buy Box ──
  function situacao(it) {
    if (it.bbStatus === 'NO_COMPETING_OFFER') return { k: 'livre', txt: 'Sem concorrente', cor: '#2a78d6' };
    if (it.ganhar != null && it.preco != null) {
      if (it.preco > it.ganhar + 0.004) return { k: 'perdendo', txt: 'Perdendo', cor: '#dc2626' };
      return { k: 'ganhando', txt: 'Ganhando', cor: '#16a34a' };
    }
    if (/WIN|WINNING|OWNER/i.test(it.bbStatus || '')) return { k: 'ganhando', txt: 'Ganhando', cor: '#16a34a' };
    return { k: 'sem', txt: it.bbStatus ? it.bbStatus.replace(/_/g, ' ').toLowerCase() : 'sem dado', cor: '#64748b' };
  }

  // ── Telas ──
  const thumb = it => it.imagem ? `<img class="az-img" src="${h(it.imagem)}" alt="" loading="lazy">` : '<span class="az-img"></span>';
  const prodCel = it => `<td><div class="az-prod">${thumb(it)}<div style="min-width:0"><div class="az-tit" title="${h(it.titulo)}">${h(it.titulo)}</div><div class="az-mut">${h(it.sku)} · ${h(it.asin || '')}${it.estoque != null ? ` · estoque ${it.estoque}` : ''}</div></div></div></td>`;
  const filtrar = lista => { const q = st.busca.toLowerCase(); return q ? lista.filter(i => `${i.titulo} ${i.sku} ${i.asin}`.toLowerCase().includes(q)) : lista; };
  const custoInput = it => `<input class="az-in ${custoDe(it) == null ? 'vazio' : ''}" inputmode="decimal" placeholder="sem custo" value="${dec(custoDe(it))}" onchange="window._azCusto('${h(it.sku)}', this.value)">`;

  function abaBuyBox() {
    const lista = filtrar(st.itens).map(it => ({ it, s: situacao(it) }));
    const n = k => lista.filter(x => x.s.k === k).length;
    const F = st.filtro;
    const ORD = { perdendo: 0, ganhando: 1, livre: 2, sem: 3 };
    const vis = lista.filter(x => F === 'todos' || x.s.k === F).sort((a, b) => ORD[a.s.k] - ORD[b.s.k]);
    const chip = (k, t, c) => `<button class="az-chip ${F === k ? 'on' : ''}" style="--c:${c}" onclick="window._azFiltro('${k}')">${t} <b>${k === 'todos' ? lista.length : n(k)}</b></button>`;
    return `<div class="az-chips">${chip('todos', 'Todos', '#64748b')}${chip('perdendo', '🔴 Perdendo', '#dc2626')}${chip('ganhando', '🟢 Ganhando', '#16a34a')}${chip('livre', '🔵 Sem concorrente', '#2a78d6')}${n('sem') ? chip('sem', 'Sem dado', '#64748b') : ''}</div>
      <div class="az-mut" style="margin-bottom:10px">O preço que ganha vem da Amazon <b>antes</b> de promoções e não é garantia: ela também pesa prazo de entrega. <b>Sem concorrente</b> = só você vende esse ASIN, o preço é seu para decidir (dá para testar subir).</div>
      <div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="az-tab">
        <thead><tr><th>Produto</th><th>Situação</th><th class="n">Seu preço</th><th class="n">Preço que ganha</th><th class="n">Margem no seu preço</th><th>O que fazer</th></tr></thead>
        <tbody>${vis.map(({ it, s }) => {
          const m = conta(it, it.preco);
          let acao = '<span class="az-mut">—</span>';
          if (s.k === 'perdendo') {
            const mg = conta(it, it.ganhar);
            acao = `Baixar para <b>${R$(it.ganhar)}</b> · margem <b style="color:${corMargem(mg?.margem)}">${mg?.margem == null ? 'sem custo' : pct(mg.margem)}</b>
              <button class="btn btn-sm btn-secondary" style="margin-left:6px" ${st.aplicando[it.sku] ? 'disabled' : ''} onclick="window._azPreco('${h(it.sku)}', ${it.ganhar})">Aplicar</button>`;
          } else if (s.k === 'livre') acao = '<span class="az-mut">Preço livre — sem disputa pela Buy Box</span>';
          else if (s.k === 'ganhando' && it.ganhar != null && it.ganhar > it.preco + 0.5) {
            // ganha com folga: dá para subir até o preço que ainda ganha
            const mg = conta(it, it.ganhar);
            acao = `Pode subir até <b>${R$(it.ganhar)}</b> · margem <b style="color:${corMargem(mg?.margem)}">${mg?.margem == null ? 'sem custo' : pct(mg.margem)}</b>
              <button class="btn btn-sm btn-secondary" style="margin-left:6px" ${st.aplicando[it.sku] ? 'disabled' : ''} onclick="window._azPreco('${h(it.sku)}', ${it.ganhar})">Aplicar</button>`;
          }
          else if (s.k === 'ganhando') acao = '<span class="az-mut">Manter</span>';
          return `<tr>${prodCel(it)}<td><span class="az-sit" style="--c:${s.cor}">${s.txt}</span></td>
            <td class="n">${R$(it.preco)}${it.promo ? `<div class="az-mut">promo ${R$(it.promo.preco)}</div>` : ''}</td>
            <td class="n">${it.ganhar != null ? R$(it.ganhar) : '—'}</td>
            <td class="n" style="color:${corMargem(m?.margem)};font-weight:700">${m?.margem == null ? '<span class="az-mut">sem custo</span>' : pct(m.margem)}</td>
            <td>${acao}</td></tr>`;
        }).join('') || `<tr><td colspan="6" class="az-vazio">${st.carregando ? '⏳ ' + h(st.progresso) : 'Nenhum anúncio neste filtro.'}</td></tr>`}</tbody></table></div></div>`;
  }

  function abaPromo() {
    const lista = filtrar(st.itens);
    return `<div class="az-mut" style="margin-bottom:10px">Na Amazon a promoção é <b>preço promocional com data</b> — o preço normal volta sozinho no fim. Cupom, Lightning Deal e Best Deal não existem na API, só no Seller Central. A margem considera a taxa estimada da Amazon, o custo do produto e o imposto da conta (${pct(aliquota())}); frete pago por você não entra.</div>
      <div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="az-tab">
        <thead><tr><th>Produto</th><th class="n">Preço</th><th class="n">Custo</th><th class="n">Preço promocional</th><th>Período</th><th class="n">Margem</th><th></th></tr></thead>
        <tbody>${lista.map(it => {
          const p = st.promo[it.sku] || {};
          const sug = precoParaMargem(it, st.margemMin);
          const preco = p.preco ?? (sug && it.preco && sug < it.preco ? sug : null);
          const m = conta(it, preco);
          const abaixoMin = preco && it.minimo && preco < it.minimo - 0.004;
          const maior = preco && it.preco && preco >= it.preco;
          return `<tr>${prodCel(it)}<td class="n">${R$(it.preco)}${it.promo ? `<div class="az-promo">em promo: ${R$(it.promo.preco)}${it.promo.ate ? ` até ${it.promo.ate.split('-').reverse().join('/')}` : ''}</div>` : ''}</td>
            <td class="n">${custoInput(it)}</td>
            <td class="n"><input class="az-in" inputmode="decimal" placeholder="${sug ? dec(sug) : '0,00'}" value="${p.preco != null ? dec(p.preco) : ''}" onchange="window._azPromoPreco('${h(it.sku)}', this.value)">
              ${sug && it.preco && sug >= it.preco ? `<div style="color:var(--red);font-size:11px">sem espaço: ${pct(st.margemMin)} de margem pede ${R$(sug)}, acima do preço</div>` : sug ? `<div class="az-mut">p/ ${pct(st.margemMin)}: ${R$(sug)}</div>` : custoDe(it) == null ? '<div class="az-mut">cadastre o custo para sugerir</div>' : ''}
              ${abaixoMin ? `<div style="color:var(--yellow);font-size:11px">abaixo do mínimo permitido (${R$(it.minimo)})</div>` : ''}${maior ? '<div style="color:var(--red);font-size:11px">precisa ser menor que o preço</div>' : ''}</td>
            <td><input type="date" class="az-in az-dt" value="${p.ini || hojeIso()}" onchange="window._azPromoData('${h(it.sku)}','ini',this.value)"> <input type="date" class="az-in az-dt" value="${p.fim || hojeIso(7)}" onchange="window._azPromoData('${h(it.sku)}','fim',this.value)"></td>
            <td class="n" style="color:${corMargem(m?.margem)};font-weight:700">${m?.margem == null ? '<span class="az-mut">—</span>' : `${pct(m.margem)}<div class="az-mut" style="font-weight:400">lucro ${R$(m.lucro)}</div>`}</td>
            <td style="white-space:nowrap">${it.promo ? `<button class="btn btn-sm btn-secondary" ${st.aplicando[it.sku] ? 'disabled' : ''} onclick="window._azTirarPromo('${h(it.sku)}')">Tirar promoção</button> ` : ''}<button class="btn btn-sm btn-primary" ${!preco || maior || st.aplicando[it.sku] ? 'disabled' : ''} onclick="window._azAplicarPromo('${h(it.sku)}')">${st.aplicando[it.sku] ? '…' : 'Aplicar'}</button></td></tr>`;
        }).join('') || `<tr><td colspan="7" class="az-vazio">${st.carregando ? '⏳ ' + h(st.progresso) : 'Nenhum anúncio.'}</td></tr>`}</tbody></table></div></div>`;
  }

  function abaMargem() {
    const lista = filtrar(st.itens).map(it => ({ it, m: conta(it, it.promo?.preco || it.preco) }))
      .sort((a, b) => (a.m?.margem ?? 999) - (b.m?.margem ?? 999));
    const comM = lista.filter(x => x.m?.margem != null);
    const neg = comM.filter(x => x.m.margem < 0).length, baixa = comM.filter(x => x.m.margem >= 0 && x.m.margem < st.margemMin).length;
    return `<div class="az-resumo">
        <div><b style="color:var(--red)">${neg}</b><span>no prejuízo</span></div>
        <div><b style="color:var(--yellow)">${baixa}</b><span>abaixo de ${pct(st.margemMin)}</span></div>
        <div><b style="color:var(--green)">${comM.length - neg - baixa}</b><span>margem boa</span></div>
        <div><b>${lista.length - comM.length}</b><span>sem custo cadastrado</span></div>
      </div>
      <div class="az-mut" style="margin-bottom:10px">Margem = preço − taxa estimada da Amazon − custo − imposto (${pct(aliquota())}). Frete pago por você (MFN) não entra. Ordem: do pior para o melhor. Preencha o custo direto na tabela — vale para Vendas, Financeiro e DRE também.</div>
      <div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="az-tab">
        <thead><tr><th>Produto</th><th class="n">Preço</th><th class="n">Taxa Amazon</th><th class="n">Custo</th><th class="n">Imposto</th><th class="n">Lucro</th><th class="n">Margem</th></tr></thead>
        <tbody>${lista.map(({ it, m }) => `<tr>${prodCel(it)}
          <td class="n">${R$(it.promo?.preco || it.preco)}${it.promo ? '<div class="az-promo">em promoção</div>' : ''}</td>
          <td class="n">${m?.taxa != null ? R$(m.taxa) : '—'}${it.taxaPct != null ? `<div class="az-mut">${pct(it.taxaPct * 100)}</div>` : ''}</td>
          <td class="n">${custoInput(it)}</td>
          <td class="n">${R$(m?.imposto)}</td>
          <td class="n" style="font-weight:700;color:${corMargem(m?.margem)}">${m?.lucro != null ? R$(m.lucro) : '—'}</td>
          <td class="n" style="font-weight:700;color:${corMargem(m?.margem)}">${m?.margem != null ? pct(m.margem) : '<span class="az-mut">sem custo</span>'}</td></tr>`).join('') || `<tr><td colspan="7" class="az-vazio">${st.carregando ? '⏳ ' + h(st.progresso) : 'Nenhum anúncio.'}</td></tr>`}</tbody></table></div></div>`;
  }

  function render() {
    const box = document.getElementById('az-root'); if (!box) return;
    if (!st.contas.length) { box.innerHTML = `<div class="card az-vazio">${st.erro ? '⚠️ ' + h(st.erro) : '⏳ Carregando contas Amazon…'}</div>`; return; }
    const ABAS = [['buybox', '🏆 Buy Box'], ['promo', '🏷️ Promoções'], ['margem', '💰 Margem']];
    const atualizado = lerJSON(`glr_amz_cache_${st.conta}`, null)?.em;
    box.innerHTML = `
      <div class="az-topo">
        <select class="az-sel" onchange="window._azConta(this.value)">${st.contas.map(c => `<option value="${h(c.id)}" ${c.id === st.conta ? 'selected' : ''}>${h(c.nome)}</option>`).join('')}</select>
        <input class="az-sel" style="min-width:240px" placeholder="Buscar produto, SKU ou ASIN…" value="${h(st.busca)}" oninput="window._azBusca(this.value)">
        <label class="az-mut">Margem mínima <input class="az-in" style="width:56px" inputmode="decimal" value="${dec(st.margemMin).replace(',00', '')}" onchange="window._azMargemMin(this.value)">%</label>
        <span style="flex:1"></span>
        <span class="az-mut">${st.carregando ? '⏳ ' + h(st.progresso) : `${st.itens.length} anúncios ativos${atualizado ? ` · atualizado ${new Date(atualizado).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}`}</span>
        <button class="btn btn-secondary btn-sm" ${st.carregando ? 'disabled' : ''} onclick="window._azRecarregar()">Atualizar</button>
      </div>
      ${st.erro ? `<div class="az-erro">⚠️ ${h(st.erro)}</div>` : ''}
      <div class="az-abas">${ABAS.map(([k, t]) => `<button class="az-aba ${st.aba === k ? 'on' : ''}" onclick="window._azAba('${k}')">${t}</button>`).join('')}</div>
      ${st.aba === 'promo' ? abaPromo() : st.aba === 'margem' ? abaMargem() : abaBuyBox()}`;
  }

  // ── Ações ──
  const itemDe = sku => st.itens.find(i => i.sku === sku);
  const salvarCache = () => { try { localStorage.setItem(`glr_amz_cache_${st.conta}`, JSON.stringify({ em: lerJSON(`glr_amz_cache_${st.conta}`, {})?.em || Date.now(), itens: st.itens })); } catch (e) {} };
  window._azConta = v => { st.conta = v; st.itens = []; try { localStorage.setItem('glr_amz_conta', JSON.stringify(v)); } catch (e) {} render(); carregar(false); };
  window._azAba = k => { st.aba = k; st.filtro = 'todos'; try { localStorage.setItem('glr_amz_aba', JSON.stringify(k)); } catch (e) {} render(); };
  window._azFiltro = k => { st.filtro = k; render(); };
  window._azBusca = v => { st.busca = v; clearTimeout(window._azT); window._azT = setTimeout(() => { render(); const b = document.querySelector('.az-topo input[placeholder^="Buscar"]'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 200); };
  window._azRecarregar = () => carregar(true);
  window._azMargemMin = v => { const n = num(v); if (n == null) return; st.margemMin = n; try { localStorage.setItem('glr_amz_margem_min', JSON.stringify(n)); } catch (e) {} render(); };
  window._azCusto = (sku, v) => {
    const it = itemDe(sku); if (!it?.titulo) return;
    const cat = lerJSON('glr_vendas_custo_catalogo', {}), n = num(v);
    if (n == null || n <= 0) delete cat[it.titulo]; else cat[it.titulo] = Math.round(n * 100) / 100;
    localStorage.setItem('glr_vendas_custo_catalogo', JSON.stringify(cat)); // sincroniza (supabase-init)
    render();
  };
  window._azPromoPreco = (sku, v) => { st.promo[sku] = { ...(st.promo[sku] || {}), preco: num(v) }; render(); };
  window._azPromoData = (sku, campo, v) => { st.promo[sku] = { ...(st.promo[sku] || {}), [campo]: v }; };
  window._azPreco = async (sku, preco) => {
    const it = itemDe(sku); if (!it?.tipo) { alert('Não sei o tipo de produto deste anúncio — clique em Atualizar e tente de novo.'); return; }
    const m = conta(it, preco);
    if (!confirm(`Mudar o preço de "${it.titulo.slice(0, 60)}" de ${R$(it.preco)} para ${R$(preco)}?${m?.margem != null ? `\nMargem nesse preço: ${pct(m.margem)}` : '\n(sem custo cadastrado: margem desconhecida)'}`)) return;
    st.aplicando[sku] = true; render();
    try { await amz('amazon_update_price', { sku, product_type: it.tipo, preco }); it.preco = preco; salvarCache(); alert('Preço enviado para a Amazon. Pode levar alguns minutos para aparecer.'); }
    catch (e) { alert('A Amazon recusou: ' + e.message); }
    finally { delete st.aplicando[sku]; render(); }
  };
  window._azAplicarPromo = async sku => {
    const it = itemDe(sku), p = st.promo[sku] || {};
    const sug = precoParaMargem(it, st.margemMin);
    const preco = p.preco ?? (sug && it.preco && sug < it.preco ? sug : null);
    const ini = p.ini || hojeIso(), fim = p.fim || hojeIso(7);
    if (!it?.tipo) { alert('Não sei o tipo de produto deste anúncio — clique em Atualizar e tente de novo.'); return; }
    if (!preco || preco >= it.preco) { alert('O preço promocional precisa ser menor que o preço atual.'); return; }
    if (fim < ini) { alert('A data de fim é antes do início.'); return; }
    const m = conta(it, preco);
    if (!confirm(`Colocar "${it.titulo.slice(0, 60)}" em promoção por ${R$(preco)} (hoje ${R$(it.preco)}) de ${ini.split('-').reverse().join('/')} a ${fim.split('-').reverse().join('/')}?${m?.margem != null ? `\nMargem: ${pct(m.margem)} (lucro ${R$(m.lucro)})` : '\n(sem custo cadastrado: margem desconhecida)'}${it.minimo && preco < it.minimo ? `\n\nAtenção: abaixo do mínimo permitido no anúncio (${R$(it.minimo)}) — a Amazon pode recusar.` : ''}`)) return;
    st.aplicando[sku] = true; render();
    try { await amz('amazon_set_sale_price', { sku, product_type: it.tipo, preco_promocional: preco, inicio: ini, fim }); it.promo = { preco, ate: fim }; delete st.promo[sku]; salvarCache(); alert('Promoção enviada para a Amazon. Pode levar alguns minutos para aparecer no anúncio.'); }
    catch (e) { alert('A Amazon recusou: ' + e.message); }
    finally { delete st.aplicando[sku]; render(); }
  };
  window._azTirarPromo = async sku => {
    const it = itemDe(sku); if (!it?.tipo) return;
    if (!confirm(`Tirar a promoção de "${it.titulo.slice(0, 60)}"? O preço volta para ${R$(it.preco)} na hora.`)) return;
    st.aplicando[sku] = true; render();
    try { await amz('amazon_remove_sale_price', { sku, product_type: it.tipo }); it.promo = null; salvarCache(); }
    catch (e) { alert('A Amazon recusou: ' + e.message); }
    finally { delete st.aplicando[sku]; render(); }
  };

  el.innerHTML = `<div class="page">
    <div style="font-size:22px;font-weight:650;letter-spacing:-0.02em;color:var(--text-primary);margin-bottom:4px">Amazon</div>
    <div class="az-mut" style="margin-bottom:16px;max-width:900px">Na Amazon todos os vendedores de um produto disputam o mesmo anúncio — o jogo é ficar com a <b>Buy Box</b> sem perder margem. Aqui você vê onde ganha e onde perde, cria promoções vendo a margem e confere a margem real de cada produto.</div>
    <div id="az-root"></div>
  </div>
  <style>
    .az-mut{font-size:12px;color:var(--text-muted)}
    .az-topo{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .az-sel{background:var(--bg-card);border:1px solid var(--border);border-radius:9px;color:var(--text-primary);padding:8px 11px;font-size:13px}
    .az-in{background:var(--bg-card-hover);border:1px solid var(--border);border-radius:7px;color:var(--text-primary);padding:6px 8px;font-size:13px;width:96px;text-align:right;font-variant-numeric:tabular-nums}
    .az-in.vazio{border-color:#dc2626}.az-in.vazio::placeholder{color:#dc2626;font-weight:700}
    .az-dt{width:132px;text-align:left}
    .az-tab .btn:disabled{opacity:.45;cursor:not-allowed}
    .az-abas{display:flex;gap:6px;margin-bottom:12px;border-bottom:1px solid var(--border)}
    .az-aba{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13.5px;font-weight:700;color:var(--text-secondary);cursor:pointer}
    .az-aba.on{color:#2a78d6;border-bottom-color:#2a78d6}
    .az-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
    .az-chip{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:4px 12px;font-size:12px;cursor:pointer}
    .az-chip.on{background:var(--c);border-color:var(--c);color:#fff}
    .az-tab{width:100%;border-collapse:collapse;font-size:13px}
    .az-tab th{padding:10px 12px;text-align:left;font-size:10.5px;text-transform:uppercase;color:var(--text-secondary);background:var(--bg-card-hover);white-space:nowrap}
    .az-tab td{padding:9px 12px;border-bottom:1px solid var(--border);color:var(--text-secondary);vertical-align:middle}
    .az-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    .az-prod{display:flex;gap:10px;align-items:center;min-width:260px;max-width:420px}
    .az-img{width:40px;height:40px;border-radius:8px;object-fit:cover;flex:none;background:var(--bg-card-hover);display:block}
    .az-tit{font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .az-sit{display:inline-block;font-size:11px;font-weight:800;color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent);padding:3px 9px;border-radius:99px;white-space:nowrap}
    .az-promo{font-size:11px;color:#d97706;font-weight:700}
    .az-vazio{padding:28px;text-align:center;color:var(--text-muted)}
    .az-erro{background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.3);color:#dc2626;border-radius:10px;padding:8px 12px;font-size:12.5px;margin-bottom:10px}
    .az-resumo{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:10px}
    .az-resumo>div{background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:10px 14px;display:flex;flex-direction:column}
    .az-resumo b{font-size:22px;font-variant-numeric:tabular-nums}.az-resumo span{font-size:11.5px;color:var(--text-muted)}
  </style>`;

  render();
  // Contas Amazon conectadas (nome pela etiqueta da conta)
  (async () => {
    try {
      const lista = await MarketplaceAPI.listAccounts();
      st.contas = (lista || []).filter(c => String(c.marketplace).toLowerCase() === 'amazon').map(c => ({
        id: String(c.param_to_use?.amazon_account_id || c.external_id),
        nome: c.tags?.find?.(t => t?.name)?.name || c.nickname || c.external_id,
      })).sort((a, b) => a.nome.localeCompare(b.nome));
      if (!st.contas.length) { st.erro = 'Nenhuma conta Amazon conectada.'; render(); return; }
      if (!st.contas.some(c => c.id === st.conta)) st.conta = st.contas[0].id;
      render();
      carregar(false);
    } catch (e) { st.erro = 'Não consegui listar as contas: ' + e.message; render(); }
  })();
});
