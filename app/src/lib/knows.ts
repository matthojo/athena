/**
 * Settings → About you → What Athena knows: everything Athena keeps about
 * the owner, grouped by where it came from. Pure, so the page and its tests
 * share it; the lists come from GET /api/profile/knows (lib/knows.ts) or the
 * sample data.
 *
 * Groups, in order:
 *  - "ask": what the owner told Ask to remember, about themselves or someone;
 *  - "profile": what they typed in About you or the setup;
 *  - "learned": what Athena worked out and the owner accepted;
 *  - "review": what Athena worked out and is still waiting on them for.
 */
import { profileField, type ProfileInput } from "./profile-catalogue";
import { provenanceLine } from "./profile-provenance";
import { sourceText } from "./sources";
import type { Fact, Suggestion } from "../types";

export type KnowsGroupId = "ask" | "profile" | "learned" | "review";

export interface KnownItem {
  /** "fact:<id>" or "suggestion:<id>": stable across repaints. */
  key: string;
  group: KnowsGroupId;
  /** What it's about: the owner, or a person. */
  about: { kind: "me" } | { kind: "person"; id: string; name: string };
  /** The fact's key as the owner knows it: "Diet", "Working hours". */
  label: string;
  /** How the value is typed and shown: a catalogue key's own input ("people", "goals"…), else text. */
  input: ProfileInput;
  value: string;
  /** Where it came from, in words: "You told Ask", "Learned from your activity". */
  from: string;
  /** ISO time it was said or learned. */
  at: string;
  /** Why Athena thinks so, for a learned one ("Runs logged on 7 of the last 8 Tuesdays"). */
  why: string | null;
  fact?: Fact;
  suggestion?: Suggestion;
}

export interface KnowsGroup {
  id: KnowsGroupId;
  title: string;
  lede: string;
  items: KnownItem[];
}

export interface KnowsLists {
  me: Fact[];
  people: Array<Fact & { person: { id: string; name: string } }>;
  suggestions: Suggestion[];
}

export const GROUPS: ReadonlyArray<Omit<KnowsGroup, "items">> = [
  { id: "ask", title: "Remembered in Ask", lede: "You told Ask to remember these." },
  { id: "profile", title: "From your profile", lede: "Your answers in About you and setup." },
  { id: "learned", title: "Learned from your activity", lede: "Athena worked these out from your days, and you kept them." },
  { id: "review", title: "Waiting for you", lede: "Athena noticed these. It won't use them until you keep them." },
];

/** "assistant" is Ask: what the owner typed there. */
export const ASK_SOURCE = "assistant";

const current = (f: Fact) => !f.superseded_at && !f.archived_at;

/** The newest current fact per key, about the owner. */
function latestMe(me: Fact[]): Fact[] {
  const byKey = new Map<string, Fact>();
  for (const f of me.filter((x) => x.subject_kind === "me" && current(x))) {
    const k = f.key.trim().toLowerCase();
    const had = byKey.get(k);
    if (!had || had.observed_at < f.observed_at) byKey.set(k, f);
  }
  return [...byKey.values()];
}

/** The catalogue's own spelling of a key ("working hours" → "Working hours"). */
const labelOf = (key: string) => profileField(key)?.key ?? key;

/** The lists in groups, each newest first. Empty groups are left out. */
export function groupKnows(lists: KnowsLists): KnowsGroup[] {
  const items: KnownItem[] = [];
  for (const f of latestMe(lists.me)) {
    const group: KnowsGroupId = f.source === ASK_SOURCE ? "ask" : f.confidence === null || f.confidence === undefined ? "profile" : "learned";
    items.push({
      key: `fact:${f.id}`,
      group,
      about: { kind: "me" },
      label: labelOf(f.key),
      input: profileField(f.key)?.input ?? "text",
      value: f.value,
      from: group === "ask" ? "You told Ask" : provenanceLine(f),
      at: f.observed_at,
      why: group === "learned" ? f.source_quote ?? null : null,
      fact: f,
    });
  }
  for (const f of lists.people.filter(current)) {
    items.push({
      key: `fact:${f.id}`,
      group: "ask",
      about: { kind: "person", id: f.person.id, name: f.person.name },
      label: f.key,
      input: "text",
      value: f.value,
      from: "You told Ask",
      at: f.observed_at,
      why: null,
      fact: f,
    });
  }
  for (const s of lists.suggestions) {
    const p = s.payload as { subject_kind?: unknown; key?: unknown; value?: unknown };
    if (s.status !== "pending" || s.op !== "fact" || p.subject_kind !== "me" || typeof p.key !== "string" || typeof p.value !== "string") continue;
    items.push({
      key: `suggestion:${s.id}`,
      group: "review",
      about: { kind: "me" },
      label: labelOf(p.key),
      input: profileField(p.key)?.input ?? "text",
      value: p.value,
      from: s.source === "profile-learner" ? "Noticed in your activity" : `Noticed in ${sourceText(s.source ?? null)}`,
      at: s.created_at,
      why: s.source_quote ?? null,
      suggestion: s,
    });
  }
  return GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.group === g.id).sort((a, b) => b.at.localeCompare(a.at)) })).filter((g) => g.items.length);
}
