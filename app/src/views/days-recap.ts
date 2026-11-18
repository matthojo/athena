/**
 * A week or a month in review (#/days/week/<monday>, #/days/month/<YYYY-MM>),
 * built from the approved prototype (docs/notes/week-review.md) with the
 * owner's decisions of 2026-11-08. A headline from rules (lib/week-headline.ts,
 * no AI), then in order: people and places, what got done, health and habits
 * (mood is a tile there, with a strip of the period's days), looking ahead,
 * the patterns that fit, and last what was watched, read and listened to as
 * one shelf of covers, with the period's links as real links.
 *
 * The old weekly review (#/week) is retired; what it had that this lacked
 * moved in: Still open under What got done (tick them off right here), and
 * Catch up with plus renewals under Looking ahead. Both only for the period
 * holding today.
 *
 * The model is lib/week-review.ts; db/week-review.ts loads it. Offline it
 * shows what this device has and says what's missing.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { dayIcons } from "../components/day-icons";
import { artTile, initialsOf } from "../components/day-art";
import { addDays, capital, hoursMinutes, list, monthName, nextMonth, roughSteps, shortDate, weekdayShort } from "../components/day-words";
import { localToday } from "../lib/time";
import { failedCard, type DaysNav, type Mounted } from "./days";
import { loadPatterns } from "../db/patterns";
import { patternsBlock } from "../components/patterns-block";
import { loadWeekReview, type MissingPart } from "../db/week-review";
import { avg, buildModel, heldLine, heldWhen, moodName, reviewTitle, type AheadItem, type HabitRow, type HealthDay, type MoodSummary, type PersonSeen, type PlaceVisit, type ShelfItem, type WeekModel } from "../lib/week-review";
import { num } from "../lib/week-headline";
import { dueLabel } from "../components/loop-row";
import { openCommitmentSheet } from "../components/commitment-sheet";
import { setCommitmentStatus } from "../db/memory";
import { showToast } from "../components/toast";
import { hueFor } from "../lib/format";
import type { CatchUp, OpenItem } from "../lib/week-review";
import { keepWeekMoment, keptMomentsNow, loadWeekMoments } from "../db/week-moments";
import { keptToast, momentChoices, sameMoment, toMoment, type MomentChoice, type WeekMoment } from "../lib/week-moment";
import "../styles/week-review.css";
import "../styles/week-moment.css";
import { pageHead } from "../components/page-head";
import { loadSuggestions, resolveSuggestion } from "../db/memory";
import { firstWeekReviewLine } from "../lib/first-week";
import type { Suggestion } from "../types";
import type { Day } from "../db/days-app";
import "../styles/first-week.css";

/**
 * `first`: the owner's first week with Athena (#/days/week/<day one>?first=1,
 * linked from Home on day seven; lib/first-week.ts). The seven days from day
 * one, "Your first week with Athena", and what Athena picked up about the
 * owner, inline, to keep or not.
 */
