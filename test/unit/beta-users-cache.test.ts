import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/pool.js';
import { BetaUsersRepo } from '../../src/modules/beta/beta-users.repo.js';

/** A database that answers the list query with `ids`, counting calls; `fail` makes the next calls throw. */
function fakeDb(ids: number[]) {
  const state = { calls: 0, fail: false, ids };
  const db = {
    query: async () => {
      state.calls++;
      await Promise.resolve();
      if (state.fail) throw new Error('db down');
      return { rows: state.ids.map((id) => ({ user_id: String(id) })) };
    },
  } as unknown as Db;
  return { db, state };
}

afterEach(() => { vi.useRealTimers(); });

describe('the beta list cache', () => {
  it('reads the database once per TTL, however many checks', async () => {
    vi.useFakeTimers();
    const { db, state } = fakeDb([7, 8]);
    const repo = new BetaUsersRepo(db, 60_000);
    expect(await repo.has(7)).toBe(true);
    expect(await repo.has(9)).toBe(false);
    for (let i = 0; i < 50; i++) await repo.has(i);
    expect(state.calls).toBe(1);
    vi.advanceTimersByTime(60_001);
    state.ids = [9];
    expect(await repo.has(9)).toBe(true);
    expect(state.calls).toBe(2);
  });

  it('shares one load between checks that arrive together', async () => {
    const { db, state } = fakeDb([1]);
    const repo = new BetaUsersRepo(db, 60_000);
    const answers = await Promise.all([repo.has(1), repo.has(2), repo.has(1)]);
    expect(answers).toEqual([true, false, true]);
    expect(state.calls).toBe(1);
  });

  it('reloads straight after invalidate()', async () => {
    const { db, state } = fakeDb([1]);
    const repo = new BetaUsersRepo(db, 60_000);
    expect(await repo.has(2)).toBe(false);
    state.ids = [1, 2];
    repo.invalidate();
    expect(await repo.has(2)).toBe(true);
    expect(state.calls).toBe(2);
  });

  it('keeps answering from the copy it holds when a reload fails, and retries soon', async () => {
    vi.useFakeTimers();
    const { db, state } = fakeDb([5]);
    const errors: unknown[] = [];
    const repo = new BetaUsersRepo(db, 60_000, (err) => errors.push(err));
    expect(await repo.has(5)).toBe(true);
    vi.advanceTimersByTime(60_001);
    state.fail = true;
    expect(await repo.has(5)).toBe(true);
    expect(errors).toHaveLength(1);
    // Not hammered: the next try waits about 30 s, not a whole TTL and not zero.
    await repo.has(5);
    expect(state.calls).toBe(2);
    vi.advanceTimersByTime(30_001);
    state.fail = false; state.ids = [6];
    expect(await repo.has(6)).toBe(true);
    expect(state.calls).toBe(3);
  });

  it('fails the check when it has never loaded the list', async () => {
    const { db, state } = fakeDb([]);
    state.fail = true;
    await expect(new BetaUsersRepo(db, 60_000).has(1)).rejects.toThrow('db down');
  });
});
