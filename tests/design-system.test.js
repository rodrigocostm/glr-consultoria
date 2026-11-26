// Design system: tokens de espaço, 6 tamanhos de texto e cores no :root, e as
// telas já migradas não voltam a usar tamanho de fonte solto em px.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ler = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const MIGRADAS = ['js/pages-vendas.js', 'js/pages-agente.js', 'js/pages-avancados.js'];

test('tokens do design system existem', () => {
  const css = ler('css/styles.css');
  for (const t of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8', '--fs-1', '--fs-2', '--fs-3', '--fs-4', '--fs-5', '--fs-6', '--blue', '--green', '--red', '--yellow', '--text-primary', '--text-secondary', '--text-muted'])
    assert.match(css, new RegExp(`${t}:`), t);
  const tamanhos = [...css.matchAll(/--fs-(\d):/g)].map(m => m[1]);
  assert.ok(new Set(tamanhos).size <= 6, 'no máximo 6 tamanhos de texto');
});

test('telas migradas usam só os tokens de tamanho de texto', () => {
  for (const f of MIGRADAS) {
    const soltos = ler(f).match(/font-size:\s*\d+(\.\d+)?px/g) || [];
    assert.deepEqual(soltos, [], f);
    assert.doesNotMatch(ler(f), /#(60a5fa|3b82f6)\b/i, f + ': use var(--blue)');
  }
});

module.exports = { MIGRADAS };
