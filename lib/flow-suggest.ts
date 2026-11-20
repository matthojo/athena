/**
 * Flow suggestions (lib/flow-types.ts FlowSuggestion): habits in what the
 * owner already does that a flow could do for them, offered on Flows and Home
 * as "You add a reminder after delivery emails · Four of five in the last 30
 * days". Everything here is pure: lib/flow-suggest-store.ts reads the signals,
 * netlify/lib/flow-suggest-routes.ts serves them.
 *
 * Four detectors, each strict, because a wrong suggestion costs more trust
 * than a missed one:
 *
 * - follow: after a collected item of one kind (a delivery, a booking, an
 *   appointment, a deadline, a renewal) the owner adds a reminder or a to-do
 *   about it within hours, most times. The flow does it on the item's date.
 * - list: after a collected item of one kind the owner asks Ask (What Ask did,
 *   lib/ask-activity.ts) to put it on the same list, most times.
 * - repeat: the owner sets the same one-off reminder or to-do by hand, on the
 *   same weekday, week after week. The flow does it on a schedule.
 * - saved: the owner files the same kind of saved thing the same way (books to
 *   Watch & read, places to Places) soon after saving it, most times.
 *
 * Each gives a complete flow (lib/flow-suggest-check.ts checks it), a short
 * title and a why line with the counts. pickSuggestions() drops the dismissed
 * ones and the ones already a flow, and keeps the best three.
 */
import { createHash } from "node:crypto";
import { zonedParts } from "./dates";
import type { FlowStep, FlowSuggestion, FlowText, FlowTrigger, ValueRef } from "./flow-types";
import { alreadyAFlow, suggestionProblems, type ExistingFlow } from "./flow-suggest-check";
import { TRIGGER_KEYS } from "./flow-suggest-keys";
import type { TeamWeekday } from "./team-types";

export { TRIGGER_KEYS, suggestedTriggerKeys } from "./flow-suggest-keys";

/** At most this many at once. */
export const MAX_SUGGESTIONS = 3;
/** Each habit needs at least this many times. */
export const MIN_TIMES = 3;
/** And it has to be what the owner does most of the time, not now and then. */
export const MIN_SHARE = 0.6;
/** A follow-up counts when it was made this long after the item arrived. */
export const FOLLOW_HOURS = 12;
/** How far back repeats are looked for, and how recent the last one must be to still be a habit. */
export const REPEAT_DAYS = 56;
export const REPEAT_RECENT_DAYS = 21;
/** A saved thing filed within this long of saving it counts as filed straight away. */
export const SAVED_FILE_HOURS = 48;
export const SAVED_DAYS = 60;

// ---------- what the store reads ----------

/** A collected item that arrived: a delivery, a booking, a renewal… (team_events, purchases). */
export interface CollectedItem {
  /** The record it became (or the event's own id). One item per record. */
  id: string;
  /** Its kind as an event filter has it: "delivery", "booking", "appointment", "deadline", "renewal". */
  kind: string;
  title: string;
  /** Each time it arrived or moved on (ordered, dispatched…): a follow-up after any of them counts. ISO. */
  times: string[];
}

/** A reminder (`reminders`), the owner's or Ask's. */
export interface OwnerReminder {
  id: string;
  text: string;
  created_at: string;
  remind_at: string;
  repeat: string;
  done: boolean;
}

/** A to-do the owner made, by hand or through Ask (not one a collection filed). */
export interface OwnerTodo {
  id: string;
  title: string;
  created_at: string;
  due_on: string | null;
}

/** A row of What Ask did, as far as suggestions need it. */
export interface AskChange {
  at: string;
  state: string;
  change: { kind: string; action: string; title: string; detail: string };
}

/** A saved item and how it was filed (`saved_items`). */
export interface SavedFiling {
  id: string;
  thing: string | null;
  saved_at: string;
  filed_at: string | null;
  /** The saved action that filed it ("watch_read"), or null. */
  action: string | null;
}

export interface SuggestSignals {
  collected: CollectedItem[];
  /** How many days back collected items of each kind go (team_events keeps 7; purchases go further). */
  collectedDays: Record<string, number>;
  reminders: OwnerReminder[];
  todos: OwnerTodo[];
  activity: AskChange[];
  saved: SavedFiling[];
}

