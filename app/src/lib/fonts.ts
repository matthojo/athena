/**
 * Fonts already on this device, for Settings → Appearance → Your font. No
 * font is ever downloaded: the person picks from what the device has, or
 * Athena's own.
 *
 * Two ways to find them:
 * - The Local Font Access API (queryLocalFonts, Chromium browsers), which
 *   lists every font, only once the person allows it.
 * - Otherwise, a short list of common system and reading fonts, each tested
 *   by drawing a line of text in it and in a generic face: if the widths
 *   differ, the font is there. Browsers that guard against fingerprinting
 *   (Safari, Firefox's resist-fingerprinting) answer only for their own
 *   system fonts, so a font the person installed may not show.
 */

/** Common interface, reading and accessibility fonts, tested for on devices without the Local Font Access API. */
export const COMMON_FONTS = [
  "Arial", "Helvetica Neue", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Segoe UI", "Calibri", "Candara", "Corbel",
  "Avenir Next", "Avenir", "Optima", "Gill Sans", "Futura", "Roboto", "Noto Sans", "Open Sans", "Lato", "Ubuntu", "Cantarell",
  "DejaVu Sans", "Liberation Sans", "Inter", "Source Sans 3", "Fira Sans", "Georgia", "Times New Roman", "Palatino", "Book Antiqua",
  "Baskerville", "Charter", "Iowan Old Style", "Cambria", "Noto Serif", "Atkinson Hyperlegible", "Lexend", "OpenDyslexic", "Andika",
  "Comic Sans MS", "Verdana Pro",
];

const GENERIC = ["monospace", "serif", "sans-serif"];
const SAMPLE = "mmmmmmmmmmlli10WQ@#&";

/** Whether a font is on this device, by measuring a line drawn in it against each generic face. */
export function fontPresent(name: string, ctx?: CanvasRenderingContext2D | null): boolean {
  const c = ctx ?? document.createElement("canvas").getContext("2d");
  if (!c) return false;
  const width = (family: string) => {
    c.font = `72px ${family}`;
    return c.measureText(SAMPLE).width;
  };
  return GENERIC.some((g) => width(`"${name.replace(/"/g, "")}", ${g}`) !== width(g));
}

/** The common fonts this device has. */
export function commonFontsHere(): string[] {
  const ctx = document.createElement("canvas").getContext("2d");
  return COMMON_FONTS.filter((f) => fontPresent(f, ctx));
}

type LocalFont = { family: string };
type FontWindow = Window & { queryLocalFonts?: () => Promise<LocalFont[]> };

/** Whether this browser can list every font, if the person allows it. */
export const canListFonts = (): boolean => typeof window !== "undefined" && typeof (window as FontWindow).queryLocalFonts === "function";

/** "granted", "denied" or "prompt" for the full list, where the browser says; null where it can't. */
export async function fontPermission(): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions.query({ name: "local-fonts" as PermissionName })).state;
  } catch {
    return null;
  }
}

/** Every font family on the device, once the person allows it (needs a tap to ask). Null if they don't, or the browser can't. */
export async function listDeviceFonts(): Promise<string[] | null> {
  const w = window as FontWindow;
  if (!w.queryLocalFonts) return null;
  try {
    const fonts = await w.queryLocalFonts();
    return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
}
