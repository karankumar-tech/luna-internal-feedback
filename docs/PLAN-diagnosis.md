# AI Diagnosis — Plan

Turn each feedback submission into a diagnosed bug: pull the tester's logs from the
Luna logging API, keep the relevant slice, have a cheap model decide where the fault
sits, and store the verdict in queryable columns next to the submission.

Everything below is grounded in what the logging API and the log files actually
return (inspected 2026-09-02 against stage) and what OpenRouter currently offers.

---

## 1. What the log source looks like (facts)

`GET https://stage-app.gonoise.com/logging/ring/list-botfetch?email=…` or `?serial_no=…`,
header `api-key: <LUNA_LOGS_APIKEY>`. Public S3 file URLs, no auth needed to download.

| field | meaning | notes |
|---|---|---|
| `data[]` | one entry per (user, device) | a tester with an Android phone and an iPhone appears twice |
| `user_id`, `device_id` | Luna user id, device index | `user_id` is the same id the app sends us as `user_id` |
| `platform`, `device_model`, `device_manufacturer`, `os_version` | phone | e.g. `android` / `2201116PI` / `POCO` / `12` |
| `fv`, `version_name`, `batt_perct` | ring firmware, app version, battery at upload | `fv` can be `null`; more reliable than what the app self-reports |
| `updated_at` | last upload | ISO UTC |
| `app_logs`, `ring_logs`, `firmware_logs` | **comma-separated URL lists**, one file per upload day | path contains `<user_id>-YYYY-MM-DD`; `firmware_logs` can be `""` |

File formats (sizes from one real tester):

| source | file | format | size seen |
|---|---|---|---|
| app | `…_appLogs.txt` | API request/response dumps, one JSON object per entry, entries separated by a line of `=` (78 chars); each has `"time": "<epoch ms>"` | 2 MB, 53k lines, ~60 entries |
| ring (Android) | `Ring_log_YYYY-MM-DD.zip` | zip with `BLE_<date>.log` (raw protobuf hex, huge) and `BEHAVIOR_<date>.log` (SDK calls); lines start `YYYY-MM-DD HH:mm:ss:SSS ----> sdk --- <area> ---> <event>` | 12 MB unzipped; BLE is 98% of it |
| ring (iOS) | `…-watchLogs.txt` | ZHD SDK trace, `[V2.4.5][SDK][ConnectState] …`, **almost no timestamps** (1 of 1,776 lines), Chinese labels mixed in | 100 KB |
| firmware | `…_firmware_logs.txt` | `M-D HH:mm:ss:ms cmd: 113,17` style lines, **no year**, sections separated by `==========<epoch ms>==========` | 100 KB, 2.2k lines |

Implications baked into the design:

- **The 100-line excerpt is a selection problem, not a truncation problem.** Whole-day
  logs are 50k+ lines; BLE hex dumps are noise. Selection is by time window + keyword
  scoring per source, with a per-source cap.
- **Timestamps need normalising per source.** Firmware lacks a year (take it from the
  file path); app entries use epoch ms; iOS traces are effectively unordered, so for
  iOS the "window" is the whole upload nearest the issue day.
- **Pick files by path date, not by downloading everything.** Choose the upload on or
  just after `occurred_on` (logs uploaded that evening cover the day) plus the one
  before it, per source. Download at most ~3 files per source, cap 25 MB each, and
  read only the zip members whose date matches.
- **Logs may not exist** for the day or the user. That is a first-class outcome
  (`no_logs`), not an error.
- **App logs contain API payloads.** Redact tokens, OTPs, phone numbers, and auth
  headers before anything is stored or sent to the model.

---

## 2. Model

OpenRouter key verified (paid tier, $1.60 credit currently loaded).

| model | in $/M | out $/M | context | structured output |
|---|---|---|---|---|
| `google/gemini-2.5-flash-lite` | 0.10 | 0.40 | 1M | yes |
| `google/gemini-3.1-flash-lite` | 0.25 | 1.50 | 1M | yes |

