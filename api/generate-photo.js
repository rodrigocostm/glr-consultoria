// Gera um kit de até 9 fotos de produto com IA (OpenAI gpt-image-1) a partir de
// uma foto de referência — usado pela Central de Anúncios. Fica fora do
// Marketplace Connect (Tiops) de propósito: a geração por lá consome um
// crédito pago à parte, sem relação com o plano de API já contratado.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY não configurada no servidor.' });
  }

  try {
    const { image_base64, image_url, product_name, details, ambientada } = req.body || {};

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

    const base = [
      'Gere uma foto comercial de e-commerce do MESMO produto da imagem enviada.',
      'Mantenha o produto totalmente fiel — mesmo formato, cor, proporções e textura. Não invente nem altere o produto.',
      product_name ? `Produto: ${product_name}.` : '',
      details ? `Detalhes do produto: ${details}.` : '',
    ].filter(Boolean).join(' ');

    // Kit de 9 fotos com propósitos diferentes (não são 9 variações aleatórias do
    // mesmo prompt — cada uma pede um ângulo/contexto específico pra formar um
    // catálogo completo, como um fotógrafo de produto faria).
    const variantes = [
      ambientada
        ? 'Foto ambientada: produto em um ambiente real e condizente com seu uso, boa composição, luz natural, estilo lifestyle de catálogo.'
        : 'Produto centralizado, isolado, fundo branco puro (RGB 255,255,255), iluminação de estúdio — foto principal de capa.',
      'Produto em ângulo de 3/4, fundo branco puro, iluminação de estúdio.',
      'Produto de frente, fundo branco puro, iluminação de estúdio.',
      'Produto de lado, fundo branco puro, iluminação de estúdio.',
      'Produto visto de outro ângulo relevante pro tipo de produto (trás ou de cima), fundo branco puro.',
      'Foto de detalhe/zoom em um acabamento, textura ou elemento de destaque do produto, fundo neutro.',
      'Foto ambientada mostrando o produto em uso ou num cenário real, ângulo diferente de qualquer outra foto ambientada já pedida.',
      'Foto de plano aberto mostrando a escala/proporção do produto dentro de um ambiente, pra dar noção de tamanho.',
      'Foto de destaque de um diferencial específico do produto (funcionalidade, acabamento ou detalhe construtivo), fundo neutro.',
    ];

    async function gerarUma(promptExtra) {
      const form = new FormData();
      form.append('model', 'gpt-image-1');
      form.append('image', new Blob([buffer], { type: 'image/png' }), 'referencia.png');
      form.append('prompt', `${base} ${promptExtra}`);
      form.append('n', '1');
      form.append('size', '1024x1024');

      const r = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error?.message || 'Erro na API da OpenAI.');
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error('OpenAI não devolveu imagem.');

      // O ML precisa buscar a foto por uma URL pública — a Tiops orienta explicitamente
      // a NUNCA mandar base64 de foto de verdade pros endpoints dela (fica cortada no
      // meio). Sobe cada imagem gerada pro host público deles aqui mesmo, no servidor.
      const imgBuffer = Buffer.from(b64, 'base64');
      const upForm = new FormData();
      upForm.append('file', new Blob([imgBuffer], { type: 'image/png' }), `anuncio-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
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
