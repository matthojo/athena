/**
 * "Share <Name>" (lib/workflow.ts): an assistant as a file someone else can
 * add to their own Athena, from its page. A sheet, not a page:
 *
 * - What goes and what stays: the job, instructions, skill, triggers and
 *   looks go; memory, runs, conversations and accounts stay.
 * - What Athena took out for you (links into your Athena, record ids).
 * - What looks like yours (your people, places, addresses, email addresses,
 *   phone numbers, private links): edit it out in the fields below, or say
 *   it's fine to share. Download waits until each one is settled, and the
 *   server checks again before it sends the file.
 * - The fields themselves, which change the file only, never the assistant,
 *   and the questions it asks whoever adds it (the owner's own answers never
 *   go).
 *
 * The file is a zip of workflow.json, SKILL.md and the skill's files. It has
 * no link to this Athena: share it however you like.
 */
import "../styles/skills.css";
import "../styles/workflows.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { openSheet } from "../components/sheet";
import { showToast } from "../components/toast";
import { checkWorkflow, downloadWorkflow, type WorkflowEdits, type WorkflowExport } from "../db/workflows";
import type { TeamAssistant } from "../db/team";
import { isSampleMode } from "../db/api";
import { MAX_INSTRUCTIONS, MAX_JOB, MAX_NAME } from "../../../lib/team-types";
import { MAX_QUESTION, MAX_QUESTIONS } from "../../../lib/team-skill";
import type { Finding, WorkflowAsk } from "../../../lib/workflow";
import { allowOption } from "./setup-allow";
import { cap, pronouns } from "./detail-words";
import { findingKindWords, findingsLede, removedWords, whereWords } from "./workflow-words";

const errorText = (error: unknown) => (error instanceof Error && error.message && !/fetch|network|Failed/i.test(error.message) ? error.message : "That didn't work. Check you're online.");
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A field that grows with its text. */
function area(value: string, opts: { rows: number; max: number; label: string; mono?: boolean }): HTMLTextAreaElement {
  const t = h("textarea", { class: `field${opts.mono ? " skill-editor__body" : ""}`, rows: opts.rows, maxlength: opts.max, "aria-label": opts.label, spellcheck: true }, value) as HTMLTextAreaElement;
  return t;
}

