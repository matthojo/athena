/**
 * Athena's one link syntax, shared by the server (content-link sync, export)
 * and the PWA (editor, plain-text projections). Pure functions, no imports.
 *
 *   [@Priya Shah](athena://person/<uuid>)
 *   [@Dishoom](athena://place/<uuid>)
 *   [@Netlify](athena://organisation/<uuid>)
 *   [@Mum's birthday](athena://event/<uuid>)
 *   [Q3 planning](athena://note/<uuid>)
 *   [@Château Musar](athena://record/<uuid>)   one of the owner's own records (a wine, a plant…)
 *   [@Green dress](athena://saved/<uuid>)      something in Saved (saved_items)
 *   [@Book the dentist](athena://todo/<uuid>)  a to-do (commitments)
 *   [@The Bear](athena://watch/<uuid>)         a Watch & read title (reading_items)
 *
 * It is ordinary Markdown link syntax, so any Markdown renderer degrades
 * gracefully, agents can write it by hand, and keyword search still matches
 * the visible label. Entity labels conventionally start with "@"; note
 * labels don't.
 *
 * A link may carry how it's shown in the Markdown link title (rich links):
 *
 *   [@Priya Shah](athena://person/<uuid> "card")
 *   [A slow walk](https://example.com/walk "embed")
 *
 * Modes: mention, link, card, embed. No title means the default: Mention for
 * athena:// links, Link for web links. Things in Athena never embed (their
 * card is live), so "embed" on an athena:// link reads and writes as "card".
 * The default mode is never written, so a link without a mode stays exactly
 * as it was.
 */

