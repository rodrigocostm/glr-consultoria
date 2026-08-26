// Gera foto de produto com IA (OpenAI gpt-image-1) a partir de uma foto de
// referência — usado pela Central de Anúncios. Fica fora do Marketplace
// Connect (Tiops) de propósito: a geração por lá consome um crédito pago à
// parte, sem relação com o plano de API já contratado.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY não configurada no servidor.' });
  }

  try {
    const { image_base64, image_url, prompt, ad_title, photo_count } = req.body || {};

    let buffer;
    if (image_base64) {
      const clean = String(image_base64).includes(',') ? image_base64.split(',')[1] : image_base64;
      buffer = Buffer.from(clean, 'base64');
    } else if (image_url) {
      const imgRes = await fetch(image_url);
      if (!imgRes.ok) {
        return res.status(400).json({ error: `Não consegui baixar a foto de referência (HTTP ${imgRes.status}).` });
      }
      buffer = Buffer.from(await imgRes.arrayBuffer());
    } else {
      return res.status(400).json({ error: 'Envie image_base64 ou image_url.' });
    }

    const n = Math.min(Math.max(parseInt(photo_count, 10) || 1, 1), 4);
    const promptFinal = [
      'Gere uma foto comercial de e-commerce do MESMO produto da imagem enviada.',
      'Mantenha o produto totalmente fiel — mesmo formato, cor, proporções e textura. Não invente nem altere o produto.',
      'Troque apenas cenário, fundo e iluminação para um visual profissional de catálogo de marketplace.',
      ad_title ? `Produto: ${ad_title}.` : '',
      prompt ? `Instrução adicional do analista: ${prompt}.` : '',
    ].filter(Boolean).join(' ');

    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('image', new Blob([buffer], { type: 'image/png' }), 'referencia.png');
    form.append('prompt', promptFinal);
    form.append('n', String(n));
    form.append('size', '1024x1024');

    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    const json = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: json.error?.message || 'Erro na API da OpenAI.' });
    }

    // O ML precisa buscar a foto por uma URL pública — a Tiops orienta explicitamente
    // a NUNCA mandar base64 pro pictures[]/upload_temp_image dela (a chamada é
    // cortada no meio pra foto de verdade). Por isso sobe cada imagem gerada pro
    // host público deles aqui mesmo, no servidor, e já devolve a URL final pro front.
    const images = [];
    for (const d of (json.data || [])) {
      const imgBuffer = Buffer.from(d.b64_json, 'base64');
      const upForm = new FormData();
      upForm.append('file', new Blob([imgBuffer], { type: 'image/png' }), `anuncio-${Date.now()}-${images.length}.png`);
      const upRes = await fetch('https://upload.tiops.com.br/', { method: 'POST', body: upForm });
      const upJson = await upRes.json().catch(() => ({}));
      const publicUrl = upJson.data?.url || upJson.url;
      if (!upRes.ok || !publicUrl) {
        return res.status(502).json({ error: 'Foto gerada, mas falhou ao publicar em URL pública: ' + (upJson.error || upJson.data?.error || upRes.status) });
      }
      images.push({ url: publicUrl });
    }

    return res.status(200).json({ images });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
