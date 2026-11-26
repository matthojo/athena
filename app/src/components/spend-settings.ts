/**
 * Settings → AI spend (#/settings/spend): what Athena's AI cost today, in words first ("£1.20 of £3 today"),
 * where it went (Ask, each assistant, background work, pictures), the last 7 days, and the daily budget it won't
 * go past. Spend always shows; the budget is unset until the owner sets one. Each
 * assistant's own cap is set on its page (components/spend-cap.ts) and listed here.
 *
 * Money is in the owner's currency (Profile → Region), converted by the server (lib/spend.ts).
 */
import "../styles/spend.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { allowMore, loadSpend, onSpendChange, saveBudget, spendSnapshot, type SpendLine, type SpendView } from "../db/spend";
import { areaName, money, spentWords } from "../../../lib/spend-types";
import { clockTime } from "../lib/clock";

/** Spend in the owner's currency: "£1.20", "Less than £0.01". */
export const spendMoney = (v: Pick<SpendView, "currency" | "locale">, n: number) => spentWords(n, v.currency, v.locale);
/** A budget or a step: "£3", "£0.50". */
export const budgetMoney = (v: Pick<SpendView, "currency" | "locale">, n: number) => money(n, v.currency, v.locale);

/** "in pounds", "in dollars": what the amount box is in, for its label. Others by their code: "in CHF". */
const CURRENCY_WORDS: Record<string, string> = { GBP: "pounds", USD: "dollars", EUR: "euros", JPY: "yen", AUD: "Australian dollars", CAD: "Canadian dollars", NZD: "New Zealand dollars", INR: "rupees" };
export const currencyWords = (currency: string): string => CURRENCY_WORDS[currency] ?? currency;

