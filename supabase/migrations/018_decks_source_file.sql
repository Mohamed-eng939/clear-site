alter table public.decks add column if not exists source_file_id uuid references public.cur_files(id) on delete set null;
create unique index if not exists decks_source_file_uq on public.decks(source_file_id) where source_file_id is not null;