export function renderRecap(kind: "week" | "month", key: string, nav: DaysNav, opts: { first?: boolean } = {}): Mounted {
  const first = kind === "week" && !!opts.first;
  const today = localToday();
  const from = kind === "week" ? key : `${key}-01`;
  const to = kind === "week" ? addDays(key, 6) : addDays(`${nextMonth(key)}-01`, -1);
  const prevKey = kind === "week" ? addDays(key, -7) : nextMonth(key, -1);
  const nextKey = kind === "week" ? addDays(key, 7) : nextMonth(key);
  const hasNext = (kind === "week" ? nextKey : `${nextKey}-01`) <= today;
  let dead = false;
  // An old #/week link landed here: show the address it lives at now.
  if (kind === "week" && /^#\/?week(\?|$)/.test(location.hash)) history.replaceState(history.state, "", `#/days/week/${key}`);

  const back = h("a", { class: "icon-btn icon-btn--ghost day-top__back", href: "#/days", "aria-label": "All days" }, icons.back());
  back.addEventListener("click", (e) => {
    e.preventDefault();
    if ((history.state as { daysFrom?: string } | null)?.daysFrom) history.back();
    else nav.to(null);
  });
  const step = (k: string, dir: "prev" | "next", enabled: boolean) => {
    const label = kind === "week" ? (dir === "prev" ? "Week before" : "Week after") : dir === "prev" ? "Month before" : "Month after";
    const icon = dir === "prev" ? dayIcons.chevronLeft() : dayIcons.chevronRight();
    const a = enabled ? h("a", { class: "icon-btn icon-btn--ghost", href: `#/days/${kind}/${k}`, "aria-label": label }, icon) : h("button", { class: "icon-btn icon-btn--ghost is-disabled", type: "button", disabled: true, "aria-label": label }, icon);
    if (enabled)
      a.addEventListener("click", (e) => {
        e.preventDefault();
        nav.to(`${kind}/${k}`, null, { replace: true, dir });
      });
    return a;
  };
  const top = pageHead({
    class: "day-top wr-head",
    rowClass: "day-top__bar",
    lead: back,
    title: kind === "week" ? "Week in review" : "Month in review",
    // The first week is one of a kind: no week before or after it.
    actions: first ? [] : [step(prevKey, "prev", true), step(nextKey, "next", hasNext)],
  });
  if (first) top.querySelector(".page-title")!.textContent = "Your first week with Athena";
  const page = h("div", { class: "wr-page", "aria-busy": "true" }, kicker(kind, from, to, today, first), h("div", { class: "wr-skeleton" }, h("span", { class: "skeleton day-sk day-sk--card" }), h("span", { class: "skeleton day-sk day-sk--shelf" })));
  const el = h("div", { class: "view days days--recap wr" }, top, page);

  const patterns = loadPatterns(90);
  async function load() {
    try {
      const r = await loadWeekReview(kind, from, to, today);
      if (dead) return;
      // Nothing at all on this device for the period: the same card as the rest of Days.
      if (r.missing.includes("days") && r.missing.includes("people") && r.missing.includes("done")) throw new Error("nothing to show");
      page.removeAttribute("aria-busy");
      const m = buildModel(r.input);
      const review = renderReview(m, r.missing, r.offline, { openPerson: (id) => nav.openLink("person", id) });
      if (first) await firstWeekOpening(review, m, r.input.days, () => dead);
      if (dead) return;
      // Last, after Looking ahead and the shelf: one quiet invitation to keep the week's moment (a Monday's week only).
      const picker = kind === "week" && !first ? momentPicker(from, momentChoices(r.input.days, from, to > today ? today : to), () => dead) : null;
      if (picker) review.append(picker);
      page.replaceChildren(review);
      // Patterns from the last 90 days, at most three, after Looking ahead; those this period fits first.
      void patterns.then((ps) => {
        const block = dead || r.missing.includes("days") ? null : patternsBlock(ps, { from, to, window: 90 });
        if (block) review.querySelector("#wr-sec-4")?.closest(".wr-sec")?.after(block);
      });
    } catch {
      if (dead) return;
      page.removeAttribute("aria-busy");
      page.replaceChildren(kicker(kind, from, to, today, first), failedCard(kind === "week" ? "this week" : "this month", () => void load()));
    }
  }
  void load();
  return { el, destroy: () => (dead = true) };
}

// ---------- The page ----------

const count = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const dow = (date: string) => weekdayShort(date);
const ico = (make: () => SVGSVGElement, cls = "wr-ico") => {
  const s = make();
  s.classList.add(...cls.split(" "));
  s.setAttribute("aria-hidden", "true");
  return s;
};

function kicker(kind: "week" | "month", from: string, to: string, today: string, first = false): HTMLElement {
  const span = kind === "week" ? `${shortDate(from)} to ${shortDate(to)}` : monthName(from.slice(0, 7));
  // The page's title already says Week (or Month) in review: the kicker is just when.
  return h("p", { class: "wr-hero__kicker" }, [first ? "First week" : null, span, to >= today ? "so far" : null].filter(Boolean).join(" · "));
}

// ---------- The first week ----------

/** About the owner, waiting in the Review inbox: what the learner (and the collections) picked up. */
const aboutYou = (s: Suggestion) => s.op === "fact" && s.payload.subject_kind === "me";

/** Whether a day has anything on it. */
const kept = (d: Day) => !!(d.mood || d.line || d.journal || d.photos.length || d.entries.length || d.health?.steps || d.health?.sleep_minutes);

/**
 * The first week's opening: "Your first week with Athena", the line ("Five
 * days kept, two people and three places. Here's what I picked up, if you
 * want to keep it."), then the learner's suggestions inline, each with Add it
 * and Not right, as in the Review inbox.
 */
async function firstWeekOpening(review: HTMLElement, m: WeekModel, days: Day[], gone: () => boolean): Promise<void> {
  const picks = await loadSuggestions().then(({ items }) => items.filter(aboutYou).slice(0, 6), () => [] as Suggestion[]);
  if (gone()) return;
  const end = m.to > m.today ? m.today : m.to;
  const daysKept = days.filter((d) => d.date >= m.from && d.date <= end && kept(d)).length;
  const hero = review.querySelector(".wr-hero");
  const k = hero?.querySelector(".wr-hero__kicker");
  if (k) k.textContent = ["First week", `${shortDate(m.from)} to ${shortDate(m.to)}`, m.sofar ? "so far" : null].filter(Boolean).join(" · ");
  const line = hero?.querySelector(".wr-hero__line");
  if (line) line.textContent = firstWeekReviewLine({ daysKept, people: m.people.length, places: m.places.length + m.trips.length, picked: picks.length > 0 });
  if (picks.length) hero?.after(picksBlock(picks));
}

function picksBlock(items: Suggestion[]): HTMLElement {
  const list = h("div", { class: "fw-picks__list", role: "list" });
  const block = h("section", { class: "fw-picks", "aria-labelledby": "fw-picks-title" }, h("h2", { class: "fw-picks__title", id: "fw-picks-title" }, "What I picked up"), list);
  let left = items.length;
  for (const s of items) {
    const add = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.check(), "Add it") as HTMLButtonElement;
    const no = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Not right") as HTMLButtonElement;
    const row = h(
      "div",
      { class: "fw-pick", role: "listitem" },
      h(
        "div",
        { class: "fw-pick__in" },
        h("p", { class: "fw-pick__summary" }, s.summary.replace(/^About you · /, "")),
        s.source_quote ? h("p", { class: "fw-pick__quote" }, `“${s.source_quote.replace(/^[“"]|[”"]$/g, "")}”`) : null,
        h("div", { class: "fw-pick__actions" }, no, add)
      )
    );
    const act = async (action: "accept" | "reject") => {
      add.disabled = no.disabled = true;
      row.classList.toggle("is-kept", action === "accept");
      try {
        await resolveSuggestion(s, action);
        showToast(action === "accept" ? "Kept, under About you" : "Dismissed. It won't come back.", { icon: action === "accept" ? "check" : "close" });
        // It holds a beat in its new colour, then folds away.
        setTimeout(() => row.classList.add("is-leaving"), reduced() ? 0 : 260);
        setTimeout(() => {
          row.remove();
          if (--left === 0) list.replaceWith(h("p", { class: "fw-picks__done" }, "All kept or set aside. You can change any of it in Settings, under About you."));
        }, reduced() ? 0 : 640);
      } catch (error) {
        add.disabled = no.disabled = false;
        row.classList.remove("is-kept");
        showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff", timeoutMs: 4000 });
      }
    };
    add.addEventListener("click", () => void act("accept"));
    no.addEventListener("click", () => void act("reject"));
    list.append(row);
  }
  return block;
}

