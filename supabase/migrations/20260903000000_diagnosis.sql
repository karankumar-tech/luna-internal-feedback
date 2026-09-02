-- AI diagnosis of negative feedback: one current diagnosis per submission, append-only run history, and a job queue.

create table if not exists luna_feedback.diagnoses (
  id                   uuid primary key default gen_random_uuid(),
  submission_id        uuid not null unique references luna_feedback.submissions(id) on delete cascade,
  status               text not null default 'pending'
                       constraint diagnoses_status_check check (status in ('pending','running','done','no_logs','failed')),

  -- verdict (queryable)
  root_cause_side      text constraint diagnoses_side_check check (root_cause_side is null or root_cause_side in
                         ('firmware','sdk','app','backend','user_expectation','not_a_bug','insufficient_logs')),
  confidence           numeric(3,2) constraint diagnoses_confidence_check check (confidence is null or (confidence >= 0 and confidence <= 1)),
  severity             text constraint diagnoses_severity_check check (severity is null or severity in ('low','medium','high','critical')),
  tags                 text[] not null default '{}',
  reproducible         text constraint diagnoses_repro_check check (reproducible is null or reproducible in ('likely','unlikely','unknown')),
  summary              text,
  evidence             jsonb not null default '[]'::jsonb,
  suggested_fix        text,
  questions_for_tester text[] not null default '{}',

  -- log context
  log_device           jsonb,
  log_files            jsonb not null default '{}'::jsonb,
  log_window_from      timestamptz,
  log_window_to        timestamptz,
  log_excerpt          text,
  log_excerpt_lines    int not null default 0,
  log_coverage         text constraint diagnoses_coverage_check check (log_coverage is null or log_coverage in ('full','partial','none')),
  fw_version_seen      text,
  app_version_seen     text,

  -- run
  model                text,
  prompt_tokens        int,
  completion_tokens    int,
  cost_usd             numeric(10,6),
  duration_ms          int,
  trigger              text constraint diagnoses_trigger_check check (trigger is null or trigger in ('auto','manual')),
  error                text,

  -- human loop
  review_verdict       text constraint diagnoses_review_check check (review_verdict is null or review_verdict in ('agree','disagree','unsure')),
  review_note          text,
  reviewed_by          text,
  reviewed_at          timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint diagnoses_excerpt_len check (log_excerpt is null or char_length(log_excerpt) <= 32768)
);

create index if not exists diagnoses_status_idx on luna_feedback.diagnoses (status);
create index if not exists diagnoses_side_idx   on luna_feedback.diagnoses (root_cause_side);
create index if not exists diagnoses_tags_gin   on luna_feedback.diagnoses using gin (tags);
create index if not exists diagnoses_review_idx on luna_feedback.diagnoses (review_verdict) where review_verdict is not null;

drop trigger if exists diagnoses_set_updated_at on luna_feedback.diagnoses;
create trigger diagnoses_set_updated_at before update on luna_feedback.diagnoses
  for each row execute function luna_feedback.set_updated_at();

create table if not exists luna_feedback.diagnosis_runs (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid not null references luna_feedback.submissions(id) on delete cascade,
  status            text not null,
  trigger           text not null,
  model             text,
  prompt_tokens     int,
  completion_tokens int,
  cost_usd          numeric(10,6),
  duration_ms       int,
  error             text,
  verdict_snapshot  jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists diagnosis_runs_submission_idx on luna_feedback.diagnosis_runs (submission_id, created_at desc);
create index if not exists diagnosis_runs_created_idx    on luna_feedback.diagnosis_runs (created_at desc);

create table if not exists luna_feedback.diagnosis_jobs (
  submission_id uuid primary key references luna_feedback.submissions(id) on delete cascade,
  state         text not null default 'queued' constraint diagnosis_jobs_state_check check (state in ('queued','running','done','failed')),
  attempts      int not null default 0,
  run_after     timestamptz not null default now(),
  started_at    timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists diagnosis_jobs_state_idx on luna_feedback.diagnosis_jobs (state, run_after);
drop trigger if exists diagnosis_jobs_set_updated_at on luna_feedback.diagnosis_jobs;
create trigger diagnosis_jobs_set_updated_at before update on luna_feedback.diagnosis_jobs
  for each row execute function luna_feedback.set_updated_at();

-- denormalised for cheap filtering on the main list
alter table luna_feedback.submissions
  add column if not exists ai_status     text,
  add column if not exists ai_side       text,
  add column if not exists ai_severity   text,
  add column if not exists ai_checked_at timestamptz;
create index if not exists submissions_ai_status_idx on luna_feedback.submissions (ai_status) where ai_status is not null;
create index if not exists submissions_ai_side_idx   on luna_feedback.submissions (ai_side) where ai_side is not null;

alter table luna_feedback.diagnoses      enable row level security;
alter table luna_feedback.diagnosis_runs enable row level security;
alter table luna_feedback.diagnosis_jobs enable row level security;
