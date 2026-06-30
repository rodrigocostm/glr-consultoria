// ============================================================
// GLR — Gestão de Acessos do Portal (Admin)
// ============================================================

Router.register('portal-admin', async (params, el) => {
  el.innerHTML = `<div style="padding:24px;max-width:900px;margin:0 auto;" id="portal-admin-root">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
      <div>
        <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">🔐 Portal dos Clientes</h2>
        <p style="font-size:13px;color:var(--text-secondary);margin:0;">Gerencie os acessos dos seus clientes ao portal de vendas</p>
      </div>
      <button onclick="window._portalAdminNovo()" style="background:var(--primary);color:#fff;border:none;border-radius:99px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;">+ Novo Acesso</button>
    </div>
    <div id="portal-admin-lista">Carregando...</div>
  </div>`;

  await _renderPortalAdminLista();
});

async function _lerConfigs() {
  try {
    const raw = localStorage.getItem('glr_portal_configs');
    if (raw) return JSON.parse(raw);
    // tenta Supabase
    const { data } = await _sb.from('glr_storage').select('dados').eq('chave','glr_portal_configs').single();
    return data?.dados || [];
  } catch { return []; }
}

async function _salvarConfigs(configs) {
  localStorage.setItem('glr_portal_configs', JSON.stringify(configs));
  try {
    await _sb.from('glr_storage')
      .upsert({ chave: 'glr_portal_configs', dados: configs, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
  } catch(e) { console.warn('[Portal] Erro ao salvar no Supabase:', e.message); }
}

async function _renderPortalAdminLista() {
  const lista = document.getElementById('portal-admin-lista');
  if (!lista) return;

  const configs = await _lerConfigs();

  if (!configs.length) {
    lista.innerHTML = `
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:60px;text-align:center;color:var(--text-secondary);">
        <div style="font-size:40px;margin-bottom:12px;">🔐</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Nenhum acesso criado ainda</div>
        <div style="font-size:13px;">Clique em "+ Novo Acesso" para liberar o portal para um cliente.</div>
      </div>`;
    return;
  }

  lista.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${configs.map(cfg => `
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
          <div style="display:flex;align-items:center;gap:14px;">
            <div style="width:40px;height:40px;border-radius:50%;background:${cfg.ativo!==false?'#f0fdf4':'#f8fafc'};border:2px solid ${cfg.ativo!==false?'#16a34a':'var(--border)'};display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:${cfg.ativo!==false?'#16a34a':'var(--text-secondary)'};">
              ${(cfg.clienteNome||'?').slice(0,2).toUpperCase()}
            </div>
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text-primary);">${cfg.clienteNome||'—'}</div>
              <div style="font-size:12px;color:var(--text-secondary);">📧 ${cfg.email} · ${(cfg.contaIds||[]).length} conta(s)</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">Criado em ${new Date(cfg.criadoEm||Date.now()).toLocaleDateString('pt-BR')}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-shrink:0;">
            <button onclick="window._portalAdminToggle('${cfg.id}')"
              style="font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer;border:1px solid var(--border);background:var(--bg-base);color:var(--text-secondary);">
              ${cfg.ativo!==false ? '⏸ Suspender' : '▶ Ativar'}
            </button>
            <button onclick="window._portalAdminEditar('${cfg.id}')"
              style="font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer;border:1px solid #6366f1;background:transparent;color:#6366f1;font-weight:600;">
              ✏️ Editar
            </button>
            <button onclick="window._portalAdminRemover('${cfg.id}')"
              style="font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer;border:1px solid #fecaca;background:transparent;color:#dc2626;">
              🗑
            </button>
          </div>
        </div>
      `).join('')}
    </div>`;
}

// ── Modal de criação / edição ──────────────────────────────────
window._portalAdminNovo = function() { _abrirModal(null); };

window._portalAdminEditar = async function(id) {
  const configs = await _lerConfigs();
  const cfg = configs.find(c => c.id === id);
  if (cfg) _abrirModal(cfg);
};

function _abrirModal(cfg) {
  document.getElementById('portal-modal')?.remove();

  const clientes = (GLR?.clientes || []);
  const vinculos = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_vinculos')||'{}'); } catch{ return {}; } })();
  const isEdit = !!cfg;

  const modal = document.createElement('div');
  modal.id = 'portal-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-surface);border-radius:16px;padding:28px;width:480px;max-width:95vw;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:90vh;overflow-y:auto;">
      <h3 style="font-size:16px;font-weight:700;margin:0 0 20px;color:var(--text-primary);">
        ${isEdit ? '✏️ Editar Acesso' : '🔐 Novo Acesso ao Portal'}
      </h3>

      <label style="display:block;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:6px;">Cliente</label>
      <select id="pm-cliente" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-primary);font-size:13px;margin-bottom:16px;box-sizing:border-box;" onchange="window._portalModalAtualizarContas()">
        <option value="">— Selecione —</option>
        ${clientes.map(c => `<option value="${c.id}" ${cfg?.clienteId==c.id?'selected':''}>${c.nome}</option>`).join('')}
      </select>

      <label style="display:block;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:6px;">Contas visíveis (marque quais o cliente pode ver)</label>
      <div id="pm-contas" style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:16px;min-height:40px;font-size:12px;color:var(--text-secondary);">
        Selecione um cliente acima
      </div>

      <label style="display:block;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:6px;">E-mail de acesso</label>
      <input id="pm-email" type="email" value="${cfg?.email||''}" placeholder="cliente@empresa.com"
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-primary);font-size:13px;margin-bottom:16px;box-sizing:border-box;">

      <label style="display:block;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:6px;">
        Senha ${isEdit ? '(deixe em branco para manter)' : ''}
      </label>
      <input id="pm-senha" type="password" placeholder="Mínimo 6 caracteres"
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-primary);font-size:13px;margin-bottom:20px;box-sizing:border-box;">

      <div id="pm-msg" style="margin-bottom:12px;font-size:12px;text-align:center;"></div>

      <div style="display:flex;gap:10px;">
        <button onclick="document.getElementById('portal-modal').remove()"
          style="flex:1;padding:11px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-secondary);cursor:pointer;font-weight:600;">Cancelar</button>
        <button onclick="window._portalAdminSalvar('${cfg?.id||''}')"
          style="flex:2;padding:11px;border:none;border-radius:8px;background:var(--primary);color:#fff;cursor:pointer;font-weight:700;font-size:14px;">
          ${isEdit ? 'Salvar alterações' : 'Criar acesso'}
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Armazena vinculos acessível ao modal
  window._portalModalVinculos = vinculos;
  if (isEdit) window._portalModalCfg = cfg;

  // Popula contas se já tem cliente
  if (cfg?.clienteId) _portalModalAtualizarContasInterno(cfg.clienteId, cfg.contaIds||[]);
}

window._portalModalAtualizarContas = function() {
  const sel = document.getElementById('pm-cliente');
  _portalModalAtualizarContasInterno(sel?.value, []);
};

function _portalModalAtualizarContasInterno(clienteId, selecionadas) {
  const el = document.getElementById('pm-contas');
  if (!el) return;
  if (!clienteId) { el.innerHTML = '<span>Selecione um cliente acima</span>'; return; }

  const vinculos = window._portalModalVinculos || {};
  // Tenta string e número — glr_mc_vinculos pode ter chave em qualquer formato
  const contas = vinculos[String(clienteId)] || vinculos[parseInt(clienteId)] || [];
  const nicks = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch{ return {}; } })();

  if (!contas.length) {
    el.innerHTML = '<span style="color:var(--text-secondary);">Nenhuma conta vinculada a este cliente</span>';
    return;
  }

  const platIco = { shopee:'🟠', mercadolivre:'🟡', ml:'🟡', meli:'🟡' };
  el.innerHTML = contas.map(c => {
    const checked = selecionadas.includes(String(c.external_id)) ? 'checked' : '';
    const ico = platIco[c.marketplace] || '🏪';
    const nome = nicks[c.external_id] || c.nickname || c.external_id;
    return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;">
      <input type="checkbox" value="${c.external_id}" ${checked} style="width:14px;height:14px;accent-color:#6366f1;">
      <span>${ico} ${nome} <span style="color:var(--text-secondary);font-size:11px;">(ID: ${c.external_id})</span></span>
    </label>`;
  }).join('');
}

