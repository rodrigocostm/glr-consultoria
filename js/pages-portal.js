// ============================================================
// GLR — Portal do Cliente (Dashboard | Vendas | Curva ABC)
// ============================================================

const _PORTAL_CFG_KEY = 'glr_portal_configs';

// ── Utilitários ───────────────────────────────────────────────
const _pR$ = v => 'R$ ' + (parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const _pN  = (v,d=0) => (parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d});
const _pPad = n => String(n).padStart(2,'0');
const _pCorMargem = m => m >= 15 ? '#16a34a' : m >= 5 ? '#d97706' : '#dc2626';

// Cache próprio do portal (por acesso de cliente) — populado pela busca real na API,
// scoped somente às contas vinculadas a esse cliente
const PORTAL_CACHE_VERSION = 10; // incrementar invalida cache de todos os clientes
function _portalCacheKey() {
  const cfg = window._portalConfig;
  return cfg ? `glr_portal_vendas_v${PORTAL_CACHE_VERSION}_${cfg.id || cfg.email}` : null;
}

function _portalCache() {
  const key = _portalCacheKey();
  if (!key) return null;
  try { return JSON.parse(localStorage.getItem(key)||'null'); } catch(e) { return null; }
}

function _portalFinCache() {
  try { return JSON.parse(localStorage.getItem('glr_fin_cache')||'null'); } catch(e) { return null; }
}

// Busca custo/imposto/linhas extras lançados no admin (página Vendas) direto do Supabase —
// o portal do cliente não roda o sync geral do admin (isolamento de segurança), então
// precisa puxar essas chaves especificamente pra calcular o mesmo lucro que o admin vê.
async function _portalSincronizarCustos() {
  try {
    const { data, error } = await _sb.from('glr_storage')
      .select('chave, dados')
      .in('chave', ['glr_vendas_custos', 'glr_aliquotas', 'glr_vendas_linhas']);
    if (error || !data) return;
    data.forEach(row => { if (row.dados != null) localStorage.setItem(row.chave, JSON.stringify(row.dados)); });
  } catch(e) {}
}

function _portalCustos() {
  try { return JSON.parse(localStorage.getItem('glr_vendas_custos')||'{}'); } catch(e) { return {}; }
}

function _portalAliquotas() {
  try { return JSON.parse(localStorage.getItem('glr_aliquotas')||'{}'); } catch(e) { return {}; }
}

function _portalLinhasExtras() {
  try { return JSON.parse(localStorage.getItem('glr_vendas_linhas')||'[]'); } catch(e) { return []; }
}

// ── Contas selecionadas (filtro multi-select) — Set vazio = todas ──
function _portalContasSelecionadas() {
  try {
    const raw = JSON.parse(localStorage.getItem('glr_portal_contas_sel')||'[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch { return new Set(); }
}
window._portalSetContasSelecionadas = function(novoSet) {
  localStorage.setItem('glr_portal_contas_sel', JSON.stringify([...novoSet]));
  if (typeof Router !== 'undefined' && Router.resolve) Router.resolve();
};

// ── Filtro de data (compartilhado entre as páginas do portal) ─
function _portalFiltroDefault() {
  const hoje = new Date();
  const ate  = hoje.toISOString().slice(0,10);
  const d30  = new Date(hoje); d30.setDate(d30.getDate()-29);
  const de   = d30.toISOString().slice(0,10);
  return { de, ate };
}

function _portalFiltroData() {
  try {
    const f = JSON.parse(localStorage.getItem('glr_portal_filtro_data')||'null');
    if (f && f.de && f.ate) return f;
  } catch {}
  return _portalFiltroDefault();
}

// Verifica se o período pedido já está totalmente coberto pelo cache atual —
// se estiver, não precisa chamar a API de novo, só filtrar localmente (instantâneo)
function _portalRangeCoberto(de, ate) {
  const cache = _portalCache();
  if (!cache?.pedidos || cache.erro) return false;
  if (!cache.dataFrom || !cache.dataTo) return false;
  return cache.dataFrom <= de && cache.dataTo >= ate;
}

const _portalAddDia = iso => { const [y,m,d] = iso.split('-').map(Number); return new Date(Date.UTC(y,m-1,d+1)).toISOString().slice(0,10); };
const _portalSubDia = iso => { const [y,m,d] = iso.split('-').map(Number); return new Date(Date.UTC(y,m-1,d-1)).toISOString().slice(0,10); };

// Retorna só os pedaços de [de,ate] que NÃO estão cobertos pelo cache — evita
// re-buscar meses já baixados só porque o usuário pediu uma data fora do range
function _portalSegmentosFaltantes(de, ate) {
  const cache = _portalCache();
  if (!cache?.pedidos || cache.erro || !cache.dataFrom || !cache.dataTo) return [{ de, ate }];
  const segs = [];
  if (de < cache.dataFrom) {
    const antesAte = _portalSubDia(cache.dataFrom);
    if (de <= antesAte) segs.push({ de, ate: antesAte });
  }
  if (ate > cache.dataTo) {
    const depoisDe = _portalAddDia(cache.dataTo);
    if (depoisDe <= ate) segs.push({ de: depoisDe, ate });
  }
  return segs;
}

window._portalAplicarFiltro = async function(de, ate, forcar = false) {
  localStorage.setItem('glr_portal_filtro_data', JSON.stringify({ de, ate }));
  if (!forcar && _portalRangeCoberto(de, ate)) {
    // Já temos esses dados em cache — filtra na hora, sem chamar a API
    if (typeof Router !== 'undefined' && Router.resolve) Router.resolve();
    return;
  }
  // Busca só o que falta (antes e/ou depois do que já está em cache) — nunca
  // refaz a busca de um período que já tínhamos só porque a data pedida é mais ampla
  const segmentos = forcar ? [{ de, ate }] : _portalSegmentosFaltantes(de, ate);
  for (const seg of segmentos) {
    await _portalBuscarVendas(seg.de, seg.ate, true); // incremental: mescla pedidos por id, sem duplicar
  }
  if (typeof Router !== 'undefined' && Router.resolve) Router.resolve();
};

window._portalFiltroRapido = function(dias) {
  const hoje = new Date();
  const ate = hoje.toISOString().slice(0,10);
  let de;
  if (dias === 'mes') {
    de = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0,10);
  } else if (dias === 'tudo') {
    de = '2020-01-01';
  } else {
    const d = new Date(hoje); d.setDate(d.getDate()-(dias-1));
    de = d.toISOString().slice(0,10);
  }
  window._portalAplicarFiltro(de, ate);
};

function _portalFiltroBar(pageAtual) {
  const f = _portalFiltroData();
  const cache = _portalCache();
  const contasSel = _portalContasSelecionadas();

  // Seletor de contas (checkbox multi-select) — só aparece se há mais de uma conta
  const contas = cache?.contasInfo || [];
  const qtdSel = contasSel.size;
  const contaEscolhida = qtdSel === 1 ? contas.find(c=>contasSel.has(c.id))?.nome : null;
  const textoBotaoConta = qtdSel === 0 ? 'Todas as contas' : contaEscolhida || `${qtdSel} contas selecionadas`;
  const seletorContas = contas.length > 1 ? `
    <div style="position:relative;">
      <button type="button" onclick="event.stopPropagation();const p=this.nextElementSibling;document.querySelectorAll('.pf-conta-panel').forEach(x=>{if(x!==p)x.style.display='none'});p.style.display=p.style.display==='none'?'block':'none';"
        style="font-size:11px;border-radius:8px;padding:7px 12px;cursor:pointer;border:1px solid var(--border);background:var(--bg-base);color:var(--text-primary);display:flex;align-items:center;gap:6px;">
        🏬 ${textoBotaoConta} <span style="font-size:9px;opacity:0.6;">▾</span>
      </button>
      <div class="pf-conta-panel" onclick="event.stopPropagation()" style="display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:50;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.25);min-width:200px;padding:6px;">
        ${contas.map(c => `
          <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--text-primary);">
            <input type="checkbox" value="${c.id}" ${contasSel.has(c.id)?'checked':''}
              onchange="const s=_portalContasSelecionadas(); this.checked?s.add('${c.id}'):s.delete('${c.id}'); window._portalSetContasSelecionadas(s);"
              style="width:14px;height:14px;accent-color:#6366f1;">
            ${c.marketplace?.includes('shopee')?'🟠':'🟡'} ${c.nome}
          </label>`).join('')}
        <div style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px;">
          <button type="button" onclick="window._portalSetContasSelecionadas(new Set())" style="width:100%;font-size:11px;padding:5px;background:var(--bg-card-hover);border:none;border-radius:5px;color:var(--text-secondary);cursor:pointer;">Limpar (todas)</button>
        </div>
      </div>
    </div>` : '';
  const erroShopee = (cache?.resumoContas||[]).find(r => r.erro)?.erro;
  const avisoErro = erroShopee
    ? `<div style="width:100%;margin-top:8px;padding:8px 12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:8px;font-size:11px;color:#ef4444;">⚠️ Shopee: ${erroShopee}</div>`
    : '';

  const diagML = window._diagMlP0 || '';
  const diagTotal = window._diagMlTotal || '';
  const diagCache = window._diagCacheSaved || '';
  const status = cache?.at
    ? `<span style="font-size:11px;color:var(--text-secondary);">Atualizado às ${new Date(cache.at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})} | ${cache.pedidos?.length||0} pedidos no cache</span>`
    : `<span style="font-size:11px;color:#d97706;">⚠️ Clique em Aplicar para buscar os dados</span>`;
  const diagLines = [diagTotal&&`[TOTAL] ${diagTotal}`, diagCache&&`[CACHE] ${diagCache}`, diagML&&`[ML P0] ${diagML}`].filter(Boolean).join('<br>');
  const diagBanner = diagLines ? `<div style="width:100%;margin-top:8px;padding:6px 10px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:6px;font-size:10px;color:#a5b4fc;word-break:break-all;">${diagLines}</div>` : '';

  return `
    <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span style="font-size:12px;font-weight:700;color:var(--text-secondary);">📅 Período:</span>
      <input type="date" id="pf-de" value="${f.de}" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-primary);font-size:12px;">
      <span style="color:var(--text-secondary);font-size:12px;">até</span>
      <input type="date" id="pf-ate" value="${f.ate}" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-primary);font-size:12px;">
      <button id="pf-btn-aplicar" onclick="window._portalAplicarFiltroUI()"
        style="background:var(--primary);color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;">Aplicar</button>
      ${status}
      <div style="display:flex;gap:6px;margin-left:auto;flex-wrap:wrap;">
        <button onclick="window._portalFiltroRapido(7)" style="font-size:11px;background:var(--bg-base);border:1px solid var(--border);border-radius:99px;padding:5px 12px;cursor:pointer;color:var(--text-secondary);">7 dias</button>
        <button onclick="window._portalFiltroRapido(30)" style="font-size:11px;background:var(--bg-base);border:1px solid var(--border);border-radius:99px;padding:5px 12px;cursor:pointer;color:var(--text-secondary);">30 dias</button>
        <button onclick="window._portalFiltroRapido('mes')" style="font-size:11px;background:var(--bg-base);border:1px solid var(--border);border-radius:99px;padding:5px 12px;cursor:pointer;color:var(--text-secondary);">Mês atual</button>
        <button onclick="window._portalFiltroRapido('tudo')" style="font-size:11px;background:var(--bg-base);border:1px solid var(--border);border-radius:99px;padding:5px 12px;cursor:pointer;color:var(--text-secondary);">Tudo</button>
      </div>
      ${seletorContas}
      ${avisoErro}
      ${diagBanner}
    </div>`;
}

