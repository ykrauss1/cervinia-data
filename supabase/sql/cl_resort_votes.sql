-- ─────────────────────────────────────────────────────────────────────────
-- Which ski resort should get the navigation next: the readers' votes.
--
-- Anyone may vote, signed in or not. A vote is up to three resorts from the
-- list, and/or one written in. Nobody but the admin can read the votes, and
-- he reads them only as counts, through cl_resort_votes_admin().
--
-- Run the whole block at once. The revokes are part of it: in this project
-- new objects are born granted to anon, so a create without a revoke beside
-- it is a hole. Needs cl_is_admin() from cl_photos.sql.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.cl_resort_votes (
  id         bigint generated always as identity primary key,
  resorts    text[] not null default '{}',
  other      text   not null default '',
  lang       text   not null default 'he',
  created_at timestamptz not null default now(),
  constraint cl_resort_votes_ok check (
    cardinality(resorts) <= 3
    and char_length(other) <= 80
    and lang in ('he', 'en')
    and (cardinality(resorts) > 0 or char_length(btrim(other)) > 0)
    and resorts <@ array['avoriaz','val-thorens','courchevel','meribel','les-menuires',
                         'tignes-val-disere','alpe-dhuez','les-deux-alpes','la-plagne',
                         'livigno','val-di-fassa','val-gardena','madonna','bormio',
                         'solden','ischgl','mayrhofen','bansko','gudauri','jasna']::text[]
  )
);

alter table public.cl_resort_votes enable row level security;
revoke all on public.cl_resort_votes from public, anon, authenticated;
grant insert (resorts, other, lang) on public.cl_resort_votes to anon, authenticated;

drop policy if exists cl_resort_votes_insert on public.cl_resort_votes;
create policy cl_resort_votes_insert on public.cl_resort_votes
  for insert to anon, authenticated with check (true);

-- The admin's view: how many votes each resort got, and the written-in names.
create or replace function public.cl_resort_votes_admin()
returns table (resort text, votes bigint)
language sql security definer set search_path = public stable as $$
  select r, count(*) from (
    select unnest(resorts) as r from cl_resort_votes
    union all
    select '✏️ ' || lower(btrim(other)) from cl_resort_votes where btrim(other) <> ''
  ) x
  where public.cl_is_admin()
  group by r
  order by 2 desc, 1;
$$;
revoke all on function public.cl_resort_votes_admin() from public, anon, authenticated;
grant execute on function public.cl_resort_votes_admin() to authenticated;
