-- ─────────────────────────────────────────────────────────────────────────
-- Friends, third part (runs after cl_friends_2.sql): an invitation rings.
--
-- When a member invites a registered user, the invited user's phone gets a
-- notification at once - on every device where he switched notifications
-- on while signed in (push_subs.user_id). It goes through push-send, the
-- same function and the same shared secret (cl_secrets) as the community
-- alerts, so there is still one copy of that secret.
--
-- Run the whole block at once. The revokes are part of it: in this project
-- new objects are born granted to anon, so a create without a revoke beside
-- it is a hole.
-- ─────────────────────────────────────────────────────────────────────────

-- Whom to ring for one invitation, and what to tell him. Only a fresh one
-- (ten minutes): a retry of an old call must not ring anybody twice later.
create or replace function public.cl_invite_targets(p_group uuid, p_user uuid)
returns table (endpoint text, p256dh text, auth text, lang text, group_name text, inviter text)
language sql security definer set search_path = public as $$
  select s.endpoint, s.p256dh, s.auth, coalesce(s.lang, 'he'), g.name, coalesce(m.name, '')
  from cl_invites i
  join cl_groups g on g.id = i.group_id
  left join cl_group_members m on m.group_id = i.group_id and m.user_id = i.invited_by
  join push_subs s on s.user_id = i.user_id
  where i.group_id = p_group and i.user_id = p_user
    and i.created_at > now() - interval '10 minutes';
$$;
revoke all on function public.cl_invite_targets(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cl_invite_targets(uuid, uuid) to service_role;

-- The trigger: like cl_alert_push, it hands the row to push-send and goes.
create or replace function public.cl_invite_push()
returns trigger language plpgsql security definer set search_path = public, net, extensions as $$
declare v_secret text;
begin
  select btrim(value) into v_secret from public.cl_secrets where key = 'push_hook_secret';
  if v_secret is null or v_secret = '' then
    raise warning 'cl_invite_push: no push_hook_secret in cl_secrets, nothing sent';
    return new;
  end if;
  perform net.http_post(
    url := 'https://cdgqodtbdhsqkvcgcdlm.supabase.co/functions/v1/push-send',
    body := jsonb_build_object('invite', jsonb_build_object('group', new.group_id, 'user', new.user_id)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
    timeout_milliseconds := 5000
  );
  return new;
end $$;
revoke all on function public.cl_invite_push() from public, anon, authenticated;

drop trigger if exists cl_invites_push on public.cl_invites;
-- insert: a new invitation; update: the same person invited again (the
-- invite function refreshes created_at), which should ring again too
create trigger cl_invites_push after insert or update on public.cl_invites
  for each row execute function public.cl_invite_push();

notify pgrst, 'reload schema';
