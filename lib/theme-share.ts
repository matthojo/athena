/**
 * Shared themes: one of the person's own themes as a file someone else can add to theirs. Pure and shared by the
 * server and the app: the format and its reader, making one from a theme the person made (`exportTheme`), and the
 * rules for adding and updating one among the person's own themes (`addThemeTo`, `replaceThemeIn`), which the
 * server (lib/theme-prefs.ts) and sample mode (app/src/db/community.ts) both use.
 *
 * A shared theme is a folder, usually on its own:
 *
 *   <slug>/theme.json   what themeJson() writes (lib/theme.ts): the theme's name, summary, colours, shape, text size
 *                       and chart colours, with the header every shared file carries (version, author, based_on)
 *
 * The two shapes are one. A theme's own JSON already had `format`, `name`, `summary` and `author`; it now writes
 * `format` as the number 1, as the other kinds do, and takes `version`, `author` and `based_on` with the meanings
 * they have in every shared file (lib/share-kinds.ts). The first spelling ("format": "athena-theme", "version": 1)
 * still reads.
 *
 * Reading one (`readSharedTheme`) goes through readTheme() and nothing else: the one reader every theme goes through,
 * the person's own and Athena's built-in ones included. Unknown keys are dropped, every number is clamped, colours are
 * taken only in the safe syntax, and what it dropped or changed is listed (`problems`) so the Add screen can say so.
 * A theme is data, never code: colours, corner radius, density, its own text size and chart colours, for light, dark
 * or both. Never a typeface, and nothing in it loads anything.
 */
import { NAME_MAX, OWN_THEMES_MAX, readTheme, themeJson, newThemeId, type OwnTheme, type Scheme, type Theme, type ThemeChoice, type ThemeOrigin, type ThemeProblem } from "./theme";
import { readHeader, type ShareHeader } from "./share-kinds";
import { addRemoved, findPersonal, scrubText, ShareFormatError, type CheckField, type Finding, type KnownTerm, type Removed } from "./team-share";

export const THEME_SHARE_FORMAT = 1;
export const THEME_FILE = "theme.json";

/**
 * The names of Athena's own theme and its built-in ones (app/src/themes/), which an added theme never takes, so no two
 * tiles in Appearance share a name. app/src/lib/theme.test.ts checks this list against the files.
 */
export const ATHENA_THEME_NAMES: readonly string[] = ["Athena", "Clay", "Harbour", "High contrast", "Mist"];

