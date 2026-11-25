/**
 * "Share" in Settings → Check-ins (lib/checkin-share.ts): some of the owner's own questions as a file someone else
 * can add to their check-ins. A sheet, built like the flow's (flows/share-sheet.ts):
 *
 * - Which questions go: the ones the owner wrote, each with a tick, none ticked to start. Athena's own and those
 *   added from someone else's set aren't offered.
 * - What it reaches, worked out from what's ticked (lib/reach.ts): stays in Athena, or uses AI through Go deeper.
 * - What Athena took out (links into your Athena), and what looks like yours: change the question, or say it's
 *   fine. The server checks again before it sends the file.
 * - A name (needed), a line on what they're for, and the optional author and version.
 *
 * The file is a zip with checkin.json (checkin.json alone in sample mode). It holds the questions' words and how
 * each is answered, never an answer, a pin or how many are asked a day.
 */
import "../styles/skills.css";
import "../styles/team-share.css";
import "../styles/flow-share.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { TYPE_ICON } from "./checkin-settings";
import { TYPE_NAME } from "./checkin-rules";
import { checkCheckinExport, downloadCheckinExport, type CheckinExport, type CheckinShareEdits } from "../db/checkin-share";
import { isSampleMode } from "../db/api";
import { submitToCommunity } from "../community/submit";
import { findingKindWords, removedWords } from "../team/share-words";
import { offersDeeper, CHECKIN_SHARE_LIMITS } from "../../../lib/checkin-share";
import type { CheckinQuestion } from "../../../lib/checkin-types";
import type { Finding } from "../../../lib/team-share";
import { questionWhereWords, shareFindingsLede, shareReachWords } from "./checkin-share-words";

const errorText = (error: unknown) => (error instanceof Error && error.message && !/fetch|network|Failed/i.test(error.message) ? error.message : "That didn't work. Check you're online.");
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const kindsWords = (q: CheckinQuestion) => (q.kinds.length > 1 ? "Morning and evening" : q.kinds[0] === "morning" ? "Morning" : "Evening");

