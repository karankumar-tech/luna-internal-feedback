-- Environment tagging, triage status, Jira links, issue kinds, catalog event codes and per-ticket AI chat.

-- ---------------------------------------------------------------------------
-- Which ring of the release train the report came from.
-- Stage is the default: that is the only environment shipping today, and a client
-- that never sends the field keeps behaving exactly as before.
-- ---------------------------------------------------------------------------
alter table luna_feedback.submissions
  add column if not exists environment text not null default 'stage';

alter table luna_feedback.submissions
  drop constraint if exists submissions_environment_check;
alter table luna_feedback.submissions
  add constraint submissions_environment_check check (environment in ('stage', 'uat', 'production'));

create index if not exists submissions_environment_idx
  on luna_feedback.submissions (environment, occurred_on desc);

-- ---------------------------------------------------------------------------
-- Triage status. QC moves a ticket through this; everyone else reads it.
-- ---------------------------------------------------------------------------
alter table luna_feedback.submissions
  add column if not exists status            text not null default 'open',
  add column if not exists status_note       text,
  add column if not exists status_changed_at timestamptz,
  add column if not exists status_changed_by text;

alter table luna_feedback.submissions
  drop constraint if exists submissions_status_check;
alter table luna_feedback.submissions
  add constraint submissions_status_check
  check (status in ('open', 'triaged', 'in_progress', 'resolved', 'closed', 'wont_fix'));

create index if not exists submissions_status_idx on luna_feedback.submissions (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Jira link. The key is what everyone quotes; the url is stored so a board move
-- or a base-url change never leaves a dead link in the dashboard.
-- ---------------------------------------------------------------------------
alter table luna_feedback.submissions
  add column if not exists jira_key        text,
  add column if not exists jira_url        text,
  add column if not exists jira_status     text,
  add column if not exists jira_synced_at  timestamptz,
  add column if not exists jira_created_by text;

create index if not exists submissions_jira_key_idx
  on luna_feedback.submissions (jira_key) where jira_key is not null;

-- ---------------------------------------------------------------------------
-- Catalog event codes the model recognised (FW-01, RL-07, APP-22 …).
-- Validated against the built catalog before they are written, so this column
-- only ever holds ids that exist in reference/luna-critical-events.xlsx.
-- ---------------------------------------------------------------------------
alter table luna_feedback.diagnoses
  add column if not exists event_codes text[] not null default '{}';

create index if not exists diagnoses_event_codes_idx on luna_feedback.diagnoses using gin (event_codes);

alter table luna_feedback.submissions
  add column if not exists ai_event_codes text[] not null default '{}';

create index if not exists submissions_ai_event_codes_idx on luna_feedback.submissions using gin (ai_event_codes);

-- ---------------------------------------------------------------------------
-- Issue kinds: the recurring problem several tickets are all instances of
-- ("sleep start time recorded late"). One kind, many submissions.
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.issue_kinds (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  title       text not null,
  description text,
  feature_key text references luna_feedback.features(key) on delete set null,

  -- What this kind looks like, used to suggest it on new tickets.
  tags        text[] not null default '{}',
  event_codes text[] not null default '{}',

  status      text not null default 'open',
  severity    text,

  jira_key    text,
  jira_url    text,

  is_archived boolean not null default false,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint issue_kinds_key_slug   check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint issue_kinds_status_chk check (status in ('open', 'watching', 'fixed', 'wont_fix')),
  constraint issue_kinds_sev_chk    check (severity is null or severity in ('low', 'medium', 'high', 'critical'))
);

create index if not exists issue_kinds_active_idx on luna_feedback.issue_kinds (is_archived, status, updated_at desc);

drop trigger if exists issue_kinds_set_updated_at on luna_feedback.issue_kinds;
create trigger issue_kinds_set_updated_at before update on luna_feedback.issue_kinds
  for each row execute function luna_feedback.set_updated_at();

create table if not exists luna_feedback.submission_issue_kinds (
  submission_id uuid not null references luna_feedback.submissions(id) on delete cascade,
  kind_id       uuid not null references luna_feedback.issue_kinds(id) on delete cascade,
  source        text not null default 'manual',
  confidence    numeric(3,2),
  created_by    text,
  created_at    timestamptz not null default now(),
  primary key (submission_id, kind_id),
  constraint submission_issue_kinds_source_chk check (source in ('manual', 'ai', 'rule')),
  constraint submission_issue_kinds_conf_chk   check (confidence is null or (confidence >= 0 and confidence <= 1))
);

create index if not exists submission_issue_kinds_kind_idx on luna_feedback.submission_issue_kinds (kind_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Follow-up conversation with the model about one ticket's diagnosis.
-- Capped per ticket by the API (see DIAGNOSIS_CHAT_MAX_MESSAGES).
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.diagnosis_chats (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid not null references luna_feedback.submissions(id) on delete cascade,
  role              text not null,
  content           text not null,
  author            text,
  model             text,
  prompt_tokens     int,
  completion_tokens int,
  cost_usd          numeric(10,6),
  error             text,
  created_at        timestamptz not null default now(),
  constraint diagnosis_chats_role_chk check (role in ('user', 'assistant'))
);

create index if not exists diagnosis_chats_submission_idx
  on luna_feedback.diagnosis_chats (submission_id, created_at);

-- ---------------------------------------------------------------------------
-- Access control: same posture as every other table here.
-- ---------------------------------------------------------------------------
alter table luna_feedback.issue_kinds            enable row level security;
alter table luna_feedback.submission_issue_kinds enable row level security;
alter table luna_feedback.diagnosis_chats        enable row level security;
