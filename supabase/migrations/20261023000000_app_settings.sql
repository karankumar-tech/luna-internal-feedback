-- Settings changed from the dashboard instead of the environment. One row a setting; the value is
-- JSON shaped by the code that reads it. The first is 'ai_models': which OpenRouter models the
-- diagnosis, the issue matcher and the follow-up chat use, in place of OPENROUTER_MODEL and
-- DIAGNOSIS_CHAT_MODEL (which stay the defaults).
create table if not exists luna_feedback.app_settings (
  key        text primary key,
  value      jsonb not null,
  -- The dashboard account that last changed it, or the credential.
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table luna_feedback.app_settings enable row level security;
