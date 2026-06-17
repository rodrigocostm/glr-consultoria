// ============================================================
// GLR Consultoria — Página de Integrações (Marketplace Connect)
// ============================================================

Router.register('integracoes', (params, el) => {
  const apiKey   = localStorage.getItem('glr_mc_apikey') || '';
  const vinc     = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); // { clienteId: [conta, ...] }
  const mesesNomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                      'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const hoje     = new Date();

  const platIcon = { mercadolivre:'🟡', ml:'🟡', meli:'🟡', shopee:'🟠', bling:'🔵' };
  const platNome = { mercadolivre:'Mercado Livre', ml:'Mercado Livre', meli:'Mercado Livre', shopee:'Shopee', bling:'Bling ERP' };

  el.innerHTML = `<div class="page">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="section-title" style="font-size:20px;">🔌 Integrações — Marketplace Connect</div>
        <div class="section-subtitle">Conecte contas de marketplace para importar dados reais automaticamente</div>
      </div>
    </div>

    <!-- API Key -->
    <div class="card mb-16">
      <div class="section-title mb-12">🔑 API Key</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <input id="inp-apikey" class="form-input" type="password"
          value="${apiKey}" placeholder="mc_live_xxxxxxxxxxxxxxxx"
          style="flex:1;min-width:280px;font-family:monospace;">
        <button class="btn btn-primary" onclick="salvarApiKey()">Salvar</button>
        <button class="btn btn-secondary" onclick="testarApiKey()">Testar conexão</button>
        <span id="status-apikey" style="font-size:13px;"></span>
      </div>
      <div id="credits-info" style="margin-top:10px;font-size:12px;color:var(--text-muted);"></div>
    </div>

    <!-- Contas disponíveis -->
    <div class="card mb-16" id="card-contas" style="${apiKey ? '' : 'opacity:0.4;pointer-events:none;'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div class="section-title">📋 Contas Conectadas</div>
        <button class="btn btn-secondary btn-sm" onclick="recarregarContas()">↻ Recarregar</button>
      </div>
      <div id="lista-contas">
        ${apiKey ? '<div style="color:var(--text-muted);font-size:13px;">Clique em "Recarregar" para buscar suas contas.</div>'
                 : '<div style="color:var(--text-muted);font-size:13px;">Configure a API Key primeiro.</div>'}
      </div>
    </div>

    <!-- Vínculo conta → cliente -->
    <div class="card mb-16" id="card-vinculos" style="${apiKey ? '' : 'opacity:0.4;pointer-events:none;'}">
      <div class="section-title mb-12">🔗 Vincular Conta ao Cliente</div>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
        <div class="form-group" style="flex:1;min-width:200px;margin:0;">
          <label class="form-label">Cliente</label>
          <select id="sel-cliente-vinc" class="form-input">
            <option value="">Selecione...</option>
            ${GLR.clientes.map(c => `<option value="${c.id}">${c.nome}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="flex:1;min-width:200px;margin:0;">
          <label class="form-label">Conta</label>
          <select id="sel-conta-vinc" class="form-input">
            <option value="">Carregue as contas primeiro...</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="vincularConta()">Vincular</button>
      </div>
    </div>

    <!-- Vínculos existentes + Importação -->
    <div id="card-clientes-vinculados">
      ${renderClientesVinculados(vinc, mesesNomes, hoje)}
    </div>

  </div>`;

  // ── Funções ──────────────────────────────────────────────

  window.salvarApiKey = () => {
    const key = document.getElementById('inp-apikey').value.trim();
    if (!key) return;
    localStorage.setItem('glr_mc_apikey', key);
    document.getElementById('card-contas').style.opacity = '1';
    document.getElementById('card-contas').style.pointerEvents = '';
    document.getElementById('card-vinculos').style.opacity = '1';
    document.getElementById('card-vinculos').style.pointerEvents = '';
    const st = document.getElementById('status-apikey');
    st.style.color = '#10b981';
    st.textContent = '✓ Chave salva';
    setTimeout(() => st.textContent = '', 2000);
  };

  window.testarApiKey = async () => {
    const key = document.getElementById('inp-apikey').value.trim();
    const st  = document.getElementById('status-apikey');
    const cr  = document.getElementById('credits-info');
    if (!key) { st.style.color = '#ef4444'; st.textContent = '⚠ Insira a API key'; return; }
    st.style.color = 'var(--text-muted)';
    st.textContent = '⏳ Testando...';
    try {
      const r = await MarketplaceAPI.call('credits_status', {}, key);
      const d = r.data || {};
      st.style.color = '#10b981';
      st.textContent = '✓ Conectado!';
      cr.innerHTML = `Plano: <strong>${d.plan || '—'}</strong> · Créditos: <strong>${d.credits ?? '—'}</strong>`;
      localStorage.setItem('glr_mc_apikey', key);
    } catch(e) {
      st.style.color = '#ef4444';
      st.textContent = `✗ Erro: ${e.message}`;
    }
  };

  window.recarregarContas = async () => {
    const el = document.getElementById('lista-contas');
    const sel = document.getElementById('sel-conta-vinc');
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">⏳ Carregando contas...</div>';
    try {
      const contas = await MarketplaceAPI.listAccounts();
      localStorage.setItem('glr_mc_contas', JSON.stringify(contas));

      if (!contas.length) {
        el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Nenhuma conta encontrada. Verifique a API key.</div>';
        return;
      }

      el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;">
        ${contas.map(c => `
          <div style="background:var(--bg-base);border:1px solid var(--border);border-radius:8px;padding:12px;display:flex;align-items:center;gap:10px;">
            <span style="font-size:22px;">${platIcon[c.marketplace] || '🏪'}</span>
            <div>
              <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${c.nickname || c.external_id}</div>
              <div style="font-size:11px;color:var(--text-muted);">${platNome[c.marketplace] || c.marketplace} · ID: ${c.external_id}</div>
              <div style="font-size:10px;margin-top:2px;">
                <span style="background:${c.connected ? '#10b98120' : '#ef444420'};color:${c.connected ? '#10b981' : '#ef4444'};padding:1px 6px;border-radius:99px;">
                  ${c.connected ? '● Conectado' : '○ Desconectado'}
                </span>
              </div>
            </div>
          </div>`).join('')}
      </div>`;

      // Atualiza select de vínculo
      sel.innerHTML = '<option value="">Selecione uma conta...</option>' +
        contas.map(c => `<option value='${JSON.stringify(c).replace(/'/g,"&apos;")}'>${platIcon[c.marketplace]||'🏪'} ${c.nickname||c.external_id} (${platNome[c.marketplace]||c.marketplace})</option>`).join('');

    } catch(e) {
      el.innerHTML = `<div style="color:#ef4444;font-size:13px;">✗ Erro: ${e.message}</div>`;
    }
  };

  window.vincularConta = () => {
    const clienteId = document.getElementById('sel-cliente-vinc').value;
    const contaStr  = document.getElementById('sel-conta-vinc').value;
    if (!clienteId || !contaStr) return alert('Selecione o cliente e a conta.');
    let conta;
    try { conta = JSON.parse(contaStr.replace(/&apos;/g, "'")); } catch(e) { return; }

    let vinc = {};
    try { vinc = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch(e) {}
    if (!vinc[clienteId]) vinc[clienteId] = [];

    // Evita duplicata
    const jaVinculado = vinc[clienteId].some(v => v.external_id === conta.external_id);
    if (jaVinculado) return alert('Esta conta já está vinculada a este cliente.');

    vinc[clienteId].push(conta);
    localStorage.setItem('glr_mc_vinculos', JSON.stringify(vinc));

    // Re-renderiza lista
    document.getElementById('card-clientes-vinculados').innerHTML = renderClientesVinculados(vinc, mesesNomes, hoje);
    alert(`✓ ${conta.nickname} vinculada com sucesso!`);
  };

  window.desvincularConta = (clienteId, externalId) => {
    let vinc = {};
    try { vinc = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch(e) {}
    if (vinc[clienteId]) {
      vinc[clienteId] = vinc[clienteId].filter(v => v.external_id !== externalId);
      if (!vinc[clienteId].length) delete vinc[clienteId];
    }
    localStorage.setItem('glr_mc_vinculos', JSON.stringify(vinc));
    document.getElementById('card-clientes-vinculados').innerHTML = renderClientesVinculados(vinc, mesesNomes, hoje);
  };

  window.importarDados = async (clienteId, mes, ano) => {
    const btnId = `btn-import-${clienteId}`;
    const resId = `res-import-${clienteId}`;
    const btn   = document.getElementById(btnId);
    const res   = document.getElementById(resId);
    if (!btn || !res) return;

    let vinc = {};
    try { vinc = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch(e) {}
    const contas = vinc[clienteId] || [];
    if (!contas.length) return;

    btn.disabled = true;
    btn.textContent = '⏳ Importando...';
    res.innerHTML = '';

    try {
      const dados = await MarketplaceAPI.importarClienteMes(contas, mes, ano);
      const cliente = GLR.clientes.find(c => c.id === parseInt(clienteId));

      // Salva no glr_dre
      let dres = [];
      try { dres = JSON.parse(localStorage.getItem('glr_dre') || '[]'); } catch(e) {}

      let importados = 0;
      dados.forEach(d => {
        if (d.erro || d.faturamento <= 0) return;
        // Remove entrada anterior dessa plataforma/mês/cliente
        dres = dres.filter(x =>
          !(parseInt(x.clienteId) === parseInt(clienteId) &&
            parseInt(x.mes) === mes && parseInt(x.ano) === ano &&
            (x.plataforma || '').toLowerCase() === (d.plataforma || '').toLowerCase())
        );
        dres.push({
          clienteId: String(clienteId),
          mes, ano,
          plataforma: d.plataforma,
          conta: d.conta,
          valores: {
            faturamento:      Math.round(d.faturamento),
            ads:              Math.round(d.investimento || 0),
            produtosVendidos: d.pedidos || 0,
            comissaoFrete: 0, produtos: 0, imposto: 0,
            juros: 0, custoFixo: 0, comissaoGLR: 0,
          },
          importadoEm: new Date().toISOString(),
          fonte: 'marketplace-api',
        });
        importados++;
      });

      localStorage.setItem('glr_dre', JSON.stringify(dres));

      // Atualiza projeção com fatBase real (dias decorridos do primeiro dado)
      if (dados.length && dados[0].diasDecorridos) {
        let projs = [];
        try { projs = JSON.parse(localStorage.getItem('glr_projecoes') || '[]'); } catch(e) {}
        let proj = projs.find(p => parseInt(p.chave) === parseInt(clienteId));
        if (!proj) {
          proj = { chave: String(clienteId), nomeCliente: cliente?.nome || '', plataformas: [], diasDecorridos: dados[0].diasDecorridos, diasNoMes: dados[0].diasMes, mes: `${mesesNomes[mes]} ${ano}`, obs: '' };
          projs.push(proj);
        }
        proj.diasDecorridos = dados[0].diasDecorridos;
        proj.diasNoMes      = dados[0].diasMes;

        // Atualiza fatBase por plataforma
        dados.forEach(d => {
          if (d.erro || d.faturamento <= 0) return;
          const nomePlat = d.plataforma;
          let plat = proj.plataformas.find(p => p.nome.toLowerCase() === nomePlat.toLowerCase());
          if (!plat) { plat = { nome: nomePlat, fatBase: '', adsBase: '', vendasBase: '', maio: '', abril: '', marco: '' }; proj.plataformas.push(plat); }
          plat.fatBase = String(Math.round(d.faturamento));
          if (d.investimento) plat.adsBase = String(Math.round(d.investimento));
          if (d.pedidos)     plat.vendasBase = String(d.pedidos);
        });

        localStorage.setItem('glr_projecoes', JSON.stringify(projs));
      }

      // Mostra resultado
      res.innerHTML = dados.map(d => `
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;">
          <span>${platIcon[d.plataforma?.toLowerCase()] || '🏪'}</span>
          <span style="font-weight:600;">${d.plataforma}</span>
          ${d.erro
            ? `<span style="color:#ef4444;">✗ ${d.erro}</span>`
            : `<span style="color:#10b981;">✓ Fat: <strong>R$ ${Math.round(d.faturamento).toLocaleString('pt-BR')}</strong>${d.pedidos ? ` · <strong>${d.pedidos} pedidos</strong>` : ''}${d.investimento ? ` · ADS: R$ ${Math.round(d.investimento).toLocaleString('pt-BR')}` : ''}</span>`
          }
        </div>`).join('');

      btn.textContent = `✓ Importado (${importados} conta${importados !== 1 ? 's' : ''})`;
      btn.style.background = '#10b981';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = '⬇ Importar dados'; btn.style.background = ''; }, 4000);

    } catch(e) {
      res.innerHTML = `<div style="color:#ef4444;font-size:12px;margin-top:6px;">✗ ${e.message}</div>`;
      btn.textContent = '⬇ Importar dados';
      btn.disabled = false;
    }
  };
});

