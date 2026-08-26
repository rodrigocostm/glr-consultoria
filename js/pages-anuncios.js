// ============================================================
// GLR Consultoria — Central de Anúncios (analistas criam título,
// descrição e fotos novas com IA, e publicam direto no Mercado Livre.
// Também dá pra criar um anúncio novo do zero, com foto de referência
// enviada do computador.)
// ============================================================

Router.register('anuncios', (params, el) => {
  if (!GLR.gestores.length) {
    el.innerHTML = `<div class="page">
      <div style="text-align:center;padding:80px 24px;">
        <div style="font-size:52px;margin-bottom:16px;">🎨</div>
        <div style="font-size:20px;font-weight:800;color:var(--text-primary);margin-bottom:8px;">Nenhum gestor cadastrado ainda</div>
        <div style="font-size:14px;color:var(--text-muted);max-width:420px;margin:0 auto 24px;">Cadastre pelo menos um gestor antes de criar anúncios.</div>
        <button class="btn btn-primary" onclick="Router.navigate('gestores')">Cadastrar gestor</button>
      </div>
    </div>`;
    return;
  }

  const apiKey = localStorage.getItem('glr_mc_apikey') || '';

  let modo = 'editar';        // 'editar' | 'criar'
  let contas = null;          // contas ML carregadas de list_accounts
  let contaSel = null;        // conta escolhida
  let itemAtual = null;       // resultado de get_item (modo editar)
  let fotosAtuais = [];       // pictures do anúncio atual (modo editar)
  let resultadosBusca = [];
  let categoriasBusca = [];   // resultados de search_categories (modo criar)
  const novo = { categoria: null, atributos: [], refBase64: '', refPreviewUrl: '' };

  // Cada slot: { refUrl, refBase64, prompt, gerando, geradas:[{url}], escolhidaIdx, jobId }
  const slotPrincipal = { refUrl: '', refBase64: '', prompt: '', gerando: false, geradas: [], escolhidaIdx: 0, jobId: null };
  const slotDetalhe   = { refUrl: '', refBase64: '', prompt: '', gerando: false, geradas: [], escolhidaIdx: 0, jobId: null };

  function resetSlots() {
    [slotPrincipal, slotDetalhe].forEach(s => {
      s.refUrl = ''; s.refBase64 = ''; s.prompt = ''; s.geradas = []; s.escolhidaIdx = 0; s.jobId = null; s._raw = null;
    });
  }
  function resetItem() {
    itemAtual = null; fotosAtuais = [];
    resetSlots();
  }
  function resetNovo() {
    novo.categoria = null; novo.atributos = []; novo.refBase64 = ''; novo.refPreviewUrl = '';
    categoriasBusca = [];
    resetSlots();
  }

  async function carregarContas() {
    const r = await MarketplaceAPI.call('list_accounts');
    contas = (r.data?.accounts || []).filter(c => ['meli', 'ml', 'mercadolivre'].includes(c.marketplace));
  }

  function meliIdDaConta(c) {
    return c?.param_to_use?.meliUserId || c?.external_id;
  }

  // O nickname/label que a API devolve é genérico ("Mercado Livre 123456") —
  // o nome real da loja/cliente vem só na tag associada à conta.
  function nomeDaConta(c) {
    const tagNome = c?.tags?.find(t => t && typeof t === 'object' && t.name)?.name;
    return tagNome || c?.label || c?.nickname || c?.external_id;
  }

  function render() {
    if (modo === 'criar') renderCriarNovo(); else { renderResultados(); renderPainel(); }
  }

  // Geração de foto NÃO passa pela Tiops — usa direto a API da OpenAI (gpt-image-1)
  // via /api/generate-photo (function serverless própria, chave guardada no
  // ambiente da Vercel). Publicar a foto no marketplace continua usando a Tiops,
  // que é o único jeito de escrever no anúncio real.
  async function gerarFoto(slot, refInput) {
    const promptEl = document.getElementById(refInput + '-prompt');
    slot.prompt = promptEl?.value || '';
    const temRef = modo === 'criar' ? !!slot.refBase64 : !!slot.refUrl;
    if (!temRef) { alert(modo === 'criar' ? 'Envie a foto de referência do produto antes de gerar.' : 'Escolha a foto de referência antes de gerar.'); return; }
    slot.gerando = true; slot.geradas = []; slot.escolhidaIdx = 0;
    render();
    try {
      const body = {
        prompt: slot.prompt,
        photo_count: 3,
        ad_title: modo === 'criar' ? (document.getElementById('novo-titulo')?.value || '') : itemAtual.title,
      };
      if (modo === 'criar') body.image_base64 = slot.refBase64;
      else body.image_url = slot.refUrl;

      const resp = await fetch('/api/generate-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Erro ao gerar foto.');
      slot.geradas = (json.images || []).map(im => ({ url: im.url }));
      if (!slot.geradas.length) alert('A IA respondeu sem nenhuma imagem.');
    } catch (e) {
      alert('Erro ao gerar foto: ' + (e.message || e));
    } finally {
      slot.gerando = false;
      render();
    }
  }

  // ── Modo editar ──────────────────────────────────────────────
  async function buscarAnuncios() {
    const termo = document.getElementById('anun-busca')?.value.trim();
    const statusEl = document.getElementById('anun-busca-status');
    if (!contaSel) { alert('Selecione uma loja primeiro.'); return; }
    if (!termo) { alert('Digite um título ou SKU para buscar.'); return; }
    if (statusEl) statusEl.textContent = 'Buscando...';
    try {
      const r = await MarketplaceAPI.call('list_items', { meliUserId: meliIdDaConta(contaSel), q: termo, limit: 20 });
      resultadosBusca = (r.data?.results || r.results || []).map(x => x.body || x);
      if (statusEl) statusEl.textContent = resultadosBusca.length ? `${resultadosBusca.length} encontrado(s).` : 'Nada encontrado.';
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Erro na busca: ' + (e.message || e);
    }
    renderResultados();
  }

  async function selecionarItem(itemId) {
    const statusEl = document.getElementById('anun-busca-status');
    if (statusEl) statusEl.textContent = 'Carregando anúncio...';
    try {
      const r = await MarketplaceAPI.call('get_item', { item_id: itemId, account_id: meliIdDaConta(contaSel) });
      itemAtual = r.data?.body || r.data || r;
      fotosAtuais = itemAtual.pictures || [];
      resetSlots();
      slotPrincipal.refUrl = fotosAtuais[0]?.secure_url || fotosAtuais[0]?.url || '';
      slotDetalhe.refUrl   = fotosAtuais[1]?.secure_url || fotosAtuais[1]?.url || slotPrincipal.refUrl;
      try {
        const rd = await MarketplaceAPI.call('get_description', { item_id: itemId, meliUserId: meliIdDaConta(contaSel) });
        itemAtual._descricaoAtual = rd.data?.plain_text || rd.data?.text || '';
      } catch (e) { itemAtual._descricaoAtual = ''; }
    } catch (e) {
      alert('Erro ao carregar anúncio: ' + (e.message || e));
    }
    renderResultados();
    renderPainel();
  }

  function gerasHtmlComum(slot, id) {
    if (slot.geradas.length) {
      return `
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          ${slot.geradas.map((g, i) => `
            <img src="${g.url}" onclick="_anunEscolher('${id}', ${i})"
              style="width:64px;height:64px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid ${i === slot.escolhidaIdx ? '#6366f1' : 'transparent'};">
          `).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">✅ Variação ${slot.escolhidaIdx + 1} selecionada.</div>`;
    }
    if (slot.gerando) return '';
    if (slot._raw) return `<div style="font-size:11px;color:var(--red);margin-top:8px;">Sem imagens reconhecidas na resposta. <a href="javascript:void(0)" onclick="console.log(${JSON.stringify(JSON.stringify(slot._raw))})">ver no console</a></div>`;
    return '';
  }

  function slotHtml(slot, id, titulo, opcoesRef) {
    return `
      <div class="card" style="flex:1;min-width:280px;">
        <div style="font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:10px;">${titulo}</div>
        <div style="display:flex;gap:10px;margin-bottom:10px;">
          <div style="flex-shrink:0;">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Referência</div>
            ${slot.refUrl ? `<img src="${slot.refUrl}" style="width:78px;height:78px;object-fit:cover;border-radius:10px;border:1px solid var(--border);">` : `<div style="width:78px;height:78px;border-radius:10px;border:1px dashed var(--border);"></div>`}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Escolher foto atual como referência</div>
            <select class="form-select" style="font-size:12px;" onchange="_anunSlotRef('${id}', this.value)">
              ${opcoesRef.map((f, i) => `<option value="${f.secure_url || f.url}">Foto ${i + 1}${(f.secure_url || f.url) === slot.refUrl ? ' (atual)' : ''}</option>`).join('')}
            </select>
            <input type="text" class="form-input" id="${id}-prompt" placeholder="Prompt opcional (ex: fundo branco, iluminação de estúdio)" value="${slot.prompt}" style="font-size:12px;margin-top:6px;">
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" style="width:100%;" ${slot.gerando ? 'disabled' : ''} onclick="_anunGerar('${id}')">
          ${slot.gerando ? '⏳ Gerando...' : '🎨 Gerar variação com IA'}
        </button>
        ${gerasHtmlComum(slot, id)}
      </div>`;
  }

  function renderResultados() {
    const box = document.getElementById('anun-resultados');
    if (!box) return;
    box.innerHTML = resultadosBusca.map(it => `
      <div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:8px;cursor:pointer;padding:10px 14px;" onclick="_anunSelecionar('${it.id}')">
        <img src="${it.thumbnail || ''}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${it.title || '—'}</div>
          <div style="font-size:11px;color:var(--text-muted);">${it.id} · R$ ${(it.price || 0).toFixed(2)}</div>
        </div>
        <span style="font-size:16px;">›</span>
      </div>
    `).join('');
  }

  function renderPainel() {
    const box = document.getElementById('anun-painel');
    if (!box) return;
    if (!itemAtual) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
          <img src="${fotosAtuais[0]?.secure_url || fotosAtuais[0]?.url || ''}" style="width:56px;height:56px;object-fit:cover;border-radius:10px;">
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-primary);">${itemAtual.id}</div>
            <div style="font-size:12px;color:var(--text-muted);">Editando anúncio — as alterações só valem no marketplace depois de publicar.</div>
          </div>
        </div>
        <div class="form-group"><label class="form-label">Título</label>
          <input type="text" class="form-input" id="anun-titulo" value="${(itemAtual.title || '').replace(/"/g, '&quot;')}" maxlength="60">
        </div>
        <div class="form-group"><label class="form-label">Descrição</label>
          <textarea class="form-textarea" id="anun-desc" rows="6">${itemAtual._descricaoAtual || ''}</textarea>
        </div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;">
        ${slotHtml(slotPrincipal, 'principal', '📷 Foto Principal (capa)', fotosAtuais)}
        ${slotHtml(slotDetalhe, 'detalhe', '🔍 Foto de Detalhe', fotosAtuais)}
      </div>
      <div class="card" style="background:var(--accent-soft, rgba(99,102,241,0.06));">
        <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;">
          ⚠️ Publicar altera o anúncio <strong>real</strong> no Mercado Livre. Confira título, descrição e fotos antes de confirmar.
        </div>
        <div class="grid-2" style="gap:12px;margin-bottom:12px;">
          <div class="form-group"><label class="form-label">Responsável</label>
            <select class="form-select" id="anun-resp">
              ${GLR.gestores.map(g => `<option>${g.nome}</option>`).join('')}
            </select>
          </div>
        </div>
        <button class="btn btn-primary" style="width:100%;" onclick="_anunPublicar()">🚀 Publicar Alterações no Marketplace</button>
      </div>
    `;
  }

  // ── Modo criar do zero ───────────────────────────────────────
  async function buscarCategoria() {
    const termo = document.getElementById('novo-cat-busca')?.value.trim();
    const box = document.getElementById('novo-cat-resultados');
    if (!contaSel) { alert('Selecione uma loja primeiro.'); return; }
    if (!termo) return;
    if (box) box.innerHTML = 'Buscando...';
    try {
      const r = await MarketplaceAPI.call('search_categories', { q: termo, meliUserId: meliIdDaConta(contaSel) });
      const results = r.data?.results || r.data || [];
      categoriasBusca = Array.isArray(results) ? results.slice(0, 10) : [];
      if (box) {
        box.innerHTML = categoriasBusca.length
          ? categoriasBusca.map((c, i) => `
              <div class="card" style="padding:8px 12px;margin-bottom:6px;cursor:pointer;" onclick="_anunSelecionarCategoria(${i})">
                <div style="font-size:12.5px;color:var(--text-primary);">${c.path_from_root ? c.path_from_root.map(p => p.name).join(' › ') : (c.name || c.category_name || c.id)}</div>
              </div>
            `).join('')
          : '<div style="font-size:12px;color:var(--text-muted);">Nada encontrado.</div>';
      }
    } catch (e) {
      if (box) box.innerHTML = 'Erro: ' + (e.message || e);
    }
  }

  async function selecionarCategoria(i) {
    const c = categoriasBusca[i];
    if (!c) return;
    novo.categoria = c;
    novo.atributos = [];
    renderCriarNovo();
    try {
      const r = await MarketplaceAPI.call('category_attributes', { categoryId: c.id || c.category_id, meliUserId: meliIdDaConta(contaSel) });
      const items = r.data?.items || r.data || [];
      novo.atributos = (Array.isArray(items) ? items : []).filter(a => a?.tags?.required && !a?.tags?.read_only && !a?.tags?.hidden);
    } catch (e) {
      alert('Erro ao buscar atributos obrigatórios da categoria: ' + (e.message || e));
    }
    renderCriarNovo();
  }

  function slotHtmlNovo(slot, id, titulo) {
    return `
      <div class="card" style="flex:1;min-width:280px;">
        <div style="font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:10px;">${titulo}</div>
        <div style="display:flex;gap:10px;margin-bottom:10px;">
          <div style="flex-shrink:0;">
            ${novo.refPreviewUrl ? `<img src="${novo.refPreviewUrl}" style="width:78px;height:78px;object-fit:cover;border-radius:10px;border:1px solid var(--border);">` : `<div style="width:78px;height:78px;border-radius:10px;border:1px dashed var(--border);"></div>`}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${novo.refPreviewUrl ? 'Usando a referência enviada acima' : 'Envie a foto de referência do produto acima primeiro'}</div>
            <input type="text" class="form-input" id="${id}-prompt" placeholder="Prompt opcional (ex: fundo branco, iluminação de estúdio)" value="${slot.prompt}" style="font-size:12px;margin-top:6px;">
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" style="width:100%;" ${slot.gerando ? 'disabled' : ''} onclick="_anunGerar('${id}')">
          ${slot.gerando ? '⏳ Gerando...' : '🎨 Gerar variação com IA'}
        </button>
        ${gerasHtmlComum(slot, id)}
      </div>`;
  }

  function renderCriarNovo() {
    const box = document.getElementById('anun-painel');
    if (!box) return;
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px;">
        <div class="form-group"><label class="form-label">Categoria do produto</label>
          <div style="display:flex;gap:8px;">
            <input type="text" class="form-input" id="novo-cat-busca" placeholder="Ex: armário de cozinha" style="flex:1;">
            <button class="btn btn-secondary btn-sm" ${contaSel ? '' : 'disabled'} onclick="_anunBuscarCategoria()">🔍 Buscar</button>
          </div>
          <div id="novo-cat-resultados" style="margin-top:8px;"></div>
          ${novo.categoria ? `<div style="margin-top:8px;padding:8px 10px;background:var(--accent-soft, rgba(99,102,241,0.06));border-radius:8px;font-size:12.5px;color:var(--text-secondary);">Categoria selecionada: <strong>${novo.categoria.path_from_root ? novo.categoria.path_from_root.map(p => p.name).join(' › ') : (novo.categoria.name || novo.categoria.id)}</strong></div>` : ''}
        </div>
      </div>

      ${novo.categoria ? `
      <div class="card" style="margin-bottom:16px;">
        <div class="form-group"><label class="form-label">Título</label>
          <input type="text" class="form-input" id="novo-titulo" maxlength="60" placeholder="Título do anúncio">
        </div>
        <div class="grid-2" style="gap:12px;">
          <div class="form-group"><label class="form-label">Preço (R$)</label>
            <input type="number" step="0.01" class="form-input" id="novo-preco">
          </div>
          <div class="form-group"><label class="form-label">Estoque</label>
            <input type="number" class="form-input" id="novo-estoque" value="1">
          </div>
        </div>
        <div class="form-group"><label class="form-label">Condição</label>
          <select class="form-select" id="novo-condicao">
            <option value="new">Novo</option>
            <option value="used">Usado</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Descrição</label>
          <textarea class="form-textarea" id="novo-desc" rows="6"></textarea>
        </div>
        ${novo.atributos.length ? `
          <div style="font-size:13px;font-weight:700;color:var(--text-primary);margin:14px 0 8px;">Atributos obrigatórios da categoria</div>
          ${novo.atributos.map(a => `
            <div class="form-group"><label class="form-label">${a.name}</label>
              ${a.values && a.values.length ? `
                <select class="form-select" data-attr="${a.id}">
                  <option value="">Selecione...</option>
                  ${a.values.map(v => `<option value="${v.id}">${v.name}</option>`).join('')}
                </select>
              ` : `
                <input type="text" class="form-input" data-attr="${a.id}" placeholder="${a.value_type === 'number_unit' ? 'Ex: 35 cm' : ''}">
              `}
            </div>
          `).join('')}
        ` : '<div style="font-size:12px;color:var(--text-muted);margin-top:10px;">Carregando atributos obrigatórios da categoria...</div>'}
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div class="form-group"><label class="form-label">Foto de referência do produto (envie do computador)</label>
          <input type="file" accept="image/*" id="novo-ref-upload" onchange="_anunUploadRef(this)">
          ${novo.refPreviewUrl ? `<img src="${novo.refPreviewUrl}" style="width:90px;height:90px;object-fit:cover;border-radius:10px;margin-top:8px;border:1px solid var(--border);">` : ''}
        </div>
      </div>

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;">
        ${slotHtmlNovo(slotPrincipal, 'principal', '📷 Foto Principal (capa)')}
        ${slotHtmlNovo(slotDetalhe, 'detalhe', '🔍 Foto de Detalhe')}
      </div>

      <div class="card" style="background:var(--accent-soft, rgba(99,102,241,0.06));">
        <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;">
          ⚠️ Criar publica um anúncio <strong>novo e real</strong> no Mercado Livre. Confira tudo antes de confirmar.
        </div>
        <div class="form-group"><label class="form-label">Responsável</label>
          <select class="form-select" id="anun-resp-novo">
            ${GLR.gestores.map(g => `<option>${g.nome}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary" style="width:100%;" onclick="_anunCriar()">✨ Criar Anúncio no Marketplace</button>
      </div>
      ` : ''}
    `;
  }

  // ── Layout / troca de modo ───────────────────────────────────
  function renderBody() {
    const btnE = document.getElementById('anun-modo-editar');
    const btnC = document.getElementById('anun-modo-criar');
    if (btnE) btnE.className = 'btn btn-sm ' + (modo === 'editar' ? 'btn-primary' : 'btn-secondary');
    if (btnC) btnC.className = 'btn btn-sm ' + (modo === 'criar' ? 'btn-primary' : 'btn-secondary');
    const body = document.getElementById('anun-body');
    if (!body) return;
    if (modo === 'editar') {
      body.innerHTML = `
        <div class="card" style="margin-bottom:16px;">
          <div style="display:flex;gap:8px;">
            <input type="text" class="form-input" id="anun-busca" placeholder="Buscar anúncio por título ou SKU..." style="flex:1;">
            <button class="btn btn-primary" id="anun-btn-buscar" ${contaSel ? '' : 'disabled'} onclick="_anunBuscar()">🔍 Buscar</button>
          </div>
          <div id="anun-busca-status" style="font-size:12px;color:var(--text-muted);margin-top:8px;"></div>
        </div>
        <div id="anun-resultados" style="margin-bottom:16px;"></div>
        <div id="anun-painel"></div>
      `;
      renderResultados();
      renderPainel();
    } else {
      body.innerHTML = `<div id="anun-painel"></div>`;
      renderCriarNovo();
    }
  }

  el.innerHTML = `<div class="page">
    <div class="section-title mb-16">🎨 Central de Anúncios</div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;max-width:640px;">
      Edite um anúncio existente ou crie um novo do zero — em ambos os casos dá pra gerar fotos novas com IA a partir de uma foto de referência.
    </div>

    ${!apiKey ? `<div class="card" style="border-color:var(--red);"><div style="color:var(--red);font-size:13px;">⚠️ Configure a API Key nas Integrações antes de usar esta página.</div></div>` : `

    <div class="card" style="margin-bottom:16px;">
      <div class="form-group"><label class="form-label">Loja (conta Mercado Livre)</label>
        <select class="form-select" id="anun-conta"><option value="">Carregando lojas...</option></select>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <button class="btn btn-sm btn-primary" id="anun-modo-editar" onclick="_anunModo('editar')">✏️ Editar anúncio existente</button>
      <button class="btn btn-sm btn-secondary" id="anun-modo-criar" onclick="_anunModo('criar')">✨ Criar anúncio novo</button>
    </div>
    <div id="anun-body"></div>
    `}
  </div>`;

  if (apiKey) {
    renderBody();
    carregarContas().then(() => {
      const sel = document.getElementById('anun-conta');
      if (!contas.length) {
        sel.innerHTML = '<option value="">Nenhuma loja ML conectada</option>';
        return;
      }
      sel.innerHTML = '<option value="">Selecione a loja...</option>' + contas.map((c, i) => `<option value="${i}">${nomeDaConta(c)}</option>`).join('');
      sel.addEventListener('change', () => {
        contaSel = sel.value !== '' ? contas[sel.value] : null;
        resultadosBusca = []; resetItem(); resetNovo();
        renderBody();
      });
    }).catch(e => {
      const sel = document.getElementById('anun-conta');
      if (sel) sel.innerHTML = '<option value="">Erro ao carregar lojas</option>';
    });
  }

  window._anunModo = (m) => {
    if (modo === m) return;
    modo = m;
    resetItem(); resetNovo(); resultadosBusca = [];
    renderBody();
  };
  window._anunBuscar = buscarAnuncios;
  window._anunSelecionar = selecionarItem;
  window._anunBuscarCategoria = buscarCategoria;
  window._anunSelecionarCategoria = selecionarCategoria;
  window._anunGerar = (id) => gerarFoto(id === 'principal' ? slotPrincipal : slotDetalhe, id);
  window._anunSlotRef = (id, url) => { (id === 'principal' ? slotPrincipal : slotDetalhe).refUrl = url; render(); };
  window._anunEscolher = (id, idx) => { (id === 'principal' ? slotPrincipal : slotDetalhe).escolhidaIdx = idx; render(); };

  window._anunUploadRef = (input) => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      novo.refPreviewUrl = dataUrl;
      novo.refBase64 = dataUrl.split(',')[1] || '';
      slotPrincipal.refBase64 = novo.refBase64;
      slotDetalhe.refBase64 = novo.refBase64;
      renderCriarNovo();
    };
    reader.readAsDataURL(file);
  };

  window._anunPublicar = async () => {
    if (!itemAtual) return;
    const tituloNovo = document.getElementById('anun-titulo').value.trim();
    const descNova = document.getElementById('anun-desc').value.trim();
    const responsavel = document.getElementById('anun-resp').value;
    const mudouTitulo = tituloNovo && tituloNovo !== itemAtual.title;
    const mudouDesc = descNova !== (itemAtual._descricaoAtual || '');
    const publicaPrincipal = slotPrincipal.geradas.length > 0;
    const publicaDetalhe = slotDetalhe.geradas.length > 0;

    if (!mudouTitulo && !mudouDesc && !publicaPrincipal && !publicaDetalhe) {
      alert('Nada foi alterado ainda.'); return;
    }

    const resumo = [
      mudouTitulo ? `• Título → "${tituloNovo}"` : null,
      mudouDesc ? '• Descrição atualizada' : null,
      publicaPrincipal ? '• Foto principal atualizada' : null,
      publicaDetalhe ? '• Foto de detalhe atualizada' : null,
    ].filter(Boolean).join('\n');
    if (!confirm(`Confirma publicar estas alterações no anúncio ${itemAtual.id} (marketplace real)?\n\n${resumo}`)) return;

    const meliUserId = meliIdDaConta(contaSel);
    const erros = [];
    try {
      if (mudouTitulo) {
        await MarketplaceAPI.call('update_item', { item_id: itemAtual.id, meliUserId, title: tituloNovo });
      }
    } catch (e) { erros.push('Título: ' + (e.message || e)); }
    try {
      if (mudouDesc) {
        await MarketplaceAPI.call('update_description', { item_id: itemAtual.id, meliUserId, plain_text: descNova, description: descNova });
      }
    } catch (e) { erros.push('Descrição: ' + (e.message || e)); }
    try {
      if (publicaPrincipal || publicaDetalhe) {
        // pictures do update_item SUBSTITUI a galeria inteira — monta a lista com as
        // fotos atuais (por {id}, na ordem) e só troca as posições que foram geradas.
        // A URL gerada já vem pública (subida pro host da Tiops dentro de
        // /api/generate-photo), então entra direto em source, sem upload extra aqui.
        const pics = fotosAtuais.map(f => ({ id: f.id }));
        if (publicaPrincipal) {
          const url = slotPrincipal.geradas[slotPrincipal.escolhidaIdx]?.url;
          if (!url) throw new Error('Foto principal sem URL gerada.');
          pics[0] = { source: url };
        }
        if (publicaDetalhe) {
          const url = slotDetalhe.geradas[slotDetalhe.escolhidaIdx]?.url;
          if (!url) throw new Error('Foto de detalhe sem URL gerada.');
          if (pics.length > 1) pics[1] = { source: url }; else pics.push({ source: url });
        }
        await MarketplaceAPI.call('update_item', { item_id: itemAtual.id, meliUserId, pictures: pics });
      }
    } catch (e) { erros.push('Fotos: ' + (e.message || e)); }

    if (erros.length) {
      alert('Publicado com erros:\n' + erros.join('\n'));
    } else {
      alert('✅ Anúncio atualizado com sucesso!');
    }

    try {
      GLR.acoes.push({
        id: GLR.nextId(GLR.acoes),
        clienteId: null,
        data: new Date().toISOString().split('T')[0],
        categoria: 'Catálogo',
        descricao: `Anúncio ${itemAtual.id} atualizado (${resumo.replace(/\n/g, ' ')})`,
        responsavel,
        status: 'concluida',
      });
      localStorage.setItem('glr_acoes', JSON.stringify(GLR.acoes));
    } catch (e) {}

    resetItem();
    renderResultados();
    renderPainel();
  };

  window._anunCriar = async () => {
    if (!contaSel) { alert('Selecione uma loja primeiro.'); return; }
    if (!novo.categoria) { alert('Escolha uma categoria primeiro.'); return; }
    const titulo = document.getElementById('novo-titulo')?.value.trim();
    const preco = parseFloat(document.getElementById('novo-preco')?.value);
    const estoque = parseInt(document.getElementById('novo-estoque')?.value, 10);
    const condicao = document.getElementById('novo-condicao')?.value;
    const descricao = document.getElementById('novo-desc')?.value.trim();
    const responsavel = document.getElementById('anun-resp-novo')?.value;

    if (!titulo) { alert('Informe o título.'); return; }
    if (!preco || preco <= 0) { alert('Informe um preço válido.'); return; }
    if (!estoque || estoque <= 0) { alert('Informe um estoque válido.'); return; }

    const attrs = [];
    document.querySelectorAll('#anun-painel [data-attr]').forEach(input => {
      const id = input.dataset.attr;
      if (input.tagName === 'SELECT') {
        if (!input.value) return;
        attrs.push({ id, value_id: input.value, value_name: input.selectedOptions[0]?.textContent || undefined });
      } else {
        const v = input.value.trim();
        if (v) attrs.push({ id, value_name: v });
      }
    });

    const pics = [];
    [slotPrincipal, slotDetalhe].forEach(slot => {
      const g = slot.geradas[slot.escolhidaIdx];
      if (g?.url) pics.push({ source: g.url });
    });

    const resumo = `• Título: ${titulo}\n• Preço: R$ ${preco.toFixed(2)}\n• Estoque: ${estoque}\n• Categoria: ${novo.categoria.path_from_root ? novo.categoria.path_from_root.map(p => p.name).join(' › ') : (novo.categoria.name || novo.categoria.id)}\n• Fotos: ${pics.length ? pics.length + ' gerada(s) por IA' : (novo.refBase64 ? 'só a referência enviada (nenhuma variação de IA escolhida)' : 'nenhuma — o anúncio sobe sem foto')}`;
    if (!confirm(`Confirma CRIAR este anúncio novo no Mercado Livre (marketplace real)?\n\n${resumo}`)) return;

    try {
      const payload = {
        meliUserId: meliIdDaConta(contaSel),
        title: titulo,
        price: preco,
        category_id: novo.categoria.id || novo.categoria.category_id,
        available_quantity: estoque,
        condition: condicao,
        description: descricao,
        attributes: attrs,
      };
      if (pics.length) payload.pictures = pics;
      else if (novo.refBase64) payload.images_base64 = [novo.refBase64];
      const r = await MarketplaceAPI.call('create_item', payload);
      const novoId = r.data?.id || r.data?.body?.id || r.id;
      alert('✅ Anúncio criado' + (novoId ? `: ${novoId}` : '') + '!');

      try {
        GLR.acoes.push({
          id: GLR.nextId(GLR.acoes),
          clienteId: null,
          data: new Date().toISOString().split('T')[0],
          categoria: 'Catálogo',
          descricao: `Novo anúncio criado${novoId ? ' (' + novoId + ')' : ''}: ${titulo}`,
          responsavel,
          status: 'concluida',
        });
        localStorage.setItem('glr_acoes', JSON.stringify(GLR.acoes));
      } catch (e) {}

      resetNovo();
      renderCriarNovo();
    } catch (e) {
      alert('Erro ao criar anúncio: ' + (e.message || e));
    }
  };
});
