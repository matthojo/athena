/**
 * Adding and editing trips, bookings and orders by hand: the same editor
 * sheet as Life admin and Goals (a big title, compact rows, Add at the foot).
 * A new one is made by Add; an existing one saves each field as it changes.
 *
 * Times are typed in the local time of where each thing happens, and the
 * time zone follows the city you type ("Lisbon" -> Lisbon time), so a flight
 * reads as it does on the ticket. You can still pick the zone yourself.
 *
 * Built only with h() and text nodes.
 */

import "../styles/trips.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { openEditorSheet } from "../components/editor-sheet";
import { autoTextarea, choiceChips, field, input, select } from "../components/fields";
import { showToast } from "../components/toast";
import { addBooking, createPurchase, createTrip, deleteLogisticsForever, editBooking, editPurchase, setLogisticsArchived, updateTrip } from "../db/trips";
import { relativeTime } from "../lib/format";
import { deviceZone, localToday } from "../lib/time";
import { BOOKING_ICON } from "../lib/trips-meta";
import { BOOKING_LABEL, PURCHASE_LABEL, PURCHASE_STATUSES, TRANSPORT, bookingName, purchaseName } from "../../../lib/trip-text";
import { CARRIERS, trackingLink } from "../../../lib/carriers";
import { zonedParts } from "../../../lib/dates";
import type { Booking, BookingFields, BookingKind, Purchase, PurchaseFields, Trip } from "../types";

// ---------- time zones, from the city ----------

/** Cities whose zone isn't named after them. */
const CITY_ZONE: Record<string, string> = {
  porto: "Europe/Lisbon",
  faro: "Europe/Lisbon",
  funchal: "Atlantic/Madeira",
  manchester: "Europe/London",
  edinburgh: "Europe/London",
  glasgow: "Europe/London",
  bristol: "Europe/London",
  birmingham: "Europe/London",
  leeds: "Europe/London",
  liverpool: "Europe/London",
  newcastle: "Europe/London",
  cardiff: "Europe/London",
  belfast: "Europe/London",
  cornwall: "Europe/London",
  barcelona: "Europe/Madrid",
  seville: "Europe/Madrid",
  valencia: "Europe/Madrid",
  malaga: "Europe/Madrid",
  ibiza: "Europe/Madrid",
  mallorca: "Europe/Madrid",
  palma: "Europe/Madrid",
  tenerife: "Atlantic/Canary",
  "gran canaria": "Atlantic/Canary",
  lanzarote: "Atlantic/Canary",
  nice: "Europe/Paris",
  lyon: "Europe/Paris",
  marseille: "Europe/Paris",
  bordeaux: "Europe/Paris",
  florence: "Europe/Rome",
  venice: "Europe/Rome",
  milan: "Europe/Rome",
  naples: "Europe/Rome",
  munich: "Europe/Berlin",
  frankfurt: "Europe/Berlin",
  hamburg: "Europe/Berlin",
  cologne: "Europe/Berlin",
  geneva: "Europe/Zurich",
  krakow: "Europe/Warsaw",
  salzburg: "Europe/Vienna",
  "new york city": "America/New_York",
  nyc: "America/New_York",
  boston: "America/New_York",
  washington: "America/New_York",
  miami: "America/New_York",
  "san francisco": "America/Los_Angeles",
  "las vegas": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  "los angeles": "America/Los_Angeles",
  montreal: "America/Toronto",
  marrakech: "Africa/Casablanca",
  bali: "Asia/Makassar",
  "abu dhabi": "Asia/Dubai",
  kyoto: "Asia/Tokyo",
  osaka: "Asia/Tokyo",
  beijing: "Asia/Shanghai",
  "cape town": "Africa/Johannesburg",
  "hong kong": "Asia/Hong_Kong",
  "mexico city": "America/Mexico_City",
};

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["Europe/London", "Europe/Lisbon", "Europe/Paris", "Europe/Madrid", "Europe/Rome", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"];
  }
})();

/** "Europe/Lisbon" -> "Lisbon", "America/New_York" -> "New York". */
export function zoneCity(tz: string): string {
  return (tz.split("/").pop() ?? tz).replace(/_/g, " ");
}

