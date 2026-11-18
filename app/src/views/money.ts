/**
 * Money, in the Library beside Purchases: each month's spending by category
 * and where it went, from banking sources (GET /api/life/money). Energy is on
 * House (views/house.ts). Opened from
 * sealed rows on the server; never a balance, because Athena never reads
 * one. A sentence first, then Regular payments (lib/recurring.ts: what goes
 * out every week, month or year, GET /api/life/recurring), then the bars,
 * then what was added by hand (GET /api/life/spending). "Add spending"
 * (components/spending-sheet.ts) is always there: a bank connection is one
 * way in, never the only one.
 */

import "../styles/life.css";
import "../styles/manual-entry.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { brandLogo } from "../components/brand-logo";
import { showToast } from "../components/toast";
import { CATEGORY_WORDS, loadMoney, loadRegular, loadSpending, markRegular, money, removeSpending, type ManualPayment, type Money, type MoneyMonth, type RegularPayment, type RegularPayments } from "../db/life";
import { openSpendingSheet } from "../components/spending-sheet";
import type { ViewId } from "../components/nav";
import { exactMoney } from "../../../lib/recurring";
import { pageHead } from "../components/page-head";

const monthName = (m: string, year = false) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
const SHOWN = 6;

function lede(months: MoneyMonth[], thisMonth: string): string {
  const now = months[0];
  const top = now.categories[0];
  const when = now.month === thisMonth ? `in ${monthName(now.month)} so far` : `in ${monthName(now.month)}`;
  const most = top ? ` ${CATEGORY_WORDS[top.category]} took the most, ${money(top.amount, now.currency)}.` : "";
  return `${money(now.spent, now.currency)} spent ${when}.${most}`;
}

function monthCard(m: MoneyMonth, thisMonth: string): HTMLElement {
  const cats = m.categories.slice(0, 6);
  const rest = m.categories.slice(6).reduce((s, c) => s + c.amount, 0);
  const rows = [...cats.map((c) => ({ name: CATEGORY_WORDS[c.category], amount: c.amount })), ...(rest ? [{ name: "The rest", amount: rest }] : [])];
  // Bars against the month's biggest category, so each month reads on its own.
  const max = Math.max(...rows.map((r) => r.amount), 1);
  return h(
    "li",
    { class: "money-month" },
    h("div", { class: "money-month__head" }, h("h2", { class: "money-month__name" }, monthName(m.month, m.month.slice(0, 4) !== thisMonth.slice(0, 4))), h("span", { class: "money-month__total" }, money(m.spent, m.currency))),
    h("p", { class: "money-month__sub" }, `${m.month === thisMonth ? "So far, across" : "Across"} ${m.days} ${m.days === 1 ? "day" : "days"} with spending`),
    h(
      "ul",
      { class: "money-cats", role: "list" },
      ...rows.map((r) =>
        h(
          "li",
          { class: "money-cat" },
          h("span", { class: "money-cat__name" }, r.name),
          h("span", { class: "money-cat__track", "aria-hidden": "true" }, h("span", { class: "money-cat__fill", style: `width:${Math.max(2, Math.round((r.amount / max) * 100))}%` })),
          h("span", { class: "money-cat__amount" }, money(r.amount, m.currency))
        )
      )
    ),
    m.merchants.length
      ? h(
          "div",
          {},
          h("p", { class: "money-merchants__title" }, "Where"),
          h(
            "ul",
            { class: "money-merchants", role: "list" },
            ...m.merchants.slice(0, 5).map((x) =>
              h("li", { class: "money-merchant" }, h("span", { class: "money-merchant__name" }, x.name, x.count > 1 ? h("span", { class: "money-merchant__times" }, `${x.count} times`) : null), h("span", { class: "money-merchant__amount" }, money(x.amount, m.currency)))
            )
          )
        )
      : null
  );
}

// ---------- Regular payments ----------

