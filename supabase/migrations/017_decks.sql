-- Slide decks: view and present in the browser, edit (admin and teachers), students view only.
-- A student sees a deck only when the teacher has made it visible and it belongs to the plan lesson of one of her lessons.
-- Speaker notes live in their own table so they never reach a student.

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.my_teacher_id() is not null
$$;

create table public.decks (
  id                  uuid primary key default gen_random_uuid(),
  cur_lesson_id       uuid references public.cur_lessons (id) on delete set null,
  title               text not null,
  slides              jsonb not null default '[]'::jsonb,
  visible_to_students boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);
create index decks_lesson_idx on public.decks (cur_lesson_id);

create table public.deck_notes (
  deck_id    uuid primary key references public.decks (id) on delete cascade,
  notes      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.deck_assets (
  id         uuid primary key default gen_random_uuid(),
  deck_id    uuid not null references public.decks (id) on delete cascade,
  kind       text not null check (kind in ('image', 'audio')),
  name       text,
  mime       text,
  data       text,            -- images: base64 (small, optimised)
  file_path  text,            -- audio: path inside the 'materials' bucket, under decks/
  created_at timestamptz not null default now()
);
create index deck_assets_deck_idx on public.deck_assets (deck_id);

create or replace function public.can_view_deck(p_deck uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() or exists (
    select 1 from public.decks d
     where d.id = p_deck and d.visible_to_students
       and d.cur_lesson_id in (select l.cur_lesson_id from public.lessons l
                                where l.cur_lesson_id is not null and l.student_id in (select public.my_student_ids()))
  )
$$;

create or replace function public.touch_deck() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger decks_touch before update on public.decks for each row execute function public.touch_deck();

alter table public.decks       enable row level security;
alter table public.deck_notes  enable row level security;
alter table public.deck_assets enable row level security;

create policy decks_view   on public.decks for select to authenticated using (public.can_view_deck(id));
create policy decks_staff_w on public.decks for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy deck_notes_staff on public.deck_notes for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy deck_assets_view on public.deck_assets for select to authenticated using (public.can_view_deck(deck_id));
create policy deck_assets_staff_w on public.deck_assets for all to authenticated using (public.is_staff()) with check (public.is_staff());

revoke all on public.decks, public.deck_notes, public.deck_assets from anon;
grant select, insert, update, delete on public.decks, public.deck_notes, public.deck_assets to authenticated;
revoke execute on function public.is_staff(), public.can_view_deck(uuid) from anon, public;
grant  execute on function public.is_staff(), public.can_view_deck(uuid) to authenticated;
revoke execute on function public.touch_deck() from anon, authenticated, public;

-- audio files for slides
create policy deck_audio_staff on storage.objects for all to authenticated
  using (bucket_id = 'materials' and name like 'decks/%' and public.is_staff())
  with check (bucket_id = 'materials' and name like 'decks/%' and public.is_staff());
create policy deck_audio_student_read on storage.objects for select to authenticated
  using (bucket_id = 'materials' and name like 'decks/%'
         and exists (select 1 from public.deck_assets a where a.file_path = storage.objects.name and public.can_view_deck(a.deck_id)));

-- one-time import jobs: an encrypted bundle shipped with the app, opened with a key kept only here
create table public.import_jobs (
  name text primary key,
  file text not null,
  key  text,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.import_jobs enable row level security;
create policy import_jobs_admin on public.import_jobs for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.import_jobs from anon;
grant select, insert, update, delete on public.import_jobs to authenticated;
