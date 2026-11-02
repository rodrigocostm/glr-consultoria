// ============================================================
// GLR Consultoria — Caixa de decisões
// ------------------------------------------------------------
// Tudo que pede uma decisão do analista, de todos os agentes e clientes, numa
// fila só — ordenada pelo que vence primeiro e depois pelo R$ em jogo:
//  • ADS Shopee: sugestões fora do limite automático (inclusive o freio de
//    volume) → Aprovar executa na Shopee (mesma regra do ADS Shopee, js/acoes-agente.js);
//  • ADS Mercado Livre: passos do pacote → aplicar no painel do ML e marcar Feito;
//  • Faturamento: as quedas do Raio-X do Gerente (Plano de ação);
//  • Reputação: reclamação com prazo vencendo;
//  • Promoções: promoções que cabem na margem;
//  • Estoque: produto que o ADS empurra e acaba em até 7 dias (repor antes de zerar).
// Limpeza: o servidor fecha de hora em hora as sugestões vencidas e as que uma
// mais nova substituiu (api/agente-cron.js limparDecisoes); cada loja mostra as
// 3 de maior impacto e o resto fica em "ver mais".
// "Abrir" leva para a tela certa já no cliente da decisão (cliente em foco).
// Tela: um card por cliente (gestor, tipos, prazos, R$ em jogo e as 3 principais);
// o card abre as decisões do cliente separadas por loja. Filtro por gestor.
// ============================================================
Router.register('decisoes', (params, el) => {
  const R$ = v => 'R$ ' + (Math.round(parseFloat(v) || 0)).toLocaleString('pt-BR');
  const R2 = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const corta = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const dataCurta = iso => iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';
  const TIPOS = {
    'retencao': { t: 'Retenção', c: 'var(--red)' },
    'onboarding': { t: 'Implantação', c: 'var(--accent)' },
    'reputacao': { t: 'Reputação', c: 'var(--red)' },
    'saldo': { t: 'Saldo de ADS', c: 'var(--red)' },
    'conexao': { t: 'Conexão', c: 'var(--red)' },
    'ads-shopee': { t: 'ADS Shopee', c: '#eb6834' },
    'ads-ml': { t: 'ADS ML', c: '#d9a400' },
    'estoque': { t: 'Estoque', c: '#1f9d74' },
    'conversao': { t: 'Catálogo ML', c: '#d9a400' },
    'faturamento': { t: 'Faturamento', c: 'var(--accent)' },
    'promocoes': { t: 'Promoções', c: 'var(--purple)' },
  };
  const ACAO_REC = { send_attachments: 'Enviar provas', send_message_to_mediator: 'Responder ao mediador', refund: 'Resolver reembolso' };
  const lerLS = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
  const st = { aberto: null, gestor: lerLS('glr_dc_gestor', 'todos'), itens: [], carregando: true, erro: null, filtro: 'todos', abertos: new Set(), sel: new Set(), proc: {}, lote: null, lojasTodas: new Set() };
  window._dcSt = st;

  // decisões que não ficam no registro dos agentes (plano, reputação, promoções): feito/descartado por aqui
  const K_OK = 'glr_decisoes_ok';
  const resolvidasLocais = () => lerJSON(K_OK, {});
  const resolverLocal = id => { const m = resolvidasLocais(); m[id] = Date.now(); for (const k of Object.keys(m)) if (Date.now() - m[k] > 30 * 864e5) delete m[k]; localStorage.setItem(K_OK, JSON.stringify(m)); };

  function acaoShopee(d) {
    if (d.retomar) return `Reativar${d.roas_sugerido != null ? ` com ROAS ${d.roas_sugerido}x` : ''}`;
    if (d.pausar) return 'Pausar campanha';
    if (d.roas_sugerido != null) return `ROAS ${d.roas_atual ?? '?'}x → ${d.roas_sugerido}x`;
    if (d.budget_sugerido != null) return `Orçamento ${R$(d.budget_atual)} → ${R$(d.budget_sugerido)}/dia`;
    return '';
  }

  async function carregar() {
    st.carregando = true; render();
    try {
      const desde = new Date(Date.now() - 10 * 864e5).toISOString();
      const [logs, planos, reps, promos, conex] = await Promise.all([
        _sb.from('glr_agente_log').select('id,conta_id,cliente_nome,titulo,explicacao,dados,criado_em').eq('tipo', 'alerta').eq('resultado', 'so_alerta').gte('criado_em', desde).order('criado_em', { ascending: false }).limit(3000),
        _sb.from('glr_sync_estado').select('conta_id,cursor').eq('marketplace', 'sistema').eq('recurso', 'plano'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,rec:cursor->reclamacoes').eq('recurso', 'reputacao'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,res:cursor->resumo,dest:cursor->destaques').eq('recurso', 'promocoes'),
        _sb.from('glr_sync_estado').select('cursor').eq('marketplace', 'sistema').eq('conta_id', 'conexoes').eq('recurso', 'todas').maybeSingle(),
      ]);
      for (const r of [logs, planos, reps, promos]) if (r.error) throw r.error;
      const itens = [], locais = resolvidasLocais(), planoSt = lerJSON('glr_plano_status', {});
      for (const l of logs.data || []) {
        const d = l.dados || {};
        if (d.acao === 'abc_queda') continue; // informativo: já aparece no Raio-X do Plano de ação
        const mkt = d.marketplace === 'ml' ? 'ml' : 'shopee';
        if (d.promo_aprovar) { // promoção preparada pelo agente (pela meta): só entra com aprovação
          itens.push({ id: 'log:' + l.id, log: l, tipo: 'promocoes', mkt, conta: String(l.conta_id), titulo: `Entrar em promoção — ${d.produto || d.item_id}`,
            acao: `${d.promo || 'Promoção'} a ${R$(d.preco)} · lucro ${R$(d.lucro_venda)}/venda (margem ${String(d.margem ?? '—').replace('.', ',')}%)`,
            porque: String(l.explicacao || ''), impacto: d.impacto || null, impactoTipo: 'ganho', exec: true, tela: 'promocoes', quando: l.criado_em });
          continue;
        }
        if (d.acao === 'saldo_ads') { // monitor de saldo de ADS da Shopee: recarregar é com o analista/cliente
          const diasTxt = d.nivel === 'zerado' ? 'anúncios parados' : d.dias_restantes != null ? `dura ~${String(Math.round(d.dias_restantes * 10) / 10).replace('.', ',')} dia(s)` : '';
          itens.push({ id: 'log:' + l.id, log: l, tipo: 'saldo', mkt: 'shopee', conta: String(l.conta_id), titulo: String(l.titulo || '').replace(/\s+—\s+[^—]*$/, ''),
            acao: `Recarregar — saldo ${R$(d.saldo)}${diasTxt ? ` · ${diasTxt}` : ''}`, porque: String(l.explicacao || ''), urgente: d.nivel !== 'baixo', exec: false, tela: 'agente', quando: l.criado_em });
          continue;
        }
        if (d.acao === 'onboarding') { // Agente de Onboarding: implantação do cliente travada num passo essencial
          itens.push({ id: 'log:' + l.id, log: l, tipo: 'onboarding', mkt: 'cliente', conta: String(l.conta_id), clienteFixo: String(d.cliente_id || ''), titulo: `Implantação travada — falta ${(d.faltam || []).map(x => x.toLowerCase()).join(', ')}`,
            acao: `${d.pct ?? 0}% pronto`, porque: String(l.explicacao || ''), urgente: false, exec: false, tela: 'onboarding', quando: l.criado_em, nomeCliente: l.cliente_nome });
          continue;
        }
        if (d.acao === 'retencao') { // Agente de Retenção: o aviso é do cliente, não de uma loja
          itens.push({ id: 'log:' + l.id, log: l, tipo: 'retencao', mkt: 'cliente', conta: String(l.conta_id), clienteFixo: String(d.cliente_id || ''), titulo: `Cliente em risco de cancelar${d.gestor ? ` — ${d.gestor}` : ''}`,
            acao: `risco ${d.score}/100`, porque: (d.motivos || []).join(' · '), urgente: true, exec: false, tela: 'retencao', quando: l.criado_em, nomeCliente: l.cliente_nome });
          continue;
        }
        if (d.acao === 'buybox_preco' || d.acao === 'catalogo_optin') { // Agente de Conversão no ML: aprovar aplica no ML
          const cat = d.acao === 'catalogo_optin';
          itens.push({ id: 'log:' + l.id, log: l, tipo: 'conversao', mkt: 'ml', conta: String(l.conta_id), titulo: cat ? `Entrar no catálogo — ${d.produto || d.item_id}` : `Ganhar o catálogo — ${d.produto || d.item_id}`,
            acao: cat ? 'publicar no catálogo' : `${R2(d.preco_atual)} → ${R2(d.preco_sugerido)}${d.margem_nova != null ? ` · margem ${String(d.margem_nova).replace('.', ',')}%` : ''}`,
            porque: String(l.explicacao || ''), impacto: d.impacto || null, impactoTipo: 'ganho', exec: !!GLRAcoes.tipoDe(d), tela: 'conversao-ml', quando: l.criado_em });
          continue;
        }
        if (d.acao === 'estoque_minimo') { // agente de ADS: produto da campanha acabando — repor é com o cliente
          const diasTxt = d.dias != null ? ` · acaba em ~${String(d.dias).replace('.', ',')} dia(s)` : '';
          itens.push({ id: 'log:' + l.id, log: l, tipo: 'estoque', mkt, conta: String(l.conta_id), titulo: `Repor estoque — ${d.produto || ''}`,
            acao: `${d.estoque ?? '?'} un.${diasTxt}`, porque: String(l.explicacao || ''), urgente: d.dias != null && d.dias <= 3, exec: false, tela: 'estoque-margem', quando: l.criado_em });
          continue;
        }
        const impacto = d.impacto != null ? parseFloat(d.impacto) : d.freio_volume ? Math.max(0, (d.venda_antes || 0) - (d.venda_agora || 0)) : null;
        itens.push({
          id: 'log:' + l.id, log: l, tipo: mkt === 'ml' ? 'ads-ml' : 'ads-shopee', mkt, conta: String(l.conta_id),
          titulo: String(l.titulo || '').replace(/^Sugestão:\s*/, '').replace(/^Sugestão de /, ''), acao: mkt === 'shopee' ? acaoShopee(d) : '',
          porque: String(l.explicacao || '').replace(/\s*Como fazer no ML:[^]*$/, ''), impacto, impactoTipo: d.impacto_tipo || (d.freio_volume ? 'ganho' : null),
          exec: mkt === 'shopee' && !!GLRAcoes.tipoDe(d), tela: mkt === 'ml' ? 'agente-ml' : 'agente', quando: l.criado_em, freio: !!d.freio_volume,
        });
      }
      for (const r of planos.data || []) {
        const p = r.cursor; if (!p?.acoes) continue;
        for (const a of p.acoes.filter(a => a.tipo === 'faturamento')) {
          if (planoSt[a.id] || locais['fat:' + a.id]) continue;
          itens.push({ id: 'fat:' + a.id, tipo: 'faturamento', mkt: a.mkt, conta: String(a.conta), cliente: p.cliente?.nome, titulo: a.titulo, porque: a.porque, impacto: a.valor, impactoTipo: 'ganho', tela: a.tela, quando: p.em ? new Date(p.em).toISOString() : null, planoId: a.id });
        }
      }
      for (const r of reps.data || []) {
        for (const c of (r.rec || []).filter(c => c.prazo)) {
          const dias = (new Date(c.prazo).getTime() - Date.now()) / 864e5;
          const id = `rec:${r.conta_id}:${c.id}`;
          if (dias > 3 || locais[id]) continue;
          itens.push({ id, tipo: 'reputacao', mkt: r.marketplace, conta: String(r.conta_id), titulo: `${ACAO_REC[c.acao] || 'Agir'} na reclamação${c.produto ? ` — ${corta(c.produto, 50)}` : ''}`,
            porque: `${c.etapa === 'dispute' ? 'Mediação' : 'Reclamação'} do pedido ${c.pedido}. Perder o prazo derruba a reputação e trava o ADS da conta.`, prazo: c.prazo, urgente: true, tela: 'atendimento' });
        }
      }
      const hoje = new Date().toISOString().slice(0, 10);
      for (const r of promos.data || []) {
        const n = r.res?.sugeridas || 0, id = `promo:${r.conta_id}:${hoje}`;
        if (!n || locais[id]) continue;
        const ex = r.dest?.sugeridas?.[0];
        itens.push({ id, tipo: 'promocoes', mkt: r.marketplace, conta: String(r.conta_id), titulo: `Aplicar ${n} promoção(ões) que cabem na margem`,
          porque: ex ? `Ex.: ${corta(ex.n, 60)} — ${ex.rot}${ex.m != null ? `, margem ${String(ex.m).replace('.', ',')}%` : ''}${r.res.parados ? ` · ${r.res.parados} giram estoque parado` : ''}` : '', tela: 'promocoes' });
      }
      // conexões com problema (Saúde das conexões, servidor de hora em hora): conta parada não entra nas vendas nem nos agentes
      const NOME_MKT = { shopee: 'Shopee', ml: 'Mercado Livre', amazon: 'Amazon', tiktok: 'TikTok Shop', magalu: 'Magalu', shein: 'Shein' };
      for (const c of Object.values(conex?.data?.cursor?.contas || {})) {
        if (c.status !== 'erro' && c.status !== 'ads') continue;
        const id = `cx:${c.mkt}:${c.id}:${c.desde || ''}`;
        if (locais[id]) continue;
        itens.push({ id, tipo: 'conexao', mkt: c.mkt, conta: String(c.id), titulo: `${c.status === 'ads' ? 'Liberar permissão de Ads' : 'Reconectar'} — ${c.nome} (${NOME_MKT[c.mkt] || c.mkt})`,
          porque: c.acao || '', urgente: c.status === 'erro', tela: 'conexoes', quando: c.desde || null });
      }
      // conta que não está mais em nenhum cliente (cliente excluído / conta desvinculada) sai da fila
      const vinc = lerJSON('glr_mc_vinculos', {}), contasVinc = new Set(Object.values(vinc).flatMap(a => (a || []).flatMap(c => [c.external_id, c.param_to_use?.shopId, c.param_to_use?.meliUserId].filter(Boolean).map(String))));
      if (contasVinc.size) for (let i = itens.length - 1; i >= 0; i--) if (!itens[i].clienteFixo && !contasVinc.has(itens[i].conta)) itens.splice(i, 1);
      const nomear = it => {
        if (it.clienteFixo) { it.clienteId = it.clienteFixo; it.loja = `${(GLR.clientes || []).find(c => String(c.id) === it.clienteFixo)?.nome || it.nomeCliente || 'Cliente'} · Carteira`; return; }
        it.loja = GLR.nomeConta(it.mkt, it.conta); it.clienteId = GLR.ctx?.clienteDaConta(it.mkt, it.conta) || '';
      };
      itens.forEach(nomear);
      itens.sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0) || (a.urgente && b.urgente ? new Date(a.prazo) - new Date(b.prazo) : 0)
        || (b.impacto || 0) - (a.impacto || 0) || String(b.quando || '').localeCompare(String(a.quando || '')));
      st.itens = itens; st.erro = null;
      GLR.quandoClientes(() => { st.itens.forEach(nomear); render(); });
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
    window.dispatchEvent(new CustomEvent('glr:decisoes', { detail: { n: st.itens.length } }));
  }

  // gestor do cliente pelo cadastro (o filtro e o card mostram o nome)
  const gestorDe = cid => { const c = (GLR.clientes || []).find(x => String(x.id) === String(cid)); const g = (GLR.gestores || []).find(x => String(x.id) === String(c?.gestorId)); return { id: g ? String(g.id) : 'sem', nome: g?.nome || c?.gestor || 'Sem gestor' }; };
  const doGestor = it => st.gestor === 'todos' || gestorDe(it.clienteId).id === st.gestor;
  const visiveis = () => {
    const foco = GLR.ctx?.cliente();
    return st.itens.filter(it => (!foco || it.clienteId === foco) && doGestor(it) && (st.filtro === 'todos' || it.tipo === st.filtro || (st.filtro === 'aprovar' && it.exec)));
  };

  function render() {
    if (window._dcSt !== st) return;
    const root = document.getElementById('dc-root'); if (!root) return;
    if (st.carregando && !st.itens.length) { root.innerHTML = '<div class="card" style="padding:18px">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card" style="padding:18px;color:var(--red)">Não consegui carregar as decisões: ${h(st.erro)} <button class="btn btn-secondary btn-sm" onclick="window._dcRecarregar()">Tentar de novo</button></div>`; return; }
    const foco = GLR.ctx?.cliente();
    const base = st.itens.filter(it => (!foco || it.clienteId === foco) && doGestor(it));
    const gestores = [...new Map(st.itens.map(it => { const g = gestorDe(it.clienteId); return [g.id, g.nome]; })).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const lista = visiveis();
    const emJogo = lista.reduce((s, it) => s + (it.impacto || 0), 0);
    const nExec = base.filter(it => it.exec).length;
    const selExec = lista.filter(it => it.exec && st.sel.has(it.id));
    const chips = [['todos', 'Tudo', base.length], ['aprovar', 'Aprovar com 1 clique', nExec], ...Object.entries(TIPOS).map(([k, v]) => [k, v.t, base.filter(it => it.tipo === k).length])].filter(([k, , n]) => k === 'todos' || n);
    root.innerHTML = `
      <div class="dc-topo">
        <div class="dc-num"><b>${lista.length}</b><span>decisão(ões)${foco ? ' deste cliente' : ''}</span></div>
        ${emJogo > 0 ? `<div class="dc-num"><b>${R$(emJogo)}</b><span>por semana em jogo</span></div>` : ''}
        <div class="dc-num"><b>${lista.filter(it => it.urgente).length}</b><span>com prazo vencendo</span></div>
        <span style="flex:1"></span>
        ${selExec.length ? `<button class="btn btn-primary btn-sm" ${st.lote ? 'disabled' : ''} onclick="window._dcAprovarSel()">${st.lote ? h(st.lote) : `Aprovar ${selExec.length} selecionada(s)`}</button>` : ''}
        <button class="btn btn-secondary btn-sm" ${st.carregando ? 'disabled' : ''} onclick="window._dcRecarregar()" title="Buscar de novo">↻</button>
      </div>
      <div class="dc-nota">Sugestões vencidas ou repetidas fecham sozinhas a cada hora — se ainda valer, o agente sugere de novo. Em cada loja aparecem as 3 de maior impacto.</div>
      <div class="dc-filtros"><div class="dc-chips">${chips.map(([k, t, n]) => `<button class="dc-chip ${st.filtro === k ? 'on' : ''}" onclick="window._dcFiltro('${k}')">${h(t)} <b>${n}</b></button>`).join('')}</div>
        <select class="form-control dc-gestor" aria-label="Gestor" onchange="window._dcGestor(this.value)"><option value="todos">Todos os gestores</option>${gestores.map(([id, nome]) => `<option value="${h(id)}" ${st.gestor === id ? 'selected' : ''}>${h(nome)}</option>`).join('')}</select></div>
      ${lista.length ? renderGrupos(lista, !!foco)
        : `<div class="card dc-vazio"><b>Nada esperando você${foco ? ' neste cliente' : ''}.</b><span>Os agentes não encontraram nada que precise de decisão agora.</span></div>`}`;
  }

  // ── Agrupado por cliente → loja (o nome da conta vem como "Cliente · Loja") ──
  const NOME_MKT = { ML: 'Mercado Livre', Shopee: 'Shopee', AMZ: 'Amazon', TT: 'TikTok Shop' };
  const partes = it => { const t = String(it.loja || it.cliente || ''); const i = t.indexOf(' · '); const [c, l] = i > 0 ? [t.slice(0, i), t.slice(i + 3)] : [t || 'Sem cliente', t || '']; return [c, NOME_MKT[l] || l.replace(/^ML /, 'Mercado Livre · ')]; };
  function agrupar(lista) {
    const cls = new Map();
    for (const it of lista) {
      const [cn, ln] = partes(it), ck = it.clienteId || cn;
      const c = cls.get(ck) || { k: ck, nome: cn, itens: [], lojas: new Map() };
      c.itens.push(it);
      const lk = `${it.mkt}:${it.conta}`, l = c.lojas.get(lk) || { k: lk, nome: ln, itens: [] };
      l.itens.push(it); c.lojas.set(lk, l); cls.set(ck, c);
    }
    const soma = xs => xs.reduce((s2, it) => s2 + (it.impacto || 0), 0), urg = xs => xs.filter(it => it.urgente).length;
    return [...cls.values()].map(c => ({ ...c, rs: soma(c.itens), urg: urg(c.itens), lojas: [...c.lojas.values()].map(l => ({ ...l, rs: soma(l.itens), urg: urg(l.itens) })).sort((a, b) => b.urg - a.urg || b.rs - a.rs || b.itens.length - a.itens.length) }))
      .sort((a, b) => b.urg - a.urg || b.rs - a.rs || b.itens.length - a.itens.length);
  }
  const POR_LOJA = 3; // as 3 de maior impacto (a lista já vem em ordem de prazo e R$)
  function renderGrupos(lista, umCliente) {
    const gs = agrupar(lista);
    const g = umCliente && gs.length === 1 ? gs[0] : gs.find(x => x.k === st.aberto);
    if (g) return detalhe(g, !umCliente);
    // um card por cliente: o que tem prazo vencendo e mais R$ em jogo vem primeiro
    return `<div class="dc-grade">${gs.map(c => {
      const porTipo = Object.entries(c.itens.reduce((m, it) => { m[it.tipo] = (m[it.tipo] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
      const ex = c.itens.filter(it => it.exec).length, cor = c.urg ? 'var(--red)' : c.rs > 0 ? 'var(--accent)' : 'var(--border)';
      return `<button type="button" class="dc-card" style="--c:${cor}" onclick="window._dcAbrirCliente('${h(c.k)}')">
        <div class="dc-card-top"><div><b>${h(c.nome)}</b><span>${h(gestorDe(c.itens[0]?.clienteId).nome)}${c.lojas.length > 1 ? ` · ${c.lojas.length} lojas` : ''}</span></div>${c.urg ? `<span class="dc-card-urg">${c.urg} vencendo</span>` : ''}</div>
        <div class="dc-card-nums"><div><b>${c.itens.length}</b><span>decisão(ões)</span></div>${c.rs > 0 ? `<div><b>${R$(c.rs)}</b><span>por semana em jogo</span></div>` : ''}${ex ? `<div><b>${ex}</b><span>aprovar com 1 clique</span></div>` : ''}</div>
        <div class="dc-g-tipos">${porTipo.map(([t, n]) => `<span class="dc-g-t" style="--c:${TIPOS[t]?.c || 'var(--text-muted)'}">${TIPOS[t]?.t || t} ${n}</span>`).join('')}</div>
        <ul class="dc-card-top3">${c.itens.slice(0, 3).map(it => `<li style="--c:${TIPOS[it.tipo]?.c || 'var(--text-muted)'}"><i></i><span>${h(corta(it.titulo, 70))}</span>${it.impacto ? `<b>${R$(it.impacto)}</b>` : ''}</li>`).join('')}</ul>
        <span class="dc-card-ir">Ver as ${c.itens.length} decisão(ões) →</span>
      </button>`;
    }).join('')}</div>`;
  }
  // decisões de um cliente, separadas por loja
  function detalhe(g, comVoltar) {
    return `<div class="card dc-det">
      <div class="dc-det-cab">${comVoltar ? `<button type="button" class="dc-voltar" onclick="window._dcAbrirCliente(null)">← Todos os clientes</button>` : ''}
        <div class="dc-det-nome"><b>${h(g.nome)}</b><span>${h(gestorDe(g.itens[0]?.clienteId).nome)} · ${g.itens.length} decisão(ões)${g.rs > 0 ? ` · ${R$(g.rs)}/sem em jogo` : ''}${g.urg ? ` · <b class="dc-prazo">${g.urg} vencendo</b>` : ''}</span></div></div>
      ${g.lojas.map(l => { const ex = l.itens.filter(it => it.exec);
        return `<div class="dc-loja">
          <div class="dc-loja-cab"><span class="dc-loja-nome">${h(l.nome || 'Loja')}</span><span class="pl-sub">${l.itens.length} decisão(ões)${l.rs > 0 ? ` · ${R$(l.rs)}/sem` : ''}</span><span style="flex:1"></span>
            ${ex.length >= 2 ? `<button class="btn btn-secondary btn-sm" ${st.lote ? 'disabled' : ''} onclick="window._dcAprovarLoja('${h(g.k)}','${h(l.k)}')">Aprovar as ${ex.length} desta loja</button>` : ''}</div>
          ${(st.lojasTodas.has(l.k) ? l.itens : l.itens.slice(0, POR_LOJA)).map(linha).join('')}
          ${l.itens.length > POR_LOJA && !st.lojasTodas.has(l.k) ? `<button type="button" class="dc-mais" onclick="window._dcLojaTodas('${h(l.k)}')">ver mais ${l.itens.length - POR_LOJA} desta loja</button>` : ''}
        </div>`; }).join('')}
    </div>`;
  }

  function linha(it) {
    const T = TIPOS[it.tipo], proc = st.proc[it.id], aberto = st.abertos.has(it.id);
    const prazo = it.prazo ? (() => { const d = Math.round((new Date(it.prazo).getTime() - Date.now()) / 864e5); return d <= 0 ? 'vence hoje' : `vence em ${d} dia(s)`; })() : '';
    return `<div class="dc-li ${it.urgente ? 'urgente' : ''}" style="--c:${T.c}">
      <div class="dc-sel">${it.exec ? `<input type="checkbox" aria-label="Selecionar" ${st.sel.has(it.id) ? 'checked' : ''} onchange="window._dcMarcarSel('${h(it.id)}', this.checked)">` : ''}</div>
      <div class="dc-txt" onclick="window._dcAbrirTxt('${h(it.id)}')">
        <div class="dc-meta"><span class="dc-tipo">${T.t}</span>${prazo ? `<span class="dc-prazo">${prazo}</span>` : ''}${it.freio ? '<span class="dc-freio" title="O agente parou de apertar porque a venda do produto caiu">freio de volume</span>' : ''}${it.quando && !prazo ? `<span>${dataCurta(it.quando)}</span>` : ''}</div>
        <div class="dc-tit">${h(it.titulo)}${it.acao ? ` <span class="dc-acao">${h(it.acao)}</span>` : ''}</div>
        ${it.porque ? `<div class="dc-porque ${aberto ? 'aberto' : ''}">${h(it.porque)}</div>` : ''}
      </div>
      <div class="dc-imp">${it.impacto ? `<b>${R$(it.impacto)}</b><small>${it.impactoTipo === 'economia' ? 'a cortar/sem' : 'por semana'}</small>` : ''}</div>
      <div class="dc-bt">${proc ? `<span class="dc-proc">${h(proc)}</span>` : `
        ${it.exec ? `<button class="btn btn-primary btn-sm" onclick="window._dcAprovar('${h(it.id)}')">Aprovar</button>` : `<button class="btn btn-secondary btn-sm" onclick="window._dcIr('${h(it.id)}')">Abrir</button>`}
        ${it.exec ? `<button class="btn btn-ghost btn-sm" title="Abrir na tela do ADS" onclick="window._dcIr('${h(it.id)}')">↗</button>` : `<button class="btn btn-ghost btn-sm" title="Já fiz" onclick="window._dcFeito('${h(it.id)}')">Feito</button>`}
        <button class="dc-x" title="Descartar" aria-label="Descartar" onclick="window._dcDescartar('${h(it.id)}')">✕</button>`}</div>
    </div>`;
  }

  const achar = id => st.itens.find(x => x.id === id);
  const tirar = id => { st.itens = st.itens.filter(x => x.id !== id); st.sel.delete(id); window.dispatchEvent(new CustomEvent('glr:decisoes', { detail: { n: st.itens.length } })); };
  window._dcRecarregar = () => carregar();
  window._dcFiltro = k => { st.filtro = k; render(); };
  window._dcGestor = g => { st.gestor = g; st.aberto = null; try { localStorage.setItem('glr_dc_gestor', g); } catch (e) {} render(); };
  window._dcAbrirCliente = k => { st.aberto = k; render(); window.scrollTo({ top: 0 }); };
  window._dcLojaTodas = k => { st.lojasTodas.add(k); render(); };
  window._dcAprovarLoja = (ck, lk) => {
    const g = agrupar(visiveis()).find(x => x.k === ck), l = g?.lojas.find(x => x.k === lk);
    if (l) aprovarLote(l.itens.filter(it => it.exec), `${g.nome} · ${l.nome}`);
  };
  window._dcAbrirTxt = id => { st.abertos.has(id) ? st.abertos.delete(id) : st.abertos.add(id); render(); };
  window._dcMarcarSel = (id, on) => { on ? st.sel.add(id) : st.sel.delete(id); render(); };
  window._dcIr = id => { const it = achar(id); if (!it) return; if (it.clienteId) GLR.ctx?.definir(it.clienteId, true); Router.navigate(it.tela); };
  window._dcAprovar = async id => {
    const it = achar(id); if (!it?.exec) return;
    st.proc[id] = 'Executando…'; render();
    try { await GLRAcoes.executar(it.log); tirar(id); }
    catch (e) { alert('Não consegui executar: ' + (e.message || e)); }
    delete st.proc[id]; render();
  };
  window._dcAprovarSel = () => aprovarLote(visiveis().filter(it => it.exec && st.sel.has(it.id)));
  async function aprovarLote(sel, onde) {
    if (!sel.length || st.lote) return;
    if (!confirm(`Aprovar e executar agora ${sel.length} sugestão(ões)${onde ? ` de ${onde}` : ''}?\n\n${sel.slice(0, 12).map(it => `• ${it.acao || ''} — ${corta(it.titulo, 60)}`).join('\n')}${sel.length > 12 ? `\n… e mais ${sel.length - 12}` : ''}`)) return;
    const falhas = []; let n = 0;
    for (const it of sel) {
      st.lote = `Executando ${++n} de ${sel.length}…`; render();
      try { await GLRAcoes.executar(it.log); tirar(it.id); } catch (e) { falhas.push(`${corta(it.titulo, 50)}: ${e.message || e}`); }
    }
    st.lote = null; render();
    if (falhas.length) alert(`Executei ${sel.length - falhas.length} de ${sel.length}. Falharam:\n${falhas.slice(0, 8).join('\n')}`);
  }
  async function resolver(id, resultado) {
    const it = achar(id); if (!it) return;
    st.proc[id] = resultado === 'executado' ? 'Marcando…' : 'Descartando…'; render();
    try {
      if (it.log) await GLRAcoes.marcar(it.log, resultado);
      else if (it.planoId) { const s = lerJSON('glr_plano_status', {}); s[it.planoId] = { st: resultado === 'executado' ? 'feito' : 'descartada', em: Date.now() }; localStorage.setItem('glr_plano_status', JSON.stringify(s)); }
      else resolverLocal(id);
      tirar(id);
    } catch (e) { alert('Não consegui salvar: ' + (e.message || e)); }
    delete st.proc[id]; render();
  }
  window._dcFeito = id => resolver(id, 'executado');
  window._dcDescartar = id => resolver(id, 'descartado');

  el.innerHTML = `<div class="page"><div id="dc-root"></div></div>
  <style>
    .dc-topo{display:flex;align-items:center;gap:22px;flex-wrap:wrap;margin-bottom:12px}
    .dc-num{display:flex;flex-direction:column} .dc-num b{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1} .dc-num span{font-size:12px;color:var(--text-muted)}
    .dc-nota{font-size:12px;color:var(--text-muted);margin:-4px 0 10px}
    .dc-filtros{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px} .dc-filtros .dc-chips{margin-bottom:0}
    .dc-gestor{width:auto;max-width:220px}
    .dc-grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
    .dc-card{all:unset;box-sizing:border-box;cursor:pointer;display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:14px;background:var(--bg-card);border:1px solid var(--border);box-shadow:inset 4px 0 0 var(--c)}
    .dc-card:hover{border-color:color-mix(in srgb,var(--c) 45%,var(--border))} .dc-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .dc-card-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start} .dc-card-top>div{display:flex;flex-direction:column;min-width:0} .dc-card-top b{font-size:14.5px;font-weight:650;color:var(--text-primary)} .dc-card-top span{font-size:12px;color:var(--text-muted)}
    .dc-card-urg{font-size:11.5px !important;font-weight:700;color:var(--red) !important;background:color-mix(in srgb,var(--red) 10%,transparent);border-radius:99px;padding:2px 8px;white-space:nowrap}
    .dc-card-nums{display:flex;gap:18px;flex-wrap:wrap} .dc-card-nums>div{display:flex;flex-direction:column} .dc-card-nums b{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text-primary)} .dc-card-nums span{font-size:11px;color:var(--text-muted)}
    .dc-card-top3{list-style:none;margin:0;padding:10px 0 0;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:6px}
    .dc-card-top3 li{display:flex;gap:8px;align-items:baseline;font-size:12.5px;color:var(--text-secondary);line-height:1.35} .dc-card-top3 i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--c);transform:translateY(-1px)} .dc-card-top3 span{flex:1;min-width:0} .dc-card-top3 b{font-size:12px;font-weight:650;color:var(--text-primary);white-space:nowrap}
    .dc-card-ir{font-size:12.5px;font-weight:600;color:var(--accent)}
    .dc-det{padding:0;overflow:hidden}
    .dc-det-cab{display:flex;flex-direction:column;gap:8px;padding:14px 16px}
    .dc-voltar{all:unset;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--accent);width:fit-content} .dc-voltar:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .dc-det-nome{display:flex;flex-direction:column} .dc-det-nome b{font-size:16px;font-weight:650} .dc-det-nome span{font-size:12.5px;color:var(--text-muted)}
    .dc-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
    .dc-chip{border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
    .dc-chip b{color:var(--text-primary);font-weight:650;margin-left:2px} .dc-chip.on{border-color:var(--accent);background:var(--accent-glow);color:var(--accent-light)}
    .dc-grupos{display:flex;flex-direction:column;gap:10px}
    .dc-g{padding:0;overflow:hidden}
    .dc-g-cab{display:flex;align-items:center;gap:12px;flex-wrap:wrap;width:100%;padding:13px 16px;border:0;background:none;cursor:pointer;text-align:left;font-family:inherit;color:var(--text-primary)}
    .dc-g-cab:hover{background:var(--bg-subtle)} .dc-g-cab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
    .dc-g-seta{color:var(--text-muted);transition:transform .15s;display:inline-block} .dc-g.aberto .dc-g-seta{transform:rotate(90deg)}
    .dc-g-nome{font-size:14.5px;font-weight:650}
    .dc-g-tipos{display:flex;gap:6px;flex-wrap:wrap} .dc-g-t{font-size:11.5px;font-weight:600;color:var(--c);background:color-mix(in srgb,var(--c) 10%,transparent);border-radius:99px;padding:2px 8px}
    .dc-g-res{margin-left:auto;display:flex;gap:14px;font-size:12.5px;color:var(--text-muted);white-space:nowrap} .dc-g-res b{color:var(--text-primary);font-variant-numeric:tabular-nums}
    .dc-loja{border-top:1px solid var(--border)}
    .dc-loja-cab{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 16px;background:var(--bg-subtle)} .dc-loja-nome{font-size:12.5px;font-weight:650;color:var(--text-secondary)}
    .dc-mais{display:block;width:100%;border:0;border-top:1px solid var(--border);background:none;padding:9px 16px;font-size:12.5px;color:var(--accent);cursor:pointer;font-family:inherit;text-align:left} .dc-mais:hover{background:var(--bg-subtle)}
    .dc-lista{padding:4px 0}
    .dc-li{display:grid;grid-template-columns:28px minmax(0,1fr) 110px auto;gap:12px;align-items:start;padding:12px 16px;border-top:1px solid var(--border);border-left:3px solid transparent}
    .dc-loja-cab + .dc-li{border-top:0} .dc-li.urgente{border-left-color:var(--red);background:color-mix(in srgb,var(--red) 4%,transparent)}
    .dc-li:hover{background:var(--bg-subtle)}
    .dc-sel{padding-top:2px} .dc-sel input{width:16px;height:16px;cursor:pointer;accent-color:var(--accent)}
    .dc-txt{cursor:pointer;min-width:0}
    .dc-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--text-muted);margin-bottom:3px}
    .dc-tipo{color:var(--c);font-weight:650}
    .dc-prazo{color:var(--red);font-weight:650} .dc-freio{color:var(--accent);font-weight:600}
    .dc-tit{font-size:13.5px;font-weight:600;color:var(--text-primary);line-height:1.4}
    .dc-acao{display:inline-block;font-size:12px;font-weight:600;color:var(--text-secondary);background:var(--bg-subtle);border-radius:6px;padding:1px 7px;margin-left:4px}
    .dc-porque{font-size:12.5px;color:var(--text-secondary);line-height:1.5;margin-top:3px;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
    .dc-porque.aberto{-webkit-line-clamp:unset;display:block}
    .dc-imp{text-align:right;display:flex;flex-direction:column} .dc-imp b{font-size:14px;font-weight:650;font-variant-numeric:tabular-nums} .dc-imp small{font-size:11px;color:var(--text-muted)}
    .dc-bt{display:flex;gap:6px;align-items:center;justify-content:flex-end;white-space:nowrap}
    .dc-x{border:0;background:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:4px 6px;border-radius:6px} .dc-x:hover{color:var(--red);background:var(--bg-subtle)}
    .dc-proc{font-size:12px;color:var(--text-muted)}
    .dc-vazio{padding:28px;text-align:center;display:flex;flex-direction:column;gap:4px} .dc-vazio span{font-size:13px;color:var(--text-muted)}
    @media (max-width:760px){.dc-li{grid-template-columns:24px minmax(0,1fr);}.dc-imp{text-align:left;grid-column:2}.dc-bt{grid-column:2;justify-content:flex-start}}
  </style>`;
  carregar();
});
