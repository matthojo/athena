/**
 * Library: People, Places, Organisations, Events. Same shape as Notes — a
 * sticky header with a filter box over a grouped list; on desktop the list
 * sits beside a profile pane, on mobile a tap opens the profile in a sheet.
 * Events list what's next (by next occurrence) before what's past. The filter
 * also matches the owner's own text and choices fields ("climbing" finds
 * whoever has it in Interests).
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { placesCard } from "../components/place-visits";
import { prepareMeeting, recordProfile, recordTitle, RECORD_ICON, type ProfileView } from "../components/record-profile";
import { openNoteSheet } from "../components/note-detail";
import { loadRecords, onRecordsChange } from "../db/records";
import { loadKindValues, onCustomFieldsChange, valuesSearchText } from "../db/custom-fields";
import { calendarDate, DEFAULT_CATCH_UP, dayLabel, hueFor, initials } from "../lib/format";
import { nextOccurrence, daysBetween } from "../../../lib/dates";
import { localToday, whenLocal } from "../lib/time";
import { sourceText } from "../lib/sources";
import type { AnyRecord, AthenaEvent, EntityKind, Organisation, Person, Place, RecordKind } from "../types";
import type { ViewId } from "../components/nav";
import { pageHead } from "../components/page-head";

export interface RecordsContext {
  kind: RecordKind;
  recordId: string | null;
  isDesktop: () => boolean;
  openRecord: (kind: RecordKind, rec: AnyRecord) => void;
  newRecord: (kind: RecordKind) => void;
  openLink: (kind: EntityKind, id: string) => void;
  go: (view: ViewId) => void;
  onSelectionChange: (id: string | null) => void;
}

const TITLES: Record<RecordKind, { title: string; one: string; empty: string; search: string }> = {
  person: { title: "People", one: "person", empty: "Add the people you want to keep up with: birthdays, how you know them, when you last spoke.", search: "Search people" },
  place: { title: "Places", one: "place", empty: "Restaurants, venues, homes: anywhere you'll want the address for later.", search: "Search places" },
  organisation: { title: "Organisations", one: "organisation", empty: "Companies, clubs and schools that the people in your notes belong to.", search: "Search organisations" },
  event: { title: "Events", one: "event", empty: "Appointments, deadlines and anniversaries. Birthdays appear here when you add them to people.", search: "Search events" },
};

function subtitle(kind: RecordKind, rec: AnyRecord): string {
  switch (kind) {
    case "person": {
      const p = rec as Person;
      return [p.relationship, p.organisation?.name].filter(Boolean).join(" · ") || (p.email || p.phone || "");
    }
    case "place":
      return (rec as Place).address;
    case "organisation":
      return (rec as Organisation).website.replace(/^https?:\/\//, "").replace(/\/$/, "");
    case "event": {
      const e = rec as AthenaEvent;
      const at = whenLocal(e);
      const when = e.recurrence === "yearly" ? `Every ${calendarDate(at.date)}` : calendarDate(at.date, true);
      const parts = [when, at.time, e.source ? sourceText(e.source) : null].filter(Boolean);
      return parts.join(" · ");
    }
  }
}

/** Right-hand detail: a birthday in the next fortnight, an overdue catch-up, an event's next day. */
function trailing(kind: RecordKind, rec: AnyRecord, today: string): HTMLElement | null {
  if (kind === "person") {
    const p = rec as Person;
    if (p.birthday) {
      const date = p.birthday.startsWith("--") ? `2000-${p.birthday.slice(2)}` : p.birthday;
      const next = nextOccurrence(date, "yearly", today)!;
      const n = daysBetween(today, next);
      if (n <= 14) return h("span", { class: "row__time row__time--accent", title: `Birthday ${calendarDate(next)}` }, icons.gift(), dayLabel(n, next));
    }
    const cadence = p.catch_up_days ?? DEFAULT_CATCH_UP;
    if (p.keep_in_touch && p.last_contacted_at && Date.now() - Date.parse(p.last_contacted_at) > cadence * 86_400_000) {
      return h("span", { class: "row__time row__time--warn" }, icons.refresh(), "Catch up");
    }
    return null;
  }
  if (kind === "event") {
    const e = rec as AthenaEvent;
    const next = nextOccurrence(whenLocal(e).date, e.recurrence, today);
    if (!next) return null;
    return h("span", { class: "row__time" }, dayLabel(daysBetween(today, next), next));
  }
  return null;
}

