// ============================================================
// GLR Consultoria — Chat com os agentes (rota 'chat')
// ------------------------------------------------------------
// Conversa estilo ChatGPT com o copiloto da GLR (api/chat-central.js): ele
// lê o que todos os agentes sabem — plano do Gerente, meta, funil, vendas,
// produtos, ADS, estoque e margem, campanhas, Caixa de decisões — e responde
// com números e próximos passos. Mudança vira sugestão na Caixa de decisões
// (nada é aplicado sem aprovação). As conversas ficam salvas por usuário no
// servidor; o cliente em foco vem do seletor do topo.
// ============================================================
Router.register('chat', (params, el) => {
  const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerLS = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
  const gravarLS = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const st = { conversas: [], id: lerLS('glr_chat_atual', null), msgs: [], enviando: false, erro: null, listaAberta: false, carregando: true, inicio: 0, rascunho: '' };
  window._chSt = st; // respostas que chegam depois de sair da tela conferem se ainda são a tela atual

  const focoId = () => (typeof GLR !== 'undefined' && GLR.ctx?.cliente()) || null;
  const focoNome = () => { const id = focoId(); return id ? ((GLR.clientes || []).find(c => String(c.id) === String(id))?.nome || null) : null; };

  async function api(corpo) {
    const { data } = await _sb.auth.getSession();
    const r = await fetch('/api/chat-central', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data?.session?.access_token || ''}` }, body: JSON.stringify(corpo) });
    const j = await r.json().catch(() => ({ error: `Resposta inválida do servidor (HTTP ${r.status}).` }));
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  // ── Markdown simples e seguro (o texto é escapado antes) ──
  function md(texto) {
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
        const num = /^\s*\d+[.)]\s+/.test(l), itens = [];
        while (i < linhas.length && ehLista(linhas[i])) itens.push(linhas[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, '')); i--;
        blocos.push(`<${num ? 'ol' : 'ul'}>${itens.map(t => `<li>${inline(t)}</li>`).join('')}</${num ? 'ol' : 'ul'}>`);
        continue;
      }
      if (/^\s*---+\s*$/.test(l)) { blocos.push('<hr>'); continue; }
      if (!l.trim()) continue;
      const par = [l];
      while (i + 1 < linhas.length && linhas[i + 1].trim() && !/^(```|#{1,4}\s)/.test(linhas[i + 1]) && !ehLista(linhas[i + 1]) && !ehTab(linhas[i + 1])) par.push(linhas[++i]);
      blocos.push(`<p>${par.map(inline).join('<br>')}</p>`);
    }
    return blocos.join('');
  }

  const SUG_CLIENTE = n => [
    `Onde a ${n} está perdendo venda e o que fazer hoje?`,
    `Monte um plano para a ${n} bater a meta do mês`,
    `Quais campanhas da ${n} posso acelerar sem estourar o TACOS?`,
    `Quais produtos da ${n} têm visita e não vendem?`,
  ];
  const SUG_CARTEIRA = [
    'Quais 5 clientes têm mais potencial de crescer esta semana, e por onde começar?',
    'Quem está mais longe da meta e o que destrava cada um?',
    'Onde tem ADS sobrando ou faltando na carteira (TACOS × teto)?',
    'Quais decisões da Caixa valem mais dinheiro para aprovar hoje?',
  ];

  function renderLista() {
    return `<button class="ch-nova" onclick="window._chNova()"><span aria-hidden="true">+</span> Nova conversa</button>
      <div class="ch-conv">${st.conversas.length ? st.conversas.map(c => `<div class="ch-ci ${c.id === st.id ? 'on' : ''}">
        <button class="ch-ci-a" onclick="window._chAbrir('${h(c.id)}')"><b>${h(c.titulo)}</b><small>${c.cliente ? `${h(c.cliente)} · ` : ''}${new Date(c.em).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</small></button>
        <button class="ch-ci-x" title="Apagar conversa" aria-label="Apagar conversa" onclick="window._chApagar('${h(c.id)}')">✕</button></div>`).join('') : '<div class="ch-vazia-l">Suas conversas aparecem aqui.</div>'}</div>`;
  }

  function renderMsg(m, i) {
    if (m.r === 'user') return `<div class="ch-m ch-u"><div class="ch-b">${h(m.t).replace(/\n/g, '<br>')}</div></div>`;
    const fs = m.ferramentas || [];
    return `<div class="ch-m ch-a"><div class="ch-av" aria-hidden="true">G</div><div class="ch-corpo">
      ${fs.length ? `<details class="ch-fontes"><summary>Consultou ${fs.length} fonte(s)</summary><div>${fs.map(f => `<span class="${f.erro ? 'erro' : ''}">${h(f.r)}</span>`).join('')}</div></details>` : ''}
      <div class="ch-md">${md(m.t)}</div>
      ${m.criadas ? `<div class="ch-criadas"><b>${m.criadas} sugestão(ões) criada(s)</b> na Caixa de decisões — nada foi aplicado ainda. <button class="ch-link" onclick="Router.navigate('decisoes')">Abrir a Caixa →</button></div>` : ''}
      <div class="ch-acoes-m"><button class="ch-link" onclick="window._chCopiar(${i}, this)">Copiar</button></div>
    </div></div>`;
  }

  function renderConversa() {
    const nome = focoNome();
    if (!st.msgs.length && !st.enviando) {
      const sug = nome ? SUG_CLIENTE(nome) : SUG_CARTEIRA;
      return `<div class="ch-inicio">
        <div class="ch-logo" aria-hidden="true">G</div>
        <h2>Como posso ajudar a escalar ${nome ? `a ${h(nome)}` : 'a carteira'} hoje?</h2>
        <p>Eu leio o que todos os agentes sabem — plano e meta, funil de visitas e conversão, vendas, ADS, estoque e margem, campanhas e a Caixa de decisões — e respondo com números e próximos passos. Se você pedir, preparo as ações na Caixa de decisões para você aprovar.</p>
        <div class="ch-sugs">${sug.map(s => `<button onclick="window._chUsar(this.textContent)">${h(s)}</button>`).join('')}</div>
      </div>`;
    }
    const pensando = st.enviando ? `<div class="ch-m ch-a"><div class="ch-av" aria-hidden="true">G</div><div class="ch-corpo"><div class="ch-pensa" role="status"><i></i><i></i><i></i><span id="ch-pensa-t">Consultando os agentes…</span></div></div></div>` : '';
    return st.msgs.map(renderMsg).join('') + pensando + (st.erro ? `<div class="ch-erro">${h(st.erro)} <button class="ch-link" onclick="window._chReenviar()">Tentar de novo</button></div>` : '');
  }

  function render() {
    if (window._chSt !== st || !document.getElementById('ch-root')) return;
    const nome = focoNome();
    document.getElementById('ch-root').innerHTML = `
      <aside class="ch-lista ${st.listaAberta ? 'aberta' : ''}">${renderLista()}</aside>
      <section class="ch-main">
        <div class="ch-topo">
          <button class="ch-menu" onclick="window._chLista()" aria-label="Conversas">☰</button>
          <span class="ch-foco">${nome ? `Falando sobre <b>${h(nome)}</b>` : 'Falando sobre <b>a carteira inteira</b>'} <small>· troque no seletor de cliente do topo</small></span>
        </div>
        <div class="ch-msgs" id="ch-msgs"><div class="ch-col">${st.carregando ? '<div class="ch-carregando">Abrindo a conversa…</div>' : renderConversa()}</div></div>
        <div class="ch-comp"><div class="ch-col">
          <div class="ch-caixa">
            <textarea id="ch-in" rows="1" aria-label="Mensagem" placeholder="${nome ? `Pergunte sobre a ${h(nome)} ou peça um plano…` : 'Pergunte sobre qualquer cliente ou sobre a carteira…'}" ${st.enviando ? 'disabled' : ''}></textarea>
            <button class="ch-env" aria-label="Enviar" ${st.enviando ? 'disabled' : ''} onclick="window._chEnviar()">↑</button>
          </div>
          <div class="ch-nota">O chat só lê os dados e cria sugestões na Caixa de decisões — nada é aplicado sem a sua aprovação. Promoção e ADS do Mercado Livre são sempre aplicados por você.</div>
        </div></div>
      </section>`;
    const ta = document.getElementById('ch-in');
    if (ta) {
      ta.value = st.rascunho || '';
      const crescer = () => { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; };
      crescer();
      ta.addEventListener('input', () => { st.rascunho = ta.value; crescer(); });
      ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); window._chEnviar(); } });
      if (!st.enviando) ta.focus();
    }
    const box = document.getElementById('ch-msgs'); if (box) box.scrollTop = box.scrollHeight;
  }

  // a resposta vem inteira (o agente consulta várias fontes antes); enquanto isso, mostra o que está fazendo
  const FRASES = ['Consultando os agentes…', 'Lendo o plano do Gerente…', 'Cruzando vendas, ADS e funil…', 'Conferindo estoque e margem…', 'Montando os próximos passos…'];
  let timer = null;
  function iniciarEspera() {
    clearInterval(timer); let k = 0;
    timer = setInterval(() => {
      const t = document.getElementById('ch-pensa-t'); if (!t || !st.enviando || window._chSt !== st) { clearInterval(timer); return; }
      k++; t.textContent = `${FRASES[Math.floor(k / 4) % FRASES.length]} ${Math.round((Date.now() - st.inicio) / 1000)}s`;
    }, 1000);
  }

  async function carregarLista() {
    try { st.conversas = (await api({ acao: 'listar' })).conversas || []; } catch (e) { st.conversas = []; }
  }
  async function abrir(id) {
    st.id = id; st.msgs = []; st.erro = null; st.carregando = true; st.listaAberta = false; gravarLS('glr_chat_atual', id); render();
    try { st.msgs = (await api({ acao: 'abrir', conversa_id: id })).conversa?.msgs || []; }
    catch (e) { st.id = null; gravarLS('glr_chat_atual', null); }
    st.carregando = false; render();
  }

  async function enviar(texto) {
    texto = String(texto || '').trim();
    if (!texto || st.enviando) return;
    st.msgs.push({ r: 'user', t: texto }); st.ultima = texto; st.rascunho = ''; st.enviando = true; st.erro = null; st.inicio = Date.now();
    render(); iniciarEspera();
    try {
      const j = await api({ acao: 'enviar', conversa_id: st.id, mensagem: texto, cliente_id: focoId() });
      if (window._chSt !== st) return;
      const nova = st.id !== j.conversa_id;
      st.id = j.conversa_id; gravarLS('glr_chat_atual', st.id);
      st.msgs.push({ r: 'assistant', t: j.resposta + (j.cortada ? '\n\n_(resposta cortada por tamanho — peça a continuação)_' : ''), ferramentas: j.ferramentas, criadas: j.criadas });
      if (nova || !st.conversas.some(c => c.id === st.id)) await carregarLista();
      else { const c = st.conversas.find(x => x.id === st.id); if (c) c.em = new Date().toISOString(); st.conversas.sort((a, b) => String(b.em).localeCompare(String(a.em))); }
    } catch (e) {
      if (window._chSt !== st) return;
      st.msgs.pop(); st.rascunho = texto; st.erro = `Não consegui responder: ${e.message || e}`;
    }
    st.enviando = false; render();
  }

  window._chEnviar = () => enviar(document.getElementById('ch-in')?.value);
  window._chUsar = t => enviar(t);
  window._chReenviar = () => { st.erro = null; enviar(st.rascunho || st.ultima); };
  window._chNova = () => { st.id = null; st.msgs = []; st.erro = null; st.listaAberta = false; gravarLS('glr_chat_atual', null); render(); };
  window._chAbrir = id => abrir(id);
  window._chLista = () => { st.listaAberta = !st.listaAberta; render(); };
  window._chApagar = async id => {
    if (!confirm('Apagar esta conversa?')) return;
    try { await api({ acao: 'apagar', conversa_id: id }); } catch (e) { alert('Não consegui apagar: ' + (e.message || e)); return; }
    st.conversas = st.conversas.filter(c => c.id !== id);
    if (st.id === id) window._chNova(); else render();
  };
  window._chCopiar = (i, bt) => { navigator.clipboard?.writeText(st.msgs[i]?.t || '').then(() => { if (bt) { bt.textContent = 'Copiado'; setTimeout(() => { bt.textContent = 'Copiar'; }, 1500); } }, () => {}); };

  el.innerHTML = `<div class="ch" id="ch-root"></div>
  <style>
    #page-content:has(.ch){padding:0;max-width:none;overflow:hidden}
    .ch{position:relative;display:grid;grid-template-columns:260px minmax(0,1fr);height:calc(100dvh - var(--header-h, 64px));background:var(--bg-base,var(--bg-surface))}
    .ch-lista{border-right:1px solid var(--border);background:var(--bg-card);display:flex;flex-direction:column;gap:8px;padding:12px;overflow:hidden}
    .ch-nova{all:unset;cursor:pointer;display:flex;gap:8px;align-items:center;padding:9px 12px;border:1px solid var(--border);border-radius:10px;font-weight:600;font-size:13.5px;color:var(--text-primary)} .ch-nova:hover{background:var(--bg-subtle)} .ch-nova span{font-size:16px}
    .ch-nova:focus-visible,.ch-ci-a:focus-visible,.ch-sugs button:focus-visible,.ch-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .ch-conv{overflow-y:auto;display:flex;flex-direction:column;gap:2px;margin:0 -4px;padding:0 4px}
    .ch-ci{display:flex;align-items:center;border-radius:8px} .ch-ci:hover,.ch-ci.on{background:var(--bg-subtle)}
    .ch-ci-a{all:unset;cursor:pointer;flex:1;min-width:0;padding:8px 10px;display:flex;flex-direction:column;gap:1px} .ch-ci-a b{font-size:13px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary)} .ch-ci-a small{font-size:11px;color:var(--text-muted)}
    .ch-ci-x{border:0;background:none;color:var(--text-muted);cursor:pointer;padding:6px 8px;opacity:0;border-radius:6px} .ch-ci:hover .ch-ci-x,.ch-ci-x:focus-visible{opacity:1} .ch-ci-x:hover{color:var(--red)}
    .ch-vazia-l{font-size:12.5px;color:var(--text-muted);padding:8px}
    .ch-main{display:flex;flex-direction:column;min-width:0;min-height:0}
    .ch-topo{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--border);font-size:13px;color:var(--text-secondary)} .ch-topo small{color:var(--text-muted)}
    .ch-menu{display:none;border:1px solid var(--border);background:var(--bg-card);border-radius:8px;width:32px;height:32px;cursor:pointer;color:var(--text-primary)}
    .ch-msgs{flex:1;overflow-y:auto;padding:20px 16px 8px}
    .ch-col{max-width:800px;margin:0 auto;width:100%}
    .ch-m{display:flex;gap:12px;margin-bottom:22px}
    .ch-u{justify-content:flex-end} .ch-u .ch-b{background:var(--bg-subtle);border-radius:16px;padding:10px 14px;max-width:80%;font-size:14px;line-height:1.55;color:var(--text-primary);overflow-wrap:anywhere}
    .ch-av,.ch-logo{flex-shrink:0;width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px}
    .ch-corpo{flex:1;min-width:0}
    .ch-md{font-size:14px;line-height:1.65;color:var(--text-primary)} .ch-md p{margin:0 0 10px} .ch-md ul,.ch-md ol{margin:0 0 10px;padding-left:22px} .ch-md li{margin:3px 0}
    .ch-md h3,.ch-md h4,.ch-md h5{margin:16px 0 6px;font-size:15px;font-weight:650} .ch-md code{background:var(--bg-subtle);padding:1px 5px;border-radius:5px;font-size:12.5px}
    .ch-md pre{background:var(--bg-subtle);padding:10px 12px;border-radius:8px;overflow-x:auto} .ch-md pre code{background:none;padding:0} .ch-md hr{border:0;border-top:1px solid var(--border);margin:14px 0}
    .ch-tab{overflow-x:auto;margin:0 0 12px;border:1px solid var(--border);border-radius:10px} .ch-tab table{border-collapse:collapse;width:100%;font-size:13px} .ch-tab th{text-align:left;font-weight:600;background:var(--bg-subtle);padding:7px 10px;white-space:nowrap} .ch-tab td{padding:7px 10px;border-top:1px solid var(--border);font-variant-numeric:tabular-nums;vertical-align:top}
    .ch-fontes{margin-bottom:6px} .ch-fontes summary{cursor:pointer;font-size:12px;color:var(--text-muted);list-style:none} .ch-fontes summary::before{content:'▸ '} .ch-fontes[open] summary::before{content:'▾ '}
    .ch-fontes div{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px} .ch-fontes span{font-size:11.5px;background:var(--bg-subtle);border-radius:6px;padding:2px 8px;color:var(--text-secondary)} .ch-fontes span.erro{color:var(--red)}
    .ch-criadas{margin-top:6px;font-size:13px;padding:9px 12px;border-radius:10px;background:color-mix(in srgb,var(--green) 12%,transparent);color:var(--text-primary)}
    .ch-acoes-m{margin-top:4px;opacity:0;transition:opacity .15s} .ch-a:hover .ch-acoes-m,.ch-acoes-m:focus-within{opacity:1} @media (hover:none){.ch-acoes-m{opacity:1}}
    .ch-link{all:unset;cursor:pointer;color:var(--accent);font-size:12.5px;font-weight:600} .ch-link:hover{text-decoration:underline}
    .ch-pensa{display:flex;align-items:center;gap:5px;font-size:13px;color:var(--text-muted);padding-top:6px} .ch-pensa i{width:7px;height:7px;border-radius:50%;background:var(--text-muted);animation:chp 1.2s infinite ease-in-out} .ch-pensa i:nth-child(2){animation-delay:.15s} .ch-pensa i:nth-child(3){animation-delay:.3s} .ch-pensa span{margin-left:6px}
    @keyframes chp{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
    @media (prefers-reduced-motion:reduce){.ch-pensa i{animation:none;opacity:.6}}
    .ch-erro{font-size:13px;color:var(--red);margin:-8px 0 16px 42px}
    .ch-carregando{color:var(--text-muted);font-size:13px;padding:30px 0;text-align:center}
    .ch-inicio{display:flex;flex-direction:column;align-items:center;text-align:center;padding:8vh 0 20px;gap:10px} .ch-logo{width:44px;height:44px;font-size:18px}
    .ch-inicio h2{font-size:22px;font-weight:650;margin:6px 0 0;text-wrap:balance} .ch-inicio p{font-size:13.5px;color:var(--text-secondary);max-width:560px;line-height:1.55;margin:0}
    .ch-sugs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;width:100%;max-width:640px;margin-top:14px}
    .ch-sugs button{all:unset;cursor:pointer;text-align:left;padding:11px 13px;border:1px solid var(--border);border-radius:12px;font-size:13px;line-height:1.4;color:var(--text-primary);background:var(--bg-card)} .ch-sugs button:hover{background:var(--bg-subtle)}
    .ch-comp{padding:8px 16px 14px}
    .ch-caixa{display:flex;align-items:flex-end;gap:8px;border:1px solid var(--border);border-radius:18px;background:var(--bg-card);padding:8px 8px 8px 14px;box-shadow:var(--shadow-sm)} .ch-caixa:focus-within{border-color:var(--accent)}
    .ch-caixa textarea{flex:1;border:0;outline:0;resize:none;background:transparent;font:inherit;font-size:14px;line-height:1.5;color:var(--text-primary);max-height:200px;padding:5px 0}
    .ch-env{width:34px;height:34px;border-radius:50%;border:0;background:var(--accent);color:#fff;font-size:17px;font-weight:700;cursor:pointer;flex-shrink:0} .ch-env:disabled{opacity:.4;cursor:default} .ch-env:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .ch-nota{font-size:11px;color:var(--text-muted);text-align:center;margin-top:6px}
    @media (max-width:860px){
      .ch{grid-template-columns:1fr}
      .ch-lista{position:absolute;z-index:20;top:0;bottom:0;left:0;width:270px;transform:translateX(-105%);transition:transform .2s;box-shadow:var(--shadow-sm)} .ch-lista.aberta{transform:none}
      .ch-menu{display:inline-block} .ch-sugs{grid-template-columns:1fr} .ch-topo small{display:none}
    }
  </style>`;

  render();
  (async () => {
    await carregarLista();
    if (window._chSt !== st) return;
    if (st.id && st.conversas.some(c => c.id === st.id)) await abrir(st.id);
    else { st.id = null; st.carregando = false; render(); }
  })();
});

// a tela antiga "IA Copiloto" (respostas por regra) foi substituída pelo chat com os agentes
Router.register('ia', () => Router.navigate('chat'));
