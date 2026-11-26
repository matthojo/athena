/**
 * A person, place, organisation or event: the profile shown in the mobile
 * sheet and the desktop Library pane. It reads as a page about someone or
 * somewhere, not a form:
 *
 *  - A hero that fits the kind: a place opens on a still of the spot, a
 *    person on a larger avatar with "Last saw Wednesday, lunch at Dishoom",
 *    an event on its date, an organisation on a calm icon. One primary
 *    action under the name; the rest are in the ··· menu.
 *  - What's coming up (a birthday, a catch-up due, an event's day and RSVP).
 *  - The story: "Together" for a person (person-memory.ts), "Visits" for a
 *    place (place-visits.ts), drawn like Week in review's Seen rows.
 *  - Notes, what mentions it, what it's linked to.
 *  - Details at the end, folded: only the fields that are set, as words;
 *    the empty ones wait behind "Add a detail". A new record shows them all.
 *
 * Every field saves on change (online; see db/records.ts for why these
 * aren't queued offline). Archive and Delete permanently are in the menu.
 *
 * Built only with h() and text nodes — field values can come from agents.
 */

import { placeMenuAcross } from "../lib/menu-place";
import { openAsk } from "../lib/open-ask";
import { openLinked } from "../lib/open-linked";
import { h } from "../lib/dom";
import { setPageName } from "../lib/page-title";
import { icons, type IconName } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { openNoteSheet } from "./note-detail";
import { field, foldedEditor, input, pickerInput, select } from "./fields";
import { openMergeSheet, personMemory, type PersonMemory } from "./person-memory";
import { openDraftSheet } from "./draft-sheet";
import { storyTimeline } from "./record-timeline";
import { lastHereLine, lastSawLine, longDate, namesList, type StoryRow } from "../lib/record-story";
import { localGraphSection, type LocalGraphSection } from "./local-graph";
import { customFieldsSection } from "./custom-fields";
import { canAnswer, rsvpControl } from "./rsvp-control";
import { gettingThere } from "./getting-there";
import { entityIcon } from "../lib/entity-icon";
import { cadenceLabel, calendarDate, DEFAULT_CATCH_UP, dayLabel, daysSince, hueFor, inDays, initials, relativeTime, shortDate } from "../lib/format";
import { markdownToText } from "../lib/markdown-text";
import { sourceText } from "../lib/sources";
import { loadConnections, notesSnapshot, onNotes } from "../db/data";
import { deleteForever, loadRecords, OfflineError, saveRecord, setArchived } from "../db/records";
import { nextOccurrence, daysBetween, yearsSince, isValidDate } from "../../../lib/dates";
import { deviceZone, localToday, whenLocal } from "../lib/time";
import { formatAthenaLink } from "../../../lib/links";
import type { AnyRecord, AthenaEvent, Connection, EntityKind, EventKind, LinkedKind, Organisation, Person, Place, RecordKind } from "../types";
import "../styles/record.css";
import { clockOfDay } from "../lib/clock";

export const RECORD_ICON: Record<RecordKind, IconName> = {
  person: "person",
  place: "pin",
  organisation: "building",
  event: "calendar",
};

export const RECORD_LABEL: Record<RecordKind, string> = {
  person: "Person",
  place: "Place",
  organisation: "Organisation",
  event: "Event",
};


const EVENT_KINDS: { value: EventKind; label: string }[] = [
  { value: "appointment", label: "Appointment" },
  { value: "birthday", label: "Birthday" },
  { value: "anniversary", label: "Anniversary" },
  { value: "deadline", label: "Deadline" },
  { value: "other", label: "Other" },
];

const REMIND_OPTIONS = [
  { days: 0, label: "On the day" },
  { days: 1, label: "Day before" },
  { days: 7, label: "Week before" },
];

const CADENCES = [7, 14, 30, 60, 90, 180, 365];

const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2000, i, 15)))
);

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Home's "Prepare notes" for one meeting: Meeting notes filled from the calendar, People, catch-ups,
 * to-dos and email, opened as a note that saves. The template picker is its own chunk.
 */
export function prepareMeeting(eventId: string, openLink: (kind: EntityKind, id: string) => void): void {
  void import("./templates").then(({ openTemplatePicker }) =>
    openTemplatePicker(
      { openLink, openFilled: (n) => openNoteSheet(null, { openLink, seed: n.body, seedTitle: n.title, keepSeed: true }) },
      { forMeeting: eventId }
    )
  );
}
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface ProfileContext {
  close: () => void;
  openLink: (kind: EntityKind, id: string) => void;
  /** Start a new note whose body begins with this Markdown (a link to the record). */
  compose?: (seed: string) => void;
  /** Fill Meeting notes for this event and open them, as Home's "Prepare notes" does (prepareMeeting). */
  prepare?: (eventId: string) => void;
  /** A brand-new record was created. */
  onCreated?: (kind: RecordKind, record: AnyRecord) => void;
  autofocus?: boolean;
}

export interface ProfileView {
  el: HTMLElement;
  recordId: () => string | null;
  destroy: () => void;
}

export function recordTitle(rec: AnyRecord): string {
  return "name" in rec ? rec.name : rec.title;
}

/** "Turns 35 on 4 March (in 3 days)" for a person's birthday string. */
export function birthdayLine(birthday: string): string {
  const yearKnown = !birthday.startsWith("--");
  const date = yearKnown ? birthday : `2000-${birthday.slice(2)}`;
  const today = localToday();
  const next = nextOccurrence(date, "yearly", today)!;
  const when = `${calendarDate(next)} (${inDays(daysBetween(today, next))})`;
  if (!yearKnown) return `Birthday ${when}`;
  return `Turns ${yearsSince(date, next)} on ${when}`;
}

// ---------- small helpers ----------

export function safeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const hostOf = (url: string) => url.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** "A · B · C" with the dots as separate, unread spans. */
const dotted = (parts: (string | HTMLElement)[]) =>
  parts.flatMap((part, i) => (i ? [h("span", { class: "profile__dot", "aria-hidden": "true" }, "·"), part] : [part]));

/** A coloured status line: what's coming up, or what's overdue. */
function fact(icon: IconName, title: string, detail: string, tone?: "accent" | "warn"): HTMLElement {
  return h(
    "div",
    { class: `fact${tone ? ` fact--${tone}` : ""}` },
    h("span", { class: "fact__icon" }, icons[icon]()),
    h("span", { class: "fact__body" }, h("span", { class: "fact__title" }, title), detail ? h("span", { class: "fact__detail" }, detail) : null)
  );
}

