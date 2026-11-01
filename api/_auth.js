// Central authorization. A valid session alone never grants staff privileges.
const { timingSafeEqual } = require('node:crypto');
const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  const actual = String(req.headers?.authorization || '');
  if (!secret) return false;
  const expected = `Bearer ${secret}`;
  return Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
async function access(req) {
  const token = String(req.headers?.authorization || '').match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return null;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Authorization unavailable');
  const headers = { apikey: key, Authorization: `Bearer ${token}` };
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers });
  if (!userResponse.ok) return null;
  const user = await userResponse.json();
  if (!user?.id) return null;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/glr_acesso`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!response.ok) throw new Error('Authorization unavailable');
  const role = await response.json();
  return { user, ...role };
}
async function requireStaff(req, res) {
  try {
    const identity = await access(req);
    if (!identity) { res.status(401).json({ error: 'Faça login para continuar.' }); return null; }
    if (identity.role !== 'staff') { res.status(403).json({ error: 'Acesso restrito à equipe GLR.' }); return null; }
    return identity.user;
  } catch {
    res.status(503).json({ error: 'Não foi possível verificar as permissões.' }); return null;
  }
}
function internalOrigin() {
  const value = process.env.GLR_INTERNAL_ORIGIN || 'https://consultoriaglr.com.br';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('GLR_INTERNAL_ORIGIN inválida');
  return url.origin;
}
module.exports = { access, requireStaff, cronAuthorized, internalOrigin };
