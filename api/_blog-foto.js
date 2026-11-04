// ============================================================
// GLR Consultoria — Foto de capa dos posts do blog
// ------------------------------------------------------------
// Gera uma foto editorial PRÓPRIA para cada notícia com a IA de imagem do
// Gemini (a mesma do Gerador de Fotos) — nunca usa foto de outro veículo.
// A cena vem do assunto do post (cenaDoPost, IA de texto), não só da editoria.
// A cena é genérica: sem texto, logotipo, marca, produto ou personagem real e
// sem pessoa identificável. Comprime para WebP (1200 px) e guarda no Supabase
// Storage, no bucket público "blog" (criado na primeira vez). O post ganha
// p.foto = { url, gerada_em }; sem foto, a página continua com a capa de cor.
// Usado por api/_blog.js (rascunho novo) e api/blog.js (gerar/trocar/em lote).
// ============================================================
const SUPA = 'https://rrodqlejqyaoomutriiw.supabase.co';
const BUCKET = 'blog';
const MODELO = 'gemini-3.1-flash-image';

// Cena por editoria: dá o "mundo" da foto sem depender de marca nenhuma
const CENAS = {
  marketplaces: 'um centro de distribuição ou a bancada de um pequeno lojista online com caixas de papelão, etiquetas de envio e um notebook',
  pagamentos: 'um pagamento por aproximação com celular numa maquininha genérica, cartões e notas sobre uma mesa',
  logistica: 'um galpão logístico com esteiras, prateleiras e pacotes, ou uma van de entregas numa rua brasileira',
  datas: 'pacotes de presente, sacolas e caixas de entrega com iluminação de vitrine',
  tecnologia: 'mãos usando um notebook e um celular com gráficos abstratos, numa mesa de trabalho moderna',
  gestao: 'uma mesa de reunião com planilhas impressas, calculadora, notebook e café',
  varejo: 'o corredor de uma loja ou um balcão de varejo com produtos genéricos sem rótulo',
};

// A cena sai do ASSUNTO do post: a IA de texto lê título, resumo e o começo do texto e
// descreve uma foto que mostra aquele tema de forma concreta (o que um editor de fotos
// escolheria). Sem ela (falha da IA), cai na cena genérica da editoria.
const SISTEMA_CENA = `Você é editor de fotografia de um portal de notícias brasileiro sobre varejo digital. Para a notícia recebida, descreva em 2 a 3 frases, em português, UMA foto realista que mostre o tema CENTRAL da notícia de forma concreta e reconhecível à primeira vista — o fato específico, não um clichê genérico de e-commerce (evite caixas de papelão e notebook, a não ser que a notícia seja sobre isso). Exemplos: notícia sobre lives de vendas → uma criadora de conteúdo apresentando produtos para o celular num tripé com ring light; investimento bilionário em IA → corredor de data center com racks de servidores iluminados; troca de liderança em empresa → sala de reunião executiva com pessoas de terno de costas; imposto sobre tráfego de dados → cabos de fibra óptica e equipamentos de rede; lançamento de videogame → mãos segurando um controle genérico diante de uma TV com luz colorida desfocada.
Regras: nada de texto, letras, números, logotipos ou marcas; nenhum produto, embalagem, console, personagem, loja, uniforme ou fachada de marca real (descreva versões genéricas); telas sem conteúdo legível; pessoas apenas de costas, desfocadas ou só mãos, nunca rosto identificável nem pessoa famosa; nada que possa ser ofensivo. Responda só com a descrição da cena, sem aspas nem introdução.`;
async function cenaDoPost(p) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  try {
    const sdk = require('@anthropic-ai/sdk'), Anthropic = sdk.default || sdk;
    const r = await new Anthropic({ apiKey: key }).messages.create({ model: 'claude-sonnet-5-5', max_tokens: 300, system: SISTEMA_CENA,
      messages: [{ role: 'user', content: JSON.stringify({ titulo: p.titulo, resumo: p.resumo, tags: p.tags, inicio_do_texto: String(p.corpo || '').slice(0, 1500) }) }] });
    const t = r.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    return t ? t.slice(0, 600) : null;
  } catch (e) { return null; }
}

function prompt(p, editoriaId, cena) {
  const cenaFinal = cena || `${CENAS[editoriaId] || CENAS.marketplaces} — adapte ao assunto de forma simbólica.`;
  return [
    'Fotografia editorial realista, horizontal 16:9, para ilustrar uma notícia de um portal brasileiro sobre varejo digital e marketplaces.',
    `Cena: ${cenaFinal}`,
    `A foto precisa deixar claro o assunto da notícia: "${String(p.titulo).slice(0, 140)}".`,
    'Estilo: foto de banco de imagens de alta qualidade, luz natural, profundidade de campo rasa, cores sóbrias, composição limpa.',
    'Regras obrigatórias: NENHUM texto, letra, número, logotipo ou marca visível; não reproduza produtos, embalagens, consoles, personagens ou lojas de marcas reais; telas sem conteúdo legível; pessoas só de costas, desfocadas ou só as mãos — nunca rostos identificáveis nem pessoas famosas.',
  ].join(' ');
}

async function gerarImagem(texto) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada no servidor.');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: texto }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } } }),
    signal: AbortSignal.timeout(90000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error?.message || `Gemini HTTP ${r.status}`);
  const part = (json.candidates?.[0]?.content?.parts || []).find(x => x.inlineData || x.inline_data);
  const inline = part?.inlineData || part?.inline_data;
  if (!inline?.data) throw new Error(`Gemini não devolveu imagem (${json.candidates?.[0]?.finishReason || 'sem imagem'}).`);
  return Buffer.from(inline.data, 'base64');
}

async function storage(path, init = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(`${SUPA}/storage/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) });
}
let bucketOk = false;
async function garantirBucket() {
  if (bucketOk) return;
  const r = await storage(`bucket/${BUCKET}`);
  if (!r.ok) {
    const c = await storage('bucket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 5 * 1024 * 1024, allowed_mime_types: ['image/webp', 'image/png', 'image/jpeg'] }) });
    if (!c.ok && c.status !== 409) throw new Error(`Não consegui criar o bucket de fotos (HTTP ${c.status}).`);
  }
  bucketOk = true;
}

// Gera, comprime e guarda a foto; devolve { url, gerada_em, kb }
async function gerarFotoPost(p, editoriaId) {
  const cena = await cenaDoPost(p);
  const png = await gerarImagem(prompt(p, editoriaId, cena));
  const sharp = require('sharp');
  const webp = await sharp(png).resize({ width: 1200, height: 675, fit: 'cover' }).webp({ quality: 74 }).toBuffer();
  await garantirBucket();
  const caminho = `capas/${String(p.id || p.slug).replace(/[^a-zA-Z0-9-]/g, '')}-${Date.now()}.webp`;
  const up = await storage(`object/${BUCKET}/${caminho}`, { method: 'POST', headers: { 'Content-Type': 'image/webp', 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000' }, body: webp });
  if (!up.ok) throw new Error(`Não consegui guardar a foto (HTTP ${up.status}).`);
  return { url: `${SUPA}/storage/v1/object/public/${BUCKET}/${caminho}`, gerada_em: new Date().toISOString(), kb: Math.round(webp.length / 1024), cena: cena || null, versao: 2 };
}

module.exports = { gerarFotoPost, prompt };