const DAY_MS = 86_400_000;
const noon = (d: string) => new Date(`${d}T12:00:00Z`);
const daysUntil = (from: string, to: string) => Math.round((noon(to).getTime() - noon(from).getTime()) / DAY_MS);
const shortDate = (d: string) => noon(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekdayName = (d: string) => noon(d).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** "today", "tomorrow", "on Tuesday", "14 Nov". */
function whenWords(on: string, today: string): string {
  const n = daysUntil(today, on);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n > 1 && n < 7) return `on ${weekdayName(on)}`;
  return shortDate(on);
}

const CADENCE: Record<RegularPayment["cadence"], string> = { weekly: "Every week", monthly: "Every month", yearly: "Every year" };

/** Drawn marks for services Athena already has one for (nothing is fetched, so a merchant's name never leaves the device). */
const MARKS: Array<[RegExp, string]> = [
  [/^spotify\b/, "spotify"],
  [/^netflix\b/, "netflix"],
  [/^(google )?youtube\b/, "youtube"],
  [/^octopus\b/, "octopus"],
  [/^dropbox\b/, "dropbox"],
  [/^strava\b/, "strava"],
  [/^oura\b/, "oura"],
  [/^whoop\b/, "whoop"],
  [/^plex\b/, "plex"],
  [/^github\b/, "github"],
  [/^notion\b/, "notion"],
  [/^todoist\b/, "todoist"],
  [/^readwise\b/, "readwise"],
  [/^letterboxd\b/, "letterboxd"],
];

/** Soft hues for the initials, picked by the name so each merchant keeps its own. */
const HUES = ["blue", "teal", "green", "amber", "orange", "pink", "violet", "red"];

function mark(r: RegularPayment): HTMLElement {
  const brand = MARKS.find(([re]) => re.test(r.key));
  if (brand) {
    const logo = brandLogo(brand[1], "md");
    logo.classList.add("regular-row__logo");
    return logo;
  }
  let n = 0;
  for (const c of r.key) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const initial = (r.name.match(/[\p{L}\p{N}]/u)?.[0] ?? "·").toUpperCase();
  return h("span", { class: `regular-row__initial regular-row__initial--${HUES[n % HUES.length]}`, "aria-hidden": "true" }, initial);
}

/** A few past payments as small bars, the latest strongest: a glance at "steady" or "went up". */
function beats(r: RegularPayment): HTMLElement {
  const max = Math.max(...r.recent.map((p) => p.amount), 1);
  const label = (on: string) => (r.cadence === "monthly" ? noon(on).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }) : r.cadence === "yearly" ? on.slice(0, 4) : shortDate(on));
  return h(
    "ol",
    { class: "regular-beats", "aria-label": `Last ${r.recent.length} payments` },
    ...r.recent.map((p, i) =>
      h(
        "li",
        { class: `regular-beat${i === r.recent.length - 1 ? " regular-beat--last" : ""}`, style: `--i:${i}`, title: `${shortDate(p.on)}: ${exactMoney(p.amount, r.currency)}` },
        h("span", { class: "regular-beat__bar", style: `--h:${Math.max(28, Math.round((p.amount / max) * 100))}`, "aria-hidden": "true" }),
        h("span", { class: "regular-beat__on" }, label(p.on)),
        h("span", { class: "visually-hidden" }, exactMoney(p.amount, r.currency))
      )
    )
  );
}

