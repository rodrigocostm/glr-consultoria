// ============================================================
// GLR Consultoria — Blog (tela da equipe)
// ------------------------------------------------------------
// Rascunhos que o agente escreve todo dia às 06:00 a partir do RSS dos portais
// do varejo digital (api/_blog.js): a equipe confere, edita e publica em
// consultoriaglr.com.br/blog. Nada vai ao ar sem "Publicar". Cada post tem o
// link da matéria original para conferir o que o texto afirma.
// Servidor: api/blog.js (POST listar/salvar/publicar/despublicar/descartar/gerar).
// ============================================================
Router.register('blog', (params, el) => {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const data = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const ABAS = [['rascunho', 'Rascunhos'], ['publicado', 'Publicados'], ['descartado', 'Descartados']];
  const st = { posts: [], fontes: [], carregando: true, erro: null, aba: 'rascunho', editando: null, proc: {}, gerando: false, aviso: null };
  window._blSt = st;

  async function api(corpo) {
    const r = await window.glrApiFetch('/api/blog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  async function carregar() {
    st.carregando = true; render();
    try { const j = await api({ acao: 'listar' }); st.posts = j.posts || []; st.fontes = j.fontes || []; st.erro = null; } catch (e) { st.erro = e.message; }
    st.carregando = false; render();
  }

  function render() {
    if (window._blSt !== st) return;
    const root = document.getElementById('bl-root'); if (!root) return;
    if (st.carregando && !st.posts.length) { root.innerHTML = '<div class="card bl-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card bl-vazio" style="color:var(--red)">Não consegui carregar o blog: ${h(st.erro)}</div>`; return; }
    const cont = k => st.posts.filter(p => p.status === k).length;
    const lista = st.posts.filter(p => p.status === st.aba).sort((a, b) => String(b.publicado_em || b.criado_em).localeCompare(String(a.publicado_em || a.criado_em)));
    root.innerHTML = `
      <div class="bl-topo">
        <div class="bl-abas" role="tablist">${ABAS.map(([k, t]) => `<button role="tab" aria-selected="${st.aba === k}" class="${st.aba === k ? 'on' : ''}" onclick="window._blAba('${k}')">${t} <b>${cont(k)}</b></button>`).join('')}</div>
        <span style="flex:1"></span>
        <a class="btn btn-ghost btn-sm" href="/blog" target="_blank" rel="noopener">Ver o blog no site ↗</a>
        ${(() => { const n = st.posts.filter(p => p.status === 'publicado' && !p.foto?.url).length; return n || st.fotos ? `<button class="btn btn-secondary btn-sm" ${st.fotos ? 'disabled' : ''} onclick="window._blFotos()">${st.fotos ? h(st.fotos) : `Gerar fotos dos publicados (${n})`}</button>` : ''; })()}
        <button class="btn btn-primary btn-sm" ${st.gerando ? 'disabled' : ''} onclick="window._blGerar()">${st.gerando ? 'Lendo os portais e escrevendo… (até 2 min)' : 'Gerar rascunhos agora'}</button>
      </div>
      ${st.aviso ? `<div class="bl-aviso">${h(st.aviso)}</div>` : ''}
      ${lista.length ? `<div class="bl-lista">${lista.map(card).join('')}</div>`
        : `<div class="card bl-vazio"><b>${st.aba === 'rascunho' ? 'Nenhum rascunho esperando revisão.' : st.aba === 'publicado' ? 'Nada publicado ainda.' : 'Nenhum post descartado.'}</b>${st.aba === 'rascunho' ? `<span>Todo dia às 6h o agente lê ${st.fontes.length || 'os'} portais (${h(st.fontes.join(', '))}) e escreve até 3 rascunhos com as notícias mais relevantes para quem vende em marketplace.</span>` : ''}</div>`}`;
  }

  function card(p) {
    const ed = st.editando === p.id, proc = st.proc[p.id];
    if (ed) return `<div class="card bl-card bl-ed">
      <label class="bl-campo" for="bl-tit">Título <input id="bl-tit" class="form-control" maxlength="140" value="${h(p.titulo)}"></label>
      <label class="bl-campo" for="bl-res">Resumo (aparece no Google) <input id="bl-res" class="form-control" maxlength="200" value="${h(p.resumo)}"></label>
      <label class="bl-campo" for="bl-editoria">Categoria <select id="bl-editoria" class="form-control"><option value="">Automática</option>${[['marketplaces','Marketplaces'],['pagamentos','Pagamentos'],['logistica','Logística'],['datas','Datas e vendas'],['tecnologia','Tecnologia e IA'],['gestao','Gestão'],['varejo','Varejo e consumo']].map(([id,nome])=>`<option value="${id}" ${p.editoria===id?'selected':''}>${nome}</option>`).join('')}</select></label>
      <label class="bl-campo" for="bl-tags">Tags (separadas por vírgula) <input id="bl-tags" class="form-control" value="${h((p.tags || []).join(', '))}"></label>
      <div class="bl-ed-grid">
        <label class="bl-campo" for="bl-corpo">Texto (markdown: ## título, - lista, **negrito**) <textarea id="bl-corpo" class="form-control" rows="18" oninput="document.getElementById('bl-prev').innerHTML = window.glrMarkdown(this.value)">${h(p.corpo)}</textarea></label>
        <div class="bl-campo">Pré-visualização<div id="bl-prev" class="bl-md">${window.glrMarkdown(p.corpo)}</div></div>
      </div>
      <div class="bl-bts"><button class="btn btn-primary btn-sm" ${proc ? 'disabled' : ''} onclick="window._blSalvar('${h(p.id)}')">${proc || 'Salvar'}</button><button class="btn btn-ghost btn-sm" onclick="window._blEditar(null)">Cancelar</button></div>
    </div>`;
    const fotoBt = `<button class="btn btn-ghost btn-sm" onclick="window._blAcao('${h(p.id)}','foto')">${p.foto?.url ? 'Trocar foto' : 'Gerar foto'}</button>`;
    return `<div class="card bl-card${p.foto?.url ? ' com-foto' : ''}">
      ${p.foto?.url ? `<img class="bl-foto" src="${h(p.foto.url)}" alt="" loading="lazy" width="1200" height="675">` : p.foto_erro ? `<div class="bl-sub">Sem foto: ${h(p.foto_erro)}</div>` : ''}
      <div class="bl-meta"><span>${p.status === 'publicado' ? `publicado ${data(p.publicado_em)}` : `escrito ${data(p.criado_em)}`}</span><span>· com informações de <a href="${h(p.fonte?.url)}" target="_blank" rel="noopener">${h(p.fonte?.nome)} ↗</a></span>${(p.tags || []).map(t => `<span class="bl-tag">${h(t)}</span>`).join('')}</div>
      <h3>${h(p.titulo)}</h3>
      <p class="bl-res">${h(p.resumo)}</p>
      <details class="bl-det"><summary>Ler o texto</summary><div class="bl-md">${window.glrMarkdown(p.corpo)}</div><div class="bl-orig">Matéria original: <a href="${h(p.fonte?.url)}" target="_blank" rel="noopener">${h(p.fonte?.titulo)}</a> — confira se o texto só afirma o que está nela.</div></details>
      <div class="bl-bts">${proc ? `<span class="bl-sub">${h(proc)}</span>` : p.status === 'rascunho' ? `
        <button class="btn btn-primary btn-sm" onclick="window._blAcao('${h(p.id)}','publicar')">Publicar</button>
        <button class="btn btn-secondary btn-sm" onclick="window._blEditar('${h(p.id)}')">Editar</button>
        ${fotoBt}
        <button class="btn btn-ghost btn-sm" onclick="window._blAcao('${h(p.id)}','descartar')">Descartar</button>` : p.status === 'publicado' ? `
        <a class="btn btn-secondary btn-sm" href="/blog/${h(p.slug)}" target="_blank" rel="noopener">Ver no site ↗</a>
        <button class="btn btn-secondary btn-sm" onclick="window._blEditar('${h(p.id)}')">Editar</button>
        ${fotoBt}
        <button class="btn btn-ghost btn-sm" onclick="window._blAcao('${h(p.id)}','despublicar')">Tirar do ar</button>` : `
        <button class="btn btn-secondary btn-sm" onclick="window._blAcao('${h(p.id)}','despublicar')">Voltar para rascunho</button>`}</div>
    </div>`;
  }

  const troca = post => { const i = st.posts.findIndex(x => x.id === post.id); if (i >= 0) st.posts[i] = post; };
  window._blAba = k => { st.aba = k; st.editando = null; render(); };
  window._blEditar = id => { st.editando = id; render(); };
  window._blSalvar = async id => {
    const v = k => document.getElementById(k)?.value || '';
    st.proc[id] = 'Salvando…'; render();
    try { const j = await api({ acao: 'salvar', id, titulo: v('bl-tit'), resumo: v('bl-res'), tags: v('bl-tags'), editoria: v('bl-editoria'), corpo: v('bl-corpo') }); troca(j.post); st.editando = null; }
    catch (e) { alert('Não consegui salvar: ' + e.message); }
    delete st.proc[id]; render();
  };
  const TXT = { publicar: ['Publicar no site? O post fica visível para todos em consultoriaglr.com.br/blog.', 'Publicando…'], descartar: ['Descartar este rascunho?', 'Descartando…'], despublicar: [null, 'Atualizando…'], foto: [null, 'Gerando a foto… (até 30 s)'] };
  window._blAcao = async (id, acao) => {
    if (TXT[acao][0] && !confirm(TXT[acao][0])) return;
    st.proc[id] = TXT[acao][1]; render();
    try { const j = await api({ acao, id }); troca(j.post); } catch (e) { alert('Não consegui: ' + e.message); }
    delete st.proc[id]; render();
  };
  // publicadas sem foto: o servidor faz 2 por vez; repete até zerar
  window._blFotos = async () => {
    let feitas = 0; const erros = [];
    st.fotos = 'Gerando fotos…'; render();
    try {
      for (let i = 0; i < 40; i++) {
        const j = await api({ acao: 'fotos_faltando' });
        feitas += j.feitas.length; erros.push(...j.erros);
        st.fotos = `Gerando fotos… ${feitas} prontas, faltam ${j.faltam}`; render();
        if (!j.faltam || !j.feitas.length) break;
      }
      st.aviso = `${feitas} foto(s) gerada(s) e já no site.${erros.length ? ` Não deu em ${erros.length}: ${erros.slice(0, 2).join(' · ')}` : ''}`;
    } catch (e) { st.aviso = 'Não consegui gerar as fotos: ' + e.message; }
    st.fotos = null; await carregar();
  };
  window._blGerar = async () => {
    if (st.gerando) return;
    st.gerando = true; st.aviso = null; render();
    try {
      const j = await api({ acao: 'gerar', qtd: 3 });
      st.posts = j.posts || st.posts; st.aba = 'rascunho';
      st.aviso = `${j.rascunhos.length ? `${j.rascunhos.length} rascunho(s) novo(s)` : 'Nenhuma notícia nova relevante agora'} · ${j.fontes_lidas} portal(is) lido(s)${j.fontes_com_erro?.length ? ` · sem resposta: ${j.fontes_com_erro.join(', ')}` : ''}`;
    } catch (e) { st.aviso = 'Não consegui gerar: ' + e.message; }
    st.gerando = false; render();
  };

  el.innerHTML = `<div class="page">
    <div class="ajuda">Notícias do varejo digital para o blog do site. Todo dia às 6h o agente lê os portais do setor e escreve rascunhos com texto próprio da GLR e o link da matéria original. Revise, edite se precisar e publique — nada vai ao ar sozinho.</div>
    <div id="bl-root"></div>
  </div>
  <style>
    .bl-sub{font-size:12.5px;color:var(--text-muted)}
    .bl-vazio{padding:28px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px} .bl-vazio span{font-size:13px;color:var(--text-muted);max-width:620px}
    .bl-topo{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .bl-abas{display:flex;gap:6px;flex-wrap:wrap} .bl-abas button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
    .bl-abas button b{color:var(--text-primary);margin-left:2px} .bl-abas button.on{border-color:var(--accent);background:var(--accent-glow);color:var(--accent-light)}
    .bl-aviso{font-size:13px;padding:9px 12px;border-radius:9px;background:var(--bg-subtle);margin-bottom:12px}
    .bl-lista{display:flex;flex-direction:column;gap:12px}
    .bl-card{padding:16px 18px;display:flex;flex-direction:column;gap:8px}
    .bl-foto{width:100%;max-width:420px;aspect-ratio:16/9;object-fit:cover;border-radius:10px;background:var(--bg-secondary,#eef1f6)}
    .bl-card h3{font-size:16.5px;font-weight:650;margin:0;line-height:1.35} .bl-res{margin:0;font-size:13.5px;color:var(--text-secondary)}
    .bl-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--text-muted)} .bl-tag{font-size:11px;font-weight:600;color:var(--accent);background:var(--accent-glow);border-radius:99px;padding:1px 8px}
    .bl-det summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--accent)} .bl-det[open] summary{margin-bottom:8px}
    .bl-md{font-size:14px;line-height:1.65;color:var(--text-primary);max-width:760px} .bl-md p{margin:0 0 10px} .bl-md h3,.bl-md h4,.bl-md h5{font-size:15px;font-weight:650;margin:14px 0 6px} .bl-md ul,.bl-md ol{padding-left:22px;margin:0 0 10px}
    .bl-orig{font-size:12.5px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:8px;margin-top:6px}
    .bl-bts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .bl-ed{gap:10px} .bl-campo{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-secondary)}
    .bl-ed-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px} .bl-ed-grid textarea{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.5}
    .bl-ed-grid .bl-md{border:1px solid var(--border);border-radius:8px;padding:10px 12px;max-height:420px;overflow:auto;background:var(--bg-surface)}
    @media (max-width:860px){.bl-ed-grid{grid-template-columns:1fr}}
  </style>`;
  carregar();
});
