-- pl_state also says which speaking slots already have a recording (so a reload resumes correctly)
create or replace function public.pl_state(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; k int; blk jsonb; answered jsonb := '{}'::jsonb; v_cfg jsonb := pl_cfg();
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.status = 'submitted' then
    return jsonb_build_object('token', a.token, 'status', a.status, 'stage', a.stage, 'section', pl_sec(a.stage),
      'intro', false, 'block', null, 'answered', '{}'::jsonb, 'prompts', '[]'::jsonb);
  end if;
  k := coalesce(jsonb_array_length(a.paper->'served'), 0) - 1;
  if k >= 0 and not coalesce((a.paper->'served'->k->>'closed')::boolean, false) and a.stage < 4 then
    blk := pl_block_payload(a, k);
    select coalesce(jsonb_object_agg(r.item_id, r.chosen_index), '{}'::jsonb) into answered
      from placement_responses r
      where r.attempt_id = a.id and r.item_id in (select jsonb_array_elements_text(a.paper->'served'->k->'ids')::uuid);
  end if;
  return jsonb_build_object('token', a.token, 'status', a.status, 'stage', a.stage, 'section', pl_sec(a.stage),
    'intro', coalesce((a.paper->>'waiting_intro')::boolean, false), 'block', blk, 'answered', answered,
    'preview', coalesce((a.paper->>'preview')::boolean, false),
    'plays', (v_cfg->>'listen_plays')::int,
    'recorded', coalesce((select jsonb_agg(distinct slot) from placement_recordings where attempt_id = a.id), '[]'::jsonb),
    'prompts', case when a.stage >= 4 then pl_prompts_payload(a.paper->'prompts') else '[]'::jsonb end);
end $$;
