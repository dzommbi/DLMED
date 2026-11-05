begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

select ok(to_regclass('public.profiles') is not null, 'profiles table exists');
select ok(to_regclass('public.dlmed_active_sessions') is not null, 'active-session table exists');
select ok(
  to_regprocedure('public.dlmed_active_session_heartbeat()') is not null,
  'heartbeat RPC exists with the expected zero-argument signature'
);
select ok(
  pg_get_function_result(to_regprocedure('public.dlmed_active_session_heartbeat()')) = 'boolean',
  'heartbeat RPC returns boolean'
);
select ok(
  coalesce(has_function_privilege(
    'authenticated', to_regprocedure('public.dlmed_active_session_heartbeat()'), 'execute'
  ), false),
  'authenticated users can execute the heartbeat RPC'
);
select ok(
  not coalesce(has_function_privilege(
    'anon', to_regprocedure('public.dlmed_active_session_heartbeat()'), 'execute'
  ), false),
  'anonymous users cannot execute the heartbeat RPC'
);
select ok(
  not has_table_privilege('authenticated', 'public.dlmed_active_sessions', 'select'),
  'authenticated users cannot read active-session rows directly'
);
select ok(to_regclass('public.dlmed_username_check_limits') is not null, 'username-check rate-limit table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'profiles has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.dlmed_active_sessions'::regclass),
  'active sessions has RLS enabled'
);
select ok(
  exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'dlmed_active_sessions'
       and column_name = 'is_active'
       and is_nullable = 'NO'
  ),
  'active-session tombstone state exists'
);
select ok(
  to_regclass('public.dlmed_profiles_username_ci_uidx') is not null,
  'case-insensitive username uniqueness index exists'
);
select ok(
  (select indisunique from pg_index where indexrelid = 'public.dlmed_profiles_username_ci_uidx'::regclass),
  'the username index enforces uniqueness in PostgreSQL'
);
select ok(
  position('lower(username)' in pg_get_indexdef('public.dlmed_profiles_username_ci_uidx'::regclass)) > 0,
  'the username uniqueness constraint ignores letter case'
);
select ok(
  not has_table_privilege('anon', 'public.profiles', 'select'),
  'anonymous users cannot read profiles'
);
select ok(
  not has_table_privilege('authenticated', 'public.dlmed_username_check_limits', 'select'),
  'users cannot inspect username rate-limit records'
);
select ok(
  not has_table_privilege('anon', 'public.subject', 'select'),
  'anonymous users cannot read the QCM catalog'
);
select ok(
  not has_any_column_privilege('anon', 'public.subject', 'select')
    and not has_any_column_privilege('anon', 'public.lessons', 'select'),
  'anonymous users have no subject or lesson column grants'
);
select ok(
  not has_column_privilege('anon', 'public.questions', 'question', 'select'),
  'anonymous users cannot read question text through a column grant'
);
select ok(
  not has_any_column_privilege('anon', 'public.questions', 'select'),
  'anonymous users have no question-column grants'
);
select ok(
  has_column_privilege('authenticated', 'public.questions', 'question', 'select'),
  'authenticated users receive the question display column grant'
);
select ok(
  not has_table_privilege('authenticated', 'public.questions_answers', 'select'),
  'authenticated users cannot read answer keys directly'
);
select ok(
  not has_column_privilege('authenticated', 'public.questions_answers', 'correct_options', 'select'),
  'authenticated users cannot read the correct-options column'
);
select ok(
  not has_function_privilege('anon', 'public.dlmed_claim_active_session(uuid)', 'execute'),
  'anonymous users cannot claim an active session'
);
select ok(
  has_function_privilege('authenticated', 'public.dlmed_claim_active_session(uuid)', 'execute'),
  'authenticated users can claim their own session'
);
select ok(
  not has_function_privilege('anon', 'public.dlmed_has_complete_profile_session()', 'execute')
    and has_function_privilege('authenticated', 'public.dlmed_has_complete_profile_session()', 'execute'),
  'profile-complete session check is private to authenticated callers'
);
select ok(
  position('v_session_created_at <= v_last_claimed_at' in
    pg_get_functiondef('public.dlmed_claim_active_session(uuid)'::regprocedure)) > 0,
  'older Supabase sessions cannot reclaim the device slot'
);
select ok(
  position('delete from auth.sessions' in
    pg_get_functiondef('public.dlmed_claim_active_session(uuid)'::regprocedure)) > 0,
  'the replaced Supabase Auth session is revoked'
);
select ok(
  position('google' in
    pg_get_functiondef('public.dlmed_claim_active_session(uuid)'::regprocedure)) > 0
    and position('oauth' in
      pg_get_functiondef('public.dlmed_claim_active_session(uuid)'::regprocedure)) > 0,
  'only a Google OAuth session can claim the slot'
);
select ok(
  position('active.is_active' in
    pg_get_functiondef('public.dlmed_has_active_session()'::regprocedure)) > 0,
  'inactive sessions fail the server-side access check'
);
select ok(
  position('profile.user_id' in
    pg_get_functiondef('public.dlmed_has_complete_profile_session()'::regprocedure)) > 0,
  'QCM access requires a saved username profile'
);
select ok(
  exists (
    select 1 from pg_policy
     where polrelid = 'public.questions'::regclass
       and polname = 'dlmed_active_session_only'
       and not polpermissive
  ),
  'question reads have a restrictive active-session policy'
);
select ok(
  position('dlmed_has_complete_profile_session' in
    pg_get_expr((select polqual from pg_policy where polrelid = 'public.questions'::regclass and polname = 'dlmed_active_session_only'), 'public.questions'::regclass)) > 0,
  'question reads require the username profile at the database layer'
);
select ok(
  position('dlmed_has_complete_profile_session' in
    pg_get_functiondef('public.grade_qcm_question(bigint,text[])'::regprocedure)) > 0,
  'grading requires the username profile at the database layer'
);

select * from finish();
rollback;