/** What an offline page doesn't have, in words. */
const MISSING_WORDS: Record<MissingPart, string[]> = {
  days: ["Health, habits, places and media"],
  extras: ["Goals moved on", "Calendar catch-ups", "First visits"],
  people: ["Logged catch-ups"],
  done: ["To-dos and decisions"],
  trips: ["Trips"],
  events: ["The diary"],
};

function missingNote(offline: boolean, missing: MissingPart[]): HTMLElement | null {
  if (!offline && !missing.length) return null;
  return h(
    "div",
    { class: "wr-missing", role: "status" },
    ico(icons.wifiOff),
    h("p", {}, "You're offline, so this is what this device kept.", ...(missing.length ? [h("br"), `Not here yet: ${missing.flatMap((m) => MISSING_WORDS[m]).join(" · ")}.`] : []))
  );
}

export interface ReviewActions {
  openPerson?: (id: string) => void;
}

export function renderReview(m: WeekModel, missing: MissingPart[] = [], offline = false, actions: ReviewActions = {}): HTMLElement {
  const word = m.period === "week" ? "week" : "month";
  return h(
    "article",
    { class: `wr-review wr-review--${m.period}`, "aria-labelledby": "wr-title" },
    hero(m),
    missingNote(offline, missing),
    section(1, "People and places", peopleSummary(m), peopleAndPlaces(m, missing.includes("days"))),
    section(2, "What got done", doneSummary(m), whatGotDone(m)),
    section(3, "Health and habits", healthSummary(m), healthAndHabits(m)),
    section(4, "Looking ahead", m.ahead.length ? `${m.period === "week" ? "The next seven days" : "The next two weeks"}: ${count(m.ahead.length, "thing")}` : "Nothing in the diary yet", lookingAhead(m, actions)),
    media(m, word)
  );
}

/**
 * The date span and the headline. No tally of numbers: each section's own
 * line says its count in words ("Three people, four places and one trip").
 */
function hero(m: WeekModel): HTMLElement {
  return h(
    "header",
    { class: "wr-hero" },
    h("p", { class: "wr-hero__kicker" }, [m.period === "week" ? `${shortDate(m.from)} to ${shortDate(m.to)}` : reviewTitle(m.period, m.from, m.today), m.sofar ? "so far" : null].filter(Boolean).join(" · ")),
    h("h2", { class: "wr-hero__line", id: "wr-title" }, m.headline.text)
  );
}

function section(n: number, title: string, summary: string, body: HTMLElement): HTMLElement {
  const id = `wr-sec-${n}`;
  return h(
    "section",
    { class: "wr-sec", "aria-labelledby": id },
    h("div", { class: "wr-sec__rail" }, h("span", { class: "wr-sec__n", "aria-hidden": "true" }, String(n).padStart(2, "0")), h("h2", { class: "wr-sec__title", id }, title), h("p", { class: "wr-sec__sum" }, summary)),
    h("div", { class: "wr-sec__body" }, body)
  );
}

const quiet = (text: string) => h("p", { class: "wr-quiet" }, text);
const sub = (text: string, extra?: HTMLElement | null) => h("h3", { class: "wr-sub" }, text, extra ?? null);

// ---------- 1. People and places ----------

function peopleSummary(m: WeekModel): string {
  const bits = [m.people.length ? count(m.people.length, "person", "people") : "No one logged", m.places.length ? count(m.places.length, "place") : null, m.trips.length ? count(m.trips.length, "trip") : null].filter(Boolean) as string[];
  return capital(list(bits));
}

function peopleAndPlaces(m: WeekModel, noDays = false): HTMLElement {
  const wrap = h("div", { class: "wr-stack" });
  for (const t of m.trips) {
    wrap.append(
      h(
        "div",
        { class: "wr-trip" },
        h("span", { class: "wr-trip__icon" }, ico(icons.plane)),
        h("span", { class: "wr-trip__body" }, h("span", { class: "wr-trip__kicker" }, "Trip"), h("span", { class: "wr-trip__title" }, t.place), h("span", { class: "wr-trip__meta" }, `${dow(t.from)} ${shortDate(t.from)} to ${dow(t.to)} ${shortDate(t.to)} · ${count(t.days, "day")}`)),
        t.bits.length ? h("span", { class: "wr-trip__bits" }, t.bits.slice(0, 3).join(" · ")) : null
      )
    );
  }
  wrap.append(m.people.length ? h("ul", { class: "wr-people", role: "list" }, ...m.people.map((p) => personCard(p, m))) : quiet(`No one in your catch-ups or calendar this ${m.period}.`));
  if (m.places.length) {
    wrap.append(sub("Where you went"), h("ul", { class: "wr-places", role: "list" }, ...m.places.slice(0, m.period === "week" ? 6 : 8).map((p) => placeRow(p, m))));
  } else if (!noDays) wrap.append(quiet("Only home and work."));
  return wrap;
}

