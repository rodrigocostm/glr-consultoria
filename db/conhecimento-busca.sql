-- Busca do Segundo Cérebro sem baixar todas as notas para a função.
-- Rodar no SQL Editor do Supabase (projeto rrodqlejqyaoomutriiw), uma vez.
-- Não mexe em Auth, RLS das outras tabelas nem em chaves.
-- Enquanto esta função não existir, api/_conhecimento.js volta sozinho
-- para a lista paginada antiga.

alter table public.glr_conhecimento
  add column if not exists busca tsvector
  generated always as (
    setweight(to_tsvector('portuguese', coalesce(titulo, '')), 'A')
    || setweight(to_tsvector('portuguese', coalesce(tags::text, '')), 'B')
    || setweight(to_tsvector('portuguese', coalesce(conteudo, '')), 'C')
  ) stored;

create index if not exists glr_conhecimento_busca_idx
  on public.glr_conhecimento using gin (busca);

create or replace function public.glr_conhecimento_buscar(p_pergunta text, p_limite integer default 6)
returns table (
  id uuid,
  titulo text,
  conteudo text,
  categoria text,
  tags jsonb,
  estado text,
  versao integer,
  atualizado_em timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  q tsquery := websearch_to_tsquery('portuguese', left(coalesce(p_pergunta, ''), 4000));
  limite integer := least(greatest(coalesce(p_limite, 6), 1), 8);
begin
  if q is not null and q::text <> '' then
    return query
      select n.id, n.titulo, n.conteudo, n.categoria, n.tags, n.estado, n.versao, n.atualizado_em
      from public.glr_conhecimento n
      where n.estado = 'publicado'
        and n.busca @@ q
      order by ts_rank_cd(n.busca, q) desc, n.id
      limit limite;
    if found then
      return;
    end if;
  end if;

  -- Mesmo peso da busca antiga em JS (título 6, tags 4, corpo 1) quando o
  -- índice português não casa (sigla, nome de cliente, acento fora do stem).
  return query
  with termos as (
    select distinct t
    from regexp_split_to_table(
      translate(lower(left(coalesce(p_pergunta, ''), 4000)),
        'áàâãäéèêëíìîïóòôõöúùûüçñ',
        'aaaaaeeeeiiiiooooouuuucn'),
      '[^a-z0-9]+'
    ) as t
    where char_length(t) >= 3
      and t not in ('para','com','uma','que','dos','das','como','por','mais','tem','essa','esse','sobre','quais')
  ),
  rank as (
    select n.id, n.titulo, n.conteudo, n.categoria, n.tags, n.estado, n.versao, n.atualizado_em,
      coalesce((
        select sum(
          (case when strpos(translate(lower(n.titulo), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'), t.t) > 0 then 6 else 0 end)
          + (case when strpos(translate(lower(coalesce(n.tags::text, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'), t.t) > 0 then 4 else 0 end)
          + (case when strpos(translate(lower(n.conteudo), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'), t.t) > 0 then 1 else 0 end)
        )::integer
        from termos t
      ), 0) as score
    from public.glr_conhecimento n
    where n.estado = 'publicado'
  )
  select r.id, r.titulo, r.conteudo, r.categoria, r.tags, r.estado, r.versao, r.atualizado_em
  from rank r
  where r.score > 0
  order by r.score desc, r.id
  limit limite;
end;
$$;

revoke all on function public.glr_conhecimento_buscar(text, integer) from public, anon, authenticated;
grant execute on function public.glr_conhecimento_buscar(text, integer) to service_role;

comment on function public.glr_conhecimento_buscar(text, integer) is
  'Notas publicadas do Segundo Cérebro por relevância. Só service_role. Sem acesso do portal.';

-- Embeddings ficam de fora de propósito. Se o pgvector já estiver ativo e o
-- dono quiser busca semântica, o próximo passo é uma coluna vector(1536) e
-- um parâmetro p_embedding. Não criar a extensão neste script.
