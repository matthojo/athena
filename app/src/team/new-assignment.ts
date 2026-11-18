/**
 * New assignment (docs/team.md "How it runs"): say what the work is, get a
 * proposed lineup, change it, tap Go. A sheet over wherever it was opened.
 */
import "../styles/team-assign.css";
import { h } from "../lib/dom";
import { openSheet } from "../components/sheet";
import { showToast } from "../components/toast";
import { draftLineup } from "../db/assignments";
import { lineupCard } from "./lineup-card";
import { ASSIGNMENT_LIMITS } from "../../../lib/assignment-types";

const EXAMPLES = ["Write the launch post for offline mode, about 600 words", "Work out what the March offsite will cost for 14 people", "Rewrite the pricing page so the plans are easier to compare"];

export function openNewAssignment(opts: { text?: string } = {}): void {
  const box = h("textarea", { class: "na__box", rows: 4, maxlength: ASSIGNMENT_LIMITS.brief, placeholder: "What's the work?", "aria-label": "What's the work?" }) as HTMLTextAreaElement;
  box.value = opts.text ?? "";
  const propose = h("button", { class: "btn btn--primary", type: "button", disabled: !box.value.trim() }, "Propose a lineup") as HTMLButtonElement;
  const ideas = h(
    "div",
    { class: "na__ideas" },
    ...EXAMPLES.map((ex) => {
      const b = h("button", { class: "chip", type: "button" }, ex);
      b.addEventListener("click", () => {
        box.value = ex;
        propose.disabled = false;
        box.focus();
      });
      return b;
    })
  );
  const step = h("div", { class: "na__step" }, h("p", { class: "na__lede" }, "Ask picks who should work on it, in order. You can change the lineup before anything runs."), box, h("p", { class: "na__label" }, "Or start from one of these"), ideas, h("div", { class: "na__foot" }, propose));
  const body = h("div", { class: "na" }, step);
  const sheet = openSheet({ label: "New assignment", title: "New assignment", body, variant: "tall" });

  box.addEventListener("input", () => (propose.disabled = !box.value.trim()));
  propose.addEventListener("click", async () => {
    if (propose.getAttribute("aria-busy")) return;
    propose.setAttribute("aria-busy", "true");
    propose.textContent = "Picking a lineup…";
    try {
      const { lineup, fallback } = await draftLineup(box.value.trim());
      const again = h("button", { class: "link-btn na__again", type: "button" }, "Change the brief");
      again.addEventListener("click", () => {
        body.replaceChildren(step);
        box.focus();
      });
      body.replaceChildren(
        h("p", { class: "na__brief" }, lineup.brief),
        again,
        lineupCard({
          lineup,
          fallback,
          onStarted: (a) => {
            sheet.close();
            location.hash = `#/team/assignment/${encodeURIComponent(a.id)}`;
          },
        })
      );
    } catch (e) {
      showToast(e instanceof Error && e.message && !/^\d{3} /.test(e.message) ? e.message : "The lineup didn't come back. Try again in a moment.", { icon: "refresh" });
    } finally {
      propose.removeAttribute("aria-busy");
      propose.textContent = "Propose a lineup";
    }
  });
  requestAnimationFrame(() => box.focus());
}
