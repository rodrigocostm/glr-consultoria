alter table public.push_subscriptions add column preferencias jsonb not null default '{}'::jsonb;
create table public.push_deliveries (endpoint text not null references public.push_subscriptions(endpoint) on delete cascade, evento text not null, criado_em timestamptz not null default now(), primary key(endpoint,evento));
alter table public.push_deliveries enable row level security;
revoke all on public.push_deliveries from anon,authenticated;
grant all on public.push_deliveries to service_role;
notify pgrst,'reload schema';
