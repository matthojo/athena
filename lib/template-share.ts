/**
 * Shared note templates: one of the owner's templates as a file someone else can add to their own. Pure and shared
 * by the server and the app: the format, its limits and the reader, making one from a template the owner wrote
 * (`exportTemplate`), and a free name for one being added (`freeTemplateName`). The server side is
 * lib/templates-db.ts; the rules for templates themselves are lib/templates.ts.
 *
 * A shared template is a folder, usually on its own:
 *
 *   <slug>/template.json   a name, a one-line summary, the optional header every shared file carries (version,
 *                          author, based_on) and the body
 *
 * The body is what a template is today: Markdown with {{fields}} (lib/templates.ts FIELDS). A field is filled only
 * from the Athena it's used in, from that owner's own records, never from the file; a field that Athena doesn't
 * know stays a blank for them. The file carries nothing else: no id, no starter key, no notes made from it.
 *
 * Reading one (`readSharedTemplate`) treats every word as someone else's, as the other readers do: checked against
 * the template limits, unknown keys dropped, and the body made plain (`plainTemplateBody`): nothing in it can make
 * Athena fetch anything by itself. A web link loses its card, mention or embed mode (lib/links.ts plainWebLinks), a
 * picture becomes a plain link to it, raw HTML tags go, and links into someone else's Athena (athena://) keep only
 * their words. Data only, never code; nothing in the file is a permission.
 */
import { plainWebLinks } from "./links";
import { readHeader, type ShareHeader } from "./share-kinds";
import { TEMPLATE_LIMITS } from "./templates";
import { addRemoved, findPersonal, scrubText, ShareFormatError, type CheckField, type Finding, type KnownTerm, type Removed } from "./team-share";

export const TEMPLATE_SHARE_FORMAT = 1;
export const TEMPLATE_FILE = "template.json";

/** The limits a shared template is read against: a template's own (lib/templates.ts TEMPLATE_LIMITS). */
export const TEMPLATE_SHARE_LIMITS = {
  name: TEMPLATE_LIMITS.name,
  summary: 400,
  body: TEMPLATE_LIMITS.body,
} as const;

export interface SharedTemplate extends ShareHeader {
  format: typeof TEMPLATE_SHARE_FORMAT;
  name: string;
  /** One line on what it's for, for the preview and the template list. */
  summary: string;
  /** Markdown with {{fields}}, made plain. */
  body: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
const fail = (msg: string): never => {
  throw new ShareFormatError(msg);
};

function words(raw: unknown, at: string, max: number, opts: { required?: boolean } = {}): string {
  if (raw === undefined || raw === null) return opts.required ? fail(`${at}: missing`) : "";
  if (typeof raw !== "string") return fail(`${at}: should be text`);
  const v = oneLine(raw);
  if (opts.required && !v) fail(`${at}: missing`);
  if (v.length > max) fail(`${at}: over ${max} characters`);
  return v;
}

/** Line breaks as \n, and no control characters but tabs and line breaks. Pure. */
const cleanText = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

/** Raw HTML tags: <img …>, <iframe …>, </div>. Not an autolink (<https://…>) or words like "<3". */
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>\n]*)?\/?>/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * scrubText over a body, a line at a time, so a line's indent (a nested list item) survives the tidy-up scrubText
 * makes after a cut. Pure.
 */
function scrubBody(text: string, ownHosts: readonly string[]): { text: string; removed: Removed[] } {
  let removed: Removed[] = [];
  const lines = text.split("\n").map((line) => {
    const indent = /^[ \t]*/.exec(line)![0];
    const r = scrubText(line.slice(indent.length), ownHosts);
    removed = addRemoved(removed, r.removed);
    return r.removed.length ? (r.text.trim() ? indent + r.text : "") : line;
  });
  return { text: lines.join("\n"), removed };
}

/**
 * A body with everything that would fetch on its own made plain: a web link's card, mention or embed mode dropped
 * (plainWebLinks), a picture (`![words](address)`) turned into a plain link to it, raw HTML tags and comments
 * taken out, and athena:// links and record ids (someone else's Athena) cut to their words (scrubText). The words
 * themselves stay as written. Pure.
 */