window._portalAdminSalvar = async function(editId) {
  const msg   = document.getElementById('pm-msg');
  const email = document.getElementById('pm-email')?.value?.trim();
  const senha = document.getElementById('pm-senha')?.value;
  const clienteId = document.getElementById('pm-cliente')?.value;
  const checkboxes = document.querySelectorAll('#pm-contas input[type=checkbox]:checked');
  const contaIds = Array.from(checkboxes).map(cb => String(cb.value));

  if (!email) { msg.textContent = '⚠️ Informe o e-mail'; msg.style.color='#dc2626'; return; }
  if (!clienteId) { msg.textContent = '⚠️ Selecione um cliente'; msg.style.color='#dc2626'; return; }
  if (!editId && !senha) { msg.textContent = '⚠️ Informe a senha para novo acesso'; msg.style.color='#dc2626'; return; }
  if (senha && senha.length < 6) { msg.textContent = '⚠️ Senha deve ter no mínimo 6 caracteres'; msg.style.color='#dc2626'; return; }
  if (!contaIds.length) { msg.textContent = '⚠️ Selecione ao menos uma conta'; msg.style.color='#dc2626'; return; }

  msg.textContent = editId ? 'Salvando...' : 'Criando usuário...';
  msg.style.color = 'var(--text-secondary)';

  const clientes = GLR?.clientes || [];
  const cliente = clientes.find(c => String(c.id) === String(clienteId));
  const clienteNome = cliente?.nome || 'Cliente';

  try {
    const configs = await _lerConfigs();

    if (editId) {
      // Edição: atualiza config, senha opcional
      const idx = configs.findIndex(c => c.id === editId);
      if (idx >= 0) {
        configs[idx] = { ...configs[idx], email, clienteId, clienteNome, contaIds };
      }
      if (senha) {
        // Tenta atualizar senha — requer que o usuário esteja logado com a conta alvo (não é possível admin-side sem service key)
        // Orientamos o usuário a pedir reset via Supabase
        msg.textContent = '⚠️ Para alterar a senha, use o painel do Supabase ou peça ao cliente para redefinir.';
        msg.style.color = '#d97706';
      }
    } else {
      // Novo: cria usuário no Supabase
      const { error: signUpError } = await _sb.auth.signUp({ email, password: senha });
      if (signUpError && !signUpError.message.includes('already registered')) {
        msg.textContent = '❌ Erro ao criar usuário: ' + signUpError.message;
        msg.style.color = '#dc2626';
        return;
      }
      const novoId = 'portal_' + Date.now();
      configs.push({ id: novoId, email, clienteId, clienteNome, contaIds, ativo: true, criadoEm: new Date().toISOString() });
    }

    await _salvarConfigs(configs);
    msg.textContent = '✅ Salvo com sucesso!';
    msg.style.color = '#16a34a';
    setTimeout(async () => {
      document.getElementById('portal-modal')?.remove();
      await _renderPortalAdminLista();
    }, 1000);
  } catch(e) {
    msg.textContent = '❌ Erro: ' + e.message;
    msg.style.color = '#dc2626';
  }
};

window._portalAdminToggle = async function(id) {
  const configs = await _lerConfigs();
  const idx = configs.findIndex(c => c.id === id);
  if (idx >= 0) {
    configs[idx].ativo = configs[idx].ativo === false;
    await _salvarConfigs(configs);
    await _renderPortalAdminLista();
  }
};

window._portalAdminRemover = async function(id) {
  if (!confirm('Remover este acesso? O usuário não conseguirá mais logar.')) return;
  const configs = await _lerConfigs();
  await _salvarConfigs(configs.filter(c => c.id !== id));
  await _renderPortalAdminLista();
};
