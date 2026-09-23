// ============================================================
// GLR Consultoria — Central de Anúncios (criação de anúncio novo, completo,
// direto no marketplace). Mercado Livre está funcional; Shopee/TikTok/Amazon
// ficam com uma tela de "em construção" até serem construídas na mesma
// profundidade (categoria + ficha técnica reais, IA de foto integrada).
// ============================================================
(function () {

  function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

  // ── Quando a busca/sugestão literal de categoria do marketplace não acha
  // nada (nome curto ou comercial, tipo "Buffet Alaska"), pede pra IA pensar
  // em 3 termos descritivos alternativos (tipo de produto, material) em vez
  // de simplesmente desistir. Compartilhado pelos 3 marketplaces. ──
  async function sugerirTermosAlternativos(nomeProduto, descricao) {
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: 'Você ajuda a achar a categoria certa de um produto em marketplaces (Mercado Livre, Shopee, TikTok Shop). Dado o nome e a descrição de um produto, devolva APENAS um JSON válido, sem markdown e sem texto fora do JSON, neste formato exato: {"termos": ["termo 1", "termo 2", "termo 3"]}. Cada termo é uma frase curta de 2 a 4 palavras descrevendo o TIPO do produto (categoria geral, material, função) — nunca o nome comercial, marca ou nome de fantasia. Exemplo: pro produto "Buffet Alaska", um bom termo é "buffet aparador madeira" ou "móveis sala de estar", nunca "Buffet Alaska". Ordene do termo mais específico pro mais genérico.',
          messages: [{ role: 'user', content: `Nome do produto: ${nomeProduto}${descricao ? `\nDescrição: ${descricao}` : ''}` }],
        }),
      });
      const json = await resp.json();
      if (json.error) return [];
      const texto = json.content || '';
      const match = texto.match(/\{[\s\S]*\}/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed.termos) ? parsed.termos.filter(Boolean).slice(0, 3) : [];
    } catch (e) { return []; }
  }

  // ── Placeholder para os marketplaces ainda não construídos ──────────────
  const _PLACEHOLDER = {
    amazon:  { nome: 'Amazon', cor: '#ff9900' },
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

      categoriaBuscaInput: '', categoriaResultados: [], categoriaEscolhida: null, buscandoCategoria: false, categoriaAvisoIA: '',
      categoriaNavegando: false, categoriaNavPath: [], categoriaNavItens: [], categoriaNavCarregando: false,
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
      state.categoriaAvisoIA = '';
      render();
      try {
        const resp = await MarketplaceAPI.call('search_categories', { q, meliUserId: state.contaId });
        state.categoriaResultados = resp.data?.items || resp.items || [];

        // Nada encontrado com o termo literal — em vez de simplesmente desistir,
        // pede pra IA pensar em termos mais descritivos (tipo de produto) e
        // tenta cada um, um de cada vez, até achar alguma coisa.
        if (!state.categoriaResultados.length) {
          state.categoriaAvisoIA = '🧠 IA pensando em termos alternativos...';
          render();
          const termos = await sugerirTermosAlternativos(state.titulo || q, state.descricao);
          for (const termo of termos) {
            const r2 = await MarketplaceAPI.call('search_categories', { q: termo, meliUserId: state.contaId }).catch(() => null);
            const itens = r2?.data?.items || r2?.items || [];
            if (itens.length) {
              state.categoriaResultados = itens;
              state.categoriaAvisoIA = `Nada encontrado pra "${q}" — a IA tentou "${termo}" e achou isso:`;
              break;
            }
          }
          if (!state.categoriaResultados.length) {
            state.categoriaAvisoIA = '';
            alert('Nenhuma categoria encontrada pra "' + q + '", nem com os termos alternativos que a IA tentou. Busque manualmente com outra palavra.');
          }
        }
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
      state.categoriaAvisoIA = '';
      state.categoriaNavegando = false;
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

    // ── Navegador de categorias — busca sob demanda por nível (o ML não
    // tem endpoint de árvore inteira; cada clique busca só os filhos daquele
    // nó, via ml_category_detail). Mais direto que digitar termo de busca. ──
    async function abrirNavegadorCategorias() {
      syncFormState();
      if (!state.contaId) { alert('Selecione a conta do Mercado Livre primeiro.'); return; }
      state.categoriaNavegando = true;
      state.categoriaNavPath = [];
      state.categoriaNavCarregando = true;
      render();
      try {
        const resp = await MarketplaceAPI.call('ml_site_categories', { meliUserId: state.contaId });
        state.categoriaNavItens = (resp.data?.items || resp.items || []).map(c => ({ id: c.id, nome: c.name }));
      } catch (e) {
        alert('Erro ao carregar categorias: ' + (e.message || e));
      } finally {
        state.categoriaNavCarregando = false;
        render();
      }
    }

    async function navegarCategoriaPara(cat) {
      state.categoriaNavCarregando = true;
      render();
      try {
        const resp = await MarketplaceAPI.call('ml_category_detail', { category_id: cat.id, meliUserId: state.contaId });
        const d = resp.data || resp;
        const filhos = d.children_categories || [];
        if (!filhos.length) {
          // Categoria-folha — usa direto.
          state.categoriaNavegando = false;
          state.categoriaNavCarregando = false;
          await escolherCategoria({ category_id: cat.id, category_name: cat.nome });
          return;
        }
        state.categoriaNavPath.push(cat);
        state.categoriaNavItens = filhos.map(c => ({ id: c.id, nome: c.name }));
      } catch (e) {
        alert('Erro ao carregar subcategorias: ' + (e.message || e));
      } finally {
        state.categoriaNavCarregando = false;
        render();
      }
    }

    async function navegarCategoriaVoltar(indice) {
      if (indice < 0) { await abrirNavegadorCategorias(); return; }
      state.categoriaNavPath = state.categoriaNavPath.slice(0, indice + 1);
      const pai = state.categoriaNavPath[indice];
      state.categoriaNavCarregando = true;
      render();
      try {
        const resp = await MarketplaceAPI.call('ml_category_detail', { category_id: pai.id, meliUserId: state.contaId });
        const d = resp.data || resp;
        state.categoriaNavItens = (d.children_categories || []).map(c => ({ id: c.id, nome: c.name }));
      } catch (e) {
        alert('Erro ao carregar subcategorias: ' + (e.message || e));
      } finally {
        state.categoriaNavCarregando = false;
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
            <div class="form-label" style="margin-bottom:6px;">🗂️ Categoria</div>

            ${state.categoriaEscolhida ? `
              <div style="background:var(--accent-soft,rgba(99,102,241,0.08));border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:12px;">
                ✅ <b>${esc(state.categoriaEscolhida.category_name)}</b> <span style="color:var(--text-muted);">(${esc(state.categoriaEscolhida.category_id)})</span>
                <button type="button" class="btn btn-secondary btn-sm" style="margin-left:8px;" onclick="window._anMlNavegarCategorias()">Trocar</button>
              </div>
            ` : `
              <button class="btn btn-primary btn-sm" style="margin-bottom:8px;width:100%;" ${state.categoriaNavCarregando ? 'disabled' : ''} onclick="window._anMlNavegarCategorias()">
                📂 Escolher categoria na lista
              </button>

              ${state.categoriaNavegando ? `
                <div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
                  <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                    <span style="cursor:pointer;text-decoration:underline;" onclick="window._anMlNavCategoriaVoltar(-1)">Categorias</span>
                    ${state.categoriaNavPath.map((p, i) => `<span>›</span><span style="cursor:pointer;text-decoration:underline;" onclick="window._anMlNavCategoriaVoltar(${i})">${esc(p.nome)}</span>`).join('')}
                  </div>
                  ${state.categoriaNavCarregando ? `<div style="font-size:12px;color:var(--text-muted);padding:8px;">⏳ Carregando...</div>` : `
                    <div style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;">
                      ${state.categoriaNavItens.map((c, i) => `
                        <button type="button" class="btn btn-secondary btn-sm" style="text-align:left;justify-content:space-between;" onclick="window._anMlNavCategoriaAbrir(${i})">
                          <span>${esc(c.nome)}</span>
                          <span style="color:var(--text-muted);">›</span>
                        </button>`).join('') || '<div style="font-size:12px;color:var(--text-muted);padding:8px;">Sem categorias nesse nível.</div>'}
                    </div>
                  `}
                </div>
              ` : ''}

              <details style="margin-bottom:12px;">
                <summary style="cursor:pointer;font-size:11.5px;color:var(--text-muted);">Prefere buscar por nome? (opcional)</summary>
                <div style="margin-top:8px;">
                  <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">Busque pelo tipo de produto (ex: "armário de cozinha"), não pelo nome comercial — nomes curtos ou de marca (ex: "Buffet Alaska") costumam não achar nada.</div>
                  <div style="display:flex;gap:8px;margin-bottom:8px;">
                    <input type="text" class="form-input" id="an-cat-busca" placeholder="Ex: armário de cozinha" value="${esc(state.categoriaBuscaInput)}" style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();window._anMlBuscarCategoria();}">
                    <button class="btn btn-secondary" ${state.buscandoCategoria ? 'disabled' : ''} onclick="window._anMlBuscarCategoria()">${state.buscandoCategoria ? '⏳' : '🔍'}</button>
                  </div>
                  ${state.categoriaAvisoIA ? `<div style="font-size:11px;color:#6366f1;margin-bottom:8px;">${esc(state.categoriaAvisoIA)}</div>` : ''}
                  ${state.categoriaResultados.length ? `
                    <div style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;">
                      ${state.categoriaResultados.map((c, i) => `
                        <button type="button" class="btn btn-secondary btn-sm" style="text-align:left;justify-content:flex-start;" onclick="window._anMlEscolherCategoria(${i})">
                          ${esc(c.category_name)} <span style="color:var(--text-muted);font-size:11px;">— ${esc(c.domain_name || '')}</span>
                        </button>`).join('')}
                    </div>` : ''}
                </div>
              </details>

              <div style="font-size:11px;color:var(--text-muted);margin-bottom:14px;">Escolha a categoria antes de preencher a ficha técnica.</div>
            `}

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
    window._anMlNavegarCategorias = abrirNavegadorCategorias;
    window._anMlNavCategoriaAbrir = (i) => navegarCategoriaPara(state.categoriaNavItens[i]);
    window._anMlNavCategoriaVoltar = navegarCategoriaVoltar;
    window._anMlToggleOpcionais = () => { syncFormState(); state.mostrarOpcionais = !state.mostrarOpcionais; render(); };
    window._anMlCriar = criarAnuncio;
    window._anMlReset = resetar;

    render();
    carregarContas();
  }

  // ============================================================
  // SHOPEE
  // ============================================================

  function renderShopee(params, el) {
    const state = {
      contas: [], contaId: '', carregandoContas: true,

      fotos: [], fotoRefBase64: '', fotoRefPreview: '',
      iaCarregando: false, gerandoFoto: false,

      arvoreCategorias: null,
      nomeProduto: '', categoriaSugestoes: [], categoriaEscolhida: null, buscandoCategoria: false, categoriaAvisoIA: '',
      categoriaNavegando: false, categoriaNavPath: [], categoriaNavItens: [],
      atributosObrigatorios: [], atributosOpcionais: [], mostrarOpcionais: false, carregandoAtributos: false,
      valoresAtributos: {},

      marcaOpcoes: [], marcaObrigatoria: false, carregandoMarca: false,

      descricao: '', preco: '', estoque: '', condicao: 'NEW', marca: '0', sku: '',
      peso: '', compr: '', larg: '', alt: '',

      criando: false, resultado: null, erro: '',
    };

    function syncFormState() {
      const v = id => document.getElementById(id)?.value;
      if (document.getElementById('an-sp-nome')) {
        state.nomeProduto = v('an-sp-nome') || ''; state.descricao = v('an-sp-descricao') || '';
        state.preco = v('an-sp-preco') || ''; state.estoque = v('an-sp-estoque') || '';
        state.condicao = v('an-sp-condicao') || 'NEW'; state.sku = v('an-sp-sku') || '';
        state.peso = v('an-sp-peso') || ''; state.compr = v('an-sp-compr') || '';
        state.larg = v('an-sp-larg') || ''; state.alt = v('an-sp-alt') || '';
        if (document.getElementById('an-sp-marca')) state.marca = v('an-sp-marca');
        if (document.getElementById('an-sp-marca-custom')) state.marcaCustom = v('an-sp-marca-custom') || '';
      }
      [...state.atributosObrigatorios, ...state.atributosOpcionais].forEach(a => {
        const tipo = campoTipoAtributo(a);
        if (tipo === 'numero_unidade') {
          const n = v(`attr-${a.attribute_id}-num`); const u = v(`attr-${a.attribute_id}-unit`);
          if (n) state.valoresAtributos[a.attribute_id] = { num: n, unit: u };
        } else if (tipo === 'multi') {
          const el2 = document.getElementById(`attr-${a.attribute_id}`);
          const sel = el2 ? Array.from(el2.selectedOptions).map(o => o.value) : [];
          if (sel.length) state.valoresAtributos[a.attribute_id] = sel;
        } else {
          const val = v(`attr-${a.attribute_id}`);
          if (val) state.valoresAtributos[a.attribute_id] = val;
        }
      });
    }

    function render() { renderPainel(); }

    async function carregarContas() {
      try {
        const todas = await MarketplaceAPI.listAccounts();
        state.contas = todas.filter(c => (c.marketplace || '').toLowerCase() === 'shopee');
        if (state.contas.length === 1) state.contaId = state.contas[0].param_to_use?.shopId || state.contas[0].external_id;
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

    // ── Categorias (árvore cacheada localmente pra resolver nome dos IDs
    // sugeridos sem ter que baixar tudo de novo a cada anúncio) ─────────
    async function obterArvoreCategorias() {
      if (state.arvoreCategorias) return state.arvoreCategorias;
      try {
        const cache = JSON.parse(localStorage.getItem('glr_shopee_categorias_cache') || 'null');
        if (cache && Date.now() - cache.ts < 7 * 24 * 3600 * 1000) { state.arvoreCategorias = cache.lista; return cache.lista; }
      } catch (e) {}
      const resp = await MarketplaceAPI.call('shopee_get_categories', { shopId: state.contaId });
      const lista = resp.data?.response?.category_list || resp.response?.category_list || [];
      try { localStorage.setItem('glr_shopee_categorias_cache', JSON.stringify({ ts: Date.now(), lista })); } catch (e) {}
      state.arvoreCategorias = lista;
      return lista;
    }

    function nomeCategoria(id) {
      const c = (state.arvoreCategorias || []).find(c => c.category_id === id);
      return c?.display_category_name || c?.original_category_name || ('Categoria ' + id);
    }

    // ── Navegador de categorias (clica e desce de nível, tipo pasta) — mais
    // direto que ficar tentando adivinhar o termo de busca certo. Usa a mesma
    // árvore já cacheada. ──
    async function abrirNavegadorCategorias() {
      syncFormState();
      if (!state.contaId) { alert('Selecione a loja Shopee primeiro.'); return; }
      state.categoriaNavegando = true;
      state.categoriaNavPath = [];
      state.categoriaAvisoIA = '';
      state.categoriaSugestoes = [];
      render();
      await obterArvoreCategorias();
      state.categoriaNavItens = (state.arvoreCategorias || []).filter(c => c.parent_category_id === 0);
      render();
    }

    function navegarCategoriaPara(cat) {
      const filhos = (state.arvoreCategorias || []).filter(c => c.parent_category_id === cat.category_id);
      if (!filhos.length) {
        // Categoria-folha — usa direto, sem precisar de mais um clique.
        escolherCategoria({ category_id: cat.category_id, nome: cat.display_category_name || cat.original_category_name });
        return;
      }
      state.categoriaNavPath.push({ id: cat.category_id, nome: cat.display_category_name || cat.original_category_name });
      state.categoriaNavItens = filhos;
      render();
    }

    function navegarCategoriaVoltar(indice) {
      if (indice < 0) { state.categoriaNavPath = []; state.categoriaNavItens = (state.arvoreCategorias || []).filter(c => c.parent_category_id === 0); render(); return; }
      state.categoriaNavPath = state.categoriaNavPath.slice(0, indice + 1);
      const paiId = state.categoriaNavPath[indice].id;
      state.categoriaNavItens = (state.arvoreCategorias || []).filter(c => c.parent_category_id === paiId);
      render();
    }

    // ── Foto de referência + IA (mesmo endpoint usado no ML) ─────────
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
        if (json.titulo) state.nomeProduto = json.titulo;
        if (json.descricao) state.descricao = json.descricao;
        state.iaCarregando = false;
        // categoria_busca é um termo já pensado pela IA especificamente pra
        // achar categoria (ex: "buffet aparador madeira") — bem melhor que o
        // título comercial (ex: "Buffet Alaska") pra bater com a busca da Shopee.
        if (json.categoria_busca || state.nomeProduto) { await sugerirCategorias(json.categoria_busca); return; } // já chama render()
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
          body: JSON.stringify({ image_base64: state.fotoRefBase64, product_name: state.nomeProduto, details: state.descricao, stage: 'ambientada' }),
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

    // ── Categoria sugerida pela própria Shopee a partir do nome do produto.
    // termoOverride (opcional) é o categoria_busca vindo da IA de foto — mais
    // descritivo que o nome comercial digitado no campo. ──
    async function sugerirCategorias(termoOverride) {
      syncFormState();
      const termoBase = termoOverride || state.nomeProduto;
      if (!termoBase || !termoBase.trim()) { alert('Preencha o nome do produto primeiro.'); return; }
      if (!state.contaId) { alert('Selecione a loja Shopee primeiro.'); return; }
      state.buscandoCategoria = true;
      state.categoriaSugestoes = [];
      state.categoriaAvisoIA = '';
      render();
      try {
        await obterArvoreCategorias();
        const buscar = async (termo) => {
          const resp = await MarketplaceAPI.call('shopee_recommend_category', { item_name: termo, shopId: state.contaId });
          const ids = resp.data?.response?.category_id || resp.response?.category_id || [];
          return ids.map(id => ({ category_id: id, nome: nomeCategoria(id) }));
        };
        state.categoriaSugestoes = await buscar(termoBase);

        // Nada encontrado — pede pra IA pensar em termos mais descritivos (tipo
        // de produto, material) em vez de simplesmente desistir, e tenta cada
        // um até achar categoria.
        if (!state.categoriaSugestoes.length) {
          state.categoriaAvisoIA = '🧠 IA pensando em termos alternativos...';
          render();
          const termos = await sugerirTermosAlternativos(state.nomeProduto, state.descricao);
          for (const termo of termos) {
            const achadas = await buscar(termo).catch(() => []);
            if (achadas.length) {
              state.categoriaSugestoes = achadas;
              state.categoriaAvisoIA = `Nada encontrado pra "${termoBase}" — a IA tentou "${termo}" e achou isso:`;
              break;
            }
          }
          if (!state.categoriaSugestoes.length) {
            state.categoriaAvisoIA = '';
            alert('A Shopee não sugeriu categoria pra esse nome, nem com os termos alternativos que a IA tentou. Busque manualmente com outra palavra.');
          }
        }
      } catch (e) {
        alert('Erro ao sugerir categoria: ' + (e.message || e));
      } finally {
        state.buscandoCategoria = false;
        render();
      }
    }

    // ── Busca manual na árvore de categorias (cacheada) — usada quando o
    // nome do produto é curto/comercial demais e a IA da Shopee não acha
    // nada (ex: "Buffet Alaska" não bate com nada, mas "buffet aparador"
    // acha — confirmado ao vivo). Filtra só categoria-folha (sem filhos).
    async function buscarCategoriaManual() {
      syncFormState();
      const termo = document.getElementById('an-sp-cat-manual')?.value.trim().toLowerCase();
      if (!termo) { alert('Digite uma palavra-chave do produto (ex: "armário", "buffet", "cadeira").'); return; }
      if (!state.contaId) { alert('Selecione a loja Shopee primeiro.'); return; }
      state.buscandoCategoria = true;
      state.categoriaSugestoes = [];
      state.categoriaAvisoIA = '';
      render();
      try {
        const arvore = await obterArvoreCategorias();
        const achadas = arvore.filter(c => !c.has_children && ((c.display_category_name || '').toLowerCase().includes(termo) || (c.original_category_name || '').toLowerCase().includes(termo)));
        state.categoriaSugestoes = achadas.slice(0, 20).map(c => ({ category_id: c.category_id, nome: c.display_category_name || c.original_category_name }));
        if (!state.categoriaSugestoes.length) alert('Nenhuma categoria encontrada com esse termo. Tente uma palavra mais genérica (ex: "móveis" em vez de "buffet retrô").');
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
      state.categoriaSugestoes = [];
      state.categoriaAvisoIA = '';
      state.categoriaNavegando = false;
      state.valoresAtributos = {};
      state.mostrarOpcionais = false;
      state.carregandoAtributos = true;
      state.carregandoMarca = true;
      render();
      try {
        const [respAttr, respBrand] = await Promise.allSettled([
          MarketplaceAPI.call('shopee_get_attributes', { shopId: state.contaId, params: { category_id: cat.category_id } }),
          MarketplaceAPI.call('shopee_get_brand_list', { shopId: state.contaId, category_id: cat.category_id, offset: 0, page_size: 100, status: 1 }),
        ]);
        if (respAttr.status === 'fulfilled') {
          const arvore = respAttr.value.data?.response?.list?.[0]?.attribute_tree || respAttr.value.response?.list?.[0]?.attribute_tree || [];
          state.atributosObrigatorios = arvore.filter(a => a.mandatory);
          state.atributosOpcionais = arvore.filter(a => !a.mandatory);
        }
        if (respBrand.status === 'fulfilled') {
          const r = respBrand.value.data?.response || respBrand.value.response || {};
          state.marcaOpcoes = r.brand_list || [];
          state.marcaObrigatoria = !!r.is_mandatory;
        }
      } catch (e) {
        alert('Erro ao buscar ficha técnica / marcas: ' + (e.message || e));
      } finally {
        state.carregandoAtributos = false;
        state.carregandoMarca = false;
        render();
      }
    }

    // ── Renderização de campo de atributo dinâmico ───────────
    function labelAtributo(a) { return a.multi_lang?.find(m => m.language === 'pt-BR')?.value || a.name; }
    function valoresAtributo(a) { return (a.attribute_value_list || []).map(v => ({ id: v.value_id, nome: v.multi_lang?.find(m => m.language === 'pt-BR')?.value || v.name })); }
    function campoTipoAtributo(a) {
      if (a.attribute_value_list && a.attribute_value_list.length) return a.attribute_info?.input_type === 5 ? 'multi' : 'select';
      return a.attribute_info?.attribute_unit_list?.length ? 'numero_unidade' : 'texto';
    }

    function renderCampoAtributo(a) {
      const tipo = campoTipoAtributo(a);
      const valorSalvo = state.valoresAtributos[a.attribute_id];
      if (tipo === 'select') {
        return `<select class="form-select" id="attr-${a.attribute_id}">
          <option value="">— não informado —</option>
          ${valoresAtributo(a).map(v => `<option value="${v.id}" ${String(valorSalvo) === String(v.id) ? 'selected' : ''}>${esc(v.nome)}</option>`).join('')}
        </select>`;
      }
      if (tipo === 'multi') {
        const sel = Array.isArray(valorSalvo) ? valorSalvo.map(String) : [];
        return `<select class="form-select" id="attr-${a.attribute_id}" multiple size="4">
          ${valoresAtributo(a).map(v => `<option value="${v.id}" ${sel.includes(String(v.id)) ? 'selected' : ''}>${esc(v.nome)}</option>`).join('')}
        </select>
        <div style="font-size:10px;color:var(--text-muted);">Segura Ctrl/Cmd pra marcar mais de um (até ${a.attribute_info?.max_value_count || 5}).</div>`;
      }
      if (tipo === 'numero_unidade') {
        const units = a.attribute_info?.attribute_unit_list || [];
        const savedNum = valorSalvo?.num || ''; const savedUnit = valorSalvo?.unit || units[0];
        return `<div style="display:flex;gap:6px;">
          <input type="number" step="0.01" class="form-input" id="attr-${a.attribute_id}-num" value="${esc(savedNum)}" style="flex:1;">
          <select class="form-select" id="attr-${a.attribute_id}-unit" style="width:80px;">
            ${units.map(u => `<option value="${esc(u)}" ${savedUnit === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}
          </select>
        </div>`;
      }
      return `<input type="text" class="form-input" id="attr-${a.attribute_id}" value="${esc(valorSalvo || '')}">`;
    }

    function renderBlocoAtributos(lista, titulo, colapsavel) {
      if (!lista.length) return '';
      const conteudo = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
        ${lista.map(a => `<div class="form-group" style="margin:0;">
          <label class="form-label">${esc(labelAtributo(a))}${a.mandatory ? ' *' : ''}</label>
          ${renderCampoAtributo(a)}
        </div>`).join('')}
      </div>`;
      if (!colapsavel) return `<div style="margin-top:14px;"><div class="form-label" style="margin-bottom:8px;">${titulo}</div>${conteudo}</div>`;
      return `<div style="margin-top:14px;">
        <button type="button" class="btn btn-secondary btn-sm" onclick="window._anSpToggleOpcionais()">
          ${state.mostrarOpcionais ? '▲' : '▼'} ${titulo} (${lista.length})
        </button>
        ${state.mostrarOpcionais ? `<div style="margin-top:10px;">${conteudo}</div>` : ''}
      </div>`;
    }

    // ── Montagem do payload e criação ────────────────────────
    function montarAtributosPayload() {
      const out = [];
      [...state.atributosObrigatorios, ...state.atributosOpcionais].forEach(a => {
        const tipo = campoTipoAtributo(a);
        if (tipo === 'select') {
          const val = document.getElementById(`attr-${a.attribute_id}`)?.value;
          if (val) out.push({ attribute_id: a.attribute_id, attribute_value_list: [{ value_id: parseInt(val, 10) }] });
        } else if (tipo === 'multi') {
          const el2 = document.getElementById(`attr-${a.attribute_id}`);
          const sel = el2 ? Array.from(el2.selectedOptions).map(o => parseInt(o.value, 10)) : [];
          if (sel.length) out.push({ attribute_id: a.attribute_id, attribute_value_list: sel.map(id => ({ value_id: id })) });
        } else if (tipo === 'numero_unidade') {
          const num = document.getElementById(`attr-${a.attribute_id}-num`)?.value;
          const unit = document.getElementById(`attr-${a.attribute_id}-unit`)?.value;
          if (num) out.push({ attribute_id: a.attribute_id, attribute_value_list: [{ value_unit: unit, original_value_name: num }] });
        } else {
          const val = document.getElementById(`attr-${a.attribute_id}`)?.value?.trim();
          if (val) out.push({ attribute_id: a.attribute_id, attribute_value_list: [{ original_value_name: val }] });
        }
      });
      return out;
    }

    async function criarAnuncio() {
      if (!state.contaId) return alert('Selecione a loja Shopee.');
      if (!state.categoriaEscolhida) return alert('Escolha uma categoria antes de criar o anúncio.');
      if (!state.fotos.length) return alert('Adicione pelo menos uma foto ao anúncio.');

      const nome = document.getElementById('an-sp-nome')?.value.trim();
      const descricao = document.getElementById('an-sp-descricao')?.value.trim();
      const preco = parseFloat(document.getElementById('an-sp-preco')?.value);
      const estoque = parseInt(document.getElementById('an-sp-estoque')?.value, 10);
      const condicao = document.getElementById('an-sp-condicao')?.value;
      const sku = document.getElementById('an-sp-sku')?.value.trim();
      const peso = document.getElementById('an-sp-peso')?.value;
      const compr = document.getElementById('an-sp-compr')?.value;
      const larg = document.getElementById('an-sp-larg')?.value;
      const alt = document.getElementById('an-sp-alt')?.value;
      const marcaSel = document.getElementById('an-sp-marca')?.value;
      const marcaCustom = document.getElementById('an-sp-marca-custom')?.value.trim();

      if (!nome) return alert('Preencha o nome do produto.');
      if (!descricao) return alert('Preencha a descrição.');
      if (!(preco > 0)) return alert('Informe um preço válido.');
      if (!(estoque >= 0)) return alert('Informe o estoque.');

      const faltando = state.atributosObrigatorios.filter(a => {
        const tipo = campoTipoAtributo(a);
        if (tipo === 'numero_unidade') return !document.getElementById(`attr-${a.attribute_id}-num`)?.value;
        if (tipo === 'multi') return !document.getElementById(`attr-${a.attribute_id}`)?.selectedOptions?.length;
        return !document.getElementById(`attr-${a.attribute_id}`)?.value;
      });
      if (faltando.length && !confirm(`Faltam ${faltando.length} atributo(s) obrigatório(s) (${faltando.map(labelAtributo).join(', ')}). A Shopee pode recusar o anúncio. Continuar mesmo assim?`)) return;

      const body = {
        shopId: state.contaId,
        item_name: nome,
        description: descricao,
        category_id: parseInt(state.categoriaEscolhida.category_id, 10),
        original_price: preco,
        stock: estoque,
        condition: condicao,
        images_base64: state.fotos.map(f => f.url),
      };
      if (sku) body.item_sku = sku;
      if (peso) body.weight = parseFloat(peso);
      if (compr && larg && alt) body.dimension = { package_length: parseFloat(compr), package_width: parseFloat(larg), package_height: parseFloat(alt) };
      const marcaFinal = marcaCustom || (state.marcaOpcoes.find(m => String(m.brand_id) === marcaSel)?.original_brand_name) || '';
      if (marcaFinal) body.brand = marcaFinal;
      const atributos = montarAtributosPayload();
      // attribute_list é o nome real do campo na API da Shopee — não aparece
      // documentado no schema da ferramenta de criação, mas é enviado mesmo
      // assim; se a integração ignorar, o anúncio sai sem esses atributos em
      // vez de falhar (mesmo espírito do "continuar mesmo assim" acima).
      if (atributos.length) body.attribute_list = atributos;

      state.criando = true; state.erro = ''; state.resultado = null;
      render();
      try {
        const resp = await MarketplaceAPI.call('shopee_create_item', body);
        state.resultado = resp.data?.response || resp.response || resp.data || resp;
      } catch (e) {
        state.erro = e.message || String(e);
      } finally {
        state.criando = false;
        render();
      }
    }

    function resetar() { Router.navigate('anuncios-shopee'); }

    // ── Render principal ──────────────────────────────────────
    function renderPainel() {
      const root = document.getElementById('an-sp-root');
      if (!root) return;

      if (state.resultado) {
        root.innerHTML = `<div class="card" style="padding:40px;text-align:center;max-width:520px;margin:0 auto;">
          <div style="font-size:44px;margin-bottom:12px;">✅</div>
          <div style="font-size:18px;font-weight:800;margin-bottom:8px;">Anúncio criado na Shopee!</div>
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">Item ID: ${esc(state.resultado.item_id || '—')} — pode levar alguns minutos até aparecer na loja, a Shopee revisa antes de publicar.</div>
          <button class="btn btn-secondary" style="width:100%;" onclick="window._anSpReset()">➕ Criar outro anúncio</button>
        </div>`;
        return;
      }

      root.innerHTML = `
        <div class="card" style="padding:20px 22px;margin-bottom:16px;">
          <div class="form-group" style="margin:0;">
            <label class="form-label">Loja Shopee</label>
            <select class="form-select" id="an-sp-conta" ${state.carregandoContas ? 'disabled' : ''} onchange="window._anSpSelConta(this.value)">
              ${state.carregandoContas ? '<option>Carregando lojas...</option>' :
                `<option value="">— Selecione —</option>` + state.contas.map(c => {
                  const id = c.param_to_use?.shopId || c.external_id;
                  return `<option value="${id}" ${state.contaId === id ? 'selected' : ''}>${esc(nomeConta(c))}</option>`;
                }).join('')}
            </select>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:16px;margin-bottom:16px;" class="an-grid-resp">
          <div class="card" style="padding:20px;">
            <div class="form-label" style="margin-bottom:10px;">📸 Foto do produto</div>
            <div id="an-sp-dropzone" ondragover="event.preventDefault();this.style.borderColor='#ee4d2d';" ondragleave="this.style.borderColor='var(--border)';"
                 ondrop="event.preventDefault();this.style.borderColor='var(--border)';window._anSpDropRef(event);"
                 onclick="document.getElementById('an-sp-ref-input').click()"
                 style="border:2px dashed var(--border);border-radius:14px;min-height:160px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;text-align:center;padding:16px;background:var(--bg-soft,#f7f8fc);">
              ${state.fotoRefPreview
                ? `<img src="${state.fotoRefPreview}" style="max-width:100%;max-height:130px;border-radius:8px;object-fit:contain;">`
                : `<div style="font-size:32px;">📤</div><div style="font-size:12.5px;font-weight:600;margin-top:6px;">Envie a foto de referência</div>`}
              <input type="file" id="an-sp-ref-input" accept="image/*" style="display:none;" onchange="window._anSpUploadRef(this)">
            </div>

            <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:10px;" ${(!state.fotoRefBase64 || state.iaCarregando) ? 'disabled' : ''} onclick="window._anSpSugerirIA()">
              ${state.iaCarregando ? '⏳ Analisando...' : '✨ Autopreencher com IA (nome, descrição, categoria)'}
            </button>
            <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:8px;" ${(!state.fotoRefBase64 || state.gerandoFoto) ? 'disabled' : ''} onclick="window._anSpGerarFotoIA()">
              ${state.gerandoFoto ? '⏳ Gerando foto...' : '🎨 Gerar foto profissional com IA'}
            </button>

            <div class="form-label" style="margin-top:16px;margin-bottom:6px;">Mais fotos (opcional)</div>
            <input type="file" accept="image/*" multiple onchange="window._anSpUploadExtra(this)">

            ${state.fotos.length ? `
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px;">
                ${state.fotos.map((f, i) => `
                  <div style="position:relative;">
                    <img src="${f.url}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--border);">
                    ${i === 0 ? '<span style="position:absolute;top:3px;left:3px;background:#ee4d2d;color:#fff;font-size:9px;padding:1px 5px;border-radius:99px;">capa</span>' : ''}
                    <button type="button" onclick="window._anSpRemoverFoto(${f.id})" style="position:absolute;top:3px;right:3px;background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:50%;width:18px;height:18px;font-size:11px;cursor:pointer;">✕</button>
                  </div>`).join('')}
              </div>` : `<div style="font-size:11px;color:var(--text-muted);margin-top:10px;">Nenhuma foto adicionada ainda.</div>`}
          </div>

          <div class="card" style="padding:20px;">
            <div class="form-group" style="margin-bottom:12px;">
              <label class="form-label">Nome do produto</label>
              <input type="text" class="form-input" id="an-sp-nome" value="${esc(state.nomeProduto)}" placeholder="Ex: Armário de Cozinha 4 Portas MDF Branco">
            </div>
            ${state.categoriaEscolhida ? `
              <div style="background:rgba(238,77,45,0.08);border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:12px;">
                ✅ <b>${esc(state.categoriaEscolhida.nome)}</b> <span style="color:var(--text-muted);">(${esc(state.categoriaEscolhida.category_id)})</span>
                <button type="button" class="btn btn-secondary btn-sm" style="margin-left:8px;" onclick="window._anSpNavegarCategorias()">Trocar</button>
              </div>
            ` : `
              <button class="btn btn-primary btn-sm" style="margin-bottom:8px;width:100%;" onclick="window._anSpNavegarCategorias()">
                📂 Escolher categoria na lista
              </button>

              ${state.categoriaNavegando ? `
                <div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
                  <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                    <span style="cursor:pointer;text-decoration:underline;" onclick="window._anSpNavCategoriaVoltar(-1)">Categorias</span>
                    ${state.categoriaNavPath.map((p, i) => `<span>›</span><span style="cursor:pointer;text-decoration:underline;" onclick="window._anSpNavCategoriaVoltar(${i})">${esc(p.nome)}</span>`).join('')}
                  </div>
                  <div style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;">
                    ${state.categoriaNavItens.map((c, i) => `
                      <button type="button" class="btn btn-secondary btn-sm" style="text-align:left;justify-content:space-between;" onclick="window._anSpNavCategoriaAbrir(${i})">
                        <span>${esc(c.display_category_name || c.original_category_name)}</span>
                        <span style="color:var(--text-muted);">›</span>
                      </button>`).join('') || '<div style="font-size:12px;color:var(--text-muted);padding:8px;">Sem categorias nesse nível.</div>'}
                  </div>
                </div>
              ` : ''}

              <details style="margin-bottom:12px;">
                <summary style="cursor:pointer;font-size:11.5px;color:var(--text-muted);">Prefere buscar por nome? (opcional)</summary>
                <div style="margin-top:8px;">
                  <button class="btn btn-secondary btn-sm" style="margin-bottom:8px;" ${state.buscandoCategoria ? 'disabled' : ''} onclick="window._anSpSugerirCategoria()">
                    ${state.buscandoCategoria ? '⏳ Buscando...' : '✨ Sugerir categoria pra esse nome (IA)'}
                  </button>
                  <div style="display:flex;gap:8px;margin-bottom:8px;">
                    <input type="text" class="form-input" id="an-sp-cat-manual" placeholder="Buscar categoria manualmente (ex: armário)" style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();window._anSpBuscarCategoriaManual();}">
                    <button class="btn btn-secondary btn-sm" ${state.buscandoCategoria ? 'disabled' : ''} onclick="window._anSpBuscarCategoriaManual()">🔍</button>
                  </div>
                  ${state.categoriaAvisoIA ? `<div style="font-size:11px;color:#ee4d2d;margin-bottom:8px;">${esc(state.categoriaAvisoIA)}</div>` : ''}
                  ${state.categoriaSugestoes.length ? `
                    <div style="display:flex;flex-direction:column;gap:6px;">
                      ${state.categoriaSugestoes.map((c, i) => `
                        <button type="button" class="btn btn-secondary btn-sm" style="text-align:left;justify-content:flex-start;" onclick="window._anSpEscolherCategoria(${i})">
                          ${esc(c.nome)} <span style="color:var(--text-muted);font-size:11px;">(${c.category_id})</span>
                        </button>`).join('')}
                    </div>` : ''}
                </div>
              </details>

              <div style="font-size:11px;color:var(--text-muted);margin-bottom:14px;">Escolha a categoria antes de preencher a ficha técnica.</div>
            `}

            <div class="form-group" style="margin-bottom:12px;">
              <label class="form-label">Descrição</label>
              <textarea class="form-textarea" id="an-sp-descricao" rows="4" placeholder="Descreva o produto: material, medidas, diferenciais...">${state.descricao}</textarea>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px;">
              <div class="form-group" style="margin:0;"><label class="form-label">Preço (R$)</label><input type="number" step="0.01" class="form-input" id="an-sp-preco" value="${esc(state.preco)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Estoque</label><input type="number" class="form-input" id="an-sp-estoque" value="${esc(state.estoque)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Condição</label>
                <select class="form-select" id="an-sp-condicao">
                  <option value="NEW" ${state.condicao === 'NEW' ? 'selected' : ''}>Novo</option>
                  <option value="USED" ${state.condicao === 'USED' ? 'selected' : ''}>Usado</option>
                </select>
              </div>
              <div class="form-group" style="margin:0;"><label class="form-label">SKU</label><input type="text" class="form-input" id="an-sp-sku" value="${esc(state.sku)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Peso (kg)</label><input type="number" step="0.01" class="form-input" id="an-sp-peso" value="${esc(state.peso)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Compr. embalagem (cm)</label><input type="number" class="form-input" id="an-sp-compr" value="${esc(state.compr)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Larg. embalagem (cm)</label><input type="number" class="form-input" id="an-sp-larg" value="${esc(state.larg)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Alt. embalagem (cm)</label><input type="number" class="form-input" id="an-sp-alt" value="${esc(state.alt)}"></div>
            </div>

            <div class="form-group" style="margin-bottom:12px;">
              <label class="form-label">Marca ${state.marcaObrigatoria ? '*' : '(opcional)'}</label>
              ${state.carregandoMarca ? `<div style="font-size:12px;color:var(--text-muted);">⏳ Carregando marcas da categoria...</div>` :
                state.marcaOpcoes.length ? `
                  <select class="form-select" id="an-sp-marca">
                    ${state.marcaOpcoes.map(m => `<option value="${m.brand_id}" ${String(state.marca) === String(m.brand_id) ? 'selected' : ''}>${esc(m.display_brand_name)}</option>`).join('')}
                  </select>
                  <input type="text" class="form-input" id="an-sp-marca-custom" placeholder="Marca não está na lista? Digite aqui (substitui a seleção acima)" value="${esc(state.marcaCustom || '')}" style="margin-top:6px;">
                ` : `<input type="text" class="form-input" id="an-sp-marca-custom" placeholder="Ex: Genérica" value="${esc(state.marcaCustom || '')}">`}
            </div>

            ${state.carregandoAtributos ? `<div style="font-size:12px;color:var(--text-muted);">⏳ Carregando ficha técnica da categoria...</div>` : ''}
            ${!state.carregandoAtributos && state.categoriaEscolhida ? `
              ${renderBlocoAtributos(state.atributosObrigatorios, '📋 Ficha técnica — obrigatórios pro SEO/catálogo', false)}
              ${renderBlocoAtributos(state.atributosOpcionais, 'Ver mais atributos (opcionais, melhoram a busca)', true)}
            ` : ''}

            ${state.erro ? `<div style="font-size:12.5px;color:var(--red);margin-top:14px;">⚠️ ${esc(state.erro)}</div>` : ''}

            <button class="btn btn-primary" style="width:100%;padding:14px;font-size:14px;border-radius:12px;margin-top:18px;background:#ee4d2d;" ${state.criando ? 'disabled' : ''} onclick="window._anSpCriar()">
              ${state.criando ? '⏳ Criando anúncio...' : '🚀 Criar anúncio na Shopee'}
            </button>
          </div>
        </div>
      `;
    }

    el.innerHTML = `<div class="page">
      <div class="section-title mb-16">🟠 Anúncios — Shopee</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;max-width:680px;">
        Suba a foto, deixe a IA sugerir nome/descrição/categoria, confira a ficha técnica e publique — tudo numa tela só.
      </div>
      <div id="an-sp-root"></div>
      <style>@media (max-width:900px){.an-grid-resp{grid-template-columns:1fr !important;}}</style>
    </div>`;

    window._anSpSelConta = (v) => { syncFormState(); state.contaId = v; render(); };
    window._anSpUploadRef = (input) => processarFotoRef(input.files?.[0]);
    window._anSpDropRef = (ev) => processarFotoRef(ev.dataTransfer?.files?.[0]);
    window._anSpUploadExtra = (input) => processarFotosExtra(input.files || []);
    window._anSpRemoverFoto = removerFoto;
    window._anSpSugerirIA = sugerirComIA;
    window._anSpGerarFotoIA = gerarFotoIA;
    window._anSpSugerirCategoria = sugerirCategorias;
    window._anSpNavegarCategorias = abrirNavegadorCategorias;
    window._anSpNavCategoriaAbrir = (i) => navegarCategoriaPara(state.categoriaNavItens[i]);
    window._anSpNavCategoriaVoltar = navegarCategoriaVoltar;
    window._anSpBuscarCategoriaManual = buscarCategoriaManual;
    window._anSpEscolherCategoria = (i) => escolherCategoria(state.categoriaSugestoes[i]);
    window._anSpToggleOpcionais = () => { syncFormState(); state.mostrarOpcionais = !state.mostrarOpcionais; render(); };
    window._anSpCriar = criarAnuncio;
    window._anSpReset = resetar;

    render();
    carregarContas();
  }

  // ============================================================
  // TIKTOK SHOP
  // ============================================================

  function renderTikTok(params, el) {
    const state = {
      contas: [], contaId: '', carregandoContas: true,

      fotos: [], fotoRefBase64: '', fotoRefPreview: '',
      iaCarregando: false, gerandoFoto: false,

      nomeProduto: '', categoriaEscolhida: null, categoriaCaminho: '', buscandoCategoria: false, categoriaAvisoIA: '',
      categoriaNavegando: false, categoriaNavPath: [], categoriaNavItens: [], arvoreCategorias: null,
      atributosObrigatorios: [], atributosOpcionais: [], mostrarOpcionais: false, carregandoAtributos: false,
      valoresAtributos: {},

      marcaBusca: '', marcaResultados: [], marcaEscolhida: null, buscandoMarca: false,
      warehouseId: '',

      descricao: '', preco: '', estoque: '', sku: '', identifierCode: '',
      peso: '', compr: '', larg: '', alt: '',

      criando: false, resultado: null, erro: '',
    };

    function syncFormState() {
      const v = id => document.getElementById(id)?.value;
      if (document.getElementById('an-tt-nome')) {
        state.nomeProduto = v('an-tt-nome') || ''; state.descricao = v('an-tt-descricao') || '';
        state.preco = v('an-tt-preco') || ''; state.estoque = v('an-tt-estoque') || '';
        state.sku = v('an-tt-sku') || ''; state.identifierCode = v('an-tt-identifier') || '';
        state.peso = v('an-tt-peso') || ''; state.compr = v('an-tt-compr') || '';
        state.larg = v('an-tt-larg') || ''; state.alt = v('an-tt-alt') || '';
      }
      if (document.getElementById('an-tt-marca-busca')) state.marcaBusca = v('an-tt-marca-busca') || '';
      [...state.atributosObrigatorios, ...state.atributosOpcionais].forEach(a => {
        const tipo = campoTipoAtributo(a);
        if (tipo === 'multi') {
          const el2 = document.getElementById(`attr-${a.id}`);
          const sel = el2 ? Array.from(el2.selectedOptions).map(o => o.value) : [];
          if (sel.length) state.valoresAtributos[a.id] = sel;
        } else if (tipo === 'texto') {
          const val = v(`attr-${a.id}`);
          if (val) state.valoresAtributos[a.id] = val;
        } else {
          const val = v(`attr-${a.id}`);
          if (val) state.valoresAtributos[a.id] = val;
        }
      });
    }

    function render() { renderPainel(); }

    async function carregarContas() {
      try {
        const todas = await MarketplaceAPI.listAccounts();
        state.contas = todas.filter(c => (c.marketplace || '').toLowerCase() === 'tiktok_shop');
        if (state.contas.length === 1) { state.contaId = state.contas[0].external_id; await carregarWarehouse(); }
      } catch (e) {
        state.erro = 'Não consegui carregar as lojas: ' + e.message;
      } finally {
        state.carregandoContas = false;
        render();
      }
    }

    function nomeConta(c) {
      const tag = c.tags?.[0]?.name || c.tags?.[0];
      return (typeof tag === 'string' ? tag : tag?.value) || c.nickname || c.external_id;
    }

    async function carregarWarehouse() {
      try {
        const resp = await MarketplaceAPI.call('tiktok_get_warehouses', { open_id: state.contaId });
        const lista = resp.data?.warehouses || resp.warehouses || [];
        const vendas = lista.filter(w => w.type === 'SALES_WAREHOUSE');
        const escolhido = vendas.find(w => w.is_default) || vendas[0];
        state.warehouseId = escolhido?.id || '';
        if (!state.warehouseId) state.erro = 'Essa loja não tem um SALES_WAREHOUSE ativo — não dá pra criar produto sem isso.';
      } catch (e) {
        state.erro = 'Erro ao buscar o armazém da loja: ' + e.message;
      }
    }

    // ── Árvore de categorias cacheada (mesmo padrão da Shopee) ──────────
    async function obterArvoreCategorias() {
      if (state.arvoreCategorias) return state.arvoreCategorias;
      try {
        const cache = JSON.parse(localStorage.getItem('glr_tiktok_categorias_cache') || 'null');
        if (cache && Date.now() - cache.ts < 7 * 24 * 3600 * 1000) { state.arvoreCategorias = cache.lista; return cache.lista; }
      } catch (e) {}
      const resp = await MarketplaceAPI.call('tiktok_get_categories', { open_id: state.contaId });
      const lista = resp.data?.categories || resp.categories || [];
      try { localStorage.setItem('glr_tiktok_categorias_cache', JSON.stringify({ ts: Date.now(), lista })); } catch (e) {}
      state.arvoreCategorias = lista;
      return lista;
    }

    async function abrirNavegadorCategorias() {
      syncFormState();
      if (!state.contaId) { alert('Selecione a loja TikTok primeiro.'); return; }
      state.categoriaNavegando = true;
      state.categoriaNavPath = [];
      state.categoriaAvisoIA = '';
      render();
      await obterArvoreCategorias();
      state.categoriaNavItens = (state.arvoreCategorias || []).filter(c => c.parent_id === '0' || c.parent_id === 0);
      render();
    }

    async function navegarCategoriaPara(cat) {
      const filhos = (state.arvoreCategorias || []).filter(c => c.parent_id === cat.id);
      if (!filhos.length || cat.is_leaf) {
        state.categoriaEscolhida = { category_id: cat.id, nome: cat.local_name };
        state.categoriaCaminho = [...state.categoriaNavPath.map(p => p.nome), cat.local_name].join(' › ');
        state.categoriaNavegando = false;
        await carregarFichaTecnica();
        return;
      }
      state.categoriaNavPath.push({ id: cat.id, nome: cat.local_name });
      state.categoriaNavItens = filhos;
      render();
    }

    function navegarCategoriaVoltar(indice) {
      if (indice < 0) { state.categoriaNavPath = []; state.categoriaNavItens = (state.arvoreCategorias || []).filter(c => c.parent_id === '0' || c.parent_id === 0); render(); return; }
      state.categoriaNavPath = state.categoriaNavPath.slice(0, indice + 1);
      const paiId = state.categoriaNavPath[indice].id;
      state.categoriaNavItens = (state.arvoreCategorias || []).filter(c => c.parent_id === paiId);
      render();
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
        if (json.titulo) state.nomeProduto = json.titulo;
        if (json.descricao) state.descricao = json.descricao;
        state.iaCarregando = false;
        // categoria_busca é mais descritivo que o título comercial pra achar categoria.
        if (json.categoria_busca || state.nomeProduto) { await sugerirCategoria(json.categoria_busca); return; }
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
          body: JSON.stringify({ image_base64: state.fotoRefBase64, product_name: state.nomeProduto, details: state.descricao, stage: 'ambientada' }),
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

    // ── Categoria sugerida (TikTok devolve o caminho completo + a folha).
    // termoOverride (opcional) é o categoria_busca vindo da IA de foto. ──
    async function sugerirCategoria(termoOverride) {
      syncFormState();
      const termoBase = termoOverride || state.nomeProduto;
      if (!termoBase || !termoBase.trim()) { alert('Preencha o nome do produto primeiro.'); return; }
      if (!state.contaId) { alert('Selecione a loja TikTok primeiro.'); return; }
      state.buscandoCategoria = true;
      state.categoriaAvisoIA = '';
      render();
      try {
        const buscar = async (termo) => {
          const resp = await MarketplaceAPI.call('tiktok_recommend_category', {
            open_id: state.contaId,
            body: { product_title: termo, description: state.descricao || undefined },
          });
          const d = resp.data || resp;
          const caminho = d.categories || [];
          const folhaId = d.leaf_category_id;
          const folha = caminho.find(c => c.id === folhaId) || caminho[caminho.length - 1];
          return folha ? { category_id: folhaId, nome: folha.name || folha.local_name, caminho: caminho.map(c => c.name || c.local_name).join(' › ') } : null;
        };

        let achada = await buscar(termoBase);
        if (!achada) {
          state.categoriaAvisoIA = '🧠 IA pensando em termos alternativos...';
          render();
          const termos = await sugerirTermosAlternativos(state.nomeProduto, state.descricao);
          for (const termo of termos) {
            achada = await buscar(termo).catch(() => null);
            if (achada) { state.categoriaAvisoIA = `Nada encontrado pra "${termoBase}" — a IA tentou "${termo}" e achou isso.`; break; }
          }
        }
        if (!achada) {
          state.categoriaAvisoIA = '';
          alert('O TikTok não sugeriu categoria pra esse nome, nem com os termos alternativos que a IA tentou. Ajuste o nome do produto e tente de novo.');
          return;
        }
        state.categoriaEscolhida = { category_id: achada.category_id, nome: achada.nome };
        state.categoriaCaminho = achada.caminho;
        state.categoriaNavegando = false;
        await carregarFichaTecnica();
      } catch (e) {
        alert('Erro ao sugerir categoria: ' + (e.message || e));
      } finally {
        state.buscandoCategoria = false;
        render();
      }
    }

    async function carregarFichaTecnica() {
      state.valoresAtributos = {};
      state.mostrarOpcionais = false;
      state.carregandoAtributos = true;
      render();
      try {
        const resp = await MarketplaceAPI.call('tiktok_listing_schemas', { category_ids: state.categoriaEscolhida.category_id, open_id: state.contaId });
        const schema = (resp.data?.listing_schemas || resp.listing_schemas || [])[0];
        const campoAtributos = (schema?.fields || []).find(f => f.id === 'product_attribute');
        const todos = campoAtributos?.complex_values || [];
        state.atributosObrigatorios = todos.filter(a => a.rules?.some(r => r.type === 'REQUIRED' && r.value === 'true'));
        state.atributosOpcionais = todos.filter(a => !a.rules?.some(r => r.type === 'REQUIRED' && r.value === 'true'));
      } catch (e) {
        alert('Erro ao buscar ficha técnica da categoria: ' + (e.message || e));
      } finally {
        state.carregandoAtributos = false;
        render();
      }
    }

    // ── Marca (busca sob demanda — lista global tem milhares de itens) ──
    async function buscarMarca() {
      syncFormState();
      if (!state.marcaBusca.trim()) { alert('Digite o nome da marca pra buscar.'); return; }
      state.buscandoMarca = true;
      render();
      try {
        const resp = await MarketplaceAPI.call('tiktok_get_brands', { open_id: state.contaId, brand_name: state.marcaBusca, page_size: 15 });
        state.marcaResultados = resp.data?.brands || resp.brands || [];
        if (!state.marcaResultados.length) alert('Nenhuma marca encontrada com esse nome.');
      } catch (e) {
        alert('Erro ao buscar marca: ' + (e.message || e));
      } finally {
        state.buscandoMarca = false;
        render();
      }
    }

    function escolherMarca(m) {
      syncFormState();
      state.marcaEscolhida = m;
      state.marcaResultados = [];
      render();
    }

    // ── Renderização de campo de atributo dinâmico ───────────
    function campoTipoAtributo(a) {
      if (Array.isArray(a.options) && a.options.length) {
        return a.rules?.some(r => r.type === 'MULTI_INPUT' && r.value === 'true') ? 'multi' : 'select';
      }
      return 'texto';
    }

    function renderCampoAtributo(a) {
      const tipo = campoTipoAtributo(a);
      const valorSalvo = state.valoresAtributos[a.id];
      if (tipo === 'select') {
        return `<select class="form-select" id="attr-${a.id}">
          <option value="">— não informado —</option>
          ${a.options.map(o => `<option value="${o.id}" ${String(valorSalvo) === String(o.id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
        </select>`;
      }
      if (tipo === 'multi') {
        const sel = Array.isArray(valorSalvo) ? valorSalvo.map(String) : [];
        return `<select class="form-select" id="attr-${a.id}" multiple size="4">
          ${a.options.map(o => `<option value="${o.id}" ${sel.includes(String(o.id)) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
        </select>
        <div style="font-size:10px;color:var(--text-muted);">Segura Ctrl/Cmd pra marcar mais de um.</div>`;
      }
      return `<input type="text" class="form-input" id="attr-${a.id}" value="${esc(valorSalvo || '')}">`;
    }

    function renderBlocoAtributos(lista, titulo, colapsavel) {
      if (!lista.length) return '';
      const conteudo = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
        ${lista.map(a => `<div class="form-group" style="margin:0;">
          <label class="form-label">${esc(a.name)}${a.rules?.some(r => r.type === 'REQUIRED' && r.value === 'true') ? ' *' : ''}</label>
          ${renderCampoAtributo(a)}
        </div>`).join('')}
      </div>`;
      if (!colapsavel) return `<div style="margin-top:14px;"><div class="form-label" style="margin-bottom:8px;">${titulo}</div>${conteudo}</div>`;
      return `<div style="margin-top:14px;">
        <button type="button" class="btn btn-secondary btn-sm" onclick="window._anTtToggleOpcionais()">
          ${state.mostrarOpcionais ? '▲' : '▼'} ${titulo} (${lista.length})
        </button>
        ${state.mostrarOpcionais ? `<div style="margin-top:10px;">${conteudo}</div>` : ''}
      </div>`;
    }

    function montarAtributosPayload() {
      const out = [];
      [...state.atributosObrigatorios, ...state.atributosOpcionais].forEach(a => {
        const tipo = campoTipoAtributo(a);
        if (tipo === 'select') {
          const val = document.getElementById(`attr-${a.id}`)?.value;
          if (val) {
            const opt = a.options.find(o => String(o.id) === val);
            out.push({ id: a.id, values: [{ id: val, name: opt?.name }] });
          }
        } else if (tipo === 'multi') {
          const el2 = document.getElementById(`attr-${a.id}`);
          const sel = el2 ? Array.from(el2.selectedOptions) : [];
          if (sel.length) out.push({ id: a.id, values: sel.map(o => ({ id: o.value, name: o.textContent })) });
        } else {
          const val = document.getElementById(`attr-${a.id}`)?.value?.trim();
          if (val) out.push({ id: a.id, values: [{ name: val }] });
        }
      });
      return out;
    }

    // ── Criação: sobe cada foto (TikTok exige uri própria, não aceita
    // base64/URL de outro site direto no anúncio) e então cria o produto ──
    async function criarAnuncio() {
      if (!state.contaId) return alert('Selecione a loja TikTok.');
      if (!state.warehouseId) return alert('Essa loja não tem um armazém de vendas configurado — não dá pra criar o produto.');
      if (!state.categoriaEscolhida) return alert('Sugira e confirme uma categoria antes de criar o anúncio.');
      if (!state.fotos.length) return alert('Adicione pelo menos uma foto ao anúncio.');

      const nome = document.getElementById('an-tt-nome')?.value.trim();
      const descricao = document.getElementById('an-tt-descricao')?.value.trim();
      const preco = parseFloat(document.getElementById('an-tt-preco')?.value);
      const estoque = parseInt(document.getElementById('an-tt-estoque')?.value, 10);
      const sku = document.getElementById('an-tt-sku')?.value.trim();
      const identifier = document.getElementById('an-tt-identifier')?.value.trim();
      const peso = document.getElementById('an-tt-peso')?.value;
      const compr = document.getElementById('an-tt-compr')?.value;
      const larg = document.getElementById('an-tt-larg')?.value;
      const alt = document.getElementById('an-tt-alt')?.value;

      if (!nome) return alert('Preencha o nome do produto.');
      if (!descricao) return alert('Preencha a descrição.');
      if (!(preco > 0)) return alert('Informe um preço válido.');
      if (!(estoque >= 0)) return alert('Informe o estoque.');
      if (!(peso > 0)) return alert('Informe o peso da embalagem.');
      if (!(compr > 0 && larg > 0 && alt > 0)) return alert('Informe comprimento, largura e altura da embalagem.');

      const faltando = state.atributosObrigatorios.filter(a => {
        const tipo = campoTipoAtributo(a);
        if (tipo === 'multi') return !document.getElementById(`attr-${a.id}`)?.selectedOptions?.length;
        return !document.getElementById(`attr-${a.id}`)?.value;
      });
      if (faltando.length && !confirm(`Faltam ${faltando.length} atributo(s) obrigatório(s) (${faltando.map(a => a.name).join(', ')}). O TikTok pode recusar o anúncio. Continuar mesmo assim?`)) return;

      state.criando = true; state.erro = ''; state.resultado = null;
      render();
      try {
        // 1) Sobe cada foto e pega a uri própria da TikTok
        const imagens = [];
        for (const f of state.fotos) {
          const up = await MarketplaceAPI.call('tiktok_upload_image', { open_id: state.contaId, image_base64: f.url, use_case: 'MAIN_IMAGE' });
          const uri = up.data?.uri || up.uri;
          if (uri) imagens.push({ uri });
        }
        if (!imagens.length) throw new Error('Nenhuma foto foi aceita pelo TikTok.');

        // 2) Monta e cria o produto
        const body = {
          title: nome,
          description: descricao,
          category_id: state.categoriaEscolhida.category_id,
          main_images: imagens,
          package_weight: { value: String(peso), unit: 'KILOGRAM' },
          package_dimensions: { length: String(compr), width: String(larg), height: String(alt), unit: 'CENTIMETER' },
          skus: [{
            seller_sku: sku || undefined,
            price: { amount: String(preco), currency: 'BRL' },
            inventory: [{ warehouse_id: state.warehouseId, quantity: estoque }],
            identifier_code: identifier ? { code: identifier } : undefined,
          }],
        };
        if (state.marcaEscolhida) body.brand_id = state.marcaEscolhida.id;
        const atributos = montarAtributosPayload();
        if (atributos.length) body.product_attributes = atributos;

        const resp = await MarketplaceAPI.call('tiktok_create_product', { open_id: state.contaId, body });
        state.resultado = resp.data || resp;
      } catch (e) {
        state.erro = e.message || String(e);
      } finally {
        state.criando = false;
        render();
      }
    }

    function resetar() { Router.navigate('anuncios-tiktok'); }

    // ── Render principal ──────────────────────────────────────
    function renderPainel() {
      const root = document.getElementById('an-tt-root');
      if (!root) return;

      if (state.resultado) {
        root.innerHTML = `<div class="card" style="padding:40px;text-align:center;max-width:520px;margin:0 auto;">
          <div style="font-size:44px;margin-bottom:12px;">✅</div>
          <div style="font-size:18px;font-weight:800;margin-bottom:8px;">Anúncio criado no TikTok Shop!</div>
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">Product ID: ${esc(state.resultado.product_id || '—')} — o TikTok revisa antes de deixar visível na loja.</div>
          <button class="btn btn-secondary" style="width:100%;" onclick="window._anTtReset()">➕ Criar outro anúncio</button>
        </div>`;
        return;
      }

      root.innerHTML = `
        <div class="card" style="padding:20px 22px;margin-bottom:16px;">
          <div class="form-group" style="margin:0;">
            <label class="form-label">Loja TikTok Shop</label>
            <select class="form-select" id="an-tt-conta" ${state.carregandoContas ? 'disabled' : ''} onchange="window._anTtSelConta(this.value)">
              ${state.carregandoContas ? '<option>Carregando lojas...</option>' :
                `<option value="">— Selecione —</option>` + state.contas.map(c => `<option value="${c.external_id}" ${state.contaId === c.external_id ? 'selected' : ''}>${esc(nomeConta(c))}</option>`).join('')}
            </select>
            ${state.warehouseId ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Armazém de vendas encontrado ✓</div>` : ''}
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:16px;margin-bottom:16px;" class="an-grid-resp">
          <div class="card" style="padding:20px;">
            <div class="form-label" style="margin-bottom:10px;">📸 Foto do produto</div>
            <div id="an-tt-dropzone" ondragover="event.preventDefault();this.style.borderColor='#25F4EE';" ondragleave="this.style.borderColor='var(--border)';"
                 ondrop="event.preventDefault();this.style.borderColor='var(--border)';window._anTtDropRef(event);"
                 onclick="document.getElementById('an-tt-ref-input').click()"
                 style="border:2px dashed var(--border);border-radius:14px;min-height:160px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;text-align:center;padding:16px;background:var(--bg-soft,#f7f8fc);">
              ${state.fotoRefPreview
                ? `<img src="${state.fotoRefPreview}" style="max-width:100%;max-height:130px;border-radius:8px;object-fit:contain;">`
                : `<div style="font-size:32px;">📤</div><div style="font-size:12.5px;font-weight:600;margin-top:6px;">Envie a foto de referência</div>`}
              <input type="file" id="an-tt-ref-input" accept="image/*" style="display:none;" onchange="window._anTtUploadRef(this)">
            </div>

            <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:10px;" ${(!state.fotoRefBase64 || state.iaCarregando) ? 'disabled' : ''} onclick="window._anTtSugerirIA()">
              ${state.iaCarregando ? '⏳ Analisando...' : '✨ Autopreencher com IA (nome, descrição, categoria)'}
            </button>
            <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:8px;" ${(!state.fotoRefBase64 || state.gerandoFoto) ? 'disabled' : ''} onclick="window._anTtGerarFotoIA()">
              ${state.gerandoFoto ? '⏳ Gerando foto...' : '🎨 Gerar foto profissional com IA'}
            </button>

            <div class="form-label" style="margin-top:16px;margin-bottom:6px;">Mais fotos (opcional)</div>
            <input type="file" accept="image/*" multiple onchange="window._anTtUploadExtra(this)">

            ${state.fotos.length ? `
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px;">
                ${state.fotos.map((f, i) => `
                  <div style="position:relative;">
                    <img src="${f.url}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--border);">
                    ${i === 0 ? '<span style="position:absolute;top:3px;left:3px;background:#000;color:#fff;font-size:9px;padding:1px 5px;border-radius:99px;">capa</span>' : ''}
                    <button type="button" onclick="window._anTtRemoverFoto(${f.id})" style="position:absolute;top:3px;right:3px;background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:50%;width:18px;height:18px;font-size:11px;cursor:pointer;">✕</button>
                  </div>`).join('')}
              </div>` : `<div style="font-size:11px;color:var(--text-muted);margin-top:10px;">Nenhuma foto adicionada ainda.</div>`}
          </div>

          <div class="card" style="padding:20px;">
            <div class="form-group" style="margin-bottom:12px;">
              <label class="form-label">Nome do produto</label>
              <input type="text" class="form-input" id="an-tt-nome" value="${esc(state.nomeProduto)}" placeholder="Ex: Armário de Cozinha 4 Portas MDF Branco">
            </div>
            ${state.categoriaEscolhida ? `
              <div style="background:rgba(37,244,238,0.08);border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:12px;">
                ✅ <b>${esc(state.categoriaCaminho || state.categoriaEscolhida.nome)}</b>
                <button type="button" class="btn btn-secondary btn-sm" style="margin-left:8px;" onclick="window._anTtNavegarCategorias()">Trocar</button>
              </div>
            ` : `
              <button class="btn btn-primary btn-sm" style="margin-bottom:8px;width:100%;" onclick="window._anTtNavegarCategorias()">
                📂 Escolher categoria na lista
              </button>

              ${state.categoriaNavegando ? `
                <div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
                  <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                    <span style="cursor:pointer;text-decoration:underline;" onclick="window._anTtNavCategoriaVoltar(-1)">Categorias</span>
                    ${state.categoriaNavPath.map((p, i) => `<span>›</span><span style="cursor:pointer;text-decoration:underline;" onclick="window._anTtNavCategoriaVoltar(${i})">${esc(p.nome)}</span>`).join('')}
                  </div>
                  <div style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;">
                    ${state.categoriaNavItens.map((c, i) => `
                      <button type="button" class="btn btn-secondary btn-sm" style="text-align:left;justify-content:space-between;" onclick="window._anTtNavCategoriaAbrir(${i})">
                        <span>${esc(c.local_name)}</span>
                        <span style="color:var(--text-muted);">${c.is_leaf ? '✓' : '›'}</span>
                      </button>`).join('') || '<div style="font-size:12px;color:var(--text-muted);padding:8px;">Sem categorias nesse nível.</div>'}
                  </div>
                </div>
              ` : ''}

              <details style="margin-bottom:12px;">
                <summary style="cursor:pointer;font-size:11.5px;color:var(--text-muted);">Prefere buscar por nome? (opcional)</summary>
                <div style="margin-top:8px;">
                  <button class="btn btn-secondary btn-sm" ${state.buscandoCategoria ? 'disabled' : ''} onclick="window._anTtSugerirCategoria()">
                    ${state.buscandoCategoria ? '⏳ Buscando...' : '✨ Sugerir categoria pra esse nome (IA)'}
                  </button>
                  ${state.categoriaAvisoIA ? `<div style="font-size:11px;color:#25b0aa;margin-top:8px;">${esc(state.categoriaAvisoIA)}</div>` : ''}
                </div>
              </details>

              <div style="font-size:11px;color:var(--text-muted);margin-bottom:14px;">Escolha a categoria antes de preencher a ficha técnica.</div>
            `}

            <div class="form-group" style="margin-bottom:12px;">
              <label class="form-label">Descrição</label>
              <textarea class="form-textarea" id="an-tt-descricao" rows="4" placeholder="Descreva o produto: material, medidas, diferenciais...">${state.descricao}</textarea>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px;">
              <div class="form-group" style="margin:0;"><label class="form-label">Preço (R$)</label><input type="number" step="0.01" class="form-input" id="an-tt-preco" value="${esc(state.preco)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Estoque</label><input type="number" class="form-input" id="an-tt-estoque" value="${esc(state.estoque)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">SKU</label><input type="text" class="form-input" id="an-tt-sku" value="${esc(state.sku)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">GTIN/EAN (opcional)</label><input type="text" class="form-input" id="an-tt-identifier" value="${esc(state.identifierCode)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Peso c/ embalagem (kg)</label><input type="number" step="0.01" class="form-input" id="an-tt-peso" value="${esc(state.peso)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Compr. embalagem (cm)</label><input type="number" class="form-input" id="an-tt-compr" value="${esc(state.compr)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Larg. embalagem (cm)</label><input type="number" class="form-input" id="an-tt-larg" value="${esc(state.larg)}"></div>
              <div class="form-group" style="margin:0;"><label class="form-label">Alt. embalagem (cm)</label><input type="number" class="form-input" id="an-tt-alt" value="${esc(state.alt)}"></div>
            </div>

            <div class="form-group" style="margin-bottom:12px;">
              <label class="form-label">Marca (opcional)</label>
              <div style="display:flex;gap:8px;">
                <input type="text" class="form-input" id="an-tt-marca-busca" value="${esc(state.marcaBusca)}" placeholder="Buscar marca registrada na loja" style="flex:1;">
                <button type="button" class="btn btn-secondary btn-sm" ${state.buscandoMarca ? 'disabled' : ''} onclick="window._anTtBuscarMarca()">${state.buscandoMarca ? '⏳' : '🔍'}</button>
              </div>
              ${state.marcaResultados.length ? `
                <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px;max-height:140px;overflow-y:auto;">
                  ${state.marcaResultados.map((m, i) => `<button type="button" class="btn btn-secondary btn-sm" style="text-align:left;justify-content:flex-start;" onclick="window._anTtEscolherMarca(${i})">${esc(m.name)}</button>`).join('')}
                </div>` : ''}
              ${state.marcaEscolhida ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">Marca selecionada: <b>${esc(state.marcaEscolhida.name)}</b></div>` : ''}
            </div>

            ${state.carregandoAtributos ? `<div style="font-size:12px;color:var(--text-muted);">⏳ Carregando ficha técnica da categoria...</div>` : ''}
            ${!state.carregandoAtributos && state.categoriaEscolhida ? `
              ${renderBlocoAtributos(state.atributosObrigatorios, '📋 Ficha técnica — obrigatórios pro SEO/catálogo', false)}
              ${renderBlocoAtributos(state.atributosOpcionais, 'Ver mais atributos (opcionais, melhoram a busca)', true)}
            ` : ''}

            ${state.erro ? `<div style="font-size:12.5px;color:var(--red);margin-top:14px;">⚠️ ${esc(state.erro)}</div>` : ''}

            <button class="btn btn-primary" style="width:100%;padding:14px;font-size:14px;border-radius:12px;margin-top:18px;background:#000;" ${state.criando ? 'disabled' : ''} onclick="window._anTtCriar()">
              ${state.criando ? '⏳ Criando anúncio...' : '🚀 Criar anúncio no TikTok Shop'}
            </button>
          </div>
        </div>
      `;
    }

    el.innerHTML = `<div class="page">
      <div class="section-title mb-16">⬛ Anúncios — TikTok Shop</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;max-width:680px;">
        Suba a foto, deixe a IA sugerir nome/descrição/categoria, confira a ficha técnica e publique — tudo numa tela só.
      </div>
      <div id="an-tt-root"></div>
      <style>@media (max-width:900px){.an-grid-resp{grid-template-columns:1fr !important;}}</style>
    </div>`;

    window._anTtSelConta = async (v) => { syncFormState(); state.contaId = v; state.warehouseId = ''; render(); await carregarWarehouse(); render(); };
    window._anTtUploadRef = (input) => processarFotoRef(input.files?.[0]);
    window._anTtDropRef = (ev) => processarFotoRef(ev.dataTransfer?.files?.[0]);
    window._anTtUploadExtra = (input) => processarFotosExtra(input.files || []);
    window._anTtRemoverFoto = removerFoto;
    window._anTtSugerirIA = sugerirComIA;
    window._anTtGerarFotoIA = gerarFotoIA;
    window._anTtSugerirCategoria = sugerirCategoria;
    window._anTtNavegarCategorias = abrirNavegadorCategorias;
    window._anTtNavCategoriaAbrir = (i) => navegarCategoriaPara(state.categoriaNavItens[i]);
    window._anTtNavCategoriaVoltar = navegarCategoriaVoltar;
    window._anTtBuscarMarca = buscarMarca;
    window._anTtEscolherMarca = (i) => escolherMarca(state.marcaResultados[i]);
    window._anTtToggleOpcionais = () => { syncFormState(); state.mostrarOpcionais = !state.mostrarOpcionais; render(); };
    window._anTtCriar = criarAnuncio;
    window._anTtReset = resetar;

    render();
    carregarContas();
  }

  Router.register('anuncios-ml', renderML);
  Router.register('anuncios-shopee', renderShopee);
  Router.register('anuncios-tiktok', renderTikTok);
  Router.register('anuncios-amazon', (p, el) => renderEmConstrucao('amazon', el));

})();
