# Aplicação das correções de acesso

As alterações de código e banco devem ser aplicadas juntas. Esta branch não confirma a configuração atual de produção.

1. Faça backup e valide em um ambiente de teste com usuários de equipe, portal ativo, portal desativado e usuário desconhecido.
2. Confira/aplique `supabase-portal-seguranca.sql`, depois `supabase-access-hardening.sql` no SQL Editor do Supabase. A segunda migração bloqueia usuários sem cadastro explícito na equipe. Isso pode interromper o acesso até o passo seguinte.
3. Cadastre cada pessoa da equipe por e-mail confirmado, substituindo o exemplo abaixo por um endereço real verificado. Não cadastre clientes nesta tabela. Ninguém é promovido automaticamente.

```sql
insert into public.glr_staff (user_id, ativo)
select id, true from auth.users
where lower(email) = lower('SUBSTITUA_PELO_EMAIL_DA_EQUIPE')
  and email_confirmed_at is not null
on conflict (user_id) do update set ativo = true;
```

4. Configure um `CRON_SECRET` aleatório e forte na Vercel. O mesmo segredo autentica os disparos internos. Não publique o valor no repositório. `MCP_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` e as chaves de IA continuam nas variáveis do servidor.
5. `GLR_INTERNAL_ORIGIN` é opcional e deve apontar para a origem HTTPS confiável deste ambiente. O padrão é `https://consultoriaglr.com.br`. Configure também no preview para ele não chamar produção. O Host recebido do navegador não determina mais o destino dos segredos.
6. Publique esta branch somente após conferir os passos anteriores. Teste login, chat, imagens, consultas do portal, disparos manuais e agendados. Usuários do portal não podem abrir chats internos; usuários desativados/desconhecidos devem receber bloqueio.

## Alterações de comportamento

- Apenas usuários explicitamente cadastrados em `glr_staff` usam chats internos, IA de imagens e disparos manuais dos agentes.
- Clientes do portal usam uma lista explícita de consultas no proxy; `raw` e ações fora dessa lista são negadas. Operações do portal antes aceitas pela lista de bloqueio podem precisar de implementação dedicada com validação de propriedade de cada recurso.
- O agendador exige o segredo correto; cabeçalhos que se dizem da Vercel não concedem acesso. Disparos manuais do agente aceitam sessão da equipe.
- Não há fallback para permissões locais quando o banco falha.

## Limites desta entrega

Não houve aplicação de SQL, publicação, rotação de credenciais nem testes contra dados reais. A chave de integração ainda é usada no navegador da equipe no código legado. As coleções globais de custos liberadas ao portal pelo SQL anterior ainda precisam ser separadas por cliente. A lista de conta do proxy não substitui validar propriedade de cada ID de pedido/produto no serviço upstream. Limites distribuídos de uso, auditoria completa de dependências, XSS e revisão integral de todos os endpoints ficam pendentes. Não considerar esta entrega uma certificação de segurança.

## Validação local

Execute `node --test tests/security.test.js`. Os testes simulam serviços externos e não usam credenciais reais nem consomem APIs pagas.
