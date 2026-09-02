import type { Db } from '../../db/pool.js';
import type { CategoryOption, FeatureRow } from '../../schema/buildSchemaResponse.js';

export interface CategoryRow {
  id: string;
  feature_key: string;
  key: string;
  label: string;
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface Snapshot {
  features: FeatureRow[];
  categories: CategoryRow[];
  loadedAt: number;
}

/**
 * Reads the feature registry + category master list, with a short in-memory cache.
 * Admin writes call invalidate() so changes are visible immediately on this instance;
 * other instances (serverless) pick them up within TTL.
 */
export class CategoriesRepo {
  private snapshot: Snapshot | undefined;
  private inflight: Promise<Snapshot> | undefined;

  constructor(private readonly db: Db, private readonly ttlMs: number) {}

  invalidate(): void {
    this.snapshot = undefined;
  }

  private async load(): Promise<Snapshot> {
    const [f, c] = await Promise.all([
      this.db.query<FeatureRow>('select key, label, sort_order, is_active from luna_feedback.features order by sort_order, key'),
      this.db.query<CategoryRow>('select * from luna_feedback.issue_categories order by feature_key, sort_order, key'),
    ]);
    return { features: f.rows, categories: c.rows, loadedAt: Date.now() };
  }

  private async get(): Promise<Snapshot> {
    if (this.snapshot && Date.now() - this.snapshot.loadedAt < this.ttlMs) return this.snapshot;
    if (!this.inflight) {
      this.inflight = this.load()
        .then((s) => { this.snapshot = s; return s; })
        .finally(() => { this.inflight = undefined; });
    }
    return this.inflight;
  }

  async allFeatures(): Promise<FeatureRow[]> {
    return (await this.get()).features;
  }

  async activeFeatures(): Promise<FeatureRow[]> {
    return (await this.get()).features.filter((f) => f.is_active);
  }

  async feature(key: string): Promise<FeatureRow | undefined> {
    return (await this.get()).features.find((f) => f.key === key);
  }

  /** Active category options per feature, for the schema response. */
  async activeOptionsByFeature(): Promise<Map<string, CategoryOption[]>> {
    const { categories } = await this.get();
    const map = new Map<string, CategoryOption[]>();
    for (const c of categories) {
      if (!c.is_active) continue;
      const list = map.get(c.feature_key) ?? [];
      list.push({ key: c.key, label: c.label });
      map.set(c.feature_key, list);
    }
    return map;
  }

  async activeKeysFor(featureKey: string): Promise<string[]> {
    const { categories } = await this.get();
    return categories.filter((c) => c.feature_key === featureKey && c.is_active).map((c) => c.key);
  }

  // ---- admin (bypass cache, then invalidate) --------------------------------

  async listAll(featureKey: string): Promise<CategoryRow[]> {
    const r = await this.db.query<CategoryRow>(
      'select * from luna_feedback.issue_categories where feature_key = $1 order by sort_order, key',
      [featureKey],
    );
    return r.rows;
  }

  async create(input: { feature_key: string; key: string; label: string; sort_order: number }): Promise<CategoryRow> {
    const r = await this.db.query<CategoryRow>(
      `insert into luna_feedback.issue_categories (feature_key, key, label, sort_order)
       values ($1, $2, $3, $4) returning *`,
      [input.feature_key, input.key, input.label, input.sort_order],
    );
    this.invalidate();
    return r.rows[0]!;
  }

  async update(id: string, patch: { label?: string; sort_order?: number; is_active?: boolean }): Promise<CategoryRow | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (sets.length === 0) {
      const r = await this.db.query<CategoryRow>('select * from luna_feedback.issue_categories where id = $1', [id]);
      return r.rows[0];
    }
    vals.push(id);
    const r = await this.db.query<CategoryRow>(
      `update luna_feedback.issue_categories set ${sets.join(', ')} where id = $${vals.length} returning *`,
      vals,
    );
    this.invalidate();
    return r.rows[0];
  }

  async updateFeature(key: string, patch: { label?: string; sort_order?: number; is_active?: boolean }): Promise<FeatureRow | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (sets.length === 0) return this.feature(key);
    vals.push(key);
    const r = await this.db.query<FeatureRow>(
      `update luna_feedback.features set ${sets.join(', ')} where key = $${vals.length}
       returning key, label, sort_order, is_active`,
      vals,
    );
    this.invalidate();
    return r.rows[0];
  }
}
