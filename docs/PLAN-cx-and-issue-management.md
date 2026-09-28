# CX Reports and Issue Management — Plan

Two things change. First, reports stop coming only from internal testers: customer queries
that reach CX get filed here too, and every report says where it came from — `internal`
(default) or `cx`. Second, as volume grows, the dashboard has to answer three questions it
cannot answer well today:

1. **What is nobody looking at?** Untouched, stale, or overdue reports, with CX first.
2. **How many times has this been reported?** Mark one report and its look-alikes as the
   same problem, and see the count, the people affected and how many came through CX.
3. **Where exactly is it breaking?** Which version, which cohort, whether it is growing,
   whether a fix held.

Everything below builds on what exists: `submissions` (environment, triage status, Jira, AI
columns), `issue_kinds` + `submission_issue_kinds` (grouping, counts, trend), the diagnosis
pipeline, `buildWhere` (one filter slice shared by list, stats, analytics and kinds) and the
role table in `src/lib/actor.ts`.

---

## 0. Principles

- **One grouping system.** "Mark as the same issue" means "link to the same issue kind". A
  separate `duplicate_of` pointer would produce a second, disagreeing count. Kinds already
  have counts, affected users, trend and Jira; this plan makes them faster to build and
  harder to get wrong.
- **SQL first, AI on top.** Similarity, ageing, spikes and version skew are cheap queries.
  The model is used to judge, extract and summarise, always on demand or batched, never per
  page load. That follows the 2026-09-08 decision to run diagnosis on demand for cost.
- **Origin is its own dimension.** It is independent of `environment`. A CX report is usually
  `production`, but an internal tester on production is still `internal`.
- **A person confirms, the machine suggests.** Links proposed by rules or the model are shown
  as suggestions until someone accepts them, and a rejection is remembered.

---

## 1. Origin tagging: internal vs CX (the requested change)

### 1.1 Data model

```sql
-- supabase/migrations/20260928000000_origin_cx.sql
alter table luna_feedback.submissions
  add column if not exists origin        text not null default 'internal',
  add column if not exists submitted_via text,   -- which credential sent it: app | cx_tool | admin
  add column if not exists cx_ref        text,   -- ticket id in the CX tool, e.g. "FD-48213"
  add column if not exists cx_url        text,   -- deep link to that ticket
  add column if not exists cx_channel    text,   -- how the customer reached CX
  add column if not exists cx_agent      text,   -- the CX agent who pressed the button (an employee, not the customer)
  add column if not exists cx_transcript text;   -- the customer's words, with emails and phone numbers redacted before storing

update luna_feedback.submissions set submitted_via = 'app' where submitted_via is null;

-- Real customers' emails are never stored. Internal testers' emails still are.
alter table luna_feedback.submissions alter column email   drop not null;
alter table luna_feedback.submissions alter column user_id drop not null;

alter table luna_feedback.submissions
  add constraint submissions_origin_check     check (origin in ('internal', 'cx')),
  add constraint submissions_identity_check   check (
        (origin = 'internal' and email is not null and user_id is not null)
     or (origin = 'cx' and email is null and device_serial is not null and cx_ref is not null)),
  add constraint submissions_cx_channel_check check (cx_channel is null or cx_channel in
    ('email','chat','call','whatsapp','social','app_store','play_store','other')),
  add constraint submissions_cx_fields_only_cx check (origin = 'cx' or
    (cx_ref is null and cx_url is null and cx_channel is null and cx_agent is null and cx_transcript is null)),
  add constraint submissions_cx_transcript_len check (cx_transcript is null or char_length(cx_transcript) <= 5000);

create index if not exists submissions_origin_idx on luna_feedback.submissions (origin, occurred_on desc);
-- One report per CX ticket per feature: a second click returns the first report instead of filing another.
create unique index if not exists submissions_cx_ref_uidx
  on luna_feedback.submissions (cx_ref, feature_key) where origin = 'cx';

-- CX role
alter table luna_feedback.dashboard_users drop constraint dashboard_users_role_chk;
alter table luna_feedback.dashboard_users add constraint dashboard_users_role_chk
  check (role in ('admin', 'qc', 'developer', 'business', 'cx'));
```

Existing rows become `internal`, sent via `app`.

- **The ring serial identifies a CX report, not an email.** The CX tool always has the serial, so
  `device_serial` is required. `email` is not part of the CX contract: a request that includes
  one is rejected with 422, just as the API already rejects any unknown field. That means a
  misconfigured integration gets fixed rather than quietly sending us personal data.
