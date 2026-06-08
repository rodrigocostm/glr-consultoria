// ============================================================
// GLR Consultoria — Gestores + Performance (página unificada)
// ============================================================

// Carrega gestores do localStorage ao iniciar
(function() {
  try { const s = localStorage.getItem('glr_gestores'); if (s) GLR.gestores = JSON.parse(s); } catch(e) {}
  try { const s = localStorage.getItem('glr_clientes'); if (s) GLR.clientes = JSON.parse(s); } catch(e) {}
})();

Router.register('gestores', (params, el) => {
  const storageKey = 'glr_gestores';
  const cores = ['#6366f1','#8b5cf6','#06b6d4','#10b981','#f59e0b','#f97316','#ef4444','#ec4899','#84cc16','#14b8a6'];
  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                 'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const hoje  = new Date();

  function salvarGestores() {
    localStorage.setItem(storageKey, JSON.stringify(GLR.gestores));
    if (typeof atualizarBadges === 'function') atualizarBadges();
  }
  function iniciais(nome) {
    return nome.trim().split(/\s+/).slice(0,2).map(p=>p[0]?.toUpperCase()||'').join('') || '?';
  }
  function fmtR(v) {
    return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0}).format(v||0);
  }
  function fmtPct(v) { return (v>=0?'+':'')+(v||0).toFixed(1)+'%'; }

  // Clientes de um gestor — aceita tanto gestorId quanto nome
  function clientesDoGestor(g) {
    return GLR.clientes.filter(c =>
      c.gestorId === g.id || c.gestor === g.nome
    );
  }

  // Dados de performance de um cliente
  function perfCliente(c) {
    let projecoes = [], dres = [];
    try { projecoes = JSON.parse(localStorage.getItem('glr_projecoes')||'[]'); } catch(e) {}
    try { dres      = JSON.parse(localStorage.getItem('glr_dre')||'[]');       } catch(e) {}

    const proj  = projecoes.find(p => parseInt(p.chave) === c.id);
    const plats = proj?.plataformas || [];
    const dd    = Math.max(parseInt(proj?.diasDecorridos)||1, 1);
    const dm    = Math.max(parseInt(proj?.diasNoMes)||30, 1);
    const calcP = base => base ? (parseFloat(base)/dd)*dm : 0;

    const fatBase  = plats.reduce((s,p)=>s+(parseFloat(p.fatBase)||0),0);
    const adsBase  = plats.reduce((s,p)=>s+(parseFloat(p.adsBase)||0),0);
    const fatProj  = plats.reduce((s,p)=>s+calcP(p.fatBase),0);
    const adsProj  = plats.reduce((s,p)=>s+calcP(p.adsBase),0);
    const pctADS   = fatBase > 0 ? (adsBase/fatBase)*100 : 0;
    const pctADSProj = fatProj > 0 ? (adsProj/fatProj)*100 : 0;

    const dresMes = dres.filter(d =>
      parseInt(d.clienteId)===c.id &&
      d.mes===hoje.getMonth() && d.ano===hoje.getFullYear()
    );
    const fatReal = dresMes.reduce((s,d)=>s+(parseFloat(d.valores?.faturamento)||0),0);
    const adsReal = dresMes.reduce((s,d)=>s+(parseFloat(d.valores?.ads)||0),0);

    // Meses anteriores — busca no DRE primeiro, depois no historico
    function fatOffset(off) {
      const d    = new Date(hoje.getFullYear(), hoje.getMonth()-off, 1);
      const nome = meses[d.getMonth()]+' '+d.getFullYear();
      // 1) Tenta DRE do mês
      const dreOff = dres.filter(x =>
        parseInt(x.clienteId)===c.id && x.mes===d.getMonth() && x.ano===d.getFullYear()
      );
      if (dreOff.length) return dreOff.reduce((s,x)=>s+(parseFloat(x.valores?.faturamento)||0),0);
      // 2) Tenta historico
      const h = (c.historico||[]).find(x=>x.mes===nome);
      if (h) return parseFloat(h.faturamento)||0;
      return 0;
    }
    const fatM1 = fatOffset(1), fatM2 = fatOffset(2), fatM3 = fatOffset(3);

    // Meta manual (glr_metas) sobrescreve fatBase se definida
    let metas = {};
    try { metas = JSON.parse(localStorage.getItem('glr_metas')||'{}'); } catch(e) {}
    const metaManual = metas[c.id] ? parseFloat(metas[c.id]) : null;
    const metaFinal  = metaManual !== null ? metaManual : fatBase;

    const fatRef    = fatReal || fatProj;
    const pctMeta   = metaFinal>0 ? (fatRef/metaFinal)*100 : null;
    const faltaMeta = metaFinal>0 ? metaFinal-fatRef : null;
    const compM1    = fatM1>0 ? ((fatRef-fatM1)/fatM1)*100 : null;
    const vendasProj = plats.reduce((s,p)=>s+calcP(p.vendasBase),0);
    const recGLR    = Math.round(vendasProj)*(parseFloat(c.valorPorVenda)||0);

    return { fatBase, metaFinal, adsBase, pctADS, fatProj, adsProj, pctADSProj,
             fatReal, adsReal, fatM1, fatM2, fatM3,
             pctMeta, faltaMeta, compM1, recGLR };
  }

  function corMeta(pct) {
    if (pct===null) return {bg:'transparent',text:'var(--text-muted)'};
    if (pct>=100)   return {bg:'#10b98120',text:'#10b981'};
    if (pct>=85)    return {bg:'#f59e0b20',text:'#f59e0b'};
    return               {bg:'#ef444420',text:'#ef4444'};
  }
  function corComp(v) {
    if (v===null) return 'var(--text-muted)';
    return v>=0 ? '#10b981' : '#ef4444';
  }

  function mesAbrev(off) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth()-off, 1);
    return meses[d.getMonth()].substring(0,3).toUpperCase();
  }

  function renderTabelaGestor(g, gid) {
    const clientes = clientesDoGestor(g);
    if (!clientes.length) return `
      <div style="padding:24px 20px;color:var(--text-muted);font-size:13px;text-align:center;">
        Nenhum cliente atribuído. Vá em <strong>Carteira de Clientes</strong> e selecione este gestor nos cadastros.
      </div>`;

    const rows = clientes.map(c=>({c, d:perfCliente(c)}));
    const tot = {
      metaFinal: rows.reduce((s,r)=>s+r.d.metaFinal,0),
      fatProj:   rows.reduce((s,r)=>s+r.d.fatProj,0),
      fatReal:   rows.reduce((s,r)=>s+r.d.fatReal,0),
      adsProj:   rows.reduce((s,r)=>s+r.d.adsProj,0),
      fatM1:     rows.reduce((s,r)=>s+r.d.fatM1,0),
      fatM2:     rows.reduce((s,r)=>s+r.d.fatM2,0),
      fatM3:     rows.reduce((s,r)=>s+r.d.fatM3,0),
      recGLR:    rows.reduce((s,r)=>s+r.d.recGLR,0),
    };
    const totRef = tot.fatReal||tot.fatProj;
    const totPct = tot.metaFinal>0 ? (totRef/tot.metaFinal)*100 : null;
    const totM1  = tot.fatM1>0 ? ((totRef-tot.fatM1)/tot.fatM1)*100 : null;
    const corTot = corMeta(totPct);

    return `
    <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:980px;">
      <thead>
        <tr style="background:var(--bg-base);border-bottom:2px solid var(--border);">
          ${['Empresa','Meta Base','ADS%','Projeção','Fat. Real','vs Mês Ant.','Falta p/ Meta','% Meta','ADS Proj.','%ADS','Rec. GLR',mesAbrev(3),mesAbrev(2),mesAbrev(1)]
            .map((h,i)=>`<th style="padding:8px ${i===0?'14px':'8px'};text-align:${i===0?'left':'right'};color:var(--text-muted);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;white-space:nowrap;">${h}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${rows.map(({c,d},i)=>{
          const cor = corMeta(d.pctMeta);
          return `
          <tr style="background:${i%2===0?'var(--bg-surface)':'var(--bg-card)'};">
            <td style="padding:10px 14px;font-weight:600;border-left:3px solid ${cor.text};cursor:pointer;"
                onclick="Router.navigate('cliente-perfil',{id:${c.id}})">
              ${c.nome}
              <div style="font-size:10px;color:var(--text-muted);font-weight:400;">${GLR.statusLabel?.[c.status]||c.status||''}</div>
            </td>
            <td style="padding:6px 8px;text-align:right;">
              <div style="display:flex;align-items:center;gap:4px;justify-content:flex-end;">
                <input type="number" id="inp-meta-${c.id}"
                  value="${d.metaFinal>0?Math.round(d.metaFinal):''}"
                  placeholder="${d.fatBase>0?Math.round(d.fatBase):'Meta'}"
                  data-fat-ref="${Math.round(d.fatReal||d.fatProj||0)}"
                  data-gestor-id="${gid}"
                  onclick="event.stopPropagation()"
                  oninput="previewMeta(${c.id},this.value,this.dataset.fatRef)"
                  onchange="salvarMeta(${c.id},this.value,this.dataset.fatRef,this.dataset.gestorId)"
                  style="width:100px;background:var(--bg-base);border:1px solid var(--border);border-radius:6px;
                         padding:5px 8px;color:var(--text-primary);font-size:12px;text-align:right;outline:none;"
                  onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'">
                <button title="Salvar meta" onclick="event.stopPropagation();(function(){var inp=document.getElementById('inp-meta-${c.id}');salvarMeta(${c.id},inp.value,inp.dataset.fatRef,inp.dataset.gestorId);})()"
                  style="background:var(--accent);border:none;border-radius:5px;padding:5px 7px;cursor:pointer;color:white;font-size:11px;flex-shrink:0;">✓</button>
              </div>
            </td>
            <td style="padding:10px 8px;text-align:right;color:${d.pctADS>20?'#ef4444':d.pctADS>15?'#f59e0b':'var(--text-secondary)'};">${d.pctADS>0?d.pctADS.toFixed(1)+'%':'—'}</td>
            <td style="padding:10px 8px;text-align:right;font-weight:600;color:var(--accent-light);">${d.fatProj>0?fmtR(d.fatProj):'—'}</td>
            <td style="padding:10px 8px;text-align:right;font-weight:${d.fatReal>0?700:400};color:${d.fatReal>0?'var(--text-primary)':'var(--text-muted)'};">${d.fatReal>0?fmtR(d.fatReal):'<span style="font-size:10px;">sem DRE</span>'}</td>
            <td style="padding:10px 8px;text-align:right;font-weight:600;color:${corComp(d.compM1)};">${d.compM1!==null?fmtPct(d.compM1):'—'}</td>
            <td id="cell-falta-${c.id}" style="padding:10px 8px;text-align:right;color:${d.faltaMeta!==null?(d.faltaMeta<=0?'#10b981':'#f97316'):'var(--text-muted)'};">${d.faltaMeta!==null?(d.faltaMeta<=0?'✅ Batida':fmtR(d.faltaMeta)):'—'}</td>
            <td id="cell-pct-${c.id}" style="padding:10px 8px;text-align:center;">${d.pctMeta!==null?`<span style="background:${cor.bg};color:${cor.text};font-weight:800;padding:2px 9px;border-radius:99px;font-size:11px;">${d.pctMeta.toFixed(1)}%</span>`:'<span style="color:var(--text-muted)">—</span>'}</td>
            <td style="padding:10px 8px;text-align:right;color:var(--text-secondary);">${d.adsProj>0?fmtR(d.adsProj):'—'}</td>
            <td style="padding:10px 8px;text-align:right;color:${d.pctADSProj>20?'#ef4444':d.pctADSProj>15?'#f59e0b':'var(--text-secondary)'};">${d.pctADSProj>0?d.pctADSProj.toFixed(1)+'%':'—'}</td>
            <td style="padding:10px 8px;text-align:right;color:#10b981;font-weight:600;">${d.recGLR>0?fmtR(d.recGLR):'—'}</td>
            <td style="padding:10px 8px;text-align:right;color:var(--text-muted);font-size:11px;">${d.fatM3>0?fmtR(d.fatM3):'—'}</td>
            <td style="padding:10px 8px;text-align:right;color:var(--text-muted);font-size:11px;">${d.fatM2>0?fmtR(d.fatM2):'—'}</td>
            <td style="padding:10px 8px;text-align:right;color:var(--text-muted);font-size:11px;">${d.fatM1>0?fmtR(d.fatM1):'—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="background:#1a274415;font-weight:700;border-top:2px solid var(--border);">
          <td style="padding:10px 14px;">Total · ${clientes.length} cliente${clientes.length!==1?'s':''}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.metaFinal>0?fmtR(tot.metaFinal):'—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatProj>0&&tot.adsProj>0?((tot.adsProj/tot.fatProj)*100).toFixed(1)+'%':'—'}</td>
          <td style="padding:10px 8px;text-align:right;color:var(--accent-light);">${tot.fatProj>0?fmtR(tot.fatProj):'—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.fatReal>0?fmtR(tot.fatReal):'—'}</td>
          <td style="padding:10px 8px;text-align:right;color:${corComp(totM1)};">${totM1!==null?fmtPct(totM1):'—'}</td>
          <td></td>
          <td style="padding:10px 8px;text-align:center;">${totPct!==null?`<span style="background:${corTot.bg};color:${corTot.text};font-weight:800;padding:2px 9px;border-radius:99px;font-size:11px;">${totPct.toFixed(1)}%</span>`:'—'}</td>
          <td style="padding:10px 8px;text-align:right;">${tot.adsProj>0?fmtR(tot.adsProj):'—'}</td>
          <td></td>
          <td style="padding:10px 8px;text-align:right;color:#10b981;">${tot.recGLR>0?fmtR(tot.recGLR):'—'}</td>
          <td style="padding:10px 8px;text-align:right;font-size:11px;">${tot.fatM3>0?fmtR(tot.fatM3):'—'}</td>
          <td style="padding:10px 8px;text-align:right;font-size:11px;">${tot.fatM2>0?fmtR(tot.fatM2):'—'}</td>
          <td style="padding:10px 8px;text-align:right;font-size:11px;">${tot.fatM1>0?fmtR(tot.fatM1):'—'}</td>
        </tr>
      </tfoot>
    </table>
    </div>
    <div style="padding:8px 16px 10px;border-top:1px solid var(--border);display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--text-muted);">
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;background:#10b981;border-radius:2px;"></span>Batendo meta ≥100%</span>
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;background:#f59e0b;border-radius:2px;"></span>Quase lá 85–99%</span>
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;background:#ef4444;border-radius:2px;"></span>Abaixo &lt;85%</span>
      <span style="margin-left:auto;">Clique no cliente para abrir o perfil →</span>
    </div>`;
  }

  // ── Render principal ───────────────────────────────────────────
  el.innerHTML = `<div class="page">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="section-title" style="font-size:20px;">👥 Gestores — Performance ${meses[hoje.getMonth()]} ${hoje.getFullYear()}</div>
        <div class="section-subtitle">${GLR.gestores.length} gestor${GLR.gestores.length!==1?'es':''} cadastrado${GLR.gestores.length!==1?'s':''} · Dados em tempo real</div>
      </div>
      <div style="display:flex;gap:10px;">
        <button class="btn" style="background:var(--bg-card);border:1px solid var(--border);" onclick="window.print()">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          Imprimir
        </button>
        <button class="btn btn-primary" onclick="abrirModalGestor()">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          Novo Gestor
        </button>
      </div>
    </div>

    ${!GLR.gestores.length ? `
    <div style="text-align:center;padding:80px 24px;color:var(--text-muted);">
      <div style="font-size:40px;margin-bottom:12px;">👤</div>
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">Nenhum gestor cadastrado</div>
      <div style="font-size:13px;margin-bottom:20px;">Cadastre gestores para visualizar a performance da equipe.</div>
      <button class="btn btn-primary" onclick="abrirModalGestor()">+ Cadastrar primeiro gestor</button>
    </div>` : `

    <!-- Um bloco por gestor -->
    ${GLR.gestores.map(g => {
      const cli     = clientesDoGestor(g);
      const rows    = cli.map(c=>({c,d:perfCliente(c)}));
      const totRef  = rows.reduce((s,r)=>s+(r.d.fatReal||r.d.fatProj),0);
      const totMeta = rows.reduce((s,r)=>s+r.d.metaFinal,0); // usa metaFinal (manual ou fatBase)
      const totRecGLR = rows.reduce((s,r)=>s+r.d.recGLR,0);
      const totPct  = totMeta>0?(totRef/totMeta)*100:null;
      const corTot  = corMeta(totPct);
      const gid     = g.id || GLR.gestores.indexOf(g); // id estável para IDs de DOM
      return `
      <div class="card" style="padding:0;overflow:hidden;margin-bottom:24px;" data-gestor-id="${gid}">

        <!-- Header do gestor -->
        <div style="padding:16px 20px;background:linear-gradient(135deg,#1a2744,#23305a);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div style="display:flex;align-items:center;gap:14px;">
            <div style="width:48px;height:48px;border-radius:50%;background:${g.cor||'#6366f1'}30;border:2px solid ${g.cor||'#6366f1'}60;display:flex;align-items:center;justify-content:center;font-weight:800;color:${g.cor||'#6366f1'};font-size:16px;">${iniciais(g.nome)}</div>
            <div>
              <div style="font-size:17px;font-weight:800;color:white;">${g.nome}</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.5);">${g.cargo||'Gestor de Contas'} · ${cli.length} cliente${cli.length!==1?'s':''}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
            <div style="text-align:center;">
              <div style="font-size:10px;color:rgba(255,255,255,0.5);margin-bottom:2px;">META</div>
              <div id="hdr-meta-${gid}" style="font-size:14px;font-weight:700;color:white;">${totMeta>0?fmtR(totMeta):'—'}</div>
            </div>
            ${totRef>0?`<div style="text-align:center;"><div style="font-size:10px;color:rgba(255,255,255,0.5);margin-bottom:2px;">PROJEÇÃO/REAL</div><div style="font-size:14px;font-weight:700;color:#818cf8;">${fmtR(totRef)}</div></div>`:''}
            <div style="text-align:center;">
              <div style="font-size:10px;color:rgba(255,255,255,0.5);margin-bottom:2px;">% META</div>
              <div id="hdr-pct-${gid}" style="font-size:18px;font-weight:800;color:${totPct!==null?corTot.text:'rgba(255,255,255,0.4)'};">${totPct!==null?totPct.toFixed(0)+'%':'—'}</div>
            </div>
            ${totRecGLR>0?`<div style="text-align:center;"><div style="font-size:10px;color:rgba(255,255,255,0.5);margin-bottom:2px;">RECEITA GLR</div><div style="font-size:14px;font-weight:700;color:#34d399;">${fmtR(totRecGLR)}</div></div>`:''}
            <div style="display:flex;gap:6px;margin-left:8px;">
              <button class="btn btn-ghost btn-sm" style="color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.2);" onclick="editarGestor(${GLR.gestores.indexOf(g)})">✏️ Editar</button>
              <button class="btn btn-ghost btn-sm" style="color:#f87171;border:1px solid rgba(248,113,113,0.3);" onclick="removerGestor(${GLR.gestores.indexOf(g)})">🗑️</button>
            </div>
          </div>
        </div>

        <!-- Tabela de performance -->
        ${renderTabelaGestor(g, gid)}
      </div>`;
    }).join('')}
    `}

    <style>
      @media print {
        #sidebar,#header{display:none!important;}
        #main{margin-left:0!important;}
        #page-content{padding:0!important;}
        .page>div:first-child{display:none!important;}
      }
    </style>
  </div>`;

  // ── Salvar meta manual por cliente ──────────────────────────
  // Atualiza as células visuais sem re-renderizar a página
  function atualizarCelulasMeta(clienteId, meta, fatRef) {
    const falta    = meta > 0 ? meta - fatRef : null;
    const pct      = meta > 0 && fatRef >= 0 ? (fatRef / meta) * 100 : null;
    const faltaEl  = document.getElementById(`cell-falta-${clienteId}`);
    const pctEl    = document.getElementById(`cell-pct-${clienteId}`);
    if (faltaEl) {
      if (falta === null) {
        faltaEl.style.color = 'var(--text-muted)';
        faltaEl.textContent = '—';
      } else if (falta <= 0) {
        faltaEl.style.color = '#10b981';
        faltaEl.textContent = '✅ Batida';
      } else {
        faltaEl.style.color = '#f97316';
        faltaEl.textContent = fmtR(falta);
      }
    }
    if (pctEl) {
      if (pct === null) {
        pctEl.innerHTML = '<span style="color:var(--text-muted)">—</span>';
      } else {
        const cor = corMeta(pct);
        pctEl.innerHTML = `<span style="background:${cor.bg};color:${cor.text};font-weight:800;padding:2px 9px;border-radius:99px;font-size:11px;">${pct.toFixed(1)}%</span>`;
      }
    }
  }

  // Preview ao digitar (antes de salvar)
  window.previewMeta = (clienteId, valor, fatRefStr) => {
    const meta   = parseFloat(valor) || 0;
    const fatRef = parseFloat(fatRefStr) || 0;
    atualizarCelulasMeta(clienteId, meta, fatRef);
  };

  window.salvarMeta = (clienteId, valor, fatRefStr, gestorId) => {
    let metas = {};
    try { metas = JSON.parse(localStorage.getItem('glr_metas')||'{}'); } catch(e) {}
    const v      = parseFloat(valor);
    const fatRef = parseFloat(fatRefStr) || 0;
    if (v > 0) metas[clienteId] = v;
    else delete metas[clienteId];
    localStorage.setItem('glr_metas', JSON.stringify(metas));

    // Atualiza células visuais da linha
    atualizarCelulasMeta(clienteId, v > 0 ? v : 0, fatRef);

    // Recalcula e atualiza cabeçalho do gestor
    if (gestorId !== undefined && gestorId !== null) {
      // Soma todos os inputs de meta do bloco deste gestor
      const blocoEl = document.querySelector(`[data-gestor-id="${gestorId}"]`);
      if (blocoEl) {
        let totalMeta = 0;
        let totalRef  = 0;
        blocoEl.querySelectorAll('input[data-gestor-id]').forEach(inp => {
          const metaVal = parseFloat(inp.value) || 0;
          const refVal  = parseFloat(inp.dataset.fatRef) || 0;
          totalMeta += metaVal;
          totalRef  += refVal;
        });
        const pct = totalMeta > 0 ? (totalRef / totalMeta) * 100 : null;
        const hdrMeta = document.getElementById(`hdr-meta-${gestorId}`);
        const hdrPct  = document.getElementById(`hdr-pct-${gestorId}`);
        if (hdrMeta) hdrMeta.textContent = totalMeta > 0 ? fmtR(totalMeta) : '—';
        if (hdrPct) {
          const cor = corMeta(pct);
          hdrPct.textContent = pct !== null ? pct.toFixed(0) + '%' : '—';
          hdrPct.style.color = pct !== null ? cor.text : 'rgba(255,255,255,0.4)';
        }
      }
    }

    // Feedback visual no botão ✓
    const inp = document.getElementById(`inp-meta-${clienteId}`);
    if (inp) {
      const btn = inp.nextElementSibling;
      if (btn) {
        btn.textContent = '✓ Salvo';
        btn.style.background = '#10b981';
        setTimeout(() => { btn.textContent = '✓'; btn.style.background = 'var(--accent)'; }, 1500);
      }
    }
  };

  // ── Modal novo/editar gestor ─────────────────────────────────
  window.abrirModalGestor = (idx=null) => {
    const g = idx!==null ? GLR.gestores[idx] : null;
    const corAtual = g?.cor || cores[GLR.gestores.length % cores.length];
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal">
      <div class="modal-header">
        <div class="modal-title">${g?'Editar Gestor':'Novo Gestor'}</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div style="display:flex;justify-content:center;margin-bottom:20px;">
        <div id="avatar-preview" style="width:64px;height:64px;border-radius:50%;background:${corAtual}20;border:3px solid ${corAtual}60;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:${corAtual};">
          ${g?iniciais(g.nome):'?'}
        </div>
      </div>
      <div class="form-group"><label class="form-label">Nome Completo *</label>
        <input class="form-input" id="g-nome" placeholder="Ex: Ana Souza" value="${g?.nome||''}" oninput="atualizarAvatar(this.value)">
      </div>
      <div class="form-group"><label class="form-label">Cargo</label>
        <input class="form-input" id="g-cargo" placeholder="Ex: Gestora de Contas Sênior" value="${g?.cargo||''}">
      </div>
      <div class="grid-2" style="gap:12px;">
        <div class="form-group"><label class="form-label">E-mail</label>
          <input class="form-input" id="g-email" type="email" placeholder="nome@glr.com.br" value="${g?.email||''}">
        </div>
        <div class="form-group"><label class="form-label">Telefone</label>
          <input class="form-input" id="g-telefone" placeholder="(11) 99999-9999" value="${g?.telefone||''}">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Cor de identificação</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${cores.map(c=>`<div onclick="selecionarCor('${c}')" data-cor="${c}"
            style="width:28px;height:28px;border-radius:50%;background:${c};cursor:pointer;transition:all .15s;
            border:3px solid ${c===corAtual?'white':'transparent'};box-shadow:${c===corAtual?`0 0 0 2px ${c}`:'none'};"></div>`).join('')}
        </div>
        <input type="hidden" id="g-cor" value="${corAtual}">
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px;">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="salvarGestor(${idx})">${g?'Salvar alterações':'Cadastrar Gestor'}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.remove(); });
  };

  window.atualizarAvatar = nome => {
    const el = document.getElementById('avatar-preview');
    if (!el) return;
    el.textContent = nome.trim().split(/\s+/).slice(0,2).map(p=>p[0]?.toUpperCase()||'').join('')||'?';
  };

  window.selecionarCor = cor => {
    document.getElementById('g-cor').value = cor;
    document.querySelectorAll('[data-cor]').forEach(el => {
      const c = el.dataset.cor;
      el.style.border     = `3px solid ${c===cor?'white':'transparent'}`;
      el.style.boxShadow  = c===cor?`0 0 0 2px ${c}`:'none';
    });
    const p = document.getElementById('avatar-preview');
    if (p) { p.style.background=cor+'20'; p.style.borderColor=cor+'60'; p.style.color=cor; }
  };

  window.salvarGestor = idx => {
    const nome = document.getElementById('g-nome').value.trim();
    if (!nome) { alert('Informe o nome do gestor.'); return; }
    const gestor = {
      id:       idx!==null ? GLR.gestores[idx].id : GLR.nextId(GLR.gestores),
      nome,
      cargo:    document.getElementById('g-cargo').value.trim(),
      email:    document.getElementById('g-email').value.trim(),
      telefone: document.getElementById('g-telefone').value.trim(),
      cor:      document.getElementById('g-cor').value,
      avatar:   iniciais(nome),
    };
    if (idx!==null) GLR.gestores[idx] = gestor;
    else GLR.gestores.push(gestor);
    salvarGestores();
    document.querySelector('.modal-overlay')?.remove();
    Router.navigate('gestores');
  };

  window.editarGestor  = idx => abrirModalGestor(idx);
  window.removerGestor = idx => {
    const g   = GLR.gestores[idx];
    const cli = clientesDoGestor(g).length;
    const msg = cli>0 ? `"${g.nome}" possui ${cli} cliente(s). Remover mesmo assim?` : `Remover "${g.nome}"?`;
    if (!confirm(msg)) return;
    GLR.gestores.splice(idx,1);
    salvarGestores();
    Router.navigate('gestores');
  };
});
