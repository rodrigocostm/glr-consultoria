// GLR Copiloto ADS — regras da inteligência (extensao-mercado-ads/inteligencia.js) com dados no formato
// real das APIs internas do Mercado Ads, sem navegador: a "ponte" é simulada aqui.
const { test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const FONTE = fs.readFileSync(path.join(__dirname, '../extensao-mercado-ads/inteligencia.js'), 'utf8');

function carregar({ url, campanhas, eventos = {}, anuncios = [], diario = [] }) {
  const ouvintes = [], chamadas = [];
  const u = new URL(url);
  const win = {
    location: { pathname: u.pathname, search: u.search, origin: u.origin },
    addEventListener: (t, fn) => { if (t === 'message') ouvintes.push(fn); },
    postMessage(m) {
      if (m.glr !== 'req') return;
      chamadas.push(m.caminho);
      const p = new URL('https://x' + m.caminho), q = p.searchParams;
      let json = null;
      if (p.pathname === '/campaigns/search') {
        const de = q.get('dateFrom'), ate = q.get('dateTo'), dias = Math.round((Date.parse(ate) - Date.parse(de)) / 864e5);
        const jan = dias <= 8 ? 7 : dias <= 16 ? 15 : 30;
        json = { results: campanhas.map(c => ({ ...c, metrics: c.m[jan] })) };
      } else if (/\/events$/.test(p.pathname)) json = { result: eventos[p.pathname.split('/')[2]] || [] };
      else if (p.pathname === '/ads') { const off = +q.get('offset'); json = { results: anuncios.slice(off, off + +q.get('limit')) }; }
      else if (p.pathname === '/campaigns/metrics') json = { daily: { results: diario } };
      setImmediate(() => ouvintes.forEach(fn => fn({ source: win, data: { glr: 'resp', id: m.id, ok: true, status: 200, json } })));
    },
  };
  win.window = win;
  vm.runInNewContext(FONTE, { window: win, location: win.location, URLSearchParams, setTimeout, clearTimeout, Date, Math, Promise, Map, Set, String, JSON, Array, Object, Number, parseFloat });
  return { ia: win.__glrIA, chamadas };
}
const diasAtras = n => new Date(Date.now() - n * 864e5).toISOString();
const m = (cost, units, total, extra = {}) => ({ cost, unitsQuantity: units, totalAmount: total, clicks: units * 30 + 50, acos: total ? +(cost / total * 100).toFixed(2) : 0, sov: 40, organicUnitsQuantity: 1, ...extra });
const camp = (id, roasTarget, budget, m7, m15, m30, extra = {}) => ({ id, name: `C${id}`, status: 'active', roasTarget, acosTarget: +(100 / roasTarget).toFixed(2), budget, dateCreated: diasAtras(90), m: { 7: m7, 15: m15, 30: m30 }, ...extra });
const LISTA = 'https://ads.mercadolivre.com.br/product-ads/admin/campaigns?advertiserId=39696';

test('escala pelo lance quando as 3 janelas têm folga e o orçamento sobra', async () => {
  const { ia } = carregar({ url: LISTA, campanhas: [camp(1, 10, 100, m(30, 5, 1000), m(60, 10, 2000), m(120, 20, 4000))] });
  const r = await ia.analisar({});
  const x = r.itens[0];
  assert.equal(r.tipo, 'lista'); assert.equal(r.fonte, 'api');
  assert.equal(x.v, 'escalar'); assert.equal(x.gargalo, 'lance'); assert.equal(x.conf, 'alta');
  assert.ok(x.novoRoas < 10 && x.novoRoas >= 7.5, `novo ROAS ${x.novoRoas} respeita o passo de 25%`);
  assert.equal(x.esc.map(e => e.cl).join(), 'folga,folga,folga');
  assert.match(x.href, /campaigns\/1\/dashboard\?advertiser_id=39696/);
});

test('com folga e orçamento quase todo usado, o gargalo é o orçamento', async () => {
  const { ia } = carregar({ url: LISTA, campanhas: [camp(2, 10, 5, m(33, 5, 1000), m(60, 10, 2000), m(120, 20, 4000))] });
  const x = (await ia.analisar({})).itens[0];
  assert.equal(x.v, 'escalar'); assert.equal(x.gargalo, 'orçamento'); assert.ok(x.novoOrc > 5);
});

test('ACOS alto em 15 e 30 dias contém subindo o ROAS; mudança recente segura em aguardar', async () => {
  const alta = camp(3, 10, 100, m(100, 5, 500), m(200, 10, 1000), m(400, 20, 2000));
  const { ia } = carregar({ url: LISTA, campanhas: [alta, { ...alta, id: 4 }], eventos: { 4: [{ eventType: 'roas', eventTime: diasAtras(3), eventData: [{ prevValue: 8, newValue: 10 }] }] } });
  const r = await ia.analisar({});
  const c3 = r.itens.find(x => x.id === '3'), c4 = r.itens.find(x => x.id === '4');
  assert.equal(c3.v, 'conter'); assert.ok(c3.novoRoas > 10 && c3.novoRoas <= 12.5);
  assert.equal(c4.v, 'aguardar'); assert.match(c4.motivo, /de 8x para 10x há 3 dia/);
});

test('gasto sem venda em 15 dias pede correção; pouco volume não vira "perto da meta"', async () => {
  const { ia } = carregar({ url: LISTA, campanhas: [
    camp(5, 10, 100, m(30, 0, 0), m(50, 0, 0), m(80, 1, 200)),
    camp(6, 10, 100, { cost: 2, unitsQuantity: 0, clicks: 3 }, { cost: 3, unitsQuantity: 0, clicks: 5 }, { cost: 5, unitsQuantity: 1, clicks: 9, totalAmount: 100 }),
  ] });
  const r = await ia.analisar({});
  assert.equal(r.itens.find(x => x.id === '5').v, 'corrigir');
  const c6 = r.itens.find(x => x.id === '6'); assert.equal(c6.v, 'manter'); assert.match(c6.motivo, /Pouco volume/);
});

test('dentro da campanha: anúncio que gasta sem vender é retirado e problemas do anúncio aparecem', async () => {
  const anuncios = [
    { externalId: 'MLB1', title: 'Gasta sem vender', status: 'A', impressions: 9000, clicks: 260, cost: 63, soldQuantityTotal: 0, amountTotal: 0, variants: {} },
    { externalId: 'MLB2', title: 'Vende bem', status: 'A', impressions: 60000, clicks: 400, cost: 100, soldQuantityTotal: 6, amountTotal: 3000, variants: {} },
    { externalId: 'MLB3', title: 'Catálogo perdendo', status: 'A', impressions: 5000, clicks: 20, cost: 5, soldQuantityTotal: 0, amountTotal: 0, catalogListing: true, item: { priceToWin: { status: 'competing', price_to_win: 99.9 } }, variants: { noImmediateStock: 1 } },
    ...Array.from({ length: 55 }, (_, i) => ({ externalId: `MLBX${i}`, title: 'x', status: 'A', impressions: 0, clicks: 0, cost: 0, soldQuantityTotal: 0, amountTotal: 0 })),
  ];
  const { ia, chamadas } = carregar({ url: 'https://ads.mercadolivre.com.br/product-ads/admin/campaigns/7/dashboard?advertiserId=39696',
    campanhas: [camp(7, 10, 100, m(30, 5, 1000), m(60, 10, 2000), m(120, 20, 4000, { clicks: 700 }))],
    diario: Array.from({ length: 14 }, () => ({ cost: 95, unitsQuantity: 1 })), anuncios });
  const r = await ia.analisar({});
  assert.equal(r.tipo, 'campanha'); assert.equal(r.itens.length, 58, 'pagina os anúncios de 50 em 50');
  assert.ok(chamadas.filter(c => c.startsWith('/ads?')).every(c => /limit=50/.test(c)));
  assert.equal(r.itens.find(x => x.id === 'MLB1').v, 'retirar');
  assert.equal(r.itens.find(x => x.id === 'MLB2').v, 'escalar');
  const c3 = r.itens.find(x => x.id === 'MLB3'); assert.equal(c3.v, 'avaliar'); assert.ok(c3.prob.some(p => /buy box.*99.9/.test(p))); assert.ok(c3.prob.includes('sem estoque imediato'));
  assert.ok(r.vc.notas.some(n => /Bateu o orçamento em 14 de 14 dias/.test(n)));
});
