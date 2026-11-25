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
//  • Estoque: produto que o ADS empurra e acaba em até 7 dias (repor antes de zerar)
//    e qualquer produto que vende e zera em até 15 dias (mural 'sinais');
//  • Margem: produto vendendo no prejuízo ou abaixo da margem mínima da conta;
//  • Reputação também: conta perto do limite do verde (ML), queda de nível,
//    perguntas paradas, métrica fora da meta e devolução com prazo (Shopee).
// Limpeza: o servidor fecha de hora em hora as sugestões vencidas e as que uma
// mais nova substituiu (api/agente-cron.js limparDecisoes); cada loja mostra as
// fila mostra 40 por vez ("Mostrar mais").
// "Abrir" leva para a tela certa já no cliente da decisão (cliente em foco).
// Tela: três faixas (Urgente → Aprovar com 1 clique → Revisar), filtro lateral por
// tipo e cliente, e uma fila única de linhas compactas. Resolver tira a linha com
// animação; atalhos de teclado (J/K, Enter, F, A, X, Espaço) para passar rápido.
// ============================================================
Router.register('decisoes', (params, el) => {
  const R$ = v => 'R$ ' + (Math.round(parseFloat(v) || 0)).toLocaleString('pt-BR');
  const R2 = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const corta = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const dataCurta = iso => iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';
  const TIPOS = {
    'playbook': { t: 'Playbook GLR', c: 'var(--accent)' },
    'retencao': { t: 'Retenção', c: 'var(--red)' },
    'onboarding': { t: 'Implantação', c: 'var(--accent)' },
    'reputacao': { t: 'Reputação', c: 'var(--red)' },
    'saldo': { t: 'Saldo de ADS', c: 'var(--red)' },
    'conexao': { t: 'Conexão', c: 'var(--red)' },
    'saude-api': { t: 'Pedidos em dúvida', c: 'var(--red)' },
    'ads-shopee': { t: 'ADS Shopee', c: '#eb6834' },
    'ads-ml': { t: 'ADS ML', c: '#d9a400' },
    'estoque': { t: 'Estoque', c: '#1f9d74' },
    'margem': { t: 'Margem', c: '#b45309' },
    'prejuizo': { t: 'Vendas com prejuízo', c: 'var(--red)' },
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

  async function buscarPrejuizos() {
    try { const {data}=await _sb.auth.getSession();const r=await fetch('/api/vendas-prejuizo?resumo=1',{headers:{Authorization:'Bearer '+(data?.session?.access_token||'')}});const d=await r.json();if(!r.ok)throw Error(d.error||'Falha na apuração');return d; }
    catch(e){return {erro:e.message,grupos:[]};}
  }
  async function carregar() {
    st.carregando = true; render();
    try {
      const desde = new Date(Date.now() - 10 * 864e5).toISOString();
      const [logs, planos, reps, promos, conex, sinais, saude, perdas] = await Promise.all([
        _sb.from('glr_agente_log').select('id,conta_id,cliente_nome,titulo,explicacao,dados,criado_em').eq('tipo', 'alerta').eq('resultado', 'so_alerta').gte('criado_em', desde).order('criado_em', { ascending: false }).limit(3000),
        _sb.from('glr_sync_estado').select('conta_id,cursor').eq('marketplace', 'sistema').eq('recurso', 'plano'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,rec:cursor->reclamacoes,al:cursor->alertas').eq('recurso', 'reputacao'),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,res:cursor->resumo,dest:cursor->destaques').eq('recurso', 'promocoes'),
        _sb.from('glr_sync_estado').select('cursor').eq('marketplace', 'sistema').eq('conta_id', 'conexoes').eq('recurso', 'todas').maybeSingle(),
        _sb.from('glr_sync_estado').select('marketplace,conta_id,em:cursor->em,al:cursor->alertas').eq('recurso', 'sinais'),
        _sb.from('glr_sync_estado').select('contas:cursor->contas').eq('marketplace', 'sistema').eq('conta_id', 'saude_api').eq('recurso', 'todas').maybeSingle(),
        buscarPrejuizos(),
      ]);
      for (const r of [logs, planos, reps, promos]) if (r.error) throw r.error;
      const estoqueAds = new Set(); // produto que o agente de ADS já avisou (estoque_minimo): não repete
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
          for (const iid of d.item_ids || []) estoqueAds.add(`${l.conta_id}:${iid}`);
          if (d.produto) estoqueAds.add(`${l.conta_id}:${String(d.produto).slice(0, 90)}`);
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
      // Agente de Reputação: conta perto de mudar de cor, queda de nível, perguntas paradas, devolução com prazo (Shopee)
      const pctTxt = v => `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
      for (const r of reps.data || []) {
        const als = r.al || [], base = { tipo: 'reputacao', mkt: r.marketplace, conta: String(r.conta_id), exec: false, tela: 'atendimento' };
        for (const a of als) {
          const id = `repal:${r.conta_id}:${a.chave}`; if (locais[id]) continue;
          if (a.t === 'queda_nivel') itens.push({ ...base, id, titulo: `Reputação caiu — ${a.de} → ${a.para}`, porque: 'A conta perdeu cor/nota. Com reputação pior o marketplace mostra menos os anúncios e os agentes de ADS seguram a aceleração. Veja o que puxou (reclamações, atrasos, cancelamentos) em Reputação e atendimento.', urgente: true, quando: new Date(a.em).toISOString() });
          else if (a.t === 'perguntas') itens.push({ ...base, id, titulo: `Responder ${a.n ? a.n + ' ' : ''}pergunta(s) parada(s)`, acao: `a mais antiga há ${a.h >= 48 ? `${Math.round(a.h / 24)} dias` : `${a.h} h`}${a.rascunhos ? ` · ${a.rascunhos} rascunho(s) prontos` : ''}`, porque: 'Pergunta sem resposta perde a venda e pesa no tempo de resposta da conta. A IA já deixou rascunhos onde tinha informação no anúncio.', urgente: a.h > 48 });
          else if (a.t === 'devolucao') itens.push({ ...base, id, titulo: `Responder devolução — ${corta(a.produto, 50)}`, acao: a.valor ? `${R2(a.valor)}` : '', porque: `Devolução ${a.id}${a.motivo ? ` (${String(a.motivo).toLowerCase().replace(/_/g, ' ')})` : ''} espera resposta da loja. Sem resposta no prazo, a Shopee decide a favor do comprador.`, prazo: a.prazo, urgente: true });
        }
        // taxas do ML perto/acima do limite do verde: uma decisão por loja
        const tx = als.filter(a => a.t === 'taxa');
        if (tx.length) {
          const id = `repal:${r.conta_id}:${tx.map(a => a.chave).sort().join(',')}`;
          const acima = tx.filter(a => a.acima);
          if (!locais[id]) itens.push({ ...base, id, titulo: `${acima.length ? 'Reputação acima do limite' : 'Reputação perto do limite'} — ${tx.map(a => a.nome.toLowerCase()).join(', ')}`,
            acao: tx.map(a => `${a.nome} ${pctTxt(a.taxa)} (limite ${pctTxt(a.lim)})`).join(' · '),
            porque: acima.length ? `Já passou do limite para manter o verde no Mercado Livre${tx.some(a => a.n) ? ` (${tx.map(a => a.n != null ? `${a.n} ${a.nome.toLowerCase()}` : '').filter(Boolean).join(', ')} nos últimos 60 dias)` : ''}. Se continuar, a conta muda de cor.` : 'Já usa mais de 70% do limite para manter o verde. Dá tempo de agir antes de a conta mudar de cor: resolver reclamações, despachar no prazo, evitar cancelar.',
            urgente: acima.length > 0 });
        }
        // métricas da Shopee fora da meta: uma decisão por loja
        const mt = als.filter(a => a.t === 'metrica');
        if (mt.length) {
          const id = `repal:${r.conta_id}:${mt.map(a => a.chave).sort().join(',')}`;
          if (!locais[id]) itens.push({ ...base, id, titulo: `Fora da meta da Shopee — ${mt.length === 1 ? mt[0].nome : `${mt.length} métricas`}`,
            acao: mt.slice(0, 3).map(a => `${a.nome} ${String(a.atual ?? '—').replace('.', ',')}${a.unidade || ''}${a.meta ? ` (meta ${a.meta}${a.unidade || ''})` : ''}`).join(' · '),
            porque: 'Métrica fora da meta gera ponto de penalidade e pode limitar a loja (menos exposição, sem campanhas).', urgente: false });
        }
      }
      st.prejuizoErro=perdas.erro||null;
      for(const g of perdas.grupos||[]){
        const id=`perda:${g.chave}:${g.ultimo}`;if(locais[id])continue;
        itens.push({id,tipo:'prejuizo',mkt:g.marketplace,conta:String(g.conta_id),titulo:`Venda com prejuízo — ${g.produto}`,acao:`${g.pedidos} pedido(s) · perda ${g.estimado?'estimada ':''}${R2(g.perda)} em 30 dias`,porque:'Resultado dos pedidos com custo completo e repasse disponível, antes do ADS. Revise preço, custos e taxas. Pedidos com vários produtos são tratados como conjunto.',impacto:g.perda/30*7,impactoTipo:'perda',urgente:false,exec:false,tela:'vendas-prejuizo',quando:g.ultimo});
      }
      // Agentes de Estoque e de Margem (mural 'sinais', a cada 3 h): ruptura em até 15 dias e produto vendendo no prejuízo
      const dias1 = v => String(Math.round(v * 10) / 10).replace('.', ',');
      for (const r of sinais?.data || []) {
        if (!r.em || Date.now() - r.em > 2 * 864e5) continue; // mural velho: a loja parou de sincronizar (aparece em Conexões)
        for (const a of r.al || []) {
          const base = { mkt: r.marketplace, conta: String(r.conta_id), exec: false, tela: 'estoque-margem', quando: new Date(r.em).toISOString() };
          if (a.t === 'ruptura') continue; // agrupado por loja logo abaixo
          if (a.t === 'prejuizo') {
            if(!perdas.erro)continue; // apuração por pedido substitui o alerta pela margem média
            const id = `marg:${r.conta_id}:${a.id}`; if (locais[id]) continue;
            itens.push({ ...base, id, tipo: 'margem', titulo: `Vendendo no prejuízo — ${a.n}`,
              acao: `margem ${String(a.m).replace('.', ',')}% antes do ADS · preço ${R2(a.p)}`,
              porque: `Com taxas do marketplace, imposto e o custo cadastrado (${R2(a.c)}), cada venda perde dinheiro — ${a.u30} vendas em 30 dias. Revise o preço; se o custo estiver errado, corrija em Produtos.`,
              impacto: a.perda / 30 * 7, impactoTipo: 'perda', urgente: false });
          } else if (a.t === 'margem_baixa') {
            const id = `margb:${r.conta_id}:${a.id}`; if (locais[id]) continue;
            itens.push({ ...base, id, tipo: 'margem', titulo: `Margem abaixo do mínimo — ${a.n}`,
              acao: `${String(a.m).replace('.', ',')}% · mínimo da conta ${String(a.mm).replace('.', ',')}%`,
              porque: `Lucra pouco antes do ADS (${a.u30} vendas em 30 dias, ${R$(a.rec)}). Qualquer real de ADS nele tende a virar prejuízo — vale subir o preço ou revisar o custo.`, urgente: false });
          }
        }
      }
      // ruptura: uma decisão por loja com os produtos que zeraram ou zeram em até 15 dias
      for (const r of sinais?.data || []) {
        if (!r.em || Date.now() - r.em > 2 * 864e5) continue;
        const rup = (r.al || []).filter(a => a.t === 'ruptura' && !estoqueAds.has(`${r.conta_id}:${a.id}`) && !estoqueAds.has(`${r.conta_id}:${a.n}`));
        if (!rup.length) continue;
        const id = `rup:${r.conta_id}:${rup.map(a => a.id + a.ne[0]).sort().join(',')}`; if (locais[id]) continue;
        const zer = rup.filter(a => a.ne === 'zerado'), linhaP = a => `${corta(a.n, 55)} (${a.ne === 'zerado' ? 'zerado' : `${a.e} un., ~${dias1(a.d)} dia(s)`}, ${R$(a.rd)}/dia)`;
        itens.push({ id, tipo: 'estoque', mkt: r.marketplace, conta: String(r.conta_id), exec: false, tela: 'estoque-margem', quando: new Date(r.em).toISOString(),
          titulo: rup.length === 1 ? `${zer.length ? 'Sem estoque' : 'Repor estoque'} — ${rup[0].n}` : `Repor estoque — ${rup.length} produtos${zer.length ? ` (${zer.length} zerado${zer.length > 1 ? 's' : ''})` : ''}`,
          acao: rup.length === 1 ? (zer.length ? `zerado · vendia ~${dias1(rup[0].vd)}/dia` : `${rup[0].e} un. · acaba em ~${dias1(rup[0].d)} dia(s)`) : `${R$(rup.reduce((s, a) => s + a.rd, 0))}/dia em risco`,
          porque: `${rup.slice(0, 4).map(linhaP).join(' · ')}${rup.length > 4 ? ` · +${rup.length - 4}` : ''}. Avisar o cliente para repor; produto zerado perde venda e cai no ranking, e o ADS dele deve ser segurado.`,
          impacto: rup.reduce((s, a) => s + a.rd, 0) * 7, impactoTipo: 'ganho', urgente: rup.some(a => (a.ne === 'zerado' || (a.d != null && a.d <= 3)) && a.rd >= 100) });
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
      // Agente Saúde da API: histórico travado ou base diferente do marketplace (conexão com erro já aparece acima)
      for (const c of Object.values(saude?.data?.contas || {})) {
        if (c.status !== 'travado' && c.status !== 'divergente') continue;
        const id = `sa:${c.mkt}:${c.id}:${c.status}:${c.desde || ''}`;
        if (locais[id]) continue;
        itens.push({ id, tipo: 'saude-api', mkt: c.mkt, conta: String(c.id), titulo: `${c.status === 'travado' ? 'Histórico do mês travado' : 'Pedidos diferentes do marketplace'} — ${c.nome} (${NOME_MKT[c.mkt] || c.mkt})`,
          porque: `${(c.problemas || []).join(' ')} Enquanto isso, vendas e projeção deste cliente podem estar incompletas.`, urgente: true, tela: 'saude-api', quando: c.desde || null });
      }
      // conta que não está mais em nenhum cliente (cliente excluído / conta desvinculada) sai da fila
      const vinc = lerJSON('glr_mc_vinculos', {}), contasVinc = new Set(Object.values(vinc).flatMap(a => (a || []).flatMap(c => [c.external_id, c.param_to_use?.shopId, c.param_to_use?.meliUserId].filter(Boolean).map(String))));
      if (contasVinc.size) for (let i = itens.length - 1; i >= 0; i--) if (!itens[i].clienteFixo && !contasVinc.has(itens[i].conta)) itens.splice(i, 1);
      const nomear = it => {
        if (it.clienteFixo) { it.clienteId = it.clienteFixo; it.loja = `${(GLR.clientes || []).find(c => String(c.id) === it.clienteFixo)?.nome || it.nomeCliente || 'Cliente'} · Carteira`; return; }
        it.loja = GLR.nomeConta(it.mkt, it.conta); it.clienteId = GLR.ctx?.clienteDaConta(it.mkt, it.conta) || '';
      };
      // Playbook: revisão de planejamento, sem executar campanhas nem alterar metas.
      const metasPlaybook = lerJSON('glr_metas', {}) || {};
      const hojePlaybook = new Date();
      const semanaPlaybook = new Date(hojePlaybook.getFullYear(), hojePlaybook.getMonth(), hojePlaybook.getDate() - ((hojePlaybook.getDay()+6)%7));
      const cicloPlaybook = [semanaPlaybook.getFullYear(),semanaPlaybook.getMonth()+1,semanaPlaybook.getDate()].join('-');
      for (const cliente of (GLR.clientes || [])) {
        const meta = Number(metasPlaybook[cliente.id]);
        if (!Number.isFinite(meta) || meta <= 0 || !(cliente.gestorId || cliente.gestor)) continue;
        const id = 'playbook:meta:' + cliente.id + ':' + cicloPlaybook;
        if (locais[id]) continue;
        itens.push({id, tipo:'playbook', clienteFixo:String(cliente.id), titulo:'Revisar execução da meta semanal', porque:'Meta consolidada cadastrada: '+R2(meta)+'. Conferir projeção, margem e ações do gestor; não alterar campanhas automaticamente.', tela:'gestores', quando:semanaPlaybook.toISOString()});
      }
      // Revisões manuais após conclusão da ação de planejamento; armazenamento local provisório.
      const revisoesPB = lerJSON('glr_playbook_revisoes_v1', {}) || {};
      try {
        const tabela=_sb.from('glr_playbook_review_history');
        for(const [id,reg] of Object.entries(revisoesPB)){
          if(!reg || !Number.isFinite(reg.em) || !reg.cliente)continue;
          const {error}=await tabela.upsert({id,client_id:reg.cliente,executed_at:new Date(reg.em).toISOString(),reviews:reg.encerradas||{}},{onConflict:'id',ignoreDuplicates:true});
          if(error)throw error;
        }
        const {data,error}=await _sb.from('glr_playbook_review_history').select('id,client_id,executed_at,reviews').order('id').limit(1000);
        if(error)throw error;
        for(const row of data||[])revisoesPB[row.id]={cliente:row.client_id,em:Date.parse(row.executed_at),encerradas:row.reviews||{}};
        for(let i=itens.length-1;i>=0;i--)if(itens[i].tipo==='playbook'&&revisoesPB[itens[i].id])itens.splice(i,1);
        st.pbErro=null;
      }catch(e){st.pbErro='Histórico central indisponível; registros locais preservados.';}
      for (const [origem, registro] of Object.entries(revisoesPB)) {
        if (!registro || !Number.isFinite(registro.em) || !GLR.clientes.some(c=>String(c.id)===registro.cliente)) continue;
        for (const dia of [3,7,15]) {
          const prazo = registro.em + dia * 864e5;
          const id = origem + ':revisao:' + dia;
          if (Date.now() < prazo || locais[id] || registro.encerradas?.[dia]) continue;
          const atraso = Math.max(0,Math.floor((Date.now()-prazo)/864e5));
          itens.push({id,tipo:'playbook',clienteFixo:registro.cliente,titulo:(atraso>=3?'Escalonar revisão atrasada — ':atraso>=1?'Cobrar revisão atrasada — ':'Avaliar intervenção — ')+dia+' dias',porque:(atraso?'Atraso de '+atraso+' dia(s). '+(atraso>=3?'Encaminhar à liderança. ':'Cobrar o gestor responsável. '):'')+'Comparar faturamento, margem e TACOS antes e depois; registrar fatores externos. Sem evidência suficiente, considerar inconclusivo.',tela:'playbook-glr',prazo:new Date(prazo).toISOString(),urgente:true,pbOrigem:origem,pbDia:dia});
        }
      }
      itens.forEach(nomear);
      itens.sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0) || (a.urgente && b.urgente ? new Date(a.prazo) - new Date(b.prazo) : 0)
        || (b.impacto || 0) - (a.impacto || 0) || String(b.quando || '').localeCompare(String(a.quando || '')));
      st.itens = itens; st.erro = null;
      GLR.quandoClientes(() => { st.itens.forEach(nomear); render(); });
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
    window.dispatchEvent(new CustomEvent('glr:decisoes', { detail: { n: st.itens.length } }));
  }

  // gestor do cliente pelo cadastro (o filtro e a linha mostram o nome)
  const gestorDe = cid => { const c = (GLR.clientes || []).find(x => String(x.id) === String(cid)); const g = (GLR.gestores || []).find(x => String(x.id) === String(c?.gestorId)); return { id: g ? String(g.id) : 'sem', nome: g?.nome || c?.gestor || 'Sem gestor' }; };
  const doGestor = it => st.gestor === 'todos' || gestorDe(it.clienteId).id === st.gestor;
  // ── Faixas: o que fazer primeiro ──
  // urgente (prazo/saldo/conexão) → aprovar com 1 clique → revisar (o resto)
  const FAIXAS = [
    { k: 'urgente', t: 'Urgente', d: 'prazo vencendo, saldo ou conexão parada', c: 'var(--red)', ok: it => !!it.urgente },
    { k: 'aprovar', t: 'Aprovar com 1 clique', d: 'o sistema executa ao aprovar', c: 'var(--accent)', ok: it => !it.urgente && !!it.exec },
    { k: 'revisar', t: 'Revisar', d: 'abrir a tela e decidir', c: 'var(--text-muted)', ok: it => !it.urgente && !it.exec },
    { k: 'todas', t: 'Todas', d: '', c: 'var(--text-muted)', ok: () => true },
  ];
  const NOME_MKT = { ML: 'Mercado Livre', Shopee: 'Shopee', AMZ: 'Amazon', TT: 'TikTok Shop' };
  const partes = it => { const t = String(it.loja || it.cliente || ''); const i = t.indexOf(' · '); const [c, l] = i > 0 ? [t.slice(0, i), t.slice(i + 3)] : [t || 'Sem cliente', '']; return [c, NOME_MKT[l] || l.replace(/^ML /, 'Mercado Livre · ')]; };
  const cliK = it => it.clienteId || partes(it)[0];
  const base = () => { const foco = GLR.ctx?.cliente(); return st.itens.filter(it => (!foco || it.clienteId === foco) && doGestor(it)); };
  const faixaDe = k => FAIXAS.find(f => f.k === k) || FAIXAS[3];
  const passa = (it, { faixa = true, tipo = true, cli = true } = {}) =>
    (!faixa || faixaDe(st.faixa).ok(it)) && (!tipo || st.tipo === 'todos' || it.tipo === st.tipo) && (!cli || !st.cli || cliK(it) === st.cli);
  const visiveis = () => base().filter(it => passa(it));
  if (!st.faixa) st.faixa = null; st.tipo = 'todos'; st.cli = null; st.limite = 40; st.foco = 0;

  function render() {
    if (window._dcSt !== st) return;
    const root = document.getElementById('dc-root'); if (!root) return;
    if (st.carregando && !st.itens.length) { root.innerHTML = '<div class="dc-carregando"><span></span><span></span><span></span></div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card" style="padding:18px;color:var(--red)">Não consegui carregar as decisões: ${h(st.erro)} <button class="btn btn-secondary btn-sm" onclick="window._dcRecarregar()">Tentar de novo</button></div>`; return; }
    const B = base();
    // abre na faixa mais importante que tem algo
    if (!st.faixa) st.faixa = (FAIXAS.find(f => f.k !== 'todas' && B.some(f.ok)) || FAIXAS[3]).k;
    const lista = B.filter(it => passa(it));
    const emJogo = B.reduce((s, it) => s + (it.impacto || 0), 0);
    const gestores = [...new Map(st.itens.map(it => { const g = gestorDe(it.clienteId); return [g.id, g.nome]; })).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const tipos = Object.entries(TIPOS).map(([k, v]) => [k, v.t, B.filter(it => passa(it, { tipo: false }) && it.tipo === k).length]).filter(x => x[2]);
    // clientes da faixa/tipo atuais (lateral): mais urgentes e com mais itens primeiro
    const cls = new Map();
    for (const it of B.filter(it => passa(it, { cli: false }))) { const k = cliK(it), c = cls.get(k) || { k, nome: partes(it)[0], n: 0, u: 0, rs: 0 }; c.n++; c.u += it.urgente ? 1 : 0; c.rs += it.impacto || 0; cls.set(k, c); }
    const clientes = [...cls.values()].sort((a, b) => b.u - a.u || b.n - a.n);
    const selExec = lista.filter(it => it.exec && st.sel.has(it.id));
    const mostrando = lista.slice(0, st.limite);
    st.foco = Math.min(st.foco, Math.max(0, mostrando.length - 1));
    const foco = GLR.ctx?.cliente();
    root.innerHTML = `
      ${st.pbErro ? `<p role="alert">${h(st.pbErro)}</p>` : ''}
      ${st.prejuizoErro ? `<p role="alert" style="color:var(--yellow)">Vendas com prejuízo não puderam ser apuradas. Abra a aba para tentar novamente; as demais decisões continuam disponíveis.</p>` : ''}
      <div class="dc-cab">
        <p class="dc-resumo"><b>${B.length}</b> decisões${foco ? ' deste cliente' : ''}${emJogo > 0 ? ` · <b>${R$(emJogo)}</b>/semana em jogo` : ''}</p>
        <div class="dc-cab-dir">
          <select class="form-control dc-gestor" aria-label="Gestor" onchange="window._dcGestor(this.value)"><option value="todos">Todos os gestores</option>${gestores.map(([id, nome]) => `<option value="${h(id)}" ${st.gestor === id ? 'selected' : ''}>${h(nome)}</option>`).join('')}</select>
          <button class="btn btn-secondary btn-sm" ${st.carregando ? 'disabled' : ''} onclick="window._dcRecarregar()" title="Buscar de novo — sugestões vencidas ou repetidas fecham sozinhas a cada hora">${st.carregando ? '…' : '↻'}</button>
        </div>
      </div>
      <div class="dc-faixas" role="tablist">${FAIXAS.map(f => { const n = B.filter(it => f.ok(it) && passa(it, { faixa: false })).length; return `
        <button type="button" role="tab" aria-selected="${st.faixa === f.k}" class="dc-faixa ${st.faixa === f.k ? 'on' : ''} ${f.k === 'todas' ? 'mini' : ''}" style="--c:${f.c}" onclick="window._dcFaixa('${f.k}')">
          <b>${n}</b><span>${f.t}</span>${f.d ? `<small>${f.d}</small>` : ''}</button>`; }).join('')}
      </div>
      <div class="dc-corpo">
        <aside class="dc-lado">
          <div class="dc-lado-t">Tipo</div>
          <div class="dc-tipos">
            <button type="button" class="dc-tp ${st.tipo === 'todos' ? 'on' : ''}" onclick="window._dcTipo('todos')"><i style="--c:var(--text-muted)"></i>Todos</button>
            ${tipos.map(([k, t, n]) => `<button type="button" class="dc-tp ${st.tipo === k ? 'on' : ''}" onclick="window._dcTipo('${k}')"><i style="--c:${TIPOS[k].c}"></i>${h(t)}<b>${n}</b></button>`).join('')}
          </div>
          ${clientes.length > 1 || st.cli ? `<div class="dc-lado-t">Cliente</div>
          <div class="dc-clis">${clientes.slice(0, st.clisTodos ? 999 : 10).map(c => `<button type="button" class="dc-tp ${st.cli === c.k ? 'on' : ''}" onclick="window._dcCli('${h(c.k)}')"><span class="dc-tp-n">${h(c.nome)}</span><b class="${c.u ? 'dc-urg' : ''}" title="${c.u ? `${c.u} urgente(s)` : ''}">${c.n}</b></button>`).join('')}
            ${clientes.length > 10 && !st.clisTodos ? `<button type="button" class="dc-link" onclick="window._dcClisTodos()">ver os ${clientes.length} clientes</button>` : ''}</div>` : ''}
        </aside>
        <section class="dc-fila" aria-label="Decisões">
          ${st.cli || st.tipo !== 'todos' ? `<div class="dc-ativos">${st.tipo !== 'todos' ? `<button type="button" class="dc-tag" onclick="window._dcTipo('todos')">${h(TIPOS[st.tipo]?.t || st.tipo)} ✕</button>` : ''}${st.cli ? `<button type="button" class="dc-tag" onclick="window._dcCli(null)">${h(clientes.find(c => c.k === st.cli)?.nome || 'Cliente')} ✕</button>` : ''}</div>` : ''}
          ${lista.some(it => it.exec) ? `<div class="dc-lote">
            <label><input type="checkbox" ${selExec.length && selExec.length === lista.filter(it => it.exec).length ? 'checked' : ''} onchange="window._dcSelTodas(this.checked)"> Selecionar as ${lista.filter(it => it.exec).length} que aprovo com 1 clique</label>
            ${selExec.length ? `<button class="btn btn-primary btn-sm" ${st.lote ? 'disabled' : ''} onclick="window._dcAprovarSel()">${st.lote ? h(st.lote) : `Aprovar ${selExec.length}`}</button>` : ''}</div>` : ''}
          ${lista.length ? `<div class="dc-linhas">${mostrando.map((it, i) => linha(it, i)).join('')}</div>
            ${lista.length > mostrando.length ? `<button type="button" class="dc-mais" onclick="window._dcMais()">Mostrar mais ${Math.min(40, lista.length - mostrando.length)} de ${lista.length - mostrando.length}</button>` : ''}
            <div class="dc-atalhos"><kbd>J</kbd><kbd>K</kbd> navegar · <kbd>Enter</kbd> abrir · <kbd>F</kbd> feito · <kbd>A</kbd> aprovar · <kbd>X</kbd> descartar · <kbd>Espaço</kbd> detalhes</div>`
            : `<div class="dc-vazio"><b>${st.faixa === 'urgente' ? 'Nada urgente agora.' : 'Nada por aqui.'}</b><span>${B.length ? 'Veja as outras faixas acima.' : 'Os agentes não encontraram nada que precise de decisão.'}</span></div>`}
        </section>
      </div>`;
  }

  function linha(it, i) {
    const T = TIPOS[it.tipo] || { t: it.tipo, c: 'var(--text-muted)' }, proc = st.proc[it.id], aberto = st.abertos.has(it.id);
    const [cn, ln] = partes(it);
    const prazo = it.prazo ? (() => { const d = Math.round((new Date(it.prazo).getTime() - Date.now()) / 864e5); return d <= 0 ? 'vence hoje' : `vence em ${d} dia(s)`; })() : '';
    return `<article class="dc-row ${it.urgente ? 'urg' : ''} ${aberto ? 'aberto' : ''} ${i === st.foco ? 'foco' : ''}" style="--c:${T.c}" data-id="${h(it.id)}" data-i="${i}">
      <div class="dc-sel">${it.exec ? `<input type="checkbox" aria-label="Selecionar" ${st.sel.has(it.id) ? 'checked' : ''} onchange="window._dcMarcarSel('${h(it.id)}', this.checked)">` : `<i class="dc-dot"></i>`}</div>
      <div class="dc-main" onclick="window._dcAbrirTxt('${h(it.id)}')">
        <div class="dc-l1"><span class="dc-tit">${h(it.titulo)}</span>${it.acao ? `<span class="dc-acao">${h(it.acao)}</span>` : ''}</div>
        <div class="dc-l2"><span class="dc-tipo">${h(T.t)}</span><span>${h(cn)}${ln ? ` · ${h(ln)}` : ''}</span>${prazo ? `<span class="dc-prazo">${prazo}</span>` : it.quando ? `<span>${dataCurta(it.quando)}</span>` : ''}${it.freio ? '<span class="dc-freio" title="O agente parou de apertar porque a venda do produto caiu">freio de volume</span>' : ''}</div>
        ${it.porque ? `<div class="dc-porque">${h(it.porque)}</div>` : ''}
      </div>
      <div class="dc-imp">${it.impacto ? `<b>${R$(it.impacto)}</b><small>${it.impactoTipo === 'economia' ? 'a cortar/sem' : it.impactoTipo === 'perda' ? 'perde/semana' : '/semana'}</small>` : ''}</div>
      <div class="dc-bt">${proc ? `<span class="dc-proc">${h(proc)}</span>` : `
        ${it.exec ? `<button class="btn btn-primary btn-sm" onclick="window._dcAprovar('${h(it.id)}')">Aprovar</button><button class="dc-ic" title="Abrir na tela" aria-label="Abrir na tela" onclick="window._dcIr('${h(it.id)}')">↗</button>`
          : `<button class="btn btn-secondary btn-sm" onclick="window._dcIr('${h(it.id)}')">Abrir</button><button class="dc-ic dc-ok" title="Já fiz" aria-label="Marcar como feito" onclick="window._dcFeito('${h(it.id)}')">✓</button>`}
        <button class="dc-ic dc-x" title="Descartar" aria-label="Descartar" onclick="window._dcDescartar('${h(it.id)}')">✕</button>`}</div>
    </article>`;
  }

  // ── Ações: a linha sai com animação, os números se ajustam e aparece um aviso ──
  const achar = id => st.itens.find(x => x.id === id);
  const tirar = id => { st.itens = st.itens.filter(x => x.id !== id); st.sel.delete(id); window.dispatchEvent(new CustomEvent('glr:decisoes', { detail: { n: st.itens.length } })); };
  const sair = id => new Promise(ok => { const r = document.querySelector(`.dc-row[data-id="${CSS.escape(id)}"]`); if (!r || matchMedia('(prefers-reduced-motion: reduce)').matches) return ok(); r.style.height = r.offsetHeight + 'px'; r.getBoundingClientRect(); r.classList.add('saindo'); setTimeout(ok, 260); });
  function aviso(txt) {
    let t = document.getElementById('dc-aviso'); if (!t) { t = document.createElement('div'); t.id = 'dc-aviso'; t.className = 'dc-aviso'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = txt; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2200);
  }
  window._dcRecarregar = () => carregar();
  const mudou = () => { st.limite = 40; st.foco = 0; render(); };
  window._dcFaixa = k => { st.faixa = k; mudou(); };
  window._dcTipo = k => { st.tipo = k; mudou(); };
  window._dcCli = k => { st.cli = st.cli === k ? null : k; mudou(); };
  window._dcClisTodos = () => { st.clisTodos = true; render(); };
  window._dcMais = () => { st.limite += 40; render(); };
  window._dcGestor = g => { st.gestor = g; st.cli = null; try { localStorage.setItem('glr_dc_gestor', g); } catch (e) {} mudou(); };
  window._dcAbrirTxt = id => { st.abertos.has(id) ? st.abertos.delete(id) : st.abertos.add(id); const r = document.querySelector(`.dc-row[data-id="${CSS.escape(id)}"]`); if (r) r.classList.toggle('aberto', st.abertos.has(id)); else render(); };
  window._dcMarcarSel = (id, on) => { on ? st.sel.add(id) : st.sel.delete(id); render(); };
  window._dcSelTodas = on => { visiveis().filter(it => it.exec).forEach(it => on ? st.sel.add(it.id) : st.sel.delete(it.id)); render(); };
  window._dcIr = id => { const it = achar(id); if (!it) return; if (it.clienteId) GLR.ctx?.definir(it.clienteId, true); Router.navigate(it.tela,it.tipo==='prejuizo'?{conta:it.mkt+':'+it.conta}:{}); };
  window._dcAprovar = async id => {
    const it = achar(id); if (!it?.exec) return;
    st.proc[id] = 'Executando…'; render();
    try { await GLRAcoes.executar(it.log); delete st.proc[id]; await sair(id); tirar(id); aviso('Aprovada e executada'); }
    catch (e) { alert('Não consegui executar: ' + (e.message || e)); }
    delete st.proc[id]; render();
  };
  window._dcAprovarSel = () => aprovarLote(visiveis().filter(it => it.exec && st.sel.has(it.id)));
  async function aprovarLote(sel) {
    if (!sel.length || st.lote) return;
    if (!confirm(`Aprovar e executar agora ${sel.length} sugestão(ões)?\n\n${sel.slice(0, 12).map(it => `• ${it.acao || ''} — ${corta(it.titulo, 60)}`).join('\n')}${sel.length > 12 ? `\n… e mais ${sel.length - 12}` : ''}`)) return;
    const falhas = []; let n = 0;
    for (const it of sel) {
      st.lote = `Executando ${++n} de ${sel.length}…`; render();
      try { await GLRAcoes.executar(it.log); tirar(it.id); } catch (e) { falhas.push(`${corta(it.titulo, 50)}: ${e.message || e}`); }
    }
    st.lote = null; render();
    if (falhas.length) alert(`Executei ${sel.length - falhas.length} de ${sel.length}. Falharam:\n${falhas.slice(0, 8).join('\n')}`);
    else aviso(`${sel.length} aprovada(s) e executada(s)`);
  }
  async function resolver(id, resultado) {
    const it = achar(id); if (!it) return;
    st.proc[id] = resultado === 'executado' ? 'Marcando…' : 'Descartando…'; render();
    try {
      if (it.log) await GLRAcoes.marcar(it.log, resultado);
      else if (it.planoId) { const s = lerJSON('glr_plano_status', {}); s[it.planoId] = { st: resultado === 'executado' ? 'feito' : 'descartada', em: Date.now() }; localStorage.setItem('glr_plano_status', JSON.stringify(s)); }
      else {
        if (it.tipo==='playbook') {
          const registros=lerJSON('glr_playbook_revisoes_v1',{})||{};
          if(it.pbOrigem){
            const {data,error}=await _sb.from('glr_playbook_review_history').select('reviews').eq('id',it.pbOrigem).single();
            if(error)throw error;
            const reviews={...(data.reviews||{}),[it.pbDia]:{em:Date.now(),status:resultado}};
            const saved=await _sb.from('glr_playbook_review_history').update({reviews}).eq('id',it.pbOrigem).select('id').single();
            if(saved.error)throw saved.error;
          }else if(resultado==='executado'&&id.startsWith('playbook:meta:')){
            const saved=await _sb.from('glr_playbook_review_history').upsert({id,client_id:String(it.clienteId),executed_at:new Date().toISOString()},{onConflict:'id',ignoreDuplicates:true});
            if(saved.error)throw saved.error;
          }
          if (it.pbOrigem && registros[it.pbOrigem]) {
            const reg=registros[it.pbOrigem];
            reg.encerradas={...(reg.encerradas||{}),[it.pbDia]:{em:Date.now(),status:resultado}};
          } else if (resultado==='executado' && id.startsWith('playbook:meta:')) {
            registros[id]={cliente:String(it.clienteId),em:Date.now(),encerradas:{}};
          }
          localStorage.setItem('glr_playbook_revisoes_v1',JSON.stringify(registros));
        }
        resolverLocal(id);
      }
      delete st.proc[id]; await sair(id); tirar(id);
      aviso(resultado === 'executado' ? 'Marcada como feita' : 'Descartada');
    } catch (e) { alert('Não consegui salvar: ' + (e.message || e)); }
    delete st.proc[id]; render();
  }
  window._dcFeito = id => resolver(id, 'executado');
  window._dcDescartar = id => resolver(id, 'descartado');

  // ── Teclado: J/K navegam, Enter abre, F feito, A aprova, X descarta, Espaço detalhes ──
  if (window._dcTeclas) document.removeEventListener('keydown', window._dcTeclas);
  window._dcTeclas = e => {
    if(document.getElementById('dc-root')?.hidden)return;
    if (window._dcSt !== st || !document.getElementById('dc-root')) return;
    if (e.metaKey || e.ctrlKey || e.altKey || /input|select|textarea/i.test(e.target.tagName)) return;
    const rows = [...document.querySelectorAll('.dc-row')]; if (!rows.length) return;
    const k = e.key.toLowerCase(), id = rows[st.foco]?.dataset.id;
    const mover = d => { st.foco = Math.max(0, Math.min(rows.length - 1, st.foco + d)); rows.forEach((r, i) => r.classList.toggle('foco', i === st.foco)); rows[st.foco].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); mover(1); }
    else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); mover(-1); }
    else if (e.key === 'Enter' && id) { e.preventDefault(); window._dcIr(id); }
    else if (e.key === ' ' && id) { e.preventDefault(); window._dcAbrirTxt(id); }
    else if (k === 'f' && id && !achar(id)?.exec) window._dcFeito(id);
    else if (k === 'a' && id && achar(id)?.exec) window._dcAprovar(id);
    else if (k === 'x' && id) window._dcDescartar(id);
  };
  document.addEventListener('keydown', window._dcTeclas);

  el.innerHTML = `<div class="page"><nav aria-label="Setores da caixa de decisões" style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap"><button class="btn btn-secondary" id="dc-tab-decisions" onclick="window._dcTab('decisoes')">Decisões para aprovar</button><button class="btn btn-secondary" id="dc-tab-notifications" onclick="window._dcTab('notificacoes')">Notificações <span id="dc-notification-count" hidden></span></button></nav><div id="dc-root"></div><div id="dc-notifications" hidden></div></div>
  <style>
    .dc-cab{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
    .dc-resumo{margin:0;font-size:14px;color:var(--text-secondary)} .dc-resumo b{color:var(--text-primary);font-variant-numeric:tabular-nums}
    .dc-cab-dir{display:flex;gap:8px;align-items:center} .dc-gestor{width:auto;max-width:220px}
    .dc-faixas{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) auto;gap:10px;margin-bottom:16px}
    .dc-faixa{all:unset;box-sizing:border-box;cursor:pointer;display:grid;grid-template-columns:auto 1fr;column-gap:12px;align-items:center;padding:12px 16px;border-radius:12px;background:var(--bg-card);border:1px solid var(--border);transition:border-color .15s,box-shadow .15s,transform .15s}
    .dc-faixa b{grid-row:span 2;font-size:26px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:var(--c)}
    .dc-faixa span{font-size:13.5px;font-weight:650;color:var(--text-primary)} .dc-faixa small{font-size:11.5px;color:var(--text-muted)}
    .dc-faixa:hover{border-color:color-mix(in srgb,var(--c) 40%,var(--border));transform:translateY(-1px)}
    .dc-faixa.on{border-color:var(--c);box-shadow:0 0 0 1px var(--c) inset;background:color-mix(in srgb,var(--c) 6%,var(--bg-card))}
    .dc-faixa.mini{grid-template-columns:auto;justify-items:center;padding:12px 18px} .dc-faixa.mini b{grid-row:auto;font-size:18px}
    .dc-faixa:focus-visible,.dc-tp:focus-visible,.dc-tag:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .dc-corpo{display:grid;grid-template-columns:220px minmax(0,1fr);gap:18px;align-items:start}
    .dc-lado{position:sticky;top:12px;display:flex;flex-direction:column;gap:4px;max-height:calc(100vh - 120px);overflow:auto}
    .dc-lado-t{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);padding:10px 8px 4px}
    .dc-tipos,.dc-clis{display:flex;flex-direction:column;gap:1px}
    .dc-tp{all:unset;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;font-size:13px;color:var(--text-secondary)}
    .dc-tp:hover{background:var(--bg-subtle);color:var(--text-primary)} .dc-tp.on{background:var(--accent-glow);color:var(--text-primary);font-weight:600}
    .dc-tp i{flex:none;width:8px;height:8px;border-radius:50%;background:var(--c)} .dc-tp b{margin-left:auto;font-size:12px;font-weight:600;color:var(--text-muted);font-variant-numeric:tabular-nums}
    .dc-tp-n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .dc-tp em{font-style:normal;font-size:11px;font-weight:700;color:var(--red)}
    .dc-tp b.dc-urg{color:var(--red)}
    .dc-link{all:unset;cursor:pointer;font-size:12.5px;color:var(--accent);padding:6px 8px}
    .dc-fila{min-width:0;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
    .dc-ativos{display:flex;gap:6px;padding:10px 14px 0;flex-wrap:wrap}
    .dc-tag{all:unset;cursor:pointer;font-size:12px;font-weight:600;padding:3px 10px;border-radius:99px;background:var(--accent-glow);color:var(--accent-light)}
    .dc-lote{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border);font-size:12.5px;color:var(--text-secondary)}
    .dc-lote label{display:flex;gap:8px;align-items:center;cursor:pointer} .dc-lote input{accent-color:var(--accent);width:15px;height:15px}
    .dc-row{display:grid;grid-template-columns:22px minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);box-shadow:inset 3px 0 0 transparent;transition:background .12s,box-shadow .12s,opacity .25s,transform .25s,height .25s,padding .25s;overflow:hidden}
    .dc-row:hover{background:var(--bg-subtle)} .dc-row.foco{box-shadow:inset 3px 0 0 var(--accent);background:var(--bg-subtle)}
    .dc-row.urg{box-shadow:inset 3px 0 0 var(--red)} .dc-row.urg.foco{box-shadow:inset 3px 0 0 var(--red),inset 0 0 0 1px color-mix(in srgb,var(--accent) 35%,transparent)}
    .dc-row.saindo{opacity:0;transform:translateX(24px);height:0 !important;padding-top:0;padding-bottom:0;border-bottom-width:0}
    .dc-sel{display:flex;justify-content:center} .dc-sel input{width:16px;height:16px;cursor:pointer;accent-color:var(--accent)}
    .dc-dot{width:8px;height:8px;border-radius:50%;background:var(--c)}
    .dc-main{min-width:0;cursor:pointer}
    .dc-l1{display:flex;align-items:baseline;gap:8px;min-width:0}
    .dc-tit{font-size:13.5px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    .dc-row.aberto .dc-tit{white-space:normal}
    .dc-acao{flex:none;font-size:12px;font-weight:600;color:var(--text-secondary);background:var(--bg-subtle);border:1px solid var(--border);border-radius:6px;padding:1px 7px;white-space:nowrap}
    .dc-l2{display:flex;gap:6px 10px;flex-wrap:wrap;font-size:12px;color:var(--text-muted);margin-top:2px}
    .dc-tipo{color:var(--c);font-weight:650} .dc-prazo{color:var(--red);font-weight:650} .dc-freio{color:var(--accent);font-weight:600}
    .dc-porque{font-size:12.5px;color:var(--text-secondary);line-height:1.5;overflow:hidden;max-height:0;margin-top:0;transition:max-height .25s ease,margin .2s}
    .dc-row.aberto .dc-porque{max-height:240px;margin-top:6px}
    .dc-imp{text-align:right;display:flex;flex-direction:column;min-width:76px} .dc-imp b{font-size:13.5px;font-weight:650;font-variant-numeric:tabular-nums} .dc-imp small{font-size:11px;color:var(--text-muted)}
    .dc-bt{display:flex;gap:4px;align-items:center;justify-content:flex-end;white-space:nowrap}
    .dc-ic{border:0;background:none;color:var(--text-muted);cursor:pointer;font-size:14px;width:30px;height:30px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center}
    .dc-ic:hover{background:var(--bg-card-hover);color:var(--text-primary)} .dc-ok:hover{color:var(--green)} .dc-x:hover{color:var(--red)}
    .dc-ic:focus-visible{outline:2px solid var(--accent)}
    .dc-row .dc-bt .dc-ic{opacity:.55} .dc-row:hover .dc-bt .dc-ic,.dc-row.foco .dc-bt .dc-ic{opacity:1}
    .dc-proc{font-size:12px;color:var(--text-muted)}
    .dc-mais{display:block;width:100%;border:0;background:none;padding:12px 16px;font-size:13px;font-weight:600;color:var(--accent);cursor:pointer;font-family:inherit} .dc-mais:hover{background:var(--bg-subtle)}
    .dc-atalhos{padding:10px 16px;font-size:11.5px;color:var(--text-muted);border-top:1px solid var(--border)}
    .dc-atalhos kbd{font-family:inherit;font-size:10.5px;border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;padding:0 5px;margin-right:2px;color:var(--text-secondary)}
    .dc-vazio{padding:40px 20px;text-align:center;display:flex;flex-direction:column;gap:4px} .dc-vazio span{font-size:13px;color:var(--text-muted)}
    .dc-carregando{display:flex;flex-direction:column;gap:10px} .dc-carregando span{height:58px;border-radius:12px;background:linear-gradient(90deg,var(--bg-card) 0%,var(--bg-subtle) 50%,var(--bg-card) 100%);background-size:200% 100%;animation:dcPulse 1.2s infinite}
    @keyframes dcPulse{to{background-position:-200% 0}}
    .dc-aviso{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);opacity:0;pointer-events:none;background:var(--text-primary);color:var(--bg-base);font-size:13px;font-weight:600;padding:9px 16px;border-radius:99px;box-shadow:0 8px 24px rgba(0,0,0,.2);transition:opacity .2s,transform .2s;z-index:200}
    .dc-aviso.on{opacity:1;transform:translate(-50%,0)}
    @media (max-width:980px){.dc-corpo{grid-template-columns:1fr}.dc-lado{position:static;max-height:none;flex-direction:row;flex-wrap:wrap;gap:6px}.dc-lado-t{display:none}.dc-tipos,.dc-clis{flex-direction:row;flex-wrap:wrap;gap:4px}.dc-clis{display:none}.dc-tp{border:1px solid var(--border);border-radius:99px;padding:4px 10px}.dc-atalhos{display:none}}
    @media (max-width:760px){.dc-faixas{grid-template-columns:1fr 1fr}.dc-row{grid-template-columns:18px minmax(0,1fr)}.dc-imp{grid-column:2;text-align:left;flex-direction:row;gap:4px;align-items:baseline}.dc-bt{grid-column:2;justify-content:flex-start}.dc-tit{white-space:normal}}
    @media (prefers-reduced-motion:reduce){.dc-row,.dc-faixa,.dc-porque,.dc-aviso{transition:none}.dc-carregando span{animation:none}}
  </style>`;
  let desmontar=null;
  window._dcTab=tab=>{const notificacoes=tab==='notificacoes';document.getElementById('dc-root').hidden=notificacoes;document.getElementById('dc-notifications').hidden=!notificacoes;document.getElementById('dc-tab-decisions').setAttribute('aria-pressed',String(!notificacoes));document.getElementById('dc-tab-notifications').setAttribute('aria-pressed',String(notificacoes));if(notificacoes){if(desmontar)desmontar();desmontar=NotificationCenter.mount(document.getElementById('dc-notifications'));}else if(desmontar){desmontar();desmontar=null;}};
  window._dcTab(params.aba==='notificacoes'?'notificacoes':'decisoes');
  NotificationCenter.refreshBadge();
  carregar();
});

