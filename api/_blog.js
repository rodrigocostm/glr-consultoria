// ============================================================
// GLR Consultoria — Blog de notícias do varejo digital
// ------------------------------------------------------------
// Todo dia (06:00, agente-cron ?rodada=blog) lê o RSS dos portais do setor e dos
// grandes de economia/política (Exame, g1, Metrópoles, CNN Política/Economia/Money,
// Valor, InfoMoney), escolhe as notícias mais relevantes do varejo digital e do
// ecossistema em volta (juros, consumo, câmbio, impostos, regras) e escreve
// RASCUNHOS com texto próprio da GLR: o que aconteceu, por que importa e o que
// muda para quem vende no Mercado Livre, Shopee, Amazon, TikTok Shop e Magalu —
// sempre com a fonte e o link da matéria original. Não copia frases da matéria
// (no máximo uma citação curta, entre aspas, com o crédito). Nada vai ao ar
// sozinho: a equipe revisa e publica na tela Blog (js/pages-blog.js).
// Posts e fontes usadas: glr_storage 'glr_blog' (só o servidor lê/escreve).
// Página pública: api/blog.js (consultoriaglr.com.br/blog).
// ============================================================

// link: só os itens cujo endereço bate (o feed da CNN traz todas as seções juntas)
const CNN = 'https://www.cnnbrasil.com.br/feed/';
const FONTES = [
  // setor
  { nome: 'Mercado & Consumo', url: 'https://mercadoeconsumo.com.br/feed/' },
  { nome: 'Consumidor Moderno', url: 'https://www.consumidormoderno.com.br/feed/' },
  { nome: 'Ecommerce na Prática', url: 'https://ecommercenapratica.com/feed' },
  { nome: 'ABComm', url: 'https://www.abcomm.org/feed/' },
  { nome: 'Startups', url: 'https://startups.com.br/feed/' },
  { nome: 'Mobile Time', url: 'https://www.mobiletime.com.br/feed/' },
  { nome: 'Meio & Mensagem', url: 'https://www.meioemensagem.com.br/feed' },
  // economia, negócios e política (o ecossistema de quem vende: juros, consumo, impostos, câmbio, regras)
  { nome: 'Exame', url: 'https://exame.com/feed/' },
  { nome: 'g1', url: 'https://g1.globo.com/rss/g1/' },
  { nome: 'g1 Economia', url: 'https://g1.globo.com/rss/g1/economia/' },
  { nome: 'Metrópoles', url: 'https://www.metropoles.com/feed' },
  { nome: 'CNN Política', url: CNN, link: /cnnbrasil\.com\.br\/politica\// },
  { nome: 'CNN Money', url: CNN, link: /cnnbrasil\.com\.br\/economia\/money\// },
  { nome: 'CNN Economia', url: CNN, link: /cnnbrasil\.com\.br\/(economia\/(?!money\/)|agro\/|infra\/)/ },
  { nome: 'Valor Brasil', url: 'https://valor.globo.com/rss/valor/brasil/' },
  { nome: 'Valor Política', url: 'https://valor.globo.com/rss/valor/politica/' },
  { nome: 'Valor Finanças', url: 'https://valor.globo.com/rss/valor/financas/' },
  { nome: 'InfoMoney', url: 'https://www.infomoney.com.br/feed/' },
  { nome: 'InfoMoney Negócios', url: 'https://www.infomoney.com.br/negocios/feed/' },
  { nome: 'Forbes Brasil', url: 'https://forbes.com.br/feed/' },
  { nome: 'Money Times', url: 'https://www.moneytimes.com.br/feed/' },
  { nome: 'Canaltech', url: 'https://canaltech.com.br/rss/' },
  { nome: 'Olhar Digital', url: 'https://olhardigital.com.br/feed/' },
];
// Assunto: varejo digital direto (NUCLEO) ou o ecossistema em volta dele (ECOSSISTEMA):
// juros e crédito, consumo e renda, câmbio e importação, impostos, frete, pagamentos,
// regras do consumidor e de dados, IA e publicidade. Política só entra quando é sobre isso.
const NUCLEO = /mercado livre|shopee|amazon|magalu|magazine luiza|tiktok shop|shein|temu|aliexpress|americanas|casas bahia|marketplace|e-?commerce|com[eé]rcio eletr[oô]nico|loja virtual|varejo (digital|online)|vendas online|social commerce|retail media|m[ií]dia de varejo/i;
const ECOSSISTEMA = /varejo|consumo|consumidor|vendas do com[eé]rcio|com[eé]rcio varejista|lojista|juros|selic|copom|infla[cç][aã]o|ipca|cr[eé]dito|endividamento|inadimpl|renda|emprego|desemprego|sal[aá]rio m[ií]nimo|d[oó]lar|c[aâ]mbio|importa[cç]|taxa das blusinhas|remessa conforme|imposto|tribut|icms|reforma tribut|nota fiscal|frete|log[ií]stica|correios|\bpix\b|pagamento|cart[aã]o de cr[eé]dito|fintech|black friday|vendas de natal|compras de natal|procon|defesa do consumidor|lgpd|anpd|\bpib\b|confian[cç]a do consumidor|intelig[eê]ncia artificial|publicidade|influenciador|big techs?/i;
// …e não é post de oferta/cupom (os portais de tecnologia publicam muitos) nem pauta fora do tema
const FORA = /\boferta|cupom|desconto de|menor pre[cç]o|por apenas|pre[cç]o baixo|vale a pena|review|testamos|melhores .* para comprar|promo[cç](ão|ões) (na|no|de)|em promo[cç]|quando comprar|mais barato|qual pre[cç]o|sele[cç][aã]o de|op[cç][oõ]es em|guia de compras|onde comprar|futebol|campeonato|novela|bbb|celebridade|hor[oó]scopo|loteria|mega-?sena|sat[eé]lite|foguete|kuiper|spacex|starlink|blue origin|\biene\b|bitcoin|cripto|\d+ (modelos|produtos|op[cç][oõ]es) para|para monitorar|campanha .* (fome|doa[cç])|como apoiar/i;
const conta = (t, re) => (String(t || '').match(new RegExp(re.source, 'gi')) || []).length;
// fala do assunto de verdade: o termo no título, ou pelo menos 2 vezes no texto
const doNucleo = n => NUCLEO.test(n.titulo) || conta(n.resumo, NUCLEO) >= 2;
const doEcossistema = n => ECOSSISTEMA.test(n.titulo) || conta(n.resumo, ECOSSISTEMA) >= 3;
const doAssunto = n => doNucleo(n) || doEcossistema(n);
// relevância para quem vende em marketplace (título pesa o dobro da descrição)
const TERMOS = [
  [/mercado livre|shopee|amazon|magalu|magazine luiza|tiktok shop|shein|temu|aliexpress|americanas|casas bahia/i, 5],
  [/marketplace|e-?commerce|com[eé]rcio eletr[oô]nico|loja virtual|varejo digital|vendas online|social commerce/i, 4],
  [/black friday|cyber monday|11\.11|vendas de natal|compras de natal|natal (do|no) (varejo|com[eé]rcio)|dia das m[aã]es|data comemorativa|sazonal/i, 3],
  [/frete|log[ií]stica|entrega|fulfillment|correios|last mile/i, 2],
  [/pix|pagamento|parcelamento|checkout|cart[aã]o/i, 2],
  [/varejo|consumidor|consumo|vendas|seller|vendedor|lojista|an[uú]ncio|publicidade|m[ií]dia de varejo|retail media/i, 1],
  [/tributa|imposto|icms|reforma tribut|nota fiscal/i, 2],
  [/importa[cç]|taxa das blusinhas|remessa conforme|d[oó]lar|c[aâ]mbio/i, 3],
  [/juros|selic|copom|infla[cç][aã]o|ipca|cr[eé]dito|endividamento|inadimpl/i, 2],
  [/renda|emprego|desemprego|sal[aá]rio m[ií]nimo|\bpib\b|confian[cç]a do consumidor/i, 2],
  [/procon|defesa do consumidor|lgpd|anpd|regula[cç]|big techs?/i, 2],
  [/intelig[eê]ncia artificial|publicidade|influenciador|creator/i, 1],
];
// por dia: até 4 rascunhos, no máximo 2 do ecossistema (o resto, varejo digital direto)
const MIN_RELEVANCIA = 6, POR_DIA = 4, MAX_ECOSSISTEMA = 2, JANELA_DIAS = 5;

const limpar = t => String(t || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#8217;|&#8216;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&#8211;|&#8212;/g, '—').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
const tag = (xml, nome) => { const m = xml.match(new RegExp(`<${nome}[^>]*>([\\s\\S]*?)</${nome}>`, 'i')); return m ? m[1] : ''; };
const slugDe = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

async function lerFeed(f, cache = {}) {
  const itens = await (cache[f.url] = cache[f.url] || baixarFeed(f.url));
  return itens.filter(x => !f.link || f.link.test(x.url)).map(x => ({ ...x, fonte: f.nome }));
}
async function baixarFeed(url) {
  const f = { nome: url, url };
  const r = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 (GLR Consultoria blog)' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${f.nome}: HTTP ${r.status}`);
  const xml = await r.text();
  return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).slice(0, 60).map(it => ({
    fonte: f.nome, titulo: limpar(tag(it, 'title')), url: limpar(tag(it, 'link')),
    data: (() => { const d = Date.parse(limpar(tag(it, 'pubDate'))); return isNaN(d) ? null : new Date(d).toISOString(); })(),
    resumo: limpar(tag(it, 'content:encoded') || tag(it, 'description')).slice(0, 2500),
  })).filter(x => x.titulo && /^https?:\/\//.test(x.url));
}
function relevancia(n) {
  let s = 0;
  for (const [re, p] of TERMOS) { if (re.test(n.titulo)) s += p * 2; else if (re.test(n.resumo)) s += p; }
  return s;
}

const SISTEMA = `Você escreve para o blog da GLR Consultoria, que opera lojas de clientes no Mercado Livre, Shopee, Amazon, TikTok Shop e Magalu. Leitor: dono ou gestor de loja online no Brasil. O blog cobre o varejo digital e tudo em volta dele: economia, consumo, crédito, impostos, logística, regulação e tecnologia.
A partir de UMA notícia (título, resumo e link da fonte), escreva um post ORIGINAL em português do Brasil:
- Não copie frases da matéria: reescreva com outras palavras. No máximo UMA citação literal curta (até 15 palavras), entre aspas e creditada à fonte.
- Use só os fatos e números que estão na notícia; não invente dados, datas, valores nem falas. Se a notícia não diz, não afirme.
- Estrutura em markdown: um parágrafo de abertura (o que aconteceu, em 2–3 frases); "## Por que isso importa"; "## O que muda para quem vende em marketplace" (prático, citando os canais quando fizer sentido); "## O que fazer agora" (2 a 4 itens de lista, concretos). 300 a 550 palavras no total.
- Quando a notícia é de economia, política ou regulação (juros, inflação, câmbio, impostos, crédito, regras do consumidor), explique a ligação com quem vende online passo a passo (ex.: juros → crédito e parcelamento → conversão). Se a ligação for indireta, diga que é indireta; não exagere o efeito nem invente números.
- Política: só o fato e o efeito econômico; sem opinião partidária, sem adjetivar governo, partidos ou pessoas.
- Tom: direto, útil, sem sensacionalismo e sem prometer resultado. Não fale mal de concorrentes nem de pessoas.
- No fim, uma linha: "Fonte: [nome da fonte](link)".
Responda SÓ com JSON: {"titulo": "até 90 caracteres, diferente do título da fonte", "resumo": "1 frase de até 160 caracteres para o Google", "corpo": "markdown", "tags": ["até 4 tags curtas"]}`;

async function escrever(anthropicKey, n) {
  const sdk = require('@anthropic-ai/sdk'), Anthropic = sdk.default || sdk;
  const client = require('./_ia-uso').medir(new Anthropic({ apiKey: anthropicKey }), 'blog');
  const r = await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 3000, system: SISTEMA,
    messages: [{ role: 'user', content: JSON.stringify({ fonte: n.fonte, titulo: n.titulo, link: n.url, publicada: n.data, resumo: n.resumo }) }] });
  const txt = r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  if (!j.titulo || !j.corpo) throw new Error('rascunho incompleto');
  return { titulo: String(j.titulo).slice(0, 120), resumo: String(j.resumo || '').slice(0, 200), corpo: String(j.corpo), tags: (Array.isArray(j.tags) ? j.tags : []).map(String).slice(0, 4) };
}

async function lerEstado(lerStorage) { const d = await lerStorage('glr_blog'); return { posts: [], usadas: {}, ...(d || {}) }; }
async function salvarEstado(sbUpsert, est) {
  est.posts = est.posts.slice(-500);
  for (const [u, ts] of Object.entries(est.usadas)) if (Date.now() - ts > 60 * 864e5) delete est.usadas[u];
  await sbUpsert('glr_storage', { chave: 'glr_blog', dados: est, atualizado_em: new Date().toISOString() }, 'chave');
}

// Lê as fontes e escolhe as notícias do dia (sem IA) — também usada para conferir a seleção
async function escolher(est, qtd = POR_DIA) {
  const cache = {};
  const lidas = await Promise.allSettled(FONTES.map(f => lerFeed(f, cache)));
  const erros = lidas.map((r, i) => r.status === 'rejected' ? FONTES[i].nome : null).filter(Boolean);
  const desde = Date.now() - JANELA_DIAS * 864e5;
  const vistas = new Set();
  const candidatas = lidas.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    .filter(n => !vistas.has(n.url) && vistas.add(n.url)) // a mesma matéria em dois feeds (g1 e g1 Economia, Valor e Valor Brasil)
    .filter(n => !est.usadas[n.url] && (!n.data || Date.parse(n.data) >= desde))
    .filter(n => doAssunto(n) && !FORA.test(n.titulo))
    .map(n => ({ ...n, nota: relevancia(n) })).filter(n => n.nota >= MIN_RELEVANCIA)
    .sort((a, b) => b.nota - a.nota || String(b.data).localeCompare(String(a.data)));
  // no máximo 2 por fonte, para variar
  const escolhidas = [], porFonte = {};
  let eco = 0;
  for (const n of candidatas) {
    if (escolhidas.length >= qtd) break;
    if ((porFonte[n.fonte] || 0) >= 2) continue;
    const ehEco = !doNucleo(n); if (ehEco && eco >= MAX_ECOSSISTEMA) continue;
    porFonte[n.fonte] = (porFonte[n.fonte] || 0) + 1; if (ehEco) eco++; escolhidas.push(n);
  }
  return { escolhidas, candidatas, erros };
}

// Gera até `qtd` rascunhos com as notícias mais relevantes que ainda não viraram post
async function gerarRascunhos({ lerStorage, sbUpsert, anthropicKey }, { qtd = POR_DIA } = {}) {
  if (!anthropicKey) throw new Error('IA não configurada no servidor.');
  const est = await lerEstado(lerStorage);
  const { escolhidas, candidatas, erros } = await escolher(est, qtd);
  const criados = [];
  for (const n of escolhidas) {
    est.usadas[n.url] = Date.now();
    try {
      const p = await escrever(anthropicKey, n);
      let slug = slugDe(p.titulo) || `post-${Date.now()}`; while (est.posts.some(x => x.slug === slug)) slug += '-2';
      const post = { id: require('node:crypto').randomUUID(), slug, ...p, status: 'rascunho', criado_em: new Date().toISOString(), fonte: { nome: n.fonte, url: n.url, titulo: n.titulo, publicada: n.data }, relevancia: n.nota };
      // foto de capa própria (IA); se falhar, o post fica com a capa de cor e dá para gerar depois na tela Blog
      try { post.foto = await require('./_blog-foto').gerarFotoPost(post, editoriaDe(post).id); } catch (e) { post.foto_erro = String(e.message || e).slice(0, 160); }
      est.posts.push(post); criados.push(post.titulo);
    } catch (e) { criados.push(`(falhou: ${n.titulo.slice(0, 60)} — ${e.message})`); }
  }
  await salvarEstado(sbUpsert, est);
  return { fontes_lidas: FONTES.length - erros.length, fontes_com_erro: erros, candidatas: candidatas.length, rascunhos: criados };
}

// Markdown simples → HTML (página pública); o texto é escapado antes
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function httpsDe(valor) {
  try {
    const u = new URL(String(valor || ''));
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    return u.href;
  } catch { return ''; }
}
function mdParaHtml(md) {
  const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener nofollow">${t}</a>`).replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const out = [], L = String(md || '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const t = l.match(/^(#{2,4})\s+(.*)$/); if (t) { out.push(`<h${t[1].length}>${inline(t[2])}</h${t[1].length}>`); continue; }
    if (/^\s*([-*]|\d+[.)])\s+/.test(l)) { const num = /^\s*\d/.test(l), itens = []; while (i < L.length && /^\s*([-*]|\d+[.)])\s+/.test(L[i])) itens.push(L[i++].replace(/^\s*([-*]|\d+[.)])\s+/, '')); i--; out.push(`<${num ? 'ol' : 'ul'}>${itens.map(x => `<li>${inline(x)}</li>`).join('')}</${num ? 'ol' : 'ul'}>`); continue; }
    if (/^\s*>\s?/.test(l)) { out.push(`<blockquote>${inline(l.replace(/^\s*>\s?/, ''))}</blockquote>`); continue; }
    if (!l.trim()) continue;
    const par = [l]; while (i + 1 < L.length && L[i + 1].trim() && !/^(#{2,4}\s|\s*([-*]|\d+[.)])\s|\s*>)/.test(L[i + 1])) par.push(L[++i]);
    out.push(`<p>${par.map(inline).join(' ')}</p>`);
  }
  return out.join('\n');
}

