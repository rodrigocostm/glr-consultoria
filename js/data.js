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
GLR.nextId = (arr) => arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1;
