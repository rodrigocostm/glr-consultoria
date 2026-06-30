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
  'glr_mc_vinculos', 'glr_mc_nicknames', 'glr_portal_configs'
];

// ── Intercepta localStorage.setItem para sincronizar com Supabase ──
// Toda vez que qualquer parte do sistema salva no localStorage,
// automaticamente também salva no Supabase — sem alterar nenhum outro arquivo.
const _localSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function(key, value) {
  _localSetItem(key, value); // salva local normalmente
  if (GLR_KEYS.includes(key)) {
    try {
      const dados = JSON.parse(value);
      _sb.from('glr_storage')
        .upsert({ chave: key, dados, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' })
        .then(({ error }) => { if (error) console.warn('[Supabase] Erro sync:', error.message); });
    } catch(e) {}
  }
};

// ── Carrega todos os dados do Supabase para o localStorage local ──
async function sincronizarDoSupabase() {
  const { data, error } = await _sb.from('glr_storage').select('chave, dados');
  if (error) { console.warn('[Supabase] Erro ao carregar:', error.message); return; }
  if (data?.length) {
    data.forEach(row => _localSetItem(row.chave, JSON.stringify(row.dados)));
    console.log(`[Supabase] ${data.length} coleções sincronizadas.`);
  }
}

// ── Real-time: atualiza quando outro usuário salvar algo ──
function ativarRealtime() {
  _sb.channel('glr_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'glr_storage' }, payload => {
      if (payload.new?.chave && payload.new?.dados) {
        _localSetItem(payload.new.chave, JSON.stringify(payload.new.dados));
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

// ── Tela de Login ─────────────────────────────────────────────
function mostrarLogin(erroMsg) {
  document.getElementById('glr-login-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'glr-login-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:#0d0d14;
    display:flex;align-items:center;justify-content:center;z-index:9999;
    font-family:'Inter',sans-serif;
  `;
  overlay.innerHTML = `
    <div style="background:#16161f;border:1px solid rgba(255,255,255,0.07);border-radius:20px;
                padding:44px 40px;width:100%;max-width:420px;box-shadow:0 32px 80px rgba(0,0,0,0.6);">

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

  // Login OK — sincroniza dados e inicia sistema
  await sincronizarDoSupabase();
  document.getElementById('glr-login-overlay')?.remove();
  ativarRealtime();

  // Detecta se é cliente do portal ou admin GLR
  const portalCfg = await _detectarPortalCliente(email);
  if (portalCfg) {
    // Cliente do portal — mostra apenas páginas permitidas
    atualizarSidebarUsuario();
    if (typeof window._initPortalCliente === 'function') window._initPortalCliente(portalCfg);
    return;
  }

  // Admin normal
  atualizarSidebarUsuario();
  if (typeof carregarDadosSalvos === 'function') carregarDadosSalvos();
  if (typeof Router !== 'undefined' && typeof Router.resolve === 'function') Router.resolve();
  if (typeof atualizarBadges === 'function') atualizarBadges();
};

// ── Fazer Logout ──────────────────────────────────────────────
window.fazerLogout = async function() {
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

// ── Inicialização ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const { data: { session } } = await _sb.auth.getSession();

  if (!session) {
    mostrarLogin();
    return;
  }

  // Já está logado — sincroniza e inicia
  await sincronizarDoSupabase();
  ativarRealtime();

  const userEmail = session.user?.email || '';
  const portalCfg = await _detectarPortalCliente(userEmail);
  if (portalCfg) {
    atualizarSidebarUsuario();
    if (typeof window._initPortalCliente === 'function') window._initPortalCliente(portalCfg);
    return;
  }

  atualizarSidebarUsuario();
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