function personCard(p: PersonSeen, m: WeekModel): HTMLElement {
  const when = m.period === "week" ? list([...p.dates].reverse().map(dow)) : p.dates.length > 1 ? count(p.dates.length, "time") : shortDate(p.dates[0]);
  return h(
    "li",
    { class: `wr-person${p.inPerson ? " is-in-person" : ""}` },
    h("span", { class: "wr-person__avatar", "aria-hidden": "true" }, initialsOf(p.name)),
    h(
      "span",
      { class: "wr-person__body" },
      h("span", { class: "wr-person__head" }, h("span", { class: "wr-person__name" }, p.name), h("span", { class: "wr-person__when" }, `${p.how} · ${when}`)),
      p.summary ? h("span", { class: "wr-person__summary" }, p.summary) : null,
      p.where ? h("span", { class: "wr-person__where" }, ico(icons.pin, "wr-ico wr-ico--xs"), p.where) : null
    )
  );
}

function placeRow(p: PlaceVisit, m: WeekModel): HTMLElement {
  const days = m.period === "week" ? h("span", { class: "wr-dots", "aria-hidden": "true" }, ...m.health.map((d) => h("span", { class: `wr-dot${p.dates.includes(d.date) ? " is-on" : ""}` }))) : null;
  const when = m.period === "week" ? list(p.dates.map(dow)) : count(p.dates.length, "visit");
  return h(
    "li",
    { class: "wr-place" },
    h("span", { class: "wr-place__icon" }, ico(icons.pin)),
    h("span", { class: "wr-place__body" }, h("span", { class: "wr-place__name" }, p.name, p.isNew ? h("span", { class: "wr-badge" }, "First visit") : null), h("span", { class: "wr-place__meta" }, when)),
    days
  );
}

// ---------- 2. What got done ----------

function doneSummary(m: WeekModel): string {
  const bits = [m.todos.length ? count(m.todos.length, "to-do") : null, m.meetings.length ? count(m.meetings.length, "meeting") : null, m.decisions.length ? count(m.decisions.length, "decision") : null].filter(Boolean) as string[];
  return bits.length ? capital(list(bits)) : "Nothing logged";
}

function whatGotDone(m: WeekModel): HTMLElement {
  const wrap = h("div", { class: "wr-stack" });
  const tiles: [number, string][] = [
    [m.todos.length, m.todos.length === 1 ? "to-do done" : "to-dos done"],
    [m.meetings.length, m.meetings.length === 1 ? "meeting" : "meetings"],
    [m.decisions.length, m.decisions.length === 1 ? "decision" : "decisions"],
    [m.goals.length, m.goals.length === 1 ? "goal moved on" : "goals moved on"],
  ];
  wrap.append(h("dl", { class: "wr-figures" }, ...tiles.map(([n, label]) => h("div", { class: `wr-figure${n ? "" : " is-zero"}` }, h("dt", { class: "wr-figure__label" }, label), h("dd", { class: "wr-figure__n" }, String(n))))));

  const cols = h("div", { class: "wr-cols" });
  const left = h("div", { class: "wr-col" });
  if (m.todos.length) {
    const shown = m.todos.slice(0, m.period === "week" ? 6 : 8);
    left.append(
      sub("Ticked off"),
      h("ul", { class: "wr-ticks", role: "list" }, ...shown.map((t) => h("li", { class: "wr-tick" }, h("span", { class: "wr-tick__box" }, ico(icons.check, "wr-ico wr-ico--xs")), h("span", { class: "wr-tick__title" }, t.title), h("span", { class: "wr-tick__when" }, m.period === "week" ? dow(t.date) : shortDate(t.date)))))
    );
    if (m.todos.length > shown.length) left.append(h("p", { class: "wr-more" }, `and ${num(m.todos.length - shown.length)} more`));
  } else left.append(quiet("Nothing ticked off."));
  if (m.meetings.length) {
    const titles = new Map<string, number>();
    for (const x of m.meetings) titles.set(x.title, (titles.get(x.title) ?? 0) + 1);
    left.append(sub("Meetings"), h("p", { class: "wr-meetings" }, [...titles].slice(0, 6).map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(" · ") + (titles.size > 6 ? ` · and ${num(titles.size - 6)} more` : "")));
  }
  cols.append(left);

  const right = h("div", { class: "wr-col" });
  if (m.decisions.length)
    right.append(
      sub("Decided"),
      ...m.decisions.map((d) => h("figure", { class: "wr-decision" }, h("blockquote", { class: "wr-decision__title" }, d.title), d.note ? h("p", { class: "wr-decision__note" }, d.note) : null, h("figcaption", { class: "wr-decision__by" }, [d.person ? `With ${d.person}` : null, m.period === "week" ? dow(d.date) : shortDate(d.date)].filter(Boolean).join(" · "))))
    );
  if (m.goals.length)
    right.append(
      sub("Goals"),
      h(
        "ul",
        { class: "wr-goals", role: "list" },
        ...m.goals.map((g) => {
          const bar = h("span", { class: "wr-goal__bar", role: "img", "aria-label": `${g.progress}%, up ${g.delta} this ${m.period}` }, h("span", { class: "wr-goal__was" }), h("span", { class: "wr-goal__gain" }));
          bar.style.setProperty("--was", `${g.progress - g.delta}%`);
          bar.style.setProperty("--now", `${g.progress}%`);
          return h("li", { class: "wr-goal" }, h("span", { class: "wr-goal__head" }, h("span", { class: "wr-goal__title" }, g.title), h("span", { class: "wr-goal__pct" }, `${g.progress}%`, h("span", { class: "wr-goal__delta" }, ` +${g.delta}`))), bar, g.target ? h("span", { class: "wr-goal__target" }, g.target) : null);
        })
      )
    );
  if (right.childElementCount) cols.append(right);
  wrap.append(cols);
  if (m.sofar && m.from <= m.today) wrap.append(stillOpen(m));
  return wrap;
}

