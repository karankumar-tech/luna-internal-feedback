# Luna Internal Feedback API

Node.js + TypeScript (Fastify) API backed by Supabase Postgres. Receives feature-level
feedback from the Luna iOS app (Stage builds), serves a form schema the app renders
from, and keeps the issue-category master lists editable without a redeploy.

All tables live in the `luna_feedback` schema of the Supabase project, isolated from
anything in `public`. See [PLAN.md](PLAN.md) for the full design.

| page | URL | access |
|---|---|---|
| API reference for front-end teams | `/docs` | public |
| Home: issues today and over 7 days, issues by category, and the paginated report list (filters on demand) | `/dashboard` | signed-in account |
| Report an issue: the app's form, rendered from the same schema, with screenshots. For what internal people see on production and UAT builds, which have no form of their own | `/dashboard/report` | signed-in account (any role) |
| Settings: report categories, AI diagnosis queue, test data | `/dashboard/settings` | signed-in account (changes need admin or QC) |
| Needs attention (untouched, stale, CX waiting, stuck diagnoses, getting worse, same ring) | `/dashboard/attention` | signed-in account |
| Analytics (what kind of issues, where the fault sits) | `/dashboard/analytics` | signed-in account |
| Issue kinds (recurring problems and how often) | `/dashboard/kinds` | signed-in account |
| Diagnosis overview | `/dashboard/diagnosis` | signed-in account |
| Benchmarks: the same workout or night on Luna and another device, from an Apple Health export | `/dashboard/benchmarks` | signed-in account (importing and editing need admin, QC or developer) |
| People (accounts, roles, passwords) | `/dashboard/users` | admin |

Reports are tagged `stage`, `uat` or `production`, defaulting to `stage`, and every screen
filters by it. They also carry an origin: `internal` (testers, through the app or the dashboard's Report page) or `cx` (customer
problems filed by CX from its own tool), with its own filter on every screen. A report filed from the dashboard
posts to the same `POST /v1/feedback/{feature}` as the app, is stored with `submitted_via: dashboard`, and its
history names the person who filed it.

Every report has a readable reference, `LN-00042`, and every issue kind one of its own, `LNK-0007`.
Existing rows were numbered oldest first; numbers are never reused. `/i/LN-00042` and `/k/LNK-0007`
(and `/b/BM-0007` for a benchmark session) are short links to share (the page behind them needs a sign-in), and `GET /v1/feedback/{id}` accepts
a reference as well as the uuid.

The pages are plain HTML in `src/pages/`, with the scripts they load in `src/pages/scripts/`
(served at `/dashboard/assets/<name>.js`), and are embedded into the server bundle by
`npm run pages:embed` (runs automatically before dev/build/test; the generated
`src/pages/generated.ts` is committed). Design tokens follow
[docs/design/luna-design-system.html](docs/design/luna-design-system.html).

## Setup

```bash
npm install
cp .env.example .env      # then fill in SUPABASE_DB_URL, APP_API_KEY, ADMIN_API_KEY, DASHBOARD_KEY
npm run db:migrate        # applies supabase/migrations/*.sql once each
npm run dev               # http://localhost:3000
```

| script | what it does |
|---|---|
| `npm run dev` | dev server with reload |
| `npm run build` / `npm start` | compile to `dist/` and run |
| `npm test` | unit + integration tests (integration hits the DB in `.env`, cleans up after itself) |
| `npm run db:migrate` | apply pending migrations (tracked in `luna_feedback.schema_migrations`) |
| `npm run db:verify` | print tables, RLS state, seed counts, grants |
| `node scripts/seed-demo.mjs 60` / `--clean` | insert demo submissions flagged `is_test`, or delete every `is_test` row (also possible from the dashboard) |
| `scripts/smoke-remote.sh <url>` | post-deploy checks against a live deployment |

## Auth

| header | grants |
|---|---|
| `x-api-key: <APP_API_KEY>` | app routes under `/v1/feedback` |
| `x-api-key: <CX_API_KEY>` | the CX tool: `/v1/cx/*`, the form schema and screenshot uploads, nothing else. Every report it files is a CX report |
| `x-admin-key: <ADMIN_API_KEY>` | everything, for automation and scripts. Not tied to a person |
| dashboard session cookie + `x-requested-with: dashboard` | whatever the signed-in account's role allows |

