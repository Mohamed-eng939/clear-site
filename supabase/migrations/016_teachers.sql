-- Teachers (freelancers): profile, assigned students, weekly availability, requests, warnings.
-- Rules: a teacher sees only their assigned students, without phone, email or payments.
-- Teachers change data only through the functions below, never by writing to tables directly.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'student', 'teacher'));

create table public.teachers (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid unique references auth.users (id) on delete set null,
  full_name    text not null,
  email        text not null,
  phone        text,
  status       text not null default 'invited' check (status in ('invited', 'active', 'paused', 'ended')),
  start_date   date,
  end_date     date,
  rate_per_lesson numeric(10, 2),
  currency     text not null default 'EGP',
  weekly_hours numeric(5, 1),            -- agreed commitment, for example 2
  agreement    text,                     -- plain words: "Sunday and Wednesday 1 h each"
  bio          text,
  created_at   timestamptz not null default now()
);
create unique index teachers_email_key on public.teachers (lower(email));

create table public.teacher_notes (
  teacher_id uuid primary key references public.teachers (id) on delete cascade,
  body       text not null default '',
  updated_at timestamptz not null default now()
);

create table public.teacher_students (
  id         uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  starts_on  date not null default current_date,
  ends_on    date,
  created_at timestamptz not null default now()
);
create unique index teacher_students_one_active on public.teacher_students (student_id) where ends_on is null;
create index teacher_students_teacher_idx on public.teacher_students (teacher_id);

-- weekly availability / commitment, in Egypt time
create table public.teacher_slots (
  id         uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id) on delete cascade,
  dow        int  not null check (dow between 0 and 6),   -- 0 Sunday
  start_time time not null,
  duration_min int not null default 60 check (duration_min between 15 and 240),
  note       text,
  created_at timestamptz not null default now()
);

create table public.teacher_requests (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null references public.teachers (id) on delete cascade,
  kind        text not null check (kind in ('leave', 'swap', 'material', 'suggestion', 'other')),
  subject     text not null,
  body        text,
  date_from   date,
  date_to     date,
  status      text not null default 'open' check (status in ('open', 'approved', 'declined', 'done')),
  admin_reply text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);

create table public.teacher_warnings (
  id         uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id) on delete cascade,
  level      text not null check (level in ('verbal', 'written', 'final')),
  reason     text not null,
  issued_on  date not null default current_date,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.lessons add column if not exists teacher_id uuid references public.teachers (id) on delete set null;
alter table public.lessons add column if not exists marked_at timestamptz;
alter table public.assignments add column if not exists reviewed_by_teacher uuid references public.teachers (id) on delete set null;
create index if not exists lessons_teacher_idx on public.lessons (teacher_id, starts_at);

-- ------------------------------------------------------------ helpers
create or replace function public.my_teacher_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.teachers where user_id = auth.uid() and status in ('invited', 'active');
$$;
create or replace function public.teacher_my_student_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select ts.student_id from public.teacher_students ts
   where ts.teacher_id = public.my_teacher_id() and ts.ends_on is null;
$$;
create or replace function public.teacher_my_cur_lesson_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select distinct l.cur_lesson_id from public.lessons l
   where l.teacher_id = public.my_teacher_id() and l.cur_lesson_id is not null;
$$;

-- A teacher account is linked only when the sign-in email is confirmed and matches the email the academy recorded.
create or replace function public.claim_teacher()
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare v_email text; v_confirmed timestamptz; v_id uuid;
begin
  if auth.uid() is null then return null; end if;
  select email, email_confirmed_at into v_email, v_confirmed from auth.users where id = auth.uid();
  if v_confirmed is null or v_email is null then return null; end if;
  update public.teachers set user_id = auth.uid(), status = case when status = 'invited' then 'active' else status end
   where user_id is null and lower(email) = lower(v_email) and status <> 'ended'
   returning id into v_id;
  if v_id is null then select id into v_id from public.teachers where user_id = auth.uid(); end if;
  if v_id is not null then
    update public.profiles set role = 'teacher' where id = auth.uid() and role = 'student';
  end if;
  return v_id;
end $$;

-- the roster a teacher sees: no phone, no email, no payments
create or replace view public.teacher_roster with (security_invoker = false) as
  select s.id, s.full_name, s.program, s.cefr, s.level_code, s.goal, s.country, ts.starts_on
    from public.students s
    join public.teacher_students ts on ts.student_id = s.id and ts.ends_on is null
   where ts.teacher_id = public.my_teacher_id();

