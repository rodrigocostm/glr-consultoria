// ============================================================
// GLR Consultoria — Agente de Fotos
// ------------------------------------------------------------
// Por loja (Shopee e Mercado Livre), 1x por semana (agente-cron ?rodada=fotos,
// de madrugada; &conta=X&mkt=Y analisa uma loja na hora):
//  1. Conversão de cada anúncio = unidades vendidas ÷ visitas (visitas do funil,
//     api/_funil.js; vendas dos pedidos da base) — ML 28 dias, Shopee 14 dias.
//  2. Campeões: maior conversão com volume (visitas e vendas mínimas).
//     Candidatos: anúncio com visita boa e conversão bem abaixo da mediana da loja
//     — a foto é o primeiro suspeito (o cliente vê e não compra).
//  3. A IA (Gemini) olha as fotos dos campeões e descreve o PADRÃO VISUAL da loja
//     (fundo, luz, ângulo, ambientação, sequência) e o que falta nas fotos dos
//     candidatos. O padrão vira instrução para gerar foto nova (api/generate-photo.js
//     stage 'padrao', a partir da tela Agente de Fotos).
// Nada é publicado no anúncio: o analista gera, revisa e decide.
// Resultado em glr_sync_estado (recurso 'fotos'):
//   { em, dia, janela, medianaConv, referencias: [{ id, n, conv, visitas, un, fotos[] }],
//     candidatos: [{ id, n, conv, visitas, un, preco, ganhoSem, foto, fotos[], sugestao }],
//     padrao: { resumo, fundo, iluminacao, enquadramento, ambientacao, sequencia[], prompt }, erro? }
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================
const { visitasItem } = require('./_funil');
const SEG = 1000, DIA = 86400;
const dataBR = t => new Date((t - 3 * 3600) * SEG).toISOString().slice(0, 10);
const r2 = v => Math.round(v * 100) / 100;
const JANELA = { ml: 28, shopee: 14 };
const MIN_VISITAS = { ml: 150, shopee: 100 };

async function vendasPorItem(sbSelect, mkt, id, desdeIso, ateIso) {
  const out = new Map();
  for (let off = 0; off < 60000; off += 1000) {
    const rows = await sbSelect('glr_pedidos', `marketplace=eq.${mkt}&conta_id=eq.${encodeURIComponent(id)}&situacao=eq.valido&criado_em=gte.${encodeURIComponent(desdeIso)}&criado_em=lt.${encodeURIComponent(ateIso)}&select=itens&limit=1000&offset=${off}`);
    for (const p of rows) for (const it of (p.itens || [])) {
      if (!it.item_id) continue;
      const k = String(it.item_id), q = parseInt(it.qtd) || 1;
      const v = out.get(k) || { un: 0, rs: 0, n: String(it.nome || k).slice(0, 90) };
      v.un += q; v.rs += (parseFloat(it.preco) || 0) * q;
      out.set(k, v);
    }
    if (rows.length < 1000) break;
  }
  return out;
}

async function fotosDosItens(mcpCall, apiKey, mkt, id, ids) {
  const out = {};
  if (!ids.length) return out;
  if (mkt === 'shopee') {
    for (let i = 0; i < ids.length; i += 50) {
      const r = await mcpCall(apiKey, 'shopee_get_items_batch', { shopId: id, item_id_list: ids.slice(i, i + 50).map(Number) });
      for (const b of ((r.data || r)?.response?.item_list || [])) out[String(b.item_id)] = { fotos: (b.image?.image_url_list || []).slice(0, 8), url: b.item_url || null };
    }
  } else {
    for (let i = 0; i < ids.length; i += 20) {
      const r = await mcpCall(apiKey, 'raw', { method: 'GET', path: `/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=id,pictures,permalink`, meliUserId: id });
      const lista = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [];
      for (const x of lista) { const b = x.body || x; if (b?.id) out[String(b.id)] = { fotos: (b.pictures || []).map(p => p.secure_url || p.url).filter(Boolean).slice(0, 8), url: b.permalink || null }; }
    }
  }
  return out;
}

async function baixarImagem(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4.5e6) return null;
    return { mimeType: ct.startsWith('image/') ? ct.split(';')[0] : 'image/jpeg', data: buf.toString('base64') };
  } catch (e) { return null; }
}

