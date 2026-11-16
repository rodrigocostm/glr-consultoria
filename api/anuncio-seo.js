// ============================================================
// GLR Consultoria — SEO do anúncio (Criar anúncio, js/pages-criador-anuncio.js)
// ------------------------------------------------------------
// Escreve título por canal (ML até 60, Shopee até 120, TikTok) e a descrição
// a partir de DADOS REAIS de busca, não só do que a IA imagina:
//  1. o que é o produto: título digitado ou, sem título, a foto (Claude olha);
//  2. categoria do ML (search_categories) → termos em alta (ml_trends) e nomes
//     dos mais vendidos da categoria (ml_highlights + /products) via Tiops;
//  3. sugestões da caixa de busca do ML (autosuggest público) para o termo;
//  4. Claude monta títulos e descrição com essas palavras, sem inventar dado
//     técnico (o que não dá para afirmar volta em "faltam").
// Corpo: { titulo, descricao, marca, extras, foto (data URL, opcional),
//          categoria_ml (opcional), contas: [meliUserId…] }
// acao 'termos' (termos para achar categoria) e 'ficha' (preencher ficha técnica)
// usam prompts fixos daqui — o portal não usa o /api/chat, que leva a base interna.
// Equipe e portal (no portal, a pesquisa só usa as contas do próprio cliente).
// ============================================================
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;
const market = require('./_tiops-market');

const MODELO = 'claude-opus-5-5';
const MODELO_RAPIDO = 'claude-sonnet-5-5'; // termos e ficha: respostas curtas
const corta = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
// corta no limite sem quebrar palavra
const limite = (s, n) => { s = corta(s, 400); if (s.length <= n) return s; const c = s.slice(0, n + 1); const i = c.lastIndexOf(' '); return (i > n * 0.6 ? c.slice(0, i) : s.slice(0, n)).trim(); };