const cityKey = (s: string) => s.trim().toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
const BY_CITY = new Map(ZONES.map((z) => [cityKey(zoneCity(z)), z]));

/** The zone a city is in, when Athena can tell: "Lisbon", "Porto", "New York". */
export function zoneForCity(city: string): string | null {
  const key = cityKey(city.split(",")[0] ?? "");
  if (!key) return null;
  return CITY_ZONE[key] ?? BY_CITY.get(key) ?? null;
}

/** A zone picker that reads like the itinerary: "Lisbon time". The ones you're likely to want come first. */
function zonePicker(value: string, label: string): HTMLSelectElement {
  const first = [...new Set([value, deviceZone()].filter(Boolean))];
  const rest = ZONES.filter((z) => !first.includes(z) && z.includes("/")).sort((a, b) => zoneCity(a).localeCompare(zoneCity(b)));
  const el = h(
    "select",
    { class: "tz-pick", "aria-label": label },
    ...first.map((z) => h("option", { value: z }, `${zoneCity(z)} time`)),
    h("optgroup", { label: "All time zones" }, ...rest.map((z) => h("option", { value: z }, `${zoneCity(z)} time`)))
  ) as HTMLSelectElement;
  el.value = value;
  return el;
}

/** A day, an optional time and the zone they're in: one end of a booking. */
interface When {
  el: HTMLElement;
  date: HTMLInputElement;
  time: HTMLInputElement;
  zone: () => string;
  setZone: (tz: string) => void;
  /** The zone was picked by hand: typing a city no longer moves it. */
  pinned: () => boolean;
  local: () => string;
}

function whenControl(label: string, local: string, tz: string, onChange: () => void): When {
  const [d, t] = local.split("T");
  const date = input("date", d ?? "", { "aria-label": `${label} day` });
  const time = input("time", t ?? "", { "aria-label": `${label} time`, class: "prop__input when__time" });
  let pinned = false;
  let zone = zonePicker(tz || deviceZone(), `${label} time zone`);
  const zoneWrap = h("span", { class: "when__zone" }, icons.clock(), zone);
  const wire = () =>
    zone.addEventListener("change", () => {
      pinned = true;
      onChange();
    });
  wire();
  date.addEventListener("change", onChange);
  time.addEventListener("change", onChange);
  date.addEventListener("input", () => (date.dataset.touched = "1"));
  return {
    el: h("span", { class: "when" }, date, h("span", { class: "when__row" }, time, zoneWrap)),
    date,
    time,
    zone: () => zone.value,
    setZone(next) {
      if (!next || next === zone.value) return;
      const fresh = zonePicker(next, `${label} time zone`);
      zone.replaceWith(fresh);
      zone = fresh;
      wire();
    },
    pinned: () => pinned,
    local: () => (date.value ? `${date.value}${time.value ? `T${time.value}` : ""}` : ""),
  };
}

// ---------- a trip ----------

