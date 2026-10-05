-- Screenshots attached to a benchmark session: what each device's app showed for that workout or night.
-- [{ file_id, url, name, width, height, size, added_by, added_at }] hosted on ImageKit, at most 6.
alter table luna_feedback.benchmark_sessions
  add column if not exists screenshots jsonb not null default '[]'::jsonb
  constraint benchmark_sessions_screenshots_is_array check (jsonb_typeof(screenshots) = 'array');
