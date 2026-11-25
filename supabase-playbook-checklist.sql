create table public.glr_playbook_checklist (
 id uuid primary key default gen_random_uuid(),cliente_id text not null,gestor_id text,conta text not null,ciclo text not null check(ciclo ~ '^\d{4}-(0[1-9]|1[0-2])$'),item text not null,
 status text not null check(status in ('pendente','andamento','feito','nao_aplica')),evidencia text not null default '',autor uuid not null references auth.users(id),criado_em timestamptz not null default clock_timestamp()
);
create index on public.glr_playbook_checklist(ciclo,conta,criado_em desc);
alter table public.glr_playbook_checklist enable row level security;
revoke all on public.glr_playbook_checklist from public,anon,authenticated;
grant select,insert on public.glr_playbook_checklist to service_role;
