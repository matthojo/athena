/**
 * Home's personal half: the people who matter most (from the profile's
 * "The people who matter most"), each as one sentence with their name as a
 * chip ("Mum's birthday is in 10 days.", "You last saw Priya on Wednesday,
 * at Dishoom."), then one line on a goal from "This year's goals". The
 * owner's name goes back to Home for the greeting. Ask's empty state reads
 * the same things for its examples (askContext).
 *
 * Every source loads on its own and is optional: a section with nothing to
 * say stays hidden. The words come from lib/home-personal.ts.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { hueFor, initials } from "../lib/format";
import { localToday } from "../lib/time";
import { isSampleMode, request } from "../db/api";
import { getMeta, setMeta } from "../db/idb";
import { notesSnapshot } from "../db/data";
import { loadRecords, onRecordsChange } from "../db/records";
import { loadBrief, loadGoals, loadInteractions, loadReading, onMemoryChange, weekStartOf } from "../db/memory";
import { loadProfile, onProfileChange } from "../db/profile";
import { sampleWeekExtras } from "../db/sample-week";
import { CATCH_UP, type SeenEvent } from "../lib/week-review";
import { openSheet } from "./sheet";
import { openCommitmentSheet } from "./commitment-sheet";
import { openDraftSheet } from "./draft-sheet";
import type { Fact, Person } from "../types";
import {
  addDays,
  birthdaysToday,
  daysToBirthday,
  firstName,
  giftIdeas,
  goalLine,
  goalMeasure,
  importantPeople,
  keepingInTouch,
  lastSeenBy,
  ownerName,
  personMoment,
  personNotes,
  profileGoals,
  topicOf,
  type AskPerson,
  type GoalLine,
  type LastSeen,
  type OwnerFact,
  type PersonMoment,
  type PersonNote,
  type SeenItem,
} from "../lib/home-personal";
import "../styles/home-personal.css";

// ---------- loading ----------

const NAME_KEY = () => `athena:owner-name:${isSampleMode() ? "sample" : "live"}`;

/** The name from last time, so the greeting doesn't arrive a beat after the page. */
export function rememberedName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY()) || null;
  } catch {
    return null;
  }
}

export function rememberName(name: string | null) {
  try {
    if (name) localStorage.setItem(NAME_KEY(), name);
    else localStorage.removeItem(NAME_KEY());
  } catch {
    // Private windows: the greeting just waits for the profile.
  }
}

async function ownerFacts(): Promise<OwnerFact[]> {
  try {
    const { sections } = await loadProfile();
    return sections.flatMap((s) => s.fields.filter((f) => f.fact).map((f) => ({ key: f.key, value: f.fact!.value })));
  } catch {
    return [];
  }
}

/** Calendar events with someone at a place, the last six weeks (GET /api/week-review), kept for offline. */
async function seenEvents(today: string): Promise<SeenEvent[]> {
  const from = addDays(today, -42);
  try {
    const { seen } = await request<{ seen: SeenEvent[] }>(`/week-review?${new URLSearchParams({ from, to: today, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}`);
    void setMeta("home:seen", JSON.stringify(seen)).catch(() => undefined);
    return seen;
  } catch {
    try {
      const kept = await getMeta("home:seen");
      return kept ? (JSON.parse(kept) as SeenEvent[]) : [];
    } catch {
      return [];
    }
  }
}

/** Every catch-up Athena knows: logged ones (sample mode adds its week and month), and events with someone at a place. */
export async function catchUps(today: string): Promise<SeenItem[]> {
  const { items } = await loadInteractions().catch(() => ({ items: [] as Awaited<ReturnType<typeof loadInteractions>>["items"] }));
  let logged: Array<(typeof items)[number] & { how?: string; where?: string }> = items;
  let events: SeenEvent[] = [];
  if (isSampleMode()) {
    const week = sampleWeekExtras("week", weekStartOf(today), addDays(weekStartOf(today), 6), today, []);
    const month = sampleWeekExtras("month", addDays(today, -27), today, today, []);
    logged = [...logged, ...week.interactions, ...month.interactions];
    events = [...week.seenEvents, ...month.seenEvents];
  } else events = await seenEvents(today);
  return [
    ...logged
      .filter((i) => !i.archived_at && CATCH_UP[i.channel])
      .map((i) => ({ date: localToday(new Date(i.at)), people: i.people, inPerson: i.channel === "in_person", how: i.how ?? CATCH_UP[i.channel], where: i.where, summary: i.summary })),
    ...events.map((e) => ({ date: e.date, people: e.people, inPerson: true, how: e.title, where: e.place })),
  ];
}

