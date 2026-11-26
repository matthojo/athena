/**
 * Sample mode's added theme: Paper lantern, from the made-up Community catalogue (db/sample-community.ts), added at
 * version 1.0 while the listing is at 1.1, so Appearance shows its update dot and Community's preview offers Update.
 * Kept small and apart so app/src/lib/theme.ts can seed it without loading the catalogue.
 */
export const SAMPLE_THEMES_KEY = "athena.sample.themes";

/** The listing it came from (db/sample-community.ts). */
export const PAPER_LANTERN_LISTING = "w3x7y2z6a1b5c9d4";
/** Fog lamp's listing, taken down since sample mode added it (db/sample-community.ts WITHDRAWN). */
export const FOG_LAMP_LISTING = "f4g8h3j7k2m6n1p5";

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

/** Fog lamp, added from Community and taken down since: it stays usable, and its editor shows the catalogue's reason. */
export const SAMPLE_WITHDRAWN_THEME = {
  id: "samplefoglamp",
  theme: {
    format: 1,
    name: "Fog lamp",
    summary: "Grey-blue mist and a sodium-orange accent.",
    author: "harbour-nights",
    colours: {
      light: { page: "#eef1f3", surface: "#f8f9fa", sunken: "#e3e8eb", border: "#cfd7dc", text: "#1d2a33", textMuted: "#55636d", accent: "#d9731a", onAccent: "#fffaf4" },
      dark: { page: "#11171b", surface: "#182026", sunken: "#1f282f", border: "#2b363e", text: "#e4eaee", textMuted: "#9fadb7", accent: "#f0913a", onAccent: "#1e1206" },
    },
    shape: { radius: 0.9, density: 1 },
    text: { scale: 1 },
  },
  origin: { catalogue_id: FOG_LAMP_LISTING, hash: `sha256-${"7".repeat(64)}`, version: "1.2", author: "harbour-nights", changed: false },
};
