// ============================================================
// GLR Consultoria — Agente de Qualidade de Anúncio
// ------------------------------------------------------------
// Roda 1x por dia por loja (sincronizador, depois das 06:00), em cima do mural
// de Estoque e Margem, e grava em glr_sync_estado, recurso 'qualidade':
//  • Mercado Livre (os que mais vendem, em rodízio de ~25 por dia; cada
//    anúncio é revisto a cada 3 dias):
//      - experiência de compra (nota 0–100, causa e o remédio que o ML indica;
//        nota baixa tira exposição e o ML pode pausar o anúncio sozinho);
//      - qualidade do anúncio (pendências: fotos, vídeo, ficha técnica, GTIN…);
//      - conversão = unidades vendidas ÷ visitas em 30 dias, comparada com a
//        mediana da própria conta.
//  • Shopee: diagnóstico de conteúdo (nível e o que falta) dos que mais vendem.
// Colaboração: anúncio com experiência ruim, pausado/congelado pelo ML, ou com
// muita visita e pouca venda → os agentes de ADS não aceleram (pagar clique
// para um anúncio que não converte só aumenta o ACOS). O conserto é no anúncio.
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

const POR_DIA_ML = 25, REVER_DIAS = 3, MAX_SHOPEE = 96;
const VISITAS_MIN = 300;   // abaixo disso a conversão ainda não diz nada
const r1 = v => Math.round(v * 10) / 10;
const corta = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const SUGESTAO_SH = { 'Add video': 'Adicionar vídeo', 'Add brand info': 'Informar a marca', 'Add more images': 'Adicionar mais fotos', 'Add size chart': 'Adicionar tabela de medidas', 'Improve product name': 'Melhorar o título', 'Add attributes': 'Preencher as características', 'Improve description': 'Melhorar a descrição', 'Add variation image': 'Foto em cada variação', 'Add GTIN': 'Informar o GTIN (código de barras)' };
const NIVEL_SH = { 1: 'precisa melhorar', 2: 'qualificado', 3: 'excelente' };

