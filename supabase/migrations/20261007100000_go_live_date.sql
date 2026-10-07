-- When the fix for a report is planned to go live. Optional; QC and developers set or clear it,
-- and the dashboard filters by it (planned, not planned, or a date range).
alter table luna_feedback.submissions
  add column if not exists go_live_on date;

create index if not exists submissions_go_live_on_idx
  on luna_feedback.submissions (go_live_on) where go_live_on is not null;

-- The report's history records go-live changes.
alter table luna_feedback.submission_events drop constraint if exists submission_events_action_chk;
alter table luna_feedback.submission_events add constraint submission_events_action_chk check (action in (
  'created', 'status', 'assign', 'priority', 'note', 'test_flag',
  'kind_link', 'kind_suggest', 'kind_confirm', 'kind_reject', 'jira', 'diagnosis', 'ask_reporter', 'regression', 'tag',
  'go_live'));
