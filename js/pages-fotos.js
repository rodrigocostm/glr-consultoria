// ============================================================
// GLR Consultoria — Gerador de Fotos (analistas geram fotos de produto com
// IA a partir de uma foto de referência; não publica nada, só gera e baixa)
// ============================================================

// Templates de prompt por tipo de foto — cada um monta o texto final a partir
// dos campos preenchidos. O texto final SEMPRE passa por uma revisão manual
// (textarea editável) antes de ir pra geração, pra não gastar crédito de IA
// com um prompt errado.
const _FOTO_TEMPLATES = [
  {
    id: 'ambientada',
    nome: '🏠 Ambientada',
    desc: 'Produto inserido num ambiente, com itens de composição ao redor',
    campos: [
      { key: 'o_que_e', label: 'O que é o produto', placeholder: 'Ex: um sofá de 3 lugares cinza' },
      { key: 'onde_vai', label: 'Onde o produto vai / itens ao redor', placeholder: 'Ex: sala de estar moderna, com tapete, quadro e luminária' },
    ],
    montar: c => `Faça um ambiente ${c.o_que_e || '(o que é o produto)'}, coloque itens para compor a imagem, ${c.onde_vai || '(onde o produto vai)'}, realista, 8k, a imagem será usada em canais de venda marketplace, resolução 2100x2100`,
  },
  {
    id: 'closeup_dir_esq',
    nome: '🔍 Close-up (direita → esquerda, câmera alta)',
    desc: 'Câmera próxima, produto da direita pra esquerda, vista de cima',
    campos: [
      { key: 'produto', label: 'Produto', placeholder: 'Ex: o tênis' },
      { key: 'foco', label: 'Onde deve focar', placeholder: 'Ex: no solado e nos cadarços' },
    ],
    montar: c => `Faça uma imagem de close up, focando no ${c.produto || '(produto)'}, câmera próxima, mostrando o ${c.produto || '(produto)'} da direita pra esquerda, ${c.foco || '(onde deve focar)'}, câmera alta, a imagem será usada em canais de venda marketplace`,
  },
  {
    id: 'closeup_esq_dir',
    nome: '🔍 Close-up (esquerda → direita, ângulo Plongé)',
    desc: 'Câmera próxima, produto completo da esquerda pra direita, ângulo Plongé',
    campos: [
      { key: 'produto', label: 'Produto', placeholder: 'Ex: o tênis' },
    ],
    montar: c => `Faça uma imagem de close up, focando no ${c.produto || '(produto)'}, câmera próxima, mostrando o ${c.produto || '(produto)'} da esquerda pra direita, câmera próxima, ângulo Plongé, enquadrando o ${c.produto || '(produto)'} completo, a imagem será usada em canais de venda marketplace`,
  },
  {
    id: 'render3d',
    nome: '🧊 Render 3D (fundo branco)',
    desc: 'Produto em render 3D realista, fundo branco',
    campos: [
      { key: 'produto', label: 'Produto', placeholder: 'Ex: o liquidificador' },
      { key: 'o_que_e', label: 'O que é o produto', placeholder: 'Ex: um liquidificador prateado de 3 velocidades' },
    ],
    montar: c => `Faça esse ${c.produto || '(produto)'} em render 3D, ${c.o_que_e || '(o que é o produto)'}, realista, 8k, fundo branco, a imagem será usada em canais de venda marketplace`,
  },
  {
    id: 'frontal',
    nome: '↔️ Ângulo Frontal',
    desc: 'Muda o ângulo do produto pra vista de frente',
    campos: [
      { key: 'produto', label: 'Produto', placeholder: 'Ex: a cadeira' },
    ],
    montar: c => `Mude o ângulo de visão desse ${c.produto || '(produto)'} para que o ${c.produto || '(produto)'} seja visto de frente`,
  },
];

