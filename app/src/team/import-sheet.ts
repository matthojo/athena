/**
 * "Import assistant" (lib/team-share.ts): an assistant someone shared, added to
 * this team. Opened from New assistant ("Or import one someone shared"), the
 * empty Team page, a file dropped on the Team page, or a file shared to the
 * installed app (#/team/import); it reads a file, a folder or a GitHub link.
 *
 * Everything is shown before anything is kept: who it is, when it runs, the
 * accounts it needs and whether they're connected, the questions it asks,
 * what it would like to do without asking (each one unticked; only changes
 * inside Athena that keep an Undo, and tracking, can be ticked, and anything
 * else it asked for is listed as always asking first), the connected
 * accounts it may open (each unticked, the ones it needs first), looking
 * things up online (unticked), the sites its words link to, and its whole
 * instructions and skill. It joins paused, so nothing runs until the owner
 * turns it on from its page.
 */
import "../styles/skills.css";
import "../styles/team-share.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { openSheet, type SheetHandle } from "../components/sheet";
import { showToast } from "../components/toast";
import { addImported, previewImportFiles, previewImportLink, type ImportPreview } from "../db/team-share";
import type { TeamAssistant } from "../db/team";
import { MAX_ANSWER, type TeamAnswer } from "../../../lib/team-skill";
import { MAX_ASSISTANTS } from "../../../lib/team-types";
import { shareSeed } from "../../../lib/team-share";
import { avatarFromSeed, renderAvatarTile } from "./avatar";
import { SHARED_TOOLS, toolWords } from "../../../lib/shared-limits";
import { accountTicks } from "../components/account-ticks";
import { answersFor, questionsForm, type AnswerMap } from "./setup-questions";
import { triggerSentence } from "./trigger-editor-words";
import { creditWords, fromWords, needWords } from "./share-words";

const errorText = (error: unknown) => (error instanceof Error && error.message && !/fetch|network|Failed/i.test(error.message) ? error.message : "That didn't work. Check you're online.");

export interface ImportOptions {
  /** Files to read straight away: a drop, or a share to the installed app. */
  files?: File[];
  onAdded: (a: TeamAssistant) => void;
  onClose?: () => void;
}

function setBody(sheet: SheetHandle, el: HTMLElement): void {
  sheet.dialog.querySelector(".sheet__scroll")?.replaceChildren(el);
}