A diagnosis sends ~8–12k tokens (submission + 100 log lines + instructions) and gets
~600 tokens back. That is **≈ $0.004 on 3.1 flash-lite, ≈ $0.0015 on 2.5 flash-lite**.
Default to `google/gemini-3.1-flash-lite` as requested; the model id is an env var so
we can drop to 2.5 if quality holds, or step up per feature if it doesn't. Use
`response_format: json_schema` so the output is always the exact structure below.
Add a daily spend cap (`DIAGNOSIS_DAILY_BUDGET_USD`, default 2) that pauses auto-runs.

---

## 3. Data model

### `luna_feedback.diagnoses` — one current diagnosis per submission

| column | type | purpose |
|---|---|---|
| `id` | uuid pk | |
| `submission_id` | uuid fk, unique | one row per submission; re-runs overwrite and archive to `diagnosis_runs` |
| `status` | enum `pending` · `running` · `done` · `no_logs` · `failed` | "AI check done" = `done` or `no_logs` |
| **Verdict (queryable)** | | |
| `root_cause_side` | enum `firmware` · `sdk` · `app` · `backend` · `user_expectation` · `not_a_bug` · `insufficient_logs` | the column you asked for; `sdk` = ring SDK / BLE layer inside the app, `app` = Luna app logic/UI, `backend` = Luna API errors seen in app logs |
| `confidence` | numeric 0–1 | model's stated confidence |
| `severity` | enum `low` · `medium` · `high` · `critical` | |
| `tags` | text[] from a fixed taxonomy (§3.3) | queryable clusters ("ble_disconnect", "sync_timeout"…) |
| `reproducible` | enum `likely` · `unlikely` · `unknown` | |
| `summary` | text ≤ 400 chars | one paragraph, human-readable |
| `evidence` | jsonb `[{source, ts, line, why}]` | the exact log lines the verdict rests on |
| `suggested_fix` | text | what to try / who to route to |
| `questions_for_tester` | text[] | what to ask back if logs are inconclusive |
| **Log context** | | |
| `log_device` | jsonb | the matched `list-botfetch` entry (platform, model, OS, `fv`, `version_name`, `updated_at`) |
| `log_files` | jsonb `{app:[url], ring:[url], firmware:[url]}` | only the files actually used; URLs stay valid in S3 long after the API rolls over |
| `log_window` | tstzrange | the IST window that was searched |
| `log_excerpt` | text | ≤ 100 merged lines, sections tagged `===== [firmware] fv 1.2.6 =====` etc. |
| `log_excerpt_lines` | int | |
| `log_coverage` | enum `full` · `partial` · `none` | did any file cover the window |
| `fw_version_seen`, `app_version_seen` | text | from logs; compare with what the app self-reported |
| **Run** | | |
| `model`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `duration_ms` | | |
| `trigger` | enum `auto` · `manual` | |
| `error` | text | when `failed` |
| **Human loop** | | |
| `review_verdict` | enum `agree` · `disagree` · `unsure` | set from the dashboard |
| `review_note`, `reviewed_by`, `reviewed_at` | | |
| `created_at`, `updated_at` | | |

Denormalised onto `submissions` for cheap filtering and the CSV: `ai_status`,
`ai_side`, `ai_severity`, `ai_checked_at`.

### `luna_feedback.diagnosis_runs` — append-only history

Every attempt (including failures and re-runs): `submission_id`, `status`, `model`,
tokens, cost, `duration_ms`, `error`, `verdict_snapshot jsonb`, `created_at`. This is
where cost reporting and "did re-running change the answer" come from.

### `luna_feedback.diagnosis_jobs` — queue

`submission_id`, `state` (`queued` · `running` · `done` · `failed`), `attempts`,
`run_after`, `last_error`. Filled on submit (when auto-diagnosis is on) and drained by
the worker route.

### 3.3 Tag taxonomy (fixed list the model must choose from)

`ble_disconnect`, `ble_pairing`, `sync_timeout`, `sync_partial`, `data_gap`,
`sensor_quality`, `algorithm_output`, `firmware_reboot`, `firmware_cmd_error`,
`app_crash`, `app_ui_state`, `app_background_kill`, `api_error_4xx`, `api_error_5xx`,
`auth_session`, `battery`, `permissions`, `time_zone`, `user_expectation`, `other`.

