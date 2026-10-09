/**
 * A small Excel (.xlsx) writer: sheets of rows with a bold, frozen, filterable header, column
 * widths and number formats. Enough for exports people open in Excel, Numbers or Google Sheets;
 * no formulas, no charts, no shared strings.
 *
 * Numbers stay numbers: a unit goes into the cell's format ("142 bpm" is 142 shown with ` bpm`),
 * so a column can still be sorted, filtered and summed.
 */
import { strToU8, zipSync } from 'fflate';

export type CellValue = string | number | boolean | null | undefined;
/** A value with how to show it. `fmt` is an Excel number format, such as `0.0" bpm"` or `[h]:mm:ss`. */
export interface Cell { v: CellValue; fmt?: string; bold?: boolean; wrap?: boolean }
export type CellInput = CellValue | Cell;

export interface Sheet {
  name: string;
  /** A bold first row that stays in view while scrolling, with a filter on every column. */
  header?: string[];
  rows: CellInput[][];
  /** Column widths in characters; worked out from the content where not given. */
  widths?: (number | undefined)[];
}

/** Excel counts days from 1899-12-30; this is the wall-clock time at `offsetMin` from UTC. */
export function excelTime(epochSeconds: number, offsetMin = 0): number {
  return (epochSeconds + offsetMin * 60) / 86400 + 25569;
}

/** A length of time as Excel stores one: a fraction of a day. */
export const excelDuration = (seconds: number) => seconds / 86400;

/** Text that may go into a number format as a literal: `"…"` with any quote dropped. */
export const fmtText = (s: string) => `"${s.replace(/"/g, '')}"`;

const MAX_TEXT = 32_767;
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const esc = (s: string) => s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function column(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const asCell = (c: CellInput): Cell => (c !== null && typeof c === 'object' ? c : { v: c });

/** Every distinct look a cell can have, numbered as Excel's cellXfs. 0 is plain. */
class Styles {
  private readonly formats = new Map<string, number>();
  private readonly xfs = new Map<string, number>([['0|0|0', 0]]);

  id(cell: Cell): number {
    if (!cell.fmt && !cell.bold && !cell.wrap) return 0;
    let fmt = 0;
    if (cell.fmt) {
      fmt = this.formats.get(cell.fmt) ?? 164 + this.formats.size;
      this.formats.set(cell.fmt, fmt);
    }
    const key = `${fmt}|${cell.bold ? 1 : 0}|${cell.wrap ? 1 : 0}`;
    let id = this.xfs.get(key);
    if (id === undefined) { id = this.xfs.size; this.xfs.set(key, id); }
    return id;
  }

  xml(): string {
    const numFmts = [...this.formats].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('');
    const xfs = [...this.xfs.keys()].map((key) => {
      const [fmt, bold, wrap] = key.split('|');
      return `<xf numFmtId="${fmt}" fontId="${bold}" fillId="0" borderId="0" xfId="0"${fmt !== '0' ? ' applyNumberFormat="1"' : ''}${bold === '1' ? ' applyFont="1"' : ''}`
        + (wrap === '1' ? ' applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' : '/>');
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + (this.formats.size ? `<numFmts count="${this.formats.size}">${numFmts}</numFmts>` : '')
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${this.xfs.size}">${xfs}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
  }
}

/** About how many characters a cell takes on screen, for a column's width. */
function displayWidth(cell: Cell): number {
  const v = cell.v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return cell.fmt ? Math.max(10, cell.fmt.replace(/"[^"]*"/g, (m) => m.slice(1, -1)).replace(/[\\[\]]/g, '').length) : String(v).length;
  if (typeof v === 'boolean') return 5;
  return Math.max(...v.split('\n').map((line) => line.length));
}

function sheetXml(sheet: Sheet, styles: Styles): { xml: string; filter: string | null } {
  const header = sheet.header?.map((h): Cell => ({ v: h, bold: true }));
  const rows = [...(header ? [header] : []), ...sheet.rows.map((r) => r.map(asCell))];
  const width = Math.max(1, ...rows.map((r) => r.length));

  const widths: number[] = [];
  for (let c = 0; c < width; c++) {
    const given = sheet.widths?.[c];
    if (given) { widths.push(given); continue; }
    let w = 6;
    for (const r of rows) { const cell = r[c]; if (cell && !cell.wrap) w = Math.max(w, displayWidth(cell) + (cell.bold ? 2 : 1)); }
    widths.push(Math.min(60, w + 1));
  }
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');

  const body = rows.map((r, ri) => {
    const cells = r.map((cell, ci) => {
      const ref = `${column(ci)}${ri + 1}`;
      const s = styles.id(cell);
      const style = s ? ` s="${s}"` : '';
      const v = cell.v;
      if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return s ? `<c r="${ref}"${style}/>` : '';
      if (typeof v === 'number') return `<c r="${ref}"${style}><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`;
      const text = v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v;
      const space = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
      return `<c r="${ref}"${style} t="inlineStr"><is><t${space}>${esc(text)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  const filter = header && rows.length > 1 ? `A1:${column(width - 1)}${rows.length}` : null;
  const frozen = header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + frozen + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${cols}</cols><sheetData>${body}</sheetData>`
    + (filter ? `<autoFilter ref="${filter}"/>` : '')
    + '</worksheet>';
  return { xml, filter };
}

/** A sheet name Excel accepts: at most 31 characters, none of []:*?/\, unique in the book. */
function sheetNames(sheets: Sheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((s, i) => {
    const base = s.name.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet ${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** The workbook as the bytes of an .xlsx file. */
export function workbook(sheets: Sheet[]): Uint8Array {
  if (!sheets.length) throw new Error('a workbook needs at least one sheet');
  const styles = new Styles();
  const names = sheetNames(sheets);
  const built = sheets.map((s) => sheetXml(s, styles));
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, xml: string) => { files[path] = strToU8(xml); };

  put('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + built.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>');
  put('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>');
  // A filter needs its range named in the workbook, or Excel offers to repair the file.
  const defined = built.map((b, i) => (b.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i]!.replace(/'/g, "''"))}'!${b.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : '')).join('');
  put('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<bookViews><workbookView/></bookViews><sheets>'
    + names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets>' + (defined ? `<definedNames>${defined}</definedNames>` : '') + '</workbook>');
  put('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + built.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${built.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>');
  built.forEach((b, i) => put(`xl/worksheets/sheet${i + 1}.xml`, b.xml));
  // Styles last: the sheets above register every format they use.
  put('xl/styles.xml', styles.xml());
  return zipSync(files, { level: 6 });
}
