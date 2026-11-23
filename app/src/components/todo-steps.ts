/**
 * A to-do's steps: a checklist that writes like a list in a notebook.
 *
 * - Tick a step with its circle; its words soften and strike through.
 * - Enter in a step starts the next one below it (splitting the words at the
 *   caret); Backspace at the start of an empty step removes it; the arrow
 *   keys move between steps at their first and last lines.
 * - "Add a step" at the foot keeps the caret there, so a list goes in with
 *   one Enter after another. Pasting several lines adds a step for each.
 * - Drag a step by its handle (mouse or finger) to reorder, or Alt+↑/↓.
 *
 * Every change hands the whole list to `onChange`; words are saved once
 * you leave a step (or pause typing), ticks, adds, removals and moves at once.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { prefersReducedMotion } from "../lib/motion";
import { showToast } from "./toast";
import { MAX_STEPS, newItemId, pastedSteps, STEP_LENGTH, stepProgress, type TodoStep } from "../../../lib/todo-details";

export interface StepsEditor {
  el: HTMLElement;
  set: (steps: TodoStep[]) => void;
  steps: () => TodoStep[];
  focusAdd: () => void;
}

const autoGrow = (t: HTMLTextAreaElement) => {
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight}px`;
};

export function stepsEditor(opts: { steps: TodoStep[]; onChange: (steps: TodoStep[]) => void; readOnly?: boolean }): StepsEditor {
  let steps: TodoStep[] = opts.steps.map((s) => ({ ...s }));
  let textTimer: number | undefined;

  const count = h("span", { class: "tsec__count" });
  const bar = h("span", { class: "tsteps__bar", "aria-hidden": "true" }, h("span", { class: "tsteps__fill" }));
  const list = h("ol", { class: "tsteps", "aria-label": "Steps" });
  const addInput = h("textarea", { class: "tstep__text tsteps__add-input", rows: 1, maxlength: STEP_LENGTH, placeholder: "Add a step", "aria-label": "Add a step", enterkeyhint: "enter" }) as HTMLTextAreaElement;
  const add = h("div", { class: "tsteps__add" }, h("span", { class: "tsteps__add-mark", "aria-hidden": "true" }, icons.plus()), addInput);
  const el = h("section", { class: "tsec tsec--steps", "aria-label": "Steps" }, h("h3", { class: "tsec__head" }, icons.checklist(), h("span", { class: "tsec__label" }, "Steps"), count, bar), list, opts.readOnly ? null : add);

  const commit = () => {
    clearTimeout(textTimer);
    textTimer = undefined;
    paintCount();
    opts.onChange(steps.map((s) => ({ ...s })));
  };
  const commitSoon = () => {
    clearTimeout(textTimer);
    textTimer = window.setTimeout(commit, 900);
  };

  function paintCount() {
    const p = stepProgress(steps);
    count.textContent = p.total ? `${p.done} of ${p.total}` : "";
    bar.hidden = !p.total;
    (bar.firstElementChild as HTMLElement).style.transform = `scaleX(${p.total ? p.done / p.total : 0})`;
    el.dataset.complete = String(p.total > 0 && p.done === p.total);
    add.hidden = steps.length >= MAX_STEPS;
  }

  const rowOf = (id: string) => list.querySelector<HTMLElement>(`.tstep[data-id="${CSS.escape(id)}"]`);
  const textOf = (id: string) => rowOf(id)?.querySelector<HTMLTextAreaElement>(".tstep__text") ?? null;
  const focusStep = (id: string, at: "start" | "end" | number = "end") => {
    const t = textOf(id);
    if (!t) return;
    t.focus({ preventScroll: false });
    const pos = at === "start" ? 0 : at === "end" ? t.value.length : at;
    t.setSelectionRange(pos, pos);
  };

  function row(step: TodoStep): HTMLElement {
    const check = h(
      "button",
      { class: "tstep__check", type: "button", role: "checkbox", "aria-checked": String(step.done), "aria-label": step.done ? `Untick “${step.text}”` : `Tick “${step.text}”`, disabled: opts.readOnly || undefined },
      h("span", { class: "tstep__ring", "aria-hidden": "true" }, icons.check())
    );
    const text = h("textarea", { class: "tstep__text", rows: 1, maxlength: STEP_LENGTH, "aria-label": "Step", enterkeyhint: "enter", readonly: opts.readOnly || undefined }) as HTMLTextAreaElement;
    text.value = step.text;
    const grip = h("button", { class: "tstep__grip", type: "button", "aria-label": `Move “${step.text}”. Alt and the arrow keys move it too`, tabindex: -1 }, icons.grip());
    const remove = h("button", { class: "tstep__remove", type: "button", "aria-label": `Remove “${step.text}”` }, icons.close());
    const li = h("li", { class: "tstep", "data-id": step.id, "data-done": String(step.done) }, opts.readOnly ? null : grip, check, text, opts.readOnly ? null : remove);

    check.addEventListener("click", () => {
      const s = steps.find((x) => x.id === step.id);
      if (!s) return;
      s.done = !s.done;
      li.dataset.done = String(s.done);
      check.setAttribute("aria-checked", String(s.done));
      check.setAttribute("aria-label", s.done ? `Untick “${s.text}”` : `Tick “${s.text}”`);
      if (s.done && !prefersReducedMotion()) {
        li.classList.remove("is-ticked");
        void li.offsetWidth;
        li.classList.add("is-ticked");
      }
      commit();
    });
    text.addEventListener("input", () => {
      autoGrow(text);
      const s = steps.find((x) => x.id === step.id);
      if (s) s.text = text.value.replace(/\s+/g, " ").slice(0, STEP_LENGTH);
      commitSoon();
    });
    text.addEventListener("blur", () => {
      const s = steps.find((x) => x.id === step.id);
      if (!s) return;
      if (!text.value.trim()) {
        // Left empty: it goes (unless it's being moved).
        if (li.classList.contains("is-dragging")) return;
        steps = steps.filter((x) => x.id !== step.id);
        li.remove();
        commit();
        return;
      }
      if (textTimer !== undefined) commit();
    });
    text.addEventListener("keydown", (e) => onKey(e, step.id, text));
    text.addEventListener("paste", (e) => {
      const lines = pastedSteps(e.clipboardData?.getData("text/plain") ?? "");
      if (lines.length < 2) return;
      e.preventDefault();
      const at = steps.findIndex((x) => x.id === step.id);
      const fresh = lines.slice(0, MAX_STEPS - steps.length).map((t) => ({ id: newItemId(), text: t.slice(0, STEP_LENGTH), done: false }));
      steps.splice(at + 1, 0, ...fresh);
      paint();
      commit();
      if (fresh.length) focusStep(fresh[fresh.length - 1].id);
    });
    remove.addEventListener("click", () => {
      const at = steps.findIndex((x) => x.id === step.id);
      const stepNow = steps[at] ? { ...steps[at] } : null;
      steps = steps.filter((x) => x.id !== step.id);
      li.classList.add("is-leaving");
      const gone = () => {
        li.remove();
        paintCount();
      };
      if (prefersReducedMotion()) gone();
      else li.addEventListener("animationend", gone, { once: true });
      commit();
      const next = steps[at] ?? steps[at - 1];
      if (next) focusStep(next.id);
      else addInput.focus();
      const removed = stepNow ?? { ...step };
      showToast(`Removed “${removed.text}”`, {
        icon: "trash",
        action: {
          label: "Undo",
          run: () => {
            if (steps.some((x) => x.id === removed.id) || steps.length >= MAX_STEPS) return;
            steps.splice(Math.min(at, steps.length), 0, removed);
            paint();
            commit();
          },
        },
      });
    });
    grip.addEventListener("pointerdown", (e) => startDrag(e, li));
    requestAnimationFrame(() => autoGrow(text));
    return li;
  }

  function onKey(e: KeyboardEvent, id: string, text: HTMLTextAreaElement) {
    const at = steps.findIndex((x) => x.id === id);
    const caretStart = text.selectionStart === 0 && text.selectionEnd === 0;
    const caretEnd = text.selectionStart === text.value.length;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (steps.length >= MAX_STEPS) return;
      const before = text.value.slice(0, text.selectionStart).trimEnd();
      const after = text.value.slice(text.selectionEnd).trim();
      if (!before && !after) {
        addInput.focus();
        return;
      }
      text.value = before;
      steps[at].text = before;
      const fresh: TodoStep = { id: newItemId(), text: after, done: false };
      steps.splice(at + 1, 0, fresh);
      rowOf(id)!.after(row(fresh));
      autoGrow(text);
      commit();
      focusStep(fresh.id, "start");
      return;
    }
    if (e.key === "Backspace" && caretStart && !text.value) {
      e.preventDefault();
      steps.splice(at, 1);
      rowOf(id)?.remove();
      commit();
      const prev = steps[at - 1];
      if (prev) focusStep(prev.id, "end");
      else if (steps[0]) focusStep(steps[0].id, "start");
      else addInput.focus();
      return;
    }
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const to = at + (e.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= steps.length) return;
      const [moved] = steps.splice(at, 1);
      steps.splice(to, 0, moved);
      paint();
      commit();
      focusStep(id, text.selectionStart);
      return;
    }
    if (e.key === "ArrowUp" && caretStart && at > 0) {
      e.preventDefault();
      focusStep(steps[at - 1].id, "end");
    } else if (e.key === "ArrowDown" && caretEnd) {
      e.preventDefault();
      if (steps[at + 1]) focusStep(steps[at + 1].id, "start");
      else addInput.focus();
    }
  }

  // ---------- adding ----------

  function addSteps(words: string[]) {
    const room = MAX_STEPS - steps.length;
    const fresh = words.slice(0, room).map((t) => ({ id: newItemId(), text: t.replace(/\s+/g, " ").trim().slice(0, STEP_LENGTH), done: false })).filter((s) => s.text);
    if (!fresh.length) return;
    steps.push(...fresh);
    for (const s of fresh) {
      const li = row(s);
      if (!prefersReducedMotion()) li.classList.add("is-new");
      list.append(li);
    }
    commit();
  }
  addInput.addEventListener("input", () => autoGrow(addInput));
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const v = addInput.value.trim();
      if (!v) return;
      addInput.value = "";
      autoGrow(addInput);
      addSteps([v]);
    } else if (e.key === "ArrowUp" && addInput.selectionStart === 0 && steps.length) {
      e.preventDefault();
      focusStep(steps[steps.length - 1].id, "end");
    } else if (e.key === "Escape" && addInput.value) {
      e.stopPropagation();
      addInput.value = "";
      autoGrow(addInput);
    }
  });
  addInput.addEventListener("paste", (e) => {
    const lines = pastedSteps(e.clipboardData?.getData("text/plain") ?? "");
    if (lines.length < 2) return;
    e.preventDefault();
    addSteps(lines);
  });
  // A step typed but not entered still counts when you leave.
  addInput.addEventListener("blur", () => {
    const v = addInput.value.trim();
    if (!v) return;
    addInput.value = "";
    autoGrow(addInput);
    addSteps([v]);
  });

  // ---------- dragging ----------

  function startDrag(e: PointerEvent, li: HTMLElement) {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const rows = () => [...list.querySelectorAll<HTMLElement>(".tstep")];
    const height = li.getBoundingClientRect().height;
    let offset = 0;
    li.classList.add("is-dragging");
    list.classList.add("is-sorting");
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY - offset;
      li.style.transform = `translateY(${dy}px)`;
      // Past half a neighbour's height, swap with it; the dragged row stays under the finger.
      const all = rows();
      const at = all.indexOf(li);
      const prev = all[at - 1];
      const next = all[at + 1];
      if (next && dy > next.getBoundingClientRect().height / 2) {
        next.after(li);
        offset += next.getBoundingClientRect().height;
        nudge(next, height);
      } else if (prev && dy < -prev.getBoundingClientRect().height / 2) {
        prev.before(li);
        offset -= prev.getBoundingClientRect().height;
        nudge(prev, -height);
      }
      li.style.transform = `translateY(${ev.clientY - startY - offset}px)`;
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      li.classList.remove("is-dragging");
      list.classList.remove("is-sorting");
      li.style.transform = "";
      const order = rows().map((r) => r.dataset.id!);
      const before = steps.map((s) => s.id).join();
      steps.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      if (steps.map((s) => s.id).join() !== before) commit();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  /** A swapped neighbour slides into its new place rather than jumping. */
  function nudge(row: HTMLElement, by: number) {
    if (prefersReducedMotion()) return;
    row.animate([{ transform: `translateY(${by}px)` }, { transform: "translateY(0)" }], { duration: 160, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
  }

  function paint() {
    list.replaceChildren(...steps.map(row));
    paintCount();
  }
  paint();

  return {
    el,
    set(next) {
      // Don't repaint under someone typing in a step.
      if (list.contains(document.activeElement)) return;
      steps = next.map((s) => ({ ...s }));
      paint();
    },
    steps: () => steps.map((s) => ({ ...s })),
    focusAdd: () => addInput.focus(),
  };
}
