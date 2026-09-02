# Luna Internal Feedback API — Front-end Integration Guide

| | |
|---|---|
| **Base URL** | `https://luna-feedback.buildsage.tech` |
| **API version** | `v1` (path prefix) · schema version `1` |
| **Auth** | `x-api-key` header on every `/v1/*` call |
| **Format** | JSON in, JSON out, UTF-8 |
| **Audience** | Luna app Stage builds (iOS and Android). Never ship the key in a Release build. |
| **Live docs** | `https://luna-feedback.buildsage.tech/docs` (this document, always current) |

---

## 1. Overview

The API does three things for the client:

1. **Describes the form.** `GET /v1/feedback/schema` returns every feature (Home, Sleep, Activity, Workout, Other), its issue categories, and the extra fields to render. The client builds the form from this response rather than hard-coding it, so categories can be added or renamed on the server without an app release.
2. **Accepts submissions.** `POST /v1/feedback/{feature}` validates the payload against the same schema and stores it.
3. **Reads submissions back.** `GET /v1/feedback`, `GET /v1/feedback/{id}`, and `GET /v1/feedback/stats` power the dashboard at `/dashboard`; the app does not need them.

### Environments

| environment | base URL | notes |
|---|---|---|
| Production | `https://luna-feedback.buildsage.tech` | same deployment as `luna-internal-feedback.vercel.app` |
| Local | `http://localhost:3000` | `npm run dev` in the backend repo |

### Authentication

Send the shared app key on every request under `/v1`:

```
x-api-key: <APP_API_KEY>
```

The key is distributed out of band by the backend owner. `GET /healthz`, `/docs` (this document), and `/dashboard` (its own sign-in) are the only unauthenticated routes. Admin routes under `/v1/admin` need a different key (`x-admin-key`) and are not for the app.

**While integrating:** send `"is_test": true` on submissions from development and integration runs. They show up in the dashboard tagged TEST, can be hidden with one filter, and are deleted in bulk later without touching real tester feedback. Drop the flag in the build testers use.

---

## 2. Quick start

Three calls, in order:

```bash
# 1. Fetch the form definition (cache it; see ETag below)
curl https://luna-feedback.buildsage.tech/v1/feedback/schema \
  -H "x-api-key: $APP_API_KEY"

# 2. Render the form for the feature the user is on (client side)

# 3. Submit  (while integrating, keep "is_test": true — see §3b)
curl -X POST https://luna-feedback.buildsage.tech/v1/feedback/sleep \
  -H "x-api-key: $APP_API_KEY" \
  -H "content-type: application/json" \
  -H "Idempotency-Key: 2E5C1D1C-6D6B-4B3E-9C6A-3F1E8B7A5D42" \
  -d '{
    "is_test": true,
    "is_positive": false,
    "occurred_on": "2026-09-01",
    "user_id": 10482,
    "email": "tester@luna.app",
    "issue_categories": ["incorrect_sleep", "vitals_not_recorded"],
    "feedback_text": "Ring said 4h, I slept 7h.",
    "device_serial": "R2N08250600302",
    "details": { "actual_start_time": "11:30 PM", "actual_end_time": "06:45 AM" },
    "client": { "platform": "ios", "app_version": "2.4.0", "build_number": "512", "build_channel": "stage",
                "firmware_version": "1.9.2", "os_version": "iOS 19.1" }
  }'
```

---

## 3. Conventions

### Request headers

| header | required | purpose |
|---|---|---|
| `x-api-key` | yes, all `/v1` routes | app key |
| `content-type: application/json` | on POST/PATCH | body encoding |
| `Idempotency-Key` | recommended on POST | any string ≤ 200 chars, unique per submission attempt. Reuse the same value when retrying. See §3.5 |
| `If-None-Match` | optional on schema GETs | send the `ETag` from a previous response to get `304 Not Modified` |

### Data formats

| kind | wire format | rules |
|---|---|---|
| date (`occurred_on`) | `"2026-09-01"` | `YYYY-MM-DD`, must be a real calendar date, must not be after today in IST |
| 12-hour time (`time_12h`) | `"10:45 PM"`, `"7:05 am"` | `H:MM AM/PM` or `HH:MM AM/PM`, space before the meridiem, case-insensitive. Stored and returned as `"07:05 AM"` |
| timestamps (responses) | `created_at`: `"2026-09-02T08:20:23.521Z"` · `created_at_ist`: `"2026-09-02 13:50:23 +05:30"` | `created_at` is ISO 8601 UTC. `created_at_ist` is the same instant in Asia/Kolkata for display |
| `user_id` | `10482` | JSON number, positive integer |
| `email` | `"tester@luna.app"` | valid email, ≤ 254 chars, stored as given |
| `issue_categories` | `["incorrect_sleep"]` | array of category **keys** (not labels), at least one, no duplicates, only keys the schema lists for that feature |
| ids | `"178239d2-2581-4207-a378-742b0ac186ef"` | UUID v4 |

