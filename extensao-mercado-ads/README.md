# GLR Copiloto ADS (extensão do Chrome)

Copiloto do Mercado Ads. Abre um painel ao lado da tela de **Product Ads** com duas abas:

- **Análise — funciona sem login e sem o sistema da GLR.** Lê só as tabelas que o próprio
  Mercado Ads mostra na sua sessão (nada sai do navegador, não usa MCP nem API):
  - **Lista de campanhas:** veredito por campanha — *Escalar*, *Manter*, *Conter*, *Corrigir*,
    *Aguardar* (aprendendo) ou *Sem dados* — com o motivo, a ação sugerida (ROAS objetivo ou
    orçamento) e o gargalo (orçamento × lance). O selo aparece também na linha da tabela do ML.
  - **Dentro da campanha:** veredito por anúncio — *Escalar*, *Manter*, *Avaliar*, *Mover*,
    *Retirar* ou *Sem dados* — com CTR, conversão e CPC; **Preencher ROAS/orçamento** e
    **Mostrar o anúncio** preparam a mudança na tela (quem salva é você).
  - **Modo Expert:** tabela ordenável por veredito, ACOS, ROAS, investimento, receita, uso do orçamento…
  - **Meta de ACOS da conta** (campo no painel): sem ela, vale a de cada campanha (100 ÷ ROAS objetivo).
- **Pacote GLR — opcional, para clientes da GLR.** Com o login da GLR (ícone da extensão), mostra o
  pacote do dia do agente, preenche os campos e pode aplicar passos no ritmo de uma pessoa.

## Instalar
1. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor**.
2. **Carregar sem compactação** → escolha esta pasta (`extensao-mercado-ads`). Para atualizar, clique em ↻ na extensão.
3. Fixe o ícone **GLR Copiloto ADS** na barra do Chrome.

## Regras dos vereditos (analise.js → LIM)
- Campanha: *Conter* com ACOS > 120% da meta (sugere subir o ROAS objetivo 12%); *Escalar* com ACOS ≤ 80%
  da meta e 3+ vendas — se o orçamento já é usado em 85%+, aumentar orçamento 20%; senão, baixar o ROAS
  objetivo 12% (nunca abaixo do ROAS da meta); *Corrigir* com R$ 40+ investidos sem venda.
- Anúncio: *Retirar* quando investe acima de R$ 40 (ou 1,5× o custo de uma venda) sem vender; *Avaliar*
  com 60+ cliques sem venda ou CTR < 0,25% em 3 mil+ impressões; *Mover* com ACOS > 150% da meta;
  *Escalar* com ACOS ≤ 60% da meta e 2+ vendas.

## Segurança
- A Análise não envia nada para fora do navegador.
- O Pacote GLR usa o login próprio no Supabase com a chave pública (a mesma do site), com as regras de acesso do site.

Tela mapeada em 05/11/2026 (ads.mercadolivre.com.br/product-ads/admin). Se o Mercado Livre mudar as
tabelas, a análise mostra "abra Product Ads" e a tela do ML segue normal.
