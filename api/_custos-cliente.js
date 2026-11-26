// Gravação do catálogo de custo sem chave pelo nome do produto e sem perder
// uma gravação concorrente: lê a versão, aplica só os ids desta conta e
// só confirma se a versão não mudou no meio.
const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';

function aplicarIds(cat, pares) {
  const out = cat && typeof cat === 'object' && !Array.isArray(cat) ? { ...cat } : {};
  for (const [id, valor] of pares) {
    const chave = String(id || '');
    if (!chave) continue;
    if (valor > 0) out[chave] = valor;
    else delete out[chave];
  }
  return out;
}

async function fundirCatalogo(pares) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Não consegui salvar o custo');
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  for (let t = 0; t < 5; t++) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?chave=eq.glr_vendas_custo_catalogo&select=dados,atualizado_em`, { headers: H, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('Não consegui ler o catálogo de custos');
    const row = (await r.json())[0];
    const base = row?.dados && typeof row.dados === 'object' && !Array.isArray(row.dados) ? row.dados : {};
    const dados = aplicarIds(base, pares);
    const agora = new Date().toISOString();
    if (!row) {
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ chave: 'glr_vendas_custo_catalogo', dados, atualizado_em: agora }),
        signal: AbortSignal.timeout(10000),
      });
      if (ins.status === 409) continue;
      if (!ins.ok) throw new Error('Não consegui salvar o custo');
      return dados;
    }
    const filtro = `chave=eq.glr_vendas_custo_catalogo&atualizado_em=eq.${encodeURIComponent(row.atualizado_em)}`;
    const w = await fetch(`${SUPABASE_URL}/rest/v1/glr_storage?${filtro}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ dados, atualizado_em: agora }),
      signal: AbortSignal.timeout(10000),
    });
    if (!w.ok) throw new Error('Não consegui salvar o custo');
    const gravou = await w.json();
    if (Array.isArray(gravou) && gravou.length) return dados;
  }
  throw new Error('Não consegui salvar o custo. Tente de novo.');
}

async function fundirColecao(clienteId, pares) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !clienteId) throw new Error('Não consegui salvar o custo');
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const base = `${SUPABASE_URL}/rest/v1/glr_cliente_colecao`;
  for (let t = 0; t < 5; t++) {
    const r = await fetch(`${base}?cliente_id=eq.${encodeURIComponent(clienteId)}&colecao=eq.custo_catalogo&select=dados,versao`, { headers: H, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('Não consegui salvar o custo');
    const row = (await r.json())[0];
    const dados = aplicarIds(row?.dados, pares);
    const agora = new Date().toISOString();
    if (!row) {
      const ins = await fetch(base, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ cliente_id: clienteId, colecao: 'custo_catalogo', dados, versao: 1, atualizado_em: agora }),
        signal: AbortSignal.timeout(10000),
      });
      if (ins.status === 409) continue;
      if (!ins.ok) throw new Error('Não consegui salvar o custo');
      return dados;
    }
    const w = await fetch(`${base}?cliente_id=eq.${encodeURIComponent(clienteId)}&colecao=eq.custo_catalogo&versao=eq.${encodeURIComponent(row.versao)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ dados, versao: Number(row.versao) + 1, atualizado_em: agora }),
      signal: AbortSignal.timeout(10000),
    });
    if (!w.ok) throw new Error('Não consegui salvar o custo');
    const gravou = await w.json();
    if (Array.isArray(gravou) && gravou.length) return dados;
  }
  throw new Error('Não consegui salvar o custo. Tente de novo.');
}

module.exports = { aplicarIds, fundirCatalogo, fundirColecao };
