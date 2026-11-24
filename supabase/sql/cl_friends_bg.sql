-- ─────────────────────────────────────────────────────────────────────────
-- Friends on the mountain, part 4: sharing on with the screen off (24.11).
--
-- A web page sends its position only while it is open on the screen. The
-- Android app adds a small service that goes on sending while the phone is
-- in a pocket, with a notification showing all the time that it does.
--
-- The service does not hold the user's sign-in. When sharing starts, the page
-- asks for a key that can do one thing only: move this user's position in
-- this one group, until the time he chose. The key is kept here only as a
-- hash; it dies with the sharing - when the time is up, when he stops, or
-- when he leaves the group.
--
-- Run the whole block at once. The revokes are part of it: in this project
-- new objects are born granted to anon, so a create without a revoke beside
-- it is a hole.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.cl_bg_keys (
  key_hash   text primary key,
  group_id   uuid not null,
  user_id    uuid not null,
  until      timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (group_id, user_id) references public.cl_group_members(group_id, user_id) on delete cascade
);
create index if not exists cl_bg_keys_member on public.cl_bg_keys (group_id, user_id);

alter table public.cl_bg_keys enable row level security;
revoke all on public.cl_bg_keys from anon, authenticated, public;

-- A key for the sharing that is on now. Only while it is on: the page
-- starts sharing first (cl_loc_share), then asks for the key.
create or replace function public.cl_loc_bg_key(p_group uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); until_ timestamptz; k text;
begin
  if me is null then raise exception 'sign in first'; end if;
  select l.share_until into until_ from cl_locations l
   where l.group_id = p_group and l.user_id = me and l.share_until > now();
  if until_ is null then raise exception 'not sharing'; end if;
  delete from cl_bg_keys where (group_id = p_group and user_id = me) or until < now();
  k := encode(gen_random_bytes(24), 'hex');
  insert into cl_bg_keys (key_hash, group_id, user_id, until)
    values (encode(digest(k, 'sha256'), 'hex'), p_group, me, until_);
  return k;
end $$;

-- The service, with the key: here I am now. Returns the end of the sharing,
-- or null when it is over - and the service stops.
create or replace function public.cl_loc_bg_push(p_key text, p_lat double precision, p_lon double precision, p_acc real)
returns timestamptz language plpgsql security definer set search_path = public, extensions as $$
declare r cl_bg_keys%rowtype; until_ timestamptz;
begin
  if p_key is null or length(p_key) <> 48 then return null; end if;
  select * into r from cl_bg_keys where key_hash = encode(digest(p_key, 'sha256'), 'hex');
  if not found or r.until < now() then return null; end if;
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 then
    return r.until;
  end if;
  -- the row is there only while he shares: stopped from the page, the key is dead
  update cl_locations
     set lat = p_lat, lon = p_lon, acc = p_acc, updated_at = now()
   where group_id = r.group_id and user_id = r.user_id and share_until > now()
     -- the page may be sending too; one fix every 10 seconds is plenty
     and updated_at < now() - interval '10 seconds'
  returning share_until into until_;
  if until_ is null then
    if not exists (select 1 from cl_locations where group_id = r.group_id and user_id = r.user_id and share_until > now()) then
      delete from cl_bg_keys where key_hash = r.key_hash;
      return null;
    end if;
    return r.until;
  end if;
  update cl_groups set last_used = now() where id = r.group_id;
  return until_;
end $$;

-- "Stop" on the phone's notification: the sharing ends, as from the page.
create or replace function public.cl_loc_bg_stop(p_key text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare r cl_bg_keys%rowtype;
begin
  if p_key is null then return; end if;
  select * into r from cl_bg_keys where key_hash = encode(digest(p_key, 'sha256'), 'hex');
  if not found then return; end if;
  delete from cl_locations where group_id = r.group_id and user_id = r.user_id;
  delete from cl_bg_keys where group_id = r.group_id and user_id = r.user_id;
end $$;

-- Stopping from the page kills the key too.
create or replace function public.cl_loc_stop(p_group uuid)
returns void language sql security definer set search_path = public as $$
  delete from cl_locations where group_id = p_group and user_id = auth.uid();
  delete from cl_bg_keys where group_id = p_group and user_id = auth.uid();
$$;

revoke all on function public.cl_loc_bg_key(uuid)                                    from public, anon;
revoke all on function public.cl_loc_bg_push(text, double precision, double precision, real) from public;
revoke all on function public.cl_loc_bg_stop(text)                                    from public;
revoke all on function public.cl_loc_stop(uuid)                                       from public, anon;
grant execute on function public.cl_loc_bg_key(uuid)                                  to authenticated;
-- the service has no sign-in: the key is its whole permission
grant execute on function public.cl_loc_bg_push(text, double precision, double precision, real) to anon, authenticated;
grant execute on function public.cl_loc_bg_stop(text)                                  to anon, authenticated;
grant execute on function public.cl_loc_stop(uuid)                                     to authenticated;
