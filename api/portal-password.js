// Password updates for existing portal accounts. Never accepts a user ID or
// arbitrary email from the browser, and never changes roles or confirmations.
const { requireStaff } = require('./_auth');
const BASE = 'https://rrodqlejqyaoomutriiw.supabase.co';
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!await requireStaff(req, res)) return;
  const { portalId, password } = req.body || {};
  if (typeof portalId !== 'string' || !portalId || portalId.length > 160) return res.status(400).json({ error: 'Acesso do portal inválido.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Use uma senha entre 8 e 128 caracteres.' });
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const read = async path => {
    const response = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('lookup');
    return response.json();
  };
  try {
    const rows = await read('/rest/v1/glr_storage?chave=eq.glr_portal_configs&select=dados');
    const configs = Array.isArray(rows[0]?.dados) ? rows[0].dados : [];
    const cfg = configs.find(c => c.id === portalId);
    if (!cfg || cfg.ativo === false || !cfg.email) return res.status(404).json({ error: 'Acesso ativo do portal não encontrado.' });
    const email = String(cfg.email).toLowerCase();
    if (configs.some(c => String(c.email || '').toLowerCase() === email && c.ativo === false)) return res.status(403).json({ error: 'Existe um acesso desativado para este e-mail. Revise os cadastros.' });
    let user = null;
    for (let page = 1; page <= 20; page++) {
      const result = await read(`/auth/v1/admin/users?page=${page}&per_page=100`);
      if (!Array.isArray(result.users)) throw new Error('lookup');
      user = result.users.find(u => String(u.email || '').toLowerCase() === email);
      if (user || result.users.length < 100) break;
    }
    if (!user) return res.status(404).json({ error: 'Login não encontrado. Confira o e-mail cadastrado.' });
    const staff = await read(`/rest/v1/glr_staff?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`);
    if (!Array.isArray(staff) || staff.length) return res.status(403).json({ error: 'Este formulário não altera senhas da equipe.' });
    if (!user.email_confirmed_at || (user.banned_until && new Date(user.banned_until) > new Date())) return res.status(403).json({ error: 'O login precisa estar confirmado e ativo. A senha não foi alterada.' });
    const response = await fetch(`${BASE}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
      method: 'PUT', headers, body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const safe = ['weak_password', 'same_password'].includes(failure.error_code || failure.code);
      return res.status(response.status >= 500 ? 502 : 400).json({ error: safe ? 'Use uma senha diferente e mais forte.' : 'O provedor recusou a alteração de senha. A alteração não foi confirmada.' });
    }
    const updated = await response.json();
    if (updated.id !== user.id) throw new Error('unexpected response');
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(502).json({ error: 'Não foi possível confirmar a atualização. Confira o acesso antes de tentar novamente.' });
  }
};
