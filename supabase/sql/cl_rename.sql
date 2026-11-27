-- cl_rename.sql: a signed-in user changes his own display name (Yossi, 27.11).
--
-- The name lives in profiles.username, and it is also written beside
-- everything the person posted (posts."user", replies."user",
-- reactions."user", reviews.author_name, alerts.author_name). Renaming only
-- the profile would leave the old name on every old message, so this
-- renames them all, in one transaction, for the caller only.
--
-- Signing in goes by username (cl_login_email), so after a rename the
-- person signs in with the NEW name. The account itself - its id, its
-- internal sign-in address, is_admin - does not change.
--
-- Run once in the Supabase SQL editor. Safe to run again.

create or replace function public.cl_rename_me(p_new text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  nn  text := btrim(coalesce(p_new, ''));
  old text;
begin
  if uid is null then
    raise exception 'not_signed_in';
  end if;
  if char_length(nn) < 2 or char_length(nn) > 30 then
    raise exception 'bad_length';
  end if;
  if nn ~ '[<>"''`\\]' then
    raise exception 'bad_chars';
  end if;

  select username into old from public.profiles where id = uid;
  if old is null then
    raise exception 'no_profile';
  end if;
  if old = nn then
    return nn;
  end if;
  if exists (select 1 from public.profiles
             where lower(username) = lower(nn) and id <> uid) then
    raise exception 'taken';
  end if;

  update public.profiles  set username = nn    where id = uid;
  update public.posts     set "user" = nn      where user_id = uid or (user_id is null and "user" = old);
  update public.replies   set "user" = nn      where user_id = uid or (user_id is null and "user" = old);
  update public.reactions set "user" = nn      where "user" = old;
  update public.reviews   set author_name = nn where author_id = uid;
  update public.alerts    set author_name = nn where author_id = uid;
  return nn;
end;
$$;

-- the rights: nobody by default, then only a signed-in user, for himself
revoke all on function public.cl_rename_me(text) from public;
revoke all on function public.cl_rename_me(text) from anon;
grant execute on function public.cl_rename_me(text) to authenticated;
