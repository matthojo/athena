/**
 * A field for FlowText: you type words, and tap a value in the tray to put
 * its chip where the caret is. Chips are whole: Backspace takes one out.
 * The tray (valueTray) is shared by every field in a sheet and fills the one
 * last focused, and it only offers values from earlier steps.
 */
import { h } from "../lib/dom";
import type { FlowText, ValueRef } from "../../../lib/flow-types";
import { chip, type Lookup } from "./parts";
import { normaliseText } from "./text";
import type { AvailableValue } from "./tree";

export interface TextField {
  el: HTMLElement;
  get: () => FlowText;
  /** Put a value's chip at the caret (or at the end). */
  insert: (r: ValueRef) => void;
  focus: () => void;
}

let fieldSeq = 0;

function chipNode(r: ValueRef, look: Lookup): HTMLElement {
  const v = look(r);
  const c = chip(v, { broken: !v.known });
  c.contentEditable = "false";
  c.dataset.from = r.from;
  c.dataset.key = r.key;
  return c;
}

/** Read a field's nodes back as FlowText. */
function read(box: HTMLElement): FlowText {
  const parts: Array<string | ValueRef> = [];
  const visit = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) parts.push((n.textContent ?? "").replace(/ /g, " "));
    else if (n instanceof HTMLElement) {
      if (n.dataset.from !== undefined && n.dataset.key !== undefined) parts.push({ from: n.dataset.from, key: n.dataset.key });
      else if (n.tagName === "BR") parts.push(" ");
      else n.childNodes.forEach(visit);
    }
  };
  box.childNodes.forEach(visit);
  return normaliseText(parts);
}

export function textField(o: { label: string; value: FlowText; look: Lookup; placeholder?: string; onFocus?: (f: TextField) => void; onInput?: () => void; required?: boolean }): TextField {
  const id = `flow-field-${++fieldSeq}`;
  const box = h("div", {
    class: "flow-field__box",
    id,
    contenteditable: "true",
    role: "textbox",
    "aria-multiline": "false",
    "aria-labelledby": `${id}-label`,
    "data-placeholder": o.placeholder ?? "",
    spellcheck: "true",
  });
  for (const p of o.value) box.append(typeof p === "string" ? document.createTextNode(p) : chipNode(p, o.look));
  let saved: Range | null = null;
  const keep = () => {
    const sel = document.getSelection();
    if (sel?.rangeCount && box.contains(sel.getRangeAt(0).commonAncestorContainer)) saved = sel.getRangeAt(0).cloneRange();
  };
  const paintEmpty = () => box.classList.toggle("is-empty", !box.textContent?.trim() && !box.querySelector("[data-key]"));
  box.addEventListener("keyup", keep);
  box.addEventListener("mouseup", keep);
  box.addEventListener("input", () => {
    keep();
    paintEmpty();
    o.onInput?.();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
  });
  box.addEventListener("paste", (e) => {
    e.preventDefault();
    const t = e.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, t.replace(/\s*\n\s*/g, " "));
  });
  const field: TextField = {
    el: h("div", { class: "flow-field" }, h("span", { class: "flow-field__label", id: `${id}-label` }, o.label, o.required ? null : h("span", { class: "flow-field__optional" }, " (optional)")), box),
    get: () => read(box),
    insert(r) {
      const node = chipNode(r, o.look);
      const space = document.createTextNode(" ");
      if (saved && box.contains(saved.commonAncestorContainer)) {
        saved.deleteContents();
        saved.insertNode(space);
        saved.insertNode(node);
      } else box.append(node, space);
      const sel = document.getSelection();
      const after = document.createRange();
      after.setStartAfter(space);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);
      saved = after.cloneRange();
      paintEmpty();
      o.onInput?.();
    },
    focus: () => box.focus(),
  };
  box.addEventListener("focus", () => o.onFocus?.(field));
  paintEmpty();
  return field;
}

/** The values a step may use, as chips to tap. Fills `target()`. */
export function valueTray(values: readonly AvailableValue[], target: () => TextField | null): HTMLElement {
  if (!values.length) return h("p", { class: "flow-tray__none" }, "No values yet. What the trigger and earlier steps find shows here.");
  const tray = h("div", { class: "flow-tray__chips" });
  for (const v of values) {
    const b = chip(v, { button: true });
    b.setAttribute("aria-label", `Put in ${v.label}`);
    // Keep the field's caret: a tap mustn't take focus first.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => target()?.insert(v.ref));
    tray.append(b);
  }
  return h("div", { class: "flow-tray" }, h("span", { class: "flow-tray__hint" }, "From earlier steps. Tap one to put it in."), tray);
}
