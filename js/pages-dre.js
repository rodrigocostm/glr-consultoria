// ============================================================
// GLR Consultoria — DRE (Demonstração do Resultado do Exercício)
// ============================================================

Router.register('dre', (params, el) => {
  let clientes  = [];
  let projecoes = [];
  try { clientes  = JSON.parse(localStorage.getItem('glr_clientes')  || '[]'); } catch(e) {}
  try { projecoes = JSON.parse(localStorage.getItem('glr_projecoes') || '[]'); } catch(e) {}

  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                 'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const hoje    = new Date();
  const mesAtual = hoje.getMonth();
  const anoAtual = hoje.getFullYear();

  // Retorna plataformas da projeção de um cliente
  function getPlataformasDoCliente(clienteId) {
    if (!clienteId) return [];
    const proj = projecoes.find(p => parseInt(p.chave) === parseInt(clienteId));
    if (!proj?.plataformas?.length) return [];
    return proj.plataformas.map(p => p.nome).filter(Boolean);
  }

  function getValoresDaProjecao(clienteId, nomePlataforma) {
    const proj = projecoes.find(p => parseInt(p.chave) === parseInt(clienteId));
    if (!proj?.plataformas?.length) return null;
    const linha = proj.plataformas.find(p => p.nome === nomePlataforma);
    if (!linha) return null;
    const cliente       = clientes.find(c => c.id === parseInt(clienteId));
    const valorPorVenda = parseFloat(cliente?.valorPorVenda) || 0;
    const vendasBase    = parseFloat(linha.vendasBase) || 0;
    const fatBase       = parseFloat(linha.fatBase)    || 0;
    const adsBase       = parseFloat(linha.adsBase)    || 0;
    const comissaoGLR   = vendasBase * valorPorVenda;
    if (!fatBase && !adsBase && !vendasBase) return null;
    return { faturamento: fatBase, ads: adsBase, comissaoGLR, produtosVendidos: vendasBase };
  }

  function getDREs() {
    try { return JSON.parse(localStorage.getItem('glr_dre') || '[]'); } catch(e) { return []; }
  }
  function saveDREs(arr) { localStorage.setItem('glr_dre', JSON.stringify(arr)); }
  function dreKey(cid, plat, mes, ano) { return `${cid}_${plat}_${mes}_${ano}`; }
  function findDRE(cid, plat, mes, ano) {
    return getDREs().find(d => d.chave === dreKey(cid, plat, mes, ano)) || null;
  }
  function diasNoMes(mes, ano) { return new Date(ano, mes + 1, 0).getDate(); }

  const clienteInicial  = clientes[0] || null;
  const platsIniciais   = clienteInicial ? getPlataformasDoCliente(clienteInicial.id) : [];
  let estado = {
    clienteId:  clienteInicial?.id || null,
    plataforma: platsIniciais[0] || null,
    mes: mesAtual,
    ano: anoAtual,
  };

  // Linhas customizadas (estado em memória)
  let linhasCustom   = [];
  let nextLinhaId    = 1;
  let ocultarGLR     = false;

  const camposDRE = [
    { key: 'faturamento',   label: 'Faturamento',     tipo: 'receita' },
    { key: 'comissaoFrete', label: 'Comissão e Frete', tipo: 'custo'   },
    { key: 'produtos',      label: 'Produtos',          tipo: 'custo'   },
    { key: 'ads',           label: 'ADS',               tipo: 'custo'   },
    { key: 'imposto',       label: 'Imposto',           tipo: 'custo'   },
    { key: 'juros',         label: 'Juros',             tipo: 'custo'   },
    { key: 'custoFixo',     label: 'Custo Fixo',        tipo: 'custo'   },
    { key: 'comissaoGLR',   label: 'Comissão GLR',      tipo: 'custo'   },
  ];

  function parseVal(str) {
    if (!str && str !== 0) return 0;
    return parseFloat(String(str).replace(/\./g,'').replace(',','.')) || 0;
  }
  function fmt(v) {
    return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0);
  }
  function fmtN2(v) {
    return new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2}).format(v||0);
  }
  function fmtPct(v) { return (v||0).toFixed(2).replace('.',',') + '%'; }

  function calcular(vals, linhas, hideGLR) {
    const fat    = parseFloat(vals.faturamento) || 0;
    let custos   = camposDRE.filter(c=>c.tipo==='custo'&&!(hideGLR&&c.key==='comissaoGLR')).reduce((s,c)=>s+(parseFloat(vals[c.key])||0),0);
    let recExtra = 0;
    (linhas||[]).forEach(l => {
      const v = parseFloat(l.valor) || 0;
      if (l.tipo === 'receita') recExtra += v;
      else custos += v;
    });
    const resultado = fat + recExtra - custos;
    const pct       = (fat + recExtra) > 0 ? (resultado/(fat + recExtra))*100 : 0;
    const pv   = parseFloat(vals.produtosVendidos) || 0;
    const dias = diasNoMes(estado.mes, estado.ano);
    return {
      fat, custos, resultado, pct,
      pv, dias,
      mediaVendaDia: dias>0 ? pv/dias : 0,
      mediaFatDia:   dias>0 ? fat/dias : 0,
      ticketMedio:   pv>0 ? fat/pv : 0,
      mediaAdsDia:   dias>0 ? (parseFloat(vals.ads)||0)/dias : 0,
    };
  }

  // Agrega DREs de todas as plataformas para o Geral
  function getValoresGeral() {
    const dres = getDREs().filter(d =>
      parseInt(d.clienteId) === parseInt(estado.clienteId) &&
      d.mes === estado.mes && d.ano === estado.ano &&
      d.plataforma !== 'GERAL'
    );
    if (!dres.length) return null;
    const vals = {};
    camposDRE.forEach(c => {
      vals[c.key] = dres.reduce((s,d) => s + (parseFloat(d.valores?.[c.key])||0), 0);
    });
    vals.produtosVendidos = dres.reduce((s,d) => s + (parseFloat(d.valores?.produtosVendidos)||0), 0);
    return vals;
  }

  // Lê os valores dos inputs + linhas custom
  function lerInputs() {
    const vals = {};
    camposDRE.forEach(c => { vals[c.key] = parseVal(document.getElementById('inp-'+c.key)?.value); });
    vals.produtosVendidos = parseVal(document.getElementById('inp-produtosVendidos')?.value);
    // ler linhas custom atualizadas
    linhasCustom.forEach(l => {
      const inp = document.getElementById('inp-custom-'+l.id);
      if (inp) l.valor = parseVal(inp.value);
      const lbl = document.getElementById('lbl-custom-'+l.id);
      if (lbl) l.label = lbl.value || l.label;
    });
    return vals;
  }

  // ── Render ────────────────────────────────────────────────────
  function render() {
    const plats      = getPlataformasDoCliente(estado.clienteId);
    const semProj    = !plats.length;
    const clienteNome = clientes.find(c=>c.id===estado.clienteId)?.nome || '—';
    const mesLabel   = meses[estado.mes];
    const anos       = [anoAtual-1, anoAtual, anoAtual+1];
    const isGeral    = estado.plataforma === 'GERAL';

    if (plats.length && !isGeral && !plats.includes(estado.plataforma)) estado.plataforma = plats[0];

    let saved = null;
    if (!semProj && estado.plataforma) {
      saved = findDRE(estado.clienteId, estado.plataforma, estado.mes, estado.ano);
    }

    // Carregar linhas custom do DRE salvo
    if (saved?.linhasCustom) {
      linhasCustom = saved.linhasCustom.map(l => ({...l}));
      nextLinhaId  = linhasCustom.reduce((m,l)=>Math.max(m,l.id+1),1);
    } else {
      linhasCustom = [];
      nextLinhaId  = 1;
    }

    let vals = {};
    let preenchidoDaProjecao = false;
    let preenchidoGeral = false;

    if (saved) {
      vals = saved.valores;
    } else if (isGeral) {
      const vGeral = getValoresGeral();
      if (vGeral) { vals = vGeral; preenchidoGeral = true; }
    } else if (!semProj && estado.plataforma) {
      const vProj = getValoresDaProjecao(estado.clienteId, estado.plataforma);
      if (vProj) { vals = vProj; preenchidoDaProjecao = true; }
    }

    const calc = calcular(vals, linhasCustom, ocultarGLR);

    el.innerHTML = `
    <div class="dre-wrap">

      <!-- Seletores -->
      <div class="card" style="margin-bottom:20px;">
        <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;">

          <div style="flex:1;min-width:160px;">
            <label class="form-label">Cliente</label>
            <select class="form-control" id="dre-cliente" onchange="dreOnCliente()">
              ${clientes.length===0
                ? `<option value="">Nenhum cliente cadastrado</option>`
                : clientes.map(c=>`<option value="${c.id}" ${c.id===estado.clienteId?'selected':''}>${c.nome}</option>`).join('')}
            </select>
          </div>

          <div style="flex:2;min-width:200px;">
            <label class="form-label">Conta / Plataforma</label>
            ${semProj
              ? `<div style="padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;color:var(--text-muted);">
                   Cadastre plataformas na <a href="#projecao" style="color:var(--accent);" onclick="Router.navigate('projecao')">Projeção</a> primeiro
                 </div>`
              : `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                  ${plats.map(p=>`
                    <button onclick="dreOnPlat('${p}')"
                      style="padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.15s;
                             border:2px solid ${p===estado.plataforma?'var(--accent)':'var(--border)'};
                             background:${p===estado.plataforma?'var(--accent)':'var(--bg-surface)'};
                             color:${p===estado.plataforma?'white':'var(--text-secondary)'};">
                      ${p}
                    </button>`).join('')}
                  <button onclick="dreOnPlat('GERAL')"
                    style="padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.15s;
                           border:2px solid ${isGeral?'#10b981':'var(--border)'};
                           background:${isGeral?'#10b981':'var(--bg-surface)'};
                           color:${isGeral?'white':'var(--text-secondary)'};">
                    📊 Geral
                  </button>
                </div>`}
          </div>

          <div style="flex:0 0 auto;min-width:130px;">
            <label class="form-label">Mês</label>
            <select class="form-control" id="dre-mes" onchange="dreOnPeriodo()">
              ${meses.map((m,i)=>`<option value="${i}" ${i===estado.mes?'selected':''}>${m}</option>`).join('')}
            </select>
          </div>

          <div style="flex:0 0 auto;min-width:88px;">
            <label class="form-label">Ano</label>
            <select class="form-control" id="dre-ano" onchange="dreOnPeriodo()">
              ${anos.map(a=>`<option value="${a}" ${a===estado.ano?'selected':''}>${a}</option>`).join('')}
            </select>
          </div>

          <div style="display:flex;gap:8px;flex-shrink:0;align-items:center;">
            <button onclick="dreToggleGLR()" title="${ocultarGLR?'Mostrar':'Ocultar'} Comissão GLR"
              style="padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;
                     border:1px solid ${ocultarGLR?'rgba(251,191,36,.5)':'var(--border)'};
                     background:${ocultarGLR?'rgba(251,191,36,.12)':'var(--bg-surface)'};
                     color:${ocultarGLR?'#fbbf24':'var(--text-muted)'};display:flex;align-items:center;gap:5px;">
              ${ocultarGLR
                ? `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg> GLR oculta`
                : `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Ocultar GLR`}
            </button>
            <button class="btn btn-primary" onclick="dreSalvar()" ${semProj?'disabled':''}>
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
              Salvar
            </button>
            <button class="btn" style="background:var(--bg-card);border:1px solid var(--border);" onclick="dreExportarPDF()" ${semProj?'disabled':''}>
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              PDF
            </button>
          </div>
        </div>
      </div>

      ${semProj ? `
        <div class="card" style="text-align:center;padding:48px;">
          <div style="font-size:40px;margin-bottom:12px;">📊</div>
          <div style="font-size:16px;font-weight:700;margin-bottom:8px;">Nenhuma plataforma cadastrada</div>
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">Vá até Projeção de Crescimento e adicione as plataformas do cliente para liberar o DRE.</div>
          <button class="btn btn-primary" onclick="Router.navigate('projecao')">Ir para Projeção</button>
        </div>
      ` : renderCard(clienteNome, mesLabel, vals, calc, preenchidoDaProjecao, preenchidoGeral, isGeral)}

      <!-- Histórico -->
      <div class="card" style="margin-top:20px;" id="dre-hist">
        <h3 style="font-size:14px;font-weight:700;margin:0 0 16px;">Histórico de DREs</h3>
        ${renderHistorico()}
      </div>
    </div>

    <style>
      .dre-wrap{max-width:960px;margin:0 auto;}
      .dre-tbl{width:100%;border-collapse:collapse;font-size:14px;}
      .dre-tbl th{background:var(--bg-surface);color:var(--text-muted);font-size:11px;font-weight:600;
        text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;border-bottom:2px solid var(--border);}
      .dre-tbl td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle;}
      .dre-tbl tr:hover td{background:rgba(255,255,255,.02);}
      .dre-receita td{font-weight:600;}
      .dre-resultado td{background:var(--bg-surface)!important;border-top:2px solid var(--border);
        font-weight:700;font-size:15px;padding:14px 12px;}
      .dre-calc td{color:var(--text-muted);font-size:13px;}
      .dre-custom-row td{border-bottom:1px dashed var(--border);}
      .dre-inp{
        background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;
        color:var(--text-primary);font-size:14px;padding:5px 10px;
        text-align:right;width:150px;outline:none;transition:border .15s;
      }
      .dre-inp:focus{border-color:var(--accent);}
      .dre-inp-label{
        background:transparent;border:none;border-bottom:1px dashed var(--border);
        color:var(--text-primary);font-size:13px;font-style:italic;padding:3px 4px;
        width:100%;outline:none;
      }
      .dre-inp-label:focus{border-bottom-color:var(--accent);}
      .dre-inp[readonly]{opacity:.65;cursor:default;}
      /* Print */
      .dre-print-header,.dre-print-footer{display:none;}
      @media print{
        .dre-wrap{max-width:100%;}
        .card{box-shadow:none!important;border:none!important;background:white!important;}
        .dre-screen-header{display:none!important;}
        .dre-print-header{display:block;text-align:center;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #1a2744;}
        .dre-print-logo{background:#1a2744;color:white;font-size:13px;font-weight:800;padding:3px 10px;border-radius:4px;display:inline-block;margin-bottom:10px;}
        .dre-print-title{font-size:22px;font-weight:700;color:#1a2744;margin:0 0 4px;font-style:italic;}
        .dre-print-sub{font-size:15px;color:#555;margin:0;font-style:italic;}
        .dre-print-footer{display:block;text-align:center;margin-top:28px;padding-top:10px;border-top:1px solid #ccc;font-size:11px;color:#888;}
        .dre-tbl th{background:#1a2744!important;color:white!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        .dre-resultado td{background:#f0f2f5!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        .dre-tbl td,.dre-tbl th{color:#111!important;border-color:#ccc!important;}
        .dre-inp{border:none!important;background:transparent!important;color:#111!important;font-size:14px!important;}
        #dre-hist,button,.btn-add-linha,.btn-rem-linha{display:none!important;}
      }
    </style>`;
  }

  function renderCard(clienteNome, mesLabel, vals, calc, preenchidoDaProjecao, preenchidoGeral, isGeral) {
    const dias = diasNoMes(estado.mes, estado.ano);
    const rc   = calc.resultado >= 0 ? 'var(--green)' : 'var(--red)';
    const platLabel = isGeral ? 'Consolidado Geral' : estado.plataforma;
    return `
    <div class="card" id="dre-printable">

      ${preenchidoDaProjecao ? `
      <div style="margin-bottom:16px;padding:10px 14px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:var(--radius-sm);display:flex;align-items:center;gap:10px;">
        <svg width="15" height="15" fill="none" stroke="#6366f1" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span style="font-size:13px;color:var(--accent-light);">
          <strong>Pré-preenchido da Projeção</strong> — Faturamento, ADS e Comissão GLR vieram do último lançamento manual. Complete os demais campos e salve.
        </span>
      </div>` : ''}

      ${preenchidoGeral ? `
      <div style="margin-bottom:16px;padding:10px 14px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:var(--radius-sm);display:flex;align-items:center;gap:10px;">
        <svg width="15" height="15" fill="none" stroke="#10b981" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span style="font-size:13px;color:#10b981;">
          <strong>DRE Geral consolidado</strong> — Soma automática de todos os DREs de plataforma salvos neste período. Salve para fixar e adicionar linhas extras.
        </span>
      </div>` : ''}

      ${isGeral && !preenchidoGeral && !findDRE(estado.clienteId,'GERAL',estado.mes,estado.ano) ? `
      <div style="margin-bottom:16px;padding:10px 14px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:var(--radius-sm);font-size:13px;color:#fbbf24;">
        ⚠️ Nenhum DRE de plataforma salvo para este período. Salve os DREs por plataforma primeiro para o Geral consolidar automaticamente.
      </div>` : ''}

      <div class="dre-print-header">
        <div class="dre-print-logo">GLR</div>
        <h1 class="dre-print-title">${clienteNome}</h1>
        <h2 class="dre-print-sub">${platLabel} · ${mesLabel} ${estado.ano}</h2>
      </div>

      <div class="dre-screen-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <div>
          <h2 style="font-size:18px;font-weight:700;margin:0;">${clienteNome}</h2>
          <p style="color:var(--text-muted);margin:4px 0 0;font-size:13px;">${platLabel} · ${mesLabel} ${estado.ano} · ${dias} dias</p>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;">Resultado</div>
          <div id="res-display" style="font-size:24px;font-weight:800;color:${rc};">${fmt(calc.resultado)}</div>
          <div id="res-pct-display" style="font-size:12px;color:${rc};">${fmtPct(calc.pct)} sobre faturamento</div>
        </div>
      </div>

      <table class="dre-tbl">
        <thead>
          <tr>
            <th style="width:38%;">${platLabel}</th>
            <th style="width:8%;text-align:center;">Moeda</th>
            <th style="width:30%;text-align:right;">DRE</th>
            <th style="width:24%;text-align:right;">Percentual</th>
          </tr>
        </thead>
        <tbody>
          ${camposDRE.map(campo => {
            if (ocultarGLR && campo.key === 'comissaoGLR') return '';
            const v   = parseFloat(vals[campo.key]) || 0;
            const pct = calc.fat > 0 ? (v/calc.fat)*100 : 0;
            return `
            <tr class="${campo.tipo==='receita'?'dre-receita':''}">
              <td style="font-style:italic;">${campo.label}</td>
              <td style="text-align:center;color:var(--text-muted);font-size:12px;">R$</td>
              <td style="text-align:right;">
                <input class="dre-inp" id="inp-${campo.key}" type="text" inputmode="decimal"
                  value="${v>0 ? v.toFixed(2).replace('.',',') : ''}"
                  placeholder="0,00" oninput="dreCalc()" onfocus="this.select()">
              </td>
              <td style="text-align:right;font-style:italic;" id="pct-${campo.key}">${v>0?fmtPct(pct):'0,00%'}</td>
            </tr>`;
          }).join('')}

          <!-- Linhas customizadas -->
          ${linhasCustom.map(l => {
            const v   = parseFloat(l.valor) || 0;
            const pct = calc.fat > 0 ? (v/calc.fat)*100 : 0;
            const corTipo = l.tipo==='receita' ? 'var(--green)' : 'var(--text-muted)';
            return `
            <tr class="dre-custom-row">
              <td>
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="font-size:10px;color:${corTipo};font-weight:700;text-transform:uppercase;">${l.tipo==='receita'?'↑':'↓'}</span>
                  <input class="dre-inp-label" id="lbl-custom-${l.id}" type="text"
                    value="${l.label}" placeholder="Nome da linha" oninput="dreCalc()">
                  <button class="btn-rem-linha" onclick="dreRemoverLinha(${l.id})"
                    style="border:none;background:none;cursor:pointer;color:var(--red);font-size:16px;line-height:1;padding:0 4px;opacity:.6;" title="Remover">×</button>
                </div>
              </td>
              <td style="text-align:center;color:var(--text-muted);font-size:12px;">R$</td>
              <td style="text-align:right;">
                <input class="dre-inp" id="inp-custom-${l.id}" type="text" inputmode="decimal"
                  value="${v>0?v.toFixed(2).replace('.',','):''}"
                  placeholder="0,00" oninput="dreCalc()" onfocus="this.select()">
              </td>
              <td style="text-align:right;font-style:italic;" id="pct-custom-${l.id}">${v>0?fmtPct(pct):'0,00%'}</td>
            </tr>`;
          }).join('')}

          <!-- Botões adicionar linha -->
          <tr>
            <td colspan="4" style="padding:8px 12px;border-bottom:none;">
              <div style="display:flex;gap:8px;">
                <button class="btn btn-add-linha" onclick="dreAdicionarLinha('custo')"
                  style="font-size:12px;padding:4px 12px;background:rgba(248,113,113,0.08);border:1px dashed rgba(248,113,113,0.4);color:#f87171;border-radius:6px;cursor:pointer;">
                  + Linha de Custo
                </button>
                <button class="btn btn-add-linha" onclick="dreAdicionarLinha('receita')"
                  style="font-size:12px;padding:4px 12px;background:rgba(16,185,129,0.08);border:1px dashed rgba(16,185,129,0.4);color:#10b981;border-radius:6px;cursor:pointer;">
                  + Linha de Receita
                </button>
              </div>
            </td>
          </tr>

          <tr class="dre-resultado">
            <td><strong>Resultado</strong></td>
            <td style="text-align:center;"><strong>R$</strong></td>
            <td style="text-align:right;" id="res-val"><strong style="color:${rc};">${fmt(calc.resultado)}</strong></td>
            <td style="text-align:right;" id="res-pct"><strong style="color:${rc};">${fmtPct(calc.pct)}</strong></td>
          </tr>
        </tbody>
      </table>

      <!-- Métricas -->
      <div style="margin-top:24px;border-top:1px solid var(--border);padding-top:18px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px;">
          Métricas Operacionais · ${dias} dias no mês
        </div>
        <table class="dre-tbl">
          <tbody>
            <tr>
              <td style="font-style:italic;width:38%;">Produtos Vendidos</td>
              <td style="width:8%;"></td>
              <td style="text-align:right;width:30%;">
                <input class="dre-inp" id="inp-produtosVendidos" type="text" inputmode="decimal"
                  value="${vals.produtosVendidos>0?Math.round(vals.produtosVendidos):''}"
                  placeholder="0" oninput="dreCalc()" onfocus="this.select()">
              </td>
              <td style="width:24%;"></td>
            </tr>
            <tr class="dre-calc">
              <td style="font-style:italic;">Media de Venda Dia</td><td></td>
              <td style="text-align:right;" id="m-vendaDia">${calc.mediaVendaDia>0?calc.mediaVendaDia.toFixed(0):'-'}</td>
              <td></td>
            </tr>
            <tr class="dre-calc">
              <td style="font-style:italic;">Media Faturamento Dia</td>
              <td style="text-align:center;color:var(--text-muted);font-size:12px;">R$</td>
              <td style="text-align:right;" id="m-fatDia">${calc.mediaFatDia>0?fmtN2(calc.mediaFatDia):'-'}</td>
              <td></td>
            </tr>
            <tr class="dre-calc">
              <td style="font-style:italic;">Ticket Médio</td>
              <td style="text-align:center;color:var(--text-muted);font-size:12px;">R$</td>
              <td style="text-align:right;" id="m-ticket">${calc.ticketMedio>0?fmtN2(calc.ticketMedio):'-'}</td>
              <td></td>
            </tr>
            <tr class="dre-calc">
              <td style="font-style:italic;">Media ADS Dia</td>
              <td style="text-align:center;color:var(--text-muted);font-size:12px;">R$</td>
              <td style="text-align:right;" id="m-adsDia">${calc.mediaAdsDia>0?fmtN2(calc.mediaAdsDia):'-'}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="dre-print-footer">
        <p>GLR Consultoria · Centro de Operações · Gerado em ${new Date().toLocaleDateString('pt-BR')}</p>
      </div>
    </div>`;
  }

  function renderHistorico() {
    const dres = getDREs().sort((a,b)=>b.ano!==a.ano?b.ano-a.ano:b.mes-a.mes);
    if (!dres.length) return `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">Nenhum DRE salvo ainda.</div>`;
    return `<table class="table" style="font-size:13px;">
      <thead><tr>
        <th>Cliente</th><th>Plataforma</th><th>Período</th>
        <th style="text-align:right;">Faturamento</th>
        <th style="text-align:right;">Resultado</th>
        <th style="text-align:right;">%</th>
        <th></th>
      </tr></thead>
      <tbody>
      ${dres.map(d=>{
        const c    = clientes.find(c=>c.id===parseInt(d.clienteId));
        const calc = calcular(d.valores, d.linhasCustom||[]);
        const rc   = calc.resultado>=0?'var(--green)':'var(--red)';
        const isG  = d.plataforma === 'GERAL';
        return `<tr>
          <td>${c?c.nome:'—'}</td>
          <td>${isG?'<span style="color:#10b981;font-weight:700;">📊 Geral</span>':d.plataforma}</td>
          <td>${meses[d.mes]} ${d.ano}</td>
          <td style="text-align:right;">${fmt(calc.fat)}</td>
          <td style="text-align:right;color:${rc};">${fmt(calc.resultado)}</td>
          <td style="text-align:right;color:${rc};">${fmtPct(calc.pct)}</td>
          <td><button class="btn" style="padding:4px 10px;font-size:11px;background:var(--bg-surface);border:1px solid var(--border);"
            onclick="dreAbrir('${d.clienteId}','${encodeURIComponent(d.plataforma)}',${d.mes},${d.ano})">Abrir</button></td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
  }

  // ── Funções globais ───────────────────────────────────────────
  window.dreToggleGLR = function() {
    // Preservar valores digitados antes de re-render
    lerInputs();
    ocultarGLR = !ocultarGLR;
    render();
  };

  window.dreOnCliente = function() {
    estado.clienteId  = parseInt(document.getElementById('dre-cliente')?.value)||null;
    const plats = getPlataformasDoCliente(estado.clienteId);
    estado.plataforma = plats[0]||null;
    render();
  };
  window.dreOnPlat = function(p) { estado.plataforma = p; render(); };
  window.dreOnPeriodo = function() {
    estado.mes = parseInt(document.getElementById('dre-mes')?.value);
    estado.ano = parseInt(document.getElementById('dre-ano')?.value);
    render();
  };

  window.dreAdicionarLinha = function(tipo) {
    linhasCustom.push({ id: nextLinhaId++, label: tipo==='receita'?'Nova Receita':'Novo Custo', tipo, valor: 0 });
    // Re-render apenas a tabela — mais simples fazer render() completo
    render();
    // Focar no label da nova linha
    setTimeout(()=>{
      const ultima = linhasCustom[linhasCustom.length-1];
      document.getElementById('lbl-custom-'+ultima.id)?.focus();
    }, 50);
  };

  window.dreRemoverLinha = function(id) {
    // Salvar valores atuais antes de remover
    lerInputs();
    linhasCustom = linhasCustom.filter(l => l.id !== id);
    render();
  };

  window.dreCalc = function() {
    const vals = lerInputs();
    const calc = calcular(vals, linhasCustom, ocultarGLR);
    const rc   = calc.resultado>=0?'var(--green)':'var(--red)';

    camposDRE.forEach(c => {
      const v   = vals[c.key];
      const pct = calc.fat>0?(v/calc.fat)*100:0;
      const e  = document.getElementById('pct-'+c.key);
      if (e) e.textContent = fmtPct(pct);
    });

    // Atualizar pcts das linhas custom
    linhasCustom.forEach(l => {
      const v   = parseFloat(l.valor) || 0;
      const pct = calc.fat>0?(v/calc.fat)*100:0;
      const e   = document.getElementById('pct-custom-'+l.id);
      if (e) e.textContent = fmtPct(pct);
    });

    const s=(id,html)=>{const e=document.getElementById(id);if(e)e.innerHTML=html;};
    s('res-val',     `<strong style="color:${rc};">${fmt(calc.resultado)}</strong>`);
    s('res-pct',     `<strong style="color:${rc};">${fmtPct(calc.pct)}</strong>`);
    s('res-display', `<span style="color:${rc};font-size:24px;font-weight:800;">${fmt(calc.resultado)}</span>`);
    s('res-pct-display',`<span style="color:${rc};font-size:12px;">${fmtPct(calc.pct)} sobre faturamento</span>`);

    const t=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
    t('m-vendaDia', calc.mediaVendaDia>0?calc.mediaVendaDia.toFixed(0):'-');
    t('m-fatDia',   calc.mediaFatDia>0  ?fmtN2(calc.mediaFatDia):'-');
    t('m-ticket',   calc.ticketMedio>0  ?fmtN2(calc.ticketMedio):'-');
    t('m-adsDia',   calc.mediaAdsDia>0  ?fmtN2(calc.mediaAdsDia):'-');
  };

  window.dreSalvar = function() {
    if (!estado.clienteId||!estado.plataforma) return;
    const vals  = lerInputs();
    // Se comissaoGLR está oculta, preservar valor já salvo para não perder
    if (ocultarGLR) {
      const existente = findDRE(estado.clienteId, estado.plataforma, estado.mes, estado.ano);
      if (existente?.valores?.comissaoGLR) vals.comissaoGLR = existente.valores.comissaoGLR;
    }
    const dres  = getDREs();
    const chave = dreKey(estado.clienteId, estado.plataforma, estado.mes, estado.ano);
    const idx   = dres.findIndex(d=>d.chave===chave);
    const entry = { chave, clienteId:estado.clienteId, plataforma:estado.plataforma,
                    mes:estado.mes, ano:estado.ano, valores:vals,
                    linhasCustom: linhasCustom.map(l=>({...l})),
                    at:new Date().toISOString() };
    if (idx>=0) dres[idx]=entry; else dres.push(entry);
    saveDREs(dres);

    const btn = event?.target?.closest('button');
    if (btn) {
      const orig=btn.innerHTML;
      btn.innerHTML=`<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Salvo!`;
      btn.style.background='var(--green)';
      setTimeout(()=>{btn.innerHTML=orig;btn.style.background='';},2000);
    }
    const hist=document.getElementById('dre-hist');
    if(hist) hist.innerHTML=`<h3 style="font-size:14px;font-weight:700;margin:0 0 16px;">Histórico de DREs</h3>${renderHistorico()}`;
  };

  window.dreExportarPDF = function() {
    const c    = clientes.find(c=>c.id===estado.clienteId)?.nome||'DRE';
    const plat = estado.plataforma==='GERAL'?'Geral':estado.plataforma;
    const orig = document.title;
    document.title=`DRE - ${c} - ${plat} - ${meses[estado.mes]} ${estado.ano}`;
    window.print();
    setTimeout(()=>{document.title=orig;},1000);
  };

  window.dreAbrir = function(cid, plat, mes, ano) {
    estado.clienteId  = parseInt(cid);
    estado.plataforma = decodeURIComponent(plat);
    estado.mes        = mes;
    estado.ano        = ano;
    render();
    window.scrollTo({top:0,behavior:'smooth'});
  };

  render();
});
