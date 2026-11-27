-- Agente de ADS autônomo do Mercado Livre (via Adman) — api/_agente-ml-adman.js
-- Uma linha por conta. Chave de desligar: ligado=false. Modo: 'simulacao' (só registra) ou 'execucao' (aplica).
-- Rodar no SQL Editor do Supabase.
create table if not exists public.glr_ads_autonomo (
  conta_id       text primary key,          -- ID da conta ML (o mesmo de glr_agente_config)
  adman_cust_id  text,                      -- custId na Adman (se vazio, usa conta_id)
  cliente_nome   text,
  ligado         boolean not null default false,
  modo           text not null default 'simulacao' check (modo in ('simulacao','execucao')),
  limites        jsonb not null default '{}'::jsonb,  -- sobrescreve LIMITES_PADRAO do código
  atualizado_em  timestamptz not null default now(),
  atualizado_por text
);
alter table public.glr_ads_autonomo enable row level security;
drop policy if exists glr_ads_autonomo_staff on public.glr_ads_autonomo;
create policy glr_ads_autonomo_staff on public.glr_ads_autonomo for all to authenticated using ((select public.glr_eh_equipe())) with check ((select public.glr_eh_equipe()));

-- Piloto: Expresso Móveis, começa LIGADO em SIMULAÇÃO (não mexe em nada no ML)
insert into public.glr_ads_autonomo (conta_id, adman_cust_id, cliente_nome, ligado, modo)
values ('802228249', '802228249', 'Expresso Móveis', true, 'simulacao')
on conflict (conta_id) do nothing;

-- Desligar agora:            update glr_ads_autonomo set ligado=false, atualizado_em=now() where conta_id='802228249';
-- Passar a executar de fato: update glr_ads_autonomo set modo='execucao', atualizado_em=now() where conta_id='802228249';
