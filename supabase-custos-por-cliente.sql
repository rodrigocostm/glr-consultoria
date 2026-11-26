-- Custos, alíquotas e linhas extras por cliente.
-- Rodar no SQL Editor do Supabase DEPOIS de supabase-portal-seguranca.sql
-- e supabase-access-hardening.sql.
-- A equipe continua gravando os documentos globais em glr_storage.
-- Este script projeta, para cada cliente do portal, só o pedaço dele
-- e fecha a leitura direta desses documentos globais.

begin;

create table if not exists public.glr_cliente_colecao (
  cliente_id text not null,
  colecao text not null check (colecao in ('custos', 'custo_catalogo', 'aliquotas', 'vendas_linhas')),
  dados jsonb not null default '{}'::jsonb,
  versao bigint not null default 1,
  atualizado_em timestamptz not null default now(),
  primary key (cliente_id, colecao)
);

alter table public.glr_cliente_colecao enable row level security;
revoke all on public.glr_cliente_colecao from anon;
grant select on public.glr_cliente_colecao to authenticated;

drop policy if exists equipe_le on public.glr_cliente_colecao;
create policy equipe_le on public.glr_cliente_colecao
  for select to authenticated
  using ((select public.glr_eh_equipe()));

drop policy if exists portal_so_o_seu on public.glr_cliente_colecao;
create policy portal_so_o_seu on public.glr_cliente_colecao
  for select to authenticated
  using (
    (select public.glr_portal_ativo())
    and cliente_id = (select public.glr_meu_portal()->>'clienteId')
  );

-- O portal deixa de ler os documentos globais. O que ele vê está na tabela acima.
drop policy if exists portal_isolado on public.glr_storage;
create policy portal_isolado on public.glr_storage as restrictive
  for all to authenticated
  using ((select public.glr_meu_portal()) is null)
  with check ((select public.glr_meu_portal()) is null);

create or replace function public.glr_repartir_colecoes() returns void
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb;
  aliq jsonb := coalesce((select dados from public.glr_storage where chave = 'glr_aliquotas'), '{}'::jsonb);
  cat jsonb := coalesce((select dados from public.glr_storage where chave = 'glr_vendas_custo_catalogo'), '{}'::jsonb);
  custos jsonb := coalesce((select dados from public.glr_storage where chave = 'glr_vendas_custos'), '{}'::jsonb);
  linhas jsonb := coalesce((select dados from public.glr_storage where chave = 'glr_vendas_linhas'), '[]'::jsonb);
  produtos jsonb := coalesce((select dados from public.glr_storage where chave = 'glr_produtos'), '[]'::jsonb);
  portais jsonb := coalesce((select dados from public.glr_storage where chave = 'glr_portal_configs'), '[]'::jsonb);
  cid text;
  contas text[];
  ids text[];
  pedidos text[];
  fatia jsonb;
  ch text;
