// ============================================================
// GLR Consultoria — Integração Supabase
// Substitui localStorage por banco na nuvem com autenticação
// ============================================================

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJyb2RxbGVqcXlhb29tdXRyaWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjU5NjUsImV4cCI6MjA5NjQ0MTk2NX0.JaKQHoGH8S3ZdLQInLErpC21SZ0j4FmIGtvWKcBes-A';

// Cliente Supabase global
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

// Chaves gerenciadas pelo sistema
const GLR_KEYS = [
  'glr_clientes', 'glr_gestores', 'glr_tarefas', 'glr_acoes',
  'glr_alertas', 'glr_oportunidades', 'glr_projecoes', 'glr_dre',
  'glr_mc_vinculos', 'glr_mc_nicknames', 'glr_portal_configs',
  'glr_vendas_custos',  // custo de produto lançado no admin — precisa chegar no portal do cliente
  'glr_aliquotas',      // % de imposto padrão por conta
  'glr_vendas_linhas',  // linhas extras de custo/desconto lançadas no admin
  'glr_mc_apikey',      // API Key do Marketplace Connect — precisa funcionar em qualquer PC do admin
  'glr_vendas_cache',   // pedidos já buscados na página Vendas — evita rebuscar em outro PC
  'glr_fin_cache',      // pedidos + ADS já buscados no Financeiro — evita rebuscar em outro PC
  'glr_mc_contas',      // lista de contas conectadas do Marketplace Connect
  'glr_analytics_dados', // painel executivo Analytics — meta/projeção/ADS por cliente (cache do mês)
  'glr_analytics_queda', // produtos em queda detectados pelo Analytics
  'glr_plano_acao',      // plano de ação (Analytics) — editorial, não vem de API
  'glr_checklist_diario', // checklist diário (Analytics) — editorial, não vem de API
];

// ── Intercepta localStorage.setItem para sincronizar com Supabase ──
// Toda vez que qualquer parte do sistema salva no localStorage,
// automaticamente também salva no Supabase — sem alterar nenhum outro arquivo.
const _localSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function(key, value) {
  _localSetItem(key, value); // salva local normalmente
  if (GLR_KEYS.includes(key)) {
    // Nem todo valor salvo é JSON (ex: glr_mc_apikey é uma string simples,
    // não "aspas-envolvida") — se JSON.parse falhar, sobe o valor cru mesmo
    let dados;
    try { dados = JSON.parse(value); } catch(e) { dados = value; }
    _sb.from('glr_storage')
      .upsert({ chave: key, dados, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' })
      .then(({ error }) => { if (error) console.warn('[Supabase] Erro sync:', error.message); });
  }
};

// Converte o valor vindo do Supabase de volta pro formato que o localStorage
// espera: string simples fica como está, objeto/array vira JSON.stringify
const _paraLocalStorage = dados => typeof dados === 'string' ? dados : JSON.stringify(dados);

// ── Carrega todos os dados do Supabase para o localStorage local ──
async function sincronizarDoSupabase() {
  const { data, error } = await _sb.from('glr_storage').select('chave, dados');
  if (error) { console.warn('[Supabase] Erro ao carregar:', error.message); return; }
  if (data?.length) {
    data.forEach(row => _localSetItem(row.chave, _paraLocalStorage(row.dados)));
    console.log(`[Supabase] ${data.length} coleções sincronizadas.`);
  }
  // Chaves que já existiam localmente mas nunca foram salvas desde que entraram no
  // GLR_KEYS (ex: dado antigo cadastrado antes do sync existir) — empurra pro Supabase
  // uma única vez, re-chamando o setItem interceptado.
  const chavesNoServidor = new Set((data||[]).map(r => r.chave));
  GLR_KEYS.forEach(key => {
    if (chavesNoServidor.has(key)) return;
    const local = localStorage.getItem(key);
    if (local != null) localStorage.setItem(key, local); // dispara o interceptor, empurra pro Supabase
  });
}

// ── Real-time: atualiza quando outro usuário salvar algo ──
function ativarRealtime() {
  _sb.channel('glr_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'glr_storage' }, payload => {
      if (payload.new?.chave && payload.new?.dados != null) {
        _localSetItem(payload.new.chave, _paraLocalStorage(payload.new.dados));
        if (typeof carregarDadosSalvos === 'function') carregarDadosSalvos();
        // Mostra notificação discreta
        mostrarNotifSync(payload.new.chave);
      }
    })
    .subscribe();
}

function mostrarNotifSync(chave) {
  const mapa = {
    glr_clientes: 'Clientes', glr_gestores: 'Gestores', glr_tarefas: 'Tarefas',
    glr_projecoes: 'Projeções', glr_dre: 'DRE', glr_alertas: 'Alertas',
  };
  const nome = mapa[chave];
  if (!nome) return;
  const notif = document.createElement('div');
  notif.style.cssText = `
    position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
    background:#16161f;border:1px solid rgba(99,102,241,0.3);border-radius:8px;
    padding:8px 16px;font-size:13px;color:#9192a8;z-index:9998;
    display:flex;align-items:center;gap:8px;box-shadow:0 4px 20px rgba(0,0,0,0.3);
    animation:fadeInUp 0.2s ease;
  `;
  notif.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:#10b981;flex-shrink:0;"></span> ${nome} atualizados por outro usuário`;
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), 3000);
}

