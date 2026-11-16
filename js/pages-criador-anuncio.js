// ============================================================
// GLR Consultoria — Criador de anúncios (assistente em etapas)
// ------------------------------------------------------------
// Monta o produto uma vez e publica em várias contas de vários marketplaces:
//   1 Produto e fotos → 2 Variações → 3 Onde publicar (contas + categoria e
//   ficha técnica de cada marketplace) → 4 Preço e margem → 5 Revisar e publicar
// Ao lado, sempre: prévia do anúncio no canal escolhido e a nota de qualidade
// (o que falta para chegar a 100).
// Marketplaces: Mercado Livre, Shopee e TikTok Shop — as mesmas chamadas das
// telas antigas (js/pages-anuncios.js), que continuam no ar.
//  • ML com variações: um anúncio por variação com o mesmo family_name (modelo
//    de user products — o ML agrupa na mesma página do produto).
//  • Shopee com variações: cria o item e depois shopee_init_variation (tiers).
//  • TikTok com variações: um SKU por combinação (sales_attributes).
// Taxas: ML pela API (ml_listing_fees); Shopee pela tabela de faixas 2026 e
// TikTok 12% + R$ 5 (as mesmas da calculadora.html). Imposto: alíquota da conta
// (glr_aliquotas). Rascunho salvo no navegador (glr_ca_rascunho).
// ============================================================
(function () {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : null; };
  const R$ = v => v == null || !isFinite(v) ? '—' : 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = v => v == null || !isFinite(v) ? '—' : (+v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const K_RASC = 'glr_ca_rascunho';

  const MKTS = {
    ml: { nome: 'Mercado Livre', cor: '#d9a400', tituloMax: 60, fotosMax: 10, tituloIdeal: [45, 60] },
    shopee: { nome: 'Shopee', cor: '#ee4d2d', tituloMax: 120, fotosMax: 9, tituloIdeal: [60, 120] },
    tiktok: { nome: 'TikTok Shop', cor: '#111827', tituloMax: 255, fotosMax: 9, tituloIdeal: [40, 120] },
  };
  const MKT_DE = m => ({ meli: 'ml', ml: 'ml', mercadolivre: 'ml', shopee: 'shopee', tiktok_shop: 'tiktok', tiktok: 'tiktok' })[String(m || '').toLowerCase()] || null;
  const idConta = c => { const m = MKT_DE(c.marketplace); return String(m === 'ml' ? (c.param_to_use?.meliUserId || c.external_id) : m === 'shopee' ? (c.param_to_use?.shopId || c.external_id) : c.external_id); };
  const nomeContaRaw = c => { const t = c.tags?.[0]?.name || c.tags?.[0]; return (typeof t === 'string' ? t : t?.value) || c.nickname || c.external_id; };
  const LISTING_ML = [{ id: 'gold_special', nome: 'Clássico' }, { id: 'gold_pro', nome: 'Premium (parcelado sem juros)' }];
  const dado = r => r?.data ?? r;

  // ── Taxas por marketplace ─────────────────────────────────────
  function shopeeFaixa(v) {
    if (v < 8) return { c: 50, f: 0 };
    if (v < 80) return { c: 20, f: 4 };
    if (v < 100) return { c: 14, f: 16 };
    if (v < 200) return { c: 14, f: 20 };
    return { c: 14, f: 26 };
  }
  // ML: % e taxa fixa da API (última consulta para esse preço); sem ela, 12% (+ R$ 6,25 abaixo de R$ 79) estimado
  function taxaCanal(mkt, preco, cn) {
    if (!(preco > 0)) return { c: 0, f: 0, est: true };
    if (mkt === 'shopee') { const x = shopeeFaixa(preco); return { c: x.c, f: x.f, est: false }; }
    if (mkt === 'tiktok') return { c: 12, f: 5, est: false };
    const api = cn.taxaApi && Math.abs(cn.taxaApi.preco - preco) < 0.01 ? cn.taxaApi : null;
    if (api) return { c: api.c, f: api.f, est: false };
    return { c: cn.taxaApi?.c ?? 12, f: preco < 79 ? 6.25 : 0, est: true };
  }

  Router.register('criar-anuncio', (params, el) => {
    const novoCanal = () => ({ cat: null, catRes: [], catBusca: '', buscando: false, aviso: '', req: [], opt: [], varAttrs: [], vals: {}, carregando: false, mostrarOpc: false, titulo: '', preco: '', frete: '', tipo: 'gold_special', mapaEixo: {}, marcas: [], marcaObrig: false, marcaId: '', taxaApi: null, iaFicha: false });
    const vazio = () => ({
      passo: 1, sel: [], todasContas: false,
      p: { titulo: '', descricao: '', marca: '', sku: '', gtin: '', condicao: 'new', peso: '', compr: '', larg: '', alt: '', custo: '', estoque: '', garantia: '' },
      fotos: [], vars: { ativo: false, eixos: [{ nome: 'Cor', valores: [] }], linhas: {} },
      canal: { ml: novoCanal(), shopee: novoCanal(), tiktok: novoCanal() },
      margemAlvo: 15, adsPct: 0, prevMkt: 'ml',
    });
    const st = Object.assign(vazio(), lerJSON(K_RASC, {}), { contas: [], carregandoContas: true, ia: false, gerandoFoto: false, iaTexto: false, pub: null, arvore: {}, gerando: [], kitAberto: false });
    if (!Array.isArray(st.kit)) st.kit = ['fundo_branco', 'ambientada', 'angulo', 'detalhe'];
    st.p = Object.assign(vazio().p, st.p || {});
    for (const m of Object.keys(MKTS)) st.canal[m] = Object.assign(novoCanal(), st.canal?.[m] || {}, { buscando: false, carregando: false, iaFicha: false });
    window._caSt = st;

    // Rascunho da Expansão de canais (o anúncio que já vende em outro canal)
    const rasc = window._glrRascunhoAnuncio; window._glrRascunhoAnuncio = null;
    if (rasc) {
      Object.assign(st, vazio(), { contas: [], carregandoContas: true, pub: null, arvore: {} });
      Object.assign(st.p, { titulo: rasc.titulo || '', descricao: rasc.descricao || '', sku: rasc.sku || '', estoque: String(rasc.estoque ?? ''), peso: String(rasc.peso || ''), compr: String(rasc.compr || ''), larg: String(rasc.larg || ''), alt: String(rasc.alt || '') });
      st.fotos = (rasc.fotos || []).map((url, i) => ({ id: Date.now() + i, url }));
      const m = MKT_DE(rasc.alvo) || rasc.alvo;
      if (MKTS[m]) { st.canal[m].preco = String(rasc.preco ?? ''); if (rasc.conta) st.sel = [`${m}:${rasc.conta}`]; st.prevMkt = m; }
      st.origemRasc = rasc.origem || '';
    }

    // fotos ficam no IndexedDB (base64 grande não cabe no localStorage); o resto do rascunho no localStorage
    const idb = (modo, fn) => new Promise((ok, erro) => { try { const r = indexedDB.open('glr_criador', 1); r.onupgradeneeded = () => r.result.createObjectStore('fotos'); r.onerror = () => erro(r.error); r.onsuccess = () => { const tx = r.result.transaction('fotos', modo); const q = fn(tx.objectStore('fotos')); tx.oncomplete = () => ok(q?.result); tx.onerror = () => erro(tx.error); }; } catch (e) { erro(e); } });
    const salvarFotos = () => idb('readwrite', os => os.put(st.fotos, 'rascunho')).catch(() => {});
    function salvar() {
      const { contas, carregandoContas, ia, gerandoFoto, iaTexto, pub, arvore, gerando, kitAberto, fotos, ...resto } = st;
      try { localStorage.setItem(K_RASC, JSON.stringify({ ...resto, nFotos: fotos.length })); } catch (e) {}
      salvarFotos();
    }
    let tSalvar; const salvarDepois = () => { clearTimeout(tSalvar); tSalvar = setTimeout(salvar, 600); };

    // ── Contas ──────────────────────────────────────────────────
    const contasDoCliente = () => {
      const cli = GLR.ctx?.cliente?.(); if (!cli) return null;
      const v = lerJSON('glr_mc_vinculos', {})[String(cli)] || [];
      return new Set(v.flatMap(c => [c.external_id, c.param_to_use?.shopId, c.param_to_use?.meliUserId].filter(Boolean).map(String)));
    };
    const contaKey = c => `${MKT_DE(c.marketplace)}:${idConta(c)}`;
    const contaPorKey = k => st.contas.find(c => contaKey(c) === k);
    const nomeConta = c => { const m = MKT_DE(c.marketplace), id = idConta(c); const g = window._portalConfig ? '' : (GLR.nomeConta ? String(GLR.nomeConta(m, id)) : ''); return g && !/^\d+$/.test(g) ? g : nomeContaRaw(c); };
    const selDe = m => st.sel.filter(k => k.startsWith(m + ':')).map(contaPorKey).filter(Boolean);
    const mktsSel = () => Object.keys(MKTS).filter(m => st.sel.some(k => k.startsWith(m + ':')));
    const contaRef = m => { const c = selDe(m)[0]; return c ? idConta(c) : ''; };
    async function carregarContas() {
      try { st.contas = (await MarketplaceAPI.listAccounts()).filter(c => MKT_DE(c.marketplace)); }
      catch (e) { st.erroContas = e.message || String(e); }
      st.carregandoContas = false;
      st.sel = st.sel.filter(k => contaPorKey(k));
      tudo();
    }

    // ── Variações ───────────────────────────────────────────────
    function combos() {
      if (!st.vars.ativo) return [];
      const eixos = st.vars.eixos.filter(e => e.nome.trim() && e.valores.length);
      if (!eixos.length) return [];
      let out = [[]];
      for (const e of eixos) out = out.flatMap(c => e.valores.map(v => [...c, v]));
      return out.map(vs => ({ chave: vs.join(' | '), valores: vs, eixos: eixos.map(e => e.nome), ...(st.vars.linhas[vs.join(' | ')] || {}) }));
    }
    const estoqueTotal = () => st.vars.ativo && combos().length ? combos().reduce((s, c) => s + (parseInt(c.estoque) || 0), 0) : parseInt(st.p.estoque) || 0;

    // ── Fotos e IA ──────────────────────────────────────────────
    function lerArquivos(files) {
      [...files].filter(f => f.type.startsWith('image/')).forEach(f => {
        const r = new FileReader();
        r.onload = () => { st.fotos.push({ id: Date.now() + Math.random(), url: String(r.result) }); tudo(); salvarDepois(); };
        r.readAsDataURL(f);
      });
    }
    async function api(path, corpo) {
      const r = await window.glrApiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    }
    // foto de referência para a IA: a primeira foto real (não gerada); reduzida para caber no envio
    const fotoRef = () => (st.fotos.find(f => !f.ia) || st.fotos[0])?.url || null;
    function reduzir(url, max = 1024) {
      return new Promise(ok => {
        const im = new Image(); im.crossOrigin = 'anonymous';
        im.onload = () => { try { const k = Math.min(1, max / Math.max(im.width, im.height)); const c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height); ok(c.toDataURL('image/jpeg', 0.86)); } catch (e) { ok(/^data:/.test(url) ? url : null); } };
        im.onerror = () => ok(/^data:/.test(url) ? url : null);
        im.src = url;
      });
    }
    const KIT = { fundo_branco: 'Fundo branco (capa)', ambientada: 'Ambientada', angulo: 'Outro ângulo', detalhe: 'Detalhe de perto', uso: 'Em uso / tamanho real' };
    async function gerarKit() {
      const ref = fotoRef(); if (!ref) return aviso('Envie uma foto real do produto primeiro.');
      const tipos = st.kit.filter(t => KIT[t]); if (!tipos.length) return aviso('Escolha pelo menos um tipo de foto.');
      const cabe = 10 - st.fotos.length; if (cabe <= 0) return aviso('Já são 10 fotos — remova alguma para gerar mais.');
      const lista = tipos.slice(0, cabe);
      const refMenor = await reduzir(ref, 1280);
      st.kitAberto = false; st.gerando = lista.map(t => ({ t, status: 'gerando' })); tudo();
      let ok = 0;
      await Promise.all(lista.map(async t => {
        const g = st.gerando.find(x => x.t === t);
        try {
          const j = await api('/api/generate-photo', { ...(refMenor ? { image_base64: refMenor } : { image_url: ref }), product_name: st.p.titulo, details: st.p.descricao.slice(0, 600), stage: 'tipo', tipo: t });
          const img = j.images?.[0]; if (!img) throw new Error('sem imagem');
          const foto = { id: Date.now() + Math.random(), url: img.url, ia: true, tipo: t };
          if (t === 'fundo_branco') st.fotos.unshift(foto); else st.fotos.push(foto);
          st.gerando = st.gerando.filter(x => x !== g); ok++;
        } catch (e) { g.status = 'erro'; g.msg = e.message; }
        tudo();
      }));
      st.gerando = st.gerando.filter(x => x.status === 'erro');
      aviso(ok === lista.length ? `${ok} foto(s) geradas.${lista.includes('fundo_branco') ? ' A de fundo branco virou a capa.' : ''}` : `${ok} de ${lista.length} foto(s) geradas — as que falharam podem ser geradas de novo.`);
      tudo(); salvarDepois();
    }
    async function api(path, corpo) {
      const r = await window.glrApiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    }
    // SEO: pesquisa real de busca do ML + IA (api/anuncio-seo.js) → título por canal e descrição
    async function iaSEO() {
      if (!st.fotos.length && !st.p.titulo.trim()) return aviso('Envie uma foto ou escreva o nome do produto.');
      st.iaTexto = true; tudo();
      try {
        const ref = fotoRef(), foto = ref ? await reduzir(ref, 1024) : null;
        const foco = contasDoCliente();
        const ml = [...selDe('ml'), ...st.contas.filter(c => MKT_DE(c.marketplace) === 'ml' && (!foco || foco.has(idConta(c))))].map(idConta);
        const extras = [st.p.compr && `embalagem ${st.p.compr}x${st.p.larg}x${st.p.alt} cm`, st.p.peso && `${st.p.peso} kg`, st.p.garantia && `garantia ${st.p.garantia}`, st.vars.ativo && st.vars.eixos.filter(e => e.valores.length).map(e => `${e.nome}: ${e.valores.join(', ')}`).join('; ')].filter(Boolean).join(' · ');
        const j = await api('/api/anuncio-seo', { titulo: st.p.titulo, descricao: st.p.descricao, marca: st.p.marca, extras, foto, categoria_ml: st.canal.ml.cat?.id, categoria_nome: st.canal.ml.cat?.nome, contas: [...new Set(ml)].slice(0, 6) });
        if (j.titulos?.ml) st.p.titulo = j.titulos.ml;
        if (j.descricao) st.p.descricao = j.descricao;
        if (j.titulos?.shopee) st.canal.shopee.titulo = j.titulos.shopee;
        if (j.titulos?.tiktok) st.canal.tiktok.titulo = j.titulos.tiktok;
        st.canal.ml.titulo = '';
        st.seo = { chaves: j.palavras_chave || [], principal: j.palavra_principal || '', faltam: j.faltam || [], fontes: j.fontes || {}, titulos: j.titulos || {} };
        if (j.palavra_principal) st.termoCategoria = j.palavra_principal;
        aviso('Título e descrição com SEO prontos — confira os dados técnicos.');
      } catch (e) { aviso('Não consegui gerar o SEO: ' + e.message); }
      st.iaTexto = false; tudo(); salvarDepois();
    }

    // ── Categoria e ficha técnica (adaptadores por marketplace) ──
    // Atributo normalizado: { id, nome, obrig, tipo: lista|multi|texto|numero, opcoes:[{id,nome}], unidades:[], dica, max }
    async function arvoreShopee(conta) {
      if (st.arvore.shopee) return st.arvore.shopee;
      const c = lerJSON('glr_shopee_categorias_pt', null);
      if (c && Date.now() - c.ts < 7 * 864e5) return (st.arvore.shopee = c.lista);
      const r = await MarketplaceAPI.call('shopee_get_categories', { shopId: conta, language: 'pt-br' });
      const lista = dado(r)?.response?.category_list || r.response?.category_list || [];
      try { localStorage.setItem('glr_shopee_categorias_pt', JSON.stringify({ ts: Date.now(), lista })); } catch (e) {}
      return (st.arvore.shopee = lista);
    }
    async function termosAlternativos() {
      try { const r = await api('/api/anuncio-seo', { acao: 'termos', titulo: st.p.titulo, descricao: st.p.descricao }); return (r.termos || []).slice(0, 3); } catch (e) { return []; }
    }
    const ADP = {
      ml: {
        async categorias(conta, q) {
          const r = await MarketplaceAPI.call('search_categories', { q, meliUserId: conta });
          const d = dado(r);
          return (Array.isArray(d) ? d : d?.items || r.items || []).map(c => ({ id: c.category_id, nome: c.category_name, extra: c.domain_name || '' }));
        },
        async ficha(conta, cat) {
          const r = await MarketplaceAPI.call('category_attributes', { categoryId: cat.id, meliUserId: conta });
          const d = dado(r), todos = Array.isArray(d) ? d : d?.items || r.items || [];
          const norm = a => ({ id: a.id, nome: a.name, obrig: !!(a.tags?.required || a.tags?.catalog_required), tipo: Array.isArray(a.values) && a.values.length ? (a.tags?.multivalued ? 'multi' : 'lista') : (a.value_type === 'number_unit' || a.value_type === 'number') ? 'numero' : 'texto',
            opcoes: (a.values || []).map(v => ({ id: v.id, nome: v.name })), unidades: (a.allowed_units || []).map(u => u.id), unidade: a.default_unit, dica: a.tooltip || a.hint || '', max: a.value_max_length });
          const ok = todos.filter(a => !a.tags?.hidden && !a.tags?.read_only && !['SELLER_SKU', 'GTIN', 'EMPTY_GTIN_REASON'].includes(a.id));
          const ehVar = a => a.tags?.variation_attribute || (a.tags?.allow_variations && !/^PACKAGE_/.test(a.id));
          const obrig = a => a.tags?.required || a.tags?.catalog_required;
          return { req: ok.filter(a => !ehVar(a) && obrig(a)).map(norm), opt: ok.filter(a => !ehVar(a) && !obrig(a)).map(norm), varAttrs: ok.filter(ehVar).map(norm) };
        },
      },
      shopee: {
        async categorias(conta, q, manual) {
          const arv = await arvoreShopee(conta);
          const nomeDe = id => { const c = arv.find(x => x.category_id === id); return c?.display_category_name || c?.original_category_name || `Categoria ${id}`; };
          const caminho = id => { const p = []; let c = arv.find(x => x.category_id === id); while (c && p.length < 6) { p.unshift(c.display_category_name || c.original_category_name); const pai = c.parent_category_id; c = arv.find(x => x.category_id === pai); } return p.slice(0, -1).join(' › '); };
          if (manual) { const t = q.toLowerCase(); return arv.filter(c => !c.has_children && `${c.display_category_name} ${c.original_category_name}`.toLowerCase().includes(t)).slice(0, 15).map(c => ({ id: c.category_id, nome: nomeDe(c.category_id), extra: caminho(c.category_id) })); }
          const r = await MarketplaceAPI.call('shopee_recommend_category', { item_name: q, shopId: conta });
          return (dado(r)?.response?.category_id || r.response?.category_id || []).map(id => ({ id, nome: nomeDe(id), extra: caminho(id) }));
        },
        async ficha(conta, cat) {
          const [ra, rb] = await Promise.allSettled([
            MarketplaceAPI.call('shopee_get_attributes', { shopId: conta, category_id: cat.id }),
            MarketplaceAPI.call('shopee_get_brand_list', { shopId: conta, category_id: cat.id, offset: 0, page_size: 100, status: 1 }),
          ]);
          if (ra.status === 'rejected') throw ra.reason;
          const arv = dado(ra.value)?.response?.list?.[0]?.attribute_tree || ra.value.response?.list?.[0]?.attribute_tree || [];
          const pt = (x, d) => x?.multi_lang?.find(m => m.language === 'pt-BR')?.value || d;
          const norm = a => { const ops = (a.attribute_value_list || []).map(v => ({ id: v.value_id, nome: pt(v, v.name) })); const un = a.attribute_info?.attribute_unit_list || [];
            return { id: a.attribute_id, nome: pt(a, a.name), obrig: !!a.mandatory, tipo: ops.length ? (a.attribute_info?.input_type === 5 ? 'multi' : 'lista') : un.length ? 'numero' : 'texto', opcoes: ops, unidades: un, unidade: un[0], max: a.attribute_info?.max_value_count }; };
          const b = rb.status === 'fulfilled' ? (dado(rb.value)?.response || rb.value.response || {}) : {};
          return { req: arv.filter(a => a.mandatory).map(norm), opt: arv.filter(a => !a.mandatory).map(norm), varAttrs: [], marcas: b.brand_list || [], marcaObrig: !!b.is_mandatory };
        },
      },
      tiktok: {
        async categorias(conta, q) {
          const r = await MarketplaceAPI.call('tiktok_recommend_category', { open_id: conta, body: { product_title: q, description: st.p.descricao?.slice(0, 500) || undefined } });
          const d = dado(r); const cam = d?.categories || []; const folha = cam.find(c => c.id === d?.leaf_category_id) || cam[cam.length - 1];
          return folha ? [{ id: d.leaf_category_id || folha.id, nome: folha.name || folha.local_name, extra: cam.slice(0, -1).map(c => c.name || c.local_name).join(' › ') }] : [];
        },
        async ficha(conta, cat) {
          const r = await MarketplaceAPI.call('tiktok_listing_schemas', { category_ids: cat.id, open_id: conta });
          const sc = (dado(r)?.listing_schemas || r.listing_schemas || [])[0];
          const todos = (sc?.fields || []).find(f => f.id === 'product_attribute')?.complex_values || [];
          const obrig = a => a.rules?.some(x => x.type === 'REQUIRED' && x.value === 'true');
          const norm = a => ({ id: a.id, nome: a.name, obrig: !!obrig(a), tipo: a.options?.length ? (a.rules?.some(x => x.type === 'MULTI_INPUT' && x.value === 'true') ? 'multi' : 'lista') : 'texto', opcoes: (a.options || []).map(o => ({ id: o.id, nome: o.name })) });
          return { req: todos.filter(obrig).map(norm), opt: todos.filter(a => !obrig(a)).map(norm), varAttrs: [] };
        },
      },
    };
    async function buscarCategoria(m, termo, manual) {
      const cn = st.canal[m], conta = contaRef(m);
      if (!conta) return;
      const q = (termo || cn.catBusca || st.termoCategoria || st.p.titulo || '').trim();
      if (!q) { cn.aviso = 'Preencha o nome do produto (etapa 1) para sugerir a categoria.'; tudo(); return; }
      cn.buscando = true; cn.aviso = ''; cn.catRes = []; tudo();
      try {
        cn.catRes = await ADP[m].categorias(conta, q, manual);
        if (!cn.catRes.length && !manual) {
          cn.aviso = 'Nada com esse nome — a IA está tentando outros termos…'; tudo();
          for (const t of await termosAlternativos()) {
            const r = await ADP[m].categorias(conta, t).catch(() => []);
            if (r.length) { cn.catRes = r; cn.aviso = `Achei buscando por "${t}".`; break; }
          }
        }
        if (!cn.catRes.length) cn.aviso = 'Nenhuma categoria encontrada. Busque pelo tipo do produto (ex.: "armário de cozinha").';
        else if (cn.aviso.startsWith('Nada')) cn.aviso = '';
      } catch (e) { cn.aviso = 'Erro ao buscar categoria: ' + e.message; }
      cn.buscando = false; tudo();
    }
    async function escolherCategoria(m, cat) {
      const cn = st.canal[m]; cn.cat = cat; cn.catRes = []; cn.aviso = ''; cn.vals = {}; cn.carregando = true; cn.mapaEixo = {}; cn.taxaApi = null; tudo();
      try {
        const f = await ADP[m].ficha(contaRef(m), cat);
        Object.assign(cn, { req: f.req, opt: f.opt, varAttrs: f.varAttrs || [], marcas: f.marcas || [], marcaObrig: !!f.marcaObrig });
        preencherAutomatico(m);
      } catch (e) { cn.aviso = 'Não consegui carregar a ficha técnica: ' + e.message; }
      cn.carregando = false; tudo(); salvarDepois();
    }
    // o que o produto já informa entra sozinho na ficha (marca e os eixos de variação do ML)
    function preencherAutomatico(m) {
      const cn = st.canal[m], todos = [...cn.req, ...cn.opt];
      const marca = todos.find(a => /^BRAND$/i.test(String(a.id)) || /^marca$/i.test(a.nome));
      if (marca && st.p.marca && cn.vals[marca.id] == null) {
        if (marca.tipo === 'texto') cn.vals[marca.id] = st.p.marca;
        else { const o = marca.opcoes.find(o => o.nome.toLowerCase() === st.p.marca.toLowerCase()); if (o) cn.vals[marca.id] = String(o.id); }
      }
      // medidas da embalagem (ML: PACKAGE_*)
      const med = { PACKAGE_HEIGHT: st.p.alt, PACKAGE_WIDTH: st.p.larg, PACKAGE_LENGTH: st.p.compr };
      for (const a of todos) {
        if (cn.vals[a.id] != null || a.tipo !== 'numero') continue;
        if (med[a.id] && num(med[a.id])) cn.vals[a.id] = { num: String(num(med[a.id])), unit: a.unidades?.includes('cm') ? 'cm' : a.unidade };
        if (a.id === 'PACKAGE_WEIGHT' && num(st.p.peso)) { const kg = a.unidades?.includes('kg'); cn.vals[a.id] = { num: String(kg ? num(st.p.peso) : Math.round(num(st.p.peso) * 1000)), unit: kg ? 'kg' : 'g' }; }
      }
      if (m === 'shopee' && st.p.marca && !cn.marcaId) { const b = cn.marcas.find(b => (b.original_brand_name || b.display_brand_name || '').toLowerCase() === st.p.marca.toLowerCase()); if (b) cn.marcaId = String(b.brand_id); }
      if (m === 'ml') mapearEixos();
    }
    function mapearEixos() {
      const cn = st.canal.ml; if (!st.vars.ativo) return;
      st.vars.eixos.forEach((e, i) => {
        if (cn.mapaEixo[i]) return;
        const re = /cor|color/i.test(e.nome) ? /COLOR|^cor/i : /tamanho|size/i.test(e.nome) ? /SIZE|tamanho/i : /volt/i.test(e.nome) ? /VOLTAGE|volt/i : new RegExp(e.nome.slice(0, 5).replace(/[^\w]/g, ''), 'i');
        const a = cn.varAttrs.find(a => re.test(a.id) || re.test(a.nome)); if (a) cn.mapaEixo[i] = a.id;
      });
    }
    async function iaFicha(m) {
      const cn = st.canal[m], alvo = [...cn.req, ...cn.opt].filter(a => !preenchido(cn, a)).slice(0, 40);
      if (!alvo.length) return aviso('A ficha já está preenchida.');
      cn.iaFicha = true; tudo();
      try {
        const lista = alvo.map(a => `${a.id} | ${a.nome}${a.tipo === 'numero' ? ` | número em ${a.unidades?.join('/') || a.unidade || ''}` : ''}${a.opcoes?.length ? ` | opções: ${a.opcoes.slice(0, 40).map(o => o.nome).join('; ')}` : ''}`).join('\n');
        const r = await api('/api/anuncio-seo', { acao: 'ficha', titulo: st.p.titulo, marca: st.p.marca, descricao: st.p.descricao, embalagem: `${st.p.compr}x${st.p.larg}x${st.p.alt} cm, ${st.p.peso} kg`, campos: lista });
        let n = 0;
        for (const [id, v] of Object.entries(r.valores || {})) {
          const a = alvo.find(x => String(x.id) === String(id)); if (!a || v == null || v === '') continue;
          if (a.tipo === 'lista' || a.tipo === 'multi') { const o = a.opcoes.find(o => o.nome.toLowerCase() === String(v).toLowerCase()); if (o) { cn.vals[a.id] = a.tipo === 'multi' ? [String(o.id)] : String(o.id); n++; } }
          else if (a.tipo === 'numero') {
            const mm = String(v).trim().match(/^(-?[\d.,]+)\s*(.*)$/); if (!mm || num(mm[1]) == null) continue;
            const un = (a.unidades || []).find(u => u.toLowerCase() === mm[2].trim().toLowerCase()) || (a.unidades?.length ? unidadeBoa(a) : undefined);
            cn.vals[a.id] = { num: String(num(mm[1])), unit: un }; n++;
          }
          else { cn.vals[a.id] = String(v); n++; }
        }
        aviso(n ? `A IA preencheu ${n} campo(s) — confira antes de publicar.` : 'A IA não encontrou nada seguro para preencher com os dados do produto.');
      } catch (e) { aviso('A IA não respondeu: ' + e.message); }
      cn.iaFicha = false; tudo(); salvarDepois();
    }
    // unidade preferida quando não vem explícita: cm para medida, kg para peso
    const unidadeBoa = a => { const u = a.unidades || []; return u.find(x => x === 'cm') || u.find(x => x === 'kg') || a.unidade || u[0]; };
    const preenchido = (cn, a) => { const v = cn.vals[a.id]; if (v == null || v === '') return false; if (Array.isArray(v)) return v.length > 0; if (typeof v === 'object') return !!v.num; return true; };

    // ── Preço, taxas e margem ───────────────────────────────────
    const aliquotaDe = m => { const al = lerJSON('glr_aliquotas', {}); const v = selDe(m).map(c => num(al[idConta(c)]) || 0); return { a: v.length ? Math.max(...v) : 0, varia: new Set(v).size > 1 }; };
    function contaMargem(m, precoOverride) {
      const cn = st.canal[m], preco = precoOverride ?? num(cn.preco), custo = num(st.p.custo) || 0;
      if (!(preco > 0)) return null;
      const t = taxaCanal(m, preco, cn), al = aliquotaDe(m).a, frete = m === 'ml' ? (num(cn.frete) || 0) : 0;
      const comissao = preco * t.c / 100, imposto = preco * al / 100, ads = preco * (num(st.adsPct) || 0) / 100;
      const lucro = preco - comissao - t.f - frete - imposto - ads - custo;
      return { preco, comissao, fixa: t.f, frete, imposto, ads, custo, lucro, margem: lucro / preco * 100, est: t.est, pc: t.c };
    }
    // preço que dá a margem desejada (taxa da Shopee muda por faixa: itera até estabilizar), terminando em ,90
    function precoParaMargem(m, alvo) {
      const custo = num(st.p.custo); if (!(custo > 0)) return null;
      let p = custo * 2;
      for (let i = 0; i < 30; i++) {
        const t = taxaCanal(m, p, st.canal[m]), al = aliquotaDe(m).a, fr = m === 'ml' ? (num(st.canal[m].frete) || 0) : 0;
        const den = 1 - (t.c + al + (num(st.adsPct) || 0) + alvo) / 100;
        if (den <= 0.02) return null;
        const np = (custo + t.f + fr) / den;
        if (Math.abs(np - p) < 0.005) { p = np; break; } p = np;
      }
      return Math.ceil(p) - 0.1 >= p ? Math.ceil(p) - 0.1 : Math.ceil(p) + 0.9;
    }
    let tTaxa;
    function consultarTaxaML() {
      const cn = st.canal.ml, preco = num(cn.preco), conta = contaRef('ml');
      if (!(preco > 0) || !conta) return;
      clearTimeout(tTaxa);
      tTaxa = setTimeout(async () => {
        try {
          const r = await MarketplaceAPI.call('ml_listing_fees', { price: preco, ...(cn.cat ? { category_id: cn.cat.id } : {}), listing_type_id: cn.tipo, meliUserId: conta, shipping_mode: 'me2', logistic_type: 'drop_off' });
          const d = dado(r); const lista = Array.isArray(d) ? d : d?.items || d?.results || [d];
          const x = lista.find(i => i?.listing_type_id === cn.tipo) || lista[0];
          const det = x?.sale_fee_details || {};
          if (x?.sale_fee_amount != null) {
            const fixa = num(det.fixed_fee) || 0, pc = num(det.percentage_fee) ?? ((num(x.sale_fee_amount) - fixa) / preco * 100);
            cn.taxaApi = { preco, c: Math.round(pc * 100) / 100, f: fixa };
            ladoEPreco();
          }
        } catch (e) { /* fica a estimativa */ }
      }, 500);
    }
    async function estimarFreteML() {
      const cn = st.canal.ml, conta = contaRef('ml'), preco = num(cn.preco);
      const dims = [st.p.alt, st.p.larg, st.p.compr].map(num), pesoG = Math.round((num(st.p.peso) || 0) * 1000);
      if (!conta || !(preco > 0) || dims.some(d => !(d > 0)) || !pesoG) return aviso('Para estimar o frete preencha o preço e o peso e as medidas da embalagem (etapa 1).');
      if (preco < 79) { cn.frete = '0'; aviso('Abaixo de R$ 79 o frete do ML é pago pelo comprador.'); tudo(); return; }
      try {
        const r = await MarketplaceAPI.call('ml_shipping_options_free', { meliUserId: conta, dimensions: `${dims.join('x')},${pesoG}`, item_price: preco, listing_type_id: cn.tipo, mode: 'me2', condition: st.p.condicao, free_shipping: true, ...(cn.cat ? { category_id: cn.cat.id } : {}) });
        const d = dado(r); const v = num(d?.coverage?.all_country?.list_cost ?? d?.list_cost);
        if (v != null) { cn.frete = String(v); aviso(`Frete grátis estimado pelo ML: ${R$(v)} por venda.`); } else aviso('O ML não devolveu o custo do frete — informe à mão.');
      } catch (e) { aviso('Não consegui estimar o frete: ' + e.message); }
      tudo(); salvarDepois();
    }

    // ── Nota de qualidade (por canal) ───────────────────────────
    function nota(m) {
      const cn = st.canal[m], M = MKTS[m], t = (cn.titulo || st.p.titulo).trim(), nf = st.fotos.length, desc = st.p.descricao.trim().length;
      const req = cn.req.length ? cn.req.filter(a => preenchido(cn, a)).length / cn.req.length : cn.cat ? 1 : 0;
      const opt = cn.opt.length ? Math.min(1, cn.opt.filter(a => preenchido(cn, a)).length / Math.min(8, cn.opt.length)) : cn.cat ? 1 : 0;
      const mg = contaMargem(m);
      const itens = [
        { t: 'Fotos', peso: 20, v: nf >= 6 ? 1 : nf >= 4 ? 0.7 : nf >= 1 ? 0.35 : 0, dica: nf ? `tem ${nf}; o ideal é 6 ou mais (capa com fundo limpo, detalhes, medidas, ambiente)` : 'adicione fotos do produto' },
        { t: 'Título', peso: 15, v: !t ? 0 : t.length > M.tituloMax ? 0.3 : t === t.toUpperCase() && /[A-Z]/.test(t) ? 0.6 : t.length >= M.tituloIdeal[0] ? 1 : 0.5, dica: !t ? 'escreva o título' : t.length > M.tituloMax ? `passa de ${M.tituloMax} caracteres` : t === t.toUpperCase() ? 'evite CAIXA ALTA' : `use de ${M.tituloIdeal[0]} a ${M.tituloIdeal[1]} caracteres com tipo + características (está com ${t.length})` },
        { t: 'Descrição', peso: 10, v: desc >= 500 ? 1 : desc >= 200 ? 0.6 : desc ? 0.3 : 0, dica: desc ? `está com ${desc} caracteres; com 500+ explicando medidas, material e o que vem na caixa converte melhor` : 'escreva a descrição' },
        { t: 'Ficha técnica obrigatória', peso: 25, v: req, dica: !cn.cat ? 'escolha a categoria (etapa 3)' : `${cn.req.filter(a => !preenchido(cn, a)).length} campo(s) obrigatório(s) vazio(s)` },
        { t: 'Ficha técnica extra', peso: 10, v: opt, dica: !cn.cat ? 'escolha a categoria (etapa 3)' : 'campos opcionais ajudam a aparecer nos filtros da busca' },
        { t: 'Código de barras (EAN)', peso: 5, v: st.p.gtin.trim() ? 1 : 0, dica: 'informe o EAN se o produto tiver' },
        { t: 'Peso e medidas', peso: 5, v: [st.p.peso, st.p.compr, st.p.larg, st.p.alt].every(x => num(x) > 0) ? 1 : 0, dica: 'informe peso e medidas da embalagem (frete certo)' },
        { t: 'Margem', peso: 10, v: !mg ? 0 : !(num(st.p.custo) > 0) ? 0.3 : mg.margem >= st.margemAlvo ? 1 : mg.margem > 0 ? 0.5 : 0, dica: !mg ? 'informe o preço (etapa 4)' : !(num(st.p.custo) > 0) ? 'informe o custo para conferir o lucro' : mg.margem <= 0 ? 'o preço dá prejuízo' : `margem ${pct(mg.margem)} abaixo da meta de ${st.margemAlvo}%` },
      ];
      const total = Math.round(itens.reduce((s, i) => s + i.peso * i.v, 0));
      return { total, faltam: itens.filter(i => i.v < 1).map(i => ({ ...i, ganha: Math.round(i.peso * (1 - i.v)) })).filter(i => i.ganha > 0).sort((a, b) => b.ganha - a.ganha) };
    }

    // ── Publicação ──────────────────────────────────────────────
    const nomeOpcao = (a, x) => a.opcoes.find(o => String(o.id) === String(x))?.nome || String(x);
    function valsML(cn) {
      const out = [];
      for (const a of [...cn.req, ...cn.opt]) {
        if (!preenchido(cn, a)) continue; const v = cn.vals[a.id];
        if (a.tipo === 'numero') out.push({ id: a.id, value_name: `${v.num} ${v.unit || ''}`.trim() });
        else if (a.tipo === 'lista') out.push({ id: a.id, value_name: nomeOpcao(a, v) });
        else if (a.tipo === 'multi') out.push({ id: a.id, value_name: (Array.isArray(v) ? v : [v]).map(x => nomeOpcao(a, x)).join(', ') });
        else out.push({ id: a.id, value_name: String(v) });
      }
      return out;
    }
    function valsShopee(cn) {
      const out = [];
      for (const a of [...cn.req, ...cn.opt]) {
        if (!preenchido(cn, a)) continue; const v = cn.vals[a.id];
        if (a.tipo === 'lista') out.push({ attribute_id: a.id, attribute_value_list: [{ value_id: parseInt(v, 10) }] });
        else if (a.tipo === 'multi') out.push({ attribute_id: a.id, attribute_value_list: (Array.isArray(v) ? v : [v]).map(x => ({ value_id: parseInt(x, 10) })) });
        else if (a.tipo === 'numero') out.push({ attribute_id: a.id, attribute_value_list: [{ value_unit: v.unit, original_value_name: String(v.num) }] });
        else out.push({ attribute_id: a.id, attribute_value_list: [{ original_value_name: String(v) }] });
      }
      return out;
    }
    function valsTikTok(cn) {
      const out = [];
      for (const a of [...cn.req, ...cn.opt]) {
        if (!preenchido(cn, a)) continue; const v = cn.vals[a.id];
        if (a.tipo === 'lista') out.push({ id: a.id, values: [{ id: String(v), name: nomeOpcao(a, v) }] });
        else if (a.tipo === 'multi') out.push({ id: a.id, values: (Array.isArray(v) ? v : [v]).map(x => ({ id: String(x), name: nomeOpcao(a, x) })) });
        else out.push({ id: a.id, values: [{ name: String(v) }] });
      }
      return out;
    }
    // fotos num endereço público (uma vez por foto; vale para todas as contas)
    async function fotosPublicas() {
      for (const f of st.fotos) {
        if (f.pub) continue;
        if (/^https?:/.test(f.url)) { f.pub = f.url; continue; }
        const menor = await reduzir(f.url, 1600);
        if (!menor) throw new Error('não consegui preparar uma das fotos');
        f.pub = (await api('/api/foto-publica', { image_base64: menor })).url;
      }
      salvarDepois();
      return st.fotos.map(f => f.pub);
    }
    const fotoDaVar = c => { const i = parseInt(c.foto); return isFinite(i) && st.fotos[i] ? st.fotos[i].pub || null : null; };
    const precoVar = (m, c) => num(c.preco) || num(st.canal[m].preco);
    const tituloDe = m => (st.canal[m].titulo || st.p.titulo).trim().slice(0, MKTS[m].tituloMax);
    const PUB = {
      async ml(conta) {
        const cn = st.canal.ml, base = { meliUserId: conta, category_id: cn.cat.id, condition: st.p.condicao, listing_type_id: cn.tipo, description: st.p.descricao, ...(st.p.garantia ? { warranty: st.p.garantia } : {}) };
        const attrsBase = valsML(cn);
        attrsBase.push(st.p.gtin.trim() ? { id: 'GTIN', value_name: st.p.gtin.trim() } : { id: 'EMPTY_GTIN_REASON', value_name: 'O produto não tem código cadastrado' });
        // contas no modelo de user products exigem family_name; as antigas, title
        const criar = async corpo => {
          try { return dado(await MarketplaceAPI.call('create_item', { ...corpo, family_name: tituloDe('ml') })); }
          catch (e) { if (/family_name|title/i.test(e.message)) return dado(await MarketplaceAPI.call('create_item', { ...corpo, title: tituloDe('ml') })); throw e; }
        };
        const fotos = await fotosPublicas(), cs = combos();
        const pics = l => l.map(u => ({ source: u }));
        if (!cs.length) {
          const r = await criar({ ...base, price: num(cn.preco), available_quantity: parseInt(st.p.estoque) || 0, pictures: pics(fotos), attributes: [...attrsBase, ...(st.p.sku ? [{ id: 'SELLER_SKU', value_name: st.p.sku }] : [])] });
          return { id: r.id, link: r.permalink, txt: r.id };
        }
        const ids = []; let link = null;
        for (const c of cs) {
          const va = c.valores.map((v, i) => cn.mapaEixo[i] ? { id: cn.mapaEixo[i], value_name: v } : null).filter(Boolean);
          const capa = fotoDaVar(c);
          const r = await criar({ ...base, price: precoVar('ml', c), available_quantity: parseInt(c.estoque) || 0, pictures: pics(capa ? [capa, ...fotos.filter(u => u !== capa)] : fotos), attributes: [...attrsBase, ...va, ...(c.sku ? [{ id: 'SELLER_SKU', value_name: c.sku }] : [])] });
          ids.push(r.id); link = link || r.permalink;
        }
        return { id: ids[0], link, txt: `${ids.length} anúncios da mesma família (${ids.join(', ')})` };
      },
      async shopee(conta) {
        const cn = st.canal.shopee, cs = combos();
        const marca = cn.marcas.find(b => String(b.brand_id) === String(cn.marcaId));
        // Shopee: cada foto sobe na loja de destino (shopee_upload_image) e vira image_id
        const urls = await fotosPublicas(), ids = [];
        for (const u of urls.slice(0, 9)) {
          const up = dado(await MarketplaceAPI.call('shopee_upload_image', { shopId: conta, image_url: u }));
          const id = up?.response?.image_info?.image_id || up?.image_info?.image_id || up?.image_id || up?.response?.image_id;
          if (id) ids.push(id);
        }
        if (!ids.length) throw new Error('a Shopee não aceitou nenhuma foto');
        const body = { shopId: conta, item_name: tituloDe('shopee'), description: st.p.descricao, category_id: parseInt(cn.cat.id, 10), original_price: num(cn.preco), stock: estoqueTotal(), condition: st.p.condicao === 'used' ? 'USED' : 'NEW', image: { image_id_list: ids } };
        if (st.p.sku) body.item_sku = st.p.sku; if (st.p.gtin.trim()) body.gtin_code = st.p.gtin.trim();
        if (num(st.p.peso)) body.weight = num(st.p.peso);
        if ([st.p.compr, st.p.larg, st.p.alt].every(x => num(x) > 0)) body.dimension = { package_length: num(st.p.compr), package_width: num(st.p.larg), package_height: num(st.p.alt) };
        body.brand = marca ? { brand_id: marca.brand_id, original_brand_name: marca.original_brand_name } : { brand_id: 0, original_brand_name: 'NoBrand' };
        const at = valsShopee(cn); if (at.length) body.attribute_list = at;
        const r = dado(await MarketplaceAPI.call('shopee_create_item', body));
        const itemId = r?.response?.item_id || r?.item_id;
        const link = itemId ? `https://shopee.com.br/product/${conta}/${itemId}` : null;
        if (!cs.length || !itemId) return { id: itemId, link, txt: String(itemId || 'criado') };
        const eixos = st.vars.eixos.filter(e => e.nome.trim() && e.valores.length);
        try {
          await MarketplaceAPI.call('shopee_init_variation', { shopId: conta, params: {
            item_id: itemId,
            tier_variation: eixos.map(e => ({ name: e.nome.slice(0, 14), option_list: e.valores.map(v => ({ option: v.slice(0, 20) })) })),
            model: cs.map(c => ({ tier_index: c.valores.map((v, i) => eixos[i].valores.indexOf(v)), original_price: precoVar('shopee', c), model_sku: c.sku || '', seller_stock: [{ stock: parseInt(c.estoque) || 0 }] })),
          } });
          return { id: itemId, link, txt: `${itemId} · ${cs.length} variações` };
        } catch (e) { return { id: itemId, link, txt: `${itemId} — criado, mas as variações falharam: ${e.message}. Ajuste no painel da Shopee.`, aviso: true }; }
      },
      async tiktok(conta) {
        const cn = st.canal.tiktok, cs = combos();
        const wr = dado(await MarketplaceAPI.call('tiktok_get_warehouses', { open_id: conta }));
        const vend = (wr?.warehouses || []).filter(w => w.type === 'SALES_WAREHOUSE'); const wh = (vend.find(w => w.is_default) || vend[0])?.id;
        if (!wh) throw new Error('a loja não tem armazém de vendas ativo');
        const imagens = [];
        for (const u of (await fotosPublicas()).slice(0, 9)) {
          let up = await MarketplaceAPI.call('tiktok_upload_image', { open_id: conta, image_url: u, use_case: 'MAIN_IMAGE' }).then(dado).catch(() => null);
          if (!up?.uri) { const f = st.fotos.find(x => x.pub === u); const b64 = f ? await reduzir(f.url, 1200) : null; if (b64) up = dado(await MarketplaceAPI.call('tiktok_upload_image', { open_id: conta, image_base64: b64, use_case: 'MAIN_IMAGE' })); }
          if (up?.uri) imagens.push({ uri: up.uri });
        }
        if (!imagens.length) throw new Error('nenhuma foto foi aceita');
        const sku = (c, preco, q) => ({ seller_sku: c?.sku || st.p.sku || undefined, price: { amount: String(preco), currency: 'BRL' }, inventory: [{ warehouse_id: wh, quantity: q }], ...(st.p.gtin.trim() && !c ? { identifier_code: { code: st.p.gtin.trim() } } : {}), ...(c ? { sales_attributes: c.valores.map((v, i) => ({ name: c.eixos[i], value_name: v })) } : {}) });
        const body = { title: tituloDe('tiktok'), description: h(st.p.descricao).replace(/\n/g, '<br>'), category_id: cn.cat.id, main_images: imagens,
          package_weight: { value: String(num(st.p.peso) || 0), unit: 'KILOGRAM' }, package_dimensions: { length: String(num(st.p.compr) || 0), width: String(num(st.p.larg) || 0), height: String(num(st.p.alt) || 0), unit: 'CENTIMETER' },
          skus: cs.length ? cs.map(c => sku(c, precoVar('tiktok', c), parseInt(c.estoque) || 0)) : [sku(null, num(cn.preco), parseInt(st.p.estoque) || 0)] };
        const at = valsTikTok(cn); if (at.length) body.product_attributes = at;
        const r = dado(await MarketplaceAPI.call('tiktok_create_product', { open_id: conta, body }));
        return { id: r?.product_id, link: null, txt: String(r?.product_id || 'criado') };
      },
    };
    function pendencias() {
      const out = [];
      if (!st.fotos.length) out.push({ passo: 1, t: 'Adicione pelo menos uma foto' });
      if (!st.p.titulo.trim()) out.push({ passo: 1, t: 'Escreva o título' });
      if (!st.p.descricao.trim()) out.push({ passo: 1, t: 'Escreva a descrição' });
      if (st.vars.ativo && !combos().length) out.push({ passo: 2, t: 'Informe os valores das variações (ou desligue)' });
      if (!st.vars.ativo && String(st.p.estoque).trim() === '') out.push({ passo: 1, t: 'Informe o estoque' });
      if (!st.sel.length) out.push({ passo: 3, t: 'Escolha onde publicar' });
      for (const m of mktsSel()) {
        const cn = st.canal[m], M = MKTS[m];
        if (!cn.cat) out.push({ passo: 3, t: `${M.nome}: escolha a categoria` });
        else if (cn.req.some(a => !preenchido(cn, a))) out.push({ passo: 3, t: `${M.nome}: ${cn.req.filter(a => !preenchido(cn, a)).length} campo(s) obrigatório(s) da ficha`, leve: true });
        if (!(num(cn.preco) > 0)) out.push({ passo: 4, t: `${M.nome}: informe o preço` });
        if (m === 'ml' && cn.cat && combos().length && st.vars.eixos.some((e, i) => e.valores.length && !cn.mapaEixo[i])) out.push({ passo: 3, t: 'Mercado Livre: ligue cada variação a um campo do ML (ex.: Cor → Cor)' });
        if (m === 'shopee' && cn.cat && cn.marcaObrig && !cn.marcaId) out.push({ passo: 3, t: 'Shopee: escolha a marca (obrigatória nessa categoria)' });
        if ((m === 'tiktok' || m === 'shopee') && ![st.p.peso, st.p.compr, st.p.larg, st.p.alt].every(x => num(x) > 0)) out.push({ passo: 1, t: `${M.nome}: peso e medidas da embalagem são obrigatórios` });
      }
      return out;
    }
    async function rodarUma(l) {
      l.status = 'enviando'; l.msg = ''; tudo();
      try { const r = await PUB[l.mkt](l.key.slice(l.key.indexOf(':') + 1)); Object.assign(l, { status: r.aviso ? 'aviso' : 'ok', msg: r.txt, link: r.link }); }
      catch (e) { Object.assign(l, { status: 'erro', msg: e.message || String(e) }); }
      tudo();
    }
    async function publicar() {
      const pend = pendencias(), bloq = pend.filter(p => !p.leve);
      if (bloq.length) { st.passo = bloq[0].passo; tudo(); aviso(bloq[0].t); return; }
      const leves = pend.filter(p => p.leve);
      const lista = st.sel.map(contaPorKey).filter(Boolean);
      if (!confirm(`Publicar em ${lista.length} conta(s)?\n\n${lista.map(c => `• ${MKTS[MKT_DE(c.marketplace)].nome} — ${nomeConta(c)}`).join('\n')}${leves.length ? `\n\nAtenção: ${leves.map(l => l.t).join('; ')}. O marketplace pode recusar.` : ''}\n\nOs anúncios são criados de verdade nas contas.`)) return;
      st.pub = { rodando: true, linhas: lista.map(c => ({ key: contaKey(c), mkt: MKT_DE(c.marketplace), nome: nomeConta(c), status: 'fila' })) };
      tudo();
      for (const l of st.pub.linhas) await rodarUma(l);
      st.pub.rodando = false; tudo();
    }
    async function republicar(key) {
      const l = st.pub?.linhas.find(x => x.key === key); if (!l || st.pub.rodando) return;
      st.pub.rodando = true; await rodarUma(l); st.pub.rodando = false; tudo();
    }

    // ── Aviso curto ─────────────────────────────────────────────
    function aviso(t) { const a = document.getElementById('ca-aviso'); if (!a) return; a.textContent = t; a.classList.add('on'); clearTimeout(a._t); a._t = setTimeout(() => a.classList.remove('on'), 4500); }

    // ── Render ──────────────────────────────────────────────────
    const PASSOS = [['Produto e fotos', 'o que é e como é'], ['Variações', 'cor, tamanho…'], ['Onde publicar', 'contas, categoria e ficha'], ['Preço e margem', 'quanto sobra por venda'], ['Revisar e publicar', 'nota e envio']];
    const passoOk = i => {
      if (i === 1) return !st.vars.ativo || combos().length > 0;
      if (i === 4) return !!st.pub && st.pub.linhas.every(l => l.status === 'ok');
      const p = pendencias().filter(x => x.passo === i + 1 && !x.leve);
      return !p.length && (i !== 2 || st.sel.length > 0) && (i !== 3 || mktsSel().length > 0);
    };
    const campo = (id, rot, val, extra = '') => `<label class="ca-f"><span>${rot}</span><input class="form-input" id="ca-${id}" value="${h(val)}" ${extra} oninput="_ca.p('${id}',this.value)"></label>`;

    function telaProduto() {
      const p = st.p;
      return `<section class="ca-bloco">
        <h4>Fotos <span class="ca-dica">${st.fotos.length} de até 10 · a primeira é a capa</span></h4>
        <div class="ca-fotos" ondragover="event.preventDefault();this.classList.add('arr')" ondragleave="this.classList.remove('arr')" ondrop="event.preventDefault();this.classList.remove('arr');_ca.arquivos(event.dataTransfer.files)">
          ${st.fotos.map((f, i) => `<figure class="ca-foto${i === 0 ? ' capa' : ''}"><button type="button" class="ca-foto-ver" title="Ampliar" aria-label="Ampliar foto ${i + 1}" onclick="_ca.ver(${i})"><img src="${h(f.url)}" alt="foto ${i + 1}"></button>${i === 0 ? '<b>Capa</b>' : ''}${f.ia ? `<i>${h(KIT[f.tipo] ? KIT[f.tipo].replace(/ \(.*\)/, '') : 'IA')}</i>` : ''}
            <div class="ca-foto-ac">${i > 0 ? `<button type="button" title="Mover para a esquerda" onclick="_ca.moverFoto(${i},-1)">‹</button><button type="button" title="Usar como capa" onclick="_ca.capa(${i})">★</button>` : ''}${i < st.fotos.length - 1 ? `<button type="button" title="Mover para a direita" onclick="_ca.moverFoto(${i},1)">›</button>` : ''}<button type="button" title="Remover" onclick="_ca.tirarFoto(${i})">✕</button></div></figure>`).join('')}
          <label class="ca-foto-add"><input type="file" accept="image/*" multiple onchange="_ca.arquivos(this.files)"><span>＋</span><small>${st.fotos.length ? 'Mais fotos' : 'Arraste as fotos aqui ou clique'}</small></label>
        </div>
        ${st.gerando.length ? `<div class="ca-gerando">${st.gerando.map(g => `<div class="ca-ger ${g.status}"><span>${g.status === 'erro' ? '!' : ''}</span><b>${h(KIT[g.t])}</b><small>${g.status === 'erro' ? h(g.msg || 'falhou') : 'gerando…'}</small></div>`).join('')}</div>` : ''}
        <div class="ca-ia">
          <button class="btn btn-primary btn-sm" ${!st.fotos.length || st.gerando.some(g => g.status === 'gerando') ? 'disabled' : ''} onclick="_ca.kit()">${st.gerando.some(g => g.status === 'gerando') ? 'Gerando fotos…' : 'Gerar fotos com IA'}</button>
          <span class="ca-dica">A IA usa a primeira foto real como referência e mantém o produto igual.</span>
        </div>
        ${st.kitAberto ? `<div class="ca-kit"><div class="ca-sub" style="margin-top:0">Quais fotos gerar</div><div class="ca-kit-op">${Object.entries(KIT).map(([k, t]) => `<label class="ca-conta${st.kit.includes(k) ? ' on' : ''}"><input type="checkbox" ${st.kit.includes(k) ? 'checked' : ''} onchange="_ca.kitTipo('${k}',this.checked)">${t}</label>`).join('')}</div>
          <div class="ca-ia"><button class="btn btn-primary btn-sm" onclick="_ca.gerarKit()">Gerar ${Math.min(st.kit.length, 10 - st.fotos.length)} foto(s)</button><button class="btn btn-secondary btn-sm" onclick="_ca.kit()">Cancelar</button><span class="ca-dica">Cerca de 20 segundos; elas aparecem conforme ficam prontas.</span></div></div>` : ''}
      </section>
      <section class="ca-bloco">
        <label class="ca-f"><span>Título <em id="ca-cont-tit">${p.titulo.length} caracteres</em></span><input class="form-input" id="ca-titulo" value="${h(p.titulo)}" placeholder="Ex.: Armário de Cozinha 4 Portas MDF Branco" oninput="_ca.p('titulo',this.value)"></label>
        <label class="ca-f"><span>Descrição</span><textarea class="form-textarea" id="ca-descricao" rows="7" placeholder="Material, medidas, o que vem na caixa, diferenciais…" oninput="_ca.p('descricao',this.value)">${h(p.descricao)}</textarea></label>
        <div class="ca-ia" style="margin-top:0;margin-bottom:12px"><button class="btn btn-primary btn-sm" ${st.iaTexto ? 'disabled' : ''} onclick="_ca.iaSEO()">${st.iaTexto ? 'Pesquisando buscas e escrevendo…' : 'Criar título e descrição com SEO (IA)'}</button><span class="ca-dica">Usa as buscas reais do Mercado Livre (sugestões, termos em alta e mais vendidos da categoria).</span></div>
        ${st.seo ? `<div class="ca-seo">
          <div class="ca-sub" style="margin-top:0">Títulos por canal</div>
          ${['ml', 'shopee', 'tiktok'].map(m => { const t = m === 'ml' ? st.p.titulo : st.canal[m].titulo || st.p.titulo; return `<div class="ca-seo-t" style="--c:${MKTS[m].cor}"><b>${MKTS[m].nome}</b><span>${h(t)}</span><em>${t.length}/${MKTS[m].tituloMax}</em></div>`; }).join('')}
          ${st.seo.chaves.length ? `<div class="ca-sub">Palavras-chave usadas</div><div class="ca-chips ca-chips-ro">${st.seo.chaves.map((c, i) => `<span class="ca-chip${i === 0 || c === st.seo.principal ? ' forte' : ''}">${h(c)}</span>`).join('')}</div>` : ''}
          <div class="ca-dica" style="margin-top:6px">Fonte: ${st.seo.fontes.categoria ? `categoria ${h(st.seo.fontes.categoria.nome || st.seo.fontes.categoria.id)} · ` : ''}${st.seo.fontes.busca || 0} sugestões da busca · ${st.seo.fontes.em_alta || 0} termos em alta · ${st.seo.fontes.mais_vendidos || 0} mais vendidos. Os títulos da Shopee e do TikTok ficam editáveis na etapa 3.</div>
          ${st.seo.faltam.length ? `<div class="ca-sub">Para completar o anúncio, informe</div><ul class="ca-pend">${st.seo.faltam.map(f => `<li class="leve">${h(f)}</li>`).join('')}</ul>` : ''}
        </div>` : ''}
        <div class="ca-g4">
          ${campo('marca', 'Marca', p.marca)}${campo('sku', 'SKU', p.sku)}${campo('gtin', 'Código de barras (EAN)', p.gtin, 'inputmode="numeric" placeholder="se tiver"')}
          <label class="ca-f"><span>Condição</span><select class="form-select" id="ca-condicao" onchange="_ca.p('condicao',this.value)"><option value="new" ${p.condicao === 'new' ? 'selected' : ''}>Novo</option><option value="used" ${p.condicao === 'used' ? 'selected' : ''}>Usado</option></select></label>
        </div>
      </section>
      <section class="ca-bloco">
        <h4>Embalagem, custo e estoque</h4>
        <div class="ca-g4">
          ${campo('peso', 'Peso (kg)', p.peso, 'inputmode="decimal"')}${campo('compr', 'Comprimento (cm)', p.compr, 'inputmode="decimal"')}${campo('larg', 'Largura (cm)', p.larg, 'inputmode="decimal"')}${campo('alt', 'Altura (cm)', p.alt, 'inputmode="decimal"')}
          ${campo('custo', 'Custo do produto (R$)', p.custo, 'inputmode="decimal" placeholder="para a margem"')}
          ${st.vars.ativo ? `<div class="ca-f"><span>Estoque</span><div class="ca-fixo">${estoqueTotal()} (soma das variações)</div></div>` : campo('estoque', 'Estoque', p.estoque, 'inputmode="numeric"')}
          ${campo('garantia', 'Garantia', p.garantia, 'placeholder="ex.: 3 meses"')}
        </div>
      </section>`;
    }
    function telaVariacoes() {
      const cs = combos();
      return `<section class="ca-bloco">
        <label class="ca-switch"><input type="checkbox" id="ca-vars" ${st.vars.ativo ? 'checked' : ''} onchange="_ca.varsAtivo(this.checked)"><span></span>Este produto tem variações (cor, tamanho, voltagem…)</label>
        ${!st.vars.ativo ? '<p class="ca-dica" style="margin:10px 0 0">Sem variações: um anúncio só, com o estoque da etapa 1.</p>' : `
        <div class="ca-eixos">${st.vars.eixos.map((e, i) => `<div class="ca-eixo">
          <input class="form-input" id="ca-eixo-nome-${i}" value="${h(e.nome)}" placeholder="Nome (ex.: Cor)" oninput="_ca.eixoNome(${i},this.value)">
          <div class="ca-chips" onclick="document.getElementById('ca-eixo-${i}').focus()">${e.valores.map((v, j) => `<span class="ca-chip">${h(v)}<button type="button" aria-label="Tirar ${h(v)}" onclick="_ca.tirarValor(${i},${j})">✕</button></span>`).join('')}
            <input class="ca-chip-in" id="ca-eixo-${i}" placeholder="${e.valores.length ? '+ valor' : 'Digite e tecle Enter (ex.: Azul)'}" onkeydown="if(event.key==='Enter'||event.key===','){event.preventDefault();_ca.addValor(${i},this.value)}" onblur="if(this.value.trim())_ca.addValor(${i},this.value)"></div>
          ${st.vars.eixos.length > 1 ? `<button class="btn btn-secondary btn-sm" onclick="_ca.tirarEixo(${i})">Remover</button>` : '<span></span>'}
        </div>`).join('')}
        ${st.vars.eixos.length < 2 ? '<div><button class="btn btn-secondary btn-sm" onclick="_ca.addEixo()">+ Segunda variação (ex.: Tamanho)</button></div>' : ''}</div>
        ${cs.length ? `<div class="ca-tab-w"><table class="ca-tab"><thead><tr><th>Variação</th><th>Foto</th><th>SKU</th><th>Estoque</th><th>Preço próprio</th></tr></thead><tbody>
          ${cs.map((c, k) => `<tr><td><b>${h(c.chave)}</b></td>
            <td><select class="form-select ca-sm" id="ca-vf-${k}" onchange="_ca.linha(${k},'foto',this.value)"><option value="">capa</option>${st.fotos.map((f, i) => `<option value="${i}" ${String(c.foto) === String(i) ? 'selected' : ''}>foto ${i + 1}</option>`).join('')}</select></td>
            <td><input class="form-input ca-sm" id="ca-vs-${k}" value="${h(c.sku || '')}" oninput="_ca.linha(${k},'sku',this.value)"></td>
            <td><input class="form-input ca-sm" id="ca-ve-${k}" inputmode="numeric" value="${h(c.estoque || '')}" oninput="_ca.linha(${k},'estoque',this.value)"></td>
            <td><input class="form-input ca-sm" id="ca-vp-${k}" inputmode="decimal" value="${h(c.preco || '')}" placeholder="igual" oninput="_ca.linha(${k},'preco',this.value)"></td></tr>`).join('')}
        </tbody></table></div>
        <div class="ca-ia"><button class="btn btn-secondary btn-sm" onclick="_ca.skusAuto()">Gerar SKUs a partir do SKU base</button><span class="ca-dica" id="ca-vars-tot">${cs.length} combinações · estoque total ${estoqueTotal()}. No Mercado Livre cada variação vira um anúncio da mesma família.</span></div>` : ''}`}
      </section>`;
    }
    function telaCanais() {
      const foco = contasDoCliente();
      const lista = st.contas.filter(c => st.todasContas || !foco || foco.has(idConta(c)) || st.sel.includes(contaKey(c)));
      const grupos = Object.keys(MKTS).map(m => [m, lista.filter(c => MKT_DE(c.marketplace) === m)]).filter(([, l]) => l.length);
      const contasHtml = st.carregandoContas ? '<div class="ca-dica">Carregando contas…</div>' : st.erroContas ? `<div class="ca-erro">${h(st.erroContas)}</div>` : `
        ${window._portalConfig ? '' : foco ? `<div class="ca-dica" style="margin-bottom:8px">${st.todasContas ? 'Mostrando todas as contas.' : 'Contas do cliente em foco.'} <a href="javascript:_ca.todas()">${st.todasContas ? 'Só as do cliente' : 'Ver todas'}</a></div>` : '<div class="ca-dica" style="margin-bottom:8px">Dica: escolha o cliente no topo para listar só as contas dele.</div>'}
        <div class="ca-contas">${grupos.map(([m, l]) => `<div><div class="ca-cgt" style="--c:${MKTS[m].cor}">${MKTS[m].nome}</div>${l.map(c => { const k = contaKey(c); return `<label class="ca-conta${st.sel.includes(k) ? ' on' : ''}"><input type="checkbox" ${st.sel.includes(k) ? 'checked' : ''} onchange="_ca.conta('${h(k)}',this.checked)">${h(nomeConta(c))}</label>`; }).join('')}</div>`).join('') || '<div class="ca-dica">Nenhuma conta de Mercado Livre, Shopee ou TikTok Shop conectada.</div>'}</div>`;
      return `<section class="ca-bloco"><h4>Contas</h4>${contasHtml}
        <p class="ca-dica" style="margin:8px 0 0">Amazon, Magalu e Shein ainda não entram aqui (a ficha deles é por modelo de produto) — crie pelo painel do marketplace.</p></section>
        ${mktsSel().map(telaCanal).join('')}`;
    }
    function campoAttr(m, a) {
      const cn = st.canal[m], v = cn.vals[a.id], idc = `ca-at-${m}-${String(a.id).replace(/[^\w-]/g, '_')}`, ida = h(String(a.id)).replace(/'/g, '&#39;');
      let inp;
      if (a.tipo === 'lista') inp = `<select class="form-select" id="${idc}" onchange="_ca.attr('${m}','${ida}',this.value)"><option value="">—</option>${a.opcoes.map(o => `<option value="${h(o.id)}" ${String(v) === String(o.id) ? 'selected' : ''}>${h(o.nome)}</option>`).join('')}</select>`;
      else if (a.tipo === 'multi') inp = `<select class="form-select" id="${idc}" multiple size="3" onchange="_ca.attrMulti('${m}','${ida}',this)">${a.opcoes.map(o => `<option value="${h(o.id)}" ${(Array.isArray(v) ? v : []).map(String).includes(String(o.id)) ? 'selected' : ''}>${h(o.nome)}</option>`).join('')}</select>`;
      else if (a.tipo === 'numero') inp = `<div class="ca-nu"><input class="form-input" id="${idc}" inputmode="decimal" value="${h(v?.num || '')}" oninput="_ca.attrNum('${m}','${ida}',this.value,null)">${a.unidades?.length ? `<select class="form-select" id="${idc}-u" onchange="_ca.attrNum('${m}','${ida}',null,this.value)">${a.unidades.map(u => `<option ${(v?.unit || unidadeBoa(a)) === u ? 'selected' : ''}>${h(u)}</option>`).join('')}</select>` : ''}</div>`;
      else inp = `<input class="form-input" id="${idc}" value="${h(v || '')}" ${a.max ? `maxlength="${a.max}"` : ''} oninput="_ca.attr('${m}','${ida}',this.value)">`;
      return `<label class="ca-f${a.obrig && !preenchido(cn, a) ? ' falta' : ''}"><span>${h(a.nome)}${a.obrig ? ' <i>*</i>' : ''}</span>${inp}${a.dica ? `<small>${h(String(a.dica).slice(0, 140))}</small>` : ''}</label>`;
    }
    function telaCanal(m) {
      const cn = st.canal[m], M = MKTS[m], nSel = selDe(m).length, okReq = cn.req.filter(a => preenchido(cn, a)).length;
      return `<section class="ca-bloco ca-canal" style="--c:${M.cor}">
        <div class="ca-canal-h"><b>${M.nome}</b><span>${nSel} conta(s)</span></div>
        <div class="ca-sub">Categoria</div>
        ${cn.cat ? `<div class="ca-cat"><div><b>${h(cn.cat.nome)}</b>${cn.cat.extra ? `<small>${h(cn.cat.extra)}</small>` : ''}</div><button class="btn btn-secondary btn-sm" onclick="_ca.trocarCat('${m}')">Trocar</button></div>` : `
          <div class="ca-catbusca"><input class="form-input" id="ca-cat-${m}" value="${h(cn.catBusca || st.termoCategoria || st.p.titulo)}" placeholder="Tipo do produto (ex.: armário de cozinha)" oninput="_ca.catBusca('${m}',this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();_ca.buscarCat('${m}')}">
            <button class="btn btn-primary btn-sm" ${cn.buscando ? 'disabled' : ''} onclick="_ca.buscarCat('${m}')">${cn.buscando ? 'Buscando…' : 'Sugerir categoria'}</button>
            ${m === 'shopee' ? `<button class="btn btn-secondary btn-sm" ${cn.buscando ? 'disabled' : ''} onclick="_ca.buscarCat('${m}',true)">Procurar na lista</button>` : ''}</div>
          ${cn.aviso ? `<div class="ca-dica">${h(cn.aviso)}</div>` : ''}
          ${cn.catRes.length ? `<div class="ca-catres">${cn.catRes.map((c, i) => `<button type="button" onclick="_ca.cat('${m}',${i})"><b>${h(c.nome)}</b>${c.extra ? `<small>${h(c.extra)}</small>` : ''}</button>`).join('')}</div>` : ''}`}
        ${cn.carregando ? '<div class="ca-dica">Carregando a ficha técnica…</div>' : ''}
        ${cn.cat && cn.aviso && !cn.carregando ? `<div class="ca-erro">${h(cn.aviso)}</div>` : ''}
        ${cn.cat && !cn.carregando ? `
          <div class="ca-g3">
            <label class="ca-f"><span>Título neste canal <em>${(cn.titulo || st.p.titulo).length}/${M.tituloMax}</em></span><input class="form-input" id="ca-tit-${m}" maxlength="${M.tituloMax}" value="${h(cn.titulo)}" placeholder="${h(st.p.titulo.slice(0, M.tituloMax))}" oninput="_ca.canal('${m}','titulo',this.value)"></label>
            ${m === 'ml' ? `<label class="ca-f"><span>Tipo de anúncio</span><select class="form-select" id="ca-tipo-ml" onchange="_ca.canal('ml','tipo',this.value)">${LISTING_ML.map(t => `<option value="${t.id}" ${cn.tipo === t.id ? 'selected' : ''}>${t.nome}</option>`).join('')}</select></label>` : ''}
            ${m === 'shopee' ? `<label class="ca-f${cn.marcaObrig && !cn.marcaId ? ' falta' : ''}"><span>Marca na Shopee${cn.marcaObrig ? ' <i>*</i>' : ''}</span><select class="form-select" id="ca-marca-sp" onchange="_ca.canal('shopee','marcaId',this.value,true)"><option value="">${cn.marcaObrig ? '— escolha —' : 'Sem marca'}</option>${cn.marcas.map(b => `<option value="${b.brand_id}" ${String(cn.marcaId) === String(b.brand_id) ? 'selected' : ''}>${h(b.display_brand_name || b.original_brand_name)}</option>`).join('')}</select></label>` : ''}
          </div>
          ${m === 'ml' && combos().length ? `<div class="ca-sub">Variações no Mercado Livre</div>${cn.varAttrs.length ? `<div class="ca-g3">${st.vars.eixos.map((e, i) => e.valores.length ? `<label class="ca-f${!cn.mapaEixo[i] ? ' falta' : ''}"><span>${h(e.nome)} → campo do ML</span><select class="form-select" id="ca-mapa-${i}" onchange="_ca.mapa(${i},this.value)"><option value="">— escolha —</option>${cn.varAttrs.map(a => `<option value="${h(a.id)}" ${cn.mapaEixo[i] === a.id ? 'selected' : ''}>${h(a.nome)}</option>`).join('')}</select></label>` : '').join('')}</div>` : '<div class="ca-erro">Esta categoria do ML não aceita variações — publique sem variações ou troque a categoria.</div>'}` : ''}
          <div class="ca-sub ca-ficha-h"><span>Ficha técnica · obrigatórios ${okReq}/${cn.req.length}</span><button class="btn btn-secondary btn-sm" ${cn.iaFicha ? 'disabled' : ''} onclick="_ca.iaFicha('${m}')">${cn.iaFicha ? 'Preenchendo…' : 'Preencher com IA'}</button></div>
          <div class="ca-g3">${cn.req.map(a => campoAttr(m, a)).join('') || '<div class="ca-dica">Sem campos obrigatórios.</div>'}</div>
          ${cn.opt.length ? `<button class="ca-mais" onclick="_ca.opc('${m}')">${cn.mostrarOpc ? '▾' : '▸'} Campos extras (${cn.opt.filter(a => preenchido(cn, a)).length}/${cn.opt.length} preenchidos) — ajudam nos filtros da busca</button>${cn.mostrarOpc ? `<div class="ca-g3">${cn.opt.map(a => campoAttr(m, a)).join('')}</div>` : ''}` : ''}` : ''}
      </section>`;
    }
    const corMargem = mg => !mg ? 'var(--text-muted)' : mg.margem >= st.margemAlvo ? 'var(--green)' : mg.margem > 0 ? 'var(--yellow)' : 'var(--red)';
    function linhaMargem(m) {
      const cn = st.canal[m], M = MKTS[m], sug = precoParaMargem(m, st.margemAlvo);
      return `<section class="ca-bloco ca-canal" style="--c:${M.cor}">
        <div class="ca-canal-h"><b>${M.nome}</b>${m === 'ml' ? `<span>${LISTING_ML.find(t => t.id === cn.tipo)?.nome || ''}</span>` : `<span>${selDe(m).length} conta(s)</span>`}</div>
        <div class="ca-preco">
          <label class="ca-f"><span>Preço de venda (R$)</span><input class="form-input ca-grande" id="ca-preco-${m}" inputmode="decimal" value="${h(cn.preco)}" oninput="_ca.preco('${m}',this.value)"></label>
          ${m === 'ml' ? `<label class="ca-f"><span>Frete que você paga (R$)</span><div class="ca-nu"><input class="form-input" id="ca-frete-ml" inputmode="decimal" value="${h(cn.frete)}" placeholder="0" oninput="_ca.frete(this.value)"><button class="btn btn-secondary btn-sm" onclick="_ca.estimarFrete()">Estimar</button></div></label>` : ''}
          <div id="ca-sug-${m}">${sug ? `<button class="btn btn-secondary btn-sm" onclick="_ca.usarSug('${m}',${sug.toFixed(2)})">Usar ${R$(sug)} · margem ${st.margemAlvo}%</button>` : '<span class="ca-dica">Com o custo (etapa 1) eu sugiro o preço pela margem.</span>'}</div>
        </div>
        <div id="ca-mg-${m}">${tabelaMargem(m)}</div>
      </section>`;
    }
    function tabelaMargem(m) {
      const mg = contaMargem(m), al = aliquotaDe(m);
      if (!mg) return '<div class="ca-dica" style="margin-top:8px">Digite o preço para ver taxas e lucro.</div>';
      const barra = [['Custo', mg.custo, '#64748b'], ['Comissão', mg.comissao + mg.fixa, MKTS[m].cor], ['Frete', mg.frete, '#0ea5e9'], ['Imposto', mg.imposto, '#a855f7'], ['ADS', mg.ads, '#f59e0b'], ['Lucro', Math.max(0, mg.lucro), 'var(--green)']].filter(x => x[1] > 0);
      return `<div class="ca-barra" role="img" aria-label="composição do preço">${barra.map(([t, v, c]) => `<i style="width:${Math.min(100, v / mg.preco * 100)}%;background:${c}" title="${t}: ${R$(v)}"></i>`).join('')}</div>
        <div class="ca-leg">${barra.map(([t, v, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('')}</div>
        <div class="ca-mg">
          <div><span>Comissão ${pct(mg.pc)}${mg.fixa ? ` + ${R$(mg.fixa)} fixa` : ''}${mg.est ? ' <em>estimada</em>' : ''}</span><b>− ${R$(mg.comissao + mg.fixa)}</b></div>
          ${m === 'ml' ? `<div><span>Frete</span><b>− ${R$(mg.frete)}</b></div>` : ''}
          <div><span>Imposto ${pct(al.a)}${al.varia ? ' <em>maior alíquota entre as contas</em>' : !al.a ? ' <em>sem alíquota cadastrada</em>' : ''}</span><b>− ${R$(mg.imposto)}</b></div>
          ${mg.ads ? `<div><span>ADS ${pct(num(st.adsPct))}</span><b>− ${R$(mg.ads)}</b></div>` : ''}
          <div><span>Custo do produto</span><b>${mg.custo ? `− ${R$(mg.custo)}` : '<em>não informado</em>'}</b></div>
          <div class="tot"><span>Lucro por venda</span><b style="color:${corMargem(mg)}">${R$(mg.lucro)} · ${pct(mg.margem)}</b></div>
        </div>`;
    }
    function telaPreco() {
      if (!mktsSel().length) return '<section class="ca-bloco"><div class="ca-dica">Escolha as contas na etapa 3 para calcular o preço de cada canal.</div></section>';
      return `<section class="ca-bloco"><div class="ca-g3">
          <label class="ca-f"><span>Margem desejada (%)</span><input class="form-input" id="ca-margem" inputmode="decimal" value="${h(st.margemAlvo)}" oninput="_ca.global('margemAlvo',this.value)"></label>
          <label class="ca-f"><span>ADS previsto (% do preço)</span><input class="form-input" id="ca-ads" inputmode="decimal" value="${h(st.adsPct)}" oninput="_ca.global('adsPct',this.value)"></label>
          <label class="ca-f"><span>Custo do produto (R$)</span><input class="form-input" id="ca-custo2" inputmode="decimal" value="${h(st.p.custo)}" oninput="_ca.p('custo',this.value)"></label>
        </div></section>${mktsSel().map(linhaMargem).join('')}
        <p class="ca-dica">Shopee: tabela de comissão por faixa de preço de 2026 (CNPJ). TikTok Shop: 12% + R$ 5. Mercado Livre: comissão da própria API para a categoria e o tipo de anúncio. O imposto vem da alíquota cadastrada na conta do cliente.</p>`;
    }
    function telaRevisar() {
      const pend = pendencias();
      const ROT = { fila: 'Na fila', enviando: 'Enviando…', ok: 'Publicado', aviso: 'Publicado com aviso', erro: 'Erro' };
      const pubHtml = st.pub ? `<section class="ca-bloco"><h4>Publicação</h4><div class="ca-pub">${st.pub.linhas.map(l => `<div class="ca-publ ${l.status}"><span class="ca-pubst">${ROT[l.status]}</span><b>${h(MKTS[l.mkt].nome)} — ${h(l.nome)}</b>
        <span class="ca-pubac">${l.link ? `<a class="btn btn-secondary btn-sm" href="${h(l.link)}" target="_blank" rel="noopener">Abrir</a>` : ''}${l.status === 'erro' && !st.pub.rodando ? `<button class="btn btn-secondary btn-sm" onclick="_ca.republicar('${h(l.key)}')">Tentar de novo</button>` : ''}</span>${l.msg ? `<small>${h(l.msg)}</small>` : ''}</div>`).join('')}</div>
        ${!st.pub.rodando ? '<div class="ca-ia"><button class="btn btn-primary btn-sm" onclick="_ca.novo()">Criar outro anúncio</button><button class="btn btn-secondary btn-sm" onclick="_ca.limparPub()">Voltar a editar</button></div>' : ''}</section>` : '';
      return `${pubHtml}
        <section class="ca-bloco"><h4>Resumo por canal</h4>
          <div class="ca-resumo">${mktsSel().map(m => { const n = nota(m), mg = contaMargem(m); return `<div class="ca-rc" style="--c:${MKTS[m].cor}"><div class="ca-rc-h"><b>${MKTS[m].nome}</b>${anel(n.total, 44)}</div>
            <div>${selDe(m).length} conta(s) · ${h(st.canal[m].cat?.nome || 'sem categoria')}</div><div>${mg ? `${R$(mg.preco)} · lucro ${R$(mg.lucro)} (${pct(mg.margem)})` : 'sem preço'}</div><div>${combos().length ? `${combos().length} variações · estoque ${estoqueTotal()}` : `estoque ${estoqueTotal()}`}</div></div>`; }).join('') || '<div class="ca-dica">Nenhuma conta escolhida.</div>'}</div></section>
        ${st.pub && !st.pub.rodando ? '' : `<section class="ca-bloco"><h4>${pend.length ? 'Antes de publicar' : 'Tudo pronto'}</h4>
          ${pend.length ? `<ul class="ca-pend">${pend.map(p => `<li class="${p.leve ? 'leve' : ''}"><a href="javascript:_ca.ir(${p.passo})">${h(p.t)}</a>${p.leve ? ' <em>recomendado</em>' : ''}</li>`).join('')}</ul>` : '<p class="ca-dica">Confira a prévia de cada canal ao lado e publique.</p>'}
          <button class="btn btn-primary ca-publicar" ${st.pub?.rodando || pend.some(p => !p.leve) ? 'disabled' : ''} onclick="_ca.publicar()">${st.pub?.rodando ? 'Publicando…' : `Publicar em ${st.sel.length} conta(s)`}</button>
        </section>`}`;
    }
    function anel(v, tam = 64) {
      const r = tam / 2 - 5, c = 2 * Math.PI * r, cor = v >= 85 ? 'var(--green)' : v >= 60 ? 'var(--yellow)' : 'var(--red)';
      return `<svg class="ca-anel" width="${tam}" height="${tam}" viewBox="0 0 ${tam} ${tam}" role="img" aria-label="nota ${v} de 100"><circle cx="${tam / 2}" cy="${tam / 2}" r="${r}" fill="none" stroke="var(--border)" stroke-width="5"/><circle cx="${tam / 2}" cy="${tam / 2}" r="${r}" fill="none" stroke="${cor}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(c * v / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${tam / 2} ${tam / 2})"/><text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" font-size="${Math.round(tam / 3.4)}" font-weight="700" fill="var(--text-primary)">${v}</text></svg>`;
    }
    function lado() {
      const ms = mktsSel().length ? mktsSel() : Object.keys(MKTS);
      if (!ms.includes(st.prevMkt)) st.prevMkt = ms[0];
      const m = st.prevMkt, cn = st.canal[m], M = MKTS[m], n = nota(m);
      const capa = st.fotos[0]?.url, preco = num(cn.preco), tit = (cn.titulo || st.p.titulo || 'Título do anúncio').slice(0, M.tituloMax);
      const eixos = st.vars.ativo ? st.vars.eixos.filter(e => e.valores.length) : [];
      return `<div class="ca-prev-tabs">${ms.map(k => `<button class="${k === m ? 'on' : ''}" style="--c:${MKTS[k].cor}" onclick="_ca.prev('${k}')">${MKTS[k].nome}</button>`).join('')}</div>
        <div class="ca-prev ca-prev-${m}">
          <div class="ca-prev-img">${capa ? `<button type="button" class="ca-foto-ver" title="Ampliar" aria-label="Ampliar a capa" onclick="_ca.ver(0)"><img src="${h(capa)}" alt="capa"></button>` : '<span>Sem foto</span>'}${st.fotos.length > 1 ? `<em>1/${st.fotos.length}</em>` : ''}</div>
          <div class="ca-prev-b">
            ${st.fotos.length > 1 ? `<div class="ca-prev-th">${st.fotos.slice(1, 6).map((f, i) => `<button type="button" class="ca-foto-ver" aria-label="Ampliar foto ${i + 2}" onclick="_ca.ver(${i + 1})"><img src="${h(f.url)}" alt=""></button>`).join('')}</div>` : ''}
            ${m === 'ml' ? `<small class="ca-prev-cond">${st.p.condicao === 'used' ? 'Usado' : 'Novo'}</small>` : ''}
            <div class="ca-prev-t">${h(tit)}</div>
            <div class="ca-prev-p">${preco ? R$(preco) : 'R$ —'}</div>
            ${m === 'ml' && preco ? `<div class="ca-prev-s">${cn.tipo === 'gold_pro' ? `em 10x ${R$(preco / 10)} sem juros` : 'em até 12x no cartão'}</div>${preco >= 79 ? '<div class="ca-prev-fg">Frete grátis</div>' : ''}` : ''}
            ${m === 'shopee' && preco ? '<div class="ca-prev-s">Frete grátis com cupom</div>' : ''}
            ${eixos.map(e => `<div class="ca-prev-v"><small>${h(e.nome)}</small><div>${e.valores.slice(0, 6).map((v, i) => `<span class="${i === 0 ? 'on' : ''}">${h(v)}</span>`).join('')}</div></div>`).join('')}
            <div class="ca-prev-btn">${m === 'tiktok' ? 'Comprar' : 'Comprar agora'}</div>
          </div>
        </div>
        <div class="ca-nota">${anel(n.total)}<div><b>Nota no ${M.nome}</b><small>${n.total >= 85 ? 'Pronto para vender bem' : n.total >= 60 ? 'Bom, dá para melhorar' : 'Falta bastante coisa'}</small></div></div>
        ${n.faltam.length ? `<ul class="ca-falta">${n.faltam.slice(0, 5).map(f => `<li><b>+${f.ganha}</b> <span><strong>${h(f.t)}</strong>: ${h(f.dica)}</span></li>`).join('')}</ul>` : '<p class="ca-dica">Nada faltando neste canal.</p>'}
        <p class="ca-dica" style="margin:10px 0 0">Prévia aproximada — o marketplace monta a página final.</p>`;
    }

    function tudo() {
      if (window._caSt !== st) return;
      const root = el.querySelector('#ca-root'); if (!root) return;
      const ae = document.activeElement, ativo = ae && root.contains(ae) ? ae.id : null; let sel = null; try { sel = [ae.selectionStart, ae.selectionEnd]; } catch (x) {}
      root.querySelector('.ca-passos').innerHTML = PASSOS.map(([t, s], i) => `<button class="${st.passo === i + 1 ? 'on' : ''}${passoOk(i) ? ' ok' : ''}" ${st.passo === i + 1 ? 'aria-current="step"' : ''} onclick="_ca.ir(${i + 1})"><span>${passoOk(i) && st.passo !== i + 1 ? '✓' : i + 1}</span><b>${t}</b><small>${s}</small></button>`).join('');
      root.querySelector('.ca-main').innerHTML = [telaProduto, telaVariacoes, telaCanais, telaPreco, telaRevisar][st.passo - 1]()
        + `<div class="ca-nav">${st.passo > 1 ? `<button class="btn btn-secondary" onclick="_ca.ir(${st.passo - 1})">Voltar</button>` : '<span></span>'}${st.passo < 5 ? `<button class="btn btn-primary" onclick="_ca.ir(${st.passo + 1})">Continuar</button>` : ''}</div>`;
      root.querySelector('.ca-lado').innerHTML = lado();
      if (ativo) { const e = document.getElementById(ativo); if (e) { e.focus(); if (sel && sel[0] != null) try { e.setSelectionRange(sel[0], sel[1]); } catch (x) {} } }
    }
    function ladoSo() { const l = el.querySelector('.ca-lado'); if (l) l.innerHTML = lado(); const p = el.querySelector('.ca-passos'); if (p) p.querySelectorAll('button').forEach((b, i) => { b.classList.toggle('ok', passoOk(i)); const s = b.querySelector('span'); if (s) s.textContent = passoOk(i) && st.passo !== i + 1 ? '✓' : i + 1; }); }
    function ladoEPreco() {
      ladoSo();
      for (const m of mktsSel()) {
        const d = el.querySelector(`#ca-mg-${m}`); if (d) d.innerHTML = tabelaMargem(m);
        const s = el.querySelector(`#ca-sug-${m}`), sug = precoParaMargem(m, st.margemAlvo);
        if (s) s.innerHTML = sug ? `<button class="btn btn-secondary btn-sm" onclick="_ca.usarSug('${m}',${sug.toFixed(2)})">Usar ${R$(sug)} · margem ${st.margemAlvo}%</button>` : '<span class="ca-dica">Com o custo (etapa 1) eu sugiro o preço pela margem.</span>';
      }
    }

    // ── Visualizador de fotos ───────────────────────────────────
    function desenharVisor() {
      let v = document.getElementById('ca-visor');
      if (st.verFoto == null || !st.fotos[st.verFoto]) { if (v) v.remove(); document.removeEventListener('keydown', teclaVisor); st.verFoto = null; return; }
      if (!v) { v = document.createElement('div'); v.id = 'ca-visor'; v.setAttribute('role', 'dialog'); v.setAttribute('aria-modal', 'true'); v.setAttribute('aria-label', 'Foto ampliada'); document.body.appendChild(v); v.addEventListener('click', e => { if (e.target === v || e.target.classList.contains('ca-visor-palco')) window._ca.fecharVer(); }); document.addEventListener('keydown', teclaVisor); }
      const i = st.verFoto, f = st.fotos[i], n = st.fotos.length;
      const rot = i === 0 ? 'Capa' : f.tipo && KIT[f.tipo] ? KIT[f.tipo] : f.ia ? 'Gerada por IA' : `Foto ${i + 1}`;
      v.innerHTML = `<div class="ca-visor-topo"><span><b>${i + 1}</b> de ${n} · ${h(rot)}${f.ia && i === 0 && f.tipo && KIT[f.tipo] ? ` · ${h(KIT[f.tipo])}` : ''}</span>
          <span class="ca-visor-ac">${i > 0 ? '<button type="button" onclick="_ca.verCapa()">Usar como capa</button>' : ''}<button type="button" onclick="_ca.verTirar()">Remover</button><button type="button" class="ca-visor-x" aria-label="Fechar" onclick="_ca.fecharVer()">✕</button></span></div>
        <div class="ca-visor-palco">${n > 1 ? '<button type="button" class="ca-visor-seta esq" aria-label="Foto anterior" onclick="_ca.verPasso(-1)">‹</button>' : ''}<img src="${h(f.url)}" alt="${h(rot)}">${n > 1 ? '<button type="button" class="ca-visor-seta dir" aria-label="Próxima foto" onclick="_ca.verPasso(1)">›</button>' : ''}</div>
        ${n > 1 ? `<div class="ca-visor-tira">${st.fotos.map((x, j) => `<button type="button" class="${j === i ? 'on' : ''}" aria-label="Foto ${j + 1}" onclick="_ca.ver(${j})"><img src="${h(x.url)}" alt=""></button>`).join('')}</div>` : ''}`;
      v.querySelector('.ca-visor-x')?.focus();
    }
    function teclaVisor(e) {
      if (st.verFoto == null) return;
      if (e.key === 'Escape') { e.preventDefault(); window._ca.fecharVer(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); window._ca.verPasso(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); window._ca.verPasso(-1); }
    }

    // ── Ações (handlers globais) ────────────────────────────────
    window._ca = {
      p(k, v) { st.p[k] = v; if (k === 'titulo') { const c = el.querySelector('#ca-cont-tit'); if (c) c.textContent = `${v.length} caracteres`; } if (k === 'custo') ladoEPreco(); else ladoSo(); salvarDepois(); },
      arquivos: f => lerArquivos(f),
      tirarFoto(i) { st.fotos.splice(i, 1); tudo(); salvarDepois(); },
      moverFoto(i, d) { const j = i + d; if (j < 0 || j >= st.fotos.length) return; [st.fotos[i], st.fotos[j]] = [st.fotos[j], st.fotos[i]]; tudo(); salvarDepois(); },
      capa(i) { st.fotos.unshift(st.fotos.splice(i, 1)[0]); tudo(); salvarDepois(); },
      iaSEO, gerarKit,
      // visualizador: foto grande, setas, Esc; capa e remover direto daqui
      ver(i) { st.verFoto = Math.max(0, Math.min(st.fotos.length - 1, i)); desenharVisor(); },
      verPasso(d) { if (st.verFoto == null || !st.fotos.length) return; st.verFoto = (st.verFoto + d + st.fotos.length) % st.fotos.length; desenharVisor(); },
      fecharVer() { st.verFoto = null; desenharVisor(); },
      verCapa() { const i = st.verFoto; if (i > 0) { st.fotos.unshift(st.fotos.splice(i, 1)[0]); st.verFoto = 0; tudo(); salvarDepois(); desenharVisor(); } },
      verTirar() { const i = st.verFoto; if (i == null) return; st.fotos.splice(i, 1); st.verFoto = st.fotos.length ? Math.min(i, st.fotos.length - 1) : null; tudo(); salvarDepois(); desenharVisor(); },
      kit() { st.kitAberto = !st.kitAberto; tudo(); },
      kitTipo(k, on) { st.kit = on ? [...new Set([...st.kit, k])] : st.kit.filter(x => x !== k); tudo(); salvarDepois(); },
      varsAtivo(v) { st.vars.ativo = v; if (v) mapearEixos(); tudo(); salvarDepois(); },
      eixoNome(i, v) { st.vars.eixos[i].nome = v; ladoSo(); salvarDepois(); },
      addValor(i, v) { v = String(v || '').replace(/,/g, '').trim(); if (!v) return; if (!st.vars.eixos[i].valores.includes(v)) st.vars.eixos[i].valores.push(v); mapearEixos(); tudo(); const e = document.getElementById(`ca-eixo-${i}`); if (e) { e.value = ''; e.focus(); } salvarDepois(); },
      tirarValor(i, j) { st.vars.eixos[i].valores.splice(j, 1); tudo(); salvarDepois(); },
      addEixo() { st.vars.eixos.push({ nome: 'Tamanho', valores: [] }); tudo(); },
      tirarEixo(i) { st.vars.eixos.splice(i, 1); st.canal.ml.mapaEixo = {}; mapearEixos(); tudo(); salvarDepois(); },
      linha(k, campo, v) { const c = combos()[k]; if (!c) return; (st.vars.linhas[c.chave] = st.vars.linhas[c.chave] || {})[campo] = v; if (campo === 'estoque') { const t = el.querySelector('#ca-vars-tot'); if (t) t.textContent = `${combos().length} combinações · estoque total ${estoqueTotal()}. No Mercado Livre cada variação vira um anúncio da mesma família.`; } ladoSo(); salvarDepois(); },
      skusAuto() { const b = (st.p.sku || 'SKU').toUpperCase().replace(/\s+/g, ''); for (const c of combos()) (st.vars.linhas[c.chave] = st.vars.linhas[c.chave] || {}).sku = `${b}-${c.valores.map(v => v.toUpperCase().normalize('NFD').replace(/[^\w]/g, '').slice(0, 6)).join('-')}`; tudo(); salvarDepois(); },
      todas() { st.todasContas = !st.todasContas; tudo(); },
      conta(k, on) {
        st.sel = on ? [...new Set([...st.sel, k])] : st.sel.filter(x => x !== k);
        const m = k.slice(0, k.indexOf(':'));
        if (on) { st.prevMkt = m; if (!st.canal[m].cat && !st.canal[m].buscando && selDe(m).length === 1 && (st.termoCategoria || st.p.titulo)) buscarCategoria(m); }
        tudo(); salvarDepois();
      },
      catBusca(m, v) { st.canal[m].catBusca = v; },
      buscarCat: (m, manual) => buscarCategoria(m, null, manual),
      cat: (m, i) => escolherCategoria(m, st.canal[m].catRes[i]),
      trocarCat(m) { Object.assign(st.canal[m], { cat: null, req: [], opt: [], varAttrs: [], vals: {}, catRes: [], aviso: '' }); tudo(); },
      canal(m, k, v, re) { st.canal[m][k] = v; if (k === 'tipo') consultarTaxaML(); if (re) tudo(); else ladoSo(); salvarDepois(); },
      attr(m, id, v) { const cn = st.canal[m], a = [...cn.req, ...cn.opt].find(x => String(x.id) === String(id)); if (!a) return; const antes = preenchido(cn, a); cn.vals[a.id] = v || null; if (a.obrig && antes !== preenchido(cn, a)) tudo(); else ladoSo(); salvarDepois(); },
      attrMulti(m, id, sel) { const cn = st.canal[m], a = [...cn.req, ...cn.opt].find(x => String(x.id) === String(id)); if (!a) return; cn.vals[a.id] = [...sel.selectedOptions].map(o => o.value); ladoSo(); salvarDepois(); },
      attrNum(m, id, n, u) { const cn = st.canal[m], a = [...cn.req, ...cn.opt].find(x => String(x.id) === String(id)); if (!a) return; const antes = preenchido(cn, a); const v = Object.assign({ unit: unidadeBoa(a) }, cn.vals[a.id] || {}); if (n != null) v.num = n; if (u != null) v.unit = u; cn.vals[a.id] = v; if (a.obrig && antes !== preenchido(cn, a)) tudo(); else ladoSo(); salvarDepois(); },
      opc(m) { st.canal[m].mostrarOpc = !st.canal[m].mostrarOpc; tudo(); },
      mapa(i, v) { st.canal.ml.mapaEixo[i] = v; tudo(); salvarDepois(); },
      iaFicha,
      preco(m, v) { st.canal[m].preco = v; if (m === 'ml') consultarTaxaML(); ladoEPreco(); salvarDepois(); },
      usarSug(m, v) { st.canal[m].preco = String(v); if (m === 'ml') consultarTaxaML(); tudo(); salvarDepois(); },
      frete(v) { st.canal.ml.frete = v; ladoEPreco(); salvarDepois(); },
      estimarFrete: estimarFreteML,
      global(k, v) { st[k] = num(v) ?? 0; ladoEPreco(); salvarDepois(); },
      prev(m) { st.prevMkt = m; ladoSo(); },
      ir(n) { st.passo = Math.max(1, Math.min(5, n)); if (st.passo === 4 && mktsSel().includes('ml')) consultarTaxaML(); tudo(); salvarDepois(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
      publicar, republicar,
      limparPub() { st.pub = null; tudo(); },
      novo() { if (st.pub?.rodando) return; clearTimeout(tSalvar); try { localStorage.removeItem(K_RASC); } catch (e) {} idb('readwrite', os => os.delete('rascunho')).catch(() => {}).finally(() => { window._caSt = null; Router.resolve(); }); },
      zerar() { if (st.pub?.rodando) return; if (!confirm('Apagar este rascunho e começar do zero?')) return; window._ca.novo(); },
    };

    el.innerHTML = `<div class="page ca">
      <div class="ca-head"><div><h1>Criar anúncio</h1><p>Monte o produto uma vez e publique no Mercado Livre, na Shopee e no TikTok Shop — em quantas contas quiser. O rascunho fica salvo neste navegador.${st.origemRasc ? ` <b>Rascunho da Expansão de canais</b> (${h(st.origemRasc)}): confira categoria, ficha e preço.` : ''}</p></div>
        <button class="btn btn-secondary btn-sm" onclick="_ca.zerar()">Começar do zero</button></div>
      <div id="ca-root"><nav class="ca-passos" aria-label="Etapas"></nav><div class="ca-corpo"><div class="ca-main"></div><aside class="ca-lado" aria-label="Prévia e nota"></aside></div></div>
      <div id="ca-aviso" role="status" aria-live="polite"></div>
      <style>
        .ca-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px}.ca-head h1{margin:0;font-size:22px;letter-spacing:-.02em}.ca-head p{margin:4px 0 0;color:var(--text-secondary);font-size:13px;max-width:80ch}
        .ca-passos{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:16px}
        .ca-passos button{display:grid;grid-template-columns:28px 1fr;column-gap:8px;text-align:left;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:10px 12px;cursor:pointer;font:inherit;color:var(--text-primary)}
        .ca-passos button span{grid-row:1/3;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:var(--bg-subtle);color:var(--text-secondary);align-self:center}
        .ca-passos button b{font-size:13px}.ca-passos button small{font-size:11px;color:var(--text-muted)}
        .ca-passos button.ok span{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
        .ca-passos button.on{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 15%,transparent)}.ca-passos button.on span{background:var(--accent);color:#fff}
        .ca-passos button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
        .ca-corpo{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
        .ca-lado{position:sticky;top:76px;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:14px}
        .ca-bloco{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:16px 18px;margin-bottom:12px}
        .ca-bloco h4{margin:0 0 10px;font-size:14px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
        .ca-f{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;min-width:0}.ca-f>span{font-size:12px;font-weight:600;color:var(--text-secondary);display:flex;justify-content:space-between;gap:6px}.ca-f>span em{font-style:normal;font-weight:400;color:var(--text-muted)}.ca-f>span i{color:var(--red);font-style:normal}
        .ca-f small{font-size:11px;color:var(--text-muted)}.ca-f.falta .form-input,.ca-f.falta .form-select{border-color:color-mix(in srgb,var(--red) 55%,var(--border))}
        .ca-fixo{padding:9px 0;font-size:13px;color:var(--text-secondary)}
        .ca-g4{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0 12px}.ca-g3{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 12px}
        .ca-dica{font-size:12px;color:var(--text-muted);font-weight:400}.ca-erro{font-size:12.5px;color:var(--red);margin:6px 0}
        .ca-ia{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
        .ca-fotos{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;border:2px dashed transparent;border-radius:12px;padding:2px}.ca-fotos.arr{border-color:var(--accent)}
        .ca-foto{position:relative;margin:0;aspect-ratio:1;border-radius:10px;overflow:hidden;border:1px solid var(--border);background:var(--bg-subtle)}.ca-foto img{width:100%;height:100%;object-fit:cover;display:block}
        .ca-foto.capa{outline:2px solid var(--accent);outline-offset:1px}.ca-foto>b{position:absolute;top:6px;left:6px;background:var(--accent);color:#fff;font-size:10px;padding:2px 7px;border-radius:99px}.ca-foto>i{position:absolute;bottom:6px;left:6px;background:#111827cc;color:#fff;font-size:10px;font-style:normal;padding:2px 6px;border-radius:99px}
        .ca-foto-ver{display:block;width:100%;height:100%;padding:0;border:none;background:none;cursor:zoom-in}.ca-foto-ver img{width:100%;height:100%;object-fit:cover;display:block}.ca-foto-ver:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
        .ca-prev-img .ca-foto-ver img{object-fit:contain;background:#fff}.ca-prev-th .ca-foto-ver{width:36px;height:36px}.ca-prev-th .ca-foto-ver img{border-radius:5px;border:1px solid #e5e7eb}
        #ca-visor{position:fixed;inset:0;z-index:60;background:rgba(10,12,18,.92);display:flex;flex-direction:column;color:#fff;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}
        .ca-visor-topo{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 16px;font-size:13px;flex-wrap:wrap}.ca-visor-ac{display:flex;gap:8px}
        .ca-visor-ac button{border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);color:#fff;border-radius:8px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}.ca-visor-ac button:hover{background:rgba(255,255,255,.18)}
        .ca-visor-palco{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;position:relative;padding:0 56px}.ca-visor-palco img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;background:#fff}
        .ca-visor-seta{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;border:none;background:rgba(255,255,255,.14);color:#fff;font-size:28px;line-height:1;cursor:pointer}.ca-visor-seta:hover{background:rgba(255,255,255,.28)}.ca-visor-seta.esq{left:8px}.ca-visor-seta.dir{right:8px}
        .ca-visor-tira{display:flex;gap:6px;justify-content:center;padding:12px 16px;overflow-x:auto}.ca-visor-tira button{flex:none;width:56px;height:56px;padding:0;border:2px solid transparent;border-radius:6px;overflow:hidden;cursor:pointer;background:none;opacity:.6}.ca-visor-tira button.on{border-color:#fff;opacity:1}.ca-visor-tira img{width:100%;height:100%;object-fit:cover}
        #ca-visor button:focus-visible{outline:2px solid #fff;outline-offset:2px}
        @media (max-width:700px){.ca-visor-palco{padding:0 8px}.ca-visor-seta{width:36px;height:36px;font-size:22px}}
        .ca-foto-ac{position:absolute;inset:auto 0 0 0;display:flex;justify-content:center;gap:4px;padding:6px;background:linear-gradient(transparent,#0009);opacity:0;transition:opacity .15s}.ca-foto:hover .ca-foto-ac,.ca-foto:focus-within .ca-foto-ac{opacity:1}
        @media (hover:none){.ca-foto-ac{opacity:1}}
        .ca-foto-ac button{width:26px;height:26px;border-radius:50%;border:none;background:#fff;color:#111;cursor:pointer;font-size:13px;line-height:1}
        .ca-foto-add{aspect-ratio:1;border:2px dashed var(--border);border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer;color:var(--text-secondary);text-align:center;padding:8px}.ca-foto-add:hover,.ca-foto-add:focus-within{border-color:var(--accent);color:var(--accent)}.ca-foto-add input{position:absolute;opacity:0;width:1px;height:1px}.ca-foto-add span{font-size:26px;line-height:1}.ca-foto-add small{font-size:11px}
        .ca-gerando{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;margin-top:10px}.ca-ger{aspect-ratio:1;border-radius:10px;border:1px dashed var(--accent);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;text-align:center;padding:8px;background:linear-gradient(110deg,var(--bg-subtle) 30%,color-mix(in srgb,var(--accent) 10%,var(--bg-subtle)) 50%,var(--bg-subtle) 70%);background-size:200% 100%;animation:caBrilho 1.4s linear infinite}.ca-ger b{font-size:12px}.ca-ger small{font-size:11px;color:var(--text-muted)}.ca-ger.erro{border-color:var(--red);animation:none;background:var(--bg-subtle)}.ca-ger.erro span{color:var(--red);font-weight:700}
        @keyframes caBrilho{to{background-position:-200% 0}}
        .ca-kit{margin-top:10px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-subtle)}.ca-kit-op{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px}.ca-kit .ca-conta{background:var(--bg-card);margin:0}
        .ca-seo{border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:12px;background:var(--bg-subtle)}.ca-seo-t{display:grid;grid-template-columns:100px 1fr auto;gap:8px;align-items:baseline;font-size:13px;padding:5px 0;border-bottom:1px dashed var(--border)}.ca-seo-t b{color:var(--c);font-size:12px}.ca-seo-t em{font-style:normal;font-size:11px;color:var(--text-muted)}
        .ca-chips-ro{border:none;padding:0;background:none;min-height:0;cursor:default}.ca-chip.forte{background:var(--accent);color:#fff}
        .ca-switch{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;cursor:pointer;position:relative}.ca-switch input{position:absolute;opacity:0;width:1px;height:1px}.ca-switch span{width:38px;height:22px;border-radius:99px;background:var(--border);position:relative;transition:background .15s;flex:none}.ca-switch span::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}.ca-switch input:checked+span{background:var(--accent)}.ca-switch input:checked+span::after{transform:translateX(16px)}.ca-switch input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
        .ca-eixos{display:flex;flex-direction:column;gap:10px;margin:14px 0}.ca-eixo{display:grid;grid-template-columns:150px 1fr auto;gap:8px;align-items:start}
        .ca-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:1px solid var(--border);border-radius:10px;padding:6px 8px;min-height:40px;background:var(--bg-card);cursor:text}
        .ca-chip{display:inline-flex;align-items:center;gap:4px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--text-primary);border-radius:99px;padding:3px 6px 3px 10px;font-size:12.5px}.ca-chip button{border:none;background:none;cursor:pointer;color:var(--text-muted);font-size:11px}
        .ca-chip-in{border:none;outline:none;background:transparent;font:inherit;font-size:13px;flex:1;min-width:120px;color:var(--text-primary)}
        .ca-tab-w{overflow-x:auto}.ca-tab{width:100%;border-collapse:collapse;font-size:13px}.ca-tab th{text-align:left;font-size:11.5px;color:var(--text-secondary);padding:6px;border-bottom:1px solid var(--border);white-space:nowrap}.ca-tab td{padding:5px 6px;border-bottom:1px solid var(--border)}.ca-sm{padding:6px 8px;font-size:12.5px;min-width:80px}
        .ca-contas{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.ca-cgt{font-size:12px;font-weight:700;color:var(--c);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
        .ca-conta{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;margin-bottom:5px;font-size:13px;cursor:pointer}.ca-conta.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 7%,transparent)}
        .ca-canal{border-top:3px solid var(--c)}.ca-canal-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.ca-canal-h b{font-size:15px}.ca-canal-h span{font-size:12px;color:var(--text-muted)}
        .ca-sub{font-size:11.5px;font-weight:700;color:var(--text-secondary);margin:12px 0 6px;text-transform:uppercase;letter-spacing:.04em}.ca-ficha-h{display:flex;justify-content:space-between;align-items:center;gap:8px}
        .ca-cat{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--c) 8%,var(--bg-card));margin-bottom:10px}.ca-cat small{display:block;font-size:11.5px;color:var(--text-muted)}
        .ca-catbusca{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px}.ca-catbusca .form-input{flex:1;min-width:200px}
        .ca-catres{display:flex;flex-direction:column;gap:6px;margin:8px 0}.ca-catres button{text-align:left;border:1px solid var(--border);background:var(--bg-card);border-radius:9px;padding:8px 12px;cursor:pointer;font:inherit;color:var(--text-primary)}.ca-catres button:hover,.ca-catres button:focus-visible{border-color:var(--c)}.ca-catres small{display:block;font-size:11.5px;color:var(--text-muted)}
        .ca-mais{border:none;background:none;color:var(--accent);font:inherit;font-size:13px;cursor:pointer;padding:6px 0;margin-bottom:6px;text-align:left}
        .ca-nu{display:flex;gap:6px}.ca-nu .form-input{flex:1;min-width:0}.ca-nu .form-select{width:auto}
        .ca-preco{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}.ca-preco .ca-f{margin:0}.ca-grande{font-size:18px;font-weight:700;max-width:170px}
        .ca-barra{display:flex;height:12px;border-radius:99px;overflow:hidden;background:var(--bg-subtle);margin:14px 0 6px}.ca-barra i{display:block;height:100%}
        .ca-leg{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--text-muted);margin-bottom:6px}.ca-leg i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
        .ca-mg{display:flex;flex-direction:column;font-size:13px}.ca-mg div{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px dashed var(--border);font-variant-numeric:tabular-nums}.ca-mg em{font-style:normal;font-size:11px;color:var(--text-muted)}.ca-mg .tot{border:none;font-size:14px;padding-top:8px}
        .ca-resumo{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.ca-rc{border:1px solid var(--border);border-top:3px solid var(--c);border-radius:10px;padding:10px 12px;font-size:12.5px;color:var(--text-secondary);display:flex;flex-direction:column;gap:3px}.ca-rc-h{display:flex;justify-content:space-between;align-items:center;color:var(--text-primary)}
        .ca-pend{margin:0 0 12px;padding-left:18px;font-size:13px;display:flex;flex-direction:column;gap:4px}.ca-pend a{color:var(--red)}.ca-pend li.leve a{color:var(--text-secondary)}.ca-pend em{font-style:normal;font-size:11px;color:var(--text-muted)}
        .ca-publicar{width:100%;padding:13px;font-size:14px;border-radius:12px}
        .ca-pub{display:flex;flex-direction:column;gap:6px}.ca-publ{display:grid;grid-template-columns:130px 1fr auto;gap:4px 10px;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:9px;font-size:13px}.ca-publ small{grid-column:2/-1;color:var(--text-muted);font-size:11.5px;overflow-wrap:anywhere}.ca-pubac{display:flex;gap:6px}
        .ca-pubst{font-size:11.5px;font-weight:700}.ca-publ.ok .ca-pubst{color:var(--green)}.ca-publ.erro .ca-pubst{color:var(--red)}.ca-publ.aviso .ca-pubst{color:var(--yellow)}.ca-publ.enviando .ca-pubst{color:var(--accent)}.ca-publ.fila .ca-pubst{color:var(--text-muted)}
        .ca-nav{display:flex;justify-content:space-between;margin:4px 0 30px}
        .ca-prev-tabs{display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap}.ca-prev-tabs button{border:1px solid var(--border);background:var(--bg-card);border-radius:99px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;color:var(--text-secondary)}.ca-prev-tabs button.on{background:var(--c);border-color:var(--c);color:#fff}
        .ca-prev{border:1px solid var(--border);border-radius:12px;overflow:hidden;background:#fff;color:#1f2937}
        .ca-prev-ml{border-top:6px solid #ffe600}.ca-prev-shopee{border-top:6px solid #ee4d2d}.ca-prev-tiktok{border-top:6px solid #111827}
        .ca-prev-img{position:relative;aspect-ratio:1;background:#f3f4f6;display:grid;place-items:center;color:#9ca3af;font-size:12px}.ca-prev-img img{width:100%;height:100%;object-fit:contain;background:#fff}.ca-prev-img em{position:absolute;bottom:6px;right:6px;background:#0007;color:#fff;font-size:10px;font-style:normal;padding:2px 6px;border-radius:99px}
        .ca-prev-th{display:flex;gap:4px}.ca-prev-th img{width:36px;height:36px;object-fit:cover;border-radius:5px;border:1px solid #e5e7eb}
        .ca-prev-b{padding:10px 12px 12px;display:flex;flex-direction:column;gap:4px;min-width:0}.ca-prev-cond{font-size:11px;color:#6b7280}.ca-prev-t{font-size:14px;line-height:1.35;overflow-wrap:anywhere}
        .ca-prev-p{font-size:24px;font-weight:300;letter-spacing:-.01em;font-variant-numeric:tabular-nums}.ca-prev-shopee .ca-prev-p{color:#ee4d2d;font-weight:500}.ca-prev-tiktok .ca-prev-p{font-weight:700}
        .ca-prev-s{font-size:12px;color:#00a650}.ca-prev-shopee .ca-prev-s{color:#26aa99}.ca-prev-fg{font-size:12px;font-weight:600;color:#00a650}
        .ca-prev-v small{font-size:11px;color:#6b7280}.ca-prev-v div{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}.ca-prev-v span{font-size:11px;border:1px solid #d1d5db;border-radius:6px;padding:2px 7px}.ca-prev-v span.on{border-color:#3483fa;color:#3483fa}.ca-prev-shopee .ca-prev-v span.on{border-color:#ee4d2d;color:#ee4d2d}
        .ca-prev-btn{margin-top:6px;text-align:center;padding:9px;border-radius:7px;font-size:13px;font-weight:600;background:#3483fa;color:#fff}.ca-prev-shopee .ca-prev-btn{background:#ee4d2d}.ca-prev-tiktok .ca-prev-btn{background:#fe2c55}
        .ca-nota{display:flex;gap:12px;align-items:center;margin:14px 0 8px}.ca-nota b{display:block;font-size:14px}.ca-nota small{font-size:12px;color:var(--text-muted)}
        .ca-falta{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px;font-size:12px;color:var(--text-secondary)}.ca-falta li{display:grid;grid-template-columns:32px 1fr;gap:4px}.ca-falta b{color:var(--accent);font-variant-numeric:tabular-nums}.ca-falta strong{color:var(--text-primary);font-weight:600}
        #ca-aviso{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translate(-50%,20px);background:var(--text-primary);color:var(--bg-card);padding:10px 16px;border-radius:10px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:50;max-width:min(560px,calc(100vw - 32px))}#ca-aviso.on{opacity:1;transform:translate(-50%,0)}
        @media (max-width:1100px){.ca-corpo{grid-template-columns:1fr}.ca-lado{position:static;order:-1}.ca-prev{display:grid;grid-template-columns:160px 1fr}}
        @media (max-width:700px){.ca-passos button{grid-template-columns:1fr;padding:8px 4px;justify-items:center}.ca-passos button b,.ca-passos button small{display:none}.ca-passos button span{grid-row:auto}.ca-eixo{grid-template-columns:1fr}.ca-prev{grid-template-columns:110px 1fr}.ca-prev-th{display:none}.ca-publ{grid-template-columns:1fr auto}.ca-publ small{grid-column:1/-1}}
        @media (prefers-reduced-motion:reduce){.ca-ger{animation:none}.ca-foto-ac,#ca-aviso,.ca-switch span,.ca-switch span::after{transition:none}}
      </style>
    </div>`;
    tudo();
    carregarContas();
    // fotos do rascunho (IndexedDB); quem veio da Expansão já trouxe as dele
    if (!rasc && !st.fotos.length) idb('readonly', os => os.get('rascunho')).then(f => { if (Array.isArray(f) && f.length && window._caSt === st && !st.fotos.length) { st.fotos = f; tudo(); } }).catch(() => {});
  });
})();
