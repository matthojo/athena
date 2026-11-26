/**
 * A note as a file to download:
 * Markdown as written, or a Word document made from that Markdown. Pure, with
 * no I/O, so the server (lib/document-make-db.ts) and the app (sample mode,
 * offline) make the same bytes.
 *
 * Word: headings, paragraphs, bold, italic, strikethrough, links, bullet and
 * numbered lists (nested), task lists, tables, inline code and code blocks,
 * quotes. A .docx is a zip of XML; the zip here is stored, not compressed,
 * which Word, Pages, Google Docs and LibreOffice all read.
 * An athena:// link keeps its label and loses the link, as when a note is
 * sent to Google Docs (lib/documents.ts): it means nothing outside Athena.
 */
import { lexer, type Token, type Tokens } from "marked";
import type { DocumentFormat } from "./assignment-types";

// ---------- names and Markdown ----------

/** "Trip plan.docx": the note's title as a file name, safe on every system. */
export function documentName(title: string, format: DocumentFormat): string {
  const base = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|[. ]+$/g, "")
    .slice(0, 120)
    .trim();
  return `${base || "Untitled note"}.${format}`;
}

/** The note as written: its title as a heading (unless the body opens with it), then the body untouched. */
export function noteMarkdown(note: { title: string; body: string }): string {
  const title = note.title.trim();
  const body = note.body.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const opens = /^#\s+(.*)$/m.exec(body.trimStart().split("\n", 1)[0] ?? "")?.[1]?.trim();
  if (!title || opens === title) return body ? `${body}\n` : "";
  return body ? `# ${title}\n\n${body}\n` : `# ${title}\n`;
}

// ---------- Markdown → WordprocessingML ----------

const esc = (s: string) =>
  s
    // What XML 1.0 can't hold.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** marked leaves entities in some token text; a document wants the characters. */
const unescape = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e] ?? _m);

interface Marks {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
}

interface Para {
  style?: string;
  /** A list item's first paragraph. */
  num?: { id: number; level: number };
  /** Left indent in twentieths of a point (a list item's later paragraphs, task items). */
  indent?: number;
  align?: "center" | "right";
  keepNext?: boolean;
}

/** The parts of a .docx that depend on the note. */
export interface DocxParts {
  /** word/document.xml */
  document: string;
  /** word/numbering.xml */
  numbering: string;
  /** word/_rels/document.xml.rels */
  rels: string;
}

const LEVELS = 9;
const BULLETS = ["•", "◦", "▪"];
const STEP = 360;

class Builder {
  private out: string[] = [];
  /** Each list is its own numbering instance, so a second numbered list starts again at 1. */
  private lists: Array<{ ordered: boolean; level: number; start: number }> = [];
  private links: string[] = [];

  // ----- inline -----

