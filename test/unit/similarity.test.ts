import { describe, expect, it } from 'vitest';
import { compare, isShown, isSuggested, textSimilarity, trigrams, type Comparable } from '../../src/modules/similar/similarity.js';

const base: Comparable = {
  id: 'a', feature_key: 'sleep', issue_categories: ['incorrect_sleep'], tags: [], event_codes: [],
  text: 'Sleep start was recorded three hours late, I was asleep by 11 pm',
  firmware_version: '1.9.3', app_version: '2.4.0', platform: 'ios', occurred_on: '2026-09-10',
};
const other = (over: Partial<Comparable>): Comparable => ({ ...base, id: 'b', ...over });

describe('trigrams', () => {
  it('builds them the way pg_trgm does', () => {
    expect([...trigrams('word')].sort()).toEqual(['  w', ' wo', 'ord', 'rd ', 'wor']);
    // pg_trgm: similarity('word', 'words') = 4 shared / 7 total
    expect(textSimilarity('word', 'words')).toBeCloseTo(4 / 7, 5);
    expect(textSimilarity('Sleep LATE!', 'sleep late')).toBe(1);
    expect(textSimilarity('', 'anything')).toBe(0);
    expect(textSimilarity(null, 'anything')).toBe(0);
  });
});

describe('compare', () => {
  it('scores the same symptom highly and says why', () => {
    const m = compare(base, other({ text: 'Sleep start recorded 3 hours late, I slept at 11pm' }));
    const kinds = m.reasons.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['feature', 'categories', 'text', 'firmware', 'app', 'platform']));
    expect(m.substantive).toBe(true);
    expect(isShown(m)).toBe(true);
    expect(isSuggested(m)).toBe(true);
    expect(m.strength).toBeGreaterThan(0.5);
    expect(m.strength).toBeLessThanOrEqual(1);
  });

  it('labels categories with their display names when given', () => {
    const m = compare(base, other({}), { labelOf: (_f, c) => (c === 'incorrect_sleep' ? 'Incorrect sleep' : c) });
    expect(m.reasons.find((r) => r.kind === 'categories')!.label).toBe('Incorrect sleep');
  });

  it('does not match on "same screen, same build" alone', () => {
    const m = compare(base, other({ issue_categories: ['vitals_not_recorded'], text: 'Heart rate graph is empty all night' }));
    expect(m.substantive).toBe(false);
    expect(isShown(m)).toBe(false);
  });

  it('ignores category keys from a different feature', () => {
    const m = compare(base, other({ feature_key: 'workout', text: null }));
    expect(m.reasons.map((r) => r.kind)).not.toContain('categories');
    expect(isShown(m)).toBe(false);
  });

  it('counts shared diagnosis tags and catalog events', () => {
    const m = compare({ ...base, tags: ['sync_timeout', 'ble_disconnect'], event_codes: ['FW-01'] }, other({ tags: ['sync_timeout'], event_codes: ['FW-01', 'RL-07'], text: null }));
    expect(m.reasons.find((r) => r.kind === 'tags')!.label).toBe('sync_timeout');
    expect(m.reasons.find((r) => r.kind === 'events')!.label).toBe('FW-01');
  });

  it('loses up to a point as the dates drift apart', () => {
    const near = compare(base, other({}));
    const far = compare(base, other({ occurred_on: '2026-12-10' }));
    expect(near.score - far.score).toBeCloseTo(1, 5);
    const week = compare(base, other({ occurred_on: '2026-09-17' }));
    expect(near.score - week.score).toBeCloseTo(7 / 30, 2);
  });

  it('needs more than feature and category to suggest a problem on its own', () => {
    const m = compare(base, other({ text: 'Completely different words here', firmware_version: null, app_version: null, platform: null }));
    expect(isShown(m)).toBe(true);
    expect(isSuggested(m)).toBe(false);
  });
});
