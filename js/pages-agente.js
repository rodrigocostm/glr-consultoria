// ============================================================
// GLR Consultoria — Agente Autônomo de ADS (piloto)
// Aba dedicada: configura 1 conta Shopee como piloto (o cron em
// api/agente-cron.js roda 1x/dia às 07:00 BRT, avalia as campanhas contra as
// metas daqui e executa pausar/retomar/orçamento sozinho), mostra cards de
// status, o log de tudo que foi feito/decidido, os relatórios diários e um
// chat pra conversar com o agente usando esse mesmo contexto.
// ============================================================
(function () {

  function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
  function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }
  const R$ = v => 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const TIPO_LABEL = { decisao: '⚙️ Decisão', alerta: '🔔 Alerta', sistema: '🖥️ Sistema', chat: '💬 Chat' };
  const TIPO_COR = { decisao: '#6366f1', alerta: '#d97706', sistema: '#64748b', chat: '#0ea5e9' };
  const RESULTADO_LABEL = { executado: '✅ Executado', erro: '⚠️ Erro', so_alerta: '🔔 Aguardando aprovação' };
  const RESULTADO_COR = { executado: '#16a34a', erro: '#dc2626', so_alerta: '#d97706' };

  function renderPage(params, el) {
    const state = {
      carregando: true,
      contasShopee: [],
      config: null, // linha ativa (piloto) mais recente, ou null
      logs: [],
      relatorios: [],
      chatMessages: [], // {role, content}
      chatEnviando: false,
      salvandoConfig: false,
      filtroLog: 'todos',
      dadosAoVivo: null, carregandoDadosAoVivo: false,
    };

    function render() { renderShell(); }

    async function carregarTudo() {
      state.carregando = true;
      render();
      try {
        const [contas, cfgResp, logsResp, relResp] = await Promise.all([
          MarketplaceAPI.listAccounts().catch(() => []),
          _sb.from('glr_agente_config').select('*').order('atualizado_em', { ascending: false }).limit(1),
          _sb.from('glr_agente_log').select('*').order('criado_em', { ascending: false }).limit(60),
          _sb.from('glr_agente_relatorios').select('*').order('data', { ascending: false }).limit(30),
        ]);
        state.contasShopee = (contas || []).filter(c => (c.marketplace || '').toLowerCase() === 'shopee');
        state.config = cfgResp.data?.[0] || null;
        state.logs = logsResp.data || [];
        state.relatorios = relResp.data || [];
      } catch (e) {
        console.warn('[Agente] erro ao carregar:', e.message);
      } finally {
        state.carregando = false;
        render();
      }
      if (state.config?.conta_id) buscarDadosAoVivo();
    }

    function dataLocal(diasAtras) {
      const d = new Date(); d.setDate(d.getDate() - diasAtras);
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
    }

    // ── Dados ao vivo da Shopee (últimos 7 dias) — pro chat e pros cards
    // terem número de verdade mesmo antes do cron rodar pela 1ª vez ──
    async function buscarDadosAoVivo() {
      if (!state.config?.conta_id) return;
      state.carregandoDadosAoVivo = true;
      render();
      try {
        const shopId = state.config.conta_id;
        const listaResp = await MarketplaceAPI.call('shopee_ads_campaigns', { shopId });
        const campanhas = listaResp.data?.response?.campaign_list || listaResp.response?.campaign_list || [];
        const hoje = dataLocal(0), seteDiasAtras = dataLocal(7);
        const settingsPorId = {}, diarioPorId = {};
        const ids = campanhas.map(c => c.campaign_id);
        let falhasSettings = 0, falhasDiario = 0, lotes = 0, ultimoErro = '';
        for (let i = 0; i < ids.length; i += 20) {
          lotes++;
          const idsStr = ids.slice(i, i + 20).join(',');
          const [settingsResp, diarioResp] = await Promise.all([
            MarketplaceAPI.call('shopee_ads_campaign_settings', { shopId, campaign_id_list: idsStr }).catch((e) => { falhasSettings++; ultimoErro = e.message || String(e); return null; }),
            MarketplaceAPI.call('shopee_ads_campaign_daily', { shopId, campaign_id_list: idsStr, start_date: seteDiasAtras, end_date: hoje }).catch((e) => { falhasDiario++; ultimoErro = e.message || String(e); return null; }),
          ]);
          (settingsResp?.data?.response?.campaign_list || settingsResp?.response?.campaign_list || []).forEach(c => { settingsPorId[c.campaign_id] = c.common_info || {}; });
          (diarioResp?.data?.response?.campaign_list || diarioResp?.response?.campaign_list || []).forEach(c => {
            const dias = c.metrics_list || [];
            diarioPorId[c.campaign_id] = {
              gasto: dias.reduce((s, d) => s + (parseFloat(d.expense) || 0), 0),
              gmv: dias.reduce((s, d) => s + (parseFloat(d.broad_gmv) || 0), 0),
              pedidos: dias.reduce((s, d) => s + (parseInt(d.broad_order) || 0), 0),
            };
          });
        }
        // Soma o gasto de TODA campanha que teve atividade na janela, mesmo
        // que já tenha encerrado depois — uma campanha que gastou 3 dias e
        // terminou ontem ainda pesou no TACOS da semana. Filtrar só "ongoing"
        // aqui subestimava o investimento real (confirmado comparando com o
        // Gestor Seller: R$371 vs R$703 reais na mesma janela).
        let gastoTotal = 0, gmvTotal = 0, pedidosTotal = 0, ativas = 0;
        const porCampanha = [];
        campanhas.forEach(c => {
          const s = settingsPorId[c.campaign_id], d = diarioPorId[c.campaign_id];
          if (!s || !d) return;
          if (d.gasto <= 0 && d.gmv <= 0) return; // sem atividade na janela, ignora
          gastoTotal += d.gasto; gmvTotal += d.gmv; pedidosTotal += d.pedidos;
          if ((s.campaign_status || '').toLowerCase() === 'ongoing') ativas++;
          const acos = d.gmv > 0 ? (d.gasto / d.gmv * 100) : (d.gasto > 0 ? Infinity : 0);
          porCampanha.push({ nome: c.campaign_name, budget: parseFloat(s.campaign_budget) || 0, gasto: d.gasto, gmv: d.gmv, acos, status: s.campaign_status });
        });
        porCampanha.sort((a, b) => b.gasto - a.gasto);

        // Se as chamadas de métrica falharam em todos os lotes (ex: instabilidade
        // da API da Shopee/Tiops), "0 campanhas ativas" seria enganoso — parece
        // "conta sem campanha" quando na verdade é "não consegui buscar agora".
        if (campanhas.length > 0 && falhasSettings >= lotes && falhasDiario >= lotes) {
          state.dadosAoVivo = { erro: `Não consegui buscar métricas das ${campanhas.length} campanhas agora. Erro real: "${ultimoErro || 'desconhecido'}". Tente "Atualizar" de novo em alguns minutos.` };
        } else {
          // Faturamento TOTAL da loja (não só o atribuído ao ADS) — base do TACOS,
          // que é a métrica que a GLR usa de verdade pra julgar a conta, não ACOS
          // isolado de campanha.
          let faturamentoTotal = 0;
          for (const st of ['COMPLETED', 'READY_TO_SHIP', 'SHIPPED']) {
            try {
              const r = await MarketplaceAPI.call('shopee_sales_summary', { shopId, days: 7, order_status: st });
              faturamentoTotal += parseFloat(r.data?.total_revenue ?? r.total_revenue) || 0;
            } catch (e) {}
          }
          const tacosGeral = faturamentoTotal > 0 ? (gastoTotal / faturamentoTotal * 100) : (gastoTotal > 0 ? Infinity : 0);
          state.dadosAoVivo = {
            atualizadoEm: new Date().toISOString(),
            campanhasAtivas: ativas, gastoTotal, gmvTotal, pedidosTotal, faturamentoTotal, tacosGeral,
            acosGeral: gmvTotal > 0 ? (gastoTotal / gmvTotal * 100) : (gastoTotal > 0 ? Infinity : 0),
            top5: porCampanha.slice(0, 5),
            avisoParcial: (falhasSettings > 0 || falhasDiario > 0) ? 'Algumas campanhas podem estar faltando — houve falha parcial ao buscar dados da Shopee.' : null,
          };
        }
      } catch (e) {
        state.dadosAoVivo = { erro: e.message || String(e) };
      } finally {
        state.carregandoDadosAoVivo = false;
        render();
      }
    }

    function nomeConta(c) {
      const tag = c.tags?.[0]?.name || c.tags?.[0];
      return (typeof tag === 'string' ? tag : tag?.value) || c.nickname || c.external_id;
    }

    // ── Salvar configuração do piloto ────────────────────────
    async function salvarConfig() {
      const v = id => document.getElementById(id)?.value;
      const contaId = v('ag-conta');
      if (!contaId) { alert('Selecione a conta Shopee que vai virar o piloto.'); return; }
      const contaObj = state.contasShopee.find(c => (c.param_to_use?.shopId || c.external_id) === contaId);
      const ativo = document.getElementById('ag-ativo')?.checked || false;

      const row = {
        conta_id: contaId,
        cliente_nome: contaObj ? nomeConta(contaObj) : contaId,
        cliente_id: null,
        marketplace: 'shopee',
        ativo,
        meta_acos: parseFloat(v('ag-meta-acos')) || null,
        orcamento_min: parseFloat(v('ag-orc-min')) || null,
        orcamento_max: parseFloat(v('ag-orc-max')) || null,
        margem_pct: parseFloat(v('ag-margem')) || null,
        estoque_minimo: parseInt(v('ag-estoque-min'), 10) || null,
        regra_pausa_acos: parseFloat(v('ag-pausa-acos')) || null,
        regra_pausa_dias: parseInt(v('ag-pausa-dias'), 10) || 3,
        janela_decisao_dias: parseInt(v('ag-janela'), 10) || 1,
        alerta_variacao_pct: parseFloat(v('ag-alerta-var')) || 30,
        dias_maturacao_campanha: parseInt(v('ag-maturacao'), 10) || 7,
        notas: v('ag-notas') || '',
        atualizado_em: new Date().toISOString(),
      };

      state.salvandoConfig = true;
      render();
      try {
        // Piloto é sempre 1 conta só de propósito (teste controlado) — ativar
        // essa desativa qualquer outra que estivesse ligada antes.
        if (ativo) {
          await _sb.from('glr_agente_config').update({ ativo: false }).neq('conta_id', contaId);
        }
        const { error } = await _sb.from('glr_agente_config').upsert(row, { onConflict: 'conta_id' });
        if (error) throw error;
        await _sb.from('glr_agente_log').insert({
          conta_id: contaId, cliente_nome: row.cliente_nome, tipo: 'sistema',
          titulo: ativo ? 'Piloto ativado' : 'Configuração salva',
          explicacao: `Configuração atualizada pelo analista. Meta TACOS ${row.meta_acos ?? '—'}%, orçamento ${row.orcamento_min ?? '—'}–${row.orcamento_max ?? '—'}, pausa automática acima de ${row.regra_pausa_acos ?? '—'}% ACOS por ${row.regra_pausa_dias} dia(s), maturação mínima de ${row.dias_maturacao_campanha} dia(s).`,
          dados: row, resultado: 'executado', origem: 'analista',
        });
        await carregarTudo();
      } catch (e) {
        alert('Erro ao salvar configuração: ' + (e.message || e));
      } finally {
        state.salvandoConfig = false;
        render();
      }
    }

    // ── Chat com o agente ────────────────────────────────────
    function contextoAgente() {
      const cfg = state.config;
      const logsRecentes = state.logs.slice(0, 15).map(l =>
        `[${new Date(l.criado_em).toLocaleString('pt-BR')}] ${TIPO_LABEL[l.tipo] || l.tipo} — ${l.titulo}: ${l.explicacao || ''}`
      ).join('\n');
      const ultimoRelatorio = state.relatorios[0];
      const d = state.dadosAoVivo;
      const dadosTexto = !d ? '\nDADOS AO VIVO: ainda não carregados.'
        : d.erro ? `\nDADOS AO VIVO: erro ao buscar (${d.erro})`
        : `\nDADOS AO VIVO DA SHOPEE (últimos 7 dias, atualizado ${new Date(d.atualizadoEm).toLocaleTimeString('pt-BR')}):\nFaturamento TOTAL da loja: ${R$(d.faturamentoTotal)} | Investimento ADS: ${R$(d.gastoTotal)} | TACOS da conta: ${d.tacosGeral === Infinity ? '∞' : d.tacosGeral.toFixed(1) + '%'} (esta é a métrica principal, não o ACOS isolado abaixo)\nCampanhas ativas: ${d.campanhasAtivas} | Vendas atribuídas ao ADS: ${R$(d.gmvTotal)} | Pedidos atribuídos: ${d.pedidosTotal} | ACOS médio das campanhas: ${d.acosGeral === Infinity ? '∞ (gastou sem vender nada)' : d.acosGeral.toFixed(1) + '%'}\nTop campanhas por investimento (ACOS individual, útil só pra comparar entre elas):\n${d.top5.map(c => `- ${(c.nome || '').slice(0, 60)}: orçamento ${R$(c.budget)}, gasto ${R$(c.gasto)}, vendas ${R$(c.gmv)}, ACOS ${c.acos === Infinity ? '∞' : c.acos.toFixed(1) + '%'}`).join('\n') || '(nenhuma campanha ativa com dados na janela)'}`;
      return [
        cfg ? `CONFIGURAÇÃO ATUAL DO PILOTO (conta ${cfg.cliente_nome || cfg.conta_id}, ${cfg.ativo ? 'ATIVO' : 'inativo'}):` : 'Nenhuma conta piloto configurada ainda.',
        cfg ? `Meta TACOS: ${cfg.meta_acos ?? '—'}% (métrica principal: investimento ADS ÷ faturamento TOTAL da loja, não ACOS isolado) | Orçamento: ${cfg.orcamento_min ?? '—'} a ${cfg.orcamento_max ?? '—'} | Margem: ${cfg.margem_pct ?? '—'}% | Estoque mínimo: ${cfg.estoque_minimo ?? '—'} | Pausa automática acima de ${cfg.regra_pausa_acos ?? '—'}% ACOS por ${cfg.regra_pausa_dias ?? '—'} dia(s), só após ${cfg.dias_maturacao_campanha ?? 7} dia(s) de maturação da campanha | Alerta humano se variação de orçamento > ${cfg.alerta_variacao_pct ?? '—'}% | Notas: ${cfg.notas || '—'}` : '',
        cfg ? dadosTexto : '',
        ultimoRelatorio ? `\nÚLTIMO RELATÓRIO DIÁRIO (${ultimoRelatorio.data}):\n${ultimoRelatorio.resumo}` : '',
        logsRecentes ? `\nÚLTIMAS AÇÕES/EVENTOS REGISTRADOS NO LOG:\n${logsRecentes}` : '',
      ].filter(Boolean).join('\n');
    }

    async function enviarChat() {
      const input = document.getElementById('ag-chat-input');
      const texto = input?.value.trim();
      if (!texto || state.chatEnviando) return;
      input.value = '';
      state.chatMessages.push({ role: 'user', content: texto });
      state.chatEnviando = true;
      render();

      try {
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system: `Você é o Agente Autônomo de ADS da GLR Consultoria, hoje rodando em modo PILOTO numa única conta Shopee. Você mesmo decide pausar campanha, retomar campanha e ajustar orçamento diariamente com base nas regras configuradas pelo analista — sem precisar de aprovação manual, exceto quando a variação proposta passa do limite de alerta configurado. A métrica principal pra julgar a saúde da conta é o TACOS (investimento em ADS dividido pelo faturamento TOTAL da loja, não só a venda atribuída ao ADS) — NUNCA trate ACOS isolado de uma campanha como veredito sobre a conta inteira, ele só serve pra comparar campanhas entre si. Campanhas novas (dentro do período de maturação configurado) não são pausadas por ACOS ruim ainda, mesmo que o critério tenha sido tecnicamente atingido — dá tempo delas amadurecerem primeiro. Converse em português, direto, como um analista sênior explicando decisões pra outro analista. Use os dados de contexto abaixo (configuração, último relatório, log recente) pra responder — nunca invente números que não estão aí. Se o analista pedir pra mudar uma regra, explique que isso se edita no painel de configuração da aba, você não altera a config pelo chat.\n\n${contextoAgente()}`,
            messages: state.chatMessages,
          }),
        });
        const json = await resp.json();
        if (json.error) throw new Error(json.error);
        const resposta = json.content || 'Sem resposta.';
        state.chatMessages.push({ role: 'assistant', content: resposta });
        try {
          await _sb.from('glr_agente_log').insert({
            conta_id: state.config?.conta_id || null, cliente_nome: state.config?.cliente_nome || null,
            tipo: 'chat', titulo: 'Conversa com o analista', explicacao: `Pergunta: ${texto}\n\nResposta: ${resposta}`,
            dados: {}, resultado: 'executado', origem: 'analista',
          });
        } catch (e) {}
      } catch (e) {
        state.chatMessages.push({ role: 'assistant', content: '⚠️ Erro ao falar com o agente: ' + (e.message || e) });
      } finally {
        state.chatEnviando = false;
        render();
        const msgs = document.getElementById('ag-chat-msgs');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      }
    }

    // ── Cards de análise ──────────────────────────────────────
    function renderCards() {
      const cfg = state.config;
      const ultimoRel = state.relatorios[0];
      const seteDiasAtras = Date.now() - 7 * 24 * 3600 * 1000;
      const decisoesSemana = state.logs.filter(l => l.tipo === 'decisao' && l.resultado === 'executado' && new Date(l.criado_em).getTime() > seteDiasAtras).length;
      const alertasPendentes = state.logs.filter(l => l.tipo === 'alerta' && l.resultado === 'so_alerta').length;

      const card = (label, valor, cor, sub) => `
        <div class="card" style="padding:16px 18px;">
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">${label}</div>
          <div style="font-size:20px;font-weight:700;color:${cor || 'var(--text-primary)'};">${valor}</div>
          ${sub ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${sub}</div>` : ''}
        </div>`;

      return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px;">
        ${card('Piloto', cfg?.ativo ? '🟢 Ativo' : '⚪ Inativo', cfg?.ativo ? '#16a34a' : 'var(--text-muted)', cfg ? esc(cfg.cliente_nome || cfg.conta_id) : 'nenhuma conta configurada')}
        ${card('TACOS mais recente', ultimoRel?.metricas?.tacos_conta != null ? `${ultimoRel.metricas.tacos_conta.toFixed(1)}%` : '—', null, cfg?.meta_acos ? `meta: ${cfg.meta_acos}%` : '')}
        ${card('Decisões (7 dias)', decisoesSemana, '#6366f1', 'pausar / retomar / orçamento')}
        ${card('Alertas pendentes', alertasPendentes, alertasPendentes ? '#d97706' : '#16a34a', 'aguardando aprovação manual')}
      </div>`;
    }

    // ── Config do piloto ──────────────────────────────────────
    function renderConfig() {
      const cfg = state.config || {};
      return `<div class="card" style="padding:20px 22px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div style="font-size:14px;font-weight:700;">⚙️ Configuração do piloto</div>
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;">
            <input type="checkbox" id="ag-ativo" ${cfg.ativo ? 'checked' : ''}> Piloto ativo (o cron age sozinho nessa conta)
          </label>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;">
          Só 1 conta fica ativa por vez, de propósito — é o teste controlado. Ativar uma nova desativa a anterior automaticamente.
        </div>

        <div class="form-group" style="margin-bottom:12px;">
          <label class="form-label">Conta Shopee piloto</label>
          <select class="form-select" id="ag-conta">
            <option value="">— Selecione —</option>
            ${state.contasShopee.map(c => {
              const id = c.param_to_use?.shopId || c.external_id;
              return `<option value="${id}" ${cfg.conta_id === id ? 'selected' : ''}>${esc(nomeConta(c))}</option>`;
            }).join('')}
          </select>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px;">
          <div class="form-group" style="margin:0;"><label class="form-label" title="Investimento em ADS ÷ faturamento TOTAL da loja — não é o ACOS isolado de campanha. É a métrica principal que o agente usa pra decidir.">Meta TACOS (%)</label><input type="number" step="0.1" class="form-input" id="ag-meta-acos" value="${esc(cfg.meta_acos ?? '')}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Orçamento mín. (R$/dia)</label><input type="number" step="0.01" class="form-input" id="ag-orc-min" value="${esc(cfg.orcamento_min ?? '')}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Orçamento máx. (R$/dia)</label><input type="number" step="0.01" class="form-input" id="ag-orc-max" value="${esc(cfg.orcamento_max ?? '')}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Margem (%)</label><input type="number" step="0.1" class="form-input" id="ag-margem" value="${esc(cfg.margem_pct ?? '')}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Estoque mínimo</label><input type="number" class="form-input" id="ag-estoque-min" value="${esc(cfg.estoque_minimo ?? '')}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Pausa automática se ACOS da campanha acima de (%)</label><input type="number" step="0.1" class="form-input" id="ag-pausa-acos" value="${esc(cfg.regra_pausa_acos ?? '')}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">...por quantos dias seguidos</label><input type="number" class="form-input" id="ag-pausa-dias" value="${esc(cfg.regra_pausa_dias ?? 3)}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label" title="Campanha mais nova que isso não é pausada por ACOS ruim, mesmo que o critério acima tenha sido atingido — só registra um aviso.">Maturação mínima da campanha (dias)</label><input type="number" class="form-input" id="ag-maturacao" value="${esc(cfg.dias_maturacao_campanha ?? 7)}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Janela de decisão (dias)</label><input type="number" class="form-input" id="ag-janela" value="${esc(cfg.janela_decisao_dias ?? 1)}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Alerta humano se variação orçamento &gt; (%)</label><input type="number" class="form-input" id="ag-alerta-var" value="${esc(cfg.alerta_variacao_pct ?? 30)}"></div>
        </div>
        <div class="form-group" style="margin-bottom:14px;">
          <label class="form-label">Notas / calendário de promoções / contexto extra</label>
          <textarea class="form-textarea" id="ag-notas" rows="2" placeholder="Ex: Black Friday em novembro, não cortar orçamento nessa semana mesmo se ACOS subir.">${cfg.notas || ''}</textarea>
        </div>

        <button class="btn btn-primary" ${state.salvandoConfig ? 'disabled' : ''} onclick="window._agSalvarConfig()">
          ${state.salvandoConfig ? '⏳ Salvando...' : '💾 Salvar configuração'}
        </button>
      </div>`;
    }

    // ── Log ────────────────────────────────────────────────────
    function renderLog() {
      const lista = state.filtroLog === 'todos' ? state.logs : state.logs.filter(l => l.tipo === state.filtroLog);
      return `<div class="card" style="padding:20px 22px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
          <div style="font-size:14px;font-weight:700;">📜 Log de tudo que foi feito</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${['todos', 'decisao', 'alerta', 'sistema', 'chat'].map(t => `
              <button class="btn btn-sm ${state.filtroLog === t ? 'btn-primary' : 'btn-secondary'}" onclick="window._agFiltrarLog('${t}')">${t === 'todos' ? 'Todos' : TIPO_LABEL[t]}</button>
            `).join('')}
          </div>
        </div>
        ${!lista.length ? `<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:13px;">Nenhum registro ainda — o log enche assim que o piloto rodar pela primeira vez.</div>` : `
        <div style="display:flex;flex-direction:column;gap:8px;max-height:480px;overflow-y:auto;">
          ${lista.map(l => `
            <div style="border:1px solid var(--border);border-left:3px solid ${TIPO_COR[l.tipo] || '#64748b'};border-radius:8px;padding:10px 14px;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px;">
                <div style="font-size:13px;font-weight:600;">${esc(l.titulo)}</div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <span style="font-size:10.5px;color:${RESULTADO_COR[l.resultado] || 'var(--text-muted)'};font-weight:600;">${RESULTADO_LABEL[l.resultado] || l.resultado}</span>
                  <span style="font-size:10.5px;color:var(--text-muted);">${new Date(l.criado_em).toLocaleString('pt-BR')}</span>
                </div>
              </div>
              ${l.explicacao ? `<div style="font-size:12.5px;color:var(--text-secondary);margin-top:6px;line-height:1.55;white-space:pre-wrap;">${nl2br(l.explicacao)}</div>` : ''}
            </div>`).join('')}
        </div>`}
      </div>`;
    }

    // ── Decisões recentes (tabela estruturada, mais legível que o log em texto) ──
    function renderDecisoesRecentes() {
      const decisoes = state.logs.filter(l => l.tipo === 'decisao').slice(0, 20);
      if (!decisoes.length) return '';
      const nomeCampanha = titulo => esc((titulo || '').replace(/^(Campanha pausada|Orçamento ajustado|Meta de ROAS ajustada|Falha ao pausar|Falha ao ajustar orçamento|Falha ao ajustar meta de ROAS) — /, ''));
      return `<div class="card" style="padding:20px 22px;margin-bottom:20px;overflow-x:auto;">
        <div style="font-size:14px;font-weight:700;margin-bottom:4px;">⚡ Últimas decisões (ações automáticas)</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;">O que o agente mudou em cada campanha, e por quê.</div>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <thead>
            <tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border);">
              <th style="padding:6px 8px;">Produto / campanha</th>
              <th style="padding:6px 8px;">Ação</th>
              <th style="padding:6px 8px;">De → Para</th>
              <th style="padding:6px 8px;">ACOS</th>
              <th style="padding:6px 8px;">Resultado</th>
              <th style="padding:6px 8px;">Quando</th>
            </tr>
          </thead>
          <tbody>
            ${decisoes.map(l => {
              const d = l.dados || {};
              let acao = '—', deParaVal = '—';
              if (d.roas_de != null && d.roas_para != null) {
                acao = d.roas_para < d.roas_de ? '🔽 Lance + agressivo' : '🔼 Lance + conservador';
                deParaVal = `${d.roas_de}x → ${d.roas_para}x`;
              } else if (d.budget_de != null && d.budget_para != null) {
                acao = d.budget_para > d.budget_de ? '🔼 Orçamento ↑' : '🔽 Orçamento ↓';
                deParaVal = `${R$(d.budget_de)} → ${R$(d.budget_para)}`;
              } else if ((l.titulo || '').includes('pausada')) {
                acao = '⏸️ Pausada';
              }
              return `<tr style="border-bottom:1px solid var(--border);">
                <td style="padding:6px 8px;font-weight:600;max-width:260px;">${nomeCampanha(l.titulo)}</td>
                <td style="padding:6px 8px;white-space:nowrap;">${acao}</td>
                <td style="padding:6px 8px;white-space:nowrap;font-variant-numeric:tabular-nums;">${deParaVal}</td>
                <td style="padding:6px 8px;white-space:nowrap;">${d.acos != null ? d.acos.toFixed(1) + '%' : '—'}</td>
                <td style="padding:6px 8px;white-space:nowrap;color:${RESULTADO_COR[l.resultado] || 'var(--text-muted)'};font-weight:600;">${RESULTADO_LABEL[l.resultado] || l.resultado}</td>
                <td style="padding:6px 8px;white-space:nowrap;color:var(--text-muted);">${new Date(l.criado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
    }

    // ── Relatórios diários ────────────────────────────────────
    function renderRelatorios() {
      return `<div class="card" style="padding:20px 22px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:4px;">🗞️ Relatórios diários</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;">Gerado automaticamente todo dia às 07:00, sobre o dia anterior.</div>
        ${!state.relatorios.length ? `<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:13px;">Nenhum relatório ainda — sai amanhã de manhã se o piloto estiver ativo hoje.</div>` : `
        <div style="display:flex;flex-direction:column;gap:10px;max-height:420px;overflow-y:auto;">
          ${state.relatorios.map((r, i) => `
            <details ${i === 0 ? 'open' : ''} style="border:1px solid var(--border);border-radius:10px;padding:10px 14px;">
              <summary style="cursor:pointer;font-size:13px;font-weight:600;">${new Date(r.data + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })} — ${esc(r.cliente_nome || r.conta_id)}</summary>
              <div style="font-size:12.5px;color:var(--text-secondary);margin-top:8px;line-height:1.6;white-space:pre-wrap;">${nl2br(r.resumo)}</div>
            </details>`).join('')}
        </div>`}
      </div>`;
    }

    // ── Chat ───────────────────────────────────────────────────
    function renderDadosAoVivoResumo() {
      const d = state.dadosAoVivo;
      const linha = state.carregandoDadosAoVivo ? '⏳ atualizando dados da Shopee (últimos 7 dias)...'
        : !state.config?.conta_id ? 'Configure e salve uma conta piloto pra puxar dados ao vivo.'
        : d?.erro ? `⚠️ erro ao buscar dados: ${esc(d.erro)}`
        : d ? `${d.campanhasAtivas} campanha(s) ativa(s) · faturamento total ${R$(d.faturamentoTotal)} · investimento ADS ${R$(d.gastoTotal)} · TACOS ${d.tacosGeral === Infinity ? '∞' : d.tacosGeral.toFixed(1) + '%'} (últimos 7 dias, ${new Date(d.atualizadoEm).toLocaleTimeString('pt-BR')})${d.avisoParcial ? ` ⚠️ ${esc(d.avisoParcial)}` : ''}`
        : 'Nenhum dado carregado ainda.';
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--bg-card-hover,#f7f7fb);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:11.5px;color:var(--text-muted);">
        <span>${linha}</span>
        <button class="btn btn-secondary btn-sm" style="white-space:nowrap;" ${state.carregandoDadosAoVivo ? 'disabled' : ''} onclick="window._agAtualizarDados()">🔄 Atualizar</button>
      </div>`;
    }

    function renderChat() {
      return `<div class="card" style="padding:20px 22px;display:flex;flex-direction:column;height:560px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:10px;">💬 Conversar com o agente</div>
        ${renderDadosAoVivoResumo()}
        <div id="ag-chat-msgs" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding-right:4px;">
          ${!state.chatMessages.length ? `<div style="text-align:center;color:var(--text-muted);font-size:12.5px;padding:30px 10px;">Pergunte sobre as decisões recentes, o desempenho da conta piloto, ou peça pra explicar por que pausou/ajustou alguma campanha.</div>` : ''}
          ${state.chatMessages.map(m => `
            <div style="display:flex;justify-content:${m.role === 'user' ? 'flex-end' : 'flex-start'};">
              <div style="max-width:88%;background:${m.role === 'user' ? '#6366f1' : 'var(--bg-card-hover,#f1f1f5)'};color:${m.role === 'user' ? '#fff' : 'var(--text-primary)'};border-radius:12px;padding:10px 14px;font-size:13px;line-height:1.55;white-space:pre-wrap;">${nl2br(m.content)}</div>
            </div>`).join('')}
          ${state.chatEnviando ? `<div style="font-size:12px;color:var(--text-muted);">⏳ o agente está respondendo...</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <input type="text" class="form-input" id="ag-chat-input" placeholder="Ex: por que pausou a campanha X ontem?" style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();window._agEnviarChat();}">
          <button class="btn btn-primary" ${state.chatEnviando ? 'disabled' : ''} onclick="window._agEnviarChat()">Enviar</button>
        </div>
      </div>`;
    }

    // ── Shell ────────────────────────────────────────────────
    function renderShell() {
      const root = document.getElementById('ag-root');
      if (!root) return;
      if (state.carregando) {
        root.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-muted);">⏳ Carregando agente...</div>`;
        return;
      }
      root.innerHTML = `
        ${renderCards()}
        ${renderDecisoesRecentes()}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;" class="ag-grid-resp">
          <div>
            ${renderConfig()}
            ${renderRelatorios()}
          </div>
          <div>
            ${renderChat()}
          </div>
        </div>
        ${renderLog()}
      `;
    }

    el.innerHTML = `<div class="page">
      <div class="section-title mb-16">🤖 Agente Autônomo de ADS</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;max-width:700px;">
        Modo piloto — 1 conta Shopee por vez. O agente revisa as campanhas todo dia às 07:00, decide pausar/retomar/ajustar orçamento sozinho dentro das regras abaixo, registra tudo no log e escreve um relatório diário sobre o dia anterior. Mudanças de orçamento acima do limite de alerta esperam aprovação manual.
      </div>
      <div id="ag-root"></div>
      <style>@media (max-width:980px){.ag-grid-resp{grid-template-columns:1fr !important;}}</style>
    </div>`;

    window._agSalvarConfig = salvarConfig;
    window._agEnviarChat = enviarChat;
    window._agFiltrarLog = (t) => { state.filtroLog = t; render(); };
    window._agAtualizarDados = buscarDadosAoVivo;

    render();
    carregarTudo();
  }

  if (typeof Router !== 'undefined') {
    Router.register('agente', renderPage);
  }

})();
