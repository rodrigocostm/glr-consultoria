# Grupo WhatsApp dos agentes — teste local

Requer Node.js 22+ no MacBook e uma cópia completa deste repositório.

```bash
cd integrations/whatsapp
npm ci
npm start
```

Digite seu login de equipe GLR no Terminal. A senha não aparece e o login fica apenas em memória. MFA não é suportado neste protótipo. Nunca envie senha ou tokens pelo chat.

Escaneie o QR com WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho. Escolha um grupo interno da equipe. Nenhuma mensagem é enviada ao conectar.

Qualquer integrante do grupo selecionado pode enviar pelo seu próprio WhatsApp:

- `!adviser Como avançar para 200 mil de receita?`
- `!gerente Analise a Mega Facil e as prioridades de hoje.`
- `!shopee Como está o TACOS da Gama?`
- `!ml Analise as campanhas da Mega Facil.`

Outros: `!estoque`, `!margem`, `!atendimento`, `!redator`.

A ponte responde aos comandos de todos os participantes do grupo selecionado, inclusive do número vinculado. Conversas privadas, outros grupos e mídia são ignorados. Use `!ping` para testar a conexão sem consultar a IA. Todos no grupo escolhido podem ver os dados e respostas: escolha apenas equipe autorizada. O cliente precisa constar na pergunta. Cada grupo/agente tem uma conversa própria no login GLR; não compartilhe esse login.

Mac ligado e programa aberto são necessários. Ctrl+C interrompe. Desconexões temporárias recebem até cinco tentativas de reconexão; selecione o grupo novamente quando solicitado. A sessão do WhatsApp fica na pasta privada `auth/`: não compartilhe nem envie ao Git. Para revogar, remova o aparelho no WhatsApp.

Baileys é não oficial. Há risco de bloqueio ou desconexão, sem garantia para o atendimento do número principal. Prefira número de teste. Os agentes usam o chat e as permissões já existentes no GLR, incluindo criação de sugestões e notas quando solicitado. Não há disparos nem criação automática de grupo.

Validação: testes de roteamento, isolamento e duplicatas. Pareamento real, entrega em grupo e login GLR ainda precisam ser testados no celular. Este código não significa que o WhatsApp já foi conectado.