Router.register('fotos', (params, el) => {
  if (!GLR.gestores.length) {
    el.innerHTML = `<div class="page">
      <div style="text-align:center;padding:80px 24px;">
        <div style="font-size:52px;margin-bottom:16px;">🎨</div>
        <div style="font-size:20px;font-weight:800;color:var(--text-primary);margin-bottom:8px;">Nenhum gestor cadastrado ainda</div>
        <div style="font-size:14px;color:var(--text-muted);max-width:420px;margin:0 auto 24px;">Cadastre pelo menos um gestor antes de usar o gerador.</div>
        <button class="btn btn-primary" onclick="Router.navigate('gestores')">Cadastrar gestor</button>
      </div>
    </div>`;
    return;
  }

  let modo = 'tipo'; // 'tipo' (geradores específicos) | 'kit' (kit automático de 3 fotos)

  const estado = {
    refBase64: '', refPreviewUrl: '',
    nome: '', detalhes: '', sugerindo: false,
    gerandoAmbientada: false, ambientada: null,      // { url }
    gerandoDetalhes: false, detalhes_imgs: [], errosDetalhes: [],
  };

  const tipoState = {
    templateId: _FOTO_TEMPLATES[0].id,
    campos: {},
    prompt: '',
    promptMontado: false,
    gerando: false,
    resultado: null, // { url }
  };

  function resetTudo() {
    estado.refBase64 = ''; estado.refPreviewUrl = '';
    estado.nome = ''; estado.detalhes = ''; estado.sugerindo = false;
    estado.gerandoAmbientada = false; estado.ambientada = null;
    estado.gerandoDetalhes = false; estado.detalhes_imgs = []; estado.errosDetalhes = [];
    tipoState.campos = {}; tipoState.prompt = ''; tipoState.promptMontado = false;
    tipoState.gerando = false; tipoState.resultado = null;
  }

  function processarArquivo(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      estado.refPreviewUrl = String(reader.result || '');
      estado.refBase64 = estado.refPreviewUrl;
      estado.ambientada = null; estado.detalhes_imgs = []; estado.errosDetalhes = [];
      tipoState.resultado = null;
      render();
    };
    reader.readAsDataURL(file);
  }

  async function sugerirComIA() {
    if (!estado.refBase64) return;
    estado.sugerindo = true;
    render();
    try {
      const resp = await fetch('/api/analyze-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: estado.refBase64 }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Erro ao sugerir com IA.');
      if (json.titulo) estado.nome = json.titulo;
    } catch (e) {
      alert('Erro ao sugerir com IA: ' + (e.message || e));
    } finally {
      estado.sugerindo = false;
      render();
    }
  }

  async function gerarAmbientada() {
    if (!estado.refBase64) { alert('Envie a foto de referência primeiro.'); return; }
    estado.nome = document.getElementById('foto-nome')?.value || estado.nome;
    estado.detalhes = document.getElementById('foto-detalhes')?.value || estado.detalhes;
    estado.gerandoAmbientada = true;
    estado.ambientada = null; estado.detalhes_imgs = []; estado.errosDetalhes = [];
    render();
    try {
      const resp = await fetch('/api/generate-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: estado.refBase64, product_name: estado.nome, details: estado.detalhes, stage: 'ambientada' }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Erro ao gerar foto.');
      estado.ambientada = json.images?.[0] || null;
      if (!estado.ambientada) alert('A IA não devolveu nenhuma imagem.');
    } catch (e) {
      alert('Erro ao gerar foto ambientada: ' + (e.message || e));
    } finally {
      estado.gerandoAmbientada = false;
      render();
    }
  }

  async function gerarDetalhes() {
    if (!estado.ambientada) return;
    estado.gerandoDetalhes = true;
    estado.detalhes_imgs = []; estado.errosDetalhes = [];
    render();
    try {
      const resp = await fetch('/api/generate-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: estado.refBase64, product_name: estado.nome, details: estado.detalhes,
          stage: 'detalhes', ambientada_base64: estado.ambientada.url,
        }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Erro ao gerar detalhes.');
      estado.detalhes_imgs = json.images || [];
      estado.errosDetalhes = json.erros || [];
      if (!estado.detalhes_imgs.length) alert('A IA não devolveu nenhuma foto de detalhe.');
    } catch (e) {
      alert('Erro ao gerar fotos de detalhe: ' + (e.message || e));
    } finally {
      estado.gerandoDetalhes = false;
      render();
    }
  }

  // ── Modo "Por Tipo Específico" ──────────────────────────────
  function templateAtual() {
    return _FOTO_TEMPLATES.find(t => t.id === tipoState.templateId) || _FOTO_TEMPLATES[0];
  }

  function montarPrompt() {
    const t = templateAtual();
    // Lê os campos direto do DOM (fonte da verdade no momento do clique)
    t.campos.forEach(c => {
      const el2 = document.getElementById('tipo-campo-' + c.key);
      tipoState.campos[c.key] = el2?.value || '';
    });
    tipoState.prompt = t.montar(tipoState.campos);
    tipoState.promptMontado = true;
    renderPainel();
  }

  async function gerarPorTipo() {
    const promptFinal = document.getElementById('tipo-prompt')?.value.trim();
    if (!promptFinal) { alert('Monte (ou escreva) o prompt antes de gerar.'); return; }
    if (!estado.refBase64) { alert('Envie a foto de referência primeiro.'); return; }
    tipoState.prompt = promptFinal;
    tipoState.gerando = true;
    tipoState.resultado = null;
    renderPainel();
    try {
      const resp = await fetch('/api/generate-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: estado.refBase64, stage: 'custom', prompt: promptFinal }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Erro ao gerar foto.');
      tipoState.resultado = json.images?.[0] || null;
      if (!tipoState.resultado) alert('A IA não devolveu nenhuma imagem.');
    } catch (e) {
      alert('Erro ao gerar foto: ' + (e.message || e));
    } finally {
      tipoState.gerando = false;
      renderPainel();
    }
  }

  function registrarAcao() {
    const responsavel = document.getElementById('foto-resp')?.value;
    if (!responsavel) return;
    const total = modo === 'tipo' ? (tipoState.resultado ? 1 : 0) : (1 + estado.detalhes_imgs.length);
    try {
      GLR.acoes.push({
        id: GLR.nextId(GLR.acoes),
        clienteId: null,
        data: new Date().toISOString().split('T')[0],
        categoria: 'Catálogo',
        descricao: `Gerador de Fotos: ${total} foto(s) geradas${estado.nome ? ' — ' + estado.nome : ''}`,
        responsavel,
        status: 'concluida',
      });
      localStorage.setItem('glr_acoes', JSON.stringify(GLR.acoes));
      alert('✅ Registrado no relatório do dia.');
    } catch (e) {}
  }

  function cardFoto(img, titulo) {
    return `
      <div style="text-align:center;">
        <img src="${img.url}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;border:1px solid var(--border);">
        <div style="font-size:11px;color:var(--text-muted);margin:6px 0 4px;">${titulo}</div>
        <a href="${img.url}" download="${titulo.replace(/\s+/g, '-').toLowerCase()}.png" target="_blank" class="btn btn-secondary btn-sm" style="width:100%;">⬇ Baixar</a>
      </div>`;
  }

  function renderDropzone() {
    return `
      <div id="foto-dropzone" ondragover="event.preventDefault();this.style.borderColor='#6366f1';" ondragleave="this.style.borderColor='var(--border)';"
           ondrop="event.preventDefault();this.style.borderColor='var(--border)';_fotoDrop(event);"
           onclick="document.getElementById('foto-file-input').click()"
           style="border:2px dashed var(--border);border-radius:16px;min-height:190px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;text-align:center;padding:20px;background:var(--bg-soft,#f7f8fc);transition:border-color .15s;">
        ${estado.refPreviewUrl
          ? `<img src="${estado.refPreviewUrl}" style="max-width:100%;max-height:150px;border-radius:10px;object-fit:contain;">
             <div style="font-size:11px;color:var(--text-muted);margin-top:10px;">Clique pra trocar a foto</div>`
          : `<div style="width:44px;height:44px;border-radius:50%;background:rgba(99,102,241,0.1);display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:10px;">📤</div>
             <div style="font-size:13px;font-weight:600;color:var(--text-primary);">Arraste ou clique pra enviar</div>
             <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Foto do produto original, em boa resolução</div>`}
        <input type="file" id="foto-file-input" accept="image/*" style="display:none;" onchange="_fotoUpload(this)">
      </div>`;
  }

  function renderModoTipo() {
    const t = templateAtual();
    return `
      <div class="form-group" style="margin-bottom:14px;">
        <label class="form-label">Tipo de foto</label>
        <select class="form-select" id="tipo-select" onchange="_fotoTrocarTipo(this.value)">
          ${_FOTO_TEMPLATES.map(tp => `<option value="${tp.id}" ${tp.id === tipoState.templateId ? 'selected' : ''}>${tp.nome}</option>`).join('')}
        </select>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${t.desc}</div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:14px;">
        ${t.campos.map(c => `
          <div class="form-group" style="margin:0;"><label class="form-label">${c.label}</label>
            <input type="text" class="form-input" id="tipo-campo-${c.key}" placeholder="${c.placeholder}" value="${(tipoState.campos[c.key] || '').replace(/"/g, '&quot;')}">
          </div>
        `).join('')}
      </div>

      <button class="btn btn-secondary" style="width:100%;" onclick="_fotoMontarPrompt()">📝 Montar Prompt</button>

      ${tipoState.promptMontado ? `
        <div class="form-group" style="margin-top:14px;">
          <label class="form-label">Prompt final — revise e edite antes de gerar</label>
          <textarea class="form-textarea" id="tipo-prompt" rows="4">${tipoState.prompt}</textarea>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Edita livremente — o que estiver aqui é exatamente o que vai pra IA. Confira antes de gerar pra não gastar crédito à toa.</div>
        </div>
        <button class="btn btn-primary" style="width:100%;padding:14px;font-size:14px;border-radius:12px;margin-top:10px;" ${(!estado.refBase64 || tipoState.gerando) ? 'disabled' : ''} onclick="_fotoGerarTipo()">
          ${tipoState.gerando ? '⏳ Gerando...' : '🎨 Gerar Foto'}
        </button>
      ` : ''}

      ${tipoState.resultado ? `
        <div style="max-width:320px;margin:20px auto 0;">${cardFoto(tipoState.resultado, t.nome.replace(/^\S+\s/, ''))}</div>
      ` : ''}
    `;
  }

  function renderModoKit() {
    return `
      <div class="form-group" style="margin:0 0 14px;">
        <label class="form-label" style="display:flex;justify-content:space-between;align-items:center;">
          Nome do Produto (opcional)
          <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px;" ${(!estado.refBase64 || estado.sugerindo) ? 'disabled' : ''} onclick="_fotoSugerir()">
            ${estado.sugerindo ? '⏳ Sugerindo...' : '✨ Sugerir com IA'}
          </button>
        </label>
        <input type="text" class="form-input" id="foto-nome" value="${(estado.nome || '').replace(/"/g, '&quot;')}" placeholder="Ex: Armário de Cozinha 2 Portas">
      </div>
      <div class="form-group" style="margin:0 0 14px;"><label class="form-label">Detalhes & instruções (opcional)</label>
        <textarea class="form-textarea" id="foto-detalhes" rows="3" placeholder="Cor, material, diferenciais, estilo de foto desejado...">${estado.detalhes || ''}</textarea>
      </div>

      <button class="btn btn-primary" style="width:100%;padding:14px;font-size:14px;border-radius:12px;" ${(!estado.refBase64 || estado.gerandoAmbientada) ? 'disabled' : ''} onclick="_fotoGerarAmbientada()">
        ${estado.gerandoAmbientada ? '⏳ Gerando...' : (estado.ambientada ? '🔄 Gerar outra foto ambientada' : '🎨 Gerar Foto Ambientada (1 foto)')}
      </button>
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:center;">Gera só a foto principal primeiro — os 2 close-ups de detalhe custam à parte e só valem a pena depois de aprovar essa.</div>

      ${estado.ambientada ? `
        <div style="margin-top:20px;">
          <div style="max-width:320px;margin:0 auto;">${cardFoto(estado.ambientada, 'Ambientada')}</div>
          <button class="btn btn-secondary" style="width:100%;margin-top:16px;" ${estado.gerandoDetalhes ? 'disabled' : ''} onclick="_fotoGerarDetalhes()">
            ${estado.gerandoDetalhes ? '⏳ Gerando detalhes...' : '🔍 Gerar 2 Fotos de Detalhe (a partir dessa)'}
          </button>
        </div>
      ` : ''}

      ${estado.errosDetalhes.length ? `<div style="font-size:11px;color:var(--red);margin-top:8px;">${estado.errosDetalhes.join(' · ')}</div>` : ''}

      ${estado.detalhes_imgs.length ? `
        <div style="display:grid;grid-template-columns:repeat(${estado.detalhes_imgs.length === 1 ? 1 : 2},1fr);gap:14px;margin-top:16px;max-width:480px;margin-left:auto;margin-right:auto;">
          ${estado.detalhes_imgs.map((im, i) => cardFoto(im, `Detalhe ${i + 1}`)).join('')}
        </div>
      ` : ''}
    `;
  }

  function temResultado() {
    return modo === 'tipo' ? !!tipoState.resultado : !!estado.ambientada;
  }

  function renderPainel() {
    const box = document.getElementById('foto-painel');
    if (!box) return;
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px;padding:26px;">
        <div style="text-align:center;margin-bottom:22px;">
          <div style="width:50px;height:50px;border-radius:14px;background:rgba(99,102,241,0.1);display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 10px;">🎨</div>
          <div style="font-size:17px;font-weight:800;color:var(--text-primary);">Gerador de Fotos</div>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;max-width:440px;margin-left:auto;margin-right:auto;">Envie uma foto de referência e gere fotos profissionais com IA. Sem publicar nada — baixe e use onde quiser.</div>
        </div>

        <div style="display:flex;gap:8px;margin-bottom:18px;">
          <button class="btn btn-sm ${modo === 'tipo' ? 'btn-primary' : 'btn-secondary'}" onclick="_fotoModo('tipo')">🎯 Por Tipo Específico</button>
          <button class="btn btn-sm ${modo === 'kit' ? 'btn-primary' : 'btn-secondary'}" onclick="_fotoModo('kit')">📦 Kit Automático (3 fotos)</button>
        </div>

        <div style="display:flex;gap:22px;flex-wrap:wrap;margin-bottom:18px;">
          <div style="flex:1;min-width:220px;">${renderDropzone()}</div>
          <div style="flex:1.3;min-width:260px;">${modo === 'tipo' ? renderModoTipo() : renderModoKit()}</div>
        </div>

        ${temResultado() ? `
          <div class="card" style="background:var(--accent-soft, rgba(99,102,241,0.06));margin-top:20px;">
            <div class="form-group" style="margin-bottom:12px;"><label class="form-label">Responsável</label>
              <select class="form-select" id="foto-resp">
                ${GLR.gestores.map(g => `<option>${g.nome}</option>`).join('')}
              </select>
            </div>
            <button class="btn btn-secondary" style="width:100%;" onclick="_fotoRegistrar()">✅ Registrar no relatório do dia</button>
          </div>
        ` : ''}
      </div>`;
  }

  el.innerHTML = `<div class="page">
    <div class="section-title mb-16">🎨 Gerador de Fotos</div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;max-width:640px;">
      Envie a foto de um produto e gere variações profissionais com IA. Sem publicar nada — baixe e use onde quiser.
    </div>
    <div id="foto-painel"></div>
  </div>`;

  window._fotoUpload = (input) => processarArquivo(input.files?.[0]);
  window._fotoDrop = (ev) => processarArquivo(ev.dataTransfer?.files?.[0]);
  window._fotoSugerir = sugerirComIA;
  window._fotoGerarAmbientada = gerarAmbientada;
  window._fotoGerarDetalhes = gerarDetalhes;
  window._fotoRegistrar = registrarAcao;
  window._fotoModo = (m) => { modo = m; renderPainel(); };
  window._fotoTrocarTipo = (id) => { tipoState.templateId = id; tipoState.campos = {}; tipoState.prompt = ''; tipoState.promptMontado = false; tipoState.resultado = null; renderPainel(); };
  window._fotoMontarPrompt = montarPrompt;
  window._fotoGerarTipo = gerarPorTipo;

  function render() { renderPainel(); }
  render();
});
