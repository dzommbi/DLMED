-- DLMed Google authentication, required usernames, and one active session.
-- Apply after 20261104_secure_qcm_grading.sql.
begin;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now(),
  constraint dlmed_profiles_username_format_check
    check (username ~ '^[A-Za-z0-9_]{4,20}$')
);

create unique index if not exists dlmed_profiles_username_ci_uidx
  on public.profiles (lower(username));

alter table public.profiles enable row level security;
revoke all privileges on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;

create table if not exists public.dlmed_active_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id uuid not null unique,
  device_id uuid not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  claimed_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists dlmed_active_sessions_last_seen_idx
  on public.dlmed_active_sessions (last_seen_at);

alter table public.dlmed_active_sessions enable row level security;
revoke all privileges on table public.dlmed_active_sessions from public, anon, authenticated;

create table if not exists public.dlmed_username_check_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  check_count integer not null default 0 check (check_count >= 0)
);
alter table public.dlmed_username_check_limits enable row level security;
revoke all privileges on table public.dlmed_username_check_limits from public, anon, authenticated;

-- This helper checks both DLMed's current-session row and Supabase Auth's own
-- session row. Supabase access tokens contain a UUID `session_id` claim.
create or replace function public.dlmed_has_active_session()
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
begin
  if v_user_id is null then
    return false;
  end if;

  begin
    v_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  if v_session_id is null then
    return false;
  end if;

  return exists (
    select 1
      from public.dlmed_active_sessions as active
      join auth.sessions as auth_session
        on auth_session.id = active.session_id
       and auth_session.user_id = active.user_id
     where active.user_id = v_user_id
       and active.is_active
       and active.session_id = v_session_id
  );
end;
$$;

revoke all on function public.dlmed_has_active_session() from public, anon;
grant execute on function public.dlmed_has_active_session() to authenticated;

create or replace function public.dlmed_has_complete_profile_session()
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not public.dlmed_has_active_session() then
    return false;
  end if;
  return exists (select 1 from public.profiles as profile where profile.user_id = v_user_id);
end;
$$;

revoke all on function public.dlmed_has_complete_profile_session() from public, anon;
grant execute on function public.dlmed_has_complete_profile_session() to authenticated;

