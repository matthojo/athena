/**
 * Settings' section for the owner's own kinds of record (#/settings/types,
 * with its name and words from lib/custom-kind-words.ts): each kind with its
 * icon, how many records it holds and its fields; a new one; rename, a new
 * icon, reorder; Duplicate and Archive. A kind's fields are edited where every
 * field is, in "Your fields", on the kind's own tab ("Edit fields" goes
 * there).
 *
 * The editor is the same sheet as fields and life admin
 * (components/editor-sheet.ts). A new kind is made by its button and the sheet
 * stays open on it, so adding its fields is the next step. An archived kind
 * waits on the Archived page with everything in it.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openEditorSheet } from "./editor-sheet";
import { field as propRow, input } from "./fields";
import { showToast } from "./toast";
import { duplicateKind, kindsSnapshot, loadKinds, onKindsChange, reorderKinds, saveKind, setKindArchived } from "../db/custom-kinds";
import { liveFields, loadAllFields, onCustomFieldsChange, type CustomField } from "../db/custom-fields";
import { rememberFieldsKind } from "../lib/field-meta";
import { kindIcon } from "../lib/entity-icon";
import { relativeTime } from "../lib/format";
import { KIND_ICONS, singular } from "../../../lib/custom-field-rules";
import { KIND_WORD } from "../../../lib/custom-kind-words";
import type { ConnectionState, CustomKind } from "../types";
import type { ViewId } from "./nav";

/** What each icon is, for the picker's labels. */
const ICON_NAMES: Record<(typeof KIND_ICONS)[number], string> = {
  folder: "Folder",
  wine: "Wine glass",
  leaf: "Leaf",
  dice: "Dice",
  cup: "Cup",
  book: "Book",
  film: "Film",
  music: "Music",
  game: "Game",
  bookmark: "Bookmark",
  star: "Star",
  heart: "Heart",
  gift: "Gift",
  tag: "Tag",
  pin: "Pin",
  plane: "Plane",
  suitcase: "Suitcase",
  ticket: "Ticket",
  car: "Car",
  paw: "Paw",
  parcel: "Parcel",
  target: "Target",
  flag: "Flag",
  sparkle: "Sparkle",
  briefcase: "Briefcase",
  people: "People",
};