/** New or existing: where it's to, its dates (on one you added) and notes. */
export function openTripForm(trip: Trip | null, opts: { onCreated?: (trip: Trip) => void } = {}): void {
  let rec = trip;
  const own = !trip || trip.source === "manual";
  const today = localToday();
  const starts = input("date", trip?.starts_on ?? "", { "aria-label": "First day", min: trip ? undefined : today });
  const ends = input("date", trip?.ends_on ?? "", { "aria-label": "Last day" });
  const notes = autoTextarea(trip?.notes ?? "", { name: "notes", placeholder: "Door codes, who's picking you up", "aria-label": "Notes" }, 44);
  starts.addEventListener("change", () => {
    ends.min = starts.value;
    if (starts.value && (!ends.value || ends.value < starts.value)) ends.value = starts.value;
    if (rec) void save({ starts_on: starts.value || null, ends_on: ends.value || null });
  });
  ends.addEventListener("change", () => rec && void save({ starts_on: starts.value || null, ends_on: ends.value || null }));
  notes.addEventListener("change", () => rec && void save({ notes: notes.value }));
  if (!own) {
    starts.disabled = true;
    ends.disabled = true;
  }

  async function save(patch: Parameters<typeof updateTrip>[1]) {
    if (!rec) return;
    try {
      rec = { ...(await updateTrip(rec.id, patch)), bookings: rec.bookings };
      starts.value = rec.starts_on ?? "";
      ends.value = rec.ends_on ?? "";
      editor.refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
    }
  }

  const fields = h("div", { class: "card card--flush fields logi-form" }, field("From", starts), field("To", ends), field("Notes", notes));
  const sections: HTMLElement[] = [fields];
  if (!own) sections.push(h("p", { class: "sheet-hint" }, icons.calendar(), "This trip came from your email, so its dates follow its bookings."));
  else if (!trip) sections.push(h("p", { class: "sheet-hint" }, icons.plane(), "Add flights, hotels and tickets once it's saved."));

  const editor = openEditorSheet({
    newLabel: "New trip",
    isNew: !trip,
    titleValue: trip?.title ?? "",
    placeholder: "Where to?",
    mark: h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.suitcase()),
    sections,
    createLabel: "Add trip",
    onTitle: (title) => void save({ title }),
    create: async () => {
      const made = await createTrip({ title: editor.title.value.trim(), starts_on: starts.value || null, ends_on: ends.value || null, notes: notes.value });
      showToast(`Added ${made.title}`, { icon: "suitcase" });
      if (opts.onCreated) afterClose(editor.sheet.dialog, () => opts.onCreated!(made));
      return true;
    },
    status: () => (rec ? `Updated ${relativeTime(rec.updated_at)}` : ""),
  });
  editor.title.maxLength = 120;
}

// ---------- a booking ----------

/**
 * Run once the sheet has gone: closing it steps browser history back, which
 * would undo a route change (opening the new item) made any earlier.
 */
function afterClose(dialog: HTMLDialogElement, run: () => void) {
  dialog.addEventListener("close", () => setTimeout(run, 60), { once: true });
}

/** What each kind calls its parts. */
const KIND_WORDS: Record<BookingKind, { name: string; provider?: string; place: string; endPlace?: string; detail?: string; seat: boolean; endTime: boolean }> = {
  flight: { name: "Flight number, like TP 1351", provider: "Airline", place: "Airport", detail: "Bags, terminal", seat: true, endTime: true },
  train: { name: "Train, like Eurostar 9014", provider: "Operator", place: "Station", detail: "Coach, how many", seat: true, endTime: true },
  hotel: { name: "Hotel name", place: "Address", detail: "Room, breakfast", seat: false, endTime: true },
  car: { name: "Company, like Hertz", place: "Pick-up desk", endPlace: "Drop-off", detail: "Car, extras", seat: false, endTime: true },
  event: { name: "What it's for", place: "Venue", detail: "How many tickets", seat: true, endTime: false },
  other: { name: "What it is", place: "Where", detail: "Details", seat: false, endTime: true },
};

const KINDS: BookingKind[] = ["flight", "train", "hotel", "car", "event", "other"];

/** The most likely next booking for a trip: out, then back; a stay across the trip. */
function guess(trip: Trip, kind: BookingKind): Partial<BookingFields> {
  const home = zoneCity(deviceZone());
  const dest = trip.title.split(",")[0].trim();
  const first = trip.starts_on ?? localToday();
  const last = trip.ends_on ?? first;
  const destZone = zoneForCity(dest) ?? deviceZone();
  if (TRANSPORT.has(kind)) {
    const out = trip.bookings.find((b) => b.kind === kind && !b.archived_at && b.end_city && cityKey(b.end_city) === cityKey(dest));
    if (out) {
      return { start_city: dest, start_tz: out.end_tz || destZone, end_city: out.start_city, end_tz: out.start_tz, start_local: last, end_local: last, start_place: out.end_place, end_place: out.start_place, provider: out.provider };
    }
    return { start_city: home, start_tz: deviceZone(), end_city: dest, end_tz: destZone, start_local: first, end_local: first };
  }
  return { start_city: dest, start_tz: destZone, end_tz: destZone, start_local: first, end_local: kind === "event" ? "" : last };
}

