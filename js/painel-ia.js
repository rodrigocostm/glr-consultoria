// ============================================================
// GLR Consultoria — Painel único de IA (lateral)
// ------------------------------------------------------------
// Chat, Adviser e Segundo Cérebro abrem num painel ao lado da tela, sem sair
// dela. O chat usa a mesma conversa em SSE de /api/chat-central e recebe o
// cliente em foco (seletor do topo) e a tela em que a pessoa está.
// Os endereços antigos (#chat, #adviser, #segundo-cerebro, #ia) abrem o painel
// por cima da tela anterior. O portal do cliente não usa este painel.
// ============================================================
(function () {
  if (typeof Router === 'undefined') return;
  const ABAS = [
    { id: 'chat', nome: 'Chat', largo: false },
    { id: 'adviser', nome: 'Adviser', largo: true },
    { id: 'segundo-cerebro', nome: 'Segundo Cérebro', largo: true },
  ];
  Router.embutiveis = Router.embutiveis || {};
  ABAS.forEach(a => { if (Router.routes[a.id]) Router.embutiveis[a.id] = Router.embutiveis[a.id] || Router.routes[a.id]; });

  let painel = null, aba = null, voltarFoco = null;
  const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // a tela em que a pessoa está (vai junto com a pergunta do chat)
  function telaAtual() {
    const t = document.getElementById('page-title')?.textContent?.trim() || '';
    const p = Router.currentPage || '';
    const sub = document.querySelector('.perfil-sub.on, .tela-unida-abas .active')?.textContent?.trim();
    return [t || p, sub].filter(Boolean).join(' › ').slice(0, 80);
  }
  window.glrTelaAtual = telaAtual;

  function montar() {
    if (painel) return painel;
    painel = document.createElement('aside');
    painel.id = 'glr-painel-ia';
    painel.className = 'painel-ia';
    painel.setAttribute('role', 'dialog');
    painel.setAttribute('aria-label', 'Assistente de IA');
    painel.setAttribute('aria-modal', 'false');
    painel.hidden = true;
    painel.innerHTML = `<div class="painel-ia-topo">
        <div class="tabs painel-ia-abas" role="tablist" aria-label="Assistentes">${ABAS.map(a => `<button type="button" role="tab" class="tab-btn" data-aba="${a.id}">${esc(a.nome)}</button>`).join('')}</div>
        <span class="painel-ia-ctx" aria-live="polite"></span>
        <button type="button" class="icon-btn painel-ia-fechar" aria-label="Fechar o painel de IA" title="Fechar (Esc)">✕</button>
      </div>
      <div class="painel-ia-corpo"></div>`;
    document.body.appendChild(painel);
    painel.querySelectorAll('.painel-ia-abas [data-aba]').forEach(b => { b.onclick = () => abrir(b.dataset.aba); });
    painel.querySelector('.painel-ia-fechar').onclick = fechar;
    // Esc fecha (menos quando há um diálogo ou a busca ⌘K por cima)
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e.defaultPrevented || painel.hidden) return;
      if (document.querySelector('.glr-dialogo, .cmdk.on, .modal-overlay')) return;
      fechar();
    });
    return painel;
  }

  function contexto() {
    const el = painel?.querySelector('.painel-ia-ctx');
    if (!el) return;
    const foco = (typeof GLR !== 'undefined' && GLR.ctx?.cliente?.()) || '';
    const nome = foco ? ((typeof GLR !== 'undefined' && GLR.clientes) || []).find(c => String(c.id) === foco)?.nome : '';
    el.textContent = [nome || 'Carteira toda', telaAtual()].filter(Boolean).join(' · ');
  }

  function abrir(id) {
    if (window._portalConfig) return;
    const a = ABAS.find(x => x.id === id) || ABAS[0];
    montar();
    const jaAberto = !painel.hidden;
    if (!jaAberto) voltarFoco = document.activeElement;
    painel.hidden = false;
    document.body.classList.add('com-painel-ia');
    painel.classList.toggle('largo', a.largo);
    document.body.classList.toggle('painel-ia-largo', a.largo);
    painel.querySelectorAll('.painel-ia-abas [data-aba]').forEach(b => { const on = b.dataset.aba === a.id; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
    contexto();
    if (a.id === 'chat' && window._glrChatAgente) aba = null; // "Conversar com o Adviser" abre o chat de novo, já no Adviser
    if (aba !== a.id || !painel.querySelector('.painel-ia-corpo').childElementCount) {
      aba = a.id;
      const corpo = painel.querySelector('.painel-ia-corpo');
      corpo.innerHTML = '';
      const tela = Router.embutiveis[a.id];
      if (tela) {
        try { tela({ embed: true, painel: true }, corpo); }
        catch (e) { console.error('[painel-ia]', a.id, e); corpo.innerHTML = typeof GLR !== 'undefined' && GLR.estado ? GLR.estado('erro', { erro: e, oque: a.nome }) : ''; }
      }
    }
    // no chat o foco vai para a caixa de mensagem; nas outras abas, para a própria aba
    if (!jaAberto) setTimeout(() => ((a.id === 'chat' && painel.querySelector('.painel-ia-corpo textarea')) || painel.querySelector('.painel-ia-abas .active'))?.focus(), 0);
  }

  function fechar() {
    if (!painel || painel.hidden) return;
    painel.hidden = true;
    document.body.classList.remove('com-painel-ia', 'painel-ia-largo');
    if (voltarFoco && voltarFoco.isConnected) voltarFoco.focus();
    voltarFoco = null;
  }
  const alternar = id => (painel && !painel.hidden && (!id || id === aba)) ? fechar() : abrir(id || aba || 'chat');

  window.GLRPainelIA = { abrir, fechar, alternar, telaAtual, aberto: () => !!painel && !painel.hidden };

  // endereço antigo → painel aberto por cima da tela anterior
  let anterior = '';
  window.addEventListener('hashchange', e => {
    const h = String(e.oldURL || '').split('#')[1] || '';
    if (h && !ABAS.some(a => h.split('?')[0] === a.id) && h.split('?')[0] !== 'ia') anterior = h;
  });
  const abrirPorEndereco = id => (params, el) => {
    if (window._portalConfig) { el.innerHTML = ''; return; }
    try { history.replaceState(null, '', '#' + (anterior || 'dashboard')); } catch (e) {}
    abrir(id);
    setTimeout(() => Router.resolve(), 0);
  };
  ABAS.forEach(a => { if (Router.embutiveis[a.id]) Router.register(a.id, abrirPorEndereco(a.id)); });
  Router.register('ia', abrirPorEndereco('chat'));

  // o contexto do topo acompanha a troca de cliente e de tela
  window.addEventListener('glr:cliente', () => { if (painel && !painel.hidden) contexto(); });
  window.addEventListener('hashchange', () => setTimeout(() => { if (painel && !painel.hidden) contexto(); }, 50));
})();