### Error envelope

Every non-2xx response has this shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request failed validation",
    "issues": [
      { "path": "details.peak_score_value", "message": "must be <= 100" },
      { "path": "issue_categories.0", "message": "unknown category \"incorrect_sleep\"" }
    ]
  }
}
```

`issues` is present only for `VALIDATION_FAILED`. `path` is dot-separated and matches the request body, so it can be mapped straight back to a form field. Array elements are indexed (`issue_categories.0`). `(body)` means the whole body was unparseable.

### Status codes

| status | code | when |
|---|---|---|
| 200 | | read succeeded, or a POST with an `Idempotency-Key` already seen (returns the original row) |
| 201 | | POST created a new submission |
| 304 | | schema unchanged since the `If-None-Match` ETag |
| 400 | `VALIDATION_FAILED` | body is not valid JSON |
| 401 | `UNAUTHORIZED` | missing or wrong `x-api-key` |
| 404 | `NOT_FOUND` | unknown route, unknown or deactivated feature, unknown id |
| 409 | `CONFLICT` | admin only: duplicate category key |
| 422 | `VALIDATION_FAILED` | body parsed but failed field validation; see `issues` |
| 500 | `INTERNAL` | server fault; safe to retry with the same `Idempotency-Key` |
| 503 | | database unreachable (health check only) |

### Idempotency and retries

Network on internal test devices is unreliable. To make retries safe:

1. Generate a UUID **when the user taps Submit**, and keep it with the queued payload.
2. Send it as `Idempotency-Key` on every attempt of that submission.
3. `201` means stored now. `200` means it was already stored by an earlier attempt; the body is the original row. Treat both as success.
4. Retry on `5xx`, timeouts, and connection failures. Do not retry `4xx`; surface the `issues` to the user instead.

Keys are unique across the whole API, so a UUID is the right choice.

### Caching the schema

Schema responses carry a weak `ETag` and `Cache-Control: no-cache`. Recommended: fetch on app launch (or before first showing the form), send `If-None-Match` with the stored ETag, and keep the last good copy on disk so the form can render offline. A `304` means the cached copy is current.

### Limits

| limit | value |
|---|---|
| request body | 64 KB |
| `feedback_text` | 500 characters |
| `issue_categories` | ≥ 1 item |
| list page size | 1–200, default 50 |

---

## 3b. Test submissions

Real tester feedback and integration traffic share one database. The `is_test` flag keeps them apart, so you can hit production freely while building the feature.

**How to set it.** Add one boolean at the **top level** of the POST body (not inside `details` or `client`):

```json
{
  "is_test": true,
  "is_positive": false,
  "occurred_on": "2026-09-01",
  …
}
```

Omit it, or send `false`, in the build that real testers use. It defaults to `false`.

**What it does**

- The row is stored exactly like real feedback and comes back with `"is_test": true`.
- The dashboard tags it TEST and can show real only, test only, or both.
- Test rows can be bulk-deleted later from the dashboard (or `DELETE /v1/admin/test-data?confirm=delete`). Real feedback is never touched by that action.
- Listing and stats accept `?is_test=true|false`: `GET /v1/feedback?is_test=true&user_id=<your id>` shows your own test rows.

**Suggested wiring.** Bind it to the build channel (`is_test = buildChannel != "stage"` for local and CI builds) or expose a hidden developer toggle. A submission that arrives without the flag is treated as real.

---

## 4. Rendering a form from the schema

The schema is a list of **field definitions**. Each has:

| property | present on | meaning |
|---|---|---|
| `key` | all | JSON key to send |
| `label` | all | display label |
| `type` | all | one of the types below |
| `required` | all | must be present and non-null |
| `help` | any | optional hint text |

Type-specific properties:

| `type` | extra properties | render as | send as |
|---|---|---|---|
| `boolean` | | toggle / segmented control | `true` / `false` |
| `text` | `maxLength`, `multiline` | text area with a counter | string |
| `date` | `format: "YYYY-MM-DD"`, `allowFuture` (absent = false) | date picker, max = today | `"YYYY-MM-DD"` |
| `number` | `min`, `max`, `integer`, `unit` | numeric keypad; stepper if `integer` | JSON number |
| `time_12h` | `format: "HH:MM AM/PM"` | time picker in 12-hour mode | `"HH:MM AM/PM"` |
| `string` | `maxLength`, `format` (`email`), `options` | text field; a picker if `options` is present | string |
| `multi_select` | `minItems`, `optionsFrom: "issue_categories"` | multi-select chips from the feature's `issue_categories` | array of option `key`s |

**Where fields live in the request body.** Common fields (`common_fields`) go at the top level. Feature fields (`features[].fields`) go inside `details`. The `client` block takes the fields listed in `client_context_fields` (`platform` carries `options`).

**Rules.** `features[].rules` lists cross-field constraints the server enforces. Today there is one kind:

```json
{ "kind": "time_pair_distinct", "start": "actual_start_time", "end": "actual_end_time" }
```

If both fields are filled, they must not be identical. There is no ordering check because sleep and workouts can cross midnight.

**Forward compatibility.** Skip any field whose `type` the client doesn't recognise, and ignore unknown properties. The server rejects unknown *keys* in the body, so only send keys the schema lists. `schema_version` increments on breaking changes.

---

## 5. Endpoints

### `GET /healthz`

No auth. Returns `{ "ok": true, "db": "up" }` or `503` with `{ "ok": false, "db": "down" }`.

---

### `GET /v1/feedback/schema`

Everything needed to build the form for every active feature.

**Response `200`** (live, verbatim)

```json
{
  "schema_version": 1,
  "common_fields": [
    { "key": "is_positive",      "type": "boolean",      "label": "Was this a positive experience?", "required": true },
    { "key": "occurred_on",      "type": "date",         "format": "YYYY-MM-DD", "label": "Date the issue occurred", "required": true },
    { "key": "user_id",          "type": "number",       "label": "User ID", "required": true, "integer": true, "min": 1 },
    { "key": "email",            "type": "string",       "format": "email", "label": "Email", "required": true, "maxLength": 254 },
    { "key": "issue_categories", "type": "multi_select", "label": "What went wrong?", "required": true, "minItems": 1, "optionsFrom": "issue_categories" },
    { "key": "feedback_text",    "type": "text",         "label": "Tell us more", "required": false, "maxLength": 500, "multiline": true },
    { "key": "device_serial",    "type": "string",       "label": "Ring or band serial number", "required": false, "maxLength": 64,
      "help": "Fill automatically from the connected ring or band, e.g. R2N08250600302. Not typed by the tester. Used to fetch device logs; email is the fallback." }
  ],
  "client_context_keys": ["platform", "app_version", "build_number", "build_channel", "firmware_version", "os_version", "device_id", "session_id"],
  "client_context_fields": [
    { "key": "platform",         "type": "string", "label": "Platform",              "required": false, "options": ["ios", "android"] },
    { "key": "app_version",      "type": "string", "label": "App version",           "required": false, "maxLength": 200 },
    { "key": "build_number",     "type": "string", "label": "Build number",          "required": false, "maxLength": 200 },
    { "key": "build_channel",    "type": "string", "label": "Build channel",         "required": false, "maxLength": 200 },
    { "key": "firmware_version", "type": "string", "label": "Ring firmware version", "required": false, "maxLength": 200 },
    { "key": "os_version",       "type": "string", "label": "OS version",            "required": false, "maxLength": 200 },
    { "key": "device_id",        "type": "string", "label": "Device ID",             "required": false, "maxLength": 200 },
    { "key": "session_id",       "type": "string", "label": "Session ID",            "required": false, "maxLength": 200 }
  ],
  "features": [
    {
      "key": "home", "label": "Home",
      "issue_categories": [
        { "key": "wrong_peak_score",      "label": "Wrong peak score" },
        { "key": "peak_score_not_loaded", "label": "Peak score not loaded" },
        { "key": "guidance_incorrect",    "label": "Guidance incorrect" }
      ],
      "fields": [
        { "key": "peak_score_value", "type": "number", "label": "Peak score shown", "required": false, "min": 0, "max": 100 }
      ],
      "rules": []
    },
    {
      "key": "sleep", "label": "Sleep",
      "issue_categories": [
        { "key": "incorrect_sleep",       "label": "Incorrect sleep" },
        { "key": "sleep_not_recorded",    "label": "Sleep not recorded" },
        { "key": "incorrect_sleep_stage", "label": "Incorrect sleep stage" },
        { "key": "vitals_not_recorded",   "label": "Vitals not recorded" }
      ],
      "fields": [
        { "key": "actual_start_time",   "type": "time_12h", "format": "HH:MM AM/PM", "label": "Actual sleep start",   "required": false },
        { "key": "actual_end_time",     "type": "time_12h", "format": "HH:MM AM/PM", "label": "Actual sleep end",     "required": false },
        { "key": "recorded_start_time", "type": "time_12h", "format": "HH:MM AM/PM", "label": "Recorded sleep start", "required": false },
        { "key": "recorded_end_time",   "type": "time_12h", "format": "HH:MM AM/PM", "label": "Recorded sleep end",   "required": false }
      ],
      "rules": [
        { "kind": "time_pair_distinct", "start": "actual_start_time",   "end": "actual_end_time" },
        { "kind": "time_pair_distinct", "start": "recorded_start_time", "end": "recorded_end_time" }
      ]
    },
    {
      "key": "activity", "label": "Activity",
      "issue_categories": [
        { "key": "incorrect_steps",           "label": "Incorrect steps" },
        { "key": "incorrect_total_calories",  "label": "Incorrect total calories" },
        { "key": "incorrect_active_calories", "label": "Incorrect active calories" },
        { "key": "incorrect_training_load",   "label": "Incorrect training load" },
        { "key": "workout_not_showing",       "label": "Workout not showing" }
      ],
      "fields": [
        { "key": "steps",           "type": "number", "label": "Steps",           "required": false, "integer": true, "min": 0 },
        { "key": "active_calories", "type": "number", "label": "Active calories", "required": false, "min": 0, "unit": "kcal" },
        { "key": "total_calories",  "type": "number", "label": "Total calories",  "required": false, "min": 0, "unit": "kcal" }
      ],
      "rules": []
    },
    {
      "key": "workout", "label": "Workout",
      "issue_categories": [
        { "key": "incorrect_duration",  "label": "Incorrect duration" },
        { "key": "incorrect_calories",  "label": "Incorrect calories" },
        { "key": "hr_not_showing",      "label": "HR not showing" },
        { "key": "map_not_loading",     "label": "Map not loading" },
        { "key": "incorrect_zones",     "label": "Incorrect zones" },
        { "key": "incorrect_intensity", "label": "Incorrect intensity" },
        { "key": "start_workout_fail",  "label": "Start workout fail" },
        { "key": "end_workout_fail",    "label": "End workout fail" }
      ],
      "fields": [
        { "key": "workout_type", "type": "string",   "label": "Workout type",  "required": false, "maxLength": 100 },
        { "key": "start_time",   "type": "time_12h", "format": "HH:MM AM/PM", "label": "Workout start", "required": false },
        { "key": "end_time",     "type": "time_12h", "format": "HH:MM AM/PM", "label": "Workout end",   "required": false },
        { "key": "intensity",    "type": "string",   "label": "Intensity",     "required": false, "maxLength": 50 }
      ],
      "rules": [
        { "kind": "time_pair_distinct", "start": "start_time", "end": "end_time" }
      ]
    },
    {
      "key": "other", "label": "Other",
      "issue_categories": [
        { "key": "app_crash",         "label": "App crashed" },
        { "key": "app_slow_or_froze", "label": "App slow or froze" },
        { "key": "login_or_signup",   "label": "Login or sign-up problem" },
        { "key": "ring_pairing_sync", "label": "Ring pairing or sync" },
        { "key": "battery_drain",     "label": "Battery drain" },
        { "key": "notifications",     "label": "Notifications" },
        { "key": "display_glitch",    "label": "Display or UI glitch" },
        { "key": "data_missing",      "label": "Data missing" },
        { "key": "something_else",    "label": "Something else" }
      ],
      "fields": [
        { "key": "screen", "type": "string", "label": "Where in the app did it happen?", "required": false, "maxLength": 100 }
      ],
      "rules": []
    }
  ]
}
```

Response headers: `ETag: W/"…"`, `Cache-Control: no-cache`. Features are returned in display order; deactivated features are omitted.

---

### `GET /v1/feedback/schema/{feature}`

One feature only. Response is a single element of `features[]` above (`key`, `label`, `issue_categories`, `fields`, `rules`). Note it does **not** include `common_fields`; fetch the full schema for those. `404` if the feature is unknown or deactivated.

---

### `POST /v1/feedback/{feature}`

Create a submission. `{feature}` is one of `home`, `sleep`, `activity`, `workout`, `other`. Use `other` for anything that does not belong to one screen (crashes, login, pairing, battery, and so on).

**Request body**

| field | type | required | notes |
|---|---|---|---|
| `is_positive` | boolean | yes | |
| `occurred_on` | date | yes | not in the future (IST) |
| `user_id` | integer ≥ 1 | yes | |
| `email` | email string | yes | |
| `issue_categories` | string[] | yes | category keys for this feature, ≥ 1, unique |
| `feedback_text` | string ≤ 500 | no | free text |
| `device_serial` | string ≤ 64 | no | **send whenever a ring or band is connected**, e.g. `"R2N08250600302"`. Read from the SDK; never typed by the tester. Used to fetch that device's logs for AI diagnosis; `email` is the fallback |
| `details` | object | no | feature fields, see §6. Unknown keys are rejected. Defaults to `{}` |
| `client` | object | no | any subset of the client context keys, see §7. Unknown keys are rejected |
| `is_test` | boolean | no | default `false`. Send `true` from integration runs and test builds; see §3b |

Optional or nullable fields may be omitted or sent as `null`. Whitespace is trimmed from strings.

**Example request**

```http
POST /v1/feedback/workout HTTP/1.1
Host: luna-feedback.buildsage.tech
x-api-key: <APP_API_KEY>
content-type: application/json
Idempotency-Key: 9B2E6D3A-0C41-4E0F-8F1B-7D2A5C9E4B11

