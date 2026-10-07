-- What a dashboard user last entered on the Report page about themselves (Luna user id, email,
-- ring serial, phone and ring details), so the form is prefilled next time on any browser.
-- Free-form json: the page decides the keys; nothing else reads it.
alter table luna_feedback.dashboard_users
  add column if not exists reporter_profile jsonb not null default '{}'::jsonb;