/** Add a booking to a trip, or change one (email ones too). */
export function openBookingForm(trip: Trip, booking: Booking | null, opts: { kind?: BookingKind } = {}): void {
  let rec = booking;
  let kind: BookingKind = booking?.kind ?? opts.kind ?? "flight";
  const start = booking ? fieldsOf(booking) : { ...blank(kind), ...guess(trip, kind) };

  const provider = input("text", start.provider ?? "", { autocomplete: "off" });
  const reference = input("text", start.reference ?? "", { autocomplete: "off", autocapitalize: "characters", spellcheck: false });
  const seat = input("text", start.seat ?? "", { autocomplete: "off" });
  const details = input("text", start.details ?? "", { autocomplete: "off" });
  const fromCity = input("text", start.start_city ?? "", { autocomplete: "off", placeholder: "City" });
  const fromPlace = input("text", start.start_place ?? "", { autocomplete: "off" });
  const toCity = input("text", start.end_city ?? "", { autocomplete: "off", placeholder: "City" });
  const toPlace = input("text", start.end_place ?? "", { autocomplete: "off" });
  const changed = () => rec && void save();
  const from = whenControl("Starts", start.start_local ?? "", start.start_tz ?? "", changed);
  const to = whenControl("Ends", start.end_local ?? "", start.end_tz || start.start_tz || "", changed);
  const cancelled = choiceChips(
    "Status",
    [
      { value: "confirmed", label: "Booked" },
      { value: "cancelled", label: "Cancelled" },
    ],
    booking?.status === "cancelled" ? "cancelled" : "confirmed",
    () => changed()
  );

  // A city you type sets its zone, until you pick one yourself.
  const follow = (city: HTMLInputElement, when: When, also?: When) =>
    city.addEventListener("input", () => {
      const tz = zoneForCity(city.value);
      if (tz && !when.pinned()) when.setZone(tz);
      if (tz && also && !also.pinned()) also.setZone(tz);
    });
  follow(fromCity, from);
  follow(toCity, to);
  // A stay starts and ends in one place.
  fromCity.addEventListener("input", () => {
    if (!TRANSPORT.has(kind) && !to.pinned()) to.setZone(from.zone());
  });
  for (const el of [provider, reference, seat, details, fromCity, fromPlace, toCity, toPlace]) el.addEventListener("change", changed);
  from.date.addEventListener("change", () => {
    if (from.date.value && (!to.date.value || to.date.value < from.date.value) && (TRANSPORT.has(kind) || kind === "car")) to.date.value = from.date.value;
    to.date.min = from.date.value;
  });

  const rows = {
    provider: field("Airline", provider),
    fromCity: field("From", fromCity),
    fromPlace: field("Airport", fromPlace),
    from: field("Departs", from.el),
    toCity: field("To", toCity),
    toPlace: field("Airport", toPlace),
    to: field("Arrives", to.el),
    reference: field("Reference", reference),
    seat: field("Seat", seat),
    details: field("Details", details),
    status: field("Status", cancelled.el),
  };
  rows.from.classList.add("prop--when");
  rows.to.classList.add("prop--when");
  const label = (row: HTMLElement, text: string) => ((row.querySelector(".prop__label") as HTMLElement).textContent = text);
  const startCard = h("div", { class: "card card--flush fields" });
  const endCard = h("div", { class: "card card--flush fields" });
  const moreCard = h("div", { class: "card card--flush fields" });
  const startLabel = h("h3", { class: "group__label booking-form__label" });
  const endLabel = h("h3", { class: "group__label booking-form__label" });

  /** Rows and words for the kind. */
  function shape() {
    const w = KIND_WORDS[kind];
    const words = BOOKING_LABEL[kind];
    const transport = TRANSPORT.has(kind);
    editor.title.placeholder = w.name;
    label(rows.provider, w.provider ?? "With");
    label(rows.fromPlace, w.place);
    label(rows.toPlace, w.endPlace ?? w.place);
    label(rows.from, words.start);
    label(rows.to, words.end);
    label(rows.details, "Details");
    details.placeholder = w.detail ?? "";
    fromPlace.placeholder = transport ? (kind === "flight" ? "Heathrow, Terminal 2" : "St Pancras") : kind === "hotel" ? "Street and number" : "";
    startLabel.textContent = transport ? "From" : kind === "hotel" ? "Where and when" : kind === "car" ? "Pick up" : "When and where";
    endLabel.textContent = transport ? "To" : kind === "car" ? "Drop off" : "Ends";
    startCard.replaceChildren(...(transport ? [rows.fromCity, rows.fromPlace, rows.from] : [rows.fromPlace, rows.fromCity, rows.from]));
    endCard.replaceChildren(...(transport ? [rows.toCity, rows.toPlace, rows.to] : kind === "car" ? [rows.toPlace, rows.to] : [rows.to]));
    endLabel.hidden = !w.endTime && !booking?.end_date;
    endCard.hidden = endLabel.hidden;
    moreCard.replaceChildren(...[w.provider ? rows.provider : null, rows.reference, w.seat ? rows.seat : null, rows.details, rec ? rows.status : null].filter((x): x is HTMLElement => !!x));
    mark.replaceChildren(icons[BOOKING_ICON[kind]]());
  }

  function fields(): BookingFields {
    const transport = TRANSPORT.has(kind);
    const endLocal = endCard.hidden ? "" : to.local();
    return {
      kind,
      status: cancelled.value() === "cancelled" ? "cancelled" : rec?.status === "changed" ? "changed" : "confirmed",
      title: editor.title.value.trim(),
      provider: KIND_WORDS[kind].provider ? provider.value.trim() : "",
      reference: reference.value.trim(),
      segment: rec?.segment ?? "",
      start_local: from.local(),
      start_tz: from.zone(),
      start_place: fromPlace.value.trim(),
      start_city: fromCity.value.trim(),
      end_local: endLocal,
      end_tz: endLocal ? (transport ? to.zone() : from.zone()) : "",
      end_place: transport || kind === "car" ? toPlace.value.trim() : "",
      end_city: transport ? toCity.value.trim() : "",
      seat: KIND_WORDS[kind].seat ? seat.value.trim() : "",
      details: details.value.trim(),
    };
  }

  let saving: Promise<void> = Promise.resolve();
  function save() {
    saving = saving.then(async () => {
      if (!rec) return;
      const f = fields();
      if (!f.start_local) return;
      try {
        rec = await editBooking(rec, f);
        editor.refresh();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
      }
    });
  }

  const picker = choiceChips(
    "Kind",
    KINDS.map((k) => ({ value: k, label: k === "other" ? "Other" : BOOKING_LABEL[k].label, icon: icons[BOOKING_ICON[k]]() })),
    kind,
    (next) => {
      kind = next;
      if (!rec) {
        // A fresh guess for the new kind, unless you've typed something there.
        const g = guess(trip, kind);
        if (!fromCity.value || fromCity.dataset.guessed) (fromCity.value = g.start_city ?? ""), (fromCity.dataset.guessed = "1");
        if (!toCity.value || toCity.dataset.guessed) (toCity.value = g.end_city ?? ""), (toCity.dataset.guessed = "1");
        if (g.start_tz && !from.pinned()) from.setZone(g.start_tz);
        if (g.end_tz && !to.pinned()) to.setZone(g.end_tz);
        // Dates follow the kind too (a stay runs the whole trip), until you change them.
        if (!from.date.dataset.touched && g.start_local) from.date.value = g.start_local.slice(0, 10);
        if (!to.date.dataset.touched) to.date.value = (g.end_local ?? "").slice(0, 10);
      }
      shape();
      changed();
    }
  );
  picker.el.classList.add("booking-form__kinds");
  const mark = h("span", { class: "tile tile--sm", "aria-hidden": "true" });
  const hint = h("p", { class: "sheet-hint" }, icons.clock(), "Times are local to each place, as on your ticket.");
  // What a later email can still change, once there's a booking to edit.
  const emailHint = booking
    ? h("p", { class: "sheet-hint" }, icons.mail(), booking.source === "manual" ? "Emails about this booking only fill in what's blank." : "What you change here stays. Later emails update the rest.")
    : null;

  const editor = openEditorSheet({
    newLabel: `New booking · ${trip.title}`,
    isNew: !booking,
    titleValue: booking?.title ?? "",
    placeholder: KIND_WORDS[kind].name,
    mark,
    sections: [h("div", { class: "booking-form logi-form" }, picker.el, startLabel, startCard, endLabel, endCard, h("h3", { class: "group__label booking-form__label" }, "Booking"), moreCard, hint, emailHint)],
    createLabel: "Add booking",
    onTitle: () => changed(),
    create: async () => {
      const f = fields();
      if (!f.start_local) {
        showToast(`Add the day it ${kind === "hotel" ? "starts" : TRANSPORT.has(kind) ? "departs" : "starts"}`, { icon: "calendar" });
        from.date.focus();
        return false;
      }
      const { booking: made } = await addBooking(trip.id, f);
      showToast(`Added ${bookingName(made)}`, { icon: BOOKING_ICON[made.kind] });
      return true;
    },
    status: () => (rec ? (rec.source === "manual" ? `Added by you · updated ${relativeTime(rec.updated_at)}` : `Updated ${relativeTime(rec.updated_at)}`) : ""),
    archive: booking
      ? async () => {
          const id = booking.id;
          await setLogisticsArchived("booking", id, true);
          showToast(`${bookingName(booking)} archived`, { icon: "archive", action: { label: "Undo", run: () => void setLogisticsArchived("booking", id, false) } });
        }
      : undefined,
    remove: booking ? { what: bookingName(booking), run: () => deleteLogisticsForever("booking", booking.id) } : undefined,
  });
  editor.title.maxLength = 160;
  shape();
  // The kind chips sit above the title on a new booking: pick first, then name it.
  if (!booking) editor.title.before(picker.el);
  else {
    picker.el.remove();
    startLabel.before(picker.el);
  }
}

