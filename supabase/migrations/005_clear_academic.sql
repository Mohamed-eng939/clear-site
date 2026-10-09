-- CLEAR Academic: the teacher's curriculum, lesson kits, sources, homework and feedback checkpoints.
-- Everything in cur_* is teacher-only (admin). Students only see what the teacher sends them:
-- materials (already exist), assignments (homework) and published reports.

-- ------------------------------------------------------------- curriculum
create table public.cur_levels (
  id        uuid primary key default gen_random_uuid(),
  program   text not null default 'general',
  code      text not null unique,            -- e.g. A1.1
  name      text not null,
  cefr      text not null default 'A1',
  position  int  not null,
  summary   text
);

create table public.cur_lessons (
  id            uuid primary key default gen_random_uuid(),
  level_id      uuid not null references public.cur_levels (id) on delete cascade,
  number        int  not null,               -- 1..8 inside the level
  title         text not null,
  objective     text,                         -- "By the end the learner can ..."
  grammar       text,
  vocabulary    text,
  navigate_ref  text,                         -- where this comes from in Navigate A1 Beginner (for the teacher)
  omitted       text,                         -- what was left out or replaced, and why
  culture_note  text,
  plan          text,                         -- staged 60-minute plan
  homework      text,                         -- instructions sent to the student
  teacher_notes text,                         -- private: key, error correction, timing
  status        text not null default 'outline' check (status in ('outline', 'drafting', 'ready')),
  updated_at    timestamptz not null default now(),
  unique (level_id, number)
);

create table public.cur_files (
  id          uuid primary key default gen_random_uuid(),
  lesson_id   uuid not null references public.cur_lessons (id) on delete cascade,
  kind        text not null default 'slides' check (kind in ('slides', 'handout', 'worksheet', 'homework', 'key', 'notes', 'audio', 'other')),
  title       text not null,
  for_student boolean not null default true,  -- false = teacher only (answer key, notes)
  file_path   text not null unique,           -- path inside the 'materials' bucket, under kits/
  file_name   text not null,
  mime        text,
  size_bytes  bigint,
  created_at  timestamptz not null default now()
);
create index cur_files_lesson_idx on public.cur_files (lesson_id);

create table public.cur_sources (
  id        uuid primary key default gen_random_uuid(),
  title     text not null,
  kind      text not null default 'other' check (kind in ('coursebook', 'teachers_book', 'workbook', 'standard', 'wordlist', 'website', 'other')),
  publisher text,
  url       text,
  used_for  text,
  checked   text not null default 'from_memory' check (checked in ('opened', 'purchased', 'from_memory')),
  checked_on date,
  licence   text,
  notes     text,
  position  int not null default 0
);

-- a live lesson can point to the curriculum lesson it teaches
alter table public.lessons add column cur_lesson_id uuid references public.cur_lessons (id) on delete set null;
-- a file sent to a student remembers which kit file it came from
alter table public.materials add column cur_file_id uuid references public.cur_files (id) on delete set null;
-- feedback checkpoints
alter table public.reports add column checkpoint text check (checkpoint in ('after_1', 'after_4', 'final'));

-- ------------------------------------------------------------- homework
create table public.assignments (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.students (id) on delete cascade,
  lesson_id     uuid references public.lessons (id) on delete set null,
  cur_lesson_id uuid references public.cur_lessons (id) on delete set null,
  title         text not null,
  instructions  text,
  due_on        date,
  status        text not null default 'assigned' check (status in ('assigned', 'submitted', 'reviewed')),
  sub_text      text,
  sub_path      text,
  sub_name      text,
  sub_mime      text,
  sub_size      bigint,
  submitted_at  timestamptz,
  feedback      text,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index assignments_student_idx on public.assignments (student_id, created_at desc);

-- a student can submit (or resubmit until it is reviewed); nothing else about the row
create or replace function public.submit_assignment(p_id uuid, p_text text, p_path text, p_name text, p_mime text, p_size bigint)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.assignments a
                  where a.id = p_id and a.student_id in (select public.my_student_ids())) then
    raise exception 'Homework not found';
  end if;
  if coalesce(trim(p_text), '') = '' and p_path is null then
    raise exception 'Write your answer or attach a file';
  end if;
  update public.assignments
     set sub_text = nullif(trim(p_text), ''),
         sub_path = p_path, sub_name = p_name, sub_mime = p_mime, sub_size = p_size,
         submitted_at = now(),
         status = 'submitted', feedback = null, reviewed_at = null
   where id = p_id;
end;
$$;
revoke all on function public.submit_assignment(uuid, text, text, text, text, bigint) from public, anon;
grant execute on function public.submit_assignment(uuid, text, text, text, text, bigint) to authenticated;

-- ------------------------------------------------------------- security
alter table public.cur_levels  enable row level security;
alter table public.cur_lessons enable row level security;
alter table public.cur_files   enable row level security;
alter table public.cur_sources enable row level security;
alter table public.assignments enable row level security;

