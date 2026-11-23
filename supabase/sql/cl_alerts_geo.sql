-- ======================================================================
--  CerviniaLive - where a report was made
--
--  The navigation's "⚠️" button posts a report (ice, an obstacle, fog...)
--  into public.alerts like any other alert, and adds the spot the skier
--  stood at, so the navigation map can show it to the next one who passes.
--
--  Until this runs the site still works: it posts and reads without the
--  two columns, and the reports simply do not appear on the map.
--
--  Run once in Supabase -> SQL Editor. Safe to run twice.
-- ======================================================================

alter table public.alerts
  add column if not exists lat double precision,
  add column if not exists lon double precision;

-- somewhere on Earth, or nowhere
alter table public.alerts drop constraint if exists alerts_latlon_ok;
alter table public.alerts add constraint alerts_latlon_ok
  check ((lat is null and lon is null)
      or (lat between -90 and 90 and lon between -180 and 180));