export function plainTemplateBody(text: string): string {
  let s = cleanText(text);
  s = scrubBody(s, []).text;
  s = s.replace(/!\[([^\]\n]*)\](?=[([])/g, "[$1]");
  s = s.replace(HTML_COMMENT, "").replace(HTML_TAG, "");
  return plainWebLinks(s);
}

/** template.json, read and checked. Throws ShareFormatError with words for the owner. Pure. */
export function readSharedTemplate(raw: unknown): SharedTemplate {
  if (!isObj(raw)) throw new ShareFormatError(`That isn't a template: ${TEMPLATE_FILE} should hold an object.`);
  if (raw.format !== TEMPLATE_SHARE_FORMAT) {
    if (typeof raw.format === "number" && raw.format > TEMPLATE_SHARE_FORMAT) throw new ShareFormatError("That template was shared from a newer Athena. Update yours, then try again.");
    throw new ShareFormatError(`That isn't a template Athena can read: ${TEMPLATE_FILE} needs "format": ${TEMPLATE_SHARE_FORMAT}.`);
  }
  const name = words(raw.name, "name", TEMPLATE_SHARE_LIMITS.name, { required: true });
  const summary = words(raw.summary, "summary", TEMPLATE_SHARE_LIMITS.summary);
  if (typeof raw.body !== "string") return fail("body: should be text");
  const cleaned = cleanText(raw.body);
  if (cleaned.length > TEMPLATE_SHARE_LIMITS.body) fail(`body: over ${TEMPLATE_SHARE_LIMITS.body} characters`);
  const body = plainTemplateBody(cleaned).replace(/^\n+/, "").replace(/\s+$/, "");
  if (!body.trim()) fail("body: missing");
  return { format: TEMPLATE_SHARE_FORMAT, ...readHeader(raw), name, summary, body };
}

/** template.json as it's written: two-space JSON with a line at the end. Pure. */
export function serialiseSharedTemplate(t: SharedTemplate): string {
  return `${JSON.stringify(t, null, 2)}\n`;
}

/**
 * A name for a template being added that none of the owner's templates has: "Gratitude page", else
 * "Gratitude page (2)", "(3)"… within the name limit. Names are compared ignoring case and spacing. Pure.
 */
export function freeTemplateName(name: string, taken: Iterable<string>): string {
  const key = (s: string) => oneLine(s).toLowerCase();
  const have = new Set([...taken].map(key));
  const base = oneLine(name).slice(0, TEMPLATE_SHARE_LIMITS.name) || "Shared template";
  if (!have.has(key(base))) return base;
  for (let n = 2; ; n++) {
    const tail = ` (${n})`;
    const next = `${base.slice(0, TEMPLATE_SHARE_LIMITS.name - tail.length).trimEnd()}${tail}`;
    if (!have.has(key(next))) return next;
  }
}

// ---------- making one ----------

/** What exportTemplate needs from the server: the site's own hosts to take out, and the owner's terms to flag. */
export interface TemplateExportContext {
  ownHosts: string[];
  known: KnownTerm[];
  /** The owner's words in the share sheet. They change the file, never the template. */
  edits?: { name?: string; summary?: string; version?: string; author?: string };
  /** Finding ids the owner said are fine to share. */
  fine?: readonly string[];
}

export interface TemplateExport {
  shared: SharedTemplate;
  removed: Removed[];
  /** What looks like the owner's own: `where` holds "name", "summary" or "body". */
  findings: Finding[];
  /** The folder's name: "gratitude-page". */
  slug: string;
}

/** "gratitude-page": a template's folder name. Pure. */
export function templateSlug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "template";
}

/**
 * One of the owner's templates as a file: links into their Athena taken out of every word, the body made plain as
 * any reader would make it, and the personal-data check run over the name, the summary and the body. Nothing else
 * of theirs goes: no id, no notes made from it. The name in the sheet wins over the template's own. Throws
 * ShareFormatError when the result isn't a template Athena can read (no name, an empty body). Pure.
 */
export function exportTemplate(t: { name: string; body: string }, ctx: TemplateExportContext): TemplateExport {
  let removed: Removed[] = [];
  const scrub = (text: string): string => {
    const r = scrubText(text, ctx.ownHosts);
    removed = addRemoved(removed, r.removed);
    return r.text;
  };
  const edits = ctx.edits ?? {};
  const name = oneLine(scrub(oneLine(edits.name ?? t.name).slice(0, TEMPLATE_SHARE_LIMITS.name)));
  const summary = oneLine(scrub(oneLine(edits.summary ?? "").slice(0, TEMPLATE_SHARE_LIMITS.summary)));
  const cut = scrubBody(cleanText(t.body), ctx.ownHosts);
  removed = addRemoved(removed, cut.removed);
  const body = cut.text;
  if (!name) throw new ShareFormatError("Give the template a name first.");
  if (!body.trim()) throw new ShareFormatError("That template is empty. Write something in it first.");
  const shared = readSharedTemplate({ format: TEMPLATE_SHARE_FORMAT, name, summary, body, version: edits.version, author: edits.author });
  const fields: CheckField[] = [
    { field: "name", text: shared.name },
    { field: "summary", text: shared.summary },
    { field: "body", text: shared.body },
  ];
  return { shared, removed, findings: findPersonal(fields, ctx.known, ctx.fine ?? []), slug: templateSlug(shared.name) };
}
