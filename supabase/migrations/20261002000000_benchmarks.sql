-- Benchmarking: the same workout or night recorded by Luna and by other devices (Polar, Garmin,
-- Fitbit, Apple Watch…), read from an Apple Health export in the browser and compared here.
-- The export file itself is never stored: only what was recorded during each session.

create sequence if not exists luna_feedback.benchmark_ref_seq;

-- ---------------------------------------------------------------------------
-- One session = one workout or one night, for one tester, however many devices recorded it.
--   devices: the device tags of its recordings, kept here so the list can filter without a join.
--   summary: the comparison (per-device totals, agreement between devices, findings), recomputed
--            whenever a recording is added, removed or re-tagged.
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.benchmark_sessions (
  id             uuid primary key default gen_random_uuid(),
  ref_no         bigint not null default nextval('luna_feedback.benchmark_ref_seq'),
  -- lpad() truncates longer input, so without the case BM-10000 would read BM-1000 and collide.
  ref            text generated always as
                   ('BM-' || case when ref_no < 10000 then lpad(ref_no::text, 4, '0') else ref_no::text end) stored,
  kind           text not null,
  activity       text,
  title          text,
  tester         text not null,
  tester_key     text generated always as (lower(btrim(tester))) stored,
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  utc_offset_min integer not null default 330,
  devices        text[] not null default '{}',
  summary        jsonb not null default '{}'::jsonb,
  notes          text,
  is_test        boolean not null default false,
  uploaded_by    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint benchmark_sessions_kind_chk check (kind in ('workout', 'sleep')),
  constraint benchmark_sessions_window_chk check (ended_at >= started_at),
  constraint benchmark_sessions_tester_len check (char_length(tester) between 1 and 80),
  constraint benchmark_sessions_notes_len check (notes is null or char_length(notes) <= 4000)
);

alter sequence luna_feedback.benchmark_ref_seq owned by luna_feedback.benchmark_sessions.ref_no;
create unique index if not exists benchmark_sessions_ref_uidx on luna_feedback.benchmark_sessions (ref);
create index if not exists benchmark_sessions_started_idx on luna_feedback.benchmark_sessions (started_at desc);
create index if not exists benchmark_sessions_tester_idx on luna_feedback.benchmark_sessions (tester_key, kind, started_at);
alter table luna_feedback.benchmark_sessions enable row level security;

-- ---------------------------------------------------------------------------
-- What one device (one Apple Health source) recorded during a session.
--   logged:      the device logged the workout or the night itself. False for a source that only has
--                samples in the window, such as the phone counting steps during a run.
--   fingerprint: source | kind | start | end of what it logged. The same workout in a later export
--                has the same fingerprint, which is how a second upload is recognised.
--   metrics:     totals and averages, keyed by metric (dynamic: whatever the device wrote).
--   series:      the samples over time, keyed by metric.
--   stages:      sleep stages; route: GPS track; details: workout metadata, events, body profile.
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.benchmark_recordings (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references luna_feedback.benchmark_sessions(id) on delete cascade,
  source_name    text not null,
  source_version text,
  device_tag     text not null,
  device_label   text,
  logged         boolean not null default true,
  fingerprint    text,
  activity       text,
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  metrics        jsonb not null default '{}'::jsonb,
  series         jsonb not null default '{}'::jsonb,
  stages         jsonb,
  route          jsonb,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint benchmark_recordings_source_uniq unique (session_id, source_name),
  constraint benchmark_recordings_tag_chk check (device_tag ~ '^[a-z0-9_]{1,30}$')
);

create unique index if not exists benchmark_recordings_fingerprint_uidx
  on luna_feedback.benchmark_recordings (fingerprint) where fingerprint is not null;
create index if not exists benchmark_recordings_session_idx on luna_feedback.benchmark_recordings (session_id);
create index if not exists benchmark_recordings_source_idx on luna_feedback.benchmark_recordings (source_name, created_at desc);
alter table luna_feedback.benchmark_recordings enable row level security;