// Gemini olha as fotos: padrão dos campeões + o que falta em cada candidato
async function analisarFotos(geminiKey, refs, cands) {
  const partes = [];
  const textos = [
    'Você é diretor de fotografia de e-commerce (marketplaces brasileiros: Mercado Livre e Shopee).',
    `As primeiras imagens são fotos dos ${refs.length} anúncios que MAIS CONVERTEM nesta loja (visita → compra). Depois vêm as fotos principais de anúncios da MESMA loja que convertem pouco, mesmo com muitas visitas.`,
    'Descreva o PADRÃO VISUAL que os campeões têm em comum (o que provavelmente ajuda a converter) e, para cada anúncio fraco, o que a foto dele faz diferente do padrão.',
    'Devolva APENAS JSON válido, em português, neste formato:',
    '{"padrao":{"resumo":"1 frase","fundo":"","iluminacao":"","enquadramento":"","angulo":"","ambientacao":"","elementos":"textos, selos, medidas, setas — ou nenhum","sequencia":["foto 1: …","foto 2: …"],"prompt":"instrução de até 600 caracteres para gerar uma foto NOVA de outro produto seguindo esse padrão (sem descrever nenhum produto específico)"},"candidatos":[{"id":"","diferenca":"o que a foto atual faz diferente do padrão (1-2 frases)","sugestao":"o que mudar na foto principal (1 frase)"}]}',
    'Seja concreto (ex.: "fundo branco infinito", "ambiente de sala clara com luz natural lateral", "produto ocupando 80% do quadro", "ângulo 3/4"). Não invente o que não dá para ver.',
  ];
  partes.push({ text: textos.join(' ') });
  for (const r of refs) for (const img of r.imgs) { partes.push({ text: `Campeão — ${r.n} (conversão ${r2(r.conv * 100)}%):` }); partes.push({ inlineData: img }); }
  for (const c of cands) if (c.img) { partes.push({ text: `Anúncio fraco id=${c.id} — ${c.n} (conversão ${r2(c.conv * 100)}%):` }); partes.push({ inlineData: c.img }); }
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
    body: JSON.stringify({ contents: [{ parts: partes }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Gemini HTTP ${r.status}`);
  const texto = j.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
  return JSON.parse(texto);
}

async function analisarConta(h, mkt, id) {
  const { sbSelect, mcpCall, apiKey, geminiKey } = h;
  const t = Math.floor(Date.now() / SEG), hoje = dataBR(t), dias = JANELA[mkt] || 14;
  const ini = dataBR(t - dias * DIA), fim = dataBR(t - DIA);
  const funil = (await sbSelect('glr_sync_estado', `marketplace=eq.${mkt}&conta_id=eq.${encodeURIComponent(id)}&recurso=eq.funil&select=cursor`).catch(() => []))[0]?.cursor;
  if (!funil?.itens) return { em: Date.now(), dia: hoje, erro: 'Ainda não há visitas por anúncio desta loja (o funil roda 1x por dia).' };
  const vendas = await vendasPorItem(sbSelect, mkt, id, new Date(`${ini}T00:00:00-03:00`).toISOString(), new Date(`${hoje}T00:00:00-03:00`).toISOString());
  const linhas = [];
  for (const [item, x] of Object.entries(funil.itens)) {
    const vis = visitasItem(funil, item, ini, fim);
    if (vis == null || vis < MIN_VISITAS[mkt]) continue;
    const v = vendas.get(String(item)) || { un: 0, rs: 0 };
    linhas.push({ id: String(item), n: x.n || v.n || String(item), visitas: vis, un: v.un, preco: v.un ? r2(v.rs / v.un) : null, conv: v.un / vis });
  }
  if (linhas.length < 4) return { em: Date.now(), dia: hoje, janela: dias, erro: `Poucos anúncios com visitas suficientes (${linhas.length}) para comparar a conversão.` };
  const convs = linhas.map(l => l.conv).sort((a, b) => a - b);
  const mediana = convs[Math.floor(convs.length / 2)];
  const visMed = linhas.map(l => l.visitas).sort((a, b) => a - b)[Math.floor(linhas.length / 2)];
  const referencias = linhas.filter(l => l.un >= 3).sort((a, b) => b.conv - a.conv).slice(0, 3);
  const comPreco = linhas.filter(l => l.preco);
  const precoMedio = comPreco.length ? comPreco.reduce((s, l) => s + l.preco, 0) / comPreco.length : 0;
  const candidatos = linhas.filter(l => l.visitas >= visMed && l.conv < mediana * 0.5 && !referencias.includes(l))
    .map(l => ({ ...l, ganhoSem: r2((mediana - l.conv) * l.visitas / dias * 7 * (l.preco || precoMedio)) }))
    .sort((a, b) => b.ganhoSem - a.ganhoSem).slice(0, 8);
  const fotos = await fotosDosItens(mcpCall, apiKey, mkt, id, [...referencias, ...candidatos].map(l => l.id));
  for (const l of [...referencias, ...candidatos]) { l.fotos = fotos[l.id]?.fotos || []; l.link = fotos[l.id]?.url || null; l.foto = l.fotos[0] || null; }
  let padrao = null, erro = null;
  if (geminiKey && referencias.some(r => r.fotos.length)) {
    try {
      const refsImg = await Promise.all(referencias.map(async r => ({ ...r, imgs: (await Promise.all(r.fotos.slice(0, 2).map(baixarImagem))).filter(Boolean) })));
      const candImg = await Promise.all(candidatos.slice(0, 4).map(async c => ({ ...c, img: c.foto ? await baixarImagem(c.foto) : null })));
      const ia = await analisarFotos(geminiKey, refsImg.filter(r => r.imgs.length), candImg);
      padrao = ia?.padrao || null;
      for (const c of (ia?.candidatos || [])) { const x = candidatos.find(k => k.id === String(c.id)); if (x) { x.diferenca = c.diferenca || null; x.sugestao = c.sugestao || null; } }
    } catch (e) { erro = `Análise das fotos falhou: ${String(e.message || e).slice(0, 160)}`; }
  } else if (!geminiKey) erro = 'GEMINI_API_KEY não configurada — sem análise das fotos.';
  const limpa = l => ({ id: l.id, n: l.n, conv: r2(l.conv * 100), visitas: l.visitas, un: l.un, preco: l.preco, foto: l.foto, fotos: l.fotos, link: l.link, ...(l.ganhoSem != null ? { ganhoSem: l.ganhoSem, diferenca: l.diferenca || null, sugestao: l.sugestao || null } : {}) });
  return { em: Date.now(), dia: hoje, janela: dias, medianaConv: r2(mediana * 100), analisados: linhas.length, referencias: referencias.map(limpa), candidatos: candidatos.map(limpa), padrao, ...(erro ? { erro } : {}) };
}

module.exports = { analisarConta };
