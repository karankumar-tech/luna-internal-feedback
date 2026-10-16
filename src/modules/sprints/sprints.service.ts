import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { todayInZone } from '../../lib/time.js';
import { compareVersions, parseVersion } from '../../lib/version.js';
import { PLATFORMS, type Platform } from '../../schema/registry.js';
import { parseSubmissionRef, type Screenshot } from '../feedback/feedback.repo.js';
import { CARRIED_NOTE, type SprintCounts, type SprintRow, type SprintsRepo } from './sprints.repo.js';
import { daysBetween, defaultName, halfLabel, halfOf, parseSprintRef, rangeLabel, refFor, sprintAfter, timing } from './cycle.js';

/** What a report carries about its sprint. */
export interface SprintSummary { id: string; ref: string; name: string; status: SprintRow['status'] }

/** Where a carried-over issue goes: the next sprint, back to the main list, or another planned sprint. */
export type CloseDestination = 'next' | 'main' | string;

const MAX_DAYS = 62;

/**
 * A sprint's issues by platform (iOS, Android, Backend, Firmware, then reports that did not say) and the
 * app versions they came from, newest first, each with the platforms that sent it.
 */
export function splitBuilds(rows: { platform: string | null; app_version: string | null; open: number; done: number }[]) {
  const platforms = new Map<string | null, { platform: string | null; open: number; done: number }>();
  const versions = new Map<string, { app_version: string; platforms: string[]; issues: number }>();
  for (const r of rows) {
    const p = platforms.get(r.platform) ?? { platform: r.platform, open: 0, done: 0 };
    p.open += r.open; p.done += r.done; platforms.set(r.platform, p);
    if (!r.app_version) continue;
    const v = versions.get(r.app_version) ?? { app_version: r.app_version, platforms: [], issues: 0 };
    v.issues += r.open + r.done;
    if (r.platform && !v.platforms.includes(r.platform)) v.platforms.push(r.platform);
    versions.set(r.app_version, v);
  }
  const rank = (p: string | null) => { const i = PLATFORMS.indexOf(p as Platform); return i >= 0 ? i : p ? PLATFORMS.length : PLATFORMS.length + 1; };
  return {
    by_platform: [...platforms.values()].sort((a, b) => rank(a.platform) - rank(b.platform) || String(a.platform).localeCompare(String(b.platform))),
    app_versions: [...versions.values()]
      .map((v) => ({ ...v, platforms: v.platforms.sort((a, b) => rank(a) - rank(b)) }))
      .sort((a, b) => (compareVersions(b.app_version, a.app_version) ?? (parseVersion(a.app_version) ? -1 : parseVersion(b.app_version) ? 1 : a.app_version.localeCompare(b.app_version)))),
  };
}
const summary = (s: SprintRow): SprintSummary => ({ id: s.id, ref: s.ref, name: s.name, status: s.status });

export class SprintsService {
  /** Screenshot cleanup for deleted reports, wired when ImageKit is configured. */
  private deleteFile: ((fileId: string) => Promise<boolean>) | null = null;

