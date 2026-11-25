create table if not exists public.glr_playbook_records (
 id uuid primary key default gen_random_uuid(),
 tipo text not null check(tipo in ('plano','intervencao','revisao','produto')),
 cliente_id text not null,
 gestor_id text,
 conta text not null,
 marketplace text not null,
 origem uuid references public.glr_playbook_records(id),
 janela integer check(janela in (3,7,15)),
 dados jsonb not null default '{}'::jsonb,
 autor uuid not null references auth.users(id),
 criado_em timestamptz not null default now(),
 unique(origem,janela)
);
create index if not exists glr_playbook_records_cliente_data on public.glr_playbook_records(cliente_id,criado_em desc);
alter table public.glr_playbook_records enable row level security;
revoke all on public.glr_playbook_records from public,anon,authenticated;
grant select,insert on public.glr_playbook_records to service_role;
