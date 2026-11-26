// Cota diária por usuário para as rotas de IA pagas. Mesmo espírito do chat
// do portal: o contador fica no servidor e zera no dia seguinte (Brasília).
const URL = 'https://rrodqlejqyaoomutriiw.supabase.co/rest/v1/glr_sync_estado';

function limite() {
  return Math.max(1, parseInt(process.env.GLR_IA_COTA_DIA, 10) || 40);
}
function hoje() {
  return new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
}
function erro(msg, status) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

async function consumir(userId, rota) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const uid = String(userId || '');
  if (!key || !uid) throw erro('Cota indisponível.', 503);
  const dia = hoje();
  const max = limite();
  const conta = `iacota:${rota}:${uid}:${dia}`.slice(0, 180);
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const ler = await fetch(`${URL}?marketplace=eq.sistema&recurso=eq.cota&conta_id=eq.${encodeURIComponent(conta)}&select=cursor`, { headers: H, signal: AbortSignal.timeout(10000) });
  if (!ler.ok) throw erro('Cota indisponível.', 503);
  const row = (await ler.json())[0];
  const n = row?.cursor?.dia === dia ? (parseInt(row.cursor.n, 10) || 0) : 0;
  if (n >= max) throw erro(`Você chegou ao limite de ${max} usos de hoje. Amanhã libera de novo.`, 429);
  const agora = new Date().toISOString();
  const gravar = await fetch(`${URL}?on_conflict=marketplace,conta_id,recurso`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ marketplace: 'sistema', conta_id: conta, recurso: 'cota', cursor: { dia, n: n + 1 }, ultima_tentativa: agora, ultimo_sucesso: agora, registros: n + 1 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!gravar.ok) throw erro('Cota indisponível.', 503);
  return { usadas: n + 1, limite: max };
}

module.exports = { consumir, limite, hoje };
