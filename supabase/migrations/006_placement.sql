-- 006_placement.sql: online placement test, pre-A1 to B2.
-- Rules baked into the database:
--   * Nothing here is ever deleted (rows, or the whole table). Items are retired, not removed.
--   * The public (anonymous) side has no table access at all. It can only call the pl_* functions below,
--     each of which checks the attempt token. Answer keys never leave the database.
--   * Staff (is_admin) can read and edit everything, but not delete.
-- Bands, lowest to highest: pre_a1, a1_1, a1_2, a1_3, a2, b1, b2. Above b2 is a custom path.

create or replace function public.pl_band_idx(b text) returns int
language sql immutable set search_path = public as
$$ select array_position(array['pre_a1','a1_1','a1_2','a1_3','a2','b1','b2'], b) - 1 $$;

create or replace function public.pl_band_at(i int) returns text
language sql immutable set search_path = public as
$$ select (array['pre_a1','a1_1','a1_2','a1_3','a2','b1','b2'])[i + 1] $$;

create or replace function public.pl_no_delete() returns trigger
language plpgsql set search_path = public as
$$ begin raise exception 'Placement records are never deleted. Retire the item or mark the row instead.' using errcode = '42501'; end $$;

-- ---------- leads: everyone who fills the website form, meeting or online ----------
create table public.placement_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  full_name text not null check (length(trim(full_name)) >= 2),
  phone text not null check (phone ~ '^\+?[0-9]{7,16}$'),           -- WhatsApp number, mandatory
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  country text, goal text, availability text,
  program text check (program is null or program in ('general','business','conversation','esp')),
  package_levels int check (package_levels is null or package_levels between 1 and 3),
  path text not null check (path in ('meeting','online')),
  src text,                                                          -- which video / post sent them
  status text not null default 'new' check (status in
    ('new','test_started','test_completed','speaking_reviewed','report_sent','contacted','booked','enrolled','lost')),
  consent_at timestamptz,                                            -- recordings stored, reviewed, used to improve scoring
  consent_version text,
  consent_withdrawn_at timestamptz,                                  -- if set: exclude from training and hide, never erase
  student_id uuid references public.students(id) on delete set null,
  admin_note text
);

-- ---------- bank ----------
create table public.placement_passages (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  section text not null check (section in ('reading','listening')),
  band text not null check (band in ('pre_a1','a1_1','a1_2','a1_3','a2','b1','b2')),
  title text, body text, audio_path text, transcript text,
  status text not null default 'draft' check (status in ('draft','approved','retired')),
  version int not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.placement_items (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  section text not null check (section in ('vocab_grammar','reading','listening')),
  band text not null check (band in ('pre_a1','a1_1','a1_2','a1_3','a2','b1','b2')),
  passage_id uuid references public.placement_passages(id),
  stem text not null,
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 4),
  correct_index int not null check (correct_index >= 0),
  misconceptions jsonb,                       -- array aligned with options; null for the correct one
  routing boolean not null default false,     -- may be used in the short first stage
  tags text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft','approved','retired')),
  version int not null default 1,
  times_served int not null default 0,
  times_correct int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (correct_index < jsonb_array_length(options))
);

create table public.placement_prompts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  slot int not null check (slot between 1 and 4),
  band_from text not null check (band_from in ('pre_a1','a1_1','a1_2','a1_3','a2','b1','b2')),
  band_to text not null check (band_to in ('pre_a1','a1_1','a1_2','a1_3','a2','b1','b2')),
  text text not null,
  prep_seconds int not null default 10,
  max_seconds int not null default 60,
  status text not null default 'draft' check (status in ('draft','approved','retired')),
  version int not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- every edit keeps the previous version
create table public.placement_versions (
  id uuid primary key default gen_random_uuid(),
  entity text not null, entity_id uuid not null, version int not null,
  snapshot jsonb not null, saved_at timestamptz not null default now(), saved_by uuid default auth.uid()
);

create or replace function public.pl_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
declare skip text[] := array['times_served','times_correct','updated_at','version'];
begin
  if (to_jsonb(old) - skip) is distinct from (to_jsonb(new) - skip) then
    insert into placement_versions(entity, entity_id, version, snapshot) values (tg_table_name, old.id, old.version, to_jsonb(old));
    new.version := old.version + 1;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger placement_items_snap    before update on public.placement_items    for each row execute function public.pl_snapshot();
