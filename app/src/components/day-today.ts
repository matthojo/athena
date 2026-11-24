/**
 * Today, as one block: at the top of Home and of the Days feed. It changes
 * gently through the day (in this device's zone, which is the owner's):
 *  - morning: last night's sleep, what's ahead today, On this day
 *  - daytime: the day so far: its line, the latest artwork, steps and places
 *  - evening: the day handed back. Mood and the line come first: five faces,
 *    then a box for the owner's own line with the run's line (or the day's
 *    sentence: people, then places, then a highlight) waiting in it in grey.
 *    Leaving the box says "Kept" and quotes their words. Habits fold into
 *    one line that opens, with no count.
 * Always: mood in one tap, Write about today, and a way into the full day.
 * A change of phase cross-fades (a cut with reduced motion).
 */

import "../styles/days.css";
import "../styles/moments.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { artStrip, photoArt } from "./day-art";
import { earlierCard } from "./day-card";
import { moodPicker } from "./day-mood";
import { addDays, fallbackLine, healthSentences, listLine, longDate, roughSteps, hoursMinutes, deepNote, sameDayEarlier, type HealthFigures } from "./day-words";
import { firstName, memorySentence, namesTopic, pickMemory, placeClauses, WEEK_WINDOW, type MemoryCandidate, type RememberedDay } from "../lib/memories";
import { loadMemoryContext, syncMemoryPrefs } from "../db/memories-app";
import { dayMark, loadDay, loadDays, nothingNew, onDaysChange, reloadWhenIdle, saveDay, type Day, type DayEntry, type DaySummary } from "../db/days-app";
import { loadHealthDays } from "../db/health";
import { localToday } from "../lib/time";
import { dayHref } from "../lib/day-link";
import { prefersReducedMotion } from "../lib/motion";
import { todayHabits } from "./habit-today";
import { checkinEntry } from "./checkin-entry";
import { journalEditor } from "./day-journal";
import { catchUps } from "./home-personal";
import { loadHabitsOn, onHabitsChange, type HabitsOn } from "../db/habits";
import { isDone } from "../../../lib/habit-rules";
import { eveningLine, keptLead, type SeenToday } from "../../../lib/nudges";

import { phaseAt } from "./day-words";
import { clockTime } from "../lib/clock";

export const blankDay = (date: string): Day => ({ date, photos: [], places: [], entries: [], notes: [], events: [], counts: { entries: 0, by_kind: {}, minutes: {}, photos: 0, notes: 0, events: 0, heat: 0 } });

/**
 * Today's memory (lib/memories.ts), as On this day shows it: at most one
 * day, carrying its sentence. Reads the same week in each of the last six
 * years and the server's firsts, picks one, and only then opens that one
 * day in full for its journal. Empty when memories are off (Settings → Days)
 * or nothing qualifies. Memories are for the app only, never a push.
 */
