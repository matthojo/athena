/**
 * New flow (mockup 3): say what should happen in a sentence and Athena draws
 * it (POST /api/flows/draft), or build it step by step from a blank one.
 * Either way the flow is kept off until you turn it on in the editor.
 */
import { h } from "../lib/dom";
import { openSheet } from "../components/sheet";
import { showToast } from "../components/toast";
import { createFlow, draftFlow, type Flow } from "../db/flows";
import { FLOW_LIMITS } from "../../../lib/flow-types";
import { tile } from "./parts";
import { communityHash } from "../community/words";

/** Sentences to start from, each beginning with when. */
export const STARTERS: ReadonlyArray<{ icon: "calendar" | "bookmark" | "parcel"; text: string }> = [
  { icon: "calendar", text: "Before I meet someone, show me what I owe them" },
  { icon: "bookmark", text: "When I save an article, link it to my notes" },
  { icon: "parcel", text: "When a parcel is on its way, ask if I'll be in" },
];

export function openNewFlow(o: { text?: string; onMade: (f: Flow, notes: string[]) => void }): void {
  const ta = h("textarea", { class: "flow-new__input", rows: 4, maxlength: FLOW_LIMITS.text, placeholder: "When a renewal email comes in, check what I paid last year and tell me if it's gone up", "aria-label": "What should happen" }) as HTMLTextAreaElement;
  ta.value = o.text ?? "";
  const draw = h("button", { class: "btn btn--primary btn--block flow-new__draw", type: "button" }, "Make the steps");
  const blank = h("button", { class: "flow-link flow-new__blank", type: "button" }, "Or build it step by step");
  const status = h("p", { class: "flow-new__status", role: "status", "aria-live": "polite" });
  // Community (app/src/community/page.ts): flows other people shared, reviewed.
  const browse = h("button", { class: "flow-link flow-new__blank", type: "button" }, "Or browse Community");
  browse.addEventListener("click", () => {
    sheet.close();
    window.setTimeout(() => (location.hash = communityHash("flow")), 450);
  });
  // A flow someone sent as a file or a link: the Add screen (app/src/add/), as on Team and Skills.
  const shared = h("button", { class: "flow-link flow-new__blank", type: "button" }, "Or add one someone shared");
  shared.addEventListener("click", () => {
    sheet.close();
    window.setTimeout(() => (location.hash = "#/add"), 450);
  });
  const starters = h(
    "div",
    { class: "flow-new__starters" },
    ...STARTERS.map((s) => {
      const b = h("button", { class: "flow-new__start", type: "button" }, tile("trigger", s.icon, "md"), h("span", {}, s.text));
      b.addEventListener("click", () => {
        ta.value = s.text;
        ta.focus();
      });
      return b;
    })
  );
  const body = h(
    "div",
    { class: "flow-sheet flow-new" },
    h("div", { class: "flow-new__art", "aria-hidden": "true" }, tile("trigger", "clock", "lg"), h("span", { class: "flow-new__art-wire" }), tile("step", "plus", "lg")),
    h("h2", { class: "flow-new__title" }, "What should happen?"),
    h("p", { class: "flow-new__lede" }, "Say when it should happen and what Athena should do. Athena makes the steps, and you can change any of them."),
    ta,
    h("span", { class: "flow-note" }, "Or start from one of these"),
    starters,
    status,
    h("div", { class: "flow-sheet__foot" }, draw, blank, shared, browse)
  );
  const sheet = openSheet({ label: "New flow", body, variant: "tall" });
  setTimeout(() => ta.focus(), 80);

  let busy = false;
  const make = async (fromSentence: boolean) => {
    if (busy) return;
    const sentence = ta.value.trim();
    if (fromSentence && !sentence) {
      status.textContent = "Say what should happen first, or build it step by step.";
      ta.focus();
      return;
    }
    busy = true;
    draw.disabled = true;
    blank.disabled = true;
    status.textContent = fromSentence ? "Making the steps…" : "";
    try {
      let notes: string[] = [];
      let made: Flow;
      if (fromSentence) {
        const d = await draftFlow(sentence);
        notes = d.notes;
        made = await createFlow({ ...d.flow, paused: true, origin: "draft" });
        if (d.fallback) notes = [...notes, "Athena couldn't make steps from that, so this flow is empty and named after your sentence. Add the steps yourself."];
      } else made = await createFlow({ name: sentence ? sentence.slice(0, FLOW_LIMITS.name) : "New flow", trigger: { kind: "manual" }, steps: [], paused: true, origin: "owner" });
      sheet.close();
      // Closing the sheet steps back in history a beat later: move on after it, as Team's sheets do.
      window.setTimeout(() => o.onMade(made, notes), 450);
    } catch (e) {
      busy = false;
      draw.disabled = false;
      blank.disabled = false;
      status.textContent = "";
      showToast(e instanceof Error && e.message ? `Couldn't make it: ${e.message}` : "Couldn't make it. Try again.");
    }
  };
  draw.addEventListener("click", () => void make(true));
  blank.addEventListener("click", () => void make(false));
}
