import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, defaultName, halfOf, parseSprintRef, rangeLabel, refFor, sprintAfter, timing } from '../../src/modules/sprints/cycle.js';

describe('half months', () => {
  it('splits a month at the 15th', () => {
    expect(halfOf('2026-10-01')).toMatchObject({ half: 1, starts_on: '2026-10-01', ends_on: '2026-10-15' });
    expect(halfOf('2026-10-15')).toMatchObject({ half: 1, starts_on: '2026-10-01', ends_on: '2026-10-15' });
    expect(halfOf('2026-10-16')).toMatchObject({ half: 2, starts_on: '2026-10-16', ends_on: '2026-10-31' });
    expect(halfOf('2026-11-20')).toMatchObject({ half: 2, starts_on: '2026-11-16', ends_on: '2026-11-30' });
  });

  it('ends February on the 28th, or the 29th in a leap year', () => {
    expect(halfOf('2027-02-20').ends_on).toBe('2027-02-28');
    expect(halfOf('2028-02-20').ends_on).toBe('2028-02-29');
  });

  it('names and references a half', () => {
    expect(refFor(halfOf('2026-10-03'))).toBe('SPR-202610-01');
    expect(refFor(halfOf('2026-10-31'))).toBe('SPR-202610-02');
    expect(defaultName(halfOf('2026-10-03'))).toBe('Sprint · October 2026 · 01');
    expect(defaultName(halfOf('2027-01-20'))).toBe('Sprint · January 2027 · 02');
  });

  it('labels a date range', () => {
    expect(rangeLabel('2026-10-01', '2026-10-15')).toBe('1–15 Oct 2026');
    expect(rangeLabel('2026-12-16', '2027-01-02')).toBe('16 Dec – 2 Jan 2027');
  });
});

describe('the sprint after', () => {
  it('follows a first half with the second', () => {
    expect(sprintAfter('2026-10-15')).toEqual({ ref: 'SPR-202610-02', name: 'Sprint · October 2026 · 02', starts_on: '2026-10-16', ends_on: '2026-10-31' });
  });

  it('rolls over the month and the year', () => {
    expect(sprintAfter('2026-10-31')).toMatchObject({ ref: 'SPR-202611-01', starts_on: '2026-11-01', ends_on: '2026-11-15' });
    expect(sprintAfter('2026-12-31')).toMatchObject({ ref: 'SPR-202701-01', starts_on: '2027-01-01', ends_on: '2027-01-15' });
    expect(sprintAfter('2027-02-15')).toMatchObject({ ref: 'SPR-202702-02', starts_on: '2027-02-16', ends_on: '2027-02-28' });
  });

  it('after a stretched sprint, takes the rest of the half so nothing overlaps', () => {
    expect(sprintAfter('2026-10-18')).toMatchObject({ ref: 'SPR-202610-02', starts_on: '2026-10-19', ends_on: '2026-10-31' });
  });
});

describe('references', () => {
  it('accepts the usual spellings', () => {
    expect(parseSprintRef('SPR-202610-01')).toBe('SPR-202610-01');
    expect(parseSprintRef('spr-202610-1')).toBe('SPR-202610-01');
    expect(parseSprintRef(' SPR20261002 ')).toBe('SPR-202610-02');
  });

  it('refuses anything else', () => {
    for (const bad of ['SPR-202613-01', 'SPR-202610-03', 'LN-00042', 'current', '202610-01', '']) expect(parseSprintRef(bad)).toBeNull();
  });
});

describe('timing', () => {
  const oct1 = { starts_on: '2026-10-01', ends_on: '2026-10-15' };

  it('counts the days of the current sprint', () => {
    expect(timing({ ...oct1, status: 'active' }, '2026-10-14')).toEqual({ days: 15, day: 14, days_left: 1, overdue_days: 0, starts_in: 0 });
    expect(timing({ ...oct1, status: 'active' }, '2026-10-15')).toMatchObject({ day: 15, days_left: 0, overdue_days: 0 });
  });

  it('says how overdue a current sprint nobody closed is', () => {
    expect(timing({ ...oct1, status: 'active' }, '2026-10-17')).toMatchObject({ day: 15, days_left: null, overdue_days: 2 });
  });

  it('knows a current sprint that began early has not started yet', () => {
    expect(timing({ starts_on: '2026-10-16', ends_on: '2026-10-31', status: 'active' }, '2026-10-14')).toMatchObject({ days: 16, day: null, starts_in: 2, overdue_days: 0 });
  });

  it('gives planned sprints a countdown and closed ones nothing', () => {
    expect(timing({ starts_on: '2026-10-16', ends_on: '2026-10-31', status: 'planned' }, '2026-10-14')).toMatchObject({ day: null, days_left: null, starts_in: 2 });
    expect(timing({ ...oct1, status: 'closed' }, '2026-10-20')).toEqual({ days: 15, day: null, days_left: null, overdue_days: 0, starts_in: 0 });
  });

  it('does date arithmetic across months', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(daysBetween('2026-12-31', '2027-01-02')).toBe(2);
  });
});
