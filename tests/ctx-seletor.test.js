// Seletor global único: GLR.ctx.ajustarSeletor deixa no seletor local só as contas do cliente em foco
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function carregar(foco) {
  const store = new Map([['glr_mc_vinculos', JSON.stringify({
    1: [{ marketplace: 'shopee', external_id: 'S1' }, { marketplace: 'meli', external_id: 'M1' }],
    2: [{ marketplace: 'shopee', external_id: 'S2' }, { marketplace: 'shopee', external_id: 'S3' }],
  })]]);
  if (foco) store.set('glr_ctx_cliente', foco);
  const ctx = { console, JSON, Event: class { constructor(t) { this.type = t; } }, localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    document: { createElement: () => ({ classList: { contains: c => c === 'ctx-conta-fixa', toggle() {} }, className: '', remove() { this.removido = true; } }) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(require.resolve('../js/data.js'), 'utf8') + ';window.G = GLR;', ctx);
  return ctx.G;
}
function select(valores, valor) {
  const sel = { style: { display: '' }, dataset: {}, eventos: [], nextElementSibling: null,
    get options() { return this._ops; }, get value() { return this._v; }, set value(v) { this._v = this._ops.some(o => o.value === v) ? v : ''; },
    dispatchEvent(e) { this.eventos.push(e.type); },
    insertAdjacentElement(_, el) { this.nextElementSibling = el; } };
  sel._ops = valores.map(v => ({ value: v, textContent: 'Conta ' + (v || 'todas'), disabled: false, remove() { sel._ops = sel._ops.filter(o => o !== this); } }));
  sel._v = valor ?? valores[0];
  return sel;
}
const valores = sel => Array.from(sel.options, o => o.value);

test('sem cliente em foco o seletor fica como está', () => {
  const G = carregar('');
  const sel = select(['', 'S1', 'S2', 'S3']);
  assert.equal(G.ctx.ajustarSeletor(sel, { mkt: 'shopee' }), null);
  assert.deepEqual(valores(sel), ['', 'S1', 'S2', 'S3']);
  assert.equal(sel.style.display, '');
});

test('com foco lista só as contas do cliente e escolhe uma dele', () => {
  const G = carregar('2');
  const sel = select(['', 'S1', 'S2', 'S3'], 'S1');
  const r = G.ctx.ajustarSeletor(sel, { mkt: 'shopee' });
  assert.equal(r.n, 2);
  assert.deepEqual(valores(sel), ['', 'S2', 'S3']);
  assert.equal(sel.value, 'S2');
  assert.deepEqual(sel.eventos, ['change'], 'avisa a tela que a conta mudou');
  assert.equal(sel.style.display, '', 'com 2 contas no canal o seletor aparece');
});

test('com uma conta só no canal o seletor some e fica o nome da conta', () => {
  const G = carregar('1');
  const sel = select(['', 'S1', 'S2', 'S3'], '');
  G.ctx.ajustarSeletor(sel, { mkt: 'shopee', disparar: false });
  assert.equal(sel.value, 'S1');
  assert.equal(sel.style.display, 'none');
  assert.equal(sel.nextElementSibling.textContent, 'Conta S1');
  assert.deepEqual(sel.eventos, [], 'disparar: false não dispara change');
});

test('cliente sem conta no canal mostra o aviso no lugar do seletor', () => {
  const G = carregar('1');
  const sel = select(['', 'S2', 'S3'], 'S2');
  const r = G.ctx.ajustarSeletor(sel, { mkt: 'shopee', semTodas: true, vazio: 'Sem conta Shopee' });
  assert.equal(r.n, 0);
  assert.deepEqual(valores(sel), []);
  assert.equal(sel.nextElementSibling.textContent, 'Sem conta Shopee');
});

test('seletor de cliente fica só com o cliente em foco', () => {
  const G = carregar('2');
  const sel = select(['1', '2'], '1');
  G.ctx.ajustarSeletor(sel, { cliente: true, disparar: false });
  assert.deepEqual(valores(sel), ['2']);
  assert.equal(sel.style.display, 'none');
});
