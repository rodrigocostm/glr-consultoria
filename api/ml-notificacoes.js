// ============================================================
// GLR Consultoria — Avisos (notificações) do app da GLR no Mercado Livre
// ------------------------------------------------------------
// URL cadastrada no app do ML em "URL de retornos de chamada de notificação".
// O ML manda um POST a cada pedido/anúncio/mensagem alterado e exige resposta
// 200 rápida (senão desativa os avisos). Por enquanto só confirma o
// recebimento — o motor de dados já sincroniza a cada 15 min. Depois dá pra
// usar estes avisos para atualizar na hora (ex.: tópico orders_v2).
// A autorização das contas fica em /api/ml-oauth.
// ============================================================
module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(JSON.stringify({ ok: true }));
};
