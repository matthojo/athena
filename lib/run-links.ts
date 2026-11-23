/**
 * Which links a turn may open (SECURITY.md §10, "Links a turn may open").
 *
 * Anthropic's web fetch tool (lib/answer.ts webFetchTool) opens a link that's in the turn's own message, and it does
 * so on Anthropic's side, inside the model call, before Athena sees the request. So a link goes into a turn's message
 * as something it may open only when the owner supplied or approved it: a saved item's own link, or a tracker link
 * the owner typed or gave their Go to. Text a model wrote (a flow step's values, an assignment's work and handoffs, a
 * tracker's name or a check's shop) goes in with its links and web addresses written so they can't be opened
 * (`unlinked`), and a tracker link a model chose waits for the owner's Go (lib/ask-guard.ts needsOwnersGo).
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A web address in text: a scheme and host, or a bare host with a dot and a top-level name of letters, with its port
 * and path; or an IPv4 address. "34.99", "e.g." and "v1.2" aren't.
 */
const ADDRESS =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+)|(?:\b(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}\b(?::\d{1,5})?(?:[/?#][^\s<>"'`]*)?)|(?:\b\d{1,3}(?:\.\d{1,3}){3}\b(?::\d{1,5})?(?:[/?#][^\s<>"'`]*)?)/giu;

/** How a dot and a scheme's "://" are written in a link that can't be opened. */
const DOT = "[.]";
const SEP = "[://]";

/**
 * Text a model wrote, with every web address in it written so it can't be opened: "https[://]shop[.]example/x". A
 * reader still sees where it points. Pure.
 */
export function unlinked(text: string): string {
  if (!text) return text;
  return text.replace(ADDRESS, (m) => m.replace("://", SEP).replace(/\./g, DOT));
}

/** `unlinked` undone, for text a model hands back to be kept (an assignment's work): its links work again for the owner. Pure. */
export function relinked(text: string): string {
  if (!text) return text;
  return text.split(SEP).join("://").split(DOT).join(".");
}

/** A tracker link a model chose, as it's shown for Go and kept: without its fragment, which no page needs. Null when it isn't a link. Pure. */
export function modelLink(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

const go = new AsyncLocalStorage<true>();

/** Run a plan's steps under the owner's Go (lib/ask-plans.ts goPlan): what a step sets is the owner's, approved. */
export function asOwnersGo<T>(fn: () => T): T {
  return go.run(true, fn);
}

/** Is this running under the owner's Go on a plan? */
export function underOwnersGo(): boolean {
  return go.getStore() === true;
}
