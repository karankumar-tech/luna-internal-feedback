-- Accountability: an activity log per report (notes included), an owner for reports and problems,
-- a human priority, a "needs info" status, and the timestamps response-time numbers come from.
-- See docs/PLAN-cx-and-issue-management.md §2.2.

-- ---------------------------------------------------------------------------
-- Every change to a report, and every note on it. Actors are stored as text (an email, "ai",
-- "rule", "app", "cx_tool"), so the history survives accounts being removed.
-- Notes are events with a body; `visibility` = customer marks one CX may pass on to the customer.
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.submission_events (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references luna_feedback.submissions(id) on delete cascade,
  actor         text,
  action        text not null,
  from_value    text,
  to_value      text,
  note          text,
  visibility    text not null default 'internal',
  created_at    timestamptz not null default now(),
  constraint submission_events_action_chk check (action in (
    'created', 'status', 'assign', 'priority', 'note', 'test_flag',
    'kind_link', 'kind_suggest', 'kind_confirm', 'kind_reject', 'jira', 'diagnosis', 'ask_reporter')),
  constraint submission_events_visibility_chk check (visibility in ('internal', 'customer')),
  constraint submission_events_note_len check (note is null or char_length(note) <= 4000)
);

create index if not exists submission_events_submission_idx on luna_feedback.submission_events (submission_id, created_at);
create index if not exists submission_events_created_idx on luna_feedback.submission_events (created_at desc);
alter table luna_feedback.submission_events enable row level security;

-- ---------------------------------------------------------------------------
-- Owner, priority and the response-time clock on each report.
--   first_touched_at: the team's first action (status, owner, priority, note, grouping, Jira, a
--                     diagnosis someone ran). The report arriving, the AI and the matcher do not count.
--   last_activity_at: the team's latest action; "stale" is measured from here.
--   resolved_at:      when it last moved to resolved / closed / won't fix; cleared if reopened.
-- ---------------------------------------------------------------------------
alter table luna_feedback.submissions
  add column if not exists assigned_to      text,
  add column if not exists priority         text,
  add column if not exists first_touched_at timestamptz,
  add column if not exists last_activity_at timestamptz,
  add column if not exists resolved_at      timestamptz;

alter table luna_feedback.submissions drop constraint if exists submissions_priority_check;
alter table luna_feedback.submissions add constraint submissions_priority_check
  check (priority is null or priority in ('p0', 'p1', 'p2', 'p3'));

-- "Needs info": waiting on the tester or the customer. Not terminal, but not our move either.
alter table luna_feedback.submissions drop constraint if exists submissions_status_check;
alter table luna_feedback.submissions add constraint submissions_status_check
  check (status in ('open', 'triaged', 'in_progress', 'needs_info', 'resolved', 'closed', 'wont_fix'));

create index if not exists submissions_assigned_idx on luna_feedback.submissions (assigned_to, status) where assigned_to is not null;

alter table luna_feedback.issue_kinds add column if not exists owner text;

-- ---------------------------------------------------------------------------
-- A partial history for reports that existed before the log: when each arrived, its last status
-- change, its Jira ticket, the problems people linked it to, and diagnosis runs.
-- ---------------------------------------------------------------------------
insert into luna_feedback.submission_events (submission_id, actor, action, to_value, created_at)
select s.id, coalesce(s.submitted_via, 'app'), 'created', s.origin, s.created_at
  from luna_feedback.submissions s
 where not exists (select 1 from luna_feedback.submission_events e where e.submission_id = s.id);

insert into luna_feedback.submission_events (submission_id, actor, action, to_value, note, created_at)
select s.id, s.status_changed_by, 'status', s.status, s.status_note, s.status_changed_at
  from luna_feedback.submissions s
 where s.status_changed_at is not null
   and not exists (select 1 from luna_feedback.submission_events e where e.submission_id = s.id and e.action = 'status');

insert into luna_feedback.submission_events (submission_id, actor, action, to_value, created_at)
select s.id, s.jira_created_by, 'jira', s.jira_key, coalesce(s.jira_synced_at, s.created_at)
  from luna_feedback.submissions s
 where s.jira_key is not null
   and not exists (select 1 from luna_feedback.submission_events e where e.submission_id = s.id and e.action = 'jira');

insert into luna_feedback.submission_events (submission_id, actor, action, to_value, created_at)
select sk.submission_id, coalesce(sk.decided_by, sk.created_by), 'kind_link', k.ref, coalesce(sk.decided_at, sk.created_at)
  from luna_feedback.submission_issue_kinds sk
  join luna_feedback.issue_kinds k on k.id = sk.kind_id
 where sk.state = 'linked'
   and not exists (select 1 from luna_feedback.submission_events e where e.submission_id = sk.submission_id and e.action = 'kind_link' and e.to_value = k.ref);

insert into luna_feedback.submission_events (submission_id, actor, action, to_value, created_at)
select r.submission_id, case when r.trigger = 'auto' then 'ai' else null end, 'diagnosis', r.status, r.created_at
  from luna_feedback.diagnosis_runs r
 where not exists (select 1 from luna_feedback.submission_events e where e.submission_id = r.submission_id and e.action = 'diagnosis');

-- The clock, from what is known: people's status changes, Jira tickets and manual grouping.
update luna_feedback.submissions s
   set first_touched_at = t.first_at,
       last_activity_at = t.last_at
  from (
    select e.submission_id, min(e.created_at) as first_at, max(e.created_at) as last_at
      from luna_feedback.submission_events e
      join luna_feedback.submissions x on x.id = e.submission_id
     where e.action in ('status', 'jira')
        or (e.action = 'kind_link' and e.actor is not null and e.actor not in ('ai', 'rule'))
     group by e.submission_id
  ) t
 where t.submission_id = s.id and s.first_touched_at is null;

update luna_feedback.submissions
   set resolved_at = status_changed_at
 where status in ('resolved', 'closed', 'wont_fix') and resolved_at is null and status_changed_at is not null;