function regularRow(r: RegularPayment, today: string, i: number, hide: (r: RegularPayment, row: HTMLElement) => void): HTMLElement {
  const when = r.missed ? `was due ${shortDate(r.missed.due_on)}` : whenWords(r.next_on, today);
  const flag = r.missed
    ? h("span", { class: "regular-row__flag regular-row__flag--missed" }, h("span", { class: "regular-row__dot", "aria-hidden": "true" }), "Hasn't come")
    : r.rise
      ? h("span", { class: "regular-row__flag regular-row__flag--up" }, icons.arrowUp(), `Up from ${exactMoney(r.rise.from, r.currency)}`)
      : null;
  const id = `regular-${r.key.replace(/[^a-z0-9]+/g, "-")}`;
  const main = h(
    "button",
    { class: "regular-row__main", type: "button", "aria-expanded": "false", "aria-controls": id },
    mark(r),
    h("span", { class: "regular-row__words" }, h("span", { class: "regular-row__name" }, r.name), h("span", { class: "regular-row__meta" }, `${CADENCE[r.cadence]} · ${when}`), flag),
    h("span", { class: "regular-row__amount" }, exactMoney(r.last_amount, r.currency)),
    h("span", { class: "regular-row__chev", "aria-hidden": "true" }, icons.chevronDown())
  );
  const notOne = h("button", { class: "btn btn--soft btn--sm", type: "button" }, r.kind === "bill" ? "Not a bill" : "Not a subscription");
  const lines = [
    r.missed
      ? `Expected around ${shortDate(r.missed.due_on)}. If you've cancelled it, it drops off this list in a few weeks.`
      : `Next one expected ${r.next_on === today || daysUntil(today, r.next_on) === 1 ? whenWords(r.next_on, today) : `on ${shortDate(r.next_on)}`}.`,
    r.rise ? `Went up on ${shortDate(r.rise.on)}, from ${exactMoney(r.rise.from, r.currency)} to ${exactMoney(r.rise.to, r.currency)}.` : `Last paid ${shortDate(r.last_on)}${r.times > 1 ? `, ${r.times} payments so far` : ""}.`,
    r.mandate ? "A live direct debit at your bank." : r.cadence !== "monthly" ? `About ${money(r.monthly, r.currency)} a month.` : "",
  ].filter(Boolean);
  const more = h(
    "div",
    { class: "regular-row__more", id, role: "region", "aria-label": r.name },
    h("div", { class: "regular-row__inner" }, h("div", { class: "regular-row__detail" }, beats(r), h("div", { class: "regular-row__notes" }, ...lines.map((t) => h("p", {}, t)), h("div", { class: "regular-row__actions" }, notOne))))
  );
  const row = h("li", { class: `regular-row${r.missed ? " is-missed" : ""}${r.rise ? " is-up" : ""}`, style: `--i:${i}`, "data-key": r.key }, main, more);
  main.addEventListener("click", () => {
    const open = row.classList.toggle("is-open");
    main.setAttribute("aria-expanded", String(open));
  });
  notOne.addEventListener("click", () => hide(r, row));
  return row;
}

