// ============================================================
// GLR Consultoria — Data combinada (11.11, 12.12, Black Friday…)
// ------------------------------------------------------------
// O acompanhamento do dia de campanha combinado com os clientes, no formato da
// planilha "Data Combinada": por cliente e por loja, a meta do dia (digitada
// aqui), o faturamento do dia, % da meta, quanto falta, o ADS do dia, o % de ADS
// sobre o faturamento e os pedidos. Faturamento, ADS e pedidos vêm da base
// automática (BaseDados — a mesma do Dashboard: sem cancelados, atualiza a cada
// 15 min); no próprio dia, os números são parciais.
// Metas: glr_metas_data_combinada = { 'AAAA-MM-DD': { 'mkt:conta': valor } },
// sincronizada com a equipe (js/supabase-init.js → GLR_KEYS).
// Semáforo da coluna "% sobre meta" de cada loja: glr_dc_semaforo =
// { limites: [20, 35, 45], cores: [vermelho, amarelo, intermediária, verde] } — editável na tela
// (botão "Semáforo"), também sincronizado com a equipe.
// O score de saúde das lojas fica na página própria Score da operação
// (js/pages-score-operacao.js), não aqui.
// ============================================================
Router.register('data-combinada', (params, el) => {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const R$ = v => v == null || !isFinite(v) ? '—' : 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = v => v == null || !isFinite(v) ? '—' : `${(+v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (e) { return d; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const K_METAS = 'glr_metas_data_combinada', K_SEL = 'glr_dc_sel', K_SEM = 'glr_dc_semaforo';
  // Meta sugerida do dia de campanha = faturamento médio por dia no mês (do dia 1 até a véspera) × este fator.
  // Black Friday 2026 começou com 3 e passou para 2,5 em 27/11/2026. Para mudar a regra, troque só este número.
  const FATOR_META_CAMPANHA = 2.5;
  // semáforo padrão: < 20% vermelho, < 35% amarelo, 35–45% amarelo (faixa intermediária), ≥ 45% verde
  const SEM_PADRAO = { limites: [20, 35, 45], cores: ['#ef4444', '#facc15', '#facc15', '#22c55e'] };
  const lerSemaforo = () => {
    const s = lerJSON(K_SEM, null) || {}, hex = c => /^#[0-9a-f]{6}$/i.test(String(c || ''));
    const lim = Array.isArray(s.limites) && s.limites.length === 3 && s.limites.every(v => isFinite(parseFloat(v))) ? s.limites.map(Number) : SEM_PADRAO.limites;
    const cores = Array.isArray(s.cores) && s.cores.length === 4 && s.cores.every(hex) ? s.cores : SEM_PADRAO.cores;
    return { limites: lim, cores };
  };
  // cor de fundo da faixa em que a % cai (null = sem % para colorir)
  const corSemaforo = (p, sem) => {
    if (p == null || !isFinite(p)) return null;
    const [l1, l2, l3] = sem.limites;
    return p < l1 ? sem.cores[0] : p < l2 ? sem.cores[1] : p < l3 ? sem.cores[2] : sem.cores[3];
  };
  // texto legível sobre a cor de fundo (preto em cores claras, branco nas escuras)
  const textoSobre = hex => {
    const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? '#111827' : '#ffffff';
  };
  const hojeIso = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const dm = iso => iso.split('-').reverse().slice(0, 2).join('/');
  const fimDoMes = iso => { const [a, m] = iso.split('-').map(Number); return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); };
  // próxima data "dupla" (11.11, 12.12…): hoje, se for uma; senão a próxima
  const proximaDupla = () => {
    const [a, m, d] = hojeIso.split('-').map(Number);
    if (m === d) return hojeIso;
    const mm = d < m ? m : m + 1, ano = mm > 12 ? a + 1 : a, mes = mm > 12 ? 1 : mm;
    return `${ano}-${String(mes).padStart(2, '0')}-${String(mes).padStart(2, '0')}`;
  };
  const MKT = { ml: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', tiktok: 'TikTok', magalu: 'Magalu', shein: 'Shein' };
  const sel = lerJSON(K_SEL, {});
  const st = { dia: sel.dia || proximaDupla(), gestor: sel.gestor || 'todos', base: null, erro: null, carregando: true };
  const guardarSel = () => gravar(K_SEL, { dia: st.dia, gestor: st.gestor });

  async function carregar(forcar) {
    st.carregando = true; render();
    try { st.base = await BaseDados.carregar(forcar); st.erro = null; } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  // clientes → lojas, com a meta e os números do dia
  function montar() {
    const vinc = lerJSON('glr_mc_vinculos', {}), metas = (lerJSON(K_METAS, {}) || {})[st.dia] || {};
    const metasMes = lerJSON('glr_metas', {}) || {}; // meta do mês por cliente (a mesma da Meta diária e do Plano de ação)
    const mesIni = st.dia.slice(0, 8) + '01';
    const vespera = new Date(Date.parse(st.dia + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
    const diasAntes = vespera >= mesIni && vespera < hojeIso ? Number(vespera.slice(8)) : 0; // dias completos do mês antes da data
    const mesAte = st.dia.slice(0, 7) === hojeIso.slice(0, 7) ? hojeIso : (st.dia < hojeIso ? fimDoMes(st.dia) : null);
    const gestores = GLR.gestores || [];
    const out = [];
    for (const c of (GLR.clientes || [])) {
      if (/inativ|cancel|encerr/i.test(String(c.status || ''))) continue;
      const foco = GLR.ctx?.cliente?.(); if (foco && String(c.id) !== foco) continue; // cliente em foco (barra de cima)
      const g = gestores.find(x => String(x.id) === String(c.gestorId));
      const gestorId = g ? String(g.id) : 'sem';
      if (!foco && st.gestor !== 'todos' && st.gestor !== gestorId) continue; // com cliente em foco, o filtro de gestor não vale
      const lojas = [];
      for (const ct of (vinc[String(c.id)] || [])) {
        const mkt = BaseDados.mktDe(ct.marketplace); if (!mkt) continue;
        const p = ct.param_to_use || {};
        const id = String(p.shopId || p.meliUserId || p.amazon_account_id || p.magalu_account_id || p.shein_supplier_id || ct.contaId || ct.external_id);
        const info = st.base ? (st.base[BaseDados.chave(mkt, id)] || st.base[BaseDados.chave(mkt, ct.external_id)]) : null;
        const cobre = st.dia <= hojeIso && !!(info && BaseDados.cobre(info, st.dia)); // data futura: ainda sem faturamento
        const t = cobre ? BaseDados.somar(info, st.dia, st.dia) : null;
        const temAds = !!(info && BaseDados.cobreAds(info, st.dia));
        const nome = String(GLR.nomeConta(mkt, id) || id).replace(new RegExp(`^${String(c.nome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · `), '');
        const chave = `${mkt}:${id}`, meta = parseFloat(metas[chave]) || 0;
        const cobreMes = !!(mesAte && info && BaseDados.cobre(info, mesIni));
        const fatMes = cobreMes ? BaseDados.somar(info, mesIni, mesAte).faturamento : null;
        const media = diasAntes && info && BaseDados.cobre(info, mesIni) ? BaseDados.somar(info, mesIni, vespera).faturamento / diasAntes : null;
        lojas.push({ chave, mkt, nome, meta, cobre, fatMes, media, fat: t ? t.faturamento : null, ads: t && temAds ? t.ads : null, pedidos: t ? t.pedidos : null });
      }
      if (!lojas.length) continue;
      const soma = k => lojas.reduce((s, l) => s + (l[k] || 0), 0);
      // quanto falta para a meta do mês, em % (faturado no mês até hoje; no próprio dia, parcial)
      const metaMes = parseFloat(metasMes[c.id] ?? metasMes[String(c.id)]) || parseFloat(c.metaMensal) || 0;
      const fatMes = lojas.every(l => l.fatMes != null) ? soma('fatMes') : null;
      const faltaMesPct = metaMes > 0 && fatMes != null ? Math.max(0, metaMes - fatMes) / metaMes * 100 : null;
      out.push({ id: String(c.id), nome: c.nome, gestor: g?.nome || 'Sem gestor', lojas, metaMes, fatMes, faltaMesPct, meta: soma('meta'), fat: soma('fat'), ads: soma('ads'), pedidos: soma('pedidos') });
    }
    return out.sort((a, b) => b.meta - a.meta || a.nome.localeCompare(b.nome));
  }

  // meta digitada em reais: mostra "25.000,00"; aceita "25000", "25.000", "25.000,50" ou "25000.5"
  const moeda = v => (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lerMoeda = v => {
    let t = String(v || '').replace(/[^\d,.]/g, '');
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');           // padrão brasileiro: 25.000,50
    else if ((t.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(t)) t = t.replace(/\./g, ''); // 25.000 = vinte e cinco mil
    const n = parseFloat(t); return isFinite(n) ? n : 0;
  };
  const corMeta = p => p == null ? 'var(--text-muted)' : p >= 100 ? 'var(--green)' : p >= 80 ? 'var(--yellow)' : 'var(--red)';
  function linha(l, cli, sem) {
    const p = l.meta > 0 && l.fat != null ? l.fat / l.meta * 100 : null, falta = l.meta > 0 && l.fat != null ? Math.max(0, l.meta - l.fat) : null;
    const pa = l.fat > 0 && l.ads != null ? l.ads / l.fat * 100 : (l.ads > 0 ? Infinity : null);
    return `<tr>
      <td>${h(MKT[l.mkt] || l.mkt)}</td>
      <td class="dc-loja" title="${h(l.nome)}">${h(l.nome)}</td>
      <td class="num"><label class="dc-meta"><span>R$</span><input type="text" inputmode="decimal" value="${l.meta ? moeda(l.meta) : ''}" placeholder="0,00" onfocus="this.select()" onkeydown="if(event.key==='Enter')this.blur()" aria-label="Meta de ${h(cli)} — ${h(l.nome)} em ${dm(st.dia)}" onchange="window._dcMeta('${h(l.chave)}', this.value)"></label></td>
      <td class="num">${l.cobre ? R$(l.fat) : st.dia > hojeIso ? '—' : '<span class="dc-mut" title="A base automática ainda não tem este dia desta loja">sem dados</span>'}</td>
      ${(() => { const cor = corSemaforo(p, sem); return cor
        ? `<td class="num dc-sem" style="background:${cor};color:${textoSobre(cor)}">${pct(p)}</td>`
        : `<td class="num" style="color:${corMeta(p)};font-weight:700">${pct(p)}</td>`; })()}
      <td class="num">${falta == null ? '—' : falta === 0 ? '<span style="color:var(--green);font-weight:700">bateu</span>' : R$(falta)}</td>
      <td class="num">${l.ads == null ? '—' : R$(l.ads)}</td>
      <td class="num">${pa === Infinity ? '∞' : pct(pa)}</td>
      <td class="num">${l.pedidos == null ? '—' : Math.round(l.pedidos).toLocaleString('pt-BR')}</td>
    </tr>`;
  }

  // "Falta X% da meta do mês" ao lado dos totais do cliente
  function faltaMes(c) {
    if (!(c.metaMes > 0)) return '<span class="dc-mut" title="Cliente sem meta do mês cadastrada">Sem meta do mês</span>';
    if (c.faltaMesPct == null) return `<span class="dc-mut" title="A base automática não tem o mês inteiro de todas as lojas">Meta do mês ${R$(c.metaMes)}</span>`;
    const t = `Meta do mês ${R$(c.metaMes)} · faturado no mês ${R$(c.fatMes)}`;
    return c.faltaMesPct === 0
      ? `<span title="${h(t)}" style="color:var(--green)"><b style="color:inherit">Bateu a meta do mês</b></span>`
      : `<span title="${h(t)}">Falta p/ meta do mês <b style="color:${corMeta(100 - c.faltaMesPct)}">${pct(c.faltaMesPct)}</b></span>`;
  }

  function render() {
    const root = el.querySelector('#dc-root'); if (!root) return;
    const focado = document.activeElement?.closest?.('.dc-meta') ? document.activeElement.getAttribute('aria-label') : null;
    if (!st.base && st.carregando) { root.innerHTML = '<div class="card dc-vazio">Carregando a base automática…</div>'; return; }
    const clientes = montar(), sem = lerSemaforo();
    const T = clientes.reduce((s, c) => ({ meta: s.meta + c.meta, fat: s.fat + c.fat, ads: s.ads + c.ads, pedidos: s.pedidos + c.pedidos }), { meta: 0, fat: 0, ads: 0, pedidos: 0 });
    const pT = T.meta > 0 ? T.fat / T.meta * 100 : null;
    const datasSalvas = Object.entries(lerJSON(K_METAS, {}) || {}).filter(([, m]) => Object.values(m || {}).some(v => parseFloat(v) > 0)).map(([d]) => d).sort().slice(-8);
    const parcial = st.dia === hojeIso ? ' · hoje, parcial (atualiza a cada 15 min)' : st.dia > hojeIso ? ' · data futura: o faturamento entra no dia' : '';
    root.innerHTML = `
      ${st.erro ? `<div class="card dc-aviso">Não consegui ler a base automática: ${h(st.erro)}</div>` : ''}
      <div class="dc-resumo card">
        <div><span>Meta do dia</span><b>${R$(T.meta)}</b></div>
        <div><span>Faturamento ${dm(st.dia)}</span><b>${R$(T.fat)}</b></div>
        <div><span>% sobre a meta</span><b style="color:${corMeta(pT)}">${pct(pT)}</b></div>
        <div><span>Falta para a meta</span><b>${T.meta > 0 ? R$(Math.max(0, T.meta - T.fat)) : '—'}</b></div>
        <div><span>ADS</span><b>${R$(T.ads)}</b><small>${T.fat > 0 ? `${pct(T.ads / T.fat * 100)} do faturamento` : ''}</small></div>
        <div><span>Pedidos</span><b>${Math.round(T.pedidos).toLocaleString('pt-BR')}</b></div>
      </div>
      <div class="dc-sub">${clientes.length} cliente(s)${parcial}. Faturamento sem cancelados; ADS da Shopee inclui o GMV Max. Digite a meta de cada loja: ela fica salva para a equipe toda.</div>
      ${datasSalvas.length ? `<div class="dc-chips">Datas com meta: ${datasSalvas.map(d => `<button class="${d === st.dia ? 'on' : ''}" onclick="window._dcDia('${d}')">${dm(d)}</button>`).join('')}</div>` : ''}
      ${clientes.length ? clientes.map(c => {
        const p = c.meta > 0 ? c.fat / c.meta * 100 : null;
        return `<section class="card dc-cli">
          <div class="dc-cli-cab"><div><b>${h(c.nome)}</b><span>${h(c.gestor)}</span></div>
            <div class="dc-cli-tot"><span>Meta <b>${R$(c.meta)}</b></span><span>Faturado <b>${R$(c.fat)}</b></span><span style="color:${corMeta(p)}"><b style="color:inherit">${pct(p)}</b></span><span>Pedidos <b>${Math.round(c.pedidos).toLocaleString('pt-BR')}</b></span>${faltaMes(c)}</div></div>
          <div class="dc-scroll"><table class="dc-tab" data-todas-colunas>
            <colgroup><col style="width:11%"><col style="width:21%"><col style="width:14%"><col style="width:11%"><col style="width:9%"><col style="width:11%"><col style="width:9%"><col style="width:6%"><col style="width:7%"></colgroup>
            <thead><tr><th>Marketplace</th><th>Loja</th><th class="num">Meta</th><th class="num">Faturamento ${dm(st.dia)}</th><th class="num">% sobre meta</th><th class="num">Falta para meta</th><th class="num">ADS</th><th class="num" title="ADS ÷ faturamento do dia">% ADS</th><th class="num">Pedidos</th></tr></thead>
            <tbody>${c.lojas.map(l => linha(l, c.nome, sem)).join('')}</tbody>
          </table></div>
        </section>`;
      }).join('') : '<div class="card dc-vazio">Nenhum cliente com lojas vinculadas para este filtro.</div>'}`;
    if (focado) { const i = [...root.querySelectorAll('.dc-meta input')].find(x => x.getAttribute('aria-label') === focado); if (i) i.focus(); }
  }

  window._dcMeta = (chave, v) => {
    const todas = lerJSON(K_METAS, {}) || {}, m = todas[st.dia] || {};
    const n = lerMoeda(v);
    if (n > 0) m[chave] = Math.round(n * 100) / 100; else delete m[chave];
    todas[st.dia] = m; gravar(K_METAS, todas); render();
  };
  window._dcDia = d => { if (!/^\d{4}-\d\d-\d\d$/.test(d)) return; st.dia = d; guardarSel(); const i = el.querySelector('#dc-dia'); if (i) i.value = d; render(); };
  window._dcGestor = g => { st.gestor = g; guardarSel(); render(); };
  window._dcCopiar = async () => {
    const todas = lerJSON(K_METAS, {}) || {}, ant = Object.keys(todas).filter(d => d < st.dia && Object.keys(todas[d] || {}).length).sort().pop();
    if (!ant) { GLR.avisar('Não há uma data anterior com metas para copiar.', 'info'); return; }
    if (Object.keys(todas[st.dia] || {}).length && !(await GLR.confirmar(`Substituir as metas de ${dm(st.dia)} pelas de ${dm(ant)}?`, { perigo: true }))) return;
    todas[st.dia] = { ...todas[ant] }; gravar(K_METAS, todas); render();
  };
  // preenche a meta de cada loja na tela com a média diária do mês × FATOR_META_CAMPANHA
  window._dcCalcular = async () => {
    const lojas = montar().flatMap(c => c.lojas).filter(l => l.media > 0);
    if (!lojas.length) { GLR.avisar('Sem faturamento do mês antes desta data para calcular a média.', 'info'); return; }
    const fator = FATOR_META_CAMPANHA.toLocaleString('pt-BR');
    if (!(await GLR.confirmar(`Calcular a meta de ${lojas.length} loja(s) em ${dm(st.dia)} como média diária do mês × ${fator}? As metas já digitadas dessas lojas serão substituídas.`, { perigo: true }))) return;
    const todas = lerJSON(K_METAS, {}) || {}, m = todas[st.dia] || {};
    for (const l of lojas) m[l.chave] = Math.round(l.media * FATOR_META_CAMPANHA * 100) / 100;
    todas[st.dia] = m; gravar(K_METAS, todas); render();
    GLR.avisar(`Metas de ${lojas.length} loja(s) calculadas (média × ${fator}).`, 'sucesso');
  };
  // editor do semáforo: 3 limites (%) e 4 cores, salvos para a equipe toda
  window._dcSemaforo = () => {
    const box = el.querySelector('#dc-sem-ed'); if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    const s = lerSemaforo(), [l1, l2, l3] = s.limites;
    const num = (i, v) => `<input type="number" step="0.1" min="0" class="form-input dc-sem-lim" data-i="${i}" value="${v}" aria-label="Limite ${i + 1} (%)">`;
    const cor = (i, rot) => `<label class="dc-sem-f"><input type="color" class="dc-sem-cor" data-i="${i}" value="${s.cores[i]}" aria-label="Cor: ${h(rot)}"><span>${rot}</span></label>`;
    box.innerHTML = `<div class="dc-sem-lin">${cor(0, 'Abaixo de')} ${num(0, l1)}<span>%</span></div>
      <div class="dc-sem-lin">${cor(1, 'Abaixo de')} ${num(1, l2)}<span>%</span></div>
      <div class="dc-sem-lin">${cor(2, 'Abaixo de')} ${num(2, l3)}<span>%</span></div>
      <div class="dc-sem-lin">${cor(3, 'A partir do último limite')}</div>
      <div class="dc-sem-acoes"><button class="btn btn-primary btn-sm" onclick="window._dcSemSalvar()">Salvar</button>
        <button class="btn btn-secondary btn-sm" onclick="window._dcSemPadrao()">Voltar ao padrão</button>
        <span class="dc-mut">Pinta o fundo da coluna "% sobre meta" de cada loja. Vale para a equipe toda.</span></div>`;
    box.hidden = false;
  };
  window._dcSemSalvar = () => {
    const box = el.querySelector('#dc-sem-ed'); if (!box) return;
    const lim = [...box.querySelectorAll('.dc-sem-lim')].map(i => parseFloat(String(i.value).replace(',', '.')));
    if (lim.some(v => !isFinite(v) || v < 0)) { GLR.avisar('Preencha os três limites com números.', 'erro'); return; }
    if (!(lim[0] <= lim[1] && lim[1] <= lim[2])) { GLR.avisar('Os limites precisam ir do menor para o maior.', 'erro'); return; }
    const cores = [...box.querySelectorAll('.dc-sem-cor')].map(i => i.value);
    gravar(K_SEM, { limites: lim, cores }); box.hidden = true; render();
    GLR.avisar('Semáforo salvo.', 'sucesso');
  };
  window._dcSemPadrao = () => { gravar(K_SEM, SEM_PADRAO); const box = el.querySelector('#dc-sem-ed'); if (box) box.hidden = true; render(); };
  window._dcRecarregar = () => { if (BaseDados.invalidar) BaseDados.invalidar(); carregar(true); };

  const gestores = (GLR.gestores || []).slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
  el.innerHTML = `<div class="page dc">
    <header class="dc-head">
      <div><h1>Data combinada</h1><p>Meta do dia de campanha combinado com cada cliente e quanto cada loja já faturou.</p></div>
      <div class="dc-filtros">
        <label>Data<input id="dc-dia" type="date" class="form-input" value="${st.dia}" onchange="window._dcDia(this.value)"></label>
        <label>Gestor<select class="form-input" onchange="window._dcGestor(this.value)"><option value="todos">Todos</option>${gestores.map(g => `<option value="${h(g.id)}" ${String(g.id) === st.gestor ? 'selected' : ''}>${h(g.nome)}</option>`).join('')}<option value="sem" ${st.gestor === 'sem' ? 'selected' : ''}>Sem gestor</option></select></label>
        <button class="btn btn-secondary btn-sm" onclick="window._dcCopiar()" title="Usa as metas da última data anterior que tem metas">Copiar metas da data anterior</button>
        <button class="btn btn-secondary btn-sm" onclick="window._dcCalcular()" title="Meta de cada loja na tela = faturamento médio por dia do mês, do dia 1 até a véspera, × ${FATOR_META_CAMPANHA.toLocaleString('pt-BR')}">Calcular metas (média × ${FATOR_META_CAMPANHA.toLocaleString('pt-BR')})</button>
        <button class="btn btn-secondary btn-sm" onclick="window._dcSemaforo()" title="Limites e cores do fundo da coluna % sobre meta">Semáforo</button>
        <button class="btn btn-secondary btn-sm" onclick="window._dcRecarregar()">Atualizar</button>
      </div>
    </header>
    <div id="dc-sem-ed" class="card dc-sem-ed" hidden></div>
    <div id="dc-root"></div>
  </div>
  <style>
    .dc-head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
    .dc-head h1{margin:0;font-size:22px;font-weight:650;letter-spacing:-.02em} .dc-head p{margin:4px 0 0;font-size:13px;color:var(--text-secondary)}
    .dc-filtros{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end} .dc-filtros label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)}
    .dc-resumo{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:4px;padding:14px 18px;margin-bottom:8px}
    .dc-resumo div{display:flex;flex-direction:column;gap:2px;padding:4px 10px;border-left:1px solid var(--border)} .dc-resumo div:first-child{border-left:none;padding-left:0}
    .dc-resumo span{font-size:12.5px;color:var(--text-secondary)} .dc-resumo b{font-size:19px;font-variant-numeric:tabular-nums} .dc-resumo small{font-size:11.5px;color:var(--text-muted)}
    .dc-sub{font-size:12px;color:var(--text-muted);margin:0 0 10px}
    .dc-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--text-secondary);margin-bottom:12px}
    .dc-chips button{border:1px solid var(--border);background:var(--bg-card);border-radius:99px;padding:2px 10px;font:inherit;font-size:12px;cursor:pointer;color:var(--text-secondary)} .dc-chips button.on{background:var(--text-primary);color:var(--bg-card);border-color:var(--text-primary)}
    .dc-cli{padding:0;margin-bottom:14px;overflow:hidden}
    .dc-cli-cab{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:12px 16px;background:color-mix(in srgb,var(--accent) 9%,var(--bg-card));border-bottom:1px solid var(--border)}
    .dc-cli-cab b{font-size:15px} .dc-cli-cab>div:first-child span{display:block;font-size:12px;color:var(--text-muted)}
    .dc-cli-tot{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums} .dc-cli-tot span b{color:var(--text-primary)}
    .dc-scroll{overflow-x:auto}
    .dc-tab{width:100%;min-width:1060px;table-layout:fixed;border-collapse:collapse;font-size:13px} /* mesmas colunas em todos os clientes */
    .dc-tab th{font-size:11.5px;font-weight:600;color:var(--text-secondary);text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
    .dc-tab td{padding:6px 12px;border-bottom:1px solid var(--border);white-space:nowrap;font-variant-numeric:tabular-nums}
    .dc-tab tr:last-child td{border-bottom:none}
    .dc-tab .num{text-align:right} .dc-tab th.num{text-align:right} .dc-loja{font-weight:600;overflow:hidden;text-overflow:ellipsis}
    .dc-meta{display:flex;align-items:center;gap:4px;justify-content:flex-end} .dc-meta span{font-size:12px;color:var(--text-muted)}
    .dc-meta input{width:100%;max-width:120px;min-width:0;text-align:right;font:inherit;font-variant-numeric:tabular-nums;border:1px solid var(--border);border-radius:8px;padding:4px 8px;background:var(--bg-card);color:var(--text-primary)}
    .dc-meta input:focus-visible{outline:2px solid var(--accent);outline-offset:0}
    .dc-tab td.dc-sem{font-weight:700}
    .dc-sem-ed{display:flex;flex-direction:column;gap:8px;padding:12px 16px;margin-bottom:12px;font-size:13px}
    .dc-sem-lin{display:flex;align-items:center;gap:8px} .dc-sem-f{display:flex;align-items:center;gap:8px;min-width:190px}
    .dc-sem-f input[type=color]{width:34px;height:26px;padding:0;border:1px solid var(--border);border-radius:6px;background:none;cursor:pointer}
    .dc-sem-lim{width:90px} .dc-sem-acoes{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px}
    .dc-mut{font-size:12px;color:var(--text-muted)} .dc-vazio{padding:28px;text-align:center;color:var(--text-secondary)} .dc-aviso{padding:10px 14px;color:var(--red);margin-bottom:10px}
  </style>`;
  carregar();
  if (GLR.quandoClientes) GLR.quandoClientes(() => render());
  window.addEventListener('glr-base-atualizada', () => { if (el.querySelector('#dc-root')) carregar(true); });
});