export async function onThisDay(today: string): Promise<RememberedDay[]> {
  const prefs = await syncMemoryPrefs();
  if (!prefs.on) return [];
  const weeks = sameDayEarlier(today, 6).map((d) => ({ from: addDays(d, -WEEK_WINDOW), to: addDays(d, WEEK_WINDOW) }));
  const [ranges, ctx] = await Promise.all([
    Promise.all(weeks.map((w) => loadDays(w.from, w.to).then((r) => r.days, () => [] as DaySummary[]))),
    loadMemoryContext(today).catch(() => null),
  ]);
  const summaries = new Map(ranges.flat().map((d) => [d.date, d]));
  const seen = new Map((ctx?.days ?? []).map((d) => [d.date, d]));
  const never = ctx?.never ?? [];
  const MEDIA = ["watched", "listened", "read", "played"] as const;
  const candidates: MemoryCandidate[] = [
    ...[...summaries.values()].map((s) => ({
      date: s.date,
      mood: s.mood,
      words: s.journal,
      people: seen.get(s.date)?.people,
      places: seen.get(s.date)?.places,
      media: MEDIA.some((k) => (s.counts.by_kind[k] ?? 0) > 0),
      text: s.line ? [s.line] : [],
    })),
    ...(ctx?.firsts ?? []).map((f) => ({
      date: f.date,
      first: { kind: f.kind, name: f.name, since: f.since, km: f.km },
      mood: summaries.get(f.date)?.mood,
      people: seen.get(f.date)?.people,
    })),
  ];
  const hidden = [...prefs.hidden];
  // The journal can name a never-nudge topic; that's only known once the day is open, so try the next.
  for (let tries = 0; tries < 3; tries++) {
    const m = pickMemory({ today, candidates, hidden, neverTopics: never });
    if (!m) return [];
    const c = m.candidate;
    const who = seen.get(c.date);
    const full = c.first && c.first.kind !== "place" ? null : await loadDay(c.date).catch(() => null);
    const own = full?.journal || (full?.line_by === "owner" ? full.line : null) || null;
    if (full && namesTopic([own, full.line, full.places_line, ...full.entries.map((e) => e.group ?? e.title)].filter(Boolean).join("\n"), never)) {
      hidden.push(c.date);
      continue;
    }
    const top = full?.entries.find((e) => MEDIA.includes(e.kind as (typeof MEDIA)[number]) && VERB[e.kind]);
    const people = (who?.people ?? []).filter((p) => !p.archived).map((p) => firstName(p.name));
    const sentence = memorySentence(m, {
      words: own,
      people: c.first?.kind === "person" ? [] : people.slice(0, 2),
      call: who?.call,
      place: placeClauses(who?.line ?? full?.places_line ?? "")[0] ?? who?.places[0] ?? null,
      media: top ? `${VERB[top.kind]!.toLowerCase()} ${top.group ?? top.title}` : null,
      line: full?.line ? listLine(full.line) : null,
    });
    const found = summaries.get(c.date) ?? { date: c.date, counts: blankDay(c.date).counts, art: [], journal: false };
    // A first is about the first time, not that day's telly: no cover, a small mark instead (components/day-card.ts).
    const summary: DaySummary = c.first ? { ...found, art: [], photo: undefined } : found;
    return [{ ...summary, memory: { sentence, tier: m.tier, ...(c.first ? { first: c.first.kind } : {}) } }];
  }
  return [];
}

const VERB: Partial<Record<DayEntry["kind"], string>> = { watched: "Watching", listened: "Listening to", read: "Reading", played: "Playing" };

/** The newest things with artwork, newest first, one per show or album. */
function latestArt(day: Day): DayEntry[] {
  const seen = new Set<string>();
  return day.entries
    .filter((e) => e.art && e.source !== "places")
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .filter((e) => {
      const k = e.group ?? e.id;
      return !seen.has(k) && !!seen.add(k);
    });
}

/** "10:00" for an event today, in this zone. */
const timeOf = (iso: string) => clockTime(iso);

export interface TodayOptions {
  /** Open a day; with write, its journal is focused. */
  openDay: (date: string, opts?: { write?: boolean }) => void;
  /** Where it sits: Home leads with it; the feed shows it above the days. */
  place: "home" | "feed";
  /** For tests and screenshots. */
  now?: () => Date;
  /** Told whether the day has anything in it yet, each time it paints. */
  onQuiet?: (quiet: boolean) => void;
  /** Told the day in one sentence (people, then places, then a highlight; else the run's line), each time it paints: Home's evening headline. */
  onLine?: (line: string | null) => void;
}

/** Who the owner saw today, by Week in review's rule (components/home-personal.ts catchUps). */
async function seenToday(today: string): Promise<SeenToday[]> {
  const items = await catchUps(today).catch(() => []);
  return items.filter((i) => i.date === today).flatMap((i) => i.people.map((p) => ({ name: p.name, in_person: i.inPerson, place: i.where ?? null, how: i.how ?? null })));
}

