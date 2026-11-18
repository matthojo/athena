/**
 * A question back from Athena (lib/answer.ts askBack), under her reply: the
 * answers to tap, and "Something else" for the owner's own words.
 *
 * One question: tapping an answer sends it. Several asked together: pick one
 * under each, then Send; what goes back is each question with its answer,
 * so the conversation reads whole later.
 */
import { h } from "../lib/dom";

export interface AskCardQuestion {
  question: string;
  options: string[];
}

/** What's sent for several questions: each with the answer picked, a line apiece. */
export function askAnswers(asks: AskCardQuestion[], picked: Array<string | undefined>): string {
  return asks.map((a, i) => `${a.question} ${picked[i] ?? ""}`.trim()).join("\n");
}

export function askCard(asks: AskCardQuestion[], on: { send: (text: string) => void; own: () => void }): HTMLElement {
  const several = asks.length > 1;
  const picked: Array<string | undefined> = asks.map(() => undefined);
  const send = h("button", { class: "btn btn--primary ask-card__send", type: "button", disabled: true }, "Send") as HTMLButtonElement;
  const left = h("span", { class: "ask-card__left", "aria-live": "polite" });
  const count = () => {
    const todo = picked.filter((p) => !p).length;
    send.disabled = todo > 0;
    left.textContent = todo ? `${todo} to answer` : "";
  };

  let n = 0;
  const groups = asks.map((a, qi) => {
    const rows = a.options.map((o) => {
      const b = h("button", { class: "ask-card__option", type: "button", style: `--i:${n++}`, ...(several ? { "aria-pressed": "false" } : {}) }, h("span", { class: "ask-card__mark", "aria-hidden": "true" }), h("span", { class: "ask-card__text" }, o));
      b.addEventListener("click", () => {
        if (!several) return on.send(o);
        picked[qi] = picked[qi] === o ? undefined : o;
        for (const r of rows) r.setAttribute("aria-pressed", String(r === b && picked[qi] === o));
        count();
      });
      return b;
    });
    return h("div", { class: "ask-card__group", role: "group", "aria-label": several ? a.question : "Choose one" }, ...(several ? [h("p", { class: "ask-card__question" }, a.question)] : []), ...rows);
  });

  const own = h("button", { class: "ask-card__own", type: "button" }, "Something else");
  own.addEventListener("click", () => on.own());
  send.addEventListener("click", () => {
    if (picked.every(Boolean)) on.send(askAnswers(asks, picked));
  });
  if (several) count();
  return h("div", { class: `followups ask-card${several ? " ask-card--several" : ""}` }, ...groups, h("div", { class: "ask-card__foot" }, own, ...(several ? [left, send] : [])));
}
