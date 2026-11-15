const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const read = p => fs.readFileSync(p, 'utf8');
test('all first-party entry pages load the same brand after their own styles', () => {
  for (const [file, cls] of [['index.html','glr-app'],['landing.html','glr-landing'],['shopee.html','glr-shopee'],['calculadora.html','glr-calculadora']]) {
    const html = read(file);
    assert.match(html, new RegExp(`<body class="${cls}"`));
    assert.equal((html.match(/href="\/css\/brand.css\?v=/g) || []).length, 1, file);
    assert.ok(html.indexOf('/css/brand.css') > html.slice(0,html.indexOf('</head>')).lastIndexOf('</style>'), file);
    assert.match(html, /glr-monogram-180.png/);
  }
  assert.match(read('api/blog.js'), /brand.css\?v=20261115-1.*<\/head><body class="glr-blog">/);
});
test('brand assets referenced in every modified page exist and vectors are standalone', () => {
  for (const f of ['index.html','landing.html','shopee.html','calculadora.html','api/blog.js','js/supabase-init.js','sw.js']) {
    for (const m of read(f).matchAll(/(?:src="|href="|')\/?(img\/brand\/[^"'?]+)(?:\?[^"']*)?["']/g)) assert.ok(fs.existsSync(m[1]), `${f}: ${m[1]}`);
  }
  for (const name of ['glr-consultoria.svg','glr-consultoria-white.svg','glr-monogram.svg']) {
    const svg=read('img/brand/'+name);
    assert.match(svg, /viewBox=/); assert.match(svg, /<title[^>]*>GLR Consultoria<\/title>/);
    assert.doesNotMatch(svg, /<script|https?:\/\/(?!www.w3.org)|<image|<foreignObject/);
    assert.match(svg, /<path/);
  }
});
test('sidebar uses a full lockup and an independent compact monogram; portal keeps the same shell', () => {
  const html=read('index.html'), css=read('css/brand.css');
  assert.match(html, /class="glr-brand-full" src="\/img\/brand\/glr-consultoria-white.svg"/);
  assert.match(html, /class="glr-brand-compact" src="\/img\/brand\/glr-monogram.svg"/);
  assert.match(css, /sidebar-mini.*glr-brand-full \{display:none;/);
  assert.match(css, /filter:none!important; mix-blend-mode:normal!important/);
  assert.match(read('js/pages-portal.js'), /contexto.textContent = 'Portal do cliente'/);
});
test('login, recovery and connection notice use theme-aware brand variants and retain authentication controls', () => {
  const source=read('js/supabase-init.js');
  assert.equal((source.match(/class="glr-auth-mark"/g)||[]).length,3);
  assert.equal((source.match(/class="glr-brand-dark"/g)||[]).length,3);
  assert.equal((source.match(/class="glr-brand-light"/g)||[]).length,3);
  assert.match(source, /signInWithPassword/); assert.match(source, /glr_acesso/);
  assert.doesNotMatch(source, /glr-auth-mark"><b/);
});
function luminance(hex) {
 const rgb=hex.match(/[\da-f]{2}/gi).map(x=>parseInt(x,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);
 return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
}
test('institutional text and primary button colors meet WCAG AA normal-text contrast', () => {
 for (const [fg,bg] of [['#FFFFFF','#0E6BFF'],['#FFFFFF','#0754C7'],['#0B1F3B','#FFFFFF'],['#425B77','#FFFFFF'],['#5C7088','#FFFFFF'],['#C4D6EA','#0B1F3B'],['#19C2FF','#0B1F3B']]) {
  const a=luminance(fg),b=luminance(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  assert.ok(ratio>=4.5, `${fg}/${bg}: ${ratio}`);
 }
});
