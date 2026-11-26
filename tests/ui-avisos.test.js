// GLR.avisar / GLR.confirmar / GLR.perguntar / GLR.validar (js/ui.js) — DOM mínimo em memória
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function criarDom() {
  const porId = new Map();
  const ouvintesDoc = {};
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.ouvintes = {}; this._txt = ''; this.className = ''; this.value = ''; const self = this; this.classList = { add: c => { if (!self.className.split(' ').includes(c)) self.className = (self.className + ' ' + c).trim(); }, remove: c => { self.className = self.className.split(' ').filter(x => x && x !== c).join(' '); }, contains: c => self.className.split(' ').includes(c), toggle() {} }; }
    set id(v) { this._id = v; porId.set(v, this); } get id() { return this._id || ''; }
    set textContent(v) { this._txt = String(v); this.children = []; } get textContent() { return this._txt + this.children.map(c => c.textContent).join(''); }
    get isConnected() { let e = this; while (e.parent) e = e.parent; return e === doc.body; }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    prepend(c) { c.parent = this; this.children.unshift(c); }
    insertAdjacentElement(_, c) { const p = this.parent; c.parent = p; p.children.splice(p.children.indexOf(this) + 1, 0, c); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; if (this._id) porId.delete(this._id); }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, f) { (this.ouvintes[t] = this.ouvintes[t] || []).push(f); } removeEventListener(t, f) { this.ouvintes[t] = (this.ouvintes[t] || []).filter(x => x !== f); }
    dispara(t, ev = {}) { (this.ouvintes[t] || []).slice().forEach(f => f({ target: this, preventDefault() {}, stopPropagation() {}, ...ev })); }
    focus() { doc.activeElement = this; }
    todos() { return [this, ...this.children.flatMap(c => c.todos())]; }
    acha(pred) { return this.todos().find(pred); }
  }
  const doc = {
    body: null, activeElement: null, readyState: 'complete',
    createElement: t => new El(t),
    getElementById: id => { const e = porId.get(id); return e && e.isConnected ? e : null; },
    addEventListener: (t, f) => { (ouvintesDoc[t] = ouvintesDoc[t] || []).push(f); },
    removeEventListener: (t, f) => { ouvintesDoc[t] = (ouvintesDoc[t] || []).filter(x => x !== f); },
    tecla: (key, target) => (ouvintesDoc.keydown || []).slice().forEach(f => f({ key, target: target || doc.activeElement, preventDefault() {}, stopPropagation() {} })),
  };
  doc.body = new El('body');
  return doc;
}

function carregar() {
  const document = criarDom();
  const timers = [];
  const window = { document, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].f = null; }, setInterval: () => 0, localStorage: { getItem: () => null, setItem() {} } };
  const ctx = { window, document, GLR: {}, setTimeout: () => 0, setInterval: () => 0, console, MutationObserver: class { observe() {} } };
  window.GLR = ctx.GLR;
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/ui.js'), 'utf8'), ctx);
  return { GLR: ctx.GLR, document, timers };
}

test('avisar mostra o texto sem interpretar HTML, com aria-live, e some sozinho', () => {
  const { GLR, document, timers } = carregar();
  const a = GLR.avisar('<img src=x onerror=alert(1)> salvo', 'sucesso');
  const pilha = document.getElementById('glr-avisos');
  assert.ok(pilha, 'cria a pilha de avisos');
  assert.equal(pilha.getAttribute('aria-live'), 'polite');
  assert.equal(pilha.getAttribute('role'), 'status');
  assert.ok(a.el.className.includes('glr-aviso-sucesso'));
  assert.ok(a.el.textContent.includes('<img src=x onerror=alert(1)> salvo'), 'texto literal (textContent)');
  assert.equal(a.el.innerHTML, undefined, 'nunca usa innerHTML');
  const t = timers.find(x => x.f);
  assert.equal(t.ms, 4000);
  t.f();
  assert.equal(pilha.children.length, 0, 'saiu da tela');
});

test('avisar de erro usa role=alert/assertive e tem botão de fechar', () => {
  const { GLR, document } = carregar();
  const a = GLR.avisar('Falhou', 'erro');
  const pilha = document.getElementById('glr-avisos-erro');
  assert.equal(pilha.getAttribute('aria-live'), 'assertive');
  assert.equal(pilha.getAttribute('role'), 'alert');
  const fechar = a.el.acha(e => e.tagName === 'BUTTON');
  assert.equal(fechar.getAttribute('aria-label'), 'Fechar aviso');
  fechar.dispara('click');
  assert.equal(pilha.children.length, 0);
  GLR.avisar('x', 'tipo-que-nao-existe');
  assert.ok(document.getElementById('glr-avisos').children[0].className.includes('glr-aviso-info'), 'tipo desconhecido vira info');
});

