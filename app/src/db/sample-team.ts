/**
 * Sample mode's team (docs/team.md): three assistants with their triggers,
 * memory and a few runs, so the Team pages have something real to show.
 * Muse watches gift prices, Dot turns Linear issues into to-dos, and Wren
 * sums up the week on Fridays.
 */
import type { TeamAssistant, TeamRun, TeamTrigger } from "../../../lib/team-types";
import { hashText, skillBasis, type TeamQuestion, type TeamSkillMeta } from "../../../lib/team-skill";

export const SAMPLE_TEAM_IDS = {
  muse: "5a3e0000-0000-4000-8000-0000000e0001",
  dot: "5a3e0000-0000-4000-8000-0000000e0002",
  wren: "5a3e0000-0000-4000-8000-0000000e0003",
} as const;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const DAY = 24 * 60;

/** When the sample was opened: the day is laid out back from here, so it stays put while you look. */
const T0 = Date.now();
const MIN = 60_000;

/** Minutes before the sample was opened, squeezed into today when it's early, so today's runs read as today. */
function today(min: number): number {
  const midnight = new Date(T0);
  midnight.setHours(0, 0, 0, 0);
  const since = (T0 - midnight.getTime()) / MIN;
  return T0 - (since < 420 ? (min * Math.max(since - 3, 1)) / 420 : min) * MIN;
}

