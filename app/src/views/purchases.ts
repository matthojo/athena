/**
 * Purchases: orders from your email and where each delivery has got to.
 * What's on its way comes first, today's deliveries at the top; delivered,
 * returned and refunded orders fold away below and are archived 30 days on.
 * A purchase opens to a tracker (ordered, dispatched, out for delivery,
 * delivered), its updates, and links to track it or open the email. Never a
 * price: Athena doesn't keep them. Same shape as Trips; main.ts loads this
 * module on first visit.
 *
 * You can add your own (New) and edit any of it, tracking included: with a
 * carrier and number, Track opens the carrier's page (lib/carriers.ts).
 *
 * Built only with h() and text nodes: every value here came out of an email,
 * or was typed by you.
 */

import "../styles/trips.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { openSheet } from "../components/sheet";
import { showToast } from "../components/toast";
import { confirmDialog } from "../components/confirm";
import { deleteLogisticsForever, findPurchase, loadPurchases, onLogisticsChange, setLogisticsArchived, setPurchaseStatus } from "../db/trips";
import { relativeTime, shortDate } from "../lib/format";
import { sourceText } from "../lib/sources";
import { deviceZone, localToday } from "../lib/time";
import { PURCHASE_ICON, TRACK_STEPS, safeLink, shortWeekday, trackIndex } from "../lib/trips-meta";
import { PURCHASE_LABEL, dayWord, deliveryState, isSettled, purchaseName, type DeliveryState } from "../../../lib/trip-text";
import { daysBetween, zonedParts } from "../../../lib/dates";
import { trackingLink } from "../../../lib/carriers";
import { openPurchaseForm } from "./trip-forms";
import type { Purchase } from "../types";
import type { ViewId } from "../components/nav";
import { pageHead } from "../components/page-head";
import { clockOfDay } from "../lib/clock";

/** The item(s), without the shop: "Kindle Paperwhite", "KALLAX shelf unit and 1 more". */
function itemsTitle(p: Purchase): string {
  const items = p.items.filter(Boolean);
  if (!items.length) return `Order from ${p.retailer}`;
  return items.length > 1 ? `${items[0]} and ${items.length - 1} more` : items[0];
}

/** "Today 07:05", "Yesterday 16:40", "Mon 3 Nov, 20:14". */
function when(iso: string, today: string): string {
  const p = zonedParts(new Date(iso), deviceZone());
  const n = daysBetween(p.date, today);
  const day = n === 0 ? "Today" : n === 1 ? "Yesterday" : shortWeekday(p.date);
  return `${day}${n > 1 ? "," : ""} ${clockOfDay(p.time)}`;
}

/** A tracker step's time, kept short: "Today 07:05", "Yesterday 16:40", "Tue 3 Nov". */
function stepWhen(iso: string, today: string): string {
  const p = zonedParts(new Date(iso), deviceZone());
  const n = daysBetween(p.date, today);
  return n === 0 ? `Today ${clockOfDay(p.time)}` : n === 1 ? `Yesterday ${clockOfDay(p.time)}` : shortWeekday(p.date);
}

/** "Due today", "Due tomorrow", "Due Monday", "Due 14 Nov", "Was due Tuesday". */
function dueWhen(date: string, today: string): string {
  const n = daysBetween(today, date);
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  return n < 0 ? `Was due ${dayWord(date, today)}` : `Due ${dayWord(date, today)}`;
}

const toneClass = (s: DeliveryState) => (s.tone === "today" ? " row__time--accent" : s.tone === "late" ? " row__time--warn" : "");

/** A slim four-step bar: how far along it is. */
function trackBar(p: Purchase): HTMLElement | null {
  const at = trackIndex(p.status);
  if (at < 0) return null;
  return h(
    "span",
    { class: "track", "data-status": p.status, role: "img", "aria-label": `${PURCHASE_LABEL[p.status]}: step ${at + 1} of 4` },
    ...TRACK_STEPS.map((_, i) => h("span", { class: "track__step", "data-done": i <= at ? "" : undefined }))
  );
}