/** "Evening walk, Read 20 pages and Stretch", or "All done": the folded habits' one line. Never a count. */
export function habitsLine(data: HabitsOn): string | null {
  const byId = new Map(data.habits.map((x) => [x.id, x]));
  const due = data.on.filter((d) => d.shows && byId.has(d.id));
  if (!due.length) return null;
  if (due.every((d) => isDone(d.progress, byId.get(d.id)!.target))) return due.length === 1 ? "Done" : "All done";
  const names = due.map((d) => byId.get(d.id)!.name);
  return names.length <= 3 ? names.join(", ").replace(/, ([^,]*)$/, " and $1") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export function todayBlock(opts: TodayOptions): { el: HTMLElement; destroy: () => void } {
  const now = opts.now ?? (() => new Date());
  const today = localToday(now());
  let phase = phaseAt(now());
  let day: Day | null = null;
  let before: HealthFigures[] = [];
  let earlier: DaySummary[] = [];
  let seen: SeenToday[] = [];
  let habitsSummary: string | null = null;
  /** The habits fold stays open across repaints once the owner opens it. */
  let habitsOpen = false;
  let dead = false;
  /** The day as last painted (a dayMark), to tell a change made elsewhere from one already on screen. */
  let painted = "";

  const inner = h("div", { class: "today__inner" });
  // The owner's own habits due today, ticked in one tap; kept across repaints (components/habit-today.ts).
  const habits = todayHabits(today);
  // The morning preparation or evening reflection, when it's due (components/checkin-entry.ts); kept across repaints.
  const checkins = checkinEntry({ today, now, place: opts.place });
  // Named by its title once it has one; "Today" until then (or if the day can't load).
  const el = h("section", { class: `today today--${opts.place}`, "aria-labelledby": `today-title-${opts.place}`, "aria-label": "Today", "aria-busy": "true" }, inner);
  inner.append(skeleton());

  const link = (label: string, cls: string, write = false, icon?: SVGSVGElement) => {
    const a = h("a", { class: cls, href: `${dayHref(today)}${write ? "?write" : ""}` }, ...(icon ? [icon] : []), label);
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      opts.openDay(today, { write });
    });
    return a;
  };

  function paint() {
    if (dead) return;
    const d = day ?? blankDay(today);
    painted = dayMark(d);
    el.removeAttribute("aria-busy");
    el.dataset.phase = phase;
    const h_ = d.health;
    const sleep = h_?.sleep_minutes !== undefined ? healthSentences({ sleep_minutes: h_.sleep_minutes }, before)[0] : null;
    const art = latestArt(d);
    const nothing = !d.entries.length && !h_ && !d.photos.length && !d.events.length && !d.places.length;
    opts.onQuiet?.(nothing);

    // ---- the title ----
    const line = d.line || fallbackLine(d, seen);
    // The day handed back: who, then where, then a highlight (lib/nudges.ts eveningLine), else the run's line.
    const daySentence = eveningLine({ places_line: d.places_line, entries: d.entries.filter((e) => e.source !== "places"), events: d.events }, seen) ?? (d.line || null);
    opts.onLine?.(daySentence);
    const ownLine = d.line_by === "owner" && d.line ? d.line : null;
    let kicker = "So far today";
    let title: string;
    if (phase === "morning") {
      kicker = "This morning";
      title = sleep ? `Slept ${hoursMinutes(h_!.sleep_minutes!)}${deepNote(h_!.sleep_stages)}` : nothing ? "Nothing in yet this morning" : line ?? "Good to see you";
    } else if (phase === "evening") {
      kicker = "This evening";
      // Once the owner has written their line, it's the title; until then, the question.
      title = ownLine ?? "How was today?";
    } else title = line ?? "Nothing in yet today";

    // ---- what's on: the newest artwork ----
    const latest = art[0];
    const onNow =
      phase !== "morning" && latest
        ? h(
            "div",
            { class: "today__art" },
            artStrip([...d.photos.slice(0, 1).map((p) => ({ art: photoArt(p), title: "Photo", photo: true })), ...art.map((e) => ({ art: e.art, title: e.title }))], { height: opts.place === "home" ? 76 : 64, max: 6 }),
          )
        : null;

    // ---- the day in words: sleep, steps, places ----
    const now_ = phase !== "morning" && latest && VERB[latest.kind] ? `${VERB[latest.kind]!.toLowerCase()} ${latest.group ?? latest.title}` : null;
    const facts = [
      phase !== "morning" && h_?.sleep_minutes ? `Slept ${hoursMinutes(h_.sleep_minutes)}${deepNote(h_.sleep_stages)}` : null,
      h_?.steps ? `${roughSteps(h_.steps)} steps${phase === "evening" ? "" : " so far"}` : null,
      now_,
    ].filter((x): x is string => !!x);
    const words = facts.length || d.places_line ? h("p", { class: "today__words" }, [facts.join(" · "), d.places_line].filter(Boolean).join(". ")) : null;

    // ---- the morning: what's ahead ----
    const ahead =
      phase === "morning"
        ? d.events
            .filter((e) => e.starts_at && new Date(e.starts_at) > now())
            .sort((a, b) => a.starts_at!.localeCompare(b.starts_at!))
            .slice(0, 3)
        : [];
    const aheadEl = ahead.length
      ? h("div", { class: "today__ahead" }, h("p", { class: "today__label" }, "Ahead today"), h("ul", { class: "today__events", role: "list" }, ...ahead.map((e) => h("li", {}, h("span", { class: "today__time" }, timeOf(e.starts_at!)), h("span", {}, e.title)))))
      : null;

    // ---- mood and the journal ----
    const picker = moodPicker({
      value: d.mood ?? null,
      label: phase === "evening" ? "How was today?" : "How's today going?",
      compact: true,
      onChange: (m) => {
        const was = d.mood;
        d.mood = m ?? undefined;
        saveDay(today, { mood: m }).then(
          (x) => (day = x),
          () => {
            d.mood = was;
            picker.set(was ?? null);
            showToast("Mood didn't save. Check you're online", { icon: "wifiOff" });
          }
        );
      },
    });
    const evening = phase === "evening";
    const write = link(evening ? (d.journal ? "Add to today's page" : "Write more") : d.journal ? "Add to today's page" : "Write about today", `btn ${evening ? "btn--ghost" : "btn--primary"} today__write`, true, icons.pen());

    // ---- the evening: the owner's line, the run's waiting in grey ----
    const lineBox = evening
      ? journalEditor({
          value: ownLine ?? "",
          label: "Add a line about today",
          placeholder: (d.line_by !== "owner" ? d.line : null) ?? daySentence ?? "Sum up the day in a line",
          line: { maxLength: 140 },
          save: async (text) => {
            const x = await saveDay(today, { line: text.trim() });
            // Kept without a repaint, so the box keeps its focus.
            day = x;
          },
          onKept: (text) => {
            showToast(keptLead(today, seen, d.places_line), { icon: "check", quote: text });
            // Their words become the block's title, settling in like the headline.
            if (titleEl.textContent !== text) {
              titleEl.textContent = text;
              titleEl.classList.remove("is-kept");
              void titleEl.offsetWidth;
              titleEl.classList.add("is-kept");
            }
          },
        })
      : null;
    const lineEl = lineBox ? h("div", { class: "today__line" }, h("p", { class: "today__label", "aria-hidden": "true" }, "Add a line"), lineBox.el) : null;

    // ---- habits: in the evening one line that opens, never a count ----
    let habitsEl: HTMLElement = habits.el;
    if (evening && habitsSummary) {
      const fold = h(
        "details",
        { class: "today-fold" },
        h("summary", { class: "today-fold__sum" }, h("span", { class: "today__label" }, "Habits today"), h("span", { class: "today-fold__line" }, habitsSummary), h("span", { class: "today-fold__chev", "aria-hidden": "true" }, icons.chevronRight())),
        h("div", { class: "today-fold__body" }, habits.el)
      ) as HTMLDetailsElement;
      fold.open = habitsOpen;
      fold.addEventListener("toggle", () => (habitsOpen = fold.open));
      habitsEl = fold;
    }
    const open = link("Open today", "btn btn--ghost today__open");
    open.append(icons.chevronRight());

    // ---- On this day: in the morning on Home, always in the feed ----
    // On this day lives on Home (mornings on a phone, always on a wide screen; days.css) and on today's page.
    const showEarlier = earlier.length > 0 && opts.place === "home";
    const earlierEl = showEarlier
      ? h("div", { class: `today__earlier${opts.place === "home" && phase !== "morning" ? " today__earlier--wide-only" : ""}` }, h("p", { class: "today__label" }, "On this day"), ...earlier.slice(0, 2).map((x) => earlierCard(x, today, (date) => opts.openDay(date))))
      : null;

    const keep = (xs: (HTMLElement | null)[]) => xs.filter((x): x is HTMLElement => !!x);
    const kickerEl = h("p", { class: "today__kicker" }, kicker, ...(opts.place === "feed" ? [h("span", { "aria-hidden": "true" }, " · "), longDate(today, today)] : []));
    const titleEl = h("h2", { class: "today__title", id: `today-title-${opts.place}` }, title);
    // The evening: mood and the line first, then the day in words and art, habits folded under it.
    const next = evening
      ? [
          h(
            "div",
            { class: "today__main today__main--evening" },
            ...keep([
              kickerEl,
              titleEl,
              // Their own line is the title once written; the day's sentence sits under it (until then it waits in the box).
              ownLine && daySentence && daySentence !== ownLine ? h("p", { class: "today__so-far today__day" }, daySentence) : null,
              checkins.el,
              h("div", { class: "today__feel" }, picker.el),
              lineEl,
            ])
          ),
          h("div", { class: "today__side" }, ...keep([onNow, words, habitsEl, h("div", { class: "today__actions" }, write, open), earlierEl])),
        ]
      : [
      h(
        "div",
        { class: "today__main" },
        ...keep([
          // Home's top bar already gives the date.
          h("p", { class: "today__kicker" }, kicker, ...(opts.place === "feed" ? [h("span", { "aria-hidden": "true" }, " · "), longDate(today, today)] : [])),
          h("h2", { class: "today__title", id: `today-title-${opts.place}` }, title),
          nothing && phase !== "evening" ? h("p", { class: "today__words" }, "Your apps fill this in as the day goes. You can set a mood or write now.") : null,
          checkins.el,
          phase === "evening" && !d.line && line ? h("p", { class: "today__so-far" }, line) : null,
          phase === "morning" && sleep?.aside ? h("p", { class: "today__so-far" }, sleep.aside) : null,
          onNow,
          words,
          aheadEl,
          habitsEl,
        ])
      ),
      h(
        "div",
        { class: "today__side" },
        ...keep([
          phase === "evening" && !d.line ? null : h("p", { class: "today__label", "aria-hidden": "true" }, phase === "evening" ? "How was today?" : "How's today going?"),
          picker.el,
          h("div", { class: "today__actions" }, write, open),
          earlierEl,
        ])
      ),
    ];
    el.classList.toggle("today--evening", evening);

    if (inner.childElementCount && !prefersReducedMotion() && el.dataset.painted) {
      inner.classList.add("is-fading");
      setTimeout(() => {
        inner.replaceChildren(...next);
        inner.classList.remove("is-fading");
      }, 180);
    } else inner.replaceChildren(...next);
    el.dataset.painted = "1";
  }

  async function load() {
    const [d, hist, otd, who] = await Promise.all([
      loadDay(today).catch(() => null),
      loadHealthDays(addDays(today, -14), addDays(today, -1)).catch(() => null),
      onThisDay(today).catch(() => []),
      seenToday(today).catch(() => []),
    ]);
    day = d;
    seen = who;
    before = (hist?.days ?? []).filter((x) => x.date < today && x.date >= addDays(today, -14));
    earlier = otd;
    paint();
  }

  // The phase moves on while the app stays open.
  const timer = setInterval(() => {
    const p = phaseAt(now());
    if (p !== phase && localToday(now()) === today) {
      phase = p;
      paint();
    }
  }, 5 * 60_000);

  // The folded habits' one line (evening only), kept current as they're ticked.
  const loadHabitsLine = () =>
    loadHabitsOn(today).then(
      (data) => {
        const next = habitsLine(data);
        if (next === habitsSummary) return;
        const had = habitsSummary;
        habitsSummary = next;
        if (phase !== "evening" || dead) return;
        // Only the fold's words change; a repaint would close the owner's box.
        const words = el.querySelector(".today-fold__line");
        if (words && next && had) words.textContent = next;
        else if (el.dataset.painted && (!el.querySelector(".today-fold") || !next)) paint();
      },
      () => undefined
    );
  const offHabits = onHabitsChange(() => void loadHabitsLine());
  // Today changed somewhere else (the live channel): it loads again, never under the caret and not for an echo of a save made here.
  const elsewhere = reloadWhenIdle(el, () => loadDay(today), (d) => {
    if (dead || !day || nothingNew(d, painted)) return;
    day = d;
    paint();
  });
  const offDays = onDaysChange((dates) => void ((!dates.length || dates.includes(today)) && elsewhere()));

  void load();
  void loadHabitsLine();
  return {
    el,
    destroy() {
      dead = true;
      clearInterval(timer);
      habits.destroy();
      checkins.destroy();
      offHabits();
      offDays();
    },
  };
}

function skeleton(): HTMLElement {
  return h(
    "div",
    { class: "today__sk", "aria-hidden": "true" },
    h("span", { class: "skeleton", style: "width:40%;height:12px" }),
    h("span", { class: "skeleton", style: "width:85%;height:26px" }),
    h("span", { class: "skeleton", style: "width:60%;height:64px" }),
    h("span", { class: "skeleton", style: "width:100%;height:58px" })
  );
}

