/**
 * Minimal read-only XLSX reader.
 *
 * Only what this repo needs: sheet names in workbook order and their cell text.
 * Uses fflate (already a runtime dependency) to unzip and a tolerant scan of the
 * SpreadsheetML we actually get from Excel/Numbers exports. Not a general parser:
 * it ignores styles, formulas (reads the cached value), merges and dates-as-numbers.
 */
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Concatenates every <t> run inside a chunk — how Excel splits styled text. */
function textRuns(chunk) {
  let out = '';
  for (const m of chunk.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) out += decodeXml(m[1] ?? '');
  return out;
}

/** "BC12" -> 54 (zero-based column index). */
function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref);
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Reads a workbook into `{ name -> rows }`, each row an array of trimmed cell strings.
 * Rows and columns are padded so a cell's index always equals its column.
 */
export function readWorkbook(path) {
  const files = unzipSync(readFileSync(path));
  const read = (name) => (files[name] ? strFromU8(files[name]) : undefined);

  const shared = [];
  const sharedXml = read('xl/sharedStrings.xml');
  if (sharedXml) for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1]));

  const rels = new Map();
  const relsXml = read('xl/_rels/workbook.xml.rels') ?? '';
  // Excel writes `<Relationship .../>`; the Mac exporter writes `<Relationship ...></Relationship>`.
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) rels.set(id, target);
  }

  const out = new Map();
  const workbookXml = read('xl/workbook.xml') ?? '';
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)>/g)) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? '');
    const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1];
    const target = rid ? rels.get(rid) : undefined;
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : target.startsWith('xl/') ? target : `xl/${target}`;
    const xml = read(path);
    if (xml === undefined) continue;
    out.set(name, parseSheet(xml, shared));
  }
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      let value = '';
      if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1]);
        value = shared[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = textRuns(body);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = v === undefined ? '' : decodeXml(v);
      }
      value = value.trim();
      if (!value) continue;
      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length <= at) cells.push('');
      cells[at] = value;
    }
    rows.push(cells);
  }
  return rows;
}
