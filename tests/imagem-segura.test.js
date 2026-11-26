const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ipPrivado, hostPermitido, tipoDaImagem, baixarImagem } = require('../api/_imagem-segura');

test('private and link-local addresses are rejected', () => {
  for (const ip of ['127.0.0.1', '10.1.1.1', '192.168.0.5', '172.16.0.1', '169.254.169.254', '::1', 'fe80::1', 'fd00::1']) assert.equal(ipPrivado(ip), true, ip);
  assert.equal(ipPrivado('8.8.8.8'), false);
});

test('only known image hosts are allowed', () => {
  assert.equal(hostPermitido('http2.mlstatic.com'), true);
  assert.equal(hostPermitido('down-br.img.susercontent.com'), true);
  assert.equal(hostPermitido('evil.example'), false);
  assert.equal(hostPermitido('mlstatic.com.evil.test'), false);
});

test('file type comes from the bytes, not the header', () => {
  assert.equal(tipoDaImagem(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(tipoDaImagem(Buffer.from('nao e imagem')), null);
});

test('http, private host and open redirect never fetch the target', async () => {
  const original = global.fetch;
  let chamadas = 0;
  global.fetch = async () => { chamadas++; return { status: 200, ok: true, headers: { get: () => null }, arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff]) }; };
  await assert.rejects(() => baixarImagem('http://http2.mlstatic.com/a.jpg'), /https/);
  await assert.rejects(() => baixarImagem('https://169.254.169.254/latest'), /não permitido/);
  await assert.rejects(() => baixarImagem('https://evil.example/a.jpg'), /não permitido/);
  assert.equal(chamadas, 0);
  global.fetch = original;
});
