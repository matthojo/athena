/**
 * The vehicle card in Life admin (views/admin.ts): what the car is, its MOT
 * and tax in words, the last test, mileage and the latest advisories in
 * plain words. Data from GET /api/car (db/car.ts). A missing source says
 * what adding it would give, with the way to Sources.
 */
import "../styles/car.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showRegistration } from "../../../lib/car";
import type { CarCard } from "../db/car";

const SOURCES = "#/settings/sources?add=travel";

/** "1 Dec", or "1 Dec 2027" when it isn't this year. */
function day(date: string, today: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: date.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const miles = (n: number) => `${n.toLocaleString("en-GB")} miles`;
const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);
const ago = (n: number) => (n === 1 ? "yesterday" : `${n} days ago`);

/** The MOT in words, and how soon it needs you. */
export function motLine(c: CarCard, today: string): { text: string; tone?: "soon" | "late" } {
  const { on, days } = c.mot;
  if (!on || days === null) return { text: c.sources.dvla || c.sources.mot ? "No MOT date on record" : "Not read yet" };
  if (days < 0) return { text: `Ran out ${ago(-days)}`, tone: "late" };
  if (days <= 30) return { text: `Runs out ${inDays(days)}, on ${day(on, today)}`, tone: days <= 7 ? "late" : "soon" };
  return { text: `Valid until ${day(on, today)}` };
}

/** The tax in words. */
export function taxLine(c: CarCard, today: string): { text: string; tone?: "soon" | "late" } | null {
  if (!c.sources.dvla) return null;
  const { on, days, status } = c.tax;
  if (status === "SORN") return { text: "Off the road (SORN)" };
  if (status === "Not Taxed for on Road Use") return { text: "Not taxed for the road" };
  if (!on || days === null) return { text: "No tax date on record" };
  if (days < 0) return { text: `Not taxed since ${day(on, today)}`, tone: "late" };
  if (days <= 30) return { text: `Due ${inDays(days)}, on ${day(on, today)}`, tone: days <= 7 ? "late" : "soon" };
  return { text: `Paid until ${day(on, today)}` };
}

function line(label: string, value: HTMLElement | string, tone?: string): HTMLElement {
  return h("div", { class: "car-line" }, h("span", { class: "car-line__label" }, label), h("span", { class: "car-line__value", "data-tone": tone }, value));
}

export function carCardView(c: CarCard, today: string, opts: { onRefresh?: () => void } = {}): HTMLElement {
  const about = [c.colour ? title(c.colour) : null, c.year ? String(c.year) : null, c.fuel ? title(c.fuel) : null].filter(Boolean).join(" · ");
  const mot = motLine(c, today);
  const tax = taxLine(c, today);
  const lines: HTMLElement[] = [line("MOT", mot.text, mot.tone)];
  lines.push(tax ? line("Tax", tax.text, tax.tone) : line("Tax", h("a", { class: "acct-link", href: SOURCES }, "Add a DVLA key for the tax date")));
  if (c.last_test) {
    const t = c.last_test;
    lines.push(line("Last test", `${t.result === "PASSED" ? "Passed" : "Failed"} on ${day(t.date, today)}${t.miles ? ` at ${miles(t.miles)}` : ""}`, t.result === "FAILED" ? "late" : undefined));
  } else if (!c.sources.mot) {
    lines.push(line("Last test", h("a", { class: "acct-link", href: SOURCES }, "Add DVSA MOT history for results and advisories")));
  }
  if (c.miles_a_year) lines.push(line("Mileage", `About ${miles(c.miles_a_year)} a year`));

  const advisories = c.advisories.length
    ? h(
        "div",
        { class: "car-advice" },
        h("p", { class: "car-advice__title" }, c.advisories.length === 1 ? "One thing to keep an eye on" : `${c.advisories.length} things to keep an eye on`),
        h("ul", { class: "car-advice__list" }, ...c.advisories.map((a) => h("li", {}, a))),
        h("p", { class: "car-advice__note" }, "From the last MOT. None of these failed the test.")
      )
    : null;

  const refresh = opts.onRefresh ? (h("button", { class: "btn btn--ghost btn--sm", type: "button" }, icons.refresh(), "Check again") as HTMLButtonElement) : null;
  refresh?.addEventListener("click", () => {
    refresh.disabled = true;
    opts.onRefresh!();
  });
  const checked = c.fetched_on ? (c.fetched_on === today ? "Checked today" : `Checked ${day(c.fetched_on, today)}`) : "Not checked yet";

  return h(
    "article",
    { class: "car-card", "aria-label": c.label },
    h(
      "header",
      { class: "car-card__head" },
      h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.car()),
      h("span", { class: "car-card__name" }, h("span", { class: "car-card__title" }, c.label), about ? h("span", { class: "car-card__about" }, about) : null),
      h("span", { class: "car-plate" }, showRegistration(c.registration))
    ),
    h("div", { class: "car-lines" }, ...lines),
    c.recall ? h("p", { class: "car-warn" }, icons.flag(), "There's a safety recall on this car that hasn't been fixed. The maker or a dealer can tell you more.") : null,
    c.problem ? h("p", { class: "car-warn" }, icons.flag(), c.problem) : null,
    advisories,
    h("footer", { class: "car-card__foot" }, h("span", {}, checked), refresh)
  );
}
