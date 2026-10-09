import type pg from 'pg';
import type { Db } from '../../db/pool.js';
import type { Details, HrQuality, Kind, MetricValue, NormalizedRecording, Rec, Route, Series, Stages, Summary } from './analyze.js';
import type { ProgressSession } from './progress.js';

/** A recording without its samples: what is needed to say which device it is. */
export interface RecordingHead { id: string; session_id: string; source_name: string; device_tag: string; device_label: string | null; logged: boolean }

type Queryable = Pick<pg.PoolClient, 'query'> | Db;

/** An image attached to a session, hosted on ImageKit. */
export interface BenchmarkScreenshot {
  file_id: string;
  url: string;
  name: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  added_by: string | null;
  added_at: string;
}

export interface SessionRow {
  id: string;
  ref: string;
  kind: Kind;
  activity: string | null;
  title: string | null;
  tester: string;
  /** Seconds since the epoch. */
  started_at: number;
  ended_at: number;
  utc_offset_min: number;
  devices: string[];
  summary: Summary | Record<string, never>;
  notes: string | null;
  screenshots: BenchmarkScreenshot[];
  is_test: boolean;
  /** The Luna build it was recorded with, typed in by a person. */
  firmware_version: string | null;
  app_version: string | null;
  platform: 'ios' | 'android' | null;
  build_set_at: Date | null;
  uploaded_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Luna's firmware, the Luna app's version and the phone's platform. */
export interface LunaBuild { firmware_version: string | null; app_version: string | null; platform: 'ios' | 'android' | null }
export const BUILD_FIELDS = ['firmware_version', 'app_version', 'platform'] as const;

export interface RecordingRow {
  id: string;
  session_id: string;
  source_name: string;
  source_version: string | null;
  device_tag: string;
  device_label: string | null;
  logged: boolean;
  fingerprint: string | null;
  activity: string | null;
  started_at: number;
  ended_at: number;
  metrics: Record<string, MetricValue>;
  series: Record<string, Series>;
  stages: Stages | null;
  route: Route | null;
  details: Details;
}

export interface ListFilters {
  kind?: Kind;
  device?: string;
  tester?: string;
  /** true = test data only, false = real only, undefined = both. */
  is_test?: boolean;
  /** true = only sessions where two devices have something to compare; false = only those with nothing. */
  comparable?: boolean;
  limit: number;
  offset: number;
}

const SESSION_COLS = `id, ref, kind, activity, title, tester, extract(epoch from started_at)::float8 as started_at,
  extract(epoch from ended_at)::float8 as ended_at, utc_offset_min, devices, summary, notes, screenshots, is_test,
  firmware_version, app_version, platform, build_set_at, uploaded_by, created_at, updated_at`;
const RECORDING_COLS = `id, session_id, source_name, source_version, device_tag, device_label, logged, fingerprint, activity,
  extract(epoch from started_at)::float8 as started_at, extract(epoch from ended_at)::float8 as ended_at,
  metrics, series, stages, route, details`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toRec(r: RecordingRow): Rec {
  return {
    id: r.id, source: r.source_name, tag: r.device_tag, label: r.device_label || r.source_name, logged: r.logged,
    activity: r.activity, start: r.started_at, end: r.ended_at, series: r.series, stages: r.stages, route: r.route, details: r.details,
  };
}

export class BenchmarksRepo {
  constructor(private readonly db: Db) {}

