// ============================================================
// GLR Consultoria — Escritório dos agentes
// ------------------------------------------------------------
// Mostra cada agente automático do sistema na sua mesa (trabalhando agora,
// em pausa ou com erro) e uma conversa entre eles. A conversa é montada a
// partir do REGISTRO REAL de cada agente — nada é inventado:
//  • ADS Shopee e Copiloto ML → glr_agente_log (ações, sugestões, detecção, medição)
//  • Coletor, Vigia de preços, Caçador de oportunidades → glr_sync_estado
//  • Redator → glr_agente_relatorios (relatório diário escrito com IA)
// Os agentes não trocam mensagens entre si de verdade: as menções (@) só
// aparecem onde o trabalho de um depende do outro (ex.: o relatório do Redator
// sai da revisão do ADS Shopee) ou quando precisam do analista.
// ============================================================
Router.register('escritorio', (params, el) => {
  const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const N = v => (parseFloat(v) || 0).toLocaleString('pt-BR');
  const MIN = 60e3, HORA = 60 * MIN, DIA = 24 * HORA;
  const hora = t => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const haQuanto = t => { const d = Date.now() - t; return d < MIN ? 'agora' : d < HORA ? `há ${Math.round(d / MIN)} min` : d < DIA ? `há ${Math.round(d / HORA)} h` : `há ${Math.round(d / DIA)} d`; };
  const diaTxt = t => { const d = new Date(t), hj = new Date(); const k = x => x.toDateString(); if (k(d) === k(hj)) return 'Hoje'; const on = new Date(hj.getTime() - DIA); return k(d) === k(on) ? 'Ontem' : d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' }); };
  const corta = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const primeiraFrase = s => corta(String(s || '').split(/(?<=[.!?])\s/)[0], 160);

  // Quem trabalha no escritório (a ordem é a da planta: dados → análise → entrega)
  const AG = {
    sync:   { nome: 'Coletor', cargo: 'Sincroniza pedidos, ADS e resumo das lojas a cada 15 min', cor: '#0e8aa6', rot: 'Dados' },
    precos: { nome: 'Vigia de Preços', cargo: 'Confere o preço dos anúncios do Mercado Livre a cada 4 h', cor: '#b7791f', rot: 'Dados' },
    estoque: { nome: 'Estoque', cargo: 'Calcula em quantos dias cada produto acaba, a cada 3 h', cor: '#0f9f6e', rot: 'Dados' },
    margem: { nome: 'Margem', cargo: 'Calcula a margem e o ACOS máximo de cada produto, a cada 3 h', cor: '#d93f3f', rot: 'Dados' },
    promo:  { nome: 'Promoções', cargo: 'Escolhe, 1x por dia, as promoções que cabem na margem e no estoque', cor: '#db2777', rot: 'Vendas' },
    rep:    { nome: 'Reputação e Atendimento', cargo: 'Vigia perguntas, reclamações e a saúde das contas a cada 30 min', cor: '#0891b2', rot: 'Clientes' },
    oport:  { nome: 'Caçador de Oportunidades', cargo: 'Procura produtos com espaço para crescer', cor: '#7c3aed', rot: 'Dados' },
    shopee: { nome: 'ADS Shopee', cargo: 'Revisa as campanhas às 07:30 e ajusta sozinho dentro dos limites', cor: '#d9622b', rot: 'ADS' },
    ml:     { nome: 'Copiloto ADS ML', cargo: 'Analisa as campanhas às 07:30 e monta o pacote do dia', cor: '#d9a400', rot: 'ADS' },
    rel:    { nome: 'Redator', cargo: 'Escreve o relatório diário de cada conta com IA', cor: '#4f46e5', rot: 'Entrega' },
  };
  const ANALISTA = { nome: 'Analista', cor: 'var(--text-secondary)' };

  const state = {
    carregando: true, erro: null, logs: [], sync: [], sinais: [], repu: [], rels: [], agenda: {}, pendentes: 0,
    filtro: (() => { try { return localStorage.getItem('glr_esc_filtro') || 'todos'; } catch (e) { return 'todos'; } })(),
    atualizadoEm: 0, novos: new Set(), vistos: new Set(),
  };

  // Nome da conta pelo vínculo cliente ↔ conta (cai no id quando não acha)
  function mapaContas() {
    let vinc = {}; try { vinc = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch (e) {}
    const m = new Map();
    for (const c of (window.GLR?.clientes || [])) {
      for (const ct of (vinc[String(c.id)] || [])) {
        const ids = [ct.external_id, ct.param_to_use?.shopId, ct.param_to_use?.meliUserId, ct.param_to_use?.amazon_account_id, ct.param_to_use?.magalu_account_id, ct.param_to_use?.shein_supplier_id, ct.contaId];
        ids.filter(Boolean).forEach(i => m.set(String(i), c.nome));
      }
    }
    return m;
  }

  async function carregar() {
    const desde = new Date(Date.now() - 48 * HORA).toISOString();
    try {
      const COLS = 'id,conta_id,cliente_nome,tipo,titulo,explicacao,dados,resultado,origem,criado_em';
      const [logs, antigos, sync, rels, agenda, pend, sinais, repu] = await Promise.all([
        _sb.from('glr_agente_log').select(COLS).gte('criado_em', desde).order('criado_em', { ascending: false }).limit(800),
        // ações antigas que foram detectadas no painel ou medidas nas últimas 48 h
        _sb.from('glr_agente_log').select(COLS).lt('criado_em', desde).gte('criado_em', new Date(Date.now() - 46 * DIA).toISOString())
          .or(`dados->medicao->>medido_em.gte.${desde},dados->>aplicado_em.gte.${desde}`).limit(300),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,recurso,ultimo_sucesso,ultima_tentativa,ultimo_erro,registros').neq('marketplace', 'sistema'),
        _sb.from('glr_agente_relatorios').select('*').gte('data', desde.slice(0, 10)).order('data', { ascending: false }).limit(80),
        _sb.from('glr_sync_estado').select('cursor').eq('marketplace', 'sistema').eq('conta_id', 'agente').eq('recurso', 'agenda'),
        _sb.from('glr_agente_log').select('id', { count: 'exact', head: true }).eq('tipo', 'alerta').eq('resultado', 'so_alerta'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,ultimo_sucesso,ultima_tentativa,ultimo_erro,registros,resumo:cursor->resumo,destaques:cursor->destaques').eq('recurso', 'sinais'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,ultimo_sucesso,ultima_tentativa,ultimo_erro,resumo:cursor->resumo').eq('recurso', 'reputacao'),
      ]);
      if (logs.error) throw logs.error;
      const vistos = new Set();
      state.logs = [...(logs.data || []), ...(antigos.error ? [] : antigos.data || [])].filter(l => !vistos.has(l.id) && vistos.add(l.id));
      state.sync = sync.data || [];
      state.sinais = sinais.error ? [] : sinais.data || [];
      state.repu = repu.error ? [] : repu.data || [];
      state.rels = (rels.data || []).map(({ resumo, ...r }) => r); // o texto do relatório não é usado aqui
      state.agenda = agenda.data?.[0]?.cursor?.rodadas || {};
      state.pendentes = pend.count || 0;
      state.erro = null;
    } catch (e) { state.erro = e.message || String(e); }
    state.carregando = false; state.atualizadoEm = Date.now();
    render();
  }

  // ── Conversa: uma mensagem por evento real (agrupando o que acontece junto) ──
  function montarConversa() {
    const contas = mapaContas();
    const nomeConta = (id, fallback) => fallback || contas.get(String(id)) || `conta ${id}`;
    const msgs = [];
    const add = (de, t, texto, extra = {}) => { if (t && !isNaN(t)) msgs.push({ de, t, texto, ...extra }); };
    const limite = Date.now() - 48 * HORA;
    const camp = t => String(t || '').replace(/^.*? — /, '');

    // Agentes de ADS (Shopee e ML)
    const sugestoesPor = new Map(); // conta + janela de 10 min → sugestões criadas juntas
    for (const l of state.logs) {
      const d = l.dados || {}, ml = d.marketplace === 'ml', ag = d.agente === 'promocoes' ? 'promo' : d.agente === 'reputacao' ? 'rep' : ml ? 'ml' : 'shopee';
      const t = new Date(l.criado_em).getTime(), cli = nomeConta(l.conta_id, l.cliente_nome);
      const humano = l.origem && l.origem !== 'cron';
      const recente = t >= limite; // ação antiga entra só pela detecção/medição de agora
      if (!recente && l.tipo !== 'alerta') { /* segue para detecção e medição */ }
      else if (l.tipo === 'sistema') {
        if (humano) { add('analista', t, `${h(corta(l.titulo, 80))} na <b>${h(cli)}</b>.`); continue; }
        if (/^Revisão diária concluída/.test(l.titulo)) add(ag, t, `Terminei a revisão diária da <b>${h(cli)}</b>: ${N(d.campanhas || 0)} campanhas ativas, ${N(d.decisoes || 0)} ajuste(s) feitos e ${N(d.alertas || 0)} sugestão(ões) para aprovar.${d.medidas ? ` Também medi o resultado de ${N(d.medidas)} ação(ões) antigas.` : ''}`, { conta: cli });
        else if (/^Acompanhamento das/.test(l.titulo)) add(ag, t, `${h(l.titulo.replace(/ — .*/, ''))} na <b>${h(cli)}</b>: ${h(l.titulo.split(' — ')[1] || '')}.`, { conta: cli, menor: true });
        else if (/^Análise ML concluída/.test(l.titulo)) {
          const partes = [`Analisei ${N(d.campanhas || 0)} campanhas e ${N(d.produtos || 0)} produtos da <b>${h(cli)}</b> e deixei ${N(d.sugestoes || 0)} sugestão(ões).`];
          if (d.detectadas) partes.push(`Vi no painel que ${N(d.detectadas)} já foram aplicadas.`);
          if (d.medidas) partes.push(`Medi o resultado de ${N(d.medidas)}.`);
          add('ml', t, partes.join(' '), { conta: cli });
        } else if (l.resultado === 'erro') add(ag, t, `Tive um problema na <b>${h(cli)}</b>: ${h(corta(l.explicacao || l.titulo, 160))}`, { erro: true, conta: cli });
        else if (/^Promoções do dia/.test(l.titulo)) {
          const r = d.resumo || {}, dq = d.destaques || {}, s0 = dq.sugeridas?.[0];
          const ads = d.marketplace === 'ml' ? '@Copiloto ADS ML' : '@ADS Shopee';
          const partes = [`Escolhi as promoções do dia da <b>${h(cli)}</b>: ${N(r.sugeridas || 0)} cabem na margem${s0 ? ` — a melhor é <b>${h(corta(s0.n, 45))}</b> (${h(s0.rot)}${s0.desconto != null ? `, −${String(s0.desconto).replace('.', ',')}%` : ''}, margem ${String(s0.m).replace('.', ',')}%)` : ''}.`];
          if (r.parados) partes.push(`${N(r.parados)} são para girar estoque parado que o @Estoque apontou.`);
          if (r.emPromo) partes.push(`${N(r.emPromo)} produto(s) já estão em promoção: ${ads}, usem o ACOS do preço promocional.`);
          if (r.promoApertada) partes.push(`@Analista, ${N(r.promoApertada)} promoção(ões) em vigor deixam margem abaixo da mínima.`);
          if ((d.colaboracoes || []).length) partes.push(`Não sugeri ${N(d.colaboracoes.length)} por falta de estoque.`);
          add('promo', t, partes.join(' '), { conta: cli, chama: !!r.promoApertada, menor: !r.sugeridas && !r.promoApertada });
        }
        else if (/^Colaboração com Estoque e Margem/.test(l.titulo)) {
          const cs = d.colaboracoes || [];
          const quem = [cs.some(x => x.de === 'estoque') ? '@Estoque' : '', cs.some(x => x.de === 'margem') ? '@Margem' : '', cs.some(x => x.de === 'promocoes') ? '@Promoções' : '', cs.some(x => x.de === 'reputacao') ? '@Reputação' : ''].filter(Boolean).join(', ');
          add(ag, t, `Levei em conta os avisos de ${quem || '@Estoque'} na <b>${h(cli)}</b>: ${cs.slice(0, 3).map(x => h(x.texto)).join('; ')}${cs.length > 3 ? ` (+${cs.length - 3})` : ''}.`, { conta: cli, colab: true });
        }
        else if (/Aumento represado|Maturação segurando/.test(l.titulo)) add(ag, t, `${h(corta(l.titulo, 90))} (<b>${h(cli)}</b>) — ${h(primeiraFrase(l.explicacao))}`, { conta: cli, menor: true });
        continue;
      }
      else if (l.tipo === 'decisao') {
        if (l.resultado === 'erro') { add(ag, t, `Tentei ${h(corta(l.titulo.replace(/^Falha ao /, ''), 90))} na <b>${h(cli)}</b>, mas a Shopee recusou: ${h(corta(String(l.explicacao || '').split(' — mas deu erro: ')[1] || '', 120))}`, { erro: true, conta: cli }); continue; }
        const de = d.roas_de != null ? ` (meta de ROAS ${d.roas_de} → ${d.roas_para})` : d.budget_de != null ? ` (${R$(d.budget_de)} → ${R$(d.budget_para)}/dia)` : '';
        const acao = /pausad/i.test(l.titulo) ? 'Pausei' : /ROAS/i.test(l.titulo) ? 'Ajustei a meta de ROAS de' : /Orçamento/i.test(l.titulo) ? 'Ajustei o orçamento de' : /retom/i.test(l.titulo) ? 'Retomei' : '';
        if (humano) add('analista', t, `${h(corta(l.titulo, 90))}${de} na <b>${h(cli)}</b>.`);
        else add(ag, t, `${acao ? `${acao} <b>"${h(camp(l.titulo))}"</b>${de}` : h(l.titulo)} na ${h(cli)}. ${h(primeiraFrase(l.explicacao))}`, { conta: cli });
      }
      if (l.tipo === 'alerta' && t >= limite && !humano) {
        const k = `${ag}|${l.conta_id}|${Math.floor(t / (10 * MIN))}`;
        const g = sugestoesPor.get(k) || { ag, t, cli, itens: [] };
        g.itens.push(l); g.t = Math.max(g.t, t); sugestoesPor.set(k, g);
      }
      // Copiloto ML: detectou no painel / analista marcou feito
      if (ml && l.resultado === 'executado' && d.aplicado_em) {
        const ta = new Date(d.aplicado_em).getTime();
        if (ta >= limite) {
          if (d.aplicado_por === 'detectado') add('ml', ta, `Vi no painel do ML que aplicaram <b>${h(corta(l.titulo.replace(/^Sugestão: /, ''), 80))}</b> (${h(d.deteccao || '')}). Meço o resultado em 7 dias.`, { conta: cli });
          else add('analista', ta, `Apliquei no painel: ${h(corta(l.titulo.replace(/^Sugestão: /, ''), 90))} (${h(cli)}).`);
        }
      }
      // Medição (7 dias antes × 7 depois)
      const md = d.medicao;
      if (md?.medido_em && ['melhorou', 'piorou', 'neutro'].includes(md.veredito)) {
        const tm = new Date(md.medido_em).getTime();
        if (tm >= limite) {
          const v = { melhorou: 'melhorou', piorou: 'piorou', neutro: 'não mudou de forma clara' }[md.veredito];
          add(ag, tm, `Resultado de <b>${h(corta(camp(l.titulo.replace(/^Sugestão: /, '')), 70))}</b> (${h(cli)}), 7 dias antes × depois: ${h(md.resumo || '')} — <b class="esc-v-${md.veredito}">${v}</b>.`, { conta: cli, medicao: md.veredito });
        }
      }
    }
    for (const g of sugestoesPor.values()) {
      const pend = g.itens.filter(l => l.resultado === 'so_alerta').length;
      const topo = g.itens.slice().sort((a, b) => (+b.dados?.prioridade || 0) - (+a.dados?.prioridade || 0))[0];
      const ref = topo ? camp(topo.titulo.replace(/^Sugestão: /, '').replace(/^Sugestão de /, '')) : '';
      const txt = g.ag === 'ml'
        ? `@Analista, montei o pacote do dia da <b>${h(g.cli)}</b> com ${g.itens.length} passo(s)${ref ? ` — comece por <b>${h(corta(ref, 60))}</b>` : ''}.${pend < g.itens.length ? ` ${g.itens.length - pend} já resolvido(s).` : ''}`
        : `@Analista, deixei ${g.itens.length} sugestão(ões) para você aprovar na <b>${h(g.cli)}</b>${ref ? `, como <b>${h(corta(ref, 60))}</b>` : ''} — passam do limite que posso aplicar sozinho.${pend < g.itens.length ? ` ${g.itens.length - pend} já resolvida(s).` : ''}`;
      add(g.ag, g.t, txt, { conta: g.cli, chama: true });
    }

    // Redator: o relatório sai da revisão do ADS Shopee (mesma rodada)
    for (const r of state.rels) {
      const t = new Date(r.criado_em || r.atualizado_em || `${r.data}T10:40:00Z`).getTime();
      if (t >= limite) add('rel', t, `@ADS Shopee, transformei sua revisão de ${String(r.data).split('-').reverse().slice(0, 2).join('/')} da <b>${h(nomeConta(r.conta_id, r.cliente_nome))}</b> no relatório diário.`, { conta: r.cliente_nome });
    }

    // Estoque e Margem: último cálculo de cada loja (o mural que os agentes de ADS leem)
    for (const s of state.sinais) {
      const ok = s.ultimo_sucesso ? new Date(s.ultimo_sucesso).getTime() : 0, tent = s.ultima_tentativa ? new Date(s.ultima_tentativa).getTime() : 0;
      const cli = nomeConta(s.conta_id);
      if (s.ultimo_erro && tent >= limite && tent >= ok) { add('estoque', tent, `@Analista, não consegui calcular estoque e margem da <b>${h(cli)}</b> (${h(s.marketplace)}): ${h(corta(s.ultimo_erro, 120))}`, { erro: true, chama: true }); continue; }
      if (ok < limite || !s.resumo) continue;
      const r = s.resumo, dq = s.destaques || {}, ads = s.marketplace === 'ml' ? '@Copiloto ADS ML' : '@ADS Shopee';
      const probE = [r.zerados ? `${r.zerados} sem estoque${dq.zerados?.length ? ` (${h(corta(dq.zerados[0], 40))})` : ''}` : '', r.criticos ? `${r.criticos} acabam em até 7 dias${dq.criticos?.length ? ` (${h(corta(dq.criticos[0].n, 40))}, ~${Math.round(dq.criticos[0].d)} d)` : ''}` : '', r.baixos ? `${r.baixos} em até 15 dias` : ''].filter(Boolean);
      add('estoque', ok, probE.length ? `Conferi o estoque de ${N(r.produtos)} produtos da <b>${h(cli)}</b>: ${probE.join(', ')}. ${ads}, não acelere esses.` : `Conferi o estoque de ${N(r.produtos)} produtos da <b>${h(cli)}</b>: nenhum acabando nos próximos 15 dias.`, { menor: !probE.length, chama: false });
      if (r.comCusto) {
        const probM = [r.negativos ? `${r.negativos} com margem negativa${dq.negativos?.length ? ` (${h(corta(dq.negativos[0].n, 40))}, ${String(dq.negativos[0].m).replace('.', ',')}%)` : ''}` : '', r.apertados ? `${r.apertados} com margem que aguenta menos de 3% de ACOS` : ''].filter(Boolean);
        const semCusto = r.produtos - r.comCusto;
        add('margem', ok, `Calculei a margem de ${N(r.comCusto)} produtos da <b>${h(cli)}</b>${probM.length ? `: ${probM.join(', ')}. ${ads}, o ACOS de cada produto agora respeita a margem` : ': todos com folga para o ADS'}.${semCusto > 0 ? ` ${N(semCusto)} produto(s) sem custo cadastrado ficaram de fora.` : ''}`, { menor: !probM.length });
      } else add('margem', ok, `@Analista, não consegui calcular a margem da <b>${h(cli)}</b>: nenhum dos ${N(r.produtos)} produtos que venderam tem custo cadastrado na tela Produtos.`, { menor: true, chama: true });
    }

    // Reputação e Atendimento: último estado de cada loja
    for (const s of state.repu) {
      const ok = s.ultimo_sucesso ? new Date(s.ultimo_sucesso).getTime() : 0, tent = s.ultima_tentativa ? new Date(s.ultima_tentativa).getTime() : 0;
      const cli = nomeConta(s.conta_id);
      if (s.ultimo_erro && tent >= limite && tent >= ok) { add('rep', tent, `@Analista, não consegui ler reputação e atendimento da <b>${h(cli)}</b> (${h(s.marketplace)}): ${h(corta(s.ultimo_erro, 120))}`, { erro: true, chama: true }); continue; }
      if (ok < limite || !s.resumo) continue;
      const r = s.resumo, partes = [];
      if (r.perguntas) partes.push(`${N(r.perguntas)} pergunta(s) sem resposta${r.perguntaMaisAntigaH != null ? ` (a mais antiga há ${r.perguntaMaisAntigaH} h)` : ''}${r.rascunhos ? `, ${N(r.rascunhos)} com rascunho pronto` : ''}`);
      if (r.comPrazo) partes.push(`${N(r.comPrazo)} reclamação(ões) com ação obrigatória e prazo`);
      if (r.pedemResposta) partes.push(`${N(r.pedemResposta)} devolução(ões) pedindo resposta`);
      if (r.mensagens) partes.push(`${N(r.mensagens)} mensagem(ns) pós-venda não lida(s)`);
      const ads = s.marketplace === 'ml' ? '@Copiloto ADS ML' : '@ADS Shopee';
      const risco = r.risco === 'alto' ? ` Reputação em risco (${h(r.riscoMotivo || '')}): ${ads}, não acelerem esta conta.` : r.risco === 'atencao' && r.riscoMotivo ? ` Atenção: ${h(r.riscoMotivo)}.` : '';
      const prob = r.produtosProblema ? ` ${N(r.produtosProblema)} produto(s) com reclamação repetida ficam sem aceleração no ADS.` : '';
      if (partes.length || risco || prob) add('rep', ok, `${partes.length ? `@Analista, na <b>${h(cli)}</b>: ${partes.join('; ')}.` : `Na <b>${h(cli)}</b>:`}${risco}${prob}`, { chama: !!partes.length || r.risco === 'alto', erro: r.risco === 'alto' });
      else add('rep', ok, `Atendimento em dia na <b>${h(cli)}</b>${r.nivel ? ` · reputação ${h(r.nivel.toLowerCase())}` : ''}.`, { menor: true });
    }

    // Coletor / Vigia / Caçador: último estado de cada loja (agrupado por rodada)
    const rodadas = new Map();
    for (const s of state.sync) {
      const ag = s.recurso === 'precos' ? 'precos' : s.recurso === 'oportunidades' ? 'oport' : ['pedidos', 'ads'].includes(s.recurso) ? 'sync' : null;
      if (!ag) continue;
      const ok = s.ultimo_sucesso ? new Date(s.ultimo_sucesso).getTime() : 0;
      const tent = s.ultima_tentativa ? new Date(s.ultima_tentativa).getTime() : 0;
      if (s.ultimo_erro && tent >= limite && tent >= ok) {
        add(ag, tent, `@Analista, não consegui atualizar ${s.recurso === 'ads' ? 'o ADS' : s.recurso === 'precos' ? 'os preços' : s.recurso === 'oportunidades' ? 'as oportunidades' : 'os pedidos'} da <b>${h(nomeConta(s.conta_id))}</b> (${h(s.marketplace)}): ${h(corta(s.ultimo_erro, 120))}`, { erro: true, chama: true });
        continue;
      }
      if (ok < limite) continue;
      const k = `${ag}|${s.recurso}|${Math.floor(ok / (10 * MIN))}`;
      const g = rodadas.get(k) || { ag, recurso: s.recurso, t: 0, lojas: new Set(), reg: 0 };
      g.t = Math.max(g.t, ok); g.lojas.add(`${s.marketplace}:${s.conta_id}`); g.reg += parseInt(s.registros) || 0;
      rodadas.set(k, g);
    }
    for (const g of rodadas.values()) {
      const n = g.lojas.size;
      if (g.ag === 'precos') add('precos', g.t, `Conferi o preço de ${N(g.reg)} anúncios em ${n} conta(s) do Mercado Livre. As mudanças estão no Monitor de preços.`, { menor: true });
      else if (g.ag === 'oport') add('oport', g.t, `Encontrei ${N(g.reg)} oportunidade(s) em ${n} loja(s).`, { menor: true });
      else if (g.recurso === 'pedidos') add('sync', g.t, `Sincronizei os pedidos de ${n} loja(s)${g.reg ? `: ${N(g.reg)} pedido(s) novos ou atualizados nesta rodada` : ', sem pedidos novos'}. A base que os agentes de ADS e o Vendômetro leem está em dia.`, { menor: !g.reg });
      else add('sync', g.t, `Atualizei o investimento em ADS de ${n} loja(s).`, { menor: true });
    }
    return msgs.sort((a, b) => a.t - b.t);
  }

  // ── Mesas: o que cada agente está fazendo agora ──
  function estadoAgentes(msgs) {
    const agora = Date.now();
    const out = {};
    for (const k of Object.keys(AG)) {
      const minhas = msgs.filter(m => m.de === k);
      const ult = minhas[minhas.length - 1];
      const hoje = minhas.filter(m => new Date(m.t).toDateString() === new Date().toDateString());
      const erroRecente = minhas.filter(m => m.erro && agora - m.t < 6 * HORA).length;
      let tentativa = 0;
      if (['sync', 'precos', 'oport', 'estoque', 'margem', 'promo', 'rep'].includes(k)) {
        const rec = k === 'sync' ? ['pedidos', 'ads', 'resumo'] : k === 'estoque' || k === 'margem' ? ['sinais'] : k === 'promo' ? ['promocoes'] : k === 'rep' ? ['reputacao'] : [k === 'precos' ? 'precos' : 'oportunidades'];
        state.sync.filter(s => rec.includes(s.recurso)).forEach(s => { const t = s.ultima_tentativa ? new Date(s.ultima_tentativa).getTime() : 0; if (t > tentativa) tentativa = t; });
      }
      const ativo = (ult && agora - ult.t < 4 * MIN) || (tentativa && agora - tentativa < 3 * MIN);
      let prox = '';
      if (k === 'sync') prox = tentativa ? `próxima rodada em ~${Math.max(1, Math.round((tentativa + 15 * MIN - agora) / MIN))} min` : '';
      else if (k === 'precos') prox = 'confere de novo a cada 4 h';
      else if (k === 'estoque' || k === 'margem') prox = 'recalcula a cada 3 h e antes das 07:00';
      else if (k === 'promo') prox = 'analisa 1x por dia, depois das 06:00';
      else if (k === 'rep') prox = 'confere de novo a cada 30 min';
      else if (k === 'rel') prox = hoje.length ? 'próximo relatório amanhã, logo após a revisão' : 'escreve logo após a revisão das 07:30';
      else if (k === 'shopee' || k === 'ml') {
        const feitaHoje = hoje.some(m => /revisão diária|Analisei/i.test(m.texto));
        prox = feitaHoje ? 'próxima revisão amanhã às 07:30' : 'revisão de hoje às 07:30';
        if (k === 'shopee') { const hj = new Date(agora - 3 * HORA).toISOString().slice(0, 10); const rod = Object.keys(state.agenda).filter(s => s.startsWith(hj) && /\dh$/.test(s)).map(s => s.slice(-3)).sort(); if (rod.length) prox += ` · acompanhamentos hoje: ${rod.join(', ')}`; }
      }
      out[k] = {
        status: ativo ? 'trabalhando' : erroRecente && ult?.erro ? 'erro' : ult ? 'pausa' : 'sem_registro',
        ult, hoje: hoje.length, erros: erroRecente, prox,
      };
    }
    return out;
  }

  // Bonequinho na mesa (SVG simples; anima digitando quando está trabalhando)
  const boneco = (cor, status) => `<svg class="esc-boneco ${status}" viewBox="0 0 120 92" aria-hidden="true">
      <rect x="30" y="4" width="60" height="38" rx="5" class="esc-monitor"/>
      <rect x="35" y="9" width="50" height="28" rx="2" class="esc-tela"/>
      <g class="esc-linhas"><rect x="39" y="14" width="30" height="3" rx="1.5"/><rect x="39" y="21" width="38" height="3" rx="1.5"/><rect x="39" y="28" width="22" height="3" rx="1.5"/></g>
      <rect x="56" y="42" width="8" height="6" class="esc-pe"/>
      <rect x="8" y="47" width="104" height="5" rx="2.5" class="esc-mesa"/>
      <g class="esc-pessoa">
        <rect x="40" y="70" width="40" height="22" rx="8" class="esc-cadeira"/>
        <path d="M40 92 C40 76 48 71 60 71 C72 71 80 76 80 92 Z" fill="${cor}"/>
        <circle cx="60" cy="61" r="10" fill="${cor}"/>
        <path d="M51 58 C53 51 67 51 69 58" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="3" stroke-linecap="round"/>
      </g>
      ${status === 'pausa' ? '<text x="76" y="58" class="esc-zz">z z</text>' : ''}
      ${status === 'erro' ? '<circle cx="84" cy="58" r="7" class="esc-alerta"/><text x="84" y="62" text-anchor="middle" class="esc-alerta-t">!</text>' : ''}
    </svg>`;

  const STATUS = { trabalhando: ['Trabalhando agora', 'var(--green)'], pausa: ['Em pausa', 'var(--text-muted)'], erro: ['Precisa de atenção', 'var(--red)'], sem_registro: ['Sem registro em 48 h', 'var(--text-muted)'] };

  function render() {
    const root = document.getElementById('esc-root'); if (!root) return;
    if (state.carregando) { root.innerHTML = '<div class="esc-sub" style="padding:30px">Carregando o escritório…</div>'; return; }
    const msgs = montarConversa();
    const est = estadoAgentes(msgs);
    const trabalhando = Object.values(est).filter(e => e.status === 'trabalhando').length;
    const hojeStr = new Date().toDateString();
    const acoesHoje = state.logs.filter(l => l.tipo === 'decisao' && l.resultado === 'executado' && new Date(l.criado_em).toDateString() === hojeStr).length;
    const medidas48 = msgs.filter(m => m.medicao);
    const melhorou = medidas48.filter(m => m.medicao === 'melhorou').length;

    const mesas = Object.entries(AG).map(([k, a]) => {
      const e = est[k], st = STATUS[e.status];
      const tela = e.ult ? corta(e.ult.texto.replace(/<[^>]+>/g, ''), 110) : 'Nada registrado nas últimas 48 h.';
      return `<button class="esc-mesa-card ${state.filtro === k ? 'on' : ''}" style="--c:${a.cor}" onclick="window._escFiltro('${k}')" title="Ver só as falas de ${h(a.nome)}">
        <div class="esc-mesa-topo"><span class="esc-setor">${a.rot}</span><span class="esc-status" style="--s:${st[1]}"><i></i>${st[0]}</span></div>
        ${boneco(a.cor, e.status)}
        <div class="esc-nome">${h(a.nome)}</div>
        <div class="esc-cargo">${h(a.cargo)}</div>
        <div class="esc-fazendo"><span>${e.ult ? (e.status === 'trabalhando' ? 'Agora' : `Último trabalho ${haQuanto(e.ult.t)}`) : 'Último trabalho'}</span>${h(tela)}</div>
        <div class="esc-mesa-rodape"><span><b>${e.hoje}</b> hoje</span>${e.prox ? `<span>${h(e.prox)}</span>` : ''}</div>
      </button>`;
    }).join('');

    const lista = state.filtro === 'todos' ? msgs : state.filtro === 'analista' ? msgs.filter(m => m.de === 'analista' || m.chama) : msgs.filter(m => m.de === state.filtro);
    let ultimoDia = '';
    const bolhas = lista.slice(-160).map(m => {
      const a = m.de === 'analista' ? ANALISTA : AG[m.de];
      const dia = diaTxt(m.t); const sep = dia !== ultimoDia ? `<div class="esc-dia"><span>${dia}</span></div>` : ''; ultimoDia = dia;
      const id = `${m.de}|${m.t}|${m.texto.length}`;
      const novo = state.vistos.size && !state.vistos.has(id);
      state.novos.add(id);
      const texto = m.texto.replace(/@(Analista|ADS Shopee|Coletor|Copiloto ADS ML|Redator|Estoque|Margem|Promoções|Reputação)/g, '<span class="esc-mencao">@$1</span>');
      return `${sep}<div class="esc-msg ${m.de === 'analista' ? 'humano' : ''} ${m.menor ? 'menor' : ''} ${m.erro ? 'erro' : ''} ${novo ? 'novo' : ''}" style="--c:${a.cor}">
        <div class="esc-av">${h(a.nome.split(' ').filter(p => p.length > 2).map(p => p[0]).join('').slice(0, 2).toUpperCase())}</div>
        <div class="esc-bal"><div class="esc-de"><b>${h(a.nome)}</b><span>${hora(m.t)}</span></div><div class="esc-txt">${texto}</div></div>
      </div>`;
    }).join('');
    state.vistos = new Set(state.novos); state.novos = new Set();

    const chips = [['todos', 'Todos'], ...Object.entries(AG).map(([k, a]) => [k, a.nome]), ['analista', 'Com você']];
    root.innerHTML = `
      ${state.erro ? `<div class="esc-aviso">Não consegui ler o registro dos agentes: ${h(state.erro)}</div>` : ''}
      <div class="esc-kpis">
        <div><span>Trabalhando agora</span><b>${trabalhando}<small>/${Object.keys(AG).length}</small></b></div>
        <div><span>Ações aplicadas hoje</span><b>${acoesHoje}</b></div>
        <div><span>Esperando você</span><b style="color:${state.pendentes ? 'var(--yellow)' : 'inherit'}">${state.pendentes}</b><small>sugestões para aprovar ou aplicar</small></div>
        <div><span>Resultados medidos (48 h)</span><b>${medidas48.length}</b><small>${medidas48.length ? `${melhorou} melhoraram` : 'cada ação é medida 7 dias depois'}</small></div>
      </div>
      <div class="esc-grid">
        <section class="esc-planta" aria-label="Mesas dos agentes">
          <div class="esc-planta-cab"><b>Planta do escritório</b><span class="esc-sub">clique numa mesa para ver só as falas daquele agente</span></div>
          <div class="esc-mesas">${mesas}</div>
        </section>
        <section class="esc-chat" aria-label="Conversa dos agentes">
          <div class="esc-chat-cab">
            <div><b>Conversa da equipe</b><div class="esc-sub">últimas 48 h · atualiza sozinho${state.atualizadoEm ? ` · lido às ${hora(state.atualizadoEm)}` : ''}</div></div>
            <button class="btn btn-secondary btn-sm" onclick="window._escAtualizar()">Atualizar</button>
          </div>
          <div class="esc-chips">${chips.map(([k, t]) => `<button class="${state.filtro === k ? 'on' : ''}" onclick="window._escFiltro('${k}')">${h(t)}</button>`).join('')}</div>
          <div class="esc-msgs" id="esc-msgs">${bolhas || '<div class="esc-sub" style="padding:24px;text-align:center">Nenhuma fala neste filtro nas últimas 48 h.</div>'}</div>
          <div class="esc-nota">As falas são montadas a partir do registro real de cada agente: ações, sugestões, sincronizações, medições e relatórios. Os agentes não trocam mensagens entre si; as menções (@) mostram onde o trabalho de um depende do outro ou precisa de você.</div>
        </section>
      </div>`;
    const box = document.getElementById('esc-msgs'); if (box) box.scrollTop = box.scrollHeight;
  }

  window._escFiltro = k => { state.filtro = state.filtro === k && k !== 'todos' ? 'todos' : k; try { localStorage.setItem('glr_esc_filtro', state.filtro); } catch (e) {} render(); };
  window._escAtualizar = () => carregar();

  el.innerHTML = `<div class="page esc">
    <div class="esc-titulo"><h1>Escritório dos agentes</h1><span class="esc-sub">o que cada agente automático da GLR está fazendo, em tempo real</span></div>
    <div id="esc-root"></div>
  </div>
  <style>
    .esc-titulo{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:16px}
    .esc-titulo h1{font-size:22px;font-weight:650;letter-spacing:-.02em;margin:0}
    .esc-sub{font-size:12.5px;color:var(--text-muted)}
    .esc-aviso{padding:10px 14px;border-radius:10px;background:var(--red-bg);color:var(--red);font-size:13px;margin-bottom:12px}
    .esc-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
    .esc-kpis>div{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius,14px);padding:12px 16px;display:flex;flex-direction:column;gap:2px}
    .esc-kpis span{font-size:12.5px;color:var(--text-secondary)}
    .esc-kpis b{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--text-primary)} .esc-kpis b small{font-size:13px;color:var(--text-muted);font-weight:500}
    .esc-kpis>div>small{font-size:11.5px;color:var(--text-muted)}
    .esc-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(340px,1fr);gap:16px;align-items:start}
    @media (max-width:1100px){.esc-grid{grid-template-columns:1fr}}
    .esc-planta{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius,14px);padding:14px 16px 16px;
      background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:28px 28px;background-position:-1px -1px}
    .esc-planta-cab{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:12px;background:var(--bg-card);padding:4px 8px;border-radius:8px;width:max-content;max-width:100%}
    .esc-planta-cab b{font-size:14px}
    .esc-mesas{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
    .esc-mesa-card{all:unset;box-sizing:border-box;cursor:pointer;display:flex;flex-direction:column;gap:6px;background:var(--bg-card);border:1px solid var(--border);border-top:3px solid var(--c);border-radius:12px;padding:10px 12px 12px;box-shadow:var(--shadow-xs);transition:border-color .15s,box-shadow .15s,transform .15s}
    .esc-mesa-card:hover{box-shadow:var(--shadow-sm);transform:translateY(-1px)} .esc-mesa-card.on{border-color:var(--c);box-shadow:0 0 0 2px color-mix(in srgb,var(--c) 30%,transparent)}
    .esc-mesa-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .esc-mesa-topo{display:flex;justify-content:space-between;align-items:center;gap:6px}
    .esc-setor{font-size:11px;color:var(--text-muted)}
    .esc-status{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:var(--s)} .esc-status i{width:7px;height:7px;border-radius:50%;background:var(--s)}
    .esc-boneco{width:100%;height:86px} .esc-monitor{fill:var(--border-strong)} .esc-tela{fill:var(--bg-subtle)} .esc-pe{fill:var(--border-strong)} .esc-mesa{fill:var(--border-strong)}
    .esc-linhas rect{fill:var(--text-muted);opacity:.35;transform-box:fill-box;transform-origin:left}
    .esc-boneco.trabalhando .esc-tela{fill:color-mix(in srgb,var(--c) 14%,var(--bg-subtle))}
    .esc-boneco.trabalhando .esc-linhas rect{fill:var(--c);opacity:.8;animation:esc-digita 1.4s ease-in-out infinite}
    .esc-boneco.trabalhando .esc-linhas rect:nth-child(2){animation-delay:.25s} .esc-boneco.trabalhando .esc-linhas rect:nth-child(3){animation-delay:.5s}
    .esc-cadeira{fill:var(--border-strong);opacity:.7}
    .esc-boneco.trabalhando .esc-pessoa{animation:esc-maos .5s ease-in-out infinite alternate}
    .esc-zz{font-size:11px;fill:var(--text-muted);font-style:italic}
    .esc-alerta{fill:var(--red)} .esc-alerta-t{font-size:10px;font-weight:700;fill:#fff}
    @keyframes esc-digita{0%,100%{transform:scaleX(1)}50%{transform:scaleX(.55)}}
    @keyframes esc-maos{from{transform:translateY(0)}to{transform:translateY(-2px)}}
    .esc-nome{font-weight:650;font-size:14px;color:var(--text-primary)} .esc-cargo{font-size:11.5px;color:var(--text-muted);line-height:1.4;min-height:32px}
    .esc-fazendo{font-size:12px;color:var(--text-secondary);line-height:1.45;background:var(--bg-subtle);border-radius:8px;padding:7px 9px;min-height:54px}
    .esc-fazendo span{display:block;font-size:10.5px;color:var(--text-muted);margin-bottom:2px}
    .esc-mesa-rodape{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--text-muted)} .esc-mesa-rodape b{color:var(--text-primary)}
    .esc-chat{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius,14px);display:flex;flex-direction:column;max-height:calc(100vh - 150px);min-height:520px;position:sticky;top:12px}
    @media (max-width:1100px){.esc-chat{position:static;max-height:none}}
    .esc-chat-cab{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)} .esc-chat-cab b{font-size:14px}
    .esc-chips{display:flex;gap:6px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border)}
    .esc-chips button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit}
    .esc-chips button.on{background:var(--text-primary);border-color:var(--text-primary);color:var(--bg-card)}
    .esc-msgs{flex:1;overflow-y:auto;padding:10px 16px 14px;display:flex;flex-direction:column;gap:10px;min-height:300px}
    .esc-dia{display:flex;justify-content:center;margin:6px 0 2px} .esc-dia span{font-size:11px;color:var(--text-muted);background:var(--bg-subtle);border-radius:99px;padding:2px 10px;text-transform:capitalize}
    .esc-msg{display:flex;gap:9px;align-items:flex-start}
    .esc-av{flex:none;width:30px;height:30px;border-radius:50%;background:var(--c);color:#fff;display:grid;place-items:center;font-size:11px;font-weight:700}
    .esc-bal{min-width:0;background:var(--bg-subtle);border-radius:4px 12px 12px 12px;padding:7px 11px;max-width:100%}
    .esc-de{display:flex;gap:8px;align-items:baseline;font-size:12px} .esc-de b{color:var(--c);font-weight:650} .esc-de span{color:var(--text-muted);font-size:11px}
    .esc-txt{font-size:13px;color:var(--text-primary);line-height:1.5;overflow-wrap:anywhere} .esc-txt b{font-weight:600}
    .esc-msg.menor .esc-txt{color:var(--text-secondary);font-size:12.5px}
    .esc-msg.erro .esc-bal{background:var(--red-bg)}
    .esc-msg.humano{flex-direction:row-reverse} .esc-msg.humano .esc-bal{border-radius:12px 4px 12px 12px;background:color-mix(in srgb,var(--accent) 10%,var(--bg-card))} .esc-msg.humano .esc-av{background:var(--text-secondary)}
    .esc-msg.humano .esc-de b{color:var(--text-secondary)}
    .esc-msg.novo{animation:esc-entra .5s ease-out}
    @keyframes esc-entra{from{opacity:.2;transform:translateY(6px)}to{opacity:1;transform:none}}
    .esc-mencao{color:var(--accent);font-weight:600}
    .esc-v-melhorou{color:var(--green)} .esc-v-piorou{color:var(--red)} .esc-v-neutro{color:var(--text-muted)}
    .esc-nota{font-size:11px;color:var(--text-muted);line-height:1.5;padding:10px 16px;border-top:1px solid var(--border)}
    @media (prefers-reduced-motion:reduce){.esc-boneco *{animation:none!important}.esc-msg.novo{animation:none}.esc-mesa-card{transition:none}}
  </style>`;

  carregar();
  // Atualiza sozinho: a cada 60 s e quando um agente grava algo novo (tempo real do Supabase)
  let canal = null, espera = null;
  const timer = setInterval(() => {
    if (!document.getElementById('esc-root')) { clearInterval(timer); try { canal && _sb.removeChannel(canal); } catch (e) {} return; }
    carregar();
  }, 60e3);
  try {
    canal = _sb.channel('glr-escritorio-' + Date.now())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'glr_agente_log' }, () => { clearTimeout(espera); espera = setTimeout(carregar, 1500); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'glr_sync_estado' }, () => { clearTimeout(espera); espera = setTimeout(carregar, 4000); })
      .subscribe();
  } catch (e) { canal = null; }
});
