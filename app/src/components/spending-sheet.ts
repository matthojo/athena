/**
 * Add spending by hand, on the Library's Money page: what it was, how much,
 * the kind of spending and the day. For anyone whose bank Athena can't
 * connect to, or for cash a bank never sees. It's kept with the bank days
 * (POST /api/life/spending, lib/money.ts), so the month totals, the day's
 * money line, Ask and Regular payments all count it. Ask's spending card
 * opens it filled in from what was said (`start`), to change before Add.
 */

import "../styles/manual-entry.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openEditorSheet } from "./editor-sheet";
import { field, input, pickerInput, select } from "./fields";
import { showToast } from "./toast";
import { addSpending, CATEGORY_WORDS, money, type ManualPayment, type MoneyCategory } from "../db/life";
import { localToday } from "../lib/time";
import { parseAmount } from "../../../lib/manual-entry";
import { MONEY_CATEGORIES } from "../../../lib/day-types";

/** Starting values (Ask's card): the amount in minor units, and its currency when it isn't pounds. */
export interface SpendingStart {
  merchant?: string;
  amount?: number;
  currency?: string;
  category?: MoneyCategory;
}

export function openSpendingSheet(onAdded: (p: ManualPayment) => void, opts: { date?: string; start?: SpendingStart } = {}): void {
  const today = localToday();
  const start = opts.start ?? {};
  const currency = start.currency && start.currency !== "GBP" ? start.currency : undefined;
  const sign = currency ? (new Intl.NumberFormat("en-GB", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency) : "£";
  const amount = input("text", start.amount === undefined ? "" : (start.amount / 100).toFixed(2), { inputmode: "decimal", autocomplete: "off", placeholder: "0.00", "aria-label": currency ? `Amount in ${currency}` : "Amount in pounds", class: "prop__input" });
  const amountBox = h("span", { class: "manual-amount" }, h("span", { class: "manual-amount__sign", "aria-hidden": "true" }, sign), amount);
  const category = select(
    "Kind of spending",
    MONEY_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_WORDS[c] })),
    start.category ?? "general"
  );
  const date = pickerInput("date", opts.date ?? today, { max: today, "aria-label": "Day" });

  const fields = h(
    "div",
    { class: "card card--flush fields" },
    field("Amount", amountBox),
    field("Kind", category),
    field("Day", date.el)
  );
  const hint = h("p", { class: "manual-sheet__hint" }, "Kept sealed with the rest of your spending. Athena never sees a balance.");

  const editor = openEditorSheet({
    newLabel: "Add spending",
    isNew: true,
    titleValue: start.merchant ?? "",
    placeholder: "What was it? Coffee, the market…",
    mark: h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.wallet()),
    sections: [fields, hint],
    createLabel: "Add",
    create: async () => {
      const minor = parseAmount(amount.value);
      if (minor === null) {
        showToast("Add how much it was, like 4.50");
        amount.focus();
        return false;
      }
      const made = await addSpending({ merchant: editor.title.value.trim(), amount: minor, category: category.value as MoneyCategory, date: date.input.value || today, ...(currency ? { currency } : {}) });
      showToast(`${money(made.amount, made.currency)} added`, { icon: "check" });
      onAdded(made);
      return true;
    },
  });
}
