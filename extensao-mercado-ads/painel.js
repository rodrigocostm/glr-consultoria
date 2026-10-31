// ============================================================
// GLR Copiloto Mercado Ads — painel dentro do Mercado Ads
// ------------------------------------------------------------
// Mostra no canto da tela o pacote do dia da GLR para a campanha aberta (ou
// para as campanhas da lista) e ajuda a aplicar: abre a edição, PREENCHE o
// valor e DESTACA onde clicar. Nunca clica em Salvar — quem confirma no ML é
// sempre o analista (modo copiloto). "Feito" marca o passo no sistema da GLR.
// Tela mapeada em 30/10/2026 (Central de vendedores → Publicidade → Product Ads).
// ============================================================
(function () {
  if (window.__glrCopiloto) return;
  window.__glrCopiloto = true;

  const enviar = m => new Promise(r => { try { chrome.runtime.sendMessage(m, x => r(x || { ok: false, erro: chrome.runtime.lastError?.message })); } catch (e) { r({ ok: false, erro: String(e) }); } });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const espera = ms => new Promise(r => setTimeout(r, ms));
  const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const xv = v => v ? `${String(Math.round(v * 10) / 10).replace('.', ',')}x` : '—';
  const pct = v => v == null ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')}%`;

  // ── Tela do ML ──
  const campanhaAberta = () => (location.pathname.match(/\/campaigns\/(\d+)\//) || [])[1] || null;
  const campanhasDaLista = () => [...new Set([...document.querySelectorAll('a[href*="/campaigns/"]')].map(a => (a.getAttribute('href').match(/\/campaigns\/(\d+)\/dashboard/) || [])[1]).filter(Boolean))];
  const textoIgual = (sel, txt, raiz = document) => [...raiz.querySelectorAll(sel)].find(e => e.textContent.trim() === txt);
  // input controlado pelo React do ML: muda o valor pelo setter nativo e avisa a página
  function digitar(el, valor) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(valor));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  let destacados = [];
  function destacar(el, rotulo) {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.style.setProperty('outline', '3px solid #7c3aed', 'important');
    el.style.setProperty('outline-offset', '3px', 'important');
    el.style.setProperty('box-shadow', '0 0 0 6px rgba(124,58,237,.18)', 'important');
    if (rotulo) el.setAttribute('title', rotulo);
    destacados.push(el);
    return true;
  }
  function limparDestaques() { destacados.forEach(el => { el.style.removeProperty('outline'); el.style.removeProperty('outline-offset'); el.style.removeProperty('box-shadow'); }); destacados = []; }
  async function aguardar(fn, ms = 6000) { const fim = Date.now() + ms; while (Date.now() < fim) { const r = fn(); if (r) return r; await espera(200); } return null; }
  const gaveta = () => { const t = textoIgual('h1,h2,h3,span,div,p', 'Modificar sua campanha'); let g = t; for (let i = 0; i < 10 && g && !(g.querySelectorAll && [...g.querySelectorAll('button')].some(b => b.textContent.trim() === 'Salvar')); i++) g = g.parentElement; return g; };
  // botão "Editar" (lápis) do cartão de ROAS ou de orçamento no topo da campanha
  function lapisDoCartao(titulo) {
    const rot = [...document.querySelectorAll('span,div,p,h3,h4')].find(e => e.childElementCount <= 2 && e.textContent.trim().startsWith(titulo) && e.textContent.trim().length < 40);
    let c = rot; for (let i = 0; i < 6 && c; i++) { const b = c.querySelector && c.querySelector('button[aria-label="Editar"]'); if (b) return b; c = c.parentElement; }
    return null;
  }

  // ── Ajudantes por tipo de passo (preenche e destaca; não salva) ──
  async function abrirGaveta(titulo) {
    if (gaveta()) return gaveta();
    const b = lapisDoCartao(titulo); if (!b) return null;
    b.click();
    return aguardar(() => { const g = gaveta(); return g && g.querySelector('input') ? g : null; });
  }
  async function preencherRoas(valor) {
    const g = await abrirGaveta('ROAS Objetivo'); if (!g) return 'Não achei o botão de editar o ROAS objetivo nesta tela.';
    const fixo = g.querySelector('input[type="radio"][value="fixed"]'); if (fixo && !fixo.checked) { fixo.click(); await espera(500); }
    const outro = await aguardar(() => g.querySelector('input[type="radio"][value="-1"]'), 3000); if (outro && !outro.checked) { outro.click(); await espera(300); }
    const campo = await aguardar(() => g.querySelector('input[type="number"]'), 3000); if (!campo) return 'Não achei o campo do ROAS objetivo.';
    digitar(campo, String(valor).replace(',', '.'));
    destacar(campo, 'Valor preenchido pela GLR');
    destacar(textoIgual('button', 'Salvar', g), 'Confira e clique em Salvar');
    return null;
  }
  async function preencherOrcamento(valor) {
    const g = await abrirGaveta('Orçamento diário'); if (!g) return 'Não achei o botão de editar o orçamento nesta tela.';
    let campo = g.querySelector('input[aria-label="Orçamento diário"]');
    if (!campo) { textoIgual('button', 'Orçamento diário', g)?.click(); campo = await aguardar(() => g.querySelector('input[aria-label="Orçamento diário"]'), 3000); }
    const fixo = g.querySelector('input[type="radio"][aria-label="Orçamento fixo"]'); if (fixo && !fixo.checked) { fixo.click(); await espera(400); campo = g.querySelector('input[aria-label="Orçamento diário"]') || campo; }
    if (!campo) return 'Não achei o campo do orçamento diário.';
    digitar(campo, String(Math.round(valor * 100) / 100).replace('.', ','));
    destacar(campo, 'Valor preenchido pela GLR');
    destacar(textoIgual('button', 'Salvar', g), 'Confira e clique em Salvar');
    return null;
  }
  // filtra a tabela de anúncios pelo código e destaca a linha e o menu ⋮ (Pausar / Remover da campanha)
  async function mostrarAnuncio(itemId) {
    const busca = document.querySelector('input[placeholder^="Procurar por #"]');
    if (busca) { digitar(busca, itemId); busca.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); await espera(1500); }
    const num = String(itemId).replace(/^MLB/i, '');
    const linha = await aguardar(() => [...document.querySelectorAll('table tbody tr')].find(tr => tr.innerText.includes(num)), 5000);
    if (!linha) return `Não achei o anúncio ${itemId} nesta campanha (pode já ter sido pausado).`;
    destacar(linha);
    destacar(linha.querySelector('button[aria-label="Acciones del anuncio"]'), 'Clique aqui → Pausar');
    return null;
  }
  async function mostrarAdicionar(ids) {
    try { await navigator.clipboard.writeText(ids.join(', ')); } catch (e) {}
    const b = textoIgual('button', 'Adicionar anúncios') || textoIgual('a', 'Adicionar') || textoIgual('button', 'Adicionar');
    return destacar(b, 'Clique aqui e cole os códigos') ? null : 'Não achei o botão "Adicionar anúncios" nesta tela.';
  }
  function mostrarEstado() {
    const t = textoIgual('span,div,p', 'Estado:');
    const sw = t ? t.parentElement.querySelector('input[type="checkbox"],button[role="switch"],[class*="switch"]') : null;
    return destacar(sw || t, 'Desligue aqui para pausar a campanha') ? null : 'Não achei o controle de estado da campanha.';
  }

  // ── Modo automático, no ritmo de uma pessoa: aplica sozinho ROAS, orçamento e pausa de anúncio,
  //    confere cada passo na tela e para no primeiro imprevisto. Mover/colocar produto e pausar
  //    campanha continuam à mão (mover pela metade deixaria o produto pausado e fora do ADS).
  const AUTO = new Set(['roas_target', 'orcamento', 'retirar_produto']);
  const MAX_AUTO = 8, FILA = 'glr_fila_auto';
  const humano = (a = 4000, b = 9000) => espera(a + Math.random() * (b - a));
  async function digitarDevagar(el, valor) {
    el.focus(); digitar(el, ''); await espera(300);
    let atual = '';
    for (const ch of String(valor)) { atual += ch; digitar(el, atual); await espera(90 + Math.random() * 140); }
  }
  // valor que o cartão da campanha mostra depois de salvar (ex.: "ROAS Objetivo 17,6x", "Orçamento diário R$ 500")
  function valorDoCartao(titulo) {
    let c = lapisDoCartao(titulo); for (let i = 0; i < 4 && c; i++) c = c.parentElement;
    const t = (c?.innerText || '').split(titulo)[1] || '';
    const m = t.match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/);
    return m ? parseFloat(m[0].replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) : null;
  }
  async function salvarGaveta() {
    const g = gaveta(), b = g && textoIgual('button', 'Salvar', g); if (!b) return 'Não achei o botão Salvar.';
    await humano(1500, 3500); b.click();
    if (!(await aguardar(() => !gaveta(), 8000))) return 'Cliquei em Salvar, mas a edição não fechou — o ML pode ter mostrado um aviso. Confira a tela.';
    await espera(2500); return null;
  }
  async function autoRoas(valor) {
    const g = await abrirGaveta('ROAS Objetivo'); if (!g) return 'Não achei a edição do ROAS objetivo.';
    await humano(1200, 2500);
    const fixo = g.querySelector('input[type="radio"][value="fixed"]'); if (fixo && !fixo.checked) { fixo.click(); await humano(800, 1600); }
    const outro = await aguardar(() => g.querySelector('input[type="radio"][value="-1"]'), 3000); if (outro && !outro.checked) { outro.click(); await humano(600, 1200); }
    const campo = await aguardar(() => g.querySelector('input[type="number"]'), 3000); if (!campo) return 'Não achei o campo do ROAS objetivo.';
    await digitarDevagar(campo, String(valor));
    const e = await salvarGaveta(); if (e) return e;
    const lido = valorDoCartao('ROAS Objetivo');
    return lido != null && Math.abs(lido - valor) < 0.06 ? null : `Salvei, mas o cartão mostra ${lido ?? '?'}x em vez de ${xv(valor)} — confira.`;
  }
  async function autoOrcamento(valor) {
    const g = await abrirGaveta('Orçamento diário'); if (!g) return 'Não achei a edição do orçamento.';
    await humano(1200, 2500);
    if (!g.querySelector('input[aria-label="Orçamento diário"]')) { textoIgual('button', 'Orçamento diário', g)?.click(); await humano(800, 1500); }
    const fixo = g.querySelector('input[type="radio"][aria-label="Orçamento fixo"]'); if (fixo && !fixo.checked) { fixo.click(); await humano(800, 1500); }
    const campo = await aguardar(() => g.querySelector('input[aria-label="Orçamento diário"]'), 3000); if (!campo) return 'Não achei o campo do orçamento diário.';
    await digitarDevagar(campo, String(Math.round(valor * 100) / 100).replace('.', ','));
    const e = await salvarGaveta(); if (e) return e;
    const lido = valorDoCartao('Orçamento diário');
    return lido != null && Math.abs(lido - valor) < 0.6 ? null : `Salvei, mas o cartão mostra R$ ${lido ?? '?'} em vez de ${R$(valor)} — confira.`;
  }
  async function autoPausarAnuncio(itemId) {
    const e = await mostrarAnuncio(itemId); if (e) return e;
    const num = String(itemId).replace(/^MLB/i, '');
    const linhaDe = () => [...document.querySelectorAll('table tbody tr')].find(tr => tr.innerText.includes(num));
    const menu = linhaDe()?.querySelector('button[aria-label="Acciones del anuncio"]'); if (!menu) return 'Não achei o menu ⋮ do anúncio.';
    await humano(1500, 3000); menu.click();
    const pausar = await aguardar(() => [...document.querySelectorAll('li,button,a,span,[role="menuitem"]')].find(x => x.textContent.trim() === 'Pausar' && x.offsetParent !== null), 4000);
    if (!pausar) return 'Não achei a opção Pausar no menu do anúncio.';
    await humano(800, 1800); pausar.click();
    await espera(2500);
    if ([...document.querySelectorAll('[role="dialog"]')].some(d => d.offsetParent !== null && /pausar|confirm/i.test(d.innerText))) return 'O ML pediu uma confirmação para pausar — confirme à mão e marque Feito.';
    return (await aguardar(() => /paus/i.test(linhaDe()?.innerText || ''), 6000)) ? null : 'Cliquei em Pausar, mas não vi o anúncio como pausado — confira.';
  }
  const lerFila = async () => (await chrome.storage.local.get(FILA))[FILA] || null;
  const gravarFila = f => chrome.storage.local.set({ [FILA]: f });
  async function iniciarAuto() {
    const adv = new URLSearchParams(location.search).get('advertiser_id') || '';
    const chaveRisco = `glr_risco_${adv || 'sem_anunciante'}`;
    if (!(await chrome.storage.local.get(chaveRisco))[chaveRisco]) {
      if (!confirm('O Mercado Livre não permite alterar o ADS por automação. Se ele detectar, este anunciante pode ter a publicidade restringida.\n\nA extensão vai aplicar sozinha, no ritmo de uma pessoa, conferindo cada passo e parando no primeiro imprevisto.\n\nVocê assume esse risco para esta conta?')) return;
      await chrome.storage.local.set({ [chaveRisco]: new Date().toISOString() });
    }
    const passos = st.itens.filter(l => AUTO.has(l.dados?.acao)).sort((a, b) => String(a.dados.campaign_id).localeCompare(String(b.dados.campaign_id))).slice(0, MAX_AUTO).map(l => ({ id: l.id, dados: l.dados }));
    if (!passos.length) return;
    await gravarFila({ adv, passos, i: 0, status: 'rodando', inicio: Date.now() });
    rodar();
  }
  let rodando = false;
  async function rodar() {
    if (rodando) return; rodando = true;
    try {
      let f = await lerFila();
      while (f && f.status === 'rodando' && f.i < f.passos.length) {
        const p = f.passos[f.i], d = p.dados;
        st.auto = f; render();
        if (String(d.campaign_id) !== campanhaAberta()) { await humano(2000, 4000); location.href = `/publicidade/product-ads/admin/campaigns/${d.campaign_id}/dashboard${f.adv ? `?advertiser_id=${f.adv}` : ''}`; return; }
        await aguardar(() => lapisDoCartao('ROAS Objetivo'), 15000); await humano(2500, 5000);
        let erro = null;
        if (d.acao === 'roas_target') erro = await autoRoas(+d.para);
        else if (d.acao === 'orcamento') erro = await autoOrcamento(+d.para);
        else if (d.acao === 'retirar_produto') for (const id of (d.item_ids || [])) { erro = await autoPausarAnuncio(id); if (erro) break; await humano(); }
        f = await lerFila(); if (!f || f.status !== 'rodando') break; // parado no meio pelo analista
        if (erro) { f.status = 'parado'; f.erro = `Passo ${f.i + 1}: ${erro}`; await gravarFila(f); break; }
        await enviar({ tipo: 'marcar', id: p.id, resultado: 'executado', dados: d, por: 'extensao_auto' });
        st.itens = st.itens.filter(x => x.id !== p.id);
        f.i++; if (f.i >= f.passos.length) f.status = 'concluido';
        await gravarFila(f); limparDestaques(); await humano();
      }
      st.auto = await lerFila(); render();
    } finally { rodando = false; }
  }
  async function pararAuto() { const f = await lerFila(); if (f) { f.status = 'parado'; f.erro = f.erro || 'Parado por você.'; await gravarFila(f); } st.auto = f; render(); }

  // ── Painel ──
  const host = document.createElement('div');
  host.id = 'glr-copiloto';
  const raiz = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);
  const st = { itens: [], aberto: true, carregando: true, erro: null, msg: {}, chave: '' };

  const ACAO = {
    roas_target: d => `${+d.para > +d.de ? 'Subir' : 'Baixar'} o ROAS objetivo de ${xv(d.de)} para <b>${xv(d.para)}</b>`,
    orcamento: d => `${+d.para > +d.de ? 'Aumentar' : 'Reduzir'} o orçamento diário para <b>${R$(d.para)}</b>`,
    retirar_produto: d => `Pausar o anúncio <b>${esc(String(d.produto || '').slice(0, 60))}</b>`,
    mover_produto: d => `Mover <b>${esc(String(d.produto || '').slice(0, 60))}</b> para <b>${esc(d.destino || 'campanha nova')}</b>`,
    adicionar_produto: d => `Colocar <b>${esc(String(d.produto || '').slice(0, 60))}</b> nesta campanha`,
    pausar: () => 'Pausar esta campanha',
    informativa: () => 'Melhorar os anúncios desta campanha',
  };
  const PQ = d => d.acao === 'roas_target' || d.acao === 'orcamento' ? `ACOS da campanha ${pct(d.acos)}${d.share ? ` · perde ${Math.round((d.acao === 'orcamento' ? d.share.orcamento : d.share.classificacao) * 100)}% das impressões por ${d.acao === 'orcamento' ? 'orçamento' : 'classificação'}` : ''}`
    : d.acao === 'retirar_produto' ? `gastou ${R$(d.gasto)}${d.janela_dias ? ` em ${d.janela_dias} dias` : ''} ${d.unidades ? `e vendeu ${d.unidades} un.` : 'sem venda pelo ADS'}`
    : d.acao === 'mover_produto' ? `ACOS ${pct(d.acos)} · gastou ${R$(d.gasto)}` : '';
  const impacto = d => !d.impacto ? '' : `<span class="imp ${d.impacto_tipo === 'economia' ? 'eco' : ''}">${d.impacto_tipo === 'economia' ? '−' : '+'}${R$(d.impacto)}/sem</span>`;

  // o que o botão de ajuda faz em cada passo, na campanha aberta
  function ajudaDe(l, aqui) {
    const d = l.dados || {}, origem = String(d.campaign_id) === aqui, destino = String(d.destino_id) === aqui;
    if (d.acao === 'roas_target' && origem) return { rot: 'Preencher o ROAS', fn: () => preencherRoas(d.para) };
    if (d.acao === 'orcamento' && origem) return { rot: 'Preencher o orçamento', fn: () => preencherOrcamento(d.para) };
    if ((d.acao === 'retirar_produto' || d.acao === 'mover_produto') && origem && (d.item_ids || []).length) return { rot: 'Mostrar o anúncio', fn: async () => { for (const id of d.item_ids) { if (!(await mostrarAnuncio(id))) return null; } return 'Nenhum dos anúncios apareceu na tabela desta campanha.'; } };
    if ((d.acao === 'adicionar_produto' || d.acao === 'mover_produto') && destino && (d.item_ids || []).length) return { rot: 'Adicionar aqui (copia os códigos)', fn: () => mostrarAdicionar(d.item_ids) };
    if (d.acao === 'pausar' && origem) return { rot: 'Mostrar onde pausar', fn: () => mostrarEstado() };
    return null;
  }
  const comoFazer = (d, aqui) => {
    if (d.acao === 'roas_target' || d.acao === 'orcamento') return 'Clique em <b>Preencher</b>, confira o valor destacado e clique em <b>Salvar</b> no ML.';
    if (d.acao === 'retirar_produto') return 'Clique em <b>Mostrar o anúncio</b>, depois no <b>⋮</b> destacado → <b>Pausar</b>.';
    if (d.acao === 'mover_produto') return String(d.destino_id) === aqui ? 'Clique em <b>Adicionar aqui</b> (os códigos vão para a área de transferência) e cole em <b>Adicionar anúncios</b>.' : `Pause o anúncio aqui (<b>⋮ → Pausar</b>) e depois abra a campanha <b>${esc(d.destino || 'de destino')}</b> para adicionar.`;
    if (d.acao === 'adicionar_produto') return 'Clique em <b>Adicionar aqui</b> e cole os códigos em <b>Adicionar anúncios</b>.';
    if (d.acao === 'pausar') return 'Desligue o <b>Estado</b> da campanha (destacado).';
    return 'Revise os anúncios desta campanha (fotos, título, ficha, frete e buy box).';
  };

  function render() {
    const aqui = campanhaAberta();
    const lista = st.itens;
    const corpo = st.erro === 'SEM_LOGIN'
      ? '<div class="vazio">Entre com o seu login da GLR: clique no ícone da extensão <b>GLR Copiloto</b> na barra do Chrome.</div>'
      : st.erro ? `<div class="vazio erro">${esc(st.erro)}</div>`
      : st.carregando ? '<div class="vazio">Buscando o pacote do dia…</div>'
      : !lista.length ? `<div class="vazio">Nada pendente ${aqui ? 'para esta campanha' : 'para as campanhas desta tela'}. ✓</div>`
      : lista.map((l, i) => {
          const d = l.dados || {}, aj = aqui ? ajudaDe(l, aqui) : null, m = st.msg[l.id];
          return `<div class="passo">
            <div class="topo"><span class="n">${i + 1}</span><div class="acao">${(ACAO[d.acao] || (() => esc(l.titulo)))(d)}</div>${impacto(d)}</div>
            ${PQ(d) ? `<div class="pq">${PQ(d)}</div>` : ''}
            ${aqui ? `<div class="como">${comoFazer(d, aqui)}</div>` : `<div class="pq">Campanha: <b>${esc(d.campanha || '—')}</b></div>`}
            ${m ? `<div class="msg ${m.erro ? 'erro' : ''}">${esc(m.texto)}</div>` : ''}
            <div class="bts">
              ${!aqui && d.campaign_id ? `<button class="pri" data-abrir="${esc(d.campaign_id)}">Abrir a campanha</button>` : ''}
              ${aj ? `<button class="pri" data-ajuda="${esc(l.id)}">${esc(aj.rot)}</button>` : ''}
              <button data-feito="${esc(l.id)}">Feito</button>
              <button class="x" data-desc="${esc(l.id)}" title="Descartar">✕</button>
            </div>
          </div>`;
        }).join('');
    const f = st.auto, nAuto = lista.filter(l => AUTO.has(l.dados?.acao)).length;
    const barra = f && f.status === 'rodando' ? `<div class="auto on">Aplicando sozinho, no ritmo de uma pessoa: passo <b>${Math.min(f.i + 1, f.passos.length)} de ${f.passos.length}</b>. Não feche esta aba. <button class="x" data-auto-parar="1">Parar</button></div>`
      : f && f.status === 'parado' ? `<div class="auto erro">Parou: ${esc(f.erro || '')} (${f.i} de ${f.passos.length} aplicados) <button data-auto-fechar="1">Ok</button></div>`
      : f && f.status === 'concluido' ? `<div class="auto ok">${f.passos.length} passo(s) aplicados e conferidos ✓ <button data-auto-fechar="1">Ok</button></div>`
      : nAuto && !st.erro ? `<div class="auto"><button class="pri" data-auto-iniciar="1">Aplicar ${Math.min(nAuto, MAX_AUTO)} passo(s) sozinho</button><span>ROAS, orçamento e pausar anúncio · ritmo humano · para no primeiro imprevisto${lista.length > nAuto ? ' · mover/colocar produto ficam à mão' : ''}</span></div>` : '';
    raiz.innerHTML = `<style>
      .auto{margin:0 0 4px;padding:8px 10px;border-radius:10px;background:#f4f2ff;font-size:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;color:#2b2f3c} .auto span{color:#5b6070}
      .auto.on{background:#fff7e6} .auto.erro{background:#fdecea;color:#8a1f12} .auto.ok{background:#eefaf2;color:#1b6b3a}
      :host{all:initial}
      .p{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:360px;max-height:70vh;display:flex;flex-direction:column;background:#fff;color:#1f2330;border:1px solid #e1e3ea;border-radius:14px;box-shadow:0 12px 32px rgba(20,24,40,.18);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .p.min{width:auto;max-height:none}
      .cab{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eef0f4;cursor:pointer}
      .cab b{font-size:13px} .cab .q{margin-left:auto;font-size:11px;background:#5b4ff0;color:#fff;border-radius:99px;padding:1px 8px}
      .p.min .cab{border-bottom:0}
      .lista{overflow:auto;padding:8px 10px 10px;display:flex;flex-direction:column;gap:8px}
      .passo{border:1px solid #eceef3;border-radius:10px;padding:9px 10px}
      .topo{display:flex;gap:8px;align-items:flex-start} .n{flex-shrink:0;width:20px;height:20px;border-radius:50%;background:#f1f2f6;font-size:11px;font-weight:700;display:grid;place-items:center}
      .acao{flex:1;font-size:13px} .imp{font-weight:700;color:#5b4ff0;white-space:nowrap;font-size:12px} .imp.eco{color:#1b8a4b}
      .pq{color:#5b6070;font-size:12px;margin:3px 0 0 28px} .como{font-size:12px;margin:5px 0 0 28px;color:#2b2f3c}
      .msg{font-size:12px;margin:6px 0 0 28px;color:#1b6b3a} .msg.erro,.vazio.erro{color:#c0392b}
      .bts{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 0 28px}
      button{font:inherit;font-size:12px;border:1px solid #d6d9e2;background:#fff;border-radius:8px;padding:5px 10px;cursor:pointer;color:#1f2330}
      button.pri{background:#5b4ff0;border-color:#5b4ff0;color:#fff;font-weight:600} button.x{color:#8a8fa0}
      button:focus-visible{outline:2px solid #5b4ff0;outline-offset:2px}
      .vazio{padding:14px 6px;color:#5b6070;font-size:12.5px}
      .rod{padding:8px 12px;border-top:1px solid #eef0f4;font-size:11px;color:#8a8fa0}
    </style>
    <div class="p ${st.aberto ? '' : 'min'}">
      <div class="cab" data-alternar="1"><b>GLR · pacote do dia</b><span class="q">${st.erro ? '!' : lista.length}</span></div>
      ${st.aberto ? `<div class="lista">${barra}${corpo}</div><div class="rod">A extensão preenche e destaca; quem salva no ML é você.</div>` : ''}
    </div>`;
  }

  raiz.addEventListener('click', async e => {
    const b = e.target.closest('[data-alternar],[data-abrir],[data-ajuda],[data-feito],[data-desc],[data-auto-iniciar],[data-auto-parar],[data-auto-fechar]'); if (!b) return;
    if (b.dataset.alternar) { st.aberto = !st.aberto; return render(); }
    if (b.dataset.autoIniciar) { b.disabled = true; return iniciarAuto(); }
    if (b.dataset.autoParar) return pararAuto();
    if (b.dataset.autoFechar) { await chrome.storage.local.remove(FILA); st.auto = null; st.chave = ''; return carregar(); }
    if (b.dataset.abrir) { const adv = new URLSearchParams(location.search).get('advertiser_id'); location.href = `/publicidade/product-ads/admin/campaigns/${b.dataset.abrir}/dashboard${adv ? `?advertiser_id=${adv}` : ''}`; return; }
    const l = st.itens.find(x => String(x.id) === String(b.dataset.ajuda || b.dataset.feito || b.dataset.desc)); if (!l) return;
    if (b.dataset.ajuda) {
      limparDestaques();
      const aj = ajudaDe(l, campanhaAberta()); if (!aj) return;
      b.disabled = true;
      const erro = await aj.fn().catch(err => String(err.message || err));
      st.msg[l.id] = erro ? { texto: erro, erro: true } : { texto: 'Pronto: confira o que está destacado em roxo e confirme no ML.' };
      return render();
    }
    b.disabled = true;
    const r = await enviar({ tipo: 'marcar', id: l.id, resultado: b.dataset.feito ? 'executado' : 'descartado', dados: l.dados });
    if (r?.ok) { st.itens = st.itens.filter(x => x.id !== l.id); limparDestaques(); }
    else st.msg[l.id] = { texto: `Não consegui marcar: ${r?.erro || 'erro'}`, erro: true };
    render();
  });

  async function carregar() {
    const aqui = campanhaAberta();
    const campanhas = aqui ? [aqui] : campanhasDaLista();
    const chave = campanhas.join(',');
    if (chave === st.chave && (!st.erro || Date.now() - (st.erroEm || 0) < 30000)) return; // com erro, tenta de novo a cada 30 s
    st.chave = chave; st.carregando = true; render();
    if (!campanhas.length) { st.itens = []; st.carregando = false; st.erro = null; return render(); }
    const r = await enviar({ tipo: 'listar', campanhas });
    st.carregando = false;
    if (!r?.ok) { st.erro = r?.erro || 'Não consegui buscar o pacote do dia.'; st.erroEm = Date.now(); st.itens = []; }
    else { st.erro = null; st.itens = (r.itens || []).filter(l => l.dados?.acao !== 'abc_queda'); }
    render();
  }

  render();
  // fila do modo automático continua sozinha depois de abrir a próxima campanha
  lerFila().then(f => { st.auto = f; render(); if (f?.status === 'rodando') setTimeout(rodar, 3000); });
  // o painel do ML é uma página de uma tela só: acompanha a troca de campanha pela URL e a lista que carrega
  let ultimaUrl = '';
  setInterval(() => { if (location.href !== ultimaUrl) { ultimaUrl = location.href; st.chave = ''; limparDestaques(); } carregar(); }, 1500);
  chrome.storage.onChanged.addListener(m => { if (m.sessao) { st.chave = ''; st.erro = null; carregar(); } });
})();
