// ============================================================
// GLR — Gestão de Acessos do Portal (Admin)
// ============================================================

Router.register('portal-admin', async (params, el) => {
  el.innerHTML = `<div style="padding:24px;max-width:900px;margin:0 auto;" id="portal-admin-root">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
      <div>
        <h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">Portal dos Clientes</h2>
        <p style="font-size:13px;color:var(--text-secondary);margin:0;">Gerencie os acessos dos seus clientes ao portal de vendas</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="window._portalAdminChatTodos()" title="Liga o Chat com IA em todos os acessos do portal (cada um só enxerga as próprias lojas)" style="background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border);border-radius:99px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;">Liberar chat IA para todos</button>
        <button onclick="window._portalAdminNovo()" style="background:var(--primary);color:#fff;border:none;border-radius:99px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;">+ Novo Acesso</button>
      </div>
    </div>
    <div id="portal-admin-lista">Carregando...</div>
  </div>`;

  await _renderPortalAdminLista();
});

// O banco é a fonte da verdade: a cópia do navegador pode estar velha (ou não caber) e,
// se fosse lida primeiro, o próximo salvamento gravaria a lista antiga por cima.
async function _lerConfigs() {
  let erro;
  try {
    const { data, error } = await _sb.from('glr_storage').select('dados').eq('chave', 'glr_portal_configs').maybeSingle();
    if (!error) return Array.isArray(data?.dados) ? data.dados : [];
    erro = error;
  } catch (e) { erro = e; }
  try { const raw = localStorage.getItem('glr_portal_configs'); if (raw) return JSON.parse(raw); } catch (e) {}
  throw new Error('Não consegui ler os acessos do portal: ' + (erro?.message || erro));
}

