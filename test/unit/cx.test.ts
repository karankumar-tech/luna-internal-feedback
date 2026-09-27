import { describe, expect, it } from 'vitest';
import { buildCxSubmissionValidator, CX_EMAIL_REFUSED, zodIssues } from '../../src/schema/buildValidator.js';
import { parseSubmissionRef } from '../../src/modules/feedback/feedback.repo.js';
import { parseKindRef } from '../../src/modules/kinds/kinds.repo.js';
import { redact } from '../../src/modules/diagnosis/logs/redact.js';
import { normalizeEntry } from '../../src/modules/diagnosis/logs/client.js';

const NOW = new Date('2026-09-02T10:00:00Z');
const ctx = { categoryKeys: ['cat_a', 'cat_b'], timeZone: 'Asia/Kolkata', now: NOW };

const cxBase = {
  is_positive: false,
  occurred_on: '2026-09-01',
  device_serial: 'R2N08250600302',
  issue_categories: ['cat_a'],
  feedback_text: 'Customer says sleep is wrong.',
  cx: { ref: 'FD-48213' },
};

function cxIssues(body: unknown) {
  const r = buildCxSubmissionValidator('sleep', ctx).safeParse(body);
  return r.success ? [] : zodIssues(r.error);
}

describe('CX contract', () => {
  it('accepts a report identified by serial and CX ticket, with no email or user id', () => {
    expect(cxIssues(cxBase)).toEqual([]);
    expect(cxIssues({ ...cxBase, user_id: 10482, cx: { ref: 'FD-1', url: 'https://support.example/t/1', channel: 'whatsapp', agent: 'A', transcript: 'x' } })).toEqual([]);
  });

  it('names the email when one is sent, rather than a generic unknown-key error', () => {
    expect(cxIssues({ ...cxBase, email: 'customer@example.com' })).toEqual([{ path: 'email', message: CX_EMAIL_REFUSED }]);
    expect(cxIssues({ ...cxBase, email: null })).toEqual([{ path: 'email', message: CX_EMAIL_REFUSED }]);
  });

  it('requires the serial and the CX ticket ref', () => {
    const { device_serial: _s, cx: _c, ...rest } = cxBase;
    const paths = cxIssues(rest).map((i) => i.path).sort();
    expect(paths).toEqual(['cx', 'device_serial']);
    expect(cxIssues({ ...cxBase, cx: { ref: '  ' } }).map((i) => i.path)).toEqual(['cx.ref']);
    expect(cxIssues({ ...cxBase, device_serial: 'R2' }).map((i) => i.path)).toEqual(['device_serial']);
  });

  it('rejects unknown CX fields and channels', () => {
    expect(cxIssues({ ...cxBase, cx: { ref: 'FD-1', priority: 'high' } }).length).toBe(1);
    expect(cxIssues({ ...cxBase, cx: { ref: 'FD-1', channel: 'fax' } }).map((i) => i.path)).toEqual(['cx.channel']);
  });

  it('still validates the feature fields and categories like the app contract', () => {
    expect(cxIssues({ ...cxBase, issue_categories: ['nope'] }).map((i) => i.path)).toEqual(['issue_categories.0']);
    expect(cxIssues({ ...cxBase, details: { actual_start_time: '25:00 PM' } }).map((i) => i.path)).toEqual(['details.actual_start_time']);
  });
});

describe('references', () => {
  it('reads LN- references however they are typed', () => {
    for (const s of ['LN-00042', 'ln-42', 'LN42', '42', ' 00042 ']) expect(parseSubmissionRef(s), s).toBe(42);
    expect(parseSubmissionRef('LN-100000')).toBe(100000);
    for (const s of ['', 'LN-', 'LNK-7', 'abc', '0', 'LN-0', '4 2']) expect(parseSubmissionRef(s), s).toBeNull();
  });

  it('reads LNK- references, but not a bare number', () => {
    for (const s of ['LNK-0007', 'lnk-7', 'LNK7']) expect(parseKindRef(s), s).toBe(7);
    for (const s of ['7', 'LN-7', 'LNK-']) expect(parseKindRef(s), s).toBeNull();
  });
});

describe('email redaction', () => {
  it('removes email addresses from log lines and customer text', () => {
    expect(redact('mail me at jane.doe+x@mail.example.co.in today')).toBe('mail me at [REDACTED_EMAIL] today');
    expect(redact('"email":"a.b@c.io","name":"x"')).toBe('"email":"[REDACTED_EMAIL]","name":"x"');
    // Not an address: left alone.
    expect(redact('version 2.5.0@build and user@host')).toBe('version 2.5.0@build and user@host');
  });
});

describe('logging API responses', () => {
  it('normalises a device entry the same way whichever host it came from', () => {
    const e = normalizeEntry({ user_id: '900777', platform: 'iOS', fv: '1.9.3', version_name: '2.5.0', app_logs: 'https://x/app_logs/900777-2026-09-02/1.txt' });
    expect(e).toMatchObject({ user_id: 900777, platform: 'ios', fv: '1.9.3', version_name: '2.5.0' });
    expect(e.files.app[0]!.date).toBe('2026-09-02');
  });
});
