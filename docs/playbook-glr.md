# Playbook GLR — Fundação v1

Uso exclusivamente interno. O portal do cliente recebe apenas resultados consolidados e planos aprovados. Não armazenar senhas de marketplaces neste módulo.

## Ciclo por conta e marketplace
1. Onboarding: gestor atribuído, acessos autorizados, conexão verificada, solicitação e importação de custos, histórico disponível. Custos faltantes geram pendência, nunca bloqueio geral.
2. Diagnóstico: receita válida, TACOS, margem quando conhecida, curva ABC, conversão, estoque, qualidade e riscos. Dados ausentes são desconhecidos, não zero.
3. Planejamento: três cenários mensais (conservador, realista, agressivo), com receita, Ads, TACOS, lucro estimado quando possível, premissas, riscos e ações. Aprovação do gestor e cliente; plano por canal e consolidado sem duplicar pedidos.
4. Execução: caixa de decisões existente, segregada por gestor, conta e canal. Trabalhar curva A e produtos potenciais simultaneamente; 70/30 é sugestão ajustável.
5. Validação: registrar intervenção, autor humano/IA, valores anteriores e posteriores, janela e fatores externos. Revisões sugeridas em 3/7/15 dias conforme volume e atribuição. Classificar positiva, negativa ou inconclusiva; não confundir correlação com causalidade.
6. Escala: gradual, acelerada ou proteção conforme TACOS, demanda, estoque, margem conhecida e orçamento aprovado. Custos desconhecidos exigem cautela, não bloqueio operacional.
7. Replanejamento: resumo semanal, revisão mensal de metas e trimestral de estratégia. Avanço por evidências, não por dias decorridos.

## Regras por canal
- Shopee: TACOS da conta primeiro; ACOS/ROAS por campanha para diagnóstico, GMV Max, orçamento limitado, conversão, campanhas comerciais e exclusivos.
- Mercado Livre: TACOS, Product Ads, catálogo, Buy Box, atributos, reputação, Full/Flex, frete e competitividade.
- TikTok Shop: afiliados, criadores, vídeos, lives, comissão, Ads e custo total de aquisição; evitar dupla contagem de custos.
- Amazon: Sponsored Products, TACOS, Buy Box, SEO, avaliações, estoque, FBA e tarifas.
- Magalu: catálogo, preço, Ads quando disponível, logística, reputação e conversão.
Cada integração deve declarar disponibilidade, atualização e permissões dos dados. Não inventar indicadores ausentes.

## Supervisão e segurança
Prioridades: crítica (prejuízo confirmado ou risco operacional), alta (desvio relevante), média (otimização), estratégica (expansão). Cobrar pendências e escalar reincidências aos sócios.
Índice de eficiência proposto: rentabilidade 35%, plano 30%, impacto das decisões 20%, Ads 10%, disciplina 5%. Exibir cobertura dos dados e não ranquear como comparáveis pontuações incompletas.
Autonomia: leitura, tarefas e alertas automáticos; alterações Ads somente após autorização explícita por conta, limites, dados suficientes, auditoria e mecanismo de interrupção; preços e investimentos relevantes exigem aprovação humana. Nesta fase nenhuma escrita em marketplace é habilitada.
Desenvolvimento de Produtos em guia separada: catálogo atual e descoberta semanal de mercado; identificação, viabilidade, preparação, teste, validação, escala. Tiops e APIs conforme disponibilidade.

## Mapeamento inicial
Reutilizar rotas existentes: onboarding, conexoes, produtos, projecao, decisoes, plano-acao, vendas-prejuizo, rentabilidade, dre, mercado-tiops, expansao, segundo-cerebro, adviser, relatorios, relatorio-semanal, portal-admin, gestores, clientes. Presença no menu não comprova funcionamento.
Novos módulos propostos: planejamento estratégico, registro/validação de intervenções, desenvolvimento de produtos. Melhorar saúde da conta e supervisão existentes.
Próxima etapa: inspecionar modelos e RLS do Supabase, rotas JS, integrações e testes; definir persistência aditiva, isolamento por cliente e gestor, deduplicação de tarefas e migração reversível. Nenhuma alteração destrutiva ou publicação nesta fase.
