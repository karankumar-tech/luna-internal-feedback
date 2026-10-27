import type pg from 'pg';
import { AppError } from '../../lib/errors.js';
import {
  ANALYSIS_VERSION, analyzeSession, displayOrder, fingerprintOf, groupCandidates, looksLikeSameSession, mergeSeries, normalizeRecording, overlapShare,
  type Candidate, type IncomingRecording, type Kind,
} from './analyze.js';
import { activityKey, activityLabel, guessTag, isOnFoot, tagLabel, TEST_TAG } from './metrics.js';
import { HR_BY_MINUTE_MAX, listWorkbook, sessionWorkbook, type ExportFile, type ExportOptions } from './export.js';
import { GOALS, groupByTester, leaderboard, progressReport, testerKey } from './progress.js';
import { toRec, type BenchmarkScreenshot, type BenchmarksRepo, type ListFilters, type LunaBuild, type RecordingHead, type RecordingRow, type SessionRow } from './benchmarks.repo.js';

/** How far apart two sessions may sit and still be offered as "possibly the same one". */
const NEARBY_S = 30 * 60;

/** The most sessions one list export holds. */
export const BENCHMARK_EXPORT_MAX = 2000;

/** How many screenshots one session may hold. */
export const BENCHMARK_MAX_SCREENSHOTS = 6;

export interface ScreenshotInput { file_id: string; url: string; name?: string | null; width?: number | null; height?: number | null; size?: number | null }

export interface ImportInput {
  tester: string;
  kind: Kind;
  start: number;
  end: number;
  utc_offset_min: number;
  is_test?: boolean;
  firmware_version?: string | null;
  app_version?: string | null;
  platform?: LunaBuild['platform'];
  recordings: IncomingRecording[];
}

/** more: a day of steps that is stored, but this export holds more of its samples (a device synced late). */
export type CandidateStatus = 'new' | 'imported' | 'more';
/**
 * new: nothing like it is stored. adds_device: a stored session gains a device. updates: a stored day
 * of steps gets the samples a device synced since. imported: all of it is already stored.
 */
export type GroupStatus = 'new' | 'adds_device' | 'updates' | 'imported';

