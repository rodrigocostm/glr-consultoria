// Cron: escaneia o preço dos anúncios ativos de TODAS as contas (ML + Shopee)
// automaticamente, sem precisar de watchlist manual, compara com o preço do
// dia anterior e dispara notificação push quando muda algo.
// Agendado via vercel.json (crons). Mesmo padrão do push-cron.js (vendas novas).
//
// Escopo: primeiros 100 anúncios ativos por conta ML, 50 por conta Shopee —
// cap deliberado pra manter o cron rápido/barato; não escaneia catálogos
// inteiros. Se precisar de mais cobertura, dá pra paginar depois.

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
const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

module.exports = async function handler(req, res) {
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

    const snap = (await sbGet('glr_track_precos_snap_auto')) || {};
    const logArr = (await sbGet('glr_track_precos_log')) || [];
    const mudancas = [];

    for (const conta of contas) {
      const mkt = (conta.marketplace||'').toLowerCase();
      const extId = conta.external_id;
      const label = conta.nickname || extId;

      try {
        if (['meli','ml','mercadolivre'].includes(mkt)) {
          const meliId = conta.param_to_use?.meliUserId || extId;
          const r = await mcpCall(apiKey, 'list_items', { meliUserId: meliId, status: 'active', limit: 100 });
          const itens = (r.results || []).map(x => x.body).filter(Boolean);
          for (const it of itens) {
            const chave = `ml_${it.id}`;
            const precoAtual = parseFloat(it.price) || 0;
            const antes = snap[chave];
            if (antes && antes._conta === extId && antes.preco !== precoAtual) {
              logArr.unshift({ id: novoId(), itemId: it.id, apelido: (it.title||it.id).slice(0,60), de: R$(antes.preco), para: R$(precoAtual), quando: new Date().toISOString() });
              mudancas.push({ conta: label, nome: it.title, de: antes.preco, para: precoAtual });
            }
            snap[chave] = { preco: precoAtual, _conta: extId };
          }
        } else if (mkt === 'shopee') {
          const shopId = conta.param_to_use?.shopId || extId;
          const rl = await mcpCall(apiKey, 'shopee_list_items', { shopId, item_status: 'NORMAL', page_size: 50 });
          const idsRaw = rl.data?.response?.item || rl.data?.item || [];
          const ids = idsRaw.map(x => x.item_id).filter(Boolean);
          if (!ids.length) continue;
          const rd = await mcpCall(apiKey, 'shopee_get_items_batch', { shopId, item_id_list: ids });
          const detalhes = rd.data?.response?.item_list || [];
          for (const it of detalhes) {
            const chave = `shopee_${it.item_id}`;
            const precoAtual = (it.price_info?.[0]?.current_price || 0) / 100000;
            const antes = snap[chave];
            if (antes && antes._conta === extId && antes.preco !== precoAtual) {
              logArr.unshift({ id: novoId(), itemId: it.item_id, apelido: (it.item_name||String(it.item_id)).slice(0,60), de: R$(antes.preco), para: R$(precoAtual), quando: new Date().toISOString() });
              mudancas.push({ conta: label, nome: it.item_name, de: antes.preco, para: precoAtual });
            }
            snap[chave] = { preco: precoAtual, _conta: extId };
          }
        }
      } catch(e) {
        console.warn('[preco-cron] erro conta', label, e.message);
      }
    }

    await sbSet('glr_track_precos_snap_auto', snap);
    await sbSet('glr_track_precos_log', logArr.slice(0, 500));

    if (!mudancas.length) return res.status(200).json({ ok: true, mudancas: 0 });

    const subsResp = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const subs = await subsResp.json();

    const exemplos = mudancas.slice(0, 3).map(m => `${m.nome}: ${R$(m.de)} → ${R$(m.para)}`).join('\n');
    const payload = JSON.stringify({
      title: `💲 ${mudancas.length} preço(s) mudou(aram) hoje`,
      body: exemplos + (mudancas.length > 3 ? `\n+ ${mudancas.length - 3} outro(s)` : ''),
      url: '/index.html#rastreamento',
      tag: 'preco',
    });

    let enviados = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        enviados++;
      } catch(e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, {
            method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
          }).catch(()=>{});
        }
      }
    }

    return res.status(200).json({ ok: true, mudancas: mudancas.length, dispositivos: subs.length, enviados });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