-- ------------------------------------------------------------ teacher actions
create or replace function public.teacher_mark_lesson(p_id uuid, p_status text, p_topic text, p_summary text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('completed', 'no_show', 'moved', 'late_cancel') then raise exception 'Not a valid attendance mark'; end if;
  update public.lessons set status = p_status, topic = coalesce(nullif(trim(p_topic), ''), topic),
         summary = coalesce(nullif(trim(p_summary), ''), summary), marked_at = now()
   where id = p_id and teacher_id = public.my_teacher_id();
  if not found then raise exception 'Lesson not found'; end if;
end $$;

create or replace function public.teacher_review_assignment(p_id uuid, p_feedback text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(p_feedback), '') = '' then raise exception 'Write your feedback first'; end if;
  update public.assignments set feedback = trim(p_feedback), status = 'reviewed', reviewed_at = now(), reviewed_by_teacher = public.my_teacher_id()
   where id = p_id and status in ('submitted', 'reviewed') and student_id in (select public.teacher_my_student_ids());
  if not found then raise exception 'Homework not found'; end if;
end $$;

create or replace function public.teacher_assign_homework(p_student uuid, p_title text, p_instructions text, p_due date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_student not in (select public.teacher_my_student_ids()) then raise exception 'Student not found'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'Give the homework a title'; end if;
  insert into public.assignments (student_id, title, instructions, due_on) values (p_student, trim(p_title), nullif(trim(p_instructions), ''), p_due);
end $$;

create or replace function public.teacher_send_request(p_kind text, p_subject text, p_body text, p_from date, p_to date)
returns void language plpgsql security definer set search_path = public as $$
declare t uuid := public.my_teacher_id();
begin
  if t is null then raise exception 'Not a teacher account'; end if;
  if p_kind not in ('leave', 'swap', 'material', 'suggestion', 'other') then raise exception 'Choose a type'; end if;
  if coalesce(trim(p_subject), '') = '' then raise exception 'Add a short subject'; end if;
  insert into public.teacher_requests (teacher_id, kind, subject, body, date_from, date_to)
  values (t, p_kind, trim(p_subject), nullif(trim(p_body), ''), p_from, p_to);
end $$;

create or replace function public.teacher_ack_warning(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.teacher_warnings set acknowledged_at = coalesce(acknowledged_at, now())
   where id = p_id and teacher_id = public.my_teacher_id();
end $$;

-- ------------------------------------------------------------ security
alter table public.teachers         enable row level security;
alter table public.teacher_notes    enable row level security;
alter table public.teacher_students enable row level security;
alter table public.teacher_slots    enable row level security;
alter table public.teacher_requests enable row level security;
alter table public.teacher_warnings enable row level security;

create policy teachers_admin on public.teachers for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy teachers_own_select on public.teachers for select to authenticated using (user_id = auth.uid());
create policy teacher_notes_admin on public.teacher_notes for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy teacher_students_admin on public.teacher_students for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy teacher_students_own_select on public.teacher_students for select to authenticated using (teacher_id = public.my_teacher_id());
create policy teacher_slots_admin on public.teacher_slots for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy teacher_slots_own_select on public.teacher_slots for select to authenticated using (teacher_id = public.my_teacher_id());
create policy teacher_requests_admin on public.teacher_requests for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy teacher_requests_own_select on public.teacher_requests for select to authenticated using (teacher_id = public.my_teacher_id());
create policy teacher_warnings_admin on public.teacher_warnings for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy teacher_warnings_own_select on public.teacher_warnings for select to authenticated using (teacher_id = public.my_teacher_id());

-- read access to what a teacher teaches: their lessons, their students' homework, the kits for their lessons
create policy lessons_teacher_select on public.lessons for select to authenticated using (teacher_id = public.my_teacher_id());
create policy assignments_teacher_select on public.assignments for select to authenticated using (student_id in (select public.teacher_my_student_ids()));
create policy assignment_files_teacher_select on public.assignment_files for select to authenticated using (student_id in (select public.teacher_my_student_ids()));
create policy cur_levels_teacher_select on public.cur_levels for select to authenticated using (public.my_teacher_id() is not null);
create policy cur_lessons_teacher_select on public.cur_lessons for select to authenticated using (id in (select public.teacher_my_cur_lesson_ids()));
create policy cur_files_teacher_select on public.cur_files for select to authenticated using (lesson_id in (select public.teacher_my_cur_lesson_ids()));
create policy materials_files_teacher_read on storage.objects for select to authenticated using (
  bucket_id = 'materials' and (
    ((storage.foldername(name))[1] in (select public.teacher_my_student_ids()::text) and (storage.foldername(name))[2] = 'submissions')
    or ((storage.foldername(name))[1] = 'kits' and (storage.foldername(name))[2] in (select public.teacher_my_cur_lesson_ids()::text))
  )
);

revoke all on public.teachers, public.teacher_notes, public.teacher_students, public.teacher_slots, public.teacher_requests, public.teacher_warnings from anon;
grant select, insert, update, delete on public.teachers, public.teacher_notes, public.teacher_students, public.teacher_slots, public.teacher_requests, public.teacher_warnings to authenticated;
revoke all on public.teacher_roster from anon, public;
grant select on public.teacher_roster to authenticated;

revoke execute on function public.my_teacher_id(), public.teacher_my_student_ids(), public.teacher_my_cur_lesson_ids(), public.claim_teacher(),
  public.teacher_mark_lesson(uuid, text, text, text), public.teacher_review_assignment(uuid, text), public.teacher_assign_homework(uuid, text, text, date),
  public.teacher_send_request(text, text, text, date, date), public.teacher_ack_warning(uuid) from public, anon;
grant execute on function public.my_teacher_id(), public.teacher_my_student_ids(), public.teacher_my_cur_lesson_ids(), public.claim_teacher(),
  public.teacher_mark_lesson(uuid, text, text, text), public.teacher_review_assignment(uuid, text), public.teacher_assign_homework(uuid, text, text, date),
  public.teacher_send_request(text, text, text, date, date), public.teacher_ack_warning(uuid) to authenticated;