export interface SuggestContext {
  now: Date;
  /** The owner's time zone. */
  tz: string;
}

/** A detector's find: the suggestion and how sure it is, for ranking. */
export interface Found {
  suggestion: FlowSuggestion;
  score: number;
}

const ref = (key: string): ValueRef => ({ from: "trigger", key });

// ---------- words ----------

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
/** "four", "12": words up to nine, as house style has it. */
export const count = (n: number): string => (n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n));
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** "4 of 4" reads as "all four". */
const share = (n: number, of: number): string => (n === of ? `All ${count(of)}` : `${sentence(count(n))} of ${count(of)}`);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** "in the last week", "in the last 30 days". */
const lastDays = (days: number): string => (days <= 7 ? "in the last week" : `in the last ${days} days`);

/** Cut to `max` characters on a word, with no trailing punctuation. */
export function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1).replace(/\s+\S*$/, "");
  return (cut || s.slice(0, max)).replace(/[\s,.;:·-]+$/, "");
}

/** A short stable id part for owner text: the text itself never goes in an id. */
export function textKey(text: string): string {
  return createHash("sha256").update(normalise(text)).digest("hex").slice(0, 12);
}

/** Lower case, no numbers or punctuation, single spaces: "Put the bins out!" and "put the bins out" are one habit. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(
  "about after again also back been before being from have here into just more only over some such than that their them then there these they this those very what when where which while will with would your yours order email update updates today tomorrow".split(" "),
);
/** The words worth matching on: four letters or more, not filler. */
export function words(text: string): Set<string> {
  return new Set(normalise(text).split(" ").filter((w) => w.length >= 4 && !STOP.has(w)));
}
const shares = (a: Set<string>, b: Set<string>): boolean => [...a].some((w) => b.has(w));

const hoursBetween = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 3_600_000;
const daysBefore = (now: Date, days: number): number => now.getTime() - days * 86_400_000;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toClock = (minutes: number): string => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
/** The middle of some local times, on the nearest `step` minutes. */
const middleTime = (times: string[], step: number): string => toClock(Math.round(median(times.map(toMinutes)) / step) * step);
const spread = (times: string[]): number => {
  const m = times.map(toMinutes);
  return Math.max(...m) - Math.min(...m);
};

// ---------- follow: a reminder or a to-do after a collected item ----------

interface FollowKind {
  /** "delivery email". */
  noun: string;
  plural: string;
  /** "Deliveries", for a flow's name. */
  things: string;
  /** The flow's name when it adds a reminder, and when it adds a to-do. */
  reminderName: string | null;
  todoName: string;
  /** Words before the item's title in what the flow adds. */
  reminderText: string;
  todoText: string;
  /** Words that tie a reminder or to-do to this kind of item when the titles share none. */
  about: RegExp;
}

/**
 * The kinds with a date worth acting on. A reminder on the day only makes
 * sense for things that happen on the day; a deadline or renewal gets a to-do
 * due on its date instead, never a reminder that comes too late.
 */
export const FOLLOW_KINDS: Record<string, FollowKind> = {
  delivery: {
    noun: "delivery email",
    plural: "delivery emails",
    things: "Deliveries",
    reminderName: "Delivery day",
    todoName: "Delivery to-do",
    reminderText: "Delivery today: ",
    todoText: "Check the delivery: ",
    about: /\b(deliver\w*|parcel|package|courier|arriv\w*|dispatch\w*|shipp?\w*|collect\w*|tracking)\b/,
  },
  booking: {
    noun: "booking email",
    plural: "booking emails",
    things: "Bookings",
    reminderName: "Booking reminder",
    todoName: "Booking to-do",
    reminderText: "Booking today: ",
    todoText: "Get ready for ",
    about: /\b(book\w*|reservation|table|ticket\w*|check.?in|flight|hotel|train)\b/,
  },
  appointment: {
    noun: "appointment email",
    plural: "appointment emails",
    things: "Appointments",
    reminderName: "Appointment day",
    todoName: "Appointment to-do",
    reminderText: "Appointment today: ",
    todoText: "Get ready for ",
    about: /\b(appointment|appt|dentist|doctor|clinic|surgery|vet|haircut|hair)\b/,
  },
  deadline: {
    noun: "deadline email",
    plural: "deadline emails",
    things: "Deadlines",
    reminderName: null,
    todoName: "Deadline to-do",
    reminderText: "",
    todoText: "Deal with ",
    about: /\b(deadline|due|submit\w*|pay\w*|expir\w*|return\w*)\b/,
  },
  renewal: {
    noun: "renewal email",
    plural: "renewal emails",
    things: "Renewals",
    reminderName: null,
    todoName: "Renewal to-do",
    reminderText: "",
    todoText: "Decide on ",
    about: /\b(renew\w*|subscription|cancel\w*|contract|insurance|policy)\b/,
  },
};

