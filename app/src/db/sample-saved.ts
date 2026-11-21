/**
 * Sample Saved items for sample mode: a fortnight of links (with readable
 * copies), images, quotes, snippets and notes, dated back from today so the
 * Day pages and the Library both have something. Changes live in memory
 * until the page reloads. Images are small files in /sample/saved/.
 */

import { localToday } from "../lib/time";
import { planSave, siteOf, type SavedItem, type SavedKind } from "../../../lib/saved-rules";
import { BUILTIN, describeActions, itemName } from "../../../lib/saved-action-rules";
import type { SavedFacts, SavedThing } from "../../../lib/saved-kinds";
import { sampleNotes, samplePeople } from "./sample-data";
import { samplePreview } from "./sample-rich-links";
import type { ActionResult, NewSaved, SavedActions, SavedPage, SavedQuery } from "./saved";
import { PRICED_SEEDS, seedSampleTrackers, withSamplePricesNow } from "./sample-trackers";

const SLEEP = `Most of us treat sleep as the thing we cut when the week gets busy. The research suggests that is exactly backwards: the hours we lose are the ones that consolidate what we learned during the day, and the cost compounds quietly.

In a series of studies at the University of California, participants who slept a full eight hours before a memory test recalled roughly forty per cent more than those who stayed up. The effect held even when the sleep-deprived group had extra time to study.

## What happens overnight

What changes overnight is not just rest. During deep slow-wave sleep the brain replays the patterns it formed while awake, moving them from short-term storage in the hippocampus to longer-term homes in the cortex.

That replay is fragile. Alcohol, late caffeine and irregular bedtimes all shorten the deep stages, and the first to go are the hours between two and four in the morning, when most of the consolidation happens.

> Sleep is not the absence of work; it is when a good share of the work gets done.

## What to try this week

The practical advice is unglamorous. Keep the same wake time every day, weekends included. Stop caffeine by early afternoon. Keep the bedroom cool and dark, and leave the phone in another room.

• Same wake time, seven days.
• No caffeine after 2pm.
• Phone out of the bedroom.

None of this is new, but the size of the effect is. If you are trying to learn something hard, a language, an instrument, a new codebase, the night after you practise matters about as much as the practice itself.`;

const HOUSE = `Walk into a traditional Japanese house and the first thing you notice is how little there is. The second is how much that little does.

The rooms are measured in tatami mats, each roughly 90 by 180 centimetres, so a six-mat room is a size everyone can picture. Sliding paper screens divide the space for sleeping and open it again for the day. Furniture folds away; the floor is the furniture.

## Light, filtered

Shoji screens turn harsh daylight into something soft and even. Deep eaves keep the summer sun off the walls but let the low winter sun reach far into the room. The result is a house that changes with the hour without anyone touching a switch.

## What travels well

You don't need a machiya in Kyoto to borrow the ideas. Fewer, better things. Storage that hides everything. One window you sit beside on purpose. A threshold, even a small one, between outside and in.

Several British architects have been doing exactly this in terraced houses: a lowered floor by the garden door, a built-in bench along a wall, a single long shelf instead of three cabinets. The houses feel larger, and calmer, without being any bigger.`;

const README = `A README is the first page most people read and the last one most authors write. It doesn't need to be long. It needs to answer four questions quickly.

## What is this?

One or two sentences. Not the history of the project, not the architecture: what it does and who it is for.

## How do I run it?

The shortest path from a fresh clone to something working. Copy-pasteable commands, in order. If there is a setup step that always trips people up, say so here, not in an issue thread.

## How do I use it?

One realistic example, with its output. People learn faster from an example than from a list of options.

## Where do I go next?

Links to the full docs, how to report a bug, and how to contribute. Keep it short.

Write it for the person who arrives tired, from a search result, with ten minutes to decide whether your project solves their problem.`;

interface Seed {
  id: string;
  days: number;
  time: string;
  kind: SavedKind;
  source: SavedItem["source"];
  url?: string;
  title?: string;
  site?: string;
  author?: string;
  published_at?: string;
  excerpt?: string;
  quote?: string;
  note?: string;
  tags?: string[];
  source_url?: string;
  image?: [file: string, w: number, h: number, tone: string];
  readable?: string;
  fetch_status?: SavedItem["fetch_status"];
  thing?: SavedThing;
  facts?: SavedFacts;
}

