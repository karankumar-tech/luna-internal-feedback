# Luna Internal Feedback — Backend Plan

Node.js + TypeScript API backed by Supabase Postgres. Receives feature-level
feedback from the Luna iOS app (Stage builds only), serves a form schema the
client renders from, and keeps the issue-category master lists editable
without a redeploy.

---

## 1. Decisions

| Area | Choice | Why |
|---|---|---|
| Runtime | Node 24, TypeScript (ESM) | Type-safe contract shared between schema and validator |
| HTTP | Fastify | Built-in JSON schema, fast, exportable for serverless or long-running |
| Validation | Zod, generated from a single field registry | The GET schema and the POST validator come from the same source, so they can never drift |
| DB access | `pg` over `SUPABASE_DB_URL`, fully-qualified `luna_feedback.*` names | No service-role key or Exposed-schemas toggle needed; typed SQL and transactions. RLS is still on with no policies so the anon/public API keys see nothing. Swapping to supabase-js later touches only the two `*.repo.ts` files |
| Isolation | Dedicated Postgres schema `luna_feedback` inside the existing Supabase project | Supabase exposes one database per project; a schema keeps these tables apart from the existing `public` tables (`vendor_clients`, `vendor_users`). Moves to another project later with `pg_dump --schema=luna_feedback`. Requires adding `luna_feedback` to Exposed schemas in Project Settings, Data API |
| Migrations | Plain SQL files in `supabase/migrations/`, applied by `npm run db:migrate` (tracked in `luna_feedback.schema_migrations`) | Reviewable, idempotent, no CLI login needed; file naming matches the Supabase CLI convention so `supabase db push` works later too |
| Feedback storage | One `submissions` table: common columns + `details jsonb` for feature-specific fields | Four features today, more later; avoids a new table per feature. `details` is validated against the registry before insert |
| Issue categories | DB table `issue_categories`, admin endpoints to add/rename/deactivate | Requirement: master list must be updatable |
| Field definitions | Code registry (`src/schema/registry.ts`), versioned | Field types carry validation rules (0-100, HH:MM AM/PM). Keeping these in code keeps validation typed and simple. Categories are the only piece that changes at runtime |
| Timestamps | `created_at timestamptz` stored in UTC; every response also returns `created_at_ist` formatted `Asia/Kolkata` | Storing local time in Postgres loses ordering guarantees across DST/zone edits; formatting at the edge is lossless |
| Auth | `x-api-key` shared secret for the app, separate `x-admin-key` for admin routes | Internal-only, Release binary excludes the module; matches the iOS side's `requiresAuth: false` endpoint plan |
| Hosting | `src/server.ts` is the single entrypoint; Vercel's Fastify preset detects it and intercepts `listen()`, `npm start` runs it as a plain server | Earlier plan pointed the iOS endpoint at a Vercel route |

---

## 2. Database schema

```sql
create schema if not exists luna_feedback;
set search_path to luna_feedback;

-- Feature registry
create table features (
  key         text primary key,            -- 'home' | 'sleep' | 'activity' | 'workout'
  label       text not null,
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Updatable master list of issue categories, scoped per feature
create table issue_categories (
  id          uuid primary key default gen_random_uuid(),
  feature_key text not null references features(key) on delete cascade,
  key         text not null,               -- stable slug, e.g. 'wrong_peak_score'
  label       text not null,               -- display text, e.g. 'Wrong peak score'
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (feature_key, key)
);

-- One row per submission
create table submissions (
  id               uuid primary key default gen_random_uuid(),
  feature_key      text not null references features(key),

  -- common, mandatory
  is_positive      boolean not null,
  occurred_on      date not null,          -- 'date' in the spec: day the issue occurred
  user_id          bigint not null,
  email            text not null,
  issue_categories text[] not null,        -- category keys, validated against issue_categories at insert
  created_at       timestamptz not null default now(),

  -- common, optional
  feedback_text    text check (char_length(feedback_text) <= 500),

  -- feature-specific fields (validated by the registry, shape documented in §3)
  details          jsonb not null default '{}'::jsonb,

  -- client context (optional; what the dashboards will slice by later)
  app_version      text,
  build_number     text,
  build_channel    text,
  firmware_version text,
  os_version       text,
  device_id        text,                   -- IDFV
  session_id       text,

  schema_version   int not null default 1
);

create index submissions_feature_created_idx on submissions (feature_key, created_at desc);
create index submissions_user_idx            on submissions (user_id, created_at desc);
create index submissions_occurred_idx        on submissions (occurred_on);
create index submissions_categories_gin      on submissions using gin (issue_categories);
create index submissions_details_gin         on submissions using gin (details);

alter table features         enable row level security;
alter table issue_categories enable row level security;
alter table submissions      enable row level security;
-- No policies: only the service-role key (server) can touch these tables.
```