`GET /healthz`, `/docs`, and the dashboard pages are open; the data behind them is not.
The session is a signed, HttpOnly cookie valid for `DASHBOARD_SESSION_DAYS`.

### People and roles

Dashboard sign-in is by email and password. The first time a deployment runs no admin account
exists, so the sign-in page offers to create one — that form needs `DASHBOARD_KEY` as proof of
access. After that, people are added from `/dashboard/users`.

**Getting back in.** `DASHBOARD_KEY_LOGIN` defaults to `true`, which keeps `DASHBOARD_KEY`
working as a master key: it signs in as an admin however many accounts exist. Set it to `false`
once everyone has their own account and the key reverts to bootstrap-only — it then stops
working as soon as an admin account exists, and starts working again if every admin is ever
removed or disabled, so a deployment can never become unreachable. Two more ways back:

- `SUPERADMIN_EMAIL` — optional. That address signs in with `DASHBOARD_KEY` as its password and
  is always an admin. It needs no row in the database, and it names master-key sessions in the
  account log. A real account with the same email always takes precedence.
- `npm run users:grant-admin -- someone@nexxbase.com "Their Name"` — from any machine with
  `SUPABASE_DB_URL`, creates or promotes an admin and prints a one-time password. Works whatever
  state the accounts are in.

| role | can |
|---|---|
| `admin` | everything, including adding and removing people |
| `qc` | Jira, triage and issue status, tags, issue kinds, diagnosis and review, benchmarks |
| `developer` | tags, issue kinds, diagnosis and review, benchmarks. No Jira, triage or people |
| `business` | read-only across the dashboard |
| `cx` | read-only, plus the AI on a report (diagnose, chat). CX files reports from its own tool, not the dashboard |

The permission table lives in [`src/lib/actor.ts`](src/lib/actor.ts) and is enforced per
route; the dashboard hides what a role cannot use, and the server refuses it either way.
Filing a report from `/dashboard/report` needs no permission: every signed-in account can.
What a person enters there about themselves (Luna user id, email, ring serial, phone and ring details) is
saved on their account (`PATCH /v1/me/reporter`, returned by `GET /v1/me`) and prefilled next time, on any
browser; the fields stay editable.

Passwords are scrypt-hashed with their parameters stored alongside the hash, so the cost can
be raised later without invalidating anyone. They must be at least 10 characters with a
letter and a digit, must not contain the account's own name or email, must differ from the
last `PASSWORD_HISTORY_DEPTH` (5), and expire after `PASSWORD_MAX_AGE_DAYS` (30). An admin can
issue a password from `/dashboard/users`: it is shown once, never stored in the clear, and the
recipient must replace it at first sign-in. Changing a password signs out that account's other
sessions. `LOGIN_MAX_ATTEMPTS` failures lock an account for `LOGIN_LOCK_MINUTES`.

If you are ever locked out entirely, delete the rows in `luna_feedback.dashboard_users` and the
sign-in page will offer the first-admin form again.

## Endpoints

### Schema (form building)

```bash
curl -H "x-api-key: $APP_API_KEY" localhost:3000/v1/feedback/schema
curl -H "x-api-key: $APP_API_KEY" localhost:3000/v1/feedback/schema/sleep
```

Returns `schema_version`, `common_fields`, and per-feature `issue_categories`, `fields`,
and `rules`. Responses carry an `ETag`; send it back as `If-None-Match` to get a `304`.

Field types the app must render: `boolean`, `text` (maxLength), `date` (YYYY-MM-DD),
`number` (min/max/integer), `time_12h` ("HH:MM AM/PM"), `string` (maxLength, optional
`options`), `multi_select` (options come from `issue_categories`).

### Submit

