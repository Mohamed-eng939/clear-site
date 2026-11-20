-- 021: the Books library was removed (not needed). It never held any data.
drop policy if exists library_files_admin on storage.objects;
drop table if exists public.library_books;
