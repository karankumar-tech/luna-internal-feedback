-- Positive feedback carries no issue categories; the non-empty rule applies to issues only.
alter table luna_feedback.submissions drop constraint if exists submissions_categories_nonempty;
alter table luna_feedback.submissions add constraint submissions_categories_nonempty
  check (is_positive or cardinality(issue_categories) >= 1);
