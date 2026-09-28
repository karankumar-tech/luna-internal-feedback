-- Same-issue linking: suggested / linked / rejected links, a reference report per problem,
-- merging problems, and a record of AI same-issue checks. See docs/PLAN-cx-and-issue-management.md §3.

-- ---------------------------------------------------------------------------
-- A link between a report and a problem is suggested (by a rule at intake, or by CX), linked
-- (a person or a diagnosis put it there), or rejected (a person said "not this"). Only linked
-- ones count. A rejected row stays so the same suggestion is never made again.
-- Existing links were made by people or by a finished diagnosis, so they are all linked.
-- ---------------------------------------------------------------------------
alter table luna_feedback.submission_issue_kinds
  add column if not exists state      text not null default 'linked',
  add column if not exists decided_by text,
  add column if not exists decided_at timestamptz;

alter table luna_feedback.submission_issue_kinds drop constraint if exists submission_issue_kinds_state_chk;
alter table luna_feedback.submission_issue_kinds add constraint submission_issue_kinds_state_chk
  check (state in ('suggested', 'linked', 'rejected'));

create index if not exists submission_issue_kinds_state_idx
  on luna_feedback.submission_issue_kinds (kind_id, state);

-- ---------------------------------------------------------------------------
-- The report to read first for a problem, titles of problems merged into it (so the model's
-- title matching keeps landing on the survivor), and where a merged-away problem went.
-- ---------------------------------------------------------------------------
alter table luna_feedback.issue_kinds
  add column if not exists reference_submission_id uuid references luna_feedback.submissions(id) on delete set null,
  add column if not exists aliases                 text[] not null default '{}',
  add column if not exists merged_into             uuid references luna_feedback.issue_kinds(id) on delete set null;

-- Oldest linked report as the reference for problems that already have reports.
update luna_feedback.issue_kinds k
   set reference_submission_id = first.submission_id
  from (
    select distinct on (sk.kind_id) sk.kind_id, sk.submission_id
      from luna_feedback.submission_issue_kinds sk
      join luna_feedback.submissions s on s.id = sk.submission_id
     order by sk.kind_id, s.created_at
  ) first
 where first.kind_id = k.id and k.reference_submission_id is null;

-- ---------------------------------------------------------------------------
-- "Ask AI to check": which of a report's look-alikes are really the same issue. Kept so the
-- verdicts show again when the page is reopened, and so the spend is visible.
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.similarity_checks (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid not null references luna_feedback.submissions(id) on delete cascade,
  -- [{ submission_id, ref, verdict: same|related|different, reason }]
  verdicts          jsonb not null default '[]'::jsonb,
  model             text,
  prompt_tokens     int,
  completion_tokens int,
  cost_usd          numeric(10,6),
  created_by        text,
  created_at        timestamptz not null default now(),
  constraint similarity_checks_verdicts_is_array check (jsonb_typeof(verdicts) = 'array')
);

create index if not exists similarity_checks_submission_idx
  on luna_feedback.similarity_checks (submission_id, created_at desc);

alter table luna_feedback.similarity_checks enable row level security;
