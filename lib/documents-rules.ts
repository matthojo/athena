/**
 * The pure half of sending a note out (lib/documents.ts does the rest):
 *  - Markdown → a Google Docs batchUpdate (headings, lists, checklists,
 *    bold, italic, web links);
 *  - the gate every Google Docs/Drive request passes (googleDocsRequestProblem):
 *    only the few calls that make a doc in Athena's folder, fill it, or trash
 *    it again, and only for files Athena made;
 *  - the gate every Notion write passes (notionWriteProblem): create a page
 *    under the parent the owner chose, or add to a page Athena made. Nothing
 *    else, whatever the server offers.
 * No I/O, so it's all unit-tested (documents-rules.test.ts).
 */

// ---------- Markdown → Google Docs ----------

export type DocsRequest = Record<string, unknown>;

interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  url?: string;
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; spans: Span[] }
  | { kind: "bullet" | "number" | "check"; spans: Span[] }
  | { kind: "para"; spans: Span[] };

/** **bold**, *italic* or _italic_, `code`, [label](https://…). An athena:// link keeps its label and loses the link: it means nothing outside Athena. */
export function inlineSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|(\b_([^_\n]+)_\b)|(`([^`\n]+)`)|(\[((?:\\.|[^\]\\\n])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) spans.push({ text: text.slice(last, m.index) });
    if (m[2]) spans.push({ text: m[2], bold: true });
    else if (m[4]) spans.push({ text: m[4], italic: true });
    else if (m[6]) spans.push({ text: m[6], italic: true });
    else if (m[8]) spans.push({ text: m[8], code: true });
    else if (m[9]) {
      const label = m[10].replace(/\\(.)/g, "$1").replace(/^@/, "");
      const url = m[11];
      spans.push(/^https?:\/\//i.test(url) ? { text: label, url } : { text: label });
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.filter((s) => s.text.length);
}

export function markdownBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      // Blank lines and rules separate blocks; Docs spaces paragraphs itself.
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: Math.min(h[1].length, 3) as 1 | 2 | 3, spans: inlineSpans(h[2]) });
      continue;
    }
    const check = /^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/.exec(line);
    if (check) {
      blocks.push({ kind: "check", spans: inlineSpans(check[2] || " ") });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: "bullet", spans: inlineSpans(bullet[1]) });
      continue;
    }
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (num) {
      blocks.push({ kind: "number", spans: inlineSpans(num[1]) });
      continue;
    }
    blocks.push({ kind: "para", spans: inlineSpans(line.replace(/^>\s?/, "")) });
  }
  return blocks;
}

const PRESET = { bullet: "BULLET_DISC_CIRCLE_SQUARE", number: "NUMBERED_DECIMAL_ALPHA_ROMAN", check: "BULLET_CHECKBOX" } as const;

/**
 * The batchUpdate that writes `md` into an empty document: one insertText at
 * index 1, then paragraph and text styles over the ranges it made. Indexes
 * are UTF-16 code units, as JavaScript counts them.
 */
export function markdownToDocsRequests(md: string, opts: { at?: number } = {}): DocsRequest[] {
  const start = opts.at ?? 1;
  const blocks = markdownBlocks(md);
  if (!blocks.length) return [];
  let text = "";
  const styles: DocsRequest[] = [];
  const lists: Array<{ kind: keyof typeof PRESET; from: number; to: number }> = [];
  for (const b of blocks) {
    const from = start + text.length;
    for (const s of b.spans) {
      const at = start + text.length;
      text += s.text;
      const range = { startIndex: at, endIndex: at + s.text.length };
      const style: Record<string, unknown> = {};
      if (s.bold) style.bold = true;
      if (s.italic) style.italic = true;
      if (s.code) style.weightedFontFamily = { fontFamily: "Roboto Mono" };
      if (s.url) style.link = { url: s.url };
      const fields = Object.keys(style);
      if (fields.length) styles.push({ updateTextStyle: { range, textStyle: style, fields: fields.join(",") } });
    }
    text += "\n";
    const to = start + text.length;
    if (b.kind === "heading") {
      styles.push({ updateParagraphStyle: { range: { startIndex: from, endIndex: to }, paragraphStyle: { namedStyleType: `HEADING_${b.level}` }, fields: "namedStyleType" } });
    } else if (b.kind !== "para") {
      // Neighbouring items of the same kind make one list.
      const prev = lists[lists.length - 1];
      if (prev && prev.kind === b.kind && prev.to === from) prev.to = to;
      else lists.push({ kind: b.kind, from, to });
    }
  }
  return [
    { insertText: { location: { index: start }, text } },
    ...styles,
    ...lists.map((l) => ({ createParagraphBullets: { range: { startIndex: l.from, endIndex: l.to }, bulletPreset: PRESET[l.kind] } })),
  ];
}

// ---------- Google: what may be asked of Drive and Docs ----------

export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
export const DOCS_API_URL = "https://docs.googleapis.com/v1/documents";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DOC_MIME = "application/vnd.google-apps.document";
/** The folder Athena makes in the owner's Drive and puts every doc in. */
export const ATHENA_FOLDER = "Athena";

const DOC_REQUEST_TYPES = new Set(["insertText", "updateParagraphStyle", "updateTextStyle", "createParagraphBullets", "deleteParagraphBullets", "deleteContentRange"]);
/** Google's file ids: letters, digits, - and _. */
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export interface GoogleDocsRequest {
  method: "GET" | "POST" | "PATCH";
  url: string;
  body?: unknown;
}

const keysIn = (o: unknown, allowed: string[]) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => allowed.includes(k));

/**
 * Null when this request is one Athena may make, else why not. `owned` is
 * every file id Athena made (its folder and its docs): only those can be
 * filled, read back or trashed. drive.file already stops Google showing
 * Athena anything else; this makes sure the code never asks.
 */
export function googleDocsRequestProblem(req: GoogleDocsRequest, owned: ReadonlySet<string>): string | null {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return "not Google's API";
  const here = `${url.origin}${url.pathname}`;
  // Query parameters: a folder lookup's q and fields, otherwise only which fields come back.
  const params = [...url.searchParams.keys()];
  const listing = req.method === "GET" && here === DRIVE_FILES_URL;
  if (!params.every((k) => k === "fields" || (listing && (k === "q" || k === "pageSize")))) return "not a request Athena makes";
  // Find Athena's folder (drive.file lists only what Athena made).
  if (req.method === "GET" && here === DRIVE_FILES_URL) {
    const query = url.searchParams.get("q") ?? "";
    return query.includes(`mimeType='${FOLDER_MIME}'`) && query.includes(`name='${ATHENA_FOLDER}'`) ? null : "only Athena's folder can be looked up";
  }
  // Make the folder, or a doc inside a folder Athena made.
  if (req.method === "POST" && here === DRIVE_FILES_URL) {
    const b = req.body as { name?: unknown; mimeType?: unknown; parents?: unknown } | undefined;
    if (!keysIn(b, ["name", "mimeType", "parents"]) || typeof b!.name !== "string") return "a new file has a name, a type and a folder, nothing else";
    if (b!.mimeType === FOLDER_MIME) return b!.name === ATHENA_FOLDER && b!.parents === undefined ? null : "the only folder is Athena's";
    if (b!.mimeType !== DOC_MIME) return "only Google Docs are made";
    const parents = b!.parents;
    return Array.isArray(parents) && parents.length === 1 && typeof parents[0] === "string" && owned.has(parents[0]) ? null : "a doc goes in Athena's folder";
  }
  const doc = /^https:\/\/docs\.googleapis\.com\/v1\/documents\/([^/:]+)(:batchUpdate)?$/.exec(here);
  if (doc) {
    const [, id, batch] = doc;
    if (!FILE_ID.test(id) || !owned.has(id)) return "not a doc Athena made";
    if (!batch) return req.method === "GET" ? null : "not a doc request";
    if (req.method !== "POST") return "not a doc request";
    const b = req.body as { requests?: unknown } | undefined;
    if (!keysIn(b, ["requests"]) || !Array.isArray(b!.requests) || !b!.requests.length) return "an update is a list of changes";
    for (const r of b!.requests) {
      if (!r || typeof r !== "object" || Object.keys(r).length !== 1 || !DOC_REQUEST_TYPES.has(Object.keys(r)[0])) return "only text and formatting change";
    }
    return null;
  }
  // Trash (Undo), take back out of the trash, or rename: on a file Athena made.
  const file = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/]+)$/.exec(here);
  if (file && req.method === "PATCH") {
    if (!FILE_ID.test(file[1]) || !owned.has(file[1])) return "not a file Athena made";
    // One field at a time: trashed (Undo, or back again) or name (sent again with a new title).
    const b = req.body as { trashed?: unknown; name?: unknown } | undefined;
    if (!b || typeof b !== "object" || Object.keys(b).length !== 1) return "only the name or trashed can change";
    if ("trashed" in b) return typeof b.trashed === "boolean" ? null : "only the name or trashed can change";
    return typeof b.name === "string" && b.name.length <= 200 ? null : "only the name or trashed can change";
  }
  return "Athena doesn't make that request to Google";
}

/** A doc's own link, only when it's docs.google.com/document/d/<id>/…: anything else a reply says isn't shown. */
export function docsLink(url: unknown, id: string): string {
  if (typeof url === "string") {
    const m = /^https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)(?:\/[^\s?#]*)?(?:\?[^\s#]*)?$/.exec(url);
    if (m && m[1] === id) return url;
  }
  return `https://docs.google.com/document/d/${id}/edit`;
}