{
  "is_test": true,
  "is_positive": false,
  "occurred_on": "2026-09-01",
  "user_id": 10482,
  "email": "tester@luna.app",
  "issue_categories": ["hr_not_showing", "incorrect_zones"],
  "feedback_text": "HR stayed at -- for the whole run.",
  "device_serial": "R2N08250600302",
  "details": {
    "workout_type": "Outdoor Run",
    "start_time": "6:00 AM",
    "end_time": "6:45 AM",
    "intensity": "High"
  },
  "client": {
    "platform": "ios",
    "app_version": "2.4.0",
    "build_number": "512",
    "build_channel": "stage",
    "firmware_version": "1.9.2",
    "os_version": "iOS 19.1",
    "device_id": "3F2B0C7A-1D2E-4F5A-9B8C-7D6E5F4A3B2C",
    "session_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
  }
}
```

**Response `201 Created`** (live, verbatim)

```json
{
  "id": "178239d2-2581-4207-a378-742b0ac186ef",
  "feature_key": "workout",
  "is_positive": false,
  "occurred_on": "2026-09-01",
  "user_id": 10482,
  "email": "tester@luna.app",
  "issue_categories": ["hr_not_showing", "incorrect_zones"],
  "created_at": "2026-09-02T08:20:23.521Z",
  "feedback_text": "HR stayed at -- for the whole run.",
  "device_serial": "R2N08250600302",
  "details": {
    "workout_type": "Outdoor Run",
    "start_time": "06:00 AM",
    "end_time": "06:45 AM",
    "intensity": "High"
  },
  "platform": "ios",
  "app_version": "2.4.0",
  "build_number": "512",
  "build_channel": "stage",
  "firmware_version": "1.9.2",
  "os_version": "iOS 19.1",
  "device_id": "3F2B0C7A-1D2E-4F5A-9B8C-7D6E5F4A3B2C",
  "session_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "schema_version": 1,
  "is_test": true,
  "created_at_ist": "2026-09-02 13:50:23 +05:30"
}
```

Note the times came back zero-padded, and the `client` block is flattened to top-level columns. Client keys not sent come back as `null`.

**Response `200 OK`**: same body, returned when the `Idempotency-Key` was already used. Treat as success.

**Response `422`**

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request failed validation",
    "issues": [
      { "path": "details.end_time", "message": "must differ from start_time" },
      { "path": "feedback_text", "message": "must be at most 500 characters" }
    ]
  }
}
```

