import { describe, expect, it } from 'vitest';
import { NAME_MAX, parsePaste } from '../../src/pages/scripts/beta-paste.js';

/** The pasted users as [id, name] pairs, in order. */
const pairs = (text: string) => parsePaste(text).users.map((u: { user_id: number; name: string | null }) => [u.user_id, u.name]);

describe('pasting beta users', () => {
  it('reads bare IDs separated by commas, spaces, semicolons or lines', () => {
    expect(pairs('104233, 118790;120455\n130001 130002')).toEqual([[104233, null], [118790, null], [120455, null], [130001, null], [130002, null]]);
    expect(pairs('104233,118790')).toEqual([[104233, null], [118790, null]]);
  });

  it('reads an ID and a name a line, either way round, with any separator', () => {
    expect(pairs([
      '104233 Rahul Sharma',
      'Priya Singh, 118790',
      '120455 - Amit Kumar',
      'Neha: 130001',
      '130002 | Vikram',
      'Sana Khan – 130003',
    ].join('\n'))).toEqual([
      [104233, 'Rahul Sharma'], [118790, 'Priya Singh'], [120455, 'Amit Kumar'], [130001, 'Neha'], [130002, 'Vikram'], [130003, 'Sana Khan'],
    ]);
  });

  it('reads IDs in brackets, after a #, and labelled', () => {
    expect(pairs('Rahul Sharma (104233)\n118790 (Priya)\nAmit [#120455]\nID: 130001  Name: Neha\nuser_id=130002 name=Vikram')).toEqual([
      [104233, 'Rahul Sharma'], [118790, 'Priya'], [120455, 'Amit'], [130001, 'Neha'], [130002, 'Vikram'],
    ]);
  });

  it('strips numbers and bullets off a list', () => {
    expect(pairs('1. 104233 Rahul\n2) Priya - 118790\n- 120455 Amit\n• Neha 130001\n10. 130002')).toEqual([
      [104233, 'Rahul'], [118790, 'Priya'], [120455, 'Amit'], [130001, 'Neha'], [130002, null],
    ]);
  });

  it('reads several pairs on one line', () => {
    expect(pairs('104233 Rahul, 118790 Priya Singh; 120455 Amit')).toEqual([[104233, 'Rahul'], [118790, 'Priya Singh'], [120455, 'Amit']]);
    expect(pairs('Rahul 104233, Priya Singh 118790')).toEqual([[104233, 'Rahul'], [118790, 'Priya Singh']]);
  });

  it('pairs a name with the ID on the next line, or the line before when the list starts with an ID', () => {
    expect(pairs('Rahul Sharma\n104233\nPriya\n118790')).toEqual([[104233, 'Rahul Sharma'], [118790, 'Priya']]);
    expect(pairs('104233\nRahul Sharma\n118790\nPriya')).toEqual([[104233, 'Rahul Sharma'], [118790, 'Priya']]);
  });

  it('does not pair lines up in a list that already pairs IDs and names on one line', () => {
    const r = parsePaste('104233 Rahul\nKaran Mehta\n118790\nLN-00042 crash\n120455');
    expect(r.users.map((u) => [u.user_id, u.name])).toEqual([[104233, 'Rahul'], [118790, null], [120455, null]]);
    expect(r.problems.map((p) => [p.line, p.reason])).toEqual([[2, 'No user ID'], [4, 'No user ID']]);
  });

  it('reads spreadsheet columns, skipping the header and the columns it does not need', () => {
    const r = parsePaste('User ID\tName\tCity\n104233\tRahul Sharma\tDelhi\n118790\tPriya\tPune\n120455\t\tMumbai');
    expect(r.users.map((u) => [u.user_id, u.name])).toEqual([[104233, 'Rahul Sharma'], [118790, 'Priya'], [120455, null]]);
    expect(r.headers).toEqual([1]);
    expect(r.problems).toEqual([]);
  });

  it('follows the header when the name comes first, and without a header takes the first number and the first words', () => {
    expect(pairs('Name\tPhone\tLuna ID\nRahul\t9876543210\t104233')).toEqual([[104233, 'Rahul']]);
    expect(pairs('Rahul Sharma\t104233\nPriya\t118790')).toEqual([[104233, 'Rahul Sharma'], [118790, 'Priya']]);
  });

  it('skips a plain-text header', () => {
    const r = parsePaste('User ID, Name\n104233, Rahul');
    expect(r.users.map((u) => [u.user_id, u.name])).toEqual([[104233, 'Rahul']]);
    expect(r.headers).toEqual([1]);
  });

  it('never keeps an email address', () => {
    expect(pairs('104233 Rahul Sharma rahul.sharma99@gmail.com\nPriya <priya@example.in> 118790\n120455\tAmit\tamit@luna.app')).toEqual([
      [104233, 'Rahul Sharma'], [118790, 'Priya'], [120455, 'Amit'],
    ]);
  });

  it('does not take report refs, phone numbers, dates or decimals for IDs', () => {
    const r = parsePaste('Rahul LN-00042\n+919876543210\n12/10/2026\n3.14');
    expect(r.users).toEqual([]);
    expect(r.problems.map((p) => p.line)).toEqual([1, 2, 3, 4]);
  });

  it('reports lines with no ID, as pasted, and adds the rest', () => {
    const r = parsePaste('104233 Rahul\nPriya Singh\n\n118790 Amit\nKaran');
    expect(r.users.map((u) => u.user_id)).toEqual([104233, 118790]);
    expect(r.problems).toEqual([{ line: 2, text: 'Priya Singh', reason: 'No user ID' }, { line: 5, text: 'Karan', reason: 'No user ID' }]);
  });

  it('turns away IDs that are zero or too long', () => {
    const r = parsePaste('0 Rahul\n1234567890123456 Priya\n104233 Amit');
    expect(r.users.map((u) => u.user_id)).toEqual([104233]);
    expect(r.problems.map((p) => p.reason)).toEqual(['Not a user ID', 'Too long for a user ID']);
  });

  it('keeps each ID once, the last name given winning', () => {
    const r = parsePaste('104233 Rahul\n118790\n104233 Rahul Sharma\n104233');
    expect(r.users).toEqual([
      { user_id: 104233, name: 'Rahul Sharma', line: 1, repeated: true, cut: false },
      { user_id: 118790, name: null, line: 2, repeated: false, cut: false },
    ]);
  });

  it('shortens a name past the limit', () => {
    const [u] = parsePaste(`104233 ${'R'.repeat(NAME_MAX + 30)}`).users;
    expect(u.name).toHaveLength(NAME_MAX);
    expect(u.cut).toBe(true);
  });

  it('ignores blank lines and rules', () => {
    expect(parsePaste('\n  \n-----\n104233 Rahul\n=====\n')).toEqual({ users: [{ user_id: 104233, name: 'Rahul', line: 4, repeated: false, cut: false }], problems: [], headers: [] });
  });

  it('keeps names with apostrophes, dots and accents', () => {
    expect(pairs("104233 D'Souza Jr.\nJosé Ñúñez 118790\n120455 \"Sharma, Rahul\"")).toEqual([[104233, "D'Souza Jr."], [118790, 'José Ñúñez'], [120455, 'Sharma, Rahul']]);
  });
});
