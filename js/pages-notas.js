// ============================================================
// GLR Consultoria — Notas e etiquetas (portal do cliente)
// ------------------------------------------------------------
// Pedidos a enviar do Mercado Livre e da Shopee das contas do cliente, com a nota
// fiscal de cada um: prévia (sem número, sem SEFAZ), emissão pelo Emissor NF-e da
// Tiops e DANFE (etiqueta 10×15 para o pacote ou A4). O servidor (api/_nfe.js) usa
// a chave do emissor DO CLIENTE, guardada só no servidor — a tela nunca a recebe.
// Toda nota sai em homologação (teste, sem valor fiscal) até o cliente escolher
// Produção — que também precisa estar liberada para a empresa no painel do emissor.
// A etiqueta de envio do marketplace entra numa próxima etapa.
// ============================================================
Router.register('notas', (params, el) => {
  const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const dataBR = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const MKT = { ml: { s: 'ML', c: '#d9a400', n: 'Mercado Livre' }, shopee: { s: 'SH', c: '#eb6834', n: 'Shopee' } };
  const SIT = { autorizada: ['Autorizada', 'var(--green)'], processando: ['Processando', 'var(--yellow)'], pendente_consulta: ['Aguardando SEFAZ', 'var(--yellow)'], rejeitada: ['Rejeitada', 'var(--red)'], denegada: ['Denegada', 'var(--red)'], cancelada: ['Cancelada', 'var(--text-muted)'] };
  const lerAmb = () => { try { return localStorage.getItem('glr_nfe_ambiente') === 'producao' ? 'producao' : 'homologacao'; } catch (e) { return 'homologacao'; } };
  const st = { carregando: true, emissor: null, pedidos: [], erro: null, ambiente: lerAmb(), empresa: '', ocupado: {}, msg: null, previa: null };
  const call = (a, p = {}) => MarketplaceAPI.call(a, p);

  async function carregar() {
    st.carregando = true; st.erro = null; render();
    try {
      st.emissor = await call('glr_nfe_status');
      if (st.emissor?.temChave) {
        const r = await call('glr_nfe_pedidos');
        st.pedidos = r.pedidos || []; st.emissor = r.emissor || st.emissor;
        if (!st.empresa && st.emissor?.empresas?.length === 1) st.empresa = st.emissor.empresas[0].id;
      }
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  const empresaDo = p => p.empresaId || st.empresa;
  async function acao(p, tipo) {
    const k = `${p.mkt}:${p.pedido}`;
    const empresaId = empresaDo(p);
    if ((tipo === 'previa' || tipo === 'emitir') && !empresaId) { alert('Escolha no topo a empresa que emite a nota.'); return; }
    if (tipo === 'emitir') {
      const prod = st.ambiente === 'producao';
      if (!confirm(prod ? `Emitir a NOTA FISCAL de verdade (produção) do pedido ${p.pedido}?\n\nEla vai para a SEFAZ e tem valor fiscal.` : `Emitir a nota do pedido ${p.pedido} em HOMOLOGAÇÃO (teste, sem valor fiscal)?`)) return;
    }
    st.ocupado[k] = tipo; render();
    try {
      if (tipo === 'previa') {
        const r = await call('glr_nfe_previa', { mkt: p.mkt, conta: p.conta, pedido: p.pedido, orderIds: p.orderIds, empresaId, ambiente: st.ambiente });
        st.previa = { p, dados: r.previa };
      } else if (tipo === 'emitir') {
        const r = await call('glr_nfe_emitir', { mkt: p.mkt, conta: p.conta, pedido: p.pedido, orderIds: p.orderIds, empresaId, ambiente: st.ambiente });
        p.nota = r.nota;
        if (p.nota && ['processando', 'pendente_consulta'].includes(p.nota.situacao)) setTimeout(() => atualizarNota(p), 6000);
      } else if (tipo === 'danfe' || tipo === 'a4') {
        const r = await call('glr_nfe_danfe', { id: p.nota.id, formato: tipo === 'a4' ? 'a4' : 'etiqueta' });
        if (r.url) window.open(r.url, '_blank', 'noopener'); else alert('O emissor não devolveu o link do DANFE.');
      }
    } catch (e) { alert(e.message || String(e)); }
    delete st.ocupado[k]; render();
  }
  async function atualizarNota(p) {
    try { const r = await call('glr_nfe_nota', { id: p.nota.id }); p.nota = r.nota; render(); if (['processando', 'pendente_consulta'].includes(p.nota?.situacao)) setTimeout(() => atualizarNota(p), 8000); } catch (e) {}
  }
  async function salvarChave() {
    const v = document.getElementById('nf-chave')?.value?.trim();
    if (!v) return;
    st.msg = 'Conferindo a chave…'; render();
    try { const r = await call('glr_nfe_chave', { chave: v }); st.msg = `Chave conferida${r.conta ? ` — conta ${r.conta}` : ''}.`; await carregar(); }
    catch (e) { st.msg = '❌ ' + (e.message || e); render(); }
  }
  async function trocarChave() {
    if (!confirm('Remover a chave do emissor? Para emitir de novo será preciso cadastrar outra.')) return;
    try { await call('glr_nfe_chave', { remover: true }); st.emissor = { temChave: false }; st.pedidos = []; render(); } catch (e) { alert(e.message); }
  }

  function renderSemChave() {
    return `<div class="card nf-card">
      <div class="nf-tit">Conectar o emissor de notas</div>
      <ol class="nf-passos">
        <li>Crie sua conta em <a href="https://nfe.tiops.com.br" target="_blank" rel="noopener">nfe.tiops.com.br</a>.</li>
        <li>Cadastre sua empresa e envie o <b>certificado digital A1</b> (arquivo .pfx).</li>
        <li>Em <b>Lojas</b>, vincule suas lojas do Mercado Livre e da Shopee à empresa (assim a nota já vai sozinha para o pedido).</li>
        <li>Em <b>Chaves de API</b>, gere uma chave com nível <b>eventos</b> (ou emissão) e cole abaixo.</li>
      </ol>
      <div class="nf-linha"><input id="nf-chave" class="form-control" type="password" autocomplete="off" placeholder="nfe_…" style="max-width:420px">
        <button class="btn btn-primary btn-sm" onclick="window._nfSalvarChave()">Conectar</button></div>
      <div class="nf-sub">A chave fica guardada só no servidor da GLR — ela não aparece mais na tela depois de salva.</div>
      ${st.msg ? `<div class="nf-sub" style="margin-top:6px">${h(st.msg)}</div>` : ''}
    </div>`;
  }

  function render() {
    const root = document.getElementById('nf-root'); if (!root) return;
    if (st.carregando && !st.emissor) { root.innerHTML = '<div class="card nf-vazio">Carregando…</div>'; return; }
    if (st.erro && !st.emissor) { root.innerHTML = `<div class="card nf-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    if (!st.emissor?.temChave) { root.innerHTML = renderSemChave(); return; }
    const em = st.emissor, emp = em.empresas || [];
    const empSel = emp.find(e => e.id === st.empresa);
    const podeProd = !empSel || empSel.producao;
    const pend = st.pedidos.filter(p => !p.erro && !(p.nota && p.nota.situacao === 'autorizada'));
    root.innerHTML = `
      <div class="card nf-topo">
        <div><div class="nf-tit" style="margin:0">Emissor conectado${em.conta ? ` — ${h(em.conta)}` : ''}</div>
          <div class="nf-sub">${emp.length} empresa(s) · ${(em.lojas || []).filter(l => l.empresaId).length} loja(s) vinculada(s)${em.erro ? ` · <span style="color:var(--red)">${h(em.erro)}</span>` : ''}</div></div>
        ${emp.length > 1 ? `<label class="nf-campo">Empresa (pedidos de loja não vinculada)<select class="form-control" onchange="window._nfEmpresa(this.value)"><option value="">Escolha…</option>${emp.map(e => `<option value="${h(e.id)}" ${e.id === st.empresa ? 'selected' : ''}>${h(e.nome)}${e.cnpj ? ` · ${h(e.cnpj)}` : ''}</option>`).join('')}</select></label>` : ''}
        <div class="nf-amb" role="group" aria-label="Ambiente">
          <button class="${st.ambiente === 'homologacao' ? 'on' : ''}" onclick="window._nfAmb('homologacao')">Homologação (teste)</button>
          <button class="${st.ambiente === 'producao' ? 'on prod' : ''}" ${podeProd ? '' : 'disabled title="Produção ainda não liberada para esta empresa no painel do emissor"'} onclick="window._nfAmb('producao')">Produção</button>
        </div>
        <span style="flex:1"></span>
        <button class="btn btn-secondary btn-sm" ${st.carregando ? 'disabled' : ''} onclick="window._nfRecarregar()">${st.carregando ? 'Buscando…' : '↻ Atualizar pedidos'}</button>
        <button class="btn btn-secondary btn-sm" onclick="window._nfTrocarChave()" title="Remover a chave do emissor">Trocar chave</button>
      </div>
      ${st.ambiente === 'producao' ? '<div class="nf-aviso">Produção: as notas vão para a SEFAZ e têm valor fiscal.</div>' : '<div class="nf-sub" style="margin:-4px 0 10px">Em homologação as notas são de teste (sem valor fiscal). Confira algumas e depois mude para Produção.</div>'}
      <div class="nf-sub" style="margin-bottom:8px">${pend.length} pedido(s) a enviar sem nota autorizada · últimos 15 dias · Mercado Livre e Shopee</div>
      <div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="nf-tab" data-todas-colunas>
        <thead><tr><th>Pedido</th><th>Itens</th><th class="n">Total</th><th>NCM</th><th>Nota</th><th></th></tr></thead>
        <tbody>${st.pedidos.map((p, i) => {
          if (p.erro) return `<tr><td colspan="6" class="nf-sub" style="color:var(--red)">${h(MKT[p.mkt]?.n || p.mkt)} ${h(p.conta)}: ${h(p.erro)}</td></tr>`;
          const k = `${p.mkt}:${p.pedido}`, oc = st.ocupado[k], n = p.nota, sit = n ? SIT[n.situacao] || [n.situacao, 'var(--text-muted)'] : null;
          return `<tr>
            <td><span class="nf-mkt" style="--c:${MKT[p.mkt].c}">${MKT[p.mkt].s}</span> <b>${h(p.pedido)}</b><div class="nf-sub">${dataBR(p.data)} · ${h(p.status || '')}</div></td>
            <td class="nf-itens">${p.itens.slice(0, 3).map(it => `${h(String(it.nome).slice(0, 60))} <span class="nf-sub">×${it.qtd}</span>`).join('<br>')}${p.itens.length > 3 ? `<div class="nf-sub">+${p.itens.length - 3} item(ns)</div>` : ''}</td>
            <td class="n">${R$(p.total)}</td>
            <td>${p.semNcm ? `<a href="#produtos" class="nf-falta">falta em ${p.semNcm}</a>` : '<span style="color:var(--green)">ok</span>'}</td>
            <td>${n ? `<span class="nf-pill" style="--c:${sit[1]}">${h(sit[0])}</span>${n.numero ? ` nº ${n.numero}` : ''}${n.ambiente === 'homologacao' ? ' <span class="nf-sub">(teste)</span>' : ''}${n.motivo && n.situacao !== 'autorizada' ? `<div class="nf-sub" title="${h(n.motivo)}">${h(String(n.orientacao?.mensagem || n.motivo).slice(0, 90))}</div>` : ''}${n.envioCanal ? `<div class="nf-sub">${n.envioCanal.ok || n.envioCanal.enviado ? 'enviada ao pedido' : 'não foi ao pedido'}</div>` : ''}` : '<span class="nf-sub">sem nota</span>'}</td>
            <td class="nf-bts">
              ${n?.situacao === 'autorizada' ? `<button class="btn btn-primary btn-sm" ${oc ? 'disabled' : ''} onclick="window._nfAcao(${i},'danfe')">${oc === 'danfe' ? '…' : 'DANFE etiqueta'}</button><button class="btn btn-secondary btn-sm" ${oc ? 'disabled' : ''} onclick="window._nfAcao(${i},'a4')">A4</button>`
                : `<button class="btn btn-secondary btn-sm" ${oc || p.semNcm ? 'disabled' : ''} onclick="window._nfAcao(${i},'previa')">${oc === 'previa' ? '…' : 'Prévia'}</button><button class="btn btn-primary btn-sm" ${oc || p.semNcm ? 'disabled' : ''} onclick="window._nfAcao(${i},'emitir')">${oc === 'emitir' ? 'Emitindo…' : 'Emitir nota'}</button>`}
              <button class="btn btn-secondary btn-sm" disabled title="Etiqueta do Mercado Envios / Shopee: próxima etapa">Etiqueta envio</button>
            </td></tr>`;
        }).join('') || `<tr><td colspan="6" class="nf-vazio">${st.carregando ? 'Buscando pedidos…' : 'Nenhum pedido a enviar nos últimos 15 dias.'}</td></tr>`}</tbody>
      </table></div></div>
      ${st.previa ? renderPrevia() : ''}`;
  }
  function renderPrevia() {
    const { p, dados: d } = st.previa;
    const tot = d?.totais || d?.total || {};
    const itens = Array.isArray(d?.itens) ? d.itens : [];
    return `<div class="modal-overlay" onclick="if(event.target===this)window._nfFecharPrevia()"><div class="modal" style="max-width:720px">
      <div class="modal-header"><div class="modal-title">Prévia da nota — pedido ${h(p.pedido)}</div><button class="btn btn-secondary btn-sm" onclick="window._nfFecharPrevia()">Fechar</button></div>
      <div class="nf-sub" style="margin-bottom:10px">Sem número e sem SEFAZ: só confere como a nota sairia.</div>
      ${itens.length ? `<table class="nf-tab" data-todas-colunas><thead><tr><th>Item</th><th>NCM</th><th>CFOP</th><th class="n">Qtd</th><th class="n">Valor</th></tr></thead><tbody>${itens.map(it => `<tr><td>${h(it.descricao || it.codigo)}</td><td>${h(it.ncm || '')}</td><td>${h(it.cfop || '')}</td><td class="n">${h(it.quantidade ?? '')}</td><td class="n">${R$(it.valorTotal ?? it.valor ?? (it.valorUnitario * it.quantidade))}</td></tr>`).join('')}</tbody></table>` : ''}
      <pre class="nf-json">${h(JSON.stringify(Object.keys(tot).length ? tot : d, null, 2).slice(0, 4000))}</pre>
    </div></div>`;
  }

  window._nfSalvarChave = salvarChave;
  window._nfTrocarChave = trocarChave;
  window._nfRecarregar = carregar;
  window._nfEmpresa = v => { st.empresa = v; render(); };
  window._nfAmb = v => {
    if (v === 'producao' && !confirm('Mudar para PRODUÇÃO? As próximas notas terão valor fiscal.')) return;
    st.ambiente = v; try { localStorage.setItem('glr_nfe_ambiente', v); } catch (e) {} render();
  };
  window._nfAcao = (i, tipo) => { const p = st.pedidos[i]; if (p) acao(p, tipo); };
  window._nfFecharPrevia = () => { st.previa = null; render(); };

  el.innerHTML = `<div class="page">
    <div class="ajuda">Emita a nota fiscal dos pedidos a enviar do Mercado Livre e da Shopee e imprima o DANFE simplificado (etiqueta 10×15) para o pacote. Comece em homologação (teste) e, quando estiver tudo certo, mude para Produção. Os produtos precisam do NCM cadastrado na tela Produtos.</div>
    <div id="nf-root"></div>
  </div>
  <style>
    .nf-sub{font-size:12px;color:var(--text-muted);line-height:1.5}
    .nf-vazio{padding:24px;text-align:center;color:var(--text-muted)}
    .nf-card{padding:18px 20px;max-width:760px}
    .nf-tit{font-weight:700;font-size:15px;margin-bottom:8px}
    .nf-passos{margin:0 0 14px 18px;font-size:13px;line-height:1.8;color:var(--text-secondary)}
    .nf-passos a{color:var(--accent)}
    .nf-linha{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
    .nf-topo{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;padding:14px 16px;margin-bottom:12px}
    .nf-campo{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)}
    .nf-amb{display:inline-flex;border:1px solid var(--border);border-radius:9px;overflow:hidden}
    .nf-amb button{border:0;background:var(--bg-card);color:var(--text-secondary);padding:7px 12px;font-size:12.5px;cursor:pointer}
    .nf-amb button.on{background:var(--accent);color:#fff} .nf-amb button.on.prod{background:var(--red)}
    .nf-amb button:disabled{opacity:.5;cursor:not-allowed}
    .nf-aviso{background:color-mix(in srgb,var(--red) 10%,transparent);color:var(--red);border-radius:9px;padding:8px 12px;font-size:12.5px;font-weight:600;margin-bottom:10px}
    .nf-tab{width:100%;border-collapse:collapse;font-size:13px}
    .nf-tab th{padding:9px 12px;text-align:left;font-size:11.5px;font-weight:600;color:var(--text-muted);background:var(--bg-card-hover);white-space:nowrap}
    .nf-tab td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top}
    .nf-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    .nf-itens{min-width:240px;max-width:380px}
    .nf-mkt{display:inline-block;font-size:11px;font-weight:700;color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent);border-radius:5px;padding:1px 6px}
    .nf-pill{display:inline-block;font-size:11.5px;font-weight:650;padding:2px 8px;border-radius:99px;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent)}
    .nf-falta{color:var(--red);font-weight:600;text-decoration:none}
    .nf-bts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;min-width:230px}
    .nf-json{background:var(--bg-subtle);border-radius:8px;padding:10px;font-size:11.5px;max-height:300px;overflow:auto;white-space:pre-wrap}
  </style>`;
  carregar();
});
