/**
 * "Share" on a flow's page (lib/flow-share.ts): the flow as a file someone else can add to their own Athena. A
 * sheet, built like the assistant's (team/share-sheet.ts):
 *
 * - What goes and what stays: the trigger and steps go; runs, your records and who runs it stay.
 * - What it reaches, worked out from the file (lib/reach.ts): nothing leaves the site, a model or a lookup (each
 *   named), or the web.
 * - Steps that can't go yet (they lean on your own types or fields), by name, with why. Nothing downloads while
 *   there are any.
 * - What Athena took out (links into your Athena), and what looks like yours: edit it out below, or say it's fine.
 *   The server checks again before it sends the file.
 * - The name, a summary (drafted from the trigger and steps, no model), and a question for each record, list or
 *   to-do context a step named, worded by you, which whoever adds it answers with one of theirs. These change the
 *   file only, never the flow.
 *
 * The file is a zip with flow.json (flow.json alone in sample mode). It has no link to this Athena.
 */
import "../styles/skills.css";
import "../styles/team-share.css";
import "../styles/flow-share.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { openSheet } from "../components/sheet";
import { showToast } from "../components/toast";
import { checkFlowExport, downloadFlowExport, type FlowExport, type FlowShareEdits } from "../db/flow-share";
import { loadCatalog, type Flow } from "../db/flows";
import { isSampleMode } from "../db/api";
import { reachOfFlow } from "../../../lib/reach";
import { allSharedSteps, type FlowExportBlocked, type SharedFlowAsk, type SharedFlowStep } from "../../../lib/flow-share";
import { FLOW_LIMITS, type CatalogEntry, type FlowStep } from "../../../lib/flow-types";
import { MAX_QUESTION, MAX_SUMMARY } from "../../../lib/team-skill";
import type { Finding } from "../../../lib/team-share";
import { findingKindWords, removedWords } from "../team/share-words";
import { stepTitle } from "./words";
import { stepTile } from "./parts";
import { asksHint, blockedLede, flowFindingsLede, flowWhereWords, reachWords, usedByWords } from "./share-words";