create policy cur_levels_admin  on public.cur_levels  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy cur_lessons_admin on public.cur_lessons for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy cur_files_admin   on public.cur_files   for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy cur_sources_admin on public.cur_sources for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy assignments_admin on public.assignments for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy assignments_own_select on public.assignments
  for select to authenticated using (student_id in (select public.my_student_ids()));

revoke all on public.cur_levels, public.cur_lessons, public.cur_files, public.cur_sources, public.assignments from anon;
grant select, insert, update, delete on public.cur_levels, public.cur_lessons, public.cur_files, public.cur_sources, public.assignments to authenticated;

-- A student may upload a homework file only into their own folder: <student id>/submissions/...
create policy materials_files_student_submit on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'materials'
    and (storage.foldername(name))[1] in (select public.my_student_ids()::text)
    and (storage.foldername(name))[2] = 'submissions'
  );
create policy materials_files_student_read_submit on storage.objects
  for select to authenticated
  using (
    bucket_id = 'materials'
    and (storage.foldername(name))[1] in (select public.my_student_ids()::text)
    and (storage.foldername(name))[2] = 'submissions'
  );

-- ------------------------------------------------------------- seed: General English A1, three levels
insert into public.cur_levels (code, name, cefr, position, summary) values
  ('A1.1', 'Foundations',   'A1', 1, 'Introduce yourself and your family; basic personal information. Navigate units 1-3.'),
  ('A1.2', 'Daily life',    'A1', 2, 'Routines, questions, shopping, home and neighbourhood. Navigate units 4-6.'),
  ('A1.3', 'Doing things',  'A1', 3, 'Abilities, free time, simple past, plans and ordering. Navigate units 7, 8 and 10.');

insert into public.cur_lessons (level_id, number, title, objective, grammar, vocabulary, navigate_ref, omitted)
select l.id, v.n, v.title, v.obj, v.gram, v.vocab, v.nav, v.om
from public.cur_levels l
join (values
  ('A1.1', 1, 'Hello and introductions', 'Greet someone and say who you are.', 'I am / you are; my name is', 'Greetings, hello and goodbye, first names', '1.1, 1.4', 'Hotel registration context swapped for school and neighbourhood'),
  ('A1.1', 2, 'Countries, numbers and the alphabet', 'Spell your name, say a phone number and say where you are from.', 'we / you are; question words What, Where, How', 'Countries, numbers 1-10, alphabet', '1.2, 1.3', null),
  ('A1.1', 3, 'Things around me', 'Name things around you and ask what something is.', 'this / that, a / an, plurals, it / they', 'Everyday objects, numbers 11-100', '2.1', null),
  ('A1.1', 4, 'Jobs and people', 'Say what people do and talk about other people.', 'be with he / she / they; subject and object pronouns', 'Jobs', '2.2, 2.3, 8.3 (object pronouns moved here)', 'Object pronouns moved earlier from unit 8'),
  ('A1.1', 5, 'Describing with have got', 'Say what you and others have, and describe things.', 'have got (all forms), adjective + noun, irregular plurals', 'Adjectives, opposite adjectives', '3.1, 3.2', null),
  ('A1.1', 6, 'Family and possessions', 'Talk about your family and who things belong to.', 'my / your / his / her, possessive s', 'Family members', '3.3', null),
  ('A1.1', 7, 'Time and places', 'Tell the time, say where things are, and write a short message.', 'in / on / near; and / but', 'Telling the time, everyday expressions', '2.3 (places), 2.4, 3.4', null),
  ('A1.1', 8, 'Review: introduce yourself and your family', 'Introduce yourself and your family and answer simple questions.', 'Review of lessons 1-7', 'Review', 'Review 1-3', null),
  ('A1.2', 1, 'Present simple: I, you, we, they', 'Say what you do every day.', 'Present simple positive', 'Common verbs', '4.1', null),
  ('A1.2', 2, 'Present simple negatives and transport', 'Say what you do not do and how you travel.', 'Present simple negative, contractions', 'Transport', '4.2', null),
  ('A1.2', 3, 'Present simple questions and routines', 'Ask and answer questions about daily routines.', 'Do / does questions, short answers', 'Daily routine, days', '4.3', null),
  ('A1.2', 4, 'How often and free time', 'Say how often you do things.', 'Adverbs of frequency; and / but / because', 'Free time activities', '5.1', 'Present simple re-teach in 5.3 left out; body parts and very / really left out'),
  ('A1.2', 5, 'Wh- questions', 'Ask and answer questions with Who, What, Where, When and Why.', 'Wh- questions', 'Places and buildings', '5.2', 'Architecture examples replaced with local places'),
  ('A1.2', 6, 'Shopping, prices and clothes', 'Ask the price and buy something in a shop.', 'Prices, How much, adjectives for clothes', 'Shops, clothes, colours', '4.4, 5.1 (clothes)', 'Check dress and skin-colour content before use'),
  ('A1.2', 7, 'My home and neighbourhood', 'Describe your home and the places near it.', 'there is / there are, Is there / Are there', 'Rooms, furniture, places in a town', '6.1, 6.2, 6.3 (vocabulary)', 'Each / all the left out; hotel and Oktoberfest contexts replaced'),
  ('A1.2', 8, 'Review: your day and your home', 'Describe your day and your home.', 'Review of lessons 1-7', 'Review', 'Review 4-6', null),
  ('A1.3', 1, 'Can and can''t', 'Say what you can and cannot do.', 'can / can''t', 'Skills and abilities', '7.1', null),
  ('A1.3', 2, 'Requests and how well', 'Make simple requests and say how well you do things.', 'Can you ...?, adverbs of manner', 'Simple requests, adverbs', '7.2, 7.4', null),
  ('A1.3', 3, 'Likes and hobbies', 'Say what you like and do not like doing.', 'like / love / hate + -ing', 'Hobbies', '7.3', null),
  ('A1.3', 4, 'Past of be, dates and occasions', 'Say where you were and talk about special days.', 'was / were; dates', 'Dates, occasions such as Eid, weddings and graduation', '8.1, 8.4', 'Valentine''s Day examples replaced with local occasions'),
  ('A1.3', 5, 'Regular past simple', 'Say what you did yesterday and last week.', 'Past simple regular verbs; past time expressions', 'Regular past verbs, yesterday, last week', '8.2, 8.3 (time expressions)', 'Irregular past, past negatives and questions and ago (9.1-9.3) moved to A2; to be checked against the A2 books'),
  ('A1.3', 6, 'Future plans with going to', 'Talk about plans for the weekend and next week.', 'going to', 'Future time expressions, life events', '10.1, 10.2', 'Crowdfunding texts left out'),
  ('A1.3', 7, 'Ordering food and drink', 'Order food and drink politely.', 'would like', 'Cafe food and drink', '10.3, 10.4', null),
  ('A1.3', 8, 'Review: the A1 can-do check', 'Show the can-do statements of the whole A1 level.', 'Review of lessons 1-7', 'Review', 'Review 7-10', null)
) as v(code, n, title, obj, gram, vocab, nav, om) on v.code = l.code;

