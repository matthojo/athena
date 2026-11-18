/**
 * Sync status in two shapes: a circular header button with a popover menu
 * (mobile/tablet Home) and a card at the foot of the desktop sidebar. Both
 * read the same SyncStatus store from db/data.ts and offer the same actions,
 * and both carry one line about encryption at rest when there's something
 * to say: it's on, it's still sealing existing data, or this is a preview
 * copy that can't read it.
 */

import "../styles/sources.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { plural, relativeTime } from "../lib/format";
import type { SyncStatus } from "../db/data";
import type { ViewId } from "./nav";

// ---------- Sources' health, shared with Settings ----------

export type HealthTone = "none" | "good" | "running" | "warn";

export interface SourcesStatus {
  tone: HealthTone;
  /** "2 things need you", "All working". */
  line: string;
  /** For the Settings row: "2 need you", "All working". */
  short: string;
  count: number;
  /** Who needs you ("Personal Gmail", "Outlook"). Memory only. */
  names: string[];
  /** When it was true. */
  at: number;
  /** False when it came from the device, not the server just now. */
  live: boolean;
}

const HEALTH_KEY = "athena.sources.health";
const healthListeners = new Set<(s: SourcesStatus | null) => void>();
let health: SourcesStatus | null = readHealth();

function readHealth(): SourcesStatus | null {
  try {
    const raw = localStorage.getItem(HEALTH_KEY);
    const s = raw ? (JSON.parse(raw) as Partial<SourcesStatus>) : null;
    if (!s || typeof s.line !== "string" || typeof s.at !== "number") return null;
    return { tone: s.tone ?? "good", line: s.line, short: s.short ?? s.line, count: s.count ?? 0, names: [], at: s.at, live: false };
  } catch {
    return null;
  }
}

export function sourcesStatus(): SourcesStatus | null {
  return health;
}

export function onSourcesStatus(fn: (s: SourcesStatus | null) => void): () => void {
  healthListeners.add(fn);
  return () => healthListeners.delete(fn);
}

/** lib/sources-health.ts's publishSources() calls this with each state the server sends. */
export function setSourcesStatus(s: Omit<SourcesStatus, "at" | "live">): void {
  health = { ...s, at: Date.now(), live: true };
  try {
    localStorage.setItem(HEALTH_KEY, JSON.stringify({ tone: s.tone, line: s.line, short: s.short, count: s.count, at: health.at }));
  } catch {
    /* private browsing: memory only */
  }
  for (const fn of healthListeners) fn(health);
}

/** Offline, or the server didn't answer: what's known stops being current. */
export function markSourcesStale(): void {
  if (!health?.live) return;
  health = { ...health, live: false };
  for (const fn of healthListeners) fn(health);
}

