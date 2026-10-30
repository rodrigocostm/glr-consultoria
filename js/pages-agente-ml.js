// ============================================================
// GLR Consultoria — Agente Mercado Livre (aba própria, modo COPILOTO)
// ------------------------------------------------------------
// Separado do Agente da Shopee (pages-agente.js) a pedido do analista.
// O ML não libera alteração de Product Ads por integração (401 testado em
// 14/10/2026 pelo Tiops e pelo app próprio da GLR) — então o agente analisa
// (às 07:00 ou em "Analisar agora") e SUGERE; o analista aplica no painel do
// ML e marca "Já apliquei". Regras em api/_agente-ml.js.
// Config: glr_agente_config (marketplace='ml'); sugestões e registro:
// glr_agente_log (dados.marketplace='ml'); números do mês: base automática.
// ============================================================
Router.register('agente-ml', (params, el) => {
  const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = v => v == null || !isFinite(v) ? '—' : `${(+v).toFixed(1).replace('.', ',')}%`;
  const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pad = n => String(n).padStart(2, '0');
  const hoje = new Date();
  const hojeIso = `${hoje.getFullYear()}-${pad(hoje.getMonth() + 1)}-${pad(hoje.getDate())}`;
  const mesIni = hojeIso.slice(0, 8) + '01';
  const diasMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();

  const state = {
    carregando: true, contasML: [], configs: [], logs: [], base: null,
    aberta: (() => { try { return localStorage.getItem('glr_aml_conta') || null; } catch (e) { return null; } })(),
    campanhas: {}, carregandoCamp: false, aberto: null, produtos: {}, analisando: false, editando: false, salvando: false, processando: null,
  };

  const nomeConta = c => {
    const tag = (c?.tags || []).find(t => t && typeof t === 'object' && t.name);
    return tag ? String(tag.name).replace(/\s*[-–]\s*(ml|mercado livre)\s*$/i, '').trim() : (c?.nickname || c?.external_id || '');
  };
  const idConta = c => String(c.param_to_use?.meliUserId || c.external_id);
  const cfgDe = id => state.configs.find(c => String(c.conta_id) === String(id)) || null;
  const nomeDe = id => { const c = state.contasML.find(x => idConta(x) === String(id)); return c ? nomeConta(c) : (cfgDe(id)?.cliente_nome || id); };
  const pendentes = id => state.logs.filter(l => String(l.conta_id) === String(id) && l.tipo === 'alerta' && l.resultado === 'so_alerta' && !l.dados?.promo_aprovar); // promoção pela meta fica na Caixa de decisões

  async function carregar() {
    state.carregando = true; render();
    try {
      const [contas, cfg, logs] = await Promise.all([
        MarketplaceAPI.listAccounts().catch(() => []),
        _sb.from('glr_agente_config').select('*').eq('marketplace', 'ml'),
        _sb.from('glr_agente_log').select('*').eq('dados->>marketplace', 'ml').order('criado_em', { ascending: false }).limit(800),
      ]);
      state.contasML = (contas || []).filter(c => ['meli', 'ml', 'mercadolivre'].includes(String(c.marketplace || '').toLowerCase()));
      state.configs = cfg.data || [];
      state.logs = logs.data || [];
      try { state.base = window.BaseDados ? await BaseDados.carregar() : null; } catch (e) { state.base = null; }
      if (state.aberta && !cfgDe(state.aberta) && state.aberta !== '__novo__') state.aberta = null;
      const foco = GLR.ctx?.cliente(); // cliente em foco (barra de cima) → conta ML dele
      if (foco && GLR.ctx.clienteDaConta('ml', state.aberta) !== foco) { const doCli = state.configs.find(x => GLR.ctx.clienteDaConta('ml', x.conta_id) === foco); if (doCli) state.aberta = String(doCli.conta_id); }
      if (!state.aberta && state.configs.length === 1) state.aberta = String(state.configs[0].conta_id);
    } catch (e) { console.warn('[Agente ML]', e); }
    state.carregando = false; render();
    if (state.aberta && state.aberta !== '__novo__') carregarCampanhas(state.aberta);
  }

  // Mês da conta pela base automática (faturamento sem cancelados, ADS, TACOS, projeção)
  function mesDe(id) {
    const info = state.base ? state.base[BaseDados.chave('ml', String(id))] : null;
    if (!info || !BaseDados.cobre(info, mesIni)) return null;
    const t = BaseDados.somar(info, mesIni, hojeIso);
    const b = t.faturamento + t.valor_cancelado + t.valor_devolvido;
    const temAds = BaseDados.cobreAds(info, mesIni);
    return { fat: t.faturamento, proj: t.faturamento / hoje.getDate() * diasMes, ads: temAds ? t.ads : null, tacos: temAds && t.faturamento > 0 ? t.ads / t.faturamento * 100 : null, taxaCancel: b > 0 ? (t.valor_cancelado + t.valor_devolvido) / b : 0 };
  }

  async function carregarCampanhas(id, forcar) {
    if (state.carregandoCamp || (!forcar && state.campanhas[id])) return;
    state.carregandoCamp = true; render();
    try {
      const todas = [];
      for (let offset = 0; offset < 500; offset += 50) {
        const r = await MarketplaceAPI.call('ml_ads_campaigns', { meliUserId: id, date_from: mesIni, date_to: hojeIso, limit: 50, offset, status: 'ALL' });
        const d = r.data || r;
        const res = d.results || [];
        todas.push(...res);
        if (res.length < 50 || offset + 50 >= (parseInt(d.paging?.total) || 0)) break;
      }
      state.campanhas[id] = { lista: todas, em: Date.now() };
    } catch (e) { state.campanhas[id] = { erro: e.message || String(e) }; }
    state.carregandoCamp = false; render();
  }

  // Produtos dentro da campanha (mês atual), somando as variações por família
  async function carregarProdutos(contaId, campId) {
    const k = `${contaId}:${campId}`;
    if (state.produtos[k] && !state.produtos[k].erro) return;
    state.produtos[k] = { carregando: true }; render();
    try {
      const todos = [];
      for (let offset = 0; offset < 1000; offset += 100) {
        const r = await MarketplaceAPI.call('ml_ads_items', { meliUserId: contaId, campaign_id: String(campId), date_from: mesIni, date_to: hojeIso, limit: 100, offset });
        const d = r.data || r;
        const res = d.results || [];
        todos.push(...res);
        if (res.length < 100 || offset + 100 >= (parseInt(d.paging?.total) || 0)) break;
      }
      // O ML segue listando aqui o anúncio que foi movido para outra campanha —
      // às vezes em dobro ("deleted" daqui + "idle" já com o campaign_id novo, os
      // dois com o mesmo gasto). Fica 1 registro por anúncio, gasto contado uma vez.
      const cid = String(campId), porItem = new Map();
      const daqui = a => a.campaign_id == null || String(a.campaign_id) === cid;
      const peso = a => (daqui(a) ? 2 : 0) + (a.status === 'active' ? 1 : 0);
      for (const a of todos) {
        const o = porItem.get(String(a.item_id));
        porItem.set(String(a.item_id), { a: !o || peso(a) > peso(o.a) ? a : o.a, fora: daqui(a) ? o?.fora : String(a.campaign_id) });
      }
      const fam = new Map();
      for (const { a, fora } of porItem.values()) {
        const movido = !(a.status === 'active' && daqui(a)) && fora;
        const key = String(a.family_id || a.item_id), m = a.metrics || {};
        const f = fam.get(key) || { chave: key, nome: a.family_name || a.title, itens: [], ativos: 0, movidos: {}, gasto: 0, vendas: 0, unidades: 0, cliques: 0, recomendado: false, permalink: a.permalink, thumb: a.thumbnail };
        f.itens.push({ id: a.item_id, status: movido ? 'moved' : a.status, titulo: a.title, movido_para: movido || null });
        if (movido) f.movidos[movido] = (f.movidos[movido] || 0) + 1;
        else if (a.status === 'active') f.ativos++;
        f.gasto += parseFloat(m.cost) || 0; f.vendas += parseFloat(m.total_amount) || 0;
        f.unidades += parseInt(m.units_quantity) || 0; f.cliques += parseInt(m.clicks) || 0;
        f.recomendado = f.recomendado || !!a.recommended;
        fam.set(key, f);
      }
      state.produtos[k] = { lista: [...fam.values()].sort((a, b) => b.gasto - a.gasto) };
    } catch (e) { state.produtos[k] = { erro: e.message || String(e) }; }
    render();
  }

  async function analisarAgora() {
    const id = state.aberta; if (!id) return;
    state.analisando = true; render();
    try {
      const r = await fetch(`/api/agente-cron?conta_id=${encodeURIComponent(id)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    } catch (e) { alert('Não consegui analisar agora: ' + (e.message || e)); }
    state.analisando = false;
    state.campanhas[id] = null;
    await carregar();
  }

  async function marcar(logId, resultado) {
    const l = state.logs.find(x => String(x.id) === String(logId)); if (!l) return;
    state.processando = logId; render();
    try {
      const dados = { ...(l.dados || {}), [resultado === 'executado' ? 'aplicado_em' : 'descartado_em']: new Date().toISOString() };
      const { error } = await _sb.from('glr_agente_log').update({ resultado, dados }).eq('id', l.id);
      if (error) throw error;
      l.resultado = resultado; l.dados = dados;
    } catch (e) { alert('Não consegui salvar: ' + (e.message || e)); }
    state.processando = null; render();
  }

  async function marcarGrupo(ids) {
    for (const id of String(ids).split(',').filter(Boolean)) await marcar(id, 'executado');
  }

  async function salvarConfig() {
    const v = id => document.getElementById(id)?.value?.trim();
    const contaId = state.aberta === '__novo__' ? v('aml-conta') : state.aberta;
    if (!contaId) { alert('Escolha a conta do Mercado Livre.'); return; }
    const num = id => { const x = parseFloat(String(v(id) || '').replace(',', '.')); return isNaN(x) ? null : x; };
    const row = {
      conta_id: String(contaId), marketplace: 'ml', cliente_nome: nomeDe(contaId),
      ativo: document.getElementById('aml-ativo')?.checked ?? !!cfgDe(contaId)?.ativo,
      meta_acos: num('aml-meta'), regra_pausa_acos: num('aml-forte'),
      regra_pausa_dias: parseInt(v('aml-janela'), 10) || 7, dias_maturacao_campanha: parseInt(v('aml-mat'), 10) || 7,
      orcamento_min: num('aml-omin'), orcamento_max: num('aml-omax'),
      alerta_variacao_pct: 30, janela_decisao_dias: 1, notas: v('aml-notas') || '',
      atualizado_em: new Date().toISOString(),
    };
    if (row.meta_acos == null) { alert('Defina a meta de TACOS/ACOS — é ela que guia as sugestões.'); return; }
    state.salvando = true; render();
    try {
      const { error } = await _sb.from('glr_agente_config').upsert(row, { onConflict: 'conta_id' });
      if (error) throw error;
      state.aberta = String(contaId); state.editando = false;
      try { localStorage.setItem('glr_aml_conta', state.aberta); } catch (e) {}
    } catch (e) { alert('Não consegui salvar: ' + (e.message || e)); }
    state.salvando = false;
    await carregar();
  }

  async function alternarAtivo(ligado) {
    const cfg = cfgDe(state.aberta); if (!cfg) return;
    const { error } = await _sb.from('glr_agente_config').update({ ativo: ligado, atualizado_em: new Date().toISOString() }).eq('conta_id', cfg.conta_id);
    if (error) { alert('Não consegui salvar: ' + error.message); return; }
    cfg.ativo = ligado; render();
  }

  // ── Render ──
  const corTacos = (tacos, meta) => tacos != null && meta ? (tacos <= meta ? 'var(--green)' : tacos <= meta * 1.3 ? 'var(--yellow)' : 'var(--red)') : 'var(--text-muted)';
  function kpi(rot, val, sub, cor) {
    return `<div class="aml-kpi" style="--c:${cor || 'var(--accent)'}"><div class="aml-rot">${rot}</div><div class="aml-val">${val}</div>${sub ? `<div class="aml-sub">${sub}</div>` : ''}</div>`;
  }
  function renderPortfolio() {
    return `<div class="aml-grid">
      ${state.configs.map(cfg => {
        const id = String(cfg.conta_id), m = mesDe(id), fila = pendentes(id).length;
        const cor = corTacos(m?.tacos, cfg.meta_acos);
        return `<div class="card aml-card" style="--c:${cor}" onclick="window._amlAbrir('${h(id)}')">
          <div style="font-weight:700;font-size:15px;">${h(nomeDe(id))}</div>
          <div class="aml-sub">Mercado Livre · ${cfg.ativo ? 'análise diária ligada' : 'análise diária desligada'}</div>
          <div style="display:flex;gap:18px;margin-top:12px;flex-wrap:wrap;">
            <div><div class="aml-rot">TACOS mês</div><div class="aml-val" style="font-size:18px;color:${cor};">${pct(m?.tacos)}</div></div>
            <div><div class="aml-rot">Projeção mês</div><div class="aml-val" style="font-size:18px;">${m ? R$(m.proj).replace(/,\d{2}$/, '') : '—'}</div></div>
            <div><div class="aml-rot">Sugestões</div><div class="aml-val" style="font-size:18px;color:${fila ? 'var(--yellow)' : 'inherit'};">${fila}</div></div>
          </div>
        </div>`;
      }).join('')}
      <div class="card aml-card aml-novo" onclick="window._amlAbrir('__novo__')">+ Adicionar conta do Mercado Livre</div>
    </div>`;
  }
  function renderConfig(cfg) {
    const c = cfg || {};
    const opcoes = state.contasML.filter(x => !cfgDe(idConta(x))).map(x => `<option value="${h(idConta(x))}">${h(nomeConta(x))} (${h(idConta(x))})</option>`).join('');
    const campo = (id, rot, val, dica, suf) => `<label class="aml-campo"><span>${rot}</span><div><input id="${id}" class="form-control" value="${val ?? ''}" inputmode="decimal">${suf ? `<em>${suf}</em>` : ''}</div>${dica ? `<small>${dica}</small>` : ''}</label>`;
    return `<div class="card" style="padding:18px 20px;margin-bottom:18px;">
      <div style="font-weight:700;font-size:15px;margin-bottom:4px;">Guardrails do copiloto</div>
      <div class="ajuda">As mesmas regras do agente da Shopee: TACOS do mês decide se dá pra acelerar; ACOS sem cancelados; pausar só quando gasta muito sem retorno.</div>
      ${!cfg ? `<label class="aml-campo"><span>Conta do Mercado Livre</span><div><select id="aml-conta" class="form-control"><option value="">Escolha…</option>${opcoes}</select></div></label>` : ''}
      <div class="aml-campos">
        ${campo('aml-meta', 'Meta de TACOS / ACOS', c.meta_acos, 'Em ACOS (%). Ex.: 6% equivale a ROAS 16,7x. Acima disso o agente contém; abaixo de 70% dela, acelera.', '%')}
        ${campo('aml-forte', 'Contenção forte acima de ACOS', c.regra_pausa_acos, 'Com venda, aperta 25% em vez de 15% — não pausa.', '%')}
        ${campo('aml-janela', 'Janela de análise', c.regra_pausa_dias ?? 7, 'Dias olhados para gasto, vendas e ACOS de cada campanha.', 'dias')}
        ${campo('aml-mat', 'Maturação mínima', c.dias_maturacao_campanha ?? 7, 'Campanha mais nova que isso não recebe sugestão de conter/pausar.', 'dias')}
        ${campo('aml-omin', 'Orçamento mínimo', c.orcamento_min, '', 'R$/dia')}
        ${campo('aml-omax', 'Orçamento máximo', c.orcamento_max, '', 'R$/dia')}
      </div>
      <label class="aml-campo"><span>Notas para o agente</span><div><input id="aml-notas" class="form-control" value="${h(c.notas || '')}"></div></label>
      <label style="display:flex;gap:8px;align-items:center;margin:8px 0 14px;font-size:13px;"><input type="checkbox" id="aml-ativo" ${c.ativo || !cfg ? 'checked' : ''}> Analisar sozinho todo dia às 07:00</label>
      <div style="display:flex;gap:8px;"><button class="btn btn-primary" ${state.salvando ? 'disabled' : ''} onclick="window._amlSalvar()">${state.salvando ? 'Salvando…' : 'Salvar'}</button>
      ${cfg ? '<button class="btn btn-secondary" onclick="window._amlEditar(false)">Cancelar</button>' : ''}</div>
    </div>`;
  }
  const semInstrucao = t => String(t || '').replace(/ ?Aplique no painel[\s\S]*$/, '').replace(/ ?Leitura do especialista: [\s\S]*$/, '');
  // o especialista em Mercado Ads escreve por que a recomendação entrou no pacote do dia
  const leitura = t => (String(t || '').match(/Leitura do especialista: ([\s\S]*?)(?: Aplique no painel|$)/) || [])[1] || null;
  // Sugestões em formato de "bater o olho e agir": uma linha por sugestão —
  // tipo de ação (cor), produto/campanha, O QUE FAZER e o PORQUÊ em um número;
  // explicação completa e anúncios ficam escondidos (▸ detalhes).
  const roasXg = v => v ? `${(+v).toFixed(1).replace('.', ',')}x` : '—';
  const TIPOS = {
    retirar_produto: { rot: 'Tirar produto', cor: 'var(--red)', ordem: 1 },
    pausar: { rot: 'Pausar campanha', cor: 'var(--red)', ordem: 2 },
    mover_produto: { rot: 'Mover produto', cor: 'var(--yellow)', ordem: 3 },
    roas_target: { rot: 'Ajustar ROAS', cor: 'var(--accent)', ordem: 4 },
    acos_target: { rot: 'Meta de ACOS', cor: 'var(--accent)', ordem: 4 },
    orcamento: { rot: 'Orçamento', cor: 'var(--accent)', ordem: 5 },
    adicionar_produto: { rot: 'Colocar no ADS', cor: 'var(--green)', ordem: 6 },
    informativa: { rot: 'Melhorar anúncio', cor: 'var(--purple)', ordem: 7 },
    abc_queda: { rot: 'Curva A caindo', cor: 'var(--purple)', ordem: 9 },
  };
  // Estratégia da conta escrita pelo especialista em Mercado Ads na última análise
  function quadroEspecialista(id) {
    const l = state.logs.find(x => String(x.conta_id) === String(id) && x.dados?.especialista);
    if (!l || (!l.dados.estrategia && !(l.dados.esperar || []).length)) return '';
    const quando = new Date(l.criado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<div class="aml-espq"><div class="aml-espq-t">Leitura do especialista Mercado Ads <span class="aml-sub">${quando} · ${(l.dados.escolhidas || []).length} recomendação(ões) no pacote</span></div>
      ${l.dados.estrategia ? `<div class="aml-espq-x">${h(l.dados.estrategia)}</div>` : ''}
      ${(l.dados.esperar || []).length ? `<div class="aml-espq-e"><b>Esperar:</b> ${l.dados.esperar.map(h).join(' · ')}</div>` : ''}</div>`;
  }
  function renderSugestoes(id) {
    const meta = parseFloat(cfgDe(id)?.meta_acos) || null;
    const roasMeta = meta ? 100 / meta : null;
    // "Mover produto": tirar o anúncio da campanha atual e colocar numa campanha mais
    // conservadora (ROAS objetivo maior = lance menor só para ele). Destino com ROAS
    // quase igual (menos de 20% maior) não muda nada → orienta criar campanha nova.
    const roasNovo = d => Math.max(roasMeta || 0, (+d.de || 0) * 1.25) || null;
    const destinoFraco = d => d.destino && d.de && d.para && +d.para < +d.de * 1.2;
    // Produtos que vão para campanha nova: agrupa por ROAS → UMA campanha com todos
    const novaCamp = {};
    for (const l of pendentes(id)) {
      const d = l.dados || {};
      if (d.acao !== 'mover_produto' || (d.destino && !destinoFraco(d))) continue;
      const r = roasXg(d.destino ? roasNovo(d) : d.para);
      (novaCamp[r] = novaCamp[r] || []).push(d);
    }
    const quadroNova = Object.entries(novaCamp).map(([r, ds]) => {
      const ids = [...new Set(ds.flatMap(d => d.item_ids || []))];
      return `<div class="aml-nova">
        <div><b>Campanha nova sugerida: ROAS objetivo ${r}</b> · ${ds.length} produto(s), ${ids.length} anúncio(s)</div>
        <div class="aml-sub" style="margin:2px 0 6px">Crie uma campanha só (Publicidade → Product Ads → Criar campanha, ROAS objetivo ${r}) e adicione estes anúncios. Depois pause cada um na campanha de origem indicada na lista e marque ✓ Feito.</div>
        <div class="aml-nova-ids">${ids.map(h).join(', ')}</div>
        <button class="btn btn-secondary btn-sm" style="margin-top:6px" onclick="navigator.clipboard.writeText('${ids.join(', ')}').then(()=>{this.textContent='✓ Copiado'})">Copiar anúncios</button>
      </div>`;
    }).join('');
    const todas = pendentes(id).map(l => ({ l, d: l.dados || {} })).sort((a, b) => (TIPOS[a.d.acao]?.ordem || 8) - (TIPOS[b.d.acao]?.ordem || 8));
    const filtro = state.filtroSug || 'todas';
    const lista = filtro === 'todas' ? todas : todas.filter(x => x.d.acao === filtro);
    const roasX = v => v ? `${(+v).toFixed(1).replace('.', ',')}x` : '—';
    const un = v => `${v} un.`;
    const varTxt = v => v == null ? '' : ` (${v > 0 ? '+' : ''}${v}%)`;
    const camp = d => d.campanha ? `"${h(d.campanha)}"` : 'a campanha';
    const contagem = {}; todas.forEach(x => { contagem[x.d.acao] = (contagem[x.d.acao] || 0) + 1; });
    const chips = [['todas', 'Todas', todas.length], ...Object.entries(contagem).sort((a, b) => (TIPOS[a[0]]?.ordem || 8) - (TIPOS[b[0]]?.ordem || 8)).map(([k, n]) => [k, TIPOS[k]?.rot || k, n])];
    const fazerNoMl = todas.filter(x => x.d.acao !== 'abc_queda').length;
    // Pacote do dia: agrupa por campanha (abre cada campanha uma vez no painel e faz tudo nela);
    // produtos antes da campanha; campanhas na ordem do que mais custa dinheiro
    const PASSO = { retirar_produto: 1, mover_produto: 2, adicionar_produto: 3, roas_target: 4, acos_target: 4, orcamento: 5, pausar: 6, informativa: 7 };
    const grupos = new Map();
    for (const x of lista) {
      const d = x.d, revisar = d.acao === 'abc_queda';
      const k = revisar ? '__revisar' : String((d.acao === 'adicionar_produto' ? (d.destino_id || d.campaign_id) : d.campaign_id) ?? '__sem');
      const g = grupos.get(k) || { k, nome: revisar ? 'Para revisar (estoque, preço e anúncio)' : (d.acao === 'adicionar_produto' ? (d.destino || d.campanha) : d.campanha) || 'Sem campanha', itens: [], prio: 0, economia: 0, ganho: 0 };
      g.itens.push(x); g.prio += +d.prioridade || 0;
      if (d.impacto_tipo === 'economia') g.economia += +d.impacto || 0; else if (!revisar) g.ganho += +d.impacto || 0;
      grupos.set(k, g);
    }
    const ordGrupos = [...grupos.values()].sort((a, b) => (a.k === '__revisar') - (b.k === '__revisar') || b.prio - a.prio || b.itens.length - a.itens.length);
    ordGrupos.forEach(g => g.itens.sort((a, b) => (PASSO[a.d.acao] || 9) - (PASSO[b.d.acao] || 9) || (+b.d.prioridade || 0) - (+a.d.prioridade || 0)));
    const campAtual = k => (state.campanhas[id]?.lista || []).find(c => String(c.id) === String(k));
    const estadoCamp = k => { const c = campAtual(k); if (!c) return ''; const r = parseFloat(c.roas_target) || (c.acos_target ? 100 / c.acos_target : 0); return [c.status !== 'active' ? 'pausada' : '', r ? `ROAS objetivo ${roasX(r)}` : '', c.budget ? `orçamento ${R$(c.budget)}/dia` : ''].filter(Boolean).join(' · '); };
    // ── Um passo = uma frase do que fazer, uma linha do porquê, o valor em jogo e o "como fazer" no painel ──
    const nomeP = d => `<b>${h(String(d.produto || '').slice(0, 70))}</b>`;
    const nomeC = n => `<b>${h(n || '—')}</b>`;
    const destinoTxt = d => d.destino && !destinoFraco(d) ? `a campanha ${nomeC(d.destino)} (ROAS ${roasX(d.para)})` : `uma <b>campanha nova</b> com ROAS objetivo ${roasX(d.destino ? roasNovo(d) : d.para)}`;
    const acaoTxt = d => ({
      retirar_produto: `Pausar o anúncio ${nomeP(d)}`,
      pausar: `Pausar a campanha ${nomeC(d.campanha)}`,
      mover_produto: `Mover ${nomeP(d)} para ${destinoTxt(d)}`,
      roas_target: `${+d.para > +d.de ? 'Subir' : 'Baixar'} o ROAS objetivo de ${roasX(d.de)} para <b>${roasX(d.para)}</b>`,
      acos_target: `Mudar a meta de ACOS de ${pct(d.de)} para <b>${pct(d.para)}</b>`,
      orcamento: `${+d.para > +d.de ? 'Aumentar' : 'Reduzir'} o orçamento diário de ${R$(d.de)} para <b>${R$(d.para)}</b>`,
      adicionar_produto: `Colocar ${nomeP(d)} na campanha ${nomeC(d.destino || d.campanha)}`,
      abc_queda: `Revisar ${nomeP(d)} — curva A ${d.tendencia === 'parou' ? 'parou de vender' : 'em queda'}`,
      informativa: 'Melhorar os anúncios desta campanha',
    })[d.acao] || h(d.produto || d.campanha || 'Revisar');
    const g0 = d => d.janela_dias ? ` em ${d.janela_dias} dias` : '';
    const pqTxt = d => {
      const perde = d.share ? (d.acao === 'orcamento' ? d.share.orcamento : d.share.classificacao) : null;
      switch (d.acao) {
        case 'retirar_produto': case 'pausar': return `Gastou <b>${R$(d.gasto)}</b>${g0(d)} ${d.unidades ? `e vendeu só ${un(d.unidades)} pelo ADS` : d.vendas_sem_cancelados ? `e vendeu só ${R$(d.vendas_sem_cancelados)}` : 'e <b>não vendeu nada</b> pelo ADS'}.`;
        case 'mover_produto': return `ACOS de <b>${pct(d.acos)}</b>${meta ? ` com meta de ${pct(meta)}` : ''} — é ele que encarece a campanha (gastou ${R$(d.gasto)}${g0(d)}). Vende, então muda de campanha em vez de pausar.`;
        case 'roas_target': return +d.para > +d.de ? `ACOS da campanha em <b>${pct(d.acos)}</b>${meta ? `, acima da meta de ${pct(meta)}` : ''}: lance mais conservador.` : `ACOS de <b>${pct(d.acos)}</b> com folga${perde != null ? ` e a campanha perde <b>${Math.round(perde * 100)}%</b> das impressões por classificação` : ''}: lance mais forte para ganhar leilão.`;
        case 'orcamento': return +d.para > +d.de ? `ACOS de <b>${pct(d.acos)}</b> dentro da meta${perde != null ? ` e perde <b>${Math.round(perde * 100)}%</b> das impressões por falta de orçamento` : ' e o orçamento acaba antes do fim do dia'}.` : `ACOS de <b>${pct(d.acos)}</b>${meta ? ` acima da meta de ${pct(meta)}` : ''}: gastar menos por dia.`;
        case 'adicionar_produto': return d.unidades_loja_30d ? `Vendeu <b>${un(d.unidades_loja_30d)}</b> no mês sem estar no ADS.` : `Subindo: ${un(d.unidades_ultima)} na última semana${varTxt(d.variacao_pct)}.`;
        case 'abc_queda': return `<b>${un(d.unidades_ultima)}</b> na última semana contra média de ${String(d.media_3_semanas ?? '—').replace('.', ',')} nas 3 anteriores <b style="color:var(--red)">${varTxt(d.variacao_pct).trim()}</b>.`;
        case 'informativa': return `Perde <b>${Math.round((perde || 0) * 100)}%</b> das impressões por classificação e o ACOS (${pct(d.acos)}) já está perto do limite da margem${d.limite_acos ? ` (${pct(d.limite_acos)})` : ''}: baixar o ROAS não cabe — o caminho é o anúncio.`;
      }
      return '';
    };
    const idsHtml = ids => `<span class="aml-ids">${ids.map(x => `<a href="https://produto.mercadolivre.com.br/${h(String(x).replace(/^MLB/, 'MLB-'))}" target="_blank" rel="noopener">${h(x)}</a>`).join(' ')}</span><button class="aml-cop" onclick="navigator.clipboard.writeText('${ids.map(h).join(', ')}').then(()=>{this.textContent='Copiado'})">Copiar códigos</button>`;
    const passosPainel = d => {
      const ids = d.item_ids || [], abrir = n => `Em <b>Publicidade → Product Ads</b>, abra a campanha ${nomeC(n)}`;
      switch (d.acao) {
        case 'retirar_produto': return [abrir(d.campanha), `Na lista de anúncios, pause: ${idsHtml(ids)}`];
        case 'mover_produto': return [abrir(d.campanha), `Pause os anúncios: ${idsHtml(ids)}`, d.destino && !destinoFraco(d) ? `Abra a campanha ${nomeC(d.destino)} → <b>Adicionar anúncios</b> → cole os mesmos códigos` : 'Coloque os anúncios na campanha nova (quadro acima — uma só para todos os produtos)'];
        case 'roas_target': return [abrir(d.campanha), `Clique em <b>Editar</b> e mude o ROAS objetivo para <b>${roasX(d.para)}</b>`];
        case 'acos_target': return [abrir(d.campanha), `Clique em <b>Editar</b> e mude a meta de ACOS para <b>${pct(d.para)}</b>`];
        case 'orcamento': return [abrir(d.campanha), `Clique em <b>Editar</b> e mude o orçamento diário para <b>${R$(d.para)}</b>`];
        case 'pausar': return [abrir(d.campanha), 'Clique em <b>Pausar campanha</b>'];
        case 'adicionar_produto': return [abrir(d.destino || d.campanha), `<b>Adicionar anúncios</b> → ${idsHtml(ids)}`, 'Confira o estoque antes'];
      }
      return null;
    };
    const R0 = v => R$(v).replace(/,\d{2}$/, '');
    const impHtml = d => !d.impacto ? '' : `<div class="aml-p-imp ${d.impacto_tipo === 'economia' ? 'eco' : d.impacto_tipo === 'risco' ? 'risco' : 'ganho'}"><b>${d.impacto_tipo === 'economia' ? '−' : d.impacto_tipo === 'risco' ? '−' : '+'}${R0(d.impacto)}</b><small>${d.impacto_tipo === 'economia' ? 'de gasto por semana' : d.impacto_tipo === 'risco' ? 'por semana em risco' : 'em vendas por semana'}</small></div>`;
    const linhaPasso = ({ l, d }, n) => {
      const t = TIPOS[d.acao] || { rot: 'Ação', cor: 'var(--text-muted)' };
      const passos = passosPainel(d), esp = leitura(l.explicacao), revisar = d.acao === 'abc_queda' || d.acao === 'informativa';
      return `<div class="aml-p" style="--c:${t.cor}">
          <div class="aml-p-n" aria-hidden="true">${n}</div>
          <div class="aml-p-corpo">
            <div class="aml-p-acao"><span class="aml-p-tag">${t.rot}</span>${acaoTxt(d)}</div>
            <div class="aml-p-pq">${pqTxt(d)}</div>
            ${esp ? `<div class="aml-esp"><b>Especialista:</b> ${h(esp)}</div>` : ''}
            <details class="aml-como"><summary>${passos ? 'Como fazer no painel do ML' : 'O que revisar'}</summary>
              ${passos ? `<ol>${passos.map(x => `<li>${x}</li>`).join('')}</ol>` : `<div class="aml-sub">${h(semInstrucao(l.explicacao))}</div>`}
              ${passos ? `<div class="aml-sub aml-expl">${h(semInstrucao(l.explicacao))}</div>` : ''}
            </details>
          </div>
          <div class="aml-p-lado">
            ${impHtml(d)}
            <div class="aml-li-bt">
              <button class="btn btn-secondary btn-sm" ${state.processando ? 'disabled' : ''} title="${revisar ? 'Já revisei' : 'Já apliquei no painel do ML (opcional: o agente confere sozinho amanhã)'}" onclick="window._amlMarcar('${l.id}','executado')">${revisar ? 'Revisado' : 'Feito'}</button>
              <button class="aml-x" ${state.processando ? 'disabled' : ''} title="Descartar" aria-label="Descartar" onclick="window._amlMarcar('${l.id}','descartado')">✕</button>
            </div>
          </div>
        </div>`;
    };
    const pacote = ordGrupos.map((g, i) => {
      const est = g.k.startsWith('__') ? '' : estadoCamp(g.k);
      const impTxt = [g.economia ? `<b>~${R0(g.economia)}/sem</b> de gasto a cortar` : '', g.ganho ? `~${R0(g.ganho)}/sem em vendas` : ''].filter(Boolean).join(' · ');
      const idsGrupo = g.itens.map(x => x.l.id).join(',');
      return `<div class="aml-grupo">
        <div class="aml-grupo-top">
          <div style="min-width:0;flex:1;">
            <div class="aml-grupo-nome">${i === 0 && g.k !== '__revisar' ? '<span class="aml-comece">Comece por aqui</span>' : ''}${h(g.nome)}${g.k.startsWith('__') ? '' : ` <span class="aml-sub">#${h(g.k)}</span>`}</div>
            <div class="aml-sub">${[est ? `hoje: ${est}` : '', `${g.itens.length} passo${g.itens.length > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}</div>
          </div>
          ${impTxt ? `<div class="aml-g-imp">${impTxt}</div>` : ''}
          ${g.k === '__revisar' ? '' : `<button class="btn btn-primary btn-sm" ${state.processando ? 'disabled' : ''} title="Marca todos os passos desta campanha como aplicados" onclick="window._amlMarcarGrupo('${idsGrupo}')">Fiz tudo desta campanha</button>`}
        </div>
        <div class="aml-lista">${g.itens.map((x, j) => linhaPasso(x, j + 1)).join('')}</div>
      </div>`;
    }).join('');
    return `<div class="card" style="padding:18px 20px;margin-bottom:18px;">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px;">
        <div style="font-weight:700;font-size:15px;">O que fazer no Mercado Livre</div>
        <div class="aml-sub">${fazerNoMl} para aplicar no painel do ML · ${todas.length - fazerNoMl} para revisar</div>
      </div>
      <div class="ajuda">Um bloco por campanha, na ordem do que mais custa dinheiro: abra a campanha em Publicidade → Product Ads e faça todos os passos dela. <b>Não precisa marcar Feito</b> — na análise da manhã seguinte o agente lê as campanhas e marca sozinho o que mudou (o ML não deixa a integração alterar, mas deixa ler).</div>
      ${quadroEspecialista(id)}
      ${quadroNova}
      ${todas.length ? `<div class="aml-filtros">${chips.map(([k, t, n]) => `<button class="aml-fchip ${filtro === k ? 'on' : ''}" style="--c:${TIPOS[k]?.cor || 'var(--text-muted)'}" onclick="window._amlFiltroSug('${k}')">${t} <b>${n}</b></button>`).join('')}</div>` : ''}
      ${lista.length ? pacote : '<div class="aml-sub">Nada pendente agora.</div>'}
    </div>`;
  }
  window._amlFiltroSug = k => { state.filtroSug = k; render(); };
  function renderCampanhas(id) {
    const c = state.campanhas[id], m = mesDe(id), cfg = cfgDe(id);
    const tx = m?.taxaCancel || 0;
    let corpo;
    if (!c) corpo = '<div class="aml-sub">⏳ Carregando campanhas…</div>';
    else if (c.erro) corpo = `<div class="aml-sub" style="color:var(--red);">Não consegui buscar as campanhas: ${h(c.erro)}</div>`;
    else if (!c.lista.length) corpo = '<div class="aml-sub">Nenhuma campanha de Product Ads nesta conta.</div>';
    else {
      const pend = new Set(pendentes(id).map(l => String(l.dados?.campaign_id)));
      const linhas = [...c.lista].sort((a, b) => (parseFloat(b.metrics?.cost) || 0) - (parseFloat(a.metrics?.cost) || 0));
      corpo = `<div style="overflow-x:auto;"><table class="aml-tab"><thead><tr><th>Campanha</th><th>Status</th><th>Estratégia</th><th>Orçamento</th><th>ROAS objetivo</th><th>Gasto</th><th>Vendas (sem cancel.)</th><th>ROAS</th><th>ACOS</th></tr></thead><tbody>
        ${linhas.map(x => {
          const mm = x.metrics || {}, g = parseFloat(mm.cost) || 0, v = (parseFloat(mm.total_amount) || 0) * (1 - tx);
          const acos = v > 0 ? g / v * 100 : (g > 0 ? Infinity : null);
          const cor = acos == null || !cfg?.meta_acos ? 'inherit' : acos === Infinity || acos > (cfg.regra_pausa_acos || cfg.meta_acos * 2) ? 'var(--red)' : acos > cfg.meta_acos ? 'var(--yellow)' : 'var(--green)';
          const roasAlvo = parseFloat(x.roas_target) || (x.acos_target ? 100 / x.acos_target : 0);
          const aberta = state.aberto === String(x.id);
          return `<tr class="aml-linha" onclick="window._amlProdutos('${x.id}')"><td><span class="aml-seta">${aberta ? '▾' : '▸'}</span> ${h(x.name)}${pend.has(String(x.id)) ? ' <span class="aml-chip" title="Tem sugestão pendente">sugestão</span>' : ''}</td>
            <td>${x.status === 'active' ? '🟢 ativa' : x.status === 'paused' ? '⏸ pausada' : h(x.status)}</td><td>${h({ PROFITABILITY: 'Rentabilidade', INCREASE: 'Crescimento', VISIBILITY: 'Visibilidade' }[x.strategy] || x.strategy || '—')}</td>
            <td>${x.budget ? R$(x.budget) : '—'}</td><td>${roasAlvo ? roasX(roasAlvo) : '—'}</td>
            <td>${R$(g)}</td><td>${R$(v)}</td><td>${g > 0 ? roasX(v / g) : '—'}</td><td style="color:${cor};font-weight:700;">${acos === Infinity ? '∞' : pct(acos)}</td></tr>
            ${aberta ? `<tr><td colspan="9" style="padding:0;white-space:normal;">${renderProdutos(id, x.id, tx, cfg)}</td></tr>` : ''}`;
        }).join('')}</tbody></table></div>`;
    }
    return `<div class="card" style="padding:18px 20px;margin-bottom:18px;">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
        <div><div style="font-weight:700;font-size:15px;">Campanhas de Product Ads — mês atual</div>
        <div class="aml-sub">Clique numa campanha para ver os produtos dentro dela. ACOS sem cancelados${tx > 0.005 ? ` (cancelamentos/devoluções da loja no mês: ${pct(tx * 100)})` : ''}.</div></div>
        <button class="btn btn-secondary btn-sm" title="Atualizar" ${state.carregandoCamp ? 'disabled' : ''} onclick="window._amlCampanhas()">🔄</button>
      </div>${corpo}</div>`;
  }
  const roasX = v => v && isFinite(v) ? `${(+v).toFixed(1).replace('.', ',')}x` : '—';
  function renderProdutos(contaId, campId, tx, cfg) {
    const p = state.produtos[`${contaId}:${campId}`];
    if (!p || p.carregando) return '<div class="aml-sub" style="padding:10px 14px;">⏳ Carregando produtos…</div>';
    if (p.erro) return `<div class="aml-sub" style="padding:10px 14px;color:var(--red);">Não consegui buscar os produtos: ${h(p.erro)}</div>`;
    if (!p.lista.length) return '<div class="aml-sub" style="padding:10px 14px;">Nenhum produto nesta campanha.</div>';
    const pend = new Set(pendentes(contaId).map(l => String(l.dados?.familia || '')).filter(Boolean));
    const gastoCamp = p.lista.reduce((s, f) => s + f.gasto, 0) || 1;
    return `<div class="aml-prods"><table class="aml-tab"><thead><tr><th>Produto (variações somadas)</th><th>Anúncios ativos</th><th>Gasto</th><th>% do gasto</th><th>Vendas (sem cancel.)</th><th>Un.</th><th>ROAS</th><th>ACOS</th></tr></thead><tbody>
      ${p.lista.map(f => {
        const v = f.vendas * (1 - tx), acos = v > 0 ? f.gasto / v * 100 : (f.gasto > 0 ? Infinity : null);
        const cor = acos == null || !cfg?.meta_acos ? 'inherit' : acos === Infinity ? 'var(--red)' : acos > (cfg.regra_pausa_acos || cfg.meta_acos * 2) ? 'var(--red)' : acos > cfg.meta_acos ? 'var(--yellow)' : 'var(--green)';
        const nMov = Object.values(f.movidos || {}).reduce((x, y) => x + y, 0);
        const pausados = f.itens.length - nMov - f.ativos;
        const nomeCamp = id => (state.campanhas[contaId]?.lista || []).find(c => String(c.id) === String(id))?.name || `campanha ${id}`;
        const movTxt = Object.entries(f.movidos || {}).map(([id, n]) => `${n} movido${n > 1 ? 's' : ''} para ${h(nomeCamp(id))}`).join(', ');
        return `<tr><td style="white-space:normal;min-width:240px;">${f.permalink ? `<a href="${h(f.permalink)}" target="_blank" rel="noopener">${h(f.nome)}</a>` : h(f.nome)}${f.recomendado ? ' <span class="aml-chip" title="O ML recomenda anunciar">recomendado ML</span>' : ''}${pend.has(f.chave) ? ' <span class="aml-chip">sugestão</span>' : ''}</td>
          <td style="white-space:normal;">${f.itens.length - nMov ? `${f.ativos}/${f.itens.length - nMov}` : '—'}${pausados ? ` <span class="aml-sub">(${pausados} fora)</span>` : ''}${movTxt ? `<div class="aml-sub" title="O gasto ao lado é o que ficou nesta campanha antes de mover">→ ${movTxt}</div>` : ''}</td><td>${R$(f.gasto)}</td><td>${Math.round(f.gasto / gastoCamp * 100)}%</td><td>${R$(v)}</td><td>${f.unidades}</td>
          <td>${f.gasto > 0 ? roasX(v / f.gasto) : '—'}</td><td style="color:${cor};font-weight:700;">${acos === Infinity ? '∞' : pct(acos)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }
  // Resultado do que foi aplicado: 7 dias antes × 7 dias depois, por campanha
  function renderResultados(id) {
    const aplicadas = state.logs.filter(l => String(l.conta_id) === String(id) && l.tipo === 'alerta' && l.resultado === 'executado' && l.dados?.acao && l.dados.acao !== 'abc_queda');
    const medidas = aplicadas.filter(l => ['melhorou', 'piorou', 'neutro'].includes(l.dados?.medicao?.veredito));
    const aguardando = aplicadas.filter(l => !l.dados?.medicao).length;
    const detectadas = aplicadas.filter(l => l.dados?.aplicado_por === 'detectado').length;
    const n = v => medidas.filter(l => l.dados.medicao.veredito === v).length;
    const taxa = medidas.length ? Math.round(n('melhorou') / medidas.length * 100) : null;
    const porTipo = {};
    medidas.forEach(l => { const t = l.dados.acao; porTipo[t] = porTipo[t] || { ok: 0, tot: 0 }; porTipo[t].tot++; if (l.dados.medicao.veredito === 'melhorou') porTipo[t].ok++; });
    const VER = { melhorou: ['Melhorou', 'var(--green)'], piorou: ['Piorou', 'var(--red)'], neutro: ['Sem mudança clara', 'var(--text-muted)'] };
    const dm = s => s ? s.split('-').reverse().slice(0, 2).join('/') : '';
    return `<div class="card" style="padding:18px 20px;margin-bottom:18px;">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div style="font-weight:700;font-size:15px;">Deu resultado?</div>
        <div class="aml-sub">cada sugestão aplicada é medida na campanha: 7 dias antes × 7 dias depois</div>
      </div>
      <div class="aml-res-kpis">
        <div><div class="aml-rot">Taxa de acerto</div><div class="aml-val" style="color:${taxa == null ? 'inherit' : taxa >= 70 ? 'var(--green)' : taxa >= 50 ? 'var(--yellow)' : 'var(--red)'}">${taxa == null ? '—' : taxa + '%'}</div><div class="aml-sub">${medidas.length ? `${n('melhorou')} de ${medidas.length} medidas melhoraram` : 'nada medido ainda'}</div></div>
        <div><div class="aml-rot">Pioraram</div><div class="aml-val">${n('piorou')}</div><div class="aml-sub">${n('neutro')} sem mudança clara</div></div>
        <div><div class="aml-rot">Aguardando 7 dias</div><div class="aml-val">${aguardando}</div><div class="aml-sub">aplicadas, ainda sem medição</div></div>
        <div><div class="aml-rot">Detectadas sozinho</div><div class="aml-val">${detectadas}</div><div class="aml-sub">de ${aplicadas.length} aplicadas (sem clicar Feito)</div></div>
      </div>
      ${Object.keys(porTipo).length ? `<div class="aml-filtros" style="margin-top:12px;">${Object.entries(porTipo).sort((a, b) => b[1].tot - a[1].tot).map(([t, v]) => `<span class="aml-fchip" style="cursor:default">${h(TIPOS_ROT[t] || t)}: <b>${Math.round(v.ok / v.tot * 100)}%</b> <span class="aml-sub">(${v.ok}/${v.tot})</span></span>`).join('')}</div>` : ''}
      ${medidas.length ? `<div class="aml-lista" style="margin-top:10px;">${medidas.slice(0, 8).map(l => { const d = l.dados, v = VER[d.medicao.veredito]; return `<div class="aml-res" style="--c:${v[1]}">
          <span class="aml-tipo">${h(TIPOS_ROT[d.acao] || d.acao)}</span>
          <div style="min-width:0"><div class="aml-li-ass">${h(d.produto || d.campanha || '—')}</div><div class="aml-sub">${h(d.medicao.resumo || '')}</div></div>
          <span class="aml-sub">aplicada ${dm(d.medicao.aplicado_dia)}${d.aplicado_por === 'detectado' ? ' · detectada' : ''}</span>
          <span class="aml-ver">${v[0]}</span>
        </div>`; }).join('')}</div>` : `<div class="aml-sub" style="margin-top:10px;">Ainda não há resultados: cada sugestão aplicada é medida 7 dias depois.${aguardando ? ` ${aguardando} aguardando.` : ''}</div>`}
    </div>`;
  }
  const TIPOS_ROT = { retirar_produto: 'Tirar produto', pausar: 'Pausar campanha', mover_produto: 'Mover produto', roas_target: 'Ajustar ROAS', acos_target: 'Meta de ACOS', orcamento: 'Orçamento', adicionar_produto: 'Colocar no ADS', informativa: 'Melhorar anúncio' };

  function renderHistorico(id) {
    const lista = state.logs.filter(l => String(l.conta_id) === String(id) && !(l.tipo === 'alerta' && l.resultado === 'so_alerta')).slice(0, 15);
    const quando = s => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const rot = l => l.tipo === 'sistema' ? 'análise ·' : l.resultado === 'executado' ? (l.dados?.aplicado_por === 'detectado' ? 'aplicada (detectada no painel) ·' : 'aplicada ·') : l.resultado === 'descartado' ? 'descartada ·' : l.resultado === 'expirado' ? 'venceu (refeita se ainda valia) ·' : '';
    return `<details class="card" style="padding:14px 20px;margin-bottom:18px;"><summary style="cursor:pointer;font-weight:700;">Registro</summary>
      ${lista.length ? lista.map(l => `<div class="aml-hist"><span class="aml-sub">${quando(l.criado_em)}</span> ${rot(l)} <b>${h(l.titulo)}</b><div class="aml-sub">${h(semInstrucao(l.explicacao).slice(0, 260))}</div></div>`).join('') : '<div class="aml-sub" style="margin-top:8px;">Nada registrado ainda.</div>'}
    </details>`;
  }

  // Painel "Desempenho de ADS" (a antiga Central de ADS, agora dentro desta tela)
  // — container próprio, fora do aml-root que é redesenhado a todo momento.
  let _desempenhoConta = null;
  function montarDesempenho() {
    const box = document.getElementById('aml-desempenho');
    if (!box) return;
    const id = state.aberta && state.aberta !== '__novo__' && !state.carregando && cfgDe(state.aberta) ? String(state.aberta) : null;
    if (!id) { if (_desempenhoConta) { box.innerHTML = ''; _desempenhoConta = null; } return; }
    if (_desempenhoConta === id || !window.AdsCentral) return;
    _desempenhoConta = id;
    box.innerHTML = '<div class="card" style="padding:20px 22px;margin-top:4px;"><div id="aml-desempenho-corpo"></div></div>';
    window.AdsCentral.montar(document.getElementById('aml-desempenho-corpo'), { marketplace: 'ml', contaId: id, semCampanhas: true, semIA: false });
  }

  function render() {
    setTimeout(montarDesempenho, 0);
    const root = document.getElementById('aml-root'); if (!root) return;
    if (state.carregando) { root.innerHTML = '<div class="aml-sub" style="padding:30px;">⏳ Carregando…</div>'; return; }
    if (!state.aberta) { root.innerHTML = renderPortfolio(); return; }
    if (state.aberta === '__novo__') { root.innerHTML = `<button class="btn btn-secondary btn-sm" style="margin-bottom:14px;" onclick="window._amlAbrir(null)">← Voltar</button>${renderConfig(null)}`; return; }
    const id = state.aberta, cfg = cfgDe(id), m = mesDe(id);
    const ultima = state.logs.find(l => String(l.conta_id) === String(id) && l.tipo === 'sistema' && /^Análise ML|^Erro na análise ML/.test(l.titulo || ''));
    root.innerHTML = `
      <div class="card aml-topo">
        <button class="btn btn-secondary btn-sm" onclick="window._amlAbrir(null)" title="Todas as contas">←</button>
        <select class="form-control" style="max-width:260px;" onchange="window._amlAbrir(this.value)">
          ${state.configs.map(c => `<option value="${h(c.conta_id)}" ${String(c.conta_id) === id ? 'selected' : ''}>${h(nomeDe(c.conta_id))}</option>`).join('')}
          <option value="__novo__">+ Adicionar conta</option>
        </select>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" ${cfg?.ativo ? 'checked' : ''} onchange="window._amlAtivo(this.checked)"> Análise diária 07:00</label>
        <span class="aml-sub" style="flex:1;">${ultima ? `Última análise: ${new Date(ultima.criado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'Ainda não analisou'}</span>
        <button class="btn btn-secondary btn-sm" onclick="window._amlEditar(${state.editando ? 'false' : 'true'})">Guardrails</button>
        <button class="btn btn-primary btn-sm" ${state.analisando ? 'disabled' : ''} onclick="window._amlAnalisar()">${state.analisando ? '⏳ Analisando…' : 'Analisar agora'}</button>
      </div>
      ${state.editando ? renderConfig(cfg) : ''}
      <div class="aml-kpis">
        ${kpi('Faturamento do mês (sem cancelados)', m ? R$(m.fat) : '—', m ? `projeção do mês <b>${R$(m.proj)}</b>` : 'a base automática ainda não cobre o mês desta conta')}
        ${kpi('Investimento em ADS no mês', m?.ads != null ? R$(m.ads) : '—', '', 'var(--cyan)')}
        ${kpi('TACOS do mês vs meta', pct(m?.tacos), `meta ${pct(cfg?.meta_acos)}`, corTacos(m?.tacos, cfg?.meta_acos))}
      </div>
      ${renderSugestoes(id)}
      ${renderResultados(id)}
      ${renderCampanhas(id)}
      ${renderHistorico(id)}`;
  }

  window._amlAbrir = id => {
    state.aberta = id || null; state.editando = false;
    if (!id) GLR.ctx?.definir('', true); else if (id !== '__novo__') GLR.ctx?.definirPorConta('ml', id);
    try { if (id && id !== '__novo__') localStorage.setItem('glr_aml_conta', id); else localStorage.removeItem('glr_aml_conta'); } catch (e) {}
    render();
    if (id && id !== '__novo__') carregarCampanhas(id);
  };
  window._amlEditar = on => { state.editando = !!on; render(); };
  window._amlSalvar = salvarConfig;
  window._amlAtivo = alternarAtivo;
  window._amlAnalisar = analisarAgora;
  window._amlMarcar = marcar;
  window._amlMarcarGrupo = marcarGrupo;
  window._amlCampanhas = () => { state.produtos = {}; carregarCampanhas(state.aberta, true); };
  window._amlProdutos = campId => {
    campId = String(campId);
    state.aberto = state.aberto === campId ? null : campId; render();
    if (state.aberto) carregarProdutos(state.aberta, campId);
  };

  el.innerHTML = `<div class="page">
    <div class="aml-copiloto"><span class="aml-chip" title="Analisa e sugere; você aplica no painel do ML">Copiloto</span></div>
    <div class="ajuda">Analisa os anúncios patrocinados (Product Ads) de cada conta com as mesmas regras do agente da Shopee e sugere o que ajustar. O Mercado Livre não libera alteração de campanhas por integração — então você aplica no painel do ML; o agente confere sozinho o que mudou e, 7 dias depois, mede se deu resultado. Quando o ML liberar, ele passa a executar sozinho.</div>
    <div id="aml-root"></div>
    <div id="aml-desempenho"></div>
  </div>
  <style>
    .aml-sub{font-size:12.5px;color:var(--text-muted);line-height:1.5;}
    .aml-esp{font-size:12px;color:var(--text-secondary);margin-top:4px;line-height:1.45;padding-left:8px;border-left:2px solid var(--purple);}
    .aml-espq{margin:10px 0 12px;padding:11px 14px;border-radius:10px;background:color-mix(in srgb,var(--purple) 8%,var(--bg-card));border:1px solid color-mix(in srgb,var(--purple) 25%,transparent);}
    .aml-espq-t{font-weight:650;font-size:13px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px;} .aml-espq-x{font-size:13px;line-height:1.55;color:var(--text-primary);} .aml-espq-e{font-size:12.5px;color:var(--text-secondary);margin-top:6px;}
    .aml-chip{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;background:rgba(99,102,241,.12);color:var(--accent);vertical-align:middle;}
    .aml-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;}
    .aml-card{padding:16px 18px;cursor:pointer;border-left:4px solid var(--c,var(--text-muted));}
    .aml-novo{display:flex;align-items:center;justify-content:center;min-height:110px;color:var(--text-muted);font-weight:600;border-style:dashed;}
    .aml-rot{font-size:11px;text-transform:none;letter-spacing:0;color:var(--text-muted);}
    .aml-val{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;}
    .aml-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:18px;}
    .aml-kpi{background:var(--bg-card);border:1px solid var(--border);border-left:4px solid var(--c);border-radius:12px;padding:12px 14px;}
    .aml-topo{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;margin-bottom:18px;}
    .aml-sug{border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;}
    .aml-filtros{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}
    .aml-fchip{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:4px 11px;font-size:12px;cursor:pointer;}
    .aml-fchip.on{background:var(--c);border-color:var(--c);color:#fff;}
    .aml-lista{border:1px solid var(--border);border-radius:10px;overflow:hidden;}
    .aml-tipo{font-size:11px;font-weight:700;color:var(--c);text-transform:none;letter-spacing:0;}
    .aml-li-ass{font-weight:700;font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .aml-nova{border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:13px;background:var(--bg-card-hover);}
    .aml-nova-ids{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--text-secondary);word-break:break-all;}
    .aml-p{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);box-shadow:inset 3px 0 0 var(--c);}
    .aml-p:last-child{border-bottom:none;}
    .aml-p-n{width:24px;height:24px;border-radius:50%;background:var(--bg-subtle);color:var(--text-secondary);font-size:12px;font-weight:700;display:grid;place-items:center;margin-top:1px;}
    .aml-p-corpo{min-width:0;display:flex;flex-direction:column;gap:4px;}
    .aml-p-acao{font-size:14px;line-height:1.45;color:var(--text-primary);} .aml-p-acao b{font-weight:650;}
    .aml-p-tag{display:inline-block;font-size:10.5px;font-weight:700;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);border-radius:5px;padding:1px 7px;margin-right:8px;vertical-align:1px;letter-spacing:.02em;}
    .aml-p-pq{font-size:13px;line-height:1.5;color:var(--text-secondary);} .aml-p-pq b{color:var(--text-primary);}
    .aml-como{font-size:12.5px;margin-top:2px;} .aml-como summary{cursor:pointer;color:var(--accent);font-weight:600;font-size:12.5px;width:max-content;}
    .aml-como ol{margin:8px 0 6px;padding-left:20px;display:flex;flex-direction:column;gap:6px;color:var(--text-primary);line-height:1.5;}
    .aml-ids{display:inline-flex;flex-wrap:wrap;gap:4px;margin:0 6px;} .aml-ids a{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:var(--bg-subtle);border-radius:5px;padding:1px 6px;color:var(--text-primary);text-decoration:none;} .aml-ids a:hover{text-decoration:underline;}
    .aml-cop{border:1px solid var(--border);background:var(--bg-card);border-radius:6px;font-size:11.5px;padding:2px 8px;cursor:pointer;color:var(--text-secondary);}
    .aml-expl{margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);}
    .aml-p-lado{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:150px;}
    .aml-p-imp{text-align:right;display:flex;flex-direction:column;line-height:1.2;} .aml-p-imp b{font-size:15px;font-variant-numeric:tabular-nums;} .aml-p-imp small{font-size:11px;color:var(--text-muted);}
    .aml-p-imp.eco b{color:var(--green);} .aml-p-imp.ganho b{color:var(--accent);} .aml-p-imp.risco b{color:var(--red);}
    .aml-g-imp{font-size:12.5px;color:var(--text-secondary);}
    @media (max-width:760px){.aml-p{grid-template-columns:24px minmax(0,1fr)}.aml-p-lado{grid-column:2;flex-direction:row;align-items:center;justify-content:space-between;min-width:0}.aml-p-imp{text-align:left}}
    .aml-li-pq{font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums;}
    .aml-li-bt{display:flex;gap:6px;align-items:center;justify-content:flex-end;}
    .aml-x{border:1px solid var(--border);background:none;border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text-muted);}
    .aml-x:hover{border-color:var(--red);color:var(--red);}
    .aml-tab{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums;}
    .aml-tab th,.aml-tab td{padding:7px 8px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap;}
    .aml-tab th{font-size:11px;color:var(--text-muted);text-transform:none;}
    .aml-campos{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 16px;}
    .aml-campo{display:flex;flex-direction:column;gap:4px;font-size:12.5px;margin-bottom:8px;}
    .aml-campo > div{display:flex;align-items:center;gap:6px;} .aml-campo em{font-style:normal;color:var(--text-muted);font-size:12px;}
    .aml-campo small{color:var(--text-muted);font-size:11px;}
    .aml-linha{cursor:pointer;} .aml-linha:hover td{background:rgba(99,102,241,.05);}
    .aml-seta{display:inline-block;width:12px;color:var(--text-muted);}
    .aml-prods{background:rgba(99,102,241,.04);padding:6px 10px 10px 26px;overflow-x:auto;}
    .aml-prods a{color:inherit;text-decoration:underline;text-decoration-color:var(--border);}
    .aml-grupo{border:1px solid var(--border);border-radius:12px;margin-bottom:12px;overflow:hidden;}
    .aml-grupo .aml-lista{border:none;border-radius:0;border-top:1px solid var(--border);}
    .aml-grupo-top{display:flex;gap:12px;align-items:center;padding:10px 14px;background:var(--bg-subtle);flex-wrap:wrap;}
    .aml-grupo-nome{font-weight:700;font-size:14px;color:var(--text-primary);display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
    .aml-comece{font-size:11px;font-weight:650;color:var(--on-accent,#fff);background:var(--accent);border-radius:99px;padding:2px 8px;}
    .aml-imp{font-size:11.5px;color:var(--text-muted);margin-top:2px;}
    .aml-res-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;}
    .aml-res{display:grid;grid-template-columns:130px minmax(0,1fr) auto auto;gap:4px 14px;align-items:center;padding:9px 14px;border-left:4px solid var(--c);border-bottom:1px solid var(--border);}
    .aml-res:last-child{border-bottom:none;}
    .aml-ver{font-size:12px;font-weight:650;color:var(--c);white-space:nowrap;}
    @media (max-width:900px){.aml-res{grid-template-columns:1fr auto}.aml-res>div{grid-column:1/-1}}
    .aml-hist{padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;}
  </style>`;
  carregar();
});
