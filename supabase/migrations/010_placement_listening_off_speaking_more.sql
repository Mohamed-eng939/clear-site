-- Listening is paused: its content stays as draft, but it is never served to test takers (cfg listening_enabled=false).
-- The time that listening used (about 8 minutes) goes to speaking: 6 tasks instead of 4.
-- Nothing here deletes anything.

alter table public.placement_prompts   drop constraint placement_prompts_slot_check;
alter table public.placement_prompts   add  constraint placement_prompts_slot_check check (slot >= 1 and slot <= 6);
alter table public.placement_recordings drop constraint placement_recordings_slot_check;
alter table public.placement_recordings add  constraint placement_recordings_slot_check check (slot >= 1 and slot <= 6);

update public.placement_thresholds set cfg = cfg || '{"listening_enabled": false, "speaking_tasks": 6}'::jsonb where id = 1;

-- listening has no servable content while it is switched off (also in staff preview)
create or replace function public.pl_has_content(sec text, pre boolean) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when sec = 'listening' and not coalesce((select (cfg->>'listening_enabled')::boolean from placement_thresholds where id = 1), true) then false
    when sec = 'vocab_grammar' then
      exists (select 1 from placement_items where section = 'vocab_grammar' and status = any (case when pre then array['approved','draft'] else array['approved'] end))
    else
      exists (select 1 from placement_passages p where p.section = sec
                and p.status = any (case when pre then array['approved','draft'] else array['approved'] end)
                and (pre or sec = 'reading' or p.audio_path is not null)
                and exists (select 1 from placement_items i where i.passage_id = p.id
                              and i.status = any (case when pre then array['approved','draft'] else array['approved'] end)))
    end
$$;

-- choose speaking_tasks prompts (one per slot) for the written band
create or replace function public.pl_enter_speaking(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.placement_attempts; sc jsonb; bi int; s int; pid uuid; prompts jsonb := '[]'::jsonb; pre boolean; sts text[];
        n int := coalesce((pl_cfg()->>'speaking_tasks')::int, 4);
begin
  select * into a from placement_attempts where id = p_id;
  if a.stage >= 4 then return; end if;
  pre := coalesce((a.paper->>'preview')::boolean, false);
  sts := case when pre then array['approved','draft'] else array['approved'] end;
  sc := pl_score(p_id);
  bi := pl_band_idx(sc->>'band');
  for s in 1..n loop
    select id into pid from placement_prompts
      where status = any (sts) and slot = s and pl_band_idx(band_from) <= bi and pl_band_idx(band_to) >= bi
      order by random() limit 1;
    if pid is null then select id into pid from placement_prompts where status = any (sts) and slot = s order by random() limit 1; end if;
    if pid is not null then prompts := prompts || to_jsonb(pid::text); end if;
    pid := null;
  end loop;
  if not pre then
    update placement_items it set times_correct = it.times_correct + 1
      from placement_responses r where r.attempt_id = p_id and r.item_id = it.id and r.is_correct;
  end if;
  update placement_attempts set stage = 4, scores = sc, band_written = sc->>'band',
      paper = a.paper || jsonb_build_object('prompts', prompts, 'waiting_intro', true) where id = p_id;
end $$;

-- pl_state also tells the page how many sections there are, so the labels read "Section 2 of 3"
create or replace function public.pl_state(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.placement_attempts; k int; blk jsonb; answered jsonb := '{}'::jsonb; v_cfg jsonb := pl_cfg();
        lis boolean := coalesce((v_cfg->>'listening_enabled')::boolean, true);
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
    'total_sections', case when lis then 4 else 3 end,
    'speak_n', coalesce((v_cfg->>'speaking_tasks')::int, 4),
    'prompts', case when a.stage >= 4 then pl_prompts_payload(a.paper->'prompts') else '[]'::jsonb end);
end $$;

-- more speaking tasks for slots 5 and 6 (drafts; you approve them in the admin app)
insert into public.placement_prompts (code, slot, band_from, band_to, text, prep_seconds, max_seconds, status) values
 ('SP-5-01',5,'pre_a1','a1_3','Look around you. Tell us three things you can see. What colour are they?',10,60,'draft'),
 ('SP-5-02',5,'pre_a1','a1_3','Tell us about your city or town. Is it big or small? What can you do there?',10,60,'draft'),
 ('SP-5-03',5,'a1_2','a2','Tell us about your last holiday or a trip you remember. Where did you go?',10,60,'draft'),
 ('SP-5-04',5,'a2','b2','Describe a place you like to visit. Where is it, and why do you like it?',10,90,'draft'),
 ('SP-5-05',5,'b1','b2','Talk about something new you learned recently. How did you learn it, and why was it useful?',10,90,'draft'),
 ('SP-6-01',6,'pre_a1','a1_3','What is your favourite season? Tell us why you like it.',10,60,'draft'),
 ('SP-6-02',6,'a1_1','a2','What do you usually have for breakfast, lunch and dinner? Tell us about your meals.',10,60,'draft'),
 ('SP-6-03',6,'a2','b1','Which is better for you: studying in the morning or at night? Give your reasons.',10,90,'draft'),
 ('SP-6-04',6,'b1','b2','Some people say that social media makes life easier. Do you agree? Explain your opinion with examples.',10,90,'draft'),
 ('SP-6-05',6,'b1','b2','Imagine you could change one thing about your city. What would it be, and why?',10,90,'draft');

revoke execute on function public.pl_has_content(text, boolean), public.pl_enter_speaking(uuid) from public, anon, authenticated;
