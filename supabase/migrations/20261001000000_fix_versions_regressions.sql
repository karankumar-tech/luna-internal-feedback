-- Pinpointing: the version a problem's fix ships in, and regressions against it.
-- See docs/PLAN-cx-and-issue-management.md §4.3. Spikes, version skew, repeat devices and
-- "caught before customers" are computed from existing columns and need nothing stored.

-- ---------------------------------------------------------------------------
-- Fix versions. Optional: without one, a fixed problem is never checked for regressions.
-- regressed_at: when a report on the fix version or later was last linked to it.
-- ---------------------------------------------------------------------------
alter table luna_feedback.issue_kinds
  add column if not exists fixed_in_app_version      text,
  add column if not exists fixed_in_firmware_version text,
  add column if not exists regressed_at              timestamptz;

alter table luna_feedback.issue_kinds drop constraint if exists issue_kinds_fixed_in_len;
alter table luna_feedback.issue_kinds add constraint issue_kinds_fixed_in_len check (
  (fixed_in_app_version is null or char_length(fixed_in_app_version) <= 40)
  and (fixed_in_firmware_version is null or char_length(fixed_in_firmware_version) <= 40));

-- A linked report on the fix version or later: the fix did not hold.
alter table luna_feedback.submission_issue_kinds
  add column if not exists regression boolean not null default false;

create index if not exists issue_kinds_regressed_idx on luna_feedback.issue_kinds (regressed_at desc) where regressed_at is not null;

-- The report's history records the regression.
alter table luna_feedback.submission_events drop constraint if exists submission_events_action_chk;
alter table luna_feedback.submission_events add constraint submission_events_action_chk check (action in (
  'created', 'status', 'assign', 'priority', 'note', 'test_flag',
  'kind_link', 'kind_suggest', 'kind_confirm', 'kind_reject', 'jira', 'diagnosis', 'ask_reporter', 'regression'));
