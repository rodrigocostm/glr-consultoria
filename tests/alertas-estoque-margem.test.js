const test = require('node:test');
const assert = require('node:assert');
const { alertasDe } = require('../api/_estoque-margem');

test('alertas: ruptura, prejuízo e margem baixa, ignorando quem quase não vende', () => {
  const itens = {
    a: { n: 'Zerado campeão', u30: 30, u14: 10, vd: 1, p: 100, e: 0, d: 0, ne: 'zerado', m: 20, nm: 'ok' },
    b: { n: 'Acaba logo', u30: 10, vd: 0.5, p: 50, e: 3, d: 6, ne: 'critico', m: 15, nm: 'ok' },
    c: { n: 'Pouca venda', u30: 1, vd: 0.03, p: 50, e: 0, d: null, ne: 'zerado', m: -10, nm: 'negativa' },
    d: { n: 'Prejuízo', u30: 20, vd: 0.7, p: 80, e: 100, d: 140, ne: 'ok', m: -5, nm: 'negativa', c: 60 },
    e: { n: 'Apertado', u30: 12, vd: 0.4, p: 40, e: 100, d: 250, ne: 'ok', m: 3, nm: 'apertada' },
  };
  const al = alertasDe(itens, 5);
  assert.deepStrictEqual(al.filter(x => x.t === 'ruptura').map(x => x.id).join(), 'a,b');
  const pj = al.find(x => x.t === 'prejuizo');
  assert.strictEqual(pj.id, 'd');
  assert.strictEqual(pj.perda, 80); // 5% × R$ 80 × 20 vendas
  assert.strictEqual(al.filter(x => x.t === 'margem_baixa').map(x => x.id).join(), 'e');
  assert.ok(!al.some(x => x.id === 'c'));
  // zerado que não vende há 14 dias ou anúncio excluído: fora
  const al2 = alertasDe({ x: { n: 'Velho', u30: 9, u14: 0, vd: 0.3, p: 50, e: 0, ne: 'zerado' }, y: { n: 'Excluído', u30: 9, u14: 5, vd: 0.3, p: 50, e: 0, ne: 'zerado', st: 'SELLER_DELETE' } }, 5);
  assert.strictEqual(al2.length, 0);
});
