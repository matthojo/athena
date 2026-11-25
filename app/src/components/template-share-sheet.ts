/**
 * "Share" on one of the owner's own templates (lib/template-share.ts), from the template editor
 * (components/templates.ts): the template as a file someone else can add to their templates. A sheet, built like the
 * check-in questions' (checkin-share-sheet.ts):
 *
 * - What it reaches: always "Stays in Athena" (lib/reach.ts reachOfTemplate).
 * - What Athena took out (links into your Athena) and what looks like yours (people, places, contact details, private
 *   links): change it in the template, or say it's fine. The server checks again before it sends the file.
 * - A name (the template's to start), a line on what it's for, and the optional author and version.
 * - A look at the words that go, so nothing in the file is a surprise.
 *
 * The file is a zip with template.json (template.json alone in sample mode). It holds the template's name, summary
 * and words, never a note made from it.
 */
import "../styles/skills.css";
import "../styles/team-share.css";
import "../styles/flow-share.css";
import "../styles/documents.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { checkTemplateExport, downloadTemplateExport, type TemplateExport, type TemplateShareEdits } from "../db/template-share";
import { isSampleMode } from "../db/api";
import { submitToCommunity } from "../community/submit";
import { findingKindWords, removedWords } from "../team/share-words";
import { TEMPLATE_SHARE_LIMITS } from "../../../lib/template-share";
import type { Finding } from "../../../lib/team-share";
import type { NoteTemplate } from "../db/documents";
import { templateReachWords, templateWhereWords, TEMPLATE_SHARE_INTRO, templateFindingsLede } from "./template-share-words";

