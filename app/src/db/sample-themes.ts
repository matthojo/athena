/**
 * Sample mode's added theme: Paper lantern, from the made-up Community catalogue (db/sample-community.ts), added at
 * version 1.0 while the listing is at 1.1, so Appearance shows its update dot and Community's preview offers Update.
 * Kept small and apart so app/src/lib/theme.ts can seed it without loading the catalogue.
 */
export const SAMPLE_THEMES_KEY = "athena.sample.themes";

/** The listing it came from (db/sample-community.ts). */
export const PAPER_LANTERN_LISTING = "w3x7y2z6a1b5c9d4";

/** Paper lantern 1.0, as it was added: a warmer page and a softer amber than 1.1. */
export const SAMPLE_ADDED_THEME = {
  id: "samplelantern",
  theme: {
    format: 1,
    name: "Paper lantern",
    summary: "Warm rice paper and a lantern amber, for evenings in.",
    author: "lamplight-co",
    colours: {
      light: { page: "#f6efe2", surface: "#fdf8ef", sunken: "#efe5d3", border: "#e2d4bb", text: "#2e2418", textMuted: "#6b5a44", accent: "#b9711c", onAccent: "#fffaf2" },
      dark: { page: "#1a1611", surface: "#231e17", sunken: "#2c261d", border: "#3a3226", text: "#f2e8d8", textMuted: "#c4b49b", accent: "#e8a24a", onAccent: "#1f170c" },
    },
    shape: { radius: 1.3, density: 1.05 },
    text: { scale: 1 },
  },
  origin: { catalogue_id: PAPER_LANTERN_LISTING, hash: `sha256-${"6".repeat(64)}`, version: "1.0", author: "lamplight-co", changed: false },
};
