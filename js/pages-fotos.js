// ============================================================
// GLR Consultoria — Gerador de Fotos (analistas geram fotos de produto com
// IA a partir de uma foto de referência; não publica nada, só gera e baixa)
// ============================================================

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

  const estado = {
    refBase64: '', refPreviewUrl: '',
    nome: '', detalhes: '', sugerindo: false,
    gerandoAmbientada: false, ambientada: null,      // { url }
    gerandoDetalhes: false, detalhes_imgs: [], errosDetalhes: [],
  };

  function resetTudo() {
    estado.refBase64 = ''; estado.refPreviewUrl = '';
    estado.nome = ''; estado.detalhes = ''; estado.sugerindo = false;
    estado.gerandoAmbientada = false; estado.ambientada = null;
    estado.gerandoDetalhes = false; estado.detalhes_imgs = []; estado.errosDetalhes = [];
  }

  function processarArquivo(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      estado.refPreviewUrl = String(reader.result || '');
      estado.refBase64 = estado.refPreviewUrl;
      estado.ambientada = null; estado.detalhes_imgs = []; estado.errosDetalhes = [];
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

  function registrarAcao() {
    const responsavel = document.getElementById('foto-resp')?.value;
    if (!responsavel) return;
    const total = 1 + estado.detalhes_imgs.length;
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

  function render() {
    const box = document.getElementById('foto-painel');
    if (!box) return;
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px;padding:26px;">
        <div style="text-align:center;margin-bottom:22px;">
          <div style="width:50px;height:50px;border-radius:14px;background:rgba(99,102,241,0.1);display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 10px;">🎨</div>
          <div style="font-size:17px;font-weight:800;color:var(--text-primary);">Gerador de Fotos</div>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;max-width:440px;margin-left:auto;margin-right:auto;">Envie uma foto de referência e gere fotos profissionais com IA. Sem publicar nada — baixe e use onde quiser.</div>
        </div>

        <div style="display:flex;gap:22px;flex-wrap:wrap;margin-bottom:18px;">
          <div style="flex:1;min-width:220px;">
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
            </div>
          </div>
          <div style="flex:1.3;min-width:260px;display:flex;flex-direction:column;gap:14px;">
            <div class="form-group" style="margin:0;">
              <label class="form-label" style="display:flex;justify-content:space-between;align-items:center;">
                Nome do Produto (opcional)
                <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px;" ${(!estado.refBase64 || estado.sugerindo) ? 'disabled' : ''} onclick="_fotoSugerir()">
                  ${estado.sugerindo ? '⏳ Sugerindo...' : '✨ Sugerir com IA'}
                </button>
              </label>
              <input type="text" class="form-input" id="foto-nome" value="${(estado.nome || '').replace(/"/g, '&quot;')}" placeholder="Ex: Armário de Cozinha 2 Portas">
            </div>
            <div class="form-group" style="margin:0;"><label class="form-label">Detalhes & instruções (opcional)</label>
              <textarea class="form-textarea" id="foto-detalhes" rows="3" placeholder="Cor, material, diferenciais, estilo de foto desejado...">${estado.detalhes || ''}</textarea>
            </div>
          </div>
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

        ${(estado.ambientada) ? `
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
      Envie a foto de um produto e gere variações profissionais com IA — foto ambientada e close-ups de detalhe. Baixe e use onde quiser.
    </div>
    <div id="foto-painel"></div>
  </div>`;

  window._fotoUpload = (input) => processarArquivo(input.files?.[0]);
  window._fotoDrop = (ev) => processarArquivo(ev.dataTransfer?.files?.[0]);
  window._fotoSugerir = sugerirComIA;
  window._fotoGerarAmbientada = gerarAmbientada;
  window._fotoGerarDetalhes = gerarDetalhes;
  window._fotoRegistrar = registrarAcao;

  render();
});
