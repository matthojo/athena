/**
 * Library: one of the owner's own kinds of record ("Wines"), at #/kind/<id>.
 * Built like People and Places: a sticky header with the Library's sections,
 * the kind's name, a count, "New wine" and a filter box over its records; on
 * desktop the list sits beside a profile pane, on mobile a tap opens the
 * record in a sheet. Rows show a record's first one or two filled fields.
 * The filter matches titles, notes and the text and choice fields.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { customRecordProfile, kindIcon, recordSubtitle, withArticle, type CustomProfileView } from "../components/custom-record-profile";
import { openNoteSheet } from "../components/note-detail";
import { kindById, loadKindRecords, loadKinds, onKindsChange } from "../db/custom-kinds";
import { loadKindValues, onCustomFieldsChange, valuesSearchText, type CustomField, type ValueMap } from "../db/custom-fields";
import { rememberFieldsKind } from "../lib/field-meta";
import { markdownToText } from "../lib/markdown-text";
import { addFieldsPrompt } from "../../../lib/custom-field-rules";
import { kindView, type ViewId } from "../components/nav";
import type { CustomKind, CustomRecord, EntityKind } from "../types";
import { pageHead } from "../components/page-head";

export interface CustomRecordsContext {
  kindId: string;
  recordId: string | null;
  isDesktop: () => boolean;
  openRecord: (rec: CustomRecord) => void;
  newRecord: (kindId: string) => void;
  openLink: (kind: EntityKind, id: string) => void;
  go: (view: ViewId) => void;
  onSelectionChange: (id: string | null) => void;
}

/** "Grape, Region and 2 more" from addFieldsPrompt's wording, without its "Add". */
const fieldList = (fields: CustomField[]) => addFieldsPrompt(fields.map((f) => f.label)).replace(/^Add /, "");

