/**
 * Saved actions in the app (lib/saved-actions.ts on the server): the panel
 * on an item's page with its suggested action ("Move to Watch & read"),
 * "More actions" as a sheet, the pickers an action needs (a person, a list,
 * something to link to), and the toast with Undo.
 *
 * Cards use quickAction (hover on a pointer, long-press on touch) and
 * filedLine. The actions and their order come from the server (or the
 * sample's copy of the same rules), so a feature that registers an action
 * shows up here without changes, as long as its params are one of the
 * kinds below.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { showToast } from "./toast";
import { personPicker } from "./person-picker";
import { notesSnapshot } from "../db/data";
import { loadSavedActions, runSavedAction, undoSavedAction, type ActionInfo, type SavedItem } from "../db/saved";
import { thingLine } from "../../../lib/saved-kinds";

const iconOf = (name: string) => (icons as Record<string, () => SVGElement>)[name] ?? icons.sparkle;

/** "Book · Ottessa Moshfegh", or null when there's nothing to say. */
/** In a list, the best price now when the item has checks since it was saved; its own page keeps the saved price. */
export const thingText = (item: SavedItem) => thingLine(item.thing, item.price_now ? { ...(item.facts ?? {}), price: item.price_now.amount, currency: item.price_now.currency, shop: item.price_now.shop ?? item.facts?.shop } : item.facts);

/** Run it, toast with Undo, and tell the caller what changed. */
async function run(item: SavedItem, action: ActionInfo, params: Record<string, unknown>, done: (item: SavedItem) => void): Promise<boolean> {
  try {
    const { item: next, result } = await runSavedAction(item.id, action.id, params);
    done(next);
    const undo = async () => {
      try {
        done(await undoSavedAction(item.id, result.filed ? undefined : result.undo));
        showToast(result.filed ? "Back in Saved" : "Unlinked", { icon: "restore" });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't undo that", { icon: "wifiOff" });
      }
    };
    showToast(result.done, { icon: "check", action: result.undo !== null || result.filed ? { label: "Undo", run: () => void undo() } : undefined });
    return true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Couldn't do that", { icon: "wifiOff", timeoutMs: 4000 });
    return false;
  }
}

/** Does it need the owner to pick something first? Free text has a suggestion, so it doesn't. */
const needsPick = (a: ActionInfo) => a.params.some((p) => p.kind === "person" || p.kind === "list" || p.kind === "target");

/** Run an action, asking for what it needs in a sheet first (or in the one already open). */
export function startAction(item: SavedItem, action: ActionInfo, done: (item: SavedItem) => void, sheet?: SheetHandle): void {
  if (!needsPick(action)) {
    void run(item, action, {}, done).then((ok) => ok && sheet?.close());
    return;
  }
  const body = h("div", { class: "sva-step" });
  const s = sheet ?? openSheet({ label: action.label, title: action.label, body });
  if (sheet) {
    sheet.setTitle(action.label);
    sheet.setBack(() => {
      sheet.setBack(null);
      sheet.setTitle("Do something with it");
      paintList(item, sheet, done);
    });
    swapBody(sheet, body);
  }
  const finish = (params: Record<string, unknown>) => void run(item, action, params, done).then((ok) => ok && s.close());
  const kinds = action.params.map((p) => p.kind);
  // A picker's list drops down over what's below it, so the step keeps room for it.
  if (kinds.includes("person") || kinds.includes("target")) body.classList.add("sva-step--pick");
  if (kinds.includes("person")) body.append(...personStep(item, action, finish));
  else if (kinds.includes("list")) body.append(...listStep(item, finish));
  else body.append(...targetStep(finish));
}

/** The sheet's content area. */
function swapBody(sheet: SheetHandle, body: HTMLElement): void {
  const scroll = sheet.dialog.querySelector(".sheet__scroll");
  scroll?.replaceChildren(body);
}

