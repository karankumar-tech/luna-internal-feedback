import { describe, expect, it } from 'vitest';
import { formatInZone, isValidCalendarDate, isValidTime12h, normalizeTime12h, todayInZone } from '../../src/lib/time.js';

describe('time_12h', () => {
  it.each(['10:45 PM', '7:05 AM', '07:05 AM', '12:00 AM', '12:59 PM', '7:05 pm'])('accepts %s', (v) => {
    expect(isValidTime12h(v)).toBe(true);
  });
  it.each(['13:00 PM', '00:30 AM', '10:60 PM', '10:45', '10:45pm', '10:45 P', '', '24:00 AM'])('rejects %s', (v) => {
    expect(isValidTime12h(v)).toBe(false);
  });
  it('normalises to zero-padded upper-case', () => {
    expect(normalizeTime12h('7:05 pm')).toBe('07:05 PM');
    expect(normalizeTime12h('10:45 PM')).toBe('10:45 PM');
  });
});

describe('calendar dates', () => {
  it.each(['2026-01-01', '2024-02-29', '2026-12-31'])('accepts %s', (v) => expect(isValidCalendarDate(v)).toBe(true));
  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '01-01-2026', 'yesterday'])('rejects %s', (v) => {
    expect(isValidCalendarDate(v)).toBe(false);
  });
});

describe('zone formatting', () => {
  it('formats an instant in IST with offset', () => {
    const instant = new Date('2026-09-02T07:42:22.554Z');
    expect(formatInZone(instant, 'Asia/Kolkata')).toBe('2026-09-02 13:12:22 +05:30');
  });
  it('computes today in IST across the UTC midnight boundary', () => {
    // 20:00 UTC on Sep 1 is 01:30 IST on Sep 2
    expect(todayInZone('Asia/Kolkata', new Date('2026-09-01T20:00:00Z'))).toBe('2026-09-02');
  });
});
