/**
 * The chosen theme and the owner's own themes, the same on every device
 * (docs: architecture/theming). One row in the settings table, `theme`:
 * { choice, themes }. Plain, not sealed: colours, numbers and the names the
 * owner gave their themes, nothing about their life.
 *
 * Everything is read through lib/theme.ts on the way in and on the way out,
 * so what's stored is only what the reader keeps, whatever a client sends.
 *
 * Themes added from someone else (lib/theme-share.ts) ride in the same row,
 * among the owner's own, each with a plain `origin`: the Community listing's
 * id and hash, its author's username and version, and whether the owner has
 * changed it. They count towards the same 40. Adding one at 40 is refused
 * with words, and the preview says so first.
 *
 *  - `addSharedTheme`: what the `#/add` screen's Add does for a theme.
 *  - `replaceSharedTheme`: Update, from a newer Community listing.
 *  - `exportThemeFor`: POST /api/themes/:id/share, one the owner made, as a
 *    file, after the scrub and the personal-data check.
 */
import { AthenaInputError, q } from "./db";
import { OWN_THEMES_MAX, isThemeChoice, readOwnThemes, readThemeChoice, type OwnTheme, type ThemeChoice } from "./theme";
import { ATHENA_THEME_NAMES, addThemeTo, exportTheme, replaceThemeIn, serialiseSharedTheme, themeFromListing, themesFollowing, THEME_FILE, type AddedTheme, type SharedTheme, type ThemeExport, type ThemeListing } from "./theme-share";
import { ShareFormatError, type KnownTerm } from "./team-share";

const KEY = "theme";

export interface ThemePrefs {
  choice: ThemeChoice;
  themes: OwnTheme[];
}

/** What's stored, checked: a choice that names a theme that's gone is Athena's own. */
export function readThemePrefs(raw: unknown): ThemePrefs {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const themes = readOwnThemes(r.themes);
  let choice = readThemeChoice(r.choice);
  if (choice.startsWith("own:") && !themes.some((t) => `own:${t.id}` === choice)) choice = "athena";
  return { choice, themes };
}

/** The row as stored. Throws when the database can't be read, so nothing is saved over themes that didn't load. */
async function loadStrict(): Promise<ThemePrefs> {
  const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [KEY]);
  return readThemePrefs(row?.value);
}

export async function loadThemePrefs(): Promise<ThemePrefs> {
  try {
    return await loadStrict();
  } catch {
    return { choice: "athena", themes: [] };
  }
}

export async function saveThemePrefs(raw: unknown): Promise<ThemePrefs> {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!r || !isThemeChoice(r.choice) || !Array.isArray(r.themes)) throw new AthenaInputError("theme: { choice, themes }");
  if (r.themes.length > OWN_THEMES_MAX) throw new AthenaInputError(`theme: at most ${OWN_THEMES_MAX} themes of your own`);
  const prefs = readThemePrefs(r);
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(prefs)],
  );
  return prefs;
}

// ---------- themes someone else shared ----------

type Listing = { id: string; hash: string; version?: string };
type Saved = AddedTheme & { prefs: ThemePrefs };

function asInput<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
}

/**
 * Add a shared theme among the owner's own: read again, never trusted, under a free name, marked by where it came
 * from. The theme in use changes only with `use`. Throws AthenaInputError with words (at 40 themes too).
 */
export async function addSharedTheme(shared: SharedTheme, catalogue?: Listing, opts: { use?: boolean } = {}): Promise<Saved> {
  const prefs = await loadStrict();
  const got = asInput(() => addThemeTo(prefs, shared, catalogue, { use: opts.use, builtIn: ATHENA_THEME_NAMES }));
  return { ...got.added, prefs: await saveThemePrefs(got.list) };
}

/**
 * Update a theme added from Community: over it while the owner hasn't changed it (its name stays), beside it once
 * they have. Throws AthenaInputError with words.
 */
export async function replaceSharedTheme(id: string, shared: SharedTheme, catalogue: Listing): Promise<Saved> {
  const prefs = await loadStrict();
  const got = asInput(() => replaceThemeIn(prefs, id, shared, catalogue as ThemeListing, { builtIn: ATHENA_THEME_NAMES }));
  return { ...got.added, prefs: await saveThemePrefs(got.list) };
}

/** The theme here that follows a listing, for the Add screen's "You already have this". */
export async function themeListingHere(catalogueId: string): Promise<{ id: string; version: string | null; hash: string | null; changed: boolean } | null> {
  return themeFromListing(await loadStrict(), catalogueId);
}

/** Added themes that follow a listing, for Community's update check. A theme never runs, so none is "on". */
export async function themesFromCommunity(): Promise<ReturnType<typeof themesFollowing>> {
  return themesFollowing(await loadThemePrefs());
}

/** An added theme's tier here: always 1 (lib/reach.ts reachOfTheme), or null when it's gone. */
export async function themeTier(id: string): Promise<1 | null> {
  return (await loadThemePrefs()).themes.some((t) => t.id === id) ? 1 : null;
}

/**
 * One of the owner's own themes as a file to share. `raw` is the request: `{ edits?, fine? }`. Athena's built-in themes
 * aren't in the row, and a theme added from someone else can't go. Throws AthenaInputError with words.
 */
export async function exportThemeFor(id: string, raw: Record<string, unknown>, opts: { hosts: string[]; known?: KnownTerm[] }): Promise<ThemeExport> {
  const own = (await loadStrict()).themes.find((t) => t.id === id);
  if (!own) throw new AthenaInputError("No such theme. Athena's own themes are in every Athena already: share one you made.", 404);
  if (own.origin) throw new AthenaInputError("Someone else shared that theme with you. Share only themes you made.");
  const e = (raw.edits && typeof raw.edits === "object" ? raw.edits : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const fine = Array.isArray(raw.fine) ? raw.fine.filter((f): f is string => typeof f === "string").slice(0, 200) : [];
  const known = opts.known ?? (await (await import("./team-share-store")).knownTerms());
  return asInput(() => exportTheme(own.theme, { ownHosts: opts.hosts, known, edits: { name: str(e.name, 200), summary: str(e.summary, 800), version: str(e.version, 20), author: str(e.author, 40) }, fine }));
}

/** The download: <slug>/theme.json in a zip. */
export async function themeZip(x: ThemeExport): Promise<Uint8Array> {
  const { writeSkillZip } = await import("./skill-zip");
  return writeSkillZip([{ path: `${x.slug}/${THEME_FILE}`, text: serialiseSharedTheme(x.shared) }]);
}

export type { OwnTheme };
