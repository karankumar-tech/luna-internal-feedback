-- An issue can live in the backend or the ring's firmware rather than in one of the apps. QA picks
-- that when filing (the Report page, or the app's form), and QC can change a report's platform later.
alter table luna_feedback.submissions drop constraint if exists submissions_platform_check;
alter table luna_feedback.submissions add constraint submissions_platform_check
  check (platform is null or platform in ('ios', 'android', 'backend', 'firmware'));

-- The history records a platform change (from/to = the platform before and after).
alter table luna_feedback.submission_events drop constraint if exists submission_events_action_chk;
alter table luna_feedback.submission_events add constraint submission_events_action_chk check (action in (
  'created', 'status', 'assign', 'priority', 'note', 'test_flag',
  'kind_link', 'kind_suggest', 'kind_confirm', 'kind_reject', 'jira', 'diagnosis', 'ask_reporter', 'regression', 'tag',
  'go_live', 'sprint', 'screenshot', 'platform'));
