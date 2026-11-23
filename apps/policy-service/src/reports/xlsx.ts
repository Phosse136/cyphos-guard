/**
 * Minimal, dependency-free XLSX writer (Office Open XML SpreadsheetML in a ZIP), enough for report tables:
 * one sheet per table, bold frozen header row, autofilter, column widths, numbers as numbers and dates as real
 * Excel dates. No formulas, no shared strings (inline strings), no styles beyond that.
 */
import { crc32, deflateRawSync } from "node:zlib";

export type Cell = string | number | Date | null | undefined;
export type Sheet = { name: string; header: string[]; rows: Cell[][]; widths?: number[]; filter?: boolean };

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
// XML 1.0 forbids most control characters; drop them rather than produce a file Excel refuses to open.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is exactly what this matches
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const esc = (s: string) =>
  s.replace(INVALID_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Column letters: 0 → A, 25 → Z, 26 → AA. */
export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel serial date (days since 1899-12-30, UTC). */
const excelDate = (d: Date) => d.getTime() / 86_400_000 + 25_569;

// Style indexes into cellXfs below: 0 normal, 1 bold header, 2 date-time, 3 date (UTC midnight).
const STYLES = `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(ref: string, v: Cell, header = false): string {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    return `<c r="${ref}" s="${v.getTime() % 86_400_000 === 0 ? 3 : 2}"><v>${excelDate(v)}</v></c>`;
  }
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${header ? ' s="1"' : ""}><v>${v}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ""}><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const cols = sheet.header.length;
  const widths =
    sheet.widths ??
    sheet.header.map((h, i) =>
      Math.min(
        60,
        Math.max(
          h.length + 2,
          ...sheet.rows.slice(0, 500).map((r) => {
            const v = r[i];
            return v instanceof Date ? 17 : String(v ?? "").length + 2;
          }),
        ),
      ),
    );
  const lastRef = `${colName(Math.max(cols - 1, 0))}${sheet.rows.length + 1}`;
  const rows = [sheet.header, ...sheet.rows]
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r.map((v, ci) => cellXml(`${colName(ci)}${ri + 1}`, v, ri === 0)).join("")}</row>`,
    )
    .join("");
  return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${rows}</sheetData>${hasFilter(sheet) ? `<autoFilter ref="A1:${lastRef}"/>` : ""}
</worksheet>`;
}

const hasFilter = (s: Sheet) => s.filter !== false && s.header.length > 0 && s.rows.length > 0;

/** Excel sheet names: max 31 chars, none of []:*?/\ , unique. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    const base = n.replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || "Sheet";
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)}_${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export function buildXlsx(sheets: Sheet[]): Buffer {
  const names = sheetNames(sheets.map((s) => s.name));
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`,
    ],
    [
      "_rels/.rels",
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
        .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets>${sheets.some((s) => s.rows.length > 0) ? definedFilters(names, sheets) : ""}</workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          "",
        )}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    ["xl/styles.xml", STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)] as [string, string]),
  ];
  return zip(files.map(([name, text]) => [name, Buffer.from(text, "utf8")]));
}

/** Excel expects a hidden _FilterDatabase name per autofiltered sheet. */
function definedFilters(names: string[], sheets: Sheet[]): string {
  const defs = sheets
    .map((s, i) =>
      hasFilter(s)
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i] ?? "").replace(/'/g, "''")}'!$A$1:$${colName(s.header.length - 1)}$${s.rows.length + 1}</definedName>`
        : "",
    )
    .join("");
  return defs ? `<definedNames>${defs}</definedNames>` : "";
}

/** Plain ZIP (deflate), UTF-8 names. */
export function zip(entries: [string, Buffer][]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // DOS time/date for 1980-01-01 00:00 keeps output deterministic.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(dosTime, 10);
    h.writeUInt16LE(dosDate, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    local.push(h, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += h.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