/** The longest run in the last eight weeks, in km; null without one (or without health data). */
async function longestRun(today: string): Promise<number | null> {
  try {
    const { loadHealthDays } = await import("../db/health");
    const { days } = await loadHealthDays(addDays(today, -56), today);
    let best = 0;
    for (const d of days) for (const w of d.workouts ?? []) if (/run/i.test(w.type) && w.distance_m) best = Math.max(best, w.distance_m / 1000);
    return best || null;
  } catch {
    return null;
  }
}

async function booksThisYear(today: string): Promise<number | null> {
  try {
    const { items } = await loadReading();
    return items.filter((r) => r.kind === "book" && r.status === "done" && r.finished_at && r.finished_at.slice(0, 4) === today.slice(0, 4)).length;
  } catch {
    return null;
  }
}

async function goalFor(facts: OwnerFact[], today: string): Promise<GoalLine | null> {
  const goals = profileGoals(facts);
  if (!goals.length) return null;
  const kinds = new Set(goals.map((g) => goalMeasure(g)?.kind));
  const [run, books, records] = await Promise.all([
    kinds.has("run") ? longestRun(today) : Promise.resolve(null),
    kinds.has("books") ? booksThisYear(today) : Promise.resolve(null),
    loadGoals().then((r) => r.items).catch(() => []),
  ]);
  return goalLine(goals, { longestRunKm: run, booksThisYear: books, records });
}

export interface OwnerContext {
  name: string | null;
  people: PersonNote[];
  /** Their records, for the birthday sheet (by id). */
  records: Map<string, Person>;
  /** Every catch-up Athena knows, for the sheet and "again". */
  seen: SeenItem[];
  /** The ids in "The people who matter most". */
  important: Set<string>;
  goal: GoalLine | null;
  /** For Ask: each important person's latest topic and birthday. */
  askPeople: AskPerson[];
  /** The latest place you saw someone. */
  place: string | null;
}

/** Everything Home's personal half and Ask's examples need. */
export async function ownerContext(): Promise<OwnerContext> {
  const today = localToday();
  const facts = await ownerFacts();
  const name = ownerName(facts);
  rememberName(name);
  const important = importantPeople(facts);
  const [people, seenItems, goal] = await Promise.all([
    // Everyone, not just who's overdue a catch-up: a birthday is a birthday however recently you met.
    important.length ? loadRecords("person").then((r) => r.items).catch(() => [] as Person[]) : Promise.resolve([] as Person[]),
    important.length ? catchUps(today).catch(() => [] as SeenItem[]) : Promise.resolve([] as SeenItem[]),
    goalFor(facts, today).catch(() => null),
  ]);
  // A person typed by name in the profile finds their record by name.
  const byName = new Map(people.map((p) => [p.name.toLowerCase(), p.id]));
  const linked = important.map((p) => ({ id: p.id ?? byName.get(p.name.toLowerCase()) ?? null, name: p.name }));
  const birthdays = new Map(people.map((p) => [p.id, p.birthday]));
  const seen: Map<string, LastSeen> = lastSeenBy(seenItems);
  const latestWith = (id: string | null) => (id ? seenItems.filter((s) => s.people.some((x) => x.id === id) && s.summary).sort((a, b) => b.date.localeCompare(a.date))[0] : undefined);
  const names = people.map((p) => p.name);
  const place = [...seenItems].filter((s) => s.where && s.inPerson).sort((a, b) => b.date.localeCompare(a.date))[0]?.where ?? null;
  const notes = personNotes(keepingInTouch(linked, people).slice(0, 4), { today, birthdays, seen });
  // After a catch-up you do together somewhere, the row says how often this year: "Third lunch with Priya at Dishoom this year."
  for (const n of notes) {
    if (!n.id) continue;
    const again = personMoment({ id: n.id, name: n.name }, { today, seen: seenItems, facts: [], gifts: [] }).again;
    if (again) n.sub = again;
  }
  return {
    name,
    people: notes,
    records: new Map(people.map((p) => [p.id, p])),
    seen: seenItems,
    important: new Set(linked.map((p) => p.id).filter((id): id is string => !!id)),
    goal,
    askPeople: linked.map((p) => ({ name: p.name, topic: topicOf(latestWith(p.id)?.summary, names), birthdayIn: p.id ? daysToBirthday(birthdays.get(p.id), today) : null })),
    place,
  };
}

