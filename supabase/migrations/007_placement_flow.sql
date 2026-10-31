-- CLEAR online placement test, flow v2.
-- Order: vocabulary+grammar -> reading -> listening -> speaking.
-- Inside each written section the server serves one band at a time, lowest first, and never shows the band.
-- If every question of A2 or B1 in a section is wrong, that section ends. Every block has a server-side clock.
-- Nothing here deletes anything.

alter table public.placement_leads    add column if not exists is_test boolean not null default false;
alter table public.placement_attempts add column if not exists is_test boolean not null default false;
alter table public.placement_responses add column if not exists time_ms int;

-- integrity log: leaving the page, leaving full screen, copy/paste. A flag for the reviewer, never an automatic fail.
create table public.placement_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.placement_attempts(id),
  kind text not null check (kind in ('fullscreen_enter','fullscreen_exit','fullscreen_unavailable','tab_hidden','tab_visible',
                                     'window_blur','window_focus','copy','paste','context_menu','resume')),
  section text,
  at timestamptz not null default now(),
  away_ms int,
  detail text
);
create index placement_events_attempt on public.placement_events(attempt_id, at);
alter table public.placement_events enable row level security;
create policy placement_events_sel on public.placement_events for select using (public.is_admin());
create policy placement_events_ins on public.placement_events for insert with check (public.is_admin());
create policy placement_events_upd on public.placement_events for update using (public.is_admin()) with check (public.is_admin());
create trigger placement_events_nodel   before delete   on public.placement_events for each row       execute function public.pl_no_delete();
create trigger placement_events_notrunc before truncate on public.placement_events for each statement execute function public.pl_no_delete();

-- settings (kept in the database so they can change without a rebuild)
update public.placement_thresholds set cfg = cfg || '{
  "vg_items_per_band": {"pre_a1":3,"a1_1":3,"a1_2":3,"a1_3":3,"a2":4,"b1":4,"b2":4},
  "vg_item_seconds":   {"pre_a1":20,"a1_1":20,"a1_2":20,"a1_3":20,"a2":30,"b1":30,"b2":30},
  "reading_seconds":   {"pre_a1":50,"a1_1":60,"a1_2":75,"a1_3":90,"a2":105,"b1":120,"b2":135},
  "listening_seconds": {"pre_a1":45,"a1_1":50,"a1_2":60,"a1_3":70,"a2":80,"b1":90,"b2":100},
  "stop_all_wrong_bands": ["a2","b1"],
  "grace_seconds": 8,
  "listen_plays": 2
}'::jsonb where id = 1;

-- ---------- internal helpers ----------
create or replace function public.pl_cfg() returns jsonb
language sql stable security definer set search_path = public as $$ select cfg from placement_thresholds where id = 1 $$;

create or replace function public.pl_sec(st int) returns text
language sql immutable as $$ select case st when 1 then 'vocab_grammar' when 2 then 'reading' when 3 then 'listening' else 'speaking' end $$;

create or replace function public.pl_served_ids(p jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(x.v), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p->'served', '[]'::jsonb)) b(v), jsonb_array_elements(b.v->'ids') x(v)
$$;

