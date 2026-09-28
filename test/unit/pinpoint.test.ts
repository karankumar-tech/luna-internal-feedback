import { describe, expect, it } from 'vitest';
import { compareVersions, isAtLeast, oldestVersion, parseVersion } from '../../src/lib/version.js';
import { isSpike, oldestVersions, regressionVerdict, spikeRatio, summarizeSkew } from '../../src/modules/kinds/pinpoint.js';
import type { SkewRow } from '../../src/modules/kinds/kinds.repo.js';

describe('versions', () => {
  it('reads the leading dotted number and ignores the rest', () => {
    expect(parseVersion('2.4.0')).toEqual([2, 4, 0]);
    expect(parseVersion('v2.4.0-beta')).toEqual([2, 4, 0]);
    expect(parseVersion('2.0.3.staging.luna')).toEqual([2, 0, 3]);
    expect(parseVersion('1.9.3 (312)')).toEqual([1, 9, 3]);
    expect(parseVersion('dev')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it('compares as numbers, so 1.10 is newer than 1.9, and missing parts are zero', () => {
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(compareVersions('2.4', '2.4.0')).toBe(0);
    expect(compareVersions('2.3.9', '2.4.0')).toBeLessThan(0);
    expect(compareVersions('dev', '2.4.0')).toBeNull();
    expect(isAtLeast('2.4.0', '2.4.0')).toBe(true);
    expect(isAtLeast(null, '2.4.0')).toBe(false);
    expect(oldestVersion(['2.10.0', 'dev', '2.9.1', null, '2.9.10'])).toBe('2.9.1');
  });
});

describe('spikes', () => {
  it('needs 3 reports, at 3× the usual rate', () => {
    expect(isSpike(3, 0)).toBe(true); // new and busy
    expect(isSpike(2, 0)).toBe(false); // too few
    expect(isSpike(3, 14)).toBe(false); // one a day is the usual three
    expect(isSpike(9, 14)).toBe(true); // three times that
    expect(isSpike(8, 14)).toBe(false);
    expect(spikeRatio(3, 2)).toBe(7);
    expect(spikeRatio(3, 0)).toBeNull();
  });
});

describe('regressions', () => {
  const fix = (app: string | null, fw: string | null) => ({ fixed_in_app_version: app, fixed_in_firmware_version: fw });
  const ran = (app: string | null, fw: string | null) => ({ app_version: app, firmware_version: fw });

  it('flags a report on the fix version or later', () => {
    expect(regressionVerdict(fix('2.4.0', null), ran('2.4.0', null))?.reason).toBe('Reported on app 2.4.0 (fixed in 2.4.0)');
    expect(regressionVerdict(fix('2.4.0', null), ran('2.10.1', '1.0'))).not.toBeNull();
    expect(regressionVerdict(fix(null, '1.9.4'), ran(null, '1.9.5'))?.reason).toBe('Reported on firmware 1.9.5 (fixed in 1.9.4)');
  });

  it('never flags an older version, a missing or unreadable one, or a problem with no fix version', () => {
    expect(regressionVerdict(fix('2.4.0', null), ran('2.3.9', null))).toBeNull();
    expect(regressionVerdict(fix('2.4.0', null), ran(null, '9.9'))).toBeNull();
    expect(regressionVerdict(fix('2.4.0', null), ran('dev', null))).toBeNull();
    expect(regressionVerdict(fix(null, null), ran('9.0', '9.0'))).toBeNull();
  });

  it('with both fix versions set, needs both to be met', () => {
    expect(regressionVerdict(fix('2.4.0', '1.9.4'), ran('2.5.0', '1.9.3'))).toBeNull();
    expect(regressionVerdict(fix('2.4.0', '1.9.4'), ran('2.5.0', null))).toBeNull();
    expect(regressionVerdict(fix('2.4.0', '1.9.4'), ran('2.5.0', '1.9.4'))?.reason).toBe('Reported on app 2.5.0 (fixed in 2.4.0) and firmware 1.9.4 (fixed in 1.9.4)');
  });
});

describe('where it happens', () => {
  const row = (dim: SkewRow['dim'], value: string, kind: number, base: number): SkewRow => ({ dim, value, kind_count: kind, base_count: base });

  it('compares shares, and headlines the most over-represented value that covers most of the problem', () => {
    const out = summarizeSkew([
      row('firmware', '1.9.3', 5, 10), row('firmware', '1.9.2', 1, 20),
      row('platform', 'ios', 3, 15), row('platform', 'android', 3, 15),
    ]);
    const fw = out.dims.find((d) => d.dim === 'firmware')!;
    expect(fw.kind_known).toBe(6);
    expect(fw.values[0]).toMatchObject({ value: '1.9.3', kind_count: 5, kind_share: 0.83, base_share: 0.33, ratio: 2.5, notable: true });
    expect(fw.values[1]).toMatchObject({ value: '1.9.2', notable: false });
    expect(out.dims.find((d) => d.dim === 'platform')!.values.every((v) => !v.notable)).toBe(true);
    expect(out.headline).toMatchObject({ dim: 'firmware', value: '1.9.3' });
  });

  it('calls nothing out below 3 reports', () => {
    const out = summarizeSkew([row('firmware', '9.9.9', 2, 2), row('firmware', '1.0.0', 0, 40)]);
    expect(out.dims.find((d) => d.dim === 'firmware')!.values[0]!.notable).toBe(false);
    expect(out.headline).toBeNull();
  });

  it('finds the oldest firmware, and the oldest app version per platform', () => {
    expect(oldestVersions([
      { platform: 'ios', app_version: '2.4.0', firmware_version: '1.9.3' },
      { platform: 'ios', app_version: '2.10.0', firmware_version: '1.10.0' },
      { platform: 'android', app_version: '1.8.2', firmware_version: null },
    ])).toEqual({ firmware: '1.9.3', app: [{ platform: 'ios', version: '2.4.0' }, { platform: 'android', version: '1.8.2' }] });
  });
});
