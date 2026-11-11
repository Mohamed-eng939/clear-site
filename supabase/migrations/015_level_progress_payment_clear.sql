-- 1) Per-student CLEAR level (A1.1, A1.2 ...). students.cefr stays the broad CEFR band.
alter table public.students add column if not exists level_code text;
update public.students set level_code = 'A1.2', cefr = coalesce(cefr, 'A1') where full_name ilike 'Dina Nady%' and level_code is null;

-- 2) Recording any payment clears the "payment due" flag on that student.
create or replace function public.clear_payment_due()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.students set payment_due = false, payment_due_note = null
   where id = new.student_id and payment_due;
  return new;
end $$;
drop trigger if exists payments_clear_due on public.payments;
create trigger payments_clear_due after insert on public.payments
  for each row execute function public.clear_payment_due();

-- 3) Level results (written by the teacher now, by the app exam later). A pass moves the student to the next level.
create table if not exists public.level_results (
  id         uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  level_code text not null,
  outcome    text not null check (outcome in ('pass', 'needs_practice')),
  score      numeric,
  note       text,
  decided_at timestamptz not null default now()
);
create index if not exists level_results_student_idx on public.level_results (student_id);
alter table public.level_results enable row level security;
drop policy if exists level_results_admin on public.level_results;
create policy level_results_admin on public.level_results
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists level_results_own_select on public.level_results;
create policy level_results_own_select on public.level_results
  for select to authenticated using (exists (select 1 from public.students s where s.id = student_id and s.user_id = auth.uid()));

create or replace function public.advance_level_on_pass()
returns trigger language plpgsql security definer set search_path = public as $$
declare cur record; nxt record; st record;
begin
  if new.outcome <> 'pass' then return new; end if;
  select position into cur from public.cur_levels where code = new.level_code;
  if cur.position is null then return new; end if;
  select * into st from public.students where id = new.student_id;
  -- only move forward: ignore a pass recorded for a level the student has already left
  if st.level_code is not null and exists (
       select 1 from public.cur_levels c where c.code = st.level_code and c.position > cur.position) then
    return new;
  end if;
  select * into nxt from public.cur_levels where position > cur.position order by position limit 1;
  if nxt.id is null then return new; end if;   -- last level: stays put
  update public.students set level_code = nxt.code, cefr = nxt.cefr where id = new.student_id;
  return new;
end $$;
drop trigger if exists level_results_advance on public.level_results;
create trigger level_results_advance after insert on public.level_results
  for each row execute function public.advance_level_on_pass();
