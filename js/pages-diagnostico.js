// ============================================================
// GLR Consultoria — Diagnóstico do Sistema
// Painel que mostra, por área, se tem dado salvo, de quando é,
// e testa a conexão com a API ao vivo. Não corrige nada sozinho —
// só mostra o que está acontecendo, pra facilitar achar problema.
// ============================================================

Router.register('diagnostico', async (params, el) => {
  const lerJSON = (key, fallback=null) => {
    try { const v = JSON.parse(localStorage.getItem(key)||'null'); return v==null ? fallback : v; }
    catch(e) { return fallback; }
  };

  function fmtAgo(ts) {
    if (!ts) return '—';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)    return 'agora mesmo';
    if (diff < 3600)  return `há ${Math.floor(diff/60)} min`;
    if (diff < 86400) return `há ${Math.floor(diff/3600)}h`;
    return `há ${Math.floor(diff/86400)} dias`;
  }

  function statusDe(ts, { semDadoOk=false } = {}) {
    if (!ts) return semDadoOk
      ? { label: 'OK', cor: '#10b981', bg: 'rgba(16,185,129,0.12)' }
      : { label: 'Sem dados', cor: '#ef4444', bg: 'rgba(239,68,68,0.12)' };
    const horas = (Date.now() - ts) / 3600000;
    if (horas < 24) return { label: 'Atualizado', cor: '#10b981', bg: 'rgba(16,185,129,0.12)' };
    if (horas < 72) return { label: 'Desatualizado', cor: '#f59e0b', bg: 'rgba(245,158,11,0.12)' };
    return { label: 'Muito antigo', cor: '#ef4444', bg: 'rgba(239,68,68,0.12)' };
  }

  function montarAreas() {
    const vinculos = lerJSON('glr_mc_vinculos', {});
    const totalContasVinc = Object.values(vinculos).reduce((s,arr)=>s+(arr?.length||0), 0);

    const vendasCache   = lerJSON('glr_vendas_cache');
    const oportCache    = lerJSON('glr_vendas_oportunidades');
    const foraAdsCache  = lerJSON('glr_vendas_fora_ads');
    const finCache      = lerJSON('glr_fin_cache');
    const anaExecCache  = lerJSON('glr_analytics_dados');
    const anaQuedaCache = lerJSON('glr_analytics_queda');
    const projecoes     = lerJSON('glr_projecoes', []);

    const adsKeys = Object.keys(localStorage).filter(k => k.startsWith('glr_ads_cache_'));
    let adsUltimoAt = null;
    adsKeys.forEach(k => { const c = lerJSON(k); if (c?.at && (!adsUltimoAt || c.at > adsUltimoAt)) adsUltimoAt = c.at; });

    const afilTodos = lerJSON('glr_afiliados_cache', {});
    let afilUltimoAt = null, afilQtdSets = 0;
    Object.values(afilTodos).forEach(c => {
      Object.values(c?.at||{}).forEach(ts => { afilQtdSets++; if (!afilUltimoAt || ts > afilUltimoAt) afilUltimoAt = ts; });
    });

    const conciliacaoCache = lerJSON('glr_conciliacao_cache');

    return [
      { nome: 'Vendas — Pedidos',        icone: '🛒', pagina: 'vendas',    at: vendasCache?.at,
        detalhe: vendasCache ? `${vendasCache.pedidos?.length||0} pedidos · ${vendasCache.dataFrom||'?'} a ${vendasCache.dataTo||'?'}` : 'Nunca buscado', auto: true },
      { nome: 'Vendas — Oportunidades',  icone: '🎯', pagina: 'vendas',    at: oportCache?.at,
        detalhe: oportCache ? `${oportCache.oportunidades?.length||0} produto(s) encontrado(s)` : 'Nunca buscado', auto: true },
      { nome: 'Vendas — Fora do ADS',    icone: '🚫', pagina: 'vendas',    at: foraAdsCache?.at,
        detalhe: foraAdsCache ? `${foraAdsCache.foraDoAds?.length||0} produto(s) encontrado(s)` : 'Nunca buscado', auto: true },
      { nome: 'Financeiro',              icone: '💰', pagina: 'financeiro', at: finCache?.at,
        detalhe: finCache ? `${finCache.pedidos?.length||0} pedidos · mês ${finCache.mesKey||'?'}` : 'Nunca buscado', auto: true },
      { nome: 'Analytics — Painel Executivo', icone: '📊', pagina: 'analytics', at: anaExecCache?.atualizadoEm,
        detalhe: anaExecCache ? `${anaExecCache.dados?.length||0} conta(s)` : 'Nunca buscado', auto: true },
      { nome: 'Analytics — Produtos em Queda', icone: '📉', pagina: 'analytics', at: anaQuedaCache?.atualizadoEm,
        detalhe: anaQuedaCache ? `${anaQuedaCache.produtos?.length||0} produto(s) em queda` : 'Nunca buscado', auto: true },
      { nome: 'Projeção de Crescimento', icone: '📈', pagina: 'projecao',  at: null, semDadoOk: projecoes.length > 0,
        detalhe: `${projecoes.length} projeção(ões) configurada(s)`, auto: true },
      { nome: 'Central de ADS',          icone: '📢', pagina: 'ads',       at: adsUltimoAt,
        detalhe: adsKeys.length ? `${adsKeys.length} conta(s)/mês em cache` : 'Nunca buscado', manual: true },
      { nome: 'Central de Afiliados',    icone: '🔗', pagina: 'afiliados', at: afilUltimoAt,
        detalhe: afilQtdSets ? `${afilQtdSets} conta(s)/mês em cache` : 'Nunca buscado', manual: true },
      { nome: 'Conciliação Financeira',  icone: '🧾', pagina: 'conciliacao', at: conciliacaoCache?.at,
        detalhe: conciliacaoCache ? `${conciliacaoCache.pedidos?.length||0} pedidos conciliados` : 'Nunca buscado', manual: true },
    ];
  }

  function render(testeApi) {
    const apiKey = localStorage.getItem('glr_mc_apikey') || '';
    const vinculos = lerJSON('glr_mc_vinculos', {});
    const totalContasVinc = Object.values(vinculos).reduce((s,arr)=>s+(arr?.length||0), 0);
    const areas = montarAreas();

    const okCount = areas.filter(a => statusDe(a.at, {semDadoOk:a.semDadoOk}).label==='Atualizado' || a.semDadoOk).length;

    el.innerHTML = `
    <div class="page">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
        <div>
          <h1 style="font-size:20px;font-weight:800;margin:0;">🩺 Diagnóstico do Sistema</h1>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Mostra o que já está salvo em cada área e testa a conexão com a API — não faz nenhuma busca de vendas sozinho.</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn-primary" style="padding:8px 16px;" id="btn-testar-api" ${testeApi==='carregando'?'disabled':''}>${testeApi==='carregando'?'⏳ Testando...':'🔄 Testar conexão'}</button>
          <button class="btn-primary" style="padding:8px 16px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#10b981;" id="btn-atualizar-tudo">⚡ Atualizar tudo</button>
        </div>
      </div>

      <div class="kpi-grid mb-24" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));">
        <div class="kpi-card">
          <div class="kpi-icon" style="background:${apiKey?'rgba(16,185,129,0.12)':'rgba(239,68,68,0.12)'};"><span style="font-size:18px;">🔑</span></div>
          <div class="kpi-label">API Key</div>
          <div class="kpi-value" style="color:${apiKey?'#10b981':'#ef4444'};font-size:16px;">${apiKey ? 'Configurada' : 'Não configurada'}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:${totalContasVinc>0?'rgba(16,185,129,0.12)':'rgba(239,68,68,0.12)'};"><span style="font-size:18px;">🔗</span></div>
          <div class="kpi-label">Contas Vinculadas</div>
          <div class="kpi-value">${totalContasVinc}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:rgba(16,185,129,0.12);"><span style="font-size:18px;">✅</span></div>
          <div class="kpi-label">Áreas em dia</div>
          <div class="kpi-value">${okCount} / ${areas.length}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:${testeApi==='ok'?'rgba(16,185,129,0.12)':testeApi==='erro'?'rgba(239,68,68,0.12)':'rgba(148,163,184,0.12)'};"><span style="font-size:18px;">📡</span></div>
          <div class="kpi-label">Conexão API (agora)</div>
          <div class="kpi-value" style="font-size:14px;color:${testeApi==='ok'?'#10b981':testeApi==='erro'?'#ef4444':'var(--text-muted)'};">
            ${testeApi==='ok' ? '🟢 Respondendo' : testeApi==='erro' ? '🔴 Erro' : testeApi==='carregando' ? '⏳ Testando...' : 'Não testado ainda'}
          </div>
        </div>
      </div>

      ${testeApi==='erro' ? `<div class="card mb-16" style="border-color:rgba(239,68,68,0.4);">
        <div style="color:#ef4444;font-weight:700;font-size:13px;margin-bottom:4px;">Erro ao testar a API:</div>
        <div style="font-size:12px;color:var(--text-secondary);font-family:monospace;">${window._diagErroApi||''}</div>
      </div>` : ''}

      <div class="card" style="padding:0;overflow:hidden;">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);font-weight:700;">📋 Status por Área</div>
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:700px;">
          <thead>
            <tr style="background:#1a2744;color:white;">
              <th style="padding:10px 12px;text-align:left;">Área</th>
              <th style="padding:10px 8px;text-align:left;">Detalhe</th>
              <th style="padding:10px 8px;text-align:right;">Última atualização</th>
              <th style="padding:10px 8px;text-align:center;">Status</th>
              <th style="padding:10px 8px;text-align:center;">Automação</th>
            </tr>
          </thead>
          <tbody>
            ${areas.map((a,i) => {
              const st = statusDe(a.at, {semDadoOk:a.semDadoOk});
              return `
              <tr style="background:${i%2===0?'var(--bg-card)':'var(--bg-surface)'};cursor:pointer;" onclick="Router.navigate('${a.pagina}')">
                <td style="padding:9px 12px;font-weight:600;border-left:3px solid ${st.cor};">${a.icone} ${a.nome}</td>
                <td style="padding:9px 8px;color:var(--text-secondary);">${a.detalhe}</td>
                <td style="padding:9px 8px;text-align:right;color:var(--text-muted);">${a.semDadoOk ? '—' : fmtAgo(a.at)}</td>
                <td style="padding:9px 8px;text-align:center;"><span style="background:${st.bg};color:${st.cor};font-weight:700;padding:3px 10px;border-radius:99px;font-size:11px;">${st.label}</span></td>
                <td style="padding:9px 8px;text-align:center;font-size:10.5px;color:var(--text-muted);">${a.manual ? 'requer conta manual' : 'incluído em "Atualizar tudo"'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        </div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;padding:10px 4px;font-size:11px;color:var(--text-muted);">
        <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#10b981;border-radius:3px;"></span> Atualizado (&lt;24h)</span>
        <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#f59e0b;border-radius:3px;"></span> Desatualizado (24–72h)</span>
        <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#ef4444;border-radius:3px;"></span> Muito antigo (&gt;72h) ou sem dados</span>
        <span style="margin-left:auto;">Clique numa linha pra abrir a página correspondente</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);padding:4px;">
        📢 Central de ADS, 🔗 Afiliados e 🧾 Conciliação exigem escolher uma conta específica — não entram no "Atualizar tudo" pra não disparar chamada em todas as contas de uma vez sem querer.
      </div>
    </div>`;

    document.getElementById('btn-testar-api')?.addEventListener('click', testarApi);
  }

  async function testarApi() {
    const apiKey = localStorage.getItem('glr_mc_apikey') || '';
    if (!apiKey) {
      window._diagErroApi = 'Nenhuma API Key configurada. Configure em Integrações.';
      render('erro');
      return;
    }
    render('carregando');
    try {
      await MarketplaceAPI.call('list_accounts');
      render('ok');
    } catch(e) {
      window._diagErroApi = e.message;
      render('erro');
    }
  }

  document.getElementById('btn-atualizar-tudo')?.addEventListener('click', atualizarTudo);

  // ── Atualizar tudo: navega por cada página automática e dispara a busca real
  // dela (clicando no botão de verdade ou chamando a função exposta), uma de
  // cada vez. Fica num overlay fixo (fora do #page-content) pra sobreviver às
  // trocas de página do Router.navigate no meio do processo. ──
  const ETAPAS_AUTO = [
    { nome: '🛒 Vendas — Pedidos',       rota: 'vendas',     modo: 'click', btnId: 'btn-buscar', cacheKey: 'glr_vendas_cache' },
    { nome: '🎯 Vendas — Oportunidades', rota: 'vendas',     modo: 'fn',    fnGlobal: 'buscarOportunidades', cacheKey: 'glr_vendas_oportunidades' },
    { nome: '🚫 Vendas — Fora do ADS',   rota: 'vendas',     modo: 'fn',    fnGlobal: 'buscarForaDoAds', cacheKey: 'glr_vendas_fora_ads' },
    { nome: '💰 Financeiro',             rota: 'financeiro', modo: 'click', btnId: 'fin-btn-atualizar', cacheKey: 'glr_fin_cache' },
    { nome: '📊 Analytics — Painel Executivo', rota: 'analytics', modo: 'fn', fnGlobal: '_analyticsBuscarExec', cacheKey: 'glr_analytics_dados' },
    { nome: '📉 Analytics — Produtos em Queda', rota: 'analytics', modo: 'fn', fnGlobal: '_analyticsBuscarQueda', cacheKey: 'glr_analytics_queda' },
    { nome: '📈 Projeção de Crescimento', rota: 'projecao',  modo: 'fn',    fnGlobal: 'buscarDadosProjecao', semCache: true },
  ];

  function _lerCacheAt(key) {
    if (!key) return null;
    try { const v = JSON.parse(localStorage.getItem(key)||'null'); return v?.at ?? v?.atualizadoEm ?? null; } catch(e) { return null; }
  }

  function _overlayHTML(etapas, idxAtual) {
    return `
    <div id="diag-overlay" style="position:fixed;bottom:20px;right:20px;width:340px;background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.4);z-index:9999;overflow:hidden;">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-weight:700;font-size:13px;display:flex;justify-content:space-between;align-items:center;">
        <span>⚡ Atualizando tudo...</span>
        <span style="font-size:11px;color:var(--text-muted);">${idxAtual+1}/${etapas.length}</span>
      </div>
      <div style="height:4px;background:var(--bg-card);">
        <div style="height:100%;width:${Math.round((idxAtual/etapas.length)*100)}%;background:#10b981;transition:width .3s;"></div>
      </div>
      <div style="max-height:280px;overflow-y:auto;padding:8px 0;">
        ${etapas.map((e,i) => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 16px;font-size:12px;">
            <span style="width:16px;text-align:center;">${e.status==='ok'?'✅':e.status==='erro'?'❌':i===idxAtual?'⏳':'⚪'}</span>
            <span style="flex:1;color:${i===idxAtual?'var(--text-primary)':'var(--text-secondary)'};font-weight:${i===idxAtual?'700':'400'};">${e.nome}</span>
            ${e.erro?`<span style="font-size:10px;color:#ef4444;">${e.erro}</span>`:''}
          </div>`).join('')}
      </div>
    </div>`;
  }

  function _atualizarOverlay(etapas, idxAtual) {
    document.getElementById('diag-overlay')?.remove();
    const div = document.createElement('div');
    div.innerHTML = _overlayHTML(etapas, idxAtual);
    document.body.appendChild(div.firstElementChild);
  }

  async function atualizarTudo() {
    if (window._diagRodandoTudo) return;
    window._diagRodandoTudo = true;
    const etapas = ETAPAS_AUTO.map(e => ({ ...e, status: null }));
    let rotaAtual = null;

    for (let i = 0; i < etapas.length; i++) {
      const et = etapas[i];
      _atualizarOverlay(etapas, i);
      try {
        if (et.rota !== rotaAtual) {
          Router.navigate(et.rota);
          rotaAtual = et.rota;
          await new Promise(r => setTimeout(r, 600)); // espera a página montar
        }
        const antes = et.semCache ? null : _lerCacheAt(et.cacheKey);

        if (et.modo === 'click') {
          const btn = document.getElementById(et.btnId);
          if (!btn) throw new Error('botão não encontrado');
          btn.click();
        } else if (et.modo === 'fn') {
          const fn = window[et.fnGlobal];
          if (typeof fn !== 'function') throw new Error('função não disponível');
          // buscarDadosProjecao aceita um modo "silencioso" (não mostra alert em erro) — os demais não usam esse parâmetro
          await fn(et.fnGlobal === 'buscarDadosProjecao' ? true : undefined);
        }

        if (et.semCache) {
          // Sem timestamp único pra conferir (ex: Projeção) — já esperou a função terminar (await), considera OK
          etapas[i].status = 'ok';
        } else {
          // Polling: espera o cache dessa área ganhar um "at" mais novo, até 90s
          const inicio = Date.now();
          let ok = false;
          while (Date.now() - inicio < 90000) {
            await new Promise(r => setTimeout(r, 1500));
            const depois = _lerCacheAt(et.cacheKey);
            if (depois && depois !== antes) { ok = true; break; }
          }
          etapas[i].status = ok ? 'ok' : 'erro';
          if (!ok) etapas[i].erro = 'tempo esgotado';
        }
      } catch(e) {
        etapas[i].status = 'erro';
        etapas[i].erro = e.message;
      }
      _atualizarOverlay(etapas, i);
    }

    await new Promise(r => setTimeout(r, 1200));
    document.getElementById('diag-overlay')?.remove();
    window._diagRodandoTudo = false;
    Router.navigate('diagnostico');
  }

  render(null);
});
