/**
 * The Library index (#/library): everything Athena keeps, in the groups
 * lib/library-layout.ts sets out (Notes and collections, People and places,
 * Home and money, Health and habits, the owner's own kinds, and More: Graph,
 * Archived, Settings). Each row says what's in it now in a few words ("2 on the way",
 * "Lisbon, coming up"), filled in as each list arrives; until then, and if a
 * list can't load, the row says what the section is for. Groups and names
 * come from components/library-nav.ts, so the sidebar and ⌘K match.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { libraryGroups, type LibraryItem } from "../components/library-nav";
import { isKindView, kindIdOf } from "../lib/routes";
import type { ViewId } from "../components/nav";
import { notesSnapshot } from "../db/data";
import { loadRecords } from "../db/records";
import { loadPurchases, loadTrips } from "../db/trips";
import { loadAssets, loadGoals, loadReading, renewals } from "../db/memory";
import { loadKindRecords } from "../db/custom-kinds";
import { loadSaved } from "../db/saved";
import { loadMusic } from "../db/music";
import { loadWork } from "../db/work";
import { listFlows } from "../db/flows";
import { KIND_WORD } from "../../../lib/custom-kind-words";
import { plural } from "../lib/format";
import { localToday } from "../lib/time";
import type { RecordKind } from "../types";
import { pageHead } from "../components/page-head";

/** What each section is for, shown until (or instead of) its live summary. */
const ABOUT: Partial<Record<ViewId, string>> = {
  notes: "Everything you've written or collected",
  saved: "Pages and pictures you sent to Athena",
  people: "Who you know",
  places: "Where you go",
  organisations: "Where people work and what you deal with",
  events: "Birthdays, anniversaries and plans",
  trips: "Flights, stays and tickets",
  purchases: "Orders and deliveries",
  money: "What you spent, and where",
  house: "Energy, bills and the home itself",
  health: "Sleep, steps, workouts and weight",
  habits: "What you ticked off, day by day",
  admin: "Renewals and expiries",
  reading: "Books, films, shows and more",
  music: "Artists and albums you play",
  goals: "What you're working towards",
  work: "What you closed, merged and reviewed",
  graph: "How everything links together",
  flows: "What Athena does for you when something happens",
  archived: "Put away, ready to restore",
  settings: "Sources, fields, voice and keys",
};

/** Flows sits with More: not something Athena keeps, but something it does (flows/list.ts). */
const FLOWS: LibraryItem = { view: "flows", label: "Flows", icon: "flow" };

const RECORD_KIND: Partial<Record<ViewId, [RecordKind, string, string]>> = {
  people: ["person", "person", "people"],
  places: ["place", "place", "places"],
  organisations: ["organisation", "organisation", "organisations"],
  events: ["event", "event", "events"],
};

const num = (n: number) => n.toLocaleString("en-GB");

const DONE_PURCHASE = new Set(["delivered", "returned", "refunded", "cancelled"]);