/** Still open (from the old weekly review): the tally, then the first six, each ticked off right here. */
function stillOpen(m: WeekModel): HTMLElement {
  const block = h("div", { class: "wr-open" });
  const { overdue, forOthers, waiting } = m.openTally;
  block.append(sub("Still open", h("span", { class: "wr-sub__meta" }, m.open.length ? String(m.open.length) : "")));
  if (!m.open.length) {
    block.append(quiet("Nothing open. A clean slate for next week."));
    return block;
  }
  const tally = [overdue ? h("span", { class: "wr-tally__bit", "data-tone": "late" }, `${num(overdue)} overdue`) : null, forOthers ? h("span", { class: "wr-tally__bit" }, `${num(forOthers)} for other people`) : null, waiting ? h("span", { class: "wr-tally__bit" }, `${num(waiting)} waiting on other people`) : null].filter(Boolean) as HTMLElement[];
  if (tally.length) block.append(h("p", { class: "wr-tally" }, ...tally));
  const shown = m.open.slice(0, 6);
  block.append(h("ul", { class: "wr-opens", role: "list" }, ...shown.map((o) => openRow(o, m.today))));
  if (m.open.length > shown.length) block.append(h("a", { class: "wr-more wr-more--link", href: "#/loops" }, `See all ${num(m.open.length)} in To do`, ico(dayIcons.chevronRight, "wr-ico wr-ico--xs")));
  return block;
}

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function openRow(o: OpenItem, today: string): HTMLElement {
  const due = o.due ? dueLabel(o.due, today) : null;
  const meta = [due ? h("span", { class: "wr-open__due", "data-tone": due.tone || undefined }, due.text) : null, o.relation ? h("span", { class: "wr-open__rel" }, o.relation) : null].filter(Boolean) as HTMLElement[];
  const body = h("button", { class: "wr-open__body", type: "button" }, h("span", { class: "wr-open__title" }, o.title), meta.length ? h("span", { class: "wr-open__meta" }, ...meta) : null);
  body.addEventListener("click", () => openCommitmentSheet(o.commitment));
  const box = h("button", { class: "wr-open__box", type: "button", role: "checkbox", "aria-checked": "false", "aria-label": `Mark “${o.title}” done` }, h("span", { class: "wr-open__mark", "aria-hidden": "true" }, ico(icons.check, "wr-ico wr-ico--xs"))) as HTMLButtonElement;
  const row = h("li", { class: "wr-open-row" }, h("div", { class: "wr-open-row__in" }, box, body));

  // Tick: the box fills and the title strikes, the row holds a moment, then folds away. Undo brings it back.
  const set = (state: "open" | "done" | "gone") => {
    row.dataset.state = state;
    box.setAttribute("aria-checked", String(state !== "open"));
  };
  box.addEventListener("click", () => {
    if (row.dataset.state) return;
    box.disabled = true;
    set("done");
    setTimeout(
      async () => {
        try {
          await setCommitmentStatus(o.commitment, "done");
          set("gone");
          showToast(`Done: ${o.title}`, {
            icon: "check",
            action: {
              label: "Undo",
              run: () =>
                void setCommitmentStatus(o.commitment, "open")
                  .then(() => {
                    delete row.dataset.state;
                    box.setAttribute("aria-checked", "false");
                    box.disabled = false;
                  })
                  .catch(() => showToast("Couldn't undo", { icon: "wifiOff" })),
            },
          });
        } catch (error) {
          delete row.dataset.state;
          box.setAttribute("aria-checked", "false");
          box.disabled = false;
          showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
        }
      },
      reduced() ? 0 : 600
    );
  });
  return row;
}

// ---------- 3. Health and habits ----------

function healthSummary(m: WeekModel): string {
  const sleep = avg(m.health.map((d) => d.sleep));
  const steps = avg(m.health.map((d) => d.steps));
  const bits = [sleep ? `${hoursMinutes(sleep)} sleep a night` : null, steps ? `about ${roughSteps(steps)} steps a day` : null].filter(Boolean) as string[];
  return bits.length ? capital(list(bits)) : "No health data this time";
}

