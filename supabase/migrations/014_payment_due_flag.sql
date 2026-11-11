alter table public.students add column if not exists payment_due boolean not null default false;
alter table public.students add column if not exists payment_due_note text;
-- Dina Nady: new level A1.2 unpaid
update public.students set payment_due = true, payment_due_note = 'A1.2' where full_name ilike 'Dina Nady%';