// ── Render clientes vinculados ──────────────────────────────
function renderClientesVinculados(vinc, mesesNomes, hoje) {
  const platIcon = { mercadolivre:'🟡', ml:'🟡', meli:'🟡', shopee:'🟠', bling:'🔵' };
  const ids = Object.keys(vinc);
  if (!ids.length) return `<div class="card" style="text-align:center;padding:32px;color:var(--text-muted);">
    <div style="font-size:36px;margin-bottom:10px;">🔗</div>
    <div style="font-weight:600;margin-bottom:6px;">Nenhum cliente vinculado</div>
    <div style="font-size:13px;">Vincule contas de marketplace aos seus clientes acima.</div>
  </div>`;

  return ids.map(clienteId => {
    const cliente = GLR.clientes.find(c => c.id === parseInt(clienteId));
    const contas  = vinc[clienteId] || [];
    if (!cliente) return '';

    const mesAtual = hoje.getMonth();
    const anoAtual = hoje.getFullYear();

    return `<div class="card mb-16" style="padding:0;overflow:hidden;">
      <div style="padding:14px 18px;background:linear-gradient(135deg,#1a2744,#23305a);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div>
          <div style="font-size:15px;font-weight:700;color:white;">${cliente.nome}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.5);">${contas.length} conta${contas.length !== 1 ? 's' : ''} vinculada${contas.length !== 1 ? 's' : ''}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="sel-mes-${clienteId}" style="background:#1a2744;border:1px solid rgba(255,255,255,0.2);color:white;border-radius:6px;padding:5px 8px;font-size:12px;">
            ${mesesNomes.map((m, i) => `<option value="${i}" ${i === mesAtual ? 'selected' : ''}>${m} ${i <= mesAtual ? anoAtual : anoAtual - 1}</option>`).join('')}
          </select>
          <button id="btn-import-${clienteId}" class="btn btn-primary btn-sm"
            onclick="importarDados(${clienteId}, parseInt(document.getElementById('sel-mes-${clienteId}').value), ${anoAtual})">
            ⬇ Importar dados
          </button>
        </div>
      </div>

      <div style="padding:14px 18px;">
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
          ${contas.map(c => `
            <div style="background:var(--bg-base);border:1px solid var(--border);border-radius:8px;padding:8px 12px;display:flex;align-items:center;gap:8px;">
              <span>${platIcon[c.marketplace] || '🏪'}</span>
              <div>
                <div style="font-size:12px;font-weight:600;">${c.nickname || c.external_id}</div>
                <div style="font-size:10px;color:var(--text-muted);">${c.marketplace}</div>
              </div>
              <button onclick="desvincularConta(${clienteId},'${c.external_id}')"
                style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:2px 4px;font-size:12px;margin-left:4px;" title="Desvincular">✕</button>
            </div>`).join('')}
        </div>
        <div id="res-import-${clienteId}"></div>
      </div>
    </div>`;
  }).join('');
}
