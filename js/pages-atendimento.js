// ============================================================
// GLR Consultoria — Reputação e atendimento
// ------------------------------------------------------------
// Tela do Agente de Reputação e Atendimento (api/_reputacao.js, a cada 30 min
// por loja): reputação da conta, perguntas sem resposta com rascunho feito por
// IA (o analista revisa e envia — nada é respondido sozinho), reclamações
// abertas com prazo, mensagens pós-venda não lidas, devoluções da Shopee e
// produtos com reclamação repetida (que os agentes de ADS deixam de acelerar).
// ============================================================
Router.register('atendimento', (params, el) => {
  const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = (v, mult = 100) => v == null ? '—' : `${String(Math.round(v * mult * 100) / 100).replace('.', ',')}%`;
  const R$ = v => v == null ? '—' : 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const haQuanto = iso => { if (!iso) return ''; const d = (Date.now() - new Date(iso).getTime()) / 3600e3; return d < 1 ? 'agora há pouco' : d < 24 ? `há ${Math.round(d)} h` : `há ${Math.round(d / 24)} dia(s)`; };
  const data = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };

  const st = { contas: [], conta: (() => { try { return localStorage.getItem('glr_at_conta') || ''; } catch (e) { return ''; } })(), dados: null, carregando: true, erro: null, enviado: {}, enviando: {} };

  async function carregarContas() {
    st.carregando = true; render();
    try {
      const { data: rows, error } = await _sb.from('glr_sync_estado').select('marketplace,conta_id,ultimo_sucesso,resumo:cursor->resumo').eq('recurso', 'reputacao');
      if (error) throw error;
      const vinc = lerJSON('glr_mc_vinculos', {}), nomes = new Map();
      for (const c of (window.GLR?.clientes || [])) for (const ct of (vinc[String(c.id)] || [])) [ct.external_id, ct.param_to_use?.shopId, ct.param_to_use?.meliUserId].filter(Boolean).forEach(i => nomes.set(String(i), `${c.nome} · ${ct.nickname || ct.external_id}`));
      const peso = r => (r?.risco === 'alto' ? 1000 : r?.risco === 'atencao' ? 100 : 0) + (r?.perguntas || 0) + (r?.comPrazo || 0) * 5 + (r?.pedemResposta || 0) * 5;
      st.contas = (rows || []).map(r => ({ ...r, nome: GLR.nomeConta(r.marketplace, r.conta_id) })).sort((a, b) => peso(b.resumo) - peso(a.resumo) || a.nome.localeCompare(b.nome));
      if (!st.contas.some(c => `${c.marketplace}:${c.conta_id}` === st.conta)) st.conta = st.contas[0] ? `${st.contas[0].marketplace}:${st.contas[0].conta_id}` : '';
      GLR.quandoClientes(() => { st.contas.forEach(c => { c.nome = GLR.nomeConta(c.marketplace, c.conta_id); }); render(); });
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    await carregarConta();
  }
  async function carregarConta() {
    st.dados = null;
    if (!st.conta) { st.carregando = false; render(); return; }
    st.carregando = true; render();
    const [mkt, id] = st.conta.split(':');
    try {
      const { data: rows, error } = await _sb.from('glr_sync_estado').select('cursor').eq('recurso', 'reputacao').eq('marketplace', mkt).eq('conta_id', id).limit(1);
      if (error) throw error;
      st.dados = rows?.[0]?.cursor || null;
      // respondidas aqui depois da última leitura do agente não voltam para a lista
      if (st.dados?.perguntas?.length) {
        const { data: resp } = await _sb.from('glr_agente_log').select('dados').eq('conta_id', id).eq('tipo', 'decisao').gte('criado_em', new Date(Date.now() - 2 * 86400000).toISOString()).like('titulo', 'Pergunta respondida%').limit(200);
        (resp || []).forEach(l => { if (l.dados?.question_id) st.enviado[String(l.dados.question_id)] = true; });
      }
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  const RISCO = { alto: ['Em risco', 'var(--red)'], atencao: ['Atenção', 'var(--yellow)'], ok: ['Saudável', 'var(--green)'] };
  const chip = (c, t) => `<span class="at-chip" style="--c:${c}">${t}</span>`;
  const ETAPA = { claim: 'Reclamação', dispute: 'Mediação', recontact: 'Recontato' };
  const ACAO = { send_attachments: 'enviar provas', send_message_to_mediator: 'responder ao mediador', refund: 'reembolsar', send_message_to_complainant: 'responder ao comprador' };
  const MOTIVO_SH = { DAMAGED_OTHERS: 'Chegou danificado', NOT_RECEIPT: 'Não recebeu', WRONG_ITEM: 'Produto errado', ITEM_MISSING: 'Faltou item', DIFFERENT_DESCRIPTION: 'Diferente do anúncio', FUNCTIONAL_DMG: 'Defeito', CHANGE_MIND: 'Desistiu', ITEM_DAMAGED: 'Chegou danificado' };

  function render() {
    const root = document.getElementById('at-root'); if (!root) return;
    if (st.carregando && !st.contas.length) { root.innerHTML = '<div class="at-sub" style="padding:30px">Carregando…</div>'; return; }
    if (!st.contas.length) { root.innerHTML = `<div class="card" style="padding:22px"><b>O agente de Reputação e Atendimento ainda não rodou.</b><div class="at-sub" style="margin-top:6px">Ele visita cada loja da Shopee e do Mercado Livre a cada 30 minutos, junto com a sincronização automática.</div>${st.erro ? `<div class="at-sub" style="color:var(--red)">${h(st.erro)}</div>` : ''}</div>`; return; }
    const d = st.dados, ml = d?.mkt === 'ml', r = d?.resumo || {};
    const rep = d?.reputacao;
    const linkItem = id => ml ? `https://produto.mercadolivre.com.br/${String(id).replace(/^MLB/, 'MLB-')}` : `https://shopee.com.br/product/${h(d?.conta)}/${h(id)}`;
    const perguntas = (d?.perguntas || []).filter(p => !st.enviado[p.id]);
    root.innerHTML = `
      <div class="card at-topo">
        <select class="form-control" style="max-width:340px" onchange="window._atConta(this.value)">
          ${st.contas.map(c => { const k = `${c.marketplace}:${c.conta_id}`, rr = c.resumo || {}; const n = (rr.perguntas || 0) + (rr.comPrazo || 0) + (rr.pedemResposta || 0); return `<option value="${h(k)}" ${k === st.conta ? 'selected' : ''}>${h(c.nome)}${rr.risco && rr.risco !== 'ok' ? ` — ${RISCO[rr.risco][0].toLowerCase()}` : ''}${n ? ` · ${n} pendência(s)` : ''}</option>`; }).join('')}
        </select>
        <span class="at-sub">verificado ${d?.em ? haQuanto(new Date(d.em).toISOString()) : '—'} · perguntas e reclamações a cada 30 min, reputação a cada 6 h</span>
      </div>
      ${!d ? `<div class="at-sub" style="padding:20px">${st.carregando ? 'Carregando…' : 'Sem dados desta conta.'}</div>` : `
      <div class="at-grid">
        <div class="card at-card">
          <div class="at-tit">Reputação ${d.risco ? chip(RISCO[d.risco][1], RISCO[d.risco][0]) : ''}</div>
          ${d.riscoMotivo ? `<div class="at-sub" style="margin:-4px 0 10px">${h(d.riscoMotivo)}${d.risco === 'alto' ? ' — os agentes de ADS não aceleram esta conta enquanto isso durar' : ''}</div>` : ''}
          ${ml && rep ? `<div class="at-mets">
            <div><span>Nível</span><b>${h(rep.nivel)}</b><small>${rep.medalha ? 'MercadoLíder ' + h(rep.medalha) : 'sem medalha'}</small></div>
            <div><span>Reclamações (60 d)</span><b>${pct(rep.reclamacoes?.taxa)}</b><small>${rep.reclamacoes?.n ?? '—'} de ${rep.vendas60 ?? '—'} vendas</small></div>
            <div><span>Envio com atraso</span><b>${pct(rep.atrasos?.taxa)}</b><small>${rep.atrasos?.n ?? '—'} vendas</small></div>
            <div><span>Cancelamentos</span><b>${pct(rep.cancelamentos?.taxa)}</b><small>${rep.cancelamentos?.n ?? '—'} vendas</small></div>
          </div>` : !ml && rep ? `<table class="at-tab"><thead><tr><th>Métrica da Shopee</th><th>Agora</th><th>Período anterior</th><th>Meta</th><th></th></tr></thead><tbody>
            ${(rep.metricas || []).map(m => `<tr><td>${h(m.nome)}</td><td><b>${m.atual ?? '—'}${m.atual != null ? m.unidade : ''}</b></td><td>${m.anterior ?? '—'}${m.anterior != null ? m.unidade : ''}</td><td>${h(m.meta)}${m.unidade}</td><td>${m.ok ? chip('var(--green)', 'ok') : chip('var(--red)', 'fora da meta')}</td></tr>`).join('')}
          </tbody></table>` : '<div class="at-sub">Reputação ainda não lida.</div>'}
          ${ml ? `<div class="at-sub" style="margin-top:10px">Mensagens pós-venda não lidas: <b>${r.mensagens ?? '—'}</b> — responda pelo painel do Mercado Livre (Vendas → Mensagens).</div>` : ''}
        </div>
        <div class="card at-card">
          <div class="at-tit">Produtos com problema <span class="at-sub">${ml ? '2+ reclamações abertas' : '3+ devoluções em 30 dias'} — o ADS não acelera nem coloca no ADS</span></div>
          ${Object.keys(d.itens || {}).length ? Object.entries(d.itens).map(([id, x]) => `<div class="at-li"><a href="${linkItem(id)}" target="_blank" rel="noopener">${h(x.produto || id)}</a><span class="at-sub">${h(x.motivo)}</span></div>`).join('') : '<div class="at-sub">Nenhum produto com reclamação repetida.</div>'}
        </div>
      </div>
      ${ml ? `
      <div class="card at-card">
        <div class="at-tit">Perguntas sem resposta <span class="at-sub">${r.perguntas ?? 0} no total${r.perguntaMaisAntigaH != null ? ` · a mais antiga há ${r.perguntaMaisAntigaH} h` : ''} · rascunho feito com IA só com os dados do anúncio — revise antes de enviar</span></div>
        ${perguntas.length ? perguntas.map(p => `<div class="at-perg">
          <div class="at-perg-top"><a href="${linkItem(p.item)}" target="_blank" rel="noopener">${h(p.titulo || p.item)}</a><span class="at-sub">${haQuanto(p.criada)}</span></div>
          <div class="at-q">“${h(p.texto)}”</div>
          ${p.rascunho || !p.semResposta ? `<textarea id="at-r-${h(p.id)}" class="form-control" rows="3" placeholder="Escreva a resposta">${h(p.rascunho || '')}</textarea>` : `<div class="at-sub" style="color:var(--yellow)">O agente não respondeu: ${h(p.semResposta)}. Responda você.</div><textarea id="at-r-${h(p.id)}" class="form-control" rows="3" placeholder="Escreva a resposta"></textarea>`}
          <div class="at-perg-bt">${st.enviando[p.id] ? '<span class="at-sub">Enviando…</span>' : `<button class="btn btn-primary btn-sm" onclick="window._atResponder('${h(p.id)}')">Enviar resposta</button>`}${st.enviado['e' + p.id] ? `<span class="at-sub" style="color:var(--red)">${h(st.enviado['e' + p.id])}</span>` : ''}</div>
        </div>`).join('') : '<div class="at-sub">Nenhuma pergunta esperando resposta.</div>'}
      </div>
      <div class="card at-card">
        <div class="at-tit">Reclamações abertas <span class="at-sub">${r.reclamacoes ?? 0} no total · ${r.comPrazo || 0} com ação obrigatória e prazo</span></div>
        ${(d.reclamacoes || []).length ? `<div style="overflow-x:auto"><table class="at-tab"><thead><tr><th>Produto</th><th>Etapa</th><th>Aberta</th><th>Ação obrigatória</th><th>Pedido</th></tr></thead><tbody>
          ${[...d.reclamacoes].sort((a, b) => (a.prazo ? 0 : 1) - (b.prazo ? 0 : 1) || String(a.prazo).localeCompare(String(b.prazo))).map(c => `<tr>
            <td class="at-prod">${c.item ? `<a href="${linkItem(c.item)}" target="_blank" rel="noopener">${h(c.produto || c.item)}</a>` : '<span class="at-sub">produto não encontrado na base</span>'}</td>
            <td>${h(ETAPA[c.etapa] || c.etapa || '—')}</td><td>${haQuanto(c.criada)}</td>
            <td>${c.prazo ? `<b style="color:var(--red)">${h(ACAO[c.acao] || c.acao)} até ${data(c.prazo)}</b>` : '<span class="at-sub">—</span>'}</td><td class="at-sub">${h(c.pedido)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="at-sub">Nenhuma reclamação aberta.</div>'}
      </div>` : `
      <div class="card at-card">
        <div class="at-tit">Devoluções dos últimos 30 dias <span class="at-sub">${r.devolucoes ?? 0} no total · ${r.pedemResposta || 0} pedem resposta da loja</span></div>
        ${(d.devolucoes || []).length ? `<div style="overflow-x:auto"><table class="at-tab"><thead><tr><th>Produto</th><th>Motivo</th><th>O comprador disse</th><th>Situação</th><th>Valor</th><th>Aberta</th></tr></thead><tbody>
          ${[...d.devolucoes].sort((a, b) => (/PENDING/.test(b.negociacao) ? 1 : 0) - (/PENDING/.test(a.negociacao) ? 1 : 0)).map(x => `<tr>
            <td class="at-prod">${x.item ? `<a href="${linkItem(x.item)}" target="_blank" rel="noopener">${h(x.produto || x.item)}</a>` : '—'}</td>
            <td>${h(MOTIVO_SH[x.motivo] || x.motivo)}</td><td class="at-prod at-sub">${h(x.texto)}</td>
            <td>${/PENDING/.test(x.negociacao) ? `<b style="color:var(--red)">responder${x.prazo ? ' até ' + data(x.prazo) : ''}</b>` : h(x.status)}</td><td>${R$(x.valor)}</td><td>${haQuanto(x.criada)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="at-sub">Nenhuma devolução nos últimos 30 dias.</div>'}
        <div class="at-sub" style="margin-top:8px">Perguntas e chat da Shopee não estão disponíveis na integração — responda pelo Seller Center.</div>
      </div>`}`}`;
  }

  window._atConta = k => { st.conta = k; try { localStorage.setItem('glr_at_conta', k); } catch (e) {} carregarConta(); };
  window._atResponder = async id => {
    const p = (st.dados?.perguntas || []).find(x => x.id === id); if (!p) return;
    const txt = (document.getElementById(`at-r-${id}`)?.value || '').trim();
    if (txt.length < 3) { alert('Escreva a resposta antes de enviar.'); return; }
    if (/https?:\/\/|www\.|@[a-z0-9-]+\.|\(\d{2}\)\s?\d|whats/i.test(txt) && !confirm('A resposta parece ter link, e-mail ou telefone — o Mercado Livre não permite. Enviar mesmo assim?')) return;
    if (!confirm(`Enviar esta resposta no Mercado Livre?\n\nPergunta: ${p.texto}\n\nResposta: ${txt}`)) return;
    st.enviando[id] = true; delete st.enviado['e' + id]; render();
    try {
      const r = await MarketplaceAPI.call('ml_answer_question', { meliUserId: st.dados.conta, question_id: String(id), text: txt });
      if (r?.error || r?.data?.error) throw new Error(r.error || r.data.error);
      st.enviado[id] = true;
      _sb.from('glr_agente_log').insert({ conta_id: String(st.dados.conta), tipo: 'decisao', origem: 'analista', resultado: 'executado',
        titulo: `Pergunta respondida — ${String(p.titulo || p.item).slice(0, 70)}`, explicacao: `Pergunta: "${p.texto.slice(0, 200)}" · Resposta${p.rascunho && txt === p.rascunho ? ' (rascunho do agente, sem alteração)' : p.rascunho ? ' (rascunho do agente, editado)' : ''}: "${txt.slice(0, 300)}"`,
        dados: { agente: 'reputacao', marketplace: 'ml', question_id: id, item_id: p.item, usou_rascunho: !!p.rascunho } }).then(() => {}, () => {});
    } catch (e) { st.enviado['e' + id] = `Não enviou: ${e.message || e}`; }
    st.enviando[id] = false; render();
  };

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <h1 style="font-size:22px;font-weight:650;letter-spacing:-.02em;margin:0">Reputação e atendimento</h1>
      <span class="at-sub">perguntas, reclamações e saúde de cada conta — o agente prepara, você responde</span>
    </div>
    <div id="at-root"></div>
  </div>
  <style>
    .at-sub{font-size:12px;color:var(--text-muted)}
    .at-topo{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:12px 16px;margin-bottom:14px}
    .at-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:14px} @media (max-width:1000px){.at-grid{grid-template-columns:1fr}}
    .at-card{padding:14px 16px;margin-bottom:14px} .at-tit{font-weight:650;font-size:14px;margin-bottom:10px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
    .at-chip{display:inline-block;font-size:11px;font-weight:600;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);border-radius:99px;padding:1px 8px}
    .at-mets{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
    .at-mets>div{background:var(--bg-subtle);border-radius:10px;padding:9px 11px;display:flex;flex-direction:column;gap:1px} .at-mets span{font-size:12px;color:var(--text-secondary)} .at-mets b{font-size:18px;font-weight:650;font-variant-numeric:tabular-nums} .at-mets small{font-size:11px;color:var(--text-muted)}
    .at-li{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px} .at-li:last-child{border-bottom:none} .at-li a{color:var(--text-primary);text-decoration:none;font-weight:550}
    .at-perg{border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px;display:flex;flex-direction:column;gap:6px}
    .at-perg-top{display:flex;justify-content:space-between;gap:10px} .at-perg-top a{font-size:13px;font-weight:600;color:var(--text-primary);text-decoration:none}
    .at-q{font-size:13.5px;color:var(--text-primary)} .at-perg textarea{font-size:13px;resize:vertical}
    .at-perg-bt{display:flex;gap:10px;align-items:center}
    .at-tab{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums} .at-tab th,.at-tab td{padding:7px 8px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap;vertical-align:top}
    .at-prod{white-space:normal!important;min-width:200px;max-width:340px} .at-prod a{color:var(--text-primary);text-decoration:none;font-weight:550}
  </style>`;
  carregarContas();
});