interface Action {
  id: string;
  text: string;
  at: string;
  /** Reminders: when it fires, for the time the flow uses. */
  fires?: string;
}

/** Each item matched to at most one action made soon after it and about it, each action used once. Pure. */
export function followUps(items: CollectedItem[], actions: Action[], hours = FOLLOW_HOURS): Map<string, Action> {
  const used = new Set<string>();
  const out = new Map<string, Action>();
  const sorted = [...items].sort((a, b) => first(a).localeCompare(first(b)));
  for (const item of sorted) {
    const kind = FOLLOW_KINDS[item.kind];
    const itemWords = words(item.title);
    const hit = actions
      .filter((a) => !used.has(a.id))
      .filter((a) => item.times.some((t) => hoursBetween(t, a.at) > 0 && hoursBetween(t, a.at) <= hours))
      .filter((a) => shares(itemWords, words(a.text)) || (!!kind && kind.about.test(normalise(a.text))))
      .sort((a, b) => a.at.localeCompare(b.at))[0];
    if (hit) {
      used.add(hit.id);
      out.set(item.id, hit);
    }
  }
  return out;
}
const first = (item: CollectedItem): string => [...item.times].sort()[0] ?? "";

const inWindow = (item: CollectedItem, since: number): boolean => item.times.some((t) => Date.parse(t) >= since);

/** "You add a reminder after delivery emails": per kind, the follow-up the owner makes most times. */
export function detectFollow(signals: SuggestSignals, ctx: SuggestContext): Found[] {
  const out: Found[] = [];
  const reminders: Action[] = signals.reminders.filter((r) => r.repeat === "none").map((r) => ({ id: `r:${r.id}`, text: r.text, at: r.created_at, fires: r.remind_at }));
  const todos: Action[] = signals.todos.map((t) => ({ id: `t:${t.id}`, text: t.title, at: t.created_at }));
  for (const [kindName, kind] of Object.entries(FOLLOW_KINDS)) {
    const days = signals.collectedDays[kindName] ?? 7;
    const items = signals.collected.filter((i) => i.kind === kindName && inWindow(i, daysBefore(ctx.now, days)));
    if (items.length < MIN_TIMES) continue;
    const byReminder = kind.reminderName ? followUps(items, reminders) : new Map<string, Action>();
    const byTodo = followUps(items, todos);
    const useReminder = byReminder.size >= byTodo.size && byReminder.size > 0;
    const matched = useReminder ? byReminder : byTodo;
    if (matched.size < MIN_TIMES || matched.size / items.length < MIN_SHARE) continue;
    const dateKey = TRIGGER_KEYS.date[kindName];
    const trigger: FlowTrigger = { kind: "event", event: { source: "collected", kind: kindName } };
    let step: FlowStep;
    if (useReminder) {
      const fired = [...matched.values()].map((a) => zonedParts(new Date(a.fires!), ctx.tz).time);
      const time = spread(fired) <= 120 ? middleTime(fired, 15) : "08:00";
      step = {
        id: "remind",
        title: null,
        kind: "tool",
        tool: "add_reminder",
        input: { text: [kind.reminderText, ref(TRIGGER_KEYS.title)], date: [ref(dateKey)], time: [time] },
        go: "auto",
        gives: [],
      };
    } else {
      step = {
        id: "todo",
        title: null,
        kind: "tool",
        tool: "add_todo",
        input: { title: [kind.todoText, ref(TRIGGER_KEYS.title)], kind: ["todo"], due_on: [ref(dateKey)] },
        go: "auto",
        gives: [],
      };
    }
    const what = useReminder ? "a reminder" : "a to-do";
    out.push({
      score: matched.size * (matched.size / items.length) + 0.5,
      suggestion: {
        id: `follow-${kindName}-${useReminder ? "reminder" : "todo"}`,
        title: `You add ${what} after ${kind.plural}`,
        why: `${share(matched.size, items.length)} ${kind.plural} ${lastDays(days)}.`,
        flow: { name: useReminder ? kind.reminderName! : kind.todoName, trigger, steps: [step], origin: "suggestion" },
      },
    });
  }
  return out;
}

