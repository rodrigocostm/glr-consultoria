// ============================================================
// GLR Consultoria — Medidor de consumo da Tiops
// ------------------------------------------------------------
// O plano tem limite diário de ações (renova às 21h de Brasília) e, quando
// estoura, a sincronização de pedidos/ADS de todas as lojas para até a
// renovação. Aqui cada chamada é contada por ação e o total do "dia da Tiops"
// (21h → 21h) é gravado em glr_sync_estado (marketplace 'sistema', conta_id
// 'consumo:<origem>', recurso 'consumo') — mostra quem gasta a cota.
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

let cont = {};
let limite = false;

function contar(action) { cont[action] = (cont[action] || 0) + 1; }
function ehLimite(e) { return /PLAN_LIMIT|Limite di[aá]rio do plano/i.test(String(e?.message || e || '')); }
function marcarLimite() { limite = true; }
function limiteAtingido() { return limite; }

// Dia da cota: começa às 21h de Brasília (00h UTC) — é o próprio dia UTC
const diaCota = () => new Date().toISOString().slice(0, 10);

async function gravar(sbSelect, sbUpsert, origem) {
  const porAcao = cont; cont = {};
  const bateu = limite; limite = false;
  const total = Object.values(porAcao).reduce((s, n) => s + n, 0);
  if (!total && !bateu) return;
  const conta_id = `consumo:${origem}`, dia = diaCota();
  const ant = (await sbSelect('glr_sync_estado', `marketplace=eq.sistema&conta_id=eq.${encodeURIComponent(conta_id)}&recurso=eq.consumo&select=cursor`).catch(() => []))[0]?.cursor || {};
  const mesmoDia = ant.dia === dia;
  const acc = mesmoDia ? { ...(ant.porAcao || {}) } : {};
  for (const [a, n] of Object.entries(porAcao)) acc[a] = (acc[a] || 0) + n;
  const cursor = {
    dia, porAcao: acc, total: Object.values(acc).reduce((s, n) => s + n, 0),
    rodadas: (mesmoDia ? ant.rodadas || 0 : 0) + 1,
    limiteEm: bateu ? (mesmoDia && ant.limiteEm) || new Date().toISOString() : (mesmoDia ? ant.limiteEm || null : null),
    anterior: mesmoDia ? ant.anterior || null : (ant.dia ? { dia: ant.dia, total: ant.total, porAcao: ant.porAcao, limiteEm: ant.limiteEm || null } : null),
  };
  await sbUpsert('glr_sync_estado', [{ marketplace: 'sistema', conta_id, recurso: 'consumo', cursor, ultima_tentativa: new Date().toISOString(), ultimo_sucesso: new Date().toISOString(), registros: cursor.total }], 'marketplace,conta_id,recurso').catch(() => {});
}

module.exports = { contar, ehLimite, marcarLimite, limiteAtingido, gravar };
