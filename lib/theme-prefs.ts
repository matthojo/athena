/**
 * The chosen theme and the owner's own themes, the same on every device
 * (ARCHITECTURE.md, "Themes"). One row in the settings table, `theme`:
 * { choice, themes }. Plain, not sealed: colours, numbers and the names the
 * owner gave their themes, nothing about their life.
 *
 * Everything is read through lib/theme.ts on the way in and on the way out,
 * so what's stored is only what the reader keeps, whatever a client sends.
 */
import { AthenaInputError, q } from "./db";
import { OWN_THEMES_MAX, isThemeChoice, readOwnThemes, readThemeChoice, type OwnTheme, type ThemeChoice } from "./theme";

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

export async function loadThemePrefs(): Promise<ThemePrefs> {
  try {
    const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [KEY]);
    return readThemePrefs(row?.value);
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
