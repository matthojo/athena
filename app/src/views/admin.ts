/**
 * Life admin: the things that quietly renew or expire — passport, insurance,
 * MOT, subscriptions, warranties — grouped by how soon they need you. Each
 * one feeds Coming up and the morning reminders on its "remind me" days.
 * Numbers (passport, policy, account) never go here; the sheet says so.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { openEditorSheet } from "../components/editor-sheet";
import { autoTextarea, field, input, select } from "../components/fields";
import { showToast } from "../components/toast";
import { customFieldsSection } from "../components/custom-fields";
import { deleteMemoryForever, loadAssets, onMemoryChange, saveAsset, setMemoryArchived } from "../db/memory";
import { calendarDate, relativeTime } from "../lib/format";
import { ASSET_META, renewalLabel } from "../lib/memory-meta";
import { daysBetween } from "../../../lib/dates";
import { localToday } from "../lib/time";
import type { Asset, AssetKind } from "../types";
import type { ViewId } from "../components/nav";
import { pageHead } from "../components/page-head";
import { carCardView } from "../components/car-card";
import { fetchCar, refreshCar, type CarView } from "../db/car";

/** "9 Nov", or "9 Nov 2027" when it isn't this year. */
function shortDay(date: string, today: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: date.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`)
  );
}

const REMIND = [
  { days: 30, label: "Month before" },
  { days: 7, label: "Week before" },
  { days: 0, label: "On the day" },
];

export function openAssetSheet(initial: Asset | null): void {
  let rec = initial;
  const kind = select(
    "Kind",
    (Object.keys(ASSET_META) as AssetKind[]).map((k) => ({ value: k, label: ASSET_META[k].label })),
    initial?.kind ?? "other"
  );
  const provider = input("text", initial?.provider ?? "", { placeholder: "Who it's with", autocomplete: "off" });
  const renews = input("date", initial?.renews_on ?? "", { "aria-label": "Renews or expires" });
  let remind = [...(initial?.remind_days_before ?? [30, 7, 0])];
  const remindRow = h(
    "span",
    { class: "chip-row chip-row--wrap prop__toggles", role: "group", "aria-label": "Remind me" },
    ...REMIND.map((o) => {
      const b = h("button", { class: "chip", type: "button", "aria-pressed": String(remind.includes(o.days)) }, o.label);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        remind = remind.includes(o.days) ? remind.filter((d) => d !== o.days) : [...remind, o.days].sort((a, b) => b - a);
        b.setAttribute("aria-pressed", String(remind.includes(o.days)));
        if (rec) save({ remind_days_before: remind });
      });
      return b;
    })
  );
  const notes = autoTextarea(initial?.notes ?? "", { name: "notes", placeholder: "How to renew, who to call", "aria-label": "Notes" }, 44);

  let saving: Promise<void> = Promise.resolve();
  function save(patch: Partial<Asset>) {
    saving = saving.then(async () => {
      if (!rec) return;
      try {
        rec = await saveAsset(patch, rec.id);
        editor.refresh();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
      }
    });
  }
  kind.addEventListener("change", () => {
    mark.replaceChildren(icons[ASSET_META[kind.value as AssetKind].icon]());
    if (rec) save({ kind: kind.value as AssetKind });
  });
  provider.addEventListener("change", () => rec && save({ provider: provider.value.trim() }));
  renews.addEventListener("change", () => rec && save({ renews_on: renews.value || null }));
  notes.addEventListener("change", () => rec && save({ notes: notes.value }));

  const fields = h("div", { class: "card card--flush fields" }, field("Kind", kind), field("With", provider), field("Renews", renews), field("Remind me", remindRow), field("Notes", notes));
  fields.children[3].classList.add("prop--stack");
  // The owner's own fields follow the built-in ones once the item exists.
  const custom = customFieldsSection("asset");
  custom.attach(fields);
  custom.show(initial?.id ?? null);
  const mark =h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[ASSET_META[initial?.kind ?? "other"].icon]());

  const editor = openEditorSheet({
    newLabel: "New life admin item",
    isNew: !initial,
    titleValue: initial?.name ?? "",
    placeholder: "Passport, car insurance, Netflix…",
    mark,
    sections: [fields, h("p", { class: "sheet-hint" }, icons.shield(), "Keep passport, policy and account numbers out of here.")],
    onTitle: (name) => save({ name }),
    create: async () => {
      const created = await saveAsset({
        name: editor.title.value.trim(),
        kind: kind.value as AssetKind,
        provider: provider.value.trim(),
        renews_on: renews.value || null,
        remind_days_before: remind,
        notes: notes.value,
      });
      await custom.commit(created.id);
      showToast("Added to Life admin", { icon: "shield" });
      return true;
    },
    status: () => (rec ? `Updated ${relativeTime(rec.updated_at)}` : ""),
    archive: async () => {
      if (!rec) return;
      const { id } = rec;
      await setMemoryArchived("asset", id, true);
      showToast("Archived", { icon: "archive", action: { label: "Undo", run: () => void setMemoryArchived("asset", id, false) } });
    },
    remove: {
      what: initial ? `“${initial.name}”` : "It",
      run: async () => {
        if (rec) await deleteMemoryForever("asset", rec.id);
      },
    },
  });
  editor.sheet.dialog.addEventListener("close", () => custom.destroy());
}

export function renderAdmin(ctx: { go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  let items: Asset[] = [];
  let loaded = false;
  const count = h("span", { class: "page-count" });
  const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "New");
  add.addEventListener("click", () => openAssetSheet(null));
  const list = h("div", { class: "notes__list" });
  // The car (components/car-card.ts): only when one has been added in Sources.
  const cars = h("section", { class: "car-sec", hidden: true, "aria-label": "Your car" });
  const el = h(
    "div",
    { class: "view lists" },
    pageHead({
      segments: librarySegments("admin", ctx.go),
      title: "Life admin",
      count,
      actions: [add],
      lede: "Everything that renews or expires. Athena reminds you before each one, in the morning briefing.",
    }),
    cars,
    list
  );

  function paintCars(view: CarView) {
    const today = localToday();
    cars.hidden = !view.vehicles.length;
    cars.replaceChildren(
      h("h2", { class: "group__label" }, view.vehicles.length === 1 ? "Your car" : "Your cars"),
      ...view.vehicles.map((c) =>
        carCardView(c, today, {
          onRefresh: () =>
            void refreshCar()
              .then((v) => (paintCars(v), void load()))
              .catch(() => showToast("Couldn't check the car just now", { icon: "wifiOff" })),
        })
      )
    );
  }
  void fetchCar().then(paintCars, () => undefined);

  function row(a: Asset, today: string): HTMLElement {
    const meta = ASSET_META[a.kind];
    const n = a.renews_on ? daysBetween(today, a.renews_on) : null;
    const tone = n === null ? "" : n < 0 ? "late" : n <= 14 ? "soon" : "";
    const b = h(
      "button",
      { class: "row", type: "button" },
      h("span", { class: "tile tile--sm" }, icons[meta.icon]()),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title-line" }, h("span", { class: "row__title" }, a.name)),
        h(
          "span",
          { class: "row__meta" },
          [a.provider.toLowerCase() === a.name.toLowerCase() ? "" : a.provider, a.renews_on ? shortDay(a.renews_on, today) : "No date"].filter(Boolean).join(" · ")
        )
      ),
      n !== null ? h("span", { class: "row__time renewal", "data-tone": tone || undefined }, renewalLabel(a.kind, n)) : h("span", {})
    );
    b.addEventListener("click", () => openAssetSheet(a));
    return b;
  }

  function paint() {
    if (!loaded) return;
    count.textContent = String(items.length);
    if (!items.length) {
      const btn = h("button", { class: "btn btn--primary", type: "button" }, icons.plus(), "Add the first one");
      btn.addEventListener("click", () => openAssetSheet(null));
      list.replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("span", { class: "tile" }, icons.shield()),
          h("p", { class: "empty__title" }, "Nothing tracked yet"),
          h("p", { class: "empty__sub" }, "Start with whatever lapsing would hurt most: passport, car insurance, MOT, home insurance."),
          btn
        )
      );
      return;
    }
    const today = localToday();
    const days = (a: Asset) => (a.renews_on ? daysBetween(today, a.renews_on) : null);
    const groups: [string, Asset[], string?][] = [
      ["Needs attention", items.filter((a) => (days(a) ?? 999) <= 30), "late"],
      ["Coming up", items.filter((a) => (days(a) ?? 999) > 30 && (days(a) ?? 999) <= 180)],
      ["Later", items.filter((a) => (days(a) ?? -1) > 180)],
      ["No date", items.filter((a) => days(a) === null)],
    ];
    list.replaceChildren(
      ...groups
        .filter(([, rows]) => rows.length)
        .map(([label, rows, tone]) =>
          h(
            "section",
            { class: "group", "data-tone": tone },
            h("h2", { class: "group__label" }, label, h("span", { class: "group__count" }, String(rows.length))),
            h("div", { class: "card card--flush list" }, ...rows.map((a) => row(a, today)))
          )
        )
    );
  }

  async function load() {
    const { items: loadedItems } = await loadAssets();
    items = [...loadedItems].sort((a, b) => (a.renews_on ?? "9999").localeCompare(b.renews_on ?? "9999") || a.name.localeCompare(b.name));
    loaded = true;
    paint();
  }

  void load();
  const unsub = onMemoryChange((t) => (t === "asset" || t === "all") && void load());
  return { el, destroy: unsub };
}
