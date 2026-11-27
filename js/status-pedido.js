// GLR — status do pedido e regra única de "pedido válido" para as somas.
// Entra na soma (faturamento, comissão, vendômetro, totais) só o pedido válido:
// fora ficam cancelados, reembolsados/devolvidos (inclusive devolução em
// andamento e reembolso parcial) e pedidos em aberto (sem pagamento confirmado).
// Usa só o que a sincronização já grava: situacao (valido/cancelado/devolvido)
// e o status original do marketplace. Usado no navegador e no servidor.
(function (root) {
  'use strict';

  // status original (qualquer marketplace) → [rótulo, grupo]
  // grupos: valido | cancelado | reembolsado | aberto
  const MAPA = {
    // Mercado Livre
    paid: ['Pago', 'valido'], confirmed: ['Confirmado', 'valido'],
    payment_required: ['Aguardando pagamento', 'aberto'], payment_in_process: ['Pagamento em processamento', 'aberto'],
    partially_paid: ['Pago parcialmente', 'aberto'], pending_cancel: ['Cancelamento pendente', 'cancelado'],
    partially_refunded: ['Reembolso parcial', 'reembolsado'], refunded: ['Reembolsado', 'reembolsado'],
    // Shopee
    unpaid: ['Aguardando pagamento', 'aberto'], ready_to_ship: ['Pronto para envio', 'valido'],
    processed: ['Processado', 'valido'], retry_ship: ['Reenvio', 'valido'], shipped: ['Enviado', 'valido'],
    to_confirm_receive: ['Entregue (aguardando confirmação)', 'valido'], completed: ['Concluído', 'valido'],
    to_return: ['Devolução/reembolso em andamento', 'reembolsado'], in_cancel: ['Em cancelamento', 'cancelado'],
    invoice_pending: ['Aguardando nota fiscal', 'valido'],
    // TikTok Shop
    on_hold: ['Em espera (cliente pode cancelar)', 'aberto'], awaiting_shipment: ['Aguardando envio', 'valido'],
    partially_shipping: ['Envio parcial', 'valido'], awaiting_collection: ['Aguardando coleta', 'valido'],
    in_transit: ['Em trânsito', 'valido'], delivered: ['Entregue', 'valido'],
    // Amazon
    pending: ['Pendente (aguardando pagamento)', 'aberto'], pendingavailability: ['Pendente (pré-venda)', 'aberto'],
    unshipped: ['Não enviado', 'valido'], partiallyshipped: ['Enviado parcialmente', 'valido'],
    invoiceunconfirmed: ['Nota não confirmada', 'valido'], unfulfillable: ['Não atendível', 'cancelado'],
    // Magalu
    new: ['Novo (aguardando pagamento)', 'aberto'], created: ['Criado (aguardando pagamento)', 'aberto'],
    approved: ['Aprovado', 'valido'], invoiced: ['Faturado', 'valido'], finished: ['Concluído', 'valido'],
    // genéricos
    cancelled: ['Cancelado', 'cancelado'], canceled: ['Cancelado', 'cancelado'], cancelled_unpaid: ['Cancelado (não pago)', 'cancelado'],
    invalid: ['Inválido', 'cancelado'], incomplete: ['Incompleto', 'aberto'], awaiting_payment: ['Aguardando pagamento', 'aberto'],
    devolvido: ['Devolvido', 'reembolsado'],
  };
  const ROTULO_GRUPO = { valido: 'Válido', cancelado: 'Cancelado', reembolsado: 'Reembolsado', aberto: 'Em aberto' };

  function normal(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[\s-]+/g, '_'); }

  // Classifica um pedido. Aceita a linha da base (situacao, status_original) ou
  // o pedido da tela ({ status }, onde 'devolvido' já vem da situação).
  function classificar(p) {
    p = p || {};
    const sit = String(p.situacao || '').toLowerCase();
    const bruto = p.status_original != null ? p.status_original : p.status;
    const k = normal(bruto);
    const m = MAPA[k] || MAPA[k.replace(/_/g, '')];
    let grupo = m ? m[1] : null;
    let rotulo = m ? m[0] : (bruto ? String(bruto) : '');
    if (!grupo) {
      if (/cancel|invalid/.test(k)) grupo = 'cancelado';
      else if (/refund|return|devol|reembols/.test(k)) grupo = 'reembolsado';
      else if (/unpaid|pending|awaiting_payment|payment_required|on_hold|incomplete/.test(k)) grupo = 'aberto';
      else grupo = 'valido';
    }
    // a base manda: cancelado/devolvido gravado pela sincronização vale mais que o status
    if (sit === 'cancelado' && grupo !== 'cancelado') { grupo = 'cancelado'; rotulo = rotulo ? `Cancelado (${rotulo})` : 'Cancelado'; }
    else if (sit === 'devolvido' && grupo !== 'reembolsado') { grupo = 'reembolsado'; rotulo = 'Devolvido'; }
    if (!rotulo) rotulo = grupo === 'valido' ? 'Sem status' : ROTULO_GRUPO[grupo];
    // Shein grava só o código numérico
    if (/^\d+$/.test(k)) rotulo = grupo === 'valido' ? `Shein · código ${k}` : `${ROTULO_GRUPO[grupo]} (código ${k})`;
    return { grupo, rotulo, valido: grupo === 'valido' };
  }

  const valido = p => classificar(p).valido;

  const api = Object.freeze({ classificar, valido, ROTULO_GRUPO });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GLRStatusPedido = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
