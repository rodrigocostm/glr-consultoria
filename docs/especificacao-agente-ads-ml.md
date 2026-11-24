# Especificação — Agente de ADS do Mercado Livre com inteligência real

Status: **aprovado e em implementação** · 23/11/2026

## 1. Problema

O agente atual (`api/_agente-ml.js`) é um conjunto de regras independentes: estoque, ACOS do
produto, ACOS da campanha, TACOS, leilão. Cada regra decide sozinha e ninguém confere se o
conjunto faz sentido. Resultado visto na Casa D (23/11):

- a Cômoda Belize (ROAS 36x, melhor anúncio da Campanha GERAL) recebeu "pausar" por falta de
  estoque, sem "voltar quando repor" e sem pesar que ela sustenta a campanha;
- a extensão, com outra lógica, dizia "escalar" o mesmo anúncio;
- sugestões trazem o número, mas não o raciocínio de analista ("por que isto e não aquilo").

Além disso, nem a Tiops nem o MCP Seller conseguem **alterar** campanhas do ML: tudo é aplicado à
mão pelo analista. Então cada sugestão precisa ser poucas, certas e fáceis de executar.

## 2. Objetivo

Um agente que, por conta do ML, leia **tudo junto** e devolva **um único plano coerente por
campanha**, como um analista sênior faria:

- o que fazer (no máximo 3 ações por campanha, em ordem);
- por quê, em 1–2 frases com os números que decidiram;
- o que esperar (efeito previsto e em quanto tempo);
- quando reavaliar e qual sinal faria desfazer.

A extensão e a tela ADS Mercado Livre passam a mostrar **só esse plano** — uma voz só.

## 3. Fora do escopo (agora)

- Aplicar mudanças sozinho no ML (não há escrita disponível; a política do ML proíbe automação na tela).
- Shopee (o agente de lá continua como está).
- Criar campanhas novas sozinho. O agente **sugere** criar campanha e mover produtos
  (decidido em 23/11); o analista cria/move à mão com o passo a passo.

## 4. Entradas por conta (o "dossiê")

Montado no servidor, 1 vez por dia (07h) e sob demanda ("Analisar agora"):

| Bloco | Conteúdo | Fonte |
|---|---|---|
| Cliente | meta de ACOS, teto de TACOS, meta de faturamento do mês, margem por produto, modelo de comissão | `glr_agente_config`, metas, Produtos |
| Campanhas | ROAS objetivo, orçamento, estratégia, idade, ACOS/ROAS 7/15/30 dias (D-2), perda de impressão por orçamento × classificação, ACOS de referência da categoria, uso do orçamento | Tiops `ml_ads_*` (ou MCP Seller como leitura) |
| Histórico | mudanças de ROAS/orçamento nos últimos 30 dias (data, de → para) e o efeito medido | log do agente + histórico do ML |
| Produtos (por família) | gasto, vendas por ADS e orgânicas, conversão, CTR, preço, estoque e dias de cobertura, buy box, nota do anúncio, curva ABC | base sincronizada, agente de Estoque, Qualidade |
| Conta | TACOS do mês, faturamento × meta, taxa de cancelamento | base + Projeção |
| Pendências | sugestões já abertas e o que o analista descartou (e por quê) | `glr_agente_log` |

## 5. Como decide

**Camada 1 — fatos e travas (código, determinístico).** Calcula os números e marca as travas:

- campanha com menos de 30 dias → aprendendo (só mexe se ACOS > 2× a meta);
- ROAS/orçamento mudado há menos de 7 dias → aguardar;
- passo máximo de ROAS/orçamento: 15% (25% se ACOS > 2× meta), nunca abaixo do ROAS da margem;
- produto sem estoque → não pode receber "escalar"; produto curva A não é pausado sem plano de volta;
- perda por classificação > 50% → mais verba não resolve (o caminho é anúncio/preço ou ROAS);
- teto de TACOS do cliente manda: dentro do teto, não aperta campanha que vende.

**Camada 2 — raciocínio (IA).** O modelo recebe o dossiê + as travas e escreve o plano. Regras do
prompt: respeitar as travas; ordem produtos → campanha; no máximo 3 ações por campanha; cada ação
com motivo, efeito esperado, data de reavaliação e critério de desfazer; dizer "não mexer" quando
for o caso (é uma resposta válida e frequente).

**Camada 3 — conferência (código).** Valida a saída antes de gravar: valor dentro do passo máximo,
campanha/produto existem, nada contradiz uma trava, nenhuma ação dupla no mesmo alvo. O que falhar
é descartado e registrado (não chega ao analista).

## 6. Saída

Uma linha por ação em `glr_agente_log` (o formato que a extensão e a tela já leem), com campos novos:

