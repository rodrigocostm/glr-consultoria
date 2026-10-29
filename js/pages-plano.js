// ============================================================
// GLR Consultoria — Plano de ação (Gerente de Conta)
// ------------------------------------------------------------
// Tela interna do agente central (api/_gerente.js, todo dia às 08:00): por
// cliente, o semáforo, o diagnóstico, até 7 ações priorizadas (hoje / esta
// semana / pedir ao cliente) e a pauta do dia para conversar com o cliente.
// Nada vira tarefa sozinho: "Virar tarefa" cria na Gestão de Tarefas para o
// gestor do cliente; "Feito" e "Descartar" ficam guardados por ação
// (glr_plano_status, sincronizado) e a ação não volta no dia seguinte.
// ============================================================
Router.register('plano-acao', (params, el) => {
  // embed: o Perfil do cliente monta o plano dele aqui dentro (sem a lista de clientes)
  const embed = !!params?.embed, cliEmbed = embed ? String(params.clienteId) : null;
  const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const R$ = v => v == null ? '—' : 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const pct = v => v == null ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')}%`;
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const maisDias = n => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  const st = {
    planos: [], aberto: (() => { try { return localStorage.getItem('glr_plano_cliente') || ''; } catch (e) { return ''; } })(),
    filtro: (() => { try { return localStorage.getItem('glr_plano_filtro') || 'todos'; } catch (e) { return 'todos'; } })(),
    meuGestor: null, carregando: true, erro: null, gerando: false, copiado: false,
    aba: (() => { try { return localStorage.getItem('glr_plano_aba') || 'acoes'; } catch (e) { return 'acoes'; } })(),
    acaoAberta: null, metaEd: null, diagAberto: false, rxTodos: false, pautaEd: {},
  };
  const status = () => lerJSON('glr_plano_status', {});
  const salvarStatus = (id, v) => { const s = status(); if (v) s[id] = v; else delete s[id]; localStorage.setItem('glr_plano_status', JSON.stringify(s)); };

  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('conta_id,ultimo_sucesso,cursor').eq('marketplace', 'sistema').eq('recurso', 'plano');
      if (error) throw error;
      // só clientes que existem e ainda têm conta vinculada (cliente excluído ou sem contas deixava o plano antigo parado)
      const vinc = lerJSON('glr_mc_vinculos', {}), ids = new Set((GLR.clientes || []).map(c => String(c.id)));
      st.planos = (data || []).map(r => r.cursor).filter(p => p?.cliente && (!ids.size || ids.has(String(p.cliente.id))) && (vinc[String(p.cliente.id)] || []).length);
      try {
        const { data: { user } } = await _sb.auth.getUser();
        const email = String(user?.email || '').toLowerCase();
        const g = (window.GLR?.gestores || []).find(x => [x.email, x.loginEmail].some(e => e && String(e).toLowerCase() === email));
        st.meuGestor = g ? g.id : null;
      } catch (e) {}
      if (embed) st.aberto = cliEmbed;
      else if (GLR.ctx) { const foco = GLR.ctx.cliente(); st.aberto = foco && st.planos.some(p => String(p.cliente.id) === foco) ? foco : foco ? st.aberto : ''; } // cliente em foco
      if (st.aberto && !st.planos.some(p => String(p.cliente.id) === st.aberto)) st.aberto = '';
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  const SEM = { vermelho: ['Precisa de atenção hoje', 'var(--red)', 0], amarelo: ['Atenção', 'var(--yellow)', 1], verde: ['Em dia', 'var(--green)', 2] };
  const QUEM = { analista: 'Analista', cliente: 'Cliente', agente: 'Agente' };
  const pendentesDe = p => (p.acoes || []).filter(a => !status()[a.id]);

  function lista() {
    let ps = st.planos.slice();
    if (st.filtro === 'meus' && st.meuGestor != null) ps = ps.filter(p => String(p.cliente.gestorId) === String(st.meuGestor));
    const perda = p => p.raioX?.caiu?.[0]?.perdaSem || 0;
    return ps.sort((a, b) => SEM[a.semaforo][2] - SEM[b.semaforo][2] || perda(b) - perda(a) || a.cliente.nome.localeCompare(b.cliente.nome));
  }

  function renderLista() {
    const ps = lista();
    const cont = k => st.planos.filter(p => p.semaforo === k).length;
    return `
      <div class="pl-topo">
        <div class="pl-chips">
          <button class="${st.filtro === 'todos' ? 'on' : ''}" onclick="window._plFiltro('todos')">Todos os clientes <b>${st.planos.length}</b></button>
          <button class="${st.filtro === 'meus' ? 'on' : ''}" ${st.meuGestor == null ? 'disabled title="Seu e-mail não está no cadastro de gestores"' : ''} onclick="window._plFiltro('meus')">Meus clientes</button>
        </div>
        <span class="pl-sub"><b style="color:var(--red)">${cont('vermelho')}</b> precisam de atenção hoje · <b style="color:var(--yellow)">${cont('amarelo')}</b> em atenção · <b style="color:var(--green)">${cont('verde')}</b> em dia</span>
      </div>
      <div class="card pl-tab-wrap"><table class="pl-tab">
        <thead><tr><th>Cliente</th><th>Situação</th><th class="n">Projeção</th><th class="n">Última semana</th><th class="n">TACOS</th><th>Maior queda</th><th class="n">Hoje</th></tr></thead>
        <tbody>${ps.map(p => {
          const s = SEM[p.semaforo], pend = pendentesDe(p), hoje = pend.filter(a => a.quando === 'hoje').length, m = p.metricas || {}, rx = p.raioX;
          const q = rx?.caiu?.[0];
          const tacosCor = m.metaTacos && m.tacos > m.metaTacos ? 'var(--red)' : 'inherit';
          return `<tr onclick="window._plAbrir('${h(p.cliente.id)}')" style="--c:${s[1]}">
            <td><b>${h(p.cliente.nome)}</b><div class="pl-sub">${h(p.cliente.gestor || 'sem gestor')}</div></td>
            <td><span class="pl-sem"><i></i>${p.semaforo === 'vermelho' ? 'Agir hoje' : s[0]}</span></td>
            <td class="n"><b>${R$(m.projecao)}</b><div class="pl-sub">${m.pctMeta != null ? `${pct(m.pctMeta)} da meta` : 'sem meta'}</div></td>
            <td class="n">${rx ? `${R$(rx.semanaAgora)}<div class="pl-sub" style="color:${rx.var >= 0 ? 'var(--green)' : 'var(--red)'}">${rx.var >= 0 ? '+' : ''}${pct(rx.var)}</div>` : '<span class="pl-sub">—</span>'}</td>
            <td class="n" style="color:${tacosCor};font-weight:600">${pct(m.tacos)}${m.metaTacos ? `<div class="pl-sub">meta ${pct(m.metaTacos)}</div>` : ''}</td>
            <td class="pl-queda">${q ? `${h(q.nome)}<div class="pl-sub"><b style="color:var(--red)">−${R$(q.perdaSem)}/sem</b>${q.causas?.[0] ? ` · ${h(q.causas[0].t)}` : ''}</div>` : '<span class="pl-sub">—</span>'}</td>
            <td class="n"><b>${hoje}</b></td>
          </tr>`;
        }).join('') || '<tr><td colspan="7" class="pl-sub" style="padding:20px">Nenhum cliente neste filtro.</td></tr>'}</tbody>
      </table></div>`;
  }

  // Ação numa linha: quem, o quê e o impacto; o porquê abre ao clicar
  const tirarMeta = t => String(t || '').replace(/^Meta:\s*/, '');
  function renderAcao(p, a) {
    const s = status()[a.id], ab = st.acaoAberta === a.id, ehMeta = /^Meta:/.test(a.titulo || '');
    const cid = h(p.cliente.id), id = h(a.id);
    const bt = s ? `<span class="pl-sub">${s.st === 'feito' ? 'Feito' : s.st === 'tarefa' ? 'Virou tarefa' : 'Descartada'}${s.motivo ? ` — ${h(s.motivo)}` : ''}</span><button class="pl-x" title="Reabrir" onclick="window._plReabrir('${id}')">↺</button>`
      : `${a.tela ? `<button class="btn btn-primary btn-sm" onclick="window._plIr('${h(a.tela)}')">Fazer agora</button><button class="btn btn-secondary btn-sm" onclick="window._plTarefa('${cid}','${id}')">Virar tarefa</button>`
        : `<button class="btn btn-primary btn-sm" onclick="window._plTarefa('${cid}','${id}')">Virar tarefa</button>`}<button class="btn btn-secondary btn-sm" onclick="window._plFeito('${id}')">Feito</button><button class="pl-x" title="Descartar" onclick="window._plDescartar('${id}')">✕</button>`;
    return `<div class="pl-acao ${s ? 'resolvida' : ''} ${ab ? 'aberta' : ''}" style="--q:${a.quem === 'cliente' ? 'var(--purple)' : 'var(--accent)'}">
      <button type="button" class="pl-acao-main" aria-expanded="${ab}" onclick="window._plAcaoTog('${id}')">
        <span class="pl-quem">${QUEM[a.quem] || h(a.quem)}</span>
        <span class="pl-acao-tit">${ehMeta ? '<span class="pl-tag">meta</span>' : ''}${h(tirarMeta(a.titulo))}</span>
        ${a.impacto ? `<span class="pl-imp">${h(a.impacto)}</span>` : ''}
      </button>
      <div class="pl-acao-bt">${bt}</div>
      ${ab ? `<div class="pl-acao-det">${h(a.porque || '')}${a.loja ? `<div class="pl-sub">${h(a.loja)}</div>` : ''}</div>` : ''}
    </div>`;
  }

  // Meta do mês + o caminho que o Gerente montou até ela
  const numBR = v => { const x = parseFloat(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isNaN(x) ? null : x; };
  const metasDe = cid => ({ fat: lerJSON('glr_metas', {})[cid], ped: lerJSON('glr_metas_pedidos', {})[cid] });
  const CONF = { alta: 'var(--green)', 'média': 'var(--yellow)', baixa: 'var(--text-muted)' };
  const N = v => Math.round(v || 0).toLocaleString('pt-BR');
  const corPct = v => v == null ? 'var(--text-muted)' : v >= 100 ? 'var(--green)' : v >= 85 ? 'var(--yellow)' : 'var(--red)';
  function formMeta(p) {
    const m = p.metricas || {}, cid = String(p.cliente.id), salvas = metasDe(cid);
    const vFat = salvas.fat ?? m.meta, vPed = salvas.ped ?? m.metaPedidos;
    return `<div class="pl-meta-form">
      <label>Faturamento do mês <span class="pl-in">R$ <input id="pl-meta-fat" class="form-control" inputmode="decimal" placeholder="ex.: 300.000" value="${vFat ? Number(vFat).toLocaleString('pt-BR') : ''}"></span></label>
      <label>Pedidos do mês <span class="pl-in"><input id="pl-meta-ped" class="form-control" inputmode="numeric" placeholder="ex.: 2.000" value="${vPed ? Number(vPed).toLocaleString('pt-BR') : ''}"></span></label>
      <button class="btn btn-primary btn-sm" ${st.gerando ? 'disabled' : ''} onclick="window._plSalvarMeta('${h(cid)}')">${st.gerando ? 'Calculando o caminho…' : 'Salvar e calcular o caminho'}</button>
      <button class="pl-link" onclick="window._plMetaEd()">Cancelar</button>
    </div>`;
  }

  // Topo: semáforo, a meta numa barra só, quanto falta por dia e os números do mês
  function renderHero(p) {
    const s = SEM[p.semaforo], m = p.metricas || {}, c = p.caminho, cid = String(p.cliente.id);
    const quando = p.em ? new Date(p.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const meta = m.meta, prox = !!c?.proximo, proj = c ? c.proj : m.projecao;
    const pP = meta && proj != null ? proj / meta * 100 : null, pF = meta && !prox ? (m.faturamento || 0) / meta * 100 : null;
    const falta = !meta ? '' : c?.atinge || (!c && pP >= 100) ? '<span style="color:var(--green);font-weight:600">No ritmo de hoje a meta é batida.</span>'
      : c ? `Faltam <b>${R$(c.falta)}</b> · precisa de <b>${R$(c.precisaDia)}/dia</b> ${prox ? `em ${h(c.mesAlvo)}` : 'até o fim do mês'} — hoje faz ${R$(c.ritmoDia)}/dia${c.alavancas?.length ? ` <button class="pl-link" onclick="window._plAba('caminho')">ver o caminho (cobre ${c.cobertura}%) →</button>` : ''}`
      : `Faltam <b>${R$(meta - proj)}</b> na projeção.`;
    const diag = String(p.diagnostico || ''), corte = diag.search(/\.\s/), lead = corte > 0 ? diag.slice(0, corte + 1) : diag, resto = corte > 0 ? diag.slice(corte + 2) : '';
    const tacosAlto = m.metaTacos && m.tacos > m.metaTacos;
    return `<div class="card pl-hero" style="--c:${s[1]};--m:${corPct(pP)}">
      <div class="pl-hero-top">
        <span class="pl-sem"><i></i>${s[0]}</span>
        ${embed ? '' : `<span class="pl-sub">${h(p.cliente.gestor || '')}</span>`}
        <span class="pl-sub pl-hero-em">plano de ${quando}${p.fonteTexto === 'ia' ? ' · texto com IA' : ''}</span>
        ${st.metaEd === cid ? '' : `<button class="pl-link" onclick="window._plMetaEd('${h(cid)}')">${meta ? 'Editar meta' : 'Definir meta'}</button>`}
        <button class="btn btn-secondary btn-sm" ${st.gerando ? 'disabled' : ''} onclick="window._plGerar('${h(cid)}')">${st.gerando ? 'Gerando…' : 'Atualizar plano'}</button>
      </div>
      ${st.metaEd === cid ? formMeta(p) : ''}
      ${meta ? `<div class="pl-hero-meta">
        <div class="pl-hero-rot">${prox ? `Meta de ${h(c.mesAlvo)}` : 'Meta do mês'}</div>
        <div class="pl-hero-num"><b>${R$(proj)}</b><span>${prox ? 'no ritmo de hoje' : 'projetados'} de ${R$(meta)}</span><em>${Math.round(pP)}%</em></div>
        <div class="pl-hbar" title="${pF != null ? `faturado ${Math.round(pF)}% · projeção ${Math.round(pP)}%` : `${Math.round(pP)}% no ritmo de hoje`}">${pF != null ? `<i class="f" style="width:${Math.min(100, pF)}%"></i>` : ''}<i class="p" style="width:${Math.min(100, pP)}%"></i></div>
        ${pF != null ? `<div class="pl-hbar-leg"><span><i class="f"></i>faturado ${R$(m.faturamento)}</span><span><i class="p"></i>projeção até o fim do mês</span></div>` : ''}
        <div class="pl-hero-falta">${falta}</div>
      </div>` : st.metaEd === cid ? '' : `<div class="pl-hero-meta"><div class="pl-hero-rot">Sem meta para este cliente</div><div class="pl-sub">Defina a meta de faturamento e pedidos: os agentes passam a mirar nela e o Gerente monta o caminho.</div></div>`}
      <div class="pl-stats">
        ${prox || !meta ? `<div><span>Faturado no mês</span><b>${R$(m.faturamento)}</b><small>até ontem · dia ${m.dia}/${m.diasMes}</small></div><div><span>Fecha o mês em</span><b>${R$(m.projecao)}</b><small>projeção</small></div>` : ''}
        ${m.metaPedidos ? `<div><span>Pedidos</span><b>${N(c?.projPedidos ?? m.projPedidos)}</b><small>de ${N(m.metaPedidos)} na meta</small></div>` : ''}
        <div><span>TACOS do mês</span><b style="color:${tacosAlto ? 'var(--red)' : 'inherit'}">${pct(m.tacos)}</b><small>${m.metaTacos ? `meta ${pct(m.metaTacos)}` : 'sem meta'}</small></div>
        <div><span>Contra o mês passado</span><b style="color:${m.varMes == null ? 'inherit' : m.varMes >= 0 ? 'var(--green)' : 'var(--red)'}">${m.varMes == null ? '—' : `${m.varMes >= 0 ? '+' : ''}${pct(m.varMes)}`}</b><small>mesmo período</small></div>
      </div>
      ${diag ? `<div class="pl-hero-diag">${h(lead)}${resto ? (st.diagAberto ? ` ${h(resto)} <button class="pl-link" onclick="window._plDiag()">resumir</button>` : ` <button class="pl-link" onclick="window._plDiag()">ler a análise completa</button>`) : ''}</div>` : ''}
    </div>`;
  }

  function renderCaminho(p) {
    const c = p.caminho;
    if (!c) return `<div class="pl-vazio">Este cliente ainda não tem meta. <button class="pl-link" onclick="window._plMetaEd('${h(p.cliente.id)}')">Definir meta</button> — o Gerente monta o caminho até ela.</div>`;
    if (c.atinge) return '<div class="pl-meta-ok">No ritmo de hoje a meta é batida. Siga "O que fazer" para proteger o resultado.</div>';
    return `<div class="pl-cam-res">
        <div>Faltam <b>${R$(c.falta)}</b>${c.faltaPedidos ? ` (≈ ${N(c.faltaPedidos)} pedidos a ${R$(c.ticket)})` : ''}. As alavancas abaixo somam <b>~${R$(c.soma)}</b> até o fim de ${h(c.mesAlvo)}.</div>
        <div class="pl-cob"><i style="width:${Math.min(100, c.cobertura)}%"></i></div><small>cobrem ${c.cobertura}% do que falta</small>
      </div>
      ${c.alavancas.length ? `<div class="pl-alav">${c.alavancas.map(a => `<div class="pl-alav-i">
        <div class="pl-alav-txt"><b>${h(a.titulo)}</b>${a.porque ? `<div class="pl-sub">${h(a.porque)}</div>` : ''}</div>
        <div class="pl-alav-v"><b>+${R$(a.valor)}</b><small style="color:${CONF[a.conf] || 'inherit'}">confiança ${h(a.conf)}</small></div>
        ${a.tela ? `<button class="btn btn-secondary btn-sm" onclick="window._plIr('${h(a.tela)}')">Fazer</button>` : '<span></span>'}
      </div>`).join('')}</div>` : '<div class="pl-sub">Os agentes não acharam alavancas nos dados deste cliente agora.</div>'}
      ${(c.promosMeta || []).length ? `<div class="pl-meta-agentes"><b>Promoções preparadas pela meta:</b> ${c.promosMeta.length} nos últimos 7 dias, que cabem na margem — ${c.promosMeta.slice(0, 3).map(x => `${h(x.produto)} (${h(x.promo || '')}, margem ${String(x.margem ?? '—').replace('.', ',')}%)`).join('; ')}. Esperam a sua aprovação na <button class="pl-link" onclick="window._plIr('decisoes')">Caixa de decisões</button>.</div>` : ''}
      ${c.resto > 0 ? `<div class="pl-meta-resto"><b>Ainda faltariam ~${R$(c.resto)}.</b> Isso pede ação comercial: lançar produtos ou variações, entrar numa data/campanha relâmpago do marketplace${c.adsExtra ? `, ou investir <b>~${R$(c.adsExtra)}</b> a mais de ADS no mês mantendo o TACOS de hoje` : ''}.</div>` : ''}`;
  }

  // Contrato do cliente: perfil e o que o agente pode fazer sozinho (o agente lê glr_contratos no servidor)
  const PERFIS = [['crescer', 'Crescer', 'aceita ACOS até 15% acima da meta para ganhar volume; acelera antes; freio de volume age com queda de 15%'],
    ['equilibrio', 'Equilíbrio', 'o comportamento padrão: contém acima da meta, acelera com ACOS 30% abaixo dela; freio com queda de 25%'],
    ['lucrar', 'Lucrar', 'protege a margem: acelera só com ACOS 40% abaixo da meta; freio só com queda de 35%']];
  const AUTON = [['ajuste', 'Ajustar ROAS e orçamento (ADS Shopee)'], ['pausar', 'Pausar campanha (ADS Shopee)'], ['desfazer', 'Desfazer sozinho um aperto que derrubou a venda']];
  const contratoDe = cid => { const c = lerJSON('glr_contratos', {})[cid] || {}; return { perfil: c.perfil || 'equilibrio', fixo: !!c.fixo, autonomia: { ajuste: 'executar', pausar: 'executar', desfazer: 'executar', ...(c.autonomia || {}) }, em: c.em }; };
  // nível que o resultado medido decidiu (servidor grava glr_autonomia_auto; a sincronização traz)
  const autoDe = cid => lerJSON('glr_autonomia_auto', {})[cid] || {};
  const efetivo = (c, a, k) => (!c.fixo && a[k]?.nivel) || c.autonomia[k];
  function resumoContrato(cid) {
    const c = contratoDe(cid), a = autoDe(cid);
    return `${PERFIS.find(x => x[0] === c.perfil)[1]} · ${AUTON.filter(([k]) => efetivo(c, a, k) === 'executar').length} de ${AUTON.length} ações no automático${AUTON.some(([k]) => !c.fixo && a[k]?.nivel && a[k].nivel !== c.autonomia[k]) ? ' · ajustado pelo resultado' : ''}`;
  }
  function renderContrato(p) {
    const cid = String(p.cliente.id), c = contratoDe(cid), a = autoDe(cid), r = p.resultados || {};
    return `<div class="pl-sub" style="margin-bottom:10px">${h(resumoContrato(cid))}${r.medidas ? ` · ${r.medidas} resultado(s) medido(s) em 7 dias, ${r.melhoraram || 0} melhoraram` : ''}</div>
      <div class="pl-ctr-g">
        <div><div class="pl-ctr-t">Perfil do cliente</div>
          ${PERFIS.map(([k, t, d]) => `<label class="pl-ctr-op"><input type="radio" name="pl-perfil" value="${k}" ${c.perfil === k ? 'checked' : ''}><span><b>${t}</b><small>${d}</small></span></label>`).join('')}</div>
        <div><div class="pl-ctr-t">O que o agente faz sozinho</div>
          ${AUTON.map(([k, t]) => { const x = a[k], mudou = !c.fixo && x?.nivel && x.nivel !== c.autonomia[k];
            return `<div class="pl-ctr-a"><span>${t}${x?.n ? `<small class="pl-ctr-res">${x.n} medido(s): <b style="color:var(--green)">${x.melhorou} certo(s)</b> · <b style="color:var(--red)">${x.piorou} errado(s)</b></small>` : '<small class="pl-ctr-res">ainda sem casos medidos</small>'}${x?.sombra ? `<small class="pl-ctr-res" title="Sugestões que não foram aplicadas, medidas 7 dias depois">modo sombra: ${x.sombra.certo} de ${x.sombra.n} sugestões não aplicadas estavam certas${x.sombra.custo ? ` · não aplicar custou ~R$ ${Number(x.sombra.custo).toLocaleString('pt-BR')}` : ''}</small>` : ''}${mudou ? `<small class="pl-ctr-mud">agora em <b>${x.nivel === 'executar' ? 'Executar' : 'Só sugerir'}</b> pelo resultado (${h(x.motivo || '')})</small>` : ''}</span><select id="pl-aut-${k}" class="form-control"><option value="executar" ${c.autonomia[k] === 'executar' ? 'selected' : ''}>Executar</option><option value="sugerir" ${c.autonomia[k] === 'sugerir' ? 'selected' : ''}>Só sugerir</option></select></div>`; }).join('')}
          <label class="pl-ctr-fixo"><input type="checkbox" id="pl-aut-fixo" ${c.fixo ? 'checked' : ''}> Fixo — não mudar o nível sozinho pelo resultado</label>
          <div class="pl-sub pl-ctr-reg">Promoção nunca é automática: o agente prepara (com custo e lucro por venda) e espera a sua aprovação na Caixa de decisões.</div>
          <div class="ajuda pl-sub">Contam as ações aplicadas e, no modo sombra, as sugestões não aplicadas (medidas 7 dias depois: o agente estava certo?). Sem "Fixo", o nível sobe ou desce sozinho: rebaixa para "Só sugerir" se metade ou mais de 10+ casos medidos piorou; promove para "Executar" com 30+ casos, 70% melhorando e até 15% piorando. "Só sugerir" manda a ação para a Caixa de decisões. Os limites de cada conta continuam valendo.</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:12px"><button class="btn btn-primary btn-sm" onclick="window._plSalvarContrato('${h(cid)}')">Salvar</button>${st.ctrSalvo === cid ? '<span class="pl-sub" style="color:var(--green)">Salvo — vale a partir da próxima revisão do agente</span>' : ''}</div>`;
  }

  // Raio-X do faturamento: o que puxou e o que derrubou nas últimas 2 semanas
  function renderRaioX(rx, m) {
    if (!rx) return '<div class="pl-vazio">Sem pedidos suficientes na base para comparar as últimas 2 semanas.</div>';
    const sinal = v => v == null ? '' : `<span style="color:${v >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:650">${v >= 0 ? '+' : ''}${pct(v)}</span>`;
    const chips = cs => { const vis = cs.slice(0, 2).map(c => `<span class="pl-causa pl-c-${h(c.tipo)}">${h(c.t)}</span>`).join(''); return vis + (cs.length > 2 ? `<span class="pl-causa" title="${h(cs.slice(2).map(c => c.t).join(' · '))}">+${cs.length - 2}</span>` : ''); };
    const linha = (x, neg) => `<div class="pl-rx-l">
      <div class="pl-rx-n"><b>${h(x.nome)}</b><span class="pl-sub">${h(x.loja)} · ${R$(x.antes)} → ${R$(x.agora)} por semana</span>
        ${neg ? `<div class="pl-rx-c">${x.causas.length ? chips(x.causas) : '<span class="pl-sub">sem causa clara nos dados — conferir concorrência, posição e avaliações</span>'}</div>`
          : (x.novo || x.alerta ? `<div class="pl-rx-c">${x.novo ? '<span class="pl-causa">começou a vender agora</span>' : ''}${x.alerta ? `<span class="pl-causa pl-c-estoque">${h(x.alerta)}</span>` : ''}</div>` : '')}</div>
      <div class="pl-rx-v" style="color:${neg ? 'var(--red)' : 'var(--green)'}">${neg ? '−' : '+'}${R$(neg ? x.perdaSem : x.ganhoSem)}<small>/sem</small></div>
    </div>`;
    const LIM = 5, caiu = st.rxTodos ? rx.caiu : rx.caiu.slice(0, LIM);
    return `<div class="pl-sub" style="margin-bottom:8px">${h(rx.periodo.agora)} × ${h(rx.periodo.antes)} · pedidos válidos, por semana</div>
      <div class="pl-stats pl-stats-box">
        <div><span>Faturamento por semana</span><b>${R$(rx.semanaAgora)}</b><small>antes ${R$(rx.semanaAntes)} ${sinal(rx.var)}</small></div>
        <div><span>Concentração</span><b>${pct(rx.concentracaoTop5)}</b><small>do faturamento em 5 produtos</small></div>
        <div><span>Produtos que pararam</span><b>${rx.produtosQueZeraram}</b><small>vendiam (3+ un.) e zeraram</small></div>
      </div>
      ${rx.lojas.length > 1 ? `<div class="pl-lojas">${rx.lojas.map(l => `<span>${h(l.loja)}: ${R$(l.agora)}/sem ${sinal(l.var)}</span>`).join('')}</div>` : ''}
      <div class="pl-rx-t">O que derrubou</div>
      ${rx.caiu.length ? caiu.map(x => linha(x, true)).join('') + (rx.caiu.length > LIM ? `<button class="pl-link" style="margin-top:6px" onclick="window._plRxTodos()">${st.rxTodos ? 'mostrar menos' : `ver os ${rx.caiu.length} produtos`}</button>` : '') : '<div class="pl-sub">Nenhum produto com queda relevante.</div>'}
      ${rx.subiu.length ? `<div class="pl-rx-t">O que puxou</div>${rx.subiu.slice(0, LIM).map(x => linha(x, false)).join('')}` : ''}`;
  }

  function renderAcoes(p) {
    const grupos = [['Fazer hoje', a => a.quando === 'hoje' && a.quem !== 'cliente'], ['Esta semana', a => a.quando !== 'hoje' && a.quem !== 'cliente'], ['Pedir ao cliente', a => a.quem === 'cliente']];
    const ordem = as => [...as.filter(a => !status()[a.id]), ...as.filter(a => status()[a.id])]; // resolvidas vão para o fim
    return grupos.map(([t, fn]) => { const as = ordem((p.acoes || []).filter(fn)); if (!as.length) return '';
      const ab = as.filter(a => !status()[a.id]).length;
      return `<div class="pl-grupo"><div class="pl-grupo-t">${t}<span class="pl-sub">${ab ? `${ab} aberta(s)` : 'tudo resolvido'}</span></div>${as.map(a => renderAcao(p, a)).join('')}</div>`; }).join('')
      || '<div class="pl-vazio">Nenhuma ação hoje — os agentes não encontraram nada urgente.</div>';
  }

  function renderPauta(p) {
    const cid = String(p.cliente.id), txt = st.pautaEd[cid] ?? p.pauta;
    return `<div class="pl-sub" style="margin-bottom:8px">Interna — revise antes de enviar ao cliente.</div>
      <textarea id="pl-pauta" class="form-control" rows="16" oninput="window._plPautaEd('${h(cid)}', this.value)">${h(txt)}</textarea>
      <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="window._plCopiar()">${st.copiado ? 'Copiado' : 'Copiar pauta'}</button>`;
  }

  function renderPlano(p) {
    const abertas = pendentesDe(p).length, c = p.caminho;
    const ABAS = [['acoes', `O que fazer${abertas ? ` <b>${abertas}</b>` : ''}`], ['caminho', `Caminho da meta${c && !c.atinge && c.cobertura != null ? ` <small>${c.cobertura}%</small>` : ''}`],
      ['raiox', 'Por que mudou'], ['pauta', 'Pauta do cliente'], ['ajustes', 'Autonomia']];
    const aba = ABAS.some(x => x[0] === st.aba) ? st.aba : 'acoes';
    const corpo = { acoes: () => renderAcoes(p), caminho: () => renderCaminho(p), raiox: () => renderRaioX(p.raioX, p.metricas || {}), pauta: () => renderPauta(p), ajustes: () => renderContrato(p) }[aba]();
    return `
      ${embed ? '' : `<div class="pl-head">
        <button class="btn btn-secondary btn-sm" onclick="window._plAbrir('')">← Todos</button>
        <select class="form-control" style="max-width:280px" onchange="window._plAbrir(this.value)">${lista().map(x => `<option value="${h(x.cliente.id)}" ${String(x.cliente.id) === String(p.cliente.id) ? 'selected' : ''}>${h(x.cliente.nome)}</option>`).join('')}</select>
      </div>`}
      ${renderHero(p)}
      <div class="pl-seg" role="tablist">${ABAS.map(([k, t]) => `<button role="tab" aria-selected="${k === aba}" class="${k === aba ? 'on' : ''}" onclick="window._plAba('${k}')">${t}</button>`).join('')}</div>
      <div class="card pl-painel">${corpo}</div>`;
  }

  function render() {
    const root = document.getElementById('pl-root'); if (!root) return;
    if (st.carregando && !st.planos.length) { root.innerHTML = '<div class="pl-sub" style="padding:30px">Carregando…</div>'; return; }
    if (!st.planos.length) { root.innerHTML = `<div class="card" style="padding:22px"><b>O Gerente de Conta ainda não montou planos.</b><div class="pl-sub" style="margin-top:6px">Ele roda todo dia às 08:00, depois da revisão dos agentes de ADS, para cada cliente com lojas na sincronização automática.</div>${st.erro ? `<div class="pl-sub" style="color:var(--red)">${h(st.erro)}</div>` : ''}</div>`; return; }
    const p = st.aberto && st.planos.find(x => String(x.cliente.id) === st.aberto);
    if (embed && !p) { root.innerHTML = `<div class="card" style="padding:20px"><b>Ainda não há plano para este cliente.</b><div class="pl-sub" style="margin:6px 0 10px">O Gerente monta os planos todo dia às 08:00 para os clientes com lojas na sincronização automática.</div><button class="btn btn-primary btn-sm" ${st.gerando ? 'disabled' : ''} onclick="window._plGerar('${h(cliEmbed)}')">${st.gerando ? 'Gerando…' : 'Gerar plano agora'}</button></div>`; return; }
    root.innerHTML = p ? renderPlano(p) : renderLista();
  }

  window._plFiltro = k => { st.filtro = k; try { localStorage.setItem('glr_plano_filtro', k); } catch (e) {} render(); };
  window._plAbrir = id => { st.aberto = String(id || ''); GLR.ctx?.definir(st.aberto, true); st.copiado = false; st.acaoAberta = null; st.metaEd = null; st.diagAberto = false; st.rxTodos = false; try { localStorage.setItem('glr_plano_cliente', st.aberto); } catch (e) {} render(); window.scrollTo?.(0, 0); };
  window._plIr = tela => Router.navigate(tela);
  window._plFeito = id => { salvarStatus(id, { st: 'feito', em: Date.now() }); render(); };
  window._plReabrir = id => { salvarStatus(id, null); render(); };
  window._plDescartar = id => { const motivo = prompt('Por que descartar esta ação? (opcional)'); if (motivo === null) return; salvarStatus(id, { st: 'descartado', em: Date.now(), motivo: motivo.slice(0, 140) }); render(); };
  window._plTarefa = (cid, id) => {
    const p = st.planos.find(x => String(x.cliente.id) === String(cid)), a = p?.acoes.find(x => x.id === id); if (!a) return;
    const cli = (window.GLR?.clientes || []).find(c => String(c.id) === String(cid));
    const resp = (window.GLR?.gestores || []).find(g => g.id === (cli?.gestorId ?? p.cliente.gestorId))?.nome || p.cliente.gestor || '';
    const tarefa = { id: GLR.nextId(GLR.tarefas), titulo: a.quem === 'cliente' ? `Pedir ao cliente: ${a.titulo}` : a.titulo, cliente: p.cliente.nome, clienteId: cli ? cli.id : p.cliente.id,
      responsavel: resp, status: 'pendente', prioridade: a.quando === 'hoje' ? 'alta' : 'media', prazo: a.quando === 'hoje' ? hojeISO() : maisDias(7),
      categoria: 'Plano de ação', notas: `${a.porque}${a.impacto ? ` · Impacto: ${a.impacto}` : ''} · ${a.loja || ''} (Gerente de Conta, ${new Date(p.em).toLocaleDateString('pt-BR')})` };
    GLR.tarefas.push(tarefa);
    localStorage.setItem('glr_tarefas', JSON.stringify(GLR.tarefas)); // sincroniza (supabase-init)
    salvarStatus(id, { st: 'tarefa', em: Date.now(), tarefaId: tarefa.id });
    render();
  };
  window._plCopiar = () => { const t = document.getElementById('pl-pauta')?.value || ''; navigator.clipboard?.writeText(t).then(() => { st.copiado = true; render(); }, () => alert('Não consegui copiar — selecione o texto e copie.')); };
  window._plAba = k => { st.aba = k; st.copiado = false; try { localStorage.setItem('glr_plano_aba', k); } catch (e) {} render(); };
  window._plAcaoTog = id => { st.acaoAberta = st.acaoAberta === id ? null : id; render(); };
  window._plMetaEd = cid => { st.metaEd = cid ? String(cid) : null; render(); if (cid) document.getElementById('pl-meta-fat')?.focus(); };
  window._plDiag = () => { st.diagAberto = !st.diagAberto; render(); };
  window._plRxTodos = () => { st.rxTodos = !st.rxTodos; render(); };
  window._plPautaEd = (cid, v) => { st.pautaEd[cid] = v; };
  window._plSalvarContrato = cid => {
    const perfil = document.querySelector('input[name="pl-perfil"]:checked')?.value || 'equilibrio';
    const autonomia = Object.fromEntries(AUTON.map(([k]) => [k, document.getElementById(`pl-aut-${k}`)?.value === 'sugerir' ? 'sugerir' : 'executar']));
    const fixo = !!document.getElementById('pl-aut-fixo')?.checked;
    const todos = lerJSON('glr_contratos', {}); todos[cid] = { perfil, autonomia, fixo, em: Date.now() };
    localStorage.setItem('glr_contratos', JSON.stringify(todos)); // sincroniza (supabase-init) — o agente lê no servidor
    st.ctrSalvo = cid; render();
  };
  window._plSalvarMeta = async cid => {
    const fat = numBR(document.getElementById('pl-meta-fat')?.value), ped = numBR(document.getElementById('pl-meta-ped')?.value);
    const mf = lerJSON('glr_metas', {}), mp = lerJSON('glr_metas_pedidos', {});
    if (fat > 0) mf[cid] = fat; else delete mf[cid];
    if (ped > 0) mp[cid] = Math.round(ped); else delete mp[cid];
    localStorage.setItem('glr_metas', JSON.stringify(mf)); localStorage.setItem('glr_metas_pedidos', JSON.stringify(mp)); // sincronizam (supabase-init)
    st.gerando = true; st.metaEd = null; render();
    try {
      const q = `&meta=${encodeURIComponent(fat > 0 ? fat : '')}&meta_pedidos=${encodeURIComponent(ped > 0 ? Math.round(ped) : '')}`;
      const r = await fetch(`/api/agente-cron?rodada=gerente&cliente_id=${encodeURIComponent(cid)}${q}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    } catch (e) { alert('Meta salva, mas não consegui recalcular o caminho agora: ' + (e.message || e)); }
    st.gerando = false; await carregar();
  };
  window._plGerar = async cid => {
    st.gerando = true; render();
    try {
      const r = await fetch(`/api/agente-cron?rodada=gerente&cliente_id=${encodeURIComponent(cid)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    } catch (e) { alert('Não consegui gerar o plano agora: ' + (e.message || e)); }
    st.gerando = false; await carregar();
  };

  el.innerHTML = `<div class="${embed ? 'pl-embed' : 'page'}">
    <div id="pl-root"></div>
  </div>
  <style>
    .pl-sub{font-size:12px;color:var(--text-muted)}
    .pl-topo{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .pl-chips{display:flex;gap:6px} .pl-chips button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
    .pl-chips button.on{background:var(--text-primary);border-color:var(--text-primary);color:var(--bg-card)} .pl-chips button:disabled{opacity:.5;cursor:default}
    .pl-sem{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:var(--c);white-space:nowrap} .pl-sem i{width:8px;height:8px;border-radius:50%;background:var(--c)}
    .pl-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .pl-link{all:unset;cursor:pointer;color:var(--accent);font-size:12.5px;font-weight:600} .pl-link:hover{text-decoration:underline} .pl-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
    .pl-hero{padding:16px 18px;margin-bottom:14px;box-shadow:inset 4px 0 0 var(--c)}
    .pl-hero-top{display:flex;gap:12px;align-items:center;flex-wrap:wrap} .pl-hero-em{flex:1;text-align:right}
    .pl-hero-meta{margin-top:14px}
    .pl-hero-rot{font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)}
    .pl-hero-num{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:2px} .pl-hero-num b{font-size:28px;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
    .pl-hero-num span{font-size:13.5px;color:var(--text-secondary)} .pl-hero-num em{font-style:normal;font-weight:700;font-size:13px;color:var(--m);background:color-mix(in srgb,var(--m) 13%,transparent);padding:2px 8px;border-radius:99px}
    .pl-hbar{position:relative;height:10px;border-radius:99px;background:var(--bg-subtle);overflow:hidden;margin:10px 0 6px}
    .pl-hbar i{position:absolute;left:0;top:0;bottom:0;border-radius:99px} .pl-hbar i.p{background:color-mix(in srgb,var(--m) 35%,transparent)} .pl-hbar i.f{background:var(--m);z-index:1}
    .pl-hbar-leg{display:flex;gap:16px;font-size:11.5px;color:var(--text-muted)} .pl-hbar-leg i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:0} .pl-hbar-leg i.f{background:var(--m)} .pl-hbar-leg i.p{background:color-mix(in srgb,var(--m) 35%,transparent)}
    .pl-hero-falta{font-size:13.5px;color:var(--text-secondary);margin-top:8px;line-height:1.5} .pl-hero-falta b{color:var(--text-primary)}
    .pl-stats{display:flex;flex-wrap:wrap;gap:10px 28px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}
    .pl-stats>div{display:flex;flex-direction:column;gap:1px;min-width:120px} .pl-stats span{font-size:11.5px;color:var(--text-muted)} .pl-stats b{font-size:16px;font-weight:650;font-variant-numeric:tabular-nums} .pl-stats small{font-size:11px;color:var(--text-muted)}
    .pl-stats-box{margin-top:0;padding-top:0;border-top:0}
    .pl-hero-diag{font-size:13px;line-height:1.55;color:var(--text-secondary);margin-top:12px;max-width:880px}
    .pl-seg{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 10px;padding:4px;background:var(--bg-subtle);border-radius:11px;width:fit-content;max-width:100%}
    .pl-seg button{all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;color:var(--text-secondary);display:inline-flex;gap:6px;align-items:center}
    .pl-seg button:hover{color:var(--text-primary)} .pl-seg button:focus-visible{outline:2px solid var(--accent)}
    .pl-seg button.on{background:var(--bg-card);color:var(--text-primary);box-shadow:var(--shadow-xs)}
    .pl-seg button b{font-size:11px;background:var(--accent);color:#fff;border-radius:99px;padding:1px 7px} .pl-seg button small{font-size:11px;color:var(--text-muted);font-weight:600}
    .pl-painel{padding:14px 16px;margin-bottom:14px}
    .pl-vazio{font-size:13px;color:var(--text-secondary);padding:6px 0}
    .pl-grupo+.pl-grupo{margin-top:16px} .pl-grupo-t{display:flex;gap:8px;align-items:baseline;font-weight:650;font-size:13px;margin-bottom:2px}
    .pl-acao{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center;padding:7px 0;border-top:1px solid var(--border)}
    .pl-acao.resolvida{opacity:.55}
    .pl-acao-main{all:unset;cursor:pointer;display:grid;grid-template-columns:62px minmax(0,1fr) auto;gap:10px;align-items:center;min-width:0;padding:3px 0;border-radius:6px}
    .pl-acao-main:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .pl-quem{font-size:11px;font-weight:650;color:var(--q)}
    .pl-acao-tit{font-size:13px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pl-acao.aberta .pl-acao-tit{white-space:normal}
    .pl-tag{font-size:10.5px;font-weight:700;color:var(--accent);background:var(--accent-glow);border-radius:5px;padding:1px 6px;margin-right:6px;vertical-align:1px}
    .pl-imp{font-size:12px;color:var(--text-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
    .pl-acao-bt{display:flex;gap:6px;align-items:center;justify-content:flex-end}
    .pl-acao-det{grid-column:1/-1;font-size:12.5px;line-height:1.5;color:var(--text-secondary);padding:2px 0 6px 72px}
    @media (max-width:760px){.pl-acao{grid-template-columns:1fr}.pl-acao-main{grid-template-columns:auto minmax(0,1fr)}.pl-imp{grid-column:2}.pl-acao-bt{justify-content:flex-start;flex-wrap:wrap}.pl-acao-det{padding-left:0}.pl-hero-em{text-align:left;flex-basis:100%}}
    .pl-cam-res{font-size:13.5px;color:var(--text-secondary);margin-bottom:12px} .pl-cam-res b{color:var(--text-primary)} .pl-cam-res small{font-size:11.5px;color:var(--text-muted)}
    .pl-cob{height:6px;border-radius:99px;background:var(--bg-subtle);overflow:hidden;margin:8px 0 3px;max-width:420px} .pl-cob i{display:block;height:100%;background:var(--green);border-radius:99px}
    .pl-alav-txt .pl-sub{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.45}
    .pl-rx-t{font-weight:650;font-size:13px;margin:16px 0 2px}
    .pl-rx-l{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start;padding:9px 0;border-top:1px solid var(--border)}
    .pl-rx-n{display:flex;flex-direction:column;gap:2px;min-width:0} .pl-rx-n b{font-size:13px;font-weight:600} .pl-rx-c{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}
    .pl-rx-v{font-weight:700;font-size:13.5px;white-space:nowrap;font-variant-numeric:tabular-nums} .pl-rx-v small{font-weight:500;font-size:11px;color:var(--text-muted)}
    .pl-ctr-reg{margin-top:10px}
    #pl-pauta{font-size:13px;line-height:1.5;resize:vertical}
    .pl-causa{display:inline-block;font-size:11.5px;padding:2px 7px;border-radius:6px;background:var(--bg-subtle);margin:1px 0} .pl-c-estoque{background:color-mix(in srgb,var(--orange) 15%,transparent)} .pl-c-ads{background:color-mix(in srgb,var(--accent) 14%,transparent)} .pl-c-preco{background:color-mix(in srgb,var(--purple) 14%,transparent)} .pl-c-anuncio,.pl-c-qualidade{background:color-mix(in srgb,var(--red) 12%,transparent)}
    .pl-acao-bt>*:not(:first-child){opacity:0;transition:opacity .15s}
    .pl-acao:hover .pl-acao-bt>*, .pl-acao:focus-within .pl-acao-bt>*, .pl-acao.resolvida .pl-acao-bt>*{opacity:1}
    @media (hover:none){.pl-acao-bt>*:not(:first-child){opacity:1}}
    .pl-tab-wrap{padding:0;overflow-x:auto}
    .pl-tab{width:100%;border-collapse:collapse;font-size:13px}
    .pl-tab th{font-size:11.5px;font-weight:600;color:var(--text-muted);text-align:left;padding:10px 14px;border-bottom:1px solid var(--border);white-space:nowrap}
    .pl-tab td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:top}
    .pl-tab tbody tr{cursor:pointer;box-shadow:inset 3px 0 0 var(--c)} .pl-tab tbody tr:hover{background:var(--bg-subtle)}
    .pl-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    .pl-tab .pl-queda{max-width:340px}
    .pl-meta-form{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:flex-end;margin-bottom:12px} .pl-meta-form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)}
    .pl-in{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)} .pl-in input{width:150px}
    .pl-meta-ls{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:10px}
    .pl-meta-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--text-secondary)} .pl-meta-top b{font-size:16px;color:var(--text-primary);font-variant-numeric:tabular-nums} .pl-meta-top b small{font-size:12px;color:var(--text-muted);font-weight:500}
    .pl-barra{height:8px;border-radius:99px;background:var(--bg-subtle);overflow:hidden;margin:6px 0 4px} .pl-barra i{display:block;height:100%;border-radius:99px}
    .pl-meta-falta{font-size:13px;margin:6px 0 10px;color:var(--text-secondary)} .pl-meta-falta b{color:var(--text-primary)}
    .pl-meta-ok{font-size:13px;color:var(--green);font-weight:600;margin-top:4px}
    .pl-alav{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:10px;overflow:hidden}
    .pl-alav-i{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:9px 12px;border-top:1px solid var(--border)} .pl-alav-i:first-child{border-top:0}
    .pl-alav-txt b{font-size:13px;font-weight:600} .pl-alav-v{text-align:right;display:flex;flex-direction:column} .pl-alav-v b{font-size:14px;color:var(--green);font-variant-numeric:tabular-nums} .pl-alav-v small{font-size:11px}
    .pl-meta-agentes{font-size:12.5px;color:var(--text-secondary);background:color-mix(in srgb,var(--accent) 7%,var(--bg-surface));border-radius:10px;padding:9px 12px;margin-top:10px;line-height:1.5}
    .pl-meta-resto{font-size:12.5px;color:var(--text-secondary);background:var(--bg-subtle);border-radius:10px;padding:9px 12px;margin-top:10px;line-height:1.5}
    .pl-ctr-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}
    .pl-ctr-t{font-size:12px;font-weight:650;color:var(--text-secondary);margin-bottom:6px}
    .pl-ctr-op{display:flex;gap:8px;align-items:flex-start;padding:7px 9px;border:1px solid var(--border);border-radius:9px;margin-bottom:6px;cursor:pointer} .pl-ctr-op:has(input:checked){border-color:var(--accent);background:var(--accent-glow)}
    .pl-ctr-op span{display:flex;flex-direction:column} .pl-ctr-op b{font-size:13px} .pl-ctr-op small{font-size:11.5px;color:var(--text-muted);line-height:1.45}
    .pl-ctr-a{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px} .pl-ctr-a select{width:140px;flex-shrink:0}
    .pl-ctr-a>span{display:flex;flex-direction:column;gap:1px} .pl-ctr-res{font-size:11.5px;color:var(--text-muted)} .pl-ctr-mud{font-size:11.5px;color:var(--accent)}
    .pl-ctr-fixo{display:flex;gap:7px;align-items:center;font-size:12.5px;margin-top:8px;cursor:pointer}
    .pl-bloco{padding:12px 14px;margin-bottom:12px} .pl-bloco-t{font-weight:650;font-size:14px;margin-bottom:8px;display:flex;gap:8px;align-items:baseline}
    .pl-x{border:1px solid var(--border);background:none;border-radius:8px;width:28px;height:28px;cursor:pointer;color:var(--text-muted)}
  </style>`;
  carregar();
});