const errorText = (error: unknown) => (error instanceof Error && error.message && !/fetch|network|Failed/i.test(error.message) ? error.message : "That didn't work. Check you're online.");
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function openShareFlow(flow: Flow): void {
  const body = h("div", { class: "skills-form wf fs" }, h("div", { class: "skills-loading" }, h("span", { class: "orb orb--thinking", "aria-hidden": "true" }), h("p", {}, "Getting it ready…")));
  openSheet({ title: `Share ${flow.name}`, label: `Share ${flow.name} as a file`, body, variant: "tall" });
  const fine = new Set<string>();
  let read: (() => FlowShareEdits) | null = null;
  let catalog: CatalogEntry[] = [];
  let steps: SharedFlowStep[] = [];
  let findingsEl: HTMLElement | null = null;
  let blockedEl: HTMLElement | null = null;
  let removedEl: HTMLElement | null = null;
  let download: HTMLButtonElement | null = null;
  let left = { findings: 0, blocked: 0 };
  let busy = false;
  let timer = 0;

  const edits = (): FlowShareEdits => read?.() ?? {};
  /** A step's name in the file, as the flow's page shows it. */
  const stepName = (id: string): string => {
    const s = steps.find((x) => x.id === id);
    return s ? stepTitle(s as unknown as FlowStep, catalog) : "a step";
  };
  /** The step's own tile, as the flow's page shows it. */
  const stepTileOf = (id: string): HTMLElement => {
    const s = steps.find((x) => x.id === id);
    const t = s ? stepTile(s as unknown as FlowStep, "md") : h("span", { class: "tile tile--sm" }, icons.flag());
    t.setAttribute("aria-hidden", "true");
    return t;
  };
  const settle = () => {
    if (download) download.disabled = left.findings > 0 || left.blocked > 0;
  };

  function paintBlocked(blocked: FlowExportBlocked[]) {
    if (!blockedEl) return;
    left.blocked = blocked.length;
    blockedEl.hidden = !blocked.length;
    if (!blocked.length) return blockedEl.replaceChildren();
    blockedEl.replaceChildren(
      h("p", { class: "skills-form__caption" }, "Can't be shared yet"),
      h("p", { class: "form__hint wf-lede" }, blockedLede(blocked.length)),
      h("ul", { class: "card card--flush list fs-list" }, ...blocked.map((b) => h("li", { class: "row fs-row" }, stepTileOf(b.step_id), h("span", { class: "row__body" }, h("span", { class: "row__title" }, stepName(b.step_id)), h("span", { class: "row__meta" }, b.why)))))
    );
  }

  function paintFindings(findings: Finding[]) {
    if (!findingsEl) return;
    left.findings = findings.length;
    if (!findings.length) {
      findingsEl.replaceChildren(h("p", { class: "wf-clear" }, icons.check(), h("span", {}, flowFindingsLede(0))));
      return;
    }
    findingsEl.replaceChildren(
      h("p", { class: "skills-form__caption" }, "Check these first"),
      h("p", { class: "form__hint wf-lede" }, flowFindingsLede(findings.length)),
      h(
        "ul",
        { class: "card card--flush list wf-findings" },
        ...findings.map((f) => {
          const ok = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `${f.term} is fine to share` }, "It's fine");
          ok.addEventListener("click", () => {
            fine.add(f.id);
            void check();
          });
          return h("li", { class: "row wf-finding" }, h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.flag()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, f.term), h("span", { class: "row__meta" }, `${findingKindWords(f.kind)}. ${flowWhereWords(f.where, stepName)}.`)), ok);
        })
      )
    );
  }

  function paintRemoved(x: FlowExport) {
    if (!removedEl) return;
    const words = removedWords(x.removed);
    removedEl.hidden = !words.length;
    removedEl.replaceChildren(icons.check(), h("span", {}, `Athena took out ${list(words)}.`));
  }

  function paintChecks(x: FlowExport) {
    steps = allSharedSteps(x.shared.steps);
    paintBlocked(x.blocked);
    paintFindings(x.findings);
    paintRemoved(x);
    settle();
  }

  async function check() {
    window.clearTimeout(timer);
    if (busy) return;
    busy = true;
    try {
      paintChecks(await checkFlowExport(flow, edits(), [...fine]));
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

  function draw(x: FlowExport) {
    steps = allSharedSteps(x.shared.steps);
    const w = x.shared;
    const name = h("input", { class: "field", type: "text", value: w.name, maxlength: FLOW_LIMITS.name, autocomplete: "off", "aria-label": "Name" }) as HTMLInputElement;
    const summary = h("textarea", { class: "field fs-summary", rows: 2, maxlength: MAX_SUMMARY, "aria-label": "What it does", placeholder: "What it does, and when it runs", spellcheck: true }, w.summary) as HTMLTextAreaElement;
    const author = h("input", { class: "field", type: "text", value: w.author ?? "", maxlength: 39, autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Optional", "aria-label": "Your GitHub username" }) as HTMLInputElement;
    const version = h("input", { class: "field", type: "text", value: w.version ?? "1.0.0", maxlength: 20, autocomplete: "off", "aria-label": "Version" }) as HTMLInputElement;

    // One question for each record, list or context a step named. The owner words it; whoever adds the flow answers it.
    const questions: Array<{ ask: SharedFlowAsk; input: HTMLInputElement }> = w.asks.map((ask, i) => {
      const input = h("input", { class: "field", type: "text", value: ask.question, maxlength: MAX_QUESTION, autocomplete: "off", "aria-label": `Question ${i + 1}`, "aria-describedby": `fs-ask-${i}-used` }) as HTMLInputElement;
      input.addEventListener("input", soon);
      return { ask, input };
    });
    const askList = questions.length
      ? h(
          "ol",
          { class: "fs-asks" },
          ...questions.map(({ ask, input }, i) => {
            const used = x.blanks.find((b) => b.key === ask.key)?.steps ?? [];
            return h("li", { class: "fs-ask" }, input, h("span", { class: "fs-ask__used", id: `fs-ask-${i}-used` }, usedByWords(used, stepName)));
          })
        )
      : null;

    read = () => ({
      name: name.value,
      summary: summary.value,
      asks: questions.map(({ ask, input }) => ({ ...ask, question: input.value })),
      author: author.value.trim() || undefined,
      version: version.value.trim() || undefined,
    });
    for (const el of [name, summary, author, version]) el.addEventListener("input", soon);

    const reach = reachWords(reachOfFlow(w));
    const reachCard = h(
      "div",
      { class: `card fs-reach fs-reach--${reach.icon}` },
      h("span", { class: "tile tile--sm fs-tile", "aria-hidden": "true" }, icons[reach.icon]()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, reach.title), h("span", { class: "row__meta" }, reach.detail))
    );

    blockedEl = h("section", { class: "wf-check fs-blocked", "aria-live": "polite", hidden: true });
    findingsEl = h("section", { class: "wf-check", "aria-live": "polite" });
    removedEl = h("p", { class: "skills-draft-note", hidden: true });
    download = h("button", { class: "btn btn--primary btn--block", type: "button" }, icons.arrowDown(), "Download") as HTMLButtonElement;
    const again = h("button", { class: "btn btn--soft btn--block", type: "button" }, icons.refresh(), "Check again");
    again.addEventListener("click", () => void check());
    download.addEventListener("click", async () => {
      window.clearTimeout(timer);
      download!.disabled = true;
      try {
        const stopped = await downloadFlowExport(flow, edits(), [...fine]);
        if (stopped) {
          paintBlocked(stopped.blocked);
          paintFindings(stopped.findings);
          showToast(stopped.blocked.length ? "A step can't be shared yet." : "Something's still flagged. Edit it out, or say it's fine.", { icon: "flag" });
          return;
        }
        showToast(isSampleMode() ? "Saved flow.json. Your own copy saves it in a zip." : `Saved ${x.slug}.zip. Share it however you like.`, { icon: "check" });
      } catch (error) {
        showToast(errorText(error), { icon: "refresh" });
      } finally {
        settle();
      }
    });

    body.replaceChildren(
      h("p", { class: "settings__lede wf-intro" }, "A file anyone can add to their own Athena, with this flow's trigger and steps. Its runs stay here, and so do your records and who runs it."),
      reachCard,
      blockedEl,
      removedEl,
      findingsEl,
      h("label", { class: "skills-form__label" }, h("span", {}, "Name"), name),
      h("label", { class: "skills-form__label" }, h("span", {}, "What it does"), summary),
      h("p", { class: "form__hint" }, "One or two sentences. Whoever adds it reads this first."),
      h("div", { class: "skills-form__label", role: "group", "aria-labelledby": "fs-asks-title" }, h("span", { id: "fs-asks-title" }, "Questions for whoever adds it"), h("p", { class: "form__hint" }, asksHint(questions.length)), askList),
      h("div", { class: "wf-pair" }, h("label", { class: "skills-form__label" }, h("span", {}, "Your GitHub username"), author), h("label", { class: "skills-form__label" }, h("span", {}, "Version"), version)),
      h("p", { class: "form__hint fs-starts" }, "Wherever it's added, it starts switched off, and every step that changes something waits for their Go."),
      h("div", { class: "skills-form__actions" }, again, download),
      h("p", { class: "form__hint" }, "The file has no link to your Athena. Send it to someone, keep it in your own GitHub repository, or offer it to a catalogue of flows.")
    );
    paintChecks(x);
  }

  void Promise.all([checkFlowExport(flow, {}, []), loadCatalog().catch(() => [] as CatalogEntry[])]).then(
    ([x, c]) => {
      catalog = c;
      draw(x);
    },
    (error) => {
      body.replaceChildren(h("p", { class: "skills-error" }, icons.flag(), h("span", {}, errorText(error))));
    }
  );
}