// ---------- Notion: create, and change only what Athena made ----------

/** The only Notion tools Athena writes with. Exact names: notion-update-page-properties or anything else isn't one. */
export const NOTION_CREATE_TOOL = "notion-create-pages";
export const NOTION_UPDATE_TOOL = "notion-update-page";
/** Undo only: move a page Athena made under its own "Removed by Athena" page. */
export const NOTION_MOVE_TOOL = "notion-move-pages";
export const NOTION_WRITE_TOOLS: readonly string[] = [NOTION_CREATE_TOOL, NOTION_UPDATE_TOOL, NOTION_MOVE_TOOL];
/** The page Undo moves pages under, made by Athena under the chosen parent the first time it's needed. */
export const REMOVED_PAGE_TITLE = "Removed by Athena";
/** What an update to a page Athena made may do: add to it, rewrite what Athena wrote, or retitle it. */
const UPDATE_COMMANDS = new Set(["insert_content_after", "replace_content", "update_properties"]);

/** A Notion id with or without dashes, or a notion.so link ending in one: the 32 hex digits, lower case. */
export function notionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?:[?#][^\s]*)?$/i.exec(value.trim());
  return m ? m.slice(1).join("").toLowerCase() : null;
}

const onlyTitle = (props: unknown) => props === undefined || (keysIn(props, ["title"]) && typeof (props as { title: unknown }).title === "string");

