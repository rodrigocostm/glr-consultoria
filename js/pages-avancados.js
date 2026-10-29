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

  // Lista de gestores — apenas os que têm pelo menos 1 cliente. Filtra por
  // gestorId (é o que o formulário de editar cliente realmente grava; c.gestor
  // de string não é gravado por lá, então derivar a lista a partir dele
  // deixava essa página inteira "Nenhum gestor com clientes" após qualquer edição).
  const gestoresAtivos = GLR.gestores.filter(g =>
    GLR.clientes.some(c => c.gestorId === g.id || c.gestor === g.nome)
  );

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
    const vendasCom  = plats.reduce((s,p) => s + (GLR.linhaGeraComissao(c.id, p) ? calcP(p.vendasBase) : 0), 0);
    const fatCom     = plats.reduce((s,p) => s + (GLR.linhaGeraComissao(c.id, p) ? calcP(p.fatBase) : 0), 0);
    const receitaGLR = GLR.comissao.estimar(c, vendasCom, fatCom); // modelo de comissão do cliente

    return { fatBase, adsBase, pctADSBase, fatProj, adsProj, pctADSProj,
             fatReal, adsReal, fatM1, fatM2, fatM3,
             faltaMeta, pctMeta, compMesAnt, compMeta, receitaGLR };
  }

  // Cor da célula de % meta
  function corMeta(pct) {
    if (pct === null) return { bg: 'transparent', text: 'var(--text-muted)' };
    if (pct >= 100)   return { bg: '#10b98120', text: 'var(--green)' };
    if (pct >= 85)    return { bg: '#f59e0b20', text: 'var(--yellow)' };
    return                   { bg: '#ef444420', text: 'var(--red)' };
  }

  function corCrescimento(pct) {
    if (pct === null) return 'var(--text-muted)';
    if (pct >= 10)    return 'var(--green)';
    if (pct >= 0)     return 'var(--yellow)';
    return 'var(--red)';
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
        <tr style="background:var(--bg-subtle);color:var(--text-secondary);">
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
            <td style="padding:9px 8px;text-align:right;color:${d.pctADSBase>20?'var(--red)':d.pctADSBase>15?'var(--yellow)':'var(--text-secondary)'};">${d.pctADSBase > 0 ? d.pctADSBase.toFixed(1)+'%' : '—'}</td>
            <td style="padding:9px 8px;text-align:right;font-weight:600;color:var(--accent-light);">${d.fatProj > 0 ? fmtR(d.fatProj) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;font-weight:${d.fatReal>0?'700':'400'};color:${d.fatReal>0?'var(--text-primary)':'var(--text-muted)'};">${d.fatReal > 0 ? fmtR(d.fatReal) : '<span style="font-size:10px;">sem DRE</span>'}</td>
            <td style="padding:9px 8px;text-align:right;font-weight:600;color:${corCrescimento(d.compMesAnt)};">${d.compMesAnt !== null ? fmtPct(d.compMesAnt) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:${d.faltaMeta !== null ? (d.faltaMeta <= 0 ? 'var(--green)' : 'var(--red)') : 'var(--text-muted)'};">${d.faltaMeta !== null ? (d.faltaMeta <= 0 ? '✅ Batida' : fmtR(d.faltaMeta)) : '—'}</td>
            <td style="padding:9px 8px;text-align:center;">
              ${d.pctMeta !== null ? `
              <span style="background:${cor.bg};color:${cor.text};font-weight:700;padding:3px 8px;border-radius:99px;font-size:11px;">
                ${d.pctMeta.toFixed(1)}%
              </span>` : '<span style="color:var(--text-muted)">—</span>'}
            </td>
            <td style="padding:9px 8px;text-align:right;color:var(--text-secondary);">${d.adsProj > 0 ? fmtR(d.adsProj) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:${d.pctADSProj>20?'var(--red)':d.pctADSProj>15?'var(--yellow)':'var(--text-secondary)'};">${d.pctADSProj > 0 ? d.pctADSProj.toFixed(1)+'%' : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:var(--green);font-weight:600;">${d.receitaGLR > 0 ? fmtR(d.receitaGLR) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:var(--text-muted);">${d.fatM3 > 0 ? fmtR(d.fatM3) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:var(--text-muted);">${d.fatM2 > 0 ? fmtR(d.fatM2) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;color:var(--text-muted);">${d.fatM1 > 0 ? fmtR(d.fatM1) : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="background:var(--bg-subtle);font-weight:700;font-size:12.5px;border-top:2px solid var(--border);">
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
          <td style="padding:10px 8px;text-align:right;color:var(--green);">${tot.recGLR > 0 ? fmtR(tot.recGLR) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatM3 > 0 ? fmtR(tot.fatM3) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatM2 > 0 ? fmtR(tot.fatM2) : '—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatM1 > 0 ? fmtR(tot.fatM1) : '—'}</td>
        </tr>
      </tfoot>
    </table>
    </div>

    <!-- Legenda -->
    <div style="display:flex;gap:16px;flex-wrap:wrap;padding:10px 4px;font-size:11px;color:var(--text-muted);">
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:var(--green);border-radius:3px;"></span> Batendo a meta (≥100%)</span>
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:var(--yellow);border-radius:3px;"></span> Quase batendo (85–99%)</span>
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:var(--red);border-radius:3px;"></span> Abaixo da meta (&lt;85%)</span>
      <span style="margin-left:auto;">Dados atualizados em tempo real · Clique em um cliente para ver o perfil</span>
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
        <div class="section-title" style="font-size:20px;">Performance Gestor</div>
        <div class="section-subtitle">${meses[hoje.getMonth()]} ${hoje.getFullYear()} · Dados em tempo real</div>
      </div>
      <button class="btn" style="background:var(--bg-card);border:1px solid var(--border);" onclick="window.print()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Imprimir
      </button>
    </div>

    <!-- Um bloco por gestor -->
    ${gestoresAtivos.map(g => {
      const clientes = GLR.clientes.filter(c => c.gestorId === g.id || c.gestor === g.nome);
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
        <div style="padding:16px 20px;background:var(--bg-subtle);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-weight:700;color:white;font-size:18px;">${g.nome.charAt(0)}</div>
            <div>
              <div style="font-size:16px;font-weight:700;color:var(--text-primary);">${g.nome}</div>
              <div style="font-size:12px;color:var(--text-muted);">${clientes.length} cliente${clientes.length!==1?'s':''} · ${meses[hoje.getMonth()]} ${hoje.getFullYear()}</div>
            </div>
          </div>
          <div style="display:flex;gap:20px;flex-wrap:wrap;">
            <div style="text-align:center;">
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Meta Total</div>
              <div style="font-size:15px;font-weight:700;color:var(--text-primary);">${tot.fatBase > 0 ? fmtR(tot.fatBase) : '—'}</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Projeção</div>
              <div style="font-size:15px;font-weight:700;color:var(--accent-light);">${tot.fatProj > 0 ? fmtR(tot.fatProj) : '—'}</div>
            </div>
            ${tot.fatReal > 0 ? `<div style="text-align:center;">
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Realizado</div>
              <div style="font-size:15px;font-weight:700;color:var(--green);">${fmtR(tot.fatReal)}</div>
            </div>` : ''}
            <div style="text-align:center;">
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">% Meta</div>
              <div style="font-size:15px;font-weight:700;color:${corTot.text};">${totPctMeta !== null ? totPctMeta.toFixed(0)+'%' : '—'}</div>
            </div>
            ${tot.recGLR > 0 ? `<div style="text-align:center;">
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Receita GLR</div>
              <div style="font-size:15px;font-weight:700;color:var(--green);">${fmtR(tot.recGLR)}</div>
            </div>` : ''}
          </div>
        </div>

        <!-- Tabela de clientes -->
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:1000px;">
          <thead>
            <tr style="background:var(--bg-base);border-bottom:2px solid var(--border);">
              <th style="padding:9px 14px;text-align:left;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;letter-spacing:0;">Empresa</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;letter-spacing:0;white-space:nowrap;">Meta Base</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">ADS%</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">Projeção</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">Fat. Real</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">vs Mês Ant.</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">Falta p/ Meta</th>
              <th style="padding:9px 8px;text-align:center;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">% Meta</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">ADS Proj.</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">%ADS</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">Rec. GLR</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">${mesN(3)}</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">${mesN(2)}</th>
              <th style="padding:9px 8px;text-align:right;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:none;white-space:nowrap;">${mesN(1)}</th>
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
                <td style="padding:10px 8px;text-align:right;color:${d.pctADSBase>20?'var(--red)':d.pctADSBase>15?'var(--yellow)':'var(--text-secondary)'};">${d.pctADSBase > 0 ? d.pctADSBase.toFixed(1)+'%' : '—'}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:600;color:var(--accent-light);">${d.fatProj > 0 ? fmtR(d.fatProj) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:${d.fatReal>0?'700':'400'};color:${d.fatReal>0?'var(--text-primary)':'var(--text-muted)'};">${d.fatReal > 0 ? fmtR(d.fatReal) : '<span style="font-size:10px;">sem DRE</span>'}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:600;color:${corCrescimento(d.compMesAnt)};">${d.compMesAnt !== null ? fmtPct(d.compMesAnt) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:${d.faltaMeta !== null ? (d.faltaMeta <= 0 ? 'var(--green)' : 'var(--orange)') : 'var(--text-muted)'};">${d.faltaMeta !== null ? (d.faltaMeta <= 0 ? '✅ Batida' : fmtR(d.faltaMeta)) : '—'}</td>
                <td style="padding:10px 8px;text-align:center;">
                  ${d.pctMeta !== null
                    ? `<span style="background:${cor.bg};color:${cor.text};font-weight:700;padding:3px 10px;border-radius:99px;font-size:11px;white-space:nowrap;">${d.pctMeta.toFixed(1)}%</span>`
                    : '<span style="color:var(--text-muted)">—</span>'}
                </td>
                <td style="padding:10px 8px;text-align:right;color:var(--text-secondary);">${d.adsProj > 0 ? fmtR(d.adsProj) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:${d.pctADSProj>20?'var(--red)':d.pctADSProj>15?'var(--yellow)':'var(--text-secondary)'};">${d.pctADSProj > 0 ? d.pctADSProj.toFixed(1)+'%' : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:var(--green);font-weight:600;">${d.receitaGLR > 0 ? fmtR(d.receitaGLR) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:var(--text-muted);font-size:11px;">${d.fatM3 > 0 ? fmtR(d.fatM3) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:var(--text-muted);font-size:11px;">${d.fatM2 > 0 ? fmtR(d.fatM2) : '—'}</td>
                <td style="padding:10px 8px;text-align:right;color:var(--text-muted);font-size:11px;">${d.fatM1 > 0 ? fmtR(d.fatM1) : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr style="background:var(--bg-subtle);font-weight:700;font-size:12.5px;border-top:2px solid var(--border);">
              <td style="padding:10px 14px;color:var(--text-primary);">Total</td>
              <td style="padding:10px 8px;text-align:right;">${tot.fatBase > 0 ? fmtR(tot.fatBase) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;">${tot.fatProj > 0 && tot.adsProj > 0 ? ((tot.adsProj/tot.fatProj)*100).toFixed(1)+'%' : '—'}</td>
              <td style="padding:10px 8px;text-align:right;color:var(--accent-light);">${tot.fatProj > 0 ? fmtR(tot.fatProj) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;">${tot.fatReal > 0 ? fmtR(tot.fatReal) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;color:${corCrescimento(totCompM1)};">${totCompM1 !== null ? fmtPct(totCompM1) : '—'}</td>
              <td style="padding:10px 8px;"></td>
              <td style="padding:10px 8px;text-align:center;">${totPctMeta !== null ? `<span style="background:${corTot.bg};color:${corTot.text};font-weight:700;padding:3px 10px;border-radius:99px;font-size:11px;">${totPctMeta.toFixed(1)}%</span>` : '—'}</td>
              <td style="padding:10px 8px;text-align:right;">${tot.adsProj > 0 ? fmtR(tot.adsProj) : '—'}</td>
              <td style="padding:10px 8px;"></td>
              <td style="padding:10px 8px;text-align:right;color:var(--green);">${tot.recGLR > 0 ? fmtR(tot.recGLR) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;font-size:11px;">${tot.fatM3 > 0 ? fmtR(tot.fatM3) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;font-size:11px;">${tot.fatM2 > 0 ? fmtR(tot.fatM2) : '—'}</td>
              <td style="padding:10px 8px;text-align:right;font-size:11px;">${tot.fatM1 > 0 ? fmtR(tot.fatM1) : '—'}</td>
            </tr>
          </tfoot>
        </table>
        </div>

        <!-- Legenda -->
        <div style="padding:10px 16px;border-top:1px solid var(--border);display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--text-muted);">
          <span style="display:flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;background:var(--green);border-radius:2px;"></span> Batendo meta (≥100%)</span>
          <span style="display:flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;background:var(--yellow);border-radius:2px;"></span> Quase lá (85–99%)</span>
          <span style="display:flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;background:var(--red);border-radius:2px;"></span> Abaixo da meta (&lt;85%)</span>
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
// Aba "Oportunidades" (cadastro manual) removida a pedido do analista em 14/10/2026.


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
  // Dias no mês de uma data ISO (YYYY-MM-DD) — usado pra dias decorridos/dias no mês
  // sempre seguirem a Data Base, a menos que o usuário edite os campos manualmente
  function _diasNoMesDe(dataIso) {
    const [y, m] = (dataIso || '').split('-').map(Number);
    if (!y || !m) return new Date(_hoje.getFullYear(), _hoje.getMonth() + 1, 0).getDate();
    return new Date(y, m, 0).getDate();
  }
  const _diasNoMes = new Date(_hoje.getFullYear(), _hoje.getMonth() + 1, 0).getDate();
  // Labels dos 3 meses fechados anteriores (M1/M2/M3), calculados a partir de hoje —
  // usados como fallback nos headers/CSV antes da 1ª busca (evita mostrar sempre
  // "Maio/Abril/Março" fixo, que ficava errado assim que o mês virava).
  function _labelMesOffset(offset) {
    const d = new Date(_hoje.getFullYear(), _hoje.getMonth() - offset, 1);
    return `${_mesesNomesProj[d.getMonth()]} ${d.getFullYear()}`;
  }
  const _labelM1Default = _labelMesOffset(1), _labelM2Default = _labelMesOffset(2), _labelM3Default = _labelMesOffset(3);

  // Rótulos do mês (e dos 3 meses fechados) sempre derivados da Data Base — antes
  // ficavam gravados na projeção e mostravam "Junho 2026" meses depois.
  function _rotulosDaDataBase(proj) {
    const db = proj.dataBase ? new Date(proj.dataBase + 'T12:00:00') : _ontem;
    const lbl = off => { const d = new Date(db.getFullYear(), db.getMonth() - off, 1); return `${_mesesNomesProj[d.getMonth()]} ${d.getFullYear()}`; };
    proj.mes = lbl(0); proj.labelM1 = lbl(1); proj.labelM2 = lbl(2); proj.labelM3 = lbl(3);
  }

  if (!projecaoAtiva) {
    const clienteObj = GLR.clientes.find(c => c.id === clienteIdAtivo);
    projecaoAtiva = {
      chave:          clienteIdAtivo ? String(clienteIdAtivo) : 'sem_cliente',
      nomeCliente:    clienteObj?.nome || '',
      mes:            _mesLabel,
      dataBase:       `${_ontem.getFullYear()}-${String(_ontem.getMonth()+1).padStart(2,'0')}-${String(_ontem.getDate()).padStart(2,'0')}`,
      diasNoMes:      _diasNoMes,
      diasDecorridos: _ontem.getDate(),
      obs: '',
      plataformas: []
    };
  } else if (!projecaoAtiva._diasEditadosManualmente) {
    // Segue a Data Base salva (não a data de hoje) — evita trocar o mês errado
    // quando a projeção é de um mês anterior e o usuário só está consultando
    projecaoAtiva.diasNoMes = _diasNoMesDe(projecaoAtiva.dataBase);
    if (projecaoAtiva.dataBase) {
      const [,,d] = projecaoAtiva.dataBase.split('-').map(Number);
      projecaoAtiva.diasDecorridos = d;
    }
  }

  // Data Base segue ontem enquanto não for escolhida à mão
  if (!projecaoAtiva._diasEditadosManualmente) {
    const ontemIso = `${_ontem.getFullYear()}-${String(_ontem.getMonth()+1).padStart(2,'0')}-${String(_ontem.getDate()).padStart(2,'0')}`;
    if (projecaoAtiva.dataBase !== ontemIso) { projecaoAtiva.dataBase = ontemIso; projecaoAtiva.diasDecorridos = _ontem.getDate(); projecaoAtiva.diasNoMes = _diasNoMesDe(ontemIso); }
  }
  _rotulosDaDataBase(projecaoAtiva);

  function salvar() {
    _rotulosDaDataBase(projecaoAtiva);
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

  // ── Base sincronizada (servidor, a cada 15 min) ───────────────────────────
  // Faturamento/vendas do mês até a Data Base, ADS (Shopee já com GMV Max) e os
  // 2 meses fechados anteriores saem prontos do resumo diário por loja — sem
  // depender de "Buscar dados" nem do cache do Financeiro. Loja cujo histórico
  // ainda não cobre o período continua pelo caminho antigo (API).
  let baseProj = null;
  const _padP = n => String(n).padStart(2, '0');
  const idContaBase = c => String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.contaId || c.external_id);
  function infoBaseDe(marketplace, contaId) {
    if (!baseProj || !window.BaseDados || !contaId) return null;
    const mkt = BaseDados.mktDe(String(marketplace || '').replace(/\s+/g, '')); // "Mercado Livre" → mercadolivre
    return mkt ? baseProj[BaseDados.chave(mkt, String(contaId))] : null;
  }
  function mesFechadoIso(offset) {
    const db = projecaoAtiva.dataBase ? new Date(projecaoAtiva.dataBase + 'T12:00:00') : _ontem;
    const d = new Date(db.getFullYear(), db.getMonth() - offset, 1);
    const fim = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { from: `${d.getFullYear()}-${_padP(d.getMonth()+1)}-01`, to: `${fim.getFullYear()}-${_padP(fim.getMonth()+1)}-${_padP(fim.getDate())}` };
  }
  // { fat, vendas, ads|null } da base para uma linha (conta) — ou null se a base não cobre
  function dadosBaseDaLinha(p) {
    const info = infoBaseDe(p.marketplace || p._platNome, p.contaId);
    const db = projecaoAtiva.dataBase;
    if (!info || !db) return null;
    const ini = db.slice(0, 8) + '01';
    if (!BaseDados.cobre(info, ini)) return null;
    const t = BaseDados.somar(info, ini, db);
    return { fat: t.faturamento, vendas: t.unidades || t.pedidos, ads: BaseDados.cobreAds(info, ini) ? t.ads : null };
  }
  // Cria as linhas das contas vinculadas que ainda não existem e preenche os
  // meses fechados (M1/M2) que estiverem vazios a partir da base.
  function aplicarBase(forcarMeses = false) {
    if (!baseProj) return false;
    let vinculos = {};
    try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch(e) {}
    const cid = parseInt(document.getElementById('sel-cliente')?.value) || clienteIdAtivo;
    const contasVinc = vinculos[String(cid)] || [];
    const platMap = { mercadolivre:'Mercado Livre', ml:'Mercado Livre', meli:'Mercado Livre', shopee:'Shopee' };
    const nicks = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();
    let mudou = false;
    projecaoAtiva.plataformas = projecaoAtiva.plataformas || [];
    // Conta que saiu do cliente (desvinculada ou passada para outro) não pode
    // continuar somando na projeção dele
    if (contasVinc.length) {
      const ids = new Set(contasVinc.map(c => String(c.external_id)));
      const antes = projecaoAtiva.plataformas.length;
      projecaoAtiva.plataformas = projecaoAtiva.plataformas.filter(p => !p.contaId || ids.has(String(p.contaId)));
      if (projecaoAtiva.plataformas.length !== antes) mudou = true;
    }
    // Data Base segue ontem enquanto não for editada à mão
    if (!projecaoAtiva._diasEditadosManualmente) {
      const ontemIso = `${_ontem.getFullYear()}-${_padP(_ontem.getMonth()+1)}-${_padP(_ontem.getDate())}`;
      if (projecaoAtiva.dataBase !== ontemIso) {
        projecaoAtiva.dataBase = ontemIso; projecaoAtiva.diasDecorridos = _ontem.getDate(); projecaoAtiva.diasNoMes = _diasNoMesDe(ontemIso); mudou = true;
      }
    }
    const m1 = mesFechadoIso(1), m2 = mesFechadoIso(2);
    const lbl = off => _labelMesOffset(off);
    for (const c of contasVinc) {
      const info = infoBaseDe(c.marketplace, idContaBase(c));
      if (!info) continue;
      let linha = projecaoAtiva.plataformas.find(p => String(p.contaId) === String(c.external_id));
      if (!linha) {
        const tag = c.tags?.[0]?.name || '';
        linha = { nome: nicks[c.external_id] || tag || c.nickname || c.external_id, contaId: c.external_id, marketplace: c.marketplace,
          fatBase:'', adsBase:'', vendasBase:'', maio:'', abril:'', marco:'', _platNome: platMap[(c.marketplace||'').toLowerCase()] || c.marketplace };
        projecaoAtiva.plataformas.push(linha); mudou = true;
      }
      // Meses fechados vêm SEMPRE da base quando ela cobre o mês (antes só preenchia
      // se estivesse vazio — e o valor antigo ficava na coluna errada quando o mês virava)
      const m3 = mesFechadoIso(3);
      const setMes = (campo, per) => { if (!BaseDados.cobre(info, per.from)) return; const v = BaseDados.somar(info, per.from, per.to).faturamento; const novo = v > 0 ? v.toFixed(2) : ''; if (linha[campo] !== novo) { linha[campo] = novo; mudou = true; } };
      setMes('maio', m1); setMes('abril', m2); setMes('marco', m3);
      linha._base = true;
    }
    if (mudou) salvar();
    return mudou;
  }
  async function carregarBaseProj(forcar = false) {
    if (!window.BaseDados) return;
    try { baseProj = await BaseDados.carregar(forcar); } catch(e) { console.warn('[Projeção] base indisponível:', e.message); return; }
    if (Router.currentPage !== 'projecao') return;
    aplicarBase();
    renderTabela();
    if (typeof atualizarGrafico === 'function') setTimeout(atualizarGrafico, 50);
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
  // Executa promessas com concorrência limitada — mesmo padrão usado em Vendas/Analytics
  async function _mapLimitAv(items, limit, fn) {
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        try { await fn(items[i], i); } catch(e) {}
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  // Painel de diagnóstico temporário — mesmo padrão já usado em Vendas pra achar
  // bug de campo/duplicação sem precisar abrir o console do navegador.
  function _diagMostrarAv(grupo, chaveId, obj) {
    try { if (localStorage.getItem('glr_debug') !== '1') return; } catch (e) { return; } // só com a depuração ligada (localStorage glr_debug=1)
    let box = document.getElementById('diag-api-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'diag-api-box';
      box.style.cssText = 'position:fixed;bottom:12px;right:12px;width:520px;max-height:70vh;overflow-y:auto;background:#0d0d14;border:1px solid #6366f1;border-radius:10px;padding:14px;z-index:99999;font-family:monospace;font-size:11px;color:#e5e7eb;box-shadow:0 10px 40px rgba(0,0,0,.5);';
      box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="color:var(--accent-light);">Diagnóstico Projeção (temporário)</strong>
        <button onclick="document.getElementById('diag-api-box').remove()" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;">✕</button>
      </div><div id="diag-api-conteudo"></div>`;
      document.body.appendChild(box);
    }
    const cont = document.getElementById('diag-api-conteudo');
    const bloco = document.createElement('div');
    bloco.style.cssText = 'margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #2a2a3a;';
    bloco.innerHTML = `<div style="color:#fbbf24;margin-bottom:4px;">[${grupo}] ${chaveId}</div><pre style="white-space:pre-wrap;word-break:break-all;margin:0;">${JSON.stringify(obj,null,2).replace(/</g,'&lt;')}</pre>`;
    cont.appendChild(bloco);
  }

  async function buscarDadosProjecao(silencioso = false, forcarMesesAnteriores = false) {
    const cidAtivo = parseInt(document.getElementById('sel-cliente')?.value) || clienteIdAtivo;
    let vinculos = {};
    try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos')||'{}'); } catch(e) {}
    const contasVinc = vinculos[String(cidAtivo)] || [];
    if (!contasVinc.length) { if (!silencioso) alert('Nenhuma conta vinculada. Use Vincular conta primeiro.'); return; }
    const apiKey = localStorage.getItem('glr_mc_apikey')||'';
    if (!apiKey) { if (!silencioso) alert('Configure a API Key nas Integrações.'); return; }

    // Meses fechados (Maio/Abril/Março) não mudam mais depois de fechados — guarda o
    // que já foi buscado antes por conta, pra não buscar de novo toda atualização.
    // "Forçar" (botão à parte) ignora esse cache e busca tudo de novo mesmo assim.
    const mesesJaSalvos = {};
    (projecaoAtiva.plataformas||[]).forEach(p => {
      if (p.contaId && (p.maio || p.abril || p.marco)) {
        mesesJaSalvos[p.contaId] = { maio: p.maio, abril: p.abril, marco: p.marco };
      }
    });

    // Diagnóstico: lista as contas vinculadas tal como estão salvas — se o mesmo
    // external_id aparecer mais de uma vez, os pedidos dela são contados em dobro/triplo.
    _diagMostrarAv('contas_vinculadas', `cliente ${cidAtivo}`, contasVinc.map(c => ({ external_id: c.external_id, marketplace: c.marketplace, nickname: c.nickname })));

    const btn = document.getElementById('btn-buscar-proj');
    if (btn) { btn.disabled=true; btn.textContent='⏳ Buscando...'; }

    try {
      // Sempre até ONTEM — hoje ainda não fechou o dia, incluir puxaria dado
      // parcial e distorceria a projeção (base incompleta ÷ dias decorridos)
      const hoje = new Date();
      const ontem = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
      const pad  = n => String(n).padStart(2,'0');
      const ano = ontem.getFullYear(), mes = ontem.getMonth()+1;
      const primeiroDia = `${ano}-${pad(mes)}-01`;
      const dataTo = `${ano}-${pad(mes)}-${pad(ontem.getDate())}`;
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

      // Meses anteriores fechados (M1/M2/M3) — mesmo padrão já usado no Analytics
      // (buscarDadosExecutivo). Preenche os campos Maio/Abril/Março automaticamente
      // em vez de precisar digitar na mão pra ter comparação com o mês atual.
      function mesFechadoOffset(offset) {
        const d = new Date(ano, mes-1-offset, 1);
        const y = d.getFullYear(), m = d.getMonth()+1;
        const diasMes = new Date(y, m, 0).getDate();
        return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(diasMes)}`, tsFrom: Math.floor(new Date(`${y}-${pad(m)}-01T00:00:00`).getTime()/1000), tsTo: Math.floor(new Date(`${y}-${pad(m)}-${pad(diasMes)}T23:59:59`).getTime()/1000), label: `${_mesesNomesProj[d.getMonth()]} ${y}` };
      }
      const m1 = mesFechadoOffset(1), m2 = mesFechadoOffset(2), m3 = mesFechadoOffset(3);
      // Guarda os labels reais (ex.: "Ago/2026") na projeção pra tabela/CSV/histórico
      // pararem de mostrar sempre "Maio/Abril/Março" fixo mesmo quando o mês já virou.
      projecaoAtiva.labelM1 = m1.label; projecaoAtiva.labelM2 = m2.label; projecaoAtiva.labelM3 = m3.label;

      const totalContas = contasVinc.length;
      let idx = 0;
      const adsPorConta = {}; // { external_id: valor investido no período }
      const fatM1PorConta = {}, fatM2PorConta = {}, fatM3PorConta = {}; // faturamento dos 3 meses fechados anteriores
      const toShopeeDate = iso => iso.split('-').reverse().join('-');

      async function fatMesFechadoML(meliId, periodo) {
        try {
          const orders = await MarketplaceAPI.mlOrders(meliId, periodo.from, periodo.to);
          return orders.reduce((s,o) => ['cancelled','invalid'].includes((o.status||'').toLowerCase()) ? s : s+(parseFloat(o.total_amount)||0), 0);
        } catch(e) { return 0; }
      }
      async function fatMesFechadoShopee(shopId, periodo) {
        let total = 0;
        try {
          const sns = await MarketplaceAPI.shopeeListOrderSns(shopId, periodo.tsFrom, periodo.tsTo);
          for (let i=0; i<sns.length; i+=50) {
            const lote = sns.slice(i,i+50).map(o=>o.sn);
            try {
              const rd = await MarketplaceAPI.call('shopee_get_order_detail', { shopId, order_sn_list: lote });
              const lista = rd.data?.response?.order_list || rd.data?.order_list || [];
              for (const ord of lista) {
                // Mesma blindagem do período atual: confere o create_time real e descarta
                // pedido fora do mês pedido (status tipo READY_TO_SHIP não respeita o
                // filtro de data da API em contas com volume alto).
                if (ord.create_time && (ord.create_time < periodo.tsFrom || ord.create_time > periodo.tsTo)) continue;
                const itens = ord.item_list || ord.items || [];
                const subtotal = itens.reduce((s,it) => {
                  const p = parseFloat(it.model_discounted_price)||parseFloat(it.item_price)||0;
                  const q = parseInt(it.model_quantity_purchased)||parseInt(it.quantity)||1;
                  return s + p*q;
                }, 0);
                total += subtotal > 0 ? subtotal : (parseFloat(ord.total_amount)||0);
              }
            } catch(e) {}
          }
        } catch(e) {}
        return total;
      }

      try { baseProj = window.BaseDados ? await BaseDados.carregar(true) : null; } catch(e) { baseProj = null; }
      const iniMesIso = primeiroDia;
      for (const conta of contasVinc) {
        idx++;
        const mkt = (conta.marketplace||'').toLowerCase();
        const label = conta.nickname || conta.external_id;
        if (btn) btn.textContent = `⏳ ${idx}/${totalContas}: ${label}`;
        // Conta já coberta pela base (mês inteiro + ADS): nada a buscar na API
        const infoB = infoBaseDe(conta.marketplace, idContaBase(conta));
        if (infoB && BaseDados.cobre(infoB, iniMesIso) && BaseDados.cobreAds(infoB, iniMesIso)) {
          adsPorConta[conta.external_id] = BaseDados.somar(infoB, iniMesIso, dataTo).ads;
          continue;
        }

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
            // ADS Mercado Livre — investimento real da conta no período
            try {
              let adsTotal = 0, off = 0;
              while (true) {
                const ra = await MarketplaceAPI.call('ml_ads_campaigns', { meliUserId: meliId, date_from: primeiroDia, date_to: dataTo, limit: 50, offset: off });
                const res = ra.data?.results || [];
                adsTotal += res.reduce((s,c) => s + (parseFloat(c.metrics?.cost)||0), 0);
                if (res.length < 50) break;
                off += 50;
              }
              adsPorConta[conta.external_id] = adsTotal;
            } catch(e) { console.warn('[Proj] ADS ML erro:', e.message); }
          } else if (mkt === 'shopee') {
            const shopId = conta.param_to_use?.shopId || conta.external_id;
            let forasDoPeriodo = 0;
            const snsList = await MarketplaceAPI.shopeeListOrderSns(shopId, Math.floor(tsFrom/1000), Math.floor(tsTo/1000));
            // Diagnóstico: quantos order_sn vieram, e se tem sn duplicado na lista
            const snsUnicos = new Set(snsList.map(o=>o.sn));
            _diagMostrarAv('shopee_sns_periodo', `conta ${conta.external_id}`, {
              periodo: `${primeiroDia} a ${dataTo}`, totalRetornado: snsList.length, totalUnico: snsUnicos.size,
              statusPorSn: snsList.slice(0,20).map(o=>`${o.sn}:${o.status}`),
            });
            let diagPedidoFeito = false;
            for (let i=0; i<snsList.length; i+=50) {
              const lote = snsList.slice(i,i+50).map(o=>o.sn);
              try {
                const rd = await MarketplaceAPI.call('shopee_get_order_detail',{shopId, order_sn_list:lote});
                const orderList = rd.data?.response?.order_list || rd.data?.order_list || [];
                if (!diagPedidoFeito && orderList.length) {
                  diagPedidoFeito = true;
                  _diagMostrarAv('shopee_pedidos_valor', `conta ${conta.external_id}`, orderList.map(ord => ({
                    sn: ord.order_sn, status: ord.order_status,
                    total_amount: ord.total_amount,
                    itens: (ord.item_list||ord.items||[]).map(it => ({ nome: it.item_name||it.model_name, preco: it.model_discounted_price||it.item_price, qtd: it.model_quantity_purchased||it.quantity })),
                  })));
                }
                for (const ord of orderList) {
                  // Blindagem: status tipo READY_TO_SHIP é uma fila (fica até despachar),
                  // não um evento datado — se o filtro de data da API falhar pra esse
                  // status (visto em contas com volume alto), confere o create_time real
                  // do próprio pedido e descarta quem está fora do período pedido.
                  if (ord.create_time) {
                    const criadoEm = ord.create_time * 1000;
                    if (criadoEm < tsFrom || criadoEm > tsTo) { forasDoPeriodo++; continue; }
                  }
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
            if (forasDoPeriodo > 0) {
              _diagMostrarAv('shopee_filtrados_fora_periodo', `conta ${conta.external_id}`,
                { descartados: forasDoPeriodo, motivo: 'create_time real fora do período pedido — provável bug de filtro de data na API pra status tipo READY_TO_SHIP' });
            }
            // ADS Shopee — investimento real da conta no período. O total diário
            // (daily_performance) JÁ inclui o GMV Max da Loja (conferido em
            // 14/10/2026) — antes o GMV Max era somado de novo, contando duas vezes.
            try {
              const r = await MarketplaceAPI.call('shopee_ads_daily_performance', { shopId, start_date: toShopeeDate(primeiroDia), end_date: toShopeeDate(dataTo) });
              const dias = r?.data?.response || [];
              const adsTotalConta = Array.isArray(dias) ? dias.reduce((s,d) => s + (parseFloat(d.expense)||0), 0) : 0;
              adsPorConta[conta.external_id] = adsTotalConta;
            } catch(e) { console.warn('[Proj] ADS Shopee erro:', e.message); }
          }
        } catch(e) {
          console.warn(`[Proj] Erro conta ${label}:`, e.message);
        }
      }

      // Faturamento dos 3 meses fechados anteriores (Maio/Abril/Março) — roda pra
      // TODAS as contas em paralelo (limite 3 por vez) em vez de uma conta de cada vez
      // dentro do loop principal, que estava deixando a busca bem mais lenta.
      // Contas que já têm esses meses salvos não buscam de novo (a menos que "forçar").
      // Meses da base: M1/M2 prontos para quem a base cobre; M3 (fora dos 90 dias) ainda pela API
      const contasParaBuscarMeses = (forcarMesesAnteriores
        ? contasVinc
        : contasVinc.filter(c => !mesesJaSalvos[c.external_id]))
        .filter(c => { const ib = infoBaseDe(c.marketplace, idContaBase(c)); return !(ib && BaseDados.cobre(ib, m2.from) && mesesJaSalvos[c.external_id]?.marco); });
      if (btn) btn.textContent = `⏳ Buscando meses anteriores (${contasParaBuscarMeses.length}/${contasVinc.length} contas)...`;
      await _mapLimitAv(contasParaBuscarMeses, 3, async conta => {
        const mkt = (conta.marketplace||'').toLowerCase();
        try {
          if (['meli','ml','mercadolivre'].includes(mkt)) {
            const meliId = conta.param_to_use?.meliUserId || conta.external_id;
            [fatM1PorConta[conta.external_id], fatM2PorConta[conta.external_id], fatM3PorConta[conta.external_id]] =
              await Promise.all([fatMesFechadoML(meliId, m1), fatMesFechadoML(meliId, m2), fatMesFechadoML(meliId, m3)]);
          } else if (mkt === 'shopee') {
            const shopId = conta.param_to_use?.shopId || conta.external_id;
            [fatM1PorConta[conta.external_id], fatM2PorConta[conta.external_id], fatM3PorConta[conta.external_id]] =
              await Promise.all([fatMesFechadoShopee(shopId, m1), fatMesFechadoShopee(shopId, m2), fatMesFechadoShopee(shopId, m3)]);
          }
        } catch(e) { console.warn('[Proj] meses anteriores erro:', e.message); }
      });

      // Salva cache mesclado
      localStorage.setItem('glr_fin_cache', JSON.stringify({ ...(cacheExist||{}), ver:25, mesKey, pedidos }));

      // Atualiza data base para ONTEM (último dia fechado) — busca é sempre
      // automática, então também destrava um eventual override manual de dias
      const ontemIso = dataTo; // já calculado acima como ano-mes-dia de ontem
      projecaoAtiva._diasEditadosManualmente = false;
      projecaoAtiva.dataBase = ontemIso;
      projecaoAtiva.diasDecorridos = ontem.getDate();
      projecaoAtiva.diasNoMes = _diasNoMesDe(ontemIso);
      const inpDb = document.getElementById('inp-data-base');
      if (inpDb) inpDb.value = ontemIso;
      const inpDd = document.getElementById('inp-dias-dec');
      if (inpDd) inpDd.value = ontem.getDate();
      const inpDm = document.getElementById('inp-dias-mes');
      if (inpDm) inpDm.value = projecaoAtiva.diasNoMes;

      // Cria/atualiza uma linha por conta vinculada (identifica pelo contaId)
      const platMap = { mercadolivre:'Mercado Livre', ml:'Mercado Livre', meli:'Mercado Livre', shopee:'Shopee', bling:'Bling' };
      const nicks = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();

      // Remove TODAS as linhas: as sem contaId (antigas/manuais por plataforma), as
      // das contas vinculadas (recriadas abaixo com dados frescos) e as de contas que
      // não são mais deste cliente
      projecaoAtiva.plataformas = [];

      contasVinc.forEach(c => {
        const mktKey = (c.marketplace||'').toLowerCase();
        const nomePlat = platMap[mktKey] || c.marketplace || 'Outro';
        const tag = c.tags?.[0]?.name || '';
        const nome = nicks[c.external_id] || tag || c.nickname || c.external_id;
        // Se pulou a busca desse mês fechado (já tinha valor salvo), reaproveita o
        // que já existia em vez de zerar.
        const salvoAntes = mesesJaSalvos[c.external_id];
        const buscouDeNovo = fatM1PorConta[c.external_id] != null;
        projecaoAtiva.plataformas.push({
          nome, contaId: c.external_id, marketplace: c.marketplace,
          fatBase:'', adsBase:'', vendasBase:'',
          maio:  buscouDeNovo ? (fatM1PorConta[c.external_id] > 0 ? fatM1PorConta[c.external_id].toFixed(2) : '') : (salvoAntes?.maio  || ''),
          abril: buscouDeNovo ? (fatM2PorConta[c.external_id] > 0 ? fatM2PorConta[c.external_id].toFixed(2) : '') : (salvoAntes?.abril || ''),
          marco: buscouDeNovo ? (fatM3PorConta[c.external_id] > 0 ? fatM3PorConta[c.external_id].toFixed(2) : '') : (salvoAntes?.marco || ''),
          _platNome: nomePlat,
          _adsAuto: adsPorConta[c.external_id] || 0,
        });
      });

      // Contas cobertas pela base: M1/M2 vêm dela (mesma regra de Vendas)
      if (baseProj) {
        for (const p of projecaoAtiva.plataformas) {
          const ib = infoBaseDe(p.marketplace, p.contaId);
          if (ib && BaseDados.cobre(ib, m2.from)) {
            const v1 = BaseDados.somar(ib, m1.from, m1.to).faturamento, v2 = BaseDados.somar(ib, m2.from, m2.to).faturamento;
            p.maio = v1 > 0 ? v1.toFixed(2) : ''; p.abril = v2 > 0 ? v2.toFixed(2) : '';
          }
        }
      }
      salvar(); // persiste dataBase/dias/ads buscados — importante pro refresh automático das 5h
      renderTabela();
    } catch(e) {
      if (!silencioso) alert('Erro ao buscar dados: '+e.message);
      else console.warn('[Projeção] Erro na busca automática:', e.message);
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='Buscar dados'; }
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

  // Só preenche dados de uma linha vinculada a uma conta específica (contaId).
  // Sem contaId não busca/soma nada — evita contar a mesma conta duas vezes
  // (uma vez na linha por conta, outra vez agregada "por plataforma")
  function cacheParaPlat(cache, contasCliente, platNome, contaId) {
    if (!cache || !contaId) return null;
    const platFiltro = normalizaPlat(platNome);
    const isReemb = st => { const s=(st||'').toLowerCase(); return s.includes('cancel')||s.includes('refund')||s.includes('devol')||s==='invalid'||s.includes('return'); };
    const peds = (cache.pedidos||[]).filter(p => !isReemb(p.status) && String(p.contaId) === String(contaId) && p.plataforma === platFiltro);
    const fat = peds.reduce((s,p) => s+(parseFloat(p.valor)||0), 0);
    const qtd = peds.reduce((s,p) => s+(parseInt(p.qtd)||1), 0);
    // ADS por conta ainda não está no cache; usa por plataforma como fallback
    const ads = parseFloat((cache.adsAPI||{})[platFiltro]) || 0;
    return fat > 0 ? { fat, ads, vendas: qtd } : null;
  }

  // ── Painel da projeção ─────────────────────────────────────────────────────
  // Valores efetivos por conta: base automática primeiro (até a Data Base); conta
  // fora da base usa o que foi digitado / buscado pela API (fonte manual).
  const _pnFmt0 = v => 'R$ ' + Math.round(parseFloat(v) || 0).toLocaleString('pt-BR');
  const _pnPct = v => v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')}%`;
  const _pnEsc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let _pnUltimo = null; // números do último render (usados pelos gráficos)

  function calcularPainel() {
    const plats = projecaoAtiva.plataformas || [];
    const dd = parseInt(document.getElementById('inp-dias-dec')?.value) || projecaoAtiva.diasDecorridos;
    const dm = parseInt(document.getElementById('inp-dias-mes')?.value) || projecaoAtiva.diasNoMes;
    const cache = lerCacheAtual();
    let vinculos = {};
    try { vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}'); } catch (e) {}
    const cid = parseInt(document.getElementById('sel-cliente')?.value) || clienteIdAtivo;
    const contasCliente = (vinculos[String(cid)] || vinculos[cid] || []).map(c => c.external_id);
    let mudou = false;
    const linhas = plats.map((p, i) => {
      const bd = dadosBaseDaLinha(p);
      let fat, ads, vendas;
      if (bd) {
        fat = bd.fat; vendas = bd.vendas; ads = bd.ads != null ? bd.ads : (parseFloat(p.adsBase) || 0);
        // grava o valor da base na linha (Gestores, Carteira e relatório leem daqui)
        const f = fat.toFixed(2), v = String(vendas), a = bd.ads != null ? bd.ads.toFixed(2) : p.adsBase;
        if (p.fatBase !== f || p.vendasBase !== v || p.adsBase !== a) { p.fatBase = f; p.vendasBase = v; p.adsBase = a; mudou = true; }
      } else {
        const cd = cacheParaPlat(cache, contasCliente, p._platNome || p.nome, p.contaId);
        fat = parseFloat(p.fatBase) || (cd ? cd.fat : 0);
        vendas = parseFloat(p.vendasBase) || (cd ? cd.vendas : 0);
        ads = parseFloat(p.adsBase) || (p._adsAuto != null ? p._adsAuto : 0);
      }
      const proj = calcProjecao(fat, dd, dm), adsProj = calcProjecao(ads, dd, dm), vendasProj = calcProjecao(vendas, dd, dm);
      const m1 = parseFloat(p.maio) || 0, m2 = parseFloat(p.abril) || 0, m3 = parseFloat(p.marco) || 0;
      return { p, i, base: !!bd, fat, ads, vendas, proj, adsProj, vendasProj, m1, m2, m3, evo: calcEvolucao(proj, m1), tacos: proj > 0 && adsProj > 0 ? adsProj / proj * 100 : null };
    });
    if (mudou) salvar();
    const soma = k => linhas.reduce((s, l) => s + (l[k] || 0), 0);
    const tot = { fat: soma('fat'), ads: soma('ads'), vendas: soma('vendas'), proj: soma('proj'), adsProj: soma('adsProj'), vendasProj: soma('vendasProj'), m1: soma('m1'), m2: soma('m2'), m3: soma('m3') };
    tot.evo = calcEvolucao(tot.proj, tot.m1);
    const mediaMeses = [tot.m1, tot.m2, tot.m3].filter(v => v > 0);
    tot.media3 = mediaMeses.length ? mediaMeses.reduce((a, b) => a + b, 0) / mediaMeses.length : 0;
    tot.vsMedia = tot.media3 > 0 ? (tot.proj - tot.media3) / tot.media3 * 100 : null;
    tot.tacos = tot.proj > 0 && tot.adsProj > 0 ? tot.adsProj / tot.proj * 100 : null;
    tot.ticket = tot.vendas > 0 ? tot.fat / tot.vendas : null;
    let clientes = []; try { clientes = JSON.parse(localStorage.getItem('glr_clientes') || '[]'); } catch (e) {}
    const cli = clientes.find(c => c.id === cid);
    const valorVenda = parseFloat(cli?.valorPorVenda) || 0;
    tot.vendasCom = linhas.reduce((s, l) => s + (GLR.linhaGeraComissao(cid, l.p) ? l.vendasProj || 0 : 0), 0);
    tot.fatCom = linhas.reduce((s, l) => s + (GLR.linhaGeraComissao(cid, l.p) ? l.proj || 0 : 0), 0);
    tot.receitaGLR = cli ? GLR.comissao.estimar(cli, tot.vendasCom, tot.fatCom) : 0; // modelo de comissão do cliente; só linhas/contas que contam comissão
    let metas = {}; try { metas = JSON.parse(localStorage.getItem('glr_metas') || '{}'); } catch (e) {}
    tot.meta = metas[cid] ? parseFloat(metas[cid]) : null;
    return { linhas, tot, dd, dm, valorVenda, nBase: linhas.filter(l => l.base).length, nContas: linhas.filter(l => l.p.contaId).length };
  }

  function renderTabela() {
    const box = document.getElementById('pn-conteudo');
    if (!box) return;
    const r = calcularPainel(); _pnUltimo = r;
    const { linhas, tot, dd, dm } = r;
    const mesNome = (projecaoAtiva.mes || '').split(' ')[0];
    const m1Nome = (projecaoAtiva.labelM1 || _labelM1Default).split(' ')[0];
    const pctMes = dm ? Math.min(100, dd / dm * 100) : 0;
    const pctFat = tot.proj > 0 ? Math.min(100, tot.fat / tot.proj * 100) : 0;
    const corEvo = v => v == null ? 'var(--text-muted)' : v >= 0 ? 'var(--pn-bom)' : 'var(--pn-ruim)';
    const chip = (rot, v) => `<span class="pn-chip" style="--c:${corEvo(v)}">${v == null ? '—' : (v >= 0 ? '▲ ' : '▼ ') + _pnPct(v).replace(/^[+-]/, '')}<em>${rot}</em></span>`;
    const metaPct = tot.meta > 0 ? tot.proj / tot.meta * 100 : null;
    const tagMes = document.getElementById('pn-mes'); if (tagMes) tagMes.textContent = projecaoAtiva.mes;
    const inpDb = document.getElementById('inp-data-base'); if (inpDb && projecaoAtiva.dataBase && inpDb.value !== projecaoAtiva.dataBase) inpDb.value = projecaoAtiva.dataBase;
    const badge = document.getElementById('pn-fonte');
    if (badge) badge.innerHTML = r.nBase ? `base automática · ${r.nBase} conta${r.nBase === 1 ? '' : 's'}` : (r.nContas ? 'contas sem base — use Buscar dados' : 'nenhuma conta vinculada');
    const mkt = l => { const m = String(l.p.marketplace || l.p._platNome || '').toLowerCase(); return m.includes('shopee') ? { t: 'Shopee', c: '#eb6834' } : (m.includes('ml') || m.includes('meli') || m.includes('mercado')) ? { t: 'Mercado Livre', c: '#d9a400' } : { t: l.p.contaId ? 'Conta' : 'Manual', c: 'var(--text-muted)' }; };
    const inp = (i, campo, v, ph) => `<input class="pn-inp" value="${v ?? ''}" placeholder="${ph || '0'}" onchange="updatePlat(${i},'${campo}',this.value)">`;

    box.innerHTML = `
      <div class="pn-hero card">
        <div class="pn-hero-top">
          <div>
            <div class="pn-rot">Projeção de ${_pnEsc(mesNome)}</div>
            <div class="pn-big">${_pnFmt0(tot.proj)}</div>
            <div class="pn-sub">Faturado até ${projecaoAtiva.dataBase ? new Date(projecaoAtiva.dataBase + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : '—'}: <b>${_pnFmt0(tot.fat)}</b> · dia ${dd} de ${dm}</div>
          </div>
          <div class="pn-chips">
            ${chip(`vs ${_pnEsc(m1Nome)} (${_pnFmt0(tot.m1)})`, tot.evo)}
            ${chip(`vs média de 3 meses (${_pnFmt0(tot.media3)})`, tot.vsMedia)}
            ${metaPct != null ? `<span class="pn-chip" style="--c:${metaPct >= 100 ? 'var(--pn-bom)' : metaPct >= 85 ? 'var(--yellow)' : 'var(--pn-ruim)'}">${metaPct.toFixed(0)}%<em>da meta de ${_pnFmt0(tot.meta)}</em></span>` : ''}
          </div>
        </div>
        <div class="pn-barra" title="Faturado até a data base sobre a projeção do mês">
          <div class="pn-barra-fat" style="width:${pctFat}%"></div>
          <div class="pn-barra-dia" style="left:${pctMes}%" title="Dia ${dd} de ${dm}"></div>
        </div>
        <div class="pn-barra-leg"><span><i style="background:var(--pn-azul)"></i>Faturado ${pctFat.toFixed(0)}% da projeção</span><span><i class="pn-tick"></i>${pctMes.toFixed(0)}% do mês passado</span></div>
      </div>

      <div class="pn-kpis">
        <div class="pn-kpi"><div class="pn-rot">Vendas projetadas</div><div class="pn-val">${Math.round(tot.vendasProj).toLocaleString('pt-BR')}</div><div class="pn-sub">${Math.round(tot.vendas).toLocaleString('pt-BR')} até agora${tot.ticket ? ` · ticket ${_pnFmt0(tot.ticket)}` : ''}</div></div>
        <div class="pn-kpi"><div class="pn-rot">ADS projetado</div><div class="pn-val">${tot.adsProj > 0 ? _pnFmt0(tot.adsProj) : '—'}</div><div class="pn-sub">${tot.ads > 0 ? `${_pnFmt0(tot.ads)} investidos até agora` : 'sem ADS no período'}</div></div>
        <div class="pn-kpi"><div class="pn-rot">TACOS</div><div class="pn-val">${tot.tacos != null ? tot.tacos.toFixed(1).replace('.', ',') + '%' : '—'}</div><div class="pn-sub">ADS ÷ faturamento</div></div>
      </div>

      <div class="pn-graficos">
        <div class="card pn-graf"><div class="pn-graf-t">Ritmo do mês</div><div class="pn-sub">Faturamento acumulado dia a dia × ${_pnEsc(m1Nome)}, com a linha da projeção</div><div class="pn-graf-area"><canvas id="pn-chart-ritmo"></canvas></div><div class="pn-leg" id="pn-leg-ritmo"></div></div>
        <div class="card pn-graf"><div class="pn-graf-t">Últimos meses</div><div class="pn-sub">Meses fechados e a projeção de ${_pnEsc(mesNome)}</div><div class="pn-graf-area"><canvas id="pn-chart-meses"></canvas></div></div>
      </div>

      <div class="pn-sec-t">Por conta</div>
      <div class="pn-contas">
        ${linhas.map(l => { const m = mkt(l); return `
          <div class="card pn-conta" style="--m:${m.c}">
            <div class="pn-conta-top">
              <div style="min-width:0"><div class="pn-conta-nome">${l.p.contaId ? _pnEsc(l.p.nome) : inp(l.i, 'nome', _pnEsc(l.p.nome), 'Nome da fonte')}</div>
              <div class="pn-sub"><span class="pn-mkt">${m.t}</span>${l.base ? ' · base automática' : l.p.contaId ? ' · fora da base' : ' · digitado'}</div></div>
              ${l.p.contaId ? '' : `<button class="pn-x" onclick="removePlat(${l.i})" title="Remover esta fonte">✕</button>`}
            </div>
            <div class="pn-conta-num"><div><div class="pn-rot">Projeção</div><div class="pn-val">${_pnFmt0(l.proj)}</div></div><div style="text-align:right">${chip(`vs ${_pnEsc(m1Nome)}`, l.evo)}</div></div>
            <div class="pn-conta-grid">
              <div><span>Até agora</span><b>${l.base ? _pnFmt0(l.fat) : inp(l.i, 'fatBase', l.p.fatBase, '0,00')}</b></div>
              <div><span>Vendas</span><b>${l.base ? Math.round(l.vendas).toLocaleString('pt-BR') : inp(l.i, 'vendasBase', l.p.vendasBase)}</b></div>
              <div><span>ADS</span><b>${l.base && l.ads ? _pnFmt0(l.ads) : l.base ? '—' : inp(l.i, 'adsBase', l.p.adsBase, '0,00')}</b></div>
              <div><span>TACOS</span><b>${l.tacos != null ? l.tacos.toFixed(1).replace('.', ',') + '%' : '—'}</b></div>
            </div>
            <div class="pn-conta-meses">${[['marco', l.m3, projecaoAtiva.labelM3 || _labelM3Default], ['abril', l.m2, projecaoAtiva.labelM2 || _labelM2Default], ['maio', l.m1, projecaoAtiva.labelM1 || _labelM1Default]].map(([campo, v, lb]) => `<div><span>${_pnEsc(lb.split(' ')[0].slice(0, 3))}</span>${l.base ? `<b>${v ? _pnFmt0(v) : '—'}</b>` : inp(l.i, campo, l.p[campo], '0,00')}</div>`).join('')}</div>
          </div>`; }).join('') || '<div class="card pn-vazio">Nenhuma conta nesta projeção. Use <b>Vincular contas</b> para puxar os números da base automática.</div>'}
      </div>`;
    setTimeout(atualizarGrafico, 0);
  }

  el.innerHTML = `<div class="page pn">
    <div class="pn-head">
      <div class="pn-head-l">
        ${GLR.clientes.length === 0
          ? `<div class="pn-cliente-txt">${_pnEsc(projecaoAtiva.nomeCliente || 'Projeção')}</div>`
          : `<select id="sel-cliente" class="pn-cliente" onchange="trocarCliente(parseInt(this.value))">
               ${GLR.clientes.map(c => `<option value="${c.id}" ${c.id === clienteIdAtivo ? 'selected' : ''}>${_pnEsc(c.nome)}</option>`).join('')}
             </select>`}
        <div class="pn-head-info">
          <span class="pn-tag" id="pn-mes">${_pnEsc(projecaoAtiva.mes)}</span>
          <span class="pn-tag pn-tag-fonte" id="pn-fonte">…</span>
          <span id="lbl-atualizado" class="pn-mut">${projecaoAtiva.atualizadoEm ? 'Salvo ' + new Date(projecaoAtiva.atualizadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>
        </div>
      </div>
      <div class="pn-head-r">
        <button class="pn-btn" onclick="abrirVinculoProjecao()">Vincular contas</button>
        <details class="pn-mais"><summary class="pn-btn">⋯ Mais</summary>
          <div class="pn-menu">
            <button id="btn-buscar-proj" onclick="buscarDadosProjecao()">Buscar dados pela API <small>contas fora da base</small></button>
            <button id="btn-forcar-meses-proj" onclick="buscarDadosProjecao(false, true)">↺ Buscar meses anteriores de novo</button>
            <button onclick="adicionarPlat()">+ Fonte manual <small>ex.: Amazon, loja própria</small></button>
            <button onclick="exportarProjecao()">Exportar CSV</button>
            <button onclick="limparDadosManuais()" style="color:var(--red)">Limpar valores digitados</button>
          </div>
        </details>
        <button class="pn-btn pn-btn-p" onclick="salvarProjecao(this)">Salvar</button>
      </div>
    </div>
    <div class="pn-periodo">
      <label>Data base <input id="inp-data-base" type="date" class="pn-date" value="${projecaoAtiva.dataBase || ''}" onchange="updateDataBase(this.value)"></label>
      <span class="pn-mut">dia <input id="inp-dias-dec" type="number" class="pn-dia" value="${projecaoAtiva.diasDecorridos}" min="1" max="31" oninput="updateDias()"> de <input id="inp-dias-mes" type="number" class="pn-dia" value="${projecaoAtiva.diasNoMes}" min="28" max="31" oninput="updateDias()"></span>
      <span class="pn-mut">Projeção = faturado até a data base ÷ dias decorridos × dias do mês</span>
    </div>
    <div id="pn-conteudo"></div>
    <div class="card" style="margin-top:18px;padding:16px 18px;">
      <div class="pn-graf-t" style="margin-bottom:8px;">Observações</div>
      <textarea id="proj-obs" class="form-textarea" placeholder="Contexto do mês, eventos, campanhas, rupturas de estoque…" style="min-height:70px;">${_pnEsc(projecaoAtiva.obs || '')}</textarea>
    </div>
  </div>`;

  if (!document.getElementById('pn-styles')) {
    const st = document.createElement('style');
    st.id = 'pn-styles';
    st.textContent = `
      .pn{--pn-azul:var(--accent);--pn-cinza:var(--text-muted);--pn-bom:var(--green);--pn-ruim:var(--red);}
      .pn-mut{font-size:12px;color:var(--text-muted);}
      .pn-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:10px;}
      .pn-head-l{min-width:0;}
      .pn-cliente{appearance:none;-webkit-appearance:none;background:transparent;border:none;font-size:26px;font-weight:800;color:var(--text-primary);cursor:pointer;outline:none;padding:0 22px 0 0;max-width:100%;
        background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 9px) 55%,calc(100% - 4px) 55%;background-size:5px 5px;background-repeat:no-repeat;}
      .pn-cliente option{font-size:14px;color:#111;}
      .pn-cliente-txt{font-size:26px;font-weight:800;color:var(--text-primary);}
      .pn-head-info{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;}
      .pn-tag{font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;background:rgba(42,120,214,.12);color:var(--pn-azul);}
      .pn-tag-fonte{background:rgba(22,163,74,.12);color:var(--pn-bom);}
      .pn-head-r{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
      .pn-btn{border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);border-radius:9px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;list-style:none;}
      .pn-btn::-webkit-details-marker{display:none;}
      .pn-btn:hover{border-color:var(--pn-azul);}
      .pn-btn-p{background:var(--pn-azul);border-color:var(--pn-azul);color:#fff;}
      .pn-mais{position:relative;}
      .pn-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:6px;min-width:250px;box-shadow:0 12px 30px rgba(0,0,0,.18);}
      .pn-menu button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--text-primary);padding:9px 10px;border-radius:8px;font-size:13px;cursor:pointer;}
      .pn-menu button:hover{background:var(--bg-card-hover);}
      .pn-menu small{display:block;color:var(--text-muted);font-size:11px;}
      .pn-periodo{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:16px;font-size:12.5px;color:var(--text-secondary);}
      .pn-date,.pn-dia{background:var(--bg-card);border:1px solid var(--border);border-radius:7px;color:var(--text-primary);padding:4px 7px;font-size:12px;margin-left:4px;}
      .pn-dia{width:48px;margin:0 2px;}
      .pn-hero{padding:22px 24px 18px;margin-bottom:14px;}
      .pn-hero-top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:16px;}
      .pn-rot{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;}
      .pn-big{font-size:40px;font-weight:800;color:var(--text-primary);letter-spacing:-1px;font-variant-numeric:tabular-nums;line-height:1.1;margin:2px 0 4px;}
      .pn-sub{font-size:12.5px;color:var(--text-muted);}
      .pn-sub b{color:var(--text-primary);}
      .pn-chips{display:flex;gap:8px;flex-wrap:wrap;}
      .pn-chip{display:inline-flex;flex-direction:column;gap:1px;font-weight:800;font-size:15px;color:var(--c);background:color-mix(in srgb,var(--c) 10%,transparent);border-radius:10px;padding:7px 12px;font-variant-numeric:tabular-nums;}
      .pn-chip em{font-style:normal;font-weight:500;font-size:11px;color:var(--text-muted);}
      .pn-barra{position:relative;height:12px;background:var(--bg-card-hover);border-radius:99px;overflow:visible;}
      .pn-barra-fat{height:100%;background:var(--pn-azul);border-radius:99px;transition:width .4s;}
      .pn-barra-dia{position:absolute;top:-4px;width:2px;height:20px;background:var(--text-primary);opacity:.55;border-radius:2px;}
      .pn-barra-leg{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--text-muted);margin-top:8px;}
      .pn-barra-leg span{display:flex;align-items:center;gap:6px;}
      .pn-barra-leg i{width:10px;height:10px;border-radius:3px;display:inline-block;}
      .pn-barra-leg .pn-tick{width:2px;height:12px;background:var(--text-primary);opacity:.55;border-radius:1px;}
      .pn-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px;}
      @media (max-width:900px){.pn-kpis{grid-template-columns:1fr;}.pn-big{font-size:32px;}}
      .pn-kpi{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:14px 16px;}
      .pn-val{font-size:21px;font-weight:800;color:var(--text-primary);font-variant-numeric:tabular-nums;margin:2px 0;}
      .pn-graficos{display:grid;grid-template-columns:3fr 2fr;gap:14px;margin-bottom:18px;}
      @media (max-width:1000px){.pn-graficos{grid-template-columns:1fr;}}
      .pn-graf{padding:16px 18px 12px;min-width:0;}
      .pn-graficos>*,.pn-kpis>*,.pn-contas>*{min-width:0;}
      .pn-graf-t{font-size:14.5px;font-weight:800;color:var(--text-primary);}
      .pn-graf-area{position:relative;height:250px;margin-top:10px;}
      .pn-leg{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--text-secondary);margin-top:6px;}
      .pn-leg span{display:flex;align-items:center;gap:6px;} .pn-leg i{width:16px;height:0;border-top:2px solid;display:inline-block;}
      .pn-sec-t{font-size:15px;font-weight:800;color:var(--text-primary);margin:4px 0 10px;}
      .pn-contas{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:14px;}
      .pn-conta{padding:20px 22px;border-top:4px solid var(--m);}
      .pn-conta-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:8px;}
      .pn-conta-nome{font-weight:800;color:var(--text-primary);font-size:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pn-mkt{color:var(--m);font-weight:700;}
      .pn-conta .pn-sub{font-size:13px;}
      .pn-x{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;padding:2px 4px;border-radius:6px;} .pn-x:hover{color:var(--red);background:rgba(220,38,38,.08);}
      .pn-conta-num{display:flex;justify-content:space-between;align-items:flex-end;gap:8px;margin:6px 0 16px;}
      .pn-conta-num .pn-val{font-size:30px;letter-spacing:-.5px;}
      .pn-conta-num .pn-chip{font-size:15px;padding:7px 11px;}
      .pn-conta-grid,.pn-conta-meses{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
      .pn-conta-meses{grid-template-columns:repeat(3,1fr);border-top:1px solid var(--border);padding-top:14px;margin-top:14px;}
      .pn-conta-grid>div,.pn-conta-meses>div{background:var(--bg-card-hover);border-radius:10px;padding:9px 11px;}
      .pn-conta-grid span,.pn-conta-meses span{display:block;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;}
      .pn-conta-grid b,.pn-conta-meses b{color:var(--text-primary);font-variant-numeric:tabular-nums;font-size:16px;}
      @media (max-width:520px){.pn-conta-grid{grid-template-columns:repeat(2,1fr);}}
      .pn-inp{width:100%;background:var(--bg-card-hover);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);padding:3px 6px;font-size:12px;font-weight:600;}
      .pn-vazio{padding:28px;text-align:center;color:var(--text-muted);grid-column:1/-1;}
    `;
    document.head.appendChild(st);
  }

  // ---- Handlers ----
  window.limparDadosManuais = () => {
    if (!confirm('Limpar todos os dados inseridos manualmente (faturamento base, ADS, vendas e histórico)? Os dados da API continuam visíveis automaticamente.')) return;
    // Mantém a ligação de cada linha com a conta (contaId/marketplace) — só zera os valores
    projecaoAtiva.plataformas = projecaoAtiva.plataformas.map(p => ({
      ...p,
      fatBase: '', adsBase: '', vendasBase: '',
      maio: '', abril: '', marco: '',
    }));
    aplicarBase(true);
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
    const pl = projecaoAtiva.plataformas[i];
    if (!pl || !confirm(`Remover a fonte "${pl.nome}" desta projeção?`)) return;
    projecaoAtiva.plataformas.splice(i, 1);
    salvar();
    renderTabela();
    atualizarGrafico();
  };

  window.toggleGLRProjecao = () => {
    ocultarGLR = !ocultarGLR;
    const btn = document.getElementById('btn-toggle-glr');
    if (btn) btn.textContent = ocultarGLR ? 'GLR oculta' : 'Ocultar GLR';
    renderTabela();
  };

  window.buscarDadosProjecao = buscarDadosProjecao;

  window.adicionarPlat = () => {
    projecaoAtiva.plataformas.push({ nome: 'Nova fonte', fatBase: '', adsBase: '', vendasBase: '', maio: '', abril: '', marco: '' });
    salvar();
    renderTabela();
  };

  window.updateDias = () => {
    // Edição direta dos campos "trava" o auto-cálculo pela Data Base até o
    // usuário mudar a Data Base de novo (aí volta a seguir automaticamente)
    projecaoAtiva._diasEditadosManualmente = true;
    projecaoAtiva.diasDecorridos = parseInt(document.getElementById('inp-dias-dec').value) || projecaoAtiva.diasDecorridos;
    projecaoAtiva.diasNoMes = parseInt(document.getElementById('inp-dias-mes').value) || projecaoAtiva.diasNoMes;
    salvar(); // auto-save ao alterar dias
    renderTabela();
    atualizarGrafico();
  };

  window.updateDataBase = (dataStr) => {
    if (!dataStr) return;
    // Mudar a Data Base é a fonte da verdade pra dias decorridos/dias no mês —
    // sempre recalcula os dois e destrava um eventual override manual anterior
    projecaoAtiva._diasEditadosManualmente = false;
    projecaoAtiva.dataBase = dataStr;
    const d = new Date(dataStr + 'T12:00:00');
    const dia = d.getDate();
    projecaoAtiva.diasDecorridos = dia;
    projecaoAtiva.diasNoMes = _diasNoMesDe(dataStr);
    document.getElementById('inp-dias-dec').value = dia;
    const inpDm = document.getElementById('inp-dias-mes');
    if (inpDm) inpDm.value = projecaoAtiva.diasNoMes;
    salvar(); // atualiza também os rótulos de mês
    aplicarBase(true);
    renderTabela();
  };

  window.salvarProjecao = (btn) => {
    projecaoAtiva.obs = document.getElementById('proj-obs')?.value || '';
    projecaoAtiva.atualizadoEm = new Date().toISOString();
    const lblAtt = document.getElementById('lbl-atualizado');
    if (lblAtt) lblAtt.textContent = 'Salvo ' + new Date().toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});

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
    _rotulosDaDataBase(projecaoAtiva);
    const mesLabel = projecaoAtiva.mes;

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
        // Usa o label REAL do mês fechado (ex.: "Ago/2026"), não mais fixo em
        // "Maio/Abril/Março" — antes isso sobrescrevia o histórico de Maio com dado
        // de outro mês assim que o "mês fechado -1" deixava de ser Maio de fato.
        upsertMes(projecaoAtiva.labelM1 || 'Maio',  fatMaio,  plats.reduce((s,p)=>s+(parseFloat(p.adsBase)||0),0));
        upsertMes(projecaoAtiva.labelM2 || 'Abril', fatAbril, 0);
        upsertMes(projecaoAtiva.labelM3 || 'Março', fatMarco, 0);

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
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;background:var(--green);color:white;padding:12px 20px;border-radius:10px;font-size:13.5px;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.3);animation:fadeIn 0.2s ease;`;
    toast.innerHTML = `✅ Projeção salva — dados sincronizados com o cliente`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  };

  window.exportarProjecao = () => {
    const dd = projecaoAtiva.diasDecorridos;
    const dm = projecaoAtiva.diasNoMes;
    const plats = projecaoAtiva.plataformas;
    const mesLabel = projecaoAtiva.mes || 'Projeção';
    const lblM1 = projecaoAtiva.labelM1 || _labelM1Default, lblM2 = projecaoAtiva.labelM2 || _labelM2Default, lblM3 = projecaoAtiva.labelM3 || _labelM3Default;
    let csv = `Plataforma;Fat. Base;Projeção ${mesLabel};ADS Investido Base;Projeção ADS;% ADS s/ Fat.;Evolução Mês Ant.;Fat. ${lblM1};Fat. ${lblM2};Fat. ${lblM3}\n`;
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
        mes:            _mesLabel,
        dataBase:       `${_ontem.getFullYear()}-${String(_ontem.getMonth()+1).padStart(2,'0')}-${String(_ontem.getDate()).padStart(2,'0')}`,
        diasNoMes:      _diasNoMes,
        diasDecorridos: _ontem.getDate(),
        obs:            '',
        plataformas: []
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
              <div style="font-size:16px;font-weight:700;color:var(--text-primary);">Contas vinculadas</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${cliente?.nome || 'Cliente #'+cidAtivo}</div>
            </div>
            <button id="btn-fechar-vinculos" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-muted);">✕</button>
          </div>

          ${vinculadas.length === 0
            ? `<div style="padding:16px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;font-size:13px;color:var(--yellow);margin-bottom:16px;">⚠️ Nenhuma conta vinculada ainda</div>`
            : `<div style="margin-bottom:16px;">
                <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:none;letter-spacing:0;margin-bottom:8px;">Contas vinculadas (${vinculadas.length})</div>
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
                      <button onclick="window._desvincularProj('${c.external_id}')" style="background:rgba(239,68,68,0.15);border:none;color:var(--red);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;">remover</button>
                    </div>`;
                  }).join('')}
                </div>
              </div>`
          }

          ${contasDisponiveis.length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:none;letter-spacing:0;margin-bottom:8px;">Adicionar conta</div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${contasDisponiveis.map(c => {
                const tag = (c.tags||[]).map(t=>t.name||t.value).filter(Boolean).join(' · ');
                const nick = nicks[c.external_id] || '';
                return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:8px;">
                  <span style="font-size:16px;">${platIcon[c.marketplace]||'🏪'}</span>
                  <div style="flex:1;min-width:0;">
                    <div style="font-size:12px;font-weight:600;">${nick || tag || platNome[c.marketplace]||c.marketplace}</div>
                    <div style="font-size:10px;color:var(--text-muted);">ID: ${c.external_id}</div>
                    ${tag ? `<div style="font-size:10px;color:var(--accent-light);">${tag}</div>` : ''}
                  </div>
                  <button onclick="window._vincularProj('${c.external_id}')" style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.4);color:var(--accent-light);border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;">+ vincular</button>
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
        // Cria uma linha por conta vinculada (identificada por contaId)
        const platMap2 = { mercadolivre:'Mercado Livre', ml:'Mercado Livre', meli:'Mercado Livre', shopee:'Shopee', bling:'Bling' };
        const nicks2 = (() => { try { return JSON.parse(localStorage.getItem('glr_mc_nicknames')||'{}'); } catch(e) { return {}; } })();
        const vinculadasAtual = (vinculos[String(cidAtivo)] || []);
        const contaIdsVinc = new Set(vinculadasAtual.map(c => String(c.external_id)));
        // Remove linhas sem contaId (antigas/manuais) e linhas de contas desvinculadas
        projecaoAtiva.plataformas = (projecaoAtiva.plataformas||[]).filter(p => p.contaId && contaIdsVinc.has(String(p.contaId)));
        // Adiciona linhas para contas vinculadas que ainda não têm linha
        const existingIds = new Set((projecaoAtiva.plataformas||[]).map(p => String(p.contaId)).filter(Boolean));
        vinculadasAtual.forEach(c => {
          if (existingIds.has(c.external_id)) return;
          const mktKey = (c.marketplace||'').toLowerCase();
          const platNomeDisplay = platMap2[mktKey] || c.marketplace || 'Outro';
          const tag = c.tags?.[0]?.name || '';
          const nome = nicks2[c.external_id] || tag || c.nickname || c.external_id;
          projecaoAtiva.plataformas.push({
            nome, contaId: c.external_id, marketplace: c.marketplace,
            fatBase:'', adsBase:'', vendasBase:'', maio:'', abril:'', marco:'',
            _platNome: platNomeDisplay,
          });
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
      chave, nomeCliente: nome.trim(), mes: _mesLabel,
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

  // Gráficos (Chart.js): ritmo do mês (acumulado diário × mês anterior + linha
  // da projeção) e últimos meses × projeção. Cores do tema categórico validado.
  function atualizarGrafico() {
    const r = _pnUltimo;
    if (!r || !window.Chart) return;
    const claro = document.body.classList.contains('light');
    const C = { azul: claro ? '#2a78d6' : '#3987e5', cinza: claro ? '#94a3b8' : '#64748b', texto: claro ? '#475569' : '#94a3b8', grade: claro ? 'rgba(15,23,42,.07)' : 'rgba(255,255,255,.06)', fundo: claro ? '#fff' : '#111827', titulo: claro ? '#0f172a' : '#f1f5f9', borda: claro ? 'rgba(15,23,42,.12)' : 'rgba(255,255,255,.12)' };
    const kfmt = v => Math.abs(v) >= 1000 ? `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil` : `R$ ${Math.round(v)}`;
    const tip = { backgroundColor: C.fundo, titleColor: C.titulo, bodyColor: C.texto, borderColor: C.borda, borderWidth: 1, padding: 11, cornerRadius: 10, boxPadding: 4, usePointStyle: true };
    const eixos = { x: { grid: { display: false }, border: { display: false }, ticks: { color: C.texto, font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 11 } }, y: { beginAtZero: true, grid: { color: C.grade, drawTicks: false }, border: { display: false }, ticks: { color: C.texto, font: { size: 11 }, padding: 8, maxTicksLimit: 5, callback: kfmt } } };
    const { dd, dm, tot } = r;
    const db = projecaoAtiva.dataBase ? new Date(projecaoAtiva.dataBase + 'T12:00:00') : _ontem;
    const pad = n => String(n).padStart(2, '0');
    const isoDe = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
    // Faturamento por dia das contas na base (mês atual e anterior)
    const ano = db.getFullYear(), mes = db.getMonth();
    const ant = new Date(ano, mes - 1, 1), dmAnt = new Date(ano, mes, 0).getDate();
    const diaAtual = Array(dm).fill(0), diaAnt = Array(Math.max(dm, dmAnt)).fill(0);
    let temDiario = false;
    for (const l of r.linhas) {
      if (!l.base) continue;
      const info = infoBaseDe(l.p.marketplace || l.p._platNome, l.p.contaId);
      const dias = info?.dias || {};
      for (let d = 1; d <= dd; d++) { const v = parseFloat(dias[isoDe(ano, mes, d)]?.faturamento) || 0; diaAtual[d - 1] += v; if (v) temDiario = true; }
      for (let d = 1; d <= dmAnt; d++) diaAnt[d - 1] += parseFloat(dias[isoDe(ant.getFullYear(), ant.getMonth(), d)]?.faturamento) || 0;
    }
    const labels = Array.from({ length: dm }, (_, i) => String(i + 1));
    const acum = arr => { let s = 0; return arr.map(v => (s += v)); };
    const acAtual = acum(diaAtual).map((v, i) => i < dd ? v : null);
    const acAnt = acum(diaAnt).slice(0, dm);
    const fatAte = temDiario ? acAtual[dd - 1] : tot.fat;
    const linhaProj = labels.map((_, i) => i < dd - 1 ? null : fatAte + (tot.proj - fatAte) * ((i + 1 - dd) / Math.max(1, dm - dd)));
    const m1Nome = (projecaoAtiva.labelM1 || _labelM1Default).split(' ')[0], mesNome = (projecaoAtiva.mes || '').split(' ')[0];
    const cv1 = document.getElementById('pn-chart-ritmo');
    if (cv1) {
      if (window._pnChartRitmo) window._pnChartRitmo.destroy();
      const ds = [];
      if (temDiario) ds.push({ label: mesNome, data: acAtual, borderColor: C.azul, backgroundColor: ctx => { const a = ctx.chart.chartArea; if (!a) return C.azul + '00'; const g = ctx.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, C.azul + '38'); g.addColorStop(1, C.azul + '00'); return g; }, fill: 'origin', borderWidth: 2.5, tension: .3, pointRadius: 0, pointHoverRadius: 5 });
      ds.push({ label: `Projeção de ${mesNome}`, data: linhaProj, borderColor: C.azul, borderDash: [6, 5], borderWidth: 2, pointRadius: labels.map((_, i) => i === dm - 1 ? 4 : 0), pointBackgroundColor: C.azul, fill: false, tension: 0 });
      if (acAnt.some(v => v > 0)) ds.push({ label: m1Nome, data: acAnt, borderColor: C.cinza, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: false, tension: .3 });
      window._pnChartRitmo = new Chart(cv1, { type: 'line', data: { labels, datasets: ds }, options: { responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { ...tip, callbacks: { title: it => `Dia ${it[0].label}`, label: it => it.parsed.y == null ? null : ` ${it.dataset.label}: R$ ${Math.round(it.parsed.y).toLocaleString('pt-BR')}` } } }, scales: eixos } });
      const leg = document.getElementById('pn-leg-ritmo');
      if (leg) leg.innerHTML = `${temDiario ? `<span><i style="border-color:${C.azul}"></i>${mesNome} (acumulado)</span>` : ''}<span><i style="border-color:${C.azul};border-top-style:dashed"></i>Projeção até o fim do mês</span>${acAnt.some(v => v > 0) ? `<span><i style="border-color:${C.cinza}"></i>${m1Nome}</span>` : ''}${temDiario ? '' : '<span>· sem dados diários (contas fora da base)</span>'}`;
    }
    const cv2 = document.getElementById('pn-chart-meses');
    if (cv2) {
      if (window._pnChartMeses) window._pnChartMeses.destroy();
      const lb = [projecaoAtiva.labelM3 || _labelM3Default, projecaoAtiva.labelM2 || _labelM2Default, projecaoAtiva.labelM1 || _labelM1Default].map(x => x.split(' ')[0].slice(0, 3));
      const vals = [tot.m3, tot.m2, tot.m1, tot.proj];
      window._pnChartMeses = new Chart(cv2, {
        type: 'bar',
        data: { labels: [...lb, `${mesNome.slice(0, 3)} (proj.)`], datasets: [
          { label: 'Faturamento', data: vals, backgroundColor: [C.cinza + '99', C.cinza + '99', C.cinza + 'cc', C.azul + '40'], borderColor: [C.cinza, C.cinza, C.cinza, C.azul], borderWidth: [0, 0, 0, 2], borderDash: [], borderRadius: 8, borderSkipped: false, maxBarThickness: 56, grouped: false },
          { label: 'Faturado até agora', data: [null, null, null, temDiario ? fatAte : tot.fat], backgroundColor: C.azul, borderRadius: 8, borderSkipped: false, maxBarThickness: 56, grouped: false },
        ] },
        options: { responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, plugins: { legend: { display: false }, tooltip: { ...tip, filter: it => it.parsed.y != null, callbacks: { label: it => ` ${it.dataIndex === 3 ? (it.datasetIndex === 0 ? 'Projeção' : 'Faturado até agora') : 'Fechado'}: R$ ${Math.round(it.parsed.y).toLocaleString('pt-BR')}` } } }, scales: eixos },
      });
    }
  }

  renderTabela();
  setTimeout(atualizarGrafico, 50);
  carregarBaseProj();
  // Servidor terminou uma rodada de sincronização → recarrega a base e redesenha
  window._projRecarregarBase = () => carregarBaseProj(true);
  if (!window._projOuvindoBase) {
    window._projOuvindoBase = true;
    window.addEventListener('glr-base-atualizada', () => { if (Router.currentPage === 'projecao' && window._projRecarregarBase) window._projRecarregarBase(); });
  }

  // ── Auto-refresh diário às 5h — fora disso só atualiza manualmente (botão) ──
  // Checa a cada 10 min se são 5h e se ainda não rodou hoje; evita popup de erro
  // (modo silencioso) e não busca nada se não houver conta vinculada.
  if (window._projAutoRefreshTimer) clearInterval(window._projAutoRefreshTimer);
  window._projAutoRefreshTimer = setInterval(() => {
    const agora = new Date();
    const hojeStr = `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-${String(agora.getDate()).padStart(2,'0')}`;
    const ultimoAuto = localStorage.getItem('glr_proj_ultimo_auto');
    if (agora.getHours() === 5 && ultimoAuto !== hojeStr) {
      localStorage.setItem('glr_proj_ultimo_auto', hojeStr);
      buscarDadosProjecao(true);
    }
  }, 10 * 60 * 1000);
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
    const vendasCom  = plats.reduce((s,p) => s + (GLR.linhaGeraComissao(c.id, p) ? calcProj(p.vendasBase) : 0), 0);
    const fatCom     = plats.reduce((s,p) => s + (GLR.linhaGeraComissao(c.id, p) ? calcProj(p.fatBase) : 0), 0);
    const receitaGLR = GLR.comissao.estimar(c, vendasCom, fatCom); // modelo de comissão do cliente
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
          <div style="font-size:11px;color:#888;text-transform:none;letter-spacing:0;margin-bottom:6px;">Relatório de Gestão · Confidencial</div>
          <div style="font-size:26px;font-weight:700;color:#1a2744;">${c.nome}</div>
          <div style="font-size:13px;color:#666;margin-top:4px;">${mesAtual} ${anoAtual} · Gerado em ${new Date().toLocaleDateString('pt-BR')}</div>
          <div style="margin-top:8px;">
            <span style="background:${sc}22;color:${sc};border:1px solid ${sc}44;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;">${GLR.statusLabel[c.status]||c.status}</span>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="width:60px;height:60px;border-radius:12px;background:linear-gradient(135deg,var(--accent),#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:white;margin-left:auto;">${c.nome.charAt(0)}</div>
          <div style="font-size:12px;color:#888;margin-top:8px;">Gestor: <strong style="color:#333;">${c.gestor||'—'}</strong></div>
          <div style="font-size:12px;color:#888;">Responsável: <strong style="color:#333;">${c.responsavel||'—'}</strong></div>
          ${GLR.comissao.temComissao(c) ? `<div style="font-size:12px;color:#888;">Comissão GLR: <strong style="color:#333;">${GLR.comissao.descricao(c)}</strong></div>` : ''}
        </div>
      </div>

      <!-- KPIs da Projeção -->
      ${plats.length ? `
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:14px;color:#1a2744;">Projeção do Mês — ${proj?.mes || mesAtual+' '+anoAtual}</div>
        <div style="display:grid;grid-template-columns:repeat(${receitaGLR>0?5:4},1fr);gap:10px;">
          ${[
            { l:'Faturamento Projetado', v: fmtFull(fatProj), icon:'💰', c:'#6366f1' },
            { l:'Vendas Projetadas',     v: Math.round(vendasProj).toLocaleString('pt-BR'), icon:'📦', c:'#10b981' },
            { l:'Ticket Médio',          v: ticketMedio>0 ? fmtFull(ticketMedio) : '—', icon:'🧾', c:'#06b6d4' },
            { l:'Investimento ADS',      v: fmtFull(adsProj), icon:'📢', c:'#f59e0b' },
            ...(receitaGLR>0 ? [{ l:'Receita GLR', v: fmtFull(receitaGLR), icon:'🏆', c:'#10b981' }] : []),
          ].map(k=>`
            <div style="background:var(--bg-subtle);border:1px solid #e5e7eb;border-radius:8px;padding:14px;text-align:center;">
              <div style="font-size:20px;margin-bottom:4px;">${k.icon}</div>
              <div style="font-size:15px;font-weight:700;color:${k.c};">${k.v}</div>
              <div style="font-size:10px;color:#888;margin-top:2px;text-transform:none;letter-spacing:0;">${k.l}</div>
            </div>`).join('')}
        </div>
        ${pctADS>0?`<div style="margin-top:10px;font-size:12px;color:#888;text-align:right;">% ADS sobre Faturamento: <strong style="color:var(--yellow);">${pctADS.toFixed(1)}%</strong> · Dias decorridos: <strong>${dd}</strong> de <strong>${dm}</strong></div>`:''}
      </div>` : `
      <div style="margin-bottom:24px;padding:16px;background:var(--bg-subtle);border-radius:8px;text-align:center;color:#888;font-size:13px;">
        Nenhuma projeção cadastrada para este cliente. <a href="#projecao" style="color:var(--accent);">Cadastrar projeção</a>
      </div>`}

      <!-- Plataformas -->
      ${plats.length ? `
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#1a2744;">Desempenho por Plataforma</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:var(--bg-subtle);color:var(--text-secondary);">
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
              return `<tr style="background:${i%2===0?'var(--bg-subtle)':'white'};">
                <td style="padding:9px 12px;font-weight:600;">${p.nome||'—'}</td>
                <td style="padding:9px 12px;text-align:right;">${fat>0?fmtFull(fat):'—'}</td>
                <td style="padding:9px 12px;text-align:right;font-weight:700;color:var(--accent);">${proj>0?fmtFull(proj):'—'}</td>
                <td style="padding:9px 12px;text-align:right;">${p.vendasBase>0?Math.round(parseFloat(p.vendasBase)).toLocaleString('pt-BR'):'—'}</td>
                <td style="padding:9px 12px;text-align:right;">${ads>0?fmtFull(ads):'—'}</td>
                <td style="padding:9px 12px;text-align:right;color:var(--yellow);">${pADS>0?pADS.toFixed(1)+'%':'—'}</td>
              </tr>`;
            }).join('')}
            <tr style="background:var(--bg-subtle);font-weight:700;">
              <td style="padding:9px 12px;">Total</td>
              <td style="padding:9px 12px;text-align:right;">${fmtFull(plats.reduce((s,p)=>s+(parseFloat(p.fatBase)||0),0))}</td>
              <td style="padding:9px 12px;text-align:right;color:var(--accent);">${fmtFull(fatProj)}</td>
              <td style="padding:9px 12px;text-align:right;">${Math.round(plats.reduce((s,p)=>s+(parseFloat(p.vendasBase)||0),0)).toLocaleString('pt-BR')}</td>
              <td style="padding:9px 12px;text-align:right;">${fmtFull(plats.reduce((s,p)=>s+(parseFloat(p.adsBase)||0),0))}</td>
              <td style="padding:9px 12px;text-align:right;color:var(--yellow);">${pctADS>0?pctADS.toFixed(1)+'%':'—'}</td>
            </tr>
          </tbody>
        </table>
      </div>` : ''}

      <!-- Comparativo de Faturamento -->
      ${(fatAtual > 0 || fatProj > 0 || histAnteriores.length > 0) ? `
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:14px;color:#1a2744;">Comparativo de Faturamento — ${mesAnoAtual}</div>

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
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#1a2744;">DRE — ${meses[dreRecente.mes]} ${dreRecente.ano} · ${dreRecente.plataforma}</div>
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
            return `<tr style="background:${i%2===0?'var(--bg-subtle)':'white'};">
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
            return `<tr style="background:var(--bg-subtle);font-weight:700;font-size:14px;">
              <td style="padding:10px 12px;">Resultado</td>
              <td style="padding:10px 12px;text-align:right;color:${res>=0?'var(--green)':'var(--red)'};">${fmtFull(res)}</td>
              <td style="padding:10px 12px;text-align:right;color:${res>=0?'var(--green)':'var(--red)'};">${pct.toFixed(2)}%</td>
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
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#1a2744;">Ações Executadas</div>
        ${acoes.length ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          ${acoes.slice(0,10).map((a,i)=>`
          <tr style="background:${i%2===0?'var(--bg-subtle)':'white'};">
            <td style="padding:8px 12px;color:#888;white-space:nowrap;">${a.data?new Date(a.data+'T00:00:00').toLocaleDateString('pt-BR'):''}</td>
            <td style="padding:8px 12px;"><span style="background:#6366f111;color:var(--accent);padding:2px 8px;border-radius:20px;font-size:11px;">${a.categoria||a.tipo||''}</span></td>
            <td style="padding:8px 12px;">${a.descricao||''}</td>
            <td style="padding:8px 12px;color:#888;">${a.responsavel||''}</td>
          </tr>`).join('')}
        </table>` : '<div style="color:#888;font-size:13px;padding:8px 0;">Nenhuma ação registrada para este cliente.</div>'}
      </div>

      <!-- Oportunidades -->
      ${opps.length ? `
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:var(--green);">Oportunidades</div>
        ${opps.map(o=>`
          <div style="padding:10px 14px;background:#10b98108;border:1px solid #10b98133;border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-weight:600;font-size:13.5px;">${o.titulo}</div>
              <div style="font-size:12px;color:#666;margin-top:2px;">${o.descricao||''}</div>
            </div>
            ${o.impacto?`<div style="font-weight:700;color:var(--green);white-space:nowrap;margin-left:16px;">${fmtFull(o.impacto)}/mês</div>`:''}
          </div>`).join('')}
      </div>` : ''}

      <!-- Próximos Passos -->
      <div style="margin-bottom:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:var(--yellow);">Próximos Passos</div>
        ${tarefasPend.length ? `
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${tarefasPend.map((t,i)=>`
            <div style="display:flex;gap:10px;align-items:center;padding:8px 12px;background:var(--bg-subtle);border-radius:6px;">
              <div style="width:22px;height:22px;border-radius:50%;background:var(--bg-subtle);color:var(--text-secondary);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${i+1}</div>
              <div style="flex:1;font-size:13px;">${t.titulo}</div>
              <div style="font-size:12px;color:#888;">${t.prazo?new Date(t.prazo+'T00:00:00').toLocaleDateString('pt-BR'):''}</div>
              <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:${{urgente:'#ef444422',alta:'#f9731622',media:'#f59e0b22',baixa:'#10b98122'}[t.prioridade]||'#88888822'};color:${{urgente:'var(--red)',alta:'#f97316',media:'var(--yellow)',baixa:'var(--green)'}[t.prioridade]||'#888'};">${t.prioridade||''}</span>
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
      const hojeSt2 = new Date().toISOString().slice(0,10);
      const atrasadas = ta.filter(t=>t.status!=='concluida' && (t.status==='atrasada' || (t.prazo && t.prazo<hojeSt2)));
      const pendentes = ta.filter(t=>['pendente','em_andamento','parado'].includes(t.status||'pendente'));
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
        const clientesG = cl.filter(c=>c.gestorId===g.id||c.gestor===g.nome);
        const tarefasG  = ta.filter(t=>t.responsavel===g.nome&&t.status!=='concluida');
        const atrasG    = ta.filter(t=>t.responsavel===g.nome&&t.status!=='concluida'&&t.prazo&&t.prazo<new Date().toISOString().slice(0,10));
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
          <div style="width:36px;height:36px;border-radius:var(--radius-sm);background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-size:16px;">🤖</div>
          <div>
            <div style="font-size:14px;font-weight:700;">GLR IA Copiloto</div>
            <div style="font-size:11px;color:var(--green);">● Online</div>
          </div>
        </div>
        <div style="font-size:12.5px;color:var(--text-secondary);">Analiso os dados reais da sua carteira — clientes, tarefas, gestores e faturamentos cadastrados no sistema.</div>
      </div>

      <div class="card" style="flex:1;overflow-y:auto;">
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:none;letter-spacing:0;margin-bottom:10px;">Perguntas Sugeridas</div>
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
          <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">🤖</div>
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
      <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">🤖</div>
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
        <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">🤖</div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;max-width:85%;font-size:13.5px;line-height:1.7;color:var(--text-secondary);">${formatted}</div>
      </div>`;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }, 600 + Math.random() * 500);
  };
});
