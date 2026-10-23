import type { Db } from '../../db/pool.js';

export interface SettingRow<T = unknown> {
  value: T;
  updated_by: string | null;
  updated_at: string;
}

interface Snapshot {
  rows: Map<string, SettingRow>;
  loadedAt: number;
}

/** After a failed reload, the copy already held is trusted this much longer before trying again. */
const RETRY_AFTER_ERROR_MS = 30_000;

/**
 * Settings changed from the dashboard (luna_feedback.app_settings). Read on every model call, so
 * the few rows are held in memory and read from the database once per TTL. A change calls
 * invalidate() so it shows at once on this instance; other instances (serverless) pick it up
 * within the TTL. If a reload fails, the copy already held keeps answering.
 */
export class SettingsRepo {
  private snapshot: Snapshot | undefined;
  private inflight: Promise<Snapshot> | undefined;

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
    private readonly onReloadError: (err: unknown) => void = () => {},
  ) {}

  invalidate(): void {
    this.snapshot = undefined;
  }

  private async load(): Promise<Snapshot> {
    const { rows } = await this.db.query<{ key: string; value: unknown; updated_by: string | null; updated_at: Date }>(
      'select key, value, updated_by, updated_at from luna_feedback.app_settings',
    );
    return { rows: new Map(rows.map((r) => [r.key, { value: r.value, updated_by: r.updated_by, updated_at: new Date(r.updated_at).toISOString() }])), loadedAt: Date.now() };
  }

  private async rows(): Promise<Map<string, SettingRow>> {
    const held = this.snapshot;
    if (held && Date.now() - held.loadedAt < this.ttlMs) return held.rows;
    if (!this.inflight) {
      this.inflight = this.load()
        .then((s) => { this.snapshot = s; return s; })
        .catch((err) => {
          if (!held) throw err;
          this.onReloadError(err);
          // Keep answering from what we have; try the database again shortly.
          const kept = { rows: held.rows, loadedAt: Date.now() - this.ttlMs + RETRY_AFTER_ERROR_MS };
          this.snapshot = kept;
          return kept;
        })
        .finally(() => { this.inflight = undefined; });
    }
    return (await this.inflight).rows;
  }

  /** The setting, or null when it was never set (the code's default applies). */
  async get<T>(key: string): Promise<SettingRow<T> | null> {
    return ((await this.rows()).get(key) as SettingRow<T> | undefined) ?? null;
  }

  async set(key: string, value: unknown, by: string | null): Promise<void> {
    await this.db.query(
      `insert into luna_feedback.app_settings (key, value, updated_by, updated_at) values ($1, $2::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), by],
    );
    this.invalidate();
  }
}
