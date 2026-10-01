import type pg from 'pg';
import { AppError } from '../../lib/errors.js';
import {
  ANALYSIS_VERSION, analyzeSession, displayOrder, fingerprintOf, groupCandidates, normalizeRecording, overlapShare,
  type Candidate, type IncomingRecording, type Kind,
} from './analyze.js';
import { guessTag, tagLabel } from './metrics.js';
import { toRec, type BenchmarksRepo, type ListFilters, type RecordingRow, type SessionRow } from './benchmarks.repo.js';

export interface ImportInput {
  tester: string;
  kind: Kind;
  start: number;
  end: number;
  utc_offset_min: number;
  is_test?: boolean;
  recordings: IncomingRecording[];
}

export type CandidateStatus = 'new' | 'imported';
/** new: nothing like it is stored. adds_device: a stored session gains a device. imported: all of it is already stored. */
export type GroupStatus = 'new' | 'adds_device' | 'imported';

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export class BenchmarksService {
  constructor(private readonly repo: BenchmarksRepo) {}

  /** Sessions whose numbers were worked out by an older version of the analysis are redone before they are shown. */
  private async refresh(sessions: SessionRow[]): Promise<boolean> {
    const stale = sessions.filter((s) => (s.summary as { version?: number }).version !== ANALYSIS_VERSION);
    for (const s of stale) await this.repo.transaction((c) => this.recompute(c, s.id, s.kind));
    return stale.length > 0;
  }

  async list(filters: ListFilters) {
    let [page, facets] = await Promise.all([this.repo.list(filters), this.repo.facets()]);
    if (await this.refresh(page.items)) page = await this.repo.list(filters);
    return { total: page.total, limit: filters.limit, offset: filters.offset, facets, items: page.items.map(sessionDto) };
  }

  async get(idOrRef: string) {
    let session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    if (await this.refresh([session])) session = (await this.repo.session(session.id))!;
    const recordings = await this.repo.recordings(session.id);
    const ordered = displayOrder(recordings.map((r) => ({ tag: r.device_tag, logged: r.logged, row: r }))).map((x) => x.row);
    return { ...sessionDto(session), recordings: ordered.map(recordingDto) };
  }

  /**
   * Looks at the workouts and nights found in an export before anything is uploaded: which of them
   * are the same session on different devices, and which are already stored.
   */
  async check(tester: string, candidates: Candidate[]) {
    const fp = (c: Candidate) => fingerprintOf(c.kind, c.source, c.start, c.end);
    const stored = new Map((await this.repo.byFingerprints(candidates.map(fp))).map((r) => [r.fingerprint, r]));
    const lastTags = await this.repo.lastTags([...new Set(candidates.map((c) => c.source))]);
    const groups = groupCandidates(candidates);
    // Everything this tester has stored across the span of the export, fetched once.
    const mine = tester.trim() && candidates.length
      ? await this.repo.overlapping(tester, null, Math.min(...candidates.map((c) => c.start)), Math.max(...candidates.map((c) => c.end)))
      : [];
    const out = [];
    for (const g of groups) {
      const members = g.members.map((c) => {
        const hit = stored.get(fp(c));
        return { key: c.key, source: c.source, activity: c.activity ?? null, start: c.start, end: c.end, status: (hit ? 'imported' : 'new') as CandidateStatus, tag: hit?.device_tag ?? lastTags.get(c.source)?.tag ?? guessTag(c.source) };
      });
      const hits = g.members.map((c) => stored.get(fp(c))).filter((h) => h !== undefined);
      let session = hits[0] ? { id: hits[0].session_id, ref: hits[0].ref } : null;
      // Nothing of it is stored under the same start and end, but this tester may already have the
      // session: from another device, or from this one before its recording was extended.
      if (!session) {
        const near = mine.find((s) => s.kind === g.kind && overlapShare({ start: s.started_at, end: s.ended_at }, g) >= 0.5);
        if (near) {
          session = { id: near.id, ref: near.ref };
          for (const m of members) if (near.sources.includes(m.source)) m.status = 'imported';
        }
      }
      const left = members.filter((m) => m.status === 'new').length;
      const status: GroupStatus = left === 0 ? 'imported' : session ? 'adds_device' : 'new';
      out.push({ kind: g.kind, start: g.start, end: g.end, status, session, members });
    }
    return { groups: out };
  }

  /**
   * Stores what the devices recorded during one session. A recording that is already stored is
   * skipped; a device that is new to a stored session joins it; otherwise a session is created.
   */
  async import(input: ImportInput, uploadedBy: string | null) {
    try {
      return await this.importOnce(input, uploadedBy);
    } catch (err) {
      // Two people importing the same export at the same moment: the second finds the first's rows.
      if ((err as { code?: string }).code === '23505') throw AppError.conflict('This session was being imported at the same moment. Try again: it will be recognised as stored.');
      throw err;
    }
  }

  private async importOnce(input: ImportInput, uploadedBy: string | null) {
    const window = { start: input.start, end: input.end };
    const normalized = input.recordings
      .map((r) => normalizeRecording(r, input.kind, window))
      // A source with neither a workout or night of its own nor any sample has nothing to store.
      .filter((r) => r.logged || Object.keys(r.series).length > 0);
    if (!normalized.some((r) => r.logged)) throw AppError.validation([{ path: 'recordings', message: 'at least one recording must carry the workout or the night itself' }]);

    return this.repo.transaction(async (c) => {
      const fingerprints = normalized.map((r) => r.fingerprint).filter((f): f is string => f !== null);
      const stored = await this.repo.byFingerprints(fingerprints, c);
      const storedSet = new Set(stored.map((s) => s.fingerprint));

      let session: SessionRow | undefined;
      let created = false;
      if (stored[0]) session = await this.repo.session(stored[0].session_id, c);
      if (!session) {
        const near = (await this.repo.overlapping(input.tester, input.kind, input.start, input.end, c))
          .find((s) => overlapShare({ start: s.started_at, end: s.ended_at }, window) >= 0.5);
        if (near) session = await this.repo.session(near.id, c);
      }
      const fresh = normalized.filter((r) => !(r.fingerprint && storedSet.has(r.fingerprint)));
      if (!session) {
        if (!fresh.some((r) => r.logged)) throw AppError.conflict('This session is already stored.');
        session = await this.repo.createSession(c, { kind: input.kind, tester: input.tester, start: input.start, end: input.end, utc_offset_min: input.utc_offset_min, is_test: input.is_test ?? false, uploaded_by: uploadedBy });
        created = true;
      }

      const existing = created ? [] : await this.repo.recordings(session.id, c);
      const have = new Set(existing.map((r) => r.source_name));
      const lastTags = await this.repo.lastTags(fresh.map((r) => r.source), c);
      const added: string[] = [];
      const addsLogged = fresh.some((r) => r.logged && !have.has(r.source));
      const skipped: string[] = normalized.filter((r) => !fresh.includes(r)).map((r) => r.source);
      for (const rec of fresh) {
        if (have.has(rec.source)) { skipped.push(rec.source); continue; }
        // A source joining a stored session without a workout of its own adds nothing new to compare.
        if (!created && !rec.logged && !addsLogged) { skipped.push(rec.source); continue; }
        const last = lastTags.get(rec.source);
        const device = rec.details.device ?? undefined;
        await this.repo.insertRecording(c, session.id, rec, last?.tag ?? guessTag(rec.source, device), last?.label ?? null);
        have.add(rec.source);
        added.push(rec.source);
      }
      if (added.length) await this.recompute(c, session.id, input.kind);
      const after = (await this.repo.session(session.id, c))!;
      return { status: created ? 'created' as const : added.length ? 'updated' as const : 'unchanged' as const, session: { id: after.id, ref: after.ref }, added, skipped };
    });
  }

  /** Re-derives every number of a session from what its recordings hold. */
  private async recompute(c: pg.PoolClient, sessionId: string, kind: Kind): Promise<void> {
    const rows = await this.repo.recordings(sessionId, c);
    if (!rows.length) return;
    const recs = rows.map(toRec);
    const a = analyzeSession(recs, kind);
    await this.repo.saveComputed(c, sessionId, {
      start: a.window.start, end: a.window.end, activity: a.activity,
      devices: [...new Set(rows.map((r) => r.device_tag))].sort(),
      summary: a.summary,
    }, rows.map((r) => ({ id: r.id, metrics: a.metrics.get(r.id) ?? {}, details: { ...r.details, hr: a.hr.get(r.id) ?? null } })));
  }

  async update(idOrRef: string, patch: { title?: string | null; notes?: string | null; tester?: string; is_test?: boolean }) {
    const session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    await this.repo.patchSession(session.id, patch);
    return this.get(session.id);
  }

  /** Re-tagging a device changes which one is under test, so the comparison is redone. */
  async updateRecording(idOrRef: string, recordingId: string, patch: { device_tag?: string; device_label?: string | null }) {
    const session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    const rec = (await this.repo.recordings(session.id)).find((r) => r.id === recordingId);
    if (!rec) throw AppError.notFound('No such recording in this session');
    await this.repo.transaction(async (c) => {
      await this.repo.patchRecording(c, rec.id, patch);
      await this.recompute(c, session.id, session.kind);
    });
    return this.get(session.id);
  }

  async remove(idOrRef: string): Promise<{ deleted: string }> {
    const session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    await this.repo.deleteSession(session.id);
    return { deleted: session.ref };
  }

  /** Removes one device from a session. The last device that logged it takes the session with it. */
  async removeRecording(idOrRef: string, recordingId: string) {
    const session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    const rows = await this.repo.recordings(session.id);
    const rec = rows.find((r) => r.id === recordingId);
    if (!rec) throw AppError.notFound('No such recording in this session');
    if (!rows.some((r) => r.id !== rec.id && r.logged)) {
      await this.repo.deleteSession(session.id);
      return { deleted: session.ref, session: null };
    }
    await this.repo.transaction(async (c) => {
      await this.repo.deleteRecording(c, rec.id);
      await this.recompute(c, session.id, session.kind);
    });
    return { deleted: rec.source_name, session: await this.get(session.id) };
  }
}

function sessionDto(s: SessionRow) {
  return {
    id: s.id, ref: s.ref, kind: s.kind, activity: s.activity, title: s.title, tester: s.tester,
    started_at: iso(s.started_at), ended_at: iso(s.ended_at), duration_s: Math.round(s.ended_at - s.started_at),
    utc_offset_min: s.utc_offset_min, devices: s.devices, summary: s.summary, notes: s.notes, is_test: s.is_test,
    uploaded_by: s.uploaded_by, created_at: new Date(s.created_at).toISOString(), updated_at: new Date(s.updated_at).toISOString(),
  };
}

function recordingDto(r: RecordingRow) {
  return {
    id: r.id, source_name: r.source_name, source_version: r.source_version,
    device_tag: r.device_tag, device_label: r.device_label || r.source_name, tag_label: tagLabel(r.device_tag),
    logged: r.logged, activity: r.activity, started_at: iso(r.started_at), ended_at: iso(r.ended_at),
    metrics: r.metrics, series: r.series, stages: r.stages, route: r.route, details: r.details,
  };
}
