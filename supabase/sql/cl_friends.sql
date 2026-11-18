-- ─────────────────────────────────────────────────────────────────────────
-- Friends on the mountain: groups, and locations shared inside a group.
--
-- A group is a family or a few friends. Someone opens it and sends its
-- invite link; whoever follows the link and is signed in joins it. Inside
-- the group, each member decides for himself whether to share where he is,
-- and for how long. When that time is up the location is deleted - there is
-- no history of where anybody went.
--
-- Nobody outside a group can read anything in it. The tables are closed to
-- every client role; everything goes through the functions below, and each
-- of them checks that the caller is a member of the group he asks about.
--
-- Run the whole block at once. The revokes are part of it: in this project
-- new objects are born granted to anon, so a create without a revoke beside
-- it is a hole.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.cl_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique,
  owner       uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  -- a trip ends: a group nobody has used for 60 days is deleted
  last_used   timestamptz not null default now()
);

create table if not exists public.cl_group_members (
  group_id  uuid not null references public.cl_groups(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  name      text not null check (char_length(name) between 1 and 30),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.cl_locations (
  group_id    uuid not null,
  user_id     uuid not null,
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  acc         real,
  updated_at  timestamptz not null default now(),
  share_until timestamptz not null,
  primary key (group_id, user_id),
  foreign key (group_id, user_id) references public.cl_group_members(group_id, user_id) on delete cascade
);

alter table public.cl_groups        enable row level security;
alter table public.cl_group_members enable row level security;
alter table public.cl_locations     enable row level security;
revoke all on public.cl_groups        from anon, authenticated, public;
revoke all on public.cl_group_members from anon, authenticated, public;
revoke all on public.cl_locations     from anon, authenticated, public;

-- ── helpers ──────────────────────────────────────────────────────────────

-- Old locations and dead groups go on every call that reads or writes a
-- location: the tables stay small, and nothing outlives its time.
create or replace function public.cl_sweep()
returns void language sql security definer set search_path = public as $$
  delete from cl_locations where share_until < now();
  delete from cl_groups where last_used < now() - interval '60 days';
$$;

-- A member's handle as the others see it: stable inside the group, and not
-- the account id.
create or replace function public.cl_handle(p_group uuid, p_user uuid)
returns text language sql immutable as $$
  select left(md5(p_group::text || ':' || p_user::text), 10);
$$;

create or replace function public.cl_new_code()
returns text language sql volatile as $$
  -- ten characters a person can read aloud: no 0/O, no 1/l/I
  select string_agg(substr('abcdefghjkmnpqrstuvwxyz23456789', 1 + floor(random() * 31)::int, 1), '')
  from generate_series(1, 10);
$$;

-- ── groups ───────────────────────────────────────────────────────────────

create or replace function public.cl_group_create(p_name text, p_member_name text)
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
  insert into cl_groups (name, invite_code, owner) values (trim(p_name), c, me) returning cl_groups.id into g;
  insert into cl_group_members (group_id, user_id, name) values (g, me, trim(p_member_name));
  return query select g, trim(p_name), c;
end $$;

create or replace function public.cl_group_join(p_code text, p_member_name text)
returns table (id uuid, name text)
language plpgsql security definer set search_path = public as $$
declare g cl_groups; me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in first'; end if;
  select * into g from cl_groups x where x.invite_code = lower(trim(p_code));
  if g.id is null then raise exception 'no such group'; end if;
  if (select count(*) from cl_group_members m where m.group_id = g.id) >= 30 then
    raise exception 'the group is full';
  end if;
  insert into cl_group_members (group_id, user_id, name) values (g.id, me, trim(p_member_name))
    on conflict (group_id, user_id) do update set name = excluded.name;
  update cl_groups set last_used = now() where cl_groups.id = g.id;
  return query select g.id, g.name;
end $$;

-- The caller's groups, with the invite code - every member may invite.
create or replace function public.cl_my_groups()
returns table (id uuid, name text, invite_code text, is_owner boolean, members int, my_name text)
language sql security definer set search_path = public as $$
  select g.id, g.name, g.invite_code, g.owner = auth.uid(),
         (select count(*)::int from cl_group_members m2 where m2.group_id = g.id), m.name
  from cl_groups g join cl_group_members m on m.group_id = g.id and m.user_id = auth.uid()
  order by g.last_used desc;
$$;

create or replace function public.cl_group_leave(p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from cl_group_members where group_id = p_group and user_id = auth.uid();
  -- the last one out turns off the light
  delete from cl_groups g where g.id = p_group
    and not exists (select 1 from cl_group_members m where m.group_id = p_group);
end $$;

-- The owner may remove a member - for when an invite link went further
-- than it should have - and may change the code so it cannot happen again.
create or replace function public.cl_group_remove(p_group uuid, p_handle text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from cl_groups g where g.id = p_group and g.owner = auth.uid()) then
    raise exception 'only the group''s owner may remove members';
  end if;
  delete from cl_group_members m
   where m.group_id = p_group and cl_handle(p_group, m.user_id) = p_handle and m.user_id <> auth.uid();
end $$;

create or replace function public.cl_group_new_code(p_group uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not exists (select 1 from cl_groups g where g.id = p_group and g.owner = auth.uid()) then
    raise exception 'only the group''s owner may change the code';
  end if;
  loop
    c := cl_new_code();
    exit when not exists (select 1 from cl_groups x where x.invite_code = c);
  end loop;
  update cl_groups set invite_code = c where id = p_group;
  return c;
end $$;

-- ── locations ────────────────────────────────────────────────────────────

-- Share where I am with one group until p_minutes from now (at most 12
-- hours). Called again as the phone moves; each call may extend nothing -
-- the end time is set when sharing starts and only the reader can move it.
create or replace function public.cl_loc_share(p_group uuid, p_lat double precision, p_lon double precision,
                                               p_acc real, p_minutes int)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); until_ timestamptz;
begin
  if me is null then raise exception 'sign in first'; end if;
  if not exists (select 1 from cl_group_members m where m.group_id = p_group and m.user_id = me) then
    raise exception 'not a member of this group';
  end if;
  perform cl_sweep();
  until_ := now() + make_interval(mins => greatest(1, least(coalesce(p_minutes, 60), 720)));
  insert into cl_locations (group_id, user_id, lat, lon, acc, updated_at, share_until)
    values (p_group, me, p_lat, p_lon, p_acc, now(), until_)
    on conflict (group_id, user_id) do update
      set lat = excluded.lat, lon = excluded.lon, acc = excluded.acc, updated_at = now(),
          -- a new length only when asked for (p_minutes > 0); 0 keeps the end
          share_until = case when p_minutes > 0 then excluded.share_until else cl_locations.share_until end;
  update cl_groups set last_used = now() where id = p_group;
  return (select share_until from cl_locations where group_id = p_group and user_id = me);
end $$;

create or replace function public.cl_loc_stop(p_group uuid)
returns void language sql security definer set search_path = public as $$
  delete from cl_locations where group_id = p_group and user_id = auth.uid();
$$;

-- Everyone in the group, and where those who share are.
create or replace function public.cl_group_locations(p_group uuid)
returns table (handle text, name text, is_me boolean, is_owner boolean,
               lat double precision, lon double precision, acc real,
               updated_at timestamptz, share_until timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from cl_group_members m where m.group_id = p_group and m.user_id = auth.uid()) then
    raise exception 'not a member of this group';
  end if;
  perform cl_sweep();
  return query
    select cl_handle(p_group, m.user_id), m.name, m.user_id = auth.uid(), g.owner = m.user_id,
           l.lat, l.lon, l.acc, l.updated_at, l.share_until
    from cl_group_members m
    join cl_groups g on g.id = m.group_id
    left join cl_locations l on l.group_id = m.group_id and l.user_id = m.user_id and l.share_until > now()
    where m.group_id = p_group
    order by m.joined_at;
end $$;

-- ── who may call what ────────────────────────────────────────────────────
revoke all on function public.cl_sweep()                                         from public, anon, authenticated;
revoke all on function public.cl_handle(uuid, uuid)                              from public, anon, authenticated;
revoke all on function public.cl_new_code()                                      from public, anon, authenticated;
revoke all on function public.cl_group_create(text, text)                        from public, anon;
revoke all on function public.cl_group_join(text, text)                          from public, anon;
revoke all on function public.cl_my_groups()                                     from public, anon;
revoke all on function public.cl_group_leave(uuid)                               from public, anon;
revoke all on function public.cl_group_remove(uuid, text)                        from public, anon;
revoke all on function public.cl_group_new_code(uuid)                            from public, anon;
revoke all on function public.cl_loc_share(uuid, double precision, double precision, real, int) from public, anon;
revoke all on function public.cl_loc_stop(uuid)                                  from public, anon;
revoke all on function public.cl_group_locations(uuid)                           from public, anon;
grant execute on function public.cl_group_create(text, text)                     to authenticated;
grant execute on function public.cl_group_join(text, text)                       to authenticated;
grant execute on function public.cl_my_groups()                                  to authenticated;
grant execute on function public.cl_group_leave(uuid)                            to authenticated;
grant execute on function public.cl_group_remove(uuid, text)                     to authenticated;
grant execute on function public.cl_group_new_code(uuid)                         to authenticated;
grant execute on function public.cl_loc_share(uuid, double precision, double precision, real, int) to authenticated;
grant execute on function public.cl_loc_stop(uuid)                               to authenticated;
grant execute on function public.cl_group_locations(uuid)                        to authenticated;

notify pgrst, 'reload schema';