const SEEDS: Seed[] = [
  {
    id: "s-sleep", days: 0, time: "00:42", kind: "link", source: "shortcut",
    url: "https://longform.example/science/why-sleep-is-when-you-learn", title: "Why sleep is when you learn", site: "The Longform Review", author: "Hannah Okafor", published_at: "2026-10-21",
    excerpt: "The hours we cut are the ones that keep what we learned.", note: "For the team talk on focus. The 2–4am bit is the surprising part.", tags: ["sleep", "talk"],
    image: ["night.webp", 1200, 675, "#26386c"], readable: SLEEP, fetch_status: "ok",
  },
  {
    id: "s-quote-sleep", days: 0, time: "00:38", kind: "quote", source: "extension",
    quote: "Sleep is not the absence of work; it is when a good share of the work gets done.", title: "Why sleep is when you learn", site: "The Longform Review",
    source_url: "https://longform.example/science/why-sleep-is-when-you-learn",
  },
  {
    id: "s-palette", days: 0, time: "02:15", kind: "image", source: "shortcut",
    note: "Colours for the kitchen repaint. Terracotta for the one wall?", image: ["palette.webp", 900, 1200, "#cbb79c"],
  },
  {
    id: "s-bread", days: 1, time: "19:05", kind: "link", source: "share-target",
    url: "https://www.youtube.com/watch?v=k8sQ2Lq1abc", title: "Making sourdough at home: a slow weekend loaf", site: "YouTube", author: "Bake With Jo",
    excerpt: "A calm walk through a weekend loaf, from starter to crumb shot.", image: ["bread.webp", 1200, 675, "#c9a27c"], fetch_status: "preview", note: "Try Saturday",
  },
  {
    id: "s-git", days: 1, time: "10:22", kind: "snippet", source: "extension",
    quote: "git log --oneline --graph --decorate --all -20", note: "The nicer history view", site: "Stack Overflow", source_url: "https://stackoverflow.com/questions/1057564",
  },
  {
    id: "s-house", days: 2, time: "21:30", kind: "link", source: "extension",
    url: "https://fieldnotes.example/architecture/the-quiet-genius-of-the-japanese-house", title: "The quiet genius of the Japanese house", site: "Field Notes on Design", author: "Kenji Mori", published_at: "2026-09-30",
    excerpt: "Fewer, better things, and light that changes with the hour.", image: ["house.webp", 1200, 675, "#c9d0c7"], readable: HOUSE, fetch_status: "ok", tags: ["home"],
  },
  {
    id: "s-gift", days: 2, time: "13:02", kind: "note", source: "shortcut",
    quote: "Gift idea for Ana: the Ottolenghi cookbook, and a bottle of the good olive oil from Borough.",
  },
  {
    id: "s-shelf", days: 3, time: "11:48", kind: "image", source: "app",
    note: "Hallway shelves, measured on Saturday", image: ["shelf.webp", 1000, 1250, "#e6e1d6"], tags: ["home"],
  },
  {
    id: "s-durant", days: 3, time: "22:10", kind: "quote", source: "share-target",
    quote: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", title: "The Story of Philosophy", author: "Will Durant", site: "Kindle",
  },
  {
    id: "s-ride", days: 5, time: "17:20", kind: "link", source: "shortcut",
    url: "https://www.komoot.com/tour/1785522", title: "A 42 km loop through the Surrey Hills", site: "komoot", excerpt: "Box Hill, Ranmore Common and back through Dorking. 640 m of climbing.",
    image: ["bike.webp", 1200, 675, "#dfe5dc"], fetch_status: "preview", note: "With Sam, once the weather turns",
  },
  {
    id: "s-sql", days: 5, time: "09:41", kind: "snippet", source: "app",
    quote: "SELECT date_trunc('week', saved_at) AS week, count(*)\nFROM saved_items\nWHERE archived_at IS NULL\nGROUP BY 1\nORDER BY 1 DESC;",
    note: "Weekly counts",
  },
  {
    id: "s-readme", days: 8, time: "15:03", kind: "link", source: "extension",
    url: "https://github.blog/developer-skills/how-to-write-a-good-readme", title: "How to write a README people actually read", site: "The GitHub Blog", author: "Priya Shah", published_at: "2026-08-14",
    excerpt: "Four questions, answered quickly.", readable: README, fetch_status: "ok", tags: ["writing"],
  },
  {
    id: "s-hills", days: 8, time: "20:44", kind: "image", source: "share-target",
    note: "Print for the spare room?", image: ["hills.webp", 1200, 900, "#c47a72"], source_url: "https://www.etsy.com/listing/1520",
  },
  {
    id: "5a3e5a7e-0000-4000-8000-00000000b001", days: 0, time: "01:05", kind: "link", source: "extension",
    url: "https://www.goodreads.com/book/show/59808223-lapvona", title: "Lapvona", site: "Goodreads", author: "Ottessa Moshfegh",
    excerpt: "A fable of a village in a medieval fiefdom, and the lamb-herding boy at its centre.", image: ["book.webp", 900, 1200, "#8f3b2e"], fetch_status: "preview",
    note: "Ana's recommendation", thing: "book", facts: { name: "Lapvona", by: "Ottessa Moshfegh", isbn: "9780593300268" },
  },
  {
    id: "5a3e5a7e-0000-4000-8000-00000000b002", days: 1, time: "21:40", kind: "link", source: "share-target",
    url: "https://marlowandfinch.example/products/sage-linen-wrap-dress", title: "Sage linen wrap dress", site: "Marlow & Finch",
    excerpt: "Washed linen, a tie waist and deep pockets.", image: ["dress.webp", 900, 1200, "#a9b59a"], fetch_status: "preview",
    thing: "product", facts: { name: "Sage linen wrap dress", price: "85", currency: "GBP", shop: "Marlow & Finch" },
  },
  {
    id: "5a3e5a7e-0000-4000-8000-00000000b003", days: 2, time: "18:12", kind: "link", source: "shortcut",
    url: "https://maps.app.goo.gl/towpathcafe", title: "Towpath Café", site: "Google Maps", fetch_status: "failed",
    note: "Breakfast by the canal, Sunday?", thing: "place", facts: { name: "Towpath Café", address: "42 De Beauvoir Crescent, London N1 5SB" },
  },
  {
    id: "s-beck", days: 12, time: "10:00", kind: "quote", source: "extension",
    quote: "Make it work, make it right, make it fast.", author: "Kent Beck", site: "wiki.c2.com", source_url: "https://wiki.c2.com/?MakeItWorkMakeItRightMakeItFast",
  },
  // Gift ideas with a price history (db/sample-trackers.ts): last, so no other sample id moves.
  ...PRICED_SEEDS,
];

