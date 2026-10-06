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
      abcPorConta: {}, carregandoABC: false, abcProgresso: '',
      timelineFiltro: 'todos', timelineMostrar: 5,
      tabOrdem: { col: 'gasto', dir: -1 }, tabTodas: false,
      logBusca: '', logMostrar: 20, regrasSalvoEm: null, chatAberto: false, reativando: false,
      sec: {}, // seções recolhíveis abertas (o render recria o HTML, então o estado mora aqui)
      executandoAcaoManual: false,
      rodandoAgente: false, resultadoRodada: null,
      processandoAlertaId: null,
    };

    function render() { renderShell(); renderChatDrawer(); }

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
        buscarNegocio(cfgAberta.conta_id);
        buscarDadosAoVivo(cfgAberta.conta_id);
        abcCarregarDoCache(cfgAberta.conta_id);
        render();
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
      // Até 29/09/2026 precisava complementar com raw_read paginado à mão
      // (shopee_ads_campaigns só trazia a primeira leva). O Tiops corrigiu:
      // agora pagina sozinha e devolve a loja inteira numa chamada só
      // (confirmado ao vivo: conta com 205 campanhas, has_next_page:false).
      const base = await MarketplaceAPI.call('shopee_ads_campaigns', { shopId });
      return base.data?.response?.campaign_list || base.response?.campaign_list || [];
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

    // ── Período único da tela (state.negocioPeriodo: '7' | '15' | '30' | 'mes') ──
    function isoDe(d) {
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    function isoParaBR(iso) { return iso.split('-').reverse().join('-'); }
    function periodoLabel(p) { return p === 'mes' ? 'mês atual' : `${p} dias`; }

    // Janela do período atual + período anterior de igual tamanho, pra
    // comparação. "mes" compara o mês corrente (dia 1 até hoje) com o mesmo
    // intervalo de dias do mês anterior (comparação justa, não o mês anterior
    // inteiro).
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

    // A API de Ads da Shopee recusa janela maior que 1 mês ("Date range can't
    // be longer than 1 month") — confirmado ao vivo: 31 dias falha, 30 passa.
    // Só afeta "Mês atual" nos dias 31 em diante; nesse caso usa os últimos 30.
    function janelaAds(periodo) {
      const j = janelasNegocio(periodo);
      let reduzida = false;
      const limitar = (de, ate) => {
        const d1 = new Date(de + 'T12:00:00'), d2 = new Date(ate + 'T12:00:00');
        const dias = Math.round((d2 - d1) / 86400000) + 1;
        if (dias <= 30) return [de, ate];
        reduzida = true;
        const nd = new Date(d2); nd.setDate(nd.getDate() - 29);
        return [isoDe(nd), ate];
      };
      const [atualDe, atualAte] = limitar(j.atualDe, j.atualAte);
      const [anteriorDe, anteriorAte] = limitar(j.anteriorDe, j.anteriorAte);
      return { atualDe, atualAte, anteriorDe, anteriorAte, reduzida };
    }

    // Faturamento total + métricas de ADS do período e do período anterior.
    // É a ÚNICA fonte desses números na tela (indicadores, chat e tabela
    // reaproveitam o mesmo resultado), pra nunca dois blocos mostrarem
    // janelas ou valores diferentes. Guarda a promessa em andamento: abrir a
    // conta dispara vários consumidores ao mesmo tempo e só o primeiro busca.
    const negEmAndamento = {};
    function calcularNegocio(shopId, periodo, forcar) {
      const chave = shopId + ':' + periodo;
      if (!forcar && negEmAndamento[chave]) return negEmAndamento[chave];
      const promessa = (async () => {
        // Se algum status falhar mesmo depois do retry, NÃO mostra um número
        // limpo como se fosse completo — marca "incompleto" e mostra na tela.
        // Sequencial, NUNCA em paralelo: confirmado ao vivo que disparar as
        // chamadas de status juntas faz o conector devolver dado incompleto.
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
        const falhas = [...atual.statusFalhou, ...anterior.statusFalhou];

        // Gasto/GMV de ADS: performance diária da loja inteira (campanhas
        // individuais, inclusive GMV Max por produto). O GMV Max da Loja fica
        // de fora por decisão do analista (o agente não consegue agir nele).
        const somaAds = async (deISO, ateISO) => {
          const r = await MarketplaceAPI.call('shopee_ads_daily_performance', { shopId, start_date: isoParaBR(deISO), end_date: isoParaBR(ateISO) });
          const dias = r.data?.response || r.response || [];
          const s = { gasto: 0, gmv: 0, impressoes: 0, cliques: 0, pedidos: 0 };
          dias.forEach(d => {
            s.gasto += parseFloat(d.expense) || 0; s.gmv += parseFloat(d.broad_gmv) || 0;
            s.impressoes += parseInt(d.impression) || 0; s.cliques += parseInt(d.clicks) || 0;
            s.pedidos += parseInt(d.broad_order) || 0;
          });
          return s;
        };
        const adsJ = janelaAds(periodo);
        let adsAtual = null, adsAnterior = null, adsErro = null;
        try {
          adsAtual = await somaAds(adsJ.atualDe, adsJ.atualAte);
          adsAnterior = await somaAds(adsJ.anteriorDe, adsJ.anteriorAte);
        } catch (e) { adsErro = e.message || String(e); }

        const semanaAtual = atual.total, semanaAnterior = anterior.total;
        return {
          periodo, semanaAtual, semanaAnterior,
          variacaoPct: semanaAnterior > 0 ? ((semanaAtual - semanaAnterior) / semanaAnterior) * 100 : (semanaAtual > 0 ? Infinity : 0),
          atualizadoEm: new Date().toISOString(),
          incompleto: falhas.length > 0,
          avisoIncompleto: falhas.length ? `Não consegui buscar ${[...new Set(falhas)].join(', ')} mesmo com retry — o faturamento está SUBESTIMADO. Clique em Atualizar pra tentar de novo.` : null,
          adsAtual, adsAnterior, adsErro, adsJanelaReduzida: adsJ.reduzida,
        };
      })();
      negEmAndamento[chave] = promessa;
      promessa.catch(() => { if (negEmAndamento[chave] === promessa) delete negEmAndamento[chave]; });
      return promessa;
    }

    async function buscarNegocio(contaId, periodo, forcar) {
      if (!contaId || contaId === '__novo__') return;
      periodo = periodo || state.negocioPeriodo;
      state.carregandoNegocio = true;
      render();
      try {
        state.negocioPorConta[contaId + ':' + periodo] = await calcularNegocio(contaId, periodo, forcar);
      } catch (e) {
        state.negocioPorConta[contaId + ':' + periodo] = { erro: e.message || String(e) };
      } finally {
        state.carregandoNegocio = false;
        render();
      }
    }

    // ── Dados ao vivo das campanhas (tabela + contexto do chat), no período
    // selecionado. Faturamento e totais de ADS vêm de calcularNegocio (mesma
    // fonte dos indicadores). Aqui só busca o que é por campanha. ──
    async function buscarDadosAoVivo(contaId, periodo, forcar) {
      if (!contaId || contaId === '__novo__') return;
      periodo = periodo || state.negocioPeriodo;
      state.carregandoDadosAoVivo = true;
      render();
      try {
        const shopId = contaId;
        const adsJ = janelaAds(periodo);
        const inicioBR = isoParaBR(adsJ.atualDe), fimBR = isoParaBR(adsJ.atualAte);
        const inicioMs = new Date(adsJ.atualDe + 'T00:00:00').getTime();
        const campanhas = await listarTodasCampanhasShopee(shopId);
        const settingsPorId = {}, diarioPorId = {};
        const ids = campanhas.map(c => c.campaign_id);
        let falhasSettings = 0, falhasDiario = 0, lotesSettings = 0, lotesDiario = 0, ultimoErro = '';

        // 1) status/orçamento/meta de ROAS de todas as campanhas listadas
        for (let i = 0; i < ids.length; i += 20) {
          lotesSettings++;
          const r = await MarketplaceAPI.call('shopee_ads_campaign_settings', { shopId, campaign_id_list: ids.slice(i, i + 20).join(',') })
            .catch((e) => { falhasSettings++; ultimoErro = e.message || String(e); return null; });
          (r?.data?.response?.campaign_list || r?.response?.campaign_list || []).forEach(c => {
            settingsPorId[c.campaign_id] = { ...(c.common_info || {}), roas_target: c.auto_bidding_info?.roas_target ?? null };
          });
        }
        // 2) métricas diárias só das campanhas que importam: ativas, pausadas
        // ou encerradas dentro da janela (o resto é histórico morto — a conta
        // lista centenas de campanhas antigas).
        const idsRelevantes = ids.filter(id => {
          const s = settingsPorId[id];
          if (!s) return false;
          const st = (s.campaign_status || '').toLowerCase();
          if (st === 'ongoing' || st === 'paused') return true;
          const fim = s.campaign_duration?.end_time;
          return fim ? fim * 1000 >= inicioMs : false;
        });
        for (let i = 0; i < idsRelevantes.length; i += 20) {
          lotesDiario++;
          const r = await MarketplaceAPI.call('shopee_ads_campaign_daily', { shopId, campaign_id_list: idsRelevantes.slice(i, i + 20).join(','), start_date: inicioBR, end_date: fimBR })
            .catch((e) => { falhasDiario++; ultimoErro = e.message || String(e); return null; });
          (r?.data?.response?.campaign_list || r?.response?.campaign_list || []).forEach(c => {
            const dias = c.metrics_list || [];
            diarioPorId[c.campaign_id] = {
              gasto: dias.reduce((s, d) => s + (parseFloat(d.expense) || 0), 0),
              gmv: dias.reduce((s, d) => s + (parseFloat(d.broad_gmv) || 0), 0),
              pedidos: dias.reduce((s, d) => s + (parseInt(d.broad_order) || 0), 0),
              impressoes: dias.reduce((s, d) => s + (parseInt(d.impression) || 0), 0),
              cliques: dias.reduce((s, d) => s + (parseInt(d.clicks) || 0), 0),
            };
          });
        }

        let pedidosTotal = 0, ativas = 0;
        const porCampanha = [];
        idsRelevantes.forEach(id => {
          const s = settingsPorId[id], d = diarioPorId[id];
          if (!s || !d) return;
          if (d.gasto <= 0 && d.gmv <= 0) return; // sem atividade na janela, ignora
          pedidosTotal += d.pedidos;
          if ((s.campaign_status || '').toLowerCase() === 'ongoing') ativas++;
          const acos = d.gmv > 0 ? (d.gasto / d.gmv * 100) : (d.gasto > 0 ? Infinity : 0);
          porCampanha.push({ id, nome: s.ad_name || `Campanha ${id}`, budget: parseFloat(s.campaign_budget) || 0, roasTarget: s.roas_target, gasto: d.gasto, gmv: d.gmv, acos, status: s.campaign_status, impressoes: d.impressoes || 0, cliques: d.cliques || 0, pedidos: d.pedidos || 0, ctr: d.impressoes > 0 ? (d.cliques / d.impressoes * 100) : 0 });
        });
        porCampanha.sort((a, b) => b.gasto - a.gasto);

        let resultado;
        // Se as chamadas falharam por completo, "0 campanhas" seria enganoso —
        // parece "conta sem campanha" quando na verdade é "não consegui buscar".
        if (campanhas.length > 0 && (falhasSettings >= lotesSettings || (lotesDiario > 0 && falhasDiario >= lotesDiario))) {
          resultado = { erro: `Não consegui buscar métricas das ${campanhas.length} campanhas agora. Erro real: "${ultimoErro || 'desconhecido'}". Tente "Atualizar" de novo em alguns minutos.` };
        } else {
          let neg = null;
          try { neg = await calcularNegocio(shopId, periodo, forcar); } catch (e) { /* segue sem faturamento */ }
          const faturamentoTotal = neg ? neg.semanaAtual : 0;
          const zero = { gasto: 0, gmv: 0, impressoes: 0, cliques: 0, pedidos: 0 };
          const A = neg?.adsAtual || zero, P = neg?.adsAnterior || zero;
          const gastoTotal = A.gasto, gmvTotal = A.gmv;
          const variacaoPct = (atual, anterior) => anterior > 0 ? ((atual - anterior) / anterior * 100) : (atual > 0 ? Infinity : null);
          resultado = {
            periodo, atualizadoEm: new Date().toISOString(),
            campanhasAtivas: ativas, gastoTotal, gmvTotal, pedidosTotal, faturamentoTotal,
            tacosGeral: faturamentoTotal > 0 ? (gastoTotal / faturamentoTotal * 100) : (gastoTotal > 0 ? Infinity : 0),
            acosGeral: gmvTotal > 0 ? (gastoTotal / gmvTotal * 100) : (gastoTotal > 0 ? Infinity : 0),
            impressoesTotal: A.impressoes, cliquesTotal: A.cliques, pedidosAdsTotal: A.pedidos,
            ctrGeral: A.impressoes > 0 ? (A.cliques / A.impressoes * 100) : 0,
            crGeral: A.cliques > 0 ? (A.pedidos / A.cliques * 100) : 0,
            cpcGeral: A.cliques > 0 ? (gastoTotal / A.cliques) : 0,
            impressoesAnterior: P.impressoes, cliquesAnterior: P.cliques, pedidosAdsAnterior: P.pedidos, gmvAnterior: P.gmv,
            variacaoImpressoes: variacaoPct(A.impressoes, P.impressoes),
            variacaoCliques: variacaoPct(A.cliques, P.cliques),
            variacaoPedidosAds: variacaoPct(A.pedidos, P.pedidos),
            variacaoGmv: variacaoPct(gmvTotal, P.gmv),
            topCampanhas: porCampanha.slice(0, 8),
            todasCampanhas: porCampanha,
            avisoParcial: (falhasSettings > 0 || falhasDiario > 0 || !neg || neg.adsErro) ? 'Algumas campanhas ou totais podem estar faltando — houve falha parcial ao buscar dados da Shopee.' : null,
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

    // ── Curva ABC de vendas por produto + alerta de projeção ─────────
    // Pedido do analista: a IA tem que entender de curva A e avisar quando um
    // produto que cresceu no mês passado está projetando queda neste mês,
    // pra agir em conjunto. A Shopee não tem ranking por produto da conta
    // inteira (shopee_sales_by_item exige item_id), então agrega a partir dos
    // pedidos. Mês fechado nunca muda → fica em cache local pra sempre; só o
    // mês corrente é rebuscado. Receita exclui cancelados/devolvidos.
    const ABC_PREFIXO = 'glr_agente_abc_';
    const ABC_STATUS = ['COMPLETED', 'READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'INVOICE_PENDING'];
    const ABC_CRESCIMENTO_MIN = 0.10; // "estava crescendo": mês passado ≥ +10% sobre o retrasado
    const ABC_QUEDA_PROJ = -0.15;     // projeção do mês ≤ -15% sobre o mês passado
    const ABC_QUEDA_FORTE_A = -0.25;  // produto A: alerta mesmo sem ter crescido antes
    const ABC_DIA_MIN_PROJECAO = 5;   // antes disso a projeção linear é ruído

    function abcLerCache(contaId) { try { return JSON.parse(localStorage.getItem(ABC_PREFIXO + contaId) || '{}'); } catch (e) { return {}; } }
    function abcSalvarCache(contaId, c) { try { localStorage.setItem(ABC_PREFIXO + contaId, JSON.stringify(c)); } catch (e) { /* cache é só otimização */ } }
    function abcChaveMes(ano, mes0) { return `${ano}-${String(mes0 + 1).padStart(2, '0')}`; }

    async function abcAgregarMes(shopId, ano, mes0, ateDia, onProgresso) {
      const tsFrom = Math.floor(new Date(ano, mes0, 1, 0, 0, 0).getTime() / 1000);
      const tsTo = Math.floor(new Date(ano, mes0, ateDia || new Date(ano, mes0 + 1, 0).getDate(), 23, 59, 59).getTime() / 1000);
      const sns = await MarketplaceAPI.shopeeListOrderSns(shopId, tsFrom, tsTo, ABC_STATUS);
      const itens = {};
      for (let i = 0; i < sns.length; i += 50) {
        if (onProgresso) onProgresso(i, sns.length);
        const lote = sns.slice(i, i + 50).map(o => o.sn);
        let rd;
        // Um lote que falha não pode virar "venda menor" em silêncio (mesmo
        // bug que já mordeu o faturamento) — tenta de novo e, se persistir,
        // aborta o mês inteiro em vez de gravar número incompleto no cache.
        try { rd = await MarketplaceAPI.call('shopee_get_order_detail', { shopId, order_sn_list: lote }); }
        catch (e) { rd = await MarketplaceAPI.call('shopee_get_order_detail', { shopId, order_sn_list: lote }); }
        const lista = rd.data?.response?.order_list || rd.data?.order_list || [];
        for (const ord of lista) {
          if (!ord.create_time || ord.create_time < tsFrom || ord.create_time > tsTo) continue;
          for (const it of (ord.item_list || ord.items || [])) {
            const id = String(it.item_id || it.item_name);
            const qtd = parseInt(it.model_quantity_purchased) || parseInt(it.quantity) || 1;
            const preco = parseFloat(it.model_discounted_price) || parseFloat(it.item_price) || 0;
            if (!itens[id]) itens[id] = { nome: it.item_name || it.model_name || id, receita: 0, un: 0 };
            itens[id].receita += preco * qtd;
            itens[id].un += qtd;
          }
        }
      }
      return itens;
    }

    function abcAnalisar(cache) {
      const hoje = new Date();
      const ano = hoje.getFullYear(), m0 = hoje.getMonth();
      const d1 = new Date(ano, m0 - 1, 1), d2 = new Date(ano, m0 - 2, 1);
      const k0 = abcChaveMes(ano, m0), k1 = abcChaveMes(d1.getFullYear(), d1.getMonth()), k2 = abcChaveMes(d2.getFullYear(), d2.getMonth());
      const mes0 = cache[k0]?.itens || {}, mes1 = cache[k1]?.itens, mes2 = cache[k2]?.itens || {};
      if (!mes1) return null;
      const diasNoMes = new Date(ano, m0 + 1, 0).getDate();
      const diasDecorridos = hoje.getDate() - 1; // até ontem
      const projecaoOk = diasDecorridos >= ABC_DIA_MIN_PROJECAO;

      const ordenados = Object.entries(mes1).map(([id, v]) => ({ id, ...v })).filter(p => p.receita > 0).sort((a, b) => b.receita - a.receita);
      const total1 = ordenados.reduce((s, p) => s + p.receita, 0);
      let acum = 0;
      const produtos = ordenados.map(p => {
        const classe = acum < total1 * 0.8 ? 'A' : acum < total1 * 0.95 ? 'B' : 'C';
        acum += p.receita;
        const r1 = p.receita, r2 = mes2[p.id]?.receita || 0, r0 = mes0[p.id]?.receita || 0;
        const proj = diasDecorridos >= 1 ? (r0 / diasDecorridos) * diasNoMes : null;
        const crescimentoAnterior = r2 > 0 ? (r1 - r2) / r2 : null;
        const varProj = projecaoOk && proj != null ? (proj - r1) / r1 : null;
        let alerta = null;
        if (varProj != null && classe !== 'C') {
          if (crescimentoAnterior != null && crescimentoAnterior >= ABC_CRESCIMENTO_MIN && varProj <= ABC_QUEDA_PROJ) alerta = 'virada';
          else if (classe === 'A' && varProj <= ABC_QUEDA_FORTE_A) alerta = 'queda_a';
        }
        return { id: p.id, nome: p.nome, classe, r2, r1, r0, proj, crescimentoAnterior, varProj, alerta, impacto: proj != null ? r1 - proj : 0 };
      });
      const resumo = { A: 0, B: 0, C: 0 };
      produtos.forEach(p => resumo[p.classe]++);
      return {
        k0, k1, k2, diasDecorridos, diasNoMes, projecaoOk, total1, resumo, produtos,
        alertas: produtos.filter(p => p.alerta).sort((a, b) => b.impacto - a.impacto).slice(0, 8),
        semMes2: !cache[k2],
      };
    }

    async function abcAtualizar(contaId) {
      if (!contaId || contaId === '__novo__' || state.carregandoABC) return;
      state.carregandoABC = true;
      state.abcProgresso = 'preparando...';
      render();
      try {
        const hoje = new Date();
        const ano = hoje.getFullYear(), m0 = hoje.getMonth();
        const cache = abcLerCache(contaId);
        const meses = [new Date(ano, m0 - 2, 1), new Date(ano, m0 - 1, 1), new Date(ano, m0, 1)];
        for (const d of meses) {
          const k = abcChaveMes(d.getFullYear(), d.getMonth());
          const ehAtual = d.getFullYear() === ano && d.getMonth() === m0;
          if (!ehAtual && cache[k]?.itens) continue; // mês fechado já em cache
          if (ehAtual && hoje.getDate() === 1) { cache[k] = { itens: {}, atualizadoEm: Date.now() }; continue; }
          const label = d.toLocaleDateString('pt-BR', { month: 'long' });
          state.abcProgresso = `lendo pedidos de ${label}...`;
          render();
          const itens = await abcAgregarMes(contaId, d.getFullYear(), d.getMonth(), ehAtual ? hoje.getDate() - 1 : null, (i, n) => {
            state.abcProgresso = `lendo pedidos de ${label}: ${i}/${n}`;
            const el = document.getElementById('ag-abc-prog'); if (el) el.textContent = '⏳ ' + state.abcProgresso;
          });
          cache[k] = { itens, atualizadoEm: Date.now() };
          abcSalvarCache(contaId, cache);
        }
        abcSalvarCache(contaId, cache);
        const analise = abcAnalisar(cache);
        state.abcPorConta[contaId] = analise ? { ...analise, atualizadoEm: Date.now() } : { erro: 'Sem vendas no mês passado pra montar a curva.' };
        if (analise?.alertas.length) await abcCriarAlertas(contaId, analise);
      } catch (e) {
        state.abcPorConta[contaId] = { erro: e.message || String(e) };
      } finally {
        state.carregandoABC = false;
        state.abcProgresso = '';
        render();
      }
    }

    function abcCarregarDoCache(contaId) {
      if (!contaId || state.abcPorConta[contaId]) return;
      const cache = abcLerCache(contaId);
      const analise = abcAnalisar(cache);
      const atual = cache[abcChaveMes(new Date().getFullYear(), new Date().getMonth())];
      if (analise) state.abcPorConta[contaId] = { ...analise, atualizadoEm: atual?.atualizadoEm || null };
    }

    // Um alerta por produto por mês (não repete a cada atualização).
    async function abcCriarAlertas(contaId, a) {
      const cfg = configDaConta(contaId);
      const mesAtual = new Date().toISOString().slice(0, 7);
      for (const p of a.alertas) {
        const titulo = p.alerta === 'virada'
          ? `Curva ${p.classe} em risco — ${p.nome.slice(0, 60)}`
          : `Queda em produto curva A — ${p.nome.slice(0, 60)}`;
        const jaExiste = state.logs.some(l => l.conta_id === contaId && l.titulo === titulo && String(l.criado_em).slice(0, 7) === mesAtual);
        if (jaExiste) continue;
        const cresc = p.crescimentoAnterior != null ? `${p.crescimentoAnterior >= 0 ? '+' : ''}${(p.crescimentoAnterior * 100).toFixed(0)}%` : '—';
        const explicacao = p.alerta === 'virada'
          ? `Produto curva ${p.classe} que vinha crescendo (mês passado ${cresc} sobre o retrasado: ${R$(p.r2)} → ${R$(p.r1)}) e agora projeta ${R$(p.proj)} no mês (${(p.varProj * 100).toFixed(0)}% vs mês passado, projeção linear com ${a.diasDecorridos} dia(s) de dados). Impacto estimado: ${R$(p.impacto)}. Vale revisar anúncio, preço, estoque e ADS desse produto em conjunto.`
          : `Produto curva A (parte dos ~80% da receita) projetando ${R$(p.proj)} no mês contra ${R$(p.r1)} no mês passado (${(p.varProj * 100).toFixed(0)}%, projeção linear com ${a.diasDecorridos} dia(s) de dados). Impacto estimado: ${R$(p.impacto)}. Vale revisar anúncio, preço, estoque e ADS desse produto em conjunto.`;
        try {
          await _sb.from('glr_agente_log').insert({
            conta_id: contaId, cliente_nome: cfg?.cliente_nome || null, tipo: 'alerta', titulo, explicacao,
            dados: { origem_analise: 'curva_abc', produto_id: p.id, classe: p.classe, receita_mes_retrasado: p.r2, receita_mes_passado: p.r1, projecao_mes: p.proj, variacao_projecao_pct: p.varProj * 100 },
            resultado: 'so_alerta', origem: 'chat',
          });
        } catch (e) { /* um alerta falhando não derruba os outros */ }
      }
      const { data } = await _sb.from('glr_agente_log').select('*').order('criado_em', { ascending: false }).limit(250);
      if (data) state.logs = data;
    }

    function renderCurvaABC(contaId) {
      const a = state.abcPorConta[contaId];
      const carregando = state.carregandoABC;
      const pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
      const COR_CLASSE = { A: '#16a34a', B: '#d97706', C: '#64748b' };
      const cor = a && !a.erro && a.alertas.length ? '#dc2626' : '#6366f1';
      const mesLabel = k => { const [y, m] = k.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }); };
      let corpo;
      if (carregando) corpo = `<div id="ag-abc-prog" style="color:var(--text-muted);font-size:13px;">⏳ ${esc(state.abcProgresso || 'calculando...')}</div><div style="font-size:11.5px;color:var(--text-muted);margin-top:6px;">A primeira leitura puxa 3 meses de pedidos e pode levar alguns minutos — os meses fechados ficam guardados e as próximas atualizações leem só o mês atual.</div>`;
      else if (!a) corpo = `<div style="color:var(--text-muted);font-size:13px;">Ainda não analisado. Clique em Analisar pra montar a curva e comparar a projeção do mês com o mês passado.</div>`;
      else if (a.erro) corpo = `<div style="color:#dc2626;font-size:13px;">⚠️ ${esc(a.erro)}</div>`;
      else {
        const top = a.produtos.filter(p => p.classe === 'A' || p.alerta).slice(0, 12);
        corpo = `
          <div style="display:flex;gap:22px;flex-wrap:wrap;margin-bottom:12px;">
            ${['A', 'B', 'C'].map(c => `<div><div class="ag-hud-label" style="margin-bottom:2px;">Curva ${c}</div><div class="ag-mono" style="font-size:20px;font-weight:800;color:${COR_CLASSE[c]};">${a.resumo[c]}</div></div>`).join('')}
            <div><div class="ag-hud-label" style="margin-bottom:2px;">Receita ${mesLabel(a.k1)}</div><div class="ag-mono" style="font-size:20px;font-weight:800;">${R$(a.total1)}</div></div>
          </div>
          ${a.alertas.length ? `<div style="background:#dc26261a;border:1px solid #dc2626;border-radius:8px;padding:10px 12px;margin-bottom:12px;">
            <div style="font-size:12.5px;font-weight:800;color:#dc2626;margin-bottom:6px;">🚨 ${a.alertas.length} produto(s) pedindo ação conjunta</div>
            ${a.alertas.map(p => `<div style="font-size:12px;line-height:1.5;margin-top:4px;"><b>${esc(p.nome.slice(0, 70))}</b> <span class="ag-action-chip" style="color:${COR_CLASSE[p.classe]};background:${COR_CLASSE[p.classe]}1a;">Curva ${p.classe}</span> — ${p.alerta === 'virada' ? `vinha crescendo (${pct(p.crescimentoAnterior)}) e` : ''} projeta ${R$(p.proj)} (${pct(p.varProj)} vs ${mesLabel(a.k1)}), impacto ≈ ${R$(p.impacto)}</div>`).join('')}
          </div>` : (a.projecaoOk ? `<div style="font-size:12.5px;color:#16a34a;margin-bottom:12px;">✅ Nenhum produto A/B com queda projetada relevante neste mês.</div>` : `<div style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px;">Projeção do mês só é confiável a partir do dia ${ABC_DIA_MIN_PROJECAO + 1} (hoje há ${a.diasDecorridos} dia(s) de dados) — por enquanto sem alertas.</div>`)}
          <div style="overflow-x:auto;"><table class="ag-tech-table"><thead><tr><th>Produto</th><th>Classe</th><th>${mesLabel(a.k2)}</th><th>${mesLabel(a.k1)}</th><th>Projeção ${mesLabel(a.k0)}</th><th>Variação</th></tr></thead><tbody>
            ${top.map(p => `<tr style="--row-accent:${COR_CLASSE[p.classe]};"><td>${esc(p.nome.slice(0, 55))}</td><td><span class="ag-action-chip" style="color:${COR_CLASSE[p.classe]};background:${COR_CLASSE[p.classe]}1a;">${p.classe}</span></td><td class="ag-mono">${a.semMes2 ? '—' : R$(p.r2)}</td><td class="ag-mono">${R$(p.r1)}</td><td class="ag-mono">${p.proj != null && a.projecaoOk ? R$(p.proj) : '—'}</td><td class="ag-mono" style="font-weight:800;color:${p.varProj == null ? 'var(--text-muted)' : p.varProj <= ABC_QUEDA_PROJ ? '#dc2626' : '#16a34a'};">${p.varProj == null ? '—' : pct(p.varProj)}</td></tr>`).join('')}
          </tbody></table></div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">Curva A = produtos que somam ~80% da receita de ${mesLabel(a.k1)}, B até 95%, C o resto. Projeção linear (receita até ontem ÷ dias decorridos × dias do mês), receita sem cancelados.${a.atualizadoEm ? ` Atualizado ${new Date(a.atualizadoEm).toLocaleString('pt-BR')}.` : ''}</div>`;
      }
      return `<div class="ag-hud-card" style="--ag-hud-accent:${cor};margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:2px;">
          <div style="font-size:14px;font-weight:800;">🅰️ Curva ABC de vendas</div>
          <button class="btn btn-secondary btn-sm" ${carregando ? 'disabled' : ''} onclick="window._agAnalisarABC()">${a && !a.erro ? '🔄 Atualizar' : '▶ Analisar'}</button>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:12px;">Produto que cresceu mês passado e projeta queda neste mês vira alerta na Fila de Atenção, pra decidirmos a ação juntos.</div>
        ${corpo}
      </div>`;
    }

    function nomeConta(c) {
      const tag = c.tags?.[0]?.name || c.tags?.[0];
      return (typeof tag === 'string' ? tag : tag?.value) || c.nickname || c.external_id;
    }
    // Nome da LOJA como aparece na conta do marketplace ("ELATOR - SHOPEE" →
    // "Elator"), não o do cliente/grupo vinculado (várias lojas podem
    // pertencer ao mesmo cliente, ex.: Mega Fácil, e precisam ser distintas).
    function nomeLojaLimpo(c) {
      return String(nomeConta(c) || '').replace(/\s*[-–]\s*shopee\s*$/i, '').trim();
    }
    function nomeExibicao(cfg) {
      const c = state.contasShopee.find(x => String(x.param_to_use?.shopId || x.external_id) === String(cfg.conta_id));
      return (c ? nomeLojaLimpo(c) : '') || cfg.cliente_nome || cfg.conta_id;
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
      const chkAtivo = document.getElementById('ag-ativo');
      const ativo = chkAtivo ? chkAtivo.checked : !!configDaConta(contaId)?.ativo;
      const vinculo = clienteVinculado(contaId);

      const row = {
        conta_id: contaId,
        // Guarda o nome da LOJA (o cliente fica em cliente_id): várias lojas
        // do mesmo grupo não podem aparecer todas com o nome do grupo.
        cliente_nome: contaObj ? nomeLojaLimpo(contaObj) : (vinculo.cliente_nome || contaId),
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
        state.regrasSalvoEm = Date.now();
        await carregarTudo();
        setTimeout(() => render(), 20500);
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
        : `\nDADOS AO VIVO DA SHOPEE (${periodoLabel(d.periodo || state.negocioPeriodo)}, atualizado ${new Date(d.atualizadoEm).toLocaleTimeString('pt-BR')}):\nFaturamento TOTAL da loja: ${R$(d.faturamentoTotal)} | Investimento ADS: ${R$(d.gastoTotal)} | TACOS da conta: ${d.tacosGeral === Infinity ? '∞' : d.tacosGeral.toFixed(1) + '%'} (esta é a métrica principal, não o ACOS isolado abaixo)\nCampanhas ativas: ${d.campanhasAtivas} | Vendas atribuídas ao ADS: ${R$(d.gmvTotal)} | Pedidos atribuídos: ${d.pedidosTotal} | ACOS médio das campanhas: ${d.acosGeral === Infinity ? '∞ (gastou sem vender nada)' : d.acosGeral.toFixed(1) + '%'}\nTop campanhas por investimento (ACOS individual, útil só pra comparar entre elas — use o ID exato ao sugerir mudança):\n${d.topCampanhas.map(c => `- ID ${c.id} — ${(c.nome || '').slice(0, 60)}: status ${c.status === 'ongoing' ? 'ATIVA' : c.status === 'paused' ? 'PAUSADA' : c.status || '—'}, orçamento ${R$(c.budget)}${c.roasTarget != null ? `, meta de ROAS atual ${c.roasTarget}x (lance automático)` : ''}, gasto ${R$(c.gasto)}, vendas (GMV) ${R$(c.gmv)}, ACOS ${c.acos === Infinity ? '∞' : c.acos.toFixed(1) + '%'}`).join('\n') || '(nenhuma campanha ativa com dados na janela)'}`;
      const neg = state.negocioPorConta[state.contaAbertaId + ':' + state.negocioPeriodo];
      const negTexto = neg && !neg.erro ? `\nSAÚDE DO NEGÓCIO (período: ${state.negocioPeriodo === 'mes' ? 'mês atual' : state.negocioPeriodo + ' dias'}): faturamento ${R$(neg.semanaAtual)} vs período anterior equivalente ${R$(neg.semanaAnterior)} (${neg.variacaoPct === Infinity ? '∞' : (neg.variacaoPct >= 0 ? '+' : '') + neg.variacaoPct.toFixed(1) + '%'}).` : '';
      const abc = state.abcPorConta[state.contaAbertaId];
      const abcTexto = abc && !abc.erro
        ? `\nCURVA ABC DE VENDAS (base: receita de ${abc.k1}; A = ~80% da receita, B até 95%, C o resto; ${abc.resumo.A} produtos A, ${abc.resumo.B} B, ${abc.resumo.C} C; receita do mês passado ${R$(abc.total1)}). Top produtos A (receita ${abc.k2} → ${abc.k1} → projeção ${abc.k0}):\n${abc.produtos.filter(p => p.classe === 'A').slice(0, 10).map(p => `- ${p.nome.slice(0, 60)}: ${R$(p.r2)} → ${R$(p.r1)} → ${p.proj != null && abc.projecaoOk ? R$(p.proj) + ' (' + (p.varProj >= 0 ? '+' : '') + (p.varProj * 100).toFixed(0) + '%)' : 'projeção ainda sem dados suficientes'}`).join('\n')}\n${abc.alertas.length ? 'ALERTAS ABC: ' + abc.alertas.map(p => `${p.nome.slice(0, 50)} (curva ${p.classe}, ${p.alerta === 'virada' ? 'vinha crescendo e' : ''} projeta ${(p.varProj * 100).toFixed(0)}% vs mês passado)`).join('; ') : 'Nenhum alerta ABC no momento.'}`
        : '';
      return [
        cfg ? `CONFIGURAÇÃO ATUAL DO PILOTO (conta ${nomeExibicao(cfg)}, ${cfg.ativo ? 'ATIVO' : 'inativo'}):` : 'Nenhuma conta piloto configurada ainda.',
        cfg ? `Meta TACOS: ${cfg.meta_acos ?? '—'}% (métrica principal: investimento ADS ÷ faturamento TOTAL da loja, não ACOS isolado) | Orçamento: ${cfg.orcamento_min ?? '—'} a ${cfg.orcamento_max ?? '—'} | Margem: ${cfg.margem_pct ?? '—'}% | Estoque mínimo: ${cfg.estoque_minimo ?? '—'} | Pausa automática acima de ${cfg.regra_pausa_acos ?? '—'}% ACOS por ${cfg.regra_pausa_dias ?? '—'} dia(s), só após ${cfg.dias_maturacao_campanha ?? 7} dia(s) de maturação da campanha | Alerta humano se variação de orçamento > ${cfg.alerta_variacao_pct ?? '—'}% | Notas: ${cfg.notas || '—'}` : '',
        cfg ? dadosTexto : '',
        cfg ? negTexto : '',
        cfg ? abcTexto : '',
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
        sugestoes = Array.isArray(arr) ? arr.filter(s => s && s.campaign_id != null && ['pausar', 'orcamento', 'roas', 'retomar'].includes(s.tipo)) : [];
      } catch (e) { /* JSON malformado — ignora, trata como se não tivesse sugestão */ }
      return { sugestoes, textoLimpo: texto.replace(m[0], '').trim() };
    }

    async function criarSugestoesNoKanban(sugestoes) {
      const cfg = configDaConta(state.contaAbertaId);
      const contaId = state.contaAbertaId;
      for (const s of sugestoes) {
        // Ads usa campaign_id; estoque/preço (Fundação do Analista GLR,
        // módulos ainda não produzem essas sugestões sozinhos, mas o Kanban
        // já reconhece o formato) usam item_id — dados começa vazio e cada
        // tipo preenche o que precisa, em vez de assumir campaign_id sempre.
        const dados = {};
        if (s.tipo === 'roas') { dados.campaign_id = Number(s.campaign_id); dados.roas_atual = s.valor_atual; dados.roas_sugerido = s.valor_sugerido; }
        else if (s.tipo === 'orcamento') { dados.campaign_id = Number(s.campaign_id); dados.budget_atual = s.valor_atual; dados.budget_sugerido = s.valor_sugerido; }
        else if (s.tipo === 'pausar') { dados.campaign_id = Number(s.campaign_id); dados.pausar = true; }
        else if (s.tipo === 'retomar') { dados.campaign_id = Number(s.campaign_id); dados.retomar = true; if (s.valor_sugerido != null) { dados.roas_atual = s.valor_atual; dados.roas_sugerido = s.valor_sugerido; } }
        else if (s.tipo === 'estoque') { dados.item_id = s.item_id; dados.marketplace = s.marketplace; dados.model_id = s.model_id; dados.estoque_atual = s.valor_atual; dados.estoque_sugerido = s.valor_sugerido; }
        else if (s.tipo === 'preco') { dados.item_id = s.item_id; dados.marketplace = s.marketplace; dados.model_id = s.model_id; dados.preco_atual = s.valor_atual; dados.preco_sugerido = s.valor_sugerido; }
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
      renderChatDrawer(true);

      try {
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system: `Você é o Agente Autônomo de ADS da GLR Consultoria. Você mesmo decide pausar campanha, retomar campanha e ajustar orçamento/meta de ROAS diariamente com base nas regras configuradas pelo analista — sem precisar de aprovação manual, exceto quando a variação proposta passa do limite de alerta configurado. A métrica principal pra julgar a saúde da conta é o TACOS (investimento em ADS dividido pelo faturamento TOTAL da loja, não só a venda atribuída ao ADS) — NUNCA trate ACOS isolado de uma campanha como veredito sobre a conta inteira, ele só serve pra comparar campanhas entre si. Campanhas novas (dentro do período de maturação configurado) não são pausadas por ACOS ruim ainda, mesmo que o critério tenha sido tecnicamente atingido — dá tempo delas amadurecerem primeiro. Muitas campanhas individuais hoje em dia (modo GMV Max por produto, lance automático) são geridas pelo algoritmo da própria Shopee/TikTok — o papel do agente aí é ajustar o guardrail (meta de ROAS), não microgerenciar lance por lance. O agente só mexe em campanhas individuais — o GMV Max da Loja (campanha única, guarda-chuva, por conta inteira) está fora do escopo por decisão do analista, não monitorado nem ajustado. Converse em português, direto, como um analista sênior explicando decisões pra outro analista. Você também entende de curva ABC de vendas (A = produtos que somam ~80% da receita, B até 95%, C o resto): produto curva A que cresceu e projeta queda é prioridade de atenção, e nesses casos você levanta o alerta e propõe a ação junto com o analista (revisar anúncio, preço, estoque, ADS) em vez de decidir sozinho — use o bloco CURVA ABC do contexto quando existir. Use os dados de contexto abaixo (configuração, dados ao vivo, saúde do negócio, último relatório, log recente) pra responder — nunca invente números que não estão aí, nunca invente campaign_id que não apareça na lista "Top campanhas" do contexto.\n\nQUANDO O ANALISTA PEDIR UMA MUDANÇA CONCRETA (ex: "aumenta o investimento", "pausa a campanha X", "sobe a meta de ROAS da campanha Y", "reduz orçamento de Z"): responda com no máximo 2 frases confirmando o que você está sugerindo e por quê, e termine a mensagem com um bloco \`\`\`json contendo um array de sugestões, uma por campanha, no formato exato: [{"campaign_id": <ID numérico exato do contexto>, "nome_campanha": "<nome curto>", "tipo": "pausar"|"orcamento"|"roas"|"retomar", "valor_atual": <número, omita se tipo=pausar>, "valor_sugerido": <número, omita se tipo=pausar>, "titulo": "<título curto pro card, ex: Aumentar orçamento — Nome da campanha>", "explicacao": "<1-2 frases explicando o motivo, com os números que embasam>"}]. Use tipo \"roas\" só pra campanha que already tem \"meta de ROAS atual\" no contexto (lance automático); use \"orcamento\" só pra campanha com orçamento fixo (budget > 0); nunca sugira os dois tipos pra mesma campanha na mesma resposta. Use tipo \"retomar\" só pra campanha que o contexto mostra como PAUSADA, quando o analista pedir pra reativar; se ele quiser reativar E mudar a meta de ROAS, use tipo \"retomar\" com valor_atual/valor_sugerido da meta de ROAS (o card faz as duas coisas ao aprovar). Nunca escreva no título/explicação que vai reativar uma campanha se o tipo não for \"retomar\" — o card só executa o que o tipo diz. NÃO execute nada você mesmo pelo chat — a sugestão vira um card na Fila de Atenção (Kanban) e só é aplicada de verdade quando o analista clicar em \"Aprovar\" ali. Se o pedido for só uma pergunta ou pedir explicação (\"por que caiu tal coisa\", \"como está a conta\"), responda em texto normal e NÃO inclua o bloco \`\`\`json. Se o analista pedir pra mudar uma regra/guardrail (meta TACOS, regra de pausa, etc — não uma campanha específica), explique que isso se edita no painel de configuração da aba, você não altera a config pelo chat.\n\n${contextoAgente()}`,
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
          resposta = (resposta ? resposta + '\n\n' : '') + `📋 Criei ${sugestoes.length} sugestão${sugestoes.length > 1 ? 'ões' : ''} — veja em "Precisa de você", no topo da tela, pra aprovar ou rejeitar.`;
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
        renderChatDrawer(true);
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
                <div style="font-size:15px;font-weight:800;">${h(nomeExibicao(cfg))}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Shopee · ${cfg.ativo ? 'piloto ativo' : 'piloto pausado'}${clienteVinculado(cfg.conta_id).cliente_nome ? ` · cliente ${h(clienteVinculado(cfg.conta_id).cliente_nome)}` : ''}</div>
              </div>
              <span style="font-size:20px;line-height:1;" title="${saude.label}">${saude.emoji}</span>
            </div>
            <div style="display:flex;gap:18px;margin-top:14px;">
              <div><div class="ag-hud-label" style="margin-bottom:2px;">TACOS</div><div class="ag-mono" style="font-size:18px;font-weight:800;">${tacos != null ? fmtPct(tacos) : '—'}</div></div>
              <div><div class="ag-hud-label" style="margin-bottom:2px;">Fila</div><div class="ag-mono" style="font-size:18px;font-weight:800;color:${pendencias ? '#d97706' : 'inherit'};">${pendencias}</div></div>
            </div>
          </div>`;
        }).join('')}
        <div class="ag-hud-card" style="--ag-hud-accent:#64748b;cursor:pointer;border-style:dashed;display:flex;align-items:center;justify-content:center;min-height:110px;" onclick="window._agAbrirConta('__novo__')">
          <div style="text-align:center;color:var(--text-muted);font-size:13px;font-weight:600;">+ Adicionar conta</div>
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
            tacos: r.tacos_conta != null ? fmtPct(r.tacos_conta) : '—',
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
      return `<details class="ag-sec" ${state.sec.manual ? 'open' : ''} ontoggle="window._agToggleSec('manual', this.open)">
      <summary>⚡ Ajuste manual avançado (1 campanha na mão)</summary>
      <div class="ag-hud-card" style="--ag-hud-accent:#dc2626;margin-top:10px;">
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;">Só pra casos pontuais — pode colar o ID aqui ou usar "✏️ Ajustar à mão" no menu ⋯ da linha da campanha, que já preenche tudo. Pra aumentar investimento, prefira "🚀 Sugerir mais investimento" no mesmo menu, que já calcula o valor certo pra você aprovar.</div>
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
      } else if (d.estoque_atual != null && d.estoque_sugerido != null) {
        const subiu = d.estoque_sugerido > d.estoque_atual;
        acaoLabel = subiu ? '▲ Sugestão: repor estoque' : '▼ Sugestão: reduzir estoque';
        acaoCor = subiu ? '#22d3ee' : '#d97706';
        deParaVal = `${d.estoque_atual} un → ${d.estoque_sugerido} un`;
      } else if (d.preco_atual != null && d.preco_sugerido != null) {
        const subiu = d.preco_sugerido > d.preco_atual;
        acaoLabel = subiu ? '▲ Sugestão: subir preço' : '▼ Sugestão: baixar preço';
        acaoCor = subiu ? '#22d3ee' : '#d97706';
        deParaVal = `${R$(d.preco_atual)} → ${R$(d.preco_sugerido)}`;
      } else if ((l.titulo || '').includes('pausada')) {
        acaoLabel = '⏸ Pausada'; acaoCor = '#dc2626';
      }
      if (d.retomar === true) { acaoLabel = '▶ Sugestão: reativar' + (acaoLabel ? ' + ' + acaoLabel.replace('Sugestão: ', '') : ''); acaoCor = '#22d3ee'; }
      else if (d.retomada === true) { acaoLabel = '▶ Reativada' + (acaoLabel ? ' + ' + acaoLabel : ''); acaoCor = '#22d3ee'; }
      else if (d.pausada === true) { acaoLabel = '⏸ Pausada'; acaoCor = '#dc2626'; }
      return { nomeCampanha, acaoLabel, acaoCor, deParaVal, acos: d.acos != null ? n1(d.acos) + '%' : null };
    }

    // Um alerta é "executável" se tiver ação automática reconhecida associada.
    // Ads (campaign_id + roas/budget/pausar) já existia; estoque (item_id +
    // estoque_sugerido) e preço (item_id + preco_sugerido) são novos — parte
    // da Fundação do Analista GLR (nenhum módulo ainda produz esses alertas
    // sozinho, mas o Kanban/aprovação já reconhece o formato pra quando os
    // módulos de Rentabilidade/Estoque existirem, sem precisar mexer aqui de novo).
    function temAcaoReconhecida(d) {
      if (d.campaign_id != null && (d.roas_sugerido != null || d.budget_sugerido != null || d.pausar === true || d.retomar === true)) return 'ads';
      if (d.item_id != null && d.estoque_sugerido != null) return 'estoque';
      if (d.item_id != null && d.preco_sugerido != null) return 'preco';
      return null;
    }

    async function aprovarAlerta(logId) {
      const l = state.logs.find(x => String(x.id) === String(logId));
      if (!l) return;
      const d = l.dados || {};
      const tipoAcao = temAcaoReconhecida(d);
      if (!tipoAcao) {
        alert('Esse alerta é informativo — não tem ação automática associada pra aprovar. Ajuste manualmente no marketplace se for o caso, ou descarte.');
        return;
      }
      const cfg = configDaConta(l.conta_id);
      state.processandoAlertaId = logId;
      render();
      try {
        if (tipoAcao === 'ads') {
          if (d.retomar === true) {
            // Reativar de verdade na Shopee; se a sugestão trouxe também uma
            // meta de ROAS nova ("reativar e apertar ROAS"), aplica depois.
            await MarketplaceAPI.call('shopee_ads_resume_campaign', { shopId: l.conta_id, campaign_id: Number(d.campaign_id) });
            if (d.roas_sugerido != null) {
              await MarketplaceAPI.call('shopee_ads_roi_target', { shopId: l.conta_id, campaign_id: Number(d.campaign_id), roas_target: d.roas_sugerido });
            }
          } else if (d.pausar === true) {
            await MarketplaceAPI.call('shopee_ads_pause_campaign', { shopId: l.conta_id, campaign_id: Number(d.campaign_id) });
          } else if (d.roas_sugerido != null) {
            await MarketplaceAPI.call('shopee_ads_roi_target', { shopId: l.conta_id, campaign_id: Number(d.campaign_id), roas_target: d.roas_sugerido });
          } else {
            await MarketplaceAPI.call('shopee_ads_edit_campaign', {
              shopId: l.conta_id,
              params: { campaign_id: Number(d.campaign_id), budget: d.budget_sugerido, edit_action: 'change_budget', reference_id: `glr-aprovado-${Date.now()}-${d.campaign_id}` },
            });
          }
        } else if (tipoAcao === 'estoque') {
          // marketplace da sugestão decide a ação — Shopee e ML cobertos
          // desde já (ações confirmadas no diagnóstico); outros marketplaces
          // entram conforme forem validados ao vivo, não antes.
          if (d.marketplace === 'ml') {
            await MarketplaceAPI.call('ml_update_variation_stock', { item_id: d.item_id, variation_id: d.model_id, available_quantity: d.estoque_sugerido });
          } else {
            await MarketplaceAPI.call('shopee_update_stock', { shopId: l.conta_id, item_id: Number(d.item_id), model_id: d.model_id ? Number(d.model_id) : undefined, stock: d.estoque_sugerido });
          }
        } else if (tipoAcao === 'preco') {
          if (d.marketplace === 'ml') {
            await MarketplaceAPI.call('ml_update_variations_price', { item_id: d.item_id, price: d.preco_sugerido });
          } else {
            await MarketplaceAPI.call('shopee_update_price', { shopId: l.conta_id, item_id: Number(d.item_id), model_id: d.model_id ? Number(d.model_id) : undefined, price: d.preco_sugerido });
          }
        }
        // A decisão executada usa o formato "de → para" (igual às do cron), não
        // o "atual/sugerido" do alerta — senão o card executado continuava com
        // o selo laranja de "Sugestão" e parecia ainda pendente.
        const dadosExec = { ...d };
        if (d.roas_sugerido != null) { dadosExec.roas_de = d.roas_atual; dadosExec.roas_para = d.roas_sugerido; delete dadosExec.roas_atual; delete dadosExec.roas_sugerido; }
        if (d.budget_sugerido != null) { dadosExec.budget_de = d.budget_atual; dadosExec.budget_para = d.budget_sugerido; delete dadosExec.budget_atual; delete dadosExec.budget_sugerido; }
        if (d.retomar === true) { dadosExec.retomada = true; delete dadosExec.retomar; }
        if (d.pausar === true) { dadosExec.pausada = true; delete dadosExec.pausar; }
        await _sb.from('glr_agente_log').update({ resultado: 'executado' }).eq('id', l.id);
        await _sb.from('glr_agente_log').insert({
          conta_id: l.conta_id, cliente_nome: cfg?.cliente_nome || null, tipo: 'decisao',
          titulo: `Aprovado manualmente — ${(l.titulo || '').replace(/^Sugestão de /, '')}`,
          explicacao: `Alerta aprovado pelo analista. ${l.explicacao || ''}`, dados: dadosExec, resultado: 'executado', origem: 'aprovacao_manual',
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

    // ── Guardrails do piloto: as regras que o agente segue (o "coração") ──
    function numRegra(x) { return x == null || isNaN(x) ? '—' : fmtNum(x, Number.isInteger(x) ? 0 : 1); }
    // Frase em português simples descrevendo EXATAMENTE o que o cron faz com
    // esses números (Regras 1 a 4 de api/agente-cron.js).
    function textoRegras(v) {
      const avisos = [];
      if (v.pausaAcos != null && v.meta != null && v.pausaAcos <= v.meta) avisos.push(`⚠️ O limite de pausa (${numRegra(v.pausaAcos)}%) está igual ou abaixo da meta (${numRegra(v.meta)}%): o agente pausaria antes de tentar conter o gasto.`);
      if (v.orcMin != null && v.orcMax != null && v.orcMin > v.orcMax) avisos.push('⚠️ O orçamento mínimo está maior que o máximo.');
      if (v.pausaAcos == null) avisos.push('⚠️ Sem limite de pausa configurado: o agente não pausa campanha por ACOS alto.');
      if (v.meta == null) avisos.push('⚠️ Sem meta configurada: o agente não aumenta nem reduz investimento sozinho.');
      return `<p><b>Pausa</b> a campanha se o ${sigla('ACOS')} passar de <b>${numRegra(v.pausaAcos)}%</b> por <b>${numRegra(v.pausaDias)} dia(s) seguidos</b> (ou se gastar sem nenhuma venda), mas só depois de <b>${numRegra(v.mat)} dias</b> de vida da campanha.</p>
        <p><b>Cresce sozinho</b> quando o ${sigla('ACOS')} da campanha fica abaixo de <b>${v.meta != null ? numRegra(v.meta * 0.7) : '—'}%</b> (70% da meta de <b>${numRegra(v.meta)}%</b>) e o ${sigla('TACOS')} da conta ainda tem folga: sobe o orçamento 20% (teto de <b>${v.orcMax != null ? R$(v.orcMax) : 'sem teto'}</b>/dia) ou baixa a meta de ${sigla('ROAS')} em 15%.</p>
        <p><b>Contém o gasto</b> quando o ${sigla('ACOS')} passa da meta de <b>${numRegra(v.meta)}%</b> mas ainda não chegou no limite de pausa: aperta a meta de ${sigla('ROAS')} em 15% ou corta o orçamento em 15% (piso de <b>${v.orcMin != null ? R$(v.orcMin) : 'sem piso'}</b>/dia).</p>
        <p><b>Sempre pede sua aprovação</b> quando a mudança proposta passa de <b>${numRegra(v.alerta)}%</b>.</p>
        ${avisos.map(a => `<p class="ag-regras-aviso">${a}</p>`).join('')}`;
    }

    function lerRegrasDoForm() {
      const num = id => { const v = parseFloat(document.getElementById(id)?.value); return isNaN(v) ? null : v; };
      return { pausaAcos: num('ag-pausa-acos'), pausaDias: num('ag-pausa-dias'), mat: num('ag-maturacao'), meta: num('ag-meta-acos'), orcMin: num('ag-orc-min'), orcMax: num('ag-orc-max'), alerta: num('ag-alerta-var') };
    }

    function campoRegra(id, label, valor, o) {
      o = o || {};
      return `<div class="ag-campo">
        <label class="ag-campo-label" for="${id}">${label}</label>
        <div class="ag-campo-grupo"><input type="number" ${o.step ? `step="${o.step}"` : ''} min="0" class="form-input" id="${id}" value="${esc(valor ?? '')}" ${o.ph ? `placeholder="${o.ph}"` : ''}>${o.sufixo ? `<span class="ag-campo-sufixo">${o.sufixo}</span>` : ''}</div>
        ${o.dica ? `<div class="ag-campo-dica">${o.dica}</div>` : ''}
      </div>`;
    }

    function formRegras(cfg, novo) {
      const jaConfiguradas = new Set(state.contas.map(c => c.conta_id));
      const v = { pausaAcos: cfg.regra_pausa_acos, pausaDias: cfg.regra_pausa_dias ?? 3, mat: cfg.dias_maturacao_campanha ?? 7, meta: cfg.meta_acos, orcMin: cfg.orcamento_min, orcMax: cfg.orcamento_max, alerta: cfg.alerta_variacao_pct ?? 30 };
      return `<div id="ag-regras-form" oninput="window._agRegrasMudou()">
        ${novo ? `<div class="ag-campo" style="max-width:420px;margin-bottom:14px;">
          <label class="ag-campo-label" for="ag-conta">Conta Shopee</label>
          <select class="form-select" id="ag-conta">
            <option value="">— Selecione —</option>
            ${state.contasShopee.map(c => {
              const id = c.param_to_use?.shopId || c.external_id;
              const jaConfigurada = jaConfiguradas.has(id) && id !== cfg.conta_id;
              return `<option value="${id}" ${cfg.conta_id === id ? 'selected' : ''} ${jaConfigurada ? 'disabled' : ''}>${esc(nomeConta(c))}${jaConfigurada ? ' (já configurada)' : ''}</option>`;
            }).join('')}
          </select>
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;margin-top:10px;"><input type="checkbox" id="ag-ativo"> Ligar o piloto nesta conta</label>
        </div>` : `<input type="hidden" id="ag-conta" value="${esc(cfg.conta_id)}">`}
        <div class="ag-regras-grid">
          <div class="ag-regra-bloco" style="--c:#dc2626;">
            <div class="ag-regra-tit">🛑 Quando pausar</div>
            ${campoRegra('ag-pausa-acos', `${sigla('ACOS')} da campanha acima de`, cfg.regra_pausa_acos, { step: '0.1', sufixo: '%', dica: 'Limite a partir do qual a campanha é considerada cara demais.' })}
            ${campoRegra('ag-pausa-dias', 'por quantos dias seguidos', cfg.regra_pausa_dias ?? 3, { sufixo: 'dias', dica: 'Evita pausar por um dia ruim isolado.' })}
            ${campoRegra('ag-maturacao', 'Maturação mínima da campanha', cfg.dias_maturacao_campanha ?? 7, { sufixo: 'dias', dica: 'Campanha mais nova que isso não é pausada ainda — só registra um aviso.' })}
          </div>
          <div class="ag-regra-bloco" style="--c:#16a34a;">
            <div class="ag-regra-tit">📈 Quando pode crescer sozinho</div>
            ${campoRegra('ag-meta-acos', `Meta de ${sigla('TACOS')}`, cfg.meta_acos, { step: '0.1', sufixo: '%', dica: 'Quanto da venda total da loja pode ir para ADS. É a métrica principal do agente.' })}
            ${campoRegra('ag-orc-min', 'Orçamento mínimo', cfg.orcamento_min, { step: '0.01', sufixo: 'R$/dia', dica: 'Piso ao reduzir o investimento.' })}
            ${campoRegra('ag-orc-max', 'Orçamento máximo', cfg.orcamento_max, { step: '0.01', sufixo: 'R$/dia', dica: 'Teto ao aumentar o investimento.' })}
            ${campoRegra('ag-janela', 'Janela de decisão', cfg.janela_decisao_dias ?? 1, { sufixo: 'dias', dica: 'Quantos dias de dados entram na análise.' })}
          </div>
          <div class="ag-regra-bloco" style="--c:#d97706;">
            <div class="ag-regra-tit">✋ O que sempre espera sua aprovação</div>
            ${campoRegra('ag-alerta-var', 'Alerta se a variação proposta passar de', cfg.alerta_variacao_pct ?? 30, { sufixo: '%', dica: 'Mudança maior que isso não é feita sozinha: vira item em “Precisa de você”.' })}
          </div>
        </div>
        <details class="ag-avancado">
          <summary>Avançado</summary>
          <div class="ag-regras-grid" style="margin-top:10px;">
            <div class="ag-regra-bloco" style="--c:#64748b;">
              ${campoRegra('ag-margem', 'Margem', cfg.margem_pct, { step: '0.1', sufixo: '%' })}
              ${campoRegra('ag-estoque-min', 'Estoque mínimo', cfg.estoque_minimo, { sufixo: 'un' })}
            </div>
          </div>
        </details>
        <div class="ag-campo" style="margin-top:14px;">
          <label class="ag-campo-label" for="ag-notas">Notas, calendário de promoções, contexto extra</label>
          <textarea class="form-textarea" id="ag-notas" rows="2" placeholder="Ex: Black Friday em novembro, não cortar orçamento nessa semana mesmo se o ACOS subir.">${h(cfg.notas || '')}</textarea>
          <div class="ag-campo-dica">O chat usa esse texto como contexto ao responder.</div>
        </div>
        <div class="ag-regras-live" id="ag-regras-live"><div class="ag-regras-live-tit">Como isso vira regra</div><div id="ag-regras-live-txt">${textoRegras(v)}</div></div>
        <div class="ag-regras-rodape">
          <span id="ag-regras-estado" class="ag-regras-estado"></span>
          ${novo ? '' : '<button class="btn btn-secondary btn-sm" id="ag-regras-descartar" style="display:none;" onclick="window._agRegrasDescartar()">Descartar alterações</button>'}
          <button class="btn btn-primary" id="ag-regras-salvar" ${state.salvandoConfig ? 'disabled' : ''} onclick="window._agSalvarConfig()">${state.salvandoConfig ? '⏳ Salvando...' : '💾 Salvar regras'}</button>
        </div>
      </div>`;
    }

    // Formulário de conta nova (sem conta aberta ainda)
    function renderConfig() {
      return `<div class="ag-hud-card" style="--ag-hud-accent:#6366f1;margin-bottom:20px;">
        <div class="ag-sec-head"><div class="ag-sec-titulo">🛡️ Guardrails do piloto <span class="ag-sec-sub">Defina as regras que o agente vai seguir nesta conta. O cron avalia todas as contas com o piloto ligado todo dia às 07:00.</span></div></div>
        ${formRegras({}, true)}
      </div>`;
    }

    // Cartão compacto: a frase das regras em vigor sempre à vista; o
    // formulário abre sob demanda.
    function renderRegras(cfg) {
      const aberto = !!state.sec.regras;
      const v = { pausaAcos: cfg.regra_pausa_acos, pausaDias: cfg.regra_pausa_dias ?? 3, mat: cfg.dias_maturacao_campanha ?? 7, meta: cfg.meta_acos, orcMin: cfg.orcamento_min, orcMax: cfg.orcamento_max, alerta: cfg.alerta_variacao_pct ?? 30 };
      const salvoAgora = state.regrasSalvoEm && Date.now() - state.regrasSalvoEm < 20000;
      const chip = (txt, cor) => `<span class="ag-action-chip" style="color:${cor};background:${cor}1a;">${txt}</span>`;
      return `<div class="ag-hud-card" id="ag-regras-card" style="--ag-hud-accent:#6366f1;margin-bottom:20px;">
        <div class="ag-sec-head">
          <div class="ag-sec-titulo">🛡️ Guardrails do piloto <span class="ag-sec-sub">as regras que o agente segue sozinho em cada campanha</span></div>
          <div class="ag-periodos">
            ${salvoAgora ? '<span class="ag-regras-salvo">✔ Regras salvas</span>' : ''}
            <button class="btn btn-sm ${aberto ? 'btn-primary' : 'btn-secondary'}" onclick="window._agToggleRegras()">${aberto ? 'Fechar edição' : '✏️ Editar regras'}</button>
          </div>
        </div>
        ${aberto ? formRegras(cfg, false) : `
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
            ${chip(`Pausa: ${sigla('ACOS')} > ${numRegra(v.pausaAcos)}% · ${numRegra(v.pausaDias)} dia(s)`, '#dc2626')}
            ${chip(`Maturação: ${numRegra(v.mat)} dias`, '#64748b')}
            ${chip(`Meta ${sigla('TACOS')}: ${numRegra(v.meta)}%`, '#16a34a')}
            ${chip(`Orçamento: ${v.orcMin != null ? R$(v.orcMin) : '—'} a ${v.orcMax != null ? R$(v.orcMax) : '—'}`, '#16a34a')}
            ${chip(`Aprovação acima de ${numRegra(v.alerta)}%`, '#d97706')}
            ${chip(cfg.ativo ? 'Piloto ON' : 'Piloto OFF', cfg.ativo ? '#22d3ee' : '#64748b')}
          </div>
          <div class="ag-regras-resumo">${textoRegras(v)}</div>
          ${cfg.notas ? `<div class="ag-nota"><b>Notas:</b> ${h(cfg.notas)}</div>` : ''}`}
      </div>`;
    }

    // ── Registro do agente: tudo que foi feito, decidido e conversado ──
    const LOG_POR_PAGINA = 20;
    function diaRotulo(ts) {
      const d = new Date(ts), agora = new Date();
      const ini = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const dif = Math.round((ini(agora) - ini(d)) / 86400000);
      if (dif === 0) return 'Hoje';
      if (dif === 1) return 'Ontem';
      return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
    }
    function logsFiltrados(contaId) {
      const busca = (state.logBusca || '').trim().toLowerCase();
      return logsDaConta(contaId)
        .filter(l => state.filtroLog === 'todos' || l.tipo === state.filtroLog)
        .filter(l => !busca || ((l.titulo || '') + ' ' + (l.explicacao || '')).toLowerCase().includes(busca))
        .sort(maisRecente);
    }
    function renderLogLista(contaId) {
      const todos = logsFiltrados(contaId);
      const lista = todos.slice(0, state.logMostrar);
      if (!lista.length) return `<div class="ag-vazio">${(state.logBusca || '').trim() ? 'Nenhum registro com esse texto.' : 'Nenhum registro ainda — o registro enche assim que o piloto rodar pela primeira vez.'}</div>`;
      let diaAtual = '', html = '';
      lista.forEach(l => {
        const dia = diaRotulo(l.criado_em);
        if (dia !== diaAtual) { diaAtual = dia; html += `<div class="ag-log-dia">${h(dia)}</div>`; }
        const cor = TIPO_COR[l.tipo] || '#64748b';
        const res = l.resultado === 'so_alerta' ? { txt: 'Aguardando você', cor: '#d97706' } : l.resultado === 'executado' ? { txt: 'Executado', cor: '#16a34a' } : l.resultado === 'erro' ? { txt: 'Erro', cor: '#dc2626' } : l.resultado === 'descartado' ? { txt: 'Descartado', cor: '#64748b' } : { txt: l.resultado || '', cor: '#64748b' };
        const orig = l.origem === 'cron' ? 'Automático' : l.origem === 'chat' ? 'Chat' : l.origem === 'aprovacao_manual' ? 'Aprovado por você' : l.origem === 'analista' ? 'Você' : '';
        html += `<details class="ag-log-item" style="--c:${cor};">
          <summary>
            <span class="ag-log-hora">${new Date(l.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
            <span class="ag-action-chip" style="color:${cor};background:${cor}1a;">${TIPO_LABEL[l.tipo] || l.tipo}</span>
            <span class="ag-log-titulo">${h(l.titulo)}</span>
            ${res.txt ? `<span class="ag-action-chip" style="color:${res.cor};background:${res.cor}1a;">${res.txt}</span>` : ''}
            ${orig ? `<span class="ag-log-origem">${orig}</span>` : ''}
          </summary>
          ${l.explicacao ? `<div class="ag-log-corpo">${nl2br(h(l.explicacao))}</div>` : '<div class="ag-log-corpo ag-camp-motivo">Sem detalhes.</div>'}
        </details>`;
      });
      if (todos.length > lista.length) html += `<div style="text-align:center;margin-top:12px;"><button class="btn btn-secondary btn-sm" onclick="window._agLogMais()">Ver mais (${todos.length - lista.length})</button></div>`;
      return html;
    }
    function renderLog(contaId) {
      const doConta = logsDaConta(contaId);
      const cont = t => t === 'todos' ? doConta.length : doConta.filter(l => l.tipo === t).length;
      return `<div class="ag-hud-card" style="--ag-hud-accent:#6366f1;margin-bottom:20px;">
        <div class="ag-sec-head">
          <div class="ag-sec-titulo">📜 Registro do agente <span class="ag-sec-sub">tudo que foi feito, decidido e conversado — inclusive as ações automáticas e as suas</span></div>
          <div class="ag-periodos">${['todos', 'decisao', 'alerta', 'sistema', 'chat'].map(t => `<button class="btn btn-sm ${state.filtroLog === t ? 'btn-primary' : 'btn-secondary'}" onclick="window._agFiltrarLog('${t}')">${t === 'todos' ? 'Todos' : TIPO_LABEL[t]} (${cont(t)})</button>`).join('')}</div>
        </div>
        <input type="search" class="form-input" id="ag-log-busca" placeholder="Buscar no registro (campanha, motivo, ação)…" value="${esc(state.logBusca || '')}" oninput="window._agLogBusca(this.value)" style="margin-bottom:12px;" aria-label="Buscar no registro do agente">
        <div id="ag-log-lista">${renderLogLista(contaId)}</div>
      </div>`;
    }

    // ── Campanhas ao vivo (com GMV, orçamento, gasto e ACOS por campanha) ──
    // ── Impressões, Cliques e Vendas: funil de ADS da conta (topo de funil
    // até venda), pedido explícito do analista — separado da tabela de
    // campanhas porque é uma leitura de conta inteira, não por campanha. ──
    function renderImpressoesCliquesVendas(contaId) {
      const d = state.dadosAoVivoPorConta[contaId];
      if (!d || d.erro || d.impressoesTotal == null) return '';
      const n = v => (v || 0).toLocaleString('pt-BR');
      const varChip = v => {
        if (v == null) return '';
        const sobe = v > 0, cor = sobe ? '#16a34a' : v < 0 ? '#dc2626' : '#64748b';
        const txt = v === Infinity ? 'novo' : `${sobe ? '+' : '−'}${fmtNum(Math.abs(v))}%`;
        return `<span style="color:${cor};font-weight:700;">${sobe ? '▲' : v < 0 ? '▼' : '–'} ${txt}</span>`;
      };
      const metrica = (label, valor, sub, variacao) => `<div><div class="ag-hud-label" style="margin-bottom:2px;">${label}</div><div class="ag-mono" style="font-size:20px;font-weight:800;">${valor}</div><div class="ag-hud-sub">${sub || ''}${sub && variacao != null ? ' · ' : ''}${varChip(variacao)}</div></div>`;
      return `<div class="ag-hud-card" style="--ag-hud-accent:#0ea5e9;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:800;margin-bottom:2px;">📊 Impressões, Cliques e Vendas (${periodoLabel(d.periodo || state.negocioPeriodo)})</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;">Funil de ADS da conta inteira — de quantas vezes o anúncio apareceu até quantas vendas ele gerou. Variação vs o período anterior equivalente.</div>
        <div style="display:flex;gap:28px;flex-wrap:wrap;">
          ${metrica('Impressões', n(d.impressoesTotal), null, d.variacaoImpressoes)}
          ${metrica('Cliques', n(d.cliquesTotal), `CTR ${fmtPct(d.ctrGeral, 2)}`, d.variacaoCliques)}
          ${metrica('Pedidos (ADS)', n(d.pedidosAdsTotal), `Conversão ${fmtPct(d.crGeral, 2)}`, d.variacaoPedidosAds)}
          ${metrica('CPC médio', R$(d.cpcGeral))}
          ${metrica('Vendas atribuídas', R$(d.gmvTotal), `ACOS ${fmtPct(d.acosGeral)}`, d.variacaoGmv)}
        </div>
      </div>`;
    }

    // ═════════════════════════════════════════════════════════════
    // Interface da conta aberta: cabeçalho → "Precisa de você" →
    // indicadores → timeline do que o agente fez → campanhas →
    // seções secundárias. Responde, sem rolar: a conta está bem? o que
    // mudou? preciso agir? E por que cada campanha está como está.
    // ═════════════════════════════════════════════════════════════

    // ── Formatação pt-BR e glossário das siglas ──
    function h(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function fmtNum(v, c) { c = c == null ? 1 : c; return (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }); }
    function fmtPct(v, c) { return v === Infinity ? '∞' : fmtNum(v, c) + '%'; }
    const GLOSSARIO = {
      TACOS: 'Investimento em anúncios ÷ faturamento TOTAL da loja. É a métrica principal do agente: mostra quanto do que a loja vendeu foi gasto com ADS.',
      ACOS: 'Investimento em anúncios ÷ vendas atribuídas aos anúncios. Serve pra comparar campanhas entre si.',
      ROAS: 'Retorno sobre o investimento: quantos reais vendidos para cada R$ 1 gasto (20x = R$ 20 vendidos por R$ 1). Meta de ROAS maior deixa o lance mais conservador.',
      GMV: 'Valor bruto de vendas que a Shopee atribui ao anúncio, antes de descontos e cancelamentos.',
      CTR: 'Taxa de cliques: de cada 100 vezes que o anúncio apareceu, quantas viraram clique.',
      ADS: 'Anúncios pagos dentro da Shopee.',
    };
    function sigla(s) { return `<abbr class="ag-sigla" title="${esc(GLOSSARIO[s] || '')}">${s}</abbr>`; }

    function varChip(v, inverso) {
      if (v == null) return '';
      const sobe = v > 0, bom = inverso ? !sobe : sobe;
      const cor = v === 0 ? '#64748b' : bom ? '#16a34a' : '#dc2626';
      const txt = v === Infinity ? 'novo' : (sobe ? '+' : '−') + fmtNum(Math.abs(v)) + '%';
      return `<span style="color:${cor};font-weight:700;">${v === 0 ? '–' : sobe ? '▲' : '▼'} ${txt}</span>`;
    }

    function quandoCurto(ts) {
      const d = new Date(ts), agora = new Date();
      const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const diaIni = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const dif = Math.round((diaIni(agora) - diaIni(d)) / 86400000);
      if (dif === 0) return `hoje ${hm}`;
      if (dif === 1) return `ontem ${hm}`;
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
    }

    // O cron roda 07:00 de Brasília (10:00 UTC).
    function proximaExecucao() {
      const agora = new Date();
      const prox = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 10, 0, 0));
      if (prox <= agora) prox.setUTCDate(prox.getUTCDate() + 1);
      const mesmoDia = prox.getDate() === agora.getDate() && prox.getMonth() === agora.getMonth();
      return `${mesmoDia ? 'hoje' : 'amanhã'} 07:00`;
    }

    function logsDaConta(contaId) { return state.logs.filter(l => l.conta_id === contaId); }
    const maisRecente = (a, b) => new Date(b.criado_em) - new Date(a.criado_em);

    function motivoCurto(txt, n) {
      const t = String(txt || '').replace(/^Alerta aprovado pelo analista\.\s*/, '').trim();
      const m = t.match(/^[\s\S]*?[.!?](?=\s|$)/);
      const prim = m ? m[0] : t;
      return prim.length > n ? prim.slice(0, n - 1) + '…' : prim;
    }

    // ── Ligação decisão ↔ campanha (id quando existe; senão pelo nome no título) ──
    // Nome da campanha = último trecho do título (títulos de aprovação têm
    // dois traços: "Aprovado manualmente — Reativar e apertar ROAS — Nome").
    function nomeNoLog(titulo) { const p = String(titulo || '').split(' — '); return p.length > 1 ? p[p.length - 1] : ''; }
    // Decisões antigas aprovadas pelo chat: o texto prometia reativar, mas só
    // a meta de ROAS era enviada (o tipo "retomar" não existia). Sem a flag
    // retomada, a campanha nunca foi reativada por elas.
    function alegaReativacao(l) { return /reativ/i.test((l.titulo || '') + ' ' + (l.explicacao || '')); }
    function reativacaoLegada(l) { return l.tipo === 'decisao' && alegaReativacao(l) && l.dados?.retomada !== true; }
    function mesmoNome(c, n) { return !!n && (c.nome === n || c.nome.slice(0, 70) === n || c.nome.startsWith(n)); }
    function logEhDaCampanha(l, c) {
      const d = l.dados || {};
      if (d.campaign_id != null) return String(d.campaign_id) === String(c.id);
      return mesmoNome(c, nomeNoLog(l.titulo));
    }
    function campanhaAoVivo(contaId, id, titulo) {
      const lista = state.dadosAoVivoPorConta[contaId]?.todasCampanhas || [];
      if (id != null) return lista.find(c => String(c.id) === String(id)) || null;
      const n = nomeNoLog(titulo);
      return lista.find(c => mesmoNome(c, n)) || null;
    }

    function textoAcao(l) {
      const d = l.dados || {};
      if (l.resultado === 'erro') return l.titulo || 'Ação com falha';
      const partes = [];
      if (d.retomada === true) partes.push('Reativou a campanha');
      // Decisões aprovadas antes do ajuste guardam "atual/sugerido" em vez de "de/para".
      const roasDe = d.roas_de ?? d.roas_atual, roasPara = d.roas_para ?? d.roas_sugerido;
      const budDe = d.budget_de ?? d.budget_atual, budPara = d.budget_para ?? d.budget_sugerido;
      if (roasDe != null && roasPara != null) {
        const cons = roasPara > roasDe;
        partes.push(`${cons ? 'Subiu' : 'Baixou'} a meta de ROAS de ${fmtNum(roasDe)}x para ${fmtNum(roasPara)}x (${cons ? 'lance mais conservador' : 'lance mais agressivo'})`);
      } else if (budDe != null && budPara != null) {
        partes.push(`${budPara > budDe ? 'Aumentou' : 'Reduziu'} o orçamento de ${R$(budDe)} para ${R$(budPara)}`);
      }
      if (reativacaoLegada(l) && partes.length) return partes.join(' e ') + ' — a reativação aprovada não foi enviada à Shopee';
      if (d.pausada === true || (/pausada/i.test(l.titulo || '') && !/falha/i.test(l.titulo || ''))) partes.push('Pausou a campanha');
      return partes.length ? partes.join(' e ') : (l.titulo || '');
    }

    function origemInfo(l) {
      if (l.origem === 'cron') return { txt: 'Automático', cor: '#6366f1' };
      if (l.origem === 'aprovacao_manual') return { txt: 'Aprovado por você', cor: '#0ea5e9' };
      return { txt: 'Feito por você', cor: '#0ea5e9' };
    }

    // O "Executado" só quer dizer que a Shopee não devolveu erro. Aqui
    // compara o que foi pedido com o estado ao vivo da campanha pra dizer se
    // realmente pegou.
    function estadoAplicacao(l, contaId) {
      if (l.resultado === 'erro') return { k: 'falhou', txt: '✖ Falhou', cor: '#dc2626' };
      const d = l.dados || {};
      const nv = { k: 'nv', txt: 'Sem confirmação (campanha fora da janela)', cor: '#64748b' };
      const live = campanhaAoVivo(contaId, d.campaign_id, l.titulo);
      if (!live) return nv;
      const t = new Date(l.criado_em).getTime();
      const posterior = logsDaConta(contaId).some(x => x.id !== l.id && x.tipo === 'decisao' && x.resultado === 'executado' && new Date(x.criado_em).getTime() > t && logEhDaCampanha(x, live));
      if (posterior) return { k: 'sup', txt: 'Superada por ação posterior', cor: '#64748b' };
      const st = (live.status || '').toLowerCase();
      let ok = null;
      const roasPara = d.roas_para ?? d.roas_sugerido, budPara = d.budget_para ?? d.budget_sugerido;
      if (reativacaoLegada(l) && st === 'paused') return { k: 'div', txt: '⚠ Só a meta de ROAS mudou — a campanha continua pausada', cor: '#dc2626' };
      if (d.retomada === true) ok = st === 'ongoing';
      else if (d.pausada === true || (/pausada/i.test(l.titulo || '') && !/falha/i.test(l.titulo || ''))) ok = st === 'paused';
      else if (roasPara != null) ok = live.roasTarget != null && Math.abs(live.roasTarget - roasPara) < 0.06;
      else if (budPara != null) ok = Math.abs((live.budget || 0) - budPara) < 0.01;
      if (ok === null) return nv;
      if (ok) return { k: 'ok', txt: '✔ Confirmada na Shopee', cor: '#16a34a' };
      if (Date.now() - t < 3600000) return { k: 'pend', txt: '⏳ Enviada, aguardando confirmação', cor: '#d97706' };
      return { k: 'div', txt: '⚠ A Shopee mostra outro valor', cor: '#dc2626' };
    }

    // ── 1. Cabeçalho compacto da conta ──
    function renderResultadoRodada() {
      const r = state.resultadoRodada;
      if (!r) return '';
      if (r.erro) return `<div class="ag-aviso ag-aviso-erro">⚠️ ${h(r.erro)}</div>`;
      return `<div class="ag-aviso ag-aviso-ok">✅ Rodada concluída agora: ${r.campanhas} campanha(s) ativa(s) revisadas, ${r.decisoes} decisão(ões), ${r.alertas} alerta(s), ${sigla('TACOS')} ${h(r.tacos)}.${r.paginacaoErro ? ' ⚠️ A listagem de campanhas pode estar incompleta nesta rodada.' : ''}</div>`;
    }

    function renderCabecalho(cfg) {
      const saude = saudeDaConta(cfg);
      const logs = logsDaConta(cfg.conta_id);
      const ultima = logs.filter(l => l.origem === 'cron').sort(maisRecente)[0];
      const resumo = logs.filter(l => l.origem === 'cron' && /^Revisão diária concluída/.test(l.titulo || '')).sort(maisRecente)[0];
      const resumoTxt = resumo ? String(resumo.titulo).replace(/^Revisão diária concluída — /, '') : '';
      const opcoes = state.contas.map(c => `<option value="${esc(c.conta_id)}" ${c.conta_id === cfg.conta_id ? 'selected' : ''}>${h(nomeExibicao(c))}</option>`).join('');
      return `<div class="ag-topbar" style="--ag-hud-accent:${saude.cor};">
        <div class="ag-topbar-l">
          <select class="form-select ag-sel-conta" onchange="window._agTrocarConta(this.value)" title="Trocar de conta">
            ${opcoes}
            ${state.contas.length > 1 ? '<option value="__portfolio__">⟵ Todas as contas</option>' : ''}
            <option value="__novo__">+ Adicionar conta</option>
          </select>
          <span class="ag-saude-pill" style="color:${saude.cor};background:${saude.cor}1a;" title="Combina o TACOS contra a meta e se há pendências antigas esperando você.">${saude.emoji} ${saude.label}</span>
          <label class="ag-toggle" title="Ligado: o agente revisa e age nesta conta todo dia às 07:00.">
            <input type="checkbox" ${cfg.ativo ? 'checked' : ''} onchange="window._agTogglePiloto(this.checked)">
            <span class="ag-toggle-trilho"></span><span>Piloto ${cfg.ativo ? 'ON' : 'OFF'}</span>
          </label>
        </div>
        <div class="ag-topbar-r">
          <span class="ag-topbar-run">${ultima ? `Última execução: <b>${quandoCurto(ultima.criado_em)}</b>${resumoTxt ? ` · ${h(resumoTxt)}` : ''}` : 'Ainda não rodou'}${cfg.ativo ? ` · próxima: <b>${proximaExecucao()}</b>` : ' · piloto desligado, não roda sozinho'}</span>
          <button class="btn btn-secondary btn-sm" ${state.rodandoAgente ? 'disabled' : ''} onclick="window._agRodarAgora()" title="Dispara agora o mesmo ciclo das 07:00 nesta conta.">${state.rodandoAgente ? '⏳ Rodando...' : '🚀 Rodar agora'}</button>
        </div>
      </div>${renderResultadoRodada()}`;
    }

    // Campanhas que estão pausadas na Shopee AGORA mas cuja última decisão
    // registrada diz que foram reativadas.
    function reativacoesPendentes(contaId) {
      const lista = state.dadosAoVivoPorConta[contaId]?.todasCampanhas || [];
      const decisoes = logsDaConta(contaId).filter(l => l.tipo === 'decisao' && l.resultado === 'executado').sort(maisRecente);
      const out = [];
      lista.filter(c => (c.status || '').toLowerCase() === 'paused').forEach(c => {
        const ultima = decisoes.find(l => logEhDaCampanha(l, c));
        if (ultima && alegaReativacao(ultima)) out.push({ c, log: ultima });
      });
      return out;
    }

    // Reativa de verdade, mas só depois da sua confirmação (volta a gastar).
    async function reativarPendentesAgora() {
      const contaId = state.contaAbertaId;
      const itens = reativacoesPendentes(contaId);
      if (!itens.length || state.reativando) return;
      if (!confirm(`Reativar agora na Shopee ${itens.length} campanha(s)?\n\n${itens.map(i => '• ' + i.c.nome.slice(0, 70)).join('\n')}\n\nElas voltam a gastar com ADS.`)) return;
      const cfg = configDaConta(contaId);
      state.reativando = true; render();
      const falhas = [];
      for (const { c } of itens) {
        try {
          await MarketplaceAPI.call('shopee_ads_resume_campaign', { shopId: contaId, campaign_id: Number(c.id) });
          await _sb.from('glr_agente_log').insert({
            conta_id: contaId, cliente_nome: cfg?.cliente_nome || null, tipo: 'decisao',
            titulo: `Reativada manualmente — ${c.nome}`,
            explicacao: 'Reativação confirmada por você na tela do agente (as aprovações anteriores só tinham alterado a meta de ROAS).',
            dados: { campaign_id: Number(c.id), retomada: true }, resultado: 'executado', origem: 'analista',
          });
        } catch (e) {
          falhas.push(`${c.nome.slice(0, 50)}: ${e.message || e}`);
          try { await _sb.from('glr_agente_log').insert({ conta_id: contaId, cliente_nome: cfg?.cliente_nome || null, tipo: 'decisao', titulo: `Falha ao reativar — ${c.nome}`, explicacao: `Tentei reativar — mas deu erro: ${e.message || e}`, dados: { campaign_id: Number(c.id) }, resultado: 'erro', origem: 'analista' }); } catch (e2) {}
        }
      }
      state.reativando = false;
      await carregarTudo();
      alert(falhas.length ? `Reativei ${itens.length - falhas.length} de ${itens.length}. Falhas:\n${falhas.join('\n')}` : `${itens.length} campanha(s) reativada(s). A confirmação aparece na timeline assim que a Shopee atualizar.`);
    }

    // ── 2. Faixa "Precisa de você" (só aparece se houver o que fazer) ──
    function renderPrecisaDeVoce(contaId) {
      const logs = logsDaConta(contaId);
      const pend = logs.filter(l => l.tipo === 'alerta' && l.resultado === 'so_alerta').sort(maisRecente);
      const tresDias = Date.now() - 3 * 86400000;
      const falhas = logs.filter(l => l.tipo === 'decisao' && l.resultado === 'erro' && new Date(l.criado_em).getTime() > tresDias).sort(maisRecente);
      const reativ = reativacoesPendentes(contaId);
      if (!pend.length && !falhas.length && !reativ.length) return '<div class="ag-nada">✅ Nada pendente — o agente não precisa de você agora.</div>';
      const bannerReativ = reativ.length ? (() => {
        const algumaLegada = reativ.some(r => reativacaoLegada(r.log));
        const nomes = reativ.slice(0, 5).map(r => h(r.c.nome.slice(0, 45))).join(', ') + (reativ.length > 5 ? ` e mais ${reativ.length - 5}` : '');
        return `<div class="ag-precisa-item" style="--c:#dc2626;">
          <div class="ag-precisa-corpo">
            <div class="ag-precisa-titulo">⚠️ ${reativ.length} campanha(s) com reativação aprovada continuam pausadas na Shopee</div>
            <div class="ag-precisa-motivo">${nomes}. ${algumaLegada ? 'As aprovações antigas só alteraram a meta de ROAS — o comando de reativar nunca foi enviado (já corrigido para as próximas).' : 'A Shopee ainda mostra essas campanhas como pausadas.'}</div>
          </div>
          <div class="ag-precisa-acoes"><button class="btn btn-sm ag-btn-ok" ${state.reativando ? 'disabled' : ''} onclick="window._agReativarAgora()">${state.reativando ? '⏳ Reativando...' : `▶ Reativar ${reativ.length} agora`}</button></div>
        </div>`;
      })() : '';
      const linha = (l, falha) => {
        const d = descreverAcao(l);
        const exec = !falha && !!temAcaoReconhecida(l.dados || {});
        const proc = state.processandoAlertaId === l.id;
        const impacto = (String(l.explicacao || '').match(/Impacto estimado:\s*(R\$\s*[\d.,]+)/) || [])[1];
        const motivo = falha ? 'Erro: ' + motivoCurto(String(l.explicacao || '').split('mas deu erro:')[1] || l.explicacao, 150) : motivoCurto(l.explicacao, 170);
        return `<div class="ag-precisa-item" style="--c:${falha ? '#dc2626' : '#d97706'};">
          <div class="ag-precisa-corpo">
            <div class="ag-precisa-titulo">${d.nomeCampanha || esc(l.titulo)}
              ${d.acaoLabel ? `<span class="ag-action-chip" style="color:${d.acaoCor};background:${d.acaoCor}1a;">${d.acaoLabel}</span>` : ''}
              ${falha ? '<span class="ag-action-chip" style="color:#dc2626;background:#dc26261a;">✖ Falhou</span>' : ''}
            </div>
            ${d.deParaVal ? `<div class="ag-mono ag-precisa-depara">${d.deParaVal}</div>` : ''}
            <div class="ag-precisa-motivo">${h(motivo)}${impacto ? ` · <b>impacto ≈ ${h(impacto)}</b>` : ''}</div>
          </div>
          <div class="ag-precisa-acoes">
            ${exec ? `<button class="btn btn-sm ag-btn-ok" ${proc ? 'disabled' : ''} onclick="window._agAprovarAlerta('${l.id}')">${proc ? '⏳' : '✅ Aprovar'}</button>` : ''}
            <button class="btn btn-sm ag-btn-no" ${proc ? 'disabled' : ''} onclick="window._agDescartarAlerta('${l.id}')">${falha ? 'Marcar como visto' : exec ? '🚫 Rejeitar' : 'Dispensar'}</button>
          </div>
        </div>`;
      };
      return `<div class="ag-hud-card" style="--ag-hud-accent:#d97706;margin-bottom:20px;">
        <div class="ag-sec-head"><div class="ag-sec-titulo">🔔 Precisa de você <span class="ag-contagem">${pend.length + falhas.length + (reativ.length ? 1 : 0)}</span></div></div>
        <div class="ag-lista-precisa">${bannerReativ}${pend.map(l => linha(l, false)).join('')}${falhas.map(l => linha(l, true)).join('')}</div>
      </div>`;
    }

    // ── 3. Indicadores (um seletor de período vale pra tela toda) ──
    function kpiCard(label, valor, rodape, cor, valorCor) {
      return `<div class="ag-kpi" style="--ag-hud-accent:${cor};"><div class="ag-hud-label">${label}</div><div class="ag-hud-value" ${valorCor ? `style="color:${valorCor};"` : ''}>${valor}</div><div class="ag-hud-sub">${rodape || ''}</div></div>`;
    }
    function corAcos(acos, cfg) {
      if (acos === Infinity) return '#dc2626';
      if (!cfg.meta_acos) return null;
      if (acos <= cfg.meta_acos) return '#16a34a';
      return acos <= (cfg.regra_pausa_acos || cfg.meta_acos * 1.5) ? '#d97706' : '#dc2626';
    }

    function renderKPIs(cfg) {
      const contaId = cfg.conta_id, p = state.negocioPeriodo;
      const n = state.negocioPorConta[contaId + ':' + p];
      const PERIODOS = [['7', '7 dias'], ['15', '15 dias'], ['30', '30 dias'], ['mes', 'Mês atual']];
      const cab = `<div class="ag-sec-head">
        <div class="ag-sec-titulo">📈 Indicadores <span class="ag-sec-sub">${periodoLabel(p)} vs período anterior equivalente · vale também para a tabela de campanhas</span></div>
        <div class="ag-periodos">
          ${PERIODOS.map(([v, l]) => `<button class="btn btn-sm ${p === v ? 'btn-primary' : 'btn-secondary'}" onclick="window._agMudarPeriodo('${v}')">${l}</button>`).join('')}
          <button class="btn btn-secondary btn-sm" ${state.carregandoNegocio ? 'disabled' : ''} onclick="window._agAtualizarTudo()" title="Buscar de novo na Shopee">🔄</button>
        </div>
      </div>`;
      let corpo;
      if (!n && state.carregandoNegocio) {
        corpo = `<div class="ag-kpi-grid">${'<div class="ag-kpi ag-skel"></div>'.repeat(5)}</div>`;
      } else if (!n) {
        corpo = '<div class="ag-vazio">Ainda sem dados. <button class="btn btn-secondary btn-sm" onclick="window._agAtualizarTudo()">Carregar</button></div>';
      } else if (n.erro) {
        corpo = `<div class="ag-aviso ag-aviso-erro">⚠️ Não consegui buscar os indicadores: ${h(n.erro)} <button class="btn btn-secondary btn-sm" style="margin-left:8px;" onclick="window._agAtualizarTudo()">Tentar de novo</button></div>`;
      } else {
        const fat = n.semanaAtual, fatAnt = n.semanaAnterior, A = n.adsAtual, P = n.adsAnterior;
        const cards = [kpiCard('Faturamento total', R$(fat), `${varChip(n.variacaoPct)} vs ${R$(fatAnt)}`, '#6366f1')];
        let notas = '';
        if (A) {
          const tacos = fat > 0 ? A.gasto / fat * 100 : (A.gasto > 0 ? Infinity : 0);
          const tacosAnt = P && fatAnt > 0 ? P.gasto / fatAnt * 100 : null;
          const meta = cfg.meta_acos;
          const corTacos = !meta ? '#6366f1' : tacos <= meta ? '#16a34a' : tacos <= meta * 1.3 ? '#d97706' : '#dc2626';
          const larg = !meta || tacos === Infinity ? 100 : Math.min(100, tacos / (meta * 1.6) * 100);
          const veredito = !meta ? 'sem meta configurada' : tacos <= meta ? 'dentro da meta' : tacos <= meta * 1.3 ? 'um pouco acima da meta' : 'bem acima da meta';
          const medidor = meta ? `<div class="ag-meter"><div class="ag-meter-fill" style="width:${larg}%;background:${corTacos};"></div><div class="ag-meter-meta" style="left:${100 / 1.6}%;" title="Meta ${fmtPct(meta)}"></div></div>` : '';
          cards.push(kpiCard(`${sigla('TACOS')} vs meta`, fmtPct(tacos), `${medidor}meta ${meta != null ? fmtPct(meta) : '—'} · ${veredito}${tacosAnt ? ` · ${varChip((tacos - tacosAnt) / tacosAnt * 100, true)}` : ''}`, corTacos, corTacos));
          cards.push(kpiCard(`Investimento em ${sigla('ADS')}`, R$(A.gasto), `${P && P.gasto > 0 ? varChip((A.gasto - P.gasto) / P.gasto * 100, true) + ' ' : ''}vs ${R$(P ? P.gasto : 0)}`, '#0ea5e9'));
          const gmvAcima = fat > 0 && A.gmv > fat;
          cards.push(kpiCard(`Vendas via ${sigla('ADS')} (${sigla('GMV')})`, R$(A.gmv), `${P && P.gmv > 0 ? varChip((A.gmv - P.gmv) / P.gmv * 100) + ' ' : ''}vs ${R$(P ? P.gmv : 0)}${gmvAcima ? ' · ⚠️ acima do faturamento (veja a nota)' : ''}`, '#22d3ee'));
          const acos = A.gmv > 0 ? A.gasto / A.gmv * 100 : (A.gasto > 0 ? Infinity : 0);
          const acosAnt = P && P.gmv > 0 ? P.gasto / P.gmv * 100 : null;
          cards.push(kpiCard(sigla('ACOS'), fmtPct(acos), `${acosAnt ? varChip((acos - acosAnt) / acosAnt * 100, true) + ' ' : ''}${acosAnt != null ? `vs ${fmtPct(acosAnt)}` : ''}`, '#d97706', corAcos(acos, cfg)));
          if (gmvAcima) notas += `<div class="ag-nota">ℹ️ <b>Por que as vendas via ADS passam do faturamento?</b> O ${sigla('GMV')} é a atribuição da Shopee: conta compras de qualquer produto da loja feitas depois do clique no anúncio, antes de descontos e inclusive pedidos que depois foram cancelados. O faturamento soma só o que o comprador pagou. Por isso o primeiro pode superar o segundo — não é erro de janela (os dois usam o mesmo período).</div>`;
        } else {
          cards.push(`<div class="ag-kpi" style="--ag-hud-accent:#dc2626;grid-column:span 4;"><div class="ag-hud-label">Dados de ADS</div><div class="ag-hud-sub">Não consegui buscar o investimento em ADS agora${n.adsErro ? ` (${h(n.adsErro)})` : ''}. <button class="btn btn-secondary btn-sm" onclick="window._agAtualizarTudo()">Tentar de novo</button></div></div>`);
        }
        if (n.incompleto) notas += `<div class="ag-aviso ag-aviso-aten">⚠️ ${h(n.avisoIncompleto)}</div>`;
        if (n.adsJanelaReduzida) notas += '<div class="ag-nota">ℹ️ A Shopee só entrega até 30 dias de dados de ADS por consulta — o investimento e as vendas via ADS usam os últimos 30 dias, mesmo com "Mês atual" mais longo.</div>';
        corpo = `<div class="ag-kpi-grid">${cards.join('')}</div>${notas}`;
      }
      return `<div class="ag-hud-card" style="--ag-hud-accent:#6366f1;margin-bottom:20px;">${cab}${corpo}</div>`;
    }

    // ── 4. O que o agente fez (timeline) ──
    function renderTimeline(contaId) {
      const trintaDias = Date.now() - 30 * 86400000;
      const todas = logsDaConta(contaId).filter(l => l.tipo === 'decisao' && new Date(l.criado_em).getTime() > trintaDias).sort(maisRecente);
      const grupos = {
        todos: todas,
        auto: todas.filter(l => l.origem === 'cron' && l.resultado !== 'erro'),
        manual: todas.filter(l => l.origem !== 'cron' && l.resultado !== 'erro'),
        falhas: todas.filter(l => l.resultado === 'erro'),
      };
      const FILTROS = [['todos', 'Todos'], ['auto', 'Automáticos'], ['manual', 'Manuais'], ['falhas', 'Falhas']];
      const filtro = grupos[state.timelineFiltro] ? state.timelineFiltro : 'todos';
      const lista = grupos[filtro];
      const sete = Date.now() - 7 * 86400000;
      const c7 = k => grupos[k].filter(l => new Date(l.criado_em).getTime() > sete).length;
      const item = l => {
        const est = estadoAplicacao(l, contaId);
        const orig = origemInfo(l);
        const d = l.dados || {};
        const live = campanhaAoVivo(contaId, d.campaign_id, l.titulo);
        const nome = h(live ? live.nome : (nomeNoLog(l.titulo) || l.titulo));
        const nomeHtml = live ? `<a href="#" class="ag-link" onclick="window._agIrParaCampanha('${live.id}'); return false;" title="Ver a linha desta campanha na tabela">${nome}</a>` : `<b>${nome}</b>`;
        const motivo = l.resultado === 'erro' ? 'Erro: ' + motivoCurto(String(l.explicacao || '').split('mas deu erro:')[1] || l.explicacao, 130) : motivoCurto(l.explicacao, 140);
        return `<div class="ag-tl-item" style="--c:${est.cor};">
          <div class="ag-tl-quando">${quandoCurto(l.criado_em)}</div>
          <div class="ag-tl-corpo">
            <div>${nomeHtml} — ${h(textoAcao(l))}</div>
            <div class="ag-tl-meta">
              <span class="ag-action-chip" style="color:${orig.cor};background:${orig.cor}1a;">${orig.txt}</span>
              <span class="ag-action-chip" style="color:${est.cor};background:${est.cor}1a;">${est.txt}</span>
              <span class="ag-tl-motivo">${h(motivo)}</span>
            </div>
          </div>
        </div>`;
      };
      const mostrados = lista.slice(0, state.timelineMostrar);
      return `<div class="ag-hud-card" style="--ag-hud-accent:#6366f1;margin-bottom:20px;">
        <div class="ag-sec-head">
          <div class="ag-sec-titulo">🕘 O que o agente fez <span class="ag-sec-sub">últimos 7 dias: ${c7('auto')} automáticas · ${c7('manual')} manuais · ${c7('falhas')} falhas</span></div>
          <div class="ag-periodos">${FILTROS.map(([k, l]) => `<button class="btn btn-sm ${filtro === k ? 'btn-primary' : 'btn-secondary'}" onclick="window._agFiltroTimeline('${k}')">${l} (${grupos[k].length})</button>`).join('')}</div>
        </div>
        ${mostrados.length ? `<div class="ag-tl">${mostrados.map(item).join('')}</div>` : '<div class="ag-vazio">Nenhuma ação neste filtro nos últimos 30 dias.</div>'}
        ${lista.length > mostrados.length ? `<div style="text-align:center;margin-top:10px;"><button class="btn btn-secondary btn-sm" onclick="window._agTimelineMais()">Ver mais (${lista.length - mostrados.length})</button></div>` : ''}
        <div class="ag-nota" style="margin-top:12px;">Contagens dos últimos 30 dias registrados. “Confirmada na Shopee” compara a ação com o estado atual da campanha.</div>
      </div>`;
    }

    // ── 5. Tabela de campanhas (por quê, não só o quê) ──
    const ORDENACAO = {
      nome: c => (c.nome || '').toLowerCase(), status: c => c.status || '', orcamento: c => c.budget || 0,
      gasto: c => c.gasto, impressoes: c => c.impressoes, cliques: c => c.cliques, ctr: c => c.ctr, pedidos: c => c.pedidos,
      gmv: c => c.gmv, acos: c => (c.acos === Infinity ? 1e12 : c.acos),
    };

    function statusCampanha(contaId, c, cfg) {
      const st = (c.status || '').toLowerCase();
      if (st === 'ongoing') return { txt: 'Ativa', cor: '#16a34a', anomalia: false };
      if (st === 'paused') {
        const pausa = logsDaConta(contaId).filter(l => l.tipo === 'decisao' && l.resultado === 'executado' && (l.dados?.pausada === true || /pausada/i.test(l.titulo || '')) && logEhDaCampanha(l, c)).sort(maisRecente)[0];
        const txt = !pausa ? 'Pausada (fora do agente)' : pausa.origem === 'cron' ? 'Pausada pelo agente' : 'Pausada por você';
        const anomalia = c.gasto > 0 && c.acos !== Infinity && !!cfg.meta_acos && c.acos <= cfg.meta_acos;
        return { txt, cor: '#d97706', anomalia };
      }
      if (st === 'ended') return { txt: 'Encerrada', cor: '#64748b', anomalia: false };
      if (st === 'closed') return { txt: 'Fechada', cor: '#64748b', anomalia: false };
      return { txt: c.status || '—', cor: '#64748b', anomalia: false };
    }

    function renderTabelaCampanhas(cfg) {
      const contaId = cfg.conta_id, d = state.dadosAoVivoPorConta[contaId];
      const cab = `<div class="ag-sec-head">
        <div class="ag-sec-titulo">📡 Campanhas <span class="ag-sec-sub">${periodoLabel(state.negocioPeriodo)} · ativas e pausadas com atividade no período</span></div>
        <button class="btn btn-secondary btn-sm" ${state.carregandoDadosAoVivo ? 'disabled' : ''} onclick="window._agAtualizarDados()">🔄 Atualizar</button>
      </div>`;
      if (!d && state.carregandoDadosAoVivo) return `<div class="ag-hud-card" style="--ag-hud-accent:#818cf8;margin-bottom:20px;">${cab}<div class="ag-skel" style="height:180px;border-radius:10px;"></div></div>`;
      if (!d) return `<div class="ag-hud-card" style="--ag-hud-accent:#818cf8;margin-bottom:20px;">${cab}<div class="ag-vazio">Ainda sem dados. <button class="btn btn-secondary btn-sm" onclick="window._agAtualizarDados()">Carregar</button></div></div>`;
      if (d.erro) return `<div class="ag-hud-card" style="--ag-hud-accent:#d97706;margin-bottom:20px;">${cab}<div class="ag-aviso ag-aviso-erro">⚠️ ${h(d.erro)} <button class="btn btn-secondary btn-sm" style="margin-left:8px;" onclick="window._agAtualizarDados()">Tentar de novo</button></div></div>`;
      if (!d.todasCampanhas?.length) return `<div class="ag-hud-card" style="--ag-hud-accent:#818cf8;margin-bottom:20px;">${cab}<div class="ag-vazio">Nenhuma campanha com atividade em ${periodoLabel(state.negocioPeriodo)}.</div></div>`;

      const { col, dir } = state.tabOrdem;
      const acesso = ORDENACAO[col] || ORDENACAO.gasto;
      const linhasOrd = [...d.todasCampanhas].sort((a, b) => { const x = acesso(a), y = acesso(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
      const LIMITE = 10;
      const linhas = state.tabTodas ? linhasOrd : linhasOrd.slice(0, LIMITE);
      const th = (chave, rotulo, extra) => `<th class="ag-th-sort" onclick="window._agOrdenar('${chave}')">${rotulo}${col === chave ? (dir === 1 ? ' ▲' : ' ▼') : ''}${extra || ''}</th>`;
      const logs = logsDaConta(contaId);

      const linha = c => {
        const s = statusCampanha(contaId, c, cfg);
        const ult = logs.filter(l => (l.tipo === 'decisao' || (l.tipo === 'alerta' && l.resultado === 'so_alerta')) && logEhDaCampanha(l, c)).sort(maisRecente)[0];
        const ultHtml = ult
          ? `<span class="ag-camp-quando">${quandoCurto(ult.criado_em)}</span> ${ult.tipo === 'alerta' ? '<i>Sugestão pendente:</i> ' : ''}${h(textoAcao(ult))}<div class="ag-camp-motivo">${h(motivoCurto(ult.explicacao, 110))}</div>`
          : ((c.status || '').toLowerCase() === 'paused' ? '<span class="ag-camp-motivo">Sem registro do agente — pausada direto na Shopee.</span>' : '<span class="ag-camp-motivo">—</span>');
        const orc = c.budget > 0 ? R$(c.budget) : `Sem limite${c.roasTarget != null ? ` <div class="ag-camp-motivo">meta de ${sigla('ROAS')} ${fmtNum(c.roasTarget)}x</div>` : ''}`;
        const nomeJs = esc(c.nome).replace(/'/g, "\\'");
        const ativa = (c.status || '').toLowerCase() === 'ongoing', pausada = (c.status || '').toLowerCase() === 'paused';
        const cAcos = corAcos(c.acos, cfg);
        return `<tr id="ag-camp-${c.id}" style="--row-accent:${s.anomalia ? '#dc2626' : s.cor};">
          <td style="max-width:260px;"><div class="ag-camp-nome">${h(c.nome)}</div><div class="ag-camp-id">ID ${c.id}</div></td>
          <td><span class="ag-action-chip" style="color:${s.cor};background:${s.cor}1a;">${s.txt}</span>${s.anomalia ? `<div class="ag-camp-anom" title="Pausada com ACOS dentro da meta — vale checar se a pausa foi intencional.">⚠ pausada com ACOS bom</div>` : ''}</td>
          <td style="min-width:200px;max-width:280px;">${ultHtml}</td>
          <td class="ag-mono">${orc}</td>
          <td class="ag-mono">${R$(c.gasto)}</td>
          <td class="ag-mono">${(c.impressoes || 0).toLocaleString('pt-BR')}</td>
          <td class="ag-mono">${(c.cliques || 0).toLocaleString('pt-BR')}</td>
          <td class="ag-mono">${fmtPct(c.ctr, 2)}</td>
          <td class="ag-mono">${c.pedidos || 0}</td>
          <td class="ag-mono" style="font-weight:700;">${R$(c.gmv)}</td>
          <td class="ag-mono" style="font-weight:700;${cAcos ? `color:${cAcos};` : ''}">${fmtPct(c.acos)}</td>
          <td><details class="ag-menu"><summary title="Ações">⋯</summary><div class="ag-menu-lista">
            ${ativa ? `<button onclick="this.closest('details').removeAttribute('open');window._agBoostCampanha('${c.id}', '${nomeJs}', ${c.budget || 0}, ${c.roasTarget != null ? c.roasTarget : 'null'}, ${c.acos === Infinity ? 'Infinity' : c.acos})">🚀 Sugerir mais investimento</button>` : ''}
            ${ativa ? `<button onclick="this.closest('details').removeAttribute('open');window._agSugerirCampanha('${c.id}', 'pausar', '${nomeJs}')">⏸ Sugerir pausar</button>` : ''}
            ${pausada ? `<button onclick="this.closest('details').removeAttribute('open');window._agSugerirCampanha('${c.id}', 'retomar', '${nomeJs}')">▶ Sugerir reativar</button>` : ''}
            <button onclick="this.closest('details').removeAttribute('open');window._agUsarCampanhaManual('${c.id}', '${nomeJs}')">✏️ Ajustar à mão</button>
          </div></details></td>
        </tr>`;
      };
      return `<div class="ag-hud-card" id="ag-tabela-campanhas" style="--ag-hud-accent:#818cf8;margin-bottom:20px;">
        ${cab}
        <div style="overflow-x:auto;">
        <table class="ag-tech-table">
          <thead><tr>
            ${th('nome', 'Campanha')}${th('status', 'Status')}<th>Última ação do agente / motivo</th>${th('orcamento', 'Orçamento')}${th('gasto', 'Gasto')}${th('impressoes', 'Impressões')}${th('cliques', 'Cliques')}${th('ctr', sigla('CTR'))}${th('pedidos', 'Pedidos')}${th('gmv', sigla('GMV'))}${th('acos', sigla('ACOS'))}<th></th>
          </tr></thead>
          <tbody>${linhas.map(linha).join('')}</tbody>
        </table>
        </div>
        ${linhasOrd.length > LIMITE ? `<div style="text-align:center;margin-top:10px;"><button class="btn btn-secondary btn-sm" onclick="window._agTabelaTodas()">${state.tabTodas ? 'Mostrar só as 10 primeiras' : `Ver todas (${linhasOrd.length})`}</button></div>` : ''}
        <div class="ag-nota" style="margin-top:10px;">“Sem limite” = campanha sem orçamento diário fixo (lance automático por meta de ${sigla('ROAS')}). Cores do ${sigla('ACOS')}: verde dentro da meta, amarelo acima da meta, vermelho perto do limite de pausa. Ações do menu ⋯ viram sugestões pra você aprovar em “Precisa de você”.</div>
      </div>`;
    }

    // ── 6. Seções secundárias, recolhidas por padrão ──
    function secaoColapsavel(chave, titulo, conteudo) {
      return `<details class="ag-sec" ${state.sec[chave] ? 'open' : ''} ontoggle="window._agToggleSec('${chave}', this.open)"><summary>${titulo}</summary><div class="ag-sec-corpo">${conteudo}</div></details>`;
    }
    function blocoABC(contaId) {
      const a = state.abcPorConta[contaId];
      if (!a && !state.carregandoABC) {
        return `<div class="ag-sec ag-linha-abc">🅰️ <b>Curva ABC de vendas</b> <span class="ag-sec-sub">ainda não gerada</span> <button class="btn btn-secondary btn-sm" onclick="window._agAnalisarABC()">Gerar Curva ABC</button></div>`;
      }
      return secaoColapsavel('abc', `🅰️ Curva ABC de vendas${a && !a.erro && a.alertas.length ? ` <span class="ag-contagem">${a.alertas.length} alerta(s)</span>` : ''}`, renderCurvaABC(contaId));
    }

    // ── Decisões automáticas (histórico, colapsado) ──
    // ── Relatórios diários ────────────────────────────────────
    function renderRelatorios(contaId) {
      const lista = state.relatorios.filter(r => r.conta_id === contaId);
      return `<div class="card" style="padding:20px 22px;margin-bottom:10px;">
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
    // Painel flutuante do chat: fica acessível de qualquer ponto da tela (antes
    // ficava no fim da página, depois das configurações). Mora num contêiner
    // próprio (#ag-chat-root) e preserva rascunho, foco e rolagem entre os
    // re-renders da tela, senão cada carga de dados apagava o que estava sendo
    // digitado.
    const PERGUNTAS_RAPIDAS = [
      'Como está a conta hoje?',
      'O que o agente fez nos últimos dias e funcionou?',
      'Quais campanhas devo olhar primeiro?',
      'Tem produto curva A em risco neste mês?',
    ];
    function mdLeve(t) {
      return h(t).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/^[-•]\s+/gm, '• ').replace(/\n/g, '<br>');
    }
    function contextoChatCurto(contaId) {
      const d = state.dadosAoVivoPorConta[contaId];
      if (state.carregandoDadosAoVivo && !d) return '⏳ carregando dados da conta...';
      if (!d) return 'sem dados da conta carregados ainda';
      if (d.erro) return '⚠️ dados da conta indisponíveis agora';
      return `${periodoLabel(d.periodo || state.negocioPeriodo)} · ${d.campanhasAtivas} ativa(s) · ${sigla('TACOS')} ${fmtPct(d.tacosGeral)} · dados de ${new Date(d.atualizadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    }

    function renderChatDrawer(rolarParaFim) {
      const raiz = document.getElementById('ag-chat-root');
      if (!raiz) return;
      const cfg = state.contaAbertaId && state.contaAbertaId !== '__novo__' ? configDaConta(state.contaAbertaId) : null;
      if (!cfg || state.carregando) { raiz.innerHTML = ''; return; }

      const antigo = document.getElementById('ag-chat-input');
      const rascunho = antigo ? antigo.value : '';
      const tinhaFoco = !!antigo && document.activeElement === antigo;
      const msgsAntigo = document.getElementById('ag-chat-msgs');
      const noFim = !msgsAntigo || msgsAntigo.scrollHeight - msgsAntigo.scrollTop - msgsAntigo.clientHeight < 60;
      const rolagemAntiga = msgsAntigo ? msgsAntigo.scrollTop : 0;

      if (!state.chatAberto) {
        raiz.innerHTML = `<button class="ag-chat-fab" onclick="window._agChatToggle()" title="Conversar com o agente sobre esta conta">💬 Perguntar ao agente</button>`;
        return;
      }
      raiz.innerHTML = `<div class="ag-chat-panel" role="dialog" aria-label="Conversa com o agente">
        <div class="ag-chat-head">
          <div style="min-width:0;">
            <div class="ag-chat-titulo">💬 Agente · ${h(nomeExibicao(cfg))}</div>
            <div class="ag-chat-sub">${contextoChatCurto(cfg.conta_id)}</div>
          </div>
          <div class="ag-chat-head-acoes">
            <button onclick="window._agAtualizarDados()" title="Atualizar os dados que o agente enxerga" ${state.carregandoDadosAoVivo ? 'disabled' : ''}>🔄</button>
            <button onclick="window._agChatNova()" title="Começar uma conversa nova" ${state.chatMessages.length ? '' : 'disabled'}>↺</button>
            <button onclick="window._agChatToggle()" title="Fechar (Esc)">✕</button>
          </div>
        </div>
        <div class="ag-chat-msgs" id="ag-chat-msgs">
          ${!state.chatMessages.length ? `<div class="ag-chat-vazio">
            <div style="font-weight:700;margin-bottom:4px;">Pergunte ou peça uma ação</div>
            <div>Eu vejo os indicadores, as campanhas, o que o agente fez e a curva ABC desta conta. Pedidos de mudança viram sugestões em "Precisa de você" — nada é executado sem o seu aprovar.</div>
            <div class="ag-chat-chips">${PERGUNTAS_RAPIDAS.map((p, i) => `<button onclick="window._agPerguntar(${i})">${h(p)}</button>`).join('')}</div>
          </div>` : ''}
          ${state.chatMessages.map(m => `<div class="ag-chat-linha ${m.role === 'user' ? 'eu' : 'ag'}"><div class="ag-chat-balao">${mdLeve(m.content)}</div></div>`).join('')}
          ${state.chatEnviando ? '<div class="ag-chat-linha ag"><div class="ag-chat-balao ag-chat-digitando"><span></span><span></span><span></span></div></div>' : ''}
        </div>
        <div class="ag-chat-entrada">
          <textarea id="ag-chat-input" rows="1" placeholder="Pergunte sobre a conta ou peça uma ação…" aria-label="Mensagem para o agente"
            oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window._agEnviarChat();}else if(event.key==='Escape'){window._agChatToggle();}"></textarea>
          <button class="btn btn-primary btn-sm" ${state.chatEnviando ? 'disabled' : ''} onclick="window._agEnviarChat()">Enviar</button>
        </div>
        <div class="ag-chat-dica">Enter envia · Shift+Enter quebra a linha</div>
      </div>`;

      const novoInput = document.getElementById('ag-chat-input');
      if (novoInput) {
        novoInput.value = rascunho;
        if (rascunho) { novoInput.style.height = 'auto'; novoInput.style.height = Math.min(novoInput.scrollHeight, 120) + 'px'; }
        if (tinhaFoco || rolarParaFim) { novoInput.focus(); novoInput.setSelectionRange(novoInput.value.length, novoInput.value.length); }
      }
      const msgs = document.getElementById('ag-chat-msgs');
      if (msgs) msgs.scrollTop = (rolarParaFim || noFim) ? msgs.scrollHeight : rolagemAntiga;
    }

    function perguntarRapido(i) {
      const input = document.getElementById('ag-chat-input');
      if (!input) return;
      input.value = PERGUNTAS_RAPIDAS[i];
      enviarChat();
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
      const voltar = state.contas.length > 0 ? `<button class="btn btn-secondary btn-sm" style="margin-bottom:16px;" onclick="window._agVoltarPortfolio()">← Voltar</button>` : '';

      if (!cfg) {
        // '__novo__' ou conta_id que ainda não tem linha salva — só o form.
        root.innerHTML = `${voltar}${renderConfig()}`;
        return;
      }

      const funil = renderImpressoesCliquesVendas(cfg.conta_id);
      root.innerHTML = `
        ${renderCabecalho(cfg)}
        ${renderPrecisaDeVoce(cfg.conta_id)}
        ${renderKPIs(cfg)}
        ${renderRegras(cfg)}
        ${renderTimeline(cfg.conta_id)}
        ${renderTabelaCampanhas(cfg)}
        ${renderLog(cfg.conta_id)}
        <div class="ag-secundarias">
          ${secaoColapsavel('funil', '📊 Funil de ADS (impressões → cliques → pedidos)', funil || '<div class="ag-vazio">Sem dados de ADS no período.</div>')}
          ${blocoABC(cfg.conta_id)}
          ${renderAcaoManual(cfg.conta_id)}
          ${secaoColapsavel('relatorios', '🗞️ Relatórios diários (gerados às 07:00 sobre o dia anterior)', renderRelatorios(cfg.conta_id))}
        </div>
      `;
    }

    el.innerHTML = `<div class="page">
      <div class="ag-titulo-pagina">
        <div class="ag-hero-title"><span class="ag-pulse-dot"></span><span>Agente Autônomo</span></div>
        <details class="ag-como">
          <summary title="Como o agente funciona">ⓘ Como funciona</summary>
          <div class="ag-como-corpo">Todo dia às 07:00 o agente revisa cada conta com o piloto ligado contra as regras da seção "Guardrails do piloto": pausa, reativa e ajusta orçamento ou meta de <abbr class="ag-sigla" title="Retorno sobre o investimento: quantos reais vendidos para cada R$ 1 gasto.">ROAS</abbr> sozinho quando a mudança está dentro da faixa combinada. O que passa do limite, ou que ele não pode decidir sozinho, aparece em "Precisa de você" pra você aprovar ou rejeitar.</div>
        </details>
      </div>
      <div id="ag-root"></div>
      <div id="ag-chat-root"></div>
      <style>
        .ag-chat-fab { position:fixed; right:22px; bottom:22px; z-index:40; padding:12px 18px; border:none; border-radius:99px; background:#6366f1; color:#fff; font-size:13.5px; font-weight:700; cursor:pointer; box-shadow:0 8px 24px rgba(99,102,241,.45); }
        .ag-chat-fab:hover { background:#5558e6; }
        .ag-chat-panel { position:fixed; right:22px; bottom:22px; z-index:41; width:min(430px, calc(100vw - 24px)); height:min(680px, calc(100vh - 110px)); display:flex; flex-direction:column; background:var(--bg-card); border:1px solid var(--border); border-radius:16px; box-shadow:0 18px 50px rgba(0,0,0,.28); overflow:hidden; }
        .ag-chat-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 14px; border-bottom:1px solid var(--border); background:linear-gradient(135deg, rgba(99,102,241,.14), transparent); }
        .ag-chat-titulo { font-size:14px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .ag-chat-sub { font-size:11px; color:var(--text-muted); margin-top:2px; }
        .ag-chat-head-acoes { display:flex; gap:4px; flex-shrink:0; }
        .ag-chat-head-acoes button { width:30px; height:30px; border:none; border-radius:8px; background:transparent; color:var(--text-muted); font-size:15px; cursor:pointer; }
        .ag-chat-head-acoes button:hover:not(:disabled) { background:var(--bg-card-hover,#f1f1f5); color:var(--text-primary,inherit); }
        .ag-chat-head-acoes button:disabled { opacity:.35; cursor:default; }
        .ag-chat-msgs { flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:10px; scroll-behavior:smooth; }
        .ag-chat-vazio { font-size:12.5px; line-height:1.6; color:var(--text-muted); padding:6px 2px; }
        .ag-chat-chips { display:flex; flex-direction:column; gap:7px; margin-top:12px; }
        .ag-chat-chips button { text-align:left; padding:9px 12px; border:1px solid var(--border); border-radius:10px; background:var(--bg-card-hover,#f7f7fb); color:var(--text-primary,inherit); font-size:12.5px; cursor:pointer; }
        .ag-chat-chips button:hover { border-color:#6366f1; }
        .ag-chat-linha { display:flex; }
        .ag-chat-linha.eu { justify-content:flex-end; }
        .ag-chat-balao { max-width:90%; padding:9px 13px; border-radius:14px; font-size:13px; line-height:1.55; word-break:break-word; }
        .ag-chat-linha.eu .ag-chat-balao { background:#6366f1; color:#fff; border-bottom-right-radius:4px; }
        .ag-chat-linha.ag .ag-chat-balao { background:var(--bg-card-hover,#f1f1f5); color:var(--text-primary,inherit); border-bottom-left-radius:4px; }
        .ag-chat-digitando { display:flex; gap:4px; align-items:center; padding:12px 14px; }
        .ag-chat-digitando span { width:6px; height:6px; border-radius:50%; background:var(--text-muted); animation:ag-ponto 1.2s infinite ease-in-out; }
        .ag-chat-digitando span:nth-child(2) { animation-delay:.15s; } .ag-chat-digitando span:nth-child(3) { animation-delay:.3s; }
        @keyframes ag-ponto { 0%,80%,100% { opacity:.3; transform:translateY(0); } 40% { opacity:1; transform:translateY(-3px); } }
        .ag-chat-entrada { display:flex; align-items:flex-end; gap:8px; padding:10px 12px 4px; border-top:1px solid var(--border); }
        .ag-chat-entrada textarea { flex:1; resize:none; max-height:120px; padding:9px 12px; border:1px solid var(--border); border-radius:10px; background:var(--bg-card); color:var(--text-primary,inherit); font:inherit; font-size:13px; line-height:1.45; }
        .ag-chat-entrada textarea:focus { outline:2px solid #6366f1; outline-offset:-1px; }
        .ag-chat-dica { padding:0 14px 8px; font-size:10.5px; color:var(--text-muted); }
        @media (max-width:640px) { .ag-chat-panel { right:8px; bottom:8px; height:calc(100vh - 80px); } }
        @media (prefers-reduced-motion:reduce) { .ag-chat-digitando span { animation:none; } .ag-chat-msgs { scroll-behavior:auto; } }
        @media (max-width:980px){.ag-grid-resp{grid-template-columns:1fr !important;}}

        .ag-titulo-pagina { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:14px; }
        .ag-titulo-pagina .ag-hero-title { color:var(--text-primary,inherit); font-size:19px; }
        .ag-como summary { cursor:pointer; font-size:12px; color:var(--text-muted); list-style:none; padding:3px 10px; border:1px solid var(--border); border-radius:99px; }
        .ag-como summary::-webkit-details-marker { display:none; }
        .ag-como-corpo { position:absolute; z-index:5; max-width:520px; margin-top:6px; padding:12px 14px; background:var(--bg-card); border:1px solid var(--border); border-radius:10px; font-size:12.5px; line-height:1.6; box-shadow:0 8px 24px rgba(0,0,0,.18); }
        .ag-como { position:relative; }
        .ag-sigla { text-decoration:underline dotted; cursor:help; }
        .ag-topbar { display:flex; align-items:center; justify-content:space-between; gap:12px 18px; flex-wrap:wrap; padding:12px 16px; margin-bottom:14px; border:1px solid var(--border); border-left:4px solid var(--ag-hud-accent,#6366f1); border-radius:12px; background:var(--bg-card); }
        .ag-topbar-l, .ag-topbar-r { display:flex; align-items:center; gap:10px 14px; flex-wrap:wrap; }
        .ag-sel-conta { width:auto; min-width:170px; font-weight:700; }
        .ag-saude-pill { font-size:12px; font-weight:800; padding:4px 11px; border-radius:99px; white-space:nowrap; }
        .ag-topbar-run { font-size:12px; color:var(--text-muted); }
        .ag-toggle { display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:700; cursor:pointer; }
        .ag-toggle input { position:absolute; opacity:0; pointer-events:none; }
        .ag-toggle-trilho { width:34px; height:19px; border-radius:99px; background:#64748b; position:relative; transition:background .15s; flex-shrink:0; }
        .ag-toggle-trilho::after { content:''; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:#fff; transition:transform .15s; }
        .ag-toggle input:checked + .ag-toggle-trilho { background:#22d3ee; }
        .ag-toggle input:checked + .ag-toggle-trilho::after { transform:translateX(15px); }
        .ag-toggle input:focus-visible + .ag-toggle-trilho { outline:2px solid #6366f1; outline-offset:2px; }
        .ag-aviso { margin:-6px 0 14px; padding:9px 13px; border-radius:8px; font-size:12.5px; line-height:1.5; }
        .ag-aviso-ok { background:#16a34a1a; border:1px solid #16a34a55; color:#16a34a; }
        .ag-aviso-erro { background:#dc26261a; border:1px solid #dc2626; color:#dc2626; margin-top:0; }
        .ag-aviso-aten { background:#d977061a; border:1px solid #d97706; color:#d97706; margin:10px 0 0; }
        .ag-nada { margin-bottom:14px; padding:8px 14px; font-size:12.5px; color:#16a34a; background:#16a34a12; border:1px solid #16a34a33; border-radius:10px; }
        .ag-nota { margin-top:10px; font-size:11.5px; line-height:1.6; color:var(--text-muted); }
        .ag-vazio { padding:18px 6px; font-size:13px; color:var(--text-muted); text-align:center; }
        .ag-sec-head { display:flex; align-items:center; justify-content:space-between; gap:10px 16px; flex-wrap:wrap; margin-bottom:14px; }
        .ag-sec-titulo { font-size:14px; font-weight:800; }
        .ag-sec-sub { display:block; font-size:11.5px; font-weight:400; color:var(--text-muted); margin-top:2px; }
        .ag-contagem { display:inline-block; min-width:20px; padding:0 7px; margin-left:4px; border-radius:99px; background:#d97706; color:#fff; font-size:11px; font-weight:800; text-align:center; line-height:19px; vertical-align:middle; }
        .ag-periodos { display:flex; gap:6px; flex-wrap:wrap; }
        .ag-lista-precisa { display:flex; flex-direction:column; gap:8px; }
        .ag-precisa-item { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:10px 12px; border:1px solid var(--border); border-left:3px solid var(--c); border-radius:8px; background:var(--bg-card-hover,#f7f7fb); }
        .ag-precisa-corpo { flex:1; min-width:240px; }
        .ag-precisa-titulo { font-size:13px; font-weight:700; line-height:1.5; }
        .ag-precisa-depara { font-size:12px; margin-top:4px; }
        .ag-precisa-motivo { font-size:11.5px; color:var(--text-secondary,var(--text-muted)); margin-top:4px; line-height:1.5; }
        .ag-precisa-acoes { display:flex; gap:6px; flex-shrink:0; }
        .ag-btn-ok { background:#16a34a1a; color:#16a34a; border:1px solid #16a34a55; }
        .ag-btn-no { background:#dc26261a; color:#dc2626; border:1px solid #dc262655; }
        .ag-kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; }
        .ag-kpi { position:relative; border-radius:12px; padding:13px 15px; border:1px solid var(--border); background:var(--bg-card-hover,#f7f7fb); overflow:hidden; min-height:92px; }
        .ag-kpi::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--ag-hud-accent,#6366f1); }
        .ag-kpi .ag-hud-value { font-size:21px; }
        .ag-meter { position:relative; height:6px; border-radius:99px; background:var(--border); margin:2px 0 6px; }
        .ag-meter-fill { height:100%; border-radius:99px; }
        .ag-meter-meta { position:absolute; top:-3px; width:2px; height:12px; background:var(--text-primary,#111); opacity:.55; }
        .ag-skel { background:linear-gradient(90deg,var(--border) 25%,transparent 50%,var(--border) 75%); background-size:200% 100%; animation:ag-brilho 1.3s infinite linear; border:none; }
        @keyframes ag-brilho { to { background-position:-200% 0; } }
        .ag-tl { display:flex; flex-direction:column; gap:0; }
        .ag-tl-item { display:flex; gap:12px; padding:10px 0 10px 12px; border-left:3px solid var(--c); margin-left:4px; border-bottom:1px solid var(--border); }
        .ag-tl-item:last-child { border-bottom:none; }
        .ag-tl-quando { width:92px; flex-shrink:0; font-size:11.5px; color:var(--text-muted); padding-top:2px; }
        .ag-tl-corpo { flex:1; font-size:12.5px; line-height:1.55; min-width:0; }
        .ag-tl-meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:5px; }
        .ag-tl-motivo { font-size:11.5px; color:var(--text-muted); }
        .ag-link { color:var(--accent-light,#818cf8); font-weight:700; text-decoration:none; }
        .ag-link:hover { text-decoration:underline; }
        .ag-th-sort { cursor:pointer; user-select:none; white-space:nowrap; }
        .ag-th-sort:hover { color:var(--text-primary,inherit); }
        .ag-tech-table td.ag-mono { white-space:nowrap; }
        .ag-camp-nome { font-weight:700; line-height:1.4; }
        .ag-camp-id { font-size:10.5px; color:var(--text-muted); font-weight:400; }
        .ag-camp-quando { font-size:11px; color:var(--text-muted); }
        .ag-camp-motivo { font-size:11px; color:var(--text-muted); font-weight:400; line-height:1.45; }
        .ag-camp-anom { margin-top:4px; font-size:10.5px; font-weight:700; color:#dc2626; }
        .ag-tech-table tbody td { font-weight:400; }
        .ag-tech-table tbody td:first-child { font-weight:400; }
        .ag-linha-destaque td { background:#6366f126 !important; transition:background .3s; }
        .ag-menu { position:relative; }
        .ag-menu summary { list-style:none; cursor:pointer; font-size:18px; line-height:1; padding:2px 9px; border-radius:6px; border:1px solid var(--border); color:var(--text-muted); }
        .ag-menu summary::-webkit-details-marker { display:none; }
        .ag-menu-lista { position:absolute; right:0; z-index:6; min-width:210px; margin-top:4px; padding:5px; display:flex; flex-direction:column; background:var(--bg-card); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.2); }
        .ag-menu-lista button { text-align:left; background:none; border:none; color:inherit; font-size:12.5px; padding:8px 10px; border-radius:6px; cursor:pointer; }
        .ag-menu-lista button:hover { background:var(--bg-card-hover,#f1f1f5); }
        .ag-regras-resumo p, .ag-regras-live p { margin:0 0 8px; font-size:13px; line-height:1.65; }
        .ag-regras-aviso { color:#d97706; font-weight:700; }
        .ag-regras-salvo { font-size:12px; font-weight:800; color:#16a34a; align-self:center; }
        .ag-regras-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:14px; }
        .ag-regra-bloco { padding:14px; border:1px solid var(--border); border-top:3px solid var(--c); border-radius:12px; background:var(--bg-card-hover,#f7f7fb); }
        .ag-regra-tit { font-size:13px; font-weight:800; margin-bottom:12px; }
        .ag-campo { margin-bottom:12px; }
        .ag-campo:last-child { margin-bottom:0; }
        .ag-campo-label { display:block; font-size:12px; font-weight:700; margin-bottom:5px; }
        .ag-campo-grupo { display:flex; align-items:stretch; }
        .ag-campo-grupo .form-input { border-top-right-radius:0; border-bottom-right-radius:0; min-width:0; }
        .ag-campo-sufixo { display:flex; align-items:center; padding:0 10px; border:1px solid var(--border); border-left:none; border-radius:0 8px 8px 0; background:var(--bg-card); color:var(--text-muted); font-size:11.5px; font-weight:700; white-space:nowrap; }
        .ag-campo-dica { margin-top:4px; font-size:11px; line-height:1.45; color:var(--text-muted); }
        .ag-avancado { margin-top:14px; }
        .ag-avancado > summary { cursor:pointer; font-size:12px; font-weight:700; color:var(--text-muted); }
        .ag-regras-live { margin-top:16px; padding:12px 14px; border:1px dashed var(--border); border-radius:12px; }
        .ag-regras-live-tit { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); margin-bottom:6px; }
        .ag-regras-rodape { display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap; margin-top:14px; }
        .ag-regras-estado { margin-right:auto; font-size:12px; font-weight:700; color:#d97706; }
        .ag-log-dia { margin:14px 0 4px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); }
        .ag-log-dia:first-child { margin-top:0; }
        .ag-log-item { border-left:3px solid var(--c); margin-bottom:4px; border-radius:0 8px 8px 0; background:var(--bg-card-hover,#f7f7fb); }
        .ag-log-item > summary { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 12px; cursor:pointer; list-style:none; font-size:12.5px; }
        .ag-log-item > summary::-webkit-details-marker { display:none; }
        .ag-log-hora { font-size:11px; color:var(--text-muted); font-variant-numeric:tabular-nums; min-width:36px; }
        .ag-log-titulo { flex:1; min-width:180px; font-weight:600; }
        .ag-log-origem { font-size:11px; color:var(--text-muted); }
        .ag-log-corpo { padding:2px 14px 12px 56px; font-size:12.5px; line-height:1.6; color:var(--text-secondary,inherit); }
        .ag-secundarias { margin-bottom:20px; }
        .ag-sec { margin-bottom:10px; }
        .ag-sec > summary { cursor:pointer; font-size:13px; font-weight:700; color:var(--text-muted); padding:6px 0; }
        .ag-sec-corpo { margin-top:8px; }
        .ag-linha-abc { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:13px; color:var(--text-muted); padding:6px 0; }
        .ag-linha-abc .ag-sec-sub { display:inline; margin:0; }
        @media (prefers-reduced-motion:reduce){ .ag-skel { animation:none; } .ag-toggle-trilho, .ag-toggle-trilho::after { transition:none; } }

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
    window._agFiltrarLog = (t) => { state.filtroLog = t; state.logMostrar = LOG_POR_PAGINA; render(); };
    window._agAtualizarDados = () => buscarDadosAoVivo(state.contaAbertaId, state.negocioPeriodo, true);
    // Troca o período da tela inteira: indicadores e tabela de campanhas.
    window._agMudarPeriodo = (periodo) => {
      state.negocioPeriodo = periodo;
      render();
      buscarNegocio(state.contaAbertaId, periodo);
      buscarDadosAoVivo(state.contaAbertaId, periodo);
    };
    window._agAtualizarTudo = () => {
      buscarNegocio(state.contaAbertaId, state.negocioPeriodo, true);
      buscarDadosAoVivo(state.contaAbertaId, state.negocioPeriodo);
    };
    window._agAbrirConta = (id) => {
      state.contaAbertaId = id; state.chatMessages = []; render();
      if (id && id !== '__novo__') { buscarNegocio(id); buscarDadosAoVivo(id); abcCarregarDoCache(id); render(); }
    };
    window._agTrocarConta = (id) => {
      if (id === '__portfolio__') window._agVoltarPortfolio(); else window._agAbrirConta(id);
    };
    window._agTogglePiloto = async (ativo) => {
      const cfg = configDaConta(state.contaAbertaId);
      if (!cfg) return;
      try {
        const { error } = await _sb.from('glr_agente_config').update({ ativo, atualizado_em: new Date().toISOString() }).eq('conta_id', cfg.conta_id);
        if (error) throw error;
        cfg.ativo = ativo;
        await _sb.from('glr_agente_log').insert({
          conta_id: cfg.conta_id, cliente_nome: cfg.cliente_nome || null, tipo: 'sistema',
          titulo: `Piloto ${ativo ? 'ligado' : 'desligado'}`,
          explicacao: ativo ? 'Piloto ligado pelo analista — o agente volta a revisar e agir nesta conta às 07:00.' : 'Piloto desligado pelo analista — o agente não roda mais sozinho nesta conta até ser ligado de novo.',
          dados: { ativo }, resultado: 'executado', origem: 'analista',
        });
      } catch (e) {
        alert('Não consegui alterar o piloto: ' + (e.message || e));
      } finally {
        render();
      }
    };
    window._agReativarAgora = reativarPendentesAgora;
    window._agToggleRegras = () => { state.sec.regras = !state.sec.regras; render(); };
    window._agRegrasMudou = () => {
      const txt = document.getElementById('ag-regras-live-txt'); if (txt) txt.innerHTML = textoRegras(lerRegrasDoForm());
      const est = document.getElementById('ag-regras-estado'); if (est) est.textContent = '● Alterações não salvas';
      const d = document.getElementById('ag-regras-descartar'); if (d) d.style.display = '';
    };
    window._agRegrasDescartar = () => { render(); };
    window._agLogBusca = (v) => {
      state.logBusca = v; state.logMostrar = LOG_POR_PAGINA;
      const lista = document.getElementById('ag-log-lista'); if (lista) lista.innerHTML = renderLogLista(state.contaAbertaId);
    };
    window._agLogMais = () => {
      state.logMostrar += LOG_POR_PAGINA;
      const lista = document.getElementById('ag-log-lista'); if (lista) lista.innerHTML = renderLogLista(state.contaAbertaId);
    };
    window._agChatToggle = () => { state.chatAberto = !state.chatAberto; renderChatDrawer(true); };
    window._agChatNova = () => { state.chatMessages = []; renderChatDrawer(); };
    window._agPerguntar = perguntarRapido;
    window._agFiltroTimeline = (k) => { state.timelineFiltro = k; state.timelineMostrar = 5; render(); };
    window._agTimelineMais = () => { state.timelineMostrar += 10; render(); };
    window._agOrdenar = (col) => {
      state.tabOrdem = state.tabOrdem.col === col ? { col, dir: -state.tabOrdem.dir } : { col, dir: col === 'nome' || col === 'status' ? 1 : -1 };
      render();
    };
    window._agTabelaTodas = () => { state.tabTodas = !state.tabTodas; render(); };
    window._agToggleSec = (chave, aberta) => { state.sec[chave] = aberta; };
    window._agIrParaCampanha = (id) => {
      state.tabTodas = true; render();
      const linha = document.getElementById('ag-camp-' + id);
      if (!linha) return;
      linha.scrollIntoView({ behavior: 'smooth', block: 'center' });
      linha.classList.add('ag-linha-destaque');
      setTimeout(() => linha.classList.remove('ag-linha-destaque'), 2200);
    };
    // Ações do menu ⋯ da tabela: nunca executam direto — viram sugestão em
    // "Precisa de você" pra você aprovar (mesmo fluxo do chat).
    window._agSugerirCampanha = async (id, tipo, nome) => {
      const rotulo = tipo === 'pausar' ? 'Pausar' : 'Reativar';
      await criarSugestoesNoKanban([{ campaign_id: Number(id), nome_campanha: nome, tipo, titulo: `${rotulo} campanha — ${nome}`, explicacao: `${rotulo} solicitado por você na tabela de campanhas.` }]);
      await carregarTudo();
      alert(`Sugestão criada: "${rotulo} — ${nome}". Aprove (ou rejeite) na faixa "Precisa de você" lá em cima.`);
    };
    window._agAnalisarABC = () => abcAtualizar(state.contaAbertaId);
    window._agVoltarPortfolio = () => { state.contaAbertaId = null; render(); };
    window._agExecutarAcaoManual = executarAcaoManual;
    window._agRodarAgora = rodarAgenteAgora;
    window._agAprovarAlerta = aprovarAlerta;
    window._agDescartarAlerta = descartarAlerta;
    window._agBoostCampanha = boostCampanha;
    window._agUsarCampanhaManual = (id, nome) => {
      state.sec.manual = true; render(); // abre o painel antes de preencher
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