const errorText = (error: unknown) => (error instanceof Error && error.message && !/fetch|network|Failed/i.test(error.message) ? error.message : "That didn't work. Check you're online.");
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function openShareTemplate(t: NoteTemplate): void {
  const body = h("div", { class: "skills-form wf fs cs ts" });
  openSheet({ title: "Share this template", label: `Share ${t.name} as a file`, body, variant: "tall" });
  const fine = new Set<string>();
  let busy = false;
  let timer = 0;

  const name = h("input", { class: "field", type: "text", maxlength: TEMPLATE_SHARE_LIMITS.name, autocomplete: "off", value: t.name, "aria-label": "Name" }) as HTMLInputElement;
  const summary = h("textarea", { class: "field fs-summary", rows: 2, maxlength: TEMPLATE_SHARE_LIMITS.summary, "aria-label": "What it's for", placeholder: "A quiet page for the end of the week.", spellcheck: true }) as HTMLTextAreaElement;
  const author = h("input", { class: "field", type: "text", maxlength: 39, autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Optional", "aria-label": "Your GitHub username" }) as HTMLInputElement;
  const version = h("input", { class: "field", type: "text", value: "1.0", maxlength: 20, autocomplete: "off", "aria-label": "Version" }) as HTMLInputElement;
  const edits = (): TemplateShareEdits => ({ name: name.value, summary: summary.value, author: author.value.trim() || undefined, version: version.value.trim() || undefined });

  const reach = templateReachWords();
  const reachCard = h(
    "div",
    { class: `card fs-reach fs-reach--${reach.icon}` },
    h("span", { class: "tile tile--sm fs-tile", "aria-hidden": "true" }, icons[reach.icon]()),
    h("span", { class: "row__body" }, h("span", { class: "row__title" }, reach.title), h("span", { class: "row__meta" }, reach.detail))
  );
  const findingsEl = h("section", { class: "wf-check", "aria-live": "polite" });
  const removedEl = h("p", { class: "skills-draft-note", hidden: true });
  const words = h("pre", { class: "skill-pre ts-words" }, t.body);
  const wordsBox = h("details", { class: "skill-file ts-words-box" }, h("summary", {}, icons.note(), h("span", { class: "skill-file__name" }, "The words that go"), h("span", { class: "skill-file__size" }, "template.json")), words);
  const problem = h("p", { class: "form__error cs-problem", role: "status" });
  const download = h("button", { class: "btn btn--primary btn--block", type: "button", disabled: true }, icons.arrowDown(), "Download") as HTMLButtonElement;
  const again = h("button", { class: "btn btn--soft btn--block", type: "button" }, icons.refresh(), "Check again");
  let flagged = 0;

  const ready = () => name.value.trim().length > 0;
  const settle = () => {
    download.disabled = !ready() || flagged > 0 || busy;
    problem.textContent = !name.value.trim() ? "Give it a name." : "";
  };

  function paintFindings(findings: Finding[]) {
    flagged = findings.length;
    if (!findings.length) {
      findingsEl.replaceChildren(h("p", { class: "wf-clear" }, icons.check(), h("span", {}, templateFindingsLede(0))));
      return;
    }
    findingsEl.replaceChildren(
      h("p", { class: "skills-form__caption" }, "Check these first"),
      h("p", { class: "form__hint wf-lede" }, templateFindingsLede(findings.length)),
      h(
        "ul",
        { class: "card card--flush list wf-findings" },
        ...findings.map((f) => {
          const ok = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `${f.term} is fine to share` }, "It's fine");
          ok.addEventListener("click", () => {
            fine.add(f.id);
            void check();
          });
          return h("li", { class: "row wf-finding" }, h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.flag()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, f.term), h("span", { class: "row__meta" }, `${findingKindWords(f.kind)}. ${templateWhereWords(f.where)}.`)), ok);
        })
      )
    );
  }

  function paintResult(x: TemplateExport | null) {
    const w = x ? removedWords(x.removed) : [];
    removedEl.hidden = !w.length;
    removedEl.replaceChildren(icons.check(), h("span", {}, `Athena took out ${list(w)}.`));
    if (x) words.textContent = x.shared.body;
  }

  async function check() {
    window.clearTimeout(timer);
    if (!ready()) {
      flagged = 0;
      findingsEl.replaceChildren();
      paintResult(null);
      return settle();
    }
    if (busy) return;
    busy = true;
    settle();
    try {
      const x = await checkTemplateExport(t.id, edits(), [...fine]);
      paintFindings(x.findings);
      paintResult(x);
    } catch (error) {
      showToast(errorText(error), { icon: "refresh" });
    } finally {
      busy = false;
      settle();
    }
  }

  /** Look again a moment after typing stops. */
  const soon = () => {
    window.clearTimeout(timer);
    download.disabled = true;
    timer = window.setTimeout(() => void check(), 700);
  };
  for (const el of [name, summary, author, version]) el.addEventListener("input", soon);
  again.addEventListener("click", () => void check());

  download.addEventListener("click", async () => {
    window.clearTimeout(timer);
    download.disabled = true;
    try {
      const got = await downloadTemplateExport(t.id, edits(), [...fine]);
      if ("findings" in got) {
        paintFindings(got.findings);
        showToast("Something's still flagged. Change it, or say it's fine.", { icon: "flag" });
        return;
      }
      showToast(isSampleMode() ? "Saved template.json. A signed-in Athena saves it in a zip." : `Saved ${got.saved}. Share it however you like.`, { icon: "check" });
    } catch (error) {
      showToast(errorText(error), { icon: "refresh" });
    } finally {
      settle();
    }
  });

  body.replaceChildren(
    h("p", { class: "settings__lede wf-intro" }, TEMPLATE_SHARE_INTRO),
    reachCard,
    removedEl,
    findingsEl,
    h("label", { class: "skills-form__label" }, h("span", {}, "Name"), name),
    h("label", { class: "skills-form__label" }, h("span", {}, "What it's for"), summary),
    h("p", { class: "form__hint" }, "One line. Whoever adds it reads this first."),
    h("div", { class: "wf-pair" }, h("label", { class: "skills-form__label" }, h("span", {}, "Your GitHub username"), author), h("label", { class: "skills-form__label" }, h("span", {}, "Version"), version)),
    wordsBox,
    problem,
    h("div", { class: "skills-form__actions" }, again, download),
    h("p", { class: "form__hint" }, "The file has no link to your Athena. Send it to someone, or keep it in a GitHub repository of yours."),
    submitToCommunity("template")
  );
  settle();
  void check();
}
