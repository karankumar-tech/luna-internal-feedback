-- Beta users: production customers who may send reports from the Luna app, the way internal
-- testers do. The app asks whether its user is on the list (GET /v1/beta/users/:user_id) and shows
-- the feedback option only to them. Reports they send are origin 'beta'.

-- ---------------------------------------------------------------------------
-- The list, kept in memory by the API (a couple of thousand ids at most) and edited in Settings.
-- ---------------------------------------------------------------------------
create table if not exists luna_feedback.beta_users (
  user_id  bigint primary key,
  -- Whatever helps QC tell them apart ("Rahul, Strava group"). Shown on the dashboard, never sent to the app.
  name     text,
  -- The dashboard account that added them, or the credential.
  added_by text,
  added_at timestamptz not null default now(),
  constraint beta_users_user_id_check check (user_id > 0),
  constraint beta_users_name_len check (name is null or char_length(name) between 1 and 120)
);
alter table luna_feedback.beta_users enable row level security;

-- ---------------------------------------------------------------------------
-- A third origin. Beta users are real customers, so like CX reports their email is never stored;
-- the Luna user id (always known to the app) identifies them.
-- ---------------------------------------------------------------------------
alter table luna_feedback.submissions drop constraint if exists submissions_origin_check;
alter table luna_feedback.submissions add constraint submissions_origin_check
  check (origin in ('internal', 'cx', 'beta'));

alter table luna_feedback.submissions drop constraint if exists submissions_identity_check;
alter table luna_feedback.submissions add constraint submissions_identity_check check (
     (origin = 'internal' and email is not null and user_id is not null)
  or (origin = 'cx' and email is null and device_serial is not null and cx_ref is not null)
  or (origin = 'beta' and email is null and user_id is not null));

-- ---------------------------------------------------------------------------
-- A customer's email (CX or beta) is kept only masked, "ra***@g***.com": enough to recognise
-- someone, not to contact them. The user id is what identifies them. The full address never
-- reaches the database; the check refuses anything without the mask.
-- ---------------------------------------------------------------------------
alter table luna_feedback.submissions add column if not exists email_masked text;

alter table luna_feedback.submissions drop constraint if exists submissions_email_masked_check;
alter table luna_feedback.submissions add constraint submissions_email_masked_check check (
  email_masked is null
  or (origin in ('cx', 'beta') and char_length(email_masked) <= 40 and email_masked like '%***@%***.%'));
