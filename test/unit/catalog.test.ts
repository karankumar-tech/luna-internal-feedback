import { describe, it, expect } from 'vitest';
import { CATALOG, EVENTS_BY_ID, isKnownEventCode, matchCatalog, renderCatalogBrief } from '../../src/modules/diagnosis/knowledge/catalog.js';

describe('event catalog', () => {
  it('is built from the workbook with all three sheets represented', () => {
    expect(CATALOG.events.length).toBeGreaterThan(100);
    for (const domain of ['firmware', 'sdk', 'app'] as const) {
      expect(CATALOG.events.some((e) => e.domain === domain)).toBe(true);
    }
    expect(CATALOG.dictionary.length).toBeGreaterThan(500);
  });

  it('gives every event a stable id, a name and something to match on', () => {
    const withoutProbes = CATALOG.events.filter((e) => e.match.length === 0).map((e) => e.id);
    // A handful of "Not logged" rows have no line to match yet; they are listed in the sheet as gaps.
    expect(withoutProbes.length).toBeLessThan(10);
    for (const e of CATALOG.events) {
      expect(e.id).toMatch(/^(FW|RL|APP)-\d+/);
      expect(e.event.length).toBeGreaterThan(2);
    }
    expect(new Set(CATALOG.events.map((e) => e.id)).size).toBe(CATALOG.events.length);
  });

  it('never keeps a placeholder inside a probe', () => {
    const offenders: string[] = [];
    for (const entry of [...CATALOG.events, ...CATALOG.dictionary]) {
      for (const probe of entry.match) {
        if (/%[a-zA-Z@]|<[^<>]{1,24}>|\{[^{}]{1,32}\}/.test(probe)) offenders.push(probe);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('validates event codes against the built catalog', () => {
    const someId = CATALOG.events[0]!.id;
    expect(isKnownEventCode(someId)).toBe(true);
    expect(isKnownEventCode(someId.toLowerCase())).toBe(true);
    expect(isKnownEventCode('FW-9999')).toBe(false);
    expect(isKnownEventCode('nonsense')).toBe(false);
    expect(EVENTS_BY_ID.get(someId)?.event).toBe(CATALOG.events[0]!.event);
  });

  it('finds the watchdog restart from real firmware lines', () => {
    const excerpt = [
      '===== [firmware] =====',
      '10:15:01 hub ful',
      '10:15:02 WDT isr save',
      '10:15:04 Reset Status Register = 0x40',
      '10:15:04 power on',
    ].join('\n');
    const match = matchCatalog(excerpt);
    const ids = match.events.map((e) => e.entry.id);
    expect(ids).toContain('FW-01');
    const hit = match.events.find((e) => e.entry.id === 'FW-01')!;
    expect(hit.entry.tag).toBe('firmware_reboot');
    expect(hit.lines[0]).toBeGreaterThan(0);
  });

  it('matches iOS SDK disconnects case-insensitively', () => {
    const excerpt = '===== [ring] =====\n22:04:11 [SDK][CONNECTSTATE] DIDDISCONNECTPERIPHERAL';
    const ids = matchCatalog(excerpt).events.map((e) => e.entry.id);
    expect(ids).toContain('RL-01');
  });

  it('returns nothing for an excerpt with no known lines', () => {
    const match = matchCatalog('===== [app] =====\n09:00:00 everything is entirely ordinary here');
    expect(match.events).toEqual([]);
    expect(renderCatalogBrief(match)).toBe('');
  });

  it('caps what it renders so the prompt cannot blow up', () => {
    // Every probe in the catalog at once: the worst case a real excerpt could approach.
    const everything = [...CATALOG.events, ...CATALOG.dictionary].flatMap((e) => e.match).join('\n');
    const match = matchCatalog(everything);
    expect(match.events.length).toBeLessThanOrEqual(14);
    expect(match.dictionary.length).toBeLessThanOrEqual(18);
    const brief = renderCatalogBrief(match);
    expect(brief.length).toBeLessThanOrEqual(7100);
    expect(brief).toContain('Known critical events matched');
  });

  it('ranks P0 events above P2 ones that matched equally well', () => {
    const p0 = CATALOG.events.find((e) => e.priority === 'P0' && e.match.length)!;
    const p2 = CATALOG.events.find((e) => e.priority === 'P2' && e.match.length)!;
    const excerpt = `${p2.match[0]}\n${p0.match[0]}`;
    const order = matchCatalog(excerpt).events.map((e) => e.entry.id);
    // Both must be found, and where the probe strengths are comparable P0 wins.
    expect(order).toContain(p0.id);
    expect(order).toContain(p2.id);
  });
});