```bash
curl -X POST localhost:3000/v1/feedback/sleep \
  -H "x-api-key: $APP_API_KEY" -H "content-type: application/json" \
  -H "Idempotency-Key: 5f1c-…" \
  -d '{
    "is_positive": false,
    "occurred_on": "2026-09-01",
    "user_id": 10482,
    "email": "tester@luna.app",
    "issue_categories": ["incorrect_sleep", "vitals_not_recorded"],
    "feedback_text": "Ring said 4h, I slept 7h.",
    "details": { "actual_start_time": "11:30 PM", "actual_end_time": "06:45 AM" },
    "client": { "app_version": "2.4.0", "build_number": "512", "build_channel": "stage",
                "firmware_version": "1.9.2", "os_version": "iOS 19.1", "device_id": "…", "session_id": "…" }
  }'
```

- `201` with the stored row on success; `200` with the original row if the
  `Idempotency-Key` was seen before (safe for offline-outbox replays).
- `422` with `error.issues[]` (`path`, `message`) on validation failure.
- `404` for an unknown or deactivated feature.

Common fields are identical for every feature. `details` holds the feature-specific
fields listed by the schema; unknown keys are rejected. `client` is optional.
Timestamps: `created_at` is ISO 8601 UTC, `created_at_ist` is `YYYY-MM-DD HH:mm:ss +05:30`.

### Read

```bash
curl -H "x-api-key: $APP_API_KEY" "localhost:3000/v1/feedback?feature=sleep&from=2026-09-01&limit=50"
curl -H "x-api-key: $APP_API_KEY" localhost:3000/v1/feedback/<id>
```

Filters: `feature`, `platform`, `user_id`, `from`, `to` (on `occurred_on`), `is_positive`, `category`.
Pagination: pass the `next_cursor` from one page as `cursor` on the next.
`GET /v1/feedback/stats` takes the same filters and returns totals, per-day, per-feature, and per-category aggregates.

### Admin (issue-category master list)

```bash
curl -H "x-admin-key: $ADMIN_API_KEY" localhost:3000/v1/admin/features
curl -X PATCH -H "x-admin-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  localhost:3000/v1/admin/features/workout -d '{"is_active": false}'

curl -H "x-admin-key: $ADMIN_API_KEY" localhost:3000/v1/admin/features/home/issue-categories
curl -X POST -H "x-admin-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  localhost:3000/v1/admin/features/home/issue-categories \
  -d '{"key": "widget_missing", "label": "Widget missing", "sort_order": 40}'
curl -X PATCH -H "x-admin-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  localhost:3000/v1/admin/issue-categories/<id> -d '{"is_active": false}'
```

Categories are never deleted. Deactivating removes them from the schema and rejects
them on new submissions; old rows keep their keys.

## CX reports

CX files customer problems from its own tool: an agent checks the problem is real, then presses a
button that calls `POST /v1/cx/feedback/{feature}` with `CX_API_KEY`. The ring serial and the CX
ticket (`cx.ref`) identify the report; **a customer's email is never accepted or stored**, and any
address or phone number in the free text is redacted first. The Luna user id and device details
are filled in afterwards from the production logging service by serial. Pressing the button twice
for the same ticket and feature returns the first report. `GET /v1/cx/feedback/{ref}` tells the
tool where a report stands. Contract: [docs/API.md §5b](docs/API.md).

## Same issue, counted

Every issue report gets a **Similar reports** panel: reports from the 90 days around it that look
like the same problem, best first, each saying why (same feature, same categories, wording N% alike,
shared diagnosis tags or catalog events, same firmware / app / platform). Tick the look-alikes and
**Mark as same issue** puts them all under one problem (`LNK-…`), creating it if needed with this
report as the one to read first. **Ask AI to check** (about $0.002) labels them same / related /
different and ticks the same ones.

When a report arrives it is matched against open problems; a clear match shows on it as "Looks like
LNK-0007 … Confirm / Not this", and the CX API returns it as `likely_problem`. "Clear" means two
symptoms agree (say the same category and similar wording, or shared log tags): a shared build or
platform is only a tie-breaker, and a catch-all category such as "Something else" never counts. Links are *suggested*,
*linked* or *rejected*: only linked ones count anywhere, and a rejection is remembered so no rule or
diagnosis puts it back. CX can suggest a problem for QC to confirm. A problem's page lists more
reports like it, lets you pick the reference report, and merges duplicates (the merged title becomes
an alias, so the AI stops recreating it). Scoring lives in `src/modules/similar/similarity.ts`.