// Fecha o dropdown de contas ao clicar fora — registra só uma vez
if (!window._portalContaPanelCloseListener) {
  window._portalContaPanelCloseListener = true;
  document.addEventListener('click', () => {
    document.querySelectorAll('.pf-conta-panel').forEach(p => p.style.display = 'none');
  });
}

window._portalAplicarFiltroUI = function() {
  const btn = document.getElementById('pf-btn-aplicar');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Buscando...'; }
  window._portalAplicarFiltro(document.getElementById('pf-de').value, document.getElementById('pf-ate').value);
};

// Chama o proxy serverless /api/mcp — API key fica no servidor, nunca no browser do cliente
// Timeout garante que uma chamada travada não trava a busca inteira para sempre
async function _portalMcCall(action, params = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(()=>({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    return await resp.json();
  } catch(e) {
    if (e.name === 'AbortError') throw new Error(`Timeout (${timeoutMs}ms) em ${action}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Executa promessas com concorrência limitada — evita disparar centenas de
// requisições simultâneas (183 pedidos × 3 chamadas = ~550 fetches travava tudo)
async function _portalMapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); } catch(e) { results[i] = undefined; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ML paginado via proxy — lógica idêntica ao MarketplaceAPI.mlOrders do admin
async function _portalMlOrders(meliId, dataFrom, dataTo) {
  const PAGE = 50;
  let offset = 0, all = [], pagingTotal = null;
  do {
    let r = null;
    for (let t = 0; t < 3; t++) {
      try {
        r = await _portalMcCall('list_orders_detail', { meliUserId: meliId, date_from: dataFrom, date_to: dataTo, limit: PAGE, offset });
        break;
      } catch(e) { if (t >= 2) break; await new Promise(res=>setTimeout(res, 1500*(t+1))); }
    }
    if (!r) break;
    const results = r.data?.results || [];
    const paging  = r.data?.paging  || {};
    if (offset === 0) {
      if (paging.total > 0) pagingTotal = paging.total;
      window._diagMlP0 = `meliId=${meliId} de=${dataFrom} ate=${dataTo} | p0=${results.length} | paging.total=${paging.total??'?'} | resp=${JSON.stringify(r).slice(0,200)}`;
    }
    all = all.concat(results);
    if (results.length < PAGE) break;
    if (pagingTotal !== null && all.length >= pagingTotal) break;
    offset += PAGE;
  } while (true);
  window._diagMlTotal = `total=${all.length} pedidos ML | paging.total=${pagingTotal??'?'}`;
  return all;
}

// Shopee: lista SNs paginado via proxy
// Retorna { sns, erro, diagRaw }
async function _portalShopeeSns(shopId, tsFrom, tsTo) {
  const STATUSES = ['COMPLETED','READY_TO_SHIP','RETRY_SHIP','SHIPPED','TO_CONFIRM_RECEIVE',
    'PROCESSED','INVOICE_PENDING','CANCELLED','IN_CANCEL','TO_RETURN','UNPAID'];
  const CHUNK = 14 * 24 * 3600;
  const sid = isNaN(Number(shopId)) ? shopId : Number(shopId);
  const out = [];
  const seen = new Set();
  let primeiroErro = null;
  let primeiraResposta = null;

  // Estratégia 1: com order_status
  for (let cFrom = tsFrom; cFrom < tsTo; cFrom += CHUNK) {
    const cTo = Math.min(cFrom + CHUNK - 1, tsTo);
    for (const st of STATUSES) {
      let cursor = '';
      do {
        const params = { shopId: sid, time_range_field:'create_time', time_from:cFrom, time_to:cTo, page_size:100, order_status:st };
        if (cursor) params.cursor = cursor;
        let r;
        try { r = await _portalMcCall('shopee_list_orders', params); }
        catch(e) { if (!primeiroErro) primeiroErro = e.message; break; }
        if (!primeiraResposta) primeiraResposta = JSON.stringify(r).slice(0,300);
        const apiErr = r?.error || r?.message || r?.error_msg;
        if (apiErr && !r?.data?.response?.order_list) {
          if (!primeiroErro) primeiroErro = `${apiErr}`;
          break;
        }
        const resp = r?.data?.response || {};
        const orders = resp.order_list || [];
        for (const o of orders) {
          if (!seen.has(o.order_sn)) { seen.add(o.order_sn); out.push({ sn: o.order_sn }); }
        }
        cursor = resp.more ? (resp.next_cursor || '') : '';
      } while (cursor);
    }
  }

  // Estratégia 2: sem order_status (apenas 1 chunk para diagnóstico se vazio)
  if (out.length === 0 && !primeiroErro) {
    const cTo = Math.min(tsFrom + CHUNK - 1, tsTo);
    let r;
    try {
      r = await _portalMcCall('shopee_list_orders', { shopId: sid, time_range_field:'create_time', time_from:tsFrom, time_to:cTo, page_size:50 });
      if (!primeiraResposta) primeiraResposta = JSON.stringify(r).slice(0,300);
      const resp = r?.data?.response || {};
      const orders = resp.order_list || [];
      for (const o of orders) {
        if (!seen.has(o.order_sn)) { seen.add(o.order_sn); out.push({ sn: o.order_sn }); }
      }
      // Se ainda vazio, tenta todos os chunks
      if (out.length === 0) {
        for (let cFrom = tsFrom + CHUNK; cFrom < tsTo; cFrom += CHUNK) {
          const cTo2 = Math.min(cFrom + CHUNK - 1, tsTo);
          try {
            const r2 = await _portalMcCall('shopee_list_orders', { shopId: sid, time_range_field:'create_time', time_from:cFrom, time_to:cTo2, page_size:50 });
            const orders2 = r2?.data?.response?.order_list || [];
            for (const o of orders2) {
              if (!seen.has(o.order_sn)) { seen.add(o.order_sn); out.push({ sn: o.order_sn }); }
            }
          } catch(e) {}
        }
      }
    } catch(e) {}
  }

  const erroFinal = primeiroErro || (out.length === 0 ? `0 pedidos Shopee (shopId=${sid}). Resp: ${primeiraResposta||'sem resposta'}` : null);
  return { sns: out, erro: erroFinal };
}

// ── Busca real na API (ML + Shopee), via proxy — API key nunca chega ao browser do cliente ──
// incremental=true: mescla novos pedidos ao cache existente (não substitui tudo)
// incremental=false: substitui o cache completamente (full refresh)
async function _portalBuscarVendas(dataFrom, dataTo, incremental = false) {
  const cfg = window._portalConfig;
  const cacheKey = _portalCacheKey();
  if (!cfg || !cacheKey) return;

  try {
    const contasResp = await _portalMcCall('list_accounts', {});
    const ids = (cfg.contaIds||[]).map(String);
    const todasContas = contasResp.data?.accounts || contasResp.data || [];
    if (!Array.isArray(todasContas) || todasContas.length === 0) {
      throw new Error(`Nenhuma conta retornada pela API (list_accounts). Resp: ${JSON.stringify(contasResp).slice(0,200)}`);
    }
    const contas = todasContas.filter(c => ids.includes(String(c.external_id)));
    if (contas.length === 0) {
      const idsDisp = todasContas.map(c=>c.external_id).join(', ');
      throw new Error(`Contas do portal [${ids.join(', ')}] não encontradas na API. Disponíveis: [${idsDisp}]`);
    }
    // Salva info de diagnóstico para exibir na UI
    window._portalDiagContas = contas.map(c=>`${c.external_id}→"${c.marketplace}"`).join(' | ');

    const novosPedidos = [];
    const resumoContas = [];
    const pendenciasTaxasML = []; // { mlPedidos, meliId } — enriquecidas em segundo plano depois do render
    const contasInfo = contas.map(c => {
      const mp = (c.marketplace||'').toLowerCase();
      const nomeBase = mp.includes('shopee') ? 'Shopee' : 'Mercado Livre';
      return {
        id: String(c.external_id),
        nome: nomeBase, // usa sempre o nome do marketplace — o nickname do MCP já contém o ID
        marketplace: mp,
      };
    });

    for (const conta of contas) {
      const mpLower = (conta.marketplace||'').toLowerCase();
      // ── Mercado Livre ──
      if (!mpLower.includes('shopee')) {
        const meliId = conta.param_to_use?.meliUserId || conta.external_id;
        const orders = await _portalMlOrders(meliId, dataFrom, dataTo);

        const mlPedidos = orders.map(o => {
          const itens = (o.order_items||o.items||[]).map(i => ({
            nome: i.item?.title || '—', qtd: i.quantity||1,
            preco: parseFloat(i.unit_price)||0, imagem: '',
            itemId: i.item?.id || '',
          }));
          const totalAmount = parseFloat(o.total_amount)||0;
          const comissaoML = itens.reduce((s,i) => s+((parseFloat(i.sale_fee)||0)*(i.qtd||1)), 0);
          return {
            id: String(o.id), plataforma:'Mercado Livre', contaId: conta.external_id,
            data: o.date_created ? new Date(o.date_created).toLocaleDateString('pt-BR') : '—',
            dataTs: new Date(o.date_created||0).getTime(),
            produto: itens[0]?.nome||'—', imagem:'',
            qtd: itens.reduce((s,i)=>s+i.qtd,0)||1,
            valor: totalAmount, status: o.status||'',
            paymentId: o.payments?.[0]?.id||null, shippingId: o.shipping?.id||null,
            itens,
            taxas: { liquido:null, comissao:comissaoML, taxaServico:0, imposto:0, frete:null, voucher:0 },
          };
        });

        const itemIdsUnicos = [...new Set(mlPedidos.flatMap(p=>p.itens.map(i=>i.itemId)).filter(Boolean))];
        const thumbMap = {};
        const CONCURRENCY = 8;

        // Bloqueante: só as imagens dos produtos (poucas dezenas de chamadas) —
        // essencial pra UI não ficar sem foto. Líquido/frete (183+183 chamadas)
        // vão pro background depois do render, senão a busca demora minutos.
        await _portalMapLimit(itemIdsUnicos, CONCURRENCY, async itemId => {
          try {
            const r = await _portalMcCall('get_item', { itemId, meliUserId: meliId });
            const thumb = r.data?.thumbnail || r.data?.pictures?.[0]?.secure_url || r.data?.pictures?.[0]?.url || '';
            if (thumb) thumbMap[itemId] = thumb;
          } catch(e) {}
        });

        for (const p of mlPedidos) {
          const firstItemId = p.itens[0]?.itemId;
          if (firstItemId && thumbMap[firstItemId]) {
            p.imagem = thumbMap[firstItemId];
            p.itens.forEach(i => { i.imagem = thumbMap[i.itemId] || ''; });
          }
          // Estimativa até o valor preciso chegar via enriquecimento em background
          if (p.taxas.comissao > 0) p.taxas.liquido = p.valor - p.taxas.comissao;
        }
        novosPedidos.push(...mlPedidos);
        resumoContas.push({ mp:'Mercado Livre', qtd: mlPedidos.length });
        pendenciasTaxasML.push({ mlPedidos, meliId, concorrencia: CONCURRENCY });
      }

      // ── Shopee ──
      if (mpLower.includes('shopee')) {
        const shopId = conta.param_to_use?.shopId || conta.external_id;
        const tsFrom = Math.floor(new Date(`${dataFrom}T00:00:00`).getTime()/1000);
        const tsTo   = Math.floor(new Date(`${dataTo}T23:59:59`).getTime()/1000);
        const { sns, erro: shopeeErro } = await _portalShopeeSns(shopId, tsFrom, tsTo);
        if (shopeeErro) resumoContas.push({ mp:'Shopee', qtd: 0, erro: shopeeErro });

        const uniq = [], detMap = {};
        for (let i=0; i<sns.length; i+=50) {
          const lote = sns.slice(i,i+50).map(o=>o.sn);
          try {
            const rd = await _portalMcCall('shopee_get_order_detail', { shopId, order_sn_list: lote });
            const lista = rd.data?.response?.order_list || [];
            for (const ord of lista) {
              const itens = (ord.item_list||[]).map(it => ({
                nome: it.item_name||'—', qtd: it.model_quantity_purchased||1,
                preco: parseFloat(it.model_discounted_price)||0, imagem: it.image_info?.image_url||'',
              }));
              detMap[ord.order_sn] = { itens, imagem: itens[0]?.imagem||'', produto: itens.length>1?`${itens[0].nome} (+${itens.length-1})`:(itens[0]?.nome||'—') };
              const dt = ord.create_time ? new Date(ord.create_time*1000) : null;
              const totalPedido = parseFloat(ord.total_amount)||0;
              const subtotal = itens.reduce((s,it)=>s+it.preco*it.qtd,0);
              uniq.push({
                id: ord.order_sn, plataforma:'Shopee', contaId: conta.external_id,
                data: dt ? dt.toLocaleDateString('pt-BR') : '—', dataTs: (ord.create_time||0)*1000,
                produto:'…', imagem:'', qtd: itens.reduce((s,it)=>s+it.qtd,0)||1,
                valor: subtotal>0 ? subtotal : totalPedido, status: ord.order_status||'', itens:[], taxas:{},
              });
            }
          } catch(e) {}
        }

        const escrowMap = {};
        const parseEscrow = oi => {
          const n = v => parseFloat(v)||0;
          const freteVendedor = Math.max(0, n(oi.actual_shipping_fee)-n(oi.buyer_paid_shipping_fee)-n(oi.shopee_shipping_rebate));
          return {
            liquido: n(oi.escrow_amount), comissao: n(oi.commission_fee), taxaServico: n(oi.service_fee),
            imposto: n(oi.seller_transaction_fee)+n(oi.buyer_tax_amount)+n(oi.seller_coin_cash_back),
            frete: freteVendedor+n(oi.shipping_seller_protection_fee_amount), voucher: n(oi.voucher_from_shopee),
          };
        };
        for (let i=0; i<uniq.length; i+=50) {
          const snsLote = uniq.slice(i,i+50).map(o=>o.id);
          try {
            const re = await _portalMcCall('shopee_get_escrow_detail_batch', { shopId, order_sn_list: snsLote });
            const lista = re.data?.response || re.data?.result_list || [];
            lista.forEach((item, idx) => {
              const oi = item.escrow_detail?.order_income || item.order_income || {};
              const sn = snsLote[idx];
              if (sn) escrowMap[sn] = parseEscrow(oi);
            });
          } catch(e) {}
        }

        for (const o of uniq) {
          const d = detMap[o.id]||{};
          o.produto = d.produto||o.id; o.imagem = d.imagem||''; o.itens = d.itens||[];
          o.taxas = escrowMap[o.id]||null;
          novosPedidos.push(o);
        }
        resumoContas.push({ mp:'Shopee', qtd: uniq.length });
      }
    }

    // ── ADS: busca investimento para o período ──
    let adsTotal = 0;
    const toShopeeDate = iso => iso.split('-').reverse().join('-');
    const addDaysIso = (iso, n) => { const [y,m,d] = iso.split('-').map(Number); return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10); };

    for (const conta of contas) {
      try {
        if (!conta.marketplace?.toLowerCase().includes('shopee')) {
          const meliId = conta.param_to_use?.meliUserId || conta.external_id;
          let custo = 0, off = 0;
          while (true) {
            const ra = await _portalMcCall('ml_ads_campaigns', { meliUserId: meliId, date_from: dataFrom, date_to: dataTo, limit: 50, offset: off });
            const res = ra.data?.results || [];
            custo += res.reduce((s,c) => s + (parseFloat(c.metrics?.cost)||0), 0);
            if (res.length < 50) break;
            off += 50;
          }
          adsTotal += custo;
        }
        if (conta.marketplace?.toLowerCase().includes('shopee')) {
          const shopId = conta.param_to_use?.shopId || conta.external_id;
          let cur = dataFrom;
          while (cur <= dataTo) {
            const chunkEnd = addDaysIso(cur, 29) > dataTo ? dataTo : addDaysIso(cur, 29);
            try {
              const r = await _portalMcCall('shopee_ads_daily_performance', { shopId, start_date: toShopeeDate(cur), end_date: toShopeeDate(chunkEnd) });
              const dias = r?.data?.response || [];
              if (Array.isArray(dias)) adsTotal += dias.reduce((s,d) => s + (parseFloat(d.expense)||0), 0);
            } catch(e) {}
            cur = addDaysIso(chunkEnd, 1);
          }
        }
      } catch(e) {}
    }

    // Merge incremental ou substituição completa
    let pedidosFinal;
    const cacheAtual = _portalCache();
    if (incremental && cacheAtual?.pedidos) {
      // Atualiza pedidos existentes + adiciona novos, sem apagar os que ficaram fora do range
      const mapaExistente = {};
      cacheAtual.pedidos.forEach(p => { mapaExistente[p.id] = p; });
      novosPedidos.forEach(p => { mapaExistente[p.id] = p; }); // sobrescreve/adiciona
      pedidosFinal = Object.values(mapaExistente);
    } else {
      pedidosFinal = novosPedidos;
    }

    pedidosFinal.sort((a,b) => (b.dataTs||0)-(a.dataTs||0));
    // dataFrom/dataTo/adsTotal recebidos aqui cobrem só o segmento buscado nesta chamada
    // (não necessariamente a união inteira). Só soma o ads quando o segmento REALMENTE
    // estende a cobertura (evita duplicar quando é só um refresh de um dia já coberto,
    // como o incremental de "hoje" do auto-refresh)
    const temCacheValido = incremental && cacheAtual?.dataFrom && cacheAtual?.dataTo && !cacheAtual.erro;
    const estendeCobertura = temCacheValido && (dataFrom < cacheAtual.dataFrom || dataTo > cacheAtual.dataTo);
    const payload = {
      pedidos: pedidosFinal,
      adsTotal: estendeCobertura ? (parseFloat(cacheAtual.adsTotal)||0) + adsTotal
              : temCacheValido    ? cacheAtual.adsTotal
              : adsTotal,
      dataFrom: temCacheValido && cacheAtual.dataFrom < dataFrom ? cacheAtual.dataFrom : dataFrom,
      dataTo:   temCacheValido && cacheAtual.dataTo   > dataTo   ? cacheAtual.dataTo   : dataTo,
      resumoContas,
      contasInfo,
      at: Date.now(),
    };
    const payloadStr = JSON.stringify(payload);
    try {
      localStorage.setItem(cacheKey, payloadStr);
      window._diagCacheSaved = `OK key=${cacheKey} | ${payload.pedidos.length} pedidos | ${Math.round(payloadStr.length/1024)}KB`;
    } catch(qe) {
      // QuotaExceededError — limpa entradas antigas e tenta de novo
      const keysToClean = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('glr_portal_vendas_v') && k !== cacheKey) keysToClean.push(k);
      }
      keysToClean.forEach(k => localStorage.removeItem(k));
      try {
        localStorage.setItem(cacheKey, payloadStr);
        window._diagCacheSaved = `OK (após limpar ${keysToClean.length} entradas antigas) | ${payload.pedidos.length} pedidos`;
      } catch(qe2) {
        window._diagCacheSaved = `ERRO quota: ${qe2.message}`;
      }
    }
    // Dispara em segundo plano — não trava o retorno da função nem o render.
    // Quando terminar, atualiza o cache com valores precisos e re-renderiza.
    pendenciasTaxasML.forEach(job => _portalEnriquecerTaxasML(job.mlPedidos, job.meliId, job.concorrencia, cacheKey));
  } catch(e) {
    console.warn('[Portal] Erro ao buscar vendas:', e.message);
    window._diagCacheSaved = `ERRO fetch: ${e.message}`;
    try {
      const ck = _portalCacheKey();
      if (ck && !_portalCache()) {
        localStorage.setItem(ck, JSON.stringify({ pedidos:[], erro: e.message, at: Date.now() }));
      }
    } catch(_) {}
  }
}

// Busca líquido (collections) e frete (shipments) por pedido ML SEM travar a UI —
// roda depois que o dashboard já está de pé com a estimativa (valor - comissão).
// Ao terminar, grava os valores precisos no cache e re-renderiza se ainda estiver no portal.
async function _portalEnriquecerTaxasML(mlPedidos, meliId, concorrencia, cacheKey) {
  const collectionsMap = {}, freteMap = {};
  await Promise.all([
    _portalMapLimit(mlPedidos.filter(p=>p.paymentId), concorrencia, async p => {
      try {
        const r = await _portalMcCall('raw', { method:'GET', path:`/collections/${p.paymentId}`, meliUserId: meliId });
        const net = parseFloat(r.data?.net_received_amount);
        if (!isNaN(net)) collectionsMap[p.paymentId] = net;
      } catch(e) {}
    }),
    _portalMapLimit(mlPedidos.filter(p=>p.shippingId), concorrencia, async p => {
      try {
        const r = await _portalMcCall('raw', { method:'GET', path:`/shipments/${p.shippingId}`, meliUserId: meliId });
        const s = r.data || {};
        const listCost = parseFloat(s.shipping_option?.list_cost);
        const baseCost = parseFloat(s.base_cost);
        freteMap[p.shippingId] = !isNaN(listCost) ? listCost : (!isNaN(baseCost) ? baseCost : 0);
      } catch(e) {}
    }),
  ]);

  let cache;
  try { cache = JSON.parse(localStorage.getItem(cacheKey)||'null'); } catch(e) { return; }
  if (!cache?.pedidos) return;
  let mudou = false;
  cache.pedidos.forEach(p => {
    if (p.paymentId && collectionsMap[p.paymentId] != null) { p.taxas.liquido = collectionsMap[p.paymentId]; mudou = true; }
    if (p.shippingId && freteMap[p.shippingId] != null) { p.taxas.frete = freteMap[p.shippingId]; mudou = true; }
  });
  if (!mudou) return;
  try { localStorage.setItem(cacheKey, JSON.stringify(cache)); } catch(e) { return; }
  // Re-renderiza se o cliente ainda estiver numa página do portal
  const hash = window.location.hash.replace('#','');
  if (hash.startsWith('portal-') && typeof Router !== 'undefined' && Router.resolve) Router.resolve();
}

function _portalPedidos() {
  const cfg = window._portalConfig;
  if (!cfg) return [];
  const cache = _portalCache();
  if (!cache?.pedidos) return [];
  const ids = (cfg.contaIds||[]).map(String);
  const contasSel = _portalContasSelecionadas();
  const f = _portalFiltroData();
  const deTs  = f.de  ? new Date(`${f.de}T00:00:00`).getTime()  : -Infinity;
  const ateTs = f.ate ? new Date(`${f.ate}T23:59:59`).getTime() : Infinity;
  return cache.pedidos.filter(p =>
    ids.includes(String(p.contaId)) &&
    (contasSel.size === 0 || contasSel.has(String(p.contaId))) &&
    (!p.dataTs || (p.dataTs >= deTs && p.dataTs <= ateTs))
  );
}

const _isCancelPortal = s => {
  const v = (s||'').toLowerCase();
  return v.includes('cancel')||v.includes('refund')||v.includes('devol')||v==='invalid'||v.includes('return');
};

// Explode pedidos em itens individuais (nome do produto, qtd, valor proporcional)
// — essencial para a Curva ABC agrupar corretamente por produto, não por pedido
function _portalItens(pedidos) {
  const out = [];
  for (const p of pedidos) {
    const itens = p.itens && p.itens.length ? p.itens : null;
    if (itens) {
      const totalQtd = itens.reduce((s,i)=>s+(i.qtd||1), 0) || 1;
      for (const it of itens) {
        const fracao = (it.qtd||1) / totalQtd;
        out.push({
          nome:   it.nome || p.produto || `Pedido ${p.id}`,
          qtd:    it.qtd || 1,
          valor:  (it.preco != null ? it.preco * (it.qtd||1) : (parseFloat(p.valor)||0) * fracao),
          imagem: it.imagem || p.imagem || '',
          status: p.status, dataTs: p.dataTs, contaId: p.contaId, plataforma: p.plataforma,
        });
      }
    } else {
      out.push({
        nome: p.produto || `Pedido ${p.id}`, qtd: p.qtd || 1, valor: parseFloat(p.valor)||0,
        imagem: p.imagem || '',
        status: p.status, dataTs: p.dataTs, contaId: p.contaId, plataforma: p.plataforma,
      });
    }
  }
  return out;
}

// Retorna investimento em ADS do cache do portal (buscado junto com as vendas)
function _portalAdsInvestimento(contaIds) {
  const cache = _portalCache();
  return parseFloat(cache?.adsTotal) || 0;
}

// ── Inicializar portal cliente ────────────────────────────────
window._initPortalCliente = async function(cfg) {
  window._portalConfig = cfg;
  _configurarSidebarCliente(cfg);

  // Custos lançados no admin — busca antes do render pra já mostrar o lucro descontado
  await _portalSincronizarCustos();

  // Busca inicial: await bloqueante garante que os dados chegam antes do render
  if (!_portalCache()) {
    const f = _portalFiltroData();
    try {
      await _portalBuscarVendas(f.de, f.ate, false);
    } catch(err) {
      console.error('[Portal] _portalBuscarVendas lançou exceção:', err);
      window._diagCacheSaved = `EXCEÇÃO não tratada: ${err.message}`;
    }
  }

  if (typeof Router !== 'undefined') Router.navigate('portal-dashboard');

  // Auto-refresh: incremental a cada minuto, full refresh às 3h
  _iniciarAutoRefreshPortal();
};

function _portalMostrarLoading(msg) {
  const el = document.getElementById('page-content');
  if (!el) return;
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:60vh;gap:16px;color:var(--text-secondary);">
      <div style="font-size:36px;animation:spin 1s linear infinite;display:inline-block;">⟳</div>
      <div style="font-size:15px;font-weight:600;">${msg || 'Carregando...'}</div>
      <div style="font-size:12px;">Buscando seus pedidos nas plataformas...</div>
    </div>
    <style>@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}</style>
  `;
}

function _portalOcultarLoading() {
  // A re-navegação após busca substituirá o conteúdo automaticamente
}

let _portalAutoRefreshTimer = null;

function _iniciarAutoRefreshPortal() {
  if (_portalAutoRefreshTimer) clearInterval(_portalAutoRefreshTimer);
  _portalAutoRefreshTimer = setInterval(async () => {
    const cfg = window._portalConfig;
    if (!cfg) return;

    await _portalSincronizarCustos(); // pega custos lançados no admin desde a última checagem

    const agora = new Date();
    const hora = agora.getHours();

    if (hora === 3) {
      // Full refresh às 3h — substitui o cache completamente
      const f = _portalFiltroData();
      await _portalBuscarVendas(f.de, f.ate, false);
    } else {
      // Incremental: só hoje, mesclando novos pedidos sem apagar os anteriores
      const hoje = agora.toISOString().slice(0, 10);
      await _portalBuscarVendas(hoje, hoje, true);
    }
    // Atualiza UI silenciosamente sem navegar (apenas re-renderiza a página atual)
    if (typeof Router !== 'undefined' && Router.resolve) Router.resolve();
  }, 60 * 1000); // 1 minuto
}

function _configurarSidebarCliente(cfg) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // Esconde toda a navegação admin
  sidebar.querySelectorAll('.sidebar-section').forEach(s => s.style.display='none');

  // Injeta menu do portal
  const logo = sidebar.querySelector('.sidebar-logo');
  const nav = document.createElement('div');
  nav.id = 'portal-nav';
  nav.innerHTML = `
    <div class="sidebar-section" style="display:block!important;">
      <div class="sidebar-section-title">Meu Painel</div>
      <button class="nav-item" data-page="portal-dashboard" onclick="Router.navigate('portal-dashboard')">
        <svg class="nav-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        Dashboard de Vendas
      </button>
      <button class="nav-item" data-page="portal-vendas" onclick="Router.navigate('portal-vendas')">
        <svg class="nav-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
        Minhas Vendas
      </button>
      <button class="nav-item" data-page="portal-abc" onclick="Router.navigate('portal-abc')">
        <svg class="nav-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        Curva ABC
      </button>
    </div>
  `;
  if (logo) logo.after(nav); else sidebar.prepend(nav);

  // Atualiza info do usuário na sidebar
  const nome = sidebar.querySelector('.user-info strong');
  const cargo = sidebar.querySelector('.user-info span');
  if (nome)  nome.textContent  = cfg.clienteNome || 'Cliente';
  if (cargo) cargo.textContent = 'Portal do Cliente';
}

// ── Kpi card helper ───────────────────────────────────────────
function _pKpi(label, valor, sub, cor='#6366f1') {
  return `
    <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;">
      <div style="font-size:11px;font-weight:700;color:${cor};text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">${label}</div>
      <div style="font-size:24px;font-weight:700;color:var(--text-primary);">${valor}</div>
      ${sub ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${sub}</div>` : ''}
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// PÁGINA: Dashboard de Vendas
// ─────────────────────────────────────────────────────────────
Router.register('portal-dashboard', (params, el) => {
  const cfg   = window._portalConfig || {};

  // Fetch é feito pelo _initPortalCliente antes de navegar aqui

  // Mostra erro se a busca falhou
  const cache = _portalCache();
  if (cache?.erro) {
    el.innerHTML = `
      <div style="padding:40px;max-width:600px;margin:60px auto;text-align:center;">
        <div style="font-size:48px;margin-bottom:16px;">⚠️</div>
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);margin-bottom:8px;">Erro ao carregar dados</div>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:24px;">${cache.erro}</div>
        <button onclick="window._portalRecarregar()" style="background:var(--primary);color:#fff;border:none;border-radius:99px;padding:12px 28px;font-size:14px;font-weight:600;cursor:pointer;">🔄 Tentar novamente</button>
      </div>`;
    window._portalRecarregar = async () => {
      localStorage.removeItem(_portalCacheKey());
      await window._initPortalCliente(cfg);
    };
    return;
  }

  const finCache = _portalFinCache();
  const custos = _portalCustos();
  const todos = _portalPedidos();
  const ativos = todos.filter(p => !_isCancelPortal(p.status));
  const filtro = _portalFiltroData();

  const fat      = ativos.reduce((s,p) => s+(parseFloat(p.valor)||0), 0);
  const qtd      = ativos.length;
  const ticket   = qtd > 0 ? fat/qtd : 0;
  const unidades = ativos.reduce((s,p) => s+(parseFloat(p.qtd)||1), 0);
  const cancelados = todos.filter(p => _isCancelPortal(p.status)).length;
  const txCancel = todos.length > 0 ? (cancelados/todos.length*100) : 0;

  // Líquido do marketplace — casa pelo ID do pedido com glr_fin_cache (que tem taxas.liquido)
  const finPorId = {};
  (finCache?.pedidos||[]).forEach(p => { finPorId[String(p.id)] = p; });
  let liquido = 0, temLiquido = false;
  for (const p of ativos) {
    const fp = finPorId[String(p.id)];
    const liq = fp?.taxas?.liquido ?? p?.taxas?.liquido;
    if (liq != null) { liquido += parseFloat(liq)||0; temLiquido = true; }
  }
  if (!temLiquido) liquido = fat; // fallback se ainda não processado no financeiro

  // Custo de produto + imposto (mesma fórmula do admin) → lucro bruto
  let lucroBruto = 0, custoTotal = 0, temCusto = false;
  for (const p of ativos) {
    const l = _portalCalcLucro(p, custos);
    lucroBruto += l.lucro;
    custoTotal += l.custo;
    if (l.custo > 0) temCusto = true;
  }
  const margem = fat > 0 ? (lucroBruto/fat*100) : 0;

  // ADS — investimento no período + margem pós-ADS
  const adsInvestimento = _portalAdsInvestimento(cfg.contaIds);
  const roas = adsInvestimento > 0 ? fat/adsInvestimento : 0;
  const lucroPosAds = lucroBruto - adsInvestimento;
  const margemPosAds = fat > 0 ? (lucroPosAds/fat*100) : 0;

  // Top 5 produtos — agrupado por ITEM real (corrige pedidos com múltiplos produtos)
  const itensAtivos = _portalItens(ativos);
  const prodMap = {};
  for (const it of itensAtivos) {
    if (!prodMap[it.nome]) prodMap[it.nome] = {fat:0, qtd:0};
    prodMap[it.nome].fat += it.valor;
    prodMap[it.nome].qtd += it.qtd;
  }
  const top5 = Object.entries(prodMap).sort((a,b)=>b[1].fat-a[1].fat).slice(0,5);

  // Gráfico diário
  const diaMap = {};
  for (const p of ativos) {
    const d = p.dataTs ? new Date(p.dataTs).toLocaleDateString('pt-BR') : '?';
    diaMap[d] = (diaMap[d]||0) + (parseFloat(p.valor)||0);
  }
  const dias = Object.entries(diaMap).sort(([a],[b]) => {
    const [da,ma,ya] = a.split('/'); const [db,mb,yb] = b.split('/');
    return new Date(`${ya}-${ma}-${da}`) - new Date(`${yb}-${mb}-${db}`);
  }).slice(-30);
  const maxDia = Math.max(...dias.map(([,v])=>v), 0.01);

  const bars = dias.map(([d,v]) => {
    const h = Math.max(Math.round((v/maxDia)*100), 2);
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;flex:1;min-width:0;height:100px;" title="${d}: ${_pR$(v)}">
      <div style="width:100%;background:#6366f1;border-radius:3px 3px 0 0;height:${h}px;opacity:.8;"></div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="padding:24px;max-width:1200px;margin:0 auto;">
      <div style="margin-bottom:16px;">
        <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">📊 Dashboard de Vendas</h2>
        <div style="font-size:13px;color:var(--text-secondary);">${cfg.clienteNome || 'Minha Conta'}</div>
      </div>

      ${_portalFiltroBar()}

      <!-- KPIs principais -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:16px;">
        ${_pKpi('💰 Faturamento', _pR$(fat), `${_pN(qtd)} pedidos`, '#16a34a')}
        ${_pKpi('🏦 Líq. do Marketplace', _pR$(liquido), temLiquido?'após taxas':'estimado', '#0ea5e9')}
        ${_pKpi('📈 Lucro Bruto', _pR$(lucroBruto), temCusto?'líquido − custo produto':'sem custo cadastrado', lucroBruto>=0?'#16a34a':'#dc2626')}
        ${_pKpi('🎯 Margem', _pN(margem,1)+'%', 'lucro bruto / faturamento', _pCorMargem(margem))}
      </div>

      <!-- KPIs ADS -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:16px;">
        ${_pKpi('📢 Investimento em ADS', _pR$(adsInvestimento), 'no período selecionado', '#9333ea')}
        ${_pKpi('🎯 ROAS', adsInvestimento>0?_pN(roas,2)+'x':'—', 'receita / investido em ADS', roas>=3?'#16a34a':roas>0?'#d97706':'#6366f1')}
        ${_pKpi('📉 Lucro Pós-ADS', _pR$(lucroPosAds), 'lucro bruto − investimento ADS', lucroPosAds>=0?'#16a34a':'#dc2626')}
        ${_pKpi('🧮 Margem Pós-ADS', _pN(margemPosAds,1)+'%', 'considerando o gasto com anúncios', _pCorMargem(margemPosAds))}
      </div>

      <!-- KPIs secundários -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px;">
        ${_pKpi('🛒 Número de Vendas', _pN(qtd), `cancelados: ${_pN(cancelados)}`, '#6366f1')}
        ${_pKpi('📦 Unidades Vendidas', _pN(unidades), 'itens despachados', '#8b5cf6')}
        ${_pKpi('🎫 Ticket Médio', _pR$(ticket), 'por pedido', '#0ea5e9')}
        ${_pKpi('❌ Cancelamentos', _pN(txCancel,1)+'%', `${_pN(cancelados)} pedidos`, txCancel>10?'#dc2626':'#d97706')}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;">
        <!-- Gráfico diário -->
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;">
          <h3 style="font-size:14px;font-weight:700;margin:0 0 16px;color:var(--text-primary);">📅 Faturamento Diário</h3>
          ${dias.length > 0 ? `
            <div style="display:flex;align-items:flex-end;gap:2px;height:100px;">${bars}</div>
            <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:var(--text-secondary);">
              <span>${dias[0]?.[0]||''}</span><span>Total: ${_pR$(fat)}</span><span>${dias[dias.length-1]?.[0]||''}</span>
            </div>` : `<div style="text-align:center;padding:40px;color:var(--text-secondary);font-size:13px;">Nenhum dado no período</div>`}
        </div>

        <!-- Top produtos -->
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:20px;">
          <h3 style="font-size:14px;font-weight:700;margin:0 0 16px;color:var(--text-primary);">🏆 Top 5 Produtos</h3>
          ${top5.length > 0 ? top5.map(([nome,d],i) => {
            const pct = fat > 0 ? (d.fat/fat*100) : 0;
            const cores = ['#6366f1','#8b5cf6','#0ea5e9','#16a34a','#d97706'];
            return `
              <div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                  <span style="color:var(--text-primary);font-weight:600;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${nome}">${i+1}. ${nome}</span>
                  <span style="color:var(--text-secondary);">${_pR$(d.fat)}</span>
                </div>
                <div style="background:var(--border);border-radius:99px;height:4px;">
                  <div style="background:${cores[i]};border-radius:99px;height:4px;width:${pct}%;"></div>
                </div>
              </div>`;
          }).join('') : `<div style="text-align:center;padding:40px;color:var(--text-secondary);font-size:13px;">Nenhum dado</div>`}
        </div>
      </div>

      ${ativos.length === 0 ? `
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:48px;text-align:center;color:var(--text-secondary);">
          <div style="font-size:40px;margin-bottom:12px;">📦</div>
          <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Nenhum dado disponível no período</div>
          <div style="font-size:13px;">Tente ampliar o período ou aguarde a atualização dos dados pela consultoria.</div>
        </div>` : ''}

      ${!temCusto && ativos.length > 0 ? `
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;margin-top:16px;font-size:12px;color:#92400e;">
          ℹ️ Lucro Bruto e Margem ficam mais precisos quando o custo dos produtos é cadastrado na página Vendas.
        </div>` : ''}
    </div>
  `;
});

// ─────────────────────────────────────────────────────────────
// PÁGINA: Minhas Vendas — mesmo padrão detalhado da Central (somente leitura)
// ─────────────────────────────────────────────────────────────
const _PORTAL_PLAT_COR = { 'Shopee':'#f97316', 'Mercado Livre':'#fbbf24' };
let _portalVendasExpandido = null;

// Replica exatamente a lógica de calcLucro do admin (pages-vendas.js) para o
// portal chegar no mesmo número: imposto por escrow > manual por pedido > alíquota da conta
function _portalCalcLucro(p, custos) {
  const receita = parseFloat(p.valor) || 0;
  const tx      = p.taxas || {};
  const liquido = tx.liquido != null ? parseFloat(tx.liquido) : null;
  const c       = custos[p.id] || {};
  const custo   = parseFloat(c.custo)  || 0;
  const outros  = parseFloat(c.outros) || 0;

  const aliquotas = _portalAliquotas();
  const impAPIRaw = tx.imposto != null ? parseFloat(tx.imposto) : null;
  const impManual = parseFloat(c.imposto) || 0;
  const impAliq   = parseFloat(aliquotas[p.contaId] || 0);
  const impPct    = impManual || impAliq;
  const impDeEscrow = (impAPIRaw != null && impAPIRaw > 0);
  const impVal    = impDeEscrow ? impAPIRaw : (receita * impPct / 100);

  let extra = 0;
  for (const l of _portalLinhasExtras())
    extra += l.tipo==='pct' ? receita*(parseFloat(l.valor)||0)/100 : (parseFloat(l.valor)||0);

  const base = liquido != null ? liquido : receita;
  const impSubtrair = impDeEscrow ? 0 : impVal; // se veio do escrow já está deduzido do líquido
  const lucro  = base - custo - impSubtrair - outros - extra;
  const margem = receita > 0 ? (lucro/receita*100) : 0;
  return { receita, liquido, custo, impVal, impPct, impDeEscrow, outros, extra, lucro, margem };
}

Router.register('portal-vendas', (params, el) => {
  const cfg = window._portalConfig || {};
  const custos = _portalCustos();
  const todos = _portalPedidos();

  const fat = todos.filter(p=>!_isCancelPortal(p.status)).reduce((s,p)=>s+(parseFloat(p.valor)||0),0);

  el.innerHTML = `
    <div style="padding:24px;max-width:1300px;margin:0 auto;">
      <div style="margin-bottom:16px;">
        <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">🛒 Minhas Vendas</h2>
        <div style="font-size:13px;color:var(--text-secondary);">${todos.length} pedidos · Faturamento: ${_pR$(fat)}</div>
      </div>

      ${_portalFiltroBar()}

      <div id="portal-vendas-lista"></div>
    </div>
  `;

  _renderPortalVendasLista(todos, custos);
});

function _renderPortalVendasLista(todos, custos) {
  const cont = document.getElementById('portal-vendas-lista');
  if (!cont) return;

  if (!todos.length) {
    cont.innerHTML = `
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:60px;text-align:center;color:var(--text-secondary);">
        <div style="font-size:40px;margin-bottom:12px;">📦</div>
        <div style="font-size:15px;font-weight:600;">Nenhuma venda no período</div>
      </div>`;
    return;
  }

  // Agrupa por data (campo p.data já vem formatado de glr_vendas_cache)
  const grupos = {};
  for (const p of todos) { const k = p.data || '—'; if (!grupos[k]) grupos[k] = []; grupos[k].push(p); }

  // Ordena grupos por data desc
  const gruposOrdenados = Object.entries(grupos).sort(([,a],[,b]) => (b[0]?.dataTs||0)-(a[0]?.dataTs||0));

  cont.innerHTML = `<div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
    ${gruposOrdenados.map(([data, peds]) => {
      const fatGrupo = peds.filter(p=>!_isCancelPortal(p.status)).reduce((s,p)=>s+(parseFloat(p.valor)||0),0);
      const lucroGrupo = peds.filter(p=>!_isCancelPortal(p.status)).reduce((s,p)=>s+_portalCalcLucro(p,custos).lucro,0);
      const margemGrupo = fatGrupo > 0 ? (lucroGrupo/fatGrupo*100) : 0;
      return `
      <div>
        <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--bg-base);border-bottom:1px solid var(--border);">
          <span style="font-size:13px;font-weight:700;color:var(--text-primary);">📅 ${data}</span>
          <span style="font-size:11px;color:var(--text-secondary);">${peds.length} pedidos</span>
          <span style="margin-left:auto;font-size:12px;color:#0ea5e9;font-weight:600;">${_pR$(fatGrupo)}</span>
          <span style="font-size:12px;font-weight:700;color:${_pCorMargem(margemGrupo)};">Lucro ${_pR$(lucroGrupo)} · ${_pN(margemGrupo,1)}%</span>
        </div>
        <div style="display:grid;grid-template-columns:2fr 50px 105px 105px 90px 90px;padding:6px 16px;background:var(--bg-base);border-bottom:1px solid var(--border);">
          ${['ITEM','QTD','TOTAL','LÍQ. MP','LUCRO','MARGEM'].map((h,i)=>
            `<div style="font-size:10px;color:var(--text-secondary);font-weight:700;text-align:${i<=1?'left':'right'};white-space:nowrap;">${h}</div>`).join('')}
        </div>
        ${peds.map(p => _renderPortalVendaRow(p, custos)).join('')}
      </div>`;
    }).join('')}
  </div>`;

  cont.querySelectorAll('.portal-row-click').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      _portalVendasExpandido = _portalVendasExpandido === id ? null : id;
      _renderPortalVendasLista(todos, custos);
    });
  });
}

function _renderPortalVendaRow(p, custos) {
  const l = _portalCalcLucro(p, custos);
  const exp = _portalVendasExpandido === p.id;
  const cor = _PORTAL_PLAT_COR[p.plataforma] || '#9ca3af';
  const isCancelled = _isCancelPortal(p.status);
  const img = p.imagem
    ? `<img src="${p.imagem}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0;" onerror="this.style.display='none'">`
    : `<div style="width:40px;height:40px;background:var(--bg-base);border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px;">${p.plataforma==='Shopee'?'🟠':'🟡'}</div>`;

  return `
  <div style="border-bottom:1px solid var(--border);">
    <div class="portal-row-click" data-id="${p.id}" style="display:grid;grid-template-columns:2fr 50px 105px 105px 90px 90px;padding:10px 16px;align-items:center;cursor:pointer;">
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        ${img}
        <div style="min-width:0;">
          <div style="font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px;" title="${(p.produto||'').replace(/"/g,'&quot;')}">${p.produto||'—'}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px;display:flex;gap:6px;align-items:center;">
            <span style="color:${cor};font-weight:600;">${p.plataforma}</span>
            <span>${p.id}</span>
            ${isCancelled ? '<span style="background:#fef2f2;color:#dc2626;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;">● Cancelado</span>' : ''}
          </div>
        </div>
      </div>
      <div style="text-align:left;font-size:13px;color:var(--text-secondary);">${p.qtd||1}</div>
      <div style="text-align:right;font-size:13px;font-weight:700;color:#0ea5e9;">${_pR$(l.receita)}</div>
      <div style="text-align:right;font-size:13px;font-weight:700;color:#8b5cf6;">${l.liquido!=null?_pR$(l.liquido):'—'}</div>
      <div style="text-align:right;font-size:13px;font-weight:700;color:${_pCorMargem(l.margem)};">${_pR$(l.lucro)}</div>
      <div style="text-align:right;">
        <span style="background:${_pCorMargem(l.margem)}22;color:${_pCorMargem(l.margem)};padding:3px 8px;border-radius:20px;font-size:11px;font-weight:700;">${_pN(l.margem,1)}%</span>
      </div>
    </div>
    ${exp ? _renderPortalVendaDetalhe(p, l) : ''}
  </div>`;
}

function _renderPortalVendaDetalhe(p, l) {
  const tx = p.taxas || {};
  const hasEscrow = p.taxas != null;
  const linhas = [
    { label:'💰 Total do Pedido', v: l.receita, cor:'#0ea5e9', sinal:'+' },
    tx.comissao>0    ? { label:'🏦 Comissão',       v:-tx.comissao,    cor:'#dc2626', sinal:'-' } : null,
    tx.taxaServico>0 ? { label:'⚙️ Taxa de Serviço', v:-tx.taxaServico, cor:'#dc2626', sinal:'-' } : null,
    tx.frete>0       ? { label:'🚚 Frete',           v:-Math.abs(tx.frete), cor:'#f97316', sinal:'-' } : null,
    tx.voucher>0     ? { label:'🎟️ Voucher',         v: tx.voucher,     cor:'#16a34a', sinal:'+' } : null,
    l.liquido!=null  ? { label:'💳 Líquido (após taxas)', v:l.liquido, cor:'#8b5cf6', sinal:'=', bold:true } : null,
    { label:'📦 Custo do Produto', v:-l.custo, cor:'#dc2626', sinal:'-' },
    l.impVal>0 ? { label:`🧾 Imposto${l.impDeEscrow?' (escrow)':l.impPct?` (${l.impPct}%)`:''}`, v:-l.impVal, cor:'#fbbf24', sinal:'-' } : null,
    l.outros>0 ? { label:'➕ Outros custos', v:-l.outros, cor:'#dc2626', sinal:'-' } : null,
    l.extra   ? { label:'➕ Linhas extras', v:-l.extra, cor: l.extra>0?'#dc2626':'#16a34a', sinal: l.extra>0?'-':'+' } : null,
    { label:'✅ Lucro Bruto', v:l.lucro, cor:_pCorMargem(l.margem), sinal: l.lucro>=0?'+':'-', bold:true },
  ].filter(Boolean);

  return `
  <div style="display:flex;background:var(--bg-base);border-top:1px solid var(--border);flex-wrap:wrap;">
    <div style="flex:1;min-width:260px;padding:16px 20px;border-right:1px solid var(--border);">
      <div style="font-size:10px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;margin-bottom:10px;">Detalhes do Pedido</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
        <div><div style="font-size:10px;color:var(--text-secondary);">ID</div><div style="font-size:12px;color:var(--text-primary);">${p.id}</div></div>
        <div><div style="font-size:10px;color:var(--text-secondary);">Plataforma</div><div style="font-size:12px;color:var(--text-primary);font-weight:600;">${p.plataforma}</div></div>
        <div><div style="font-size:10px;color:var(--text-secondary);">Data</div><div style="font-size:12px;color:var(--text-primary);">${p.data}</div></div>
        <div><div style="font-size:10px;color:var(--text-secondary);">Status</div><div style="font-size:12px;color:var(--text-primary);">${p.status||'—'}</div></div>
      </div>
      ${p.itens && p.itens.length ? `
      <div style="font-size:10px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;margin-bottom:8px;">Itens</div>
      ${p.itens.map(it=>`
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
          ${it.imagem?`<img src="${it.imagem}" style="width:32px;height:32px;object-fit:cover;border-radius:5px;flex-shrink:0;">` : ''}
          <div style="flex:1;font-size:12px;color:var(--text-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${it.nome}</div>
          <div style="font-size:11px;color:var(--text-secondary);flex-shrink:0;">x${it.qtd}</div>
          <div style="font-size:12px;color:#0ea5e9;font-weight:600;flex-shrink:0;">${_pR$(it.preco)}</div>
        </div>`).join('')}` : ''}
    </div>
    <div style="width:280px;flex-shrink:0;padding:16px 20px;">
      <div style="font-size:10px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;margin-bottom:10px;">
        Composição do Lucro ${hasEscrow ? '<span style="color:#8b5cf6;font-size:9px;background:#8b5cf622;padding:1px 6px;border-radius:8px;margin-left:4px;">dados da API</span>' : ''}
      </div>
      ${linhas.map(r=>`
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:12px;${r.bold?'font-weight:700;color:var(--text-primary);':'color:var(--text-secondary);'}">${r.label}</span>
          <span style="font-size:13px;font-weight:${r.bold?'800':'600'};color:${r.cor};">${r.sinal==='='?'= ':r.sinal==='+'?'+':'-'}${_pR$(Math.abs(r.v))}</span>
        </div>`).join('')}
      <div style="margin-top:10px;padding-top:10px;border-top:2px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;color:var(--text-secondary);">Margem s/ receita</span>
        <span style="font-size:18px;font-weight:800;color:${_pCorMargem(l.margem)};">${_pN(l.margem,1)}%</span>
      </div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// PÁGINA: Curva ABC
// ─────────────────────────────────────────────────────────────
Router.register('portal-abc', (params, el) => {
  const cfg   = window._portalConfig || {};
  const ativos = _portalPedidos().filter(p => !_isCancelPortal(p.status));

  // Agrupa por PRODUTO real (item a item) — corrige pedidos com múltiplos produtos
  const itens = _portalItens(ativos);
  const prodMap = {};
  for (const it of itens) {
    const nome = it.nome;
    if (!prodMap[nome]) prodMap[nome] = { fat:0, qtd:0, imagem:'' };
    prodMap[nome].fat += it.valor;
    prodMap[nome].qtd += it.qtd;
    if (!prodMap[nome].imagem && it.imagem) prodMap[nome].imagem = it.imagem;
  }

  const total = Object.values(prodMap).reduce((s,d)=>s+d.fat, 0);
  const sorted = Object.entries(prodMap).sort((a,b)=>b[1].fat-a[1].fat);

  // Classifica ABC
  let acum = 0;
  const classificados = sorted.map(([nome, d]) => {
    acum += d.fat;
    const pctAcum = total > 0 ? acum/total*100 : 0;
    const pctProd = total > 0 ? d.fat/total*100 : 0;
    const cls = pctAcum <= 80 ? 'A' : pctAcum <= 95 ? 'B' : 'C';
    return { nome, fat: d.fat, qtd: d.qtd, imagem: d.imagem, pctProd, pctAcum, cls };
  });

  const countA = classificados.filter(p=>p.cls==='A').length;
  const countB = classificados.filter(p=>p.cls==='B').length;
  const countC = classificados.filter(p=>p.cls==='C').length;
  const fatA   = classificados.filter(p=>p.cls==='A').reduce((s,p)=>s+p.fat,0);
  const fatB   = classificados.filter(p=>p.cls==='B').reduce((s,p)=>s+p.fat,0);
  const fatC   = classificados.filter(p=>p.cls==='C').reduce((s,p)=>s+p.fat,0);

  const clsCfg = {
    A: {cor:'#16a34a', bg:'#f0fdf4', desc:'80% do faturamento'},
    B: {cor:'#d97706', bg:'#fffbeb', desc:'15% do faturamento'},
    C: {cor:'#dc2626', bg:'#fef2f2', desc:'5% do faturamento'},
  };

  const rows = classificados.map((p, i) => {
    const c = clsCfg[p.cls];
    const img = p.imagem
      ? `<img src="${p.imagem}" style="width:32px;height:32px;object-fit:cover;border-radius:5px;flex-shrink:0;" onerror="this.style.display='none'">`
      : `<div style="width:32px;height:32px;background:var(--bg-base);border-radius:5px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;">📦</div>`;
    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px 12px;text-align:center;font-size:13px;color:var(--text-secondary);">${i+1}</td>
        <td style="padding:10px 12px;font-size:12px;color:var(--text-primary);">
          <div style="display:flex;align-items:center;gap:8px;max-width:280px;">
            ${img}
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p.nome}">${p.nome}</span>
          </div>
        </td>
        <td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:var(--text-primary);">${_pR$(p.fat)}</td>
        <td style="padding:10px 12px;text-align:center;font-size:12px;color:var(--text-secondary);">${_pN(p.qtd)} un.</td>
        <td style="padding:10px 12px;text-align:center;font-size:12px;color:var(--text-secondary);">${_pN(p.pctProd,1)}%</td>
        <td style="padding:10px 12px;text-align:center;font-size:12px;color:var(--text-secondary);">${_pN(p.pctAcum,1)}%</td>
        <td style="padding:10px 12px;text-align:center;">
          <span style="background:${c.bg};color:${c.cor};border-radius:99px;padding:3px 14px;font-size:12px;font-weight:800;">${p.cls}</span>
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <div style="padding:24px;max-width:1200px;margin:0 auto;">
      <div style="margin-bottom:16px;">
        <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">📈 Curva ABC de Produtos</h2>
        <div style="font-size:13px;color:var(--text-secondary);">${sorted.length} produtos analisados · Faturamento total: ${_pR$(total)}</div>
      </div>

      ${_portalFiltroBar()}

      <!-- Resumo ABC -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px;">
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;text-align:center;">
          <div style="font-size:32px;font-weight:800;color:#16a34a;">A</div>
          <div style="font-size:13px;font-weight:700;color:#16a34a;margin:4px 0;">${countA} produto(s)</div>
          <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${_pR$(fatA)}</div>
          <div style="font-size:11px;color:#16a34a;margin-top:4px;">Foco total — ${_pN(total>0?fatA/total*100:0,1)}% do faturamento</div>
        </div>
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:20px;text-align:center;">
          <div style="font-size:32px;font-weight:800;color:#d97706;">B</div>
          <div style="font-size:13px;font-weight:700;color:#d97706;margin:4px 0;">${countB} produto(s)</div>
          <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${_pR$(fatB)}</div>
          <div style="font-size:11px;color:#d97706;margin-top:4px;">Monitorar — ${_pN(total>0?fatB/total*100:0,1)}% do faturamento</div>
        </div>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:20px;text-align:center;">
          <div style="font-size:32px;font-weight:800;color:#dc2626;">C</div>
          <div style="font-size:13px;font-weight:700;color:#dc2626;margin:4px 0;">${countC} produto(s)</div>
          <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${_pR$(fatC)}</div>
          <div style="font-size:11px;color:#dc2626;margin-top:4px;">Revisar — ${_pN(total>0?fatC/total*100:0,1)}% do faturamento</div>
        </div>
      </div>

      <!-- Tabela -->
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
        ${sorted.length > 0 ? `
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="background:var(--bg-base);border-bottom:2px solid var(--border);">
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);">#</th>
                  <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:var(--text-secondary);">PRODUTO</th>
                  <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:700;color:var(--text-secondary);">FATURAMENTO</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);">QTD</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);">% PRODUTO</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);">% ACUMULADO</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-secondary);">CLASSE</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : `
          <div style="text-align:center;padding:60px;color:var(--text-secondary);">
            <div style="font-size:40px;margin-bottom:12px;">📈</div>
            <div style="font-size:15px;font-weight:600;">Nenhum dado no período</div>
          </div>`}
      </div>

      <div style="margin-top:12px;font-size:11px;color:var(--text-secondary);">
        A = produtos que representam 80% do faturamento · B = próximos 15% · C = últimos 5%
      </div>
    </div>
  `;
});
