/**
 * Sample mode's Community catalogue: a dozen made-up items across the three kinds and the three reach tiers, each
 * with real files, so the `#/community` list and the `#/add` preview work with no server. The hashes are worked out
 * from the files (bundleHash), as the catalogue's build does, and each item's reach is the one its files give
 * (sample-community.test.ts checks both). Authors are made-up GitHub-style names.
 *
 *   sampleCatalogue()   the index
 *   sampleBundle(id)    one item and its files, as netlify/lib/community-catalogue.ts loadBundle gives them
 *   sampleUpdates()     what sample mode's own items would hear from the daily check
 */
import { bundleHash, type CatalogueBundle, type CatalogueFile, type CatalogueIndex, type CatalogueItem } from "../../../lib/catalogue-types";
import type { Reach } from "../../../lib/reach";
import type { ShareKind } from "../../../lib/share-kinds";
import type { UpdateCheck } from "../../../lib/community-api";
import { SAMPLE_FLOW_IDS } from "./sample-flows";
import { SAMPLE_TEAM_IDS } from "./sample-team";

interface Seed {
  id: string;
  kind: ShareKind;
  slug: string;
  name: string;
  summary: string;
  author: string | null;
  version: string | null;
  reach: Reach;
  featured: boolean;
  days: number;
  files: CatalogueFile[];
}

const reach = (tier: Reach["tier"], over: Partial<Omit<Reach, "tier">> = {}): Reach => ({ tier, model: tier > 1, web: tier === 3, lookups: [], needs: [], ...over });
const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
const skillMd = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

const assistant = (o: Record<string, unknown>) => json({ format: 1, ...o });
const flow = (o: Record<string, unknown>) => json({ format: 1, asks: [], needs: [], money: false, web: false, ...o });

