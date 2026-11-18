/**
 * The sheet life admin, reading and goals edit in: a big title, compact
 * field rows, then a foot. A new item is created by its primary button (or
 * Return in the title); an existing one saves each field as it changes, with
 * Archive and Delete permanently in the overflow menu — the same shape as an
 * open loop's sheet.
 */

import { placeMenuAcross } from "../lib/menu-place";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";

let editorSeq = 0;

export interface EditorSheet {
  sheet: SheetHandle;
  title: HTMLTextAreaElement;
  /** Repaint the foot (status line, primary action) after a save. */
  refresh: () => void;
}

export function openEditorSheet(opts: {
  /** "New item", "New goal" … */
  newLabel: string;
  isNew: boolean;
  titleValue: string;
  placeholder: string;
  /** Leading mark beside the title (a tile with the kind's icon). */
  mark?: HTMLElement;
  sections: HTMLElement[];
  /** Existing item: a title edit. */
  onTitle?: (value: string) => void;
  /** New item: create it from the fields; resolve true to close the sheet. */
  create?: () => Promise<boolean>;
  createLabel?: string;
  /** Existing item: the foot's status line and optional action button. */
  status?: () => string;
  action?: () => { icon: IconName; label: string; run: () => void } | null;
  /** Existing item: more actions for the overflow menu, before Archive (Duplicate). */
  more?: Array<{ icon: IconName; label: string; run: () => void }>;
  archive?: () => Promise<void>;
  remove?: { what: string; run: () => Promise<void> };
}): EditorSheet {
  const uid = `editor-${++editorSeq}`;
  const title = h("textarea", { class: "note__title-input loop-sheet__title", name: "title", rows: 1, maxlength: 300, placeholder: opts.placeholder, "aria-label": "Title" }) as HTMLTextAreaElement;
  title.value = opts.titleValue;
  const grow = () => {
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
  };

  const createBtn = h("button", { class: "btn btn--primary", type: "button", disabled: !title.value.trim() }, icons.plus(), opts.createLabel ?? "Add") as HTMLButtonElement;
  let isNew = opts.isNew;

  async function create() {
    if (!isNew || !opts.create || !title.value.trim()) return;
    createBtn.disabled = true;
    try {
      if (await opts.create()) sheet.close();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't add it", { icon: "wifiOff", timeoutMs: 4000 });
    }
    createBtn.disabled = !title.value.trim();
  }
  createBtn.addEventListener("click", () => void create());

  title.addEventListener("input", () => {
    grow();
    createBtn.disabled = !title.value.trim();
  });
  title.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (isNew) void create();
    else title.blur();
  });
  title.addEventListener("change", () => {
    if (isNew) return;
    const v = title.value.trim();
    if (!v) {
      title.value = opts.titleValue;
      return;
    }
    opts.onTitle?.(v);
  });

  // ---------- menu ----------
  const menuId = `${uid}-menu`;
  const moreBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "More actions", popovertarget: menuId }, icons.more()) as HTMLButtonElement;
  const menu = h("div", { class: "menu note-menu", id: menuId, popover: "auto" }) as HTMLElement & { hidePopover?: () => void };
  const menuItem = (icon: IconName, label: string, run: () => void, cls = "") => {
    const b = h("button", { class: `menu__item ${cls}`, type: "button" }, icons[icon](), label);
    b.addEventListener("click", () => {
      menu.hidePopover?.();
      run();
    });
    return b;
  };
  const items: HTMLElement[] = (opts.more ?? []).map((m) => menuItem(m.icon, m.label, m.run));
  if (opts.archive) {
    const archive = opts.archive;
    items.push(
      menuItem("archive", "Archive", () =>
        void archive()
          .then(() => sheet.close())
          .catch((error) => showToast(error instanceof Error ? error.message : "Couldn't archive", { icon: "wifiOff" }))
      )
    );
  }
  if (opts.remove) {
    const { what, run } = opts.remove;
    if (items.length) items.push(h("div", { class: "menu__sep" }));
    items.push(
      menuItem(
        "trash",
        "Delete permanently",
        () =>
          void confirmDialog({ title: "Delete this permanently?", body: `${what} is removed from Athena everywhere. This can't be undone.`, confirmLabel: "Delete permanently", danger: true }).then(async (ok) => {
            if (!ok) return;
            try {
              await run();
              sheet.close();
              showToast("Deleted permanently", { icon: "trash" });
            } catch (error) {
              showToast(error instanceof Error ? error.message : "Couldn't delete", { icon: "wifiOff" });
            }
          }),
        "menu__item--danger"
      )
    );
  }
  menu.replaceChildren(...items);
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const r = moreBtn.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 160)}px`;
    placeMenuAcross(menu, moreBtn);
  });

  const foot = h("div", { class: "loop-sheet__foot" });
  function refresh() {
    moreBtn.hidden = isNew || !items.length;
    if (isNew) {
      foot.replaceChildren(h("span", { class: "loop-sheet__hint" }, "Return to add"), createBtn);
      return;
    }
    const action = opts.action?.();
    let btn: HTMLElement | null = null;
    if (action) {
      btn = h("button", { class: "btn btn--soft", type: "button" }, icons[action.icon](), action.label);
      btn.addEventListener("click", action.run);
    }
    foot.replaceChildren(h("span", { class: "loop-sheet__hint" }, opts.status?.() ?? ""), btn ?? h("span", {}));
  }

  const body = h(
    "div",
    { class: "loop-sheet" },
    h("div", { class: "loop-sheet__top" }, opts.mark ?? h("span", {}), h("span", { class: "note__bar-spacer" }), moreBtn, menu),
    title,
    ...opts.sections,
    foot
  );
  const sheet = openSheet({ label: isNew ? opts.newLabel : opts.titleValue, title: isNew ? opts.newLabel : undefined, body });
  refresh();
  requestAnimationFrame(() => {
    grow();
    if (isNew) title.focus();
  });
  sheet.dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && isNew) {
      e.preventDefault();
      void create();
    }
  });

  return {
    sheet,
    title,
    refresh: () => {
      isNew = false;
      refresh();
    },
  };
}
