/**
 * Community's words and list logic, pure so they're tested (words.test.ts): a kind and a reach tier in plain
 * words, the filter, the search, and the order (featured first, then newest).
 */
import type { CatalogueItem } from "../../../lib/catalogue-types";
import { LOOKUP_TOOLS, type Reach } from "../../../lib/reach";
import { SHARE_KINDS, type ShareKind } from "../../../lib/share-kinds";

export type KindFilter = ShareKind | "all";

/** How the list is ordered: featured picks first then the newest (the default), or the most downloaded first. */
export type CommunitySort = "featured" | "downloads";

export const KIND_WORDS: Readonly<Record<ShareKind, { one: string; many: string }>> = {
  assistant: { one: "Assistant", many: "Assistants" },
  skill: { one: "Skill", many: "Skills" },
  flow: { one: "Flow", many: "Flows" },
  checkin: { one: "Check-in questions", many: "Check-ins" },
  template: { one: "Template", many: "Templates" },
  theme: { one: "Theme", many: "Themes" },
};

/** The kind in a sentence: "this flow", "this set of check-in questions". Pure. */
export const KIND_NOUN: Readonly<Record<ShareKind, string>> = { assistant: "assistant", skill: "skill", flow: "flow", checkin: "set of check-in questions", template: "template", theme: "theme" };

/** `?kind=` as the address gives it, or "all". Pure. */
export function readKind(raw: string | null | undefined): KindFilter {
  return (SHARE_KINDS as readonly string[]).includes(raw ?? "") ? (raw as ShareKind) : "all";
}

/** `?sort=` as the address gives it, or "featured". Pure. */
export const readSort = (raw: string | null | undefined): CommunitySort => (raw === "downloads" ? "downloads" : "featured");

/** `#/community`, `#/community?kind=flow`, `#/community?kind=flow&sort=downloads`: where "Browse Community" goes. Pure. */
export function communityHash(kind: KindFilter = "all", sort: CommunitySort = "featured"): string {
  const params = new URLSearchParams();
  if (kind !== "all") params.set("kind", kind);
  if (sort !== "featured") params.set("sort", sort);
  const qs = params.toString();
  return qs ? `#/community?${qs}` : "#/community";
}

/**
 * A download count, rounded down so it reads at a glance: "7", "40+", "300+", "1k+", "12k+", "1.2m+". Null when
 * there's no count, or none yet: a new item isn't marked down for it. Pure.
 */
export function downloadCount(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return null;
  const whole = Math.floor(n);
  if (whole < 10) return String(whole);
  if (whole < 100) return `${Math.floor(whole / 10) * 10}+`;
  if (whole < 1000) return `${Math.floor(whole / 100) * 100}+`;
  if (whole < 1_000_000) return `${Math.floor(whole / 1000)}k+`;
  const m = Math.floor(whole / 100_000) / 10;
  return `${m % 1 ? m.toFixed(1) : m}m+`;
}

/** "1 download", "40+ downloads", "1k+ downloads", or null. Pure. */
export function downloadWords(n: number | null | undefined): string | null {
  const c = downloadCount(n);
  return c ? `${c} ${c === "1" ? "download" : "downloads"}` : null;
}

/** Does any item carry a count? The sort is offered only then. Pure. */
export const hasDownloads = (items: readonly CatalogueItem[]): boolean => items.some((i) => typeof i.downloads === "number");

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

const newest = (a: CatalogueItem, b: CatalogueItem) => Date.parse(b.added_at) - Date.parse(a.added_at) || a.name.localeCompare(b.name);

/** Featured first, then newest; or the most downloaded first (no count counts as none), then newest. Pure. */
export function ordered(items: readonly CatalogueItem[], sort: CommunitySort = "featured"): CatalogueItem[] {
  if (sort === "downloads") return [...items].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0) || newest(a, b));
  return [...items].sort((a, b) => Number(b.featured) - Number(a.featured) || newest(a, b));
}

