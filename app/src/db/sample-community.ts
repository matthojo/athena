/**
 * Sample mode's Community catalogue: made-up items across the six kinds and the three reach tiers, each
 * with real files, so the `#/community` list and the `#/add` preview work with no server. The hashes are worked out
 * from the files (bundleHash), as the catalogue's build does, and each item's reach is the one its files give
 * (sample-community.test.ts checks both). Authors are made-up GitHub-style names.
 *
 *   sampleCatalogue()   the index
 *   sampleBundle(id)    one item and its files, as netlify/lib/community-catalogue.ts loadBundle gives them
 *   sampleUpdates()     what sample mode's own items would hear from the daily check
 *
 * Templates are a gentle, journaling corner: a weekly look back, a gratitude page and a year-end reflection. Sample
 * mode starts with two added already (SAMPLE_ADDED_TEMPLATE_ROWS, kept by db/documents.ts): Gratitude page at an
 * older version, and Morning pages, taken down since.
 *
 * Themes are three with their own look: Paper lantern (light and dark), Night garden (dark only) and Risograph
 * (light only). Sample mode starts with Paper lantern added at version 1.0 (db/sample-themes.ts), so its update shows.
 */
import { bundleHash, type CatalogueBundle, type CatalogueFile, type CatalogueIndex, type CatalogueItem } from "../../../lib/catalogue-types";
import type { Reach } from "../../../lib/reach";
import type { ShareKind } from "../../../lib/share-kinds";
import type { UpdateCheck } from "../../../lib/community-api";
import { SAMPLE_FLOW_IDS } from "./sample-flows";
import { SAMPLE_TEAM_IDS } from "./sample-team";
import { SAMPLE_SET_ID, sampleSetOf } from "./sample-checkins";
import { PAPER_LANTERN_LISTING } from "./sample-themes";
import type { OwnTheme } from "../../../lib/theme";

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
  /** Made-up counts; the newest two have none, as an index from before the site counted would. */
  downloads?: number;
  files: CatalogueFile[];
}

const reach = (tier: Reach["tier"], over: Partial<Omit<Reach, "tier">> = {}): Reach => ({ tier, model: tier > 1, web: tier === 3, lookups: [], needs: [], ...over });
const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
const skillMd = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

const assistant = (o: Record<string, unknown>) => json({ format: 1, ...o });
const flow = (o: Record<string, unknown>) => json({ format: 1, asks: [], needs: [], money: false, web: false, ...o });
const checkins = (o: Record<string, unknown>) => json({ format: 1, ...o });
const template = (o: Record<string, unknown>) => json({ format: 1, ...o });
const theme = (o: Record<string, unknown>) => json({ format: 1, ...o });

/** The sample templates' bodies, so the listing and an older copy added here can share words. */
const GRATITUDE_BODY = `# Gratitude, {{date}}

Three things I'm grateful for:
1. 
2. 
3. 

## A small moment I want to remember


## Someone who made today easier
`;
/** Gratitude page as version 1.0 had it, before "Someone who made today easier". */
const GRATITUDE_BODY_1_0 = GRATITUDE_BODY.replace(/\n## Someone who made today easier\n$/, "");

const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.UTC(2026, 10, 24, 9) - days * DAY).toISOString();