// ---------- the profile ----------

export function recordProfile<K extends RecordKind>(kind: K, initial: AnyRecord | null, ctx: ProfileContext): ProfileView {
  let rec: AnyRecord | null = initial;
  let dead = false;
  let saving: Promise<void> = Promise.resolve();
  const uid = Math.random().toString(36).slice(2);

  // ---------- identity ----------
  const mark = h("span", { "aria-hidden": "true" });
  const nameInput = h("textarea", {
    class: "note__title-input profile__name",
    name: kind === "event" ? "title" : "name",
    rows: 1,
    placeholder: kind === "event" ? "What's happening?" : "Name",
    "aria-label": kind === "event" ? "Title" : "Name",
    maxlength: 200,
  }) as HTMLTextAreaElement;
  nameInput.value = rec ? recordTitle(rec) : "";
  // The tab is called who or what this is (lib/page-title.ts).
  let unnameTab = setPageName(rec ? recordTitle(rec) : null);
  const grow = () => {
    nameInput.style.height = "auto";
    nameInput.style.height = `${nameInput.scrollHeight}px`;
  };
  nameInput.addEventListener("input", () => {
    grow();
    if (kind === "person") paintMark();
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameInput.blur();
    }
  });
  nameInput.addEventListener("change", () => {
    const v = nameInput.value.trim();
    if (!v) {
      if (rec) nameInput.value = recordTitle(rec);
      return;
    }
    save(kind === "event" ? { title: v } : { name: v });
  });

  function paintMark() {
    if (kind === "person") {
      const name = nameInput.value.trim();
      mark.className = "avatar avatar--hero avatar--ring";
      mark.style.setProperty("--h", String(hueFor(name)));
      mark.replaceChildren(name ? initials(name) : icons.person());
      return;
    }
    const ev = kind === "event" ? (rec as AthenaEvent | null) : null;
    if (ev && ev.kind !== "birthday") {
      // An event's hero is its day, like a page torn from a calendar.
      const { date } = whenLocal(ev);
      const next = nextOccurrence(date, ev.recurrence, localToday()) ?? date;
      mark.className = "tile tile--hero record-date";
      mark.replaceChildren(
        h("span", { class: "record-date__month" }, new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(Date.parse(`${next}T12:00:00Z`))),
        h("span", { class: "record-date__day" }, String(Number(next.slice(8, 10))))
      );
      return;
    }
    const icon: IconName = ev?.kind === "birthday" ? "gift" : RECORD_ICON[kind];
    mark.className = "tile tile--hero record-calm";
    mark.replaceChildren(icons[icon]());
  }

  /** Save a patch; a new record is created by its first save (needs a name). */
  function save(patch: Record<string, unknown>) {
    saving = saving.then(async () => {
      if (dead) return;
      const nameKey = kind === "event" ? "title" : "name";
      if (!rec && !nameInput.value.trim()) {
        nameInput.focus();
        showToast(kind === "event" ? "Give it a title first" : "Add a name first", { icon: "pen" });
        return;
      }
      try {
        const input = rec ? patch : { ...collectNew(), ...patch, [nameKey]: nameInput.value.trim() };
        const saved = await saveRecord(kind, input, rec?.id);
        const created = !rec;
        rec = saved;
        if (!dead) unnameTab = setPageName(recordTitle(saved));
        if (created) ctx.onCreated?.(kind, saved);
        paint();
      } catch (error) {
        showToast(error instanceof OfflineError ? error.message : error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
      }
    });
  }

  // ---------- menu ----------
  const menuId = `rec-menu-${uid}`;
  const moreBtn = h(
    "button",
    { class: "icon-btn icon-btn--sm icon-btn--ghost note__more", type: "button", "aria-label": "More actions", popovertarget: menuId },
    icons.more()
  ) as HTMLButtonElement;
  const menu = h("div", { class: "menu note-menu", id: menuId, popover: "auto" }) as HTMLElement & { hidePopover?: () => void };
  const menuItem = (icon: IconName, label: string, run: () => void, cls = "") => {
    const b = h("button", { class: `menu__item ${cls}`, type: "button" }, icons[icon](), label);
    b.addEventListener("click", () => {
      menu.hidePopover?.();
      run();
    });
    return b;
  };
  const menuLink = (icon: IconName, label: string, href: string, external = false) => {
    const a = h("a", { class: "menu__item", href, target: external ? "_blank" : undefined, rel: external ? "noopener noreferrer" : undefined }, icons[icon](), label);
    a.addEventListener("click", () => menu.hidePopover?.());
    return a;
  };
  /** The ··· menu: this kind's quieter actions first, then Archive and Delete permanently. */
  function paintMenu(more: HTMLElement[]) {
    menu.replaceChildren(
      // Ask with this one attached (lib/open-ask.ts).
      ...(rec ? [menuItem("chat", "Ask about this", () => rec && openAsk({ context: { kind, id: rec.id, label: recordTitle(rec) } })), h("div", { class: "menu__sep" })] : []),
      ...more,
      ...(kind === "person"
        ? [
            menuItem("people", "Merge a duplicate…", () =>
              rec
                ? openMergeSheet(rec as Person, (merged) => {
                    rec = merged;
                    paint();
                  })
                : undefined
            ),
          ]
        : []),
      ...(more.length || kind === "person" ? [h("div", { class: "menu__sep" })] : []),
      menuItem("archive", "Archive", archive),
      h("div", { class: "menu__sep" }),
      menuItem("trash", "Delete permanently", remove, "menu__item--danger")
    );
  }
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const r = moreBtn.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 12)}px`;
    placeMenuAcross(menu, moreBtn);
  });

  async function archive() {
    if (!rec) return;
    const { id } = rec;
    try {
      await setArchived(kind, id, true);
      dead = true;
      ctx.close();
      showToast(`${RECORD_LABEL[kind]} archived`, {
        icon: "archive",
        action: { label: "Undo", run: () => void setArchived(kind, id, false).catch(() => showToast("Couldn't undo. Restore it from Archived")) },
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't archive", { icon: "wifiOff" });
    }
  }

  async function remove() {
    if (!rec) return;
    const extra = kind === "person" ? " Their birthday goes too." : "";
    const ok = await confirmDialog({
      title: `Delete ${recordTitle(rec)} permanently?`,
      body: `It's removed from Athena everywhere, along with its links.${extra} Notes that mention it keep their text. This can't be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteForever(kind, rec.id);
      dead = true;
      ctx.close();
      showToast("Deleted permanently", { icon: "trash" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't delete", { icon: "wifiOff" });
    }
  }

  // ---------- header line, the one primary action, what's coming up ----------
  const sub = h("p", { class: "profile__sub" });
  /** "Last saw Wednesday, lunch at Dishoom" / "Last here Saturday, gallery with Tom". */
  const lastLine = h("p", { class: "profile__last", hidden: true });
  const primary = h("div", { class: "profile__primary" });
  const facts = h("div", { class: "profile__facts" });
  /** Menu items for the actions that aren't the primary one; each kind's details fill it. */
  let secondary: HTMLElement[] = [];

  /** The page's one primary action: a soft pill under the name. */
  function primaryAction(icon: IconName, label: string, run: string | (() => void), external = false): HTMLElement {
    const inner = [icons[icon](), label];
    if (typeof run === "string") {
      return h("a", { class: "btn btn--soft btn--sm profile__go", href: run, target: external ? "_blank" : undefined, rel: external ? "noopener noreferrer" : undefined }, ...inner);
    }
    const b = h("button", { class: "btn btn--soft btn--sm profile__go", type: "button" }, ...inner);
    b.addEventListener("click", run);
    return b;
  }

  /** A new note that already links here, so it lands in "Mentioned in". */
  const composeHere = () => rec && ctx.compose?.(`${formatAthenaLink(kind, rec.id, `@${recordTitle(rec)}`)} `);
  const noteMenu = (): HTMLElement[] => (ctx.compose && rec ? [menuItem("pen", "Write a note", composeHere)] : []);

  // ---------- the story: Together (a person) or Visits (a place) ----------
  let story: StoryRow[] = [];
  function paintLast() {
    const today = localToday();
    let line: string | null = null;
    if (kind === "person") {
      const p = rec as Person | null;
      line = lastSawLine(story, today) ?? (p?.last_contacted_at ? `Last spoke ${relativeTime(p.last_contacted_at)}` : null);
    } else if (kind === "place") line = lastHereLine(story, today);
    lastLine.textContent = line ?? "";
    lastLine.hidden = !line;
  }
  const openEvent = (id: string) => ctx.openLink("event", id);

  // ---------- a person's open loops, facts, catch-ups and Together (components/person-memory.ts) ----------
  let memory: PersonMemory | null = null;
  const memorySlot = h("div", { class: "profile__memory" });
  function ensureMemory() {
    if (kind !== "person" || !rec || memory) return;
    memory = personMemory(rec as Person, {
      onBrief: () => void paintLinks(),
      onPerson: (p) => {
        rec = p;
        paint();
      },
      onStory: (rows) => {
        story = rows;
        paintLast();
        if (rec) paintPersonFacts(rec as Person);
      },
      openEvent,
    });
    memorySlot.replaceChildren(memory.composer, memory.together, memory.loops, memory.decisions, memory.facts);
  }

  // A place's visits (components/place-visits.ts), loaded once for each place shown.
  const visits = kind === "place" ? storyTimeline({ title: "Visits", shape: "place", empty: "No visits yet. Days you spend here show up once your places are in Athena.", openEvent }) : null;
  let visitsFor: string | null = null;
  // "Add a visit" under the Visits, with this Place picked (not on an archived one).
  const addVisit = h("div", { class: "where__actions story__add" });
  visits?.el.append(addVisit);
  function loadVisits(pl: Place) {
    if (!visits || visitsFor === pl.id) return;
    visitsFor = pl.id;
    void import("./place-visits")
      .then((m) => {
        const again = () => ((visitsFor = null), m.forgetPlaceVisits(), loadVisits(pl));
        addVisit.replaceChildren(...(pl.archived_at ? [] : [m.addVisitButton(again, { place: pl })]));
        return m.placeStoryRows(pl);
      })
      .then((rows) => {
        if (dead || rec?.id !== pl.id) return;
        story = rows;
        visits.set(rows, localToday());
        paintLast();
        // "Last visited", if the owner keeps that field, comes from the days rather than memory.
        if (rows[0]) custom.prefill(/^last visit/i, rows[0].date, "From your days");
      })
      .catch(() => visits.set([], localToday()));
  }

  // A place opens on a still of the spot (the one its rich link uses); without one, its calm pin.
  const heroMap = h("div", { class: "record-map", hidden: true });
  let mapFor: string | null = null;
  function loadMap(pl: Place) {
    if (kind !== "place" || mapFor === pl.id) return;
    mapFor = pl.id;
    void import("./place-visits")
      .then((m) => m.placeHeroMap(pl))
      .then((still) => {
        if (dead || rec?.id !== pl.id || !still) return;
        const img = h("img", { class: "record-map__img", src: still.src, alt: `${pl.name} on a map`, decoding: "async", draggable: "false" }) as HTMLImageElement;
        const frame = still.open
          ? h("a", { class: "record-map__frame", href: still.open, target: "_blank", rel: "noopener noreferrer", "aria-label": `${pl.name}: open in Maps` }, img)
          : h("div", { class: "record-map__frame" }, img);
        const settle = () => heroMap.classList.add("is-in");
        img.addEventListener("load", settle, { once: true });
        img.addEventListener("error", () => {
          heroMap.hidden = true;
          el.classList.remove("profile--mapped");
        }, { once: true });
        heroMap.replaceChildren(frame);
        heroMap.hidden = false;
        el.classList.add("profile--mapped");
        if (img.complete && img.naturalWidth) settle();
      })
      .catch(() => undefined);
  }

  // ---------- kind-specific details ----------
  const fields = h("div", { class: "card card--flush fields" });
  // The owner's own fields follow the built-in ones (components/custom-fields.ts).
  const custom = customFieldsSection(kind);
  const notesInput = h("textarea", { class: "prop__input prop__textarea", name: "notes", rows: 1, placeholder: "Anything worth remembering", "aria-label": "Notes" }) as HTMLTextAreaElement;
  notesInput.value = rec && "notes" in rec ? rec.notes : "";
  notesInput.addEventListener("change", () => rec && save({ notes: notesInput.value }));
  // Empty, the box is one quiet line; it opens up while you write in it.
  const growNotes = () => {
    notesInput.style.height = "auto";
    const min = notesInput.value.trim() || document.activeElement === notesInput ? 88 : 46;
    notesInput.style.height = `${Math.max(min, notesInput.scrollHeight)}px`;
  };
  notesInput.addEventListener("input", growNotes);

  const growNotesSoon = () => requestAnimationFrame(growNotes);
  notesInput.addEventListener("focus", growNotesSoon);
  notesInput.addEventListener("blur", growNotesSoon);

  /** Values typed into a record before it existed, sent with its first save. */
  let collectNew: () => Record<string, unknown> = () => ({ notes: notesInput.value });

  // ---------- Details: folded at the end; set fields as words, empty ones behind "Add a detail" ----------
  const preview = h("span", { class: "record-details__preview" });
  const addDetail = h("button", { class: "link-btn section-add record-details__add", type: "button" }, icons.plus(), "Add a detail") as HTMLButtonElement;
  const details = h(
    "details",
    { class: "profile__section record-details" },
    h("summary", { class: "record-details__summary" }, h("h2", { class: "group__label record-h" }, "Details"), preview, h("span", { class: "record-details__chev", "aria-hidden": "true" }, icons.chevronDown())),
    h("div", { class: "record-details__body" }, fields, addDetail)
  ) as HTMLDetailsElement;
  /** "Add a detail" was used: every row shows until another record is shown. */
  let revealAll = false;
  let revealedFor: string | null = null;
  let emptyRows: HTMLElement[] = [];

  /** The built-in rows, each with whether it holds a value; a saved record hides the empty ones. */
  function setRows(rows: Array<[HTMLElement, boolean]>, words: string[]) {
    const id = rec?.id ?? null;
    if (id !== revealedFor) {
      revealedFor = id;
      revealAll = false;
    }
    emptyRows = rows.filter(([, set]) => !set).map(([row]) => row);
    for (const [row, set] of rows) if (!set && rec && !revealAll) row.hidden = true;
    fields.replaceChildren(...rows.map(([row]) => row));
    const shown = words.filter(Boolean);
    preview.textContent = shown.length ? shown.slice(0, 3).join(" · ") : "";
    syncAdd();
  }
  /** "Add a detail" shows while something is still hidden: a built-in row, or the owner's own fields' (custom-fields.ts) "Add …" row. */
  const syncAdd = () => {
    addDetail.hidden = !rec || revealAll || !(emptyRows.some((r) => r.hidden) || fields.querySelector(".prop--reveal"));
  };
  addDetail.addEventListener("click", () => {
    revealAll = true;
    const first = emptyRows.find((r) => r.hidden) ?? null;
    for (const r of emptyRows) r.hidden = false;
    // Keep Catch up hidden while Keep in touch is off.
    fields.querySelector<HTMLElement>("[data-needs-touch]")?.toggleAttribute("hidden", !(fields.querySelector<HTMLInputElement>("input[role=switch][name=keep-in-touch]")?.checked ?? false));
    fields.querySelector<HTMLButtonElement>(".prop--reveal")?.click();
    syncAdd();
    // The owner's own fields put the caret in the first one they open; a built-in row does it here.
    first?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
  });
  /** What needs measuring once the folded Details opens (a place's address box). */
  let onDetailsOpen = () => {};
  details.addEventListener("toggle", () => details.open && onDetailsOpen());
  // The owner's own fields arrive after a load: keep "Add a detail" in step with them.
  const watchFields = new MutationObserver(syncAdd);
  watchFields.observe(fields, { childList: true });

  function personDetails(p: Person | null) {
    const relationship = input("text", p?.relationship ?? "", { placeholder: "Add relationship", autocomplete: "off" });
    relationship.addEventListener("change", () => rec && save({ relationship: relationship.value.trim() }));

    const orgList = h("datalist", { id: `orgs-${uid}` });
    const org = input("text", p?.organisation?.name ?? "", { placeholder: "Add workplace", list: `orgs-${uid}`, autocomplete: "off" });
    let orgs: Organisation[] = [];
    void loadRecords("organisation").then(({ items }) => {
      orgs = items;
      orgList.replaceChildren(...items.map((o) => h("option", { value: o.name })));
    });
    org.addEventListener("change", async () => {
      if (!rec) return;
      const name = org.value.trim();
      if (!name) return save({ organisation_id: null });
      let match = orgs.find((o) => o.name.toLowerCase() === name.toLowerCase());
      if (!match) {
        try {
          match = await saveRecord("organisation", { name });
          orgs.push(match);
        } catch (error) {
          showToast(error instanceof Error ? error.message : "Couldn't add that organisation", { icon: "wifiOff" });
          return;
        }
      }
      save({ organisation_id: match.id });
    });

    // Birthday as day + month + an optional year; no year is stored as "--MM-DD".
    const [by, bm, bd] = p?.birthday ? (p.birthday.startsWith("--") ? ["", p.birthday.slice(2, 4), p.birthday.slice(5, 7)] : p.birthday.split("-")) : ["", "", ""];
    const day = select("Birthday day", [{ value: "", label: "Day" }, ...Array.from({ length: 31 }, (_, i) => ({ value: pad(i + 1), label: String(i + 1) }))], bd);
    const month = select("Birthday month", [{ value: "", label: "Month" }, ...MONTHS.map((m, i) => ({ value: pad(i + 1), label: m }))], bm);
    const year = input("text", by, { placeholder: "Year", inputmode: "numeric", maxlength: 4, autocomplete: "off", "aria-label": "Birth year (optional)" });
    day.classList.add("prop__input--day");
    month.classList.add("prop__input--month");
    year.classList.add("prop__input--year");
    day.name = "birthday-day";
    month.name = "birthday-month";
    year.name = "birthday-year";
    /** null = cleared; undefined = not a whole date yet. */
    const birthdayValue = (): string | null | undefined => {
      if (!day.value && !month.value) return null;
      if (!day.value || !month.value) return undefined;
      const y = year.value.trim();
      if (y && !/^\d{4}$/.test(y)) return undefined;
      const full = `${y || "2000"}-${month.value}-${day.value}`;
      if (!isValidDate(full)) return undefined;
      return y ? full : `--${month.value}-${day.value}`;
    };
    const saveBirthday = () => {
      const v = birthdayValue();
      if (v === undefined) {
        if (day.value && month.value) showToast("That date doesn't exist", { icon: "calendar" });
        return;
      }
      if (rec && v !== (p?.birthday ?? null)) save({ birthday: v });
    };
    for (const el of [day, month, year]) el.addEventListener("change", saveBirthday);

    const email = input("email", p?.email ?? "", { placeholder: "Add email", autocomplete: "off", inputmode: "email" });
    email.addEventListener("change", () => rec && save({ email: email.value.trim() }));
    const phone = input("tel", p?.phone ?? "", { placeholder: "Add phone", autocomplete: "off", inputmode: "tel" });
    phone.addEventListener("change", () => rec && save({ phone: phone.value.trim() }));

    const current = p?.catch_up_days ?? DEFAULT_CATCH_UP;
    const cadence = select(
      "Catch up",
      [...new Set([...CADENCES, current])].sort((a, b) => a - b).map((d) => ({ value: String(d), label: capitalise(cadenceLabel(d)) })),
      String(current)
    );
    cadence.addEventListener("change", () => {
      const n = Number(cadence.value);
      if (rec) save({ catch_up_days: n === DEFAULT_CATCH_UP ? null : n });
    });

    const contactedPicker = pickerInput("date", p?.last_contacted_at ? localToday(new Date(p.last_contacted_at)) : "", { "aria-label": "Last spoke", max: localToday() });
    const contacted = contactedPicker.input;
    contacted.addEventListener("change", () => rec && save({ last_contacted_at: contacted.value || null }));

    // Catch-up nudges are opt-in: only people you keep in touch with come up.
    const keepInTouch = h("input", { type: "checkbox", role: "switch", class: "switch" }) as HTMLInputElement;
    keepInTouch.checked = !!p?.keep_in_touch;
    const cadenceRow = field("Catch up", cadence);
    cadenceRow.dataset.needsTouch = "";
    keepInTouch.addEventListener("change", () => {
      cadenceRow.hidden = !keepInTouch.checked;
      if (rec) save({ keep_in_touch: keepInTouch.checked });
    });

    collectNew = () => ({
      notes: notesInput.value,
      relationship: relationship.value.trim(),
      email: email.value.trim(),
      phone: phone.value.trim(),
      keep_in_touch: keepInTouch.checked,
      ...(birthdayValue() ? { birthday: birthdayValue() } : {}),
      ...(Number(cadence.value) !== DEFAULT_CATCH_UP ? { catch_up_days: Number(cadence.value) } : {}),
    });

    const birthdayRow = h(
      "div",
      { class: "prop", role: "group", "aria-label": "Birthday" },
      h("span", { class: "prop__label" }, "Birthday"),
      h("span", { class: "prop__control prop__date" }, day, month, year)
    );
    const akaRow = memory ? field("Also known as", memory.aka) : null;
    akaRow?.classList.add("prop--stack");
    setRows(
      [
        [field("Relationship", relationship), !!p?.relationship],
        [field("Works at", org, orgList), !!p?.organisation],
        [birthdayRow, !!p?.birthday],
        [field("Email", email), !!p?.email],
        [field("Phone", phone), !!p?.phone],
        [field("Keep in touch", keepInTouch, h("span", { class: "prop__suffix" }, "Nudge me to catch up")), !!p?.keep_in_touch],
        [cadenceRow, !!p?.keep_in_touch],
        [field("Last spoke", contactedPicker.el), !!p?.last_contacted_at],
        ...(akaRow ? [[akaRow, !!memory?.brief()?.identities.length] as [HTMLElement, boolean]] : []),
      ],
      [p?.relationship ?? "", p?.organisation?.name ?? "", p?.email ?? "", p?.phone ?? ""]
    );
    // Catch up only means something while Keep in touch is on.
    if (!keepInTouch.checked) cadenceRow.hidden = true;

    if (!p) return;
    const parts: (string | HTMLElement)[] = [];
    if (p.relationship) parts.push(p.relationship);
    if (p.organisation) {
      const o = p.organisation;
      const b = h("button", { class: "profile__sub-link", type: "button" }, o.name);
      b.addEventListener("click", () => ctx.openLink("organisation", o.id));
      parts.push(b);
    }
    sub.replaceChildren(...dotted(parts));

    // Two things to do from here: log a catch-up, or draft them a message. Email, Call and a note are in the menu.
    const person = p;
    primary.replaceChildren(
      primaryAction("check", "Log a catch-up", () => memory?.openComposer()),
      primaryAction("pen", "Draft a message", () =>
        openDraftSheet({
          person: { id: person.id, name: person.name },
          about: "a short, friendly note to catch up",
          sample: ["Catching up", "It's been a while. How are things? Would be good to catch up soon. [suggest a day]", "Best,"],
        })
      )
    );
    secondary = [
      ...(p.email ? [menuLink("mail", `Email ${p.name.split(" ")[0]}`, `mailto:${p.email}`)] : []),
      ...(p.phone ? [menuLink("phone", `Call ${p.name.split(" ")[0]}`, `tel:${p.phone.replace(/[^\d+]/g, "")}`)] : []),
      ...noteMenu(),
    ];

    paintPersonFacts(p);
  }

  /** What's coming up for a person: a birthday, and a catch-up when you keep in touch. Again when Together loads, which may know a later meeting. */
  function paintPersonFacts(p: Person) {
    const today = localToday();
    const items: HTMLElement[] = [];
    if (p.birthday) {
      const yearKnown = !p.birthday.startsWith("--");
      const date = yearKnown ? p.birthday : `2000-${p.birthday.slice(2)}`;
      const next = nextOccurrence(date, "yearly", today)!;
      const n = daysBetween(today, next);
      const what = yearKnown ? `Turns ${yearsSince(date, next)}` : "Birthday";
      const when = n < 2 ? dayLabel(n, next).toLowerCase() : `on ${dayLabel(n, next)}`;
      const detail = n < 2 ? calendarDate(next) : n < 7 ? `${calendarDate(next)} · ${inDays(n)}` : capitalise(inDays(n));
      items.push(fact("gift", `${what} ${when}`, detail, n <= 14 ? "accent" : undefined));
    }
    // When you last saw them is the hero's line; a catch-up only comes up here when you keep in touch.
    const every = p.catch_up_days ?? DEFAULT_CATCH_UP;
    // The latest of the date on the record and the newest time in Together (a calendar lunch counts too).
    const seen = story[0] ? `${story[0].date}T12:00:00` : null;
    const last = seen && (!p.last_contacted_at || Date.parse(seen) > Date.parse(p.last_contacted_at)) ? new Date(seen).toISOString() : p.last_contacted_at;
    if (p.keep_in_touch) {
      if (!last) items.push(fact("refresh", "No catch-up logged yet", `Aim for ${cadenceLabel(every)}`));
      else {
        const due = every - (daysSince(last) ?? 0);
        if (due < 0) items.push(fact("refresh", "Time to catch up", `Last spoke ${relativeTime(last)} · ${cadenceLabel(every)}`, "warn"));
        else items.push(fact("refresh", due === 0 ? "Catch-up due today" : `Next catch-up ${inDays(due)}`, capitalise(cadenceLabel(every))));
      }
    }
    facts.replaceChildren(...items);
    facts.hidden = !items.length;
  }

  function placeDetails(pl: Place | null) {
    const address = h("textarea", { class: "prop__input prop__textarea", rows: 1, placeholder: "Add address", "aria-label": "Address" }) as HTMLTextAreaElement;
    address.value = pl?.address ?? "";
    address.addEventListener("change", () => rec && save({ address: address.value.trim() }));
    const growAddress = () => {
      address.style.height = "auto";
      address.style.height = `${address.scrollHeight + 2}px`;
    };
    address.addEventListener("input", growAddress);
    requestAnimationFrame(growAddress);
    // A folded Details has no height to measure: size the box when it opens.
    onDetailsOpen = growAddress;
    const url = input("url", pl?.url ?? "", { placeholder: "Add website or booking link", autocomplete: "off", inputmode: "url" });
    url.addEventListener("change", () => rec && save({ url: url.value.trim() }));
    collectNew = () => ({ notes: notesInput.value, address: address.value.trim(), url: url.value.trim() });
    setRows(
      [
        [field("Address", address), !!pl?.address],
        [field("Website", url), !!pl?.url],
      ],
      [pl?.address.split(/\n+/)[0] ?? "", pl?.url ? hostOf(pl.url) : ""]
    );

    if (!pl) return;
    sub.replaceChildren(...(pl.address ? [pl.address.split(/\n+/).join(", ")] : []));
    const site = safeUrl(pl.url);
    primary.replaceChildren(primaryAction("pin", "Directions", `https://maps.apple.com/?q=${encodeURIComponent(pl.address || pl.name)}`, true));
    secondary = [...(site ? [menuLink("link", "Open the website", site, true)] : []), ...noteMenu()];
    loadMap(pl);
    loadVisits(pl);
  }

  function organisationDetails(o: Organisation | null) {
    const website = input("url", o?.website ?? "", { placeholder: "Add website", autocomplete: "off", inputmode: "url" });
    website.addEventListener("change", () => rec && save({ website: website.value.trim() }));
    collectNew = () => ({ notes: notesInput.value, website: website.value.trim() });
    setRows([[field("Website", website), !!o?.website]], [o?.website ? hostOf(o.website) : ""]);

    if (!o) return;
    const site = safeUrl(o.website);
    sub.replaceChildren(...(o.website ? [hostOf(o.website)] : []));
    if (site) primary.replaceChildren(primaryAction("link", "Website", site, true));
    else if (ctx.compose) primary.replaceChildren(primaryAction("pen", "Write a note", composeHere));
    secondary = site ? noteMenu() : [];
  }

  function eventDetails(ev: AthenaEvent | null) {
    const kindSel = select("Kind", EVENT_KINDS, ev?.kind ?? "appointment");
    kindSel.addEventListener("change", () => rec && save({ kind: kindSel.value }));

    const yearly = h("input", { type: "checkbox", role: "switch", class: "switch", name: "yearly" }) as HTMLInputElement;
    yearly.checked = ev?.recurrence === "yearly";
    const yearKnown = h("input", { type: "checkbox", role: "switch", class: "switch", name: "year-known" }) as HTMLInputElement;
    yearKnown.checked = ev ? ev.year_known : true;
    // Shown in this device's time zone; a timed one-off is stored as a UTC instant.
    const when = ev ? whenLocal(ev) : null;
    // Read the way the app writes them ("Tuesday 10 November", "09:30"), edited with the system's own picker.
    const datePicker = pickerInput("date", when?.date ?? "", { required: true, "aria-label": "Date" });
    const timePicker = pickerInput("time", when?.time ?? "", { "aria-label": "Time" }, "All day");
    const date = datePicker.input;
    const time = timePicker.input;

    const dateValue = () => (yearly.checked && !yearKnown.checked && date.value ? `--${date.value.slice(5)}` : date.value);
    date.addEventListener("change", () => rec && date.value && save({ date: dateValue(), year_known: !yearly.checked || yearKnown.checked, tz: deviceZone() }));
    time.addEventListener("change", () => rec && date.value && save({ date: dateValue(), time: time.value || null, tz: deviceZone() }));
    yearly.addEventListener("change", () => {
      yearKnownWrap.hidden = !yearly.checked;
      if (rec) save({ recurrence: yearly.checked ? "yearly" : "none", ...(yearly.checked ? {} : { year_known: true }), tz: deviceZone() });
    });
    yearKnown.addEventListener("change", () => rec && save({ year_known: yearKnown.checked }));
    const yearKnownWrap = h("label", { class: "prop__inline" }, yearKnown, "Year known");
    yearKnownWrap.hidden = !yearly.checked;

    let remind = [...(ev?.remind_days_before ?? [0])];
    const REMIND_WORDS: Record<number, string> = { 0: "on the day", 1: "the day before", 7: "a week before" };
    const remindWords = () => capitalise(namesList(REMIND_OPTIONS.filter((o) => remind.includes(o.days)).map((o) => REMIND_WORDS[o.days] ?? o.label.toLowerCase())));
    const remindRow = h(
      "span",
      { class: "chip-row chip-row--wrap prop__toggles", role: "group", "aria-label": "Remind me" },
      ...REMIND_OPTIONS.map((o) => {
        const b = h("button", { class: "chip", type: "button", "aria-pressed": String(remind.includes(o.days)) }, o.label);
        b.addEventListener("click", (e) => {
          e.preventDefault();
          remind = remind.includes(o.days) ? remind.filter((d) => d !== o.days) : [...remind, o.days].sort((a, b) => a - b);
          b.setAttribute("aria-pressed", String(remind.includes(o.days)));
          if (rec) save({ remind_days_before: remind });
          remindFold.paint();
        });
        return b;
      })
    );

    // Set reminders read as words; a tap brings back the three choices.
    const remindFold = foldedEditor("Remind me", remindWords, remindRow);

    collectNew = () => ({
      notes: notesInput.value,
      kind: kindSel.value,
      date: dateValue() || localToday(),
      time: time.value || null,
      tz: deviceZone(),
      recurrence: yearly.checked ? "yearly" : "none",
      year_known: !yearly.checked || yearKnown.checked,
      remind_days_before: remind,
    });

    setRows(
      [
        [field("Kind", kindSel), true],
        [field("Date", datePicker.el), true],
        [field("Time", timePicker.el), true],
        [field("Repeats", h("label", { class: "prop__inline" }, yearly, "Every year"), yearKnownWrap), ev?.recurrence === "yearly"],
        [field("Remind me", ev ? remindFold.el : remindRow), true],
      ],
      [EVENT_KINDS.find((k) => k.value === kindSel.value)?.label ?? "", when?.date ? longDate(when.date, localToday()) : "", clockOfDay(when?.time)]
    );

    if (!ev) return;
    const label = EVENT_KINDS.find((k) => k.value === ev.kind)?.label ?? "Event";
    // Synced from a calendar by a collection: say which one, so it's clear edits there win.
    const from = ev.source ? `From ${sourceText(ev.source)}` : null;
    sub.replaceChildren(...dotted([ev.recurrence === "yearly" ? `${label} · every year` : label, ...(from ? [from] : [])]));
    const today = localToday();
    const at = when!;
    // A meeting (a timed event that isn't a birthday): its notes, filled from what Athena knows, are the one action;
    // a blank note stays in the menu. Before it starts they're for preparing; afterwards, for writing it up.
    const meeting = !!ev.starts_at && ev.kind !== "birthday" && ev.recurrence === "none";
    if (meeting && ctx.prepare) {
      const prepare = ctx.prepare;
      const upcoming = new Date(ev.starts_at!).getTime() > Date.now();
      primary.replaceChildren(primaryAction("sparkle", upcoming ? "Prepare notes" : "Meeting notes", () => prepare(ev.id)));
      secondary = noteMenu();
    } else if (ctx.compose) primary.replaceChildren(primaryAction("pen", "Write a note", composeHere));

    const next = nextOccurrence(at.date, ev.recurrence, today);
    if (!next) {
      facts.replaceChildren(fact("calendar", `Was on ${calendarDate(at.date, true)}`, at.time ? `at ${clockOfDay(at.time)}` : ""));
      return;
    }
    const n = daysBetween(today, next);
    const day = n < 2 ? dayLabel(n, next) : n < 7 ? `${dayLabel(n, next)} ${calendarDate(next)}` : calendarDate(next, ev.recurrence !== "yearly");
    const extra: string[] = [capitalise(inDays(n))];
    if (ev.recurrence === "yearly" && ev.year_known) {
      const yrs = yearsSince(ev.date, next);
      if (yrs > 0) extra.push(ev.kind === "birthday" ? `turns ${yrs}` : `${yrs} ${yrs === 1 ? "year" : "years"}`);
    }
    const declined = ev.rsvp === "declined";
    facts.replaceChildren(fact(ev.kind === "birthday" ? "gift" : "calendar", `${day}${at.time ? ` at ${clockOfDay(at.time)}` : ""}`, extra.join(" · "), n <= 7 && !declined ? "accent" : undefined));
    // Going, Maybe or Declined (components/rsvp-control.ts). It repaints itself; `rec` just keeps up.
    if (canAnswer(ev)) facts.append(rsvpControl(ev, (saved) => (rec = saved)));
  }

  // ---------- related + mentions ----------
  const related = h("div", { class: "link-chips" });
  const mentions = h("div", { class: "backlinks" });
  const mentionsCount = h("span", { class: "group__count" });
  const relatedWrap = h("section", { class: "note__links" }, h("h2", { class: "group__label" }, "Related"), related);
  const mentionsWrap = h("section", { class: "note__links" }, h("h2", { class: "group__label" }, "Mentioned in", mentionsCount), mentions);

  const chip = (k: LinkedKind, id: string, title: string, kindId?: string, via?: string, subtitle?: string) => {
    const b = h("button", { class: "link-chip", type: "button", "data-kind": k, ...(via ? { title: `In “${via}”` } : {}) }, icons[entityIcon(k, kindId, id, subtitle)](), title || "Untitled");
    b.addEventListener("click", () => openLinked(ctx.openLink, k, id));
    return b;
  };

  async function paintLinks() {
    if (!rec) {
      relatedWrap.hidden = true;
      mentionsWrap.hidden = true;
      return;
    }
    const current = rec;
    const [{ outgoing, backlinks, through_notes }, people] = await Promise.all([
      loadConnections(kind, current.id),
      kind === "organisation" ? loadRecords("person").then((r) => r.items) : Promise.resolve([] as Person[]),
    ]);
    if (dead || rec !== current) return;
    const chips: HTMLElement[] = [];
    const seen = new Set<string>();
    const add = (k: LinkedKind, id: string, title: string, kindId?: string, via?: string, subtitle?: string) => {
      if (seen.has(`${k}:${id}`)) return;
      seen.add(`${k}:${id}`);
      chips.push(chip(k, id, title, kindId, via, subtitle));
    };
    if (kind === "event" && (current as AthenaEvent).person_id) {
      const pid = (current as AthenaEvent).person_id!;
      const person = (await loadRecords("person")).items.find((p) => p.id === pid);
      if (person) add("person", person.id, person.name);
    }
    // A person's organisation is already in the header line.
    if (kind === "person" && (current as Person).organisation) seen.add(`organisation:${(current as Person).organisation!.id}`);
    if (kind === "person" && (current as Person).birthday_event_id) add("event", (current as Person).birthday_event_id!, `${(current as Person).name}'s birthday`);
    const members = people.filter((p) => p.organisation?.id === current.id);
    for (const p of members) add("person", p.id, p.name);
    if (kind === "organisation" && members.length) {
      const o = current as Organisation;
      sub.replaceChildren(...dotted([...(o.website ? [hostOf(o.website)] : []), `${members.length} ${members.length === 1 ? "person" : "people"}`]));
      sub.hidden = false;
    }
    for (const c of [...outgoing, ...backlinks].filter((c: Connection) => c.kind !== "note")) add(c.kind, c.id, c.title, c.kind_id, undefined, c.subtitle);
    // Saved items, to-dos and Watch & read titles from the notes that mention this ("Ideas for Rowan: @green dress").
    for (const c of through_notes ?? []) add(c.kind, c.id, c.title, undefined, c.note.title || "Untitled", c.subtitle);
    relatedWrap.hidden = !chips.length;
    related.replaceChildren(...chips);
    // An upcoming timed event at a place: how to get there, for Leave by (components/getting-there.ts).
    const ev = kind === "event" ? (current as AthenaEvent) : null;
    if (ev?.starts_at && Date.parse(ev.starts_at) > Date.now() && [...outgoing, ...backlinks].some((c: Connection) => c.kind === "place") && !facts.querySelector(".getting-there")) {
      facts.append(gettingThere(ev.id));
    }

    const notes = backlinks.filter((c) => c.kind === "note");
    const cached = new Map(notesSnapshot().notes.map((n) => [n.id, n]));
    // The notes that mention this, newest first. A person's catch-ups are in Together.
    const entries: { at: string; el: HTMLElement }[] = notes.map((c) => {
      const n = cached.get(c.id);
      const snippet = n ? markdownToText(n.body).replace(/\s+/g, " ").trim() : "";
      const row = h(
        "button",
        { class: "row", type: "button" },
        h("span", { class: "tile tile--sm" }, icons.note()),
        h(
          "span",
          { class: "row__body" },
          h("span", { class: "row__title-line" }, h("span", { class: "row__title" }, c.title || "Untitled")),
          snippet ? h("span", { class: "row__snippet" }, snippet) : null
        ),
        c.updated_at ? h("span", { class: "row__time" }, shortDate(c.updated_at)) : h("span", {})
      );
      row.addEventListener("click", () => ctx.openLink("note", c.id));
      return { at: c.updated_at ?? "", el: row };
    });
    entries.sort((a, b) => b.at.localeCompare(a.at));
    mentionsCount.textContent = entries.length ? String(entries.length) : "";
    // Nothing mentions it yet: the section steps aside rather than saying so.
    mentionsWrap.hidden = !entries.length;
    mentions.replaceChildren(...(entries.length ? [h("div", { class: "card card--flush list" }, ...entries.map((e) => e.el))] : []));
  }

  // ---------- assemble ----------
  const foot = h("footer", { class: "note__foot" });

  // The small graph goes in once there's a record to centre it on.
  let localGraph: LocalGraphSection | null = null;
  function ensureGraph() {
    if (!rec || localGraph) return;
    localGraph = localGraphSection({ kind, id: rec.id, title: () => (rec ? recordTitle(rec) : ""), openLink: ctx.openLink });
    details.before(localGraph.el);
  }

  function paint() {
    ensureMemory();
    moreBtn.hidden = !rec;
    sub.replaceChildren();
    primary.replaceChildren();
    facts.replaceChildren();
    secondary = [];
    switch (kind) {
      case "person":
        personDetails(rec as Person | null);
        break;
      case "place":
        placeDetails(rec as Place | null);
        break;
      case "organisation":
        organisationDetails(rec as Organisation | null);
        break;
      case "event":
        eventDetails(rec as AthenaEvent | null);
        break;
    }
    if (rec) paintMenu(secondary);
    custom.attach(fields);
    custom.show(rec?.id ?? null);
    paintMark();
    paintLast();
    sub.hidden = !sub.childNodes.length;
    primary.hidden = !primary.childElementCount;
    facts.hidden = !facts.childElementCount;
    // A new record shows every field, open; a saved one keeps Details folded at the end.
    if (!rec) details.open = true;
    syncAdd();
    foot.textContent = rec ? `Added ${shortDate(rec.created_at)} · Updated ${relativeTime(rec.updated_at)}` : "Saves as you go. Needs a connection.";
    void paintLinks();
    ensureGraph();
  }

  const notesSection = h("section", { class: "profile__section record-notes-box" }, h("h2", { class: "group__label record-h" }, "Notes"), notesInput);
  const el = h(
    "article",
    { class: `note note--edit profile profile--${kind}` },
    h(
      "header",
      { class: "profile__hero" },
      heroMap,
      h("div", { class: "profile__top" }, mark, h("span", { class: "note__bar-spacer" }), moreBtn, menu),
      nameInput,
      sub,
      lastLine,
      primary
    ),
    facts,
    memorySlot,
    ...(visits ? [visits.el] : []),
    notesSection,
    mentionsWrap,
    relatedWrap,
    details,
    foot
  );
  paint();
  requestAnimationFrame(() => {
    grow();
    growNotes();
    if (ctx.autofocus) nameInput.focus();
  });

  // Backlinks come from the notes store when offline or in sample mode, which
  // may still be loading (a deep link straight to a profile), or change later.
  let linksTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribeNotes = onNotes(() => {
    clearTimeout(linksTimer);
    linksTimer = setTimeout(() => void paintLinks(), 150);
  });

  return {
    el,
    recordId: () => rec?.id ?? null,
    destroy() {
      dead = true;
      unnameTab();
      clearTimeout(linksTimer);
      watchFields.disconnect();
      unsubscribeNotes();
      memory?.destroy();
      localGraph?.destroy();
      custom.destroy();
    },
  };
}

/** Mobile (and "+ New" on desktop): a profile in a sheet. */
export function openRecordSheet<K extends RecordKind>(kind: K, rec: AnyRecord | null, opts: { openLink: (kind: EntityKind, id: string) => void }): void {
  let view: ProfileView | null = null;
  const sheet = openSheet({
    label: rec ? recordTitle(rec) : `New ${RECORD_LABEL[kind].toLowerCase()}`,
    title: rec ? undefined : `New ${RECORD_LABEL[kind].toLowerCase()}`,
    body: h("div", {}),
    variant: "tall",
    onClose: () => view?.destroy(),
  });
  // Following a link or starting a note replaces this sheet rather than stacking sheets.
  const thenClose = (run: () => void) => {
    sheet.close();
    setTimeout(run, 260);
  };
  view = recordProfile(kind, rec, {
    close: () => sheet.close(),
    openLink: (k, id) => thenClose(() => opts.openLink(k, id)),
    compose: (seed) => thenClose(() => openNoteSheet(null, { openLink: opts.openLink, seed })),
    prepare: (eventId) => thenClose(() => prepareMeeting(eventId, opts.openLink)),
    autofocus: !rec,
  });
  sheet.dialog.querySelector(".sheet__scroll")!.replaceChildren(view.el);
}
