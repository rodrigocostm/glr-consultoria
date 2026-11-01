// Shared deterministic adapter: no external calls and no invented metrics.
(function(root) {
  function build(plan, candidates) {
    const source = candidates || plan.oportunidades || plan.acoes || [];
    const seen = new Set();
    return (Array.isArray(source) ? source : []).filter(a => a && typeof a.id === 'string' && !seen.has(a.id) && seen.add(a.id))
      .map(a => {
        const drop = (plan.raioX?.caiu || []).find(x => a.id === `fat:${x.conta}:${x.id}`);
        const conversion = [...(plan.raioX?.oportunidades?.semConversao || []), ...(plan.raioX?.oportunidades?.poucaVisita || [])]
          .find(x => a.id === `conv:${x.conta}:${x.id}` || a.id === `exp:${x.conta}:${x.id}`);
        const evidence = drop ? `Faturamento semanal: R$ ${drop.antes} antes e R$ ${drop.agora} agora; perda observada: R$ ${drop.perdaSem}/semana.`
          : conversion ? `${conversion.v7 ?? 'não informado'} visitas/semana; conversão: ${conversion.conv == null ? 'não informada' : Number(conversion.conv).toFixed(2) + '%'}.`
          : a.porque || 'Sem evidência detalhada neste plano.';
        const hypothesis = drop ? (drop.causas || []).map(x => x.t).join('; ') || 'Causa ainda não identificada.'
          : a.tipo === 'funil' ? 'Melhorar conversão ou exposição pode recuperar vendas; validar com um teste.'
          : 'O efeito da ação deve ser validado após a execução.';
        const missing = [];
        if (!plan.raioX?.periodo && ['funil', 'faturamento'].includes(a.tipo)) missing.push('Período comparável');
        if (a.tipo === 'funil' || a.tipo === 'ads' || a.tipo === 'promocoes' || a.tipo === 'meta') missing.push('Confirmar estoque e margem atual antes de acelerar');
        if (a.tipo === 'margem') missing.push('Conferir custo, taxas, imposto, frete e Ads por produto');
        const amount = a.valor != null && Number.isFinite(Number(a.valor)) && Number(a.valor) > 0 ? Number(a.valor) : null;
        return { ...a, evidencia: evidence, hipotese: hypothesis, faltantes: missing,
          confianca: drop ? 'média' : conversion ? 'média' : 'a validar',
          impactoValor: amount, impactoNatureza: drop ? 'Perda observada; recuperação não garantida' : 'Estimativa; ganho não garantido',
          responsavel: a.quem === 'cliente' ? 'Cliente' : plan.cliente?.gestor || 'Definir responsável' };
      }).sort((a,b) => (Number(b.peso)||0) - (Number(a.peso)||0) || a.id.localeCompare(b.id)).slice(0,40);
  }
  const api = { build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GLRPlanoOportunidades = api;
})(typeof window !== 'undefined' ? window : null);
