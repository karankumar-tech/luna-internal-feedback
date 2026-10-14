-- "Fixed": a developer says the bug is fixed; QC still checks it and resolves or closes it.
-- Not a finished status: the report stays open (attention, sprint carry-over) until QC decides.
alter table luna_feedback.submissions drop constraint if exists submissions_status_check;
alter table luna_feedback.submissions add constraint submissions_status_check
  check (status in ('open', 'triaged', 'in_progress', 'needs_info', 'fixed', 'resolved', 'closed', 'wont_fix'));
