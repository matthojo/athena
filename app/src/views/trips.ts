/**
 * Trips: flights, trains, hotel stays, car hire and tickets from booking
 * emails, grouped into trips ("Lisbon, 12–15 Nov"). Upcoming and in-progress
 * trips come first; past ones fold away below. A trip opens to its
 * itinerary, day by day, with every time in the local time of where it
 * happens and the city named. Same shape as the Library's records: a list
 * beside a pane on desktop, a sheet on a phone. main.ts loads this module
 * (and styles/trips.css) on first visit.
 *
 * You can add your own (New, then Add booking), and edit any of it. Forms
 * are in trip-forms.ts.
 *
 * Built only with h() and text nodes: every value here came out of an email,
 * or was typed by you.
 */

import "../styles/trips.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { openSheet } from "../components/sheet";
import { showToast } from "../components/toast";
import { confirmDialog } from "../components/confirm";
import { deleteLogisticsForever, findTrip, loadTrips, onLogisticsChange, setLogisticsArchived, updateTrip } from "../db/trips";
import { relativeTime, shortDate } from "../lib/format";
import { sourceText } from "../lib/sources";
import { deviceZone, localToday } from "../lib/time";
import { BOOKING_ICON, duration, longDay, mapsLink, monthDay, safeLink, shortWeekday } from "../lib/trips-meta";
import { BOOKING_LABEL, bookingEnd, bookingName, bookingStart, dayWord, previousTime, relativeDay, TRANSPORT, tripDates, type LocalMoment } from "../../../lib/trip-text";
import { daysBetween } from "../../../lib/dates";
import { openBookingForm, openTripForm } from "./trip-forms";
import { loadFlightStatus, loadTrainStatus, wantsFlightStatus, wantsLiveStatus } from "../db/live-travel";
import { trainChip, type TrainStatus } from "../../../lib/live-travel-text";
import { flightChip, PROVIDER_NAME, type FlightStatus } from "../../../lib/flight-text";
import type { Booking, BookingKind, Trip } from "../types";
import type { ViewId } from "../components/nav";
import { pageHead } from "../components/page-head";

// ---------- small pieces ----------

const live = (t: Trip) => t.bookings.filter((b) => !b.archived_at);
const going = (t: Trip) => live(t).filter((b) => b.status !== "cancelled");

/** "3 nights", "1 night", "Day trip". */
function nights(t: Trip): string {
  if (!t.starts_on || !t.ends_on) return "";
  const n = daysBetween(t.starts_on, t.ends_on);
  return n <= 0 ? "Day trip" : `${n} ${n === 1 ? "night" : "nights"}`;
}

/** "Tomorrow", "In 5 days", "In 3 weeks", "Now". */
function whenLabel(t: Trip, today: string): { text: string; accent: boolean } | null {
  if (!t.starts_on) return null;
  if (t.ends_on && t.ends_on < today) return null;
  if (t.starts_on <= today) return { text: "Now", accent: true };
  const n = daysBetween(today, t.starts_on);
  if (n === 1) return { text: "Tomorrow", accent: true };
  if (n < 7) return { text: `In ${n} days`, accent: true };
  if (n < 28) return { text: `In ${Math.round(n / 7)} ${Math.round(n / 7) === 1 ? "week" : "weeks"}`, accent: false };
  return { text: `In ${Math.round(n / 30)} ${Math.round(n / 30) === 1 ? "month" : "months"}`, accent: false };
}

/** The next thing that happens on a trip, from now. */
function nextBooking(t: Trip, now: Date, today: string): Booking | null {
  return (
    going(t)
      .map((b) => ({ b, s: bookingStart(b) }))
      .filter(({ s }) => (s.at ? Date.parse(s.at) > now.getTime() : s.date >= today))
      .sort((x, y) => (x.s.at ?? `${x.s.date}T23:59`).localeCompare(y.s.at ?? `${y.s.date}T23:59`))[0]?.b ?? null
  );
}

/** "07:10" with its place's city: "London", or "Lisbon time" when that isn't where this device is. */
function zoneCity(m: LocalMoment): string {
  if (!m.city) return "";
  return m.tz && m.tz !== deviceZone() && m.time ? `${m.city} time` : m.city;
}