/** Every item, newest first by `days` ago. Ids are made up, in the catalogue's alphabet. */
const SEEDS: Seed[] = [
  {
    id: "k3m9p2q7r4s8t1v6",
    kind: "flow",
    slug: "bin-day",
    name: "Bin day",
    summary: "A reminder the evening before the bins go out, and which ones.",
    author: "kerbside-kit",
    version: "1.2",
    reach: reach(1),
    featured: true,
    days: 2,
    files: [
      {
        path: "flow.json",
        text: flow({
          name: "Bin day",
          summary: "A reminder the evening before the bins go out, and which ones.",
          trigger: { kind: "schedule", days: [3], time: "19:00" },
          steps: [{ id: "remind", title: null, kind: "tool", tool: "add_reminder", input: { text: ["Bins out tonight: ", { blank: "bins" }], date: [{ from: "trigger", key: "date" }], time: ["20:00"] }, go: "auto", gives: [] }],
          asks: [{ key: "bins", question: "Which bins go out?", choices: ["Recycling and garden", "General waste"] }],
        }),
      },
    ],
  },
  {
    id: "h7j2k8m3n9p4q1r5",
    kind: "assistant",
    slug: "inbox-sorter",
    name: "Inbox sorter",
    summary: "Reads new email each morning and turns what needs you into to-dos, with the sender linked.",
    author: "maple-and-ink",
    version: "2.0",
    reach: reach(2, { needs: ["gmail"] }),
    featured: true,
    days: 4,
    files: [
      {
        path: "assistant.json",
        text: assistant({
          name: "Sorter",
          job: "Turns email that needs you into to-dos",
          summary: "Reads new email each morning and turns what needs you into to-dos, with the sender linked.",
          instructions: "Each morning, read the new email. When one asks you to do something, add a to-do linked to the sender. Leave newsletters alone.",
          needs: ["gmail"],
        }),
      },
    ],
  },
  {
    id: "c4d8f2g6h1j5k9m3",
    kind: "skill",
    slug: "meeting-notes",
    name: "Meeting notes",
    summary: "Writes up a meeting as decisions, actions with owners, and open questions.",
    author: "quiet-desk",
    version: "1.0",
    reach: reach(2),
    featured: true,
    days: 6,
    files: [
      { path: "SKILL.md", text: skillMd("meeting-notes", "Use when asked to write up a meeting.", "Write three short sections: Decisions, Actions (each with an owner and a date) and Open questions. Keep each line under twenty words.") },
      { path: "references/example.md", text: "# Example\n\n## Decisions\n- Launch moves to March.\n\n## Actions\n- Sam: draft the plan by Friday.\n" },
    ],
  },
  {
    id: "t5v9w3x7y2z6a1b4",
    kind: "assistant",
    slug: "trip-scout",
    name: "Trip scout",
    summary: "Looks up opening times, prices and how to get there for the places on your next trip.",
    author: "wander-notes",
    version: "0.9",
    reach: reach(3),
    featured: false,
    days: 9,
    files: [
      {
        path: "assistant.json",
        text: assistant({
          name: "Scout",
          job: "Researches the places on your next trip",
          summary: "Looks up opening times, prices and how to get there for the places on your next trip.",
          instructions: "For each place on the next trip, find its opening hours, the price of entry and the quickest way there from where you're staying. Say where each fact came from.",
          web: true,
        }),
      },
    ],
  },
  {
    id: "r8s2t6v1w5x9y3z7",
    kind: "flow",
    slug: "rain-check",
    name: "Rain check",
    summary: "Before an outdoor event, checks the forecast and tells you if it looks wet.",
    author: "drizzle-dev",
    version: "1.0",
    reach: reach(2, { model: false, lookups: ["weather"] }),
    featured: false,
    days: 11,
    files: [
      {
        path: "flow.json",
        text: flow({
          name: "Rain check",
          summary: "Before an outdoor event, checks the forecast and tells you if it looks wet.",
          trigger: { kind: "before", what: "event", minutes: 720 },
          steps: [
            { id: "sky", title: "Check the forecast", kind: "tool", tool: "weather", input: { date: [{ from: "trigger", key: "starts_at" }] }, go: "auto", gives: [{ key: "result", label: "what it found", kind: "text" }] },
            { id: "tell", title: null, kind: "notify", text: ["Forecast for ", { from: "trigger", key: "event" }, ": ", { from: "sky", key: "result" }] },
          ],
        }),
      },
    ],
  },
  {
    id: "m2n6p1q5r9s3t7v2",
    kind: "skill",
    slug: "polite-no",
    name: "Polite no",
    summary: "Drafts a kind, short reply that turns down an invitation without a long excuse.",
    author: null,
    version: null,
    reach: reach(2),
    featured: false,
    days: 14,
    files: [{ path: "SKILL.md", text: skillMd("polite-no", "Use when asked to decline an invitation or a request.", "Thank them, say no plainly in one sentence, and offer something smaller only if it's true. No long reasons.") }],
  },
  {
    id: "d6f1g5h9j3k7m2n8",
    kind: "flow",
    slug: "late-train",
    name: "Late train",
    summary: "On weekday mornings, checks your usual train and tells you when it's running late.",
    author: "platform-four",
    version: "1.1",
    reach: reach(2, { model: false, lookups: ["train_status"] }),
    featured: false,
    days: 17,
    files: [
      {
        path: "flow.json",
        text: flow({
          name: "Late train",
          summary: "On weekday mornings, checks your usual train and tells you when it's running late.",
          trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], time: "07:15" },
          steps: [
            { id: "train", title: "Check the train", kind: "tool", tool: "train_status", input: {}, go: "auto", gives: [{ key: "result", label: "what it found", kind: "text" }] },
            { id: "tell", title: null, kind: "notify", text: [{ from: "train", key: "result" }] },
          ],
        }),
      },
    ],
  },
  {
    id: "w1x5y9z3a7b2c6d1",
    kind: "assistant",
    slug: "standup-helper",
    name: "Standup helper",
    summary: "Before standup, lists what you closed yesterday and what's next, ready to paste into Slack.",
    author: "sprint-goose",
    version: "1.3",
    reach: reach(2, { needs: ["linear", "slack"] }),
    featured: false,
    days: 20,
    files: [
      {
        path: "assistant.json",
        text: assistant({
          name: "Pip",
          job: "Gets your standup ready",
          summary: "Before standup, lists what you closed yesterday and what's next, ready to paste into Slack.",
          instructions: "At 09:20 on weekdays, list the issues closed yesterday and the ones in progress, in three lines or fewer.",
          needs: ["linear", "slack"],
        }),
      },
    ],
  },
  {
    id: "f3g7h2j6k1m5n9p4",
    kind: "skill",
    slug: "recipe-scaler",
    name: "Recipe scaler",
    summary: "Scales a recipe up or down and rounds the amounts to ones you can measure.",
    author: "batch-cook",
    version: "1.0",
    reach: reach(2),
    featured: false,
    days: 24,
    files: [{ path: "SKILL.md", text: skillMd("recipe-scaler", "Use when asked to make a recipe for more or fewer people.", "Multiply each amount, then round to the nearest spoon, 5 g or 25 ml. Keep cooking times the same unless the tin size changes.") }],
  },
  {
    id: "y4z8a3b7c2d6f1g5",
    kind: "flow",
    slug: "chase-a-reply",
    name: "Chase a reply",
    summary: "When an email you sent gets no answer in five days, drafts a short follow-up for you to check.",
    author: "maple-and-ink",
    version: "1.0",
    reach: reach(2, { needs: ["gmail"] }),
    featured: false,
    days: 30,
    files: [
      {
        path: "flow.json",
        text: flow({
          name: "Chase a reply",
          summary: "When an email you sent gets no answer in five days, drafts a short follow-up for you to check.",
          trigger: { kind: "event", event: { source: "collected", connector: "gmail", kind: "awaiting-reply" } },
          steps: [{ id: "draft", title: null, kind: "tool", tool: "draft_email", input: { about: ["A friendly nudge about ", { from: "trigger", key: "title" }] }, go: "ask", gives: [{ key: "draft", label: "the draft", kind: "text" }] }],
          needs: ["gmail"],
        }),
      },
    ],
  },
  {
    id: "n5p9q4r8s3t7v2w6",
    kind: "skill",
    slug: "weekly-review",
    name: "Weekly review",
    summary: "On Fridays, walks through the week: what got done, what slipped, and one thing for next week.",
    author: "quiet-desk",
    version: "2.1",
    reach: reach(2),
    featured: false,
    days: 38,
    files: [{ path: "SKILL.md", text: skillMd("weekly-review", "Use for a weekly review.", "List what got done, what slipped and why in a few words, then ask for one thing to carry into next week.") }],
  },
  {
    id: "g6h1j5k9m4n8p3q7",
    kind: "assistant",
    slug: "running-coach",
    name: "Running coach",
    summary: "Looks at your runs each week and suggests next week's, easing off when you've done a lot.",
    author: "long-way-round",
    version: "0.4",
    reach: reach(2, { needs: ["strava"] }),
    featured: false,
    days: 45,
    files: [
      {
        path: "assistant.json",
        text: assistant({
          name: "Coach",
          job: "Plans next week's runs",
          summary: "Looks at your runs each week and suggests next week's, easing off when you've done a lot.",
          instructions: "On Sunday evening, look at this week's runs and suggest next week's: three runs, one long, with distances. Ease off by a fifth after a big week.",
          needs: ["strava"],
        }),
      },
    ],
  },
  {
    id: "q8r3s7t2v6w1x5y9",
    kind: "flow",
    slug: "gift-price-watch",
    name: "Gift price watch",
    summary: "Checks the prices on your gift ideas each week and tells you when one drops by a fifth or more.",
    author: "kerbside-kit",
    version: "1.4",
    reach: reach(2),
    featured: false,
    days: 52,
    files: [
      {
        path: "flow.json",
        text: flow({
          name: "Gift price watch",
          summary: "Checks the prices on your gift ideas each week and tells you when one drops by a fifth or more.",
          trigger: { kind: "schedule", days: [6], time: "09:00" },
          steps: [
            { id: "prices", title: "Check the prices", kind: "tool", tool: "tracker_history", input: { query: ["Gift ideas"] }, go: "auto", gives: [{ key: "result", label: "what it found", kind: "text" }] },
            { id: "judge", title: "Is it a good price?", kind: "think", task: ["Say in one line which gift ideas dropped by a fifth or more: ", { from: "prices", key: "result" }], web: false, gives: [{ key: "answer", label: "the answer", kind: "text" }] },
            { id: "tell", title: null, kind: "notify", text: [{ from: "judge", key: "answer" }] },
          ],
        }),
      },
    ],
  },
];

