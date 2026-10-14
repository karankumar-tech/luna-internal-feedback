# Sprints — Plan

Today every issue lands in one list, the Reports page, whatever it is. QA also files issues against
a release cycle: a two-week sprint whose bugs are planned, fixed and checked together. This plan adds
**sprints**: a report can belong to one sprint, the Reports list leaves sprint issues out by default,
and a new Sprints page lets QC run the cycle: see the current sprint, close it, carry what is left
into the next sprint or back to the main list, and plan, edit or delete sprints.

Everything builds on what exists: `submissions` (status, owner, priority, tags, history),
`submission_events` (the history), `buildWhere` (one filter slice shared by the list, stats and
analytics), the home list (`/v1/home/reports`), the role table in `src/lib/actor.ts` and the submit
contract in `src/schema/buildValidator.ts`.

The look is mocked up in [`docs/design/sprints-mockup.html`](design/sprints-mockup.html) (open it in
a browser; it links the real `app.css`, so it matches the dashboard).

---

## 0. Principles

- **A report is in one place.** It is either on the main list or in exactly one sprint
  (`submissions.sprint_id`). Sprints are not a kind of tag: tags are free text with no dates, no
  state and no close step.
- **A sprint issue is still an ordinary report.** Diagnosis, problems (LNK-), Jira, notes, owner,
  priority and history work on it unchanged. Only where it is *listed* changes.
- **The calendar suggests, a person closes.** Sprints run 1st to 15th and 16th to month end by
  default, but the current sprint only moves on when QC closes it. Nothing happens automatically on
  the 16th.
- **Open work never sits in a closed sprint.** Closing moves every open issue somewhere, and an
  issue reopened later moves to the current sprint. So a closed sprint only ever holds finished
  issues, which is also what makes deleting one safe.
- **Deleting is deliberate.** Never automatic, never while anything in the sprint is open, never the
  current sprint, and only after typing the sprint's reference.
- **The app stays simple.** Two choices: the current sprint or the next one. Everything else is done
  on the dashboard.

---

## 1. The sprint cycle

### 1.1 Cadence and names

A sprint is a half month by default: the 1st to the 15th, then the 16th to the last day of the month.
Dates are calendar days in the app's time zone (`Asia/Kolkata`, as everywhere else).

| ref | default name | dates | days |
|---|---|---|---|
| `SPR-202610-01` | Sprint · October 2026 · 01 | 1–15 Oct 2026 | 15 |
| `SPR-202610-02` | Sprint · October 2026 · 02 | 16–31 Oct 2026 | 16 |
| `SPR-202611-02` | Sprint · November 2026 · 02 | 16–30 Nov 2026 | 15 |
| `SPR-202612-02` | Sprint · December 2026 · 02 | 16–31 Dec 2026 | 16 |
| `SPR-202701-01` | Sprint · January 2027 · 01 | 1–15 Jan 2027 | 15 |
| `SPR-202702-02` | Sprint · February 2027 · 02 | 16–28 Feb 2027 | 13 |
| `SPR-202802-02` | Sprint · February 2028 · 02 | 16–29 Feb 2028 | 14 |

- **Reference** `SPR-YYYYMM-NN`: year, month, and `01` or `02` for the half its start date falls
  in. Mono and upper case like `LN-`/`LNK-`/`BM-`, sorts by time, and is the sprint's identity in
  URLs (`/dashboard/sprints/SPR-202610-01`, short link `/s/SPR-202610-01`).
- **Name** defaults to `Sprint · <Month> <Year> · NN` and can be renamed (for example
  "Sprint · October 2026 · 01 — Luna 2.4 RC"). An optional **goal** (one sentence) shows under it.
- **Dates can be adjusted** (a sprint stretched to the 18th, say), but sprints never overlap and the
  start date's half decides the reference, so there is at most one sprint per half month. Editing
  keeps the start inside its half, so a reference never changes once links to it exist. A one-week
  sprint would need a suffix (`SPR-202610-01b`); left out of v1.

### 1.2 States

```
 planned ──(previous sprint closed)──▶ active ──(QC closes it)──▶ closed
```

