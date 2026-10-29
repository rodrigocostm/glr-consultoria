// ============================================================
// GLR Consultoria — Ajustes de interface que valem para todas as telas
// ------------------------------------------------------------
//  • Explicação sob demanda: texto com classe "ajuda" (ou as notas antigas
//    .ag-nota) fica escondido e ganha um botão ⓘ ao lado do título do bloco —
//    o número aparece primeiro, a explicação só quando o usuário pede.
//  • Coluna vazia some: em qualquer tabela da tela, coluna em que todas as
//    linhas são "—" (ou vazias) é escondida — menos colunas encavaladas.
//    Tabela que precisa de todas as colunas: data-todas-colunas.
// Roda sozinho (observa #page-content); as telas não precisam chamar nada.
// ============================================================
(function () {
  const SELETOR_AJUDA = '.ajuda, .ag-nota';
  const abertas = new Set(); // explicações abertas nesta sessão (sobrevive ao redesenho da tela)
  const chave = el => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);

  function prepararAjuda(raiz) {
    raiz.querySelectorAll(SELETOR_AJUDA).forEach(el => {
      if (el.dataset.ajuda) return;
      el.dataset.ajuda = '1';
      const k = chave(el);
      if (!k) return;
      const bt = document.createElement('button');
      bt.type = 'button';
      bt.className = 'ajuda-bt';
      bt.title = 'Como ler';
      bt.setAttribute('aria-label', 'Mostrar explicação');
      bt.textContent = 'ⓘ';
      const aberto = abertas.has(k);
      el.classList.toggle('ajuda-fechada', !aberto);
      bt.setAttribute('aria-expanded', String(aberto));
      bt.addEventListener('click', e => {
        e.stopPropagation();
        const abrir = el.classList.contains('ajuda-fechada');
        el.classList.toggle('ajuda-fechada', !abrir);
        bt.setAttribute('aria-expanded', String(abrir));
        abrir ? abertas.add(k) : abertas.delete(k);
      });
      // o ⓘ vai no título do bloco (irmão anterior curto); sem título, logo antes do texto
      const ant = el.previousElementSibling;
      const titulo = ant && !ant.matches(SELETOR_AJUDA) && ant.textContent.trim().length < 140 && !ant.querySelector('input,select,textarea,table,canvas') ? ant : null;
      if (titulo) { const alvo = titulo.querySelector('.ag-sec-titulo, .section-title, b, strong') || titulo; alvo.appendChild(bt); }
      else { const linha = document.createElement('div'); linha.className = 'ajuda-linha'; linha.appendChild(bt); el.before(linha); }
    });
  }

  const vazio = t => { const s = t.replace(/\s+/g, ' ').trim(); return !s || s === '—' || s === '-' || s === '–'; };
  function ocultarColunasVazias(raiz) {
    raiz.querySelectorAll('table').forEach(tab => {
      if (tab.hasAttribute('data-todas-colunas')) return;
      const cab = tab.tHead?.rows[0];
      const corpo = tab.tBodies[0];
      if (!cab || !corpo) return;
      const n = cab.cells.length;
      const linhas = [...corpo.rows].filter(r => r.cells.length === n); // linhas expandidas (colspan) ficam de fora
      if (linhas.length < 3) return;
      for (let c = 1; c < n; c++) {
        const semDado = linhas.every(r => vazio(r.cells[c].textContent));
        if (semDado === cab.cells[c].classList.contains('col-vazia')) continue;
        cab.cells[c].classList.toggle('col-vazia', semDado);
        linhas.forEach(r => r.cells[c].classList.toggle('col-vazia', semDado));
      }
    });
  }

  let agendado = null;
  function passar() {
    agendado = null;
    const raiz = document.getElementById('page-content');
    if (!raiz) return;
    try { prepararAjuda(raiz); } catch (e) {}
    try { ocultarColunasVazias(raiz); } catch (e) {}
  }
  function iniciar() {
    const raiz = document.getElementById('page-content');
    if (!raiz) return;
    new MutationObserver(() => { if (!agendado) agendado = setTimeout(passar, 120); }).observe(raiz, { childList: true, subtree: true });
    passar();
  }
  window.GLRUI = { atualizar: passar };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
