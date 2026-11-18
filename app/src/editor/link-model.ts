/**
 * Rich links in the editor: the pure rules, with no DOM and no editor, so the
 * tests can run them in Node (link-model.test.ts).
 *
 *   - what a link is (a thing in Athena or a web page) and how it's shown
 *     (lib/links.ts: Mention, Link, Card, Embed);
 *   - the switcher's choices for one link, with the reason a choice is off;
 *   - what a pasted address becomes, by where it lands (the owner's answer 3);
 *   - where a Card or Embed goes when it's picked for a link in a sentence
 *     (answer 2: the words stay a Link, the block goes after the paragraph);
 *   - what a tap on a link does.
 */

import type { IconName } from "../components/icons";
import { LINK_MODES, defaultMode, modesFor, type LinkKind, type LinkMode } from "../../../lib/links";
import { embedFor, isEmbeddable } from "../../../lib/embeds";

export type { LinkMode };
export const MODES = LINK_MODES;

export const MODE_LABEL: Record<LinkMode, string> = { mention: "Mention", link: "Link", card: "Card", embed: "Embed" };
export const MODE_ICON: Record<LinkMode, IconName> = { mention: "at", link: "link", card: "image", embed: "play" };

/** What a link points at. */
export type LinkTarget = { target: "athena"; kind: LinkKind; id: string } | { target: "web"; url: string };

/** Card and Embed are blocks on their own line; Mention and Link sit in the text. */
export const isBlockMode = (mode: LinkMode): boolean => mode === "card" || mode === "embed";

export interface ModeChoice {
  mode: LinkMode;
  enabled: boolean;
  /** Why it's off, for the switcher's tooltip. */
  reason?: string;
}

export const NO_PLAYER = "There's no player for this page";
export const ATHENA_NO_EMBED = "Things in Athena show as a card instead";

/** The switcher's four options for one link, each on or off (lib/links.ts modesFor, Embed only where there's a player). */
export function switcherChoices(t: LinkTarget): ModeChoice[] {
  const allowed = modesFor(t.target);
  return MODES.map((mode) => {
    if (!allowed.includes(mode)) return { mode, enabled: false, reason: ATHENA_NO_EMBED };
    if (mode === "embed" && t.target === "web" && !isEmbeddable(t.url)) return { mode, enabled: false, reason: NO_PLAYER };
    return { mode, enabled: true };
  });
}

/** The modes a link can be switched to. */
export const allowedModes = (t: LinkTarget): LinkMode[] => switcherChoices(t).filter((c) => c.enabled).map((c) => c.mode);

/** The mode a link shows in, given what its Markdown says. Athena things never embed. */
export function shownMode(t: LinkTarget, mode: LinkMode | null | undefined): LinkMode {
  if (!mode) return defaultMode(t.target);
  if (t.target === "athena" && mode === "embed") return "card";
  return mode;
}

/** Text that is one web address and nothing else, tidied; null otherwise (a sentence, an `<iframe>`, `javascript:`). */
export function pastedUrl(text: string | null | undefined): string | null {
  const s = (text ?? "").trim();
  if (!s || s.length > 2048 || /[\s<>"]/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
  } catch {
    return null;
  }
  return s;
}

/** Where a paste lands: a line with nothing else on it, or inside some words. */
export type PastePlace = "empty-line" | "in-text";

/** Paste by position: Card (Embed for players) on an empty line, Link inside a sentence. */
export function pasteMode(url: string, place: PastePlace): LinkMode {
  if (place === "in-text") return "link";
  return embedFor(url) ? "embed" : "card";
}

/**
 * Picking Card or Embed for a link that sits in a paragraph. A link alone in
 * its paragraph becomes the block ("replace"); one inside a sentence stays a
 * Link and the block is added after the paragraph ("after").
 */
export function blockPlacement(aloneInParagraph: boolean): "replace" | "after" {
  return aloneInParagraph ? "replace" : "after";
}

/**
 * A tap on a link opens what it points at: the person, place, note or page
 * (owner's answers, 2026-11-08). The switcher comes only after a paste and
 * from the menu's Show as. An Embed in the editor is the exception: a tap on
 * its still selects it, and its own button plays it.
 */
export function tapAction(mode: LinkMode, editable: boolean): "open" | "select" {
  return editable && mode === "embed" ? "select" : "open";
}

/** The address without its scheme and "www.", for a failed Link or a fresh paste. */
export const bareUrl = (url: string): string => url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

/** The site's host without "www.", as the card's site row says it before a preview arrives. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return bareUrl(url).split("/")[0];
  }
}