Free-text tags would defeat querying; the list can grow by migration.

---

## 4. Pipeline

```
submission ──(auto or "Diagnose now")──▶ job ──▶ worker
                                               │
   1. lookup   list-botfetch?serial_no=<device_serial> when the submission has one, else ?email=…
   2. match    entry by platform, then most recent updated_at ≥ occurred_on
   3. select   per source: file(s) whose path date is the first ≥ occurred_on, plus the previous one
   4. fetch    ≤ 25 MB each, zip members filtered by date, redact secrets
   5. window   IST day of occurred_on; narrowed by details (sleep times ±1 h, workout ±30 min)
   6. extract  per-source scoring → app ≤ 40, ring ≤ 40, firmware ≤ 20 lines, chronological, merged
   7. prompt   submission + excerpt + taxonomy + JSON schema → OpenRouter
   8. persist  diagnoses (+ run history), denormalised columns on submissions
```

Selection scoring (step 6): a line scores on keywords weighted by feature
(sleep: `sleep|stage|hrv|spo2|vitals`; workout: `workout|hr|gps|zone|start|stop`;
activity: `step|calorie|load`; everything: `error|fail|timeout|disconnect|retry|exception|crash|reboot|battery|reset`),
plus a bonus for being inside the narrowed window, plus context lines (±2) around
top hits so the model sees sequences, not isolated words. BLE hex dumps are dropped
unless they carry an error marker. Ties keep the later line.

Prompt contract (system message, abbreviated): you are diagnosing feedback from an
internal tester of the Luna smart ring app; the stack is ring firmware → ring SDK
(BLE, inside the app) → app → Luna backend API; decide `root_cause_side` from
evidence only, prefer `insufficient_logs` over guessing, cite lines verbatim in
`evidence`, choose tags only from the taxonomy, write for an engineer.

### Where it runs (Vercel Hobby plan, verified against the docs 2026-09-02)

- Functions on Hobby run up to **300 s** per invocation (default and maximum), 2 GB
  memory. A diagnosis takes ~5–20 s, so a single invocation is ample.
- `waitUntil()` from `@vercel/functions` **extends the invocation after the response
  is sent**, up to that same 300 s. That is the background mechanism; no cron and
  no separate worker.
- Hobby cron jobs run at most once a day, so they are not used for the main path.

Flow for a negative submission:

1. `POST /v1/feedback/{feature}` validates and inserts the row, writes a
   `diagnosis_jobs` row (`queued`), and **responds 201 immediately**.
2. In the same invocation, `waitUntil(runDiagnosis(submissionId))` performs lookup →
   fetch → extract → model → persist. Locally (no Vercel runtime) the same call falls
   back to `setImmediate`, so `npm run dev` behaves identically.
3. If the invocation dies (timeout, crash), the job stays `queued`/`running` with a
   stale `started_at`. A **"Run pending" button** on the dashboard and an
   opportunistic sweep when the dashboard loads pick those up, plus "Diagnose now"
   on any detail page. Retries are capped at 3 with the last error stored.
4. Manual "Diagnose now" runs synchronously in its own request and returns the result.

`attachDatabasePool(pool)` from the same package is added so the pg pool releases
idle clients before Fluid compute suspends the instance.

---

## 5. API additions

| method | path | auth | purpose |
|---|---|---|---|
| `POST` | `/v1/admin/submissions/{id}/diagnose` | admin / dashboard | run now (or re-run); returns the diagnosis |
| `GET` | `/v1/feedback/{id}/diagnosis` | app key | current diagnosis for a submission |
| `GET` | `/v1/feedback/{id}/diagnosis/runs` | admin | history |
| `PATCH` | `/v1/admin/diagnoses/{id}/review` | admin | `{ verdict, note }` |
| `GET` | `/v1/admin/logs/lookup?email=…|serial_no=…` | admin | proxies list-botfetch so the detail page can list every available file, not just the ones used |
| `GET` | `/v1/feedback/stats` | | gains `diagnosis` block (§7) |
| `GET` | `/v1/feedback` | | gains filters `ai_status`, `ai_side`, `ai_severity`, `tag` |
| `POST` | `/v1/admin/diagnoses/run-pending` | admin / dashboard | sweep queued or stale jobs (also triggered opportunistically on dashboard load) |

