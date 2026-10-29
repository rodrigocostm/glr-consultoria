// ============================================================
// GLR Consultoria — Aviso no celular (push) para problemas do sistema
// ------------------------------------------------------------
// Mesmo canal do aviso de venda (push-cron.js): web-push para os aparelhos em
// push_subscriptions. Usado quando algo para a operação — ex.: a cota diária
// da Tiops estourou e a sincronização de pedidos/ADS parou até 21h.
// Sem VAPID configurada não envia nada (e não quebra quem chamou).
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================
const webpush = require('web-push');

async function avisar(sbSelect, titulo, corpo, tag) {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return 0;
  webpush.setVapidDetails('mailto:contatoconsultoriaglr@gmail.com', pub, priv);
  const subs = await sbSelect('push_subscriptions', 'select=endpoint,p256dh,auth').catch(() => []);
  const payload = JSON.stringify({ title: titulo, body: corpo, url: '/index.html', tag: tag || 'sistema' });
  let n = 0;
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); n++; } catch (e) { /* aparelho que saiu: o push-cron limpa */ }
  }
  return n;
}

module.exports = { avisar };
