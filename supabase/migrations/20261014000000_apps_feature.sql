-- "Apps" feature: reports about Luna's mini apps (Cycle tracker, Hydration, Hyrox training, ...).
-- Which app is a required dropdown in the report (details.app, listed in src/schema/registry.ts);
-- the categories below say what went wrong and stay editable from the dashboard's Settings page.
-- Sits before Other, which stays last.
insert into luna_feedback.features (key, label, sort_order) values ('apps', 'Apps', 45)
on conflict (key) do nothing;

insert into luna_feedback.issue_categories (feature_key, key, label, sort_order) values
  ('apps', 'app_not_loading',     'App not loading',               10),
  ('apps', 'app_crashed',         'App crashed or froze',          20),
  ('apps', 'wrong_data',          'Wrong data or numbers',         30),
  ('apps', 'data_missing',        'Data missing',                  40),
  ('apps', 'cannot_log_entry',    'Could not log or save an entry', 50),
  ('apps', 'plan_or_guidance',    'Plan or guidance looks wrong',  60),
  ('apps', 'reminders',           'Reminders or notifications',    70),
  ('apps', 'display_glitch',      'Display or UI glitch',          80),
  ('apps', 'something_else',      'Other',                         1000)
on conflict (feature_key, key) do nothing;
