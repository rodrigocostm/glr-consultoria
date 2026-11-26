const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('security headers block framing and sniffing and pin the CDN scripts', () => {
  const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  const headers = vercel.headers.find(h => h.source === '/(.*)').headers;
  const csp = headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(csp, /https:\/\/mcp\.tiops\.com\.br/);
  assert.match(csp, /wss:\/\/rrodqlejqyaoomutriiw\.supabase\.co/);
  assert.equal(headers.find(h => h.key === 'X-Content-Type-Options').value, 'nosniff');
  assert.equal(headers.find(h => h.key === 'X-Frame-Options').value, 'DENY');
  for (const file of ['index.html', 'landing.html', 'shopee.html']) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /supabase-js@2\.86\.0\/dist\/umd\/supabase\.js/);
    assert.match(html, /integrity="sha384-3Sgm1bFlHa\+gvzgZCHY6SyQwlKZpsgWl0qwxcwsypsSZQvo1vV1miPkn7n1lU1\/L"/);
  }
  assert.match(fs.readFileSync('index.html', 'utf8'), /chart\.umd\.min\.js" integrity="sha384-/);
});
