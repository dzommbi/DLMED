# DLMed Supabase integration

The site uses the existing `subject`, `lessons`, `questions`, and `questions_answers` tables. No duplicate tables are defined here.

## Current production state

Verified on 2026-11-04 against the Supabase project configured in `../supabase-config.js` (`https://alfziyssfhiabqgmzlsb.supabase.co`):

| Table / check | Current result |
|---|---:|
| `subject` | 4 rows |
| `lessons` | 17 rows |
| `questions` | 590 rows |
| `questions_answers` | 590 rows |
| Questions without exactly one correction | 0 |
| Questions with a broken subject/lesson link | 0 |

Question counts by subject:

| Subject | Lessons | QCM |
|---|---:|---:|
| Biochimie | 3 | 90 |
| Physiopathologie | 3 | 90 |
| Psychologie médicale | 1 | 30 |
| Sémiologie | 10 | 380 |

The optional Radiologie placeholder remains in `catalog.json` and the picker, but there are no Radiologie questions in the imported bank. Running `seed-qcm-catalog.ps1` against this project would add its empty subject row; it is not needed for the current production catalog.

## Access and grading

- Anonymous clients can read `subject` and `lessons` and the question display columns `id`, `subject_id`, `lesson_id`, `question`, and `options`.
- Anonymous/authenticated clients cannot read `questions_answers` directly. Correct options and explanations are returned by `grade_qcm_question(bigint, text[])` after an answer is submitted.
- The `questions_answers.question_id` foreign key and question-to-subject/lesson references were checked; the existing schema is reused.
- The migration `migrations/20261104_secure_qcm_grading.sql` was applied to the configured production project. It can be kept in version control as the reviewable schema/security change.

## Browser integration

- `../supabase-config.js` contains the public project URL and publishable key. Do not put a Supabase secret/service-role key in browser files.
- `../supabase-auth.js` manages Google OAuth, required usernames, server-verified active sessions, heartbeats, and local sign-out after revocation.
- `../supabase-data.js` loads the existing subject/lesson/question columns only after a server heartbeat, pages questions in ranges of 500, does not cache QCM data, and submits answers through `grade_qcm_question`.
- `../supabase-runtime.js` builds the picker and exam session from those records. It uses `questions_answers` only through the grading RPC.
- Both `index.html` and `quiz.html` load the same Supabase client, auth manager, data adapter, and runtime. Relative asset URLs and the manifest scope support GitHub Pages at `/DLMED/`.

The current site is static HTML/JavaScript and has no separate bundler or build command. GitHub Pages serves the checked-in files directly; publishing requires no generated build directory.

## Original bank and import utilities

The original 590 QCM were imported from the 17 JSON files in the workspace `work/supabase-import` folder. Those files preserve the question text, choices, correct letters, and explanations. The public site does not load QCM from these JSON files; it reads the Supabase tables.

- `catalog.json` describes the optional subject/lesson seed catalog.
- `../scripts/seed-qcm-catalog.ps1` inserts missing catalog metadata. Do not run it for the current deployment unless you intend to add the empty Radiologie subject row.
- `../scripts/publish-qcm.ps1` publishes source JSON records through the Supabase REST API. It requires a Supabase secret key in the current PowerShell process; never commit or share that key. The 590 production QCM are already present, so do not rerun it against this project as part of a Pages deployment.
- `../scripts/export-existing-qcm.mjs` exports the archived local question bank into JSON; it does not contact Supabase.

## Deployment and verification

There is no `package.json`, build step, or configured automated test runner in this static site snapshot. Verify the JavaScript syntax and static asset paths, then publish the site files at the repository root so `./quiz.html`, `./supabase-config.js`, the manifest, icons, and service worker resolve under `/DLMED/`.

Production verification on 2026-11-04 confirmed the published picker counts (90, 90, 30, 380) and opened the first Biochimie lesson, displaying its first question and choices from the 30-question lesson. A new deployment is not required for the Supabase data import itself; these local files document the applied migration and current database state.

## Google Auth and single active DLMed session

