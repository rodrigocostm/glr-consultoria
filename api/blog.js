// ============================================================
// GLR Consultoria — Blog (consultoriaglr.com.br/blog)
// ------------------------------------------------------------
// GET público (vercel.json reescreve /blog, /blog/editoria/<id> e /blog/<slug>
// para cá): portal de notícias do varejo digital — destaque, grade por
// editoria, página de cada post com capa gerada na cor da editoria (sem foto de
// terceiros), compartilhar e "leia também". HTML pronto para o Google (título,
// descrição, canônico, Open Graph, dados estruturados). Só posts PUBLICADOS.
// ?formato=json: os últimos publicados para a landing (landing.html).
// POST da equipe (requireStaff): listar, salvar, publicar, despublicar, descartar
// e gerar rascunhos agora (api/_blog.js). Posts em glr_storage 'glr_blog'.
// ============================================================
const blog = require('./_blog');
const { requireStaff } = require('./_auth');
const BASE = 'https://rrodqlejqyaoomutriiw.supabase.co/rest/v1';
const SITE = 'https://consultoriaglr.com.br';
const WHATS = 'https://wa.me/5517992117263?text=' + encodeURIComponent('Olá! Vim pelo blog da GLR e quero conversar sobre a minha loja.');

async function sb(path, init = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${BASE}/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Banco indisponível (HTTP ${r.status})`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const lerStorage = async chave => (await sb(`glr_storage?chave=eq.${chave}&select=dados`))?.[0]?.dados || null;
const sbUpsert = (table, row, conflito) => sb(`${table}?on_conflict=${conflito}`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });

const { esc } = blog;
const dataBR = iso => iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Sao_Paulo' }).replace('.', '') : '';
const minutos = p => Math.max(1, Math.round(String(p.corpo || '').split(/\s+/).length / 200));
const ed = p => blog.editoriaDe(p);
// capa: foto própria gerada por IA (api/_blog-foto.js) com a editoria por cima; sem foto,
// a capa de cor da editoria com o assunto em letra grande (nunca foto de outro veículo)
const capa = (p, tam) => {
  const e = ed(p);
  if (p.foto?.url) return `<div class="capa capa-${tam} com-foto" style="--c:${e.cor}" aria-hidden="true"><img src="${esc(p.foto.url)}" alt="" width="1200" height="675" ${tam === 'x' || tam === 'g' ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"><span class="capa-ed">${esc(e.nome)}</span></div>`;
  const k = (p.tags?.[0] || e.nome).toLowerCase(); return `<div class="capa capa-${tam}${k.length > 11 ? ' longo' : ''}" style="--c:${e.cor}" aria-hidden="true"><span class="capa-ed">${esc(e.nome)}</span><span class="capa-k">${esc(k)}</span></div>`;
};
// dentro de um card (que já é link) a editoria vai como texto: link dentro de link quebra o card
const etiqueta = (p, link) => { const e = ed(p); return link ? `<a class="ed-tag" style="--c:${e.cor}" href="/blog/editoria/${e.id}">${esc(e.nome)}</a>` : `<span class="ed-tag" style="--c:${e.cor}">${esc(e.nome)}</span>`; };

const CSS = `
:root{--noite:#0A1633;--azul:#0B4FE0;--azul2:#083BAA;--ceu:#E9EFFE;--nevoa:#F4F6FA;--tinta:#0D1322;--sec:#4B5468;--mute:#8A91A3;--linha:#E3E7EF;--papel:#fff}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font-family:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--tinta);background:var(--papel);line-height:1.6;font-size:16px}
a{color:inherit}img{max-width:100%}
.wrap{max-width:1200px;margin:0 auto;padding:0 20px}
.d{font-family:"Bricolage Grotesque","Instrument Sans",system-ui,sans-serif;letter-spacing:-.02em}
.mono{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace}
:focus-visible{outline:2px solid var(--azul);outline-offset:2px}
.topo{background:var(--noite);color:#fff}
.topo .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;height:68px}
.marca{display:flex;align-items:center;gap:10px;text-decoration:none;color:#fff}.marca img{display:block;height:28px;width:auto}
.marca b{font-family:"Bricolage Grotesque",sans-serif;font-size:19px;letter-spacing:-.02em}.marca span{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#9fb3e8;font-family:"JetBrains Mono",monospace}
.topo nav{display:flex;align-items:center;gap:20px;font-size:14px}.topo nav a{text-decoration:none;color:#c9d3ea}.topo nav a:hover{color:#fff}
.bt{display:inline-flex;align-items:center;gap:8px;background:var(--azul);color:#fff !important;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:10px;border:0;cursor:pointer;font-family:inherit}.bt:hover{background:var(--azul2)}
.cel{display:none}.bt-luz{background:#fff;color:var(--noite) !important}.bt-luz:hover{background:var(--ceu)}
.editorias{border-bottom:1px solid var(--linha);background:#fff;position:sticky;top:0;z-index:5}
.editorias .wrap{display:flex;gap:22px;overflow-x:auto;scrollbar-width:none;height:48px;align-items:center}.editorias .wrap::-webkit-scrollbar{display:none}
.editorias a{white-space:nowrap;text-decoration:none;font-size:14px;font-weight:600;color:var(--c);padding:13px 0;border-bottom:2px solid transparent}.editorias a.on,.editorias a:hover{border-bottom-color:var(--c)}
.editorias a.todas{color:var(--tinta)}
.capa{position:relative;overflow:hidden;background:var(--c);color:#fff;border-radius:12px;display:flex;flex-direction:column;justify-content:space-between;padding:16px 18px;isolation:isolate}
.capa::before{content:"";position:absolute;inset:0;z-index:-1;background:repeating-linear-gradient(135deg,rgba(255,255,255,.09) 0 2px,transparent 2px 14px),radial-gradient(120% 90% at 100% 0%,rgba(255,255,255,.28),transparent 55%)}
.capa-ed{font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.9}
.capa-k{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;line-height:.92;letter-spacing:-.04em;hyphens:auto;overflow-wrap:break-word}
.capa.longo .capa-k{font-size-adjust:none;transform-origin:left bottom}
.capa-g{aspect-ratio:16/10}.capa-g .capa-k{font-size:clamp(44px,7vw,92px)}
.capa-m{aspect-ratio:16/10}.capa-m .capa-k{font-size:clamp(28px,3.2vw,42px)}
.capa-p{aspect-ratio:1/1;border-radius:10px;padding:10px}.capa-p .capa-k{font-size:20px}.capa-p .capa-ed{font-size:9px}
.capa-x{aspect-ratio:21/8;border-radius:16px}.capa-x .capa-k{font-size:clamp(46px,8vw,104px)}
.capa.com-foto{padding:14px 16px;justify-content:flex-start;background:#0A1633}.capa.com-foto::before{display:none}.capa.com-foto img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2;transition:transform .5s ease}.capa.com-foto::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(10,22,51,.55),rgba(10,22,51,0) 45%)}.capa.com-foto .capa-ed{align-self:flex-start;background:var(--c);padding:4px 8px;border-radius:6px;opacity:1}.capa-p.com-foto{padding:6px}.capa-p.com-foto .capa-ed{font-size:8px;padding:3px 5px}.capa-x.com-foto{aspect-ratio:16/9}a:hover .capa.com-foto img{transform:scale(1.03)}@media (prefers-reduced-motion:reduce){.capa.com-foto img{transition:none}}
.capa-g.longo .capa-k{font-size:clamp(34px,4.6vw,60px)}.capa-m.longo .capa-k{font-size:clamp(20px,2vw,26px)}.capa-p.longo .capa-k{font-size:14px}.capa-x.longo .capa-k{font-size:clamp(34px,5.4vw,68px)}
.ed-tag{display:inline-block;text-decoration:none;font-family:"JetBrains Mono",monospace;font-size:11.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--c)}
.meta{font-size:13px;color:var(--mute)}
.destaque{display:grid;grid-template-columns:1.35fr 1fr;gap:28px;padding:30px 0 34px;border-bottom:1px solid var(--linha)}
.dest-princ{text-decoration:none;display:flex;flex-direction:column;gap:12px}.dest-princ h1{font-size:clamp(28px,3.4vw,42px);line-height:1.08;margin:0;text-wrap:balance}.dest-princ p{margin:0;color:var(--sec);font-size:17px}
.dest-princ:hover h1{color:var(--azul)}
.dest-lado{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.mini{text-decoration:none;display:flex;flex-direction:column;gap:8px}.mini h3{font-size:16.5px;line-height:1.3;margin:0;font-weight:700;letter-spacing:-.01em}.mini:hover h3{color:var(--azul)}
.corpo-home{display:grid;grid-template-columns:1fr 320px;gap:40px;padding:34px 0 60px}
.sec-t{display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:2px solid var(--tinta);padding-bottom:8px;margin-bottom:6px}.sec-t h2{font-size:22px;margin:0}
.lista-item{display:grid;grid-template-columns:150px 1fr;gap:18px;padding:20px 0;border-bottom:1px solid var(--linha);text-decoration:none}
.lista-item h3{font-size:19px;line-height:1.25;margin:4px 0 6px}.lista-item p{margin:0 0 6px;color:var(--sec);font-size:14.5px}.lista-item:hover h3{color:var(--azul)}
.lado{display:flex;flex-direction:column;gap:22px}
.box-cta{background:var(--noite);color:#fff;border-radius:16px;padding:22px}.box-cta b{font-family:"Bricolage Grotesque",sans-serif;font-size:21px;line-height:1.15;display:block;margin-bottom:8px;letter-spacing:-.02em}.box-cta p{color:#b9c6e6;font-size:14px;margin:0 0 16px}
.box{border:1px solid var(--linha);border-radius:16px;padding:18px}.box h4{margin:0 0 10px;font-size:13px;font-family:"JetBrains Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);font-weight:500}
.box a.ed-link{display:flex;justify-content:space-between;text-decoration:none;padding:8px 0;border-top:1px solid var(--linha);font-weight:600;font-size:14.5px}.box a.ed-link:first-of-type{border-top:0}.box a.ed-link i{font-style:normal;color:var(--mute);font-weight:500}
.vazio{padding:70px 20px;text-align:center;color:var(--sec)}.vazio b{display:block;font-family:"Bricolage Grotesque",sans-serif;font-size:24px;color:var(--tinta);margin-bottom:6px}
.cab-ed{padding:30px 0 6px}.cab-ed h1{font-size:clamp(30px,4vw,46px);margin:6px 0 0;color:var(--c)}
article.post{max-width:760px;margin:0 auto;padding:30px 20px 10px}
article.post h1{font-size:clamp(30px,4.4vw,48px);line-height:1.06;margin:12px 0 14px;text-wrap:balance}
.lead{font-size:19px;color:var(--sec);margin:0 0 16px;line-height:1.5}
.assina{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:13.5px;color:var(--mute);padding:14px 0;border-top:1px solid var(--linha);border-bottom:1px solid var(--linha);margin-bottom:24px}
.assina b{color:var(--tinta)}.assina a{color:var(--azul)}
.texto{font-size:18px;line-height:1.72}.texto h2{font-family:"Bricolage Grotesque",sans-serif;font-size:25px;letter-spacing:-.02em;line-height:1.2;margin:36px 0 10px}.texto h3{font-size:20px;margin:28px 0 8px}
.texto p{margin:0 0 18px}.texto ul,.texto ol{padding-left:24px;margin:0 0 18px}.texto li{margin:6px 0}.texto a{color:var(--azul)}
.texto blockquote{margin:0 0 18px;padding:12px 18px;border-left:3px solid var(--azul);background:var(--nevoa);color:var(--sec)}
.fonte{font-size:14px;color:var(--sec);background:var(--nevoa);border-radius:12px;padding:14px 16px;margin:28px 0}
.compart{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--mute);margin:0 0 30px}
.compart a,.compart button{border:1px solid var(--linha);background:#fff;border-radius:99px;padding:7px 14px;font:inherit;font-size:13px;font-weight:600;color:var(--tinta);text-decoration:none;cursor:pointer}.compart a:hover,.compart button:hover{border-color:var(--azul);color:var(--azul)}
.cta-post{max-width:760px;margin:0 auto 40px;padding:0 20px}.cta-post .box-cta{display:flex;gap:18px;align-items:center;justify-content:space-between;flex-wrap:wrap}.cta-post .box-cta p{margin:0}
.relac{background:var(--nevoa);padding:34px 0 50px}.relac h2{font-size:22px;margin:0 0 16px}.relac-g{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.rodape{background:var(--noite);color:#9fb0d6;font-size:13.5px;padding:34px 0}.rodape .wrap{display:flex;gap:20px;justify-content:space-between;flex-wrap:wrap}.rodape a{color:#dfe6f7}.rodape p{max-width:560px;margin:6px 0 0}
@media(max-width:960px){.destaque,.corpo-home{grid-template-columns:1fr}.lado{order:2}.relac-g{grid-template-columns:1fr 1fr}}
@media(max-width:640px){.topo nav a.l,.topo .bt .l{display:none}.topo .bt .cel{display:inline}.dest-lado{grid-template-columns:1fr}.lista-item{grid-template-columns:96px 1fr;gap:14px}.lista-item h3{font-size:17px}.lista-item p{display:none}.relac-g{grid-template-columns:1fr}.texto{font-size:17px}}
@media(prefers-reduced-motion:reduce){*{transition:none !important}}`;

function pagina({ titulo, descricao, url, corpo, jsonld, editoriaAtual, imagem }) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><meta name="description" content="${esc(descricao)}"><link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${jsonld ? 'article' : 'website'}"><meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(descricao)}"><meta property="og:url" content="${esc(url)}"><meta property="og:site_name" content="GLR Notícias">${imagem ? `<meta property="og:image" content="${esc(imagem)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="675"><meta name="twitter:card" content="summary_large_image">` : ''}<meta property="og:locale" content="pt_BR">
<meta name="theme-color" content="#0A1633"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/img/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/img/apple-touch-icon.png"><link rel="alternate" type="application/rss+xml" title="GLR Notícias" href="/blog?formato=rss">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
<style>${CSS}</style></head><body>
<header class="topo"><div class="wrap"><a class="marca" href="/blog"><img src="/img/logo-glr-branco.png" alt="GLR" width="56" height="28"><span>Notícias</span></a>
<nav><a class="l" href="/landing.html">A consultoria</a><a class="l" href="/calculadora.html">Calculadora de taxas</a><a class="bt" href="${WHATS}" target="_blank" rel="noopener"><span class="l">Falar com um especialista</span><span class="cel">WhatsApp</span></a></nav></div></header>
<nav class="editorias" aria-label="Editorias"><div class="wrap"><a class="todas ${!editoriaAtual ? 'on' : ''}" style="--c:var(--tinta)" href="/blog">Últimas</a>${blog.EDITORIAS.map(e => `<a class="${editoriaAtual === e.id ? 'on' : ''}" style="--c:${e.cor}" href="/blog/editoria/${e.id}">${esc(e.nome)}</a>`).join('')}</div></nav>
<main>${corpo}</main>
<footer class="rodape"><div class="wrap"><div><b style="color:#fff;font-family:'Bricolage Grotesque',sans-serif;font-size:18px">GLR Notícias</b><p>O que acontece no Mercado Livre, Shopee, Amazon, TikTok Shop, Magalu e no e-commerce brasileiro, explicado para quem vende. Os textos são da equipe GLR e sempre trazem o link da matéria original.</p></div>
<div><a href="/landing.html">Conheça a GLR Consultoria</a><br><a href="${WHATS}" target="_blank" rel="noopener">WhatsApp</a><br>© ${new Date().getFullYear()} GLR Consultoria</div></div></footer>
</body></html>`;
}

const boxLado = (pub) => {
  const n = id => pub.filter(p => ed(p).id === id).length;
  return `<aside class="lado">
  <div class="box-cta"><b>Sua loja vendendo mais no Mercado Livre e na Shopee</b><p>A GLR cuida de ADS, anúncios, preço, estoque e reputação — com agentes trabalhando todo dia e um gestor dedicado.</p><a class="bt bt-luz" href="/landing.html">Conhecer a GLR</a></div>
  <div class="box"><h4>Editorias</h4>${blog.EDITORIAS.filter(e => n(e.id)).map(e => `<a class="ed-link" href="/blog/editoria/${e.id}" style="color:${e.cor}">${esc(e.nome)} <i>${n(e.id)}</i></a>`).join('') || '<span class="meta">As editorias aparecem com os primeiros posts.</span>'}</div>
</aside>`;
};
const itemLista = p => `<a class="lista-item" href="/blog/${esc(p.slug)}">${capa(p, 'p')}<div>${etiqueta(p)}<h3 class="d">${esc(p.titulo)}</h3><p>${esc(p.resumo)}</p><span class="meta">${dataBR(p.publicado_em)} · ${minutos(p)} min de leitura</span></div></a>`;

function htmlHome(pub, aviso) {
  const [d, ...resto] = pub, lado = resto.slice(0, 4), mais = resto.slice(4);
  const corpo = !pub.length ? `<div class="wrap"><div class="vazio"><b>As primeiras notícias estão chegando</b>A equipe GLR está preparando os primeiros textos sobre o varejo digital.</div></div>` : `
<div class="wrap">${aviso ? `<div class="vazio" style="padding:24px 0 0">${esc(aviso)}</div>` : ''}
  <section class="destaque">
    <a class="dest-princ" href="/blog/${esc(d.slug)}">${capa(d, 'g')}<span>${etiqueta(d)}</span><h1 class="d">${esc(d.titulo)}</h1><p>${esc(d.resumo)}</p><span class="meta">${dataBR(d.publicado_em)} · ${minutos(d)} min de leitura</span></a>
    <div class="dest-lado">${lado.map(p => `<a class="mini" href="/blog/${esc(p.slug)}">${capa(p, 'm')}${etiqueta(p)}<h3 class="d">${esc(p.titulo)}</h3><span class="meta">${dataBR(p.publicado_em)}</span></a>`).join('')}</div>
  </section>
  <div class="corpo-home"><section><div class="sec-t"><h2 class="d">Mais notícias</h2><span class="meta">${pub.length} publicada(s)</span></div>${mais.length ? mais.map(itemLista).join('') : '<p class="meta" style="padding:16px 0">As próximas notícias aparecem aqui.</p>'}</section>${boxLado(pub)}</div>
</div>`;
  return pagina({ titulo: 'GLR Notícias — o varejo digital explicado para quem vende', descricao: 'Notícias do Mercado Livre, Shopee, Amazon e do e-commerce brasileiro, com o que muda para quem vende em marketplace.', url: `${SITE}/blog`, corpo });
}
function htmlEditoria(e, pub) {
  const lista = pub.filter(p => ed(p).id === e.id);
  return pagina({ titulo: `${e.nome} — GLR Notícias`, descricao: `Notícias de ${e.nome.toLowerCase()} no varejo digital, explicadas para quem vende em marketplace.`, url: `${SITE}/blog/editoria/${e.id}`, editoriaAtual: e.id,
    corpo: `<div class="wrap"><div class="cab-ed" style="--c:${e.cor}"><span class="ed-tag" style="--c:${e.cor}">Editoria</span><h1 class="d">${esc(e.nome)}</h1></div>
<div class="corpo-home"><section>${lista.length ? lista.map(itemLista).join('') : '<div class="vazio"><b>Nada por aqui ainda</b>As notícias desta editoria aparecem assim que forem publicadas.</div>'}</section>${boxLado(pub)}</div></div>` });
}
function htmlPost(p, pub) {
  const url = `${SITE}/blog/${p.slug}`, e = ed(p);
  const relac = pub.filter(x => x.id !== p.id).sort((a, b) => (ed(b).id === e.id) - (ed(a).id === e.id)).slice(0, 3);
  const txt = encodeURIComponent(`${p.titulo} — ${url}`);
  return pagina({ titulo: `${p.titulo} | GLR Notícias`, descricao: p.resumo || p.titulo, url, editoriaAtual: e.id, imagem: p.foto?.url || null,
    jsonld: { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: p.titulo, description: p.resumo, ...(p.foto?.url ? { image: [p.foto.url] } : {}), articleSection: e.nome, datePublished: p.publicado_em, dateModified: p.atualizado_em || p.publicado_em, mainEntityOfPage: url, author: { '@type': 'Organization', name: 'Equipe GLR Consultoria' }, publisher: { '@type': 'Organization', name: 'GLR Consultoria', logo: { '@type': 'ImageObject', url: `${SITE}/logo.png` } }, isBasedOn: p.fonte?.url },
    corpo: `<article class="post">${etiqueta(p, true)}<h1 class="d">${esc(p.titulo)}</h1><p class="lead">${esc(p.resumo)}</p>
<div class="assina"><span>Por <b>Equipe GLR</b></span><span>${dataBR(p.publicado_em)}</span><span>${minutos(p)} min de leitura</span><span>Com informações de <a href="${esc(p.fonte?.url)}" target="_blank" rel="noopener nofollow">${esc(p.fonte?.nome)}</a></span></div>
${capa(p, 'x')}
<div class="texto" style="margin-top:28px">${blog.mdParaHtml(String(p.corpo || '').replace(/\n+Fonte:.*$/i, ''))}</div>
<div class="fonte">Fonte original: <a href="${esc(p.fonte?.url)}" target="_blank" rel="noopener nofollow">${esc(p.fonte?.titulo || p.fonte?.nome)}</a> (${esc(p.fonte?.nome)}). Este texto resume e comenta a notícia; os detalhes completos estão na matéria original.</div>
<div class="compart"><span>Compartilhar:</span><a href="https://wa.me/?text=${txt}" target="_blank" rel="noopener">WhatsApp</a><a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}" target="_blank" rel="noopener">LinkedIn</a><button type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(url)}').then(()=>{this.textContent='Link copiado'})">Copiar link</button></div>
</article>
<div class="cta-post"><div class="box-cta"><div><b>Quer aplicar isso na sua loja?</b><p>A GLR opera ADS, anúncios, preço e estoque no Mercado Livre, Shopee e Amazon — e você acompanha tudo num portal próprio.</p></div><a class="bt bt-luz" href="${WHATS}" target="_blank" rel="noopener">Falar com um especialista</a></div></div>
${relac.length ? `<section class="relac"><div class="wrap"><h2 class="d">Leia também</h2><div class="relac-g">${relac.map(x => `<a class="mini" href="/blog/${esc(x.slug)}">${capa(x, 'm')}${etiqueta(x)}<h3 class="d">${esc(x.titulo)}</h3><span class="meta">${dataBR(x.publicado_em)}</span></a>`).join('')}</div></div></section>` : ''}` });
}
function rss(pub) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>GLR Notícias</title><link>${SITE}/blog</link><description>O varejo digital explicado para quem vende em marketplace.</description><language>pt-BR</language>
${pub.slice(0, 30).map(p => `<item><title>${esc(p.titulo)}</title><link>${SITE}/blog/${esc(p.slug)}</link><guid>${SITE}/blog/${esc(p.slug)}</guid><pubDate>${new Date(p.publicado_em).toUTCString()}</pubDate><description>${esc(p.resumo)}</description><category>${esc(ed(p).nome)}</category></item>`).join('\n')}
</channel></rss>`;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const est = await blog.lerEstado(lerStorage);
      const pub = est.posts.filter(p => p.status === 'publicado').sort((a, b) => String(b.publicado_em).localeCompare(String(a.publicado_em)));
      const slug = String(req.query?.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
      if (req.query?.formato === 'json') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(200).json({ posts: pub.slice(0, 6).map(p => ({ titulo: p.titulo, resumo: p.resumo, slug: p.slug, publicado_em: p.publicado_em, foto: p.foto?.url || null, editoria: ed(p).nome, cor: ed(p).cor })) }); }
      if (req.query?.formato === 'rss') { res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8'); return res.status(200).send(rss(pub)); }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.query?.editoria) { const e = blog.EDITORIAS.find(x => x.id === String(req.query.editoria)); if (e) return res.status(200).send(htmlEditoria(e, pub)); }
      if (!slug) return res.status(200).send(htmlHome(pub));
      const p = pub.find(x => x.slug === slug);
      if (!p) return res.status(404).send(htmlHome(pub, 'Não encontramos esta notícia — veja as mais recentes abaixo.'));
      return res.status(200).send(htmlPost(p, pub));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
    res.setHeader('Cache-Control', 'private, no-store');
    const user = await requireStaff(req, res); if (!user) return;
    const b = req.body || {};
    if (b.acao === 'gerar') {
      const r = await blog.gerarRascunhos({ lerStorage, sbUpsert, anthropicKey: process.env.ANTHROPIC_API_KEY }, { qtd: Math.min(5, Math.max(1, parseInt(b.qtd) || 3)) });
      const est = await blog.lerEstado(lerStorage);
      return res.status(200).json({ ok: true, ...r, posts: est.posts });
    }
    if (b.acao === 'fotos_faltando') { // publicadas sem foto: até 2 por chamada (cada foto leva ~20s); a tela repete até zerar
      const est0 = await blog.lerEstado(lerStorage);
      const sem = est0.posts.filter(p => p.status === 'publicado' && (!p.foto?.url || (b.refazer && p.foto.versao !== 2))).sort((a, b) => String(b.publicado_em).localeCompare(String(a.publicado_em)));
      const feitas = [], erros = [];
      for (const p of sem.slice(0, 2)) {
        try { p.foto = await require('./_blog-foto').gerarFotoPost(p, blog.editoriaDe(p).id); feitas.push(p.titulo); } catch (e) { erros.push(`${p.titulo.slice(0, 50)}: ${e.message}`); }
      }
      if (feitas.length) { // relê antes de gravar para não perder edição feita enquanto as fotos eram geradas
        const est1 = await blog.lerEstado(lerStorage);
        for (const p of sem.slice(0, 2)) if (p.foto?.url) { const q = est1.posts.find(x => x.id === p.id); if (q) q.foto = p.foto; }
        await blog.salvarEstado(sbUpsert, est1);
      }
      return res.status(200).json({ ok: true, feitas, erros, faltam: Math.max(0, sem.length - feitas.length) });
    }
    const est = await blog.lerEstado(lerStorage);
    if (b.acao === 'listar') return res.status(200).json({ posts: est.posts, fontes: blog.FONTES.map(f => f.nome), editorias: blog.EDITORIAS.map(({id,nome})=>({id,nome})) });
    const p = est.posts.find(x => x.id === b.id);
    if (!p) return res.status(404).json({ error: 'Post não encontrado.' });
    const agora = new Date().toISOString();
    if (b.acao === 'salvar') {
      const tit = String(b.titulo || '').trim(), corpo = String(b.corpo || '').trim();
      if (!tit || tit.length > 140 || !corpo || corpo.length > 20000) return res.status(400).json({ error: 'Título (até 140) e texto são obrigatórios.' });
      if (b.editoria !== undefined) {
        if (b.editoria && !blog.EDITORIAS.some(e => e.id === b.editoria)) return res.status(400).json({error:'Categoria inválida.'});
        if (b.editoria) p.editoria = b.editoria; else delete p.editoria;
      }
      Object.assign(p, { titulo: tit, resumo: String(b.resumo || '').trim().slice(0, 200), corpo, tags: (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map(t => String(t).trim()).filter(Boolean).slice(0, 4), atualizado_em: agora, editado_por: user.email || null });
      if (p.status !== 'publicado') { let slug = blog.slugDe(tit) || p.slug; while (est.posts.some(x => x !== p && x.slug === slug)) slug += '-2'; p.slug = slug; } // link já publicado não muda
    } else if (b.acao === 'publicar') { if (p.status === 'descartado') return res.status(400).json({ error: 'Post descartado.' }); p.status = 'publicado'; p.publicado_em = p.publicado_em || agora; p.publicado_por = user.email || null; }
    else if (b.acao === 'foto') { p.foto = await require('./_blog-foto').gerarFotoPost(p, blog.editoriaDe(p).id); }
    else if (b.acao === 'tirar_foto') { delete p.foto; }
    else if (b.acao === 'despublicar') p.status = 'rascunho';
    else if (b.acao === 'descartar') { if (p.status === 'publicado') return res.status(400).json({ error: 'Despublique antes de descartar.' }); p.status = 'descartado'; }
    else return res.status(400).json({ error: 'Ação inválida.' });
    await blog.salvarEstado(sbUpsert, est);
    return res.status(200).json({ ok: true, post: p });
  } catch (e) {
    if (req.method === 'GET') return res.status(503).send('Blog indisponível no momento. Tente de novo em instantes.');
    return res.status(503).json({ error: e.message || 'Blog indisponível.' });
  }
};
