const { test } = require('node:test');
const assert = require('node:assert/strict');
const { httpsDe } = require('../api/_blog');

test('blog only keeps https source and cover addresses', () => {
  assert.equal(httpsDe('https://g1.globo.com/economia/noticia.html'), 'https://g1.globo.com/economia/noticia.html');
  assert.equal(httpsDe('http://example.com/a'), '');
  assert.equal(httpsDe('javascript:alert(1)'), '');
  assert.equal(httpsDe('https://user:pass@example.com/a'), '');
});