function fact(icon: IconName, title: string, detail: string, tone?: "accent" | "warn"): HTMLElement {
  return h(
    "div",
    { class: `fact${tone ? ` fact--${tone}` : ""}` },
    h("span", { class: "fact__icon" }, icons[icon]()),
    h("span", { class: "fact__body" }, h("span", { class: "fact__title" }, title), detail ? h("span", { class: "fact__detail" }, detail) : null)
  );
}

function readOnly(label: string, value: HTMLElement | string): HTMLElement {
  return h("div", { class: "prop" }, h("span", { class: "prop__label" }, label), h("span", { class: "prop__control prop__value" }, value));
}

// ---------- a purchase ----------

export interface PurchaseDetail {
  el: HTMLElement;
  purchaseId: () => string;
  destroy: () => void;
}

export function purchaseDetail(initial: Purchase, ctx: { close: () => void }): PurchaseDetail {
  let p = initial;
  let dead = false;
  const uid = Math.random().toString(36).slice(2);

  const menuId = `purchase-menu-${uid}`;
  const more = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "More actions", popovertarget: menuId }, icons.more()) as HTMLButtonElement;
  const menu = h("div", { class: "menu note-menu", id: menuId, popover: "auto" }) as HTMLElement & { hidePopover?: () => void };
  const item = (icon: IconName, label: string, run: () => void, cls = "") => {
    const b = h("button", { class: `menu__item ${cls}`, type: "button" }, icons[icon](), label);
    b.addEventListener("click", () => {
      menu.hidePopover?.();
      run();
    });
    return b;
  };
  menu.replaceChildren(
    item("pen", "Edit order", () => openPurchaseForm(p)),
    item("archive", "Archive", () => void archive()),
    h("div", { class: "menu__sep" }),
    item("trash", "Delete permanently", () => void remove(), "menu__item--danger")
  );
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const r = more.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 120)}px`;
    menu.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  });

  async function archive() {
    const { id } = p;
    try {
      await setLogisticsArchived("purchase", id, true);
      dead = true;
      ctx.close();
      showToast("Purchase archived", { icon: "archive", action: { label: "Undo", run: () => void setLogisticsArchived("purchase", id, false) } });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't archive", { icon: "wifiOff" });
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Delete ${itemsTitle(p)} permanently?`,
      body: "This order and its delivery updates are removed from Athena. Your emails aren't touched. This can't be undone.",
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteLogisticsForever("purchase", p.id);
      dead = true;
      ctx.close();
      showToast("Deleted permanently", { icon: "trash" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't delete", { icon: "wifiOff" });
    }
  }

  async function arrived() {
    try {
      p = await setPurchaseStatus(p.id, "delivered");
      paint();
      showToast("Marked as delivered", { icon: "check" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff" });
    }
  }

  const title = h("h2", { class: "note__title-input profile__name purchase__title" });
  const sub = h("p", { class: "profile__sub" });
  const facts = h("div", { class: "profile__facts" });
  const tracker = h("ol", { class: "tracker" });
  const actions = h("div", { class: "profile__actions", role: "group", "aria-label": "Quick actions" });
  const updates = h("div", { class: "card card--flush list" });
  const fields = h("div", { class: "card card--flush fields" });
  const foot = h("footer", { class: "note__foot" });

  function action(icon: IconName, label: string, run: string | (() => void)): HTMLElement {
    const inner = [h("span", { class: "profile__action-icon" }, icons[icon]()), h("span", { class: "profile__action-label" }, label)];
    if (typeof run === "string") return h("a", { class: "profile__action", href: run, target: "_blank", rel: "noopener noreferrer" }, ...inner);
    const b = h("button", { class: "profile__action", type: "button" }, ...inner);
    b.addEventListener("click", run);
    return b;
  }

  function paint() {
    if (dead) return;
    const today = localToday();
    const state = deliveryState(p, today, deviceZone());
    title.textContent = itemsTitle(p);
    sub.replaceChildren(
      ...[p.retailer, p.order_number ? `Order ${p.order_number}` : ""].filter(Boolean).flatMap((x, i) => (i ? [h("span", { class: "profile__dot", "aria-hidden": "true" }, "·"), x] : [x]))
    );

    // Ordering comes first, even when you added the order after its delivery emails had arrived.
    const steps = [...p.updates].sort((a, b) => Number(b.status === "ordered") - Number(a.status === "ordered") || a.at.localeCompare(b.at));
    // Your "Ordered" step is dated by the day you ordered, not the minute you typed it in.
    const whenOf = (u: Purchase["updates"][number], fmt: (at: string, today: string) => string) =>
      u.status === "ordered" && p.ordered_on && / by you$/.test(u.detail) ? shortWeekday(p.ordered_on) : fmt(u.at, today);
    // Where it's got to, in a line.
    const latest = steps[steps.length - 1];
    // Your own steps ("Added by you") say nothing new here: the carrier does.
    const said = latest?.status === p.status && !/ by you$/.test(latest.detail) ? latest.detail : "";
    const carrierName = p.carrier || trackingLink(p)?.carrier || "";
    const detail = said || [carrierName, p.tracking_number].filter(Boolean).join(" · ");
    const tone = state.tone === "today" ? "accent" : state.tone === "late" ? "warn" : undefined;
    const unconfirmed = state.label === "Did it arrive?";
    facts.replaceChildren(fact(PURCHASE_ICON[p.status], state.label, unconfirmed ? "No delivery email yet. Mark it delivered when it's here." : detail, tone));

    // The tracker: four steps, each with when it happened.
    const at = trackIndex(p.status);
    tracker.hidden = at < 0;
    tracker.replaceChildren(
      ...TRACK_STEPS.map((step, i) => {
        const hit = [...steps].reverse().find((u) => (step.status === "dispatched" ? u.status === "dispatched" || u.status === "delayed" : u.status === step.status));
        const done = i <= at;
        const current = i === at;
        const late = current && p.status === "delayed";
        const sub2 = hit ? whenOf(hit, stepWhen) : i === 3 && p.expected_on && !done ? dueWhen(p.expected_on, today) : "";
        return h(
          "li",
          { class: "tracker__step", "data-done": done ? "" : undefined, "data-current": current ? "" : undefined, "data-late": late ? "" : undefined, "aria-current": current ? "step" : undefined },
          h("span", { class: "tracker__dot", "aria-hidden": "true" }, late ? icons.hourglass() : done ? icons.check() : null),
          h("span", { class: "tracker__label" }, current && p.status === "delayed" ? "Delayed" : step.label),
          sub2 ? h("span", { class: "tracker__when" }, sub2) : null
        );
      })
    );

    const track = trackingLink(p);
    // A cancelled order's Email opens the email that cancelled it.
    const email = safeLink((p.status === "cancelled" && latest?.status === "cancelled" && latest.email_link) || p.email_link);
    const trackAction = track ? action("truck", "Track", track.url) : null;
    if (trackAction) trackAction.setAttribute("aria-label", track!.carrier ? `Track with ${track!.carrier}` : "Track this parcel");
    actions.replaceChildren(
      ...(trackAction ? [trackAction] : !isSettled(p.status) ? [action("truck", "Add tracking", () => openPurchaseForm(p, { focus: "tracking" }))] : []),
      ...(email ? [action("mail", "Email", email)] : []),
      ...(!isSettled(p.status) ? [action("check", "It arrived", () => void arrived())] : []),
      ...(p.order_number
        ? [
            action("copy", "Order no.", () => {
              void navigator.clipboard
                .writeText(p.order_number)
                .then(() => showToast("Order number copied", { icon: "copy" }))
                .catch(() => showToast("Couldn't copy the order number", { icon: "copy" }));
            }),
          ]
        : [])
    );
    actions.hidden = !actions.childElementCount;

    updates.replaceChildren(
      ...[...steps].reverse().map((u) => {
        const link = safeLink(u.email_link);
        return h(
          "div",
          { class: "row row--static update-row", role: "group", "aria-label": `${PURCHASE_LABEL[u.status]}, ${whenOf(u, when)}` },
          h("span", { class: "tile tile--sm", "data-status": u.status }, icons[PURCHASE_ICON[u.status]]()),
          h(
            "span",
            { class: "row__body" },
            h("span", { class: "row__title-line" }, h("span", { class: "row__title" }, PURCHASE_LABEL[u.status])),
            u.detail ? h("span", { class: "row__snippet" }, u.detail) : null,
            h("span", { class: "row__meta" }, whenOf(u, when))
          ),
          link ? h("a", { class: "icon-btn icon-btn--sm icon-btn--ghost", href: link, target: "_blank", rel: "noopener noreferrer", "aria-label": "Open the email" }, icons.mail()) : h("span", {})
        );
      })
    );

    const rows: HTMLElement[] = [readOnly("Shop", p.retailer)];
    if (p.items.length > 1) rows.push(readOnly("Items", h("span", { class: "prop__list" }, ...p.items.map((i) => h("span", {}, i)))));
    if (p.order_number) rows.push(readOnly("Order", p.order_number));
    if (p.ordered_on) rows.push(readOnly("Ordered", shortWeekday(p.ordered_on)));
    if (p.carrier || track?.carrier) rows.push(readOnly("Carrier", p.carrier || track!.carrier));
    if (p.tracking_number) {
      const copy = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Copy tracking number ${p.tracking_number}` }, icons.copy());
      copy.addEventListener("click", () =>
        void navigator.clipboard
          .writeText(p.tracking_number)
          .then(() => showToast("Tracking number copied", { icon: "copy" }))
          .catch(() => showToast("Couldn't copy the tracking number", { icon: "copy" }))
      );
      rows.push(readOnly("Tracking", h("span", { class: "prop__copy" }, h("span", { class: "prop__mono" }, p.tracking_number), copy)));
    }
    if (!isSettled(p.status) && !p.tracking_number && !track) {
      const add = h("button", { class: "link-btn", type: "button" }, icons.plus(), "Add tracking");
      add.addEventListener("click", () => openPurchaseForm(p, { focus: "tracking" }));
      rows.push(readOnly("Tracking", add));
    }
    fields.replaceChildren(...rows);
    foot.textContent = [p.source === "manual" ? "Added by you" : p.source ? `From ${sourceText(p.source)}` : "", `Updated ${relativeTime(p.updated_at)}`, "Prices aren't kept"].filter(Boolean).join(" · ");
  }

  const el = h(
    "article",
    { class: "note profile purchase-detail" },
    h(
      "header",
      { class: "profile__hero" },
      h("div", { class: "profile__top" }, h("span", { class: "tile tile--hero", "aria-hidden": "true" }, icons.parcel()), h("span", { class: "note__bar-spacer" }), more, menu),
      title,
      sub
    ),
    facts,
    tracker,
    actions,
    h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Updates"), updates),
    h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Details"), fields),
    foot
  );
  paint();

  const unsub = onLogisticsChange(async (topic) => {
    if (dead || topic === "trip") return;
    const fresh = await findPurchase(p.id);
    if (!fresh) return;
    p = fresh;
    paint();
  });

  return {
    el,
    purchaseId: () => p.id,
    destroy() {
      dead = true;
      unsub();
    },
  };
}

export async function openPurchaseSheet(purchaseOrId: Purchase | string): Promise<void> {
  const p = typeof purchaseOrId === "string" ? await findPurchase(purchaseOrId) : purchaseOrId;
  if (!p) {
    showToast("That purchase isn't available. It may be archived", { icon: "archive" });
    return;
  }
  let view: PurchaseDetail | null = null;
  const sheet = openSheet({ label: purchaseName(p), body: h("div", {}), variant: "tall", onClose: () => view?.destroy() });
  view = purchaseDetail(p, { close: () => sheet.close() });
  sheet.dialog.querySelector(".sheet__scroll")!.replaceChildren(view.el);
}

// ---------- the page ----------

export interface PurchasesContext {
  purchaseId: string | null;
  isDesktop: () => boolean;
  go: (view: ViewId) => void;
  onSelectionChange: (id: string | null) => void;
}

export function renderPurchases(ctx: PurchasesContext): { el: HTMLElement; destroy: () => void } {
  let items: Purchase[] = [];
  let loaded = false;
  let selectedId = ctx.purchaseId;
  let pendingSheet = !ctx.isDesktop() ? ctx.purchaseId : null;

  const count = h("span", { class: "page-count" });
  const newBtn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "New");
  const addOrder = () => openPurchaseForm(null, { onCreated: (p) => open(p) });
  newBtn.addEventListener("click", addOrder);
  const head = pageHead({
    segments: librarySegments("purchases", ctx.go),
    title: "Purchases",
    count,
    actions: [newBtn],
    lede: "Your orders and where each delivery has got to. Add your own, or let order emails bring them in. Prices never show here.",
  });
  const list = h("div", { class: "notes__list" });
  const col = h("div", { class: "notes__col" }, head, list);
  const pane = h("section", { class: "notes__pane", "aria-label": "Purchase" });
  const el = h("div", { class: "view notes records purchases" }, col, pane);

  let paneView: PurchaseDetail | null = null;
  const clearPane = () => {
    paneView?.destroy();
    paneView = null;
  };
  function showInPane(p: Purchase) {
    if (paneView?.purchaseId() === p.id) return;
    clearPane();
    paneView = purchaseDetail(p, {
      close: () => {
        clearPane();
        selectedId = null;
        ctx.onSelectionChange(null);
        paint();
      },
    });
    pane.replaceChildren(paneView.el);
    pane.scrollTop = 0;
  }

  function open(p: Purchase) {
    if (!ctx.isDesktop()) return void openPurchaseSheet(p);
    selectedId = p.id;
    ctx.onSelectionChange(p.id);
    showInPane(p);
    list.querySelectorAll<HTMLElement>(".row").forEach((r) => (r.dataset.id === p.id ? r.setAttribute("aria-current", "true") : r.removeAttribute("aria-current")));
  }

  function row(p: Purchase, today: string): HTMLElement {
    const state = deliveryState(p, today, deviceZone());
    const b = h(
      "button",
      { class: "row purchase-row", type: "button", "data-id": p.id, "data-tone": state.tone || undefined, "aria-current": p.id === selectedId ? "true" : undefined },
      h("span", { class: "tile tile--sm", "data-status": p.status }, icons[PURCHASE_ICON[p.status]]()),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title-line" }, h("span", { class: "row__title" }, itemsTitle(p))),
        h("span", { class: "row__meta" }, [p.retailer, p.carrier].filter(Boolean).join(" · ")),
        isSettled(p.status) ? null : trackBar(p)
      ),
      h("span", { class: `row__time${toneClass(state)}` }, state.label)
    );
    b.addEventListener("click", () => open(p));
    return b;
  }

  function paint() {
    if (!loaded) return;
    const today = localToday();
    const tz = deviceZone();
    const onTheWay = items
      .filter((p) => !isSettled(p.status))
      .map((p) => ({ p, s: deliveryState(p, today, tz) }))
      .sort((a, b) => {
        const rank = (x: DeliveryState) => (x.tone === "today" ? 0 : x.tone === "late" ? 1 : 2);
        return rank(a.s) - rank(b.s) || (a.s.days ?? 99) - (b.s.days ?? 99) || b.p.status_at.localeCompare(a.p.status_at);
      })
      .map((x) => x.p);
    const settled = items.filter((p) => isSettled(p.status)).sort((a, b) => b.status_at.localeCompare(a.status_at));
    count.textContent = onTheWay.length ? String(onTheWay.length) : "";

    if (!items.length) {
      const add = h("button", { class: "btn btn--primary", type: "button" }, icons.plus(), "Add an order");
      add.addEventListener("click", addOrder);
      const setup = h("button", { class: "btn btn--ghost", type: "button" }, icons.plug(), "Connect your email");
      setup.addEventListener("click", () => (location.hash = "#/settings/accounts"));
      list.replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("span", { class: "tile" }, icons.parcel()),
          h("p", { class: "empty__title" }, "No purchases yet"),
          h("p", { class: "empty__sub" }, "Add an order here, or tell Athena in Ask. Order emails show up here too once your email is connected."),
          h("div", { class: "empty__actions" }, add, setup)
        )
      );
    } else {
      // Something delivered in the last couple of days is still worth seeing without a tap.
      const recent = settled.some((p) => daysBetween(zonedParts(new Date(p.status_at), tz).date, today) <= 2);
      list.replaceChildren(
        onTheWay.length
          ? h("section", { class: "group" }, h("h2", { class: "group__label" }, "On the way", h("span", { class: "group__count" }, String(onTheWay.length))), h("div", { class: "card card--flush list" }, ...onTheWay.map((p) => row(p, today))))
          : h("div", { class: "empty empty--inline" }, h("p", { class: "empty__sub" }, "Nothing on its way. Add an order, or new order emails will show up here.")),
        ...(settled.length
          ? [
              h(
                "details",
                { class: "group group--done", open: recent ? true : undefined },
                h("summary", { class: "group__label" }, icons.chevronRight(), "Delivered", h("span", { class: "group__count" }, String(settled.length))),
                h("div", { class: "card card--flush list list--quiet" }, ...settled.map((p) => row(p, today))),
                h("p", { class: "group__hint" }, "Delivered orders move to Archived after 30 days.")
              ),
            ]
          : [])
      );
    }

    if (ctx.isDesktop()) {
      const current = items.find((p) => p.id === selectedId);
      if (current) showInPane(current);
      // Just added: an older reload may land before the one that has it.
      else if (selectedId && paneView?.purchaseId() === selectedId) {
        /* keep it */
      } else {
        clearPane();
        pane.replaceChildren(
          h(
            "div",
            { class: "pane-empty" },
            h(
              "div",
              { class: "empty" },
              h("span", { class: "tile" }, icons.parcel()),
              h("p", { class: "empty__title" }, items.length ? "Nothing selected" : "Your orders will appear here"),
              h("p", { class: "empty__sub" }, items.length ? "Pick an order on the left to see where it's got to." : "Each one shows where its delivery has got to, with a link to track it.")
            )
          )
        );
      }
    }
    if (pendingSheet) {
      const p = items.find((x) => x.id === pendingSheet);
      pendingSheet = null;
      ctx.onSelectionChange(null);
      if (p) void openPurchaseSheet(p);
    }
  }

  async function load() {
    const { items: loadedItems } = await loadPurchases();
    items = loadedItems;
    loaded = true;
    paint();
  }

  list.replaceChildren(
    h("div", { class: "card card--flush list" }, ...[0, 1, 2].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:50%" })), h("span", {}))))
  );
  void load();
  const unsub = onLogisticsChange((topic) => topic !== "trip" && void load());

  const onScroll = () => head.classList.toggle("is-scrolled", (ctx.isDesktop() ? col.scrollTop : window.scrollY) > 4);
  const target: EventTarget = ctx.isDesktop() ? col : window;
  target.addEventListener("scroll", onScroll, { passive: true });

  return {
    el,
    destroy: () => {
      unsub();
      clearPane();
      target.removeEventListener("scroll", onScroll);
    },
  };
}
