# Agente de ADS autônomo — Mercado Livre (via Adman)

Código: `api/_agente-ml-adman.js` (regras), `api/_adman.js` (conexão com a Adman), rodada `?rodada=adman` em `api/agente-cron.js`, disparada às **09:00** (Brasília) por `api/sync-dados.js`.

Igual ao agente da Shopee: analisa as campanhas uma vez por dia e **age sozinho dentro dos limites abaixo**, sem pedir aprovação a cada mudança. Cada ação (ou simulação) fica em `glr_agente_log` com `origem='adman'`, o motivo, o valor **antes** e **depois** e as métricas que levaram à decisão. Aparece no histórico do Agente como "Agente autônomo (Adman)".

## Ligar, desligar, simular

Tabela `glr_ads_autonomo` (uma linha por conta, criada por `supabase-ads-autonomo.sql`):

| Campo | Efeito |
|---|---|
| `ligado = false` | **chave de desligar**: o agente não lê nem mexe em nada da conta |
| `modo = 'simulacao'` | padrão: só registra o que faria (`resultado='simulado'`) |
| `modo = 'execucao'` | aplica no Mercado Livre pela Adman (`resultado='executado'` ou `'erro'`) |
| `limites` (json) | sobrescreve qualquer limite abaixo só para essa conta |

Chave geral de emergência: variável `ADS_AUTONOMO_DESLIGADO=1` no Vercel desliga para todas as contas.
Teste manual: `/api/agente-cron?rodada=adman&simular=1` (nunca aplica, mesmo em modo execução).

Precisa das variáveis `ADMAN_MCP_URL` e `ADMAN_MCP_TOKEN` no Vercel (endereço e chave do MCP da Adman).

## O que ele pode fazer

| # | Ação | Quando | Limite |
|---|---|---|---|
| 1 | Pausar anúncio | 14 dias com gasto ≥ R$ 50, ≥ 80 cliques e **zero venda** | máx. 3 pausas/dia por conta |
| 2 | Pausar campanha | 14 dias com gasto ≥ R$ 100 e zero venda, campanha com ≥ 14 dias | idem |
| 3 | Apertar ROAS alvo | ACOS 7 dias > alvo × 1,3 (com ≥ R$ 70 e ≥ 3 vendas) | +20% por vez, nunca acima de 35 |
| 4 | Soltar ROAS alvo | ACOS < alvo × 0,7, perde ≥ 50% por ranking e TACOS da conta ≤ meta | −10% por vez; ACOS alvo nunca acima de meta × 1,5; ROAS nunca abaixo de 4 |
| 5 | Subir orçamento | perde ≥ 10% das impressões por verba, ACOS ≤ alvo e TACOS da conta ≤ meta | +20%/dia; soma das campanhas ≤ R$ 1.000/dia |
| 6 | Baixar orçamento | ACOS > 2× alvo e ROAS já no máximo | −20%/dia; nunca abaixo de R$ 10/dia |

Regras gerais: no máximo **6 ações por dia** por conta, **uma ação por campanha por dia**, e a mesma campanha ou anúncio só é mexida de novo **3 dias depois** (para dar tempo de medir). Datas em `limites.datas_congeladas` só observam.

## O que ele nunca faz

Criar campanha, reativar campanha ou anúncio pausado, mover anúncio entre campanhas, mexer em campanha pausada ou eliminada, mudar regra de anúncio, aceitar ou rejeitar alertas da Adman.

## Piloto

Expresso Móveis (`802228249`), meta de ACOS 6% (de `glr_agente_config`), começa **ligado em simulação**.
