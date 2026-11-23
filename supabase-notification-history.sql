create table public.glr_notification_readers (user_id uuid primary key references auth.users(id) on delete cascade, criado_em timestamptz not null default now());
create table public.glr_notifications (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, evento text not null, categoria text not null, titulo text not null, texto text not null, contas jsonb not null default '[]'::jsonb, destino text not null, criado_em timestamptz not null default now(), lida_em timestamptz, tratada_em timestamptz, unique(user_id,evento));
create index glr_notifications_user_date on public.glr_notifications(user_id,criado_em desc,id);
alter table public.glr_notification_readers enable row level security;
alter table public.glr_notifications enable row level security;
revoke all on public.glr_notification_readers,public.glr_notifications from anon,authenticated;
grant all on public.glr_notification_readers,public.glr_notifications to service_role;
create function public.glr_notification_totals(p_user uuid) returns jsonb language sql stable security invoker set search_path=public as $$
select jsonb_build_object('total',count(*),'nao_lidas',count(*) filter(where lida_em is null),'pendentes',count(*) filter(where tratada_em is null),'tratadas',count(*) filter(where tratada_em is not null)) from public.glr_notifications where user_id=p_user;
$$;
revoke all on function public.glr_notification_totals(uuid) from public,anon,authenticated;
grant execute on function public.glr_notification_totals(uuid) to service_role;
notify pgrst,'reload schema';

alter table public.glr_notifications add column perfil text not null default 'consultoria' check (perfil in ('consultoria','portal'));
drop function public.glr_notification_totals(uuid);
create function public.glr_notification_totals(p_user uuid,p_perfil text,p_contas jsonb) returns jsonb language sql stable security invoker set search_path=public as $$
select jsonb_build_object('total',count(*),'nao_lidas',count(*) filter(where lida_em is null),'pendentes',count(*) filter(where tratada_em is null),'tratadas',count(*) filter(where tratada_em is not null)) from public.glr_notifications where user_id=p_user and perfil=p_perfil and (p_perfil='consultoria' or (jsonb_array_length(contas)>0 and contas <@ p_contas));
$$;
revoke all on function public.glr_notification_totals(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.glr_notification_totals(uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