create trigger placement_passages_snap before update on public.placement_passages for each row execute function public.pl_snapshot();
create trigger placement_prompts_snap  before update on public.placement_prompts  for each row execute function public.pl_snapshot();

-- ---------- attempts ----------
create table public.placement_attempts (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),     -- the secret the test-taker's browser holds
  lead_id uuid not null references public.placement_leads(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'in_progress' check (status in ('in_progress','submitted','reopened')),
  stage int not null default 1,                              -- 1 routing, 2 main, 3 speaking
  est_band text,
  paper jsonb not null default '{}'::jsonb,                  -- {route:[ids], main:[ids], prompts:[ids]}
  camera_on boolean,
  scores jsonb, band_written text,
  submitted_by_mistake boolean not null default false,
  reopened_count int not null default 0,
  user_agent text
);

create table public.placement_responses (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.placement_attempts(id),
  item_id uuid not null references public.placement_items(id),
  item_version int not null,
  chosen_index int not null,
  is_correct boolean not null,
  band text not null, section text not null,
  misconception text,
  answered_at timestamptz not null default now(),
  unique (attempt_id, item_id)
);

create table public.placement_recordings (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.placement_attempts(id),
  prompt_id uuid references public.placement_prompts(id),
  slot int not null check (slot between 1 and 4),
  storage_path text not null unique,
  mime text, has_video boolean not null default false, duration_ms int,
  created_at timestamptz not null default now()
);

-- ---------- feedback by staff; the scores are the labels a speaking-scoring model will learn from ----------
create table public.placement_feedback (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.placement_attempts(id),
  reviewer uuid default auth.uid(),
  status text not null default 'draft' check (status in ('draft','final')),
  comments text,
  recommended_band text check (recommended_band is null or recommended_band in ('pre_a1','a1_1','a1_2','a1_3','a2','b1','b2','custom')),
  recommended_program text check (recommended_program is null or recommended_program in ('general','business','conversation','esp')),
  next_step text,
  report_id uuid references public.reports(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.placement_feedback_scores (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.placement_feedback(id),
  recording_id uuid not null references public.placement_recordings(id),
  criterion text not null check (criterion in ('fluency','accuracy','pronunciation','range')),
  score int not null check (score between 0 and 5),
  unique (feedback_id, recording_id, criterion)
);

create table public.placement_help_requests (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid references public.placement_attempts(id),
  lead_id uuid references public.placement_leads(id),
  kind text not null check (kind in ('whatsapp','callback','submitted_by_mistake','other')),
  section text, note text,
  handled boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.placement_thresholds (
  id int primary key check (id = 1),
  cfg jsonb not null
);
insert into public.placement_thresholds values (1, '{
  "hold_min": 50, "below_min": 60, "min_items": 3,
  "est_cum_ratio": 0.6, "vg_items": 14, "reading_passages": 2, "listening_passages": 2,
  "max_leads_per_phone_per_day": 6, "cooldown_days": 30
}'::jsonb);

-- ---------- security: staff read/insert/update, nobody deletes ----------
do $$
declare t text;
begin
  foreach t in array array['placement_leads','placement_passages','placement_items','placement_versions','placement_prompts',
    'placement_attempts','placement_responses','placement_recordings','placement_feedback','placement_feedback_scores',
    'placement_help_requests','placement_thresholds'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select using (public.is_admin())', t || '_sel', t);
    execute format('create policy %I on public.%I for insert with check (public.is_admin())', t || '_ins', t);
    execute format('create policy %I on public.%I for update using (public.is_admin()) with check (public.is_admin())', t || '_upd', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.pl_no_delete()', t || '_nodel', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.pl_no_delete()', t || '_notrunc', t);
  end loop;
end $$;

-- ---------- scoring ----------
-- Per band: raw correct, minus what guessing would give, as a percentage of what is above guessing.
-- Unanswered items count as wrong. A band needs min_items served to count; otherwise it is "unknown".
-- The band is awarded walking down from the top; a band is held only if the nearest known band below it is also solid.
create or replace function public.pl_score(p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a public.placement_attempts; v_cfg jsonb;
  hold_min numeric; below_min numeric; min_n int;
  i int; j int; n int; c int; ch numeric; adjs numeric[] := array_fill(null::numeric, array[7]);
  bands jsonb := '{}'::jsonb; secs jsonb := '{}'::jsonb; award int := 0; ok boolean; s record;
begin
  select * into a from placement_attempts where id = p_attempt;
  select t.cfg into v_cfg from placement_thresholds t where t.id = 1;
  hold_min := (v_cfg->>'hold_min')::numeric; below_min := (v_cfg->>'below_min')::numeric; min_n := (v_cfg->>'min_items')::int;

  for i in 0..6 loop
    with sv as (select jsonb_array_elements_text(coalesce(a.paper->'route','[]'::jsonb) || coalesce(a.paper->'main','[]'::jsonb))::uuid as item_id)
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
    with sv as (select jsonb_array_elements_text(coalesce(a.paper->'route','[]'::jsonb) || coalesce(a.paper->'main','[]'::jsonb))::uuid as item_id)
    select it.section, count(*) as n, count(*) filter (where r.is_correct) as c
    from sv join placement_items it on it.id = sv.item_id
    left join placement_responses r on r.attempt_id = a.id and r.item_id = it.id
    group by it.section loop
    secs := secs || jsonb_build_object(s.section, jsonb_build_object('n', s.n, 'correct', s.c));
  end loop;

  return jsonb_build_object('bands', bands, 'sections', secs, 'band', pl_band_at(award));
end $$;

-- ---------- public API (token-checked) ----------
create or replace function public.pl_items_payload(p_ids jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', it.id, 'section', it.section, 'stem', it.stem, 'options', it.options,
      'passage', case when ps.id is null then null else
        jsonb_build_object('id', ps.id, 'title', ps.title, 'body', ps.body, 'audio_path', ps.audio_path) end
    ) order by o.ord), '[]'::jsonb)
  from jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)) with ordinality as o(id, ord)
  join placement_items it on it.id = o.id::uuid
  left join placement_passages ps on ps.id = it.passage_id
$$;

create or replace function public.pl_prompts_payload(p_ids jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'slot', p.slot, 'text', p.text,
      'prep_seconds', p.prep_seconds, 'max_seconds', p.max_seconds) order by p.slot), '[]'::jsonb)
  from placement_prompts p where p.id::text in (select jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)))