## Owners, priority, notes and history

Every report keeps a history: when it arrived, every status, owner and priority change, problem
links, Jira tickets, diagnosis runs and notes, with who did it. Any dashboard user can own a report
or a problem; **My queue** on the dashboard shows yours. QC sets a priority (P0–P3) that overrides
the AI's severity. Notes are team-only or customer-safe; CX users can write both, and the CX tool
reads the latest customer-safe one and can post replies back. **Needs info** parks a report while
waiting on the tester or customer (Ask reporter posts the AI's questions and sets it); a reply
through the CX tool puts it back where it was. The dashboard list does bulk status, owner, priority
and tag changes.

**Tags** are short labels on a report, such as `app` or `firmware`: free-form, stored lowercase
(spaces become dashes), up to 10 per report. QC and developers add them on the report page, where
`app` and `firmware` are one click and tags already in use are suggested; QC can also tag many
reports at once from the list. The list filters by a tag, by several (any of them) or by
**Untagged**, and clicking a tag on a row filters by it. Tags go onto Jira tickets as `tag-…` labels,
and every change is in the report's history.

**Go-live date.** A report can carry the date its fix is planned to go live. It is optional: admin, QC
and developers set, move or clear it on the report page (`PATCH /v1/admin/submissions/{id}/go-live` with
`{ "go_live_on": "YYYY-MM-DD" | null }`), every change is in the history, and the list shows it on each
row, filters by it (`go_live=any|none`, `go_live_from`, `go_live_to`) and exports it in the CSV.

Analytics shows time to first response and to resolve, per source, and time in each status.

## Needs attention

`/dashboard/attention` (`GET /v1/attention`) lists what someone should look at now: reports nobody
has touched (CX after 1 day, internal after 3), reports that went stale (CX 3 days, internal 7),
every open CX report, reports waiting on the reporter for over a week, stuck diagnoses, and big
problems with no owner or no Jira ticket. A priority replaces the limits: P0 after 4 hours untouched
(1 day without progress), P1 after 1 day (3 days), P3 after twice the usual time; without one,
critical AI severity halves them. Within a list, items sort by severity × (1 + log2(people
affected)) × (1 + age / 7), where a customer counts twice. The limits live in
`src/modules/attention/attention.service.ts`.

It also shows what is **getting worse**: problems and categories with at least 3 reports over the
last 3 days and 3× their daily average of the 14 days before, and fixed problems that **came back**.
Give a fixed problem the app or firmware version its fix ships in; a report later linked to it that
ran that version or newer is flagged as a regression, the problem reopens as watching, and the report's
history says why (versions compare as dotted numbers; a missing or unreadable version never flags).
**Same ring, many reports** lists rings (or, without a serial, people) with 3+ problem reports in 14
days, customers first, since for them it often means a faulty ring; the report page says the same.

A problem's page shows **where it happens** (its firmware, app version, phone OS and platform mix
against all problem reports in the same filters, and the oldest versions it was reported on), and
Analytics shows **caught by testing first?**: of the problems customers reported, how many an internal
report reached first, by how long, and which ones testing missed. The rules live in
`src/modules/kinds/pinpoint.ts`.

## AI diagnosis

Diagnosis runs on demand from a submission's page (Diagnose now), or automatically for every negative
submission when `DIAGNOSIS_AUTO=true`. The tester's logs are looked up in the Luna logging API
(`device_serial` first, `email` fallback), one file per source covering the issue day is fetched, the
≤100 most relevant lines around the issue time are extracted and redacted, and an OpenRouter model
returns a structured verdict
(`root_cause_side`, confidence, severity, tags, evidence, suggested fix). Results live in
`luna_feedback.diagnoses` with `ai_*` columns denormalised onto `submissions`.

- **Log window.** Only uploads dated the day before the issue, the issue day and the day after are ever
  used, listed or waited for (`LOG_WINDOW_DAYS` in `logs/select.ts`). A diagnosed ticket shows the
  files it was diagnosed from, read from the database, and makes no call to the logging service; the
  service keeps only a rolling set of recent uploads, so those stored links are often the only record.
