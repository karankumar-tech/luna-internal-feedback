-- Tags on reports: short labels the team puts on a report (app, firmware, …) and filters by.
-- Free-form, stored lowercase; the dashboard suggests the common ones and those already in use.

alter table luna_feedback.submissions
  add column if not exists tags text[] not null default '{}';

alter table luna_feedback.submissions drop constraint if exists submissions_tags_len;
alter table luna_feedback.submissions add constraint submissions_tags_len check (cardinality(tags) <= 10);

-- "tag = firmware" and "tag in (app, firmware)" use this.
create index if not exists submissions_tags_gin on luna_feedback.submissions using gin (tags);

-- The report's history records tag changes.
alter table luna_feedback.submission_events drop constraint if exists submission_events_action_chk;
alter table luna_feedback.submission_events add constraint submission_events_action_chk check (action in (
  'created', 'status', 'assign', 'priority', 'note', 'test_flag',
  'kind_link', 'kind_suggest', 'kind_confirm', 'kind_reject', 'jira', 'diagnosis', 'ask_reporter', 'regression', 'tag'));
