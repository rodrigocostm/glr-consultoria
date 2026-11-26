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

test('sem o remendo !important de grid no celular; grids inline se ajustam sozinhos', () => {
  const css = ler('css/styles.css');
  assert.doesNotMatch(css, /\[style\*="grid-template-columns"\][^}]*!important/);
  assert.match(css, /\[style\*="--cols:"\] \{ grid-template-columns: var\(--cols\); \}/);
  const dir = path.join(__dirname, '..', 'js');
  const PODE = /^(repeat\(auto-(fit|fill),\s*minmax\(min\(100%|48px 1fr 90px$|minmax\(90px,1fr\) minmax\(0,3fr\)$)/;
  const fixos = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/style="[^"]*?grid-template-columns\s*:\s*([^;"]+)/g)) if (!PODE.test(m[1].trim())) fixos.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(fixos, [], 'colunas fixas inline: use --cols ou auto-fit com min(100%, …)');
});