**Response `404`**: `{ "error": { "code": "NOT_FOUND", "message": "Unknown feature \"nutrition\"" } }`

---

### `GET /v1/feedback`

List submissions, newest first. Intended for dashboards; the app does not need it.

**Query parameters**

| param | type | notes |
|---|---|---|
| `feature` | string | `home` / `sleep` / `activity` / `workout` / `other` |
| `platform` | string | `ios` / `android` |
| `is_test` | `true` / `false` | omit for both |
| `user_id` | integer | |
| `from`, `to` | date | inclusive bounds on `occurred_on` |
| `is_positive` | `true` / `false` | |
| `category` | string | submissions whose `issue_categories` contains this key |
| `limit` | 1–200 | default 50 |
| `cursor` | string | value of `next_cursor` from the previous page |

**Response `200`**

```json
{
  "items": [ { …submission… }, { …submission… } ],
  "next_cursor": "2026-09-02T08:20:23.521Z|178239d2-2581-4207-a378-742b0ac186ef"
}
```

`next_cursor` is `null` on the last page. Pass it back URL-encoded as `cursor`. Invalid parameters return `422`.

---

### `GET /v1/feedback/{id}`

One submission by UUID. `404` if not found or the id is not a UUID.

---

### `GET /v1/feedback/stats`

