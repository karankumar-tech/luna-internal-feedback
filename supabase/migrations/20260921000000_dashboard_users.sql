-- Named dashboard accounts with roles, replacing the single shared key.

-- ---------------------------------------------------------------------------
-- One row per person who can sign in.
--
-- password_hash is scrypt: "scrypt$N$r$p$<salt b64>$<derived key b64>". Storing the
-- parameters alongside the hash means the cost can be raised later without locking
-- anyone out: old hashes keep verifying under their own parameters.
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.dashboard_users (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null,
  name                text,
  role                text not null default 'business',

  password_hash       text not null,
  password_set_at     timestamptz not null default now(),
  -- Set when an admin issues a password: the user must replace it before doing anything else.
  must_change         boolean not null default true,

  is_disabled         boolean not null default false,
  last_login_at       timestamptz,
  failed_attempts     int not null default 0,
  locked_until        timestamptz,

  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint dashboard_users_role_chk check (role in ('admin', 'qc', 'developer', 'business')),
  constraint dashboard_users_email_chk check (email = lower(email) and position('@' in email) > 1)
);

-- Email is the login, so it must be unique regardless of case; the check above keeps it lower.
create unique index if not exists dashboard_users_email_key on luna_feedback.dashboard_users (email);
create index if not exists dashboard_users_active_idx on luna_feedback.dashboard_users (is_disabled, role);

drop trigger if exists dashboard_users_set_updated_at on luna_feedback.dashboard_users;
create trigger dashboard_users_set_updated_at before update on luna_feedback.dashboard_users
  for each row execute function luna_feedback.set_updated_at();

-- ---------------------------------------------------------------------------
-- Previous password hashes, so a rotation cannot reuse a recent one.
-- Only hashes live here; there is nothing to read back.
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.dashboard_password_history (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references luna_feedback.dashboard_users(id) on delete cascade,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create index if not exists dashboard_password_history_user_idx
  on luna_feedback.dashboard_password_history (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Who did what to whom: account changes are worth keeping even when the account is gone,
-- so the actor and target are recorded as text rather than as foreign keys.
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.dashboard_user_events (
  id         uuid primary key default gen_random_uuid(),
  actor      text,
  target     text,
  action     text not null,
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists dashboard_user_events_created_idx
  on luna_feedback.dashboard_user_events (created_at desc);

alter table luna_feedback.dashboard_users            enable row level security;
alter table luna_feedback.dashboard_password_history enable row level security;
alter table luna_feedback.dashboard_user_events      enable row level security;
