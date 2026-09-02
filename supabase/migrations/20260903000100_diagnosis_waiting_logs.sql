-- Logs upload on a schedule (iOS syncs after ~20:00 IST), so a same-day report usually has no
-- same-day files yet. "waiting_logs" parks the diagnosis until the retry time in diagnosis_jobs.run_after.
alter table luna_feedback.diagnoses drop constraint if exists diagnoses_status_check;
alter table luna_feedback.diagnoses add constraint diagnoses_status_check
  check (status in ('pending','running','waiting_logs','done','no_logs','failed'));
