-- ─────────────────────────────────────────────────────────────────────────
-- Rate-limit counters for tf-translate.
--
-- tf-translate spends real money per call and is reachable by anyone who
-- reads the page source. The shape of what may be asked is now closed, so
-- the worst a stranger can do is translate short sentences - but he could
-- still do it in a loop. These two counters put a ceiling on that.
--
-- Run the whole block at once. The revokes are part of it: in this project
-- new objects are born granted to anon, so a create without a revoke beside
-- it is a hole.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.cl_ai_usage (
  bucket     text primary key,              -- 'day:2026-11-09' | 'ip:1.2.3.4:2026-11-09T08'
  n          int  not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.cl_ai_usage enable row level security;
revoke all on public.cl_ai_usage from anon, authenticated, public;

-- Counts one call and says whether it was still within the limit. The
-- increment happens either way, so a client that ignores the refusal keeps
-- digging its own hole deeper rather than resetting it.
create or replace function public.cl_ai_bump(p_bucket text, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare cur int;
begin
  -- Yesterday's buckets are dead weight. Swept now and then rather than on
  -- every call, which would make every translation pay for the cleaning.
  if random() < 0.01 then
    delete from cl_ai_usage where updated_at < now() - interval '3 days';
  end if;

  insert into cl_ai_usage (bucket, n) values (p_bucket, 1)
    on conflict (bucket) do update
      set n = cl_ai_usage.n + 1, updated_at = now()
    returning n into cur;

  return cur <= p_limit;
end $$;

revoke all on function public.cl_ai_bump(text, int) from public, anon, authenticated;
grant execute on function public.cl_ai_bump(text, int) to service_role;

notify pgrst, 'reload schema';
