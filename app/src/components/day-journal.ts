/**
 * The owner's own words on a day: the journal (a page that saves as you
 * type, a second after you stop, and when you leave) and the day's line
 * (tap to change it). "Saving…" and "Saved" are the only feedback; a failed
 * save keeps the words and says so, and tries again on the next change or
 * when the connection comes back.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";

type Save = (text: string) => Promise<void>;

function saver(save: Save, status: HTMLElement, wait = 900) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  let queued: string | null = null;
  let inFlight = false;
  const say = (s: string, state: "idle" | "saving" | "saved" | "failed") => {
    status.textContent = s;
    status.dataset.state = state;
  };
  async function run(text: string) {
    if (inFlight) {
      queued = text;
      return;
    }
    if (text === last) return;
    inFlight = true;
    say("Saving…", "saving");
    try {
      await save(text);
      last = text;
      say("Saved", "saved");
    } catch {
      say(navigator.onLine ? "Not saved yet. Athena will try again" : "Offline. Saves when you're back", "failed");
      const retry = () => void run(text);
      window.addEventListener("online", retry, { once: true });
    } finally {
      inFlight = false;
      if (queued !== null) {
        const q = queued;
        queued = null;
        void run(q);
      }
    }
  }
  return {
    prime: (text: string) => (last = text),
    /** These words are saved and nothing newer is waiting. */
    isSaved: (text: string) => !inFlight && queued === null && text === last,
    change(text: string) {
      clearTimeout(timer);
      say("", "idle");
      timer = setTimeout(() => void run(text), wait);
    },
    flush(text: string) {
      clearTimeout(timer);
      void run(text);
    },
  };
}

export interface JournalOptions {
  value: string;
  placeholder: string;
  label: string;
  save: Save;
  /** One line rather than a page: fewer rows, a length cap, and Enter keeps it. */
  line?: { maxLength: number };
  /** Told the owner's words once they leave the box (or press Enter on a line) and the save lands: the "Kept" toast. */
  onKept?: (text: string) => void;
}

export function journalEditor(opts: JournalOptions): { el: HTMLElement; flush: () => void; focus: () => void } {
  const area = h("textarea", {
    class: `journal__text${opts.line ? " journal__text--line" : ""}`,
    rows: opts.line ? 1 : 3,
    placeholder: opts.placeholder,
    "aria-label": opts.label,
    spellcheck: "true",
    ...(opts.line ? { maxlength: String(opts.line.maxLength), enterkeyhint: "done" } : {}),
  }) as HTMLTextAreaElement;
  area.value = opts.value;
  const status = h("span", { class: "journal__status", role: "status", "aria-live": "polite" });
  // Leaving the box says "Kept" once per change of words, after the save lands.
  let keptText = opts.value.trim();
  let leaving = false;
  const kept = (text: string) => {
    if (!opts.onKept || !leaving || !text.trim() || text.trim() === keptText) return;
    keptText = text.trim();
    opts.onKept(keptText);
  };
  const save: Save = async (text) => {
    await opts.save(text);
    kept(text);
  };
  const s = saver(save, status);
  s.prime(opts.value);
  const grow = () => {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  };
  area.addEventListener("input", () => {
    grow();
    s.change(area.value);
  });
  area.addEventListener("blur", () => {
    leaving = true;
    // Saved already while typing: say so now; otherwise once this save lands.
    if (s.isSaved(area.value)) kept(area.value);
    else s.flush(area.value);
  });
  area.addEventListener("focus", () => (leaving = false));
  if (opts.line) {
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        area.blur();
      }
    });
  }
  requestAnimationFrame(grow);
  const el = h("div", { class: "journal" }, area, h("div", { class: "journal__foot" }, status));
  return { el, flush: () => s.flush(area.value), focus: () => area.focus() };
}

/**
 * The day's line, editable in place: a button showing the line (or a
 * suggestion), which turns into a field on tap. Enter or leaving saves; Esc
 * puts it back.
 */
export function lineEditor(opts: { value: string | null; fallback: string | null; save: (line: string) => Promise<void> }): HTMLElement {
  let value = opts.value;
  const wrap = h("div", { class: "day-line" });
  function show() {
    const text = value || opts.fallback;
    const b = h(
      "button",
      { class: `day-line__show${value ? "" : " is-suggested"}`, type: "button", "aria-label": text ? `The day's line: ${text}. Change it` : "Add a line for the day" },
      h("span", { class: "day-line__text" }, text ?? "Add a line for the day"),
      h("span", { class: "day-line__pen", "aria-hidden": "true" }, icons.pen())
    );
    b.addEventListener("click", edit);
    wrap.replaceChildren(b);
  }
  function edit() {
    const input = h("textarea", { class: "day-line__input", rows: 1, maxlength: "140", "aria-label": "The day's line. Enter saves, Escape cancels", placeholder: opts.fallback ?? "Sum up the day in a line" }) as HTMLTextAreaElement;
    input.value = value ?? "";
    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight + 2}px`;
    };
    input.addEventListener("input", grow);
    requestAnimationFrame(grow);
    let done = false;
    const finish = async (keep: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (keep && next !== (value ?? "")) {
        const before = value;
        value = next || null;
        show();
        try {
          await opts.save(next);
        } catch {
          value = before;
          show();
          wrap.append(h("p", { class: "day-line__error", role: "alert" }, "That didn't save. Check you're online and try again."));
        }
      } else show();
      (wrap.querySelector("button") as HTMLElement | null)?.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => void finish(true));
    wrap.replaceChildren(input);
    input.focus();
    input.select();
  }
  show();
  return wrap;
}
