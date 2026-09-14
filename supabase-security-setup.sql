-- ============================================================
-- GLR Consultoria — Pacote de segurança + tabela de leads
-- Rode isto UMA VEZ no SQL Editor do Supabase (projeto rrodqlejqyaoomutriiw)
-- ============================================================

-- 1) Trava glr_storage: só usuário autenticado (admin ou portal do cliente) lê/escreve
alter table glr_storage enable row level security;

drop policy if exists "Enable read access for all users" on glr_storage;
drop policy if exists "Enable insert for all users" on glr_storage;
drop policy if exists "Enable update for all users" on glr_storage;
drop policy if exists "allow_anon_all" on glr_storage;
drop policy if exists "somente_autenticado" on glr_storage;

create policy "somente_autenticado" on glr_storage
for all
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

-- 2) Tabela de leads da landing page — visitante anônimo consegue INSERIR
-- (enviar o formulário), mas não consegue LER os leads de outras pessoas.
-- Só usuário autenticado (você, logado no GLR Central) consegue ler/gerenciar.
create table if not exists glr_leads (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text not null,
  marketplace text,
  faturamento text,
  dificuldade text,
  utm_source text,
  utm_campaign text,
  criado_em timestamptz not null default now()
);

alter table glr_leads enable row level security;

drop policy if exists "anon_pode_inserir_lead" on glr_leads;
drop policy if exists "autenticado_le_leads" on glr_leads;

create policy "anon_pode_inserir_lead" on glr_leads
for insert
to anon
with check (true);

create policy "autenticado_le_leads" on glr_leads
for select
to authenticated
using (true);
