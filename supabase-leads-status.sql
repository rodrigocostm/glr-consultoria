-- ============================================================
-- GLR Consultoria — Adiciona status ao CRM de leads
-- Rode isto UMA VEZ no SQL Editor do Supabase (depois do supabase-security-setup.sql)
-- ============================================================

alter table glr_leads add column if not exists status text not null default 'novo';
-- status esperado: 'novo' | 'contatado' | 'fechado' | 'perdido'

drop policy if exists "autenticado_atualiza_leads" on glr_leads;

create policy "autenticado_atualiza_leads" on glr_leads
for update
to authenticated
using (true)
with check (true);
