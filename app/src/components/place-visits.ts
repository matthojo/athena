/**
 * Where you've been, on the Library's Places page and on each Place:
 *
 *  - placesCard(): above the list. Before anything's arrived, what it does
 *    and the ways in (a visit added by hand, a Timeline file, Swarm). After,
 *    the latest day in the Life log's own words and how many days there are.
 *    Either way, the visits added by hand (manualVisitList), latest first.
 *  - manualVisitList() and addVisitButton(): visits added by hand, each with
 *    a remove, and the button that opens the sheet (place-visit-sheet.ts);
 *    the day page and a Place's Visits use them too.
 *  - placeVisitsFact(): "Visited 6 times · last 3 Nov", with the last 12
 *    months as a strip.
 *  - placeStoryRows(): a Place's "Visits" timeline (lib/record-story.ts):
 *    its days from placeDays (the server's latest visits, or sample mode's
 *    Days), calendar events there and who was with you.
 *  - placeHeroMap(): the still of the spot the Place's page opens with,
 *    the same one its rich link uses (db/rich-links.ts).
 *
 * They read the server (GET /api/places/status, /api/places/:id/visits,
 * /api/places/visits/manual); visits are sealed there and never stored on
 * this device (sample mode keeps its own in this browser).
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { plural } from "../lib/format";
import { isSampleMode, request } from "../db/api";
import { loadConnections } from "../db/data";
import { loadRecords } from "../db/records";
import { liveCard } from "../db/rich-links";
import { addDays } from "../../../lib/dates";
import { localToday, whenLocal } from "../lib/time";
import { placeStory, type StoryDay, type StoryRow } from "../lib/record-story";
import { recentSeen, sampleStory } from "./record-timeline";
import { dayPreview, type PlacesStatus } from "./timeline-import";
import { showToast } from "./toast";
import { duration } from "./day-words";
import { loadManualVisits, removeManualVisit, type ManualVisit } from "../db/place-visits";
import type { Place } from "../types";
import "../styles/places.css";
import "../styles/manual-entry.css";
import { clockTime } from "../lib/clock";

interface Visits {
  count: number;
  days: number;
  first: string | null;
  last: string | null;
  recent: Array<{ date: string; minutes: number; n: number }>;
  months: Array<{ month: string; n: number }>;
}

const n = (x: number) => x.toLocaleString("en-GB");
const thisYear = () => String(new Date().getFullYear());

/** "3 Nov", or "3 Nov 2025" before this year. */
function shortDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const s = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).replace(/Sept/, "Sep");
  return day.slice(0, 4) === thisYear() ? s : `${s} ${day.slice(0, 4)}`;
}
const monthYear = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function openImport(done: () => void) {
  void import("./timeline-import").then((m) => m.openTimelineImport(done));
}

// ---------- The Places page ----------

