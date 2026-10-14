// ============================================================
// GLR Consultoria — App próprio da GLR no Mercado Livre (OAuth)
// ------------------------------------------------------------
// Por quê: pelo conector Tiops a ESCRITA em Product Ads volta 401 ("o ML não
// liberou escrita para integrações"). O app da GLR (5910746940823924) tem a
// permissão "Publicidade de um produto: leitura e escrita". Esta rota:
//   GET /api/ml-oauth                 → manda o vendedor autorizar o app no ML
//                                       (com PKCE S256 — o app exige)
//   GET /api/ml-oauth?code=…&state=…  → volta do ML: troca o código por token,
//                                       guarda (só o servidor lê) e testa LEITURA
//                                       de Product Ads na conta
//   POST /api/ml-oauth                → avisos do ML (notificações): responde 200
//   GET /api/ml-oauth?acao=teste-escrita&user=…&sig=… → teste NEUTRO de escrita:
//                                       regrava o MESMO orçamento de 1 campanha
// O teste mostra a resposta exata do ML — a documentação de Product Ads mudou
// (endpoints antigos desligados em 26/02/2026), então tenta o caminho novo e o
// antigo e mostra o que cada um respondeu.
//
// Variáveis na Vercel: ML_APP_SECRET (obrigatória), ML_APP_ID (opcional).
// Tokens ficam em glr_config_privada (chave ml_oauth:<user_id>), tabela sem
// leitura para a equipe — só a service role.
// ============================================================
const crypto = require('crypto');

const APP_ID = process.env.ML_APP_ID || '5910746940823924';
const APP_SECRET = process.env.ML_APP_SECRET;
const REDIRECT_URI = 'https://consultoriaglr.com.br/api/ml-oauth';
const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ML = 'https://api.mercadolibre.com';

const assinar = txt => crypto.createHmac('sha256', APP_SECRET).update(txt).digest('hex').slice(0, 32);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sbUpsertPrivado(chave, valor) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_config_privada?on_conflict=chave`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ chave, valor }]),
  });
  if (!r.ok) throw new Error(`não consegui guardar o token: HTTP ${r.status} ${await r.text().catch(() => '')}`);
}
async function sbLerPrivado(chave) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_config_privada?chave=eq.${encodeURIComponent(chave)}&select=valor`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) return null;
  return (await r.json())[0]?.valor || null;
}

// PKCE (o app da GLR exige "PKCE necessário"): o code_verifier fica guardado no
// servidor por 20 min, ligado a um nonce que vai no state — nunca passa pelo navegador.
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function novoPkce() {
  const nonce = b64url(crypto.randomBytes(12));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  await sbUpsertPrivado(`ml_pkce:${nonce}`, JSON.stringify({ verifier, ts: Date.now() }));
  return { nonce, challenge };
}
async function verifierDoNonce(nonce) {
  const bruto = await sbLerPrivado(`ml_pkce:${nonce}`);
  if (!bruto) return null;
  const d = JSON.parse(bruto);
  if (Date.now() - d.ts > 20 * 60 * 1000) return null;
  await sbUpsertPrivado(`ml_pkce:${nonce}`, JSON.stringify({ usado: true, ts: 0 })); // uso único
  return d.verifier || null;
}

