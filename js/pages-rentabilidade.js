// ============================================================
// GLR Consultoria — Rentabilidade da carteira
// ------------------------------------------------------------
// Quanto cada cliente rende de comissão para a GLR em relação ao que fatura:
// faturamento, comissão (modelo de comissão do cliente, GLR.comissao, só nas
// contas marcadas "conta comissão"), comissão ÷ faturamento, ticket médio e
// comissão por pedido. Com uma taxa de referência (padrão: a média da carteira)
// mostra quanto cada contrato renderia a mais — base para a conversa de
// renovação. A meta de R$ 200 mil/mês fica no topo.
// Fonte: a base automática (BaseDados, glr_sync_estado resumo), a mesma da tela
// Gestores; períodos fechados até ontem. Só lê.
// ============================================================
Router.register('rentabilidade', (params, el) => {
  const R0 = v => 'R$ ' + Math.round(parseFloat(v) || 0).toLocaleString('pt-BR');
  const R2 = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v, d = 2) => v == null || !isFinite(v) ? '—' : `${(Math.round(v * 10 ** d) / 10 ** d).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch (e) { return d; } };
  const pad2 = n => String(n).padStart(2, '0');
  const isoD = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const META = 200000;
  const PERIODOS = { '30d': 'Últimos 30 dias', mes: 'Mês passado' };
  const st = { base: null, carregando: true, erro: null, periodo: lerJSON('glr_rent_periodo', '30d'), ref: lerJSON('glr_rent_ref', null), ordem: 'falta', gestor: 'todos' };
  window._rtbSt = st;

  function intervalo() {
    const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
    if (st.periodo === 'mes') { const ini = new Date(ontem.getFullYear(), ontem.getMonth() - 1, 1); return { de: isoD(ini), ate: isoD(new Date(ini.getFullYear(), ini.getMonth() + 1, 0)), dias: new Date(ini.getFullYear(), ini.getMonth() + 1, 0).getDate() }; }
    const de = new Date(ontem); de.setDate(ontem.getDate() - 29);
    return { de: isoD(de), ate: isoD(ontem), dias: 30 };
  }

  // por cliente: o mesmo recorte da tela Gestores (só contas com a base cobrindo o período)
  function linhas() {
    if (!st.base) return [];
    const { de, ate, dias } = intervalo(), escala = 30 / dias; // tudo "por mês" de 30 dias
    const vinc = lerJSON('glr_mc_vinculos', {});
    const gest = id => (GLR.gestores || []).find(g => String(g.id) === String(id))?.nome || '';
    const out = [];
    for (const c of (GLR.clientes || [])) {
      if (/inativ|cancel|encerr/i.test(String(c.status || ''))) continue;
      const r = { fat: 0, ped: 0, fatCom: 0, unidCom: 0, cobertas: 0, contas: (vinc[String(c.id)] || []).length };
      for (const ct of (vinc[String(c.id)] || [])) {
        const mkt = BaseDados.mktDe(ct.marketplace), id = String(ct.param_to_use?.shopId || ct.param_to_use?.meliUserId || ct.contaId || ct.external_id);
        const info = mkt ? st.base[BaseDados.chave(mkt, id)] : null;
        if (!info || !BaseDados.cobre(info, de)) continue;
        r.cobertas++;
        const t = BaseDados.somar(info, de, ate);
        r.fat += t.faturamento; r.ped += t.pedidos;
        if (GLR.contaGeraComissao(ct)) { r.fatCom += t.faturamento; r.unidCom += t.unidades || t.pedidos; }
      }
      if (!r.cobertas || r.fat <= 0) continue;
      const com = GLR.comissao.temComissao(c) ? GLR.comissao.estimar(c, r.unidCom * escala, r.fatCom * escala) : 0;
      const fat = r.fat * escala, ped = r.ped * escala;
      out.push({ id: String(c.id), nome: c.nome, gestor: gest(c.gestorId) || c.gestor || 'Sem gestor', modelo: GLR.comissao.temComissao(c) ? GLR.comissao.descricao(c, true) : 'sem comissão',
        fat, ped, com, taxa: fat > 0 ? com / fat * 100 : null, ticket: ped > 0 ? fat / ped : null, porPedido: ped > 0 ? com / ped : null, parcial: r.cobertas < r.contas });
    }
    return out;
  }

  async function carregar(forcar) {
    st.carregando = true; render();
    try { st.base = await BaseDados.carregar(forcar); st.erro = null; } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
    GLR.quandoClientes(render);
  }

  function render() {
    if (window._rtbSt !== st) return;
    const root = document.getElementById('rtb-root'); if (!root) return;
    if (st.carregando && !st.base) { root.innerHTML = '<div class="card rtb-vazio">Carregando a base…</div>'; return; }
    if (st.erro) { root.innerHTML = `<div class="card rtb-vazio" style="color:var(--red)">Não consegui carregar a base: ${h(st.erro)}</div>`; return; }
    const todos = linhas(), foco = GLR.ctx?.cliente();
    const totFat = todos.reduce((s, x) => s + x.fat, 0), totCom = todos.reduce((s, x) => s + x.com, 0);
    const media = totFat > 0 ? totCom / totFat * 100 : 0;
    const ref = st.ref != null ? st.ref : Math.round(media * 100) / 100;
    const falta = x => Math.max(0, x.fat * ref / 100 - x.com);
    const ls = todos.filter(x => (!foco || x.id === String(foco)) && (st.gestor === 'todos' || x.gestor === st.gestor)).map(x => ({ ...x, falta: falta(x) }));
    const ord = { falta: (a, b) => b.falta - a.falta, comissao: (a, b) => b.com - a.com, taxa: (a, b) => (a.taxa ?? -1) - (b.taxa ?? -1), fat: (a, b) => b.fat - a.fat }[st.ordem];
    ls.sort(ord);
    const top5 = todos.slice().sort((a, b) => b.com - a.com).slice(0, 5).reduce((s, x) => s + x.com, 0);
    const totFalta = todos.reduce((s, x) => s + falta(x), 0);
    const abaixoMetade = todos.filter(x => x.taxa != null && x.taxa < ref / 2).length;
    const maxTaxa = Math.max(ref * 1.6, ...ls.map(x => x.taxa || 0));
    const gestores = [...new Set(todos.map(x => x.gestor))].sort();
    const pMeta = totCom / META * 100, pExtra = Math.max(0, Math.min(100 - pMeta, totFalta / META * 100));
    const soma = k => ls.reduce((s, x) => s + x[k], 0);
    root.innerHTML = `
      <div class="rtb-meta card">
        <div class="rtb-meta-txt"><span>Comissão por mês</span><b>${R0(totCom)}</b><span>${pct(pMeta, 0)} da meta de ${R0(META)}</span></div>
        <div class="rtb-meta-barra" role="img" aria-label="${pct(pMeta, 0)} da meta"><span style="width:${Math.min(100, pMeta)}%"></span><span class="extra" style="left:${Math.min(100, pMeta)}%;width:${pExtra}%"></span></div>
        <div class="rtb-sub">Com todos os contratos em pelo menos ${pct(ref)} do faturamento, seriam <b>${R0(totCom + totFalta)}</b> por mês (+${R0(totFalta)}) — a faixa clara da barra.</div>
      </div>
      <div class="rtb-topo">
        <div class="rtb-num"><b>${R0(totFat)}</b><span>de faturamento por mês na carteira</span></div>
        <div class="rtb-num"><b>${pct(media)}</b><span>comissão média sobre o faturamento</span></div>
        <div class="rtb-num"><b>${pct(totCom > 0 ? top5 / totCom * 100 : 0, 0)}</b><span>da comissão vem dos 5 maiores clientes</span></div>
        <div class="rtb-num" style="--c:var(--red)"><b>${abaixoMetade}</b><span>cliente(s) abaixo da metade da referência</span></div>
      </div>
      <div class="rtb-ctrl">
        <div class="rtb-chips">${Object.entries(PERIODOS).map(([k, t]) => `<button class="rtb-chip ${st.periodo === k ? 'on' : ''}" onclick="window._rtbPeriodo('${k}')">${t}</button>`).join('')}</div>
        <label class="rtb-ref" for="rtb-ref">Taxa de referência <input id="rtb-ref" class="form-control" inputmode="decimal" value="${String(ref).replace('.', ',')}" onchange="window._rtbRef(this.value)"> %</label>
        ${st.ref != null ? `<button class="btn btn-ghost btn-sm" onclick="window._rtbRef('')">usar a média</button>` : '<span class="rtb-sub">(média da carteira)</span>'}
        <span style="flex:1"></span>
        <select id="rtb-gestor" class="form-control rtb-sel" aria-label="Gestor" onchange="window._rtbGestor(this.value)"><option value="todos">Todos os gestores</option>${gestores.map(g => `<option ${st.gestor === g ? 'selected' : ''}>${h(g)}</option>`).join('')}</select>
        <select id="rtb-ordem" class="form-control rtb-sel" aria-label="Ordenar" onchange="window._rtbOrdem(this.value)">${[['falta', 'Maior ganho na referência'], ['comissao', 'Maior comissão'], ['taxa', 'Menor taxa'], ['fat', 'Maior faturamento']].map(([k, t]) => `<option value="${k}" ${st.ordem === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      ${ls.length ? `<div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table class="rtb-tab" data-todas-colunas>
        <thead><tr><th>Cliente</th><th>Contrato</th><th class="n">Faturamento/mês</th><th class="n">Comissão/mês</th><th>Comissão ÷ faturamento</th><th class="n">Ticket médio</th><th class="n">Por pedido</th><th class="n">A mais em ${pct(ref)}</th></tr></thead>
        <tbody>${ls.map(x => `<tr>
          <td><button type="button" class="rtb-cli" onclick="window._rtbIr('${h(x.id)}')">${h(x.nome)}</button><small>${h(x.gestor)}${x.parcial ? ' · base parcial' : ''}</small></td>
          <td class="rtb-modelo">${h(x.modelo)}</td>
          <td class="n">${R0(x.fat)}<small>${Math.round(x.ped).toLocaleString('pt-BR')} pedidos</small></td>
          <td class="n"><b>${R0(x.com)}</b></td>
          <td><div class="rtb-taxa"><span class="rtb-bar"><span style="width:${Math.min(100, (x.taxa || 0) / maxTaxa * 100)}%;background:${(x.taxa || 0) >= ref ? 'var(--green)' : (x.taxa || 0) >= ref / 2 ? '#d98b00' : 'var(--red)'}"></span><i style="left:${ref / maxTaxa * 100}%" title="referência ${pct(ref)}"></i></span><b>${pct(x.taxa)}</b></div></td>
          <td class="n">${x.ticket ? R0(x.ticket) : '—'}</td>
          <td class="n">${x.porPedido != null ? R2(x.porPedido) : '—'}</td>
          <td class="n" style="font-weight:650;color:${x.falta > 0 ? 'var(--text-primary)' : 'var(--text-muted)'}">${x.falta > 0 ? `+${R0(x.falta)}` : '—'}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td><b>Total</b><small>${ls.length} cliente(s)</small></td><td></td><td class="n"><b>${R0(soma('fat'))}</b></td><td class="n"><b>${R0(soma('com'))}</b></td><td><b>${pct(soma('fat') > 0 ? soma('com') / soma('fat') * 100 : null)}</b></td><td></td><td></td><td class="n"><b>+${R0(soma('falta'))}</b></td></tr></tfoot>
      </table></div></div>` : '<div class="card rtb-vazio"><b>Nenhum cliente com vendas na base neste período.</b></div>'}`;
  }

  window._rtbPeriodo = k => { st.periodo = k; try { localStorage.setItem('glr_rent_periodo', JSON.stringify(k)); } catch (e) {} render(); };
  window._rtbRef = v => { const n = parseFloat(String(v).replace(',', '.')); st.ref = v === '' || !(n > 0) ? null : Math.min(20, n); try { localStorage.setItem('glr_rent_ref', JSON.stringify(st.ref)); } catch (e) {} render(); };
  window._rtbGestor = g => { st.gestor = g; render(); };
  window._rtbOrdem = o => { st.ordem = o; render(); };
  window._rtbIr = id => { GLR.ctx?.definir(id, true); Router.navigate('cliente-perfil', { id }); };

  el.innerHTML = `<div class="page">
    <div class="ajuda">Quanto cada cliente rende de comissão em relação ao que vende. A comissão segue o modelo de cada contrato e só conta as contas marcadas como "conta comissão"; a base é a mesma da tela Gestores. A taxa de referência mostra quanto cada contrato renderia a mais — use na conversa de renovação.</div>
    <div id="rtb-root"></div>
  </div>
  <style>
    .rtb-sub{font-size:12px;color:var(--text-muted);line-height:1.45}
    .rtb-vazio{padding:28px;text-align:center}
    .rtb-meta{padding:16px 18px;margin-bottom:14px;display:flex;flex-direction:column;gap:8px}
    .rtb-meta-txt{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap} .rtb-meta-txt b{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums} .rtb-meta-txt span{font-size:12.5px;color:var(--text-muted)}
    .rtb-meta-barra{position:relative;height:10px;border-radius:99px;background:var(--bg-subtle);overflow:hidden}
    .rtb-meta-barra span{position:absolute;top:0;bottom:0;left:0;background:var(--accent);border-radius:99px} .rtb-meta-barra span.extra{background:color-mix(in srgb,var(--accent) 30%,transparent);border-radius:0 99px 99px 0}
    .rtb-topo{display:flex;gap:26px;flex-wrap:wrap;margin-bottom:14px}
    .rtb-num{display:flex;flex-direction:column} .rtb-num b{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.15;color:var(--c,var(--text-primary))} .rtb-num span{font-size:12px;color:var(--text-muted)}
    .rtb-ctrl{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
    .rtb-chips{display:flex;gap:6px}
    .rtb-chip{border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);border-radius:99px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit} .rtb-chip.on{border-color:var(--accent);background:var(--accent-glow);color:var(--accent-light)}
    .rtb-ref{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-secondary)} .rtb-ref input{width:70px}
    .rtb-sel{width:auto;min-width:0;max-width:220px}
    .rtb-tab{width:100%;border-collapse:collapse;font-size:13px}
    .rtb-tab th{padding:9px 12px;text-align:left;font-size:11.5px;font-weight:600;color:var(--text-muted);background:var(--bg-card-hover);white-space:nowrap}
    .rtb-tab td{padding:9px 12px;border-top:1px solid var(--border);vertical-align:middle} .rtb-tab tfoot td{background:var(--bg-subtle)}
    .rtb-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums} .rtb-tab td small{display:block;font-size:11.5px;color:var(--text-muted);font-weight:400}
    .rtb-cli{border:0;background:none;padding:0;font:inherit;font-weight:650;color:var(--text-primary);cursor:pointer;text-align:left} .rtb-cli:hover{color:var(--accent)} .rtb-cli:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .rtb-modelo{font-size:12px;color:var(--text-secondary);max-width:200px}
    .rtb-taxa{display:flex;align-items:center;gap:8px;min-width:170px} .rtb-taxa b{font-variant-numeric:tabular-nums;font-weight:650;min-width:52px;text-align:right}
    .rtb-bar{position:relative;flex:1;height:8px;border-radius:99px;background:var(--bg-subtle)} .rtb-bar > span{position:absolute;left:0;top:0;bottom:0;border-radius:99px}
    .rtb-bar i{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--text-secondary);border-radius:1px}
  </style>`;
  carregar();
  // a base atualiza a cada 15 min: recarrega a tela se ela estiver aberta
  window.removeEventListener('glr-base-atualizada', window._rtbAtualizar || (() => {}));
  window._rtbAtualizar = () => { if (window._rtbSt === st && document.getElementById('rtb-root')) carregar(true); };
  window.addEventListener('glr-base-atualizada', window._rtbAtualizar);
});
