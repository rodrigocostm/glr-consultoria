// ============================================================
// GLR Consultoria — Central de Anúncios (analistas criam título,
// descrição e um kit de fotos com IA, e publicam direto no Mercado Livre.
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
  const novo = { categoria: null, atributos: [] };

  // Kit de fotos com IA — compartilhado pelos dois modos. refUrl (editar, foto já
  // existente) ou refBase64 (criar, upload do computador) alimenta a geração.
  const kit = {
    refUrl: '', refBase64: '', refPreviewUrl: '',
    nome: '', detalhes: '',
    gerando: false, imagens: [], selecionadas: [], erros: [],
  };

  function resetKit() {
    kit.refUrl = ''; kit.refBase64 = ''; kit.refPreviewUrl = '';
    kit.nome = ''; kit.detalhes = '';
    kit.gerando = false; kit.imagens = []; kit.selecionadas = []; kit.erros = [];
  }
  function resetItem() {
    itemAtual = null; fotosAtuais = [];
    resetKit();
  }
  function resetNovo() {
    novo.categoria = null; novo.atributos = [];
    categoriasBusca = [];
    resetKit();
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

  // ── Kit de fotos com IA (não passa pela Tiops) ──────────────────
  // Usa direto a API da OpenAI (gpt-image-1) via /api/generate-photo (function
  // serverless própria, chave guardada no ambiente da Vercel) e já devolve fotos
  // com URL pública. Publicar no marketplace continua indo pela Tiops — é o único
  // jeito de escrever no anúncio real.
  function processarArquivoKit(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      kit.refPreviewUrl = dataUrl;
      kit.refBase64 = dataUrl.split(',')[1] || '';
      renderKit();
    };
    reader.readAsDataURL(file);
  }

  // Zona de referência: no modo criar é uma dropzone de upload; no modo editar é
  // uma tira de miniaturas da galeria atual do anúncio pra escolher a referência.
  function renderKitReferencia() {
    if (modo === 'editar') {
      return `
        <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;">Foto de referência (galeria atual)</div>
        <div style="display:flex;gap:8px;overflow-x:auto;padding:4px 2px 8px;">
          ${fotosAtuais.map((f, i) => {
            const u = f.secure_url || f.url;
            const sel = u === kit.refUrl;
            return `<img src="${u}" onclick="_anunKitRef('${u}')"
              style="width:66px;height:66px;object-fit:cover;border-radius:10px;cursor:pointer;flex-shrink:0;border:3px solid ${sel ? '#6366f1' : 'transparent'};opacity:${sel ? '1' : '.55'};transition:.15s;">`;
          }).join('')}
        </div>`;
    }
    return `
      <div id="kit-dropzone" ondragover="event.preventDefault();this.style.borderColor='#6366f1';" ondragleave="this.style.borderColor='var(--border)';"
           ondrop="event.preventDefault();this.style.borderColor='var(--border)';_anunKitDrop(event);"
           onclick="document.getElementById('kit-file-input').click()"
           style="border:2px dashed var(--border);border-radius:16px;min-height:190px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;text-align:center;padding:20px;background:var(--bg-soft,#f7f8fc);transition:border-color .15s;">
        ${kit.refPreviewUrl
          ? `<img src="${kit.refPreviewUrl}" style="max-width:100%;max-height:150px;border-radius:10px;object-fit:contain;">
             <div style="font-size:11px;color:var(--text-muted);margin-top:10px;">Clique pra trocar a foto</div>`
          : `<div style="width:44px;height:44px;border-radius:50%;background:rgba(99,102,241,0.1);display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:10px;">📤</div>
             <div style="font-size:13px;font-weight:600;color:var(--text-primary);">Arraste ou clique pra enviar</div>
             <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Foto do produto original, em boa resolução</div>`}
        <input type="file" id="kit-file-input" accept="image/*" style="display:none;" onchange="_anunKitUpload(this)">
      </div>`;
  }

  function renderKit() {
    const box = document.getElementById('anun-kit');
    if (!box) return;
    const temRef = modo === 'criar' ? !!kit.refBase64 : !!kit.refUrl;
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px;padding:26px;">
        <div style="text-align:center;margin-bottom:22px;">
          <div style="width:50px;height:50px;border-radius:14px;background:rgba(99,102,241,0.1);display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 10px;">🎨</div>
          <div style="font-size:17px;font-weight:800;color:var(--text-primary);">Kit de Fotos com IA</div>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;max-width:440px;margin-left:auto;margin-right:auto;">Gere um kit de 3 fotos profissionais prontas pra anunciar (ambientada premium, detalhe em zoom e frontal na mesma ambientação), a partir de 1 foto de referência.</div>
        </div>
        <div style="display:flex;gap:22px;flex-wrap:wrap;margin-bottom:18px;">
          <div style="flex:1;min-width:220px;">${renderKitReferencia()}</div>
          <div style="flex:1.3;min-width:260px;display:flex;flex-direction:column;gap:14px;">
            <div class="form-group" style="margin:0;"><label class="form-label">Nome do Produto</label>
              <input type="text" class="form-input" id="kit-nome" value="${(kit.nome || '').replace(/"/g, '&quot;')}" placeholder="Ex: Armário de Cozinha 2 Portas">
            </div>
            <div class="form-group" style="margin:0;"><label class="form-label">Detalhes & instruções (opcional)</label>
              <textarea class="form-textarea" id="kit-detalhes" rows="3" placeholder="Cor, material, diferenciais, estilo de foto desejado...">${kit.detalhes || ''}</textarea>
            </div>
          </div>
        </div>
        <button class="btn btn-primary" style="width:100%;padding:14px;font-size:14px;border-radius:12px;" ${(!temRef || kit.gerando) ? 'disabled' : ''} onclick="_anunGerarKit()">
          ${kit.gerando ? '⏳ Gerando kit...' : '🎨 Gerar Kit de Fotos (3 fotos)'}
        </button>
        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:center;">Kit em cascata: 1 ambientada premium, e a partir dela 1 close-up de detalhe e 1 de frente — todas no mesmo ambiente.</div>
        ${kit.erros.length ? `<div style="font-size:11px;color:var(--red);margin-top:8px;">${kit.erros.length} foto(s) do kit falharam: ${kit.erros.join(' · ')}</div>` : ''}
        ${kit.imagens.length ? `
          <div style="font-size:12.5px;font-weight:600;color:var(--text-primary);margin:18px 0 10px;">Escolha as fotos que vão pro anúncio (${kit.selecionadas.length} selecionada${kit.selecionadas.length !== 1 ? 's' : ''}):</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
            ${kit.imagens.map((im, i) => `
              <img src="${im.url}" onclick="_anunKitToggle(${i})"
                style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;cursor:pointer;border:3px solid ${kit.selecionadas.includes(i) ? '#6366f1' : 'transparent'};opacity:${kit.selecionadas.includes(i) ? '1' : '.5'};transition:.15s;">
            `).join('')}
          </div>
        ` : ''}
      </div>`;
  }

  window._anunGerarKit = async () => {
    const temRef = modo === 'criar' ? !!kit.refBase64 : !!kit.refUrl;
    if (!temRef) { alert('Escolha ou envie a foto de referência antes de gerar.'); return; }
    kit.nome = document.getElementById('kit-nome')?.value || '';
    kit.detalhes = document.getElementById('kit-detalhes')?.value || '';
    kit.gerando = true; kit.imagens = []; kit.selecionadas = []; kit.erros = [];
    renderKit();
    try {
      const body = { product_name: kit.nome, details: kit.detalhes };
      if (modo === 'criar') body.image_base64 = kit.refBase64;
      else body.image_url = kit.refUrl;

      const resp = await fetch('/api/generate-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Erro ao gerar kit.');
      kit.imagens = json.images || [];
      kit.selecionadas = kit.imagens.map((_, i) => i);
      kit.erros = json.erros || [];
      if (!kit.imagens.length) alert('Não consegui gerar nenhuma foto do kit.');
    } catch (e) {
      alert('Erro ao gerar kit: ' + (e.message || e));
    } finally {
      kit.gerando = false;
      renderKit();
    }
  };
  window._anunKitToggle = (i) => {
    const idx = kit.selecionadas.indexOf(i);
    if (idx >= 0) kit.selecionadas.splice(idx, 1); else kit.selecionadas.push(i);
    renderKit();
  };
  window._anunKitRef = (url) => { kit.refUrl = url; renderKit(); };
  window._anunKitUpload = (input) => processarArquivoKit(input.files?.[0]);
  window._anunKitDrop = (ev) => processarArquivoKit(ev.dataTransfer?.files?.[0]);

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
      resetKit();
      kit.refUrl = fotosAtuais[0]?.secure_url || fotosAtuais[0]?.url || '';
      kit.nome = itemAtual.title || '';
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
      <div id="anun-kit"></div>
      <div class="card" style="background:var(--accent-soft, rgba(99,102,241,0.06));">
        <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;">
          ⚠️ Publicar altera o anúncio <strong>real</strong> no Mercado Livre. Se você selecionar fotos do kit, elas <strong>substituem toda a galeria</strong> atual do anúncio.
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
    renderKit();
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

      <div id="anun-kit"></div>

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
    if (novo.categoria) renderKit();
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
      Edite um anúncio existente ou crie um novo do zero — em ambos os casos dá pra gerar um kit de fotos com IA a partir de uma foto de referência.
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

  window._anunPublicar = async () => {
    if (!itemAtual) return;
    const tituloNovo = document.getElementById('anun-titulo').value.trim();
    const descNova = document.getElementById('anun-desc').value.trim();
    const responsavel = document.getElementById('anun-resp').value;
    const mudouTitulo = tituloNovo && tituloNovo !== itemAtual.title;
    const mudouDesc = descNova !== (itemAtual._descricaoAtual || '');
    const fotosSelecionadas = kit.selecionadas.map(i => kit.imagens[i]).filter(Boolean);

    if (!mudouTitulo && !mudouDesc && !fotosSelecionadas.length) {
      alert('Nada foi alterado ainda.'); return;
    }

    const resumo = [
      mudouTitulo ? `• Título → "${tituloNovo}"` : null,
      mudouDesc ? '• Descrição atualizada' : null,
      fotosSelecionadas.length ? `• Galeria substituída por ${fotosSelecionadas.length} foto(s) do kit` : null,
    ].filter(Boolean).join('\n');
    if (!confirm(`Confirma publicar estas alterações no anúncio ${itemAtual.id} (marketplace real)?\n\n${resumo}${fotosSelecionadas.length ? '\n\n⚠️ As fotos ATUAIS do anúncio serão todas substituídas pelas selecionadas.' : ''}`)) return;

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
      if (fotosSelecionadas.length) {
        await MarketplaceAPI.call('update_item', {
          item_id: itemAtual.id, meliUserId,
          pictures: fotosSelecionadas.map(f => ({ source: f.url })),
        });
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

    const fotosSelecionadas = kit.selecionadas.map(i => kit.imagens[i]).filter(Boolean);

    const resumo = `• Título: ${titulo}\n• Preço: R$ ${preco.toFixed(2)}\n• Estoque: ${estoque}\n• Categoria: ${novo.categoria.path_from_root ? novo.categoria.path_from_root.map(p => p.name).join(' › ') : (novo.categoria.name || novo.categoria.id)}\n• Fotos: ${fotosSelecionadas.length ? fotosSelecionadas.length + ' do kit gerado por IA' : (kit.refBase64 ? 'só a referência enviada (nenhuma do kit escolhida)' : 'nenhuma — o anúncio sobe sem foto')}`;
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
      if (fotosSelecionadas.length) payload.pictures = fotosSelecionadas.map(f => ({ source: f.url }));
      else if (kit.refBase64) payload.images_base64 = [kit.refBase64];
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
