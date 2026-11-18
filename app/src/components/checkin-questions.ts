/**
 * The four kinds of check-in question, each as a control the flow puts on
 * its own screen: a scale (components/scale-slider.ts), words in two
 * columns with "Show more", life areas as icon tiles in three columns with
 * "Show all", and a written answer with "Go deeper" (one follow-up from
 * Athena, answered or skipped). Each gives back its value, or null when
 * nothing was chosen or written.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { scaleSlider } from "./scale-slider";
import type { CheckinAnswer, CheckinQuestion, CheckinValue } from "../../../lib/checkin-types";
import { MAX_ANSWER_CHARS } from "../../../lib/checkin-types";

export interface QuestionControl {
  el: HTMLElement;
  /** What to save; null when nothing was chosen or written. */
  value: () => CheckinValue | null;
  focus: () => void;
}

/** Life areas' icons. An area of the owner's own gets a tag. */
const AREA_ICON: Record<string, IconName> = {
  Work: "briefcase",
  "Self-care": "sparkle",
  Learning: "book",
  Nature: "leaf",
  Health: "heart",
  Family: "people",
  Friends: "chat",
  Fitness: "flame",
  Creativity: "pen",
  Rest: "cup",
  Home: "home",
  Money: "wallet",
  Partner: "person",
  Travel: "plane",
  Music: "music",
  Spirituality: "circle",
  Food: "pot",
  Sleep: "bed",
  Community: "team",
  Hobbies: "game",
};

export const areaIcon = (name: string): IconName => AREA_ICON[name] ?? "tag";

export function questionControl(q: CheckinQuestion, a: CheckinAnswer | undefined, opts: { labelledBy: string; deeper?: (text: string) => Promise<string | null> }): QuestionControl {
  const v = a?.value;
  if (q.type === "scale") {
    const s = scaleSlider(q, { value: v && "scale" in v ? v.scale : undefined, labelledBy: opts.labelledBy });
    return { el: s.el, value: () => ({ scale: s.value() }), focus: s.focus };
  }
  if (q.type === "choices" || q.type === "areas") return picker(q, v && "picks" in v ? v.picks : [], opts.labelledBy);
  return written(q, v && "text" in v ? v : undefined, opts);
}

function picker(q: CheckinQuestion, chosen: string[], labelledBy: string): QuestionControl {
  const picks = new Set(chosen);
  const areas = q.type === "areas";
  const first = q.options ?? [];
  const more = (q.more ?? []).filter((x) => !first.includes(x));
  // Anything chosen from behind "Show more" shows from the start.
  let open = more.some((x) => picks.has(x));

  const button = (word: string) => {
    const b = h(
      "button",
      { class: areas ? "checkin-area" : "checkin-word", type: "button", "aria-pressed": String(picks.has(word)) },
      ...(areas ? [h("span", { class: "checkin-area__icon", "aria-hidden": "true" }, icons[areaIcon(word)]())] : []),
      h("span", { class: areas ? "checkin-area__name" : "checkin-word__name" }, word)
    );
    b.addEventListener("click", () => {
      if (picks.has(word)) picks.delete(word);
      else picks.add(word);
      b.setAttribute("aria-pressed", String(picks.has(word)));
    });
    return b;
  };
  const grid = h("div", { class: areas ? "checkin-areas" : "checkin-words", role: "group", "aria-labelledby": labelledBy });
  const toggle = h("button", { class: "btn btn--ghost btn--sm checkin-more", type: "button" });
  const paint = () => {
    grid.replaceChildren(...[...first, ...(open ? more : [])].map(button));
    toggle.hidden = !more.length;
    toggle.replaceChildren(open ? "Show fewer" : areas ? "Show all" : "Show more", open ? icons.arrowUp() : icons.chevronDown());
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => {
    open = !open;
    paint();
  });
  paint();
  return {
    el: h("div", { class: "checkin-pick" }, grid, toggle),
    value: () => {
      // In the order they're shown, not the order they were tapped.
      const all = [...first, ...more];
      const out = all.filter((x) => picks.has(x));
      return out.length ? { picks: out } : null;
    },
    focus: () => grid.querySelector<HTMLElement>("button")?.focus(),
  };
}

function written(q: CheckinQuestion, was: { text: string; deeper?: { question: string; text?: string } } | undefined, opts: { labelledBy: string; deeper?: (text: string) => Promise<string | null> }): QuestionControl {
  const box = h("textarea", { class: "field checkin-text", rows: 6, maxlength: MAX_ANSWER_CHARS, placeholder: q.placeholder ?? "", "aria-labelledby": opts.labelledBy }) as HTMLTextAreaElement;
  box.value = was?.text ?? "";
  let follow: { question: string; box: HTMLTextAreaElement } | null = null;
  const slot = h("div", { class: "checkin-deeper" });

  const showFollow = (question: string, text = "") => {
    const id = `checkin-deeper-${Math.random().toString(36).slice(2, 8)}`;
    const fbox = h("textarea", { class: "field checkin-text checkin-text--follow", rows: 4, maxlength: MAX_ANSWER_CHARS, "aria-labelledby": id, placeholder: "Answer this, or leave it blank to skip it." }) as HTMLTextAreaElement;
    fbox.value = text;
    const skip = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Skip this one");
    skip.addEventListener("click", () => {
      follow = null;
      slot.replaceChildren();
      paintButton();
      box.focus();
    });
    follow = { question, box: fbox };
    slot.replaceChildren(h("div", { class: "checkin-deeper__card" }, h("p", { class: "checkin-deeper__label" }, icons.sparkle(), "Athena asks"), h("p", { class: "checkin-deeper__q", id }, question), fbox, h("div", { class: "checkin-deeper__foot" }, skip)));
  };

  const go = h("button", { class: "btn btn--soft btn--sm checkin-deeper__go", type: "button" }, icons.sparkle(), "Go deeper");
  // Offered for this question while there's a connection and Athena has something to ask.
  let unavailable = false;
  const paintButton = () => {
    go.hidden = !q.deeper || !opts.deeper || !!follow || unavailable || !navigator.onLine;
  };
  const onLine = () => {
    if (!go.isConnected) {
      window.removeEventListener("online", onLine);
      window.removeEventListener("offline", onLine);
      return;
    }
    paintButton();
  };
  window.addEventListener("online", onLine);
  window.addEventListener("offline", onLine);
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.setAttribute("aria-busy", "true");
    go.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), "Thinking");
    const question = await opts.deeper!(box.value).catch(() => null);
    go.disabled = false;
    go.removeAttribute("aria-busy");
    go.replaceChildren(icons.sparkle(), "Go deeper");
    if (!question) unavailable = true;
    else {
      showFollow(question);
      follow?.box.focus();
    }
    paintButton();
  });

  if (was?.deeper) showFollow(was.deeper.question, was.deeper.text ?? "");
  paintButton();
  return {
    el: h("div", { class: "checkin-written" }, box, go, slot),
    value: () => {
      const text = box.value.trim();
      const deeper = follow ? { question: follow.question, ...(follow.box.value.trim() ? { text: follow.box.value.trim() } : {}) } : undefined;
      if (!text && !deeper?.text) return null;
      return { text, ...(deeper ? { deeper } : {}) };
    },
    focus: () => box.focus(),
  };
}
