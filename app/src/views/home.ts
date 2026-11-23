/**
 * Home: a greeting by name and a sentence instead of a KPI row, today's
 * briefing when there is one, then a bento (to do, the latest note, and
 * what's coming up: birthdays, events, overdue catch-ups). Below it the
 * personal half: the people who matter most and a line on a goal, from the
 * owner's profile (components/home-personal.ts), then recent notes. Meeting
 * hours live in Week in review and sources in Settings. Notes come from the
 * shared store (db/data.ts). The staggered entrance plays once per session,
 * not on every tab switch or background refresh.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { brandMark } from "../components/brand-mark";
import { noteParts, noteRow, TYPE_ICON } from "../components/note-row";
import { onNotes } from "../db/data";
import { loadUpcoming, onRecordsChange } from "../db/records";
import { onLive } from "../live";
import { headlineEvent, headlineEventWords } from "../lib/headline-event";
import { localToday } from "../lib/time";
import { dayHref } from "../lib/day-link";
import type { ComingUpLogistics } from "../lib/coming-up-trips";
import { groupLoops, loadAssets, loadCommitments, loadSuggestions, onMemoryChange, openLoops, renewals, weekStartOf } from "../db/memory";
import { loopRow } from "../components/loop-row";
import { openCommitmentSheet } from "../components/commitment-sheet";
import { countWord, dayLabel, formatDateHeading, greeting, hueFor, initials, plural, relativeTime } from "../lib/format";
import { ASSET_META, renewalLabel } from "../lib/memory-meta";
import { describeSource } from "../lib/sources";
import type { Commitment, EntityKind, Note, Renewal, Upcoming, UpcomingItem } from "../types";
import type { ViewId } from "../components/nav";
import { profileSetupCard } from "../components/profile-card";
import { accountsNoticeCard } from "../components/accounts-notice";
import { homePersonal, rememberedName } from "../components/home-personal";
import { pageHead } from "../components/page-head";
import { phaseAt } from "../components/day-words";
import { briefingFrame } from "../lib/briefing-frame";
import { isSampleMode } from "../db/api";
import { changeSetup, loadSetup, saveProfile } from "../db/profile";
import { profileControl } from "../components/profile-inputs";
import { openProfileWizard } from "../components/profile-wizard";
import { showToast } from "../components/toast";
import { ATHENA_HELLO, NAME_QUESTION, firstWeekCard, firstWeekDay, firstWeekStart, yesterdayPage, type FirstWeekAction, type FirstWeekFacts } from "../lib/first-week";
import { homeAsk } from "../components/home-ask";
import { newNoteButton } from "../components/new-note-button";
import "../styles/moments.css";
import "../styles/first-week.css";

export interface HomeContext {
  openNote: (note: Note) => void;
  openLink: (kind: EntityKind, id: string) => void;
  goNotes: (source: string | null) => void;
  go: (view: ViewId) => void;
  /** A trip or purchase from Coming up (a sheet on a phone, the page on desktop). */
  openTrip: (id: string) => void;
  openPurchase: (id: string) => void;
  compose: () => void;
  statusEl: HTMLElement;
}

let introPlayed = false;

const bar = (w: string, hgt = "12px") => h("div", { class: "skeleton", style: `width:${w};height:${hgt}` });

/** The small line icon that leads a card heading. */
const headingIcon = (name: IconName) => h("span", { class: "heading-icon", "aria-hidden": "true" }, icons[name]());

function stack(...children: (Node | null)[]) {
  return h("div", { style: "display:flex;flex-direction:column;gap:8px" }, ...children);
}

/** At most this many rows of dates in Coming up, before catch-ups. */
const COMING_UP_ROWS = 6;

type ComingUpRow = { kind: "event"; o: UpcomingItem } | { kind: "day"; day: string; days_until: number; list: UpcomingItem[] } | { kind: "more"; count: number };

/**
 * This week, sized to how busy it is. A quiet week lists everything. A busy
 * one keeps the dates you added (birthdays, appointments) one per row, folds
 * a day's calendar events into a single "4 calendar events" row, and ends
 * with "+N more this week" once the card is full.
 */
export function planComingUp(events: UpcomingItem[], max = COMING_UP_ROWS): ComingUpRow[] {
  if (events.length <= max) return events.map((o) => ({ kind: "event", o }));
  const rows: ComingUpRow[] = [];
  const byDay = new Map<string, UpcomingItem[]>();
  for (const o of events) byDay.set(o.occurs_on, [...(byDay.get(o.occurs_on) ?? []), o]);
  for (const [day, list] of byDay) {
    const synced = list.filter((o) => o.event.source);
    for (const o of list.filter((x) => !x.event.source)) rows.push({ kind: "event", o });
    if (synced.length === 1) rows.push({ kind: "event", o: synced[0] });
    else if (synced.length > 1) rows.push({ kind: "day", day, days_until: synced[0].days_until, list: synced });
  }
  if (rows.length <= max) return rows;
  const shown = rows.slice(0, max - 1);
  const shownCount = shown.reduce((n, r) => n + (r.kind === "day" ? r.list.length : 1), 0);
  return [...shown, { kind: "more", count: events.length - shownCount }];
}