/** The card above the Places list. Paints itself once the server answers; offline, it shows how to start. */
export function placesCard(onChange: () => void): HTMLElement {
  // Its room is kept while it loads, so the list below doesn't jump when it arrives.
  const el = h("section", { class: "where where--wait", "aria-label": "Where you've been", "aria-busy": "true" });
  const reload = () => {
    forgetPlaceVisits();
    onChange();
    void load();
  };

  function intro() {
    const add = addVisitButton(reload, { primary: true });
    const file = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Import Timeline");
    file.addEventListener("click", () => openImport(reload));
    el.replaceChildren(
      h(
        "div",
        { class: "where__head" },
        h("span", { class: "where__mark", "aria-hidden": "true" }, icons.pin()),
        h(
          "div",
          { class: "where__text" },
          h("p", { class: "where__title" }, "Where you've been"),
          h("p", { class: "where__sub" }, "Add a visit by hand, add your Google Maps Timeline or connect Swarm. Each of your days then says where you went, with the weather.")
        )
      ),
      h("div", { class: "where__actions" }, add, file, h("a", { class: "btn btn--soft btn--sm", href: "#/settings/sources" }, "Connect Swarm")),
      h("p", { class: "where__private" }, icons.shield(), "Encrypted, and only shown to you.")
    );
  }

  function filled(s: PlacesStatus) {
    const more = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": "Import a newer Timeline" }, "Import");
    more.addEventListener("click", () => openImport(reload));
    const since = s.first ? (s.days === 1 ? `On ${longDay(s.first)}.` : `Since ${monthYear(s.first)}.`) : "";
    const source = s.swarm ? "Swarm adds new days overnight." : "";
    el.replaceChildren(
      h(
        "div",
        { class: "where__head" },
        h("span", { class: "where__mark", "aria-hidden": "true" }, icons.pin()),
        h(
          "div",
          { class: "where__text" },
          h("p", { class: "where__title" }, `${n(s.days)} ${plural(s.days, "day", "days")} of places`),
          h(
            "p",
            { class: "where__sub" },
            [since, s.waiting ? `Still naming ${n(s.waiting)} ${plural(s.waiting, "day", "days")}; Athena carries on tonight.` : source].filter(Boolean).join(" "),
            s.swarm || s.waiting ? null : h("a", { class: "where__link", href: "#/settings/sources" }, " Connect Swarm")
          )
        ),
        more
      ),
      ...(s.latest ? [dayPreview(s.latest)] : []),
      h("div", { class: "where__actions" }, addVisitButton(reload))
    );
  }

  async function load() {
    const added = loadManualVisits().catch(() => [] as ManualVisit[]);
    try {
      const s = await request<PlacesStatus>("/places/status");
      if (s.days) filled(s);
      else intro();
    } catch {
      intro();
    }
    const visits = await added;
    if (visits.length) el.append(manualVisitList(visits.slice(0, 5), reload, { dates: true }));
    el.classList.remove("where--wait");
    el.removeAttribute("aria-busy");
  }
  void load();
  return el;
}

// ---------- Visits added by hand ----------

/** "Add a visit": opens the sheet (with the day or the Place already set), then calls `done` once it's saved. */
export function addVisitButton(done: () => void, opts: { date?: string; place?: Place; primary?: boolean } = {}): HTMLButtonElement {
  const b = h("button", { class: `btn ${opts.primary ? "btn--primary" : "btn--soft"} btn--sm`, type: "button" }, icons.plus(), "Add a visit") as HTMLButtonElement;
  b.addEventListener("click", () => void import("./place-visit-sheet").then((m) => m.openPlaceVisitSheet(() => done(), { date: opts.date, place: opts.place })));
  return b;
}

const arrival = (iso: string) => clockTime(iso);

