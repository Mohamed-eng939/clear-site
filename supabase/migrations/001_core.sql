-- CLEAR English Academy: Phase 1 core schema
-- Roles: admin (Mohamed) sees everything. A student sees only their own rows,
-- and only reports that have been published.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- roles
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       text not null default 'student' check (role in ('admin', 'student')),
  full_name  text,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- every new sign-in account starts as a student with no access to anything
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name)
  values (new.id, 'student', coalesce(new.raw_user_meta_data ->> 'full_name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------- students
create table public.students (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid unique references auth.users (id) on delete set null,
  full_name  text not null,
  email      text,
  phone      text,
  country    text,
  goal       text,
  program    text check (program in ('general', 'business', 'conversation', 'esp')),
  cefr       text check (cefr in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  status     text not null default 'lead'
             check (status in ('lead', 'test', 'active', 'paused', 'completed', 'inactive')),
  created_at timestamptz not null default now()
);
create unique index students_email_key on public.students (lower(email)) where email is not null;

-- private notes: admin only, never readable by the student
create table public.student_notes (
  student_id uuid primary key references public.students (id) on delete cascade,
  body       text not null default '',
  updated_at timestamptz not null default now()
);

-- A student account is linked to its record only when the sign-in email is
-- confirmed and matches the email the academy recorded.
create or replace function public.my_student_ids()
returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select id from public.students where user_id = auth.uid();
$$;

create or replace function public.claim_student()
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_email     text;
  v_confirmed timestamptz;
  v_id        uuid;
begin
  if auth.uid() is null then
    return null;
  end if;
  select email, email_confirmed_at into v_email, v_confirmed
  from auth.users where id = auth.uid();
  if v_confirmed is null or v_email is null then
    return null;
  end if;
  update public.students
     set user_id = auth.uid()
   where user_id is null and lower(email) = lower(v_email)
   returning id into v_id;
  if v_id is null then
    select id into v_id from public.students where user_id = auth.uid();
  end if;
  return v_id;
end;
$$;

-- ------------------------------------------------------------- packages
create table public.packages (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references public.students (id) on delete cascade,
  program        text not null check (program in ('general', 'business', 'conversation', 'esp')),
  levels         int  not null check (levels between 1 and 3),
  lessons_total  int  not null check (lessons_total > 0),
  list_price_usd numeric(10, 2) not null,
  discount_pct   numeric(5, 2)  not null default 0,
  price_usd      numeric(10, 2) not null,
  status         text not null default 'pending'
                 check (status in ('pending', 'active', 'completed', 'expired', 'cancelled')),
  starts_on      date,
  expires_on     date,
  pause_until    date,
  created_at     timestamptz not null default now()
);
create index packages_student_idx on public.packages (student_id);

-- ------------------------------------------------------------- payments
-- gapless receipt counter: rolled back inserts do not burn a number
create table public.receipt_counter (
  id int primary key default 1 check (id = 1),
  n  int not null
);
insert into public.receipt_counter (id, n) values (1, 1);  -- CLEAR-0001 is Dina's, imported with her number

create or replace function public.set_receipt_no()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare v int;
begin
  if new.receipt_no is null or new.receipt_no = '' then
    update public.receipt_counter set n = n + 1 where id = 1 returning n into v;
    new.receipt_no := 'CLEAR-' || lpad(v::text, 4, '0');
  end if;
  return new;
end;
$$;

create table public.payments (
  id         uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  package_id uuid references public.packages (id) on delete set null,
  amount     numeric(12, 2) not null check (amount > 0),
  currency   text not null default 'USD' check (currency in ('USD', 'EGP')),
  method     text not null,
  reference  text,
  paid_on    date not null default current_date,
  receipt_no text not null unique,
  note       text,
  created_at timestamptz not null default now()
);
create index payments_student_idx on public.payments (student_id);

create trigger payments_receipt_no
  before insert on public.payments
  for each row execute function public.set_receipt_no();

-- -------------------------------------------------------------- lessons
create table public.lessons (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.students (id) on delete cascade,
  package_id   uuid references public.packages (id) on delete set null,
  starts_at    timestamptz not null,
  duration_min int not null default 60,
  status       text not null default 'scheduled'
               check (status in ('scheduled', 'completed', 'moved', 'late_cancel', 'no_show', 'cancelled_by_academy')),
  topic        text,
  summary      text,            -- visible to the student
  meeting_url  text,
  created_at   timestamptz not null default now()
);
create index lessons_student_idx on public.lessons (student_id, starts_at);
create index lessons_starts_idx on public.lessons (starts_at);

-- -------------------------------------------------------------- reports
create table public.reports (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references public.students (id) on delete cascade,
  kind            text not null default 'placement' check (kind in ('placement', 'progress', 'final')),
  title           text,
  cefr            text check (cefr in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  summary         text,
  goals           text,
  skills          jsonb not null default '[]'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  objectives      jsonb not null default '[]'::jsonb,
  plan            jsonb not null default '[]'::jsonb,
  assessed_by     text not null default 'CLEAR Academic Team',
  published       boolean not null default false,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index reports_student_idx on public.reports (student_id);

create or replace function public.touch_report()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.published and (tg_op = 'INSERT' or not old.published) then
    new.published_at := now();
  end if;
  return new;
end;
$$;

create trigger reports_touch
  before insert or update on public.reports
  for each row execute function public.touch_report();

-- ------------------------------------------------- row-level security
alter table public.profiles      enable row level security;
alter table public.students      enable row level security;
alter table public.student_notes enable row level security;
alter table public.packages      enable row level security;
alter table public.payments      enable row level security;
alter table public.lessons       enable row level security;
alter table public.reports       enable row level security;
alter table public.receipt_counter enable row level security;  -- no policies: only the trigger touches it

-- profiles: you see your own; only the admin changes roles
create policy profiles_select on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_admin_write on public.profiles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- students
create policy students_admin on public.students
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy students_own_select on public.students
  for select to authenticated using (user_id = auth.uid());

-- private notes: admin only
create policy notes_admin on public.student_notes
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- packages, payments, lessons: admin everything, student reads their own
create policy packages_admin on public.packages
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy packages_own_select on public.packages
  for select to authenticated using (student_id in (select public.my_student_ids()));

create policy payments_admin on public.payments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy payments_own_select on public.payments
  for select to authenticated using (student_id in (select public.my_student_ids()));

create policy lessons_admin on public.lessons
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy lessons_own_select on public.lessons
  for select to authenticated using (student_id in (select public.my_student_ids()));

-- reports: a student reads only their own published reports
create policy reports_admin on public.reports
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy reports_own_select on public.reports
  for select to authenticated
  using (published and student_id in (select public.my_student_ids()));

-- ------------------------------------------------------------- grants
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon, public;

grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on public.receipt_counter from authenticated;
grant execute on function public.is_admin()        to authenticated;
grant execute on function public.my_student_ids()  to authenticated;
grant execute on function public.claim_student()   to authenticated;
