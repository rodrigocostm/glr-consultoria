// ============================================================
// GLR Consultoria — Medição de resultado das ações de ADS
// ------------------------------------------------------------
// Mesma régua para o agente do Mercado Livre (copiloto) e o da Shopee
// (executa sozinho): a campanha nos 7 dias ANTES do dia aplicado × os 7 dias
// DEPOIS. O dia da aplicação fica fora das duas janelas.
//  • conter (subir ROAS objetivo, cortar orçamento, tirar/mover produto):
//    melhorou = ACOS caiu ≥10% sem perder mais de 30% das vendas/dia;
//  • acelerar (baixar ROAS objetivo, subir orçamento, colocar produto, retomar):
//    melhorou = vendas/dia subiram ≥10% com ACOS dentro da meta (ou ≤ +10% do antes);
//  • pausar: melhorou = o gasto parou (economia por semana).
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

const r1 = v => Math.round(v * 10) / 10;
const pctTxt = v => v == null ? '—' : v === Infinity ? '∞' : `${String(r1(v)).replace('.', ',')}%`;

// ACOS: sem gasto = 0; gasto sem venda = ∞ (guardado como semVenda — JSON não tem Infinity)
function metricas(gasto, vendas, dias = 7) {
  return { gastoDia: r1(gasto / dias), vendasDia: r1(vendas / dias), acos: gasto <= 0 ? 0 : vendas > 0 ? r1(gasto / vendas * 100) : null, semVenda: gasto > 0 && vendas <= 0 };
}

// tipo: 'pausar' | 'conter' | 'acelerar'; a/b: metricas() antes/depois; meta: ACOS meta (%)
function avaliar(tipo, a, b, meta, R$) {
  if (!a || !b || (a.gastoDia <= 0 && b.gastoDia <= 0)) return { veredito: 'sem_dados', resumo: 'campanha sem dados de ADS nas duas semanas' };
  const acosA = a.semVenda ? Infinity : a.acos, acosB = b.semVenda ? Infinity : b.acos;
  const vend = `vendas/dia ${R$(a.vendasDia)} → ${R$(b.vendasDia)}`;
  if (tipo === 'pausar') {
    return { veredito: b.gastoDia < a.gastoDia * 0.2 ? 'melhorou' : 'neutro', resumo: `deixou de gastar ~${R$(Math.max(0, a.gastoDia - b.gastoDia) * 7)}/semana` };
  }
  if (tipo === 'conter') {
    const acosOk = acosA === Infinity ? acosB !== Infinity : acosB <= acosA * 0.9;
    const veredito = acosOk && b.vendasDia >= a.vendasDia * 0.7 ? 'melhorou'
      : (acosB > acosA * 1.05 || b.vendasDia < a.vendasDia * 0.5) ? 'piorou' : 'neutro';
    return { veredito, resumo: `ACOS ${pctTxt(acosA)} → ${pctTxt(acosB)} · ${vend}` };
  }
  const dentro = meta ? acosB <= meta * 1.1 : acosB <= acosA * 1.1;
  const veredito = b.vendasDia >= a.vendasDia * 1.1 && dentro ? 'melhorou'
    : (b.vendasDia < a.vendasDia * 0.95 || (meta && acosB > meta * 1.3)) ? 'piorou' : 'neutro';
  return { veredito, resumo: `${vend} · ACOS ${pctTxt(acosA)} → ${pctTxt(acosB)}` };
}

module.exports = { metricas, avaliar, pctTxt };
