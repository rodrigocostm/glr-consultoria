// GLR Copiloto ADS — ponte (roda no contexto da página do Mercado Ads).
// Faz as mesmas chamadas de leitura que a própria página faz (pa.mercadolivre.com.br/.../admin-pads/ajax),
// com a sessão do usuário, e devolve o JSON para o painel. Só GET e só esse caminho: nada é alterado no ML.
(function () {
  if (window.__glrPonte) return; window.__glrPonte = true;
  const BASE = 'https://pa.mercadolivre.com.br/pa/api/admin-pads/ajax';
  window.addEventListener('message', async e => {
    const m = e.data; if (e.source !== window || !m || m.glr !== 'req' || typeof m.caminho !== 'string' || !m.caminho.startsWith('/')) return;
    let resp;
    try { const r = await fetch(BASE + m.caminho, { credentials: 'include' }); resp = { ok: r.ok, status: r.status, json: await r.json().catch(() => null) }; }
    catch (err) { resp = { ok: false, erro: String(err && err.message || err) }; }
    window.postMessage({ glr: 'resp', id: m.id, ...resp }, '*');
  });
})();