/** A coloured status line, as on a person's profile. */
function fact(icon: IconName, title: string, detail: string, tone?: "accent" | "warn"): HTMLElement {
  return h(
    "div",
    { class: `fact${tone ? ` fact--${tone}` : ""}` },
    h("span", { class: "fact__icon" }, icons[icon]()),
    h("span", { class: "fact__body" }, h("span", { class: "fact__title" }, title), detail ? h("span", { class: "fact__detail" }, detail) : null)
  );
}

/** What's happening with a trip, in a line or two. */
function tripFacts(t: Trip, today: string, now: Date): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (!t.starts_on) return out;
  const next = nextBooking(t, now, today);
  const nextLine = (b: Booking) => {
    const s = bookingStart(b);
    const what = b.kind === "hotel" ? `Check in at ${b.title}` : b.kind === "car" ? `Pick up the car` : bookingName(b);
    return `${what} ${relativeDay(s.date, today)}${s.time ? ` at ${s.time}` : ""}`;
  };
  if (t.ends_on && t.ends_on < today) {
    out.push(fact("suitcase", `Was ${tripDates(t.starts_on, t.ends_on, today)}`, nights(t)));
  } else if (t.starts_on > today) {
    const n = daysBetween(today, t.starts_on);
    const title = n === 1 ? "Leaves tomorrow" : n < 7 ? `Leaves ${dayWord(t.starts_on, today)}` : `Starts in ${n} days`;
    out.push(fact("suitcase", title, next ? nextLine(next) : "", n <= 7 ? "accent" : undefined));
  } else {
    out.push(fact("suitcase", "Happening now", next ? `Next: ${nextLine(next)}` : "Nothing else booked", "accent"));
  }
  for (const b of live(t)) {
    const s = bookingStart(b);
    if (t.ends_on && t.ends_on < today) break;
    const label = BOOKING_LABEL[b.kind].label;
    if (b.status === "changed" && s.date >= today) {
      const was = previousTime(b);
      out.push(fact("clock", `${label} time changed`, `${b.title} now ${shortWeekday(s.date)}${s.time ? ` at ${s.time}` : ""}${was ? `, not ${was}` : ""}`, "warn"));
    } else if (b.status === "cancelled" && s.date >= today) {
      out.push(fact("close", `${label} cancelled`, `${b.title}, ${shortWeekday(s.date)}${s.time ? ` at ${s.time}` : ""}`, "warn"));
    }
  }
  return out;
}

function menuPopover(uid: string, items: Array<{ icon: IconName; label: string; run: () => void; danger?: boolean } | "sep">): { button: HTMLButtonElement; menu: HTMLElement } {
  const id = `trip-menu-${uid}`;
  const button = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "More actions", popovertarget: id }, icons.more()) as HTMLButtonElement;
  const menu = h("div", { class: "menu note-menu", id, popover: "auto" }) as HTMLElement & { hidePopover?: () => void };
  menu.replaceChildren(
    ...items.map((item) => {
      if (item === "sep") return h("div", { class: "menu__sep" });
      const b = h("button", { class: `menu__item${item.danger ? " menu__item--danger" : ""}`, type: "button" }, icons[item.icon](), item.label);
      b.addEventListener("click", () => {
        menu.hidePopover?.();
        item.run();
      });
      return b;
    })
  );
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const r = button.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 120)}px`;
    menu.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  });
  return { button, menu };
}

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${what} copied`, { icon: "copy" });
  } catch {
    showToast(`Couldn't copy the ${what.toLowerCase()}`, { icon: "copy" });
  }
}

// ---------- a booking ----------

