const { test } = require('node:test');
const assert = require('node:assert/strict');
const { conferirPlano } = require('../api/_especialista-ml');
const dossie = { campanhas: [
  { id: 1, nome: 'GERAL', produtos: [{ item_ids: ['A'], estoque: 'zerado' }, { item_ids: ['B'] }, { item_ids: ['C'] }, { item_ids: ['D'] }] },
  { id: 2, nome: 'MIX', produtos: [{ item_ids: ['E'] }] },
  { id: 3, nome: 'NOVOS', produtos: [] }], fora_de_campanha: [{ item_id: 'F' }] };
const candidatos = [{ id: 'p:A', titulo: 'tirar A', dados: { acao: 'retirar_produto', campaign_id: 1, item_ids: ['A'] } }, { id: 'c:2', titulo: 'roas MIX', dados: { acao: 'roas_target', campaign_id: 2 } }];
const travas = { 1: {}, 2: { recente: true }, 3: { aprendendo: true } };
const ok = (j, t = travas) => conferirPlano(j, { hoje: '2026-11-23', dossie, candidatos, travas: t });
test('uma ação por alvo e produto sem estoque não recebe outra ação', () => {
  const r = ok({ planos: [{ campaign_id: 1, acoes: [{ candidata: 'p:A', motivo: 'sem estoque' }, { tipo: 'mover_produto', item_ids: ['A'], destino_id: 2, motivo: 'x' }, { tipo: 'mover_produto', item_ids: ['B'], destino_id: 2, motivo: 'ok' }] }] });
  assert.deepEqual(r.planos[0].acoes.map(a => a.tipo), ['candidata', 'mover_produto']);
});
test('trava de campanha alterada há pouco descarta ajuste de ROAS', () => {
  const r = ok({ planos: [{ campaign_id: 2, acoes: [{ candidata: 'c:2', motivo: 'roas' }] }] });
  assert.equal(r.planos.find(p => p.campaign_id === '2').situacao, 'nao_mexer');
  assert.equal(ok({ planos: [{ campaign_id: 2, acoes: [{ candidata: 'c:2', motivo: 'roas' }] }] }, { 2: { recente: true, acos_dobro: true } }).planos[0].situacao, 'mexer');
});
test('campanha esquecida aparece como não mexer; id inventado é ignorado', () => {
  const r = ok({ planos: [{ campaign_id: 99, acoes: [] }] });
  assert.deepEqual(r.planos.map(p => p.campaign_id).sort(), ['1', '2', '3']);
  assert.ok(r.planos.every(p => p.situacao === 'nao_mexer'));
});
test('criar campanha: 3+ produtos do dossiê, valores na faixa, 1 por semana', () => {
  const c = { tipo: 'criar_campanha', nome: 'Nova', item_ids: ['B', 'C', 'F'], roas_objetivo: 9, orcamento_dia: 40, motivo: 'grupo' };
  assert.equal(ok({ planos: [], fora_de_campanha: [c] }).fora.length, 1);
  assert.equal(ok({ planos: [], fora_de_campanha: [{ ...c, item_ids: ['B', 'C'] }] }).fora.length, 0);
  assert.equal(ok({ planos: [], fora_de_campanha: [{ ...c, item_ids: ['B', 'C', 'Z'] }] }).fora.length, 0);
  assert.equal(ok({ planos: [], fora_de_campanha: [{ ...c, roas_objetivo: 0 }] }).fora.length, 0);
  assert.equal(ok({ planos: [], fora_de_campanha: [{ ...c, item_ids: ['A', 'B', 'C'] }] }).fora.length, 0);
  assert.equal(ok({ planos: [], fora_de_campanha: [c] }, { ...travas, _criouSemana: true }).fora.length, 0);
});
test('no máximo 3 ações por campanha e data de reavaliar sempre válida', () => {
  const m = i => ({ tipo: 'mover_produto', item_ids: [i], destino_id: 2, motivo: 'm', reavaliar_em: 'amanhã' });
  const r = ok({ planos: [{ campaign_id: 1, acoes: [m('B'), m('C'), m('D'), { candidata: 'p:A', motivo: 'x' }] }] });
  assert.equal(r.planos[0].acoes.length, 3);
  assert.ok(r.planos[0].acoes.every(a => a.reavaliar_em === '2026-11-30'));
});
