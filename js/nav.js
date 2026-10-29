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
  const GRUPOS = [
    { id: 'hoje', titulo: 'Hoje', paginas: ['dashboard', 'vendometro', 'plano-acao', 'alertas', 'tarefas', 'calendario'] },
    { id: 'clientes', titulo: 'Clientes', paginas: ['clientes', 'projecao', 'vendas', 'gestores', 'relatorios', 'leads', 'portal-admin'] },
    { id: 'ads', titulo: 'ADS e preço', paginas: ['agente', 'agente-ml', 'promocoes', 'precos-ml', 'afiliados'] },
    { id: 'saude', titulo: 'Saúde das contas', paginas: ['estoque-margem', 'atendimento', 'qualidade-anuncios', 'rastreamento'] },
    { id: 'anuncios', titulo: 'Anúncios', paginas: ['produtos', 'anuncios-ml', 'anuncios-shopee', 'anuncios-tiktok', 'anuncios-amazon', 'fotos'] },
    { id: 'financeiro', titulo: 'Financeiro', paginas: ['financeiro', 'dre', 'conciliacao'] },
    { id: 'sistema', titulo: 'Sistema', paginas: ['escritorio', 'ia', 'integracoes', 'timeline', 'diagnostico'] },
  ];
  const K_ABERTOS = 'glr_nav_abertos';
  const lerAbertos = () => { try { const v = JSON.parse(localStorage.getItem(K_ABERTOS) || 'null'); return Array.isArray(v) ? v : ['hoje']; } catch (e) { return ['hoje']; } };
  const salvarAbertos = v => { try { localStorage.setItem(K_ABERTOS, JSON.stringify(v)); } catch (e) {} };
  const paginaAtual = () => (location.hash.replace('#', '') || 'dashboard').split('?')[0];
  const grupoDe = p => (GRUPOS.find(g => g.paginas.includes(p)) || {}).id;
  const chevron = '<svg class="nav-grupo-seta" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>';

  function montar() {
    const sidebar = document.querySelector('.sidebar');
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
    const telas = [...document.querySelectorAll('.sidebar .nav-item[data-page]')].filter(b => getComputedStyle(b).display !== 'none' || b.closest('.nav-grupo'))
      .map(b => ({ tipo: 'Tela', nome: b.textContent.replace(/\s+/g, ' ').trim(), grupo: b.closest('.nav-grupo')?.querySelector('.nav-grupo-tit span')?.textContent || '', ir: () => Router.navigate(b.dataset.page) }));
    const clientes = (window.GLR?.clientes || []).map(c => ({ tipo: 'Cliente', nome: c.nome, grupo: 'Perfil do cliente', ir: () => Router.navigate('cliente-perfil', { id: c.id }) }));
    return [...telas, ...clientes];
  }
  function filtrar(q) {
    const t = semAcento(q).trim();
    const base = todasOpcoes();
    if (!t) return base.filter(o => o.tipo === 'Tela').slice(0, 12);
    return base.map(o => { const n = semAcento(o.nome); const i = n.indexOf(t); return { o, s: i === 0 ? 0 : i > 0 ? 1 : -1 }; })
      .filter(x => x.s >= 0).sort((a, b) => a.s - b.s || (a.o.tipo === 'Tela' ? -1 : 1)).slice(0, 12).map(x => x.o);
  }
  function desenhar() {
    const lista = paleta.querySelector('.cmdk-lista');
    lista.innerHTML = opcoes.length ? opcoes.map((o, i) => `<button type="button" class="cmdk-op ${i === selecionado ? 'on' : ''}" data-i="${i}"><span class="cmdk-tipo">${o.tipo}</span><b>${esc(o.nome)}</b><small>${esc(o.grupo)}</small></button>`).join('')
      : '<div class="cmdk-vazio">Nada encontrado</div>';
    lista.querySelector('.cmdk-op.on')?.scrollIntoView({ block: 'nearest' });
  }
  function abrirPaleta() {
    if (window._portalConfig) return;
    if (!paleta) {
      paleta = document.createElement('div');
      paleta.className = 'cmdk';
      paleta.innerHTML = `<div class="cmdk-caixa" role="dialog" aria-label="Ir para"><input id="cmdk-input" class="cmdk-input" placeholder="Ir para tela ou cliente…" autocomplete="off"><div class="cmdk-lista"></div><div class="cmdk-rodape"><span>↑↓ escolher</span><span>Enter abrir</span><span>Esc fechar</span></div></div>`;
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
    inp.value = ''; selecionado = 0; opcoes = filtrar('');
    paleta.classList.add('on'); desenhar();
    setTimeout(() => inp.focus(), 0);
  }
  function fecharPaleta() { paleta?.classList.remove('on'); }
  function escolher(i) { const o = opcoes[i]; if (!o) return; fecharPaleta(); o.ir(); }
  window.GLRNav = { abrirPaleta, alternar };

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') { e.preventDefault(); paleta?.classList.contains('on') ? fecharPaleta() : abrirPaleta(); }
  });
  window.addEventListener('hashchange', () => { const g = grupoDe(paginaAtual()); if (g) alternar(g, true); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar); else montar();
})();
