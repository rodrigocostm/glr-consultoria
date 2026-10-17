-- ============================================================
-- GLR — Isolamento do Portal do Cliente (17/10/2026)
-- ------------------------------------------------------------
-- Problema: as políticas atuais liberam TUDO para qualquer usuário logado
-- ("to authenticated using (true)"). Como o cliente do portal também é um
-- usuário logado, ele conseguia, pelo navegador, ler e ALTERAR glr_storage
-- (inclusive a API key do Tiops da GLR) e ler os pedidos de TODOS os clientes.
--
-- Solução: políticas RESTRITIVAS (somam uma trava às existentes, sem apagá-las):
--   • equipe GLR (logado e fora de glr_portal_configs) continua vendo tudo;
--   • cliente do portal só lê pedidos/ADS/resumo das contas vinculadas a ele,
--     só lê as chaves de custo do glr_storage e não grava nada;
--   • tabelas internas (agentes, leads, sugestões) ficam fechadas para o portal.
-- Rodar inteiro no SQL Editor do Supabase. Pode rodar mais de uma vez.
-- ============================================================

-- Config do portal do usuário logado (ou null se for da equipe GLR)
create or replace function public.glr_meu_portal() returns jsonb
language sql stable security definer set search_path = public as $$
  select c
  from glr_storage s, jsonb_array_elements(case when jsonb_typeof(s.dados) = 'array' then s.dados else '[]'::jsonb end) c
  where s.chave = 'glr_portal_configs'
    and lower(c->>'email') = lower(auth.jwt()->>'email')
    and coalesce(c->>'ativo', 'true') <> 'false'
  limit 1;
$$;

create or replace function public.glr_eh_portal() returns boolean
language sql stable security definer set search_path = public as $$
  select public.glr_meu_portal() is not null;
$$;

create or replace function public.glr_portal_contas() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array(select jsonb_array_elements_text(public.glr_meu_portal()->'contaIds')), '{}'::text[]);
$$;

grant execute on function public.glr_meu_portal(), public.glr_eh_portal(), public.glr_portal_contas() to authenticated;

-- glr_storage: portal só LÊ as chaves de custo; não grava nada
drop policy if exists portal_isolado on public.glr_storage;
create policy portal_isolado on public.glr_storage as restrictive for all to authenticated
  using (not (select public.glr_eh_portal()) or chave in ('glr_vendas_custos', 'glr_vendas_custo_catalogo', 'glr_aliquotas', 'glr_vendas_linhas'))
  with check (not (select public.glr_eh_portal()));

-- Base automática: portal só as contas dele
drop policy if exists portal_isolado on public.glr_pedidos;
create policy portal_isolado on public.glr_pedidos as restrictive for select to authenticated
  using (not (select public.glr_eh_portal()) or array[conta_id] <@ (select public.glr_portal_contas()));
drop policy if exists portal_isolado on public.glr_ads_diario;
create policy portal_isolado on public.glr_ads_diario as restrictive for select to authenticated
  using (not (select public.glr_eh_portal()) or array[conta_id] <@ (select public.glr_portal_contas()));
drop policy if exists portal_isolado on public.glr_sync_estado;
create policy portal_isolado on public.glr_sync_estado as restrictive for select to authenticated
  using (not (select public.glr_eh_portal()) or array[conta_id] <@ (select public.glr_portal_contas()));

-- A view respeita as políticas de quem consulta (senão ela furaria o isolamento)
alter view public.vw_vendas_dia set (security_invoker = true);

-- Tabelas internas: fechadas para o portal
do $$
declare t text;
begin
  foreach t in array array['glr_agente_log', 'glr_agente_config', 'glr_agente_relatorios', 'glr_ads_sugestoes', 'glr_leads'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists portal_isolado on public.%I', t);
      execute format('create policy portal_isolado on public.%I as restrictive for all to authenticated using (not (select public.glr_eh_portal())) with check (not (select public.glr_eh_portal()))', t);
    end if;
  end loop;
end $$;