- **Everything else comes from the serial.** At intake the server looks the serial up in the
  production logging API (`list-botfetch?serial_no=`), which returns `user_id`, platform, phone
  model, firmware (`fv`) and app version (`version_name`). The agent types none of it. `user_id`
  is a pseudonymous number and is kept so we can count people and spot repeat reporters.
- **Counting people** becomes `count(distinct coalesce(user_id::text, 'serial:' || device_serial))`
  in stats, kinds and analytics, so a CX report whose serial didn't resolve still counts once.
- `feedback_text` stays at 500 characters and holds the agent's summary. The customer's longer
  message, if sent, goes in `cx_transcript`.

### 1.2 How CX reports arrive

CX already works in its own tool. The agent checks that an issue is real and belongs here, then
presses a button in that tool, which calls our API. There is no webhook, and for now there is no
form on our dashboard for filing CX reports.

| caller | endpoint | key | origin |
|---|---|---|---|
| Luna app (internal testers) | `POST /v1/feedback/:feature` | `APP_API_KEY` | `internal` |
| CX tool (the agent's button) | `POST /v1/cx/feedback/:feature` | `CX_API_KEY` (new) | `cx`, set by the key |

- **One key per caller.** Each report records who sent it in `submitted_via`. We can rotate or
  revoke the CX key without touching the app, and a leaked app key cannot file CX reports. The
  CX key may call only `/v1/cx/*` and the schema endpoints; the app key may not call `/v1/cx/*`.
  If a third caller appears (for example an in-app form in the production app), move keys into
  an `api_clients` table managed from the People page.
- **The key decides the origin**, never the request body.
- **A separate path, not a flag on the app endpoint.** The CX contract differs (serial and ticket
  ref required, no email), and it gets its own section in `/docs`.
- If the production app later gets a "Report a problem" form, those reports come from customers
  without going through CX. Decide then between `cx` and a third value such as `customer_app`.

### 1.3 API

```
POST /v1/cx/feedback/sleep
x-api-key: <CX_API_KEY>
{
  "device_serial": "R2N08250600302",
  "is_positive": false,
  "occurred_on": "2026-09-25",
  "issue_categories": ["incorrect_sleep"],
  "feedback_text": "Customer says sleep shows 3h; they slept about 7h.",
  "details": { "actual_start_time": "11:30 PM" },
  "cx": { "ref": "FD-48213", "url": "https://…", "channel": "email", "agent": "agent name", "transcript": "…" },
  "user_id": 10482,
  "screenshots": [],
  "is_test": false
}
```

`user_id` and `screenshots` are optional; `user_id` is resolved from the serial when it's
missing. Screenshots use the same upload flow as the app.

The response is `201 { "ref": "LN-00042", "id": "…", "status": "open", … }`, or `200` with the first
report when that `cx.ref` has already been filed for that feature. The CX tool stores `ref` on
its own ticket.

| method | path | caller | purpose |
|---|---|---|---|
| POST | `/v1/cx/feedback/:feature` | CX key | file a report |
| GET | `/v1/cx/feedback/:ref` | CX key | status for the CX tool: triage status, the problem it belongs to (`LNK-…`) with its report count, fixed-in version, and the customer-safe update when there is one |
| GET | `/v1/feedback/schema[/:feature]` | app or CX key | features and categories, for the button's form in the CX tool |
| PATCH | `/v1/admin/submissions/:id` | `manage_triage` | *not built:* origin is fixed by the key that filed the report. Turning an internal report into a CX one would mean deleting a tester's email, and the identity rules (§1.1) forbid a CX report with one |
| GET | list / stats / analytics / kinds | read | new filter `origin=internal|cx` in `CommonQuery` + `buildWhere`, so every screen agrees |

`StatsResult` gains `by_origin`. `IssueKindWithCounts` gains `cx_count` and `cx_users`.

### 1.4 Roles

`ROLES` gains `cx`. A CX user can:

- **see** everything a `business` user sees;
- **use the AI on a report's page**: Diagnose now, Re-run, the follow-up chat, the similar-reports
  check (§3.2) and the customer-safe update draft (§5);
- **suggest** that a report belongs to a problem ("looks like LNK-0007"). This creates a
  `suggested` link (§3.5) for QC to confirm.

A CX user cannot change triage status, file Jira tickets, confirm or edit problems, manage
categories, or manage people.

```ts
run_diagnosis: ['admin', 'qc', 'developer', 'cx'],   // was admin, qc, developer
suggest_kinds: ['admin', 'qc', 'developer', 'cx'],   // new; confirming stays under manage_kinds
```

CX use of the AI counts toward the shared `DIAGNOSIS_DAILY_BUDGET_USD` (default $2). Revisit it
once real production volume shows.

### 1.5 Dashboard

- **Filter** "Source: All / Internal / CX" next to Environment, on every page (dashboard,
  analytics, kinds, diagnosis).
- **CX pill** on list rows, like the TEST tag. The row also shows the age of an open report
  ("open 6d").
- **Ticket page**: a CX block showing the ticket link, channel, agent, serial, the resolved user
  id and device, and the transcript. There is no email to show. QC gets an origin toggle.
- **KPIs**: CX reports in range, CX open, oldest open CX report.
- **No dashboard form for filing CX reports.** Build one later only if CX needs a fallback for
  when their tool is down.

### 1.6 Diagnosis for CX reports

Three things differ from internal tester reports:

1. **Production logs: choose the host from the report's environment.** One deployment uses one
   `LUNA_LOGS_BASE_URL` today, which defaults to stage, so production customers' logs are never
   found. Confirmed on 2026-09-27 with probes that used an address belonging to no one:

   | environment | lookup | status |
   |---|---|---|
   | production | `https://app.gonoise.com/logging/ring/list-botfetch?serial_no=…` / `?email=…` | 200 with the existing `LUNA_LOGS_APIKEY` |
   | stage | `https://stage-app.gonoise.com/logging/ring/list-botfetch?serial_no=…` / `?email=…` | 200 (what the code calls today) |
   | uat | **none for now**: credentials to come | no lookups |

   - **The same key works on both hosts**, so only the base URL changes. Replace
     `LUNA_LOGS_BASE_URL` with `LUNA_LOGS_BASE_URL_STAGE` / `LUNA_LOGS_BASE_URL_PRODUCTION`, keeping
     the old name as an alias for stage, and add an empty `LUNA_LOGS_BASE_URL_UAT`.
     `DiagnosisService` then holds one `LogsClient` per configured environment and chooses by
     `submission.environment`. The CX serial → user_id / device lookup (§1.1) uses the
     production client.
   - **UAT: no log lookups until its host is configured.** For a UAT report, Diagnose now is
     disabled with the note "Log lookup isn't set up for UAT yet". Nothing is queued and no
     `no_logs` result is recorded, so UAT reports don't skew the "logs found" numbers. When the
     host arrives, setting `LUNA_LOGS_BASE_URL_UAT` turns lookups on with no code change.
   - **Keep `list-botfetch` on stage; don't switch to `/logging/falcon/admin/list`.** The vendor
     note lists falcon as the stage email lookup, but it **ignores `email`**: given an address
     that belongs to no one, it returned other users' recent uploads on both hosts. Used as
     documented, it would attach a stranger's logs to a report.
   - **Response shape checked; no change needed.** A match comes back flat as
     `{ success, data: [...] }`, which is what `LogsClient.list` expects (confirmed 2026-09-27 on
     stage with a real tester: 3 devices). An empty result comes back wrapped as
     `{ success, data: { success, data: [], … } }`, which the client already reads as zero
     devices, the correct outcome. Worth a unit test so a future change doesn't break it.
   - **Production files are on a different host** (`service-logging-cdn.gonoise.com`; stage uses
     `stage-s3.gonoise.com`). Before trusting date-based file selection on production, confirm
     that production paths still contain `<user_id>-YYYY-MM-DD/`, which the `DATE_IN_PATH`
     pattern in `logs/client.ts` depends on.
   - **Look up by serial first, then email**, as today, for internal reports. CX reports always
     have a serial and never an email, so they use `serial_no` only. `serial_no` works on both hosts.
2. **Late reports and rolling logs.** Customers write in days after the event, and the logging
   service keeps only a rolling set of recent uploads. Before those files roll off, a **log
   snapshot at intake** should record the file links inside the issue window. This makes one
   `list-botfetch` call and no model call, and reuses the `diagnosis_jobs` queue for the
   same-day `waiting_logs` retry. The model still runs only when someone presses Diagnose.
3. **Second-hand wording.** The system prompt currently says "internal tester feedback". For CX
   reports, add: "Relayed by customer support from a customer's message; wording is
   second-hand and the date may be approximate." Before anything is stored or sent to the
   model, redact phone numbers, emails and order ids from `cx_transcript`, using the same
   redaction pass the app logs go through.

### 1.7 Privacy

**Decided: we never store real customers' email addresses.** Internal testers' emails are still
stored, as decided on 2026-09-02. Because there is no customer email, nothing needs masking by
role. The CX tool keeps the customer's contact details, and our record points to them only
through `cx_ref`.

- **The CX API rejects `email`** (§1.1).
- **Free text is redacted before it is stored.** On CX reports, email addresses and phone numbers
  are removed from `feedback_text` and `cx_transcript`, so the model never sees them either.
- **Log redaction gains an email rule.** `logs/redact.ts` already strips tokens, JWTs, OTPs and
  Indian mobile numbers, but not email addresses. Production customers' app logs are API dumps
  that can contain their email, so add the rule before production logs are diagnosed.
- **Stored device details come from the normalised lookup result**, which has no email field. The
  raw logging API response is never stored.

### 1.8 Files touched

`supabase/migrations/…_origin_cx.sql`, `src/schema/registry.ts` (`ORIGINS`, `CX_CHANNELS`),
`src/schema/buildValidator.ts` (CX variant: serial and `cx.ref` required, no email),
`src/config.ts` (`CX_API_KEY`, per-environment logs base URLs), `src/plugins/auth.ts` (CX key,
path scoping), new `src/modules/cx/` (routes for `/v1/cx/*`), `src/modules/diagnosis/logs/redact.ts`
(email rule), `src/modules/feedback/{repo,service,routes}.ts`,
`src/lib/actor.ts`, `src/modules/kinds/kinds.repo.ts`, `src/modules/analytics/analytics.repo.ts`,
`src/modules/jira/jira.service.ts` (origin + CX count in the description),
`src/modules/diagnosis/{ai/prompt.ts,logs/client.ts,diagnosis.service.ts}`, pages (`dashboard`, `submission`, `kinds`,
`analytics`, `users`, `docs`), `docs/API.md`, `README.md`, tests (`api`, `users`, `workflow`).

---

## 1b. Report IDs and sharing

A UUID can't be read aloud to a customer or typed into Slack. Every report gets a readable
reference, `LN-00042`, and every problem (issue kind) gets one too: `LNK-0007`. The UUID stays
the primary key and every foreign key; the reference is for people.

### 1b.1 IDs

```sql
-- reports: LN-00001, LN-00002, …
create sequence if not exists luna_feedback.submission_ref_seq;
alter table luna_feedback.submissions add column if not exists ref_no bigint;

-- Decided: number the existing reports oldest first (LN-00001 is the first report ever filed),
-- then continue from there.
update luna_feedback.submissions s
   set ref_no = n.rn
  from (select id, row_number() over (order by created_at, id) as rn from luna_feedback.submissions) n
 where s.id = n.id and s.ref_no is null;
select setval('luna_feedback.submission_ref_seq',
              coalesce((select max(ref_no) from luna_feedback.submissions), 0) + 1, false);

alter table luna_feedback.submissions
  alter column ref_no set default nextval('luna_feedback.submission_ref_seq'),
  alter column ref_no set not null;

-- lpad() truncates longer strings, so without the case LN-100000 would become LN-10000, a duplicate.
-- After 99,999 the number just grows a digit.
alter table luna_feedback.submissions
  add column if not exists ref text generated always as
    ('LN-' || case when ref_no < 100000 then lpad(ref_no::text, 5, '0') else ref_no::text end) stored;
create unique index if not exists submissions_ref_uidx on luna_feedback.submissions (ref);

-- issue kinds: LNK-0001, … (same pattern, own sequence, backfilled by created_at)
```

- **Gaps are normal and numbers are never reused.** An idempotent replay (`on conflict do nothing`)
  still draws a number, and deleting test data leaves holes. Test reports are numbered like any
  other, so a number never changes when a report is re-flagged.
- **API.** Every DTO carries `ref`. The `POST` response includes it, so the app can show "Thanks,
  your reference is LN-00042" and CX can quote it to the customer. `GET /v1/feedback/:id` accepts a
  UUID or a reference, ignoring case and padding (`ln-42`, `LN42` and `42` all find LN-00042).
  List filter: `?ref=`. Update `docs/API.md`, `/docs` and the Swift model.
- **Everywhere a report is named**, the reference comes first: list rows, the ticket header, Jira
  summaries (`[LN-00042] Sleep start recorded late`, plus the reference as a label), kind pages,
  the digest and the attention page. A **Go to** box in the dashboard header jumps straight to a
  reference. Notes and status notes turn `LN-…` and `LNK-…` into links.

### 1b.2 Sharing inside the team (people with accounts)

- **Links built from the reference.** Canonical `/dashboard/submissions/LN-00042` (the existing
  route, which already accepts any id segment; the page resolves reference or UUID), with a short
  form `/i/LN-00042` that redirects to it. Kinds use `/dashboard/kinds/LNK-0007` and `/k/LNK-0007`.
  Old UUID links keep working.
- **Copy link** (already on the ticket page) switches to the reference URL. A new **Copy as text**
  gives a line that pastes cleanly into Slack, WhatsApp or Jira:
  `LN-00042 · Sleep · Incorrect sleep · Open · CX · reported 14× (LNK-0007) — https://luna-feedback.buildsage.tech/i/LN-00042`
- **Back to the shared page after sign-in.** The `next` allowlist in `dashboard.html` accepts only
  `submissions/<uuid>` and `diagnosis`. Extend it to references, `/i/…`, `/k/…` and
  `kinds/<id>`. Kind links are dropped after sign-in today, which is an existing bug.
- **Link previews.** The HTML pages are public (only the data is gated), so Open Graph tags can
  make Slack show "Luna issue LN-00042". They carry the reference only, never report content,
  because the preview is visible to everyone in the channel.

### 1b.3 No sharing outside the team

Decided: links are only for people with a dashboard account. There are no public or
token-based share links, and every shared link requires sign-in.

---

## 2. What nobody is looking at: ageing, ownership, attention queue

### 2.1 Ship-now version (no new tables)

The existing columns already give a useful first cut:

| state | rule |
|---|---|
| **Untouched** | `status = 'open' and status_changed_at is null and jira_key is null` and no manual kind link, older than the threshold |
| **Stale** | non-terminal status and `coalesce(status_changed_at, created_at)` older than the threshold |
| **Old** | any non-terminal report, bucketed by age: 0–2d, 3–7d, 8–14d, 15–30d, 30d+ |

Default thresholds (code constants first, a table later if QC wants to tune them):

| origin | untouched after | stale after |
|---|---|---|
| cx | 1 day | 3 days |
| internal | 3 days | 7 days |

Critical severity (AI or human) halves both thresholds.

### 2.2 Foundation: activity log, owner, "needs info"

The system knows only the *last* status change, so it cannot measure time to first response,
time in status, or who touched a report. Add:

```sql
create table luna_feedback.submission_events (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references luna_feedback.submissions(id) on delete cascade,
  actor         text,
  action        text not null,   -- created | status | origin | assign | kind_link | kind_unlink | jira | diagnosis | note | priority
  from_value    text,
  to_value      text,
  note          text,
  visibility    text not null default 'internal' check (visibility in ('internal', 'cx')),  -- cx = safe to tell the customer
  created_at    timestamptz not null default now()
);

alter table luna_feedback.submissions
  add column assigned_to      text,          -- dashboard user email
  add column priority         text check (priority is null or priority in ('p0','p1','p2','p3')),  -- human call; overrides AI severity
  add column first_touched_at timestamptz,   -- first human action of any kind
  add column resolved_at      timestamptz,
  add column last_activity_at timestamptz;

-- "Waiting on the reporter or customer": pauses the stale clock.
-- status check gains 'needs_info'.
```

Every mutating route writes one event. That gives exact time-to-triage and time-to-resolve
metrics per origin, a history panel on the ticket, and notes that are split into internal
notes and **CX-safe updates**, which an agent can pass to the customer.

Kinds get `owner` too. A big kind with no owner is itself an attention item.

### 2.3 Attention page — `/dashboard/attention`

One screen with every "someone should look at this" list, CX first in each:

1. **Untouched** past threshold.
2. **CX waiting on us**: non-terminal CX reports, oldest first, showing age and CX ticket ref.
3. **Stale in progress**: no activity past threshold.
4. **Needs info for too long**: parked more than 7 days, so chase or close.
5. **Growing problems**: spikes (§4.2) and regressions (§4.3).
6. **Big kinds with no owner or no Jira**: at least 5 reports or any CX report.
7. **Diagnosis stuck**: failed or waiting too long (the existing ops card, moved here).

Sorting within a list uses a **priority score** whose parts are shown on hover:

```
severity = p0 4 · p1 3 · p2 2 · p3 1   (else AI severity: critical 4 · high 3 · medium 2 · low 1 · unknown 2)
impact   = distinct people on the kind (1 if unlinked); a CX person counts double
age      = days since reported, capped at 30
score    = severity × (1 + log2(impact)) × (1 + age / 7)
```

"My queue" filters the page to `assigned_to = me`. List-page **bulk actions** (select rows →
status, assign, link to kind, mark test) make clearing the queue quick.

### 2.4 Daily digest

Decided: **dashboard only for now.** The attention page is the daily summary, and the weekly AI
brief (§5) appears as a card on it.

Later, Slack: the existing nightly cron (`vercel.json`) already calls `run-pending`. Extending it
to post the attention counts and the top 5 items to a Slack incoming webhook
(`SLACK_WEBHOOK_URL`) is a small change once wanted.

---

## 3. Same issue, counted: similar reports and linking

### 3.1 "Similar reports" on every ticket (SQL, free)

A panel on the ticket page ranks candidates, recent negative non-test reports not already on
the same kind, by a transparent score. Each result shows why it matched:

| signal | weight |
|---|---|
| same feature | 3 |
| category overlap (Jaccard) | 2 × |
| shared AI tags (Jaccard) | 2 × |
| shared catalog event code | 3 |
| text similarity, `pg_trgm` `similarity(feedback_text, …)` | 2 × |
| same firmware / app version / platform | 1 / 1 / 0.5 |
| date distance | decays over 30 days |

This needs `create extension if not exists pg_trgm` (available on Supabase) and a GIN trigram
index on `feedback_text`. Chips on each result read, for example, "same categories · FW-03 · text 64% alike".

### 3.2 Mark as same issue (the "refer one issue" flow)

1. On ticket A, tick the look-alikes in the panel and press **Mark as same issue**.
2. If A already has a kind, the ticked tickets link to it. If not, a kind is created, with a
   title prefilled from A's AI `issue_kind` suggestion (or feature + category), and **A becomes
   the kind's reference ticket**.
3. **Ask AI to check** (optional, about $0.002 per click) sends A and the top 20 candidates in
   compact form to the model. The model labels each one `same`, `related` or `different` with a
   one-line reason and pre-ticks the `same` ones. A person confirms.

The same flow runs from a kind's page as **Find more instances**. It matches against the kind's
reference ticket and its signature (the union of categories, tags and event codes).

### 3.3 Counts where people look

- Ticket header: **"Reported 14× · 9 people · 5 via CX · first 3 Sep · last yesterday · ↑"**.
- List rows show the count next to the kind, e.g. "Sleep start late ×14".
- Kinds page: new columns for CX count, CX people, owner and age of the oldest open instance.
- Kind Jira ticket: "14 reports, 9 people, 5 customers via CX", refreshed when counts change.

### 3.4 Suggest at intake

When a report arrives from the app or the CX tool, score it against each open kind's signature
and title. A strong match creates a **suggested** link. The ticket shows "Looks like: *Sleep
start recorded late* (14 reports) — Confirm / Not this". The CX API response includes the top
match (`likely_problem: { ref: "LNK-0007", title, report_count }`), so the CX tool can show it
to the agent right away. CX reports have no diagnosis yet, so for them this is the main path into a kind.

### 3.5 Link states and kind hygiene

```sql
alter table luna_feedback.submission_issue_kinds
  add column state text not null default 'linked'
    check (state in ('suggested', 'linked', 'rejected'));   -- rejected rows block re-suggesting
alter table luna_feedback.issue_kinds
  add column reference_submission_id uuid references luna_feedback.submissions(id) on delete set null,
  add column owner          text,
  add column aliases        text[] not null default '{}',   -- titles of kinds merged into this one
  add column merged_into    uuid references luna_feedback.issue_kinds(id),
  add column fixed_in_app_version      text,
  add column fixed_in_firmware_version text,
  add column public_title   text,    -- customer-safe wording for the CX known-issues board
  add column workaround     text;
```

- Counts include `linked` only. Suggested links show muted ("+3 suggested").
- The existing `source` (`manual` / `ai` / `rule`) stays. Rule-based intake matches use `rule`.
- **Merge kinds**: move the links, keep the old title in `aliases`, and set `merged_into`.
  `applySuggestion` also matches on aliases, so the model stops recreating merged synonyms.
- **AI merge suggestions** (weekly, one call): "These 3 kinds look like the same problem."

Embeddings (pgvector) aren't needed at current volume, because trigram plus a model judge is
enough. They start to pay off once CX volume reaches thousands a month. By then, confirm an
embeddings provider (check whether the OpenRouter account offers embeddings) and add a
`vector` column to submissions and kinds.

---

## 4. Pinpointing where it breaks

### 4.1 Version and cohort skew per kind (SQL)

On each kind's page, compare the kind's reports with all reports in the same window by
firmware, app version, platform and phone model:

> Firmware 1.9.3: **83%** of this kind vs 31% of all reports (**2.7×**)

This also shows the **first seen version**. The baseline is all reports rather than the install
base, which we don't have, and the page says so.

### 4.2 Spikes

Per kind and per category, flag it when the last 3 days are at least 3× the prior 14-day daily
average and there are at least 3 reports. Computed live for the attention page and the digest,
with nothing stored.

### 4.3 Regressions

When a kind is marked fixed with `fixed_in_app_version` or `fixed_in_firmware_version`, a new
report linked to it from that version or later triggers these steps:

1. The link is flagged as a regression.
2. The kind reopens as `watching`.
3. It appears under Growing problems.

Versions compare as dotted numbers. An unparsable version never flags.

### 4.4 Repeat reporters and devices

The same `user_id` or `device_serial` with 3 or more negative reports in 14 days is flagged.
For CX this often means a faulty ring and a replacement conversation rather than a software bug.

### 4.5 Escaped defects: did testing catch it first? (the metric origin unlocks)

For each kind with CX reports, find whether an internal report came first:

- **Caught internally first**: X of Y customer-affecting kinds, with a median lead time.
- **Escaped**: kinds whose first report came from CX. Broken down by feature, these show where
  internal testing has blind spots.

This measures how well the stage and UAT programme protects customers, which is only possible
once reports carry an origin.

---

## 5. AI features (all on demand or batched)

The costs below are estimates at the current `google/gemini-3.1-flash-lite` pricing
($0.25 / $1.50 per M tokens).

| feature | trigger | what it returns | ≈ cost |
|---|---|---|---|
| **CX intake assistant** *(deferred: the agent fills the form in the CX tool)* | if wanted later, `POST /v1/cx/assist` from the CX tool with the customer's message | English summary (≤500 chars; translates Hindi/Hinglish), feature, categories from the active list, date noticed, matching known issues | $0.001 |
| **Similar-reports judge** | "Ask AI to check" | same / related / different + reason for each candidate | $0.002 |
| **Kind digest** | button on a kind; refreshed when 5+ new links arrive | pattern across instances: versions, shared evidence lines and event codes, root-cause hypothesis, what is still unknown, next step. Stored on the kind and used in its Jira ticket | $0.003 |
| **Kind merge suggestions** | weekly | kinds that look like the same problem | $0.002 |
| **Weekly brief** | Monday cron | 5 bullets: new kinds, growing kinds, top CX pain, regressions, escaped defects, built from aggregates only (no logs) | $0.003 |
| **Customer-safe update** | on a CX ticket, or when its kind is fixed | plain-language reply draft for the agent, without internal details: what we found, fix version, workaround | $0.001 |
| **Questions for the customer** | already in the verdict (`questions_for_tester`) | sets status to `needs_info` and hands the questions to the CX agent | free |

All of them count against `DIAGNOSIS_DAILY_BUDGET_USD` and are gated by `run_diagnosis`, which
now includes `cx` (§1.4).

---

## 6. Closing the loop with CX

- **Known issues, where CX works.** Open and watching kinds with their `public_title`,
  `workaround` and status, written for CX. They are available both as a dashboard page
  (`/dashboard/known-issues`) and to the CX tool through `GET /v1/cx/known-issues`, so the agent
  sees them before deciding to press the button.
- **+1 on a known issue.** `POST /v1/cx/known-issues/:ref/reports` (serial, CX ref, channel, date)
  files a minimal CX report already linked to the kind, taking the feature and most common
  category from the kind. Agents answer faster, and every repeat is still counted.
- **Kind fixed → notify list**: marking a kind fixed shows every CX report on it with its ticket
  ref, and offers **Resolve all linked reports** and a drafted customer update.
- **Status goes back through the same API.** The CX tool reads `GET /v1/cx/feedback/:ref`
  (status, problem, fixed-in version, customer-safe update). We never push into their tool.

---

## 7. Build order

**Phase 1 status (2026-09-27, branch `cx-phase-1`, not merged):** built and tested locally against a
throwaway Postgres. Migration `20260928000000_origin_cx_refs.sql`; CX API and key; serial → device
fill from the production logs host; `cx` role; email redaction; origin filter, CX tags and KPIs on
every page; `LN-`/`LNK-` references with lookup, `/i/` and `/k/` short links, Copy link / Copy as text,
and sign-in return; logs host per environment (UAT off); the Attention page (§2.1, §2.3 without
owner or assignee); and the CX line in the prompt. Also fixed along the way: the diagnose,
review and category-edit routes had no role check (any signed-in role could call them). Not in
Phase 1 as planned: re-tagging origin (see §1.3), and the log snapshot at intake, which stays in Phase 6.

**Phase 2 status (2026-09-28, branch `cx-phase-2`, not merged):** built and tested locally. Migration
`20260929000000_same_issue_links.sql` (link states, reference report, aliases, merged_into,
similarity_checks). Similar-reports panel, mark as same, counts on reports and list rows, intake
suggestions (CX API `likely_problem`), confirm / reject with rejections remembered, CX suggestions,
merge, reference report, "more reports like this" on a problem, and the AI same-issue check pulled
forward from Phase 5. Deviations: wording similarity is computed in the app (pg_trgm's algorithm,
no database extension); a problem's Jira ticket is not updated with new counts yet.

**Phase 3 status (2026-09-28, branch `cx-phase-3`, not merged):** built and tested locally. Migration
`20260930000000_activity_owner_priority.sql` (submission_events with notes, assigned_to, priority,
first_touched_at / last_activity_at / resolved_at, needs_info, problem owner, partial history
backfill). Decisions: anyone with a dashboard account can own a report or problem; CX can write
notes (team-only or customer-safe), the CX tool reads the latest customer-safe note and posts replies,
which reopen a needs_info report; priority sets both ordering and time limits (P0 4 h / 1 d, P1 1 d /
3 d, P2 defaults, P3 double); assignment shows as My queue and a count, no notifications.

| phase | scope | size |
|---|---|---|
| **1** | Origin + CX API (`/v1/cx/feedback`, `CX_API_KEY`, serial required, no email) + serial → device lookup + `cx` role + email redaction + origin filter/pill/KPIs + **`LN-`/`LNK-` references, lookup, copy link/text, sign-in return** (§1b.1–1b.2) + per-environment logs host (production on, UAT off) + ship-now ageing (§2.1) + attention page v1 + CX prompt line | M |
| **2** | Similar-reports panel (trigram) + mark as same + reference ticket + counts on tickets + link states (incl. CX suggestions) + suggest at intake | M |
| **3** | `submission_events`, assignee, priority, `needs_info`, bulk actions, exact time-to-triage/resolve | M |
| **4** | Version skew, spikes, regressions (`fixed_in_*`), repeat devices, escaped-defect metric | M |
| **5** | AI: similar-reports judge, kind digest, merge suggestions, weekly brief card, customer-safe updates | M |
| **6** | Known issues (page + CX endpoints + "+1"), status endpoint for the CX tool, notify-on-fix, log snapshot at intake. Later: Slack digest, UAT logs once credentials arrive | M |

Phases 1 and 2 are the minimum before CX starts filing. Without the similarity panel and
suggest-at-intake, every customer complaint about the same bug arrives as a separate report,
and the queue floods.

---

## 8. Decisions

Decided 2026-09-27:

| # | question | decision |
|---|---|---|
| 1 | How do CX reports arrive? | CX's existing tool calls our API when an agent presses a button after judging the issue is real. No webhook and no dashboard form (§1.2). |
| 2 | Identity on CX reports | Device serial is required. Email is not sent and not stored. `user_id` is optional and resolved from the serial (§1.1). |
| 3 | Keys | The CX tool gets its own `CX_API_KEY`, so every report records which caller sent it (§1.2). Production logs come from `app.gonoise.com` with the existing logs key (§1.6). |
| 4 | CX role | A new `cx` role: sees everything and uses the AI on a report's page. It can suggest a problem link, but cannot change status, file Jira tickets or confirm links (§1.4). |
| 5 | Customer emails | Never stored for real customers. Internal testers' emails are kept (§1.7). |
| 6 | Daily summary | Dashboard only (the attention page). Slack later (§2.4). |
| 8 | Reference format | `LN-00001` for reports and `LNK-0001` for problems. Existing reports are numbered oldest first, and numbering continues from there (§1b.1). |
| 9 | Sharing | Only with people who have a dashboard account. No external links (§1b.3). |
| — | UAT logs | Not fetched until credentials are shared. Diagnose is disabled for UAT reports (§1.6). |

Kept as defaults, easy to change later:

7. **Attention thresholds** (§2.1): how long a report can sit before the attention page flags it.
   *Untouched* means nobody has done anything with it; *stale* means someone did, but nothing has
   moved since.

   | origin | flag as untouched after | flag as stale after |
   |---|---|---|
   | CX | 1 day | 3 days |
   | internal | 3 days | 7 days |

Still open:

- The UAT logging host, which you'll share with its credentials.
