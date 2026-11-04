// ============================================================
// GLR Consultoria — Atendimento com IA (portal e equipe)
// ------------------------------------------------------------
// POST com login (Authorization: Bearer <token do Supabase>):
//  • listar   — atendimentos dos últimos 30 dias das contas do cliente (o
//               portal só vê as próprias contas e só com o módulo liberado);
//  • responder — o cliente responde o que ficou "para você responder"
//               (envia pela plataforma e marca como respondida);
//  • resolver — marca como resolvida (respondeu pelo painel da plataforma).
// As respostas automáticas são feitas por api/_atendimento-ia.js no sincronizador.
// ============================================================
const SUPA = 'https://rrodqlejqyaoomutriiw.supabase.co';
const ia = require('./_atendimento-ia');

async function sb(path, init = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Banco indisponível (HTTP ${r.status})`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function mcpCall(apiKey, action, params) {
  const r = await fetch('https://mcp.tiops.com.br', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ action, params: params || {} }), signal: AbortSignal.timeout(30000) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || (json.status && json.status !== 200) || (json.error && String(json.error).trim())) throw new Error(json.error || json.message || json.data?.message || `Erro na ação ${action}`);
  return json;
}
// o portal não precisa dos ids internos de envio
const limpar = l => { const d = { ...(l.dados || {}) }; delete d.envio; return { id: l.id, criado_em: l.criado_em, conta_id: l.conta_id, titulo: l.titulo, explicacao: l.explicacao, resultado: l.resultado, dados: d }; };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  let identity;
  try { identity = await require('./_auth').access(req); } catch { return res.status(503).json({ error: 'Não foi possível verificar as permissões.' }); }
  if (!identity) return res.status(401).json({ error: 'Faça login para continuar.' });
  if (!['staff', 'portal'].includes(identity.role)) return res.status(403).json({ error: 'Acesso não autorizado.' });
  const b = req.body || {};
  try {
    // contas que este usuário pode ver — portal: as dele, e só com o módulo liberado (lido do banco, não do navegador)
    let contas;
    if (identity.role === 'portal') {
      const cfgs = (await sb('glr_storage?chave=eq.glr_portal_configs&select=dados'))?.[0]?.dados;
      const email = String(identity.user?.email || '').toLowerCase(); // mesmo critério do glr_meu_portal()
      const cfg = (Array.isArray(cfgs) ? cfgs : []).filter(c => String(c?.email || '').toLowerCase() === email).sort((a, b) => (a.ativo === false) - (b.ativo === false))[0];
      if (!cfg || cfg.ativo === false) return res.status(403).json({ error: 'Acesso não autorizado.' });
      if (!cfg.atendimentoIA) return res.status(200).json({ liberado: false, itens: [] });
      contas = (cfg.contaIds || []).map(String);
    } else {
      contas = (Array.isArray(b.contas) ? b.contas : []).map(String).filter(Boolean).slice(0, 60);
      if (!contas.length) return res.status(400).json({ error: 'Informe as contas.' });
    }
    const lista = contas.map(c => `"${c.replace(/"/g, '')}"`).join(',');

    if (b.acao === 'listar') {
      const desde = new Date(Date.now() - 30 * 864e5).toISOString();
      const rows = await sb(`glr_agente_log?tipo=eq.atendimento&conta_id=in.(${encodeURIComponent(lista)})&criado_em=gte.${encodeURIComponent(desde)}&select=id,criado_em,conta_id,titulo,explicacao,resultado,dados&order=criado_em.desc&limit=400`) || [];
      const mes = new Date(); mes.setUTCDate(1); mes.setUTCHours(3, 0, 0, 0);
      const doMes = rows.filter(r => r.criado_em >= mes.toISOString());
      const resumo = {
        respondidas_ia: doMes.filter(r => r.dados?.status === 'respondida_ia').length,
        respondidas_cliente: doMes.filter(r => r.dados?.status === 'respondida_cliente').length,
        pendentes: rows.filter(r => r.dados?.status === 'pendente').length,
        tokens_mes: doMes.reduce((s, r) => s + (r.dados?.tokens?.entrada || 0) + (r.dados?.tokens?.saida || 0), 0),
      };
      return res.status(200).json({ liberado: true, resumo, itens: rows.map(limpar) });
    }

    if (b.acao === 'responder' || b.acao === 'resolver') {
      const l = (await sb(`glr_agente_log?id=eq.${encodeURIComponent(String(b.id || ''))}&tipo=eq.atendimento&select=id,conta_id,dados`))?.[0];
      if (!l || !contas.includes(String(l.conta_id))) return res.status(404).json({ error: 'Atendimento não encontrado.' });
      if (l.dados?.status !== 'pendente') return res.status(400).json({ error: 'Este atendimento já foi resolvido.' });
      const quem = identity.user?.email || null, agora = new Date().toISOString();
      let dados;
      if (b.acao === 'responder') {
        const texto = String(b.texto || '').trim();
        const max = l.dados?.envio?.tipo === 'ml_mensagem' ? 350 : l.dados?.envio?.tipo === 'ml_pergunta' ? 2000 : 1000;
        if (!texto || texto.length > max) return res.status(400).json({ error: `Escreva a resposta (até ${max} caracteres).` });
        const apiKey = process.env.MCP_API_KEY; if (!apiKey) return res.status(500).json({ error: 'Integração não configurada.' });
        try { await ia.enviarManual(mcpCall, apiKey, String(l.conta_id), l.dados?.envio, texto); }
        catch (e) { return res.status(502).json({ error: `A plataforma recusou o envio: ${String(e.message).slice(0, 200)}` }); }
        dados = { ...l.dados, status: 'respondida_cliente', resposta: texto, respondida_em: agora, respondida_por: quem };
      } else {
        dados = { ...l.dados, status: 'resolvida', resolvida_em: agora, resolvida_por: quem };
      }
      await sb(`glr_agente_log?id=eq.${encodeURIComponent(l.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ resultado: 'executado', dados }) });
      return res.status(200).json({ ok: true, item: limpar({ ...l, resultado: 'executado', dados }) });
    }
    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (e) {
    return res.status(503).json({ error: e.message || 'Atendimento indisponível.' });
  }
};
