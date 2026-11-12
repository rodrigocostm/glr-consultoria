// ============================================================
// GLR Consultoria — Chat com IA do portal do cliente
// ------------------------------------------------------------
// O cliente conversa sobre as lojas DELE: vendas, produtos, curva ABC, ADS,
// estoque e margem, e as campanhas ao vivo. Mesmo cérebro e mesmas ferramentas
// de leitura do chat da equipe (api/chat-central.js), mas:
//  • só com login do portal e com o módulo liberado pela GLR (cfg.chatIA —
//    Portal Clientes → "Liberar chat IA"), porque cada pergunta gasta tokens;
//  • a carteira é só o cliente do acesso, e só as contas liberadas para ele;
//  • nada de ferramentas internas (carteira, plano da GLR, Caixa de decisões,
//    histórico dos agentes, sugestões, Segundo Cérebro) — e nada é alterado;
//  • conversas por usuário em glr_sync_estado ('sistema' / 'chat' /
//    'chat:<usuário>:portal<id>'), gravadas pelo servidor.
// POST { acao: 'abrir' | 'enviar' | 'apagar', conversa_id, mensagem }
// ============================================================
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;
const { interno } = require('./chat-central');
const { carregarCarteira, FERRAMENTAS, EXEC, lerConversa, salvarConversa, MODELO } = interno;