/** The symbol in front of the amount box: "£", "$", "CHF". */
export function currencySymbol(currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

/** "Wed", "Today": a day of the week in the owner's language. */
function dayName(day: string, today: string, locale: string): string {
  if (day === today) return "Today";
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

/** "Wednesday 12 November": for a screen reader's row in the week's table. */
function dayLong(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

/** The split: one line each for Ask, each assistant, background work and pictures, with a bar for its share. */
export function splitList(v: SpendView, lines: SpendLine[], label: string): HTMLElement {
  const total = lines.reduce((n, l) => n + l.spent, 0);
  if (!total) return h("p", { class: "spend-split__none" }, "Nothing yet.");
  return h(
    "ul",
    { class: "spend-split", "aria-label": label },
    ...lines.map((l) => {
      const share = total ? Math.max(0.015, l.spent / total) : 0;
      const name = l.area === "assistant" && l.assistant_id && l.name ? h("a", { class: "spend-split__name", href: `#/team/${l.assistant_id}` }, areaName(l)) : h("span", { class: "spend-split__name" }, areaName(l));
      return h(
        "li",
        { class: "spend-split__row", "data-area": l.area },
        h(
          "span",
          { class: "spend-split__line" },
          name,
          h("span", { class: "spend-split__amount" }, spendMoney(v, l.spent), l.estimated ? h("span", { class: "spend-tag" }, "estimated high") : null)
        ),
        h("span", { class: "spend-split__bar", "aria-hidden": "true" }, h("span", { class: "spend-split__fill", style: `--share:${share}` }))
      );
    })
  );
}

/** The week: seven bars with the budget drawn across, and the same as a table for a screen reader. */
function weekChart(v: SpendView): HTMLElement {
  const days = v.week.days;
  const top = Math.max(...days.map((d) => d.spent), v.budget.daily ?? 0, 0.01) * 1.08;
  const budget = v.budget.daily;
  const chart = h(
    "div",
    { class: "spend-week__chart", "aria-hidden": "true" },
    h(
      "div",
      { class: "spend-week__plot", style: budget ? `--budget:${budget / top}` : "" },
      budget ? h("span", { class: "spend-week__budget" }) : null,
      ...days.map((d) =>
        h(
          "span",
          { class: "spend-week__col", "data-today": d.day === v.today.day ? "true" : undefined },
          h("span", { class: "spend-week__amount" }, spendMoney(v, d.spent)),
          h("span", { class: "spend-week__bar", style: `--h:${d.spent / top}` })
        )
      )
    ),
    h("div", { class: "spend-week__days" }, ...days.map((d) => h("span", { class: "spend-week__day", "data-today": d.day === v.today.day ? "true" : undefined }, dayName(d.day, v.today.day, v.locale))))
  );
  const table = h(
    "table",
    { class: "visually-hidden" },
    h("caption", {}, "Spend on each of the last 7 days"),
    h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Day"), h("th", { scope: "col" }, "Spent"))),
    h("tbody", {}, ...days.map((d) => h("tr", {}, h("th", { scope: "row" }, d.day === v.today.day ? "Today" : dayLong(d.day, v.locale)), h("td", {}, `${spendMoney(v, d.spent)}${d.estimated ? ", estimated high" : ""}`))))
  );
  return h("div", { class: "spend-week__figure" }, chart, table);
}

/** The sentence under today's figure: what's left, or that Athena has stopped, or that there's no budget. */
function todayWords(v: SpendView): { text: string; icon: Element | null } {
  const b = v.budget;
  if (b.limit === null) return { text: "No daily budget, so nothing stops Athena. You can set one below.", icon: null };
  const left = Math.max(0, b.limit - v.today.spent);
  const stop = budgetMoney(v, b.limit);
  if (b.state === "reached") return { text: "Today's budget is used. Athena has stopped until midnight, Ask included.", icon: icons.clock() };
  if (b.state === "near") return { text: `Nearly there: ${spendMoney(v, left)} left. At ${stop}, Athena stops until midnight.`, icon: icons.hourglass() };
  return { text: `${spendMoney(v, left)} left. At ${stop}, Athena stops until midnight.`, icon: null };
}

/** Today: the figure in words, a meter against the budget, Allow more when it's used, and where it went. */
function todayCard(v: SpendView, act: { more: () => Promise<void> }): HTMLElement {
  const b = v.budget;
  const words = todayWords(v);
  const pct = b.limit ? Math.min(1, v.today.spent / b.limit) : 0;
  const meter =
    b.limit === null
      ? null
      : h(
          "div",
          {
            class: "spend-meter",
            role: "meter",
            "aria-label": "Today's spend against the budget",
            "aria-valuemin": "0",
            "aria-valuemax": String(b.limit),
            "aria-valuenow": String(Math.min(v.today.spent, b.limit)),
            "aria-valuetext": `${spendMoney(v, v.today.spent)} of ${budgetMoney(v, b.limit)}, ${Math.round(pct * 100)}%`,
            "data-state": b.state,
          },
          h("span", { class: "spend-meter__fill", style: `--pct:${pct}` }),
          b.extra && b.daily ? h("span", { class: "spend-meter__mark", style: `--at:${b.daily / b.limit}`, title: `Your ${budgetMoney(v, b.daily)} budget` }) : null
        );
  const more = h("button", { class: "btn btn--primary spend-more", type: "button" }, icons.plus(), `Allow ${budgetMoney(v, b.step)} more today`);
  more.addEventListener("click", async () => {
    more.disabled = true;
    try {
      await act.more();
    } finally {
      more.disabled = false;
    }
  });
  const extraLine = b.extra ? h("p", { class: "spend-today__extra" }, `Includes ${budgetMoney(v, b.extra)} you allowed on top today.`) : null;
  return h(
    "div",
    { class: "card spend-card spend-today", "data-state": b.state },
    h("p", { class: "spend-card__label", id: "spend-today-label" }, "Today"),
    h(
      "p",
      { class: "spend-today__figure", "aria-describedby": "spend-today-words" },
      h("span", { class: "spend-today__spent" }, spendMoney(v, v.today.spent)),
      b.limit !== null ? h("span", { class: "spend-today__of" }, ` of ${budgetMoney(v, b.limit)}`) : null,
      v.today.estimated ? h("span", { class: "spend-tag spend-tag--hero" }, "estimated high") : null
    ),
    meter,
    h("p", { class: "spend-today__words", id: "spend-today-words", tabindex: "-1", "data-state": b.state }, words.icon ? h("span", { class: "spend-today__icon", "aria-hidden": "true" }, words.icon) : null, h("span", {}, words.text)),
    extraLine,
    b.state === "reached" ? h("div", { class: "spend-today__actions" }, more) : null,
    h("div", { class: "spend-card__divider", role: "presentation" }),
    splitList(v, v.today.lines, "Where today's spend went")
  );
}

function weekCard(v: SpendView): HTMLElement {
  const avg = v.week.spent / 7;
  return h(
    "div",
    { class: "card spend-card spend-week" },
    h("h3", { class: "spend-card__title" }, "Last 7 days"),
    h(
      "p",
      { class: "spend-card__sub" },
      v.week.spent ? `${spendMoney(v, v.week.spent)} in all, about ${spendMoney(v, avg)} a day.` : "Nothing spent in the last 7 days.",
      v.budget.daily !== null ? ` The dashed line is your ${budgetMoney(v, v.budget.daily)} budget.` : ""
    ),
    weekChart(v),
    h("div", { class: "spend-card__divider", role: "presentation" }),
    splitList(v, v.week.lines, "Where the week's spend went")
  );
}

/** The daily budget: set, change or remove it. Each assistant's cap is listed, set on its own page. */
function budgetCard(v: SpendView, act: { save: (daily: number | null) => Promise<boolean> }): HTMLElement {
  const b = v.budget;
  const id = "spend-daily";
  const input = h("input", {
    class: "field spend-amount__input",
    id,
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    placeholder: "3.00",
    value: b.daily === null ? "" : b.daily.toFixed(2).replace(/\.00$/, ""),
    "aria-describedby": `${id}-help ${id}-error`,
  }) as HTMLInputElement;
  const error = h("p", { class: "spend-error", id: `${id}-error`, "aria-live": "polite" });
  const save = h("button", { class: "btn btn--primary", type: "submit" }, b.daily === null ? "Set budget" : "Save");
  const remove = h("button", { class: "btn btn--ghost", type: "button" }, "Remove budget");
  const form = h(
    "form",
    { class: "spend-budget__form", novalidate: true },
    h("label", { class: "field-label spend-budget__label", for: id }, `Daily budget, in ${currencyWords(v.currency)}`),
    h("div", { class: "spend-amount" }, h("span", { class: "spend-amount__symbol", "aria-hidden": "true" }, currencySymbol(v.currency, v.locale)), input),
    error,
    h("div", { class: "spend-budget__actions" }, save, b.daily !== null ? remove : null)
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    // Only a currency symbol in front is set aside: anything else that isn't a number is an error, never "empty".
    const raw = input.value.trim().replace(/^[£$€¥₹]\s*/, "").replace(",", ".");
    const n = Number(raw);
    if (!raw) {
      error.textContent = b.daily === null ? "Type an amount, like 3." : "";
      if (b.daily !== null) await act.save(null);
      return;
    }
    if (!Number.isFinite(n) || n <= 0) {
      error.textContent = "Type an amount above zero, like 3 or 2.50.";
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    error.textContent = "";
    input.removeAttribute("aria-invalid");
    save.setAttribute("disabled", "");
    try {
      await act.save(n);
    } finally {
      save.removeAttribute("disabled");
    }
  });
  remove.addEventListener("click", () => void act.save(null));

  const capped = v.assistants.filter((a) => a.cap !== null);
  const caps = v.assistants.length
    ? h(
        "div",
        { class: "spend-caps" },
        h("h4", { class: "spend-caps__title" }, "Each assistant"),
        h("p", { class: "spend-card__sub" }, capped.length ? "An assistant past its own cap stops. The rest of Athena carries on." : "An assistant can have a cap of its own. Set it on its page."),
        h(
          "div",
          { class: "card card--flush list spend-caps__list" },
          ...v.assistants.map((a) => {
            const limit = a.cap === null ? null : a.cap + a.extra;
            const meta = limit === null ? `${spendMoney(v, a.spent)} today, no cap` : a.state === "reached" ? `Stopped: ${spendMoney(v, a.spent)} of ${budgetMoney(v, limit)} today` : `${spendMoney(v, a.spent)} of ${budgetMoney(v, limit)} today`;
            return h(
              "a",
              { class: "row spend-caps__row", href: `#/team/${a.assistant_id}`, "data-state": a.state },
              h(
                "span",
                { class: "row__body" },
                h("span", { class: "row__title" }, a.name ?? "An assistant"),
                h("span", { class: "row__meta" }, meta),
                limit === null ? null : h("span", { class: "spend-caps__meter", "aria-hidden": "true" }, h("span", { class: "spend-caps__fill", style: `--pct:${Math.min(1, a.spent / limit)}` }))
              ),
              h("span", { class: "row__trail" }, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()))
            );
          })
        )
      )
    : null;

  return h(
    "div",
    { class: "card spend-card spend-budget" },
    h("h3", { class: "spend-card__title" }, "Daily budget"),
    h("p", { class: "spend-card__sub", id: `${id}-help` }, "At this amount everything stops until midnight, Ask included. When it does, one tap allows a little more for the day."),
    form,
    caps
  );
}

/** How the figures were worked out: the exchange rate and its date, and any model counted at an estimated price. */
function notes(v: SpendView): HTMLElement {
  const out: HTMLElement[] = [];
  const when = (iso: string) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? `at ${clockTime(d)} today` : `on ${new Intl.DateTimeFormat(v.locale, { day: "numeric", month: "short" }).format(d)}`;
  };
  if (v.rate_missing) out.push(h("p", { class: "settings__note spend-note" }, icons.globe(), h("span", {}, "Shown in dollars until Athena can get an exchange rate for your currency.")));
  else if (v.rate)
    out.push(
      h(
        "p",
        { class: "settings__note spend-note", "data-stale": v.rate.stale ? "true" : undefined },
        v.rate.stale ? icons.clock() : icons.globe(),
        h(
          "span",
          {},
          v.rate.stale
            ? `Today's exchange rate couldn't be fetched, so the one from ${when(v.rate.as_of).replace(/^on /, "")} is used: ${budgetMoney(v, v.rate.value)} to $1.`
            : `Prices are published in dollars and shown here at ${budgetMoney(v, v.rate.value)} to $1, the rate fetched ${when(v.rate.as_of)}.`
        )
      )
    );
  else out.push(h("p", { class: "settings__note spend-note" }, icons.globe(), h("span", {}, "Worked out from each model's published prices for what it reads and writes.")));
  if (v.estimated_models.length)
    out.push(
      h(
        "p",
        { class: "settings__note spend-note" },
        icons.flag(),
        h(
          "span",
          {},
          "Estimated high: ",
          ...v.estimated_models.flatMap((m, i) => [i ? ", " : "", h("code", {}, m)]),
          v.estimated_models.length === 1 ? " has no published price, so it counts at the dearest price from the same company." : " have no published price, so they count at the dearest price from the same company."
        )
      )
    );
  return h("div", { class: "spend-notes" }, ...out);
}

export function spendSettingsSection(): { el: HTMLElement; destroy: () => void } {
  const body = h("div", { class: "settings__body spend", "aria-busy": "true" });
  const live = h("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const el = h(
    "section",
    { class: "settings__section settings__section--spend", "aria-labelledby": "settings-spend" },
    h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-spend" }, icons.wallet(), "AI spend")),
    h("p", { class: "settings__lede" }, "What Athena's AI cost, worked out from each model's published prices. Set a daily budget and Athena stops there until midnight."),
    body,
    live
  );
  let view: SpendView | null = spendSnapshot();
  const say = (text: string) => {
    // Cleared first, so the same words said twice are still read out.
    live.textContent = "";
    requestAnimationFrame(() => (live.textContent = text));
  };

  const act = {
    more: async () => {
      try {
        const v = await allowMore();
        say(`${budgetMoney(v, v.budget.step)} more allowed today. Athena carries on until ${budgetMoney(v, v.budget.limit ?? 0)}.`);
        // The button has gone with the "used" state: the keyboard lands on the words that replaced it.
        body.querySelector<HTMLElement>("#spend-today-words")?.focus();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "That didn't work. Check you're online", { icon: "wifiOff" });
      }
    },
    save: async (daily: number | null) => {
      try {
        const v = await saveBudget({ daily });
        say(daily === null ? "Daily budget removed. Spend still shows here." : `Daily budget set to ${budgetMoney(v, daily)}.`);
        return true;
      } catch (error) {
        showToast(error instanceof Error ? error.message : "That didn't save. Check you're online", { icon: "wifiOff" });
        return false;
      }
    },
  };

  function paint() {
    if (!view) return;
    // A repaint keeps the keyboard where it was: the amount box, or the button that was used.
    const focused = document.activeElement as HTMLElement | null;
    const keep = body.contains(focused) ? (focused?.id || (focused?.classList.contains("spend-more") ? ".spend-more" : null)) : null;
    body.removeAttribute("aria-busy");
    body.replaceChildren(todayCard(view, act), weekCard(view), budgetCard(view, act), notes(view));
    if (keep) (keep.startsWith(".") ? body.querySelector<HTMLElement>(keep) ?? body.querySelector<HTMLElement>("#spend-daily") : body.querySelector<HTMLElement>(`#${keep}`))?.focus();
  }

  function failed() {
    const again = h("button", { class: "btn btn--soft", type: "button" }, icons.refresh(), "Try again");
    again.addEventListener("click", () => void load());
    body.removeAttribute("aria-busy");
    body.replaceChildren(h("div", { class: "empty" }, h("span", { class: "tile" }, icons.wifiOff()), h("p", { class: "empty__title" }, "AI spend didn't load"), h("p", { class: "empty__sub" }, "It needs a connection. Check you're online and try again."), again));
  }

  async function load() {
    try {
      view = await loadSpend();
      paint();
    } catch {
      if (!view) failed();
    }
  }

  if (view) paint();
  else body.replaceChildren(h("div", { class: "card spend-card spend-skeleton" }, h("span", { class: "skeleton", style: "height:14px;width:20%" }), h("span", { class: "skeleton", style: "height:40px;width:55%" }), h("span", { class: "skeleton", style: "height:10px;width:100%" })));
  void load();
  const off = onSpendChange((v) => {
    view = v;
    paint();
  });
  return { el, destroy: off };
}
