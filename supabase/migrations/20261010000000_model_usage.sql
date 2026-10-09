-- Rough daily token use per model, for the analytics page. One row per civil day (app time zone)
-- and model; every model call adds to it. Rows older than 30 days are dropped as new ones land.
create table if not exists luna_feedback.model_usage_daily (
  day           date   not null,
  model         text   not null,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  calls         int    not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (day, model)
);
alter table luna_feedback.model_usage_daily enable row level security;
