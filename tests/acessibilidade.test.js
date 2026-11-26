// Acessibilidade básica (js/ui.js + js/nav.js) num Chromium de verdade:
// o que tem onclick vira botão de teclado, campo sem nome ganha aria-label,
// e o menu do celular fecha ao navegar / com Esc.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let playwright = null;
try { playwright = require('playwright'); } catch (e) {}
const pular = !playwright && 'playwright não instalado';

const HTML = `<!doctype html><html><body>
<aside id="sidebar"><div class="sidebar-section"><div class="sidebar-section-title">Geral</div>
  <button class="nav-item" data-page="dashboard" onclick="location.hash='dashboard'">Painel</button>
  <button class="nav-item" data-page="clientes" onclick="location.hash='clientes'">Clientes</button></div></aside>
<div id="sidebar-backdrop" data-a11y="1" aria-hidden="true" onclick="document.getElementById('sidebar').classList.remove('open')"></div>
<button id="sidebar-toggle" onclick="document.getElementById('sidebar').classList.toggle('open')">menu</button>
<main id="page-content">
  <div id="card" class="dx-li" onclick="window.clicou=(window.clicou||0)+1">Cliente A</div>
  <div id="fundo" onclick="if(event.target===this)this.remove()"><div id="segura" onclick="event.stopPropagation()">modal</div></div>
  <table><tbody><tr id="linha" onclick="window.linha=1"><td>x</td></tr></tbody></table>
  <input id="c1" placeholder="Buscar produto">
  <label class="form-label">Margem mínima</label><input id="c2" type="number">
  <label for="c3">Com rótulo</label><input id="c3">
  <select id="c4" name="conta_id"><option>a</option></select>
  <input id="c5" type="hidden">
</main></body></html>`;

test('onclick vira botão de teclado, campos ganham nome, menu do celular fecha', { skip: pular }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.setContent(HTML);
    await page.addScriptTag({ path: path.join(__dirname, '../js/nav.js') }).catch(() => {});
    await page.addScriptTag({ path: path.join(__dirname, '../js/ui.js') });
    await page.evaluate(() => window.GLRUI.atualizar());

    const attr = (sel, a) => page.$eval(sel, (el, a) => el.getAttribute(a), a);
    assert.equal(await attr('#card', 'role'), 'button');
    assert.equal(await attr('#card', 'tabindex'), '0');
    assert.equal(await attr('#fundo', 'role'), null, 'fundo de modal não vira botão');
    assert.equal(await attr('#segura', 'role'), null);
    assert.equal(await attr('#sidebar-backdrop', 'role'), null);
    assert.equal(await attr('#linha', 'role'), null, 'linha de tabela mantém o papel');
    assert.equal(await attr('#linha', 'tabindex'), '0');

    await page.focus('#card'); await page.keyboard.press('Enter'); await page.keyboard.press(' ');
    assert.equal(await page.evaluate(() => window.clicou), 2, 'Enter e Espaço clicam');
    await page.focus('#linha'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.linha), 1);

    assert.equal(await attr('#c1', 'aria-label'), 'Buscar produto');
    assert.equal(await attr('#c2', 'aria-label'), 'Margem mínima');
    assert.equal(await attr('#c3', 'aria-label'), null, 'quem já tem <label for> fica como está');
    assert.equal(await attr('#c4', 'aria-label'), 'conta id');
    assert.equal(await attr('#c5', 'aria-label'), null);

    // menu do celular
    assert.equal(await attr('#sidebar-toggle', 'aria-expanded'), 'false');
    await page.click('#sidebar-toggle');
    assert.equal(await page.$eval('#sidebar', el => el.classList.contains('open')), true);
    assert.equal(await attr('#sidebar-toggle', 'aria-expanded'), 'true');
    await page.click('.nav-item[data-page=clientes]');
    await page.waitForFunction(() => !document.getElementById('sidebar').classList.contains('open'));
    await page.click('#sidebar-toggle');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#sidebar', el => el.classList.contains('open')), false, 'Esc fecha');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sidebar-toggle', 'foco volta para o botão');
    await page.click('#sidebar-toggle');
    await page.evaluate(() => { location.hash = 'dashboard'; });
    await page.waitForFunction(() => !document.getElementById('sidebar').classList.contains('open'));
  } finally { await browser.close(); }
});
