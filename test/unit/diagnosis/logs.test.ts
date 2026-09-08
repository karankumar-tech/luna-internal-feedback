import { describe, expect, it } from 'vitest';
import { normalizeEntry, toFileRefs } from '../../../src/modules/diagnosis/logs/client.js';
import { pickEntry, pickFiles } from '../../../src/modules/diagnosis/logs/select.js';
import { parseAppLog, parseFirmware, parseRingAndroid, parseRingIos, istToEpoch, epochToIst, collapseRepeats } from '../../../src/modules/diagnosis/logs/parse.js';
import { redact } from '../../../src/modules/diagnosis/logs/redact.js';
import { buildExcerpt, computeWindow } from '../../../src/modules/diagnosis/extract.js';
import type { ParsedFile } from '../../../src/modules/diagnosis/logs/types.js';

const U = (src: string, date: string, name: string) => `https://stage-s3.example.com/service-logging/stage/luna/logreport/${src}/778261-${date}/1786363705995_${name}`;

describe('list-botfetch normalisation', () => {
  it('splits comma-separated url lists and reads the date from the path', () => {
    const refs = toFileRefs('app', `${U('app_logs', '2026-08-10', 'appLogs.txt')},${U('app_logs', '2026-08-07', 'appLogs.txt')}, `);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ source: 'app', date: '2026-08-10' });
    expect(toFileRefs('firmware', '')).toEqual([]);
    expect(toFileRefs('firmware', undefined)).toEqual([]);
  });
  it('normalises an entry', () => {
    const e = normalizeEntry({ user_id: 778261, device_id: 1, fv: null, batt_perct: '84', platform: 'Android', version_name: '2.0.0', updated_at: '2026-08-10T12:08:26.000Z', app_logs: U('app_logs', '2026-08-10', 'appLogs.txt'), ring_logs: '', firmware_logs: '' });
    expect(e.platform).toBe('android');
    expect(e.fv).toBeNull();
    expect(e.batt_perct).toBe(84);
    expect(e.files.app).toHaveLength(1);
    expect(e.files.ring).toEqual([]);
  });
});

describe('entry and file selection', () => {
  const mk = (platform: string, updated: string, n = 1) => normalizeEntry({ platform, updated_at: updated, app_logs: Array.from({ length: n }, (_, i) => U('app_logs', `2026-08-0${i + 1}`, 'a.txt')).join(',') });
  it('prefers same platform, then uploads on/after the issue day', () => {
    const android = mk('android', '2026-08-10T00:00:00Z', 3);
    const ios = mk('ios', '2026-08-12T00:00:00Z', 1);
    expect(pickEntry([android, ios], { platform: 'ios', occurredOn: '2026-08-09' })).toBe(ios);
    expect(pickEntry([android, ios], { platform: null, occurredOn: '2026-08-09' })).toBe(android); // closer upload + more files
    expect(pickEntry([], { platform: 'ios', occurredOn: '2026-08-09' })).toBeNull();
  });
  it('picks one upload per source: the first dated on/after the issue day, else the day before', () => {
    const files = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10'].map((d) => ({ source: 'app' as const, url: U('app_logs', d, 'a.txt'), date: d }));
    expect(pickFiles(files, '2026-08-06').map((f) => f.date)).toEqual(['2026-08-06']);
    expect(pickFiles(files, '2026-08-08').map((f) => f.date)).toEqual(['2026-08-10']);   // nearest after, within +2
    expect(pickFiles(files, '2026-08-11').map((f) => f.date)).toEqual(['2026-08-10']);   // nothing after: day before
    expect(pickFiles(files, '2026-08-20')).toEqual([]);
    expect(pickFiles([{ source: 'app', url: 'https://x/y.txt', date: null }], '2026-08-20')).toHaveLength(1);
  });
});