Aggregates for the dashboard. Same filters as the list (`feature`, `platform`, `is_test`, `user_id`, `from`, `to`, `is_positive`, `category`); `to` defaults to today in IST and `from` to 30 days earlier. Returns `range`, `totals` (submissions, positive, negative, users), `by_day`, `by_feature`, and `by_category`.

---

### `GET /v1/feedback/{id}/diagnosis`

The AI diagnosis for a reported issue, produced in the background from the tester's device logs (looked up by `device_serial`, then `email`). `404` until the first run has started. Fields: `status` (pending · running · waiting_logs · done · no_logs · failed), `root_cause_side` (firmware · sdk · app · backend · user_expectation · not_a_bug · insufficient_logs), `confidence`, `severity`, `tags`, `reproducible`, `summary`, `suggested_fix`, `questions_for_tester`, `evidence[]`, `log_files`, `log_excerpt` (≤100 lines), `log_coverage`, `fw_version_seen`, `app_version_seen`, `model`, `cost_usd`, `duration_ms`. Submissions carry `ai_status`, `ai_side`, `ai_severity`, `ai_checked_at`; list and stats accept `ai_status`, `ai_side`, `ai_severity` filters. Same-day reports usually wait for the evening log sync before a verdict exists.

---

### Admin routes (`x-admin-key`)

