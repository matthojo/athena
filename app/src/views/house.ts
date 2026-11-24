/**
 * House, in the Library's Life section beside Life admin: the home's energy
 * (charts from the half-hourly readings), what it cost at the tariff, the
 * household bills found in the bank payments, and the Life admin items
 * about the house. GET /api/life/house (lib/house-data.ts) gives the first
 * three, opened from sealed rows on the server; house admin is Life admin's
 * own list, filtered here (lib/house.ts isHouseItem). Meter readings can
 * always be typed in by hand (components/meter-reading-sheet.ts), for a
 * home whose meter Athena can't read.
 */

import "../styles/life.css";
import "../styles/house.css";
import "../styles/manual-entry.css";
import { openMeterReadingSheet } from "../components/meter-reading-sheet";
import { readingGaps } from "../../../lib/manual-entry";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { pageHead } from "../components/page-head";
import { showToast } from "../components/toast";
import { barChart, heatmap, lineChart } from "../components/house-charts";
import { trendsCard } from "../components/trends-charts";
import { loadHouse, removeReading, type DailyPoint, type House, type HouseBill, type HouseEnergy, type MeterReading } from "../db/house";
import { loadAssets, onMemoryChange } from "../db/memory";
import { ASSET_META, renewalLabel } from "../lib/memory-meta";
import { localToday } from "../lib/time";
import { daysBetween } from "../../../lib/dates";
import { BILL_WORDS, houseAdmin } from "../../../lib/house";
import { durationWords } from "../../../lib/home-appliances";
import { exactMoney } from "../../../lib/recurring";
import { pence, unitPrice } from "../../../lib/tariff";
import type { Asset } from "../types";
import type { ViewId } from "../components/nav";
import { clockOfDay, clockTime } from "../lib/clock";

