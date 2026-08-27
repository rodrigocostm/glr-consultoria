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

    const refProduto = { mimeType, data: buffer.toString('base64') };

    // Chama o Gemini com a foto do produto + (opcionalmente) outras imagens de
    // referência extra — usado pra passar a foto ambientada já gerada como guia
    // de cenário na foto frontal, já que cada chamada não enxerga as outras.
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

    // O ML precisa buscar a foto por uma URL pública — a Tiops orienta explicitamente
    // a NUNCA mandar base64 de foto de verdade pros endpoints dela (fica cortada no
    // meio). Sobe cada imagem gerada pro host público deles aqui mesmo, no servidor.
    async function publicarImagem(img) {
      const imgBuffer = Buffer.from(img.data, 'base64');
      const upForm = new FormData();
      upForm.append('file', new Blob([imgBuffer], { type: img.mimeType }), `anuncio-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
      const upRes = await fetch('https://upload.tiops.com.br/', { method: 'POST', body: upForm });
      const upJson = await upRes.json().catch(() => ({}));
      const publicUrl = upJson.data?.url || upJson.url;
      if (!upRes.ok || !publicUrl) throw new Error('Falhou ao publicar imagem gerada em URL pública: ' + (upJson.error || upJson.data?.error || upRes.status));
      return publicUrl;
    }

    const promptAmbientada = 'Foto ambientada em ambiente premium: produto inserido em um ambiente premium sofisticado (ex.: sala/ambiente moderno e elegante, materiais nobres, iluminação suave e clean, condizente com um produto de alto padrão), em uso, boa composição, câmera em plano aberto/meio plano, ângulo em 3/4 (nunca de frente reta), estilo lifestyle de catálogo — foto principal.';

    const images = [];
    const erros = [];

    // 1) Gera a foto ambientada primeiro — ela vira a referência de cenário das outras 2
    // (efeito cascata: a 2ª e a 3ª partem da 1ª, não são geradas soltas).
    let fotoAmbientada = null;
    try {
      fotoAmbientada = await gerarImagem(promptAmbientada);
      images.push({ url: await publicarImagem(fotoAmbientada) });
    } catch (e) {
      erros.push('Ambientada: ' + (e.message || e));
    }

    // 2) Detalhe e 3) frontal, cada uma usando a foto ambientada (se deu certo) como
    // referência extra — rodam em paralelo entre si, mas as duas dependem da 1ª.
    const promptDetalhe = fotoAmbientada
      ? `${base} Use a SEGUNDA imagem de referência fornecida (a foto ambientada) como cena base — NÃO é uma foto de estúdio isolada nem fundo infinito. Aproxime a câmera dentro dessa MESMA cena ambientada (mesmo ambiente, luz e enquadramento espacial) até um close-up mostrando de perto um acabamento, textura ou elemento de destaque específico do produto.`
      : `${base} Foto de detalhe: zoom em uma característica específica do produto (acabamento, textura, funcionalidade ou elemento de destaque), mostrando qualidade e detalhes construtivos.`;

    const promptFrontal = fotoAmbientada
      ? `${base} Use a SEGUNDA imagem de referência fornecida (a foto ambientada) como guia de cenário — mantenha exatamente o MESMO ambiente dela (mesma sala/fundo, mobiliário, parede, piso e iluminação). MUDE A CÂMERA: reposicione pra um plano frontal reto (0°), câmera direto de frente pro produto, na altura do produto, diferente do ângulo em 3/4 da primeira foto — essa foto precisa ficar visivelmente diferente da primeira em enquadramento e ângulo, mesmo estando no mesmo ambiente.`
      : `${base} Foto do produto de frente, em um ambiente premium sofisticado condizente com um produto de alto padrão, enquadramento frontal reto e centralizado.`;

    const [rDetalhe, rFrontal] = await Promise.allSettled([
      gerarImagem(promptDetalhe, fotoAmbientada ? [fotoAmbientada] : []).then(publicarImagem),
      gerarImagem(promptFrontal, fotoAmbientada ? [fotoAmbientada] : []).then(publicarImagem),
    ]);

    if (rDetalhe.status === 'fulfilled') images.push({ url: rDetalhe.value });
    else erros.push('Detalhe: ' + (rDetalhe.reason?.message || rDetalhe.reason));

    if (rFrontal.status === 'fulfilled') images.push({ url: rFrontal.value });
    else erros.push('Frontal: ' + (rFrontal.reason?.message || rFrontal.reason));

    if (!images.length) {
      return res.status(502).json({ error: 'Nenhuma foto do kit foi gerada. ' + (erros[0] || '') });
    }
    return res.status(200).json({ images, erros: erros.length ? erros : undefined });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
