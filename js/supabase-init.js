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

// Sends the session only to same-origin application API routes.
window.glrApiFetch = async function(input, init = {}) {
  const url = new URL(input, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) throw new Error('Destino de API inválido');
  const { data } = await _sb.auth.getSession();
  if (!data?.session?.access_token) throw new Error('Sessão expirada. Entre novamente.');
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${data.session.access_token}`);
  return fetch(url.href, { ...init, headers });
};

// Chaves gerenciadas pelo sistema
const GLR_KEYS = [
  'glr_clientes', 'glr_gestores', 'glr_tarefas', 'glr_acoes', 'glr_produtos',
  'glr_alertas', 'glr_oportunidades', 'glr_projecoes', 'glr_dre',
  'glr_mc_vinculos', 'glr_mc_nicknames', 'glr_portal_configs',
  'glr_vendas_custos',  // custo de produto lançado no admin — precisa chegar no portal do cliente
  'glr_vendas_custo_catalogo', // custo unitário fixo por produto (SKU/itemId) — aplica a pedidos antigos e novos
  'glr_aliquotas',      // % de imposto padrão por conta
  'glr_comissao_contas', // contas que NÃO contam comissão GLR ({ id: false })
  'glr_margem_minima',   // margem mínima de lucro por conta (agente de Margem → ACOS alvo)
  'glr_metas',           // meta de faturamento por cliente (Gestores, Projeção, Plano de ação) — o Gerente lê no servidor
  'glr_metas_pedidos',   // meta de pedidos por cliente (Plano de ação)
  'glr_metas_tacos',     // teto de ADS (TACOS %) por cliente (Plano de ação) — os agentes de ADS não aceleram acima dele
  'glr_contratos',       // contrato do cliente: perfil (crescer/equilíbrio/lucrar) e autonomia do agente — o agente lê no servidor
  'glr_plano_status',    // Plano de ação: ação feita / virou tarefa / descartada (Gerente de Conta)
  'glr_vendas_linhas',  // linhas extras de custo/desconto lançadas no admin
  'glr_fin_manual',     // lançamentos manuais do Financeiro (antes ficavam só no navegador de quem lançou)
  'glr_mc_apikey',      // API Key do Marketplace Connect — precisa funcionar em qualquer PC do admin
  'glr_vendas_cache',   // pedidos já buscados na página Vendas — evita rebuscar em outro PC
  'glr_fin_cache',      // pedidos + ADS já buscados no Financeiro — evita rebuscar em outro PC
  'glr_mc_contas',      // lista de contas conectadas do Marketplace Connect
  'glr_analytics_dados', // painel executivo Analytics — meta/projeção/ADS por cliente (cache do mês)
  'glr_analytics_queda', // produtos em queda detectados pelo Analytics
  'glr_plano_acao',      // plano de ação (Analytics) — editorial, não vem de API
  'glr_checklist_diario', // checklist diário (Analytics) — editorial, não vem de API
  'glr_logs',            // log de alterações (auditoria) — quem mudou o quê
  'glr_track_ads_snap',    // Histórico de Alterações — último retrato de campanhas ADS por conta
  'glr_track_ads_log',     // Histórico de Alterações — mudanças de ADS detectadas
  'glr_track_precos_snap', // Histórico de Alterações — último preço visto por item, por conta
  'glr_track_precos_log',  // Histórico de Alterações — mudanças de preço detectadas
  'glr_track_prevenda_snap', // Histórico de Alterações — último estado de pré-venda visto por item, por conta
  'glr_track_prevenda_log',  // Histórico de Alterações — entradas/saídas de pré-venda detectadas
];

// ── Intercepta localStorage.setItem para sincronizar com Supabase ──
// Toda vez que qualquer parte do sistema salva no localStorage,
// automaticamente também salva no Supabase — sem alterar nenhum outro arquivo.
const _localSetItem = localStorage.setItem.bind(localStorage);

// ── Listas compartilhadas por vários analistas: gravação ITEM A ITEM ──
// Antes, cada navegador subia a lista INTEIRA e sobrescrevia a do banco: quem
// estava com a cópia velha (aba aberta de um dia pro outro, notebook dormindo)
// apagava as ações registradas pelos outros. Agora: lê a lista atual do banco,
// aplica só o que mudou NESTE navegador (novos, editados e excluídos, pelo id)
// e grava o resultado. Uma gravação por vez por chave.
const CHAVES_POR_ITEM = ['glr_acoes', 'glr_tarefas', 'glr_produtos'];
const _baseSync = {};   // chave → última versão do banco que este navegador conhece
const _filaSync = {};   // chave → promessa da gravação em andamento
function _salvarMesclando(key, local) {
  _filaSync[key] = (_filaSync[key] || Promise.resolve()).then(async () => {
    const { data, error } = await _sb.from('glr_storage').select('dados').eq('chave', key).maybeSingle();
    if (error) { console.warn('[Supabase] Erro ao ler antes de gravar', key, error.message); return; }
    const remoto = Array.isArray(data?.dados) ? data.dados : [];
    const base = Array.isArray(_baseSync[key]) ? _baseSync[key] : null;
    const idDe = x => (x && x.id != null) ? String(x.id) : null;
    const mapa = arr => new Map(arr.filter(idDe).map(x => [idDe(x), x]));
    const mB = mapa(base || []), mL = mapa(local), resultado = mapa(remoto);
    // Excluídos neste navegador: estavam na última versão conhecida e saíram daqui
    if (base) for (const id of mB.keys()) if (!mL.has(id)) resultado.delete(id);
    // Novos ou editados neste navegador (item igual à versão conhecida não reescreve —
    // assim não ressuscita o que outra pessoa excluiu)
    for (const [id, item] of mL) {
      const antes = mB.get(id);
      if (!antes || JSON.stringify(antes) !== JSON.stringify(item)) resultado.set(id, item);
    }
    // Itens sem id (formato antigo): mantém os do banco e acrescenta os novos daqui
    const semIdR = remoto.filter(x => !idDe(x)), vistos = new Set(semIdR.map(x => JSON.stringify(x)));
    const final = [...resultado.values(), ...semIdR, ...local.filter(x => !idDe(x) && !vistos.has(JSON.stringify(x)))];
    const { error: e2 } = await _sb.from('glr_storage').upsert({ chave: key, dados: final, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
    if (e2) { console.warn('[Supabase] Erro sync:', e2.message); return; }
    _baseSync[key] = final;
    _localSetItem(key, JSON.stringify(final));
    if (typeof carregarDadosSalvos === 'function') carregarDadosSalvos();
  }).catch(e => console.warn('[Supabase] Erro ao mesclar', key, e.message));
  return _filaSync[key];
}

localStorage.setItem = function(key, value) {
  _localSetItem(key, value); // salva local normalmente
  if (CHAVES_POR_ITEM.includes(key)) {
    let dados; try { dados = JSON.parse(value); } catch (e) { dados = null; }
    if (Array.isArray(dados)) { _salvarMesclando(key, dados); return; }
  }
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

const CHAVES_MESCLAR_NA_1A_SYNC = ['glr_fin_manual', 'glr_metas']; // glr_metas: cada PC tinha as suas (não sincronizava)
// União profunda: objetos juntam as chaves dos dois lados; listas juntam os
// itens sem repetir; em valor simples conflitante fica o do banco.
function _mesclarProfundo(remoto, local) {
  const ehObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(remoto) && Array.isArray(local)) {
    const vistos = new Set(remoto.map(x => JSON.stringify(x)));
    return [...remoto, ...local.filter(x => !vistos.has(JSON.stringify(x)))];
  }
  if (ehObj(remoto) && ehObj(local)) {
    const out = { ...local };
    for (const k of Object.keys(remoto)) out[k] = k in local ? _mesclarProfundo(remoto[k], local[k]) : remoto[k];
    return out;
  }
  return remoto !== undefined && remoto !== null ? remoto : local;
}

// ── Carrega todos os dados do Supabase para o localStorage local ──
async function sincronizarDoSupabase() {
  const { data, error } = await _sb.from('glr_storage').select('chave, dados');
  if (error) { console.warn('[Supabase] Erro ao carregar:', error.message); return; }
  // Chaves que antes viviam só em cada navegador: na 1ª sincronização deste
  // navegador, MESCLA o que ele tinha com o que já está no banco (vindo de
  // outros PCs) em vez de sobrescrever — senão um PC apagaria os lançamentos
  // do outro. Roda uma vez por navegador.
  const mesclarDepois = [];
  for (const key of CHAVES_MESCLAR_NA_1A_SYNC) {
    const flag = `glr_migrado_${key}`;
    if (localStorage.getItem(flag)) continue;
    const localBruto = localStorage.getItem(key);
    const remoto = (data || []).find(r => r.chave === key);
    if (localBruto != null && remoto) {
      try {
        remoto.dados = _mesclarProfundo(remoto.dados, JSON.parse(localBruto));
        mesclarDepois.push(key);
      } catch (e) { console.warn('[Supabase] Não mesclei', key, e.message); continue; }
    }
    _localSetItem(flag, '1');
  }
  if (data?.length) {
    data.forEach(row => {
      // Lista com gravação item a item que ainda está sendo gravada: não atropela
      if (CHAVES_POR_ITEM.includes(row.chave)) _baseSync[row.chave] = Array.isArray(row.dados) ? row.dados : [];
      _localSetItem(row.chave, _paraLocalStorage(row.dados));
    });
    console.log(`[Supabase] ${data.length} coleções sincronizadas.`);
  }
  // Chaves que já existiam localmente mas nunca foram salvas desde que entraram no
  // GLR_KEYS (ex: dado antigo cadastrado antes do sync existir) — empurra pro Supabase
  // uma única vez, re-chamando o setItem interceptado.
  // Sobe a versão mesclada pro banco (dispara o interceptor do setItem).
  mesclarDepois.forEach(key => localStorage.setItem(key, localStorage.getItem(key)));
  const chavesNoServidor = new Set((data||[]).map(r => r.chave));
  GLR_KEYS.forEach(key => {
    if (chavesNoServidor.has(key)) return;
    const local = localStorage.getItem(key);
    if (local != null) localStorage.setItem(key, local); // dispara o interceptor, empurra pro Supabase
  });
}

// ── Aba que ficou aberta (notebook dormiu, tempo real caiu): ao voltar para ela
//    ou reconectar, recarrega tudo do banco — no máx. 1x por minuto ──
let _ultimaRessincronia = Date.now();
async function _ressincronizarSeVoltou() {
  if (document.visibilityState === 'hidden' || window._portalConfig || Date.now() - _ultimaRessincronia < 60000) return;
  _ultimaRessincronia = Date.now();
  try {
    await Promise.all(Object.values(_filaSync)); // termina o que estiver gravando antes
    await sincronizarDoSupabase();
    if (typeof carregarDadosSalvos === 'function') carregarDadosSalvos();
    if (typeof Router !== 'undefined' && Router.currentPage && typeof Router.resolve === 'function' && ['relatorios', 'timeline', 'tarefas'].includes(Router.currentPage)) Router.resolve();
  } catch (e) { console.warn('[Supabase] Ressincronia falhou:', e.message); }
}
document.addEventListener('visibilitychange', _ressincronizarSeVoltou);
window.addEventListener('online', _ressincronizarSeVoltou);
window.addEventListener('focus', _ressincronizarSeVoltou);

// ── Real-time: atualiza quando outro usuário salvar algo ──
function ativarRealtime() {
  _sb.channel('glr_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'glr_storage' }, payload => {
      if (payload.new?.chave && payload.new?.dados != null) {
        if (CHAVES_POR_ITEM.includes(payload.new.chave)) _baseSync[payload.new.chave] = Array.isArray(payload.new.dados) ? payload.new.dados : [];
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

// ── Tela de Login ─────────────────────────────────────────────
function mostrarLogin(erroMsg) {
  document.getElementById('glr-login-overlay')?.remove();
  document.getElementById('glr-vendas-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'glr-login-overlay';
  overlay.innerHTML = `
    <section class="glr-auth-card" aria-labelledby="glr-auth-title">
      <button class="glr-auth-back" onclick="window.location.href='/landing.html'">← Voltar</button>
      <div class="glr-auth-mark"><b aria-hidden="true">GLR</b><span>GLR Consultoria</span></div>
      <h1 id="glr-auth-title">Seu próximo resultado<br>começa aqui.</h1>
      <p class="glr-auth-lead">Entre no seu Centro de Operações.</p>
      ${erroMsg ? `<div class="glr-auth-error" role="alert"></div>` : ''}
      <div class="glr-auth-field"><label for="glr-email">E-mail</label>
        <input id="glr-email" type="email" placeholder="seu@email.com" autocomplete="email" autocapitalize="none" spellcheck="false"></div>
      <div class="glr-auth-field"><label for="glr-senha">Senha</label>
        <input id="glr-senha" type="password" placeholder="Sua senha" autocomplete="current-password" onkeydown="if(event.key==='Enter') window.fazerLogin()"></div>
      <div class="glr-auth-recovery"><a href="#" onclick="event.preventDefault();window.esqueciSenha()">Esqueci minha senha</a></div>
      <button id="glr-login-btn" onclick="window.fazerLogin()">Entrar</button>
      <p class="glr-auth-foot">Gestão. Lucro. Resultado.</p>
    </section>`;
  // Error text is data, not markup (also covers password recovery messages).
  if (erroMsg) overlay.querySelector('.glr-auth-error').textContent = String(erroMsg);
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
    // mostra o motivo de verdade: "e-mail não confirmado" aparecia como senha errada
    const m = String(error.message || '');
    mostrarLogin(/not confirmed/i.test(m) ? 'Este e-mail ainda não foi confirmado. Abra o e-mail de confirmação que o sistema enviou (veja também o spam) e tente de novo.'
      : /invalid login credentials/i.test(m) ? 'E-mail ou senha incorretos. Se esqueceu a senha, use "Esqueci minha senha".'
      : /rate limit|too many/i.test(m) ? 'Muitas tentativas seguidas. Espere alguns minutos e tente de novo.'
      : 'Não consegui entrar: ' + m);
    return;
  }

  // Verifica tipo ANTES de expor qualquer conteúdo
  const portalCfg = await _detectarPortalCliente(email);
  if (portalCfg?.bloqueado) return; // acesso do portal desativado: já saiu e mostrou o aviso

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

// ── Esqueci minha senha ───────────────────────────────────────
// Manda o e-mail de troca de senha do Supabase; o link volta para o site, o
// Supabase avisa PASSWORD_RECOVERY e abrimos a tela para definir a nova senha.
window.esqueciSenha = async function() {
  const email = document.getElementById('glr-email')?.value?.trim();
  if (!email) { mostrarLogin('Digite seu e-mail no campo acima e clique de novo em "Esqueci minha senha".'); return; }
  const { error } = await _sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/' });
  mostrarLogin(error ? 'Não consegui enviar o e-mail: ' + error.message : `Se ${email} tiver acesso, chega em instantes um e-mail com o link para criar uma nova senha (veja também o spam).`);
  setTimeout(() => { const i = document.getElementById('glr-email'); if (i) i.value = email; }, 50);
};
function mostrarNovaSenha(msg) {
  document.getElementById('glr-nova-senha')?.remove();
  const o = document.createElement('div');
  o.id = 'glr-nova-senha';
  o.innerHTML = `<section class="glr-auth-card" aria-labelledby="glr-recovery-title">
    <div class="glr-auth-mark"><b aria-hidden="true">GLR</b><span>GLR Consultoria</span></div>
    <h1 id="glr-recovery-title">Criar nova senha</h1>
    <p class="glr-auth-lead">Use pelo menos 8 caracteres.</p>
    ${msg ? '<div class="glr-auth-error" role="alert"></div>' : ''}
    <div class="glr-auth-field"><label for="glr-nova-1">Nova senha</label><input id="glr-nova-1" type="password" placeholder="Nova senha" autocomplete="new-password"></div>
    <div class="glr-auth-field"><label for="glr-nova-2">Confirme a senha</label><input id="glr-nova-2" type="password" placeholder="Repita a nova senha" autocomplete="new-password" onkeydown="if(event.key==='Enter') window.salvarNovaSenha()"></div>
    <button class="glr-auth-submit" onclick="window.salvarNovaSenha()">Salvar nova senha</button>
  </section>`;
  if (msg) o.querySelector('.glr-auth-error').textContent = String(msg);
  document.body.appendChild(o);
  setTimeout(() => document.getElementById('glr-nova-1')?.focus(), 100);
}
window.salvarNovaSenha = async function() {
  const a = document.getElementById('glr-nova-1')?.value || '', b = document.getElementById('glr-nova-2')?.value || '';
  if (a.length < 8) { mostrarNovaSenha('A senha precisa ter pelo menos 8 caracteres.'); return; }
  if (a !== b) { mostrarNovaSenha('As duas senhas não são iguais.'); return; }
  const { error } = await _sb.auth.updateUser({ password: a });
  if (error) { mostrarNovaSenha('Não consegui salvar: ' + error.message); return; }
  document.getElementById('glr-nova-senha')?.remove();
  await _sb.auth.signOut();
  mostrarLogin('Senha alterada. Entre com a nova senha.');
};
_sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') mostrarNovaSenha(); });

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
      // Sem sessão: só mostra o login direto se veio da própria landing (?login=1) —
      // senão manda pra landing.html, que é a ÚNICA versão da página de vendas agora.
      // Antes existia uma cópia inteira da landing embutida aqui (mostrarVendas()),
      // que ficava desatualizada toda vez que só o landing.html era editado.
      if (new URLSearchParams(window.location.search).get('login') === '1') {
        _ocultarLoadingInicial();
        mostrarLogin();
        return;
      }
      window.location.replace('/landing.html');
      return;
    }

    const userEmail = session.user?.email || '';

    // Verifica tipo ANTES de sincronizar qualquer dado admin
    const portalCfg = await _detectarPortalCliente(userEmail);
    if (portalCfg?.bloqueado) { _ocultarLoadingInicial(); return; }

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
  const { data: access, error } = await _sb.rpc('glr_acesso');
  if (!error && access?.role === 'staff') return null;
  if (!error && access?.role === 'portal' && access.portal) return access.portal;
  await _sb.auth.signOut();
  GLR_KEYS.forEach(k => localStorage.removeItem(k));
  mostrarLogin(error ? 'Não foi possível verificar suas permissões. Tente novamente.' : 'Acesso não autorizado ou desativado. Fale com a GLR Consultoria.');
  return { bloqueado: true };
}
