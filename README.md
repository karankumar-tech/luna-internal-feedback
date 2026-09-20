# Luna Internal Feedback API

Node.js + TypeScript (Fastify) API backed by Supabase Postgres. Receives feature-level
feedback from the Luna iOS app (Stage builds), serves a form schema the app renders
from, and keeps the issue-category master lists editable without a redeploy.

All tables live in the `luna_feedback` schema of the Supabase project, isolated from
anything in `public`. See [PLAN.md](PLAN.md) for the full design.

| page | URL | access |
|---|---|---|
| API reference for front-end teams | `/docs` | public |
| Review dashboard (filters, charts, table, category management) | `/dashboard` | signed-in account |
| Analytics (what kind of issues, where the fault sits) | `/dashboard/analytics` | signed-in account |
| Issue kinds (recurring problems and how often) | `/dashboard/kinds` | signed-in account |
| Diagnosis overview | `/dashboard/diagnosis` | signed-in account |
| People (accounts, roles, passwords) | `/dashboard/users` | admin |

Reports are tagged `stage`, `uat` or `production`, defaulting to `stage`, and every screen
filters by it.

The pages are plain HTML in `src/pages/` and are embedded into the server bundle by
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
| `x-admin-key: <ADMIN_API_KEY>` | everything, for automation and scripts. Not tied to a person |
| dashboard session cookie + `x-requested-with: dashboard` | whatever the signed-in account's role allows |

`GET /healthz`, `/docs`, and the dashboard pages are open; the data behind them is not.
The session is a signed, HttpOnly cookie valid for `DASHBOARD_SESSION_DAYS`.

### People and roles

Dashboard sign-in is by email and password. The first time a deployment runs, nobody has an
account, so the sign-in page offers to create the first admin — that one form needs
`DASHBOARD_KEY` as proof of access. **Once any account exists, the shared key stops working
as a login**, and people are added from `/dashboard/users`.

| role | can |
|---|---|
| `admin` | everything, including adding and removing people |
| `qc` | Jira, triage and issue status, issue kinds, diagnosis and review |
| `developer` | issue kinds, diagnosis and review. No Jira, triage or people |
| `business` | read-only across the dashboard |

The permission table lives in [`src/lib/actor.ts`](src/lib/actor.ts) and is enforced per
route; the dashboard hides what a role cannot use, and the server refuses it either way.

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

## AI diagnosis

Diagnosis runs on demand from a submission's page (Diagnose now), or automatically for every negative
submission when `DIAGNOSIS_AUTO=true`. The tester's logs are looked up in the Luna logging API
(`device_serial` first, `email` fallback), one file per source covering the issue day is fetched, the
≤100 most relevant lines around the issue time are extracted and redacted, and an OpenRouter model
returns a structured verdict
(`root_cause_side`, confidence, severity, tags, evidence, suggested fix). Results live in
`luna_feedback.diagnoses` with `ai_*` columns denormalised onto `submissions`.

- Runs after the HTTP response via `waitUntil` (Vercel) or `setImmediate` (local). Same-day reports
  park as `waiting_logs` until the evening log sync (`DIAGNOSIS_SYNC_HOUR_IST`) and retry.
- `POST /v1/admin/diagnoses/run-pending` finishes runs that are waiting for logs (and, in automatic
  mode, backfills undiagnosed issues); the dashboard calls it on load and `vercel.json` schedules it
  nightly (needs `CRON_SECRET`). A finished diagnosis is never re-run unless someone presses Re-run.
- Detail page: `/dashboard/submissions/{id}` (verdict, evidence linked to the excerpt, log file links,
  Diagnose now / Re-run, Agree / Disagree review).
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
