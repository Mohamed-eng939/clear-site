-- IELTS programs: General Training and Academic (8 two-hour lessons per level).
alter table public.students drop constraint if exists students_program_check;
alter table public.students add constraint students_program_check
  check (program in ('general', 'business', 'conversation', 'esp', 'ielts_general', 'ielts_academic'));

alter table public.packages drop constraint if exists packages_program_check;
alter table public.packages add constraint packages_program_check
  check (program in ('general', 'business', 'conversation', 'esp', 'ielts_general', 'ielts_academic'));
