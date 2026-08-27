// Gera um kit de 3 fotos de produto com IA (Google Gemini — gemini-2.5-flash-image,
// "Nano Banana") a partir de uma foto de referência — usado pela Central de
// Anúncios. Fica fora do Marketplace Connect (Tiops) de propósito: a geração
// por lá consome um crédito pago à parte, sem relação com o plano de API já
// contratado.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor.' });
  }

  try {
    const { image_base64, image_url, product_name, details } = req.body || {};

    let buffer;
    let mimeType = 'image/jpeg';
    if (image_base64) {
      const raw = String(image_base64);
      const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
      if (match) mimeType = match[1];
      const clean = raw.includes(',') ? raw.split(',')[1] : raw;
      buffer = Buffer.from(clean, 'base64');
    } else if (image_url) {
      const imgRes = await fetch(image_url);
      if (!imgRes.ok) {
        return res.status(400).json({ error: `Não consegui baixar a foto de referência (HTTP ${imgRes.status}).` });
      }
      const ct = imgRes.headers.get('content-type');
      if (ct && ct.startsWith('image/')) mimeType = ct;
      buffer = Buffer.from(await imgRes.arrayBuffer());
    } else {
      return res.status(400).json({ error: 'Envie image_base64 ou image_url.' });
    }

    const base = [
      'Gere uma foto comercial de e-commerce do MESMO produto da imagem enviada.',
      'Mantenha o produto totalmente fiel — mesmo formato, cor, proporções e textura. Não invente nem altere o produto.',
      product_name ? `Produto: ${product_name}.` : '',
      details ? `Detalhes do produto: ${details}.` : '',
    ].filter(Boolean).join(' ');

    // Kit de 3 fotos com propósitos fixos e diferentes entre si.
    const variantes = [
      'Foto ambientada: produto em um ambiente real e condizente com seu uso, boa composição, luz natural, estilo lifestyle de catálogo — foto principal.',
      'Foto ambientada também: mesmo estilo de cenário real de uso da primeira foto (lifestyle, luz natural), mas com o enquadramento focado em outro detalhe ou funcionalidade do produto — não repita o mesmo ângulo nem o mesmo recorte da primeira foto.',
      'Foto em perspectiva diferente da primeira: produto fotografado em ângulo diagonal/rotacionado, mostrando profundidade e volume, fundo neutro.',
    ];

    const imageBase64 = buffer.toString('base64');

    async function gerarUma(promptExtra) {
      const body = {
        contents: [{
          parts: [
            { text: `${base} ${promptExtra}` },
            { inlineData: { mimeType, data: imageBase64 } },
          ],
        }],
        generationConfig: { responseModalities: ['IMAGE'] },
      };

      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error?.message || 'Erro na API do Gemini.');

      const parts = json.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find(p => p.inlineData || p.inline_data);
      const inline = imgPart?.inlineData || imgPart?.inline_data;
      if (!inline?.data) {
        const motivo = json.candidates?.[0]?.finishReason || 'sem imagem na resposta';
        throw new Error('Gemini não devolveu imagem (' + motivo + ').');
      }

      // O ML precisa buscar a foto por uma URL pública — a Tiops orienta explicitamente
      // a NUNCA mandar base64 de foto de verdade pros endpoints dela (fica cortada no
      // meio). Sobe cada imagem gerada pro host público deles aqui mesmo, no servidor.
      const imgBuffer = Buffer.from(inline.data, 'base64');
      const upForm = new FormData();
      upForm.append('file', new Blob([imgBuffer], { type: inline.mimeType || 'image/png' }), `anuncio-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
      const upRes = await fetch('https://upload.tiops.com.br/', { method: 'POST', body: upForm });
      const upJson = await upRes.json().catch(() => ({}));
      const publicUrl = upJson.data?.url || upJson.url;
      if (!upRes.ok || !publicUrl) throw new Error('Falhou ao publicar imagem gerada em URL pública: ' + (upJson.error || upJson.data?.error || upRes.status));
      return publicUrl;
    }

    const resultados = await Promise.allSettled(variantes.map(v => gerarUma(v)));
    const images = resultados.filter(r => r.status === 'fulfilled').map(r => ({ url: r.value }));
    const erros = resultados.filter(r => r.status === 'rejected').map(r => r.reason?.message || String(r.reason));

    if (!images.length) {
      return res.status(502).json({ error: 'Nenhuma foto do kit foi gerada. ' + (erros[0] || '') });
    }
    return res.status(200).json({ images, erros: erros.length ? erros : undefined });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
