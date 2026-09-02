import { describe, expect, it } from 'vitest';
import { buildSubmissionValidator, zodIssues } from '../../src/schema/buildValidator.js';
import { FEATURE_KEYS, FEATURE_DEFINITIONS, COMMON_FIELDS } from '../../src/schema/registry.js';

const NOW = new Date('2026-09-02T10:00:00Z'); // 15:30 IST, Sep 2
const ctx = (categoryKeys: string[]) => ({ categoryKeys, timeZone: 'Asia/Kolkata', now: NOW });

const base = {
  is_positive: false,
  occurred_on: '2026-09-01',
  user_id: 10482,
  email: 'tester@luna.app',
  issue_categories: ['cat_a'],
  feedback_text: 'Something was off.',
};

function issuesOf(feature: (typeof FEATURE_KEYS)[number], body: unknown, cats = ['cat_a', 'cat_b']) {
  const r = buildSubmissionValidator(feature, ctx(cats)).safeParse(body);
  return r.success ? [] : zodIssues(r.error);
}

describe('registry sanity', () => {
  it('every feature has fields with unique keys and no overlap with common fields', () => {
    const common = new Set(COMMON_FIELDS.map((f) => f.key));
    for (const k of FEATURE_KEYS) {
      const keys = FEATURE_DEFINITIONS[k].fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) expect(common.has(key)).toBe(false);
    }
  });
});

describe('common fields', () => {
  it('accepts a minimal valid body for every feature', () => {
    for (const k of FEATURE_KEYS) expect(issuesOf(k, base)).toEqual([]);
  });

  it('requires the mandatory fields', () => {
    const paths = issuesOf('home', {}).map((i) => i.path).sort();
    expect(paths).toEqual(['email', 'is_positive', 'issue_categories', 'occurred_on', 'user_id']);
  });

  it('rejects unknown top-level keys', () => {
    expect(issuesOf('home', { ...base, rating: 5 })[0]?.message).toMatch(/unrecognized/i);
  });

  it('rejects feedback_text over 500 chars', () => {
    expect(issuesOf('home', { ...base, feedback_text: 'x'.repeat(501) })).toEqual([
      { path: 'feedback_text', message: 'must be at most 500 characters' },
    ]);
  });

  it('rejects future occurred_on relative to IST today', () => {
    expect(issuesOf('home', { ...base, occurred_on: '2026-09-03' })[0]?.message).toMatch(/future/);
    expect(issuesOf('home', { ...base, occurred_on: '2026-09-02' })).toEqual([]);
  });

  it('rejects impossible dates', () => {
    expect(issuesOf('home', { ...base, occurred_on: '2026-02-30' })[0]?.path).toBe('occurred_on');
  });

  it('validates user_id as a positive integer', () => {
    expect(issuesOf('home', { ...base, user_id: 0 })[0]?.path).toBe('user_id');
    expect(issuesOf('home', { ...base, user_id: 1.5 })[0]?.path).toBe('user_id');
    expect(issuesOf('home', { ...base, user_id: '123' })[0]?.path).toBe('user_id');
  });

  it('validates email', () => {
    expect(issuesOf('home', { ...base, email: 'not-an-email' })[0]?.path).toBe('email');
  });

  it('requires at least one category and rejects unknown/duplicate ones', () => {
    expect(issuesOf('home', { ...base, issue_categories: [] })[0]?.message).toBe('select at least one');
    expect(issuesOf('home', { ...base, issue_categories: ['nope'] })[0]).toEqual({ path: 'issue_categories.0', message: 'unknown category "nope"' });
    expect(issuesOf('home', { ...base, issue_categories: ['cat_a', 'cat_a'] })[0]?.message).toMatch(/duplicate/);
  });

  it('uses the live category list passed in', () => {
    expect(issuesOf('home', { ...base, issue_categories: ['fresh'] }, ['fresh'])).toEqual([]);
  });
});

describe('home', () => {
  it('bounds peak_score_value to 0-100', () => {
    expect(issuesOf('home', { ...base, details: { peak_score_value: 100 } })).toEqual([]);
    expect(issuesOf('home', { ...base, details: { peak_score_value: 101 } })[0]).toEqual({ path: 'details.peak_score_value', message: 'must be <= 100' });
    expect(issuesOf('home', { ...base, details: { peak_score_value: -1 } })[0]?.message).toBe('must be >= 0');
  });
  it('rejects fields from other features', () => {
    expect(issuesOf('home', { ...base, details: { steps: 100 } })[0]?.path).toBe('details');
  });
});

describe('sleep', () => {
  it('accepts and normalises 12h times', () => {
    const r = buildSubmissionValidator('sleep', ctx(['cat_a'])).safeParse({
      ...base,
      details: { actual_start_time: '11:30 pm', actual_end_time: '6:45 AM' },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.details).toEqual({ actual_start_time: '11:30 PM', actual_end_time: '06:45 AM' });
  });
  it('rejects bad time formats', () => {
    expect(issuesOf('sleep', { ...base, details: { recorded_start_time: '13:00 PM' } })[0]?.path).toBe('details.recorded_start_time');
  });
  it('rejects identical start and end on the same pair', () => {
    expect(issuesOf('sleep', { ...base, details: { actual_start_time: '10:00 PM', actual_end_time: '10:00 PM' } })[0]).toEqual({
      path: 'details.actual_end_time',
      message: 'must differ from actual_start_time',
    });
  });
  it('allows crossing midnight (no ordering check)', () => {
    expect(issuesOf('sleep', { ...base, details: { actual_start_time: '11:00 PM', actual_end_time: '06:00 AM' } })).toEqual([]);
  });
});

describe('activity', () => {
  it('requires integer steps and non-negative calories', () => {
    expect(issuesOf('activity', { ...base, details: { steps: 1234.5 } })[0]?.message).toBe('must be a whole number');
    expect(issuesOf('activity', { ...base, details: { active_calories: -3 } })[0]?.message).toBe('must be >= 0');
    expect(issuesOf('activity', { ...base, details: { steps: 8000, active_calories: 412.5, total_calories: 2100 } })).toEqual([]);
  });
});

describe('workout', () => {
  it('accepts free-text type and intensity with times', () => {
    expect(issuesOf('workout', { ...base, details: { workout_type: 'Run', intensity: 'high', start_time: '6:00 AM', end_time: '6:45 AM' } })).toEqual([]);
  });
  it('rejects identical start/end', () => {
    expect(issuesOf('workout', { ...base, details: { start_time: '6:00 AM', end_time: '06:00 AM' } })[0]?.path).toBe('details.end_time');
  });
});

describe('client context', () => {
  it('accepts known keys and rejects unknown ones', () => {
    expect(issuesOf('home', { ...base, client: { app_version: '2.4.0', firmware_version: '1.9.2' } })).toEqual([]);
    expect(issuesOf('home', { ...base, client: { imei: 'x' } })[0]?.path).toBe('client');
  });
  it('accepts platform ios/android case-insensitively and rejects others', () => {
    const r = buildSubmissionValidator('home', ctx(['cat_a'])).safeParse({ ...base, client: { platform: 'iOS' } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.client?.platform).toBe('ios');
    expect(issuesOf('home', { ...base, client: { platform: 'android' } })).toEqual([]);
    expect(issuesOf('home', { ...base, client: { platform: 'web' } })[0]).toEqual({ path: 'client.platform', message: 'must be one of: ios, android' });
  });
});