/** "Grape, Region, Rating and Price", or past four "Grape, Region, Rating and 2 more": names as the owner wrote them. */
function fieldNames(fields: CustomField[]): string {
  const names = fields.map((f) => f.label);
  if (names.length <= 1) return names.join("");
  if (names.length <= 4) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** "4 wines · Grape, Region and 2 more". */
function kindSummary(k: CustomKind, fields: CustomField[]): string {
  const count = k.record_count ? `${k.record_count} ${k.record_count === 1 ? k.one : k.name.toLowerCase()}` : `No ${k.name.toLowerCase()} yet`;
  return [count, fields.length ? fieldNames(fields) : "No fields yet"].join(" · ");
}

/** Settings › Your fields, on this kind's tab. */
function openFields(k: CustomKind) {
  rememberFieldsKind(k.kind);
  location.hash = "#/settings/fields";
}

/** Make a kind (null) or change one: its name, what one is called, its icon. */
export function openKindEditor(initial: CustomKind | null, ctx: { go: (view: ViewId) => void }): void {
  let rec = initial;
  let icon: string = initial?.icon ?? KIND_ICONS[0];

  const mark = h("span", { class: "tile tile--sm", "aria-hidden": "true" });
  const paintMark = () => mark.replaceChildren(icons[kindIcon({ icon })]());
  paintMark();

  let saving: Promise<void> = Promise.resolve();
  function save(patch: { name?: string; one?: string; icon?: string }, revert?: () => void) {
    if (!rec) return;
    saving = saving.then(async () => {
      if (!rec) return;
      try {
        rec = await saveKind(patch, rec.id);
        oneInput.value = rec.one;
        editor.refresh();
      } catch (error) {
        revert?.();
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "pen", timeoutMs: 5000 });
      }
    });
  }

  // ---------- what one is called ----------
  const oneInput = input("text", initial?.one ?? "", { autocomplete: "off", maxlength: 40, enterkeyhint: "done", "aria-label": "One of them is called" });
  const oneHint = h("p", { class: "field-types__hint" });
  const paintOneHint = () => {
    const one = oneInput.value.trim() || oneInput.placeholder;
    oneHint.textContent = one ? `For buttons like “New ${one}”.` : "";
  };
  oneInput.addEventListener("input", paintOneHint);
  oneInput.addEventListener("keydown", (e) => e.key === "Enter" && oneInput.blur());
  oneInput.addEventListener("change", () => {
    const before = rec?.one ?? "";
    if (rec && oneInput.value.trim() && oneInput.value.trim() !== before) save({ one: oneInput.value.trim() }, () => (oneInput.value = before));
    if (!oneInput.value.trim() && rec) oneInput.value = before;
    paintOneHint();
  });
  const oneSection = h("section", { class: "profile__section" }, h("div", { class: "card card--flush fields" }, propRow("One is called", oneInput)), oneHint);

  // ---------- icon ----------
  const iconButtons = KIND_ICONS.map((name) => {
    const b = h(
      "button",
      { class: "kind-icon", type: "button", role: "radio", "aria-checked": String(name === icon), "aria-label": ICON_NAMES[name], title: ICON_NAMES[name] },
      icons[name as IconName]()
    );
    b.addEventListener("click", () => {
      if (name === icon) return;
      const before = icon;
      icon = name;
      paintIcons();
      save({ icon: name }, () => {
        icon = before;
        paintIcons();
      });
    });
    return b;
  });
  const paintIcons = () => {
    iconButtons.forEach((b, i) => b.setAttribute("aria-checked", String(KIND_ICONS[i] === icon)));
    paintMark();
  };
  const iconSection = h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Icon"), h("div", { class: "kind-icons", role: "radiogroup", "aria-label": "Icon" }, ...iconButtons));

  // ---------- its fields ----------
  const fieldsBody = h("div", { class: "kind-fields" });
  const fieldsSection = h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Fields"), fieldsBody);
  function paintFields(fields: CustomField[]) {
    if (!rec) {
      fieldsBody.replaceChildren(h("p", { class: "field-types__hint" }, "Once it's made, give it the fields each one should have, like a rating or a price."));
      return;
    }
    const k = rec;
    const edit = h("button", { class: `btn ${fields.length ? "btn--soft" : "btn--primary"} btn--sm`, type: "button" }, fields.length ? icons.sliders() : icons.plus(), fields.length ? "Edit fields" : "Add fields");
    edit.addEventListener("click", () => {
      editor.sheet.close();
      setTimeout(() => openFields(k), 200);
    });
    fieldsBody.replaceChildren(
      h(
        "div",
        { class: "kind-fields__row" },
        h("p", { class: "kind-fields__names" }, fields.length ? fieldNames(fields) : `${k.name} have no fields yet.`),
        edit
      )
    );
  }
  const refreshFields = () => void loadAllFields().then(({ fields }) => paintFields(rec ? liveFields(fields, rec.kind) : []));
  paintFields([]);
  refreshFields();

  const editor = openEditorSheet({
    newLabel: KIND_WORD.new,
    isNew: !initial,
    titleValue: initial?.name ?? "",
    placeholder: "Name, like Wines or Plants",
    mark,
    createLabel: `Add ${KIND_WORD.one}`,
    sections: [oneSection, iconSection, fieldsSection],
    onTitle: (name) => {
      const before = rec?.name ?? "";
      save({ name }, () => (editor.title.value = before));
    },
    create: async () => {
      rec = await saveKind({ name: editor.title.value, one: oneInput.value.trim() || undefined, icon });
      oneInput.value = rec.one;
      editor.title.value = rec.name;
      editor.refresh();
      // It isn't new any more: the sheet's heading goes, as an existing one's has none.
      editor.sheet.setTitle("");
      paintFields([]);
      showToast(`Made ${rec.name}. Now give ${rec.name.toLowerCase()} some fields.`, { icon: "check" });
      // Stays open: adding its fields is the next step.
      return false;
    },
    status: () => (rec ? `${rec.record_count ? `${rec.record_count} ${rec.record_count === 1 ? rec.one : rec.name.toLowerCase()}` : `No ${rec.name.toLowerCase()} yet`} · made ${relativeTime(rec.created_at)}` : ""),
    action: () =>
      rec
        ? {
            icon: "arrowRight",
            label: `Open ${rec.name}`,
            run: () => {
              const id = rec!.id;
              editor.sheet.close();
              setTimeout(() => (location.hash = `#/kind/${encodeURIComponent(id)}`), 200);
            },
          }
        : null,
    more: [
      {
        icon: "copy",
        label: KIND_WORD.duplicate,
        run: () => {
          if (!rec) return;
          void duplicateKind(rec.id)
            .then((copy) => {
              editor.sheet.close();
              showToast(`Made ${copy.name}, with the same fields. Rename it here.`, { icon: "copy" });
              setTimeout(() => openKindEditor(copy, ctx), 260);
            })
            .catch((error) => showToast(error instanceof Error ? error.message : "Couldn't duplicate it", { icon: "wifiOff" }));
        },
      },
    ],
    archive: async () => {
      if (!rec) return;
      const k = rec;
      await setKindArchived(k.id, true);
      const records = k.record_count ? `, with its ${k.record_count} ${k.record_count === 1 ? k.one : k.name.toLowerCase()}` : "";
      showToast(`${k.name} archived${records}`, {
        icon: "archive",
        action: { label: "Undo", run: () => void setKindArchived(k.id, false).catch((e) => showToast(e instanceof Error ? e.message : "Couldn't restore it", { icon: "close" })) },
      });
    },
  });
  editor.sheet.dialog.classList.add("kind-editor");
  // A new kind's singular follows its name until it's typed over.
  editor.title.addEventListener("input", () => {
    if (rec) return;
    oneInput.placeholder = editor.title.value.trim() ? singular(editor.title.value) : "Like wine";
    paintOneHint();
  });
  if (!initial) oneInput.placeholder = "Like wine";
  paintOneHint();
}