export interface SharedTheme extends ShareHeader {
  format: typeof THEME_SHARE_FORMAT;
  name: string;
  /** One line on what it looks like. */
  summary: string;
  /** The theme as readTheme() gave it. Its author is the header's, or none. */
  theme: Theme;
  /** What reading it dropped or changed, for the Add screen to say. */
  problems: ThemeProblem[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

const READ_ERRORS: Record<string, string> = {
  "not-json": `${THEME_FILE} isn't valid JSON.`,
  "too-big": `${THEME_FILE} is too big to be a theme.`,
  "not-a-theme": `That isn't a theme Athena can read: ${THEME_FILE} needs "format": ${THEME_SHARE_FORMAT}, a name and its colours.`,
  "newer-version": "That theme was shared from a newer Athena. Update yours, then try again.",
  "no-name": "name: missing",
};

/** theme.json, read and checked by readTheme() and the shared header's rules. Throws ShareFormatError with words for the person. Pure. */
export function readSharedTheme(raw: unknown): SharedTheme {
  if (!isObj(raw)) throw new ShareFormatError(`That isn't a theme: ${THEME_FILE} should hold an object.`);
  const read = readTheme(raw);
  if (!read.theme) throw new ShareFormatError(READ_ERRORS[read.error ?? "not-a-theme"]);
  const header = readHeader(raw);
  const problems = [...read.problems];
  // The header's fields are checked as every shared file's are; one that doesn't fit is left out, and said.
  if (raw.format !== "athena-theme" && raw.version !== undefined && !header.version) problems.push({ path: "version", why: "not-text" });
  if (raw.author !== undefined && !header.author) problems.push({ path: "author", why: "not-a-handle" });
  if (raw.based_on !== undefined && !header.based_on) problems.push({ path: "based_on", why: "unknown" });
  const theme: Theme = { ...read.theme };
  delete theme.author;
  if (header.author) theme.author = header.author;
  return { format: THEME_SHARE_FORMAT, ...header, name: theme.name, summary: theme.summary ?? "", theme, problems };
}

/** theme.json as it's written: what themeJson() writes, with the header, and a line at the end. Pure. */
export function serialiseSharedTheme(s: Pick<SharedTheme, "theme" | "version" | "author" | "based_on">): string {
  return `${themeJson(s.theme, { version: s.version, author: s.author, based_on: s.based_on })}\n`;
}

/**
 * A name for a theme being added that none of the person's themes has: "Ember", else "Ember (2)", "(3)"… within the
 * name limit. Athena's own and built-in theme names count as taken too, so a tile is never named twice. Compared
 * ignoring case and spacing. Pure.
 */
export function freeThemeName(name: string, taken: Iterable<string>): string {
  const key = (s: string) => oneLine(s).toLowerCase();
  const have = new Set([...taken].map(key));
  const base = oneLine(name).slice(0, NAME_MAX).trim() || "Theme";
  if (!have.has(key(base))) return base;
  for (let n = 2; ; n++) {
    const tail = ` (${n})`;
    const next = `${base.slice(0, NAME_MAX - tail.length).trimEnd()}${tail}`;
    if (!have.has(key(next))) return next;
  }
}

/** "ember": a theme's folder name. Pure. */
export function themeSlug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "theme";
}

/** The schemes a theme sets colours for: one, the other or both. None means it keeps Athena's colours in both. Pure. */
export const themeSchemes = (t: Theme): Scheme[] => (["light", "dark"] as const).filter((s) => !!t.colours[s] && Object.keys(t.colours[s]!).length > 0);

/** A few of a theme's colours per scheme, for a row in the Community list: page, card, text, accent and two chart colours. Pure. */
export interface ThemeSwatches {
  light?: string[];
  dark?: string[];
}

export function themeSwatches(t: Theme): ThemeSwatches {
  const out: ThemeSwatches = {};
  for (const s of themeSchemes(t)) {
    const c = t.colours[s]!;
    // Page, card, text and accent in that order (a list's tile reads them by place), then chart colours not already there.
    const base = [c.page, c.surface, c.text, c.accent].filter((x): x is string => !!x);
    const list = [...base, ...(t.chart?.[s] ?? []).filter((x) => !base.includes(x))].slice(0, 6);
    if (list.length) out[s] = list;
  }
  return out;
}

// ---------- making one ----------

/** What exportTheme needs from the server: the site's own hosts to take out, and the person's terms to flag. */
export interface ThemeExportContext {
  ownHosts: string[];
  known: KnownTerm[];
  /** The person's words in the share sheet. They change the file, never the theme. */
  edits?: { name?: string; summary?: string; version?: string; author?: string };
  /** Finding ids the person said are fine to share. */
  fine?: readonly string[];
}

export interface ThemeExport {
  shared: SharedTheme;
  removed: Removed[];
  /** What looks like the person's own: `where` holds "name" or "summary". */
  findings: Finding[];
  /** The folder's name: "ember". */
  slug: string;
}

/**
 * One of the person's own themes as a file: links into their Athena taken out of the name and summary, and the
 * personal-data check run over both. Colours and numbers go as readTheme() wrote them; nothing else of theirs goes
 * (no id, no choice, no other theme, never their own font or text size). The name in the sheet wins over the theme's.
 * Throws ShareFormatError when there's no name. Pure.
 */
export function exportTheme(t: Theme, ctx: ThemeExportContext): ThemeExport {
  let removed: Removed[] = [];
  const scrub = (text: string): string => {
    const r = scrubText(text, ctx.ownHosts);
    removed = addRemoved(removed, r.removed);
    return r.text;
  };
  const edits = ctx.edits ?? {};
  const name = oneLine(scrub(oneLine(edits.name ?? t.name)));
  const summary = oneLine(scrub(oneLine(edits.summary ?? t.summary ?? "")));
  if (!name) throw new ShareFormatError("Give the theme a name first.");
  const draft: Record<string, unknown> = JSON.parse(themeJson({ ...t, name, summary: summary || undefined }, { version: edits.version?.trim(), author: edits.author?.trim().replace(/^@/, "") }));
  // An author or version that doesn't fit the header's rules is left out, as a reader would.
  const shared = readSharedTheme(draft);
  shared.problems = [];
  const fields: CheckField[] = [
    { field: "name", text: shared.name },
    { field: "summary", text: shared.summary },
  ];
  return { shared, removed, findings: findPersonal(fields, ctx.known, ctx.fine ?? []), slug: themeSlug(shared.name) };
}

// ---------- adding one, and updating it ----------

/** The person's themes and choice, as lib/theme-prefs.ts and the app keep them. */
export interface ThemeList {
  choice: ThemeChoice;
  themes: OwnTheme[];
}

/** A Community listing as recorded on an added theme. */
export interface ThemeListing {
  id: string;
  hash: string;
  version?: string | null;
}

/** What adding (or updating) a shared theme did. */
export interface AddedTheme {
  id: string;
  /** The name it's under: its own, or with a number on the end when one of the person's themes has that name. */
  name: string;
  renamed: boolean;
  /** An Update went beside the person's changed copy rather than over it. */
  beside: boolean;
  /** It's the theme in use now ("Add and use"). */
  used: boolean;
}

export const THEMES_FULL = `You have ${OWN_THEMES_MAX} themes, the most Athena keeps. Remove one in Settings, then add this again.`;

/** Room for one more theme among the person's own (added ones count). Pure. */
export const themeRoom = (list: Pick<ThemeList, "themes">): boolean => list.themes.length < OWN_THEMES_MAX;

const LISTING_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^sha256-[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/;

function originOf(shared: SharedTheme, listing?: ThemeListing | null): ThemeOrigin {
  if (listing && (!LISTING_ID.test(listing.id) || !HASH.test(listing.hash))) throw new ShareFormatError("That catalogue listing isn't one Athena can read.");
  const version = (listing?.version ?? shared.version ?? "").trim();
  return { catalogue_id: listing?.id ?? null, hash: listing?.hash ?? null, version: VERSION.test(version) ? version : null, author: shared.author ?? null, changed: false };
}

/** The theme as kept: read again, its author the header's. */
const kept = (shared: SharedTheme, name: string): Theme => {
  const again = readSharedTheme(JSON.parse(serialiseSharedTheme(shared)));
  return { ...again.theme, name };
};

/**
 * Add a shared theme among the person's own: read again, never trusted; marked by where it came from; never over one
 * of theirs (a name in use, theirs or one of Athena's, gets a number); the theme in use changes only with `use`.
 * `builtIn`: the names of Athena's own themes. Throws ShareFormatError (THEMES_FULL at the limit). Pure.
 */
export function addThemeTo(list: ThemeList, raw: SharedTheme, listing?: ThemeListing | null, opts: { use?: boolean; builtIn?: readonly string[]; id?: () => string } = {}): { list: ThemeList; added: AddedTheme } {
  const shared = readSharedTheme(JSON.parse(serialiseSharedTheme(raw)));
  if (!themeRoom(list)) throw new ShareFormatError(THEMES_FULL);
  const name = freeThemeName(shared.name, [...(opts.builtIn ?? []), ...list.themes.map((t) => t.theme.name)]);
  const taken = new Set(list.themes.map((t) => t.id));
  let id = (opts.id ?? newThemeId)();
  while (taken.has(id)) id = newThemeId();
  const entry: OwnTheme = { id, theme: kept(shared, name), origin: originOf(shared, listing) };
  const use = opts.use === true;
  return {
    list: { themes: [...list.themes, entry], choice: use ? `own:${id}` : list.choice },
    added: { id, name, renamed: name !== shared.name, beside: false, used: use },
  };
}

/**
 * Update a theme added from Community to a newer version. While the person hasn't changed it, its name stays and the
 * rest becomes the new version's (and if it's in use, it stays in use). Once they have, theirs is left exactly as it
 * is and stops following the listing, and the new version goes beside it. Throws ShareFormatError. Pure.
 */
export function replaceThemeIn(list: ThemeList, id: string, raw: SharedTheme, listing: ThemeListing, opts: { builtIn?: readonly string[]; id?: () => string } = {}): { list: ThemeList; added: AddedTheme } {
  const at = list.themes.findIndex((t) => t.id === id);
  const had = list.themes[at];
  if (!had?.origin) throw new ShareFormatError("That theme isn't there any more.");
  const shared = readSharedTheme(JSON.parse(serialiseSharedTheme(raw)));
  const origin = originOf(shared, listing);
  if (had.origin.changed) {
    const left: ThemeList = { ...list, themes: list.themes.map((t) => (t.id === id ? { ...t, origin: { ...t.origin!, hash: null } } : t)) };
    const got = addThemeTo(left, shared, listing, opts);
    return { list: got.list, added: { ...got.added, beside: true } };
  }
  const themes = [...list.themes];
  themes[at] = { id, theme: kept(shared, had.theme.name), origin };
  return { list: { ...list, themes }, added: { id, name: had.theme.name, renamed: false, beside: false, used: list.choice === `own:${id}` } };
}

/** The theme here that follows this listing (the newest one added from it), if any: "You already have this". Pure. */
export function themeFromListing(list: Pick<ThemeList, "themes">, catalogueId: string): { id: string; version: string | null; hash: string | null; changed: boolean } | null {
  const from = list.themes.filter((t) => t.origin?.catalogue_id === catalogueId);
  const t = [...from].reverse().find((x) => x.origin!.hash) ?? from[from.length - 1];
  return t ? { id: t.id, version: t.origin!.version, hash: t.origin!.hash, changed: t.origin!.changed } : null;
}

/** Added themes that follow a listing, as Community's update check counts them. A theme never runs, so none is "on". Pure. */
export function themesFollowing(list: Pick<ThemeList, "themes">): Array<{ kind: "theme"; id: string; catalogue_id: string; catalogue_hash: string; catalogue_version: string | null; on: false }> {
  return list.themes.flatMap((t) => (t.origin?.catalogue_id && t.origin.hash ? [{ kind: "theme" as const, id: t.id, catalogue_id: t.origin.catalogue_id, catalogue_hash: t.origin.hash, catalogue_version: t.origin.version, on: false as const }] : []));
}

/**
 * The person saved one of their themes from the editor: an added one they changed is theirs from then on (an Update
 * goes beside it). Compared as themeJson() writes them, so saving without a change changes nothing. Pure.
 */
export function markChanged(before: OwnTheme | undefined, after: Theme): ThemeOrigin | undefined {
  if (!before?.origin) return undefined;
  if (before.origin.changed || themeJson(before.theme) === themeJson({ ...after, author: before.theme.author })) return before.origin;
  return { ...before.origin, changed: true };
}
