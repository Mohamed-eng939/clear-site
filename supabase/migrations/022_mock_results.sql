-- 022: mock answer sheet. (1) A part cannot be sent with a blank box. (2) The student sees her own score and band
-- without ever seeing the key: the marking runs inside a SECURITY DEFINER function that returns totals only.

-- ---------- marking helpers (same rules as the teacher's marking page) ----------
create or replace function public.mock_norm(t text) returns text
language sql immutable as $$
  select regexp_replace(btrim(regexp_replace(lower(coalesce(t, '')), '\s+', ' ', 'g')), '\.+$', '')
$$;

-- true / false, or null when there is no key for the question and no teacher override
create or replace function public.mock_right(p_ans text, p_key text, p_ov jsonb) returns boolean
language plpgsql immutable as $$
declare alts text[]; got text;
begin
  if p_ov is not null and jsonb_typeof(p_ov) = 'boolean' then return (p_ov #>> '{}')::boolean; end if;
  if p_key is null or p_key = '' then return null; end if;
  alts := array(select public.mock_norm(a) from unnest(string_to_array(p_key, '/')) a where public.mock_norm(a) <> '');
  if cardinality(alts) = 0 then return null; end if;
  got := public.mock_norm(p_ans);
  if got = '' then return false; end if;
  return got = any (alts);
end $$;

-- indicative band tables (Teacher Pack): Listening, and Reading General Training
create or replace function public.mock_band(p_kind text, p_raw int) returns numeric
language sql immutable as $$
  select case p_kind
    when 'L' then case when p_raw >= 39 then 9 when p_raw >= 37 then 8.5 when p_raw >= 35 then 8 when p_raw >= 32 then 7.5
      when p_raw >= 30 then 7 when p_raw >= 26 then 6.5 when p_raw >= 23 then 6 when p_raw >= 18 then 5.5
      when p_raw >= 16 then 5 when p_raw >= 13 then 4.5 when p_raw >= 11 then 4 end
    when 'R' then case when p_raw >= 40 then 9 when p_raw >= 39 then 8.5 when p_raw >= 37 then 8 when p_raw >= 36 then 7.5
      when p_raw >= 34 then 7 when p_raw >= 32 then 6.5 when p_raw >= 30 then 6 when p_raw >= 27 then 5.5
      when p_raw >= 23 then 5 when p_raw >= 19 then 4.5 when p_raw >= 15 then 4 when p_raw >= 12 then 3.5
      when p_raw >= 9 then 3 end
  end
$$;

-- raw score for one question range; keyed = how many of those questions can be marked
create or replace function public.mock_tally(p_ans jsonb, p_key jsonb, p_ov jsonb, p_pfx text, p_lo int, p_hi int)
returns jsonb language plpgsql immutable as $$
declare n int; q text; r boolean; raw int := 0; keyed int := 0;
begin
  for n in p_lo..p_hi loop
    q := p_pfx || n;
    r := public.mock_right(p_ans ->> q, p_key ->> q, p_ov -> q);
    if r is not null then keyed := keyed + 1; end if;
    if r then raw := raw + 1; end if;
  end loop;
  return jsonb_build_object('raw', raw, 'of', p_hi - p_lo + 1, 'keyed', keyed);
end $$;

-- ---------- what a student (or the teacher) may read: totals and bands only ----------
create or replace function public.mock_result(p_sheet uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s public.mock_sheets; k jsonb; ov jsonb;
  l jsonb; r1 jsonb; r3 jsonb; out jsonb := '{}'::jsonb; raw int;
begin
  select * into s from public.mock_sheets
   where id = p_sheet and (public.is_admin() or student_id in (select public.my_student_ids()));
  if not found then raise exception 'Sheet not found'; end if;
  select answers into k from public.mock_keys where id = s.mock_id;
  select overrides into ov from public.mock_marks where sheet_id = s.id;
  k := coalesce(k, '{}'::jsonb); ov := coalesce(ov, '{}'::jsonb);

  if s.submitted ? 'L' then
    l := public.mock_tally(s.answers, k, ov, 'L', 1, 40);
    if (l ->> 'keyed')::int < 40 then out := out || jsonb_build_object('L', jsonb_build_object('pending', true));
    else out := out || jsonb_build_object('L', jsonb_build_object('raw', l -> 'raw', 'of', 40, 'band', public.mock_band('L', (l ->> 'raw')::int)));
    end if;
  end if;

  if s.submitted ? 'R' then
    r1 := public.mock_tally(s.answers, k, ov, 'R', 1, 27);
    if (r1 ->> 'keyed')::int < 27 then out := out || jsonb_build_object('R', jsonb_build_object('pending', true));
    else out := out || jsonb_build_object('R', jsonb_build_object('raw', r1 -> 'raw', 'of', 27));
    end if;
  end if;

  if s.submitted ? 'R3' then
    r3 := public.mock_tally(s.answers, k, ov, 'R', 28, 40);
    if (r3 ->> 'keyed')::int < 13 then out := out || jsonb_build_object('R3', jsonb_build_object('pending', true));
    else out := out || jsonb_build_object('R3', jsonb_build_object('raw', r3 -> 'raw', 'of', 13));
    end if;
  end if;

  if s.submitted ? 'R' and s.submitted ? 'R3' then
    if (r1 ->> 'keyed')::int < 27 or (r3 ->> 'keyed')::int < 13 then
      out := out || jsonb_build_object('reading', jsonb_build_object('pending', true));
    else
      raw := (r1 ->> 'raw')::int + (r3 ->> 'raw')::int;
      out := out || jsonb_build_object('reading', jsonb_build_object('raw', raw, 'of', 40, 'band', public.mock_band('R', raw)));
    end if;
  end if;
  return out;
end $$;
revoke execute on function public.mock_result(uuid) from anon, public;
grant execute on function public.mock_result(uuid) to authenticated;

-- ---------- sending: no blanks ----------
create or replace function public.mock_save(p_sheet uuid, p_answers jsonb, p_part text, p_submit boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.mock_sheets;
  k text; v text; n int; pfx text; lo int; hi int;
  merged jsonb; missing text;
begin
  select * into s from public.mock_sheets where id = p_sheet and student_id in (select public.my_student_ids());
  if not found then raise exception 'Sheet not found'; end if;
  if p_part not in ('L', 'R', 'R3') then raise exception 'Unknown part'; end if;
  if s.submitted ? p_part then raise exception 'This part is already submitted'; end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then raise exception 'Bad answers'; end if;
  pfx := case when p_part = 'L' then 'L' else 'R' end;
  lo  := case p_part when 'L' then 1 when 'R' then 1 else 28 end;
  hi  := case p_part when 'L' then 40 when 'R' then 27 else 40 end;
  merged := s.answers;
  for k, v in select key, value from jsonb_each_text(p_answers) loop
    if k ~ ('^' || pfx || '[0-9]{1,2}$') then
      n := substring(k from 2)::int;
      if n between lo and hi then merged := merged || jsonb_build_object(k, left(coalesce(v, ''), 80)); end if;
    end if;
  end loop;

  if p_submit then
    select string_agg(g::text, ', ' order by g) into missing
      from generate_series(lo, hi) g
     where btrim(coalesce(merged ->> (pfx || g), '')) = '';
    if missing is not null then
      raise exception 'Answer every question before sending. Still blank: %', missing;
    end if;
  end if;

  update public.mock_sheets
     set answers = merged,
         submitted = case when p_submit then submitted || jsonb_build_object(p_part, now()) else submitted end
   where id = p_sheet;
  return merged;
end $$;
revoke execute on function public.mock_save(uuid, jsonb, text, boolean) from anon, public;
grant execute on function public.mock_save(uuid, jsonb, text, boolean) to authenticated;