/** Visits added by hand, each with when and how long, and a remove. `dates` adds the day (the Places page lists several). */
export function manualVisitList(visits: ManualVisit[], removed: () => void, opts: { dates?: boolean } = {}): HTMLElement {
  const rows = visits.map((v) => {
    const remove = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Remove the visit to ${v.name}` }, icons.trash());
    const li = h(
      "li",
      { class: "manual-row" },
      h(
        "span",
        { class: "manual-row__words" },
        h("span", { class: "manual-row__name" }, v.name),
        h("span", { class: "manual-row__meta" }, [opts.dates ? shortDay(v.date) : "", arrival(v.start)].filter(Boolean).join(" · "))
      ),
      h("span", { class: "manual-row__value" }, duration(v.minutes)),
      remove
    );
    remove.addEventListener("click", () => {
      li.classList.add("is-leaving");
      removeManualVisit(v.date, v.id).then(
        () => {
          forgetPlaceVisits();
          removed();
        },
        () => {
          li.classList.remove("is-leaving");
          showToast("That didn't save. Try again in a moment");
        }
      );
    });
    return li;
  });
  return h("div", { class: "manual where-manual" }, h("p", { class: "manual-sheet__group" }, "Added by hand"), h("ul", { class: "manual-list", role: "list" }, ...rows));
}

// ---------- A Place ----------

const cache = new Map<string, Promise<Visits | null>>();

/** The last 12 months as a quiet strip of bars, this month last. */
function monthStrip(months: Visits["months"]): HTMLElement {
  const max = Math.max(1, ...months.map((m) => m.n));
  const label = months.map((m) => `${new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })} ${m.n}`).join(", ");
  return h(
    "span",
    { class: "where-strip", role: "img", "aria-label": `Visits in the last 12 months: ${label}` },
    ...months.map((m) => h("span", { class: `where-strip__bar${m.n ? "" : " is-empty"}`, style: `--h:${m.n ? Math.max(18, Math.round((m.n / max) * 100)) : 10}%` }))
  );
}

/**
 * "Visited 6 times · last 3 Nov" for a Place's facts, or null when it has no
 * visits (or the server can't be reached: the profile simply leaves it out).
 */
export async function placeVisitsFact(placeId: string): Promise<HTMLElement | null> {
  const v = await visitsOf(placeId);
  if (!v || !v.last) return null;
  // Two halves that never break inside: "Visited 6 times ·" / "last 3 Nov".
  const whole = (t: string) => h("span", { class: "where-fact__part" }, t);
  const title = v.count === 1 ? [whole("Visited once ·"), " ", whole(shortDay(v.last))] : [whole(`Visited ${n(v.count)} times ·`), " ", whole(`last ${shortDay(v.last)}`)];
  const detail = v.count === 1 ? "From your days" : v.first && v.first !== v.last ? `First on ${longDay(v.first)}` : `All on ${longDay(v.last)}`;
  const spread = v.months.filter((m) => m.n).length;
  return h(
    "div",
    { class: "fact where-fact" },
    h("span", { class: "fact__icon" }, icons.calendar()),
    h("span", { class: "fact__body" }, h("span", { class: "fact__title" }, ...title), h("span", { class: "fact__detail" }, detail)),
    spread > 1 ? monthStrip(v.months) : null
  );
}

async function visitsOf(placeId: string): Promise<Visits | null> {
  let load = cache.get(placeId);
  if (!load) {
    load = request<{ visits: Visits | null }>(`/places/${encodeURIComponent(placeId)}/visits`)
      .then((r) => r.visits)
      .catch(() => {
        cache.delete(placeId);
        return null;
      });
    cache.set(placeId, load);
  }
  return load;
}

/** How far back sample mode's Days are read for a Place's visits. */
const SAMPLE_DAYS = 70;

/**
 * A Place's visits, newest first: one row a day, with what happened there
 * and who with. Sample mode reads its own Days; otherwise the server's
 * latest visits (placeDays, sealed there) and the calendar.
 */
export async function placeStoryRows(place: Place): Promise<StoryRow[]> {
  const today = localToday();
  const sample = isSampleMode();
  const [visits, days, seen, extra, linked, events] = await Promise.all([
    sample ? Promise.resolve(null) : visitsOf(place.id),
    sample ? sampleDays(today) : Promise.resolve([] as StoryDay[]),
    recentSeen(today),
    sampleStory(today),
    loadConnections("place", place.id).catch(() => ({ outgoing: [], backlinks: [] })),
    loadRecords("event")
      .then((r) => r.items)
      .catch(() => []),
  ]);
  const ids = new Set([...linked.outgoing, ...linked.backlinks].filter((c) => c.kind === "event").map((c) => c.id));
  return placeStory({
    place,
    days,
    visits: visits?.recent ?? [],
    seen: [...seen, ...extra.seen],
    events: events.filter((e) => ids.has(e.id) && e.recurrence === "none").map((e) => ({ id: e.id, title: e.title, date: whenLocal(e).date, kind: e.kind })),
    today,
  });
}

async function sampleDays(today: string): Promise<StoryDay[]> {
  const { loadDay } = await import("../db/days-app");
  const dates = Array.from({ length: SAMPLE_DAYS }, (_, i) => addDays(today, -i));
  const days = await Promise.all(dates.map((d) => loadDay(d).catch(() => null)));
  return days.filter((d): d is NonNullable<typeof d> => !!d).map((d) => ({ date: d.date, places: d.places }));
}

/** The still a Place's page opens with, and where tapping it goes; null with no still (no spot, no map key, offline with no copy). */
export async function placeHeroMap(place: Place): Promise<{ src: string; open: string | null } | null> {
  try {
    const card = await liveCard("place", place.id);
    return card?.kind === "place" && card.mapUrl ? { src: card.mapUrl, open: card.openMapUrl } : null;
  } catch {
    return null;
  }
}

/** Drop what's remembered (after an import), so the next look asks again. */
export function forgetPlaceVisits(): void {
  cache.clear();
}