// Editorias do blog (cor e assunto): título pesa 3, tags 2, começo do texto 1; empate fica com a primeira
const EDITORIAS = [
  { id: 'marketplaces', nome: 'Marketplaces', cor: '#0B4FE0', re: /mercado livre|shopee|amazon|magalu|magazine luiza|tiktok shop|shein|temu|aliexpress|marketplace|americanas|casas bahia/gi },
  { id: 'pagamentos', nome: 'Pagamentos', cor: '#6236F5', re: /\bpix\b|pagamento|checkout|parcel|cart[aã]o|banco|fintech|cr[eé]dito|carteira digital/gi },
  { id: 'logistica', nome: 'Logística', cor: '#D9480F', re: /frete|log[ií]stica|entrega|fulfillment|correios|armaz[eé]m|estoque/gi },
  { id: 'datas', nome: 'Datas e vendas', cor: '#C2185B', re: /black friday|cyber monday|natal|11\.11|12\.12|dia das (m[aã]es|crian[cç]as|pais)|dia dos namorados|sazonal|halloween/gi },
  { id: 'tecnologia', nome: 'Tecnologia e IA', cor: '#0B7F73', re: /intelig[eê]ncia artificial|\bia\b|tecnologia|big techs?|automa[cç][aã]o|algoritmo|aplicativo/gi },
  { id: 'economia', nome: 'Economia e política', cor: '#1F6F43', re: /juros|selic|copom|infla[cç][aã]o|ipca|d[oó]lar|c[aâ]mbio|\bpib\b|desemprego|renda|governo|congresso|senado|c[aâ]mara|minist[eé]rio|banco central|haddad|importa[cç]|taxa das blusinhas|remessa conforme|regula[cç]/gi },
  { id: 'gestao', nome: 'Gestão', cor: '#334155', re: /lideran[cç]|\bceo\b|executiv|gest[aã]o|tribut|imposto|resultado|balan[cç]o|investimento|reforma/gi },
  { id: 'varejo', nome: 'Varejo e consumo', cor: '#A15C07', re: /varejo|consumidor|consumo|loja|vendas|marca/gi },
];
function editoriaDe(p) {
  const revisada = EDITORIAS.find(e => e.id === p.editoria);
  if (revisada) return revisada; // revisão editorial tem prioridade sobre palavras do texto
  const conta = (t, re) => (String(t || '').match(re) || []).length;
  let melhor = EDITORIAS[EDITORIAS.length - 1], nota = 0;
  for (const e of EDITORIAS) {
    const n = conta(p.titulo, e.re) * 3 + conta((p.tags || []).join(' '), e.re) * 2 + conta(String(p.corpo || '').slice(0, 600), e.re);
    if (n > nota) { nota = n; melhor = e; }
  }
  return melhor;
}

module.exports = { FONTES, EDITORIAS, editoriaDe, gerarRascunhos, escolher, lerEstado, salvarEstado, mdParaHtml, esc, httpsDe, slugDe };
