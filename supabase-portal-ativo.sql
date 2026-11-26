-- Se o mesmo e-mail tiver um acesso de portal ativo e outro desativado,
-- vale o ativo. Antes o desativado ganhava e o login era recusado,
-- mesmo existindo um acesso válido.
-- Rodar no SQL Editor depois de supabase-access-hardening.sql.
begin;
create or replace function public.glr_meu_portal() returns jsonb
language sql stable security definer set search_path = public as $$
  select c from public.glr_storage s,
    jsonb_array_elements(case when jsonb_typeof(s.dados) = 'array' then s.dados else '[]'::jsonb end) c
  where s.chave = 'glr_portal_configs'
    and lower(c->>'email') = lower(auth.jwt()->>'email')
  order by (coalesce(c->>'ativo', 'true') <> 'false') desc
  limit 1;
$$;
revoke all on function public.glr_meu_portal() from public, anon;
grant execute on function public.glr_meu_portal() to authenticated;
commit;
