-- 023: allow "B1+" as a level on students and reports.
alter table public.students drop constraint students_cefr_check;
alter table public.students add constraint students_cefr_check check (cefr = any (array['A1','A2','B1','B1+','B2','C1','C2']));
alter table public.reports drop constraint reports_cefr_check;
alter table public.reports add constraint reports_cefr_check check (cefr = any (array['A1','A2','B1','B1+','B2','C1','C2']));
