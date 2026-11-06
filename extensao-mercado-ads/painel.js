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
  const textoIgual = (sel, txt, raiz = document) => fundo(raiz, sel).find(e => e.textContent.trim() === txt);
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
  // edição da campanha: gaveta lateral "Modificar sua campanha" ou janela "Modificar seu ROAS Objetivo" /
  // "Modificar seu orçamento…" — o ML mostra um formato ou outro dependendo da conta
  const visivel = e => !!(e && e.getClientRects().length);
  // partes da tela do ML vêm em módulos com Shadow DOM (ex.: as opções de ROAS da janela "Modificar seu ROAS
  // Objetivo"): a busca precisa entrar neles
  function fundo(raiz, sel) { const out = []; const ir = n => { if (!n || !n.querySelectorAll) return; out.push(...n.querySelectorAll(sel)); n.querySelectorAll('*').forEach(e => { if (e.shadowRoot) ir(e.shadowRoot); }); }; ir(raiz); return out; }
  const fundo1 = (raiz, sel) => fundo(raiz, sel)[0] || null;
  const gaveta = () => {
    // só vale o título visível que está na mesma janela de um botão Salvar visível (o lápis tem uma dica com o mesmo texto)
    const tits = [...document.querySelectorAll('h1,h2,h3,span,div,p')].filter(e => e.childElementCount === 0 && /^Modificar (sua campanha|seu ROAS|seu orçamento)/i.test(e.textContent.trim()) && visivel(e));
    for (const t of tits) { let g = t; for (let i = 0; i < 12 && g; i++) { if (g.querySelectorAll && [...fundo(g, 'button')].some(b => b.textContent.trim() === 'Salvar' && visivel(b))) return g; g = g.parentElement; } }
    return null;
  };
  // botão "Editar" (lápis) do cartão de ROAS ou de orçamento no topo da campanha
  function lapisDoCartao(titulo) {
    const rots = [...document.querySelectorAll('span,div,p,h3,h4,label')].filter(e => e.childElementCount <= 3 && e.textContent.trim().startsWith(titulo) && e.textContent.trim().length < 60);
    for (const rot of rots) {
      let c = rot;
      for (let i = 0; i < 6 && c; i++) {
        const b = c.querySelector && ([...c.querySelectorAll('button')].find(x => /editar|edit/i.test(x.getAttribute('aria-label') || x.title || '')));
        if (b) return b;
        c = c.parentElement;
      }
    }
    return null;
  }

  // ── Ajudantes por tipo de passo (preenche e destaca; não salva) ──
  async function abrirGaveta(titulo) {
    if (gaveta()) return gaveta();
    const b = lapisDoCartao(titulo); if (!b) return null;
    b.click();
    return aguardar(() => { const g = gaveta(); return g && fundo1(g, 'input') ? g : null; });
  }
  async function preencherRoas(valor) {
    const g = await abrirGaveta('ROAS Objetivo'); if (!g) return 'Não achei o botão de editar o ROAS objetivo nesta tela.';
    const fixo = fundo1(g, 'input[type="radio"][value="fixed"]'); if (fixo && !fixo.checked) { fixo.click(); await espera(500); }
    const o = await aguardar(() => { const x = campoDefinirOutro(g); return x.radio ? x : null; }, 3000);
    if (o?.radio && !o.radio.checked) { o.radio.click(); await espera(300); }
    const campo = campoDefinirOutro(g).campo; if (!campo) return 'Não achei o campo do ROAS objetivo.';
    digitar(campo, campo.type === 'number' ? String(valor) : String(valor).replace('.', ','));
    destacar(campo, 'Valor preenchido pela GLR');
    destacar(textoIgual('button', 'Salvar', g), 'Confira e clique em Salvar');
    return null;
  }
  async function preencherOrcamento(valor) {
    const g = await abrirGaveta('Orçamento diário'); if (!g) return 'Não achei o botão de editar o orçamento nesta tela.';
    let campo = fundo1(g, 'input[aria-label="Orçamento diário"]');
    if (!campo) { textoIgual('button', 'Orçamento diário', g)?.click(); campo = await aguardar(() => fundo1(g, 'input[aria-label="Orçamento diário"]'), 3000); }
    const fixo = fundo1(g, 'input[type="radio"][aria-label="Orçamento fixo"]'); if (fixo && !fixo.checked) { fixo.click(); await espera(400); campo = fundo1(g, 'input[aria-label="Orçamento diário"]') || campo; }
    if (!campo) return 'Não achei o campo do orçamento diário.';
    digitar(campo, String(Math.round(valor * 100) / 100).replace('.', ','));
    destacar(campo, 'Valor preenchido pela GLR');
    destacar(textoIgual('button', 'Salvar', g), 'Confira e clique em Salvar');
    return null;
  }
  // linha do anúncio na tabela da campanha: o ML agrupa por produto (a linha mostra o código do anúncio
  // principal, do catálogo ou da família), então procura pelo código e, se não achar, pelo nome do produto
  const normT = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  function linhaDoAnuncio(itemId, produto) {
    const num = String(itemId).replace(/^MLB/i, ''), linhas = fundo(document, 'table tbody tr'), nome = normT(produto).slice(0, 35);
    return linhas.find(tr => tr.innerText.includes(num)) || (nome.length >= 12 ? linhas.find(tr => normT(tr.innerText).includes(nome)) : null);
  }
  const codigoDaLinha = tr => ((tr?.innerText || '').match(/#\s?((?:MLB)?\d{6,})/) || [])[1] || null;
  const linhaPorCodigo = cod => cod ? fundo(document, 'table tbody tr').find(tr => codigoDaLinha(tr) === cod) : null;
  function buscarNaTabela(q) {
    const busca = fundo1(document, 'input[placeholder^="Procurar por #"]'); if (!busca) return false;
    digitar(busca, q); busca.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); return true;
  }
  // devolve o código que a linha mostra (#MLB… / família), para achar a mesma linha depois de pausar
  async function acharLinha(itemId, produto) {
    let linha = await aguardar(() => linhaDoAnuncio(itemId, produto), 4000);
    // a busca do ML acha pelo código da variação e mostra a linha do produto/catálogo
    if (!linha && buscarNaTabela(String(itemId))) { await espera(3000); const rs = fundo(document, 'table tbody tr').filter(tr => tr.innerText.trim()); linha = linhaDoAnuncio(itemId, produto) || (rs.length === 1 ? rs[0] : null); }
    if (!linha && produto && buscarNaTabela(String(produto).slice(0, 30))) { linha = await aguardar(() => linhaDoAnuncio(itemId, produto), 5000); }
    return linha ? codigoDaLinha(linha) || linha : null;
  }
  async function mostrarAnuncio(itemId, produto) {
    const k = await acharLinha(itemId, produto);
    const linha = typeof k === 'string' ? linhaPorCodigo(k) : k;
    if (!linha) return `Não achei o anúncio ${itemId}${produto ? ` ("${String(produto).slice(0, 40)}")` : ''} nesta campanha (pode já ter sido pausado ou removido).`;
    destacar(linha);
    destacar(linha.querySelector('button[aria-label="Acciones del anuncio"]'), 'Clique aqui → Pausar');
    return null;
  }
  async function mostrarAdicionar(ids) {
    try { await navigator.clipboard.writeText(ids.join(', ')); } catch (e) {}
    const b = textoIgual('button', 'Adicionar anúncios') || textoIgual('a', 'Adicionar') || textoIgual('button', 'Adicionar');
    return destacar(b, 'Clique aqui e cole os códigos') ? null : 'Não achei o botão "Adicionar anúncios" nesta tela.';
  }
  // mover de campanha pela tela "Anúncios patrocinados": acha a linha, marca, Mais ações → Mover para uma
  // campanha → escolhe o destino (o valor de cada opção é o id da campanha). Não precisa pausar antes.
  const naAds = () => /\/product-ads\/admin\/ads/.test(location.pathname);
  // sempre no Central de vendedores: em ads.mercadolivre.com.br o caminho /publicidade/... dá 404
  const ML = 'https://vendedores.mercadolivre.com.br';
  const urlAnuncios = adv => `${ML}/publicidade/product-ads/admin/ads${adv ? `?advertiser_id=${adv}` : ''}`;
  const urlCampanha = (id, adv) => `${ML}/publicidade/product-ads/admin/campaigns/${id}/dashboard${adv ? `?advertiser_id=${adv}` : ''}`;
  const campanhaDaLinha = tr => ((tr?.querySelector('a[href*="/campaigns/"]')?.getAttribute('href') || '').match(/\/campaigns\/(\d+)\//) || [])[1] || null;
  const modalMover = () => [...document.querySelectorAll('.ml-ads-tab-move-ads-modal')].find(visivel) || null;
  const fecharModalMover = () => { const b = modalMover() && [...modalMover().querySelectorAll('button')].find(x => x.textContent.trim() === 'Cancelar'); if (b) b.click(); };
  // auto = clica em "Mover anúncios patrocinados" e confere; manual = deixa tudo escolhido e destaca o botão
  async function moverUm(itemId, d, auto) {
    const destino = String(d.destino_id || ''), pausa = auto ? humano : () => espera(400);
    const k = await acharLinha(itemId, d.produto);
    const linhaDe = () => typeof k === 'string' ? linhaPorCodigo(k) : k;
    if (!linhaDe()) return `Não achei o anúncio ${itemId}${d.produto ? ` ("${String(d.produto).slice(0, 40)}")` : ''} na tela de anúncios patrocinados.`;
    if (campanhaDaLinha(linhaDe()) === destino) return null; // já está na campanha de destino (ex.: a família toda numa variação anterior)
    destacar(linhaDe());
    const cb = linhaDe().querySelector('input[type="checkbox"]'); if (!cb) return 'Não achei a caixa de seleção da linha do anúncio.';
    fundo(document, 'table tbody tr input[type="checkbox"]').filter(c => c.checked && c !== cb).forEach(c => (c.closest('label') || c).click()); // só esta linha marcada
    if (!cb.checked) { await pausa(1200, 2500); (cb.closest('label') || cb).click(); }
    if (!(await aguardar(() => cb.checked, 3000))) return 'Não consegui marcar a linha do anúncio.';
    await pausa(1000, 2200);
    const mais = fundo(document, 'button').find(b => /^Mais ações/.test(b.textContent.trim()) && visivel(b)); if (!mais) return 'Não achei o botão "Mais ações".';
    mais.click();
    const op = await aguardar(() => fundo(document, 'li').find(x => x.textContent.trim() === 'Mover para uma campanha' && visivel(x)), 4000);
    if (!op) return 'Não achei a opção "Mover para uma campanha" em Mais ações.';
    await pausa(800, 1600); (op.querySelector('button') || op).click();
    if (!(await aguardar(() => modalMover()?.querySelector('input[type="radio"]'), 8000))) return 'A janela "Escolha a campanha de destino" não abriu.';
    const radioDe = () => modalMover()?.querySelector(`input[type="radio"][value="${destino}"]`);
    let rd = radioDe();
    const busca = modalMover().querySelector('input[placeholder^="Buscar por título"]');
    if (!rd && d.destino && busca) { await pausa(800, 1500); if (auto) await digitarDevagar(busca, String(d.destino)); else digitar(busca, String(d.destino)); rd = await aguardar(radioDe, 5000); }
    if (!rd) { fecharModalMover(); return `A campanha ${d.destino || destino} não aparece na lista de destino do ML (pode estar pausada ou com outro nome).`; }
    const ativar = modalMover().querySelector('input[type="checkbox"]'); if (ativar && !ativar.checked) (ativar.closest('label') || ativar).click(); // entra ativo na campanha nova
    await pausa(800, 1600); rd.click();
    const mover = await aguardar(() => { const b = [...(modalMover()?.querySelectorAll('button') || [])].find(x => x.textContent.trim() === 'Mover anúncios patrocinados'); return b && !b.disabled ? b : null; }, 3000);
    if (!mover) { fecharModalMover(); return 'O botão "Mover anúncios patrocinados" não liberou.'; }
    if (!auto) { destacar(rd.closest('li') || rd); destacar(mover, 'Confira a campanha e clique aqui'); return null; }
    await humano(1500, 3500); mover.click();
    if (!(await aguardar(() => !modalMover(), 10000))) return 'Cliquei em Mover, mas a janela não fechou — o ML pode ter mostrado um aviso. Confira a tela.';
    await espera(3000);
    const noDestino = () => { const tr = linhaDe() || linhaDoAnuncio(itemId, d.produto); return tr && campanhaDaLinha(tr) === destino; };
    let ok = await aguardar(noDestino, 6000);
    if (!ok && buscarNaTabela(String(itemId))) ok = await aguardar(noDestino, 8000); // a tabela pode só atualizar com nova busca
    buscarNaTabela(''); // limpa a busca para o próximo passo
    return ok ? null : `Movi, mas a tabela ainda não mostra o anúncio em ${d.destino || 'na campanha de destino'} — confira.`;
  }
  function mostrarEstado() {
    const t = textoIgual('span,div,p', 'Estado:');
    const sw = t ? t.parentElement.querySelector('input[type="checkbox"],button[role="switch"],[class*="switch"]') : null;
    return destacar(sw || t, 'Desligue aqui para pausar a campanha') ? null : 'Não achei o controle de estado da campanha.';
  }

  // ── Modo automático, no ritmo de uma pessoa: aplica sozinho ROAS, orçamento, pausa de anúncio e
  //    mover de campanha (quando o destino já existe), confere cada passo na tela e para no primeiro
  //    imprevisto. Colocar produto e pausar campanha continuam à mão.
  const AUTO = new Set(['roas_target', 'orcamento', 'retirar_produto', 'mover_produto']);
  const podeAuto = d => !!d && AUTO.has(d.acao) && (d.acao !== 'mover_produto' || /^\d+$/.test(String(d.destino_id || '')));
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
  // "Definir outro" e o campo do valor, nos dois formatos de edição (o campo pode ser número ou texto com vírgula)
  function campoDefinirOutro(g) {
    let radio = fundo1(g, 'input[type="radio"][value="-1"]');
    if (!radio) { const rot = [...fundo(g, 'label,span,div,p')].find(e => e.childElementCount === 0 && e.textContent.trim() === 'Definir outro'); let c = rot; for (let i = 0; i < 4 && c && !radio; i++) { radio = c.querySelector && c.querySelector('input[type="radio"]'); c = c.parentElement; } }
    let card = radio; for (let i = 0; i < 5 && card && !(card.querySelector && card.querySelector('input:not([type="radio"]):not([type="checkbox"])')); i++) card = card.parentElement;
    const campo = (card && card.querySelector('input:not([type="radio"]):not([type="checkbox"])')) || fundo1(g, 'input[type="number"]');
    return { radio, campo };
  }
  const cancelarEdicao = () => { const g = gaveta(); const b = g && textoIgual('button', 'Cancelar', g); if (b) b.click(); };
  const porqueSemEdicao = titulo => `Não achei a edição do ${titulo} (lápis ${lapisDoCartao(titulo) ? 'encontrado' : 'não encontrado'}; janela de edição ${gaveta() ? 'aberta' : 'não abriu'}).`;
  async function autoRoas(valor) {
    const g = await abrirGaveta('ROAS Objetivo'); if (!g) return porqueSemEdicao('ROAS Objetivo');
    await humano(1200, 2500);
    const fixo = fundo1(g, 'input[type="radio"][value="fixed"]'); if (fixo && !fixo.checked) { fixo.click(); await humano(800, 1600); }
    const o = await aguardar(() => { const x = campoDefinirOutro(g); return x.radio ? x : null; }, 3000);
    if (o?.radio && !o.radio.checked) { o.radio.click(); await humano(600, 1200); }
    const campo = campoDefinirOutro(g).campo; if (!campo) { cancelarEdicao(); return 'Não achei o campo do ROAS objetivo.'; }
    await digitarDevagar(campo, campo.type === 'number' ? String(valor) : String(valor).replace('.', ','));
    const e = await salvarGaveta(); if (e) return e;
    const lido = valorDoCartao('ROAS Objetivo');
    return lido != null && Math.abs(lido - valor) < 0.06 ? null : `Salvei, mas o cartão mostra ${lido ?? '?'}x em vez de ${xv(valor)} — confira.`;
  }
  async function autoOrcamento(valor) {
    const g = await abrirGaveta('Orçamento diário'); if (!g) return porqueSemEdicao('Orçamento diário');
    await humano(1200, 2500);
    if (!fundo1(g, 'input[aria-label="Orçamento diário"]')) { textoIgual('button', 'Orçamento diário', g)?.click(); await humano(800, 1500); }
    const fixo = fundo1(g, 'input[type="radio"][aria-label="Orçamento fixo"]'); if (fixo && !fixo.checked) { fixo.click(); await humano(800, 1500); }
    const campo = await aguardar(() => fundo1(g, 'input[aria-label="Orçamento diário"]') || fundo1(g, 'input[type="text"],input[type="number"]'), 3000); if (!campo) { cancelarEdicao(); return 'Não achei o campo do orçamento diário.'; }
    await digitarDevagar(campo, String(Math.round(valor * 100) / 100).replace('.', ','));
    const e = await salvarGaveta(); if (e) return e;
    const lido = valorDoCartao('Orçamento diário');
    return lido != null && Math.abs(lido - valor) < 0.6 ? null : `Salvei, mas o cartão mostra R$ ${lido ?? '?'} em vez de ${R$(valor)} — confira.`;
  }
  async function autoPausarAnuncio(itemId, produto) {
    const k = await acharLinha(itemId, produto);
    const linhaDe = () => typeof k === 'string' ? linhaPorCodigo(k) : k;
    if (!linhaDe()) return `Não achei o anúncio ${itemId}${produto ? ` ("${String(produto).slice(0, 40)}")` : ''} nesta campanha.`;
    destacar(linhaDe());
    if (/pausad/i.test(linhaDe()?.innerText || '')) return null; // já pausado (ex.: a família toda numa variação anterior)
    const menu = linhaDe()?.querySelector('button[aria-label="Acciones del anuncio"]'); if (!menu) return 'Não achei o menu ⋮ do anúncio.';
    await humano(1500, 3000); menu.click();
    const pausar = await aguardar(() => fundo(document, 'li,button,a,span,[role="menuitem"]').find(x => x.textContent.trim() === 'Pausar' && visivel(x)), 4000);
    if (!pausar) return 'Não achei a opção Pausar no menu do anúncio.';
    await humano(800, 1800); pausar.click();
    await espera(2500);
    if (fundo(document, '[role="dialog"]').some(d => visivel(d) && /pausar|confirm/i.test(d.innerText))) return 'O ML pediu uma confirmação para pausar — confirme à mão e marque Feito.';
    const ok = await aguardar(() => /paus/i.test(linhaDe()?.innerText || ''), 6000);
    buscarNaTabela(''); // limpa a busca para o próximo passo
    return ok ? null : 'Cliquei em Pausar, mas não vi o anúncio como pausado — confira.';
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
    // agrupa por tela: cada campanha, e os "mover" juntos na tela de anúncios patrocinados
    const tela = d => d.acao === 'mover_produto' ? '~ads' : String(d.campaign_id);
    const passos = st.itens.filter(l => podeAuto(l.dados)).sort((a, b) => tela(a.dados).localeCompare(tela(b.dados))).slice(0, MAX_AUTO).map(l => ({ id: l.id, dados: l.dados }));
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
        const ads = d.acao === 'mover_produto';
        if (ads ? !naAds() : String(d.campaign_id) !== campanhaAberta()) { await humano(2000, 4000); location.href = ads ? urlAnuncios(f.adv) : urlCampanha(d.campaign_id, f.adv); return; }
        await aguardar(() => ads ? fundo(document, 'table tbody tr').length && fundo1(document, 'input[placeholder^="Procurar por #"]') : lapisDoCartao('ROAS Objetivo'), 15000); await humano(2500, 5000);
        let erro = null;
        if (d.acao === 'roas_target') erro = await autoRoas(+d.para);
        else if (d.acao === 'orcamento') erro = await autoOrcamento(+d.para);
        else if (d.acao === 'retirar_produto') for (const id of (d.item_ids || [])) { erro = await autoPausarAnuncio(id, d.produto); if (erro) break; await humano(); }
        else if (ads) for (const id of (d.item_ids || [])) { erro = await moverUm(id, d, true); if (erro) break; await humano(); }
        f = await lerFila(); if (!f || f.status !== 'rodando') break; // parado no meio pelo analista
        if (erro && /^Não achei o anúncio/.test(erro)) { f.pulados = [...(f.pulados || []), erro]; f.i++; if (f.i >= f.passos.length) f.status = 'concluido'; await gravarFila(f); limparDestaques(); await humano(); continue; }
        if (erro) { cancelarEdicao(); fecharModalMover(); f.status = 'parado'; f.erro = `Passo ${f.i + 1}: ${erro}`; await gravarFila(f); break; }
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
  const st = { itens: [], aberto: true, carregando: true, erro: null, msg: {}, chave: '', aba: 'analise', an: null, anAssin: '', meta: null, expert: false, ordem: 'prior' };
  const AN = window.__glrAnalise;
  const chaveMeta = () => `glr_meta_acos_${AN?.anunciante() || ''}`;
  chrome.storage.local.get(['glr_aba', 'glr_expert']).then(v => { if (v.glr_aba) st.aba = v.glr_aba; st.expert = !!v.glr_expert; render(); }).catch(() => {});

  const ACAO = {
    roas_target: d => `${+d.para > +d.de ? 'Subir' : 'Baixar'} o ROAS objetivo de ${xv(d.de)} para <b>${xv(d.para)}</b>`,
    orcamento: d => `${+d.para > +d.de ? 'Aumentar' : 'Reduzir'} o orçamento diário para <b>${R$(d.para)}</b>`,
    retirar_produto: d => `Pausar o anúncio <b>${esc(String(d.produto || '').slice(0, 60))}</b>`,
    mover_produto: d => `Mover <b>${esc(String(d.produto || '').slice(0, 60))}</b> para <b>${esc(d.destino || 'campanha nova')}</b>`,
    adicionar_produto: d => `Colocar <b>${esc(String(d.produto || '').slice(0, 60))}</b> nesta campanha`,
    pausar: () => 'Pausar esta campanha',
    informativa: () => 'Melhorar os anúncios desta campanha',
  };
  const PQ = d => d.acao === 'roas_target' || d.acao === 'orcamento' ? `${d.acos_30d != null ? `ACOS ${pct(d.acos_30d)} · TACOS da campanha ${pct(d.tacos_campanha)} (30 dias, como no ML)` : `ACOS da campanha ${pct(d.acos)}${d.janela_dias ? ` em ${d.janela_dias} dias` : ''}`}${d.share ? ` · perde ${Math.round((d.acao === 'orcamento' ? d.share.orcamento : d.share.classificacao) * 100)}% das impressões por ${d.acao === 'orcamento' ? 'orçamento' : 'classificação'}` : ''}`
    : d.acao === 'retirar_produto' ? `gastou ${R$(d.gasto)}${d.janela_dias ? ` em ${d.janela_dias} dias` : ''} ${d.unidades ? `e vendeu ${d.unidades} un.` : 'sem venda pelo ADS'}`
    : d.acao === 'mover_produto' ? `ACOS ${pct(d.acos)} · gastou ${R$(d.gasto)}` : '';
  const impacto = d => !d.impacto ? '' : `<span class="imp ${d.impacto_tipo === 'economia' ? 'eco' : ''}">${d.impacto_tipo === 'economia' ? '−' : '+'}${R$(d.impacto)}/sem</span>`;

  // o que o botão de ajuda faz em cada passo, na campanha aberta
  function ajudaDe(l, aqui) {
    const d = l.dados || {}, origem = String(d.campaign_id) === aqui, destino = String(d.destino_id) === aqui;
    if (d.acao === 'mover_produto' && d.destino_id && (d.item_ids || []).length) return naAds()
      ? { rot: 'Preparar a mudança', fn: async () => { for (const id of d.item_ids) { const e = await moverUm(id, d, false); if (!e) return null; if (!/^Não achei o anúncio/.test(e)) return e; } return 'Nenhum dos anúncios apareceu na tela de anúncios patrocinados.'; } }
      : { rot: 'Ir para Anúncios patrocinados', fn: async () => { location.href = urlAnuncios(new URLSearchParams(location.search).get('advertiser_id')); return null; } };
    if (d.acao === 'roas_target' && origem) return { rot: 'Preencher o ROAS', fn: () => preencherRoas(d.para) };
    if (d.acao === 'orcamento' && origem) return { rot: 'Preencher o orçamento', fn: () => preencherOrcamento(d.para) };
    if ((d.acao === 'retirar_produto' || d.acao === 'mover_produto') && origem && (d.item_ids || []).length) return { rot: 'Mostrar o anúncio', fn: async () => { for (const id of d.item_ids) { if (!(await mostrarAnuncio(id, d.produto))) return null; } return 'Nenhum dos anúncios apareceu na tabela desta campanha.'; } };
    if ((d.acao === 'adicionar_produto' || d.acao === 'mover_produto') && destino && (d.item_ids || []).length) return { rot: 'Adicionar aqui (copia os códigos)', fn: () => mostrarAdicionar(d.item_ids) };
    if (d.acao === 'pausar' && origem) return { rot: 'Mostrar onde pausar', fn: () => mostrarEstado() };
    return null;
  }
  const comoFazer = (d, aqui) => {
    if (d.acao === 'roas_target' || d.acao === 'orcamento') return 'Clique em <b>Preencher</b>, confira o valor destacado e clique em <b>Salvar</b> no ML.';
    if (d.acao === 'retirar_produto') return 'Clique em <b>Mostrar o anúncio</b>, depois no <b>⋮</b> destacado → <b>Pausar</b>.';
    if (d.acao === 'mover_produto') return !d.destino_id ? 'Em <b>Anúncios patrocinados</b>, marque o anúncio → <b>Mais ações → Criar campanha</b>.'
      : naAds() ? `Clique em <b>Preparar a mudança</b>: a extensão marca o anúncio e escolhe <b>${esc(d.destino || 'o destino')}</b> em <b>Mais ações → Mover para uma campanha</b>. Confira e clique em <b>Mover anúncios patrocinados</b>. Não precisa pausar.`
      : 'Mover é feito na tela <b>Anúncios patrocinados</b> (sem pausar): clique no botão abaixo.';
    if (d.acao === 'adicionar_produto') return 'Clique em <b>Adicionar aqui</b> e cole os códigos em <b>Adicionar anúncios</b>.';
    if (d.acao === 'pausar') return 'Desligue o <b>Estado</b> da campanha (destacado).';
    return 'Revise os anúncios desta campanha (fotos, título, ficha, frete e buy box).';
  };

  // ── Aba Análise (funciona sem login: lê a tela do Mercado Ads) ──
  const chipV = v => { const [rot, cor, fundo] = AN.VER[v] || AN.VER.manter; return `<span class="chip" style="color:${cor};background:${fundo}">${rot}</span>`; };
  const n0 = v => v == null ? '—' : Math.round(v).toLocaleString('pt-BR');
  const dl = d => d == null || d === 0 ? '' : `<span class="dl ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'}${Math.abs(Math.round(d))}%</span>`;
  function corpoAnalise() {
    const a = st.an;
    if (!AN) return '<div class="vazio erro">Não consegui carregar a análise.</div>';
    if (!a || a.tipo === 'nada') return '<div class="vazio">Abra <b>Product Ads → Campanhas</b> ou uma campanha: a análise lê a tabela da tela.</div>';
    if (a.tipo === 'carregando') return '<div class="vazio">Esperando a tabela de anúncios carregar…</div>';
    const metaTxt = st.meta ? `meta de ACOS da conta: <b>${pct(st.meta)}</b>` : 'meta de ACOS: a de cada campanha (100 ÷ ROAS objetivo)';
    const cfg = `<div class="cfg"><label>Meta de ACOS da conta <input id="glr-meta" type="number" step="0.5" min="0" placeholder="por campanha" value="${st.meta || ''}">%</label><button data-expert="1">${st.expert ? 'Modo simples' : 'Modo Expert'}</button></div>${st.meta ? '' : '<div class="dica">Defina a meta de ACOS desta conta (o máximo que a margem aguenta): sem ela, o copiloto usa o ROAS objetivo de cada campanha, que costuma ser mais apertado que o ACOS real.</div>'}`;
    if (a.tipo === 'lista') {
      const cont = {}; a.itens.forEach(x => { cont[x.v] = (cont[x.v] || 0) + 1; });
      const acosT = a.tot.receita ? a.tot.invest / a.tot.receita * 100 : null;
      const resumo = `<div class="res"><div><span>Investimento</span><b>${R$(a.tot.invest)}</b></div><div><span>Receita</span><b>${R$(a.tot.receita)}</b></div><div><span>ACOS</span><b>${pct(acosT)}</b></div><div><span>Vendas</span><b>${n0(a.tot.vendas)}</b></div></div>
        <div class="chips">${['corrigir', 'conter', 'escalar', 'aguardar', 'manter', 'semdados'].filter(k => cont[k]).map(k => `${chipV(k)}<b class="q2">${cont[k]}</b>`).join(' ')}</div>
        <div class="pq0">${a.fonte === 'api' ? `${a.itens.length} campanha(s) da conta · dados do Mercado Ads até ${a.ate.split('-').reverse().slice(0, 2).join('/')} (escada 7/15/30 dias)` : `${a.itens.length} campanha(s) desta página · últimos ${a.dias} dias${st.iaErro ? ' · leitura da tela (dados completos indisponíveis agora)' : ''}`} · ${metaTxt}</div>`;
      if (st.expert) {
        const cols = [['nome', 'Campanha'], ['v', 'Veredito'], ['roasObj', 'ROAS obj.'], ['orc', 'Orç./dia'], ['uso', 'Uso orç.'], ['acos', 'ACOS'], ['roas', 'ROAS'], ['invest', 'Invest.'], ['receita', 'Receita'], ['vendas', 'Vendas']];
        const val = (x, k) => k === 'v' ? ({ corrigir: 0, conter: 1, escalar: 2, aguardar: 3, manter: 4, semdados: 5 }[x.v]) : k === 'nome' ? x.nome : k === 'uso' ? x.uso : typeof x[k] === 'object' ? x[k]?.v : x[k];
        const ord = [...a.itens].sort((p, q) => { if (st.ordem === 'prior') return 0; const [k, dir] = st.ordem.split(':'); const A = val(p, k), B = val(q, k); return (A == null) - (B == null) || (A > B ? 1 : A < B ? -1 : 0) * (dir === 'd' ? -1 : 1); });
        return `${cfg}${resumo}<div class="tw"><table><thead><tr>${cols.map(([k, t]) => `<th data-ord="${k}">${t}${st.ordem.startsWith(k + ':') ? (st.ordem.endsWith(':d') ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead><tbody>${ord.map(x => `<tr title="${esc(x.motivo + ' ' + x.acao)}"><td><a href="${esc(x.href)}">${esc(x.nome.slice(0, 34))}</a></td><td>${chipV(x.v)}</td><td>${xv(x.roasObj)}</td><td>${x.orc ? R$(x.orc) : '—'}</td><td>${x.uso != null ? Math.round(x.uso * 100) + '%' : '—'}</td><td>${pct(x.acos.v)}${dl(x.acos.d)}</td><td>${xv(x.roas.v)}</td><td>${R$(x.invest.v)}</td><td>${R$(x.receita.v)}</td><td>${n0(x.vendas.v)}</td></tr>`).join('')}</tbody></table></div>`;
      }
      return `${cfg}${resumo}${a.itens.filter(x => x.v !== 'manter' && x.v !== 'semdados').concat(a.itens.filter(x => x.v === 'manter' || x.v === 'semdados')).map(x => `<div class="passo">
        <div class="topo">${chipV(x.v)}<div class="acao"><b>${esc(x.nome)}</b></div></div>
        <div class="pq">${esc(x.motivo)}${x.gargalo ? ` Gargalo: <b>${x.gargalo}</b>.` : ''}</div>
        <div class="como">${esc(x.acao)}</div>${extrasIA(x)}
        <div class="pq">ROAS obj. ${xv(x.roasObj)} · ${x.orc ? R$(x.orc) + '/dia' : 'sem orçamento'}${x.uso != null ? ` (${Math.round(x.uso * 100)}% usado)` : ''} · invest. ${R$(x.invest.v)}${dl(x.invest.d)} · vendas ${n0(x.vendas.v)}${dl(x.vendas.d)}</div>
        <div class="bts"><a class="bt pri" href="${esc(x.href)}">Abrir a campanha</a></div>
      </div>`).join('')}`;
    }
    // dentro da campanha
    const vc = a.vc, acosT = a.tot.receita ? a.tot.invest / a.tot.receita * 100 : null;
    const topo = `<div class="passo camp"><div class="topo">${chipV(vc.v)}<div class="acao"><b>Esta campanha</b> · ROAS obj. ${xv(a.cab.roasObj)} · ${a.cab.orc ? R$(a.cab.orc) + '/dia' : '—'}${a.cab.diag ? ` · ${esc(a.cab.diag.toLowerCase())}` : ''}</div></div>
      <div class="pq">${esc(vc.motivo)}</div><div class="como">${esc(vc.acao)}</div>${extrasIA(vc)}
      <div class="pq">Soma dos anúncios: invest. ${R$(a.tot.invest)} · receita ${R$(a.tot.receita)} · ACOS ${pct(acosT)} · ${n0(a.tot.vendas)} vendas · CTR ${a.tot.imp ? pct(a.tot.cli / a.tot.imp * 100) : '—'}</div>
      ${vc.novoRoas || vc.novoOrc ? `<div class="bts">${vc.novoRoas ? `<button class="pri" data-pre-roas="${vc.novoRoas}">Preencher ROAS ${xv(vc.novoRoas)}</button>` : ''}${vc.novoOrc ? `<button class="pri" data-pre-orc="${vc.novoOrc}">Preencher orçamento ${R$(vc.novoOrc)}</button>` : ''}</div>${st.msg.camp ? `<div class="msg ${st.msg.camp.erro ? 'erro' : ''}">${esc(st.msg.camp.texto)}</div>` : ''}` : ''}</div>
      <div class="pq0">${a.itens.length} anúncio(s)${a.fonte === 'api' ? ` · 30 dias até ${a.ate.split('-').reverse().slice(0, 2).join('/')}` : ` desta página · últimos ${a.dias} dias`} · ${a.meta ? `meta de ACOS ${pct(a.meta)}` : 'sem meta'}</div>`;
    if (st.expert) {
      return `${cfg}${topo}<div class="tw"><table><thead><tr><th>Anúncio</th><th>Veredito</th><th>Impr.</th><th>Cliques</th><th>CTR</th><th>Conv.</th><th>CPC</th><th>Invest.</th><th>Receita</th><th>ACOS</th></tr></thead><tbody>${a.itens.map(x => `<tr title="${esc(x.motivo + ' ' + x.acao)}"><td>${esc((x.nome || '').slice(0, 30))}<br><small>${esc(x.id || '')}</small></td><td>${chipV(x.v)}</td><td>${n0(x.imp.v)}</td><td>${n0(x.cli.v)}</td><td>${x.ctr != null ? pct(x.ctr) : '—'}</td><td>${x.conv != null ? pct(x.conv) : '—'}</td><td>${x.cpc.v != null ? R$(x.cpc.v) : '—'}</td><td>${R$(x.invest.v)}</td><td>${R$(x.receita.v)}</td><td>${pct(x.acos.v)}</td></tr>`).join('')}</tbody></table></div>`;
    }
    return `${cfg}${topo}${a.itens.map(x => `<div class="passo">
      <div class="topo">${chipV(x.v)}<div class="acao">${esc((x.nome || '').slice(0, 70))} <small>${esc(x.id || '')}</small></div></div>
      <div class="pq">${esc(x.motivo)}</div>${x.v !== 'manter' ? `<div class="como">${esc(x.acao)}</div>` : ''}${(x.prob || []).length ? `<div class="prob">${x.prob.map(p => `<span>${esc(p)}</span>`).join('')}</div>` : ''}
      <div class="pq">${n0(x.imp.v)} impr. · ${n0(x.cli.v)} cliques · CTR ${x.ctr != null ? pct(x.ctr) : '—'} · conv. ${x.conv != null ? pct(x.conv) : '—'} · invest. ${R$(x.invest.v)}${dl(x.invest.d)} · ACOS ${pct(x.acos.v)}</div>
      ${x.id && ['retirar', 'mover'].includes(x.v) ? `<div class="bts"><button data-mostrar="${esc(x.id)}" data-nome="${esc((x.nome || '').slice(0, 60))}">Mostrar o anúncio</button></div>` : ''}
      ${st.msg['ad:' + x.id] ? `<div class="msg ${st.msg['ad:' + x.id].erro ? 'erro' : ''}">${esc(st.msg['ad:' + x.id].texto)}</div>` : ''}
    </div>`).join('')}`;
  }
  const atencao = () => (st.an?.itens || []).filter(x => ['corrigir', 'conter', 'retirar', 'mover', 'avaliar'].includes(x.v)).length;

  function render() {
    const aqui = campanhaAberta();
    const lista = st.itens;
    const corpo = st.erro === 'SEM_LOGIN'
      ? '<div class="vazio">O pacote do dia é para clientes da GLR: entre com o login da GLR no ícone da extensão. A aba <b>Análise</b> funciona sem login.</div>'
      : st.erro ? `<div class="vazio erro">${esc(st.erro)}</div>`
      : st.carregando ? '<div class="vazio">Buscando o pacote do dia…</div>'
      : !lista.length ? `<div class="vazio">Nada pendente ${aqui ? 'para esta campanha' : 'para as campanhas desta tela'}. ✓</div>`
      : lista.map((l, i) => {
          const d = l.dados || {}, mover = d.acao === 'mover_produto', aj = aqui || mover ? ajudaDe(l, aqui) : null, m = st.msg[l.id];
          return `<div class="passo">
            <div class="topo"><span class="n">${i + 1}</span><div class="acao">${(ACAO[d.acao] || (() => esc(l.titulo)))(d)}</div>${impacto(d)}</div>
            ${PQ(d) ? `<div class="pq">${PQ(d)}</div>` : ''}
            ${aqui || mover ? `<div class="como">${comoFazer(d, aqui)}</div>` : ''}
            ${!aqui ? `<div class="pq">Campanha: <b>${esc(d.campanha || '—')}</b></div>` : ''}
            ${m ? `<div class="msg ${m.erro ? 'erro' : ''}">${esc(m.texto)}</div>` : ''}
            <div class="bts">
              ${!aqui && !mover && d.campaign_id ? `<button class="pri" data-abrir="${esc(d.campaign_id)}">Abrir a campanha</button>` : ''}
              ${aj ? `<button class="pri" data-ajuda="${esc(l.id)}">${esc(aj.rot)}</button>` : ''}
              <button data-feito="${esc(l.id)}">Feito</button>
              <button class="x" data-desc="${esc(l.id)}" title="Descartar">✕</button>
            </div>
          </div>`;
        }).join('');
    const f = st.auto, nAuto = lista.filter(l => podeAuto(l.dados)).length;
    const barra = f && f.status === 'rodando' ? `<div class="auto on">Aplicando sozinho, no ritmo de uma pessoa: passo <b>${Math.min(f.i + 1, f.passos.length)} de ${f.passos.length}</b>. Não feche esta aba. <button class="x" data-auto-parar="1">Parar</button></div>`
      : f && f.status === 'parado' ? `<div class="auto erro">Parou: ${esc(f.erro || '')} (${f.i} de ${f.passos.length} aplicados) <button data-auto-fechar="1">Ok</button></div>`
      : f && f.status === 'concluido' ? `<div class="auto ok">${f.passos.length - (f.pulados || []).length} passo(s) aplicados e conferidos ✓${(f.pulados || []).length ? `<br>${f.pulados.length} pulado(s), sem mexer: ${esc(f.pulados.join(' · '))}` : ''} <button data-auto-fechar="1">Ok</button></div>`
      : nAuto && !st.erro ? `<div class="auto"><button class="pri" data-auto-iniciar="1">Aplicar ${Math.min(nAuto, MAX_AUTO)} passo(s) sozinho</button><span>ROAS, orçamento, pausar e mover anúncio · ritmo humano · para no primeiro imprevisto${lista.length > nAuto ? ' · colocar produto e campanha nova ficam à mão' : ''}</span></div>` : '';
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
      .p.exp{width:min(860px,calc(100vw - 32px))}
      .abas{display:flex;gap:4px;padding:6px 10px 0} .abas button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:6px 8px;color:#5b6070;background:none} .abas button.on{border-bottom-color:#5b4ff0;color:#1f2330;font-weight:600} .abas i{font-style:normal;font-size:10.5px;background:#5b4ff0;color:#fff;border-radius:99px;padding:0 6px;margin-left:3px}
      .chip{display:inline-block;flex-shrink:0;font-size:11px;font-weight:700;border-radius:99px;padding:1px 8px;white-space:nowrap}
      .res{display:grid;grid-template-columns:repeat(4,1fr);gap:6px} .res div{background:#f6f7fa;border-radius:8px;padding:6px 8px;display:flex;flex-direction:column} .res span{font-size:10.5px;color:#5b6070} .res b{font-size:13px}
      .esc{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:4px} .degrau{font-size:11px;font-weight:600;border-radius:99px;padding:1px 7px} .conf{font-size:11px;color:#8a8fa0;margin-left:2px}
      .notas{margin:4px 0 0;padding-left:16px;font-size:11.5px;color:#5b6070} .prob{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px} .prob span{font-size:11px;color:#c0392b;background:#fdecea;border-radius:99px;padding:1px 7px}
      .chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center} .q2{font-size:12px;margin-right:6px} .pq0{font-size:11.5px;color:#8a8fa0}
      .cfg{display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:12px;color:#5b6070} .dica{font-size:11.5px;color:#8a5a00;background:#fff8e6;border-radius:8px;padding:6px 8px} .cfg input{width:70px;font:inherit;border:1px solid #d6d9e2;border-radius:6px;padding:3px 6px;margin:0 3px}
      .passo .topo .acao b{font-weight:600} .passo.camp{border-color:#d9d4ff;background:#faf9ff} small{color:#8a8fa0;font-size:10.5px}
      .dl{font-size:10.5px;margin-left:2px} .dl.up{color:#0f8a4b} .dl.dn{color:#c0392b}
      a.bt{font-size:12px;border:1px solid #5b4ff0;background:#5b4ff0;color:#fff;border-radius:8px;padding:5px 10px;text-decoration:none;font-weight:600}
      .tw{overflow:auto;max-height:52vh;border:1px solid #eceef3;border-radius:8px} table{border-collapse:collapse;width:100%;font-size:12px} th{position:sticky;top:0;background:#f6f7fa;text-align:left;padding:6px;cursor:pointer;white-space:nowrap;font-weight:600} td{padding:5px 6px;border-top:1px solid #f0f1f5;white-space:nowrap} td a{color:#3b32c4}
    </style>
    <div class="p ${st.aberto ? '' : 'min'} ${st.expert && st.aba === 'analise' && st.aberto ? 'exp' : ''}">
      <div class="cab" data-alternar="1"><b>GLR Copiloto ADS</b><span class="q">${atencao() + (st.erro ? 0 : lista.length)}</span></div>
      ${st.aberto ? `<div class="abas"><button class="${st.aba === 'analise' ? 'on' : ''}" data-aba="analise">Análise${atencao() ? ` <i>${atencao()}</i>` : ''}</button><button class="${st.aba === 'glr' ? 'on' : ''}" data-aba="glr">Pacote GLR${!st.erro && lista.length ? ` <i>${lista.length}</i>` : ''}</button></div>
        <div class="lista">${st.aba === 'analise' ? corpoAnalise() : barra + corpo}</div><div class="rod">${st.aba === 'analise' ? 'Lê só a tela do Mercado Ads, no seu navegador. Sugestões: quem decide e salva no ML é você.' : 'A extensão preenche e destaca; quem salva no ML é você.'} · v${chrome.runtime.getManifest?.().version || ''}</div>` : ''}
    </div>`;
  }

  raiz.addEventListener('click', async e => {
    const b = e.target.closest('[data-alternar],[data-abrir],[data-ajuda],[data-feito],[data-desc],[data-auto-iniciar],[data-auto-parar],[data-auto-fechar],[data-aba],[data-expert],[data-ord],[data-pre-roas],[data-pre-orc],[data-mostrar]'); if (!b) return;
    if (b.dataset.alternar) { st.aberto = !st.aberto; return render(); }
    if (b.dataset.aba) { st.aba = b.dataset.aba; chrome.storage.local.set({ glr_aba: st.aba }); return render(); }
    if (b.dataset.expert) { st.expert = !st.expert; chrome.storage.local.set({ glr_expert: st.expert }); return render(); }
    if (b.dataset.ord) { const k = b.dataset.ord; st.ordem = st.ordem === `${k}:d` ? `${k}:a` : st.ordem === `${k}:a` ? 'prior' : `${k}:d`; return render(); }
    if (b.dataset.preRoas || b.dataset.preOrc) { limparDestaques(); b.disabled = true; const erro = await (b.dataset.preRoas ? preencherRoas(+b.dataset.preRoas) : preencherOrcamento(+b.dataset.preOrc)).catch(err => String(err.message || err)); st.msg.camp = erro ? { texto: erro, erro: true } : { texto: 'Pronto: confira o valor destacado em roxo e clique em Salvar no ML.' }; return render(); }
    if (b.dataset.mostrar) { limparDestaques(); const ok = await mostrarAnuncio(b.dataset.mostrar, b.dataset.nome).catch(() => false); st.msg['ad:' + b.dataset.mostrar] = ok ? { texto: 'Anúncio destacado: use o ⋮ da linha → Pausar (ou Mover em Anúncios patrocinados).' } : { texto: 'Não achei o anúncio nesta página da tabela.', erro: true }; return render(); }
    if (b.dataset.autoIniciar) { b.disabled = true; return iniciarAuto(); }
    if (b.dataset.autoParar) return pararAuto();
    if (b.dataset.autoFechar) { await chrome.storage.local.remove(FILA); st.auto = null; st.chave = ''; return carregar(); }
    if (b.dataset.abrir) { location.href = urlCampanha(b.dataset.abrir, new URLSearchParams(location.search).get('advertiser_id')); return; }
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

  raiz.addEventListener('change', e => {
    if (e.target.id !== 'glr-meta') return;
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    st.meta = v > 0 ? v : null; chrome.storage.local.set({ [chaveMeta()]: st.meta }); st.anAssin = ''; analisarTela(true); analisarIA(true);
  });
  // inteligência pelos dados do próprio Mercado Ads (inteligencia.js): escada 7/15/30 dias, gargalo, histórico
  // de alterações, diagnóstico do anúncio. Refaz a cada 60 s ou ao trocar de tela/meta; se falhar, fica a leitura da tela.
  let ia = { chave: '', em: 0, rodando: false, res: null };
  const chaveIA = () => `${location.pathname}|${AN.anunciante()}|${st.meta || ''}`;
  async function analisarIA(forcar) {
    if (!window.__glrIA || ia.rodando) return;
    const chave = chaveIA();
    if (!forcar && chave === ia.chave && Date.now() - ia.em < 60000) return;
    ia.rodando = true; ia.chave = chave; ia.em = Date.now();
    try { const r = await window.__glrIA.analisar({ metaAcos: st.meta }); ia.res = r ? { ...r, chave } : null; st.iaErro = null; }
    catch (e) { ia.res = null; st.iaErro = String(e.message || e); }
    ia.rodando = false; analisarTela(true);
  }
  function mesclarIA(dom) {
    const r = ia.res;
    if (!r || r.chave !== chaveIA() || r.tipo !== (dom.tipo === 'carregando' ? 'campanha' : dom.tipo === 'nada' ? r.tipo : dom.tipo)) return dom;
    // mantém o selo nas linhas da tabela do ML, agora com o veredito da inteligência
    const linhas = new Map((dom.itens || []).map(x => [String(x.id), x.tr]));
    r.itens.forEach(x => { const tr = linhas.get(String(x.id)) || [...linhas.entries()].find(([k]) => k && String(x.id).includes(k.replace(/\D/g, '')))?.[1]; if (tr) AN.selo(tr, x.v, `${x.motivo} ${x.acao}`); });
    return r;
  }
  const escada = esc0 => (esc0 || []).map(e => { const [rot, cor, fundo] = { folga: ['folga', '#0f8a4b', '#e7f6ee'], ok: ['na meta', '#4a5568', '#eef0f4'], alto: ['alto', '#b45309', '#fff3e0'], pouco: ['pouco dado', '#8a8fa0', '#f3f4f7'] }[e.cl] || []; return `<span class="degrau" style="color:${cor};background:${fundo}" title="ACOS em ${e.d} dias">${e.d}d ${e.acos != null ? pct(e.acos) : '—'} · ${rot}</span>`; }).join('');
  const extrasIA = x => !x.esc ? '' : `<div class="esc">${escada(x.esc)}<span class="conf">confiança ${x.conf}</span></div>${(x.notas || []).length ? `<ul class="notas">${x.notas.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
  // lê a tela e refaz a análise só quando a tabela mudou
  let metaDe = '';
  async function analisarTela(forcar) {
    if (!AN) return;
    if (metaDe !== chaveMeta()) { metaDe = chaveMeta(); try { st.meta = (await chrome.storage.local.get(metaDe))[metaDe] || null; } catch (e) {} }
    const dom = AN.analisar({ metaAcos: st.meta });
    analisarIA();
    const a = mesclarIA(dom);
    const assin = JSON.stringify([a.tipo, a.fonte, (a.itens || []).map(x => [x.id, x.v, x.invest?.v, x.acos?.v]), a.vc?.v, st.meta, st.iaErro]);
    if (!forcar && assin === st.anAssin) return;
    st.anAssin = assin; st.an = a;
    const ativo = raiz.activeElement && raiz.activeElement.id === 'glr-meta'; if (!ativo) render();
  }

  async function carregar() {
    const aqui = campanhaAberta();
    let campanhas = aqui ? [aqui] : campanhasDaLista();
    // a tela de anúncios patrocinados só mostra 50 linhas: junta as campanhas vistas na lista de campanhas
    const chaveLista = `glr_campanhas_lista_${new URLSearchParams(location.search).get('advertiser_id') || ''}`;
    if (!aqui && naAds()) campanhas = [...new Set([...campanhas, ...((await chrome.storage.local.get(chaveLista))[chaveLista] || [])])];
    else if (!aqui && campanhas.length) chrome.storage.local.set({ [chaveLista]: campanhas });
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
  setInterval(() => { if (location.href !== ultimaUrl) { ultimaUrl = location.href; st.chave = ''; st.anAssin = ''; st.msg = {}; limparDestaques(); } analisarTela(); carregar(); }, 1500);
  chrome.storage.onChanged.addListener(m => { if (m.sessao) { st.chave = ''; st.erro = null; carregar(); } });
})();
