-- Applied through Supabase migration segundo_cerebro_operacao.
create table public.glr_conhecimento (
 id uuid primary key,
 titulo text not null check (length(titulo) between 1 and 160),
 conteudo text not null default '' check (length(conteudo) <= 40000),
 categoria text not null default 'Operação',
 tags jsonb not null default '[]',
 estado text not null default 'rascunho' check (estado in ('rascunho','publicado','arquivado')),
 versao integer not null default 1,
 historico jsonb not null default '[]',
 atualizado_em timestamptz not null default now(),
 atualizado_por uuid not null
);
create unique index glr_conhecimento_titulo on public.glr_conhecimento (lower(titulo));
alter table public.glr_conhecimento enable row level security;
revoke all on public.glr_conhecimento from anon, authenticated;
grant select, insert, update on public.glr_conhecimento to service_role;
comment on table public.glr_conhecimento is 'Conhecimento interno. Acesso somente pela API com requireStaff. Sem acesso pelo portal.';