/** Trips and parcels in Coming up: lib/coming-up-trips.ts, loaded after Home's first paint. */
interface Logistics {
  data: ComingUpLogistics | null;
  openTrip: (id: string) => void;
  openPurchase: (id: string) => void;
}

/** Coming up: this week's travel and deliveries, its dates, renewals in the next fortnight, then who's overdue a catch-up. */
function comingUpBody(
  up: Upcoming,
  due: Renewal[],
  open: (kind: EntityKind, id: string) => void,
  goEvents: () => void,
  openAdmin: () => void,
  logistics: Logistics
): Node[] {
  const head = h("h3", { class: "catchup__title" }, headingIcon("calendar"), "This week");
  const extra = (logistics.data?.travel ?? 0) + (logistics.data?.parcels ?? 0);
  const rows = planComingUp(up.events, Math.max(2, COMING_UP_ROWS - extra));
  const used = rows.length + extra;
  const lapsing = due.filter((r) => r.days_until <= 14).slice(0, Math.max(1, COMING_UP_ROWS - used));
  const people = up.catch_ups.slice(0, Math.max(used || lapsing.length ? 2 : 4, COMING_UP_ROWS - used - lapsing.length));
  if (!rows.length && !people.length && !lapsing.length && !extra) {
    return [head, h("p", { class: "empty__sub" }, "Nothing on this week, and everyone's caught up. Birthdays and events you add show up here.")];
  }
  const item = (lead: Node, title: string, sub: string, run: () => void, tone?: "late" | "today") => {
    const b = h(
      "button",
      { class: "person person--button", type: "button" },
      lead,
      h("span", { class: "person__text" }, h("span", { class: "person__name" }, title), h("span", { class: "person__days", "data-tone": tone }, sub))
    );
    b.addEventListener("click", run);
    return h("li", {}, b);
  };
  const tile = (icon: Node) => h("span", { class: "tile tile--sm tile--date", "aria-hidden": "true" }, icon);
  const out: Node[] = [
    head,
    h(
      "ul",
      { class: "people" },
      ...(logistics.data?.rows(item, tile, { trip: logistics.openTrip, purchase: logistics.openPurchase }) ?? []),
      ...rows.map((r) => {
        if (r.kind === "more") return item(tile(icons.calendar()), `+${r.count} more this week`, "See everything in Events", goEvents);
        if (r.kind === "day") {
          const names = r.list.slice(0, 2).map((o) => o.event.title).join(", ");
          return item(tile(icons.calendar()), `${r.list.length} calendar events`, `${dayLabel(r.days_until, r.day)} · ${names}${r.list.length > 2 ? ", …" : ""}`, goEvents);
        }
        const { event: e, occurs_on, days_until, years, time } = r.o;
        const birthday = e.kind === "birthday";
        const target: [EntityKind, string] = birthday && e.person_id ? ["person", e.person_id] : ["event", e.id];
        const title = birthday ? e.title.replace(/'s birthday$/, "") : e.title;
        const what = birthday ? (years ? `turns ${years}` : "birthday") : (time ?? "");
        // Maybe gets a soft label; declined invites aren't here at all.
        const maybe = e.rsvp === "maybe" ? "Maybe" : "";
        return item(tile(birthday ? icons.gift() : icons.calendar()), title, [dayLabel(days_until, occurs_on), what, maybe].filter(Boolean).join(" · "), () => open(target[0], target[1]));
      }),
      ...lapsing.map(({ asset, days_until }) =>
        item(tile(icons[ASSET_META[asset.kind].icon]()), asset.name, renewalLabel(asset.kind, days_until), openAdmin, days_until < 0 ? "late" : undefined)
      ),
      ...people.map((p) =>
        item(
          h("span", { class: "avatar", style: `--h:${hueFor(p.name)}`, "aria-hidden": "true" }, initials(p.name)),
          p.name,
          p.last_contacted_at ? `Catch up · last spoke ${relativeTime(p.last_contacted_at)}` : "Catch up · never logged",
          () => open("person", p.id)
        )
      )
    ),
  ];
  if (up.catch_ups.length > people.length) {
    out.push(h("p", { class: "catchup__foot" }, `${countWord(up.catch_ups.length)} ${plural(up.catch_ups.length, "person", "people")} overdue a catch-up`));
  }
  return out;
}

/** To do: the next few things, soonest due first, ticked off right here. */
function toDoBody(loops: Commitment[], overdue: number, dueToday: number, go: (view: ViewId) => void): Node[] {
  const add = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "Add a to-do" }, icons.plus());
  add.addEventListener("click", () => openCommitmentSheet(null));
  const head = h("div", { class: "todo-card__head" }, h("h3", { class: "catchup__title" }, headingIcon("loop"), "To do"), add);
  if (!loops.length) {
    return [head, h("p", { class: "empty__sub" }, "Nothing to do. Add the next thing on your mind, and things you promise in meetings land here too.")];
  }
  const all = h("button", { class: "link-btn", type: "button" }, `See all ${loops.length}`);
  all.addEventListener("click", () => go("loops"));
  const tally = [overdue ? `${countWord(overdue)} overdue` : "", dueToday ? `${countWord(dueToday, overdue > 0)} due today` : ""].filter(Boolean).join(", ");
  return [
    head,
    h("div", { class: "list list--plain" }, ...loops.slice(0, 5).map((c) => loopRow(c, { onOpen: (x) => openCommitmentSheet(x) }))),
    h("div", { class: "todo-card__foot" }, h("span", { class: "todo-card__tally", "data-tone": overdue ? "late" : undefined }, tally), all),
  ];
}