Schema change (done 2026-09-02): optional common field `device_serial` (ring/band
serial from the SDK). Lookups use `serial_no` when present, `email` otherwise.

---

## 6. Dashboard

### 6.1 Submission detail page — `/dashboard/submissions/{id}`

The drawer stays for a quick look; this page is where diagnosis lives.

```
┌ header: Sleep · Issue · 01 Sep · tester 10482 · iOS 2.4.0 · fw 1.9.2 ─── [Diagnose now] [Open in Supabase]
├─────────────────────────────┬──────────────────────────────────────────────────┐
│ Feedback                    │ AI diagnosis                                     │
│  quote, categories, details │  status ● done · 12 s · $0.004 · gemini-3.1-lite │
│  reporter, client context   │  ┌ FIRMWARE ┐  confidence ████░ 0.82  severity ▲ high │
│                             │  summary                                          │
│ Log files                   │  tags  ble_disconnect · sync_partial               │
│  app     10 Aug ↗  07 Aug ↗ │  evidence (3)   [firmware] 8-10 17:36:48 cmd 4109,0 │
│  ring    10 Aug ↗ (zip)     │                 [ring]     … --> dailysync ---> Add │
│  firmware 10 Aug ↗          │  suggested fix                                     │
│  device: POCO 2201116PI,    │  questions for tester                              │
│  Android 12, fv 1.2.6       │  review:  [Agree] [Disagree] [Unsure]  note…       │
├─────────────────────────────┴──────────────────────────────────────────────────┤
│ Log excerpt (97 lines)                                   [copy] [download .txt] │
│  ===== [app] 2.0.0.staging.luna =====                                            │
│  17:35:12 POST /v1/sleep/sync → 504 …                                           │
│  ===== [ring/BEHAVIOR] =====                                                     │
│  2026-08-10 17:35:59:114 ----> sdk --- dailysync ---> Add                        │
│  ===== [firmware] fv 1.2.6 =====                                                 │
│  8-10 17:36:48:1532 cmd: 4109,0                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Evidence lines are clickable and highlight the same line in the excerpt. Side badge
colours follow the design system: firmware = Strain Orange, sdk = Recovery Blue,
app = black, backend = Insights Magenta, not-a-bug / user-expectation = gray,
insufficient-logs = Luna Yellow (needs attention).

### 6.2 Main dashboard additions

- KPI row gains **AI checked** (done+no_logs ÷ issues) and **Logs found** (%).
- New chart **Root cause by side**, stacked per feature (categorical, ≤ 4 series +
  Other, validated palette).
- Filters: AI status, root-cause side, severity, tag.
- Table: side badge column; row click still opens the drawer, which now shows a
  one-line verdict and an "Open detail →" link.
- "Test data" card gets a sibling **Diagnosis** card: queue depth, failures, spend
  today / month, budget bar, "Run pending now" button.

### 6.3 Diagnosis overview page — `/dashboard/diagnosis`

Answers "how is the product doing" rather than "what happened to this bug":

- **Side × feature matrix** (counts, click-through to filtered table).
- **Firmware version vs issue rate** using `fw_version_seen` from logs (trustworthy),
  same for app version — this is the "how is FW build X doing" view from the
  original brief.
- **Top tags** over time; **devices with most issues** (model/OS from logs).
- **Confidence distribution** and **reviewer agreement rate** (are we trusting the
  model correctly).
- **Cost**: per day, per diagnosis, projected month.
- **Needs attention queue**: `insufficient_logs` and `disagree` verdicts.

---

## 7. Metrics the diagnosis unlocks

| metric | source | why it matters |
|---|---|---|
| Root-cause side share, overall and per feature | `root_cause_side` | routes work to the right team |
| Issue rate per firmware version | `fw_version_seen` | "is FW 1.9.3 better than 1.9.2" with log-verified versions |
| Issue rate per app version / OS / device model | `log_device` | catches platform-specific regressions |
| Tag clusters and their trend | `tags` | "ble_disconnect doubled after 1.9.3" |
| Log coverage rate | `log_coverage` | tells the FE team whether upload timing needs fixing |
| Self-reported vs observed version mismatch | `client.firmware_version` vs `fw_version_seen` | data quality of the app's context block |
| Backend errors surfaced from app logs | `api_error_*` tags + evidence | bugs that are actually server-side |
| Confidence and reviewer agreement | `confidence`, `review_verdict` | calibrates how much to trust auto verdicts |
| Time to diagnosis, cost per diagnosis, spend/day | `diagnosis_runs` | ops |
| Severity mix per feature | `severity` | prioritisation |

---

## 8. Security and privacy

- Logs API key and OpenRouter key are server-only env vars; never reach the dashboard.
- Redaction before storage and before the model: `Authorization`/`api-key` headers,
  `token`/`otp`/`password` JSON fields, bearer strings, phone numbers, 6-digit codes.
- The stored excerpt is capped at 100 lines / 16 KB; full files are never stored, only
  their URLs.
- OpenRouter call uses `X-Title: luna-feedback` and no data-retention opt-in.
- Diagnosis routes require admin key or dashboard session; nothing runs unauthenticated.

---

## 9. Environment

| var | status | purpose |
|---|---|---|
| `LUNA_LOGS_APIKEY` | set | logging API |
| `LUNA_LOGS_BASE_URL` | new, default `https://stage-app.gonoise.com` | host header + URL |
| `OPEN_ROUTER_KEY` | set | OpenRouter |
| `OPENROUTER_MODEL` | new, default `google/gemini-3.1-flash-lite` | swappable |
| `DIAGNOSIS_AUTO` | new, default `true` | enqueue on submit |
| `DIAGNOSIS_DAILY_BUDGET_USD` | new, default `2` | pauses auto runs when exceeded |

