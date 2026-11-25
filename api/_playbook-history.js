// Read existing ADS evidence without creating duplicate interventions.
const CHANNEL = { ml: 'mercado-livre', shopee: 'shopee', 'mercado-livre': 'mercado-livre' };
const ACTIONS = new Set(['roas_target','acos_target','orcamento','pausar','retomar','retirar_produto','mover_produto','adicionar_produto']);
function normalize(logs, accounts) {
  const seen = new Set(), out = [];
  for (const log of logs) {
    const d = log.dados || {};
    if (log.id == null || seen.has(String(log.id))) continue;
    const action = d.acao || (d.budget_para != null ? 'orcamento' : d.roas_para != null ? 'roas_target' : d.pausar ? 'pausar' : d.retomada ? 'retomar' : null);
    if (!action || !ACTIONS.has(action) || !['decisao','alerta'].includes(log.tipo)) continue;
    const channel = CHANNEL[d.marketplace];
    const candidates = accounts.filter(a => a.key.slice(a.key.indexOf(':') + 1) === String(log.conta_id) && (!channel || a.marketplace === channel));
    // Never guess a platform or client when account identifiers are ambiguous.
    if (candidates.length !== 1) continue;
    const account = candidates[0], executed = log.resultado === 'executado';
    let executor = 'nao_confirmado';
    if (executed && d.aplicado_por !== 'detectado') {
      if (['agente','extensao_auto'].includes(d.aplicado_por)) executor = 'ia';
      else if (log.origem === 'analista' || d.aplicado_por === 'extensao') executor = 'humano';
      else if (account.marketplace === 'shopee' && log.origem === 'cron' && log.tipo === 'decisao') executor = 'ia';
    }
    seen.add(String(log.id));
    out.push({
      id: 'ads:' + log.id, fonte: 'glr_agente_log', fonte_id: String(log.id),
      cliente_id: account.cliente_id, gestor_id: account.gestor_id, conta: account.key,
      marketplace: account.marketplace, titulo: log.titulo || action, descricao: log.explicacao || '',
      acao: action, status: executed ? 'executada' : log.resultado === 'so_alerta' ? 'sugerida' : log.resultado,
      executor, autor_id: null, sugestor: log.origem === 'cron' && log.tipo === 'alerta' ? 'ia' : 'nao_confirmado',
      criado_em: log.criado_em, executado_em: executed && d.aplicado_por !== 'detectado' ? (d.aplicado_em || log.criado_em) : null,
      detectado_em: d.aplicado_por === 'detectado' ? d.aplicado_em || null : null,
      antes: d.de ?? d.budget_de ?? d.roas_de ?? null, depois: d.para ?? d.budget_para ?? d.roas_para ?? null,
      campanha_id: d.campaign_id ?? null, medicao: executed ? d.medicao || null : null,
    });
  }
  return out;
}
async function history(ctx, read) {
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  try {
    const rows = await read('glr_agente_log?tipo=in.(decisao,alerta)&select=id,conta_id,tipo,titulo,explicacao,dados,resultado,origem,criado_em&criado_em=gte.' + encodeURIComponent(since) + '&order=criado_em.desc,id', 30000);
    return { acoes_ads: normalize(rows, ctx.contas), historico_ads: { disponivel: true, dias: 90 } };
  } catch (_) {
    return { acoes_ads: [], historico_ads: { disponivel: false, dias: 90, aviso: 'Histórico de Ads indisponível. Os registros do Playbook continuam disponíveis; tente atualizar.' } };
  }
}
module.exports = { normalize, history };
