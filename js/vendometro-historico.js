// Leitura histórica sob demanda. Usa o proxy autenticado; não altera pedidos na origem.
const VendometroHistorico = (() => {
  const DIA = 86400000;
  function janela(dia) {
    const inicio = Date.parse(`${dia}T00:00:00-03:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || !Number.isFinite(inicio) || new Date(inicio - 10800000).toISOString().slice(0, 10) !== dia) throw Error('Data inválida.');
    return { inicio, fim: inicio + DIA };
  }
  async function buscar(call, conta, dia, ativo = () => true) {
    const { inicio, fim } = janela(dia), porId = new Map();
    const consultar = async (acao, params) => {
      if (!ativo()) throw Error('Consulta substituída.');
      const r = await call(acao, params);
      if (!ativo()) throw Error('Consulta substituída.');
      const d = r?.data?.response || r?.response || r?.data || r;
      if (!d || d.error || d.error_code) throw Error('O conector não disponibilizou esse histórico.');
      return d;
    };
    function guardar(id, criado, valor, itens, valido) {
      const ts = new Date(criado).getTime();
      if (!id || !Number.isFinite(ts)) throw Error('Pedido histórico sem identificação ou data.');
      if (ts < inicio || ts >= fim || !valido) return;
      porId.set(String(id), { marketplace: conta.mkt, conta_id: String(conta.id), pedido_id: String(id), criado_em: new Date(ts).toISOString(), situacao: 'valido', valor_bruto: valor, itens });
    }
    if (conta.mkt === 'ml') {
      for (let pagina = 0; pagina < 200; pagina++) {
        const d = await consultar('list_orders_detail', { meliUserId: conta.id, date_from: dia, date_to: dia, limit: 50, offset: pagina * 50 });
        if (!Array.isArray(d.results)) throw Error('O conector retornou um histórico incompleto.');
        for (const o of d.results) {
          const status = String(o.status || '').toLowerCase();
          const estorno = status === 'partially_refunded' ? (o.payments || []).reduce((s, p) => s + (Number(p.transaction_amount_refunded) || 0), 0) : 0;
          guardar(o.id, o.date_created, Math.max(0, (Number(o.total_amount) || 0) - estorno), (o.order_items || []).map(i => ({ qtd: Number(i.quantity) || 1 })), !/cancel|invalid|^refunded$/.test(status));
        }
        const total = Number(d.paging?.total);
        if (total > pagina * 50 + d.results.length && d.results.length < 50) throw Error('Página histórica incompleta.');
        if (d.results.length < 50 || (total > 0 && (pagina + 1) * 50 >= total)) return [...porId.values()];
      }
      throw Error('Histórico excedeu o limite de paginação; comparação incompleta.');
    }
    if (conta.mkt !== 'shopee') throw Error('Histórico dessa plataforma ainda não está disponível para essa data.');
    const sns = new Set();
    async function listar(status) {
      let cursor = ''; const cursores = new Set();
      for (let pagina = 0; pagina < 200; pagina++) {
        const params = { shopId: conta.id, time_range_field: 'create_time', time_from: inicio / 1000, time_to: fim / 1000 - 1, page_size: 100 };
        if (status) params.order_status = status;
        if (cursor) params.cursor = cursor;
        const d = await consultar('shopee_list_orders', params);
        if (!Array.isArray(d.order_list)) throw Error('O conector retornou um histórico incompleto.');
        for (const o of d.order_list) { if (!o.order_sn) throw Error('Pedido sem identificação.'); sns.add(String(o.order_sn)); }
        if (!d.more) return;
        if (!d.next_cursor || cursores.has(d.next_cursor)) throw Error('Paginação histórica incompleta.');
        cursor = d.next_cursor; cursores.add(cursor);
      }
      throw Error('Histórico excedeu o limite de paginação.');
    }
    try { await listar(null); }
    catch (e) {
      if (!/order_status|status.*required|status.*obrigat/i.test(e.message)) throw e;
      sns.clear();
      for (const status of ['READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED', 'INVOICE_PENDING', 'TO_RETURN', 'IN_CANCEL', 'CANCELLED']) await listar(status);
    }
    const ids = [...sns];
    for (let i = 0; i < ids.length; i += 50) {
      const lote = ids.slice(i, i + 50);
      const d = await consultar('shopee_get_order_detail', { shopId: conta.id, order_sn_list: lote, response_optional_fields: 'total_amount,item_list,order_status' });
      if (!Array.isArray(d.order_list)) throw Error('Detalhes históricos incompletos.');
      const recebidos = new Set(d.order_list.map(o => String(o.order_sn)));
      if (lote.some(id => !recebidos.has(id))) throw Error('Faltam detalhes de pedidos históricos.');
      for (const o of d.order_list) {
        const itens = (o.item_list || []).map(i => ({ qtd: Number(i.model_quantity_purchased) || 1, preco: Number(i.model_discounted_price) || 0 }));
        const subtotal = itens.reduce((s, i) => s + i.qtd * i.preco, 0);
        guardar(o.order_sn, Number(o.create_time) * 1000, subtotal > 0 ? subtotal : Number(o.total_amount) || 0, itens, !/CANCEL|UNPAID|TO_RETURN|RETURNED/i.test(o.order_status || ''));
      }
    }
    return [...porId.values()];
  }
  return { buscar };
})();
if (typeof module !== 'undefined') module.exports = VendometroHistorico;
