/**
 * The app's openLink, for components that are opened from anywhere and so
 * aren't handed one (the to-do sheet's links). main.ts sets it once at start.
 * Before then, or in a test, a link falls back to lib/open-item.ts for the
 * kinds that open in a sheet and otherwise does nothing.
 */
import type { EntityKind } from "../types";

type OpenLink = (kind: EntityKind, id: string) => void;
let opener: OpenLink | null = null;

export function setAppOpenLink(fn: OpenLink): void {
  opener = fn;
}

/** Open what an athena:// link points at: a page, a record, or a to-do, saved item or Watch & read title. */
export function openAppLink(kind: string, id: string): void {
  if (opener) return opener(kind as EntityKind, id);
  void import("./open-item").then((m) => m.openItem({ kind, id }));
}
