// ============================================================
// GLR Consultoria — Blog (consultoriaglr.com.br/blog)
// ------------------------------------------------------------
// GET público (vercel.json reescreve /blog e /blog/<slug> para cá): a lista dos
// posts PUBLICADOS e a página de cada post, em HTML pronto para o Google
// (título, descrição, link canônico, Open Graph e dados estruturados). Rascunho
// nunca aparece aqui.
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
const dataBR = iso => iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' }) : '';
function pagina({ titulo, descricao, url, corpo, jsonld }) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><meta name="description" content="${esc(descricao)}"><link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${jsonld ? 'article' : 'website'}"><meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(descricao)}"><meta property="og:url" content="${esc(url)}"><meta property="og:site_name" content="GLR Consultoria">
<link rel="icon" href="/logo.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
<style>
:root{--blue:#0B4FE0;--blue-dark:#083BAA;--blue-soft:#E8EFFD;--ink:#0A0A0A;--paper:#fff;--soft:#F4F6FB;--sec:#52586B;--mute:#8B90A0;--border:#E5E8F0}
*{box-sizing:border-box}body{margin:0;font-family:Poppins,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper);line-height:1.6}
a{color:var(--blue)}.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--border);background:#fff}header .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;height:64px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px;color:var(--ink);text-decoration:none}.logo img{width:28px;height:28px;object-fit:contain}
nav{display:flex;gap:18px;align-items:center;font-size:14px}nav a{color:var(--sec);text-decoration:none;font-weight:500}nav a:hover{color:var(--ink)}
.btn{display:inline-block;background:var(--blue);color:#fff !important;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px}.btn:hover{background:var(--blue-dark)}
.hero{background:var(--soft);padding:44px 0 34px}.hero h1{font-size:clamp(26px,4vw,38px);line-height:1.2;margin:0 0 8px;letter-spacing:-.02em;text-wrap:balance}.hero p{color:var(--sec);margin:0;max-width:640px}
.grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;padding:34px 0 50px}
.card{display:flex;flex-direction:column;gap:8px;border:1px solid var(--border);border-radius:14px;padding:20px;text-decoration:none;color:inherit;background:#fff;transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:#c9d6f7;box-shadow:0 8px 24px rgba(10,10,10,.06)}.card h2{font-size:18px;line-height:1.35;margin:0;color:var(--ink)}.card p{margin:0;color:var(--sec);font-size:14.5px}
.meta{font-size:12.5px;color:var(--mute)}.tags{display:flex;gap:6px;flex-wrap:wrap}.tags span{font-size:11.5px;font-weight:600;color:var(--blue);background:var(--blue-soft);border-radius:99px;padding:2px 9px}
.vazio{padding:60px 0;text-align:center;color:var(--sec)}
article{max-width:720px;margin:0 auto;padding:36px 20px 20px}article h1{font-size:clamp(26px,4.2vw,36px);line-height:1.22;letter-spacing:-.02em;margin:10px 0 10px;text-wrap:balance}
.voltar{font-size:13.5px;text-decoration:none;font-weight:500}.lead{font-size:17px;color:var(--sec);margin:0 0 6px}
.corpo{font-size:16.5px}.corpo h2{font-size:21px;margin:30px 0 8px;letter-spacing:-.01em}.corpo h3{font-size:18px;margin:24px 0 6px}.corpo p{margin:0 0 16px}.corpo ul,.corpo ol{padding-left:22px;margin:0 0 16px}.corpo li{margin:5px 0}
.corpo blockquote{margin:0 0 16px;padding:10px 16px;border-left:3px solid var(--blue);background:var(--soft);color:var(--sec)}
.fonte{font-size:13.5px;color:var(--sec);border-top:1px solid var(--border);padding-top:14px;margin-top:26px}
.cta{max-width:720px;margin:10px auto 50px;padding:24px;border-radius:16px;background:var(--blue-soft);display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.cta b{font-size:17px;display:block}.cta span{color:var(--sec);font-size:14.5px}
footer{border-top:1px solid var(--border);padding:22px 0;font-size:13px;color:var(--mute)}
@media(max-width:640px){nav a:not(.btn){display:none}.cta{margin:10px 16px 40px}}
</style></head><body>
<header><div class="wrap"><a class="logo" href="/landing.html"><img src="/logo.png" alt="" onerror="this.style.display='none'">GLR Consultoria</a>
<nav><a href="/blog">Notícias</a><a href="/landing.html">A GLR</a><a href="/calculadora.html">Calculadora</a><a class="btn" href="${WHATS}" target="_blank" rel="noopener">Falar no WhatsApp</a></nav></div></header>
${corpo}
<footer><div class="wrap">© ${new Date().getFullYear()} GLR Consultoria · Gestão de lojas no Mercado Livre, Shopee, Amazon, TikTok Shop e Magalu. Os posts resumem e comentam notícias de outros veículos, sempre com o link da fonte original.</div></footer>
</body></html>`;
}

function htmlLista(posts, aviso) {
  return pagina({ titulo: 'Notícias do varejo digital | GLR Consultoria', descricao: 'O que acontece no Mercado Livre, Shopee, Amazon e no e-commerce brasileiro — e o que isso muda para quem vende.', url: `${SITE}/blog`,
    corpo: `<section class="hero"><div class="wrap"><h1>Notícias do varejo digital</h1><p>O que acontece no Mercado Livre, Shopee, Amazon e no e-commerce brasileiro — e o que isso muda para quem vende, explicado pela equipe da GLR.</p></div></section>
<main class="wrap">${aviso ? `<div class="vazio">${esc(aviso)}</div>` : ''}${posts.length ? `<div class="grade">${posts.map(p => `<a class="card" href="/blog/${esc(p.slug)}"><span class="meta">${dataBR(p.publicado_em)} · com informações de ${esc(p.fonte?.nome || '')}</span><h2>${esc(p.titulo)}</h2><p>${esc(p.resumo)}</p>${p.tags?.length ? `<div class="tags">${p.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}</a>`).join('')}</div>` : '<div class="vazio">Em breve, as primeiras notícias.</div>'}</main>` });
}
function htmlPost(p) {
  const url = `${SITE}/blog/${p.slug}`;
  return pagina({ titulo: `${p.titulo} | GLR Consultoria`, descricao: p.resumo || p.titulo, url,
    jsonld: { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.titulo, description: p.resumo, datePublished: p.publicado_em, dateModified: p.atualizado_em || p.publicado_em, mainEntityOfPage: url, author: { '@type': 'Organization', name: 'GLR Consultoria' }, publisher: { '@type': 'Organization', name: 'GLR Consultoria', logo: { '@type': 'ImageObject', url: `${SITE}/logo.png` } }, isBasedOn: p.fonte?.url },
    corpo: `<article><a class="voltar" href="/blog">← Todas as notícias</a><h1>${esc(p.titulo)}</h1><p class="lead">${esc(p.resumo)}</p>
<div class="meta">${dataBR(p.publicado_em)} · Equipe GLR Consultoria · com informações de <a href="${esc(p.fonte?.url)}" target="_blank" rel="noopener nofollow">${esc(p.fonte?.nome)}</a></div>
<div class="corpo" style="margin-top:22px">${blog.mdParaHtml(String(p.corpo || '').replace(/\n+Fonte:.*$/i, ''))}</div>
<div class="fonte">Fonte original: <a href="${esc(p.fonte?.url)}" target="_blank" rel="noopener nofollow">${esc(p.fonte?.titulo || p.fonte?.nome)}</a> (${esc(p.fonte?.nome)}). Este texto é um resumo comentado pela GLR; os detalhes completos estão na matéria original.</div></article>
<div class="cta"><div><b>Quer ajuda para aplicar isso na sua loja?</b><span>A GLR cuida de ADS, catálogo, preço e estratégia no Mercado Livre, Shopee e Amazon.</span></div><a class="btn" href="${WHATS}" target="_blank" rel="noopener">Falar com um especialista</a></div>` });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const est = await blog.lerEstado(lerStorage);
      const pub = est.posts.filter(p => p.status === 'publicado').sort((a, b) => String(b.publicado_em).localeCompare(String(a.publicado_em)));
      const slug = String(req.query?.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
      if (!slug) return res.status(200).send(htmlLista(pub));
      const p = pub.find(x => x.slug === slug);
      if (!p) return res.status(404).send(htmlLista(pub, 'Não encontramos esta notícia — veja as mais recentes abaixo.'));
      return res.status(200).send(htmlPost(p));
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
    const est = await blog.lerEstado(lerStorage);
    if (b.acao === 'listar') return res.status(200).json({ posts: est.posts, fontes: blog.FONTES.map(f => f.nome) });
    const p = est.posts.find(x => x.id === b.id);
    if (!p) return res.status(404).json({ error: 'Post não encontrado.' });
    const agora = new Date().toISOString();
    if (b.acao === 'salvar') {
      const tit = String(b.titulo || '').trim(), corpo = String(b.corpo || '').trim();
      if (!tit || tit.length > 140 || !corpo || corpo.length > 20000) return res.status(400).json({ error: 'Título (até 140) e texto são obrigatórios.' });
      Object.assign(p, { titulo: tit, resumo: String(b.resumo || '').trim().slice(0, 200), corpo, tags: (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map(t => String(t).trim()).filter(Boolean).slice(0, 4), atualizado_em: agora, editado_por: user.email || null });
      if (p.status !== 'publicado') { let slug = blog.slugDe(tit) || p.slug; while (est.posts.some(x => x !== p && x.slug === slug)) slug += '-2'; p.slug = slug; } // link já publicado não muda
    } else if (b.acao === 'publicar') { if (p.status === 'descartado') return res.status(400).json({ error: 'Post descartado.' }); p.status = 'publicado'; p.publicado_em = p.publicado_em || agora; p.publicado_por = user.email || null; }
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