Not for the app. Listed so the front-end team knows how categories change.

| method | path | body |
|---|---|---|
| `GET` | `/v1/admin/features` | |
| `PATCH` | `/v1/admin/features/{feature}` | `{ "label"?, "sort_order"?, "is_active"? }` |
| `GET` | `/v1/admin/features/{feature}/issue-categories` | includes inactive |
| `POST` | `/v1/admin/features/{feature}/issue-categories` | `{ "key", "label", "sort_order"? }` · key is a lowercase slug · `409` on duplicate |
| `PATCH` | `/v1/admin/issue-categories/{id}` | `{ "label"?, "sort_order"?, "is_active"? }` |
| `GET` | `/v1/admin/test-data` | → `{ "count" }` of rows flagged `is_test` |
| `DELETE` | `/v1/admin/test-data?confirm=delete` | deletes only `is_test` rows → `{ "deleted" }`; `422` without the confirm parameter |

Categories are never deleted. Deactivating one removes it from the schema and makes the server reject it on new submissions, so a client holding a stale cached schema may get a `422` on `issue_categories.N`. Handle that by refetching the schema and asking the user to re-pick.

---

## 6. Feature reference

Everything below is also in the schema response. Duplicated here for quick reading. All `details` fields are optional.

### Home

| category key | label |
|---|---|
| `wrong_peak_score` | Wrong peak score |
| `peak_score_not_loaded` | Peak score not loaded |
| `guidance_incorrect` | Guidance incorrect |

| `details` field | type | constraints |
|---|---|---|
| `peak_score_value` | number | 0–100 |

### Sleep

| category key | label |
|---|---|
| `incorrect_sleep` | Incorrect sleep |
| `sleep_not_recorded` | Sleep not recorded |
| `incorrect_sleep_stage` | Incorrect sleep stage |
| `vitals_not_recorded` | Vitals not recorded |

| `details` field | type | constraints |
|---|---|---|
| `actual_start_time` | time_12h | |
| `actual_end_time` | time_12h | must differ from `actual_start_time` |
| `recorded_start_time` | time_12h | |
| `recorded_end_time` | time_12h | must differ from `recorded_start_time` |

### Activity

