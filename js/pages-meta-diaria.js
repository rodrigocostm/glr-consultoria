// ============================================================
// GLR Consultoria — Meta diária
// ------------------------------------------------------------
// O mesmo formato da Data combinada, para o dia a dia: a meta do mês de cada
// cliente (glr_metas — a mesma da Projeção, do Plano de ação e dos Gestores)
// vira meta do dia, e cada loja recebe a parte dela pela participação no
// faturamento dos últimos 30 dias. Mostra se o dia está batendo, quanto falta,
// o ADS do dia, o % de ADS e os pedidos, e o "necessário por dia" para fechar
// o mês na meta (o que falta ÷ dias que restam, contando o dia escolhido).
// Faturamento, ADS e pedidos vêm da base automática (sem cancelados).
// ============================================================
Router.register('meta-diaria', (params, el) => {
  const h = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const R$ = v => v == null || !isFinite(v) ? '—' : 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = v => v == null || !isFinite(v) ? '—' : `${(+v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const moeda = v => (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lerMoeda = v => { let t = String(v || '').replace(/[^\d,.]/g, ''); if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); else if ((t.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(t)) t = t.replace(/\./g, ''); const n = parseFloat(t); return isFinite(n) ? n : 0; };
  const lerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (e) { return d; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const hojeIso = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const somaDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dm = iso => iso.split('-').reverse().slice(0, 2).join('/');
  const MKT = { ml: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', tiktok: 'TikTok', magalu: 'Magalu', shein: 'Shein' };
  const sel = lerJSON('glr_md_sel', {});
  const st = { dia: hojeIso, gestor: sel.gestor || 'todos', base: null, erro: null, carregando: true };

  async function carregar(forcar) {
    st.carregando = true; render();
    try { st.base = await BaseDados.carregar(forcar); st.erro = null; } catch (e) { st.erro = e.message || String(e); }
    st.carregando = false; render();
  }

  function montar() {
    const vinc = lerJSON('glr_mc_vinculos', {}), metas = lerJSON('glr_metas', {}) || {};
    const ano = +st.dia.slice(0, 4), mes = +st.dia.slice(5, 7), dia = +st.dia.slice(8, 10);
    const diasMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate(), mesIni = st.dia.slice(0, 8) + '01', ontem = somaDias(st.dia, -1);
    const de30 = somaDias(st.dia, -30);
    const out = [];
    for (const c of (GLR.clientes || [])) {
      if (/inativ|cancel|encerr/i.test(String(c.status || ''))) continue;
      const g = (GLR.gestores || []).find(x => String(x.id) === String(c.gestorId));
      if (st.gestor !== 'todos' && st.gestor !== (g ? String(g.id) : 'sem')) continue;
      const lojas = [];
      for (const ct of (vinc[String(c.id)] || [])) {
        const mkt = BaseDados.mktDe(ct.marketplace); if (!mkt) continue;
        const p = ct.param_to_use || {};
        const id = String(p.shopId || p.meliUserId || p.amazon_account_id || p.magalu_account_id || p.shein_supplier_id || ct.contaId || ct.external_id);
        const info = st.base ? (st.base[BaseDados.chave(mkt, id)] || st.base[BaseDados.chave(mkt, ct.external_id)]) : null;
        const cobre = !!(info && BaseDados.cobre(info, st.dia));
        const t = cobre ? BaseDados.somar(info, st.dia, st.dia) : null;
        const ref = info ? BaseDados.somar(info, de30, ontem).faturamento : 0;      // participação: últimos 30 dias
        const mesAteOntem = info && dia > 1 ? BaseDados.somar(info, mesIni, ontem).faturamento : 0;
        const nome = String(GLR.nomeConta(mkt, id) || id).replace(new RegExp(`^${String(c.nome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · `), '');
        lojas.push({ mkt, nome, cobre, ref, mesAteOntem, fat: t ? t.faturamento : null, ads: t && BaseDados.cobreAds(info, st.dia) ? t.ads : null, pedidos: t ? t.pedidos : null });
      }
      if (!lojas.length) continue;
      const metaMes = parseFloat(metas[c.id] ?? metas[String(c.id)]) || parseFloat(c.metaMensal) || 0;
      const metaDia = metaMes / diasMes;
      const refTot = lojas.reduce((s, l) => s + l.ref, 0);
      lojas.forEach(l => { l.meta = metaDia * (refTot > 0 ? l.ref / refTot : 1 / lojas.length); });
      const soma = k => lojas.reduce((s, l) => s + (l[k] || 0), 0);
      const mesAteOntem = soma('mesAteOntem'), restam = diasMes - dia + 1;
      const necessario = metaMes > 0 ? Math.max(0, metaMes - mesAteOntem) / restam : 0;
      out.push({ id: String(c.id), nome: c.nome, gestor: g?.nome || 'Sem gestor', lojas, metaMes, metaDia, necessario, mesAteOntem, metaAteOntem: metaDia * (dia - 1), fat: soma('fat'), ads: soma('ads'), pedidos: soma('pedidos') });
    }
    return out.sort((a, b) => b.metaMes - a.metaMes || a.nome.localeCompare(b.nome));
  }

  const cor = p => p == null ? 'var(--text-muted)' : p >= 100 ? 'var(--green)' : p >= 80 ? 'var(--yellow)' : 'var(--red)';
  function linha(l) {
    const p = l.meta > 0 && l.fat != null ? l.fat / l.meta * 100 : null, falta = l.meta > 0 && l.fat != null ? Math.max(0, l.meta - l.fat) : null;
    const pa = l.fat > 0 && l.ads != null ? l.ads / l.fat * 100 : (l.ads > 0 ? Infinity : null);
    return `<tr><td>${h(MKT[l.mkt] || l.mkt)}</td><td class="md-loja" title="${h(l.nome)}">${h(l.nome)}</td>
      <td class="num">${l.meta > 0 ? R$(l.meta) : '—'}</td>
      <td class="num">${l.cobre ? R$(l.fat) : '<span class="md-mut">sem dados</span>'}</td>
      <td class="num" style="color:${cor(p)};font-weight:700">${pct(p)}</td>
      <td class="num">${falta == null ? '—' : falta === 0 ? '<span style="color:var(--green);font-weight:700">bateu</span>' : R$(falta)}</td>
      <td class="num">${R$(l.ads)}</td><td class="num">${pa === Infinity ? '∞' : pct(pa)}</td>
      <td class="num">${l.pedidos == null ? '—' : Math.round(l.pedidos).toLocaleString('pt-BR')}</td></tr>`;
  }

  function render() {
    const root = el.querySelector('#md-root'); if (!root) return;
    const focado = document.activeElement?.closest?.('.md-metames') ? document.activeElement.dataset.cli : null;
    if (!st.base && st.carregando) { root.innerHTML = '<div class="card md-vazio">Carregando a base automática…</div>'; return; }
    const cs = montar(), comMeta = cs.filter(c => c.metaMes > 0);
    const T = comMeta.reduce((s, c) => ({ meta: s.meta + c.metaDia, nec: s.nec + c.necessario, fat: s.fat + c.fat, ads: s.ads + c.ads, ped: s.ped + c.pedidos }), { meta: 0, nec: 0, fat: 0, ads: 0, ped: 0 });
    const pT = T.meta > 0 ? T.fat / T.meta * 100 : null, batendo = comMeta.filter(c => c.fat >= c.metaDia).length;
    const parcial = st.dia === hojeIso ? 'hoje, parcial (atualiza a cada 15 min)' : 'dia fechado';
    root.innerHTML = `
      ${st.erro ? `<div class="card md-aviso">Não consegui ler a base automática: ${h(st.erro)}</div>` : ''}
      <div class="md-resumo card">
        <div><span>Meta do dia</span><b>${R$(T.meta)}</b><small>${comMeta.length} cliente(s) com meta</small></div>
        <div><span>Faturamento ${dm(st.dia)}</span><b>${R$(T.fat)}</b><small>${parcial}</small></div>
        <div><span>% da meta do dia</span><b style="color:${cor(pT)}">${pct(pT)}</b><small>${batendo} de ${comMeta.length} batendo</small></div>
        <div><span>Necessário por dia</span><b>${R$(T.nec)}</b><small>para fechar o mês na meta</small></div>
        <div><span>ADS do dia</span><b>${R$(T.ads)}</b><small>${T.fat > 0 ? `${pct(T.ads / T.fat * 100)} do faturamento` : ''}</small></div>
        <div><span>Pedidos</span><b>${Math.round(T.ped).toLocaleString('pt-BR')}</b></div>
      </div>
      <div class="md-sub">Meta do dia = meta do mês ÷ dias do mês; cada loja recebe a parte dela pela participação no faturamento dos últimos 30 dias. "Necessário por dia" = o que falta da meta do mês ÷ dias que restam, contando ${dm(st.dia)}. A meta do mês é a mesma da Projeção e do Plano de ação.</div>
      ${cs.length ? cs.map(c => {
        const p = c.metaDia > 0 ? c.fat / c.metaDia * 100 : null, pm = c.metaAteOntem > 0 ? c.mesAteOntem / c.metaAteOntem * 100 : null;
        return `<section class="card md-cli">
          <div class="md-cli-cab"><div><b>${h(c.nome)}</b><span>${h(c.gestor)}</span></div>
            <div class="md-cli-tot">
              <label class="md-metames" title="Meta de faturamento do mês (a mesma da Projeção e do Plano de ação)">Meta do mês <span>R$</span><input type="text" inputmode="decimal" data-cli="${h(c.id)}" value="${c.metaMes ? moeda(c.metaMes) : ''}" placeholder="0,00" onfocus="this.select()" onkeydown="if(event.key==='Enter')this.blur()" onchange="window._mdMetaMes('${h(c.id)}', this.value)"></label>
              <span>Meta do dia <b>${c.metaDia ? R$(c.metaDia) : '—'}</b></span>
              <span>Necessário/dia <b style="color:${c.metaMes && c.necessario > c.metaDia * 1.05 ? 'var(--red)' : 'inherit'}">${c.metaMes ? R$(c.necessario) : '—'}</b></span>
              <span>No dia <b style="color:${cor(p)}">${pct(p)}</b></span>
              <span title="faturado no mês até o dia anterior × meta proporcional">Mês até ontem <b style="color:${cor(pm)}">${pct(pm)}</b></span>
            </div></div>
          <div class="md-scroll"><table class="md-tab" data-todas-colunas>
            <colgroup><col style="width:11%"><col style="width:21%"><col style="width:12%"><col style="width:12%"><col style="width:9%"><col style="width:11%"><col style="width:10%"><col style="width:7%"><col style="width:7%"></colgroup>
            <thead><tr><th>Marketplace</th><th>Loja</th><th class="num">Meta do dia</th><th class="num">Faturamento ${dm(st.dia)}</th><th class="num">% da meta</th><th class="num">Falta</th><th class="num">ADS</th><th class="num">% ADS</th><th class="num">Pedidos</th></tr></thead>
            <tbody>${c.lojas.map(linha).join('')}</tbody>
          </table></div>
        </section>`;
      }).join('') : '<div class="card md-vazio">Nenhum cliente com lojas vinculadas para este filtro.</div>'}`;
    if (focado) { const i = root.querySelector(`.md-metames input[data-cli="${focado}"]`); if (i) i.focus(); }
  }

  window._mdMetaMes = (cid, v) => { const m = lerJSON('glr_metas', {}) || {}, n = lerMoeda(v); if (n > 0) m[cid] = n; else delete m[cid]; gravar('glr_metas', m); render(); };
  window._mdDia = d => { if (!/^\d{4}-\d\d-\d\d$/.test(d)) return; st.dia = d; render(); };
  window._mdGestor = g => { st.gestor = g; gravar('glr_md_sel', { gestor: g }); render(); };
  window._mdRecarregar = () => { if (BaseDados.invalidar) BaseDados.invalidar(); carregar(true); };

  const gestores = (GLR.gestores || []).slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
  el.innerHTML = `<div class="page md">
    <header class="md-head">
      <div><h1>Meta diária</h1><p>A meta do mês de cada cliente dividida em meta do dia, por loja: está batendo? Com ADS e pedidos.</p></div>
      <div class="md-filtros">
        <label>Dia<input type="date" class="form-input" value="${st.dia}" max="${hojeIso}" onchange="window._mdDia(this.value)"></label>
        <label>Gestor<select class="form-input" onchange="window._mdGestor(this.value)"><option value="todos">Todos</option>${gestores.map(g => `<option value="${h(g.id)}" ${String(g.id) === st.gestor ? 'selected' : ''}>${h(g.nome)}</option>`).join('')}<option value="sem" ${st.gestor === 'sem' ? 'selected' : ''}>Sem gestor</option></select></label>
        <button class="btn btn-secondary btn-sm" onclick="window._mdRecarregar()">Atualizar</button>
      </div>
    </header>
    <div id="md-root"></div>
  </div>
  <style>
    .md-head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
    .md-head h1{margin:0;font-size:22px;font-weight:650;letter-spacing:-.02em} .md-head p{margin:4px 0 0;font-size:13px;color:var(--text-secondary)}
    .md-filtros{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end} .md-filtros label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)}
    .md-resumo{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:4px;padding:14px 18px;margin-bottom:8px}
    .md-resumo div{display:flex;flex-direction:column;gap:2px;padding:4px 10px;border-left:1px solid var(--border)} .md-resumo div:first-child{border-left:none;padding-left:0}
    .md-resumo span{font-size:12.5px;color:var(--text-secondary)} .md-resumo b{font-size:19px;font-variant-numeric:tabular-nums} .md-resumo small{font-size:11.5px;color:var(--text-muted)}
    .md-sub{font-size:12px;color:var(--text-muted);margin:0 0 12px;max-width:110ch}
    .md-cli{padding:0;margin-bottom:14px;overflow:hidden}
    .md-cli-cab{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:12px 16px;background:color-mix(in srgb,var(--accent) 9%,var(--bg-card));border-bottom:1px solid var(--border)}
    .md-cli-cab b{font-size:15px} .md-cli-cab>div:first-child span{display:block;font-size:12px;color:var(--text-muted)}
    .md-cli-tot{display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums} .md-cli-tot b{font-size:13px;color:var(--text-primary)}
    .md-metames{display:inline-flex;align-items:center;gap:4px} .md-metames span{font-size:12px;color:var(--text-muted)}
    .md-metames input{width:120px;text-align:right;font:inherit;font-variant-numeric:tabular-nums;border:1px solid var(--border);border-radius:8px;padding:3px 8px;background:var(--bg-card);color:var(--text-primary)}
    .md-metames input:focus-visible{outline:2px solid var(--accent);outline-offset:0}
    .md-scroll{overflow-x:auto}
    .md-tab{width:100%;min-width:980px;table-layout:fixed;border-collapse:collapse;font-size:13px}
    .md-tab th{font-size:11.5px;font-weight:600;color:var(--text-secondary);text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
    .md-tab td{padding:7px 12px;border-bottom:1px solid var(--border);white-space:nowrap;font-variant-numeric:tabular-nums} .md-tab tr:last-child td{border-bottom:none}
    .md-tab .num,.md-tab th.num{text-align:right} .md-loja{font-weight:600;overflow:hidden;text-overflow:ellipsis}
    .md-mut{font-size:12px;color:var(--text-muted)} .md-vazio{padding:28px;text-align:center;color:var(--text-secondary)} .md-aviso{padding:10px 14px;color:var(--red);margin-bottom:10px}
  </style>`;
  carregar();
  if (GLR.quandoClientes) GLR.quandoClientes(() => render());
  window.addEventListener('glr-base-atualizada', () => { if (el.querySelector('#md-root')) carregar(true); });
});