export function openShareCheckins(own: readonly CheckinQuestion[]): void {
  const mine = own.filter((q) => !q.set);
  const body = h("div", { class: "skills-form wf fs cs" });
  openSheet({ title: "Share your questions", label: "Share your check-in questions as a file", body, variant: "tall" });
  const picked = new Set<string>();
  const fine = new Set<string>();
  let busy = false;
  let timer = 0;

  const name = h("input", { class: "field", type: "text", maxlength: CHECKIN_SHARE_LIMITS.name, autocomplete: "off", placeholder: "Evening wind-down", "aria-label": "Name" }) as HTMLInputElement;
  const summary = h("textarea", { class: "field fs-summary", rows: 2, maxlength: CHECKIN_SHARE_LIMITS.summary, "aria-label": "What they're for", placeholder: "A few quiet questions for the end of the day.", spellcheck: true }) as HTMLTextAreaElement;
  const author = h("input", { class: "field", type: "text", maxlength: 39, autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Optional", "aria-label": "Your GitHub username" }) as HTMLInputElement;
  const version = h("input", { class: "field", type: "text", value: "1.0", maxlength: 20, autocomplete: "off", "aria-label": "Version" }) as HTMLInputElement;
  const edits = (): CheckinShareEdits => ({ name: name.value, summary: summary.value, author: author.value.trim() || undefined, version: version.value.trim() || undefined });

  const reachCard = h("div", { class: "card fs-reach" });
  const findingsEl = h("section", { class: "wf-check", "aria-live": "polite" });
  const removedEl = h("p", { class: "skills-draft-note", hidden: true });
  const problem = h("p", { class: "form__error cs-problem", role: "status" });
  const download = h("button", { class: "btn btn--primary btn--block", type: "button", disabled: true }, icons.arrowDown(), "Download") as HTMLButtonElement;
  const again = h("button", { class: "btn btn--soft btn--block", type: "button" }, icons.refresh(), "Check again");
  let flagged = 0;

  const ready = () => picked.size > 0 && name.value.trim().length > 0;
  const settle = () => {
    download.disabled = !ready() || flagged > 0 || busy;
    problem.textContent = !picked.size ? "Tick at least one question." : !name.value.trim() ? "Give them a name." : "";
  };

  function paintReach() {
    const r = shareReachWords(offersDeeper(mine.filter((q) => picked.has(q.id))));
    reachCard.className = `card fs-reach fs-reach--${r.icon}`;
    reachCard.replaceChildren(h("span", { class: "tile tile--sm fs-tile", "aria-hidden": "true" }, icons[r.icon]()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, r.title), h("span", { class: "row__meta" }, r.detail)));
  }

  function paintFindings(findings: Finding[]) {
    flagged = findings.length;
    if (!findings.length) {
      findingsEl.replaceChildren(h("p", { class: "wf-clear" }, icons.check(), h("span", {}, shareFindingsLede(0))));
      return;
    }
    findingsEl.replaceChildren(
      h("p", { class: "skills-form__caption" }, "Check these first"),
      h("p", { class: "form__hint wf-lede" }, shareFindingsLede(findings.length)),
      h(
        "ul",
        { class: "card card--flush list wf-findings" },
        ...findings.map((f) => {
          const ok = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `${f.term} is fine to share` }, "It's fine");
          ok.addEventListener("click", () => {
            fine.add(f.id);
            void check();
          });
          return h("li", { class: "row wf-finding" }, h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.flag()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, f.term), h("span", { class: "row__meta" }, `${findingKindWords(f.kind)}. ${questionWhereWords(f.where)}.`)), ok);
        })
      )
    );
  }

  function paintRemoved(x: CheckinExport | null) {
    const words = x ? removedWords(x.removed) : [];
    removedEl.hidden = !words.length;
    removedEl.replaceChildren(icons.check(), h("span", {}, `Athena took out ${list(words)}.`));
  }

  const ids = () => mine.filter((q) => picked.has(q.id)).map((q) => q.id);

  async function check() {
    window.clearTimeout(timer);
    paintReach();
    if (!ready()) {
      flagged = 0;
      findingsEl.replaceChildren();
      paintRemoved(null);
      return settle();
    }
    if (busy) return;
    busy = true;
    settle();
    try {
      const x = await checkCheckinExport(ids(), edits(), [...fine]);
      paintFindings(x.findings);
      paintRemoved(x);
    } catch (error) {
      showToast(errorText(error), { icon: "refresh" });
    } finally {
      busy = false;
      settle();
    }
  }

  /** Look again a moment after typing or ticking stops. */
  const soon = () => {
    window.clearTimeout(timer);
    download.disabled = true;
    paintReach();
    timer = window.setTimeout(() => void check(), 700);
  };
  for (const el of [name, summary, author, version]) el.addEventListener("input", soon);
  again.addEventListener("click", () => void check());

  download.addEventListener("click", async () => {
    window.clearTimeout(timer);
    download.disabled = true;
    try {
      const got = await downloadCheckinExport(ids(), edits(), [...fine]);
      if ("findings" in got) {
        paintFindings(got.findings);
        showToast("Something's still flagged. Change it, or say it's fine.", { icon: "flag" });
        return;
      }
      showToast(isSampleMode() ? "Saved checkin.json. A signed-in Athena saves it in a zip." : `Saved ${got.saved}. Share it however you like.`, { icon: "check" });
    } catch (error) {
      showToast(errorText(error), { icon: "refresh" });
    } finally {
      settle();
    }
  });

  const ticks = mine.map((q, i) => {
    const box = h("input", { type: "checkbox", class: "wf-tick__box", id: `cs-q-${i}` }) as HTMLInputElement;
    box.addEventListener("change", () => {
      if (box.checked) picked.add(q.id);
      else picked.delete(q.id);
      soon();
    });
    return h(
      "label",
      { class: "wf-tick cs-tick", for: `cs-q-${i}` },
      box,
      h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[TYPE_ICON[q.type]]()),
      h("span", {}, h("span", { class: "wf-tick__label" }, q.prompt), h("span", { class: "row__meta" }, `${TYPE_NAME[q.type]} · ${kindsWords(q)}`))
    );
  });

  body.replaceChildren(
    h("p", { class: "settings__lede wf-intro" }, "A file anyone can add to their own check-ins, with the questions you pick. Your answers stay here, and so do your pins and how many you're asked a day."),
    reachCard,
    h(
      "div",
      { class: "skills-form__label", role: "group", "aria-labelledby": "cs-pick-title" },
      h("span", { id: "cs-pick-title" }, "Questions to share"),
      mine.length ? h("div", { class: "cs-ticks" }, ...ticks) : h("p", { class: "form__hint" }, "You haven't written any questions yet. Write one first, then share it."),
      own.some((q) => q.set) ? h("p", { class: "form__hint" }, "Questions you added from someone else's set aren't listed. Point people to that set instead.") : null
    ),
    removedEl,
    findingsEl,
    h("label", { class: "skills-form__label" }, h("span", {}, "Name"), name),
    h("label", { class: "skills-form__label" }, h("span", {}, "What they're for"), summary),
    h("p", { class: "form__hint" }, "One line. Whoever adds them reads this first."),
    h("div", { class: "wf-pair" }, h("label", { class: "skills-form__label" }, h("span", {}, "Your GitHub username"), author), h("label", { class: "skills-form__label" }, h("span", {}, "Version"), version)),
    h("p", { class: "form__hint fs-starts" }, "Wherever they're added, they join that person's own questions and never switch a check-in on."),
    problem,
    h("div", { class: "skills-form__actions" }, again, download),
    h("p", { class: "form__hint" }, "The file has no link to your Athena. Send it to someone, or keep it in a GitHub repository of yours."),
    submitToCommunity("checkin")
  );
  paintReach();
  settle();
}
