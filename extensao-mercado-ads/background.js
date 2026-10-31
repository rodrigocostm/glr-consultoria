// ============================================================
// GLR Copiloto Mercado Ads — serviço de fundo
// ------------------------------------------------------------
// Login próprio do analista no sistema da GLR (Supabase, chave pública — a
// mesma do site; nenhuma chave secreta aqui) e as chamadas ao banco: listar o
// pacote do dia das campanhas abertas no Mercado Ads e marcar um passo como
// feito ou descartado. As regras de acesso do banco valem como no site.
// ============================================================
const SUPA = 'https://rrodqlejqyaoomutriiw.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJyb2RxbGVqcXlhb29tdXRyaWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjU5NjUsImV4cCI6MjA5NjQ0MTk2NX0.JaKQHoGH8S3ZdLQInLErpC21SZ0j4FmIGtvWKcBes-A';

async function guardar(j, emailAnt) {
  const s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: j.user?.email || emailAnt || null };
  await chrome.storage.local.set({ sessao: s });
  return s;
}

async function entrar(email, senha) {
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senha }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || 'E-mail ou senha incorretos.');
  return guardar(j);
}

// sessão válida (renova sozinha um minuto antes de vencer); null = precisa entrar de novo
async function sessao() {
  const { sessao: s } = await chrome.storage.local.get('sessao');
  if (!s) return null;
  if (s.expires_at * 1000 - Date.now() > 60e3) return s;
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
  if (!r.ok) { await chrome.storage.local.remove('sessao'); return null; }
  return guardar(await r.json(), s.email);
}

async function rest(caminho, opc = {}) {
  const s = await sessao();
  if (!s) throw new Error('SEM_LOGIN');
  const r = await fetch(`${SUPA}/rest/v1/${caminho}`, { ...opc, headers: { apikey: ANON, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...(opc.headers || {}) } });
  if (!r.ok) throw new Error(`Banco respondeu ${r.status}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

// recomendações pendentes do ML que tocam estas campanhas (como origem ou como destino)
async function listar(campanhas) {
  const ids = [...new Set((campanhas || []).map(String).filter(x => /^\d+$/.test(x)))];
  if (!ids.length) return [];
  const lista = ids.join(',');
  const qs = `tipo=eq.alerta&resultado=eq.so_alerta&dados->>marketplace=eq.ml&or=(dados->>campaign_id.in.(${lista}),dados->>destino_id.in.(${lista}))&select=id,conta_id,cliente_nome,titulo,explicacao,dados,criado_em&order=criado_em.desc&limit=200`;
  return rest(`glr_agente_log?${qs}`, { method: 'GET', headers: { Prefer: '' } });
}

async function marcar(id, resultado, dados, por) {
  const extra = resultado === 'executado' ? { dados: { ...(dados || {}), aplicado_em: new Date().toISOString(), aplicado_por: por || 'extensao' } } : {};
  await rest(`glr_agente_log?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ resultado, ...extra }) });
  return true;
}

chrome.runtime.onMessage.addListener((msg, _de, responder) => {
  (async () => {
    try {
      if (msg.tipo === 'entrar') return responder({ ok: true, email: (await entrar(msg.email, msg.senha)).email });
      if (msg.tipo === 'sair') { await chrome.storage.local.remove('sessao'); return responder({ ok: true }); }
      if (msg.tipo === 'estado') { const s = await sessao(); return responder({ ok: true, email: s?.email || null }); }
      if (msg.tipo === 'listar') return responder({ ok: true, itens: await listar(msg.campanhas) });
      if (msg.tipo === 'marcar') return responder({ ok: await marcar(msg.id, msg.resultado, msg.dados, msg.por) });
      responder({ ok: false, erro: 'mensagem desconhecida' });
    } catch (e) { responder({ ok: false, erro: e.message === 'SEM_LOGIN' ? 'SEM_LOGIN' : (e.message || String(e)) }); }
  })();
  return true; // resposta assíncrona
});
