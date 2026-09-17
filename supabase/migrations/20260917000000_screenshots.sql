-- Screenshots attached to a submission: [{ file_id, url, thumbnail_url, name, width, height, size }] hosted on ImageKit.
alter table luna_feedback.submissions
  add column if not exists screenshots jsonb not null default '[]'::jsonb
  constraint submissions_screenshots_is_array check (jsonb_typeof(screenshots) = 'array');