```
dados: {
  acao, campaign_id, item_ids, de, para,           // como hoje
  plano_id, ordem,                                   // ações do mesmo plano da campanha
  motivo,        // 1–2 frases com os números
  esperado,      // "ACOS cai para ~9% em 7–10 dias"
  reavaliar_em,  // data AAAA-MM-DD
  desfazer_se,   // "se as vendas da campanha caírem mais de 20%"
  voltar_quando, // ex.: "repor estoque" (para pausas)
  confianca      // alta / média / baixa
}
```

E um resumo por campanha ("Campanha GERAL: não mexer até 30/11 — ROAS 14x na meta; a perda é de
classificação, o ganho está nos anúncios") para quando não há ação.

## 7. Onde aparece

- **Tela ADS Mercado Livre:** um cartão por campanha com o plano (ações em ordem, passo a passo,
  motivo, esperado, reavaliar). "Não mexer" também aparece, para o analista saber que foi analisado.
- **Extensão:** o selo na linha passa a mostrar a ação + motivo do plano; a análise própria da
  extensão vira só leitura de apoio (aparece apenas onde o agente não tem plano, e nunca contradiz).
- **Caixa de decisões:** as ações com maior impacto em R$/semana.

## 8. Medição

Para cada ação marcada como feita (pela extensão ou à mão): comparar 7 dias antes × 7 dias depois
(ACOS, vendas, gasto) e registrar se deu certo. Esse resultado entra no dossiê das próximas análises
(o agente aprende o que funciona em cada conta).

## 9. Custo estimado

1 chamada de IA por conta por dia, dossiê de ~15–30 mil tokens. Com ~55 contas de ML, na ordem de
alguns dólares por dia. Contas sem mudança relevante desde a última análise são puladas.

## 10. Plano de entrega

1. **Dossiê + travas** (camada 1) reaproveitando o que `_agente-ml.js` já calcula. Sem mudar a tela.
2. **Raciocínio + conferência** (camadas 2 e 3) rodando em paralelo ao agente atual, só gravando
   para comparação (1 semana, 3–5 contas, incluindo a Casa D).
3. **Revisão com o analista** dos planos lado a lado com as sugestões atuais.
4. **Troca:** a tela e a extensão passam a mostrar o plano novo; o agente antigo vira só trava.
5. **Medição** ligada e entrando no dossiê.

## 11. Decisões (23/11/2026)

1. **Teto de TACOS:** todas as contas têm. A falta de margem cadastrada (custo em Produtos ou margem
   mínima após ADS) não trava mais a escala: só deixa o passo menor (confiança no máximo média).
2. **Ações por dia:** sem limite fixo. O que vale é resultado: **crescer o faturamento com o gasto
   equilibrado** (TACOS no teto). Limite técnico: até 3 ações por campanha por análise.
3. **Contas:** todas as contas de ML cadastradas no agente (sem piloto). A escala deixou de depender
   do "piloto de escala"; o piloto agora só liga o modo de teste controlado com medição de 21 dias.
4. **Criar campanha e mover produtos:** o agente pode sugerir os dois.

### Ações que o plano pode conter

`roas_target`, `orcamento`, `pausar` (campanha), `retirar_produto`, `mover_produto` (para campanha
existente), `adicionar_produto`, `criar_campanha` (nome, estratégia, ROAS objetivo, orçamento e
produtos — o passo a passo mostra como criar no ML e mover os produtos), e "não mexer" por campanha.
Regras para `criar_campanha`: só para um grupo de 3 ou mais produtos parecidos que não cabem nas
campanhas atuais; no máximo 1 por conta por semana.

## 12. Implementação (onde está no código)

- `api/_especialista-ml.js` → `planejar()` (camada 2, IA) e `conferirPlano()` (camada 3).
- `api/_agente-ml.js` → monta o dossiê e as travas, chama o planejador depois de TODAS as regras
  (produtos, campanhas, curva ABC, produtos fora do ADS) e grava as ações com `motivo`, `esperado`,
  `reavaliar_em`, `desfazer_se`, `voltar_quando`, `confianca`, `plano_id`, `ordem`. Grava também um
  log `sistema` com `dados.planejador = true` e `dados.planos` (inclusive as campanhas "não mexer").
  Sem IA ou com resposta inválida, volta ao caminho antigo (`revisar()`).
- `api/_ml-crescimento.js` → margem não cadastrada vira aviso (passo menor) em vez de bloqueio.
- `js/pages-agente-ml.js` → quadro "Plano do especialista" com as campanhas "não mexer"; cada passo
  mostra o motivo, o esperado, a data de reavaliar e quando desfazer.
- `extensao-mercado-ads` v1.4 → mesmo plano na tela do ML, selo cinza "não mexer até dd/mm".
