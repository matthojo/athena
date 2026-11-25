/**
 * ⌘K by name: the people, to-dos, places, organisations, events and notes
 * whose name holds every word typed, so "priya" opens Priya rather than
 * only offering to search notes for her. Pure, so it can be tested:
 * components/jump.ts loads the things and draws the rows.
 */

export type JumpKind = "person" | "todo" | "place" | "organisation" | "event" | "note";

export interface JumpThing {
  kind: JumpKind;
  id: string;
  title: string;
  /** A few quiet words beside the name: who they are, when it's due. */
  sub?: string;
}

export interface JumpGroup {
  kind: JumpKind;
  label: string;
  items: JumpThing[];
}

/** The groups, in the order they're listed: people first, since a name is what's most often typed. */
export const JUMP_GROUPS: Array<{ kind: JumpKind; label: string }> = [
  { kind: "person", label: "People" },
  { kind: "todo", label: "To do" },
  { kind: "place", label: "Places" },
  { kind: "organisation", label: "Organisations" },
  { kind: "event", label: "Events" },
  { kind: "note", label: "Notes" },
];

/** Lower case, accents folded: "Zoë" is found by "zoe". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** How well a name answers what was typed: 3 it starts with it, 2 a word in it does, 1 it's in there somewhere, 0 not at all. */
export function nameScore(title: string, q: string): number {
  const name = fold(title);
  const typed = fold(q).trim();
  const words = typed.split(/\s+/).filter(Boolean);
  if (!words.length || !words.every((w) => name.includes(w))) return 0;
  if (name.startsWith(typed)) return 3;
  const starts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.every((w) => starts.some((s) => s.startsWith(w))) ? 2 : 1;
}

/**
 * What matches, grouped by kind, best first within a kind. From two
 * characters, so one letter doesn't fill the list; at most `perKind` of each
 * and `max` in all, so the rows to search notes and ask stay in reach.
 */
export function matchThings(things: readonly JumpThing[], q: string, perKind = 4, max = 12): JumpGroup[] {
  if (q.trim().length < 2) return [];
  const scored = things.map((t, i) => ({ t, i, score: nameScore(t.title, q) })).filter((x) => x.score > 0);
  const groups: JumpGroup[] = [];
  let room = max;
  for (const g of JUMP_GROUPS) {
    if (room <= 0) break;
    const items = scored
      .filter((x) => x.t.kind === g.kind)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, Math.min(perKind, room))
      .map((x) => x.t);
    if (!items.length) continue;
    groups.push({ ...g, items });
    room -= items.length;
  }
  return groups;
}