// ---------- list: Ask puts a collected item on the same list ----------

/** What Ask added to a plain list (not a person's), from its receipt: "New list · X" or "Added X". */
export function listAddition(c: AskChange): { list: string; item: string } | null {
  if (c.state !== "done" || c.change.kind !== "note" || (c.change.action !== "created" && c.change.action !== "updated")) return null;
  const list = c.change.title.trim();
  // A person's list ("Rowan · Gift ideas") needs their id, which a flow can't know ahead.
  if (!list || list.includes(" · ") || list.includes(" — ")) return null;
  const m = /^(?:New list · |Added )(.+)$/.exec(c.change.detail.trim());
  return m ? { list, item: m[1] } : null;
}

/** "You add booking emails to your Trips list". */
export function detectList(signals: SuggestSignals, ctx: SuggestContext): Found[] {
  const additions = signals.activity.map((a) => ({ a, add: listAddition(a) })).filter((x): x is { a: AskChange; add: { list: string; item: string } } => !!x.add);
  if (additions.length < MIN_TIMES) return [];
  const out: Found[] = [];
  for (const kindName of Object.keys(FOLLOW_KINDS)) {
    const days = signals.collectedDays[kindName] ?? 7;
    const items = signals.collected.filter((i) => i.kind === kindName && inWindow(i, daysBefore(ctx.now, days)));
    if (items.length < MIN_TIMES) continue;
    // One list at a time, so a match is only about that list; the item must share a word with the title.
    const lists = [...new Set(additions.map((x) => normalise(x.add.list)))];
    for (const list of lists) {
      const actions: Action[] = additions.filter((x) => normalise(x.add.list) === list).map((x, i) => ({ id: `l:${i}:${x.a.at}`, text: x.add.item, at: x.a.at }));
      const strict = followUps(
        items.map((i) => ({ ...i, kind: "" })), // no kind words: a list line must share a word with the item
        actions,
      );
      if (strict.size < MIN_TIMES || strict.size / items.length < MIN_SHARE) continue;
      const title = additions.find((x) => normalise(x.add.list) === list)!.add.list;
      out.push({
        score: strict.size * (strict.size / items.length),
        suggestion: {
          id: `list-${kindName}-${textKey(title)}`,
          title: clip(`You add ${FOLLOW_KINDS[kindName].plural} to ${title}`, 80),
          why: `${share(strict.size, items.length)} ${FOLLOW_KINDS[kindName].plural} ${lastDays(days)}, through Ask.`,
          flow: {
            name: clip(`${FOLLOW_KINDS[kindName].things} to ${title}`, 60),
            trigger: { kind: "event", event: { source: "collected", kind: kindName } },
            steps: [{ id: "list", title: null, kind: "tool", tool: "add_to_list", input: { item: [ref(TRIGGER_KEYS.title)], list_title: [title] }, go: "auto", gives: [] }],
            origin: "suggestion",
          },
        },
      });
    }
  }
  return out;
}

// ---------- repeat: the same reminder or to-do, week after week ----------

interface Occurrence {
  text: string;
  /** Local date and time it's for. */
  date: string;
  time: string | null;
  weekday: number;
  at: string;
}

const isoWeek = (date: string): string => {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
};

