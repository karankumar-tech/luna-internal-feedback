# Luna Internal Feedback API

Node.js + TypeScript (Fastify) API backed by Supabase Postgres. Receives feature-level
feedback from the Luna iOS app (Stage builds), serves a form schema the app renders
from, and keeps the issue-category master lists editable without a redeploy.

All tables live in the `luna_feedback` schema of the Supabase project, isolated from
anything in `public`. See [PLAN.md](PLAN.md) for the full design.

## Setup

```bash
npm install
cp .env.example .env      # then fill in SUPABASE_DB_URL, APP_API_KEY, ADMIN_API_KEY
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

## Auth

| header | grants |
|---|---|
| `x-api-key: <APP_API_KEY>` | app routes under `/v1/feedback` |
| `x-admin-key: <ADMIN_API_KEY>` | admin routes under `/v1/admin`, plus everything the app key can do |

`GET /healthz` is open.

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

Filters: `feature`, `user_id`, `from`, `to` (on `occurred_on`), `is_positive`, `category`.
Pagination: pass the `next_cursor` from one page as `cursor` on the next.

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

## Adding a field or feature

1. Edit `src/schema/registry.ts` (fields, rules, or a new entry in `FEATURE_KEYS` and `FEATURE_DEFINITIONS`).
2. For a new feature, add a migration inserting it into `luna_feedback.features` with its categories.
3. Bump `SCHEMA_VERSION` if the change is not backward compatible.

Both the schema endpoint and the validator read the registry, so nothing else changes.

## Deploy (Vercel)

`api/index.ts` wraps the Fastify app; `vercel.json` rewrites every path to it. Set the
variables from `.env.example` in the Vercel project settings, with `DB_POOL_MAX=1`
and a `SUPABASE_DB_URL` pointing at the transaction pooler (port `6543`).
Migrations are run from a developer machine with `npm run db:migrate`.
