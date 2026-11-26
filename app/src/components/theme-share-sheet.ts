/**
 * "Share" on one of the person's own themes (lib/theme-share.ts), from its editor in Settings → Appearance: the theme
 * as a file someone else can add to their themes. A sheet, built like the template's (template-share-sheet.ts):
 *
 * - What it reaches: always "Stays in Athena" (lib/reach.ts reachOfTheme).
 * - What Athena took out (links into your Athena) and what looks like yours (people, places, contact details, private
 *   links) in the name and summary: change it here, or say it's fine. The server checks again before it sends the file.
 * - A name (the theme's to start), a line on what it looks like, and the optional author and version.
 * - The file itself, readable, so nothing in it is a surprise.
 *
 * Only themes the person made: Athena's built-in themes and ones they added have no Share. The file is a zip with
 * theme.json (theme.json alone in sample mode). It never holds their own font or text size, or any other theme.
 */
import "../styles/skills.css";
import "../styles/team-share.css";
import "../styles/flow-share.css";
import "../styles/documents.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { checkThemeExport, downloadThemeExport, type ThemeExport, type ThemeShareEdits } from "../db/theme-share";
import { isSampleMode } from "../db/api";
import { submitToCommunity } from "../community/submit";
import { findingKindWords, removedWords } from "../team/share-words";
import { NAME_MAX, SUMMARY_MAX, type OwnTheme } from "../../../lib/theme";
import { serialiseSharedTheme, THEME_FILE } from "../../../lib/theme-share";
import type { Finding } from "../../../lib/team-share";
import { themeFindingsLede, themeReachWords, themeWhereWords, THEME_SHARE_INTRO } from "./theme-share-words";

const errorText = (error: unknown) => (error instanceof Error && error.message && !/fetch|network|Failed/i.test(error.message) ? error.message : "That didn't work. Check you're online.");
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function openShareTheme(t: OwnTheme): void {
  const body = h("div", { class: "skills-form wf fs cs ts" });
  openSheet({ title: "Share this theme", label: `Share ${t.theme.name} as a file`, body, variant: "tall" });
  const fine = new Set<string>();
  let busy = false;
  let timer = 0;

  const name = h("input", { class: "field", type: "text", maxlength: NAME_MAX, autocomplete: "off", value: t.theme.name, "aria-label": "Name" }) as HTMLInputElement;
  const summary = h("textarea", { class: "field fs-summary", rows: 2, maxlength: SUMMARY_MAX, "aria-label": "What it looks like", placeholder: "Warm paper and a deep green accent.", spellcheck: true }) as HTMLTextAreaElement;
  summary.value = t.theme.summary ?? "";
  const author = h("input", { class: "field", type: "text", maxlength: 39, autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Optional", "aria-label": "Your GitHub username" }) as HTMLInputElement;
  const version = h("input", { class: "field", type: "text", value: "1.0", maxlength: 20, autocomplete: "off", "aria-label": "Version" }) as HTMLInputElement;
  const edits = (): ThemeShareEdits => ({ name: name.value, summary: summary.value, author: author.value.trim() || undefined, version: version.value.trim() || undefined });

  const reach = themeReachWords();
  const reachCard = h(
    "div",
    { class: `card fs-reach fs-reach--${reach.icon}` },
    h("span", { class: "tile tile--sm fs-tile", "aria-hidden": "true" }, icons[reach.icon]()),
    h("span", { class: "row__body" }, h("span", { class: "row__title" }, reach.title), h("span", { class: "row__meta" }, reach.detail))
  );
  const findingsEl = h("section", { class: "wf-check", "aria-live": "polite" });
  const removedEl = h("p", { class: "skills-draft-note", hidden: true });
  const file = h("pre", { class: "skill-pre ts-words" });
  const fileBox = h("details", { class: "skill-file ts-words-box" }, h("summary", {}, icons.note(), h("span", { class: "skill-file__name" }, "What goes in the file"), h("span", { class: "skill-file__size" }, THEME_FILE)), file);
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
      findingsEl.replaceChildren(h("p", { class: "wf-clear" }, icons.check(), h("span", {}, themeFindingsLede(0))));
      return;
    }
    findingsEl.replaceChildren(
      h("p", { class: "skills-form__caption" }, "Check these first"),
      h("p", { class: "form__hint wf-lede" }, themeFindingsLede(findings.length)),
      h(
        "ul",
        { class: "card card--flush list wf-findings" },
        ...findings.map((f) => {
          const ok = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `${f.term} is fine to share` }, "It's fine");
          ok.addEventListener("click", () => {
            fine.add(f.id);
            void check();
          });
          return h("li", { class: "row wf-finding" }, h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.flag()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, f.term), h("span", { class: "row__meta" }, `${findingKindWords(f.kind)}. ${themeWhereWords(f.where)}.`)), ok);
        })
      )
    );
  }

  function paintResult(x: ThemeExport | null) {
    const w = x ? removedWords(x.removed) : [];
    removedEl.hidden = !w.length;
    removedEl.replaceChildren(icons.check(), h("span", {}, `Athena took out ${list(w)}.`));
    if (x) file.textContent = serialiseSharedTheme(x.shared);
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
      const x = await checkThemeExport(t.id, edits(), [...fine]);
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
      const got = await downloadThemeExport(t.id, edits(), [...fine]);
      if ("findings" in got) {
        paintFindings(got.findings);
        showToast("Something's still flagged. Change it, or say it's fine.", { icon: "flag" });
        return;
      }
      showToast(isSampleMode() ? "Saved theme.json. A signed-in Athena saves it in a zip." : `Saved ${got.saved}. Share it however you like.`, { icon: "check" });
    } catch (error) {
      showToast(errorText(error), { icon: "refresh" });
    } finally {
      settle();
    }
  });

  body.replaceChildren(
    h("p", { class: "settings__lede wf-intro" }, THEME_SHARE_INTRO),
    reachCard,
    removedEl,
    findingsEl,
    h("label", { class: "skills-form__label" }, h("span", {}, "Name"), name),
    h("label", { class: "skills-form__label" }, h("span", {}, "What it looks like"), summary),
    h("p", { class: "form__hint" }, "One line. Whoever adds it reads this first."),
    h("div", { class: "wf-pair" }, h("label", { class: "skills-form__label" }, h("span", {}, "Your GitHub username"), author), h("label", { class: "skills-form__label" }, h("span", {}, "Version"), version)),
    fileBox,
    problem,
    h("div", { class: "skills-form__actions" }, again, download),
    h("p", { class: "form__hint" }, "The file has no link to your Athena. Send it to someone, or keep it in a GitHub repository of yours."),
    submitToCommunity("theme")
  );
  settle();
  void check();
}