/** A day before the sample was opened, at a clock time. */
function daysBack(days: number, hh: number, mm: number): number {
  const d = new Date(T0);
  d.setDate(d.getDate() - days);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

/** The last Friday at 17:00 before the sample was opened (today, if that's passed). */
function lastFriday(weeks = 0): number {
  const d = new Date(T0);
  d.setHours(17, 0, 0, 0);
  while (d.getDay() !== 5 || d.getTime() > T0) d.setDate(d.getDate() - 1);
  return d.getTime() - weeks * 7 * DAY * MIN;
}

function trigger(n: number, assistant_id: string, t: Pick<TeamTrigger, "kind" | "days" | "time" | "event">, fired: number | null): TeamTrigger {
  return { id: `5a3e0000-0000-4000-8000-0000000e01${String(n).padStart(2, "0")}`, assistant_id, ...t, paused: false, last_slot: null, last_fired_at: fired === null ? null : ago(fired), created_at: ago(30 * DAY) };
}

/**
 * Who may look things up online (docs/team.md, "Looking things up online"):
 * Muse checks prices on the web; Dot and Wren don't. `web` is the contract's
 * field, which lib/team-types.ts gains in a sibling session.
 */
const SAMPLE_WEB: Record<string, boolean> = { [SAMPLE_TEAM_IDS.muse]: true, [SAMPLE_TEAM_IDS.dot]: false, [SAMPLE_TEAM_IDS.wren]: false };

/** Whose job needs the web, as the server said when it drafted them: Muse's page says so if her switch goes off. */
export const SAMPLE_WEB_HINTS: ReadonlySet<string> = new Set([SAMPLE_TEAM_IDS.muse]);

export function sampleTeam(): TeamAssistant[] {
  return sampleTeamBase().map((a) => ({ ...a, web: SAMPLE_WEB[a.id] === true }) as TeamAssistant);
}

function sampleTeamBase(): TeamAssistant[] {
  const { muse, dot, wren } = SAMPLE_TEAM_IDS;
  return [
    {
      id: muse,
      name: "Muse",
      job: "Finds good prices for gift ideas",
      instructions: "When a gift idea is saved, look for the best price from a shop I've bought from before. Note the price and the link on the gift idea. Mention it if the price drops.",
      personality: { tone: "warm", traits: ["thorough", "frugal"], pronoun: "she", greeting: "Hi! I'll keep an eye on prices for you." },
      avatar: { v: 1, seed: "muse", species: "cat", fur: "snow", accent: "pink", eyes: "sparkle", mouth: "small-smile", outfit: "hoodie", outfitColor: "berry", accessories: ["glasses"] },
      allow: ["add_to_list"],
      paused: false,
      routine_id: null,
      memory: { summary: "Jordan prefers independent shops and doesn't mind waiting a week for a better price.", facts: ["Buys books from Waterstones", "Gift budget is usually under £50"] },
      memory_updated_at: ago(2 * DAY),
      last_run_at: new Date(today(41)).toISOString(),
      triggers: [trigger(1, muse, { kind: "event", days: [], time: null, event: { source: "saved", savedAction: "gift-idea" } }, (T0 - today(42)) / MIN)],
      created_at: ago(30 * DAY),
      updated_at: ago(2 * DAY),
    },
    {
      id: dot,
      name: "Dot",
      job: "Turns Linear issues assigned to you into to-dos",
      instructions: "When a Linear issue is assigned to me, add a to-do with its title and link. Put it in the Work context and leave the due date empty unless the issue has one.",
      personality: { tone: "crisp", traits: ["tidy", "quick"], pronoun: "they", greeting: "Ready when you are." },
      avatar: { v: 1, seed: "dot", species: "monster", fur: "mint", accent: "lilac", eyes: "round", mouth: "small-smile", outfit: "tee", outfitColor: "cobalt", accessories: ["headphones"] },
      allow: ["add_todo"],
      paused: false,
      routine_id: null,
      memory: { summary: "", facts: ["Work to-dos go in the Work context"] },
      memory_updated_at: ago(5 * DAY),
      last_run_at: new Date(today(75)).toISOString(),
      triggers: [trigger(2, dot, { kind: "event", days: [], time: null, event: { source: "collected", connector: "linear", kind: "issue" } }, (T0 - today(76)) / MIN)],
      created_at: ago(21 * DAY),
      updated_at: ago(5 * DAY),
    },
    {
      id: wren,
      name: "Wren",
      job: "Sums up your week every Friday",
      instructions: "Every Friday at 5, write a short summary of my week: what I finished, what slipped, and who I met. Keep it under ten lines.",
      personality: { tone: "calm", traits: ["patient", "precise"], pronoun: "he", greeting: "Hello. I'll have your week ready on Friday." },
      avatar: { v: 1, seed: "wren", species: "fox", fur: "ginger", accent: "peach", eyes: "sleepy", mouth: "smirk", outfit: "blazer", outfitColor: "teal", accessories: ["scarf"] },
      allow: [],
      paused: false,
      routine_id: null,
      memory: { summary: "Jordan reads the summary on Saturday morning, so short is better.", facts: [] },
      memory_updated_at: ago(6 * DAY),
      last_run_at: new Date(lastFriday() + 2 * MIN).toISOString(),
      triggers: [trigger(3, wren, { kind: "schedule", days: [5], time: "17:00", event: null }, (T0 - lastFriday()) / MIN)],
      created_at: ago(60 * DAY),
      updated_at: ago(6 * DAY),
    },
  ];
}

/** A sample run's conversation id: the run's own id with a different prefix, so it's stable across reloads. */
export const sampleRunThreadId = (runId: string) => runId.replace(/^5a3e0000/, "5a3e7700");

const runId = (n: number) => `5a3e0000-0000-4000-8000-0000000e${n < 100 ? "02" : "05"}${String(n % 100).padStart(2, "0")}`;
const triggerId = (k: number) => `5a3e0000-0000-4000-8000-0000000e01${String(k).padStart(2, "0")}`;

/** Muse's run in progress: she started just before you opened the page, and finishes about a minute in. */
const MUSE_LIVE = { started: T0 - 25_000, steps: ["Reading the gift idea", "Searching the web for Aesop hand balm", "Reading johnlewis.com", "Reading boots.com", "Comparing the three shops"], stepMs: 15_000, doneAt: T0 + 70_000 };

function museLive(id: string): TeamRun {
  const now = Date.now();
  const base: TeamRun = { id: runId(10), assistant_id: id, trigger_id: triggerId(1), event_id: "41", status: "running", thread_id: null, summary: null, error: null, started_at: new Date(MUSE_LIVE.started).toISOString(), finished_at: null, label: "New gift idea: “Aesop hand balm”" };
  if (now >= MUSE_LIVE.doneAt) return { ...base, status: "done", thread_id: sampleRunThreadId(base.id), finished_at: new Date(MUSE_LIVE.doneAt).toISOString(), summary: "The Aesop hand balm is £27 at John Lewis, £4 less than Boots. The link is on the gift idea.", waiting: 0 };
  const i = Math.min(MUSE_LIVE.steps.length - 1, Math.floor((now - MUSE_LIVE.started) / MUSE_LIVE.stepMs));
  return { ...base, step: MUSE_LIVE.steps[i] };
}

/** Wren's Friday schedule, and its label as the server writes it (the app words it in the device's clock). */
const FRIDAY = { trigger: triggerId(3), label: "Every Friday at 17:00" };

interface Past {
  n: number;
  at: number;
  /** Minutes it took. */
  mins?: number;
  label: string;
  trigger?: string | null;
  summary?: string;
  error?: string;
  /** Changes it left for your Go (the server's `waiting`). */
  waiting?: number;
}

/**
 * The sample team's day: one run list that every Team screen reads (the
 * Team page, an assistant's page, Home's card and Ask). Muse is checking a
 * price as you open the app, and checked the Lego Ferrari earlier. Dot turned
 * the morning's three Linear issues into two to-dos and left one change for
 * your Go. Wren wrote Friday's summary and is quiet until next Friday. Each
 * finished run keeps a conversation (sample-team-detail.ts writes them).
 */
export function sampleRuns(assistantId: string): TeamRun[] {
  const { muse, dot, wren } = SAMPLE_TEAM_IDS;
  const ev = assistantId === muse ? triggerId(1) : assistantId === dot ? triggerId(2) : null;
  const run = (p: Past): TeamRun => ({
    id: runId(p.n),
    assistant_id: assistantId,
    trigger_id: p.trigger === undefined ? ev : p.trigger,
    event_id: null,
    status: p.error ? "failed" : "done",
    thread_id: p.error ? null : sampleRunThreadId(runId(p.n)),
    summary: p.summary ?? null,
    error: p.error ?? null,
    started_at: new Date(p.at).toISOString(),
    finished_at: new Date(p.at + (p.mins ?? 1) * MIN).toISOString(),
    label: p.label,
    waiting: p.error ? 0 : (p.waiting ?? 0),
  });
  const back = (min: number) => T0 - min * MIN;
  if (assistantId === muse)
    return [
      museLive(muse),
      ...[
        { n: 1, at: today(42), label: "New gift idea: “Lego Technic Ferrari Daytona”", summary: "Found the Lego Ferrari for £34 at Smyths, £8 under the price when you saved it." },
        { n: 2, at: daysBack(1, 19, 40), label: "New gift idea: “Moleskine diary”", summary: "The Moleskine diary is £18 at Waterstones. Nothing you've bought from is cheaper." },
        { n: 111, at: back(DAY + 140), label: "New gift idea: “Kindle Paperwhite”", error: "Amazon didn't answer in time" },
        { n: 3, at: daysBack(3, 12, 15), mins: 2, label: "2 new gift ideas", summary: "Added prices to two gift ideas." },
        { n: 112, at: back(9 * DAY), label: "New gift idea: “Le Creuset mug”", summary: "The Le Creuset mug is £16 at John Lewis, the same as when you saved it. I'll keep watching." },
        { n: 113, at: back(16 * DAY), label: "Run now", trigger: null, summary: "Checked your 6 gift ideas. None of them has dropped in price." },
      ].map(run),
    ];
  if (assistantId === dot)
    return [
      { n: 4, at: today(76), label: "3 new issues", summary: "Added 2 to-dos: Fix the sync banner on iPad, and Review the export spec. One change waits for you to tap Go.", waiting: 1 },
      { n: 5, at: today(330), label: "New issue: “Calendar invites show the wrong time zone”", summary: "Added a to-do: Calendar invites show the wrong time zone." },
      { n: 6, at: daysBack(1, 16, 5), label: "New issue: “Export fails on large notes”", summary: "Added a to-do: Export fails on large notes." },
      { n: 121, at: daysBack(2, 10, 20), label: "New issue: “Search misses archived notes”", summary: "Added a to-do: Search misses archived notes." },
      { n: 122, at: back(3 * DAY), label: "New issue: “Offline banner flickers”", summary: "Added a to-do: Offline banner flickers, due Friday." },
      { n: 123, at: back(8 * DAY), label: "2 new issues", summary: "2 new issues: 2 to-dos added." },
    ].map(run);
  if (assistantId === wren)
    return [
      { n: 7, at: lastFriday(), mins: 2, ...FRIDAY, summary: "You finished 11 to-dos, met Elena twice, and booked the Lisbon trip. Two things slipped: the Q1 plan draft and Priya's gift." },
      { n: 8, at: lastFriday(1), mins: 2, ...FRIDAY, summary: "You finished 8 to-dos and met Priya and Marcus. Nothing slipped." },
      { n: 131, at: lastFriday(2), mins: 2, ...FRIDAY, summary: "A quieter week: 6 to-dos done, the dentist moved to Tuesday, and you met Priya for lunch." },
      { n: 132, at: lastFriday(3), mins: 2, ...FRIDAY, summary: "You shipped the sync fix, 2 to-dos slipped to next week, and you met Elena and Sam." },
    ].map(run);
  return [];
}

// ---------- their own skills (docs/team.md, "Skills") ----------

const MUSE_SKILL = `---
name: muse-gift-prices
description: "Muse's own skill: how Muse does its job (Finds good prices for gift ideas). Muse loads it on every chat and run."
---

# How Muse works

1. When a gift idea is saved, search for it at Waterstones, Smyths and John Lewis first, then anywhere else.
2. Keep to the budget: under £50 a gift unless the owner says otherwise.
3. Put the best price and its link on the gift idea.
4. Tell the owner only when the price drops by £5 or more. Smaller changes go on the gift idea quietly.
5. Never buy anything. A purchase is always the owner's own tap.
`;

const DOT_SKILL = `---
name: dot-linear-to-dos
description: "Dot's own skill: how Dot does its job (Turns Linear issues assigned to you into to-dos). Dot loads it on every chat and run."
---

# How Dot works

1. For each Linear issue assigned to the owner, add one to-do with the issue's title and link.
2. Put it in the Work context.
3. Copy the due date only when the issue has one. Never guess one.
4. Skip issues that already have a to-do, and say how many were skipped.
`;

const WREN_SKILL = `---
name: wren-weekly-summary
description: "Wren's own skill: how Wren does its job (Sums up your week every Friday). Wren loads it on every chat and run."
---

# How Wren works

1. Every Friday at 5, read the week's days, finished to-dos, meetings and notes.
2. Write three short parts: what got done, what slipped, and who the owner met.
3. Keep it under ten lines, in plain sentences.
4. Leave out anything from the personal account unless the owner asks.
`;

const SAMPLE_SKILL_ANSWERS: Record<string, Array<{ question: string; answer: string }>> = {
  muse: [
    { question: "Which shops do you trust?", answer: "Waterstones, Smyths and John Lewis" },
    { question: "What's your budget per gift?", answer: "Under £50" },
    { question: "When should Muse tell you about a price?", answer: "Only drops of £5 or more" },
  ],
  dot: [
    { question: "Where should the to-dos go?", answer: "Work" },
    { question: "Should Dot copy due dates?", answer: "Only when the issue has one" },
  ],
  wren: [
    { question: "What should the summary cover?", answer: "Done, slipped and who I met" },
    { question: "How long should it be?", answer: "Under ten lines" },
  ],
};

const SAMPLE_SUMMARIES: Record<string, string> = {
  muse: "Checks Waterstones, Smyths and John Lewis first, keeps each gift under £50, and tells you only when a price drops by £5 or more.",
  dot: "Adds one to-do per Linear issue in your Work context, copies a due date only when the issue has one, and skips issues it has already added.",
  wren: "Writes three short parts every Friday: what got done, what slipped and who you met, in under ten lines.",
};

/** Muse, Dot and Wren's own skills, as sample mode's skill list keeps them. */
export function sampleTeamSkills(): Array<{ id: string; assistant_id: string; text: string; team: TeamSkillMeta; at: string; uses: number }> {
  const team = sampleTeam();
  const texts: Record<string, string> = { muse: MUSE_SKILL, dot: DOT_SKILL, wren: WREN_SKILL };
  return (["muse", "dot", "wren"] as const).map((key, i) => {
    const a = team.find((x) => x.id === SAMPLE_TEAM_IDS[key])!;
    const body = texts[key].split("\n---\n")[1].trim();
    return {
      id: `5a3e0000-0000-4000-8000-0000000e03${String(i + 1).padStart(2, "0")}`,
      assistant_id: a.id,
      text: texts[key],
      team: { basis: skillBasis(a), made: hashText(body), summary: SAMPLE_SUMMARIES[key], answers: SAMPLE_SKILL_ANSWERS[key] },
      at: a.created_at,
      uses: key === "wren" ? 0 : 4,
    };
  });
}

const q = (id: string, question: string, choices: string[]): TeamQuestion => ({ id, question, choices, allowOther: true });

/** Sample mode's setup questions, picked from the job's words the way the model would write them. */
export function sampleQuestions(text: string): TeamQuestion[] {
  const t = text.toLowerCase();
  if (/gift|price|deal|shop|buy/.test(t))
    return [
      q("q1", "Which shops do you trust?", ["Any shop", "Shops I've bought from", "Independent shops"]),
      q("q2", "What's your budget per gift?", ["Under £25", "Under £50", "Under £100", "No limit"]),
      q("q3", "When should it tell you about a price?", ["Any drop", "Only big drops", "Only below my budget"]),
    ];
  if (/linear|issue|ticket|to-?do/.test(t))
    return [
      q("q1", "Which issues count?", ["All assigned to me", "Only high priority", "Only this cycle"]),
      q("q2", "Where should the to-dos go?", ["Work", "Inbox", "A list per project"]),
      q("q3", "Should it copy due dates?", ["Always", "Only when the issue has one", "Never"]),
    ];
  if (/week|sum up|summary|recap|digest/.test(t))
    return [
      q("q1", "What should the summary cover?", ["What got done", "What slipped", "Who I met", "All of these"]),
      q("q2", "How long should it be?", ["A few lines", "Under ten lines", "As long as it needs"]),
      q("q3", "Where should it go?", ["A card on Home", "A note", "Both"]),
    ];
  return [
    q("q1", "How should it tell you what it did?", ["A card on Home", "Only in its chat", "Only when something needs me"]),
    q("q2", "How much should it do alone?", ["Ask me first", "Small changes alone", "Everything it's allowed"]),
  ];
}
