const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agruparFerramentas, executarEmGrupos } = require('../api/chat-central').interno;

test('leituras do Supabase ficam no mesmo grupo e o Tiops fica sozinho', () => {
  const grupos = agruparFerramentas(['vendas', 'ads', 'estoque_margem', 'campanhas_shopee', 'carteira', 'campanhas_ml', 'consultar_mercado_tiops', 'historico_agentes', 'plano_cliente']);
  assert.deepEqual(grupos, [
    { paralelo: true, nomes: ['vendas', 'ads', 'estoque_margem'] },
    { paralelo: false, nomes: ['campanhas_shopee'] },
    { paralelo: true, nomes: ['carteira'] },
    { paralelo: false, nomes: ['campanhas_ml'] },
    { paralelo: false, nomes: ['consultar_mercado_tiops'] },
    { paralelo: true, nomes: ['historico_agentes', 'plano_cliente'] },
  ]);
});

test('escrita e ferramenta desconhecida não correm junto com ninguém', () => {
  const grupos = agruparFerramentas(['propor_acao', 'anotar_cerebro', 'vendas', 'recursos_tiops']);
  assert.equal(grupos.filter(g => g.paralelo).length, 1);
  assert.deepEqual(grupos.map(g => g.nomes), [['propor_acao'], ['anotar_cerebro'], ['vendas'], ['recursos_tiops']]);
});

test('o grupo paralelo se sobrepõe e o Tiops espera a vez, na ordem original', async () => {
  let vivos = 0, maximo = 0;
  const ordem = [];
  const saida = await executarEmGrupos(['vendas', 'ads', 'campanhas_shopee', 'carteira'], async (nome) => {
    vivos++; maximo = Math.max(maximo, vivos);
    ordem.push('ini:' + nome);
    await new Promise(r => setTimeout(r, nome.startsWith('campanhas') ? 30 : 40));
    vivos--;
    ordem.push('fim:' + nome);
    return nome;
  });
  assert.deepEqual(saida, ['vendas', 'ads', 'campanhas_shopee', 'carteira']);
  assert.equal(maximo, 2); // vendas e ads juntos; shopee e carteira nunca dividem a vez com outro
  assert.ok(ordem.indexOf('fim:vendas') < ordem.indexOf('ini:campanhas_shopee'));
  assert.ok(ordem.indexOf('fim:campanhas_shopee') < ordem.indexOf('ini:carteira'));
});
