const test = require('node:test');
const a = require('node:assert/strict');
const S = require('../js/score-contas.js');

test('score: média ponderada só dos critérios com dado', () => {
  const r = S.calcular({
    mkt: 'ml',
    qualidade: { analisados: 100, ruins: 10, melhorar: 10, expRuim: 2 },  // 80% ok → 100; mal avaliados 2% → 100
    sinais: { comCusto: 10, negativos: 1, apertados: 0 },                // 90% → 100
    reputacao: { nota: 5 },                                              // verde → 100
    ads: { ads: 140, fat: 1000 },                                        // TACOS 14% → 50
  });
  a.equal(r.usados, 5);
  const ads = r.itens.find(i => i.id === 'ads');
  a.equal(ads.valor, 14); a.equal(ads.nota, 50);
  // (100·15 + 50·15 + 100·15 + 100·15 + 100·10) / 70
  a.equal(r.score, Math.round((1500 + 750 + 1500 + 1500 + 1000) / 70));
  a.equal(r.itens.find(i => i.id === 'preco').nota, null); // sem catálogo: fica de fora, não vira zero
});

test('score: sem nenhum dado não inventa nota', () => {
  const r = S.calcular({ mkt: 'shopee' });
  a.equal(r.score, null); a.equal(r.usados, 0);
});

test('critérios da Shopee: GMV Max da loja, nota da loja e avaliações dos produtos', () => {
  const m = S.metricas({
    mkt: 'shopee', oport: { gmv_loja: true, vendidos_30d: 50, vendidos_em_ads: 0 },
    reputacao: { notaLoja: 3 }, promocoes: { analisados: 20, emPromo: 5 },
    funil: { a: { r: 4.9, nr: 100 }, b: { r: 4.2, nr: 10 }, c: { r: 3, nr: 2 } },
  });
  a.equal(m.semCampanha, 0);
  a.equal(m.reputacao, 66.7);
  a.equal(m.semPromocao, 75);
  a.equal(m.malAvaliados, 50); // c tem menos de 5 avaliações e não entra
});

test('config editável: pesos e faixas salvos valem; inválidos voltam ao padrão', () => {
  const c = S.config({ criterios: { ads: { peso: 0, zero: 30, cem: 5 }, preco: { peso: 5, zero: 10, cem: 10 } }, faixas: { limites: [80, 60] } });
  a.equal(c.criterios.ads.peso, 0); a.equal(c.criterios.ads.zero, 30);
  a.equal(c.criterios.preco.zero, 30); // zero === cem não vale
  a.deepEqual(c.faixas.limites, S.FAIXAS_PADRAO.limites);
  const r = S.calcular({ mkt: 'ml', ads: { ads: 0, fat: 100 }, reputacao: { nota: 1 } }, c);
  a.equal(r.score, 0); // peso 0 tira o ADS; só a reputação vermelha conta
  a.equal(S.cor(40), '#ef4444'); a.equal(S.cor(60), '#facc15'); a.equal(S.cor(90), '#22c55e');
});

test('histórico: registro do dia guarda o valor bruto e a nota é refeita com os pesos atuais', () => {
  const agora = Date.parse('2026-11-27T15:00:00Z');
  const agentes = S.mapaAgentes({
    reputacao: [{ marketplace: 'ml', conta_id: '1', ultimo_sucesso: '2026-11-27T10:00:00Z', rep: { nota: 5 } },
      { marketplace: 'ml', conta_id: '2', ultimo_sucesso: '2026-11-01T10:00:00Z', rep: { nota: 5 } }], // velho: fora
  }, agora);
  a.ok(agentes['ml:1'] && !agentes['ml:2']);
  const dias = {}; for (let d = 1; d <= 30; d++) dias[`2026-10-${String(d).padStart(2, '0')}`] = { faturamento: 100, ads: 10 };
  const t0 = new Date('2026-10-01T00:00:00-03:00').getTime() / 1000;
  const base = {
    'ml:1': { dias: { ...dias, '2026-11-26': { faturamento: 1000, ads: 100 } }, historicoAte: t0 - 10 * 864e2 * 10, resumoEm: 'x', adsHistAte: t0 - 1 },
    'shopee:9': { dias, historicoAte: Date.now() / 1000, resumoEm: 'x', adsHistAte: 1 }, // base não cobre: sem TACOS
    'tiktok:5': { dias, historicoAte: 1, resumoEm: 'x', adsHistAte: 1 },
  };
  const reg = S.registroDoDia(agentes, base, '2026-11-27', agora);
  a.deepEqual(Object.keys(reg.lojas), ['ml:1']); // shopee sem nenhum dado e tiktok ficam de fora
  const m = S.metricasDoRegistro(reg, 'ml:1');
  a.equal(m.reputacao, 100); a.equal(m.ads, 10); // só 28/10–26/11 entram: 1000 + 3×100 de fat., 100 + 3×10 de ADS
  a.equal(S.deMetricas(m).score, S.calcular({ mkt: 'ml', reputacao: { nota: 5 }, ads: { ads: 130, fat: 1300 } }).score);
  const semAds = S.config({ criterios: { ads: { peso: 0, zero: 20, cem: 8 } } });
  a.equal(S.deMetricas(m, semAds).score, 100);
  a.equal(S.metricasDoRegistro(reg, 'ml:999'), null);
});

test('cron do score agendado no vercel.json', () => {
  const v = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../vercel.json'), 'utf8'));
  a.ok(v.crons.some(c => c.path === '/api/score-cron' && c.schedule === '50 2 * * *'));
});
