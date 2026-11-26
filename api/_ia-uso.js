// ============================================================
// GLR Consultoria — Uso e custo da IA (Anthropic)
// ------------------------------------------------------------
// 1) medir(client, origem, extra): embrulha um cliente do SDK para que cada
//    chamada (create ou stream, normal ou beta) grave os tokens em glr_ia_uso
//    (supabase-ia-uso.sql). Nunca atrasa nem derruba a resposta: a gravação
//    vai em segundo plano e qualquer falha é ignorada.
// 2) registrar(...): o mesmo, para quem chama a API por fetch.
// 3) cacheNaConversa(mensagens): marca o fim da conversa para o cache de
//    prompt. Nas rodadas de ferramentas o modelo relê tudo a cada volta; com a
//    marca, o que já foi lido sai a ~10% do preço na rodada seguinte.
// ============================================================
const URL = 'https://rrodqlejqyaoomutriiw.supabase.co/rest/v1/glr_ia_uso';

const num = v => (Number.isFinite(v) ? Math.round(v) : 0);
const corta = (s, n) => (s == null ? null : String(s).slice(0, n));

function linha(origem, modelo, usage, extra) {
  const u = usage || {}, x = extra || {};
  const { usuario, conta_id, ...resto } = x;
  return {
    origem: corta(origem, 60) || 'desconhecida',
    modelo: corta(modelo, 80),
    entrada: num(u.input_tokens),
    saida: num(u.output_tokens),
    cache_leitura: num(u.cache_read_input_tokens),
    cache_escrita: num(u.cache_creation_input_tokens),
    usuario: corta(usuario, 200),
    conta_id: corta(conta_id, 80),
    extra: Object.keys(resto).length ? resto : null,
  };
}

// Deixa a gravação terminar depois da resposta (Vercel); fora dela só segue.
function emSegundoPlano(p) {
  try { require('@vercel/functions').waitUntil(p); } catch (e) { /* fora da Vercel */ }
  return p;
}

function registrar(origem, modelo, usage, extra) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !usage) return Promise.resolve(false);
  const p = fetch(URL, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify([linha(origem, modelo, usage, extra)]),
    signal: AbortSignal.timeout(5000),
  }).then(r => r.ok).catch(() => false);
  return emSegundoPlano(p);
}

function embrulhar(api, origem, extra) {
  if (!api || api.__glrMedido) return;
  const anota = m => { try { if (m?.usage) registrar(origem, m.model, m.usage, extra); } catch (e) {} };
  if (typeof api.create === 'function') {
    const create = api.create.bind(api);
    api.create = (...args) => {
      const r = create(...args);
      // create devolve uma promise "turbinada" do SDK; só observamos o resultado
      if (!args[0]?.stream && r && typeof r.then === 'function') r.then(anota, () => {});
      return r;
    };
  }
  if (typeof api.stream === 'function') {
    const stream = api.stream.bind(api);
    api.stream = (...args) => {
      const s = stream(...args);
      try { s?.on?.('finalMessage', anota); } catch (e) {}
      return s;
    };
  }
  api.__glrMedido = true;
}

// Mede todas as chamadas deste cliente. Devolve o próprio cliente.
function medir(client, origem, extra) {
  if (!client) return client;
  try { embrulhar(client.messages, origem, extra); } catch (e) {}
  try { embrulhar(client.beta?.messages, origem, extra); } catch (e) {}
  return client;
}

// Cópia das mensagens com a marca de cache no último bloco (não altera o original)
function cacheNaConversa(mensagens) {
  if (!Array.isArray(mensagens) || !mensagens.length) return mensagens;
  const copia = mensagens.slice();
  const ult = copia[copia.length - 1];
  if (!ult || !ult.content) return mensagens;
  const blocos = typeof ult.content === 'string' ? [{ type: 'text', text: ult.content }] : ult.content.slice();
  if (!blocos.length) return mensagens;
  const fim = blocos[blocos.length - 1];
  if (!fim || (fim.type === 'text' && !fim.text)) return mensagens;
  blocos[blocos.length - 1] = { ...fim, cache_control: { type: 'ephemeral' } };
  copia[copia.length - 1] = { ...ult, content: blocos };
  return copia;
}

module.exports = { medir, registrar, cacheNaConversa, linha };
