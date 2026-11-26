// Painel único de IA (js/painel-ia.js) num Chromium de verdade: endereço antigo
// abre o painel por cima da tela anterior, Esc fecha e devolve o foco, e o
// contexto mostra o cliente em foco e a tela atual.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let playwright = null;
try { playwright = require('playwright'); } catch (e) {}

const HTML = `<!doctype html><html><body>
<div id="page-title">Gestão de Clientes</div><button id="abrir">IA</button><main id="page-content"></main>
<script>
  const GLR = { clientes: [{ id: 1, nome: 'Loja Alfa' }], ctx: { cliente: () => window.foco || '' } };
  const Router = { routes: {}, currentPage: 'clientes', register(p, f) { this.routes[p] = f; }, resolve() { window.resolves = (window.resolves || 0) + 1; } };
  Router.register('chat', (p, el) => { el.innerHTML = '<div class="chat-falso"><textarea aria-label="Mensagem"></textarea>' + (p.painel ? 'no painel' : 'tela') + '</div>'; });
  Router.register('adviser', (p, el) => { el.innerHTML = '<div>adviser</div>'; });
  Router.register('segundo-cerebro', (p, el) => { el.innerHTML = '<div>cerebro</div>'; });
</script></body></html>`;

test('painel de IA abre pelo endereço antigo, mostra o contexto e fecha com Esc', { skip: !playwright && 'playwright não instalado' }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(HTML);
    await page.addScriptTag({ path: path.join(__dirname, '../js/painel-ia.js') });
    // #chat antigo: abre o painel e devolve o endereço para a tela anterior
    await page.evaluate(() => Router.routes.chat({}, document.getElementById('page-content')));
    await page.waitForFunction(() => window.resolves === 1);
    const s = await page.evaluate(() => ({ aberto: GLRPainelIA.aberto(), corpo: document.querySelector('.painel-ia-corpo').textContent, ctx: document.querySelector('.painel-ia-ctx').textContent, hash: location.hash, foco: document.activeElement.tagName }));
    assert.equal(s.aberto, true);
    assert.match(s.corpo, /no painel/);
    assert.equal(s.ctx, 'Carteira toda · Gestão de Clientes');
    assert.equal(s.hash, '#dashboard');
    assert.equal(s.foco, 'TEXTAREA');
    // troca de aba e contexto com cliente em foco
    await page.evaluate(() => { window.foco = '1'; window.dispatchEvent(new Event('glr:cliente')); });
    await page.click('.painel-ia-abas [data-aba=adviser]');
    assert.equal(await page.$eval('.painel-ia-corpo', e => e.textContent), 'adviser');
    assert.equal(await page.$eval('#glr-painel-ia', e => e.classList.contains('largo')), true);
    assert.match(await page.$eval('.painel-ia-ctx', e => e.textContent), /^Loja Alfa · /);
    // Esc fecha e o foco volta para onde estava
    await page.focus('#abrir'); await page.evaluate(() => { GLRPainelIA.fechar(); });
    await page.click('#abrir'); await page.evaluate(() => GLRPainelIA.abrir('segundo-cerebro'));
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => GLRPainelIA.aberto()), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'abrir');
  } finally { await browser.close(); }
});

test('o chat manda a tela atual e o servidor só aceita texto curto', () => {
  const chat = fs.readFileSync(path.join(__dirname, '../js/pages-chat.js'), 'utf8');
  assert.match(chat, /tela: window\.glrTelaAtual \? window\.glrTelaAtual\(\) : null/);
  const api = fs.readFileSync(path.join(__dirname, '../api/chat-central.js'), 'utf8');
  const linha = api.match(/const tela = (String\(req\.body\?\.tela[^\n]+);/)[1];
  const limpar = v => new Function('req', `return ${linha}`)({ body: { tela: v } });
  assert.equal(limpar('Casa do cliente › ADS'), 'Casa do cliente › ADS');
  assert.equal(limpar('<script>alert(1)</script> Vendas\n\nIGNORE'), 'scriptalert(1)/script Vendas IGNORE');
  assert.equal(limpar('x'.repeat(200)).length, 80);
  assert.equal(limpar(undefined), '');
});