- Runs after the HTTP response via `waitUntil` (Vercel) or `setImmediate` (local). Same-day reports
  park as `waiting_logs` until the evening log sync (`DIAGNOSIS_SYNC_HOUR_IST`) and retry, and are
  finalised as `no_logs` once the day after the issue has ended.
- `POST /v1/admin/diagnoses/run-pending` finishes runs that are waiting for logs (and, in automatic
  mode, backfills undiagnosed issues); the dashboard calls it on load and `vercel.json` schedules it
  nightly (needs `CRON_SECRET`). A finished diagnosis is never re-run unless someone presses Re-run.
- Detail page: `/dashboard/submissions/{id}` (verdict, evidence linked to the excerpt, log file links,
  Diagnose now / Re-run, Agree / Disagree review).
- **Log hosts per environment.** Stage reports are looked up on `LUNA_LOGS_BASE_URL_STAGE`
  (or the older `LUNA_LOGS_BASE_URL`), production ones on `LUNA_LOGS_BASE_URL_PRODUCTION`
  (`https://app.gonoise.com`), with the same `LUNA_LOGS_APIKEY`. UAT has no host until
  `LUNA_LOGS_BASE_URL_UAT` is set: its reports are never looked up and Diagnose is disabled for them.
  Do not use `/logging/falcon/admin/list`: it ignores the email filter and returns other users' uploads.
- Env: `LUNA_LOGS_APIKEY`, `OPEN_ROUTER_KEY`, `OPENROUTER_MODEL`, `DIAGNOSIS_AUTO`,
  `DIAGNOSIS_DAILY_BUDGET_USD`, `DIAGNOSIS_SYNC_HOUR_IST`, `CRON_SECRET`. Missing keys disable
  diagnosis without affecting submissions.
- `node scripts/diagnose-live.mjs <email> <serial|-> <feature> <YYYY-MM-DD> [platform]` runs one
  real diagnosis locally (creates and removes an `is_test` submission; `KEEP=1` keeps it).

Design: [docs/PLAN-diagnosis.md](docs/PLAN-diagnosis.md).

### Event catalog

Diagnoses are grounded in the vendor's critical-event sheets. `npm run catalog:build` compiles
[`reference/luna-critical-events.xlsx`](reference/luna-critical-events.xlsx) into 133 curated
events and ~900 vendor log-line definitions, written to `catalog.json` (for reading) and
`catalog.generated.ts` (what the app imports). The build runs automatically before `dev`,
`build`, `typecheck` and `test`, so the artifacts cannot drift from the workbook.

At diagnosis time the excerpt is scanned for the literal log fragments each entry carries, and
only the entries that actually matched are injected into the prompt — the model gets the
relevant handful, not the whole catalog. Verdicts may cite event ids (`FW-01`, `RL-07`,
`APP-22`); ids that do not exist in the catalog are dropped before anything is stored.
Browse them at `GET /v1/catalog/events`. To take a new workbook revision, replace the file
and re-run the build; review the `catalog.json` diff.

### Per-ticket chat

A submission's page carries up to `DIAGNOSIS_CHAT_MAX_MESSAGES` (10) follow-up questions about
its own diagnosis, stored with the ticket. The model sees that ticket, its verdict, the same log
excerpt and the matched catalog entries — nothing else. A failed model call does not spend a turn.

## Issue kinds

Tickets group into the recurring problem behind them ("Sleep start recorded hours late"), so the
question "how much of this is happening?" has an answer. A diagnosis suggests a kind and links it
automatically, matching against existing kinds by normalised title so synonyms do not multiply;
anyone can also link or create one by hand from a ticket. `/dashboard/kinds` lists them with
counts, share, affected testers and a per-day trend.

## Jira

Optional. Set all four of `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` and `JIRA_PROJECT_KEY`
(plus optional `JIRA_ISSUE_TYPE`, default `Bug`, and `JIRA_LABELS`). Until they are set, every
Jira action answers **"Jira integration pending"** and nothing else changes.

