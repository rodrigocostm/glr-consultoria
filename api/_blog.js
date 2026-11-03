// ============================================================
// GLR Consultoria — Blog de notícias do varejo digital
// ------------------------------------------------------------
// Todo dia (06:00, agente-cron ?rodada=blog) lê o RSS dos portais do setor,
// escolhe as notícias mais relevantes para quem vende em marketplace e escreve
// RASCUNHOS com texto próprio da GLR: o que aconteceu, por que importa e o que
// muda para quem vende no Mercado Livre, Shopee, Amazon, TikTok Shop e Magalu —
// sempre com a fonte e o link da matéria original. Não copia frases da matéria
// (no máximo uma citação curta, entre aspas, com o crédito). Nada vai ao ar
// sozinho: a equipe revisa e publica na tela Blog (js/pages-blog.js).
// Posts e fontes usadas: glr_storage 'glr_blog' (só o servidor lê/escreve).
// Página pública: api/blog.js (consultoriaglr.com.br/blog).
// ============================================================

const FONTES = [
  { nome: 'Mercado & Consumo', url: 'https://mercadoeconsumo.com.br/feed/' },
  { nome: 'Consumidor Moderno', url: 'https://www.consumidormoderno.com.br/feed/' },
  { nome: 'Ecommerce na Prática', url: 'https://ecommercenapratica.com/feed' },
  { nome: 'ABComm', url: 'https://www.abcomm.org/feed/' },
  { nome: 'Startups', url: 'https://startups.com.br/feed/' },
  { nome: 'Mobile Time', url: 'https://www.mobiletime.com.br/feed/' },
  { nome: 'Meio & Mensagem', url: 'https://www.meioemensagem.com.br/feed' },
  { nome: 'InfoMoney Negócios', url: 'https://www.infomoney.com.br/negocios/feed/' },
  // gerais de economia e tecnologia: falam muito de Mercado Livre, Shopee, Amazon e e-commerce
  { nome: 'g1 Economia', url: 'https://g1.globo.com/rss/g1/economia/' },
  { nome: 'Forbes Brasil', url: 'https://forbes.com.br/feed/' },
  { nome: 'Money Times', url: 'https://www.moneytimes.com.br/feed/' },
  { nome: 'Canaltech', url: 'https://canaltech.com.br/rss/' },
  { nome: 'Olhar Digital', url: 'https://olhardigital.com.br/feed/' },
];
// só entra notícia que fala de varejo digital (no título ou no começo do texto)…
const NUCLEO = /mercado livre|shopee|amazon|magalu|magazine luiza|tiktok shop|shein|temu|aliexpress|americanas|casas bahia|marketplace|e-?commerce|com[eé]rcio eletr[oô]nico|loja virtual|varejo (digital|online)|vendas online|social commerce|retail media|m[ií]dia de varejo/i;
// …e não é post de oferta/cupom (os portais de tecnologia publicam muitos)
const FORA = /\boferta|cupom|desconto de|menor pre[cç]o|por apenas|pre[cç]o baixo|vale a pena|review|testamos|melhores .* para comprar|promo[cç](ão|ões) (na|no|de)|em promo[cç]|quando comprar|mais barato|qual pre[cç]o|sele[cç][aã]o de|op[cç][oõ]es em|guia de compras|onde comprar/i;
// fala do assunto de verdade: o termo central no título, ou pelo menos 2 vezes no texto
const doAssunto = n => NUCLEO.test(n.titulo) || (n.resumo.match(new RegExp(NUCLEO.source, 'gi')) || []).length >= 2;
// relevância para quem vende em marketplace (título pesa o dobro da descrição)
const TERMOS = [
  [/mercado livre|shopee|amazon|magalu|magazine luiza|tiktok shop|shein|temu|aliexpress|americanas|casas bahia/i, 5],
  [/marketplace|e-?commerce|com[eé]rcio eletr[oô]nico|loja virtual|varejo digital|vendas online|social commerce/i, 4],
  [/black friday|cyber monday|11\.11|natal|dia das m[aã]es|data comemorativa|sazonal/i, 3],
  [/frete|log[ií]stica|entrega|fulfillment|correios|last mile/i, 2],
  [/pix|pagamento|parcelamento|checkout|cart[aã]o/i, 2],
  [/varejo|consumidor|consumo|vendas|seller|vendedor|lojista|an[uú]ncio|publicidade|m[ií]dia de varejo|retail media/i, 1],
  [/tributa|imposto|icms|reforma tribut|nota fiscal/i, 2],
];
const MIN_RELEVANCIA = 6, POR_DIA = 3, JANELA_DIAS = 5;