create or replace function public.pl_has_content(sec text, pre boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select case when sec = 'vocab_grammar' then
      exists (select 1 from placement_items where section = 'vocab_grammar' and status = any (case when pre then array['approved','draft'] else array['approved'] end))
    else
      exists (select 1 from placement_passages p where p.section = sec
                and p.status = any (case when pre then array['approved','draft'] else array['approved'] end)
                and (pre or sec = 'reading' or p.audio_path is not null)
                and exists (select 1 from placement_items i where i.passage_id = p.id
                              and i.status = any (case when pre then array['approved','draft'] else array['approved'] end)))
    end
$$;

-- scoring now reads every item that was actually served, in any section
create or replace function public.pl_score(p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a public.placement_attempts; v_cfg jsonb;
  hold_min numeric; below_min numeric; min_n int;
  i int; j int; n int; c int; ch numeric; adjs numeric[] := array_fill(null::numeric, array[7]);
  bands jsonb := '{}'::jsonb; secs jsonb := '{}'::jsonb; award int := 0; ok boolean; s record;
begin
  select * into a from placement_attempts where id = p_attempt;
  v_cfg := pl_cfg();
  hold_min := (v_cfg->>'hold_min')::numeric; below_min := (v_cfg->>'below_min')::numeric; min_n := (v_cfg->>'min_items')::int;

  for i in 0..6 loop
    with sv as (select jsonb_array_elements_text(pl_served_ids(a.paper))::uuid as item_id)
    select count(*), count(*) filter (where r.is_correct), coalesce(sum(1.0 / jsonb_array_length(it.options)), 0)
      into n, c, ch
      from sv
      join placement_items it on it.id = sv.item_id
      left join placement_responses r on r.attempt_id = a.id and r.item_id = it.id
      where it.band = pl_band_at(i);
    if n >= min_n then adjs[i + 1] := round(greatest(0, (c - ch) / (n - ch)) * 100, 1); end if;
    bands := bands || jsonb_build_object(pl_band_at(i), jsonb_build_object('n', n, 'correct', c, 'adjusted', adjs[i + 1]));
  end loop;

  for i in reverse 6..1 loop
    if adjs[i + 1] is not null and adjs[i + 1] >= hold_min then
      ok := true;
      for j in reverse (i - 1)..0 loop
        if adjs[j + 1] is not null then ok := adjs[j + 1] >= below_min; exit; end if;
      end loop;
      if ok then award := i; exit; end if;
    end if;
  end loop;

  for s in
    with sv as (select jsonb_array_elements_text(pl_served_ids(a.paper))::uuid as item_id)
    select it.section, count(*) as n, count(*) filter (where r.is_correct) as c
    from sv join placement_items it on it.id = sv.item_id
    left join placement_responses r on r.attempt_id = a.id and r.item_id = it.id
    group by it.section loop
    secs := secs || jsonb_build_object(s.section, jsonb_build_object('n', s.n, 'correct', s.c));
  end loop;

  return jsonb_build_object('bands', bands, 'sections', secs, 'band', pl_band_at(award));
end $$;

-- what the browser gets for the open block: no band, no answer key
create or replace function public.pl_block_payload(a public.placement_attempts, k int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare blk jsonb := a.paper->'served'->k; ps public.placement_passages; items jsonb; rem bigint;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', it.id, 'stem', it.stem, 'options', it.options) order by o.ord), '[]'::jsonb)
    into items
    from jsonb_array_elements_text(blk->'ids') with ordinality o(id, ord)
    join placement_items it on it.id = o.id::uuid;
  rem := greatest(0, (extract(epoch from ((blk->>'started_at')::timestamptz + make_interval(secs => (blk->>'t')::int) - now())) * 1000)::bigint);
  if blk->>'pid' is not null then select * into ps from placement_passages where id = (blk->>'pid')::uuid; end if;
  return jsonb_build_object('n', k, 'section', blk->>'sec', 'total_s', (blk->>'t')::int, 'per_s', blk->'per', 'remaining_ms', rem,
    'passage', case when ps.id is null then null else jsonb_build_object('title', ps.title, 'body', ps.body, 'audio_path', ps.audio_path,
        'tts', case when ps.audio_path is null and coalesce((a.paper->>'preview')::boolean, false) then ps.transcript end) end,
    'items', items);
end $$;

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
    'prompts', case when a.stage >= 4 then pl_prompts_payload(a.paper->'prompts') else '[]'::jsonb end);
end $$;

-- answers are accepted only for the open block and only until its clock (plus a few seconds' grace) runs out
create or replace function public.pl_answer(p_token uuid, p_answers jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; e jsonb; iid uuid; ch int; ms int; it public.placement_items; k int := 0; bi int; blk jsonb;
        grace int := (pl_cfg()->>'grace_seconds')::int;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.status = 'submitted' then raise exception 'already_submitted' using errcode = '22023'; end if;
  for e in select * from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) loop
    iid := (e->>'item')::uuid; ch := (e->>'choice')::int; ms := nullif(e->>'ms', '')::int;
    bi := null;
    select (b.ord - 1)::int into bi from jsonb_array_elements(coalesce(a.paper->'served', '[]'::jsonb)) with ordinality b(v, ord)
      where b.v->'ids' @> to_jsonb(iid::text) limit 1;
    if bi is null then continue; end if;
    blk := a.paper->'served'->bi;
    if coalesce((blk->>'closed')::boolean, false) then continue; end if;
    if now() > (blk->>'started_at')::timestamptz + make_interval(secs => (blk->>'t')::int + grace) then continue; end if;
    select * into it from placement_items where id = iid;
    if ch is null or ch < 0 or ch >= jsonb_array_length(it.options) then continue; end if;
    insert into placement_responses(attempt_id, item_id, item_version, chosen_index, is_correct, band, section, misconception, time_ms)
    values (a.id, iid, it.version, ch, ch = it.correct_index, it.band, it.section,
            case when ch <> it.correct_index then it.misconceptions->>ch end, ms)
    on conflict (attempt_id, item_id) do update
      set chosen_index = excluded.chosen_index, is_correct = excluded.is_correct,
          misconception = excluded.misconception, time_ms = excluded.time_ms, answered_at = now();
    k := k + 1;
  end loop;
  return k;
end $$;

-- close the open block; if it is A2/B1 and every answer was wrong, the section is over
create or replace function public.pl_close_open(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; k int; blk jsonb; n int; c int; np jsonb; v_cfg jsonb := pl_cfg();
begin
  select * into a from placement_attempts where id = p_id;
  k := coalesce(jsonb_array_length(a.paper->'served'), 0) - 1;
  if k < 0 then return; end if;
  blk := a.paper->'served'->k;
  if coalesce((blk->>'closed')::boolean, false) then return; end if;
  select count(*), count(*) filter (where r.is_correct) into n, c
    from jsonb_array_elements_text(blk->'ids') x(v)
    join placement_items it on it.id = x.v::uuid
    left join placement_responses r on r.attempt_id = a.id and r.item_id = it.id;
  blk := blk || jsonb_build_object('closed', true, 'n', n, 'c', c);
  np := jsonb_set(a.paper, array['served', k::text], blk);
  if c = 0 and n > 0 and (v_cfg->'stop_all_wrong_bands') @> to_jsonb(blk->>'band') then
    np := jsonb_set(np, '{stopped}', coalesce(np->'stopped', '{}'::jsonb) || jsonb_build_object(blk->>'sec', blk->>'band'));
  end if;
  update placement_attempts set paper = np where id = p_id;
end $$;

-- serve the next band that has content in the current section; false when the section is finished
create or replace function public.pl_draw(p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; v_cfg jsonb := pl_cfg(); sec text; pre boolean; sts text[]; lastb int; b int; fb int;
        ids jsonb; pid uuid; per int; tot int; cnt int; blk jsonb;
begin
  select * into a from placement_attempts where id = p_id;
  sec := pl_sec(a.stage);
  if a.stage < 1 or a.stage > 3 then return false; end if;
  pre := coalesce((a.paper->>'preview')::boolean, false);
  sts := case when pre then array['approved','draft'] else array['approved'] end;
  if (a.paper->'stopped'->>sec) is not null then return false; end if;
  select coalesce(max(pl_band_idx(x.v->>'band')), -1) into lastb
    from jsonb_array_elements(coalesce(a.paper->'served', '[]'::jsonb)) x(v) where x.v->>'sec' = sec;
  for b in (lastb + 1)..6 loop
    ids := null; pid := null; per := null; tot := null;
    if sec = 'vocab_grammar' then
      cnt := (v_cfg->'vg_items_per_band'->>pl_band_at(b))::int;
      select jsonb_agg(x.id) into ids from (
        select id from placement_items where section = 'vocab_grammar' and band = pl_band_at(b) and status = any (sts)
        order by random() limit cnt) x;
      if ids is not null then
        per := (v_cfg->'vg_item_seconds'->>pl_band_at(b))::int; tot := per * jsonb_array_length(ids);
      end if;
    else
      select p.id into pid from placement_passages p
        where p.section = sec and p.band = pl_band_at(b) and p.status = any (sts)
          and (pre or sec = 'reading' or p.audio_path is not null)
          and exists (select 1 from placement_items i where i.passage_id = p.id and i.status = any (sts))
        order by random() limit 1;
      if pid is not null then
        select jsonb_agg(q.id order by q.code) into ids from (
          select id, code from placement_items where passage_id = pid and status = any (sts) order by code limit 3) q;
        tot := (v_cfg->(case when sec = 'reading' then 'reading_seconds' else 'listening_seconds' end)->>pl_band_at(b))::int;
      end if;
    end if;
    if ids is not null then fb := b; exit; end if;
  end loop;
  if ids is null then return false; end if;
  blk := jsonb_build_object('sec', sec, 'band', pl_band_at(fb), 'ids', ids, 't', tot, 'per', per, 'pid', pid,
                            'started_at', now(), 'closed', false);
  update placement_attempts set paper = jsonb_set(paper, '{served}', coalesce(paper->'served', '[]'::jsonb) || jsonb_build_array(blk))
    where id = p_id;
  if not pre then
    update placement_items set times_served = times_served + 1 where id in (select jsonb_array_elements_text(ids)::uuid);
  end if;
  return true;
end $$;

-- score the written part and choose 4 speaking prompts for the written band
create or replace function public.pl_enter_speaking(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; sc jsonb; bi int; s int; pid uuid; prompts jsonb := '[]'::jsonb; pre boolean; sts text[];
begin
  select * into a from placement_attempts where id = p_id;
  if a.stage >= 4 then return; end if;
  pre := coalesce((a.paper->>'preview')::boolean, false);
  sts := case when pre then array['approved','draft'] else array['approved'] end;
  sc := pl_score(p_id);
  bi := pl_band_idx(sc->>'band');
  for s in 1..4 loop
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

-- move to the next section that has content (sets the instructions page), or on to speaking
create or replace function public.pl_enter_next(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; st int; pre boolean;
begin
  select * into a from placement_attempts where id = p_id;
  pre := coalesce((a.paper->>'preview')::boolean, false);
  st := a.stage;
  loop
    st := st + 1;
    if st >= 4 then perform pl_enter_speaking(p_id); return; end if;
    if pl_has_content(pl_sec(st), pre) then
      update placement_attempts set stage = st, paper = paper || '{"waiting_intro": true}'::jsonb where id = p_id;
      return;
    end if;
  end loop;
end $$;

-- ---------- public API ----------
create or replace function public.pl_start(p_lead uuid, p_agent text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l public.placement_leads; a public.placement_attempts; v_cfg jsonb := pl_cfg();
begin
  select * into l from placement_leads where id = p_lead;
  if not found then raise exception 'lead_not_found' using errcode = '22023'; end if;
  if l.path <> 'online' or l.consent_at is null or l.consent_withdrawn_at is not null then
    raise exception 'not_allowed' using errcode = '22023'; end if;
  select * into a from placement_attempts where lead_id = p_lead and status in ('in_progress','reopened')
    order by started_at desc limit 1;
  if found then return pl_state(a.token); end if;
  if exists (select 1 from placement_attempts x join placement_leads y on y.id = x.lead_id
             where y.phone = l.phone and x.status = 'submitted' and not x.is_test
               and x.finished_at > now() - make_interval(days => (v_cfg->>'cooldown_days')::int)) then
    raise exception 'already_done' using errcode = '22023';
  end if;
  insert into placement_attempts(lead_id, stage, paper, user_agent, is_test)
    values (p_lead, 0, '{"served": [], "stopped": {}, "skips": []}'::jsonb, left(p_agent, 300), l.is_test)
    returning * into a;
  perform pl_enter_next(a.id);
  update placement_leads set status = 'test_started', updated_at = now() where id = p_lead and status in ('new');
  return pl_state(a.token);
end $$;

-- the "Start" button on an instructions page, and "Next" after a block
create or replace function public.pl_next(p_token uuid, p_answers jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.status = 'submitted' then return pl_state(p_token); end if;
  if p_answers is not null and a.stage < 4 then perform pl_answer(p_token, p_answers); end if;
  if coalesce((a.paper->>'waiting_intro')::boolean, false) then
    update placement_attempts set paper = paper || '{"waiting_intro": false}'::jsonb where id = a.id;
    if a.stage >= 4 then return pl_state(p_token); end if;
  else
    if a.stage >= 4 then return pl_state(p_token); end if;
    perform pl_close_open(a.id);
  end if;
  if not pl_draw(a.id) then perform pl_enter_next(a.id); end if;
  return pl_state(p_token);
end $$;

-- "I'm stuck": end this section (scope 'section') or the whole written part (scope 'written')
create or replace function public.pl_skip(p_token uuid, p_answers jsonb, p_scope text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.status = 'submitted' then return pl_state(p_token); end if;
  if a.stage < 4 then
    if p_answers is not null then perform pl_answer(p_token, p_answers); end if;
    perform pl_close_open(a.id);
    update placement_attempts set paper = jsonb_set(paper, '{skips}',
      coalesce(paper->'skips', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('sec', pl_sec(a.stage), 'scope', p_scope, 'at', now())))
      where id = a.id;
    if p_scope = 'written' then perform pl_enter_speaking(a.id); else perform pl_enter_next(a.id); end if;
  end if;
  return pl_state(p_token);
end $$;

create or replace function public.pl_event(p_token uuid, p_events jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; e jsonb; n int := 0;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if (select count(*) from placement_events where attempt_id = a.id) > 3000 then return; end if;
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    n := n + 1; exit when n > 50;
    begin
      insert into placement_events(attempt_id, kind, section, at, away_ms, detail)
      values (a.id, e->>'kind', left(e->>'section', 30),
              least(coalesce(nullif(e->>'at', '')::timestamptz, now()), now()),
              nullif(e->>'away_ms', '')::int, left(e->>'detail', 120));
    exception when others then null;
    end;
  end loop;
end $$;

create or replace function public.pl_record(p_token uuid, p_prompt uuid, p_slot int, p_path text, p_mime text, p_has_video boolean, p_duration_ms int)
returns void language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.status = 'submitted' or a.stage < 4 then raise exception 'not_allowed' using errcode = '22023'; end if;
  if p_path not like p_token::text || '/%' then raise exception 'bad_path' using errcode = '22023'; end if;
  insert into placement_recordings(attempt_id, prompt_id, slot, storage_path, mime, has_video, duration_ms)
  values (a.id, p_prompt, p_slot, p_path, p_mime, coalesce(p_has_video, false), p_duration_ms)
  on conflict (storage_path) do nothing;
end $$;

create or replace function public.pl_complete(p_token uuid, p_camera boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.stage < 4 then perform pl_close_open(a.id); perform pl_enter_speaking(a.id); end if;
  update placement_attempts set status = 'submitted', finished_at = now(), camera_on = p_camera where id = a.id;
  update placement_leads set status = 'test_completed', updated_at = now()
    where id = a.lead_id and status in ('new','test_started');
  return jsonb_build_object('ok', true);
end $$;

-- staff: take the test yourself on draft + approved content; kept apart from real data
create or replace function public.pl_preview() returns uuid
language plpgsql security definer set search_path = public as $$
declare lid uuid; a public.placement_attempts;
begin
  if not public.is_admin() then raise exception 'not_allowed' using errcode = '42501'; end if;
  insert into placement_leads(full_name, phone, path, consent_at, consent_version, is_test, status)
    values ('Staff preview', '+201000000000', 'online', now(), 'staff', true, 'test_started') returning id into lid;
  insert into placement_attempts(lead_id, stage, paper, is_test)
    values (lid, 0, '{"preview": true, "served": [], "stopped": {}, "skips": []}'::jsonb, true) returning * into a;
  perform pl_enter_next(a.id);
  return a.token;
end $$;

drop function if exists public.pl_advance(uuid);
drop function if exists public.pl_finish_written(uuid);

-- ---------- who may call what ----------
revoke execute on function public.pl_cfg(), public.pl_sec(int), public.pl_served_ids(jsonb), public.pl_has_content(text, boolean),
  public.pl_block_payload(public.placement_attempts, int), public.pl_close_open(uuid), public.pl_draw(uuid),
  public.pl_enter_speaking(uuid), public.pl_enter_next(uuid) from public, anon, authenticated;
revoke execute on function public.pl_next(uuid, jsonb), public.pl_skip(uuid, jsonb, text), public.pl_event(uuid, jsonb),
  public.pl_preview() from public, anon, authenticated;
grant execute on function public.pl_next(uuid, jsonb), public.pl_skip(uuid, jsonb, text), public.pl_event(uuid, jsonb) to anon, authenticated;
grant execute on function public.pl_preview() to authenticated;
-- re-assert the replaced ones (create or replace keeps grants, but be explicit)
revoke execute on function public.pl_score(uuid) from public, anon, authenticated;
