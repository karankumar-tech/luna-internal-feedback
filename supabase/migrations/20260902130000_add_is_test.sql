-- Explicit test-data flag so demo/integration submissions can live alongside real ones
-- and be removed later without touching real feedback.
alter table luna_feedback.submissions
  add column if not exists is_test boolean not null default false;

create index if not exists submissions_is_test_idx on luna_feedback.submissions (is_test) where is_test;

-- Backfill rows created by the seed script and integration tests before the flag existed.
update luna_feedback.submissions
   set is_test = true
 where is_test = false
   and (email like '%@luna-demo.invalid' or email like '%@luna-test.invalid');