  /** Runs `fn` in one transaction, so a half-imported session is never left behind. */
  async transaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async list(f: ListFilters): Promise<{ items: SessionRow[]; total: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, value: unknown) => { args.push(value); where.push(sql.replace('?', `$${args.length}`)); };
    if (f.kind) add('kind = ?', f.kind);
    if (f.device) add('? = any(devices)', f.device);
    if (f.tester) add('tester_key = ?', f.tester.trim().toLowerCase());
    if (f.is_test !== undefined) add('is_test = ?', f.is_test);
    // A session is comparable when its summary holds at least one test-against-reference pair.
    if (f.comparable !== undefined) where.push(`(jsonb_typeof(summary->'pairs') = 'array' and summary->'pairs' <> '[]'::jsonb) = ${f.comparable ? 'true' : 'false'}`);
    const cond = where.length ? `where ${where.join(' and ')}` : '';
    const r = await this.db.query<SessionRow & { total: string }>(
      `select ${SESSION_COLS}, count(*) over() as total
         from luna_feedback.benchmark_sessions ${cond}
        order by started_at desc, ref_no desc
        limit $${args.length + 1} offset $${args.length + 2}`,
      [...args, f.limit, f.offset],
    );
    return { items: r.rows.map(({ total: _total, ...row }) => row as SessionRow), total: Number(r.rows[0]?.total ?? 0) };
  }

  /**
   * Every session with its recordings' totals and heart rate quality, for Progress: never the
   * samples, so a tester's whole history is one small query. `isTest` as the list takes it.
   */
  async progressRows(isTest: boolean | undefined): Promise<ProgressSession[]> {
    const cond = isTest === undefined ? '' : `where s.is_test = ${isTest ? 'true' : 'false'}`;
    const r = await this.db.query<{
      id: string; ref: string; kind: Kind; activity: string | null; title: string | null; tester: string; started_at: number; ended_at: number;
      utc_offset_min: number; uploaded_at: number; devices: { tag: string; label: string | null; logged: boolean; metrics: Record<string, MetricValue>; hr: HrQuality | null }[] | null;
    }>(
      `select s.id, s.ref, s.kind, s.activity, s.title, s.tester,
              extract(epoch from s.started_at)::float8 as started_at, extract(epoch from s.ended_at)::float8 as ended_at,
              s.utc_offset_min, extract(epoch from s.created_at)::float8 as uploaded_at,
              (select jsonb_agg(jsonb_build_object('tag', r.device_tag, 'label', r.device_label, 'logged', r.logged, 'metrics', r.metrics, 'hr', r.details->'hr') order by r.created_at)
                 from luna_feedback.benchmark_recordings r where r.session_id = s.id) as devices
         from luna_feedback.benchmark_sessions s ${cond}
        order by s.started_at`,
    );
    return r.rows.map((row) => ({
      id: row.id, ref: row.ref, kind: row.kind, activity: row.activity, title: row.title, tester: row.tester,
      start: row.started_at, end: row.ended_at, offset_min: row.utc_offset_min, uploaded_at: row.uploaded_at,
      devices: (row.devices ?? []).map((d) => ({ tag: d.tag, label: d.label, logged: d.logged, metrics: d.metrics ?? {}, hr: d.hr ?? null })),
    }));
  }

  /** What the list's filters can offer: every tester and device tag seen so far. */
  async facets(): Promise<{ testers: string[]; devices: string[] }> {
    const r = await this.db.query<{ testers: string[] | null; devices: string[] | null }>(
      `select (select array_agg(t order by t) from (select distinct tester as t from luna_feedback.benchmark_sessions) a) as testers,
              (select array_agg(d order by d) from (select distinct unnest(devices) as d from luna_feedback.benchmark_sessions) b) as devices`,
    );
    return { testers: r.rows[0]?.testers ?? [], devices: r.rows[0]?.devices ?? [] };
  }

  /** By id, or by reference ("BM-0007", any case). */
  async session(idOrRef: string, q: Queryable = this.db): Promise<SessionRow | undefined> {
    const byId = UUID.test(idOrRef);
    const r = await q.query<SessionRow>(
      `select ${SESSION_COLS} from luna_feedback.benchmark_sessions where ${byId ? 'id = $1' : 'ref = upper($1)'}`,
      [idOrRef],
    );
    return r.rows[0];
  }

  async recordings(sessionId: string, q: Queryable = this.db): Promise<RecordingRow[]> {
    const r = await q.query<RecordingRow>(
      `select ${RECORDING_COLS} from luna_feedback.benchmark_recordings where session_id = $1 order by created_at, source_name`,
      [sessionId],
    );
    return r.rows;
  }

