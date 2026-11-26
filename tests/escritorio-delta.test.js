const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../js/pages-escritorio.js'), 'utf8');
const sandbox = {};
vm.runInNewContext(src.slice(0, src.indexOf('Router.register')), sandbox);
const { contasDoFoco, aplicarDelta } = sandbox.GLRQuadro;

function estado() {
  return { logs: [], sync: [], sinais: [], repu: [], quali: [], planos: [], rels: [], direto: [], agenda: {}, pendentes: 0, uid: 'user1' };
}

test('sem cliente em foco não filtra; com foco só as contas vinculadas', () => {
  assert.equal(contasDoFoco('', {}), null);
  const foco = contasDoFoco('7', { '7': [{ external_id: 'ext', param_to_use: { shopId: '99', meliUserId: '88' } }] });
  assert.equal(JSON.stringify([...foco.ids].sort()), JSON.stringify(['88', '99', 'ext']));
  assert.equal(contasDoFoco('7', {}).ids.length, 0);
});

test('evento novo entra na lista e o seguinte substitui, sem recarregar o resto', () => {
  const st = estado();
  const foco = { cid: '7', ids: ['99'] };
  assert.equal(aplicarDelta(st, 'glr_agente_log', { eventType: 'INSERT', new: { id: 'a', conta_id: '99', tipo: 'decisao', titulo: 'um' } }, foco), true);
  assert.equal(aplicarDelta(st, 'glr_agente_log', { eventType: 'INSERT', new: { id: 'b', conta_id: 'outra', tipo: 'decisao' } }, foco), true);
  assert.deepEqual(st.logs.map(l => l.id), ['a']);
  aplicarDelta(st, 'glr_agente_log', { eventType: 'UPDATE', new: { id: 'a', conta_id: '99', tipo: 'decisao', titulo: 'dois' } }, foco);
  assert.equal(st.logs.length, 1);
  assert.equal(st.logs[0].titulo, 'dois');
});

test('sinal atualiza a fatia certa e chat_job não mexe no quadro', () => {
  const st = estado();
  aplicarDelta(st, 'glr_sync_estado', { eventType: 'UPDATE', new: { marketplace: 'shopee', conta_id: '99', recurso: 'sinais', cursor: { resumo: { produtos: 3 } } } }, null);
  assert.equal(st.sinais[0].resumo.produtos, 3);
  aplicarDelta(st, 'glr_sync_estado', { eventType: 'UPDATE', new: { marketplace: 'shopee', conta_id: '99', recurso: 'sinais', cursor: { resumo: { produtos: 4 } } } }, null);
  assert.equal(st.sinais.length, 1);
  assert.equal(st.sinais[0].resumo.produtos, 4);
  const antes = st.logs.length;
  assert.equal(aplicarDelta(st, 'glr_sync_estado', { eventType: 'INSERT', new: { recurso: 'chat_job', conta_id: 'job:user1:abc' } }, null), true);
  assert.equal(st.logs.length, antes);
});

test('conversa direta só entra se for do usuário da tela', () => {
  const st = estado();
  aplicarDelta(st, 'glr_sync_estado', { eventType: 'UPDATE', new: { recurso: 'chat', conta_id: 'chat:outro:escritoriogerente', cursor: { agente: 'esc:gerente', msgs: [{ r: 'assistant', t: 'oi', em: new Date().toISOString() }] } } }, null);
  assert.equal(st.direto.length, 0);
  aplicarDelta(st, 'glr_sync_estado', { eventType: 'UPDATE', new: { recurso: 'chat', conta_id: 'chat:user1:escritoriogerente', cursor: { agente: 'esc:gerente', msgs: [{ r: 'assistant', t: 'oi', em: new Date().toISOString(), criadas: 0 }] } } }, null);
  assert.equal(st.direto[0].agente, 'gerente');
  assert.equal(st.direto[0].msgs[0].t, 'oi');
});