describe('parsers', () => {
  it('IST conversion round-trips', () => {
    const ts = istToEpoch(2026, 8, 10, 17, 36, 48);
    expect(new Date(ts).toISOString()).toBe('2026-08-10T12:06:48.000Z');
    expect(epochToIst(ts)).toBe('2026-08-10 17:36:48');
  });
  it('summarises app log entries and keeps error detail', () => {
    const text = [
      '==============================================================================',
      '{ "success": true, "data": { "device_features": { "id": 2 } }, "message": "", "time": "1786098002676" }',
      '==============================================================================',
      '{ "success": false, "data": null, "message": "Session expired", "error": { "code": 401, "token": "abc123def" }, "time": "1786098012676" }',
      '==============================================================================',
    ].join('\n');
    const lines = parseAppLog(text, { source: 'app', url: 'x', date: '2026-08-07' });
    expect(lines).toHaveLength(3);
    expect(lines[0]!.text).toMatch(/^ok success=true data:\{device_features\}/);
    expect(lines[0]!.ts).toBe(1786098002676);
    expect(lines[1]!.text).toMatch(/^FAIL success=false message="Session expired"/);
    expect(lines[2]!.text).toContain('[REDACTED]');
    expect(lines[2]!.text).not.toContain('abc123def');
  });
  it('parses X-LOG lines inside app logs with real timestamps', () => {
    const text = '2026-08-10 17:28:19.008 I/X-LOG: ZhConnectHandler softDisconnect (keep binding)\n2026-08-10 17:28:19.039 E/X-LOG: Exception = 01 FF\nComment : Connected\n';
    const l = parseAppLog(text, { source: 'app', url: 'x', date: '2026-08-10' });
    expect(l).toHaveLength(3);
    expect(l[0]).toMatchObject({ approx: false, text: 'I/ ZhConnectHandler softDisconnect (keep binding)' });
    expect(new Date(l[0]!.ts!).toISOString()).toBe('2026-08-10T11:58:19.008Z');
    expect(l[1]!.text).toBe('E/ Exception = 01 FF');
    expect(l[2]).toMatchObject({ approx: true, text: 'Comment : Connected' });
  });
  it('skips JSON fragments of unparseable dumps and collapses repeats', () => {
    const text = '2026-08-10 17:35:20.000 E/X-LOG: Exception = 02 FF\n{\n    "data": {\n        "sub_id": null,\n        "habit_tracking_id": null,\n    },\n}\nComment : Connected\n';
    const l = parseAppLog(text, { source: 'app', url: 'x', date: '2026-08-10' });
    expect(l.map((x) => x.text)).toEqual(['E/ Exception = 02 FF', 'Comment : Connected']);
    const rep = collapseRepeats([{ source: 'ring', channel: 'r', ts: 1, approx: false, text: 'tick' }, { source: 'ring', channel: 'r', ts: 2, approx: false, text: 'tick' }, { source: 'ring', channel: 'r', ts: 3, approx: false, text: 'tick' }, { source: 'ring', channel: 'r', ts: 4, approx: false, text: 'other' }]);
    expect(rep.map((x) => x.text)).toEqual(['tick  (×3)', 'other']);
  });
  it('drops BLE data-bean dumps', () => {
    const t = '2026-08-10 17:36:09:000 ----> fitnessparsing ---------> parsingFitness dailyData = DailyBean{stepsFrequency=60, stepsData=[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]}\n2026-08-10 17:36:10:000 ----> bluetoothservice ---------> connection lost\n';
    const l = parseRingAndroid(t, 'BLE_2026-08-10.log');
    expect(l).toHaveLength(1);
    expect(l[0]!.text).toContain('connection lost');
  });
  it('parses Android ring lines and drops BLE hex payloads', () => {
    const behaviour = '2026-08-10 17:35:59:103 ----> sdk --- realtimedata -----> Open\n2026-08-10 17:36:00:000 ----> sdk --- dailysync --------> Add\n';
    const b = parseRingAndroid(behaviour, 'BEHAVIOR_2026-08-10.log');
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ channel: 'ring/BEHAVIOR', approx: false });
    expect(b[0]!.text).toBe('sdk --- realtimedata > Open');
    const ble = '2026-08-08 00:00:07:489 ----> bluetoothservice ---------> PROTOBUF_01 receive = 00 00 00 00 02 00\n2026-08-08 00:00:09:000 ----> bluetoothservice ---------> disconnected status=133\n';
    const l = parseRingAndroid(ble, 'BLE_2026-08-08.log');
    expect(l).toHaveLength(1);
    expect(l[0]!.text).toContain('disconnected');
  });
  it('gives iOS trace lines the session base time', () => {
    const t = '── ring-trace log opened at 2026-08-07 15:46:34.246 ──\n[V2.4.5]CBManagerStatePoweredOn\n<TL> [V2.4.5][SDK][ConnectState] ZHDConnectStateConnecting\n';
    const l = parseRingIos(t);
    expect(l).toHaveLength(3);
    expect(l[1]!.approx).toBe(true);
    expect(l[1]!.ts).toBe(istToEpoch(2026, 8, 7, 15, 46, 34));
  });
  it('parses firmware lines with year from the file date and upload markers', () => {
    const t = 'giff_Sar: 2273,High:3840,low:2560\n8-7 20:20:24:9433 cmd: 113,17\n==========1786363642114==========\n8-10 17:36:48:1532 cmd: 4109,0\n';
    const l = parseFirmware(t, { source: 'firmware', url: 'x', date: '2026-08-10' });
    expect(l).toHaveLength(4);
    expect(l[0]!.ts).toBeNull();
    expect(new Date(l[1]!.ts!).toISOString()).toBe('2026-08-07T14:50:24.000Z');
    expect(l[2]!.text).toMatch(/^--- upload marker 2026-08-10/);
    expect(l[3]!.text).toBe('cmd: 4109,0');
  });
});