async function sugestoesBusca(q) {
  if (!q) return [];
  try {
    const r = await fetch(`https://http2.mlstatic.com/resources/sites/MLB/autosuggest?showFilters=true&limit=10&api_version=2&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.suggested_queries || []).map(x => x.q).filter(Boolean);
  } catch (e) { return []; }
}

function imagemDe(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null;
}

function jsonDe(txt) {
  const m = String(txt || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('A IA não devolveu o texto no formato esperado.');
  return JSON.parse(m[0]);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const quem = await require('./_auth').requireEquipeOuPortal(req, res); if (!quem) return;
  const apiKey = process.env.ANTHROPIC_API_KEY, mcpKey = process.env.MCP_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'A chave da IA não está configurada no servidor.' });

  try {
    const b = req.body || {};
    let contas = (Array.isArray(b.contas) ? b.contas : []).map(String).slice(0, 6);
    if (quem.role === 'portal') { const minhas = new Set((quem.portal?.contaIds || []).map(String)); contas = contas.filter(c => minhas.has(c)); }
    const img = imagemDe(b.foto);
    const client = new Anthropic({ apiKey });
    const texto = r => r.content.filter(x => x.type === 'text').map(x => x.text).join('\n');

    // termos para achar categoria quando o nome não acha nada
    if (b.acao === 'termos') {
      const r = await client.messages.create({ model: MODELO_RAPIDO, max_tokens: 300, system: 'Devolva APENAS JSON {"termos":["...","...","..."]}: 3 frases curtas (2 a 4 palavras) com o TIPO do produto para achar a categoria num marketplace brasileiro — nunca nome comercial ou marca. Do mais específico ao mais genérico.', messages: [{ role: 'user', content: `Produto: ${corta(b.titulo, 200)}\n${corta(b.descricao, 400)}` }] });
      return res.status(200).json({ termos: (jsonDe(texto(r)).termos || []).map(x => corta(x, 60)).slice(0, 3) });
    }
    // ficha técnica: preenche só o que dá para afirmar
    if (b.acao === 'ficha') {
      const r = await client.messages.create({ model: MODELO_RAPIDO, max_tokens: 2000,
        system: 'Você preenche a ficha técnica de um anúncio de marketplace. Devolva APENAS JSON {"valores": {"<id>": "<valor>"}}. Para campos com opções, use EXATAMENTE o texto de uma das opções. Para número, responda o número com a unidade, ex.: "80 cm" ou "12 kg" (use uma das unidades listadas). Preencha SOMENTE o que dá para afirmar com certeza a partir dos dados do produto; o que não dá, deixe fora do JSON. Nunca invente.',
        messages: [{ role: 'user', content: `PRODUTO\nTítulo: ${corta(b.titulo, 200)}\nMarca: ${corta(b.marca, 60) || '—'}\nDescrição: ${corta(b.descricao, 1500)}\nEmbalagem: ${corta(b.embalagem, 80)}\n\nCAMPOS (id | nome | regras)\n${String(b.campos || '').slice(0, 12000)}` }] });
      const v = jsonDe(texto(r)).valores || {};
      return res.status(200).json({ valores: Object.fromEntries(Object.entries(v).slice(0, 60).map(([k, x]) => [String(k).slice(0, 60), corta(x, 200)])) });
    }
    let termo = corta(b.titulo, 120);

    // 1) sem título: a IA diz o que é o produto pela foto
    if (!termo && img) {
      const r = await client.messages.create({
        model: MODELO, max_tokens: 200,
        messages: [{ role: 'user', content: [img, { type: 'text', text: 'Que produto é este? Responda APENAS com o nome genérico que um comprador digitaria na busca de um marketplace brasileiro (3 a 6 palavras, minúsculas, sem marca). Ex.: "escultura sagrada família resina".' }] }],
      });
      termo = corta(r.content.filter(x => x.type === 'text').map(x => x.text).join(' ').replace(/["'.]/g, ''), 80);
    }
    if (!termo) return res.status(400).json({ error: 'Envie uma foto ou escreva o nome do produto.' });

    // 2) e 3) pesquisa de palavras: categoria, em alta, mais vendidos e sugestões da busca
    const palavras = termo.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const semente = [termo, palavras.slice(0, 3).join(' '), palavras.slice(0, 2).join(' ')].filter((v, i, a) => v && a.indexOf(v) === i);
    let categoria = /^MLB\d+$/.test(String(b.categoria_ml || '')) ? { id: b.categoria_ml, nome: b.categoria_nome || '' } : null;
    if (!categoria && mcpKey) {
      try { const c = await market.pesquisar(mcpKey, 'categorias', { termo }, contas); if (c.categorias?.[0]) categoria = { id: c.categorias[0].id, nome: c.categorias[0].nome }; } catch (e) {}
    }
    const [alta, vend, ...sugs] = await Promise.allSettled([
      categoria && mcpKey ? market.pesquisar(mcpKey, 'em_alta', { categoria: categoria.id }, contas) : Promise.resolve(null),
      categoria && mcpKey ? market.pesquisar(mcpKey, 'mais_vendidos', { categoria: categoria.id }, contas) : Promise.resolve(null),
      ...semente.map(sugestoesBusca),
    ]);
    const emAlta = alta.status === 'fulfilled' && alta.value ? [...(alta.value.buscados || []), ...(alta.value.crescendo || [])].map(x => x.termo).filter(Boolean).slice(0, 30) : [];
    const maisVendidos = vend.status === 'fulfilled' && vend.value ? (vend.value.itens || []).map(x => x.nome).filter(Boolean).slice(0, 12) : [];
    const busca = [...new Set(sugs.flatMap(s => s.status === 'fulfilled' ? s.value : []))].slice(0, 25);

    // 4) a IA escreve com os dados
    const system = `Você é especialista em SEO de anúncios para Mercado Livre, Shopee e TikTok Shop no Brasil. Escreve títulos e descrições que aparecem na busca e convertem.
REGRAS DE TÍTULO
- Comece pelo termo que o comprador digita (tipo do produto), depois os atributos que mais aparecem nas buscas reais fornecidas: material, cor, medida, quantidade, estilo, uso/ambiente, público.
- Mercado Livre: até 60 caracteres, sem repetir palavras, sem preposições desnecessárias, sem palavras promocionais (promoção, oferta, frete grátis, barato, melhor, top), sem símbolos, sem CAIXA ALTA. Marca só se for conhecida e informada.
- Shopee: até 120 caracteres, pode trazer mais termos de busca e sinônimos (ex.: "imagem", "estátua", "enfeite"), ainda legível, sem repetir a mesma palavra mais de 2 vezes.
- TikTok Shop: 60 a 100 caracteres, natural e atrativo, com o termo principal no começo.
- Use primeira letra maiúscula nas palavras principais.
REGRAS DE DESCRIÇÃO (texto puro, sem HTML, sem markdown, sem emoji, sem links, telefone ou e-mail)
- 1º parágrafo (2 a 3 frases): o termo principal e 2 ou 3 secundários de forma natural, para quem é e onde usar.
- "Características:" com 5 a 8 linhas começando por "- ".
- "Especificações:" com material, cor, medidas e peso SOMENTE se informados ou claramente visíveis; não invente números.
- "Ideal para:" ocasiões e ambientes (presente, decoração, datas comemorativas) quando fizer sentido.
- "O que vem na embalagem:" só se informado; senão, omita a seção.
- "Cuidados:" quando fizer sentido para o material.
- Termine com 3 perguntas e respostas curtas ("Perguntas frequentes:"), usando só o que foi informado.
- Use as palavras-chave das buscas reais ao longo do texto, sem lista solta de palavras (o marketplace pune "keyword stuffing").
NUNCA invente medida, material, certificação, garantia ou quantidade. Se a foto sugere algo mas não é certo, não afirme. O que faltar para completar o anúncio, liste em "faltam".
Responda APENAS com JSON: {"palavra_principal":"...","palavras_chave":["..."],"titulos":{"ml":"...","shopee":"...","tiktok":"..."},"descricao":"...","faltam":["..."]}`;
    const dadosTxt = [
      `PRODUTO (dados do vendedor)`,
      `Nome/título atual: ${corta(b.titulo, 200) || '(vazio — veja a foto)'}`,
      `Marca: ${corta(b.marca, 60) || '(não informada)'}`,
      b.extras ? `Outros dados: ${corta(b.extras, 800)}` : '',
      `Descrição atual: ${corta(b.descricao, 2500) || '(vazia)'}`,
      '',
      `PESQUISA REAL DE BUSCA (Mercado Livre)`,
      categoria ? `Categoria: ${categoria.nome} (${categoria.id})` : 'Categoria: não identificada',
      busca.length ? `Sugestões da caixa de busca para "${termo}": ${busca.join(' | ')}` : 'Sugestões da busca: sem dados',
      emAlta.length ? `Termos em alta na categoria: ${emAlta.join(' | ')}` : 'Termos em alta: sem dados',
      maisVendidos.length ? `Nomes dos mais vendidos da categoria: ${maisVendidos.join(' | ')}` : 'Mais vendidos: sem dados',
    ].filter(x => x !== '').join('\n');
    const r = await client.messages.create({
      model: MODELO, max_tokens: 4000, system,
      messages: [{ role: 'user', content: [...(img ? [img] : []), { type: 'text', text: dadosTxt }] }],
    });
    const out = jsonDe(r.content.filter(x => x.type === 'text').map(x => x.text).join('\n'));
    const t = out.titulos || {};
    return res.status(200).json({
      palavra_principal: corta(out.palavra_principal, 80),
      palavras_chave: (out.palavras_chave || []).map(x => corta(x, 60)).filter(Boolean).slice(0, 20),
      titulos: { ml: limite(t.ml, 60), shopee: limite(t.shopee, 120), tiktok: limite(t.tiktok, 255) },
      descricao: String(out.descricao || '').replace(/\r/g, '').trim().slice(0, 5000),
      faltam: (out.faltam || []).map(x => corta(x, 120)).filter(Boolean).slice(0, 8),
      fontes: { categoria, busca: busca.length, em_alta: emAlta.length, mais_vendidos: maisVendidos.length },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