-- Locking the auth.users row serializes simultaneous claims for one user.
-- The transaction's upsert makes the most recent completed claim authoritative.
create or replace function public.dlmed_claim_active_session(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_device_id uuid;
  v_locked_user uuid;
  v_latest_session_id uuid;
  v_session_created_at timestamptz;
  v_last_claimed_at timestamptz;
  v_previous_session_id uuid;
  v_previous_is_active boolean;
begin
  if v_user_id is null or p_device_id is null then
    raise exception 'Authentication and device identity are required'
      using errcode = '42501';
  end if;

  if not (coalesce(auth.jwt() -> 'app_metadata' -> 'providers', '[]'::jsonb) ? 'google')
     or not exists (
       select 1
         from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) as method_claim(value)
        where method_claim.value ->> 'method' = 'oauth'
     ) then
    raise exception 'A Google OAuth session is required' using errcode = '42501';
  end if;

  begin
    v_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'A valid Supabase session is required' using errcode = '42501';
  end;

  select s.created_at into v_session_created_at
    from auth.sessions s
   where s.id = v_session_id and s.user_id = v_user_id;
  if v_session_id is null or v_session_created_at is null then
    raise exception 'The Supabase session is no longer valid' using errcode = '42501';
  end if;

  select s.id into v_latest_session_id
    from auth.sessions as s
   where s.user_id = v_user_id
   order by s.created_at desc nulls last, s.updated_at desc nulls last, s.id desc
   limit 1;
  if v_latest_session_id is distinct from v_session_id then
    raise exception 'Only the newest Supabase login session can claim this device slot'
      using errcode = '42501';
  end if;

  select u.id into v_locked_user
    from auth.users as u
   where u.id = v_user_id
   for update;
  if v_locked_user is null then
    raise exception 'Authenticated user not found' using errcode = '42501';
  end if;

  select active.session_id, active.claimed_at, active.is_active
    into v_previous_session_id, v_last_claimed_at, v_previous_is_active
    from public.dlmed_active_sessions as active
   where active.user_id = v_user_id
   for update;

  -- Recheck after taking the per-user lock so a session revoked while waiting
  -- cannot replace a newer, valid session.
  select s.created_at into v_session_created_at
    from auth.sessions s
   where s.id = v_session_id and s.user_id = v_user_id;
  if v_session_created_at is null then
    raise exception 'The Supabase session is no longer valid' using errcode = '42501';
  end if;

  select s.id into v_latest_session_id
    from auth.sessions as s
   where s.user_id = v_user_id
   order by s.created_at desc nulls last, s.updated_at desc nulls last, s.id desc
   limit 1;
  if v_latest_session_id is distinct from v_session_id then
    raise exception 'A newer Supabase login session already exists'
      using errcode = '42501';
  end if;

  if v_last_claimed_at is not null
     and not (v_previous_is_active is true and v_previous_session_id = v_session_id)
     and v_session_created_at <= v_last_claimed_at then
    raise exception 'This Supabase session predates the last DLMed login'
      using errcode = '42501';
  end if;

  insert into public.dlmed_active_sessions
    (user_id, session_id, device_id, created_at, claimed_at, last_seen_at)
  values
    (v_user_id, v_session_id, p_device_id, now(), now(), now())
  on conflict (user_id) do update
    set session_id = excluded.session_id,
        device_id = excluded.device_id,
        is_active = true,
        claimed_at = excluded.claimed_at,
        last_seen_at = excluded.last_seen_at
  returning session_id, device_id into v_session_id, v_device_id;

  -- Remove the replaced session from Supabase Auth as well as from DLMed's
  -- active slot. The row lock and newest-session checks keep a stale token from
  -- reclaiming the slot after logout.
  if v_previous_session_id is not null and v_previous_session_id <> v_session_id then
    delete from auth.sessions
     where id = v_previous_session_id and user_id = v_user_id;
  end if;

  return jsonb_build_object(
    'active', true,
    'session_id', v_session_id,
    'device_id', v_device_id
  );
end;
$$;

create or replace function public.dlmed_active_session_heartbeat()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
begin
  if v_user_id is null or not public.dlmed_has_active_session() then
    return false;
  end if;

  v_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  update public.dlmed_active_sessions
     set last_seen_at = now()
   where user_id = v_user_id
     and session_id = v_session_id
     and is_active;

  return found;
end;
$$;

create or replace function public.dlmed_release_active_session()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
begin
  if v_user_id is null then
    return false;
  end if;

  begin
    v_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  if v_session_id is null then
    return false;
  end if;

  update public.dlmed_active_sessions
     set is_active = false,
         last_seen_at = now()
   where user_id = v_user_id
     and session_id = v_session_id
     and is_active;
  return found;
end;
$$;

