const { test } = require('node:test');
const assert = require('node:assert/strict');
const { consumir } = require('../api/_cota-ia');

test('quota blocks the 41st use and does not call the model store twice past the limit', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock';
  let n = 0;
  const original = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('glr_sync_estado?marketplace')) return { ok: true, json: async () => (n ? [{ cursor: { dia: new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), n } }] : []) };
    if (init?.method === 'POST') { n += 1; return { ok: true, json: async () => null }; }
    throw new Error('unexpected ' + url);
  };
  const first = await consumir('user-1', 'anuncio-seo');
  assert.equal(first.usadas, 1);
  n = 40;
  await assert.rejects(() => consumir('user-1', 'anuncio-seo'), e => e.status === 429);
  global.fetch = original;
});
