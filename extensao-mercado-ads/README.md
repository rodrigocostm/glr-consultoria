# GLR Copiloto Mercado Ads (extensão do Chrome)

Mostra dentro do painel do Mercado Ads o pacote do dia que a GLR montou para a
campanha aberta, preenche os campos e destaca onde clicar. **Quem salva no
Mercado Livre é sempre o analista** — a extensão nunca clica em "Salvar".

## Instalar (equipe GLR)
1. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor** (canto superior direito).
2. Clique em **Carregar sem compactação** e escolha esta pasta (`extensao-mercado-ads`).
3. Fixe o ícone **GLR Copiloto Mercado Ads** na barra do Chrome e entre com o seu login do sistema da GLR.

## Usar
- Em **Central de vendedores → Publicidade → Product Ads**, o painel "GLR · pacote do dia" aparece no canto.
- Na lista de campanhas: mostra os passos de cada campanha e o botão **Abrir a campanha**.
- Dentro da campanha:
  - **Preencher o ROAS / o orçamento** — abre "Modificar sua campanha", coloca o valor e destaca o **Salvar**. Confira e salve.
  - **Mostrar o anúncio** — filtra a tabela pelo código e destaca o **⋮** → **Pausar**.
  - **Adicionar aqui** — copia os códigos e destaca **Adicionar anúncios**.
- **Mover produto de campanha** — é feito na tela **Anúncios patrocinados**, sem pausar: **Preparar a mudança** procura o anúncio, marca a linha, abre **Mais ações → Mover para uma campanha** e escolhe o destino; confira e clique em **Mover anúncios patrocinados** (o anúncio já entra ativo na campanha nova).
- **Aplicar N passo(s) sozinho** (na lista de campanhas ou dentro de uma) — a extensão aplica sozinha, no ritmo de uma pessoa (4 a 9 s entre ações, digitando devagar): ajusta ROAS objetivo e orçamento (clica em Salvar), pausa anúncios pelo ⋮ e move anúncios de campanha pela tela Anúncios patrocinados (confere na coluna Campanha). Depois de cada passo confere na tela; no primeiro imprevisto para e mostra onde. Até 8 passos por vez; botão **Parar** a qualquer momento. Colocar produto, criar campanha nova e pausar campanha ficam à mão. Na primeira vez em cada conta pede a confirmação de que você assume o risco (o ML não permite automação de ADS).
- **Feito** marca o passo no sistema (o agente também confere sozinho na análise da manhã). **✕** descarta.

## Segurança
- Login próprio no Supabase com a chave pública (a mesma do site); nenhuma chave secreta.
- Acesso ao banco com as mesmas regras do site (sessão do analista).
- Não lê nem envia dados do Mercado Livre para fora; só lê a tela para achar os campos.

Tela mapeada em 30/10/2026. Se o Mercado Livre mudar o painel e um botão não for
encontrado, o passo mostra a mensagem e o analista faz pela tela normalmente.