export function renderCustomRecords(ctx: CustomRecordsContext): { el: HTMLElement; destroy: () => void; focusSearch: () => void } {
  const { kindId } = ctx;
  let kind: CustomKind | undefined = kindById(kindId);
  let items: CustomRecord[] = [];
  let loaded = false;
  let selectedId = ctx.recordId;
  let query = "";
  let fields: CustomField[] = [];
  let values: Record<string, ValueMap> = {};
  const fieldKind = `custom:${kindId}` as const;

  const title = h("h1", { class: "page-title" });
  const count = h("span", { class: "page-count" });
  const addLabel = h("span", {});
  const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), addLabel);
  add.addEventListener("click", () => newOne());
  const editFields = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost records__fields", type: "button" }, icons.sliders());
  /** Settings › Your fields, on this kind's tab. */
  const openFields = () => {
    rememberFieldsKind(fieldKind);
    location.hash = "#/settings/fields";
  };
  editFields.addEventListener("click", openFields);
  const input = h("input", { type: "search", name: "q", autocomplete: "off", enterkeyhint: "search" }) as HTMLInputElement;
  const head = pageHead({
    segments: librarySegments(kindView(kindId), ctx.go),
    title,
    count,
    actions: [editFields, add],
    below: [h("label", { class: "search" }, icons.search(), input)],
  });
  const list = h("div", { class: "notes__list" });
  const col = h("div", { class: "notes__col" }, head, list);
  const pane = h("section", { class: "notes__pane" });
  const el = h("div", { class: "view notes records records--custom" }, col, pane);

  function paintHead() {
    const name = kind?.name ?? "";
    title.textContent = name;
    // A long name keeps its title on one line: the button just says New.
    const newLabel = `New ${kind?.one ?? "item"}`;
    addLabel.textContent = name.length + newLabel.length > 22 ? "New" : newLabel;
    add.setAttribute("aria-label", newLabel);
    input.placeholder = `Search ${kind ? kind.name.toLowerCase() : ""}`.trim();
    input.setAttribute("aria-label", input.placeholder);
    editFields.setAttribute("aria-label", `Fields for ${name.toLowerCase()}`);
    editFields.title = `Fields for ${name.toLowerCase()}`;
    pane.setAttribute("aria-label", name);
    add.hidden = !kind;
    editFields.hidden = !kind;
  }

  let paneView: CustomProfileView | null = null;
  const clearPane = () => {
    paneView?.destroy();
    paneView = null;
  };
  function showInPane(rec: CustomRecord | null) {
    if (rec && paneView?.recordId() === rec.id) return;
    clearPane();
    paneView = customRecordProfile(kindId, rec, {
      close: () => {
        clearPane();
        selectedId = null;
        ctx.onSelectionChange(null);
        paint();
      },
      openLink: ctx.openLink,
      compose: (seed) => openNoteSheet(null, { openLink: ctx.openLink, seed }),
      onCreated: (created) => {
        selectedId = created.id;
        ctx.onSelectionChange(created.id);
      },
      onDuplicated: (copy) => {
        selectedId = copy.id;
        ctx.onSelectionChange(copy.id);
        void load().then(() => showInPane(items.find((r) => r.id === copy.id) ?? copy));
      },
      autofocus: !rec,
    });
    pane.replaceChildren(paneView.el);
    pane.scrollTop = 0;
  }

  function newOne() {
    if (!kind) return;
    if (!ctx.isDesktop()) return ctx.newRecord(kindId);
    selectedId = null;
    ctx.onSelectionChange(null);
    list.querySelectorAll<HTMLElement>(".row[aria-current]").forEach((r) => r.removeAttribute("aria-current"));
    clearPane();
    showInPane(null);
  }

  const open = (rec: CustomRecord) => {
    if (ctx.isDesktop()) {
      selectedId = rec.id;
      ctx.onSelectionChange(rec.id);
      showInPane(rec);
      list.querySelectorAll<HTMLElement>(".row").forEach((r) => {
        if (r.dataset.id === rec.id) r.setAttribute("aria-current", "true");
        else r.removeAttribute("aria-current");
      });
    } else ctx.openRecord(rec);
  };

  function row(rec: CustomRecord): HTMLButtonElement {
    const sub = recordSubtitle(fields, values[rec.id]);
    const b = h(
      "button",
      { class: "row", type: "button", "data-id": rec.id, "aria-current": rec.id === selectedId ? "true" : undefined },
      h("span", { class: "tile tile--sm" }, icons[kindIcon(kind)]()),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title-line" }, h("span", { class: "row__title" }, rec.title || "Untitled")),
        sub ? h("span", { class: "row__meta" }, sub) : null
      ),
      h("span", {})
    ) as HTMLButtonElement;
    b.addEventListener("click", () => open(rec));
    return b;
  }

  const group = (label: string, recs: CustomRecord[]) =>
    h("section", { class: "group" }, h("h2", { class: "group__label" }, label), h("div", { class: "card card--flush list" }, ...recs.map(row)));

  /** What a record's search matches: its title, its notes as text, and its text and choice values. */
  const haystack = (r: CustomRecord) => `${r.title} ${markdownToText(r.body)} ${valuesSearchText(fields, values[r.id])}`.toLowerCase();

  function emptyState(): HTMLElement {
    if (!kind) {
      const archived = h("button", { class: "btn btn--soft", type: "button" }, icons.archive(), "Open Archived");
      archived.addEventListener("click", () => ctx.go("archived"));
      return h(
        "div",
        { class: "empty" },
        h("span", { class: "tile" }, icons.folder()),
        h("p", { class: "empty__title" }, "This isn't here any more"),
        h("p", { class: "empty__sub" }, "It may have been archived. Anything archived waits on the Archived page."),
        archived
      );
    }
    const btn = h("button", { class: "btn btn--primary", type: "button" }, icons.plus(), `New ${kind.one}`);
    btn.addEventListener("click", () => newOne());
    const fieldsBtn = h("button", { class: "btn btn--soft", type: "button" }, icons.sliders(), "Add fields");
    fieldsBtn.addEventListener("click", openFields);
    const what = fields.length
      ? `Add your first ${kind.one}. Each one keeps its ${fieldList(fields)}, with notes of its own.`
      : `Add your first ${kind.one}, and give ${kind.name.toLowerCase()} fields of their own, like a rating or where each came from.`;
    return h(
      "div",
      { class: "empty" },
      h("span", { class: "tile" }, icons[kindIcon(kind)]()),
      h("p", { class: "empty__title" }, `No ${kind.name.toLowerCase()} yet`),
      h("p", { class: "empty__sub" }, what),
      fields.length ? btn : h("div", { class: "empty__actions" }, btn, fieldsBtn)
    );
  }

  function paint() {
    paintHead();
    const needle = query.trim().toLowerCase();
    const shown = needle ? items.filter((r) => haystack(r).includes(needle)) : items;
    count.textContent = kind ? String(items.length) : "";

    if (!loaded) return;
    if (!kind || !items.length) list.replaceChildren(emptyState());
    else if (!shown.length) list.replaceChildren(h("div", { class: "empty" }, h("span", { class: "tile" }, icons.search()), h("p", { class: "empty__title" }, `Nothing matches “${query.trim()}”`)));
    else if (shown.length < 12) list.replaceChildren(h("div", { class: "card card--flush list" }, ...shown.map(row)));
    else {
      // Alphabetical, grouped by first letter once the list is long enough to need it.
      const groups = new Map<string, CustomRecord[]>();
      for (const r of shown) {
        const letter = r.title.trim().charAt(0).toUpperCase();
        const key = /[A-Z]/.test(letter) ? letter : "#";
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      list.replaceChildren(...[...groups].map(([k, recs]) => group(k, recs)));
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
              h("span", { class: "tile" }, icons[kindIcon(kind)]()),
              h("p", { class: "empty__title" }, "Nothing selected"),
              h("p", { class: "empty__sub" }, kind ? `Pick ${withArticle(kind.one)} on the left, or add a new one.` : "")
            )
          )
        );
      }
    }
  }

  async function load() {
    if (!kind) {
      await loadKinds();
      kind = kindById(kindId);
    }
    const [{ items: loadedItems }, kv] = await Promise.all([loadKindRecords(kindId), kind ? loadKindValues(fieldKind) : Promise.resolve({ fields: [], values: {} })]);
    items = loadedItems;
    fields = kv.fields;
    values = kv.values;
    loaded = true;
    paint();
  }

  input.addEventListener("input", () => {
    query = input.value;
    paint();
  });

  paintHead();
  list.replaceChildren(
    h("div", { class: "card card--flush list" }, ...[0, 1, 2].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:50%" })), h("span", {}))))
  );
  void load();
  const unsub = onKindsChange((k) => {
    if (k === kindId) return void load();
    if (k !== null) return;
    kind = kindById(kindId);
    void load();
  });
  const unsubFields = onCustomFieldsChange((k) => (k === fieldKind || k === null) && void load());

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