The static client now uses Supabase Auth PKCE with Google, persists the Supabase session, requires a unique username on first login, and checks the active session before every QCM read or grading request. The database also blocks catalog/question reads and grading until that account has a saved profile username, so the client-side username screen is not the only enforcement. The browser stores a device UUID, but authorization comes from the signed Supabase `session_id` claim and the database row, never from that UUID or local storage alone. QCM response caching is disabled so a signed-out visitor cannot reopen the question bank offline.

Apply `migrations/20261105_google_auth_single_session.sql` in the Supabase SQL Editor after the existing grading migration. It adds `profiles`, `dlmed_active_sessions`, and a rate-limit table for username availability. It also removes anonymous QCM/catalog reads and adds restrictive active-session RLS policies. Do not deploy the frontend before applying the migration: until it is applied, the current public-read policies remain in force. The SQL smoke checks are in `tests/20261105_auth_single_session.test.sql`; run them with `supabase test db` in a linked/local Supabase environment.

### Dashboard setup

1. In Google Cloud Console, create a Web OAuth client and add `https://alfziyssfhiabqgmzlsb.supabase.co/auth/v1/callback` as an authorized redirect URI.
2. In Supabase Dashboard → Authentication → Sign In / Providers → Google, enable Google and enter that OAuth client's ID and secret. Keep the secret in the dashboard only. Disable other sign-in providers if DLMED must accept Google accounts exclusively; the database claim also requires a Google identity and an OAuth-authenticated session.
3. In Supabase Dashboard → Authentication → URL Configuration, set the production Site URL to `https://dlmed.fyi` and allow the deployed redirect URL `https://dlmed.fyi/**`. If the GitHub Pages project URL is also used, allow `https://dzoombi.github.io/DLMED/**` too.
4. Confirm the Supabase JWT expiry in Authentication → Sessions. A short, reasonable expiry limits how long a revoked access JWT can be used against endpoints that do not consult PostgreSQL; all DLMed QCM endpoints do consult the active-session row.
5. Supabase's optional Auth setting **Single session per user** may be enabled as extra protection when available on the project's plan. The DLMed row lock and RLS are the immediate app-level enforcement; the Auth setting's refresh-token enforcement is not instantaneous.

### Session revocation boundary

Every request for the catalog, questions, or grading must pass the current `session_id` check in PostgreSQL. A second device atomically replaces the active row under a per-user database lock and deletes the previously active row from `auth.sessions` (which also invalidates its refresh session). A persistent inactive row is retained at logout as a high-water mark, so an older token cannot claim the slot again. Only the newest Supabase login session, newer than the last DLMed claim, can claim the slot. Logging out marks the row inactive before the browser signs out. The old client detects replacement on its next 12-second heartbeat (or when the tab becomes visible), clears the page, signs out locally, and shows the French message.

Supabase access JWTs remain cryptographically valid until their `exp` time; Supabase documents that access JWTs cannot be revoked before expiry. DLMed's RLS and grading RPC check both the active row and `auth.sessions`, so the replaced token is denied access to DLMed database content immediately after the claim commits. A suspended/offline browser cannot be notified until it reconnects, and already-rendered pixels cannot be remotely erased. No service-role key is used in browser code.

The SQL migration and Dashboard provider settings have not been applied by this local project snapshot. Google OAuth, two-device revocation, live RLS behavior, and username uniqueness therefore still require deployment and tests against the actual Supabase project.

### Post-deployment checks

- With no session, open both `index.html` and `quiz.html`; no catalog/questions request should succeed, and the question cache key must remain absent.
- Sign in with Google on device A, choose a valid username, reload, and confirm the username form is skipped. A second account must not be able to reserve the same name with different letter case.
- Sign in to the same Google account on device B. Device B should load the modules; device A should lose QCM access immediately at the database and show the exact session-replaced message on its next heartbeat or focus.
- From device A's old access token, verify direct reads of `subject`, `lessons`, and `questions`, and `grade_qcm_question`, are rejected after B claims the session. Confirm that A's prior `auth.sessions` row is gone. Do not place JWTs in logs or issue trackers.
- Log out on B, confirm its `dlmed_active_sessions.is_active` is false, then sign in again and confirm a newer Supabase session can claim the slot. Reload and navigate between the welcome page and quiz page.
- Run the pgTAP migration checks and inspect table/column grants, including that `anon` has no `questions.question` privilege and `authenticated` has no `questions_answers.correct_options` privilege.
