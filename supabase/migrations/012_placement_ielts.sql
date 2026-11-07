-- The online placement signup and the feedback form accept the two IELTS programs too.
alter table public.placement_leads drop constraint if exists placement_leads_program_check;
alter table public.placement_leads add constraint placement_leads_program_check
  check (program is null or program in ('general', 'business', 'conversation', 'esp', 'ielts_general', 'ielts_academic'));

alter table public.placement_feedback drop constraint if exists placement_feedback_recommended_program_check;
alter table public.placement_feedback add constraint placement_feedback_recommended_program_check
  check (recommended_program is null or recommended_program in ('general', 'business', 'conversation', 'esp', 'ielts_general', 'ielts_academic'));
