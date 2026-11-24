/**
 * Travelling today: on a day with bookings, a strip of its legs in time
 * order (a train, a flight, a coach or ferry, a car pick-up, a hotel
 * check-in), each with its time, from → to, how it's running, the platform
 * or gate, and the booking reference with a copy button. Tap a leg for its
 * trip. Home shows it from the morning (or 3 hours before the first leg)
 * until the last leg is in; the day page then says "Travelled today".
 * The rules are lib/travel-day.ts.
 *
 * Live times come from GET /api/travel/live every 2½ minutes while a leg is
 * in its window and the app is in front. Otherwise it waits for the next
 * window (or the next leg to finish) on one timer, and asks nothing.
 * The owner's usual Tube lines that aren't on Good Service sit under it.
 *
 * Built only with h() and text nodes: every value came out of an email, a
 * provider or the owner's typing.
 */

import "../styles/travel-today.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { BOOKING_ICON } from "../lib/trips-meta";
import { deviceZone, localToday } from "../lib/time";
import { prefersReducedMotion } from "../lib/motion";
import { loadDayLegs, loadTravelLive, type DayLeg } from "../db/travel-day";
import { legView, liveLegs, liveWindow, nextRefresh, REFRESH_MS, stripPhase, stripWindow, travelledLine, tubeLine, type LegLive, type StripPhase } from "../../../lib/travel-day";
import type { LineStatus } from "../../../lib/live-travel-text";
import { zonedParts } from "../../../lib/dates";
import { clockInText, clockOfDay, clockTime } from "../lib/clock";

export interface TravelTodayOptions {
  date: string;
  /** Home lets the strip go once the day's travel is over; the day page keeps a summary. */
  place: "home" | "day";
  openTrip: (tripId: string) => void;
  /** For tests and screenshots. */
  now?: () => Date;
  /** Told whether there's anything showing, each time it paints. */
  onShown?: (shown: boolean) => void;
}

const ICON = { train: icons.train, flight: icons.plane, coach: icons.suitcase, ferry: icons.suitcase, car: icons.car, hotel: icons.bed } as const;

async function copy(ref: string) {
  try {
    await navigator.clipboard.writeText(ref);
    showToast("Reference copied", { icon: "copy" });
  } catch {
    showToast("Couldn't copy the reference", { icon: "copy" });
  }
}