  /** Recordings already stored for these fingerprints, with the session each belongs to. */
  async byFingerprints(fingerprints: string[], q: Queryable = this.db): Promise<{ fingerprint: string; session_id: string; ref: string; device_tag: string }[]> {
    if (!fingerprints.length) return [];
    const r = await q.query<{ fingerprint: string; session_id: string; ref: string; device_tag: string }>(
      `select r.fingerprint, r.session_id, s.ref, r.device_tag
         from luna_feedback.benchmark_recordings r
         join luna_feedback.benchmark_sessions s on s.id = r.session_id
        where r.fingerprint = any($1::text[])`,
      [fingerprints],
    );
    return r.rows;
  }

  /** This tester's sessions that touch a span of time (of one kind, or of either), with the sources each already has. */
  async overlapping(tester: string, kind: Kind | null, start: number, end: number, q: Queryable = this.db): Promise<{ id: string; ref: string; kind: Kind; activity: string | null; title: string | null; started_at: number; ended_at: number; sources: string[] }[]> {
    const r = await q.query<{ id: string; ref: string; kind: Kind; activity: string | null; title: string | null; started_at: number; ended_at: number; sources: string[] }>(
      `select s.id, s.ref, s.kind, s.activity, s.title, extract(epoch from s.started_at)::float8 as started_at, extract(epoch from s.ended_at)::float8 as ended_at,
              coalesce((select array_agg(r.source_name) from luna_feedback.benchmark_recordings r where r.session_id = s.id), '{}') as sources
         from luna_feedback.benchmark_sessions s
        where s.tester_key = lower(btrim($1)) and ($2::text is null or s.kind = $2)
          and s.started_at < to_timestamp($4) and s.ended_at > to_timestamp($3)
        order by s.started_at`,
      [tester, kind, start, end],
    );
    return r.rows;
  }

  /** Which devices a set of sessions hold, without loading their samples. */
  async heads(sessionIds: string[], q: Queryable = this.db): Promise<RecordingHead[]> {
    if (!sessionIds.length) return [];
    const r = await q.query<RecordingHead>(
      `select id, session_id, source_name, device_tag, device_label, logged
         from luna_feedback.benchmark_recordings where session_id = any($1::uuid[]) order by created_at, source_name`,
      [sessionIds],
    );
    return r.rows;
  }

  /** The tag someone last gave this source, so a correction is made once. */
  async lastTags(sources: string[], q: Queryable = this.db): Promise<Map<string, { tag: string; label: string | null }>> {
    const out = new Map<string, { tag: string; label: string | null }>();
    if (!sources.length) return out;
    const r = await q.query<{ source_name: string; device_tag: string; device_label: string | null }>(
      `select distinct on (source_name) source_name, device_tag, device_label
         from luna_feedback.benchmark_recordings
        where source_name = any($1::text[])
        order by source_name, created_at desc`,
      [sources],
    );
    for (const row of r.rows) out.set(row.source_name, { tag: row.device_tag, label: row.device_label });
    return out;
  }

  async createSession(c: Queryable, s: { kind: Kind; tester: string; start: number; end: number; utc_offset_min: number; is_test: boolean; uploaded_by: string | null; build?: Partial<LunaBuild> }): Promise<SessionRow> {
    const b = s.build ?? {};
    const r = await c.query<SessionRow>(
      `insert into luna_feedback.benchmark_sessions (kind, tester, started_at, ended_at, utc_offset_min, is_test, uploaded_by, firmware_version, app_version, platform, build_set_at)
       values ($1, $2, to_timestamp($3), to_timestamp($4), $5, $6, $7, $8, $9, $10, case when $11::boolean then now() end)
       returning ${SESSION_COLS}`,
      [s.kind, s.tester, s.start, s.end, s.utc_offset_min, s.is_test, s.uploaded_by, b.firmware_version ?? null, b.app_version ?? null, b.platform ?? null,
        BUILD_FIELDS.some((k) => b[k])],
    );
    return r.rows[0]!;
  }

