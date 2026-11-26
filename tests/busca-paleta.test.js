// Busca única: botão do topo abre a paleta ⌘K, que acha telas, clientes (também por responsável/categoria) e tarefas
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function carregarNav(GLR) {
  const ctx = { console, setTimeout: () => 0, GLR, Router: { navigate() {} },
    getComputedStyle: () => ({ display: 'block' }), navigator: { platform: 'MacIntel' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { readyState: 'loading', addEventListener() {}, querySelectorAll: () => [], getElementById: () => null, querySelector: () => null },
  };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/nav.js'), 'utf8'), ctx);
  return ctx.window.GLRNav;
}

test('a paleta acha cliente pelo nome, pelo responsável e tarefas pelo título ou cliente', () => {
  const nav = carregarNav({
    clientes: [{ id: 1, nome: 'Móveis Sol', responsavel: 'Ana', categoria: 'Decoração', gestor: 'Maria' }],
    tarefas: [{ titulo: 'Revisar ADS', cliente: 'Móveis Sol', prazo: '' }, ...Array.from({ length: 6 }, (_, i) => ({ titulo: 'Repor ' + i, cliente: 'X' }))],
  });
  assert.deepEqual(Array.from(nav.filtrar('moveis')).map(o => o.tipo + ':' + o.nome), ['Cliente:Móveis Sol', 'Tarefa:Revisar ADS']);
  assert.deepEqual(Array.from(nav.filtrar('ana')).map(o => o.nome), ['Móveis Sol'], 'responsável também acha o cliente');
  assert.deepEqual(Array.from(nav.filtrar('decora')).map(o => o.nome), ['Móveis Sol'], 'categoria também acha');
  assert.equal(nav.filtrar('repor').length, 4, 'no máximo 4 tarefas');
  assert.equal(nav.filtrar('').every(o => o.tipo === 'Tela'), true, 'sem termo mostra só telas');
});

test('o topo tem um botão de busca acessível e não sobrou a busca antiga', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /<button type="button" class="search-box" id="global-search" aria-label="[^"]+"/);
  assert.doesNotMatch(html, /handleSearch|search-overlay/);
  const css = fs.readFileSync(require.resolve('../css/styles.css'), 'utf8');
  const celular = css.slice(css.indexOf('@media (max-width: 900px)'), css.indexOf('}', css.indexOf('@media (max-width: 900px)') + 400));
  assert.doesNotMatch(celular, /\.search-box \{ display: none/, 'a busca não some no celular');
});
