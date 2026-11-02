// ============================================================
// GLR Consultoria — Adviser (estratégia da GLR até R$ 200 mil/mês)
// ------------------------------------------------------------
// Receita GLR do mês (comissão projetada pela base automática ou pela Projeção
// salva — api/_adviser-revenue.js), a trilha dos marcos (130, 150, 170 e 200
// mil), a estratégia gerada por IA e as missões da equipe. Conversa livre com o
// Adviser fica no Chat com os agentes (seletor "Adviser").
// Adviser is staff-only: both navigation and the API enforce the boundary.
// ============================================================
Router.register('adviser', async (params, el) => {
  if (window._portalConfig) { Router.navigate('meu-dashboard'); return; }
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => n == null ? 'Não informado' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const META = 200000, MARCOS = [130000, 150000, 170000, 200000];
  let mes = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(new Date()), data = null, busy = false, gerando = false, erro = '';
  const st = {}; window._advSt = st;

  async function call(body) {
    if (busy) return; busy = true; gerando = body?.acao === 'gerar'; erro = ''; render();
    try {
      const r = await glrApiFetch(body ? '/api/adviser' : `/api/adviser?mes=${mes}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, mes }) } : {});
      const j = await r.json(); if (!r.ok) throw Error(j.error || 'Adviser indisponível'); data = j;
    } catch (e) { erro = e.message; } finally { busy = false; gerando = false; if (window._advSt === st) render(); }
  }

  function trilha(p) {
    const v = p?.receita, pct = v == null ? 0 : Math.min(100, v / META * 100);
    return `<div class="adv-trilha" role="img" aria-label="${v == null ? 'Receita desconhecida' : `${Math.round(pct)}% da meta de R$ 200 mil`}">
      <div class="adv-trilho"><span style="width:${pct}%"></span></div>
      ${MARCOS.map(m => { const ok = v != null && v >= m; return `<div class="adv-marco ${ok ? 'ok' : ''} ${m === META ? 'meta' : ''}" style="left:${m / META * 100}%"><i></i><b>${money(m)}</b><small>${m === META ? 'meta' : ok ? 'atingido na projeção' : 'marco'}</small></div>`; }).join('')}
    </div>`;
  }

  function render() {
    const p = data?.progresso, rc = data?.receita, est = data?.estrategia?.mes === mes ? data.estrategia : null;
    const missoes = (data?.missoes || []).filter(m => m.mes === mes);
    const STATUS = [['pendente', 'Pendente'], ['em_andamento', 'Em andamento'], ['concluida', 'Concluída']];
    el.innerHTML = `<div class="page adv">
      <div class="ajuda">O Adviser acompanha a receita da GLR (a comissão dos contratos, não o faturamento dos clientes) até R$ 200 mil por mês, monta a estratégia com os planos de todas as contas e registra as missões da equipe. Para conversar com ele, use o Chat com os agentes.</div>
      <section class="card adv-receita">
        <div class="adv-topo">
          <div><span class="adv-rot">Receita GLR projetada para o mês</span>
            <div class="adv-valor">${busy && !data ? 'Calculando…' : money(p?.receita)}<small> de ${money(META)}</small></div>
            <span class="adv-sub">${p?.receita == null ? 'Sem dados de comissão para este mês.' : `Faltam <b>${money(p.falta)}</b> para a meta${p.proximo && p.proximo < META ? ` · próximo marco: <b>${money(p.proximo)}</b>` : ''}. Acumulado até ${rc?.dias ? `o dia ${rc.dias}` : 'a data-base'}: <b>${money(rc?.base)}</b>.`}</span>
          </div>
          <div class="adv-ctrl">
            <label for="adv-mes">Mês</label><input id="adv-mes" class="form-control" type="month" value="${mes}" ${busy ? 'disabled' : ''}>
            <button id="adv-atualizar" class="btn btn-secondary btn-sm" ${busy ? 'disabled' : ''}>Atualizar</button>
          </div>
        </div>
        ${trilha(p)}
        ${rc?.instavel ? `<div class="adv-aviso">Começo do mês: a projeção soma o realizado (${rc.dias} dia${rc.dias > 1 ? 's' : ''}) com o ritmo de venda dos últimos 7 dias nos dias que faltam — a mesma conta do Dashboard.</div>` : ''}
        <div class="adv-rodape">
          <span class="adv-sub">Comissão pelo contrato de cada cliente, só nas contas que contam comissão. Projeção = realizado até ontem + ritmo dos últimos 7 dias; não é faturamento recebido nem marco realizado.</span>
          ${rc?.parcial ? `<details class="adv-faltam"><summary>${rc.faltantes.length} cliente(s) sem dados no mês</summary><p>${h(rc.faltantes.join(', '))}</p></details>` : ''}
          <span style="flex:1"></span>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('rentabilidade')">Rentabilidade da carteira</button>
          <button class="btn btn-ghost btn-sm" onclick="Router.navigate('projecao')">Projeção de faturamento</button>
        </div>
      </section>

      <section class="card adv-bloco">
        <div class="adv-cab"><div><h2>Rota de crescimento</h2><p class="adv-sub">Aquisição, expansão da base, retenção, margem e capacidade da equipe — a partir dos planos do Gerente de Conta.</p></div>
          <div class="adv-bts"><button class="btn btn-secondary btn-sm" onclick="window._advChat()">Conversar com o Adviser</button><button id="adv-gerar" class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}>${gerando ? 'Gerando…' : est ? 'Gerar de novo' : 'Gerar estratégia'}</button></div></div>
        ${est ? `<div class="adv-sub adv-em">Gerada em ${h(new Date(est.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}${est.receitaBase !== p?.receita ? ' · <b>a receita mudou desde então — vale gerar de novo</b>' : ''}</div>
          <div class="adv-md">${window.glrMarkdown(est.texto)}</div>`
          : `<div class="adv-vazio">${gerando ? 'Lendo os planos das contas e montando a rota… (até 1 minuto)' : 'Gere a estratégia para ver o diagnóstico, a rota até o próximo marco e as missões sugeridas.'}</div>`}
      </section>

      <section class="card adv-bloco">
        <div class="adv-cab"><div><h2>Missões da equipe</h2><p class="adv-sub">As prioridades aprovadas, com dono, prazo e critério de sucesso. Concluir uma missão não muda a receita registrada.</p></div></div>
        <form id="adv-missao" class="adv-form">
          <input name="titulo" class="form-control" placeholder="Missão — ação concreta" maxlength="240" required aria-label="Missão">
          <input name="responsavel" class="form-control" placeholder="Responsável" maxlength="100" required aria-label="Responsável">
          <input name="indicador" class="form-control" placeholder="Indicador e critério de sucesso" maxlength="500" required aria-label="Indicador">
          <input name="prazo" class="form-control" type="date" required aria-label="Prazo">
          <button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}>Registrar</button>
        </form>
        ${missoes.length ? `<div class="adv-missoes">${missoes.map(m => `<div class="adv-m ${m.status}">
          <div class="adv-m-txt"><b>${h(m.titulo)}</b><span>${h(m.indicador)}</span><small>${h(m.responsavel)} · prazo ${h(new Date(m.prazo + 'T12:00:00').toLocaleDateString('pt-BR'))}</small></div>
          <select class="form-control adv-st" data-missao="${h(m.id)}" aria-label="Status da missão" ${busy ? 'disabled' : ''}>${STATUS.map(([v, t]) => `<option value="${v}" ${v === m.status ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>`).join('')}</div>` : '<div class="adv-vazio">Nenhuma missão registrada neste mês.</div>'}
      </section>
      ${erro ? `<p role="alert" class="adv-erro">${h(erro)}</p>` : ''}
    </div>
    <style>
      .adv{max-width:1100px} .adv-sub{font-size:12.5px;color:var(--text-muted);line-height:1.5} .adv-sub b{color:var(--text-primary)}
      .adv-receita{padding:20px 22px;margin-bottom:16px}
      .adv-topo{display:flex;gap:18px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}
      .adv-rot{font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em}
      .adv-valor{font-size:32px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.15;margin:4px 0 2px} .adv-valor small{font-size:15px;font-weight:500;color:var(--text-muted)}
      .adv-ctrl{display:flex;align-items:center;gap:8px} .adv-ctrl label{font-size:12.5px;color:var(--text-secondary)} .adv-ctrl input{width:auto}
      .adv-trilha{position:relative;margin:22px 0 44px}
      .adv-trilho{height:10px;border-radius:99px;background:var(--bg-subtle);overflow:hidden} .adv-trilho span{display:block;height:100%;background:var(--accent);border-radius:99px}
      .adv-marco{position:absolute;top:-4px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;white-space:nowrap}
      .adv-marco.meta{transform:translateX(-100%);align-items:flex-end}
      .adv-marco i{width:18px;height:18px;border-radius:50%;background:var(--bg-surface);border:2px solid var(--border)} .adv-marco.ok i{background:var(--accent);border-color:var(--accent)} .adv-marco.meta i{border-color:var(--text-secondary)}
      .adv-marco b{font-size:12px;font-weight:650;margin-top:4px;font-variant-numeric:tabular-nums} .adv-marco small{font-size:11px;color:var(--text-muted)}
      .adv-aviso{font-size:12.5px;padding:8px 12px;border-radius:8px;background:color-mix(in srgb,#d98b00 12%,transparent);color:var(--text-primary);margin-bottom:10px}
      .adv-rodape{display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:12px}
      .adv-faltam summary{cursor:pointer;font-size:12.5px;color:var(--text-secondary)} .adv-faltam p{font-size:12.5px;color:var(--text-muted);margin:6px 0 0;max-width:640px;line-height:1.5}
      .adv-bloco{padding:18px 22px;margin-bottom:16px}
      .adv-cab{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-bottom:10px} .adv-cab h2{font-size:17px;font-weight:650;margin:0 0 2px}
      .adv-bts{display:flex;gap:8px;flex-wrap:wrap} .adv-em{margin-bottom:8px}
      .adv-vazio{font-size:13px;color:var(--text-muted);padding:18px;text-align:center;border:1px dashed var(--border);border-radius:10px}
      .adv-md{font-size:14px;line-height:1.65;color:var(--text-primary);max-width:860px} .adv-md p{margin:0 0 10px} .adv-md ul,.adv-md ol{margin:0 0 12px;padding-left:22px} .adv-md li{margin:3px 0}
      .adv-md h3{font-size:16px;font-weight:650;margin:20px 0 8px;padding-top:12px;border-top:1px solid var(--border)} .adv-md h3:first-child{border-top:0;padding-top:0;margin-top:4px} .adv-md h4,.adv-md h5{font-size:14.5px;font-weight:650;margin:14px 0 6px}
      .adv-md code{background:var(--bg-subtle);padding:1px 5px;border-radius:5px;font-size:12.5px} .adv-md hr{border:0;border-top:1px solid var(--border);margin:14px 0}
      .adv-md .ch-tab{overflow-x:auto;margin:0 0 12px;border:1px solid var(--border);border-radius:10px} .adv-md table{border-collapse:collapse;width:100%;font-size:13px} .adv-md th{text-align:left;font-weight:600;background:var(--bg-subtle);padding:7px 10px} .adv-md td{padding:7px 10px;border-top:1px solid var(--border);vertical-align:top}
      .adv-form{display:grid;grid-template-columns:2fr 1fr 2fr auto auto;gap:8px;margin-bottom:12px}
      .adv-missoes{display:flex;flex-direction:column}
      .adv-m{display:flex;gap:12px;align-items:center;padding:11px 0;border-top:1px solid var(--border)}
      .adv-m-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;font-size:13px} .adv-m-txt b{font-weight:600} .adv-m-txt span{color:var(--text-secondary)} .adv-m-txt small{color:var(--text-muted);font-size:12px}
      .adv-m.concluida .adv-m-txt b{text-decoration:line-through;color:var(--text-muted)}
      .adv-st{width:auto;flex:none}
      .adv-erro{color:var(--red);font-size:13px}
      @media (max-width:800px){.adv-form{grid-template-columns:1fr}.adv-marco small{display:none}.adv-marco b{font-size:10.5px}}
    </style>`;
    el.querySelector('#adv-mes').onchange = e => { mes = e.target.value; data = null; call(); };
    el.querySelector('#adv-gerar').onclick = () => call({ acao: 'gerar' });
    el.querySelector('#adv-atualizar').onclick = () => call();
    el.querySelector('#adv-missao').onsubmit = e => { e.preventDefault(); call({ acao: 'missao', ...Object.fromEntries(new FormData(e.target)) }); };
    el.querySelectorAll('[data-missao]').forEach(s => s.onchange = () => call({ acao: 'status', id: s.dataset.missao, status: s.value }));
  }
  window._advChat = () => { window._glrChatAgente = 'adviser'; Router.navigate('chat'); };
  await call();
});
