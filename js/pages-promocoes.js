// ============================================================
// GLR Consultoria — Central de Promoções
// Primeira versão: só Mercado Livre (Shopee fica pra depois).
// ============================================================
(function() {

let contasSel  = [];   // contas ML carregadas
let contaAtual = null; // conta selecionada
let promocoes  = [];   // últimas promoções buscadas

let abaPromo = (() => { try { return localStorage.getItem('glr_promo_aba') || 'auto'; } catch (e) { return 'auto'; } })();

function renderPage(params, container) {
  container.innerHTML = `<div id="promo-root" style="padding:24px;max-width:1400px;margin:0 auto;"></div>`;
  renderShell();
  carregarContas();
}

function renderShell() {
  const root = document.getElementById('promo-root');
  if (!root) return;
  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:24px;">
      <div>
        <h2 style="font-size:20px;font-weight:700;color:var(--text-primary);margin:0;">🏷️ Central de Promoções</h2>
        <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 0;">Mercado Livre — promoções por anúncio com a margem real, campanhas e cupons</p>
      </div>
      <select id="promo-sel-conta" class="form-input" style="border-radius:99px;padding:7px 14px;min-width:200px;">
        <option value="">Carregando contas...</option>
      </select>
    </div>
    <div class="pm-abas">
      <button id="pm-aba-auto" class="pm-aba ${abaPromo === 'auto' ? 'on' : ''}" onclick="window._pmAba('auto')">⚡ Promoções por anúncio</button>
      <button id="pm-aba-camp" class="pm-aba ${abaPromo === 'camp' ? 'on' : ''}" onclick="window._pmAba('camp')">📣 Campanhas e cupons</button>
    </div>
    <div id="pm-auto" style="${abaPromo === 'auto' ? '' : 'display:none'}"></div>
    <div id="promo-body" style="${abaPromo === 'camp' ? '' : 'display:none'}">
      <div style="text-align:center;padding:80px;color:var(--text-secondary);">
        <div style="font-size:48px;margin-bottom:12px;">🏷️</div>
        <div style="font-size:16px;font-weight:600;">Selecione uma conta Mercado Livre</div>
      </div>
    </div>
  `;
}

async function carregarContas() {
  try {
    let contas = [];
    try {
      contas = await MarketplaceAPI.listAccounts();
      localStorage.setItem('glr_mc_accounts', JSON.stringify(contas));
    } catch(e) {
      const raw = localStorage.getItem('glr_mc_accounts');
      contas = raw ? JSON.parse(raw) : [];
    }
    contasSel = contas.filter(c => ['mercadolivre','ml','meli'].includes(c.marketplace));

    const nicks = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();
    const nomeConta = c => {
      const tag = c.tags?.[0]?.name || '';
      return nicks[c.external_id] || tag || c.nickname || c.name || c.external_id;
    };

    const sel = document.getElementById('promo-sel-conta');
    if (!sel) return;
    sel.innerHTML = `<option value="">— Selecione a conta —</option>` +
      contasSel.map((c, i) => `<option value="${i}">🟡 ${nomeConta(c)}</option>`).join('');

    sel.addEventListener('change', e => {
      const idx = parseInt(e.target.value);
      contaAtual = isNaN(idx) ? null : contasSel[idx];
      if (contaAtual) {
        try { localStorage.setItem('glr_promo_ultima_conta', contaAtual.external_id); } catch(e2) {}
        buscarPromocoes();
        PM.carregar(false);
      } else {
        renderVazio();
        PM.limpar();
      }
    });

    try {
      const ultimaId = localStorage.getItem('glr_promo_ultima_conta');
      if (ultimaId) {
        const idx = contasSel.findIndex(c => String(c.external_id) === String(ultimaId));
        if (idx >= 0) {
          sel.value = String(idx);
          contaAtual = contasSel[idx];
          buscarPromocoes();
          PM.carregar(false);
        }
      }
    } catch(e2) {}
  } catch(e) {
    console.warn('[Promo] Erro ao carregar contas:', e.message);
  }
}


// ============================================================
// Promoções por anúncio, batendo na margem
// ------------------------------------------------------------
// Para cada anúncio ativo: promoções em que ele pode entrar (ml_item_promotions,
// com faixa de preço permitida e preço sugerido pelo ML), preço, "você recebe"
// e MARGEM real, com a mesma conta de Vendas:
//   recebe = preço − tarifa de venda do ML naquele preço (ml_listing_fees) − frete
//   lucro  = recebe − custo do produto − imposto da conta − despesas extras de Vendas
// Custo: catálogo de Vendas (glr_vendas_custo_catalogo, chave = id do anúncio);
// se faltar, a linha pede o custo e salva no MESMO catálogo (vale em Vendas).
// Frete: o custo EXATO que o ML cobra do vendedor naquele preço
// (/users/{id}/shipping_options/free?item_id&item_price) — varia por faixa de
// preço (ex.: R$ 10,05 a R$ 40, R$ 49,75 a R$ 100, R$ 70,95 a R$ 212), então é
// consultado em cada preço avaliado. Sem média, sem estimativa.
// ============================================================
const PM = (() => {
  const TIPO = { LIGHTNING: 'Relâmpago', PRICE_DISCOUNT: 'Desconto próprio', DEAL: 'Campanha ML', SELLER_CAMPAIGN: 'Campanha própria', SMART: 'Oferta inteligente', PRICE_MATCHING: 'Preço competitivo', DOD: 'Oferta do dia', MARKETPLACE_CAMPAIGN: 'Campanha ML', UNHEALTHY_STOCK: 'Estoque parado', VOLUME: 'Desconto por volume', PRE_NEGOTIATED: 'Pré-negociada' };
  const PRECO_FIXO = new Set(['SMART', 'PRICE_MATCHING', 'PRE_NEGOTIATED', 'UNHEALTHY_STOCK']); // preço definido pelo ML
  let st = { conta: null, carregando: false, progresso: '', itens: [], erro: null, filtro: 'todos', escolha: {}, aplicando: {}, resultado: {}, emLote: false };
  const taxaCache = {}; // `${cat}|${tipo}|${preço<79 ? preço : 'pct'}` → { pct, fixo }
  const freteCache = {}; // `${item}|${preço}` → custo do frete para o vendedor
  const R = v => (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const meliDe = c => String(c.param_to_use?.meliUserId || c.external_id);
  const margemMin = () => { const v = parseFloat(lerJSON('glr_promo_margem_min', {})[contaAtual?.external_id]); return isNaN(v) ? 15 : v; };

  async function tentar(fn, n = 3) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) { if (i >= n - 1 || /404|not.?found/i.test(e.message)) throw e; await new Promise(r => setTimeout(r, 700 * (i + 1))); }
    }
  }
  async function mapLimit(lista, lim, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(lim, lista.length) }, async () => { while (i < lista.length) { const k = i++; await fn(lista[k], k); } }));
  }

  // Tarifa de venda do ML num preço: % (por categoria/tipo de anúncio) + fixo (abaixo de R$ 79)
  async function taxa(it, preco) {
    const k = `${it.cat}|${it.tipo}|${preco < 79 ? preco.toFixed(2) : 'pct'}`;
    if (!taxaCache[k]) {
      const r = await tentar(() => MarketplaceAPI.call('ml_listing_fees', { meliUserId: st.meli, price: preco, category_id: it.cat, listing_type_id: it.tipo }));
      const d = r?.data || r || {};
      taxaCache[k] = { pct: parseFloat(d.sale_fee_details?.percentage_fee) || 0, fixo: parseFloat(d.sale_fee_details?.fixed_fee) || 0 };
    }
    return taxaCache[k];
  }

  // Frete exato cobrado do vendedor no preço (anúncio fora do Mercado Envios = 0)
  async function frete(it, preco) {
    if (!it.mercadoEnvios) return 0;
    const k = `${it.id}|${preco.toFixed(2)}`;
    if (freteCache[k] == null) {
      const r = await tentar(() => MarketplaceAPI.call('raw', { method: 'GET', path: `/users/${st.meli}/shipping_options/free?item_id=${it.id}&item_price=${preco.toFixed(2)}`, meliUserId: st.meli }));
      const v = parseFloat((r?.data || r)?.coverage?.all_country?.list_cost);
      if (isNaN(v)) throw new Error('o ML não informou o frete deste anúncio');
      freteCache[k] = v;
    }
    return freteCache[k];
  }
  async function custosNoPreco(it, preco) { const [tx, fr] = await Promise.all([taxa(it, preco), frete(it, preco)]); return { tx, fr }; }

  // Despesas que Vendas aplica a todo pedido (imposto da conta + linhas extras)
  function despesas() {
    const aliq = parseFloat(lerJSON('glr_aliquotas', {})[contaAtual.external_id]) || 0;
    let pct = 0, fixo = 0;
    for (const l of lerJSON('glr_vendas_linhas', [])) { if (l.tipo === 'pct') pct += parseFloat(l.valor) || 0; else fixo += parseFloat(l.valor) || 0; }
    return { imp: aliq, extraPct: pct, extraFixo: fixo };
  }
  function custoDe(id) { const v = parseFloat(lerJSON('glr_vendas_custo_catalogo', {})[id]); return v > 0 ? v : null; }

  // Conta completa num preço (síncrona: a tarifa já foi buscada antes)
  function conta(it, preco, tx, frete) {
    const tarifa = preco * tx.pct / 100 + tx.fixo;
    const recebe = preco - tarifa - frete;
    const d = despesas();
    const custo = custoDe(it.id);
    if (custo == null) return { preco, tarifa, frete, recebe, custo: null, lucro: null, margem: null };
    const lucro = recebe - custo - preco * (d.imp + d.extraPct) / 100 - d.extraFixo;
    return { preco, tarifa, frete, recebe, custo, lucro, margem: preco > 0 ? lucro / preco * 100 : null };
  }
  // Menor preço que bate a margem m, com a tarifa e o frete DAQUELE preço:
  // resolve, consulta tarifa/frete no novo preço e repete até estabilizar.
  async function precoParaMargem(it, m, inicial) {
    const custo = custoDe(it.id); if (custo == null) return null;
    const d = despesas();
    let preco = inicial;
    for (let i = 0; i < 5; i++) {
      const { tx, fr } = await custosNoPreco(it, preco);
      const den = 1 - (tx.pct + d.imp + d.extraPct + m) / 100;
      if (den <= 0) return Infinity;
      const novo = Math.ceil((custo + fr + tx.fixo + d.extraFixo) / den * 100) / 100;
      if (Math.abs(novo - preco) < 0.01) return novo;
      preco = novo;
    }
    return preco;
  }

  // Avalia cada promoção candidata: preço recomendado e se bate a margem
  async function avaliar(it) {
    const m = margemMin();
    it.opcoes = [];
    for (const p of it.promos.filter(p => p.status === 'candidate')) {
      const min = parseFloat(p.min_discounted_price) || 0, max = parseFloat(p.max_discounted_price) || it.preco;
      const fixo = PRECO_FIXO.has(p.type) && parseFloat(p.price) > 0;
      const sug = fixo ? parseFloat(p.price) : (parseFloat(p.suggested_discounted_price) || parseFloat(p.price) || max);
      const avaliarEm = async pr => { const { tx, fr } = await custosNoPreco(it, pr); return conta(it, pr, tx, fr); };
      let preco = sug, r = await avaliarEm(sug), motivo = 'preço sugerido pelo ML';
      if (!fixo && r.margem != null && r.margem < m) {
        const alvo = await precoParaMargem(it, m, sug);
        if (alvo != null && alvo <= max) {
          preco = Math.max(min, alvo);
          r = await avaliarEm(preco);
          // faixa de frete pode subir no preço novo: sobe de 1% em 1% até bater (sem passar do máximo)
          for (let i = 0; i < 6 && r.margem < m && preco < max; i++) { preco = Math.min(max, Math.ceil(preco * 1.01 * 100) / 100); r = await avaliarEm(preco); }
          motivo = 'ajustado para bater a margem';
        }
        if (!(r.margem >= m)) {
          // Não deu para bater: mostra o preço com a MELHOR margem possível nessa promoção.
          // O frete muda por faixa (ex.: R$ 11,45 abaixo de R$ 79 e R$ 49,75 acima), então
          // testa também logo abaixo da virada — o menor desconto nem sempre é o melhor.
          const testes = [{ preco, r, motivo }, { preco: sug, r: await avaliarEm(sug), motivo: 'preço sugerido pelo ML' }, { preco: max, r: await avaliarEm(max), motivo: 'menor desconto permitido' }];
          if (78.99 >= min && 78.99 <= max) testes.push({ preco: 78.99, r: await avaliarEm(78.99), motivo: 'abaixo de R$ 79 (frete menor)' });
          const melhorT = testes.reduce((a, t) => (t.r.margem ?? -Infinity) > (a.r.margem ?? -Infinity) ? t : a);
          ({ preco, r } = melhorT); motivo = `${melhorT.motivo} — melhor margem possível, abaixo da mínima`;
        }
      }
      it.opcoes.push({ promo: p, preco, ...r, bate: r.margem != null && r.margem >= m - 0.01, motivo, desconto: it.preco > 0 ? (1 - preco / it.preco) * 100 : 0 });
    }
    // Em vigor
    const ativa = it.promos.find(p => p.status === 'started' && parseFloat(p.price) > 0);
    if (ativa) { const pr = parseFloat(ativa.price); const { tx, fr } = await custosNoPreco(it, pr); it.ativa = { promo: ativa, ...conta(it, pr, tx, fr) }; } else it.ativa = null;
    // Padrão: a que bate a margem com o menor preço (mais competitiva); depois a de maior margem
    const ordem = [...it.opcoes].sort((a, b) => (b.bate - a.bate) || (a.bate ? a.preco - b.preco : (b.margem ?? -999) - (a.margem ?? -999)));
    it.melhor = ordem[0] || null;
    if (st.escolha[it.id] == null || !it.opcoes[st.escolha[it.id]]) st.escolha[it.id] = it.melhor ? it.opcoes.indexOf(it.melhor) : -1;
  }

  async function carregar(forcar) {
    if (!contaAtual) return;
    const meli = meliDe(contaAtual);
    const chave = `glr_promo_cache_${meli}`;
    if (!forcar) {
      const c = lerJSON(chave, null);
      if (c && Date.now() - c.em < 30 * 60000 && st.conta !== meli) {
        Object.assign(st, { conta: meli, meli, itens: c.itens, erro: null, escolha: {}, resultado: {} });
        Object.assign(taxaCache, c.taxas || {}); Object.assign(freteCache, c.fretes || {});
        await mapLimit(st.itens, 4, async it => { try { await avaliar(it); } catch (e) { it.erroPromo = e.message; it.opcoes = []; } });
        render(); return;
      }
    }
    Object.assign(st, { conta: meli, meli, carregando: true, erro: null, itens: [], escolha: {}, resultado: {}, progresso: 'listando anúncios ativos…' });
    render();
    try {
      // 1) anúncios ativos (corpo completo: categoria, tipo, frete, foto, estoque)
      const anuncios = [];
      for (let off = 0; off < 3000; off += 100) {
        const r = await tentar(() => MarketplaceAPI.call('list_items', { meliUserId: meli, status: 'active', limit: 100, offset: off }));
        const lote = r?.results || r?.data?.results || [];
        for (const e of lote) { const b = e && typeof e === 'object' ? (e.body || e) : null; if (b?.id) anuncios.push(b); }
        if (lote.length < 100) break;
      }
      // 3) promoções de cada anúncio + frete estimado de quem não tem histórico
      st.itens = anuncios.map(b => ({
        id: b.id, titulo: b.title, foto: (b.thumbnail || '').replace(/^http:/, 'https:'), link: b.permalink, preco: parseFloat(b.price) || 0,
        estoque: b.available_quantity, vendidos: b.sold_quantity, cat: b.category_id, tipo: b.listing_type_id || 'gold_special',
        // Mercado Envios (me2, inclui Full): o ML cobra o frete do vendedor; fora dele, frete = 0
        mercadoEnvios: String(b.shipping?.mode || 'me2') === 'me2', promos: [],
      }));
      let feitos = 0;
      await mapLimit(st.itens, 5, async it => {
        try { const r = await tentar(() => MarketplaceAPI.call('ml_item_promotions', { meliUserId: meli, item_id: it.id })); it.promos = r?.items || r?.data?.items || (Array.isArray(r?.data) ? r.data : []) || []; }
        catch (e) { it.erroPromo = e.message; }
        feitos++;
        if (feitos % 5 === 0) { st.progresso = `promoções e custos: ${feitos}/${st.itens.length} anúncios`; render(); }
      });
      st.progresso = 'calculando margens…'; render();
      await mapLimit(st.itens, 4, async it => { try { await avaliar(it); } catch (e) { it.erroPromo = e.message; it.opcoes = []; } });
      try { localStorage.setItem(chave, JSON.stringify({ em: Date.now(), itens: st.itens.map(({ opcoes, melhor, ativa, ...x }) => x), taxas: taxaCache, fretes: freteCache })); } catch (e) {}
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false;
    render();
  }

  // Aplica a promoção escolhida de um anúncio
  async function aplicar(id, silencioso) {
    const it = st.itens.find(x => x.id === id); if (!it) return false;
    const op = it.opcoes[st.escolha[id]]; if (!op) return false;
    const p = op.promo;
    st.aplicando[id] = true; if (!silencioso) render();
    try {
      const base = { meliUserId: st.meli, promotion_type: p.type };
      let params;
      if (p.type === 'PRICE_DISCOUNT') {
        const fmt = d => d.toISOString().slice(0, 19);
        const ini = new Date(Date.now() - 3 * 3600000 + 5 * 60000), fim = new Date(ini.getTime() + 13 * 86400000);
        params = { ...base, items: [id], deal_price: op.preco, start_date: fmt(ini), finish_date: fmt(fim) };
      } else if (PRECO_FIXO.has(p.type)) {
        params = { ...base, promotion_id: p.id, items: [{ id, offer_id: p.ref_id }] };
      } else {
        params = { ...base, promotion_id: p.id, items: [{ id, deal_price: op.preco, ...(p.ref_id ? { offer_id: p.ref_id } : {}) }] };
      }
      const r = await MarketplaceAPI.call('ml_add_promotion_items', params);
      const res = (r?.results || r?.data?.results || [])[0] || {};
      if (res.error || res.erro) throw new Error(res.error || res.erro);
      const aplicado = parseFloat(res.aplicado?.price) || op.preco;
      st.resultado[id] = { ok: true, txt: `Aplicado: ${TIPO[p.type] || p.type} a ${R(aplicado)}${res.atencao ? ` — ${res.atencao}` : ''}` };
      p.status = 'started'; p.price = aplicado;
      await avaliar(it);
      return true;
    } catch (e) {
      st.resultado[id] = { ok: false, txt: `Não aplicou: ${e.message}` };
      return false;
    } finally { st.aplicando[id] = false; if (!silencioso) render(); }
  }

  async function aplicarLote() {
    const alvo = st.itens.filter(it => { const op = it.opcoes?.[st.escolha[it.id]]; return op && op.bate && !it.ativa && op.promo.type !== 'LIGHTNING'; });
    if (!alvo.length) { alert('Nenhum anúncio com promoção escolhida que bata a margem (relâmpago fica de fora do lote).'); return; }
    if (!confirm(`Aplicar a promoção escolhida em ${alvo.length} anúncio(s) que batem a margem mínima de ${margemMin()}%?\n\n${alvo.slice(0, 12).map(it => `• ${it.titulo.slice(0, 45)} → ${R(it.opcoes[st.escolha[it.id]].preco)}`).join('\n')}${alvo.length > 12 ? `\n… e mais ${alvo.length - 12}` : ''}`)) return;
    st.emLote = true; let ok = 0;
    for (let i = 0; i < alvo.length; i++) { st.progresso = `aplicando ${i + 1}/${alvo.length}…`; render(); if (await aplicar(alvo[i].id, true)) ok++; }
    st.emLote = false; st.progresso = '';
    render();
    alert(`${ok} de ${alvo.length} promoção(ões) aplicada(s). Veja o resultado em cada linha.`);
  }

  function salvarCusto(id, valor) {
    const v = parseFloat(String(valor).replace(/\./g, '').replace(',', '.'));
    const cat = lerJSON('glr_vendas_custo_catalogo', {}); // relê antes de gravar: não apaga custo salvo em outra tela
    if (isNaN(v) || v <= 0) delete cat[id]; else cat[id] = v;
    localStorage.setItem('glr_vendas_custo_catalogo', JSON.stringify(cat)); // espelha no banco → vale em Vendas
    const it = st.itens.find(x => x.id === id);
    if (it) avaliar(it).catch(e => { it.erroPromo = e.message; }).then(render);
  }

  function render() {
    const box = document.getElementById('pm-auto');
    if (!box) return;
    if (!contaAtual) { box.innerHTML = ''; return; }
    if (st.erro) { box.innerHTML = `<div class="card" style="padding:24px;color:#dc2626;">Erro: ${h(st.erro)} <button class="btn btn-secondary btn-sm" onclick="window._pmAtualizar()">Tentar de novo</button></div>`; return; }
    const m = margemMin(), d = despesas();
    const itens = st.itens;
    const semCusto = itens.filter(it => custoDe(it.id) == null);
    const batem = itens.filter(it => it.melhor?.bate && !it.ativa);
    const emPromo = itens.filter(it => it.ativa);
    const abaixo = itens.filter(it => custoDe(it.id) != null && it.opcoes?.length && !it.melhor?.bate);
    const F = { todos: itens, batem, abaixo, semcusto: semCusto, ativa: emPromo };
    const lista = (F[st.filtro] || itens).slice().sort((a, b) => (b.vendidos || 0) - (a.vendidos || 0));
    const corM = mg => mg == null ? 'var(--text-muted)' : mg >= m ? '#16a34a' : mg >= 0 ? '#d97706' : '#dc2626';
    const chipM = mg => mg == null ? '<span class="pm-chip" style="--c:#64748b">sem custo</span>' : `<span class="pm-chip" style="--c:${corM(mg)}">${mg.toFixed(1).replace('.', ',')}%</span>`;
    const card = (k, rot, n, sub, cor) => `<button class="pm-card ${st.filtro === k ? 'on' : ''}" style="--c:${cor}" onclick="window._pmFiltro('${k}')"><span class="pm-rot">${rot}</span><b>${n}</b><span class="pm-sub">${sub}</span></button>`;

    box.innerHTML = `
      <div class="pm-config card">
        <label>Margem mínima <input id="pm-mmin" type="number" step="0.5" value="${m}" onchange="window._pmMargem(this.value)">%</label>
        <span class="pm-mut">Imposto da conta: <b>${d.imp ? d.imp.toString().replace('.', ',') + '%' : 'não definido'}</b>${d.extraPct || d.extraFixo ? ` · despesas extras de Vendas: ${d.extraPct ? d.extraPct + '%' : ''}${d.extraPct && d.extraFixo ? ' + ' : ''}${d.extraFixo ? R(d.extraFixo) + '/pedido' : ''}` : ''}</span>
        <span class="pm-mut" style="flex:1">Margem = (preço − tarifa ML − frete do ML naquele preço − custo − imposto − despesas) ÷ preço</span>
        <button class="btn btn-secondary btn-sm" ${st.carregando ? 'disabled' : ''} onclick="window._pmAtualizar()">🔄 Atualizar</button>
      </div>
      ${st.carregando || st.emLote ? `<div class="pm-prog">⏳ ${h(st.progresso)}</div>` : ''}
      ${itens.length ? `
      <div class="pm-cards">
        ${card('todos', 'Anúncios ativos', itens.length, 'com promoções avaliadas', '#2a78d6')}
        ${card('batem', 'Batem a margem', batem.length, `promoção disponível ≥ ${m}%`, '#16a34a')}
        ${card('abaixo', 'Abaixo da margem', abaixo.length, 'nenhuma promoção dá a margem', '#d97706')}
        ${card('semcusto', 'Sem custo', semCusto.length, 'cadastre para ver a margem', '#dc2626')}
        ${card('ativa', 'Em promoção', emPromo.length, 'promoção em vigor', '#64748b')}
      </div>
      <div class="pm-acoes">
        <span class="pm-mut">${lista.length} anúncio(s) · ordenado por vendas</span>
        <button class="btn btn-primary btn-sm" ${st.carregando || st.emLote || !batem.length ? 'disabled' : ''} onclick="window._pmAplicarLote()">⚡ Aplicar em todos que batem a margem (${batem.length})</button>
      </div>
      <div class="card" style="padding:0;overflow:hidden;"><div style="overflow-x:auto;">
        <table class="pm-tab">
          <thead><tr><th>Anúncio</th><th>Custo do produto</th><th>Em vigor</th><th>Promoção (preço recomendado)</th><th class="pm-n">Você recebe</th><th class="pm-n">Margem</th><th></th></tr></thead>
          <tbody>${lista.map(it => {
            const custo = custoDe(it.id), op = it.opcoes?.[st.escolha[it.id]], res = st.resultado[it.id];
            return `<tr>
              <td class="pm-anuncio"><img src="${h(it.foto)}" alt="" loading="lazy"><div><a href="${h(it.link)}" target="_blank" rel="noopener">${h(it.titulo)}</a>
                <div class="pm-mut">${h(it.id)} · ${R(it.preco)} · ${it.estoque ?? '—'} em estoque · ${it.vendidos || 0} vendidos</div>
                <div class="pm-mut">${it.mercadoEnvios ? 'Frete: valor exato do ML no preço da promoção' : 'Fora do Mercado Envios: sem frete do ML'}</div></div></td>
              <td>${custo != null
                ? `<div class="pm-custo"><b>${R(custo)}</b><button class="pm-lapis" title="Alterar custo" onclick="window._pmEditarCusto('${it.id}')">✎</button></div>`
                : `<div class="pm-sem">⚠️ sem custo<input class="pm-inp" placeholder="R$ custo" onkeydown="if(event.key==='Enter')window._pmCusto('${it.id}',this.value)" onchange="window._pmCusto('${it.id}',this.value)"></div><div class="pm-mut">salva também em Vendas</div>`}</td>
              <td>${it.ativa ? `<div class="pm-mut">${h(TIPO[it.ativa.promo.type] || it.ativa.promo.type)}</div><b>${R(it.ativa.preco)}</b> ${chipM(it.ativa.margem)}` : '<span class="pm-mut">—</span>'}</td>
              <td>${it.erroPromo ? `<span class="pm-mut" style="color:#dc2626">erro ao buscar: ${h(it.erroPromo)}</span>` : it.opcoes?.length ? `<select class="pm-sel" onchange="window._pmEscolha('${it.id}',this.value)">${it.opcoes.map((o, i) => `<option value="${i}" ${i === st.escolha[it.id] ? 'selected' : ''}>${o.bate ? '✅' : o.margem == null ? '•' : '⚠️'} ${h(TIPO[o.promo.type] || o.promo.type)}${o.promo.name ? ' · ' + h(o.promo.name) : ''} — ${R(o.preco)} (−${o.desconto.toFixed(0)}%)</option>`).join('')}</select>${op ? `<div class="pm-mut">${h(op.motivo)}${op.promo.finish_date ? ` · até ${new Date(op.promo.finish_date).toLocaleDateString('pt-BR')}` : ''}</div>` : ''}` : '<span class="pm-mut">sem promoção disponível</span>'}</td>
              <td class="pm-n">${op ? `<b>${R(op.recebe)}</b><div class="pm-mut">tarifa ${R(op.tarifa)}${op.frete ? ` · frete ${R(op.frete)}` : ''}</div>` : '—'}</td>
              <td class="pm-n">${op ? chipM(op.margem) + (op.lucro != null ? `<div class="pm-mut">lucro ${R(op.lucro)}</div>` : '') : '—'}</td>
              <td>${op ? `<button class="btn btn-sm ${op.bate ? 'btn-primary' : 'btn-secondary'}" ${st.aplicando[it.id] || st.emLote ? 'disabled' : ''} onclick="window._pmAplicar('${it.id}')" title="${op.bate ? 'Bate a margem mínima' : 'Fica abaixo da margem mínima'}">${st.aplicando[it.id] ? '⏳' : 'Aplicar'}</button>` : ''}
                ${res ? `<div class="pm-res" style="color:${res.ok ? '#16a34a' : '#dc2626'}">${h(res.txt)}</div>` : ''}</td>
            </tr>`;
          }).join('') || '<tr><td colspan="7" class="pm-mut" style="padding:24px;text-align:center">Nada neste filtro.</td></tr>'}</tbody>
        </table>
      </div></div>` : st.carregando ? '' : '<div class="card pm-mut" style="padding:30px;text-align:center">Nenhum anúncio ativo encontrado.</div>'}
      <style>
        .pm-abas{display:flex;gap:6px;margin-bottom:16px;}
        .pm-aba{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;}
        .pm-aba.on{background:#2a78d6;border-color:#2a78d6;color:#fff;}
        .pm-mut{font-size:11.5px;color:var(--text-muted);}
        .pm-config{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:12px 16px;margin-bottom:14px;font-size:13px;color:var(--text-secondary);}
        .pm-config input{width:64px;margin:0 4px;background:var(--bg-card-hover);border:1px solid var(--border);border-radius:7px;color:var(--text-primary);padding:4px 6px;font-weight:700;}
        .pm-prog{font-size:13px;color:var(--text-secondary);margin-bottom:12px;}
        .pm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:12px;}
        .pm-card{text-align:left;background:var(--bg-card);border:1px solid var(--border);border-left:4px solid var(--c);border-radius:12px;padding:10px 14px;cursor:pointer;display:flex;flex-direction:column;gap:1px;}
        .pm-card.on{box-shadow:0 0 0 2px var(--c);}
        .pm-card b{font-size:22px;color:var(--text-primary);font-variant-numeric:tabular-nums;}
        .pm-rot{font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:600;}
        .pm-sub{font-size:11.5px;color:var(--text-muted);}
        .pm-acoes{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;}
        .pm-tab{width:100%;border-collapse:collapse;font-size:12.5px;}
        .pm-tab th{padding:10px;text-align:left;font-size:10.5px;text-transform:uppercase;color:var(--text-secondary);background:var(--bg-card-hover);white-space:nowrap;}
        .pm-tab td{padding:10px;border-bottom:1px solid var(--border);vertical-align:top;color:var(--text-secondary);}
        .pm-n{text-align:right !important;white-space:nowrap;font-variant-numeric:tabular-nums;}
        .pm-anuncio{display:flex;gap:10px;min-width:300px;max-width:420px;}
        .pm-anuncio img{width:48px;height:48px;border-radius:8px;object-fit:cover;flex:none;background:var(--bg-card-hover);}
        .pm-anuncio a{color:var(--text-primary);font-weight:600;text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
        .pm-chip{display:inline-block;font-weight:800;font-size:12px;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);padding:2px 8px;border-radius:99px;}
        .pm-sem{color:#dc2626;font-weight:700;font-size:12px;display:flex;flex-direction:column;gap:4px;}
        .pm-inp{width:110px;background:var(--bg-card-hover);border:1px solid #dc2626;border-radius:7px;color:var(--text-primary);padding:5px 7px;font-size:12.5px;}
        .pm-custo{display:flex;align-items:center;gap:6px;} .pm-custo b{color:var(--text-primary);}
        .pm-lapis{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;}
        .pm-sel{max-width:330px;background:var(--bg-card-hover);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);padding:6px 8px;font-size:12px;}
        .pm-res{font-size:11.5px;margin-top:4px;max-width:200px;}
      </style>`;
  }

  window._pmAba = a => {
    abaPromo = a; try { localStorage.setItem('glr_promo_aba', a); } catch (e) {}
    document.getElementById('pm-auto').style.display = a === 'auto' ? '' : 'none';
    document.getElementById('promo-body').style.display = a === 'camp' ? '' : 'none';
    document.getElementById('pm-aba-auto').classList.toggle('on', a === 'auto');
    document.getElementById('pm-aba-camp').classList.toggle('on', a === 'camp');
  };
  window._pmFiltro = f => { st.filtro = f; render(); };
  window._pmAtualizar = () => carregar(true);
  window._pmEscolha = (id, i) => { st.escolha[id] = parseInt(i); render(); };
  window._pmAplicar = id => {
    const it = st.itens.find(x => x.id === id), op = it?.opcoes[st.escolha[id]];
    if (!op) return;
    const aviso = op.margem == null ? '\n\n⚠️ Sem custo cadastrado: a margem não foi calculada.' : !op.bate ? `\n\n⚠️ Margem de ${op.margem.toFixed(1)}% fica ABAIXO da mínima (${margemMin()}%).` : '';
    if (!confirm(`Aplicar ${TIPO[op.promo.type] || op.promo.type}${op.promo.name ? ' (' + op.promo.name + ')' : ''} em "${it.titulo.slice(0, 60)}" a ${R(op.preco)}?${aviso}`)) return;
    aplicar(id);
  };
  window._pmAplicarLote = aplicarLote;
  window._pmCusto = (id, v) => salvarCusto(id, v);
  window._pmEditarCusto = id => { const atual = custoDe(id); const v = prompt('Custo do produto (R$) — salva também em Vendas:', atual != null ? String(atual).replace('.', ',') : ''); if (v != null) salvarCusto(id, v); };
  window._pmMargem = v => {
    const mm = lerJSON('glr_promo_margem_min', {}); mm[contaAtual.external_id] = parseFloat(String(v).replace(',', '.')) || 0;
    localStorage.setItem('glr_promo_margem_min', JSON.stringify(mm));
    mapLimit(st.itens, 4, it => avaliar(it).catch(e => { it.erroPromo = e.message; })).then(render);
  };
  return { carregar, limpar: () => { st.itens = []; st.conta = null; render(); } };
})();

function renderVazio() {
  const body = document.getElementById('promo-body');
  if (!body) return;
  body.innerHTML = `
    <div style="text-align:center;padding:80px;color:var(--text-secondary);">
      <div style="font-size:48px;margin-bottom:12px;">🏷️</div>
      <div style="font-size:16px;font-weight:600;">Selecione uma conta Mercado Livre</div>
    </div>`;
}

function fmtData(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR');
}

function fmtR(v) {
  return (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const TIPO_LABEL = {
  LIGHTNING: 'Oferta Relâmpago', BANK: 'Desconto no Pagamento', PRICE_MATCHING: 'Price Matching',
  SMART: 'Oferta Inteligente', DEAL: 'Oferta do Dia', SELLER_CAMPAIGN: 'Campanha Própria',
  SELLER_COUPON_CAMPAIGN: 'Cupom Próprio', PRICE_DISCOUNT: 'Desconto de Preço', DOD: 'Deal of the Day',
  MARKETPLACE_CAMPAIGN: 'Campanha do ML',
};

async function buscarPromocoes() {
  const body = document.getElementById('promo-body');
  if (!body || !contaAtual) return;
  body.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);">
    <div style="font-size:32px;margin-bottom:12px;animation:spin 1s linear infinite;display:inline-block;">⟳</div>
    <div style="font-size:15px;font-weight:600;">Buscando promoções...</div>
  </div>
  <style>@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}</style>`;

  const meliId = contaAtual.param_to_use?.meliUserId || contaAtual.external_id;
  try {
    const r = await MarketplaceAPI.call('ml_list_promotions', { meliUserId: meliId, limit: 50 });
    promocoes = r?.data?.results || r?.results || [];
  } catch(e) {
    promocoes = [];
    body.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:24px;text-align:center;color:#dc2626;">
      <div style="font-weight:600;">Erro ao buscar promoções: ${e.message}</div>
    </div>`;
    return;
  }
  renderConteudo();
}

function renderConteudo() {
  const body = document.getElementById('promo-body');
  if (!body) return;

  const ativas = promocoes.filter(p => p.status === 'started' || p.status === 'candidate');
  const outras = promocoes.filter(p => !(p.status === 'started' || p.status === 'candidate'));

  const linhaPromo = p => `
    <div class="card" style="padding:16px 18px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="font-size:14px;font-weight:700;color:var(--text-primary);">${p.name || p.id}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">
            ${TIPO_LABEL[p.type] || p.type}${p.sub_type ? ' · ' + p.sub_type : ''} · ${fmtData(p.start_date)} → ${fmtData(p.finish_date)}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="badge ${p.status==='started'?'badge-green':'badge-yellow'}" style="font-size:11px;">${p.status==='started'?'ativa':p.status}</span>
          <button class="btn btn-secondary btn-sm" onclick="window._promoVerItens('${p.id}','${p.type}')">Ver itens</button>
        </div>
      </div>
      <div id="promo-itens-${p.id.replace(/[^a-zA-Z0-9]/g,'')}" style="margin-top:10px;"></div>
    </div>`;

  body.innerHTML = `
    <!-- Promoções ativas -->
    <div style="margin-bottom:28px;">
      <div class="section-title" style="font-size:15px;margin-bottom:12px;">📣 Promoções Ativas (${ativas.length})</div>
      ${ativas.length ? ativas.map(linhaPromo).join('') : `<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:13px;background:var(--bg-card);border-radius:12px;">Nenhuma promoção ativa nessa conta agora.</div>`}
      ${outras.length ? `
        <details style="margin-top:12px;">
          <summary style="cursor:pointer;font-size:12.5px;color:var(--text-secondary);">Ver ${outras.length} encerradas/outras</summary>
          <div style="margin-top:10px;">${outras.map(linhaPromo).join('')}</div>
        </details>` : ''}
    </div>

    <!-- Criar desconto em item -->
    <div class="card" style="padding:20px;margin-bottom:20px;">
      <div class="section-title" style="font-size:15px;margin-bottom:4px;">💸 Criar Desconto em Item</div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:0 0 16px;">Desconto de preço (PRICE_DISCOUNT) pontual num anúncio — até 14 dias de duração.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group">
          <label class="form-label">ID do Anúncio (MLB...)</label>
          <input class="form-input" id="pd-item" placeholder="MLB1234567890">
        </div>
        <div class="form-group">
          <label class="form-label">Preço Promocional (R$)</label>
          <input class="form-input" id="pd-preco" type="number" step="0.01" min="0" placeholder="0,00">
        </div>
        <div class="form-group">
          <label class="form-label">Início</label>
          <input class="form-input" id="pd-inicio" type="datetime-local">
        </div>
        <div class="form-group">
          <label class="form-label">Fim (máx. 14 dias do início)</label>
          <input class="form-input" id="pd-fim" type="datetime-local">
        </div>
      </div>
      <button class="btn btn-primary" style="margin-top:12px;" onclick="window._promoCriarDesconto()">Aplicar Desconto</button>
      <div id="pd-resultado" style="margin-top:10px;font-size:13px;"></div>
    </div>

    <!-- Criar cupom -->
    <div class="card" style="padding:20px;">
      <div class="section-title" style="font-size:15px;margin-bottom:4px;">🎟️ Criar Cupom de Vendedor</div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:0 0 16px;">Cupom válido pra loja inteira, com código próprio.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group" style="grid-column:1/-1;">
          <label class="form-label">Nome do Cupom</label>
          <input class="form-input" id="cp-nome" placeholder="Ex: Black Friday 10%">
        </div>
        <div class="form-group">
          <label class="form-label">Tipo</label>
          <select class="form-select" id="cp-tipo">
            <option value="FIXED_PERCENTAGE">% de desconto</option>
            <option value="FIXED_AMOUNT">R$ fixo de desconto</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Valor</label>
          <input class="form-input" id="cp-valor" type="number" step="0.01" min="0" placeholder="Ex: 10 (para 10%) ou 20.00">
        </div>
        <div class="form-group">
          <label class="form-label">Compra Mínima (R$)</label>
          <input class="form-input" id="cp-minimo" type="number" step="0.01" min="0" placeholder="0,00">
        </div>
        <div class="form-group">
          <label class="form-label">Orçamento Total (R$)</label>
          <input class="form-input" id="cp-orcamento" type="number" step="0.01" min="0" placeholder="0,00">
        </div>
        <div class="form-group">
          <label class="form-label">Usos por Cliente</label>
          <input class="form-input" id="cp-redeems" type="number" min="1" placeholder="1">
        </div>
        <div class="form-group">
          <label class="form-label">Início</label>
          <input class="form-input" id="cp-inicio" type="datetime-local">
        </div>
        <div class="form-group">
          <label class="form-label">Fim</label>
          <input class="form-input" id="cp-fim" type="datetime-local">
        </div>
      </div>
      <button class="btn btn-primary" style="margin-top:12px;" onclick="window._promoCriarCupom()">Criar Cupom</button>
      <div id="cp-resultado" style="margin-top:10px;font-size:13px;"></div>
    </div>
  `;
}

// Formata "2026-09-08T14:30" (datetime-local) pro formato que o ML espera: sem Z, sem offset.
function _promoDataML(inputId) {
  const v = document.getElementById(inputId).value;
  if (!v) return null;
  return v.length === 16 ? v + ':00' : v;
}

window._promoVerItens = async function(promotionId, promotionType) {
  const safeId = promotionId.replace(/[^a-zA-Z0-9]/g,'');
  const el = document.getElementById(`promo-itens-${safeId}`);
  if (!el || !contaAtual) return;
  if (el.dataset.aberto === '1') { el.innerHTML = ''; el.dataset.aberto = '0'; return; }

  el.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);">Carregando itens...</div>`;
  const meliId = contaAtual.param_to_use?.meliUserId || contaAtual.external_id;
  try {
    const r = await MarketplaceAPI.call('ml_promotion_items', { meliUserId: meliId, promotion_id: promotionId, promotion_type: promotionType, limit: 20 });
    const itens = r?.data?.results || r?.results || [];
    if (!itens.length) { el.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);">Nenhum item participante encontrado.</div>`; return; }
    el.innerHTML = `<table style="width:100%;border-collapse:collapse;margin-top:6px;">
      <thead><tr style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;">
        <th style="text-align:left;padding:4px 8px;">Item</th><th style="text-align:right;padding:4px 8px;">De</th><th style="text-align:right;padding:4px 8px;">Por</th><th style="text-align:right;padding:4px 8px;">Desconto</th>
      </tr></thead>
      <tbody>${itens.map(it => {
        const de = it.original_price || 0, por = it.price || 0;
        const desc = de > 0 ? ((1 - por/de) * 100).toFixed(0) : 0;
        return `<tr style="border-top:1px solid var(--border);">
          <td style="padding:4px 8px;font-size:12px;"><a href="https://produto.mercadolivre.com.br/${it.id}" target="_blank" rel="noopener" style="color:var(--primary);">${it.id}</a></td>
          <td style="padding:4px 8px;font-size:12px;text-align:right;color:var(--text-muted);text-decoration:line-through;">${fmtR(de)}</td>
          <td style="padding:4px 8px;font-size:12px;text-align:right;font-weight:600;">${fmtR(por)}</td>
          <td style="padding:4px 8px;font-size:12px;text-align:right;color:var(--green);">-${desc}%</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
    el.dataset.aberto = '1';
  } catch(e) {
    el.innerHTML = `<div style="font-size:12px;color:#dc2626;">Erro: ${e.message}</div>`;
  }
};

window._promoCriarDesconto = async function() {
  if (!contaAtual) { alert('Selecione uma conta primeiro.'); return; }
  const item = document.getElementById('pd-item').value.trim().toUpperCase();
  const preco = parseFloat(document.getElementById('pd-preco').value);
  const inicio = _promoDataML('pd-inicio');
  const fim = _promoDataML('pd-fim');
  const resDiv = document.getElementById('pd-resultado');

  if (!item || !item.startsWith('MLB')) { alert('Informe o ID do anúncio (formato MLB1234567890).'); return; }
  if (!preco || preco <= 0) { alert('Informe o preço promocional.'); return; }
  if (!inicio || !fim) { alert('Informe início e fim do desconto.'); return; }

  resDiv.innerHTML = '⏳ Aplicando desconto...';
  const meliId = contaAtual.param_to_use?.meliUserId || contaAtual.external_id;
  try {
    const r = await MarketplaceAPI.call('ml_add_promotion_items', {
      meliUserId: meliId, promotion_type: 'PRICE_DISCOUNT',
      items: [item], deal_price: preco, start_date: inicio, finish_date: fim,
    });
    const res = r?.data?.results?.[0] || r?.results?.[0];
    if (res?.aplicado) {
      resDiv.innerHTML = `<span style="color:var(--green);">✅ Desconto aplicado — preço efetivo: ${fmtR(res.aplicado.price)} (original ${fmtR(res.aplicado.original_price)})${res.atencao ? '<br><span style="color:#d97706;">⚠️ ' + res.atencao + '</span>' : ''}</span>`;
    } else {
      resDiv.innerHTML = `<span style="color:var(--green);">✅ Desconto enviado.</span>`;
    }
  } catch(e) {
    resDiv.innerHTML = `<span style="color:#dc2626;">❌ Erro: ${e.message}</span>`;
  }
};

window._promoCriarCupom = async function() {
  if (!contaAtual) { alert('Selecione uma conta primeiro.'); return; }
  const nome = document.getElementById('cp-nome').value.trim();
  const tipo = document.getElementById('cp-tipo').value;
  const valor = parseFloat(document.getElementById('cp-valor').value);
  const minimo = parseFloat(document.getElementById('cp-minimo').value) || undefined;
  const orcamento = parseFloat(document.getElementById('cp-orcamento').value) || undefined;
  const redeems = parseInt(document.getElementById('cp-redeems').value) || undefined;
  const inicio = _promoDataML('cp-inicio');
  const fim = _promoDataML('cp-fim');
  const resDiv = document.getElementById('cp-resultado');

  if (!nome) { alert('Informe o nome do cupom.'); return; }
  if (!valor || valor <= 0) { alert('Informe o valor do desconto.'); return; }

  resDiv.innerHTML = '⏳ Criando cupom...';
  const meliId = contaAtual.param_to_use?.meliUserId || contaAtual.external_id;
  const payload = {
    meliUserId: meliId, name: nome, sub_type: tipo,
    min_purchase_amount: minimo, budget: orcamento, redeems_per_user: redeems,
    start_date: inicio, finish_date: fim,
  };
  if (tipo === 'FIXED_PERCENTAGE') payload.fixed_percentage = valor;
  else payload.fixed_amount = valor;

  try {
    const r = await MarketplaceAPI.call('ml_create_coupon', payload);
    const id = r?.data?.id || r?.id;
    resDiv.innerHTML = `<span style="color:var(--green);">✅ Cupom criado${id ? ' — ID ' + id : ''}.</span>`;
  } catch(e) {
    resDiv.innerHTML = `<span style="color:#dc2626;">❌ Erro: ${e.message}</span>`;
  }
};

if (typeof Router !== 'undefined') {
  Router.register('promocoes', renderPage);
}

})();
