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

  // Busca os valores MANUAIS inseridos na projeção para uma plataforma específica
  // Retorna: faturamento (fatBase), ads (adsBase), comissaoGLR (vendasBase × valorPorVenda)
  // e produtosVendidos (vendasBase)
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

    // Só retorna se tiver pelo menos algum valor preenchido
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

  function calcular(vals) {
    const fat    = parseFloat(vals.faturamento) || 0;
    const custos = camposDRE.filter(c=>c.tipo==='custo').reduce((s,c)=>s+(parseFloat(vals[c.key])||0),0);
    const resultado = fat - custos;
    const pct       = fat > 0 ? (resultado/fat)*100 : 0;
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

  // Lê os valores dos inputs
  function lerInputs() {
    const vals = {};
    camposDRE.forEach(c => { vals[c.key] = parseVal(document.getElementById('inp-'+c.key)?.value); });
    vals.produtosVendidos = parseVal(document.getElementById('inp-produtosVendidos')?.value);
    return vals;
  }

  // ── Render ────────────────────────────────────────────────────
  function render() {
    const plats      = getPlataformasDoCliente(estado.clienteId);
    const semProj    = !plats.length;
    const clienteNome = clientes.find(c=>c.id===estado.clienteId)?.nome || '—';
    const mesLabel   = meses[estado.mes];
    const anos       = [anoAtual-1, anoAtual, anoAtual+1];

    if (plats.length && !plats.includes(estado.plataforma)) estado.plataforma = plats[0];

    const saved = (!semProj && estado.plataforma)
      ? findDRE(estado.clienteId, estado.plataforma, estado.mes, estado.ano) : null;

    // Se não há DRE salvo, pré-preenche com os valores manuais da projeção
    let vals = {};
    let preenchidoDaProjecao = false;
    if (saved) {
      vals = saved.valores;
    } else if (!semProj && estado.plataforma) {
      const vProj = getValoresDaProjecao(estado.clienteId, estado.plataforma);
      if (vProj) { vals = vProj; preenchidoDaProjecao = true; }
    }

    const calc = calcular(vals);

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
              : `<div style="display:flex;gap:6px;flex-wrap:wrap;">
                  ${plats.map(p=>`
                    <button onclick="dreOnPlat('${p}')"
                      style="padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.15s;
                             border:2px solid ${p===estado.plataforma?'var(--accent)':'var(--border)'};
                             background:${p===estado.plataforma?'var(--accent)':'var(--bg-surface)'};
                             color:${p===estado.plataforma?'white':'var(--text-secondary)'};">
                      ${p}
                    </button>`).join('')}
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

          <div style="display:flex;gap:8px;flex-shrink:0;">
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
      ` : renderCard(clienteNome, mesLabel, vals, calc, preenchidoDaProjecao)}

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
      .dre-inp{
        background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;
        color:var(--text-primary);font-size:14px;padding:5px 10px;
        text-align:right;width:150px;outline:none;transition:border .15s;
      }
      .dre-inp:focus{border-color:var(--accent);}
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
        #dre-hist,button{display:none!important;}
      }
    </style>`;
  }

  function renderCard(clienteNome, mesLabel, vals, calc, preenchidoDaProjecao) {
    const dias = diasNoMes(estado.mes, estado.ano);
    const rc   = calc.resultado >= 0 ? 'var(--green)' : 'var(--red)';
    return `
    <div class="card" id="dre-printable">

      ${preenchidoDaProjecao ? `
      <div style="margin-bottom:16px;padding:10px 14px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:var(--radius-sm);display:flex;align-items:center;gap:10px;">
        <svg width="15" height="15" fill="none" stroke="#6366f1" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span style="font-size:13px;color:var(--accent-light);">
          <strong>Pré-preenchido da Projeção</strong> — Faturamento, ADS e Comissão GLR vieram do último lançamento manual. Complete os demais campos e salve.
        </span>
      </div>` : ''}

      <div class="dre-print-header">
        <div class="dre-print-logo">GLR</div>
        <h1 class="dre-print-title">${clienteNome}</h1>
        <h2 class="dre-print-sub">${estado.plataforma} · ${mesLabel} ${estado.ano}</h2>
      </div>

      <div class="dre-screen-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <div>
          <h2 style="font-size:18px;font-weight:700;margin:0;">${clienteNome}</h2>
          <p style="color:var(--text-muted);margin:4px 0 0;font-size:13px;">${estado.plataforma} · ${mesLabel} ${estado.ano} · ${dias} dias</p>
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
            <th style="width:38%;">${estado.plataforma}</th>
            <th style="width:8%;text-align:center;">Moeda</th>
            <th style="width:30%;text-align:right;">DRE</th>
            <th style="width:24%;text-align:right;">Percentual</th>
          </tr>
        </thead>
        <tbody>
          ${camposDRE.map(campo => {
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
        const calc = calcular(d.valores);
        const rc   = calc.resultado>=0?'var(--green)':'var(--red)';
        return `<tr>
          <td>${c?c.nome:'—'}</td>
          <td>${d.plataforma}</td>
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

  window.dreCalc = function() {
    const vals = lerInputs();
    const calc = calcular(vals);
    const rc   = calc.resultado>=0?'var(--green)':'var(--red)';

    camposDRE.forEach(c => {
      const v   = vals[c.key];
      const pct = calc.fat>0?(v/calc.fat)*100:0;
      const el  = document.getElementById('pct-'+c.key);
      if (el) el.textContent = fmtPct(pct);
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
    const dres  = getDREs();
    const chave = dreKey(estado.clienteId, estado.plataforma, estado.mes, estado.ano);
    const idx   = dres.findIndex(d=>d.chave===chave);
    const entry = { chave, clienteId:estado.clienteId, plataforma:estado.plataforma,
                    mes:estado.mes, ano:estado.ano, valores:vals, at:new Date().toISOString() };
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
    const orig = document.title;
    document.title=`DRE - ${c} - ${estado.plataforma} - ${meses[estado.mes]} ${estado.ano}`;
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

  function lerInputs() {
    const vals={};
    camposDRE.forEach(c=>{vals[c.key]=parseVal(document.getElementById('inp-'+c.key)?.value);});
    vals.produtosVendidos=parseVal(document.getElementById('inp-produtosVendidos')?.value);
    return vals;
  }

  render();
});
