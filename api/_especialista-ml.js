// ============================================================
// GLR Consultoria — Especialista em ADS do Mercado Livre (Product Ads)
// ------------------------------------------------------------
// O agente do ML (api/_agente-ml.js) calcula as recomendações candidatas por
// regra, com os números reais da conta (campanhas, anúncios, parcela de
// impressões, margem, estoque, TACOS). Este especialista revisa esse conjunto
// como um gestor de Mercado Ads faria: escolhe o pacote do dia (o que aplicar
// primeiro, o que esperar), explica cada escolha e escreve a estratégia da
// conta — seguindo o GUIA abaixo (boas práticas oficiais do Mercado Ads).
// Não inventa nada: só pode escolher recomendações pelo id; números e ids vêm
// das regras. Sem chave da API ou se a resposta vier fora do formato, fica a
// ordem das regras (por R$ em jogo).
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

// Boas práticas — pesquisa de 30/10/2026:
//  • Central do Mercado Ads (knowledgehub.academy.mercadoads.com/pt/product-ads)
//  • Documentação do Mercado Livre (developers.mercadolivre.com.br, Product Ads leitura: ACOS → ROAS)
//  • Blog do Mercado Pago (mercadopago.com.br/blog/como-usar-mercado-ads-destacar-produtos)
const GUIA = `GUIA DE PRODUCT ADS DO MERCADO LIVRE (boas práticas oficiais do Mercado Ads + regras da GLR)
1. Métrica: o ML migrou de ACOS objetivo para ROAS objetivo (ACOS = 100 ÷ ROAS). ROAS objetivo menor = lance mais agressivo, mais volume; maior = mais rentabilidade por venda.
2. Aprendizado: o Mercado Ads recomenda não modificar nem pausar campanha nos primeiros 30 dias — o algoritmo coleta sinais. Mudança relevante (ROAS, orçamento) reinicia o aprendizado; a atribuição é de 14 dias após o clique, então o efeito de uma mudança só aparece em 1–2 semanas. Não mexer duas vezes na mesma campanha em poucos dias.
3. Anúncio ruim: se um produto consome investimento sem resultado, pause SÓ esse anúncio, não a campanha inteira. Mas pausar tira exposição e pode derrubar a venda orgânica: só pause com prova — cliques suficientes para, na conversão normal do ADS da conta, esperar pelo menos 3 vendas (4 com o TACOS dentro do teto) e nenhuma veio; e nunca pause produto que vende na loja (orgânico) — nesse caso baixe o lance (campanha mais conservadora). Produto que vende pelo ADS com ACOS alto não se pausa: vai para campanha mais conservadora. Poucas pausas por dia (no máximo 3), as de maior gasto desperdiçado.
4. Diagnóstico de escala: impressões ganhas + perdidas por orçamento + perdidas por classificação = 100%. Perdendo por ORÇAMENTO → subir orçamento (não deixe orçamento limitante). Perdendo por CLASSIFICAÇÃO → ROAS objetivo alto demais OU anúncio fraco (qualidade, ficha, envio, preço); se o ACOS já está no limite da margem, o caminho é melhorar o anúncio, não o lance.
5. Rentabilidade e TACOS: quem governa a conta é o TACOS (ADS ÷ faturamento total). Com o TACOS dentro do teto, NÃO aperte (subir ROAS / cortar orçamento) campanha só porque o ACOS dela passa da meta — isso tira venda da conta; só otimize a campanha que está muito acima (mais que o dobro da meta), acima do que a margem do produto aguenta (prejuízo) ou na contenção forte, e prefira tirar o anúncio que puxa o ACOS antes de mexer na campanha. Com o TACOS acima do teto, não acelere e aí sim contenha as campanhas acima da meta.
6. Estrutura: a campanha automática fica (não dá para excluir). As manuais se organizam por estratégia/margem (rentabilidade, crescimento, lançamento), categoria ou sazonalidade. Produto que puxa o ACOS de uma campanha vai para uma campanha mais conservadora, em vez de apertar todos.
7. Catálogo: anúncio de catálogo sem buy box perde exposição — resolver preço/frete/reputação antes de pagar clique.
8. Datas de pico (Black Friday 27/11/2026, Natal): aumentar o orçamento diário com antecedência nas campanhas eficientes.
9. Estoque: não acelerar produto que acaba em menos de ~10 dias; produto sem estoque sai da campanha até repor.`;