$$;

create or replace function public.pl_state(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; items jsonb := '[]'::jsonb; answered jsonb;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.status = 'submitted' then
    return jsonb_build_object('token', a.token, 'status', a.status, 'stage', a.stage, 'items', '[]'::jsonb, 'answered', '{}'::jsonb, 'prompts', '[]'::jsonb);
  end if;
  if a.stage = 1 then items := pl_items_payload(a.paper->'route');
  elsif a.stage = 2 then items := pl_items_payload(a.paper->'main'); end if;
  select coalesce(jsonb_object_agg(item_id, chosen_index), '{}'::jsonb) into answered from placement_responses where attempt_id = a.id;
  return jsonb_build_object('token', a.token, 'status', a.status, 'stage', a.stage, 'items', items, 'answered', answered,
    'prompts', case when a.stage >= 3 then pl_prompts_payload(a.paper->'prompts') else '[]'::jsonb end);
end $$;

create or replace function public.pl_register(
  p_name text, p_phone text, p_email text, p_country text, p_goal text, p_availability text,
  p_program text, p_levels int, p_path text, p_src text, p_consent boolean, p_consent_version text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare ph text; v_cfg jsonb; lid uuid;
begin
  ph := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  if ph like '00%' then ph := '+' || substr(ph, 3); end if;
  if ph !~ '^\+?[0-9]{7,16}$' then raise exception 'bad_phone' using errcode = '22023'; end if;
  if p_path not in ('meeting','online') then raise exception 'bad_path' using errcode = '22023'; end if;
  if p_path = 'online' and not coalesce(p_consent, false) then raise exception 'consent_required' using errcode = '22023'; end if;
  select t.cfg into v_cfg from placement_thresholds t where t.id = 1;
  if (select count(*) from placement_leads where phone = ph and created_at > now() - interval '1 day')
       >= (v_cfg->>'max_leads_per_phone_per_day')::int then
    raise exception 'too_many' using errcode = '22023';
  end if;
  insert into placement_leads(full_name, phone, email, country, goal, availability, program, package_levels, path, src,
                              consent_at, consent_version)
  values (trim(p_name), ph, nullif(trim(coalesce(p_email, '')), ''), nullif(trim(coalesce(p_country, '')), ''),
          nullif(trim(coalesce(p_goal, '')), ''), nullif(trim(coalesce(p_availability, '')), ''),
          nullif(p_program, ''), p_levels, p_path, left(nullif(trim(coalesce(p_src, '')), ''), 80),
          case when coalesce(p_consent, false) then now() end, p_consent_version)
  returning id into lid;
  return jsonb_build_object('lead_id', lid);
end $$;

create or replace function public.pl_start(p_lead uuid, p_agent text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l public.placement_leads; a public.placement_attempts; v_cfg jsonb; route jsonb := '[]'::jsonb;
        cnt int[] := array[1,1,1,2,1,1,1]; b int;
begin
  select * into l from placement_leads where id = p_lead;
  if not found then raise exception 'lead_not_found' using errcode = '22023'; end if;
  if l.path <> 'online' or l.consent_at is null or l.consent_withdrawn_at is not null then
    raise exception 'not_allowed' using errcode = '22023'; end if;
  select * into a from placement_attempts where lead_id = p_lead and status in ('in_progress','reopened')
    order by started_at desc limit 1;
  if found then return pl_state(a.token); end if;
  select t.cfg into v_cfg from placement_thresholds t where t.id = 1;
  if exists (select 1 from placement_attempts x join placement_leads y on y.id = x.lead_id
             where y.phone = l.phone and x.status = 'submitted'
               and x.finished_at > now() - make_interval(days => (v_cfg->>'cooldown_days')::int)) then
    raise exception 'already_done' using errcode = '22023';
  end if;
  for b in 0..6 loop
    route := route || coalesce((select jsonb_agg(x.id) from (
        select id from placement_items
        where status = 'approved' and section = 'vocab_grammar' and band = pl_band_at(b)
        order by routing desc, random() limit cnt[b + 1]) x), '[]'::jsonb);
  end loop;
  insert into placement_attempts(lead_id, paper, user_agent) values (p_lead, jsonb_build_object('route', route), left(p_agent, 300))
    returning * into a;
  update placement_items set times_served = times_served + 1
    where id in (select jsonb_array_elements_text(route)::uuid);
  update placement_leads set status = 'test_started', updated_at = now() where id = p_lead and status in ('new');
  return pl_state(a.token);
end $$;

create or replace function public.pl_answer(p_token uuid, p_answers jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; e jsonb; iid uuid; ch int; it public.placement_items; k int := 0;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.status = 'submitted' then raise exception 'already_submitted' using errcode = '22023'; end if;
  for e in select * from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) loop
    iid := (e->>'item')::uuid; ch := (e->>'choice')::int;
    if not (coalesce(a.paper->'route','[]'::jsonb) @> to_jsonb(iid::text) or coalesce(a.paper->'main','[]'::jsonb) @> to_jsonb(iid::text)) then continue; end if;
    select * into it from placement_items where id = iid;
    if ch is null or ch < 0 or ch >= jsonb_array_length(it.options) then continue; end if;
    insert into placement_responses(attempt_id, item_id, item_version, chosen_index, is_correct, band, section, misconception)
    values (a.id, iid, it.version, ch, ch = it.correct_index, it.band, it.section,
            case when ch <> it.correct_index then it.misconceptions->>ch end)
    on conflict (attempt_id, item_id) do update
      set chosen_index = excluded.chosen_index, is_correct = excluded.is_correct,
          misconception = excluded.misconception, answered_at = now();
    k := k + 1;
  end loop;
  return k;
end $$;

-- end of the short first stage: estimate the range, then draw the main paper from the nearest three bands
create or replace function public.pl_advance(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; v_cfg jsonb; r record; n int := 0; c int := 0; e int := 0;
        wb int[]; q int[] := array[6,4,4]; k int; vg jsonb := '[]'::jsonb; rd jsonb := '[]'::jsonb; ls jsonb := '[]'::jsonb;
        sec text; pb int[]; pid uuid; got jsonb; main jsonb;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.stage >= 2 then return pl_state(p_token); end if;
  select t.cfg into v_cfg from placement_thresholds t where t.id = 1;

  for r in
    select it.band, coalesce(rs.is_correct, false) as ok
    from jsonb_array_elements_text(a.paper->'route') with ordinality o(id, ord)
    join placement_items it on it.id = o.id::uuid
    left join placement_responses rs on rs.attempt_id = a.id and rs.item_id = it.id
    order by o.ord loop
    n := n + 1;
    if r.ok then
      c := c + 1;
      if c::numeric / n >= (v_cfg->>'est_cum_ratio')::numeric then e := greatest(e, pl_band_idx(r.band)); end if;
    end if;
  end loop;

  wb := array[e];
  if e + 1 <= 6 then wb := wb || (e + 1); end if;
  if e - 1 >= 0 then wb := wb || (e - 1); end if;
  if array_length(wb, 1) < 3 then wb := wb || case when e + 2 <= 6 then e + 2 else e - 2 end; end if;

  for k in 1..3 loop
    vg := vg || coalesce((select jsonb_agg(x.id) from (
      select id from placement_items
      where status = 'approved' and section = 'vocab_grammar' and band = pl_band_at(wb[k])
        and not (a.paper->'route' @> to_jsonb(id::text))
      order by random()
      limit q[k]) x), '[]'::jsonb);
  end loop;

  pb := array[e, case when e + 1 <= 6 then e + 1 else e - 1 end];
  foreach sec in array array['reading','listening'] loop
    got := '[]'::jsonb;
    foreach k in array pb loop
      select p.id into pid from placement_passages p
        where p.status = 'approved' and p.section = sec and p.band = pl_band_at(k)
          and exists (select 1 from placement_items i where i.passage_id = p.id and i.status = 'approved')
          and not exists (select 1 from placement_items i2 where i2.passage_id = p.id and got @> to_jsonb(i2.id::text))
        order by random() limit 1;
      if pid is null then
        select p.id into pid from placement_passages p
          where p.status = 'approved' and p.section = sec and pl_band_idx(p.band) = any(wb)
            and exists (select 1 from placement_items i where i.passage_id = p.id and i.status = 'approved')
            and not exists (select 1 from placement_items i2 where i2.passage_id = p.id and got @> to_jsonb(i2.id::text))
          order by random() limit 1;
      end if;
      if pid is not null then
        got := got || coalesce((select jsonb_agg(i.id order by i.code) from placement_items i
                                 where i.passage_id = pid and i.status = 'approved'), '[]'::jsonb);
      end if;
      pid := null;
    end loop;
    if sec = 'reading' then rd := got; else ls := got; end if;
  end loop;

  main := vg || rd || ls;
  update placement_attempts set stage = 2, est_band = pl_band_at(e),
      paper = a.paper || jsonb_build_object('main', main) where id = a.id;
  update placement_items set times_served = times_served + 1 where id in (select jsonb_array_elements_text(main)::uuid);
  return pl_state(p_token);
end $$;

-- end of the written part: score it, then choose the 4 speaking prompts for the written band
create or replace function public.pl_finish_written(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; sc jsonb; bi int; s int; pid uuid; prompts jsonb := '[]'::jsonb;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.stage >= 3 then return pl_state(p_token); end if;
  sc := pl_score(a.id);
  bi := pl_band_idx(sc->>'band');
  for s in 1..4 loop
    select id into pid from placement_prompts
      where status = 'approved' and slot = s and pl_band_idx(band_from) <= bi and pl_band_idx(band_to) >= bi
      order by random() limit 1;
    if pid is null then select id into pid from placement_prompts where status = 'approved' and slot = s order by random() limit 1; end if;
    if pid is not null then prompts := prompts || to_jsonb(pid::text); end if;
    pid := null;
  end loop;
  update placement_items it set times_correct = it.times_correct + 1
    from placement_responses r where r.attempt_id = a.id and r.item_id = it.id and r.is_correct;
  update placement_attempts set stage = 3, scores = sc, band_written = sc->>'band',
      paper = a.paper || jsonb_build_object('prompts', prompts) where id = a.id;
  return pl_state(p_token);
end $$;

create or replace function public.pl_record(p_token uuid, p_prompt uuid, p_slot int, p_path text, p_mime text, p_has_video boolean, p_duration_ms int)
returns void language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts;
begin
  select * into a from placement_attempts where token = p_token;
  if not found then raise exception 'bad_token' using errcode = '22023'; end if;
  if a.status = 'submitted' or a.stage < 3 then raise exception 'not_allowed' using errcode = '22023'; end if;
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
  if a.stage < 3 then perform pl_finish_written(p_token); end if;
  update placement_attempts set status = 'submitted', finished_at = now(), camera_on = p_camera where id = a.id;
  update placement_leads set status = 'test_completed', updated_at = now()
    where id = a.lead_id and status in ('new','test_started');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.pl_help(p_token uuid, p_lead uuid, p_kind text, p_section text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare a public.placement_attempts; lid uuid := p_lead;
begin
  if p_kind not in ('whatsapp','callback','submitted_by_mistake','other') then raise exception 'bad_kind' using errcode = '22023'; end if;
  if p_token is not null then
    select * into a from placement_attempts where token = p_token;
    if not found then raise exception 'bad_token' using errcode = '22023'; end if;
    lid := a.lead_id;
  end if;
  if lid is null then raise exception 'lead_required' using errcode = '22023'; end if;
  if (select count(*) from placement_help_requests where lead_id = lid and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many' using errcode = '22023'; end if;
  insert into placement_help_requests(attempt_id, lead_id, kind, section, note)
  values (a.id, lid, p_kind, left(p_section, 40), left(p_note, 500));
  if p_kind = 'submitted_by_mistake' and a.id is not null then
    update placement_attempts set submitted_by_mistake = true where id = a.id; end if;
end $$;

-- staff only: let a finished (or interrupted) attempt continue; the reopen is counted and kept
create or replace function public.pl_reopen(p_attempt uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_allowed' using errcode = '42501'; end if;
  update placement_attempts set status = 'reopened', reopened_count = reopened_count + 1 where id = p_attempt;
  update placement_leads set status = 'test_started', updated_at = now()
    where id = (select lead_id from placement_attempts where id = p_attempt) and status = 'test_completed';
end $$;

-- staff only: recompute the written band (after changing thresholds)
create or replace function public.pl_rescore(p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sc jsonb;
begin
  if not public.is_admin() then raise exception 'not_allowed' using errcode = '42501'; end if;
  sc := pl_score(p_attempt);
  update placement_attempts set scores = sc, band_written = sc->>'band' where id = p_attempt;
  return sc;
end $$;

-- storage uploads may only go into a folder named after a real attempt token
create or replace function public.pl_token_ok(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from placement_attempts where token::text = split_part(p_path, '/', 1) and status <> 'submitted')
$$;

-- ---------- who may call what ----------
revoke execute on function public.pl_no_delete(), public.pl_snapshot(), public.pl_score(uuid),
  public.pl_items_payload(jsonb), public.pl_prompts_payload(jsonb) from public, anon, authenticated;
revoke execute on function public.pl_state(uuid), public.pl_register(text,text,text,text,text,text,text,int,text,text,boolean,text),
  public.pl_start(uuid,text), public.pl_answer(uuid,jsonb), public.pl_advance(uuid), public.pl_finish_written(uuid),
  public.pl_record(uuid,uuid,int,text,text,boolean,int), public.pl_complete(uuid,boolean),
  public.pl_help(uuid,uuid,text,text,text), public.pl_token_ok(text), public.pl_reopen(uuid), public.pl_rescore(uuid)
  from public, anon, authenticated;
grant execute on function public.pl_state(uuid), public.pl_register(text,text,text,text,text,text,text,int,text,text,boolean,text),
  public.pl_start(uuid,text), public.pl_answer(uuid,jsonb), public.pl_advance(uuid), public.pl_finish_written(uuid),
  public.pl_record(uuid,uuid,int,text,text,boolean,int), public.pl_complete(uuid,boolean),
  public.pl_help(uuid,uuid,text,text,text), public.pl_token_ok(text) to anon, authenticated;
grant execute on function public.pl_reopen(uuid), public.pl_rescore(uuid) to authenticated;

-- ---------- files ----------
-- recordings: private. The test-taker can add a file only inside a folder named after their attempt token; staff can read.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('placement', 'placement', false, 41943040,
        array['audio/webm','audio/ogg','audio/mp4','audio/mpeg','video/webm','video/mp4'])
on conflict (id) do nothing;
create policy placement_rec_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'placement' and public.pl_token_ok(name));
create policy placement_rec_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'placement' and public.is_admin());

-- listening clips: public to play (the clip alone gives nothing away), staff upload
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('placement-audio', 'placement-audio', true, 20971520, array['audio/mpeg','audio/mp4','audio/ogg','audio/webm','audio/wav'])
on conflict (id) do nothing;
create policy placement_audio_admin on storage.objects for all to authenticated
  using (bucket_id = 'placement-audio' and public.is_admin())
  with check (bucket_id = 'placement-audio' and public.is_admin());