/** A candidate for the check: a workout, a night, or one source's day of steps (with its sample count). */
export type CheckCandidate = Candidate & { samples?: number | null };

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export class BenchmarksService {
  /** Screenshot URL check + cleanup, wired when ImageKit is configured. */
  private screenshots: { isOurUrl: (u: string) => boolean; deleteFile: (id: string) => Promise<boolean> } | null = null;

  constructor(private readonly repo: BenchmarksRepo) {}

  setScreenshotSupport(s: { isOurUrl: (u: string) => boolean; deleteFile: (id: string) => Promise<boolean> } | null) { this.screenshots = s; }

  /** Best effort, sequential to respect ImageKit rate limits; failures are ignored. */
  private async deleteFiles(shots: BenchmarkScreenshot[]): Promise<void> {
    if (!this.screenshots) return;
    for (const s of shots) await this.screenshots.deleteFile(s.file_id);
  }

  /** Attaches an image already uploaded to ImageKit (see GET /v1/admin/benchmarks/screenshot-auth). */
  async addScreenshot(idOrRef: string, input: ScreenshotInput, addedBy: string | null) {
    if (!this.screenshots) throw AppError.validation([{ path: 'screenshots', message: 'screenshot uploads are not configured on the server' }], 'Uploads unavailable');
    if (!this.screenshots.isOurUrl(input.url)) throw AppError.validation([{ path: 'url', message: 'must be an ImageKit URL from the screenshot upload flow' }]);
    const session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    const shot: BenchmarkScreenshot = {
      file_id: input.file_id, url: input.url, name: input.name ?? null, width: input.width ?? null, height: input.height ?? null, size: input.size ?? null,
      added_by: addedBy, added_at: new Date().toISOString(),
    };
    if (!(await this.repo.addScreenshot(session.id, shot, BENCHMARK_MAX_SCREENSHOTS))) {
      if (session.screenshots.some((s) => s.file_id === shot.file_id)) return this.get(session.id);
      throw AppError.conflict(`${session.ref} already has ${BENCHMARK_MAX_SCREENSHOTS} screenshots. Remove one to add another.`);
    }
    return this.get(session.id);
  }

  async removeScreenshot(idOrRef: string, fileId: string) {
    const session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    const shot = session.screenshots.find((s) => s.file_id === fileId);
    if (!shot || !(await this.repo.removeScreenshot(session.id, fileId))) throw AppError.notFound('No such screenshot on this session');
    await this.deleteFiles([shot]);
    return this.get(session.id);
  }

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

  /**
   * One tester's progress (streaks, goals, bests, badges, nudges) and everyone's leaderboard. With
   * no tester, the leaderboard and the list of testers alone. Real sessions only unless asked.
   */
  async progress(q: { tester?: string; is_test?: boolean; weeks?: number; now?: number }) {
    const byTester = groupByTester(await this.repo.progressRows(q.is_test ?? false));
    const now = q.now ?? Date.now() / 1000;
    const key = q.tester ? testerKey(q.tester) : null;
    const mine = key ? byTester.get(key) : undefined;
    if (key && !mine) throw AppError.notFound(`No benchmark sessions for ${q.tester}`);
    const board = leaderboard(byTester, { now });
    return {
      goals: GOALS,
      testers: board.map((r) => ({ tester: r.tester, sessions: r.sessions, last_upload_at: r.last_upload_at })),
      leaderboard: board,
      report: mine ? progressReport(mine[0]!.tester, mine, { now, weeks: q.weeks }) : null,
    };
  }

  async get(idOrRef: string) {
    let session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    if (await this.refresh([session])) session = (await this.repo.session(session.id))!;
    const [recordings, last] = await Promise.all([this.repo.recordings(session.id), this.lastBuild(session.tester)]);
    const ordered = displayOrder(recordings.map((r) => ({ tag: r.device_tag, logged: r.logged, row: r }))).map((x) => x.row);
    return { ...sessionDto(session), recordings: ordered.map(recordingDto), nearby: await this.nearby(session, recordings), last_build: last };
  }

  /**
   * The Luna build this tester last entered, on whichever session: what the import page and a session
   * without one are prefilled with, since a tester keeps the same band and phone from one test to the next.
   */
  async lastBuild(tester: string) {
    if (!tester.trim()) return null;
    const b = await this.repo.lastBuild(tester);
    return b ? { firmware_version: b.firmware_version, app_version: b.app_version, platform: b.platform, ref: b.ref, set_at: new Date(b.set_at).toISOString() } : null;
  }

  /** One session as an Excel workbook: the comparison, each device's numbers and every reading. */
  async exportSession(idOrRef: string, opts: ExportOptions): Promise<ExportFile> {
    let session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    if (await this.refresh([session])) session = (await this.repo.session(session.id))!;
    const recordings = await this.repo.recordings(session.id);
    return sessionWorkbook(session, displayOrder(recordings.map((r) => ({ tag: r.device_tag, logged: r.logged, row: r }))).map((x) => x.row), opts);
  }

  /** Every session the list's filters match, newest first, as an Excel workbook of their comparisons. */
  async exportList(filters: Omit<ListFilters, 'limit' | 'offset'>, opts: ExportOptions & { filters: [string, string][] }): Promise<ExportFile> {
    const all = { ...filters, limit: BENCHMARK_EXPORT_MAX, offset: 0 };
    let page = await this.repo.list(all);
    if (await this.refresh(page.items)) page = await this.repo.list(all);
    return listWorkbook(page.items, opts, await this.heartRates(page.items));
  }

  /** Each session's recordings, heart rate only, in the order its page shows them; readings for a list short enough to hold them. */
  private async heartRates(sessions: SessionRow[]): Promise<Map<string, RecordingRow[]>> {
    const rows = await this.repo.heartRates(sessions.map((s) => s.id), sessions.length <= HR_BY_MINUTE_MAX);
    const out = new Map<string, RecordingRow[]>();
    for (const r of rows) out.set(r.session_id, [...(out.get(r.session_id) ?? []), r]);
    for (const [id, recs] of out) out.set(id, displayOrder(recs.map((r) => ({ tag: r.device_tag, logged: r.logged, row: r }))).map((x) => x.row));
    return out;
  }

  /** The sessions picked on the list, by reference or id, as the same workbook. Unknown references are named in the error. */
  async exportPicked(refs: string[], opts: ExportOptions): Promise<ExportFile> {
    const wanted = [...new Set(refs.map((r) => r.trim()).filter(Boolean))];
    let rows = await this.repo.byRefs(wanted);
    const found = new Set(rows.flatMap((r) => [r.id, r.ref]));
    const missing = wanted.filter((w) => !found.has(w) && !found.has(w.toUpperCase()));
    if (missing.length) throw AppError.notFound(`No benchmark session ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}`);
    if (await this.refresh(rows)) rows = await this.repo.byRefs(wanted);
    return listWorkbook(rows, { ...opts, filters: [['Picked', `${rows.length} session${rows.length === 1 ? '' : 's'} picked on the list: ${rows.map((r) => r.ref).join(', ')}`]] }, await this.heartRates(rows));
  }

  /**
   * This tester's other sessions of the same kind recorded close to this one, that could be joined
   * with it: a device whose clock is off records the same workout as a separate session. One where
   * a device logged something in both is left out: that device recorded two things.
   */
  private async nearby(session: SessionRow, mine: RecordingHead[], limit = 5) {
    // A day of steps is that day: the one before and after are other days, never the same one.
    if (session.kind === 'steps') return [];
    const others = (await this.repo.overlapping(session.tester, session.kind, session.started_at - NEARBY_S, session.ended_at + NEARBY_S))
      .filter((o) => o.id !== session.id);
    const heads = await this.repo.heads(others.map((o) => o.id));
    const loggedHere = new Set(mine.filter((r) => r.logged).map((r) => r.source_name));
    const out = [];
    for (const o of others) {
      const recs = heads.filter((h) => h.session_id === o.id);
      if (recs.some((r) => r.logged && loggedHere.has(r.source_name))) continue;
      out.push({
        id: o.id, ref: o.ref, activity: o.activity, title: o.title, started_at: iso(o.started_at), ended_at: iso(o.ended_at),
        /** activity: the workout type a device logged, null for one that only wrote readings. */
        devices: displayOrder(recs.map((r) => ({ tag: r.device_tag, logged: r.logged, label: r.device_label || r.source_name, activity: r.logged ? r.activity : null }))),
        /** Seconds from this session's start to the other's: positive when the other starts later. */
        starts_after_s: Math.round(o.started_at - session.started_at),
        overlaps: o.started_at < session.ended_at && o.ended_at > session.started_at,
        likely_same: looksLikeSameSession({ start: session.started_at, end: session.ended_at }, { start: o.started_at, end: o.ended_at }),
      });
    }
    return out.sort((a, b) => Number(b.likely_same) - Number(a.likely_same) || Math.abs(a.starts_after_s) - Math.abs(b.starts_after_s)).slice(0, limit);
  }

  /**
   * The session close to this one in which another device logged a workout of this type: once a
   * person has said what this workout was, the same workout recorded as a session of its own (a clock
   * that is off, or a device started late). It has to start within 20 minutes at a similar length, or
   * share time with this one; "other workout" says too little to go on.
   */
  private async sameWorkoutNearby(session: SessionRow, mine: RecordingHead[], activity: string) {
    if (session.kind !== 'workout' || activity === 'other') return null;
    const near = await this.nearby(session, mine, Infinity);
    return near.find((n) => (n.likely_same || n.overlaps) && n.devices.some((d) => d.logged && d.activity === activity)) ?? null;
  }

  /** The workout types a recording can be changed to: every type a device has logged so far, "other workout" last. */
  async activities() {
    return (await this.repo.activityKeys())
      .map((key) => ({ key, label: activityLabel(key) }))
      .sort((a, b) => Number(a.key === 'other') - Number(b.key === 'other') || a.label.localeCompare(b.label));
  }

  /**
   * Joins another session into this one: its recordings move here, it is removed, and the
   * comparison is redone. Where both hold the same source, the one that logged the session is kept
   * and takes the other's samples; two logged recordings from one source cannot be one session.
   */
  async merge(idOrRef: string, otherIdOrRef: string) {
    const [target, other] = await Promise.all([this.repo.session(idOrRef), this.repo.session(otherIdOrRef)]);
    if (!target || !other) throw AppError.notFound('No benchmark session with that id or reference');
    if (target.id === other.id) throw AppError.validation([{ path: 'other', message: 'a session cannot be merged with itself' }]);
    if (target.kind !== other.kind) throw AppError.validation([{ path: 'other', message: `${other.ref} is a ${other.kind} session and ${target.ref} a ${target.kind} session` }]);
    if (target.kind === 'steps') throw AppError.validation([{ path: 'other', message: 'days of steps are not merged: each is one day' }]);
    const shots = [...target.screenshots, ...other.screenshots.filter((o) => !target.screenshots.some((t) => t.file_id === o.file_id))];
    await this.repo.transaction(async (c) => {
      const [here, there] = await Promise.all([this.repo.recordings(target.id, c), this.repo.recordings(other.id, c)]);
      const clash = there.find((b) => b.logged && here.some((a) => a.logged && a.source_name === b.source_name));
      if (clash) throw AppError.conflict(`${clash.source_name} logged a ${target.kind === 'sleep' ? 'night' : 'workout'} in both ${target.ref} and ${other.ref}, so they are two sessions.`);
      for (const b of there) {
        const a = here.find((x) => x.source_name === b.source_name);
        if (!a) { await this.repo.moveRecording(c, b.id, target.id); continue; }
        const series = mergeSeries(a.logged || !b.logged ? a.series : b.series, a.logged || !b.logged ? b.series : a.series);
        if (b.logged) {
          // The other session holds this device's own recording; the samples it left here join it.
          await this.repo.deleteRecording(c, a.id);
          await this.repo.moveRecording(c, b.id, target.id, series);
        } else {
          await this.repo.setSeries(c, a.id, series);
        }
      }
      const notes = [target.notes, other.notes].filter(Boolean).join('\n\n').slice(0, 4000);
      if (notes !== (target.notes ?? '')) await this.repo.setNotes(c, target.id, notes || null);
      if (other.screenshots.length) await this.repo.setScreenshots(c, target.id, shots.slice(0, BENCHMARK_MAX_SCREENSHOTS));
      // The Luna build goes along when only the other session had one, still dated when it was entered.
      await this.repo.fillBuild(c, target.id, other, other.build_set_at);
      await this.repo.deleteSession(other.id, c);
      await this.recompute(c, target.id, target.kind);
    });
    // Screenshots beyond what one session may hold do not survive the merge.
    await this.deleteFiles(shots.slice(BENCHMARK_MAX_SCREENSHOTS));
    return { merged: other.ref, session: await this.get(target.id) };
  }

  /**
   * One-time clean-up: every pair of stored sessions that look like one session recorded with
   * different clocks (different devices, starting within 20 minutes of each other, similar length).
   * With `apply` false nothing is changed; the pairs are only listed.
   */
  async mergeLikelySame(apply: boolean): Promise<{ into: string; from: string; starts_after_s: number; devices: string[] }[]> {
    const gone = new Set<string>();
    const out = [];
    for (const { id, ref } of await this.repo.allSpans()) {
      if (gone.has(id)) continue;
      for (;;) {
        const session = await this.repo.session(id);
        if (!session) break;
        const near = (await this.nearby(session, await this.repo.heads([id]))).find((n) => n.likely_same && !gone.has(n.id));
        if (!near) break;
        out.push({ into: ref, from: near.ref, starts_after_s: near.starts_after_s, devices: near.devices.filter((d) => d.logged).map((d) => d.label) });
        gone.add(near.id);
        if (apply) await this.merge(id, near.id);
      }
    }
    return out;
  }

  /**
   * Looks at the workouts and nights found in an export before anything is uploaded: which of them
   * are the same session on different devices, and which are already stored.
   */
  async check(tester: string, candidates: CheckCandidate[]) {
    const fp = (c: Candidate) => fingerprintOf(c.kind, c.source, c.start, c.end);
    const stored = new Map((await this.repo.byFingerprints(candidates.map(fp))).map((r) => [r.fingerprint, r]));
    const lastTags = await this.repo.lastTags([...new Set(candidates.map((c) => c.source))]);
    const rules = await this.repo.activityRules(tester);
    const groups = groupCandidates(candidates) as (Omit<ReturnType<typeof groupCandidates>[number], 'members'> & { members: CheckCandidate[] })[];
    // Everything this tester has stored across the span of the export, fetched once.
    const mine = tester.trim() && candidates.length
      ? await this.repo.overlapping(tester, null, Math.min(...candidates.map((c) => c.start)), Math.max(...candidates.map((c) => c.end)))
      : [];
    const out = [];
    for (const g of groups) {
      const members = g.members.map((c) => {
        const hit = stored.get(fp(c));
        // A stored day of steps with fewer samples than this export has: the export brings the rest.
        const status: CandidateStatus = !hit ? 'new' : g.kind === 'steps' && c.samples != null && (hit.samples ?? 0) < c.samples ? 'more' : 'imported';
        // A workout type this tester's workouts from this source are changed to, from the next import on.
        const rule = g.kind === 'workout' && c.activity ? rules.find((x) => x.source === c.source && x.from === activityKey(c.activity!)) : undefined;
        return {
          key: c.key, source: c.source, activity: c.activity ?? null, start: c.start, end: c.end, status, tag: hit?.device_tag ?? lastTags.get(c.source)?.tag ?? guessTag(c.source),
          ...(rule ? { activity_as: rule.to, activity_as_label: activityLabel(rule.to) } : {}),
        };
      });
      // A day of steps is a benchmark of Luna: one without Luna, or with Luna alone, is not offered.
      if (g.kind === 'steps' && (members.length < 2 || !members.some((m) => m.tag === TEST_TAG))) continue;
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
      const more = members.filter((m) => m.status === 'more').length;
      const status: GroupStatus = left === 0 && more === 0 ? 'imported' : !session ? 'new' : left ? 'adds_device' : 'updates';
      out.push({ kind: g.kind, start: g.start, end: g.end, status, session, members });
    }
    return { groups: out, last_build: await this.lastBuild(tester) };
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
    const now = new Date().toISOString();
    const normalized = input.recordings
      .map((r) => {
        const n = normalizeRecording(r, input.kind, window);
        // The uploader left this device out of the day: not worn all of it.
        if (input.kind === 'steps' && r.excluded) n.details.excluded = { by: uploadedBy, at: now, at_import: true };
        return n;
      })
      // A source with neither a workout or night of its own nor any sample has nothing to store.
      .filter((r) => r.logged || Object.keys(r.series).length > 0);
    if (!normalized.some((r) => r.logged)) throw AppError.validation([{ path: 'recordings', message: input.kind === 'steps' ? 'at least one recording must carry its day of steps' : 'at least one recording must carry the workout or the night itself' }]);
    // This tester's workouts from a source logged as one type are another, as a person decided before (Garmin's HIIT as strength training).
    if (input.kind === 'workout') {
      const rules = await this.repo.activityRules(input.tester);
      for (const rec of normalized) {
        const rule = rec.logged && rec.activity ? rules.find((x) => x.source === rec.source && x.from === rec.activity) : undefined;
        if (!rule) continue;
        rec.details.activity_set = { from: rule.from, to: rule.to, scope: 'tester', by: rule.by, at: now };
        rec.activity = rule.to;
      }
    }
    const build: Partial<LunaBuild> = { firmware_version: input.firmware_version ?? null, app_version: input.app_version ?? null, platform: input.platform ?? null };

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
      // A stored day of steps that this export has more samples of (a device synced late): its readings are replaced.
      const refresh = input.kind !== 'steps' ? [] : normalized.flatMap((r) => {
        const hit = stored.find((x) => x.fingerprint === r.fingerprint);
        return hit && (hit.samples ?? 0) < (r.details.day?.samples ?? 0) ? [{ id: hit.id, rec: r }] : [];
      });
      if (!session) {
        if (!fresh.some((r) => r.logged)) throw AppError.conflict('This session is already stored.');
        session = await this.repo.createSession(c, { kind: input.kind, tester: input.tester, start: input.start, end: input.end, utc_offset_min: input.utc_offset_min, is_test: input.is_test ?? false, uploaded_by: uploadedBy, build });
        created = true;
      } else {
        // A stored session that gains a device keeps the build it has; one without takes this import's.
        await this.repo.fillBuild(c, session.id, build);
      }

      const existing = created ? [] : await this.repo.recordings(session.id, c);
      const have = new Set(existing.map((r) => r.source_name));
      const lastTags = await this.repo.lastTags(fresh.map((r) => r.source), c);
      const added: string[] = [];
      const addsLogged = fresh.some((r) => r.logged && !have.has(r.source));
      const refreshed: string[] = [];
      for (const { id, rec } of refresh) {
        await this.repo.replaceDay(c, id, rec.series, rec.details.day ?? null);
        refreshed.push(rec.source);
      }
      const skipped: string[] = normalized.filter((r) => !fresh.includes(r) && !refreshed.includes(r.source)).map((r) => r.source);
      for (const rec of fresh) {
        if (have.has(rec.source)) { skipped.push(rec.source); continue; }
        // A source joining a stored session without a workout of its own adds nothing new to compare.
        if (!created && !rec.logged && !addsLogged) { skipped.push(rec.source); continue; }
        const last = lastTags.get(rec.source);
        const device = rec.details.device ?? undefined;
        const tag = last?.tag ?? guessTag(rec.source, device);
        // Luna is taken to be worn all day: it is the device under test, never left out.
        if (tag === TEST_TAG && rec.details.excluded) delete rec.details.excluded;
        await this.repo.insertRecording(c, session.id, rec, tag, last?.label ?? null);
        have.add(rec.source);
        added.push(rec.source);
      }
      if (added.length || refreshed.length) await this.recompute(c, session.id, input.kind);
      const after = (await this.repo.session(session.id, c))!;
      return { status: created ? 'created' as const : added.length || refreshed.length ? 'updated' as const : 'unchanged' as const, session: { id: after.id, ref: after.ref }, added, refreshed, skipped };
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
    }, rows.map((r) => ({ id: r.id, metrics: a.metrics.get(r.id) ?? {}, details: { ...r.details, hr: a.hr.get(r.id) ?? null, ...(kind === 'steps' ? { steps: a.steps.get(r.id) ?? null } : {}) } })));
  }

  async update(idOrRef: string, patch: { title?: string | null; notes?: string | null; tester?: string; is_test?: boolean } & Partial<LunaBuild>) {
    const session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    await this.repo.patchSession(session.id, patch);
    return this.get(session.id);
  }

  /**
   * Re-tagging a device changes which one is under test, so the comparison is redone. distance_km and
   * active_kcal are for Luna, which does not always write them to Apple Health: read off its app and
   * typed in, null to clear. max_pace_s is for any device that logged a workout on foot: none of them
   * writes its fastest pace to Apple Health.
   *
   * activity changes the workout type a device logged (Garmin's "HIIT" that was strength training).
   * activity_scope 'tester' makes it every workout of this tester that this source logged as that type,
   * stored and imported from then on; 'session' (the default) only this one. When no other device logged
   * this workout, and another device logged one of the new type close by, that session is this workout
   * too: it is merged in and the two are compared (`merged` names it).
   *
   * excluded leaves a device out of a day of steps (it was not worn the whole day), or takes it back in.
   */
  async updateRecording(idOrRef: string, recordingId: string, patch: {
    device_tag?: string; device_label?: string | null; distance_km?: number | null; active_kcal?: number | null; max_pace_s?: number | null;
    activity?: string; activity_scope?: 'session' | 'tester'; excluded?: boolean;
  }, by: string | null = null) {
    const session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    const rec = (await this.repo.recordings(session.id)).find((r) => r.id === recordingId);
    if (!rec) throw AppError.notFound('No such recording in this session');
    const FIELDS = ['distance_km', 'active_kcal', 'max_pace_s'] as const;
    const typed = FIELDS.filter((k) => patch[k] !== undefined);
    const entered = typed.filter((k) => patch[k] !== null);
    const workout = session.kind === 'workout' && rec.logged;
    for (const k of entered) {
      if (k === 'max_pace_s' && !(workout && isOnFoot(patch.activity ?? rec.activity))) throw AppError.validation([{ path: k, message: 'a max pace can only be entered for a run, walk or hike that the device logged' }]);
      if (k !== 'max_pace_s' && !(workout && (patch.device_tag ?? rec.device_tag) === 'luna')) throw AppError.validation([{ path: k, message: 'distance and calories can only be entered for a workout that Luna logged' }]);
    }
    if (patch.activity !== undefined && !workout) throw AppError.validation([{ path: 'activity', message: 'only a workout the device logged has a workout type' }]);
    if (patch.excluded !== undefined) {
      if (session.kind !== 'steps') throw AppError.validation([{ path: 'excluded', message: 'only a device in a day of steps can be left out; remove a device from a workout or a night instead' }]);
      if (patch.excluded && (patch.device_tag ?? rec.device_tag) === TEST_TAG) throw AppError.validation([{ path: 'excluded', message: 'Luna is taken to be worn all day: it is the device under test' }]);
    }
    const at = new Date().toISOString();
    const also: string[] = [];
    await this.repo.transaction(async (c) => {
      await this.repo.patchRecording(c, rec.id, patch);
      if (typed.length) {
        const merged = { ...rec.details.manual, ...patch };
        const values = Object.fromEntries(FIELDS.filter((k) => merged[k] != null).map((k) => [k, merged[k]]));
        await this.repo.setManual(c, rec.id, Object.keys(values).length ? { ...values, by, at } : null);
      }
      if (patch.excluded !== undefined) await this.repo.setExcluded(c, rec.id, patch.excluded ? { by, at } : null);
      if (patch.activity !== undefined) {
        // What the device logged it as, however often it has been changed since.
        const from = rec.details.activity_set?.from ?? rec.activity ?? 'other';
        if (patch.activity_scope === 'tester') {
          const sessions = await this.repo.setActivityForTester(c, { tester: session.tester, source: rec.source_name, from, to: patch.activity, by, at, keep: rec.id });
          for (const id of sessions) {
            if (id === session.id) continue;
            const other = await this.repo.session(id, c);
            if (other) { await this.recompute(c, id, other.kind); also.push(other.ref); }
          }
        } else {
          await this.repo.setActivity(c, rec.id, patch.activity, patch.activity === from ? null : { from, to: patch.activity, scope: 'session', by, at });
        }
      }
      await this.recompute(c, session.id, session.kind);
    });
    let merged: string | null = null;
    if (patch.activity !== undefined) {
      const heads = await this.repo.heads([session.id]);
      if (!heads.some((h) => h.logged && h.id !== rec.id)) {
        const same = await this.sameWorkoutNearby((await this.repo.session(session.id))!, heads, patch.activity);
        if (same) { await this.merge(session.id, same.id); merged = same.ref; }
      }
    }
    return { ...(await this.get(session.id)), also_changed: also.sort(), merged };
  }

  async remove(idOrRef: string): Promise<{ deleted: string }> {
    const session = await this.repo.session(idOrRef);
    if (!session) throw AppError.notFound('No benchmark session with that id or reference');
    await this.repo.deleteSession(session.id);
    await this.deleteFiles(session.screenshots);
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
      await this.deleteFiles(session.screenshots);
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
    utc_offset_min: s.utc_offset_min, devices: s.devices, summary: s.summary, notes: s.notes, screenshots: s.screenshots ?? [], is_test: s.is_test,
    firmware_version: s.firmware_version, app_version: s.app_version, platform: s.platform,
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