function healthAndHabits(m: WeekModel): HTMLElement {
  const wrap = h("div", { class: "wr-stack" });
  const sleep = avg(m.health.map((d) => d.sleep));
  const steps = avg(m.health.map((d) => d.steps));
  const km = m.workouts.reduce((a, w) => a + (w.km ?? 0), 0);
  const tiles = h(
    "div",
    { class: "wr-tiles" },
    tile("Sleep", ico(icons.bed), sleep ? hoursMinutes(sleep) : "None", "a night on average", bars(m.health, (d) => d.sleep, 600, (d) => (d.sleep ? hoursMinutes(d.sleep) : "no data"))),
    tile("Steps", ico(dayIcons.steps), steps ? roughSteps(steps) : "None", "a day on average", bars(m.health, (d) => d.steps, 16000, (d) => (d.steps ? `${roughSteps(d.steps)} steps` : "no data"))),
    tile("Workouts", ico(icons.flag), String(m.workouts.length), m.workouts.length ? [list([...new Set(m.workouts.map((w) => w.type.toLowerCase()))]), km >= 1 ? `${Math.round(km)} km` : null].filter(Boolean).join(", ") : "none logged", m.period === "week" ? strip(m.health, (d) => !!d.workout) : null),
    moodTile(m.mood, m.period)
  );
  wrap.append(tiles);

  if (m.habits.length) {
    // What held, by name: never a percentage (docs/notes/affection-2026-11.md, moment 6).
    const held = heldLine(m.habits, m.from);
    wrap.append(sub("Habits"));
    if (held) wrap.append(h("p", { class: "wr-held" }, held));
    wrap.append(m.period === "week" ? habitGrid(m.habits, m.health) : habitBars(m.habits, m.from));
  }
  return wrap;
}

function tile(label: string, icon: SVGSVGElement, value: string, caption: string, chart: HTMLElement | null, extra = ""): HTMLElement {
  return h("div", { class: `wr-tile${extra}` }, h("span", { class: "wr-tile__label" }, icon, label), value ? h("span", { class: "wr-tile__value" }, value) : null, h("span", { class: "wr-tile__caption" }, caption), chart);
}

/** The Mood tile: the period's usual mood in a word, how many days it was set, and a strip of the days. */
function moodTile(mood: MoodSummary, period: WeekModel["period"]): HTMLElement {
  const strip = h(
    "span",
    { class: `wr-moods${period === "month" ? " wr-moods--dense" : ""}`, role: "img", "aria-label": mood.cells.filter((c) => !c.future).map((c) => c.title).join(", ") },
    ...mood.cells.map((c) => h("span", { class: `wr-mood${c.mood ? ` wr-mood--${c.mood}` : ""}${c.future ? " is-future" : ""}`, title: c.title }))
  );
  // With no mood set, say it once (docs/notes/affection-2026-11.md, voice fix 4).
  if (!mood.set) return tile("Mood", ico(icons.heart), "", `No moods this ${period}`, strip, " wr-tile--mood");
  return tile("Mood", ico(icons.heart), moodName(mood.average) ?? "", `set on ${count(mood.set, "day")}`, strip, " wr-tile--mood");
}

function bars(days: HealthDay[], value: (d: HealthDay) => number | undefined, max: number, label: (d: HealthDay) => string): HTMLElement {
  const desc = days.filter((d) => !d.future).map((d) => `${dow(d.date)} ${label(d)}`).join(", ");
  return h(
    "span",
    { class: `wr-bars${days.length > 10 ? " wr-bars--dense" : ""}`, role: "img", "aria-label": desc },
    ...days.map((d) => {
      const v = value(d);
      const b = h("span", { class: `wr-bar${v ? "" : " is-empty"}${d.future ? " is-future" : ""}` });
      b.style.setProperty("--h", `${v ? Math.max(8, Math.min(100, (v / max) * 100)) : 4}%`);
      return b;
    })
  );
}

function strip(days: HealthDay[], on: (d: HealthDay) => boolean): HTMLElement {
  return h("span", { class: "wr-strip", "aria-hidden": "true" }, ...days.map((d) => h("span", { class: `wr-strip__day${on(d) ? " is-on" : ""}${d.future ? " is-future" : ""}` }, dow(d.date).slice(0, 1))));
}

/** A week of habits: a filled day for each done, and nothing drawn for the rest (no empty boxes, no tally). */
function habitGrid(rows: HabitRow[], days: HealthDay[]): HTMLElement {
  return h(
    "div",
    { class: "wr-habits wr-habits--held", role: "table", "aria-label": "Habits by day" },
    h("div", { class: "wr-habits__row wr-habits__row--head", role: "row" }, h("span", { class: "wr-habits__name", role: "columnheader" }, h("span", { class: "visually-hidden" }, "Habit")), ...days.map((d) => h("span", { class: "wr-habits__dow", role: "columnheader" }, dow(d.date).slice(0, 1)))),
    ...rows.map((r) =>
      h(
        "div",
        { class: "wr-habits__row", role: "row" },
        h("span", { class: "wr-habits__name", role: "rowheader" }, r.name),
        ...r.days.map((x, i) => {
          const cell = h("span", { class: `wr-habit${x === true ? " is-done" : ""}`, role: "cell", "aria-label": `${dow(days[i].date)}: ${x === true ? "done" : "no entry"}` });
          cell.style.setProperty("--i", String(i));
          return cell;
        })
      )
    )
  );
}

/** A month of habits: a bar for each, and when it was done in the week tile's words ("on 12 days"), never "n of m". */
function habitBars(rows: HabitRow[], from: string): HTMLElement {
  return h(
    "ul",
    { class: "wr-habitbars", role: "list" },
    ...rows.map((r) => {
      const pct = Math.round((r.kept / Math.max(r.due, 1)) * 100);
      const bar = h("span", { class: "wr-habitbar__bar", "aria-hidden": "true" }, h("span", { class: "wr-habitbar__fill" }));
      bar.style.setProperty("--pct", `${pct}%`);
      return h("li", { class: "wr-habitbar" }, h("span", { class: "wr-habitbar__name" }, r.name), bar, h("span", { class: "wr-habitbar__n" }, heldWhen(r, from)));
    })
  );
}