function lede(item: SavedItem): HTMLElement {
  const what = thingText(item);
  return h("p", { class: "sva-lede" }, h("span", { class: "sva-lede__name" }, item.facts?.name ?? item.title ?? "This item"), what ? h("span", { class: "sva-lede__what" }, what) : null);
}

function personStep(item: SavedItem, action: ActionInfo, finish: (p: Record<string, unknown>) => void): HTMLElement[] {
  const param = action.params.find((p) => p.kind === "person")!;
  const picker = personPicker({
    value: null,
    label: param.label,
    placeholder: "Search people",
    onChange: (person) => person && finish({ [param.name]: person.id }),
  });
  requestAnimationFrame(() => picker.focus());
  const hint = action.id === "gift_idea" ? h("p", { class: "sva-hint" }, "It goes on their Gift ideas list, which starts if they don't have one yet.") : null;
  return [lede(item), h("label", { class: "sva-field" }, h("span", { class: "sva-field__label" }, param.label), picker.el), hint].filter(Boolean) as HTMLElement[];
}

const isChecklist = (body: string) => /^\s*[-*]\s+\[[ xX]\]\s/m.test(body);

function listStep(item: SavedItem, finish: (p: Record<string, unknown>) => void): HTMLElement[] {
  const lists = notesSnapshot()
    .notes.filter((n) => !n.archived_at && isChecklist(n.body))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const search = h("input", { class: "prop__input", type: "search", placeholder: "Find a list, or name a new one", "aria-label": "List", autocomplete: "off", enterkeyhint: "done" }) as HTMLInputElement;
  const rows = h("div", { class: "sva-rows", role: "list" });
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const shown = lists.filter((n) => !q || n.title.toLowerCase().includes(q)).slice(0, 8);
    const items: HTMLElement[] = shown.map((n) => {
      const b = h("button", { class: "sva-row", type: "button", role: "listitem" }, h("span", { class: "sva-row__icon" }, icons.checklist()), h("span", { class: "sva-row__text" }, h("span", { class: "sva-row__label" }, n.title || "Untitled list")));
      b.addEventListener("click", () => finish({ note_id: n.id }));
      return b;
    });
    if (q && !lists.some((n) => n.title.toLowerCase() === q)) {
      const make = h("button", { class: "sva-row", type: "button", role: "listitem" }, h("span", { class: "sva-row__icon" }, icons.plus()), h("span", { class: "sva-row__text" }, h("span", { class: "sva-row__label" }, `New list “${search.value.trim()}”`)));
      make.addEventListener("click", () => finish({ list_title: search.value.trim() }));
      items.push(make);
    }
    rows.replaceChildren(...(items.length ? items : [h("p", { class: "sva-hint" }, "No lists yet. Type a name to start one.")]));
  };
  search.addEventListener("input", paint);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && search.value.trim()) {
      e.preventDefault();
      const hit = lists.find((n) => n.title.toLowerCase() === search.value.trim().toLowerCase());
      finish(hit ? { note_id: hit.id } : { list_title: search.value.trim() });
    }
  });
  paint();
  requestAnimationFrame(() => search.focus());
  return [lede(item), search, rows];
}

function targetStep(finish: (p: Record<string, unknown>) => void): HTMLElement[] {
  const picker = personPicker({ value: null, label: "A person", placeholder: "A person", onChange: (p) => p && finish({ target: { kind: "person", id: p.id } }) });
  const notes = notesSnapshot()
    .notes.filter((n) => !n.archived_at && n.title)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const search = h("input", { class: "prop__input", type: "search", placeholder: "A note", "aria-label": "A note", autocomplete: "off" }) as HTMLInputElement;
  const rows = h("div", { class: "sva-rows", role: "list" });
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    rows.replaceChildren(
      ...notes
        .filter((n) => !q || n.title.toLowerCase().includes(q))
        .slice(0, 5)
        .map((n) => {
          const b = h("button", { class: "sva-row", type: "button", role: "listitem" }, h("span", { class: "sva-row__icon" }, icons.note()), h("span", { class: "sva-row__text" }, h("span", { class: "sva-row__label" }, n.title)));
          b.addEventListener("click", () => finish({ target: { kind: "note", id: n.id } }));
          return b;
        })
    );
  };
  search.addEventListener("input", paint);
  paint();
  return [h("label", { class: "sva-field" }, h("span", { class: "sva-field__label" }, "A person"), picker.el), h("label", { class: "sva-field" }, h("span", { class: "sva-field__label" }, "Or a note"), search), rows];
}

