-- Screenshots can be added to a report after it was filed (and the ones added that way removed).
-- The history records both: from/to = how many screenshots the report held before and after.
alter table luna_feedback.submission_events drop constraint if exists submission_events_action_chk;
alter table luna_feedback.submission_events add constraint submission_events_action_chk check (action in (
  'created', 'status', 'assign', 'priority', 'note', 'test_flag',
  'kind_link', 'kind_suggest', 'kind_confirm', 'kind_reject', 'jira', 'diagnosis', 'ask_reporter', 'regression', 'tag',
  'go_live', 'sprint', 'screenshot'));
