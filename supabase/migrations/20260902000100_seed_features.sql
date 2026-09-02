-- Seed the feature registry and the initial issue-category master lists.
-- Idempotent: safe to re-run; existing rows are left untouched so admin edits survive.

insert into luna_feedback.features (key, label, sort_order) values
  ('home',     'Home',     10),
  ('sleep',    'Sleep',    20),
  ('activity', 'Activity', 30),
  ('workout',  'Workout',  40)
on conflict (key) do nothing;

insert into luna_feedback.issue_categories (feature_key, key, label, sort_order) values
  -- Home
  ('home', 'wrong_peak_score',      'Wrong peak score',      10),
  ('home', 'peak_score_not_loaded', 'Peak score not loaded', 20),
  ('home', 'guidance_incorrect',    'Guidance incorrect',    30),

  -- Sleep
  ('sleep', 'incorrect_sleep',       'Incorrect sleep',       10),
  ('sleep', 'sleep_not_recorded',    'Sleep not recorded',    20),
  ('sleep', 'incorrect_sleep_stage', 'Incorrect sleep stage', 30),
  ('sleep', 'vitals_not_recorded',   'Vitals not recorded',   40),

  -- Activity
  ('activity', 'incorrect_steps',           'Incorrect steps',           10),
  ('activity', 'incorrect_total_calories',  'Incorrect total calories',  20),
  ('activity', 'incorrect_active_calories', 'Incorrect active calories', 30),
  ('activity', 'incorrect_training_load',   'Incorrect training load',   40),
  ('activity', 'workout_not_showing',       'Workout not showing',       50),

  -- Workout
  ('workout', 'incorrect_duration',  'Incorrect duration',  10),
  ('workout', 'incorrect_calories',  'Incorrect calories',  20),
  ('workout', 'hr_not_showing',      'HR not showing',      30),
  ('workout', 'map_not_loading',     'Map not loading',     40),
  ('workout', 'incorrect_zones',     'Incorrect zones',     50),
  ('workout', 'incorrect_intensity', 'Incorrect intensity', 60),
  ('workout', 'start_workout_fail',  'Start workout fail',  70),
  ('workout', 'end_workout_fail',    'End workout fail',    80)
on conflict (feature_key, key) do nothing;