Seed (`supabase/migrations/20260902000100_seed_features.sql`, idempotent): the four features and the category lists from the spec.

| feature | seeded categories |
|---|---|
| home | wrong_peak_score, peak_score_not_loaded, guidance_incorrect |
| sleep | incorrect_sleep, sleep_not_recorded, incorrect_sleep_stage, vitals_not_recorded |
| activity | incorrect_steps, incorrect_total_calories, incorrect_active_calories, incorrect_training_load, workout_not_showing |
| workout | incorrect_duration, incorrect_calories, hr_not_showing, map_not_loading, incorrect_zones, incorrect_intensity, start_workout_fail, end_workout_fail |

---

## 3. Field registry (single source of truth)

`src/schema/registry.ts` declares field types and per-feature fields. Both the
GET schema response and the Zod validator are derived from it.

Field types:

| type | validation | wire format |
|---|---|---|
| `boolean` | required flag | `true`/`false` |
| `text` | `maxLength` | string |
| `date` | `YYYY-MM-DD`, must be a real calendar date, not in the future | string |
| `number` | `min`/`max`, `integer` flag | number |
| `time_12h` | `^(0?[1-9]|1[0-2]):[0-5][0-9] (AM|PM)$` | string, e.g. `"10:45 PM"` |
| `string` | `maxLength`, optional `options` | string |
| `multi_select` | `minItems: 1`, values ⊂ active category keys for the feature | string[] |

Common fields (every feature):

| field | type | required |
|---|---|---|
| `is_positive` | boolean | yes |
| `occurred_on` | date | yes |
| `user_id` | number (integer, >0) | yes |
| `email` | string (email) | yes |
| `issue_categories` | multi_select | yes |
| `feedback_text` | text (≤500) | no |

Feature-specific fields (`details`):

| feature | field | type | required |
|---|---|---|---|
| home | `peak_score_value` | number 0-100 | no |
| sleep | `actual_start_time` | time_12h | no |
| sleep | `actual_end_time` | time_12h | no |
| sleep | `recorded_start_time` | time_12h | no |
| sleep | `recorded_end_time` | time_12h | no |
| activity | `steps` | number, integer ≥0 | no |
| activity | `active_calories` | number ≥0 | no |
| activity | `total_calories` | number ≥0 | no |
| workout | `workout_type` | string | no |
| workout | `start_time` | time_12h | no |
| workout | `end_time` | time_12h | no |
| workout | `intensity` | string | no |

Cross-field rules: if both start and end are present on the same pair, they
must differ. No ordering check (a sleep that crosses midnight is normal).

Assumptions to confirm (see §7): feature-specific fields are optional; `workout_type` and `intensity` are free strings for now.

---

## 4. API

