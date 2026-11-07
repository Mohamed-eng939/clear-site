-- Staff can let one person retake before the cooldown ends. The flag is used up when the new attempt starts.
alter table public.placement_leads add column if not exists retake_allowed boolean not null default false;

create or replace function public.pl_start(p_lead uuid, p_agent text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.placement_leads; a public.placement_attempts; v_cfg jsonb := pl_cfg();
begin
  select * into l from placement_leads where id = p_lead;
  if not found then raise exception 'lead_not_found' using errcode = '22023'; end if;
  if l.path <> 'online' or l.consent_at is null or l.consent_withdrawn_at is not null then
    raise exception 'not_allowed' using errcode = '22023'; end if;
  select * into a from placement_attempts where lead_id = p_lead and status in ('in_progress','reopened')
    order by started_at desc limit 1;
  if found then return pl_state(a.token); end if;
  if not l.retake_allowed and exists (select 1 from placement_attempts x join placement_leads y on y.id = x.lead_id
             where y.phone = l.phone and x.status = 'submitted' and not x.is_test
               and x.finished_at > now() - make_interval(days => (v_cfg->>'cooldown_days')::int)) then
    raise exception 'already_done' using errcode = '22023';
  end if;
  insert into placement_attempts(lead_id, stage, paper, user_agent, is_test)
    values (p_lead, 0, '{"served": [], "stopped": {}, "skips": []}'::jsonb, left(p_agent, 300), l.is_test)
    returning * into a;
  perform pl_enter_next(a.id);
  update placement_leads set status = case when status = 'new' then 'test_started' else status end,
                             retake_allowed = false, updated_at = now() where id = p_lead;
  return pl_state(a.token);
end $$;
revoke execute on function public.pl_start(uuid, text) from public;
grant execute on function public.pl_start(uuid, text) to anon, authenticated;