/** A live line for a section, or null to keep what it's for. */
async function summary(view: ViewId): Promise<string | null> {
  const rec = RECORD_KIND[view];
  if (rec) {
    const { items } = await loadRecords(rec[0]);
    return items.length ? `${items.length} ${plural(items.length, rec[1], rec[2])}` : null;
  }
  const today = localToday();
  switch (view) {
    case "notes": {
      const n = notesSnapshot().notes.length;
      return n ? `${n} ${plural(n, "note", "notes")}` : null;
    }
    case "saved": {
      const { counts } = await loadSaved({ limit: 1 });
      if (!counts.all) return null;
      const parts = (["link", "image", "quote"] as const).filter((k) => counts[k]).map((k) => `${counts[k]} ${plural(counts[k], k, `${k}s`)}`);
      return parts.length ? parts.join(", ") : `${counts.all} saved`;
    }
    case "trips": {
      const { items } = await loadTrips();
      const ahead = items.filter((t) => (t.ends_on ?? t.starts_on ?? "") >= today).sort((a, b) => (a.starts_on ?? "").localeCompare(b.starts_on ?? ""));
      if (!ahead.length) return items.length ? "Nothing coming up" : null;
      return ahead.length === 1 ? `${ahead[0].title}, coming up` : `${ahead[0].title} next, ${ahead.length} coming up`;
    }
    case "purchases": {
      const { items } = await loadPurchases();
      const moving = items.filter((p) => !DONE_PURCHASE.has(p.status)).length;
      return moving ? `${moving} on the way` : items.length ? "Nothing on the way" : null;
    }
    case "admin": {
      const { items } = await loadAssets();
      const due = renewals(items, 60).length;
      return due ? `${due} due in the next two months` : items.length ? "Nothing due soon" : null;
    }
    case "reading": {
      const { items } = await loadReading();
      const now = items.filter((r) => r.status === "reading").length;
      const next = items.filter((r) => r.status === "queued").length;
      if (now) return `${now} on the go${next ? `, ${next} up next` : ""}`;
      return next ? `${next} up next` : null;
    }
    case "music": {
      const m = await loadMusic("month");
      if (!m.has_music) return null;
      return m.plays ? `${num(m.plays)} ${plural(m.plays, "play", "plays")} this month${m.top_artists[0] ? `, mostly ${m.top_artists[0].name}` : ""}` : "Nothing played this month";
    }
    case "work": {
      const w = await loadWork("month");
      if (!w.has_work) return null;
      const n = w.count.issues_closed + w.count.prs_merged;
      return n ? `${num(n)} shipped this month` : "Nothing shipped this month yet";
    }
    case "flows": {
      const { flows, latest } = await listFlows();
      if (!flows.length) return null;
      const waiting = flows.filter((f) => latest[f.id]?.status === "waiting" && !latest[f.id].dry && (latest[f.id].waits_for === "go" || latest[f.id].waits_for === "answer")).length;
      return `${flows.length} ${plural(flows.length, "flow", "flows")}${waiting ? `, ${waiting} ${waiting === 1 ? "needs" : "need"} you` : ""}`;
    }
    case "goals": {
      const { items } = await loadGoals();
      const active = items.filter((g) => g.status === "active").length;
      return active ? `${active} active` : null;
    }
  }
  if (isKindView(view)) {
    const { items } = await loadKindRecords(kindIdOf(view));
    return items.length ? `${items.length} saved` : "Nothing saved yet";
  }
  return null;
}

export function renderLibrary(ctx: { go: (view: ViewId, opts?: { noteId?: string | null }) => void }): { el: HTMLElement; destroy: () => void } {
  let alive = true;

  const row = (item: LibraryItem) => {
    const meta = h("span", { class: "row__meta" }, ABOUT[item.view] ?? "");
    const b = h(
      "button",
      { class: "row lib-row", type: "button", "data-view": item.view },
      h("span", { class: "tile tile--sm lib-row__tile" }, icons[item.icon]()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, item.label), meta),
      h("span", { class: "row__trail" }, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()))
    );
    b.addEventListener("click", () => ctx.go(item.view));
    void summary(item.view)
      .then((line) => {
        if (!alive || !line) return;
        meta.textContent = line;
        meta.classList.add("lib-row__live");
      })
      .catch(() => undefined);
    return b;
  };

  /** No kinds of your own yet: one row that says what they are and where to make one. */
  const makeKind = () => {
    const b = h(
      "button",
      { class: "row lib-row lib-row--empty", type: "button" },
      h("span", { class: "tile tile--sm lib-row__tile" }, icons.plus()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Make your own"), h("span", { class: "row__meta" }, KIND_WORD.detail)),
      h("span", { class: "row__trail" }, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()))
    );
    b.addEventListener("click", () => ctx.go("settings", { noteId: KIND_WORD.slug }));
    return b;
  };

  const groups = libraryGroups().map((g, i) =>
    h(
      "section",
      { class: "group lib-group reveal", "data-group": g.id, style: `--i:${i}`, "aria-labelledby": `lib-${g.id}` },
      h("div", { class: "group__head" }, h("h2", { class: "lib-group__label", id: `lib-${g.id}` }, g.label)),
      h("div", { class: "card card--flush list" }, ...(g.items.length ? (g.id === "more" ? [FLOWS, ...g.items] : g.items).map(row) : [makeKind()]))
    )
  );

  const el = h(
    "div",
    { class: "view library" },
    pageHead({ title: "Library", lede: "Everything Athena keeps, in one place." }),
    h("div", { class: "lib-groups" }, ...groups)
  );
  return {
    el,
    destroy: () => {
      alive = false;
    },
  };
}
