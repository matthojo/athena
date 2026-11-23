/**
 * The tab's title follows the page, so tabs, history and screen readers can
 * tell pages apart: "To do · Athena" on a section, "Priya Shah · Athena" with
 * a person open, plain "Athena" on Home. main.ts says which section is showing
 * (setPageSection, with the nav's own label for it); whatever opens one thing
 * (a note, a record) names it with setPageName and lets go when it closes.
 */

export const APP_NAME = "Athena";

/** The title for a section and, when one thing is open in it, that thing's name. Pure, so it can be tested. */
export function pageTitle(view: string, label: string | null | undefined, name?: string | null): string {
  const lead = clean(name) || (view === "home" ? "" : clean(label));
  return lead ? `${lead} · ${APP_NAME}` : APP_NAME;
}

/** One line, no stray space, and short enough for a tab. */
function clean(text: string | null | undefined): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

let section: { view: string; label: string | null } = { view: "home", label: null };
let named: { name: string } | null = null;

function apply(): void {
  if (typeof document === "undefined") return;
  document.title = pageTitle(section.view, section.label, named?.name);
}

/** The section now showing, with the nav's label for it (main.ts, on every render). */
export function setPageSection(view: string, label: string | null | undefined): void {
  section = { view, label: label ?? null };
  apply();
}

/**
 * Name the one thing that's open (a note, a person, a day), or pass null to
 * clear it. Returns a way to let go that does nothing if something else has
 * been named since, so a pane that closes late can't wipe its replacement's name.
 */
export function setPageName(name: string | null): () => void {
  const mine = name?.trim() ? { name } : null;
  named = mine;
  apply();
  return () => {
    if (!mine || named !== mine) return;
    named = null;
    apply();
  };
}
