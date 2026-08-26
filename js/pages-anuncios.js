// ============================================================
// GLR Consultoria — Central de Anúncios (analistas criam título,
// descrição e fotos novas com IA, e publicam direto no Mercado Livre)
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

  let contas = null;          // contas ML carregadas de list_accounts
  let contaSel = null;        // conta escolhida
  let itemAtual = null;       // resultado de get_item
  let fotosAtuais = [];       // pictures do anúncio atual
  let resultadosBusca = [];

  // Cada slot: { refUrl, prompt, gerando, geradas:[{url,job_id}], escolhidaIdx, publicado }
  const slotPrincipal = { refUrl: '', prompt: '', gerando: false, geradas: [], escolhidaIdx: 0, publicado: false };
  const slotDetalhe   = { refUrl: '', prompt: '', gerando: false, geradas: [], escolhidaIdx: 0, publicado: false };

  function resetSlots() {
    slotPrincipal.refUrl = ''; slotPrincipal.prompt = ''; slotPrincipal.geradas = []; slotPrincipal.escolhidaIdx = 0; slotPrincipal.publicado = false;
    slotDetalhe.refUrl = '';   slotDetalhe.prompt = '';   slotDetalhe.geradas = [];   slotDetalhe.escolhidaIdx = 0;   slotDetalhe.publicado = false;
  }
  function resetItem() {
    itemAtual = null; fotosAtuais = [];
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

  // ── Extrai job_id e imagens geradas de forma tolerante ao formato de resposta ──
  function extrairGeracoes(resp) {
    const d = resp?.data || resp || {};
    const jobId = d.job_id || d.id || resp?.job_id || null;
    let imgs = d.images || d.variations || d.photos || d.results || [];
    if (!Array.isArray(imgs)) imgs = [];
    imgs = imgs.map(x => (typeof x === 'string' ? { url: x } : { url: x.url || x.secure_url || x.image_url || x.data || '' }));
    if (!imgs.length && (d.url || d.image_url)) imgs = [{ url: d.url || d.image_url }];
    return { jobId, imgs, raw: resp };
  }

  async function gerarFoto(slot, refInput) {
    const promptEl = document.getElementById(refInput + '-prompt');
    slot.prompt = promptEl?.value || '';
    if (!slot.refUrl) { alert('Escolha a foto de referência antes de gerar.'); return; }
    slot.gerando = true; slot.geradas = []; slot.escolhidaIdx = 0;
    renderPainel();
    try {
      const r = await MarketplaceAPI.call('photo_generate', {
        item_id: itemAtual.id,
        meliUserId: meliIdDaConta(contaSel),
        marketplace: 'mercadolivre',
        image_url: slot.refUrl,
        ad_title: itemAtual.title,
        prompt: slot.prompt,
        photo_count: 3,
      });
      const { jobId, imgs, raw } = extrairGeracoes(r);
      slot.jobId = jobId;
      slot.geradas = imgs;
      slot._raw = raw;
      if (!imgs.length) {
        alert('A geração respondeu, mas não veio nenhuma imagem no formato esperado. Veja o JSON bruto no painel (modo debug) pra eu ajustar a leitura do resultado.');
      }
    } catch (e) {
      alert('Erro ao gerar foto: ' + (e.message || e));
    } finally {
      slot.gerando = false;
      renderPainel();
    }
  }

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
      // descrição vem de endpoint separado
      try {
        const rd = await MarketplaceAPI.call('get_description', { item_id: itemId, meliUserId: meliIdDaConta(contaSel) });
        itemAtual._descricaoAtual = rd.data?.plain_text || rd.data?.text || '';
      } catch (e) { itemAtual._descricaoAtual = ''; }
    } catch (e) {
      alert('Erro ao carregar anúncio: ' + (e.message || e));
    }
    renderTudo();
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
        ${slot.geradas.length ? `
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            ${slot.geradas.map((g, i) => `
              <img src="${g.url}" onclick="_anunEscolher('${id}', ${i})"
                style="width:64px;height:64px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid ${i === slot.escolhidaIdx ? '#6366f1' : 'transparent'};">
            `).join('')}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">✅ Variação ${slot.escolhidaIdx + 1} selecionada — será publicada ao confirmar.</div>
        ` : slot.gerando ? '' : (slot._raw ? `<div style="font-size:11px;color:var(--red);margin-top:8px;">Sem imagens reconhecidas na resposta. <a href="javascript:void(0)" onclick="console.log(${JSON.stringify(JSON.stringify(slot._raw))})">ver no console</a></div>` : '')}
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

  function renderTudo() {
    renderResultados();
    renderPainel();
  }

  el.innerHTML = `<div class="page">
    <div class="section-title mb-16">🎨 Central de Anúncios</div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;max-width:640px;">
      Crie título, descrição e fotos novas (geradas por IA a partir da foto atual) e publique direto no anúncio do Mercado Livre.
    </div>

    ${!apiKey ? `<div class="card" style="border-color:var(--red);"><div style="color:var(--red);font-size:13px;">⚠️ Configure a API Key nas Integrações antes de usar esta página.</div></div>` : `

    <div class="card" style="margin-bottom:16px;">
      <div class="form-group"><label class="form-label">Loja (conta Mercado Livre)</label>
        <select class="form-select" id="anun-conta"><option value="">Carregando lojas...</option></select>
      </div>
      <div style="display:flex;gap:8px;">
        <input type="text" class="form-input" id="anun-busca" placeholder="Buscar anúncio por título ou SKU..." style="flex:1;">
        <button class="btn btn-primary" id="anun-btn-buscar" disabled onclick="_anunBuscar()">🔍 Buscar</button>
      </div>
      <div id="anun-busca-status" style="font-size:12px;color:var(--text-muted);margin-top:8px;"></div>
    </div>

    <div id="anun-resultados" style="margin-bottom:16px;"></div>
    <div id="anun-painel"></div>
    `}
  </div>`;

  if (apiKey) {
    carregarContas().then(() => {
      const sel = document.getElementById('anun-conta');
      const btn = document.getElementById('anun-btn-buscar');
      if (!contas.length) {
        sel.innerHTML = '<option value="">Nenhuma loja ML conectada</option>';
        return;
      }
      sel.innerHTML = '<option value="">Selecione a loja...</option>' + contas.map((c, i) => `<option value="${i}">${nomeDaConta(c)}</option>`).join('');
      sel.addEventListener('change', () => {
        contaSel = sel.value !== '' ? contas[sel.value] : null;
        if (btn) btn.disabled = !contaSel;
        resultadosBusca = []; resetItem(); renderTudo();
      });
    }).catch(e => {
      const sel = document.getElementById('anun-conta');
      if (sel) sel.innerHTML = '<option value="">Erro ao carregar lojas</option>';
    });
  }

  window._anunBuscar = buscarAnuncios;
  window._anunSelecionar = selecionarItem;
  window._anunGerar = (id) => gerarFoto(id === 'principal' ? slotPrincipal : slotDetalhe, id);
  window._anunSlotRef = (id, url) => { (id === 'principal' ? slotPrincipal : slotDetalhe).refUrl = url; renderPainel(); };
  window._anunEscolher = (id, idx) => { (id === 'principal' ? slotPrincipal : slotDetalhe).escolhidaIdx = idx; renderPainel(); };

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
      if (publicaPrincipal) {
        const escolhida = slotPrincipal.geradas[slotPrincipal.escolhidaIdx];
        await MarketplaceAPI.call('photo_publish', { job_id: slotPrincipal.jobId, meliUserId, image_data: escolhida?.url });
      }
    } catch (e) { erros.push('Foto principal: ' + (e.message || e)); }
    try {
      if (publicaDetalhe) {
        const escolhida = slotDetalhe.geradas[slotDetalhe.escolhidaIdx];
        await MarketplaceAPI.call('photo_publish', { job_id: slotDetalhe.jobId, meliUserId, image_data: escolhida?.url });
      }
    } catch (e) { erros.push('Foto de detalhe: ' + (e.message || e)); }

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
    renderTudo();
  };
});
