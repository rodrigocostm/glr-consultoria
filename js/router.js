// ============================================================
// GLR Consultoria — SPA Router
// ============================================================

const Router = {
  routes: {},
  currentPage: null,
  currentParams: {},

  register(path, handler) {
    this.routes[path] = handler;
  },

  navigate(path, params = {}) {
    this.currentParams = params;
    window.location.hash = path;
  },

  init() {
    window.addEventListener('hashchange', () => this.resolve());
    this.resolve();
  },

  resolve() {
    // Recarrega dados do localStorage a cada navegação
    if (typeof carregarDadosSalvos === 'function') carregarDadosSalvos();

    const hash = window.location.hash.replace('#', '') || 'dashboard';
    const [path, queryStr] = hash.split('?');

    // Parse query params
    const params = {};
    if (queryStr) {
      queryStr.split('&').forEach(p => {
        const [k, v] = p.split('=');
        params[k] = decodeURIComponent(v);
      });
    }

    this.currentParams = { ...this.currentParams, ...params };
    this.currentPage = path;

    // Update sidebar active state
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.page === path);
    });

    // Update header title
    const titles = {
      dashboard: 'Dashboard Executivo',
      clientes: 'Gestão de Clientes',
      'cliente-perfil': 'Perfil do Cliente',
      projecao: 'Projeção de Crescimento',
      timeline: 'Timeline de Ações',
      tarefas: 'Gestão de Tarefas',
      calendario: 'Calendário Operacional',
      score: 'Score GLR',
      oportunidades: 'Central de Oportunidades',
      alertas: 'Central de Alertas',
      dre: 'DRE — Demonstração do Resultado',
      relatorios: 'Relatórios',
      diretoria: 'Dashboard da Diretoria',
      ia: 'Inteligência Artificial',
    };
    document.getElementById('page-title').textContent = titles[path] || 'GLR Consultoria';

    // Render page
    const content = document.getElementById('page-content');
    if (this.routes[path]) {
      content.innerHTML = '';
      this.routes[path](this.currentParams, content);
    } else {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-title">Página não encontrada</div></div>`;
    }
  }
};