function actionRow(a: ActionInfo, onPick: () => void): HTMLElement {
  const b = h(
    "button",
    { class: `sva-row${a.suggested ? " is-suggested" : ""}`, type: "button", role: "listitem" },
    h("span", { class: "sva-row__icon" }, iconOf(a.icon)()),
    h("span", { class: "sva-row__text" }, h("span", { class: "sva-row__label" }, a.label), a.suggested ? h("span", { class: "sva-row__sub" }, "Suggested") : null),
    needsPick(a) ? icons.chevronRight() : null
  );
  b.addEventListener("click", onPick);
  return b;
}

function paintList(item: SavedItem, sheet: SheetHandle, done: (item: SavedItem) => void, known?: ActionInfo[]): void {
  const body = h("div", { class: "sva-step" }, lede(item));
  const rows = h("div", { class: "sva-rows", role: "list", "aria-busy": known ? "false" : "true" });
  body.append(rows);
  swapBody(sheet, body);
  const fill = (actions: ActionInfo[]) => {
    rows.removeAttribute("aria-busy");
    rows.replaceChildren(...(actions.length ? actions.map((a) => actionRow(a, () => startAction(item, a, done, sheet))) : [h("p", { class: "sva-hint" }, "Nothing fits this one.")]));
  };
  if (known) fill(known);
  else
    void loadSavedActions(item.id).then(
      (r) => fill(r.actions),
      () => rows.replaceChildren(h("p", { class: "sva-hint" }, "Actions can't load right now."))
    );
}

/** "More actions": every action that fits, suggested first. */
export function openSavedActions(item: SavedItem, done: (item: SavedItem) => void, known?: ActionInfo[]): SheetHandle {
  const sheet = openSheet({ label: "Do something with it", title: "Do something with it", body: h("div", {}) });
  paintList(item, sheet, done, known);
  return sheet;
}

/** "Filed in Rowan · Gift ideas", the place a link when there's one. */
export function filedLine(item: SavedItem, opts: { put?: boolean; done?: (item: SavedItem) => void } = {}): HTMLElement | null {
  const f = item.filed;
  if (!f) return null;
  const where = f.href ? h("a", { class: "sva-filed__where", href: f.href }, f.label) : h("span", { class: "sva-filed__where" }, f.label);
  where.addEventListener("click", (e) => e.stopPropagation());
  const line = h("span", { class: "sva-filed" }, icons.check(), h("span", { class: "sva-filed__text" }, "Filed in ", where));
  if (opts.put) {
    const back = h("button", { class: "btn btn--soft btn--sm sva-filed__back", type: "button" }, icons.restore(), "Put back");
    back.addEventListener("click", async () => {
      try {
        const next = await undoSavedAction(item.id);
        opts.done?.(next);
        showToast("Back in Saved", { icon: "restore" });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't put it back", { icon: "wifiOff" });
      }
    });
    line.append(back);
  }
  return line;
}

/**
 * The item page's panel: the suggested action (tap to run, or to pick who
 * or which list) and More actions; or, once filed, where it went and Put back.
 */
