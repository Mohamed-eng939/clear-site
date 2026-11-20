-- 020: let the teacher watch a student's answer sheet fill in live (Supabase Realtime; RLS still applies).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mock_sheets') then
    alter publication supabase_realtime add table public.mock_sheets;
  end if;
end $$;