---

## 10. Build order

| # | deliverable | verified by |
|---|---|---|
| 1 | Migrations: `diagnoses`, `diagnosis_runs`, `diagnosis_jobs`, denormalised columns | DONE (+ `waiting_logs` status) |
| 2 | `logs/` module: client, file picker, capped downloader, zip member filter, per-source parsers (incl. X-LOG app lines), redaction, repeat collapsing | DONE, unit tests on synthetic samples modelled on the real files |
| 3 | `extract.ts`: window + scoring → ≤ 100 merged lines | DONE, unit tests |
| 4 | `ai/` module: OpenRouter client, prompt, strict JSON schema + zod, cost from usage | DONE; live runs on the sample tester: ~7 s, ~$0.002, firmware verdict with firmware evidence |
| 5 | Service + routes + queue + `waitUntil` background run + run-pending sweep with backfill + budget guard | DONE, e2e integration tests with fake logs API / S3 / model |
| 6 | Dashboard: `/dashboard/submissions/{id}` detail page with review, main-page AI filters/KPI/chart/badges/ops card | DONE, browser-checked |
| 7 | `/dashboard/diagnosis` overview page + `/v1/admin/diagnoses/overview` | DONE, browser-checked |
| 8 | Docs: `/docs` + API.md diagnosis endpoint, README, env examples | DONE |

Shipped 2026-09-02 (commits 71087d9 → e969986). Production has the keys set and reports
`enabled: true`; the first real submissions are queued and waiting for the evening log sync.

---

## 11. Decisions

Decided (2026-09-02):

1. **Every negative submission is diagnosed automatically in the background.** On
   `POST` with `is_positive: false` a job is queued; the cron worker drains it within
   ~5 minutes and fills the diagnosis columns. "Diagnose now" on the detail page
   runs the same pipeline synchronously for an immediate result or a re-run.
   Positive submissions are not diagnosed (no cost, nothing to find); they can be
   run manually from the detail page if ever needed.

2. **Device serial**: added as optional common field `device_serial`; the app fills it
   from the SDK when a ring/band is connected. Serial lookup first, email fallback.
3. **Vercel**: Hobby plan. 300 s per invocation and `waitUntil` cover the background
   run without cron or paid features.

Still open:

4. **Who reviews**: the review verdict is open to anyone with the dashboard key; if
   you want names on verdicts, we add a reviewer name at sign-in.