- **planned**: a future sprint. Issues can already be put in it (the app's "next sprint").
- **active**: *the current sprint*. Exactly one at a time (a unique index enforces it).
- **closed**: finished. Holds only finished issues (resolved, closed or won't fix). Read-only
  apart from those issues' own status, notes and so on.

**Current** means the active sprint. **Next** means the earliest planned sprint that starts after
it. The server keeps both in existence: if there is no planned sprint when one is needed (at submit
with `sprint: "next"`, or when a sprint closes), it creates the next free half month.

### 1.3 Closing a sprint (carrying issues over)

QC presses **Close sprint**. A dialog shows how many issues are done (they stay with the sprint) and
lists the open ones: open, triaged, in progress or needs info. The default is to move all of them
to the next sprint. Each one can be changed to:

- the next sprint (default),
- the main issue list (out of sprints altogether), or
- another planned sprint.

On confirm, in one transaction:

1. lock the sprint row; refuse unless it is `active`;
2. find or create the next planned sprint;
3. move each open issue as chosen, writing a `sprint` history event per issue
   (`from SPR-202610-01 to SPR-202610-02`, note "Carried over when SPR-202610-01 closed");
4. mark the sprint `closed` (`closed_by`, `closed_at`);
5. make the next sprint `active` (`activated_at`);
6. if no planned sprint is left after it, create one for the following half, so a current and a
   next always exist.

Moving issues does not touch their status, owner, priority or the response clock (`touch: false`):
carrying over is bookkeeping, not someone responding.

**Closing early** is allowed (say, on the 14th). The next sprint becomes current at once, so the
app's "current sprint" files into it from that moment, but it keeps its planned dates (and so its
reference). The page shows "Current early · starts Fri 16 Oct" until the dates begin.

### 1.4 Overdue

If nobody closes a sprint, it stays current past its end date. The Sprints page shows
"Overdue by 2 days. Close it to start SPR-202610-02." on a yellow banner (yellow: it waits on a
person). The app's "current sprint" is still that sprint until it is closed.

### 1.5 Reopened issues

If a finished issue in a closed sprint is set back to an open status (from the report page or in
bulk), `FeedbackService.setStatus` also moves it to the current sprint and records both changes. The
toast says so: "Reopened, and moved to SPR-202610-02 (the current sprint)". No other code path
reopens a report today (`reopenAfterReply` only leaves `needs_info`, which is not finished).

### 1.6 Deleting a sprint

Allowed only when the sprint is not the current one and has no open issues. That leaves a planned
sprint with nothing open in it, or a closed sprint, which by §1.5 only holds finished issues.

Deleting removes the sprint **and the issues in it, permanently**: their history, notes, AI checks,
chat and problem links go with them (all `on delete cascade` today), and their screenshots are
removed from ImageKit afterwards, best effort, as `deleteTestData` does. Jira tickets are not touched.
The dialog names the count ("Delete SPR-202609-01 and its 22 closed issues?") and asks for the
reference to be typed. Nothing ever deletes a sprint on its own.

Only admins may delete (decided 2026-10-14).

---

## 2. Data model

```sql
-- supabase/migrations/20261015000000_sprints.sql  (after the Apps feature's 20261014000000_apps_feature.sql)

-- ---------------------------------------------------------------------------
-- Sprints: half-month cycles QA files issues against. One is active (the current sprint).
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.sprints (
  id           uuid primary key default gen_random_uuid(),
  ref          text not null,                 -- SPR-202610-01
  name         text not null,                 -- Sprint · October 2026 · 01
  goal         text,
  starts_on    date not null,
  ends_on      date not null,
  status       text not null default 'planned',
  created_by   text,                          -- an email, or 'migration' / 'system' for ones made automatically
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  activated_at timestamptz,
  closed_by    text,
  closed_at    timestamptz,
  constraint sprints_ref_key        unique (ref),
  constraint sprints_ref_format     check (ref ~ '^SPR-[0-9]{6}-0[12]$'),
  constraint sprints_status_check   check (status in ('planned', 'active', 'closed')),
  constraint sprints_dates_check    check (ends_on >= starts_on and ends_on - starts_on <= 62),
  constraint sprints_name_len       check (char_length(name) between 1 and 80),
  constraint sprints_goal_len       check (goal is null or char_length(goal) <= 300),
  constraint sprints_closed_fields  check ((status = 'closed') = (closed_at is not null))
);

-- Only one current sprint.
create unique index if not exists sprints_one_active_uidx on luna_feedback.sprints ((true)) where status = 'active';
create index if not exists sprints_starts_idx on luna_feedback.sprints (starts_on);
alter table luna_feedback.sprints enable row level security;

-- ---------------------------------------------------------------------------
-- Which sprint a report is in. Null = the main issue list.
-- "restrict": a sprint cannot disappear from under its issues; deleting one deletes them explicitly.
-- ---------------------------------------------------------------------------
alter table luna_feedback.submissions
  add column if not exists sprint_id uuid references luna_feedback.sprints(id) on delete restrict;

-- Sprints hold issues, not "working fine" feedback.
alter table luna_feedback.submissions drop constraint if exists submissions_sprint_issue_only;
alter table luna_feedback.submissions add constraint submissions_sprint_issue_only
  check (sprint_id is null or not is_positive);

create index if not exists submissions_sprint_idx
  on luna_feedback.submissions (sprint_id, status) where sprint_id is not null;

-- The history records moves between sprints and the main list (from/to = sprint ref or null).
alter table luna_feedback.submission_events drop constraint if exists submission_events_action_chk;
alter table luna_feedback.submission_events add constraint submission_events_action_chk check (action in (
  'created', 'status', 'assign', 'priority', 'note', 'test_flag',
  'kind_link', 'kind_suggest', 'kind_confirm', 'kind_reject', 'jira', 'diagnosis', 'ask_reporter', 'regression', 'tag',
  'go_live', 'sprint'));

-- ---------------------------------------------------------------------------
-- The first two sprints: 1–15 October is current, 16–31 October is next.
-- If this ships after the 15th, the first sprint shows as overdue until QC closes it.
-- ---------------------------------------------------------------------------
insert into luna_feedback.sprints (ref, name, starts_on, ends_on, status, created_by, activated_at) values
  ('SPR-202610-01', 'Sprint · October 2026 · 01', '2026-10-01', '2026-10-15', 'active',  'migration', now()),
  ('SPR-202610-02', 'Sprint · October 2026 · 02', '2026-10-16', '2026-10-31', 'planned', 'migration', null)
on conflict (ref) do nothing;
```

Notes:

- **Overlap** is checked in the service inside the create/edit transaction (`select … for update`
  over neighbouring sprints), not with a `btree_gist` exclusion constraint, so no extension is
  needed. The unique `ref` already stops two sprints starting in the same half.
- **Carried over / carried in** counts come from `submission_events` (`action = 'sprint'` with the
  carry-over note), not from columns, so there is nothing to keep in sync.
- Existing reports get `sprint_id = null`: everything filed so far stays on the main list.
- The migration must ship before the app sends `sprint` (a body field the server does not know is
  rejected by `.strict()`).

---

## 3. API

### 3.1 Filing an issue into a sprint (the app, and the dashboard's Report page)

`POST /v1/feedback/:feature` gets one optional body field:

```jsonc
{
  "is_positive": false,
  "user_id": 1042, "email": "aditi@gonoise.com",
  "issue_categories": ["stages_wrong"],
  "feedback_text": "Deep sleep shows 0 min after a 2 h nap",
  "client": { "app_version": "2.4.0", "build_number": "812", "platform": "android" },
  "sprint": "current"            // optional: "current" | "next" | null (null or absent = main list)
}
```

- Resolved on the server when the report is filed: `current` = the active sprint, `next` = the
  next planned one (created if missing). The app never sends a sprint reference.
- Only issues: `sprint` on positive feedback is refused with
  `422 sprint: "is only for issues (is_positive: false)"`.
- Added in `buildSubmissionValidator` only, not in `sharedExtras`, so the CX contract keeps refusing
  it (CX reports are customers' problems; QC can still move one into a sprint from the dashboard).
- An idempotent replay returns the first report as it is, whatever `sprint` the retry carried.
- The response (and every report DTO) gains `sprint: { ref, name, status } | null`.

### 3.2 What the app shows: `GET /v1/sprints/options`

Callable with the app key. The app labels its two-choice control from this, and can cache it for
the session (it changes only when a sprint closes or is renamed).

```json
{
  "current": { "ref": "SPR-202610-01", "name": "Sprint · October 2026 · 01", "starts_on": "2026-10-01", "ends_on": "2026-10-15", "days_left": 1, "overdue_days": 0 },
  "next":    { "ref": "SPR-202610-02", "name": "Sprint · October 2026 · 02", "starts_on": "2026-10-16", "ends_on": "2026-10-31", "days_left": null, "overdue_days": 0 }
}
```

`/v1/feedback/schema` also gets a small `sprints: { options_endpoint: "/v1/sprints/options",
values: ["current", "next"] }` descriptor, like `uploads`, so the app can tell the field exists.

### 3.3 Reading sprints (any signed-in role)

| route | returns |
|---|---|
| `GET /v1/sprints` | every sprint, newest first, each with `issues`, `open`, `done`, `by_status`, `p0_open`, `p1_open`, `carried_in`, `carried_out`, `days_left` / `overdue_days`, `can_delete` + `delete_blocked_by` |
| `GET /v1/sprints/:ref` | one sprint with the same counts, plus by feature, and `prev` / `next` refs for the switcher. `current` and `next` work as refs |
| `GET /v1/home/reports?sprint=SPR-202610-01` | the sprint's issues, in exactly the home list's shape and paging, so the Sprints page reuses the list code |

The list filter `sprint` joins `CommonQuery`/`CommonFilters`, so the list, stats and analytics
endpoints all understand it:

| value | meaning |
|---|---|
| `none` | on the main list (not in any sprint) |
| `any` | in some sprint |
| `current`, `next` | the current or next sprint |
| `SPR-202610-01` | that sprint |

Defaults differ by endpoint on purpose: the **home** list, its counts and its category bars default
to `none` (§5); `/v1/feedback`, stats and analytics default to no sprint filter (everything), as
they do today.

### 3.4 Running sprints (QC, admin)

| route | does |
|---|---|
| `POST /v1/admin/sprints` | Create. Body `{ starts_on?, ends_on?, name?, goal? }`; with no dates it takes the next free half month after the latest sprint. Created as `planned`. |
| `PATCH /v1/admin/sprints/:ref` | Rename, set the goal, or change dates while `planned` or `active`. The start stays inside its half (so the ref never changes) and is fixed once the sprint is active. Closed sprints are read-only. |
| `POST /v1/admin/sprints/:ref/close` | Close the active sprint. Body `{ "default": "next" \| "main", "overrides": { "<submission uuid or LN-ref>": "next" \| "main" \| "SPR-…" } }`. Returns the closed sprint, the new current and next, and what moved where. |
| `DELETE /v1/admin/sprints/:ref?confirm=SPR-202609-01` | Delete per §1.6. `confirm` must repeat the ref. Returns `{ deleted_issues }`. |
| `PATCH /v1/admin/submissions/:id` | Gains `sprint`: a ref, `current`, `next`, or `null` for the main list. Refused for a closed sprint or a positive report. |

Bulk moves reuse the existing pattern: the dashboard calls `PATCH /v1/admin/submissions/:id` per
selected report, as status, owner and priority do today.

Errors, in the API's usual shape:

| case | response |
|---|---|
| move into a closed sprint | `409 CONFLICT` "SPR-202609-02 is closed: move it to the current or a planned sprint" |
| close a sprint that is not active | `409` "Only the current sprint can be closed" |
| delete with open issues | `409` "13 issues in SPR-202610-01 are still open. Close the sprint or move them first" |
| delete the current sprint | `409` "SPR-202610-01 is the current sprint. Close it first" |
| overlapping dates | `422` `starts_on`: "overlaps SPR-202610-02 (16–31 Oct)" |
| `confirm` missing or wrong | `422` `confirm`: "type SPR-202609-01 to delete it" |
| role not allowed | `403` "Your role (developer) cannot do this" (the existing guard) |

---

## 4. Roles

One new permission in `PERMISSIONS`, plus the delete question:

```ts
/** Create, edit and close sprints, and move reports between sprints and the main list. */
manage_sprints: ['admin', 'qc'],
/** Delete a finished sprint and the closed issues in it. */
delete_sprints: ['admin'],
```

| | admin | qc | developer | business | cx | app key |
|---|---|---|---|---|---|---|
| see sprints and their issues | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| file an issue into current / next (Report page, app) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| create, edit, close a sprint | ✓ | ✓ | – | – | – | – |
| move reports between sprints | ✓ | ✓ | – | – | – | – |
| delete a finished sprint | ✓ | – | – | – | – | – |

Anyone who can file a report today can pick current or next while filing; the CX tool cannot
(§3.1). Developers keep doing what they do on any report (status needs `manage_triage`, which they do not
have today; tags, go-live, problems and notes as before).

---

## 5. Where sprint issues show up

| surface | sprint issues | why |
|---|---|---|
| **Reports** (home): list, tabs, today / 7-day counts, category bars | left out by default | the main list is for issues outside the sprint cycle. A **Sprint** field in the filter panel (Not in a sprint · Any sprint · Current · a specific sprint) brings them in. A line under the tabs says "13 open issues are in the current sprint", linking to it. |
| **My queue** tab | left out (open question §9) | consistent with the list; the Sprints page has its own "Mine" tab |
| **Needs attention** and the bell badge | left out | a sprint has its own clock (its end date) and its own page |
| **Problems** (LNK-) | included | a sprint bug can be the same problem as a field report; counts stay honest |
| **Analytics** | included; sprint filter in a later pass | totals should not shrink because QA used a sprint |
| **Diagnosis, similar reports, intake suggestions** | unchanged | they work per report |
| **Report page** (`/dashboard/submissions/:id`) | shows its sprint | a Sprint line with a move select (QC), and moves in the history |
| **Header search** | `SPR-…` jumps to the sprint | like `LN-` and `LNK-` |
| **CX tool reads** | unchanged | sprint never appears in what CX's tool reads |

In code: `buildWhere` learns `sprint`; `HomeRepo.reports`, `summary` and `categories` add
`s.sprint_id is null` unless a sprint filter is given; `AttentionRepo` adds `s.sprint_id is null` to
its base conditions.

---

## 6. Dashboard

### 6.1 Sprints page — `/dashboard/sprints`, `/dashboard/sprints/:ref`

A new **Sprints** item in the sidebar's Overview group, right after Reports (lucide
`calendar-range`). `/dashboard/sprints` opens the current sprint. Top to bottom:

1. **Heading**: "Sprints", one sentence, and **Report an issue** (opens the Report page with the
   current sprint picked) and **New sprint** (QC).
2. **Sprint strip**: every sprint as a row of chips in time order, with previous / next arrows.
   Closed ones carry a tick, the current one a black "Current" badge, planned ones a dashed outline,
   the one on screen the yellow selection. A "Plan next" chip at the end (QC). Scrolls sideways on a
   phone.
3. **Sprint card**: name, ref, dates and goal; a time bar with one notch per day ("Day 14 of 15 ·
   Closes tomorrow", or the overdue banner) and, above it, how many issues were filed each day; the big number is **open issues** with "of 31 · 18 done (58%)" beneath;
   P0/P1 open and carried-in counts; on the right, status as one stacked bar with a legend, and
   issues by feature as bars that filter the list when clicked (the home page's pattern). Actions:
   **Close sprint** (primary, current sprint only), **Edit**, and a menu with **Delete**, shown
   disabled with its reason when not allowed.
4. **Issues card**: the home list's rows (headline, the tester's words, ref, feature, owner, status,
   priority, age), with an extra "from SPR-…" mark on carried-over issues. Tabs Open · Done · All ·
   Mine, the Filter button, paging. Picking rows (QC) opens the bulk bar: **Move to…** (next sprint,
   main list, another planned sprint), status, owner, priority.
5. **All sprints**: a table of every sprint (dates, state, issues, done %, carried over) with
   per-row actions.

### 6.2 Dialogs

- **Close sprint**: counts, the default destination as two radio cards (next sprint / main list),
  "Choose per issue" expanding a list with one select per open issue, and a line saying what happens
  next ("SPR-202610-02 becomes current; SPR-202611-01 is planned as next").
- **New / edit sprint**: start and end date (prefilled with the next free half), the reference it
  will get, name (prefilled), goal. Overlaps are reported on the field.
- **Delete sprint**: what goes (issue count, screenshots, history) and what stays (Jira), then the
  reference typed to enable the red button.

### 6.3 Changes to existing pages

- **Reports**: Sprint in the filter panel and the chips row; the hint line; bulk bar gains
  **Move to sprint…** (current, next, planned ones). Default view unchanged apart from leaving sprint
  issues out, so its cache (`luna.home.v1`) stays valid.
- **Report an issue** (`/dashboard/report`): a three-way control under the form, "Not in a
  sprint · Current (ends 15 Oct) · Next (16–31 Oct)", hidden for "working fine"; `?sprint=current`
  preselects it.
- **Report page**: a Sprint line next to Tags and Go-live ("SPR-202610-01 · current" with a select
  for QC), and history lines such as "Priya moved it from SPR-202610-01 to SPR-202610-02 (carried
  over)".
- **Header search**: `SPR-` references.

### 6.4 The app

One control on the issue form, off by default:

> **Add to a sprint** ○ No ● Current sprint · ends 15 Oct ○ Next sprint · 16–31 Oct

Labels come from `GET /v1/sprints/options`; the value sent is `"current"`, `"next"` or nothing. Not
shown for positive feedback. Any other change (another sprint, back to the main list) happens on the
dashboard.

---

## 7. Files touched

| file | change |
|---|---|
| `supabase/migrations/20261015000000_sprints.sql` | §2 |
| `src/modules/sprints/cycle.ts` | half-month maths: `halfOf(date)`, `nextHalf`, `refFor`, `defaultName`, `daysLeft` (pure, unit-tested) |
| `src/modules/sprints/sprints.repo.ts` | CRUD, counts, `current()`/`next()`/`ensureNext()`, close and delete transactions |
| `src/modules/sprints/sprints.service.ts` | rules of §1, history events, ImageKit cleanup on delete |
| `src/modules/sprints/sprints.routes.ts` | §3.2–3.4 |
| `src/build-app.ts` | wire the module; hand the sprint service to feedback and home |
| `src/lib/actor.ts` | `manage_sprints`, `delete_sprints` |
| `src/plugins/auth.ts` | `/dashboard/sprints` public path, `/s/` short links, `/v1/sprints/options` for the app key |
| `src/schema/buildValidator.ts` | `sprint` on `buildSubmissionValidator` only, refused on positive |
| `src/modules/feedback/feedback.repo.ts` | `sprint_id` + sprint ref/name in `COLUMNS` (join), `sprint` in `CommonFilters`/`buildWhere`, `setSprint` |
| `src/modules/feedback/feedback.service.ts` | resolve `current`/`next` at submit; `moveToSprint`; reopen-moves-to-current in `setStatus` |
| `src/modules/feedback/feedback.routes.ts` | `sprint` in `CommonQuery` and the triage PATCH; `sprints` descriptor in the schema |
| `src/modules/home/home.repo.ts`, `home.routes.ts` | `sprint_id is null` by default; `sprint` filter; `sprint` on each item |
| `src/modules/attention/attention.repo.ts` | leave sprint issues out |
| `src/modules/pages/pages.routes.ts`, `src/pages/sprints.html` (new) | the page (§6.1) |
| `src/pages/scripts/shell.js` | Sprints nav item and icon; `SPR-` in the header search |
| `src/pages/dashboard.html` | Sprint filter, hint line, bulk move |
| `src/pages/report.html` | the sprint control |
| `src/pages/submission.html` | Sprint line, move select, history wording |
| `src/pages/docs.html`, `docs/API.md` | `sprint` field, `/v1/sprints/options`, admin routes |
| `test/unit/sprint-cycle.test.ts`, `test/integration/sprints.test.ts` (new) | §8 |

---

## 8. Tests

Every run against a throwaway local Postgres, never `.env` (which is production): prefix each
`npx vitest run` with that local database's `SUPABASE_DB_URL`. `sprints.test.ts` refuses to run
against anything but localhost, because it takes over the sprints table (and puts it back).

Unit (`cycle.ts`):

- 1–15 and 16–end for 30- and 31-day months; February 28 and 29 (2027, 2028); 31 Dec → 1 Jan
  rolls the year; `refFor` / `defaultName`; days left and overdue across month ends, in IST.

Integration:

- submit with `sprint: "current"` and `"next"` lands in the right sprint; `"next"` creates the
  sprint when none is planned; `sprint` on positive feedback → 422; the CX endpoint refuses `sprint`;
  replay keeps the first sprint.
- home list, counts and category bars leave sprint issues out; `?sprint=` brings them back;
  attention leaves them out; analytics still counts them.
- close: open issues move per default and overrides, done ones stay, history rows written, next
  becomes active, a new next appears, only one active at any time; closing twice → 409.
- reopening a finished issue in a closed sprint moves it to the current sprint.
- delete: refused with open issues, refused for the current sprint, refused without the right
  `confirm`; allowed for a closed sprint and removes its issues (and only its issues).
- moving into a closed sprint → 409; overlapping dates → 422.
- permissions: developer, business and cx get 403 on create/close/move/delete; the app key can read
  options and submit, and cannot call the admin routes.

Then a local smoke in the browser (`api-local-db` on port 3055): file from the Report page into the
current sprint, see it on the Sprints page and not on Reports, close the sprint, check the move.

---

## 9. Build order

| phase | scope | done when |
|---|---|---|
| **1** | Migration, `cycle.ts`, sprints module (read, create, edit, close, delete), `sprint` on submit + `/v1/sprints/options`, `sprint` filter, home and attention leave sprint issues out, `manage_sprints` | API tests pass locally; the app team can start on the toggle |
| **2** | Sprints page, Report page control, Report-page sprint line and history, Reports filter + hint + bulk move, sidebar and search | the local smoke above works at desktop and phone widths |
| **3** | API docs (`docs.html`, `docs/API.md`), full suite, review | you have tried it locally; then push to `main` (which deploys) and run the migration on the live database |

Work happens on a branch; nothing is pushed until you have tried it. Migrations are run against the
live database by you.

---

## 10. Decisions

Taken from your brief (2026-10-14):

| # | question | decision |
|---|---|---|
| 1 | Cycle | Half months, 1–15 and 16–end; the first sprint is 1–15 Oct 2026 (§1.1) |
| 2 | When does the current sprint change? | Only when QC closes it (§1.3) |
| 3 | Leftover issues at close | Move to the next sprint (default) or back to the main list, per issue (§1.3) |
| 4 | Main Reports list | Leaves sprint issues out by default (§5) |
| 5 | Who runs sprints | QC (and admins): create, edit, close, move issues (§4) |
| 6 | Deleting | Only with no open issues; deletes the sprint and its closed issues; never automatic (§1.6) |
| 7 | App | Optional `sprint`: `current` or `next` only; everything else on the dashboard (§3.1) |
| 8 | Who deletes | Admins only (2026-10-14) |
| 9 | Names | `SPR-202610-01` and "Sprint · October 2026 · 01", as drafted |
| 10 | Needs attention | Leaves sprint issues out, as drafted |
| 11 | My queue | Leaves sprint issues out like the rest of the Reports list, as drafted; the Sprints page has its own Mine tab |

Defaults I picked, easy to change:

- An issue reopened in a closed sprint moves to the current sprint (§1.5).
- The current sprint cannot be deleted, even when empty; close it first.
- Only issues go into sprints, not "working fine" feedback.
- CX reports can be moved into a sprint from the dashboard, but the CX tool cannot file into one.
- Moving between sprints does not count as responding (the attention clock is not reset).

No questions are open. Built on branch `sprints` (2026-10-14).
