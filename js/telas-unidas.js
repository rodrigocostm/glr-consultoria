// ============================================================
// GLR Consultoria — Telas unidas (uma tela com abas no lugar de várias)
// ------------------------------------------------------------
// Telas parecidas viram uma só, com abas. Cada aba reaproveita a tela que já
// existia (embutida, como na Casa do cliente). O endereço antigo (#conexoes…)
// passa a abrir a tela nova na aba certa. Carregado depois de todas as telas.
// ============================================================
(function () {
  if (typeof Router === 'undefined') return;
  // telas originais, para embutir (o Router.routes[antiga] vira redirecionamento)
  Router.embutiveis = Router.embutiveis || {};
  Router.unidas = Router.unidas || {};

  window.GLR_TELAS_UNIDAS = [
    { rota: 'precos', titulo: 'Monitor de preços', abas: [
      { id: 'precos-ml', nome: 'Mercado Livre' },
      { id: 'precos-shopee', nome: 'Shopee' },
    ] },
    { rota: 'anuncios', titulo: 'Anúncios', abas: [
      { id: 'criar-anuncio', nome: 'Criar anúncio' },
      { id: 'anuncios-novos', nome: 'Anúncios novos' },
    ] },
    { rota: 'sistema', titulo: 'Sistema', abas: [
      { id: 'integracoes', nome: 'Integrações' },
      { id: 'conexoes', nome: 'Conexões' },
      { id: 'saude-api', nome: 'Saúde da API' },
      { id: 'diagnostico', nome: 'Diagnóstico' },
    ] },
  ];

  function unir({ rota, titulo, abas }) {
    const validas = abas.filter(a => Router.routes[a.id]);
    if (!validas.length) return;
    validas.forEach(a => { Router.embutiveis[a.id] = Router.embutiveis[a.id] || Router.routes[a.id]; });
    Router.unidas[rota] = validas.map(a => a.id);

    Router.register(rota, (params, el) => {
      const ativa = validas.some(a => a.id === params.aba) ? params.aba : validas[0].id;
      el.innerHTML = `<div class="page tela-unida">
        <div class="tabs tela-unida-abas" role="tablist" aria-label="${titulo}">
          ${validas.map(a => `<button type="button" role="tab" class="tab-btn${a.id === ativa ? ' active' : ''}" aria-selected="${a.id === ativa}" data-aba="${a.id}">${a.nome}</button>`).join('')}
        </div>
        <div class="tela-unida-corpo"></div>
      </div>`;
      const corpo = el.querySelector('.tela-unida-corpo');
      const abrir = id => {
        el.querySelectorAll('.tela-unida-abas .tab-btn').forEach(b => { const on = b.dataset.aba === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
        try { history.replaceState(null, '', `#${rota}?aba=${id}`); } catch (e) {}
        Router.currentParams = { ...Router.currentParams, aba: id };
        corpo.innerHTML = '';
        Router.embutida = id;
        try { Router.embutiveis[id]({ ...params, aba: undefined, embed: true }, corpo); }
        catch (e) { console.error('[telas-unidas]', id, e); corpo.innerHTML = '<div class="empty-state"><div class="empty-state-title">Não deu para abrir esta aba</div><div class="empty-state-desc">Recarregue a página.</div></div>'; }
      };
      el.querySelectorAll('.tela-unida-abas .tab-btn').forEach(b => { b.onclick = () => abrir(b.dataset.aba); });
      abrir(ativa);
    });

    // endereço antigo → tela nova, na aba certa (mantém os outros parâmetros)
    // (no portal do cliente as telas seguem soltas: o menu dele lista cada uma)
    validas.forEach(a => Router.register(a.id, (params, el) => window._portalConfig ? Router.embutiveis[a.id](params, el) : setTimeout(() => Router.navigate(rota, { ...params, aba: a.id }), 0)));
  }

  window.GLR_TELAS_UNIDAS.forEach(unir);
})();