/** "09:40", or "Tue 09:40" when it wasn't today. */
export function healthTime(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return new Date().toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

const SOURCES_HASH = "#/settings/sources";

/** The "needs you" words for the card and menu, or null when nothing does. */
function needsYou(): { title: string; sub: string; stale: boolean } | null {
  if (!health || health.count < 1) return null;
  const stale = !health.live;
  const names = health.names.length > 2 ? `${health.names.slice(0, 2).join(", ")} and ${health.names.length - 2} more` : health.names.join(", ");
  return {
    title: stale ? `${health.line} at ${healthTime(health.at)}` : health.line,
    sub: stale ? "Last known. Sources need a connection." : names,
    stale,
  };
}

export function describeEncryption(s: SyncStatus): string | null {
  switch (s.encryption?.state) {
    case "on":
      return "Your data is encrypted at rest";
    case "encrypting":
      return `Encrypting your data · ${s.encryption.remaining.toLocaleString("en-GB")} ${plural(s.encryption.remaining, "item", "items")} to go`;
    case "locked":
      return "Preview copy: your data stays encrypted here";
    default:
      return null;
  }
}

export interface StatusActions {
  syncNow: () => void;
  signOut: () => void;
  connect: () => void;
  /** Mobile reaches Settings from the status menu too (Archived and Reminders have homes in Library and Settings). */
  open?: (view: ViewId) => void;
}

export function describeStatus(s: SyncStatus): { title: string; sub: string } {
  const waiting = s.pending ? `${s.pending} ${plural(s.pending, "note", "notes")} waiting to sync` : "";
  switch (s.state) {
    case "syncing":
      return { title: "Syncing…", sub: "Sending your latest notes" };
    case "sample":
      return { title: "Sample data", sub: "Connect to see your own notes" };
    case "offline":
      return { title: "Offline", sub: waiting || "Showing notes saved on this device" };
    default:
      return { title: "Synced", sub: waiting || (s.lastSyncAt ? `Last synced ${relativeTime(s.lastSyncAt)}` : "Up to date") };
  }
}

type Popover = HTMLElement & { hidePopover?: () => void };

export function statusButton(actions: StatusActions): { el: HTMLElement; update: (s: SyncStatus) => void } {
  const dot = h("span", { class: "status-dot" });
  const button = h(
    "button",
    { class: "icon-btn status-btn", type: "button", popovertarget: "status-menu", "aria-label": "Sync status" },
    icons.cloud(),
    dot
  );
  const menu = h("div", { class: "menu", id: "status-menu", popover: "auto" }) as Popover;

  const item = (icon: keyof typeof icons, label: string, run: () => void) => {
    const b = h("button", { class: "menu__item", type: "button" }, icons[icon](), label);
    b.addEventListener("click", () => {
      menu.hidePopover?.();
      run();
    });
    return b;
  };

  let last: SyncStatus | null = null;
  onSourcesStatus(() => last && update(last));

  function update(s: SyncStatus) {
    last = s;
    const { title, sub } = describeStatus(s);
    const encryption = describeEncryption(s);
    const needs = s.state === "sample" ? null : needsYou();
    dot.dataset.state = needs && !needs.stale ? "attention" : s.state;
    button.setAttribute("aria-label", `Sync status: ${title}`);
    menu.replaceChildren(
      h("div", { class: "menu__status" }, h("span", { class: "status-dot", "data-state": s.state }), title),
      h("div", { class: "menu__sub" }, sub),
      ...(encryption ? [h("div", { class: "menu__note" }, icons.shield(), encryption)] : []),
      h("div", { class: "menu__sep" }),
      ...(needs ? [sourcesItem(needs), h("div", { class: "menu__sep" })] : []),
      ...(actions.open
        ? [
            item("sliders", "Settings", () => actions.open!("settings")),
            h("div", { class: "menu__sep" }),
          ]
        : []),
      ...(s.state === "sample"
        ? [item("plug", "Connect Athena", actions.connect)]
        : [item("refresh", "Sync now", actions.syncNow), item("logout", "Sign out", actions.signOut)])
    );
  }

  /** "2 things need you", who, and a way to Sources: one button. */
  function sourcesItem(n: { title: string; sub: string; stale: boolean }): HTMLElement {
    const b = h(
      "button",
      { class: `menu__item menu__needs${n.stale ? " is-stale" : ""}`, type: "button", "aria-label": `${n.title}. ${n.sub}. Open Sources` },
      h("span", { class: "status-dot", "data-state": n.stale ? "stale" : "attention", "aria-hidden": "true" }),
      h("span", { class: "menu__needs-body" }, h("span", { class: "menu__needs-title" }, n.title), n.sub ? h("span", { class: "menu__needs-sub" }, n.sub) : null, h("span", { class: "menu__needs-link" }, "Open Sources"))
    );
    b.addEventListener("click", () => {
      menu.hidePopover?.();
      location.hash = SOURCES_HASH;
    });
    return b;
  }

  return { el: h("div", { class: "topbar__actions" }, button, menu), update };
}

export function statusCard(actions: StatusActions): { el: HTMLElement; update: (s: SyncStatus) => void } {
  const el = h("section", { class: "status-card", "aria-label": "Sync status" });
  let last: SyncStatus | null = null;
  onSourcesStatus(() => last && update(last));

  function update(s: SyncStatus) {
    last = s;
    const needs = s.state === "sample" ? null : needsYou();
    const { title, sub } = describeStatus(s);
    const encryption = describeEncryption(s);
    const btn = (cls: string, icon: keyof typeof icons | null, label: string, run: () => void) => {
      const b = h("button", { class: `btn btn--sm ${cls}`, type: "button" }, icon ? icons[icon]() : null, label);
      b.addEventListener("click", run);
      return b;
    };
    const iconBtn = (icon: keyof typeof icons, label: string, run: () => void) => {
      const b = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": label, title: label }, icons[icon]());
      b.addEventListener("click", run);
      return b;
    };
    // One compact block, so the sidebar's Library keeps the room: the state and its
    // actions on one line, what it means on the next.
    el.replaceChildren(
      h(
        "div",
        { class: "status-card__head" },
        h("span", { class: "status-dot", "data-state": s.state }),
        h("span", { class: "status-card__title" }, title),
        h(
          "span",
          { class: "status-card__actions" },
          ...(s.state === "sample"
            ? [btn("btn--primary", null, "Connect", actions.connect)]
            : [iconBtn("refresh", "Sync now", actions.syncNow), iconBtn("logout", "Sign out", actions.signOut)])
        )
      ),
      h("p", { class: "status-card__sub", title: sub }, sub),
      ...(encryption ? [h("p", { class: "status-card__note", title: encryption }, icons.shield(), encryption)] : []),
      ...(needs
        ? [
            h(
              "a",
              { class: `status-card__needs${needs.stale ? " is-stale" : ""}`, href: SOURCES_HASH, "aria-label": `${needs.title}. ${needs.sub}. Open Sources` },
              h("span", { class: "status-card__needs-head" }, h("span", { class: "status-dot", "data-state": needs.stale ? "stale" : "attention", "aria-hidden": "true" }), needs.title),
              needs.sub ? h("span", { class: "status-card__needs-sub" }, needs.sub) : null,
              h("span", { class: "status-card__needs-link" }, "Open Sources")
            ),
          ]
        : [])
    );
  }

  return { el, update };
}