begin
  if jsonb_typeof(portais) <> 'array' then return; end if;
  if jsonb_typeof(aliq) <> 'object' then aliq := '{}'::jsonb; end if;
  if jsonb_typeof(cat) <> 'object' then cat := '{}'::jsonb; end if;
  if jsonb_typeof(custos) <> 'object' then custos := '{}'::jsonb; end if;
  if jsonb_typeof(linhas) <> 'array' then linhas := '[]'::jsonb; end if;
  if jsonb_typeof(produtos) <> 'array' then produtos := '[]'::jsonb; end if;

  for cfg in select value from jsonb_array_elements(portais) loop
    cid := cfg->>'clienteId';
    if cid is null or cid = '' then continue; end if;
    select coalesce(array_agg(x), '{}') into contas
      from jsonb_array_elements_text(coalesce(cfg->'contaIds', '[]'::jsonb)) x;

    select coalesce(array_agg(distinct a->>'id'), '{}') into ids
      from jsonb_array_elements(produtos) p,
           jsonb_array_elements(coalesce(p->'anuncios', '[]'::jsonb)) a
     where p->>'clienteId' = cid and coalesce(a->>'id', '') <> '';

    if to_regclass('public.glr_pedidos') is not null then
      select coalesce(array_agg(distinct it->>'item_id'), '{}') into pedidos
        from public.glr_pedidos gp,
             jsonb_array_elements(coalesce(gp.itens, '[]'::jsonb)) it
       where gp.conta_id = any (contas) and coalesce(it->>'item_id', '') <> '';
      ids := ids || pedidos;
    end if;

    fatia := '{}'::jsonb;
    for ch in select k from jsonb_object_keys(aliq) k where k = any (contas) loop
      fatia := fatia || jsonb_build_object(ch, aliq->ch);
    end loop;
    insert into public.glr_cliente_colecao (cliente_id, colecao, dados, versao, atualizado_em)
    values (cid, 'aliquotas', fatia, 1, now())
    on conflict (cliente_id, colecao) do update
      set dados = excluded.dados, versao = public.glr_cliente_colecao.versao + 1, atualizado_em = now()
      where public.glr_cliente_colecao.dados is distinct from excluded.dados;

    -- Ids que o próprio cliente já gravou e que continuam no catálogo global
    -- (anúncio ainda sem produto cadastrado) permanecem só na coleção dele.
    for ch in
      select k from jsonb_object_keys(coalesce((select dados from public.glr_cliente_colecao where cliente_id = cid and colecao = 'custo_catalogo'), '{}'::jsonb)) k
      where cat ? k
    loop
      ids := ids || array[ch];
    end loop;

    fatia := '{}'::jsonb;
    if array_length(ids, 1) is not null then
      for ch in select k from jsonb_object_keys(cat) k where k = any (ids) loop
        fatia := fatia || jsonb_build_object(ch, cat->ch);
      end loop;
    end if;
    insert into public.glr_cliente_colecao (cliente_id, colecao, dados, versao, atualizado_em)
    values (cid, 'custo_catalogo', fatia, 1, now())
    on conflict (cliente_id, colecao) do update
      set dados = excluded.dados, versao = public.glr_cliente_colecao.versao + 1, atualizado_em = now()
      where public.glr_cliente_colecao.dados is distinct from excluded.dados;

    pedidos := '{}';
    if to_regclass('public.glr_pedidos') is not null then
      select coalesce(array_agg(pedido_id), '{}') into pedidos
        from public.glr_pedidos where conta_id = any (contas);
    end if;
    fatia := '{}'::jsonb;
    if array_length(pedidos, 1) is not null then
      for ch in select k from jsonb_object_keys(custos) k where k = any (pedidos) loop
        fatia := fatia || jsonb_build_object(ch, custos->ch);
      end loop;
    end if;
    insert into public.glr_cliente_colecao (cliente_id, colecao, dados, versao, atualizado_em)
    values (cid, 'custos', fatia, 1, now())
    on conflict (cliente_id, colecao) do update
      set dados = excluded.dados, versao = public.glr_cliente_colecao.versao + 1, atualizado_em = now()
      where public.glr_cliente_colecao.dados is distinct from excluded.dados;

    -- Linhas extras não têm dono: são regras globais (percentual ou valor fixo),
    -- não o custo de outro cliente. Cada acesso guarda a própria cópia.
    insert into public.glr_cliente_colecao (cliente_id, colecao, dados, versao, atualizado_em)
    values (cid, 'vendas_linhas', linhas, 1, now())
    on conflict (cliente_id, colecao) do update
      set dados = excluded.dados, versao = public.glr_cliente_colecao.versao + 1, atualizado_em = now()
      where public.glr_cliente_colecao.dados is distinct from excluded.dados;
  end loop;
end;
$$;

revoke all on function public.glr_repartir_colecoes() from public, anon, authenticated;

create or replace function public.glr_repartir_colecoes_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.chave in ('glr_aliquotas', 'glr_vendas_custo_catalogo', 'glr_vendas_custos', 'glr_vendas_linhas', 'glr_produtos', 'glr_portal_configs') then
    perform public.glr_repartir_colecoes();
  end if;
  return new;
end;
$$;

drop trigger if exists glr_repartir_colecoes on public.glr_storage;
create trigger glr_repartir_colecoes
  after insert or update on public.glr_storage
  for each row execute function public.glr_repartir_colecoes_trg();

select public.glr_repartir_colecoes();

commit;
