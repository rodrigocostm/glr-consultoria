// ============================================================
// GLR Consultoria — Página de Vendas (Detalhamento de Pedidos)
// ============================================================

Router.register('vendas', async (params, el) => {
  const STORAGE_CUSTOS   = 'glr_vendas_custos';
  const STORAGE_CATALOGO = 'glr_vendas_custo_catalogo'; // { [produtoKey]: custoUnitario } — aplica a pedidos antigos E novos do mesmo produto
  const STORAGE_LINHAS  = 'glr_vendas_linhas';
  const STORAGE_PEDIDOS = 'glr_vendas_cache'; // { pedidos, dataFrom, dataTo, at }
  const pad     = n => String(n).padStart(2,'0');
  const hoje    = new Date();
  const ontem   = new Date(hoje); ontem.setDate(hoje.getDate()-1);
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const R$      = v  => 'R$ '+(parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pct     = v  => (parseFloat(v)||0).toFixed(1)+'%';

  let custos       = JSON.parse(localStorage.getItem(STORAGE_CUSTOS)||'{}');
  let catalogoCusto= JSON.parse(localStorage.getItem(STORAGE_CATALOGO)||'{}'); // custo unitário fixo por produto — não precisa reaplicar a cada pedido novo
  const produtoKey = p => p.itens?.[0]?.itemId || p.produto || '';
  let linhasExt  = JSON.parse(localStorage.getItem(STORAGE_LINHAS)||'[]');
  let produtosCusto = JSON.parse(localStorage.getItem('glr_produtos')||'[]');
  let aliquotas = JSON.parse(localStorage.getItem('glr_aliquotas')||'{}'); // { [extId]: pct }
  let pedidos   = [];  // { id, plataforma, data, dataTs, produto, imagem, qtd, valor, status, itens[], taxas{} }
  let contas    = [];  // todas as contas da API
  let filtroPeriodo = 'custom'; // padrão: só ontem
  let filtroPlat    = 'todas';
  let filtroStatus  = 'validos'; // lista de Pedidos: validos | todos | cancelado | reembolsado | aberto (as somas são sempre só dos válidos)
  let filtroEmpresas = new Set(); // vazio = todas
  let filtroContasSel = new Set(); // vazio = todas
  // plataformas: sigla, nome, cor do selo e ordem dos grupos (filtro de contas)
  const _MKT_DCB = { ml: { sigla: 'ML', nome: 'Mercado Livre', cor: '#d9a400', ordem: 0 }, shopee: { sigla: 'SH', nome: 'Shopee', cor: '#ee4d2d', ordem: 1 }, amazon: { sigla: 'AMZ', nome: 'Amazon', cor: '#232f3e', ordem: 2 }, tiktok: { sigla: 'TT', nome: 'TikTok Shop', cor: '#111111', ordem: 3 }, magalu: { sigla: 'MGL', nome: 'Magalu', cor: '#0086ff', ordem: 4 }, shein: { sigla: 'SHN', nome: 'Shein', cor: '#555555', ordem: 5 } };
  let customFrom    = fmtDate(ontem); // ontem
  let customTo      = fmtDate(ontem); // ontem
  let expandido     = null;
  let abaAtiva      = 'dashboard'; // 'dashboard' | 'pedidos'
  let _semSelecao = false, _buscandoPedidos = false, _buscaCompleta = false, _recarregarDepois = null, _timerFiltro = null, _geracao = 0, _adsTok = 0;
  // Filtro de empresa/conta: relê a base sozinho (leitura rápida), sem precisar clicar em Atualizar
  function _filtroMudou() {
    clearTimeout(_timerFiltro);
    // Tirou toda a seleção: não puxa "todas as contas" — fica parado até marcar algo de novo
    // (ver todas = link "ver todas" ou botão Atualizar)
    if (!filtroContasSel.size && !filtroEmpresas.size) { _pararSemSelecao(); return; }
    _semSelecao = false;
    _timerFiltro = setTimeout(() => buscarPedidos({ silencioso: true, soBase: true }), 200);
  }
  function _pararSemSelecao() {
    _semSelecao = true;
    if (!_buscaCompleta) { // leitura da base em andamento é descartada (e para de ler as contas)
      _geracao++; _buscandoPedidos = false; _recarregarDepois = null;
      const btn = document.getElementById('btn-buscar'); if (btn) { btn.disabled = false; btn.textContent = 'Atualizar'; }
    }
    const st = document.getElementById('vendas-status');
    if (st) st.textContent = 'Nenhuma conta marcada. Marque uma ou mais contas para ver as vendas (ou clique em Atualizar para ver todas).';
    if (abaAtiva === 'dashboard' || abaAtiva === 'pedidos') renderLista(); // as outras abas leem a base sozinhas: ficam como estão
  }

  // Adota o período do último cache salvo (se existir) ANTES de montar a tela —
  // assim a página já abre mostrando o último dado buscado, sem precisar clicar
  // em Atualizar (o padrão "ontem" só é usado se nunca buscou nada ainda).
  try {
    const rawCache = localStorage.getItem(STORAGE_PEDIDOS);
    if (rawCache) {
      const cc = JSON.parse(rawCache);
      if (cc.dataFrom && cc.dataTo) { customFrom = cc.dataFrom; customTo = cc.dataTo; }
      if (Array.isArray(cc.contasSel)) cc.contasSel.forEach(id => filtroContasSel.add(id));
    }
  } catch(e) {}

  // Converte o preset de período selecionado em { dataFrom, dataTo } — usado tanto
  // na carga inicial quanto em toda busca disparada pelo filtro de data
  function _periodoParaDatas() {
    const y = hoje.getFullYear(), m = hoje.getMonth();
    switch (filtroPeriodo) {
      case 'hoje':  return { dataFrom: fmtDate(hoje),  dataTo: fmtDate(hoje) };
      case 'ontem': return { dataFrom: fmtDate(ontem), dataTo: fmtDate(ontem) };
      case 'mes':          return { dataFrom: fmtDate(new Date(y, m, 1)), dataTo: fmtDate(hoje) };
      case 'mes-passado':  return { dataFrom: fmtDate(new Date(y, m-1, 1)), dataTo: fmtDate(new Date(y, m, 0)) };
      case 'ano':          return { dataFrom: fmtDate(new Date(y, 0, 1)), dataTo: fmtDate(hoje) };
      case 'custom': return { dataFrom: customFrom, dataTo: customTo };
      default: {
        const dias = parseInt(filtroPeriodo) || 30;
        const d = new Date(ontem); d.setDate(ontem.getDate() - dias + 1);
        return { dataFrom: fmtDate(d), dataTo: fmtDate(ontem) };
      }
    }
  }

  // Investimento em ADS (ML + Shopee) para as contas/período filtrados no momento —
  // roda depois do primeiro render pra não travar a tela (mesma lógica do portal).
  // Guarda o valor de cada conta+período por 10 min: marcar/desmarcar contas no
  // filtro não refaz a busca na API das contas que já foram somadas (antes refazia
  // TODAS, uma por uma, a cada clique — com "todas as contas" eram ~180 chamadas).
  const ADS_TTL_MS = 10 * 60 * 1000;
  const _adsCache = window._vdAdsCache = window._vdAdsCache || new Map(); // conta|de|até → { em, p: Promise<number> }
  async function _adsDaConta(conta, dataFrom, dataTo) {
    const toShopeeDate = iso => iso.split('-').reverse().join('-');
    const addDaysIso = (iso, n) => { const [y,m,d] = iso.split('-').map(Number); return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10); };
    let total = 0, falhou = false;
    try {
      if (['meli','ml','mercadolivre'].includes(conta.marketplace)) {
        const meliId = conta.param_to_use?.meliUserId || conta.external_id;
        let off = 0;
        while (true) {
          const ra = await MarketplaceAPI.call('ml_ads_campaigns', { meliUserId: meliId, date_from: dataFrom, date_to: dataTo, limit: 50, offset: off });
          const res = ra.data?.results || [];
          total += res.reduce((s,c) => s + (parseFloat(c.metrics?.cost)||0), 0);
          if (res.length < 50) break;
          off += 50;
        }
      } else if (conta.marketplace === 'shopee') {
        const shopId = conta.param_to_use?.shopId || conta.external_id;
        let cur = dataFrom;
        while (cur <= dataTo) {
          const chunkEnd = addDaysIso(cur, 29) > dataTo ? dataTo : addDaysIso(cur, 29);
          try {
            const r = await MarketplaceAPI.call('shopee_ads_daily_performance', { shopId, start_date: toShopeeDate(cur), end_date: toShopeeDate(chunkEnd) });
            const dias = r?.data?.response || [];
            if (Array.isArray(dias)) total += dias.reduce((s,d) => s + (parseFloat(d.expense)||0), 0);
          } catch(e) { falhou = true; }
          cur = addDaysIso(chunkEnd, 1);
        }
      }
    } catch(e) { falhou = true; }
    return { total, falhou };
  }
  async function _buscarAdsTotalVendas(dataFrom, dataTo) {
    if (_semSelecao) return 0;
    const contasParaBuscar = filtroContasSel.size > 0
      ? contas.filter(c => filtroContasSel.has(c.external_id))
      : filtroEmpresas.size > 0
        ? contas.filter(c => contaEmpresas(c).some(e => filtroEmpresas.has(e)))
        : contas;
    const valores = await _mapLimit(contasParaBuscar, 4, conta => {
      const k = `${conta.marketplace}:${conta.external_id}|${dataFrom}|${dataTo}`;
      const hit = _adsCache.get(k);
      if (hit && Date.now() - hit.em < ADS_TTL_MS) return hit.p;
      // falha parcial não fica guardada: a próxima tela tenta de novo
      const p = _adsDaConta(conta, dataFrom, dataTo).then(r => { if (r.falhou) _adsCache.delete(k); return r.total; });
      _adsCache.set(k, { em: Date.now(), p });
      return p;
    });
    return valores.reduce((s, v) => s + (v || 0), 0);
  }

  const salvarCustos  = () => localStorage.setItem(STORAGE_CUSTOS, JSON.stringify(custos));
  const salvarCatalogoCusto = () => localStorage.setItem(STORAGE_CATALOGO, JSON.stringify(catalogoCusto));
  const salvarLinhas  = () => localStorage.setItem(STORAGE_LINHAS, JSON.stringify(linhasExt));

  // Preenche o catálogo por produto a partir de custos já lançados pedido-a-pedido
  // (migração automática — roda toda vez que pedidos carregam, sem sobrescrever o que já tem no catálogo).
  function _backfillCatalogoCusto() {
    let mudou = false;
    for (const p of pedidos) {
      const key = produtoKey(p);
      if (!key || catalogoCusto[key] > 0) continue;
      const cv = parseFloat(custos[p.id]?.custo) || 0;
      if (cv > 0) { catalogoCusto[key] = cv; mudou = true; }
    }
    if (mudou) salvarCatalogoCusto();
  }

  // Painel de diagnóstico temporário — mostra o retorno cru da API na própria tela
  // (pra achar o nome certo de um campo sem precisar abrir o console do navegador).
  // Remover depois que o frete do ML estiver batendo certinho.
  function _diagMostrar(grupo, pedidoId, obj) {
    if (window._portalConfig) return; // depuração interna: nunca no portal do cliente
    try { if (localStorage.getItem('glr_debug') !== '1') return; } catch (e) { return; } // só com a depuração ligada (localStorage glr_debug=1)
    let box = document.getElementById('diag-api-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'diag-api-box';
      box.style.cssText = 'position:fixed;bottom:12px;right:12px;width:520px;max-height:70vh;overflow-y:auto;background:#0d0d14;border:1px solid #6366f1;border-radius:10px;padding:14px;z-index:99999;font-family:monospace;font-size:var(--fs-1);color:#e5e7eb;box-shadow:0 10px 40px rgba(0,0,0,.5);';
      box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-2);">
        <strong style="color:var(--accent-light);">Diagnóstico API (temporário)</strong>
        <button onclick="document.getElementById('diag-api-box').remove()" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:var(--fs-3);">✕</button>
      </div><div id="diag-api-conteudo"></div>`;
      document.body.appendChild(box);
    }
    const cont = document.getElementById('diag-api-conteudo');
    const chave = `${grupo}-${pedidoId}`;
    if (!window._diagVistos) window._diagVistos = {};
    if (window._diagVistos[chave]) return; // já mostrou esse — evita poluir com repetição
    window._diagVistos[chave] = true;
    const bloco = document.createElement('div');
    bloco.style.cssText = 'margin-bottom:var(--space-3);padding-bottom:var(--space-3);border-bottom:1px solid #2a2a3a;';
    bloco.innerHTML = `<div style="color:#fbbf24;margin-bottom:var(--space-1);">[${grupo}] pedido ${pedidoId}</div><pre style="white-space:pre-wrap;word-break:break-all;margin:0;">${JSON.stringify(obj,null,2).replace(/</g,'&lt;')}</pre>`;
    cont.appendChild(bloco);
  }

  function salvarCache(dataFrom, dataTo) {
    try {
      localStorage.setItem(STORAGE_PEDIDOS, JSON.stringify({ pedidos, dataFrom, dataTo, contasSel: [...filtroContasSel], at: Date.now() }));
    } catch(e) { console.warn('Cache pedidos: erro ao salvar', e); }
  }

  function carregarCache(dataFrom, dataTo) {
    try {
      const raw = localStorage.getItem(STORAGE_PEDIDOS);
      if (!raw) return false;
      const c = JSON.parse(raw);
      if (c.dataFrom !== dataFrom || c.dataTo !== dataTo) return false;
      pedidos = c.pedidos || [];
      return c.at || true;
    } catch(e) { return false; }
  }

  function fmtAgo(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)   return 'agora mesmo';
    if (diff < 3600) return `há ${Math.floor(diff/60)} min`;
    if (diff < 86400)return `há ${Math.floor(diff/3600)}h`;
    return `há ${Math.floor(diff/86400)} dias`;
  }
  const platCor = { 'Mercado Livre':'#f59e0b', 'Shopee':'#f97316', 'Amazon':'#94a3b8', 'TikTok Shop':'#25d4d0', 'Magalu':'#0086ff', 'Shein':'#222222' };

  function corMargem(m) {
    if (m>=20) return 'var(--green)';
    if (m>=10) return 'var(--yellow)';
    if (m>=0)  return 'var(--orange)';
    return 'var(--red)';
  }

  // ── Cálculo de lucro ────────────────────────────────────────
  // Se temos taxas da API (Shopee escrow), usa liquido como base.
  // Senão, usa receita bruta.
  // Delega pro módulo único js/margem-lucro.js (GLR_Margem) — mesma fórmula
  // que já rodava aqui, agora compartilhada com Financeiro/DRE/Decision
  // Engine do Analista GLR, num lugar só (evita as 3 implementações
  // divergentes que existiam antes).
  function calcLucro(p) {
    return window.GLR_Margem.calcularLucroPedido(p, { custos, catalogoCusto, linhasExt, aliquotas, produtos:produtosCusto });
  }

  function calcTotais(lista) {
    let fat=0,liq=0,custo=0,imp=0,out=0,lucro=0,nLiq=0;
    for (const p of lista) {
      const l=calcLucro(p);
      fat+=l.receita; custo+=l.custo; imp+=l.impVal; out+=l.outros+l.extra; lucro+=l.lucro;
      if (l.liquido!=null){ liq+=l.liquido; nLiq++; }
    }
    return { fat, liq: nLiq>0?liq:null, custo, imp, out, lucro, margem: fat>0?(lucro/fat)*100:0 };
  }

  // Fora das somas: cancelado, reembolsado/devolvido (inclusive em andamento) e em aberto (sem pagamento).
  // Regra única em js/status-pedido.js — a mesma do Vendômetro e da comissão.
  const _inativasLocal = () => { try { return JSON.parse(localStorage.getItem('glr_contas_inativas') || '{}'); } catch (e) { return {}; } };
  const statusPedido = p => (p._st = p._st || window.GLRStatusPedido.classificar(p));
  function isCanceladoVendas(p) { return !statusPedido(p).valido; }

  const passaFiltrosConta = p => (filtroPlat === 'todas' || p.plataforma === filtroPlat) && (filtroContasSel.size === 0 || filtroContasSel.has(p.contaId));

  // Pedidos que entram nas somas (KPIs, dashboard, comissão, totais do dia)
  function pedidosFiltrados() {
    if (_semSelecao) return []; // seleção vazia: nada na tela até marcar uma conta
    return pedidos.filter(p => !isCanceladoVendas(p) && passaFiltrosConta(p));
  }

  // Pedidos mostrados na lista da aba Pedidos (o filtro de status só muda a lista, nunca as somas)
  function pedidosDaLista() {
    if (_semSelecao) return [];
    return pedidos.filter(p => {
      if (!passaFiltrosConta(p)) return false;
      const g = statusPedido(p).grupo;
      return filtroStatus === 'todos' || (filtroStatus === 'validos' ? g === 'valido' : g === filtroStatus);
    });
  }

  const COR_STATUS = { valido: 'var(--green)', cancelado: 'var(--red)', reembolsado: 'var(--orange)', aberto: 'var(--yellow)' };
  function seloStatus(p) {
    const s = statusPedido(p), cor = COR_STATUS[s.grupo] || 'var(--text-muted)';
    const txt = String(s.rotulo).replace(/[<>&"]/g, '');
    return `<span title="${s.valido ? 'Entra nas somas' : 'Fora das somas (' + window.GLRStatusPedido.ROTULO_GRUPO[s.grupo].toLowerCase() + ')'}" style="background:color-mix(in srgb,${cor} 15%,transparent);color:${cor};padding:1px 6px;border-radius:8px;font-size:var(--fs-1);font-weight:600;">● ${txt}</span>`;
  }

  const contaNome = c => {
    const nicks = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();
    const tag = c.tags?.[0]?.name || '';
    return nicks[c.external_id] || tag || c.nickname || c.name || c.external_id;
  };

  // Empresa = cliente real vinculado à conta em Integrações (glr_mc_vinculos), não a
  // tag crua da conta na API — a tag muitas vezes nem bate com o cliente de fato
  // (ex: conta 1036862626 tem tag "EAP - Mercado Livre" mas está vinculada à Mega Facil).
  // Índice conta → empresas montado uma vez (antes relia e decodificava os vínculos e
  // os clientes do localStorage a cada chamada — milhares de vezes por clique no filtro).
  // Revalida no máximo a cada 1,5 s, comparando o conteúdo cru.
  let _empIdx = null;
  function _indiceEmpresas() {
    const agora = Date.now();
    if (_empIdx && agora - _empIdx.em < 1500) return _empIdx.mapa;
    const rawV = localStorage.getItem('glr_mc_vinculos') || '{}', rawC = localStorage.getItem('glr_clientes') || '[]';
    if (_empIdx && _empIdx.rawV === rawV && _empIdx.rawC === rawC) { _empIdx.em = agora; return _empIdx.mapa; }
    let vinc = {}, clientes = []; try { vinc = JSON.parse(rawV); clientes = JSON.parse(rawC); } catch (e) {}
    const nomeCli = new Map(clientes.map(cl => [String(cl.id), cl.nome]));
    const mapa = new Map();
    for (const [clienteId, contasVinc] of Object.entries(vinc || {})) {
      const nome = nomeCli.get(String(clienteId)); if (!nome) continue;
      for (const v of contasVinc || []) {
        const k = String(v.external_id), arr = mapa.get(k) || [];
        if (!arr.includes(nome)) arr.push(nome);
        mapa.set(k, arr);
      }
    }
    _empIdx = { em: agora, rawV, rawC, mapa };
    return mapa;
  }
  function contaEmpresas(c) {
    return _indiceEmpresas().get(String(c.external_id)) || ['Sem vínculo'];
  }

  window._vendasLimparContas = () => { if (!window._portalConfig) GLR.ctx?.definir('', true); filtroEmpresas = new Set(); filtroContasSel = new Set(); renderFiltroEmpresaConta(); _semSelecao = false; buscarPedidos({ silencioso: true, soBase: true }); }; // "ver todas": pedido explícito de todas as contas
  function renderFiltroEmpresaConta() {
    const wrapEmp  = document.getElementById('filtro-empresa');
    const wrapCont = document.getElementById('filtro-conta');
    if (!wrapEmp || !wrapCont) return;

    const empresas = [...new Set(contas.flatMap(contaEmpresas))].sort();
    const contasFiltradas = filtroEmpresas.size === 0
      ? contas
      : contas.filter(c => contaEmpresas(c).some(e => filtroEmpresas.has(e)));

    // contagem de contas por plataforma de cada empresa — uma passada só
    const porEmp = new Map();
    for (const c of contas) { const m = _MKT_DCB[BaseDados.mktDe(c.marketplace)]?.sigla || '?'; for (const e of contaEmpresas(c)) { const n = porEmp.get(e) || {}; n[m] = (n[m] || 0) + 1; porEmp.set(e, n); } }
    const subEmp = new Map([...porEmp].map(([e, n]) => [e, Object.entries(n).map(([k, v]) => `${v} ${k}`).join(' · ')]));
    _renderCheckboxDropdown(wrapEmp, {
      label: 'Empresa', icon: '🏢',
      itens: empresas.map(e => ({ valor: e, label: e, sub: subEmp.get(e) || '' })),
      selecionados: filtroEmpresas,
      textoVazio: filtroContasSel.size ? (() => { const es = [...new Set(contas.filter(c => filtroContasSel.has(c.external_id)).flatMap(contaEmpresas))]; return es.length === 1 ? `🏢 ${es[0]}` : `🏢 ${es.length} empresas (pelas contas)`; })() : null,
      onChange: (novoSet) => {
        filtroEmpresas = novoSet;
        if (!window._portalConfig) { const so = filtroEmpresas.size === 1 ? (GLR.clientes || []).find(c => c.nome === [...filtroEmpresas][0]) : null; GLR.ctx?.definir(so ? String(so.id) : '', true); } // barra de cima acompanha
        if (filtroEmpresas.size > 0) {
          const validas = contas.filter(c => contaEmpresas(c).some(e=>filtroEmpresas.has(e))).map(c=>c.external_id);
          // Marcar uma empresa já seleciona as contas dela — sem isso o usuário
          // teria que marcar empresa E conta pra busca sair do lugar
          filtroContasSel = new Set(validas);
        } else {
          filtroContasSel = new Set();
        }
        renderFiltroEmpresaConta();
        _filtroMudou();
      },
    });

    _renderCheckboxDropdown(wrapCont, {
      label: 'Conta', icon: '🏬',
      itens: contasFiltradas.map(c => ({ valor: c.external_id, label: contaNome(c), mkt: BaseDados.mktDe(c.marketplace), sub: contaEmpresas(c).join(', '), id: window.glrIdConta?.(c) || c.external_id })),
      selecionados: filtroContasSel, porPlataforma: true,
      onChange: (novoSet) => { filtroContasSel = novoSet; if (!window._portalConfig) { const cs = [...new Set(contas.filter(c => novoSet.has(c.external_id)).map(c => GLR.ctx?.clienteDaConta(c.marketplace, c.external_id) || ''))]; if (cs.length === 1 && cs[0]) GLR.ctx?.definir(cs[0], true); else if (!novoSet.size) GLR.ctx?.definir('', true); } renderFiltroEmpresaConta(); _filtroMudou(); },
    });
  }

  // ── Dropdown de checkboxes reutilizável (empresa/conta) ────────
  // itens: [{valor,label,mkt?,sub?}], selecionados: Set, onChange(novoSet)
  // Continua aberto enquanto marca (antes fechava a cada clique), tem busca, mostra a
  // plataforma de cada conta (selo ML/Shopee…), agrupa por plataforma e tem atalhos.
  function _renderCheckboxDropdown(container, { label, icon, itens, selecionados, onChange, porPlataforma, textoVazio }) {
    const uid = container.id;
    const aberto = window._dcbAberto === uid;
    const busca = (window._dcbBusca || {})[uid] || '';
    const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const selo = m => { const x = _MKT_DCB[m]; return x ? `<span class="dcb-selo" style="--c:${x.cor}">${x.sigla}</span>` : ''; };
    const qtdSel = [...selecionados].filter(v => itens.some(i => i.valor === v)).length;
    let textoBotao;
    if (!qtdSel) textoBotao = textoVazio ? String(textoVazio).replace(/</g, '&lt;') : `${icon} Todas as ${label.toLowerCase()}s`;
    else if (qtdSel === 1) { const it = itens.find(i => selecionados.has(i.valor)); textoBotao = `${porPlataforma ? selo(it?.mkt) : icon} ${esc(it?.label || '1 selecionada')}`; }
    else if (porPlataforma) { const n = {}; itens.filter(i => selecionados.has(i.valor)).forEach(i => { const k = _MKT_DCB[i.mkt]?.sigla || '?'; n[k] = (n[k] || 0) + 1; }); textoBotao = `${icon} ${qtdSel} contas · ${Object.entries(n).map(([k, v]) => `${v} ${k}`).join(' · ')}`; }
    else textoBotao = `${icon} ${qtdSel} ${label.toLowerCase()}s`;
    const q = busca.trim().toLowerCase();
    const visiveis = itens.filter(i => !q || `${i.label} ${i.sub || ''} ${i.id || ''} ${_MKT_DCB[i.mkt]?.nome || ''}`.toLowerCase().includes(q));
    const linha = i => `<label class="dcb-op"><input type="checkbox" value="${esc(i.valor)}" ${selecionados.has(i.valor) ? 'checked' : ''}>${porPlataforma ? selo(i.mkt) : ''}<span class="dcb-txt"><span class="dcb-nome">${esc(i.label)}</span>${i.sub || i.id ? `<span class="dcb-sub">${esc(i.sub || '')}${i.id ? `<span class="dcb-id">${i.sub ? ' · ' : ''}ID ${esc(i.id)}</span>` : ''}</span>` : ''}</span></label>`;
    let lista;
    if (porPlataforma) {
      const grupos = {}; visiveis.forEach(i => { (grupos[i.mkt || 'outro'] = grupos[i.mkt || 'outro'] || []).push(i); });
      lista = Object.entries(grupos).sort(([a], [b]) => (_MKT_DCB[a]?.ordem ?? 9) - (_MKT_DCB[b]?.ordem ?? 9)).map(([m, arr]) => `<div class="dcb-grupo"><span>${selo(m)} ${esc(_MKT_DCB[m]?.nome || 'Outras')} · ${arr.length}</span><button type="button" class="dcb-so" data-mkt="${esc(m)}">só ${esc(_MKT_DCB[m]?.nome || 'estas')}</button></div>${arr.sort((a, b) => (selecionados.has(b.valor) - selecionados.has(a.valor)) || a.label.localeCompare(b.label)).map(linha).join('')}`).join('');
    } else lista = [...visiveis].sort((a, b) => selecionados.has(b.valor) - selecionados.has(a.valor)).map(linha).join('');
    container.innerHTML = `
      <div style="position:relative;">
        <button type="button" class="form-input dcb-toggle" aria-expanded="${aberto}" title="${esc(qtdSel ? itens.filter(i => selecionados.has(i.valor)).map(i => `${_MKT_DCB[i.mkt]?.sigla ? _MKT_DCB[i.mkt].sigla + ' · ' : ''}${i.label}${i.id ? ` (ID ${i.id})` : ''}`).join('\n') : `Todas as ${label.toLowerCase()}s`)}">
          <span class="dcb-rot">${textoBotao}</span><span style="font-size:var(--fs-1);opacity:0.6;">▾</span>
        </button>
        <div class="dcb-panel" style="display:${aberto ? 'block' : 'none'};">
          ${itens.length > 6 ? `<input type="search" class="dcb-busca" placeholder="Buscar ${label.toLowerCase()}${porPlataforma ? ' ou plataforma' : ''}…" value="${esc(busca)}">` : ''}
          <div class="dcb-lista">${itens.length === 0 ? '<div class="dcb-vazio">Nenhuma opção</div>' : visiveis.length ? lista : '<div class="dcb-vazio">Nada encontrado</div>'}</div>
          ${itens.length > 0 ? `<div class="dcb-rodape"><span>${qtdSel ? `${qtdSel} de ${itens.length} marcada(s)` : `todas as ${itens.length}`}</span>${q && visiveis.length ? '<button type="button" class="dcb-marcar">Marcar as encontradas</button>' : ''}<button type="button" class="dcb-limpar">${qtdSel ? 'Limpar (todas)' : 'Fechar'}</button></div>` : ''}
        </div>
      </div>`;

    const btn = container.querySelector('.dcb-toggle'), panel = container.querySelector('.dcb-panel');
    const mudar = novo => { window._dcbAberto = uid; onChange(novo); };
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const abrir = panel.style.display === 'none';
      document.querySelectorAll('.dcb-panel').forEach(p => { p.style.display = 'none'; });
      panel.style.display = abrir ? 'block' : 'none';
      window._dcbAberto = abrir ? uid : null;
      if (abrir) container.querySelector('.dcb-busca')?.focus();
    });
    panel.addEventListener('click', ev => ev.stopPropagation());
    container.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
      const novo = new Set([...selecionados].filter(v => itens.some(i => i.valor === v)));
      if (cb.checked) novo.add(cb.value); else novo.delete(cb.value);
      mudar(novo);
    }));
    const inp = container.querySelector('.dcb-busca');
    if (inp) {
      inp.addEventListener('input', () => { window._dcbBusca = { ...(window._dcbBusca || {}), [uid]: inp.value }; window._dcbAberto = uid; _renderCheckboxDropdown(container, { label, icon, itens, selecionados, onChange, porPlataforma, textoVazio }); const n = container.querySelector('.dcb-busca'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
      inp.addEventListener('keydown', ev => { if (ev.key === 'Escape') { window._dcbAberto = null; panel.style.display = 'none'; } });
    }
    container.querySelectorAll('.dcb-so').forEach(b => b.addEventListener('click', () => mudar(new Set(itens.filter(i => (i.mkt || 'outro') === b.dataset.mkt).map(i => i.valor)))));
    container.querySelector('.dcb-marcar')?.addEventListener('click', () => mudar(new Set([...[...selecionados].filter(v => itens.some(i => i.valor === v)), ...visiveis.map(i => i.valor)])));
    container.querySelector('.dcb-limpar')?.addEventListener('click', () => { if (qtdSel) mudar(new Set()); else { window._dcbAberto = null; panel.style.display = 'none'; } });
  }
  if (!document.getElementById('dcb-estilo')) {
    const st = document.createElement('style'); st.id = 'dcb-estilo';
    st.textContent = `.dcb-toggle{width:220px;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer}
      .dcb-rot{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:5px}
      .dcb-panel{position:absolute;top:calc(100% + 4px);left:0;z-index:60;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.22);width:340px;max-width:calc(100vw - 32px);padding:var(--space-2)}
      .dcb-busca{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:7px;padding:7px 9px;font-size:var(--fs-3);background:var(--bg-base);color:var(--text-primary);margin-bottom:6px}
      .dcb-lista{max-height:340px;overflow:auto}
      .dcb-grupo{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:var(--fs-1);font-weight:700;color:var(--text-secondary);padding:8px 6px 4px;position:sticky;top:0;background:var(--bg-card)}
      .dcb-grupo span{display:flex;align-items:center;gap:5px}.dcb-so{font-size:var(--fs-1);border:none;background:none;color:var(--accent);cursor:pointer;padding:2px 4px;font-weight:600}
      .dcb-op{display:flex;align-items:center;gap:var(--space-2);padding:6px 8px;border-radius:6px;cursor:pointer;font-size:var(--fs-3);color:var(--text-primary)}.dcb-op:hover{background:var(--bg-card-hover)}
      .dcb-op input{width:14px;height:14px;accent-color:var(--accent);flex:none}
      .dcb-txt{display:flex;flex-direction:column;min-width:0}.dcb-nome,.dcb-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dcb-sub{font-size:var(--fs-1);color:var(--text-muted)}.dcb-id{opacity:.75;font-variant-numeric:tabular-nums}
      .dcb-selo{flex:none;font-size:var(--fs-1);font-weight:800;letter-spacing:.02em;color:#fff;background:var(--c);border-radius:4px;padding:2px 5px;line-height:1.2}
      .dcb-vazio{padding:10px;font-size:var(--fs-2);color:var(--text-muted)}
      .dcb-rodape{border-top:1px solid var(--border);margin-top:6px;padding-top:6px;display:flex;gap:var(--space-2);align-items:center;font-size:var(--fs-1);color:var(--text-muted)}
      .dcb-rodape span{flex:1}.dcb-rodape button{font-size:var(--fs-1);padding:5px 9px;background:var(--bg-card-hover);border:none;border-radius:5px;color:var(--text-secondary);cursor:pointer}`;
    document.head.appendChild(st);
  }

  // Fecha qualquer dropdown de checkbox aberto ao clicar fora — registra só uma vez
  // (esse handler roda a cada navegação pra página, sem a guarda duplicaria o listener)
  if (!window._dcbGlobalCloseListener) {
    window._dcbGlobalCloseListener = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.dcb-panel').forEach(p => p.style.display = 'none');
      window._dcbAberto = null;
    });
  }

  // ── Trocar aba ───────────────────────────────────────────────
  function setAba(aba) {
    abaAtiva = aba;
    ['dashboard','pedidos','oportunidades','semanal','funil'].forEach(a => {
      const btn = document.getElementById(`tab-${a}`);
      const sec = document.getElementById(`sec-${a}`);
      if (btn) btn.style.cssText = a===aba
        ? 'padding:var(--space-2) var(--space-5);border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:var(--fs-3);background:var(--accent);color:var(--text-primary);'
        : 'padding:var(--space-2) var(--space-5);border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:var(--fs-3);background:var(--bg-card-hover);color:var(--text-secondary);';
      if (sec) sec.style.display = a===aba ? 'block' : 'none';
    });
    if (aba==='dashboard') renderDashboard();
    if (aba==='pedidos')   renderPedidos();
    if (aba==='oportunidades') renderOportunidades();
    if (aba==='semanal')   renderComparativoSemanal();
    // Funil de vendas (tela própria, montada aqui dentro na 1ª vez): tem filtros próprios de dia, cliente e conta
    const filtros = document.getElementById('vendas-filtros');
    if (filtros) filtros.style.display = aba === 'funil' ? 'none' : 'flex';
    if (aba === 'funil') {
      const sec = document.getElementById('sec-funil');
      if (sec && !sec.dataset.montado && Router.routes?.funil) { sec.dataset.montado = '1'; Router.routes.funil({}, sec); }
    }
  }

  // Executa promessas com concorrência limitada — evita disparar centenas de
  // chamadas simultâneas (visitas por item, uma chamada por produto)
  async function _mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        try { results[i] = await fn(items[i], i); } catch(e) { results[i] = undefined; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  // list_items retorna só uma lista de IDs (string) — nunca objetos com
  // título/preço, mesmo passando status:'active'. Paginação simples.
  // IMPORTANTE: o parâmetro é meliUserId — contaId é ignorado silenciosamente
  // pela API e sempre retorna a conta ML padrão, misturando dados de contas erradas
  const _mlItemCache = {}; // id → anúncio (título, preço, estoque) já vindo da listagem
  // Chamada por anúncio com nova tentativa: a API recusa rajadas (limite de
  // chamadas) e, sem isso, a falha virava "0 visitas" / "fora do ADS" calada.
  async function _tentar(fn, n = 3) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (i >= n - 1 || /404|not.?found|no encontr|não encontr|inexist/i.test(e.message)) throw e;
        await new Promise(r => setTimeout(r, 700 * (i + 1)));
      }
    }
  }
  async function _mlListarIdsAtivos(meliUserId) {
    let ids = [];
    let offset = 0;
    while (true) {
      let r;
      try { r = await MarketplaceAPI.call('list_items', { meliUserId, status: 'active', limit: 100, offset }); }
      catch(e) { break; }
      const lote = r?.results || r?.data?.results || [];
      if (!Array.isArray(lote) || !lote.length) break;
      // O conector passou a devolver o anúncio inteiro ({code, body:{id,title,...}})
      // em vez de só o id — aceita os dois formatos e guarda o detalhe que já veio
      for (const e of lote) {
        const b = e && typeof e === 'object' ? (e.body || e) : null;
        const id = b ? b.id : e;
        if (!id) continue;
        if (b && b.title) _mlItemCache[id] = b;
        ids.push(String(id));
      }
      if (lote.length < 100) break;
      offset += 100;
    }
    return ids;
  }

  // Busca título/preço/estoque em lote (get_items aceita múltiplos ids por
  // chamada) — usado só pros itens que sobraram depois de filtrar visita/venda.
  // Precisa de meliUserId — com contaId a API retorna 403 pra cada item
  async function _mlDetalhesItens(meliUserId, ids) {
    const detalhes = {};
    ids = ids.filter(id => { if (_mlItemCache[id]) { detalhes[id] = _mlItemCache[id]; return false; } return true; });
    for (let i=0; i<ids.length; i+=20) {
      const lote = ids.slice(i,i+20);
      try {
        const r = await MarketplaceAPI.call('get_items', { meliUserId, ids: lote });
        const arr = Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : []);
        arr.forEach(entry => {
          const b = entry.body || entry;
          if (b?.id) detalhes[b.id] = b;
        });
      } catch(e) {}
    }
    return detalhes;
  }

  // ── Oportunidade de Produtos: itens ATIVOS com visitas no período mas
  // ZERO vendas — sinaliza produto com tráfego que não está convertendo ──
  const STORAGE_OPORT    = 'glr_vendas_oportunidades';
  const STORAGE_FORA_ADS = 'glr_vendas_fora_ads';
  let oportunidades = null; // null = nunca buscado; [] = buscado, nada encontrado
  let buscandoOportunidades = false;
  let foraDoAds = null; // produtos ativos sem nenhuma campanha de ADS
  let buscandoForaDoAds = false;
  let oportAtualizadoEm = null, foraAdsAtualizadoEm = null;
  let falhasOport = 0, falhasForaAds = 0; // anúncios que a API não respondeu na última busca
  let diagOport = null; // resumo da última busca de visitas sem venda (pra explicar um resultado vazio)
  // Carrega o último resultado salvo — evita ter que clicar em Buscar de novo
  // toda vez que a página é reaberta (não faz nenhuma chamada de API aqui).
  try {
    const co = JSON.parse(localStorage.getItem(STORAGE_OPORT)||'null');
    if (co) { oportunidades = co.oportunidades; oportAtualizadoEm = co.at; }
  } catch(e) {}
  try {
    const cf = JSON.parse(localStorage.getItem(STORAGE_FORA_ADS)||'null');
    if (cf) { foraDoAds = cf.foraDoAds; foraAdsAtualizadoEm = cf.at; }
  } catch(e) {}

  async function buscarOportunidades() {
    if (buscandoOportunidades) return;
    if (filtroContasSel.size === 0 && filtroEmpresas.size === 0) {
      GLR.avisar('Selecione ao menos uma conta ou empresa no filtro antes de buscar oportunidades.', 'info');
      return;
    }
    const contasAlvo = filtroContasSel.size > 0
      ? contas.filter(c => filtroContasSel.has(c.external_id))
      : contas.filter(c => contaEmpresas(c).some(e => filtroEmpresas.has(e)));
    const contasML     = contasAlvo.filter(c => ['meli','ml','mercadolivre'].includes((c.marketplace||'').toLowerCase()));
    const contasShopee = contasAlvo.filter(c => (c.marketplace||'').toLowerCase() === 'shopee');
    if (!contasML.length && !contasShopee.length) { GLR.avisar('Nenhuma conta ML ou Shopee selecionada no filtro.', 'info'); return; }

    buscandoOportunidades = true;
    const btn = document.getElementById('btn-buscar-oport');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Buscando...'; }
    const status = document.getElementById('oport-status');

    try {
      const { dataFrom, dataTo } = _periodoParaDatas();
      const achados = [];
      falhasOport = 0;
      diagOport = { ativos: 0, vendidos: 0, checados: 0, comVisita: 0, exemplo: null, erro: null };

      // ── Mercado Livre: visitas escopadas ao período selecionado ──
      // list_items só retorna uma lista de IDs (string) — nome/preço vêm de
      // get_items, buscado só pros itens que sobram depois do filtro de visita
      const idsVendidosML = new Set(
        pedidos.filter(p => contasML.some(c=>c.external_id===p.contaId))
          .flatMap(p => (p.itens||[]).map(i=>i.itemId)).filter(Boolean)
      );
      for (const conta of contasML) {
        if (status) status.textContent = `Listando anúncios ativos: ${conta.nickname||conta.external_id}...`;
        const meliIdListagem = conta.param_to_use?.meliUserId || conta.external_id;
        const itemIds = await _mlListarIdsAtivos(meliIdListagem);
        // Só checa visita de quem NÃO vendeu no período — reduz drasticamente as chamadas
        const semVenda = itemIds.filter(id => !idsVendidosML.has(String(id)));
        diagOport.ativos += itemIds.length; diagOport.vendidos += itemIds.length - semVenda.length;
        if (status) status.textContent = `Checando visitas: ${conta.nickname||conta.external_id} (${semVenda.length} anúncios sem venda)...`;

        const comVisita = [];
        await _mapLimit(semVenda, 4, async itemId => {
          try {
            const rv = await _tentar(() => MarketplaceAPI.call('ml_visits_item', { meliUserId: meliIdListagem, item_id: String(itemId), date_from: dataFrom, date_to: dataTo }));
            // formatos: {items:[{total_visits}]} (atual), {total_visits}, {results:[{total}]}
            // Lê total_visits em qualquer formato que o conector devolver (objeto, lista, aninhado)
            const m = JSON.stringify(rv || {}).match(/"total_visits"\s*:\s*"?(\d+)/);
            const visitas = m ? parseInt(m[1]) : (Array.isArray(rv?.data?.results) ? rv.data.results.reduce((s,d)=>s+(parseInt(d.total)||0),0) : 0);
            diagOport.checados++;
            if (visitas > 0) { diagOport.comVisita++; comVisita.push({ item_id: itemId, visitas }); }
            else if (!m && !diagOport.exemplo) diagOport.exemplo = JSON.stringify(rv || {}).slice(0, 160);
          } catch(e) { falhasOport++; if (!diagOport.erro) diagOport.erro = String(e.message || e).slice(0, 120); }
        });

        if (status) status.textContent = `Buscando nome/preço (ML): ${conta.nickname||conta.external_id}...`;
        const detalhes = await _mlDetalhesItens(meliIdListagem, comVisita.map(o=>o.item_id));
        for (const o of comVisita) {
          const d = detalhes[o.item_id] || {};
          achados.push({
            id: o.item_id, nome: d.title || `Item ${o.item_id}`, preco: d.price ?? 0,
            estoque: d.available_quantity ?? 0, visitas: o.visitas,
            conta: conta.nickname || conta.external_id, mp: 'ML',
            link: `https://produto.mercadolivre.com.br/${String(o.item_id).replace('MLB','MLB-')}`,
          });
        }
      }

      // ── Shopee: shopee_get_extra_info retorna "views" acumulado (sem filtro de
      // data) — cruza com quem não vendeu no período pra aproximar a mesma ideia ──
      const idsVendidosShopee = new Set(
        pedidos.filter(p => contasShopee.some(c=>c.external_id===p.contaId))
          .flatMap(p => (p.itens||[]).map(i=>i.itemId)).filter(Boolean)
      );
      for (const conta of contasShopee) {
        if (status) status.textContent = `Listando anúncios ativos (Shopee): ${conta.nickname||conta.external_id}...`;
        let itemIds = [];
        let offset = 0;
        while (true) {
          let r;
          try { r = await MarketplaceAPI.call('shopee_list_items', { shopId: conta.external_id, item_status: 'NORMAL', offset, page_size: 100 }); }
          catch(e) { break; }
          const lista = r?.data?.response?.item || r?.data?.item || [];
          if (!Array.isArray(lista) || !lista.length) break;
          itemIds = itemIds.concat(lista.map(i => i.item_id));
          if (lista.length < 100) break;
          offset += 100;
        }
        const semVenda = itemIds.filter(id => !idsVendidosShopee.has(String(id)));
        if (status) status.textContent = `Checando visitas (Shopee): ${conta.nickname||conta.external_id} (${semVenda.length} anúncios sem venda)...`;

        const comVisita = []; // { item_id, visitas } — vira achado depois de buscar nome/preço/estoque
        for (let i=0; i<semVenda.length; i+=50) {
          const lote = semVenda.slice(i,i+50);
          try {
            const re = await MarketplaceAPI.call('shopee_get_extra_info', { shopId: conta.external_id, item_id_list: lote });
            const lista = re?.data?.response?.item_list || re?.data?.item_list || [];
            for (const it of lista) {
              const visitas = parseInt(it.views) || 0;
              if (visitas > 0 && !(parseInt(it.sale) > 0)) comVisita.push({ item_id: it.item_id, visitas });
            }
          } catch(e) {}
        }

        // shopee_get_extra_info não traz nome/preço/estoque — busca os detalhes
        // reais só de quem sobrou (bem menos itens que o catálogo inteiro)
        if (status) status.textContent = `Buscando detalhes dos produtos (Shopee): ${conta.nickname||conta.external_id}...`;
        for (let i=0; i<comVisita.length; i+=50) {
          const lote = comVisita.slice(i,i+50);
          try {
            const rd = await MarketplaceAPI.call('shopee_get_items_batch', { shopId: conta.external_id, item_id_list: lote.map(o=>o.item_id) });
            const detalhes = rd?.data?.response?.item_list || rd?.data?.item_list || [];
            const detMap = {};
            detalhes.forEach(d => { detMap[d.item_id] = d; });
            for (const o of lote) {
              const d = detMap[o.item_id] || {};
              achados.push({
                id: o.item_id, nome: d.item_name || `Item ${o.item_id}`,
                preco: d.price_min ?? d.price_max ?? 0, estoque: d.total_stock ?? 0,
                visitas: o.visitas, conta: conta.nickname || conta.external_id, mp: 'Shopee',
                link: `https://shopee.com.br/product/${conta.external_id}/${o.item_id}`,
              });
            }
          } catch(e) {
            // Falhou o detalhe — ainda mostra a oportunidade, só sem nome/preço/estoque
            lote.forEach(o => achados.push({
              id: o.item_id, nome: `Item ${o.item_id}`, preco: 0, estoque: 0,
              visitas: o.visitas, conta: conta.nickname || conta.external_id, mp: 'Shopee',
              link: `https://shopee.com.br/product/${conta.external_id}/${o.item_id}`,
            }));
          }
        }
      }

      achados.sort((a,b) => b.visitas - a.visitas);
      oportunidades = achados;
      oportAtualizadoEm = Date.now();
      if (status) status.textContent = '';
      try { localStorage.setItem(STORAGE_OPORT, JSON.stringify({ oportunidades, at: oportAtualizadoEm })); } catch(e) {}
    } catch(e) {
      if (status) status.textContent = `⚠️ Erro: ${e.message}`;
    } finally {
      buscandoOportunidades = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Buscar oportunidades'; }
      renderOportunidades();
    }
  }
  window.buscarOportunidades = buscarOportunidades;

  // ── Produtos ativos SEM nenhuma campanha de ADS — potencial de tráfego
  // pago que nunca foi testado. ML: checa item a item (ml_ads_get_ad, sem
  // endpoint em lote). Shopee: shopee_ads_recommended_items já vem pronto ──
  async function buscarForaDoAds() {
    if (buscandoForaDoAds) return;
    if (filtroContasSel.size === 0 && filtroEmpresas.size === 0) {
      GLR.avisar('Selecione ao menos uma conta ou empresa no filtro antes de buscar.', 'info');
      return;
    }
    const contasAlvo = filtroContasSel.size > 0
      ? contas.filter(c => filtroContasSel.has(c.external_id))
      : contas.filter(c => contaEmpresas(c).some(e => filtroEmpresas.has(e)));
    const contasML     = contasAlvo.filter(c => ['meli','ml','mercadolivre'].includes((c.marketplace||'').toLowerCase()));
    const contasShopee = contasAlvo.filter(c => (c.marketplace||'').toLowerCase() === 'shopee');
    if (!contasML.length && !contasShopee.length) { GLR.avisar('Nenhuma conta ML ou Shopee selecionada no filtro.', 'info'); return; }

    buscandoForaDoAds = true;
    const btn = document.getElementById('btn-buscar-fora-ads');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Buscando...'; }
    const status = document.getElementById('fora-ads-status');

    try {
      const achados = [];
      falhasForaAds = 0;

      // ── Mercado Livre: um item por vez (não existe lista em lote) ──
      for (const conta of contasML) {
        if (status) status.textContent = `Listando anúncios ativos: ${conta.nickname||conta.external_id}...`;
        const meliId = conta.param_to_use?.meliUserId || conta.external_id;
        const itemIds = await _mlListarIdsAtivos(meliId);
        if (status) status.textContent = `Checando ADS: ${conta.nickname||conta.external_id} (${itemIds.length} anúncios)...`;

        const foraDeAdsIds = [];
        const situacaoAds = {}; // itemId → texto da situação no Product Ads
        await _mapLimit(itemIds, 4, async itemId => {
          try {
            const ra = await _tentar(() => MarketplaceAPI.call('ml_ads_get_ad', { meliUserId: meliId, item_id: String(itemId) }));
            const ad = ra?.data || ra;
            const temCampanha = parseInt(ad?.campaign_id) > 0;
            if (ad?.status === 'active' && temCampanha) return; // está no ADS
            foraDeAdsIds.push(itemId);
            situacaoAds[itemId] = !temCampanha ? 'Sem campanha'
              : ad?.status === 'hold' ? 'Na campanha, anúncio suspenso pelo ML'
              : ad?.status === 'paused' ? 'Na campanha, anúncio pausado'
              : ad?.status === 'idle' ? 'Na campanha, anúncio parado (sem entrega)' : `Na campanha, anúncio ${ad?.status || 'inativo'}`;
          } catch(e) {
            // 404 = o anúncio nunca entrou no Product Ads; outro erro = não deu pra checar (fica de fora e é contado)
            if (/404|not.?found|no encontr|não encontr|inexist/i.test(e.message)) { foraDeAdsIds.push(itemId); situacaoAds[itemId] = 'Sem campanha'; }
            else falhasForaAds++;
          }
        });

        if (status) status.textContent = `Buscando nome/preço (ML): ${conta.nickname||conta.external_id}...`;
        const detalhes = await _mlDetalhesItens(meliId, foraDeAdsIds);
        for (const itemId of foraDeAdsIds) {
          const d = detalhes[itemId] || {};
          achados.push({
            id: itemId, nome: d.title || `Item ${itemId}`, preco: d.price ?? 0,
            estoque: d.available_quantity ?? 0, vendasTotal: d.sold_quantity ?? null, situacao: situacaoAds[itemId] || 'Sem campanha',
            contaId: conta.external_id, meliId, conta: contaNome(conta), mp: 'ML',
            link: `https://produto.mercadolivre.com.br/${String(itemId).replace('MLB','MLB-')}`,
          });
        }
      }

      // ── Shopee: shopee_ads_recommended_items diz quem está fora, mas não traz
      // nome/preço/estoque — busca via shopee_get_items_batch depois de filtrar ──
      for (const conta of contasShopee) {
        if (status) status.textContent = `Checando ADS (Shopee): ${conta.nickname||conta.external_id}...`;
        try {
          const rr = await MarketplaceAPI.call('shopee_ads_recommended_items', { shopId: conta.external_id });
          const lista = rr?.data?.response || rr?.data || [];
          const foraDeAds = (Array.isArray(lista) ? lista : []).filter(it => {
            const tipos = it.ongoing_ad_type_list || it.ongoing_ad_types || [];
            return !tipos.length || tipos.includes('no_ongoing_promotion');
          });

          if (status) status.textContent = `Buscando nome/preço (Shopee): ${conta.nickname||conta.external_id}...`;
          for (let i=0; i<foraDeAds.length; i+=50) {
            const lote = foraDeAds.slice(i,i+50);
            try {
              const rd = await MarketplaceAPI.call('shopee_get_items_batch', { shopId: conta.external_id, item_id_list: lote.map(it=>it.item_id) });
              const detalhes = rd?.data?.response?.item_list || rd?.data?.item_list || [];
              const detMap = {};
              detalhes.forEach(d => { detMap[d.item_id] = d; });
              for (const it of lote) {
                const d = detMap[it.item_id] || {};
                achados.push({
                  id: it.item_id, nome: d.item_name || `Item ${it.item_id}`,
                  preco: d.price_min ?? d.price_max ?? 0, estoque: d.total_stock ?? 0,
                  contaId: conta.external_id, conta: contaNome(conta), mp: 'Shopee',
                  link: `https://shopee.com.br/product/${conta.external_id}/${it.item_id}`,
                });
              }
            } catch(e) {
              lote.forEach(it => achados.push({
                id: it.item_id, nome: `Item ${it.item_id}`, preco: 0, estoque: 0,
                contaId: conta.external_id, conta: contaNome(conta), mp: 'Shopee',
                link: `https://shopee.com.br/product/${conta.external_id}/${it.item_id}`,
              }));
            }
          }
        } catch(e) {}
      }

      // ── Potencial de cada anúncio: visitas e vendas ──
      // ML: visitas desde sempre (1 chamada por anúncio) + vendas desde sempre
      // (já vêm na listagem). Shopee: vendas desde sempre (get_extra_info, lote
      // de 50) — a API não traz visitas confiáveis por anúncio. Vendas dos
      // últimos 30 dias vêm da base (sem chamada).
      if (status) status.textContent = `Buscando visitas e vendas de ${achados.length} anúncios...`;
      await _mapLimit(achados.filter(o => o.mp === 'ML'), 4, async o => {
        try {
          const r = await _tentar(() => MarketplaceAPI.call('raw', { method: 'GET', path: `/visits/items?ids=${o.id}`, meliUserId: o.meliId }));
          const v = parseInt((r?.data || r)?.[o.id]);
          if (!isNaN(v)) o.visitas = v;
        } catch (e) {}
      });
      const porLojaSh = {};
      achados.filter(o => o.mp === 'Shopee').forEach(o => (porLojaSh[o.contaId] = porLojaSh[o.contaId] || []).push(o));
      for (const [shopId, lista] of Object.entries(porLojaSh)) {
        for (let i = 0; i < lista.length; i += 50) {
          const lote = lista.slice(i, i + 50);
          try {
            const r = await MarketplaceAPI.call('shopee_get_extra_info', { shopId, item_id_list: lote.map(o => o.id).join(',') });
            const info = Object.fromEntries((r?.data?.response?.item_list || r?.response?.item_list || []).map(x => [String(x.item_id), x]));
            lote.forEach(o => { const x = info[String(o.id)]; if (x) o.vendasTotal = x.sale ?? null; });
          } catch (e) {}
        }
      }
      try {
        const de30 = new Date(ontem); de30.setDate(ontem.getDate() - 29);
        const vb = await carregarBaseVendas(contas.filter(c => achados.some(o => o.contaId === c.external_id)), fmtDate(de30), fmtDate(ontem));
        const v30 = {};
        for (const p of vb.pedidos) {
          if (isCanceladoVendas(p)) continue;
          for (const i of (p.itens || [])) { const k = `${p.contaId}|${p.plataforma === 'Shopee' ? i.shopeeItemId : i.itemId}`; v30[k] = (v30[k] || 0) + (parseInt(i.qtd) || 1); }
        }
        achados.forEach(o => { o.vendas30 = v30[`${o.contaId}|${o.id}`] || 0; });
      } catch (e) {}

      foraDoAds = achados;
      foraAdsAtualizadoEm = Date.now();
      if (status) status.textContent = '';
      try { localStorage.setItem(STORAGE_FORA_ADS, JSON.stringify({ foraDoAds, at: foraAdsAtualizadoEm })); } catch(e) {}
    } catch(e) {
      if (status) status.textContent = `⚠️ Erro: ${e.message}`;
    } finally {
      buscandoForaDoAds = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Buscar produtos fora do ADS'; }
      renderOportunidades();
    }
  }
  window.buscarForaDoAds = buscarForaDoAds;

  // ── Comparativo Semanal = Curva ABC semana a semana ─────────────────────────
  // Não depende do filtro de datas: usa SEMANAS FECHADAS de 7 dias terminando
  // ontem (8 semanas, lidas da base automática), respeitando conta e plataforma.
  //  • Curva ABC pelo faturamento das últimas 4 semanas (A = até 80% do
  //    acumulado, B = até 95%, C = resto);
  //  • tendência = última semana × média das 3 anteriores (queda/alta/parou/novo);
  //  • produto = anúncio por conta (mesmo nome em lojas diferentes não se mistura).
  const NSEM = 8, DIA_MS = 86400000;
  let semanal = { chave: null, pedidos: null, carregando: false, erro: null, viaBase: true };
  let semFiltro = 'atencao', semMetrica = 'un', semBusca = '', semLimite = 60;

  async function carregarSemanal(chave) {
    semanal = { chave, pedidos: null, carregando: true, erro: null, viaBase: true };
    renderComparativoSemanal();
    try {
      const de = new Date(ontem); de.setDate(ontem.getDate() - NSEM * 7 + 1);
      const alvo = filtroContasSel.size ? contas.filter(c => filtroContasSel.has(c.external_id)) : contas;
      const r = await carregarBaseVendas(alvo, fmtDate(de), fmtDate(ontem));
      if (r.cobertas.size) semanal.pedidos = r.pedidos;
      else { semanal.pedidos = pedidos; semanal.viaBase = false; } // conta fora da base: usa o que já foi buscado
    } catch (e) { semanal.erro = e.message; semanal.pedidos = pedidos; semanal.viaBase = false; }
    semanal.carregando = false;
    if (abaAtiva === 'semanal') renderComparativoSemanal();
  }

  // Códigos dos anúncios do produto, com link para abrir no marketplace
  function idsAnuncio(x) {
    const ids = [...(x.ids || [])], skus = [...(x.skus || [])];
    if (!ids.length && !skus.length) return '';
    const link = id => x.plataforma === 'Mercado Livre' ? `https://produto.mercadolivre.com.br/${String(id).replace(/^MLB(?=\d)/, 'MLB-')}`
      : x.plataforma === 'Shopee' && x.shopId ? `https://shopee.com.br/product/${x.shopId}/${id}` : null;
    const hh = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const partes = ids.slice(0, 3).map(id => { const u = link(id); return u ? `<a href="${u}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${hh(id)}</a>` : hh(id); });
    if (ids.length > 3) partes.push(`+${ids.length - 3}`);
    const sku = skus.length ? ` · SKU ${hh(skus.slice(0, 2).join(', '))}${skus.length > 2 ? '…' : ''}` : '';
    return `<div class="cs-ids" title="${hh([...ids, ...skus].join(' · '))}">${partes.join(' · ') || ''}${ids.length ? sku : sku.replace(/^ · /, '')}</div>`;
  }

  function calcularCurvaSemanal(lista) {
    const fimOntem = new Date(ontem); fimOntem.setHours(23, 59, 59, 999);
    const fimTs = fimOntem.getTime();
    const semDe = ts => Math.floor((fimTs - ts) / (7 * DIA_MS)); // 0 = últimos 7 dias
    const prods = new Map();
    for (const p of lista) {
      if (isCanceladoVendas(p)) continue;
      if (filtroPlat !== 'todas' && p.plataforma !== filtroPlat) continue;
      if (filtroContasSel.size > 0 && !filtroContasSel.has(p.contaId)) continue;
      const w = semDe(p.dataTs || 0);
      if (w < 0 || w >= NSEM) continue;
      const itens = (p.itens && p.itens.length) ? p.itens : [{ nome: p.produto, qtd: p.qtd || 1, preco: (p.valor || 0) / (p.qtd || 1) }];
      for (const it of itens) {
        const nome = it.nome || '—', k = `${p.contaId}|${nome}`;
        const x = prods.get(k) || { k, nome, contaId: p.contaId, plataforma: p.plataforma, imagem: it.imagem || p.imagem || '', un: Array(NSEM).fill(0), rs: Array(NSEM).fill(0), ids: new Set(), skus: new Set(), shopId: p.shopId || null };
        // código do anúncio (ML: MLB…; Shopee: item_id) e SKU — para achar o anúncio
        const idAn = it.itemId || it.shopeeItemId; if (idAn) x.ids.add(String(idAn));
        if (it.sku) x.skus.add(String(it.sku));
        const q = parseInt(it.qtd) || 1;
        x.un[w] += q; x.rs[w] += (parseFloat(it.preco) || 0) * q;
        if (!x.imagem && it.imagem) x.imagem = it.imagem;
        prods.set(k, x);
      }
    }
    const lista2 = [...prods.values()];
    // Curva ABC — faturamento das últimas 4 semanas
    for (const x of lista2) x.fat4 = x.rs.slice(0, 4).reduce((a, b) => a + b, 0);
    const total4 = lista2.reduce((a, x) => a + x.fat4, 0) || 1;
    let acum = 0;
    for (const x of [...lista2].sort((a, b) => b.fat4 - a.fat4)) {
      if (x.fat4 <= 0) { x.classe = '—'; continue; }
      const antes = acum / total4; acum += x.fat4;
      x.classe = antes < 0.8 ? 'A' : antes < 0.95 ? 'B' : 'C';
      x.part = x.fat4 / total4 * 100;
    }
    // Tendência: última semana × média das 3 anteriores
    for (const x of lista2) {
      const ult = x.un[0], media = (x.un[1] + x.un[2] + x.un[3]) / 3;
      const ultRs = x.rs[0], mediaRs = (x.rs[1] + x.rs[2] + x.rs[3]) / 3;
      x.ult = ult; x.media = media; x.deltaRs = ultRs - mediaRs;
      x.var = media > 0 ? (ult - media) / media * 100 : null;
      const vendiaAntes = x.un.slice(1).some(v => v > 0);
      if (ult > 0 && !vendiaAntes) x.tend = 'novo';
      else if (ult === 0 && media >= 1) x.tend = 'parou';
      else if (media < 1 && ult < 2) x.tend = 'baixo';
      else if (x.var <= -40) x.tend = 'queda_forte';
      else if (x.var <= -20) x.tend = 'queda';
      else if (x.var >= 40) x.tend = 'alta_forte';
      else if (x.var >= 20) x.tend = 'alta';
      else x.tend = 'estavel';
    }
    return { prods: lista2, total4, fimTs };
  }

  function renderComparativoSemanal() {
    const sec = document.getElementById('sec-semanal');
    if (!sec) return;
    const chave = `${[...filtroContasSel].sort().join(',')}|${fmtDate(ontem)}|${contas.length}`;
    if (semanal.chave !== chave && !semanal.carregando) { carregarSemanal(chave); return; }
    if (semanal.carregando || !semanal.pedidos) {
      sec.innerHTML = `<div class="card" style="padding:40px;text-align:center;color:var(--text-muted);">⏳ Montando a curva ABC das últimas ${NSEM} semanas…</div>`;
      return;
    }
    const { prods, total4, fimTs } = calcularCurvaSemanal(semanal.pedidos);
    if (!prods.length) {
      sec.innerHTML = `<div class="card" style="padding:40px;text-align:center;color:var(--text-muted);">Nenhuma venda nas últimas ${NSEM} semanas para o filtro escolhido.</div>`;
      return;
    }
    const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const dm = ts => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
    const faixa = w => `${dm(fimTs - (w * 7 + 6) * DIA_MS)}–${dm(fimTs - w * 7 * DIA_MS)}`;
    const varTxt = v => v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}%`;
    const multiConta = new Set(prods.map(x => x.contaId)).size > 1;
    const nomeConta = id => { const c = contas.find(c => c.external_id === id); return c ? contaNome(c) : id; };
    const TEND = {
      queda_forte: { t: '▼▼ Queda forte', c: 'var(--red)' }, queda: { t: '▼ Queda', c: 'var(--orange)' },
      parou: { t: '■ Parou de vender', c: 'var(--red)' }, alta_forte: { t: '▲▲ Alta forte', c: 'var(--green)' },
      alta: { t: '▲ Alta', c: 'var(--green)' }, novo: { t: '★ Novo', c: 'var(--accent)' }, estavel: { t: '● Estável', c: 'var(--text-muted)' }, baixo: { t: '· Pouco volume', c: 'var(--text-muted)' },
    };
    const caindo = x => ['queda', 'queda_forte', 'parou'].includes(x.tend);
    const subindo = x => ['alta', 'alta_forte', 'novo'].includes(x.tend);

    // Resumo
    const A = prods.filter(x => x.classe === 'A');
    const aCaindo = A.filter(caindo);
    const perdaA = aCaindo.reduce((s, x) => s + Math.min(0, x.deltaRs), 0);
    const sobem = prods.filter(x => subindo(x) && x.ult >= 2);
    const ganho = sobem.reduce((s, x) => s + Math.max(0, x.deltaRs), 0);
    const parados = prods.filter(x => x.tend === 'parou');
    const fatA = A.reduce((s, x) => s + x.fat4, 0);
    const card = (rot, val, sub, cor) => `<div class="cs-card" style="--c:${cor}"><div class="cs-rot">${rot}</div><div class="cs-val">${val}</div><div class="cs-sub">${sub}</div></div>`;

    // O que olhar primeiro
    const foco = [
      ...aCaindo.sort((a, b) => a.deltaRs - b.deltaRs).slice(0, 4).map(x => ({ x, txt: `Curva A ${x.tend === 'parou' ? 'parou de vender' : 'em queda'}: ${x.ult} un. na última semana contra média de ${x.media.toFixed(1).replace('.', ',')} — ${R$(Math.abs(x.deltaRs))} a menos. Revisar estoque, preço, anúncio e ADS.`, cor: 'var(--red)' })),
      ...prods.filter(x => (x.classe === 'B' || x.classe === 'C') && ['alta', 'alta_forte'].includes(x.tend) && x.ult >= 3).sort((a, b) => b.deltaRs - a.deltaRs).slice(0, 3).map(x => ({ x, txt: `Curva ${x.classe} subindo (${varTxt(x.var)}): candidato a virar A — vale reforçar ADS e estoque.`, cor: 'var(--green)' })),
    ];

    // Filtro / busca / ordenação
    const filtros = [['atencao', 'Precisa de atenção'], ['todos', 'Todos'], ['A', 'Curva A'], ['B', 'Curva B'], ['C', 'Curva C'], ['queda', 'Em queda'], ['alta', 'Em alta'], ['parou', 'Parados']];
    const passa = x => {
      if (semBusca && !`${x.nome} ${[...(x.ids || [])].join(' ')} ${[...(x.skus || [])].join(' ')}`.toLowerCase().includes(semBusca.toLowerCase())) return false; // busca também por código do anúncio e SKU
      switch (semFiltro) {
        case 'atencao': return (x.classe === 'A' && caindo(x)) || (x.classe !== 'A' && ['alta', 'alta_forte'].includes(x.tend) && x.ult >= 3) || (x.tend === 'parou' && x.classe !== 'C');
        case 'A': case 'B': case 'C': return x.classe === semFiltro;
        case 'queda': return ['queda', 'queda_forte'].includes(x.tend);
        case 'alta': return ['alta', 'alta_forte', 'novo'].includes(x.tend);
        case 'parou': return x.tend === 'parou';
        default: return true;
      }
    };
    const ordemClasse = { A: 0, B: 1, C: 2, '—': 3 };
    const visiveis = prods.filter(passa).sort((a, b) => semFiltro === 'atencao' || semFiltro === 'queda'
      ? (ordemClasse[a.classe] - ordemClasse[b.classe]) || (a.deltaRs - b.deltaRs)
      : (ordemClasse[a.classe] - ordemClasse[b.classe]) || (b.fat4 - a.fat4));
    const mostrar = visiveis.slice(0, semLimite);

    const spark = x => {
      const v = (semMetrica === 'rs' ? x.rs : x.un).slice().reverse(); // antiga → recente
      const mx = Math.max(...v, 1), W = 8, G = 3, H = 26;
      const corUlt = caindo(x) ? 'var(--red)' : subindo(x) ? 'var(--green)' : 'var(--text-secondary)';
      return `<svg width="${NSEM * (W + G)}" height="${H}" aria-hidden="true">${v.map((q, i) => { const hh = q > 0 ? Math.max(2, q / mx * H) : 1; return `<rect x="${i * (W + G)}" y="${H - hh}" width="${W}" height="${hh}" rx="2" fill="${i === NSEM - 1 ? corUlt : 'var(--text-muted)'}" opacity="${i === NSEM - 1 ? 1 : 0.45}"/>`; }).join('')}</svg>`;
    };
    const cel = (x, w) => { const v = semMetrica === 'rs' ? x.rs[w] : x.un[w]; return v ? (semMetrica === 'rs' ? R$(v).replace(/,\d{2}$/, '') : v) : '<span class="cs-mut">—</span>'; };
    const linhas = mostrar.map(x => {
      const t = TEND[x.tend];
      return `<tr>
        <td><span class="cs-abc cs-${x.classe === '—' ? 'n' : x.classe}">${x.classe}</span></td>
        <td class="cs-prod">${x.imagem ? `<img src="${h(x.imagem)}" alt="" loading="lazy">` : '<span class="cs-img"></span>'}<div><div class="cs-nome" title="${h(x.nome)}">${h(x.nome)}</div><div class="cs-mut">${multiConta ? h(nomeConta(x.contaId)) + ' · ' : ''}${h(x.plataforma)}${x.part ? ` · ${x.part.toFixed(1).replace('.', ',')}% do fat.` : ''}</div>${idsAnuncio(x)}</div></td>
        <td class="cs-num">${R$(x.fat4).replace(/,\d{2}$/, '')}</td>
        <td>${spark(x)}</td>
        ${[3, 2, 1, 0].map(w => `<td class="cs-num${w === 0 ? ' cs-ult' : ''}">${cel(x, w)}</td>`).join('')}
        <td class="cs-num" style="color:${x.var == null ? 'inherit' : x.var < 0 ? 'var(--red)' : x.var > 0 ? 'var(--green)' : 'inherit'};font-weight:700;">${varTxt(x.var)}</td>
        <td><span class="cs-tend" style="--c:${t.c}">${t.t}</span></td>
      </tr>`;
    }).join('');

    sec.innerHTML = `
      <div class="cs-topo">
        <div class="cs-mut">Semanas fechadas de 7 dias até ontem (${dm(fimTs)}) · curva ABC pelo faturamento das últimas 4 semanas (${R$(total4).replace(/,\d{2}$/, '')}) · tendência = última semana × média das 3 anteriores${semanal.viaBase ? '' : ' · <b>conta fora da base: usando só os pedidos já buscados</b>'}</div>
      </div>
      <div class="cs-cards">
        ${card('Curva A', `${A.length} produto${A.length === 1 ? '' : 's'}`, `${(fatA / total4 * 100).toFixed(0)}% do faturamento de 4 semanas`, 'var(--accent)')}
        ${card('Curva A em queda', `${aCaindo.length}`, aCaindo.length ? `${R$(Math.abs(perdaA)).replace(/,\d{2}$/, '')} a menos na última semana` : 'nenhum produto A caindo', aCaindo.length ? 'var(--red)' : 'var(--text-muted)')}
        ${card('Em alta', `${sobem.length}`, sobem.length ? `+${R$(ganho).replace(/,\d{2}$/, '')} na última semana` : 'nenhum produto subindo', 'var(--green)')}
        ${card('Pararam de vender', `${parados.length}`, 'vendiam e zeraram na última semana', parados.length ? 'var(--orange)' : 'var(--text-muted)')}
      </div>
      ${foco.length ? `<div class="card cs-foco"><div class="cs-foco-t">O que olhar primeiro</div>${foco.map(f => `<div class="cs-foco-i" style="--c:${f.cor}"><b>${h(f.x.nome)}</b>${multiConta ? ` <span class="cs-mut">(${h(nomeConta(f.x.contaId))})</span>` : ''}<div>${h(f.txt)}</div></div>`).join('')}</div>` : ''}
      <div class="cs-ctrl">
        <div class="cs-chips">${filtros.map(([v, r]) => `<button class="cs-chip${semFiltro === v ? ' on' : ''}" onclick="window._csFiltro('${v}')">${r}</button>`).join('')}</div>
        <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;">
          <input id="cs-busca" class="form-input" placeholder="Buscar produto…" value="${h(semBusca)}" style="width:200px;">
          <div class="cs-chips"><button class="cs-chip${semMetrica === 'un' ? ' on' : ''}" onclick="window._csMetrica('un')">Unidades</button><button class="cs-chip${semMetrica === 'rs' ? ' on' : ''}" onclick="window._csMetrica('rs')">Faturamento</button></div>
        </div>
      </div>
      <div class="card" style="padding:0;overflow:hidden;">
        <div style="overflow-x:auto;">
          <table class="cs-tab">
            <thead><tr><th>ABC</th><th>Produto</th><th class="cs-num">Fat. 4 sem.</th><th>${NSEM} semanas</th>
              ${[3, 2, 1, 0].map(w => `<th class="cs-num${w === 0 ? ' cs-ult' : ''}">${w === 0 ? 'Última' : `${w + 1}ª antes`}<div class="cs-faixa">${faixa(w)}</div></th>`).join('')}
              <th class="cs-num">Últ. × média</th><th>Tendência</th></tr></thead>
            <tbody>${linhas || `<tr><td colspan="10" style="padding:28px;text-align:center;color:var(--text-muted);">Nada neste filtro. ✅</td></tr>`}</tbody>
          </table>
        </div>
        ${visiveis.length > mostrar.length ? `<div style="padding:var(--space-3);text-align:center;"><button class="cs-chip" onclick="window._csMais()">Mostrar mais (${visiveis.length - mostrar.length})</button></div>` : ''}
      </div>
      <style>
        .cs-mut{color:var(--text-muted);font-size:var(--fs-1);}
        .cs-ids{font-size:var(--fs-1);color:var(--text-muted);font-family:ui-monospace,monospace;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:380px;} .cs-ids a{color:var(--accent);text-decoration:none;} .cs-ids a:hover{text-decoration:underline;}
        .cs-topo{margin-bottom:var(--space-3);}
        .cs-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-3);margin-bottom:14px;}
        @media (max-width:900px){.cs-cards{grid-template-columns:repeat(2,1fr);}}
        .cs-card{background:var(--bg-card);border:1px solid var(--border);border-left:4px solid var(--c);border-radius:12px;padding:12px 14px;}
        .cs-rot{font-size:var(--fs-1);text-transform:none;letter-spacing:0;color:var(--text-muted);}
        .cs-val{font-size:var(--fs-5);font-weight:700;color:var(--text-primary);font-variant-numeric:tabular-nums;}
        .cs-sub{font-size:var(--fs-2);color:var(--text-secondary);}
        .cs-foco{padding:14px 18px;margin-bottom:14px;}
        .cs-foco-t{font-weight:700;font-size:var(--fs-3);margin-bottom:var(--space-2);color:var(--text-primary);}
        .cs-foco-i{border-left:3px solid var(--c);padding:6px 10px;margin-bottom:6px;font-size:var(--fs-2);color:var(--text-secondary);}
        .cs-foco-i b{color:var(--text-primary);}
        .cs-ctrl{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px;}
        .cs-chips{display:flex;gap:6px;flex-wrap:wrap;}
        .cs-chip{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:var(--fs-2);font-weight:600;cursor:pointer;}
        .cs-chip.on{background:var(--accent);border-color:var(--accent);color:#fff;}
        .cs-tab{width:100%;border-collapse:collapse;font-size:var(--fs-2);}
        .cs-tab th{padding:9px 10px;text-align:left;font-size:var(--fs-1);text-transform:none;color:var(--text-secondary);background:var(--bg-card-hover);white-space:nowrap;}
        .cs-tab td{padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text-secondary);vertical-align:middle;}
        .cs-num{text-align:right !important;font-variant-numeric:tabular-nums;white-space:nowrap;}
        .cs-ult{background:rgba(99,102,241,.06);color:var(--text-primary) !important;font-weight:700;}
        .cs-faixa{font-size:var(--fs-1);font-weight:500;text-transform:none;color:var(--text-muted);}
        .cs-prod{display:flex;gap:10px;align-items:center;min-width:280px;max-width:420px;}
        .cs-prod img,.cs-img{width:34px;height:34px;border-radius:6px;object-fit:cover;flex:none;background:var(--bg-card-hover);}
        .cs-nome{color:var(--text-primary);font-weight:600;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
        .cs-abc{display:inline-flex;width:24px;height:24px;border-radius:6px;align-items:center;justify-content:center;font-weight:700;font-size:var(--fs-2);}
        .cs-A{background:rgba(42,120,214,.15);color:var(--accent);} .cs-B{background:rgba(235,104,52,.15);color:#eb6834;} .cs-C{background:rgba(100,116,139,.15);color:var(--text-muted);} .cs-n{color:var(--text-muted);}
        .cs-tend{display:inline-block;font-size:var(--fs-1);font-weight:700;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);padding:3px 9px;border-radius:99px;white-space:nowrap;}
      </style>`;
    const busca = document.getElementById('cs-busca');
    if (busca) busca.addEventListener('input', e => {
      semBusca = e.target.value; clearTimeout(window._csT);
      window._csT = setTimeout(() => { renderComparativoSemanal(); const b = document.getElementById('cs-busca'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 250);
    });
  }
  window._csFiltro = v => { semFiltro = v; semLimite = 60; renderComparativoSemanal(); };
  window._csMetrica = v => { semMetrica = v; renderComparativoSemanal(); };
  window._csMais = () => { semLimite += 100; renderComparativoSemanal(); };

  // ── Painel automático de oportunidades ──────────────────────────────────────
  // Sem botão: lê o que a sincronização calcula 1x por dia por loja (produtos
  // que VENDEM FORA do ADS, com visitas de 30 dias no ML) + a curva ABC
  // semanal + as sugestões pendentes dos agentes. A busca detalhada antiga
  // (visitas sem venda, varredura pela API) continua logo abaixo.
  let opAuto = { carregando: false, em: 0, linhas: null, agentes: [], erro: null };
  async function carregarOportunidadesAuto(forcar) {
    if (opAuto.carregando || (!forcar && opAuto.linhas && Date.now() - opAuto.em < 5 * 60000)) return;
    opAuto.carregando = true;
    try {
      const [st, lg] = await Promise.all([
        _sb.from('glr_sync_estado').select('marketplace,conta_id,ultimo_sucesso,cursor').eq('recurso', 'oportunidades'),
        _sb.from('glr_agente_log').select('id,conta_id,titulo,dados,criado_em').eq('tipo', 'alerta').eq('resultado', 'so_alerta').gte('criado_em', new Date(Date.now() - 14 * 86400000).toISOString()).order('criado_em', { ascending: false }).limit(300),
      ]);
      if (st.error) throw st.error;
      opAuto.linhas = st.data || [];
      opAuto.agentes = (lg.data || []).filter(l => l.dados?.origem_analise === 'curva_abc_semanal' || ['adicionar_produto', 'abc_queda'].includes(l.dados?.acao));
      opAuto.erro = null; opAuto.em = Date.now();
    } catch (e) { opAuto.erro = e.message || String(e); }
    opAuto.carregando = false;
    if (abaAtiva === 'oportunidades') renderOportunidadesAuto();
  }

  function renderOportunidadesAuto() {
    const box = document.getElementById('op-auto');
    if (!box) return;
    if (!opAuto.linhas) { box.innerHTML = `<div class="card" style="padding:30px;text-align:center;color:var(--text-muted);">${opAuto.erro ? '⚠️ ' + opAuto.erro : '⏳ Carregando oportunidades…'}</div>`; return; }
    const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // conta da base → conta da tela
    const contaDaBase = {};
    contas.forEach(c => { const m = window.BaseDados ? BaseDados.mktDe(c.marketplace) : null; if (m) contaDaBase[`${m}:${idNaBase(c)}`] = c; });
    const dentroFiltro = c => c && (filtroContasSel.size === 0 || filtroContasSel.has(c.external_id));
    // curva ABC semanal (se já calculada) para classe/tendência
    const abc = {};
    if (semanal.pedidos && !semanal.carregando) calcularCurvaSemanal(semanal.pedidos).prods.forEach(x => { abc[`${x.contaId}|${x.nome}`] = x; });
    else if (!semanal.carregando) { const ch = `${[...filtroContasSel].sort().join(',')}|${fmtDate(ontem)}|${contas.length}`; if (semanal.chave !== ch) carregarSemanal(ch).then(() => { if (abaAtiva === 'oportunidades') renderOportunidadesAuto(); }); }
    const TEND = { queda_forte: '▼▼ queda forte', queda: '▼ queda', parou: '■ parou', alta_forte: '▲▲ alta forte', alta: '▲ alta', novo: '★ novo', estavel: '● estável', baixo: '· pouco volume' };
    const corT = t => ['queda', 'queda_forte', 'parou'].includes(t) ? 'var(--red)' : ['alta', 'alta_forte'].includes(t) ? 'var(--green)' : t === 'novo' ? 'var(--accent)' : 'var(--text-muted)';

    const itens = [];
    let ultima = null, semDado = 0;
    for (const r of opAuto.linhas) {
      const c = contaDaBase[`${r.marketplace}:${r.conta_id}`];
      if (!dentroFiltro(c)) continue;
      const plat = r.marketplace === 'shopee' ? 'Shopee' : 'Mercado Livre';
      if (filtroPlat !== 'todas' && filtroPlat !== plat) continue;
      if (!r.cursor?.candidatos) { semDado++; continue; }
      if (!ultima || r.ultimo_sucesso > ultima) ultima = r.ultimo_sucesso;
      for (const v of r.cursor.candidatos) {
        const x = abc[`${c.external_id}|${v.nome}`];
        itens.push({ ...v, plat, conta: c, gmvLoja: r.cursor.gmv_loja, classe: x?.classe || null, tend: x?.tend || null, conv: v.visitas ? v.un / v.visitas * 100 : null });
      }
    }
    // Prioridade: curva A/B e em alta primeiro, depois faturamento
    const peso = it => (it.classe === 'A' ? 3 : it.classe === 'B' ? 2 : 1) * (['alta', 'alta_forte', 'novo'].includes(it.tend) ? 1.5 : 1) * it.rs;
    itens.sort((a, b) => peso(b) - peso(a));
    const multi = new Set(itens.map(i => i.conta.external_id)).size > 1;
    const rsTot = itens.reduce((s, i) => s + i.rs, 0);
    const nML = itens.filter(i => i.plat === 'Mercado Livre').length, nSh = itens.length - nML;
    const ag = opAuto.agentes.filter(l => { const c = contas.find(c => idNaBase(c) === String(l.conta_id)); return !c || dentroFiltro(c); });
    const link = it => it.plat === 'Shopee' ? `https://shopee.com.br/product/${idNaBase(it.conta)}/${it.item_id}` : `https://produto.mercadolivre.com.br/${String(it.item_id).replace(/^MLB/, 'MLB-')}`;
    const acao = it => it.plat === 'Mercado Livre' ? 'Colocar numa campanha de Product Ads'
      : it.gmvLoja ? 'Só no GMV Max da Loja — vale campanha individual' : 'Sem ADS — criar campanha individual (ou ligar o GMV Max da Loja)';
    const card = (rot, val, sub, cor) => `<div class="op-card" style="--c:${cor}"><div class="op-rot">${rot}</div><div class="op-val">${val}</div><div class="op-sub">${sub}</div></div>`;

    box.innerHTML = `
      <div class="op-head">
        <div><div class="op-tit">Vendendo fora do ADS</div>
        <div class="op-sub">Produtos com 2+ vendas nos últimos 30 dias que não estão em campanha (ML: anúncio fora do Product Ads; Shopee: fora de campanha individual). Calculado sozinho 1x por dia pela sincronização${ultima ? ` · atualizado ${fmtAgo(Date.parse(ultima))}` : ''}${semDado ? ` · ${semDado} conta(s) ainda sem a 1ª leitura` : ''}.</div></div>
      </div>
      <div class="op-cards">
        ${card('Produtos fora do ADS vendendo', itens.length, `${R$(rsTot).replace(/,\d{2}$/, '')} vendidos em 30 dias`, 'var(--accent)')}
        ${card('Mercado Livre', nML, 'anúncios fora do Product Ads', '#eb6834')}
        ${card('Shopee', nSh, 'fora de campanha individual', 'var(--green)')}
        ${card('Sugestões dos agentes', ag.length, 'curva ABC e “colocar em campanha”, pendentes', ag.length ? 'var(--yellow)' : 'var(--text-muted)')}
      </div>
      ${ag.length ? `<details class="card op-ag"><summary>Sugestões pendentes dos agentes (${ag.length})</summary>${ag.slice(0, 12).map(l => {
        const c = contas.find(c => idNaBase(c) === String(l.conta_id));
        const ml = l.dados?.marketplace === 'ml';
        return `<div class="op-ag-i"><b>${h(l.titulo)}</b>${c ? ` <span class="op-sub">· ${h(contaNome(c))}</span>` : ''} <a href="#" onclick="Router.navigate('${ml ? 'agente-ml' : 'agente'}');return false;">abrir no agente →</a></div>`;
      }).join('')}</details>` : ''}
      <div class="card" style="padding:0;overflow:hidden;margin-bottom:18px;">
        <div style="overflow-x:auto;"><table class="op-tab">
          <thead><tr><th>Produto</th><th>Curva / tendência</th><th class="op-n">Vendas 30d</th><th class="op-n">Faturado 30d</th><th class="op-n">Visitas 30d</th><th class="op-n">Conversão</th><th>Sugestão</th></tr></thead>
          <tbody>${itens.length ? itens.slice(0, 120).map(it => `<tr>
            <td style="min-width:260px;white-space:normal;"><a href="${link(it)}" target="_blank" rel="noopener" class="op-nome">${it.plat === 'Shopee' ? '🟠' : '🟡'} ${h(it.nome)}</a><div class="op-sub">${multi ? h(contaNome(it.conta)) + ' · ' : ''}${h(it.item_id)}</div></td>
            <td>${it.classe ? `<b>${it.classe}</b>` : '<span class="op-sub">—</span>'}${it.tend ? ` <span style="color:${corT(it.tend)};font-weight:700;font-size:var(--fs-1);">${TEND[it.tend]}</span>` : ''}</td>
            <td class="op-n">${it.un} un.</td><td class="op-n">${R$(it.rs)}</td>
            <td class="op-n">${it.visitas != null ? it.visitas.toLocaleString('pt-BR') : '<span class="op-sub">—</span>'}</td>
            <td class="op-n">${it.conv != null ? it.conv.toFixed(1).replace('.', ',') + '%' : '<span class="op-sub">—</span>'}</td>
            <td style="white-space:normal;font-size:var(--fs-2);">${acao(it)}</td></tr>`).join('')
            : `<tr><td colspan="7" style="padding:26px;text-align:center;color:var(--text-muted);">${semDado && !opAuto.linhas.some(r => r.cursor?.candidatos) ? 'A primeira leitura sai na próxima sincronização (a partir das 06:00).' : 'Nenhum produto vendendo fora do ADS neste filtro. ✅'}</td></tr>`}</tbody>
        </table></div>
      </div>
      <style>
        .op-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:var(--space-3);}
        .op-tit{font-size:var(--fs-4);font-weight:700;color:var(--text-primary);}
        .op-sub{font-size:var(--fs-2);color:var(--text-muted);line-height:1.5;}
        .op-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-3);margin-bottom:14px;}
        @media (max-width:900px){.op-cards{grid-template-columns:repeat(2,1fr);}}
        .op-card{background:var(--bg-card);border:1px solid var(--border);border-left:4px solid var(--c);border-radius:12px;padding:12px 14px;}
        .op-rot{font-size:var(--fs-1);text-transform:none;letter-spacing:0;color:var(--text-muted);}
        .op-val{font-size:var(--fs-5);font-weight:700;color:var(--text-primary);font-variant-numeric:tabular-nums;}
        .op-ag{padding:12px 18px;margin-bottom:14px;} .op-ag summary{cursor:pointer;font-weight:700;color:var(--text-primary);}
        .op-ag-i{padding:7px 0;border-bottom:1px solid var(--border);font-size:var(--fs-2);color:var(--text-secondary);} .op-ag-i a{color:var(--accent);font-size:var(--fs-2);}
        .op-tab{width:100%;border-collapse:collapse;font-size:var(--fs-2);}
        .op-tab th{padding:9px 10px;text-align:left;font-size:var(--fs-1);text-transform:none;color:var(--text-secondary);background:var(--bg-card-hover);white-space:nowrap;}
        .op-tab td{padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text-secondary);vertical-align:middle;}
        .op-n{text-align:right !important;font-variant-numeric:tabular-nums;white-space:nowrap;}
        .op-nome{color:var(--text-primary);font-weight:600;text-decoration:none;}
      </style>`;
  }

  function renderOportunidades() {
    const sec = document.getElementById('sec-oportunidades');
    if (!sec) return;
    if (!document.getElementById('op-auto')) {
      sec.innerHTML = `<div id="op-auto"></div>
        <details class="card" style="padding:12px 18px;" id="op-manual-wrap"><summary style="cursor:pointer;font-weight:700;color:var(--text-primary);">Busca detalhada pela API — visitas sem venda e produtos que nunca tiveram ADS</summary><div id="sec-oport-manual" style="margin-top:var(--space-3);"></div></details>`;
    }
    renderOportunidadesAuto();
    renderOportunidadesManual();
    carregarOportunidadesAuto();
  }

  function renderOportunidadesManual() {
    const sec = document.getElementById('sec-oport-manual');
    if (!sec) return;

    if (oportunidades === null) {
      sec.innerHTML = `
        <div class="card" style="padding:40px;text-align:center;">
          <div style="font-size:var(--fs-6);margin-bottom:var(--space-3);">🎯</div>
          <div style="font-size:var(--fs-4);font-weight:700;color:var(--text-primary);margin-bottom:var(--space-2);">Oportunidade de Produtos</div>
          <div style="font-size:var(--fs-3);color:var(--text-muted);margin-bottom:var(--space-5);max-width:480px;margin-left:auto;margin-right:auto;">
            Encontra anúncios ativos que tiveram visitas mas ainda não venderam —
            produtos com tráfego que não está convertendo, com potencial pra alavancar (preço, imagem, anúncio patrocinado).
            No <strong>Mercado Livre</strong> as visitas são do período filtrado; na <strong>Shopee</strong> a API só retorna
            visitas acumuladas (sem filtro de data), então o número ali é o total desde sempre.
          </div>
          <button id="btn-buscar-oport" class="btn-primary" onclick="buscarOportunidades()" style="padding:10px 20px;">Buscar oportunidades</button>
          <div id="oport-status" style="font-size:var(--fs-2);color:var(--text-muted);margin-top:var(--space-3);"></div>
        </div>
        ${renderForaDoAdsHTML()}
      `;
      const btnFora0 = document.getElementById('btn-buscar-fora-ads');
      if (btnFora0) btnFora0.onclick = buscarForaDoAds;
      return;
    }

    const linhas = oportunidades.map(o => `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px 12px;color:var(--text-primary);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(o.nome||'').replace(/"/g,'&quot;')}">${o.mp==='Shopee'?'🟠':'🟡'} ${o.nome||'—'}</td>
        <td style="padding:10px 12px;color:var(--text-secondary);">${o.conta}</td>
        <td style="padding:10px 12px;text-align:right;font-weight:700;color:var(--yellow);">${o.visitas.toLocaleString('pt-BR')}${o.mp==='Shopee'?' <span style="font-size:var(--fs-1);color:var(--text-muted);">(total)</span>':''}</td>
        <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${o.preco ? R$(o.preco) : '—'}</td>
        <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${o.estoque || '—'}</td>
        <td style="padding:10px 12px;text-align:right;">${o.link ? `<a href="${o.link}" target="_blank" style="color:var(--accent);font-size:var(--fs-2);">Ver anúncio ↗</a>` : ''}</td>
      </tr>`).join('');

    sec.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
        <div style="font-size:var(--fs-3);color:var(--text-secondary);">${oportunidades.length} produto${oportunidades.length!==1?'s':''} com visitas e sem venda no período ${oportAtualizadoEm?`<span style="font-size:var(--fs-1);background:rgba(99,102,241,0.2);color:var(--accent-light);padding:1px 7px;border-radius:8px;margin-left:6px;">${fmtAgo(oportAtualizadoEm)}</span>`:''}${falhasOport ? `<div style="font-size:var(--fs-2);font-weight:600;color:var(--red);margin-top:3px;">⚠️ ${falhasOport} anúncio(s) não responderam à consulta de visitas (limite da API) — clique em Buscar de novo.</div>` : ''}${diagOport ? `<div style="font-size:var(--fs-1);color:var(--text-muted);margin-top:3px;">ML: ${diagOport.ativos} anúncios ativos · ${diagOport.vendidos} venderam no período · ${diagOport.checados} sem venda checados · ${diagOport.comVisita} com visita${diagOport.erro ? ` · erro: ${diagOport.erro.replace(/</g,'&lt;')}` : ''}${!diagOport.comVisita && diagOport.exemplo ? ` · resposta da API: <code>${diagOport.exemplo.replace(/</g,'&lt;')}</code>` : ''}</div>` : ''}</div>
        <button id="btn-buscar-oport" class="btn" onclick="buscarOportunidades()" style="padding:7px 14px;font-size:var(--fs-2);">Buscar de novo</button>
      </div>
      ${oportunidades.length === 0 ? `
        <div class="card" style="padding:var(--space-8);text-align:center;color:var(--text-muted);">Nenhuma oportunidade encontrada — todos os anúncios com visita já converteram, ou nenhum teve visita no período.</div>
      ` : `
        <div class="card" style="padding:0;overflow:hidden;">
          <table style="width:100%;border-collapse:collapse;font-size:var(--fs-3);">
            <thead><tr style="background:var(--bg-card-hover);">
              <th style="padding:10px 12px;text-align:left;color:var(--text-secondary);font-size:var(--fs-1);text-transform:none;">Produto</th>
              <th style="padding:10px 12px;text-align:left;color:var(--text-secondary);font-size:var(--fs-1);text-transform:none;">Conta</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-secondary);font-size:var(--fs-1);text-transform:none;">Visitas</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-secondary);font-size:var(--fs-1);text-transform:none;">Preço</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-secondary);font-size:var(--fs-1);text-transform:none;">Estoque</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-secondary);font-size:var(--fs-1);text-transform:none;"></th>
            </tr></thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>
      `}
      ${renderForaDoAdsHTML()}
    `;

    // O botão de "fora do ADS" só é (re)vinculado depois do innerHTML acima existir
    const btnFora = document.getElementById('btn-buscar-fora-ads');
    if (btnFora) btnFora.onclick = buscarForaDoAds;
  }

  function renderForaDoAdsHTML() {
    if (foraDoAds === null) {
      return `
        <div class="card" style="padding:var(--space-8);text-align:center;margin-top:var(--space-5);">
          <div style="font-size:var(--fs-6);margin-bottom:10px;">🚫</div>
          <div style="font-size:var(--fs-4);font-weight:700;color:var(--text-primary);margin-bottom:var(--space-2);">Produtos Fora do ADS</div>
          <div style="font-size:var(--fs-3);color:var(--text-muted);margin-bottom:var(--space-4);max-width:480px;margin-left:auto;margin-right:auto;">
            Anúncios ativos que nunca receberam investimento em anúncio patrocinado — candidatos a testar tráfego pago.
          </div>
          <button id="btn-buscar-fora-ads" class="btn-primary" style="padding:10px 20px;">Buscar produtos fora do ADS</button>
          <div id="fora-ads-status" style="font-size:var(--fs-2);color:var(--text-muted);margin-top:var(--space-3);"></div>
        </div>`;
    }

    // Potencial para campanha: vendeu recentemente e/ou tem tráfego que converte
    const conv = o => o.visitas > 0 && o.vendasTotal != null ? o.vendasTotal / o.visitas * 100 : null;
    const potencial = o => {
      const c = conv(o), v30 = o.vendas30 || 0;
      if (v30 >= 3 || (o.visitas >= 300 && c >= 1)) return { t: 'Alto', cor: 'var(--green)', n: 3 };
      if (v30 >= 1 || (o.vendasTotal || 0) >= 5 || o.visitas >= 150) return { t: '▲ Médio', cor: 'var(--yellow)', n: 2 };
      return { t: '· Baixo', cor: 'var(--text-muted)', n: 1 };
    };
    const lista = [...foraDoAds].sort((a, b) => potencial(b).n - potencial(a).n || (b.vendas30 || 0) - (a.vendas30 || 0) || (b.vendasTotal || 0) - (a.vendasTotal || 0) || (b.visitas || 0) - (a.visitas || 0));
    const nAlto = lista.filter(o => potencial(o).n === 3).length;
    const th = (t, dir, tip) => `<th style="padding:10px 12px;text-align:${dir || 'left'};color:var(--text-secondary);font-size:var(--fs-1);text-transform:none;white-space:nowrap;"${tip ? ` title="${tip}"` : ''}>${t}</th>`;
    const td = (v, forte) => `<td style="padding:10px 12px;text-align:right;color:${forte ? 'var(--text-primary)' : 'var(--text-secondary)'};${forte ? 'font-weight:700;' : ''}font-variant-numeric:tabular-nums;white-space:nowrap;">${v}</td>`;
    const num = v => v == null ? '<span style="color:var(--text-muted);">—</span>' : Number(v).toLocaleString('pt-BR');
    const linhas = lista.map(o => {
      const pt = potencial(o), c = conv(o);
      return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px 12px;color:var(--text-primary);max-width:340px;" title="${(o.nome||'').replace(/"/g,'&quot;')}"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${o.mp==='Shopee'?'🟠':'🟡'} ${o.nome||'—'}</div><div style="font-size:var(--fs-1);color:var(--text-muted);">${o.conta} · ${o.id}</div></td>
        <td style="padding:10px 12px;"><span style="font-size:var(--fs-1);font-weight:700;color:${pt.cor};white-space:nowrap;">${pt.t}</span></td>
        <td style="padding:10px 12px;font-size:var(--fs-2);color:${(o.situacao || 'Sem campanha') === 'Sem campanha' ? 'var(--text-secondary)' : 'var(--yellow)'};">${o.situacao || 'Sem campanha'}</td>
        ${td(o.mp === 'Shopee' ? '<span style="color:var(--text-muted);" title="A API da Shopee não informa visitas confiáveis por anúncio">—</span>' : num(o.visitas))}
        ${td(num(o.vendasTotal))}
        ${td(num(o.vendas30 ?? null), (o.vendas30 || 0) > 0)}
        ${td(c != null ? c.toFixed(1).replace('.', ',') + '%' : '<span style="color:var(--text-muted);">—</span>')}
        ${td(o.preco ? R$(o.preco) : '—')}
        ${td(o.estoque || '—')}
        <td style="padding:10px 12px;text-align:right;">${o.link ? `<a href="${o.link}" target="_blank" style="color:var(--accent);font-size:var(--fs-2);white-space:nowrap;">Ver anúncio ↗</a>` : ''}</td>
      </tr>`;
    }).join('');

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;margin:var(--space-6) 0 var(--space-4);gap:10px;flex-wrap:wrap;">
        <div style="font-size:var(--fs-3);font-weight:700;color:var(--text-primary);">${foraDoAds.length} produto${foraDoAds.length!==1?'s':''} ativo${foraDoAds.length!==1?'s':''} sem nenhuma campanha de ADS${nAlto ? ` · <span style="color:var(--green);">${nAlto} com potencial alto</span>` : ''} ${foraAdsAtualizadoEm?`<span style="font-size:var(--fs-1);font-weight:400;background:rgba(99,102,241,0.2);color:var(--accent-light);padding:1px 7px;border-radius:8px;margin-left:6px;">${fmtAgo(foraAdsAtualizadoEm)}</span>`:''}
          ${falhasForaAds ? `<div style="font-size:var(--fs-2);font-weight:600;color:var(--red);margin-top:3px;">⚠️ ${falhasForaAds} anúncio(s) não responderam à checagem de ADS (limite da API) — clique em Buscar de novo.</div>` : ''}
          <div style="font-size:var(--fs-1);font-weight:400;color:var(--text-muted);margin-top:3px;">Visitas e vendas totais = desde a criação do anúncio (ML). Vendas 30 dias = base automática. Potencial alto: 3+ vendas em 30 dias, ou 300+ visitas convertendo 1% ou mais.</div></div>
        <button id="btn-buscar-fora-ads" class="btn" style="padding:7px 14px;font-size:var(--fs-2);">Buscar de novo</button>
      </div>
      ${foraDoAds.length === 0 ? `
        <div class="card" style="padding:var(--space-8);text-align:center;color:var(--text-muted);">Todos os anúncios ativos já têm alguma campanha de ADS.</div>
      ` : `
        <div class="card" style="padding:0;overflow:hidden;"><div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:var(--fs-3);">
            <thead><tr style="background:var(--bg-card-hover);">
              ${th('Produto')}${th('Potencial')}${th('Situação no ADS')}${th('Visitas (total)', 'right')}${th('Vendas (total)', 'right')}${th('Vendas 30 dias', 'right')}${th('Conversão', 'right', 'vendas totais ÷ visitas totais')}${th('Preço', 'right')}${th('Estoque', 'right')}${th('', 'right')}
            </tr></thead>
            <tbody>${linhas}</tbody>
          </table>
        </div></div>
      `}`;
  }

  // ── Dashboard ────────────────────────────────────────────────
  // Gráfico de receitas (Chart.js): área suave, largura total, tooltip por dia.
  // Cores: 3 primeiras do tema categórico validado (azul, laranja, verde-água) —
  // distinguíveis também por quem tem daltonismo; texto sempre nas cores do tema.
  function desenharGraficoReceitas(porDia) {
    const cv = document.getElementById('vg-canvas');
    if (!cv || !window.Chart) return;
    const claro = document.body.classList.contains('light');
    const cor = claro ? { fat: '#2a78d6', liq: '#eb6834', luc: '#1baf7a', texto: '#475569', grade: 'rgba(15,23,42,0.07)', fundo: '#ffffff', borda: 'rgba(15,23,42,0.12)', titulo: '#0f172a' }
                      : { fat: '#3987e5', liq: '#d95926', luc: '#199e70', texto: '#94a3b8', grade: 'rgba(255,255,255,0.06)', fundo: '#111827', borda: 'rgba(255,255,255,0.12)', titulo: '#f1f5f9' };
    // Eixo X = todos os dias do período filtrado
    const { dataFrom, dataTo } = _periodoParaDatas();
    const dias = [];
    for (let d = new Date(`${dataFrom}T12:00:00`), fim = new Date(`${dataTo}T12:00:00`); d <= fim && dias.length < 400; d.setDate(d.getDate() + 1)) dias.push(d.toLocaleDateString('pt-BR'));
    if (!dias.length) dias.push(...Object.keys(porDia));
    const serie = k => dias.map(d => Math.round((porDia[d]?.[k] || 0) * 100) / 100);
    const rotulo = d => { const [dd, mm] = d.split('/'); return `${dd}/${mm}`; };
    const kfmt = v => Math.abs(v) >= 1000 ? `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
    const grad = (ctx, c, a) => { const { chartArea } = ctx.chart; if (!chartArea) return c + '00'; const g = ctx.chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom); g.addColorStop(0, c + a); g.addColorStop(1, c + '00'); return g; };
    const ds = (label, k, c, a) => ({ label, data: serie(k), borderColor: c, backgroundColor: ctx => grad(ctx, c, a), fill: 'origin', borderWidth: 2, tension: 0.35, cubicInterpolationMode: 'monotone', pointRadius: dias.length === 1 ? 4 : 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: cor.fundo, pointBackgroundColor: c });
    const legenda = document.getElementById('vg-legenda');
    if (legenda) legenda.innerHTML = [['Faturamento', cor.fat], ['Líquido MP', cor.liq], ['Lucro', cor.luc]].map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
    if (window._vendasGrafico) { try { window._vendasGrafico.destroy(); } catch (e) {} }
    if (dias.length === 1) {
      const d0 = porDia[dias[0]] || {};
      const vals = [d0.fat || 0, d0.liq || 0, d0.lucro || 0], cores = [cor.fat, cor.liq, cor.luc];
      window._vendasGrafico = new Chart(cv, {
        type: 'bar',
        data: { labels: ['Faturamento', 'Líquido MP', 'Lucro'], datasets: [{ data: vals, backgroundColor: cores, borderRadius: 8, borderSkipped: false, maxBarThickness: 90 }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
          plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: cor.fundo, titleColor: cor.titulo, bodyColor: cor.texto, borderColor: cor.borda, borderWidth: 1, padding: 12, cornerRadius: 10,
              callbacks: { title: () => dias[0], label: it => ` ${it.label}: ${R$(it.parsed.y)}`, afterBody: () => [`${d0.n || 0} venda${d0.n === 1 ? '' : 's'}`] } },
          },
          scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: { color: cor.texto, font: { size: 12, weight: '600' } } },
            y: { beginAtZero: true, grid: { color: cor.grade, drawTicks: false }, border: { display: false }, ticks: { color: cor.texto, font: { size: 11 }, padding: 8, maxTicksLimit: 5, callback: kfmt } },
          },
        },
      });
      return;
    }
    window._vendasGrafico = new Chart(cv, {
      type: 'line',
      data: { labels: dias.map(rotulo), datasets: [ds('Faturamento', 'fat', cor.fat, '40'), ds('Líquido MP', 'liq', cor.liq, '2e'), ds('Lucro', 'lucro', cor.luc, '38')] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 6, right: 6 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: cor.fundo, titleColor: cor.titulo, bodyColor: cor.texto, borderColor: cor.borda, borderWidth: 1,
            padding: 12, cornerRadius: 10, boxPadding: 4, usePointStyle: true, titleFont: { weight: '700' },
            callbacks: {
              title: it => dias[it[0].dataIndex],
              label: it => ` ${it.dataset.label}: ${R$(it.parsed.y)}`,
              afterBody: it => { const d = porDia[dias[it[0].dataIndex]]; return d ? [`${d.n} venda${d.n === 1 ? '' : 's'}`] : ['Sem vendas']; },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: cor.texto, font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
          y: { beginAtZero: true, grid: { color: cor.grade, drawTicks: false }, border: { display: false }, ticks: { color: cor.texto, font: { size: 11 }, padding: 8, maxTicksLimit: 5, callback: kfmt } },
        },
      },
    });
  }

  function renderDashboard() {
    const sec = document.getElementById('sec-dashboard');
    if (!sec) return;
    const lista = pedidosFiltrados();
    const t     = calcTotais(lista);
    const nVendas = lista.length;
    const unidades = lista.reduce((s,p)=>s+p.qtd,0);
    const ticketMedio = nVendas > 0 ? t.fat/nVendas : 0;
    const liqPct = t.fat > 0 ? t.liq/t.fat*100 : 0;

    // ── Agrupar por dia para o gráfico ──
    const porDia = {};
    for (const p of lista) {
      const dia = p.data || '—';
      if (!porDia[dia]) porDia[dia] = { fat:0, liq:0, lucro:0, n:0 };
      const l = calcLucro(p);
      porDia[dia].fat   += l.receita;
      porDia[dia].liq   += l.liquido||0;
      porDia[dia].lucro += l.lucro;
      porDia[dia].n     += 1;
    }
    const dias = Object.keys(porDia).sort((a,b)=>{
      const pa=a.split('/'), pb=b.split('/');
      return new Date(pa[2],pa[1]-1,pa[0]) - new Date(pb[2],pb[1]-1,pb[0]);
    });

    // ── Top 15 produtos ── o custo vem do cadastro (tela Produtos), só exibido aqui
    const prodMap = {};
    for (const p of lista) {
      const key = produtoKey(p);
      if (!prodMap[key]) prodMap[key] = {
        nome: p.produto, imagem: p.imagem,
        sku: p.itens?.[0]?.sku || '', key,
        fat:0, liq:0, lucro:0, custo:0, qtd:0, n:0, ids:[]
      };
      const l = calcLucro(p);
      prodMap[key].fat   += l.receita;
      prodMap[key].liq   += l.liquido||0;
      prodMap[key].lucro += l.lucro;
      prodMap[key].custo += l.custo;
      prodMap[key].qtd   += p.qtd;
      prodMap[key].n     += 1;
      prodMap[key].ids.push(p.id);
    }
    const top15 = Object.values(prodMap).sort((a,b)=>b.fat-a.fat).slice(0,15);

    // ── Gráfico: todos os dias do período (dia sem venda = 0), desenhado depois do HTML ──
    setTimeout(() => desenharGraficoReceitas(porDia), 0);

    // ADS busca em segundo plano (não trava o primeiro render) — atualiza os
    // cards quando terminar, ver bloco após sec.innerHTML mais abaixo
    let totalAds = 0;

    sec.innerHTML = `
    <!-- KPI Cards — grid único de 4 colunas: financeiro + ADS + visitas/pedidos, tudo no
    mesmo padrão de card pequeno (antes eram 3 grids separados com blocos grandes) -->
    <div id="dash-kpi-grid" style="display:grid;--cols:repeat(4,1fr);gap:var(--space-3);margin-bottom:var(--space-3);">
      ${kpiCard('Faturamento',   R$(t.fat),    `${nVendas} vendas`,  'var(--blue)')}
      ${kpiCard('Líq. Marketplace', R$(t.liq!=null?t.liq:0), t.fat>0?pct(liqPct)+' do fat.':'—', 'var(--purple)')}
      ${kpiCard('✅ Lucro Bruto',    R$(t.lucro),  'Margem: '+pct(t.margem), corMargem(t.margem))}
      ${kpiCard('Margem',         pct(t.margem),'',                   corMargem(t.margem))}
      ${kpiCard('Nº de Vendas',   nVendas,      `${unidades} unidades`,'var(--green)')}
      ${kpiCard('Unidades Vend.', unidades,     '',                   'var(--green)')}
      ${kpiCard('Ticket Médio',   R$(ticketMedio),'',                 'var(--yellow)')}
      ${kpiCard('Custo Produto',  R$(t.custo),  '',                   'var(--red)')}
    </div>

    <!-- Gráfico -->
    <div class="card vg-card" style="margin-bottom:var(--space-5);">
      <div class="vg-topo">
        <div>
          <div class="vg-titulo">Resumo de Receitas</div>
          <div class="vg-sub">Por dia, sem cancelados e devoluções</div>
        </div>
        <div class="vg-legenda" id="vg-legenda"></div>
      </div>
      <div class="vg-area"><canvas id="vg-canvas" role="img" aria-label="Faturamento, líquido do marketplace e lucro por dia"></canvas></div>
    </div>

    <!-- ADS, Lucro pós-ADS e Visitas/Pedidos/Faturamento — mesmo grid de 4 colunas e
    mesmo estilo de card pequeno do bloco acima (visualmente é uma continuação dele) -->
    <div style="display:grid;--cols:repeat(4,1fr);gap:var(--space-3);margin-bottom:var(--space-5);">
      <div class="kpi-card">
        <div class="kpi-label">Investimento em ADS</div>
        <div class="kpi-value" style="color:var(--red);font-size:var(--fs-5);" id="dashboard-ads">R$ 0,00</div>
        <div class="kpi-sub" id="dashboard-ads-pct">0% do faturamento</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Lucro Depois ADS</div>
        <div class="kpi-value" style="color:var(--green);font-size:var(--fs-5);" id="dashboard-lucro-ads">R$ 0,00</div>
        <div class="kpi-sub" id="dashboard-lucro-ads-pct">Margem: 0%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Visitas Total</div>
        <div class="kpi-value" style="font-size:var(--fs-5);" id="card-visitas">—</div>
        <div class="kpi-sub"><span id="card-visitas-ml">—</span> ML · <span id="card-visitas-shopee">—</span> Shopee</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Pedidos Total</div>
        <div class="kpi-value" style="color:var(--blue-strong);font-size:var(--fs-5);" id="card-vendas">—</div>
        <div class="kpi-sub"><span id="card-vendas-ml">—</span> ML · <span id="card-vendas-shopee">—</span> Shopee</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Faturamento Total</div>
        <div class="kpi-value" style="color:var(--green);font-size:var(--fs-5);" id="card-fat">—</div>
        <div class="kpi-sub"><span id="card-fat-ml">—</span> ML · <span id="card-fat-shopee">—</span> Shopee</div>
      </div>
    </div>

    <!-- Tabela: Comparativo por Marketplace -->
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:var(--space-5);">
      <div style="padding:var(--space-4) var(--space-5);border-bottom:1px solid var(--border);">
        <div style="font-size:var(--fs-3);font-weight:700;color:var(--text-primary);">Comparativo por Marketplace</div>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:var(--fs-2);">
          <thead>
            <tr style="background:var(--bg-card-hover);">
              <th style="padding:var(--space-3) var(--space-4);text-align:left;color:var(--text-muted);font-weight:600;">PLATAFORMA</th>
              <th style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-muted);font-weight:600;">VISITAS</th>
              <th style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-muted);font-weight:600;">PEDIDOS</th>
              <th style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-muted);font-weight:600;">FATURAMENTO</th>
              <th style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-muted);font-weight:600;">TICKET MÉDIO</th>
            </tr>
          </thead>
          <tbody id="marketplace-table-body">
            <tr style="border-bottom:1px solid var(--border);">
              <td colspan="5" style="padding:var(--space-5);text-align:center;color:var(--text-muted);">Carregando...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Top 15 Produtos -->
    <div class="card" style="padding:0;overflow:hidden;">
      <div style="padding:var(--space-4) var(--space-5);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <div style="font-size:var(--fs-3);font-weight:700;color:var(--text-primary);">Top ${top15.length} Produtos</div>
        <div style="font-size:var(--fs-1);color:var(--text-muted);">Comparação de vendas nos últimos dias</div>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:var(--fs-2);">
          <thead>
            <tr style="background:var(--bg-card-hover);">
              <th style="padding:10px 16px;text-align:left;color:var(--text-muted);font-weight:600;white-space:nowrap;min-width:280px;">PRODUTO</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;white-space:nowrap;">UNID.</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;white-space:nowrap;">FATURADO</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;white-space:nowrap;">REPRESENT.</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;white-space:nowrap;border-left:1px solid var(--border);">30 DIAS</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;white-space:nowrap;">60 DIAS</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;white-space:nowrap;">90 DIAS</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;white-space:nowrap;">120 DIAS</th>
              <th style="padding:10px 12px;text-align:right;color:var(--yellow);font-weight:600;white-space:nowrap;border-left:1px solid var(--border);">CUSTO UNIT.</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;white-space:nowrap;">LÍQ. MP</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;white-space:nowrap;">LUCRO</th>
              <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;white-space:nowrap;">MARGEM</th>
            </tr>
          </thead>
          <tbody>
            ${top15.map((p,i)=>{
              const margem = p.fat>0 ? p.lucro/p.fat*100 : 0;
              const represent = t.fat>0 ? p.fat/t.fat*100 : 0;
              const custoUnit = p.qtd > 0 ? p.custo / p.qtd : 0; // custo médio por unidade, como entrou no lucro
              return `<tr style="border-bottom:1px solid var(--border);${i%2!==0?'background:var(--bg-card-hover);':''}">
                <td style="padding:10px 16px;">
                  <div style="display:flex;align-items:center;gap:var(--space-2);">
                    ${p.imagem ? `<img src="${p.imagem}" style="width:32px;height:32px;border-radius:5px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">` : `<div style="width:32px;height:32px;background:var(--border);border-radius:5px;flex-shrink:0;"></div>`}
                    <div style="min-width:0;">
                      <div style="color:var(--text-primary);font-weight:600;font-size:var(--fs-3);line-height:1.4;word-break:break-word;max-width:320px;">${p.nome}</div>
                      <div style="display:flex;gap:var(--space-2);align-items:center;margin-top:2px;flex-wrap:wrap;">
                        ${p.sku ? `<span style="background:rgba(99,102,241,0.15);color:var(--accent-light);font-size:var(--fs-1);padding:1px 6px;border-radius:4px;font-family:monospace;">SKU: ${p.sku}</span>` : ''}
                        <span style="color:var(--text-muted);font-size:var(--fs-1);">${p.n} pedido${p.n!==1?'s':''} · ${p.qtd} un.</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${p.qtd}</td>
                <td style="padding:10px 12px;text-align:right;color:var(--blue-strong);font-weight:600;">${R$(p.fat)}</td>
                <td style="padding:10px 12px;text-align:right;">
                  <span style="background:rgba(99,102,241,0.15);color:var(--accent-light);padding:2px 7px;border-radius:10px;font-size:var(--fs-1);">${pct(represent)}</span>
                </td>
                <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);border-left:1px solid var(--border);">${(() => pedidos.filter(ped => p.ids.includes(ped.id) && Math.floor((new Date() - new Date(ped.dataTs)) / (1000*60*60*24)) <= 30).length)()}</td>
                <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${(() => pedidos.filter(ped => p.ids.includes(ped.id) && Math.floor((new Date() - new Date(ped.dataTs)) / (1000*60*60*24)) <= 60).length)()}</td>
                <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${(() => pedidos.filter(ped => p.ids.includes(ped.id) && Math.floor((new Date() - new Date(ped.dataTs)) / (1000*60*60*24)) <= 90).length)()}</td>
                <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${(() => pedidos.filter(ped => p.ids.includes(ped.id) && Math.floor((new Date() - new Date(ped.dataTs)) / (1000*60*60*24)) <= 120).length)()}</td>
                <td style="padding:var(--space-2) var(--space-3);text-align:right;border-left:1px solid var(--border);">
                  ${custoUnit > 0 ? `<span style="color:var(--text-secondary);">${R$(custoUnit)}</span>`
                    : `<a href="#" onclick="event.stopPropagation();Router.navigate('produtos');return false;" title="O custo do produto é cadastrado na tela Produtos" style="font-size:var(--fs-1);color:var(--yellow);text-decoration:none;">cadastrar</a>`}
                </td>
                <td style="padding:10px 12px;text-align:right;color:var(--purple);">${p.liq>0?R$(p.liq):'—'}</td>
                <td style="padding:10px 12px;text-align:right;color:${corMargem(margem)};font-weight:600;">${R$(p.lucro)}</td>
                <td style="padding:10px 12px;text-align:right;">
                  <span style="background:color-mix(in srgb,${corMargem(margem)} 13%,transparent);color:${corMargem(margem)};padding:2px 8px;border-radius:10px;font-size:var(--fs-1);font-weight:700;">${pct(margem)}</span>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Produtos Sem Custo -->
    ${(() => {
      // Agrupa pedidos filtrados por produto (mesma chave do catálogo — itemId, com fallback pro nome)
      const lista = pedidosFiltrados();
      const grupos = {};
      for (const p of lista) {
        if (isCanceladoVendas(p)) continue;
        const key = produtoKey(p);
        if (!grupos[key]) grupos[key] = { key, nome: p.produto || '(sem nome)', ids: [], fat: 0, qtd: 0, imagem: p.imagem || '' };
        grupos[key].ids.push(p.id);
        grupos[key].fat += parseFloat(p.valor) || 0;
        grupos[key].qtd += p.qtd || 1;
      }
      // Filtra apenas os que NÃO têm custo em nenhum pedido (mesma resolução do lucro: cadastro de Produtos)
      const porId = new Map(lista.map(p => [p.id, p]));
      const semCusto = Object.values(grupos).filter(g =>
        g.ids.every(id => !(calcLucro(porId.get(id)).custo > 0))
      ).sort((a,b) => b.fat - a.fat);

      if (!semCusto.length) return `<div class="card" style="padding:var(--space-4) var(--space-5);display:flex;align-items:center;gap:10px;border:1px solid rgba(34,197,94,0.3);background:rgba(34,197,94,0.05);">
        <span style="font-size:var(--fs-5);">✅</span>
        <span style="font-size:var(--fs-3);color:var(--green);font-weight:600;">Todos os produtos têm custo preenchido!</span>
      </div>`;

      return `<div class="card" style="padding:0;overflow:hidden;">
        <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-2);">
          <div>
            <span style="font-size:var(--fs-3);font-weight:700;color:var(--yellow);">⚠️ Produtos sem custo</span>
            <span style="font-size:var(--fs-1);color:var(--text-muted);margin-left:var(--space-2);">${semCusto.length} produto${semCusto.length!==1?'s':''} · ${semCusto.reduce((s,g)=>s+g.ids.length,0)} pedidos sem custo preenchido</span>
          </div>
          <span style="font-size:var(--fs-1);color:var(--text-muted);">O custo é cadastrado na tela Produtos · <a href="#" onclick="event.stopPropagation();Router.navigate('produtos');return false;" style="color:var(--accent);">abrir Produtos →</a></span>
        </div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:var(--fs-2);">
            <thead>
              <tr style="background:var(--bg-card-hover);">
                <th style="padding:10px 16px;text-align:left;color:var(--text-muted);font-weight:600;min-width:260px;">PRODUTO</th>
                <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;">UNID.</th>
                <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;">PEDIDOS</th>
                <th style="padding:10px 12px;text-align:right;color:var(--text-muted);font-weight:600;">FATURADO</th>
                <th style="padding:10px 12px;text-align:right;color:var(--yellow);font-weight:600;border-left:1px solid var(--border);">CUSTO UNIT.</th>
              </tr>
            </thead>
            <tbody>
              ${semCusto.map((g,i) => `
              <tr style="border-bottom:1px solid var(--border);${i%2!==0?'background:var(--bg-card-hover);':''}">
                <td style="padding:10px 16px;">
                  <div style="display:flex;align-items:center;gap:var(--space-2);">
                    ${g.imagem ? `<img src="${g.imagem}" style="width:32px;height:32px;border-radius:5px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">` : `<div style="width:32px;height:32px;background:var(--border);border-radius:5px;flex-shrink:0;"></div>`}
                    <span style="color:var(--text-primary);font-weight:600;max-width:300px;word-break:break-word;">${g.nome}</span>
                  </div>
                </td>
                <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${g.qtd}</td>
                <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${g.ids.length}</td>
                <td style="padding:10px 12px;text-align:right;color:var(--blue-strong);font-weight:600;">${R$(g.fat)}</td>
                <td style="padding:var(--space-2) var(--space-3);text-align:right;border-left:1px solid var(--border);">
                  <a href="#" onclick="event.stopPropagation();Router.navigate('produtos');return false;" style="font-size:var(--fs-1);color:var(--yellow);text-decoration:none;">cadastrar em Produtos</a>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    })()}`;

    // ADS: mostra "Buscando..." e preenche quando a busca real terminar
    const adEl = sec.querySelector('#dashboard-ads');
    const adPctEl = sec.querySelector('#dashboard-ads-pct');
    const lpEl = sec.querySelector('#dashboard-lucro-ads');
    const lpPctEl = sec.querySelector('#dashboard-lucro-ads-pct');
    if (adEl) adEl.textContent = '⏳...';
    if (adPctEl) adPctEl.textContent = 'buscando...';

    const { dataFrom: adsDe, dataTo: adsAte } = _periodoParaDatas();
    const adsTok = ++_adsTok; // um clique novo no filtro descarta a soma antiga (antes ela podia chegar depois e sobrescrever)
    _buscarAdsTotalVendas(adsDe, adsAte).then(total => {
      if (adsTok !== _adsTok) return;
      totalAds = total;
      if (adEl)    adEl.textContent = R$(totalAds);
      if (adPctEl) adPctEl.textContent = `${(t.fat>0?(totalAds/t.fat)*100:0).toFixed(1)}% do faturamento`;
      if (lpEl) {
        const lucroPosAds = t.lucro - totalAds;
        lpEl.textContent = R$(lucroPosAds);
        lpEl.style.color = lucroPosAds >= 0 ? 'var(--green)' : 'var(--red)';
        if (lpPctEl) lpPctEl.textContent = `Margem: ${(t.fat>0?(lucroPosAds/t.fat)*100:0).toFixed(1).replace('.',',')}%`;
      }
    }).catch(() => {
      if (adsTok !== _adsTok) return;
      if (adEl) adEl.textContent = 'Erro';
      if (adPctEl) adPctEl.textContent = 'falha ao buscar ADS';
    });

    // Renderizar comparativo de marketplace
    renderMarketplaceComparison().catch(e => {
      console.error('Erro ao renderizar marketplace:', e);
      renderMarketplaceComparison(); // Tentar novamente sem await
    });
  }

  // Cor só nos cards que realmente carregam um sinal (lucro/margem) — o resto
  // fica neutro, sem o efeito "arco-íris" de um card colorido diferente pra cada métrica
  function kpiCard(label, val, sub, cor) {
    const semantico = /lucro|margem/i.test(label);
    const corValor = semantico ? cor : 'var(--text-primary)';
    return `<div class="kpi-card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value" style="color:${corValor};font-size:var(--fs-5);">${val}</div>
      ${sub?`<div class="kpi-sub">${sub}</div>`:''}
    </div>`;
  }

  function atualizarKpiCards() {
    const grid = document.getElementById('dash-kpi-grid');
    if (!grid) return;
    const lista = pedidosFiltrados();
    const t = calcTotais(lista);
    const nVendas = lista.length;
    const unidades = lista.reduce((s,p)=>s+p.qtd,0);
    const ticketMedio = nVendas > 0 ? t.fat/nVendas : 0;
    const liqPct = t.fat > 0 ? t.liq/t.fat*100 : 0;
    grid.innerHTML = `
      ${kpiCard('Faturamento',      R$(t.fat),                `${nVendas} vendas`,          'var(--blue)')}
      ${kpiCard('Líq. Marketplace', R$(t.liq!=null?t.liq:0), t.fat>0?pct(liqPct)+' do fat.':'—', 'var(--purple)')}
      ${kpiCard('✅ Lucro Bruto',      R$(t.lucro),              'Margem: '+pct(t.margem),      corMargem(t.margem))}
      ${kpiCard('Margem',           pct(t.margem),            '',                            corMargem(t.margem))}
      ${kpiCard('Nº de Vendas',     nVendas,                  `${unidades} unidades`,        'var(--green)')}
      ${kpiCard('Unidades Vend.',   unidades,                 '',                            'var(--green)')}
      ${kpiCard('Ticket Médio',     R$(ticketMedio),          '',                            'var(--yellow)')}
      ${kpiCard('Custo Produto',    R$(t.custo),              '',                            'var(--red)')}`;
  }

  async function renderMarketplaceComparison() {
    const lista = pedidosFiltrados();
    const ml = lista.filter(p => p.plataforma === 'Mercado Livre');
    const shopee = lista.filter(p => p.plataforma === 'Shopee');

    const mlVendas = ml.length;
    const mlFat = ml.reduce((s,p) => s + (parseFloat(p.valor)||0), 0);
    const shopeeVendas = shopee.length;
    const shopeeFat = shopee.reduce((s,p) => s + (parseFloat(p.valor)||0), 0);

    // Puxar visitas reais da API
    let mlVisitas = 0, shopeeVisitas = 0;
    try {
      // Puxar contas
      const contas = await MarketplaceAPI.listAccounts();

      // ML
      const mlConta = contas.find(c => c.tipo === 'Mercado Livre' || c.tipo === 'ML');
      if (mlConta && mlConta.user_id) {
        mlVisitas = await MarketplaceAPI.mlVisitas(mlConta.user_id, customFrom, customTo);
      }

      // Shopee
      const shopeeConta = contas.find(c => c.tipo === 'Shopee');
      if (shopeeConta && shopeeConta.shop_id) {
        const dias = Math.ceil((new Date(customTo) - new Date(customFrom)) / (1000*60*60*24));
        shopeeVisitas = await MarketplaceAPI.shopeeVisitas(shopeeConta.shop_id, dias);
      }
    } catch(e) {
      console.warn('Erro ao puxar visitas:', e.message);
      // Fallback: estimativa
      mlVisitas = mlFat > 0 ? Math.round(mlVendas / 0.03) : 0;
      shopeeVisitas = shopeeFat > 0 ? Math.round(shopeeVendas / 0.03) : 0;
    }
    const totalVisitas = mlVisitas + shopeeVisitas;
    const totalVendas = mlVendas + shopeeVendas;
    const totalFat = mlFat + shopeeFat;

    // Preencher cards grandes
    document.getElementById('card-visitas').textContent = totalVisitas.toLocaleString('pt-BR');
    document.getElementById('card-visitas-ml').textContent = mlVisitas.toLocaleString('pt-BR');
    document.getElementById('card-visitas-shopee').textContent = shopeeVisitas.toLocaleString('pt-BR');

    document.getElementById('card-vendas').textContent = totalVendas.toLocaleString('pt-BR');
    document.getElementById('card-vendas-ml').textContent = mlVendas.toLocaleString('pt-BR');
    document.getElementById('card-vendas-shopee').textContent = shopeeVendas.toLocaleString('pt-BR');

    document.getElementById('card-fat').textContent = R$(totalFat);
    document.getElementById('card-fat-ml').textContent = R$(mlFat);
    document.getElementById('card-fat-shopee').textContent = R$(shopeeFat);

    // Preencher tabela
    const tableBody = document.getElementById('marketplace-table-body');
    const mlTicket = mlVendas > 0 ? mlFat / mlVendas : 0;
    const shopeeTicket = shopeeVendas > 0 ? shopeeFat / shopeeVendas : 0;

    tableBody.innerHTML = `
      <tr style="border-bottom:1px solid var(--border);background:rgba(245,158,11,0.05);">
        <td style="padding:var(--space-3) var(--space-4);color:var(--text-primary);font-weight:500;">Mercado Livre</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-secondary);">${mlVisitas.toLocaleString('pt-BR')}</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-secondary);">${mlVendas}</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--blue);font-weight:600;">${R$(mlFat)}</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-secondary);">${R$(mlTicket)}</td>
      </tr>
      <tr style="border-bottom:1px solid var(--border);background:rgba(249,115,22,0.05);">
        <td style="padding:var(--space-3) var(--space-4);color:var(--text-primary);font-weight:500;">Shopee</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-secondary);">${shopeeVisitas.toLocaleString('pt-BR')}</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-secondary);">${shopeeVendas}</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--blue);font-weight:600;">${R$(shopeeFat)}</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-secondary);">${R$(shopeeTicket)}</td>
      </tr>
      <tr style="background:var(--bg-card-hover);">
        <td style="padding:var(--space-3) var(--space-4);color:var(--text-primary);font-weight:700;">TOTAL</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-primary);font-weight:700;">${totalVisitas.toLocaleString('pt-BR')}</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-primary);font-weight:700;">${totalVendas}</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--green);font-weight:700;">${R$(totalFat)}</td>
        <td style="padding:var(--space-3) var(--space-3);text-align:right;color:var(--text-primary);font-weight:700;">${R$(totalVendas > 0 ? totalFat / totalVendas : 0)}</td>
      </tr>
    `;
  }

  // ── KPIs (aba pedidos) ───────────────────────────────────────
  function renderKPIs() {
    const lista = pedidosFiltrados();
    const t = calcTotais(lista);
    const el = document.getElementById('vendas-kpis');
    if (!el) return;
    el.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Faturamento Bruto</div><div class="kpi-value" style="color:var(--blue);">${R$(t.fat)}</div><div class="kpi-sub">${lista.length} pedidos</div></div>
      ${t.liq!=null?`<div class="kpi-card"><div class="kpi-label">Líquido Marketplace</div><div class="kpi-value" style="color:var(--purple);">${R$(t.liq)}</div><div class="kpi-sub">${t.fat>0?pct(t.liq/t.fat*100):''} do fat.</div></div>`:''}
      <div class="kpi-card"><div class="kpi-label">Custo Produto</div><div class="kpi-value" style="color:var(--red);">${R$(t.custo)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Outros Custos</div><div class="kpi-value" style="color:var(--orange);">${R$(t.out)}</div></div>
      <div class="kpi-card"><div class="kpi-label">${lista.some(p=>p.taxasPendente) ? "Resultado parcial — taxas pendentes" : lista.some(p=>p.taxas?.estimado) ? "Lucro estimado" : "✅ Lucro Bruto"}</div><div class="kpi-value" style="color:${corMargem(t.margem)};">${R$(t.lucro)}</div><div class="kpi-sub">Margem: ${pct(t.margem)}</div></div>
    `;
  }

  // ── Render lista ─────────────────────────────────────────────
  function renderLista() {
    custos=JSON.parse(localStorage.getItem(STORAGE_CUSTOS)||'{}');
    catalogoCusto=JSON.parse(localStorage.getItem(STORAGE_CATALOGO)||'{}');
    aliquotas=JSON.parse(localStorage.getItem('glr_aliquotas')||'{}');
    produtosCusto=JSON.parse(localStorage.getItem('glr_produtos')||'[]');
    if (abaAtiva === 'dashboard') renderDashboard();
    else if (abaAtiva === 'semanal') renderComparativoSemanal();
    else if (abaAtiva === 'oportunidades') renderOportunidadesAuto();
    else renderPedidos();
  }

  // Chips de status acima da lista: contam os pedidos de cada grupo (com os filtros de plataforma/conta)
  function renderFiltroStatus() {
    const el = document.getElementById('vendas-filtro-status');
    if (!el) return;
    const base = _semSelecao ? [] : pedidos.filter(passaFiltrosConta);
    const n = { todos: base.length, valido: 0, cancelado: 0, reembolsado: 0, aberto: 0 };
    for (const p of base) n[statusPedido(p).grupo]++;
    const op = [['validos', 'Válidos (somados)', n.valido], ['cancelado', 'Cancelados', n.cancelado], ['reembolsado', 'Reembolsados/devolvidos', n.reembolsado], ['aberto', 'Em aberto', n.aberto], ['todos', 'Todos', n.todos]];
    el.innerHTML = `<span style="font-size:var(--fs-1);color:var(--text-muted);">Mostrar:</span>` + op.map(([v, r, q]) =>
      `<button type="button" class="btn btn-sm ${filtroStatus === v ? 'btn-primary' : 'btn-secondary'}" aria-pressed="${filtroStatus === v}" data-st="${v}">${r} · ${q}</button>`).join('') +
      `<span style="font-size:var(--fs-1);color:var(--text-muted);">Somas, comissão e vendômetro contam só os válidos.</span>`;
    el.querySelectorAll('button[data-st]').forEach(b => b.addEventListener('click', () => { filtroStatus = b.dataset.st; renderPedidos(); }));
  }

  function renderPedidos() {
    renderKPIs();
    renderFiltroStatus();
    const lista = pedidosDaLista();
    const cont  = document.getElementById('vendas-lista');
    if (!cont) return;

    if (!lista.length) {
      cont.innerHTML = `<div style="text-align:center;padding:48px;color:var(--text-muted);">
        ${pedidos.length ? 'Nenhum pedido para este filtro.' : '⏳ Carregando pedidos...'}
      </div>`;
      return;
    }

    // Agrupa por data
    const grupos = {};
    for (const p of lista) { const k=p.data||'—'; if(!grupos[k])grupos[k]=[]; grupos[k].push(p); }

    cont.innerHTML = Object.entries(grupos).map(([data,peds]) => {
      const validos = peds.filter(p => !isCanceladoVendas(p));
      const t = calcTotais(validos); // total do dia: só pedidos válidos
      return `
      <div style="margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-2) var(--space-4);background:var(--bg-card-hover);border-radius:8px 8px 0 0;border-bottom:1px solid var(--border);">
          <span style="font-size:var(--fs-3);font-weight:700;color:var(--text-primary);">${data}</span>
          <span style="font-size:var(--fs-1);color:var(--text-muted);">${peds.length} pedidos${validos.length !== peds.length ? ` · ${validos.length} válidos somados` : ''}</span>
          <span style="margin-left:auto;font-size:var(--fs-2);color:var(--blue);font-weight:600;">${R$(t.fat)}</span>
          ${t.liq!=null?`<span style="font-size:var(--fs-2);color:var(--purple);">Líq. ${R$(t.liq)}</span>`:''}
          <span style="font-size:var(--fs-2);font-weight:700;color:${corMargem(t.margem)};">Lucro ${R$(t.lucro)} · ${pct(t.margem)}</span>
        </div>
        <div style="display:grid;--cols:2fr 50px 105px 105px 90px 90px 90px 90px 80px;padding:6px 16px;background:var(--bg-card-hover);border-bottom:1px solid var(--border);">
          ${['ITEM','QTD','TOTAL','LÍQ. MP','CUSTO PROD.','IMPOSTO','OUTROS','LUCRO','MARGEM'].map((h,i)=>
            `<div style="font-size:var(--fs-1);color:var(--text-muted);font-weight:600;text-align:${i<=1?'left':'right'};white-space:nowrap;">${h}</div>`).join('')}
        </div>
        ${peds.map(p => renderRow(p)).join('')}
      </div>`;
    }).join('');

    // Event listeners
    cont.querySelectorAll('.btn-exp').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        expandido = expandido===btn.dataset.id ? null : btn.dataset.id;
        renderPedidos();
      });
    });
    cont.querySelectorAll('.inp-custo').forEach(inp => {
      inp.addEventListener('change', () => {
        if (!custos[inp.dataset.id]) custos[inp.dataset.id]={};
        custos[inp.dataset.id][inp.dataset.campo] = parseFloat(inp.value)||0;
        salvarCustos(); renderPedidos();
      });
      inp.addEventListener('click', e => e.stopPropagation());
    });
    cont.querySelectorAll('.row-click').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.dataset.id;
        expandido = expandido===id ? null : id;
        renderPedidos();
      });
    });
  }

  function renderRow(p) {
    const l   = calcLucro(p);
    const c   = custos[p.id]||{};
    const exp = expandido===p.id;
    const cor = platCor[p.plataforma]||'var(--text-muted)';
    const img = p.imagem
      ? `<img src="${p.imagem}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0;" onerror="this.style.display='none'">`
      : `<div style="width:44px;height:44px;background:var(--border);border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:var(--fs-5);">${p.plataforma==='Shopee'?'🟠':p.plataforma==='Amazon'?'⚫':p.plataforma==='TikTok Shop'?'🎵':p.plataforma==='Magalu'?'🔵':p.plataforma==='Shein'?'⬛':'🟡'}</div>`;

    const isCancelled = isCanceladoVendas(p); // fora das somas: cancelado, reembolsado ou em aberto
    const resultadoPendente = !isCancelled && (!l.custoCompleto || p.taxasPendente);
    const taxasAuto = p.taxas != null; // tem dados automáticos da API
    const impVeioDeAPI = taxasAuto && (p.taxas?.imposto != null) && parseFloat(p.taxas?.imposto) > 0;

    // Imposto: badge diferente se veio da API real ou da alíquota da conta
    const aliqConta = parseFloat(aliquotas[p.contaId] || 0);
    const impCell = (impVeioDeAPI || l.impPct>0 || Object.prototype.hasOwnProperty.call(aliquotas,p.contaId) || c.imposto!=null)
      ? `<div style="text-align:right;">
           <span style="font-size:var(--fs-2);color:var(--yellow);font-weight:600;">${R$(l.impVal)}</span><br>
           <span style="font-size:var(--fs-1);color:var(--text-muted);">${impVeioDeAPI ? 'retido no repasse' : l.impPct+'% '+(c.imposto!=null?'pedido':'conta')}</span>
         </div>`
      : `<div style="text-align:right;" onclick="event.stopPropagation()">
           <div style="display:flex;align-items:center;justify-content:flex-end;gap:2px;">
             <input type="number" min="0" max="100" step="0.1" placeholder="${aliqConta||'0'}" value="${c.imposto||''}" data-id="${p.id}" data-campo="imposto" class="inp-custo"
               style="width:50px;background:var(--bg-input);border:1px solid var(--border);border-radius:5px;padding:4px 6px;color:var(--text-primary);font-size:var(--fs-2);text-align:right;">
             <span style="color:var(--text-muted);font-size:var(--fs-1);">%</span>
           </div>
           ${aliqConta && !c.imposto ? `<div style="font-size:var(--fs-1);color:var(--yellow);text-align:right;">${aliqConta}% (conta)</div>` : ''}
         </div>`;

    const liqCell = l.liquido != null
      ? `<div style="text-align:right;font-size:var(--fs-3);font-weight:700;color:var(--purple);">${R$(l.liquido)}<br><span style="font-size:var(--fs-1);color:var(--text-muted);font-weight:400;" title="${p.taxas?.estimado ? 'Valor que a Shopee informa que vai pagar; confirmado quando o pedido for concluído' : ''}">${p.taxas?.estimado ? 'estimado' : 'após taxas'}</span></div>`
      : p.taxasPendente ? `<div style="text-align:right;font-size:var(--fs-1);color:var(--yellow);" title="O marketplace ainda não informou as taxas deste pedido — a sincronização busca nos próximos minutos">aguardando<br>taxa</div>`
      : `<div style="text-align:right;font-size:var(--fs-2);color:var(--text-secondary);">—</div>`;

    return `
    <div style="border-bottom:1px solid var(--border);">
      <div class="row-click" data-id="${p.id}" style="display:grid;--cols:2fr 50px 105px 105px 90px 90px 90px 90px 80px;padding:10px 16px;align-items:center;cursor:pointer;transition:background .15s;"
           onmouseover="this.style.background='var(--bg-card-hover)'" onmouseout="this.style.background=''">

        <!-- Item -->
        <div style="display:flex;align-items:center;gap:10px;min-width:0;">
          ${img}
          <div style="min-width:0;">
            <div style="font-size:var(--fs-2);font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;" title="${(p.produto||'').replace(/"/g,'&quot;')}">${p.produto||'—'}</div>
            <div style="font-size:var(--fs-1);color:var(--text-muted);margin-top:2px;display:flex;gap:6px;align-items:center;">
              <span style="color:${cor};font-weight:600;">${p.plataforma}</span>
              <span>${p.id}</span>
              ${seloStatus(p)}
              ${taxasAuto && !isCancelled ? `<span style="background:rgba(167,139,250,0.15);color:var(--purple);padding:1px 5px;border-radius:8px;font-size:var(--fs-1);">${p.taxas?.estimado ? 'taxas estimadas' : 'taxas auto'}</span>` : ''}
              ${p.taxasPendente && !isCancelled ? '<span style="background:rgba(234,179,8,0.15);color:var(--yellow);padding:1px 5px;border-radius:8px;font-size:var(--fs-1);">aguardando taxa</span>' : ''}
            </div>
          </div>
        </div>

        <!-- Qtd -->
        <div style="text-align:center;font-size:var(--fs-3);color:var(--text-secondary);">${p.qtd||1}</div>

        <!-- Total bruto -->
        <div style="text-align:right;font-size:var(--fs-3);font-weight:700;color:var(--blue);">${R$(l.receita)}</div>

        <!-- Líquido MP -->
        ${liqCell}

        <!-- Custo efetivo usado na composição do pedido -->
        <div style="text-align:right;" onclick="event.stopPropagation()">
          ${l.custoCompleto ? `<strong>${R$(l.custo)}</strong>` : `<a href="#" onclick="event.stopPropagation();Router.navigate('produtos');return false;" title="O custo do produto é cadastrado na tela Produtos" style="font-size:var(--fs-1);color:var(--yellow);text-decoration:underline dotted;">Custo pendente · cadastrar em Produtos</a>`}
        </div>

        <!-- Imposto -->
        ${impCell}

        <!-- Custo extra opcional -->
        <div style="text-align:right;" onclick="event.stopPropagation()"><details><summary style="font-size:var(--fs-1);color:var(--text-muted)">${c.outros>0?R$(c.outros):'+ Extra'}</summary>
          <input aria-label="Custo extra opcional" type="number" min="0" step="0.01" placeholder="0,00" value="${c.outros||''}" data-id="${p.id}" data-campo="outros" class="inp-custo" style="width:80px;">
        </details></div>

        <!-- Lucro -->
        <div style="text-align:right;font-size:var(--fs-3);font-weight:700;color:${corMargem(l.margem)};">${isCancelled ? '<span style="font-size:var(--fs-1);color:var(--text-muted)" title="Pedido fora das somas">Fora da soma</span>' : resultadoPendente ? '<span style="font-size:var(--fs-1);color:var(--text-muted)">'+(!l.custoCompleto?'Custo pendente':'Taxas pendentes')+'</span>' : R$(l.lucro)}</div>

        <!-- Margem -->
        <div style="text-align:right;">
          <span style="background:color-mix(in srgb,${corMargem(l.margem)} 13%,transparent);color:${corMargem(l.margem)};padding:3px 8px;border-radius:20px;font-size:var(--fs-1);font-weight:700;">${resultadoPendente||isCancelled?'—':pct(l.margem)}</span>
          <button class="btn-exp" data-id="${p.id}" style="display:none;"></button>
        </div>
      </div>

      ${exp ? renderDetalhe(p, l) : ''}
    </div>`;
  }

  // Comissão da GLR deste pedido pelo contrato do cliente (por venda/unidade, por faixa de ticket; fixo não cobra por pedido)
  function comissaoGLRDoPedido(p) {
    const mkt = p.plataforma === 'Mercado Livre' ? 'ml' : p.plataforma === 'Shopee' ? 'shopee' : String(p.plataforma || '').toLowerCase().split(' ')[0];
    const conta = p.shopId || p.meliUserId || p.contaId;
    const cid = GLR.ctx?.clienteDaConta?.(mkt, conta);
    const cli = cid && (GLR.clientes || []).find(c => String(c.id) === String(cid));
    if (!cli) return null;
    if (!GLR.contaGeraComissao(conta)) return { valor: 0, rotulo: 'Comissão GLR (conta sem comissão)' };
    const m = GLR.comissao.modelo(cli);
    if (m.modelo === 'fixo') return { valor: 0, rotulo: 'Comissão GLR (contrato fixo: não cobra por pedido)' };
    const porPed = GLR.contaPorPedido(conta), n = porPed ? 1 : (parseInt(p.qtd) || 1);
    const v = GLR.comissao.dePedido(cli, parseFloat(p.valor) || 0, n);
    return { valor: v, rotulo: m.modelo === 'venda' || m.modelo === 'misto' ? `Comissão GLR (${R$(m.valor)} × ${n} ${porPed ? 'pedido' : 'un.'}${m.modelo === 'misto' ? ' + fixo mensal' : ''})` : 'Comissão GLR (faixa de ticket)' };
  }

  function renderDetalhe(p, l) {
    const tx = p.taxas||{};
    const hasEscrow = p.taxas != null;

    const impDeEscrowDetalhe = hasEscrow && tx.imposto != null && parseFloat(tx.imposto) > 0;
    const isML = p.plataforma === 'Mercado Livre';

    // Para ML: total de taxas = total - net_received. A API não dá o breakdown exato (sale_fee é parcial).
    // Para Shopee: temos comissao + taxaServico + frete + voucher separados do escrow.
    let linhasBreakdown;
    if (hasEscrow && isML) {
      const comissaoML = l.comissao || 0;           // sale_fee da API (pode ser parcial)
      const freteML    = tx.frete   || 0;           // frete já descontado do líquido (recebimento − tarifa)
      const totalConhecido = comissaoML + freteML;
      // Se net_received existe, calcula se há outras taxas não mapeadas
      const outrasML = l.liquido != null
        ? Math.max(0, (l.receita - l.liquido) - totalConhecido)
        : 0;
      linhasBreakdown = [
        { label:'Total do Pedido',                 v: l.receita,        cor:'var(--blue)', sinal:'+' },
        freteML>0    ? { label:'Valor do Frete (pago pelo vendedor)', v: -freteML,   cor:'var(--orange)', sinal:'-' } : null,
        comissaoML>0 ? { label:'Comissão',          v: -comissaoML,      cor:'var(--red)', sinal:'-' } : null,
        outrasML>0.01? { label:'Outras taxas ML',   v: -outrasML,        cor:'var(--red)', sinal:'-' } : null,
        l.liquido!=null? { label:'Líquido do Marketplace', v: l.liquido, cor:'var(--purple)', sinal:'=', bold:true } : null,
        { label:'Custo do Produto',                 v: -l.custo,         cor:'var(--red)', sinal:'-' },
        l.impVal>0 ? { label:`Imposto (${l.impPct}%)`,    v: -l.impVal,  cor:'var(--yellow)', sinal:'-' } : null,
        l.outros>0 ? { label:'Custos Extras',       v: -l.outros,        cor:'var(--orange)', sinal:'-' } : null,
        l.extra>0  ? { label:'Linhas Extras',      v: -l.extra,         cor:'var(--purple)', sinal:'-' } : null,
        { label:'✅ Lucro do Pedido',                  v: l.lucro,          cor:corMargem(l.margem), sinal: l.lucro>=0?'+':'-', bold:true },
      ].filter(Boolean);
    } else if (hasEscrow && p.plataforma === 'Shopee') {
      // Shopee: mesma ordem do Seller Centre / Gestor Seller, fechando no valor a receber (escrow_amount)
      const n = v => parseFloat(v) || 0, d = tx.detalhes || {};
      const cupom = n(tx.cupomVendedor ?? d.voucher_from_seller);
      const afiliado = n(tx.afiliado ?? d.order_ams_commission_fee);
      const fretePago = n(tx.fretePagoComprador ?? p.freteComprador);
      const freteVendedor = Math.max(0, n(tx.frete));
      const ajuste = l.liquido != null ? (l.receita - cupom - afiliado - l.comissao - l.taxaServico - freteVendedor) - l.liquido : 0;
      linhasBreakdown = [
        { label:'Valor dos produtos',                 v: l.receita,          cor:'var(--blue)', sinal:'+' },
        fretePago>0 ? { label:'Frete pago pelo comprador',   v: fretePago,      cor:'var(--green)', sinal:'+' } : null,
        fretePago>0 || freteVendedor>0 ? { label:'Frete descontado pela Shopee', v: -(fretePago + freteVendedor), cor:'var(--orange)', sinal:'-' } : null,
        cupom>0     ? { label:'Cupom do vendedor',           v: -cupom,         cor:'var(--red)', sinal:'-' } : null,
        afiliado>0  ? { label:'Comissão de afiliado',        v: -afiliado,      cor:'var(--red)', sinal:'-' } : null,
        { label:'Comissão Shopee',                    v: -l.comissao,        cor:'var(--red)', sinal:'-' },
        { label:'Taxa de serviço',                    v: -l.taxaServico,     cor:'var(--red)', sinal:'-' },
        Math.abs(ajuste)>0.01 ? { label: ajuste>0 ? 'Outros descontos da Shopee' : 'Outros créditos da Shopee', v: -ajuste, cor: ajuste>0?'var(--red)':'var(--green)', sinal: ajuste>0?'-':'+' } : null,
        l.liquido!=null ? { label:`Líquido Shopee${tx.estimado ? ' (estimado — pedido em andamento)' : ''}`, v: l.liquido, cor:'var(--purple)', sinal:'=', bold:true } : null,
        l.impVal>0 ? { label: impDeEscrowDetalhe ? 'Imposto (API)' : `Imposto (${l.impPct}%)`, v: -l.impVal, cor:'var(--yellow)', sinal:'-' } : { label:'Imposto (sem alíquota cadastrada)', v: 0, cor:'var(--text-muted)', sinal:'-' },
        { label: l.custo>0 ? 'Custo do produto' : 'Custo do produto (não cadastrado)', v: -l.custo, cor:'var(--red)', sinal:'-' },
        l.outros>0 ? { label:'Outros custos',     v: -l.outros,          cor:'var(--orange)', sinal:'-' } : null,
        l.extra>0  ? { label:'Custos extras (linhas)', v: -l.extra,      cor:'var(--purple)', sinal:'-' } : null,
        { label:'Lucro do pedido',                    v: l.lucro,            cor:corMargem(l.margem), sinal: l.lucro>=0?'+':'-', bold:true },
      ].filter(Boolean);
    } else if (hasEscrow && p.plataforma==='TikTok Shop' && tx.componentes) {
      const nomes={platform_commission_amount:'Comissão TikTok',affiliate_commission_amount:'Comissão de afiliado',affiliate_partner_commission_amount:'Comissão de parceiro afiliado',affiliate_ads_commission_amount:'Comissão de afiliado via anúncios',fee_per_item_sold_amount:'Taxa fixa por item vendido',transaction_fee_amount:'Taxa de transação',sfp_service_fee_amount:'Programa de frete grátis',referral_fee_amount:'Taxa de indicação',cofunded_creator_bonus_amount:'Bônus de criador cofinanciado'};
      const partes=Object.entries(tx.componentes).filter(([,v])=>+v!==0).map(([k,v])=>({label:nomes[k] || 'Rubrica TikTok: '+String(k).replace(/[<>&"']/g,''),v:-v,cor:v>0?'var(--red)':'var(--green)',sinal:v>0?'-':'+'}));
      const soma=Object.values(tx.componentes).reduce((s,v)=>s+(+v || 0),0)+(+tx.naoDiscriminado || 0)+(+tx.freteVendedor || 0);
      const ajuste=l.liquido!=null ? l.receita-soma-l.liquido : 0;
      linhasBreakdown=[{label:'Valor dos Produtos',v:l.receita,cor:'var(--blue)',sinal:'+'},...partes,
        tx.naoDiscriminado ? {label:'Saldo de taxas não discriminado pela API',v:-tx.naoDiscriminado,cor:'var(--yellow)',sinal:tx.naoDiscriminado>0?'-':'+'}:null,
        tx.freteVendedor ? {label:'Frete líquido do vendedor (API)',v:-tx.freteVendedor,cor:'var(--orange)',sinal:tx.freteVendedor>0?'-':'+'}:null,
        Math.abs(ajuste)>.02 ? {label:'Outros ajustes entre produtos e repasse (API)',v:-ajuste,cor:'var(--yellow)',sinal:ajuste>0?'-':'+'}:null,
        {label:'Líquido TikTok confirmado (API)',v:l.liquido,cor:'var(--purple)',sinal:'=',bold:true},
        {label:'Custo do Produto',v:-l.custo,cor:'var(--red)',sinal:'-'},
        l.impVal ? {label:'Imposto',v:-l.impVal,cor:'var(--yellow)',sinal:'-'}:null,
        l.outros ? {label:'Outros custos',v:-l.outros,cor:'var(--orange)',sinal:'-'}:null,
        l.extra ? {label:'Custos extras',v:-l.extra,cor:'var(--purple)',sinal:'-'}:null,
        {label:'Lucro após repasse',v:l.lucro,cor:corMargem(l.margem),sinal:l.lucro>=0?'+':'-',bold:true}].filter(Boolean);
    } else if (hasEscrow) {
      // Magalu: breakdown via API direto no pedido
      const nomePlat = p.plataforma || 'Marketplace';
      linhasBreakdown = [
        { label:'Valor dos Produtos',           v: l.receita,            cor:'var(--blue)', sinal:'+' },
        l.comissao>0   ? { label:`Comissão ${nomePlat}`,        v: -l.comissao,          cor:'var(--red)', sinal:'-' } : null,
        tx.afiliado ? { label:'Comissão de afiliado', v:-tx.afiliado, cor:'var(--red)', sinal:'-' } : null,
        l.taxaServico>0? { label:'Taxa de Serviço',             v: -l.taxaServico,       cor:'var(--red)', sinal:'-' } : null,
        tx.frete>0     ? { label:'Frete (descontado)',           v: -Math.abs(tx.frete),  cor:'var(--orange)', sinal:'-' } : null,
        impDeEscrowDetalhe ? { label:'Imposto (API)',            v: -tx.imposto,          cor:'var(--yellow)', sinal:'-' } : null,
        l.liquido!=null? { label:`Líquido ${nomePlat} (API)`,     v: l.liquido,            cor:'var(--purple)', sinal:'=', bold:true } : null,
        { label:'Custo do Produto',              v: -l.custo,             cor:'var(--red)', sinal:'-' },
        !impDeEscrowDetalhe && l.impVal>0 ? { label:`Imposto (${l.impPct}%)`, v: -l.impVal, cor:'var(--yellow)', sinal:'-' } : null,
        l.outros>0 ? { label:'Outros Custos',    v: -l.outros,            cor:'var(--orange)', sinal:'-' } : null,
        l.extra>0  ? { label:'Linhas Extras',   v: -l.extra,             cor:'var(--purple)', sinal:'-' } : null,
        { label:p.taxasPendente ? 'Resultado parcial — taxas pendentes' : tx.estimado ? 'Lucro estimado — taxas médias' : '✅ Lucro Bruto',                   v: l.lucro,              cor:corMargem(l.margem), sinal: l.lucro>=0?'+':'-', bold:true },
      ].filter(Boolean);
    } else {
      linhasBreakdown = [
        ...(p.taxasPendente ? [{ label:'Taxas TikTok e afiliado: aguardando acerto', v:0, cor:'var(--yellow)', sinal:'' }] : []),
        { label:'Total do Pedido',               v: l.receita,            cor:'var(--blue)', sinal:'+' },
        { label:'Custo do Produto',              v: -l.custo,             cor:'var(--red)', sinal:'-' },
        l.impVal>0 ? { label:`Imposto (${l.impPct}%)`, v: -l.impVal,     cor:'var(--yellow)', sinal:'-' } : null,
        l.outros>0 ? { label:'Outros Custos',    v: -l.outros,            cor:'var(--orange)', sinal:'-' } : null,
        l.extra>0  ? { label:'Linhas Extras',   v: -l.extra,             cor:'var(--purple)', sinal:'-' } : null,
        { label:p.taxasPendente ? 'Resultado parcial — taxas pendentes' : tx.estimado ? 'Lucro estimado — taxas médias' : '✅ Lucro Bruto',                   v: l.lucro,              cor:corMargem(l.margem), sinal: l.lucro>=0?'+':'-', bold:true },
      ].filter(Boolean);
    }

    const glr = isCanceladoVendas(p) ? null : comissaoGLRDoPedido(p); // pedido fora da soma não gera comissão
    if (glr) {
      linhasBreakdown.push({ label: glr.rotulo, v: -glr.valor, cor:'var(--accent)', sinal:'-' });
      const final = l.lucro - glr.valor;
      linhasBreakdown.push({ label:'✅ Lucro final (após GLR)', v: final, cor: corMargem(l.receita>0 ? final/l.receita*100 : 0), sinal: final>=0?'+':'-', bold:true });
    }
    return `
    <div style="display:flex;background:var(--bg-card-hover);border-top:1px solid var(--border);">
      <!-- Info + itens -->
      <div style="flex:1;padding:var(--space-4) var(--space-5);border-right:1px solid var(--border);min-width:0;">
        <div style="font-size:var(--fs-1);color:var(--text-muted);font-weight:700;text-transform:none;margin-bottom:10px;">Detalhes do Pedido</div>
        <div style="display:flex;gap:var(--space-5);flex-wrap:wrap;margin-bottom:14px;">
          <div><div style="font-size:var(--fs-1);color:var(--text-muted);">ID</div><div style="font-size:var(--fs-2);color:var(--text-primary);">${p.id}</div></div>
          <div><div style="font-size:var(--fs-1);color:var(--text-muted);">Plataforma</div><div style="font-size:var(--fs-2);color:${platCor[p.plataforma]||'#fff'};font-weight:600;">${p.plataforma}</div></div>
          <div><div style="font-size:var(--fs-1);color:var(--text-muted);">Data</div><div style="font-size:var(--fs-2);color:var(--text-primary);">${p.data}</div></div>
          <div><div style="font-size:var(--fs-1);color:var(--text-muted);">Status</div><div style="font-size:var(--fs-2);color:var(--text-primary);">${seloStatus(p)}${!statusPedido(p).valido ? ' <span style="font-size:var(--fs-1);color:var(--text-muted);">fora das somas</span>' : ''}</div></div>
          ${tx.instalment ? `<div><div style="font-size:var(--fs-1);color:var(--text-muted);">Parcelamento</div><div style="font-size:var(--fs-2);color:var(--text-primary);">${tx.instalment}</div></div>` : ''}
        </div>
        ${p.itens && p.itens.length ? `
        <div style="font-size:var(--fs-1);color:var(--text-muted);font-weight:700;text-transform:none;margin-bottom:var(--space-2);">Itens</div>
        ${p.itens.map(it=>`
          <div style="display:flex;align-items:center;gap:var(--space-2);padding:6px 0;border-bottom:1px solid var(--border);">
            ${it.imagem?`<img src="${it.imagem}" style="width:36px;height:36px;object-fit:cover;border-radius:5px;flex-shrink:0;">` : ''}
            <div style="flex:1;font-size:var(--fs-2);color:var(--text-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${it.nome}</div>
            <div style="font-size:var(--fs-1);color:var(--text-secondary);flex-shrink:0;">x${it.qtd}</div>
            <div style="font-size:var(--fs-2);color:var(--blue);font-weight:600;flex-shrink:0;">${R$(it.preco)}</div>
          </div>`).join('')}` : ''}
      </div>
      <!-- Breakdown financeiro -->
      <div style="width:300px;flex-shrink:0;padding:var(--space-4) var(--space-5);">
        <div style="font-size:var(--fs-1);color:var(--text-muted);font-weight:700;text-transform:none;margin-bottom:10px;">
          Composição do Lucro ${hasEscrow && !tx.estimado ? '<span style="color:var(--purple);font-size:var(--fs-1);background:rgba(167,139,250,0.15);padding:1px 6px;border-radius:8px;margin-left:var(--space-1);">dados da API</span>' : ''}
        </div>
        ${linhasBreakdown.map(r=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="font-size:var(--fs-2);${r.bold?'font-weight:700;color:var(--text-primary);':'color:var(--text-secondary);'}">${r.label}</span>
            <span style="font-size:var(--fs-3);font-weight:${r.bold?'800':'600'};color:${r.cor};">
              ${r.sinal==='='?'= ':r.sinal==='+'?'+':'-'}${R$(Math.abs(r.v))}
            </span>
          </div>`).join('')}
        <div style="margin-top:10px;padding-top:10px;border-top:2px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:var(--fs-2);color:var(--text-secondary);">Margem s/ receita${glr ? ' (após GLR)' : ''}</span>
          <span style="font-size:var(--fs-5);font-weight:700;color:${corMargem(glr && l.receita>0 ? (l.lucro-glr.valor)/l.receita*100 : l.margem)};">${pct(glr && l.receita>0 ? (l.lucro-glr.valor)/l.receita*100 : l.margem)}</span>
        </div>
      </div>
    </div>`;
  }


  // ── Buscar pedidos ───────────────────────────────────────────
  // ── Base sincronizada (servidor, a cada 15 min) ───────────────────────────
  // Shopee e Mercado Livre vêm prontos da base (pedidos com taxas reais), sem
  // chamar a API pedido a pedido — a tela abre em segundos, igual ao Gestor
  // Seller. Conta só é lida da base se o histórico dela cobre o período; o resto
  // (Amazon, Magalu, conta ainda sincronizando) segue pela busca antiga, na API.
  const STORAGE_THUMBS = 'glr_vendas_thumbs'; // { itemId: url } — imagens já buscadas
  let thumbs = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_THUMBS) || '{}'); } catch (e) { return {}; } })();
  const idNaBase = c => String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.param_to_use?.amazon_account_id || c.param_to_use?.magalu_account_id || c.param_to_use?.shein_supplier_id || c.external_id);
  const diaBR = ts => new Date(ts).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  function pedidoDaBaseVendas(mkt, r, contaId) {
    const valor = parseFloat(r.valor_bruto) || 0;
    const status = r.situacao === 'devolvido' ? 'devolvido' : (r.status_original || '');
    const ts = Date.parse(r.criado_em);
    const liq = r.liquido != null ? parseFloat(r.liquido) : null;
    const brutos = Array.isArray(r.itens) ? r.itens : [];
    if (mkt !== 'shopee' && mkt !== 'ml') {
      // Amazon/TikTok/Magalu/Shein: produto pelo nome (mesma chave da busca antiga da
      // Amazon/Magalu — preserva custos salvos). Taxas: Shein traz o líquido real;
      // Magalu traz a comissão (líquido = valor − comissão); Amazon/TikTok usam o acerto financeiro quando disponível.
      const ttEstimado = mkt === 'tiktok' && !!r.taxas?.estimado;
      const tarifa = ttEstimado ? 0 : parseFloat(r.taxas?.tarifa_venda ?? r.taxas?.comissao) || 0;
      const taxas = !ttEstimado && liq != null ? { componentes:r.taxas?.componentes, naoDiscriminado:r.taxas?.nao_discriminado, freteVendedor:r.taxas?.frete_vendedor, liquido: liq, comissao: tarifa, taxaServico: parseFloat(r.taxas?.taxa_servico) || 0, imposto: 0, frete: 0, voucher: 0, afiliado: parseFloat(r.taxas?.comissao_afiliado) || 0, estimado: !!r.taxas?.estimado }
        : tarifa > 0 ? { liquido: valor - tarifa, comissao: tarifa, taxaServico: 0, imposto: 0, frete: 0, voucher: 0, estimado: !!r.taxas?.estimado } : null;
      const itens = brutos.map(i => ({ nome: i.nome || '—', qtd: parseInt(i.qtd) || 1, preco: parseFloat(i.preco) || 0, imagem: i.imagem || '', itemId:i.item_id||'', sku: i.sku || '' }));
      return { id: r.pedido_id, plataforma: { amazon: 'Amazon', tiktok: 'TikTok Shop', magalu: 'Magalu', shein: 'Shein' }[mkt] || mkt, contaId, data: diaBR(ts), dataTs: ts,
        produto: itens.length > 1 ? `${itens[0].nome} (+${itens.length - 1})` : (itens[0]?.nome || r.pedido_id), imagem: itens[0]?.imagem || '',
        qtd: itens.reduce((t, i) => t + i.qtd, 0) || 1, valor, status, itens, taxas, taxasPendente:mkt==='tiktok' && (ttEstimado || liq==null) && !tarifa, _base: true };
    }
    if (mkt === 'shopee') {
      // Shopee: chave de produto = nome (igual à busca antiga — preserva custos já salvos)
      const itens = brutos.map(i => ({ nome: i.nome || '—', qtd: parseInt(i.qtd) || 1, preco: parseFloat(i.preco) || 0, imagem: thumbs[`s:${i.item_id}`] || '', sku: i.sku || '', shopeeItemId: i.item_id }));
      // sem o valor a receber da Shopee ainda: NÃO inventa líquido = valor cheio (taxa zero) — fica pendente
      const taxas = liq != null && r.taxas ? { ...r.taxas, liquido: liq } : null;
      const taxasPendente = liq == null && r.situacao === 'valido';
      const frete = parseFloat(r.frete) || 0;
      return { id: r.pedido_id, plataforma: 'Shopee', contaId, shopId: r.conta_id, data: diaBR(ts), dataTs: ts,
        produto: itens.length > 1 ? `${itens[0].nome} (+${itens.length - 1})` : (itens[0]?.nome || r.pedido_id), imagem: itens[0]?.imagem || '',
        qtd: itens.reduce((t, i) => t + i.qtd, 0) || 1, valor, valorTotal: valor + frete, freteComprador: frete, status, itens, taxas, taxasPendente, _base: true };
    }
    const tarifa = parseFloat(r.taxas?.tarifa_venda) || 0;
    const itens = brutos.map(i => ({ nome: i.nome || '—', qtd: parseInt(i.qtd) || 1, preco: parseFloat(i.preco) || 0, imagem: thumbs[i.item_id] || '', itemId: i.item_id || '', sku: i.sku || '', saleFee: parseFloat(i.tarifa_venda) || 0 }));
    return { id: r.pedido_id, plataforma: 'Mercado Livre', contaId, meliUserId: r.conta_id, data: diaBR(ts), dataTs: ts,
      produto: itens[0]?.nome || '—', imagem: itens[0]?.imagem || '', qtd: itens.reduce((t, i) => t + i.qtd, 0), valor, status,
      paymentId: r.taxas?.payment_id || null, itens,
      // Sem recebimento ainda → líquido estimado = valor − tarifa (mesma regra da busca antiga e do Financeiro)
      taxas: { liquido: liq != null ? liq : valor - tarifa, comissao: tarifa, taxaServico: 0, imposto: 0, frete: liq != null ? (parseFloat(r.frete) || 0) : null, voucher: 0 },
      _base: true };
  }

  // Aviso na linha de status: contas da plataforma escolhida que ficaram FORA da
  // seleção de contas, ou que ainda estão carregando o histórico na base — sem
  // isso, "só 1 pedido do TikTok" parece erro quando é filtro ou carga em andamento.
  const PLAT_MKT = { 'Mercado Livre': 'ml', 'Shopee': 'shopee', 'Amazon': 'amazon', 'TikTok Shop': 'tiktok', 'Magalu': 'magalu', 'Shein': 'shein' };
  async function avisoContas(dataFrom) {
    if (!window.BaseDados) return '';
    const base = await BaseDados.carregar();
    const daPlat = c => { const m = BaseDados.mktDe(c.marketplace); return m && (filtroPlat === 'todas' || PLAT_MKT[filtroPlat] === m); };
    const todasDaPlat = contas.filter(daPlat);
    const fora = filtroContasSel.size ? todasDaPlat.filter(c => !filtroContasSel.has(c.external_id)).length : 0;
    const alvo = todasDaPlat.filter(c => !filtroContasSel.size || filtroContasSel.has(c.external_id));
    const carregando = alvo.filter(c => !BaseDados.cobre(base[BaseDados.chave(BaseDados.mktDe(c.marketplace), idNaBase(c))], dataFrom));
    const plat = filtroPlat === 'todas' ? '' : ` de ${filtroPlat}`;
    const partes = [];
    if (fora) partes.push(`<span title="Estão fora da seleção de contas (filtro 🏬)." style="cursor:pointer;text-decoration:underline dotted" onclick="window._vendasLimparContas && window._vendasLimparContas()">⚠️ ${fora} conta(s)${plat} fora da seleção — ver todas</span>`);
    if (carregando.length) partes.push(`<span title="${carregando.map(contaNome).join(', ').replace(/"/g, '&quot;')}">⏳ ${carregando.length} conta(s)${plat} ainda carregando o histórico</span>`);
    return partes.length ? ` &nbsp;<span style="font-size:var(--fs-1);color:var(--yellow);">${partes.join(' · ')}</span>` : '';
  }

  // Pedidos da base guardados por conta+período (10 min, ou até a base avisar que
  // sincronizou). Marcar/desmarcar contas no filtro só lê do Supabase as contas que
  // ainda não foram lidas; desmarcar é instantâneo. Antes cada clique relia TODAS as
  // contas marcadas, em páginas de 1000 em fila (com "todas as contas" eram ~90 mil
  // pedidos/51 MB por clique, e o clique seguinte esperava essa leitura inteira).
  const BASE_TTL_MS = 10 * 60 * 1000;
  const _baseCache = window._vdBaseCache = window._vdBaseCache || new Map(); // mkt:conta|de|até → { em, pedidos }
  const _baseEmVoo = window._vdBaseEmVoo = window._vdBaseEmVoo || new Map(); // mesma chave → Promise (duas buscas seguidas reaproveitam a mesma leitura)
  async function _lerContaDaBase(mkt, idBase, externalId, ini, fim) {
    const lista = [];
    for (let off = 0; off < 200000; off += 1000) {
      const { data, error } = await _sb.from('glr_pedidos')
        .select('conta_id,pedido_id,criado_em,status_original,situacao,valor_bruto,frete,liquido,taxas,itens')
        .eq('marketplace', mkt).eq('conta_id', idBase).gte('criado_em', ini).lt('criado_em', fim)
        .order('criado_em').order('pedido_id').range(off, off + 999);
      if (error) throw error;
      for (const r of (data || [])) lista.push(pedidoDaBaseVendas(mkt, r, externalId));
      if (!data || data.length < 1000) break;
    }
    return lista;
  }
  // ainda(conta): a conta continua pedida? (o filtro pode ter mudado no meio da leitura)
  async function carregarBaseVendas(contasAlvo, dataFrom, dataTo, { forcar = false, ainda = () => true } = {}) {
    const out = { cobertas: new Set(), pedidos: [] };
    if (!window.BaseDados || typeof _sb === 'undefined') return out;
    const base = await BaseDados.carregar();
    const ok = contasAlvo.filter(c => { const m = BaseDados.mktDe(c.marketplace); return m && BaseDados.cobre(base[BaseDados.chave(m, idNaBase(c))], dataFrom); });
    if (!ok.length) return out;
    const ini = new Date(`${dataFrom}T00:00:00-03:00`).toISOString();
    const fim = new Date(new Date(`${dataTo}T00:00:00-03:00`).getTime() + 86400000).toISOString();
    const vistas = new Set(), falta = [];
    for (const c of ok) {
      const mkt = BaseDados.mktDe(c.marketplace), idBase = idNaBase(c), k = `${mkt}:${idBase}|${dataFrom}|${dataTo}`;
      if (vistas.has(k)) { out.cobertas.add(c.external_id); continue; } // mesma loja duas vezes na lista
      vistas.add(k);
      const hit = !forcar && _baseCache.get(k);
      if (hit && Date.now() - hit.em < BASE_TTL_MS) { for (const p of hit.pedidos) out.pedidos.push(p); out.cobertas.add(c.external_id); }
      else falta.push({ c, mkt, idBase, k });
    }
    // Lê as que faltam em paralelo (6 por vez), cada conta pelo índice conta+data
    let erro = null, i = 0;
    const worker = async () => {
      while (i < falta.length && !erro) {
        const { c, mkt, idBase, k } = falta[i++];
        if (!ainda(c)) continue;
        try {
          let voo = !forcar && _baseEmVoo.get(k);
          if (!voo) {
            voo = _lerContaDaBase(mkt, idBase, c.external_id, ini, fim)
              .then(lista => { _baseCache.set(k, { em: Date.now(), pedidos: lista }); return lista; })
              .finally(() => { if (_baseEmVoo.get(k) === voo) _baseEmVoo.delete(k); });
            _baseEmVoo.set(k, voo);
          }
          const lista = await voo;
          for (const p of lista) out.pedidos.push(p);
          out.cobertas.add(c.external_id);
        } catch (e) { erro = e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, falta.length) }, worker));
    if (erro) throw erro;
    return out;
  }

  // Imagens dos produtos vindos da base: busca em segundo plano só as que faltam
  // (as mais vendidas primeiro) e guarda — na próxima abertura já aparecem na hora.
  let _buscandoImagens = false;
  async function completarImagens() {
    if (_buscandoImagens) return;
    const falta = new Map(); // chave → { mkt, conta, id, fat }
    for (const p of pedidos) {
      if (!p._base || (p.plataforma !== 'Shopee' && p.plataforma !== 'Mercado Livre')) continue; // Amazon/TikTok: imagem já vem (ou não existe) na base
      for (const i of (p.itens || [])) {
        const k = p.plataforma === 'Shopee' ? `s:${i.shopeeItemId}` : i.itemId;
        if (!k || k === 's:undefined' || thumbs[k] !== undefined) continue;
        const f = falta.get(k) || { mkt: p.plataforma, conta: p.plataforma === 'Shopee' ? p.shopId : p.meliUserId, id: p.plataforma === 'Shopee' ? i.shopeeItemId : i.itemId, fat: 0 };
        f.fat += i.preco * i.qtd; falta.set(k, f);
      }
    }
    if (!falta.size) return;
    _buscandoImagens = true;
    try {
      const lista = [...falta.entries()].sort((a, b) => b[1].fat - a[1].fat).slice(0, 200);
      const grupos = {};
      for (const [k, f] of lista) (grupos[`${f.mkt}|${f.conta}`] = grupos[`${f.mkt}|${f.conta}`] || []).push([k, f]);
      await _mapLimit(Object.entries(grupos), 4, async ([g, itens]) => {
        const [mkt, conta] = g.split('|');
        for (let i = 0; i < itens.length; i += mkt === 'Shopee' ? 50 : 20) {
          const lote = itens.slice(i, i + (mkt === 'Shopee' ? 50 : 20));
          try {
            if (mkt === 'Shopee') {
              const rd = await MarketplaceAPI.call('shopee_get_items_batch', { shopId: conta, item_id_list: lote.map(([, f]) => f.id) });
              const det = rd?.data?.response?.item_list || rd?.data?.item_list || [];
              const porId = Object.fromEntries(det.map(d => [String(d.item_id), d.image?.image_url_list?.[0] || '']));
              lote.forEach(([k, f]) => { thumbs[k] = porId[String(f.id)] || ''; });
            } else {
              const det = await _mlDetalhesItens(conta, lote.map(([, f]) => f.id));
              lote.forEach(([k, f]) => { const b = det[f.id]; thumbs[k] = (b?.secure_thumbnail || b?.thumbnail || '').replace(/^http:/, 'https:'); });
            }
          } catch (e) {}
        }
      });
      try { localStorage.setItem(STORAGE_THUMBS, JSON.stringify(thumbs)); } catch (e) {}
      for (const p of pedidos) {
        if (!p._base || (p.plataforma !== 'Shopee' && p.plataforma !== 'Mercado Livre')) continue;
        (p.itens || []).forEach(i => { const k = p.plataforma === 'Shopee' ? `s:${i.shopeeItemId}` : i.itemId; if (thumbs[k]) i.imagem = thumbs[k]; });
        p.imagem = p.itens?.[0]?.imagem || p.imagem;
      }
      renderLista();
    } finally { _buscandoImagens = false; }
  }

  async function buscarPedidos(opts = {}) {
    const statusEl = document.getElementById('vendas-status');
    const btnEl    = document.getElementById('btn-buscar');
    // Trava: não busca nada até o usuário escolher pelo menos uma conta.
    // Buscar "todas as contas" de uma vez empilha chamada em cima de chamada
    // e já causou bug de dados — melhor forçar a escolha explícita.
    // Sem conta escolhida = todas as contas que já estão na base (leitura rápida).
    // A busca pela API, conta a conta, continua exigindo escolha explícita.
    // Busca completa (API conta a conta) em andamento, ou uma nova completa pedida
    // enquanto outra leitura roda: espera e roda de novo ao terminar, com o filtro novo.
    // Leitura só da base (clique no filtro): não espera — a mais nova vale e a antiga
    // é descartada sem desenhar (o que ela já leu fica guardado e é reaproveitado).
    if (_semSelecao && opts.soBase) return; // seleção vazia: só busca quando marcar uma conta (ou Atualizar)
    if (_buscaCompleta || (_buscandoPedidos && !opts.soBase)) { _recarregarDepois = opts; return; }
    if (!opts.soBase) _semSelecao = false; // Atualizar sem conta marcada = ver todas
    const ger = ++_geracao;
    _buscandoPedidos = true;
    if (!opts.soBase) _buscaCompleta = true;
    if (btnEl)    { btnEl.disabled=true; btnEl.textContent='⏳ Buscando...'; }
    if (statusEl && !opts.silencioso) statusEl.textContent='Carregando da base...';

    try {
      if (!contas.length) {
        const r = await MarketplaceAPI.call('list_accounts');
        contas  = (r.data?.accounts||[]).filter(c => !window.GLRContasInativas?.contaInativa(_inativasLocal(), c)); // loja inativa fora das listas e somas
        renderFiltroEmpresaConta();
      }
      const { dataFrom, dataTo } = _periodoParaDatas();

      // 1º a base (Shopee/ML) — contas sem seleção = todas
      const alvoBase = filtroContasSel.size ? contas.filter(c => filtroContasSel.has(c.external_id)) : contas;
      let viaBase = { cobertas: new Set(), pedidos: [] };
      const doPeriodo = () => { const d = _periodoParaDatas(); return d.dataFrom === dataFrom && d.dataTo === dataTo; };
      try {
        viaBase = await carregarBaseVendas(alvoBase, dataFrom, dataTo, {
          forcar: !!opts.forcar,
          ainda: c => ger === _geracao || (!_semSelecao && doPeriodo() && (!filtroContasSel.size || filtroContasSel.has(c.external_id))),
        });
      }
      catch (e) { console.warn('[Vendas] base indisponível, seguindo pela API:', e.message); }
      if (ger !== _geracao) return; // o filtro mudou enquanto lia: a leitura nova é que desenha
      // Pedidos de contas fora da base (Amazon/Magalu, vindos da API/cache) são mantidos
      const deFora = pedidos.filter(p => !p._base && !viaBase.cobertas.has(p.contaId));
      pedidos = viaBase.pedidos;

      // Respeita filtro de conta/empresa selecionado — só busca na API o que está no filtro e não veio da base
      // soBase (abertura da tela / base atualizou): não dispara a API — mantém o que já havia das contas de fora
      if (opts.soBase) pedidos.push(...deFora);
      const contasParaBuscar = opts.soBase ? [] : contas.filter(c => filtroContasSel.has(c.external_id) && !viaBase.cobertas.has(c.external_id));
      if (contasParaBuscar.length) { pedidos.sort((a,b)=>b.dataTs-a.dataTs); renderLista(); } // mostra a base já, enquanto o resto vem

      _diagMostrar('contas_para_buscar', 'lista', {
        filtroContasSel: [...filtroContasSel],
        totalContasCarregadas: contas.length,
        contasParaBuscar: contasParaBuscar.map(c => ({ marketplace: c.marketplace, external_id: c.external_id, param_to_use: c.param_to_use })),
      });

      for (const conta of contasParaBuscar) {
        // ── Mercado Livre ──
        if (['meli','ml','mercadolivre'].includes(conta.marketplace)) {
          if (statusEl) statusEl.textContent='Buscando Mercado Livre...';
          const orders = await MarketplaceAPI.mlOrders(
            conta.param_to_use?.meliUserId||conta.external_id, dataFrom, dataTo
          );
          const mlPedidos = [];
          for (const o of orders) {
            // Exclui cancelados/inválidos do faturamento
            if (['cancelled','invalid'].includes((o.status||'').toLowerCase())) continue;
            const dt = new Date((o.date_created||'').replace('T',' ').replace(/\..*/,''));
            const itens = (o.order_items||[]).map(i=>({
              nome:  i.item?.title||'—', qtd: i.quantity||1,
              preco: parseFloat(i.unit_price)||0, imagem: '',
              itemId: i.item?.id||'',
              sku: i.item?.seller_sku || i.seller_sku || '',
              saleFee: parseFloat(i.sale_fee)||0,
            }));
            const totalAmount = parseFloat(o.total_amount)||0;
            const comissaoML = itens.reduce((s,i)=>s+i.saleFee, 0);
            const paymentId  = o.payments?.[0]?.id || null;
            const shippingId = o.shipping?.id || null;

            mlPedidos.push({
              id: String(o.id), plataforma:'Mercado Livre',
              contaId: conta.external_id,
              data:   isNaN(dt)?'—':dt.toLocaleDateString('pt-BR'),
              dataTs: new Date(o.date_created||0).getTime(),
              produto: itens[0]?.nome||'—', imagem: '',
              qtd: itens.reduce((s,i)=>s+i.qtd,0),
              valor: totalAmount, status: o.status||'',
              paymentId, shippingId,
              itens,
              taxas: {
                liquido:     null,  // preenchido pelo /collections
                comissao:    comissaoML,
                taxaServico: 0,
                imposto:     0,     // ML não retém → alíquota da conta
                frete:       null,  // preenchido pelo /shipments
                voucher:     0,
              },
            });
          }

          // Buscar em paralelo: thumbnails + net_received (liquido) + frete
          if (statusEl) statusEl.textContent='Buscando detalhes ML (taxas, frete, imagens)...';

          const itemIdsUnicos = [...new Set(mlPedidos.flatMap(p=>p.itens.map(i=>i.itemId)).filter(Boolean))];
          const thumbMap = {};
          const collectionsMap = {}; // paymentId → net_received_amount
          const freteMap = {};       // shippingId → list_cost

          const semShippingId = mlPedidos.filter(p=>!p.shippingId).length;
          _diagMostrar('resumo', 'contagem', {
            totalPedidosML: mlPedidos.length,
            comShippingId: mlPedidos.length - semShippingId,
            semShippingId,
          });

          // IMPORTANTE: disparar centenas/milhares de chamadas de uma vez (sem limite de
          // concorrência) faz o navegador derrubar a maioria com "Failed to fetch" — era
          // por isso que frete e, em pedidos com volume alto, até o líquido vinham vazios.
          // _mapLimit garante um número controlado de chamadas simultâneas.
          await Promise.allSettled([
            // Thumbnails por item único
            _mapLimit(itemIdsUnicos, 15, async itemId => {
              try {
                const r = await MarketplaceAPI.call('get_item', { itemId });
                const thumb = r.data?.thumbnail || r.data?.pictures?.[0]?.secure_url || '';
                if (thumb) thumbMap[itemId] = thumb;
              } catch(e) {}
            }),
            // Liquido real via /collections/{paymentId}
            _mapLimit(mlPedidos.filter(p=>p.paymentId), 15, async p => {
              try {
                const r = await MarketplaceAPI.call('raw', { method:'GET', path:`/collections/${p.paymentId}` });
                _diagMostrar('collections', p.id, r.data);
                const net = parseFloat(r.data?.net_received_amount);
                if (!isNaN(net)) collectionsMap[p.paymentId] = net;
              } catch(e) { _diagMostrar('collections', p.id, { ERRO: e.message }); }
            }),
            // Frete vendedor via get_shipment (ação própria — "raw" em /shipments/{id} não é suportado, sempre falhava)
            _mapLimit(mlPedidos.filter(p=>p.shippingId), 15, async p => {
              try {
                const r = await MarketplaceAPI.call('get_shipment', { shipment_id: p.shippingId });
                const s = r.data || {};
                _diagMostrar('shipments', p.id, s);
                const listCost = parseFloat(s.shipping_option?.list_cost);
                const baseCost = parseFloat(s.base_cost);
                freteMap[p.shippingId] = !isNaN(listCost) ? listCost : (!isNaN(baseCost) ? baseCost : 0);
              } catch(e) { _diagMostrar('shipments', p.id, { ERRO: e.message }); }
            }),
          ]);

          // Aplicar dados buscados em cada pedido
          for (const p of mlPedidos) {
            const firstItemId = p.itens[0]?.itemId;
            if (firstItemId && thumbMap[firstItemId]) {
              p.imagem = thumbMap[firstItemId];
              p.itens.forEach(i => { i.imagem = thumbMap[i.itemId] || ''; });
            }
            const freteEnvio = p.shippingId && freteMap[p.shippingId] != null ? freteMap[p.shippingId] : null;
            if (p.paymentId && collectionsMap[p.paymentId] != null) {
              // net_received_amount já vem com tarifa e frete do vendedor descontados:
              // frete = o que o ML tirou além da tarifa (mesma regra da base e do Financeiro)
              const net = collectionsMap[p.paymentId];
              p.taxas.liquido = net;
              p.taxas.frete = Math.max(0, Math.round((p.valor - net - p.taxas.comissao) * 100) / 100);
            } else if (p.taxas.comissao > 0) {
              // sem recebimento ainda: estima total − tarifa − frete do envio
              p.taxas.liquido = p.valor - p.taxas.comissao - (freteEnvio || 0);
              p.taxas.frete = freteEnvio;
            } else if (freteEnvio != null) {
              p.taxas.frete = freteEnvio;
            }
          }
          pedidos.push(...mlPedidos);
        }

        // ── Shopee ── (shopee_list_orders: intervalo exato, paginado, sem corte de 500)
        if (conta.marketplace==='shopee') {
          const shopId = conta.param_to_use?.shopId||conta.external_id;
          if (statusEl) statusEl.textContent='Shopee: listando pedidos...';
          const tsFromSh = Math.floor(new Date(`${dataFrom}T00:00:00`).getTime()/1000);
          const tsToSh   = Math.floor(new Date(`${dataTo}T23:59:59`).getTime()/1000);
          const sns = await MarketplaceAPI.shopeeListOrderSns(shopId, tsFromSh, tsToSh);

          // Detalhes (valor, data, status, itens) em lotes de 50
          if (statusEl) statusEl.textContent=`Shopee: produtos (${sns.length} pedidos)...`;
          const uniq=[];
          const detMap={};
          for (let i=0;i<sns.length;i+=50) {
            const lote=sns.slice(i,i+50).map(o=>o.sn);
            try {
              const rd=await MarketplaceAPI.call('shopee_get_order_detail',{shopId,order_sn_list:lote});
              const lista=rd.data?.response?.order_list||[];
              for (const ord of lista) {
                // Blindagem: descarta pedido fora do período pedido (create_time real) —
                // status tipo READY_TO_SHIP não é confiável no filtro de data da API
                // em contas com volume alto (confirmado com pedido real).
                if (ord.create_time && (ord.create_time < tsFromSh || ord.create_time > tsToSh)) continue;
                const itens=(ord.item_list||[]).map(it=>({
                  nome: it.item_name||'—', qtd: it.model_quantity_purchased||1,
                  preco: parseFloat(it.model_discounted_price)||0, imagem: it.image_info?.image_url||'',
                  sku: it.item_sku || it.model_sku || '',
                }));
                detMap[ord.order_sn]={ itens, imagem:itens[0]?.imagem||'', produto:itens.length>1?`${itens[0].nome} (+${itens.length-1})`:(itens[0]?.nome||'—') };
                const dt = ord.create_time?new Date(ord.create_time*1000):null;
                // Faturamento = só produtos. Frete do comprador fica separado (não soma).
                const totalPedido = parseFloat(ord.total_amount)||0;
                const subtotal    = itens.reduce((s,it)=>s+it.preco*it.qtd,0);
                uniq.push({
                  id: ord.order_sn, plataforma:'Shopee',
                  contaId: conta.external_id,
                  data:   dt?dt.toLocaleDateString('pt-BR'):'—',
                  dataTs: (ord.create_time||0)*1000,
                  produto:'…', imagem:'',
                  qtd: itens.reduce((s,it)=>s+it.qtd,0)||1,
                  valor: subtotal>0 ? subtotal : totalPedido,
                  valorTotal: totalPedido,
                  freteComprador: Math.max(0, totalPedido - subtotal),
                  status: ord.order_status||'', itens:[], taxas:{},
                });
              }
            } catch(e){ console.warn('detail batch',e); }
          }

          // Busca escrow (taxas) em lotes de 50
          // A API retorna lista na mesma ordem do input — mapeamos por índice
          if (statusEl) statusEl.textContent=`Shopee: taxas (${uniq.length} pedidos)...`;
          const escrowMap={};
          const parseEscrow = oi => {
            const n = v => parseFloat(v)||0;
            const freteVendedor = Math.max(0,
              n(oi.actual_shipping_fee) - n(oi.buyer_paid_shipping_fee) - n(oi.shopee_shipping_rebate)
            );
            return {
              liquido:     n(oi.escrow_amount),
              comissao:    n(oi.net_commission_fee ?? oi.commission_fee),
              taxaServico: n(oi.net_service_fee    ?? oi.service_fee),
              imposto:     n(oi.seller_transaction_fee) + n(oi.buyer_tax_amount) + n(oi.seller_coin_cash_back),
              frete:       freteVendedor + n(oi.shipping_seller_protection_fee_amount),
              voucher:     n(oi.voucher_from_shopee),
              rebate:      n(oi.seller_product_rebate?.amount) + n(oi.shopee_discount),
              taxaCartao:  n(oi.credit_card_promotion_fee),
              moedas:      n(oi.coins) + n(oi.shopee_coins_cash_back),
              instalment:  oi.instalment_plan||'',
            };
          };
          for (let i=0;i<uniq.length;i+=50) {
            const lote = uniq.slice(i,i+50);
            const sns  = lote.map(o=>o.id);
            try {
              const re   = await MarketplaceAPI.call('shopee_get_escrow_detail_batch',{shopId,order_sn_list:sns});
              // response é array sem order_sn — mapeia por posição
              const lista = re.data?.response || re.data?.result_list || [];
              lista.forEach((item, idx) => {
                const oi  = item.escrow_detail?.order_income || item.order_income || {};
                const sn  = sns[idx];
                if (sn) escrowMap[sn] = parseEscrow(oi);
              });
            } catch(e){
              console.warn('escrow batch falhou, tentando individual...',e);
              for (const sn of sns) {
                try {
                  const re2 = await MarketplaceAPI.call('shopee_get_escrow_detail',{shopId,order_sn:sn});
                  const oi  = re2.data?.response?.order_income||{};
                  escrowMap[sn] = parseEscrow(oi);
                } catch(e2){ console.warn('escrow individual',sn,e2); }
              }
            }
          }

          for (const o of uniq) {
            const d=detMap[o.id]||{}; const e=escrowMap[o.id];
            o.produto = d.produto||o.id;
            o.imagem  = d.imagem||'';
            o.itens   = d.itens||[];
            o.taxas   = e||null;
            pedidos.push(o);
          }
        }

        // ── Amazon ── (amazon_list_orders + amazon_get_order_items via Marketplace Connect)
        // Taxas/comissão (amazon_list_financial_events) ainda NÃO são aplicadas ao lucro —
        // a estrutura de resposta da Amazon pra isso é aninhada e ainda não foi confirmada.
        // Por enquanto pedidos entram com taxas:null (lucro = receita bruta − custo − imposto,
        // igual ao fallback já usado quando não há dados de taxa de nenhuma API).
        if (conta.marketplace === 'amazon') {
          const amazonAccountId = conta.param_to_use?.amazon_account_id || conta.external_id;
          // Diagnóstico: mostra o objeto INTEIRO da conta (como veio de list_accounts) —
          // pode ter um campo de marketplace/região escondido que describe_action não listou.
          _diagMostrar('amazon_conta_bruta', conta.external_id, conta);
          if (statusEl) statusEl.textContent = 'Amazon: listando pedidos...';
          let ordersRaw = [];
          try {
            // amazon_list_orders corta em 100 pedidos por chamada e IGNORA created_before
            // (testado ao vivo: passar created_before não muda a resposta). A única forma
            // de paginar de verdade é encadear created_after com a data do último pedido
            // da página anterior +1s — confirmado que isso avança sem pular nem repetir
            // pedidos. Páginas: até 30 chamadas (trava de segurança), para quando a página
            // vier com menos de 100 (última página) ou já passar de dataTo.
            let cursor = `${dataFrom}T00:00:00Z`;
            const limiteAteMs = new Date(`${dataTo}T23:59:59Z`).getTime();
            let paginas = 0;
            while (paginas < 30) {
              paginas++;
              const r = await MarketplaceAPI.call('amazon_list_orders', {
                amazon_account_id: amazonAccountId,
                created_after: cursor,
              });
              const d = r.data;
              // A SP-API da Amazon embrulha tudo em "payload" — confere esse formato primeiro
              const pagina = Array.isArray(d?.orders)            ? d.orders
                           : Array.isArray(d?.payload?.Orders)   ? d.payload.Orders
                           : Array.isArray(d?.Orders)             ? d.Orders
                           : Array.isArray(d)                     ? d
                           : [];
              if (!pagina.length) break;
              ordersRaw.push(...pagina);
              const ultimo = pagina[pagina.length - 1];
              const ultimaData = ultimo.purchase_date || ultimo.PurchaseDate;
              if (!ultimaData) break;
              const proximoCursor = new Date(new Date(ultimaData).getTime() + 1000);
              if (isNaN(proximoCursor) || proximoCursor.getTime() > limiteAteMs) break; // já passou do período pedido
              if (pagina.length < 100) break; // última página (veio menos que o limite)
              cursor = proximoCursor.toISOString();
            }
            // Diagnóstico sempre visível (mesmo com 0 pedidos) — mostra a resposta crua
            // inteira quando não achou nenhum pedido, pra bater o formato real de uma vez.
            _diagMostrar('amazon_orders', conta.external_id, ordersRaw.length ? { totalPaginas: paginas, totalPedidos: ordersRaw.length, primeiro: ordersRaw[0] } : { AVISO: '0 pedidos após parsing' });
          } catch(e) {
            console.warn('[Amazon] erro amazon_list_orders', e.message);
            _diagMostrar('amazon_orders', conta.external_id, { ERRO: e.message });
          }

          const limiteDe = new Date(`${dataFrom}T00:00:00`).getTime();
          const limiteAte = new Date(`${dataTo}T23:59:59`).getTime();
          const amazonPedidos = [];
          for (const o of ordersRaw) {
            const orderId = o.AmazonOrderId || o.amazon_order_id || o.order_id;
            if (!orderId) continue;
            // O wrapper do Marketplace Connect devolve um formato já achatado/simplificado
            // (status, total, purchase_date direto na raiz) — bem diferente do formato bruto
            // da SP-API (OrderStatus, OrderTotal.Amount, PurchaseDate) que o código assumia
            // antes. Confirmado ao vivo via amazon_list_orders: {amazon_order_id, status,
            // total, currency, purchase_date, fulfillment_channel}. Mantém os fallbacks
            // antigos por segurança, caso o formato varie por conta/região.
            const status = String(o.status || o.OrderStatus || o.order_status || '');
            if (['Canceled','Cancelled'].includes(status)) continue;
            const dataCriacao = o.purchase_date || o.PurchaseDate || o.created_at;
            const dt = dataCriacao ? new Date(dataCriacao) : null;
            if (dt && !isNaN(dt) && (dt.getTime() < limiteDe || dt.getTime() > limiteAte)) continue;
            const total = parseFloat(o.total ?? o.OrderTotal?.Amount ?? o.order_total?.amount ?? o.order_total) || 0;
            amazonPedidos.push({
              id: orderId, plataforma: 'Amazon', contaId: conta.external_id,
              data: (dt && !isNaN(dt)) ? dt.toLocaleDateString('pt-BR') : '—',
              dataTs: (dt && !isNaN(dt)) ? dt.getTime() : 0,
              produto: '…', imagem: '', qtd: 1,
              valor: total, status, itens: [], taxas: null,
            });
          }

          if (statusEl) statusEl.textContent = `Amazon: itens (${amazonPedidos.length} pedidos)...`;
          let diagItemFeito = false;
          let itensOk = 0, itensFalha = 0;
          const errosItens = [];
          // Concorrência baixa (3) + 1 retry: com muitos pedidos (paginação agora traz o
          // total real, não só 100) a Amazon/Tiops passou a rejeitar parte das chamadas
          // simultâneas de amazon_get_order_items — sem isso a maioria dos pedidos ficava
          // com produto "…" e sem imagem, mesmo o parsing estando certo.
          await _mapLimit(amazonPedidos, 3, async p => {
            let ri = null, tent = 0;
            while (tent < 2) {
              try {
                ri = await MarketplaceAPI.call('amazon_get_order_items', { amazon_account_id: amazonAccountId, order_id: p.id });
                break;
              } catch(e) {
                tent++;
                if (tent >= 2) { itensFalha++; errosItens.push({ id: p.id, erro: e.message }); console.warn('[Amazon] erro amazon_get_order_items', p.id, e.message); return; }
                await new Promise(res => setTimeout(res, 800));
              }
            }
            const d = ri.data;
            // Mesmo achatamento do amazon_list_orders — confirmado ao vivo:
            // {selling_partner_id, order_id, items:[{asin, seller_sku, title, quantity,
            // price, currency}], total}. Mantém os fallbacks do formato bruto por segurança.
            const itensRaw = Array.isArray(d?.items)               ? d.items
                            : Array.isArray(d?.payload?.OrderItems) ? d.payload.OrderItems
                            : Array.isArray(d?.OrderItems)          ? d.OrderItems
                            : Array.isArray(d?.order_items)         ? d.order_items
                            : Array.isArray(d)                      ? d
                            : [];
            if (!diagItemFeito) { diagItemFeito = true; _diagMostrar('amazon_order_items', p.id, itensRaw.length ? itensRaw : { AVISO: '0 itens após parsing', RESPOSTA_CRUA: d }); }
            if (itensRaw.length) itensOk++; else itensFalha++;
            const itens = itensRaw.map(it => ({
              nome:  it.title || it.Title || it.seller_sku || it.SellerSKU || '—',
              qtd:   parseInt(it.quantity ?? it.QuantityOrdered ?? it.quantity_ordered) || 1,
              preco: parseFloat(it.price ?? it.ItemPrice?.Amount ?? it.item_price?.amount) || 0,
              imagem: '', sku: it.seller_sku || it.SellerSKU || '',
            }));
            p.itens = itens;
            p.produto = itens.length > 1 ? `${itens[0]?.nome} (+${itens.length-1})` : (itens[0]?.nome || p.id);
            p.qtd = itens.reduce((s,i)=>s+i.qtd, 0) || 1;
          });
          _diagMostrar('amazon_itens_resumo', conta.external_id, { itensOk, itensFalha, totalPedidos: amazonPedidos.length, primeirosErros: errosItens.slice(0,5) });

          // Diagnóstico dos eventos financeiros (taxas/comissão) — ainda não aplicado ao
          // cálculo, só exibido pra confirmarmos o formato antes de implementar de vez.
          try {
            const rf = await MarketplaceAPI.call('amazon_list_financial_events', {
              amazon_account_id: amazonAccountId,
              posted_after: `${dataFrom}T00:00:00Z`,
              posted_before: `${dataTo}T23:59:59Z`,
            });
            _diagMostrar('amazon_financial_events', conta.external_id, rf.data);
          } catch(e) { _diagMostrar('amazon_financial_events', conta.external_id, { ERRO: e.message }); }

          pedidos.push(...amazonPedidos);
        }

        // ── Magalu ── (magalu_list_orders via Marketplace Connect)
        // Sem filtro de data confiável na API — MarketplaceAPI.magaluOrders já pagina
        // do mais recente pro mais antigo e blinda pelo período no cliente. Valores
        // vêm em centavos (normalizer:100), por isso a divisão por 100 abaixo. Ao
        // contrário da Amazon, a Magalu já devolve comissão/imposto/frete por pedido
        // direto no objeto — não precisa de chamada extra pra taxas.
        if (conta.marketplace === 'magalu') {
          const magaluAccountId = conta.param_to_use?.magalu_account_id || conta.external_id;
          if (statusEl) statusEl.textContent = 'Magalu: listando pedidos...';

          // Diagnóstico: chamada crua direta, sem passar pelo helper, pra ver
          // exatamente o formato bruto que a API devolve (o helper pode estar
          // procurando os pedidos no lugar errado do objeto de resposta).
          try {
            const rawTeste = await MarketplaceAPI.call('magalu_list_orders', { _limit: 5, _offset: 0, _sort: 'created_at:desc', magalu_account_id: magaluAccountId });
            _diagMostrar('magalu_raw_teste', conta.external_id, rawTeste);
          } catch(eRaw) {
            _diagMostrar('magalu_raw_teste', conta.external_id, { ERRO: eRaw.message });
          }

          let ordersRaw = [];
          try {
            ordersRaw = await MarketplaceAPI.magaluOrders(magaluAccountId, dataFrom, dataTo);
            _diagMostrar('magalu_orders', conta.external_id, {
              magaluAccountId, dataFrom, dataTo,
              totalRetornado: ordersRaw.length,
              primeiroPedido: ordersRaw[0] || null,
            });
          } catch(e) {
            console.warn('[Magalu] erro magalu_list_orders', e.message);
            _diagMostrar('magalu_orders', conta.external_id, { ERRO: e.message, magaluAccountId, dataFrom, dataTo });
          }

          const magaluPedidos = [];
          for (const o of ordersRaw) {
            if (['canceled','cancelled'].includes((o.status||'').toLowerCase())) continue;
            const dt = o.purchased_at ? new Date(o.purchased_at) : (o.created_at ? new Date(o.created_at) : null);
            const itens = [];
            (o.deliveries||[]).forEach(dl => {
              (dl.items||[]).forEach(it => {
                itens.push({
                  nome:   it.info?.name || '—',
                  qtd:    parseInt(it.quantity) || 1,
                  preco:  (parseFloat(it.unit_price?.value) || 0) / 100,
                  imagem: it.info?.images?.[0]?.url || '',
                  sku:    it.info?.sku || '',
                });
              });
            });
            const totalCentavos = parseFloat(o.amounts?.total) || 0;
            magaluPedidos.push({
              id: o.code || o.id, plataforma: 'Magalu', contaId: conta.external_id,
              data:   (dt && !isNaN(dt)) ? dt.toLocaleDateString('pt-BR') : '—',
              dataTs: (dt && !isNaN(dt)) ? dt.getTime() : 0,
              produto: itens.length > 1 ? `${itens[0]?.nome} (+${itens.length-1})` : (itens[0]?.nome || o.code || '—'),
              imagem: itens[0]?.imagem || '',
              qtd: itens.reduce((s,i)=>s+i.qtd, 0) || 1,
              valor: totalCentavos / 100,
              status: o.status || '',
              itens,
              taxas: {
                liquido:     null,
                comissao:    (parseFloat(o.amounts?.commission?.total) || 0) / 100,
                taxaServico: 0,
                imposto:     (parseFloat(o.amounts?.tax?.total) || 0) / 100,
                frete:       (parseFloat(o.amounts?.freight?.total) || 0) / 100,
                voucher:     (parseFloat(o.amounts?.discount?.total) || 0) / 100,
              },
            });
          }
          pedidos.push(...magaluPedidos);
        }
      }

      pedidos.sort((a,b)=>b.dataTs-a.dataTs);
      if (pedidos.length <= 3000) salvarCache(dataFrom, dataTo); // volume grande vem da base em segundos — não vale lotar o navegador
      _backfillCatalogoCusto();
      const nTaxas = pedidos.filter(p=>p.taxas!=null).length;
      const selo = viaBase.cobertas.size && !contasParaBuscar.length
        ? `<span style="font-size:var(--fs-1);background:rgba(16,185,129,0.15);color:var(--green);padding:1px 7px;border-radius:8px;">base automática · atualiza sozinha</span>`
        : `<span style="font-size:var(--fs-1);background:rgba(16,185,129,0.15);color:var(--green);padding:1px 7px;border-radius:8px;">salvo</span>`;
      // Desenha primeiro; o aviso de contas fora da seleção entra logo depois
      const status = `${pedidos.length} pedidos · ${dataFrom} a ${dataTo} · ${nTaxas} com taxas &nbsp;${selo}`;
      if (statusEl) statusEl.innerHTML = status;
      renderLista();
      completarImagens();
      avisoContas(dataFrom).catch(() => '').then(av => { if (av && ger === _geracao && statusEl?.isConnected) statusEl.innerHTML = status + av; });

    } catch(e) {
      if (statusEl) statusEl.textContent=`Erro: ${e.message}`;
    } finally {
      if (ger === _geracao) { // uma leitura descartada não mexe no estado da mais nova
        _buscandoPedidos = false; _buscaCompleta = false;
        if (btnEl){ btnEl.disabled=false; btnEl.textContent='Atualizar'; }
        if (_recarregarDepois) { const o = _recarregarDepois; _recarregarDepois = null; buscarPedidos(o); }
      }
    }
  }

  // ── Funções globais ──────────────────────────────────────────
  window.adicionarLinhaExtra = () => {
    const nome=document.getElementById('inp-linha-nome')?.value?.trim();
    const valor=document.getElementById('inp-linha-valor')?.value;
    const tipo=document.getElementById('sel-linha-tipo')?.value;
    if (!nome||!valor){ GLR.avisar('Preencha nome e valor.', 'info'); return; }
    linhasExt.push({id:Date.now().toString(),nome,valor:parseFloat(valor),tipo});
    salvarLinhas(); renderLinhasExtras(); renderPedidos();
    document.getElementById('inp-linha-nome').value='';
    document.getElementById('inp-linha-valor').value='';
  };
  window.removerLinhaExtra = id => {
    linhasExt=linhasExt.filter(l=>l.id!==id);
    salvarLinhas(); renderLinhasExtras(); renderPedidos();
  };
  window.aplicarCustoGlobal = () => {
    const imp=parseFloat(document.getElementById('inp-global-imposto')?.value)||0;
    const out=parseFloat(document.getElementById('inp-global-outros')?.value)||0;
    if (!imp&&!out){ GLR.avisar('Preencha ao menos um valor.', 'info'); return; }
    for (const p of pedidosFiltrados()) {
      if (!custos[p.id]) custos[p.id]={};
      if (imp)   custos[p.id].imposto=imp;
      if (out)   custos[p.id].outros=out;
    }
    salvarCustos(); renderPedidos();
    GLR.avisar(`Aplicado a ${pedidosFiltrados().length} pedidos!`, 'sucesso');
  };

  window.confirmarLimpezaManuais = () => {
    // Contar o que existe antes de limpar
    const nCustos   = Object.keys(JSON.parse(localStorage.getItem('glr_vendas_custos')||'{}')).length;
    const nCatalogo = Object.keys(JSON.parse(localStorage.getItem('glr_vendas_custo_catalogo')||'{}')).length;
    const nLinhas   = (JSON.parse(localStorage.getItem('glr_vendas_linhas')||'[]')).length;
    const temFin    = !!localStorage.getItem('glr_fin_manual');
    const temDre    = !!localStorage.getItem('glr_dre');
    const temProj   = (() => {
      try {
        const p = JSON.parse(localStorage.getItem('glr_projecoes')||'{}');
        return Object.values(p).some(pr => pr.plataformas?.some(pl => pl.fatBase||pl.adsBase||pl.vendasBase));
      } catch(e) { return false; }
    })();

    // Monta o modal
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:14px;padding:28px 32px;max-width:480px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
        <div style="font-size:var(--fs-5);font-weight:700;color:var(--red);margin-bottom:6px;">Limpar dados manuais</div>
        <div style="font-size:var(--fs-3);color:var(--text-muted);margin-bottom:var(--space-5);">Os seguintes dados serão removidos permanentemente:</div>
        <div style="background:var(--bg-base);border-radius:8px;padding:14px;margin-bottom:var(--space-5);font-size:var(--fs-3);display:flex;flex-direction:column;gap:var(--space-2);">
          <div style="display:flex;justify-content:space-between;"><span>Custos de produto por pedido</span><strong style="color:${nCustos?'var(--red)':'var(--text-muted)'};">${nCustos ? nCustos+' pedidos' : 'vazio'}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>Catálogo de custo por produto</span><strong style="color:${nCatalogo?'var(--red)':'var(--text-muted)'};">${nCatalogo ? nCatalogo+' produtos' : 'vazio'}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>Linhas extras de custo</span><strong style="color:${nLinhas?'var(--red)':'var(--text-muted)'};">${nLinhas ? nLinhas+' linhas' : 'vazio'}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>Dados manuais do Financeiro</span><strong style="color:${temFin?'var(--red)':'var(--text-muted)'};">${temFin?'sim':'vazio'}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>Entradas manuais do DRE</span><strong style="color:${temDre?'var(--red)':'var(--text-muted)'};">${temDre?'sim':'vazio'}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>Dados manuais da Projeção</span><strong style="color:${temProj?'var(--red)':'var(--text-muted)'};">${temProj?'sim':'vazio'}</strong></div>
        </div>
        <div style="background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:8px;padding:10px 14px;margin-bottom:var(--space-5);font-size:var(--fs-2);color:var(--green);">
          ✅ Mantidos: vínculos de contas, API key, alíquotas, apelidos, cache da API
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="btn-cancelar-limpeza" style="padding:9px 20px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card-hover);color:var(--text-primary);font-weight:600;cursor:pointer;">Cancelar</button>
          <button id="btn-confirmar-limpeza" style="padding:9px 20px;border-radius:8px;border:none;background:var(--red);color:white;font-weight:700;cursor:pointer;">Confirmar limpeza</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    document.getElementById('btn-cancelar-limpeza').onclick = () => overlay.remove();
    document.getElementById('btn-confirmar-limpeza').onclick = () => {
      // Limpar dados manuais
      localStorage.removeItem('glr_vendas_custos');
      localStorage.removeItem('glr_vendas_custo_catalogo');
      localStorage.removeItem('glr_vendas_linhas');
      localStorage.removeItem('glr_fin_manual');
      localStorage.removeItem('glr_dre');
      // Projeções: limpa só os campos manuais (fatBase, adsBase, vendasBase), mantém a estrutura
      try {
        const prj = JSON.parse(localStorage.getItem('glr_projecoes')||'{}');
        for (const k in prj) {
          if (prj[k].plataformas) {
            prj[k].plataformas = prj[k].plataformas.map(p => ({
              nome: p.nome,
              fatBase: '', adsBase: '', vendasBase: '',
              maio: '', abril: '', marco: '',
            }));
          }
        }
        localStorage.setItem('glr_projecoes', JSON.stringify(prj));
      } catch(e) {}

      // Recarregar estado local
      custos       = {};
      catalogoCusto= {};
      linhasExt = [];
      overlay.remove();

      // Feedback e re-render
      const toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--green);color:white;font-weight:700;padding:var(--space-3) var(--space-5);border-radius:10px;z-index:9999;font-size:var(--fs-3);box-shadow:0 4px 20px rgba(0,0,0,0.3);';
      toast.textContent = '✅ Dados manuais removidos com sucesso';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3500);

      renderPedidos();
      renderDashboard();
    };
  };

  function renderLinhasExtras() {
    const el=document.getElementById('linhas-extras-lista');
    if (!el) return;
    el.innerHTML=!linhasExt.length
      ? `<div style="color:var(--text-muted);font-size:var(--fs-3);padding:6px 0;">Nenhuma linha extra.</div>`
      : linhasExt.map(l=>`
        <div style="display:flex;align-items:center;gap:var(--space-2);padding:5px 0;border-bottom:1px solid var(--border);">
          <span style="flex:1;font-size:var(--fs-3);color:var(--text-primary);">${l.nome}</span>
          <span style="font-size:var(--fs-2);color:var(--text-secondary);">${l.tipo==='pct'?l.valor+'%':'R$ '+parseFloat(l.valor).toLocaleString('pt-BR',{minimumFractionDigits:2})}</span>
          <span style="font-size:var(--fs-1);color:var(--text-muted);background:var(--border);padding:1px 6px;border-radius:8px;">${l.tipo==='pct'?'% pedido':'fixo'}</span>
          <button onclick="window.removerLinhaExtra('${l.id}')" style="background:rgba(239,68,68,0.15);border:none;color:var(--red);border-radius:4px;padding:2px 7px;cursor:pointer;font-size:var(--fs-2);">✕</button>
        </div>`).join('');
  }

  // ── HTML ─────────────────────────────────────────────────────
  el.innerHTML = `<div class="page">
    <!-- Cabeçalho + Filtros -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);flex-wrap:wrap;gap:var(--space-3);">
      <div>
        <div id="vendas-status" style="font-size:var(--fs-2);color:var(--text-muted);margin-top:var(--space-1);">Carregando...</div>
      </div>
      <div id="vendas-filtros" style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;">
        <select id="sel-periodo" class="form-input" style="width:155px;">
          <option value="hoje">Hoje</option>
          <option value="ontem">Ontem</option>
          <option value="7">Últimos 7 dias</option>
          <option value="15">Últimos 15 dias</option>
          <option value="30">Últimos 30 dias</option>
          <option value="mes">Esse mês</option>
          <option value="mes-passado">Mês passado</option>
          <option value="ano">Esse ano</option>
          <option value="custom" selected>Personalizado</option>
        </select>
        <div id="custom-range" style="display:flex;align-items:center;gap:6px;">
          <input type="date" id="inp-date-from" class="form-input" value="${customFrom}" style="width:140px;padding:7px 10px;">
          <span style="color:var(--text-secondary);">até</span>
          <input type="date" id="inp-date-to" class="form-input" value="${customTo}" style="width:140px;padding:7px 10px;">
        </div>
        <div id="filtro-empresa"></div>
        <div id="filtro-conta"></div>
        <select id="sel-plat" class="form-input" style="width:150px;">
          <option value="todas">Todas plataformas</option>
          <option value="Mercado Livre">🟡 Mercado Livre</option>
          <option value="Shopee">🟠 Shopee</option>
          <option value="Amazon">⚫ Amazon</option>
          <option value="TikTok Shop">TikTok Shop</option>
          <option value="Magalu">🔵 Magalu</option>
          <option value="Shein">⬛ Shein</option>
        </select>
        <button id="btn-buscar" class="btn-primary" style="padding:var(--space-2) var(--space-4);">Atualizar</button>
      </div>
    </div>

    <!-- Abas (no portal cada aba é uma página do menu, e a barra some) -->
    <div id="vendas-abas" style="display:flex;gap:var(--space-2);margin-bottom:var(--space-5);">
      <button id="tab-dashboard" style="padding:var(--space-2) var(--space-5);border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:var(--fs-3);background:var(--accent);color:var(--text-primary);">Dashboard</button>
      <button id="tab-pedidos"   style="padding:var(--space-2) var(--space-5);border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:var(--fs-3);background:var(--bg-card-hover);color:var(--text-secondary);">Pedidos</button>
      <button id="tab-oportunidades" style="padding:var(--space-2) var(--space-5);border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:var(--fs-3);background:var(--bg-card-hover);color:var(--text-secondary);">Oportunidades</button>
      <button id="tab-semanal" style="padding:var(--space-2) var(--space-5);border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:var(--fs-3);background:var(--bg-card-hover);color:var(--text-secondary);">Curva ABC Semanal</button>
      ${window._portalConfig ? '' : '<button id="tab-funil" style="padding:var(--space-2) var(--space-5);border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:var(--fs-3);background:var(--bg-card-hover);color:var(--text-secondary);">Funil de vendas</button>'}
    </div>

    <!-- Aba Dashboard -->
    <div id="sec-dashboard">
      <div style="text-align:center;padding:48px;color:var(--text-muted);">Carregando dashboard...</div>
    </div>

    <!-- Aba Oportunidades -->
    <div id="sec-oportunidades" style="display:none;"></div>

    <!-- Aba Funil de vendas (js/pages-funil.js) -->
    <div id="sec-funil" class="vd-funil" style="display:none;"></div>
    <style>.vd-funil .fn-wrap{padding:0;max-width:none}</style>

    <!-- Aba Comparativo Semanal -->
    <div id="sec-semanal" style="display:none;"></div>

    <!-- Aba Pedidos -->
    <div id="sec-pedidos" style="display:none;">
      <div id="vendas-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:var(--space-3);margin-bottom:var(--space-5);"></div>

      <details id="vendas-config-custo" style="margin-bottom:var(--space-4);">
        <summary style="cursor:pointer;padding:10px 16px;background:var(--bg-card-hover);border-radius:8px;font-size:var(--fs-3);color:var(--text-secondary);font-weight:600;list-style:none;display:flex;align-items:center;gap:var(--space-2);">
          Configurações de Custo
          <span style="font-size:var(--fs-1);color:var(--text-muted);font-weight:400;">Linhas extras e aplicação em massa</span>
        </summary>
        <div style="display:grid;--cols:1fr 1fr;gap:var(--space-3);margin-top:10px;">
          <div class="card">
            <div class="section-title mb-10" style="font-size:var(--fs-3);">Linhas de Custo Extra (por pedido)</div>
            <div id="linhas-extras-lista" style="margin-bottom:var(--space-3);"></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end;">
              <input id="inp-linha-nome" class="form-input" placeholder="Nome (ex: Taxa ML)" style="flex:2;min-width:100px;">
              <input id="inp-linha-valor" class="form-input" type="number" min="0" step="0.01" placeholder="Valor" style="flex:1;min-width:70px;">
              <select id="sel-linha-tipo" class="form-input" style="flex:1;min-width:90px;">
                <option value="pct">% por pedido</option>
                <option value="fixo">Valor fixo</option>
              </select>
              <button onclick="adicionarLinhaExtra()" class="btn-primary" style="padding:7px 12px;">+ Add</button>
            </div>
          </div>
          <div class="card">
            <div class="section-title mb-10" style="font-size:var(--fs-3);">Aplicar em Massa</div>
            <div style="font-size:var(--fs-1);color:var(--text-muted);margin-bottom:10px;">Aplica imposto e outros custos a todos os pedidos filtrados. O custo do produto é cadastrado na tela Produtos.</div>
            <div style="display:grid;--cols:1fr 1fr;gap:var(--space-2);margin-bottom:10px;">
              <div><div style="font-size:var(--fs-1);color:var(--text-secondary);margin-bottom:3px;">Imposto (%)</div><input id="inp-global-imposto" class="form-input" type="number" min="0" max="100" step="0.1" placeholder="0" style="width:100%;box-sizing:border-box;"></div>
              <div><div style="font-size:var(--fs-1);color:var(--text-secondary);margin-bottom:3px;">Outros (R$)</div><input id="inp-global-outros" class="form-input" type="number" min="0" step="0.01" placeholder="0,00" style="width:100%;box-sizing:border-box;"></div>
            </div>
            <button onclick="aplicarCustoGlobal()" class="btn-primary" style="padding:7px 16px;">Aplicar a todos</button>
          </div>
        </div>

        <!-- Zona de limpeza -->
        <div style="margin-top:var(--space-3);padding:14px 18px;background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.2);border-radius:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
          <div>
            <div style="font-size:var(--fs-3);font-weight:700;color:var(--red);">Limpar todos os dados manuais</div>
            <div style="font-size:var(--fs-1);color:var(--text-muted);margin-top:3px;">Remove custos de produto, impostos manuais, linhas extras, armazenamento, despesas e entradas do DRE. Mantém vínculos, API key, alíquotas e cache da API.</div>
          </div>
          <button onclick="confirmarLimpezaManuais()" style="background:var(--red);color:white;border:none;border-radius:8px;padding:var(--space-2) var(--space-4);font-weight:700;font-size:var(--fs-3);cursor:pointer;white-space:nowrap;">Limpar dados manuais</button>
        </div>
      </details>

      <div id="vendas-filtro-status" role="group" aria-label="Status dos pedidos" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:var(--space-3);"></div>
      <div class="card" style="padding:0;overflow:hidden;">
        <div id="vendas-lista" style="padding:var(--space-6);text-align:center;color:var(--text-muted);">Carregando pedidos...</div>
      </div>
    </div>
  </div>
  <style>
    .vg-card{padding:20px 22px 14px;}
    .vg-topo{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap;margin-bottom:10px;}
    .vg-titulo{font-size:var(--fs-4);font-weight:700;color:var(--text-primary);}
    .vg-sub{font-size:var(--fs-2);color:var(--text-muted);margin-top:2px;}
    .vg-legenda{display:flex;gap:var(--space-4);flex-wrap:wrap;font-size:var(--fs-2);color:var(--text-secondary);}
    .vg-legenda span{display:flex;align-items:center;gap:6px;}
    .vg-legenda i{width:14px;height:3px;border-radius:2px;display:inline-block;}
    .vg-area{position:relative;height:280px;width:100%;}
    @media (max-width:640px){.vg-area{height:220px;}}
  </style>`;

  document.getElementById('sel-periodo').addEventListener('change', e => {
    filtroPeriodo=e.target.value;
    document.getElementById('custom-range').style.display=filtroPeriodo==='custom'?'flex':'none';
    // Presets têm data pronta na hora — busca já dispara, sem precisar clicar em "Atualizar".
    // Só "Personalizado" espera o usuário preencher as datas e clicar no botão.
    if (filtroPeriodo !== 'custom') buscarPedidos();
  });
  document.getElementById('sel-plat').addEventListener('change', e => { filtroPlat=e.target.value; renderLista(); });
  // Portal (sem botão Atualizar): mudar as datas já carrega
  const _datasMudaram = () => { if (window._portalConfig && customFrom && customTo && customFrom <= customTo) buscarPedidos({ soBase: true }); };
  document.getElementById('inp-date-from').addEventListener('change', e => { customFrom=e.target.value; _datasMudaram(); });
  document.getElementById('inp-date-to').addEventListener('change',   e => { customTo=e.target.value; _datasMudaram(); });
  document.getElementById('btn-buscar').addEventListener('click', () => buscarPedidos({ forcar: true })); // Atualizar = relê a base de verdade
  document.getElementById('tab-dashboard').addEventListener('click', () => setAba('dashboard'));
  document.getElementById('tab-pedidos').addEventListener('click',   () => setAba('pedidos'));
  document.getElementById('tab-oportunidades').addEventListener('click', () => setAba('oportunidades'));
  document.getElementById('tab-semanal').addEventListener('click', () => setAba('semanal'));
  document.getElementById('tab-funil')?.addEventListener('click', () => setAba('funil'));

  renderLinhasExtras();
  // Aba pedida pela rota (no portal: Dashboard, Pedidos, Curva ABC, Oportunidades como páginas)
  if (params?.aba && ['dashboard', 'pedidos', 'oportunidades', 'semanal', ...(window._portalConfig ? [] : ['funil'])].includes(params.aba)) setAba(params.aba);

  // Ao abrir a página: busca contas para popular filtros, depois usa cache de pedidos se existir
  (async () => {
    // Busca contas sempre para popular empresa/conta — independente de cache de pedidos
    try {
      const r = await MarketplaceAPI.call('list_accounts');
      contas = (r.data?.accounts || []).filter(c => !window.GLRContasInativas?.contaInativa(_inativasLocal(), c));
      // Cliente em foco (barra de cima): abre filtrada nas contas dele
      const nomeFoco = !window._portalConfig && GLR.ctx?.nome?.();
      if (nomeFoco) {
        const doCli = contas.filter(c => contaEmpresas(c).includes(nomeFoco)), ids = new Set(doCli.map(c => String(c.external_id)));
        // a seleção lembrada (cache) só fica se já for toda do cliente em foco
        const jaDele = filtroContasSel.size > 0 && [...filtroContasSel].every(id => ids.has(String(id)));
        if (doCli.length && !jaDele) { filtroEmpresas = new Set([nomeFoco]); filtroContasSel = new Set(doCli.map(c => c.external_id)); pedidos = []; window._vdSemCache = true; }
      }
      renderFiltroEmpresaConta();
    } catch(e) { console.warn('[Vendas] Falha ao carregar contas:', e.message); }

    const { dataFrom, dataTo } = _periodoParaDatas();
    const at = window._vdSemCache ? false : carregarCache(dataFrom, dataTo); // cache era de outra seleção de contas
    window._vdSemCache = false;
    const statusEl = document.getElementById('vendas-status');
    if (at) {
      // Cache é local, não chama a API — pode mostrar direto
      custos = JSON.parse(localStorage.getItem(STORAGE_CUSTOS)||'{}');
      catalogoCusto = JSON.parse(localStorage.getItem(STORAGE_CATALOGO)||'{}');
      _backfillCatalogoCusto();
      const nTaxas = pedidos.filter(p=>p.taxas!=null).length;
      if (statusEl) statusEl.innerHTML = `${pedidos.length} pedidos · ${dataFrom} a ${dataTo} · ${nTaxas} com taxas &nbsp;<span style="font-size:var(--fs-1);background:rgba(99,102,241,0.2);color:var(--accent-light);padding:1px 7px;border-radius:8px;">cache ${fmtAgo(at)}</span>`;
      renderLista();
    }
    // A base é leitura rápida (sem API pedido a pedido): já carrega ao abrir. Contas
    // fora da base (Amazon/Magalu) só são buscadas na API quando escolhidas no filtro.
    buscarPedidos({ silencioso: !!at, soBase: true });
  })();

  // Base sincronizou (a cada 15 min) → atualiza a tela sozinha, sem clique
  const _vendasAoAtualizarBase = () => {
    if (!document.getElementById('vendas-lista')) { window.removeEventListener('glr-base-atualizada', _vendasAoAtualizarBase); return; }
    semanal.chave = null; // curva semanal relê a base na próxima vez que for exibida
    _baseCache.clear(); // pedidos guardados ficaram velhos
    buscarPedidos({ silencioso: true, soBase: true });
  };
  window.addEventListener('glr-base-atualizada', _vendasAoAtualizarBase);
  if (window.BaseDados) BaseDados.iniciarTempoReal();
});

// Páginas do portal do cliente: a mesma tela Vendas aberta direto numa aba
// (Dashboard, Pedidos, Curva ABC, Oportunidades). A central continua usando #vendas.
(function () {
  const rotaVendas = Router.routes['vendas'];
  [['meu-dashboard', 'dashboard'], ['meus-pedidos', 'pedidos'], ['minha-curva-abc', 'semanal'], ['minhas-oportunidades', 'oportunidades']]
    .forEach(([rota, aba]) => Router.register(rota, (p, el) => rotaVendas({ ...(p || {}), aba }, el)));
})();