const SISTEMA = `Você é o especialista em Mercado Ads (Product Ads do Mercado Livre) da GLR Consultoria. O Mercado Livre não libera escrita de ADS para integrações: o analista aplica no painel o que você escolher, então cada recomendação precisa valer o trabalho.
Você recebe as RECOMENDAÇÕES CANDIDATAS (já calculadas por regra, com números reais) e os dados da conta. Sua tarefa:
- Escolher o pacote do dia: no máximo 8 recomendações, em ordem de prioridade, seguindo o guia. Descarte as que conflitam com o guia (ex.: mexer em campanha em aprendizado ou alterada há poucos dias, apertar campanha com TACOS dentro do teto, acelerar sem estoque) e as que duplicam outra (mesma campanha: fique com a mais importante).
- Para cada escolhida, escrever "porque": 1 ou 2 frases objetivas de gestor de Mercado Ads, usando SÓ números que aparecem nos dados. Nunca invente número, produto, campanha ou id.
- Escrever a "estrategia" da conta: 2 a 4 frases curtas com o que está travando o crescimento e a direção das próximas 2 semanas, usando os dados das campanhas (parcela de impressões, perdas por orçamento/classificação, ACOS × limite, TACOS × teto).
Dentro dos textos, nunca use aspas duplas (para citar produto ou campanha use aspas simples). Responda APENAS um JSON válido: {"escolhidas":[{"id":"<id da candidata>","prioridade":1,"porque":"..."}],"estrategia":"...","esperar":["<o que NÃO fazer agora e por quê, 1 frase cada, no máximo 3>"]}`;

async function revisar({ Anthropic, anthropicKey, conta, candidatos }) {
  const porRegra = () => ({ escolhidas: [...candidatos].sort((a, b) => (b.dados?.prioridade || 0) - (a.dados?.prioridade || 0)).slice(0, 8).map((c, i) => ({ id: c.id, prioridade: i + 1, porque: null })), estrategia: null, esperar: [], fonte: 'regra' });
  if (!anthropicKey || !Anthropic) return { ...porRegra(), erro: 'sem chave da API ou cliente da Anthropic' };
  const entrada = {
    conta,
    candidatas: candidatos.map(c => ({ id: c.id, titulo: c.titulo, explicacao: String(c.explicacao || '').slice(0, 600), acao: c.dados?.acao, campanha: c.dados?.campanha || null, impacto_semana_rs: c.dados?.impacto ?? null, tipo_impacto: c.dados?.impacto_tipo || null })),
  };
  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const r = await client.messages.create({
      model: 'claude-opus-5-5', max_tokens: 3000,
      system: `${SISTEMA}\n\n${GUIA}`,
      messages: [{ role: 'user', content: JSON.stringify(entrada) }],
    });
    const txt = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const ler = t => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    let j;
    try { j = ler(txt); } catch (e1) {
      // JSON quebrado (ex.: aspas dentro de um texto): pede a mesma resposta de novo, corrigida
      const r2 = await client.messages.create({
        model: 'claude-opus-5-5', max_tokens: 3000,
        system: `${SISTEMA}\n\n${GUIA}`,
        messages: [{ role: 'user', content: JSON.stringify(entrada) }, { role: 'assistant', content: txt }, { role: 'user', content: `Esse JSON é inválido (${String(e1.message).slice(0, 120)}). Responda de novo SÓ o JSON válido, com o mesmo conteúdo e sem aspas duplas dentro dos textos.` }],
      });
      j = ler((r2.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
    }
    const ids = new Set(candidatos.map(c => c.id)), vistos = new Set();
    // só vale id que existe — o especialista não cria recomendação
    const escolhidas = (Array.isArray(j.escolhidas) ? j.escolhidas : []).filter(e => e && ids.has(String(e.id)) && !vistos.has(String(e.id)) && vistos.add(String(e.id)))
      .slice(0, 8).map((e, i) => ({ id: String(e.id), prioridade: i + 1, porque: typeof e.porque === 'string' ? e.porque.trim().slice(0, 400) : null }));
    if (!escolhidas.length && candidatos.length && !Array.isArray(j.escolhidas)) return { ...porRegra(), erro: 'resposta fora do formato' };
    return { escolhidas, estrategia: typeof j.estrategia === 'string' ? j.estrategia.trim().slice(0, 900) : null, esperar: (Array.isArray(j.esperar) ? j.esperar : []).filter(x => typeof x === 'string').slice(0, 3).map(x => x.slice(0, 300)), fonte: 'especialista' };
  } catch (e) {
    return { ...porRegra(), erro: String(e.message || e).slice(0, 300) }; // fica registrado no log do especialista
  }
}

module.exports = { revisar, GUIA };
