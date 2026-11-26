/**
 * Themes in the app: which one is chosen, the person's own, and putting the
 * chosen one on the page (docs: architecture/theming).
 *
 * Where they live. The choice and the person's own themes are one row in the
 * server's settings table (`theme`, GET/PUT /api/settings), like the Days
 * mood style, so they follow the person to every device. Each device keeps a
 * copy: the choice and themes (so Settings opens offline), and the chosen
 * theme already worked out (athena.theme.paint), which the first-paint script
 * reads before any stylesheet loads. A change made offline is marked unsent
 * and goes up the next time the app opens online; otherwise the server's
 * copy wins when the app loads. Sample mode keeps all of it on the device.
 *
 * Themes added from someone else (lib/theme-share.ts) are among the person's
 * own, each with its `origin`. Saving one from the editor marks it changed
 * once it differs, so an Update from Community goes beside it from then on.
 * Sample mode starts with two added from its made-up catalogue: one at an
 * older version, and one taken down since (db/sample-themes.ts).
 *
 * A person's own font and text size are this device's alone
 * (athena.personal): a font is installed on one device and not another, and
 * a phone and a laptop can want different sizes. They sit above any theme.
 */

import { readTheme, readOwnThemes, readThemeChoice, newThemeId, type OwnTheme, type Theme, type ThemeChoice } from "../../../lib/theme";
import { markChanged } from "../../../lib/theme-share";
import { SAMPLE_ADDED_THEME, SAMPLE_THEMES_KEY, SAMPLE_WITHDRAWN_THEME } from "../db/sample-themes";
import { isSampleMode, fetchSettings, saveThemeSetting } from "../db/api";
import { repaint } from "./appearance";
import { ATHENA, compileTheme, paintCss, personalCss, readPersonal, type Paint, type Personal } from "./theme-paint";
import clay from "../themes/clay.json";
import harbour from "../themes/harbour.json";
import contrast from "../themes/contrast.json";
import mist from "../themes/mist.json";

export { ATHENA };

export const THEME_KEY = "athena.theme";
export const PAINT_KEY = "athena.theme.paint";
export const UNSENT_KEY = "athena.theme.unsent";
export const PERSONAL_KEY = "athena.personal";
export const THEME_STYLE_ID = "athena-theme";
export const PERSONAL_STYLE_ID = "athena-personal";

/** Athena's built-in themes, read like any other. */
export const BUILT_IN: { id: string; theme: Theme }[] = (
  [
    ["clay", clay],
    ["harbour", harbour],
    ["contrast", contrast],
    ["mist", mist],
  ] as const
).map(([id, data]) => ({ id, theme: readTheme(data).theme! }));

export interface ThemeState {
  choice: ThemeChoice;
  themes: OwnTheme[];
}

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* private mode: this visit only */
    }
  },
};

const json = (raw: string | null): unknown => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

let state: ThemeState | null = null;

/** The chosen theme and the person's own, as this device has them. */
export function themeState(): ThemeState {
  if (state) return state;
  const raw = json(store.get(THEME_KEY)) as Partial<ThemeState> | null;
  let themes = readOwnThemes(raw?.themes);
  // Sample mode starts with a theme added from its catalogue at an older version, once, so Update shows.
  if (isSampleMode() && !store.get(SAMPLE_THEMES_KEY)) {
    store.set(SAMPLE_THEMES_KEY, "1");
    const seed = [SAMPLE_ADDED_THEME, SAMPLE_WITHDRAWN_THEME].filter((s) => !themes.some((t) => t.id === s.id));
    if (seed.length) {
      themes = readOwnThemes([...themes, ...seed]);
      store.set(THEME_KEY, JSON.stringify({ choice: raw?.choice ?? "athena", themes }));
    }
  }
  return (state = { choice: valid(readThemeChoice(raw?.choice), themes), themes });
}

/** A choice that still names something: a deleted own theme, or a built-in this version doesn't have, is Athena's own. */
function valid(choice: ThemeChoice, themes: OwnTheme[]): ThemeChoice {
  if (choice.startsWith("own:") && !themes.some((t) => `own:${t.id}` === choice)) return "athena";
  if (choice.startsWith("builtin:") && !BUILT_IN.some((t) => `builtin:${t.id}` === choice)) return "athena";
  return choice;
}

