const test = require('node:test');
const assert = require('node:assert');
const S = require('../js/status-pedido');

test('válidos entram na soma', () => {
  for (const st of ['paid', 'COMPLETED', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'READY_TO_SHIP', 'PROCESSED', 'DELIVERED', 'IN_TRANSIT', 'AWAITING_SHIPMENT', 'Shipped', 'Unshipped', 'approved', 'finished', '5'])
    assert.strictEqual(S.valido({ situacao: 'valido', status_original: st }), true, st);
});

test('cancelados, reembolsados e em aberto ficam fora', () => {
  const casos = { cancelled: 'cancelado', CANCELLED: 'cancelado', IN_CANCEL: 'cancelado', Canceled: 'cancelado', invalid: 'cancelado',
    refunded: 'reembolsado', TO_RETURN: 'reembolsado',
    UNPAID: 'aberto', payment_required: 'aberto', payment_in_process: 'aberto', Pending: 'aberto', ON_HOLD: 'aberto', new: 'aberto' };
  for (const [st, g] of Object.entries(casos)) {
    const c = S.classificar({ situacao: 'valido', status_original: st });
    assert.strictEqual(c.grupo, g, st); assert.strictEqual(c.valido, false, st);
  }
});

test('situação da base manda (devolvido/cancelado) e status da tela funciona', () => {
  assert.strictEqual(S.classificar({ situacao: 'devolvido', status_original: 'paid' }).grupo, 'reembolsado');
  assert.strictEqual(S.classificar({ situacao: 'cancelado', status_original: '6' }).grupo, 'cancelado');
  assert.strictEqual(S.classificar({ status: 'devolvido' }).grupo, 'reembolsado');
  assert.strictEqual(S.classificar({ status: 'paid' }).rotulo, 'Pago');
  assert.strictEqual(S.classificar({ status: 'TO_CONFIRM_RECEIVE' }).rotulo, 'Entregue (aguardando confirmação)');
});

test('situação gravada na base refina o válido', () => {
  assert.strictEqual(S.situacaoBase('valido', 'TO_RETURN'), 'reembolsado');
  assert.strictEqual(S.situacaoBase('valido', 'partially_refunded'), 'valido'); // valor já sem a parte reembolsada
  assert.strictEqual(S.situacaoBase('valido', 'UNPAID'), 'em_aberto');
  assert.strictEqual(S.situacaoBase('valido', 'COMPLETED'), 'valido');
  assert.strictEqual(S.situacaoBase('devolvido', 'COMPLETED'), 'devolvido');
  assert.strictEqual(S.situacaoBase('cancelado', 'CANCELLED'), 'cancelado');
  assert.strictEqual(S.classificar({ situacao: 'reembolsado', status_original: 'COMPLETED' }).grupo, 'reembolsado');
  assert.strictEqual(S.valido({ situacao: 'em_aberto', status_original: '' }), false);
});