test('confirmar devolve true ao confirmar e false ao cancelar, Esc ou clicar fora', async () => {
  const { GLR, document } = carregar();
  const botao = (txt) => document.body.acha(e => e.tagName === 'BUTTON' && e.textContent === txt);

  let p = GLR.confirmar('Apagar <b>tudo</b>?', { ok: 'Apagar' });
  const caixa = document.body.acha(e => e.className === 'glr-dialogo');
  assert.equal(caixa.getAttribute('role'), 'dialog');
  assert.equal(caixa.getAttribute('aria-modal'), 'true');
  assert.ok(caixa.textContent.includes('Apagar <b>tudo</b>?'));
  botao('Apagar').dispara('click');
  assert.equal(await p, true);
  assert.equal(document.body.children.length, 0, 'diálogo removido');

  p = GLR.confirmar('Seguir?');
  botao('Cancelar').dispara('click');
  assert.equal(await p, false);

  p = GLR.confirmar('Seguir?');
  document.tecla('Escape');
  assert.equal(await p, false);

  p = GLR.confirmar('Seguir?');
  const fundo = document.body.children[0];
  fundo.dispara('click', { target: fundo });
  assert.equal(await p, false);
});

test('confirmar com perigo começa com o foco em Cancelar e usa alertdialog', async () => {
  const { GLR, document } = carregar();
  const p = GLR.confirmar('Excluir conta?', { perigo: true, ok: 'Excluir' });
  assert.equal(document.activeElement.textContent, 'Cancelar');
  assert.equal(document.body.acha(e => e.className.includes('glr-dialogo-perigo')).getAttribute('role'), 'alertdialog');
  document.tecla('Enter'); // Enter em cima do Cancelar não confirma
  document.activeElement.dispara('click');
  assert.equal(await p, false);
});

test('perguntar devolve o texto digitado ou null', async () => {
  const { GLR, document } = carregar();
  let p = GLR.perguntar('Nome do grupo?', { valor: 'Atual' });
  const campo = document.body.acha(e => e.tagName === 'INPUT');
  assert.equal(campo.value, 'Atual');
  assert.equal(document.activeElement, campo);
  campo.value = 'Novo nome';
  document.tecla('Enter', campo);
  assert.equal(await p, 'Novo nome');
  p = GLR.perguntar('Nome?');
  document.tecla('Escape');
  assert.equal(await p, null);
});

test('validar marca todos os campos com erro, foca o primeiro e limpa ao corrigir', () => {
  const { GLR, document } = carregar();
  const form = document.body.appendChild(document.createElement('div'));
  const titulo = form.appendChild(document.createElement('input')); titulo.id = 'f-titulo';
  const preco = form.appendChild(document.createElement('input')); preco.id = 'f-preco';
  const ok = GLR.validar([
    [false, 'f-titulo', 'Preencha o título.'],
    [true, 'f-outro', 'não aparece'],
    [false, 'f-preco', 'Informe um preço válido.'],
  ]);
  assert.equal(ok, false);
  assert.equal(document.activeElement, titulo, 'foca o primeiro campo com erro');
  assert.equal(titulo.getAttribute('aria-invalid'), 'true');
  assert.equal(document.getElementById('f-titulo-erro').textContent, 'Preencha o título.');
  assert.equal(document.getElementById('f-preco-erro').textContent, 'Informe um preço válido.');
  titulo.dispara('input');
  assert.equal(titulo.getAttribute('aria-invalid'), null);
  assert.equal(document.getElementById('f-titulo-erro'), null);
  assert.equal(GLR.validar([[true, 'f-titulo', 'x']]), true);
});

test('erroCampo sem o campo na tela cai num aviso de erro', () => {
  const { GLR, document } = carregar();
  assert.equal(GLR.erroCampo('nao-existe', 'Selecione a conta.'), false);
  assert.ok(document.getElementById('glr-avisos-erro').textContent.includes('Selecione a conta.'));
});

test('anúncios e agente de ADS não usam mais alert/confirm/prompt do navegador', () => {
  for (const f of ['pages-anuncios.js', 'pages-agente.js']) {
    const src = fs.readFileSync(require.resolve('../js/' + f), 'utf8');
    assert.doesNotMatch(src, /(^|[^.\w])(alert|confirm|prompt)\(/m, f);
  }
});