/** Habits in one-off things: same words, always the same weekday, in three or more weeks, the last one recent. Pure. */
export function weeklyHabits(list: Occurrence[], now: Date): Array<{ key: string; text: string; weekday: number; times: string[]; n: number }> {
  const groups = new Map<string, Occurrence[]>();
  for (const o of list) {
    const key = normalise(o.text);
    if (key.length < 3) continue;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const out: Array<{ key: string; text: string; weekday: number; times: string[]; n: number }> = [];
  for (const [key, group] of groups) {
    if (group.length < MIN_TIMES) continue;
    const weekdays = new Set(group.map((o) => o.weekday));
    if (weekdays.size !== 1) continue;
    const weeks = new Set(group.map((o) => isoWeek(o.date)));
    if (weeks.size < MIN_TIMES) continue;
    const latest = group.map((o) => o.at).sort().at(-1)!;
    if (Date.parse(latest) < daysBefore(now, REPEAT_RECENT_DAYS)) continue;
    const newest = [...group].sort((a, b) => b.at.localeCompare(a.at))[0];
    out.push({ key, text: newest.text.trim(), weekday: group[0].weekday, times: group.map((o) => o.time).filter((t): t is string => !!t), n: group.length });
  }
  return out;
}

const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

/** "You set the same reminder every Tuesday" and "You add the same to-do every Monday". */
export function detectRepeat(signals: SuggestSignals, ctx: SuggestContext): Found[] {
  const since = daysBefore(ctx.now, REPEAT_DAYS);
  const out: Found[] = [];
  // Already automated: a repeating reminder with the same words is still going.
  const repeating = new Set(signals.reminders.filter((r) => r.repeat !== "none" && !r.done).map((r) => normalise(r.text)));

  const reminders: Occurrence[] = signals.reminders
    .filter((r) => r.repeat === "none" && Date.parse(r.created_at) >= since)
    .map((r) => {
      const p = zonedParts(new Date(r.remind_at), ctx.tz);
      return { text: r.text, date: p.date, time: p.time, weekday: weekdayOf(p.date), at: r.created_at };
    });
  for (const h of weeklyHabits(reminders, ctx.now)) {
    if (repeating.has(h.key) || spread(h.times) > 60) continue;
    const time = middleTime(h.times, 5);
    const day = WEEKDAYS[h.weekday];
    out.push({
      score: h.n,
      suggestion: {
        id: `repeat-reminder-${textKey(h.text)}`,
        title: `You set the same reminder every ${day}`,
        why: `“${clip(h.text, 60)}”: ${count(h.n)} times in ${count(REPEAT_DAYS / 7)} weeks, each a ${day} at about ${time}.`,
        flow: {
          name: clip(h.text, 60),
          trigger: { kind: "schedule", days: [h.weekday as TeamWeekday], time },
          steps: [{ id: "tell", title: null, kind: "notify", text: [clip(h.text, 500)] }],
          origin: "suggestion",
        },
      },
    });
  }

  const todos: Occurrence[] = signals.todos
    .filter((t) => Date.parse(t.created_at) >= since)
    .map((t) => {
      const made = zonedParts(new Date(t.created_at), ctx.tz);
      const date = t.due_on ?? made.date;
      return { text: t.title, date, time: t.due_on ? null : made.time, weekday: weekdayOf(date), at: t.created_at };
    });
  for (const h of weeklyHabits(todos, ctx.now)) {
    // Made on the day without a due date: add it at about the time they did. With a due date: first thing.
    if (h.times.length && h.times.length !== h.n) continue;
    if (h.times.length && spread(h.times) > 120) continue;
    const time = h.times.length ? middleTime(h.times, 15) : "08:00";
    const day = WEEKDAYS[h.weekday];
    out.push({
      score: h.n,
      suggestion: {
        id: `repeat-todo-${textKey(h.text)}`,
        title: `You add the same to-do every ${day}`,
        why: `“${clip(h.text, 60)}”: ${count(h.n)} times in ${count(REPEAT_DAYS / 7)} weeks, each for a ${day}.`,
        flow: {
          name: clip(h.text, 60),
          trigger: { kind: "schedule", days: [h.weekday as TeamWeekday], time },
          steps: [{ id: "todo", title: null, kind: "tool", tool: "add_todo", input: { title: [clip(h.text, 200)], kind: ["todo"] }, go: "auto", gives: [] }],
          origin: "suggestion",
        },
      },
    });
  }
  return out;
}

// ---------- saved: the same kind of thing filed the same way ----------

/** The saved actions a flow can run with nothing but the item: no person or list to pick. */
export const SAVED_ACTIONS: Record<string, { name: (plural: string) => string; title: (plural: string) => string }> = {
  watch_read: { name: (p) => `${sentence(p)} to Watch & read`, title: (p) => `You move the ${p} you save to Watch & read` },
  save_place: { name: () => "Saved places to Places", title: () => "You file the places you save under Places" },
  make_todo: { name: (p) => `${sentence(p)} to to-dos`, title: (p) => `You make a to-do from the ${p} you save` },
};
const PLURAL: Record<string, string> = { book: "books", film: "films", show: "shows", product: "products", recipe: "recipes", place: "places", event: "events", article: "articles", video: "videos", image: "images" };

/** "You move the books you save to Watch & read". */
export function detectSaved(signals: SuggestSignals, ctx: SuggestContext): Found[] {
  const since = daysBefore(ctx.now, SAVED_DAYS);
  const out: Found[] = [];
  const recent = signals.saved.filter((s) => s.thing && PLURAL[s.thing] && Date.parse(s.saved_at) >= since);
  for (const thing of new Set(recent.map((s) => s.thing!))) {
    const items = recent.filter((s) => s.thing === thing);
    if (items.length < MIN_TIMES) continue;
    const quick = items.filter((s) => s.filed_at && s.action && hoursBetween(s.saved_at, s.filed_at) >= 0 && hoursBetween(s.saved_at, s.filed_at) <= SAVED_FILE_HOURS);
    const byAction = new Map<string, number>();
    for (const s of quick) byAction.set(s.action!, (byAction.get(s.action!) ?? 0) + 1);
    const [action, n] = [...byAction.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
    if (!action || !n || !SAVED_ACTIONS[action] || n < MIN_TIMES || n / items.length < MIN_SHARE) continue;
    const plural = PLURAL[thing];
    out.push({
      score: n * (n / items.length),
      suggestion: {
        id: `saved-${thing}-${action}`,
        title: SAVED_ACTIONS[action].title(plural),
        why: `${share(n, items.length)} ${plural} you saved in the last ${SAVED_DAYS} days.`,
        flow: {
          name: clip(SAVED_ACTIONS[action].name(plural), 60),
          trigger: { kind: "event", event: { source: "saved", savedAction: "saved", kind: thing } },
          steps: [{ id: "file", title: null, kind: "tool", tool: "file_saved_item", input: { saved_id: [ref(TRIGGER_KEYS.saved)], action: [action] }, go: "auto", gives: [] }],
          origin: "suggestion",
        },
      },
    });
  }
  return out;
}

// ---------- all together ----------

/** Every detector's finds, best first. Pure. */
export function detectAll(signals: SuggestSignals, ctx: SuggestContext): Found[] {
  return [...detectFollow(signals, ctx), ...detectList(signals, ctx), ...detectRepeat(signals, ctx), ...detectSaved(signals, ctx)].sort(
    (a, b) => b.score - a.score || a.suggestion.id.localeCompare(b.suggestion.id),
  );
}

/**
 * What to offer: valid, not dismissed, not already a flow, one per trigger,
 * at most three, best first. Nothing when there's no room for another flow. Pure.
 */
export function pickSuggestions(found: Found[], opts: { dismissed: ReadonlySet<string>; flows: ExistingFlow[]; maxFlows: number }): FlowSuggestion[] {
  if (opts.flows.length >= opts.maxFlows) return [];
  const out: FlowSuggestion[] = [];
  const triggers = new Set<string>();
  for (const { suggestion } of found) {
    if (opts.dismissed.has(suggestion.id)) continue;
    if (suggestionProblems(suggestion).length) continue;
    if (alreadyAFlow(suggestion, opts.flows)) continue;
    // Two habits on one trigger (a reminder and a list after deliveries) would be two flows racing: offer the stronger.
    const t = JSON.stringify(suggestion.flow.trigger);
    if (triggers.has(t)) continue;
    triggers.add(t);
    out.push(suggestion);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

/** The text of a FlowText, chips as their keys: for tests and logs. */
export const flowTextPlain = (t: FlowText): string => t.map((p) => (typeof p === "string" ? p : `{${p.key}}`)).join("");