const limpar = t => String(t || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#8217;|&#8216;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&#8211;|&#8212;/g, '—').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
const tag = (xml, nome) => { const m = xml.match(new RegExp(`<${nome}[^>]*>([\\s\\S]*?)</${nome}>`, 'i')); return m ? m[1] : ''; };
const slugDe = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

async function lerFeed(f) {
  const r = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 (GLR Consultoria blog)' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${f.nome}: HTTP ${r.status}`);
  const xml = await r.text();
  return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).slice(0, 30).map(it => ({
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

const SISTEMA = `Você escreve para o blog da GLR Consultoria, que opera lojas de clientes no Mercado Livre, Shopee, Amazon, TikTok Shop e Magalu. Leitor: dono ou gestor de loja online no Brasil.
A partir de UMA notícia (título, resumo e link da fonte), escreva um post ORIGINAL em português do Brasil:
- Não copie frases da matéria: reescreva com outras palavras. No máximo UMA citação literal curta (até 15 palavras), entre aspas e creditada à fonte.
- Use só os fatos e números que estão na notícia; não invente dados, datas, valores nem falas. Se a notícia não diz, não afirme.
- Estrutura em markdown: um parágrafo de abertura (o que aconteceu, em 2–3 frases); "## Por que isso importa"; "## O que muda para quem vende em marketplace" (prático, citando os canais quando fizer sentido); "## O que fazer agora" (2 a 4 itens de lista, concretos). 300 a 550 palavras no total.
- Tom: direto, útil, sem sensacionalismo e sem prometer resultado. Não fale mal de concorrentes nem de pessoas.
- No fim, uma linha: "Fonte: [nome da fonte](link)".
Responda SÓ com JSON: {"titulo": "até 90 caracteres, diferente do título da fonte", "resumo": "1 frase de até 160 caracteres para o Google", "corpo": "markdown", "tags": ["até 4 tags curtas"]}`;

async function escrever(anthropicKey, n) {
  const sdk = require('@anthropic-ai/sdk'), Anthropic = sdk.default || sdk;
  const client = new Anthropic({ apiKey: anthropicKey });
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

// Gera até `qtd` rascunhos com as notícias mais relevantes que ainda não viraram post
async function gerarRascunhos({ lerStorage, sbUpsert, anthropicKey }, { qtd = POR_DIA } = {}) {
  if (!anthropicKey) throw new Error('IA não configurada no servidor.');
  const est = await lerEstado(lerStorage);
  const lidas = await Promise.allSettled(FONTES.map(lerFeed));
  const erros = lidas.map((r, i) => r.status === 'rejected' ? FONTES[i].nome : null).filter(Boolean);
  const desde = Date.now() - JANELA_DIAS * 864e5;
  const candidatas = lidas.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    .filter(n => !est.usadas[n.url] && (!n.data || Date.parse(n.data) >= desde))
    .filter(n => doAssunto(n) && !FORA.test(n.titulo))
    .map(n => ({ ...n, nota: relevancia(n) })).filter(n => n.nota >= MIN_RELEVANCIA)
    .sort((a, b) => b.nota - a.nota || String(b.data).localeCompare(String(a.data)));
  // no máximo 2 por fonte, para variar
  const escolhidas = [], porFonte = {};
  for (const n of candidatas) { if (escolhidas.length >= qtd) break; if ((porFonte[n.fonte] || 0) >= 2) continue; porFonte[n.fonte] = (porFonte[n.fonte] || 0) + 1; escolhidas.push(n); }
  const criados = [];
  for (const n of escolhidas) {
    est.usadas[n.url] = Date.now();
    try {
      const p = await escrever(anthropicKey, n);
      let slug = slugDe(p.titulo) || `post-${Date.now()}`; while (est.posts.some(x => x.slug === slug)) slug += '-2';
      const post = { id: require('node:crypto').randomUUID(), slug, ...p, status: 'rascunho', criado_em: new Date().toISOString(), fonte: { nome: n.fonte, url: n.url, titulo: n.titulo, publicada: n.data }, relevancia: n.nota };
      est.posts.push(post); criados.push(post.titulo);
    } catch (e) { criados.push(`(falhou: ${n.titulo.slice(0, 60)} — ${e.message})`); }
  }
  await salvarEstado(sbUpsert, est);
  return { fontes_lidas: FONTES.length - erros.length, fontes_com_erro: erros, candidatas: candidatas.length, rascunhos: criados };
}

// Markdown simples → HTML (página pública); o texto é escapado antes
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

module.exports = { FONTES, gerarRascunhos, lerEstado, salvarEstado, mdParaHtml, esc, slugDe };
