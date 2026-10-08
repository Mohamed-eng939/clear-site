-- Lesson materials: files you upload from your device (slides, handouts, recordings).
-- Files live in a private storage bucket. A student can open only the files recorded
-- for them in public.materials; the admin can do everything.

create table public.materials (
  id         uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  lesson_id  uuid references public.lessons (id) on delete set null,
  title      text not null,
  kind       text not null default 'other'
             check (kind in ('slides', 'handout', 'worksheet', 'homework', 'recording', 'other')),
  note       text,
  file_path  text not null unique,      -- path inside the 'materials' bucket
  file_name  text not null,
  mime       text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);
create index materials_student_idx on public.materials (student_id, created_at desc);
create index materials_lesson_idx on public.materials (lesson_id);

alter table public.materials enable row level security;
create policy materials_admin on public.materials
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy materials_own_select on public.materials
  for select to authenticated using (student_id in (select public.my_student_ids()));
revoke all on public.materials from anon;
grant select, insert, update, delete on public.materials to authenticated;

-- private bucket, 50 MB per file (the free plan limit), common study-file types only
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('materials', 'materials', false, 52428800, array[
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav',
  'video/mp4'
])
on conflict (id) do nothing;

-- admin: full control of the bucket
create policy materials_files_admin on storage.objects
  for all to authenticated
  using (bucket_id = 'materials' and public.is_admin())
  with check (bucket_id = 'materials' and public.is_admin());

-- student: read only the files recorded for them
create policy materials_files_student_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'materials'
    and exists (
      select 1 from public.materials m
       where m.file_path = storage.objects.name
         and m.student_id in (select public.my_student_ids())
    )
  );
