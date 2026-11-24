-- ─────────────────────────────────────────────────────────────────────────
-- The forum: tags on posts, and the list of tags the admin manages.
--
-- cl_forum_tags is the list the writer chooses from (up to three per post).
-- Everyone may read it; only the admin (cl_is_admin()) may add, change,
-- hide or reorder tags. A hidden tag (active = false) is no longer offered,
-- but posts that already carry it keep showing it.
--
-- posts.tags holds the chosen tag ids. A trigger checks them against the
-- list, so nobody can invent junk tags through the API.
-- Old posts get their tags once, from the same keywords the old filter used.
--
-- Run the whole block at once. The revokes are part of it: in this project
-- new objects are born granted to anon, so a create without a revoke beside
-- it is a hole.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.cl_forum_tags (
  id         text primary key check (id ~ '^[a-z0-9_-]{2,24}$'),
  ico        text not null default '' check (char_length(ico) <= 16),
  he         text not null check (char_length(he) between 1 and 30),
  en         text not null check (char_length(en) between 1 and 30),
  kw         text not null default '' check (char_length(kw) <= 200),
  sort       int  not null default 100,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.cl_forum_tags enable row level security;
revoke all on public.cl_forum_tags from anon, authenticated;
grant select on public.cl_forum_tags to anon, authenticated;
grant insert, update, delete on public.cl_forum_tags to authenticated;

drop policy if exists cl_forum_tags_read  on public.cl_forum_tags;
drop policy if exists cl_forum_tags_admin on public.cl_forum_tags;
create policy cl_forum_tags_read  on public.cl_forum_tags for select using (true);
create policy cl_forum_tags_admin on public.cl_forum_tags for all to authenticated
  using (public.cl_is_admin()) with check (public.cl_is_admin());

-- The starting list. Re-running the file does not overwrite the admin's changes.
insert into public.cl_forum_tags (id, ico, he, en, kw, sort) values
  ('runs',      '⛷️', 'מסלולים',        'Runs',             'מסלול|run|slope|piste',                10),
  ('zermatt',   'ch',  'צרמט',           'Zermatt',          'צרמט|zermatt',                         20),
  ('snow',      '❄️', 'שלג ומזג אוויר', 'Snow & weather',   'שלג|snow',                             30),
  ('transfers', '🚌', 'הסעות',          'Transfers',        'הסע|transfer|shuttle|bus',             40),
  ('lodging',   '🏨', 'לינה',           'Lodging',          'לינה|מלון|דירה|hotel|apartment|lodg',  50),
  ('kosher',    '☕', 'כשרות ושבת',     'Kosher & Shabbat', 'כשר|שבת|kosher|shabbat',               60),
  ('family',    '👨‍👩‍👧', 'משפחות',     'Families',         'ילד|משפח|kids|child|famil',            70),
  ('gear',      '🎿', 'ציוד והשכרה',    'Gear & rental',    'השכר|ציוד|rental|equipment|skis',      80)
on conflict (id) do nothing;

-- Tags on posts
alter table public.posts
  add column if not exists tags text[] not null default '{}';
alter table public.posts drop constraint if exists posts_tags_ok;
alter table public.posts add constraint posts_tags_ok check (cardinality(tags) <= 3);
create index if not exists posts_tags_idx on public.posts using gin (tags);

-- Only tags from the list. Unknown ids are dropped quietly rather than
-- failing the post: a writer whose page had an old list still gets posted.
create or replace function public.cl_posts_tags_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tags is null then new.tags := '{}'; end if;
  if tg_op = 'UPDATE' and new.tags is not distinct from old.tags then return new; end if;
  new.tags := coalesce((
    select array_agg(distinct t) from unnest(new.tags) t
    where exists (select 1 from cl_forum_tags f where f.id = t)
  ), '{}');
  return new;
end $$;
revoke all on function public.cl_posts_tags_check() from public, anon, authenticated;

drop trigger if exists cl_posts_tags_check on public.posts;
create trigger cl_posts_tags_check before insert or update of tags on public.posts
  for each row execute function public.cl_posts_tags_check();

-- One-time tagging of the posts written before tags existed.
update public.posts p set tags = t.tags
from (
  select id, (array_remove(array[
      case when content ~* '(מסלול|run|slope|piste)'                 then 'runs' end,
      case when content ~* '(צרמט|zermatt)'                          then 'zermatt' end,
      case when content ~* '(שלג|snow)'                              then 'snow' end,
      case when content ~* '(הסע|transfer|shuttle|bus)'              then 'transfers' end,
      case when content ~* '(לינה|מלון|דירה|hotel|apartment|lodg)'   then 'lodging' end,
      case when content ~* '(כשר|שבת|kosher|shabbat)'                then 'kosher' end,
      case when content ~* '(ילד|משפח|kids|child|famil)'             then 'family' end,
      case when content ~* '(השכר|ציוד|rental|equipment|skis)'       then 'gear' end
    ], null))[1:3] as tags
  from public.posts
  where cardinality(tags) = 0
) t
where p.id = t.id and cardinality(t.tags) > 0;

alter table public.posts enable row level security;
revoke truncate, references, trigger on public.posts from anon, authenticated;
