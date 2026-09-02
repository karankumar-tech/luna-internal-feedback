-- Luna Internal Feedback: initial schema.
-- Everything lives in its own schema so it never collides with tables in `public`
-- and can be moved to another project later with a single pg_dump --schema=luna_feedback.

create schema if not exists luna_feedback;

-- ---------------------------------------------------------------------------
-- Feature registry
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.features (
  key         text primary key,                      -- 'home' | 'sleep' | 'activity' | 'workout'
  label       text not null,
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint features_key_slug check (key ~ '^[a-z][a-z0-9_]*$')
);

-- ---------------------------------------------------------------------------
-- Updatable master list of issue categories, scoped per feature
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.issue_categories (
  id          uuid primary key default gen_random_uuid(),
  feature_key text not null references luna_feedback.features(key) on delete cascade,
  key         text not null,                         -- stable slug, e.g. 'wrong_peak_score'
  label       text not null,                         -- display text, e.g. 'Wrong peak score'
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint issue_categories_key_slug check (key ~ '^[a-z][a-z0-9_]*$'),
  unique (feature_key, key)
);

create index if not exists issue_categories_feature_active_idx
  on luna_feedback.issue_categories (feature_key, is_active, sort_order);

-- ---------------------------------------------------------------------------
-- One row per feedback submission
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.submissions (
  id               uuid primary key default gen_random_uuid(),
  feature_key      text not null references luna_feedback.features(key),

  -- common, mandatory
  is_positive      boolean not null,
  occurred_on      date not null,                    -- day the issue occurred (YYYY-MM-DD)
  user_id          bigint not null,
  email            text not null,
  issue_categories text[] not null,                  -- category keys; validated by the API against issue_categories
  created_at       timestamptz not null default now(),

  -- common, optional
  feedback_text    text,

  -- feature-specific fields, validated by the API's field registry
  details          jsonb not null default '{}'::jsonb,

  -- client context (optional; dashboards slice by these later)
  app_version      text,
  build_number     text,
  build_channel    text,
  firmware_version text,
  os_version       text,
  device_id        text,                             -- IDFV
  session_id       text,

  -- replay guard for the iOS offline outbox
  idempotency_key  text,

  schema_version   int not null default 1,

  constraint submissions_feedback_text_len  check (feedback_text is null or char_length(feedback_text) <= 500),
  constraint submissions_user_id_positive   check (user_id > 0),
  constraint submissions_categories_nonempty check (cardinality(issue_categories) >= 1),
  constraint submissions_details_is_object  check (jsonb_typeof(details) = 'object')
);

create index if not exists submissions_feature_created_idx on luna_feedback.submissions (feature_key, created_at desc);
create index if not exists submissions_user_idx            on luna_feedback.submissions (user_id, created_at desc);
create index if not exists submissions_occurred_idx        on luna_feedback.submissions (occurred_on);
create index if not exists submissions_categories_gin      on luna_feedback.submissions using gin (issue_categories);
create index if not exists submissions_details_gin         on luna_feedback.submissions using gin (details);
create unique index if not exists submissions_idempotency_uidx
  on luna_feedback.submissions (idempotency_key) where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function luna_feedback.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists issue_categories_set_updated_at on luna_feedback.issue_categories;
create trigger issue_categories_set_updated_at
  before update on luna_feedback.issue_categories
  for each row execute function luna_feedback.set_updated_at();

-- ---------------------------------------------------------------------------
-- Access control
-- RLS on, no policies: only the service_role (used by the Node server) can read/write.
-- anon / authenticated get no grants at all.
-- ---------------------------------------------------------------------------
alter table luna_feedback.features         enable row level security;
alter table luna_feedback.issue_categories enable row level security;
alter table luna_feedback.submissions      enable row level security;

grant usage on schema luna_feedback to service_role;
grant all on all tables    in schema luna_feedback to service_role;
grant all on all sequences in schema luna_feedback to service_role;
grant all on all functions in schema luna_feedback to service_role;
alter default privileges in schema luna_feedback grant all on tables    to service_role;
alter default privileges in schema luna_feedback grant all on sequences to service_role;
alter default privileges in schema luna_feedback grant all on functions to service_role;
