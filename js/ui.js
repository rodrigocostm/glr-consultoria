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
        // imagem, campo ou botão também é conteúdo (a coluna da foto e a do custo digitável não têm texto)
        const semDado = linhas.every(r => vazio(r.cells[c].textContent) && !r.cells[c].querySelector('img, input, select, textarea, button, svg, canvas'));
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
      if (el.dataset.skel || el.id || el.querySelector('div, p, td, table, ul, section, input, select, textarea, button')) return; // bloco com campo/botão nunca vira esqueleto
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

  // ── Acessibilidade: o que tem onclick vira botão para teclado e leitor de tela,
  // e todo campo ganha um nome (rótulo, placeholder ou o texto ao lado) ──
  const NATIVOS = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY|OPTION)$/;
  function clicaveis(raiz) {
    raiz.querySelectorAll('[onclick]:not([role]):not([data-a11y])').forEach(el => {
      el.dataset.a11y = '1';
      if (NATIVOS.test(el.tagName)) return;
      const acao = el.getAttribute('onclick') || '';
      // fundo de modal (fecha ao clicar fora) e "segura o clique" não são botões
      if (/event\.target|^\s*event\.stopPropagation\(\);?\s*$/.test(acao)) return;
      // linha de tabela mantém o papel de linha; só passa a receber foco
      if (el.tagName === 'TR') el.dataset.clicavel = '1'; else el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    });
  }
  function nomeDoCampo(el) {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title) return null;
    if (el.closest('label')) return null;
    if (el.id) { try { if (document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return null; } catch (e) {} }
    if (el.placeholder) return el.placeholder;
    // rótulo logo antes do campo (padrão .form-label + campo)
    let ant = el.previousElementSibling;
    if (!ant && el.parentElement) ant = el.parentElement.previousElementSibling;
    const rot = ant && (ant.matches('label, .form-label, .lbl, small, span, b, strong') ? ant : null);
    const t = rot && rot.textContent.trim();
    if (t && t.length <= 60) return t;
    return el.name ? el.name.replace(/[_-]+/g, ' ') : null;
  }
  function campos(raiz) {
    raiz.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([data-a11y]), select:not([data-a11y]), textarea:not([data-a11y])').forEach(el => {
      el.dataset.a11y = '1';
      const n = nomeDoCampo(el);
      if (n) el.setAttribute('aria-label', n);
    });
  }
  function acessivel(raiz) { clicaveis(raiz); campos(raiz); }
  // Enter/Espaço num [role=button] que não é botão de verdade = clique
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target;
    if (!el || !el.getAttribute || NATIVOS.test(el.tagName)) return;
    if (el.getAttribute('role') !== 'button' && !(el.dataset && el.dataset.clicavel)) return;
    if (e.defaultPrevented) return;
    e.preventDefault();
    el.click();
  });

  let agendado = null;
  function passar() {
    agendado = null;
    const raiz = document.getElementById('page-content');
    if (!raiz) return;
    try { esqueletos(raiz); } catch (e) {}
    try { prepararAjuda(raiz); } catch (e) {}
    try { ocultarColunasVazias(raiz); } catch (e) {}
    try { acessivel(document.body); } catch (e) {}
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

  window.GLRUI = { atualizar: passar, verificarSaude, acessivel };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();

// ── Markdown simples e seguro (o texto é escapado antes) — chat com os agentes e Adviser ──
window.glrMarkdown = (function () {
  const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return function (texto) {
  const blocos = [], linhas = String(texto || '').replace(/\r/g, '').split('\n');
  const inline = s => h(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1<i>$2</i>');
  const ehLista = l => /^\s*([-*•]|\d+[.)])\s+/.test(l), ehTab = l => /^\s*\|.*\|\s*$/.test(l);
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    if (/^```/.test(l)) { const cod = []; i++; while (i < linhas.length && !/^```/.test(linhas[i])) cod.push(linhas[i++]); blocos.push(`<pre><code>${h(cod.join('\n'))}</code></pre>`); continue; }
    if (ehTab(l)) {
      const tab = []; while (i < linhas.length && ehTab(linhas[i])) tab.push(linhas[i++]); i--;
      const cel = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const [cab, ...resto] = tab.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r));
      blocos.push(`<div class="ch-tab"><table><thead><tr>${cel(cab).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${resto.map(r => `<tr>${cel(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const tit = l.match(/^(#{1,4})\s+(.*)$/);
    if (tit) { const n = Math.min(5, tit[1].length + 2); blocos.push(`<h${n}>${inline(tit[2])}</h${n}>`); continue; }
    if (ehLista(l)) {
      // item recuado vira sublista do item de cima; a lista numerada mantém o número de onde começou
      const num = /^\s*\d+[.)]\s+/.test(l), ini = num ? parseInt(l) : 1, itens = [];
      while (i < linhas.length && ehLista(linhas[i])) {
        const li = linhas[i++], recuo = li.match(/^\s*/)[0].length, t = li.replace(/^\s*([-*•]|\d+[.)])\s+/, '');
        if ((recuo >= 2 || (num && /^\s*[-*•]\s+/.test(li))) && itens.length) itens[itens.length - 1].sub.push(t); else itens.push({ t, sub: [] });
      }
      i--;
      blocos.push(`<${num ? `ol${ini > 1 ? ` start="${ini}"` : ''}` : 'ul'}>${itens.map(x => `<li>${inline(x.t)}${x.sub.length ? `<ul>${x.sub.map(s => `<li>${inline(s)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</${num ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^\s*---+\s*$/.test(l)) { blocos.push('<hr>'); continue; }
    if (!l.trim()) continue;
    const par = [l];
    while (i + 1 < linhas.length && linhas[i + 1].trim() && !/^(```|#{1,4}\s)/.test(linhas[i + 1]) && !ehLista(linhas[i + 1]) && !ehTab(linhas[i + 1])) par.push(linhas[++i]);
    blocos.push(`<p>${par.map(inline).join('<br>')}</p>`);
  }
  return blocos.join('');
};
})();

// ── Aviso (toast) e confirmação próprios — substituem alert/confirm/prompt ──
//  GLR.avisar(msg, 'sucesso'|'erro'|'info')   → toast que some sozinho (aria-live)
//  GLR.confirmar(msg, { perigo, ok, cancelar }) → Promise<boolean>
//  GLR.perguntar(msg, { valor, placeholder, ok }) → Promise<string|null>
//  GLR.erroCampo(campo, msg)                  → marca o campo com o erro, foca e devolve false
// Todo texto entra com textContent: nada vindo do banco ou da API vira HTML.
(function (raiz) {
  const G = raiz.GLR || (typeof GLR !== 'undefined' ? GLR : (raiz.GLR = {}));
  const doc = () => raiz.document;
  const TEMPO = { sucesso: 4000, info: 5000, erro: 8000 };
  const ROTULO = { sucesso: 'Sucesso', erro: 'Erro', info: 'Aviso' };
  const novo = (tag, cls, txt) => { const el = doc().createElement(tag); if (cls) el.className = cls; if (txt != null) el.textContent = String(txt); return el; };

  function pilha(tipo) {
    const id = tipo === 'erro' ? 'glr-avisos-erro' : 'glr-avisos';
    let el = doc().getElementById(id);
    if (!el) {
      el = novo('div', 'glr-avisos');
      el.id = id;
      // erro interrompe o leitor de tela; sucesso e info esperam a vez
      el.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
      el.setAttribute('aria-live', tipo === 'erro' ? 'assertive' : 'polite');
      doc().body.appendChild(el);
    }
    return el;
  }

  G.avisar = function (msg, tipo, opcoes) {
    tipo = TEMPO[tipo] ? tipo : 'info';
    const o = opcoes || {};
    const caixa = novo('div', `glr-aviso glr-aviso-${tipo}`);
    const texto = novo('div', 'glr-aviso-texto', msg == null ? '' : msg);
    texto.prepend(novo('span', 'sr-only', ROTULO[tipo] + ': '));
    const fechar = novo('button', 'glr-aviso-fechar', '✕');
    fechar.type = 'button';
    fechar.setAttribute('aria-label', 'Fechar aviso');
    caixa.appendChild(texto);
    caixa.appendChild(fechar);
    let tm = null;
    const sair = () => { if (tm) raiz.clearTimeout(tm); caixa.remove(); };
    fechar.addEventListener('click', sair);
    const ms = o.tempo === 0 ? 0 : (o.tempo || TEMPO[tipo]);
    if (ms) {
      tm = raiz.setTimeout(sair, ms);
      // passar o mouse segura o aviso na tela
      caixa.addEventListener('mouseenter', () => { if (tm) raiz.clearTimeout(tm); tm = null; });
      caixa.addEventListener('mouseleave', () => { tm = raiz.setTimeout(sair, 2500); });
    }
    pilha(tipo).appendChild(caixa);
    return { fechar: sair, el: caixa };
  };

  function dialogo(msg, o, comCampo) {
    return new Promise(resolve => {
      const d = doc();
      const antes = d.activeElement;
      const fundo = novo('div', 'glr-dialogo-fundo');
      const caixa = novo('div', 'glr-dialogo' + (o.perigo ? ' glr-dialogo-perigo' : ''));
      caixa.setAttribute('role', o.perigo ? 'alertdialog' : 'dialog');
      caixa.setAttribute('aria-modal', 'true');
      const idTxt = 'glr-dlg-' + Math.random().toString(36).slice(2, 8);
      if (o.titulo) { const t = novo('h3', 'glr-dialogo-titulo', o.titulo); caixa.appendChild(t); }
      const texto = novo('div', 'glr-dialogo-texto', msg == null ? '' : msg);
      texto.id = idTxt;
      caixa.setAttribute('aria-describedby', idTxt);
      caixa.setAttribute('aria-label', o.titulo || (comCampo ? 'Informe um valor' : 'Confirmar'));
      caixa.appendChild(texto);
      let campo = null;
      if (comCampo) {
        campo = novo('input', 'glr-dialogo-campo');
        campo.type = 'text';
        campo.value = o.valor == null ? '' : String(o.valor);
        if (o.placeholder) campo.placeholder = o.placeholder;
        campo.setAttribute('aria-labelledby', idTxt);
        caixa.appendChild(campo);
      }
      const acoes = novo('div', 'glr-dialogo-acoes');
      const nao = novo('button', 'btn btn-secondary', o.cancelar || 'Cancelar'); nao.type = 'button';
      const sim = novo('button', 'btn ' + (o.perigo ? 'btn-perigo' : 'btn-primary'), o.ok || (comCampo ? 'OK' : 'Confirmar')); sim.type = 'button';
      acoes.appendChild(nao); acoes.appendChild(sim);
      caixa.appendChild(acoes);
      fundo.appendChild(caixa);
      let feito = false;
      const fim = v => {
        if (feito) return; feito = true;
        d.removeEventListener('keydown', tecla, true);
        fundo.remove();
        try { antes && antes.focus && antes.focus(); } catch (e) {}
        resolve(v);
      };
      const confirmar = () => fim(comCampo ? campo.value : true);
      const cancelar = () => fim(comCampo ? null : false);
      function tecla(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelar(); }
        else if (e.key === 'Enter' && (comCampo ? e.target === campo : e.target !== nao)) { e.preventDefault(); confirmar(); }
        else if (e.key === 'Tab') { // foco fica dentro do diálogo
          const f = [campo, nao, sim].filter(Boolean), i = f.indexOf(d.activeElement);
          e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
        }
      }
      sim.addEventListener('click', confirmar);
      nao.addEventListener('click', cancelar);
      fundo.addEventListener('click', e => { if (e.target === fundo) cancelar(); });
      d.addEventListener('keydown', tecla, true);
      d.body.appendChild(fundo);
      // ação perigosa começa com o foco em "Cancelar", para um Enter distraído não apagar nada
      (campo || (o.perigo ? nao : sim)).focus();
    });
  }
  G.confirmar = (msg, opcoes) => dialogo(msg, opcoes || {}, false);
  G.perguntar = (msg, opcoes) => dialogo(msg, opcoes || {}, true);

  // Erro no próprio campo: borda vermelha, texto logo abaixo e foco; some quando o usuário corrige
  G.erroCampo = function (campo, msg, opcoes) {
    const focar = !(opcoes && opcoes.foco === false);
    const el = typeof campo === 'string' ? doc().getElementById(campo) : campo;
    if (!el || !el.isConnected) { G.avisar(msg, 'erro'); return false; }
    const id = (el.id || 'campo') + '-erro';
    let txt = doc().getElementById(id);
    if (!txt) { txt = novo('div', 'glr-campo-erro'); txt.id = id; el.insertAdjacentElement('afterend', txt); }
    txt.textContent = String(msg);
    el.classList.add('glr-campo-invalido');
    el.setAttribute('aria-invalid', 'true');
    el.setAttribute('aria-describedby', id);
    const limpar = () => { el.classList.remove('glr-campo-invalido'); el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); txt.remove(); el.removeEventListener('input', limpar); el.removeEventListener('change', limpar); };
    el.addEventListener('input', limpar);
    el.addEventListener('change', limpar);
    if (focar) {
      try { el.scrollIntoView && el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      try { el.focus({ preventScroll: true }); } catch (e) {}
    }
    return false;
  };

  // Valida vários campos de uma vez: marca todos os que falharam e foca o primeiro.
  // regras: [[condiçãoOk, campo (id ou elemento), mensagem], ...] → true se tudo ok
  G.validar = function (regras) {
    let ok = true;
    for (const [passou, campo, msg] of regras) {
      if (passou) continue;
      G.erroCampo(campo, msg, { foco: ok });
      ok = false;
    }
    return ok;
  };
})(typeof window !== 'undefined' ? window : globalThis);

// ── Estado único de vazio / carregando / erro ──
// GLR.estado('erro', { erro, oque: 'os clientes' }) devolve o HTML de um bloco
// padrão que diz o que aconteceu e o que fazer, com botão de ação. Os botões
// usam data-* (sem onclick em texto): "Tentar de novo" redesenha a tela atual,
// e { acao: { rotulo, rota } } leva para outra tela.
(function (raiz) {
  const G = raiz.GLR || (typeof GLR !== 'undefined' ? GLR : (raiz.GLR = {}));
  const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // mensagem técnica → o que aconteceu e o que fazer, em português
  G.erroAmigavel = function (erro) {
    const m = String(erro?.message ?? erro ?? '');
    const r = (titulo, texto, extra) => ({ titulo, texto, tecnico: m, ...extra });
    if (/failed to fetch|networkerror|load failed|err_internet|network request failed|offline/i.test(m)) return r('Sem conexão', 'Confira a internet e tente de novo.');
    if (/_sb is not defined|supabase is not defined|createClient/i.test(m)) return r('O sistema ainda está abrindo', 'Espere alguns segundos e tente de novo. Se continuar, recarregue a página.');
    if (/jwt|\b401\b|unauthori[sz]ed|sess[aã]o expir|invalid.*token/i.test(m)) return r('Sua sessão expirou', 'Saia da conta e entre de novo.');
    if (/\b403\b|permission denied|row-level security|rls|forbidden|sem permiss/i.test(m)) return r('Sem acesso a estes dados', 'Peça acesso a um administrador da GLR.');
    if (/\b429\b|cota|quota|rate.?limit|too many requests/i.test(m)) return r('Limite de consultas atingido', 'A cota diária da Tiops acabou. Os dados voltam sozinhos quando ela renovar, às 21h.');
    if (/timeout|timed out|aborterror|demorou/i.test(m)) return r('A consulta demorou demais', 'Tente de novo em alguns segundos.');
    if (/\b50[0-4]\b|internal server|bad gateway|service unavailable/i.test(m)) return r('O servidor está com problema agora', 'Tente de novo em alguns minutos. Se continuar, veja Sistema › Saúde da API.', { acao: { rotulo: 'Ver Saúde da API', rota: 'sistema', aba: 'saude-api' } });
    return r('Algo deu errado', 'Tente de novo. Se continuar, veja Sistema › Diagnóstico.', { acao: { rotulo: 'Abrir Diagnóstico', rota: 'sistema', aba: 'diagnostico' } });
  };

  const ICONES = { vazio: '○', erro: '!', carregando: '' };
  G.estado = function (tipo, o = {}) {
    tipo = ICONES.hasOwnProperty(tipo) ? tipo : 'vazio';
    let titulo = o.titulo, texto = o.texto, tecnico = '', acao = o.acao;
    if (tipo === 'erro') {
      const a = G.erroAmigavel(o.erro);
      titulo = titulo || (o.oque ? `Não consegui carregar ${o.oque}` : a.titulo);
      texto = texto || (o.oque ? `${a.titulo}. ${a.texto}` : a.texto);
      tecnico = a.tecnico;
      acao = acao || a.acao;
    }
    if (tipo === 'carregando') titulo = titulo || 'Carregando…';
    const botoes = [];
    if (tipo === 'erro' && o.tentar !== false) botoes.push(`<button type="button" class="btn btn-primary btn-sm" data-estado-tentar>Tentar de novo</button>`);
    if (acao && acao.rota) botoes.push(`<button type="button" class="btn btn-secondary btn-sm" data-estado-rota="${esc(acao.rota)}"${acao.aba ? ` data-estado-aba="${esc(acao.aba)}"` : ''}>${esc(acao.rotulo || 'Abrir')}</button>`);
    const papel = tipo === 'erro' ? 'role="alert"' : tipo === 'carregando' ? 'role="status" aria-busy="true"' : 'role="status"';
    return `<div class="glr-estado glr-estado-${tipo}${o.compacto ? ' compacto' : ''}" ${papel}>`
      + (tipo === 'carregando' ? '<span class="glr-estado-giro" aria-hidden="true"></span>' : `<span class="glr-estado-ic" aria-hidden="true">${ICONES[tipo]}</span>`)
      + `<div class="glr-estado-tit">${esc(titulo || 'Nada por aqui ainda')}</div>`
      + (texto ? `<div class="glr-estado-txt">${esc(texto)}</div>` : '')
      + (botoes.length ? `<div class="glr-estado-acoes">${botoes.join('')}</div>` : '')
      + (tecnico ? `<details class="glr-estado-tec"><summary>Detalhe técnico</summary><code>${esc(tecnico)}</code></details>` : '')
      + '</div>';
  };

  if (raiz.document && raiz.document.addEventListener) raiz.document.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('[data-estado-tentar], [data-estado-rota]') : null;
    if (!b || typeof Router === 'undefined') return;
    if (b.hasAttribute('data-estado-tentar')) { b.disabled = true; b.textContent = 'Tentando…'; Router.resolve(); return; }
    Router.navigate(b.dataset.estadoRota, b.dataset.estadoAba ? { aba: b.dataset.estadoAba } : {});
  });
})(typeof window !== 'undefined' ? window : globalThis);
