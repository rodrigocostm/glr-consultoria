// ============================================================
// GLR Consultoria — Analista GLR: módulo único de margem/lucro
// ============================================================
// Substitui as 3 implementações divergentes que existiam (js/pages-vendas.js
// calcLucro, js/pages-financeiro.js lucroPlat, js/pages-dre.js getAutoData) —
// mesma fórmula validada, um lugar só. Fundação do Decision Engine do
// Analista GLR (módulo de Rentabilidade cruza com Ads/Estoque em cima disto).
//
// Fórmula (idêntica à que já era usada em pages-vendas.js, só extraída):
// - líquido: vem da API quando disponível (Shopee escrow_amount, ML
//   net_received_amount); Magalu não devolve líquido pronto, calcula
//   receita - comissão - frete.
// - custo: manual por pedido (glr_vendas_custos) tem prioridade sobre o
//   catálogo por produto (glr_vendas_custo_catalogo) — cadastro do produto
//   é o fallback que evita relançar custo pedido a pedido.
// - imposto: da API (escrow_tax) quando > 0 (já deduzido do líquido, só
//   exibido); senão manual por pedido ou alíquota da conta (deduzido).
// - frete do ML é subtraído à parte (não vem embutido no net_received_amount
//   como no escrow da Shopee).
// - linhas extras (glr_vendas_linhas) sempre deduzidas, fixas ou % da receita.
window.GLR_Margem = {
  // pedido: { id, plataforma, valor, taxas:{comissao,taxaServico,frete,liquido,imposto}, contaId, itens[], produto }
  // contexto: { custos:{[pedidoId]:{custo,outros,imposto}}, catalogoCusto:{[produtoKey]:custoUnitario},
  //             linhasExt:[{tipo:'pct'|'fixo',valor}], aliquotas:{[contaId]:pct} }
  calcularLucroPedido(p, contexto) {
    const { custos = {}, catalogoCusto = {}, linhasExt = [], aliquotas = {} } = contexto || {};
    const produtoKey = p.itens?.[0]?.itemId || p.produto || '';

    const receita = parseFloat(p.valor) || 0;
    const tx = p.taxas || {};

    let liquido = tx.liquido != null ? parseFloat(tx.liquido) : null;
    if (liquido == null && p.plataforma === 'Magalu' && (tx.comissao || tx.frete)) {
      liquido = receita - (parseFloat(tx.comissao) || 0) - (parseFloat(tx.frete) || 0);
    }

    const c = custos[p.id] || {};
    const custoPedido = parseFloat(c.custo) || 0;
    const custoCatalogo = parseFloat(catalogoCusto[produtoKey]) || 0;
    const custo = custoPedido || custoCatalogo;
    const outros = parseFloat(c.outros) || 0;

    const impAPIRaw = tx.imposto != null ? parseFloat(tx.imposto) : null;
    const impManual = parseFloat(c.imposto) || 0;
    const impAliq = parseFloat(aliquotas[p.contaId] || 0);
    const impPct = impManual || impAliq;
    const impDeEscrow = (impAPIRaw != null && impAPIRaw > 0);
    const impAPI = impDeEscrow ? impAPIRaw : null;
    const impVal = impAPI != null ? impAPI : (receita * impPct / 100);

    let extra = 0;
    for (const l of linhasExt) extra += l.tipo === 'pct' ? receita * (parseFloat(l.valor) || 0) / 100 : (parseFloat(l.valor) || 0);

    const isML = p.plataforma === 'Mercado Livre';
    const freteML = isML ? (parseFloat(tx.frete) || 0) : 0;
    const base = (liquido != null ? liquido : receita) - freteML;
    const lucro = base - custo - impVal - outros - extra;
    const margem = receita > 0 ? (lucro / receita) * 100 : 0;
    const liquidoExibido = liquido != null ? (isML ? liquido - freteML : liquido) : null;

    return {
      receita, liquido: liquidoExibido, liquidoBruto: liquido, custo, custoOrigem: custoPedido ? 'pedido' : (custoCatalogo ? 'catalogo' : 'nenhum'),
      impVal, impPct, outros, extra, lucro, margem,
      comissao: tx.comissao || 0, taxaServico: tx.taxaServico || 0,
      frete: tx.frete || 0, voucher: tx.voucher || 0,
      temCusto: custo > 0,
    };
  },

  // Agrega lucro/margem de uma lista de pedidos — mesmo contexto de
  // calcularLucroPedido, reaproveitado por Financeiro (lucroPlat) e pelo
  // Decision Engine (rentabilidade por conta/SKU).
  calcularLucroLista(pedidos, contexto) {
    let receita = 0, lucro = 0, custo = 0, impVal = 0, extra = 0, outros = 0, comSemCusto = 0;
    for (const p of pedidos) {
      const r = this.calcularLucroPedido(p, contexto);
      receita += r.receita; lucro += r.lucro; custo += r.custo;
      impVal += r.impVal; extra += r.extra; outros += r.outros;
      if (!r.temCusto) comSemCusto++;
    }
    return { receita, lucro, custo, impVal, extra, outros, margem: receita > 0 ? (lucro / receita) * 100 : 0, pedidosSemCusto: comSemCusto, totalPedidos: pedidos.length };
  },
};
