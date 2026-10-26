// ============================================================
// GLR Consultoria — Dados do Sistema (em branco para inserção)
// ============================================================

const GLR = {};

GLR.clientes     = [];
GLR.gestores     = [];
GLR.tarefas      = [];
GLR.eventos      = [];
GLR.acoes        = [];
GLR.oportunidades = [];
GLR.alertas      = [];
GLR.projecao     = { metaAnual: 0, realizadoAcumulado: 0, crescimentoEsperado: 0, meses: [], porCliente: [] };
GLR.evolucaoCarteira = [];
GLR.kpisDiretoria = {
  receitaConsultoria: 0, mrr: 0, churnRate: 0, nps: 0,
  clientesAtivos: 0, crescimentoMedioCarteira: 0,
  tasksConcluidas: 0, tasksPendentes: 0, retencao: 0,
};

// ---- Helpers ----
GLR.formatCurrency = (v) => {
  if (!v) return 'R$ 0';
  return v >= 1000000
    ? `R$ ${(v / 1000000).toFixed(1)}M`
    : v >= 1000 ? `R$ ${(v / 1000).toFixed(0)}k` : `R$ ${v}`;
};

GLR.formatCurrencyFull = (v) =>
  `R$ ${(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

GLR.statusLabel = { crescimento: 'Crescimento', ativo: 'Ativo', queda: 'Queda', risco: 'Risco' };
GLR.statusColor  = {
  crescimento: 'status-crescimento',
  ativo:       'status-ativo',
  queda:       'status-queda',
  risco:       'status-risco',
};

GLR.prioridadeColor = {
  urgente: 'prio-urgente',
  alta:    'prio-alta',
  media:   'prio-media',
  baixa:   'prio-baixa',
};

// Comissão GLR por conta: o valor por venda só conta nas contas marcadas como "conta comissão".
// Guarda só as exceções ({ id_da_conta: false }); conta sem registro conta comissão.
GLR.comissaoContas = () => { try { return JSON.parse(localStorage.getItem('glr_comissao_contas') || '{}'); } catch (e) { return {}; } };
GLR.contaGeraComissao = conta => {
  const m = GLR.comissaoContas();
  const ids = conta && typeof conta === 'object'
    ? [conta.external_id, conta.contaId, conta.param_to_use?.shopId, conta.param_to_use?.meliUserId, conta.param_to_use?.magalu_account_id, conta.id]
    : [conta];
  return !ids.some(i => i != null && i !== '' && m[String(i)] === false);
};
// Linha da Projeção: com conta definida usa a conta; por plataforma, só fica fora se todas as contas daquela plataforma estão fora
GLR.linhaGeraComissao = (clienteId, linha) => {
  if (!linha) return true;
  if (linha.contaId) return GLR.contaGeraComissao(linha.contaId);
  const plat = x => { x = String(x || '').toLowerCase(); return /meli|mercado|^ml$/.test(x) ? 'ml' : /shopee/.test(x) ? 'shopee' : /amazon/.test(x) ? 'amazon' : /magalu/.test(x) ? 'magalu' : /tiktok/.test(x) ? 'tiktok' : /shein/.test(x) ? 'shein' : x; };
  let vinc = {}; try { vinc = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch (e) {}
  const alvo = plat(linha.marketplace || linha._platNome || linha.nome);
  const contas = (vinc[String(clienteId)] || []).filter(c => plat(c.marketplace) === alvo);
  return !contas.length || contas.some(c => GLR.contaGeraComissao(c));
};

// Nome de uma conta de marketplace para mostrar nas telas: "Cliente · ML Etiqueta".
// Usa o vínculo cliente ↔ conta e a etiqueta (tag) da conta conectada; o apelido
// genérico ("Mercado Livre 123…") é ignorado. Calcule na hora de mostrar — os
// clientes carregam do banco depois que a tela abre.
GLR.nomeConta = (mkt, id) => {
  id = String(id || '');
  const ler = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const vinc = ler('glr_mc_vinculos') || {}, contas = ler('glr_mc_contas'), nicks = ler('glr_mc_nicknames') || {};
  const ids = c => [c?.external_id, c?.param_to_use?.shopId, c?.param_to_use?.meliUserId, c?.param_to_use?.amazon_account_id, c?.param_to_use?.magalu_account_id, c?.param_to_use?.shein_supplier_id, c?.contaId].filter(Boolean).map(String);
  const generico = n => !n || /^(mercado ?livre|meli|ml|shopee|amazon|magalu|tiktok( shop)?|shein)\s*[\d-]*$/i.test(String(n).trim());
  const limpa = n => String(n || '').replace(/\s*[-–]\s*(mercado ?livre|ml|shopee|amazon|magalu|tiktok|shein)\s*$/i, '').trim();
  let cli = null, ct = null;
  for (const [cid, lista] of Object.entries(vinc)) { const x = (lista || []).find(c => ids(c).includes(id)); if (x) { ct = x; cli = (GLR.clientes || []).find(c => String(c.id) === String(cid)) || null; break; } }
  const conn = (Array.isArray(contas) ? contas : []).find(c => ids(c).includes(id));
  const m = String(mkt || ct?.marketplace || conn?.marketplace || '').toLowerCase();
  const MK = { ml: 'ML', meli: 'ML', mercadolivre: 'ML', shopee: 'Shopee', amazon: 'Amazon', magalu: 'Magalu', tiktok: 'TikTok', shein: 'Shein' }[m] || '';
  const etiqueta = [ct, conn].map(c => c?.tags?.find?.(t => t && t.name)?.name).find(Boolean);
  const apelido = [nicks[id], ct?.nickname, conn?.nickname].find(n => !generico(n));
  const conta = limpa(etiqueta || apelido || '');
  if (cli) return `${cli.nome} · ${MK}${conta && conta.toLowerCase() !== String(cli.nome).toLowerCase() ? ' ' + conta : ''}`.trim();
  return conta ? `${conta}${MK ? ' · ' + MK : ''} (sem cliente)` : `${MK || 'Conta'} ${id} (sem cliente)`;
};
// Chama fn quando a lista de clientes já carregou do banco (ou depois de 10 s)
GLR.quandoClientes = fn => { let n = 0; const t = () => ((GLR.clientes || []).length || ++n > 20) ? fn() : setTimeout(t, 500); t(); };

GLR.tipoAcaoColor = {
  Reunião: '#6366f1', Campanha: '#f59e0b', Otimização: '#10b981',
  Precificação: '#3b82f6', Estratégia: '#8b5cf6', Análise: '#06b6d4',
  Onboarding: '#84cc16', Relatório: '#ec4899', Catálogo: '#f97316',
  NPS: '#14b8a6', Interno: '#94a3b8',
};

GLR.alertaTipoColor = {
  risco: '#ef4444', queda: '#f97316', meta: '#f59e0b',
  atrasada: '#8b5cf6', positivo: '#10b981',
};

GLR.alertaTipoLabel = {
  risco: 'Risco', queda: 'Queda', meta: 'Meta', atrasada: 'Atrasada', positivo: 'Positivo',
};

GLR.eventoColor = {
  reuniao: '#6366f1', followup: '#f59e0b', entrega: '#10b981',
  visita: '#06b6d4', interno: '#8b5cf6',
};

// ---- Próximo ID auto-incremento ----
// Ações e tarefas são criadas por vários analistas ao mesmo tempo: "maior id + 1"
// gerava o MESMO id em dois navegadores e um registro sobrescrevia o outro.
// Para essas listas o id é único (data/hora em ms × 100 + sorteio).
GLR.nextId = (arr) => {
  const max = arr.length ? Math.max(...arr.map(x => parseInt(x.id) || 0)) : 0;
  if (arr === GLR.acoes || arr === GLR.tarefas) return Math.max(max + 1, Date.now() * 100 + Math.floor(Math.random() * 100));
  return max + 1;
};

// ---- Log de alterações (auditoria) ----
// Registro genérico de "quem mudou o quê" — usado hoje pela tela de
// Integrações (API key, vínculos, apelidos, alíquotas, importações), mas
// fica em data.js pra qualquer outra página poder chamar registrarLog()
// no futuro sem depender de pages-integracoes.js.
GLR.logs = [];
async function registrarLog(acao, detalhes) {
  try {
    let usuario = 'desconhecido';
    try {
      const { data } = await _sb.auth.getUser();
      usuario = data?.user?.email || usuario;
    } catch(e) {}
    let logs = [];
    try { logs = JSON.parse(localStorage.getItem('glr_logs') || '[]'); } catch(e) {}
    logs.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      data: new Date().toISOString(),
      usuario,
      acao,
      detalhes: detalhes || '',
    });
    if (logs.length > 500) logs = logs.slice(0, 500); // limite pra não crescer sem fim
    GLR.logs = logs;
    localStorage.setItem('glr_logs', JSON.stringify(logs));
    if (typeof window._logAtualizarTela === 'function') window._logAtualizarTela();
  } catch(e) { console.warn('[Log] erro ao registrar', e); }
}
window.registrarLog = registrarLog;
