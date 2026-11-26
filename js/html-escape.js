// Um único escape para texto e atributo HTML. Cobre & < > " '.
// Dado de marketplace, cliente ou mensagem nunca entra em innerHTML sem passar por aqui.
(function () {
  const MAPA = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function glrEsc(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, c => MAPA[c]);
  }
  window.glrEsc = glrEsc;
})();
