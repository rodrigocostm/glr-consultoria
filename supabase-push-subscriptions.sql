create table public.push_subscriptions (endpoint text primary key, user_id uuid not null references auth.users(id) on delete cascade, p256dh text not null, auth text not null, criado_em timestamptz not null default now());
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant all on public.push_subscriptions to service_role;
notify pgrst, 'reload schema';