export function openImportAssistant(opts: ImportOptions): void {
  const fileInput = h("input", { type: "file", accept: ".zip,.json,application/zip,application/json", hidden: true }) as HTMLInputElement;
  const folderInput = h("input", { type: "file", hidden: true, webkitdirectory: "", multiple: true }) as HTMLInputElement;
  const option = (icon: "arrowUp" | "folder" | "link", title: string, detail: string, run: () => void) => {
    const b = h("button", { class: "row", type: "button" }, h("span", { class: "tile tile--sm" }, icons[icon]()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, title), h("span", { class: "row__meta" }, detail)), h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
    b.addEventListener("click", run);
    return b;
  };
  const choose = h(
    "div",
    { class: "skills-add" },
    h("p", { class: "settings__lede" }, "An assistant someone shared: its job, instructions, skill and triggers. You see all of it before it's imported, and it joins paused."),
    h(
      "div",
      { class: "card card--flush list" },
      option("arrowUp", "Upload a file", "A shared assistant's .zip, or its assistant.json", () => fileInput.click()),
      option("folder", "Upload a folder", "A folder with assistant.json in it", () => folderInput.click()),
      option("link", "From GitHub", "A folder in a public repository, like a catalogue of assistants", () => linkStep())
    ),
    fileInput,
    folderInput
  );
  const sheet = openSheet({ title: "Import assistant", label: "Import assistant", body: choose, onClose: opts.onClose });

  const fromFiles = (files: File[]) => {
    if (files.length) show(() => previewImportFiles(files));
  };
  fileInput.addEventListener("change", () => fromFiles([...(fileInput.files ?? [])]));
  folderInput.addEventListener("change", () => fromFiles([...(folderInput.files ?? [])]));

  const backToChoose = () => {
    sheet.setTitle("Import assistant");
    sheet.setBack(null);
    fileInput.value = "";
    folderInput.value = "";
    setBody(sheet, choose);
  };

  function linkStep() {
    const url = h("input", { class: "field", type: "url", inputmode: "url", placeholder: "https://github.com/…/tree/main/gift-prices", "aria-label": "Link to the assistant", autocomplete: "off", required: true }) as HTMLInputElement;
    const go = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Preview");
    const form = h(
      "form",
      { class: "skills-form" },
      h("label", { class: "skills-form__label" }, h("span", {}, "Link"), url),
      h("p", { class: "form__hint" }, "A public GitHub folder with an assistant.json in it, or a link to the assistant.json itself. Athena reads it once and shows you everything before importing it."),
      go
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!url.value.trim()) return url.focus();
      show(() => previewImportLink(url.value.trim()));
    });
    sheet.setTitle("From GitHub");
    sheet.setBack(backToChoose);
    setBody(sheet, form);
    url.focus();
  }

  function show(load: () => Promise<ImportPreview>) {
    sheet.setTitle("Check it before importing");
    sheet.setBack(opts.files ? null : backToChoose);
    setBody(sheet, h("div", { class: "skills-loading" }, h("span", { class: "orb orb--thinking", "aria-hidden": "true" }), h("p", {}, "Reading it…")));
    void load().then(
      (p) => setBody(sheet, preview(p)),
      (error) => setBody(sheet, h("div", { class: "skills-form" }, h("p", { class: "skills-error" }, icons.flag(), h("span", {}, errorText(error)))))
    );
  }

  function preview(p: ImportPreview): HTMLElement {
    const w = p.shared;
    const name = w.name || "This assistant";
    const face = renderAvatarTile(w.avatar ?? avatarFromSeed(shareSeed(w)), { size: 72, animate: true });
    const credit = creditWords(w);

    // Its questions: choices to tap where it gave some, a field where it didn't.
    const withChoices = w.asks.map((q, i) => ({ id: `q${i + 1}`, question: q.question, choices: q.choices, allowOther: true })).filter((q) => q.choices.length);
    let picked: AnswerMap = {};
    const free = w.asks
      .filter((q) => !q.choices.length)
      .map((q) => ({ q, input: h("input", { class: "field", type: "text", maxlength: MAX_ANSWER, autocomplete: "off", "aria-label": q.question }) as HTMLInputElement }));
    const answers = (): TeamAnswer[] => [...answersFor(withChoices, picked), ...free.flatMap(({ q, input }) => (input.value.trim() ? [{ question: q.question, answer: input.value.trim() }] : []))];

    // What it would like to do alone: every one unticked.
    // Only what an import can grant is offered (lib/shared-limits.ts); the server checks again.
    const ticks = w.would_like.filter((tool) => SHARED_TOOLS[tool]).map((tool) => {
      const o = SHARED_TOOLS[tool];
      const box = h("input", { type: "checkbox", class: "wf-tick__box", value: tool }) as HTMLInputElement;
      return { box, el: h("label", { class: "wf-tick" }, box, h("span", {}, h("span", { class: "wf-tick__label" }, o.label), o.detail ? h("span", { class: "row__meta" }, o.detail) : null)) };
    });
    const web = w.web ? (h("input", { type: "checkbox", class: "wf-tick__box" }) as HTMLInputElement) : null;
    // The connected accounts it may open: none until ticked, the ones it needs first.
    const accounts = accountTicks({ accounts: p.accounts ?? [], ticked: [], needs: w.needs, idPrefix: "wf-acct", label: `Accounts ${name} can open` });
    const asksFirst = p.asks_first ?? [];

    const add = h("button", { class: "btn btn--primary btn--block", type: "button", disabled: !p.room }, icons.plus(), `Import ${name}`) as HTMLButtonElement;
    const cancel = h("button", { class: "btn btn--soft btn--block", type: "button" }, "Cancel");
    cancel.addEventListener("click", () => sheet.close());
    add.addEventListener("click", async () => {
      add.disabled = true;
      try {
        const made = await addImported(p, { answers: answers(), allow: ticks.filter((t) => t.box.checked).map((t) => t.box.value), web: !!web?.checked, accounts: accounts.value() });
        sheet.close();
        opts.onAdded(made);
      } catch (error) {
        add.disabled = false;
        showToast(errorText(error), { icon: "refresh" });
      }
    });

    const section = (title: string, ...kids: Array<HTMLElement | null>) => h("section", { class: "wf-sec" }, h("p", { class: "skills-form__caption" }, title), ...kids);
    const files = p.skill?.files ?? [];
    return h(
      "div",
      { class: "skills-form wf" },
      h("header", { class: "wf-who" }, face, h("div", {}, h("p", { class: "wf-who__name" }, name), h("p", { class: "wf-who__job" }, w.job), h("p", { class: "skill-preview__source" }, icons.link(), fromWords(p)), credit ? h("p", { class: "row__meta" }, credit) : null)),
      w.summary ? h("p", { class: "wf-summary" }, w.summary) : null,
      p.room ? h("p", { class: "skills-draft-note" }, icons.shield(), h("span", {}, `${name} joins paused. Nothing runs until you turn it on from its page.`)) : h("p", { class: "skills-error" }, icons.flag(), h("span", {}, `Your team has ${MAX_ASSISTANTS} assistants, the most it can have. Remove one to make room.`)),
      section("When it runs", h("ul", { class: "wf-list" }, ...(w.triggers.length ? w.triggers.map((t) => h("li", {}, triggerSentence(t))) : [h("li", {}, "Only when you chat with it or tap Run now")]))),
      p.needs.length ? section("Accounts it needs", h("ul", { class: "wf-list" }, ...p.needs.map((n) => h("li", { class: n.connected ? "is-ok" : "is-missing" }, n.connected ? icons.check() : icons.plug(), h("span", {}, needWords(n)))))) : null,
      w.asks.length
        ? section(
            `${name} asks`,
            h("div", { class: "wf-questions" }, withChoices.length ? questionsForm(withChoices, picked, (m) => (picked = m)) : null, ...free.map(({ q, input }) => h("label", { class: "wf-free" }, h("span", { class: "tq__q" }, q.question), input))),
            h("p", { class: "form__hint" }, "Your answers go into its skill. You can skip any of them.")
          )
        : null,
      section(
        "Accounts it can open",
        h("p", { class: "form__hint" }, `${name} opens only the accounts you tick, in its runs and in chat. You can change this on its page.`),
        accounts.el
      ),
      ticks.length || web
        ? section(
            "Can it go ahead without asking?",
            h("p", { class: "form__hint" }, `${name} would like to do these on its own. Anything you leave unticked waits for your Go.`),
            ...ticks.map((t) => t.el),
            web ? h("label", { class: "wf-tick" }, web, h("span", {}, h("span", { class: "wf-tick__label" }, "Look things up online"), h("span", { class: "row__meta" }, "Searches the web and reads pages it finds, while “Let Ask search the web” is on"))) : null
          )
        : null,
      asksFirst.length
        ? section(
            "Always asks first",
            h("p", { class: "form__hint" }, `${name} also asked to do these alone. An assistant someone shared can't, so each waits for your Go.`),
            h("ul", { class: "wf-list" }, ...asksFirst.map((t) => h("li", {}, icons.shield(), h("span", {}, toolWords(t)))))
          )
        : null,
      p.links.length ? h("p", { class: "skills-error" }, icons.globe(), h("span", {}, `Its instructions link to ${p.links.join(", ")}. Athena didn't check ${p.links.length === 1 ? "that site" : "those sites"}.`)) : null,
      h("details", { class: "skill-file wf-doc", open: !p.skill }, h("summary", {}, icons.note(), h("span", { class: "skill-file__name" }, "Instructions")), h("pre", { class: "skill-pre" }, w.instructions || "None. It works from its job.")),
      p.skill
        ? h(
            "details",
            { class: "skill-file wf-doc" },
            h("summary", {}, icons.book(), h("span", { class: "skill-file__name" }, "Skill"), files.length ? h("span", { class: "skill-file__size" }, files.length === 1 ? "1 file" : `${files.length} files`) : null),
            h("pre", { class: "skill-pre skill-pre--body" }, p.skill.body),
            ...files.map((f) => h("details", { class: "skill-file" }, h("summary", {}, icons.note(), h("span", { class: "skill-file__name" }, f.path)), h("pre", { class: "skill-pre" }, f.text))),
            p.skill.skipped.length ? h("ul", { class: "skill-skipped", "aria-label": "Not used" }, ...p.skill.skipped.map((s) => h("li", {}, h("span", { class: "skill-file__name" }, s.path), h("span", { class: "skill-skipped__why" }, s.reason)))) : null
          )
        : h("p", { class: "form__hint" }, `It has no skill of its own. Athena writes one from its job and your answers when you import it.`),
      h("div", { class: "skills-form__actions" }, cancel, add)
    );
  }

  if (opts.files?.length) fromFiles(opts.files);
}
