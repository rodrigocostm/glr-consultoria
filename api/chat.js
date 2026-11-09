module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!await require('./_auth').requireStaff(req, res)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key não configurada no servidor' });
  }

  try {
    const { messages, system } = req.body;

    const conhecimento = await require('./_conhecimento').contexto((Array.isArray(messages) ? messages : []).filter(m=>m.role==='user' && typeof m.content==='string').slice(-2).map(m=>m.content).join(' '));
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: (system || 'Você é um especialista em ADS para marketplaces (Mercado Livre e Shopee). Responda de forma objetiva e prática em português.') + conhecimento,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Erro na API Claude' });
    }

    const data = await response.json();
    return res.status(200).json({ content: data.content?.[0]?.text || '' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
