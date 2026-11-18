-- ─────────────────────────────────────────────────────────────────────────
-- The forum: a reply rings the person it answers.
--
-- When someone replies to a post, the post's writer gets a notification on
-- every device where he switched notifications on while signed in
-- (push_subs.user_id). A reply to a reply also rings the writer of that
-- reply. Nobody is rung for his own reply. It goes through push-send with the
-- same shared secret (cl_secrets) as the alerts and the friend invitations.
--
-- Run the whole block at once. The revokes are part of it: in this project
-- new objects are born granted to anon, so a create without a revoke beside
-- it is a hole.
-- ─────────────────────────────────────────────────────────────────────────

-- Whom to ring for one reply, and what to tell him. Only a fresh reply (ten
-- minutes): a retry of an old call must not ring anybody twice later.
create or replace function public.cl_reply_targets(p_reply uuid)
returns table (endpoint text, p256dh text, auth text, lang text, replier text, snippet text, post_id uuid, to_post boolean)
language sql security definer set search_path = public as $$
  with r as (
    select r.id, r.post_id, r.parent_id, r.user_id, r."user", r.content
    from replies r
    where r.id = p_reply and r.created_at > now() - interval '10 minutes'
  ), who as (
    -- the post's writer, and the writer of the reply answered (if any)
    select p.user_id as uid, true as to_post from r join posts p on p.id = r.post_id
    union
    select q.user_id, false from r join replies q on q.id = r.parent_id
  ), one as (
    -- one row per person: a post's writer answered inside his own thread
    -- hears "a reply to your post"
    select uid, bool_or(to_post) as to_post from who
    where uid is not null and uid is distinct from (select user_id from r)
    group by uid
  )
  select s.endpoint, s.p256dh, s.auth, coalesce(s.lang, 'he'),
         coalesce((select "user" from r), ''), left(coalesce((select content from r), ''), 120),
         (select post_id from r), one.to_post
  from one join push_subs s on s.user_id = one.uid;
$$;
revoke all on function public.cl_reply_targets(uuid) from public, anon, authenticated;
grant execute on function public.cl_reply_targets(uuid) to service_role;

-- The trigger: like cl_alert_push, it hands the row to push-send and goes.
create or replace function public.cl_reply_push()
returns trigger language plpgsql security definer set search_path = public, net, extensions as $$
declare v_secret text;
begin
  select btrim(value) into v_secret from public.cl_secrets where key = 'push_hook_secret';
  if v_secret is null or v_secret = '' then
    raise warning 'cl_reply_push: no push_hook_secret in cl_secrets, nothing sent';
    return new;
  end if;
  perform net.http_post(
    url := 'https://cdgqodtbdhsqkvcgcdlm.supabase.co/functions/v1/push-send',
    body := jsonb_build_object('reply', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
    timeout_milliseconds := 5000
  );
  return new;
end $$;
revoke all on function public.cl_reply_push() from public, anon, authenticated;

drop trigger if exists cl_replies_push on public.replies;
create trigger cl_replies_push after insert on public.replies
  for each row execute function public.cl_reply_push();

notify pgrst, 'reload schema';