  constructor(
    private readonly repo: SprintsRepo,
    private readonly timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  setScreenshotCleanup(fn: ((fileId: string) => Promise<boolean>) | null) { this.deleteFile = fn; }

  today(): string { return todayInZone(this.timeZone, this.now()); }

  // ---------- reading ----------

  toDto(s: SprintRow, ctx: { today: string; currentId: string | null; nextId: string | null; counts?: SprintCounts }) {
    const c = ctx.counts;
    const blocked = s.status === 'active' ? `${s.ref} is the current sprint. Close it first.`
      : c && c.open_with_test > 0 ? `${c.open_with_test} ${c.open_with_test === 1 ? 'issue is' : 'issues are'} still open in it. Move ${c.open_with_test === 1 ? 'it' : 'them'} or close the sprint first.`
        : null;
    const { open_with_test: _skip, ...counts } = c ?? { open_with_test: 0 };
    return {
      id: s.id, ref: s.ref, name: s.name, goal: s.goal,
      starts_on: s.starts_on, ends_on: s.ends_on, range: rangeLabel(s.starts_on, s.ends_on),
      status: s.status, is_current: s.id === ctx.currentId, is_next: s.id === ctx.nextId,
      ...timing(s, ctx.today),
      created_by: s.created_by, created_at: s.created_at.toISOString(),
      closed_by: s.closed_by, closed_at: s.closed_at ? s.closed_at.toISOString() : null,
      ...(c ? { counts } : {}),
      /** Why it cannot be deleted, whoever asks; null when it can be (by someone allowed to delete). */
      delete_blocked_by: blocked,
    };
  }

  private async context(q?: pg.PoolClient) {
    const current = await this.repo.active(q);
    const next = current ? await this.repo.plannedAfter(current.starts_on, q) : undefined;
    return { today: this.today(), current, next };
  }

  /** Every sprint, newest first, with its counts. */
  async list() {
    const [{ today, current, next }, rows, counts] = await Promise.all([this.context(), this.repo.all(), this.repo.counts()]);
    const ctx = { today, currentId: current?.id ?? null, nextId: next?.id ?? null };
    return {
      today,
      current: current?.ref ?? null,
      next: next?.ref ?? null,
      items: rows.map((s) => this.toDto(s, { ...ctx, counts: counts.get(s.id) })),
    };
  }

  /** A sprint by reference, or "current" / "next". */
  async find(refOrAlias: string): Promise<SprintRow> {
    const key = refOrAlias.trim().toLowerCase();
    if (key === 'current' || key === 'next') {
      const { current, next } = await this.context();
      const s = key === 'current' ? current : next;
      if (!s) throw AppError.notFound(key === 'current' ? 'There is no current sprint' : 'No sprint is planned after the current one');
      return s;
    }
    const ref = parseSprintRef(refOrAlias);
    if (!ref) throw AppError.validation([{ path: 'ref', message: 'must look like SPR-202610-01, or be "current" or "next"' }]);
    const s = await this.repo.byRef(ref);
    if (!s) throw AppError.notFound(`No sprint ${ref}`);
    return s;
  }

  /** One sprint with everything its page shows. `me`: the viewer's email, for "Mine". */
  async get(refOrAlias: string, me: string | null) {
    const s = await this.find(refOrAlias);
    const [{ today, current, next }, all, counts, byFeature, builds, perDay, mine] = await Promise.all([
      this.context(), this.repo.all(), this.repo.counts([s.id]), this.repo.byFeature(s.id), this.repo.byBuild(s.id), this.repo.perDay(s), me ? this.repo.mineOpen(s.id, me) : Promise.resolve(0),
    ]);
    const ordered = [...all].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    const i = ordered.findIndex((x) => x.id === s.id);
    return {
      ...this.toDto(s, { today, currentId: current?.id ?? null, nextId: next?.id ?? null, counts: counts.get(s.id) }),
      today,
      mine_open: mine,
      by_feature: byFeature,
      ...splitBuilds(builds),
      per_day: perDay,
      /** What the next sprint is or will be called, for "close it to start …". */
      follows: next && current && s.id === current.id ? next.ref : sprintAfter(s.ends_on).ref,
      prev: ordered[i - 1]?.ref ?? null,
      after: ordered[i + 1]?.ref ?? null,
    };
  }

  /**
   * The two choices the app offers. Never writes: when nothing is planned yet, `next` describes the
   * sprint that filing into "next" (or closing the current one) will create.
   */
  async options() {
    const { today, current, next } = await this.context();
    const one = (s: { ref: string; name: string; starts_on: string; ends_on: string; status: string }, planned: boolean) => {
      const t = timing(s, today);
      return { ref: s.ref, name: s.name, starts_on: s.starts_on, ends_on: s.ends_on, range: rangeLabel(s.starts_on, s.ends_on), days_left: t.days_left, overdue_days: t.overdue_days, exists: planned };
    };
    return {
      current: current ? one(current, true) : null,
      next: next ? one(next, true) : current ? one({ ...sprintAfter(current.ends_on), status: 'planned' }, false) : null,
    };
  }

  /** The current sprint and its open real issues, for the Reports page's hint. */
  async currentSummary(): Promise<{ ref: string; name: string; open: number } | null> {
    const current = await this.repo.active();
    if (!current) return null;
    const c = (await this.repo.counts([current.id])).get(current.id);
    return { ref: current.ref, name: current.name, open: c?.open ?? 0 };
  }

  // ---------- resolving targets (filing, moving) ----------

  /** "current", "next" (created when nothing is planned) or a reference. */
  async resolve(target: string, by: string | null): Promise<SprintSummary> {
    const key = target.trim().toLowerCase();
    if (key === 'current') {
      const s = await this.repo.active();
      if (!s) throw AppError.conflict('There is no current sprint');
      return summary(s);
    }
    if (key === 'next') return summary(await this.ensureNext(by));
    const ref = parseSprintRef(target);
    if (!ref) throw AppError.validation([{ path: 'sprint', message: 'must be "current", "next" or a sprint reference like SPR-202610-01' }]);
    const s = await this.repo.byRef(ref);
    if (!s) throw AppError.notFound(`No sprint ${ref}`);
    return summary(s);
  }

  async byId(id: string): Promise<SprintSummary | null> {
    const s = await this.repo.byId(id);
    return s ? summary(s) : null;
  }

  /** The planned sprint after the current one, created for the following half month when there is none. */
  async ensureNext(_by: string | null, q?: pg.PoolClient): Promise<SprintRow> {
    const current = await this.repo.active(q);
    if (!current) throw AppError.conflict('There is no current sprint');
    const found = await this.repo.plannedAfter(current.starts_on, q);
    if (found) return found;
    const latest = (await this.repo.latest(q)) ?? current;
    const spec = sprintAfter(latest.ends_on);
    try {
      // Made by the system on someone's behalf (a report filed into "next", or a close); `by` is in the history of what triggered it.
      return await this.repo.insert({ ...spec, goal: null, status: 'planned', by: 'system' }, q);
    } catch (err) {
      // Two reports asking for "next" at once: the other one made it.
      if ((err as { code?: string }).code === '23505' && !q) {
        const again = await this.repo.plannedAfter(current.starts_on);
        if (again) return again;
      }
      throw err;
    }
  }

  // ---------- writing ----------

  private checkDates(starts: string, ends: string) {
    if (ends < starts) throw AppError.validation([{ path: 'ends_on', message: 'must not be before starts_on' }]);
    if (daysBetween(starts, ends) > MAX_DAYS) throw AppError.validation([{ path: 'ends_on', message: 'a sprint can be at most two months long' }]);
  }

  private async checkOverlap(starts: string, ends: string, exceptId: string | null, q?: pg.PoolClient) {
    const clash = (await this.repo.overlapping(starts, ends, exceptId, q))[0];
    if (clash) throw AppError.validation([{ path: 'starts_on', message: `overlaps ${clash.ref} (${rangeLabel(clash.starts_on, clash.ends_on)})` }]);
  }

  /**
   * A new sprint. Without dates it takes the next free half month after the last sprint. It starts as
   * planned and becomes current when the sprint before it closes (or at once when there is no current one).
   */
  async create(input: { starts_on?: string; ends_on?: string; name?: string; goal?: string | null }, by: string | null) {
    return this.repo.tx(async (q) => {
      await q.query('lock table luna_feedback.sprints in share row exclusive mode');
      const current = await this.repo.active(q);
      const latest = await this.repo.latest(q);
      const dflt = latest ? sprintAfter(latest.ends_on) : (() => { const h = halfOf(this.today()); return { starts_on: h.starts_on, ends_on: h.ends_on }; })();
      const starts = input.starts_on ?? dflt.starts_on;
      const ends = input.ends_on ?? (input.starts_on ? halfOf(input.starts_on).ends_on : dflt.ends_on);
      this.checkDates(starts, ends);
      if (current && starts <= current.starts_on) {
        throw AppError.validation([{ path: 'starts_on', message: `must be after the current sprint, ${current.ref}, begins: past sprints can't be added` }]);
      }
      const h = halfOf(starts);
      const ref = refFor(h);
      if (await this.repo.byRef(ref, q)) throw AppError.validation([{ path: 'starts_on', message: `${ref} already exists: one sprint can start in each half month` }]);
      await this.checkOverlap(starts, ends, null, q);
      const row = await this.repo.insert({
        ref, name: input.name?.trim() || defaultName(h), goal: input.goal?.trim() || null,
        starts_on: starts, ends_on: ends, status: current ? 'planned' : 'active', by,
      }, q);
      return row;
    }).then((row) => this.get(row.ref, null));
  }

  /** Rename, set the goal, or move the dates of a sprint that is not closed. */
  async update(refOrAlias: string, input: { name?: string; goal?: string | null; starts_on?: string; ends_on?: string }) {
    const s = await this.find(refOrAlias);
    const row = await this.repo.tx(async (q) => {
      await q.query('lock table luna_feedback.sprints in share row exclusive mode');
      const cur = await this.repo.byRef(s.ref, q, true);
      if (!cur) throw AppError.notFound(`No sprint ${s.ref}`);
      if (cur.status === 'closed') throw AppError.conflict(`${cur.ref} is closed and can't be edited`);
      const starts = input.starts_on ?? cur.starts_on;
      const ends = input.ends_on ?? cur.ends_on;
      if (cur.status === 'active' && starts !== cur.starts_on) throw AppError.validation([{ path: 'starts_on', message: 'is fixed once the sprint is current' }]);
      if (refFor(halfOf(starts)) !== cur.ref) {
        throw AppError.validation([{ path: 'starts_on', message: `must stay in ${halfLabel(halfOf(cur.starts_on))}, so the reference stays ${cur.ref}` }]);
      }
      this.checkDates(starts, ends);
      await this.checkOverlap(starts, ends, cur.id, q);
      return this.repo.update(cur.id, {
        name: input.name !== undefined ? input.name.trim() : cur.name,
        goal: input.goal !== undefined ? (input.goal?.trim() || null) : cur.goal,
        starts_on: starts, ends_on: ends,
      }, q);
    });
    return this.get(row.ref, null);
  }

  /**
   * Closes the current sprint. Its open issues go where asked (by default the next sprint), the next
   * sprint becomes current, and a new next is planned if none is. All in one transaction.
   */
  async close(refOrAlias: string, input: { default: 'next' | 'main'; overrides?: Record<string, CloseDestination> }, by: string | null) {
    const target = await this.find(refOrAlias);
    const out = await this.repo.tx(async (q) => {
      await q.query('lock table luna_feedback.sprints in share row exclusive mode');
      const s = await this.repo.byRef(target.ref, q, true);
      if (!s || s.status !== 'active') throw AppError.conflict('Only the current sprint can be closed');
      const next = await this.ensureNext(by, q);
      const open = await this.repo.openIssues(s.id, q, true);

      // Work out every destination before moving anything, so a bad override changes nothing.
      const byKey = new Map<string, (typeof open)[number]>();
      for (const o of open) { byKey.set(o.id, o); byKey.set(String(Number(o.ref_no)), o); }
      const others = new Map<string, SprintRow>();
      const dest = new Map<string, SprintRow | null>();
      for (const o of open) dest.set(o.id, input.default === 'main' ? null : next);
      for (const [key, to] of Object.entries(input.overrides ?? {})) {
        const n = z.string().uuid().safeParse(key).success ? key : parseSubmissionRef(key);
        const issue = n === null ? undefined : byKey.get(String(n));
        if (!issue) throw AppError.validation([{ path: `overrides.${key}`, message: `is not an open issue in ${s.ref}` }]);
        if (to === 'next') { dest.set(issue.id, next); continue; }
        if (to === 'main') { dest.set(issue.id, null); continue; }
        const ref = parseSprintRef(to);
        const other = ref ? others.get(ref) ?? await this.repo.byRef(ref, q) : undefined;
        if (!other || other.status !== 'planned') throw AppError.validation([{ path: `overrides.${key}`, message: 'must be "next", "main" or a planned sprint' }]);
        others.set(other.ref, other);
        dest.set(issue.id, other);
      }

      const moved: { ref: string; to: string | null }[] = [];
      for (const o of open) {
        const to = dest.get(o.id) ?? null;
        await this.repo.moveIssue(o.id, to?.id ?? null, { actor: by, from: s.ref, to: to?.ref ?? null, note: `${CARRIED_NOTE} ${s.ref} closed` }, q);
        moved.push({ ref: o.ref, to: to?.ref ?? null });
      }
      const closed = await this.repo.markClosed(s.id, by, q);
      const current = await this.repo.markActive(next.id, q);
      const following = await this.ensureNext(by, q);
      return { closed, current, following, moved };
    });
    const tally = (pred: (m: { to: string | null }) => boolean) => out.moved.filter(pred).length;
    return {
      closed: out.closed.ref,
      current: out.current.ref,
      next: out.following.ref,
      moved: out.moved,
      to_next: tally((m) => m.to === out.current.ref),
      to_main: tally((m) => m.to === null),
      to_other: tally((m) => m.to !== null && m.to !== out.current.ref),
    };
  }

  /**
   * Deletes a sprint and the issues in it, for good. Only when it is not the current sprint and
   * nothing in it is open; `confirm` must repeat the reference. Screenshots are removed afterwards,
   * best effort; Jira is not touched.
   */
  async remove(refOrAlias: string, confirm: string | undefined) {
    const target = await this.find(refOrAlias);
    if ((confirm ?? '').trim().toUpperCase() !== target.ref) {
      throw AppError.validation([{ path: 'confirm', message: `type ${target.ref} to delete it` }]);
    }
    const out = await this.repo.tx(async (q) => {
      const s = await this.repo.byRef(target.ref, q, true);
      if (!s) throw AppError.notFound(`No sprint ${target.ref}`);
      if (s.status === 'active') throw AppError.conflict(`${s.ref} is the current sprint. Close it first`);
      const { open } = await this.repo.countAll(s.id, q);
      if (open > 0) throw AppError.conflict(`${open} ${open === 1 ? 'issue' : 'issues'} in ${s.ref} ${open === 1 ? 'is' : 'are'} still open. Move them first`);
      return this.repo.deleteWithIssues(s.id, q);
    });
    await this.cleanup(out.screenshots);
    return { ref: target.ref, deleted_issues: out.deleted };
  }

  private async cleanup(screenshots: Screenshot[]) {
    if (!this.deleteFile) return;
    // Sequential, to respect ImageKit's rate limits; failures are ignored like deleteTestData's.
    for (const s of screenshots) if (s.file_id) await this.deleteFile(s.file_id).catch(() => false);
  }
}