/** Taken down, with the catalogue's reasons. */
const WITHDRAWN = [{ id: "z2a6b1c5d9f4g8h3", reason: "It stopped working after Linear changed how issues are labelled." }];

const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.UTC(2026, 10, 24, 9) - days * DAY).toISOString();

let built: Promise<Array<{ item: CatalogueItem; bundle: CatalogueBundle }>> | null = null;

function build() {
  return (built ??= Promise.all(
    SEEDS.map(async (s) => {
      const hash = await bundleHash(s.files);
      const item: CatalogueItem = {
        id: s.id,
        kind: s.kind,
        slug: s.slug,
        name: s.name,
        summary: s.summary,
        author: s.author,
        version: s.version,
        reach: s.reach,
        needs: [...s.reach.needs],
        hash,
        min_format: 1,
        featured: s.featured,
        added_at: at(s.days),
        bundle: `bundles/${s.id}.json`,
      };
      return { item, bundle: { id: s.id, hash, kind: s.kind, files: s.files.map((f) => ({ ...f })) } };
    })
  ));
}

/** The sample index. */
export async function sampleCatalogue(): Promise<CatalogueIndex> {
  const all = await build();
  return { format: 1, generated_at: at(0), items: all.map((a) => a.item), withdrawn: WITHDRAWN.map((w) => ({ ...w, at: at(3) })) };
}

