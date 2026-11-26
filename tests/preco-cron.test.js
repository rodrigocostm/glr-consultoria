const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('price cron uses the server key and the same Shopee price as the screen', () => {
  const cron = fs.readFileSync(path.join(__dirname, '../api/preco-cron.js'), 'utf8');
  const tela = fs.readFileSync(path.join(__dirname, '../js/pages-rastreamento.js'), 'utf8');
  assert.equal(cron.includes('eyJ'), false);
  assert.equal(cron.includes('/ 100000'), false);
  assert.match(cron, /process\.env\.MCP_API_KEY/);
  assert.match(cron, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(cron, /has_model \? \(parseFloat\(it\.price_min\) \|\| 0\) : \(parseFloat\(it\.price_info\?\.\[0\]\?\.current_price\) \|\| 0\)/);
  assert.match(tela, /has_model \? \(parseFloat\(it\.price_min\) \|\| 0\) : \(it\.price_info\?\.\[0\]\?\.current_price \|\| 0\)/);
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
  assert.ok(vercel.crons.some(c => c.path === '/api/preco-cron' && c.schedule === '15 11 * * *'));
});
