// ============================================================
// GLR Consultoria — Agente Autônomo de ADS (Central de Comando)
// Portfólio de contas Shopee com piloto configurado (o cron em
// api/agente-cron.js roda 1x/dia às 07:00 BRT em TODAS as contas ativas,
// avalia as campanhas contra as metas daqui e executa pausar/retomar/
// ajustar orçamento sozinho), com fila de atenção (só o que precisa de
// humano), saúde do negócio (faturamento + SKUs), log completo, relatórios
// diários e chat.
//
// Mental model: as campanhas de ADS na Shopee/TikTok hoje em dia são,
// majoritariamente, campanhas algorítmicas tipo "GMV Max" — a IA da própria
// plataforma decide onde investir, e o ROAS/meta é um GUARDRAIL que ela
// respeita, não uma alavanca manual por campanha (diferente do modelo antigo
// de Facebook Ads). Por isso a tela é organizada como um cockpit — guardrails
// configuráveis + exceções que pedem julgamento humano — não como uma
// planilha de campanha por campanha.
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
      contasShopee: [], // conexões de marketplace disponíveis (pra onboarding de novo piloto)
      contas: [], // todas as linhas de glr_agente_config (portfólio)
      contaAbertaId: null, // null = portfólio | conta_id | '__novo__'
      logs: [], // todos os logs (todas as contas), filtra por conta na hora de renderizar
      relatorios: [], // todos os relatórios
      chatMessages: [], // {role, content} — escopo: conversa atual (reseta ao trocar de conta)
      chatEnviando: false,
      salvandoConfig: false,
      filtroLog: 'todos',
      dadosAoVivoPorConta: {}, carregandoDadosAoVivo: false,
      negocioPorConta: {}, carregandoNegocio: false, negocioPeriodo: '7',
      executandoAcaoManual: false,
      rodandoAgente: false, resultadoRodada: null,
      processandoAlertaId: null,
    };

    function render() { renderShell(); }

    function configDaConta(id) { return state.contas.find(c => c.conta_id === id) || null; }

    async function carregarTudo() {
      state.carregando = true;
      render();
      try {
        const [contas, cfgResp, logsResp, relResp] = await Promise.all([
          MarketplaceAPI.listAccounts().catch(() => []),
          _sb.from('glr_agente_config').select('*').order('atualizado_em', { ascending: false }),
          _sb.from('glr_agente_log').select('*').order('criado_em', { ascending: false }).limit(250),
          _sb.from('glr_agente_relatorios').select('*').order('data', { ascending: false }).limit(60),
        ]);
        state.contasShopee = (contas || []).filter(c => (c.marketplace || '').toLowerCase() === 'shopee');
        state.contas = cfgResp.data || [];
        state.logs = logsResp.data || [];
        state.relatorios = relResp.data || [];
        // Só 1 conta configurada (ou nenhuma) → abre direto no detalhe, sem
        // forçar clique extra num portfólio de 1 card só.
        if (state.contaAbertaId == null && state.contas.length <= 1) {
          state.contaAbertaId = state.contas[0]?.conta_id ?? (state.contasShopee.length ? '__novo__' : null);
        }
      } catch (e) {
        console.warn('[Agente] erro ao carregar:', e.message);
      } finally {
        state.carregando = false;
        render();
      }
      const cfgAberta = configDaConta(state.contaAbertaId);
      if (cfgAberta?.conta_id) {
        buscarDadosAoVivo(cfgAberta.conta_id);
        buscarNegocio(cfgAberta.conta_id);
      }
    }

    // Lista TODAS as campanhas individuais de uma loja, com paginação de
    // verdade. A ação "shopee_ads_campaigns" só devolve a primeira leva sem
    // jeito de pedir a próxima — confirmado ao vivo numa conta com 100+
    // campanhas: só voltavam as mais antigas, todas encerradas, enquanto o
    // painel da Shopee mostrava campanhas recentes ativas com milhares de
    // reais investidos. Endpoint raw certo (usado pelo SDK oficial como
    // getProductLevelCampaignIdList): /api/v2/ads/get_product_level_campaign_id_list,
    // que aceita offset/limit e devolve has_next_page de verdade.
    async function listarTodasCampanhasShopee(shopId) {
      // Base confiável: shopee_ads_campaigns é a ação original, que sempre
      // funcionou (confirmado ao vivo: instantânea, sem erro, cobre contas
      // com até ~100 campanhas numa chamada só). "raw_read" só complementa
      // contas maiores, best-effort — nunca é o único jeito de listar.
      let campanhas = [];
      let hasNextPage = false;
      try {
        const base = await MarketplaceAPI.call('shopee_ads_campaigns', { shopId });
        campanhas = base.data?.response?.campaign_list || base.response?.campaign_list || [];
        hasNextPage = base.data?.response?.has_next_page ?? base.response?.has_next_page ?? false;
      } catch (e) { throw e; }
      if (!hasNextPage) return campanhas;

      const vistos = new Set(campanhas.map(c => c.campaign_id));
      let offset = 100;
      const limit = 100;
      for (let pagina = 0; pagina < 20; pagina++) { // teto de 2000 campanhas
        let json;
        for (let tentativa = 0; tentativa < 2 && !json; tentativa++) {
          try {
            json = await MarketplaceAPI.call('raw_read', {
              marketplace: 'shopee', shopId,
              path: `/api/v2/ads/get_product_level_campaign_id_list?ad_type=all&offset=${offset}&limit=${limit}`,
            });
          } catch (e) { /* tenta mais uma vez, ou desiste e fica com a base */ }
        }
        if (!json) break;
        const lista = json.data?.response?.campaign_list || json.response?.campaign_list || [];
        for (const c of lista) { if (!vistos.has(c.campaign_id)) { vistos.add(c.campaign_id); campanhas.push(c); } }
        const temMais = json.data?.response?.has_next_page ?? json.response?.has_next_page;
        if (!temMais || !lista.length) break;
        offset += limit;
      }
      return campanhas;
    }

    // Converte um timestamp unix (segundos) pro formato "AAAA-MM-DD HH:MM:SS"
    // em horário de Brasília — formato que shopee_sales_summary espera no
    // end_date quando a gente continua uma busca parcial (continuar_de).
    function brtDatetimeDe(unixSegundos) {
      const d = new Date(unixSegundos * 1000 - 3 * 3600 * 1000);
      const pad = n => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    }

    // Faturamento de um período/status, com paginação de verdade. Confirmado
    // ao vivo: um período de só 27 dias já veio com parcial=true (800 de
    // 1229 pedidos somados) — usar só o 1º total_revenue sem continuar a
    // paginação SUBESTIMA o faturamento real, crítico porque TACOS e Saúde
    // do Negócio se baseiam nesse número. Continua chamando com
    // end_date=continuar_de até parcial=false, somando (janelas disjuntas,
    // nunca conta o mesmo pedido 2x).
    async function shopeeFaturamentoPeriodo(shopId, startDate, endDate, orderStatus) {
      let total = 0;
      let end = endDate;
      for (let i = 0; i < 40; i++) { // teto de segurança
        // A falha aqui NÃO é sempre um erro de rede (isso o try/catch já
        // pegava) — confirmado ao vivo que às vezes a chamada "funciona"
        // (sem lançar exceção) mas devolve uma resposta sem total_orders,
        // como se não tivesse pedido nenhum, quando na verdade tem centenas.
        // Um total_revenue "limpo" de R$0 sem total_orders é sinal de
        // resposta incompleta, não de status realmente vazio — trata como
        // falha e tenta de novo (até 3 tentativas no total).
        let r, ultimoErro;
        for (let tentativa = 0; tentativa < 3; tentativa++) {
          try {
            r = await MarketplaceAPI.call('shopee_sales_summary', { shopId, start_date: startDate, end_date: end, order_status: orderStatus });
            const d = r.data || r || {};
            if (d.total_orders != null) break; // resposta bem formada, aceita
            ultimoErro = new Error('resposta sem total_orders (provável falha silenciosa da API)');
            r = null;
          } catch (e) {
            ultimoErro = e;
            r = null;
          }
        }
        if (!r) throw ultimoErro || new Error(`Não consegui buscar ${orderStatus} depois de 3 tentativas`);
        total += parseFloat(r.data?.total_revenue ?? r.total_revenue) || 0;
        const parcial = r.data?.parcial ?? r.parcial;
        const continuarDe = r.data?.continuar_de ?? r.continuar_de;
        if (!parcial || !continuarDe) break;
        end = brtDatetimeDe(continuarDe);
      }
      return total;
    }

    function dataLocal(diasAtras) {
      const d = new Date(); d.setDate(d.getDate() - diasAtras);
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
    }
    function dataISO(diasAtras) {
      const d = new Date(); d.setDate(d.getDate() - diasAtras);
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    // ── Dados ao vivo da Shopee (últimos 7 dias) — pro chat e pra fila
    // terem número de verdade mesmo antes do cron rodar pela 1ª vez ──
    async function buscarDadosAoVivo(contaId) {
      if (!contaId || contaId === '__novo__') return;
      state.carregandoDadosAoVivo = true;
      render();
      try {
        const shopId = contaId;
        const campanhas = await listarTodasCampanhasShopee(shopId);
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
          (settingsResp?.data?.response?.campaign_list || settingsResp?.response?.campaign_list || []).forEach(c => { settingsPorId[c.campaign_id] = { ...(c.common_info || {}), roas_target: c.auto_bidding_info?.roas_target ?? null }; });
          (diarioResp?.data?.response?.campaign_list || diarioResp?.response?.campaign_list || []).forEach(c => {
            const dias = c.metrics_list || [];
            diarioPorId[c.campaign_id] = {
              gasto: dias.reduce((s, d) => s + (parseFloat(d.expense) || 0), 0),
              gmv: dias.reduce((s, d) => s + (parseFloat(d.broad_gmv) || 0), 0),
              pedidos: dias.reduce((s, d) => s + (parseInt(d.broad_order) || 0), 0),
            };
          });
        }
        // Os totais de gasto/GMV da conta NÃO vêm mais dessa lista de
        // campanhas — shopee_ads_campaigns só lista ad_type=manual e, numa
        // conta com campanhas ativas em modo "GMV Max - Meta de ROAS" (um
        // bidding automático dentro de campanha individual), devolveu só
        // campanhas antigas encerradas, 0 investimento, enquanto o painel da
        // Shopee mostrava milhares de reais ativos. Essa lista aqui só serve
        // pra popular a tabela "Campanhas ao vivo" (o que dá pra ver), e
        // "pedidosTotal"/"ativas" ficam limitados ao que ela enxerga — os
        // totais de verdade (gastoTotal/gmvTotal/tacosGeral) são calculados
        // depois, com shopee_ads_daily_performance.
        let pedidosTotal = 0, ativas = 0;
        const porCampanha = [];
        campanhas.forEach(c => {
          const s = settingsPorId[c.campaign_id], d = diarioPorId[c.campaign_id];
          if (!s || !d) return;
          if (d.gasto <= 0 && d.gmv <= 0) return; // sem atividade na janela, ignora
          pedidosTotal += d.pedidos;
          if ((s.campaign_status || '').toLowerCase() === 'ongoing') ativas++;
          const acos = d.gmv > 0 ? (d.gasto / d.gmv * 100) : (d.gasto > 0 ? Infinity : 0);
          porCampanha.push({ id: c.campaign_id, nome: s.ad_name || `Campanha ${c.campaign_id}`, budget: parseFloat(s.campaign_budget) || 0, roasTarget: s.roas_target, gasto: d.gasto, gmv: d.gmv, acos, status: s.campaign_status });
        });
        porCampanha.sort((a, b) => b.gasto - a.gasto);

        let resultado;
        // Se as chamadas de métrica falharam em todos os lotes (ex: instabilidade
        // da API da Shopee/Tiops), "0 campanhas ativas" seria enganoso — parece
        // "conta sem campanha" quando na verdade é "não consegui buscar agora".
        if (campanhas.length > 0 && falhasSettings >= lotes && falhasDiario >= lotes) {
          resultado = { erro: `Não consegui buscar métricas das ${campanhas.length} campanhas agora. Erro real: "${ultimoErro || 'desconhecido'}". Tente "Atualizar" de novo em alguns minutos.` };
        } else {
          // Faturamento TOTAL da loja (não só o atribuído ao ADS) — base do TACOS,
          // que é a métrica que a GLR usa de verdade pra julgar a conta, não ACOS
          // isolado de campanha. Inclui CANCELLED de propósito: é bruto (pedidos
          // realizados), igual ao "Gestor Seller" que a GLR usa pra comparar —
          // confirmado ao vivo que sem CANCELLED o número ficava ~40% menor que
          // o valor real de referência.
          let faturamentoTotal = 0;
          for (const st of ['COMPLETED', 'READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'CANCELLED']) {
            try {
              faturamentoTotal += await shopeeFaturamentoPeriodo(shopId, dataISO(6), dataISO(0), st);
            } catch (e) {}
          }
          // Gasto/GMV de ADS: performance diária da loja inteira (campanhas
          // individuais, inclusive modo GMV Max por produto). Escopo do
          // agente é só campanhas individuais — GMV Max da Loja fica de fora
          // (o agente nunca conseguia agir nele mesmo, só gerava alerta).
          let gastoTotal = 0, gmvTotal = 0;
          try {
            const perfDiario = await MarketplaceAPI.call('shopee_ads_daily_performance', { shopId, start_date: seteDiasAtras, end_date: hoje });
            const diasPerf = perfDiario.data?.response || perfDiario.response || [];
            diasPerf.forEach(d => { gastoTotal += parseFloat(d.expense) || 0; gmvTotal += parseFloat(d.broad_gmv) || 0; });
          } catch (e) {}
          const tacosGeral = faturamentoTotal > 0 ? (gastoTotal / faturamentoTotal * 100) : (gastoTotal > 0 ? Infinity : 0);
          resultado = {
            atualizadoEm: new Date().toISOString(),
            campanhasAtivas: ativas, gastoTotal, gmvTotal, pedidosTotal, faturamentoTotal, tacosGeral,
            acosGeral: gmvTotal > 0 ? (gastoTotal / gmvTotal * 100) : (gastoTotal > 0 ? Infinity : 0),
            topCampanhas: porCampanha.slice(0, 8),
            avisoParcial: (falhasSettings > 0 || falhasDiario > 0) ? 'Algumas campanhas podem estar faltando — houve falha parcial ao buscar dados da Shopee.' : null,
          };
        }
        state.dadosAoVivoPorConta[shopId] = resultado;
      } catch (e) {
        state.dadosAoVivoPorConta[contaId] = { erro: e.message || String(e) };
      } finally {
        state.carregandoDadosAoVivo = false;
        render();
      }
    }

    // ── Saúde do negócio: faturamento desta semana vs semana anterior.
    // SKU a SKU (produtos em alta/queda) não entra aqui — isso já existe,
    // com o motor certo (varredura de pedidos semana a semana), na aba
    // Analytics → Produtos em Queda; reconstruir esse motor aqui seria
    // duplicar trabalho e arriscar divergir do número que já é usado hoje.
    // Aqui a gente só linka pra lá, filtrado nesta conta. ──
    function isoDe(d) {
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    // Janela do período atual + período anterior de igual tamanho, pra
    // comparação de faturamento. "mes" compara o mês corrente (dia 1 até
    // hoje) com o mesmo intervalo de dias do mês anterior (comparação justa,
    // não o mês anterior inteiro).
    function janelasNegocio(periodo) {
      const hoje = new Date();
      if (periodo === 'mes') {
        const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
        const inicioMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
        const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, hoje.getDate());
        return { atualDe: isoDe(inicioMes), atualAte: isoDe(hoje), anteriorDe: isoDe(inicioMesAnterior), anteriorAte: isoDe(fimMesAnterior) };
      }
      const n = parseInt(periodo, 10) || 7;
      return { atualDe: dataISO(n - 1), atualAte: dataISO(0), anteriorDe: dataISO(2 * n - 1), anteriorAte: dataISO(n) };
    }

    async function buscarNegocio(contaId, periodo) {
      if (!contaId || contaId === '__novo__') return;
      periodo = periodo || state.negocioPeriodo;
      state.carregandoNegocio = true;
      render();
      try {
        const shopId = contaId;
        // Se algum status falhar mesmo depois do retry, NÃO mostra um número
        // limpo como se fosse completo — isso é o próprio bug que o analista
        // reportou (faturamento pela metade, sem aviso nenhum). Marca
        // "incompleto" e mostra na tela, em vez de engolir o erro.
        // Sequencial, NUNCA em paralelo — confirmado ao vivo (comparando com
        // buscarDadosAoVivo, que já era sequencial e nunca deu esse bug) que
        // disparar as 3 chamadas de status ao mesmo tempo via Promise.all faz
        // o conector devolver dado incompleto pra 2 delas (sem erro, sem
        // sinalizar nada — só um total_revenue menor). Mais lento, mas o
        // único jeito confirmado de pegar o valor certo.
        const somaPeriodo = async (inicioISO, fimISO) => {
          let total = 0, statusFalhou = [];
          for (const st of ['COMPLETED', 'READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'CANCELLED']) {
            try {
              total += await shopeeFaturamentoPeriodo(shopId, inicioISO, fimISO, st);
            } catch (e) { statusFalhou.push(st); }
          }
          return { total, statusFalhou };
        };
        const janelas = janelasNegocio(periodo);
        const atual = await somaPeriodo(janelas.atualDe, janelas.atualAte);
        const anterior = await somaPeriodo(janelas.anteriorDe, janelas.anteriorAte);
        const semanaAtual = atual.total, semanaAnterior = anterior.total;
        const falhas = [...atual.statusFalhou, ...anterior.statusFalhou];
        const variacaoPct = semanaAnterior > 0 ? ((semanaAtual - semanaAnterior) / semanaAnterior) * 100 : (semanaAtual > 0 ? Infinity : 0);
        state.negocioPorConta[contaId + ':' + periodo] = {
          semanaAtual, semanaAnterior, variacaoPct, atualizadoEm: new Date().toISOString(),
          incompleto: falhas.length > 0,
          avisoIncompleto: falhas.length ? `Não consegui buscar ${[...new Set(falhas)].join(', ')} mesmo com retry — o valor acima está SUBESTIMADO. Clique em Atualizar pra tentar de novo.` : null,
        };
      } catch (e) {
        state.negocioPorConta[contaId + ':' + periodo] = { erro: e.message || String(e) };
      } finally {
        state.carregandoNegocio = false;
        render();
      }
    }

    function nomeConta(c) {
      const tag = c.tags?.[0]?.name || c.tags?.[0];
      return (typeof tag === 'string' ? tag : tag?.value) || c.nickname || c.external_id;
    }

    // Tenta achar o cliente da Carteira vinculado a essa conta de marketplace
    // (glr_mc_vinculos: { [clienteId]: [{external_id, marketplace, nickname}] }
    // já usado pelo resto do app) — se achar, usa o nome oficial do cliente em
    // vez do nickname digitado à mão.
    function clienteVinculado(contaId) {
      try {
        const vinculos = JSON.parse(localStorage.getItem('glr_mc_vinculos') || '{}');
        for (const clienteId of Object.keys(vinculos)) {
          const lista = vinculos[clienteId] || [];
          if (lista.some(v => String(v.external_id) === String(contaId) && (v.marketplace || '').toLowerCase() === 'shopee')) {
            const cliente = (typeof GLR !== 'undefined' ? GLR.clientes : []).find(c => String(c.id) === String(clienteId));
            return { cliente_id: clienteId, cliente_nome: cliente?.nome || null };
          }
        }
      } catch (e) {}
      return { cliente_id: null, cliente_nome: null };
    }

    // ── Salvar configuração de um piloto (não mexe nos outros — cada conta
    // liga/desliga o piloto de forma independente, o cron já processa todas
    // as ativas em paralelo) ──
    async function salvarConfig() {
      const v = id => document.getElementById(id)?.value;
      const contaId = v('ag-conta');
      if (!contaId) { alert('Selecione a conta Shopee que vai virar o piloto.'); return; }
      const contaObj = state.contasShopee.find(c => (c.param_to_use?.shopId || c.external_id) === contaId);
      const ativo = document.getElementById('ag-ativo')?.checked || false;
      const vinculo = clienteVinculado(contaId);

      const row = {
        conta_id: contaId,
        cliente_nome: vinculo.cliente_nome || (contaObj ? nomeConta(contaObj) : contaId),
        cliente_id: vinculo.cliente_id || null,
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
        const { error } = await _sb.from('glr_agente_config').upsert(row, { onConflict: 'conta_id' });
        if (error) throw error;
        await _sb.from('glr_agente_log').insert({
          conta_id: contaId, cliente_nome: row.cliente_nome, tipo: 'sistema',
          titulo: ativo ? 'Piloto ativado' : 'Configuração salva',
          explicacao: `Configuração atualizada pelo analista. Meta TACOS ${row.meta_acos ?? '—'}%, orçamento ${row.orcamento_min ?? '—'}–${row.orcamento_max ?? '—'}, pausa automática acima de ${row.regra_pausa_acos ?? '—'}% ACOS por ${row.regra_pausa_dias} dia(s), maturação mínima de ${row.dias_maturacao_campanha} dia(s).`,
          dados: row, resultado: 'executado', origem: 'analista',
        });
        state.contaAbertaId = contaId;
        await carregarTudo();
      } catch (e) {
        alert('Erro ao salvar configuração: ' + (e.message || e));
      } finally {
        state.salvandoConfig = false;
        render();
      }
    }

    // ── Chat com o agente (escopo: conta aberta) ─────────────────
    function contextoAgente() {
      const cfg = configDaConta(state.contaAbertaId);
      const logsConta = state.logs.filter(l => l.conta_id === state.contaAbertaId).slice(0, 15);
      const logsRecentes = logsConta.map(l =>
        `[${new Date(l.criado_em).toLocaleString('pt-BR')}] ${TIPO_LABEL[l.tipo] || l.tipo} — ${l.titulo}: ${l.explicacao || ''}`
      ).join('\n');
      const ultimoRelatorio = state.relatorios.find(r => r.conta_id === state.contaAbertaId);
      const d = state.dadosAoVivoPorConta[state.contaAbertaId];
      const dadosTexto = !d ? '\nDADOS AO VIVO: ainda não carregados.'
        : d.erro ? `\nDADOS AO VIVO: erro ao buscar (${d.erro})`
        : `\nDADOS AO VIVO DA SHOPEE (últimos 7 dias, atualizado ${new Date(d.atualizadoEm).toLocaleTimeString('pt-BR')}):\nFaturamento TOTAL da loja: ${R$(d.faturamentoTotal)} | Investimento ADS: ${R$(d.gastoTotal)} | TACOS da conta: ${d.tacosGeral === Infinity ? '∞' : d.tacosGeral.toFixed(1) + '%'} (esta é a métrica principal, não o ACOS isolado abaixo)\nCampanhas ativas: ${d.campanhasAtivas} | Vendas atribuídas ao ADS: ${R$(d.gmvTotal)} | Pedidos atribuídos: ${d.pedidosTotal} | ACOS médio das campanhas: ${d.acosGeral === Infinity ? '∞ (gastou sem vender nada)' : d.acosGeral.toFixed(1) + '%'}\nTop campanhas por investimento (ACOS individual, útil só pra comparar entre elas — use o ID exato ao sugerir mudança):\n${d.topCampanhas.map(c => `- ID ${c.id} — ${(c.nome || '').slice(0, 60)}: orçamento ${R$(c.budget)}${c.roasTarget != null ? `, meta de ROAS atual ${c.roasTarget}x (lance automático)` : ''}, gasto ${R$(c.gasto)}, vendas (GMV) ${R$(c.gmv)}, ACOS ${c.acos === Infinity ? '∞' : c.acos.toFixed(1) + '%'}`).join('\n') || '(nenhuma campanha ativa com dados na janela)'}`;
      const neg = state.negocioPorConta[state.contaAbertaId + ':' + state.negocioPeriodo];
      const negTexto = neg && !neg.erro ? `\nSAÚDE DO NEGÓCIO (período: ${state.negocioPeriodo === 'mes' ? 'mês atual' : state.negocioPeriodo + ' dias'}): faturamento ${R$(neg.semanaAtual)} vs período anterior equivalente ${R$(neg.semanaAnterior)} (${neg.variacaoPct === Infinity ? '∞' : (neg.variacaoPct >= 0 ? '+' : '') + neg.variacaoPct.toFixed(1) + '%'}).` : '';
      return [
        cfg ? `CONFIGURAÇÃO ATUAL DO PILOTO (conta ${cfg.cliente_nome || cfg.conta_id}, ${cfg.ativo ? 'ATIVO' : 'inativo'}):` : 'Nenhuma conta piloto configurada ainda.',
        cfg ? `Meta TACOS: ${cfg.meta_acos ?? '—'}% (métrica principal: investimento ADS ÷ faturamento TOTAL da loja, não ACOS isolado) | Orçamento: ${cfg.orcamento_min ?? '—'} a ${cfg.orcamento_max ?? '—'} | Margem: ${cfg.margem_pct ?? '—'}% | Estoque mínimo: ${cfg.estoque_minimo ?? '—'} | Pausa automática acima de ${cfg.regra_pausa_acos ?? '—'}% ACOS por ${cfg.regra_pausa_dias ?? '—'} dia(s), só após ${cfg.dias_maturacao_campanha ?? 7} dia(s) de maturação da campanha | Alerta humano se variação de orçamento > ${cfg.alerta_variacao_pct ?? '—'}% | Notas: ${cfg.notas || '—'}` : '',
        cfg ? dadosTexto : '',
        cfg ? negTexto : '',
        ultimoRelatorio ? `\nÚLTIMO RELATÓRIO DIÁRIO (${ultimoRelatorio.data}):\n${ultimoRelatorio.resumo}` : '',
        logsRecentes ? `\nÚLTIMAS AÇÕES/EVENTOS REGISTRADOS NO LOG:\n${logsRecentes}` : '',
      ].filter(Boolean).join('\n');
    }

    // Boost de 1 campanha: mesma fórmula da Regra 3 do cron (roas*0.85 com piso
    // 100/meta_acos, ou budget*1.2 com teto orcamento_max) mas disparado na hora
    // pelo analista pra UMA campanha específica, sem depender do ciclo diário
    // nem de ACOS já estar "bem abaixo da meta" — o analista está pedindo de
    // propósito. Cria a sugestão como card no Kanban (mesmo fluxo do chat),
    // nunca executa direto — sempre passa por Aprovar.
    async function boostCampanha(campaignId, nome, budgetAtual, roasAtual, acos) {
      const cfg = configDaConta(state.contaAbertaId);
      if (!cfg?.meta_acos) { alert('Configura a meta de TACOS dessa conta primeiro (seção "Guardrails do piloto") pra eu saber até onde posso ser agressivo.'); return; }
      const usaRoasTarget = (parseFloat(budgetAtual) || 0) === 0 && roasAtual != null;
      let sugestao;
      if (usaRoasTarget) {
        const metaRoasConta = 100 / cfg.meta_acos;
        const novoRoas = Math.round(Math.max(1, metaRoasConta, roasAtual * 0.85) * 10) / 10;
        if (novoRoas >= roasAtual) { alert(`"${nome}" já está no lance mais agressivo permitido pela meta de TACOS da conta (${cfg.meta_acos}%) — não dá pra baixar mais a meta de ROAS sem furar o guardrail.`); return; }
        sugestao = { campaign_id: Number(campaignId), nome_campanha: nome, tipo: 'roas', valor_atual: roasAtual, valor_sugerido: novoRoas, titulo: `Boost solicitado — ${nome}`, explicacao: `Analista pediu boost manual. Baixando meta de ROAS de ${roasAtual}x pra ${novoRoas}x (piso: 100/meta TACOS = ${metaRoasConta.toFixed(1)}x) pra deixar o lance mais agressivo.` };
      } else {
        const budgetNum = parseFloat(budgetAtual) || 0;
        if (budgetNum <= 0) { alert(`"${nome}" não tem orçamento fixo nem meta de ROAS configurada — não dá pra calcular um boost automático. Ajusta manualmente no painel "Avançado".`); return; }
        const novoBudget = Math.round(Math.min(cfg.orcamento_max || Infinity, budgetNum * 1.2) * 100) / 100;
        if (novoBudget <= budgetNum) { alert(`"${nome}" já está no teto de orçamento configurado (${R$(cfg.orcamento_max)}) — não dá pra subir mais sem mudar o guardrail.`); return; }
        sugestao = { campaign_id: Number(campaignId), nome_campanha: nome, tipo: 'orcamento', valor_atual: budgetNum, valor_sugerido: novoBudget, titulo: `Boost solicitado — ${nome}`, explicacao: `Analista pediu boost manual. Subindo orçamento de ${R$(budgetNum)} pra ${R$(novoBudget)} (+20%). ACOS atual: ${acos === Infinity ? '∞' : acos.toFixed(1) + '%'}.` };
      }
      await criarSugestoesNoKanban([sugestao]);
      await carregarTudo();
      alert(`Sugestão de boost criada pra "${nome}" — veja em "Mudanças e resultados", coluna "Aguardando aprovação", pra aprovar.`);
    }

    // Tira o bloco ```json...``` (se houver) da resposta do modelo e devolve
    // a lista de sugestões válidas (campaign_id + tipo reconhecido). Pedidos
    // que não geram ação concreta (pergunta geral, "por que caiu tal coisa")
    // simplesmente não trazem esse bloco — o modelo foi instruído a só usá-lo
    // quando o pedido do analista pedir uma mudança de verdade.
    function extrairSugestoes(texto) {
      const m = texto.match(/```json\s*([\s\S]*?)```/i);
      if (!m) return { sugestoes: [], textoLimpo: texto.trim() };
      let sugestoes = [];
      try {
        const arr = JSON.parse(m[1]);
        sugestoes = Array.isArray(arr) ? arr.filter(s => s && s.campaign_id != null && ['pausar', 'orcamento', 'roas'].includes(s.tipo)) : [];
      } catch (e) { /* JSON malformado — ignora, trata como se não tivesse sugestão */ }
      return { sugestoes, textoLimpo: texto.replace(m[0], '').trim() };
    }

    async function criarSugestoesNoKanban(sugestoes) {
      const cfg = configDaConta(state.contaAbertaId);
      const contaId = state.contaAbertaId;
      for (const s of sugestoes) {
        const dados = { campaign_id: Number(s.campaign_id) };
        if (s.tipo === 'roas') { dados.roas_atual = s.valor_atual; dados.roas_sugerido = s.valor_sugerido; }
        else if (s.tipo === 'orcamento') { dados.budget_atual = s.valor_atual; dados.budget_sugerido = s.valor_sugerido; }
        else if (s.tipo === 'pausar') { dados.pausar = true; }
        try {
          await _sb.from('glr_agente_log').insert({
            conta_id: contaId, cliente_nome: cfg?.cliente_nome || null, tipo: 'alerta',
            titulo: s.titulo || `Sugestão do agente — ${s.nome_campanha || 'campanha ' + s.campaign_id}`,
            explicacao: s.explicacao || '', dados, resultado: 'so_alerta', origem: 'chat',
          });
        } catch (e) { /* uma sugestão falhando não derruba as outras */ }
      }
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
            system: `Você é o Agente Autônomo de ADS da GLR Consultoria. Você mesmo decide pausar campanha, retomar campanha e ajustar orçamento/meta de ROAS diariamente com base nas regras configuradas pelo analista — sem precisar de aprovação manual, exceto quando a variação proposta passa do limite de alerta configurado. A métrica principal pra julgar a saúde da conta é o TACOS (investimento em ADS dividido pelo faturamento TOTAL da loja, não só a venda atribuída ao ADS) — NUNCA trate ACOS isolado de uma campanha como veredito sobre a conta inteira, ele só serve pra comparar campanhas entre si. Campanhas novas (dentro do período de maturação configurado) não são pausadas por ACOS ruim ainda, mesmo que o critério tenha sido tecnicamente atingido — dá tempo delas amadurecerem primeiro. Muitas campanhas individuais hoje em dia (modo GMV Max por produto, lance automático) são geridas pelo algoritmo da própria Shopee/TikTok — o papel do agente aí é ajustar o guardrail (meta de ROAS), não microgerenciar lance por lance. O agente só mexe em campanhas individuais — o GMV Max da Loja (campanha única, guarda-chuva, por conta inteira) está fora do escopo por decisão do analista, não monitorado nem ajustado. Converse em português, direto, como um analista sênior explicando decisões pra outro analista. Use os dados de contexto abaixo (configuração, dados ao vivo, saúde do negócio, último relatório, log recente) pra responder — nunca invente números que não estão aí, nunca invente campaign_id que não apareça na lista "Top campanhas" do contexto.\n\nQUANDO O ANALISTA PEDIR UMA MUDANÇA CONCRETA (ex: "aumenta o investimento", "pausa a campanha X", "sobe a meta de ROAS da campanha Y", "reduz orçamento de Z"): responda com no máximo 2 frases confirmando o que você está sugerindo e por quê, e termine a mensagem com um bloco \`\`\`json contendo um array de sugestões, uma por campanha, no formato exato: [{"campaign_id": <ID numérico exato do contexto>, "nome_campanha": "<nome curto>", "tipo": "pausar"|"orcamento"|"roas", "valor_atual": <número, omita se tipo=pausar>, "valor_sugerido": <número, omita se tipo=pausar>, "titulo": "<título curto pro card, ex: Aumentar orçamento — Nome da campanha>", "explicacao": "<1-2 frases explicando o motivo, com os números que embasam>"}]. Use tipo \"roas\" só pra campanha que already tem \"meta de ROAS atual\" no contexto (lance automático); use \"orcamento\" só pra campanha com orçamento fixo (budget > 0); nunca sugira os dois tipos pra mesma campanha na mesma resposta. NÃO execute nada você mesmo pelo chat — a sugestão vira um card na Fila de Atenção (Kanban) e só é aplicada de verdade quando o analista clicar em \"Aprovar\" ali. Se o pedido for só uma pergunta ou pedir explicação (\"por que caiu tal coisa\", \"como está a conta\"), responda em texto normal e NÃO inclua o bloco \`\`\`json. Se o analista pedir pra mudar uma regra/guardrail (meta TACOS, regra de pausa, etc — não uma campanha específica), explique que isso se edita no painel de configuração da aba, você não altera a config pelo chat.\n\n${contextoAgente()}`,
            messages: state.chatMessages,
          }),
        });
        const json = await resp.json();
        if (json.error) throw new Error(json.error);
        const respostaBruta = json.content || 'Sem resposta.';
        const { sugestoes, textoLimpo } = extrairSugestoes(respostaBruta);
        let resposta = textoLimpo;
        if (sugestoes.length) {
          await criarSugestoesNoKanban(sugestoes);
          resposta = (resposta ? resposta + '\n\n' : '') + `📋 Criei ${sugestoes.length} sugestão${sugestoes.length > 1 ? 'ões' : ''} — veja em "Mudanças e resultados" abaixo, coluna "Aguardando aprovação", pra aprovar ou descartar.`;
        }
        state.chatMessages.push({ role: 'assistant', content: resposta || 'Sem resposta.' });
        try {
          const cfg = configDaConta(state.contaAbertaId);
          await _sb.from('glr_agente_log').insert({
            conta_id: state.contaAbertaId || null, cliente_nome: cfg?.cliente_nome || null,
            tipo: 'chat', titulo: 'Conversa com o analista', explicacao: `Pergunta: ${texto}\n\nResposta: ${respostaBruta}`,
            dados: {}, resultado: 'executado', origem: 'analista',
          });
        } catch (e) {}
        if (sugestoes.length) await carregarTudo();
      } catch (e) {
        state.chatMessages.push({ role: 'assistant', content: '⚠️ Erro ao falar com o agente: ' + (e.message || e) });
      } finally {
        state.chatEnviando = false;
        render();
        const msgs = document.getElementById('ag-chat-msgs');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      }
    }

    // ── Semáforo de saúde de uma conta: 🔴 alerta pendente há >2 dias OU
    // TACOS > meta×1.3 | 🟡 TACOS > meta OU qualquer alerta pendente | 🟢 ok ──
    function saudeDaConta(cfg) {
      const relatorio = state.relatorios.find(r => r.conta_id === cfg.conta_id);
      const tacos = relatorio?.metricas?.tacos_conta;
      const alertas = state.logs.filter(l => l.conta_id === cfg.conta_id && l.tipo === 'alerta' && l.resultado === 'so_alerta');
      const doisDiasAtras = Date.now() - 2 * 24 * 3600 * 1000;
      const alertaVelho = alertas.some(a => new Date(a.criado_em).getTime() < doisDiasAtras);
      const tacosMuitoAcima = cfg.meta_acos && tacos != null && tacos > cfg.meta_acos * 1.3;
      const tacosAcima = cfg.meta_acos && tacos != null && tacos > cfg.meta_acos;
      if (alertaVelho || tacosMuitoAcima) return { cor: '#dc2626', emoji: '🔴', label: 'Precisa de atenção' };
      if (alertas.length || tacosAcima) return { cor: '#d97706', emoji: '🟡', label: 'Vale um olhar' };
      return { cor: '#16a34a', emoji: '🟢', label: 'Saudável' };
    }

    // ── Portfólio (grid de contas) ─────────────────────────────
    function renderPortfolio() {
      return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">
        ${state.contas.map(cfg => {
          const saude = saudeDaConta(cfg);
          const relatorio = state.relatorios.find(r => r.conta_id === cfg.conta_id);
          const tacos = relatorio?.metricas?.tacos_conta;
          const pendencias = state.logs.filter(l => l.conta_id === cfg.conta_id && l.tipo === 'alerta' && l.resultado === 'so_alerta').length;
          return `<div class="ag-hud-card" style="--ag-hud-accent:${saude.cor};cursor:pointer;" onclick="window._agAbrirConta('${esc(cfg.conta_id)}')">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
              <div>
                <div style="font-size:15px;font-weight:800;">${esc(cfg.cliente_nome || cfg.conta_id)}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Shopee · ${cfg.ativo ? 'piloto ativo' : 'piloto pausado'}</div>
              </div>
              <span style="font-size:20px;line-height:1;" title="${saude.label}">${saude.emoji}</span>
            </div>
            <div style="display:flex;gap:18px;margin-top:14px;">
              <div><div class="ag-hud-label" style="margin-bottom:2px;">TACOS</div><div class="ag-mono" style="font-size:18px;font-weight:800;">${tacos != null ? tacos.toFixed(1) + '%' : '—'}</div></div>
              <div><div class="ag-hud-label" style="margin-bottom:2px;">Fila</div><div class="ag-mono" style="font-size:18px;font-weight:800;color:${pendencias ? '#d97706' : 'inherit'};">${pendencias}</div></div>
            </div>
          </div>`;
        }).join('')}
        <div class="ag-hud-card" style="--ag-hud-accent:#64748b;cursor:pointer;border-style:dashed;display:flex;align-items:center;justify-content:center;min-height:110px;" onclick="window._agAbrirConta('__novo__')">
          <div style="text-align:center;color:var(--text-muted);font-size:13px;font-weight:600;">+ Adicionar conta</div>
        </div>
      </div>`;
    }

    // ── Saúde da conta aberta (card único no topo do detalhe) ──
    function renderSaudeHero(cfg) {
      const saude = saudeDaConta(cfg);
      const relatorio = state.relatorios.find(r => r.conta_id === cfg.conta_id);
      const tacos = relatorio?.metricas?.tacos_conta;
      const seteDiasAtras = Date.now() - 7 * 24 * 3600 * 1000;
      const decisoesSemana = state.logs.filter(l => l.conta_id === cfg.conta_id && l.tipo === 'decisao' && l.resultado === 'executado' && new Date(l.criado_em).getTime() > seteDiasAtras).length;
      const pendencias = state.logs.filter(l => l.conta_id === cfg.conta_id && l.tipo === 'alerta' && l.resultado === 'so_alerta').length;
      const frase = pendencias ? `${pendencias} ${pendencias === 1 ? 'item pedindo' : 'itens pedindo'} sua atenção` : 'Nada pedindo aprovação agora — tudo dentro do combinado';
      return `<div class="ag-hud-card" style="--ag-hud-accent:${saude.cor};margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px;">
          <div style="display:flex;align-items:center;gap:14px;">
            <span style="font-size:34px;line-height:1;">${saude.emoji}</span>
            <div>
              <div style="font-size:17px;font-weight:800;">${esc(cfg.cliente_nome || cfg.conta_id)}</div>
              <div style="font-size:12.5px;color:var(--text-muted);margin-top:2px;">${saude.label} · ${esc(frase)}</div>
            </div>
          </div>
          <div style="display:flex;gap:26px;">
            <div><div class="ag-hud-label" style="margin-bottom:2px;">TACOS</div><div class="ag-mono" style="font-size:22px;font-weight:800;">${tacos != null ? tacos.toFixed(1) + '%' : '—'}</div><div class="ag-hud-sub">meta ${cfg.meta_acos ?? '—'}%</div></div>
            <div><div class="ag-hud-label" style="margin-bottom:2px;">Decisões 7d</div><div class="ag-mono" style="font-size:22px;font-weight:800;">${decisoesSemana}</div><div class="ag-hud-sub">automáticas</div></div>
            <div><div class="ag-hud-label" style="margin-bottom:2px;">Piloto</div><div class="ag-mono" style="font-size:22px;font-weight:800;color:${cfg.ativo ? '#22d3ee' : '#64748b'};">${cfg.ativo ? 'ON' : 'OFF'}</div></div>
          </div>
        </div>
      </div>`;
    }

    // ── Rodar o agente agora: dispara o MESMO ciclo do cron (listar
    // campanhas, avaliar contra os guardrails, decidir e agir) pra essa
    // conta na hora, sem esperar as 07:00. Pedido do usuário: quer a
    // execução do agente de verdade (a análise que já foi montada), não
    // mexer campanha por campanha na mão. ──
    async function rodarAgenteAgora() {
      const contaId = state.contaAbertaId;
      if (!contaId) return;
      state.rodandoAgente = true;
      state.resultadoRodada = null;
      render();
      try {
        const resp = await fetch(`/api/agente-cron?conta_id=${encodeURIComponent(contaId)}`);
        const json = await resp.json();
        const r = json.resultados?.[0];
        if (json.skip) {
          state.resultadoRodada = { erro: json.skip };
        } else if (r?.erro) {
          state.resultadoRodada = { erro: r.erro };
        } else if (r) {
          state.resultadoRodada = {
            ok: true,
            campanhas: r.campanhas ?? 0, campanhasListadas: r.campanhas_listadas ?? r.campanhas ?? 0,
            decisoes: r.decisoes ?? 0, alertas: r.alertas ?? 0,
            tacos: r.tacos_conta != null ? r.tacos_conta.toFixed(1) + '%' : '—',
            paginacaoErro: r.paginacaoErro || null,
          };
        } else {
          state.resultadoRodada = { erro: 'Resposta inesperada do servidor.' };
        }
        await carregarTudo();
      } catch (e) {
        state.resultadoRodada = { erro: e.message || String(e) };
      } finally {
        state.rodandoAgente = false;
        render();
      }
    }

    function renderRodarAgente(contaId) {
      const r = state.resultadoRodada;
      return `<div class="ag-hud-card" style="--ag-hud-accent:#22d3ee;margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
          <div>
            <div style="font-size:14px;font-weight:800;margin-bottom:2px;">🚀 Rodar o agente agora</div>
            <div style="font-size:11.5px;color:var(--text-muted);">Dispara o mesmo ciclo do cron das 07:00 nesta conta agora: lista campanhas, avalia contra os guardrails configurados abaixo, e age (pausa/ajusta) sozinho.</div>
          </div>
          <button class="btn btn-primary" style="white-space:nowrap;" ${state.rodandoAgente ? 'disabled' : ''} onclick="window._agRodarAgora()">
            ${state.rodandoAgente ? '⏳ Rodando...' : '🚀 Rodar agora'}
          </button>
        </div>
        ${r ? (r.erro
          ? `<div style="margin-top:12px;background:#dc26261a;border:1px solid #dc2626;border-radius:8px;padding:10px 14px;font-size:12.5px;color:#dc2626;">⚠️ ${esc(r.erro)}</div>`
          : `<div style="margin-top:12px;display:flex;gap:24px;flex-wrap:wrap;">
              <div><div class="ag-hud-label" style="margin-bottom:2px;">Campanhas ativas</div><div class="ag-mono" style="font-size:18px;font-weight:800;">${r.campanhas}</div>${r.campanhasListadas > r.campanhas ? `<div class="ag-hud-sub">de ${r.campanhasListadas} listadas (resto é histórico antigo)</div>` : ''}</div>
              <div><div class="ag-hud-label" style="margin-bottom:2px;">Decisões</div><div class="ag-mono" style="font-size:18px;font-weight:800;color:#16a34a;">${r.decisoes}</div></div>
              <div><div class="ag-hud-label" style="margin-bottom:2px;">Alertas</div><div class="ag-mono" style="font-size:18px;font-weight:800;color:${r.alertas ? '#d97706' : 'inherit'};">${r.alertas}</div></div>
              <div><div class="ag-hud-label" style="margin-bottom:2px;">TACOS</div><div class="ag-mono" style="font-size:18px;font-weight:800;">${r.tacos}</div></div>
            </div>${r.paginacaoErro ? `<div style="margin-top:10px;background:#d977061a;border:1px solid #d97706;border-radius:8px;padding:8px 12px;font-size:11.5px;color:#d97706;">⚠️ A Shopee/Tiops recusou parte da paginação (${esc(r.paginacaoErro)}) — pode ter campanha ativa fora dessa lista. Chamado aberto com o suporte do Tiops, aguardando resposta.</div>` : ''}`) : ''}
      </div>`;
    }

    // ── Ação manual: executa direto na Shopee (pausar/orçamento/meta de
    // ROAS) sem depender da listagem automática de campanhas — usa as
    // mesmas ações já validadas ao vivo (shopee_ads_edit_campaign,
    // shopee_ads_roi_target, shopee_ads_pause_campaign). Pedido do usuário
    // pra ter um jeito de agir mesmo quando o pipeline automático (que
    // depende de listar campanhas primeiro) está bloqueado pela
    // instabilidade do conector. ──
    async function executarAcaoManual() {
      const contaId = state.contaAbertaId;
      const cfg = configDaConta(contaId);
      const v = id => document.getElementById(id)?.value?.trim();
      const campaignId = v('ag-man-campanha');
      const nome = v('ag-man-nome') || `Campanha ${campaignId}`;
      const tipo = v('ag-man-tipo');
      const valor = parseFloat(v('ag-man-valor'));
      const explicacaoInput = v('ag-man-explicacao');

      if (!campaignId) { alert('Cola o ID da campanha (aparece na tabela "Campanhas ao vivo", coluna ID).'); return; }
      if (tipo !== 'pausar' && (isNaN(valor) || valor <= 0)) { alert('Preenche o valor novo (orçamento ou meta de ROAS).'); return; }

      const acaoLabel = { orcamento: 'Orçamento ajustado manualmente', roas: 'Meta de ROAS ajustada manualmente', pausar: 'Campanha pausada manualmente' }[tipo];
      const explicacao = explicacaoInput || `Ação manual do analista via botão "Executar agora" — bypassa a listagem automática de campanhas.`;

      state.executandoAcaoManual = true;
      render();
      try {
        let dados = {};
        if (tipo === 'orcamento') {
          // shopee_ads_edit_campaign é passthrough cru — exige params.edit_action
          // ="change_budget", params.budget (não campaign_budget) e um
          // params.reference_id único, confirmado ao vivo (sem isso a Shopee
          // rejeita com "Invalid param type" / "EditAction is required").
          await MarketplaceAPI.call('shopee_ads_edit_campaign', {
            shopId: contaId,
            params: {
              campaign_id: Number(campaignId),
              budget: valor,
              edit_action: 'change_budget',
              reference_id: `glr-manual-${Date.now()}-${campaignId}`,
            },
          });
          dados = { budget_para: valor };
        } else if (tipo === 'roas') {
          await MarketplaceAPI.call('shopee_ads_roi_target', { shopId: contaId, campaign_id: Number(campaignId), roas_target: valor });
          dados = { roas_para: valor };
        } else if (tipo === 'pausar') {
          await MarketplaceAPI.call('shopee_ads_pause_campaign', { shopId: contaId, campaign_id: Number(campaignId) });
        }
        await _sb.from('glr_agente_log').insert({
          conta_id: contaId, cliente_nome: cfg?.cliente_nome || null, tipo: 'decisao',
          titulo: `${acaoLabel} — ${nome}`, explicacao, dados: { ...dados, campaign_id: Number(campaignId) },
          resultado: 'executado', origem: 'analista',
        });
        document.getElementById('ag-man-campanha').value = '';
        document.getElementById('ag-man-nome').value = '';
        document.getElementById('ag-man-valor').value = '';
        document.getElementById('ag-man-explicacao').value = '';
        await carregarTudo();
      } catch (e) {
        try {
          await _sb.from('glr_agente_log').insert({
            conta_id: contaId, cliente_nome: cfg?.cliente_nome || null, tipo: 'decisao',
            titulo: `Falha ao executar manualmente — ${nome}`, explicacao: `Tentei: ${explicacao} — mas deu erro: ${e.message || e}`,
            dados: { campaign_id: Number(campaignId) || null }, resultado: 'erro', origem: 'analista',
          });
        } catch (e2) {}
        alert('Erro ao executar: ' + (e.message || e));
        await carregarTudo();
      } finally {
        state.executandoAcaoManual = false;
        render();
      }
    }

    function renderAcaoManual(contaId) {
      return `<details style="margin-bottom:20px;">
      <summary style="cursor:pointer;font-size:13px;font-weight:700;color:var(--text-muted);padding:4px 0;">⚡ Avançado: ajustar 1 campanha específica na mão</summary>
      <div class="ag-hud-card" style="--ag-hud-accent:#dc2626;margin-top:10px;">
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;">Só pra casos pontuais — pega o ID na tabela "Campanhas ao vivo" (coluna ID). Pra aumentar investimento, prefira o botão "🚀 Boost" na própria tabela, que já sugere o valor certo pra aprovar.</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:10px;">
          <div class="form-group" style="margin:0;"><label class="form-label">ID da campanha</label><input type="text" class="form-input" id="ag-man-campanha" placeholder="Ex: 86858387"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Nome (só pro log)</label><input type="text" class="form-input" id="ag-man-nome" placeholder="Opcional"></div>
          <div class="form-group" style="margin:0;">
            <label class="form-label">O que fazer</label>
            <select class="form-select" id="ag-man-tipo" onchange="window._agAtualizarTipoManual()">
              <option value="orcamento">Ajustar orçamento (R$/dia)</option>
              <option value="roas">Ajustar meta de ROAS (x)</option>
              <option value="pausar">Pausar campanha</option>
            </select>
          </div>
          <div class="form-group" style="margin:0;" id="ag-man-valor-wrap"><label class="form-label">Valor novo</label><input type="number" step="0.1" class="form-input" id="ag-man-valor" placeholder="Ex: 300 ou 17.5"></div>
        </div>
        <div class="form-group" style="margin-bottom:12px;"><label class="form-label">Por quê (opcional, vai pro log)</label><input type="text" class="form-input" id="ag-man-explicacao" placeholder="Ex: recomendação do chat — Rack Linea, ACOS saudável, aumentar orçamento"></div>
        <button class="btn btn-primary" style="background:#dc2626;border-color:#dc2626;" ${state.executandoAcaoManual ? 'disabled' : ''} onclick="window._agExecutarAcaoManual()">
          ${state.executandoAcaoManual ? '⏳ Executando na Shopee...' : '⚡ Executar agora'}
        </button>
      </div>
      </details>`;
    }

    // ── Extrai ação/de→para de uma entrada de log (decisão ou alerta) pra
    // exibição compacta em card — mesma lógica usada no Kanban. ──
    function descreverAcao(l) {
      const d = l.dados || {};
      const n1 = v => (Math.round(parseFloat(v) * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const nomeCampanha = esc((l.titulo || '').replace(/^(Campanha pausada|Orçamento ajustado|Meta de ROAS ajustada|Falha ao pausar|Falha ao ajustar orçamento|Falha ao ajustar meta de ROAS|Sugestão de baixar meta de ROI|Sugestão de subir meta de ROI|Sugestão de aumento de orçamento|Sugestão de corte de orçamento) — /, ''));
      let acaoLabel = null, acaoCor = '#64748b', deParaVal = null;
      if (d.roas_de != null && d.roas_para != null) {
        const maisAgressivo = d.roas_para < d.roas_de;
        acaoLabel = maisAgressivo ? '▼ Lance + agressivo' : '▲ Lance + conservador';
        acaoCor = maisAgressivo ? '#22d3ee' : '#d97706';
        deParaVal = `${n1(d.roas_de)}x → ${n1(d.roas_para)}x`;
      } else if (d.budget_de != null && d.budget_para != null) {
        const subiu = d.budget_para > d.budget_de;
        acaoLabel = subiu ? '▲ Orçamento ↑' : '▼ Orçamento ↓';
        acaoCor = subiu ? '#22d3ee' : '#d97706';
        deParaVal = `${R$(d.budget_de)} → ${R$(d.budget_para)}`;
      } else if (d.roas_atual != null && d.roas_sugerido != null) {
        // Sugestão ainda pendente (vinda do chat ou da Regra 3/4), antes de aprovar.
        const maisAgressivo = d.roas_sugerido < d.roas_atual;
        acaoLabel = maisAgressivo ? '▼ Sugestão: lance + agressivo' : '▲ Sugestão: lance + conservador';
        acaoCor = maisAgressivo ? '#22d3ee' : '#d97706';
        deParaVal = `${n1(d.roas_atual)}x → ${n1(d.roas_sugerido)}x`;
      } else if (d.budget_atual != null && d.budget_sugerido != null) {
        const subiu = d.budget_sugerido > d.budget_atual;
        acaoLabel = subiu ? '▲ Sugestão: orçamento ↑' : '▼ Sugestão: orçamento ↓';
        acaoCor = subiu ? '#22d3ee' : '#d97706';
        deParaVal = `${R$(d.budget_atual)} → ${R$(d.budget_sugerido)}`;
      } else if (d.pausar === true) {
        acaoLabel = '⏸ Sugestão: pausar'; acaoCor = '#dc2626';
      } else if ((l.titulo || '').includes('pausada')) {
        acaoLabel = '⏸ Pausada'; acaoCor = '#dc2626';
      }
      return { nomeCampanha, acaoLabel, acaoCor, deParaVal, acos: d.acos != null ? n1(d.acos) + '%' : null };
    }

    function cardKanban(l, corBorda, comAcoes) {
      const { nomeCampanha, acaoLabel, acaoCor, deParaVal, acos } = descreverAcao(l);
      // Alerta pendente tem os valores sugeridos em campos "_atual/_sugerido"
      // (gerados pela Regra 3/4 do cron), não "_de/_para" (só usado nos já
      // executados) — precisa achar aqui pra saber se dá pra aprovar de
      // verdade ou se é só informativo (ex: alerta de GMV Max da Loja, fora
      // do escopo do agente, sem ação automática associada).
      const d = l.dados || {};
      const temAcaoExecutavel = d.campaign_id != null && (d.roas_sugerido != null || d.budget_sugerido != null || d.pausar === true);
      const processando = state.processandoAlertaId === l.id;
      return `<div style="border:1px solid var(--border);border-left:3px solid ${corBorda};border-radius:8px;padding:10px 12px;background:var(--bg-card-hover,#f7f7fb);">
        <div style="font-size:12.5px;font-weight:700;line-height:1.4;">${nomeCampanha || esc(l.titulo)}</div>
        ${acaoLabel ? `<span class="ag-action-chip" style="color:${acaoCor};background:${acaoCor}1a;margin-top:6px;">${acaoLabel}</span>` : ''}
        ${deParaVal ? `<div class="ag-mono" style="font-size:12px;margin-top:6px;">${deParaVal}</div>` : ''}
        ${acos ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;">ACOS ${acos}</div>` : ''}
        ${l.explicacao ? `<div style="font-size:11.5px;color:var(--text-secondary);margin-top:6px;line-height:1.5;">${nl2br(l.explicacao.slice(0, 180))}${l.explicacao.length > 180 ? '…' : ''}</div>` : ''}
        <div style="font-size:10.5px;color:var(--text-muted);margin-top:8px;">${new Date(l.criado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
        ${comAcoes ? `<div style="display:flex;gap:6px;margin-top:10px;">
          ${temAcaoExecutavel ? `<button class="btn btn-sm" style="background:#16a34a1a;color:#16a34a;border:1px solid #16a34a44;flex:1;" ${processando ? 'disabled' : ''} onclick="window._agAprovarAlerta('${l.id}')">${processando ? '⏳...' : '✅ Aprovar'}</button>` : `<span style="font-size:10.5px;color:var(--text-muted);flex:1;align-self:center;">Informativo — sem ação automática pra aprovar</span>`}
          <button class="btn btn-sm" style="background:#dc26261a;color:#dc2626;border:1px solid #dc262644;" ${processando ? 'disabled' : ''} onclick="window._agDescartarAlerta('${l.id}')">${processando ? '⏳' : '🚫 Descartar'}</button>
        </div>` : ''}
      </div>`;
    }

    async function aprovarAlerta(logId) {
      const l = state.logs.find(x => String(x.id) === String(logId));
      if (!l) return;
      const d = l.dados || {};
      if (d.campaign_id == null || (d.roas_sugerido == null && d.budget_sugerido == null && d.pausar !== true)) {
        alert('Esse alerta é informativo — não tem ação automática associada pra aprovar. Ajuste manualmente na Shopee se for o caso, ou descarte.');
        return;
      }
      const cfg = configDaConta(l.conta_id);
      state.processandoAlertaId = logId;
      render();
      try {
        if (d.pausar === true) {
          await MarketplaceAPI.call('shopee_ads_pause_campaign', { shopId: l.conta_id, campaign_id: Number(d.campaign_id) });
        } else if (d.roas_sugerido != null) {
          await MarketplaceAPI.call('shopee_ads_roi_target', { shopId: l.conta_id, campaign_id: Number(d.campaign_id), roas_target: d.roas_sugerido });
        } else {
          await MarketplaceAPI.call('shopee_ads_edit_campaign', {
            shopId: l.conta_id,
            params: { campaign_id: Number(d.campaign_id), budget: d.budget_sugerido, edit_action: 'change_budget', reference_id: `glr-aprovado-${Date.now()}-${d.campaign_id}` },
          });
        }
        await _sb.from('glr_agente_log').update({ resultado: 'executado' }).eq('id', l.id);
        await _sb.from('glr_agente_log').insert({
          conta_id: l.conta_id, cliente_nome: cfg?.cliente_nome || null, tipo: 'decisao',
          titulo: `Aprovado manualmente — ${(l.titulo || '').replace(/^Sugestão de /, '')}`,
          explicacao: `Alerta aprovado pelo analista. ${l.explicacao || ''}`, dados: d, resultado: 'executado', origem: 'aprovacao_manual',
        });
      } catch (e) {
        alert('Erro ao executar: ' + (e.message || e));
      } finally {
        state.processandoAlertaId = null;
        await carregarTudo();
      }
    }

    async function descartarAlerta(logId) {
      const l = state.logs.find(x => String(x.id) === String(logId));
      if (!l) return;
      state.processandoAlertaId = logId;
      render();
      try {
        await _sb.from('glr_agente_log').update({ resultado: 'descartado' }).eq('id', l.id);
      } catch (e) {
        alert('Erro ao descartar: ' + (e.message || e));
      } finally {
        state.processandoAlertaId = null;
        await carregarTudo();
      }
    }

    // ── Kanban de mudanças e resultados: 3 colunas por status — aguardando
    // aprovação (precisa de humano), executado (ação automática deu certo),
    // falhou (tentou executar e a API devolveu erro). Mais visual que a
    // tabela/log corrido — dá pra ver de relance o que está pendente e o
    // que já foi resolvido. ──
    function renderKanban(contaId) {
      const relevantes = state.logs.filter(l => l.conta_id === contaId && (l.tipo === 'decisao' || l.tipo === 'alerta'));
      const pendentes = relevantes.filter(l => l.resultado === 'so_alerta').sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em)).slice(0, 20);
      const executados = relevantes.filter(l => l.resultado === 'executado').sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em)).slice(0, 20);
      const falharam = relevantes.filter(l => l.resultado === 'erro').sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em)).slice(0, 20);

      const coluna = (titulo, cor, itens, vazio, comAcoes) => `
        <div style="flex:1;min-width:260px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
            <span style="width:8px;height:8px;border-radius:50%;background:${cor};"></span>
            <div style="font-size:13px;font-weight:800;">${titulo}</div>
            <span style="font-size:11px;color:var(--text-muted);background:var(--bg-card-hover,#f1f1f5);padding:1px 8px;border-radius:99px;">${itens.length}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;max-height:520px;overflow-y:auto;padding-right:2px;">
            ${itens.length ? itens.map(l => cardKanban(l, cor, comAcoes)).join('') : `<div style="text-align:center;padding:20px 10px;color:var(--text-muted);font-size:12px;">${vazio}</div>`}
          </div>
        </div>`;

      return `<div class="ag-hud-card" style="--ag-hud-accent:#6366f1;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:800;margin-bottom:2px;">🗂️ Mudanças e resultados</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:16px;">O que está esperando sua aprovação, o que o agente já executou sozinho, e o que tentou executar e falhou.</div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;">
          ${coluna('🔔 Aguardando aprovação', '#d97706', pendentes, '✅ Nada pendente agora', true)}
          ${coluna('✅ Executado', '#16a34a', executados, 'Nenhuma ação automática ainda', false)}
          ${coluna('⚠️ Falhou', '#dc2626', falharam, 'Sem falhas registradas', false)}
        </div>
      </div>`;
    }

    // ── Saúde do negócio (faturamento semana vs semana anterior) ──
    function renderNegocio(contaId) {
      const n = state.negocioPorConta[contaId + ':' + state.negocioPeriodo];
      const subindo = n && !n.erro && n.variacaoPct !== Infinity && n.variacaoPct >= 0;
      const cor = !n || n.erro ? '#64748b' : n.incompleto ? '#d97706' : subindo ? '#16a34a' : '#dc2626';
      const PERIODOS = [['7', '7 dias'], ['15', '15 dias'], ['30', '30 dias'], ['mes', 'Mês atual']];
      const labelAtual = n && n.erro === undefined ? (state.negocioPeriodo === 'mes' ? 'mês anterior (mesmo período)' : `${state.negocioPeriodo} dias anteriores`) : '';
      return `<div class="ag-hud-card" style="--ag-hud-accent:${cor};margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:2px;">
          <div style="font-size:14px;font-weight:800;">📈 Saúde do negócio</div>
          <button class="btn btn-secondary btn-sm" ${state.carregandoNegocio ? 'disabled' : ''} onclick="window._agAtualizarNegocio()">🔄 Atualizar</button>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px;">Faturamento total da loja — não só o atribuído ao ADS.</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">
          ${PERIODOS.map(([valor, label]) => `
            <button class="btn btn-sm ${state.negocioPeriodo === valor ? 'btn-primary' : 'btn-secondary'}" onclick="window._agMudarPeriodoNegocio('${valor}')">${label}</button>
          `).join('')}
        </div>
        ${state.carregandoNegocio && !n ? `<div style="color:var(--text-muted);font-size:13px;">⏳ calculando...</div>`
          : !n ? `<div style="color:var(--text-muted);font-size:13px;">Sem dados ainda.</div>`
          : n.erro ? `<div style="color:var(--text-muted);font-size:13px;">⚠️ erro ao buscar: ${esc(n.erro)}</div>` : `
          <div style="display:flex;gap:26px;flex-wrap:wrap;align-items:flex-end;">
            <div><div class="ag-hud-label" style="margin-bottom:2px;">${state.negocioPeriodo === 'mes' ? 'Mês atual' : `Últimos ${state.negocioPeriodo} dias`}</div><div class="ag-mono" style="font-size:22px;font-weight:800;">${R$(n.semanaAtual)}</div></div>
            <div><div class="ag-hud-label" style="margin-bottom:2px;">${labelAtual || 'Período anterior'}</div><div class="ag-mono" style="font-size:16px;color:var(--text-muted);">${R$(n.semanaAnterior)}</div></div>
            <div><div class="ag-hud-label" style="margin-bottom:2px;">Variação</div><div class="ag-mono" style="font-size:22px;font-weight:800;color:${cor};">${n.variacaoPct === Infinity ? '∞' : (n.variacaoPct >= 0 ? '+' : '') + n.variacaoPct.toFixed(1) + '%'}</div></div>
          </div>
          ${n.incompleto ? `<div style="margin-top:10px;background:#d977061a;border:1px solid #d97706;border-radius:8px;padding:8px 12px;font-size:12px;color:#d97706;font-weight:600;">⚠️ ${esc(n.avisoIncompleto)}</div>` : ''}
          <div style="margin-top:12px;font-size:12px;color:var(--text-muted);">Quer ver quais SKUs estão puxando essa variação (produtos em alta/queda)? A <a href="#analytics" style="color:var(--accent-light,#818cf8);">aba Analytics → Produtos em Queda</a> já tem esse detalhamento semana a semana, filtrado por cliente.</div>
        `}
      </div>`;
    }

    // ── Config do piloto (reagrupada em guardrails, em português) ──
    function renderConfig() {
      const cfg = state.contaAbertaId && state.contaAbertaId !== '__novo__' ? (configDaConta(state.contaAbertaId) || {}) : {};
      const jaConfiguradas = new Set(state.contas.map(c => c.conta_id));
      return `<div class="card" style="padding:20px 22px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <div style="font-size:14px;font-weight:700;">⚙️ Guardrails do piloto</div>
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;">
            <input type="checkbox" id="ag-ativo" ${cfg.ativo ? 'checked' : ''}> Piloto ativo nesta conta
          </label>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;">
          Cada conta liga/desliga o piloto de forma independente — o cron avalia todas as ativas todo dia às 07:00.
        </div>

        <div class="form-group" style="margin-bottom:16px;">
          <label class="form-label">Conta Shopee</label>
          <select class="form-select" id="ag-conta">
            <option value="">— Selecione —</option>
            ${state.contasShopee.map(c => {
              const id = c.param_to_use?.shopId || c.external_id;
              const jaConfigurada = jaConfiguradas.has(id) && id !== cfg.conta_id;
              return `<option value="${id}" ${cfg.conta_id === id ? 'selected' : ''} ${jaConfigurada ? 'disabled' : ''}>${esc(nomeConta(c))}${jaConfigurada ? ' (já configurada)' : ''}</option>`;
            }).join('')}
          </select>
        </div>

        <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 8px;">Quando pausar</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px;">
          <div class="form-group" style="margin:0;"><label class="form-label">ACOS da campanha acima de (%)</label><input type="number" step="0.1" class="form-input" id="ag-pausa-acos" value="${esc(cfg.regra_pausa_acos ?? '')}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">...por quantos dias seguidos</label><input type="number" class="form-input" id="ag-pausa-dias" value="${esc(cfg.regra_pausa_dias ?? 3)}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label" title="Campanha mais nova que isso não é pausada por ACOS ruim ainda, mesmo que o critério ao lado tenha sido atingido — só registra um aviso.">Maturação mínima da campanha (dias)</label><input type="number" class="form-input" id="ag-maturacao" value="${esc(cfg.dias_maturacao_campanha ?? 7)}"></div>
        </div>

        <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 8px;">Quando pode crescer sozinho</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px;">
          <div class="form-group" style="margin:0;"><label class="form-label" title="Investimento em ADS ÷ faturamento TOTAL da loja — não é o ACOS isolado de campanha. É a métrica principal que o agente usa pra decidir.">Meta TACOS (%)</label><input type="number" step="0.1" class="form-input" id="ag-meta-acos" value="${esc(cfg.meta_acos ?? '')}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Orçamento mín. (R$/dia)</label><input type="number" step="0.01" class="form-input" id="ag-orc-min" value="${esc(cfg.orcamento_min ?? '')}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Orçamento máx. (R$/dia)</label><input type="number" step="0.01" class="form-input" id="ag-orc-max" value="${esc(cfg.orcamento_max ?? '')}"></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Janela de decisão (dias)</label><input type="number" class="form-input" id="ag-janela" value="${esc(cfg.janela_decisao_dias ?? 1)}"></div>
        </div>

        <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 8px;">O que sempre espera sua aprovação</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px;">
          <div class="form-group" style="margin:0;"><label class="form-label">Alerta se variação proposta &gt; (%)</label><input type="number" class="form-input" id="ag-alerta-var" value="${esc(cfg.alerta_variacao_pct ?? 30)}"></div>
        </div>

        <details style="margin-bottom:16px;">
          <summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--text-muted);">Avançado</summary>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:10px;">
            <div class="form-group" style="margin:0;"><label class="form-label">Margem (%)</label><input type="number" step="0.1" class="form-input" id="ag-margem" value="${esc(cfg.margem_pct ?? '')}"></div>
            <div class="form-group" style="margin:0;"><label class="form-label">Estoque mínimo</label><input type="number" class="form-input" id="ag-estoque-min" value="${esc(cfg.estoque_minimo ?? '')}"></div>
          </div>
        </details>

        <div class="form-group" style="margin-bottom:14px;">
          <label class="form-label">Notas / calendário de promoções / contexto extra</label>
          <textarea class="form-textarea" id="ag-notas" rows="2" placeholder="Ex: Black Friday em novembro, não cortar orçamento nessa semana mesmo se ACOS subir.">${cfg.notas || ''}</textarea>
        </div>

        <button class="btn btn-primary" ${state.salvandoConfig ? 'disabled' : ''} onclick="window._agSalvarConfig()">
          ${state.salvandoConfig ? '⏳ Salvando...' : '💾 Salvar configuração'}
        </button>
      </div>`;
    }

    // ── Log completo ────────────────────────────────────────────
    function renderLog(contaId) {
      const doConta = state.logs.filter(l => l.conta_id === contaId);
      const lista = state.filtroLog === 'todos' ? doConta : doConta.filter(l => l.tipo === state.filtroLog);
      return `<details style="margin-bottom:20px;">
        <summary style="cursor:pointer;font-size:14px;font-weight:700;padding:4px 0;">📜 Log completo (${doConta.length})</summary>
        <div class="card" style="padding:20px 22px;margin-top:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
          <div style="font-size:12.5px;color:var(--text-muted);">Tudo que foi feito, decidido e conversado — inclusive as ações 100% automáticas.</div>
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
        </div>
      </details>`;
    }

    // ── Campanhas ao vivo (com GMV, orçamento, gasto e ACOS por campanha) ──
    function renderCampanhasAoVivo(contaId) {
      const d = state.dadosAoVivoPorConta[contaId];
      if (!d || d.erro || !d.topCampanhas?.length) return '';
      const STATUS_COR = { ongoing: '#22d3ee', paused: '#d97706', ended: '#64748b', closed: '#64748b' };
      return `<details style="margin-bottom:20px;" open>
        <summary style="cursor:pointer;font-size:14px;font-weight:700;padding:4px 0;">📡 Campanhas ao vivo (últimos 7 dias)</summary>
        <div class="ag-hud-card" style="--ag-hud-accent:#818cf8;margin-top:10px;overflow-x:auto;">
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:2px;">
          <button class="btn btn-secondary btn-sm" ${state.carregandoDadosAoVivo ? 'disabled' : ''} onclick="window._agAtualizarDados()">🔄 Atualizar</button>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;">Top ${d.topCampanhas.length} por investimento — inclui GMV (vendas atribuídas ao ADS) por campanha. Pode não bater com o total acima: a Shopee às vezes não lista aqui campanhas em modo "GMV Max - Meta de ROAS", mesmo contando o gasto delas no total.</div>
        <table class="ag-tech-table">
          <thead>
            <tr>
              <th>Campanha</th>
              <th>ID</th>
              <th>Status</th>
              <th>Orçamento</th>
              <th>Gasto</th>
              <th>GMV</th>
              <th>ACOS</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${d.topCampanhas.map(c => {
              const statusChave = (c.status || '').toLowerCase();
              const cor = STATUS_COR[statusChave] || '#64748b';
              return `<tr style="--row-accent:${cor};">
                <td style="max-width:280px;">${esc(c.nome)}</td>
                <td class="ag-mono" style="white-space:nowrap;color:var(--text-muted);">${c.id ?? '—'}</td>
                <td><span class="ag-action-chip" style="color:${cor};background:${cor}1a;">${esc(c.status || '—')}</span></td>
                <td class="ag-mono" style="white-space:nowrap;">${R$(c.budget)}</td>
                <td class="ag-mono" style="white-space:nowrap;">${R$(c.gasto)}</td>
                <td class="ag-mono" style="white-space:nowrap;font-weight:700;">${R$(c.gmv)}</td>
                <td class="ag-mono" style="white-space:nowrap;">${c.acos === Infinity ? '∞' : c.acos.toFixed(1) + '%'}</td>
                <td style="white-space:nowrap;">${c.id ? `<button class="btn btn-secondary btn-sm" title="Sugere um aumento de investimento pra essa campanha, pra aprovar no Kanban" onclick="window._agBoostCampanha('${c.id}', '${esc(c.nome).replace(/'/g, "\\'")}', ${c.budget || 0}, ${c.roasTarget != null ? c.roasTarget : 'null'}, ${c.acos === Infinity ? 'Infinity' : c.acos})">🚀 Boost</button>` : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        </div>
      </details>`;
    }

    // ── Decisões automáticas (histórico, colapsado) ──
    // ── Relatórios diários ────────────────────────────────────
    function renderRelatorios(contaId) {
      const lista = state.relatorios.filter(r => r.conta_id === contaId);
      return `<div class="card" style="padding:20px 22px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:4px;">🗞️ Relatórios diários</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;">Gerado automaticamente todo dia às 07:00, sobre o dia anterior.</div>
        ${!lista.length ? `<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:13px;">Nenhum relatório ainda — sai amanhã de manhã se o piloto estiver ativo hoje.</div>` : `
        <div style="display:flex;flex-direction:column;gap:10px;max-height:420px;overflow-y:auto;">
          ${lista.map((r, i) => `
            <details ${i === 0 ? 'open' : ''} style="border:1px solid var(--border);border-radius:10px;padding:10px 14px;">
              <summary style="cursor:pointer;font-size:13px;font-weight:600;">${new Date(r.data + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })} — ${esc(r.cliente_nome || r.conta_id)}</summary>
              <div style="font-size:12.5px;color:var(--text-secondary);margin-top:8px;line-height:1.6;white-space:pre-wrap;">${nl2br(r.resumo)}</div>
            </details>`).join('')}
        </div>`}
      </div>`;
    }

    // ── Chat ───────────────────────────────────────────────────
    function renderDadosAoVivoResumo(contaId) {
      const d = state.dadosAoVivoPorConta[contaId];
      const linha = state.carregandoDadosAoVivo ? '⏳ atualizando dados da Shopee (últimos 7 dias)...'
        : !contaId ? 'Configure e salve uma conta piloto pra puxar dados ao vivo.'
        : d?.erro ? `⚠️ erro ao buscar dados: ${esc(d.erro)}`
        : d ? `${d.campanhasAtivas} campanha(s) ativa(s) · faturamento total ${R$(d.faturamentoTotal)} · investimento ADS ${R$(d.gastoTotal)} · TACOS ${d.tacosGeral === Infinity ? '∞' : d.tacosGeral.toFixed(1) + '%'} (últimos 7 dias, ${new Date(d.atualizadoEm).toLocaleTimeString('pt-BR')})${d.avisoParcial ? ` ⚠️ ${esc(d.avisoParcial)}` : ''}`
        : 'Nenhum dado carregado ainda.';
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--bg-card-hover,#f7f7fb);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:11.5px;color:var(--text-muted);">
        <span>${linha}</span>
        <button class="btn btn-secondary btn-sm" style="white-space:nowrap;" ${state.carregandoDadosAoVivo ? 'disabled' : ''} onclick="window._agAtualizarDados()">🔄 Atualizar</button>
      </div>`;
    }

    function renderChat(contaId) {
      return `<div class="card" style="padding:20px 22px;display:flex;flex-direction:column;height:560px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:10px;">💬 Conversar com o agente</div>
        ${renderDadosAoVivoResumo(contaId)}
        <div id="ag-chat-msgs" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding-right:4px;">
          ${!state.chatMessages.length ? `<div style="text-align:center;color:var(--text-muted);font-size:12.5px;padding:30px 10px;">Pergunte sobre as decisões recentes, o desempenho da conta, ou peça pra explicar por que pausou/ajustou alguma campanha.</div>` : ''}
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

      // Portfólio: mais de 1 conta configurada e nenhuma aberta.
      if (state.contaAbertaId == null) {
        root.innerHTML = state.contas.length
          ? renderPortfolio()
          : `<div style="text-align:center;padding:50px;color:var(--text-muted);font-size:13px;">Nenhuma conta configurada ainda.</div>${renderConfig()}`;
        return;
      }

      const cfg = state.contaAbertaId === '__novo__' ? null : configDaConta(state.contaAbertaId);
      const voltar = state.contas.length > 1 ? `<button class="btn btn-secondary btn-sm" style="margin-bottom:16px;" onclick="window._agVoltarPortfolio()">← Portfólio</button>` : '';

      if (!cfg) {
        // '__novo__' ou conta_id que ainda não tem linha salva — só o form.
        root.innerHTML = `${voltar}${renderConfig()}`;
        return;
      }

      root.innerHTML = `
        ${voltar}
        ${renderSaudeHero(cfg)}
        ${renderRodarAgente(cfg.conta_id)}
        ${renderAcaoManual(cfg.conta_id)}
        ${renderKanban(cfg.conta_id)}
        ${renderNegocio(cfg.conta_id)}
        ${renderCampanhasAoVivo(cfg.conta_id)}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;" class="ag-grid-resp">
          <div>
            ${renderConfig()}
            ${renderRelatorios(cfg.conta_id)}
          </div>
          <div>
            ${renderChat(cfg.conta_id)}
          </div>
        </div>
        ${renderLog(cfg.conta_id)}
      `;
    }

    el.innerHTML = `<div class="page">
      <div class="ag-hero">
        <div class="ag-hero-grid"></div>
        <div class="ag-hero-top">
          <div class="ag-hero-title">
            <span class="ag-pulse-dot"></span>
            <span>Agente Autônomo — Central de Comando</span>
          </div>
          <span class="ag-chip ag-chip-ai">⚡ IA · monitoramento contínuo</span>
        </div>
        <div class="ag-hero-sub">
          Portfólio de contas com piloto configurado. Todo dia às 07:00, o agente revisa cada conta ativa contra os guardrails abaixo, decide pausar/retomar/ajustar sozinho o que está dentro da faixa, e só levanta a mão (Fila de Atenção) pro que precisa do seu julgamento.
        </div>
      </div>
      <div id="ag-root"></div>
      <style>
        @media (max-width:980px){.ag-grid-resp{grid-template-columns:1fr !important;}}

        .ag-hero { position:relative; overflow:hidden; border-radius:16px; padding:22px 26px; margin-bottom:22px;
          background: radial-gradient(120% 160% at 0% 0%, rgba(99,102,241,0.20), transparent 60%), linear-gradient(135deg, #0f0f1a, #14141f 55%, #0f0f1a);
          border:1px solid rgba(99,102,241,0.25); }
        .ag-hero-grid { position:absolute; inset:0; opacity:.35; pointer-events:none;
          background-image: linear-gradient(rgba(99,102,241,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.12) 1px, transparent 1px);
          background-size: 26px 26px; mask-image: radial-gradient(80% 100% at 50% 0%, #000, transparent 75%); }
        .ag-hero-top { position:relative; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
        .ag-hero-title { display:flex; align-items:center; gap:10px; font-size:19px; font-weight:800; color:#fff; letter-spacing:.01em; }
        .ag-hero-sub { position:relative; font-size:13px; color:#9ca3d4; margin-top:10px; max-width:760px; line-height:1.6; }
        .ag-pulse-dot { position:relative; width:10px; height:10px; border-radius:50%; background:#22d3ee; box-shadow:0 0 0 0 rgba(34,211,238,0.6); animation: ag-pulse 1.8s infinite; flex-shrink:0; }
        @keyframes ag-pulse { 0%{box-shadow:0 0 0 0 rgba(34,211,238,0.55);} 70%{box-shadow:0 0 0 9px rgba(34,211,238,0);} 100%{box-shadow:0 0 0 0 rgba(34,211,238,0);} }
        .ag-chip { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:700; letter-spacing:.02em; padding:5px 11px; border-radius:99px; white-space:nowrap; }
        .ag-chip-ai { color:#22d3ee; background:rgba(34,211,238,0.10); border:1px solid rgba(34,211,238,0.35); }

        .ag-hud-card { position:relative; border-radius:14px; padding:16px 18px; overflow:hidden;
          background: linear-gradient(160deg, var(--bg-card), rgba(99,102,241,0.05)); border:1px solid var(--border); }
        .ag-hud-card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--ag-hud-accent,#6366f1); box-shadow:0 0 12px var(--ag-hud-accent,#6366f1); }
        .ag-hud-label { font-size:10.5px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.08em; margin-bottom:8px; display:flex; align-items:center; gap:6px; font-weight:700; }
        .ag-hud-value { font-family: 'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace; font-size:23px; font-weight:800; font-variant-numeric:tabular-nums; }
        .ag-hud-sub { font-size:11px; color:var(--text-muted); margin-top:5px; }

        .ag-tech-table { width:100%; border-collapse:separate; border-spacing:0 6px; font-size:12.5px; }
        .ag-tech-table thead th { text-align:left; padding:0 10px 6px; font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--text-muted); font-weight:700; }
        .ag-tech-table tbody tr { background:var(--bg-card-hover,#f7f7fb); }
        .ag-tech-table tbody td { padding:9px 10px; border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
        .ag-tech-table tbody td:first-child { border-left:3px solid var(--row-accent,#6366f1); border-top-left-radius:8px; border-bottom-left-radius:8px; font-weight:700; }
        .ag-tech-table tbody td:last-child { border-top-right-radius:8px; border-bottom-right-radius:8px; color:var(--text-muted); }
        .ag-mono { font-family: 'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace; font-variant-numeric:tabular-nums; }
        .ag-action-chip { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700; padding:3px 9px; border-radius:99px; white-space:nowrap; }
      </style>
    </div>`;

    window._agSalvarConfig = salvarConfig;
    window._agEnviarChat = enviarChat;
    window._agFiltrarLog = (t) => { state.filtroLog = t; render(); };
    window._agAtualizarDados = () => buscarDadosAoVivo(state.contaAbertaId);
    window._agAtualizarNegocio = () => buscarNegocio(state.contaAbertaId);
    window._agMudarPeriodoNegocio = (periodo) => { state.negocioPeriodo = periodo; render(); buscarNegocio(state.contaAbertaId, periodo); };
    window._agAbrirConta = (id) => {
      state.contaAbertaId = id; state.chatMessages = []; render();
      if (id && id !== '__novo__') { buscarDadosAoVivo(id); buscarNegocio(id); }
    };
    window._agVoltarPortfolio = () => { state.contaAbertaId = null; render(); };
    window._agExecutarAcaoManual = executarAcaoManual;
    window._agRodarAgora = rodarAgenteAgora;
    window._agAprovarAlerta = aprovarAlerta;
    window._agDescartarAlerta = descartarAlerta;
    window._agBoostCampanha = boostCampanha;
    window._agUsarCampanhaManual = (id, nome) => {
      const campoId = document.getElementById('ag-man-campanha');
      const campoNome = document.getElementById('ag-man-nome');
      if (campoId) campoId.value = id;
      if (campoNome) campoNome.value = nome;
      campoId?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    window._agAtualizarTipoManual = () => {
      const tipo = document.getElementById('ag-man-tipo')?.value;
      const wrap = document.getElementById('ag-man-valor-wrap');
      if (wrap) wrap.style.display = tipo === 'pausar' ? 'none' : '';
    };

    render();
    carregarTudo();
  }

  if (typeof Router !== 'undefined') {
    Router.register('agente', renderPage);
  }

})();
