// ============================================================
// GLR Consultoria — Navegação
// ------------------------------------------------------------
// O menu tinha 36 telas em 7 seções sempre abertas. Aqui ele é remontado em
// grupos por tipo de trabalho, que abrem e fecham (fica aberto o grupo da tela
// atual + os que o usuário deixou abertos), e ganha a busca rápida ⌘K / Ctrl+K
// para pular para qualquer tela ou cliente. Os botões originais do index.html
// são reaproveitados (ícone, badge, onclick) — só mudam de lugar.
// O portal do cliente monta o próprio menu (pages-portal.js) e não passa por aqui.
// ============================================================
(function () {
  // Agrupado por tipo de trabalho, grupos curtos (2–7 telas). O grupo da tela
  // atual abre sozinho; os outros ficam abertos/fechados como o usuário deixou.
  const GRUPOS = [
    { id: 'hoje', titulo: 'Hoje', paginas: ['dashboard', 'decisoes', 'vendometro', 'plano-acao', 'tarefas'] },
    { id: 'vendas', titulo: 'Vendas e metas', paginas: ['vendas', 'meu-analitico', 'projecao', 'meta-diaria', 'data-combinada', 'datas-especiais'] },
    { id: 'ads', titulo: 'ADS e promoções', paginas: ['agente', 'agente-ml', 'promocoes', 'afiliados'] },
    { id: 'precos', titulo: 'Preço e concorrência', paginas: ['precos-ml', 'precos-shopee', 'conversao-ml', 'anuncios-amazon', 'mercado-tiops'] },
    { id: 'anuncios', titulo: 'Anúncios e produtos', paginas: ['criar-anuncio', 'anuncios-novos', 'produtos', 'fotos', 'agente-fotos', 'expansao'] },
    { id: 'saude', titulo: 'Saúde das contas', paginas: ['estoque-margem', 'atendimento', 'qualidade-anuncios', 'rastreamento'] },
    { id: 'clientes', titulo: 'Clientes', paginas: ['clientes', 'gestores', 'performance', 'score', 'onboarding', 'retencao', 'rentabilidade', 'portal-admin'] },
    { id: 'relatorios', titulo: 'Relatórios', paginas: ['relatorios', 'relatorio-semanal', 'timeline'] },
    { id: 'financeiro', titulo: 'Financeiro', paginas: ['financeiro', 'vendas-prejuizo', 'dre', 'conciliacao'] },
    { id: 'comercial', titulo: 'Comercial', paginas: ['leads', 'blog'] },
    { id: 'ia', titulo: 'Agentes de IA', paginas: ['adviser', 'chat', 'escritorio', 'segundo-cerebro'] },
    { id: 'sistema', titulo: 'Sistema', paginas: ['sistema'] },
  ];
  const K_ABERTOS = 'glr_nav_abertos_v2'; // v2: grupos novos (o estado antigo tinha outros ids)
  const lerAbertos = () => { try { const v = JSON.parse(localStorage.getItem(K_ABERTOS) || 'null'); return Array.isArray(v) ? v : ['hoje']; } catch (e) { return ['hoje']; } };
  const salvarAbertos = v => { try { localStorage.setItem(K_ABERTOS, JSON.stringify(v)); } catch (e) {} };
  const paginaAtual = () => (location.hash.replace('#', '') || 'dashboard').split('?')[0];
  const grupoDe = p => (GRUPOS.find(g => g.paginas.includes(p)) || {}).id;
  const chevron = '<svg class="nav-grupo-seta" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>';

  function montar() {
    const sidebar = document.getElementById('sidebar') || document.querySelector('.sidebar');
    if (!sidebar || sidebar.dataset.navMontado || window._portalConfig) return;
    const secoes = [...sidebar.querySelectorAll('.sidebar-section')];
    if (!secoes.length) return;
    const botoes = new Map();
    secoes.forEach(s => s.querySelectorAll('.nav-item[data-page]').forEach(b => botoes.set(b.dataset.page, b)));
    if (!botoes.size) return;
    const abertos = new Set(lerAbertos());
    const atualG = grupoDe(paginaAtual());
    if (atualG) abertos.add(atualG);
    const frag = document.createDocumentFragment();
    for (const g of GRUPOS) {
      const itens = g.paginas.map(p => botoes.get(p)).filter(Boolean);
      if (g.id === 'sistema') for (const [p, b] of botoes) if (!GRUPOS.some(x => x.paginas.includes(p))) itens.push(b); // tela nova sem grupo
      if (!itens.length) continue;
      const sec = document.createElement('div');
      sec.className = 'sidebar-section nav-grupo' + (abertos.has(g.id) ? ' aberto' : '');
      sec.dataset.grupo = g.id;
      sec.innerHTML = `<button type="button" class="sidebar-section-title nav-grupo-tit" aria-expanded="${abertos.has(g.id)}">${chevron}<span>${g.titulo}</span><small class="nav-grupo-n">${itens.length}</small></button><div class="nav-grupo-itens"></div>`;
      const caixa = sec.querySelector('.nav-grupo-itens');
      itens.forEach(b => caixa.appendChild(b));
      sec.querySelector('.nav-grupo-tit').addEventListener('click', () => alternar(g.id));
      frag.appendChild(sec);
    }
    secoes[0].parentNode.insertBefore(frag, secoes[0]);
    secoes.forEach(s => s.remove());
    sidebar.dataset.navMontado = '1';
  }

  function alternar(id, forcar) {
    const sec = document.querySelector(`.nav-grupo[data-grupo="${id}"]`);
    if (!sec) return;
    const abrir = forcar ?? !sec.classList.contains('aberto');
    // cada grupo fica como o usuário deixou (abrir um não fecha os outros)
    sec.classList.toggle('aberto', abrir);
    sec.querySelector('.nav-grupo-tit')?.setAttribute('aria-expanded', String(abrir));
    const a = new Set(lerAbertos());
    abrir ? a.add(id) : a.delete(id);
    salvarAbertos([...a]);
  }

  // ── Busca rápida ⌘K / Ctrl+K ──
  let paleta = null, selecionado = 0, opcoes = [];
  const semAcento = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function todasOpcoes() {
    const telas = [...document.querySelectorAll('#sidebar .nav-item[data-page], .sidebar .nav-item[data-page]')].filter(b => getComputedStyle(b).display !== 'none' || b.closest('.nav-grupo'))
      .map(b => ({ tipo: 'Tela', nome: b.textContent.replace(/\s+/g, ' ').trim(), grupo: b.closest('.nav-grupo')?.querySelector('.nav-grupo-tit span')?.textContent || '', ir: () => Router.navigate(b.dataset.page) }));
    const G = typeof GLR !== 'undefined' ? GLR : {};
    // cliente também acha pelo responsável ou pela categoria (como a busca antiga do topo)
    const clientes = (G.clientes || []).map(c => ({ tipo: 'Cliente', nome: c.nome, extra: [c.responsavel, c.categoria, c.gestor].filter(Boolean).join(' '), grupo: [c.categoria, c.gestor].filter(Boolean).join(' · ') || 'Perfil do cliente', ir: () => Router.navigate('cliente-perfil', { id: c.id }) }));
    const tarefas = (G.tarefas || []).map(t => ({ tipo: 'Tarefa', nome: t.titulo, extra: t.cliente, grupo: [t.cliente, t.prazo && typeof formatDate === 'function' ? formatDate(t.prazo) : ''].filter(Boolean).join(' · '), ir: () => Router.navigate('tarefas') }));
    return [...telas, ...clientes, ...tarefas];
  }
  const ORDEM = { Tela: 0, Cliente: 1, Tarefa: 2 };
  function filtrar(q) {
    const t = semAcento(q).trim();
    const base = todasOpcoes();
    if (!t) return base.filter(o => o.tipo === 'Tela').slice(0, 12);
    // 0 = nome começa com o termo, 1 = nome contém, 2 = só responsável/categoria/cliente da tarefa contém
    const achados = base.map(o => { const i = semAcento(o.nome).indexOf(t); return { o, s: i === 0 ? 0 : i > 0 ? 1 : semAcento(o.extra).includes(t) ? 2 : -1 }; })
      .filter(x => x.s >= 0).sort((a, b) => a.s - b.s || ORDEM[a.o.tipo] - ORDEM[b.o.tipo]);
    let nTarefas = 0; // no máximo 4 tarefas, para não esconder telas e clientes
    return achados.filter(x => x.o.tipo !== 'Tarefa' || ++nTarefas <= 4).slice(0, 14).map(x => x.o);
  }
  function desenhar() {
    const lista = paleta.querySelector('.cmdk-lista');
    lista.innerHTML = opcoes.length ? opcoes.map((o, i) => `<button type="button" class="cmdk-op ${i === selecionado ? 'on' : ''}" data-i="${i}"><span class="cmdk-tipo">${o.tipo}</span><b>${esc(o.nome)}</b><small>${esc(o.grupo)}</small></button>`).join('')
      : '<div class="cmdk-vazio">Nada encontrado</div>';
    lista.querySelector('.cmdk-op.on')?.scrollIntoView({ block: 'nearest' });
  }
  let voltarFoco = null;
  function abrirPaleta(inicial) {
    if (window._portalConfig) return;
    voltarFoco = document.activeElement;
    if (!paleta) {
      paleta = document.createElement('div');
      paleta.className = 'cmdk';
      paleta.innerHTML = `<div class="cmdk-caixa" role="dialog" aria-modal="true" aria-label="Buscar"><input id="cmdk-input" class="cmdk-input" placeholder="Buscar tela, cliente ou tarefa…" autocomplete="off" aria-label="Buscar tela, cliente ou tarefa"><div class="cmdk-lista"></div><div class="cmdk-rodape"><span>↑↓ escolher</span><span>Enter abrir</span><span>Esc fechar</span></div></div>`;
      document.body.appendChild(paleta);
      paleta.addEventListener('mousedown', e => { if (e.target === paleta) fecharPaleta(); });
      paleta.querySelector('.cmdk-lista').addEventListener('click', e => { const b = e.target.closest('.cmdk-op'); if (b) escolher(+b.dataset.i); });
      const inp = paleta.querySelector('input');
      inp.addEventListener('input', () => { selecionado = 0; opcoes = filtrar(inp.value); desenhar(); });
      inp.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); selecionado = Math.min(opcoes.length - 1, selecionado + 1); desenhar(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); selecionado = Math.max(0, selecionado - 1); desenhar(); }
        else if (e.key === 'Enter') { e.preventDefault(); escolher(selecionado); }
        else if (e.key === 'Escape') fecharPaleta();
      });
    }
    const inp = paleta.querySelector('input');
    inp.value = typeof inicial === 'string' ? inicial : ''; selecionado = 0; opcoes = filtrar(inp.value);
    paleta.classList.add('on'); desenhar();
    inp.focus(); // na hora: quem já começou a digitar no botão da busca não perde letras
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {}
  }
  function fecharPaleta() {
    if (!paleta?.classList.contains('on')) return;
    paleta.classList.remove('on');
    try { voltarFoco?.focus?.(); } catch (e) {}
  }
  // Botão de busca do topo (aparece também no celular): abre a paleta; digitar com ele focado já começa a busca
  function ligarBotaoBusca() {
    const bt = document.getElementById('global-search');
    if (!bt || bt.dataset.ligado) return;
    bt.dataset.ligado = '1';
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const kbd = bt.querySelector('.search-box-kbd'); if (kbd && !mac) kbd.textContent = 'Ctrl K';
    bt.addEventListener('click', () => abrirPaleta());
    bt.addEventListener('keydown', e => { if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== ' ') { e.preventDefault(); abrirPaleta(e.key); } });
    if (window._portalConfig) bt.hidden = true;
  }
  function escolher(i) { const o = opcoes[i]; if (!o) return; voltarFoco = null; fecharPaleta(); o.ir(); }
  // ── Cliente em foco (GLR.ctx, em data.js): um seletor na barra de cima ──
  function montarSeletorCliente() {
    if (document.getElementById('ctx-cliente') || window._portalConfig) return;
    const titulos = document.querySelector('.header-titulos');
    if (!titulos || typeof GLR === 'undefined' || !GLR.ctx) return;
    const box = document.createElement('label');
    box.className = 'ctx-box';
    box.title = 'Cliente em foco — as telas abrem direto nas contas dele';
    box.innerHTML = '<span class="ctx-rot">Cliente</span><select id="ctx-cliente" class="ctx-sel" aria-label="Cliente em foco"><option value="">Todos os clientes</option></select>';
    titulos.after(box);
    const sel = box.querySelector('select');
    const preencher = () => {
      if (window._portalConfig) { box.remove(); return; }
      const atual = GLR.ctx.cliente();
      const cls = (GLR.clientes || []).slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
      sel.innerHTML = '<option value="">Todos os clientes</option>' + cls.map(c => `<option value="${esc(c.id)}">${esc(c.nome)}</option>`).join('');
      sel.value = cls.some(c => String(c.id) === atual) ? atual : '';
      box.classList.toggle('on', !!sel.value);
    };
    sel.addEventListener('change', () => { box.classList.toggle('on', !!sel.value); GLR.ctx.definir(sel.value); });
    window.addEventListener('glr:cliente', e => { if (sel.value !== e.detail.id) { sel.value = e.detail.id; box.classList.toggle('on', !!sel.value); } });
    if (GLR.quandoClientes) GLR.quandoClientes(preencher); else preencher();
    setTimeout(preencher, 4000); // clientes podem chegar depois (sincronização)
  }

  // contador da Caixa de decisões no menu (a tela avisa quando carrega/resolve)
  window.addEventListener('glr:decisoes', e => { const b = document.getElementById('badge-decisoes'); if (!b) return; const n = e.detail?.n || 0; b.textContent = n > 99 ? '99+' : n; b.style.display = n ? '' : 'none'; });

  // ── Menu em 2 modos ──
  // Carteira (sem cliente em foco): os grupos de sempre.
  // Cliente (com foco): no topo, as seções da Casa do cliente; as telas que já
  // vivem dentro da Casa somem dos grupos, e abrir uma delas pelo endereço antigo
  // (#agente, #financeiro…) leva para a aba certa do perfil (ver Router.resolve).
  function casaDe(pagina, params) {
    // tela unida (ex.: Preços com abas ML/Shopee): vale a aba pedida, ou a primeira
    const un = typeof Router !== 'undefined' && Router.unidas?.[pagina];
    if (un) return casaDe(un.includes(params?.aba) ? params.aba : un[0]);
    const abas = window.GLR_PERFIL_ABAS || [];
    for (const a of abas) for (const s of a.subs) if (s.rota === pagina) return { aba: a.id, sub: s.id };
    return null;
  }
  function nomeCliente(id) { const c = ((typeof GLR !== 'undefined' && GLR.clientes) || []).find(x => String(x.id) === String(id)); return c ? c.nome : 'Cliente'; }
  function atualizarModo() {
    const sb = document.getElementById('sidebar');
    if (!sb || !sb.dataset.navMontado || window._portalConfig) return;
    const foco = (typeof GLR !== 'undefined' && GLR.ctx?.cliente?.()) || '';
    const abas = window.GLR_PERFIL_ABAS || [];
    sb.classList.toggle('modo-cliente', !!foco);
    let box = document.getElementById('nav-cliente');
    if (!foco || !abas.length) { box?.remove(); }
    else {
      if (!box) {
        box = document.createElement('div');
        box.id = 'nav-cliente'; box.className = 'sidebar-section nav-cliente';
        sb.querySelector('.nav-grupo')?.before(box);
      }
      const p = Router.currentPage === 'cliente-perfil' ? (Router.currentParams || {}) : {};
      const naCasa = p.id != null && String(p.id) === foco;
      box.innerHTML = `<div class="nav-cliente-topo"><span class="nav-cliente-nome" title="${esc(nomeCliente(foco))}">${esc(nomeCliente(foco))}</span><button type="button" class="nav-cliente-sair" data-sair>Carteira</button></div>`
        + abas.map(a => `<button type="button" class="nav-item nav-casa${naCasa && (p.aba || 'visao') === a.id ? ' active' : ''}" data-aba="${a.id}" data-ini="${esc(a.nome.charAt(0))}" title="${esc(a.nome)}">${esc(a.nome)}</button>`).join('');
      box.querySelector('[data-sair]').onclick = () => { GLR.ctx.definir(''); };
      box.querySelectorAll('[data-aba]').forEach(b => { b.onclick = () => Router.navigate('cliente-perfil', { id: foco, aba: b.dataset.aba }); });
    }
    // esconde dos grupos o que já está dentro da Casa (e o grupo que ficar vazio)
    sb.querySelectorAll('.nav-grupo').forEach(g => {
      const itens = [...g.querySelectorAll('.nav-item[data-page]')];
      let vis = 0;
      itens.forEach(b => { const dentro = !!foco && !!casaDe(b.dataset.page); b.classList.toggle('na-casa', dentro); if (!dentro) vis++; });
      g.classList.toggle('so-casa', !vis);
      const n = g.querySelector('.nav-grupo-n'); if (n) n.textContent = vis;
    });
  }

  window.GLRNav = { abrirPaleta, fecharPaleta, alternar, filtrar, fecharMenuCelular: () => fecharMenuCelular(), casaDe, atualizarModo };

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') { e.preventDefault(); paleta?.classList.contains('on') ? fecharPaleta() : abrirPaleta(); }
  });
  window.addEventListener('hashchange', () => { const g = grupoDe(paginaAtual()); if (g) alternar(g, true); fecharMenuCelular(); });

  // ── Menu do celular: fecha ao navegar e com Esc; o botão diz se está aberto ──
  const celular = () => window.innerWidth <= 900;
  function fecharMenuCelular(voltarFoco) {
    const sb = document.getElementById('sidebar');
    if (!sb || !sb.classList.contains('open')) return;
    sb.classList.remove('open');
    if (voltarFoco) document.getElementById('sidebar-toggle')?.focus();
  }
  function ligarMenuCelular() {
    const sb = document.getElementById('sidebar'), bt = document.getElementById('sidebar-toggle');
    if (!sb || !bt || bt.dataset.menuLigado) return;
    bt.dataset.menuLigado = '1';
    bt.setAttribute('aria-controls', 'sidebar');
    const marcar = () => bt.setAttribute('aria-expanded', String(sb.classList.contains('open')));
    marcar();
    new MutationObserver(marcar).observe(sb, { attributes: true, attributeFilter: ['class'] });
    // tocar num item leva para a tela e já fecha o menu (mesmo se for a tela atual)
    sb.addEventListener('click', e => { if (celular() && e.target.closest?.('.nav-item')) setTimeout(() => fecharMenuCelular(), 0); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && sb.classList.contains('open') && !paleta?.classList.contains('on')) fecharMenuCelular(true); });
  }
  window.addEventListener('glr:cliente', () => atualizarModo());
  window.addEventListener('hashchange', () => setTimeout(atualizarModo, 0));
  const iniciar = () => { montar(); montarSeletorCliente(); ligarBotaoBusca(); ligarMenuCelular(); atualizarModo(); if (typeof GLR !== 'undefined' && GLR.quandoClientes) GLR.quandoClientes(atualizarModo); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
