-- Payments: InstaPay details for price messages, and when/where the USD to EGP rate came from.
alter table public.settings
  add column if not exists instapay        text,
  add column if not exists rate_updated_at timestamptz,
  add column if not exists rate_source     text;
