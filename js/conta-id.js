// ID da conta no marketplace (seller id do ML, shop id da Shopee, etc.).
// Várias contas podem ter o mesmo nome (ex.: duas "D&L ASSIS" no ML) e só o ID diferencia.
(function () {
  function glrIdConta(c) {
    if (!c) return '';
    const p = c.param_to_use || {};
    return String(p.meliUserId || p.shopId || p.amazon_account_id || p.magalu_account_id || c.external_id || c.id || '');
  }
  // Para <select>: devolve uma função que dá o sufixo " · ID 123" só às contas
  // cujo nome se repete na lista (sem poluir as que já se distinguem pelo nome).
  function glrSufixoIdRepetido(lista, nomeDe, idDe) {
    const chave = c => String(nomeDe(c) ?? '').trim().toLowerCase();
    const cont = new Map();
    (lista || []).forEach(c => { const k = chave(c); cont.set(k, (cont.get(k) || 0) + 1); });
    return c => { const id = idDe(c); return cont.get(chave(c)) > 1 && id ? ` · ID ${id}` : ''; };
  }
  window.glrIdConta = glrIdConta;
  window.glrSufixoIdRepetido = glrSufixoIdRepetido;
})();
