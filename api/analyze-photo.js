// Analisa a foto de referência do produto com IA (Gemini) e sugere título e
// descrição pra pré-preencher o formulário de "Criar anúncio novo" — usado
// pela Central de Anúncios assim que o analista sobe a foto.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor.' });
  }

  try {
    const { image_base64 } = req.body || {};
    if (!image_base64) {
      return res.status(400).json({ error: 'Envie image_base64.' });
    }
    const raw = String(image_base64);
    const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
    const mimeType = match ? match[1] : 'image/jpeg';
    const data = raw.includes(',') ? raw.split(',')[1] : raw;

    const prompt = [
      'Olhe a foto de um produto físico anexada.',
      'Devolva APENAS um JSON válido (sem markdown, sem texto fora do JSON) com este formato exato:',
      '{"titulo": "título curto de anúncio de marketplace, até 60 caracteres, em português, sem emojis", "descricao": "descrição comercial de 2 a 4 frases pro anúncio, em português, destacando o que dá pra ver na foto (tipo de produto, material aparente, cor, estilo)", "categoria_busca": "1 a 3 palavras-chave em português pra buscar a categoria do produto num marketplace"}',
      'Se não conseguir identificar o produto com confiança, ainda assim devolva sua melhor estimativa — nunca deixe os campos vazios.',
    ].join(' ');

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data } },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json' },
    };

    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: json.error?.message || 'Erro na API do Gemini.' });
    }

    const texto = json.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    let parsed;
    try { parsed = JSON.parse(texto); } catch (e) {
      return res.status(502).json({ error: 'Gemini não devolveu um JSON válido.' });
    }

    return res.status(200).json({
      titulo: parsed.titulo || '',
      descricao: parsed.descricao || '',
      categoria_busca: parsed.categoria_busca || '',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
