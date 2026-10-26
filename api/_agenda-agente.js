// ============================================================
// GLR Consultoria — Agenda das rodadas automáticas do Agente
// ------------------------------------------------------------
// Arquivo com "_" na frente: a Vercel não publica como rota, só é importado
// por api/sync-dados.js (que dispara as rodadas — ele já roda a cada 15 min
// pelo agendador do Supabase) e por api/agente-cron.js (que executa).
//
// 07:00  revisão completa do dia anterior (regras de pausa/orçamento/ROAS +
//        relatório diário com IA)
// demais acompanhamento do dia em andamento (orçamento esgotando cedo,
//        gasto sem venda hoje, ritmo de vendas do dia) — não refaz as regras
//        da manhã, então nada é ajustado duas vezes pelo mesmo motivo
// Horários em Brasília. A tela do Agente mostra a mesma agenda.
// ============================================================
const AGENDA_AGENTE = [
  { hora: 7, tipo: 'completa' },
  { hora: 8, tipo: 'gerente' }, // Gerente de Conta: plano do dia por cliente (depois da revisão dos ADS)
  { hora: 12, tipo: 'acompanhamento' },
  { hora: 16, tipo: 'acompanhamento' },
  { hora: 20, tipo: 'acompanhamento' },
];

function agoraBRT() {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  return { dia: d.toISOString().slice(0, 10), hora: d.getUTCHours(), minuto: d.getUTCMinutes() };
}

module.exports = { AGENDA_AGENTE, agoraBRT };
