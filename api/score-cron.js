// Cron: grava o registro do dia do score de saúde das lojas (página Score da
// operação). Roda às 23:50 de Brasília (02:50 UTC), lê o que os agentes já
// gravaram em glr_sync_estado e o resumo diário da base (TACOS 30 dias) e salva
// os valores brutos de cada critério por loja em glr_storage, chave
// glr_score_dia_AAAA-MM-DD. A nota é refeita na tela com os pesos atuais.
// Nenhuma chamada ao marketplace: só leitura do banco.
const SC = require('../js/score-contas.js');

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const sbHeaders = (extra = {}) => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
};

async function lerRecurso(recurso, campos, mkt) {
  const q = `recurso=eq.${recurso}${mkt ? `&marketplace=eq.${mkt}` : ''}&select=${encodeURIComponent(`marketplace,conta_id,ultimo_sucesso,${campos}`)}`;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_sync_estado?${q}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`glr_sync_estado ${recurso}: HTTP ${r.status}`);
  return r.json();
}

// mesmo formato de BaseDados.carregar (js/base-dados.js), só com o que o TACOS usa
async function lerBase() {
  const [res, ped, ads] = await Promise.all([
    lerRecurso('resumo', 'dias:cursor->dias'),
    lerRecurso('pedidos', 'historico_ate:cursor->historico_ate'),
    lerRecurso('ads', 'hist_ate:cursor->hist_ate'),
  ]);
  const base = {};
  for (const e of ped) base[`${e.marketplace}:${e.conta_id}`] = { dias: {}, historicoAte: e.historico_ate || null };
  for (const e of res) { const k = `${e.marketplace}:${e.conta_id}`; base[k] = base[k] || { historicoAte: null }; base[k].dias = e.dias || {}; base[k].resumoEm = e.ultimo_sucesso; }
  for (const e of ads) { const k = `${e.marketplace}:${e.conta_id}`; if (base[k] && e.ultimo_sucesso) base[k].adsHistAte = e.hist_ate || null; }
  return base;
}

async function gravarRegistro() {
  const ids = Object.keys(SC.LEITURAS);
  const listas = await Promise.all(ids.map(id => lerRecurso(id, SC.LEITURAS[id], id === 'funil' ? 'shopee' : null)));
  const rows = {}; ids.forEach((id, i) => { rows[id] = listas[i]; });
  const hoje = SC.hojeBRT();
  const reg = SC.registroDoDia(SC.mapaAgentes(rows), await lerBase(), hoje);
  const chave = SC.CHAVE_DIA + hoje;
  const w = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?on_conflict=chave`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ chave, dados: reg, atualizado_em: new Date().toISOString() }),
  });
  if (!w.ok) throw new Error(`glr_storage: HTTP ${w.status}`);
  return { dia: hoje, lojas: Object.keys(reg.lojas).length };
}

module.exports = async function handler(req, res) {
  if (!require('./_auth').cronAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY ausente' });
  try { return res.status(200).json({ ok: true, ...(await gravarRegistro()) }); }
  catch (e) { return res.status(500).json({ error: e.message || String(e) }); }
};
module.exports.gravarRegistro = gravarRegistro;
