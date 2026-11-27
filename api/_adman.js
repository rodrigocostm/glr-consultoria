// ============================================================
// GLR Consultoria — Cliente do MCP da Adman (servidor → servidor)
// ------------------------------------------------------------
// A Adman expõe as ferramentas de ADS do Mercado Livre (leitura e escrita)
// como um servidor MCP (protocolo JSON-RPC por HTTP). O Agente de ADS
// autônomo do ML (api/_agente-ml-adman.js) usa este cliente.
//
// Variáveis de ambiente (Vercel):
//   ADMAN_MCP_URL    endereço do servidor MCP da Adman
//   ADMAN_MCP_TOKEN  chave de acesso (vai como "Authorization: Bearer ...")
// Sem as duas, o agente não roda (responde "skip" explicando o que falta).
//
// Arquivo com "_" na frente: não vira rota na Vercel.
// ============================================================

function configurado() {
  return !!(process.env.ADMAN_MCP_URL && process.env.ADMAN_MCP_TOKEN);
}

// Lê a resposta do MCP: JSON puro ou fluxo SSE ("data: {...}")
async function lerResposta(r) {
  const tipo = r.headers.get('content-type') || '';
  const txt = await r.text();
  if (tipo.includes('text/event-stream')) {
    const linhas = txt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
    for (let i = linhas.length - 1; i >= 0; i--) { try { const j = JSON.parse(linhas[i]); if (j.result || j.error) return j; } catch { /* linha parcial */ } }
    return {};
  }
  try { return txt ? JSON.parse(txt) : {}; } catch { throw new Error(`Adman respondeu algo que não é JSON (HTTP ${r.status}): ${txt.slice(0, 200)}`); }
}

function criarCliente({ url = process.env.ADMAN_MCP_URL, token = process.env.ADMAN_MCP_TOKEN, fetchFn = fetch } = {}) {
  let sessao = null, iniciado = false, seq = 0;
  async function rpc(method, params, notificacao = false) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
    if (sessao) headers['Mcp-Session-Id'] = sessao;
    const corpo = notificacao ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++seq, method, params };
    const r = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(corpo), signal: AbortSignal.timeout(45000) });
    const sid = r.headers.get('mcp-session-id'); if (sid) sessao = sid;
    if (notificacao) return null;
    if (!r.ok && r.status !== 200) {
      const t = await r.text().catch(() => '');
      const e = new Error(`Adman HTTP ${r.status}: ${t.slice(0, 300)}`); e.status = r.status; throw e;
    }
    const j = await lerResposta(r);
    if (j.error) { const e = new Error(`Adman: ${j.error.message || JSON.stringify(j.error)}`); e.status = j.error.code; throw e; }
    return j.result;
  }
  async function iniciar() {
    if (iniciado) return;
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'glr-agente-ads', version: '1.0' } });
    await rpc('notifications/initialized', {}, true).catch(() => {});
    iniciado = true;
  }
  // Chama uma ferramenta e devolve o JSON que ela respondeu (texto do 1º bloco)
  async function chamar(nome, args) {
    await iniciar();
    const res = await rpc('tools/call', { name: nome, arguments: args || {} });
    const txt = (res?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (res?.isError) { const e = new Error(txt || `Adman recusou ${nome}`); const m = /status (\d{3})/.exec(txt); if (m) e.status = Number(m[1]); throw e; }
    if (res?.structuredContent) return res.structuredContent;
    try { return JSON.parse(txt); } catch { return { texto: txt }; }
  }
  return { chamar };
}

module.exports = { configurado, criarCliente, lerResposta };