// ---------- drawing ----------

export interface HomePersonalCtx {
  openPerson: (id: string) => void;
  goPeople: () => void;
  goGoals: () => void;
  /** The owner's name, whenever it's read (null without one). */
  onName: (name: string | null) => void;
}

function personRow(p: PersonNote, ctx: HomePersonalCtx, i: number, c?: OwnerContext): HTMLElement {
  const lead = p.birthdaySoon
    ? h("span", { class: "tile tile--sm home-person__gift", "aria-hidden": "true" }, icons.gift())
    : h("span", { class: "avatar avatar--row", style: `--h:${hueFor(p.name)}`, "aria-hidden": "true" }, initials(p.name));
  const body = h(
    "span",
    { class: "home-person__text" },
    // "Mum's birthday": the possessive goes in the chip, so it reads as one word.
    p.after.startsWith("'s ")
      ? h("span", { class: "home-person__line" }, p.before, h("span", { class: "home-person__chip" }, `${p.name}'s`), p.after.slice(2))
      : h("span", { class: "home-person__line" }, p.before, h("span", { class: "home-person__chip" }, p.name), p.after),
    p.sub ? h("span", { class: "home-person__sub" }, p.sub) : null
  );
  // A birthday in the next week opens a small sheet to think of them, instead of their page.
  const sheet = !!p.id && p.birthdayIn != null && p.birthdayIn >= 1 && p.birthdayIn <= 7 && !!c;
  const row = h(
    "button",
    { class: "home-person", type: "button", style: `--i:${i}`, disabled: !p.id, "aria-haspopup": sheet ? "dialog" : undefined },
    lead,
    body,
    p.id ? h("span", { class: "home-person__chevron", "aria-hidden": "true" }, icons.chevronRight()) : null
  );
  if (p.id) row.addEventListener("click", () => (sheet && c ? openThinkingOf(p.id!, c, ctx.openPerson) : ctx.openPerson(p.id!)));
  return row;
}

function goalCard(g: GoalLine, ctx: HomePersonalCtx): HTMLElement {
  const b = h(
    "button",
    { class: "card pressable home-goal", type: "button", "aria-label": `${g.title}. ${g.text}. Opens Goals` },
    h("span", { class: "tile home-goal__tile", "aria-hidden": "true" }, icons.flag()),
    h(
      "span",
      { class: "home-goal__text" },
      h("span", { class: "home-goal__title" }, g.title),
      h("span", { class: "home-goal__line" }, g.text),
      g.ratio !== null ? h("span", { class: "home-goal__bar", "aria-hidden": "true" }, h("span", { class: "home-goal__fill", style: `--to:${g.ratio.toFixed(3)}` })) : null
    )
  );
  b.addEventListener("click", ctx.goGoals);
  return b;
}

export function homePersonal(ctx: HomePersonalCtx): { el: HTMLElement; banner: HTMLElement; destroy: () => void } {
  // On someone's birthday, one line for the top of Home (home-banners).
  const banner = h("div", { class: "home-birthdays", hidden: true });
  const list = h("div", { class: "card home-people__list" });
  const all = h("button", { class: "link-btn", type: "button" }, "Everyone");
  all.addEventListener("click", ctx.goPeople);
  const people = h(
    "section",
    { class: "section home-people", "aria-labelledby": "home-people", hidden: true },
    h("div", { class: "section-head" }, h("h2", { id: "home-people" }, "Your people"), all),
    list
  );
  const goalSlot = h("div", { class: "home-goal-slot" });
  const goal = h(
    "section",
    { class: "section home-goal-section", "aria-labelledby": "home-goal", hidden: true },
    h("div", { class: "section-head" }, h("h2", { id: "home-goal" }, "This year")),
    goalSlot
  );
  const el = h("div", { class: "home-personal" }, people, goal);

  let dead = false;
  let run = 0;
  const paint = async () => {
    const mine = ++run;
    const c = await ownerContext().catch(() => null);
    if (dead || mine !== run || !c) return;
    ctx.onName(c.name);
    people.hidden = !c.people.length;
    list.replaceChildren(...c.people.map((p, i) => personRow(p, ctx, i, c)));
    paintBirthdays(banner, c, ctx.openPerson);
    goal.hidden = !c.goal;
    goalSlot.replaceChildren(...(c.goal ? [goalCard(c.goal, ctx)] : []));
    el.hidden = people.hidden && goal.hidden;
  };
  void paint();
  const off = onProfileChange(() => void paint());
  const offMemory = onMemoryChange((topic) => (topic === "interaction" || topic === "goal" || topic === "reading" || topic === "all") && void paint());
  const offRecords = onRecordsChange((kind) => (kind === "person" || kind === "all") && void paint());
  return {
    el,
    banner,
    destroy: () => {
      dead = true;
      off();
      offMemory();
      offRecords();
    },
  };
}