create or replace function public.dlmed_username_is_available(p_username text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_check_count integer;
begin
  if not public.dlmed_has_active_session() then
    raise exception 'An active authenticated session is required' using errcode = '42501';
  end if;
  if p_username is null or p_username !~ '^[A-Za-z0-9_]{4,20}$' then
    raise exception 'Username must contain 4 to 20 English letters, digits, or underscores'
      using errcode = '22023';
  end if;

  insert into public.dlmed_username_check_limits (user_id, window_started_at, check_count)
  values (v_user_id, now(), 1)
  on conflict (user_id) do update
    set window_started_at = case
          when public.dlmed_username_check_limits.window_started_at < now() - interval '1 minute' then now()
          else public.dlmed_username_check_limits.window_started_at
        end,
        check_count = case
          when public.dlmed_username_check_limits.window_started_at < now() - interval '1 minute' then 1
          else public.dlmed_username_check_limits.check_count + 1
        end
  returning check_count into v_check_count;

  if v_check_count > 30 then
    raise exception 'Too many username availability checks' using errcode = 'P0001';
  end if;

  return not exists (
    select 1 from public.profiles p where lower(p.username) = lower(p_username)
  );
end;
$$;

create or replace function public.dlmed_set_username(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_saved_username text;
begin
  if v_user_id is null or not public.dlmed_has_active_session() then
    raise exception 'An active authenticated session is required' using errcode = '42501';
  end if;
  if p_username is null or p_username !~ '^[A-Za-z0-9_]{4,20}$' then
    return jsonb_build_object('ok', false, 'status', 'invalid');
  end if;

  insert into public.profiles (user_id, username)
  values (v_user_id, p_username)
  on conflict do nothing
  returning username into v_saved_username;

  if v_saved_username is not null then
    return jsonb_build_object('ok', true, 'status', 'saved', 'username', v_saved_username);
  end if;

  select p.username into v_saved_username
    from public.profiles p where p.user_id = v_user_id;
  if v_saved_username is not null then
    return jsonb_build_object('ok', true, 'status', 'already_set', 'username', v_saved_username);
  end if;

  return jsonb_build_object('ok', false, 'status', 'taken');
end;
$$;

revoke all on function public.dlmed_claim_active_session(uuid) from public, anon;
revoke all on function public.dlmed_active_session_heartbeat() from public, anon;
revoke all on function public.dlmed_release_active_session() from public, anon;
revoke all on function public.dlmed_username_is_available(text) from public, anon;
revoke all on function public.dlmed_set_username(text) from public, anon;
grant execute on function public.dlmed_claim_active_session(uuid) to authenticated;
grant execute on function public.dlmed_active_session_heartbeat() to authenticated;
grant execute on function public.dlmed_release_active_session() to authenticated;
grant execute on function public.dlmed_username_is_available(text) to authenticated;
grant execute on function public.dlmed_set_username(text) to authenticated;

drop policy if exists dlmed_profiles_read_own_active on public.profiles;
create policy dlmed_profiles_read_own_active
  on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) and (select public.dlmed_has_active_session()));

-- The catalog and QCM content are available only after the active session has
-- a saved username. Restrictive policies combine with any legacy policies so an old
-- `TO public`/`TO authenticated` policy cannot bypass the active-session test.
alter table public.subject enable row level security;
alter table public.lessons enable row level security;
alter table public.questions enable row level security;
alter table public.questions_answers enable row level security;

revoke all privileges on table public.subject, public.lessons, public.questions
  from public, anon, authenticated;
revoke all privileges on table public.questions_answers from public, anon, authenticated;
-- Table-level REVOKE does not remove old column-level SELECT grants. Clear
-- every column on these two tables before granting only the new allowlist.
do $$
declare
  v_subject_columns text;
  v_lesson_columns text;
  v_question_columns text;
  v_answer_columns text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum)
    into v_subject_columns
    from pg_attribute
   where attrelid = 'public.subject'::regclass
     and attnum > 0 and not attisdropped;
  select string_agg(quote_ident(attname), ', ' order by attnum)
    into v_lesson_columns
    from pg_attribute
   where attrelid = 'public.lessons'::regclass
     and attnum > 0 and not attisdropped;
  select string_agg(quote_ident(attname), ', ' order by attnum)
    into v_question_columns
    from pg_attribute
   where attrelid = 'public.questions'::regclass
     and attnum > 0 and not attisdropped;
  select string_agg(quote_ident(attname), ', ' order by attnum)
    into v_answer_columns
    from pg_attribute
   where attrelid = 'public.questions_answers'::regclass
     and attnum > 0 and not attisdropped;
  execute format(
    'revoke select (%s) on table public.subject from public, anon, authenticated',
    v_subject_columns
  );
  execute format(
    'revoke select (%s) on table public.lessons from public, anon, authenticated',
    v_lesson_columns
  );
  execute format(
    'revoke select (%s) on table public.questions from public, anon, authenticated',
    v_question_columns
  );
  execute format(
    'revoke select (%s) on table public.questions_answers from public, anon, authenticated',
    v_answer_columns
  );