insert into public.cur_sources (title, kind, publisher, url, used_for, checked, checked_on, licence, notes, position) values
  ('Navigate A1 Beginner: Coursebook', 'coursebook', 'Oxford University Press', null, 'Main topic and grammar order; used to plan the division only', 'purchased', '2026-10-09', 'Purchased copy; do not copy content into CLEAR materials', 'Read in full on 9 Oct 2026: 10 units.', 1),
  ('Navigate A1 Beginner: Teacher''s Notes', 'teachers_book', 'Oxford University Press', null, 'Procedures and answers; staging ideas only', 'purchased', '2026-10-09', 'Purchased copy', 'Has no stage timings. Written for classes, so it needs changes for 1:1 online.', 2),
  ('Navigate A1 Beginner: Workbook with Key', 'workbook', 'Oxford University Press', null, 'Extra practice and homework ideas', 'purchased', '2026-10-09', 'Purchased copy', 'Mirrors the Coursebook.', 3),
  ('CEFR Companion Volume (2020)', 'standard', 'Council of Europe', 'https://rm.coe.int/16809ea0d4', 'A1 can-do descriptors', 'opened', '2026-10-08', 'Public document', 'Confirm it is the 2020 volume before quoting a descriptor.', 4),
  ('The CEFR Levels page', 'standard', 'Council of Europe', 'https://www.coe.int/en/web/common-european-framework-reference-languages/level-descriptions', 'Level names A1 to C2', 'opened', '2026-10-08', 'Public page', 'Does not list the A1 descriptors itself.', 5),
  ('English Profile (Vocabulary and Grammar Profile)', 'wordlist', 'Cambridge', 'https://englishprofile.org/', 'Check words and structures against A1', 'opened', '2026-10-08', 'Free tools; follow site terms', 'Homepage confirmed. Exact page paths still to check from the menu.', 6),
  ('Oxford 3000 word list', 'wordlist', 'Oxford University Press', 'https://www.oxfordlearnersdictionaries.com/', 'A1 vocabulary check', 'from_memory', null, 'Follow site terms', 'Not opened yet in this project.', 7),
  ('Global Scale of English', 'standard', 'Pearson', 'https://www.pearson.com/languages/about/gse.html', 'Learning objectives and scale', 'opened', '2026-10-08', 'Follow site terms', 'Overview page opened. Score range for A1 not confirmed.', 8),
  ('LearnEnglish A1 resources', 'website', 'British Council', 'https://learnenglish.britishcouncil.org/free-resources/listening/a1', 'Self-study links for students; ideas only', 'from_memory', null, 'Check terms before copying anything', 'Links read from the menu; content not opened.', 9);
