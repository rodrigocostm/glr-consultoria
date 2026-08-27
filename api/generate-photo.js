// Gera fotos de produto com IA (Google Gemini — gemini-2.5-flash-image,
// "Nano Banana") a partir de uma foto de referência — usado pelo Gerador de
// Fotos. Não depende do Marketplace Connect (Tiops): devolve a imagem
// direto em base64, sem publicar em lugar nenhum — quem decide o que fazer
// com a foto é o analista, baixando ou usando onde quiser.
//
// Gera em 2 estágios controlados pelo front (stage: 'ambientada' | 'detalhes')
// pra economizar chamadas — o analista só paga pelos 2 close-ups de detalhe se
// gostar da foto ambientada gerada primeiro.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor.' });
  }

  try {
    const { image_base64, image_url, product_name, details, stage, ambientada_base64 } = req.body || {};

    function decodeDataUrl(raw, fallbackMime) {
      const s = String(raw);
      const match = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
      const mimeType = match ? match[1] : fallbackMime;
      const data = s.includes(',') ? s.split(',')[1] : s;
      return { mimeType, data: Buffer.from(data, 'base64').toString('base64') };
    }

    let refProduto;
    if (image_base64) {
      refProduto = decodeDataUrl(image_base64, 'image/jpeg');
    } else if (image_url) {
      const imgRes = await fetch(image_url);
      if (!imgRes.ok) {
        return res.status(400).json({ error: `Não consegui baixar a foto de referência (HTTP ${imgRes.status}).` });
      }
      const ct = imgRes.headers.get('content-type');
      const mimeType = ct && ct.startsWith('image/') ? ct : 'image/jpeg';
      const data = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
      refProduto = { mimeType, data };
    } else {
      return res.status(400).json({ error: 'Envie image_base64 ou image_url.' });
    }

    const base = [
      'Gere uma foto comercial de e-commerce do MESMO produto da imagem enviada.',
      'Mantenha o produto totalmente fiel — mesmo formato, cor, proporções e textura. Não invente nem altere o produto.',
      product_name ? `Produto: ${product_name}.` : '',
      details ? `Detalhes do produto: ${details}.` : '',
    ].filter(Boolean).join(' ');

    async function gerarImagem(promptExtra, imagensExtra = []) {
      const parts = [
        { text: `${base} ${promptExtra}` },
        { inlineData: refProduto },
        ...imagensExtra.map(img => ({ inlineData: img })),
      ];
      const body = {
        contents: [{ parts }],
        generationConfig: { responseModalities: ['IMAGE'] },
      };

      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error?.message || 'Erro na API do Gemini.');

      const respParts = json.candidates?.[0]?.content?.parts || [];
      const imgPart = respParts.find(p => p.inlineData || p.inline_data);
      const inline = imgPart?.inlineData || imgPart?.inline_data;
      if (!inline?.data) {
        const motivo = json.candidates?.[0]?.finishReason || 'sem imagem na resposta';
        throw new Error('Gemini não devolveu imagem (' + motivo + ').');
      }
      return { mimeType: inline.mimeType || 'image/png', data: inline.data };
    }

    function comoDataUrl(img) {
      return `data:${img.mimeType};base64,${img.data}`;
    }

    if (stage === 'detalhes') {
      if (!ambientada_base64) {
        return res.status(400).json({ error: 'Envie ambientada_base64 pra gerar os detalhes.' });
      }
      const fotoAmbientada = decodeDataUrl(ambientada_base64, 'image/png');

      const promptDetalhe1 = `${base} Use a SEGUNDA imagem de referência fornecida (a foto ambientada) como cena base — NÃO é uma foto de estúdio isolada nem fundo infinito. Aproxime a câmera dentro dessa MESMA cena ambientada (mesmo ambiente, luz e enquadramento espacial) até um close-up mostrando de perto um acabamento, textura ou elemento de destaque específico do produto.`;
      const promptDetalhe2 = `${base} Use a SEGUNDA imagem de referência fornecida (a foto ambientada) como cena base — NÃO é uma foto de estúdio isolada nem fundo infinito. Aproxime a câmera dentro dessa MESMA cena ambientada (mesmo ambiente, luz e enquadramento espacial) até um close-up mostrando de perto OUTRO acabamento, textura, funcionalidade ou elemento de destaque do produto — precisa ser um detalhe DIFERENTE do que normalmente seria destacado primeiro, com ângulo de câmera diferente do outro close-up.`;

      const [r1, r2] = await Promise.allSettled([
        gerarImagem(promptDetalhe1, [fotoAmbientada]),
        gerarImagem(promptDetalhe2, [fotoAmbientada]),
      ]);

      const images = [];
      const erros = [];
      if (r1.status === 'fulfilled') images.push({ url: comoDataUrl(r1.value) });
      else erros.push('Detalhe 1: ' + (r1.reason?.message || r1.reason));
      if (r2.status === 'fulfilled') images.push({ url: comoDataUrl(r2.value) });
      else erros.push('Detalhe 2: ' + (r2.reason?.message || r2.reason));

      if (!images.length) {
        return res.status(502).json({ error: 'Nenhuma foto de detalhe foi gerada. ' + (erros[0] || '') });
      }
      return res.status(200).json({ images, erros: erros.length ? erros : undefined });
    }

    // stage === 'ambientada' (padrão): gera só 1 foto, mais barato que o kit inteiro.
    const promptAmbientada = 'Foto ambientada em ambiente premium: produto inserido em um ambiente premium sofisticado (ex.: sala/ambiente moderno e elegante, materiais nobres, iluminação suave e clean, condizente com um produto de alto padrão), em uso, boa composição, câmera em plano aberto/meio plano, ângulo em 3/4 (nunca de frente reta), estilo lifestyle de catálogo — foto principal.';
    const foto = await gerarImagem(promptAmbientada);
    return res.status(200).json({ images: [{ url: comoDataUrl(foto) }] });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