Base path `/v1`. All responses are JSON. Errors follow one shape:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "issues": [ { "path": "details.peak_score_value", "message": "must be <= 100" } ] } }
```

### App endpoints (`x-api-key`)

| method | path | purpose |
|---|---|---|
| `GET` | `/v1/feedback/schema` | All active features with common fields, feature fields, and active categories. Form-building payload. Includes `schema_version` and an `ETag` so the app can cache |
| `GET` | `/v1/feedback/schema/:feature` | Same, one feature |
| `POST` | `/v1/feedback/:feature` | Submit one feedback. Validates against the registry and live categories, inserts, returns `201` with the stored row (incl. `created_at_ist`) |
| `GET` | `/v1/feedback` | List, paginated (`cursor`, `limit`), filters: `feature`, `user_id`, `from`, `to` (occurred_on), `is_positive`, `category`. For dashboards later |
| `GET` | `/v1/feedback/:id` | One row |

Schema response shape:

```json
{
  "schema_version": 1,
  "common_fields": [
    { "key": "is_positive", "type": "boolean", "label": "Was this positive?", "required": true },
    { "key": "occurred_on", "type": "date", "label": "Date of issue", "required": true, "format": "YYYY-MM-DD" },
    { "key": "feedback_text", "type": "text", "label": "Details", "required": false, "max_length": 500 }
  ],
  "features": [
    {
      "key": "home",
      "label": "Home",
      "issue_categories": [
        { "key": "wrong_peak_score", "label": "Wrong peak score" }
      ],
      "fields": [
        { "key": "peak_score_value", "type": "number", "label": "Peak score shown", "required": false, "min": 0, "max": 100 }
      ]
    }
  ]
}
```

POST body example (`POST /v1/feedback/sleep`):

```json
{
  "is_positive": false,
  "occurred_on": "2026-09-01",
  "user_id": 10482,
  "email": "tester@luna.app",
  "issue_categories": ["incorrect_sleep", "vitals_not_recorded"],
  "feedback_text": "Ring said I slept 4h, I slept 7h.",
  "details": {
    "actual_start_time": "11:30 PM",
    "actual_end_time": "06:45 AM",
    "recorded_start_time": "01:10 AM",
    "recorded_end_time": "05:00 AM"
  },
  "client": {
    "app_version": "2.4.0", "build_number": "512", "build_channel": "stage",
    "firmware_version": "1.9.2", "os_version": "iOS 19.1", "device_id": "…", "session_id": "…"
  }
}
```

Idempotency: optional `Idempotency-Key` header; same key within 24h returns the original row instead of a duplicate. Guards the iOS outbox replay.

### Admin endpoints (`x-admin-key`)

| method | path | purpose |
|---|---|---|
| `GET` | `/v1/admin/features` | All features incl. inactive |
| `PATCH` | `/v1/admin/features/:feature` | label, sort_order, is_active |
| `GET` | `/v1/admin/features/:feature/issue-categories` | All categories incl. inactive |
| `POST` | `/v1/admin/features/:feature/issue-categories` | Add `{ key, label, sort_order }` |
| `PATCH` | `/v1/admin/issue-categories/:id` | Rename, reorder, activate/deactivate |

Categories are never hard-deleted. Deactivating hides them from the schema and rejects them on new submissions, while old rows keep their keys.

### Ops

`GET /healthz` returns `{ ok, db: "up" }` after a trivial select.

---

## 5. Project structure

```
luna-feedback-app/
├── package.json
├── tsconfig.json
├── .env.example                 # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_API_KEY, ADMIN_API_KEY, PORT
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   └── 20260902000000_init.sql
│   └── seed.sql
├── src/
│   ├── server.ts                # node entry: build app, listen
│   ├── app.ts                   # buildApp(): registers plugins + routes, exported for tests/serverless
│   ├── config.ts                # env parsing (zod), fails fast on missing vars
│   ├── db/
│   │   ├── client.ts            # supabase service client (singleton)
│   │   └── types.ts             # generated: `supabase gen types typescript`
│   ├── schema/
│   │   ├── fieldTypes.ts        # type definitions + per-type zod builders
│   │   ├── registry.ts          # common + per-feature field declarations
│   │   ├── buildSchemaResponse.ts   # registry + live categories -> GET payload
│   │   └── buildValidator.ts        # registry + live categories -> zod schema for POST
│   ├── modules/
│   │   ├── feedback/
│   │   │   ├── feedback.routes.ts
│   │   │   ├── feedback.service.ts  # validate, map, insert, format IST
│   │   │   └── feedback.repo.ts     # supabase queries only
│   │   ├── categories/
│   │   │   ├── categories.routes.ts # admin
│   │   │   └── categories.repo.ts   # + short in-memory cache (30s) used by schema/validator
│   │   └── health/health.routes.ts
│   ├── plugins/
│   │   ├── auth.ts              # x-api-key / x-admin-key hooks
│   │   ├── errorHandler.ts      # zod + known errors -> error envelope
│   │   └── requestId.ts
│   └── lib/
│       ├── time.ts              # toIST(), parse/validate time_12h
│       └── errors.ts            # AppError, codes
├── api/
│   └── index.ts                 # Vercel handler wrapping buildApp()
└── test/
    ├── unit/                    # registry, validators, time helpers (no DB)
    └── integration/             # supertest against buildApp() + local Supabase