export const LINK_KINDS = ["person", "place", "organisation", "event", "note", "project", "record", "saved", "todo", "watch"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_MODES = ["mention", "link", "card", "embed"] as const;
export type LinkMode = (typeof LINK_MODES)[number];

export interface AthenaLink {
  kind: LinkKind;
  id: string;
  /** Visible label as written, without Markdown escapes. */
  label: string;
  /** How it's shown, when the link says (its title). Absent means the default, Mention. */
  mode?: LinkMode;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const KINDS = LINK_KINDS.join("|");
/** Label allows backslash-escaped brackets, e.g. [@A \[work\]](athena://...). */
const LABEL = `\\[((?:\\\\.|[^\\]\\\\\\n])*)\\]`;
/** An optional Markdown link title, "…" or '…', after the address: where the mode lives. Any title is found; only a mode means anything. */
const TITLE = `(?:[ \\t]+(?:"((?:\\\\.|[^"\\\\\\n])*)"|'((?:\\\\.|[^'\\\\\\n])*)'))?[ \\t]*`;
/** Groups: 1 label, 2 kind, 3 id, 4 or 5 the title (double or single quoted). */
const LINK_SOURCE = `${LABEL}\\(athena://(${KINDS})/(${UUID})${TITLE}\\)`;

/** A fresh global regex each call — global regexes carry lastIndex state. */
export function athenaLinkRegex(): RegExp {
  return new RegExp(LINK_SOURCE, "g");
}

/** Anchored at the start of the string — what an inline tokenizer needs. */
export const ATHENA_LINK_START = new RegExp(`^${LINK_SOURCE}`);

export function unescapeLabel(raw: string): string {
  return raw.replace(/\\([\\\[\]])/g, "$1");
}

export function escapeLabel(label: string): string {
  return label.replace(/[\\\[\]]/g, (c) => `\\${c}`).replace(/\n/g, " ");
}

export function athenaUrl(kind: LinkKind, id: string): string {
  return `athena://${kind}/${id}`;
}

/** The mode a link shows in when its title says nothing: Mention for things in Athena, Link for web pages. */
export function defaultMode(target: "athena" | "web"): LinkMode {
  return target === "athena" ? "mention" : "link";
}

/** The modes a link can take. Things in Athena never embed; a web page can be anything (Embed only where lib/embeds.ts finds a player). */
export function modesFor(target: "athena" | "web"): readonly LinkMode[] {
  return target === "athena" ? (["mention", "link", "card"] as const) : LINK_MODES;
}

/** A Markdown link title as a mode, or undefined when it isn't one. Case and spaces don't matter. */
export function parseLinkMode(title: string | null | undefined): LinkMode | undefined {
  const t = (title ?? "").trim().toLowerCase();
  return (LINK_MODES as readonly string[]).includes(t) ? (t as LinkMode) : undefined;
}

/** The mode as it should be written for this target: undefined for the default (nothing is written), card for an athena:// embed. */
function writtenMode(target: "athena" | "web", mode: LinkMode | null | undefined): LinkMode | undefined {
  if (!mode || !(LINK_MODES as readonly string[]).includes(mode)) return undefined;
  const m = target === "athena" && mode === "embed" ? "card" : mode;
  return m === defaultMode(target) ? undefined : m;
}

const titlePart = (mode: LinkMode | undefined) => (mode ? ` "${mode}"` : "");

/** `[label](athena://kind/id)`, with ` "mode"` when the mode isn't the default. */
export function formatAthenaLink(kind: LinkKind, id: string, label: string, mode?: LinkMode | null): string {
  return `[${escapeLabel(label)}](${athenaUrl(kind, id)}${titlePart(writtenMode("athena", mode))})`;
}

/** The mode a link shows in: what it says, or the default. */
export function linkMode(link: AthenaLink | WebLink): LinkMode {
  return link.mode ?? defaultMode("kind" in link ? "athena" : "web");
}

/** Only the mode a regex match's title gives, as parse results carry it (no key at all for the default). */
function modeOf(target: "athena" | "web", dq: string | undefined, sq: string | undefined): { mode?: LinkMode } {
  const m = writtenMode(target, parseLinkMode(dq ?? sq));
  return m ? { mode: m } : {};
}

/** Parse "athena://person/<uuid>" into its parts, or null. */
export function parseAthenaUrl(url: string): { kind: LinkKind; id: string } | null {
  const m = new RegExp(`^athena://(${KINDS})/(${UUID})$`).exec(url.trim());
  return m ? { kind: m[1] as LinkKind, id: m[2].toLowerCase() } : null;
}

/** Every athena:// link in a Markdown body, in order (duplicates kept). */
export function parseAthenaLinks(markdown: string): AthenaLink[] {
  const out: AthenaLink[] = [];
  for (const m of markdown.matchAll(athenaLinkRegex())) {
    out.push({ kind: m[2] as LinkKind, id: m[3].toLowerCase(), label: unescapeLabel(m[1]), ...modeOf("athena", m[4], m[5]) });
  }
  return out;
}

/** Distinct `${kind}:${id}` targets linked from a body — what content-link sync stores. */
export function contentLinkKeys(markdown: string, self?: { kind: LinkKind; id: string }): string[] {
  const keys = new Set<string>();
  for (const link of parseAthenaLinks(markdown)) {
    if (self && link.kind === self.kind && link.id === self.id.toLowerCase()) continue;
    keys.add(`${link.kind}:${link.id}`);
  }
  return [...keys];
}

/**
 * What a link kind is called in the graph (`edges`, lib/db.ts EntityType):
 * the same, except a to-do is a `commitment` and a Watch & read title a
 * `reading` item, after their tables. `linkKindOf` goes back.
 */
export const EDGE_KIND = { todo: "commitment", watch: "reading" } as const;
type EdgeRenamed = keyof typeof EDGE_KIND;
export type EdgeKind = Exclude<LinkKind, EdgeRenamed> | (typeof EDGE_KIND)[EdgeRenamed];

export function edgeKindOf(kind: LinkKind): EdgeKind {
  return (EDGE_KIND as Record<string, EdgeKind>)[kind] ?? (kind as EdgeKind);
}

export function linkKindOf(kind: EdgeKind): LinkKind {
  return kind === "commitment" ? "todo" : kind === "reading" ? "watch" : kind;
}

/** contentLinkKeys with each kind as the graph names it (`commitment:<id>` for a to-do). */
export function contentEdgeKeys(markdown: string, self?: { kind: EdgeKind; id: string }): string[] {
  const keys = new Set<string>();
  for (const link of parseAthenaLinks(markdown)) {
    const kind = edgeKindOf(link.kind);
    if (self && kind === self.kind && link.id === self.id.toLowerCase()) continue;
    keys.add(`${kind}:${link.id}`);
  }
  return [...keys];
}

/** Replace each athena:// link with whatever `fn` returns (e.g. "@Priya Shah" or "[[Priya Shah]]"). */
export function replaceAthenaLinks(markdown: string, fn: (link: AthenaLink) => string): string {
  return markdown.replace(athenaLinkRegex(), (_m, label: string, kind: string, id: string, dq: string | undefined, sq: string | undefined) =>
    fn({ kind: kind as LinkKind, id: id.toLowerCase(), label: unescapeLabel(label), ...modeOf("athena", dq, sq) }),
  );
}

// ---------- Web links ----------

export interface WebLink {
  /** The address as written (http or https). */
  url: string;
  /** Visible label as written, without Markdown escapes. */
  label: string;
  /** How it's shown, when the link says (its title). Absent means the default, Link. */
  mode?: LinkMode;
}

/** An http(s) address with at most one level of balanced brackets, as Wikipedia's have. No spaces or angle brackets. */
const WEB_URL = `(https?://(?:[^\\s()<>"]|\\([^\\s()<>"]*\\))+)`;
/** Groups: 1 label, 2 url, 3 or 4 the title. Not an image (`![alt](…)`). */
const WEB_LINK_SOURCE = `(?<!!)${LABEL}\\(${WEB_URL}${TITLE}\\)`;

/** A fresh global regex for web links (`[label](https://… "mode")`) each call. */
export function webLinkRegex(): RegExp {
  return new RegExp(WEB_LINK_SOURCE, "g");
}

/** Anchored at the start of the string, for an inline tokenizer. */
export const WEB_LINK_START = new RegExp(`^${WEB_LINK_SOURCE.replace("(?<!!)", "")}`);

/**
 * The address as it goes into Markdown: characters that would end the link
 * early (spaces, brackets that don't pair, quotes, angle brackets) are
 * percent-encoded. Anything else is left as written.
 */
export function escapeLinkUrl(url: string): string {
  const out = url.trim().replace(/[\s<>"]/g, (c) => encodeURIComponent(c));
  // Keep one level of paired brackets (Wikipedia); encode the rest.
  let depth = 0;
  let res = "";
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === "(") {
      const close = out.indexOf(")", i + 1);
      const inner = close > -1 ? out.slice(i + 1, close) : "";
      if (depth === 0 && close > -1 && !inner.includes("(")) {
        depth = 1;
        res += c;
      } else res += "%28";
    } else if (c === ")") {
      if (depth === 1) {
        depth = 0;
        res += c;
      } else res += "%29";
    } else res += c;
  }
  return res;
}

/** `[label](https://…)`, with ` "mode"` when the mode isn't the default (Link). Only http(s) addresses; anything else throws. */
export function formatWebLink(url: string, label: string, mode?: LinkMode | null): string {
  const safe = escapeLinkUrl(url);
  if (!/^https?:\/\//i.test(safe)) throw new Error("A web link needs an http or https address");
  return `[${escapeLabel(label)}](${safe}${titlePart(writtenMode("web", mode))})`;
}

/** Every web link in a Markdown body, in order (duplicates kept). Images aren't links. */
export function parseWebLinks(markdown: string): WebLink[] {
  const out: WebLink[] = [];
  for (const m of markdown.matchAll(webLinkRegex())) {
    out.push({ url: m[2], label: unescapeLabel(m[1]), ...modeOf("web", m[3], m[4]) });
  }
  return out;
}

// ---------- Links Athena wrote ----------

/**
 * Text a model wrote (an Ask reply, an answer, the briefing): every web
 * link's mode is dropped, so it is a plain link wherever it's shown and no
 * page is ever read to preview it. athena:// links are left as they are.
 */
export function plainWebLinks(text: string): string {
  return text.replace(webLinkRegex(), (_m, label: string, url: string) => `[${label}](${url})`);
}

/**
 * Text a model wrote into a note the owner wrote (save_note with a note id): every web link's mode is dropped, as
 * plainWebLinks does, except a link whose address already had that same mode in the note before (the owner's own
 * choice, kept as it was). So a model's edit can't make Athena fetch a page to preview it.
 */
export function plainNewWebLinks(text: string, before: string): string {
  const had = new Set(parseWebLinks(before).flatMap((l) => (l.mode ? [`${l.mode} ${l.url}`] : [])));
  return text.replace(webLinkRegex(), (whole: string, label: string, url: string, dq?: string, sq?: string) => {
    const mode = modeOf("web", dq, sq).mode;
    return mode && had.has(`${mode} ${url}`) ? whole : `[${label}](${url})`;
  });
}

/** A note the owner wrote in the app. Anything else (a collection, the assistant, a Shortcut, an agent) is Athena's or someone else's words. */
export function ownerWroteNote(source: string | null | undefined): boolean {
  return source === "manual" || source === "app";
}

/**
 * A note's body after a model wrote into it (save_note, add_to_list, an assignment's work, an agent's update_note):
 * in a note the owner wrote, links the model added are plain (plainNewWebLinks); anywhere else, as written. Every
 * tool through which a model writes into an existing note goes through this. Pure.
 */
export function modelWroteInto(note: { source?: string | null; body: string }, after: string): string {
  return ownerWroteNote(note.source) ? plainNewWebLinks(after, note.body) : after;
}

// ---------- The owner's choices in a note Athena wrote (migration 0059, lib/note-link-choices.ts) ----------

/** The modes that load a preview, and so need the owner's say in a note Athena wrote. */
export const CHOICE_MODES = ["card", "mention", "embed"] as const;
export type ChoiceMode = (typeof CHOICE_MODES)[number];

/** "For this address, in this note, I chose this mode." Kept beside the note, never in its Markdown. */
export interface LinkChoice {
  url: string;
  mode: ChoiceMode;
}

export const MAX_LINK_CHOICES = 200;

/** A choice as sent to the server, checked: an http(s) address and one of the modes. Null for anything else. */
export function cleanLinkChoice(raw: unknown): LinkChoice | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2048) return null;
  return (CHOICE_MODES as readonly string[]).includes(o.mode as string) ? { url, mode: o.mode as ChoiceMode } : null;
}

/** The list with this address set to `mode`, or taken out (`mode` null). The newest stay when it's full. */
export function withLinkChoice(list: readonly LinkChoice[], url: string, mode: ChoiceMode | null): LinkChoice[] {
  const rest = list.filter((c) => c.url !== url);
  return (mode ? [...rest, { url, mode }] : rest).slice(-MAX_LINK_CHOICES);
}

/** Did the owner choose exactly this mode for exactly this address? */
export function linkChosen(choices: readonly LinkChoice[], url: string, mode: unknown): boolean {
  return choices.some((c) => c.url === url && c.mode === mode);
}

/**
 * Which web links in an open note are held (plain, no preview). Every link
 * drawn while the note opens is held, whatever its title or the text around
 * it says: the only way out is `choices` (from the server's table) or the
 * owner changing the link in the editor.
 */
export interface HeldLinks {
  /** Each web address in the body as opened, with the node type and mode it had. */
  urls: Map<string, Set<string>>;
  /** True while the editor draws the body for the first time. */
  opening: boolean;
  /** The owner's stored choices for this note, once they arrive. */
  choices: LinkChoice[];
}

export const newHeldLinks = (): HeldLinks => ({ urls: new Map(), opening: true, choices: [] });

/** Is this web link held? `as` is the node's type and mode ("linkBlock:card"); `mode` its mode alone. Registers it while the note opens. */
export function holdsPreview(state: HeldLinks | null, url: string, as: string, mode?: unknown): boolean {
  if (!state || !url) return false;
  const seen = state.urls.get(url);
  if (state.opening) {
    if (seen) seen.add(as);
    else state.urls.set(url, new Set([as]));
    return !linkChosen(state.choices, url, mode);
  }
  if (!seen) return false;
  if (linkChosen(state.choices, url, mode)) return false;
  if (seen.has(as)) return true;
  // Its mode changed: the owner chose this one.
  state.urls.delete(url);
  return false;
}
