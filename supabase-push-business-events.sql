create table public.push_event_state (chave text primary key, dados jsonb not null default '{}'::jsonb, atualizado_em timestamptz not null default now());
alter table public.push_event_state enable row level security;
revoke all on public.push_event_state from anon,authenticated;
grant all on public.push_event_state to service_role;
create function public.glr_push_curva_a() returns table(marketplace text, conta_id text, item_id text, nome text, faturamento numeric)
language sql stable security invoker set search_path=public as $$
with venda as (
 select p.marketplace,p.conta_id,i->>'item_id' item_id,max(i->>'nome') nome,
 sum(coalesce(nullif(i->>'preco','')::numeric,0)*coalesce(nullif(i->>'qtd','')::numeric,1)) faturamento
 from public.glr_pedidos p cross join lateral jsonb_array_elements(p.itens) i
 where p.situacao='valido'
 and p.criado_em >= ((now() at time zone 'America/Sao_Paulo')::date - 28)::timestamp at time zone 'America/Sao_Paulo'
 and p.criado_em < ((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo'
 and nullif(i->>'item_id','') is not null
 group by p.marketplace,p.conta_id,i->>'item_id'
), curva as (
 select *,sum(faturamento) over(partition by marketplace,conta_id) total,
 coalesce(sum(faturamento) over(partition by marketplace,conta_id order by faturamento desc,item_id rows between unbounded preceding and 1 preceding),0) antes
 from venda where faturamento>0
) select marketplace,conta_id,item_id,nome,faturamento from curva where antes < total*.8;
$$;
revoke all on function public.glr_push_curva_a() from public,anon,authenticated;
grant execute on function public.glr_push_curva_a() to service_role;
notify pgrst,'reload schema';