function blank(kind: BookingKind): BookingFields {
  return { kind, status: "confirmed", title: "", provider: "", reference: "", segment: "", start_local: "", start_tz: deviceZone(), start_place: "", start_city: "", end_local: "", end_tz: "", end_place: "", end_city: "", seat: "", details: "" };
}

/** A booking's fields in local times, as the server's bookingFields gives them. */
function fieldsOf(b: Booking): BookingFields {
  const local = (date: string | null, at: string | null, tz: string) => {
    if (!date) return "";
    if (!at) return date;
    const p = zonedParts(new Date(at), tz || "UTC");
    return `${p.date}T${p.time}`;
  };
  return {
    kind: b.kind,
    status: b.status,
    title: b.title,
    provider: b.provider,
    reference: b.reference,
    segment: b.segment,
    start_local: local(b.start_date, b.starts_at, b.start_tz),
    start_tz: b.start_tz,
    start_place: b.start_place,
    start_city: b.start_city,
    end_local: local(b.end_date, b.ends_at, b.end_tz || b.start_tz),
    end_tz: b.end_tz || b.start_tz,
    end_place: b.end_place,
    end_city: b.end_city,
    seat: b.seat,
    details: b.details,
  };
}

// ---------- an order ----------

/** Add an order, or change one (email ones too), including its tracking. */
export function openPurchaseForm(purchase: Purchase | null, opts: { focus?: "tracking"; onCreated?: (p: Purchase) => void } = {}): void {
  let rec = purchase;
  const today = localToday();
  const items = autoTextarea((purchase?.items ?? []).join("\n"), { name: "items", placeholder: "One per line", "aria-label": "What you ordered" }, 44);
  const order = input("text", purchase?.order_number ?? "", { autocomplete: "off", spellcheck: false });
  const ordered = input("date", purchase?.ordered_on ?? (purchase ? "" : today), { "aria-label": "Ordered" });
  const expected = input("date", purchase?.expected_on ?? "", { "aria-label": "Arriving" });
  const listId = `carriers-${Math.random().toString(36).slice(2)}`;
  const carrier = input("text", purchase?.carrier ?? "", { autocomplete: "off", list: listId, placeholder: "Royal Mail, DPD, Evri…" });
  const carriers = h("datalist", { id: listId }, ...CARRIERS.map((c) => h("option", { value: c.name })));
  const number = input("text", purchase?.tracking_number ?? "", { autocomplete: "off", autocapitalize: "characters", spellcheck: false });
  const link = input("url", purchase?.tracking_url ?? "", { autocomplete: "off", placeholder: "Only if the shop gave one", inputmode: "url" });
  const status = select(
    "Where it's got to",
    PURCHASE_STATUSES.map((s) => ({ value: s, label: PURCHASE_LABEL[s] })),
    purchase?.status ?? "ordered"
  );

  // Where Track will go, said as you type.
  const trackHint = h("p", { class: "sheet-hint track-hint", "aria-live": "polite" });
  function paintHint() {
    const t = trackingLink({ carrier: carrier.value, tracking_number: number.value, tracking_url: link.value });
    trackHint.replaceChildren(icons.truck(), t ? (t.built ? `Track opens ${t.carrier}'s page for this parcel.` : `Track opens ${t.carrier ? `${t.carrier}'s` : "this"} link.`) : number.value.trim() ? "Add the carrier, or paste the tracking link, and Track will open it." : "Add a tracking number and Track opens the carrier's page.");
    trackHint.classList.toggle("track-hint--ready", !!t);
  }
  for (const el of [carrier, number, link]) el.addEventListener("input", paintHint);
  paintHint();

  function patch(): Partial<PurchaseFields> {
    return {
      items: items.value.split("\n").map((s) => s.trim()).filter(Boolean),
      order_number: order.value.trim(),
      ordered_on: ordered.value || null,
      expected_on: expected.value || null,
      carrier: carrier.value.trim(),
      tracking_number: number.value.trim(),
      tracking_url: link.value.trim(),
      status: status.value as PurchaseFields["status"],
    };
  }
  let saving: Promise<void> = Promise.resolve();
  function save(fields: Partial<PurchaseFields>) {
    saving = saving.then(async () => {
      if (!rec) return;
      try {
        rec = await editPurchase(rec.id, fields);
        editor.refresh();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
      }
    });
  }
  const p = () => patch();
  items.addEventListener("change", () => rec && save({ items: p().items }));
  order.addEventListener("change", () => rec && save({ order_number: p().order_number }));
  ordered.addEventListener("change", () => rec && save({ ordered_on: p().ordered_on }));
  expected.addEventListener("change", () => rec && save({ expected_on: p().expected_on }));
  carrier.addEventListener("change", () => rec && save({ carrier: p().carrier }));
  number.addEventListener("change", () => rec && save({ tracking_number: p().tracking_number }));
  link.addEventListener("change", () => rec && save({ tracking_url: p().tracking_url }));
  status.addEventListener("change", () => rec && save({ status: p().status }));

  const orderCard = h("div", { class: "card card--flush fields logi-form" }, field("Items", items), field("Order no.", order), field("Ordered", ordered), field("Arriving", expected), purchase ? field("Status", status) : null);
  const trackCard = h("div", { class: "card card--flush fields logi-form" }, field("Carrier", carrier, carriers), field("Tracking no.", number), field("Link", link));
  const trackLabel = h("h3", { class: "group__label booking-form__label", id: `${listId}-label` }, "Tracking");

  const editor = openEditorSheet({
    newLabel: "New order",
    isNew: !purchase,
    titleValue: purchase?.retailer ?? "",
    placeholder: "Which shop?",
    mark: h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.parcel()),
    sections: [
      orderCard,
      trackLabel,
      trackCard,
      trackHint,
      // What a later email can still change, once there's an order to edit.
      ...(purchase
        ? [h("p", { class: "sheet-hint" }, icons.mail(), purchase.source === "manual" ? "Delivery emails only update its status and tracking." : "What you change here stays. Later emails update the rest.")]
        : []),
      h("p", { class: "sheet-hint" }, icons.shield(), "Athena doesn't keep prices."),
    ],
    createLabel: "Add order",
    onTitle: (retailer) => save({ retailer }),
    create: async () => {
      const made = await createPurchase({ ...(patch() as PurchaseFields), retailer: editor.title.value.trim(), status: "ordered" });
      showToast(`Added ${purchaseName(made)}`, { icon: "parcel" });
      if (opts.onCreated) afterClose(editor.sheet.dialog, () => opts.onCreated!(made));
      return true;
    },
    status: () => (rec ? (rec.source === "manual" ? `Added by you · updated ${relativeTime(rec.updated_at)}` : `Updated ${relativeTime(rec.updated_at)}`) : ""),
  });
  editor.title.maxLength = 120;
  if (opts.focus === "tracking") {
    requestAnimationFrame(() => {
      trackLabel.scrollIntoView({ block: "start" });
      (number.value ? carrier : number).focus({ preventScroll: true });
    });
  }
}