// ---------- 4. Looking ahead ----------

const AHEAD: Record<AheadItem["kind"], { label: string; icon: () => SVGSVGElement }> = {
  travel: { label: "Travel", icon: icons.plane },
  birthday: { label: "Birthday", icon: icons.gift },
  event: { label: "Event", icon: icons.calendar },
  deadline: { label: "Deadline", icon: icons.flag },
  due: { label: "Due", icon: icons.check },
  renewal: { label: "Life admin", icon: icons.shield },
};

function lookingAhead(m: WeekModel, actions: ReviewActions = {}): HTMLElement {
  const diary = diaryAhead(m);
  if (!m.catchUps.length) return diary;
  return h("div", { class: "wr-stack" }, diary, sub("Catch up with", h("span", { class: "wr-sub__meta" }, "Past their usual gap")), h("ul", { class: "wr-catchups", role: "list" }, ...m.catchUps.map((p) => catchUpRow(p, actions))));
}

/** One person past their catch-up: initials on their own hue, the name, and how long it's been. */
function catchUpRow(p: CatchUp, actions: ReviewActions): HTMLElement {
  const since = p.since === null ? "Not logged yet" : p.since >= 60 ? `Last spoke ${num(Math.round(p.since / 30))} months ago` : `Last spoke ${num(p.since)} days ago`;
  const inner = [h("span", { class: "wr-catchup__avatar", "aria-hidden": "true" }, initialsOf(p.name)), h("span", { class: "wr-catchup__body" }, h("span", { class: "wr-catchup__name" }, p.name), h("span", { class: "wr-catchup__since" }, since))];
  const el = actions.openPerson ? h("button", { class: "wr-catchup", type: "button" }, ...inner) : h("span", { class: "wr-catchup" }, ...inner);
  el.style.setProperty("--h", String(hueFor(p.name)));
  if (actions.openPerson) el.addEventListener("click", () => actions.openPerson!(p.id));
  return h("li", {}, el);
}

function diaryAhead(m: WeekModel): HTMLElement {
  if (!m.ahead.length) return quiet("Nothing booked or due.");
  const byDate = new Map<string, AheadItem[]>();
  for (const a of m.ahead) byDate.set(a.date, [...(byDate.get(a.date) ?? []), a]);
  return h(
    "ol",
    { class: "wr-ahead", role: "list" },
    ...[...byDate].map(([date, items]) =>
      h(
        "li",
        { class: "wr-ahead__day" },
        h("span", { class: "wr-date", "aria-label": `${weekdayShort(date)} ${shortDate(date)}` }, h("span", { class: "wr-date__dow" }, weekdayShort(date)), h("span", { class: "wr-date__n" }, String(Number(date.slice(8))))),
        h(
          "ul",
          { class: "wr-ahead__items", role: "list" },
          ...items.map((a) => h("li", { class: `wr-ahead__item wr-ahead__item--${a.kind}` }, h("span", { class: "wr-ahead__icon" }, ico(AHEAD[a.kind].icon)), h("span", { class: "wr-ahead__body" }, h("span", { class: "wr-ahead__title" }, a.title), h("span", { class: "wr-ahead__meta" }, [AHEAD[a.kind].label, a.detail].filter(Boolean).join(" · ")))))
        )
      )
    )
  );
}

// ---------- After: watched, read and listened, then links ----------

const SHELF_LABEL: Record<ShelfItem["kind"], string> = { watched: "Watched", read: "Read", listened: "Listened" };

function media(m: WeekModel, word: string): HTMLElement | null {
  if (!m.shelf.length && !m.links.length && !m.nights) return null;
  const kinds = list([...new Set(m.shelf.map((s) => SHELF_LABEL[s.kind].toLowerCase()))]);
  const sum = [kinds ? capital(kinds) : "", m.nights ?? ""].filter(Boolean).join(" · ");
  const wrap = h("section", { class: "wr-media", "aria-labelledby": "wr-media-title" }, h("div", { class: "wr-media__head" }, h("h2", { class: "wr-media__title", id: "wr-media-title" }, `Also this ${word}`), sum ? h("p", { class: "wr-media__sum" }, sum) : null));
  if (m.shelf.length) wrap.append(h("ul", { class: "wr-shelf", role: "list" }, ...m.shelf.map(cover)));
  if (m.links.length)
    wrap.append(
      h("h3", { class: "wr-sub" }, "Links"),
      h(
        "ul",
        { class: "wr-links", role: "list" },
        ...m.links.map((l) => h("li", {}, h("a", { class: "wr-link", href: l.url, target: "_blank", rel: "noopener noreferrer" }, h("span", { class: "wr-link__icon" }, ico(icons.link, "wr-ico wr-ico--xs")), h("span", { class: "wr-link__title" }, l.title), h("span", { class: "wr-link__meta" }, `${l.via} · ${l.host}`), ico(icons.external, "wr-ico wr-ico--xs wr-link__out"))))
      )
    );
  return wrap;
}

