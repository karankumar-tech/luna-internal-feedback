# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Internal team** at Luna (Noise), signed in to the dashboard with their own accounts and roles:
  QC (triage: status, owners, priority, grouping), developers (diagnose and fix), business (read),
  admins (people, categories, test data).
- **CX (customer support)** agents with the `cx` role: they see every report, file customer problems
  from their own tool, write notes and use the AI on a report, but cannot change status.
- **Reporters** never see the dashboard: internal testers report from the Luna app, customers reach
  it only through CX.

The team works from India on desktop browsers; the dashboard is used daily to see what came in and
act on it.

## Product Purpose

Luna feedback collects issue reports about the Luna ring and app, from internal testers (in the app)
and from real customers (through CX), and turns them into something the team can act on: which
problem each report belongs to, how many times it has been reported, who owns it, what the logs and
the AI say, and what is being neglected. Success is that no report is lost or left untouched, and
that the team can see what is breaking, where, and how often.

## Operating Context

- Reports arrive through `POST /v1/feedback/{feature}` (the app) and `POST /v1/cx/feedback/{feature}`
  (the CX tool, only after an agent judges the issue real). Features: Home, Sleep, Activity, Workout,
  Other; each has its own categories.
- Every report has a reference `LN-00042`; recurring problems are `LNK-0007`. People share these
  references inside the team only.
- Pages: Dashboard (home), report detail, Issue kinds (problems), Needs attention, Analytics,
  Diagnosis, Benchmarks, People. Deployed on Vercel from `main`; data in Supabase Postgres (`luna_feedback`).
- Benchmarks are a second job of the same dashboard: a tester wears Luna and a reference device
  (Polar, Garmin, Fitbit, Apple Watch) for the same workout or night, exports Apple Health, and the
  dashboard shows the two side by side (`BM-0007`). The export is read in the browser and never stored.

## Capabilities and Constraints

- Plain HTML pages in `src/pages/*.html`, embedded into `src/pages/generated.ts` by
  `npm run pages:embed`; no front-end framework or build step for pages.
- Report text is short (the tester's words, at most 500 characters); reports have no title of their
  own. A report linked to a problem takes that problem's name as its headline.
- Speed matters: the functions and the database are far apart today, so fewer requests per page and
  cacheable default views are preferred; filters load on demand.
- Pushing `main` deploys to production; work happens on a branch and ships after testing.

## Brand Commitments

- Name: Luna Feedback. Existing dashboard look (Geist and Geist Mono, warm light ground, black hero
  tiles, yellow brand dot, magenta CX tag) is shared by every page.

## Evidence on Hand

- Real reports in the live database (internal testers; CX reports starting). Demo data only via
  `scripts/seed-demo.mjs`, always flagged `is_test`.

## Product Principles

1. **Never store a customer's email.** Customers are identified by ring serial; CX holds contact details.
2. **Nothing gets lost.** Untouched, stale and waiting reports surface on their own.
3. **Count the same issue once.** Reports are grouped into problems so repeats are visible, and a
   person's grouping decision always beats the machine's.
4. **Sharing stays inside the team.** No public or token links.
