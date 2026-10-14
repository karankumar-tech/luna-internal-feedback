-- Sprints: half-month cycles QA files issues against. A report is on the main list (sprint_id null)
-- or in exactly one sprint. One sprint is active (the current sprint); it only moves on when QC
-- closes it. See docs/PLAN-sprints.md.

-- ---------------------------------------------------------------------------
-- The sprints. ref = SPR-<year><month>-<01|02>, from the half month the sprint starts in.
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.sprints (
  id           uuid primary key default gen_random_uuid(),
  ref          text not null,
  name         text not null,
  goal         text,
  starts_on    date not null,
  ends_on      date not null,
  status       text not null default 'planned',
  -- An email, or 'migration' / 'system' for sprints made automatically.
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  activated_at timestamptz,
  closed_by    text,
  closed_at    timestamptz,
  constraint sprints_ref_key       unique (ref),
  constraint sprints_ref_format    check (ref ~ '^SPR-[0-9]{6}-0[12]$'),
  constraint sprints_status_check  check (status in ('planned', 'active', 'closed')),
  constraint sprints_dates_check   check (ends_on >= starts_on and ends_on - starts_on <= 62),
  constraint sprints_name_len      check (char_length(name) between 1 and 80),
  constraint sprints_goal_len      check (goal is null or char_length(goal) <= 300),
  constraint sprints_closed_fields check ((status = 'closed') = (closed_at is not null))
);

-- Only one current sprint.
create unique index if not exists sprints_one_active_uidx on luna_feedback.sprints ((true)) where status = 'active';
create index if not exists sprints_starts_idx on luna_feedback.sprints (starts_on);
alter table luna_feedback.sprints enable row level security;

-- ---------------------------------------------------------------------------
-- Which sprint a report is in. "restrict": a sprint cannot disappear from under its issues;
-- deleting one deletes them explicitly first.
-- ---------------------------------------------------------------------------
alter table luna_feedback.submissions
  add column if not exists sprint_id uuid references luna_feedback.sprints(id) on delete restrict;

-- Sprints hold issues, not "working fine" feedback.
alter table luna_feedback.submissions drop constraint if exists submissions_sprint_issue_only;
alter table luna_feedback.submissions add constraint submissions_sprint_issue_only
  check (sprint_id is null or not is_positive);

create index if not exists submissions_sprint_idx
  on luna_feedback.submissions (sprint_id, status) where sprint_id is not null;

-- The history records moves between sprints and the main list (from/to = a sprint ref, or null).
alter table luna_feedback.submission_events drop constraint if exists submission_events_action_chk;
alter table luna_feedback.submission_events add constraint submission_events_action_chk check (action in (
  'created', 'status', 'assign', 'priority', 'note', 'test_flag',
  'kind_link', 'kind_suggest', 'kind_confirm', 'kind_reject', 'jira', 'diagnosis', 'ask_reporter', 'regression', 'tag',
  'go_live', 'sprint'));

-- ---------------------------------------------------------------------------
-- The first two sprints: 1–15 October is current, 16–31 October is next.
-- If this runs after the 15th, the first sprint shows as overdue until QC closes it.
-- ---------------------------------------------------------------------------
insert into luna_feedback.sprints (ref, name, starts_on, ends_on, status, created_by, activated_at) values
  ('SPR-202610-01', 'Sprint · October 2026 · 01', '2026-10-01', '2026-10-15', 'active',  'migration', now()),
  ('SPR-202610-02', 'Sprint · October 2026 · 02', '2026-10-16', '2026-10-31', 'planned', 'migration', null)
on conflict (ref) do nothing;
