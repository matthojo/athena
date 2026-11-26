/**
 * An assistant's own daily cap, on its page (team/team-detail.ts mounts it with one line): what it spent today,
 * its cap, and Allow more when it has stopped. Past its cap the assistant stops until midnight and the rest of
 * Athena carries on. With no cap of its own, only the daily budget applies.
 */
import "../styles/spend.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { allowMore, loadSpend, onSpendChange, saveBudget, spendSnapshot, type SpendView } from "../db/spend";
import { budgetMoney, currencySymbol, currencyWords, spendMoney } from "./spend-settings";

export function spendCapSection(assistantId: string): HTMLElement {
  const titleId = `spend-cap-${assistantId}`;
  const body = h("div", { class: "spend-cap__body" });
  const live = h("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const el = h(
    "section",
    { class: "td-sec spend-cap", "aria-labelledby": titleId },
    h("header", { class: "td-sec__head" }, h("h2", { class: "td-sec__title", id: titleId }, "Daily cap")),
    body,
    live
  );
  const say = (text: string) => {
    live.textContent = "";
    requestAnimationFrame(() => (live.textContent = text));
  };

  async function save(cap: number | null) {
    try {
      const v = await saveBudget({ assistants: { [assistantId]: cap } });
      const name = v.assistants.find((a) => a.assistant_id === assistantId)?.name ?? "This assistant";
      say(cap === null ? `${name} has no cap of its own now.` : `${name}'s cap is ${budgetMoney(v, cap)} a day.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That didn't save. Check you're online", { icon: "wifiOff" });
    }
  }

  function paint(v: SpendView) {
    const mine = v.assistants.find((a) => a.assistant_id === assistantId);
    if (!mine) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const name = mine.name ?? "This assistant";
    const limit = mine.cap === null ? null : mine.cap + mine.extra;
    const focused = body.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focus : undefined;

    const figure = h(
      "p",
      { class: "spend-cap__figure" },
      h("span", { class: "spend-cap__spent" }, spendMoney(v, mine.spent)),
      limit === null ? h("span", { class: "spend-cap__of" }, "today") : h("span", { class: "spend-cap__of" }, `of ${budgetMoney(v, limit)} today`)
    );
    const meter =
      limit === null
        ? null
        : h(
            "div",
            {
              class: "spend-meter spend-meter--sm",
              role: "meter",
              "aria-label": `${name}'s spend today against its cap`,
              "aria-valuemin": "0",
              "aria-valuemax": String(limit),
              "aria-valuenow": String(Math.min(mine.spent, limit)),
              "aria-valuetext": `${spendMoney(v, mine.spent)} of ${budgetMoney(v, limit)}`,
              "data-state": mine.state,
            },
            h("span", { class: "spend-meter__fill", style: `--pct:${Math.min(1, mine.spent / limit)}` })
          );
    const words =
      limit === null
        ? `No cap of its own. ${v.budget.daily === null ? "There's no daily budget either." : `Athena's ${budgetMoney(v, v.budget.daily)} daily budget still applies.`}`
        : mine.state === "reached"
          ? `${name} has stopped until midnight. The rest of Athena carries on.`
          : mine.state === "near"
            ? `Nearly there: ${spendMoney(v, Math.max(0, limit - mine.spent))} left before ${name} stops for today.`
            : `At ${budgetMoney(v, limit)}, ${name} stops until midnight. The rest of Athena carries on.`;

    const more = h("button", { class: "btn btn--primary spend-more", type: "button", "data-focus": "more" }, icons.plus(), `Allow ${budgetMoney(v, v.budget.step)} more today`);
    more.addEventListener("click", async () => {
      more.disabled = true;
      try {
        const next = await allowMore({ assistant_id: assistantId });
        const now = next.assistants.find((a) => a.assistant_id === assistantId);
        body.querySelector<HTMLElement>(".spend-cap__words")?.focus();
        say(`${budgetMoney(next, next.budget.step)} more allowed for ${name} today${now?.cap !== null && now ? `, up to ${budgetMoney(next, (now.cap ?? 0) + now.extra)}` : ""}.`);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "That didn't work. Check you're online", { icon: "wifiOff" });
        more.disabled = false;
      }
    });

    const id = `${titleId}-amount`;
    const input = h("input", {
      class: "field spend-amount__input",
      id,
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      placeholder: "0.50",
      value: mine.cap === null ? "" : mine.cap.toFixed(2).replace(/\.00$/, ""),
      "data-focus": "amount",
      "aria-describedby": `${id}-error`,
    }) as HTMLInputElement;
    const error = h("p", { class: "spend-error", id: `${id}-error`, "aria-live": "polite" });
    const remove = h("button", { class: "btn btn--ghost", type: "button", "data-focus": "remove" }, "Remove cap");
    remove.addEventListener("click", () => void save(null));
    const form = h(
      "form",
      { class: "spend-budget__form", novalidate: true },
      h("label", { class: "field-label", for: id }, `Cap per day, in ${currencyWords(v.currency)}`),
      h("div", { class: "spend-amount" }, h("span", { class: "spend-amount__symbol", "aria-hidden": "true" }, currencySymbol(v.currency, v.locale)), input),
      error,
      h("div", { class: "spend-budget__actions" }, h("button", { class: "btn btn--soft", type: "submit", "data-focus": "save" }, mine.cap === null ? "Set cap" : "Save"), mine.cap !== null ? remove : null)
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      // Only a currency symbol in front is set aside: anything else that isn't a number is an error, never "empty".
    const raw = input.value.trim().replace(/^[£$€¥₹]\s*/, "").replace(",", ".");
      if (!raw) {
        if (mine.cap !== null) void save(null);
        else error.textContent = "Type an amount, like 0.50.";
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        error.textContent = "Type an amount above zero, like 0.50 or 1.";
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      void save(n);
    });

    body.replaceChildren(
      figure,
      meter ?? "",
      h("p", { class: "spend-cap__words", tabindex: "-1", "data-state": mine.state }, words),
      mine.state === "reached" ? h("div", { class: "spend-today__actions" }, more) : "",
      form,
      h("a", { class: "spend-cap__link", href: "#/settings/spend" }, "All of Athena's AI spend", icons.chevronRight())
    );
    if (focused) body.querySelector<HTMLElement>(`[data-focus="${focused}"]`)?.focus();
  }

  const first = spendSnapshot();
  if (first) paint(first);
  else el.hidden = true;
  void loadSpend().catch(() => undefined);
  // Once the page has gone, the next change stops it listening.
  const off = onSpendChange((v) => {
    if (el.dataset.shown && !el.isConnected) return void off();
    if (el.isConnected) el.dataset.shown = "true";
    paint(v);
  });
  return el;
}
