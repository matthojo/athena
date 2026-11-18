/**
 * "Open Sources at this group": #/settings/sources?add=travel (Leave by's
 * "Add a journey planner"). main.ts keeps the group here before it tidies
 * the address, and Sources opens the Add an account directory at it once.
 */
let pending: string | null = null;

/** From the address, before it's tidied. */
export function noteSourcesAsk(hash: string): void {
  const group = new URLSearchParams(hash.split("?")[1] ?? "").get("add");
  if (group) pending = group;
}

/** The group asked for, once. */
export function takeSourcesAsk(): string | null {
  const g = pending;
  pending = null;
  return g;
}
