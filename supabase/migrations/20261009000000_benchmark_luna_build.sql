-- The Luna build a benchmark session was recorded with: the band's firmware, the Luna app's version and
-- the phone it ran on. Typed in by a person (an Apple Health export does not carry them: Luna writes only
-- a build number there). build_set_at is when they were last entered, so the next session of the same
-- tester can be prefilled with the latest values.
alter table luna_feedback.benchmark_sessions
  add column if not exists firmware_version text,
  add column if not exists app_version text,
  add column if not exists platform text,
  add column if not exists build_set_at timestamptz;

alter table luna_feedback.benchmark_sessions
  drop constraint if exists benchmark_sessions_platform_chk,
  add constraint benchmark_sessions_platform_chk check (platform is null or platform in ('ios', 'android')),
  drop constraint if exists benchmark_sessions_firmware_len,
  add constraint benchmark_sessions_firmware_len check (firmware_version is null or char_length(firmware_version) <= 60),
  drop constraint if exists benchmark_sessions_app_version_len,
  add constraint benchmark_sessions_app_version_len check (app_version is null or char_length(app_version) <= 60);

create index if not exists benchmark_sessions_build_idx
  on luna_feedback.benchmark_sessions (tester_key, build_set_at desc) where build_set_at is not null;