function cover(s: ShelfItem): HTMLElement {
  const shape: [number, number] = s.kind === "listened" ? [1, 1] : [2, 3];
  const inner = [artTile(s.art, { frame: shape, initials: initialsOf(s.title), className: "wr-cover__art" }), h("span", { class: "wr-cover__kind" }, SHELF_LABEL[s.kind]), h("span", { class: "wr-cover__title" }, s.title), h("span", { class: "wr-cover__sub" }, s.sub)];
  const body = s.url ? h("a", { class: "wr-cover__in", href: s.url, target: "_blank", rel: "noopener noreferrer" }, ...inner) : h("span", { class: "wr-cover__in" }, ...inner);
  return h("li", { class: `wr-cover wr-cover--${s.kind}` }, body);
}

// ---------- Last: this week's moment ----------

/**
 * "Pick this week's moment": a row of the week's photos, covers and lines.
 * Tapping one keeps it as the week's cover in the Days feed and month view
 * (db/week-moments.ts), with a toast that names it and an Undo. One line, no
 * badge, nothing to finish: a week without a moment is complete as it is.
 * With nothing to choose from, there's no invitation at all.
 */
function momentPicker(monday: string, choices: MomentChoice[], gone: () => boolean): HTMLElement | null {
  if (!choices.length) return null;
  let kept: WeekMoment | null = keptMomentsNow()[monday] ?? null;
  let busy = false;
  const title = h("h2", { class: "wm__title", id: "wm-title" });
  const row = h("ul", { class: "wm__row", role: "radiogroup", "aria-labelledby": "wm-title" });
  const buttons = choices.map((c, i) => {
    const b = h(
      "button",
      { class: `wm-choice wm-choice--${c.kind}`, type: "button", role: "radio", "aria-checked": "false", "aria-label": c.title, tabindex: "-1" },
      h("span", { class: "wm-choice__face" }, ...choiceFace(c), h("span", { class: "wm-choice__mark", "aria-hidden": "true" }, ico(icons.check, "wr-ico wr-ico--xs"))),
      // Which day, and what it is: the tiles alone don't say.
      h("span", { class: "wm-choice__cap", "aria-hidden": "true" }, h("span", { class: "wm-choice__when" }, c.day), h("span", { class: "wm-choice__what" }, c.what))
    ) as HTMLButtonElement;
    b.style.setProperty("--i", String(Math.min(i, 8)));
    b.addEventListener("click", () => void choose(c, b));
    row.append(h("li", { class: "wm__item" }, b));
    return b;
  });

  const paint = (justKept?: HTMLButtonElement) => {
    title.textContent = kept ? "This week's moment" : "Pick this week's moment";
    section.classList.toggle("has-kept", !!kept);
    let focus = 0;
    buttons.forEach((b, i) => {
      const on = sameMoment(kept, choices[i]);
      b.setAttribute("aria-checked", String(on));
      b.classList.toggle("is-kept", on);
      if (on) focus = i;
    });
    buttons.forEach((b, i) => (b.tabIndex = i === focus ? 0 : -1));
    if (justKept) {
      justKept.classList.remove("is-keeping");
      void justKept.offsetWidth;
      justKept.classList.add("is-keeping");
    }
  };

  async function choose(c: MomentChoice, b: HTMLButtonElement) {
    if (busy || sameMoment(kept, c)) return;
    busy = true;
    const before = kept;
    kept = toMoment(c);
    paint(b);
    try {
      await keepWeekMoment(monday, kept);
      showToast(keptToast(monday, c), {
        icon: "bookmark",
        action: {
          label: "Undo",
          run: () =>
            void keepWeekMoment(monday, before)
              .then(() => {
                kept = before;
                if (!gone()) paint();
              })
              .catch(() => showToast("Couldn't undo", { icon: "wifiOff" })),
        },
      });
    } catch {
      kept = before;
      if (!gone()) paint();
      showToast("Couldn't keep it. Try again when you're online.", { icon: "wifiOff", timeoutMs: 4000 });
    } finally {
      busy = false;
    }
  }

  // One tab stop; arrows move along the row, as in any radio group.
  row.addEventListener("keydown", (e) => {
    const at = buttons.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, to))];
    buttons.forEach((x) => (x.tabIndex = x === next ? 0 : -1));
    next.focus();
    next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced() ? "auto" : "smooth" });
  });

  const section = h("section", { class: "wm", "aria-labelledby": "wm-title" }, title, h("div", { class: "wm__scroll" }, row));
  paint();
  // Another device may have kept one: the server's answer wins once it comes.
  void loadWeekMoments().then((all) => {
    const theirs = all[monday] ?? null;
    if (gone() || busy || sameMoment(theirs, kept) || (!theirs && !kept)) return;
    kept = theirs;
    paint();
  });
  return section;
}

/** What a choice looks like: the photo or cover itself, or the day's line in its own words. */
function choiceFace(c: MomentChoice): HTMLElement[] {
  // A line is a small text card quoting it, not art.
  if (c.kind === "line") return [h("blockquote", { class: "wm-choice__quote" }, h("span", { class: "wm-choice__line" }, c.text ?? ""))];
  // Photos stand as portraits; albums are square and posters and books 2:3, as on the shelf.
  const square = !!c.art && Math.abs(c.art.w / c.art.h - 1) < 0.1;
  const shape: [number, number] = c.kind === "photo" ? [3, 4] : square ? [1, 1] : [2, 3];
  return [artTile(c.art, { frame: shape, photo: c.kind === "photo" ? "thumb" : undefined, className: "wm-choice__art" })];
}
