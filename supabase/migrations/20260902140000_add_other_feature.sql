-- "Other" feature for feedback that does not belong to a specific screen. Categories are editable from the dashboard.
insert into luna_feedback.features (key, label, sort_order) values ('other', 'Other', 50)
on conflict (key) do nothing;

insert into luna_feedback.issue_categories (feature_key, key, label, sort_order) values
  ('other', 'app_crash',         'App crashed',              10),
  ('other', 'app_slow_or_froze', 'App slow or froze',        20),
  ('other', 'login_or_signup',   'Login or sign-up problem', 30),
  ('other', 'ring_pairing_sync', 'Ring pairing or sync',     40),
  ('other', 'battery_drain',     'Battery drain',            50),
  ('other', 'notifications',     'Notifications',            60),
  ('other', 'display_glitch',    'Display or UI glitch',     70),
  ('other', 'data_missing',      'Data missing',             80),
  ('other', 'something_else',    'Something else',           90)
on conflict (feature_key, key) do nothing;
