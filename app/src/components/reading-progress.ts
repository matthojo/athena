/**
 * The Watch & read sheet's Progress row (0042): how far through it you are.
 * "[120] of [300] [pages ▾]", "[4] of [8] [episodes ▾]" or "[45] [percent ▾]".
 * The first unit offered fits the kind (pages for a book, episodes for a
 * show). Clearing the first number clears the progress. The row shows while
 * something is under way, or whenever a position is kept.
 */
import { h } from "../lib/dom";
import { field, input, select } from "./fields";
import { defaultProgressUnit, parseProgress, type ProgressUnit, type ReadingProgress, type ReadingStatus } from "../../../lib/watch-read";
import "../styles/reading-progress.css";

/** Words on this row (docs/notes/rich-links-stage2s.md "New copy"). */
export const PROGRESS_COPY = {
  label: "Progress",
  of: "of",
  units: { page: "pages", episode: "episodes", percent: "percent" } as Record<ProgressUnit, string>,
  done: "How far",
  total: "Out of",
  unit: "Counted in",
};

export function readingProgressRow(opts: {
  kind: string;
  status: ReadingStatus;
  value: ReadingProgress | null | undefined;
  /** Called with a valid position, or null when cleared. */
  onChange: (p: ReadingProgress | null) => void;
  /** A position that can't be kept ("310 is more than the total of 300"). */
  onProblem: (message: string) => void;
}): { el: HTMLElement; value: () => ReadingProgress | null; setKind: (kind: string) => void; setStatus: (s: ReadingStatus) => void } {
  let kept = opts.value ?? null;
  let status = opts.status;
  const unit = select(
    PROGRESS_COPY.unit,
    (Object.keys(PROGRESS_COPY.units) as ProgressUnit[]).map((u) => ({ value: u, label: PROGRESS_COPY.units[u] })),
    kept?.unit ?? defaultProgressUnit(opts.kind)
  );
  unit.classList.add("rp__unit");
  const num = { inputmode: "numeric", min: 0, step: 1, autocomplete: "off" };
  const done = input("number", kept ? String(kept.done) : "", { ...num, class: "prop__input rp__num", placeholder: "0", "aria-label": PROGRESS_COPY.done });
  const total = input("number", kept?.total ? String(kept.total) : "", { ...num, min: 1, class: "prop__input rp__num", placeholder: "–", "aria-label": PROGRESS_COPY.total });
  const of = h("span", { class: "rp__of" }, PROGRESS_COPY.of);
  // Size each number to what's in it (or its placeholder).
  const fit = (el: HTMLInputElement) => el.style.setProperty("--ch", String(Math.max(1, (el.value || el.placeholder).length)));
  for (const el of [done, total]) {
    fit(el);
    el.addEventListener("input", () => fit(el));
  }
  const group = h("span", { class: "rp" }, done, of, total, unit);
  const row = field(PROGRESS_COPY.label, group);

  const paint = () => {
    const percent = unit.value === "percent";
    of.hidden = percent;
    total.hidden = percent;
    done.max = percent ? "100" : "";
    row.hidden = status !== "reading" && !kept;
  };

  /** What the inputs say now: a position, null (cleared), or a problem. */
  function read(): ReadingProgress | null | { problem: string } {
    if (!done.value.trim()) return null;
    const p = parseProgress({ unit: unit.value, done: done.value.trim(), total: unit.value === "percent" ? null : total.value.trim() || null });
    return p ?? null;
  }

  function commit() {
    const p = read();
    if (p && "problem" in p) {
      done.setAttribute("aria-invalid", "true");
      opts.onProblem(p.problem);
      return;
    }
    done.removeAttribute("aria-invalid");
    if (JSON.stringify(p) === JSON.stringify(kept)) return;
    kept = p;
    opts.onChange(p);
  }

  for (const el of [done, total]) el.addEventListener("change", commit);
  unit.addEventListener("change", () => {
    paint();
    commit();
  });
  paint();

  return {
    el: row,
    value: () => {
      const p = read();
      return p && "problem" in p ? null : p;
    },
    setKind: (kind) => {
      // Only an empty row follows the kind; a kept position keeps its unit.
      if (!done.value.trim()) {
        unit.value = defaultProgressUnit(kind);
        paint();
      }
    },
    setStatus: (s) => {
      status = s;
      paint();
    },
  };
}
