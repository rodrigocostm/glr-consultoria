// Segundo Cérebro escrito pelos agentes: nota por cliente, índice da carteira e "anota que…"
const { test, afterEach } = require('node:test'); const assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock';
const C = require('../api/_cerebro-agentes'); const orig = global.fetch; afterEach(() => { global.fetch = orig; });
const ok = (d, status = 200) => ({ ok: true, status, json: async () => d, text: async () => JSON.stringify(d) });
const med = (conta, v, extra = {}) => ({ conta_id: conta, titulo: 'ROAS ajustado — Campanha Mesa', dados: { roas_de: 15, roas_para: 12, medicao: { veredito: v, resumo: 'vendas R$ 1.000 → R$ 1.400, ACOS 6% → 7%', medido_em: '2026-11-05T12:00:00Z' }, ...extra } });
const plano = { semaforo: 'amarelo', metricas: { projecao: 100000, meta: 120000, pctMeta: 83.3, tacos: 6.2, metaTacos: 6, varMes: 12 }, diagnostico: 'Projeção abaixo da meta.', acoes: [{ titulo: 'Repor estoque do Armário', impacto: '~R$ 3.000' }] };
const lojas = [{ mkt: 'shopee', conta: '111', nome: 'Loja S', sinais: { resumo: { produtos: 80, comCusto: 70, zerados: 2, criticos: 1, negativos: 1 }, destaques: { zerados: ['Armário X'], criticos: [{ n: 'Mesa Y', d: 4 }], negativos: [{ n: 'Cadeira Z', m: -3.5 }] } }, reputacao: { resumo: { nivel: 'Verde' } }, qualidade: { resumo: { ruins: 1 }, destaques: { ruins: [{ n: 'Puff', qa: 'foto ruim' }] } } }];

test('nota do cliente traz placar do ADS, exemplos, estoque/margem e links', () => {
  const t = C.notaCliente({ nome: 'Cliente X' }, plano, lojas, [med('111', 'melhorou'), med('111', 'melhorou'), med('111', 'piorou', { roas_de: 10, roas_para: 14 }), med('999', 'melhorou')]);
  assert.match(t, /^# Cliente X — o que os agentes sabem/);
  assert.match(t, /\*\*3\*\* medidos, \*\*2\*\* melhoraram, \*\*1\*\* pioraram/, 'só conta as lojas do cliente');
  assert.match(t, /Baixar a meta de ROAS \(lance mais forte\): 2 de 2 melhoraram/);
  assert.match(t, /Subir a meta de ROAS \(conter\): 0 de 1 melhoraram, 1 pioraram/);
  assert.match(t, /2 sem estoque \(ex\.: Armário X\); 1 acabam em até 7 dias \(ex\.: Mesa Y, ~4 d\); 1 com margem negativa \(ex\.: Cadeira Z, -3,5%\); 10 produto\(s\) vendendo sem custo/);
  assert.match(t, /\[\[Agentes · Carteira\]\]/); assert.match(t, /\[\[Agentes · Cliente X\]\]/);
  assert.match(t, /TACOS do mês: \*\*6,2%\*\* \(meta 6% — acima\)/);
});

test('gravar cria a nota publicada e não regrava se só a data mudou', async () => {
  const calls = [];
  let existe = null;
  global.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if ((init.method || 'GET') === 'GET') return ok(existe ? [existe] : []);
    return ok(init.method === 'PATCH' ? [{ id: 'x' }] : null, init.method === 'POST' ? 201 : 200);
  };
  const r1 = await C.anotarCliente({ nome: 'Cliente X' }, plano, lojas, []);
  assert.equal(r1.nova, true);
  const post = calls.find(c => c.method === 'POST').body;
  assert.equal(post.titulo, 'Agentes · Cliente X'); assert.equal(post.estado, 'publicado'); assert.equal(post.categoria, 'Aprendizados'); assert.ok(post.tags.includes('agentes'));
  existe = { ...post, conteudo: post.conteudo.replace(/em \d\d\/\d\d, \d\d:\d\d/, 'em 01/01, 00:00') };
  calls.length = 0;
  const r2 = await C.anotarCliente({ nome: 'Cliente X' }, plano, lojas, []);
  assert.equal(r2.mudou, false); assert.ok(!calls.some(c => c.method === 'PATCH'), 'sem mudança real, não cria versão nova');
});

test('anotar acrescenta no fim da nota existente com data e autor, mantendo o estado', async () => {
  let patch = null;
  global.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') return ok([{ id: '1', titulo: 'Mega Facil — combinados', conteudo: 'antigo', tags: ['x'], estado: 'rascunho', versao: 3, historico: [] }]);
    patch = JSON.parse(init.body); return ok([{ id: '1' }]);
  };
  await C.anotar({ titulo: 'Mega Facil — combinados', texto: 'Não aceita promoção abaixo de 10% de margem.', autor: 'Promoções · pedido de ana@glr' });
  assert.match(patch.conteudo, /^antigo\n\n## \d\d\/\d\d, \d\d:\d\d — Promoções · pedido de ana@glr\nNão aceita promoção/);
  assert.equal(patch.versao, 4); assert.equal(patch.estado, undefined, 'não mexe no estado escolhido pela equipe');
});
