/**
 * "Link to Priya Shah": a quiet line under a to-do that names someone Athena
 * knows but has nobody linked (db/todo-people.ts). One tap links them, as the
 * person picker would; the cross says it isn't about them and it's not offered
 * again. When the words fit more than one person, each is a choice.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { saveCommitment } from "../db/memory";
import { dismissTodoPerson } from "../db/todo-people";
import { hueFor, initials } from "../lib/format";
import type { Commitment, PersonRef } from "../types";
import "../styles/todo-people.css";

export function personSuggestion(people: PersonRef[], on: { link: (person: PersonRef) => void; dismiss: () => void }): HTMLElement {
  const el = h("div", { class: "suggest-person", role: "group", "aria-label": "Suggested person" }, h("span", { class: "suggest-person__lead" }, "Link to"));
  for (const p of people) {
    const chip = h("button", { class: "suggest-person__chip", type: "button" }, h("span", { class: "avatar avatar--xs", style: `--h:${hueFor(p.name)}`, "aria-hidden": "true" }, initials(p.name)), h("span", { class: "suggest-person__name" }, p.name));
    chip.addEventListener("click", () => on.link(p));
    el.append(chip);
  }
  const no = h("button", { class: "suggest-person__no", type: "button", "aria-label": "Dismiss suggestion" }, icons.close());
  no.addEventListener("click", () => {
    el.remove();
    on.dismiss();
  });
  el.append(no);
  return el;
}

/** Link a to-do to the person tapped, as the sheet's picker does (a plain to-do with someone becomes "for" them), with Undo. */
export async function linkSuggested(c: Commitment, person: PersonRef): Promise<void> {
  try {
    await saveCommitment({ person_id: person.id, kind: c.kind === "todo" ? "i_owe" : c.kind }, c.id);
    showToast(`Linked to ${person.name}`, {
      icon: "person",
      action: { label: "Undo", run: () => void saveCommitment({ person_id: null, kind: c.kind }, c.id).catch(() => showToast("Couldn't undo", { icon: "wifiOff" })) },
    });
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
  }
}

/** Remember the "no" for this to-do. */
export function dismissSuggested(id: string): void {
  void dismissTodoPerson(id).catch((error) => showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 }));
}
