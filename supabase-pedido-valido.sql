-- Pedido válido em todo o sistema (27/11/2026)
-- situacao ganha dois valores além de valido/cancelado/devolvido:
--   reembolsado = reembolso total ou devolução em andamento (ML refunded, Shopee TO_RETURN).
--                 Reembolso parcial do ML segue válido: a sincronização já grava o valor sem a parte devolvida.
--   em_aberto   = pedido sem pagamento confirmado (UNPAID, payment_required, Pending, ON_HOLD...)
-- Toda consulta com situacao = 'valido' (telas, agentes, comissão, dashboard) passa a somar só pedido válido.
-- A sincronização grava a situação nova (js/status-pedido.js → situacaoBase); se a devolução for
-- recusada, o status volta para COMPLETED e a próxima sincronização grava 'valido' de novo.

alter table public.glr_pedidos drop constraint if exists glr_pedidos_situacao_check;
alter table public.glr_pedidos add constraint glr_pedidos_situacao_check
  check (situacao in ('valido','cancelado','devolvido','reembolsado','em_aberto'));

-- Pedidos já gravados (rodar depois do deploy do código novo)
update public.glr_pedidos set situacao = 'reembolsado'
 where situacao = 'valido' and lower(status_original) in ('to_return','refunded');
update public.glr_pedidos set situacao = 'em_aberto'
 where situacao = 'valido' and lower(status_original) in ('unpaid','pending','pendingavailability','payment_required','payment_in_process','partially_paid','on_hold','awaiting_payment','incomplete','new','created');

-- Resumo diário (glr_sync_estado, recurso 'resumo') dos dias afetados: recalcula a partir dos pedidos
-- (mesma conta de api/sync-dados.js → atualizarResumo; o ADS do dia é mantido). Idempotente.
with dias as (
  select distinct marketplace m, conta_id c, to_char(criado_em at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') dia
    from public.glr_pedidos where situacao in ('reembolsado','em_aberto')
), calc as (
  select d.m, d.c, d.dia, jsonb_build_object(
      'pedidos', count(*) filter (where p.situacao = 'valido'),
      'faturamento', round(coalesce(sum(p.valor_bruto) filter (where p.situacao = 'valido'), 0)::numeric, 2),
      'unidades', coalesce(sum((select coalesce(sum(coalesce((i->>'qtd')::int, 1)), 0) from jsonb_array_elements(case when jsonb_typeof(p.itens) = 'array' then p.itens else '[]'::jsonb end) i)) filter (where p.situacao = 'valido'), 0),
      'cancelados', count(*) filter (where p.situacao = 'cancelado'),
      'valor_cancelado', round(coalesce(sum(p.valor_bruto) filter (where p.situacao = 'cancelado'), 0)::numeric, 2),
      'devolvidos', count(*) filter (where p.situacao in ('devolvido','reembolsado')),
      'valor_devolvido', round(coalesce(sum(p.valor_bruto) filter (where p.situacao in ('devolvido','reembolsado')), 0)::numeric, 2),
      'liquido', round(coalesce(sum(p.liquido) filter (where p.situacao = 'valido' and p.liquido is not null), 0)::numeric, 2),
      'com_liquido', count(*) filter (where p.situacao = 'valido' and p.liquido is not null)) v
  from dias d join public.glr_pedidos p on p.marketplace = d.m and p.conta_id = d.c
   and p.criado_em >= (d.dia || 'T00:00:00-03:00')::timestamptz and p.criado_em < (d.dia || 'T00:00:00-03:00')::timestamptz + interval '1 day'
  group by d.m, d.c, d.dia
), por_conta as (select m, c, jsonb_object_agg(dia, v) novos from calc group by m, c)
update public.glr_sync_estado e
   set cursor = jsonb_set(e.cursor, '{dias}', (
     select jsonb_object_agg(k, case when pc.novos ? k then val || (pc.novos -> k) else val end)
       from jsonb_each(e.cursor -> 'dias') t(k, val)))
  from por_conta pc
 where e.marketplace = pc.m and e.conta_id = pc.c and e.recurso = 'resumo' and jsonb_typeof(e.cursor -> 'dias') = 'object';