const words = (s: string | undefined) => (s ? (s.match(/\S+/g) ?? []).length : null);

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

let items: SavedItem[] | null = null;

function all(): SavedItem[] {
  if (items) return items;
  const today = localToday();
  // UUID-shaped like the other sample ids, so an @ mention of one is a real athena:// link.
  items = SEEDS.map((s, i) => {
    const day = addDays(today, -s.days);
    // Today's are minutes or hours ago, never later than now.
    const at = s.days === 0 ? new Date(Date.now() - Number(s.time.split(":")[1]) * 60_000 - Number(s.time.split(":")[0]) * 3_600_000) : new Date(`${day}T${s.time}:00`);
    return {
      id: `5a3e5a7e-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      kind: s.kind,
      url: s.url ?? null,
      title: s.title ?? null,
      site: s.site ?? siteOf(s.url ?? s.source_url) ?? null,
      author: s.author ?? null,
      published_at: s.published_at ?? null,
      excerpt: s.excerpt ?? null,
      quote: s.quote ?? null,
      note: s.note ?? null,
      tags: s.tags ?? [],
      source: s.source,
      source_url: s.source_url ?? null,
      image_url: s.image ? `/sample/saved/${s.image[0]}` : null,
      image_w: s.image?.[1] ?? null,
      image_h: s.image?.[2] ?? null,
      image_tone: s.image?.[3] ?? null,
      saved_at: at.toISOString(),
      saved_on: day,
      archived: false,
      has_readable: !!s.readable,
      fetch_status: s.fetch_status ?? null,
      readable: s.readable ?? null,
      words: words(s.readable),
      thing: s.thing ?? (s.kind === "image" ? "image" : null),
      facts: s.facts ?? null,
      filed: null,
    };
  }).sort((a, b) => b.saved_at.localeCompare(a.saved_at));
  // What the sample tracks on these items, and on their own (db/sample-trackers.ts).
  seedSampleTrackers(items);
  return items;
}

const strip = (i: SavedItem): SavedItem => ({ ...i, readable: undefined });

export function sampleSavedPage(query: SavedQuery): SavedPage {
  const live = all().filter((i) => !i.archived);
  const main = live.filter((i) => !i.filed);
  const counts = { all: main.length, link: 0, image: 0, quote: 0, snippet: 0, note: 0, filed: live.length - main.length } as SavedPage["counts"];
  for (const i of main) counts[i.kind]++;
  // Filed items leave the main list; a day and a search still find them.
  const pool = query.filed ? live.filter((i) => i.filed).sort((a, b) => b.filed!.at.localeCompare(a.filed!.at)) : query.day || query.q?.trim() ? live : main;
  let list = pool.filter((i) => (!query.kind || i.kind === query.kind) && (!query.day || i.saved_on === query.day));
  const q = query.q?.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    list = list
      .map((i) => ({ i, hay: [i.title, i.note, i.quote, i.excerpt, i.site, i.author, i.tags.join(" "), i.readable].filter(Boolean).join(" ").toLowerCase() }))
      .filter((x) => terms.every((t) => x.hay.includes(t)))
      .map((x) => {
        const text = [x.i.note, x.i.quote, x.i.excerpt, x.i.readable].find((t) => t && t.toLowerCase().includes(terms[0])) ?? "";
        const at = text.toLowerCase().indexOf(terms[0]);
        const match = text ? `${at > 60 ? "… " : ""}${text.slice(Math.max(0, at - 60), at + 110).replace(/\s+/g, " ").trim()}${at + 110 < text.length ? " …" : ""}` : undefined;
        return { ...strip(x.i), ...(match ? { match } : {}) };
      });
    return { items: withSamplePricesNow(list), counts, more: false };
  }
  return { items: withSamplePricesNow(list.map(strip)), counts, more: false };
}

export function sampleSavedItem(id: string): SavedItem | null {
  return all().find((i) => i.id === id) ?? null;
}

export function sampleSaveNew(input: NewSaved): SavedItem {
  const plan = planSave({ ...input, hasImage: !!input.image });
  if (!plan) throw new Error("There was nothing to save");
  const now = new Date();
  // A link with a sample preview (sample-rich-links.ts) lands as that card: title, picture and what it is.
  const known = plan.kind === "link" && plan.url ? samplePreview(plan.url) : null;
  const rich = known?.title ? known : null;
  const item: SavedItem = {
    id: `s-new-${now.getTime()}`,
    kind: plan.kind,
    url: plan.url,
    title: rich?.title ?? plan.title,
    site: rich?.site_name ?? siteOf(plan.url ?? plan.source_url),
    author: rich?.facts?.by ?? rich?.author ?? null,
    published_at: null,
    excerpt: rich?.summary ?? null,
    quote: plan.quote,
    note: plan.note,
    tags: [],
    source: input.source,
    source_url: plan.source_url,
    image_url: input.image ? URL.createObjectURL(input.image) : (rich?.image_url ?? null),
    image_w: rich?.image_w ?? null,
    image_h: rich?.image_h ?? null,
    image_tone: rich?.image_tone ?? null,
    saved_at: now.toISOString(),
    saved_on: localToday(),
    archived: false,
    has_readable: false,
    fetch_status: plan.kind === "link" ? "preview" : null,
    readable: null,
    words: null,
    ...(rich?.kind && { thing: rich.kind, facts: { name: rich.title ?? undefined, ...(rich.facts ?? {}) } }),
  };
  all().unshift(item);
  return item;
}

export function sampleSavedPatch(id: string, patch: { title?: string | null; note?: string | null; tags?: string[]; archived?: boolean }): SavedItem {
  const item = all().find((i) => i.id === id);
  if (!item) throw new Error("Not found");
  if (patch.title !== undefined) item.title = patch.title;
  if (patch.note !== undefined) item.note = patch.note;
  if (patch.tags) item.tags = patch.tags;
  if (patch.archived !== undefined) item.archived = patch.archived;
  return item;
}

export function sampleSavedDelete(id: string): void {
  items = all().filter((i) => i.id !== id);
}

// ---------- actions (lib/saved-action-rules.ts; the server runs them in lib/saved-actions.ts) ----------

const links = new Map<string, Array<{ kind: string; id: string; title: string }>>();

export function sampleSavedActions(id: string): SavedActions {
  const item = sampleSavedItem(id);
  if (!item) throw new Error("Not found");
  return { actions: describeActions(Object.values(BUILTIN), item), filed: item.filed ?? null, links: links.get(id) ?? [] };
}

/** What the server would do, kept in memory: the item is filed with a label like the real one. */
export function sampleRunAction(id: string, action: string, params: Record<string, unknown>): { item: SavedItem; result: ActionResult } {
  const item = sampleSavedItem(id);
  if (!item) throw new Error("Not found");
  const person = samplePeople().find((p) => p.id === params.person_id);
  const note = sampleNotes().find((n) => n.id === params.note_id);
  const name = itemName(item);
  let result: ActionResult;
  if (action === "watch_read") {
    result = { label: "Watch & read", href: "#/reading", filed: true, undo: null, done: "Moved to Watch & read" };
    void fileToWatch(item);
  }
  else if (action === "gift_idea") {
    if (!person) throw new Error("Pick someone in People.");
    const where = `${person.name} · Gift ideas`;
    result = { label: where, href: null, filed: true, undo: null, done: `Added to ${where}` };
  } else if (action === "add_to_list") {
    const where = note?.title ?? (typeof params.list_title === "string" && params.list_title.trim()) ?? "";
    if (!where) throw new Error("Pick a list, or name a new one.");
    result = { label: where, href: note ? `#/notes/${note.id}` : null, filed: true, undo: null, done: `Added to ${where}` };
  } else if (action === "save_place") result = { label: "Places", href: "#/places", filed: true, undo: null, done: `Saved ${name} to Places` };
  else if (action === "make_todo") {
    const title = (typeof params.title === "string" && params.title.trim()) || name;
    result = { label: "To-dos", href: "#/loops", filed: true, undo: null, done: `Added “${title}” to your to-dos` };
  } else if (action === "link") {
    const t = params.target as { kind?: string; id?: string } | undefined;
    const title = samplePeople().find((p) => p.id === t?.id)?.name ?? sampleNotes().find((n) => n.id === t?.id)?.title;
    if (!t?.kind || !t.id || !title) throw new Error("Pick who or what to link it to.");
    links.set(id, [{ kind: t.kind, id: t.id, title }, ...(links.get(id) ?? []).filter((l) => l.id !== t.id)]);
    result = { label: title, href: t.kind === "person" ? `#/people/${t.id}` : `#/notes/${t.id}`, filed: false, undo: { op: "unlink", target_id: t.id }, done: `Linked to ${title}` };
  } else throw new Error(`There's no action called ${action}.`);
  if (result.filed) item.filed = { at: new Date().toISOString(), action, label: result.label, href: result.href };
  return { item, result };
}

export function sampleUndoAction(id: string, undo?: unknown): SavedItem {
  const item = sampleSavedItem(id);
  if (!item) throw new Error("Not found");
  const target = (undo as { target_id?: string } | undefined)?.target_id;
  if (target) links.set(id, (links.get(id) ?? []).filter((l) => l.id !== target));
  else item.filed = null;
  return item;
}

const WATCH_KIND: Partial<Record<SavedThing, "film" | "tv" | "book" | "video">> = { film: "film", show: "tv", book: "book", video: "video" };

/** Sample mode's half of "Move to Watch & read": the item joins Watch & read, with its picture as the cover. */
async function fileToWatch(item: SavedItem): Promise<void> {
  const [{ saveReading }, { keepArt }] = await Promise.all([import("./memory"), import("../components/art-img")]);
  let art = item.image_url && item.image_w && item.image_h ? { id: `saved-${item.id}`, w: item.image_w, h: item.image_h, tone: item.image_tone ?? undefined } : undefined;
  if (art && item.image_url) {
    const blob = await fetch(item.image_url).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
    if (blob) await keepArt(art.id, blob);
    else art = undefined;
  }
  const year = Number(item.facts?.year);
  await saveReading({ title: item.title ?? itemName(item), kind: WATCH_KIND[item.thing as SavedThing] ?? "video", author: item.author ?? item.facts?.by ?? "", url: item.url ?? "", source: "saved", ...(art && { art }), ...(year && { meta: { year } }) });
}
