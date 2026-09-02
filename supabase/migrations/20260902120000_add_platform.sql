-- Platform the feedback came from. Part of the client context; optional so metadata never blocks feedback.
alter table luna_feedback.submissions
  add column if not exists platform text
  constraint submissions_platform_check check (platform is null or platform in ('ios', 'android'));

create index if not exists submissions_platform_idx on luna_feedback.submissions (platform) where platform is not null;
