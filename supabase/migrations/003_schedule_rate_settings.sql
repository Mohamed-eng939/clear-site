-- Phase 1 additions: academy settings, USD to EGP rate per payment,
-- a weekly lesson pattern per package, and a function that builds the lessons from it.

-- ------------------------------------------------------------- settings (one row, admin only)
create table public.settings (
  id                  int primary key default 1 check (id = 1),
  usd_egp_rate        numeric(10, 4) not null default 50.6329 check (usd_egp_rate > 0),
  default_meeting_url text
);
insert into public.settings (id) values (1);

alter table public.settings enable row level security;
create policy settings_admin on public.settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.settings from anon;
grant select, insert, update, delete on public.settings to authenticated;

-- ------------------------------------------------------------- rate kept with each USD payment
alter table public.payments add column egp_rate numeric(10, 4);
update public.payments set egp_rate = 50.6329 where currency = 'USD' and egp_rate is null;

-- ------------------------------------------------------------- weekly pattern per package
-- schedule: [{"dow": 1, "time": "21:00", "min": 60}, ...]   dow 0 = Sunday ... 6 = Saturday
-- schedule_tz: the time zone those clock times are in (an IANA name, e.g. Asia/Bahrain)
alter table public.packages
  add column schedule    jsonb not null default '[]'::jsonb,
  add column schedule_tz text  not null default 'Africa/Cairo';

-- Builds the package's remaining lessons from its weekly pattern, starting on p_start.
-- p_replace first removes the package's upcoming lessons that are still 'scheduled'.
-- Runs as the caller, so row-level security and the admin check both apply.
create or replace function public.generate_lessons(p_package uuid, p_start date, p_replace boolean default false)
returns int
language plpgsql
set search_path = public
as $$
declare
  pk      public.packages%rowtype;
  have    int;
  need    int;
  made    int := 0;
  d       date;
  ent     jsonb;
  ts      timestamptz;
  meet    text;
  first_d date;
begin
  if not public.is_admin() then
    raise exception 'Only the academy admin can schedule lessons.';
  end if;
  select * into pk from public.packages where id = p_package;
  if not found then
    raise exception 'Package not found.';
  end if;
  if jsonb_typeof(pk.schedule) <> 'array' or jsonb_array_length(pk.schedule) = 0 then
    raise exception 'Add at least one weekly day first.';
  end if;
  perform now() at time zone pk.schedule_tz;          -- raises if the zone name is not valid

  if p_replace then
    delete from public.lessons
     where package_id = p_package and status = 'scheduled' and starts_at >= now();
  end if;

  select count(*) into have from public.lessons
   where package_id = p_package and status in ('scheduled', 'completed', 'late_cancel', 'no_show');
  need := pk.lessons_total - have;
  if need <= 0 then
    raise exception 'All % lessons of this package are already scheduled.', pk.lessons_total;
  end if;

  select default_meeting_url into meet from public.settings where id = 1;

  for d in select g::date from generate_series(p_start::timestamp, (p_start + 365)::timestamp, interval '1 day') g loop
    exit when made >= need;
    for ent in select value from jsonb_array_elements(pk.schedule) order by value ->> 'time' loop
      exit when made >= need;
      if (ent ->> 'dow')::int = extract(dow from d)::int then
        ts := (d + (ent ->> 'time')::time) at time zone pk.schedule_tz;
        if not exists (
          select 1 from public.lessons
           where package_id = p_package and starts_at = ts
             and status not in ('moved', 'cancelled_by_academy')
        ) then
          insert into public.lessons (student_id, package_id, starts_at, duration_min, meeting_url)
          values (pk.student_id, p_package, ts, coalesce((ent ->> 'min')::int, 60), meet);
          made := made + 1;
        end if;
      end if;
    end loop;
  end loop;

  -- the 10 weeks run from the first lesson; set them unless lessons were already delivered
  if pk.starts_on is null
     or (p_replace and not exists (
           select 1 from public.lessons
            where package_id = p_package and status in ('completed', 'late_cancel', 'no_show'))) then
    select min((starts_at at time zone pk.schedule_tz)::date) into first_d
      from public.lessons where package_id = p_package and status <> 'cancelled_by_academy';
    if first_d is not null then
      update public.packages set starts_on = first_d, expires_on = first_d + 70 where id = p_package;
    end if;
  end if;

  return made;
end;
$$;

revoke all on function public.generate_lessons(uuid, date, boolean) from public, anon;
grant execute on function public.generate_lessons(uuid, date, boolean) to authenticated;