  private run(text: string, m: Marks): string {
    if (!text) return "";
    const props = [m.code ? `<w:rStyle w:val="InlineCode"/>` : m.link ? `<w:rStyle w:val="Hyperlink"/>` : "", m.bold ? "<w:b/>" : "", m.italic ? "<w:i/>" : "", m.strike ? "<w:strike/>" : ""].join("");
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text.replace(/\n/g, " "))}</w:t></w:r>`;
  }

  private inline(tokens: Token[] | undefined, m: Marks = {}): string {
    let xml = "";
    for (const t of tokens ?? []) {
      switch (t.type) {
        case "strong":
          xml += this.inline((t as Tokens.Strong).tokens, { ...m, bold: true });
          break;
        case "em":
          xml += this.inline((t as Tokens.Em).tokens, { ...m, italic: true });
          break;
        case "del":
          xml += this.inline((t as Tokens.Del).tokens, { ...m, strike: true });
          break;
        case "codespan":
          xml += this.run(unescape((t as Tokens.Codespan).text), { ...m, code: true });
          break;
        case "br":
          xml += "<w:r><w:br/></w:r>";
          break;
        case "link": {
          const link = t as Tokens.Link;
          const web = /^(https?:\/\/|mailto:)/i.test(link.href);
          // A mention's label is "@Name" in the note; outside Athena it's just the name.
          const inner = web ? this.inline(link.tokens, { ...m, link: true }) : this.inline(link.tokens, m).replace(/(<w:t xml:space="preserve">)@/, "$1");
          if (!web) xml += inner;
          else {
            this.links.push(link.href);
            xml += `<w:hyperlink r:id="rLink${this.links.length}" w:history="1">${inner}</w:hyperlink>`;
          }
          break;
        }
        case "image": {
          // No pictures in v1: the words that stood for it.
          const image = t as Tokens.Image;
          xml += this.run(image.text || image.href, m);
          break;
        }
        case "checkbox":
          break;
        case "text": {
          const text = t as Tokens.Text;
          xml += text.tokens?.length ? this.inline(text.tokens, m) : this.run(unescape(text.text), m);
          break;
        }
        case "escape":
          xml += this.run(unescape((t as Tokens.Escape).text), m);
          break;
        default:
          // Raw HTML and anything new: as typed.
          xml += this.run("raw" in t ? String(t.raw) : "", m);
      }
    }
    return xml;
  }

  // ----- blocks -----

  private para(runs: string, p: Para = {}): void {
    const props = [
      p.style ? `<w:pStyle w:val="${p.style}"/>` : "",
      p.keepNext ? "<w:keepNext/>" : "",
      p.num ? `<w:numPr><w:ilvl w:val="${p.num.level}"/><w:numId w:val="${p.num.id}"/></w:numPr>` : "",
      p.indent ? `<w:ind w:left="${p.indent}"/>` : "",
      p.align ? `<w:jc w:val="${p.align}"/>` : "",
    ].join("");
    this.out.push(`<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${runs}</w:p>`);
  }

  private list(list: Tokens.List, depth: number, quote: boolean): void {
    const level = Math.min(depth, LEVELS - 1);
    this.lists.push({ ordered: !!list.ordered, level, start: typeof list.start === "number" ? list.start : 1 });
    const id = this.lists.length;
    const hang = STEP * (level + 2);
    for (const item of list.items) {
      let first = true;
      for (const t of item.tokens) {
        if (t.type === "space" || t.type === "checkbox") continue;
        if (t.type === "list") {
          this.list(t as Tokens.List, depth + 1, quote);
          continue;
        }
        if (t.type === "text" || t.type === "paragraph") {
          const runs = this.inline((t as Tokens.Text).tokens ?? [{ type: "text", raw: t.raw, text: (t as Tokens.Text).text } as Tokens.Text]);
          // A task: its box in place of the bullet. Ticked ones read as done in any app.
          if (first && item.task) this.para(this.run(item.checked ? "☑ " : "☐ ", {}) + runs, { style: "ListParagraph", indent: hang - STEP });
          else if (first) this.para(runs, { style: "ListParagraph", num: { id, level } });
          else this.para(runs, { style: "ListParagraph", indent: hang });
          first = false;
          continue;
        }
        this.blocks([t], depth + 1, quote);
        first = false;
      }
      if (first) this.para("", item.task ? { style: "ListParagraph", indent: hang - STEP } : { style: "ListParagraph", num: { id, level } });
    }
  }

  private table(table: Tokens.Table): void {
    const cell = (c: Tokens.TableCell, i: number, head: boolean) => {
      const align = table.align[i] === "center" || table.align[i] === "right" ? `<w:jc w:val="${table.align[i]}"/>` : "";
      const runs = this.inline(c.tokens, head ? { bold: true } : {});
      return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${head ? `<w:shd w:val="clear" w:color="auto" w:fill="F2F3F5"/>` : ""}</w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/>${align}</w:pPr>${runs}</w:p></w:tc>`;
    };
    const row = (cells: Tokens.TableCell[], head: boolean) => `<w:tr>${head ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells.map((c, i) => cell(c, i, head)).join("")}</w:tr>`;
    const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="C9CCD3"/>`;
    this.out.push(
      `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>` +
        `<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
        `<w:tblGrid>${table.header.map(() => "<w:gridCol/>").join("")}</w:tblGrid>${row(table.header, true)}${table.rows.map((r) => row(r, false)).join("")}</w:tbl>`,
    );
    // Word needs a paragraph after a table; it also keeps two tables apart.
    this.para("", { style: "TableText" });
  }

  blocks(tokens: Token[], depth = 0, quote = false): void {
    const indent = depth ? STEP * (Math.min(depth, LEVELS) + 1) : undefined;
    for (const t of tokens) {
      switch (t.type) {
        case "space":
        case "def":
          break;
        case "heading": {
          const h = t as Tokens.Heading;
          this.para(this.inline(h.tokens), { style: `Heading${Math.min(h.depth, 6)}`, keepNext: true });
          break;
        }
        case "paragraph":
        case "text":
          this.para(this.inline((t as Tokens.Paragraph).tokens ?? [{ type: "text", raw: t.raw, text: (t as Tokens.Text).text } as Tokens.Text]), { style: quote ? "Quote" : undefined, indent });
          break;
        case "list":
          this.list(t as Tokens.List, depth, quote);
          break;
        case "blockquote":
          this.blocks((t as Tokens.Blockquote).tokens, depth, true);
          break;
        case "code":
          for (const line of (t as Tokens.Code).text.split("\n")) this.para(this.run(line.replace(/\t/g, "    "), {}), { style: "CodeBlock", indent });
          break;
        case "table":
          this.table(t as Tokens.Table);
          break;
        case "hr":
          this.out.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C9CCD3"/></w:pBdr></w:pPr></w:p>`);
          break;
        default:
          // Raw HTML: as typed, never as markup.
          if ("raw" in t && String(t.raw).trim()) this.para(this.run(String(t.raw).trim(), {}), { style: quote ? "Quote" : undefined, indent });
      }
    }
  }

  parts(): DocxParts {
    const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
    const level = (ordered: boolean, i: number) =>
      `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? "decimal" : "bullet"}"/>` +
      `<w:lvlText w:val="${ordered ? `%${i + 1}.` : BULLETS[i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${STEP * (i + 2)}" w:hanging="${STEP}"/></w:pPr></w:lvl>`;
    const abstract = (id: number, ordered: boolean) =>
      `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: LEVELS }, (_v, i) => level(ordered, i)).join("")}</w:abstractNum>`;
    const nums = this.lists
      .map((l, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${l.ordered ? 1 : 0}"/>${l.ordered ? `<w:lvlOverride w:ilvl="${l.level}"><w:startOverride w:val="${l.start}"/></w:lvlOverride>` : ""}</w:num>`)
      .join("");
    const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    return {
      document:
        `${XML}<w:document ${W} xmlns:r="${R}"><w:body>${this.out.join("") || "<w:p/>"}` +
        `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
      numbering: `${XML}<w:numbering ${W}>${abstract(0, false)}${abstract(1, true)}${nums}</w:numbering>`,
      rels:
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rStyles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rNumbering" Type="${R}/numbering" Target="numbering.xml"/>` +
        this.links.map((href, i) => `<Relationship Id="rLink${i + 1}" Type="${R}/hyperlink" Target="${esc(href)}" TargetMode="External"/>`).join("") +
        `</Relationships>`,
    };
  }
}

const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

/** The XML that depends on the note (for tests, and docxBytes below). */
export function docxParts(markdown: string): DocxParts {
  const b = new Builder();
  b.blocks(lexer(markdown.replace(/\r\n?/g, "\n"), { gfm: true }));
  return b.parts();
}

// Plain and quiet: ink on white, one grey for rules and code. Fonts every Word has.
const STYLES = (() => {
  const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
  const heading = (n: number, size: number, before: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return (
    `${XML}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:color w:val="16181D"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    heading(1, 40, 360) +
    heading(2, 30, 320) +
    heading(3, 26, 280) +
    heading(4, 24, 240) +
    heading(5, 22, 200) +
    heading(6, 22, 200) +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="C9CCD3"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:color w:val="4A4F5A"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F3F5"/><w:spacing w:after="0" w:line="260" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style>` +
    `<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F2F3F5"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="2450C8"/><w:u w:val="single"/></w:rPr></w:style>` +
    `</w:styles>`
  );
})();

const CONTENT_TYPES =
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`;

const ROOT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

/** A note's Markdown as a .docx. The same Markdown gives the same bytes. */
export function markdownToDocx(markdown: string): Uint8Array {
  const parts = docxParts(markdown);
  return zipStored([
    // First, as the format asks.
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", ROOT_RELS],
    ["word/document.xml", parts.document],
    ["word/styles.xml", STYLES],
    ["word/numbering.xml", parts.numbering],
    ["word/_rels/document.xml.rels", parts.rels],
  ]);
}

/** A note as a file: its name, type and bytes. */
export function noteDocument(note: { title: string; body: string }, format: DocumentFormat): { name: string; bytes: Uint8Array } {
  const md = noteMarkdown(note);
  return { name: documentName(note.title, format), bytes: format === "docx" ? markdownToDocx(md) : new TextEncoder().encode(md) };
}

// ---------- zip (stored) ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip with every entry stored as it is. Dated 1 Jan 1980, so the same files give the same zip. */
export function zipStored(files: Array<[name: string, text: string]>): Uint8Array {
  const enc = new TextEncoder();
  const entries = files.map(([name, text]) => ({ name: enc.encode(name), data: enc.encode(text) }));
  const size = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length + 46 + e.name.length, 22);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  const crcs: number[] = [];
  for (const e of entries) {
    offsets.push(at);
    const crc = crc32(e.data);
    crcs.push(crc);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 0x0800, true); // names are UTF-8
    view.setUint16(at + 8, 0, true); // stored
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 0x21, true); // 1 Jan 1980
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, e.data.length, true);
    view.setUint32(at + 22, e.data.length, true);
    view.setUint16(at + 26, e.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(e.name, at + 30);
    out.set(e.data, at + 30 + e.name.length);
    at += 30 + e.name.length + e.data.length;
  }
  const start = at;
  entries.forEach((e, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 0, true);
    view.setUint16(at + 14, 0x21, true);
    view.setUint32(at + 16, crcs[i], true);
    view.setUint32(at + 20, e.data.length, true);
    view.setUint32(at + 24, e.data.length, true);
    view.setUint16(at + 28, e.name.length, true);
    view.setUint32(at + 42, offsets[i], true);
    out.set(e.name, at + 46);
    at += 46 + e.name.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - start, true);
  view.setUint32(at + 16, start, true);
  return out;
}
