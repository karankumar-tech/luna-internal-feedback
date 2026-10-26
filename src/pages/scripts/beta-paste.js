// Reads a pasted list of beta users: Luna user IDs, each with a name or without, in whatever shape
// the list arrives. Any of these, mixed if need be:
//   104233 Rahul Sharma        Rahul Sharma, 104233        Rahul Sharma (104233)
//   1. 104233 – Rahul          • Rahul: 104233             ID: 104233  Name: Rahul
//   a spreadsheet's columns, either way round, with or without a header row (other columns ignored)
//   104233 Rahul, 118790 Priya (several on one line)
//   a name on one line and its ID on the next, or the ID first
//   bare IDs separated by commas, spaces or new lines
// Email addresses are dropped wherever they appear: customer emails never reach the dashboard.
// Nothing here depends on the DOM, so the same file runs under Node for the tests.
//
// Served at /dashboard/assets/beta-paste.js (embedded by scripts/embed-pages.mjs).

/** Longest name the server keeps. */
export const NAME_MAX = 120;
/** Past 15 digits a number no longer survives the trip as itself. */
const ID_MAX_DIGITS = 15;

const EMAIL = /[^\s,;<>()[\]"']+@[^\s,;<>()[\]"']+\.[a-z]{2,}/gi;
/** A whole number standing on its own: not inside a word, a date, a time, a decimal, a phone number or a ref like LN-104. */
const ID = /(?<![\p{L}\d.@_+/]|\p{L}-|\d:)#?(\d+)(?![\p{L}\d@_]|[./:]\d)/gu;
const ID_CELL = /^#?\d+$/;
/** "1. ", "2) ", "- ", "• " at the start of a line. */
const LIST_MARK = /^\s*(?:[-*•·▪◦‣–—>]|\(?\d{1,3}[.)])\s+(?=\S)/;
/** "ID: 104233", "user id 104233", "Name: Rahul": labels, not names. */
const LABELS = /(?<![\p{L}\d_])(?:user[\s_-]*)?ids?\s*[:=#-]?\s*(?=#?\d)|(?<![\p{L}\d_])(?:full[\s_-]*)?name\s*[:=-]\s*/giu;
/** A column heading that names the user ID: "User ID", "user_id", "ID", "UID", "Luna ID". */
const ID_HEADING = /(?:^|[^a-z])u?ids?(?![a-z])|userid/i;
const NAME_HEADING = /name/i;
const hasWord = (s) => /\p{L}/u.test(s);

/** A name out of the words around an ID: separators, empty brackets and stray quotes trimmed. */
function clean(s) {
  let t = s.replace(/\(\s*\)|\[\s*\]|\{\s*\}|<\s*>/g, ' ').replace(/\s+/g, ' ').trim();
  for (let was = null; was !== t;) {
    was = t;
    t = t.replace(/^[\s.,;:|/\\=•*·–—-]+|[\s,;:|/\\=•*·–—-]+$/g, '');
    if (/^[)\]}>]/.test(t)) t = t.slice(1);
    if (/[([{<]$/.test(t)) t = t.slice(0, -1);
    if (/^[([{<]/.test(t) && !/[)\]}>]/.test(t)) t = t.slice(1);
    if (/[)\]}>]$/.test(t) && !/[([{<]/.test(t)) t = t.slice(0, -1);
    if (/^[([{<][^()[\]{}<>]*[)\]}>]$/.test(t)) t = t.slice(1, -1);
    if (t.length > 1 && /^["“‘'`]/.test(t) && /["”’'`]$/.test(t)) t = t.slice(1, -1);
    else if (/^["“]/.test(t) && !/["”]/.test(t.slice(1))) t = t.slice(1);
    else if (/["”]$/.test(t) && !/["“]/.test(t.slice(0, -1))) t = t.slice(0, -1);
  }
  return t;
}

/** One line of plain text: what it holds, before lines are paired up. */
function readText(raw) {
  let line = raw.replace(EMAIL, ' ').replace(LIST_MARK, '');
  if (/^\W*(?:full\s*|user\s*)?names?\W*$/i.test(line) || (!line.match(ID) && ID_HEADING.test(line))) return { kind: 'header' };
  line = line.replace(LABELS, ' ');
  const ids = [...line.matchAll(ID)];
  if (!ids.length) {
    // Numbers that are not IDs (a ref, a phone number, a date) mean this is not a name either.
    if (/\d/.test(line)) return { kind: 'bad', reason: 'No user ID' };
    const name = clean(line);
    return hasWord(name) ? { kind: 'name', name } : { kind: 'skip' };
  }
  const texts = []; let at = 0;
  for (const m of ids) { texts.push(line.slice(at, m.index)); at = m.index + m[0].length; }
  texts.push(line.slice(at));
  const words = texts.map((t) => { const c = clean(t); return hasWord(c) ? c : ''; });
  const digits = ids.map((m) => m[1]);
  if (words.every((w) => !w)) return digits.length === 1 ? { kind: 'id', id: digits[0] } : { kind: 'pairs', pairs: digits.map((id) => ({ id, name: '' })) };
  if (digits.length === 1) return { kind: 'pairs', pairs: [{ id: digits[0], name: words.filter(Boolean).join(' ') }] };
  // Several on one line: each ID takes the words on the side the line starts with.
  const idFirst = !words[0];
  const pairs = digits.map((id, k) => ({ id, name: idFirst ? words[k + 1] : words[k] }));
  const rest = idFirst ? '' : words[digits.length];
  if (rest) pairs[pairs.length - 1].name = [pairs[pairs.length - 1].name, rest].filter(Boolean).join(' ');
  return { kind: 'pairs', pairs };
}

/** One spreadsheet row (cells split by tabs): the ID cell and the name cell, by heading when there was one. */
function readCells(raw, columns) {
  const cells = raw.split('\t').map((c) => clean(c.replace(EMAIL, ' ')));
  if (!cells.some((c) => ID_CELL.test(c)) && cells.some((c) => ID_HEADING.test(c) || /^(?:full\s*|user\s*)?names?$/i.test(c))) {
    return { kind: 'header', columns: { id: cells.findIndex((c) => ID_HEADING.test(c)), name: cells.findIndex((c) => NAME_HEADING.test(c)) } };
  }
  const idAt = columns && columns.id >= 0 ? columns.id : cells.findIndex((c) => ID_CELL.test(c));
  if (idAt < 0 || !ID_CELL.test(cells[idAt] ?? '')) {
    if (columns && columns.id >= 0) return { kind: 'bad', reason: 'Nothing in the ID column' };
    // No cell is only an ID: perhaps one holds "Rahul (104233)".
    return readText(cells.filter(Boolean).join(', '));
  }
  const nameAt = columns && columns.name >= 0 ? columns.name : cells.findIndex((c, k) => k !== idAt && hasWord(c));
  return { kind: 'pairs', pairs: [{ id: cells[idAt].replace('#', ''), name: nameAt >= 0 ? (cells[nameAt] ?? '') : '' }] };
}

/**
 * The users in a paste, each ID once, in the order they first appear.
 *   users:    [{ user_id, name (null for none), line, repeated, cut }]
 *             `repeated`: the ID was pasted more than once (its last name wins); `cut`: the name was
 *             longer than NAME_MAX and was shortened.
 *   problems: [{ line, text, reason }], lines that held no usable ID, with the line as pasted.
 *   headers:  line numbers read as a header row and skipped.
 */
export function parsePaste(text) {
  const items = [];
  let columns = null;
  String(text ?? '').split(/\r\n|\r|\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const it = raw.includes('\t') ? readCells(raw, columns) : readText(raw);
    if (it.kind === 'skip') return;
    if (it.kind === 'header' && it.columns) columns = it.columns;
    items.push({ ...it, line: i + 1, text: raw.trim() });
  });

  // A list with names and IDs on lines of their own: each name takes the bare ID next to it, the
  // line after when the list starts with a name, the line before when it starts with an ID. Only
  // when no line holds both; in a list that pairs them on one line, a lone name is a missing ID.
  const split = !items.some((it) => it.kind === 'pairs' && it.pairs.some((p) => p.name));
  const firstLone = items.find((it) => it.kind === 'name' || it.kind === 'id');
  const nameFirst = firstLone?.kind === 'name';
  items.forEach((it, k) => {
    if (it.kind !== 'name') return;
    const other = split && items[nameFirst ? k + 1 : k - 1];
    if (other && other.kind === 'id' && other.name === undefined) { other.name = it.name; it.kind = 'paired'; }
    else Object.assign(it, { kind: 'bad', reason: 'No user ID' });
  });

  const users = new Map(); const problems = []; const headers = [];
  const put = (digits, name, it) => {
    if (digits.length > ID_MAX_DIGITS) { problems.push({ line: it.line, text: it.text, reason: 'Too long for a user ID' }); return; }
    const id = Number(digits);
    if (!(id > 0)) { problems.push({ line: it.line, text: it.text, reason: 'Not a user ID' }); return; }
    const full = (name || '').trim();
    const named = full.slice(0, NAME_MAX).trim() || null;
    const had = users.get(id);
    if (!had) { users.set(id, { user_id: id, name: named, line: it.line, repeated: false, cut: full.length > NAME_MAX }); return; }
    had.repeated = true;
    if (named) Object.assign(had, { name: named, cut: full.length > NAME_MAX });
  };
  for (const it of items) {
    if (it.kind === 'header') headers.push(it.line);
    else if (it.kind === 'bad') problems.push({ line: it.line, text: it.text, reason: it.reason });
    else if (it.kind === 'id') put(it.id, it.name, it);
    else if (it.kind === 'pairs') for (const p of it.pairs) put(p.id, p.name, it);
  }
  problems.sort((a, b) => a.line - b.line);
  return { users: [...users.values()], problems, headers };
}
