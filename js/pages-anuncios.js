// ============================================================
// GLR Consultoria — Central de Anúncios (criação de anúncio novo, completo,
// direto no marketplace). Mercado Livre está funcional; Shopee/TikTok/Amazon
// ficam com uma tela de "em construção" até serem construídas na mesma
// profundidade (categoria + ficha técnica reais, IA de foto integrada).
// ============================================================
(function () {

  function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

  // ── Placeholder para os marketplaces ainda não construídos ──────────────
  const _PLACEHOLDER = {
    shopee:  { nome: 'Shopee',      cor: '#ee4d2d' },
    tiktok:  { nome: 'TikTok Shop', cor: '#000000' },
    amazon:  { nome: 'Amazon',      cor: '#ff9900' },
  };

  function renderEmConstrucao(mkt, el) {
    const info = _PLACEHOLDER[mkt];
    el.innerHTML = `<div class="page">
      <div style="text-align:center;padding:80px 24px;">
        <div style="font-size:52px;margin-bottom:16px;">🚧</div>
        <div style="font-size:20px;font-weight:800;color:var(--text-primary);margin-bottom:8px;">Criação de anúncio ${info.nome} — em construção</div>
        <div style="font-size:14px;color:var(--text-muted);max-width:460px;margin:0 auto 20px;">
          A aba de Mercado Livre está completa (categoria real, ficha técnica dinâmica, foto com IA). ${info.nome} usa o mesmo padrão e entra em seguida.
        </div>
        <button class="btn btn-primary" onclick="Router.navigate('anuncios-ml')">Ir para Mercado Livre</button>
      </div>
    </div>`;
  }

  // ============================================================
  // MERCADO LIVRE
  // ============================================================

  const LISTING_TYPES = [
    { id: 'gold_special', nome: 'Clássico' },
    { id: 'gold_pro',     nome: 'Premium' },
  ];

  function renderML(params, el) {
    const state = {
      contas: [], contaId: '', carregandoContas: true,

      fotos: [], // { id, url, origem: 'referencia'|'gerada'|'upload' }
      fotoRefBase64: '', fotoRefPreview: '',
      iaCarregando: false, gerandoFoto: false,

      categoriaBuscaInput: '', categoriaResultados: [], categoriaEscolhida: null, buscandoCategoria: false,
      atributosObrigatorios: [], atributosOpcionais: [], mostrarOpcionais: false, carregandoAtributos: false,
      valoresAtributos: {},

      titulo: '', descricao: '', preco: '', estoque: '', condicao: 'new', tipoAnuncio: 'gold_special',
      garantia: '', sku: '', gtin: '',

      criando: false, resultado: null, erro: '',
    };

    // ── Sincroniza o que está no DOM pro state antes de qualquer re-render,
    // pra não perder o que o analista já digitou quando uma ação (foto,
    // categoria) força um render novo da página inteira. ──
    function syncFormState() {
      const v = id => document.getElementById(id)?.value;
      if (document.getElementById('an-titulo')) {
        state.titulo = v('an-titulo') || ''; state.descricao = v('an-descricao') || '';
        state.preco = v('an-preco') || ''; state.estoque = v('an-estoque') || '';
        state.condicao = v('an-condicao') || 'new'; state.tipoAnuncio = v('an-tipo') || 'gold_special';
        state.garantia = v('an-garantia') || ''; state.sku = v('an-sku') || ''; state.gtin = v('an-gtin') || '';
      }
      if (document.getElementById('an-cat-busca')) state.categoriaBuscaInput = v('an-cat-busca') || '';
      [...state.atributosObrigatorios, ...state.atributosOpcionais].forEach(a => {
        const campo = campoDoAtributo(a);
        if (campo.tipo === 'numero_unidade') {
          const n = v(`attr-${a.id}-num`); const u = v(`attr-${a.id}-unit`);
          if (n) state.valoresAtributos[a.id] = { num: n, unit: u };
        } else {
          const val = v(`attr-${a.id}`);
          if (val) state.valoresAtributos[a.id] = val;
        }
      });
    }

    function render() { renderPainel(); }

    // ── Contas ────────────────────────────────────────────────
    async function carregarContas() {
      try {
        const todas = await MarketplaceAPI.listAccounts();
        state.contas = todas.filter(c => ['meli', 'ml', 'mercadolivre'].includes((c.marketplace || '').toLowerCase()));
        if (state.contas.length === 1) state.contaId = state.contas[0].param_to_use?.meliUserId || state.contas[0].external_id;
      } catch (e) {
        state.erro = 'Não consegui carregar as contas: ' + e.message;
      } finally {
        state.carregandoContas = false;
        render();
      }
    }

    function nomeConta(c) {
      const tag = c.tags?.[0]?.name || c.tags?.[0];
      return (typeof tag === 'string' ? tag : tag?.value) || c.nickname || c.external_id;
    }

    // ── Foto de referência + IA ──────────────────────────────
    function processarFotoRef(file) {
      if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        state.fotoRefPreview = String(reader.result || '');
        state.fotoRefBase64 = state.fotoRefPreview;
        adicionarFoto(state.fotoRefBase64, 'referencia');
      };
      reader.readAsDataURL(file);
    }

    function adicionarFoto(url, origem) {
      syncFormState();
      state.fotos.push({ id: Date.now() + Math.random(), url, origem });
      render();
    }

    function removerFoto(id) {
      syncFormState();
      state.fotos = state.fotos.filter(f => f.id !== id);
      render();
    }

    async function sugerirComIA() {
      if (!state.fotoRefBase64) { alert('Envie a foto do produto primeiro.'); return; }
      syncFormState();
      state.iaCarregando = true;
      render();
      try {
        const resp = await fetch('/api/analyze-photo', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: state.fotoRefBase64 }),
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || 'Erro ao sugerir com IA.');
        if (json.titulo) state.titulo = json.titulo.slice(0, 60);
        if (json.descricao) state.descricao = json.descricao;
        if (json.categoria_busca) {
          state.categoriaBuscaInput = json.categoria_busca;
          await buscarCategoria(json.categoria_busca);
          return; // buscarCategoria já chama render()
        }
      } catch (e) {
        alert('Erro ao sugerir com IA: ' + (e.message || e));
      } finally {
        state.iaCarregando = false;
        render();
      }
    }

    async function gerarFotoIA() {
      if (!state.fotoRefBase64) { alert('Envie a foto do produto primeiro.'); return; }
      syncFormState();
      state.gerandoFoto = true;
      render();
      try {
        const resp = await fetch('/api/generate-photo', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: state.fotoRefBase64, product_name: state.titulo, details: state.descricao, stage: 'ambientada' }),
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || 'Erro ao gerar foto.');
        const img = json.images?.[0];
        if (!img) { alert('A IA não devolveu nenhuma imagem.'); return; }
        state.fotos.push({ id: Date.now() + Math.random(), url: img.url, origem: 'gerada' });
      } catch (e) {
        alert('Erro ao gerar foto: ' + (e.message || e));
      } finally {
        state.gerandoFoto = false;
        render();
      }
    }

    function processarFotosExtra(files) {
      syncFormState();
      [...files].forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => { adicionarFoto(String(reader.result || ''), 'upload'); };
        reader.readAsDataURL(file);
      });
    }

    // ── Categoria + ficha técnica ────────────────────────────
    async function buscarCategoria(qManual) {
      syncFormState();
      const q = qManual || state.categoriaBuscaInput;
      if (!q || !q.trim()) { alert('Digite um termo pra buscar a categoria.'); return; }
      if (!state.contaId) { alert('Selecione a conta do Mercado Livre primeiro.'); return; }
      state.buscandoCategoria = true;
      state.categoriaResultados = [];
      render();
      try {
        const resp = await MarketplaceAPI.call('search_categories', { q, meliUserId: state.contaId });
        state.categoriaResultados = resp.data?.items || resp.items || [];
        if (!state.categoriaResultados.length) alert('Nenhuma categoria encontrada pra "' + q + '". Tente outro termo.');
      } catch (e) {
        alert('Erro ao buscar categoria: ' + (e.message || e));
      } finally {
        state.buscandoCategoria = false;
        render();
      }
    }

    async function escolherCategoria(cat) {
      syncFormState();
      state.categoriaEscolhida = cat;
      state.categoriaResultados = [];
      state.valoresAtributos = {};
      state.mostrarOpcionais = false;
      state.carregandoAtributos = true;
      render();
      try {
        const resp = await MarketplaceAPI.call('category_attributes', { categoryId: cat.category_id, meliUserId: state.contaId });
        const todos = resp.data?.items || resp.items || [];
        const relevantes = todos.filter(a => !a.tags?.hidden && !a.tags?.read_only && !a.tags?.variation_attribute
          && !['SELLER_SKU', 'GTIN', 'EMPTY_GTIN_REASON'].includes(a.id));
        state.atributosObrigatorios = relevantes.filter(a => a.tags?.required || a.tags?.catalog_required);
        state.atributosOpcionais = relevantes.filter(a => !(a.tags?.required || a.tags?.catalog_required));
        state._todosAtributos = todos; // guarda pra checar EMPTY_GTIN_REASON no submit
      } catch (e) {
        alert('Erro ao buscar ficha técnica da categoria: ' + (e.message || e));
      } finally {
        state.carregandoAtributos = false;
        render();
      }
    }

    // ── Renderização de campo de atributo dinâmico ───────────
    function campoDoAtributo(a) {
      if (Array.isArray(a.values) && a.values.length) return { tipo: 'lista' };
      if (a.value_type === 'number_unit') return { tipo: 'numero_unidade' };
      return { tipo: 'texto' };
    }

    function renderCampoAtributo(a) {
      const campo = campoDoAtributo(a);
      const valorSalvo = state.valoresAtributos[a.id];
      if (campo.tipo === 'lista') {
        return `<select class="form-select" id="attr-${a.id}">
          <option value="">— não informado —</option>
          ${a.values.map(v => `<option value="${esc(v.name)}" ${valorSalvo === v.name ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
        </select>`;
      }
      if (campo.tipo === 'numero_unidade') {
        const units = a.allowed_units || [{ id: a.default_unit || 'cm', name: a.default_unit || 'cm' }];
        const savedNum = valorSalvo?.num || ''; const savedUnit = valorSalvo?.unit || a.default_unit;
        return `<div style="display:flex;gap:6px;">
          <input type="number" step="0.01" class="form-input" id="attr-${a.id}-num" value="${esc(savedNum)}" style="flex:1;">
          <select class="form-select" id="attr-${a.id}-unit" style="width:80px;">
            ${units.map(u => `<option value="${esc(u.id)}" ${savedUnit === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
          </select>
        </div>`;
      }
      return `<input type="text" class="form-input" id="attr-${a.id}" maxlength="${a.value_max_length || 255}" value="${esc(valorSalvo || '')}" placeholder="${a.hint || ''}">`;
    }

    function renderBlocoAtributos(lista, titulo, colapsavel) {
      if (!lista.length) return '';
      const conteudo = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
        ${lista.map(a => `<div class="form-group" style="margin:0;">
          <label class="form-label">${esc(a.name)}${a.tags?.required || a.tags?.catalog_required ? ' *' : ''}</label>
          ${renderCampoAtributo(a)}
          ${a.tooltip ? `<div style="font-size:10.5px;color:var(--text-muted);margin-top:3px;">${esc(a.tooltip)}</div>` : ''}
        </div>`).join('')}
      </div>`;
      if (!colapsavel) return `<div style="margin-top:14px;"><div class="form-label" style="margin-bottom:8px;">${titulo}</div>${conteudo}</div>`;
      return `<div style="margin-top:14px;">
        <button type="button" class="btn btn-secondary btn-sm" onclick="window._anMlToggleOpcionais()">
          ${state.mostrarOpcionais ? '▲' : '▼'} ${titulo} (${lista.length})
        </button>
        ${state.mostrarOpcionais ? `<div style="margin-top:10px;">${conteudo}</div>` : ''}
      </div>`;
    }

    // ── Montagem do payload e criação ────────────────────────
    function montarAtributosPayload() {
      const out = [];
      const sku = document.getElementById('an-sku')?.value.trim();
      if (sku) out.push({ id: 'SELLER_SKU', value_name: sku });
      const gtin = document.getElementById('an-gtin')?.value.trim();
      const temEmptyGtinReason = (state._todosAtributos || []).some(a => a.id === 'EMPTY_GTIN_REASON');
      if (gtin) out.push({ id: 'GTIN', value_name: gtin });
      else if (temEmptyGtinReason) out.push({ id: 'EMPTY_GTIN_REASON', value_name: 'O produto não tem código cadastrado' });

      [...state.atributosObrigatorios, ...state.atributosOpcionais].forEach(a => {
        const campo = campoDoAtributo(a);
        if (campo.tipo === 'numero_unidade') {
          const num = document.getElementById(`attr-${a.id}-num`)?.value;
          const unit = document.getElementById(`attr-${a.id}-unit`)?.value;
          if (num) out.push({ id: a.id, value_name: `${num} ${unit}` });
        } else {
          const val = document.getElementById(`attr-${a.id}`)?.value?.trim();
          if (val) out.push({ id: a.id, value_name: val });
        }
      });
      return out;
    }

    async function criarAnuncio() {
      if (!state.contaId) return alert('Selecione a conta do Mercado Livre.');
      if (!state.categoriaEscolhida) return alert('Escolha uma categoria antes de criar o anúncio.');
      if (!state.fotos.length) return alert('Adicione pelo menos uma foto ao anúncio.');

      const titulo = document.getElementById('an-titulo')?.value.trim();
      const descricao = document.getElementById('an-descricao')?.value.trim();
      const preco = parseFloat(document.getElementById('an-preco')?.value);
      const estoque = parseInt(document.getElementById('an-estoque')?.value, 10);
      const condicao = document.getElementById('an-condicao')?.value;
      const tipoAnuncio = document.getElementById('an-tipo')?.value;
      const garantia = document.getElementById('an-garantia')?.value.trim();

      if (!titulo) return alert('Preencha o título do anúncio.');
      if (titulo.length > 60) return alert('Título não pode passar de 60 caracteres.');
      if (!(preco > 0)) return alert('Informe um preço válido.');
      if (!(estoque >= 0)) return alert('Informe o estoque.');

      const faltando = state.atributosObrigatorios.filter(a => {
        const campo = campoDoAtributo(a);
        if (campo.tipo === 'numero_unidade') return !document.getElementById(`attr-${a.id}-num`)?.value;
        return !document.getElementById(`attr-${a.id}`)?.value?.trim();
      });
      if (faltando.length && !confirm(`Faltam ${faltando.length} atributo(s) obrigatório(s) da ficha técnica (${faltando.map(a => a.name).join(', ')}). O Mercado Livre pode recusar o anúncio. Continuar mesmo assim?`)) return;

      const body = {
        meliUserId: state.contaId,
        category_id: state.categoriaEscolhida.category_id,
        price: preco,
        available_quantity: estoque,
        condition: condicao,
        listing_type_id: tipoAnuncio,
        description: descricao,
        images_base64: state.fotos.map(f => f.url),
        attributes: montarAtributosPayload(),
      };
      if (garantia) body.warranty = garantia;

      state.criando = true; state.erro = ''; state.resultado = null;
      render();
      try {
        let resp;
        try {
          resp = await MarketplaceAPI.call('create_item', { ...body, title: titulo });
        } catch (e1) {
          // Contas com "user products" recusam title e exigem family_name —
          // detectado ao vivo com um anúncio real (ver create_item docs).
          if (/family_name/i.test(e1.message)) {
            resp = await MarketplaceAPI.call('create_item', { ...body, family_name: titulo.slice(0, 60) });
          } else {
            throw e1;
          }
        }
        state.resultado = resp.data || resp;
      } catch (e) {
        state.erro = e.message || String(e);
      } finally {
        state.criando = false;
        render();
      }
    }

    function resetar() {
      Router.navigate('anuncios-ml');
    }

    // ── Render principal ──────────────────────────────────────
    function renderPainel() {
      const root = document.getElementById('an-ml-root');
      if (!root) return;

      if (state.resultado) {
        root.innerHTML = `<div class="card" style="padding:40px;text-align:center;max-width:520px;margin:0 auto;">
          <div style="font-size:44px;margin-bottom:12px;">✅</div>
          <div style="font-size:18px;font-weight:800;margin-bottom:8px;">Anúncio criado no Mercado Livre!</div>
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">ID: ${esc(state.resultado.id || '—')}</div>
          ${state.resultado.permalink ? `<a href="${state.resultado.permalink}" target="_blank" rel="noopener" class="btn btn-primary" style="width:100%;margin-bottom:10px;">🔗 Ver anúncio no Mercado Livre</a>` : ''}
          <button class="btn btn-secondary" style="width:100%;" onclick="window._anMlReset()">➕ Criar outro anúncio</button>
        </div>`;
        return;
      }

      root.innerHTML = `
        <div class="card" style="padding:20px 22px;margin-bottom:16px;">
          <div class="form-group" style="margin:0;">
            <label class="form-label">Conta Mercado Livre</label>
            <select class="form-select" id="an-conta" ${state.carregandoContas ? 'disabled' : ''} onchange="window._anMlSelConta(this.value)">
              ${state.carregandoContas ? '<option>Carregando contas...</option>' :
                `<option value="">— Selecione —</option>` + state.contas.map(c => {
                  const id = c.param_to_use?.meliUserId || c.external_id;
                  return `<option value="${id}" ${state.contaId === id ? 'selected' : ''}>${esc(nomeConta(c))}</option>`;
                }).join('')}
            </select>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:16px;margin-bottom:16px;" class="an-grid-resp">
          <div class="card" style="padding:20px;">
            <div class="form-label" style="margin-bottom:10px;">📸 Foto do produto</div>
            <div id="an-dropzone" ondragover="event.preventDefault();this.style.borderColor='#6366f1';" ondragleave="this.style.borderColor='var(--border)';"
                 ondrop="event.preventDefault();this.style.borderColor='var(--border)';window._anMlDropRef(event);"
                 onclick="document.getElementById('an-ref-input').click()"
                 style="border:2px dashed var(--border);border-radius:14px;min-height:160px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;text-align:center;padding:16px;background:var(--bg-soft,#f7f8fc);">
              ${state.fotoRefPreview
                ? `<img src="${state.fotoRefPreview}" style="max-width:100%;max-height:130px;border-radius:8px;object-fit:contain;">`
                : `<div style="font-size:32px;">📤</div><div style="font-size:12.5px;font-weight:600;margin-top:6px;">Envie a foto de referência</div>`}
              <input type="file" id="an-ref-input" accept="image/*" style="display:none;" onchange="window._anMlUploadRef(this)">
            </div>

            <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:10px;" ${(!state.fotoRefBase64 || state.iaCarregando) ? 'disabled' : ''} onclick="window._anMlSugerirIA()">
              ${state.iaCarregando ? '⏳ Analisando...' : '✨ Autopreencher com IA (título, descrição, categoria)'}
            </button>
            <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:8px;" ${(!state.fotoRefBase64 || state.gerandoFoto) ? 'disabled' : ''} onclick="window._anMlGerarFotoIA()">
              ${state.gerandoFoto ? '⏳ Gerando foto...' : '🎨 Gerar foto profissional com IA'}
            </button>

            <div class="form-label" style="margin-top:16px;margin-bottom:6px;">Mais fotos (opcional)</div>
            <input type="file" accept="image/*" multiple onchange="window._anMlUploadExtra(this)">

            ${state.fotos.length ? `
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px;">
                ${state.fotos.map((f, i) => `
                  <div style="position:relative;">
                    <img src="${f.url}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--border);">
                    ${i === 0 ? '<span style="position:absolute;top:3px;left:3px;background:#6366f1;color:#fff;font-size:9px;padding:1px 5px;border-radius:99px;">capa</span>' : ''}
                    <button type="button" onclick="window._anMlRemoverFoto(${f.id})" style="position:absolute;top:3px;right:3px;background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:50%;width:18px;height:18px;font-size:11px;cursor:pointer;">✕</button>
                  </div>`).join('')}
              </div>` : `<div style="font-size:11px;color:var(--text-muted);margin-top:10px;">Nenhuma foto adicionada ainda.</div>`}
          </div>

          <div class="card" style="padding:20px;">
            <div class="form-label" style="margin-bottom:10px;">🗂️ Categoria</div>
            <div style="display:flex;gap:8px;margin-bottom:10px;">
              <input type="text" class="form-input" id="an-cat-busca" placeholder="Ex: armário de cozinha" value="${esc(state.categoriaBuscaInput)}" style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();window._anMlBuscarCategoria();}">
              <button class="btn btn-secondary" ${state.buscandoCategoria ? 'disabled' : ''} onclick="window._anMlBuscarCategoria()">${state.buscandoCategoria ? '⏳' : '🔍'}</button>
            </div>

            ${state.categoriaResultados.length ? `
              <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;max-height:180px;overflow-y:auto;">
                ${state.categoriaResultados.map((c, i) => `
                  <button type="button" class="btn btn-secondary btn-sm" style="text-align:left;justify-content:flex-start;" onclick="window._anMlEscolherCategoria(${i})">
                    ${esc(c.category_name)} <span style="color:var(--text-muted);font-size:11px;">— ${esc(c.domain_name || '')}</span>
                  </button>`).join('')}
              </div>` : ''}

            ${state.categoriaEscolhida ? `
              <div style="background:var(--accent-soft,rgba(99,102,241,0.08));border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:14px;">
                ✅ <b>${esc(state.categoriaEscolhida.category_name)}</b> <span style="color:var(--text-muted);">(${esc(state.categoriaEscolhida.category_id)})</span>
              </div>` : `<div style="font-size:11px;color:var(--text-muted);margin-bottom:14px;">Busque e escolha a categoria antes de preencher a ficha técnica.</div>`}

            <div class="form-group" style="margin-bottom:12px;">
              <label class="form-label" style="display:flex;justify-content:space-between;">Título do anúncio <span style="font-weight:400;color:var(--text-muted);">até 60 caracteres</span></label>
              <input type="text" class="form-input" id="an-titulo" maxlength="60" value="${esc(state.titulo)}" placeholder="Ex: Armário de Cozinha 4 Portas Branco MDF">
            </div>
            <div class="form-group" style="margin-bottom:12px;">
              <label class="form-label">Descrição</label>
              <textarea class="form-textarea" id="an-descricao" rows="4" placeholder="Descreva o produto: material, medidas, diferenciais...">${state.descricao}</textarea>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px;">
              <div class="form-group" style="margin:0;"><label class="form-label">Preço (R$)</label><input type="number" step="0.01" class="form-input" id="an-preco" value="${esc(state.preco)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Estoque</label><input type="number" class="form-input" id="an-estoque" value="${esc(state.estoque)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Condição</label>
                <select class="form-select" id="an-condicao">
                  <option value="new" ${state.condicao === 'new' ? 'selected' : ''}>Novo</option>
                  <option value="used" ${state.condicao === 'used' ? 'selected' : ''}>Usado</option>
                </select>
              </div>
              <div class="form-group" style="margin:0;"><label class="form-label">Tipo de anúncio</label>
                <select class="form-select" id="an-tipo">
                  ${LISTING_TYPES.map(t => `<option value="${t.id}" ${state.tipoAnuncio === t.id ? 'selected' : ''}>${t.nome}</option>`).join('')}
                </select>
              </div>
              <div class="form-group" style="margin:0;"><label class="form-label">Garantia</label><input type="text" class="form-input" id="an-garantia" value="${esc(state.garantia)}" placeholder="Ex: 3 meses"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">SKU</label><input type="text" class="form-input" id="an-sku" value="${esc(state.sku)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">GTIN / EAN</label><input type="text" class="form-input" id="an-gtin" value="${esc(state.gtin)}" placeholder="Deixe em branco se não tiver"></div>
            </div>

            ${state.carregandoAtributos ? `<div style="font-size:12px;color:var(--text-muted);">⏳ Carregando ficha técnica da categoria...</div>` : ''}
            ${!state.carregandoAtributos && state.categoriaEscolhida ? `
              ${renderBlocoAtributos(state.atributosObrigatorios, '📋 Ficha técnica — obrigatórios pro SEO/catálogo', false)}
              ${renderBlocoAtributos(state.atributosOpcionais, 'Ver mais atributos (opcionais, melhoram a busca)', true)}
            ` : ''}

            ${state.erro ? `<div style="font-size:12.5px;color:var(--red);margin-top:14px;">⚠️ ${esc(state.erro)}</div>` : ''}

            <button class="btn btn-primary" style="width:100%;padding:14px;font-size:14px;border-radius:12px;margin-top:18px;" ${state.criando ? 'disabled' : ''} onclick="window._anMlCriar()">
              ${state.criando ? '⏳ Criando anúncio...' : '🚀 Criar anúncio no Mercado Livre'}
            </button>
          </div>
        </div>
      `;
    }

    el.innerHTML = `<div class="page">
      <div class="section-title mb-16">🟡 Anúncios — Mercado Livre</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;max-width:680px;">
        Suba a foto, deixe a IA sugerir título/descrição/categoria, confira a ficha técnica e publique — tudo numa tela só.
      </div>
      <div id="an-ml-root"></div>
      <style>@media (max-width:900px){.an-grid-resp{grid-template-columns:1fr !important;}}</style>
    </div>`;

    window._anMlSelConta = (v) => { syncFormState(); state.contaId = v; render(); };
    window._anMlUploadRef = (input) => processarFotoRef(input.files?.[0]);
    window._anMlDropRef = (ev) => processarFotoRef(ev.dataTransfer?.files?.[0]);
    window._anMlUploadExtra = (input) => processarFotosExtra(input.files || []);
    window._anMlRemoverFoto = removerFoto;
    window._anMlSugerirIA = sugerirComIA;
    window._anMlGerarFotoIA = gerarFotoIA;
    window._anMlBuscarCategoria = () => buscarCategoria();
    window._anMlEscolherCategoria = (i) => escolherCategoria(state.categoriaResultados[i]);
    window._anMlToggleOpcionais = () => { syncFormState(); state.mostrarOpcionais = !state.mostrarOpcionais; render(); };
    window._anMlCriar = criarAnuncio;
    window._anMlReset = resetar;

    render();
    carregarContas();
  }

  Router.register('anuncios-ml', renderML);
  Router.register('anuncios-shopee', (p, el) => renderEmConstrucao('shopee', el));
  Router.register('anuncios-tiktok', (p, el) => renderEmConstrucao('tiktok', el));
  Router.register('anuncios-amazon', (p, el) => renderEmConstrucao('amazon', el));

})();