With them set, one click on a submission files an issue carrying the tester's words, the verdict,
the evidence lines and a link back to the dashboard (`PUBLIC_BASE_URL`), and stores the key. A
second click never opens a second ticket. Issue kinds can have their own ticket for the whole
recurring problem. `POST /v1/admin/jira/check` verifies the credentials without creating anything;
`POST /v1/admin/jira/refresh-stale` re-reads cached workflow statuses.

## Analytics

`/dashboard/analytics` answers what kind of issues are coming in, over the same filter slice as the
list so any two numbers can be compared: reports per day, issue kinds by share, reported categories,
catalog events seen in logs, where the fault sits, environment split, triage state, who is
reporting, and firmware and app versions. Served by `GET /v1/analytics/overview`.

The page ends with model usage: input and output tokens per day for the last 30 days, by model,
with the model currently in use. Every OpenRouter call adds to `model_usage_daily` and rows older
than 30 days are dropped as new ones land. Served by `GET /v1/analytics/model-usage`, unfiltered.

## Benchmarks

`/dashboard/benchmarks` compares what Luna recorded with what another device (Polar, Garmin,
Fitbit, Apple Watch…) recorded for the same workout or the same night. A tester wears both, lets
both apps sync to Apple Health, exports from the Health app (profile picture, Export All Health
Data) and drops `export.zip` (or the `export.xml` inside it) on the page.

**The file never leaves the browser.** An export is often hundreds of megabytes and a request to
the API may carry 4.5 MB, so [`src/pages/scripts/health-export.js`](src/pages/scripts/health-export.js)
reads it where it is, as a stream, in two passes: first it lists every workout and night in the
file, then it collects the samples recorded during the sessions someone ticked. Only that is sent,
one session per request. Nothing of the file is stored anywhere.

**Already imported?** `POST /v1/admin/benchmarks/check` takes the list from the first pass and says
which workouts from different sources are one session (they mostly overlap in time; two from the
same source never are), and which are stored already. A recording is recognised by its source, kind,
start and end, so uploading a later export adds only what is new. When a later export has another
device's recording of a stored session (same tester, overlapping time), it joins that session
instead of making a second one.

**One workout, two sessions.** A device whose clock is off writes the same workout to Health at a
different time, and recordings that do not overlap are not grouped. The session page lists this
tester's sessions recorded within half an hour by other devices ("Recorded close to this one") and
can merge one in: its recordings move over, the two are compared at the times each device wrote
(the start difference shows as such), and the merged-in reference stops existing. A device that
logged a workout in both is never offered: that is two workouts. `npm run benchmarks:merge-nearby`
lists every stored pair that looks like this (different devices, starting within 20 minutes of each
other, similar length) and merges them with `-- --apply`; it was written for a one-time clean-up.

**Screenshots.** A session can carry up to 6 screenshots (what each device's app showed for that
workout or night), added from its page by button or by dropping images on the card. The page shrinks
each to 1600 px, uploads it straight to ImageKit with a short-lived signature (folder
`<IMAGEKIT_FOLDER>/benchmarks`) and then attaches it to the session
(`benchmark_sessions.screenshots`, migration `20261005000000_benchmark_screenshots.sql`). Removing
one, or deleting the session, deletes the image; a merge keeps both sessions' screenshots up to 6.
Clicking a screenshot, here or on a report's page, opens it full size over the page
(`LunaShell.viewer` in [`shell.js`](src/pages/scripts/shell.js)): arrow keys, a swipe or the strip
move between them, Escape closes, and Cmd/Ctrl-click still opens the image in a new tab.

**The Luna build.** Each session holds the band's firmware, the Luna app's version and the phone
(`firmware_version`, `app_version`, `platform` `ios|android`; migration
`20261009000000_benchmark_luna_build.sql`). An Apple Health export cannot supply them (Luna writes
only a build number there), so they are typed in on the import page or the session page. A tester
keeps the same band and phone from one test to the next, so both pages start from what was last
entered for that tester (`build_set_at` dates each entry; `check` and the session's `last_build`
return it). Saving a session sends the build only when it changed, so editing a note on an old
session does not make its build the latest.

