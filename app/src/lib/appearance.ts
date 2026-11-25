/**
 * Appearance: Light, Dark, or the system's setting (the default). One switch
 * for the whole app. The root element carries the choice and the scheme it
 * resolves to:
 *
 *   <html data-appearance="system|light|dark" data-scheme="light|dark">
 *
 * Every stylesheet reads data-scheme and nothing else: the light values are
 * the plain rules, and dark ones sit under :where([data-scheme="dark"]),
 * which adds no specificity, so they cascade exactly as the old
 * prefers-color-scheme blocks did. With "system" the scheme follows the
 * device, live, as it always has.
 *
 * The choice is kept per device in localStorage (athena.appearance): it is
 * read before the first paint, synchronously, which a server setting can't
 * be, and a phone and a laptop in different rooms can want different
 * answers. appearance-boot.ts applies it before any stylesheet loads, so
 * nothing paints in the wrong mode, in a tab or in the installed app.
 */

export type Appearance = "system" | "light" | "dark";
export type Scheme = "light" | "dark";

export const APPEARANCE_KEY = "athena.appearance";
export const APPEARANCES: Appearance[] = ["system", "light", "dark"];
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** What a stored value means: anything unknown, or nothing, is "system". */
export const asAppearance = (raw: unknown): Appearance => (raw === "light" || raw === "dark" ? raw : "system");

/** The scheme a choice comes to, given whether the system is dark. */
export const resolveScheme = (choice: Appearance, systemDark: boolean): Scheme => (choice === "system" ? (systemDark ? "dark" : "light") : choice);

/** A choice that couldn't be stored (private mode): it holds for this visit. */
let unstored: Appearance | null = null;

/** This device's choice. */
export function appearance(): Appearance {
  if (unstored) return unstored;
  try {
    return asAppearance(localStorage.getItem(APPEARANCE_KEY));
  } catch {
    return "system";
  }
}

const systemDark = (): boolean => typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;

/** The scheme the app is drawn in now. */
export function scheme(): Scheme {
  const set = typeof document === "undefined" ? null : document.documentElement.dataset.scheme;
  return set === "dark" || set === "light" ? set : resolveScheme(appearance(), systemDark());
}

export const isDark = (): boolean => scheme() === "dark";

const listeners = new Set<(s: Scheme) => void>();

/** Call `fn` whenever the scheme changes (a new choice, or the system's when following it). Returns the unsubscribe. */
export function onSchemeChange(fn: (s: Scheme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The root's attributes, colour-scheme and theme-color for a choice. Exported for the tests. */
export function applyAppearance(doc: Document, choice: Appearance, dark: boolean): Scheme {
  const next = resolveScheme(choice, dark);
  const root = doc.documentElement;
  root.dataset.appearance = choice;
  root.dataset.scheme = next;
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute("content", next);
  // The browser picks a theme-color by its media; both carry the chosen scheme's colour.
  doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    const colour = meta.getAttribute(`data-${next}`);
    if (colour) meta.content = colour;
  });
  return next;
}

let current: Scheme | null = null;

function update(): void {
  const next = applyAppearance(document, appearance(), systemDark());
  if (next === current) return;
  current = next;
  refreshSchemeSources(document);
  for (const fn of listeners) fn(next);
}

/** Keep this device's choice, and redraw in it. */
export function setAppearance(choice: Appearance): void {
  try {
    if (choice === "system") localStorage.removeItem(APPEARANCE_KEY);
    else localStorage.setItem(APPEARANCE_KEY, choice);
    unstored = null;
  } catch {
    unstored = choice;
  }
  if (typeof document !== "undefined") update();
}

/** Follow the system while the choice is "system", and a choice made in another tab. Called once, from main.ts. */
export function watchAppearance(): void {
  current = scheme();
  if (typeof matchMedia === "function") matchMedia(DARK_QUERY).addEventListener("change", update);
  addEventListener("storage", (e) => {
    if (e.key === APPEARANCE_KEY || e.key === null) update();
  });
}

// ---------- Pictures with a dark version ----------
// A <source media="(prefers-color-scheme: dark)"> sees the system, not the
// choice. darkSource() makes the dark one's <source> instead, switched on or
// off by its media, and redone whenever the scheme changes.

const ON = "all";
const OFF = "not all";

/** A <source> for a picture's dark version: used while the app is dark. */
export function darkSource(srcset: string): HTMLSourceElement {
  const s = document.createElement("source");
  s.setAttribute("srcset", srcset);
  s.setAttribute("data-scheme-source", "dark");
  s.setAttribute("media", isDark() ? ON : OFF);
  return s;
}

/** Turn every dark <source> on or off for the scheme now. */
export function refreshSchemeSources(doc: Document): void {
  const on = doc.documentElement.dataset.scheme === "dark";
  doc.querySelectorAll<HTMLSourceElement>('source[data-scheme-source="dark"]').forEach((s) => s.setAttribute("media", on ? ON : OFF));
}
