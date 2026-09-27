-- Where a report came from (internal testers or CX), readable references (LN-00042, LNK-0007),
-- and the CX dashboard role. See docs/PLAN-cx-and-issue-management.md §1 and §1b.

-- ---------------------------------------------------------------------------
-- Origin. Internal testers report through the app; CX reports arrive from the CX team's own tool
-- through /v1/cx/*, and the API key decides which one a report is, never the request body.
-- ---------------------------------------------------------------------------
alter table luna_feedback.submissions
  add column if not exists origin        text not null default 'internal',
  add column if not exists submitted_via text,   -- which credential sent it: app | cx_tool | admin
  add column if not exists cx_ref        text,   -- ticket id in the CX tool, e.g. "FD-48213"
  add column if not exists cx_url        text,   -- deep link to that ticket
  add column if not exists cx_channel    text,   -- how the customer reached CX
  add column if not exists cx_agent      text,   -- the CX agent who filed it (an employee, not the customer)
  add column if not exists cx_transcript text;   -- the customer's words, emails and phone numbers redacted before storing

update luna_feedback.submissions set submitted_via = 'app' where submitted_via is null;

-- Real customers' email addresses are never stored; internal testers' still are.
-- A CX report is identified by its ring serial, and its Luna user id is filled in from the logging service.
alter table luna_feedback.submissions alter column email   drop not null;
alter table luna_feedback.submissions alter column user_id drop not null;

alter table luna_feedback.submissions drop constraint if exists submissions_origin_check;
alter table luna_feedback.submissions add constraint submissions_origin_check
  check (origin in ('internal', 'cx'));

alter table luna_feedback.submissions drop constraint if exists submissions_identity_check;
alter table luna_feedback.submissions add constraint submissions_identity_check check (
     (origin = 'internal' and email is not null and user_id is not null)
  or (origin = 'cx' and email is null and device_serial is not null and cx_ref is not null));

alter table luna_feedback.submissions drop constraint if exists submissions_cx_channel_check;
alter table luna_feedback.submissions add constraint submissions_cx_channel_check
  check (cx_channel is null or cx_channel in ('email', 'chat', 'call', 'whatsapp', 'social', 'app_store', 'play_store', 'other'));

alter table luna_feedback.submissions drop constraint if exists submissions_cx_fields_only_cx;
alter table luna_feedback.submissions add constraint submissions_cx_fields_only_cx check (origin = 'cx' or
  (cx_ref is null and cx_url is null and cx_channel is null and cx_agent is null and cx_transcript is null));

alter table luna_feedback.submissions drop constraint if exists submissions_cx_lengths;
alter table luna_feedback.submissions add constraint submissions_cx_lengths check (
      (cx_ref is null or char_length(cx_ref) between 1 and 100)
  and (cx_url is null or char_length(cx_url) <= 1000)
  and (cx_agent is null or char_length(cx_agent) <= 120)
  and (cx_transcript is null or char_length(cx_transcript) <= 5000));

create index if not exists submissions_origin_idx on luna_feedback.submissions (origin, occurred_on desc);

-- One report per CX ticket per feature: pressing the button twice returns the first report.
create unique index if not exists submissions_cx_ref_uidx
  on luna_feedback.submissions (cx_ref, feature_key) where origin = 'cx';

-- ---------------------------------------------------------------------------
-- Readable references. The uuid stays the key everything joins on; these are for people.
-- Existing rows are numbered oldest first, so LN-00001 is the first report ever filed, and new
-- rows continue from there. Numbers are never reused; gaps (deleted test data, replays) are normal.
-- ---------------------------------------------------------------------------
create sequence if not exists luna_feedback.submission_ref_seq;
alter table luna_feedback.submissions add column if not exists ref_no bigint;

update luna_feedback.submissions s
   set ref_no = n.rn
  from (select id, row_number() over (order by created_at, id) as rn from luna_feedback.submissions) n
 where s.id = n.id and s.ref_no is null;

select setval('luna_feedback.submission_ref_seq',
              coalesce((select max(ref_no) from luna_feedback.submissions), 0) + 1, false);

alter table luna_feedback.submissions
  alter column ref_no set default nextval('luna_feedback.submission_ref_seq'),
  alter column ref_no set not null;
alter sequence luna_feedback.submission_ref_seq owned by luna_feedback.submissions.ref_no;

-- lpad() truncates longer input, so without the case LN-100000 would read LN-10000 and collide.
alter table luna_feedback.submissions
  add column if not exists ref text generated always as
    ('LN-' || case when ref_no < 100000 then lpad(ref_no::text, 5, '0') else ref_no::text end) stored;
create unique index if not exists submissions_ref_uidx on luna_feedback.submissions (ref);

create sequence if not exists luna_feedback.issue_kind_ref_seq;
alter table luna_feedback.issue_kinds add column if not exists ref_no bigint;

update luna_feedback.issue_kinds k
   set ref_no = n.rn
  from (select id, row_number() over (order by created_at, id) as rn from luna_feedback.issue_kinds) n
 where k.id = n.id and k.ref_no is null;

select setval('luna_feedback.issue_kind_ref_seq',
              coalesce((select max(ref_no) from luna_feedback.issue_kinds), 0) + 1, false);

alter table luna_feedback.issue_kinds
  alter column ref_no set default nextval('luna_feedback.issue_kind_ref_seq'),
  alter column ref_no set not null;
alter sequence luna_feedback.issue_kind_ref_seq owned by luna_feedback.issue_kinds.ref_no;

alter table luna_feedback.issue_kinds
  add column if not exists ref text generated always as
    ('LNK-' || case when ref_no < 10000 then lpad(ref_no::text, 4, '0') else ref_no::text end) stored;
create unique index if not exists issue_kinds_ref_uidx on luna_feedback.issue_kinds (ref);

-- ---------------------------------------------------------------------------
-- CX role: sees everything and may use the AI on a report; cannot triage.
-- ---------------------------------------------------------------------------
alter table luna_feedback.dashboard_users drop constraint if exists dashboard_users_role_chk;
alter table luna_feedback.dashboard_users add constraint dashboard_users_role_chk
  check (role in ('admin', 'qc', 'developer', 'business', 'cx'));
