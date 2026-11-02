// ============================================================
// GLR Consultoria — Datas especiais (Shopee)
// ------------------------------------------------------------
// Para a próxima data especial do varejo (11.11, Black Friday, 12.12, Natal,
// Dia das Mães…), com contador: por loja Shopee, quanto de saldo de ADS precisa
// até o fim da data no ritmo atual, com o aumento que você definir para os dias
// da data e para o dia de pico, quanto recarregar e quais produtos que mais
// vendem acabam o estoque antes. Saldo e gasto médio de 7 dias vêm do monitor de
// saldo (glr_sync_estado sistema / saldo_ads / shopee, de hora em hora); estoque e
// venda por dia vêm do agente de Estoque e Margem (recurso 'sinais' da loja).
// Não envia nada: a mensagem para o cliente é só copiada para você mandar.
// ============================================================
function paginaDatasEspeciais(params, el) {
  const R$ = v => v == null || isNaN(v) ? '—' : 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const R0 = v => R$(v).replace(/,\d{2}$/, '');
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch (e) { return d; } };
  const salvar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const hojeIso = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const dm = iso => iso.split('-').reverse().slice(0, 2).join('/');
  const somaDias = (iso, n) => { const x = new Date(`${iso}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

  // Calendário do varejo: campanha (dia de pico + dias em volta) ou presente (a compra
  // acontece nos dias antes da data; sem dia de pico). ini/fim = janela com gasto maior.
  function calendario(ano) {
    const d = (m, dd) => `${ano}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const nDomingo = (m, n) => { const x = new Date(Date.UTC(ano, m - 1, 1)); return d(m, 1 + (7 - x.getUTCDay()) % 7 + (n - 1) * 7); };
    const bf = somaDias(d(11, 1 + (4 - new Date(Date.UTC(ano, 10, 1)).getUTCDay() + 7) % 7 + 21), 1); // sexta depois da 4ª quinta-feira de novembro
    const dupla = (m, nome) => ({ id: `${m}.${m}`, nome: nome || `${m}.${m}`, dia: d(m, m), ini: somaDias(d(m, m), -2), fim: somaDias(d(m, m), 1), semana: 30, pico: 100, tipo: 'campanha' });
    const presente = (id, nome, dia, antes) => ({ id, nome, dia, ini: somaDias(dia, -antes), fim: somaDias(dia, -1), semana: 40, pico: 0, tipo: 'presente' });
    return [
      { id: 'consumidor', nome: 'Dia do Consumidor', dia: d(3, 15), ini: d(3, 12), fim: d(3, 16), semana: 30, pico: 80, tipo: 'campanha' },
      presente('maes', 'Dia das Mães', nDomingo(5, 2), 10),
      dupla(6), presente('namorados', 'Dia dos Namorados', d(6, 12), 10), dupla(7),
      presente('pais', 'Dia dos Pais', nDomingo(8, 2), 10), dupla(8), dupla(9), dupla(10),
      presente('criancas', 'Dia das Crianças', d(10, 12), 10), dupla(11),
      { id: 'bf', nome: 'Black Friday', art: 'a', dia: bf, ini: somaDias(bf, -3), fim: somaDias(bf, 3), semana: 50, pico: 100, tipo: 'campanha', fimNome: 'Cyber Monday' },
      dupla(12), presente('natal', 'Natal', d(12, 25), 15),
    ].map(e => ({ art: 'o', ...e, id: `${e.id}-${ano}` }));
  }
  const ANO = +hojeIso.slice(0, 4);
  const DATAS = [...calendario(ANO), ...calendario(ANO + 1)].filter(e => e.fim >= hojeIso).sort((a, b) => a.dia.localeCompare(b.dia)).slice(0, 8);
  const EV = () => DATAS.find(e => e.id === st.ev) || DATAS[0];
  const kPrem = (k, e = EV()) => `glr_de_${e.id}_${k}`;

  const st = {
    lojas: [], em: null, carregando: true, erro: null,
    ev: lerJSON('glr_de_sel', null), semana: 0, dia: 0, // % a mais de gasto nos dias da data e no dia de pico
    aberta: null, sinais: {}, copiado: null,
  };
  if (!DATAS.some(e => e.id === st.ev)) st.ev = DATAS[0]?.id; // passou a data guardada: vai para a próxima
  const lerPremissas = () => { const e = EV(); if (!e) return; st.semana = lerJSON(kPrem('semana'), e.semana); st.dia = lerJSON(kPrem('dia'), e.pico); };
  lerPremissas();

  // dias de hoje até o fim da data com o peso de cada um: normal 1; dias da data 1+semana%; dia de pico 1+dia%
  function pesos() {
    const e = EV(), out = { normal: 0, semana: 0, bf: 0, total: 0 };
    for (let d = new Date(`${hojeIso}T12:00:00Z`); d.toISOString().slice(0, 10) <= e.fim; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (iso === e.dia && e.tipo === 'campanha') { out.bf++; out.total += 1 + st.dia / 100; }
      else if (iso >= e.ini) { out.semana++; out.total += 1 + st.semana / 100; }
      else { out.normal++; out.total += 1; }
    }
    return out;
  }

  // contador até 00:00 (Brasília) do dia da data
  function contador() {
    const e = EV(), ms = Date.parse(`${e.dia}T03:00:00Z`) - Date.now();
    if (hojeIso === e.dia) return { n: 'Hoje', txt: `é ${e.art} ${e.nome}` };
    if (ms <= 0) return { n: 'Agora', txt: `${e.nome} — vai até ${dm(e.fim)}${e.fimNome ? ` (${e.fimNome})` : ''}` };
    const dias = Math.floor(ms / 864e5), horas = Math.floor(ms % 864e5 / 36e5), min = Math.floor(ms % 36e5 / 6e4);
    return { n: dias > 0 ? `${dias}d ${String(horas).padStart(2, '0')}h` : `${horas}h ${String(min).padStart(2, '0')}min`, txt: `para ${e.art} ${e.nome} (${dm(e.dia)})` };
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

  // produtos que mais vendem e que acabam antes do fim da data (venda/dia × os mesmos pesos)
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
    const e = EV(), FIM = e.fim;
    const aumento = e.tipo === 'campanha' ? `com aumento de ${st.semana}% nos dias da data e ${st.dia}% no dia ${dm(e.dia)}` : `com aumento de ${st.semana}% de ${dm(e.ini)} a ${dm(e.fim)}`;
    const linhas = [
      `Olá! Para ${e.art} ${e.nome} (${dm(e.dia)}), as campanhas de ADS da Shopee da loja ${s.nome} precisam de cerca de ${R0(pl.precisa)} de saldo até ${dm(FIM)} (gasto atual de ${R$(pl.media)}/dia, ${aumento}).`,
      pl.recarga > 0 ? `Hoje o saldo é ${R$(pl.saldo)}. Recomendamos recarregar ${R0(pl.recarga)}${pl.urgente ? ' — o quanto antes, porque o saldo atual acaba hoje' : ''} em Shopee → Marketing → Anúncios Shopee → Adicionar saldo.` : `O saldo atual (${R$(pl.saldo)}) já cobre esse período.`,
    ];
    if (risco?.length) linhas.push(`Estoque: ${risco.slice(0, 5).map(x => `${String(x.n || x.id).slice(0, 50)} (faltam ~${x.falta} un.)`).join('; ')} acabam antes de ${dm(FIM)} no ritmo de venda atual.`);
    return linhas.join('\n\n');
  }

  function render() {
    const root = document.getElementById('bf-root'); if (!root) return;
    if (st.carregando && !st.lojas.length) { root.innerHTML = '<div class="card bf-vazio">Carregando…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card bf-vazio" style="color:var(--red)">Não consegui carregar: ${h(st.erro)}</div>`; return; }
    const e = EV(); if (!e) { root.innerHTML = '<div class="card bf-vazio">Nenhuma data especial nos próximos meses.</div>'; return; }
    const FIM = e.fim, p = pesos(), cont = contador();
    const foco = GLR.ctx?.cliente();
    const usa = st.lojas.filter(s => s.nivel && s.nivel !== 'sem_uso' && (s.media || 0) > 0)
      .filter(s => !foco || GLR.ctx.clienteDaConta('shopee', s.id) === foco)
      .map(s => ({ s, pl: planoDe(s, p) }))
      .sort((a, b) => (b.pl.urgente - a.pl.urgente) || b.pl.recarga - a.pl.recarga);
    const semLeitura = st.lojas.filter(s => !s.nivel && s.erro).length;
    const totRecarga = usa.reduce((t, x) => t + x.pl.recarga, 0), totPrecisa = usa.reduce((t, x) => t + x.pl.precisa, 0);
    const nRecarga = usa.filter(x => x.pl.recarga > 0).length, nUrg = usa.filter(x => x.pl.urgente).length;
    root.innerHTML = `
      <div class="bf-datas" role="tablist" aria-label="Datas especiais">${DATAS.map(x => {
        const n = Math.round((Date.parse(`${x.dia}T12:00:00Z`) - Date.parse(`${hojeIso}T12:00:00Z`)) / 864e5);
        return `<button type="button" role="tab" aria-selected="${x.id === e.id}" class="bf-data ${x.id === e.id ? 'on' : ''}" onclick="window._bfData('${x.id}')"><b>${h(x.nome)}</b><span>${dm(x.dia)} · ${n > 0 ? `em ${n} dia${n > 1 ? 's' : ''}` : n === 0 ? 'hoje' : 'agora'}</span></button>`;
      }).join('')}</div>
      <div class="card bf-premissas">
        <div class="bf-cont"><b id="bf-cont-n">${cont.n}</b><span id="bf-cont-t">${h(cont.txt)}</span></div>
        <label class="bf-campo"><span>Aumento de gasto ${e.tipo === 'campanha' ? 'nos dias da data' : 'nos dias antes'} (${dm(e.ini)} a ${dm(FIM)})</span><div><input id="bf-semana" class="form-control" inputmode="decimal" value="${st.semana}" onchange="window._bfPremissa('semana', this.value)"><em>%</em></div></label>
        ${e.tipo === 'campanha' ? `<label class="bf-campo"><span>Aumento no dia ${dm(e.dia)}</span><div><input id="bf-dia" class="form-control" inputmode="decimal" value="${st.dia}" onchange="window._bfPremissa('dia', this.value)"><em>%</em></div></label>` : ''}
        <div class="bf-sub">Conta: gasto médio dos últimos 7 dias × ${p.normal} dia(s) normais + ${p.semana} dia(s) ${e.tipo === 'campanha' ? 'da data' : 'de compra de presente'}${e.tipo === 'campanha' ? ` + ${p.bf} dia de pico` : ''}, até ${dm(FIM)}${e.fimNome ? ` (${e.fimNome})` : ''}. Saldo lido ${st.em ? new Date(st.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}.</div>
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
              : !risco.length ? `<span class="bf-sub" style="color:var(--green)">Nenhum produto que vende acaba antes de ${dm(FIM)} no ritmo atual (com o aumento da data).</span>`
              : `<div class="bf-sub" style="margin-bottom:6px">Produtos que acabam antes de ${dm(FIM)} — venda por dia atual × os mesmos aumentos da data:</div>
                <table class="bf-tab bf-mini"><thead><tr><th>Produto</th><th class="n">Estoque</th><th class="n">Vende/dia</th><th class="n">Acaba em</th><th class="n">Falta até ${dm(FIM)}</th></tr></thead>
                <tbody>${risco.map(x => `<tr><td>${h(String(x.n || x.id).slice(0, 80))}</td><td class="n">${x.e}</td><td class="n">${String(x.vd).replace('.', ',')}</td><td class="n">${x.d != null ? `${String(x.d).replace('.', ',')} dia(s)` : '—'}</td><td class="n" style="font-weight:700;color:var(--red)">${x.falta} un.</td></tr>`).join('')}</tbody></table>`}</td></tr>` : ''}`;
        }).join('') || `<tr><td colspan="6" class="bf-vazio">${st.lojas.length ? 'Nenhuma loja com gasto de ADS nos últimos 7 dias.' : 'O monitor de saldo ainda não leu as lojas (roda de hora em hora). Use "Ler agora" no quadro de saldo da tela ADS Shopee.'}</td></tr>`}</tbody>
      </table></div></div>`;
  }

  window._bfPremissa = (k, v) => { const n = parseFloat(String(v).replace(',', '.')); if (!(n >= 0) || n > 1000) return; st[k] = n; salvar(kPrem(k), n); render(); };
  window._bfData = id => { st.ev = id; salvar('glr_de_sel', id); lerPremissas(); render(); };
  // o contador anda sozinho (a cada 30 s) enquanto a tela está aberta
  clearInterval(window._bfRelogio);
  window._bfRelogio = setInterval(() => {
    const n = document.getElementById('bf-cont-n'); if (!n) { clearInterval(window._bfRelogio); return; }
    const c = contador(); n.textContent = c.n; document.getElementById('bf-cont-t').textContent = c.txt;
  }, 30000);
  window._bfAbrir = id => { st.aberta = st.aberta === id ? null : id; render(); if (st.aberta) carregarSinais(id); };
  window._bfCopiar = async id => {
    const s = st.lojas.find(x => x.id === id); if (!s) return;
    if (!st.sinais[id]) await carregarSinais(id);
    const p = pesos(), txt = mensagem(s, planoDe(s, p), riscoEstoque(id, p));
    try { await navigator.clipboard.writeText(txt); st.copiado = id; render(); setTimeout(() => { if (st.copiado === id) { st.copiado = null; render(); } }, 2500); }
    catch (e) { prompt('Copie a mensagem:', txt); }
  };

  el.innerHTML = `<div class="page">
    <div class="ajuda">Escolha a data especial: o contador mostra quanto falta, e cada loja Shopee mostra quanto de saldo de ADS precisa para atravessar a data sem parar os anúncios, quanto recarregar e quais produtos acabam antes. Ajuste os aumentos de gasto conforme o plano de cada cliente; a mensagem é só copiada, para você mandar ao cliente.</div>
    <div id="bf-root"></div>
  </div>
  <style>
    .bf-sub{font-size:12px;color:var(--text-muted);line-height:1.5}
    .bf-vazio{padding:24px;text-align:center;color:var(--text-muted)}
    .bf-premissas{display:flex;gap:16px 22px;flex-wrap:wrap;align-items:flex-end;padding:16px 18px;margin-bottom:14px}
    .bf-premissas .bf-sub{flex:1 1 100%}
    .bf-datas{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:12px}
    .bf-data{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:1px;border:1px solid var(--border);background:var(--bg-surface);border-radius:10px;padding:7px 12px;cursor:pointer;font-family:inherit;color:var(--text-secondary);text-align:left}
    .bf-data b{font-size:13px;color:var(--text-primary);font-weight:650} .bf-data span{font-size:11.5px;color:var(--text-muted);font-variant-numeric:tabular-nums}
    .bf-data.on{border-color:var(--accent);background:var(--accent-glow)} .bf-data.on b{color:var(--accent-light)} .bf-data:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .bf-cont{display:flex;flex-direction:column;line-height:1.15;margin-right:8px;min-width:150px} .bf-cont b{font-size:30px;color:var(--accent);font-variant-numeric:tabular-nums} .bf-cont span{font-size:12px;color:var(--text-muted)}
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
}
Router.register('datas-especiais', paginaDatasEspeciais);
Router.register('black-friday', paginaDatasEspeciais); // endereço antigo (Plano Black Friday)
