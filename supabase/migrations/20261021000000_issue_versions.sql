-- QC can set or correct the app and firmware version a report came from, on its page. The history
-- records each change (from/to = the version before and after), one entry per field.
alter table luna_feedback.submission_events drop constraint if exists submission_events_action_chk;
alter table luna_feedback.submission_events add constraint submission_events_action_chk check (action in (
  'created', 'status', 'assign', 'priority', 'note', 'test_flag',
  'kind_link', 'kind_suggest', 'kind_confirm', 'kind_reject', 'jira', 'diagnosis', 'ask_reporter', 'regression', 'tag',
  'go_live', 'sprint', 'screenshot', 'platform', 'app_version', 'firmware_version'));
