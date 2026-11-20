-- 019: teacher-only Books library, and the mock answer sheet (student types answers, teacher marks).
-- No third-party question text is stored anywhere: the sheet holds numbered answer boxes only.

-- ---------- Books library (admin only, private bucket) ----------
create table public.library_books (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  kind       text not null default 'other'
             check (kind in ('coursebook', 'teachers_book', 'workbook', 'exam_practice', 'reference', 'audio', 'other')),
  publisher  text,
  program    text,
  note       text,
  file_path  text not null unique,      -- path inside the 'library' bucket
  file_name  text not null,
  mime       text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);
alter table public.library_books enable row level security;
create policy library_books_admin on public.library_books
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.library_books from anon;
grant select, insert, update, delete on public.library_books to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('library', 'library', false, 52428800, array[
  'application/pdf', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav'
]) on conflict (id) do nothing;

create policy library_files_admin on storage.objects
  for all to authenticated
  using (bucket_id = 'library' and public.is_admin())
  with check (bucket_id = 'library' and public.is_admin());

-- ---------- Mock answer sheet ----------
-- The key is teacher-only. Answers are keyed L1..L40 (Listening), R1..R40 (Reading).
create table public.mock_keys (
  id         text primary key,
  title      text not null,
  answers    jsonb not null default '{}'::jsonb,   -- {"L1":"Monday/mon", ...}  "/" separates accepted alternatives
  updated_at timestamptz not null default now()
);
alter table public.mock_keys enable row level security;
create policy mock_keys_admin on public.mock_keys
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.mock_keys from anon;
grant select, insert, update, delete on public.mock_keys to authenticated;

create table public.mock_sheets (
  id         uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  mock_id    text not null references public.mock_keys (id) on delete restrict,
  title      text not null,
  answers    jsonb not null default '{}'::jsonb,
  submitted  jsonb not null default '{}'::jsonb,   -- {"L":"2026-11-21T10:00Z","R":...,"R3":...}
  created_at timestamptz not null default now()
);
create index mock_sheets_student_idx on public.mock_sheets (student_id, created_at desc);
alter table public.mock_sheets enable row level security;
create policy mock_sheets_admin on public.mock_sheets
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy mock_sheets_own_select on public.mock_sheets
  for select to authenticated using (student_id in (select public.my_student_ids()));
revoke all on public.mock_sheets from anon;
grant select, insert, update, delete on public.mock_sheets to authenticated;

-- Marking data never reaches the student.
create table public.mock_marks (
  sheet_id   uuid primary key references public.mock_sheets (id) on delete cascade,
  overrides  jsonb not null default '{}'::jsonb,   -- {"L5":true,"R3":false}  teacher overrides of the automatic mark
  codes      jsonb not null default '{}'::jsonb,   -- {"L5":"SP"}
  comment    text,
  updated_at timestamptz not null default now()
);
alter table public.mock_marks enable row level security;
create policy mock_marks_admin on public.mock_marks
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.mock_marks from anon;
grant select, insert, update, delete on public.mock_marks to authenticated;

-- A student saves answers only through this function: own sheet, unlocked parts only, valid box numbers only.
create or replace function public.mock_save(p_sheet uuid, p_answers jsonb, p_part text, p_submit boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.mock_sheets;
  k text; v text; n int; pfx text; lo int; hi int;
  merged jsonb;
begin
  select * into s from public.mock_sheets where id = p_sheet and student_id in (select public.my_student_ids());
  if not found then raise exception 'Sheet not found'; end if;
  if p_part not in ('L', 'R', 'R3') then raise exception 'Unknown part'; end if;
  if s.submitted ? p_part then raise exception 'This part is already submitted'; end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then raise exception 'Bad answers'; end if;
  pfx := case when p_part = 'L' then 'L' else 'R' end;
  lo  := case p_part when 'L' then 1 when 'R' then 1 else 28 end;
  hi  := case p_part when 'L' then 40 when 'R' then 27 else 40 end;
  merged := s.answers;
  for k, v in select key, value from jsonb_each_text(p_answers) loop
    if k ~ ('^' || pfx || '[0-9]{1,2}$') then
      n := substring(k from 2)::int;
      if n between lo and hi then merged := merged || jsonb_build_object(k, left(coalesce(v, ''), 80)); end if;
    end if;
  end loop;
  update public.mock_sheets
     set answers = merged,
         submitted = case when p_submit then submitted || jsonb_build_object(p_part, now()) else submitted end
   where id = p_sheet;
  return merged;
end $$;
revoke execute on function public.mock_save(uuid, jsonb, text, boolean) from anon, public;
grant execute on function public.mock_save(uuid, jsonb, text, boolean) to authenticated;

insert into public.mock_keys (id, title)
values ('ielts-gt-1', 'IELTS General Training mock 1 (Listening 1-40, Reading 1-40)')
on conflict (id) do nothing;