/** Every item, newest first by `days` ago. Ids are made up, in the catalogue's alphabet. */
const SEEDS: Seed[] = [
  {
    id: PAPER_LANTERN_LISTING,
    kind: "theme",
    slug: "paper-lantern",
    name: "Paper lantern",
    summary: "Warm rice paper and a lantern amber, for evenings in. Version 1.1 deepens the amber and adds its own chart colours.",
    author: "lamplight-co",
    version: "1.1",
    reach: reach(1),
    featured: true,
    days: 1,
    downloads: 1840,
    files: [
      {
        path: "theme.json",
        text: theme({
          name: "Paper lantern",
          summary: "Warm rice paper and a lantern amber, for evenings in.",
          version: "1.1",
          author: "lamplight-co",
          colours: {
            light: { page: "#f6efe2", surface: "#fdf8ef", sunken: "#efe5d3", border: "#e2d4bb", text: "#2e2418", textMuted: "#6b5a44", accent: "#a8600f", onAccent: "#fffaf2" },
            dark: { page: "#1a1611", surface: "#231e17", sunken: "#2c261d", border: "#3a3226", text: "#f2e8d8", textMuted: "#c4b49b", accent: "#eaa045", onAccent: "#1f170c" },
          },
          shape: { radius: 1.3, density: 1.05 },
          text: { scale: 1 },
          chart: {
            light: ["#a8600f", "#4f7a5a", "#8a4f7d", "#2f6f8f", "#c2412d"],
            dark: ["#eaa045", "#8cc59a", "#d79ccb", "#7fbcd9", "#f07a61"],
          },
        }),
      },
    ],
  },
  {
    id: "n6p1q5r9s3t8v2w7",
    kind: "theme",
    slug: "night-garden",
    name: "Night garden",
    summary: "Dark only: deep leaf green, moonlit text and a glow-worm accent. Light mode keeps Athena's own.",
    author: "moss-and-moth",
    version: "2.0",
    reach: reach(1),
    featured: false,
    days: 2,
    downloads: 612,
    files: [
      {
        path: "theme.json",
        text: theme({
          name: "Night garden",
          summary: "Deep leaf green, moonlit text and a glow-worm accent.",
          version: "2.0",
          author: "moss-and-moth",
          colours: {
            dark: { page: "#0f1712", surface: "#16211a", sunken: "#1c2a21", border: "#28392d", text: "#e6efe4", textMuted: "#a9bfaa", accent: "#b6e36b", onAccent: "#122008", focus: "#e3f59a" },
          },
          shape: { radius: 1.6, density: 1.1 },
          text: { scale: 1.05 },
          chart: { dark: ["#b6e36b", "#6fc3c9", "#e39bd3", "#f2c35b", "#8f9cf2"] },
        }),
      },
    ],
  },
  {
    id: "r2s6t1v5w9x3y8z4",
    kind: "theme",
    slug: "risograph",
    name: "Risograph",
    summary: "Light only: off-white stock, fluorescent pink and teal ink, square corners and a tight layout.",
    author: "inkroom-press",
    version: "1.0",
    reach: reach(1),
    featured: false,
    days: 5,
    downloads: 233,
    files: [
      {
        path: "theme.json",
        text: theme({
          name: "Risograph",
          summary: "Off-white stock, fluorescent pink and teal ink, square corners and a tight layout.",
          version: "1.0",
          author: "inkroom-press",
          colours: {
            light: { page: "#f4f1ea", surface: "#fbf9f4", sunken: "#ebe6db", border: "#d9d1c1", text: "#1d2a3a", textMuted: "#4d5a6a", accent: "#e8417f", onAccent: "#ffffff", focus: "#0f8b8d" },
          },
          shape: { radius: 0.25, density: 0.9 },
          text: { scale: 1 },
          chart: { light: ["#e8417f", "#0f8b8d", "#f2a900", "#3d5a98", "#7a4ea3"] },
        }),
      },
    ],
  },
  {
    id: "t4v8w2x6y1z5a9b3",
    kind: "template",
    slug: "gentle-weekly-review",
    name: "Gentle weekly review",
    summary: "A soft look back at the week, ending with one kind thing for next week.",
    author: "slow-sundays",
    version: "1.2",
    reach: reach(1),
    featured: true,
    days: 0,
    files: [
      {
        path: "template.json",
        text: template({
          name: "Gentle weekly review",
          summary: "A soft look back at the week, ending with one kind thing for next week.",
          version: "1.2",
          author: "slow-sundays",
          body: `# A gentle look back at {{week}}

## What I'm glad happened


## What felt heavy


## Someone I'd like to thank


## What I'm leaving behind


## One kind thing for next week
`,
        }),
      },
    ],
  },
  {
    id: "g7h2j6k1m5n9p4q8",
    kind: "template",
    slug: "gratitude-page",
    name: "Gratitude page",
    summary: "Three things you're grateful for, one small moment to keep, and someone who made the day easier.",
    author: "kind-margins",
    version: "1.1",
    reach: reach(1),
    featured: false,
    days: 3,
    downloads: 540,
    files: [{ path: "template.json", text: template({ name: "Gratitude page", summary: "Three things you're grateful for, one small moment to keep, and someone who made the day easier.", version: "1.1", author: "kind-margins", body: GRATITUDE_BODY }) }],
  },
  {
    id: "y3z7a2b6c1d5f9g4",
    kind: "template",
    slug: "year-end-reflection",
    name: "Year-end reflection",
    summary: "Unhurried questions for the last days of December, about the year you had and the one you'd like.",
    author: "lantern-notes",
    version: "1.0",
    reach: reach(1),
    featured: false,
    days: 9,
    downloads: 1300,
    files: [
      {
        path: "template.json",
        text: template({
          name: "Year-end reflection",
          summary: "Unhurried questions for the last days of December, about the year you had and the one you'd like.",
          version: "1.0",
          author: "lantern-notes",
          body: `# Looking back on the year

## The moments I keep coming back to


## What surprised me


## What I learned slowly


## Who walked alongside me


## What I'm ready to set down


## What I'd like more of next year


## A word for the year ahead
`,
        }),
      },
    ],
  },
  {
    id: "j6k1m5n9p3q8r2s7",
    kind: "checkin",
    slug: "small-joys",
    name: "Small joys",
    summary: "Four questions for the end of the day, about the good bits that are easy to miss.",
    author: "quiet-desk",
    version: "1.0",
    reach: reach(1),
    featured: true,
    days: 1,
    files: [
      {
        path: "checkin.json",
        text: checkins({
          name: "Small joys",
          summary: "Four questions for the end of the day, about the good bits that are easy to miss.",
          version: "1.0",
          author: "quiet-desk",
          questions: [
            { prompt: "What made you smile today?", kinds: ["evening"], type: "text", placeholder: "Something small counts.", deeper: false },
            { prompt: "Who did you feel close to today?", kinds: ["evening"], type: "choices", options: ["Family", "A friend", "A neighbour", "A colleague", "Someone new"], more: ["A pet", "Nobody today", "Myself"] },
            { prompt: "How kind were you to yourself?", kinds: ["evening"], type: "scale", lead: "Today I was", levels: ["hard on myself", "a bit harsh", "fair to myself", "kind to myself", "very kind to myself"], low: "Harsh", high: "Kind" },
            { prompt: "What went well today?", kinds: ["evening"], type: "text", placeholder: "A few words is enough." },
          ],
        }),
      },
    ],
  },
  {
    id: "b8c3d7f2g6h1j5k9",
    kind: "checkin",
    slug: "slow-mornings",
    name: "Slow mornings",
    summary: "Four questions for a slower start to the day.",
    author: "early-light",
    version: "2.1",
    reach: reach(1),
    featured: false,
    days: 5,
    downloads: 860,
    files: [
      {
        path: "checkin.json",
        text: checkins({
          name: "Slow mornings",
          summary: "Four questions for a slower start to the day.",
          version: "2.1",
          author: "early-light",
          questions: [
            { prompt: "How did you sleep?", kinds: ["morning"], type: "scale", lead: "Last night I slept", levels: ["badly", "on and off", "well enough", "well", "deeply"], low: "Badly", high: "Deeply" },
            { prompt: "What are you looking forward to?", kinds: ["morning"], type: "text", placeholder: "However small.", deeper: true },
            { prompt: "What's one thing you'll do slowly today?", kinds: ["morning"], type: "text", placeholder: "A cup of tea, a walk, a meal.", deeper: false },
            { prompt: "Where would you like your attention to go?", kinds: ["morning"], type: "areas", options: ["Rest", "Family", "Friends", "Nature", "Creativity", "Health"], more: ["Home", "Learning", "Music", "Food"] },
          ],
        }),
      },
    ],
  },
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
    name: "Sorter",
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
    downloads: 2340,
    files: [
      { path: "SKILL.md", text: skillMd("meeting-notes", "Use when asked to write up a meeting.", "Write three short sections: Decisions, Actions (each with an owner and a date) and Open questions. Keep each line under twenty words.") },
      { path: "references/example.md", text: "# Example\n\n## Decisions\n- Launch moves to March.\n\n## Actions\n- Sam: draft the plan by Friday.\n" },
    ],
  },
  {
    id: "t5v9w3x7y2z6a1b4",
    kind: "assistant",
    slug: "trip-scout",
    name: "Scout",
    summary: "Looks up opening times, prices and how to get there for the places on your next trip.",
    author: "wander-notes",
    version: "0.9",
    reach: reach(3),
    featured: false,
    days: 9,
    downloads: 1180,
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
    downloads: 86,
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
    downloads: 412,
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
    downloads: 1520,
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
    name: "Pip",
    summary: "Before standup, lists what you closed yesterday and what's next, ready to paste into Slack.",
    author: "sprint-goose",
    version: "1.3",
    reach: reach(2, { needs: ["linear", "slack"] }),
    featured: false,
    days: 20,
    downloads: 57,
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
    downloads: 3,
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
    downloads: 9800,
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
    downloads: 640,
    files: [{ path: "SKILL.md", text: skillMd("weekly-review", "Use for a weekly review.", "List what got done, what slipped and why in a few words, then ask for one thing to carry into next week.") }],
  },
  {
    id: "g6h1j5k9m4n8p3q7",
    kind: "assistant",
    slug: "running-coach",
    name: "Coach",
    summary: "Looks at your runs each week and suggests next week's, easing off when you've done a lot.",
    author: "long-way-round",
    version: "0.4",
    reach: reach(2, { needs: ["strava"] }),
    featured: false,
    days: 45,
    downloads: 230,
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
    downloads: 15,
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
const WITHDRAWN = [
  { id: "z2a6b1c5d9f4g8h3", reason: "It stopped working after Linear changed how issues are labelled." },
  // Sunday reset, which sample check-ins added before it was taken down (db/sample-checkins.ts SAMPLE_SET_ID).
  { id: "m4n8p2q6r1s5t9v3", reason: "Its author asked for it to come down while they rewrite it." },
  // Morning pages, a template sample mode added before it was taken down (SAMPLE_ADDED_TEMPLATE_ROWS).
  { id: "p5q9r3s7t2v6w1x4", reason: "Its author is folding it into a longer set of morning prompts." },
];

const GRATITUDE = "g7h2j6k1m5n9p4q8";

/** Sample mode's added templates' ids. */
export const SAMPLE_TEMPLATE_IDS = { gratitude: "5a3e0000-0000-4000-8000-000000000a01", morning: "5a3e0000-0000-4000-8000-000000000a02" } as const;

/**
 * Templates sample mode has already added, as db/documents.ts keeps them: Gratitude page at version 1.0 (the listing
 * is at 1.1 now), and Morning pages, taken down from Community since. The hashes stand for files that were added.
 */
export const SAMPLE_ADDED_TEMPLATE_ROWS = [
  {
    id: SAMPLE_TEMPLATE_IDS.gratitude,
    starter: null,
    name: "Gratitude page",
    body: GRATITUDE_BODY_1_0.replace(/\n+$/, ""),
    updated_at: at(20),
    shared: { author: "kind-margins", version: "1.0", summary: "Three things you're grateful for, and one small moment to keep.", catalogue_id: GRATITUDE, catalogue_hash: `sha256-${"4".repeat(64)}`, changed: false },
  },
  {
    id: SAMPLE_TEMPLATE_IDS.morning,
    starter: null,
    name: "Morning pages",
    body: "Three pages, by hand if you can, before you look at your phone. Nothing here is for anyone else.\n\n## Today I woke up feeling\n\n\n## What's already on my mind\n\n\n## What I'd like to notice today",
    updated_at: at(30),
    shared: { author: "paper-lantern", version: "1.0", summary: "Unedited pages first thing in the morning, before the day starts asking things of you.", catalogue_id: "p5q9r3s7t2v6w1x4", catalogue_hash: `sha256-${"5".repeat(64)}`, changed: false },
  },
];

/** A template here that came from a listing, as the catalogue_* columns say. */
export interface SampleTemplateListing {
  id: string;
  catalogue_id: string;
  hash: string;
  version: string | null;
  changed: boolean;
}

const seededListings: SampleTemplateListing[] = SAMPLE_ADDED_TEMPLATE_ROWS.map((r) => ({ id: r.id, catalogue_id: r.shared.catalogue_id, hash: r.shared.catalogue_hash, version: r.shared.version, changed: r.shared.changed }));


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
        ...(s.downloads !== undefined ? { downloads: s.downloads } : {}),
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

/** Sample items already added: Gift price watch (an older version), Dot and Sunday reset (both taken down since). */
export const SAMPLE_ADDED = ["q8r3s7t2v6w1x5y9", "z2a6b1c5d9f4g8h3", "m4n8p2q6r1s5t9v3"];
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
/** The listing an item here came from, if any: a shared copy names it as based_on. */
export const sampleListingOf = (kind: ShareKind, id: string): string | null => [...added].find(([, a]) => a.kind === kind && a.id === id)?.[0] ?? null;
/** Remember an Add or an Update from a listing. */
export const rememberSampleAdd = (catalogueId: string, item: SampleAdded): void => void added.set(catalogueId, item);
/** Every listing something here came from, for the list's "Added" marks: Dot's too, though it was taken down. */
export const sampleAddedIds = (): string[] => [...new Set([...SAMPLE_ADDED, ...added.keys()])];

/**
 * What sample mode's own flow, assistant, set of check-in questions and templates would hear from the daily check.
 * `templates`: the added templates as they are now (db/documents.ts sampleTemplateListings); the two it starts with
 * when not given.
 */
export async function sampleUpdates(templates: readonly SampleTemplateListing[] = seededListings, themes: readonly OwnTheme[] = []): Promise<UpdateCheck[]> {
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
    // Until it's removed in Settings this visit.
    ...(sampleSetOf(SAMPLE_SET_ID) ? [{ kind: "checkin" as const, id: SAMPLE_SET_ID, catalogue_id: WITHDRAWN[1].id, version: "1.1", hash: `sha256-${"3".repeat(64)}`, newer: null, withdrawn: { at: at(3), reason: WITHDRAWN[1].reason } }] : []),
    ...(await templateChecks(templates)),
    ...(await themeChecks(themes)),
  ];
}