/** The section: the kinds, in order, with New and Reorder. */
export function kindsSection(ctx: { go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  let kinds: CustomKind[] = kindsSnapshot();
  let fields: CustomField[] = [];
  let state: ConnectionState = "online";
  let loaded = false;
  let reordering = false;

  const list = h("div", { class: "settings__fields" });
  const el = h(
    "section",
    { class: "settings__section", "aria-labelledby": "settings-kinds" },
    h("h2", { class: "settings__heading", id: "settings-kinds" }, icons.folder(), KIND_WORD.yours),
    h(
      "p",
      { class: "settings__lede" },
      `Make your own kinds of record, like wines, plants or board games. Each one gets fields of its own and its own place in the Library.`
    ),
    list
  );

  async function move(from: number, to: number) {
    if (to < 0 || to >= kinds.length) return;
    const order = [...kinds];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    kinds = order.map((k, i) => ({ ...k, position: i }));
    paint();
    try {
      await reorderKinds(order.map((k) => k.id));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't move it", { icon: "wifiOff" });
      void load();
    }
  }

  function row(k: CustomKind, i: number): HTMLElement {
    const own = liveFields(fields, k.kind);
    const lead = h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[kindIcon(k)]());
    const body = h("span", { class: "row__body" }, h("span", { class: "row__title" }, k.name), h("span", { class: "row__meta" }, kindSummary(k, own)));
    if (reordering) {
      const arrow = (dir: "up" | "down") => {
        const target = dir === "up" ? i - 1 : i + 1;
        const b = h(
          "button",
          { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "data-dir": dir, "aria-label": `Move ${k.name} ${dir}`, disabled: target < 0 || target >= kinds.length },
          dir === "up" ? icons.arrowUp() : icons.arrowDown()
        );
        b.addEventListener("click", () => void move(i, target));
        return b;
      };
      return h("div", { class: "row settings__row", "data-id": k.id }, lead, body, h("span", { class: "settings__move" }, arrow("up"), arrow("down")));
    }
    const b = h(
      "button",
      { class: "row settings__row", type: "button", "data-id": k.id, "aria-label": `${k.name}, ${kindSummary(k, own)}. Edit` },
      lead,
      body,
      h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight())
    );
    b.addEventListener("click", () => openKindEditor(k, ctx));
    return b;
  }

  function paint() {
    if (!loaded) return;
    // A repaint (a move, a reload) keeps the keyboard where it was.
    const active = document.activeElement as HTMLElement | null;
    const focusId = list.contains(active) ? active?.closest<HTMLElement>("[data-id]")?.dataset.id : undefined;
    const focusDir = active?.dataset.dir;
    requestAnimationFrame(() => {
      if (!focusId) return;
      const r = list.querySelector<HTMLElement>(`[data-id="${focusId}"]`);
      (focusDir ? r?.querySelector<HTMLElement>(`[data-dir="${focusDir}"]:not(:disabled)`) : r)?.focus();
    });

    const add = h("button", { class: `btn ${kinds.length ? "btn--soft" : "btn--primary"}`, type: "button" }, icons.plus(), KIND_WORD.new);
    add.addEventListener("click", () => openKindEditor(null, ctx));
    const reorder = h("button", { class: "btn btn--ghost", type: "button", "aria-pressed": String(reordering) }, reordering ? "Done" : "Reorder");
    reorder.addEventListener("click", () => {
      reordering = !reordering;
      paint();
    });
    const notes: HTMLElement[] = [];
    const archivedLink = h("button", { class: "settings__link", type: "button" }, "Open Archived");
    archivedLink.addEventListener("click", () => ctx.go("archived"));
    if (kinds.length) notes.push(h("p", { class: "settings__note" }, icons.archive(), "Archiving one hides it and everything in it until you restore it. ", archivedLink));
    if (state === "offline") notes.push(h("p", { class: "settings__note" }, icons.wifiOff(), `You're offline. Changing your ${KIND_WORD.many} needs a connection.`));

    list.replaceChildren(
      kinds.length
        ? h("div", { class: `card card--flush list${reordering ? " is-reordering" : ""}` }, ...kinds.map((k, i) => row(k, i)))
        : h(
            "div",
            { class: "empty settings__empty" },
            h("span", { class: "tile" }, icons.folder()),
            h("p", { class: "empty__title" }, `No ${KIND_WORD.many} yet`),
            h("p", { class: "empty__sub" }, "Make one for anything you keep track of: wines, plants, recipes, board games. Each gets fields of its own, like a rating or where it's from.")
          ),
      h("div", { class: "settings__actions" }, add, kinds.length > 1 ? reorder : null),
      ...notes
    );
  }

  async function load() {
    const [k, f] = await Promise.all([loadKinds(), loadAllFields()]);
    kinds = k.kinds.filter((x) => !x.archived_at).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
    fields = f.fields;
    state = k.state === "offline" || f.state === "offline" ? "offline" : k.state;
    loaded = true;
    paint();
  }

  list.replaceChildren(
    h("div", { class: "card card--flush list" }, ...[0, 1].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:40%" })), h("span", {}))))
  );
  void load();
  const unsubKinds = onKindsChange(() => void load());
  const unsubFields = onCustomFieldsChange(() => void load());
  return {
    el,
    destroy: () => {
      unsubKinds();
      unsubFields();
    },
  };
}
