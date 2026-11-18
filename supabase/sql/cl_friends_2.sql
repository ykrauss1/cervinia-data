-- ─────────────────────────────────────────────────────────────────────────
-- Friends, second part (runs after cl_friends.sql):
--   1. Inviting a registered user by his name on the site - not everybody
--      has WhatsApp. The invited user sees the invitation and accepts or
--      declines it: nobody is put into a group, and nobody's location is
--      shown to people, without his own yes.
--   2. A group for a trip (deleted on the day it ends) or a standing one.
--
-- Run the whole block at once. The revokes are part of it: in this project
-- new objects are born granted to anon, so a create without a revoke beside
-- it is a hole.
-- ─────────────────────────────────────────────────────────────────────────

-- ── a group for a trip, or a standing one ────────────────────────────────
-- expires_at: when a trip group ends. Null: a standing group, deleted only
-- after a year nobody used it.
alter table public.cl_groups add column if not exists expires_at timestamptz;

-- ── invitations ──────────────────────────────────────────────────────────
create table if not exists public.cl_invites (
  group_id   uuid not null references public.cl_groups(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
alter table public.cl_invites enable row level security;
revoke all on public.cl_invites from anon, authenticated, public;

-- old locations, ended trips, forgotten groups and old invitations
create or replace function public.cl_sweep()
returns void language sql security definer set search_path = public as $$
  delete from cl_locations where share_until < now();
  delete from cl_groups where expires_at is not null and expires_at < now();
  delete from cl_groups where expires_at is null and last_used < now() - interval '365 days';
  delete from cl_invites where created_at < now() - interval '30 days';
$$;

-- the create function now takes the length of the group's life
drop function if exists public.cl_group_create(text, text);
create or replace function public.cl_group_create(p_name text, p_member_name text, p_days int)
returns table (id uuid, name text, invite_code text)
language plpgsql security definer set search_path = public as $$
declare g uuid; c text; me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in first'; end if;
  if (select count(*) from cl_group_members m where m.user_id = me) >= 10 then
    raise exception 'too many groups';
  end if;
  loop
    c := cl_new_code();
    exit when not exists (select 1 from cl_groups x where x.invite_code = c);
  end loop;
  insert into cl_groups (name, invite_code, owner, expires_at)
    values (trim(p_name), c, me,
            case when coalesce(p_days, 0) > 0 then now() + make_interval(days => least(p_days, 60)) end)
    returning cl_groups.id into g;
  insert into cl_group_members (group_id, user_id, name) values (g, me, trim(p_member_name));
  return query select g, trim(p_name), c;
end $$;

drop function if exists public.cl_my_groups();
create or replace function public.cl_my_groups()
returns table (id uuid, name text, invite_code text, is_owner boolean, members int, my_name text, expires_at timestamptz)
language sql security definer set search_path = public as $$
  select g.id, g.name, g.invite_code, g.owner = auth.uid(),
         (select count(*)::int from cl_group_members m2 where m2.group_id = g.id), m.name, g.expires_at
  from cl_groups g join cl_group_members m on m.group_id = g.id and m.user_id = auth.uid()
  where g.expires_at is null or g.expires_at > now()
  order by g.last_used desc;
$$;

-- Registered users whose name begins with what was typed: the name only,
-- never the email, at least two letters, at most eight answers.
create or replace function public.cl_user_search(p_q text)
returns table (username text)
language sql security definer set search_path = public as $$
  select p.username from profiles p
  where auth.uid() is not null
    and char_length(trim(coalesce(p_q, ''))) >= 2
    and p.username ilike replace(replace(replace(trim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    and p.id <> auth.uid()
  order by p.username
  limit 8;
$$;

-- Any member may invite a registered user by his name on the site.
create or replace function public.cl_group_invite(p_group uuid, p_username text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); them uuid;
begin
  if not exists (select 1 from cl_group_members m where m.group_id = p_group and m.user_id = me) then
    raise exception 'not a member of this group';
  end if;
  select p.id into them from profiles p where lower(p.username) = lower(trim(p_username)) limit 1;
  if them is null then raise exception 'no such user'; end if;
  if exists (select 1 from cl_group_members m where m.group_id = p_group and m.user_id = them) then
    return 'already a member';
  end if;
  if (select count(*) from cl_invites i where i.group_id = p_group) >= 50 then
    raise exception 'too many open invitations';
  end if;
  insert into cl_invites (group_id, user_id, invited_by) values (p_group, them, me)
    on conflict (group_id, user_id) do update set invited_by = excluded.invited_by, created_at = now();
  return 'invited';
end $$;

-- My open invitations: the group, and who invited me (by his name in it).
create or replace function public.cl_my_invites()
returns table (group_id uuid, group_name text, invited_by text, created_at timestamptz)
language sql security definer set search_path = public as $$
  select i.group_id, g.name, coalesce(m.name, ''), i.created_at
  from cl_invites i
  join cl_groups g on g.id = i.group_id and (g.expires_at is null or g.expires_at > now())
  left join cl_group_members m on m.group_id = i.group_id and m.user_id = i.invited_by
  where i.user_id = auth.uid()
  order by i.created_at desc;
$$;

create or replace function public.cl_invite_answer(p_group uuid, p_accept boolean, p_member_name text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if not exists (select 1 from cl_invites i where i.group_id = p_group and i.user_id = me) then
    raise exception 'no such invitation';
  end if;
  delete from cl_invites where group_id = p_group and user_id = me;
  if p_accept then
    if (select count(*) from cl_group_members m where m.group_id = p_group) >= 30 then
      raise exception 'the group is full';
    end if;
    insert into cl_group_members (group_id, user_id, name)
      values (p_group, me, left(trim(coalesce(nullif(trim(p_member_name), ''), 'חבר')), 30))
      on conflict (group_id, user_id) do nothing;
    update cl_groups set last_used = now() where id = p_group;
  end if;
end $$;

-- ── who may call what ────────────────────────────────────────────────────
revoke all on function public.cl_sweep()                                  from public, anon, authenticated;
revoke all on function public.cl_group_create(text, text, int)            from public, anon;
revoke all on function public.cl_my_groups()                              from public, anon;
revoke all on function public.cl_user_search(text)                        from public, anon;
revoke all on function public.cl_group_invite(uuid, text)                 from public, anon;
revoke all on function public.cl_my_invites()                             from public, anon;
revoke all on function public.cl_invite_answer(uuid, boolean, text)       from public, anon;
grant execute on function public.cl_group_create(text, text, int)         to authenticated;
grant execute on function public.cl_my_groups()                           to authenticated;
grant execute on function public.cl_user_search(text)                     to authenticated;
grant execute on function public.cl_group_invite(uuid, text)              to authenticated;
grant execute on function public.cl_my_invites()                          to authenticated;
grant execute on function public.cl_invite_answer(uuid, boolean, text)    to authenticated;

notify pgrst, 'reload schema';