| category key | label |
|---|---|
| `incorrect_steps` | Incorrect steps |
| `incorrect_total_calories` | Incorrect total calories |
| `incorrect_active_calories` | Incorrect active calories |
| `incorrect_training_load` | Incorrect training load |
| `workout_not_showing` | Workout not showing |

| `details` field | type | constraints |
|---|---|---|
| `steps` | number | integer ≥ 0 |
| `active_calories` | number | ≥ 0, kcal |
| `total_calories` | number | ≥ 0, kcal |

### Workout

| category key | label |
|---|---|
| `incorrect_duration` | Incorrect duration |
| `incorrect_calories` | Incorrect calories |
| `hr_not_showing` | HR not showing |
| `map_not_loading` | Map not loading |
| `incorrect_zones` | Incorrect zones |
| `incorrect_intensity` | Incorrect intensity |
| `start_workout_fail` | Start workout fail |
| `end_workout_fail` | End workout fail |

| `details` field | type | constraints |
|---|---|---|
| `workout_type` | string | ≤ 100 chars, free text (e.g. the app's workout name) |
| `start_time` | time_12h | |
| `end_time` | time_12h | must differ from `start_time` |
| `intensity` | string | ≤ 50 chars, free text |

### Other

Generic issues that do not belong to one screen. Categories are the starting set and are edited from the dashboard.

| category key | label |
|---|---|
| `app_crash` | App crashed |
| `app_slow_or_froze` | App slow or froze |
| `login_or_signup` | Login or sign-up problem |
| `ring_pairing_sync` | Ring pairing or sync |
| `battery_drain` | Battery drain |
| `notifications` | Notifications |
| `display_glitch` | Display or UI glitch |
| `data_missing` | Data missing |
| `something_else` | Something else |

| `details` field | type | constraints |
|---|---|---|
| `screen` | string | ≤ 100 chars, free text, e.g. "Settings > Profile" |

---

## 7. Client context

Optional `client` object on POST, identical for every feature. Send it on every submission: the dashboard filters by platform and slices by app and firmware version, so `platform`, `app_version`, and `firmware_version` are the most valuable. The schema lists these under `client_context_fields`.

| key | example | source |
|---|---|---|
| `platform` | `"ios"` · `"android"` | fixed; case-insensitive on input, stored lower-case |
| `app_version` | `"2.4.0"` | `CFBundleShortVersionString` |
| `build_number` | `"512"` | `CFBundleVersion` |
| `build_channel` | `"stage"` | build channel / scheme |
| `firmware_version` | `"1.9.2"` | connected ring firmware |
| `os_version` | `"iOS 19.1"` | `UIDevice.current.systemVersion` |
| `device_id` | `"3F2B0C7A-…"` | `identifierForVendor` |
| `session_id` | `"7c9e6679-…"` | app session UUID |

---

## 8. Error reference

| `error.code` | HTTP | meaning | client action |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | key missing or wrong | check build config; do not retry |
| `NOT_FOUND` | 404 | route, feature, or id unknown | refetch schema if it was a feature |
| `VALIDATION_FAILED` | 400 / 422 | malformed JSON, or field errors in `issues` | map `issues[].path` to fields; do not retry unchanged |
| `CONFLICT` | 409 | admin duplicate | n/a for app |
| `INTERNAL` | 500 | server fault | retry with the same `Idempotency-Key` |

---

## 9. Swift reference implementation

Minimal `URLSession` client covering schema fetch with ETag and a submission with idempotency. Adapt to the app's networking layer; the endpoint must be marked as **not** requiring Luna's bearer token.

```swift
import Foundation

struct FeedbackAPI {
    let baseURL = URL(string: "https://luna-feedback.buildsage.tech")!
    let apiKey: String
    let session: URLSession = .shared
    let decoder = JSONDecoder()

    // MARK: Schema

    struct Field: Decodable {
        let key: String
        let label: String
        let type: String
        let required: Bool
        let help: String?
        let maxLength: Int?
        let multiline: Bool?
        let format: String?
        let allowFuture: Bool?
        let min: Double?
        let max: Double?
        let integer: Bool?
        let unit: String?
        let options: [String]?
        let minItems: Int?
        let optionsFrom: String?
    }
    struct Category: Decodable { let key: String; let label: String }
    struct Rule: Decodable { let kind: String; let start: String; let end: String }
    struct Feature: Decodable {
        let key: String
        let label: String
        let issueCategories: [Category]
        let fields: [Field]
        let rules: [Rule]
        enum CodingKeys: String, CodingKey { case key, label, fields, rules, issueCategories = "issue_categories" }
    }
    struct Schema: Decodable {
        let schemaVersion: Int
        let commonFields: [Field]
        let clientContextKeys: [String]
        let clientContextFields: [Field]
        let features: [Feature]
        enum CodingKeys: String, CodingKey {
            case features
            case schemaVersion = "schema_version"
            case commonFields = "common_fields"
            case clientContextKeys = "client_context_keys"
            case clientContextFields = "client_context_fields"
        }
    }

    enum SchemaResult { case updated(Schema, etag: String?), notModified }

    func fetchSchema(etag: String?) async throws -> SchemaResult {
        var req = URLRequest(url: baseURL.appendingPathComponent("v1/feedback/schema"))
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        if let etag { req.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let (data, resp) = try await session.data(for: req)
        let http = resp as! HTTPURLResponse
        switch http.statusCode {
        case 304: return .notModified
        case 200: return .updated(try decoder.decode(Schema.self, from: data),
                                  etag: http.value(forHTTPHeaderField: "ETag"))
        default: throw try APIError.from(data, status: http.statusCode)
        }
    }

    // MARK: Submit

    struct Submission: Encodable {
        let isTest: Bool                  // true from dev/CI builds, false in the tester build
        let isPositive: Bool
        let occurredOn: String            // "YYYY-MM-DD"
        let userId: Int
        let email: String
        let issueCategories: [String]
        let feedbackText: String?
        let deviceSerial: String?         // ring/band serial from the SDK when connected
        let details: [String: JSONValue]  // feature fields
        let client: [String: String]          // include "platform": "ios"
        enum CodingKeys: String, CodingKey {
            case email, details, client
            case isTest = "is_test"
            case isPositive = "is_positive"
            case occurredOn = "occurred_on"
            case userId = "user_id"
            case issueCategories = "issue_categories"
            case feedbackText = "feedback_text"
            case deviceSerial = "device_serial"
        }
    }

    struct SubmissionResponse: Decodable {
        let id: String
        let createdAt: String
        let createdAtIST: String
        enum CodingKeys: String, CodingKey {
            case id
            case createdAt = "created_at"
            case createdAtIST = "created_at_ist"
        }
    }

    /// `idempotencyKey` must be generated once per user submission and reused on every retry.
    func submit(_ body: Submission, feature: String, idempotencyKey: UUID) async throws -> SubmissionResponse {
        var req = URLRequest(url: baseURL.appendingPathComponent("v1/feedback/\(feature)"))
        req.httpMethod = "POST"
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(idempotencyKey.uuidString, forHTTPHeaderField: "Idempotency-Key")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await session.data(for: req)
        let http = resp as! HTTPURLResponse
        guard (200...201).contains(http.statusCode) else { throw try APIError.from(data, status: http.statusCode) }
        return try decoder.decode(SubmissionResponse.self, from: data)
    }

    // MARK: Errors

    struct APIError: Error, Decodable {
        struct Issue: Decodable { let path: String; let message: String }
        struct Body: Decodable { let code: String; let message: String; let issues: [Issue]? }
        let error: Body
        var status: Int = 0
        var isRetryable: Bool { status >= 500 }

        static func from(_ data: Data, status: Int) throws -> APIError {
            var e = (try? JSONDecoder().decode(APIError.self, from: data))
                ?? APIError(error: .init(code: "INTERNAL", message: "Unexpected response", issues: nil))
            e.status = status
            return e
        }
    }
}

/// Small JSON value wrapper so `details` can hold numbers and strings.
enum JSONValue: Encodable {
    case string(String), number(Double), bool(Bool), null
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }
}
```

Formatting helpers the app will need:

```swift
// occurred_on
let dateFormatter: DateFormatter = {
    let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = TimeZone(identifier: "Asia/Kolkata"); f.dateFormat = "yyyy-MM-dd"; return f
}()

// time_12h
let timeFormatter: DateFormatter = {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "hh:mm a"; return f   // "07:05 AM"
}()
```

---

## 10. Versioning and change policy

- **Additive changes** (new category, new optional field, new feature) ship without notice. Clients that render from the schema pick them up on the next fetch.
- **Breaking changes** (renamed key, new required field, removed type) bump `schema_version` and will be announced before deploy. The `v1` path prefix stays until the wire contract itself changes.
- The backend repo is `github.com/karankumar-tech/luna-internal-feedback`. Field definitions live in `src/schema/registry.ts`; categories live in the database and are managed through the admin routes.
