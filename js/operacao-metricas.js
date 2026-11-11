// Filtros e métricas da operação. Trabalha apenas com os dados já carregados.
const GLROperacao = (() => {
  const nomes = { ml: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', tiktok: 'TikTok Shop', magalu: 'Magalu', shein: 'Shein' };
  function gestoresDaConta(id, clientes, gestores, vinculos, configs = []) {
    const idsClientes = new Set();
    for (const [cid, contas] of Object.entries(vinculos || {})) {
      if ((contas || []).some(c => String(c.marketplace).toLowerCase() === 'shopee' &&
        [c.external_id, c.contaId, c.param_to_use?.shopId].some(v => v != null && String(v) === String(id)))) idsClientes.add(String(cid));
    }
    for (const c of configs) if (String(c.conta_id) === String(id) && c.cliente_id != null) idsClientes.add(String(c.cliente_id));
    const encontrados = new Map();
    for (const c of clientes) {
      if (!idsClientes.has(String(c.id))) continue;
      const g = gestores.find(g => c.gestorId != null && String(g.id) === String(c.gestorId)) || gestores.find(g => c.gestor && g.nome === c.gestor);
      if (g) encontrados.set(String(g.id), g);
    }
    return [...encontrados.values()];
  }
  function diario(plataformas, dataBase, infoDe, base, hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10)) {
    if (!plataformas.length || !/^\d{4}-\d{2}-\d{2}$/.test(dataBase || '')) return { grupos: [], dias: [], totais: [] };
    const fim = dataBase < hoje ? dataBase : hoje;
    if (fim.slice(0, 7) !== dataBase.slice(0, 7)) return { grupos: [], dias: [], totais: [] };
    const contas = new Map();
    plataformas.forEach((p, i) => {
      const raw = p.marketplace || p._platNome || p.nome || 'Manual';
      const mkt = base.mktDe(String(raw).toLowerCase().replace(/\s+/g, '')) || String(raw);
      const key = p.contaId ? `${mkt}:${p.contaId}` : `manual:${i}`;
      if (!contas.has(key)) contas.set(key, { p, mkt, info: infoDe(raw, p.contaId) });
    });
    const grupos = [{ id: 'geral', nome: 'Geral' }, ...[...new Set([...contas.values()].map(c => c.mkt))].map(id => ({ id, nome: nomes[id] || id }))];
    const nova = () => ({ fat: 0, ads: 0, n: 0, nFat: 0, nAds: 0 });
    const finalizar = v => ({ ...v, fat: v.nFat ? v.fat : null, ads: v.nAds ? v.ads : null,
      parcialFat: v.nFat > 0 && v.nFat < v.n, parcialAds: v.nAds > 0 && v.nAds < v.n,
      tacos: v.n > 0 && v.nFat === v.n && v.nAds === v.n && v.fat > 0 ? v.ads / v.fat * 100 : null });
    const totais = grupos.map(nova), dias = [];
    for (let d = 1; d <= Number(fim.slice(8)); d++) {
      const iso = `${dataBase.slice(0, 8)}${String(d).padStart(2, '0')}`, valores = grupos.map(nova);
      for (const c of contas.values()) {
        const fatOk = base.cobre(c.info, iso), adsOk = !!c.info && base.cobreAds(c.info, iso);
        const t = c.info?.dias?.[iso] || {};
        for (const index of [0, grupos.findIndex(g => g.id === c.mkt)]) {
          const v = valores[index]; v.n++;
          if (fatOk) { v.nFat++; v.fat += Number(t.faturamento) || 0; }
          if (adsOk) { v.nAds++; v.ads += Number(t.ads) || 0; }
        }
      }
      valores.forEach((v, i) => { for (const k of Object.keys(v)) totais[i][k] += v[k]; });
      dias.push({ iso, valores: valores.map(finalizar) });
    }
    return { grupos, dias, totais: totais.map(finalizar) };
  }
  return { gestoresDaConta, diario };
})();
window.GLROperacao = GLROperacao;
