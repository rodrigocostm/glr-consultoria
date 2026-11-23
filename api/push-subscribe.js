// Registra (ou atualiza) a assinatura push de um dispositivo no Supabase

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await require('./_auth').requireStaff(req,res); if (!user) return;
  const sub = req.body || {};
  const endpoint = sub.endpoint;
  const p256dh = sub.keys?.p256dh;
  const auth   = sub.keys?.auth;
  if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'Assinatura inválida' });

  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return res.status(400).json({error:'Assinatura inválida'});
    const r = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ endpoint, p256dh, auth, user_id:user.id }),
    });
    if (!r.ok) { console.error('[push] banco',r.status); return res.status(503).json({ error: 'Não foi possível salvar a assinatura. Tente novamente.' }); }
    return res.status(200).json({ ok: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};

