// ============================================================
// GLR Consultoria — Score da operação
// ------------------------------------------------------------
// Acompanhamento do dia a dia da saúde das lojas: a nota de 0 a 100 de cada
// loja (8 critérios — js/score-contas.js) e a média por cliente e da operação,
// com a evolução dia a dia. Hoje = cálculo ao vivo com o que os agentes já
// gravaram; dias anteriores = registro diário (glr_score_dia_AAAA-MM-DD, gravado
// pelo cron api/score-cron.js às 23:50 e pela própria página quando o dia ainda
// não tem registro). A nota de todos os dias é refeita com os pesos atuais
// (glr_dc_score, editáveis no botão "Pesos do score"), para a evolução comparar
// sempre a mesma régua. Só Mercado Livre e Shopee.
// ============================================================
Router.register('score-operacao', (params, el) => {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (e) { return d; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const K_SCORE = 'glr_dc_score', K_SEL = 'glr_so_sel';
  const SC = GLRScoreContas;
  const cfgScore = () => SC.config(lerJSON(K_SCORE, null));
  const textoSobre = hex => {
    if (!hex) return 'inherit';
    const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? '#111827' : '#ffffff';
  };
  const MKT = { ml: 'Mercado Livre', shopee: 'Shopee' };
  const hoje = SC.hojeBRT();
  const dm = iso => iso.split('-').reverse().slice(0, 2).join('/');
  const PERIODOS = [7, 15, 30, 60];
  const sel = lerJSON(K_SEL, {});
  const st = {
    gestor: sel.gestor || 'todos', mkt: sel.mkt || 'todos', dias: PERIODOS.includes(sel.dias) ? sel.dias : 15, ordem: sel.ordem || 'pior',
    base: null, agentes: null, hist: {}, erro: null, carregando: true, abertos: new Set(),
  };
  const guardarSel = () => gravar(K_SEL, { gestor: st.gestor, mkt: st.mkt, dias: st.dias, ordem: st.ordem });
  const diasDoPeriodo = () => Array.from({ length: st.dias }, (_, i) => SC.diaMenos(hoje, st.dias - 1 - i));

  async function carregar(forcar) {
    st.carregando = true; st.erro = null; render();
    const ini = SC.diaMenos(hoje, Math.max(...PERIODOS) - 1);
    const [base, agentes, hist] = await Promise.all([
      BaseDados.carregar(forcar).catch(e => { st.erro = e.message || String(e); return null; }),
      SC.carregar(forcar).catch(e => { st.erro = e.message || String(e); return null; }),
      SC.historico(ini, hoje).catch(() => ({})),
    ]);
    st.base = base; st.agentes = agentes; st.hist = hist || {};
    st.carregando = false; render();
    // primeiro acesso do dia: já deixa o registro de hoje gravado (o cron da noite atualiza)
    if (base && agentes && !st.hist[hoje]) SC.gravarHojeSeFaltar(base).then(reg => { if (reg) st.hist[hoje] = reg; }).catch(() => {});
  }

  const media = xs => { const v = xs.filter(x => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null; };

  // clientes → lojas, com a nota de hoje e a série do período
  function montar() {
    const vinc = lerJSON('glr_mc_vinculos', {}), cfg = cfgScore(), dias = diasDoPeriodo();
    const gestores = GLR.gestores || [], out = [];
    for (const c of (GLR.clientes || [])) {
      if (/inativ|cancel|encerr/i.test(String(c.status || ''))) continue;
      const foco = GLR.ctx?.cliente?.(); if (foco && String(c.id) !== foco) continue; // cliente em foco (barra de cima)
      const g = gestores.find(x => String(x.id) === String(c.gestorId));
      const gestorId = g ? String(g.id) : 'sem';
      if (!foco && st.gestor !== 'todos' && st.gestor !== gestorId) continue;
      const lojas = [], vistas = new Set();
      for (const ct of (vinc[String(c.id)] || [])) {
        const mkt = BaseDados.mktDe(ct.marketplace); if (mkt !== 'ml' && mkt !== 'shopee') continue;
        if (st.mkt !== 'todos' && st.mkt !== mkt) continue;
        const p = ct.param_to_use || {};
        const id = String(p.shopId || p.meliUserId || ct.contaId || ct.external_id);
        const chave = `${mkt}:${id}`; if (vistas.has(chave)) continue; vistas.add(chave);
        const info = st.base ? (st.base[chave] || st.base[BaseDados.chave(mkt, ct.external_id)]) : null;
        const agora = st.agentes ? SC.calcular({ ...(st.agentes[chave] || {}), mkt, ads: SC.ads30(info, hoje) }, cfg) : null;
        const serie = dias.map(d => {
          if (d === hoje) return agora ? agora.score : null;
          const m = SC.metricasDoRegistro(st.hist[d], chave);
          return m ? SC.deMetricas(m, cfg).score : null;
        });
        const nome = String(GLR.nomeConta(mkt, id) || id).replace(new RegExp(`^${String(c.nome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · `), '');
        // ponto mais fraco: o critério com dado de menor nota (entre os que têm peso)
        const fraco = agora ? agora.itens.filter(i => i.nota != null && i.peso > 0).sort((a, b) => a.nota - b.nota)[0] || null : null;
        lojas.push({ chave, mkt, nome, agora, score: agora ? agora.score : null, serie, fraco });
      }
      if (!lojas.length) continue;
      const serie = dias.map((_, i) => media(lojas.map(l => l.serie[i])));
      out.push({ id: String(c.id), nome: c.nome, gestor: g?.nome || 'Sem gestor', lojas, serie, score: serie[serie.length - 1] });
    }
    return out;
  }

  // variação entre o último dia com nota e um dia de referência
  const delta = (serie, atras) => {
    const fim = serie[serie.length - 1], i = serie.length - 1 - atras;
    if (fim == null || i < 0 || serie[i] == null) return null;
    return fim - serie[i];
  };
  const deltaIni = serie => { const fim = serie[serie.length - 1], i = serie.findIndex(v => v != null); return fim == null || i < 0 || i === serie.length - 1 ? null : fim - serie[i]; };
  // variação de um grupo (cliente, operação) = média da variação de cada loja que tem
  // as duas notas — uma loja que entra ou sai do registro não mexe na variação
  const mediaDec = xs => { const v = xs.filter(x => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null; };
  const deltaGrupo = (lojas, atras) => mediaDec(lojas.map(l => atras === 'ini' ? deltaIni(l.serie) : delta(l.serie, atras)));
  const fmtDelta = d => d == null ? '<span class="so-mut">—</span>'
    : d === 0 ? '<span class="so-mut">=</span>'
    : `<span style="color:${d > 0 ? 'var(--green)' : 'var(--red)'};font-weight:650">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}</span>`;

  // mini gráfico 0–100 da série (falha onde o dia não tem nota)
  function spark(serie, cfg, w = 120, alt = 28) {
    const n = serie.length; if (!serie.some(v => v != null)) return '<span class="so-mut">sem histórico</span>';
    const x = i => n === 1 ? w / 2 : 2 + i * (w - 4) / (n - 1), y = v => alt - 2 - v / 100 * (alt - 4);
    const segs = []; let atual = [];
    serie.forEach((v, i) => { if (v == null) { if (atual.length) segs.push(atual); atual = []; } else atual.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); });
    if (atual.length) segs.push(atual);
    const ult = serie.length - 1 - [...serie].reverse().findIndex(v => v != null), vu = serie[ult];
    const [a, b] = cfg.faixas.limites;
    return `<svg class="so-spark" width="${w}" height="${alt}" viewBox="0 0 ${w} ${alt}" role="img" aria-label="Evolução do score: ${serie.filter(v => v != null).join(', ')}">
      <line x1="0" x2="${w}" y1="${y(a)}" y2="${y(a)}" class="so-ref"/><line x1="0" x2="${w}" y1="${y(b)}" y2="${y(b)}" class="so-ref"/>
      ${segs.map(s => s.length === 1 ? `<circle cx="${s[0].split(',')[0]}" cy="${s[0].split(',')[1]}" r="1.6" class="so-pt"/>` : `<polyline points="${s.join(' ')}" class="so-lin"/>`).join('')}
      <circle cx="${x(ult)}" cy="${y(vu)}" r="2.6" fill="${SC.cor(vu, cfg)}" stroke="var(--bg-card)" stroke-width="1"/></svg>`;
  }

  // gráfico maior: média da operação por dia
  function grafico(serie, dias, cfg) {
    if (!serie.some(v => v != null)) return '<div class="so-mut so-graf-vazio">A evolução aparece conforme os dias forem registrados (um registro por dia, às 23:50).</div>';
    const w = 720, alt = 150, pl = 28, pb = 18, n = serie.length;
    const x = i => pl + (n === 1 ? (w - pl) / 2 : i * (w - pl - 8) / (n - 1)), y = v => 6 + (100 - v) / 100 * (alt - pb - 6);
    const [a, b] = cfg.faixas.limites, cores = cfg.faixas.cores;
    const pts = serie.map((v, i) => v == null ? null : [x(i), y(v), v, dias[i]]).filter(Boolean);
    const passo = Math.ceil(n / 10);
    return `<svg class="so-graf" viewBox="0 0 ${w} ${alt}" role="img" aria-label="Score médio da operação por dia">
      <rect x="${pl}" y="${y(100)}" width="${w - pl}" height="${y(b) - y(100)}" fill="${cores[2]}" opacity=".08"/>
      <rect x="${pl}" y="${y(b)}" width="${w - pl}" height="${y(a) - y(b)}" fill="${cores[1]}" opacity=".08"/>
      <rect x="${pl}" y="${y(a)}" width="${w - pl}" height="${y(0) - y(a)}" fill="${cores[0]}" opacity=".08"/>
      ${[0, 50, 100].map(v => `<text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" class="so-eixo">${v}</text>`).join('')}
      ${dias.map((d, i) => i % passo === 0 || i === n - 1 ? `<text x="${x(i)}" y="${alt - 4}" text-anchor="${i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle'}" class="so-eixo">${dm(d)}</text>` : '').join('')}
      ${pts.length > 1 ? `<polyline points="${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" class="so-lin so-lin-g"/>` : ''}
      ${pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2" fill="${SC.cor(p[2], cfg)}" stroke="var(--bg-card)" stroke-width="1.2"><title>${dm(p[3])}: ${p[2]}</title></circle>`).join('')}
    </svg>`;
  }

  const badge = (v, cfg, cls = 'so-nota') => {
    if (v == null) return '<span class="so-mut" title="Os agentes ainda não têm dados desta loja">—</span>';
    const c = SC.cor(v, cfg); return `<span class="${cls}" style="background:${c};color:${textoSobre(c)}">${v}</span>`;
  };
  const fmtCrit = it => it.valor == null ? '—' : `${it.valor.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
  function detalhe(l) {
    const s = l.agora; if (!s || !st.abertos.has(l.chave)) return '';
    return `<tr class="so-det"><td colspan="8"><div class="so-crit">${s.itens.map(it => `
      <div class="so-crit-i${it.nota == null ? ' sem' : ''}" title="${h(it.ajuda)}"><span>${h(it.nome)}</span>
        <b>${it.nota == null ? 'sem dado' : it.nota}</b><small>${fmtCrit(it)} · peso ${it.peso.toLocaleString('pt-BR')}</small></div>`).join('')}</div>
      <div class="so-mut">Nota 0–100 por critério; o score é a média ponderada dos que têm dado (${s.usados} de ${s.total}). Passe o mouse para ver como cada um é medido.</div></td></tr>`;
  }

  function linha(l, cfg) {
    const aberto = st.abertos.has(l.chave);
    return `<tr>
      <td>${h(MKT[l.mkt])}</td>
      <td class="so-loja" title="${h(l.nome)}">${h(l.nome)}</td>
      <td class="num">${l.score == null ? badge(null, cfg) : `<button class="so-nota so-btn" style="background:${SC.cor(l.score, cfg)};color:${textoSobre(SC.cor(l.score, cfg))}" aria-expanded="${aberto}" title="${l.agora.usados} de ${l.agora.total} critérios com dado. Clique para ver." onclick="window._soAbrir('${h(l.chave)}')">${l.score}</button>`}</td>
      <td class="num">${fmtDelta(delta(l.serie, 1))}</td>
      <td class="num">${fmtDelta(deltaIni(l.serie))}</td>
      <td>${spark(l.serie, cfg)}</td>
      <td>${l.fraco ? `<span title="${h(l.fraco.ajuda)}">${h(l.fraco.nome)} <b>${l.fraco.nota}</b></span>` : '<span class="so-mut">—</span>'}</td>
      <td class="num">${l.agora ? `${l.agora.usados}/${l.agora.total}` : '—'}</td>
    </tr>${detalhe(l)}`;
  }

  function ordenar(clientes) {
    const k = c => c.score == null ? 999 : c.score;
    const queda = c => deltaGrupo(c.lojas, 1) ?? 0;
    const lojaOrd = (a, b) => (a.score == null ? 999 : a.score) - (b.score == null ? 999 : b.score) || a.nome.localeCompare(b.nome);
    for (const c of clientes) c.lojas.sort(lojaOrd);
    if (st.ordem === 'nome') return clientes.sort((a, b) => a.nome.localeCompare(b.nome));
    if (st.ordem === 'queda') return clientes.sort((a, b) => queda(a) - queda(b) || k(a) - k(b));
    return clientes.sort((a, b) => k(a) - k(b) || a.nome.localeCompare(b.nome));
  }

  function render() {
    const root = el.querySelector('#so-root'); if (!root) return;
    if (st.carregando && !st.agentes) { root.innerHTML = '<div class="card so-vazio">Carregando o score das lojas…</div>'; return; }
    const cfg = cfgScore(), dias = diasDoPeriodo(), clientes = ordenar(montar());
    const lojas = clientes.flatMap(c => c.lojas);
    const serieOp = dias.map((_, i) => media(lojas.map(l => l.serie[i])));
    const [a, b] = cfg.faixas.limites, cores = cfg.faixas.cores;
    const comNota = lojas.filter(l => l.score != null);
    const n0 = comNota.filter(l => l.score < a).length, n1 = comNota.filter(l => l.score >= a && l.score < b).length, n2 = comNota.filter(l => l.score >= b).length;
    const dOntem = deltaGrupo(lojas, 1), dIni = deltaGrupo(lojas, 'ini');
    const quedas = lojas.map(l => ({ l, d: delta(l.serie, 1) })).filter(x => x.d != null && x.d <= -5).sort((x, y) => x.d - y.d);
    const regs = dias.filter(d => d !== hoje && st.hist[d]).length;
    root.innerHTML = `
      ${st.erro ? `<div class="card so-aviso">Não consegui ler tudo: ${h(st.erro)}</div>` : ''}
      <div class="so-resumo card">
        <div><span>Score médio hoje</span><b>${badge(serieOp[serieOp.length - 1], cfg, 'so-nota so-nota-g')}</b></div>
        <div><span>vs. ontem</span><b>${fmtDelta(dOntem)}</b></div>
        <div><span>vs. ${st.dias} dias</span><b>${fmtDelta(dIni)}</b></div>
        <div><span><i class="so-dot" style="background:${cores[0]}"></i>Abaixo de ${a}</span><b>${n0}</b></div>
        <div><span><i class="so-dot" style="background:${cores[1]}"></i>${a} a ${b - 1}</span><b>${n1}</b></div>
        <div><span><i class="so-dot" style="background:${cores[2]}"></i>${b} ou mais</span><b>${n2}</b></div>
        <div><span>Sem dado</span><b>${lojas.length - comNota.length}</b></div>
      </div>
      <div class="card so-graf-box"><div class="so-graf-tit"><b>Evolução do score médio</b><span class="so-mut">${st.dias} dias · ${regs} dia(s) com registro antes de hoje · notas refeitas com os pesos atuais</span></div>${grafico(serieOp, dias, cfg)}</div>
      ${quedas.length ? `<div class="card so-alerta"><b>Caíram 5 pontos ou mais desde ontem:</b> ${quedas.slice(0, 12).map(x => `<span>${h(x.l.nome)} ${fmtDelta(x.d)}</span>`).join(' · ')}${quedas.length > 12 ? ` e mais ${quedas.length - 12}` : ''}</div>` : ''}
      <div class="so-sub">${clientes.length} cliente(s), ${lojas.length} loja(s) do Mercado Livre e Shopee. Hoje é o cálculo ao vivo com o que os agentes já leram; os dias anteriores vêm do registro diário.</div>
      ${clientes.length ? clientes.map(c => `<section class="card so-cli">
        <div class="so-cli-cab"><div><b>${h(c.nome)}</b><span>${h(c.gestor)}</span></div>
          <div class="so-cli-tot"><span title="Média do score das lojas do cliente">Score ${badge(c.score, cfg, 'so-nota so-nota-p')}</span><span>vs. ontem ${fmtDelta(deltaGrupo(c.lojas, 1))}</span><span>vs. ${st.dias} dias ${fmtDelta(deltaGrupo(c.lojas, 'ini'))}</span>${spark(c.serie, cfg)}</div></div>
        <div class="so-scroll"><table class="so-tab">
          <colgroup><col style="width:11%"><col style="width:22%"><col style="width:8%"><col style="width:9%"><col style="width:9%"><col style="width:15%"><col style="width:19%"><col style="width:7%"></colgroup>
          <thead><tr><th>Marketplace</th><th>Loja</th><th class="num">Score</th><th class="num">vs. ontem</th><th class="num">vs. ${st.dias} dias</th><th>Evolução</th><th title="O critério com a menor nota hoje">Ponto mais fraco</th><th class="num" title="Critérios com dado">Dados</th></tr></thead>
          <tbody>${c.lojas.map(l => linha(l, cfg)).join('')}</tbody>
        </table></div></section>`).join('') : '<div class="card so-vazio">Nenhum cliente com lojas do Mercado Livre ou Shopee para este filtro.</div>'}`;
  }

  window._soAbrir = chave => { if (st.abertos.has(chave)) st.abertos.delete(chave); else st.abertos.add(chave); render(); };
  window._soFiltro = (k, v) => { st[k] = k === 'dias' ? Number(v) : v; guardarSel(); render(); };
  window._soRecarregar = () => { if (BaseDados.invalidar) BaseDados.invalidar(); carregar(true); };
  // editor dos pesos: peso e faixa (nota 0 em / nota 100 em) de cada critério + limites e cores do score
  window._soPesos = () => {
    const box = el.querySelector('#so-pesos'); if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    const c = cfgScore(), [a, b] = c.faixas.limites;
    const num = (cls, id, v, rot) => `<input type="number" step="0.1" class="form-input ${cls}" data-id="${id}" value="${v}" aria-label="${h(rot)}">`;
    const cor = (i, rot) => `<label class="so-f"><input type="color" class="so-cor" data-i="${i}" value="${c.faixas.cores[i]}" aria-label="Cor: ${h(rot)}"><span>${rot}</span></label>`;
    box.innerHTML = `<b>Pesos do score de saúde</b>
      <div class="so-scroll"><table class="so-pesos-tab"><thead><tr><th>Critério</th><th>Peso</th><th title="Valor do critério que dá nota 0">Nota 0 em (%)</th><th title="Valor do critério que dá nota 100">Nota 100 em (%)</th><th>Como é medido</th></tr></thead><tbody>
      ${SC.CRITERIOS.map(k => { const f = c.criterios[k.id]; return `<tr><td>${h(k.nome)}</td>
        <td>${num('so-peso', k.id, f.peso, `Peso: ${k.nome}`)}</td><td>${num('so-zero', k.id, f.zero, `Nota 0 em: ${k.nome}`)}</td><td>${num('so-cem', k.id, f.cem, `Nota 100 em: ${k.nome}`)}</td>
        <td class="so-mut">${h(k.ajuda)}</td></tr>`; }).join('')}
      </tbody></table></div>
      <div class="so-mut">Entre os dois valores a nota sobe em linha reta. Se "nota 100" for menor que "nota 0", quanto menor o valor, melhor (ex.: TACOS). Peso 0 tira o critério do score. A evolução é refeita com os pesos novos.</div>
      <div class="so-lin-ed">${cor(0, 'Score abaixo de')} <input type="number" step="1" min="0" max="100" class="form-input so-lim" value="${a}" aria-label="Limite 1 do score"></div>
      <div class="so-lin-ed">${cor(1, 'Score abaixo de')} <input type="number" step="1" min="0" max="100" class="form-input so-lim" value="${b}" aria-label="Limite 2 do score"></div>
      <div class="so-lin-ed">${cor(2, 'A partir do último limite')}</div>
      <div class="so-acoes"><button class="btn btn-primary btn-sm" onclick="window._soPesosSalvar()">Salvar</button>
        <button class="btn btn-secondary btn-sm" onclick="window._soPesosPadrao()">Voltar ao padrão</button>
        <span class="so-mut">Vale para a equipe toda.</span></div>`;
    box.hidden = false;
  };
  window._soPesosSalvar = () => {
    const box = el.querySelector('#so-pesos'); if (!box) return;
    const val = i => parseFloat(String(i.value).replace(',', '.'));
    const criterios = {};
    for (const k of SC.CRITERIOS) {
      const pega = cls => val(box.querySelector(`.${cls}[data-id="${k.id}"]`));
      const peso = pega('so-peso'), zero = pega('so-zero'), cem = pega('so-cem');
      if (![peso, zero, cem].every(isFinite) || peso < 0) { GLR.avisar(`Preencha peso e faixa de "${k.nome}" com números.`, 'erro'); return; }
      if (zero === cem) { GLR.avisar(`Em "${k.nome}", "nota 0" e "nota 100" precisam ser valores diferentes.`, 'erro'); return; }
      criterios[k.id] = { peso, zero, cem };
    }
    if (!Object.values(criterios).some(x => x.peso > 0)) { GLR.avisar('Deixe pelo menos um critério com peso maior que zero.', 'erro'); return; }
    const lim = [...box.querySelectorAll('.so-lim')].map(val);
    if (lim.some(v => !isFinite(v)) || lim[0] > lim[1]) { GLR.avisar('Os limites do score precisam ser números, do menor para o maior.', 'erro'); return; }
    const cores = [...box.querySelectorAll('.so-cor')].map(i => i.value);
    gravar(K_SCORE, { criterios, faixas: { limites: lim, cores } }); box.hidden = true; render();
    GLR.avisar('Pesos do score salvos.', 'sucesso');
  };
  window._soPesosPadrao = () => { gravar(K_SCORE, {}); const box = el.querySelector('#so-pesos'); if (box) box.hidden = true; render(); };

  const gestores = (GLR.gestores || []).slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
  const opt = (v, rot, atual) => `<option value="${h(v)}" ${String(v) === String(atual) ? 'selected' : ''}>${h(rot)}</option>`;
  el.innerHTML = `<div class="page so">
    <header class="so-head">
      <div><h1>Score da operação</h1><p>Saúde de cada loja de 0 a 100 e como ela evolui dia a dia, por cliente.</p></div>
      <div class="so-filtros">
        <label>Gestor<select class="form-input" onchange="window._soFiltro('gestor', this.value)">${opt('todos', 'Todos', st.gestor)}${gestores.map(g => opt(g.id, g.nome, st.gestor)).join('')}${opt('sem', 'Sem gestor', st.gestor)}</select></label>
        <label>Marketplace<select class="form-input" onchange="window._soFiltro('mkt', this.value)">${opt('todos', 'Todos', st.mkt)}${opt('ml', 'Mercado Livre', st.mkt)}${opt('shopee', 'Shopee', st.mkt)}</select></label>
        <label>Período<select class="form-input" onchange="window._soFiltro('dias', this.value)">${PERIODOS.map(p => opt(p, `${p} dias`, st.dias)).join('')}</select></label>
        <label>Ordem<select class="form-input" onchange="window._soFiltro('ordem', this.value)">${opt('pior', 'Pior score primeiro', st.ordem)}${opt('queda', 'Maior queda desde ontem', st.ordem)}${opt('nome', 'Nome do cliente', st.ordem)}</select></label>
        <button class="btn btn-secondary btn-sm" onclick="window._soPesos()" title="Pesos e faixas dos critérios do score">Pesos do score</button>
        <button class="btn btn-secondary btn-sm" onclick="window._soRecarregar()">Atualizar</button>
      </div>
    </header>
    <div id="so-pesos" class="card so-pesos" hidden></div>
    <div id="so-root"></div>
  </div>
  <style>
    .so-head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
    .so-head h1{margin:0;font-size:22px;font-weight:650;letter-spacing:-.02em} .so-head p{margin:4px 0 0;font-size:13px;color:var(--text-secondary)}
    .so-filtros{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end} .so-filtros label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)}
    .so-resumo{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:4px;padding:14px 18px;margin-bottom:10px}
    .so-resumo div{display:flex;flex-direction:column;gap:4px;padding:4px 10px;border-left:1px solid var(--border)} .so-resumo div:first-child{border-left:none;padding-left:0}
    .so-resumo span{font-size:12.5px;color:var(--text-secondary);display:flex;align-items:center;gap:6px} .so-resumo b{font-size:19px;font-variant-numeric:tabular-nums;align-self:flex-start}
    .so-dot{display:inline-block;width:9px;height:9px;border-radius:50%}
    .so-nota{display:inline-block;border-radius:8px;min-width:36px;padding:2px 8px;font-weight:700;font-variant-numeric:tabular-nums;text-align:center}
    .so-nota-g{font-size:18px;padding:2px 12px} .so-nota-p{font-size:13px;min-width:30px;padding:0 6px;margin-left:4px}
    .so-btn{border:none;font:inherit;font-weight:700;cursor:pointer} .so-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .so-graf-box{padding:12px 16px;margin-bottom:10px} .so-graf-tit{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;margin-bottom:6px;font-size:13.5px}
    .so-graf{width:100%;height:auto;max-height:220px;display:block} .so-graf-vazio{padding:18px 0}
    .so-eixo{font-size:10px;fill:var(--text-muted)} .so-ref{stroke:var(--border);stroke-dasharray:2 3}
    .so-lin{fill:none;stroke:var(--text-secondary);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke} .so-lin-g{stroke:var(--accent);stroke-width:2}
    .so-pt{fill:var(--text-secondary)} .so-spark{display:block;overflow:visible}
    .so-alerta{padding:10px 14px;margin-bottom:10px;font-size:13px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
    .so-sub{font-size:12px;color:var(--text-muted);margin:0 0 10px}
    .so-cli{padding:0;margin-bottom:14px;overflow:hidden}
    .so-cli-cab{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:12px 16px;background:color-mix(in srgb,var(--accent) 9%,var(--bg-card));border-bottom:1px solid var(--border)}
    .so-cli-cab b{font-size:15px} .so-cli-cab>div:first-child span{display:block;font-size:12px;color:var(--text-muted)}
    .so-cli-tot{display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums}
    .so-scroll{overflow-x:auto}
    .so-tab{width:100%;min-width:900px;table-layout:fixed;border-collapse:collapse;font-size:13px}
    .so-tab th{font-size:11.5px;font-weight:600;color:var(--text-secondary);text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
    .so-tab td{padding:6px 12px;border-bottom:1px solid var(--border);white-space:nowrap;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}
    .so-tab tr:last-child td{border-bottom:none} .so-tab .num{text-align:right} .so-loja{font-weight:600}
    .so-tab tr.so-det td{white-space:normal;background:color-mix(in srgb,var(--accent) 4%,var(--bg-card));padding:10px 12px}
    .so-crit{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-bottom:6px}
    .so-crit-i{display:flex;flex-direction:column;gap:1px;border:1px solid var(--border);border-radius:8px;padding:6px 10px;background:var(--bg-card)}
    .so-crit-i span{font-size:12px;color:var(--text-secondary)} .so-crit-i b{font-size:16px} .so-crit-i small{font-size:11.5px;color:var(--text-muted)}
    .so-crit-i.sem b{font-size:13px;color:var(--text-muted);font-weight:600}
    .so-pesos{display:flex;flex-direction:column;gap:8px;padding:12px 16px;margin-bottom:12px;font-size:13px}
    .so-pesos-tab{border-collapse:collapse;font-size:13px} .so-pesos-tab th{font-size:11.5px;font-weight:600;color:var(--text-secondary);text-align:left;padding:4px 8px}
    .so-pesos-tab td{padding:3px 8px} .so-pesos-tab input[type=number]{width:80px}
    .so-lin-ed{display:flex;align-items:center;gap:8px} .so-f{display:flex;align-items:center;gap:8px;min-width:190px}
    .so-f input[type=color]{width:34px;height:26px;padding:0;border:1px solid var(--border);border-radius:6px;background:none;cursor:pointer}
    .so-lim{width:90px} .so-acoes{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px}
    .so-mut{font-size:12px;color:var(--text-muted)} .so-vazio{padding:28px;text-align:center;color:var(--text-secondary)} .so-aviso{padding:10px 14px;color:var(--red);margin-bottom:10px}
  </style>`;
  carregar();
  if (GLR.quandoClientes) GLR.quandoClientes(() => render());
  window.addEventListener('glr-base-atualizada', () => { if (el.querySelector('#so-root')) carregar(true); });
});
