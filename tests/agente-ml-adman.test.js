const { test } = require('node:test'); const assert = require('node:assert/strict');
const { decidir, rodadaConta, aplicar } = require('../api/_agente-ml-adman');
const { criarCliente } = require('../api/_adman');

const v = x => ({ value: x });
const camp = (id, o = {}, m7 = {}, m14 = {}) => ({ id, nome: `C${id}`, status: 'active', criadaEm: '2026-08-01T00:00:00Z', ...o,
  m7: { acos: v(6), investment: v(200), soldQuantity: v(10), roasTarget: 15, targetAcos: 6.67, dailyBudget: 100, lostImpressionShareByBudget: 0, lostImpressionShareByAdRank: 30, ...m7 },
  m14: { investment: v(400), soldQuantity: v(20), revenue: v(5000), ...m14 } });
const ad = (id, campaignId, m = {}, o = {}) => ({ adgroupId: id, campaignId, name: `Anúncio ${id}`, status: 'ACTIVE', adGroupType: 'ITEM', ...o,
  metrics: { investment: v(10), unitsQuantity: v(1), totalAmount: v(200), clicks: v(20), ...m } });
const base = (o = {}) => ({ hoje: '2026-11-27', metaAcos: 6, conta7: { tacos: v(5) }, campanhas: [], anuncios14: [], ...o });

test('pausa anúncio que gastou e não vendeu, mas não o que vendeu ou tem poucos cliques', () => {
  const r = decidir(base({ campanhas: [camp('a')], anuncios14: [
    ad('1', 'a', { investment: v(60), unitsQuantity: v(0), totalAmount: v(0), clicks: v(120) }),
    ad('2', 'a', { investment: v(60), unitsQuantity: v(1), totalAmount: v(300), clicks: v(120) }),
    ad('3', 'a', { investment: v(60), unitsQuantity: v(0), totalAmount: v(0), clicks: v(40) }),
    ad('4', 'a', { investment: v(30), unitsQuantity: v(0), totalAmount: v(0), clicks: v(200) }),
  ] }));
  assert.deepEqual(r.acoes.map(a => [a.acao, a.adgroup_id, a.antes, a.depois]), [['pausar_anuncio', '1', 'ativo', 'pausado']]);
  assert.match(r.acoes[0].motivo, /R\$ 60,00/);
});

test('nunca mexe em anúncio de campanha pausada nem reativa nada', () => {
  const r = decidir(base({ campanhas: [camp('a', { status: 'paused' })], anuncios14: [ad('1', 'a', { investment: v(90), unitsQuantity: v(0), totalAmount: v(0), clicks: v(300) })] }));
  assert.equal(r.acoes.length, 0);
});

test('pausa campanha sem venda em 14 dias, mas não campanha nova', () => {
  const r = decidir(base({ campanhas: [
    camp('velha', {}, { soldQuantity: v(0) }, { investment: v(150), soldQuantity: v(0), revenue: v(0) }),
    camp('nova', { criadaEm: '2026-11-20T00:00:00Z' }, { soldQuantity: v(0) }, { investment: v(150), soldQuantity: v(0), revenue: v(0) }),
  ] }));
  assert.deepEqual(r.acoes.map(a => [a.acao, a.campaign_id]), [['pausar_campanha', 'velha']]);
  assert.ok(r.ignoradas.some(i => /amadurecendo/.test(i.motivo)));
});

test('aperta ROAS no máximo 20% e respeita o teto', () => {
  const r = decidir(base({ campanhas: [camp('a', {}, { acos: v(12) }), camp('b', {}, { acos: v(9), roasTarget: 34, targetAcos: 100 / 34 })] }));
  const a = r.acoes.find(x => x.campaign_id === 'a'), b = r.acoes.find(x => x.campaign_id === 'b');
  assert.equal(a.acao, 'subir_roas'); assert.equal(a.depois, 18); // 15 × 1,2
  assert.equal(b.depois, 35); // teto roas_max
});

test('ROAS já no máximo e ACOS > 2× alvo: corta orçamento 20%', () => {
  const r = decidir(base({ campanhas: [camp('a', {}, { acos: v(14), roasTarget: 35, targetAcos: 100 / 35, dailyBudget: 100 })] }));
  assert.deepEqual(r.acoes.map(x => [x.acao, x.antes, x.depois]), [['baixar_orcamento', 100, 80]]);
});

