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

    return [
      { nome: 'Vendas — Pedidos',        icone: '🛒', pagina: 'vendas',    at: vendasCache?.at,
        detalhe: vendasCache ? `${vendasCache.pedidos?.length||0} pedidos · ${vendasCache.dataFrom||'?'} a ${vendasCache.dataTo||'?'}` : 'Nunca buscado' },
      { nome: 'Vendas — Oportunidades',  icone: '🎯', pagina: 'vendas',    at: oportCache?.at,
        detalhe: oportCache ? `${oportCache.oportunidades?.length||0} produto(s) encontrado(s)` : 'Nunca buscado' },
      { nome: 'Vendas — Fora do ADS',    icone: '🚫', pagina: 'vendas',    at: foraAdsCache?.at,
        detalhe: foraAdsCache ? `${foraAdsCache.foraDoAds?.length||0} produto(s) encontrado(s)` : 'Nunca buscado' },
      { nome: 'Financeiro',              icone: '💰', pagina: 'financeiro', at: finCache?.at,
        detalhe: finCache ? `${finCache.pedidos?.length||0} pedidos · mês ${finCache.mesKey||'?'}` : 'Nunca buscado' },
      { nome: 'Analytics — Painel Executivo', icone: '📊', pagina: 'analytics', at: anaExecCache?.atualizadoEm,
        detalhe: anaExecCache ? `${anaExecCache.dados?.length||0} conta(s)` : 'Nunca buscado' },
      { nome: 'Analytics — Produtos em Queda', icone: '📉', pagina: 'analytics', at: anaQuedaCache?.atualizadoEm,
        detalhe: anaQuedaCache ? `${anaQuedaCache.produtos?.length||0} produto(s) em queda` : 'Nunca buscado' },
      { nome: 'Central de ADS',          icone: '📢', pagina: 'ads',       at: adsUltimoAt,
        detalhe: adsKeys.length ? `${adsKeys.length} conta(s)/mês em cache` : 'Nunca buscado' },
      { nome: 'Central de Afiliados',    icone: '🔗', pagina: 'afiliados', at: afilUltimoAt,
        detalhe: afilQtdSets ? `${afilQtdSets} conta(s)/mês em cache` : 'Nunca buscado' },
      { nome: 'Projeção de Crescimento', icone: '📈', pagina: 'projecao',  at: null, semDadoOk: projecoes.length > 0,
        detalhe: `${projecoes.length} projeção(ões) configurada(s)` },
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
        <button class="btn-primary" style="padding:8px 16px;" id="btn-testar-api" ${testeApi==='carregando'?'disabled':''}>${testeApi==='carregando'?'⏳ Testando...':'🔄 Testar conexão com a API agora'}</button>
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

  render(null);
});