end;
$$;
grant select on table public.subject, public.lessons to authenticated;
grant select (id, subject_id, lesson_id, question, options)
  on table public.questions to authenticated;

drop policy if exists dlmed_authenticated_read on public.subject;
drop policy if exists dlmed_active_session_only on public.subject;
create policy dlmed_authenticated_read on public.subject
  for select to authenticated using (true);
create policy dlmed_active_session_only on public.subject
  as restrictive for select to authenticated
  using ((select public.dlmed_has_complete_profile_session()));

drop policy if exists dlmed_authenticated_read on public.lessons;
drop policy if exists dlmed_active_session_only on public.lessons;
create policy dlmed_authenticated_read on public.lessons
  for select to authenticated using (true);
create policy dlmed_active_session_only on public.lessons
  as restrictive for select to authenticated
  using ((select public.dlmed_has_complete_profile_session()));

drop policy if exists dlmed_authenticated_read on public.questions;
drop policy if exists dlmed_active_session_only on public.questions;
create policy dlmed_authenticated_read on public.questions
  for select to authenticated using (true);
create policy dlmed_active_session_only on public.questions
  as restrictive for select to authenticated
  using ((select public.dlmed_has_complete_profile_session()));

-- Re-create the grading RPC with a server-side active-session check. Direct
-- access to the correction table remains revoked.
create or replace function public.grade_qcm_question(
  p_question_id bigint,
  p_selected_options text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_correct_json jsonb;
  v_correct_options text[];
  v_selected_options text[];
  v_explanation text;
  v_answer_count integer;
begin
  if not public.dlmed_has_complete_profile_session() then
    raise exception 'An active authenticated session with a username is required' using errcode = '42501';
  end if;
  if p_question_id is null
     or p_selected_options is null
     or cardinality(p_selected_options) < 1
     or cardinality(p_selected_options) > 5 then
    raise exception 'Invalid QCM submission';
  end if;

  if exists (
    select 1 from unnest(p_selected_options) as submitted(option_letter)
     where upper(submitted.option_letter) not in ('A', 'B', 'C', 'D', 'E')
  ) then
    raise exception 'Options must use letters A through E';
  end if;

  select count(*),
         (array_agg(qa.correct_options order by qa.id))[1],
         (array_agg(qa.explanation order by qa.id))[1]
    into v_answer_count, v_correct_json, v_explanation
    from public.questions_answers as qa
   where qa.question_id = p_question_id;

  if v_answer_count <> 1 or v_correct_json is null then
    raise exception 'A unique correction is not available for question %', p_question_id;
  end if;
  if jsonb_typeof(v_correct_json) <> 'array' then
    raise exception 'Correction must be a JSON array of option letters';
  end if;

  select array_agg(distinct upper(submitted.option_letter) order by upper(submitted.option_letter))
    into v_selected_options
    from unnest(p_selected_options) as submitted(option_letter);
  select array_agg(distinct upper(answer.option_letter) order by upper(answer.option_letter))
    into v_correct_options
    from jsonb_array_elements_text(v_correct_json) as answer(option_letter);

  if v_correct_options is null
     or cardinality(v_correct_options) < 1
     or exists (
       select 1 from unnest(v_correct_options) as answer(option_letter)
        where answer.option_letter not in ('A', 'B', 'C', 'D', 'E')
     ) then
    raise exception 'Stored correction is invalid for question %', p_question_id;
  end if;

  return jsonb_build_object(
    'correct', v_selected_options = v_correct_options,
    'correct_options', to_jsonb(v_correct_options),
    'explanation', coalesce(v_explanation, '')
  );
end;
$$;

revoke all on function public.grade_qcm_question(bigint, text[]) from public, anon;
grant execute on function public.grade_qcm_question(bigint, text[]) to authenticated;

commit;
