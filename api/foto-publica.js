// ============================================================
// GLR Consultoria — Publica uma foto do Criar anúncio num endereço público
// ------------------------------------------------------------
// Os marketplaces não aceitam foto em base64 grande dentro da criação do anúncio
// (a Shopee recusava: "Não foi possível baixar a imagem informada"). O front manda
// cada foto aqui (já reduzida para ~1600 px), o servidor sobe no armazenamento
// temporário da Tiops (upload.tiops.com.br) e devolve a URL pública, que vai em
// pictures[].source (ML), shopee_upload_image (Shopee) e tiktok_upload_image.
// Corpo: { image_base64: "data:image/jpeg;base64,…" } → { url }
// ============================================================
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!await require('./_auth').requireStaff(req, res)) return;
  try {
    const m = String(req.body?.image_base64 || '').match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'Envie a foto em JPEG, PNG ou WebP.' });
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'Foto grande demais (máx. 4 MB).' });
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: m[1] }), `anuncio-${Date.now()}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`);
    const r = await fetch('https://upload.tiops.com.br/', { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    const url = j?.data?.url || j?.url;
    if (!r.ok || !url) return res.status(502).json({ error: `Não consegui publicar a foto (HTTP ${r.status}).` });
    return res.status(200).json({ url });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
