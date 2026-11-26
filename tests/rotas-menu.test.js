// Toda tela registrada no Router precisa ter um caminho: estar no menu (index.html
// ou menu do portal), ser um redirecionamento para outra tela, ou estar na lista
// abaixo de telas abertas por link/fluxo. Tela nova escondida quebra este teste.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
// só os scripts que o index.html carrega de fato
const js = [...html.matchAll(/<script src="js\/([\w.-]+\.js)/g)].map(m => fs.readFileSync(path.join(raiz, 'js', m[1]), 'utf8')).join('\n');

// abertas por link ou fluxo, não pelo menu
const POR_LINK = {
  'cliente-perfil': 'cartões e listas de clientes',
  'anuncios-ml': 'Criar anúncio', 'anuncios-shopee': 'Criar anúncio', 'anuncios-tiktok': 'Criar anúncio',
  'analytics-conteudo': 'embutida no Painel',
  'ia': 'ícone de IA no topo',
  'portal-dashboard': 'portal antigo (admin cai no Painel)', 'portal-vendas': 'portal antigo', 'portal-abc': 'portal antigo',
};

// abas de uma tela unida (js/telas-unidas.js): o endereço antigo abre a tela nova
const unidas = new Set([...fs.readFileSync(path.join(raiz, 'js/telas-unidas.js'), 'utf8').matchAll(/\{ id: '([^']+)', nome:/g)].map(m => m[1]));

test('nenhuma tela fica órfã do menu', () => {
  const rotas = [...js.matchAll(/Router\.register\('([^']+)'\s*,\s*([^\n]*)/g)];
  const noMenu = new Set([...html.matchAll(/data-page="([^"$]+)"/g), ...js.matchAll(/data-page="([^"$]+)"/g)].map(m => m[1]));
  const orfas = rotas.filter(([, r, corpo]) => {
    if (noMenu.has(r) || POR_LINK[r] || unidas.has(r)) return false;
    // redirecionamento: o registro só chama Router.navigate para outra tela
    if (/^(\(\)|\([^)]*\))\s*=>\s*(setTimeout\(\(\)\s*=>\s*)?Router\.navigate\(/.test(corpo)) return false;
    if (/^paginaDatasEspeciais/.test(corpo)) return false; // black-friday = Datas especiais
    if (r === 'funil' || r === 'notificacoes') return false; // redirecionam por dentro (Vendas › Funil, Decisões › Notificações)
    return true;
  }).map(m => m[1]);
  assert.deepEqual(orfas, []);
});

test('Tarefas, Score GLR e Performance Gestor estão no menu e nos grupos', () => {
  for (const p of ['tarefas', 'score', 'performance']) assert.match(html, new RegExp(`data-page="${p}"`));
  const nav = fs.readFileSync(path.join(raiz, 'js/nav.js'), 'utf8');
  assert.match(nav, /'plano-acao', 'tarefas'/);
  assert.match(nav, /'gestores', 'performance', 'score'/);
});