/** The list for a filter, a search and a sort: in order, with counts per kind for the filter's labels. Pure. */
export function filtered(items: readonly CatalogueItem[], kind: KindFilter, query: string, accountName?: (provider: string) => string, sort: CommunitySort = "featured"): { items: CatalogueItem[]; counts: Record<KindFilter, number> } {
  const found = items.filter((i) => matches(i, query, accountName));
  const counts = { all: found.length, assistant: 0, skill: 0, flow: 0, checkin: 0, template: 0, theme: 0 } as Record<KindFilter, number>;
  for (const i of found) counts[i.kind]++;
  return { items: ordered(kind === "all" ? found : found.filter((i) => i.kind === kind), sort), counts };
}

/** "Version 1.3 → 1.4", "A newer version", for an update. Pure. */
export function versionWords(was: string | null, now: string | null): string {
  if (was && now && was !== now) return `Version ${was} → ${now}`;
  if (now) return `Version ${now}`;
  return "A newer version";
}

/** "Submit to Community": the two steps the owner takes, since Athena never publishes anything itself. Pure. */
export function submitSteps(kind: ShareKind, file: string): { hint: string; lede: string; steps: Array<{ title: string; detail: string }>; note: string } {
  return {
    hint: `Offer this ${KIND_NOUN[kind]} to everyone who uses Athena`,
    lede: "Athena won't publish it for you. It takes two steps:",
    steps: [
      { title: "Put the folder in a public GitHub repository of yours", detail: `Use the folder from Download, with ${file} at its top. If it came as a zip, unzip it first.` },
      { title: "Share it on the Community site", detail: "Sign in there and give the repository's link. The site reviews it before anyone can add it." },
    ],
    note: "The site opens in your browser. Athena sends it nothing.",
  };
}

// ---------- when the list was read, and "Check for new items" ----------

const clock = (d: Date, timeZone?: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(d);
const dayKey = (d: Date, timeZone?: string) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(d);

/** "today at 09:14", "yesterday at 21:03", "24 Nov at 09:14". Pure. */
export function readWhen(iso: string, now = new Date(), timeZone?: string): string {
  const at = new Date(iso);
  const day = dayKey(at, timeZone);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const when = day === dayKey(now, timeZone) ? "today" : day === dayKey(yesterday, timeZone) ? "yesterday" : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(at);
  return `${when} at ${clock(at, timeZone)}`;
}

/** The line beside "Check for new items": "Last read today at 09:14." Null when the list was never read. Pure. */
export const lastReadWords = (fetchedAt: string | null | undefined, now = new Date(), timeZone?: string): string | null => (fetchedAt ? `Last read ${readWhen(fetchedAt, now, timeZone)}.` : null);

/**
 * What a check says, for the polite live region: up to date as of the copy's time, read just now with how many items
 * weren't in the list before, or the catalogue's words and the time of the list still shown. Pure.
 */
export function checkWords(v: { checked?: "read" | "recent"; error: string | null; fetched_at: string | null; items: readonly { id: string }[] }, before: ReadonlySet<string>, now = new Date(), timeZone?: string): string {
  const when = v.fetched_at ? readWhen(v.fetched_at, now, timeZone) : null;
  if (v.error) return when ? `${v.error} Showing the list from ${when}.` : v.error;
  if (v.checked === "recent") return when ? `Up to date as of ${when}.` : "Up to date.";
  const added = v.items.filter((i) => !before.has(i.id)).length;
  return added ? `Read just now. ${added} new ${added === 1 ? "item" : "items"}.` : "Read just now. Nothing new.";
}

/** A kind with nothing listed: its name, and when the list was last read so the check beside it makes sense. Pure. */
export function emptyKindWords(kind: ShareKind, fetchedAt: string | null, now = new Date(), timeZone?: string): { title: string; sub: string } {
  return { title: `No ${KIND_WORDS[kind].many.toLowerCase()} yet`, sub: lastReadWords(fetchedAt, now, timeZone) ?? "" };
}
