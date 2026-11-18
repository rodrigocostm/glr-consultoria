// ============================================================
// GLR Consultoria — Ícone do marketplace nas contas
// ------------------------------------------------------------
// Em todas as telas, a etiqueta da conta ("Shopee", "Mercado Livre", "ML",
// "SH", "TT", "Amazon", "TikTok Shop"…) ganha o ícone do marketplace na frente.
// As telas desenham essas etiquetas de muitos jeitos, então em vez de mexer em
// cada uma, um observador olha o que entra na página e coloca o ícone no texto
// que COMEÇA com o nome/sigla do marketplace (texto curto, tipo etiqueta).
// Para usar direto num HTML novo: GLR.iconeMkt('shopee'). Para não pôr ícone
// num trecho: class="mkt-sem-icone".
// ============================================================
(function () {
  const SRC = { ml: 'img/mkt/ml.png', shopee: 'img/mkt/shopee.png', amazon: 'img/mkt/amazon.png', tiktok: 'img/mkt/tiktok.png' };
  const NOME = { ml: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', tiktok: 'TikTok Shop' };
  const FIM = '(?=$|[\\s·:\\-—|,.()0-9/])';
  // nomes escritos por extenso (qualquer caixa) e siglas (só maiúsculas, para não pegar palavras comuns)
  const RE_NOME = new RegExp(`^(mercado ?livre|shopee|amazon|tiktok(?: shop)?|meli)${FIM}`, 'i');
  const RE_SIGLA = new RegExp(`^(ML|SH|TT|AMZ)${FIM}`);
  const mktDe = t => {
    const m = RE_NOME.exec(t) || RE_SIGLA.exec(t); if (!m) return null;
    const k = m[1].toLowerCase().replace(/\s+/g, '');
    return k === 'mercadolivre' || k === 'meli' || k === 'ml' ? 'ml' : k === 'shopee' || k === 'sh' ? 'shopee' : k === 'amazon' || k === 'amz' ? 'amazon' : 'tiktok';
  };
  // nome de conta que TERMINA com o marketplace: "Zion - Shopee", "CJ Decor Shopee", "Mega Facil - ML"
  const RE_FIM_NOME = /(?:^|[\s\-–—·|(])(mercado ?livre|shopee|amazon|tiktok(?: shop)?|meli)\s*\)?\s*$/i;
  const RE_FIM_SIGLA = /(?:^|[\s\-–—·|(])(ML|SH|TT|AMZ)\s*\)?\s*$/;
  const mktDoFim = t => { const m = RE_FIM_NOME.exec(t) || RE_FIM_SIGLA.exec(t); return m ? mktDe(m[1]) : null; };
  const img = mkt => `<img class="mkt-ic mkt-ic-${mkt}" src="${SRC[mkt]}" alt="" aria-hidden="true" loading="lazy">`;

  // ícone para usar direto no HTML; aceita 'ml', 'meli', 'mercadolivre', 'Mercado Livre', 'shopee', 'amazon', 'tiktok', 'tiktok_shop'…
  if (typeof GLR !== 'undefined') GLR.iconeMkt = m => {
    const k = String(m || '').toLowerCase().replace(/[\s_]+/g, '');
    const mkt = ['ml', 'meli', 'mercadolivre'].includes(k) ? 'ml' : k === 'shopee' ? 'shopee' : k === 'amazon' ? 'amazon' : k.startsWith('tiktok') ? 'tiktok' : null;
    return mkt ? img(mkt) : '';
  };

  const PULA = 'select,option,textarea,input,script,style,svg,[contenteditable="true"],.mkt-sem-icone,title,head';
  function decorar(el) {
    if (!el || el.nodeType !== 1 || el.dataset?.mktIc) return;
    const primeiro = el.firstChild;
    if (!primeiro || primeiro.nodeType !== 3) return;
    const texto = primeiro.nodeValue.replace(/^\s+/, '');
    if (!texto || texto.length > 90) return;
    let mkt = texto.length <= 60 ? mktDe(texto) : null, corte = 0;
    if (!mkt) { // "Cliente · Shopee Loja" (GLR.nomeConta): ícone antes do marketplace, no meio do texto
      const i = texto.indexOf(' · ');
      if (i > 0 && i < 50) { mkt = mktDe(texto.slice(i + 3)); corte = i + 3; }
      if (!mkt && texto.length <= 60 && el.childElementCount === 0) { mkt = mktDoFim(texto); corte = 0; }
      if (!mkt) return;
    }
    if (el.childElementCount > 4 || (el.textContent || '').length > 100) return; // etiqueta, não parágrafo
    if (el.closest(PULA)) return;
    const prev = el.previousElementSibling;
    if (el.querySelector(':scope > img.mkt-ic') || (prev && prev.classList?.contains('mkt-ic'))) return;
    el.dataset.mktIc = mkt;
    if (!el.getAttribute('title') && /^(ML|SH|TT|AMZ)$/.test(texto.trim())) el.setAttribute('title', NOME[mkt]);
    if (corte) {
      const resto = primeiro.splitText(primeiro.nodeValue.length - (texto.length - corte));
      const t = document.createElement('template'); t.innerHTML = img(mkt);
      el.insertBefore(t.content.firstChild, resto);
      return;
    }
    primeiro.nodeValue = texto;
    el.insertAdjacentHTML('afterbegin', img(mkt));
  }
  function varrer(raiz) {
    if (!raiz || raiz.nodeType !== 1) return;
    if (raiz.closest && raiz.closest(PULA)) return;
    decorar(raiz);
    const w = document.createTreeWalker(raiz, NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => n.matches(PULA) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let n; while ((n = w.nextNode())) decorar(n);
  }

  let fila = new Set(), agendado = false;
  const processar = () => { agendado = false; const lote = fila; fila = new Set(); for (const n of lote) if (n.isConnected) varrer(n); };
  const obs = new MutationObserver(ms => {
    for (const m of ms) {
      if (m.type !== 'childList') continue;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) { if (!n.classList?.contains('mkt-ic')) fila.add(n); }
        else if (n.nodeType === 3 && n.parentElement && !n.parentElement.querySelector(':scope > img.mkt-ic')) { delete n.parentElement.dataset.mktIc; fila.add(n.parentElement); } // texto trocado (textContent =)
      }
    }
    if (fila.size && !agendado) { agendado = true; requestAnimationFrame(processar); }
  });

  function iniciar() {
    if (!document.getElementById('mkt-ic-css')) {
      const s = document.createElement('style'); s.id = 'mkt-ic-css';
      s.textContent = `.mkt-ic{display:inline-block;width:1.15em;height:1.15em;min-width:1.15em;border-radius:50%;object-fit:cover;vertical-align:-0.22em;margin-right:.35em;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.06)}
.mkt-ic-shopee{transform:scale(1.04)}`;
      document.head.appendChild(s);
    }
    varrer(document.body);
    obs.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