// ── Página de Vendas (institucional, aparece antes do login) ──
const WHATSAPP_NUMERO = '5517992117263';

function mostrarVendas() {
  document.getElementById('glr-login-overlay')?.remove();
  document.getElementById('glr-vendas-overlay')?.remove();

  const waLink = msg => `https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(msg)}`;

  const overlay = document.createElement('div');
  overlay.id = 'glr-vendas-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:#0d0d14;z-index:9999;
    overflow-y:auto;font-family:'Inter',sans-serif;color:#f1f1f8;
  `;

  const funcionalidades = [
    { ico: '📊', titulo: 'Dashboard Executivo', desc: 'Visão consolidada da carteira, metas, crescimento e risco de cada cliente em um só lugar.' },
    { ico: '💰', titulo: 'Financeiro & DRE automático', desc: 'DRE calculado direto das taxas reais do Mercado Livre e Shopee, sem planilha manual.' },
    { ico: '📢', titulo: 'Central de ADS', desc: 'Acompanhe investimento, ROAS e TACoS das campanhas em todas as contas conectadas.' },
    { ico: '✅', titulo: 'Conciliação Financeira', desc: 'Confere pedido a pedido se a taxa calculada bate com o que a API realmente descontou, e quando o dinheiro cai na carteira.' },
    { ico: '🛒', titulo: 'Vendas & Oportunidades', desc: 'Pedidos, produtos parados e oportunidades de ADS identificados automaticamente.' },
    { ico: '🔐', titulo: 'Portal do Cliente', desc: 'Cada cliente acompanha as próprias vendas e resultados com login e dados isolados.' },
  ];

  const planos = [
    { nome: 'Starter', preco: 'R$ 497/mês', desc: 'Para quem está começando a organizar a operação.',
      itens: ['Até 2 contas conectadas', 'Dashboard e Vendas', 'Financeiro básico', 'Suporte por WhatsApp'], destaque: false },
    { nome: 'Pro', preco: 'R$ 997/mês', desc: 'Operação em crescimento, com múltiplos canais.',
      itens: ['Até 6 contas conectadas', 'DRE automático completo', 'Central de ADS', 'Conciliação Financeira', 'Portal do Cliente'], destaque: true },
    { nome: 'Enterprise', preco: 'Sob consulta', desc: 'Operações grandes ou com necessidades específicas.',
      itens: ['Contas ilimitadas', 'Tudo do plano Pro', 'Gestor dedicado', 'Relatórios personalizados'], destaque: false },
  ];

  const depoimentos = [
    { nome: 'Cliente GLR', empresa: 'Loja de Eletrônicos', texto: '“Antes eu perdia horas conferindo planilha de taxa do Mercado Livre. Hoje é tudo automático e ainda vejo onde estou perdendo dinheiro.”' },
    { nome: 'Cliente GLR', empresa: 'Loja de Moda', texto: '“O Portal do Cliente me deixou acompanhar as vendas em tempo real sem precisar ficar pedindo relatório pra equipe.”' },
    { nome: 'Cliente GLR', empresa: 'Loja de Casa & Decoração', texto: '“A Conciliação Financeira encontrou diferenças que a gente nem sabia que existiam entre o esperado e o que caía na carteira.”' },
  ];

  overlay.innerHTML = `
    <div style="max-width:1080px;margin:0 auto;padding:24px 24px 0;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0 32px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <img src="logo.png" alt="GLR" style="width:36px;height:36px;object-fit:contain;mix-blend-mode:screen;"
               onerror="this.style.display='none'">
          <strong style="font-size:16px;font-weight:800;">GLR Consultoria</strong>
        </div>
        <button onclick="window.mostrarLogin()"
          style="padding:9px 20px;background:transparent;border:1px solid rgba(255,255,255,0.15);border-radius:99px;color:#f1f1f8;font-size:13px;font-weight:600;cursor:pointer;">
          Entrar
        </button>
      </div>
    </div>

    <div style="max-width:780px;margin:0 auto;padding:24px 24px 64px;text-align:center;">
      <div style="display:inline-block;padding:6px 14px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.3);border-radius:99px;font-size:12px;font-weight:600;color:#818cf8;margin-bottom:20px;">
        Gestão de Marketplaces
      </div>
      <h1 style="font-size:38px;font-weight:800;line-height:1.15;margin:0 0 16px;letter-spacing:-0.5px;">
        Centro de Operações para quem vende no<br>Mercado Livre e Shopee
      </h1>
      <p style="font-size:16px;color:#9192a8;line-height:1.6;margin:0 0 32px;">
        Financeiro automático, conciliação de taxas, gestão de ADS e portal do cliente —
        tudo em um só painel, sem planilha.
      </p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
        <a href="${waLink('Olá! Quero saber mais sobre o GLR Consultoria.')}" target="_blank" rel="noopener"
          style="padding:14px 26px;background:#16161f;border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#f1f1f8;font-size:14px;font-weight:700;text-decoration:none;">
          💬 Falar no WhatsApp
        </a>
        <button onclick="window.mostrarLogin()"
          style="padding:14px 26px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:10px;color:white;font-size:14px;font-weight:700;cursor:pointer;">
          Entrar no sistema
        </button>
      </div>
    </div>

    <div style="max-width:1080px;margin:0 auto;padding:0 24px 64px;">
      <h2 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 8px;">Tudo que sua operação precisa</h2>
      <p style="text-align:center;font-size:14px;color:#5a5b72;margin:0 0 36px;">Módulos pensados pra quem vive marketplace no dia a dia.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">
        ${funcionalidades.map(f => `
          <div style="background:#16161f;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:24px;">
            <div style="font-size:26px;margin-bottom:12px;">${f.ico}</div>
            <div style="font-size:15px;font-weight:700;margin-bottom:6px;">${f.titulo}</div>
            <div style="font-size:13px;color:#9192a8;line-height:1.5;">${f.desc}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div style="max-width:1080px;margin:0 auto;padding:0 24px 64px;">
      <h2 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 8px;">Planos</h2>
      <p style="text-align:center;font-size:14px;color:#5a5b72;margin:0 0 36px;">Valores de referência — fale com a gente pra encontrar o plano ideal.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">
        ${planos.map(p => `
          <div style="background:${p.destaque?'#1c1c2e':'#16161f'};border:1px solid ${p.destaque?'#6366f1':'rgba(255,255,255,0.07)'};border-radius:16px;padding:28px 24px;position:relative;">
            ${p.destaque ? `<div style="position:absolute;top:-11px;left:24px;background:#6366f1;color:white;font-size:11px;font-weight:700;padding:4px 12px;border-radius:99px;">MAIS POPULAR</div>` : ''}
            <div style="font-size:15px;font-weight:700;margin-bottom:4px;">${p.nome}</div>
            <div style="font-size:26px;font-weight:800;margin-bottom:4px;">${p.preco}</div>
            <div style="font-size:12px;color:#5a5b72;margin-bottom:20px;">${p.desc}</div>
            <div style="display:flex;flex-direction:column;gap:9px;margin-bottom:24px;">
              ${p.itens.map(i => `<div style="font-size:13px;color:#c7c8d8;display:flex;align-items:flex-start;gap:8px;"><span style="color:#10b981;">✓</span>${i}</div>`).join('')}
            </div>
            <a href="${waLink('Olá! Tenho interesse no plano ' + p.nome + ' do GLR Consultoria.')}" target="_blank" rel="noopener"
              style="display:block;text-align:center;padding:11px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;
                     ${p.destaque ? 'background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;' : 'background:transparent;border:1px solid rgba(255,255,255,0.15);color:#f1f1f8;'}">
              Falar com um consultor
            </a>
          </div>
        `).join('')}
      </div>
    </div>

    <div style="max-width:1080px;margin:0 auto;padding:0 24px 64px;">
      <h2 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 36px;">Quem usa, recomenda</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">
        ${depoimentos.map(d => `
          <div style="background:#16161f;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:22px;">
            <div style="font-size:13px;color:#c7c8d8;line-height:1.6;margin-bottom:16px;">${d.texto}</div>
            <div style="font-size:13px;font-weight:700;">${d.nome}</div>
            <div style="font-size:12px;color:#5a5b72;">${d.empresa}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div style="background:linear-gradient(135deg,rgba(99,102,241,0.12),rgba(139,92,246,0.08));border-top:1px solid rgba(255,255,255,0.06);padding:56px 24px;text-align:center;">
      <h2 style="font-size:24px;font-weight:800;margin:0 0 12px;">Pronto para organizar sua operação?</h2>
      <p style="font-size:14px;color:#9192a8;margin:0 0 24px;">Fale com a gente e veja o sistema funcionando na prática.</p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
        <a href="${waLink('Olá! Quero saber mais sobre o GLR Consultoria.')}" target="_blank" rel="noopener"
          style="padding:14px 26px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:10px;color:white;font-size:14px;font-weight:700;text-decoration:none;">
          💬 Falar no WhatsApp
        </a>
        <button onclick="window.mostrarLogin()"
          style="padding:14px 26px;background:transparent;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f1f1f8;font-size:14px;font-weight:700;cursor:pointer;">
          Já sou cliente — Entrar
        </button>
      </div>
    </div>

    <div style="text-align:center;padding:24px;font-size:12px;color:#3a3b50;">
      GLR Consultoria © 2026
    </div>
  `;
  document.body.appendChild(overlay);
}

// ── Tela de Login ─────────────────────────────────────────────
function mostrarLogin(erroMsg) {
  document.getElementById('glr-login-overlay')?.remove();
  document.getElementById('glr-vendas-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'glr-login-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:#0d0d14;
    display:flex;align-items:center;justify-content:center;z-index:9999;
    font-family:'Inter',sans-serif;
  `;
  overlay.innerHTML = `
    <div style="background:#16161f;border:1px solid rgba(255,255,255,0.07);border-radius:20px;
                padding:44px 40px;width:100%;max-width:420px;box-shadow:0 32px 80px rgba(0,0,0,0.6);position:relative;">

      <button onclick="window.mostrarVendas()" title="Voltar"
        style="position:absolute;top:20px;left:20px;background:none;border:none;color:#5a5b72;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:4px;">
        ← Voltar
      </button>

      <div style="text-align:center;margin-bottom:36px;">
        <div style="width:80px;height:80px;margin:0 auto 16px;overflow:hidden;">
          <img src="logo.png" alt="GLR" style="width:80px;height:80px;object-fit:contain;mix-blend-mode:screen;"
               onerror="this.parentElement.innerHTML='<span style=\'font-size:22px;font-weight:800;color:white;letter-spacing:-1px;\'>GLR</span>'">
        </div>
        <h1 style="font-size:22px;font-weight:800;color:#f1f1f8;margin:0 0 6px;">GLR Consultoria</h1>
        <p style="font-size:14px;color:#5a5b72;margin:0;">Centro de Operações</p>
      </div>

      ${erroMsg ? `
        <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:8px;
                    padding:10px 14px;margin-bottom:20px;font-size:13px;color:#ef4444;text-align:center;">
          ${erroMsg}
        </div>` : ''}

      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:11px;font-weight:600;color:#5a5b72;
                      text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">E-mail</label>
        <input id="glr-email" type="email" placeholder="seu@email.com" autocomplete="email"
          style="width:100%;padding:11px 14px;background:#0d0d14;border:1px solid rgba(255,255,255,0.08);
                 border-radius:10px;color:#f1f1f8;font-size:14px;outline:none;box-sizing:border-box;transition:border .15s;"
          onfocus="this.style.borderColor='#6366f1'" onblur="this.style.borderColor='rgba(255,255,255,0.08)'">
      </div>

      <div style="margin-bottom:28px;">
        <label style="display:block;font-size:11px;font-weight:600;color:#5a5b72;
                      text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">Senha</label>
        <input id="glr-senha" type="password" placeholder="••••••••" autocomplete="current-password"
          style="width:100%;padding:11px 14px;background:#0d0d14;border:1px solid rgba(255,255,255,0.08);
                 border-radius:10px;color:#f1f1f8;font-size:14px;outline:none;box-sizing:border-box;transition:border .15s;"
          onfocus="this.style.borderColor='#6366f1'" onblur="this.style.borderColor='rgba(255,255,255,0.08)'"
          onkeydown="if(event.key==='Enter') window.fazerLogin()">
      </div>

      <button id="glr-login-btn" onclick="window.fazerLogin()"
        style="width:100%;padding:13px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;
               border-radius:10px;color:white;font-size:15px;font-weight:700;cursor:pointer;
               transition:opacity .15s;letter-spacing:0.2px;">
        Entrar
      </button>

      <p style="text-align:center;margin:20px 0 0;font-size:12px;color:#3a3b50;">
        GLR Consultoria © 2026
      </p>
    </div>

    <style>
      @keyframes fadeInUp {
        from { opacity:0; transform:translateX(-50%) translateY(8px); }
        to   { opacity:1; transform:translateX(-50%) translateY(0); }
      }
    </style>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('glr-email')?.focus(), 100);
}

// ── Fazer Login ───────────────────────────────────────────────
window.fazerLogin = async function() {
  const email = document.getElementById('glr-email')?.value?.trim();
  const senha = document.getElementById('glr-senha')?.value;
  const btn   = document.getElementById('glr-login-btn');

  if (!email || !senha) { mostrarLogin('Preencha e-mail e senha.'); return; }

  if (btn) { btn.textContent = 'Entrando...'; btn.disabled = true; btn.style.opacity = '0.7'; }

  const { error } = await _sb.auth.signInWithPassword({ email, password: senha });

  if (error) {
    mostrarLogin('E-mail ou senha incorretos. Tente novamente.');
    return;
  }

  // Verifica tipo ANTES de expor qualquer conteúdo
  const portalCfg = await _detectarPortalCliente(email);

  document.getElementById('glr-login-overlay')?.remove();

  if (portalCfg) {
    // Cliente do portal — NÃO sincroniza dados admin, NÃO ativa realtime admin
    atualizarSidebarUsuario();
    if (typeof window._initPortalCliente === 'function') await window._initPortalCliente(portalCfg);
    return;
  }

  // Admin GLR — limpa qualquer estado do portal e inicia normalmente
  window._portalConfig = null;
  await sincronizarDoSupabase();
  ativarRealtime();
  atualizarSidebarUsuario();
  if (typeof carregarDadosSalvos === 'function') carregarDadosSalvos();
  if (typeof Router !== 'undefined') {
    const rotasPortal = ['portal-dashboard','portal-vendas','curva-abc'];
    const hashAtual = window.location.hash.replace('#','');
    if (rotasPortal.includes(hashAtual)) Router.navigate('dashboard');
    else if (typeof Router.resolve === 'function') Router.resolve();
  }
  if (typeof atualizarBadges === 'function') atualizarBadges();
};

// ── Fazer Logout ──────────────────────────────────────────────
window.fazerLogout = async function() {
  window._portalConfig = null;
  await _sb.auth.signOut();
  GLR_KEYS.forEach(k => localStorage.removeItem(k));
  mostrarLogin();
};

// ── Atualiza sidebar com info do usuário logado ───────────────
async function atualizarSidebarUsuario() {
  const { data: { user } } = await _sb.auth.getUser();
  if (!user) return;

  const emailCurto = user.email.split('@')[0];
  const iniciais   = emailCurto.slice(0,2).toUpperCase();

  const avatar = document.querySelector('#sidebar .user-avatar');
  const nome   = document.querySelector('#sidebar .user-info strong');
  const cargo  = document.querySelector('#sidebar .user-info span');
  const headerAvatar = document.querySelector('#header .header-actions div[style*="border-radius:50%"]');

  if (avatar) avatar.textContent = iniciais;
  if (nome)   nome.textContent   = emailCurto;
  if (cargo)  cargo.textContent  = user.email;
  if (headerAvatar) headerAvatar.textContent = iniciais;
}

// ── Revela o app e remove o overlay de loading ──
// O overlay e o #app{visibility:hidden} estão no HTML/CSS, bloqueando desde o início.
function _ocultarLoadingInicial() {
  document.getElementById('glr-loading-inicial')?.remove();
  const app = document.getElementById('app');
  if (app) app.style.visibility = 'visible';
}

// ── Inicialização ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // O overlay e #app{visibility:hidden} já estão no HTML — não precisamos criar nada.
  // Qualquer erro aqui revelaria uma tela em branco; o try/finally garante fallback.
  try {
    const { data: { session } } = await _sb.auth.getSession();

    if (!session) {
      _ocultarLoadingInicial();
      mostrarVendas();
      return;
    }

    const userEmail = session.user?.email || '';

    // Verifica tipo ANTES de sincronizar qualquer dado admin
    const portalCfg = await _detectarPortalCliente(userEmail);

    if (portalCfg) {
      // Cliente do portal — NUNCA sincroniza dados admin, NUNCA ativa realtime admin
      _ocultarLoadingInicial();
      atualizarSidebarUsuario();
      if (typeof window._initPortalCliente === 'function') await window._initPortalCliente(portalCfg);
      return;
    }

    // Admin GLR — limpa qualquer estado do portal e inicia normalmente
    window._portalConfig = null;
    await sincronizarDoSupabase();
    ativarRealtime();
    _ocultarLoadingInicial();
    atualizarSidebarUsuario();
    if (typeof Router !== 'undefined') {
      const rotasPortal = ['portal-dashboard','portal-vendas','curva-abc'];
      const hashAtual = window.location.hash.replace('#','');
      if (rotasPortal.includes(hashAtual)) Router.navigate('dashboard');
    }

  } catch (err) {
    console.error('[GLR] Erro na inicialização:', err);
    _ocultarLoadingInicial();
    mostrarLogin('Erro ao inicializar. Tente novamente.');
  }
});

// ── Detecta se email é de cliente do portal ───────────────────
async function _detectarPortalCliente(email) {
  try {
    // Tenta localStorage primeiro
    let configs = JSON.parse(localStorage.getItem('glr_portal_configs')||'[]');

    // Se não encontrou, busca direto no Supabase (garante dados frescos)
    if (!configs.length) {
      const { data } = await _sb.from('glr_storage').select('dados').eq('chave','glr_portal_configs').single();
      if (data?.dados) {
        configs = Array.isArray(data.dados) ? data.dados : [];
        localStorage.setItem('glr_portal_configs', JSON.stringify(configs));
      }
    }

    const cfg = configs.find(c => c.email?.toLowerCase() === email?.toLowerCase() && c.ativo !== false);
    return cfg || null;
  } catch { return null; }
}