export function openShareWorkflow(a: TeamAssistant): void {
  const p = pronouns(a.personality);
  const body = h("div", { class: "skills-form wf" }, h("div", { class: "skills-loading" }, h("span", { class: "orb orb--thinking", "aria-hidden": "true" }), h("p", {}, "Getting it ready…")));
  const sheet = openSheet({ title: `Share ${a.name}`, label: `Share ${a.name} as a workflow`, body, variant: "tall" });
  const fine = new Set<string>();
  let fields: { read: () => WorkflowEdits } | null = null;
  let findingsEl: HTMLElement | null = null;
  let removedEl: HTMLElement | null = null;
  let download: HTMLButtonElement | null = null;
  let busy = false;
  let timer = 0;

  const edits = (): WorkflowEdits => fields?.read() ?? {};

  function paintFindings(findings: Finding[]) {
    if (!findingsEl || !download) return;
    download.disabled = findings.length > 0;
    if (!findings.length) return findingsEl.replaceChildren(h("p", { class: "wf-clear" }, icons.check(), h("span", {}, findingsLede(findings))));
    findingsEl.replaceChildren(
      h("p", { class: "skills-form__caption" }, "Check these first"),
      h("p", { class: "form__hint wf-lede" }, findingsLede(findings)),
      ...(findings.length
        ? [
            h(
              "ul",
              { class: "card card--flush list wf-findings" },
              ...findings.map((f) => {
                const ok = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "It's fine");
                ok.addEventListener("click", () => {
                  fine.add(f.id);
                  void check();
                });
                return h("li", { class: "row wf-finding" }, h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.flag()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, f.term), h("span", { class: "row__meta" }, `${findingKindWords(f.kind)}. ${whereWords(f.where)}.`)), ok);
              })
            ),
          ]
        : [])
    );
  }

  function paintRemoved(x: WorkflowExport) {
    if (!removedEl) return;
    const words = removedWords(x.removed);
    removedEl.hidden = !words.length;
    removedEl.replaceChildren(icons.check(), h("span", {}, `Taken out for you: ${list(words)}.`));
  }

  async function check() {
    window.clearTimeout(timer);
    if (busy) return;
    busy = true;
    try {
      const x = await checkWorkflow(a.id, edits(), [...fine]);
      paintFindings(x.findings);
      paintRemoved(x);
    } catch (error) {
      showToast(errorText(error), { icon: "refresh" });
    } finally {
      busy = false;
    }
  }

  /** Look again a moment after typing stops. */
  const soon = () => {
    window.clearTimeout(timer);
    if (download) download.disabled = true;
    timer = window.setTimeout(() => void check(), 900);
  };

  function draw(x: WorkflowExport) {
    const w = x.workflow;
    const name = h("input", { class: "field", type: "text", value: w.name, maxlength: MAX_NAME, autocomplete: "off", "aria-label": "Name" }) as HTMLInputElement;
    const job = h("input", { class: "field", type: "text", value: w.job, maxlength: MAX_JOB, autocomplete: "off", "aria-label": "Job" }) as HTMLInputElement;
    const instructions = area(w.instructions, { rows: 5, max: MAX_INSTRUCTIONS, label: "Instructions" });
    const skill = x.skill ? area(x.skill.body, { rows: 10, max: 40_000, label: "Skill", mono: true }) : null;
    const author = h("input", { class: "field", type: "text", value: w.author ?? "", maxlength: 39, autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Optional", "aria-label": "Your GitHub username" }) as HTMLInputElement;
    const version = h("input", { class: "field", type: "text", value: w.version ?? "1.0.0", maxlength: 20, autocomplete: "off", "aria-label": "Version" }) as HTMLInputElement;
    const noLooks = h("input", { type: "checkbox", role: "switch", class: "switch", id: "wf-no-looks", "aria-label": `Leave out ${a.name}'s looks` }) as HTMLInputElement;

    // The questions it asks whoever adds it: the ones it asked you at setup, without your answers.
    let asks: WorkflowAsk[] = w.asks.map((q) => ({ ...q, choices: [...q.choices] }));
    const askList = h("div", { class: "wf-asks" });
    const addAsk = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Add a question") as HTMLButtonElement;
    addAsk.addEventListener("click", () => {
      asks = [...asks, { question: "", choices: [] }];
      paintAsks();
      (askList.querySelector("input:last-of-type") as HTMLInputElement | null)?.focus();
    });
    function paintAsks() {
      addAsk.disabled = asks.length >= MAX_QUESTIONS;
      askList.replaceChildren(
        ...asks.map((q, i) => {
          const input = h("input", { class: "field", type: "text", value: q.question, maxlength: MAX_QUESTION, placeholder: "Which shops do you trust?", autocomplete: "off", "aria-label": `Question ${i + 1}` }) as HTMLInputElement;
          input.addEventListener("input", () => {
            asks[i] = { ...asks[i], question: input.value };
            soon();
          });
          const remove = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Remove question ${i + 1}` }, icons.close());
          remove.addEventListener("click", () => {
            asks = asks.filter((_, j) => j !== i);
            paintAsks();
            soon();
          });
          return h("div", { class: "wf-ask" }, input, remove);
        }),
        ...(asks.length ? [] : [h("p", { class: "form__hint" }, `None yet. ${a.name} works from the job and instructions alone.`)])
      );
    }
    paintAsks();

    fields = {
      read: () => ({
        name: name.value,
        job: job.value,
        instructions: instructions.value,
        ...(skill ? { skill: skill.value } : {}),
        asks: asks.filter((q) => q.question.trim()),
        author: author.value.trim() || undefined,
        version: version.value.trim() || undefined,
        no_avatar: noLooks.checked || undefined,
      }),
    };
    for (const el of [name, job, instructions, skill, author, version]) el?.addEventListener("input", soon);
    noLooks.addEventListener("change", soon);

    findingsEl = h("section", { class: "wf-check", "aria-live": "polite" });
    removedEl = h("p", { class: "skills-draft-note", hidden: true });
    download = h("button", { class: "btn btn--primary btn--block", type: "button" }, icons.arrowDown(), "Download") as HTMLButtonElement;
    const again = h("button", { class: "btn btn--soft btn--block", type: "button" }, icons.refresh(), "Check again");
    again.addEventListener("click", () => void check());
    download.addEventListener("click", async () => {
      window.clearTimeout(timer);
      download!.disabled = true;
      try {
        const left = await downloadWorkflow(a.id, edits(), [...fine]);
        if (left) {
          paintFindings(left);
          showToast("Something's still flagged. Edit it out, or say it's fine.", { icon: "flag" });
          return;
        }
        showToast(isSampleMode() ? "Saved workflow.json. Your own copy saves a zip with the skill too." : `Saved ${x.slug}.zip. Share it however you like.`, { icon: "check" });
      } catch (error) {
        showToast(errorText(error), { icon: "refresh" });
      } finally {
        download!.disabled = !!findingsEl?.querySelector(".wf-finding");
      }
    });

    const wants = w.would_like.map((t) => allowOption(t).label.toLowerCase());
    body.replaceChildren(
      h("p", { class: "settings__lede wf-intro" }, `A file anyone can add to their own Athena, with ${a.name}'s job, instructions, skill, triggers and looks. ${cap(p.their)} memory, runs and conversations stay here, and so do your accounts.`),
      removedEl,
      findingsEl,
      h("label", { class: "skills-form__label" }, h("span", {}, "Name"), name),
      h("label", { class: "skills-form__label" }, h("span", {}, "Job"), job),
      h("label", { class: "skills-form__label" }, h("span", {}, "Instructions"), instructions),
      ...(skill
        ? [h("label", { class: "skills-form__label" }, h("span", {}, "Skill"), skill), h("p", { class: "form__hint" }, "Your answers from setup are worked into this text. Change anything that's only true for you, like a budget or a shop.")]
        : [h("p", { class: "form__hint" }, `${a.name} has no skill yet. Whoever adds ${p.them} gets one written from the job and their answers.`)]),
      h("div", { class: "skills-form__label" }, h("div", { class: "skills-form__row" }, h("span", {}, "Questions for whoever adds it"), addAsk), h("p", { class: "form__hint" }, "Their answers go into its skill. Yours stay here."), askList),
      h("p", { class: "form__hint wf-wants" }, wants.length ? `Whoever adds it chooses whether it can ${list(wants)} without asking. Until they do, it asks first.` : "It asks before every change, wherever it's added."),
      h("div", { class: "wf-pair" }, h("label", { class: "skills-form__label" }, h("span", {}, "Your GitHub username"), author), h("label", { class: "skills-form__label" }, h("span", {}, "Version"), version)),
      h("label", { class: "skill-switch", for: "wf-no-looks" }, h("span", {}, h("span", { class: "skill-switch__title" }, `Leave out ${a.name}'s looks`), h("span", { class: "row__meta" }, "Whoever adds it gets a new character.")), noLooks),
      h("div", { class: "skills-form__actions" }, again, download),
      h("p", { class: "form__hint" }, "The file has no link to your Athena. Send it to someone, keep it in your own GitHub repository, or open a pull request to a workflow catalogue.")
    );
    paintFindings(x.findings);
    paintRemoved(x);
  }

  void checkWorkflow(a.id, {}, []).then(draw, (error) => {
    body.replaceChildren(h("p", { class: "skills-error" }, icons.flag(), h("span", {}, errorText(error))));
  });
  void sheet;
}