test('sobe orçamento só com perda por verba, dentro do alvo, conta na meta e abaixo do teto', () => {
  const c = camp('a', {}, { acos: v(5), lostImpressionShareByBudget: 25 });
  assert.deepEqual(decidir(base({ campanhas: [c] })).acoes.map(x => [x.acao, x.depois]), [['subir_orcamento', 120]]);
  assert.equal(decidir(base({ campanhas: [c], conta7: { tacos: v(9) } })).acoes.length, 0);
  assert.equal(decidir(base({ campanhas: [c] }), { limites: { orcamento_teto_conta: 110 } }).acoes.length, 0);
});

test('solta ROAS no máximo 10% e não passa do piso pela meta', () => {
  const r = decidir(base({ campanhas: [camp('a', {}, { acos: v(3), lostImpressionShareByAdRank: 90 })] }));
  assert.deepEqual(r.acoes.map(x => [x.acao, x.antes, x.depois]), [['baixar_roas', 15, 13.5]]);
  // piso: meta 6% × 1,5 = ACOS 9% → ROAS mínimo 11,11
  const p = decidir(base({ campanhas: [camp('a', {}, { acos: v(3), roasTarget: 11.5, targetAcos: 100 / 11.5, lostImpressionShareByAdRank: 90 })] }));
  assert.equal(p.acoes[0].depois, 11.11);
});

test('poucos dados: não mexe em ROAS/orçamento', () => {
  const r = decidir(base({ campanhas: [camp('a', {}, { acos: v(20), investment: v(40), soldQuantity: v(1) })] }));
  assert.equal(r.acoes.length, 0);
});

test('espera de 3 dias na mesma entidade e limite de ações/pausas por dia', () => {
  const hist = [{ entidade: 'campanha:a', criado_em: '2026-11-25T12:00:00Z', resultado: 'executado' }];
  assert.equal(decidir(base({ campanhas: [camp('a', {}, { acos: v(12) })] }), {}, hist).acoes.length, 0);
  // simulado não conta para espera
  assert.equal(decidir(base({ campanhas: [camp('a', {}, { acos: v(12) })] }), {}, [{ ...hist[0], resultado: 'simulado' }]).acoes.length, 1);
  const ads = Array.from({ length: 5 }, (_, i) => ad(String(i), 'a', { investment: v(60), unitsQuantity: v(0), totalAmount: v(0), clicks: v(100) }));
  const r = decidir(base({ campanhas: [camp('a')], anuncios14: ads }));
  assert.equal(r.acoes.length, 3); assert.ok(r.ignoradas.some(i => /pausas por dia/.test(i.motivo)));
});

test('data congelada: só observa', () => {
  const r = decidir(base({ campanhas: [camp('a', {}, { acos: v(12) })] }), { limites: { datas_congeladas: ['2026-11-27'] } });
  assert.equal(r.acoes.length, 0);
});

// --- rodada completa com Adman falsa ---
function admanFalsa() {
  const chamadas = [];
  const respostas = {
    get_campaigns: { campaigns: [{ campaignId: 'a', name: 'Curva A', status: 'active' }] },
    get_campaign_metrics: { acos: v(12), investment: v(200), soldQuantity: v(10), revenue: v(1600), roasTarget: 15, targetAcos: 6.67, dailyBudget: 100, lostImpressionShareByBudget: 0, lostImpressionShareByAdRank: 50, createdAt: '2026-07-01T00:00:00Z' },
    get_adgroups_metrics: { adgroups: [ad('9', 'a', { investment: v(70), unitsQuantity: v(0), totalAmount: v(0), clicks: v(150) })], totalPages: 1 },
    get_account_metrics: { metrics: { tacos: v(5), acos: v(8) } },
  };
  return { chamadas, chamar: async (n, a) => { chamadas.push([n, a]); return respostas[n] || { ok: true }; } };
}
const sb = () => { const ins = []; return { ins, sbSelect: async () => [], sbInsert: async (t, r) => ins.push([t, r]) }; };