function regularSection(data: RegularPayments, repaint: (next: RegularPayments) => void): HTMLElement {
  const { items, today } = data;
  const total = data.totals[0];
  const section = h("section", { class: "regular", "aria-labelledby": "regular-title" });
  const hide = (r: RegularPayment, row: HTMLElement) => {
    row.classList.add("is-leaving");
    const go = () =>
      markRegular(r.key, true).then(
        (next) => {
          repaint(next);
          showToast(`${r.name} hidden from Regular payments`, {
            icon: "check",
            action: { label: "Undo", run: () => void markRegular(r.key, false).then(repaint, () => showToast("That didn't save. Try again in a moment")) },
          });
        },
        () => {
          row.classList.remove("is-leaving");
          showToast("That didn't save. Try again in a moment");
        }
      );
    // Let the row fold away first; with reduced motion there's nothing to wait for.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) void go();
    else setTimeout(go, 260);
  };

  const head = h(
    "div",
    { class: "regular__head" },
    h("h2", { class: "life-section-title", id: "regular-title" }, "Regular payments"),
    total ? h("p", { class: "regular__total" }, h("span", { class: "regular__amount" }, money(total.amount, total.currency)), h("span", { class: "regular__per" }, "a month")) : null
  );
  if (!items.length) {
    section.append(head, h("p", { class: "life-section-sub" }, "Nothing regular yet. A subscription or bill shows up here once the same payment has gone out a few times."));
  } else {
    const n = items.length;
    const subs = items.filter((r) => r.kind === "subscription" && r.currency === total.currency).reduce((s, r) => s + r.monthly, 0);
    const bills = items.filter((r) => r.kind === "bill" && r.currency === total.currency).reduce((s, r) => s + r.monthly, 0);
    const sum = Math.max(subs + bills, 1);
    // One strip, each payment a share of the month; subscriptions first, then bills.
    const ordered = [...items].filter((r) => r.currency === total.currency).sort((a, b) => (a.kind === b.kind ? b.monthly - a.monthly : a.kind === "subscription" ? -1 : 1));
    const strip = h(
      "div",
      { class: "regular-strip", "aria-hidden": "true" },
      ...ordered.map((r, i) => h("span", { class: `regular-strip__part regular-strip__part--${r.kind}`, style: `flex-grow:${Math.max(r.monthly / sum, 0.006).toFixed(4)};--i:${i}`, "data-key": r.key }))
    );
    const legend = h(
      "p",
      { class: "regular-legend" },
      subs ? h("span", { class: "regular-legend__item regular-legend__item--subscription" }, `Subscriptions ${money(subs, total.currency)}`) : null,
      bills ? h("span", { class: "regular-legend__item regular-legend__item--bill" }, `Bills ${money(bills, total.currency)}`) : null
    );
    const soon = items.filter((r) => r.missed || daysUntil(today, r.next_on) < 7);
    const later = items.filter((r) => !soon.includes(r));
    let i = 0;
    const group = (title: string, list: RegularPayment[]) =>
      list.length ? h("div", { class: "regular-group" }, h("p", { class: "regular-group__title" }, title), h("ul", { class: "regular-list", role: "list" }, ...list.map((r) => regularRow(r, today, i++, hide)))) : null;
    const list = h("div", { class: "regular-card" }, strip, legend, group("In the next week", soon), group("Later on", later));
    // Hovering a row lights its share of the strip.
    list.addEventListener("pointerover", (e) => {
      const key = (e.target as HTMLElement).closest<HTMLElement>(".regular-row")?.dataset.key;
      for (const part of strip.children as HTMLCollectionOf<HTMLElement>) part.classList.toggle("is-lit", !!key && part.dataset.key === key);
      strip.classList.toggle("has-lit", !!key);
    });
    list.addEventListener("pointerleave", () => strip.classList.remove("has-lit"));
    section.append(head, h("p", { class: "life-section-sub" }, `${n <= 10 ? NUMBER_WORDS[n] : n} ${n === 1 ? "subscription or bill" : "subscriptions and bills"}, spotted in your card payments and direct debits.`), list);
  }
  if (data.hidden.length) {
    section.append(
      h(
        "details",
        { class: "regular-hidden" },
        h("summary", {}, `Hidden (${data.hidden.length})`),
        h(
          "ul",
          { class: "regular-hidden__list", role: "list" },
          ...data.hidden.map((x) => {
            const back = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Show again");
            back.addEventListener("click", () => void markRegular(x.key, false).then(repaint, () => showToast("That didn't save. Try again in a moment")));
            return h("li", { class: "regular-hidden__row" }, h("span", {}, x.name), back);
          })
        )
      )
    );
  }
  return section;
}

// ---------- Added by hand ----------

const MANUAL_SHOWN = 6;