function leading(kind: RecordKind, rec: AnyRecord): HTMLElement {
  if (kind === "person") {
    const name = (rec as Person).name;
    return h("span", { class: "avatar avatar--row", style: `--h:${hueFor(name)}`, "aria-hidden": "true" }, initials(name));
  }
  if (kind === "event" && (rec as AthenaEvent).kind === "birthday") return h("span", { class: "tile tile--sm" }, icons.gift());
  return h("span", { class: "tile tile--sm" }, icons[RECORD_ICON[kind]]());
}

export function renderRecords(ctx: RecordsContext): { el: HTMLElement; destroy: () => void; focusSearch: () => void } {
  const { kind } = ctx;
  const copy = TITLES[kind];
  let items: AnyRecord[] = [];
  let loaded = false;
  let selectedId = ctx.recordId;
  let query = "";
  /** Each record's searchable custom field values, by id. */
  let extra = new Map<string, string>();

  const count = h("span", { class: "page-count" });
  const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), `New ${copy.one}`);
  add.addEventListener("click", () => newOne());
  const input = h("input", { type: "search", name: "q", placeholder: copy.search, autocomplete: "off", "aria-label": copy.search, enterkeyhint: "search" }) as HTMLInputElement;
  const head = pageHead({ segments: librarySegments(kind, ctx.go), title: copy.title, count, actions: [add], below: [h("label", { class: "search" }, icons.search(), input)] });
  const list = h("div", { class: "notes__list" });
  // Places: where you've been, above the list (components/place-visits.ts).
  const col = h("div", { class: "notes__col" }, head, kind === "place" ? placesCard(() => void load()) : null, list);
  const pane = h("section", { class: "notes__pane", "aria-label": copy.title });
  const el = h("div", { class: "view notes records" }, col, pane);

  let paneView: ProfileView | null = null;
  const clearPane = () => {
    paneView?.destroy();
    paneView = null;
  };
  function showInPane(rec: AnyRecord | null) {
    if (rec && paneView?.recordId() === rec.id) return;
    clearPane();
    paneView = recordProfile(kind, rec, {
      close: () => {
        clearPane();
        selectedId = null;
        ctx.onSelectionChange(null);
        paint();
      },
      openLink: ctx.openLink,
      compose: (seed) => openNoteSheet(null, { openLink: ctx.openLink, seed }),
      prepare: (eventId) => prepareMeeting(eventId, ctx.openLink),
      onCreated: (_k, created) => {
        selectedId = created.id;
        ctx.onSelectionChange(created.id);
      },
      autofocus: !rec,
    });
    pane.replaceChildren(paneView.el);
    pane.scrollTop = 0;
  }

  function newOne() {
    if (!ctx.isDesktop()) return ctx.newRecord(kind);
    selectedId = null;
    ctx.onSelectionChange(null);
    clearPane();
    showInPane(null);
  }

  const open = (rec: AnyRecord) => {
    if (ctx.isDesktop()) {
      selectedId = rec.id;
      ctx.onSelectionChange(rec.id);
      showInPane(rec);
      list.querySelectorAll<HTMLElement>(".row").forEach((r) => {
        if (r.dataset.id === rec.id) r.setAttribute("aria-current", "true");
        else r.removeAttribute("aria-current");
      });
    } else ctx.openRecord(kind, rec);
  };

  function row(rec: AnyRecord, today: string): HTMLButtonElement {
    const sub = subtitle(kind, rec);
    // Your answer to an invite: Declined stays listed here, labelled; Maybe gets a soft label.
    const answer = kind === "event" ? (rec as AthenaEvent).rsvp : undefined;
    const label = answer === "declined" ? "Declined" : answer === "maybe" ? "Maybe" : null;
    const b = h(
      "button",
      { class: `row${answer === "declined" ? " row--declined" : ""}`, type: "button", "data-id": rec.id, "aria-current": rec.id === selectedId ? "true" : undefined },
      leading(kind, rec),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title-line" }, h("span", { class: "row__title" }, recordTitle(rec)), label ? h("span", { class: "badge badge--rsvp" }, label) : null),
        sub ? h("span", { class: "row__meta" }, sub) : null
      ),
      trailing(kind, rec, today) ?? h("span", {})
    ) as HTMLButtonElement;
    b.addEventListener("click", () => open(rec));
    return b;
  }

  const group = (label: string, recs: AnyRecord[], today: string) =>
    h("section", { class: "group" }, h("h2", { class: "group__label" }, label), h("div", { class: "card card--flush list" }, ...recs.map((r) => row(r, today))));

  function paint() {
    const today = localToday();
    const needle = query.trim().toLowerCase();
    const shown = needle ? items.filter((r) => `${recordTitle(r)} ${subtitle(kind, r)} ${extra.get(r.id) ?? ""}`.toLowerCase().includes(needle)) : items;
    count.textContent = String(items.length);

    if (!loaded) return;
    if (!items.length) {
      const btn = h("button", { class: "btn btn--primary", type: "button" }, icons.plus(), `New ${copy.one}`);
      btn.addEventListener("click", () => newOne());
      list.replaceChildren(
        h("div", { class: "empty" }, h("span", { class: "tile" }, icons[RECORD_ICON[kind]]()), h("p", { class: "empty__title" }, `No ${copy.title.toLowerCase()} yet`), h("p", { class: "empty__sub" }, copy.empty), btn)
      );
    } else if (!shown.length) {
      list.replaceChildren(h("div", { class: "empty" }, h("span", { class: "tile" }, icons.search()), h("p", { class: "empty__title" }, `Nothing matches “${query.trim()}”`)));
    } else if (kind === "event") {
      const withNext = (shown as AthenaEvent[]).map((e) => {
        const at = whenLocal(e);
        return { e, at, next: nextOccurrence(at.date, e.recurrence, today) };
      });
      const upcoming = withNext.filter((x) => x.next).sort((a, b) => a.next!.localeCompare(b.next!) || (a.at.time ?? "").localeCompare(b.at.time ?? ""));
      const past = withNext.filter((x) => !x.next).sort((a, b) => b.at.date.localeCompare(a.at.date));
      list.replaceChildren(
        ...(upcoming.length ? [group("Coming up", upcoming.map((x) => x.e), today)] : []),
        ...(past.length ? [group("Past", past.map((x) => x.e), today)] : [])
      );
    } else {
      // Alphabetical, grouped by first letter once the list is long enough to need it.
      if (shown.length < 12) list.replaceChildren(h("div", { class: "card card--flush list" }, ...shown.map((r) => row(r, today))));
      else {
        const groups = new Map<string, AnyRecord[]>();
        for (const r of shown) {
          const letter = recordTitle(r).trim().charAt(0).toUpperCase();
          const key = /[A-Z]/.test(letter) ? letter : "#";
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        list.replaceChildren(...[...groups].map(([k, recs]) => group(k, recs, today)));
      }
    }

    if (ctx.isDesktop()) {
      const current = items.find((r) => r.id === selectedId);
      if (current) showInPane(current);
      else if (paneView && !paneView.recordId()) {
        // A new record is being filled in; leave it be.
      } else {
        clearPane();
        pane.replaceChildren(
          h(
            "div",
            { class: "pane-empty" },
            h(
              "div",
              { class: "empty" },
              h("span", { class: "tile" }, icons[RECORD_ICON[kind]]()),
              h("p", { class: "empty__title" }, "Nothing selected"),
              h("p", { class: "empty__sub" }, `Pick ${/^[aeiou]/.test(copy.one) ? "an" : "a"} ${copy.one} on the left, or add a new one.`)
            )
          )
        );
      }
    }
  }

  async function load() {
    const { items: loadedItems } = await loadRecords(kind);
    items = loadedItems;
    loaded = true;
    paint();
  }

  async function loadExtra() {
    const { fields, values } = await loadKindValues(kind);
    extra = new Map(Object.entries(values).map(([id, v]) => [id, valuesSearchText(fields, v)]));
    if (query.trim()) paint();
  }

  input.addEventListener("input", () => {
    query = input.value;
    paint();
  });

  list.replaceChildren(
    h("div", { class: "card card--flush list" }, ...[0, 1, 2].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:50%" })), h("span", {}))))
  );
  void load();
  void loadExtra();
  const unsub = onRecordsChange((k) => {
    if (k === kind || k === "all") void load();
  });
  const unsubFields = onCustomFieldsChange((k) => (k === kind || k === null) && void loadExtra());

  const onScroll = () => head.classList.toggle("is-scrolled", (ctx.isDesktop() ? col.scrollTop : window.scrollY) > 4);
  const target: EventTarget = ctx.isDesktop() ? col : window;
  target.addEventListener("scroll", onScroll, { passive: true });

  return {
    el,
    focusSearch: () => requestAnimationFrame(() => input.focus()),
    destroy: () => {
      unsub();
      unsubFields();
      clearPane();
      target.removeEventListener("scroll", onScroll);
    },
  };
}