/**
 * The writer's own line, kept at the top of the briefing as a quote
 * (lib/briefing-run.ts bodyWithLead): "Morning, Alex. The 08:55 to Bristol
 * is 12 minutes late, and Priya turns 35 on Thursday." Null for an older
 * note or the data briefing, which keep the flattened sections.
 */
export function briefingLine(body: string): string | null {
  const m = body.match(/^\s*>\s?(.+)/);
  if (!m) return null;
  const line = m[1].replace(/\[@?([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim();
  return line || null;
}

/** Today's briefing, written at 07:30 by the reminders function (source 'briefing'). */
function todaysBriefing(notes: Note[]): Note | null {
  const today = localToday();
  return notes.find((n) => n.source === "briefing" && n.type === "daily" && localToday(new Date(n.created_at)) === today) ?? null;
}

// ---------- The first week (lib/first-week.ts) ----------

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Sample mode keeps the sample owner's Home. #/home?first=1 previews a new
 * owner's first week instead (for screenshots and design review), with
 * &day=2 to &day=7 for the later days. Nothing it does is saved.
 */
function firstWeekPreview(): { day: number; facts: FirstWeekFacts } | null {
  if (!isSampleMode()) return null;
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  if (params.get("first") !== "1") return null;
  const day = Math.min(7, Math.max(1, Number(params.get("day")) || 1));
  const facts: FirstWeekFacts = day === 1 ? { sources: 0, daysKept: 0, people: 0 } : day < 7 ? { sources: 1, daysKept: day - 1, people: 0 } : { sources: 2, daysKept: 5, people: 2, places: 3, picked: true };
  return { day, facts };
}

const NAME_LATER = "athena:first-week:name-later";
const nameLater = () => {
  try {
    return localStorage.getItem(NAME_LATER) === "1";
  } catch {
    return false;
  }
};

/** What exists so far, for the card's words: apps connected, days kept since day one, people, and whether anything about you waits to keep. */
async function firstWeekFacts(start: string, today: string): Promise<FirstWeekFacts> {
  const [sources, daysKept, people, picked] = await Promise.all([
    import("../db/api").then((api) => api.fetchConnectors()).then((s) => s.connectors.filter((c) => c.status === "connected").length, () => 0),
    import("../db/days-app").then((d) => d.loadDays(start, today)).then((r) => r.days.length, () => 0),
    import("../db/records").then((r) => r.loadRecords("person")).then((r) => r.items.filter((p) => !p.archived_at).length, () => 0),
    loadSuggestions().then(({ items }) => items.some((x) => x.op === "fact" && x.payload.subject_kind === "me"), () => false),
  ]);
  return { sources, daysKept, people, picked };
}

const FIRST_WEEK_ICON: Record<FirstWeekAction, IconName> = { connect: "plug", people: "person", mood: "heart", write: "pen", review: "sparkle" };

export function renderHome(ctx: HomeContext): { el: HTMLElement; destroy: () => void } {
  const preview = firstWeekPreview();
  /** Which day of the first week today is (1 to 7), or null for an ordinary day. */
  let firstDay: number | null = preview?.day ?? null;
  let firstStart: string | null = preview ? addDays(localToday(), 1 - preview.day) : null;
  /** Whether there's a name (or the owner said not now), so the name question stays away. */
  let named = !preview && (!!rememberedName() || nameLater());
  /** How many notes the first load found: an owner with a few already isn't new. */
  let firstNotes: (n: number) => void = () => {};
  const notesCount = new Promise<number>((resolve) => (firstNotes = resolve));
  const rest = h("span", { class: "headline__rest" });
  // "Good evening, Alex." with the name the owner gave in their profile; as before without one.
  const hello = h("span", { class: "headline__hello" }, `${greeting(new Date(), preview ? null : rememberedName())}. `);
  const headline = h("h1", { class: "headline" }, hello, rest);

  const latest = h("button", { class: "card pressable latest", type: "button", "data-area": "latest" }, h("span", { class: "tile" }), stack(bar("40%"), bar("75%", "18px"), bar("90%")));
  const catchup = h("article", { class: "card card--sunken catchup", "data-area": "catch" }, stack(bar("50%"), bar("80%"), bar("70%"), bar("75%")));
  const briefing = h("button", { class: "card pressable briefing", type: "button", hidden: true });
  let briefingNote: Note | null = null;
  briefing.addEventListener("click", () => briefingNote && ctx.openNote(briefingNote));
  const todo = h("article", { class: "card todo-card", "data-area": "todo" }, stack(bar("35%"), bar("85%"), bar("70%"), bar("78%")));

  // What agents weren't sure about, waiting for you.
  const review = h("button", { class: "card pressable briefing", type: "button", hidden: true });
  review.addEventListener("click", () => ctx.go("review"));

  // Until the owner has told Athena about themselves (or said not now): the profile wizard.
  const setupCard = profileSetupCard();
  // Once, after the update that limits imported skills: those that lost their accounts (accounts-notice.ts).
  const acctNotice = accountsNoticeCard();

  // Friday to Sunday: a way into the weekly review.
  const dow = new Date(`${localToday()}T12:00:00Z`).getUTCDay();
  const weekBanner = h(
    "button",
    { class: "card pressable briefing", type: "button", hidden: !(dow === 5 || dow === 6 || dow === 0), "aria-label": "Open your weekly review" },
    h("span", { class: "tile" }, icons.week()),
    h("span", { class: "briefing__text" }, h("span", { class: "briefing__title" }, "Your week, in review"), h("span", { class: "briefing__snippet" }, "What got done, who you saw, what's next")),
    h("span", { class: "briefing__chevron", "aria-hidden": "true" }, icons.chevronRight())
  );
  // The week in review lives in Days (#/days/week/<this Monday>).
  weekBanner.addEventListener("click", () => (location.hash = `#/days/week/${weekStartOf(localToday())}`));

  const recentList = h("div", { class: "card card--flush list" });
  const recent = h(
    "section",
    { class: "section", "aria-labelledby": "home-recent" },
    h("div", { class: "section-head" }, h("h2", { id: "home-recent" }, "Recent"), seeAll()),
    recentList
  );
  // Your people and a goal, from the profile.
  const personal = homePersonal({
    openPerson: (id) => ctx.openLink("person", id),
    goPeople: () => ctx.go("people"),
    goGoals: () => ctx.go("goals"),
    onName: (name) => {
      // The first-week preview is a new owner with no name yet.
      if (preview) return;
      named = named || !!name;
      paintAsk();
      const text = `${greeting(new Date(), name)}. `;
      if (hello.textContent !== text) hello.textContent = text;
    },
  });

  // ---------- The first week: the name question, yesterday as a small page, one card ----------
  const fwAsk = h("form", { class: "fw-ask", hidden: true, "aria-label": NAME_QUESTION });
  const fwYesterday = h("a", { class: "card pressable fw-page", hidden: true });
  const fwCard = h("article", { class: "card fw-card", hidden: true, "aria-labelledby": "fw-card-title" });
  let fwFacts: FirstWeekFacts | null = preview?.facts ?? null;

  /** The greeting with a name, settling in. */
  const sayHello = (name: string) => {
    hello.textContent = `${greeting(new Date(), name)}. `;
    hello.classList.remove("is-new");
    void hello.offsetWidth;
    hello.classList.add("is-new");
  };

  /** Fold the question away once it's answered (or put off). */
  const foldAsk = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      fwAsk.hidden = true;
      return;
    }
    fwAsk.classList.add("is-folding");
    fwAsk.addEventListener("transitionend", () => (fwAsk.hidden = true), { once: true });
    setTimeout(() => (fwAsk.hidden = true), 700);
  };

  function paintAsk() {
    const show = firstDay !== null && !named;
    if (!show) {
      if (!fwAsk.hidden && !fwAsk.classList.contains("is-folding")) fwAsk.hidden = true;
      return;
    }
    fwAsk.hidden = false;
    if (fwAsk.childElementCount) return;
    // The Name control from Settings → About you, inline: one question, nothing blocking.
    const control = profileControl({ key: "Name", label: NAME_QUESTION, input: "text", hint: "Sam" }, "");
    const input = control.el as HTMLInputElement;
    input.id = "fw-name";
    input.classList.add("fw-ask__field");
    input.setAttribute("autocomplete", "given-name");
    input.setAttribute("enterkeyhint", "done");
    input.maxLength = 40;
    const save = h("button", { class: "btn btn--primary fw-ask__save", type: "submit" }, "Save") as HTMLButtonElement;
    const later = h("button", { class: "link-btn fw-ask__later", type: "button" }, "Not now");
    fwAsk.replaceChildren(
      h("div", { class: "fw-ask__in" }, h("label", { class: "fw-ask__label", for: "fw-name" }, NAME_QUESTION), h("div", { class: "fw-ask__row" }, input, save, later))
    );
    fwAsk.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = control.value().replace(/\s+/g, " ").slice(0, 40);
      if (!name) return control.focus();
      save.disabled = true;
      try {
        if (!preview) await saveProfile([{ key: "Name", value: name }]);
        named = true;
        sayHello(name);
        foldAsk();
      } catch (error) {
        save.disabled = false;
        showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff", timeoutMs: 4000 });
      }
    });
    later.addEventListener("click", () => {
      named = true;
      if (!preview) {
        try {
          localStorage.setItem(NAME_LATER, "1");
        } catch {
          // private mode: it asks again next time
        }
      }
      foldAsk();
    });
  }

  function runFirstWeek(kind: FirstWeekAction) {
    const day = localToday();
    if (kind === "connect") location.hash = "#/settings/accounts";
    else if (kind === "people") void openProfileWizard({ step: "about" });
    else if (kind === "mood") location.hash = `${dayHref(day)}?mood`;
    else if (kind === "write") location.hash = `${dayHref(day)}?write`;
    else if (firstStart) location.hash = `#/days/week/${firstStart}?first=1`;
  }

  function paintFirstCard() {
    fwCard.hidden = firstDay === null || !fwFacts;
    if (fwCard.hidden || firstDay === null || !fwFacts) return;
    const c = firstWeekCard(firstDay, fwFacts);
    const action = c.action;
    const go = action ? h("button", { class: `btn ${action.kind === "review" ? "btn--primary" : "btn--soft"} btn--sm fw-card__go`, type: "button" }, icons[FIRST_WEEK_ICON[action.kind]](), action.label) : null;
    go?.addEventListener("click", () => action && runFirstWeek(action.kind));
    fwCard.dataset.day = String(firstDay);
    fwCard.replaceChildren(
      h("span", { class: "tile fw-card__tile", "aria-hidden": "true" }, icons.sparkle()),
      h(
        "div",
        { class: "fw-card__text" },
        h("p", { class: "fw-card__kicker" }, c.kicker),
        h("h2", { class: "fw-card__title", id: "fw-card-title" }, c.title),
        h("p", { class: "fw-card__body" }, c.body),
        go
      )
    );
  }

  /** Day two opens with yesterday, the first day, as a small page. */
  async function paintYesterday() {
    if (firstDay !== 2) return;
    const date = addDays(localToday(), -1);
    let text: string;
    try {
      const { loadDays } = await import("../db/days-app");
      const d = (await loadDays(date, date)).days[0];
      text = yesterdayPage(d ? { mood: d.mood, line: d.line, journal: d.journal, steps: d.counts.steps, photos: d.counts.photos, entries: d.counts.entries } : null);
    } catch {
      return;
    }
    if (gone) return;
    const label = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    fwYesterday.setAttribute("href", dayHref(date));
    fwYesterday.setAttribute("aria-label", `${text} Open ${label}.`);
    fwYesterday.replaceChildren(
      h("span", { class: "fw-page__text" }, h("span", { class: "fw-page__kicker" }, `Yesterday · ${label}`), h("span", { class: "fw-page__line" }, text)),
      h("span", { class: "briefing__chevron", "aria-hidden": "true" }, icons.chevronRight())
    );
    fwYesterday.hidden = false;
  }

  /** The cards that would only say "nothing" step aside for the first-week card. */
  function paintEmpties() {
    todo.toggleAttribute("data-empty", !!todo.querySelector(":scope > p.empty__sub"));
    catchup.toggleAttribute("data-empty", !!catchup.querySelector(":scope > p.empty__sub"));
    latest.toggleAttribute("data-empty", latestEmpty);
  }
  let latestEmpty = false;

  function enterFirstWeek() {
    el.classList.toggle("home--first", firstDay !== null);
    el.classList.toggle("home--first-preview", !!preview);
    paintHeadline();
    paintAsk();
    paintFirstCard();
    void paintYesterday();
  }

  function seeAll() {
    const b = h("button", { class: "link-btn", type: "button" }, "See all");
    b.addEventListener("click", () => ctx.goNotes(null));
    return b;
  }

  const topbar = h(
    "header",
    { class: "topbar" },
    h("div", { class: "brand" }, brandMark(), h("div", {}, h("div", { class: "brand-name" }, "Athena"), h("div", { class: "brand__sub" }, formatDateHeading()))),
    // A phone's new note lives here now the dock has no + (wide screens hide it: the sidebar has one).
    h("div", { class: "topbar__end" }, ctx.statusEl, newNoteButton(ctx.compose))
  );
  // Ask, from Home: Athena or any assistant (components/home-ask.ts).
  const ask = homeAsk();

  // Today leads Home (components/day-today.ts, with Days' styles, in a chunk of its own
  // so the first screen stays light). A day opens through its address.
  const today = h("div", { class: "home-today" }, h("div", { class: "home-today__wait", "aria-hidden": "true" }));
  let todayHandle: { destroy: () => void } | null = null;
  /** Whether Today has nothing in it yet (null until it knows). */
  let todayQuiet: boolean | null = null;
  /** The day in a sentence, from Today (null until it says, or when the day has nothing). */
  let todayLine: string | null | undefined;
  let gone = false;
  void import("../components/day-today").then(
    ({ todayBlock }) => {
      if (gone) return;
      const t = todayBlock({
        place: "home",
        openDay: (date, o) => (location.hash = `${dayHref(date)}${o?.write ? "?write" : ""}`),
        onQuiet: (quiet) => {
          if (todayQuiet === quiet) return;
          todayQuiet = quiet;
          paintHeadline();
        },
        onLine: (line) => {
          if (todayLine === line) return;
          todayLine = line;
          paintHeadline();
        },
      });
      todayHandle = t;
      today.replaceChildren(t.el);
    },
    () => {
      today.remove();
      // Without Today the evening headline has nothing to hand back.
      todayLine = null;
      paintHeadline();
    }
  );

  // Travelling today: on a travel day, the day's legs and how they're running, above Today (components/travel-today.ts, a chunk of its own).
  const travel = h("div", { class: "home-travel", hidden: true });
  let travelHandle: { destroy: () => void } | null = null;
  void import("../components/travel-today").then(({ travelToday }) => {
    if (gone) return;
    const t = travelToday({ date: localToday(), place: "home", openTrip: ctx.openTrip, onShown: (shown) => (travel.hidden = !shown) });
    travelHandle = t;
    travel.replaceChildren(t.el);
  }, () => travel.remove());

  // Prepare notes: a meeting soon with people Athena knows (components/prepare-notes.ts, its own chunk).
  const prep = h("div", { class: "home-prep-slot" });
  let prepHandle: { destroy: () => void } | null = null;
  void import("../components/prepare-notes").then(({ prepareNotes }) => {
    if (gone) return;
    const cards = prepareNotes({ openLink: ctx.openLink });
    prepHandle = cards;
    prep.replaceChildren(cards.el);
  }, () => prep.remove());

  // Team chat, while something waits for you there (team/home-chat-card.ts, its own chunk): opens the chat at that post.
  const teamChat = h("div", { class: "home-teamchat-slot" });
  let offTeamChat = () => {};
  void import("../team/home-chat-card").then(({ teamChatCard }) => {
    if (gone) return;
    const card = teamChatCard();
    teamChat.replaceChildren(card.el);
    offTeamChat = card.destroy;
  }, () => teamChat.remove());

  // For you: nudges Athena and the team started (components/nudge-card.ts, its own chunk), each opening Ask.
  const nudges = h("div", { class: "home-nudges-slot" });
  let offLiveNudges = () => {};
  void import("../components/nudge-card").then(({ nudgeCards }) => {
    if (gone) return;
    const cards = nudgeCards();
    nudges.replaceChildren(cards.el);
    // A nudge made (or dismissed on another device) while Home is open shows without a reload.
    const offLive = onLive("nudge", () => void cards.refresh());
    offLiveNudges = () => (offLive(), cards.destroy());
  }, () => nudges.remove());

  const blocks = [topbar, headline, ask.el, fwAsk, fwYesterday, today, fwCard, briefing, setupCard.el, acctNotice.el, review, weekBanner, todo, latest, catchup, personal.el, recent];
  if (!introPlayed) {
    blocks.forEach((b, i) => {
      b.classList.add("reveal");
      b.style.setProperty("--i", String(i));
    });
    introPlayed = true;
  }

  const el = h(
    "div",
    { class: "view home home--settling" },
    topbar,
    // The greeting is Home's title; on a wide screen it comes first, on the page head's line (styles/components.css).
    pageHead({ class: "home__head", title: headline }),
    ask.el,
    fwAsk,
    fwYesterday,
    travel,
    teamChat,
    nudges,
    today,
    prep,
    h("div", { class: "home-banners" }, personal.banner, fwCard, briefing, setupCard.el, acctNotice.el, review, weekBanner),
    h("section", { class: "bento", "aria-label": "Today" }, todo, latest, catchup),
    h("div", { class: "home-lower" }, personal.el, recent)
  );

  // ---------- Data ----------
  let todayCount: number | null = null;
  let staleCount: number | null = null;
  let latestNote: Note | null = null;
  let todayEvent: string | null = null;
  let dueCount = 0;

  function paintHeadline() {
    // From 18:00 the headline hands the day back instead of counting what's left; counts come back in the morning.
    if (phaseAt(new Date()) === "evening") {
      if (todayLine === undefined) return;
      const said = rest.dataset.said ?? "";
      const next = todayLine ? `${todayLine.replace(/[.!?…]$/, "")}.` : "A quiet one today.";
      if (said === next) return;
      rest.dataset.said = next;
      rest.replaceChildren(h("span", { class: "headline__day" }, next));
      return;
    }
    // Day one: Athena says who it is and what it will do. The counts start tomorrow.
    if (firstDay === 1) {
      if (rest.dataset.said === "hello") return;
      rest.dataset.said = "hello";
      rest.replaceChildren(h("span", { class: "headline__intro" }, ATHENA_HELLO));
      return;
    }
    // The preview is a new owner's Home: none of the sample owner's counts.
    if (preview) {
      rest.replaceChildren(todayQuiet === false ? "" : "A quiet day so far.");
      return;
    }
    if (todayCount === null || staleCount === null) return;
    const notesPart = h("strong", {}, `${countWord(todayCount)} new ${plural(todayCount, "note", "notes")}`);
    const peoplePart = h("strong", {}, `${countWord(staleCount, true)} ${plural(staleCount, "person", "people")}`);
    // A date today leads the sentence: it's the thing most worth knowing.
    if (todayEvent) {
      rest.replaceChildren(h("strong", {}, todayEvent), todayCount ? ` today, and ${countWord(todayCount, true)} new ${plural(todayCount, "note", "notes")}.` : " today.");
      return;
    }
    // Then what's due: overdue and today's to-dos.
    if (dueCount) {
      const duePart = h("strong", {}, `${countWord(dueCount)} ${plural(dueCount, "thing", "things")} to do`);
      if (staleCount) rest.replaceChildren(duePart, " today, and ", peoplePart, " to catch up with.");
      else rest.replaceChildren(duePart, " today.");
      return;
    }
    if (todayCount && staleCount) rest.replaceChildren(notesPart, " today, and ", peoplePart, " to catch up with.");
    else if (todayCount) rest.replaceChildren(notesPart, " today. You're all caught up.");
    else if (staleCount) rest.replaceChildren("A quiet day so far, with ", peoplePart, " to catch up with.");
    // Today's card below says what the day holds; only call it quiet when it is.
    else rest.replaceChildren(todayQuiet === false ? "" : "A quiet day so far.");
  }

  latest.addEventListener("click", () => {
    if (latestNote) ctx.openNote(latestNote);
    else ctx.compose();
  });

  // What's below Today stays out of sight until the notes and to-dos have
  // answered (at most 0.8s): the briefing and review banners arrive with them,
  // and appearing after that would push the cards down.
  let notesIn = false;
  let motionIn = false;
  const settled = () => el.classList.remove("home--settling");
  const settleTimer = setTimeout(settled, 800);
  const settle = () => {
    if (notesIn && motionIn) settled();
  };

  const unsubscribe = onNotes(({ notes }) => {
    notesIn = true;
    queueMicrotask(settle);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    todayCount = notes.filter((n) => Date.parse(n.created_at) >= start.getTime()).length;
    paintHeadline();

    briefingNote = todaysBriefing(notes);
    briefing.hidden = !briefingNote;
    if (briefingNote) {
      const { rest: text } = noteParts(briefingNote);
      // The writer's line, in its voice; an older note keeps its flattened sections.
      const voice = briefingLine(briefingNote.body);
      // From 18:00 the morning's greeting would sit under "Good evening": label it this morning's and quote it (lib/briefing-frame.ts).
      const frame = briefingFrame(new Date(), voice, briefingNote.title);
      briefing.setAttribute("aria-label", frame.ariaLabel);
      briefing.classList.toggle("briefing--voice", !!voice);
      // The date is already in the header; lead with what the briefing says.
      briefing.replaceChildren(
        h("span", { class: "tile" }, icons.sparkle()),
        frame.line
          ? h("span", { class: "briefing__text" }, h("span", { class: "briefing__eyebrow" }, frame.label), h("span", { class: "briefing__voice" }, frame.line))
          : h(
              "span",
              { class: "briefing__text" },
              h("span", { class: "briefing__title" }, frame.label),
              text ? h("span", { class: "briefing__snippet" }, text.replace(/\n+/g, " · ")) : null
            ),
        h("span", { class: "briefing__chevron", "aria-hidden": "true" }, icons.chevronRight())
      );
    }

    latestNote = notes.find((n) => n !== briefingNote) ?? null;
    if (latestNote) {
      const n = latestNote;
      const { title, rest: body } = noteParts(n);
      const src = describeSource(n.source);
      latest.setAttribute("aria-label", `Open latest note: ${title}`);
      latest.replaceChildren(
        h("span", { class: "tile" }, icons[TYPE_ICON[n.type]]()),
        h(
          "span",
          {},
          h("span", { class: "latest__eyebrow" }, `Latest · ${relativeTime(n.updated_at)}`),
          h("span", { class: "latest__title", style: "display:block" }, title),
          body ? h("span", { class: "latest__snippet" }, body) : null,
          h(
            "span",
            { class: "latest__foot" },
            src.key === "manual" ? null : h("span", { class: "badge" }, src.name),
            src.label ? h("span", { class: "badge badge--accent" }, src.label) : null,
            n.id.startsWith("local-") ? h("span", { class: "badge badge--queued" }, "Waiting to sync") : null
          )
        )
      );
    } else {
      latest.setAttribute("aria-label", "Write your first note");
      latest.replaceChildren(
        h("span", { class: "tile" }, icons.pen()),
        h(
          "span",
          {},
          h("span", { class: "latest__title", style: "display:block" }, "Your first note goes here"),
          h("span", { class: "latest__snippet" }, "Tap here or New note to write it. It works offline too.")
        )
      );
    }
    latestEmpty = !latestNote;
    paintEmpties();
    firstNotes(notes.filter((n) => n.source !== "briefing").length);

    const more = notes.filter((n) => n !== briefingNote && n !== latestNote).slice(0, 4);
    recent.hidden = !more.length;
    recentList.replaceChildren(...more.map((n) => noteRow(n, { onOpen: ctx.openNote })));
  });

  let lastUpcoming: Upcoming | null = null;
  let lapsing: Renewal[] = [];
  const logistics: Logistics = { data: null, openTrip: ctx.openTrip, openPurchase: ctx.openPurchase };
  const paintComingUp = () => lastUpcoming && catchup.replaceChildren(...comingUpBody(lastUpcoming, lapsing, ctx.openLink, () => ctx.go("events"), () => ctx.go("admin"), logistics));

  // Trips and parcels this week: their own chunk, so they don't hold up the first screen.
  let dead = false;
  let unsubLogistics = () => {};
  const loadLogistics = async (mod: typeof import("../lib/coming-up-trips")) => {
    logistics.data = await mod.loadComingUpLogistics();
    if (!dead) paintComingUp();
  };
  import("../lib/coming-up-trips")
    .then((mod) => {
      if (dead) return;
      void loadLogistics(mod);
      const off = mod.onLogisticsChange(() => void loadLogistics(mod));
      unsubLogistics = () => void off();
    })
    .catch(() => undefined); // offline before it was cached: Coming up just leaves trips out

  const loadComingUp = () =>
    loadUpcoming(6).then(({ upcoming }) => {
      lastUpcoming = upcoming;
      staleCount = upcoming.catch_ups.length;
      // The next of today's dates that hasn't happened (lib/headline-event.ts); the clock below moves it on.
      todayEvent = headlineEventWords(headlineEvent(upcoming.events, new Date()));
      paintHeadline();
      paintComingUp();
      paintEmpties();
    });

  // What's in motion: to-dos, suggestions waiting for review, renewals.
  const loadMotion = async () => {
    const [{ items }, { items: pending }, { items: assets }] = await Promise.all([loadCommitments(), loadSuggestions(), loadAssets()]);
    const loops = openLoops(items);
    const g = groupLoops(loops);
    dueCount = g.overdue.length + g.today.length;
    todo.replaceChildren(...toDoBody(loops, g.overdue.length, g.today.length, ctx.go));
    paintEmpties();
    review.hidden = !pending.length;
    if (pending.length) {
      review.setAttribute("aria-label", `${pending.length} ${plural(pending.length, "suggestion", "suggestions")} to review`);
      review.replaceChildren(
        h("span", { class: "tile" }, icons.inbox()),
        h(
          "span",
          { class: "briefing__text" },
          h("span", { class: "briefing__title" }, `${pending.length} ${plural(pending.length, "thing", "things")} to review`),
          h("span", { class: "briefing__snippet" }, pending[0].summary)
        ),
        h("span", { class: "briefing__chevron", "aria-hidden": "true" }, icons.chevronRight())
      );
    }
    lapsing = renewals(assets, 14);
    paintHeadline();
    paintComingUp();
  };

  // The first week: from setup's started_at, stamped the first time Home opens for a new owner.
  if (preview) enterFirstWeek();
  else if (!isSampleMode())
    void (async () => {
      let setup;
      try {
        setup = await loadSetup();
      } catch {
        return;
      }
      let started = setup.started_at;
      if (!started && !setup.completed_at) {
        // An owner from before the first week was kept already has notes: they aren't new.
        if ((await notesCount) > 5) return;
        started = new Date().toISOString();
        void changeSetup({ start: true }).catch(() => undefined);
      }
      const today = localToday();
      firstDay = firstWeekDay(started, today);
      firstStart = firstWeekStart(started);
      if (gone || firstDay === null || !firstStart) return;
      enterFirstWeek();
      fwFacts = await firstWeekFacts(firstStart, today);
      if (!gone) paintFirstCard();
    })();

  // The headline follows the day: the greeting changes at noon and at six, the event it leads with gives way
  // to the next one once it's behind you, and at 18:00 the sentence hands the day back. Checked each minute
  // and on coming back to the app; nothing is repainted unless one of those changed.
  let saidPhase = phaseAt(new Date());
  let saidDate = localToday();
  const followDay = () => {
    if (dead || gone) return;
    const now = new Date();
    // Left open past midnight: what's "today" has changed, so ask again.
    if (localToday() !== saidDate) {
      saidDate = localToday();
      void loadComingUp();
    }
    const words = greeting(now);
    const text = (hello.textContent ?? "").replace(/^(Still up|Good morning|Good afternoon|Good evening)/, words);
    if (text !== hello.textContent) hello.textContent = text;
    const next = lastUpcoming ? headlineEventWords(headlineEvent(lastUpcoming.events, now)) : todayEvent;
    const phase = phaseAt(now);
    if (next === todayEvent && phase === saidPhase) return;
    todayEvent = next;
    saidPhase = phase;
    // Leaving the evening's sentence: let the morning's be said again.
    delete rest.dataset.said;
    paintHeadline();
  };
  const dayClock = setInterval(followDay, 60_000);
  const onBack = () => document.visibilityState === "visible" && followDay();
  document.addEventListener("visibilitychange", onBack);

  void loadComingUp();
  void loadMotion().finally(() => {
    motionIn = true;
    settle();
  });
  const unsubRecords = onRecordsChange(() => void loadComingUp());
  const unsubMemory = onMemoryChange(() => void loadMotion());

  return {
    el,
    destroy: () => {
      dead = true;
      clearTimeout(settleTimer);
      unsubscribe();
      unsubRecords();
      unsubMemory();
      unsubLogistics();
      offLiveNudges();
      offTeamChat();
      clearInterval(dayClock);
      document.removeEventListener("visibilitychange", onBack);
      setupCard.destroy();
      acctNotice.destroy();
      ask.destroy();
      personal.destroy();
      gone = true;
      (todayHandle as { destroy: () => void } | null)?.destroy();
      (travelHandle as { destroy: () => void } | null)?.destroy();
      (prepHandle as { destroy: () => void } | null)?.destroy();
    },
  };
}
