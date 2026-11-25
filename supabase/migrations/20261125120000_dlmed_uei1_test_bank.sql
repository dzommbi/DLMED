begin;

create table public.dlmed_tests (
  test_number smallint primary key check (test_number between 1 and 10),
  title text not null,
  description text not null default '',
  question_count smallint not null check (question_count between 1 and 200),
  is_published boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.dlmed_test_questions (
  id bigint generated always as identity primary key,
  test_number smallint not null references public.dlmed_tests(test_number) on delete cascade,
  question_number smallint not null check (question_number between 1 and 200),
  section text not null,
  question_type text not null default 'QCM',
  question text not null,
  options jsonb not null,
  constraint dlmed_test_questions_options_five
    check (case when jsonb_typeof(options) = 'array' then jsonb_array_length(options) = 5 else false end),
  constraint dlmed_test_questions_test_number_unique
    unique (test_number, question_number)
);

create table public.dlmed_test_corrections (
  test_number smallint not null,
  question_number smallint not null,
  correct_options text[] not null,
  explanation text not null,
  reference text not null default '',
  primary key (test_number, question_number),
  constraint dlmed_test_corrections_question_fk
    foreign key (test_number, question_number)
    references public.dlmed_test_questions(test_number, question_number)
    on delete cascade,
  constraint dlmed_test_corrections_options_valid
    check (
      cardinality(correct_options) between 1 and 5
      and correct_options <@ array['A', 'B', 'C', 'D', 'E']::text[]
    )
);

alter table public.dlmed_tests enable row level security;
alter table public.dlmed_test_questions enable row level security;
alter table public.dlmed_test_corrections enable row level security;

revoke all privileges on table public.dlmed_tests, public.dlmed_test_questions, public.dlmed_test_corrections
  from public, anon, authenticated;
grant select on table public.dlmed_tests, public.dlmed_test_questions to authenticated;

create policy dlmed_tests_active_profile_read
  on public.dlmed_tests for select to authenticated
  using ((select public.dlmed_has_complete_profile_session()));

create policy dlmed_test_questions_active_profile_read
  on public.dlmed_test_questions for select to authenticated
  using ((select public.dlmed_has_complete_profile_session()));

comment on table public.dlmed_tests is 'Published DLMED practice tests.';
comment on table public.dlmed_test_questions is 'Test prompts and answer options. Does not contain answer keys.';
comment on table public.dlmed_test_corrections is 'Private answer keys and explanations. No client table access; returned only after grading.';

insert into public.dlmed_tests (test_number, title, description, question_count, is_published)
values
  (1, 'Examen 01 — UEI 1', 'SCA, HTA, imagerie, choc et sémiologie cardiovasculaire.', 67, true),
  (2, 'Examen 02 — UEI 1', 'Déshydratation, embolie pulmonaire, sémiologie respiratoire et bilan lipidique.', 67, true),
  (3, 'Examen 03 — UEI 1', 'OAP, insuffisance respiratoire, insuffisance cardiaque et stress oxydant.', 67, true),
  (4, 'Examen 04 — UEI 1', 'Anaphylaxie, ischémie aiguë de membre et examen vasculaire.', 67, true),
  (5, 'Examen 05 — UEI 1', 'Œdèmes, congestion cardiaque, épanchement pleural et préanalytique.', 67, true),
  (6, 'Examen 06 — UEI 1', 'Profils d’HTA, SCA, ECG et marqueurs cardiaques.', 67, true),
  (7, 'Examen 07 — UEI 1', 'Syndromes pulmonaires, échanges gazeux et EFR.', 67, true),
  (8, 'Examen 08 — UEI 1', 'Valvulopathies, hémodynamique et examens cardiaques.', 67, true),
  (9, 'Examen 09 — UEI 1', 'Dyslipidémies, athérosclérose et sémiologie artérielle.', 67, true),
  (10, 'Examen 10 — UEI 1', 'Cas intégrés de SCA, choc hypovolémique, HTA, douleur et biochimie.', 67, true)
on conflict (test_number) do update set
  title = excluded.title,
  description = excluded.description,
  question_count = excluded.question_count,
  is_published = excluded.is_published;

create or replace function public.dlmed_grade_test(
  p_test_number integer,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_user_id uuid := auth.uid();
  v_expected_count integer;
  v_actual_count integer;
  v_submitted_count integer;
  v_correct_count integer;
  v_results jsonb;
begin
  if v_user_id is null or not public.dlmed_has_complete_profile_session() then
    raise exception 'An active authenticated session with a username is required'
      using errcode = '42501';
  end if;

  if p_test_number is null or p_test_number < 1 or p_test_number > 10 then
    raise exception 'Unknown test' using errcode = '22023';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) is distinct from 'array' then
    raise exception 'Answers must be a JSON array' using errcode = '22023';
  end if;

  select t.question_count into v_expected_count
    from public.dlmed_tests as t
   where t.test_number = p_test_number and t.is_published;
  if v_expected_count is null then
    raise exception 'Test is not available' using errcode = '22023';
  end if;

  select count(*) into v_actual_count
    from public.dlmed_test_questions as q
   where q.test_number = p_test_number;
  if v_actual_count <> v_expected_count then
    raise exception 'Test question bank is incomplete' using errcode = '55000';
  end if;
  if (select count(*) from public.dlmed_test_corrections as c where c.test_number = p_test_number) <> v_expected_count then
    raise exception 'Test correction bank is incomplete' using errcode = '55000';
  end if;
  if jsonb_array_length(p_answers) <> v_expected_count then
    raise exception 'Submit one answer for every question' using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_answers) as submitted(value)
     where jsonb_typeof(submitted.value) is distinct from 'object'
  ) then
    raise exception 'Every answer must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_answers) as submitted(value)
     where jsonb_typeof(submitted.value -> 'question_id') is distinct from 'number'
        or (submitted.value ->> 'question_id') !~ '^[1-9][0-9]*$'
  ) then
    raise exception 'Every answer needs a valid question id' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_answers) as submitted(value)
     where jsonb_typeof(submitted.value -> 'selected_options') is distinct from 'array'
  ) then
    raise exception 'Every answer needs a selected_options array' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_answers) as submitted(value)
     where jsonb_array_length(submitted.value -> 'selected_options') < 1
        or jsonb_array_length(submitted.value -> 'selected_options') > 5
  ) then
    raise exception 'Select between one and five options for every question' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_answers) as submitted(value),
           jsonb_array_elements(submitted.value -> 'selected_options') as selected_item(value)
     where jsonb_typeof(selected_item.value) is distinct from 'string'
        or upper(selected_item.value #>> '{}') not in ('A', 'B', 'C', 'D', 'E')
  ) then
    raise exception 'Options must use letters A through E' using errcode = '22023';
  end if;

  select count(distinct (submitted.value ->> 'question_id')::bigint)
    into v_submitted_count
    from jsonb_array_elements(p_answers) as submitted(value);
  if v_submitted_count <> v_expected_count then
    raise exception 'Each question must be answered exactly once' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_answers) as submitted(value)
     where not exists (
       select 1
         from public.dlmed_test_questions as q
        where q.test_number = p_test_number
          and q.id = (submitted.value ->> 'question_id')::bigint
     )
  ) then
    raise exception 'Answers contain a question outside this test' using errcode = '22023';
  end if;

  with submissions as (
    select (submitted.value ->> 'question_id')::bigint as question_id,
           (
             select array_agg(distinct upper(option.value #>> '{}') order by upper(option.value #>> '{}'))
               from jsonb_array_elements(submitted.value -> 'selected_options') as option(value)
           ) as selected_options
      from jsonb_array_elements(p_answers) as submitted(value)
  ),
  graded as (
    select q.id,
           q.question_number,
           s.selected_options,
           c.correct_options,
           s.selected_options = c.correct_options as is_correct,
           c.explanation,
           c.reference
      from public.dlmed_test_questions as q
      join public.dlmed_test_corrections as c
        on c.test_number = q.test_number and c.question_number = q.question_number
      join submissions as s on s.question_id = q.id
     where q.test_number = p_test_number
  )
  select count(*) filter (where graded.is_correct),
         jsonb_agg(jsonb_build_object(
           'question_id', graded.id,
           'question_number', graded.question_number,
           'selected_options', to_jsonb(graded.selected_options),
           'correct_options', to_jsonb(graded.correct_options),
           'correct', graded.is_correct,
           'explanation', graded.explanation,
           'reference', graded.reference
         ) order by graded.question_number)
    into v_correct_count, v_results
    from graded;

  return jsonb_build_object(
    'test_number', p_test_number,
    'total', v_expected_count,
    'correct_count', coalesce(v_correct_count, 0),
    'score', round(coalesce(v_correct_count, 0)::numeric * 20 / v_expected_count, 1),
    'results', coalesce(v_results, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.dlmed_grade_test(integer, jsonb) from public, anon;
grant execute on function public.dlmed_grade_test(integer, jsonb) to authenticated;

commit;
