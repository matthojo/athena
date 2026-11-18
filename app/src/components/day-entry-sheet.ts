/**
 * Add something to a day by hand, from the day page: a film or show, an
 * album or podcast, a book, a game, or anything else. For when the app it
 * came from isn't one Athena reads. It's kept like any source's entry
 * (POST /api/days/:date/entries, source "manual"), so Music, search and Ask
 * count it too. A workout goes in with the day's health instead
 * (components/health-log-sheet.ts). Ask's day-entry card opens it filled in
 * from what was said (`start`), to change before Add.
 */

import "../styles/manual-entry.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openEditorSheet } from "./editor-sheet";
import { choiceChips, field, input } from "./fields";
import { showToast } from "./toast";
import { addDayEntry, type ManualEntryInput } from "../db/days-app";
import { addEntry } from "../db/days";
import { isSampleMode } from "../db/api";

type Kind = ManualEntryInput["kind"];

const KINDS: Array<{ value: Kind; label: string; icon: IconName; placeholder: string; by: string; byHint: string }> = [
  { value: "watched", label: "Watched", icon: "film", placeholder: "Perfect Days, Severance…", by: "Detail", byHint: "S2E3, or the year" },
  { value: "listened", label: "Listened", icon: "headphones", placeholder: "An album, a podcast…", by: "By", byHint: "Who made it" },
  { value: "read", label: "Read", icon: "book", placeholder: "The book or article", by: "By", byHint: "Who wrote it" },
  { value: "played", label: "Played", icon: "game", placeholder: "A game, a match…", by: "Detail", byHint: "Who with, or where" },
  { value: "other", label: "Something else", icon: "star", placeholder: "Anything worth keeping", by: "Detail", byHint: "A few words more" },
];

/** Starting values (Ask's card). */
export interface DayEntryStart {
  title?: string;
  subtitle?: string;
  minutes?: number;
  note?: string;
}

/**
 * `onAdded` gets what was added and its id: null in sample mode, or when it folded into the same thing from
 * another source that day, so there's nothing of its own to take back.
 */
export function openDayEntrySheet(date: string, onAdded: (entry: ManualEntryInput, id: string | null) => void, opts: { kind?: Kind; start?: DayEntryStart } = {}): void {
  const start = opts.start ?? {};
  const kindOf = (k: Kind) => KINDS.find((x) => x.value === k)!;
  const subtitle = input("text", start.subtitle ?? "", { autocomplete: "off", maxlength: 300 });
  const minutes = input("text", start.minutes === undefined ? "" : String(start.minutes), { inputmode: "numeric", autocomplete: "off", placeholder: "Optional", "aria-label": "Minutes", maxlength: 4 });
  const note = input("text", start.note ?? "", { autocomplete: "off", maxlength: 300, placeholder: "Optional" });
  const byField = field("By", subtitle);
  const byLabel = byField.querySelector(".prop__label")!;
  const mark = h("span", { class: "tile tile--sm", "aria-hidden": "true" });
  const kind = choiceChips<Kind>(
    "What",
    KINDS.map((k) => ({ value: k.value, label: k.label })),
    opts.kind ?? "watched",
    () => paint()
  );
  function paint() {
    const k = kindOf(kind.value());
    byLabel.textContent = k.by;
    subtitle.placeholder = k.byHint;
    editor.title.placeholder = k.placeholder;
    mark.replaceChildren(icons[k.icon]());
  }

  const fields = h(
    "div",
    { class: "card card--flush fields" },
    field("What", kind.el),
    byField,
    field("Minutes", h("span", { class: "manual-pair" }, minutes, h("span", { class: "manual-pair__unit" }, "min"))),
    field("Note", note)
  );

  const editor = openEditorSheet({
    newLabel: "Add to this day",
    isNew: true,
    titleValue: start.title ?? "",
    placeholder: kindOf(opts.kind ?? "watched").placeholder,
    mark,
    sections: [fields],
    createLabel: "Add",
    create: async () => {
      const mins = minutes.value.trim() ? Number(minutes.value.trim()) : undefined;
      if (mins !== undefined && !(Number.isInteger(mins) && mins > 0 && mins <= 1440)) {
        showToast("Minutes: a whole number, up to 1440");
        minutes.focus();
        return false;
      }
      const entry: ManualEntryInput = {
        kind: kind.value(),
        title: editor.title.value.trim(),
        ...(subtitle.value.trim() ? { subtitle: subtitle.value.trim() } : {}),
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
        ...(mins ? { minutes: mins } : {}),
      };
      // The same save as addDayEntry, keeping the id the server answers with.
      const id = isSampleMode() ? (await addDayEntry(date, entry), null) : (await addEntry(date, entry)).id;
      showToast("Added to the day", { icon: "check" });
      onAdded(entry, id);
      return true;
    },
  });
  paint();
}