/** The theme a choice names, or null for Athena's own. */
export function themeFor(choice: ThemeChoice, s: ThemeState = themeState()): Theme | null {
  if (choice.startsWith("builtin:")) return BUILT_IN.find((t) => `builtin:${t.id}` === choice)?.theme ?? null;
  if (choice.startsWith("own:")) return s.themes.find((t) => `own:${t.id}` === choice)?.theme ?? null;
  return null;
}

const listeners = new Set<(s: ThemeState) => void>();

/** Call `fn` whenever the choice or the person's own themes change, here or in another tab. */
export function onThemeChange(fn: (s: ThemeState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function styleEl(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.append(el);
  }
  return el;
}

/** Put a paint on a document: the theme's stylesheet, and theme-color for each scheme. Exported for the tests. */
export function applyPaint(doc: Document, paint: Paint): void {
  const el = doc.getElementById(THEME_STYLE_ID) ?? Object.assign(doc.createElement("style"), { id: THEME_STYLE_ID });
  if (!el.isConnected) doc.head.append(el);
  el.textContent = paintCss(paint);
  const athena = compileTheme(ATHENA).meta;
  doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    for (const s of ["light", "dark"] as const) meta.setAttribute(`data-${s}`, paint.meta[s] ?? athena[s]!);
  });
}

/**
 * Make a change to the page's theme take effect at once. Some colours
 * transition slowly on purpose (the glow drifts over six seconds between
 * times of day, Today's haze and the orb cross-fade), which would make a new
 * theme seem not to have reached them. With data-repainting on the root,
 * base.css turns every transition off; the change lands, a layout read makes
 * the browser work the new styles out, and two frames later transitions are
 * back. Exported for the tests.
 */
export function cutOver(doc: Document, change: () => void): void {
  const root = doc.documentElement;
  root.setAttribute(REPAINTING, "");
  change();
  void doc.body?.offsetHeight;
  const raf = doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView);
  if (raf) raf(() => raf(() => root.removeAttribute(REPAINTING)));
  else root.removeAttribute(REPAINTING);
}
export const REPAINTING = "data-repainting";

/** Draw the chosen theme, and keep it worked out for the next first paint. Ends any theme being tried. */
function apply(s: ThemeState): void {
  trying = false;
  const paint = compileTheme(themeFor(s.choice, s));
  store.set(PAINT_KEY, Object.keys(paint.blocks).length || Object.keys(paint.meta).length ? JSON.stringify(paint) : null);
  if (typeof document === "undefined") return;
  cutOver(document, () => applyPaint(document, paint));
  repaint();
}

function commit(next: ThemeState, opts: { send: boolean }): void {
  state = { themes: next.themes, choice: valid(next.choice, next.themes) };
  store.set(THEME_KEY, JSON.stringify(state));
  apply(state);
  for (const fn of listeners) fn(state);
  if (opts.send) void send(state);
}

async function send(s: ThemeState): Promise<void> {
  if (isSampleMode()) return;
  store.set(UNSENT_KEY, "1");
  try {
    await saveThemeSetting(s);
    store.set(UNSENT_KEY, null);
  } catch {
    /* offline: sent when the app next opens (syncTheme) */
  }
}

/** Use a theme: Athena's own, a built-in one, or one of the person's. */
export function chooseTheme(choice: ThemeChoice): void {
  commit({ ...themeState(), choice }, { send: true });
}

/**
 * Keep one of the person's own themes, new or changed, and use it. Returns its id. One they added keeps where it came
 * from, and is marked changed once it differs from what was added.
 */
export function saveOwnTheme(theme: Theme, id?: string): string {
  const s = themeState();
  const key = id && s.themes.some((t) => t.id === id) ? id : newThemeId();
  const before = s.themes.find((t) => t.id === key);
  const origin = markChanged(before, theme);
  const kept: OwnTheme = origin ? { id: key, theme: { ...theme, ...(before?.theme.author ? { author: before.theme.author } : {}) }, origin } : { id: key, theme };
  const themes = before ? s.themes.map((t) => (t.id === key ? kept : t)) : [...s.themes, kept];
  commit({ themes, choice: `own:${key}` }, { send: true });
  return key;
}

/** Take the server's copy as this device's after it changed there (a theme added through Community). Nothing is sent back. */
export function adoptThemeState(next: { choice: ThemeChoice; themes: unknown }): void {
  const themes = readOwnThemes(next.themes);
  commit({ themes, choice: readThemeChoice(next.choice) }, { send: false });
}

