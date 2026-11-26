const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

test('glrEsc escapes text and attributes', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/html-escape.js'), 'utf8'), context);
  assert.equal(context.window.glrEsc(`<img x="1" y='2'>&`), '&lt;img x=&quot;1&quot; y=&#39;2&#39;&gt;&amp;');
  assert.equal(context.window.glrEsc(null), '');
});

test('browser no longer sends the Tiops key or stores glr_mc_apikey', () => {
  const api = fs.readFileSync(path.join(__dirname, '../js/marketplace-api.js'), 'utf8');
  assert.equal(api.includes('x-api-key'), false);
  assert.equal(api.includes('glr_mc_apikey'), false);
  assert.match(api, /\/api\/mcp/);
  const init = fs.readFileSync(path.join(__dirname, '../js/supabase-init.js'), 'utf8');
  const keys = init.match(/const GLR_KEYS = \[([\s\S]*?)\];/);
  assert.ok(keys);
  assert.equal(keys[1].includes('glr_mc_apikey'), false);
  assert.match(init, /removeItem\('glr_mc_apikey'\)/);
  const cron = fs.readFileSync(path.join(__dirname, '../api/preco-cron.js'), 'utf8');
  assert.equal(cron.includes('eyJ'), false);
  assert.equal(cron.includes('glr_mc_apikey'), false);
  assert.match(cron, /process\.env\.MCP_API_KEY/);
  assert.match(cron, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('every marketplace action used by the screens is allowed for staff', () => {
  const mcpSrc = fs.readFileSync(path.join(__dirname, '../api/mcp.js'), 'utf8');
  const bloco = nome => mcpSrc.match(new RegExp(`const ${nome} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  const nomes = src => [...src.matchAll(/'([A-Za-z0-9_]+)'/g)].map(m => m[1]);
  const equipe = new Set([...nomes(bloco('ALLOWED_ACTIONS')[1]), ...nomes(bloco('ACOES_EQUIPE')[1])]);
  const root = path.join(__dirname, '../js');
  const actions = new Set();
  const re = /(?:MarketplaceAPI|this)\.call\(\s*['"`]([A-Za-z0-9_]+)['"`]/g;
  for (const file of fs.readdirSync(root)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    re.lastIndex = 0;
    let m; while ((m = re.exec(src))) actions.add(m[1]);
  }
  for (const extra of ['shopee_ams_open_campaign_performance', 'shopee_ams_affiliate_performance', 'shopee_ams_conversion_report', 'ml_affiliate_report', 'ml_affiliate_performance']) actions.add(extra);
  const missing = [...actions].filter(a => !a.startsWith('glr_') && !equipe.has(a));
  assert.deepEqual(missing, []);
});