  /** Fills in the Luna build of a stored session that has none yet (a later import adding a device). */
  async fillBuild(c: Queryable, sessionId: string, b: Partial<LunaBuild>, setAt: Date | null = null): Promise<void> {
    if (!BUILD_FIELDS.some((k) => b[k])) return;
    await c.query(
      `update luna_feedback.benchmark_sessions
          set firmware_version = $2, app_version = $3, platform = $4, build_set_at = coalesce($5, now()), updated_at = now()
        where id = $1 and firmware_version is null and app_version is null and platform is null`,
      [sessionId, b.firmware_version ?? null, b.app_version ?? null, b.platform ?? null, setAt],
    );
  }

  /** The Luna build last entered for this tester, on any of their sessions: what the next one is prefilled with. */
  async lastBuild(tester: string, q: Queryable = this.db): Promise<(LunaBuild & { ref: string; set_at: Date }) | null> {
    const r = await q.query<LunaBuild & { ref: string; set_at: Date }>(
      `select firmware_version, app_version, platform, ref, build_set_at as set_at
         from luna_feedback.benchmark_sessions
        where tester_key = lower(btrim($1)) and build_set_at is not null
        order by build_set_at desc limit 1`,
      [tester],
    );
    return r.rows[0] ?? null;
  }

  async insertRecording(c: Queryable, sessionId: string, rec: NormalizedRecording, tag: string, label: string | null): Promise<string> {
    const r = await c.query<{ id: string }>(
      `insert into luna_feedback.benchmark_recordings
         (session_id, source_name, source_version, device_tag, device_label, logged, fingerprint, activity, started_at, ended_at, series, stages, route, details)
       values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), to_timestamp($10), $11, $12, $13, $14)
       returning id`,
      [sessionId, rec.source, rec.source_version, tag, label, rec.logged, rec.fingerprint, rec.activity, rec.start, rec.end,
        JSON.stringify(rec.series), rec.stages ? JSON.stringify(rec.stages) : null, rec.route ? JSON.stringify(rec.route) : null, JSON.stringify(rec.details)],
    );
    return r.rows[0]!.id;
  }

  async saveComputed(c: Queryable, sessionId: string, s: { start: number; end: number; activity: string | null; devices: string[]; summary: Summary },
    recs: { id: string; metrics: Record<string, MetricValue>; details: Details }[]): Promise<void> {
    for (const r of recs) {
      await c.query(`update luna_feedback.benchmark_recordings set metrics = $2, details = $3 where id = $1`, [r.id, JSON.stringify(r.metrics), JSON.stringify(r.details)]);
    }
    await c.query(
      `update luna_feedback.benchmark_sessions
          set started_at = to_timestamp($2), ended_at = to_timestamp($3), activity = $4, devices = $5, summary = $6, updated_at = now()
        where id = $1`,
      [sessionId, s.start, s.end, s.activity, s.devices, JSON.stringify(s.summary)],
    );
  }