test('rodada em simulação: registra antes/depois/motivo e não escreve nada na Adman', async () => {
  const ad = admanFalsa(), s = sb();
  const r = await rodadaConta({ conta_id: '802228249', ligado: true, modo: 'execucao', meta_acos: 6 }, { ...s, adman: ad, hoje: '2026-11-27' }, { simular: true });
  assert.equal(r.modo, 'simulacao');
  assert.ok(!ad.chamadas.some(([n]) => n.startsWith('update_')));
  assert.equal(s.ins.length, 2);
  const [, linha] = s.ins.find(([, l]) => l.dados.acao === 'subir_roas');
  assert.equal(linha.resultado, 'simulado'); assert.equal(linha.origem, 'adman');
  assert.equal(linha.dados.antes, 15); assert.equal(linha.dados.depois, 18); assert.match(linha.titulo, /^\[Simulação\]/);
});

test('rodada em execução: aplica pela Adman e registra executado', async () => {
  const ad = admanFalsa(), s = sb();
  await rodadaConta({ conta_id: '802228249', ligado: true, modo: 'execucao', meta_acos: 6 }, { ...s, adman: ad, hoje: '2026-11-27' });
  const escritas = ad.chamadas.filter(([n]) => n.startsWith('update_'));
  assert.deepEqual(escritas.map(([n]) => n).sort(), ['update_adgroup_status', 'update_campaign_roas']);
  assert.deepEqual(escritas.find(([n]) => n === 'update_campaign_roas')[1], { marketplace: 'meli', custId: '802228249', campaignId: 'a', limitRoas: 18 });
  assert.ok(s.ins.every(([, l]) => l.resultado === 'executado'));
});

test('chave de desligar: conta desligada ou chave geral não lê nem escreve', async () => {
  const ad = admanFalsa(), s = sb();
  assert.match((await rodadaConta({ conta_id: 'x', ligado: false, modo: 'execucao' }, { ...s, adman: ad, hoje: '2026-11-27' })).skip, /desligado/);
  process.env.ADS_AUTONOMO_DESLIGADO = '1';
  try { assert.match((await rodadaConta({ conta_id: 'x', ligado: true, modo: 'execucao' }, { ...s, adman: ad, hoje: '2026-11-27' })).skip, /chave geral/); }
  finally { delete process.env.ADS_AUTONOMO_DESLIGADO; }
  assert.equal(ad.chamadas.length, 0); assert.equal(s.ins.length, 0);
});

test('erro da Adman vira registro de erro, sem parar as outras ações', async () => {
  const ad = admanFalsa(); const orig = ad.chamar;
  ad.chamar = async (n, a) => { if (n === 'update_adgroup_status') throw new Error('status 400: só 1 vez a cada 24h'); return orig(n, a); };
  const s = sb();
  const r = await rodadaConta({ conta_id: '1', ligado: true, modo: 'execucao', meta_acos: 6 }, { ...s, adman: ad, hoje: '2026-11-27' });
  assert.deepEqual(r.acoes.map(a => a.resultado).sort(), ['erro', 'executado']);
});

test('aplicar só conhece as 6 ações permitidas', async () => {
  await assert.rejects(aplicar({ chamar: async () => ({}) }, '1', { acao: 'criar_campanha' }), /desconhecida/);
});

test('cliente MCP: initialize + tools/call, lê SSE e repassa erro', async () => {
  const corpos = [];
  const fetchFn = async (url, o) => {
    const b = JSON.parse(o.body); corpos.push(b);
    const h = new Map([['content-type', b.method === 'tools/call' ? 'text/event-stream' : 'application/json'], ['mcp-session-id', 's1']]);
    const res = b.method === 'initialize' ? { jsonrpc: '2.0', id: b.id, result: {} }
      : b.method === 'tools/call' ? { jsonrpc: '2.0', id: b.id, result: b.params.name === 'ruim' ? { isError: true, content: [{ type: 'text', text: 'falhou com status 400' }] } : { content: [{ type: 'text', text: '{"ok":1}' }] } } : null;
    const txt = !res ? '' : b.method === 'tools/call' ? `event: message\ndata: ${JSON.stringify(res)}\n\n` : JSON.stringify(res);
    return { ok: true, status: 200, headers: { get: k => h.get(k.toLowerCase()) || null }, text: async () => txt };
  };
  const c = criarCliente({ url: 'https://x', token: 't', fetchFn });
  assert.deepEqual(await c.chamar('get_accounts', { marketplace: 'meli' }), { ok: 1 });
  assert.deepEqual(corpos.map(b => b.method), ['initialize', 'notifications/initialized', 'tools/call']);
  await assert.rejects(c.chamar('ruim', {}), e => e.status === 400);
});
