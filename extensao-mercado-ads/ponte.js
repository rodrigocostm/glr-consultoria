// GLR Copiloto ADS — ponte no mundo isolado da extensão.
// A página do Mercado Ads não enxerga esta função nem o segredo.
// Só GET no caminho do Product Ads, com o cookie do vendedor.
(function () {
  if (window.__glrPonte) return;
  const BASE = 'https://pa.mercadolivre.com.br/pa/api/admin-pads/ajax';
  const nonce = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2) + Date.now();
  async function buscar(caminho, segredo) {
    if (!chrome.runtime?.id || segredo !== nonce) return { ok: false, erro: 'origem recusada' };
    if (typeof caminho !== 'string' || !caminho.startsWith('/') || caminho.startsWith('//') || caminho.includes('\\') || caminho.includes('://')) {
      return { ok: false, erro: 'caminho recusado' };
    }
    try {
      const r = await fetch(BASE + caminho, { credentials: 'include', redirect: 'manual' });
      return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
    } catch (err) {
      return { ok: false, erro: String(err && err.message || err) };
    }
  }
  window.__glrPonte = buscar;
  window.__glrPonteNonce = nonce;
})();