describe('redaction', () => {
  it('removes tokens, jwts, otps and phone numbers', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [REDACTED]');
    expect(redact('"otp": "482913"')).toBe('"otp": "[REDACTED]"');
    expect(redact('call 9876543210 now')).toBe('call [REDACTED_PHONE] now');
    expect(redact('"time": "1786098002676"')).toBe('"time": "1786098002676"');
  });
});

describe('window + excerpt', () => {
  it('narrows sleep windows across midnight and workouts around start/end', () => {
    const s = computeWindow('sleep', '2026-09-01', { actual_start_time: '11:30 PM', actual_end_time: '06:45 AM' });
    expect(new Date(s.from).toISOString()).toBe('2026-08-31T17:00:00.000Z'); // 22:30 IST on Aug 31
    expect(new Date(s.to).toISOString()).toBe('2026-09-01T02:15:00.000Z');   // 07:45 IST on Sep 1
    const w = computeWindow('workout', '2026-09-01', { start_time: '6:00 AM', end_time: '6:45 AM' });
    expect(new Date(w.from).toISOString()).toBe('2026-09-01T00:00:00.000Z');  // 05:30 IST
    expect(new Date(w.to).toISOString()).toBe('2026-09-01T01:45:00.000Z');    // 07:15 IST
    const d = computeWindow('home', '2026-09-01', {});
    expect(d.label).toBe('issue day');
    expect(d.to - d.from).toBe(86_400_000 - 1);
  });

  it('builds a capped, tagged, chronological excerpt with error lines first', () => {
    const day = '2026-09-01';
    const base = istToEpoch(2026, 9, 1, 10, 0, 0);
    const ring = Array.from({ length: 300 }, (_, i) => ({ source: 'ring' as const, channel: 'ring/BEHAVIOR', ts: base + i * 60_000, approx: false, text: i === 150 ? 'sdk --- dailysync > sync failed timeout' : `sdk --- realtimedata > tick ${i}` }));
    const app = [{ source: 'app' as const, channel: 'app', ts: base + 5 * 60_000, approx: false, text: 'FAIL success=false message="Session expired"' }];
    const files: ParsedFile[] = [
      { ref: { source: 'ring', url: 'r', date: day }, lines: ring, bytes: 1 },
      { ref: { source: 'app', url: 'a', date: day }, lines: app, bytes: 1 },
    ];
    const r = buildExcerpt(files, { feature: 'activity', occurredOn: day, details: {}, fwVersion: '1.2.6', appVersion: '2.0.0' });
    expect(r.lineCount).toBeLessThanOrEqual(100);
    expect(r.coverage).toBe('full');
    expect(r.excerpt).toContain('===== [app] app 2.0.0 =====');
    expect(r.excerpt).toContain('===== [firmware] fv 1.2.6 =====');
    expect(r.excerpt).toContain('(no firmware log lines for this window)');
    expect(r.excerpt).toContain('sync failed timeout');
    expect(r.perSource.ring).toBe(40);
    const ringLines = r.excerpt.split('\n').filter((l) => l.includes('[BEHAVIOR]'));
    const times = ringLines.map((l) => l.slice(0, 8));
    expect([...times].sort()).toEqual(times); // chronological
  });

  it('reports no coverage when nothing parsed and partial when nothing is in the window', () => {
    expect(buildExcerpt([], { feature: 'home', occurredOn: '2026-09-01', details: {} }).coverage).toBe('none');
    const far = [{ source: 'firmware' as const, channel: 'firmware', ts: istToEpoch(2026, 8, 20, 10, 0, 0), approx: false, text: 'cmd: 1,0' }];
    const r = buildExcerpt([{ ref: { source: 'firmware', url: 'f', date: '2026-08-20' }, lines: far, bytes: 1 }], { feature: 'home', occurredOn: '2026-09-01', details: {} });
    expect(r.coverage).toBe('partial');
  });
});
