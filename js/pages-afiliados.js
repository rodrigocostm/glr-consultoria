// ============================================================
// GLR Consultoria — Central de Afiliados
// Shopee AMS + Mercado Livre Afiliados
// ============================================================

Router.register('afiliados', async (params, el) => {
  const apiKey = localStorage.getItem('glr_mc_apikey') || '';

  if (!apiKey) {
    el.innerHTML = `<div class="page"><div style="text-align:center;padding:80px 24px;">
      <div style="font-size:48px;margin-bottom:16px;">🔗</div>
      <div style="font-size:20px;font-weight:700;margin-bottom:8px;">Central de Afiliados</div>
      <div style="font-size:14px;color:var(--text-muted);margin-bottom:24px;">Configure sua API Key em Integrações para ver os dados de afiliados.</div>
      <button class="btn btn-primary" onclick="Router.navigate('integracoes')">Configurar API</button>
    </div></div>`;
    return;
  }

  // Carrega vinculos e clientes
  let vinculos = {};
  try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch(e) {}

  const clientesComVinc = GLR.clientes.filter(c => (vinculos[String(c.id)] || []).length > 0);
  if (!clientesComVinc.length) {
    el.innerHTML = `<div class="page"><div style="text-align:center;padding:80px 24px;">
      <div style="font-size:48px;margin-bottom:16px;">🔗</div>
      <div style="font-size:20px;font-weight:700;margin-bottom:8px;">Nenhum cliente vinculado</div>
      <div style="font-size:14px;color:var(--text-muted);margin-bottom:24px;">Vincule contas em Integrações para ver os dados de afiliados.</div>
      <button class="btn btn-primary" onclick="Router.navigate('integracoes')">Configurar vínculos</button>
    </div></div>`;
    return;
  }

  // Estado
  let clienteSelecionado = parseInt(params?.clienteId) || clientesComVinc[0]?.id;
  let plataforma = params?.plat || 'shopee';
  let _dadosCache = {};
  let _carregando = false;

  // ── Período (mês atual)
  const hoje = new Date();
  const pad  = n => String(n).padStart(2,'0');
  const anoMes = `${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}`;
  const dataInicio = `${anoMes}-01`;
  const dataFim    = `${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}-${pad(hoje.getDate())}`;

  function contasDoCliente(cidId, mkt) {
    return (vinculos[String(cidId)] || []).filter(c => {
      const m = (c.marketplace || '').toLowerCase();
      if (mkt === 'shopee') return m === 'shopee';
      if (mkt === 'ml') return ['mercadolivre','ml','meli'].includes(m);
      return true;
    });
  }

  function fmtBRL(v) {
    return parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtNum(v) { return parseInt(v || 0).toLocaleString('pt-BR'); }

  // ── Render shell ──────────────────────────────────────────
  function renderShell() {
    const clienteAtual = GLR.clientes.find(c => c.id === clienteSelecionado);
    const contasShopee = contasDoCliente(clienteSelecionado, 'shopee');
    const contasML     = contasDoCliente(clienteSelecionado, 'ml');

    el.innerHTML = `<div class="page">
      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <div>
          <h2 style="font-size:20px;font-weight:800;margin:0;">🔗 Central de Afiliados</h2>
          <div style="font-size:13px;color:var(--text-muted);margin-top:2px;">${dataInicio} → ${dataFim}</div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <select id="sel-cliente-afil" class="form-control" style="min-width:160px;" onchange="window._afilClienteChange(this.value)">
            ${clientesComVinc.map(c => `<option value="${c.id}" ${c.id===clienteSelecionado?'selected':''}>${c.nome}</option>`).join('')}
          </select>
          <button class="btn btn-primary" id="btn-buscar-afil" onclick="window._afilBuscar()">
            🔄 Buscar dados
          </button>
        </div>
      </div>

      <!-- Tabs plataforma -->
      <div style="display:flex;gap:8px;margin-bottom:20px;">
        ${contasShopee.length ? `<button class="btn ${plataforma==='shopee'?'btn-primary':'btn-secondary'}" onclick="window._afilPlat('shopee')" style="display:flex;align-items:center;gap:6px;">
          🟠 Shopee <span style="opacity:.7;font-size:11px;">(${contasShopee.length} conta${contasShopee.length>1?'s':''})</span>
        </button>` : ''}
        ${contasML.length ? `<button class="btn ${plataforma==='ml'?'btn-primary':'btn-secondary'}" onclick="window._afilPlat('ml')" style="display:flex;align-items:center;gap:6px;">
          🟡 Mercado Livre <span style="opacity:.7;font-size:11px;">(${contasML.length} conta${contasML.length>1?'s':''})</span>
        </button>` : ''}
      </div>

      <!-- Área de conteúdo -->
      <div id="afil-content">
        <div style="text-align:center;padding:60px;color:var(--text-muted);">
          Clique em <strong>🔄 Buscar dados</strong> para carregar os dados de afiliados.
        </div>
      </div>
    </div>`;

    // Handlers globais
    window._afilClienteChange = (id) => {
      clienteSelecionado = parseInt(id);
      _dadosCache = {};
      renderShell();
    };
    window._afilPlat = (p) => {
      plataforma = p;
      renderShell();
      if (_dadosCache[p]) renderDados(_dadosCache[p]);
    };
    window._afilBuscar = () => buscarDados();

    // Se já tem cache, renderiza
    if (_dadosCache[plataforma]) renderDados(_dadosCache[plataforma]);
  }

  // ── Busca dados ───────────────────────────────────────────
  async function buscarDados() {
    if (_carregando) return;
    _carregando = true;
    const btn = document.getElementById('btn-buscar-afil');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Buscando...'; }
    const content = document.getElementById('afil-content');
    if (content) content.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-muted);">Carregando dados de afiliados…</div>`;

    try {
      if (plataforma === 'shopee') {
        const contas = contasDoCliente(clienteSelecionado, 'shopee');
        const resultados = [];

        for (const conta of contas) {
          const shopId = conta.param_to_use?.shopId || conta.external_id;
          const tag    = conta.tags?.[0]?.name || '';
          const nicks  = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();
          const nome   = nicks[conta.external_id] || tag || conta.nickname || String(conta.external_id);

          // Shopee AMS — tenta múltiplos endpoints e formatos de data
          let perf = {}, openCamp = [], afilPerf = [], convReport = [], debug = [];
          const startDate = dataInicio.replaceAll('-',''); // YYYYMMDD
          const endDate   = dataFim.replaceAll('-','');

          // Helper para testar endpoint e registrar resultado
          const tryAMS = async (action, params) => {
            try {
              const r = await MarketplaceAPI.call(action, params);
              const raw = r?.data?.response || r?.data?.data || r?.data || r || {};
              debug.push({ action, ok: true, raw });
              return raw;
            } catch(e) {
              debug.push({ action, ok: false, erro: e.message });
              return null;
            }
          };

          // 1. Performance geral da loja
          const shopPerf = await tryAMS('shopee_ams_shop_performance', { shopId, start_date: startDate, end_date: endDate });
          if (shopPerf && typeof shopPerf === 'object' && !Array.isArray(shopPerf)) {
            perf = shopPerf;
          }

          // 2. Campanhas open
          const openR = await tryAMS('shopee_ams_open_campaign_performance', { shopId, start_date: startDate, end_date: endDate });
          openCamp = openR?.campaign_performance_list || (Array.isArray(openR) ? openR : []);

          // 3. Performance por afiliado
          const afilR = await tryAMS('shopee_ams_affiliate_performance', { shopId, start_date: startDate, end_date: endDate });
          afilPerf = afilR?.affiliate_performance_list || (Array.isArray(afilR) ? afilR : []);

          // 4. Relatório de conversão
          const convR = await tryAMS('shopee_ams_conversion_report', { shopId, start_date: startDate, end_date: endDate });
          convReport = Array.isArray(convR) ? convR : (convR?.list || []);

          // Log de debug no console
          console.log(`[AFIL Shopee ${nome}]`, debug);

          resultados.push({ conta: nome, shopId, perf, openCamp, afilPerf, convReport, debug });
        }

        _dadosCache['shopee'] = { plat: 'shopee', resultados };
        renderDados(_dadosCache['shopee']);

      } else if (plataforma === 'ml') {
        const contas = contasDoCliente(clienteSelecionado, 'ml');
        const resultados = [];

        for (const conta of contas) {
          const meliUserId = conta.param_to_use?.meliUserId || conta.external_id;
          const nicks  = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();
          const tag    = conta.tags?.[0]?.name || '';
          const nome   = nicks[conta.external_id] || tag || conta.nickname || String(conta.external_id);

          // ML Afiliados — tenta buscar via ml_exclusion_list (programa de afiliados)
          // A API do ML para afiliados usa endpoints de publisher, não disponível via MCP padrão
          let afil = {};
          const acoesML = [
            { action: 'ml_affiliate_report',      params: { meliUserId, date_from: dataInicio, date_to: dataFim } },
            { action: 'ml_affiliate_performance', params: { meliUserId, date_from: dataInicio, date_to: dataFim } },
          ];
          for (const { action, params } of acoesML) {
            try {
              const r = await MarketplaceAPI.call(action, params);
              if (r?.data) { afil = r.data; break; }
            } catch(e) {
              console.warn(`[AFIL ML ${action}]`, e.message);
              afil = { _semSuporteAPI: true };
            }
          }

          resultados.push({ conta: nome, meliUserId, afil });
        }

        _dadosCache['ml'] = { plat: 'ml', resultados };
        renderDados(_dadosCache['ml']);
      }
    } catch(e) {
      const content = document.getElementById('afil-content');
      if (content) content.innerHTML = `<div style="text-align:center;padding:40px;color:var(--red);">Erro ao buscar dados: ${e.message}</div>`;
    } finally {
      _carregando = false;
      const btn = document.getElementById('btn-buscar-afil');
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Buscar dados'; }
    }
  }

  // ── Renderiza dados Shopee ────────────────────────────────
  function renderShopee(resultados) {
    // Agrega totais
    let totalComissao = 0, totalPedidos = 0, totalReceita = 0, totalAfiliados = 0;

    resultados.forEach(r => {
      totalComissao  += parseFloat(r.perf.total_commission  || r.perf.commission_paid       || 0);
      totalPedidos   += parseInt(r.perf.total_orders        || r.perf.orders                || 0);
      totalReceita   += parseFloat(r.perf.total_gmv         || r.perf.revenue               || 0);
      totalAfiliados += parseInt(r.perf.total_affiliators   || r.perf.affiliate_count       || 0);
    });

    const roasAfil = totalComissao > 0 ? (totalReceita / totalComissao) : 0;

    return `
      <!-- KPIs -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px;">
        ${kpiAfil('Receita via Afiliados', 'R$ ' + fmtBRL(totalReceita), '#10b981', '💰')}
        ${kpiAfil('Comissão Paga', 'R$ ' + fmtBRL(totalComissao), '#f97316', '💸')}
        ${kpiAfil('Pedidos via Afiliados', fmtNum(totalPedidos), '#6366f1', '📦')}
        ${kpiAfil('Afiliadores Ativos', fmtNum(totalAfiliados), '#06b6d4', '👥')}
        ${kpiAfil('ROAS Afiliados', roasAfil > 0 ? roasAfil.toFixed(1) + 'x' : '—', '#8b5cf6', '📈')}
      </div>

      <!-- Por conta -->
      ${resultados.map(r => {
        const comissao  = parseFloat(r.perf.total_commission || r.perf.commission_paid || 0);
        const pedidos   = parseInt(r.perf.total_orders       || r.perf.orders          || 0);
        const receita   = parseFloat(r.perf.total_gmv        || r.perf.revenue         || 0);
        const afiliados = parseInt(r.perf.total_affiliators  || r.perf.affiliate_count || 0);
        const cliques   = parseInt(r.perf.total_clicks       || r.perf.clicks          || 0);
        const taxa      = comissao > 0 && receita > 0 ? (comissao / receita * 100) : 0;
        const temDados  = comissao > 0 || pedidos > 0 || receita > 0;

        return `
        <div class="card mb-16">
          <div class="section-header" style="margin-bottom:16px;">
            <div>
              <div class="section-title">🟠 ${r.conta}</div>
              <div style="font-size:11px;color:var(--text-muted);font-family:monospace;">Shop ID: ${r.shopId}</div>
            </div>
            ${!temDados ? `<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">Sem dados AMS</span>` : ''}
          </div>
          ${temDados ? `
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px;">
            ${metricaAfil('Receita', 'R$ ' + fmtBRL(receita), '#10b981')}
            ${metricaAfil('Comissão', 'R$ ' + fmtBRL(comissao), '#f97316')}
            ${metricaAfil('Pedidos', fmtNum(pedidos), '#6366f1')}
            ${metricaAfil('Afiliadores', fmtNum(afiliados), '#06b6d4')}
            ${metricaAfil('Cliques', fmtNum(cliques), '#8b5cf6')}
            ${metricaAfil('Taxa Comissão', taxa.toFixed(2) + '%', '#f59e0b')}
          </div>` : `
          <div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">
            Nenhum dado de afiliados encontrado para esta conta no período.<br>
            <span style="font-size:12px;">Verifique se o programa AMS está ativo na conta Shopee.</span>
          </div>
          ${r.debug?.length ? `<details style="margin-top:8px;font-size:11px;text-align:left;"><summary style="cursor:pointer;color:var(--text-muted);padding:8px;">🔍 Diagnóstico API</summary><div style="padding:8px 12px;background:var(--surface);border-radius:var(--radius-sm);margin-top:4px;">${r.debug.map(d=>`<div style="margin-bottom:6px;padding:6px;border-left:3px solid ${d.ok?'#10b981':'#ef4444'};"><div style="font-weight:600;color:${d.ok?'#10b981':'#ef4444'};">${d.ok?'✅':'❌'} ${d.action}</div><div style="color:var(--text-muted);font-family:monospace;font-size:10px;word-break:break-all;">${d.ok?JSON.stringify(d.raw).substring(0,300):d.erro}</div></div>`).join('')}</div></details>` : ''}`}

          ${r.afilPerf?.length > 0 ? `
          <div style="margin-top:12px;">
            <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-primary);">Top Afiliados</div>
            <table class="table" style="font-size:12px;">
              <thead><tr>
                <th>Afiliado</th>
                <th style="text-align:right;">Receita</th>
                <th style="text-align:right;">Comissão</th>
                <th style="text-align:right;">Pedidos</th>
                <th style="text-align:right;">Cliques</th>
              </tr></thead>
              <tbody>
              ${r.afilPerf.slice(0,10).map(a => `<tr>
                <td style="font-weight:500;">${a.affiliate_name || a.name || a.id || '—'}</td>
                <td style="text-align:right;color:var(--green);">R$ ${fmtBRL(a.gmv || a.revenue || 0)}</td>
                <td style="text-align:right;color:var(--red);">R$ ${fmtBRL(a.commission || 0)}</td>
                <td style="text-align:right;">${fmtNum(a.orders || 0)}</td>
                <td style="text-align:right;">${fmtNum(a.clicks || 0)}</td>
              </tr>`).join('')}
              </tbody>
            </table>
          </div>` : ''}

          ${r.openCamp.length > 0 ? `
          <div style="margin-top:12px;">
            <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-primary);">Campanhas Open</div>
            <table class="table" style="font-size:12px;">
              <thead><tr>
                <th>Campanha</th>
                <th style="text-align:right;">Receita</th>
                <th style="text-align:right;">Comissão</th>
                <th style="text-align:right;">Pedidos</th>
                <th style="text-align:right;">Taxa</th>
              </tr></thead>
              <tbody>
              ${r.openCamp.slice(0,10).map(c => {
                const cRec  = parseFloat(c.gmv || c.revenue || 0);
                const cCom  = parseFloat(c.commission || c.commission_paid || 0);
                const cPed  = parseInt(c.orders || 0);
                const cTaxa = cRec > 0 && cCom > 0 ? (cCom / cRec * 100).toFixed(1) : '—';
                return `<tr>
                  <td style="font-weight:500;">${c.campaign_name || c.name || '—'}</td>
                  <td style="text-align:right;color:var(--green);">R$ ${fmtBRL(cRec)}</td>
                  <td style="text-align:right;color:var(--red);">R$ ${fmtBRL(cCom)}</td>
                  <td style="text-align:right;">${fmtNum(cPed)}</td>
                  <td style="text-align:right;color:var(--text-muted);">${cTaxa}%</td>
                </tr>`;
              }).join('')}
              </tbody>
            </table>
          </div>` : ''}
        </div>`;
      }).join('')}
    `;
  }

  // ── Renderiza dados ML ────────────────────────────────────
  function renderML(resultados) {
    return resultados.map(r => {
      if (r.afil._semSuporteAPI || r.afil._erro) {
        return `
        <div class="card mb-16">
          <div class="section-header">
            <div class="section-title">🟡 ${r.conta}</div>
            <div style="font-size:11px;color:var(--text-muted);font-family:monospace;">User ID: ${r.meliUserId}</div>
          </div>
          <div style="padding:32px;text-align:center;">
            <div style="font-size:32px;margin-bottom:12px;">🔗</div>
            <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">API de Afiliados ML não disponível</div>
            <div style="font-size:13px;color:var(--text-muted);max-width:420px;margin:0 auto;">
              O Mercado Livre não expõe dados de afiliados (Publishers) via API pública.<br>
              Acesse o painel de afiliados diretamente em <strong>afiliados.mercadolivre.com.br</strong> para ver comissões e performance.
            </div>
          </div>
        </div>`;
      }

      const comissao = parseFloat(r.afil.total_commission || r.afil.commission || 0);
      const receita  = parseFloat(r.afil.total_amount     || r.afil.revenue    || 0);
      const pedidos  = parseInt(r.afil.total_orders       || r.afil.orders     || 0);
      const cliques  = parseInt(r.afil.total_clicks       || r.afil.clicks     || 0);
      const afiliados= parseInt(r.afil.total_affiliates   || 0);
      const taxa     = receita > 0 && comissao > 0 ? (comissao / receita * 100) : 0;
      const temDados = comissao > 0 || pedidos > 0 || receita > 0;

      return `
      <div class="card mb-16">
        <div class="section-header" style="margin-bottom:16px;">
          <div>
            <div class="section-title">🟡 ${r.conta}</div>
            <div style="font-size:11px;color:var(--text-muted);font-family:monospace;">User ID: ${r.meliUserId}</div>
          </div>
          ${!temDados ? `<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">Sem dados de afiliados</span>` : ''}
        </div>
        ${temDados ? `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;">
          ${metricaAfil('Receita', 'R$ ' + fmtBRL(receita), '#10b981')}
          ${metricaAfil('Comissão Paga', 'R$ ' + fmtBRL(comissao), '#f97316')}
          ${metricaAfil('Pedidos', fmtNum(pedidos), '#6366f1')}
          ${metricaAfil('Afiliados Ativos', fmtNum(afiliados), '#06b6d4')}
          ${metricaAfil('Cliques', fmtNum(cliques), '#8b5cf6')}
          ${metricaAfil('Taxa Comissão', taxa.toFixed(2) + '%', '#f59e0b')}
        </div>` : `
        <div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">
          Nenhum dado de afiliados encontrado no período.<br>
          <span style="font-size:12px;">Verifique se o programa de afiliados está ativo nesta conta.</span>
        </div>`}

        ${r.afil.publishers?.length > 0 ? `
        <div style="margin-top:16px;">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Top Afiliados</div>
          <table class="table" style="font-size:12px;">
            <thead><tr><th>Afiliado</th><th style="text-align:right;">Receita</th><th style="text-align:right;">Comissão</th><th style="text-align:right;">Pedidos</th></tr></thead>
            <tbody>
            ${r.afil.publishers.slice(0,10).map(p => `<tr>
              <td>${p.name || p.publisher_name || p.id || '—'}</td>
              <td style="text-align:right;color:var(--green);">R$ ${fmtBRL(p.revenue || p.amount || 0)}</td>
              <td style="text-align:right;color:var(--red);">R$ ${fmtBRL(p.commission || 0)}</td>
              <td style="text-align:right;">${fmtNum(p.orders || p.order_count || 0)}</td>
            </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
      </div>`;
    }).join('');
  }

  // ── Renderiza dados (dispatch por plataforma) ─────────────
  function renderDados(dados) {
    const content = document.getElementById('afil-content');
    if (!content) return;
    if (dados.plat === 'shopee') {
      content.innerHTML = renderShopee(dados.resultados);
    } else if (dados.plat === 'ml') {
      content.innerHTML = `<div>${renderML(dados.resultados)}</div>`;
    }
  }

  // ── Helpers visuais ───────────────────────────────────────
  function kpiAfil(label, valor, cor, icon) {
    return `<div class="kpi-card">
      <div class="kpi-icon" style="background:${cor}22;"><span style="font-size:18px;">${icon}</span></div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value" style="font-size:18px;">${valor}</div>
    </div>`;
  }

  function metricaAfil(label, valor, cor) {
    return `<div style="padding:12px 16px;background:var(--surface);border-radius:var(--radius-sm);border:1px solid var(--border);">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${label}</div>
      <div style="font-size:16px;font-weight:700;color:${cor};">${valor}</div>
    </div>`;
  }

  // ── Inicia ────────────────────────────────────────────────
  renderShell();
});
