import type { Db } from '../../db/pool.js';
import { todayInZone } from '../../lib/time.js';

/** How many days of usage are kept and shown. Older rows go as new ones are written. */
export const USAGE_WINDOW_DAYS = 30;

export interface ModelUsageDay { date: string; input_tokens: number; output_tokens: number; calls: number }
export interface ModelUsageModel { model: string; input_tokens: number; output_tokens: number; calls: number; first_used: string; last_used: string }
export interface ModelUsage {
  range: { from: string; to: string };
  /** One entry per day in the range, zeros included, oldest first. */
  by_day: ModelUsageDay[];
  /** Most tokens first. */
  by_model: ModelUsageModel[];
  totals: { input_tokens: number; output_tokens: number; calls: number };
}

/**
 * Daily token counts per model: rough usage, no breakdown by what the call was for.
 * Written from the OpenRouter client after every successful call, so every caller
 * (diagnosis, same-issue matching, chat) is counted without knowing about it.
 */
export class ModelUsageRepo {
  constructor(private readonly db: Db, private readonly timeZone: string) {}

  async record(u: { model: string; promptTokens: number; completionTokens: number; at?: Date }): Promise<void> {
    const day = todayInZone(this.timeZone, u.at ?? new Date());
    await this.db.query(
      `insert into luna_feedback.model_usage_daily (day, model, input_tokens, output_tokens, calls)
       values ($1::date, $2, $3, $4, 1)
       on conflict (day, model) do update
         set input_tokens = luna_feedback.model_usage_daily.input_tokens + excluded.input_tokens,
             output_tokens = luna_feedback.model_usage_daily.output_tokens + excluded.output_tokens,
             calls = luna_feedback.model_usage_daily.calls + 1,
             updated_at = now()`,
      [day, u.model, Math.max(0, Math.floor(u.promptTokens)), Math.max(0, Math.floor(u.completionTokens))],
    );
    // Nothing older than the window is ever shown, so it is not kept either.
    await this.db.query(`delete from luna_feedback.model_usage_daily where day < $1::date - ($2 - 1)`, [day, USAGE_WINDOW_DAYS]);
  }

  /** The last USAGE_WINDOW_DAYS days up to today, in the app time zone. */
  async lastDays(now: Date = new Date()): Promise<ModelUsage> {
    const to = todayInZone(this.timeZone, now);
    const [days, models] = await Promise.all([
      this.db.query<{ date: string; input_tokens: string; output_tokens: string; calls: number }>(
        `select d::date::text as date,
                coalesce(sum(u.input_tokens), 0)::text as input_tokens,
                coalesce(sum(u.output_tokens), 0)::text as output_tokens,
                coalesce(sum(u.calls), 0)::int as calls
           from generate_series($1::date - ($2 - 1), $1::date, interval '1 day') as d
           left join luna_feedback.model_usage_daily u on u.day = d::date
          group by d order by d`,
        [to, USAGE_WINDOW_DAYS],
      ),
      this.db.query<{ model: string; input_tokens: string; output_tokens: string; calls: number; first_used: string; last_used: string }>(
        `select model, sum(input_tokens)::text as input_tokens, sum(output_tokens)::text as output_tokens, sum(calls)::int as calls,
                min(day)::text as first_used, max(day)::text as last_used
           from luna_feedback.model_usage_daily
          where day between $1::date - ($2 - 1) and $1::date
          group by model order by sum(input_tokens) + sum(output_tokens) desc`,
        [to, USAGE_WINDOW_DAYS],
      ),
    ]);
    const by_day = days.rows.map((r) => ({ date: r.date, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), calls: r.calls }));
    const by_model = models.rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens) }));
    return {
      range: { from: by_day[0]!.date, to },
      by_day,
      by_model,
      totals: {
        input_tokens: by_day.reduce((n, d) => n + d.input_tokens, 0),
        output_tokens: by_day.reduce((n, d) => n + d.output_tokens, 0),
        calls: by_day.reduce((n, d) => n + d.calls, 0),
      },
    };
  }
}
