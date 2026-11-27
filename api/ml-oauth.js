const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { requireStaff } = require('./_auth');

const MELI = 'https://api.mercadolibre.com';
const COOKIE = '__Secure-glr_ml_oauth';
const TTL_SECONDS = 600;

function digest(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function cookie(res, value, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/api/ml-oauth; Secure; HttpOnly; SameSite=Lax`);
}

const deadline = () => AbortSignal.timeout(10000);

const PRODUCTION_DB = 'https://rrodqlejqyaoomutriiw.supabase.co';
const production = () => process.env.VERCEL_ENV === 'production';
const databaseUrl = () => process.env.ML_OAUTH_SUPABASE_URL || (production() ? PRODUCTION_DB : '');

function privateConfig(key, query = '') {
  const url = new URL('/rest/v1/glr_config_privada', databaseUrl());
  url.search = query;
  return {
    url,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: deadline(),
  };
}

async function start(req, res, config) {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const db = privateConfig(config.key);
  const saved = await fetch(db.url, {
    method: 'POST', signal: db.signal, headers: db.headers,
    body: JSON.stringify({
      chave: `ml_pkce_piloto:${digest(state)}`,
      valor: JSON.stringify({ verifier, browser: digest(nonce), staff: staff.id, seller: config.seller, expires: Date.now() + TTL_SECONDS * 1000 }),
    }),
  });
  if (!saved.ok) throw new Error('pkce_store');
  const authorization = new URL('https://auth.mercadolivre.com.br/authorization');
  authorization.search = new URLSearchParams({
    response_type: 'code', client_id: config.id, redirect_uri: config.redirect,
    state, code_challenge: digest(verifier), code_challenge_method: 'S256',
  });
  cookie(res, nonce, TTL_SECONDS);
  return res.status(200).json({ authorization_url: authorization.href });
}

async function callback(req, res, config) {
  const { state, code, error } = req.query || {};
  const nonce = String(req.headers.cookie || '').match(/(?:^|;\s*)__Secure-glr_ml_oauth=([\w-]{43})(?:;|$)/)?.[1];
  if (typeof state !== 'string' || !/^[\w-]{43}$/.test(state) || !nonce || (typeof code !== 'string' && typeof error !== 'string')) {
    return res.status(400).json({ error: 'Inicie a conexão pela sessão autenticada da GLR.' });
  }

  const query = new URLSearchParams({ chave: `eq.ml_pkce_piloto:${digest(state)}`, select: 'valor' });
  const db = privateConfig(config.key, query);
  const pending = await fetch(db.url, { headers: db.headers, signal: db.signal });
  if (!pending.ok) throw new Error('pkce_read');
  const row = (await pending.json())[0];
  const attempt = row && JSON.parse(row.valor);
  if (!attempt || attempt.expires <= Date.now() || attempt.seller !== config.seller ||
      typeof attempt.browser !== 'string' || attempt.browser.length !== 43 ||
      !timingSafeEqual(Buffer.from(attempt.browser), Buffer.from(digest(nonce)))) {
    return res.status(400).json({ error: 'Conexão inválida ou expirada. Inicie outra pela GLR.' });
  }

  const consumed = await fetch(db.url, {
    method: 'DELETE', signal: deadline(), headers: { ...db.headers, Prefer: 'return=representation' },
  });
  if (!consumed.ok) throw new Error('pkce_consume');
  if ((await consumed.json()).length !== 1) return res.status(400).json({ error: 'Esta conexão já foi utilizada.' });
  cookie(res, '', 0);
  if (error) return res.status(400).json({ error: 'Autorização recusada. Inicie outra pela GLR.' });

  const exchanged = await fetch(`${MELI}/oauth/token`, {
    method: 'POST', signal: deadline(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: config.id, client_secret: config.secret,
      code, redirect_uri: config.redirect, code_verifier: attempt.verifier,
    }),
  });
  if (!exchanged.ok) return res.status(502).json({ error: 'O Mercado Livre recusou a autorização.' });
  const grant = await exchanged.json();
  if (!grant.access_token || !grant.refresh_token || !Number.isFinite(grant.expires_in) || grant.expires_in <= 0) {
    return res.status(502).json({ error: 'O Mercado Livre retornou uma autorização incompleta.' });
  }
  if (String(grant.user_id) !== attempt.seller) {
    return res.status(403).json({ error: 'Entre com a loja piloto autorizada pela GLR.' });
  }

  const storage = privateConfig(config.key, 'on_conflict=chave');
  const saved = await fetch(storage.url, {
    method: 'POST', signal: storage.signal,
    headers: { ...storage.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      chave: `ml_oauth:${attempt.seller}`,
      valor: JSON.stringify({
        user_id: grant.user_id, access_token: grant.access_token, refresh_token: grant.refresh_token,
        expira_em: new Date(Date.now() + grant.expires_in * 1000).toISOString(), scope: grant.scope ?? null,
      }),
    }),
  });
  if (!saved.ok) throw new Error('grant_store');
  return res.status(200).json({ ok: true, message: 'Loja conectada à GLR.' });
}

function connectionPage(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!doctype html>
<html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar loja | GLR Consultoria</title>
<main><h1>Conectar loja ao GLR Ads</h1>
<p>Entre no painel GLR com sua conta de equipe e volte a esta página no mesmo navegador.</p>
<p><a href="/">Abrir painel GLR</a></p>
<button id="connect" type="button">Continuar no Mercado Livre</button>
<p id="status" role="status"></p></main>
<script>
const button = document.getElementById('connect');
const status = document.getElementById('status');
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const session = JSON.parse(localStorage.getItem('sb-rrodqlejqyaoomutriiw-auth-token') || 'null');
    if (!session?.access_token) {
      status.textContent = 'Entre no painel GLR e tente novamente.';
      return;
    }
    const response = await fetch('/api/ml-oauth', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + session.access_token },
    });
    const result = await response.json();
    if (!response.ok) {
      status.textContent = result.error || 'Abra o painel GLR e tente novamente.';
      return;
    }
    location.assign(result.authorization_url);
  } catch {
    status.textContent = 'Não foi possível iniciar a conexão. Tente novamente.';
  } finally {
    button.disabled = false;
  }
});
</script></html>`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }
  const config = {
    id: process.env.ML_APP_ID,
    secret: process.env.ML_APP_SECRET,
    seller: process.env.ML_OAUTH_PILOT_SELLER_ID,
    redirect: process.env.ML_OAUTH_REDIRECT_URI,
    key: process.env.ML_OAUTH_SUPABASE_SERVICE_ROLE_KEY || (production() && databaseUrl() === PRODUCTION_DB ? process.env.SUPABASE_SERVICE_ROLE_KEY : ''),
  };
  if (!Object.values(config).every(Boolean) || !/^\d+$/.test(config.seller) || !databaseUrl()) {
    return res.status(503).json({ error: 'Conexão piloto indisponível.' });
  }
  if (req.method === 'GET' && !Object.keys(req.query || {}).length) return connectionPage(res);
  try {
    return await (req.method === 'POST' ? start(req, res, config) : callback(req, res, config));
  } catch {
    return res.status(502).json({ error: 'Não foi possível concluir a conexão. Inicie outra tentativa.' });
  }
};