async function trocarToken(params) {
  const r = await fetch(`${ML}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: APP_ID, client_secret: APP_SECRET, ...params }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`ML recusou o token: ${j.message || j.error || r.status}`);
  return j;
}
async function guardarToken(t, nickname) {
  const dados = { access_token: t.access_token, refresh_token: t.refresh_token, expira_em: new Date(Date.now() + (t.expires_in || 21600) * 1000).toISOString(), user_id: t.user_id, nickname: nickname || null, scope: t.scope || null };
  await sbUpsertPrivado(`ml_oauth:${t.user_id}`, JSON.stringify(dados));
  return dados;
}
// Token válido da conta (renova sozinho quando faltam < 10 min).
async function tokenDaConta(userId) {
  const bruto = await sbLerPrivado(`ml_oauth:${userId}`);
  if (!bruto) throw new Error('conta ainda não autorizada no app da GLR');
  const d = JSON.parse(bruto);
  if (new Date(d.expira_em).getTime() - Date.now() > 10 * 60 * 1000) return d;
  const novo = await trocarToken({ grant_type: 'refresh_token', refresh_token: d.refresh_token });
  return guardarToken(novo, d.nickname);
}

async function chamarML(token, metodo, caminho, { versao, corpo } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (versao) headers['api-version'] = String(versao);
  if (corpo) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${ML}${caminho}`, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch (e) {}
  return { metodo, caminho, versao: versao || null, status: r.status, ok: r.ok, json, texto: texto.slice(0, 600) };
}

// Leitura de Product Ads: anunciante → campanhas (caminho novo e antigo).
async function testarLeitura(token) {
  const passos = [];
  const adv = await chamarML(token, 'GET', '/advertising/advertisers?product_id=PADS', { versao: 1 });
  passos.push(adv);
  const anunciante = adv.json?.advertisers?.[0] || null;
  let campanhas = [];
  if (anunciante?.advertiser_id) {
    const site = anunciante.site_id || 'MLB';
    const novo = await chamarML(token, 'GET', `/marketplace/advertising/${site}/advertisers/${anunciante.advertiser_id}/product_ads/campaigns/search?limit=5`, { versao: 2 });
    passos.push(novo);
    campanhas = novo.json?.results || [];
    if (!novo.ok) {
      const antigo = await chamarML(token, 'GET', `/advertising/advertisers/${anunciante.advertiser_id}/product_ads/campaigns?limit=5`, { versao: 2 });
      passos.push(antigo);
      if (antigo.ok) campanhas = antigo.json?.results || [];
    }
  }
  return { anunciante, campanhas, passos };
}

// Escrita NEUTRA: regrava o mesmo orçamento numa campanha — nada muda de fato.
async function testarEscrita(token, leitura) {
  const passos = [];
  const camp = leitura.campanhas.find(c => c.budget != null) || leitura.campanhas[0];
  if (!camp) return { campanha: null, passos, conclusao: 'Não achei campanha de Product Ads nessa conta para testar.' };
  const site = leitura.anunciante?.site_id || 'MLB';
  const corpo = { budget: camp.budget };
  const novo = await chamarML(token, 'PUT', `/marketplace/advertising/${site}/product_ads/campaigns/${camp.id}`, { versao: 2, corpo });
  passos.push(novo);
  if (!novo.ok && novo.status !== 401 && novo.status !== 403) {
    passos.push(await chamarML(token, 'PUT', `/advertising/product_ads/campaigns/${camp.id}`, { versao: 2, corpo }));
  }
  const aceitou = passos.some(p => p.ok);
  const negou = passos.some(p => p.status === 401 || p.status === 403);
  return {
    campanha: { id: camp.id, nome: camp.name, orcamento: camp.budget },
    passos,
    conclusao: aceitou ? '✅ O ML ACEITOU a escrita pelo app da GLR — dá para o Agente ajustar Product Ads.'
      : negou ? '⛔ O ML NEGOU a escrita (sem permissão) também pelo app da GLR.'
      : '⚠️ Resposta inesperada — veja os detalhes abaixo.',
  };
}

function pagina(titulo, corpoHtml) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f6f7fb;color:#1f2433;margin:0;padding:24px 16px;}main{max-width:820px;margin:0 auto;background:#fff;border:1px solid #e3e6ef;border-radius:14px;padding:22px 24px;}
h1{font-size:20px;margin:0 0 6px}p{line-height:1.55}.ok{color:#15803d}.erro{color:#b91c1c}code,pre{background:#f1f3f8;border-radius:6px;font-size:12px}pre{padding:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #eceef4;padding:6px 8px;text-align:left;vertical-align:top}.btn{display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:9px;text-decoration:none;font-weight:600}</style></head>
<body><main><h1>${esc(titulo)}</h1>${corpoHtml}</main></body></html>`;
}
const tabelaPassos = passos => `<table><tr><th>Chamada</th><th>Resposta do ML</th></tr>${passos.map(p => `<tr><td><code>${esc(p.metodo)} ${esc(p.caminho)}</code>${p.versao ? `<br><small>api-version ${esc(p.versao)}</small>` : ''}</td><td class="${p.ok ? 'ok' : 'erro'}"><b>HTTP ${p.status}</b><pre>${esc(p.texto)}</pre></td></tr>`).join('')}</table>`;

module.exports = async function handler(req, res) {
  // Avisos do ML (URL de notificação do app aponta pra cá): o ML manda POST a cada
  // pedido/anúncio alterado. Por enquanto só confirma o recebimento (o ML exige
  // resposta 200 rápida) — o motor de dados já sincroniza a cada 15 min.
  if (req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ ok: true }));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!APP_SECRET || !SUPABASE_KEY) {
    return res.status(500).send(pagina('Falta configurar', '<p class="erro">Cadastre <code>ML_APP_SECRET</code> nas variáveis da Vercel (Settings → Environment Variables) e publique de novo.</p>'));
  }
  const q = req.query || {};
  try {
    // 3) Teste de escrita (link assinado, vale 30 min)
    if (q.acao === 'teste-escrita') {
      const ts = parseInt(q.ts, 10);
      if (!q.user || !ts || Date.now() - ts > 30 * 60 * 1000 || assinar(`escrita:${q.user}:${ts}`) !== q.sig) {
        return res.status(403).send(pagina('Link expirado', '<p class="erro">Este link de teste venceu ou é inválido. Autorize a conta de novo para gerar outro.</p>'));
      }
      const tok = await tokenDaConta(q.user);
      const leitura = await testarLeitura(tok.access_token);
      const escrita = await testarEscrita(tok.access_token, leitura);
      return res.status(200).send(pagina('Teste de escrita em Product Ads', `
        <p><b>Conta:</b> ${esc(tok.nickname || tok.user_id)} (${esc(tok.user_id)})</p>
        ${escrita.campanha ? `<p><b>Campanha testada:</b> ${esc(escrita.campanha.nome)} (${esc(escrita.campanha.id)}) — orçamento regravado com o MESMO valor: ${esc(escrita.campanha.orcamento)}</p>` : ''}
        <p style="font-size:17px"><b>${esc(escrita.conclusao)}</b></p>
        ${tabelaPassos(escrita.passos)}`));
    }

    // 2) Volta do ML com o código de autorização
    if (q.code) {
      const [nonce, sig] = String(q.state || '').split('.');
      const verifier = nonce && sig && assinar(`estado:${nonce}`) === sig ? await verifierDoNonce(nonce) : null;
      if (!verifier) {
        return res.status(403).send(pagina('Autorização inválida', '<p class="erro">O link de autorização venceu ou já foi usado. Abra <a href="/api/ml-oauth">/api/ml-oauth</a> de novo.</p>'));
      }
      const t = await trocarToken({ grant_type: 'authorization_code', code: q.code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
      const me = await chamarML(t.access_token, 'GET', '/users/me');
      const dados = await guardarToken(t, me.json?.nickname);
      const leitura = await testarLeitura(t.access_token);
      const tsE = Date.now();
      const linkEscrita = `/api/ml-oauth?acao=teste-escrita&user=${encodeURIComponent(dados.user_id)}&ts=${tsE}&sig=${assinar(`escrita:${dados.user_id}:${tsE}`)}`;
      return res.status(200).send(pagina('Conta conectada ao app da GLR ✓', `
        <p><b>Conta:</b> ${esc(dados.nickname || '')} (${esc(dados.user_id)}) · permissões: <code>${esc(dados.scope || '—')}</code></p>
        <h2 style="font-size:16px">Leitura de Product Ads</h2>
        <p>${leitura.anunciante ? `Anunciante <b>${esc(leitura.anunciante.advertiser_id)}</b> · ${leitura.campanhas.length} campanha(s) lidas` : 'Não achei anunciante de Product Ads nessa conta.'}</p>
        ${tabelaPassos(leitura.passos)}
        ${leitura.campanhas.length ? `<h2 style="font-size:16px">Teste de escrita (neutro)</h2>
        <p>Regrava o <b>mesmo orçamento</b> numa campanha (nada muda de fato) só para ver se o ML aceita escrita pelo app da GLR.</p>
        <p><a class="btn" href="${linkEscrita}">Testar escrita agora</a></p>` : ''}`));
    }

    // Erro devolvido pelo ML na autorização
    if (q.error) {
      return res.status(400).send(pagina('Autorização não concluída', `<p class="erro">O Mercado Livre respondeu: ${esc(q.error_description || q.error)}</p>`));
    }

    // 1) Início: manda autorizar no ML
    const { nonce, challenge } = await novoPkce();
    const state = `${nonce}.${assinar(`estado:${nonce}`)}`;
    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${encodeURIComponent(APP_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
    res.statusCode = 302;
    res.setHeader('Location', url);
    return res.end();
  } catch (e) {
    return res.status(500).send(pagina('Erro', `<p class="erro">${esc(e.message || String(e))}</p>`));
  }
};