const noon = (d: string) => new Date(`${d}T12:00:00Z`);
const dayShort = (d: string) => noon(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dayLong = (d: string) => noon(d).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const shortDate = (d: string) => noon(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const monthShort = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
const monthLong = (m: string, year = false) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
const hhmm = (slot: number) => clockOfDay(`${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`);
const kwh = (v: number, places = 1) => `${v.toFixed(places)} kWh`;

const SERIES = { electricity: { name: "Electricity", cls: "is-electric" }, gas: { name: "Gas", cls: "is-gas" } };

function card(title: string, takeaway: string, ...body: Array<Node | null>): HTMLElement {
  return h("section", { class: "house-card" }, h("h3", { class: "house-card__title" }, title), takeaway ? h("p", { class: "house-card__take" }, takeaway) : null, ...body);
}

function legend(items: Array<{ name: string; cls: string }>): HTMLElement {
  return h("p", { class: "house-legend", "aria-hidden": "true" }, ...items.map((i) => h("span", { class: "house-legend__item" }, h("i", { class: `house-legend__swatch ${i.cls}` }), i.name)));
}

// ---------- Energy ----------

function todayCard(e: HouseEnergy, today: string): HTMLElement | null {
  const t = e.today;
  if (!t) return null;
  const isToday = t.date === today;
  // The takeaway names the day ("Yesterday: 9.2 kWh…"), so the title says what's drawn.
  const title = isToday ? "Today, each half hour" : "Each half hour";
  const chart = barChart({
    label: `Electricity each half hour, ${dayLong(t.date)}`,
    series: [SERIES.electricity],
    points: t.half_hours.map((v, i) => ({ label: hhmm(i), tick: i % 12 === 0 ? hhmm(i) : undefined, values: [v], faint: isToday && i > t.now_slot })),
    format: (v) => kwh(v, 2),
    line: { name: "A usual day", values: t.typical },
    marker: { index: t.now_slot, text: isToday ? "Now" : "This time" },
    bands: t.cheap ? { name: "Cheap hours", on: t.cheap } : undefined,
    note: t.slot_cost ? (i) => pence(t.slot_cost![i]) : undefined,
  });
  const cost = t.cost_p !== undefined ? h("p", { class: "house-card__aside" }, `${pence(t.cost_p)} with the standing charge.`) : null;
  return card(title, e.takeaways.today, chart, legend([SERIES.electricity, { name: "A usual day", cls: "is-usual" }, ...(t.cheap ? [{ name: "Cheap hours", cls: "is-cheap" }] : [])]), cost);
}


function weekCard(e: HouseEnergy): HTMLElement | null {
  if (!e.heatmap.days.length) return null;
  const map = heatmap({
    label: "Electricity each half hour over the last week",
    rows: e.heatmap.days.map((d) => noon(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" })),
    cells: e.heatmap.cells,
    max: e.heatmap.max,
    format: (v) => kwh(v, 2),
  });
  return card("The week", e.takeaways.week, map);
}

function dayDetail(p: DailyPoint): HTMLElement {
  const rows: HTMLElement[] = [];
  const fuelRow = (name: string, used: number | undefined, c?: { unit_p: number; standing_p: number; total_p: number }) =>
    used === undefined
      ? null
      : h(
          "li",
          { class: "house-detail__row" },
          h("span", { class: "house-detail__name" }, name),
          h("span", { class: "house-detail__kwh" }, kwh(used)),
          c ? h("span", { class: "house-detail__cost" }, pence(c.total_p), h("span", { class: "house-detail__sub" }, `${pence(c.unit_p)} used + ${pence(c.standing_p)} standing`)) : h("span", {})
        );
  for (const r of [fuelRow("Electricity", p.kwh, p.cost?.electricity), fuelRow("Gas", p.gas_kwh, p.cost?.gas)]) if (r) rows.push(r);
  const total = p.cost ? (p.cost.electricity?.total_p ?? 0) + (p.cost.gas?.total_p ?? 0) : null;
  return h(
    "div",
    { class: "house-detail", role: "region", "aria-label": dayLong(p.date), "aria-live": "polite" },
    h("p", { class: "house-detail__title" }, dayLong(p.date), total !== null ? h("span", { class: "house-detail__total" }, pence(total)) : null),
    rows.length ? h("ul", { class: "house-detail__rows", role: "list" }, ...rows) : h("p", { class: "house-card__aside" }, "No readings that day."),
    p.peak ? h("p", { class: "house-card__aside" }, `Busiest half hour ${hhmm(p.peak.slot)}, ${kwh(p.peak.kwh, 2)}.`) : null
  );
}

function dailyCard(e: HouseEnergy): HTMLElement | null {
  if (!e.daily.length) return null;
  const fuels = e.fuels;
  let selected = e.daily.length - 1;
  const detailBox = h("div", {});
  const wrap = h("div", {});
  const paint = () => {
    wrap.replaceChildren(
      barChart({
        label: "Electricity and gas each day, the last 30 days",
        series: fuels.map((f) => SERIES[f]),
        points: e.daily.map((p, i) => ({ label: dayShort(p.date), tick: i % 7 === (e.daily.length - 1) % 7 ? shortDate(p.date) : undefined, values: fuels.map((f) => (f === "electricity" ? (p.kwh ?? null) : (p.gas_kwh ?? null))) })),
        format: (v) => kwh(v),
        note: (i) => {
          const c = e.daily[i].cost;
          return c ? `${pence((c.electricity?.total_p ?? 0) + (c.gas?.total_p ?? 0))} · tap for the day` : "Tap for the day";
        },
        onPick: (i) => {
          selected = i;
          paint();
          (wrap.firstElementChild as HTMLElement | null)?.focus();
        },
        selected,
        height: 160,
      })
    );
    detailBox.replaceChildren(dayDetail(e.daily[selected]));
  };
  paint();
  return card("Last 30 days", e.takeaways.daily, wrap, fuels.length > 1 ? legend(fuels.map((f) => SERIES[f])) : null, detailBox);
}

function monthlyCard(e: HouseEnergy): HTMLElement | null {
  if (e.months.length < 2) return null;
  const charts: HTMLElement[] = [];
  for (const fuel of e.fuels) {
    const pts = e.months.map((m) => ({ label: monthLong(m.month, true), tick: m.month.endsWith("-01") ? m.month.slice(0, 4) : monthShort(m.month), value: m[fuel]?.per_day ?? null }));
    const yoy = e.yoy.find((y) => y.fuel === fuel);
    const ring = yoy ? [e.months.findIndex((m) => m.month === yoy.month), e.months.findIndex((m) => m.month === `${Number(yoy.month.slice(0, 4)) - 1}${yoy.month.slice(4)}`)].filter((i) => i >= 0) : [];
    // The figure itself is in Trends; the ring still marks the two months.
    const head = h("div", { class: "house-mini__head" }, h("span", { class: "house-mini__name" }, h("i", { class: `house-legend__swatch ${SERIES[fuel].cls}`, "aria-hidden": "true" }), `${SERIES[fuel].name}, kWh a day`));
    charts.push(h("div", { class: "house-mini" }, head, lineChart({ label: `${SERIES[fuel].name}, kWh a day by month`, cls: SERIES[fuel].cls, points: pts, format: (v) => `${v.toFixed(1)} kWh a day`, ring })));
  }
  return card("By month", e.takeaways.monthly, ...charts);
}

// ---------- Trends ----------

function trendsCardFor(e: HouseEnergy): HTMLElement | null {
  return e.trends && e.trends.rows.length ? trendsCard(e.trends, e.fuels, e.months) : null;
}

function figuresCard(e: HouseEnergy): HTMLElement | null {
  const out: HTMLElement[] = [];
  if (e.baseload) {
    const b = e.baseload;
    out.push(
      h(
        "section",
        { class: "house-card house-figure" },
        h("h3", { class: "house-card__title" }, "Always on"),
        h("p", { class: "house-figure__big" }, `${b.kwh_year.toLocaleString("en-GB")}`, h("span", { class: "house-figure__unit" }, " kWh a year")),
        h("p", { class: "house-card__aside" }, `${(b.kw * 1000).toFixed(0)} W through the night, ${kwh(b.kwh_day)} a day.`),
        h("p", { class: "house-card__take" }, e.takeaways.baseload)
      )
    );
  }
  if (e.peak) {
    const p = e.peak;
    const share = (n: number, cls: string, name: string) =>
      h("div", { class: "house-share" }, h("span", { class: "house-share__label" }, name, h("span", { class: "house-share__pct" }, `${Math.round(n * 100)}%`)), h("span", { class: "house-share__track", "aria-hidden": "true" }, h("span", { class: `house-share__fill ${cls}`, style: `width:${Math.max(2, Math.round(n * 100))}%` })));
    out.push(
      h(
        "section",
        { class: "house-card house-figure" },
        h("h3", { class: "house-card__title" }, "When you use it"),
        share(p.peak, "is-electric", "16:00 to 19:00"),
        p.cheap !== undefined ? share(p.cheap, "is-gas", "In the cheap hours") : null,
        h("p", { class: "house-card__take" }, e.takeaways.peak)
      )
    );
  }
  return out.length ? h("div", { class: "house-figures" }, ...out) : null;
}

function energySection(data: House, go: (v: ViewId) => void, reload: () => void): HTMLElement {
  const e = data.energy;
  const readings = data.readings ?? [];
  const sec = h("section", { class: "house-sec", "aria-labelledby": "house-energy" }, h("h2", { class: "life-section-title", id: "house-energy" }, "Energy"));
  const addReading = (cls: string, label: string) => {
    const b = h("button", { class: `btn ${cls} btn--sm`, type: "button" }, icons.plus(), label);
    b.addEventListener("click", () => openMeterReadingSheet(readings, () => reload()));
    return b;
  };
  if (!e) {
    const open = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plug(), "Connect your meters");
    open.addEventListener("click", () => go("settings"));
    const waiting = data.meter_account ?? data.meter;
    sec.append(
      h(
        "div",
        { class: "life-empty" },
        h("p", { class: "life-empty__title" }, waiting ? "No readings yet" : readings.length === 1 ? "One reading so far" : "No meters connected"),
        h(
          "p",
          { class: "life-empty__text" },
          waiting
            ? "Readings arrive a day or so late. They show here after the next Home run. You can add your own meter readings meanwhile."
            : readings.length === 1
              ? "Add another reading in a week or a month, and Athena spreads what you used over the days between."
              : "Type in your meter readings now and then, and Athena works out what you use each day. With an Octopus smart meter, connect it instead and readings arrive on their own. Either way they're encrypted."
        ),
        h("div", { class: "life-empty__actions" }, addReading("btn--primary", readings.length ? "Add a reading" : "Add a meter reading"), waiting ? null : open)
      )
    );
    if (readings.length) sec.append(readingsCard(readings, reload));
    return sec;
  }
  sec.append(...[todayCard(e, data.today), weekCard(e), dailyCard(e), monthlyCard(e), trendsCardFor(e), figuresCard(e)].filter((x): x is HTMLElement => !!x));
  if (readings.length) sec.append(readingsCard(readings, reload));
  else sec.append(h("div", {}, addReading("btn--ghost", "Add a meter reading")));
  return sec;
}

const UNIT_WORDS: Record<MeterReading["unit"], string> = { kwh: "kWh", m3: "m³", ft3: "hundreds of ft³" };

/** The readings typed in by hand, newest first, each with what was used since the one before. */
function readingsCard(readings: MeterReading[], reload: () => void): HTMLElement {
  const gaps = readingGaps(readings);
  const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Add a reading");
  add.addEventListener("click", () => openMeterReadingSheet(readings, () => reload()));
  const rows = readings.slice(0, 12).map((r) => {
    const gap = gaps.get(r.id);
    const name = `${SERIES[r.fuel].name}, ${r.value.toLocaleString("en-GB")} ${UNIT_WORDS[r.unit]}`;
    const remove = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Remove ${name}` }, icons.trash());
    const li = h(
      "li",
      { class: "manual-row" },
      h("span", { class: "manual-row__words" }, h("span", { class: "manual-row__name" }, SERIES[r.fuel].name), h("span", { class: "manual-row__meta" }, [dayShort(r.date), gap ? `${kwh(gap.kwh)} over ${gap.days} ${gap.days === 1 ? "day" : "days"}` : ""].filter(Boolean).join(" · "))),
      h("span", { class: "manual-row__value" }, `${r.value.toLocaleString("en-GB")} ${UNIT_WORDS[r.unit]}`),
      remove
    );
    remove.addEventListener("click", () => {
      li.classList.add("is-leaving");
      removeReading(r.id).then(
        () => reload(),
        () => {
          li.classList.remove("is-leaving");
          showToast("That didn't save. Try again in a moment");
        }
      );
    });
    return li;
  });
  return h(
    "section",
    { class: "house-card manual" },
    h("div", { class: "manual__head" }, h("h3", { class: "house-card__title" }, "Meter readings"), add),
    h("p", { class: "house-card__take" }, "Added by hand. What you used between two readings is spread over the days between them."),
    h("ul", { class: "manual-list", role: "list" }, ...rows)
  );
}

// ---------- Cost and tariff ----------

function costSection(data: House, go: (v: ViewId) => void): HTMLElement | null {
  const e = data.energy;
  if (!e) return null;
  // Only readings typed in by hand: there's no supplier tariff to price them with.
  if (data.meter_account === false && data.costs !== "priced") return null;
  const sec = h("section", { class: "house-sec", "aria-labelledby": "house-cost" }, h("h2", { class: "life-section-title", id: "house-cost" }, "Cost and tariff"));
  if (data.costs !== "priced") {
    const open = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Open Settings");
    open.addEventListener("click", () => go("settings"));
    sec.append(
      h(
        "div",
        { class: "house-card house-note" },
        h("p", { class: "house-card__take" }, data.costs === "waiting" ? "Your account number is saved. Costs show here after the next Life log run reads your tariff." : "Showing kWh only. To see costs, add your energy account number to your meters under Settings → Sources → Edit."),
        data.costs === "waiting" ? null : open
      )
    );
    return sec;
  }
  const rows: HTMLElement[] = [];
  for (const fuel of e.fuels) {
    const r = e.rates[fuel];
    if (!r) continue;
    rows.push(
      h(
        "li",
        { class: "house-rate" },
        h("span", { class: "house-rate__name" }, h("i", { class: `house-legend__swatch ${SERIES[fuel].cls}`, "aria-hidden": "true" }), SERIES[fuel].name, r.time_of_use ? h("span", { class: "house-rate__tag" }, "Time of use") : null),
        h("span", { class: "house-rate__unit" }, r.time_of_use && r.low_p !== undefined && r.high_p !== undefined ? `${unitPrice(r.low_p)} to ${unitPrice(r.high_p)} per kWh, ${unitPrice(r.unit_p)} now` : `${unitPrice(r.unit_p)} per kWh`),
        h("span", { class: "house-rate__standing" }, `${unitPrice(r.standing_p)} a day standing charge`)
      )
    );
  }
  const months = e.months.slice(-2).reverse();
  const monthRows = months.map((m) => {
    const parts = e.fuels.map((f) => m[f]?.cost_p).filter((v): v is number => v !== undefined);
    const total = parts.reduce((s, v) => s + v, 0);
    return h(
      "li",
      { class: "house-month" },
      h("span", { class: "house-month__name" }, `${monthLong(m.month)}${m.month === data.today.slice(0, 7) ? " so far" : ""}`),
      h("span", { class: "house-month__split" }, e.fuels.map((f) => (m[f]?.cost_p !== undefined ? `${SERIES[f].name.toLowerCase()} ${pence(m[f]!.cost_p!)}` : "")).filter(Boolean).join(" · ")),
      h("span", { class: "house-month__total" }, parts.length ? pence(total) : "–")
    );
  });
  sec.append(
    h("div", { class: "house-card" }, h("h3", { class: "house-card__title" }, "Your prices today"), h("ul", { class: "house-rates", role: "list" }, ...rows), monthRows.length ? h("h3", { class: "house-card__title house-card__title--next" }, "By month, with standing charges") : null, monthRows.length ? h("ul", { class: "house-months", role: "list" }, ...monthRows) : null)
  );
  return sec;
}

// ---------- Household bills ----------

const CADENCE: Record<HouseBill["cadence"], string> = { weekly: "Every week", monthly: "Every month", yearly: "Every year" };

function billsSection(data: House, go: (v: ViewId) => void): HTMLElement {
  const b = data.bills;
  const sec = h(
    "section",
    { class: "house-sec", "aria-labelledby": "house-bills" },
    h("div", { class: "regular__head" }, h("h2", { class: "life-section-title", id: "house-bills" }, "Household bills"), b.monthly ? h("p", { class: "regular__total" }, h("span", { class: "regular__amount" }, exactMoney(Math.round(b.monthly.amount / 100) * 100, b.monthly.currency)), h("span", { class: "regular__per" }, "a month")) : null)
  );
  if (!b.bank) {
    const open = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plug(), "Connect a bank");
    open.addEventListener("click", () => go("settings"));
    sec.append(h("div", { class: "life-empty" }, h("p", { class: "life-empty__title" }, "No banking source yet"), h("p", { class: "life-empty__text" }, "Connect a bank and add it to your Life log. Rent, council tax, energy, water and the rest show here once each has been paid a couple of times."), open));
    return sec;
  }
  if (!b.items.length) {
    sec.append(h("p", { class: "life-section-sub" }, "No household bills spotted yet. Each one shows here once it has gone out a couple of times."));
    return sec;
  }
  sec.append(
    h("p", { class: "life-section-sub" }, "Spotted in your direct debits and card payments."),
    h(
      "ul",
      { class: "house-card house-bills", role: "list" },
      ...b.items.map((x) =>
        h(
          "li",
          { class: `house-bill${x.missed ? " is-missed" : ""}` },
          h("span", { class: "house-bill__words" }, h("span", { class: "house-bill__name" }, x.name), h("span", { class: "house-bill__meta" }, `${BILL_WORDS[x.type]} · ${CADENCE[x.cadence]} · ${x.missed ? `was due ${shortDate(x.missed.due_on)}` : `last paid ${shortDate(x.last_on)}`}`)),
          h("span", { class: "house-bill__amount" }, exactMoney(x.last_amount, x.currency), x.cadence !== "monthly" ? h("span", { class: "house-bill__per" }, `${exactMoney(x.monthly, x.currency)} a month`) : null)
        )
      )
    )
  );
  return sec;
}

// ---------- Appliances ----------

/** "today at 14:30", "yesterday at 21:05", "Sat 8 Nov". */
function whenEnded(iso: string, today: string): string {
  const d = new Date(iso);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = clockTime(d);
  const gap = daysBetween(day, today);
  return gap === 0 ? `today at ${time}` : gap === 1 ? `yesterday at ${time}` : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/** What each appliance is doing, as of Athena's last look, and the last programme it finished. Null when no appliance account is connected. */
function appliancesSection(data: House): HTMLElement | null {
  const list = data.appliances;
  if (!list?.length) return null;
  const seen = list.map((a) => a.seen).sort().pop()!;
  return h(
    "section",
    { class: "house-sec", "aria-labelledby": "house-appliances" },
    h("div", { class: "regular__head" }, h("h2", { class: "life-section-title", id: "house-appliances" }, "Appliances")),
    h("p", { class: "life-section-sub" }, `As of ${whenEnded(seen, data.today)}. Athena looks every 15 minutes and never starts or stops anything.`),
    h(
      "ul",
      { class: "house-card house-bills house-appliances", role: "list" },
      ...list.map((a) =>
        h(
          "li",
          { class: `house-bill house-appliance${a.running ? " is-running" : ""}` },
          h(
            "span",
            { class: "house-bill__words" },
            h("span", { class: "house-bill__name" }, a.name),
            h("span", { class: "house-bill__meta" }, a.last ? `Last ran ${a.last.program ? `${a.last.program}, ` : ""}${durationWords(a.last.minutes)}, ${whenEnded(a.last.ended, data.today)}` : [a.name === a.what ? "" : a.what, a.brand].filter(Boolean).join(" · ") || "Nothing seen running yet")
          ),
          h("span", { class: "house-appliance__now" }, a.running ? h("span", { class: "house-appliance__dot", "aria-hidden": "true" }) : null, a.now)
        )
      )
    )
  );
}

// ---------- House admin ----------

function adminSection(items: Asset[], go: (v: ViewId) => void): HTMLElement {
  const today = localToday();
  const mine = houseAdmin(items);
  const all = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Life admin", icons.chevronRight());
  all.addEventListener("click", () => go("admin"));
  const sec = h("section", { class: "house-sec", "aria-labelledby": "house-admin" }, h("div", { class: "regular__head" }, h("h2", { class: "life-section-title", id: "house-admin" }, "House admin"), all));
  const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Add one");
  add.addEventListener("click", () => void import("./admin").then(({ openAssetSheet }) => openAssetSheet(null)));
  if (!mine.length) {
    sec.append(h("div", { class: "life-empty" }, h("p", { class: "life-empty__title" }, "Nothing about the house yet"), h("p", { class: "life-empty__text" }, "Add the boiler service, the gas safety check, home insurance or an appliance guarantee to Life admin, and it shows here with its date."), add));
    return sec;
  }
  sec.append(
    h(
      "div",
      { class: "card card--flush list" },
      ...mine.map((a) => {
        const n = a.renews_on ? daysBetween(today, a.renews_on) : null;
        const tone = n === null ? undefined : n < 0 ? "late" : n <= 30 ? "soon" : undefined;
        const b = h(
          "button",
          { class: "row", type: "button" },
          h("span", { class: "tile tile--sm" }, icons[ASSET_META[a.kind].icon]()),
          h("span", { class: "row__body" }, h("span", { class: "row__title-line" }, h("span", { class: "row__title" }, a.name)), h("span", { class: "row__meta" }, [a.provider.toLowerCase() === a.name.toLowerCase() ? "" : a.provider, a.renews_on ? shortDate(a.renews_on) : "No date"].filter(Boolean).join(" · "))),
          n !== null ? h("span", { class: "row__time renewal", "data-tone": tone }, renewalLabel(a.kind, n)) : h("span", {})
        );
        b.addEventListener("click", () => void import("./admin").then(({ openAssetSheet }) => openAssetSheet(a)));
        return b;
      })
    )
  );
  return sec;
}

// ---------- The page ----------

function lede(data: House): string {
  const e = data.energy;
  const bills = data.bills.monthly;
  const parts: string[] = [];
  const last = e?.daily[e.daily.length - 1];
  if (last?.cost) parts.push(`Energy came to ${pence((last.cost.electricity?.total_p ?? 0) + (last.cost.gas?.total_p ?? 0))} on ${noon(last.date).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}.`);
  else if (last && (last.kwh !== undefined || last.gas_kwh !== undefined)) parts.push(`${[last.kwh !== undefined ? `${kwh(last.kwh)} of electricity` : "", last.gas_kwh !== undefined ? `${kwh(last.gas_kwh)} of gas` : ""].filter(Boolean).join(" and ")} on ${noon(last.date).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}.`);
  if (bills && data.bills.items.length) parts.push(`Household bills come to about ${exactMoney(Math.round(bills.amount / 100) * 100, bills.currency)} a month.`);
  return parts.join(" ") || "Your home's energy, what it costs, the bills and the jobs that come round each year.";
}

export function renderHouse(ctx: { go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  const body = h("div", { class: "life-page house", "aria-busy": "true" });
  const ledeEl = h("p", { class: "life-page__lede" });
  const el = h("div", { class: "view lists house-view" }, pageHead({ segments: librarySegments("house", ctx.go), title: "House" }), body);
  let dead = false;
  let data: House | null = null;
  let assets: Asset[] = [];
  let adminEl: HTMLElement | null = null;
  const paintAdmin = () => {
    if (dead || !data) return;
    const next = adminSection(assets, ctx.go);
    adminEl?.replaceWith(next);
    adminEl = next;
  };
  const paint = () => {
    if (dead || !data) return;
    body.removeAttribute("aria-busy");
    ledeEl.textContent = lede(data);
    adminEl = adminSection(assets, ctx.go);
    body.replaceChildren(...[ledeEl, energySection(data, ctx.go, () => void reload()), costSection(data, ctx.go), billsSection(data, ctx.go), appliancesSection(data), adminEl].filter((x): x is HTMLElement => !!x));
  };
  // After a reading is added or taken out: the page again, from the server.
  const reload = () =>
    loadHouse().then(
      (d) => {
        data = d;
        paint();
      },
      () => showToast("House didn't reload. Check you're online")
    );
  Promise.all([loadHouse(), loadAssets().then((r) => r.items, () => [] as Asset[])]).then(
    ([d, a]) => {
      data = d;
      assets = a;
      paint();
    },
    () => {
      if (dead) return;
      body.removeAttribute("aria-busy");
      body.replaceChildren(h("div", { class: "life-empty" }, h("p", { class: "life-empty__title" }, "House didn't load"), h("p", { class: "life-empty__text" }, "Check you're online, then come back to this page.")));
    }
  );
  const unsub = onMemoryChange((t) => {
    if (t !== "asset" && t !== "all") return;
    void loadAssets().then((r) => {
      assets = r.items;
      paintAdmin();
    });
  });
  return {
    el,
    destroy: () => {
      dead = true;
      unsub();
    },
  };
}
