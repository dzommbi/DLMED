-- Review before running against the production project.
-- Existing tables are reused. This does not create, rename, or delete tables.
begin;

-- The current allow_read_answers policy exposes the full answer key to anon.
-- RLS remains enabled; removing this policy blocks direct public reads.
drop policy if exists allow_read_answers on public.questions_answers;
revoke all privileges on table public.questions_answers from anon, authenticated;
revoke select (id, created_at, question_id, correct_options, explanation)
  on table public.questions_answers from anon, authenticated;

-- `questions` also has legacy display columns and an `explanation` column.
-- Give browsers access only to the fields used to show an unanswered QCM.
revoke all privileges on table public.questions from anon, authenticated;
revoke select (created_at, subject, lesson, explanation)
  on table public.questions from anon, authenticated;
grant select (id, subject_id, lesson_id, question, options)
  on table public.questions to anon, authenticated;

-- The app reads only public catalog/question fields. Correct answers stay in
-- questions_answers and are returned only by this grading RPC after submission.
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
  if p_question_id is null
     or p_selected_options is null
     or cardinality(p_selected_options) < 1
     or cardinality(p_selected_options) > 5 then
    raise exception 'Invalid QCM submission';
  end if;

  if exists (
    select 1
    from unnest(p_selected_options) as submitted(option_letter)
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

  -- correct_options is stored as a JSON array of option letters, for example ["B"]
  -- or ["A", "D"] for multi-answer questions.
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
     or exists (select 1 from unnest(v_correct_options) as answer(option_letter)
                where answer.option_letter not in ('A', 'B', 'C', 'D', 'E')) then
    raise exception 'Stored correction is invalid for question %', p_question_id;
  end if;

  return jsonb_build_object(
    'correct', v_selected_options = v_correct_options,
    'correct_options', to_jsonb(v_correct_options),
    'explanation', coalesce(v_explanation, '')
  );
end;
$$;

revoke all on function public.grade_qcm_question(bigint, text[]) from public;
grant execute on function public.grade_qcm_question(bigint, text[]) to anon, authenticated;

-- Keep the existing public-read policies/RLS design for the catalog tables.
grant select on table public.subject, public.lessons to anon;

commit;
