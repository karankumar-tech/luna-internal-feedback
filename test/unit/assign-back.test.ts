import { describe, expect, it } from 'vitest';
import { ASSIGN_BACK_DEFAULTS, assignBackTo } from '../../src/modules/feedback/assign-back.js';

const [KULDEEP, SHAIFALI] = ASSIGN_BACK_DEFAULTS.map((d) => d.id);
const kuldeep = { id: KULDEEP!, email: 'kuldeep@x.test' };
const shaifali = { id: SHAIFALI!, email: 'shaifali@x.test' };
const tester = { id: '00000000-0000-4000-8000-000000000001', email: 'tester@x.test' };

describe('who a fixed report goes back to', () => {
  it('is Kuldeep by default, then Shaifali', () => {
    expect(ASSIGN_BACK_DEFAULTS.map((d) => d.name)).toEqual(['Kuldeep Sachan', 'Shaifali']);
  });
  it('is the first reporter with an active account, in any case', () => {
    expect(assignBackTo(['nobody@x.test', 'Tester@X.test'], [kuldeep, tester])).toEqual({ email: 'tester@x.test', reason: 'reporter' });
  });
  it('falls back to Kuldeep, then Shaifali, then nobody', () => {
    expect(assignBackTo(['nobody@x.test', null], [shaifali, kuldeep])).toEqual({ email: 'kuldeep@x.test', reason: 'default' });
    expect(assignBackTo([], [shaifali])).toEqual({ email: 'shaifali@x.test', reason: 'default' });
    expect(assignBackTo(['nobody@x.test'], [])).toBeNull();
  });
});
