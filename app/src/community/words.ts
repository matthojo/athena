/**
 * Community's words and list logic, pure so they're tested (words.test.ts): a kind and a reach tier in plain
 * words, the filter, the search, and the order (featured first, then newest).
 */
import type { CatalogueItem } from "../../../lib/catalogue-types";
import { LOOKUP_TOOLS, type Reach } from "../../../lib/reach";
import { SHARE_KINDS, type ShareKind } from "../../../lib/share-kinds";

export type KindFilter = ShareKind | "all";

export const KIND_WORDS: Readonly<Record<ShareKind, { one: string; many: string }>> = {
  assistant: { one: "Assistant", many: "Assistants" },
  skill: { one: "Skill", many: "Skills" },
  flow: { one: "Flow", many: "Flows" },
};

/** `?kind=` as the address gives it, or "all". Pure. */
export function readKind(raw: string | null | undefined): KindFilter {
  return (SHARE_KINDS as readonly string[]).includes(raw ?? "") ? (raw as ShareKind) : "all";
}

/** `#/community`, or `#/community?kind=flow`: where "Browse Community" goes. Pure. */
export function communityHash(kind: KindFilter = "all"): string {
  return kind === "all" ? "#/community" : `#/community?kind=${kind}`;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "Stays in Athena", "Uses AI", "Checks the weather forecast", "Uses AI and live train times", "Searches the web". Pure. */
export function tierWords(r: Pick<Reach, "tier" | "model" | "lookups">): string {
  if (r.tier === 3) return "Searches the web";
  if (r.tier === 1) return "Stays in Athena";
  const looks = r.lookups.map((t) => lower(LOOKUP_TOOLS[t]?.label ?? t.replace(/_/g, " ")));
  const list = looks.length > 1 ? `${looks.slice(0, -1).join(", ")} and ${looks[looks.length - 1]}` : looks[0];
  if (r.model && list) return looks.length > 1 ? `Uses AI, ${list}` : `Uses AI and ${list}`;
  if (list) return `Checks ${list}`;
  return "Uses AI";
}

/** The tier's mark everywhere it's shown: inside Athena, AI, a lookup only, the web. Pure. */
export const tierIcon = (r: Pick<Reach, "tier" | "model">): "shield" | "sparkle" | "cloud" | "globe" => (r.tier === 1 ? "shield" : r.tier === 3 ? "globe" : r.model ? "sparkle" : "cloud");

/** The longer line for a tier, for a screen reader and a tooltip. Pure. */
export function tierDetail(tier: Reach["tier"]): string {
  if (tier === 1) return "Everything it does stays inside your Athena.";
  if (tier === 2) return "It sends what it works on to an AI model, or looks something up outside Athena.";
  return "It can search the web, as well as use an AI model.";
}

/** "Stays in Athena" → "stays in Athena": for a sentence about a change of tier. Pure. */
export const tierPhrase = (r: Pick<Reach, "tier" | "model" | "lookups">): string => lower(tierWords(r));

const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Does an item match what was typed? Every word must appear in its name, summary, author, kind or accounts. Pure. */
export function matches(item: CatalogueItem, query: string, accountName: (provider: string) => string = (p) => p): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([item.name, item.summary, item.author ?? "", KIND_WORDS[item.kind].one, ...item.needs.map(accountName), item.needs.join(" ")].join(" "));
  return words.every((w) => hay.includes(w));
}

/** Featured first, then newest. Pure. */
export function ordered(items: readonly CatalogueItem[]): CatalogueItem[] {
  return [...items].sort((a, b) => Number(b.featured) - Number(a.featured) || Date.parse(b.added_at) - Date.parse(a.added_at) || a.name.localeCompare(b.name));
}

/** The list for a filter and a search: in order, with counts per kind for the filter's labels. Pure. */
export function filtered(items: readonly CatalogueItem[], kind: KindFilter, query: string, accountName?: (provider: string) => string): { items: CatalogueItem[]; counts: Record<KindFilter, number> } {
  const found = items.filter((i) => matches(i, query, accountName));
  const counts = { all: found.length, assistant: 0, skill: 0, flow: 0 } as Record<KindFilter, number>;
  for (const i of found) counts[i.kind]++;
  return { items: ordered(kind === "all" ? found : found.filter((i) => i.kind === kind)), counts };
}

/** "Version 1.3 → 1.4", "A newer version", for an update. Pure. */
export function versionWords(was: string | null, now: string | null): string {
  if (was && now && was !== now) return `Version ${was} → ${now}`;
  if (now) return `Version ${now}`;
  return "A newer version";
}