**What is stored** (migration `20261002000000_benchmarks.sql`): `benchmark_sessions` (`BM-0007`, a
workout or a night for one tester, with the comparison in `summary`) and `benchmark_recordings`
(one per Apple Health source: its totals in `metrics`, samples over time in `series`, sleep
`stages`, GPS `route`). Metrics are keyed by name, not by column, so whatever a device writes is
kept: an identifier the code has never seen still gets a key, a label and a way to total it
([`metrics.ts`](src/modules/benchmarks/metrics.ts)). A source that logged no workout of its own but
has samples in the window (the phone counting steps) is kept as background.

**Who is tested against whom.** Each source gets a brand tag, guessed from its name and hardware and
correctable on the session page (a correction is remembered for that source). The recording tagged
`luna` is the device under test; the others are references, best first (chest straps and sports
watches before the phone). With no Luna recording the best reference stands and the rest are
measured against it.

**The numbers** ([`analyze.ts`](src/modules/benchmarks/analyze.ts), pure functions, no model):

- Heart rate on its own: average and time per range weigh each reading by how long it stood, so a
  burst of readings does not count for more; coverage, gaps, and stretches of 40 s or more on one
  exact value (a device repeating itself).
- Heart rate against the reference, in half-minute blocks over the time both were recording:
  typical (mean absolute) gap, lean high or low, correlation, share within 5 and 10 bpm, the first
  three minutes apart from the rest, and whether the device trails the reference.
- Every total both reported (duration, distance, pace, calories, steps…) with the difference and a
  verdict: match within about 2% or 3 bpm, close within about 5% or 7 bpm, otherwise differs.
  Calories are "not comparable" when the two apps were given different body weights.
- Max pace, for a run, walk or hike: the fastest pace held for at least 30 s. No device writes it to
  Apple Health, so it comes from the finest detail each wrote: its own top speed, else its GPS
  track (a fix jumping faster than 43 km/h adds no distance; anything faster than 2:00 /km is
  ignored), else its distance readings when they come in pieces of 2 minutes or less, else its
  speed readings. Luna and Google Health write distance in pieces of several minutes, which cannot
  show a fastest stretch, so a max pace read off any device's app can be typed in instead
  (`max_pace_s`). The comparison row says where each side's number came from.
- VO2max (the Health app's "Cardio Fitness"): devices estimate it once a day (Google Health writes
  one at midnight) or just after an outdoor workout, never during it. The import takes each
  source's first reading from the workout's start to a day after it ends, else its last in the day
  before; it shows as that device's estimate with its date.
- Sleep: stages laid on 30-second steps; time in bed, time asleep, time to fall asleep, time awake
  after that, awakenings, efficiency and each stage; and epoch by epoch agreement with the
  reference (asleep or awake, stage by stage, kappa, the confusion table).

- A total a device only reports by the hour or by the day (Luna's steps and calories outside a
  workout) is left out of a session shorter than that; a total pieced together from samples that
  straddle the session's edges is marked as an estimate.
- The list shows who logged each session as solid chips; a device that only has readings from that
  time (Luna's all-day heart rate under another device's workout) is marked "heart rate only", and
  a session with nothing compared says why in a few words (`summary.why`).
- When something cannot be compared, the session says why (`summary.gaps`): a device that did not
  log the workout itself, or one that wrote no heart rate to Apple Health for that time.

Stored sessions carry the version of the analysis that produced them (`ANALYSIS_VERSION`); when it
changes they are redone the next time they are listed or opened.

**Export to Excel.** Both pages have an Export to Excel button
([`export.ts`](src/modules/benchmarks/export.ts), written with a small `.xlsx` writer in
[`src/lib/xlsx.ts`](src/lib/xlsx.ts) on `fflate`; no new dependency). A session's workbook holds a
summary (what it is, the headline, what stands out, a guide to the other sheets), the side by side
comparison, the agreement numbers with what each means, the stage table for a night, every device's
own numbers, the devices and their roles, heart rate on one clock (averaged as the page draws it),
every heart rate reading, held values and gaps, time in heart rate ranges, sleep stages, every other
reading and the GPS route; a sheet with nothing in it is left out. The list's workbook covers every
session its filters match (up to 2,000): one line per session, every comparison row, the agreement
per pair and the findings, without readings. Times are the wearer's own clock. Units sit in the
number formats (`142.0 bpm` is the number 142), so columns still sort, filter and sum; percentages
are kept as Excel percentages and lengths as Excel times, because Apple's Quick Look preview
misreads a `%` or a time with text added.