/** One sample item and its files, or null when there's no such item. */
export async function sampleBundle(id: string): Promise<{ item: CatalogueItem; bundle: CatalogueBundle } | null> {
  const found = (await build()).find((a) => a.item.id === id);
  return found ? { item: { ...found.item }, bundle: { ...found.bundle, files: found.bundle.files.map((f) => ({ ...f })) } } : null;
}

/** Sample items already added: Gift price watch (an older version) and Dot (taken down since). */
export const SAMPLE_ADDED = ["q8r3s7t2v6w1x5y9", "z2a6b1c5d9f4g8h3"];
const GIFT = "q8r3s7t2v6w1x5y9";

/** One item here that came from a sample listing: what Add or Update made, and the files' hash it was made from. */
export interface SampleAdded {
  kind: ShareKind;
  id: string;
  hash: string;
  version: string | null;
}

/** Sample mode's record of what came from which listing, as the catalogue_* columns are on a real Athena. For this visit. */
const added = new Map<string, SampleAdded>([[GIFT, { kind: "flow", id: SAMPLE_FLOW_IDS.gift, hash: `sha256-${"1".repeat(64)}`, version: "1.3" }]]);

/** The item here that came from this listing, if any. */
export const sampleAddedFrom = (catalogueId: string): SampleAdded | null => added.get(catalogueId) ?? null;
/** Remember an Add or an Update from a listing. */
export const rememberSampleAdd = (catalogueId: string, item: SampleAdded): void => void added.set(catalogueId, item);
/** Every listing something here came from, for the list's "Added" marks: Dot's too, though it was taken down. */
export const sampleAddedIds = (): string[] => [...new Set([...SAMPLE_ADDED, ...added.keys()])];

/** What sample mode's own flow and assistant would hear from the daily check. */
export async function sampleUpdates(): Promise<UpdateCheck[]> {
  const gift = (await build()).find((a) => a.item.id === GIFT)!.item;
  const here = added.get(GIFT)!;
  const newer: UpdateCheck[] =
    here.hash === gift.hash
      ? []
      : [
          {
            kind: "flow",
            id: here.id,
            catalogue_id: gift.id,
            version: here.version,
            hash: here.hash,
            newer: { version: gift.version, hash: gift.hash, summary: gift.summary, reach: gift.reach },
            tier_here: 1,
            withdrawn: null,
          },
        ];
  return [
    ...newer,
    { kind: "assistant", id: SAMPLE_TEAM_IDS.dot, catalogue_id: WITHDRAWN[0].id, version: "1.0", hash: `sha256-${"2".repeat(64)}`, newer: null, withdrawn: { at: at(3), reason: WITHDRAWN[0].reason } },
  ];
}