/** One end of a booking: its time (or day), the day when it isn't the itinerary's, its city, and (for a journey) its place. */
function moment(m: LocalMoment, label: string, opts: { showDay: boolean; showPlace: boolean; showZone?: boolean; align?: "end" }): HTMLElement {
  const under = [opts.showDay && m.time ? shortWeekday(m.date) : "", opts.showZone === false ? "" : zoneCity(m)].filter(Boolean).join(" · ");
  return h(
    "div",
    { class: `leg__end${opts.align === "end" ? " leg__end--to" : ""}` },
    h("span", { class: "leg__label" }, label),
    h("span", { class: `leg__clock${m.time ? "" : " leg__clock--day"}` }, m.time ?? shortWeekday(m.date)),
    under ? h("span", { class: "leg__city" }, under) : null,
    opts.showPlace && m.place ? h("span", { class: "leg__place" }, m.place) : null
  );
}

// ---------- a train's live times ----------

/** National Rail's reason, without its preamble: "Delayed by a fault with the signalling system". */
function reasonText(s: TrainStatus): string | null {
  const r = s.reason?.trim().replace(/^this train (?:has been|is being|is) /i, "").replace(/\.$/, "");
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : null;
}

/** The chip: a small live dot, how it's running, and the platform when the board has one. */
function liveChip(s: TrainStatus): HTMLElement {
  const c = trainChip(s);
  const checked = new Date(s.checked_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return h(
    "span",
    { class: "live-chip", "data-tone": c.tone, title: `National Rail, checked at ${checked}` },
    h("span", { class: "live-chip__dot", "aria-hidden": "true" }),
    h("span", { class: "live-chip__state" }, c.label),
    c.platform ? h("span", { class: "live-chip__platform" }, h("span", { class: "live-chip__label" }, "Platform"), c.platform) : null
  );
}

/** A flight's chip: how it's running, as OpenSky sees it (no gates; the terminal is on the card already). */
function flightLiveChip(s: FlightStatus): HTMLElement {
  const c = flightChip(s);
  const checked = new Date(s.checked_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return h(
    "span",
    { class: "live-chip", "data-tone": c.tone, title: `${PROVIDER_NAME[s.provider]}, checked at ${checked}` },
    h("span", { class: "live-chip__dot", "aria-hidden": "true" }),
    h("span", { class: "live-chip__state" }, c.label),
    s.gate ? h("span", { class: "live-chip__platform" }, h("span", { class: "live-chip__label" }, "Gate"), s.gate) : null
  );
}

/** A flight's live state on its card, once the provider has something. */
function fillFlight(card: HTMLElement, slot: HTMLElement, b: Booking): void {
  void loadFlightStatus(b).then((s) => {
    if (!s) return;
    slot.replaceChildren(flightLiveChip(s));
    slot.hidden = false;
    card.dataset.live = s.state;
  });
}

/**
 * Ask for a train's live times and, when there are some, fill the card in:
 * the chip, the expected time under the booked one, and why it's late. With
 * none (off, too far ahead, offline) the card stays exactly as it was.
 */
function fillLive(card: HTMLElement, slot: HTMLElement, b: Booking): void {
  void loadTrainStatus(b).then((s) => {
    // Sample mode answers at once, before the card is on the page: fill it either way.
    if (!s) return;
    slot.replaceChildren(liveChip(s));
    slot.hidden = false;
    card.dataset.live = s.state;
    const depart = card.querySelector<HTMLElement>(".leg__end");
    if (depart && s.expected && s.state === "late") depart.append(h("span", { class: "leg__expected" }, `Expected ${s.expected}`));
    const why = s.state !== "on_time" ? reasonText(s) : null;
    if (why) (slot.parentElement ?? slot).after(h("p", { class: "live-reason" }, why));
  });
}

function bookingCard(b: Booking, ctx: { onArchive: (b: Booking) => void; onEdit: (b: Booking) => void; onDelete: (b: Booking) => void }): HTMLElement {
  const s = bookingStart(b);
  const e = bookingEnd(b);
  const transport = TRANSPORT.has(b.kind);
  const meta = BOOKING_LABEL[b.kind];
  const route = transport && s.city && e?.city ? `${s.city} to ${e.city}` : "";
  const sub = [route, b.provider && b.provider !== b.title ? b.provider : ""].filter(Boolean).join(" · ") || meta.label;
  const { button: more, menu } = menuPopover(b.id, [
    { icon: "pen", label: "Edit booking", run: () => ctx.onEdit(b) },
    { icon: "archive", label: "Archive booking", run: () => ctx.onArchive(b) },
    "sep",
    { icon: "trash", label: "Delete booking", run: () => ctx.onDelete(b), danger: true },
  ]);

  const badge =
    b.status === "cancelled"
      ? h("span", { class: "badge badge--muted" }, "Cancelled")
      : b.status === "changed"
        ? h("span", { class: "badge badge--queued" }, "Time changed")
        : null;

  // The times: departure and arrival with the journey between; check in and out; or just when it starts.
  let times: HTMLElement;
  if (e && (transport || b.kind === "hotel" || b.kind === "car")) {
    const span = transport ? duration(s.at, e.at) : null;
    const days = daysBetween(s.date, e.date);
    times = h(
      "div",
      { class: `leg${transport ? " leg--journey" : ""}` },
      moment(s, meta.start, { showDay: false, showPlace: transport }),
      h(
        "div",
        { class: "leg__between", "aria-hidden": "true" },
        h("span", { class: "leg__line" }),
        transport ? icons[BOOKING_ICON[b.kind]]() : null,
        h("span", { class: "leg__span" }, span ?? (days > 0 ? `${days} ${days === 1 ? (b.kind === "hotel" ? "night" : "day") : b.kind === "hotel" ? "nights" : "days"}` : ""))
      ),
      // A stay ends where it started: its zone is said once, at check in.
      moment(e, meta.end, { showDay: days !== 0, showPlace: transport, showZone: transport || e.tz !== s.tz, align: "end" })
    );
  } else {
    times = h("div", { class: "leg leg--single" }, moment(s, meta.start, { showDay: false, showPlace: false }));
  }
  // Where a stay, a pick-up or a show is: the full address under the times, opening directions.
  const place =
    !transport && s.place
      ? h("a", { class: "booking__place", href: mapsLink(s.place), target: "_blank", rel: "noopener noreferrer", "aria-label": `Directions to ${s.place}` }, icons.pin(), h("span", {}, s.place))
      : null;

  const chips: HTMLElement[] = [];
  if (b.seat) chips.push(h("span", { class: "ticket-chip" }, h("span", { class: "ticket-chip__label" }, "Seat"), b.seat));
  if (b.reference) {
    const ref = h(
      "button",
      { class: "ticket-chip ticket-chip--button", type: "button", "aria-label": `Copy reference ${b.reference}` },
      h("span", { class: "ticket-chip__label" }, "Ref"),
      b.reference,
      icons.copy()
    );
    ref.addEventListener("click", () => void copyText(b.reference, "Reference"));
    chips.push(ref);
  }

  const links: HTMLElement[] = [];
  const email = safeLink(b.email_link);
  // A cancellation email always comes through, so say which one did it.
  const cancelledBy = b.status === "cancelled" && b.cancelled_at ? b.cancelled_at : null;
  const cancelEmail = cancelledBy ? safeLink(b.cancel_email_link) : null;
  if (cancelEmail) links.push(h("a", { class: "link-btn booking__link", href: cancelEmail, target: "_blank", rel: "noopener noreferrer" }, icons.mail(), "Cancellation email"));
  if (email && email !== cancelEmail) links.push(h("a", { class: "link-btn booking__link", href: email, target: "_blank", rel: "noopener noreferrer" }, icons.mail(), cancelEmail ? "Booking email" : "Open the email"));

  const was = b.status === "changed" ? previousTime(b) : null;
  // A train leaving in the next 3 hours, or a flight in its window: room for its live times, filled in once the board or OpenSky answers.
  const live = wantsLiveStatus(b) || wantsFlightStatus(b) ? h("span", { class: "live-slot", role: "status", "aria-live": "polite", hidden: true }) : null;
  const card = h(
    "article",
    { class: "booking card", "data-status": b.status, "data-kind": b.kind },
    h(
      "header",
      { class: "booking__head" },
      h("span", { class: "tile tile--sm booking__icon" }, icons[BOOKING_ICON[b.kind]]()),
      h(
        "span",
        { class: "booking__titles" },
        h("span", { class: "booking__title-line" }, h("span", { class: "booking__title" }, b.title || meta.label), badge),
        h("span", { class: "booking__sub" }, sub)
      ),
      more,
      menu
    ),
    times,
    was ? h("p", { class: "booking__was" }, icons.clock(), `Moved from ${was}`) : null,
    cancelledBy ? h("p", { class: "booking__was booking__was--cancelled" }, icons.mail(), `Cancelled by email, ${shortDate(cancelledBy)}`) : null,
    place,
    live || chips.length || b.details ? h("div", { class: "booking__meta" }, live, ...chips, b.details ? h("span", { class: "booking__details" }, b.details) : null) : null,
    links.length ? h("footer", { class: "booking__links" }, ...links) : null
  );
  if (live) (b.kind === "flight" ? fillFlight : fillLive)(card, live, b);
  return card;
}

/** An empty itinerary: one tap to add the first booking of each kind. */
function kindPicker(add: (kind: BookingKind) => void, fresh: boolean): HTMLElement {
  const kinds: BookingKind[] = ["flight", "train", "hotel", "car", "event"];
  return h(
    "div",
    { class: "kind-pick" },
    h("p", { class: "kind-pick__lede" }, fresh ? "Nothing booked yet. What's first?" : "No bookings left in this trip. Archived ones are on the Archived page."),
    h(
      "div",
      { class: "kind-pick__grid" },
      ...kinds.map((k) => {
        const b = h("button", { class: "kind-pick__item", type: "button" }, h("span", { class: "kind-pick__icon", "aria-hidden": "true" }, icons[BOOKING_ICON[k]]()), BOOKING_LABEL[k].label);
        b.addEventListener("click", () => add(k));
        return b;
      })
    )
  );
}

// ---------- a trip ----------

export interface TripDetail {
  el: HTMLElement;
  tripId: () => string;
  destroy: () => void;
}

export function tripDetail(initial: Trip, ctx: { close: () => void }): TripDetail {
  let trip = initial;
  let dead = false;
  const today = localToday();
  const now = new Date();

  const title = h("textarea", { class: "note__title-input profile__name", name: "title", rows: 1, maxlength: 120, "aria-label": "Trip name" }) as HTMLTextAreaElement;
  title.value = trip.title;
  const grow = (el: HTMLTextAreaElement, min = 0) => {
    el.style.height = "auto";
    el.style.height = `${Math.max(min, el.scrollHeight)}px`;
  };
  title.addEventListener("input", () => grow(title));
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      title.blur();
    }
  });
  title.addEventListener("change", () => {
    const v = title.value.trim();
    if (!v) return void (title.value = trip.title);
    void save({ title: v });
  });

  const notes = h("textarea", { class: "prop__input prop__textarea", name: "notes", rows: 2, placeholder: "Door codes, who's picking you up, what to pack", "aria-label": "Notes" }) as HTMLTextAreaElement;
  notes.value = trip.notes;
  notes.addEventListener("input", () => grow(notes, 64));
  notes.addEventListener("change", () => void save({ notes: notes.value }));

  async function save(patch: { title?: string; notes?: string }) {
    try {
      trip = { ...(await updateTrip(trip.id, patch)), bookings: trip.bookings };
      paint();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
    }
  }

  async function archiveTrip() {
    const { id } = trip;
    try {
      await setLogisticsArchived("trip", id, true);
      dead = true;
      ctx.close();
      showToast("Trip archived", { icon: "archive", action: { label: "Undo", run: () => void setLogisticsArchived("trip", id, false) } });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't archive", { icon: "wifiOff" });
    }
  }

  async function removeTrip() {
    const ok = await confirmDialog({
      title: `Delete ${trip.title} permanently?`,
      body: "The trip and all its bookings are removed from Athena. Your emails aren't touched. This can't be undone.",
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteLogisticsForever("trip", trip.id);
      dead = true;
      ctx.close();
      showToast("Deleted permanently", { icon: "trash" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't delete", { icon: "wifiOff" });
    }
  }

  async function archiveBooking(b: Booking) {
    try {
      await setLogisticsArchived("booking", b.id, true);
      showToast(`${bookingName(b)} archived`, { icon: "archive", action: { label: "Undo", run: () => void setLogisticsArchived("booking", b.id, false) } });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't archive", { icon: "wifiOff" });
    }
  }

  async function removeBooking(b: Booking) {
    const ok = await confirmDialog({
      title: `Delete ${bookingName(b)}?`,
      body: "It's removed from this trip for good.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteLogisticsForever("booking", b.id);
      showToast(`Deleted ${bookingName(b)}`, { icon: "trash" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't delete", { icon: "wifiOff" });
    }
  }

  const addBooking = (kind?: BookingKind) => openBookingForm(trip, null, { kind });

  const { button: more, menu } = menuPopover(trip.id, [
    { icon: "plus", label: "Add booking", run: () => addBooking() },
    { icon: "calendar", label: trip.source === "manual" ? "Edit trip" : "Trip details", run: () => openTripForm(trip) },
    "sep",
    { icon: "archive", label: "Archive trip", run: () => void archiveTrip() },
    "sep",
    { icon: "trash", label: "Delete permanently", run: () => void removeTrip(), danger: true },
  ]);

  const sub = h("p", { class: "profile__sub" });
  const facts = h("div", { class: "profile__facts" });
  const itinerary = h("div", { class: "itinerary" });
  const foot = h("footer", { class: "note__foot" });
  const addBtn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Add booking");
  addBtn.addEventListener("click", () => addBooking());
  const addRow = h("div", { class: "itinerary__add" }, addBtn);

  function paint() {
    if (dead) return;
    const bookings = live(trip);
    const parts = [tripDates(trip.starts_on, trip.ends_on, today), nights(trip), bookings.length ? `${bookings.length} ${bookings.length === 1 ? "booking" : "bookings"}` : ""].filter(Boolean);
    sub.replaceChildren(...parts.flatMap((p, i) => (i ? [h("span", { class: "profile__dot", "aria-hidden": "true" }, "·"), p] : [p])));
    facts.replaceChildren(...tripFacts(trip, today, now));
    facts.hidden = !facts.childElementCount;

    // Day by day, by the local day each booking starts.
    const days = new Map<string, Booking[]>();
    for (const b of bookings) {
      const day = bookingStart(b).date;
      days.set(day, [...(days.get(day) ?? []), b]);
    }
    itinerary.replaceChildren(
      ...(bookings.length
        ? [...days].map(([day, list]) => {
            const n = daysBetween(today, day);
            const label = Math.abs(n) <= 1 ? `${dayWord(day, today)} · ${longDay(day)}` : longDay(day);
            return h(
              "section",
              { class: "itinerary__day", "data-past": day < today ? "" : undefined },
              h("h3", { class: "itinerary__label" }, label),
              ...list.map((b) => bookingCard(b, { onArchive: (x) => void archiveBooking(x), onEdit: (x) => openBookingForm(trip, x), onDelete: (x) => void removeBooking(x) }))
            );
          })
        : [kindPicker(addBooking, trip.source === "manual")])
    );
    addRow.hidden = !bookings.length;
    foot.textContent = [trip.source === "manual" ? "Added by you" : trip.source ? `From ${sourceText(trip.source)}` : "", `Added ${shortDate(trip.created_at)}`, `Updated ${relativeTime(trip.updated_at)}`].filter(Boolean).join(" · ");
  }

  const el = h(
    "article",
    { class: "note profile trip-detail" },
    h(
      "header",
      { class: "profile__hero" },
      h("div", { class: "profile__top" }, h("span", { class: "tile tile--hero", "aria-hidden": "true" }, icons.suitcase()), h("span", { class: "note__bar-spacer" }), more, menu),
      title,
      sub
    ),
    facts,
    h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Itinerary"), itinerary, addRow),
    h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Notes"), notes),
    foot
  );
  paint();
  requestAnimationFrame(() => {
    grow(title);
    grow(notes, 64);
  });

  const unsub = onLogisticsChange(async (topic) => {
    if (dead || topic === "purchase") return;
    const fresh = await findTrip(trip.id);
    if (!fresh) return;
    trip = fresh;
    paint();
  });

  return {
    el,
    tripId: () => trip.id,
    destroy() {
      dead = true;
      unsub();
    },
  };
}

/** A trip in a sheet: a phone, and Home's Coming up on a phone. */
export async function openTripSheet(tripOrId: Trip | string): Promise<void> {
  const trip = typeof tripOrId === "string" ? await findTrip(tripOrId) : tripOrId;
  if (!trip) {
    showToast("That trip isn't available. It may be archived", { icon: "archive" });
    return;
  }
  let view: TripDetail | null = null;
  const sheet = openSheet({ label: trip.title, body: h("div", {}), variant: "tall", onClose: () => view?.destroy() });
  view = tripDetail(trip, { close: () => sheet.close() });
  sheet.dialog.querySelector(".sheet__scroll")!.replaceChildren(view.el);
}

// ---------- the page ----------

export interface TripsContext {
  tripId: string | null;
  isDesktop: () => boolean;
  go: (view: ViewId) => void;
  onSelectionChange: (id: string | null) => void;
}

/** A small calendar page: "NOV" over "12". */
function dateTile(date: string | null): HTMLElement {
  if (!date) return h("span", { class: "tile tile--sm" }, icons.suitcase());
  const { month, day } = monthDay(date);
  return h("span", { class: "date-tile", "aria-hidden": "true" }, h("span", { class: "date-tile__month" }, month), h("span", { class: "date-tile__day" }, day));
}

export function renderTrips(ctx: TripsContext): { el: HTMLElement; destroy: () => void } {
  let items: Trip[] = [];
  let loaded = false;
  let selectedId = ctx.tripId;
  let pendingSheet = !ctx.isDesktop() ? ctx.tripId : null;

  const count = h("span", { class: "page-count" });
  const newBtn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "New");
  const addTrip = () => openTripForm(null, { onCreated: (t) => open(t) });
  newBtn.addEventListener("click", addTrip);
  const head = pageHead({
    segments: librarySegments("trips", ctx.go),
    title: "Trips",
    count,
    actions: [newBtn],
    lede: "Flights, trains, hotels, car hire and tickets, grouped into trips. Add your own, or let booking emails bring them in.",
  });
  const list = h("div", { class: "notes__list" });
  const col = h("div", { class: "notes__col" }, head, list);
  const pane = h("section", { class: "notes__pane", "aria-label": "Trip" });
  const el = h("div", { class: "view notes records trips" }, col, pane);

  let paneView: TripDetail | null = null;
  const clearPane = () => {
    paneView?.destroy();
    paneView = null;
  };
  function showInPane(t: Trip) {
    if (paneView?.tripId() === t.id) return;
    clearPane();
    paneView = tripDetail(t, {
      close: () => {
        clearPane();
        selectedId = null;
        ctx.onSelectionChange(null);
        paint();
      },
    });
    pane.replaceChildren(paneView.el);
    pane.scrollTop = 0;
  }

  function open(t: Trip) {
    if (!ctx.isDesktop()) return void openTripSheet(t);
    selectedId = t.id;
    ctx.onSelectionChange(t.id);
    showInPane(t);
    list.querySelectorAll<HTMLElement>(".row").forEach((r) => (r.dataset.id === t.id ? r.setAttribute("aria-current", "true") : r.removeAttribute("aria-current")));
  }

  function row(t: Trip, today: string): HTMLElement {
    const when = whenLabel(t, today);
    const kinds = [...new Set(going(t).map((b) => b.kind))];
    const b = h(
      "button",
      { class: "row trip-row", type: "button", "data-id": t.id, "aria-current": t.id === selectedId ? "true" : undefined },
      dateTile(t.starts_on),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title-line" }, h("span", { class: "row__title" }, t.title)),
        h(
          "span",
          { class: "row__meta trip-row__meta" },
          [tripDates(t.starts_on, t.ends_on, today), nights(t)].filter(Boolean).join(" · "),
          kinds.length ? h("span", { class: "trip-row__kinds", "aria-label": kinds.map((k) => BOOKING_LABEL[k].label).join(", ") }, ...kinds.map((k) => icons[BOOKING_ICON[k]]())) : null
        )
      ),
      when ? h("span", { class: `row__time${when.accent ? " row__time--accent" : ""}` }, when.text) : h("span", {})
    );
    b.addEventListener("click", () => open(t));
    return b;
  }

  function paint() {
    if (!loaded) return;
    const today = localToday();
    const upcoming = items.filter((t) => !t.ends_on || t.ends_on >= today);
    const past = items.filter((t) => t.ends_on && t.ends_on < today);
    count.textContent = upcoming.length ? String(upcoming.length) : "";
    if (!items.length) {
      const add = h("button", { class: "btn btn--primary", type: "button" }, icons.plus(), "Add a trip");
      add.addEventListener("click", addTrip);
      const setup = h("button", { class: "btn btn--ghost", type: "button" }, icons.plug(), "Connect your email");
      setup.addEventListener("click", () => (location.hash = "#/settings/accounts"));
      list.replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("span", { class: "tile" }, icons.suitcase()),
          h("p", { class: "empty__title" }, "No trips yet"),
          h("p", { class: "empty__sub" }, "Add one here, or tell Athena in Ask. Booking emails show up here too once your email is connected."),
          h("div", { class: "empty__actions" }, add, setup)
        )
      );
    } else {
      list.replaceChildren(
        upcoming.length
          ? h("section", { class: "group" }, h("h2", { class: "group__label" }, "Upcoming", h("span", { class: "group__count" }, String(upcoming.length))), h("div", { class: "card card--flush list" }, ...upcoming.map((t) => row(t, today))))
          : h("div", { class: "empty empty--inline" }, h("p", { class: "empty__sub" }, "Nothing booked ahead. Add a trip, or a new booking email will start one.")),
        ...(past.length
          ? [
              h(
                "details",
                { class: "group group--done" },
                h("summary", { class: "group__label" }, icons.chevronRight(), "Past", h("span", { class: "group__count" }, String(past.length))),
                h("div", { class: "card card--flush list" }, ...past.map((t) => row(t, today)))
              ),
            ]
          : [])
      );
    }

    if (ctx.isDesktop()) {
      const current = items.find((t) => t.id === selectedId);
      if (current) showInPane(current);
      // Just added: an older reload may land before the one that has it.
      else if (selectedId && paneView?.tripId() === selectedId) {
        /* keep it */
      } else {
        clearPane();
        pane.replaceChildren(
          h(
            "div",
            { class: "pane-empty" },
            h(
              "div",
              { class: "empty" },
              h("span", { class: "tile" }, icons.suitcase()),
              h("p", { class: "empty__title" }, items.length ? "Nothing selected" : "Your trips will appear here"),
              h("p", { class: "empty__sub" }, items.length ? "Pick a trip on the left to see its itinerary." : "Each one shows its itinerary day by day, in the local time of every place.")
            )
          )
        );
      }
    }
    // A deep link to a trip on a phone (a push, or Coming up) opens its sheet once.
    if (pendingSheet) {
      const t = items.find((x) => x.id === pendingSheet);
      pendingSheet = null;
      ctx.onSelectionChange(null);
      if (t) void openTripSheet(t);
    }
  }

  async function load() {
    const { items: loadedItems } = await loadTrips();
    items = loadedItems;
    loaded = true;
    paint();
  }

  list.replaceChildren(
    h("div", { class: "card card--flush list" }, ...[0, 1].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:50%" })), h("span", {}))))
  );
  void load();
  const unsub = onLogisticsChange((topic) => topic !== "purchase" && void load());

  const onScroll = () => head.classList.toggle("is-scrolled", (ctx.isDesktop() ? col.scrollTop : window.scrollY) > 4);
  const target: EventTarget = ctx.isDesktop() ? col : window;
  target.addEventListener("scroll", onScroll, { passive: true });

  return {
    el,
    destroy: () => {
      unsub();
      clearPane();
      target.removeEventListener("scroll", onScroll);
    },
  };
}
