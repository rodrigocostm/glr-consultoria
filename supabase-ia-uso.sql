-- Uso da IA (Anthropic): uma linha por chamada ao modelo, gravada pelo
-- servidor (api/_ia-uso.js) com a chave de serviço. Serve para explicar a
-- conta: de onde veio cada token, de qual modelo, de quem e de qual conta.
-- Não bloqueia nada: se a tabela não existir, as chamadas seguem normais.
-- Rodar no SQL Editor do Supabase.

begin;

create table if not exists public.glr_ia_uso (
  id bigserial primary key,
  criado_em timestamptz not null default now(),
  origem text not null,              -- ex.: chat-central, agente-chat, especialista-ml, gerente
  modelo text,
  entrada integer not null default 0,        -- tokens de entrada sem cache
  saida integer not null default 0,
  cache_leitura integer not null default 0,  -- tokens lidos do cache (~10% do preço)
  cache_escrita integer not null default 0,  -- tokens gravados no cache (~125% do preço)
  usuario text,
  conta_id text,
  extra jsonb
);

create index if not exists glr_ia_uso_criado_em on public.glr_ia_uso (criado_em desc);
create index if not exists glr_ia_uso_origem on public.glr_ia_uso (origem, criado_em desc);

-- só o servidor (chave de serviço) lê e grava
alter table public.glr_ia_uso enable row level security;
revoke all on public.glr_ia_uso from anon, authenticated;

-- resumo por dia (Brasília), origem e modelo
create or replace view public.glr_ia_uso_dia with (security_invoker = true) as
select (criado_em at time zone 'America/Sao_Paulo')::date as dia,
       origem, modelo,
       count(*) as chamadas,
       sum(entrada) as entrada, sum(saida) as saida,
       sum(cache_leitura) as cache_leitura, sum(cache_escrita) as cache_escrita,
       sum(entrada + saida + cache_leitura + cache_escrita) as total
from public.glr_ia_uso
group by 1, 2, 3;

revoke all on public.glr_ia_uso_dia from anon, authenticated;

commit;