// ---------- thinking of them: the birthday sheet and the banner ----------

/** Facts that are the owner's own words or accepted from the Review inbox (the server says which; this is the device's fallback). */
const OWNER_SOURCES = new Set(["manual", "assistant", "app"]);
const newest = (a: Fact, b: Fact) => Date.parse(b.observed_at) - Date.parse(a.observed_at);
const acceptedOf = (facts: Fact[]) => facts.filter((f) => !f.superseded_at && (!f.source || OWNER_SOURCES.has(f.source))).sort(newest);

/** What it's about, for the draft: the owner's words, with the last thing you talked about. */
function draftAbout(m: PersonMoment, topic: string | null): { about: string; sample: [string, string, string] } {
  const days = m.birthday?.days ?? 0;
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `on ${new Date(`${m.birthday!.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}`;
  const about = `wish ${m.name} a happy birthday (it's ${when})${topic ? `, and ask how ${topic} is going` : ""}. Short and warm.`;
  const hello = days === 0 ? "Happy birthday! I hope you're having a lovely day." : `Happy birthday for ${when === "tomorrow" ? "tomorrow" : when.replace(/^on /, "")}! I hope you get to make a day of it.`;
  const middle = `${hello}${topic ? ` How are you feeling about ${topic}?` : ""}`;
  return { about, sample: ["Happy birthday", middle, "Speak soon,"] };
}

/** The latest thing you talked about with them, for the draft. */
function latestTopic(id: string, c: Pick<OwnerContext, "seen" | "records">): string | null {
  const latest = c.seen.filter((s) => s.summary && s.people.some((p) => p.id === id)).sort((a, b) => b.date.localeCompare(a.date))[0];
  return latest ? topicOf(latest.summary, [...c.records.values()].map((p) => p.name)) : null;
}

/**
 * A small sheet for someone whose birthday is close: the birthday, the last
 * time you saw them and what about, gift ideas you saved, one thing you
 * know. [Remind me <the day before>] adds a to-do; [Write to her] opens a
 * draft in the owner's voice, which Athena never sends. "Open Priya" goes to
 * their page.
 */
export function openThinkingOf(id: string, c: Pick<OwnerContext, "seen" | "records">, openPerson: (id: string) => void): void {
  const person = c.records.get(id);
  if (!person) return openPerson(id);
  const today = localToday();
  const names = [...c.records.values()].filter((p) => p.id !== id).map((p) => p.name);
  const body = h("div", { class: "moment", "aria-busy": "true" }, h("div", { class: "moment__wait" }, ...[60, 88, 74].map((w) => h("span", { class: "skeleton", style: `width:${w}%` }))));
  const sheet = openSheet({ label: `${firstName(person.name)}'s birthday`, body });

  const paint = (facts: Fact[], gifts: string[]) => {
    const m = personMoment(person, { today, seen: c.seen, facts, gifts, names });
    const ref = { id: person.id, name: person.name };
    const line = (icon: SVGElement, text: Node | string, i: number, sub?: string | null) =>
      h("li", { class: "moment__line", style: `--i:${i}` }, h("span", { class: "moment__icon", "aria-hidden": "true" }, icon), h("span", { class: "moment__text" }, text, sub ? h("span", { class: "moment__sub" }, sub) : null));
    const lines: HTMLElement[] = [];
    if (m.lastTime) lines.push(line(icons.chat(), m.lastTime, lines.length, m.again));
    if (m.giftLine) lines.push(line(icons.gift(), m.giftLine, lines.length));
    if (m.fact) lines.push(line(icons.heart(), h("span", {}, h("span", { class: "moment__key" }, m.fact.key), ` ${m.fact.value}`), lines.length));

    const actions: HTMLElement[] = [];
    if (m.remind) {
      const remind = h("button", { class: "btn btn--soft moment__btn", type: "button" }, icons.bell(), m.remind.label);
      const r = m.remind;
      remind.addEventListener("click", () => openCommitmentSheet(null, { person: ref, due: r.on, title: r.title }));
      actions.push(remind);
    }
    const write = h("button", { class: "btn btn--primary moment__btn", type: "button" }, icons.pen(), m.write);
    write.addEventListener("click", () => {
      const { about, sample } = draftAbout(m, latestTopic(id, c));
      openDraftSheet({ person: ref, about, sample });
    });
    actions.push(write);
    const open = h("button", { class: "link-btn moment__open", type: "button" }, `Open ${m.name}`, icons.chevronRight());
    open.addEventListener("click", () => {
      sheet.close();
      openPerson(id);
    });

    body.removeAttribute("aria-busy");
    body.replaceChildren(
      h(
        "header",
        { class: "moment__head" },
        h("span", { class: "moment__avatar", style: `--h:${hueFor(person.name)}`, "aria-hidden": "true" }, initials(person.name), h("span", { class: "moment__badge" }, icons.gift())),
        h(
          "div",
          { class: "moment__heading" },
          m.birthday ? h("p", { class: "moment__date" }, new Date(`${m.birthday.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })) : null,
          h("h2", { class: "moment__title" }, m.birthday?.line ?? m.name)
        )
      ),
      ...(lines.length ? [h("ul", { class: "moment__lines" }, ...lines)] : []),
      h("div", { class: "moment__actions", style: `--i:${lines.length}` }, ...actions),
      open
    );
  };

  // What the brief adds (their gift ideas and facts), with what's on the device if it can't be reached.
  let painted = false;
  const fallback = setTimeout(() => {
    if (!painted) {
      painted = true;
      paint([], giftIdeas(notesSnapshot().notes, id));
    }
  }, 1500);
  void loadBrief(id)
    .then(({ brief }) => {
      if (painted) return;
      painted = true;
      clearTimeout(fallback);
      paint(brief ? brief.accepted_facts ?? acceptedOf(brief.facts) : [], brief?.gift_ideas ?? giftIdeas(notesSnapshot().notes, id));
    })
    .catch(() => undefined);
}

const DISMISSED_KEY = "athena:birthday-dismissed";

/** The birthdays dismissed today, as ids. */
function dismissedToday(today: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "{}") as { date?: string; ids?: string[] };
    return new Set(v.date === today ? v.ids ?? [] : []);
  } catch {
    return new Set();
  }
}

function dismiss(today: string, id: string) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify({ date: today, ids: [...dismissedToday(today), id] }));
  } catch {
    // Private windows: it's dismissed until Home is next drawn.
  }
}

/** "It's Priya's birthday." at the top of Home, for the people who matter most or you keep in touch with. Dismissed for the day with ×. */
function paintBirthdays(slot: HTMLElement, c: OwnerContext, openPerson: (id: string) => void) {
  const today = localToday();
  const gone = dismissedToday(today);
  const people = birthdaysToday([...c.records.values()], c.important, today).filter((p) => !gone.has(p.id)).slice(0, 2);
  const shown = new Set([...slot.querySelectorAll<HTMLElement>("[data-person]")].map((e) => e.dataset.person));
  slot.hidden = !people.length;
  if (people.length === shown.size && people.every((p) => shown.has(p.id))) return;
  slot.replaceChildren(
    ...people.map((p, i) => {
      const name = firstName(p.name);
      const open = h(
        "button",
        { class: "home-birthday__open", type: "button", "aria-haspopup": "dialog" },
        h("span", { class: "tile tile--sm home-birthday__tile", "aria-hidden": "true" }, icons.gift()),
        h("span", { class: "home-birthday__line" }, "It's ", h("span", { class: "home-person__chip" }, `${name}'s`), " birthday.")
      );
      open.addEventListener("click", () => openThinkingOf(p.id, c, openPerson));
      const close = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost home-birthday__close", type: "button", "aria-label": `Dismiss ${name}'s birthday for today` }, icons.close());
      const row = h("div", { class: "card home-birthday", "data-person": p.id, style: `--i:${i}` }, open, close);
      close.addEventListener("click", () => {
        dismiss(today, p.id);
        row.classList.add("is-leaving");
        const done = () => {
          row.remove();
          slot.hidden = !slot.querySelector(".home-birthday");
        };
        row.addEventListener("animationend", done, { once: true });
        setTimeout(done, 600);
      });
      return row;
    })
  );
}
