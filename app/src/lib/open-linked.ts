/**
 * Open anything a link chip can point at: a page through the app's openLink,
 * or a saved item, to-do or Watch & read title (what a note @-mentions from
 * its own list) through lib/open-item.ts, loaded only when one is tapped.
 */
import type { EntityKind, LinkedKind } from "../types";

export const isListItem = (kind: LinkedKind): kind is "saved" | "commitment" | "reading" => kind === "saved" || kind === "commitment" || kind === "reading";

export function openLinked(openLink: (kind: EntityKind, id: string) => void, kind: LinkedKind, id: string): void {
  if (isListItem(kind)) void import("./open-item").then((m) => m.openItem({ kind, id }));
  else openLink(kind, id);
}
