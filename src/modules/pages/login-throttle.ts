import type { Db } from '../../db/pool.js';

/**
 * Brake on password guessing: `max` failures per IP per window. Counted in Postgres, so every
 * server instance (several pods on EKS) shares one count instead of each allowing its own.
 */
export class LoginThrottle {
  constructor(private readonly db: Db, private readonly max = 8, private readonly windowMinutes = 10) {}

  async blocked(ip: string): Promise<boolean> {
    const r = await this.db.query<{ blocked: boolean }>(
      'select count >= $2 as blocked from luna_feedback.login_failures where ip = $1 and reset_at >= now()',
      [ip, this.max],
    );
    return r.rows[0]?.blocked ?? false;
  }

  /** One more failure; a lapsed window starts over at 1. Rows a day past their window are cleared on the way. */
  async recordFailure(ip: string): Promise<void> {
    await this.db.query(
      // The clean-up skips this IP's own row: one statement must not touch a row twice.
      `with gone as (delete from luna_feedback.login_failures where reset_at < now() - interval '1 day' and ip <> $1)
       insert into luna_feedback.login_failures as f (ip, count, reset_at)
       values ($1, 1, now() + ($2::int * interval '1 minute'))
       on conflict (ip) do update set
         count    = case when f.reset_at < now() then 1 else f.count + 1 end,
         reset_at = case when f.reset_at < now() then excluded.reset_at else f.reset_at end`,
      [ip, this.windowMinutes],
    );
  }
}
