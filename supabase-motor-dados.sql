-- ============================================================
-- GLR Consultoria — Motor de dados (Fase 0)
-- Rodar UMA vez no Supabase: Dashboard → SQL Editor → New query →
-- colar tudo → Run. Pode rodar de novo sem problema (é idempotente).
--
-- Só CRIA coisas novas. Não altera nem apaga nenhuma tabela existente
-- (glr_storage, glr_agente_*, etc. ficam intactas).
-- ============================================================

-- 1) Pedidos normalizados de todos os marketplaces ---------------------
create table if not exists public.glr_pedidos (
  marketplace      text        not null,               -- shopee | ml | amazon | magalu
  conta_id         text        not null,               -- shopId / meliUserId / ...
  pedido_id        text        not null,
  criado_em        timestamptz not null,               -- data da venda
  atualizado_mkt   timestamptz,                        -- última mudança no marketplace
  status_original  text,                               -- status cru do marketplace
  situacao         text        not null check (situacao in ('valido','cancelado','devolvido')),
  valor_bruto      numeric(14,2) not null default 0,   -- total pago pelo comprador
  valor_itens      numeric(14,2),
  frete            numeric(14,2),
  taxas            jsonb,                              -- comissão, taxa fixa... quando disponível
  liquido          numeric(14,2),                      -- repasse, quando disponível
  itens            jsonb,                              -- [{item_id, sku, nome, qtd, preco}]
  sincronizado_em  timestamptz not null default now(),
  primary key (marketplace, conta_id, pedido_id)
);
create index if not exists glr_pedidos_conta_data on public.glr_pedidos (conta_id, criado_em);
create index if not exists glr_pedidos_data on public.glr_pedidos (criado_em);

-- 2) ADS por dia ----------------------------------------------------------
create table if not exists public.glr_ads_diario (
  marketplace      text    not null,
  conta_id         text    not null,
  data             date    not null,
  gasto            numeric(14,2) not null default 0,
  gmv_ads          numeric(14,2) not null default 0,  -- vendas atribuídas pela plataforma
  pedidos_ads      integer not null default 0,
  impressoes       bigint  not null default 0,
  cliques          bigint  not null default 0,
  sincronizado_em  timestamptz not null default now(),
  primary key (marketplace, conta_id, data)
);

-- 3) Estado da sincronização (alimenta a tela "Saúde dos dados") -----------
create table if not exists public.glr_sync_estado (
  marketplace      text not null,
  conta_id         text not null,
  recurso          text not null,                      -- pedidos | ads
  ultimo_sucesso   timestamptz,
  ultima_tentativa timestamptz,
  ultimo_erro      text,
  cursor           jsonb,                              -- até onde já sincronizou
  registros        integer default 0,                  -- quantos gravou na última rodada
  primary key (marketplace, conta_id, recurso)
);

-- 4) Vendas por dia (fonte única de faturamento para TODAS as telas) -------
--    faturamento_valido = sem cancelados e sem devolvidos (padrão do sistema)
--    faturamento_bruto  = tudo (base atual do TACOS do Agente)
create or replace view public.vw_vendas_dia as
select
  marketplace,
  conta_id,
  (criado_em at time zone 'America/Sao_Paulo')::date                  as dia,
  count(*) filter (where situacao = 'valido')                          as pedidos_validos,
  coalesce(sum(valor_bruto) filter (where situacao = 'valido'), 0)     as faturamento_valido,
  coalesce(sum(valor_bruto), 0)                                        as faturamento_bruto,
  coalesce(sum(valor_bruto) filter (where situacao = 'cancelado'), 0)  as cancelado,
  coalesce(sum(valor_bruto) filter (where situacao = 'devolvido'), 0)  as devolvido,
  count(*)                                                             as pedidos_total
from public.glr_pedidos
group by 1, 2, 3;

-- 5) Segurança: equipe logada só LÊ; quem grava é o servidor (service role) --
alter table public.glr_pedidos     enable row level security;
alter table public.glr_ads_diario  enable row level security;
alter table public.glr_sync_estado enable row level security;
drop policy if exists leitura_autenticado on public.glr_pedidos;
drop policy if exists leitura_autenticado on public.glr_ads_diario;
drop policy if exists leitura_autenticado on public.glr_sync_estado;
create policy leitura_autenticado on public.glr_pedidos     for select to authenticated using (true);
create policy leitura_autenticado on public.glr_ads_diario  for select to authenticated using (true);
create policy leitura_autenticado on public.glr_sync_estado for select to authenticated using (true);
alter view public.vw_vendas_dia set (security_invoker = true);
grant select on public.vw_vendas_dia to authenticated;

-- 6) Avisar as telas em tempo real quando uma sincronização termina --------
do $$
begin
  alter publication supabase_realtime add table public.glr_sync_estado;
exception when duplicate_object then null;
end $$;

-- 7) Senha interna do agendador (só o servidor lê; ninguém da equipe vê) --
create table if not exists public.glr_config_privada (
  chave text primary key,
  valor text not null
);
alter table public.glr_config_privada enable row level security;  -- sem policy = só service role
insert into public.glr_config_privada (chave, valor)
values ('sync_token', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (chave) do nothing;

-- 8) Agendador (roda dentro do Supabase, não depende do plano da Vercel) ---
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- a cada 15 min: pedidos e ADS novos/alterados
select cron.unschedule(jobid) from cron.job where jobname in ('glr-sync-15min', 'glr-sync-noturno');
select cron.schedule('glr-sync-15min', '*/15 * * * *', $cron$
  select net.http_post(
    url     := 'https://consultoriaglr.com.br/api/sync-dados',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-glr-sync-token', (select valor from public.glr_config_privada where chave = 'sync_token')),
    body    := '{"modo":"incremental"}'::jsonb,
    timeout_milliseconds := 5000
  );
$cron$);
-- todo dia 03:00 (Brasília): reprocessa os últimos 45 dias (cancelamentos e devoluções tardias)
select cron.schedule('glr-sync-noturno', '0 6 * * *', $cron$
  select net.http_post(
    url     := 'https://consultoriaglr.com.br/api/sync-dados',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-glr-sync-token', (select valor from public.glr_config_privada where chave = 'sync_token')),
    body    := '{"modo":"reprocessar","dias":45}'::jsonb,
    timeout_milliseconds := 5000
  );
$cron$);

-- Conferência: deve listar as 4 tabelas/visões e os 2 agendamentos
select 'tabela' as tipo, table_name as nome from information_schema.tables
 where table_schema = 'public' and table_name in ('glr_pedidos','glr_ads_diario','glr_sync_estado','vw_vendas_dia','glr_config_privada')
union all
select 'agendamento', jobname from cron.job where jobname like 'glr-sync-%';
