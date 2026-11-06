// ============================================================
// GLR Copiloto ADS — análise própria (funciona SEM o sistema da GLR)
// ------------------------------------------------------------
// Lê as tabelas que o próprio Mercado Ads mostra na sessão do usuário (lista de
// campanhas e anúncios de uma campanha) e dá um veredito com o motivo e a ação
// sugerida — nenhum dado sai do navegador, não usa MCP nem API.
//  • Campanha: Escalar · Manter · Conter · Corrigir · Aguardar (aprendendo) · Sem dados
//  • Anúncio: Escalar · Manter · Avaliar · Mover · Retirar · Sem dados
// Meta de ACOS: a configurada no ícone da extensão para o anunciante; sem ela,
// a de cada campanha (100 ÷ ROAS objetivo).
// Expõe window.__glrAnalise para o painel (painel.js).
// ============================================================
(function () {
  if (window.__glrAnalise) return;

  const LIM = {
    folgaEscalar: 0.8,     // ACOS ≤ 80% da meta → espaço para acelerar
    excessoConter: 1.2,    // ACOS > 120% da meta → conter
    orcSaturado: 0.85,     // gasto/dia ≥ 85% do orçamento → orçamento é o gargalo
    passoRoas: 0.12,       // ajuste sugerido no ROAS objetivo
    passoOrc: 0.2,         // ajuste sugerido no orçamento
    minVendasEscalar: 3,
    gastoSemVendaMin: 40,  // R$ — campanha/anúncio que gastou isto sem vender
    cliquesAvaliar: 60,    // anúncio com muitos cliques e nenhuma venda
    ctrBaixo: 0.25,        // % — anúncio pouco atrativo
  };

  // ── Números do jeito que o ML escreve ("R$ 10.504,99", "9.5%", "17.2x", "63.566") ──
  function num(txt) {
    let s = String(txt || '').replace(/R\$|\s| /g, '').trim();
    if (!s || s === '-' || s === '—') return null;
    const temUnid = /[%x]$/i.test(s);
    s = s.replace(/[%x]$/i, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (!(temUnid && /^\d+\.\d{1,2}$/.test(s))) s = s.replace(/\./g, '');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  // célula "R$ 430 ▼66%" → { v: 430, d: -66 }
  function celula(td) {
    const t = (td?.innerText || '').replace(/\s+/g, ' ').trim();
    const [a, b] = t.split(/[▲▼●]/);
    const d = b != null ? num(b) : null;
    return { v: num(a), d: d == null ? null : (t.includes('▼') ? -d : d), t };
  }

  // o ML desenha um cabeçalho fixo (tabela sem linhas) e a tabela de dados: fica a que tem linhas
  function tabelaCom(colunas) {
    let melhor = null;
    for (const tb of document.querySelectorAll('table')) {
      const ths = [...tb.querySelectorAll('thead th')].map(th => (th.innerText || '').trim().split('\n')[0].trim());
      if (!colunas.every(c => ths.some(h => h.startsWith(c)))) continue;
      const n = [...tb.querySelectorAll('tbody tr')].filter(tr => tr.querySelectorAll('td').length >= 6).length;
      if (n && (!melhor || n > melhor.n)) melhor = { tb, ths, n };
    }
    return melhor;
  }
  const periodoDias = () => {
    const q = new URLSearchParams(location.search), de = q.get('date_from'), ate = q.get('date_to');
    if (de && ate) { const d = Math.round((Date.parse(ate) - Date.parse(de)) / 864e5) + 1; if (d > 0 && d < 400) return d; }
    const m = (document.body.innerText || '').match(/Últimos (\d+) dias/); return m ? +m[1] : 30;
  };
  const anunciante = () => { const q = new URLSearchParams(location.search); return q.get('advertiserId') || q.get('advertiser_id') || ''; };

  function lerCampanhas() {
    const t = tabelaCom(['Nome da campanha', 'ROAS Objetivo', 'ACOS', 'Investimento']); if (!t) return null;
    const { tb, ths } = t, i = n => ths.findIndex(h => h.startsWith(n));
    const c = { nome: i('Nome da campanha'), roasObj: i('ROAS Objetivo'), orc: i('Orçamento'), acos: i('ACOS'), roas: ths.findIndex(h => /^ROAS(\s|$)/.test(h) && !h.startsWith('ROAS Objetivo')), vend: i('Vendas'), rec: i('Receita'), inv: i('Investimento') };
    const linhas = [];
    for (const tr of tb.querySelectorAll('tbody tr')) {
      const tds = tr.querySelectorAll('td'); if (tds.length < 6) continue;
      const a = tr.querySelector('a[href*="/campaigns/"]');
      const id = (a?.getAttribute('href') || '').match(/campaigns\/(\d+)/)?.[1]; if (!id) continue;
      const nomeTd = (tds[c.nome]?.innerText || '').trim();
      linhas.push({
        id, tr, href: a.href, nome: (a.innerText || nomeTd).trim().split('\n')[0], anuncios: +(nomeTd.match(/(\d+) anúncio/)?.[1] || 0),
        roasObj: celula(tds[c.roasObj]).v, orc: celula(tds[c.orc]).v, acos: celula(tds[c.acos]), roas: celula(tds[c.roas]),
        vendas: celula(tds[c.vend]), receita: celula(tds[c.rec]), invest: celula(tds[c.inv]),
      });
    }
    return linhas;
  }

  function lerCabecalhoCampanha() {
    const t = document.body.innerText || '';
    const pega = re => (t.match(re) || [])[1];
    return {
      orc: num(pega(/Orçamento diário\s*\n+\s*(R\$\s?[\d.,]+)/)), roasObj: num(pega(/ROAS Objetivo\s*\n+\s*([\d.,]+x)/)),
      diag: (pega(/Diagnóstico:\s*\n+\s*([A-ZÇÃÕÉÍÓÚ ]{3,30})/) || '').trim(),
    };
  }
  function lerAnuncios() {
    const t = tabelaCom(['Título', 'Impressões', 'Cliques', 'Investimento']); if (!t) return null;
    const { tb, ths } = t, i = n => ths.findIndex(h => h.startsWith(n));
    const c = { tit: i('Título'), imp: i('Impressões'), cli: i('Cliques'), cpc: i('Custo por clique'), vend: i('Vendas'), rec: i('Receita'), inv: i('Investimento'), acos: i('ACOS'), tacos: i('TACOS') };
    const linhas = [];
    for (const tr of tb.querySelectorAll('tbody tr')) {
      const tds = tr.querySelectorAll('td'); if (tds.length < 6) continue;
      const tit = (tds[c.tit]?.innerText || '').replace(/\s+/g, ' ').trim(); if (!tit) continue;
      linhas.push({
        id: (tit.match(/#(MLB\d+)/) || [])[1] || null, tr, status: (tit.match(/^([A-ZÇÃÕÉÍÓÚ ]+?)\s+#/) || [])[1] || '',
        nome: tit.replace(/^.*?ORIGEM:\s*\S+\s*/, '') || tit,
        imp: celula(tds[c.imp]), cli: celula(tds[c.cli]), cpc: celula(tds[c.cpc]), vendas: celula(tds[c.vend]), receita: celula(tds[c.rec]), invest: celula(tds[c.inv]), acos: celula(tds[c.acos]), tacos: c.tacos >= 0 ? celula(tds[c.tacos]) : { v: null },
      });
    }
    return linhas;
  }

  // ── Vereditos ──
  const r1 = v => Math.round(v * 10) / 10;
  const br = v => String(r1(v)).replace('.', ',');
  function vereditoCampanha(x, metaCfg, dias, cab) {
    const meta = metaCfg || (x.roasObj ? 100 / x.roasObj : null);
    const inv = x.invest.v || 0, vend = x.vendas.v || 0, acos = x.acos.v, gastoDia = inv / dias, uso = x.orc ? gastoDia / x.orc : null;
    const base = { meta, uso, gastoDia };
    if (cab && /APRENDENDO/i.test(cab.diag)) return { ...base, v: 'aguardar', motivo: 'O Mercado Ads ainda está aprendendo esta campanha.', acao: 'Espere o fim do aprendizado antes de mexer no ROAS ou no orçamento.' };
    if (!inv && !vend) return { ...base, v: 'semdados', motivo: 'Sem investimento no período.', acao: x.anuncios ? 'Confira se os anúncios estão competindo e se o ROAS objetivo não está alto demais.' : 'Campanha sem anúncios: adicione anúncios ou pause.' };
    if (inv >= LIM.gastoSemVendaMin && !vend) return { ...base, v: 'corrigir', motivo: `Investiu R$ ${br(inv)} sem nenhuma venda atribuída.`, acao: 'Abra a campanha e retire os anúncios que gastam sem vender; se nenhum vende, pause.' };
    if (meta && acos != null && acos > meta * LIM.excessoConter) {
      const novo = x.roasObj ? r1(x.roasObj / (1 - LIM.passoRoas)) : null;
      return { ...base, v: 'conter', motivo: `ACOS de ${br(acos)}% acima da meta de ${br(meta)}%.`, acao: novo ? `Subir o ROAS objetivo de ${br(x.roasObj)}x para ${br(novo)}x (lance mais conservador).` : 'Reduzir o orçamento diário.', novoRoas: novo };
    }
    if (meta && acos != null && acos <= meta * LIM.folgaEscalar && vend >= LIM.minVendasEscalar) {
      if (uso != null && uso >= LIM.orcSaturado) { const novoOrc = Math.round(x.orc * (1 + LIM.passoOrc)); return { ...base, v: 'escalar', gargalo: 'orçamento', motivo: `ACOS de ${br(acos)}% com folga (meta ${br(meta)}%) e ${Math.round(uso * 100)}% do orçamento já é usado.`, acao: `Aumentar o orçamento diário de R$ ${x.orc} para R$ ${novoOrc}.`, novoOrc }; }
      const piso = metaCfg ? 100 / metaCfg : 1, novo = x.roasObj ? r1(Math.max(1, piso, x.roasObj * (1 - LIM.passoRoas))) : null;
      return { ...base, v: 'escalar', gargalo: 'lance', motivo: `ACOS de ${br(acos)}% com folga (meta ${br(meta)}%) e o orçamento não é o limite${uso != null ? ` (${Math.round(uso * 100)}% usado)` : ''}.`, acao: novo && novo < x.roasObj ? `Baixar o ROAS objetivo de ${br(x.roasObj)}x para ${br(novo)}x (lance mais agressivo).` : 'Manter: o ROAS objetivo já está no piso da meta.', novoRoas: novo && novo < x.roasObj ? novo : null };
    }
    return { ...base, v: 'manter', motivo: acos != null && meta ? `ACOS de ${br(acos)}% perto da meta (${br(meta)}%).` : 'Dentro do esperado.', acao: 'Sem mudança agora.' };
  }

  function vereditoAnuncio(a, meta, tot) {
    const inv = a.invest.v || 0, vend = a.vendas.v || 0, cli = a.cli.v || 0, imp = a.imp.v || 0, acos = a.acos.v;
    const ctr = imp ? cli / imp * 100 : null, conv = cli ? vend / cli * 100 : null, base = { ctr, conv };
    const ticket = tot.vendas ? tot.receita / tot.vendas : null;
    const limite = Math.max(LIM.gastoSemVendaMin, ticket && meta ? ticket * meta / 100 * 1.5 : 0);
    if (!inv && !imp) return { ...base, v: 'semdados', motivo: a.status && !/COMPETINDO/i.test(a.status) ? `Status "${a.status.toLowerCase()}": não está competindo.` : 'Sem impressões no período.', acao: 'Confira estoque, preço e se o anúncio está ativo.' };
    if (!vend && inv >= limite) return { ...base, v: 'retirar', motivo: `Investiu R$ ${br(inv)} sem vender (limite R$ ${Math.round(limite)}).`, acao: 'Pausar o anúncio nesta campanha.' };
    if (!vend && cli >= LIM.cliquesAvaliar) return { ...base, v: 'avaliar', motivo: `${cli} cliques e nenhuma venda: atrai, mas não converte.`, acao: 'Revise preço, frete, fotos e ficha antes de investir mais.' };
    if (ctr != null && imp >= 3000 && ctr < LIM.ctrBaixo) return { ...base, v: 'avaliar', motivo: `CTR de ${br(ctr)}% em ${imp.toLocaleString('pt-BR')} impressões: aparece, mas quase ninguém clica.`, acao: 'Melhore a foto principal, o título e o preço.' };
    if (meta && acos != null && vend && acos > meta * 1.5) return { ...base, v: 'mover', motivo: `ACOS de ${br(acos)}%, muito acima da meta (${br(meta)}%).`, acao: 'Mover para uma campanha com ROAS objetivo maior (mais conservadora).' };
    if (meta && acos != null && vend >= 2 && acos <= meta * 0.6) return { ...base, v: 'escalar', motivo: `ACOS de ${br(acos)}%, bem abaixo da meta (${br(meta)}%), com ${vend} vendas.`, acao: 'Candidato a uma campanha própria, mais agressiva, para vender mais.' };
    return { ...base, v: 'manter', motivo: vend ? `${vend} venda(s) com ACOS de ${acos != null ? br(acos) + '%' : '—'}.` : 'Ainda pouco investimento para concluir.', acao: 'Sem mudança agora.' };
  }

  const VER = {
    escalar: ['Escalar', '#0f8a4b', '#e7f6ee'], manter: ['Manter', '#4a5568', '#eef0f4'], conter: ['Conter', '#b45309', '#fff3e0'],
    corrigir: ['Corrigir', '#c0392b', '#fdecea'], aguardar: ['Aguardar', '#2563eb', '#e8f0fe'], semdados: ['Sem dados', '#8a8fa0', '#f3f4f7'],
    retirar: ['Retirar', '#c0392b', '#fdecea'], avaliar: ['Avaliar', '#b45309', '#fff3e0'], mover: ['Mover', '#7c3aed', '#f1ebff'],
  };
  const PRIOR = { corrigir: 0, retirar: 0, conter: 1, mover: 1, avaliar: 2, escalar: 3, aguardar: 4, manter: 5, semdados: 6 };

  // selo colado na linha da tabela do ML (refeito a cada leitura)
  function selo(tr, v, titulo) {
    if (!tr) return;
    let s = tr.querySelector('.glr-selo');
    const [rot, cor, fundo] = VER[v] || VER.manter;
    if (!s) { s = document.createElement('span'); s.className = 'glr-selo'; const alvo = tr.querySelector('a[href*="/campaigns/"]') || tr.children[1]; if (!alvo) return; alvo.insertAdjacentElement('afterend', s); }
    s.textContent = rot; s.title = titulo || '';
    s.setAttribute('style', `display:inline-block;margin:2px 6px;padding:1px 7px;border-radius:99px;font:600 11px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;color:${cor};background:${fundo};vertical-align:middle;white-space:nowrap`);
  }

  // Analisa a tela atual. cfg: { metaAcos } do anunciante
  function analisar(cfg) {
    const dias = periodoDias(), metaCfg = parseFloat(cfg?.metaAcos) || null;
    const camp = (location.pathname.match(/campaigns\/(\d+)\/dashboard/) || [])[1];
    if (camp) {
      const ads = lerAnuncios(); if (!ads || !ads.length) return { tipo: 'carregando' };
      const cab = lerCabecalhoCampanha(), meta = metaCfg || (cab.roasObj ? 100 / cab.roasObj : null);
      const tot = ads.reduce((s, a) => ({ invest: s.invest + (a.invest.v || 0), receita: s.receita + (a.receita.v || 0), vendas: s.vendas + (a.vendas.v || 0), cli: s.cli + (a.cli.v || 0), imp: s.imp + (a.imp.v || 0) }), { invest: 0, receita: 0, vendas: 0, cli: 0, imp: 0 });
      const vc = vereditoCampanha({ roasObj: cab.roasObj, orc: cab.orc, anuncios: ads.length, invest: { v: tot.invest }, vendas: { v: tot.vendas }, acos: { v: tot.receita ? tot.invest / tot.receita * 100 : null } }, metaCfg, dias, cab);
      const itens = ads.map(a => ({ ...a, ...vereditoAnuncio(a, meta, tot) })).sort((a, b) => PRIOR[a.v] - PRIOR[b.v] || (b.invest.v || 0) - (a.invest.v || 0));
      itens.forEach(a => selo(a.tr, a.v, `${a.motivo} ${a.acao}`));
      return { tipo: 'campanha', campanha: camp, dias, cab, meta, tot, vc, itens };
    }
    const cs = lerCampanhas(); if (!cs || !cs.length) return { tipo: 'nada' };
    const itens = cs.map(x => ({ ...x, ...vereditoCampanha(x, metaCfg, dias) })).sort((a, b) => PRIOR[a.v] - PRIOR[b.v] || (b.invest.v || 0) - (a.invest.v || 0));
    itens.forEach(x => selo(x.tr, x.v, `${x.motivo} ${x.acao}`));
    const tot = cs.reduce((s, x) => ({ invest: s.invest + (x.invest.v || 0), receita: s.receita + (x.receita.v || 0), vendas: s.vendas + (x.vendas.v || 0) }), { invest: 0, receita: 0, vendas: 0 });
    return { tipo: 'lista', dias, metaCfg, tot, itens };
  }

  window.__glrAnalise = { analisar, anunciante, VER, num, celula, LIM };
})();
