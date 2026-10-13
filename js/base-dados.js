// ============================================================
// GLR Consultoria — Base sincronizada (leitura compartilhada pelas telas)
// ------------------------------------------------------------
// O motor do servidor (api/sync-dados.js) grava a cada 15 min, por loja
// Shopee e Mercado Livre, um resumo por dia (pedidos, faturamento válido,
// unidades, cancelados, devolvidos, líquido) em glr_sync_estado, recurso
// "resumo". As telas leem daqui em vez de buscar pedido a pedido na API.
//
// Regra = a mesma da tela de Vendas: faturamento válido sem cancelados e sem
// devoluções aceitas. Uma loja só é usada para um período se o histórico dela
// já cobre o início desse período (senão a tela cai na busca antiga pela API).
//
// Quando uma sincronização termina, o Supabase avisa em tempo real e as telas
// recebem o evento "glr-base-atualizada" para se redesenhar sozinhas.
// ============================================================
const BaseDados = (() => {
  const TTL_MS = 60 * 1000;
  let cache = null, cacheEm = 0, emAndamento = null, avisoTimer = null, canal = null;

  const mktDe = m => { m = String(m || '').toLowerCase(); return m === 'shopee' ? 'shopee' : ['meli', 'ml', 'mercadolivre'].includes(m) ? 'ml' : null; };
  const chave = (mkt, id) => `${mktDe(mkt)}:${id}`;
  const inicioDiaBRT = iso => new Date(`${iso}T00:00:00-03:00`).getTime() / 1000;

  // { "shopee:123": { dias: {AAAA-MM-DD: {...}}, historicoAte (unix), ultimoSucesso, erro, resumoEm } }
  async function carregar(forcar = false) {
    if (!forcar && cache && Date.now() - cacheEm < TTL_MS) return cache;
    if (emAndamento) return emAndamento;
    emAndamento = (async () => {
      const [res, ped] = await Promise.all([
        _sb.from('glr_sync_estado').select('marketplace,conta_id,cursor,ultimo_sucesso').eq('recurso', 'resumo'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,cursor,ultimo_sucesso,ultimo_erro').eq('recurso', 'pedidos'),
      ]);
      if (res.error) throw res.error;
      if (ped.error) throw ped.error;
      const mapa = {};
      for (const e of (ped.data || [])) {
        mapa[`${e.marketplace}:${e.conta_id}`] = { dias: {}, historicoAte: e.cursor?.historico_ate || null, ultimoSucesso: e.ultimo_sucesso, erro: e.ultimo_erro || null };
      }
      for (const e of (res.data || [])) {
        const k = `${e.marketplace}:${e.conta_id}`;
        mapa[k] = mapa[k] || { historicoAte: null };
        mapa[k].dias = e.cursor?.dias || {};
        mapa[k].resumoEm = e.ultimo_sucesso;
      }
      cache = mapa; cacheEm = Date.now();
      return mapa;
    })().finally(() => { emAndamento = null; });
    return emAndamento;
  }

  // A loja tem na base TODOS os pedidos a partir do dia `desdeIso`?
  function cobre(info, desdeIso) {
    return !!(info && info.historicoAte && info.resumoEm && info.historicoAte <= inicioDiaBRT(desdeIso));
  }

  // Soma o resumo diário de uma loja entre duas datas (inclusive).
  function somar(info, deIso, ateIso) {
    const t = { pedidos: 0, faturamento: 0, unidades: 0, cancelados: 0, valor_cancelado: 0, devolvidos: 0, valor_devolvido: 0, liquido: 0, com_liquido: 0 };
    for (const [dia, v] of Object.entries(info?.dias || {})) {
      if (dia < deIso || dia > ateIso) continue;
      for (const c of Object.keys(t)) t[c] += parseFloat(v[c]) || 0;
    }
    return t;
  }

  function invalidar() { cache = null; }

  function iniciarTempoReal() {
    if (canal || typeof _sb === 'undefined') return;
    canal = _sb.channel('glr_base_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'glr_sync_estado' }, () => {
        cache = null;
        // várias lojas terminam em sequência numa rodada — avisa uma vez só
        clearTimeout(avisoTimer);
        avisoTimer = setTimeout(() => window.dispatchEvent(new CustomEvent('glr-base-atualizada')), 20000);
      })
      .subscribe();
  }

  return { carregar, cobre, somar, invalidar, iniciarTempoReal, mktDe, chave };
})();
window.BaseDados = BaseDados;
BaseDados.iniciarTempoReal();