```

---

## 6. Build order

| # | Deliverable | Verified by |
|---|---|---|
| 1 | Scaffold: package.json, tsconfig, Fastify app, config, health route, error envelope | DONE |
| 2 | Migration + seed, applied to the hosted project | DONE |
| 3 | Field registry + type builders + `buildValidator` | DONE, 47 unit tests |
| 4 | `GET /v1/feedback/schema` + per-feature variant, ETag | DONE, integration tests |
| 5 | `POST /v1/feedback/:feature` with idempotency, IST formatting | DONE, integration tests |
| 6 | Admin category + feature endpoints, cache invalidation | DONE, integration tests |
| 7 | `GET /v1/feedback` list + filters + `GET /:id` | DONE, integration tests |
| 8 | Vercel deploy (Fastify preset, `src/server.ts` entry), `.env.example`, README | DONE, live at luna-feedback.buildsage.tech |
| 9 | `/docs` public API reference page + `docs/API.md` | DONE |
| 10 | `/dashboard`: DASHBOARD_KEY sign-in with 30-day signed HttpOnly cookie; filters (range, feature, platform, result, category, user); KPIs; charts (by day, by feature, top categories); table with drawer + CSV; category management | DONE |
| 11 | `GET /v1/feedback/stats` aggregates; `client.platform` (ios/android) column + filter | DONE |

Steps 1, 3, and the unit tests need no credentials. Steps 2 and onward run against a local Supabase via Docker until you share the project creds, then the same migrations apply to the hosted project with `supabase db push`.

---

## 6b. Dashboard and pages

- `src/pages/dashboard.html` and `src/pages/docs.html` are embedded into `src/pages/generated.ts` by `scripts/embed-pages.mjs` (pre-dev/build/test hook; generated file is committed so the Vercel bundle is deterministic).
- Design follows `docs/design/luna-design-system.html` (Geist / Geist Mono, warm off-white, 1px borders, radii ≤ 12px, light only). Chart colours: status green `#00C37A` / red `#FF3B3B` for working-fine vs issue, Recovery Blue `#2E64E4` for single-series bars; validated with the dataviz palette checker.
- Dashboard auth: `POST /dashboard/login` exchanges `DASHBOARD_KEY` for a stateless HMAC token in an HttpOnly, SameSite=Lax cookie (`DASHBOARD_SESSION_DAYS`, default 30). Fetches carry `x-requested-with: dashboard`; the auth hook treats cookie + header as admin. Rotating the key signs everyone out. Login is rate-limited per IP in memory.
- Demo data: `node scripts/seed-demo.mjs 60` / `--clean` (emails `@luna-demo.invalid`).

## 7. Assumptions to confirm

1. **Feature-specific fields are optional.** The spec marks only common fields mandatory. If e.g. `peak_score_value` must be present when the category is `wrong_peak_score`, say so and I'll add conditional rules.
2. **`workout_type` and `intensity` are free strings.** If the app has a fixed list for either, I'll seed it as options in the schema so the form can render a picker.
3. **Categories are always at least one.** "mandatory" + "multi select" read as `minItems: 1`. A positive feedback still needs a category under this reading. If positive feedback should allow an empty list, I'll relax it to `minItems: 0 when is_positive`.
4. **`user_id` is a 64-bit integer**, not a UUID.
5. **Client context block is optional.** The iOS module will send it; nothing breaks if it's absent.
6. **Deployment target is Vercel** per the earlier iOS-side plan. The app also runs as a plain Node server if that changes.

---

## 8. Prerequisites on your side

- Supabase project: `SUPABASE_DB_URL` (done). Service-role key and Exposed-schemas toggle are not needed with the direct-Postgres approach.
- Two random secrets for `APP_API_KEY` and `ADMIN_API_KEY`.
- Docker Desktop running locally for `supabase start` (I'll install the CLI via `brew install supabase/tap/supabase`).