async function _salvarConfigs(configs) {
  const { error } = await _sb.from('glr_storage')
    .upsert({ chave: 'glr_portal_configs', dados: configs, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
  if (error) throw new Error('Não foi possível salvar os dados do portal. ' + error.message);
  // cópia no navegador é só conveniência: sem espaço, apaga a cópia velha em vez de falhar (o banco já salvou)
  try {
    const gravarLocal = typeof _localSetItem === 'function' ? _localSetItem : localStorage.setItem.bind(localStorage);
    gravarLocal('glr_portal_configs', JSON.stringify(configs));
  } catch (e) { try { localStorage.removeItem('glr_portal_configs'); } catch (e2) {} }
}

async function _renderPortalAdminLista() {
  const lista = document.getElementById('portal-admin-lista');
  if (!lista) return;

  let configs;
  try { configs = await _lerConfigs(); }
  catch (e) { lista.innerHTML = `<div style="padding:20px;color:var(--red);">${String(e.message || e).replace(/</g, '&lt;')}</div>`; return; }

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
            <div style="width:40px;height:40px;border-radius:50%;background:${cfg.ativo!==false?'var(--green-bg)':'var(--bg-subtle)'};border:2px solid ${cfg.ativo!==false?'var(--green)':'var(--border)'};display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:${cfg.ativo!==false?'var(--green)':'var(--text-secondary)'};">
              ${(cfg.clienteNome||'?').slice(0,2).toUpperCase()}
            </div>
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text-primary);">${cfg.clienteNome||'—'}</div>
              <div style="font-size:12px;color:var(--text-secondary);">${cfg.email} · ${(cfg.contaIds||[]).length} conta(s)</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">Criado em ${new Date(cfg.criadoEm||Date.now()).toLocaleDateString('pt-BR')}${cfg.atendimentoIA ? ` · <span style="color:var(--green);font-weight:600;">Atendimento com IA ligado</span><span id="pa-ia-uso-${cfg.id}"></span>` : ''}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
            <button onclick="window._portalAdminToggle('${cfg.id}')"
              style="font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer;border:1px solid var(--border);background:var(--bg-base);color:var(--text-secondary);">
              ${cfg.ativo!==false ? '⏸ Suspender' : '▶ Ativar'}
            </button>
            <button onclick="window._portalAdminIA('${cfg.id}')" title="Módulo pago: a IA responde sozinha perguntas e mensagens do Mercado Livre e conversas da Magalu deste cliente (gasta tokens)"
              style="font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer;border:1px solid ${cfg.atendimentoIA ? 'var(--green)' : 'var(--border)'};background:${cfg.atendimentoIA ? 'var(--green-bg)' : 'var(--bg-base)'};color:${cfg.atendimentoIA ? 'var(--green)' : 'var(--text-secondary)'};font-weight:${cfg.atendimentoIA ? 600 : 400};">
              ${cfg.atendimentoIA ? 'IA atendimento: ligada' : 'Liberar atendimento IA'}
            </button>
            <button onclick="window._portalAdminChat('${cfg.id}')" title="Módulo pago: o cliente conversa com a IA sobre as vendas, ADS, estoque e produtos dele no portal (gasta tokens)"
              style="font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer;border:1px solid ${cfg.chatIA ? 'var(--green)' : 'var(--border)'};background:${cfg.chatIA ? 'var(--green-bg)' : 'var(--bg-base)'};color:${cfg.chatIA ? 'var(--green)' : 'var(--text-secondary)'};font-weight:${cfg.chatIA ? 600 : 400};">
              ${cfg.chatIA ? 'Chat IA: ligado' : 'Liberar chat IA'}
            </button>
            ${[['projecao', 'Projeção', 'Tela Projeção do mês no portal (só as lojas dele; a meta do mês vai junto ao liberar)'], ['financeiro', 'Financeiro', 'Tela Financeiro no portal (lucro, taxas e repasses das lojas dele)'], ['notas', 'Notas', 'Tela Notas e etiquetas no portal (emissão de nota fiscal e etiquetas)']].map(([k, n, dica]) => `<button onclick="window._portalAdminModulo('${cfg.id}','${k}')" title="${dica}"
              style="font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer;border:1px solid ${cfg[k] ? 'var(--green)' : 'var(--border)'};background:${cfg[k] ? 'var(--green-bg)' : 'var(--bg-base)'};color:${cfg[k] ? 'var(--green)' : 'var(--text-secondary)'};${cfg[k] ? 'font-weight:600;' : ''}">
              ${cfg[k] ? `${n}: ligado` : `Liberar ${n.toLowerCase()}`}
            </button>`).join('')}
            <button onclick="window._portalAdminLiberar('${cfg.id}')" title="Libera o login sem precisar do e-mail de confirmação"
              style="font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer;border:1px solid var(--border);background:var(--bg-base);color:var(--text-secondary);">
              Liberar login
            </button>
            <button onclick="window._portalAdminEditar('${cfg.id}')"
              style="font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer;border:1px solid var(--accent);background:transparent;color:var(--accent);font-weight:600;">
              Editar
            </button>
            <button onclick="window._portalAdminRemover('${cfg.id}')"
              style="font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer;border:1px solid color-mix(in srgb,var(--red) 28%,transparent);background:transparent;color:var(--red);">
              🗑
            </button>
          </div>
        </div>
      `).join('')}
    </div>`;
  _portalAdminUsoIA(configs);
}

// ── Login do cliente pelo servidor (api/mcp.js glr_login_portal, só equipe) ──
async function _loginPortalServidor(params) {
  const r = await window.glrApiFetch('/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'glr_login_portal', params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
// Libera o login de quem ficou preso no e-mail de confirmação
window._portalAdminLiberar = async function(id) {
  const cfg = (await _lerConfigs()).find(c => c.id === id); if (!cfg) return;
  try {
    const j = await _loginPortalServidor({ tipo: 'confirmar', email: cfg.email });
    alert(j.ja_estava ? `O login de ${cfg.email} já estava liberado. Se não entra, a senha está errada: use Editar para definir uma nova.` : `Login de ${cfg.email} liberado. Já pode entrar.`);
  } catch (e) { alert('Não consegui liberar: ' + e.message); }
};

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
        ${isEdit ? 'Editar Acesso' : 'Novo Acesso ao Portal'}
      </h3>

      <label style="display:block;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:none;margin-bottom:6px;">Cliente</label>
      <select id="pm-cliente" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-primary);font-size:13px;margin-bottom:16px;box-sizing:border-box;" onchange="window._portalModalAtualizarContas()">
        <option value="">— Selecione —</option>
        ${clientes.map(c => `<option value="${c.id}" ${cfg?.clienteId==c.id?'selected':''}>${c.nome}</option>`).join('')}
      </select>

      <label style="display:block;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:none;margin-bottom:6px;">Contas visíveis (marque quais o cliente pode ver)</label>
      <div id="pm-contas" style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:16px;min-height:40px;font-size:12px;color:var(--text-secondary);">
        Selecione um cliente acima
      </div>

      <label style="display:block;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:none;margin-bottom:6px;">E-mail de acesso</label>
      <input id="pm-email" type="email" ${isEdit ? 'readonly aria-describedby="pm-email-help"' : ''} value="${cfg?.email||''}" placeholder="cliente@empresa.com"
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-primary);font-size:13px;margin-bottom:16px;box-sizing:border-box;">

      ${isEdit ? '<p id="pm-email-help" style="font-size:12px;color:var(--text-secondary);margin:-8px 0 16px;">O e-mail identifica o login existente. Para um e-mail diferente, crie outro acesso.</p>' : ''}
      <label style="display:block;font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:none;margin-bottom:6px;">
        Senha ${isEdit ? '(deixe em branco para manter)' : ''}
      </label>
      <input id="pm-senha" type="password" placeholder="Mínimo 8 caracteres" autocomplete="new-password"
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-primary);font-size:13px;margin-bottom:20px;box-sizing:border-box;">

      ${isEdit ? '<p style="font-size:12px;color:var(--text-secondary);margin:-8px 0 16px;">Ao preencher, a nova senha será aplicada ao login deste cliente.</p>' : ''}
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
      <input type="checkbox" value="${c.external_id}" ${checked} style="width:14px;height:14px;accent-color:var(--accent);">
      <span>${ico} ${nome} <span style="color:var(--text-secondary);font-size:11px;">(ID: ${c.external_id})</span></span>
    </label>`;
  }).join('');
}

let _portalAdminSaving = false;
window._portalAdminSalvar = async function(editId) {
  if (_portalAdminSaving) return;
  const msg   = document.getElementById('pm-msg');
  const email = document.getElementById('pm-email')?.value?.trim();
  const senha = document.getElementById('pm-senha')?.value;
  const clienteId = document.getElementById('pm-cliente')?.value;
  const checkboxes = document.querySelectorAll('#pm-contas input[type=checkbox]:checked');
  const contaIds = Array.from(checkboxes).map(cb => String(cb.value));

  if (!email) { msg.textContent = '⚠️ Informe o e-mail'; msg.style.color='var(--red)'; return; }
  if (!clienteId) { msg.textContent = '⚠️ Selecione um cliente'; msg.style.color='var(--red)'; return; }
  if (!editId && !senha) { msg.textContent = '⚠️ Informe a senha para novo acesso'; msg.style.color='var(--red)'; return; }
  if (senha && (senha.length < 8 || senha.length > 128)) { msg.textContent = '⚠️ Use uma senha entre 8 e 128 caracteres'; msg.style.color='var(--red)'; return; }
  if (!contaIds.length) { msg.textContent = '⚠️ Selecione ao menos uma conta'; msg.style.color='var(--red)'; return; }

  msg.textContent = editId ? 'Salvando...' : 'Criando usuário...';
  msg.style.color = 'var(--text-secondary)';

  const clientes = GLR?.clientes || [];
  const cliente = clientes.find(c => String(c.id) === String(clienteId));
  const clienteNome = cliente?.nome || 'Cliente';
  // nome e plataforma de cada loja: o portal não lê os vínculos da GLR, então vai junto no acesso
  let vincNomes = {}; try { vincNomes = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch (e) {}
  const contas = contaIds.map(id => {
    const ct = (vincNomes[String(clienteId)] || []).find(c => [c.external_id, c.param_to_use?.shopId, c.param_to_use?.meliUserId].map(String).includes(id));
    const mkt = window.BaseDados ? BaseDados.mktDe(ct?.marketplace) : null;
    const nome = String((GLR.nomeConta && GLR.nomeConta(mkt, id)) || id).replace(`${clienteNome} · `, '');
    return { id, mkt, nome };
  });

  let senhaAlterada = false;
  _portalAdminSaving = true;
  try {
    const configs = await _lerConfigs();

    if (editId) {
      // Edição: atualiza config, senha opcional
      const idx = configs.findIndex(c => c.id === editId);
      if (idx < 0) throw new Error('Acesso não encontrado. Reabra o cadastro.');
      if (email.toLowerCase() !== String(configs[idx].email || '').toLowerCase()) throw new Error('O e-mail do login existente não pode ser alterado neste formulário.');
      if (idx >= 0) {
        configs[idx] = { ...configs[idx], email, clienteId, clienteNome, contaIds, contas };
        if (configs[idx].projecao) { try { const metas = JSON.parse(localStorage.getItem('glr_metas') || '{}') || {}; const v = parseFloat(metas[clienteId] ?? metas[String(clienteId)]) || parseFloat(cliente?.metaMensal) || 0; if (v > 0) configs[idx].metaMes = v; } catch (e) {} } // meta atual do mês
      }
      if (senha) {
        const response = await window.glrApiFetch('/api/portal-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ portalId: editId, password: senha }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.ok !== true) throw new Error(result.error || 'A atualização de senha não foi confirmada.');
        senhaAlterada = true;
        document.getElementById('pm-senha').value = '';
      }
    } else {
      // e-mail já tem acesso: não cria outro (um segundo clique em "Criar acesso" duplicava o cartão)
      const ja = configs.find(c => String(c.email || '').trim().toLowerCase() === email.toLowerCase());
      if (ja) { msg.textContent = `⚠️ Este e-mail já tem acesso (${ja.clienteNome || 'cliente'}). Para mudar contas ou senha, use "Editar" no cartão dele.`; msg.style.color = 'var(--red)'; return; }
      // Novo: cria usuário no Supabase
      // login criado pelo servidor já com o e-mail confirmado: o cliente entra sem o e-mail de confirmação
      try { await _loginPortalServidor({ tipo: 'criar', email, senha }); }
      catch (e) { msg.textContent = '❌ Erro ao criar usuário: ' + e.message; msg.style.color = 'var(--red)'; return; }
      const novoId = 'portal_' + Date.now();
      configs.push({ id: novoId, email, clienteId, clienteNome, contaIds, contas, ativo: true, criadoEm: new Date().toISOString() });
    }

    await _salvarConfigs(configs);
    msg.textContent = senhaAlterada ? '✅ Senha atualizada e acesso salvo. O cliente já pode entrar com a nova senha.' : '✅ Salvo com sucesso!';
    msg.style.color = 'var(--green)';
    setTimeout(async () => {
      document.getElementById('portal-modal')?.remove();
      await _renderPortalAdminLista();
    }, 1000);
  } catch(e) {
    msg.textContent = (senhaAlterada ? '⚠️ A senha foi atualizada, mas os demais dados não foram salvos: ' : '❌ Erro: ') + e.message;
    msg.style.color = 'var(--red)';
  } finally { _portalAdminSaving = false; }
};

// Módulo Atendimento com IA (pago à parte: cada resposta gasta tokens). Lê a lista
// do banco na hora para não sobrescrever com uma cópia velha do navegador.
window._portalAdminIA = async function(id) {
  let configs;
  try { const { data, error } = await _sb.from('glr_storage').select('dados').eq('chave', 'glr_portal_configs').single(); if (error) throw error; configs = Array.isArray(data?.dados) ? data.dados : []; }
  catch (e) { alert('Não consegui ler os acessos: ' + (e.message || e)); return; }
  const cfg = configs.find(c => c.id === id); if (!cfg) return;
  const ligar = !cfg.atendimentoIA;
  if (!confirm(ligar
    ? `Liberar o Atendimento com IA para ${cfg.clienteNome || cfg.email}?\n\nA IA vai responder SOZINHA, a cada ~15 minutos, as perguntas e mensagens pós-venda do Mercado Livre e as conversas da Magalu das contas deste cliente. O que ela não puder responder com segurança fica no portal para o cliente responder. Cada resposta gasta tokens.`
    : `Desligar o Atendimento com IA de ${cfg.clienteNome || cfg.email}? A IA para de responder em até 5 minutos.`)) return;
  cfg.atendimentoIA = ligar;
  cfg.atendimentoIAEm = new Date().toISOString();
  try { await _salvarConfigs(configs); } catch (e) { alert(e.message); return; }
  await _renderPortalAdminLista();
};
// Módulo Chat com IA no portal (pago à parte: cada pergunta gasta tokens)
window._portalAdminChat = async function(id) {
  let configs;
  try { const { data, error } = await _sb.from('glr_storage').select('dados').eq('chave', 'glr_portal_configs').single(); if (error) throw error; configs = Array.isArray(data?.dados) ? data.dados : []; }
  catch (e) { alert('Não consegui ler os acessos: ' + (e.message || e)); return; }
  const cfg = configs.find(c => c.id === id); if (!cfg) return;
  const ligar = !cfg.chatIA;
  if (!confirm(ligar
    ? `Liberar o Chat com IA para ${cfg.clienteNome || cfg.email}?\n\nO cliente passa a conversar no portal com a IA, que lê só as lojas dele (vendas, ADS, produtos, estoque, reembolsos). Ela não muda nada nas contas. Cada pergunta gasta tokens.`
    : `Desligar o Chat com IA de ${cfg.clienteNome || cfg.email}?`)) return;
  cfg.chatIA = ligar; cfg.chatIAEm = new Date().toISOString();
  try { await _salvarConfigs(configs); } catch (e) { alert(e.message); return; }
  await _renderPortalAdminLista();
};
window._portalAdminChatTodos = async function() {
  let configs;
  try { const { data, error } = await _sb.from('glr_storage').select('dados').eq('chave', 'glr_portal_configs').single(); if (error) throw error; configs = Array.isArray(data?.dados) ? data.dados : []; }
  catch (e) { alert('Não consegui ler os acessos: ' + (e.message || e)); return; }
  const faltam = configs.filter(c => !c.chatIA && (c.contaIds || []).length);
  if (!faltam.length) { alert('O Chat com IA já está ligado em todos os acessos com lojas.'); return; }
  if (!confirm(`Liberar o Chat com IA para ${faltam.length} acesso(s)?\n\n${faltam.slice(0, 12).map(c => '• ' + (c.clienteNome || c.email)).join('\n')}${faltam.length > 12 ? `\n… e mais ${faltam.length - 12}` : ''}\n\nCada cliente só enxerga as próprias lojas, a IA só lê (não muda nada) e cada usuário tem até 40 perguntas por dia.`)) return;
  const agora = new Date().toISOString();
  for (const c of faltam) { c.chatIA = true; c.chatIAEm = agora; }
  try { await _salvarConfigs(configs); } catch (e) { alert(e.message); return; }
  await _renderPortalAdminLista();
};
// Módulos do portal liberados por acesso (Financeiro, Notas): mesma ideia do Chat IA
window._portalAdminModulo = async function(id, chave) {
  const NOMES = { financeiro: 'Financeiro', notas: 'Notas e etiquetas', projecao: 'Projeção do mês' };
  if (!NOMES[chave]) return;
  let configs;
  try { configs = await _lerConfigs(); } catch (e) { alert(e.message); return; }
  const cfg = configs.find(c => c.id === id); if (!cfg) return;
  const ligar = !cfg[chave];
  if (!confirm(`${ligar ? 'Liberar' : 'Desligar'} a tela ${NOMES[chave]} no portal de ${cfg.clienteNome || cfg.email}?`)) return;
  cfg[chave] = ligar; cfg[chave + 'Em'] = new Date().toISOString();
  // Projeção: a meta do mês vai no acesso (o portal não lê as metas internas da GLR)
  if (chave === 'projecao' && ligar) { try { const metas = JSON.parse(localStorage.getItem('glr_metas') || '{}') || {}; const v = parseFloat(metas[cfg.clienteId] ?? metas[String(cfg.clienteId)]) || parseFloat((GLR.clientes || []).find(c => String(c.id) === String(cfg.clienteId))?.metaMensal) || 0; if (v > 0) cfg.metaMes = v; } catch (e) {} }
  try { await _salvarConfigs(configs); } catch (e) { alert(e.message); return; }
  await _renderPortalAdminLista();
};
// uso do mês de quem tem o módulo ligado
async function _portalAdminUsoIA(configs) {
  for (const cfg of configs.filter(c => c.atendimentoIA && (c.contaIds || []).length)) {
    try {
      const r = await window.glrApiFetch('/api/atendimento', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'listar', contas: cfg.contaIds }) });
      const j = await r.json(); if (!r.ok) continue;
      const el = document.getElementById(`pa-ia-uso-${cfg.id}`);
      if (el) el.textContent = ` · no mês: ${j.resumo.respondidas_ia} respondida(s) pela IA, ${j.resumo.pendentes} com o cliente, ${(j.resumo.tokens_mes / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil tokens`;
    } catch (e) {}
  }
}

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
