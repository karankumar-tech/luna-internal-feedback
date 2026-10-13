-- Daily steps as a third kind of benchmark session: one wearer's day, midnight to midnight in their
-- time zone, with one recording per device that counted steps that day. A device that was not worn
-- the whole day is left out of the comparison by a person (recordings.details->'excluded'); a workout
-- type a person corrected is kept in recordings.details->'activity_set'. Neither needs a column.
alter table luna_feedback.benchmark_sessions
  drop constraint if exists benchmark_sessions_kind_chk,
  add constraint benchmark_sessions_kind_chk check (kind in ('workout', 'sleep', 'steps'));
