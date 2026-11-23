// Remove a assinatura push de um dispositivo do Supabase

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const identity = await require('./_auth').requireEquipeOuPortal(req,res); if (!identity) return; const user=identity.user;
  const endpoint = (req.body || {}).endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint obrigatório' });

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&user_id=eq.${encodeURIComponent(user.id)}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) { console.error('[push] banco',r.status); return res.status(503).json({ error: 'Não foi possível salvar a assinatura. Tente novamente.' }); }
    return res.status(200).json({ ok: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};


