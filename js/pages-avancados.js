// ============================================================
// GLR Consultoria — Oportunidades, Alertas, Projeção, Relatórios, IA
// ============================================================

// ── Performance de Gestores ──────────────────────────────────
Router.register('performance', (params, el) => {

  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                 'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const hoje   = new Date();

  function fmtR(v) { return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0}).format(v||0); }
  function fmtPct(v) { return (v >= 0 ? '+' : '') + (v||0).toFixed(1) + '%'; }

  // Carrega dados
  let projecoes = [], dres = [];
  try { projecoes = JSON.parse(localStorage.getItem('glr_projecoes') || '[]'); } catch(e) {}
  try { dres      = JSON.parse(localStorage.getItem('glr_dre')       || '[]'); } catch(e) {}

  // Lista de gestores — apenas os que têm pelo menos 1 cliente
  const nomesGestores = [...new Set(GLR.clientes.map(c => c.gestor).filter(Boolean))];
  const gestoresAtivos = nomesGestores.map(nome => {
    const g = GLR.gestores.find(x => x.nome === nome);
    return g || { nome };
  });

  // Função que calcula todos os dados de um cliente
  function dadosCliente(c) {
    const proj  = projecoes.find(p => parseInt(p.chave) === c.id);
    const plats = proj?.plataformas || [];
    const dd    = Math.max(parseInt(proj?.diasDecorridos) || 1, 1);
    const dm    = Math.max(parseInt(proj?.diasNoMes)      || 30, 1);
    const calcP = base => base ? (parseFloat(base) / dd) * dm : 0;

    // Bases manuais (o que foi inserido)
    const fatBase  = plats.reduce((s,p) => s + (parseFloat(p.fatBase)  || 0), 0);
    const adsBase  = plats.reduce((s,p) => s + (parseFloat(p.adsBase)  || 0), 0);
    const pctADSBase = fatBase > 0 ? (adsBase / fatBase) * 100 : 0;

    // Projeção calculada (extrapolada para o mês)
    const fatProj  = plats.reduce((s,p) => s + calcP(p.fatBase),  0);
    const adsProj  = plats.reduce((s,p) => s + calcP(p.adsBase),  0);
    const pctADSProj = fatProj > 0 ? (adsProj / fatProj) * 100 : 0;

    // Real do mês atual (DRE)
    const dresMes = dres.filter(d =>
      parseInt(d.clienteId) === c.id &&
      d.mes === hoje.getMonth() &&
      d.ano === hoje.getFullYear()
    );
    const fatReal = dresMes.reduce((s,d) => s + (parseFloat(d.valores?.faturamento) || 0), 0);
    const adsReal = dresMes.reduce((s,d) => s + (parseFloat(d.valores?.ads)         || 0), 0);

    // Meses anteriores do historico
    function fatMesOffset(offset) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - offset, 1);
      const nomeMes = meses[d.getMonth()] + ' ' + d.getFullYear();
      const h = (c.historico || []).find(x => x.mes === nomeMes);
      return h ? parseFloat(h.faturamento) || 0 : 0;
    }
    const fatM1 = fatMesOffset(1); // mês anterior
    const fatM2 = fatMesOffset(2);
    const fatM3 = fatMesOffset(3);

    // Referência de comparação: real se existir, senão projeção
    const fatRef = fatReal || fatProj;

    // Falta para meta
    const faltaMeta = fatBase > 0 ? fatBase - fatRef : null;

    // % da meta
    const pctMeta = fatBase > 0 ? (fatRef / fatBase) * 100 : null;

    // Comparação mês anterior
    const compMesAnt = fatM1 > 0 ? ((fatRef - fatM1) / fatM1) * 100 : null;

    // Comparação com a meta (projeção vs base)
    const compMeta = fatBase > 0 ? ((fatProj / fatBase) * 100) - 100 : null;

    // Receita GLR
    const vendasProj = plats.reduce((s,p) => s + calcP(p.vendasBase), 0);
    const receitaGLR = Math.round(vendasProj) * (parseFloat(c.valorPorVenda) || 0);

    return { fatBase, adsBase, pctADSBase, fatProj, adsProj, pctADSProj,
             fatReal, adsReal, fatM1, fatM2, fatM3,
             faltaMeta, pctMeta, compMesAnt, compMeta, receitaGLR };
  }

  // Cor da célula de % meta
  function corMeta(pct) {
    if (pct === null) return { bg: 'transparent', text: 'var(--text-muted)' };
    if (pct >= 100)   return { bg: '#10b98120', text: '#10b981' };
    if (pct >= 85)    return { bg: '#f59e0b20', text: '#f59e0b' };
    return                   { bg: '#ef444420', text: '#ef4444' };
  }

  function corCrescimento(pct) {
    if (pct === null) return 'var(--text-muted)';
    if (pct >= 10)    return '#10b981';
    if (pct >= 0)     return '#f59e0b';
    return '#ef4444';
  }

  function renderTabela(gestorNome) {
    const clientes = GLR.clientes.filter(c => c.gestor === gestorNome);
    if (!clientes.length) return `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Nenhum cliente atribuído a este gestor.</div>`;

    const rows = clientes.map(c => ({ c, d: dadosCliente(c) }));

    // Totais
    const tot = {
      fatBase:  rows.reduce((s,r) => s + r.d.fatBase,  0),
      fatProj:  rows.reduce((s,r) => s + r.d.fatProj,  0),
      fatReal:  rows.reduce((s,r) => s + r.d.fatReal,  0),
      adsProj:  rows.reduce((s,r) => s + r.d.adsProj,  0),
      adsReal:  rows.reduce((s,r) => s + r.d.adsReal,  0),
      fatM1:    rows.reduce((s,r) => s + r.d.fatM1,    0),
      fatM2:    rows.reduce((s,r) => s + r.d.fatM2,    0),
      fatM3:    rows.reduce((s,r) => s + r.d.fatM3,    0),
      recGLR:   rows.reduce((s,r) => s + r.d.receitaGLR, 0),
    };
    const totRef     = tot.fatReal || tot.fatProj;
    const totPctMeta = tot.fatBase > 0 ? (totRef / tot.fatBase) * 100 : null;
    const totCompM1  = tot.fatM1   > 0 ? ((totRef - tot.fatM1) / tot.fatM1) * 100 : null;
    const corTot     = corMeta(totPctMeta);

    const mesN = (off) => {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - off, 1);
      return meses[d.getMonth()].substring(0,3).toUpperCase();
    };

    return `
    <div style="overflow-x:auto;margin-bottom:8px;">
    <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:1100px;">
      <thead>
        <tr style="background:#1a2744;color:white;">
          <th style="padding:10px 12px;text-align:left;border-radius:8px 0 0 0;white-space:nowrap;">Empresa</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">Meta (Base)</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">ADS%</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">Projeção Mês</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">Fat. Real</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">vs Mês Ant.</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">Falta p/ Meta</th>
          <th style="padding:10px 8px;text-align:center;white-space:nowrap;">% Meta</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">ADS Proj.</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">%ADS Proj.</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">Receita GLR</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">${mesN(3)}</th>
          <th style="padding:10px 8px;text-align:right;white-space:nowrap;">${mesN(2)}</th>
          <th style="padding:10px 8px;text-align:right;border-radius:0 8px 0 0;white-space:nowrap;">${mesN(1)}</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(({c, d}, i) => {
          const cor = corMeta(d.pctMeta);
          const ref = d.fatReal || d.fatProj;
          return `
          <tr style="background:${i%2===0?'var(--bg-card)':'var(--bg-surface)'};cursor:pointer;"
              onclick="Router.navigate('cliente-perfil',{id:${c.id}})">
            <td style="padding:9px 12px;font-weight:600;border-left:3px solid ${cor.text};">
              ${c.nome}
              <div style="font-size:10px;color:var(--text-muted);font-weight:400;">${GLR.statusLabel[c.status]||c.status}</div>
            </td>
            <td style="padding:9px 8px;text-align:right;">${d.fatBase > 0 ? fmtR(d.fatBase) : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td style="padding:9px 8px;text-align:right;color:${d.pctADSBase>20?'#ef4444':d.pctADSBase>15?'#f59e0b':'var(--text-secondary)'};">${d.pctADSBase > 0 ? d.pctADSBase.toFixed(1)+'%' : '—'}</td>
            <td style="padding:9px 8px;text-align:right;font-weight:600;color:var(--accent-light);">${d.fatProj > 0 ? fmtR(d.fatProj) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;font-weight:${d.fatReal>0?'700':'400'};color:${d.fatReal>0?'var(--text-primary)':'var(--text-muted)'};">${d.fatReal > 0 ? fmtR(d.fatReal) : '<span style="font-size:10px;">sem DRE</span>'}</td>
            <td style="padding:9px 8px;text-align:right;font-weight:600;color:${corCrescimento(d.compMesAnt)};">${d.compMesAnt !== null ? fmtPct(d.compMesAnt) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:${d.faltaMeta !== null ? (d.faltaMeta <= 0 ? '#10b981' : '#ef4444') : 'var(--text-muted)'};">${d.faltaMeta !== null ? (d.faltaMeta <= 0 ? '✅ Batida' : fmtR(d.faltaMeta)) : '—'}</td>
            <td style="padding:9px 8px;text-align:center;">
              ${d.pctMeta !== null ? `
              <span style="background:${cor.bg};color:${cor.text};font-weight:700;padding:3px 8px;border-radius:99px;font-size:11px;">
                ${d.pctMeta.toFixed(1)}%
              </span>` : '<span style="color:var(--text-muted)">—</span>'}
            </td>
            <td style="padding:9px 8px;text-align:right;color:var(--text-secondary);">${d.adsProj > 0 ? fmtR(d.adsProj) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:${d.pctADSProj>20?'#ef4444':d.pctADSProj>15?'#f59e0b':'var(--text-secondary)'};">${d.pctADSProj > 0 ? d.pctADSProj.toFixed(1)+'%' : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:#10b981;font-weight:600;">${d.receitaGLR > 0 ? fmtR(d.receitaGLR) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:var(--text-muted);">${d.fatM3 > 0 ? fmtR(d.fatM3) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:var(--text-muted);">${d.fatM2 > 0 ? fmtR(d.fatM2) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:var(--text-muted);">${d.fatM1 > 0 ? fmtR(d.fatM1) : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="background:#1a274422;font-weight:700;font-size:12.5px;border-top:2px solid var(--border);">
          <td style="padding:10px 12px;">Total — ${clientes.length} cliente${clientes.length!==1?'s':''}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatBase > 0 ? fmtR(tot.fatBase) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatBase > 0 ? ((tot.adsProj/tot.fatProj)*100).toFixed(1)+'%' : '—'}</td>
          <td style="padding:10px 8px;text-align:right;color:var(--accent-light);">${tot.fatProj > 0 ? fmtR(tot.fatProj) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatReal > 0 ? fmtR(tot.fatReal) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;color:${corCrescimento(totCompM1)};">${totCompM1 !== null ? fmtPct(totCompM1) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;"></td>
          <td style="padding:10px 8px;text-align:center;">
            ${totPctMeta !== null ? `<span style="background:${corTot.bg};color:${corTot.text};font-weight:700;padding:3px 8px;border-radius:99px;font-size:11px;">${totPctMeta.toFixed(1)}%</span>` : '—'}
          </td>
          <td style="padding:10px 8px;text-align:right;">${tot.adsProj > 0 ? fmtR(tot.adsProj) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;"></td>
          <td style="padding:10px 8px;text-align:right;color:#10b981;">${tot.recGLR > 0 ? fmtR(tot.recGLR) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatM3 > 0 ? fmtR(tot.fatM3) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatM2 > 0 ? fmtR(tot.fatM2) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatM1 > 0 ? fmtR(tot.fatM1) : '—'}</td>
        </tr>
      </tfoot>
    </table>
    </div>

    <!-- Legenda -->
    <div style="display:flex;gap:16px;flex-wrap:wrap;padding:10px 4px;font-size:11px;color:var(--text-muted);">
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#10b981;border-radius:3px;"></span> Batendo a meta (≥100%)</span>
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#f59e0b;border-radius:3px;"></span> Quase batendo (85–99%)</span>
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#ef4444;border-radius:3px;"></span> Abaixo da meta (&lt;85%)</span>
      <span style="margin-left:auto;">📡 Dados atualizados em tempo real · Clique em um cliente para ver o perfil</span>
    </div>`;
  }

  // ── Render principal — tudo numa página ───────────────────────
  if (!gestoresAtivos.length) {
    el.innerHTML = `<div class="page"><div style="text-align:center;padding:80px;color:var(--text-muted);">
      <div style="font-size:36px;margin-bottom:12px;">📊</div>
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">Nenhum gestor com clientes</div>
      <div style="font-size:13px;">Atribua clientes a gestores para ver a performance aqui.</div>
    </div></div>`;
    return;
  }

  const mesN = (off) => {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - off, 1);
    return meses[d.getMonth()].substring(0,3).toUpperCase();
  };

  el.innerHTML = `<div class="page">

    <!-- Cabeçalho -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="section-title" style="font-size:20px;">📊 Performance Gestor</div>
        <div class="section-subtitle">${meses[hoje.getMonth()]} ${hoje.getFullYear()} · Dados em tempo real</div>
      </div>
      <button class="btn" style="background:var(--bg-card);border:1px solid var(--border);" onclick="window.print()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Imprimir
      </button>
    </div>

    <!-- Um bloco por gestor -->
    ${gestoresAtivos.map(g => {
      const clientes = GLR.clientes.filter(c => c.gestor === g.nome);
      const rows     = clientes.map(c => ({ c, d: dadosCliente(c) }));

      // Totais do gestor
      const tot = {
        fatBase: rows.reduce((s,r) => s + r.d.fatBase, 0),
        fatProj: rows.reduce((s,r) => s + r.d.fatProj, 0),
        fatReal: rows.reduce((s,r) => s + r.d.fatReal, 0),
        adsProj: rows.reduce((s,r) => s + r.d.adsProj, 0),
        fatM1:   rows.reduce((s,r) => s + r.d.fatM1,   0),
        fatM2:   rows.reduce((s,r) => s + r.d.fatM2,   0),
        fatM3:   rows.reduce((s,r) => s + r.d.fatM3,   0),
        recGLR:  rows.reduce((s,r) => s + r.d.receitaGLR, 0),
      };
      const totRef     = tot.fatReal || tot.fatProj;
      const totPctMeta = tot.fatBase > 0 ? (totRef / tot.fatBase) * 100 : null;
      const totCompM1  = tot.fatM1   > 0 ? ((totRef - tot.fatM1) / tot.fatM1) * 100 : null;
      const corTot     = corMeta(totPctMeta);

      return `
      <div class="card" style="padding:0;overflow:hidden;margin-bottom:24px;">

        <!-- Header do gestor -->
        <div style="padding:16px 20px;background:linear-gradient(135deg,#1a2744,#23305a);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-weight:800;color:white;font-size:18px;">${g.nome.charAt(0)}</div>
            <div>
              <div style="font-size:16px;font-weight:800;color:white;">${g.nome}</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.6);">${clientes.length} cliente${clientes.length!==1?'s':''} · ${meses[hoje.getMonth()]} ${hoje.getFullYear()}</div>
            </div>
          </div>
          <div style="display:flex;gap:20px;flex-wrap:wrap;">
            <div style="text-align:center;">
              <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:2px;">Meta Total</div>
              <div style="font-size:15px;font-weight:700;color:white;">${tot.fatBase > 0 ? fmtR(tot.fatBase) : '—'}</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:2px;">Projeção</div>
              <div style="font-size:15px;font-weight:700;color:#818cf8;">${tot.fatProj > 0 ? fmtR(tot.fatProj) : '—'}</div>
            </div>
            ${tot.fatReal > 0 ? `<div style="text-align:center;">
              <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:2px;">Realizado</div>
              <div style="font-size:15px;font-weight:700;color:#34d399;">${fmtR(tot.fatReal)}</div>
            </div>` : ''}
            <div style="text-align:center;">
              <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:2px;">% Meta</div>
              <div style="font-size:15px;font-weight:800;color:${corTot.text};">${totPctMeta !== null ? totPctMeta.toFixed(0)+'%' : '—'}</div>
            </div>
            ${tot.recGLR > 0 ? `<div style="text-align:center;">
              <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:2px;">Receita GLR</div>
              <div style="font-size:15px;font-weight:700;color:#34d399;">${fmtR(tot.recGLR)}</div>
            </div>` : ''}
          </div>
        </div>

        <!-- Tabela de clientes -->
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:1000px;">
          <thead>
            <tr style="background:var(--bg-base);border-bottom:2px solid var(--border);">
              <th style="padding:9px 14px;text-align:left;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Empresa</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;">Meta Base</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">ADS%</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">Projeção</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">Fat. Real</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">vs Mês Ant.</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">Falta p/ Meta</th>
              <th style="padding:9px 8px;text-align:center;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">% Meta</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">ADS Proj.</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">%ADS</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">Rec. GLR</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">${mesN(3)}</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">${mesN(2)}</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;white-space:nowrap;">${mesN(1)}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(({c, d}, i) => {
              const cor = corMeta(d.pctMeta);
              return `
              <tr style="background:${i%2===0?'var(--bg-surface)':'var(--bg-card)'};cursor:pointer;transition:background .15s;"
                  onclick="Router.navigate('cliente-perfil',{id:${c.id}})"
                  onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background='${i%2===0?'var(--bg-surface)':'var(--bg-card)'}'">
                <td style="padding:10px 14px;font-weight:600;border-left:3px solid ${cor.text};">
                  ${c.nome}
                  <div style="font-size:10px;color:var(--text-muted);font-weight:400;margin-top:1px;">${GLR.statusLabel[c.status]||c.status}</div>
                </td>
                <td style="padding:10px 8px;text-align:right;">${d.fatBase > 0 ? fmtR(d.fatBase) : '<span style="color:var(--text-muted)">—</span>'}</td>
                <td style="padding:10px 8px;text-align:right;color:${d.pctADSBase>20?'#ef4444':d.pctADSBase>15?'#f59e0b':'var(--text-secondary)'};">${d.pctADSBase > 0 ? d.pctADSBase.toFixed(1)+'%' : '—'}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:600;color:var(--accent-light);">${d.fatProj > 0 ? fmtR(d.fatProj) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:${d.fatReal>0?'700':'400'};color:${d.fatReal>0?'var(--text-primary)':'var(--text-muted)'};">${d.fatReal > 0 ? fmtR(d.fatReal) : '<span style="font-size:10px;">sem DRE</span>'}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:600;color:${corCrescimento(d.compMesAnt)};">${d.compMesAnt !== null ? fmtPct(d.compMesAnt) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:${d.faltaMeta !== null ? (d.faltaMeta <= 0 ? '#10b981' : '#f97316') : 'var(--text-muted)'};">${d.faltaMeta !== null ? (d.faltaMeta <= 0 ? '✅ Batida' : fmtR(d.faltaMeta)) : '—'}</td>
                <td style="padding:10px 8px;text-align:center;">
                  ${d.pctMeta !== null
                    ? `<span style="background:${cor.bg};color:${cor.text};font-weight:800;padding:3px 10px;border-radius:99px;font-size:11px;white-space:nowrap;">${d.pctMeta.toFixed(1)}%</span>`
                    : '<span style="color:var(--text-muted)">—</span>'}
                </td>
                <td style="padding:10px 8px;text-align:right;color:var(--text-secondary);">${d.adsProj > 0 ? fmtR(d.adsProj) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:${d.pctADSProj>20?'#ef4444':d.pctADSProj>15?'#f59e0b':'var(--text-secondary)'};">${d.pctADSProj > 0 ? d.pctADSProj.toFixed(1)+'%' : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:#10b981;font-weight:600;">${d.receitaGLR > 0 ? fmtR(d.receitaGLR) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:var(--text-muted);font-size:11px;">${d.fatM3 > 0 ? fmtR(d.fatM3) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:var(--text-muted);font-size:11px;">${d.fatM2 > 0 ? fmtR(d.fatM2) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:var(--text-muted);font-size:11px;">${d.fatM1 > 0 ? fmtR(d.fatM1) : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr style="background:#1a274415;font-weight:700;font-size:12.5px;border-top:2px solid var(--border);">
              <td style="padding:10px 14px;color:var(--text-primary);">Total</td>
              <td style="padding:10px 8px;text-align:right;">${tot.fatBase > 0 ? fmtR(tot.fatBase) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;">${tot.fatProj > 0 && tot.adsProj > 0 ? ((tot.adsProj/tot.fatProj)*100).toFixed(1)+'%' : '—'}</td>
              <td style="padding:10px 8px;text-align:right;color:var(--accent-light);">${tot.fatProj > 0 ? fmtR(tot.fatProj) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;">${tot.fatReal > 0 ? fmtR(tot.fatReal) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;color:${corCrescimento(totCompM1)};">${totCompM1 !== null ? fmtPct(totCompM1) : '—'}</td>
              <td style="padding:10px 8px;"></td>
              <td style="padding:10px 8px;text-align:center;">${totPctMeta !== null ? `<span style="background:${corTot.bg};color:${corTot.text};font-weight:800;padding:3px 10px;border-radius:99px;font-size:11px;">${totPctMeta.toFixed(1)}%</span>` : '—'}</td>
              <td style="padding:10px 8px;text-align:right;">${tot.adsProj > 0 ? fmtR(tot.adsProj) : '—'}</td>
              <td style="padding:10px 8px;"></td>
              <td style="padding:10px 8px;text-align:right;color:#10b981;">${tot.recGLR > 0 ? fmtR(tot.recGLR) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;font-size:11px;">${tot.fatM3 > 0 ? fmtR(tot.fatM3) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;font-size:11px;">${tot.fatM2 > 0 ? fmtR(tot.fatM2) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;font-size:11px;">${tot.fatM1 > 0 ? fmtR(tot.fatM1) : '—'}</td>
            </tr>
          </tfoot>
        </table>
        </div>

        <!-- Legenda -->
        <div style="padding:10px 16px;border-top:1px solid var(--border);display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--text-muted);">
          <span style="display:flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;background:#10b981;border-radius:2px;"></span> Batendo meta (≥100%)</span>
          <span style="display:flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;background:#f59e0b;border-radius:2px;"></span> Quase lá (85–99%)</span>
          <span style="display:flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;background:#ef4444;border-radius:2px;"></span> Abaixo da meta (&lt;85%)</span>
          <span style="margin-left:auto;">Clique em um cliente para ver o perfil completo →</span>
        </div>
      </div>`;
    }).join('')}

    <style>
      @media print {
        #sidebar, #header { display:none!important; }
        #main { margin-left:0!important; }
        #page-content { padding:0!important; }
        .page > div:first-child { display:none!important; }
      }
    </style>
  </div>`;
});

// ---- Central de Oportunidades ----
Router.register('oportunidades', (params, el) => {
  const statusLabels = { pendente:'Pendente', em_analise:'Em análise', aprovada:'Aprovada', em_andamento:'Em andamento', concluida:'Concluída' };
  const statusColors = { pendente:'status-ativo', em_analise:'status-ativo', aprovada:'status-crescimento', em_andamento:'status-crescimento', concluida:'status-crescimento' };

  // Garante que GLR.oportunidades existe e é array
  if (!GLR.oportunidades) GLR.oportunidades = [];

  const opps = GLR.oportunidades;
  const totalImpacto = opps.reduce((s, o) => s + (parseFloat(o.impacto)||0), 0);

  el.innerHTML = `<div class="page">
    <!-- KPIs rápidos -->
    <div class="kpi-grid mb-24" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));">
      <div class="kpi-card">
        <div class="kpi-icon" style="background:rgba(16,185,129,0.12);"><span style="font-size:18px;">💡</span></div>
        <div class="kpi-label">Total de Oportunidades</div>
        <div class="kpi-value">${opps.length}</div>
        <div class="kpi-delta up">▲ Ativas</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:rgba(16,185,129,0.12);"><span style="font-size:18px;">💰</span></div>
        <div class="kpi-label">Impacto Total Potencial</div>
        <div class="kpi-value">${GLR.formatCurrency(totalImpacto)}</div>
        <div class="kpi-delta up">▲ Por mês</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:rgba(99,102,241,0.12);"><span style="font-size:18px;">✅</span></div>
        <div class="kpi-label">Em Andamento</div>
        <div class="kpi-value">${opps.filter(o=>o.status==='em_andamento').length}</div>
        <div class="kpi-delta up">▲ Execução ativa</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:rgba(245,158,11,0.12);"><span style="font-size:18px;">🎯</span></div>
        <div class="kpi-label">Maior Impacto</div>
        ${opps.length > 0 ? (() => {
          const sorted = [...opps].sort((a,b)=>b.impacto-a.impacto);
          return `<div class="kpi-value">${GLR.formatCurrency(sorted[0].impacto)}</div>
          <div class="kpi-delta up">▲ ${sorted[0].titulo.split(' ').slice(0,3).join(' ')}</div>`;
        })() : '<div class="kpi-value">—</div><div class="kpi-delta">Nenhuma oportunidade</div>'}
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <div class="section-title">💡 Oportunidades Identificadas</div>
      <button class="btn btn-primary" onclick="openModalNovaOpp()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        Nova Oportunidade
      </button>
    </div>

    ${opps.length === 0 ? `<div class="card" style="text-align:center;padding:48px;color:var(--text-muted);">
      <div style="font-size:48px;margin-bottom:16px;">💡</div>
      <div style="font-size:16px;font-weight:600;margin-bottom:8px;">Nenhuma oportunidade cadastrada</div>
      <div style="font-size:13px;">Clique em "Nova Oportunidade" para registrar uma.</div>
    </div>` : ''}

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;">
      ${[...opps].sort((a,b) => (b.impacto||0) - (a.impacto||0)).map(o => {
        const cliente = GLR.clientes.find(c => c.id === o.clienteId);
        return `<div class="opp-card">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px;">
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text-primary);margin-bottom:4px;">${o.titulo}</div>
              <div style="font-size:12px;color:var(--text-muted);">${cliente?.nome || 'Geral'}</div>
            </div>
            <span class="badge ${statusColors[o.status]}">${statusLabels[o.status]}</span>
          </div>
          <div style="margin-bottom:12px;">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Impacto esperado / mês</div>
            <div class="opp-impact">${GLR.formatCurrencyFull(o.impacto)}</div>
          </div>
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">${o.descricao}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="badge ${GLR.prioridadeColor[o.prioridade]}">${o.prioridade}</span>
              <span style="font-size:12px;color:var(--text-muted);">👤 ${o.responsavel}</span>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation()">Detalhes →</button>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;

  window.openModalNovaOpp = () => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal">
      <div class="modal-header">
        <div class="modal-title">Nova Oportunidade</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div class="form-group"><label class="form-label">Título</label><input class="form-input" placeholder="Ex: Otimização da linha de cadeiras"></div>
      <div class="form-group"><label class="form-label">Cliente</label>
        <select class="form-select">${GLR.clientes.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label class="form-label">Impacto Esperado (R$/mês)</label><input class="form-input" type="number" placeholder="30000"></div>
      <div class="form-group"><label class="form-label">Descrição</label><textarea class="form-textarea" placeholder="Detalhe a oportunidade..."></textarea></div>
      <div class="grid-2" style="gap:12px;">
        <div class="form-group"><label class="form-label">Responsável</label>
          <select class="form-select">${GLR.gestores.map(g=>`<option>${g.nome}</option>`).join('')}</select>
        </div>
        <div class="form-group"><label class="form-label">Prioridade</label>
          <select class="form-select"><option>alta</option><option>media</option><option>baixa</option></select>
        </div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">Registrar</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  };
});

// ---- Central de Alertas ----
// ── Gera alertas automáticos a partir dos dados reais ───────────
function gerarAlertasAutomaticos() {
  const alertas = [];
  const hoje    = new Date();
  const hojeSt  = hoje.toISOString().split('T')[0];
  const mesNomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const mesAbrev = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const brl = v => (parseFloat(v)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});

  let projecoes = [], dres = [];
  try { projecoes = JSON.parse(localStorage.getItem('glr_projecoes') || '[]'); } catch(e) {}
  try { dres      = JSON.parse(localStorage.getItem('glr_dre')       || '[]'); } catch(e) {}

  // add(): conta = nome da plataforma/conta (ex: "Shopee", "Mercado Livre")
  function add(tipo, titulo, descricao, clienteId, conta) {
    alertas.push({ tipo, titulo, descricao, clienteId: clienteId||null, conta: conta||null, data: hojeSt });
  }

  GLR.clientes.forEach(c => {
    const cresc  = parseFloat(c.crescimento) || 0;
    const proj   = projecoes.find(p => parseInt(p.chave) === c.id);
    const plats  = proj?.plataformas || [];
    const dd     = Math.max(parseInt(proj?.diasDecorridos)||1, 1);
    const dm     = Math.max(parseInt(proj?.diasNoMes)||30, 1);
    const calcP  = base => base ? (parseFloat(base)/dd)*dm : 0;

    // DRE do mês atual — agrupados por plataforma
    const dreAtualTodas = dres.filter(d =>
      parseInt(d.clienteId) === c.id &&
      parseInt(d.mes) === hoje.getMonth() &&
      parseInt(d.ano) === hoje.getFullYear()
    );

    // ── ANÁLISE POR PLATAFORMA / CONTA ──────────────────────────────
    plats.forEach(plat => {
      const conta      = `${c.nome} · ${plat.nome}`;
      const fatBase    = parseFloat(plat.fatBase)    || 0;
      const adsBase    = parseFloat(plat.adsBase)    || 0;
      const vendasBase = parseFloat(plat.vendasBase) || 0;
      const fatProj    = calcP(plat.fatBase);
      const adsProj    = calcP(plat.adsBase);
      const vendasProj = calcP(plat.vendasBase);
      const maioFat    = parseFloat(plat.maio)  || 0;

      // DRE desta plataforma no mês atual (nome case-insensitive)
      const dreP = dreAtualTodas.find(d =>
        (d.plataforma||'').toLowerCase().trim() === plat.nome.toLowerCase().trim()
      );
      const fatDRE    = parseFloat(dreP?.valores?.faturamento) || 0;
      const adsDRE    = parseFloat(dreP?.valores?.ads)         || 0;
      const vendasDRE = parseFloat(dreP?.valores?.produtosVendidos) || 0;

      // Referências de ADS e faturamento (DRE tem prioridade sobre projeção)
      const fatRef = fatDRE || fatProj;
      const adsRef = adsDRE || adsProj;
      const pctADS = fatRef > 0 && adsRef > 0 ? (adsRef / fatRef) * 100 : 0;
      const roas   = adsRef > 0 ? fatRef / adsRef : null;

      // Evolução vs mês anterior (mai)
      const evo = maioFat > 0 && fatProj > 0 ? ((fatProj - maioFat) / maioFat) * 100 : null;

      if (fatBase === 0 && adsBase === 0) return; // conta sem dados — pula

      // ── 🔴 CRÍTICOS ─────────────────────────────────────────────
      if (pctADS > 30) {
        add('risco',
          `ADS crítico — ${plat.nome}`,
          `${conta}: ADS representa ${pctADS.toFixed(1)}% do faturamento (acima de 30%). ROAS de ${roas ? roas.toFixed(1)+'x' : '—'}. Rentabilidade comprometida.`,
          c.id, conta);
      }
      if (roas !== null && roas < 3) {
        add('risco',
          `ROAS baixo — ${plat.nome}`,
          `${conta}: ROAS de ${roas.toFixed(2)}x — abaixo de 3x. Para cada R$ 1 investido em ADS, retorna R$ ${roas.toFixed(2)} em faturamento.`,
          c.id, conta);
      }
      if (fatDRE > 0 && fatProj > 0 && fatDRE < fatProj * 0.60) {
        add('risco',
          `Faturamento crítico — ${plat.nome}`,
          `${conta}: apenas ${((fatDRE/fatProj)*100).toFixed(0)}% da projeção realizado (${brl(fatDRE)} de ${brl(fatProj)} projetados).`,
          c.id, conta);
      }

      // ── 📉 QUEDA ────────────────────────────────────────────────
      if (pctADS > 20 && pctADS <= 30) {
        add('queda',
          `ADS elevado — ${plat.nome}`,
          `${conta}: ADS em ${pctADS.toFixed(1)}% do faturamento (ideal abaixo de 20%). Monitorar rentabilidade.`,
          c.id, conta);
      }
      if (evo !== null && evo < -10) {
        add('queda',
          `Queda vs mês anterior — ${plat.nome}`,
          `${conta}: projeção ${evo.toFixed(1)}% abaixo do mês passado (${brl(maioFat)} → ${brl(fatProj)}).`,
          c.id, conta);
      }
      if (fatDRE > 0 && fatProj > 0 && fatDRE >= fatProj * 0.60 && fatDRE < fatProj * 0.80) {
        add('queda',
          `Abaixo da projeção — ${plat.nome}`,
          `${conta}: ${((fatDRE/fatProj)*100).toFixed(0)}% da projeção realizado (${brl(fatDRE)} de ${brl(fatProj)}).`,
          c.id, conta);
      }

      // ── 🎯 METAS / ATENÇÃO ──────────────────────────────────────
      if (fatDRE > 0 && fatProj > 0 && fatDRE >= fatProj * 0.80 && fatDRE < fatProj * 0.95) {
        add('meta',
          `Próximo da meta — ${plat.nome}`,
          `${conta}: ${((fatDRE/fatProj)*100).toFixed(0)}% da projeção. Faltam ${brl(fatProj - fatDRE)} para bater a meta.`,
          c.id, conta);
      }
      if (vendasBase > 0 && vendasDRE > 0 && vendasDRE < vendasProj * 0.70) {
        add('meta',
          `Conversão baixa — ${plat.nome}`,
          `${conta}: ${vendasDRE} vendas realizadas de ${Math.round(vendasProj)} projetadas (${((vendasDRE/vendasProj)*100).toFixed(0)}%).`,
          c.id, conta);
      }

      // ── ✅ POSITIVOS ────────────────────────────────────────────
      if (roas !== null && roas >= 10) {
        add('positivo',
          `ROAS excelente — ${plat.nome}`,
          `${conta}: ROAS de ${roas.toFixed(1)}x 🚀. Cada R$ 1 em ADS gera R$ ${roas.toFixed(1)} em faturamento.`,
          c.id, conta);
      }
      if (fatDRE > 0 && fatProj > 0 && fatDRE >= fatProj) {
        add('positivo',
          `Meta batida! — ${plat.nome}`,
          `${conta}: ${brl(fatDRE)} realizados (${((fatDRE/fatProj)*100).toFixed(0)}% da projeção de ${brl(fatProj)}). 🎉`,
          c.id, conta);
      }
      if (evo !== null && evo >= 20) {
        add('positivo',
          `Crescimento forte — ${plat.nome}`,
          `${conta}: projeção +${evo.toFixed(1)}% acima do mês passado (${brl(maioFat)} → ${brl(fatProj)}). 📈`,
          c.id, conta);
      }
    });

    // ── ALERTAS DO CLIENTE (nível geral, não por conta) ────────────
    if (c.status === 'risco') {
      add('risco', `${c.nome} em situação de risco`,
        `Status marcado como Risco. Requer análise imediata e contato com o cliente.`, c.id, null);
    }
    if (cresc < -10) {
      add('risco', `Queda crítica de crescimento — ${c.nome}`,
        `Crescimento geral de ${cresc}% detectado. Intervenção necessária.`, c.id, null);
    }

    // Tarefas do cliente
    const tarefas   = GLR.tarefas.filter(t => t.cliente===c.nome || String(t.clienteId)===String(c.id));
    const atrasadas = tarefas.filter(t => t.status!=='concluida' && t.prazo && t.prazo < hojeSt);
    const urgentes  = tarefas.filter(t => t.status!=='concluida' && t.prioridade==='urgente');
    if (atrasadas.length > 0) {
      add('atrasada', `${atrasadas.length} tarefa${atrasadas.length>1?'s':''} atrasada${atrasadas.length>1?'s':''} — ${c.nome}`,
        `${atrasadas.slice(0,3).map(t=>t.titulo).join(', ')}${atrasadas.length>3?' e mais...':''}`, c.id, null);
    }
    if (urgentes.length > 0) {
      add('atrasada', `${urgentes.length} tarefa${urgentes.length>1?'s':''} urgente${urgentes.length>1?'s':''} — ${c.nome}`,
        `${urgentes.map(t=>t.titulo).join(', ')}`, c.id, null);
    }

    // DRE não lançado (cliente tem projeção mas sem DRE no mês atual)
    const fatProjTotal = plats.reduce((s,p) => s + calcP(p.fatBase), 0);
    if (fatProjTotal > 0 && dreAtualTodas.length === 0 && hoje.getDate() > 10) {
      add('atrasada', `DRE não lançado — ${c.nome}`,
        `Já passou do dia 10 e o DRE de ${mesAbrev[hoje.getMonth()]} ainda não foi registrado para nenhuma conta.`, c.id, null);
    }

    // Cliente positivo geral
    if (c.status === 'crescimento' && cresc >= 10) {
      add('positivo', `Cliente em expansão — ${c.nome}`,
        `Status "Em Crescimento" com +${cresc}%. Potencial de upsell e novos serviços.`, c.id, null);
    }
  });

  // Alertas internos sem cliente
  const tarefasGeraisAtrasadas = GLR.tarefas.filter(t =>
    !t.clienteId && t.status!=='concluida' && t.prazo && t.prazo < hojeSt);
  if (tarefasGeraisAtrasadas.length > 0) {
    add('atrasada',
      `${tarefasGeraisAtrasadas.length} tarefa${tarefasGeraisAtrasadas.length>1?'s':''} interna${tarefasGeraisAtrasadas.length>1?'s':''} atrasada${tarefasGeraisAtrasadas.length>1?'s':''}`,
      `${tarefasGeraisAtrasadas.slice(0,3).map(t=>t.titulo).join(', ')}`, null, null);
  }

  if (GLR.clientes.length === 0) {
    add('meta', 'Nenhum cliente cadastrado', 'Cadastre seus primeiros clientes para começar a usar o sistema.', null, null);
  }

  return alertas;
}

Router.register('alertas', (params, el) => {
  const alertas = gerarAlertasAutomaticos();

  const criticos  = alertas.filter(a => a.tipo === 'risco' || a.tipo === 'queda');
  const atencao   = alertas.filter(a => a.tipo === 'atrasada' || a.tipo === 'meta');
  const positivos = alertas.filter(a => a.tipo === 'positivo');

  const cores  = { risco:'#ef4444', queda:'#f97316', atrasada:'#f59e0b', meta:'#6366f1', positivo:'#10b981' };
  const icons  = { risco:'🚨', queda:'📉', atrasada:'⏰', meta:'🎯', positivo:'✅' };
  const labels = { risco:'Risco', queda:'Queda', atrasada:'Atrasada', meta:'Meta', positivo:'Positivo' };

  function renderAlerta(a) {
    const cor     = cores[a.tipo];
    const cliente = GLR.clientes.find(c => c.id === a.clienteId);
    // Badge da conta/plataforma (ex: "Shopee" ou "Mercado Livre")
    const contaNome = a.conta ? a.conta.split(' · ')[1] : null;
    const platIcon  = { shopee:'🟠', 'mercado livre':'🟡', amazon:'🔵', magazine:'🔴' };
    const platEmoji = contaNome
      ? (platIcon[contaNome.toLowerCase()] || '🏪')
      : null;

    return `<div class="alert-card" style="cursor:${cliente?'pointer':'default'}"
              onclick="${cliente ? `Router.navigate('cliente-perfil',{id:${a.clienteId}})` : ''}">
      <div class="alert-icon" style="background:${cor}20;">
        <span style="font-size:18px;">${icons[a.tipo]}</span>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;">
          <div class="alert-title">${a.titulo}</div>
          <span style="font-size:10px;background:${cor}20;color:${cor};padding:1px 7px;border-radius:99px;font-weight:600;">${labels[a.tipo]}</span>
          ${contaNome ? `<span style="font-size:10px;background:rgba(255,255,255,0.07);color:var(--text-muted);padding:1px 7px;border-radius:99px;">${platEmoji} ${contaNome}</span>` : ''}
        </div>
        <div class="alert-desc">${a.descricao}</div>
        <div style="margin-top:5px;font-size:11px;color:var(--text-muted);">📅 Hoje${cliente ? ` · ${cliente.nome}` : ''}</div>
      </div>
      ${cliente ? `<button class="btn btn-ghost btn-sm" style="flex-shrink:0;" onclick="event.stopPropagation();Router.navigate('cliente-perfil',{id:${a.clienteId}})">Ver cliente →</button>` : ''}
    </div>`;
  }

  function secao(titulo, lista, empty) {
    return `<div class="card mb-16">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div class="section-title">${titulo}</div>
        <span style="font-size:12px;color:var(--text-muted);">${lista.length} alerta${lista.length!==1?'s':''}</span>
      </div>
      ${lista.length ? lista.map(renderAlerta).join('') : `<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">${empty}</div>`}
    </div>`;
  }

  el.innerHTML = `<div class="page">

    <!-- KPIs -->
    <div class="kpi-grid mb-20" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr));">
      ${[
        { tipo:'risco',    label:'Riscos',    v: alertas.filter(a=>a.tipo==='risco').length },
        { tipo:'queda',    label:'Quedas',    v: alertas.filter(a=>a.tipo==='queda').length },
        { tipo:'atrasada', label:'Atrasadas', v: alertas.filter(a=>a.tipo==='atrasada').length },
        { tipo:'meta',     label:'Metas',     v: alertas.filter(a=>a.tipo==='meta').length },
        { tipo:'positivo', label:'Positivos', v: alertas.filter(a=>a.tipo==='positivo').length },
      ].map(k => `
        <div class="kpi-card" style="border-color:${cores[k.tipo]}30;">
          <div class="kpi-icon" style="background:${cores[k.tipo]}20;"><span style="font-size:18px;">${icons[k.tipo]}</span></div>
          <div class="kpi-label">${k.label}</div>
          <div class="kpi-value" style="color:${cores[k.tipo]};">${k.v}</div>
        </div>`).join('')}
    </div>

    <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px;display:flex;align-items:center;gap:6px;">
      <span style="width:7px;height:7px;border-radius:50%;background:#10b981;display:inline-block;"></span>
      Alertas gerados automaticamente em tempo real · ${alertas.length} total
    </div>

    ${secao('🔴 Críticos — Ação Imediata', criticos,  'Nenhum alerta crítico. Ótimo! ✅')}
    ${secao('🟡 Atenção — Monitorar',      atencao,   'Nada a monitorar no momento.')}
    ${secao('🟢 Positivos',               positivos, 'Nenhum destaque positivo ainda.')}
  </div>`;
});

// ---- Projeção de Faturamento ----
Router.register('projecao', (params, el) => {
  const storageKey = 'glr_projecoes';
  let projecoes = [];
  try { projecoes = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch(e) {}
  let ocultarGLR = false;

  // ── Determina qual cliente/projeção está ativa ─────────────────
  // Prioridade: param da URL > última projeção salva > primeiro cliente cadastrado
  let clienteIdAtivo = parseInt(params.clienteId)
    || parseInt(projecoes[0]?.chave)
    || (GLR.clientes[0]?.id)
    || null;

  let projecaoAtiva = clienteIdAtivo
    ? projecoes.find(p => parseInt(p.chave) === clienteIdAtivo)
    : null;

  // Se não existe projeção para este cliente, cria em branco vinculada a ele
  const _hoje = new Date();
  const _ontem = new Date(_hoje); _ontem.setDate(_hoje.getDate() - 1);
  const _mesesNomesProj = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const _mesLabel = `${_mesesNomesProj[_hoje.getMonth()]} ${_hoje.getFullYear()}`;
  const _diasNoMes = new Date(_hoje.getFullYear(), _hoje.getMonth() + 1, 0).getDate();

  if (!projecaoAtiva) {
    const clienteObj = GLR.clientes.find(c => c.id === clienteIdAtivo);
    projecaoAtiva = {
      chave:          clienteIdAtivo ? String(clienteIdAtivo) : 'sem_cliente',
      nomeCliente:    clienteObj?.nome || '',
      mes:            _mesLabel,
      diasNoMes:      _diasNoMes,
      diasDecorridos: _ontem.getDate(),
      obs: '',
      plataformas: [
        { nome: 'Shopee',        fatBase: '', adsBase: '', maio: '', abril: '', marco: '' },
        { nome: 'Mercado Livre', fatBase: '', adsBase: '', maio: '', abril: '', marco: '' },
      ]
    };
  } else {
    // diasDecorridos: mantém o valor salvo manualmente — não sobrescreve
    projecaoAtiva.diasNoMes = _diasNoMes;
  }

  function salvar() {
    const idx = projecoes.findIndex(p => parseInt(p.chave) === clienteIdAtivo);
    if (idx >= 0) projecoes[idx] = projecaoAtiva;
    else projecoes.push(projecaoAtiva);
    localStorage.setItem(storageKey, JSON.stringify(projecoes));
  }

  function calcProjecao(fatBase, diasDecorridos, diasNoMes) {
    const base = parseFloat(fatBase) || 0;
    if (!base || !diasDecorridos) return 0;
    return (base / diasDecorridos) * diasNoMes;
  }

  function calcEvolucao(projecao, maio) {
    const p = parseFloat(projecao) || 0;
    const m = parseFloat(maio) || 0;
    if (!m || !p) return null;
    return ((p - m) / m) * 100;
  }

  function fmtBRL(v) {
    const n = parseFloat(v) || 0;
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPct(v) {
    if (v === null || isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function evoCor(v) {
    if (v === null || isNaN(v)) return 'var(--text-muted)';
    return v >= 0 ? 'var(--green)' : 'var(--red)';
  }

  // ── Busca simplificada de ordens para contas vinculadas (GMV apenas, sem escrow) ──
  async function buscarDadosProjecao() {
    const cidAtivo = parseInt(document.getElementById('sel-cliente')?.value) || clienteIdAtivo;
    let vinculos = {};
    try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos')||'{}'); } catch(e) {}
    const contasVinc = vinculos[String(cidAtivo)] || [];
    if (!contasVinc.length) { alert('Nenhuma conta vinculada. Use 🔗 Vincular conta primeiro.'); return; }
    const apiKey = localStorage.getItem('glr_mc_apikey')||'';
    if (!apiKey) { alert('Configure a API Key nas Integrações.'); return; }

    const btn = document.getElementById('btn-buscar-proj');
    if (btn) { btn.disabled=true; btn.textContent='⏳ Buscando...'; }

    try {
      const hoje = new Date();
      const pad  = n => String(n).padStart(2,'0');
      const ano = hoje.getFullYear(), mes = hoje.getMonth()+1;
      const primeiroDia = `${ano}-${pad(mes)}-01`;
      const dataTo = `${ano}-${pad(mes)}-${pad(hoje.getDate())}`;
      const tsFrom = new Date(`${primeiroDia}T00:00:00`).getTime();
      const tsTo   = new Date(`${dataTo}T23:59:59`).getTime();
      const mesKey = `${ano}-${pad(mes)}`;

      // Carrega cache existente para merge
      let cacheExist = {};
      try { cacheExist = JSON.parse(localStorage.getItem('glr_fin_cache')||'{}'); } catch(e) {}
      let pedidos = (cacheExist.mesKey === mesKey) ? (cacheExist.pedidos || []) : [];
      const contaIds = contasVinc.map(c => c.external_id);
      // Remove ordens antigas das contas que vamos re-buscar
      pedidos = pedidos.filter(p => !contaIds.includes(p.contaId));

      const totalContas = contasVinc.length;
      let idx = 0;

      for (const conta of contasVinc) {
        idx++;
        const mkt = (conta.marketplace||'').toLowerCase();
        const label = conta.nickname || conta.external_id;
        if (btn) btn.textContent = `⏳ ${idx}/${totalContas}: ${label}`;

        try {
          if (['meli','ml','mercadolivre'].includes(mkt)) {
            const meliId = conta.param_to_use?.meliUserId || conta.external_id;
            const orders = await MarketplaceAPI.mlOrders(meliId, primeiroDia, dataTo);
            for (const o of orders) {
              pedidos.push({
                id: String(o.id), plataforma:'Mercado Livre', contaId: conta.external_id,
                valor: parseFloat(o.total_amount)||0, status: o.status||'', qtd: (o.order_items||[]).length||1, taxas:{},
              });
            }
          } else if (mkt === 'shopee') {
            const shopId = conta.param_to_use?.shopId || conta.external_id;
            const snsList = await MarketplaceAPI.shopeeListOrderSns(shopId, Math.floor(tsFrom/1000), Math.floor(tsTo/1000));
            for (let i=0; i<snsList.length; i+=50) {
              const lote = snsList.slice(i,i+50).map(o=>o.sn);
              try {
                const rd = await MarketplaceAPI.call('shopee_get_order_detail',{shopId, order_sn_list:lote});
                const orderList = rd.data?.response?.order_list || rd.data?.order_list || [];
                for (const ord of orderList) {
                  const items = ord.item_list || ord.items || [];
                  const subtotal = items.reduce((s,it) => {
                    const p = parseFloat(it.model_discounted_price)||parseFloat(it.item_price)||0;
                    const q = parseInt(it.model_quantity_purchased)||parseInt(it.quantity)||1;
                    return s + p*q;
                  }, 0);
                  pedidos.push({
                    id: ord.order_sn, plataforma:'Shopee', contaId: conta.external_id,
                    valor: subtotal > 0 ? subtotal : (parseFloat(ord.total_amount)||0),
                    status: ord.order_status||'', qtd: items.length||1, taxas:{},
                  });
                }
              } catch(e) { console.warn('[Proj] Shopee batch erro:', e.message); }
            }
          }
        } catch(e) {
          console.warn(`[Proj] Erro conta ${label}:`, e.message);
        }
      }

      // Salva cache mesclado
      localStorage.setItem('glr_fin_cache', JSON.stringify({ ...(cacheExist||{}), ver:25, mesKey, pedidos }));

      // Auto-cria linhas de plataforma que ainda não existem na tabela
      const platMap = { mercadolivre:'Mercado Livre', ml:'Mercado Livre', meli:'Mercado Livre', shopee:'Shopee', bling:'Bling' };
      const platsExistentes = new Set((projecaoAtiva.plataformas||[]).map(p=>(p.nome||'').toLowerCase()));
      contasVinc.forEach(c => {
        const nomePlat = platMap[(c.marketplace||'').toLowerCase()];
        if (nomePlat && !platsExistentes.has(nomePlat.toLowerCase())) {
          projecaoAtiva.plataformas.push({nome:nomePlat, fatBase:'', adsBase:'', vendasBase:'', maio:'', abril:'', marco:''});
          platsExistentes.add(nomePlat.toLowerCase());
        }
      });

      renderTabela();
    } catch(e) {
      alert('Erro ao buscar dados: '+e.message);
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='🔄 Buscar dados'; }
    }
  }

  // Lê cache do Financeiro do mês atual e retorna {fat, ads, vendas} por plataforma
  function lerCacheAtual() {
    try {
      const c = JSON.parse(localStorage.getItem('glr_fin_cache') || 'null');
      if (!c) return null;
      const hoje = new Date();
      const pad  = n => String(n).padStart(2, '0');
      if (c.mesKey !== `${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}`) return null;
      return c;
    } catch(e) { return null; }
  }

  function normalizaPlat(nome) {
    const n = (nome||'').toLowerCase().trim();
    if (n === 'shopee') return 'Shopee';
    if (n === 'mercado livre' || n === 'ml' || n === 'mercadolivre' || n === 'meli') return 'Mercado Livre';
    return nome;
  }

  function cacheParaPlat(cache, contasCliente, platNome) {
    if (!cache || !contasCliente.length) return null;
    const platFiltro = normalizaPlat(platNome);
    const isReemb = st => { const s=(st||'').toLowerCase(); return s.includes('cancel')||s.includes('refund')||s.includes('devol')||s==='invalid'||s.includes('return'); };
    const peds = (cache.pedidos||[]).filter(p => contasCliente.includes(p.contaId) && p.plataforma===platFiltro && !isReemb(p.status));
    const fat  = peds.reduce((s,p) => s+(parseFloat(p.valor)||0), 0);
    const qtd  = peds.reduce((s,p) => s+(parseInt(p.qtd)||1), 0);
    const ads  = parseFloat((cache.adsAPI||{})[platFiltro]) || 0;
    return fat > 0 ? { fat, ads, vendas: qtd } : null;
  }

  function renderTabela() {
    const plats = projecaoAtiva.plataformas;
    const dd = parseInt(document.getElementById('inp-dias-dec')?.value) || projecaoAtiva.diasDecorridos;
    const dm = parseInt(document.getElementById('inp-dias-mes')?.value) || projecaoAtiva.diasNoMes;

    // Dados reais da API para auto-preenchimento
    const cache = lerCacheAtual();
    let vinculos = {};
    try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos')||'{}'); } catch(e) {}
    // Tenta pelo clienteIdAtivo atual (pode ter mudado via dropdown)
    const cidAtivo = parseInt(document.getElementById('sel-cliente')?.value) || clienteIdAtivo;
    const contasVinc = vinculos[String(cidAtivo)] || vinculos[cidAtivo] || [];
    const contasCliente = contasVinc.map(c => c.external_id);
    const temCache = !!cache;

    // Diagnóstico inline — mostra estado do auto-fill no rodapé da tabela
    const pad2 = n => String(n).padStart(2,'0');
    const hoje = new Date();
    const keyAtual = `${hoje.getFullYear()}-${pad2(hoje.getMonth()+1)}`;
    let diagMsg = '';
    if (!cache) {
      diagMsg = `⚠️ Cache não encontrado para ${keyAtual}. Sincronize <strong>Financeiro</strong> neste mês primeiro.`;
    } else if (!contasCliente.length) {
      diagMsg = `⚠️ Nenhuma conta vinculada (cliente ID ${cidAtivo}). Vincule em <strong>Integrações</strong>.`;
    } else {
      const todosContaIds = [...new Set((cache.pedidos||[]).map(p => p.contaId))];
      const totalPeds = (cache.pedidos||[]).filter(p => contasCliente.includes(p.contaId)).length;
      if (totalPeds === 0) {
        diagMsg = `⚠️ Cache OK | IDs vinculados ao cliente: <code>${contasCliente.join(', ')}</code> | IDs no cache: <code>${todosContaIds.join(', ')}</code> — não batem. Verifique o vínculo em Integrações.`;
      }
    }
    // Log de diagnóstico no console para debug
    console.log('[Proj diag] cidAtivo:', cidAtivo, '| contasCliente:', contasCliente, '| cache mesKey:', cache?.mesKey, '| pedidos no cache:', (cache?.pedidos||[]).length, '| contaIds no cache:', [...new Set((cache?.pedidos||[]).map(p=>p.contaId))]);

    // ── Valores efetivos (manual salvo OU API) — usados em totais e linhas ──
    const efetivos = plats.map(p => {
      const cd = cacheParaPlat(cache, contasCliente, p.nome);
      return {
        fat:    p.fatBase    || (cd ? cd.fat.toFixed(2)    : ''),
        ads:    p.adsBase    || (cd ? cd.ads.toFixed(2)    : ''),
        vendas: p.vendasBase || (cd ? String(cd.vendas)    : ''),
      };
    });

    // ── Totais ──────────────────────────────────────────────────────
    const totFatBase   = efetivos.reduce((s,e) => s + (parseFloat(e.fat)    || 0), 0);
    const totProj      = efetivos.reduce((s,e) => s + calcProjecao(e.fat,   dd, dm), 0);
    const totVendasBase= efetivos.reduce((s,e) => s + (parseFloat(e.vendas) || 0), 0);
    const totVendasProj= efetivos.reduce((s,e) => s + calcProjecao(e.vendas,dd, dm), 0);
    const totAdsBase   = efetivos.reduce((s,e) => s + (parseFloat(e.ads)    || 0), 0);
    const totAdsProj   = efetivos.reduce((s,e) => s + calcProjecao(e.ads,   dd, dm), 0);
    const totPctAds    = totProj > 0 && totAdsProj > 0 ? (totAdsProj / totProj * 100) : 0;
    const totMaio      = plats.reduce((s,p) => s + (parseFloat(p.maio)  || 0), 0);
    const totAbril     = plats.reduce((s,p) => s + (parseFloat(p.abril) || 0), 0);
    const totMarco     = plats.reduce((s,p) => s + (parseFloat(p.marco) || 0), 0);
    const totEvo       = calcEvolucao(totProj, totMaio);

    // Receita GLR = vendas projetadas × valor por venda do cliente
    const selEl        = document.getElementById('sel-cliente');
    const cidSel       = selEl ? parseInt(selEl.value) : clienteIdAtivo;
    let clientes = []; try { clientes = JSON.parse(localStorage.getItem('glr_clientes')||'[]'); } catch(e){}
    const cliAtual     = clientes.find(c => c.id === cidSel);
    const valorVenda   = parseFloat(cliAtual?.valorPorVenda) || 0;
    const receitaGLR   = Math.round(totVendasProj) * valorVenda;

    const linhas = plats.map((p, i) => {
      const fatBaseEfetivo    = efetivos[i].fat;
      const adsBaseEfetivo    = efetivos[i].ads;
      const vendasBaseEfetivo = efetivos[i].vendas;
      const cd = cacheParaPlat(cache, contasCliente, p.nome);
      const autoFat = !p.fatBase && cd;
      const autoAds = !p.adsBase && cd;

      const proj       = calcProjecao(fatBaseEfetivo,    dd, dm);
      const vendasProj = calcProjecao(vendasBaseEfetivo, dd, dm);
      const adsProj    = calcProjecao(adsBaseEfetivo,    dd, dm);
      const pctAds     = proj > 0 && adsProj > 0 ? (adsProj / proj * 100) : 0;
      const evo        = calcEvolucao(proj, p.maio);
      const fmtInt     = v => Math.round(parseFloat(v)||0).toLocaleString('pt-BR');

      return `<tr data-idx="${i}">
        <td style="min-width:150px;">
          <input class="proj-input" style="font-weight:600;font-size:13px;text-align:left;" value="${p.nome}" onchange="updatePlat(${i},'nome',this.value)" placeholder="Plataforma">
        </td>
        <td style="text-align:right;position:relative;">
          <input class="proj-input money${autoFat?' proj-auto':''}" value="${fatBaseEfetivo}" onchange="updatePlat(${i},'fatBase',this.value)" placeholder="0,00">
          ${autoFat ? `<span style="position:absolute;top:2px;right:4px;font-size:8px;color:#818cf8;font-weight:700;">API</span>` : ''}
        </td>
        <td style="background:rgba(99,102,241,0.07);text-align:right;white-space:nowrap;">
          <strong style="color:var(--accent-light);">R$ ${fmtBRL(proj)}</strong>
        </td>
        <td style="text-align:right;background:rgba(16,185,129,0.05);">
          <input class="proj-input" value="${vendasBaseEfetivo}" onchange="updatePlat(${i},'vendasBase',this.value)" placeholder="0" style="text-align:right;">
        </td>
        <td style="background:rgba(16,185,129,0.1);text-align:right;white-space:nowrap;">
          <strong style="color:var(--green);">${fmtInt(vendasProj)}</strong>
          ${!ocultarGLR && valorVenda > 0 ? `<div style="font-size:10px;color:var(--green);opacity:0.7;">GLR: R$ ${fmtBRL(Math.round(vendasProj)*valorVenda)}</div>` : ''}
        </td>
        <td style="text-align:right;background:rgba(245,158,11,0.05);position:relative;">
          <input class="proj-input money${autoAds?' proj-auto':''}" value="${adsBaseEfetivo}" onchange="updatePlat(${i},'adsBase',this.value)" placeholder="0,00">
          ${autoAds ? `<span style="position:absolute;top:2px;right:4px;font-size:8px;color:#818cf8;font-weight:700;">API</span>` : ''}
        </td>
        <td style="background:rgba(245,158,11,0.08);text-align:right;white-space:nowrap;">
          <strong style="color:#f59e0b;">R$ ${fmtBRL(adsProj)}</strong>
        </td>
        <td style="text-align:center;">
          <span style="color:var(--text-secondary);">${pctAds > 0 ? pctAds.toFixed(2)+'%' : '—'}</span>
        </td>
        <td style="text-align:center;">
          <span style="font-weight:700;color:${evoCor(evo)};">${fmtPct(evo)}</span>
        </td>
        <td style="text-align:right;">
          <input class="proj-input money" value="${p.maio||''}"  onchange="updatePlat(${i},'maio',this.value)"  placeholder="0,00">
        </td>
        <td style="text-align:right;">
          <input class="proj-input money" value="${p.abril||''}" onchange="updatePlat(${i},'abril',this.value)" placeholder="0,00">
        </td>
        <td style="text-align:right;">
          <input class="proj-input money" value="${p.marco||''}" onchange="updatePlat(${i},'marco',this.value)" placeholder="0,00">
        </td>
        <td>
          <button class="btn btn-ghost btn-sm" style="color:var(--red);padding:4px 8px;" onclick="removePlat(${i})" title="Remover">✕</button>
        </td>
      </tr>`;
    }).join('');

    const totEvoHtml = totEvo !== null
      ? `<span style="font-weight:800;color:${evoCor(totEvo)};">${fmtPct(totEvo)}</span>`
      : '—';

    document.getElementById('proj-tbody').innerHTML = linhas;
    const cacheBadge = document.getElementById('th-cache-badge');
    if (cacheBadge) cacheBadge.style.display = temCache ? 'inline' : 'none';
    const diagEl = document.getElementById('proj-diag');
    if (diagEl) { diagEl.innerHTML = diagMsg; diagEl.style.display = diagMsg ? 'block' : 'none'; }
    document.getElementById('proj-tfoot').innerHTML = `<tr style="background:rgba(99,102,241,0.08);">
      <td style="font-weight:800;color:var(--text-primary);font-size:13.5px;">Total</td>
      <td style="font-weight:700;text-align:right;">R$ ${fmtBRL(totFatBase)}</td>
      <td style="background:rgba(99,102,241,0.15);font-weight:800;color:var(--accent-light);font-size:14px;text-align:right;">R$ ${fmtBRL(totProj)}</td>
      <td style="text-align:right;background:rgba(16,185,129,0.07);font-weight:700;">${Math.round(totVendasBase).toLocaleString('pt-BR')}</td>
      <td style="background:rgba(16,185,129,0.14);font-weight:800;color:var(--green);font-size:14px;text-align:right;">
        ${Math.round(totVendasProj).toLocaleString('pt-BR')}
        ${!ocultarGLR && valorVenda > 0 ? `<div style="font-size:11px;color:var(--green);opacity:0.8;">GLR: R$ ${fmtBRL(receitaGLR)}</div>` : ''}
      </td>
      <td style="font-weight:700;text-align:right;background:rgba(245,158,11,0.07);">R$ ${fmtBRL(totAdsBase)}</td>
      <td style="background:rgba(245,158,11,0.12);font-weight:800;color:#f59e0b;font-size:14px;text-align:right;">R$ ${fmtBRL(totAdsProj)}</td>
      <td style="text-align:center;font-weight:700;">${totPctAds > 0 ? totPctAds.toFixed(2)+'%' : '—'}</td>
      <td style="text-align:center;">${totEvoHtml}</td>
      <td style="font-weight:700;text-align:right;">R$ ${fmtBRL(totMaio)}</td>
      <td style="font-weight:700;text-align:right;">R$ ${fmtBRL(totAbril)}</td>
      <td style="font-weight:700;text-align:right;">R$ ${fmtBRL(totMarco)}</td>
      <td></td>
    </tr>`;

    // ── KPIs ────────────────────────────────────────────────────────
    const el_proj = document.getElementById('kpi-projecao');
    const el_vendas = document.getElementById('kpi-vendas');
    const el_glr = document.getElementById('kpi-receita-glr');
    const el_ads = document.getElementById('kpi-ads');
    const el_pctads = document.getElementById('kpi-pct-ads');
    const el_evo = document.getElementById('kpi-evo');

    if (el_proj)   el_proj.textContent   = 'R$ ' + fmtBRL(totProj);
    if (el_vendas) el_vendas.textContent = Math.round(totVendasProj).toLocaleString('pt-BR');
    if (el_glr) {
      el_glr.textContent = receitaGLR > 0 ? 'R$ ' + fmtBRL(receitaGLR) : '—';
      el_glr.style.color = receitaGLR > 0 ? 'var(--green)' : '';
    }
    if (el_ads)    el_ads.textContent    = 'R$ ' + fmtBRL(totAdsProj);
    if (el_pctads) el_pctads.textContent = totPctAds > 0 ? totPctAds.toFixed(2)+'%' : '—';
    if (el_evo)  { el_evo.textContent    = fmtPct(totEvo); el_evo.style.color = evoCor(totEvo); }
  }

  el.innerHTML = `<div class="page">

    <!-- Cabeçalho estilo planilha -->
    <div style="background:linear-gradient(135deg,#0d2144,#1a3a6e);border-radius:var(--radius);padding:0;margin-bottom:20px;overflow:hidden;">
      <div style="background:rgba(255,255,255,0.06);padding:16px 24px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.1);">
        ${GLR.clientes.length === 0
          ? `<div style="color:rgba(255,255,255,0.6);font-size:13px;margin-bottom:6px;">Nenhum cliente cadastrado</div>
             <div style="font-size:20px;font-weight:800;color:white;font-style:italic;">${projecaoAtiva.nomeCliente || 'Projeção'}</div>`
          : `<select id="sel-cliente" onchange="trocarCliente(parseInt(this.value))"
               style="background:transparent;border:none;color:white;font-size:22px;font-weight:800;font-style:italic;cursor:pointer;outline:none;text-align:center;max-width:500px;">
               ${GLR.clientes.map(c =>
                 `<option value="${c.id}" ${c.id === clienteIdAtivo ? 'selected' : ''}
                   style="background:#0d2144;font-style:normal;font-size:14px;">${c.nome}</option>`
               ).join('')}
             </select>`
        }
      </div>
      <div style="padding:10px 24px;text-align:center;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;">
        <input id="inp-mes-label" value="${projecaoAtiva.mes}"
          onchange="projecaoAtiva.mes=this.value;document.querySelectorAll('.mes-label').forEach(e=>e.textContent=this.value)"
          style="background:transparent;border:none;color:rgba(255,255,255,0.85);font-size:16px;font-weight:700;font-style:italic;outline:none;text-align:center;width:200px;">
        <button onclick="abrirVinculoProjecao()" style="background:rgba(99,102,241,0.25);border:1px solid rgba(99,102,241,0.5);color:#a5b4fc;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;">🔗 Vincular conta</button>
        <span id="lbl-atualizado" style="font-size:11px;color:rgba(255,255,255,0.55);background:rgba(255,255,255,0.08);padding:2px 10px;border-radius:99px;">${projecaoAtiva.atualizadoEm ? '🕓 Atualizado: ' + new Date(projecaoAtiva.atualizadoEm).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '🕓 Nunca salvo'}</span>
      </div>
    </div>


    <!-- Controles de período -->
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:8px;">
        <label style="font-size:12px;color:var(--text-muted);white-space:nowrap;">Faturamento Data Base</label>
        <input id="inp-data-base" class="form-input" type="date" value="2026-06-02" style="width:140px;padding:6px 10px;font-size:12px;" onchange="updateDataBase(this.value)">
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <label style="font-size:12px;color:var(--text-muted);">Dias decorridos</label>
        <input id="inp-dias-dec" class="form-input" type="number" value="${projecaoAtiva.diasDecorridos}" min="1" max="31" style="width:70px;padding:6px 10px;font-size:12px;" oninput="updateDias()">
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <label style="font-size:12px;color:var(--text-muted);">Dias no mês</label>
        <input id="inp-dias-mes" class="form-input" type="number" value="${projecaoAtiva.diasNoMes}" min="28" max="31" style="width:70px;padding:6px 10px;font-size:12px;" oninput="updateDias()">
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
        <button id="btn-toggle-glr" onclick="toggleGLRProjecao()"
          style="padding:5px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;
                 border:1px solid var(--border);background:var(--bg-surface);color:var(--text-muted);display:flex;align-items:center;gap:5px;">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Ocultar GLR
        </button>
        <button id="btn-buscar-proj" class="btn btn-sm" style="background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.3);color:#4ade80;" onclick="buscarDadosProjecao()" title="Busca ordens das contas vinculadas e atualiza os dados">🔄 Buscar dados</button>
        <button class="btn btn-secondary btn-sm" onclick="adicionarPlat()">+ Plataforma</button>
        <button class="btn btn-sm" style="background:rgba(248,113,113,0.12);border:1px solid rgba(248,113,113,0.3);color:#f87171;" onclick="limparDadosManuais()" title="Apaga fatBase, adsBase, vendasBase e histórico inseridos à mão — mantém só dados da API">🗑️ Limpar manuais</button>
        <button class="btn btn-primary btn-sm" onclick="salvarProjecao(this)">💾 Salvar</button>
        <button class="btn btn-ghost btn-sm" onclick="exportarProjecao()">📄 Exportar</button>
      </div>
    </div>

    <!-- KPIs resumo -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px;">
      <div class="kpi-card" style="padding:14px;">
        <div class="kpi-label">Projeção Faturamento</div>
        <div class="kpi-value" id="kpi-projecao" style="font-size:18px;">R$ —</div>
      </div>
      <div class="kpi-card" style="padding:14px;border-color:rgba(16,185,129,0.3);">
        <div class="kpi-label">Projeção de Vendas</div>
        <div class="kpi-value" id="kpi-vendas" style="font-size:22px;color:var(--green);">—</div>
        <div style="font-size:11px;color:var(--text-muted);">unidades projetadas</div>
      </div>
      <div id="kpi-glr-card" class="kpi-card" style="padding:14px;border-color:rgba(16,185,129,0.4);background:rgba(16,185,129,0.05);">
        <div class="kpi-label">💰 Receita GLR</div>
        <div class="kpi-value" id="kpi-receita-glr" style="font-size:18px;">—</div>
        <div style="font-size:11px;color:var(--text-muted);">vendas × valor por venda</div>
      </div>
      <div class="kpi-card" style="padding:14px;">
        <div class="kpi-label">Projeção ADS</div>
        <div class="kpi-value" id="kpi-ads" style="font-size:18px;color:#f59e0b;">R$ —</div>
      </div>
      <div class="kpi-card" style="padding:14px;">
        <div class="kpi-label">% ADS / Fat.</div>
        <div class="kpi-value" id="kpi-pct-ads" style="font-size:18px;">—</div>
      </div>
      <div class="kpi-card" style="padding:14px;">
        <div class="kpi-label">Evolução vs Mês Ant.</div>
        <div class="kpi-value" id="kpi-evo" style="font-size:18px;">—</div>
      </div>
    </div>

    <!-- Tabela principal -->
    <div class="card" style="padding:0;overflow:hidden;">
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:linear-gradient(135deg,#0d2144,#1a3a6e);">
              <th style="padding:12px 14px;text-align:left;color:white;font-weight:700;white-space:nowrap;min-width:150px;">Plataformas</th>
              <th style="padding:12px 14px;color:white;font-weight:700;white-space:nowrap;text-align:right;min-width:120px;">Fat. Data Base<br><span style="font-weight:400;opacity:0.8;font-size:10px;" id="th-data-base">02/06/2026</span><br><span id="th-cache-badge" style="font-size:9px;color:#818cf8;display:none;background:rgba(99,102,241,0.25);border-radius:3px;padding:1px 4px;">↺ API auto</span></th>
              <th style="padding:12px 14px;color:#a5f3fc;font-weight:800;white-space:nowrap;text-align:right;background:rgba(99,102,241,0.35);min-width:130px;">Projeção Fat.<br><span style="font-weight:400;font-size:10px;color:rgba(255,255,255,0.7);" class="mes-label">${projecaoAtiva.mes}</span></th>
              <th style="padding:12px 14px;color:#6ee7b7;font-weight:700;white-space:nowrap;text-align:right;background:rgba(16,185,129,0.15);min-width:110px;">Qtd. Vendas<br><span style="font-weight:400;opacity:0.8;font-size:10px;">Data Base</span></th>
              <th style="padding:12px 14px;color:#34d399;font-weight:800;white-space:nowrap;text-align:right;background:rgba(16,185,129,0.28);min-width:120px;">Proj. Vendas<br><span style="font-weight:400;font-size:10px;color:rgba(255,255,255,0.7);" class="mes-label">${projecaoAtiva.mes}</span></th>
              <th style="padding:12px 14px;color:#fde68a;font-weight:700;white-space:nowrap;text-align:right;background:rgba(245,158,11,0.15);min-width:110px;">ADS Investido<br><span style="font-weight:400;opacity:0.8;font-size:10px;">Data Base</span></th>
              <th style="padding:12px 14px;color:#fcd34d;font-weight:800;white-space:nowrap;text-align:right;background:rgba(245,158,11,0.25);min-width:120px;">Projeção ADS<br><span style="font-weight:400;font-size:10px;color:rgba(255,255,255,0.7);" class="mes-label">${projecaoAtiva.mes}</span></th>
              <th style="padding:12px 14px;color:white;font-weight:700;white-space:nowrap;text-align:center;min-width:80px;">% ADS<br>s/ Fat.</th>
              <th style="padding:12px 14px;color:white;font-weight:700;white-space:nowrap;text-align:center;min-width:100px;">Evolução<br>vs Mês Ant.</th>
              <th style="padding:12px 14px;color:white;font-weight:700;white-space:nowrap;text-align:right;min-width:110px;">Fat. Maio</th>
              <th style="padding:12px 14px;color:white;font-weight:700;white-space:nowrap;text-align:right;min-width:110px;">Fat. Abril</th>
              <th style="padding:12px 14px;color:white;font-weight:700;white-space:nowrap;text-align:right;min-width:110px;">Fat. Março</th>
              <th style="padding:12px 14px;width:36px;"></th>
            </tr>
          </thead>
          <tbody id="proj-tbody"></tbody>
          <tfoot id="proj-tfoot" style="border-top:2px solid rgba(99,102,241,0.4);"></tfoot>
        </table>
      </div>
      <div id="proj-diag" style="display:none;padding:10px 16px;font-size:12px;color:#f59e0b;border-top:1px solid rgba(245,158,11,0.2);"></div>
    </div>

    <!-- Gráfico evolução -->
    <div class="card" style="margin-top:20px;">
      <div class="section-header">
        <div class="section-title">📈 Evolução Histórica de Faturamento</div>
        <div class="section-subtitle">Últimos 3 meses + projeção atual</div>
      </div>
      <div class="chart-wrapper">
        <canvas id="chart-projecao-hist"></canvas>
      </div>
    </div>

    <!-- Observações -->
    <div class="card" style="margin-top:20px;">
      <div class="section-title mb-8">📝 Observações</div>
      <textarea id="proj-obs" class="form-textarea" placeholder="Notas sobre esta projeção, contexto de mercado, eventos especiais..." style="min-height:80px;">${projecaoAtiva.obs || ''}</textarea>
    </div>
  </div>`;

  // ---- Estilos dos inputs da tabela ----
  if (!document.getElementById('proj-styles')) {
    const st = document.createElement('style');
    st.id = 'proj-styles';
    st.textContent = `
      .proj-input { background:transparent; border:none; outline:none; color:var(--text-primary); font-size:13px; width:100%; min-width:80px; padding:2px 4px; text-align:right; }
      .proj-input:focus { background:rgba(99,102,241,0.1); border-radius:4px; }
      .proj-input:not(.money) { text-align:left; }
      .proj-auto { color:#818cf8 !important; }
      #proj-tbody td, #proj-tfoot td { padding:10px 14px; border-bottom:1px solid var(--border); vertical-align:middle; }
      #proj-tbody tr:hover { background:rgba(255,255,255,0.02); }
      #proj-tfoot td { padding:12px 14px; font-size:13.5px; color:var(--text-primary); }
    `;
    document.head.appendChild(st);
  }

  // ---- Handlers ----
  window.limparDadosManuais = () => {
    if (!confirm('Limpar todos os dados inseridos manualmente (faturamento base, ADS, vendas e histórico)? Os dados da API continuam visíveis automaticamente.')) return;
    projecaoAtiva.plataformas = projecaoAtiva.plataformas.map(p => ({
      nome: p.nome,
      fatBase: '', adsBase: '', vendasBase: '',
      maio: '', abril: '', marco: '',
    }));
    salvar();
    renderTabela();
    atualizarGrafico();
  };

  window.updatePlat = (i, campo, valor) => {
    projecaoAtiva.plataformas[i][campo] = valor;
    salvar(); // auto-save ao editar qualquer campo
    renderTabela();
    atualizarGrafico();
  };

  window.removePlat = (i) => {
    if (projecaoAtiva.plataformas.length <= 1) return;
    projecaoAtiva.plataformas.splice(i, 1);
    renderTabela();
    atualizarGrafico();
  };

  window.toggleGLRProjecao = () => {
    ocultarGLR = !ocultarGLR;
    // Atualiza o botão
    const btn = document.getElementById('btn-toggle-glr');
    if (btn) {
      if (ocultarGLR) {
        btn.innerHTML = `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg> GLR oculta`;
        btn.style.borderColor = 'rgba(251,191,36,.5)';
        btn.style.background  = 'rgba(251,191,36,.12)';
        btn.style.color       = '#fbbf24';
      } else {
        btn.innerHTML = `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Ocultar GLR`;
        btn.style.borderColor = '';
        btn.style.background  = '';
        btn.style.color       = '';
      }
    }
    // Oculta/mostra o KPI card
    const kpiCard = document.getElementById('kpi-glr-card');
    if (kpiCard) kpiCard.style.display = ocultarGLR ? 'none' : '';
    // Re-renderiza a tabela (inclui os sub-labels GLR nas linhas e no footer)
    renderTabela();
  };

  window.buscarDadosProjecao = buscarDadosProjecao;

  window.adicionarPlat = () => {
    projecaoAtiva.plataformas.push({ nome: 'Nova Plataforma', fatBase: '', ads: '', maio: '', abril: '', marco: '' });
    renderTabela();
  };

  window.updateDias = () => {
    projecaoAtiva.diasDecorridos = parseInt(document.getElementById('inp-dias-dec').value) || projecaoAtiva.diasDecorridos;
    projecaoAtiva.diasNoMes = parseInt(document.getElementById('inp-dias-mes').value) || projecaoAtiva.diasNoMes;
    salvar(); // auto-save ao alterar dias
    renderTabela();
    atualizarGrafico();
  };

  window.updateDataBase = (dataStr) => {
    if (!dataStr) return;
    const d = new Date(dataStr + 'T12:00:00');
    const dia = d.getDate();
    projecaoAtiva.diasDecorridos = dia;
    document.getElementById('inp-dias-dec').value = dia;
    const thdb = document.getElementById('th-data-base');
    if (thdb) thdb.textContent = d.toLocaleDateString('pt-BR');
    renderTabela();
    atualizarGrafico();
  };

  window.salvarProjecao = (btn) => {
    projecaoAtiva.obs = document.getElementById('proj-obs')?.value || '';
    projecaoAtiva.atualizadoEm = new Date().toISOString();
    const lblAtt = document.getElementById('lbl-atualizado');
    if (lblAtt) lblAtt.textContent = '🕓 Atualizado: ' + new Date().toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});

    // ── Lê diasDecorridos/diasNoMes dos campos ao vivo ──────────────
    const dd = parseInt(document.getElementById('inp-dias-dec')?.value) || projecaoAtiva.diasDecorridos || 2;
    const dm = parseInt(document.getElementById('inp-dias-mes')?.value) || projecaoAtiva.diasNoMes     || 30;
    projecaoAtiva.diasDecorridos = dd;
    projecaoAtiva.diasNoMes      = dm;

    // ── Qual cliente está selecionado AGORA no select ───────────────
    const selEl    = document.getElementById('sel-cliente');
    const cidAtual = selEl ? parseInt(selEl.value) : clienteIdAtivo;

    // ── Calcula totais ───────────────────────────────────────────────
    const plats       = projecaoAtiva.plataformas;
    const fatProj     = plats.reduce((s,p) => s + calcProjecao(p.fatBase,    dd, dm), 0);
    const vendasProj  = plats.reduce((s,p) => s + calcProjecao(p.vendasBase, dd, dm), 0);
    const adsProj     = plats.reduce((s,p) => s + calcProjecao(p.adsBase,    dd, dm), 0);
    const fatMaio  = plats.reduce((s,p) => s + (parseFloat(p.maio)  || 0), 0);
    const fatAbril = plats.reduce((s,p) => s + (parseFloat(p.abril) || 0), 0);
    const fatMarco = plats.reduce((s,p) => s + (parseFloat(p.marco) || 0), 0);
    const crescimento = fatMaio > 0
      ? parseFloat(((fatProj - fatMaio) / fatMaio * 100).toFixed(1))
      : 0;
    const mesLabel = projecaoAtiva.mes || 'Junho 2026';

    // ── Sincroniza com GLR.clientes (lê e salva no localStorage) ────
    if (cidAtual && !isNaN(cidAtual)) {
      // Sempre relê do localStorage para ter a versão mais recente
      let clientes = [];
      try { clientes = JSON.parse(localStorage.getItem('glr_clientes') || '[]'); } catch(e) {}

      const idx = clientes.findIndex(c => c.id === cidAtual);

      if (idx === -1) {
        console.warn('[GLR] Cliente ID', cidAtual, 'não encontrado no localStorage. Clientes:', clientes.map(c=>c.id));
      } else {
        const cli = clientes[idx];

        cli.faturamento       = Math.round(fatProj);
        cli.vendasProjetadas  = Math.round(vendasProj);
        cli.investimentoMidia = Math.round(adsProj);
        cli.crescimento       = crescimento;

        // Status automático
        if      (crescimento >=  5) cli.status = 'crescimento';
        else if (crescimento >=  0) cli.status = 'ativo';
        else if (crescimento >= -10) cli.status = 'queda';
        else                        cli.status = 'risco';

        // Histórico mensal
        if (!cli.historico) cli.historico = [];
        const ordemMeses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

        const upsertMes = (mesNome, fat, ads) => {
          if (!fat) return;
          const ei = cli.historico.findIndex(h => h.mes === mesNome);
          const obj = { mes: mesNome, faturamento: Math.round(fat), ads: Math.round(ads), meta: 0 };
          if (ei >= 0) cli.historico[ei] = obj;
          else cli.historico.push(obj);
        };

        upsertMes(mesLabel, fatProj, adsProj);
        upsertMes('Maio',  fatMaio,  plats.reduce((s,p)=>s+(parseFloat(p.adsBase)||0),0));
        upsertMes('Abril', fatAbril, 0);
        upsertMes('Março', fatMarco, 0);

        cli.historico.sort((a,b) => {
          const ia = ordemMeses.findIndex(m => a.mes.startsWith(m));
          const ib = ordemMeses.findIndex(m => b.mes.startsWith(m));
          return ia - ib;
        });

        clientes[idx] = cli;

        // Salva no localStorage E atualiza memória
        localStorage.setItem('glr_clientes', JSON.stringify(clientes));
        GLR.clientes = clientes;

        console.log('[GLR] Sync OK → Cliente:', cli.nome, '| Fat:', cli.faturamento, '| Cresc:', cli.crescimento, '%');
      }
    } else {
      console.warn('[GLR] Nenhum cliente selecionado para sync. cidAtual=', cidAtual);
    }

    // ── Salva a projeção ─────────────────────────────────────────────
    salvar();

    // Feedback no botão
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✅ Salvo!';
      btn.style.background = 'var(--green)';
      setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 2000);
    }

    // Mini-toast de confirmação
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;background:#10b981;color:white;padding:12px 20px;border-radius:10px;font-size:13.5px;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.3);animation:fadeIn 0.2s ease;`;
    toast.innerHTML = `✅ Projeção salva — dados sincronizados com o cliente`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  };

  window.exportarProjecao = () => {
    const dd = projecaoAtiva.diasDecorridos;
    const dm = projecaoAtiva.diasNoMes;
    const plats = projecaoAtiva.plataformas;
    const mesLabel = projecaoAtiva.mes || 'Projeção';
    let csv = `Plataforma;Fat. Base;Projeção ${mesLabel};ADS Investido Base;Projeção ADS;% ADS s/ Fat.;Evolução Mês Ant.;Fat. Maio;Fat. Abril;Fat. Março\n`;
    plats.forEach(p => {
      const proj    = calcProjecao(p.fatBase, dd, dm);
      const adsProj = calcProjecao(p.adsBase, dd, dm);
      const pctAds  = proj > 0 && adsProj > 0 ? (adsProj/proj*100).toFixed(2)+'%' : '';
      const evo     = calcEvolucao(proj, p.maio);
      csv += [p.nome, fmtBRL(parseFloat(p.fatBase)||0), fmtBRL(proj), fmtBRL(parseFloat(p.adsBase)||0), fmtBRL(adsProj), pctAds, fmtPct(evo), fmtBRL(parseFloat(p.maio)||0), fmtBRL(parseFloat(p.abril)||0), fmtBRL(parseFloat(p.marco)||0)].join(';') + '\n';
    });
    const blob = new Blob(['﻿'+csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const nome = (projecaoAtiva.nomeCliente || 'cliente').replace(/\s/g,'_');
    a.href = url; a.download = `projecao_${nome}_${mesLabel.replace(/\s/g,'_')}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  window.trocarCliente = (novoId) => {
    // 1. Salva o cliente atual antes de sair
    salvar();

    // 2. Recarrega projeções do localStorage (já inclui o que acabou de salvar)
    try { projecoes = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch(e) {}

    // 3. Atualiza o cliente ativo
    clienteIdAtivo = parseInt(novoId) || novoId;

    // 4. Carrega (ou cria em branco) a projeção do novo cliente
    projecaoAtiva = projecoes.find(p => parseInt(p.chave) === clienteIdAtivo || p.chave === String(clienteIdAtivo)) || null;
    if (!projecaoAtiva) {
      const clienteObj = GLR.clientes.find(c => c.id === clienteIdAtivo);
      projecaoAtiva = {
        chave:          String(clienteIdAtivo),
        nomeCliente:    clienteObj?.nome || '',
        mes:            'Junho 2026',
        diasNoMes:      30,
        diasDecorridos: 2,
        obs:            '',
        plataformas: [
          { nome: 'Shopee',        fatBase: '', adsBase: '', vendasBase: '', maio: '', abril: '', marco: '' },
          { nome: 'Mercado Livre', fatBase: '', adsBase: '', vendasBase: '', maio: '', abril: '', marco: '' },
        ]
      };
    }

    // 5. Re-renderiza a página inteira no mesmo elemento
    Router.currentParams = { clienteId: clienteIdAtivo };
    const pageEl = document.getElementById('page-content');
    if (pageEl) {
      pageEl.innerHTML = '';
      Router.routes['projecao'](Router.currentParams, pageEl);
    }
  };

  window.abrirVinculoProjecao = async () => {
    const cidAtivo = parseInt(document.getElementById('sel-cliente')?.value) || clienteIdAtivo;
    const cliente  = GLR.clientes.find(c => c.id === cidAtivo);
    if (!cidAtivo) { alert('Selecione um cliente primeiro.'); return; }

    // Mostrar loading enquanto busca contas da API
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `<div style="background:var(--bg-surface);border-radius:14px;padding:40px 48px;text-align:center;color:var(--text-muted);font-size:14px;">⏳ Carregando contas...</div>`;
    document.body.appendChild(overlay);

    let vinculos = {};
    try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos')||'{}'); } catch(e) {}
    let contas = [];
    try {
      const r = await MarketplaceAPI.call('list_accounts');
      contas = r.data?.accounts || [];
    } catch(e) {
      // fallback para localStorage
      try { contas = JSON.parse(localStorage.getItem('glr_mc_accounts')||'[]'); } catch(e2) {}
    }

    const vinculadas = vinculos[String(cidAtivo)] || [];
    const vinculadasIds = new Set(vinculadas.map(c => c.external_id));

    const nicks = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();
    const platIcon = { mercadolivre:'🟡', ml:'🟡', meli:'🟡', shopee:'🟠', bling:'🔵' };
    const platNome = { mercadolivre:'Mercado Livre', ml:'Mercado Livre', meli:'Mercado Livre', shopee:'Shopee', bling:'Bling' };

    const renderModalBody = () => {
      const contasDisponiveis = contas.filter(c => !vinculadasIds.has(c.external_id));
      overlay.innerHTML = `
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:14px;padding:28px 32px;max-width:520px;width:92%;box-shadow:0 20px 60px rgba(0,0,0,0.5);max-height:85vh;overflow-y:auto;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
            <div>
              <div style="font-size:16px;font-weight:800;color:var(--text-primary);">🔗 Contas vinculadas</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${cliente?.nome || 'Cliente #'+cidAtivo}</div>
            </div>
            <button id="btn-fechar-vinculos" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-muted);">✕</button>
          </div>

          ${vinculadas.length === 0
            ? `<div style="padding:16px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;font-size:13px;color:#f59e0b;margin-bottom:16px;">⚠️ Nenhuma conta vinculada ainda</div>`
            : `<div style="margin-bottom:16px;">
                <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Contas vinculadas (${vinculadas.length})</div>
                <div style="display:flex;flex-direction:column;gap:8px;">
                  ${vinculadas.map(c => {
                    const tag = (c.tags||[]).map(t=>t.name||t.value).filter(Boolean).join(' · ');
                    const nick = nicks[c.external_id] || '';
                    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-base);border:1px solid rgba(34,197,94,0.3);border-radius:8px;">
                      <span style="font-size:16px;">${platIcon[c.marketplace]||'🏪'}</span>
                      <div style="flex:1;min-width:0;">
                        <div style="font-size:12px;font-weight:600;">${nick || tag || platNome[c.marketplace]||c.marketplace}</div>
                        <div style="font-size:10px;color:var(--text-muted);">ID: ${c.external_id}</div>
                      </div>
                      <button onclick="window._desvincularProj('${c.external_id}')" style="background:rgba(239,68,68,0.15);border:none;color:#ef4444;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;">✕ remover</button>
                    </div>`;
                  }).join('')}
                </div>
              </div>`
          }

          ${contasDisponiveis.length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Adicionar conta</div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${contasDisponiveis.map(c => {
                const tag = (c.tags||[]).map(t=>t.name||t.value).filter(Boolean).join(' · ');
                const nick = nicks[c.external_id] || '';
                return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:8px;">
                  <span style="font-size:16px;">${platIcon[c.marketplace]||'🏪'}</span>
                  <div style="flex:1;min-width:0;">
                    <div style="font-size:12px;font-weight:600;">${nick || tag || platNome[c.marketplace]||c.marketplace}</div>
                    <div style="font-size:10px;color:var(--text-muted);">ID: ${c.external_id}</div>
                    ${tag ? `<div style="font-size:10px;color:#818cf8;">${tag}</div>` : ''}
                  </div>
                  <button onclick="window._vincularProj('${c.external_id}')" style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.4);color:#a5b4fc;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;">+ vincular</button>
                </div>`;
              }).join('')}
            </div>
          </div>` : `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:8px;">Todas as contas disponíveis já estão vinculadas.</div>`}

          <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;">
            <button id="btn-fechar-vinculos2" style="padding:8px 20px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card-hover);color:var(--text-primary);font-weight:600;cursor:pointer;">Fechar</button>
          </div>
        </div>`;

      const fecharVinculos = () => {
        overlay.remove();
        // Auto-adiciona linhas para plataformas vinculadas que ainda não existem na tabela
        const platMap = { mercadolivre:'Mercado Livre', ml:'Mercado Livre', meli:'Mercado Livre', shopee:'Shopee', bling:'Bling' };
        const vinculadasAtual = (vinculos[String(cidAtivo)] || []);
        const platsExistentes = new Set((projecaoAtiva.plataformas || []).map(p => (p.nome||'').toLowerCase()));
        vinculadasAtual.forEach(c => {
          const mkt = (c.marketplace || '').toLowerCase();
          const nomePlat = platMap[mkt] || (c.marketplace ? c.marketplace.charAt(0).toUpperCase() + c.marketplace.slice(1) : null);
          if (nomePlat && !platsExistentes.has(nomePlat.toLowerCase())) {
            projecaoAtiva.plataformas.push({ nome: nomePlat, fatBase:'', adsBase:'', vendasBase:'', maio:'', abril:'', marco:'' });
            platsExistentes.add(nomePlat.toLowerCase());
          }
        });
        renderTabela();
      };
      document.getElementById('btn-fechar-vinculos').onclick  = fecharVinculos;
      document.getElementById('btn-fechar-vinculos2').onclick = fecharVinculos;
    };

    window._vincularProj = (extId) => {
      const conta = contas.find(c => c.external_id === extId);
      if (!conta) return;
      if (!vinculos[String(cidAtivo)]) vinculos[String(cidAtivo)] = [];
      if (!vinculos[String(cidAtivo)].some(c => c.external_id === extId)) {
        vinculos[String(cidAtivo)].push(conta);
        localStorage.setItem('glr_mc_vinculos', JSON.stringify(vinculos));
        vinculadasIds.add(extId);
        vinculadas.push(conta);
      }
      renderModalBody();
    };

    window._desvincularProj = (extId) => {
      if (!vinculos[String(cidAtivo)]) return;
      vinculos[String(cidAtivo)] = vinculos[String(cidAtivo)].filter(c => c.external_id !== extId);
      localStorage.setItem('glr_mc_vinculos', JSON.stringify(vinculos));
      vinculadasIds.delete(extId);
      const idx = vinculadas.findIndex(c => c.external_id === extId);
      if (idx > -1) vinculadas.splice(idx, 1);
      renderModalBody();
    };

    renderModalBody();
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); renderTabela(); } });
  };

  window.novaProjecao = () => {
    const nome = prompt('Nome do cliente para a nova projeção:');
    if (!nome) return;
    const chave = 'proj_' + Date.now();
    const nova = {
      chave, nomeCliente: nome.trim(), mes: 'Junho 2026',
      diasNoMes: 30, diasDecorridos: 2, obs: '',
      plataformas: [
        { nome: 'Shopee',        fatBase: '', ads: '', maio: '', abril: '', marco: '' },
        { nome: 'Mercado Livre', fatBase: '', ads: '', maio: '', abril: '', marco: '' },
      ]
    };
    projecoes.push(nova);
    localStorage.setItem(storageKey, JSON.stringify(projecoes));
    Router.navigate('projecao', { clienteId: chave });
  };

  function atualizarGrafico() {
    const dd = projecaoAtiva.diasDecorridos;
    const dm = projecaoAtiva.diasNoMes;
    const plats = projecaoAtiva.plataformas;
    const totMaio = plats.reduce((s,p) => s+(parseFloat(p.maio)||0),0);
    const totAbril = plats.reduce((s,p) => s+(parseFloat(p.abril)||0),0);
    const totMarco = plats.reduce((s,p) => s+(parseFloat(p.marco)||0),0);
    const totProj = plats.reduce((s,p) => s+calcProjecao(p.fatBase,dd,dm),0);

    const ctx = document.getElementById('chart-projecao-hist');
    if (!ctx) return;
    if (window._chartProjecao) { window._chartProjecao.destroy(); }
    window._chartProjecao = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Março', 'Abril', 'Maio', `Projeção ${projecaoAtiva.mes}`],
        datasets: [{
          data: [totMarco, totAbril, totMaio, totProj],
          backgroundColor: ['rgba(99,102,241,0.4)','rgba(99,102,241,0.5)','rgba(99,102,241,0.65)','rgba(99,102,241,0.9)'],
          borderColor: ['#6366f1','#6366f1','#6366f1','#818cf8'],
          borderWidth: 1,
          borderRadius: 6,
        }]
      },
      options: {
        ...chartDefaults(),
        plugins: { legend: { display: false }, tooltip: tooltipStyle() }
      }
    });
  }

  renderTabela();
  setTimeout(atualizarGrafico, 50);
});

// ---- Relatórios ----
Router.register('relatorios', (params, el) => {
  if (!GLR.clientes.length) {
    el.innerHTML = `<div class="page"><div style="text-align:center;padding:80px 24px;">
      <div style="font-size:40px;margin-bottom:12px;">📄</div>
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">Nenhum cliente cadastrado</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">Cadastre clientes para gerar relatórios.</div>
      <button class="btn btn-primary" onclick="Router.navigate('clientes')">Cadastrar cliente</button>
    </div></div>`;
    return;
  }

  let clienteSel = GLR.clientes[0].id;

  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                 'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const hoje    = new Date();
  const mesAtual = meses[hoje.getMonth()];
  const anoAtual = hoje.getFullYear();

  function getProjecaoCliente(cid) {
    try {
      const projs = JSON.parse(localStorage.getItem('glr_projecoes') || '[]');
      return projs.find(p => parseInt(p.chave) === parseInt(cid)) || null;
    } catch(e) { return null; }
  }

  function getDREsCliente(cid) {
    try {
      const dres = JSON.parse(localStorage.getItem('glr_dre') || '[]');
      return dres.filter(d => parseInt(d.clienteId) === parseInt(cid));
    } catch(e) { return []; }
  }

  function fmtFull(v) {
    return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0);
  }
  function fmtN2(v) {
    return new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2}).format(v||0);
  }

  function renderRelatorio() {
    const c = GLR.clientes.find(cl => cl.id === parseInt(clienteSel));
    if (!c) return '<div style="padding:40px;text-align:center;color:var(--text-muted);">Cliente não encontrado</div>';

    // Dados de projeção
    const proj  = getProjecaoCliente(c.id);
    const plats = proj?.plataformas || [];
    const dd    = proj?.diasDecorridos || 1;
    const dm    = proj?.diasNoMes || 30;

    function calcProj(base) { return base && dd ? (parseFloat(base)/dd)*dm : 0; }

    const fatProj    = plats.reduce((s,p) => s + calcProj(p.fatBase), 0);
    const adsProj    = plats.reduce((s,p) => s + calcProj(p.adsBase), 0);
    const vendasProj = plats.reduce((s,p) => s + calcProj(p.vendasBase), 0);
    const receitaGLR = Math.round(vendasProj) * (parseFloat(c.valorPorVenda) || 0);
    const pctADS     = fatProj > 0 ? (adsProj / fatProj) * 100 : 0;
    const ticketMedio = vendasProj > 0 ? fatProj / vendasProj : 0;

    const mesAnoAtual = mesAtual + ' ' + anoAtual;

    // DREs do cliente
    const dres = getDREsCliente(c.id);
    const dreRecente = dres.sort((a,b)=>b.ano!==a.ano?b.ano-a.ano:b.mes-a.mes)[0];

    // "Atual" = soma do faturamento real inserido no DRE do mês corrente
    const dresAtual = dres.filter(d => d.mes === hoje.getMonth() && d.ano === hoje.getFullYear());
    const fatAtual  = dresAtual.reduce((s, d) => s + (parseFloat(d.valores?.faturamento) || 0), 0);

    // Histórico de meses anteriores — vem do c.historico (salvo pela projeção)
    const histAnteriores = (c.historico || [])
      .filter(h => parseFloat(h.faturamento) > 0)
      .sort((a, b) => {
        const [mA, aA] = a.mes.split(' '); const [mB, aB] = b.mes.split(' ');
        const iA = meses.indexOf(mA) + parseInt(aA) * 12;
        const iB = meses.indexOf(mB) + parseInt(aB) * 12;
        return iB - iA;
      })
      .filter(h => h.mes !== mesAnoAtual)
      .slice(0, 4);

    // Referência para comparação dos meses anteriores: real (DRE) ou projeção
    const refComparativo = fatAtual || fatProj;

    // Ações, tarefas, oportunidades filtradas por cliente
    const acoes = GLR.acoes.filter(a => a.cliente === c.nome || String(a.clienteId) === String(c.id));
    const tarefasPend = GLR.tarefas.filter(t => (t.cliente === c.nome || String(t.clienteId) === String(c.id)) && t.status !== 'concluida');
    const tarefasConc = GLR.tarefas.filter(t => (t.cliente === c.nome || String(t.clienteId) === String(c.id)) && t.status === 'concluida');
    const opps = GLR.oportunidades.filter(o => o.cliente === c.nome || String(o.clienteId) === String(c.id));

    const statusColor = { crescimento:'#10b981', ativo:'#6366f1', queda:'#f97316', risco:'#ef4444' };
    const sc = statusColor[c.status] || '#6366f1';

    return `
    <div id="relatorio-preview" style="background:white;color:#111;border-radius:12px;padding:40px;max-width:820px;margin:0 auto;font-family:'Inter',sans-serif;">

      <!-- Cabeçalho -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:20px;border-bottom:3px solid #1a2744;">
        <div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Relatório de Gestão · Confidencial</div>
          <div style="font-size:26px;font-weight:800;color:#1a2744;">${c.nome}</div>
          <div style="font-size:13px;color:#666;margin-top:4px;">${mesAtual} ${anoAtual} · Gerado em ${new Date().toLocaleDateString('pt-BR')}</div>
          <div style="margin-top:8px;">
            <span style="background:${sc}22;color:${sc};border:1px solid ${sc}44;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;">${GLR.statusLabel[c.status]||c.status}</span>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="width:60px;height:60px;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:white;margin-left:auto;">${c.nome.charAt(0)}</div>
          <div style="font-size:12px;color:#888;margin-top:8px;">Gestor: <strong style="color:#333;">${c.gestor||'—'}</strong></div>
          <div style="font-size:12px;color:#888;">Responsável: <strong style="color:#333;">${c.responsavel||'—'}</strong></div>
          ${c.valorPorVenda ? `<div style="font-size:12px;color:#888;">Valor por Venda: <strong style="color:#333;">${fmtFull(c.valorPorVenda)}</strong></div>` : ''}
        </div>
      </div>

      <!-- KPIs da Projeção -->
      ${plats.length ? `
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:14px;color:#1a2744;">📊 Projeção do Mês — ${proj?.mes || mesAtual+' '+anoAtual}</div>
        <div style="display:grid;grid-template-columns:repeat(${receitaGLR>0?5:4},1fr);gap:10px;">
          ${[
            { l:'Faturamento Projetado', v: fmtFull(fatProj), icon:'💰', c:'#6366f1' },
            { l:'Vendas Projetadas',     v: Math.round(vendasProj).toLocaleString('pt-BR'), icon:'📦', c:'#10b981' },
            { l:'Ticket Médio',          v: ticketMedio>0 ? fmtFull(ticketMedio) : '—', icon:'🧾', c:'#06b6d4' },
            { l:'Investimento ADS',      v: fmtFull(adsProj), icon:'📢', c:'#f59e0b' },
            ...(receitaGLR>0 ? [{ l:'Receita GLR', v: fmtFull(receitaGLR), icon:'🏆', c:'#10b981' }] : []),
          ].map(k=>`
            <div style="background:#f8f9fc;border:1px solid #e5e7eb;border-radius:8px;padding:14px;text-align:center;">
              <div style="font-size:20px;margin-bottom:4px;">${k.icon}</div>
              <div style="font-size:15px;font-weight:800;color:${k.c};">${k.v}</div>
              <div style="font-size:10px;color:#888;margin-top:2px;text-transform:uppercase;letter-spacing:0.3px;">${k.l}</div>
            </div>`).join('')}
        </div>
        ${pctADS>0?`<div style="margin-top:10px;font-size:12px;color:#888;text-align:right;">% ADS sobre Faturamento: <strong style="color:#f59e0b;">${pctADS.toFixed(1)}%</strong> · Dias decorridos: <strong>${dd}</strong> de <strong>${dm}</strong></div>`:''}
      </div>` : `
      <div style="margin-bottom:24px;padding:16px;background:#f8f9fc;border-radius:8px;text-align:center;color:#888;font-size:13px;">
        Nenhuma projeção cadastrada para este cliente. <a href="#projecao" style="color:#6366f1;">Cadastrar projeção</a>
      </div>`}

      <!-- Plataformas -->
      ${plats.length ? `
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#1a2744;">🏪 Desempenho por Plataforma</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#1a2744;color:white;">
              <th style="padding:9px 12px;text-align:left;border-radius:6px 0 0 0;">Plataforma</th>
              <th style="padding:9px 12px;text-align:right;">Fat. Base</th>
              <th style="padding:9px 12px;text-align:right;">Projeção Fat.</th>
              <th style="padding:9px 12px;text-align:right;">Vendas Base</th>
              <th style="padding:9px 12px;text-align:right;">ADS Base</th>
              <th style="padding:9px 12px;text-align:right;border-radius:0 6px 0 0;">% ADS</th>
            </tr>
          </thead>
          <tbody>
            ${plats.map((p,i)=>{
              const fat  = parseFloat(p.fatBase)||0;
              const proj = calcProj(p.fatBase);
              const ads  = parseFloat(p.adsBase)||0;
              const pADS = proj>0?(calcProj(p.adsBase)/proj)*100:0;
              return `<tr style="background:${i%2===0?'#f8f9fc':'white'};">
                <td style="padding:9px 12px;font-weight:600;">${p.nome||'—'}</td>
                <td style="padding:9px 12px;text-align:right;">${fat>0?fmtFull(fat):'—'}</td>
                <td style="padding:9px 12px;text-align:right;font-weight:700;color:#6366f1;">${proj>0?fmtFull(proj):'—'}</td>
                <td style="padding:9px 12px;text-align:right;">${p.vendasBase>0?Math.round(parseFloat(p.vendasBase)).toLocaleString('pt-BR'):'—'}</td>
                <td style="padding:9px 12px;text-align:right;">${ads>0?fmtFull(ads):'—'}</td>
                <td style="padding:9px 12px;text-align:right;color:#f59e0b;">${pADS>0?pADS.toFixed(1)+'%':'—'}</td>
              </tr>`;
            }).join('')}
            <tr style="background:#1a274411;font-weight:700;">
              <td style="padding:9px 12px;">Total</td>
              <td style="padding:9px 12px;text-align:right;">${fmtFull(plats.reduce((s,p)=>s+(parseFloat(p.fatBase)||0),0))}</td>
              <td style="padding:9px 12px;text-align:right;color:#6366f1;">${fmtFull(fatProj)}</td>
              <td style="padding:9px 12px;text-align:right;">${Math.round(plats.reduce((s,p)=>s+(parseFloat(p.vendasBase)||0),0)).toLocaleString('pt-BR')}</td>
              <td style="padding:9px 12px;text-align:right;">${fmtFull(plats.reduce((s,p)=>s+(parseFloat(p.adsBase)||0),0))}</td>
              <td style="padding:9px 12px;text-align:right;color:#f59e0b;">${pctADS>0?pctADS.toFixed(1)+'%':'—'}</td>
            </tr>
          </tbody>
        </table>
      </div>` : ''}

      <!-- Comparativo de Faturamento -->
      ${(fatAtual > 0 || fatProj > 0 || histAnteriores.length > 0) ? `
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:14px;color:#1a2744;">📅 Comparativo de Faturamento — ${mesAnoAtual}</div>

        ${(()=>{
          // Monta todas as linhas: Atual + Projeção + meses anteriores
          const linhas = [];
          if (fatAtual > 0)  linhas.push({ label: 'Atual',     sub: 'realizado',  v: fatAtual, color: '#1a2744' });
          if (fatProj > 0) {
            const diffProj = fatAtual > 0 ? ((fatProj - fatAtual) / fatAtual) * 100 : 0;
            linhas.push({ label: 'Projeção', sub: mesAnoAtual, v: fatProj, color: '#6366f1',
              badge: fatAtual > 0 ? (diffProj >= 0 ? `▲ +${diffProj.toFixed(1)}% vs atual` : `▼ ${diffProj.toFixed(1)}% vs atual`) : '← projeção do mês',
              badgeColor: fatAtual > 0 ? (diffProj >= 0 ? '#10b981' : '#ef4444') : '#6366f1' });
          }
          histAnteriores.forEach(h => {
            const ref  = refComparativo;
            const diff = ref > 0 ? ((ref - parseFloat(h.faturamento)) / parseFloat(h.faturamento)) * 100 : 0;
            const subiu = diff >= 0;
            linhas.push({ label: h.mes, sub: '', v: parseFloat(h.faturamento), color: subiu ? '#10b981' : '#ef4444',
              badge: ref > 0 ? (subiu ? `▲ +${diff.toFixed(1)}%` : `▼ ${diff.toFixed(1)}%`) : '',
              badgeColor: subiu ? '#10b981' : '#ef4444' });
          });

          if (!linhas.length) return '<div style="color:#888;font-size:13px;">Nenhum dado de faturamento disponível.</div>';

          const maxV = Math.max(...linhas.map(l => l.v));
          return linhas.map(l => {
            const pct = maxV > 0 ? (l.v / maxV) * 100 : 0;
            return `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
              <div style="width:100px;text-align:right;flex-shrink:0;">
                <div style="font-size:12px;font-weight:600;color:#333;">${l.label}</div>
                ${l.sub ? `<div style="font-size:10px;color:#888;">${l.sub}</div>` : ''}
              </div>
              <div style="flex:1;background:#f0f0f5;border-radius:6px;height:28px;overflow:hidden;">
                <div style="width:${pct.toFixed(1)}%;min-width:${l.v>0?'60px':'0'};height:100%;background:${l.color};border-radius:6px;display:flex;align-items:center;padding:0 10px;box-sizing:border-box;">
                  <span style="font-size:11px;font-weight:700;color:white;white-space:nowrap;">${fmtFull(l.v)}</span>
                </div>
              </div>
              <div style="width:130px;font-size:11px;font-weight:700;color:${l.badgeColor||l.color};flex-shrink:0;">
                ${l.badge || ''}
              </div>
            </div>`;
          }).join('');
        })()}
      </div>` : ''}

      <!-- DRE mais recente -->
      ${dreRecente ? `
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#1a2744;">📑 DRE — ${meses[dreRecente.mes]} ${dreRecente.ano} · ${dreRecente.plataforma}</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          ${[
            { l:'Faturamento', v: dreRecente.valores.faturamento, receita: true },
            { l:'Comissão e Frete', v: dreRecente.valores.comissaoFrete },
            { l:'Produtos', v: dreRecente.valores.produtos },
            { l:'ADS', v: dreRecente.valores.ads },
            { l:'Imposto', v: dreRecente.valores.imposto },
            { l:'Juros', v: dreRecente.valores.juros },
            { l:'Custo Fixo', v: dreRecente.valores.custoFixo },
            { l:'Comissão GLR', v: dreRecente.valores.comissaoGLR },
          ].filter(r=>parseFloat(r.v)>0).map((r,i)=>{
            const fat = parseFloat(dreRecente.valores.faturamento)||0;
            const pct = fat>0?((parseFloat(r.v)||0)/fat*100):0;
            return `<tr style="background:${i%2===0?'#f8f9fc':'white'};">
              <td style="padding:8px 12px;font-style:italic;${r.receita?'font-weight:700;':''}">${r.l}</td>
              <td style="padding:8px 12px;text-align:right;${r.receita?'font-weight:700;':''}">${fmtFull(parseFloat(r.v)||0)}</td>
              <td style="padding:8px 12px;text-align:right;color:#888;">${pct.toFixed(2)}%</td>
            </tr>`;
          }).join('')}
          ${(()=>{
            const fat = parseFloat(dreRecente.valores.faturamento)||0;
            const custos = ['comissaoFrete','produtos','ads','imposto','juros','custoFixo','comissaoGLR'].reduce((s,k)=>s+(parseFloat(dreRecente.valores[k])||0),0);
            const res = fat-custos;
            const pct = fat>0?(res/fat*100):0;
            return `<tr style="background:#1a274411;font-weight:700;font-size:14px;">
              <td style="padding:10px 12px;">Resultado</td>
              <td style="padding:10px 12px;text-align:right;color:${res>=0?'#10b981':'#ef4444'};">${fmtFull(res)}</td>
              <td style="padding:10px 12px;text-align:right;color:${res>=0?'#10b981':'#ef4444'};">${pct.toFixed(2)}%</td>
            </tr>`;
          })()}
        </table>
        ${dreRecente.valores.produtosVendidos>0?`
        <div style="margin-top:10px;display:flex;gap:16px;font-size:12px;color:#888;">
          <span>Produtos Vendidos: <strong style="color:#333;">${Math.round(dreRecente.valores.produtosVendidos)}</strong></span>
          ${dreRecente.valores.faturamento>0&&dreRecente.valores.produtosVendidos>0?`<span>Ticket Médio: <strong style="color:#333;">${fmtFull(parseFloat(dreRecente.valores.faturamento)/parseFloat(dreRecente.valores.produtosVendidos))}</strong></span>`:''}
        </div>` : ''}
      </div>` : ''}

      <!-- Ações Executadas -->
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#1a2744;">⚡ Ações Executadas</div>
        ${acoes.length ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          ${acoes.slice(0,10).map((a,i)=>`
          <tr style="background:${i%2===0?'#f8f9fc':'white'};">
            <td style="padding:8px 12px;color:#888;white-space:nowrap;">${a.data?new Date(a.data+'T00:00:00').toLocaleDateString('pt-BR'):''}</td>
            <td style="padding:8px 12px;"><span style="background:#6366f111;color:#6366f1;padding:2px 8px;border-radius:20px;font-size:11px;">${a.categoria||a.tipo||''}</span></td>
            <td style="padding:8px 12px;">${a.descricao||''}</td>
            <td style="padding:8px 12px;color:#888;">${a.responsavel||''}</td>
          </tr>`).join('')}
        </table>` : '<div style="color:#888;font-size:13px;padding:8px 0;">Nenhuma ação registrada para este cliente.</div>'}
      </div>

      <!-- Oportunidades -->
      ${opps.length ? `
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#10b981;">💡 Oportunidades</div>
        ${opps.map(o=>`
          <div style="padding:10px 14px;background:#10b98108;border:1px solid #10b98133;border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-weight:600;font-size:13.5px;">${o.titulo}</div>
              <div style="font-size:12px;color:#666;margin-top:2px;">${o.descricao||''}</div>
            </div>
            ${o.impacto?`<div style="font-weight:800;color:#10b981;white-space:nowrap;margin-left:16px;">${fmtFull(o.impacto)}/mês</div>`:''}
          </div>`).join('')}
      </div>` : ''}

      <!-- Próximos Passos -->
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#f59e0b;">📋 Próximos Passos</div>
        ${tarefasPend.length ? `
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${tarefasPend.map((t,i)=>`
            <div style="display:flex;gap:10px;align-items:center;padding:8px 12px;background:#f8f9fc;border-radius:6px;">
              <div style="width:22px;height:22px;border-radius:50%;background:#1a2744;color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${i+1}</div>
              <div style="flex:1;font-size:13px;">${t.titulo}</div>
              <div style="font-size:12px;color:#888;">${t.prazo?new Date(t.prazo+'T00:00:00').toLocaleDateString('pt-BR'):''}</div>
              <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:${{urgente:'#ef444422',alta:'#f9731622',media:'#f59e0b22',baixa:'#10b98122'}[t.prioridade]||'#88888822'};color:${{urgente:'#ef4444',alta:'#f97316',media:'#f59e0b',baixa:'#10b981'}[t.prioridade]||'#888'};">${t.prioridade||''}</span>
            </div>`).join('')}
        </div>` : '<div style="color:#888;font-size:13px;">Sem tarefas pendentes.</div>'}
      </div>

      <!-- Rodapé -->
      <div style="margin-top:32px;padding-top:16px;border-top:2px solid #1a2744;display:flex;justify-content:space-between;font-size:11.5px;color:#888;">
        <span><strong style="color:#1a2744;">GLR Consultoria</strong> · Gestor: ${c.gestor||'—'}</span>
        <span>Confidencial · ${mesAtual} ${anoAtual}</span>
      </div>
    </div>`;
  }

  el.innerHTML = `<div class="page">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <label class="form-label" style="margin:0;white-space:nowrap;">Cliente:</label>
        <select class="form-control" id="rel-cliente" style="min-width:220px;" onchange="relClienteChange(this.value)">
          ${GLR.clientes.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex;gap:10px;">
        <button class="btn" style="background:var(--bg-card);border:1px solid var(--border);" onclick="window.print()">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          Imprimir / PDF
        </button>
      </div>
    </div>
    <div id="rel-content">${renderRelatorio()}</div>
  </div>

  <style>
    @media print {
      #sidebar, #header { display:none!important; }
      #main { margin-left:0!important; }
      #page-content { padding:0!important; }
      .page > div:first-child { display:none!important; }
      body { background:white!important; }
      #relatorio-preview { border:none!important; box-shadow:none!important; padding:20px!important; }
    }
  </style>`;

  window.relClienteChange = function(val) {
    clienteSel = val;
    document.getElementById('rel-content').innerHTML = renderRelatorio();
  };
});

// ---- Inteligência Artificial ----
Router.register('ia', (params, el) => {
  const sugestoes = [
    'Quais clientes precisam de atenção urgente?',
    'Quais clientes mais cresceram esse mês?',
    'Quais tarefas estão atrasadas?',
    'Qual gestor tem mais pendências?',
    'Como está o faturamento da carteira?',
    'Quantos clientes temos por status?',
  ];

  // ── Gera respostas com dados REAIS ────────────────────────────
  function gerarResposta(pergunta) {
    const q  = pergunta.toLowerCase();
    const cl = GLR.clientes;
    const ta = GLR.tarefas;
    const ge = GLR.gestores;

    if (!cl.length) {
      return `Ainda não há clientes cadastrados no sistema. Cadastre clientes em **Carteira de Clientes** para que eu possa fazer análises.`;
    }

    const fatTotal   = cl.reduce((s,c)=>s+(c.faturamento||0),0);
    const total      = cl.length;
    const crescMedio = total ? (cl.reduce((s,c)=>s+(c.crescimento||0),0)/total) : 0;

    // Atenção urgente
    if (q.includes('atenção') || q.includes('urgente') || q.includes('risco') || q.includes('problema')) {
      const criticos = cl.filter(c=>c.status==='risco'||c.status==='queda').sort((a,b)=>(a.crescimento||0)-(b.crescimento||0));
      if (!criticos.length) return `✅ **Nenhum cliente em situação crítica!**\n\nToda a carteira está com status Ativo ou em Crescimento. Continue monitorando!`;
      return `🚨 **Clientes que precisam de atenção urgente:**\n\n` +
        criticos.map((c,i)=>`**${i===0?'🔴':'🟠'} ${c.nome}** — ${GLR.statusLabel[c.status]}\n- Crescimento: ${c.crescimento||0}%\n- Faturamento: ${GLR.formatCurrency(c.faturamento||0)}\n- Gestor: ${c.gestor||'—'}\n- **Ação:** Contato imediato e revisão de estratégia`).join('\n\n');
    }

    // Crescimento
    if (q.includes('crescer') || q.includes('cresceram') || q.includes('crescimento') || q.includes('melhores')) {
      const rank = [...cl].sort((a,b)=>(b.crescimento||0)-(a.crescimento||0));
      const medalhas = ['🥇','🥈','🥉'];
      return `📈 **Ranking de Crescimento da Carteira:**\n\n` +
        rank.slice(0,5).map((c,i)=>`${medalhas[i]||`${i+1}º`} **${c.nome}** → ${(c.crescimento||0)>=0?'+':''}${c.crescimento||0}%\n${GLR.formatCurrency(c.faturamento||0)} de faturamento · Gestor: ${c.gestor||'—'}`).join('\n\n') +
        `\n\n📊 Crescimento médio da carteira: **${crescMedio>=0?'+':''}${crescMedio.toFixed(1)}%**`;
    }

    // Tarefas atrasadas
    if (q.includes('tarefa') || q.includes('atrasad') || q.includes('pendente')) {
      const atrasadas = ta.filter(t=>t.status==='atrasada');
      const pendentes = ta.filter(t=>t.status==='pendente'||t.status==='em_andamento');
      if (!ta.length) return `Nenhuma tarefa cadastrada ainda. Adicione tarefas em **Gestão de Tarefas**.`;
      let resp = `⏰ **Situação das Tarefas:**\n\n`;
      resp += `- Total: **${ta.length}** tarefas\n- Atrasadas: **${atrasadas.length}**\n- Pendentes: **${pendentes.length}**\n- Concluídas: **${ta.filter(t=>t.status==='concluida').length}**\n\n`;
      if (atrasadas.length) {
        resp += `**🔴 Atrasadas:**\n` + atrasadas.map(t=>`- **${t.titulo}** · ${t.responsavel||'—'} · Prioridade: ${t.prioridade||'—'}`).join('\n');
      } else {
        resp += `✅ Nenhuma tarefa atrasada no momento!`;
      }
      return resp;
    }

    // Gestores / pendências
    if (q.includes('gestor') || q.includes('pendência') || q.includes('pendencia') || q.includes('responsável')) {
      if (!ge.length) return `Nenhum gestor cadastrado ainda. Adicione gestores em **Gestores**.`;
      const dados = ge.map(g=>{
        const clientesG = cl.filter(c=>c.gestor===g.nome);
        const tarefasG  = ta.filter(t=>t.responsavel===g.nome&&(t.status==='pendente'||t.status==='atrasada'));
        const atrasG    = ta.filter(t=>t.responsavel===g.nome&&t.status==='atrasada');
        const crescG    = clientesG.length ? (clientesG.reduce((s,c)=>s+(c.crescimento||0),0)/clientesG.length) : 0;
        return { ...g, clientesG, tarefasG, atrasG, crescG };
      }).sort((a,b)=>b.tarefasG.length-a.tarefasG.length);
      return `👨‍💼 **Análise por Gestor:**\n\n` +
        dados.map(g=>{
          const icone = g.atrasG.length>0?'🔴':g.tarefasG.length>3?'🟡':'🟢';
          return `${icone} **${g.nome}** (${g.cargo||'Gestor'})\n- Clientes: ${g.clientesG.length} · Tarefas pendentes: ${g.tarefasG.length} · Atrasadas: ${g.atrasG.length}\n- Crescimento médio: ${g.crescG>=0?'+':''}${g.crescG.toFixed(1)}%`;
        }).join('\n\n');
    }

    // Faturamento
    if (q.includes('faturamento') || q.includes('receita') || q.includes('financeiro')) {
      const maior = [...cl].sort((a,b)=>(b.faturamento||0)-(a.faturamento||0))[0];
      const menor = [...cl].sort((a,b)=>(a.faturamento||0)-(b.faturamento||0))[0];
      return `💰 **Análise de Faturamento da Carteira:**\n\n- Total da carteira: **${GLR.formatCurrency(fatTotal)}**\n- Crescimento médio: **${crescMedio>=0?'+':''}${crescMedio.toFixed(1)}%**\n- Clientes: **${total}**\n\n📈 Maior faturamento: **${maior.nome}** → ${GLR.formatCurrency(maior.faturamento||0)}\n📉 Menor faturamento: **${menor.nome}** → ${GLR.formatCurrency(menor.faturamento||0)}`;
    }

    // Status da carteira
    if (q.includes('status') || q.includes('carteira') || q.includes('quantos')) {
      const porStatus = ['crescimento','ativo','queda','risco'].map(s=>({
        s, label: GLR.statusLabel[s], count: cl.filter(c=>c.status===s).length
      }));
      return `📊 **Distribuição da Carteira por Status:**\n\n` +
        porStatus.map(({label,count})=>`- **${label}:** ${count} cliente${count!==1?'s':''} (${total?Math.round(count/total*100):0}%)`).join('\n') +
        `\n\n**Total:** ${total} clientes · Faturamento: **${GLR.formatCurrency(fatTotal)}**`;
    }

    // Resposta genérica com dados reais
    const emRisco = cl.filter(c=>c.status==='risco'||c.status==='queda').length;
    return `Entendi sua pergunta sobre **"${pergunta}"**.\n\nAqui está um resumo da carteira atual:\n\n📊 **${total}** clientes cadastrados\n💰 **${GLR.formatCurrency(fatTotal)}** de faturamento total\n📈 **${crescMedio>=0?'+':''}${crescMedio.toFixed(1)}%** crescimento médio\n⚠️ **${emRisco}** cliente${emRisco!==1?'s':''} em risco ou queda\n✅ **${ta.filter(t=>t.status==='concluida').length}** tarefas concluídas\n\nUse as perguntas sugeridas ao lado para análises mais detalhadas.`;
  }

  el.innerHTML = `<div class="page" style="height:calc(100vh - ${64+24}px);display:flex;gap:16px;">
    <!-- Painel de sugestões -->
    <div style="width:280px;flex-shrink:0;display:flex;flex-direction:column;gap:8px;">
      <div class="card" style="flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <div style="width:36px;height:36px;border-radius:var(--radius-sm);background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:16px;">🤖</div>
          <div>
            <div style="font-size:14px;font-weight:700;">GLR IA Copiloto</div>
            <div style="font-size:11px;color:var(--green);">● Online</div>
          </div>
        </div>
        <div style="font-size:12.5px;color:var(--text-secondary);">Analiso os dados reais da sua carteira — clientes, tarefas, gestores e faturamentos cadastrados no sistema.</div>
      </div>

      <div class="card" style="flex:1;overflow-y:auto;">
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Perguntas Sugeridas</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${sugestoes.map(s => `
            <button class="ia-chip" style="text-align:left;justify-content:flex-start;border-radius:var(--radius-sm);" onclick="sendIAMessage('${s.replace(/'/g, "\\'")}')">
              ${s}
            </button>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- Chat -->
    <div class="card" style="flex:1;display:flex;flex-direction:column;padding:0;overflow:hidden;">
      <div id="ia-messages" style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px;">
        <div style="display:flex;gap:10px;">
          <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">🤖</div>
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;max-width:80%;">
            <div style="font-size:14px;font-weight:600;margin-bottom:6px;color:var(--accent-light);">Olá! Sou o Copiloto da GLR 👋</div>
            <div style="font-size:13.5px;color:var(--text-secondary);line-height:1.6;">Analiso os dados reais cadastrados no sistema — sem inventar nada. Clientes, tarefas, gestores e faturamentos. Pergunte o que quiser!</div>
          </div>
        </div>
      </div>
      <div style="padding:16px;border-top:1px solid var(--border);display:flex;gap:10px;">
        <input class="ia-input" id="ia-input-field" placeholder="Pergunte sobre sua carteira de clientes..." onkeydown="if(event.key==='Enter')sendIAMessage()">
        <button class="btn btn-primary" onclick="sendIAMessage()" style="flex-shrink:0;">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          Enviar
        </button>
      </div>
    </div>
  </div>`;

  window.sendIAMessage = (msg) => {
    const input    = document.getElementById('ia-input-field');
    const userMsg  = msg || input?.value?.trim();
    if (!userMsg) return;
    if (input) input.value = '';

    const messagesDiv = document.getElementById('ia-messages');

    messagesDiv.innerHTML += `<div style="display:flex;gap:10px;flex-direction:row-reverse;">
      <div style="width:32px;height:32px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:white;flex-shrink:0;">EU</div>
      <div style="background:var(--accent);border-radius:var(--radius);padding:12px 16px;max-width:80%;color:white;font-size:13.5px;">${userMsg}</div>
    </div>`;

    const typingId = 'typing-' + Date.now();
    messagesDiv.innerHTML += `<div id="${typingId}" style="display:flex;gap:10px;">
      <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">🤖</div>
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;">
        <div style="display:flex;gap:4px;align-items:center;">
          <div style="width:6px;height:6px;border-radius:50%;background:var(--text-muted);animation:pulse 1s infinite;"></div>
          <div style="width:6px;height:6px;border-radius:50%;background:var(--text-muted);animation:pulse 1s 0.2s infinite;"></div>
          <div style="width:6px;height:6px;border-radius:50%;background:var(--text-muted);animation:pulse 1s 0.4s infinite;"></div>
        </div>
      </div>
    </div>`;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    setTimeout(() => {
      document.getElementById(typingId)?.remove();
      if (typeof carregarDadosSalvos === 'function') carregarDadosSalvos();

      const resp      = gerarResposta(userMsg);
      const formatted = resp
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

      messagesDiv.innerHTML += `<div style="display:flex;gap:10px;">
        <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">🤖</div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;max-width:85%;font-size:13.5px;line-height:1.7;color:var(--text-secondary);">${formatted}</div>
      </div>`;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }, 600 + Math.random() * 500);
  };
});
