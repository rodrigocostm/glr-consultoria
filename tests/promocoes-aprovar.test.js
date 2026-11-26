const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const ctx = { window: {}, console };
vm.runInNewContext(fs.readFileSync(__dirname + '/../js/acoes-agente.js', 'utf8'), ctx);
const { promocoesParaAprovar, tipoDe } = ctx.window.GLRAcoes;

const itens = {
  MLB1: { n: 'Cadeira', p: 100, e: 5, parado: true, melhor: { id: 'P-1', ref: 'OF-1', tipo: 'DEAL', rot: 'Campanha do ML', preco: 89.9, desconto: 10.1, m: 12.5 } },
  MLB2: { n: 'Mesa', p: 300, e: 2, melhor: { tipo: 'PRICE_DISCOUNT', rot: 'Desconto próprio', preco: 270, m: 9 } },
  MLB3: { n: 'Cupom', p: 50, melhor: { id: 'C', tipo: 'SELLER_COUPON_CAMPAIGN', preco: 45, m: 10 } },
  MLB4: { n: 'Zerado', p: 50, e: 0, melhor: { id: 'X', tipo: 'DEAL', preco: 45, m: 10 } },
  MLB5: { n: 'Vencida', p: 50, melhor: { id: 'Y', tipo: 'DEAL', preco: 45, m: 10, fim: '2020-01-01T00:00:00Z' } },
  MLB6: { n: 'Co-participada', p: 80, melhor: { id: 'S', ref: 'R', tipo: 'SMART', rot: 'Campanha co-participada', preco: 70, m: 8 } },
  MLB7: { n: 'Sem sugestão', p: 10, melhor: null },
};

test('mural de promoções do ML vira sugestão aprovável', () => {
  const r = promocoesParaAprovar('123', itens);
  assert.strictEqual(JSON.stringify(r.map(x => x.dados.item_id)), JSON.stringify(['MLB1', 'MLB2', 'MLB6']));
  const [deal, desc, smart] = r;
  assert.deepStrictEqual({ ...deal.dados.promo_aprovar }, { promotion_type: 'DEAL', promotion_id: 'P-1', deal_price: 89.9, offer_id: 'OF-1' });
  assert.deepStrictEqual({ ...desc.dados.promo_aprovar }, { promotion_type: 'PRICE_DISCOUNT', deal_price: 270, dias: 13 });
  assert.deepStrictEqual({ ...smart.dados.promo_aprovar }, { promotion_type: 'SMART', promotion_id: 'S', offer_id: 'R' });
  assert.match(deal.explicacao, /Só entra no ML se você aprovar/);
  for (const x of r) assert.strictEqual(tipoDe(x.dados), 'promocao');
});

test('caixa de decisões usa o mural e não grava log sem id', () => {
  const dec = fs.readFileSync(__dirname + '/../js/pages-decisoes.js', 'utf8');
  assert.match(dec, /GLRAcoes\.promocoesParaAprovar/);
  assert.match(dec, /it\.log && !it\.local/);
  assert.match(fs.readFileSync(__dirname + '/../js/acoes-agente.js', 'utf8'), /if \(l\.id\) await _sb/);
});