export function travelToday(opts: TravelTodayOptions): { el: HTMLElement; destroy: () => void } {
  const now = opts.now ?? (() => new Date());
  const tz = deviceZone();
  const isToday = () => opts.date === localToday(now());
  const id = `travel-${opts.place}`;
  const el = h("section", { class: `travel travel--${opts.place}`, "aria-labelledby": `${id}-title`, hidden: true });

  let legs: DayLeg[] = [];
  /** What the server last said per booking: undefined until asked. */
  const live = new Map<string, LegLive>();
  let lines: LineStatus[] = [];
  let checkedAt: string | null = null;
  let askedAt = 0;
  let asking = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dead = false;
  let painted = "";

  const phaseNow = (): StripPhase => {
    if (!legs.length) return "none";
    if (opts.date < localToday(now())) return "travelled";
    if (opts.date > localToday(now())) return "before";
    return stripPhase(legs, opts.date, tz, now());
  };

  function legRow(l: DayLeg, i: number): HTMLElement {
    const v = legView(l, live.get(l.booking.id), now(), tz);
    const tile = h("span", { class: "tleg__tile", "aria-hidden": "true" }, ICON[l.kind]?.() ?? icons[BOOKING_ICON[l.booking.kind]]());
    const clock = h(
      "span",
      { class: "tleg__time" },
      h("span", { class: "tleg__clock" }, v.time ? clockOfDay(v.time) : "Today"),
      v.expected ? h("span", { class: "tleg__expected", title: `Expected ${clockOfDay(v.expected)}` }, h("span", { class: "visually-hidden" }, "Expected "), clockOfDay(v.expected)) : null
    );
    const status = v.chip
      ? h(
          "span",
          { class: "tleg__status" },
          h("span", { class: "tchip", "data-tone": v.chip.tone, title: clockInText(v.chip.title) }, h("span", { class: "tchip__dot", "aria-hidden": "true" }), v.chip.label),
          v.where ? h("span", { class: "tleg__where" }, clockInText(v.where)) : null
        )
      : v.note
        ? h("span", { class: "tleg__status" }, h("span", { class: `tleg__note${v.note === "Live times unavailable" ? " tleg__note--none" : ""}` }, clockInText(v.note)))
        : null;
    const open = h(
      "button",
      { class: "tleg__open", type: "button", "aria-label": `${clockInText(v.line)}. Open the trip` },
      clock,
      h(
        "span",
        { class: "tleg__body" },
        h("span", { class: "tleg__title" }, v.title),
        v.from || v.to ? h("span", { class: "tleg__route" }, v.from, v.from && v.to ? h("span", { class: "tleg__arrow", "aria-hidden": "true" }, " → ") : null, v.to) : null
      )
    );
    open.addEventListener("click", () => opts.openTrip(l.booking.trip_id));
    const ref = v.reference
      ? h("button", { class: "tleg__ref", type: "button", "aria-label": `Copy reference ${v.reference}`, title: "Copy the reference" }, h("span", { class: "tleg__ref-code" }, v.reference), icons.copy())
      : null;
    ref?.addEventListener("click", () => void copy(v.reference!));
    // How it's running and the reference share a row under the leg: the chip says, the pill copies.
    const foot = status || ref ? h("div", { class: "tleg__foot" }, status, ref) : null;
    const li = h("li", { class: "tleg", "data-kind": l.kind, ...(v.past ? { "data-past": "" } : {}), ...(v.cancelled ? { "data-cancelled": "" } : {}), ...(v.chip ? { "data-tone": v.chip.tone } : {}) }, tile, open, foot);
    li.style.setProperty("--i", String(i));
    return li;
  }

  function paint() {
    if (dead) return;
    const phase = phaseNow();
    const show = phase === "travelling" || (opts.place === "day" && phase !== "none");
    el.hidden = !show;
    el.dataset.phase = phase;
    opts.onShown?.(show);
    if (!show) {
      painted = "";
      el.replaceChildren();
      return;
    }
    const today = isToday();
    if (phase === "travelled") {
      const key = `done:${legs.length}`;
      if (painted === key) return;
      painted = key;
      el.replaceChildren(
        h("p", { class: "travel__kicker", id: `${id}-title` }, today ? "Travelled today" : "Travelled"),
        h("p", { class: "travel__line" }, travelledLine(legs))
      );
      return;
    }
    const tube = today ? tubeLine(lines) : null;
    const fresh = checkedAt && today ? `Updated ${clockTime(checkedAt, { timeZone: tz })}` : null;
    const next = [
      h(
        "header",
        { class: "travel__head" },
        h("p", { class: "travel__kicker", id: `${id}-title` }, today ? "Travelling today" : "Travelling"),
        fresh ? h("p", { class: "travel__fresh" }, h("span", { class: "travel__pulse", "aria-hidden": "true" }), fresh) : null
      ),
      h("ol", { class: "travel__legs", role: "list" }, ...legs.map(legRow)),
      tube ? h("p", { class: "travel__tube" }, h("span", { class: "travel__tube-dot", "aria-hidden": "true" }), tube) : null,
    ];
    const first = !el.childElementCount;
    el.classList.toggle("travel--enter", first && !prefersReducedMotion());
    el.replaceChildren(...next.filter((x): x is HTMLElement => !!x));
    painted = "live";
  }

  /** Ask for the live legs' times, when it's time to. */
  async function refresh(force = false) {
    if (dead || asking || document.hidden || !isToday()) return;
    const ask = liveLegs(legs, now());
    if (!ask.length) return;
    if (!force && Date.now() - askedAt < REFRESH_MS - 1_000) return;
    asking = true;
    askedAt = Date.now();
    try {
      const r = await loadTravelLive(ask, now());
      if (dead) return;
      if (r) {
        for (const l of ask) live.set(l.booking.id, r.live[l.booking.id] ?? null);
        lines = r.lines;
        checkedAt = r.checked_at;
      } else for (const l of ask) if (!live.has(l.booking.id)) live.set(l.booking.id, null);
    } finally {
      asking = false;
    }
    paint();
  }

  /** The next moment something changes here: a leg's live window opens or closes, a leg is over, or the strip's own window. */
  function nextChange(): number | null {
    const t = now().getTime();
    const w = stripWindow(legs, opts.date, tz);
    const marks = [w?.from, w?.until, ...legs.flatMap((l) => [l.done, liveWindow(l)?.from, liveWindow(l)?.until])].filter((x): x is number => typeof x === "number" && x > t);
    return marks.length ? Math.min(...marks) - t + 1_000 : null;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (dead || document.hidden || !isToday() || !legs.length) return;
    const ask = nextRefresh(legs, now());
    const change = nextChange();
    const wait = Math.min(ask ?? Infinity, change ?? Infinity);
    if (!Number.isFinite(wait)) return;
    // Timers can't wait longer than about 24 days; a day's travel never needs to.
    timer = setTimeout(step, Math.min(wait, 6 * 3_600_000));
  }

  async function step() {
    paint();
    await refresh();
    schedule();
  }

  const onVisible = () => {
    if (document.hidden) {
      if (timer) clearTimeout(timer);
      timer = null;
    } else void step();
  };
  document.addEventListener("visibilitychange", onVisible);

  void loadDayLegs(opts.date)
    .then((ls) => {
      if (dead) return;
      legs = ls;
      paint();
      return refresh(true).then(schedule);
    })
    .catch(() => {
      el.hidden = true;
      opts.onShown?.(false);
    });

  return {
    el,
    destroy() {
      dead = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
