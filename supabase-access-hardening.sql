-- Apply AFTER supabase-portal-seguranca.sql, BEFORE deploying the new server.
-- Run in Supabase SQL Editor as administrator. Then explicitly enroll staff
-- with the INSERT shown in SECURITY-ROLLOUT.md. No user is staff by default.
begin;
create table if not exists public.glr_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ativo boolean not null default true
);
alter table public.glr_staff enable row level security;
revoke all on public.glr_staff from anon, authenticated;

-- Keep disabled portal users identifiable; they must NEVER fall through to staff.
create or replace function public.glr_meu_portal() returns jsonb
language sql stable security definer set search_path = public as $$
  select c from public.glr_storage s,
    jsonb_array_elements(case when jsonb_typeof(s.dados) = 'array' then s.dados else '[]'::jsonb end) c
  where s.chave = 'glr_portal_configs'
    and lower(c->>'email') = lower(auth.jwt()->>'email')
  order by (coalesce(c->>'ativo', 'true') = 'false') desc
  limit 1;
$$;
create or replace function public.glr_eh_equipe() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
    and public.glr_meu_portal() is null
    and exists (select 1 from public.glr_staff where user_id = auth.uid() and ativo);
$$;
create or replace function public.glr_portal_ativo() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public.glr_meu_portal() is not null
    and coalesce(public.glr_meu_portal()->>'ativo', 'true') <> 'false';
$$;
create or replace function public.glr_acesso() returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when public.glr_eh_equipe() then jsonb_build_object('role', 'staff')
    when public.glr_portal_ativo() then jsonb_build_object('role', 'portal', 'portal', public.glr_meu_portal())
    else jsonb_build_object('role', 'denied') end;
$$;
revoke all on function public.glr_meu_portal(), public.glr_eh_equipe(), public.glr_portal_ativo(), public.glr_acesso() from public, anon;
grant execute on function public.glr_meu_portal(), public.glr_eh_equipe(), public.glr_portal_ativo(), public.glr_acesso() to authenticated;

-- Restrictive policies combine with existing permissive policies; unknown or
-- disabled users cannot use any old authenticated=true policy as a backdoor.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
    and (tablename like 'glr\_%' escape '\' or tablename = 'push_subscriptions')
    and tablename not in ('glr_staff', 'glr_config_privada')
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists acesso_explicito on public.%I', t);
    execute format('create policy acesso_explicito on public.%I as restrictive for all to authenticated using (public.glr_eh_equipe() or public.glr_portal_ativo()) with check (public.glr_eh_equipe() or public.glr_portal_ativo())', t);
    -- Portal can read only the explicitly scoped core tables. Other internal
    -- tables (including new ones) are staff-only.
    if t not in ('glr_storage', 'glr_pedidos', 'glr_ads_diario', 'glr_sync_estado') then
      execute format('drop policy if exists somente_equipe_explicita on public.%I', t);
      execute format('create policy somente_equipe_explicita on public.%I as restrictive for all to authenticated using (public.glr_eh_equipe()) with check (public.glr_eh_equipe())', t);
    end if;
  end loop;
end $$;
commit;