export function savedActionsPanel(item: SavedItem, onChange: (item: SavedItem) => void): HTMLElement {
  const el = h("section", { class: "sva-panel", "aria-label": "Actions" });
  const paint = (it: SavedItem, actions: ActionInfo[], links: Array<{ kind: string; id: string; title: string }>) => {
    const linked = links.length
      ? h(
          "p",
          { class: "sva-links" },
          icons.link(),
          "Linked to ",
          ...links.flatMap((l, i) => [i ? ", " : "", l.kind === "project" ? h("span", {}, l.title) : h("a", { href: l.kind === "person" ? `#/people/${l.id}` : `#/notes/${l.id}` }, l.title)])
        )
      : null;
    const more = h("button", { class: "btn btn--ghost btn--sm sva-more", type: "button" }, icons.more(), "More actions");
    more.addEventListener("click", () => openSavedActions(it, onChange, actions));
    if (it.filed) {
      el.classList.add("is-filed");
      el.replaceChildren(filedLine(it, { put: true, done: onChange })!, linked ?? "");
      return;
    }
    el.classList.remove("is-filed");
    const best = actions.find((a) => a.suggested);
    if (!best) {
      el.replaceChildren(h("div", { class: "sva-panel__row" }, more), linked ?? "");
      return;
    }
    const what = thingText(it);
    const go = h(
      "button",
      { class: "sva-suggest", type: "button" },
      h("span", { class: "sva-suggest__icon" }, iconOf(best.icon)()),
      h("span", { class: "sva-suggest__text" }, h("span", { class: "sva-suggest__label" }, best.label), what ? h("span", { class: "sva-suggest__what" }, what) : null),
      icons.chevronRight()
    );
    go.addEventListener("click", () => startAction(it, best, onChange));
    el.replaceChildren(go, h("div", { class: "sva-panel__row" }, more), linked ?? "");
  };
  el.setAttribute("aria-busy", "true");
  void loadSavedActions(item.id).then(
    (r) => {
      el.removeAttribute("aria-busy");
      paint(item, r.actions, r.links);
    },
    () => el.remove()
  );
  return el;
}

/**
 * A card's quick action: a round button on hover (a pointer) for the
 * suggested action, and a long-press (touch) for all of them. `wrap` holds
 * the card; the button sits beside it, not inside the card's own button.
 */
export function quickAction(item: SavedItem, card: HTMLElement, onChange: (item: SavedItem) => void): HTMLElement {
  const wrap = h("div", { class: "sva-wrap" }, card);
  if (item.archived) return wrap;
  let actions: ActionInfo[] | null = null;
  const load = () => (actions ? Promise.resolve(actions) : loadSavedActions(item.id).then((r) => (actions = r.actions)));
  const btn = h("button", { class: "sva-quick", type: "button", "aria-label": "Actions", tabindex: "-1" }, icons.more());
  // The suggested action's icon, once known (on first hover).
  wrap.addEventListener(
    "pointerenter",
    () =>
      void load().then((a) => {
        const best = a.find((x) => x.suggested);
        if (!best) return;
        btn.replaceChildren(iconOf(best.icon)());
        btn.setAttribute("aria-label", best.label);
        btn.title = best.label;
      }),
    { once: true }
  );
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const a = await load().catch(() => null);
    const best = a?.find((x) => x.suggested);
    if (best) startAction(item, best, onChange);
    else if (a) openSavedActions(item, onChange, a);
  });
  // Touch: hold for every action. A held press doesn't also open the item.
  let timer: number | undefined;
  let held = false;
  card.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    held = false;
    timer = window.setTimeout(() => {
      held = true;
      navigator.vibrate?.(8);
      void load().then((a) => openSavedActions(item, onChange, a), () => openSavedActions(item, onChange));
    }, 480);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave", "pointermove"] as const)
    card.addEventListener(ev, (e) => {
      if (ev === "pointermove" && Math.hypot((e as PointerEvent).movementX, (e as PointerEvent).movementY) < 6) return;
      clearTimeout(timer);
    });
  card.addEventListener(
    "click",
    (e) => {
      if (held) {
        e.preventDefault();
        e.stopImmediatePropagation();
        held = false;
      }
    },
    { capture: true }
  );
  card.addEventListener("contextmenu", (e) => {
    if (held || (e as PointerEvent).pointerType === "touch") e.preventDefault();
  });
  wrap.append(btn);
  return wrap;
}