/** Keep a new list of themes and a choice (sample mode's Add, which has no server). Sent like any change. */
export function setThemeState(next: ThemeState): void {
  commit(next, { send: true });
}

/** Send a change made offline now, before the server changes the row itself (Add, Share). Quietly does nothing when there's none. */
export async function flushTheme(): Promise<void> {
  if (isSampleMode() || !store.get(UNSENT_KEY)) return;
  await send(themeState());
}

// ---------- Trying a theme on the whole app ----------

let trying = false;

/**
 * Draw a theme on the whole app for a look, without choosing it or keeping it anywhere: not on this device, not on
 * the server, not in the first-paint copy. stopTrying() puts the theme in use back.
 */
export function tryTheme(theme: Theme | null): void {
  if (typeof document === "undefined") return;
  trying = true;
  cutOver(document, () => applyPaint(document, compileTheme(theme)));
  repaint();
}

/** Put the theme in use back after tryTheme(). Does nothing when nothing is being tried. */
export function stopTrying(): void {
  if (!trying) return;
  trying = false;
  apply(themeState());
}

export const isTrying = (): boolean => trying;

/** Delete one of the person's own themes. Returns an undo that puts it back where it was, chosen again if it was. */
export function deleteOwnTheme(id: string): () => void {
  const before = themeState();
  const at = before.themes.findIndex((t) => t.id === id);
  if (at < 0) return () => undefined;
  const gone = before.themes[at];
  commit({ themes: before.themes.filter((t) => t.id !== id), choice: before.choice === `own:${id}` ? "athena" : before.choice }, { send: true });
  return () => {
    const now = themeState();
    if (now.themes.some((t) => t.id === id)) return;
    const themes = [...now.themes];
    themes.splice(Math.min(at, themes.length), 0, gone);
    commit({ themes, choice: before.choice === `own:${id}` ? before.choice : now.choice }, { send: true });
  };
}

/** Bring the server's copy in, or send this device's if it changed offline. Quietly does nothing offline or in sample mode. */
export async function syncTheme(): Promise<void> {
  if (isSampleMode()) return;
  if (store.get(UNSENT_KEY)) return send(themeState());
  try {
    const { theme } = await fetchSettings();
    if (!theme) return;
    const themes = readOwnThemes(theme.themes);
    const next = { themes, choice: readThemeChoice(theme.choice) };
    if (JSON.stringify(next) !== JSON.stringify(themeState())) commit(next, { send: false });
  } catch {
    /* offline: this device's copy stands */
  }
}

// ---------- A person's own font and text size, for this device ----------

export function personal(): Personal {
  return readPersonal(json(store.get(PERSONAL_KEY)));
}

/** Put the person's own layer on a document. Exported for the tests. */
export function applyPersonal(doc: Document, p: Personal): void {
  const el = doc.getElementById(PERSONAL_STYLE_ID) ?? Object.assign(doc.createElement("style"), { id: PERSONAL_STYLE_ID });
  if (!el.isConnected) doc.head.append(el);
  el.textContent = personalCss(p);
}

const personalListeners = new Set<(p: Personal) => void>();
export function onPersonalChange(fn: (p: Personal) => void): () => void {
  personalListeners.add(fn);
  return () => personalListeners.delete(fn);
}

/** Change this device's font or text size (undefined puts back Athena's own). */
export function setPersonal(change: Partial<Personal>): void {
  const p = readPersonal({ ...personal(), ...change });
  store.set(PERSONAL_KEY, p.font || p.size ? JSON.stringify(p) : null);
  if (typeof document !== "undefined") {
    cutOver(document, () => applyPersonal(document, p));
    repaint();
  }
  for (const fn of personalListeners) fn(p);
}

/** Keep the page in step: once at start (the first-paint script drew the copy; this redraws from the source), and on changes from another tab. Called once, from main.ts. */
export function watchTheme(): void {
  if (typeof document !== "undefined") styleEl(THEME_STYLE_ID);
  apply(themeState());
  applyPersonal(document, personal());
  addEventListener("storage", (e) => {
    if (e.key === THEME_KEY || e.key === null) {
      state = null;
      apply(themeState());
      for (const fn of listeners) fn(themeState());
    }
    if (e.key === PERSONAL_KEY || e.key === null) {
      const p = personal();
      applyPersonal(document, p);
      repaint();
      for (const fn of personalListeners) fn(p);
    }
  });
}
