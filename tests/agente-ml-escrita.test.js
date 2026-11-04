const { test } = require('node:test'); const assert = require('node:assert/strict');
const { aplicarAcaoML } = require('../api/_agente-ml');
const cfg = (o = {}) => ({ alerta_variacao_pct: 30, ...o });
const mcp = (resp) => { const calls = []; return { calls, fn: async (k, acao, params) => { calls.push({ acao, params }); if (resp instanceof Error) throw resp; return resp || { ok: true }; } }; };
const ctx = (m, o) => ({ cfg: cfg(o), contaId: '802228249', mcpCall: m.fn, mcApiKey: 'mock' });

test('ML recusa por permissão (401): fica como sugestão e marca bloqueado', async () => {
  const m = mcp(new Error("401 User does not have permission to write"));
  const r = await aplicarAcaoML({ acao: 'roas_target', campaign_id: 1, de: 15, para: 13 }, ctx(m));
  assert.deepEqual(r, { ok: false, bloqueado: true }); assert.equal(m.calls[0].acao, 'ml_ads_update_campaign');
});
test('ML aceita: baixar ROAS aplica direto, mesmo com contrato "sugerir" e variação grande', async () => {
  const m = mcp();
  const r = await aplicarAcaoML({ acao: 'roas_target', campaign_id: 7, de: 20, para: 10 }, ctx(m, { autonomia_ml: { ajuste: 'sugerir' } }));
  assert.equal(r.ok, true); assert.deepEqual(m.calls[0].params, { meliUserId: '802228249', campaign_id: '7', roas_target: 10 });
});
test('subir ROAS segue contrato e limite de variação', async () => {
  const m = mcp();
  assert.match((await aplicarAcaoML({ acao: 'roas_target', campaign_id: 7, de: 10, para: 11.8 }, ctx(m, { autonomia_ml: { ajuste: 'sugerir' } }))).motivo, /contrato/);
  assert.match((await aplicarAcaoML({ acao: 'orcamento', campaign_id: 7, de: 100, para: 150 }, ctx(m))).motivo, /limite/);
  assert.equal(m.calls.length, 0);
  assert.equal((await aplicarAcaoML({ acao: 'orcamento', campaign_id: 7, de: 100, para: 115 }, ctx(m))).ok, true);
  assert.deepEqual(m.calls[0].params, { meliUserId: '802228249', campaign_id: '7', daily_budget: 115 });
});
test('pausar campanha e tirar produto usam o contrato de pausa', async () => {
  const m = mcp();
  assert.equal((await aplicarAcaoML({ acao: 'retirar_produto', campaign_id: 7, item_ids: ['MLB1', 'MLB2'] }, ctx(m))).ok, true);
  assert.deepEqual(m.calls.map(c => [c.acao, c.params.item_id, c.params.status]), [['ml_ads_update_ad', 'MLB1', 'paused'], ['ml_ads_update_ad', 'MLB2', 'paused']]);
  assert.match((await aplicarAcaoML({ acao: 'pausar', campaign_id: 7 }, ctx(m, { autonomia_ml: { pausar: 'sugerir' } }))).motivo, /pausar/);
});
test('mover/colocar produto não tem escrita: nenhuma chamada', async () => {
  const m = mcp();
  assert.deepEqual(await aplicarAcaoML({ acao: 'mover_produto', campaign_id: 7, item_ids: ['MLB1'] }, ctx(m)), { ok: false });
  assert.deepEqual(await aplicarAcaoML({ acao: 'adicionar_produto', campaign_id: 7, item_ids: ['MLB1'] }, ctx(m)), { ok: false });
  assert.equal(m.calls.length, 0);
});
test('outro erro do ML vira sugestão com o motivo', async () => {
  const m = mcp(new Error('campaign not found'));
  const r = await aplicarAcaoML({ acao: 'pausar', campaign_id: 7 }, ctx(m));
  assert.equal(r.ok, false); assert.equal(r.bloqueado, undefined); assert.match(r.motivo, /campaign not found/);
});
test('erro com status 401 sem texto também conta como bloqueio', async () => {
  const e = new Error('Erro na ação ml_ads_update_campaign (status 401): {}'); e.status = 401;
  const r = await aplicarAcaoML({ acao: 'pausar', campaign_id: 7 }, ctx(mcp(e)));
  assert.deepEqual(r, { ok: false, bloqueado: true });
});