/**
 * Null when this Notion call is allowed, else why not. A new page must go
 * straight under the parent the owner picked; an update must be to a page
 * Athena made (`own`), with one of three commands; a move (Undo) must take
 * pages Athena made and put them under Athena's own "Removed by Athena"
 * page (`removedId`). There's no duplicate, delete or database tool at all.
 */
export function notionWriteProblem(name: string, args: unknown, rules: { parentId: string | null; own: ReadonlySet<string>; removedId?: string | null }): string | null {
  if (!NOTION_WRITE_TOOLS.includes(name)) return `Athena doesn't call ${name} in Notion`;
  if (!rules.parentId) return "Pick a parent page in Notion first";
  const mine = (v: unknown) => {
    const id = notionId(v);
    return !!id && [...rules.own].some((o) => notionId(o) === id);
  };
  if (name === NOTION_MOVE_TOOL) {
    const a = args as { page_or_database_ids?: unknown; new_parent?: unknown };
    if (!keysIn(a, ["page_or_database_ids", "new_parent"])) return "not a move Athena makes";
    const ids = a.page_or_database_ids;
    if (!Array.isArray(ids) || ids.length !== 1 || !mine(ids[0])) return "Athena only moves pages it made";
    if (!rules.removedId || !mine(rules.removedId) || notionId(ids[0]) === notionId(rules.removedId)) return "pages only move under Removed by Athena";
    const p = a.new_parent as { page_id?: unknown; type?: unknown };
    if (!keysIn(p, ["page_id", "type"]) || (p.type !== undefined && p.type !== "page_id") || notionId(p.page_id) !== notionId(rules.removedId)) return "pages only move under Removed by Athena";
    return null;
  }
  if (name === NOTION_CREATE_TOOL) {
    const a = args as { parent?: unknown; pages?: unknown };
    if (!keysIn(a, ["parent", "pages"])) return "a new page has a parent and its content, nothing else";
    if (!keysIn(a.parent, ["page_id"]) || notionId((a.parent as { page_id?: unknown }).page_id) !== notionId(rules.parentId)) return "new pages go under the page you picked";
    if (!Array.isArray(a.pages) || a.pages.length !== 1) return "one page at a time";
    const page = a.pages[0] as { properties?: unknown; content?: unknown };
    if (!keysIn(page, ["properties", "content"]) || !onlyTitle(page.properties) || (page.content !== undefined && typeof page.content !== "string")) return "a page is a title and Markdown";
    return null;
  }
  const a = args as { data?: unknown };
  if (!keysIn(a, ["data"])) return "not an update Athena makes";
  const d = a.data as { page_id?: unknown; command?: unknown; properties?: unknown; new_str?: unknown };
  if (!keysIn(d, ["page_id", "command", "properties", "new_str"])) return "not an update Athena makes";
  if (!mine(d.page_id)) return "Athena only changes pages it made";
  if (typeof d.command !== "string" || !UPDATE_COMMANDS.has(d.command)) return "only adding to a page Athena made";
  if (d.command === "update_properties" ? !onlyTitle(d.properties) || d.new_str !== undefined : d.properties !== undefined || typeof d.new_str !== "string") return "only the title or the text";
  return null;
}

/** The page a create call made, from the server's reply: its id and link. */
export function notionCreated(text: string): { id: string; url: string } | null {
  const url = /https:\/\/(?:www\.)?notion\.so\/[^\s"'<>)\]]*[0-9a-f]{32}/i.exec(text)?.[0];
  const id = notionId(url ?? "") ?? notionId(/"id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? "");
  if (!id) return null;
  return { id, url: url ?? `https://www.notion.so/${id}` };
}

/** Only ever link to notion.so. */
export function notionLink(url: unknown, id: string): string {
  if (typeof url === "string" && /^https:\/\/(?:www\.)?notion\.so\//i.test(url) && notionId(url) === notionId(id)) return url;
  return `https://www.notion.so/${notionId(id) ?? ""}`;
}
