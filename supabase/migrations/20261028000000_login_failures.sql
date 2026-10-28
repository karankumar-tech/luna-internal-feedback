-- Brake on dashboard password guessing: 8 failed sign-ins per IP per 10 minutes.
-- It used to live in each server's memory, which on several pods (EKS) multiplies the allowance
-- by the pod count. Here every pod counts the same failures.
create table if not exists luna_feedback.login_failures (
  ip       text primary key,
  count    integer not null,
  reset_at timestamptz not null,
  constraint login_failures_count_check check (count > 0)
);
alter table luna_feedback.login_failures enable row level security;