On the charts Luna is orange, the phone grey, and whatever Luna is compared with takes blue, then
green, then ink: the hues that stay apart from orange as thin lines.

The page's heart rate line uses the same averaging as the sample report it was modelled on (5 s up
to half an hour, 10 s beyond), on round clock times; "Every reading" shows the raw samples.

| endpoint | does |
|---|---|
| `GET /v1/admin/benchmarks?kind=&device=&tester=&is_test=&comparable=&limit=&offset=` | sessions, newest first, with each one's comparison summary and the filter values in use. `comparable=true` keeps only sessions where two devices have something to compare |
| `GET /v1/admin/benchmarks/export?kind=&device=&tester=&is_test=&comparable=` | every session the filters match, as an Excel workbook |
| `GET /v1/admin/benchmarks/{id or BM-ref}` | one session with every recording's metrics, series, stages and route, and `nearby` sessions it could be merged with |
| `GET /v1/admin/benchmarks/{id or BM-ref}/export` | one session as an Excel workbook, with every reading |
| `POST /v1/admin/benchmarks/check` | which workouts and nights from an export are one session, and which are stored; `last_build` is the Luna build last entered for the tester |
| `POST /v1/admin/benchmarks/import` | one session's recordings (201 created, 200 updated or unchanged), with the Luna build optionally; a stored session that gains a device keeps its own build |
| `PATCH /v1/admin/benchmarks/{id}` | title, notes, tester, test flag, and the Luna build: `firmware_version`, `app_version`, `platform` (`ios`/`android`; `null` or `""` clears) |
| `PATCH /v1/admin/benchmarks/{id}/recordings/{rid}` | brand tag and device name; for a workout Luna logged `distance_km` and `active_kcal` (typed in from its app, since Luna does not always write them to Apple Health); for any device's run, walk or hike `max_pace_s` (seconds per km). `null` clears one; redoes the comparison |
| `POST /v1/admin/benchmarks/{id}/merge` | `{ "other": id or BM-ref }` joins another session into this one |
| `GET /v1/admin/benchmarks/screenshot-auth` | ImageKit upload credentials for one screenshot |
| `POST /v1/admin/benchmarks/{id}/screenshots` | `{ file_id, url, name?, width?, height?, size? }` attaches an uploaded image (409 once there are 6) |
| `DELETE /v1/admin/benchmarks/{id}/screenshots/{file_id}` | detaches a screenshot and deletes the image |
| `DELETE /v1/admin/benchmarks/{id}` and `…/recordings/{rid}` | remove a session, or one device from it |

All under `/v1/admin`, so a dashboard session or the admin key is needed: this is testers' health
data and the app's key cannot read it. Reading is open to every role; the rest needs
`manage_benchmarks` (admin, QC, developer).

## Adding a field or feature

1. Edit `src/schema/registry.ts` (fields, rules, or a new entry in `FEATURE_KEYS` and `FEATURE_DEFINITIONS`).
2. For a new feature, add a migration inserting it into `luna_feedback.features` with its categories.
3. Bump `SCHEMA_VERSION` if the change is not backward compatible.

Both the schema endpoint and the validator read the registry, so nothing else changes.

## Deploy (Vercel)

Zero-config: Vercel's Fastify preset detects `src/server.ts` as the entrypoint and
intercepts `app.listen()`, running the whole app as one Function. Do not add an
`api/` directory or a `src/app.ts` / `src/index.ts` file, both would change what Vercel
picks as the entry.

Set the variables from `.env.example` in the Vercel project settings, with
`DB_POOL_MAX=1` and a `SUPABASE_DB_URL` pointing at the transaction pooler (port `6543`).
Migrations are run from a developer machine with `npm run db:migrate`.
