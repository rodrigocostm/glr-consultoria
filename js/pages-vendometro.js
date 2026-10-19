// ============================================================
// GLR Consultoria — Vendômetro
// ------------------------------------------------------------
// Vendas de HOJE da carteira inteira, ao vivo (no estilo do monitor da
// Shopee), com a marca GLR em destaque para print:
//  • total vendido hoje e comparação com ontem até a mesma hora;
//  • métricas: pedidos, unidades, ticket, ADS investido, TACOS, visitas (ML);
//  • tendência por hora (hoje × ontem);
//  • ranking de clientes com pedidos, ADS, visitas e plataformas.
// Fonte: base automática (glr_pedidos / glr_ads_diario, sincroniza a cada
// 15 min) — só contas vinculadas a clientes (glr_mc_vinculos). Faturamento sem
// cancelados e sem devolvidos. Visitas: API do Mercado Livre (a Shopee não
// fornece visitas pela API).
// ============================================================
Router.register('vendometro', (params, el) => {
  const R$ = (v, c = 2) => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
  const N = v => Math.round(v || 0).toLocaleString('pt-BR');
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch (e) { return d; } };
  const MKT = { ml: { sigla: 'ML', nome: 'Mercado Livre', cor: '#d9a400' }, shopee: { sigla: 'SH', nome: 'Shopee', cor: '#eb6834' }, amazon: { sigla: 'AMZ', nome: 'Amazon', cor: '#8b95a7' }, tiktok: { sigla: 'TT', nome: 'TikTok Shop', cor: '#1fb8b4' }, magalu: { sigla: 'MGL', nome: 'Magalu', cor: '#0a84ff' }, shein: { sigla: 'SHN', nome: 'Shein', cor: '#9aa0aa' } };
  const HORA = 3600e3, DIA = 24 * HORA;
  const horaBRT = t => new Date(t - 3 * HORA).getUTCHours();
  const isoDia = t => new Date(t - 3 * HORA).toISOString().slice(0, 10);

  const st = {
    mkt: (() => { try { return localStorage.getItem('glr_vm_mkt') || 'todos'; } catch (e) { return 'todos'; } })(),
    hoje: [], ontem: [], ads: [], dia: null, visitas: {}, visitasEm: 0, visitasProg: '',
    carregando: false, erro: null, atualizadoEm: 0, valorMostrado: 0, todos: false, grafico: null,
    ...(() => { try { const v = JSON.parse(localStorage.getItem('glr_vm_sel') || '{}'); return { cliente: v.cliente || '', conta: v.conta || '' }; } catch (e) { return { cliente: '', conta: '' }; } })(),
    contasPortal: null,
    // Modo foto: esconde nomes e números sensíveis para prints (Instagram)
    foto: (() => { try { return { on: false, nomes: true, linha: true, valores: false, painel: false, ...JSON.parse(localStorage.getItem('glr_vm_foto') || '{}') }; } catch (e) { return { on: false, nomes: true, linha: true, valores: false, painel: false }; } })(),
  };
  const oculta = k => st.foto.on && st.foto[k];
  // Portal do cliente: só as contas dele (o banco e o /api/mcp já garantem), sem escolher cliente
  const cfgPortal = window._portalConfig || null;
  if (cfgPortal) { st.cliente = String(cfgPortal.clienteId); if (st.conta && !st.conta.includes(':')) st.conta = ''; }

  // ── Contas da carteira: "ml:123" → cliente ──
  function contasCarteira() {
    if (cfgPortal) {
      const cli = { id: String(cfgPortal.clienteId), nome: cfgPortal.clienteNome || 'Minha loja' };
      return new Map((st.contasPortal || []).map(c => [`${c.mkt}:${c.id}`, { cli, ...c }]));
    }
    const vinc = lerJSON('glr_mc_vinculos', {});
    const clientes = new Map((GLR.clientes || []).map(c => [String(c.id), c]));
    const mapa = new Map();
    for (const [cid, contas] of Object.entries(vinc)) {
      const cli = clientes.get(String(cid)); if (!cli) continue;
      for (const ct of contas || []) {
        const mkt = BaseDados.mktDe(ct.marketplace); if (!mkt) continue;
        const id = String(ct.param_to_use?.shopId || ct.param_to_use?.meliUserId || ct.contaId || ct.external_id);
        mapa.set(`${mkt}:${id}`, { cli, mkt, id, nome: ct.tags?.[0]?.name || ct.nickname || id });
      }
    }
    return mapa;
  }

  // ── Leitura da base ──
  async function paginar(q) {
    const out = [];
    for (let off = 0; off < 30000; off += 1000) {
      const { data, error } = await q().range(off, off + 999);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out;
  }
  async function carregar() {
    if (st.carregando || typeof _sb === 'undefined') return;
    st.carregando = true; st.erro = null; render();
    try {
      if (cfgPortal && !st.contasPortal) {
        const ids = new Set((cfgPortal.contaIds || []).map(String));
        st.contasPortal = (await MarketplaceAPI.listAccounts() || []).filter(c => ids.has(String(c.external_id))).map(c => ({
          mkt: BaseDados.mktDe(c.marketplace), id: String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.param_to_use?.amazon_account_id || c.param_to_use?.magalu_account_id || c.param_to_use?.shein_supplier_id || c.external_id), nome: c.tags?.find?.(t => t?.name)?.name || c.nickname || c.external_id,
        })).filter(c => c.mkt);
      }
      const agora = Date.now(), hoje = isoDia(agora);
      const iniHoje = new Date(`${hoje}T00:00:00-03:00`).getTime(), iniOntem = iniHoje - DIA;
      const [rh, ro, ra] = await Promise.all([
        paginar(() => _sb.from('glr_pedidos').select('marketplace,conta_id,pedido_id,criado_em,situacao,valor_bruto,itens')
          .gte('criado_em', new Date(iniHoje).toISOString()).order('criado_em').order('pedido_id')),
        paginar(() => _sb.from('glr_pedidos').select('marketplace,conta_id,pedido_id,criado_em,situacao,valor_bruto')
          .gte('criado_em', new Date(iniOntem).toISOString()).lt('criado_em', new Date(iniHoje).toISOString()).order('criado_em').order('pedido_id')),
        _sb.from('glr_ads_diario').select('marketplace,conta_id,gasto').eq('data', hoje),
      ]);
      if (st.dia && st.dia !== hoje) { st.visitas = {}; st.visitasEm = 0; st.valorMostrado = 0; } // virou o dia
      st.hoje = rh; st.ontem = ro; st.ads = ra.data || []; st.dia = hoje; st.atualizadoEm = Date.now();
    } catch (e) { st.erro = e.message; }
    finally { st.carregando = false; render(); }
    carregarVisitas();
  }

  // Visitas de hoje das contas do Mercado Livre (a cada 10 min)
  let buscandoVisitas = false;
  async function carregarVisitas() {
    if (buscandoVisitas || Date.now() - st.visitasEm < 10 * 60e3) return;
    const ml = [...contasCarteira().values()].filter(c => c.mkt === 'ml');
    if (!ml.length) return;
    buscandoVisitas = true;
    const hoje = isoDia(Date.now()); let feitas = 0;
    const fila = [...ml];
    const trabalhador = async () => {
      while (fila.length) {
        const c = fila.shift();
        try {
          const r = await MarketplaceAPI.call('ml_visits_user', { meliUserId: c.id, date_from: hoje, date_to: hoje });
          const v = r?.total_visits ?? r?.data?.total_visits;
          if (v != null) st.visitas[`ml:${c.id}`] = Number(v) || 0;
        } catch (e) {}
        feitas++; st.visitasProg = `visitas ${feitas}/${ml.length}`;
        if (feitas % 5 === 0) render();
      }
    };
    try { await Promise.all(Array.from({ length: 5 }, trabalhador)); st.visitasEm = Date.now(); }
    finally { buscandoVisitas = false; st.visitasProg = ''; render(); }
  }

  // ── Cálculo ──
  function calcular() {
    const contas = contasCarteira();
    // filtros: plataforma + cliente + conta. Com um cliente escolhido o ranking vira de CONTAS
    const passa = k => { const ct = contas.get(k); return (st.mkt === 'todos' || k.startsWith(st.mkt + ':')) && (!st.cliente || String(ct?.cli.id) === st.cliente) && (!st.conta || k === st.conta); };
    const porConta = !!st.cliente;
    const clientes = new Map();
    const linha = ct => { const id = porConta ? `${ct.mkt}:${ct.id}` : ct.cli.id; if (!clientes.has(id)) clientes.set(id, { nome: String(porConta ? ct.nome : ct.cli.nome || ''), fat: 0, ped: 0, un: 0, ads: 0, vis: 0, temML: false, mkts: new Set() }); return clientes.get(id); };
    for (const [k, ct] of contas) if (passa(k)) { const c = linha(ct); c.mkts.add(ct.mkt); if (ct.mkt === 'ml') c.temML = true; }
    const T = { fat: 0, ped: 0, un: 0, ads: 0, vis: 0, pedML: 0, fatOntem: 0, fatOntemAgora: 0, hoje: Array(24).fill(0), ontem: Array(24).fill(0) };
    const limOntem = Date.now() - DIA;
    for (const p of st.hoje) {
      const k = `${p.marketplace}:${p.conta_id}`, ct = contas.get(k);
      if (p.situacao !== 'valido' || !ct || !passa(k)) continue;
      const v = Number(p.valor_bruto) || 0, t = new Date(p.criado_em).getTime();
      const u = (Array.isArray(p.itens) ? p.itens : []).reduce((s, i) => s + (Number(i.qtd) || 1), 0) || 1;
      T.fat += v; T.ped++; T.un += u; T.hoje[horaBRT(t)] += v; if (ct.mkt === 'ml') T.pedML++;
      const c = linha(ct); c.fat += v; c.ped++; c.un += u;
    }
    for (const p of st.ontem) {
      const k = `${p.marketplace}:${p.conta_id}`;
      if (p.situacao !== 'valido' || !contas.has(k) || !passa(k)) continue;
      const v = Number(p.valor_bruto) || 0, t = new Date(p.criado_em).getTime();
      T.fatOntem += v; T.ontem[horaBRT(t)] += v; if (t <= limOntem) T.fatOntemAgora += v;
    }
    for (const a of st.ads) {
      const k = `${BaseDados.mktDe(a.marketplace)}:${a.conta_id}`, ct = contas.get(k);
      if (!ct || !passa(k)) continue;
      const g = Number(a.gasto) || 0; T.ads += g; linha(ct).ads += g;
    }
    for (const [k, v] of Object.entries(st.visitas)) {
      const ct = contas.get(k); if (!ct || !passa(k)) continue;
      T.vis += v; linha(ct).vis += v;
    }
    T.clientes = [...clientes.values()].sort((a, b) => b.fat - a.fat || b.ped - a.ped || a.nome.localeCompare(b.nome));
    T.vendendo = T.clientes.filter(c => c.ped > 0).length;
    return T;
  }

  // ── Tela ──
  function contarAte(el, alvo) {
    const de = st.valorMostrado, ini = performance.now(), dur = de === alvo ? 0 : 900;
    st.valorMostrado = alvo;
    const passo = agora => {
      const p = dur ? Math.min(1, (agora - ini) / dur) : 1, e = 1 - Math.pow(1 - p, 3);
      el.textContent = (de + (alvo - de) * e).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (p < 1) requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  }

  function render() {
    const root = document.getElementById('vm-root'); if (!root) return;
    montarSeletores();
    const T = calcular();
    const varPct = T.fatOntemAgora > 0 ? (T.fat / T.fatOntemAgora - 1) * 100 : null;
    const tacos = T.fat > 0 ? T.ads / T.fat * 100 : 0;
    const conv = T.vis > 0 ? T.pedML / T.vis * 100 : null;
    const temVisitas = Object.keys(st.visitas).length > 0;
    const visTxt = st.mkt !== 'todos' && st.mkt !== 'ml' ? '—' : (temVisitas ? N(T.vis) : '…');

    const big = document.getElementById('vm-total');
    if (big) contarAte(big, T.fat);
    const setTxt = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
    setTxt('vm-var', varPct == null ? 'primeiras vendas do dia' : `<b class="${varPct >= 0 ? 'vm-up' : 'vm-down'}">${varPct >= 0 ? '▲' : '▼'} ${Math.abs(varPct).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</b> vs ontem até esta hora (${R$(T.fatOntemAgora, 0)})`);

    const met = (rot, val, sub = '') => `<div class="vm-met"><span>${rot}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    setTxt('vm-metricas',
      met('Pedidos', N(T.ped)) + met('Unidades', N(T.un)) +
      met('Ticket médio', R$(T.ped ? T.fat / T.ped : 0)) + met(st.cliente ? 'Contas vendendo' : 'Clientes vendendo', `${T.vendendo}<i>/${T.clientes.length}</i>`) +
      met('ADS investido', R$(T.ads, 0), 'hoje') + met('TACOS', T.fat > 0 ? tacos.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—', 'ADS ÷ vendas') +
      met('Visitas', visTxt, st.mkt !== 'todos' && st.mkt !== 'ml' ? 'só Mercado Livre informa' : 'Mercado Livre') + met('Conversão', conv == null ? '—' : conv.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%', 'pedidos ML ÷ visitas'));

    const lista = st.todos ? T.clientes : T.clientes.slice(0, 10);
    const nomeVis = (c, i) => oculta('nomes') ? `${st.cliente ? 'Conta' : 'Cliente'} ${i + 1}` : c.nome;
    document.getElementById('vm-root')?.classList.toggle('vm-sem-painel', oculta('painel'));
    setTxt('vm-ranking', lista.map((c, i) => `
      <div class="vm-cli">
        <span class="vm-pos ${i < 3 && c.fat > 0 ? 'p' + (i + 1) : ''}">${i + 1}</span>
        <div class="vm-cli-n">
          <div class="vm-cli-t"><b title="${h(nomeVis(c, i))}">${h(nomeVis(c, i))}</b>${[...c.mkts].map(m => `<span class="vm-tag" style="--c:${MKT[m].cor}" title="${MKT[m].nome}">${MKT[m].sigla}</span>`).join('')}</div>
          ${oculta('linha') ? '' : `<div class="vm-cli-s"><span>${N(c.ped)} ped.</span><span>ADS ${R$(c.ads, 0)}</span><span>${c.temML ? (temVisitas ? N(c.vis) : '…') : '—'} visitas</span></div>`}
        </div>
        <div class="vm-cli-v">${oculta('valores') ? '<span class="vm-oculto">R$ ••••</span>' : R$(c.fat)}</div>
      </div>`).join('') || `<div class="vm-vazio">Nenhuma conta ${st.cliente ? 'deste cliente ' : 'vinculada '}nesta plataforma.</div>`);
    setTxt('vm-ver-todos', T.clientes.length > 10 ? `<button onclick="window._vmTodos()">${st.todos ? 'Mostrar top 10' : `Ver todos os ${T.clientes.length} ${st.cliente ? 'contas' : 'clientes'}`}</button>` : '');

    setTxt('vm-status', st.erro ? `<span style="color:var(--red)">⚠ ${h(st.erro)}</span>`
      : `${st.carregando ? '⏳ atualizando…' : `atualizado às ${new Date(st.atualizadoEm || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`} · base sincroniza a cada 15 min${st.visitasProg ? ' · ' + st.visitasProg : ''}`);

    desenharGrafico(T);
  }

  function desenharGrafico(T) {
    const cv = document.getElementById('vm-grafico'); if (!cv || typeof Chart === 'undefined') return;
    const hAgora = horaBRT(Date.now());
    const hoje = T.hoje.map((v, i) => (i <= hAgora ? v : null));
    if (st.grafico && st.grafico.canvas === cv) {
      st.grafico.data.datasets[0].data = hoje;
      st.grafico.data.datasets[0].pointRadius = hoje.map((v, i) => (i === hAgora ? 5 : 0));
      st.grafico.data.datasets[1].data = T.ontem;
      st.grafico.stop(); st.grafico.update(); return; // 'none' durante a animação inicial deixava as linhas no zero
    }
    const css = getComputedStyle(document.documentElement);
    const v = (n, d) => (css.getPropertyValue(n) || '').trim() || d;
    const cor = { texto: v('--text-muted', '#8a8ba3'), fundo: v('--bg-card', '#16161f'), borda: v('--border', 'rgba(255,255,255,.08)'), titulo: v('--text-primary', '#f1f1f8') };
    const grad = ctx => { const { chartArea: a } = ctx.chart; if (!a) return '#6d6ff5'; const g = ctx.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, '#6d6ff566'); g.addColorStop(1, '#6d6ff500'); return g; };
    const curto = x => x >= 1e6 ? (x / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'M' : x >= 1e3 ? (x / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'k' : String(x);
    st.grafico = new Chart(cv, {
      type: 'line',
      data: {
        labels: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + 'h'),
        datasets: [
          { label: 'Hoje', data: hoje, borderColor: '#6d6ff5', backgroundColor: grad, fill: 'origin', borderWidth: 2.5, tension: 0.35, cubicInterpolationMode: 'monotone',
            pointRadius: hoje.map((v, i) => (i === hAgora ? 5 : 0)), pointBackgroundColor: '#6d6ff5', pointBorderColor: '#fff', pointBorderWidth: 2, pointHoverRadius: 5 },
          { label: 'Ontem', data: T.ontem, borderColor: '#1baf7a', borderDash: [5, 4], borderWidth: 1.8, tension: 0.35, cubicInterpolationMode: 'monotone', pointRadius: 0, pointHoverRadius: 4, fill: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { align: 'end', labels: { color: cor.texto, usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, font: { size: 11 } } },
          tooltip: { backgroundColor: cor.fundo, titleColor: cor.titulo, bodyColor: cor.texto, borderColor: cor.borda, borderWidth: 1, padding: 10, cornerRadius: 10, usePointStyle: true,
            callbacks: { title: it => `das ${it[0].label.replace('h', '')}:00 às ${it[0].label.replace('h', '')}:59`, label: c => ` ${c.dataset.label}: ${c.raw == null ? '—' : R$(c.raw)}` } },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: cor.texto, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 10 } },
          y: { beginAtZero: true, grid: { color: 'rgba(140,140,170,.12)' }, border: { display: false }, ticks: { color: cor.texto, font: { size: 10 }, maxTicksLimit: 6, callback: x => 'R$ ' + curto(x) } },
        },
      },
    });
  }

  // relógio do topo
  function relogio() {
    const e = document.getElementById('vm-relogio'); if (!e) return false;
    const d = new Date();
    e.textContent = `${d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (Brasília)`;
    return true;
  }

  // ── Ações ──
  function salvarSel() { try { localStorage.setItem('glr_vm_sel', JSON.stringify({ cliente: st.cliente, conta: st.conta })); } catch (e) {} }
  window._vmCliente = v => { st.cliente = v; st.conta = ''; st.todos = false; salvarSel(); render(); };
  window._vmConta = v => { st.conta = v; salvarSel(); render(); };
  // listas de cliente e conta (só clientes com conta vinculada)
  function montarSeletores() {
    const contas = [...contasCarteira().entries()];
    const clientes = new Map(); for (const [, ct] of contas) clientes.set(String(ct.cli.id), ct.cli.nome);
    if (st.cliente && !clientes.has(st.cliente) && !cfgPortal) { st.cliente = ''; st.conta = ''; }
    const doCli = contas.filter(([, ct]) => String(ct.cli.id) === st.cliente);
    if (st.conta && !doCli.some(([k]) => k === st.conta)) st.conta = '';
    const sc = document.getElementById('vm-sel-cliente'), sk = document.getElementById('vm-sel-conta');
    if (sc) sc.hidden = !!cfgPortal || oculta('nomes');
    if (sc && !cfgPortal) sc.innerHTML = `<option value="">Todos os clientes</option>` + [...clientes].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([id, n]) => `<option value="${h(id)}" ${id === st.cliente ? 'selected' : ''}>${h(n)}</option>`).join('');
    if (sk) { sk.hidden = doCli.length < 2 || oculta('nomes'); sk.innerHTML = `<option value="">Todas as contas</option>` + doCli.map(([k, ct]) => `<option value="${h(k)}" ${k === st.conta ? 'selected' : ''}>${MKT[ct.mkt].sigla} · ${h(ct.nome)}</option>`).join(''); }
    const nomeCli = clientes.get(st.cliente), conta = doCli.find(([k]) => k === st.conta)?.[1];
    const t = document.getElementById('vm-hoje'); if (t) t.textContent = `Vendas hoje · ${nomeCli ? (oculta('nomes') ? (conta ? `${MKT[conta.mkt].sigla} · conta selecionada` : 'cliente selecionado') : nomeCli + (conta ? ` · ${MKT[conta.mkt].sigla} ${conta.nome}` : '')) : 'carteira GLR'}`;
    const r = document.getElementById('vm-rank-t'); if (r) r.textContent = st.cliente ? 'Ranking das contas' : 'Ranking de clientes';
  }
  window._vmMkt = v => { st.mkt = v; try { localStorage.setItem('glr_vm_mkt', v); } catch (e) {} document.querySelectorAll('.vm-filtro button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); render(); };
  // Modo foto
  function pintarFoto() {
    const b = document.getElementById('vm-foto-btn'); if (b) b.classList.toggle('on', st.foto.on);
    const m = document.getElementById('vm-foto-menu'); if (!m) return;
    const op = (k, t) => `<label class="vm-foto-op ${st.foto.on ? '' : 'off'}"><input type="checkbox" id="vm-foto-${k}" ${st.foto[k] ? 'checked' : ''} ${st.foto.on ? '' : 'disabled'} onchange="window._vmFotoOp('${k}', this.checked)"> ${t}</label>`;
    m.innerHTML = `<label class="vm-foto-on"><input type="checkbox" id="vm-foto-on" ${st.foto.on ? 'checked' : ''} onchange="window._vmFotoOp('on', this.checked)"> <b>Modo foto</b></label>
      <div class="vm-foto-dica">Esconde dados para tirar print e postar.</div>
      ${op('nomes', 'Ocultar nomes das lojas')}${op('linha', 'Ocultar pedidos, ADS e visitas do ranking')}${op('valores', 'Ocultar valor de cada loja')}${op('painel', 'Ocultar painel de métricas principais')}`;
  }
  window._vmFotoOp = (k, v) => { st.foto[k] = v; try { localStorage.setItem('glr_vm_foto', JSON.stringify(st.foto)); } catch (e) {} pintarFoto(); render(); };
  window._vmFotoMenu = ev => {
    ev?.stopPropagation();
    const m = document.getElementById('vm-foto-menu'); if (!m) return;
    m.hidden = !m.hidden; if (!m.hidden) pintarFoto();
  };
  if (!window._vmFotoFora) { window._vmFotoFora = true; document.addEventListener('click', ev => { const m = document.getElementById('vm-foto-menu'); if (m && !m.hidden && !ev.target.closest('.vm-foto')) m.hidden = true; }); }
  window._vmTodos = () => { st.todos = !st.todos; render(); };
  window._vmTelaCheia = () => { const e = document.querySelector('.vm'); if (!document.fullscreenElement) e?.requestFullscreen?.(); else document.exitFullscreen?.(); };

  const filtro = [['todos', 'Todas'], ['ml', 'Mercado Livre'], ['shopee', 'Shopee'], ['amazon', 'Amazon'], ['tiktok', 'TikTok'], ['magalu', 'Magalu'], ['shein', 'Shein']];
  el.innerHTML = `<div class="vm">
    <div class="vm-hero">
      <img class="vm-marca-agua" src="logo.png" alt="">
      <div class="vm-topo">
        <div class="vm-marca"><img src="logo.png" alt="GLR"><div><b>GLR Consultoria</b><span>Gestão de marketplaces</span></div></div>
        <div class="vm-titulo"><i></i><span>Vendômetro</span><i></i></div>
        <div class="vm-acoes">
          <select class="vm-sel" id="vm-sel-cliente" onchange="window._vmCliente(this.value)"></select>
          <select class="vm-sel" id="vm-sel-conta" onchange="window._vmConta(this.value)" hidden></select>
          <div class="vm-filtro">${filtro.map(([v, t]) => `<button data-v="${v}" class="${st.mkt === v ? 'on' : ''}" onclick="window._vmMkt('${v}')">${t}</button>`).join('')}</div>
          <div class="vm-foto"><button class="vm-cheia ${st.foto.on ? 'on' : ''}" id="vm-foto-btn" title="Modo foto: ocultar nomes e números para print" onclick="window._vmFotoMenu(event)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button><div class="vm-foto-menu" id="vm-foto-menu" hidden></div></div>
          <button class="vm-cheia" title="Tela cheia" onclick="window._vmTelaCheia()">⛶</button>
        </div>
      </div>
      <div class="vm-hoje" id="vm-hoje">Vendas hoje · carteira GLR</div>
      <div class="vm-relogio" id="vm-relogio"></div>
      <div><div class="vm-total"><span class="vm-rs">R$</span><span id="vm-total">0,00</span></div></div>
      <div class="vm-var" id="vm-var"></div>
    </div>
    <div class="vm-grid" id="vm-root">
      <div class="vm-card"><div class="vm-card-t">Métricas principais</div><div class="vm-mets" id="vm-metricas"></div></div>
      <div class="vm-card"><div class="vm-card-t">Tendência de vendas <small>por hora · hoje × ontem</small></div><div class="vm-graf"><canvas id="vm-grafico"></canvas></div></div>
      <div class="vm-card"><div class="vm-card-t"><span id="vm-rank-t">Ranking de clientes</span> <small>vendas de hoje</small></div><div class="vm-rank" id="vm-ranking"></div><div class="vm-todos" id="vm-ver-todos"></div></div>
    </div>
    <div class="vm-rodape"><img src="logo.png" alt=""><span>GLR Consultoria · consultoriaglr.com.br</span><span class="vm-status" id="vm-status"></span></div>
  </div>
  <style>
    .vm{--vm-ind:#6d6ff5;padding:0 0 18px}
    .vm:fullscreen{overflow:auto;padding:16px;background:var(--bg-base,#0d0d14)}
    .vm-hero{position:relative;overflow:hidden;border-radius:18px;padding:18px 28px 30px;text-align:center;color:#fff;
      background:radial-gradient(1200px 400px at 85% -20%,#4b48d8 0%,transparent 60%),linear-gradient(135deg,#07070f 0%,#141634 55%,#262a7a 100%)}
    .vm-marca-agua{position:absolute;right:-60px;top:50%;transform:translateY(-50%) rotate(-8deg);width:420px;height:420px;object-fit:contain;mix-blend-mode:screen;opacity:.09;pointer-events:none}
    .vm-topo{position:relative;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px}
    .vm-marca{display:flex;align-items:center;gap:10px;text-align:left}
    .vm-marca img{width:58px;height:58px;object-fit:contain;mix-blend-mode:screen}
    .vm-marca b{display:block;font-size:14px;letter-spacing:.02em}.vm-marca span{font-size:11px;opacity:.6}
    .vm-titulo{display:flex;align-items:center;gap:14px;font-size:24px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
    .vm-titulo i{width:70px;height:1px;background:rgba(255,255,255,.45)}
    .vm-acoes{display:flex;justify-content:flex-end;gap:8px;align-items:center}
    .vm-filtro{display:flex;border:1px solid rgba(255,255,255,.25);border-radius:9px;overflow:hidden}
    .vm-filtro button{white-space:nowrap;background:none;border:0;color:rgba(255,255,255,.75);font-size:12px;padding:6px 10px;cursor:pointer}
    .vm-filtro button.on{background:rgba(255,255,255,.95);color:#141634;font-weight:700}
    .vm-sel{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25);border-radius:9px;color:#fff;font-size:12px;padding:6px 8px;max-width:190px}
    .vm-sel option{color:#141634}
    .vm-cheia{background:none;border:1px solid rgba(255,255,255,.25);border-radius:9px;color:#fff;width:32px;height:30px;cursor:pointer;font-size:15px}
    .vm-hoje{position:relative;margin-top:14px;font-size:26px;font-weight:800}
    .vm-relogio{position:relative;display:inline-block;margin-top:8px;background:rgba(109,111,245,.9);padding:4px 14px;border-radius:6px;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
    .vm-total{position:relative;display:inline-flex;align-items:baseline;gap:14px;margin-top:16px;background:#fff;color:#141634;border-radius:14px;padding:10px 44px 14px;box-shadow:0 18px 50px rgba(0,0,0,.35);font-variant-numeric:tabular-nums}
    .vm-rs{font-size:40px;font-weight:800;color:var(--vm-ind)}
    #vm-total{font-size:84px;font-weight:900;letter-spacing:-.02em;line-height:1}
    .vm-var{position:relative;margin-top:12px;font-size:13px;color:rgba(255,255,255,.75)}
    .vm-up{color:#4ade80}.vm-down{color:#f87171}
    .vm-foto{position:relative}.vm-cheia{display:inline-grid;place-items:center}.vm-cheia.on{background:#fff;color:#262a7a;border-color:#fff}
    .vm-foto-menu{position:absolute;right:0;top:38px;z-index:20;width:290px;background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:12px;display:flex;flex-direction:column;gap:8px;text-align:left}
    .vm-foto-menu label{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}.vm-foto-menu input{accent-color:var(--accent);width:15px;height:15px}
    .vm-foto-op.off{opacity:.45;cursor:default}.vm-foto-dica{font-size:11.5px;color:var(--text-muted);margin:-4px 0 4px 23px}
    .vm-foto-on{padding-bottom:2px}.vm-oculto{color:var(--text-muted);letter-spacing:1px}
    .vm-grid.vm-sem-painel{grid-template-columns:minmax(0,1.5fr) minmax(320px,1fr)}.vm-grid.vm-sem-painel>.vm-card:first-child{display:none}
    @media (max-width:1180px){.vm-grid.vm-sem-painel{grid-template-columns:1fr}}
    .vm-grid{display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1.3fr) minmax(320px,1fr);gap:16px;margin-top:18px}
    @media (max-width:1180px){.vm-grid{grid-template-columns:1fr 1fr}.vm-grid>.vm-card:nth-child(2){grid-column:1/-1;order:-1}}
    @media (max-width:1100px){.vm-topo{grid-template-columns:1fr}.vm-acoes,.vm-marca{justify-content:center;flex-wrap:wrap}}
    @media (max-width:720px){.vm-grid{grid-template-columns:1fr}.vm-topo{grid-template-columns:1fr}.vm-acoes,.vm-marca{justify-content:center}#vm-total{font-size:48px}.vm-rs{font-size:24px}.vm-total{padding:8px 20px}.vm-titulo i{display:none}}
    .vm-card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:16px 18px;min-width:0;display:flex;flex-direction:column}
    .vm-card-t{font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:12px}.vm-card-t small{font-weight:400;font-size:11px;color:var(--text-muted);margin-left:6px}
    .vm-mets{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--border);border-left:1px solid var(--border);flex:1}
    .vm-met{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:14px 6px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);text-align:center}
    .vm-met span{font-size:12px;color:var(--vm-ind);font-weight:600}
    .vm-met b{font-size:20px;color:var(--text-primary);font-variant-numeric:tabular-nums}.vm-met b i{font-style:normal;font-size:13px;color:var(--text-muted)}
    .vm-met small{font-size:10px;color:var(--text-muted)}
    .vm-graf{position:relative;flex:1;min-height:340px}
    .vm-rank{display:flex;flex-direction:column;gap:6px;max-height:420px;overflow:auto;padding-right:2px}
    .vm-cli{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 10px;border-radius:10px;background:var(--bg-card-hover)}
    .vm-pos{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;color:var(--text-muted)}
    .vm-pos.p1{background:#f5c542;color:#3a2a00}.vm-pos.p2{background:#cfd4dc;color:#2a2f38}.vm-pos.p3{background:#d99a62;color:#3a1f08}
    .vm-cli-t{display:flex;align-items:center;gap:5px;min-width:0}
    .vm-cli-t b{font-size:13px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .vm-tag{flex:none;font-size:9.5px;font-weight:800;color:var(--c);background:color-mix(in srgb,var(--c) 16%,transparent);padding:1px 5px;border-radius:4px}
    .vm-cli-s{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--text-muted);margin-top:2px;font-variant-numeric:tabular-nums}
    .vm-cli-v{font-size:14px;font-weight:800;color:var(--vm-ind);white-space:nowrap;font-variant-numeric:tabular-nums}
    .vm-todos button{margin-top:10px;width:100%;background:none;border:1px dashed var(--border);border-radius:9px;padding:7px;color:var(--text-secondary);cursor:pointer;font-size:12px}
    .vm-vazio{padding:20px;text-align:center;color:var(--text-muted);font-size:13px}
    .vm-rodape{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:11px;color:var(--text-muted);flex-wrap:wrap}
    .vm-rodape img{width:22px;height:22px;object-fit:contain;background:#000;border-radius:5px}
    .vm-status{margin-left:auto}
  </style>`;

  render();
  relogio();
  carregar();

  // Ao vivo: relógio a cada segundo, base a cada 2 min e quando a sincronização termina
  const tRel = setInterval(() => { if (!relogio()) parar(); }, 1000);
  const tBase = setInterval(() => { if (!document.getElementById('vm-root')) return parar(); carregar(); }, 2 * 60e3);
  const aoAtualizar = () => { if (document.getElementById('vm-root')) carregar(); };
  window.addEventListener('glr-base-atualizada', aoAtualizar);
  function parar() { clearInterval(tRel); clearInterval(tBase); window.removeEventListener('glr-base-atualizada', aoAtualizar); if (st.grafico) { st.grafico.destroy(); st.grafico = null; } }
});
