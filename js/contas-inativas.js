// GLR — lojas marcadas como inativas (glr_storage, chave 'glr_contas_inativas').
// Formato: { "shopee:453420133": { nome, desde, motivo } } (marketplace já normalizado:
// shopee, ml, amazon, tiktok, magalu, shein). Loja inativa sai da sincronização, da
// Saúde das conexões/alertas e das listas de contas; o histórico gravado fica intacto.
(function (root) {
  'use strict';
  const MKT = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : m === 'amazon' ? 'amazon' : ['tiktok', 'tiktok_shop', 'tiktokshop'].includes(m) ? 'tiktok' : m === 'magalu' ? 'magalu' : m === 'shein' ? 'shein' : m; };
  function mapa(dados) {
    if (typeof dados === 'string') { try { dados = JSON.parse(dados); } catch (e) { dados = null; } }
    return dados && typeof dados === 'object' && !Array.isArray(dados) ? dados : {};
  }
  const chave = (mkt, id) => `${MKT(mkt)}:${String(id == null ? '' : id)}`;
  const inativa = (dados, mkt, id) => !!mapa(dados)[chave(mkt, id)];
  // conta no formato da Tiops (marketplace + param_to_use/external_id)
  const idConta = c => String(c?.param_to_use?.shopId || c?.param_to_use?.meliUserId || c?.param_to_use?.amazon_account_id || c?.param_to_use?.magalu_account_id || c?.param_to_use?.shein_supplier_id || c?.external_id || '');
  const contaInativa = (dados, c) => inativa(dados, c?.marketplace, idConta(c));
  const api = Object.freeze({ mapa, chave, inativa, contaInativa });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GLRContasInativas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