const PERMITIDAS = ['vendas', 'produtos', 'curva_abc', 'ads', 'estoque_margem', 'campanhas_shopee', 'campanhas_ml'];
const TOOLS = FERRAMENTAS.filter(f => PERMITIDAS.includes(f.name));
const ORCAMENTO_MS = 200000, MAX_RODADAS = 10, LIMITE_RESULTADO = 16000;
const hojeBRT = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const corta = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function sistema(cli) {
  return `Você é o assistente de vendas do portal da GLR Consultoria. Conversa com o lojista ${cli.nome}, dono das lojas abaixo, em português do Brasil, de forma clara, direta e educada.
Hoje é ${hojeBRT()} (horário de Brasília).
Lojas deste cliente: ${cli.lojas.map(l => `${l.nome} (${l.marketplace}, conta ${l.conta_id})`).join('; ')}.
Nas ferramentas, use sempre o cliente "${cli.nome}".

COMO RESPONDER:
- Busque os números com as ferramentas antes de responder; nunca invente número, produto, campanha ou loja. Diga sempre o período dos números.
- Resposta primeiro, depois os números que a sustentam; tabela em markdown quando comparar vários itens. Seja objetivo.
- Pense no funil: faturamento = visitas × conversão × preço. Explique o que está travando e o que pode ser feito (anúncio, preço, frete, estoque, ADS, promoção dentro da margem).
- Você só LÊ as informações. Não altera nada nas contas, não aplica promoção nem ajusta campanha. Para qualquer mudança, recomende e diga que o gestor da GLR faz o ajuste.
- Fale só das lojas deste cliente. Não comente outros clientes, a carteira da GLR, comissões ou processos internos da consultoria.`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!process.env.ANTHROPIC_API_KEY || !process.env.MCP_API_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Chaves do servidor não configuradas.' });
  let identity;
  try { identity = await require('./_auth').access(req); } catch (e) { return res.status(503).json({ error: 'Não foi possível verificar o acesso.' }); }
  if (!identity || identity.role !== 'portal') return res.status(403).json({ error: 'Chat disponível só no portal do cliente.' });
  const cfg = identity.portal || {};
  if (!cfg.chatIA) return res.status(403).json({ error: 'O Chat com IA não está liberado para o seu acesso. Fale com a GLR.' });
  const uid = identity.user?.id;
  const contas = new Set((cfg.contaIds || []).map(String));
  const { acao, conversa_id, mensagem } = req.body || {};
  const idOk = v => /^portal[a-z0-9]{6,40}$/i.test(String(v || ''));

  try {
    if (acao === 'abrir') {
      const c = idOk(conversa_id) ? await lerConversa(uid, String(conversa_id)) : null;
      return c ? res.status(200).json({ conversa: { titulo: c.titulo, msgs: (c.msgs || []).map(m => ({ r: m.r, t: m.t, em: m.em })) } }) : res.status(404).json({ error: 'Conversa não encontrada.' });
    }
    if (acao === 'apagar') {
      if (!idOk(conversa_id)) return res.status(400).json({ error: 'Conversa inválida.' });
      await salvarConversa(uid, String(conversa_id), { titulo: 'Conversa apagada', criado: new Date().toISOString(), msgs: [], agente: 'portal', apagada: true });
      return res.status(200).json({ ok: true });
    }

    // enviar
    const texto = String(mensagem || '').trim().slice(0, 4000);
    if (!texto) return res.status(400).json({ error: 'Escreva a sua pergunta.' });
    // carteira = só o cliente deste acesso, com as contas liberadas para ele
    const carteira = await carregarCarteira();
    const base = carteira.find(c => String(c.id) === String(cfg.clienteId));
    const lojas = (base?.lojas || []).filter(l => contas.has(String(l.conta_id)));
    if (!lojas.length) return res.status(400).json({ error: 'Nenhuma loja liberada para o seu acesso.' });
    const cli = { id: String(cfg.clienteId), nome: base.nome, gestor: '', lojas };
    const S = { carteira: [cli], mcKey: process.env.MCP_API_KEY, usuario: identity.user?.email || uid, criadas: 0 };

    const id = idOk(conversa_id) ? String(conversa_id) : `portal${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const conv = (await lerConversa(uid, id)) || { titulo: corta(texto, 60), criado: new Date().toISOString(), msgs: [], agente: 'portal' };
    const mensagens = (conv.msgs || []).slice(-16).map(m => ({ role: m.r, content: m.t })).filter(m => m.content);
    while (mensagens.length && mensagens[0].role !== 'user') mensagens.shift();
    mensagens.push({ role: 'user', content: texto });

    const client = new Anthropic();
    const inicio = Date.now(); let resposta = null;
    for (let rodada = 0; rodada < MAX_RODADAS + 1; rodada++) {
      const semTempo = Date.now() - inicio > ORCAMENTO_MS || rodada >= MAX_RODADAS;
      resposta = await client.messages.create({ model: MODELO, max_tokens: 8000, system: sistema(cli), tools: TOOLS, tool_choice: semTempo ? { type: 'none' } : { type: 'auto' }, messages: mensagens });
      if (resposta.stop_reason === 'pause_turn') { mensagens.push({ role: 'assistant', content: resposta.content }); continue; }
      if (resposta.stop_reason !== 'tool_use') break;
      mensagens.push({ role: 'assistant', content: resposta.content });
      const resultados = [];
      for (const b of resposta.content.filter(x => x.type === 'tool_use')) {
        try {
          if (!PERMITIDAS.includes(b.name)) throw new Error('Ferramenta não disponível no portal.');
          let t = JSON.stringify(await EXEC[b.name](S, { ...(b.input || {}), cliente: cli.nome }));
          if (t.length > LIMITE_RESULTADO) t = t.slice(0, LIMITE_RESULTADO) + '… (resultado cortado)';
          resultados.push({ type: 'tool_result', tool_use_id: b.id, content: t });
        } catch (e) { resultados.push({ type: 'tool_result', tool_use_id: b.id, content: `Erro: ${e.message || e}`, is_error: true }); }
      }
      mensagens.push({ role: 'user', content: resultados });
    }
    const final = resposta.stop_reason === 'refusal' ? 'Não consegui responder a essa pergunta. Tente reformular.'
      : resposta.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || 'Sem resposta.';
    conv.msgs = [...(conv.msgs || []), { r: 'user', t: texto, em: new Date(inicio).toISOString() }, { r: 'assistant', t: final, em: new Date().toISOString() }].slice(-60);
    await salvarConversa(uid, id, conv).catch(() => {});
    return res.status(200).json({ conversa_id: id, titulo: conv.titulo, resposta: final });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'Muitas perguntas ao mesmo tempo — espere alguns segundos e tente de novo.' });
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: 'A IA está indisponível agora. Tente de novo em instantes.' });
    return res.status(500).json({ error: e.message || String(e) });
  }
};