function manualSection(list: ManualPayment[], today: string, onRemoved: (p: ManualPayment) => void): HTMLElement {
  let all = false;
  const ul = h("ul", { class: "manual-list", role: "list" });
  const more = h("button", { class: "btn btn--ghost btn--sm manual__more", type: "button" }, `Show all ${list.length}`);
  const paint = () => {
    ul.replaceChildren(...(all ? list : list.slice(0, MANUAL_SHOWN)).map(row));
    more.hidden = all || list.length <= MANUAL_SHOWN;
  };
  more.addEventListener("click", () => {
    all = true;
    paint();
  });
  function row(p: ManualPayment): HTMLElement {
    const name = p.merchant || CATEGORY_WORDS[p.category];
    const remove = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Remove ${name}, ${money(p.amount, p.currency)}` }, icons.trash());
    const li = h(
      "li",
      { class: "manual-row" },
      h("span", { class: "manual-row__words" }, h("span", { class: "manual-row__name" }, name), h("span", { class: "manual-row__meta" }, `${p.date === today ? "Today" : shortDate(p.date)} · ${CATEGORY_WORDS[p.category]}`)),
      h("span", { class: "manual-row__value" }, exactMoney(p.amount, p.currency)),
      remove
    );
    remove.addEventListener("click", () => {
      li.classList.add("is-leaving");
      removeSpending(p.date, p.id).then(
        () => onRemoved(p),
        () => {
          li.classList.remove("is-leaving");
          showToast("That didn't save. Try again in a moment");
        }
      );
    });
    return li;
  }
  paint();
  return h(
    "section",
    { class: "manual", "aria-labelledby": "money-manual-title" },
    h("div", { class: "manual__head" }, h("h2", { class: "life-section-title", id: "money-manual-title" }, "Added by hand")),
    h("p", { class: "life-section-sub" }, "Counted in the months above, on your days and in Ask, like a bank's payments."),
    ul,
    more
  );
}

function empty(go: (view: ViewId) => void, add: () => void): HTMLElement {
  const addBtn = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.plus(), "Add spending");
  addBtn.addEventListener("click", add);
  const open = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plug(), "Connect a bank");
  open.addEventListener("click", () => go("settings"));
  return h(
    "div",
    { class: "life-empty" },
    h("p", { class: "life-empty__title" }, "Nothing spent here yet"),
    h("p", { class: "life-empty__text" }, "Add what you spend yourself, or connect Monzo or Starling and Athena reads it for you. Either way it's encrypted, and Athena never reads your balance."),
    h("div", { class: "life-empty__actions" }, addBtn, open)
  );
}

export function renderMoney(ctx: { go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  const body = h("div", { class: "life-page", "aria-busy": "true" });
  const add = () => openSpendingSheet(() => void load());
  const addBtn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Add spending");
  addBtn.addEventListener("click", add);
  const el = h(
    "div",
    { class: "view lists money" },
    pageHead({ segments: librarySegments("money", ctx.go), title: "Money", actions: [addBtn] }),
    body
  );
  let dead = false;
  let showAll = false;
  let regular: RegularPayments | null = null;
  let regularEl: HTMLElement | null = null;
  let manual: ManualPayment[] = [];
  // Regular payments repaint on their own, so a hide doesn't redraw (or re-animate) the months.
  const paintRegular = (next: RegularPayments) => {
    if (dead) return;
    regular = next;
    const el = regularSection(next, paintRegular);
    if (regularEl?.isConnected) {
      el.classList.add("is-settled");
      regularEl.replaceWith(el);
    }
    regularEl = el;
  };
  const paint = (data: Money) => {
    if (dead) return;
    body.removeAttribute("aria-busy");
    const thisMonth = data.to.slice(0, 7);
    if (!data.months.length && !manual.length) return body.replaceChildren(empty(ctx.go, add));
    const parts: HTMLElement[] = [];
    if (data.months.length) {
      const shown = showAll ? data.months : data.months.slice(0, SHOWN);
      parts.push(h("p", { class: "life-page__lede" }, lede(data.months, thisMonth)));
      if (regular) {
        if (!regularEl) paintRegular(regular);
        parts.push(regularEl!);
      }
      parts.push(h("ul", { class: "money-months", role: "list" }, ...shown.map((m) => monthCard(m, thisMonth))));
      if (!showAll && data.months.length > SHOWN) {
        const more = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Show earlier months");
        more.addEventListener("click", () => {
          showAll = true;
          paint(data);
        });
        parts.push(h("div", {}, more));
      }
    }
    if (manual.length) parts.push(manualSection(manual, data.to, () => void load()));
    body.replaceChildren(...parts);
  };
  // Regular payments and the hand-added list load alongside; if they don't, the page goes without them.
  const load = () =>
    Promise.all([loadMoney(), loadRegular().catch(() => null), loadSpending().catch(() => [] as ManualPayment[])]).then(([data, reg, hand]) => {
      regular = reg;
      regularEl = null;
      manual = hand;
      paint(data);
    }, () => {
      if (dead) return;
      body.removeAttribute("aria-busy");
      body.replaceChildren(h("div", { class: "life-empty" }, h("p", { class: "life-empty__title" }, "Money didn't load"), h("p", { class: "life-empty__text" }, "Check you're online, then come back to this page.")));
    });
  void load();
  return { el, destroy: () => void (dead = true) };
}
