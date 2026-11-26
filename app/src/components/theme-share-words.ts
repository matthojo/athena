/**
 * Themes shared and added (lib/theme-share.ts) in plain words: the share sheet's reach card, intro and findings, and an
 * added theme's origin in Appearance. Pure, so the tests can read them without a DOM.
 */
import { tierIcon, tierWords } from "../community/words";
import type { ThemeOrigin } from "../../../lib/theme";

/** The reach card on the share sheet: always tier 1. */
export function themeReachWords(): { title: string; detail: string; icon: "shield" } {
  const r = { tier: 1 as const, model: false, lookups: [] };
  return { title: tierWords(r), detail: "It only changes how Athena looks for whoever adds it. It holds only colours, corners, spacing and text size.", icon: tierIcon(r) as "shield" };
}

export const THEME_SHARE_INTRO = "A file anyone can add to their own themes. It holds this theme's name, summary, colours, shape and text size. Your font, your text size and your other themes stay here.";

/** "In the name", "In the name and the summary": where a finding is. */
export function themeWhereWords(where: readonly string[]): string {
  const names: Record<string, string> = { name: "the name", summary: "the summary" };
  const parts = [...new Set(where)].map((w) => names[w] ?? `the ${w}`);
  return `In ${parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}`;
}

/** The line over the findings. */
export function themeFindingsLede(n: number): string {
  if (!n) return "Nothing is flagged. Athena checked the name and summary for your people, places, contact details and private links.";
  return `${n === 1 ? "This looks like one" : "These look like some"} of your own details. Change ${n === 1 ? "it" : "them"} here, or mark ${n === 1 ? "it" : "each one"} fine to share.`;
}

/**
 * "From Community · by @lamplight-co · version 1.0", "From a file": where an added theme came from, in the words the
 * other kinds use. Never a bare "Shared", which could read as something the person shared out (owner, 25 Nov 2026).
 * Pure.
 */
export function themeFromWords(o: Pick<ThemeOrigin, "catalogue_id" | "author" | "version">): string {
  return [o.catalogue_id ? "From Community" : "From a file", o.author ? `by @${o.author}` : null, o.version ? `version ${o.version}` : null].filter(Boolean).join(" · ");
}

/** A tile's short origin, under its name: "From Community", "From a file". Pure. */
export const themeFromShort = (o: Pick<ThemeOrigin, "catalogue_id">): string => (o.catalogue_id ? "From Community" : "From a file");

/** Under an added theme's origin in its editor: what changing it means. */
export function themeChangeWords(o: Pick<ThemeOrigin, "changed" | "catalogue_id" | "hash">): string {
  if (o.changed) return o.catalogue_id && o.hash ? "You've changed it, so it's yours now. A new version from Community would go beside it." : "You've changed it, so it's yours now.";
  return o.catalogue_id ? "Someone else made it. Change it as you like: a new version from Community never overwrites your changes." : "Someone else made it. Change it as you like.";
}
