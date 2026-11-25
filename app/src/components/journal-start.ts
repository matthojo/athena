/**
 * "Start from a template" under a day's empty journal (views/days-day.ts). A quiet text button in the journal's foot,
 * there only while the page is empty: the moment the owner types, it goes, and it comes back if they clear the page.
 * It never takes the focus.
 *
 * It opens a sheet of the owner's templates: the ones they wrote and the ones they added from someone else (Athena's
 * starters are for meetings, trips and projects, so they aren't offered). Picking one fills the journal with it
 * (lib/templates.ts journalFromTemplate: the opening heading left out, dates as this day's) and saves, with Undo. It
 * never replaces words: if the page has any by the time one is picked, nothing changes and a toast says so, and
 * Undo only empties the page while it still holds exactly what the template put there.
 */
import "../styles/documents.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { loadTemplates, type NoteTemplate } from "../db/documents";
import { journalFromTemplate } from "../../../lib/templates";
import { longDate, weekLabel, weekStart } from "./day-words";
import { communityHash } from "../community/words";
import { journalTemplates, SHARED_TAG, START_LABEL, startWords } from "./template-share-words";
import type { JournalHandle } from "./day-journal";

export function journalStart(opts: { date: string; today: string; journal: () => JournalHandle | null }): { el: HTMLElement; update: (text: string) => void } {
  const el = h("button", { class: "journal__start", type: "button", hidden: true }, icons.copy(), h("span", {}, START_LABEL)) as HTMLButtonElement;
  el.addEventListener("click", () => open());
  const update = (text: string) => {
    el.hidden = !!text.trim();
  };

  function open() {
    const body = h("div", { class: "tpl jstart" });
    const sheet = openSheet({ label: startWords.title, title: startWords.title, body });
    (sheet.dialog.querySelector(".sheet__scroll") as HTMLElement).replaceChildren(body);
    body.replaceChildren(h("div", { class: "tpl__loading" }, h("span", { class: "doc-spin", "aria-hidden": "true" })));
    void loadTemplates().then(
      (all) => {
        const mine = journalTemplates(all);
        if (!mine.length) {
          const browse = h("a", { class: "btn btn--soft btn--block", href: communityHash("template") }, icons.globe(), startWords.browse);
          browse.addEventListener("click", () => sheet.close());
          body.replaceChildren(h("div", { class: "jstart__empty" }, h("span", { class: "tile", "aria-hidden": "true" }, icons.copy()), h("p", { class: "tpl__empty" }, startWords.empty)), browse);
          return;
        }
        const rows = mine.map((t, i) => {
          const pick = h(
            "button",
            { class: "tpl-card__main", type: "button" },
            h("span", { class: `tile tile--sm${t.shared ? " jstart__tile--shared" : ""}`, "aria-hidden": "true" }, icons[t.shared ? "copy" : "note"]()),
            h(
              "span",
              { class: "tpl-card__text" },
              h("span", { class: "tpl-card__name" }, h("span", { class: "tpl-card__label" }, t.name), t.shared ? h("span", { class: "tpl-card__tag tpl-card__tag--shared" }, SHARED_TAG) : null),
              h("span", { class: "tpl-card__blurb" }, t.blurb)
            )
          );
          pick.addEventListener("click", () => {
            sheet.close();
            use(t);
          });
          return h("li", { class: "tpl-card", style: `--i:${i}` }, pick);
        });
        body.replaceChildren(h("p", { class: "tpl__lede" }, startWords.lede), h("ul", { class: "tpl__list", role: "list" }, ...rows));
      },
      () => body.replaceChildren(h("p", { class: "tpl__empty" }, startWords.failed))
    );
  }

  function use(t: NoteTemplate) {
    const journal = opts.journal();
    if (!journal) return;
    // Never over words: the owner may have started typing while the sheet was open.
    if (journal.value().trim()) {
      showToast(startWords.notEmpty, { icon: "pen" });
      return;
    }
    const text = journalFromTemplate(t.body, { date: longDate(opts.date, opts.today), week: weekLabel(weekStart(opts.date), opts.today) });
    if (!text) return;
    journal.set(text);
    showToast(startWords.started(t.name), {
      icon: "copy",
      action: {
        label: "Undo",
        run: () => {
          const now = opts.journal();
          if (!now) return;
          if (now.value() === text) {
            now.set("");
            showToast(startWords.undone, { icon: "restore" });
          } else showToast(startWords.undoKept, { icon: "pen" });
        },
      },
    });
  }

  return { el, update };
}