/** Updates and withdrawals for the themes here that follow a sample listing, as compareInstalled works them out. */
async function themeChecks(themes: readonly OwnTheme[]): Promise<UpdateCheck[]> {
  const items = new Map((await build()).map((a) => [a.item.id, a.item]));
  return themes.flatMap((t) => {
    const o = t.origin;
    if (!o?.catalogue_id || !o.hash) return [];
    const listed = items.get(o.catalogue_id);
    const gone = WITHDRAWN.find((w) => w.id === o.catalogue_id);
    const newer = listed && listed.kind === "theme" && listed.hash !== o.hash ? { version: listed.version, hash: listed.hash, summary: listed.summary, reach: listed.reach } : null;
    if (!newer && !gone) return [];
    return [{ kind: "theme" as const, id: t.id, catalogue_id: o.catalogue_id, version: o.version, hash: o.hash, newer, tier_here: newer ? 1 : undefined, withdrawn: gone ? { at: at(3), reason: gone.reason } : null }];
  });
}

/** Updates and withdrawals for the templates here, against the sample index, as the server's compareInstalled works them out. */
async function templateChecks(templates: readonly SampleTemplateListing[]): Promise<UpdateCheck[]> {
  const items = new Map((await build()).map((a) => [a.item.id, a.item]));
  return templates.flatMap((t) => {
    const listed = items.get(t.catalogue_id);
    const gone = WITHDRAWN.find((w) => w.id === t.catalogue_id);
    const newer = listed && listed.kind === "template" && listed.hash !== t.hash ? { version: listed.version, hash: listed.hash, summary: listed.summary, reach: listed.reach } : null;
    if (!newer && !gone) return [];
    return [{ kind: "template" as const, id: t.id, catalogue_id: t.catalogue_id, version: t.version, hash: t.hash, newer, tier_here: newer ? 1 : undefined, withdrawn: gone ? { at: at(3), reason: gone.reason } : null }];
  });
}
