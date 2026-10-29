// ============================================================
// GLR Consultoria — Ajustes de interface que valem para todas as telas
// ------------------------------------------------------------
//  • Explicação sob demanda: texto com classe "ajuda" (ou as notas antigas
//    .ag-nota) fica escondido e ganha um botão ⓘ ao lado do título do bloco —
//    o número aparece primeiro, a explicação só quando o usuário pede.
//  • Coluna vazia some: em qualquer tabela da tela, coluna em que todas as
//    linhas são "—" (ou vazias) é escondida — menos colunas encavaladas.
//    Tabela que precisa de todas as colunas: data-todas-colunas.
// Roda sozinho (observa #page-content); as telas não precisam chamar nada.
// ============================================================
(function () {
  const SELETOR_AJUDA = '.ajuda, .ag-nota';
  const abertas = new Set(); // explicações abertas nesta sessão (sobrevive ao redesenho da tela)
  const chave = el => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);

  function prepararAjuda(raiz) {
    raiz.querySelectorAll(SELETOR_AJUDA).forEach(el => {
      if (el.dataset.ajuda) return;
      el.dataset.ajuda = '1';
      const k = chave(el);
      if (!k) return;
      const bt = document.createElement('button');
      bt.type = 'button';
      bt.className = 'ajuda-bt';
      bt.title = 'Como ler';
      bt.setAttribute('aria-label', 'Mostrar explicação');
      bt.textContent = 'ⓘ';
      const aberto = abertas.has(k);
      el.classList.toggle('ajuda-fechada', !aberto);
      bt.setAttribute('aria-expanded', String(aberto));
      bt.addEventListener('click', e => {
        e.stopPropagation();
        const abrir = el.classList.contains('ajuda-fechada');
        el.classList.toggle('ajuda-fechada', !abrir);
        bt.setAttribute('aria-expanded', String(abrir));
        abrir ? abertas.add(k) : abertas.delete(k);
      });
      // o ⓘ vai no título do bloco (irmão anterior curto); sem título, logo antes do texto
      const ant = el.previousElementSibling;
      const titulo = ant && !ant.matches(SELETOR_AJUDA) && ant.textContent.trim().length < 140 && !ant.querySelector('input,select,textarea,table,canvas') ? ant : null;
      if (titulo) { const alvo = titulo.querySelector('.ag-sec-titulo, .section-title, b, strong') || titulo; alvo.appendChild(bt); }
      else { const linha = document.createElement('div'); linha.className = 'ajuda-linha'; linha.appendChild(bt); el.before(linha); }
    });
  }

  const vazio = t => { const s = t.replace(/\s+/g, ' ').trim(); return !s || s === '—' || s === '-' || s === '–'; };
  function ocultarColunasVazias(raiz) {
    raiz.querySelectorAll('table').forEach(tab => {
      if (tab.hasAttribute('data-todas-colunas')) return;
      const cab = tab.tHead?.rows[0];
      const corpo = tab.tBodies[0];
      if (!cab || !corpo) return;
      const n = cab.cells.length;
      const linhas = [...corpo.rows].filter(r => r.cells.length === n); // linhas expandidas (colspan) ficam de fora
      if (linhas.length < 3) return;
      for (let c = 1; c < n; c++) {
        const semDado = linhas.every(r => vazio(r.cells[c].textContent));
        if (semDado === cab.cells[c].classList.contains('col-vazia')) continue;
        cab.cells[c].classList.toggle('col-vazia', semDado);
        linhas.forEach(r => r.cells[c].classList.toggle('col-vazia', semDado));
      }
    });
  }

  // ── Esqueleto de carregamento: "Carregando…" / "Buscando…" em texto vira um
  //    esqueleto no formato do conteúdo (a tela substitui quando os dados chegam)
  const RE_CARREGANDO = /^[⏳\s]*(Carregando|Buscando|Calculando)\b[^]{0,60}$/i;
  const linhas = n => Array.from({ length: n }, (_, i) => `<span class="skel skel-linha" style="width:${[92, 78, 85, 64, 88, 70][i % 6]}%"></span>`).join('');
  function esqueletos(raiz) {
    raiz.querySelectorAll('div, td, p').forEach(el => {
      // só o elemento mais interno: um bloco que contém outro bloco (ex.: a área onde
      // a tela desenha) nunca é trocado — senão a tela perdia onde desenhar
      if (el.dataset.skel || el.id || el.querySelector('div, p, td, table, ul, section')) return;
      const t = el.textContent.trim();
      // progresso com número ("Buscando… 27/50") e texto de cabeçalho/botão continuam como estão
      if (!t || t.length > 80 || !RE_CARREGANDO.test(t) || /\d/.test(t) || el.closest('button, label, .section-header, .ag-sec-head, header') || /status|prog/i.test(el.id || '')) return;
      el.dataset.skel = '1';
      el.setAttribute('aria-busy', 'true');
      const largo = el.getBoundingClientRect().width > 640 && !el.closest('table, .card .card');
      el.innerHTML = `<span class="sr-only">${t.replace(/[<>&]/g, '')}</span>` + (largo
        ? `<div class="skel-tela"><div class="skel-kpis">${'<span class="skel skel-kpi"></span>'.repeat(4)}</div><div class="skel-bloco">${linhas(6)}</div></div>`
        : `<div class="skel-mini">${linhas(3)}</div>`);
    });
  }

  let agendado = null;
  function passar() {
    agendado = null;
    const raiz = document.getElementById('page-content');
    if (!raiz) return;
    try { esqueletos(raiz); } catch (e) {}
    try { prepararAjuda(raiz); } catch (e) {}
    try { ocultarColunasVazias(raiz); } catch (e) {}
  }
  function iniciar() {
    const raiz = document.getElementById('page-content');
    if (!raiz) return;
    new MutationObserver(() => { if (!agendado) agendado = setTimeout(passar, 120); }).observe(raiz, { childList: true, subtree: true });
    passar();
  }
  // ── Saúde do sistema: faixa no topo quando a sincronização para ──
  // (pedidos sem atualizar há mais de 40 min; diz se foi a cota da Tiops)
  async function verificarSaude() {
    if (typeof _sb === 'undefined' || window._portalConfig) return;
    try {
      const [p, c] = await Promise.all([
        _sb.from('glr_sync_estado').select('ultimo_sucesso').eq('recurso', 'pedidos').not('ultimo_sucesso', 'is', null).order('ultimo_sucesso', { ascending: false }).limit(1),
        _sb.from('glr_sync_estado').select('cursor').eq('marketplace', 'sistema').eq('recurso', 'consumo').eq('conta_id', 'consumo:sync').limit(1),
      ]);
      const ult = p.data?.[0]?.ultimo_sucesso;
      const min = ult ? (Date.now() - Date.parse(ult)) / 60000 : null;
      const cur = c.data?.[0]?.cursor;
      const cota = cur?.limiteEm && cur.dia === new Date().toISOString().slice(0, 10) ? cur.limiteEm : null;
      let faixa = document.getElementById('glr-saude');
      const fechadaAte = (() => { try { return +localStorage.getItem('glr_saude_fechada') || 0; } catch (e) { return 0; } })();
      if (min == null || min < 40 || Date.now() < fechadaAte) { faixa?.remove(); return; }
      if (!faixa) {
        faixa = document.createElement('div');
        faixa.id = 'glr-saude'; faixa.className = 'glr-saude'; faixa.setAttribute('role', 'status');
        document.getElementById('page-content')?.before(faixa);
      }
      const t = min >= 120 ? `${Math.round(min / 60)} h` : `${Math.round(min)} min`;
      const hora = cota ? new Date(cota).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
      faixa.innerHTML = `<b>Sincronização parada há ${t}.</b> <span>${cota ? `A cota diária da Tiops esgotou às ${hora} — volta sozinha às 21h. Os números de vendas e ADS ficam parados até lá.` : 'Os números de vendas e ADS podem estar desatualizados. Se continuar, confira a Vercel e a Tiops.'}</span><button type="button" aria-label="Fechar aviso" title="Esconder por 1 hora">✕</button>`;
      faixa.querySelector('button').onclick = () => { try { localStorage.setItem('glr_saude_fechada', String(Date.now() + 3600e3)); } catch (e) {} faixa.remove(); };
    } catch (e) { /* sem conexão: não mostra nada */ }
  }
  setTimeout(verificarSaude, 4000);
  setInterval(verificarSaude, 5 * 60e3);

  window.GLRUI = { atualizar: passar, verificarSaude };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