  async patchSession(id: string, p: { title?: string | null; notes?: string | null; tester?: string; is_test?: boolean } & Partial<LunaBuild>): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [id];
    const at: Partial<Record<string, number>> = {};
    // Column names come from this list, never from the caller.
    for (const col of ['title', 'notes', 'tester', 'is_test', ...BUILD_FIELDS] as const) {
      const value = p[col];
      if (value === undefined) continue;
      args.push(value);
      at[col] = args.length;
      sets.push(`${col} = $${args.length}`);
    }
    if (!sets.length) return;
    // Entering a build makes it the tester's latest; clearing all of it leaves the session out of that.
    if (BUILD_FIELDS.some((k) => p[k] !== undefined)) {
      sets.push(`build_set_at = case when ${BUILD_FIELDS.map((k) => (at[k] ? `$${at[k]}::text is not null` : `${k} is not null`)).join(' or ')} then now() end`);
    }
    await this.db.query(`update luna_feedback.benchmark_sessions set ${sets.join(', ')}, updated_at = now() where id = $1`, args);
  }

  async patchRecording(c: Queryable, id: string, p: { device_tag?: string; device_label?: string | null }): Promise<void> {
    await c.query(
      `update luna_feedback.benchmark_recordings
          set device_tag = coalesce($2, device_tag),
              device_label = case when $3::boolean then $4 else device_label end
        where id = $1`,
      [id, p.device_tag ?? null, p.device_label !== undefined, p.device_label ?? null],
    );
  }

  /** Sets or clears (null) what a person typed in for a recording. */
  async setManual(c: Queryable, id: string, manual: Details['manual']): Promise<void> {
    await c.query(
      `update luna_feedback.benchmark_recordings
          set details = case when $2::jsonb is null then details - 'manual' else jsonb_set(details, '{manual}', $2::jsonb) end
        where id = $1`,
      [id, manual ? JSON.stringify(manual) : null],
    );
  }

  /** Every session, oldest first: just enough to find ones that sit close together. */
  async allSpans(): Promise<{ id: string; ref: string }[]> {
    const r = await this.db.query<{ id: string; ref: string }>(`select id, ref from luna_feedback.benchmark_sessions order by started_at, ref_no`);
    return r.rows;
  }

  /** Moves a recording into another session, optionally with its samples replaced (two halves of one device joined). */
  async moveRecording(c: Queryable, id: string, sessionId: string, series?: Record<string, Series>): Promise<void> {
    await c.query(
      `update luna_feedback.benchmark_recordings set session_id = $2, series = coalesce($3::jsonb, series) where id = $1`,
      [id, sessionId, series ? JSON.stringify(series) : null],
    );
  }

  async setSeries(c: Queryable, id: string, series: Record<string, Series>): Promise<void> {
    await c.query(`update luna_feedback.benchmark_recordings set series = $2 where id = $1`, [id, JSON.stringify(series)]);
  }

  async setNotes(c: Queryable, sessionId: string, notes: string | null): Promise<void> {
    await c.query(`update luna_feedback.benchmark_sessions set notes = $2, updated_at = now() where id = $1`, [sessionId, notes]);
  }

  /** Attaches one more screenshot. False when the session is full or already holds that file. */
  async addScreenshot(sessionId: string, shot: BenchmarkScreenshot, max: number): Promise<boolean> {
    const r = await this.db.query(
      `update luna_feedback.benchmark_sessions
          set screenshots = screenshots || $2::jsonb, updated_at = now()
        where id = $1 and jsonb_array_length(screenshots) < $3
          and not screenshots @> jsonb_build_array(jsonb_build_object('file_id', $4::text))`,
      [sessionId, JSON.stringify([shot]), max, shot.file_id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Detaches a screenshot. False when the session does not hold that file. */
  async removeScreenshot(sessionId: string, fileId: string): Promise<boolean> {
    const r = await this.db.query(
      `update luna_feedback.benchmark_sessions
          set screenshots = coalesce((select jsonb_agg(x order by ord) from jsonb_array_elements(screenshots) with ordinality as e(x, ord)
                                       where x->>'file_id' <> $2), '[]'::jsonb),
              updated_at = now()
        where id = $1 and screenshots @> jsonb_build_array(jsonb_build_object('file_id', $2::text))`,
      [sessionId, fileId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async setScreenshots(c: Queryable, sessionId: string, shots: BenchmarkScreenshot[]): Promise<void> {
    await c.query(`update luna_feedback.benchmark_sessions set screenshots = $2, updated_at = now() where id = $1`, [sessionId, JSON.stringify(shots)]);
  }

  async deleteRecording(c: Queryable, id: string): Promise<void> {
    await c.query(`delete from luna_feedback.benchmark_recordings where id = $1`, [id]);
  }

  async deleteSession(id: string, q: Queryable = this.db): Promise<void> {
    await q.query(`delete from luna_feedback.benchmark_sessions where id = $1`, [id]);
  }
}
