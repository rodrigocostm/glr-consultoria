// ============================================================
// GLR Consultoria — Plano Black Friday (Shopee)
// ------------------------------------------------------------
// Por loja Shopee: quanto de saldo de ADS precisa até o fim da semana da Black
// Friday (27/11, até a Cyber Monday 30/11) no ritmo atual, com o aumento que você
// definir para a semana e para o dia, quanto recarregar e quais produtos que mais
// vendem acabam o estoque antes. Saldo e gasto médio de 7 dias vêm do monitor de
// saldo (glr_sync_estado sistema / saldo_ads / shopee, de hora em hora); estoque e
// venda por dia vêm do agente de Estoque e Margem (recurso 'sinais' da loja).
// Não envia nada: a mensagem para o cliente é só copiada para você mandar.
// ============================================================
Router.register('black-friday', (params, el) => {
  const R$ = v => v == null || isNaN(v) ? '—' : 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const R0 = v => R$(v).replace(/,\d{2}$/, '');
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch (e) { return d; } };
  const salvar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const ANO = new Date().getFullYear();
  const BF = `${ANO}-11-27`, SEMANA_INI = `${ANO}-11-24`, FIM = `${ANO}-11-30`; // Black Friday (sexta) e Cyber Monday
  const hojeIso = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const dm = iso => iso.split('-').reverse().slice(0, 2).join('/');

  const st = {
    lojas: [], em: null, carregando: true, erro: null,
    semana: lerJSON('glr_bf_semana', 50), dia: lerJSON('glr_bf_dia', 100), // % a mais de gasto na semana e no dia da BF
    aberta: null, sinais: {}, copiado: null,
  };

  // dias de hoje até 30/11 com o peso de cada um: normal 1; semana da BF 1+semana%; dia 27/11 1+dia%
  function pesos() {
    const out = { normal: 0, semana: 0, bf: 0, total: 0 };
    for (let d = new Date(`${hojeIso}T12:00:00Z`); d.toISOString().slice(0, 10) <= FIM; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (iso === BF) { out.bf++; out.total += 1 + st.dia / 100; }
      else if (iso >= SEMANA_INI) { out.semana++; out.total += 1 + st.semana / 100; }
      else { out.normal++; out.total += 1; }
    }
    return out;
  }

  async function carregar() {
    st.carregando = true; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('cursor').eq('marketplace', 'sistema').eq('conta_id', 'saldo_ads').eq('recurso', 'shopee').maybeSingle();
      if (error) throw error;
      st.lojas = Object.entries(data?.cursor?.lojas || {}).map(([id, s]) => ({ id, ...s }));
      st.em = st.lojas.reduce((m, s) => s.em && s.em > m ? s.em : m, '');
      st.erro = null;
    } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  async function carregarSinais(id) {
    if (st.sinais[id]) return;
    st.sinais[id] = { carregando: true }; render();
    try {
      const { data, error } = await _sb.from('glr_sync_estado').select('cursor').eq('marketplace', 'shopee').eq('conta_id', id).eq('recurso', 'sinais').maybeSingle();
      if (error) throw error;
      st.sinais[id] = { itens: data?.cursor?.itens || {} };
    } catch (e) { st.sinais[id] = { erro: e.message || String(e) }; }
    render();
  }

  // produtos que mais vendem e que acabam antes de 30/11 (venda/dia × os mesmos pesos da BF)
  function riscoEstoque(id, p) {
    const s = st.sinais[id]; if (!s?.itens) return null;
    return Object.entries(s.itens).map(([iid, x]) => ({ id: iid, ...x }))
      .filter(x => x.vd > 0 && x.e != null)
      .map(x => ({ ...x, falta: Math.max(0, Math.ceil(x.vd * p.total - x.e)) }))
      .filter(x => x.falta > 0).sort((a, b) => b.vd - a.vd).slice(0, 12);
  }

  function planoDe(s, p) {
    const media = s.media || 0, saldo = s.saldo || 0;
    const precisa = media * p.total;
    return { media, saldo, precisa, recarga: Math.max(0, precisa - saldo), urgente: s.nivel === 'zerado' || s.nivel === 'critico' };
  }

  function mensagem(s, pl, risco) {
    const linhas = [
      `Olá! Para a Black Friday (${dm(BF)}) e a semana dela, as campanhas de ADS da Shopee da loja ${s.nome} precisam de cerca de ${R0(pl.precisa)} de saldo até ${dm(FIM)} (gasto atual de ${R$(pl.media)}/dia, com aumento de ${st.semana}% na semana e ${st.dia}% no dia da Black Friday).`,
      pl.recarga > 0 ? `Hoje o saldo é ${R$(pl.saldo)}. Recomendamos recarregar ${R0(pl.recarga)}${pl.urgente ? ' — o quanto antes, porque o saldo atual acaba hoje' : ''} em Shopee → Marketing → Anúncios Shopee → Adicionar saldo.` : `O saldo atual (${R$(pl.saldo)}) já cobre esse período.`,
    ];
    if (risco?.length) linhas.push(`Estoque: ${risco.slice(0, 5).map(x => `${String(x.n || x.id).slice(0, 50)} (faltam ~${x.falta} un.)`).join('; ')} acabam antes de ${dm(FIM)} no ritmo de venda atual.`);
    return linhas.join('\n\n');
  }

  function render() {
    const root = document.getElementById('bf-root'); if (!root) return;
    if (st.carregando && !st.lojas.length) { root.innerHTML = '<div class="card bf-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card bf-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    if (hojeIso > FIM) { root.innerHTML = '<div class="card bf-vazio">A semana da Black Friday deste ano já passou.</div>'; return; }
    const p = pesos();
    const foco = GLR.ctx?.cliente();
    const usa = st.lojas.filter(s => s.nivel && s.nivel !== 'sem_uso' && (s.media || 0) > 0)
      .filter(s => !foco || GLR.ctx.clienteDaConta('shopee', s.id) === foco)
      .map(s => ({ s, pl: planoDe(s, p) }))
      .sort((a, b) => (b.pl.urgente - a.pl.urgente) || b.pl.recarga - a.pl.recarga);
    const semLeitura = st.lojas.filter(s => !s.nivel && s.erro).length;
    const totRecarga = usa.reduce((t, x) => t + x.pl.recarga, 0), totPrecisa = usa.reduce((t, x) => t + x.pl.precisa, 0);
    const nRecarga = usa.filter(x => x.pl.recarga > 0).length, nUrg = usa.filter(x => x.pl.urgente).length;
    const diasBF = Math.round((Date.parse(`${BF}T12:00:00Z`) - Date.parse(`${hojeIso}T12:00:00Z`)) / 864e5);
    root.innerHTML = `
      <div class="card bf-premissas">
        <div class="bf-cont"><b>${diasBF > 0 ? diasBF : 'Hoje'}</b><span>${diasBF > 0 ? `dia${diasBF > 1 ? 's' : ''} para a Black Friday (${dm(BF)})` : 'é a Black Friday'}</span></div>
        <label class="bf-campo"><span>Aumento de gasto na semana (${dm(SEMANA_INI)} a ${dm(FIM)})</span><div><input id="bf-semana" class="form-control" inputmode="decimal" value="${st.semana}" onchange="window._bfPremissa('semana', this.value)"><em>%</em></div></label>
        <label class="bf-campo"><span>Aumento no dia da Black Friday (${dm(BF)})</span><div><input id="bf-dia" class="form-control" inputmode="decimal" value="${st.dia}" onchange="window._bfPremissa('dia', this.value)"><em>%</em></div></label>
        <div class="bf-sub">Conta: gasto médio dos últimos 7 dias × ${p.normal} dia(s) normais + ${p.semana} dia(s) da semana da BF + ${p.bf} dia da BF, até ${dm(FIM)} (Cyber Monday). Saldo lido ${st.em ? new Date(st.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}.</div>
      </div>
      <div class="bf-topo">
        <div class="bf-num"><b>${R0(totRecarga)}</b><span>de recarga somando ${nRecarga} loja(s)</span></div>
        <div class="bf-num"><b>${R0(totPrecisa)}</b><span>de ADS previsto até ${dm(FIM)}</span></div>
        <div class="bf-num" style="--c:var(--red)"><b>${nUrg}</b><span>precisam recarregar hoje</span></div>
        ${semLeitura ? `<div class="bf-num" style="--c:var(--text-muted)"><b>${semLeitura}</b><span>sem leitura de saldo (veja Saúde das conexões)</span></div>` : ''}
      </div>
      <div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="bf-tab">
        <thead><tr><th>Loja</th><th class="n">Saldo hoje</th><th class="n">Gasto/dia (7 d)</th><th class="n">Precisa até ${dm(FIM)}</th><th class="n">Recarregar</th><th></th></tr></thead>
        <tbody>${usa.map(({ s, pl }) => {
          const aberta = st.aberta === s.id, risco = aberta ? riscoEstoque(s.id, p) : null, sin = st.sinais[s.id];
          return `<tr class="bf-linha${aberta ? ' aberta' : ''}" onclick="window._bfAbrir('${h(s.id)}')">
            <td><span class="bf-seta">${aberta ? '▾' : '▸'}</span> <b>${h(s.nome || s.id)}</b>${pl.urgente ? ' <span class="bf-pill" style="--c:var(--red)">acaba hoje</span>' : ''}</td>
            <td class="n">${R$(pl.saldo)}</td><td class="n">${R$(pl.media)}</td><td class="n">${R0(pl.precisa)}</td>
            <td class="n" style="font-weight:700;color:${pl.recarga > 0 ? (pl.urgente ? 'var(--red)' : 'var(--text-primary)') : 'var(--green)'}">${pl.recarga > 0 ? R0(pl.recarga) : 'já cobre'}</td>
            <td class="n"><button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();window._bfCopiar('${h(s.id)}')">${st.copiado === s.id ? 'Copiado' : 'Copiar mensagem'}</button></td></tr>
            ${aberta ? `<tr><td colspan="6" class="bf-det">${!sin || sin.carregando ? '<span class="bf-sub">Carregando estoque…</span>'
              : sin.erro ? `<span class="bf-sub" style="color:var(--red)">Não consegui ler o estoque: ${h(sin.erro)}</span>`
              : !Object.keys(sin.itens).length ? '<span class="bf-sub">O agente de Estoque e Margem ainda não leu esta loja.</span>'
              : !risco.length ? `<span class="bf-sub" style="color:var(--green)">Nenhum produto que vende acaba antes de ${dm(FIM)} no ritmo atual (com o aumento da BF).</span>`
              : `<div class="bf-sub" style="margin-bottom:6px">Produtos que acabam antes de ${dm(FIM)} — venda por dia atual × os mesmos aumentos da BF:</div>
                <table class="bf-tab bf-mini"><thead><tr><th>Produto</th><th class="n">Estoque</th><th class="n">Vende/dia</th><th class="n">Acaba em</th><th class="n">Falta até ${dm(FIM)}</th></tr></thead>
                <tbody>${risco.map(x => `<tr><td>${h(String(x.n || x.id).slice(0, 80))}</td><td class="n">${x.e}</td><td class="n">${String(x.vd).replace('.', ',')}</td><td class="n">${x.d != null ? `${String(x.d).replace('.', ',')} dia(s)` : '—'}</td><td class="n" style="font-weight:700;color:var(--red)">${x.falta} un.</td></tr>`).join('')}</tbody></table>`}</td></tr>` : ''}`;
        }).join('') || `<tr><td colspan="6" class="bf-vazio">${st.lojas.length ? 'Nenhuma loja com gasto de ADS nos últimos 7 dias.' : 'O monitor de saldo ainda não leu as lojas (roda de hora em hora). Use "Ler agora" no quadro de saldo da tela ADS Shopee.'}</td></tr>`}</tbody>
      </table></div></div>`;
  }

  window._bfPremissa = (k, v) => { const n = parseFloat(String(v).replace(',', '.')); if (!(n >= 0) || n > 1000) return; st[k] = n; salvar(k === 'semana' ? 'glr_bf_semana' : 'glr_bf_dia', n); render(); };
  window._bfAbrir = id => { st.aberta = st.aberta === id ? null : id; render(); if (st.aberta) carregarSinais(id); };
  window._bfCopiar = async id => {
    const s = st.lojas.find(x => x.id === id); if (!s) return;
    if (!st.sinais[id]) await carregarSinais(id);
    const p = pesos(), txt = mensagem(s, planoDe(s, p), riscoEstoque(id, p));
    try { await navigator.clipboard.writeText(txt); st.copiado = id; render(); setTimeout(() => { if (st.copiado === id) { st.copiado = null; render(); } }, 2500); }
    catch (e) { prompt('Copie a mensagem:', txt); }
  };

  el.innerHTML = `<div class="page">
    <div class="ajuda">Quanto cada loja Shopee precisa de saldo de ADS para atravessar a semana da Black Friday sem parar os anúncios, quanto recarregar e quais produtos acabam antes. Ajuste os aumentos de gasto conforme o plano de cada cliente; a mensagem é só copiada, para você mandar ao cliente.</div>
    <div id="bf-root"></div>
  </div>
  <style>
    .bf-sub{font-size:12px;color:var(--text-muted);line-height:1.5}
    .bf-vazio{padding:24px;text-align:center;color:var(--text-muted)}
    .bf-premissas{display:flex;gap:16px 22px;flex-wrap:wrap;align-items:flex-end;padding:16px 18px;margin-bottom:14px}
    .bf-premissas .bf-sub{flex:1 1 100%}
    .bf-cont{display:flex;flex-direction:column;line-height:1.15;margin-right:8px} .bf-cont b{font-size:30px;color:var(--accent);font-variant-numeric:tabular-nums} .bf-cont span{font-size:12px;color:var(--text-muted)}
    .bf-campo{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-secondary)}
    .bf-campo div{display:flex;align-items:center;gap:6px} .bf-campo input{width:80px} .bf-campo em{font-style:normal;color:var(--text-muted)}
    .bf-topo{display:flex;gap:22px;flex-wrap:wrap;margin-bottom:14px}
    .bf-num{display:flex;flex-direction:column;line-height:1.2} .bf-num b{font-size:22px;color:var(--c,var(--text-primary));font-variant-numeric:tabular-nums} .bf-num span{font-size:12px;color:var(--text-muted)}
    .bf-tab{width:100%;border-collapse:collapse;font-size:13px}
    .bf-tab th{padding:9px 12px;text-align:left;font-size:11.5px;font-weight:600;color:var(--text-muted);background:var(--bg-card-hover);white-space:nowrap}
    .bf-tab td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
    .bf-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    .bf-linha{cursor:pointer} .bf-linha:hover td,.bf-linha.aberta td{background:var(--bg-subtle)}
    .bf-seta{display:inline-block;width:12px;color:var(--text-muted)}
    .bf-det{background:var(--bg-subtle);padding:10px 16px 14px 34px !important}
    .bf-mini th{background:transparent} .bf-mini td{padding:6px 10px}
    .bf-pill{display:inline-block;font-size:11px;font-weight:650;padding:1px 7px;border-radius:99px;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent)}
  </style>`;
  carregar();
});
