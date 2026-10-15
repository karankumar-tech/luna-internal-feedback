-- Every feature ends with a catch-all "Other", for a problem none of its categories names.
-- The key is something_else on every feature, as on Other and Apps: the same-issue matcher ignores it
-- (CATCH_ALL_CATEGORIES), so two reports that only share "Other" are not taken for one problem.
-- A feature that already has one (added from Settings) is left alone.
insert into luna_feedback.issue_categories (feature_key, key, label, sort_order)
select v.feature_key, 'something_else', 'Other', 1000
  from (values ('home'), ('sleep'), ('activity'), ('workout')) as v(feature_key)
 where not exists (
   select 1 from luna_feedback.issue_categories c
    where c.feature_key = v.feature_key
      and (c.key in ('other', 'something_else') or lower(c.label) in ('other', 'something else'))
 )
on conflict (feature_key, key) do nothing;

-- Catch-alls stay last: Settings adds new categories at 100. One someone has moved keeps its place.
update luna_feedback.issue_categories set sort_order = 1000 where key = 'something_else' and sort_order = 90;