async function mapLimit(lista, lim, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(lim, lista.length) }, async () => { while (i < lista.length) { const k = i++; await fn(lista[k], k); } }));
}
const mediana = a => { const s = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

async function qualidadeML(ctx, conta, sinais, ant) {
  const { mcpCall, apiKey, prazo } = ctx;
  const itensAnt = ant?.itens || {};
  const base = Object.entries(sinais.itens || {}).map(([id, x]) => ({ id, ...x })).sort((a, b) => b.vd * b.p - a.vd * a.p);
  const vencido = id => !itensAnt[id]?.em || Date.now() - itensAnt[id].em > REVER_DIAS * 864e5;
  const fila = base.filter(x => vencido(x.id)).slice(0, POR_DIA_ML);
  const itens = {};
  for (const x of base) if (itensAnt[x.id]) itens[x.id] = { ...itensAnt[x.id], n: x.n, u30: x.u30 }; // mantém o que ainda vale
  await mapLimit(fila, 5, async x => {
    if (Date.now() > prazo) return;
    const [pe, pf, vi] = await Promise.all([
      mcpCall(apiKey, 'ml_purchase_experience', { meliUserId: conta, item_id: x.id }).catch(() => null),
      mcpCall(apiKey, 'ml_item_performance', { meliUserId: conta, item_id: x.id }).catch(() => null),
      mcpCall(apiKey, 'ml_visits_item', { meliUserId: conta, item_id: x.id, days: 30 }).catch(() => null),
    ]);
    const e = pe?.data?.nota != null ? pe.data : pe;
    const p = pf?.data?.score != null ? pf.data : pf;
    const v = vi?.data?.total_visits != null ? vi.data : vi;
    const pend = [];
    for (const b of p?.buckets || []) for (const va of b.variables || []) if (va.status === 'PENDING' && va.title) pend.push(corta(va.title, 90));
    const vis = v?.total_visits != null ? parseInt(v.total_visits) || 0 : null;
    itens[x.id] = {
      n: x.n, u30: x.u30, em: Date.now(),
      nota: e?.nota ?? null, nivelExp: e?.nivel || null, pausado: !!e?.pausado_pelo_mercado_livre, congelado: !!e?.congelado,
      causa: e?.causa ? corta(e.causa, 160) : null, remedio: e?.remedio ? corta(e.remedio, 220) : null, reclamacoes: e?.reclamacoes ?? null,
      score: p?.score ?? null, nivelAnuncio: p?.level_wording || p?.level || null, pend: pend.slice(0, 6),
      vis, conv: vis && vis > 0 ? r1(x.u30 / vis * 100) : null,
    };
  });
  // conversão comparada com a mediana da própria conta (só quem tem visita suficiente)
  const med = mediana(Object.values(itens).filter(i => (i.vis || 0) >= VISITAS_MIN).map(i => i.conv));
  for (const i of Object.values(itens)) {
    const motivos = [];
    if (i.pausado || i.congelado) motivos.push(i.pausado ? 'pausado pelo Mercado Livre' : 'congelado pelo Mercado Livre');
    if (i.nota != null && i.nota < 50) motivos.push(`experiência de compra ${i.nota}/100${i.causa ? ` (${i.causa})` : ''}`);
    if (med != null && (i.vis || 0) >= VISITAS_MIN && i.conv != null && i.conv < med * 0.4) motivos.push(`conversão de ${String(i.conv).replace('.', ',')}% com ${i.vis} visitas (a conta converte ${String(r1(med)).replace('.', ',')}%)`);
    i.qa = motivos.length ? motivos.join('; ') : null;
    i.nivel = i.qa ? 'ruim' : (i.nota != null && i.nota < 70) || (i.score != null && i.score < 70) || (i.pend || []).length >= 3 ? 'melhorar' : 'ok';
  }
  return { itens, mediana_conversao: med == null ? null : r1(med), revistos: fila.length };
}

async function qualidadeShopee(ctx, conta, sinais) {
  const { mcpCall, apiKey, prazo } = ctx;
  const base = Object.entries(sinais.itens || {}).map(([id, x]) => ({ id, ...x })).sort((a, b) => b.vd * b.p - a.vd * a.p).slice(0, MAX_SHOPEE);
  const itens = {};
  for (let i = 0; i < base.length && Date.now() < prazo; i += 48) {
    const lote = base.slice(i, i + 48);
    const r = await mcpCall(apiKey, 'shopee_get_item_content_diagnosis_result', { shopId: conta, item_id_list: lote.map(x => Number(x.id)) }).catch(() => null);
    const res = new Map((r?.data?.response?.success_item_list || r?.response?.success_item_list || []).map(d => [String(d.item_id), d]));
    for (const x of lote) {
      const d = res.get(x.id); if (!d) continue;
      const pend = (d.unfinished_task || []).map(t => SUGESTAO_SH[t.suggestion] || t.suggestion).filter(Boolean);
      const lvl = parseInt(d.quality_level) || null;
      itens[x.id] = { n: x.n, u30: x.u30, em: Date.now(), nivelConteudo: lvl, nivelTxt: NIVEL_SH[lvl] || null, pend,
        qa: lvl === 1 ? `conteúdo do anúncio "${NIVEL_SH[1]}" na Shopee${pend.length ? ` (${pend.slice(0, 2).join(', ')})` : ''}` : null };
      itens[x.id].nivel = itens[x.id].qa ? 'ruim' : pend.length ? 'melhorar' : 'ok';
    }
  }
  return { itens, revistos: Object.keys(itens).length };
}

// ctx: { mcpCall, apiKey, prazo }; sinais: mural de Estoque e Margem; ant: cursor anterior
async function calcularQualidade(ctx, mkt, conta, sinais, ant) {
  const r = mkt === 'ml' ? await qualidadeML(ctx, conta, sinais, ant) : await qualidadeShopee(ctx, conta, sinais);
  const lista = Object.entries(r.itens).map(([id, x]) => ({ id, ...x }));
  const resumo = {
    analisados: lista.length, revistosHoje: r.revistos, ruins: lista.filter(x => x.nivel === 'ruim').length, melhorar: lista.filter(x => x.nivel === 'melhorar').length,
    pausados: lista.filter(x => x.pausado || x.congelado).length, convBaixa: lista.filter(x => /conversão/.test(x.qa || '')).length,
    expRuim: lista.filter(x => x.nota != null && x.nota < 50).length,
  };
  // pendência mais comum = problema de operação, não de um anúncio
  const cont = {};
  lista.forEach(x => (x.pend || []).forEach(p => { cont[p] = (cont[p] || 0) + 1; }));
  const comuns = Object.entries(cont).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => ({ t, n }));
  const destaques = { ruins: lista.filter(x => x.nivel === 'ruim').sort((a, b) => (b.u30 || 0) - (a.u30 || 0)).slice(0, 3).map(x => ({ n: x.n, qa: x.qa })), comuns };
  return { em: Date.now(), dia: new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), mkt, conta, mediana_conversao: r.mediana_conversao ?? null, itens: r.itens, resumo, destaques };
}

module.exports = { calcularQualidade };
