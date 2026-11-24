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

const SISTEMA = `Priorize contribuição adicional hipotética ponderada pela confiança, sem tratar projeções como lucro garantido. ACOS é eficiência do ADS; TACOS é ADS sobre faturamento total: nunca use um como meta do outro. A meta de faturamento não autoriza ultrapassar margem, estoque ou teto de TACOS. Respeite os valores de cada teste e não crie ações. Comparações antes/depois são observacionais.
Você é o especialista em Mercado Ads (Product Ads do Mercado Livre) da GLR Consultoria. O Mercado Livre não libera escrita de ADS para integrações: o analista aplica no painel o que você escolher, então cada recomendação precisa valer o trabalho.
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
    candidatas: candidatos.map(c => ({ id: c.id, titulo: c.titulo, explicacao: String(c.explicacao || '').slice(0, 600), acao: c.dados?.acao, campanha: c.dados?.campanha || null, impacto_semana_rs: c.dados?.impacto ?? null, tipo_impacto: c.dados?.impacto_tipo || null, crescimento: c.dados?.crescimento || null, experimento: c.dados?.experimento || null, prioridade_calculada: c.dados?.prioridade ?? null })),
  };
  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const r = await client.messages.create({
      model: 'claude-sonnet-5-5', max_tokens: 3000,
      system: `${SISTEMA}\n\n${GUIA}`,
      messages: [{ role: 'user', content: JSON.stringify(entrada) }],
    });
    const txt = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const ler = t => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    let j;
    try { j = ler(txt); } catch (e1) {
      // JSON quebrado (ex.: aspas dentro de um texto): pede a mesma resposta de novo, corrigida
      const r2 = await client.messages.create({
        model: 'claude-sonnet-5-5', max_tokens: 3000,
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


// ============================================================
// PLANEJADOR (23/11/2026 — docs/especificacao-agente-ads-ml.md)
// Em vez de só filtrar as candidatas, lê o dossiê da conta inteira (campanhas,
// produtos de cada campanha com estoque/margem/curva, produtos fora do ADS,
// histórico do que foi aplicado e medido) e devolve UM plano por campanha:
// até 3 ações em ordem, cada uma com motivo, efeito esperado, data para
// reavaliar e quando desfazer — ou "não mexer". Pode propor, além das
// candidatas, mover produto entre campanhas e criar campanha nova (o código
// confere ids e valores; o analista cria/move à mão no painel do ML).
// Objetivo da conta: crescer o faturamento com o gasto equilibrado (TACOS no teto).
// ============================================================
const SISTEMA_PLANO = `Você é o gestor sênior de Mercado Ads (Product Ads do Mercado Livre) da GLR Consultoria. O Mercado Livre não libera escrita de ADS para integrações: o analista aplica à mão o que você planejar, então o plano precisa ser certo, coerente e fácil de executar.
OBJETIVO DA CONTA: fazer o faturamento crescer com o gasto equilibrado — TACOS do mês dentro do teto do cliente, ACOS de cada produto dentro do limite da margem. Crescer onde há venda comprovada, estoque e folga de TACOS; conter onde o gasto não volta.
Você recebe o DOSSIÊ: dados da conta, cada campanha com seus produtos (família, gasto, vendas pelo ADS, ACOS, cliques, unidades, participação na venda da campanha, estoque, grupo de crescimento), produtos que vendem fora do ADS, o histórico (o que foi aplicado nos últimos 30 dias e o resultado medido) e as TRAVAS calculadas por código. Recebe também as CANDIDATAS (ações já calculadas por regra, com ids e valores conferidos).
Monte UM plano por campanha ativa:
- situacao "mexer" com 1 a 3 ações em ordem (primeiro produtos, depois a campanha), ou "nao_mexer" (é resposta válida e frequente: campanha na meta, em aprendizado, alterada há pouco, ou esperando efeito).
- Cada ação é: uma candidata pelo id ({"candidata":"<id>"}), OU "mover_produto" ({"tipo":"mover_produto","item_ids":[...],"destino_id":<id de outra campanha ativa>}), OU "criar_campanha" ({"tipo":"criar_campanha","nome":"...","estrategia":"PROFITABILITY|INCREASE|VISIBILITY","roas_objetivo":n,"orcamento_dia":n,"item_ids":[...]}). Use só item_ids e campaign_ids que aparecem no dossiê; nunca invente número.
- Toda ação leva: "motivo" (1-2 frases de gestor com os números que decidiram), "esperado" (efeito previsto e prazo), "reavaliar_em" (AAAA-MM-DD, entre 5 e 21 dias à frente), "desfazer_se" (sinal objetivo para voltar atrás), "confianca" (alta|media|baixa) e, para pausas/retiradas, "voltar_quando".
REGRAS DURAS (respeite as travas):
- Campanha em aprendizado (menos de 30 dias) ou alterada há menos de 7 dias: não mexer em ROAS/orçamento, salvo ACOS acima do dobro da meta.
- Produto sem estoque nunca recebe mais verba. Se ele é o carro-chefe da campanha (participação alta), retire só o anúncio até repor e diga quando voltar — nunca pause a campanha por isso; os outros produtos seguem.
- Nunca diga "escalar" e "pausar/retirar" no mesmo produto ou campanha. Uma ação por alvo.
- Perda de impressões por classificação alta: mais orçamento não resolve — ROAS objetivo (se a margem permitir) ou melhorar o anúncio.
- TACOS dentro do teto: não aperte campanha que vende só porque o ACOS passou da meta; prefira tirar/mover o produto que puxa o ACOS.
- TACOS acima do teto: não acelere; contenha primeiro o que gasta sem retorno.
- criar_campanha: só para um grupo de 3 ou mais produtos parecidos que não cabem nas campanhas atuais (ex.: produtos de ACOS alto que pedem ROAS mais conservador; produtos novos misturados com campeões; produtos que vendem bem fora do ADS). No máximo 1 por conta. Diga de quais campanhas os produtos saem.
- Aprenda com o histórico: se uma ação parecida já foi medida como ruim nesta conta, não repita.
Escreva também "estrategia" (2-4 frases: o que trava o crescimento e a direção das próximas 2 semanas) e "esperar" (até 3 coisas que NÃO fazer agora e por quê).
Nos textos, nunca use aspas duplas (use aspas simples). Responda APENAS JSON válido:
{"estrategia":"...","esperar":["..."],"planos":[{"campaign_id":123,"situacao":"mexer|nao_mexer","resumo":"1 frase","reavaliar_em":"AAAA-MM-DD","acoes":[{...}]}],"fora_de_campanha":[{...ação de candidata ou criar_campanha para produtos fora do ADS, mesmos campos}]}`;

const DIA = 864e5;
const isoMais = (iso, d) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * DIA).toISOString().slice(0, 10);
const txt = (v, n = 300) => typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null;

// Camada 3 — conferência: só passa o que bate com o dossiê e com as travas
function conferirPlano(j, { hoje, dossie, candidatos, travas }) {
  const cand = new Map(candidatos.map(c => [String(c.id), c]));
  const camp = new Map(dossie.campanhas.map(c => [String(c.id), c]));
  const itemCamp = new Map(); // item → campanha onde está ativo
  for (const c of dossie.campanhas) for (const p of c.produtos || []) for (const i of p.item_ids || []) itemCamp.set(String(i), String(c.id));
  const fora = new Set((dossie.fora_de_campanha || []).map(p => String(p.item_id)));
  const semEstoque = new Set(dossie.campanhas.flatMap(c => (c.produtos || []).filter(p => p.estoque === 'zerado').flatMap(p => p.item_ids.map(String))));
  const usadosAlvo = new Set(), usadosItem = new Set(), descartes = [];
  let criadas = 0;
  const data = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && v > hoje && v <= isoMais(hoje, 30) ? v : isoMais(hoje, 7);
  const conf = v => ['alta', 'media', 'baixa'].includes(v) ? v : 'media';
  function validar(a, origemId) {
    if (!a || typeof a !== 'object') return null;
    const extra = { motivo: txt(a.motivo, 400), esperado: txt(a.esperado, 240), reavaliar_em: data(a.reavaliar_em), desfazer_se: txt(a.desfazer_se, 240), voltar_quando: txt(a.voltar_quando, 200), confianca: conf(a.confianca) };
    if (!extra.motivo) { descartes.push('ação sem motivo'); return null; }
    if (a.candidata != null) {
      const c = cand.get(String(a.candidata)); if (!c) { descartes.push(`candidata inexistente ${a.candidata}`); return null; }
      const d = c.dados || {};
      const alvo = d.item_ids?.length ? d.item_ids.map(String) : null;
      const kAlvo = alvo ? null : `c:${d.campaign_id}:${['roas_target', 'orcamento', 'pausar'].includes(d.acao) ? 'campanha' : d.acao}`;
      if (alvo ? alvo.some(i => usadosItem.has(i)) : usadosAlvo.has(kAlvo)) { descartes.push(`${c.titulo}: alvo repetido`); return null; }
      // trava: campanha em aprendizado / alterada há pouco não recebe ajuste de ROAS/orçamento (salvo ACOS > 2× meta)
      const t = travas[String(d.campaign_id)];
      if (t && ['roas_target', 'orcamento'].includes(d.acao) && (t.aprendendo || t.recente) && !t.acos_dobro) { descartes.push(`${c.titulo}: campanha ${t.aprendendo ? 'em aprendizado' : 'alterada há pouco'}`); return null; }
      if (alvo) alvo.forEach(i => usadosItem.add(i)); else usadosAlvo.add(kAlvo);
      return { tipo: 'candidata', c, ...extra };
    }
    const ids = [...new Set((Array.isArray(a.item_ids) ? a.item_ids : []).map(String))].filter(Boolean);
    if (!ids.length || ids.some(i => usadosItem.has(i))) { descartes.push(`${a.tipo}: itens vazios ou repetidos`); return null; }
    if (ids.some(i => semEstoque.has(i))) { descartes.push(`${a.tipo}: inclui produto sem estoque`); return null; }
    if (a.tipo === 'mover_produto') {
      const dest = camp.get(String(a.destino_id));
      const origem = ids.map(i => itemCamp.get(i));
      if (!dest || origem.some(o => !o || o === String(a.destino_id)) || new Set(origem).size !== 1) { descartes.push('mover_produto: campanha de origem/destino não confere'); return null; }
      ids.forEach(i => usadosItem.add(i));
      return { tipo: 'mover_produto', item_ids: ids, origem_id: origem[0], destino_id: String(a.destino_id), ...extra };
    }
    if (a.tipo === 'criar_campanha') {
      const roas = +a.roas_objetivo, orc = +a.orcamento_dia;
      if (criadas >= 1 || travas._criouSemana) { descartes.push('criar_campanha: já há uma campanha nova sugerida nesta semana'); return null; }
      if (ids.length < 3 || ids.some(i => !itemCamp.has(i) && !fora.has(i))) { descartes.push('criar_campanha: precisa de 3+ produtos do dossiê'); return null; }
      if (!(roas >= 1 && roas <= 60) || !(orc >= 5 && orc <= 5000)) { descartes.push('criar_campanha: ROAS/orçamento fora da faixa'); return null; }
      criadas++; ids.forEach(i => usadosItem.add(i));
      return { tipo: 'criar_campanha', item_ids: ids, nome: txt(a.nome, 60) || 'Campanha nova', estrategia: ['PROFITABILITY', 'INCREASE', 'VISIBILITY'].includes(a.estrategia) ? a.estrategia : 'PROFITABILITY', roas_objetivo: Math.round(roas * 10) / 10, orcamento_dia: Math.round(orc * 100) / 100, origens: [...new Set(ids.map(i => itemCamp.get(i)).filter(Boolean))], ...extra };
    }
    descartes.push(`tipo desconhecido ${a.tipo}`);
    return null;
  }
  const planos = [], vistos = new Set();
  for (const p of (Array.isArray(j.planos) ? j.planos : [])) {
    const id = String(p?.campaign_id ?? ''); if (!camp.has(id) || vistos.has(id)) continue; vistos.add(id);
    const acoes = (Array.isArray(p.acoes) ? p.acoes : []).slice(0, 3).map(a => validar(a, id)).filter(Boolean);
    planos.push({ campaign_id: id, campanha: camp.get(id).nome, situacao: acoes.length ? 'mexer' : 'nao_mexer', resumo: txt(p.resumo, 300), reavaliar_em: data(p.reavaliar_em), acoes });
  }
  // campanha que a IA esqueceu: aparece como "não mexer" sem resumo (não some do painel)
  for (const c of dossie.campanhas) if (!vistos.has(String(c.id))) planos.push({ campaign_id: String(c.id), campanha: c.nome, situacao: 'nao_mexer', resumo: null, reavaliar_em: isoMais(hoje, 7), acoes: [] });
  const foraAcoes = (Array.isArray(j.fora_de_campanha) ? j.fora_de_campanha : []).slice(0, 6).map(a => validar(a, null)).filter(Boolean);
  return { planos, fora: foraAcoes, descartes };
}

async function planejar({ Anthropic, anthropicKey, hoje, dossie, candidatos, travas }) {
  if (!anthropicKey || !Anthropic) return null; // sem IA: o agente usa o caminho antigo (revisar)
  const entrada = {
    dossie,
    travas,
    candidatas: candidatos.map(c => ({ id: c.id, titulo: c.titulo, explicacao: String(c.explicacao || '').slice(0, 500), acao: c.dados?.acao, campaign_id: c.dados?.campaign_id ?? null, item_ids: c.dados?.item_ids || null, de: c.dados?.de ?? null, para: c.dados?.para ?? null, impacto_semana_rs: c.dados?.impacto ?? null, tipo_impacto: c.dados?.impacto_tipo || null, grupo: c.dados?.crescimento?.grupo || null })),
  };
  const client = new Anthropic({ apiKey: anthropicKey });
  const pedir = msgs => client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 8000, system: `${SISTEMA_PLANO}\n\n${GUIA}`, messages: msgs });
  const texto = r => (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const ler = t => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  try {
    const msgs = [{ role: 'user', content: JSON.stringify(entrada) }];
    const t1 = texto(await pedir(msgs));
    let j;
    try { j = ler(t1); } catch (e1) {
      j = ler(texto(await pedir([...msgs, { role: 'assistant', content: t1 }, { role: 'user', content: `Esse JSON é inválido (${String(e1.message).slice(0, 120)}). Responda de novo SÓ o JSON válido, com o mesmo conteúdo e sem aspas duplas dentro dos textos.` }])));
    }
    if (!Array.isArray(j?.planos)) return { erro: 'resposta fora do formato' };
    const conferido = conferirPlano(j, { hoje, dossie, candidatos, travas });
    return { ...conferido, estrategia: txt(j.estrategia, 900), esperar: (Array.isArray(j.esperar) ? j.esperar : []).map(x => txt(x, 300)).filter(Boolean).slice(0, 3), fonte: 'planejador' };
  } catch (e) {
    return { erro: String(e.message || e).slice(0, 300) };
  }
}

module.exports = { revisar, planejar, conferirPlano, GUIA };
