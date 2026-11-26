const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('the ads bridge stays in the extension world and checks a nonce', () => {
  const dir = path.join(__dirname, '../extensao-mercado-ads');
  const ponte = fs.readFileSync(path.join(dir, 'ponte.js'), 'utf8');
  const ia = fs.readFileSync(path.join(dir, 'inteligencia.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(ponte.includes("postMessage"), false);
  assert.match(ponte, /segredo !== nonce/);
  assert.match(ponte, /chrome\.runtime\?\.id/);
  assert.equal(ia.includes("postMessage"), false);
  assert.match(ia, /__glrPonteNonce/);
  assert.equal(JSON.stringify(manifest).includes('"world"'), false);
  assert.ok(manifest.host_permissions.includes('https://pa.mercadolivre.com.br/*'));
  assert.equal(manifest.content_scripts[0].js[0], 'ponte.js');
});
