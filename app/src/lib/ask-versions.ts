/**
 * Edit and regenerate in Ask (views/ask.ts), as plain state.
 *
 * Regenerate: a reply can be written again. The new one shows, and the old
 * ones stay a tap away ("2 of 2", with ‹ and ›). All versions of one reply
 * share a slot; the one on screen is all[index]. At most MAX_VERSIONS are
 * kept, the oldest going first. They're saved with the conversation inside
 * the reply's own message (versions, version), so no schema change is needed.
 *
 * Edit: your last message goes back into the box. Sending it again replaces
 * it and everything after it (the reply below, with its versions).
 */

export interface Slot<T> {
  all: T[];
  index: number;
}

export const MAX_VERSIONS = 5;

/** A reply written again: the fresh one shows, the others stay reachable. */
export function addVersion<T>(slot: Slot<T> | null | undefined, current: T, fresh: T): Slot<T> {
  const all = [...(slot?.all ?? [current]), fresh];
  while (all.length > MAX_VERSIONS) all.shift();
  return { all, index: all.length - 1 };
}

/** Show another version (clamped to what there is). */
export function pickVersion<T>(slot: Slot<T>, index: number): Slot<T> {
  return { all: slot.all, index: Math.max(0, Math.min(slot.all.length - 1, index)) };
}

/** "2 of 2"; null when there's only one. */
export function versionLabel(slot: Slot<unknown> | null | undefined): string | null {
  return slot && slot.all.length > 1 ? `${slot.index + 1} of ${slot.all.length}` : null;
}

/** For saving: every version as saved, and which one shows. A version that can't be saved drops out. */
export function saveSlot<T, S>(slot: Slot<T> | null | undefined, save: (t: T) => S | null): { versions?: S[]; version?: number } {
  if (!slot || slot.all.length < 2) return {};
  const kept: S[] = [];
  let version = 0;
  slot.all.forEach((t, i) => {
    const s = save(t);
    if (!s) return;
    if (i === slot.index) version = kept.length;
    kept.push(s);
  });
  return kept.length > 1 ? { versions: kept, version } : {};
}

/** Reading a saved reply back: its slot, or null when it has one version. */
export function loadSlot<S, T>(saved: { versions?: S[]; version?: number }, load: (s: S) => T): Slot<T> | null {
  const v = saved.versions;
  if (!Array.isArray(v) || v.length < 2) return null;
  return { all: v.map(load), index: Math.max(0, Math.min(v.length - 1, saved.version ?? v.length - 1)) };
}

/** Where your last message is, if there's one to edit: the index of it, and what it said. */
export function lastMine<M extends { role: string }>(messages: readonly M[], isMine: (m: M) => boolean = (m) => m.role === "me"): number {
  for (let i = messages.length - 1; i >= 0; i--) if (isMine(messages[i])) return i;
  return -1;
}

/** Sending an edited message: the conversation up to (not including) your last message. */
export function beforeEdit<M extends { role: string }>(messages: readonly M[], isMine?: (m: M) => boolean): M[] {
  const i = lastMine(messages, isMine);
  return i < 0 ? [...messages] : messages.slice(0, i);
}
