// Cron: verifica vendas novas (ML + Shopee) em todas as contas conectadas
// e dispara notificação push pros dispositivos inscritos.
// Agendado via vercel.json (crons).

const webpush = require('web-push');

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJyb2RxbGVqcXlhb29tdXRyaWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjU5NjUsImV4cCI6MjA5NjQ0MTk2NX0.JaKQHoGH8S3ZdLQInLErpC21SZ0j4FmIGtvWKcBes-A';

async function sbGet(chave) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?chave=eq.${encodeURIComponent(chave)}&select=dados`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0]?.dados ?? null;
}

async function sbSet(chave, dados) {
  await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?on_conflict=chave`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ chave, dados, atualizado_em: new Date().toISOString() }),
  });
}

async function mcpCall(apiKey, action, params) {
  const r = await fetch('https://mcp.tiops.com.br', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ action, params: params || {} }),
  });
  return r.json();
}

const R$ = v => 'R$ ' + (parseFloat(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

module.exports = async function handler(req, res) {
  // Protege o endpoint: só a Vercel Cron (header automático) ou quem tiver o CRON_SECRET
  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'];
  const isVercelCron = !!req.headers['x-vercel-cron'] || !!req.headers['x-vercel-cron-signature'];
  if (secret && !isVercelCron && auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return res.status(500).json({ error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY não configuradas no ambiente' });
  webpush.setVapidDetails('mailto:contatoconsultoriaglr@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

  try {
    const apiKey = await sbGet('glr_mc_apikey');
    if (!apiKey) return res.status(200).json({ ok: true, skip: 'sem API key configurada em Integrações' });

    const contasResp = await mcpCall(apiKey, 'list_accounts', {});
    const contas = contasResp.data?.accounts || contasResp.data || [];

    const aliquotas = (await sbGet('glr_aliquotas')) || {};
    const vistos = (await sbGet('glr_push_vendas_vistas')) || {};

    const pad = n => String(n).padStart(2, '0');
    const hoje = new Date();
    const dataHoje = `${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}-${pad(hoje.getDate())}`;
    const tsInicioHoje = Math.floor(new Date(`${dataHoje}T00:00:00`).getTime()/1000);
    const tsAgora = Math.floor(Date.now()/1000);

    const novasVendas = [];

    for (const conta of contas) {
      const mkt = (conta.marketplace||'').toLowerCase();
      const extId = conta.external_id;
      const jaTinhaHistorico = Array.isArray(vistos[extId]) && vistos[extId].length > 0;
      const vistosConta = new Set(vistos[extId] || []);
      const label = conta.nickname || extId;

      try {
        if (['meli','ml','mercadolivre'].includes(mkt)) {
          const meliId = conta.param_to_use?.meliUserId || extId;
          const r = await mcpCall(apiKey, 'list_orders_detail', { meliUserId: meliId, date_from: dataHoje, date_to: dataHoje, limit: 50, offset: 0 });
          const orders = r.data?.results || [];
          for (const o of orders) {
            const id = String(o.id);
            if (vistosConta.has(id)) continue;
            vistosConta.add(id);
            if (!jaTinhaHistorico) continue; // primeira vez vendo esta conta: só cria a base, não notifica o histórico do dia
            if (['cancelled','invalid'].includes((o.status||'').toLowerCase())) continue;
            const total = parseFloat(o.total_amount) || 0;
            const comissao = (o.order_items||[]).reduce((s,i)=>s+(parseFloat(i.sale_fee)||0), 0);
            const aliq = parseFloat(aliquotas[extId]||0);
            const imposto = total * aliq / 100;
            const lucro = total - comissao - imposto;
            const margem = total>0 ? (lucro/total)*100 : 0;
            novasVendas.push({ marketplace: 'Mercado Livre', conta: label, total, margem, lucro });
          }
        } else if (mkt === 'shopee') {
          const shopId = conta.param_to_use?.shopId || extId;
          const rl = await mcpCall(apiKey, 'shopee_list_orders', { shopId, time_range_field: 'create_time', time_from: tsInicioHoje, time_to: tsAgora, page_size: 100, order_status: 'COMPLETED' });
          const lista = rl.data?.response?.order_list || [];
          const novos = lista.filter(o => !vistosConta.has(o.order_sn));
          for (const o of lista) vistosConta.add(o.order_sn);

          if (novos.length && jaTinhaHistorico) {
            const sns = novos.map(o=>o.order_sn).slice(0, 50);
            const rd = await mcpCall(apiKey, 'shopee_get_order_detail', { shopId, order_sn_list: sns });
            const orderList = rd.data?.response?.order_list || rd.data?.order_list || [];
            for (const ord of orderList) {
              const items = ord.item_list || ord.items || [];
              const total = items.reduce((s,it) => {
                const p = parseFloat(it.model_discounted_price)||parseFloat(it.item_price)||0;
                const q = parseInt(it.model_quantity_purchased)||parseInt(it.quantity)||1;
                return s + p*q;
              }, 0) || parseFloat(ord.total_amount)||0;
              const aliq = parseFloat(aliquotas[extId]||0);
              const imposto = total * aliq / 100;
              // Estimativa: comissão+taxa de serviço Shopee típica (~14%) — sem chamada extra de escrow
              // por venda, pra manter o cron rápido. Não é o cálculo exato usado no Financeiro.
              const comissaoEstimada = total * 0.14;
              const lucro = total - comissaoEstimada - imposto;
              const margem = total>0 ? (lucro/total)*100 : 0;
              novasVendas.push({ marketplace: 'Shopee', conta: label, total, margem, lucro });
            }
          }
        }
      } catch(e) {
        console.warn('[push-cron] erro conta', label, e.message);
      }

      // Mantém só os últimos 500 ids por conta, pra não crescer sem limite
      vistos[extId] = [...vistosConta].slice(-500);
    }

    await sbSet('glr_push_vendas_vistas', vistos);

    if (!novasVendas.length) return res.status(200).json({ ok: true, novasVendas: 0 });

    const subsResp = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const subs = await subsResp.json();

    let enviados = 0;
    for (const venda of novasVendas) {
      const payload = JSON.stringify({
        title: `🟢 Nova venda realizada! (${venda.marketplace})`,
        body: `${venda.conta}\nTotal: ${R$(venda.total)}\nMargem: ${venda.margem.toFixed(2)}%*\nLucro: ${R$(venda.lucro)}*\n*estimativa sem custo de produto`,
        url: '/index.html',
        tag: 'venda',
      });
      for (const s of subs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          enviados++;
        } catch(e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, {
              method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
            }).catch(()=>{});
          } else {
            console.warn('[push-cron] erro ao enviar push:', e.message);
          }
        }
      }
    }

    return res.status(200).json({ ok: true, novasVendas: novasVendas.length, dispositivos: subs.length, enviados });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
