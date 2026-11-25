/**
 * Shared wording and small builders for the Sources screens
 * (components/connector-settings.ts, connector-detail.ts, connector-forms.ts
 * and voice-connection.ts). Health words live in lib/sources-health.ts;
 * collection words in lib/collection-words.ts.
 */

import { h } from "./dom";
import { icons, type IconName } from "../components/icons";
import { whenPhrase } from "./collection-words";
import { presetFor } from "../../../lib/connector-presets";
import type { Collection, Connector, RecipeId } from "../types";

export const RECIPE_ICON: Record<RecipeId, IconName> = {
  "calendar-meetings": "calendar",
  "calendar-sync": "week",
  "email-digest": "mail",
  "work-activity": "briefcase",
  "life-log": "play",
  "plays-watches": "loop",
  "work-sync": "work",
  home: "home",
  custom: "sparkle",
};

/** "Gmail" for a known service; for a custom server, the name it gives itself. */
export function serviceLabel(c: Pick<Connector, "provider" | "server_info">): string {
  if (c.provider !== "custom") return presetFor(c.provider).label;
  return c.server_info?.title || c.server_info?.name || "MCP server";
}

export type Tone = "good" | "warn" | "bad" | "muted";

/** "Every morning at 7:15", in the one format collections use everywhere (lib/collection-words.ts). */
export const scheduleText = (c: Pick<Collection, "schedule" | "run_at" | "every_hours">): string => whenPhrase(c);

/** "slack_read_thread" → "Read thread"; "notion-search" → "Search". */
export function toolTitle(name: string, provider: string): string {
  let base = name;
  const prefixes = [provider, presetFor(provider).label.toLowerCase().replace(/\s+/g, "_"), provider.split("-")[0]];
  for (const p of prefixes) {
    const re = new RegExp(`^${p.replace(/[^a-z0-9]/gi, "[_-]?")}[_\\-.]`, "i");
    if (re.test(base) && base.replace(re, "").length > 2) {
      base = base.replace(re, "");
      break;
    }
  }
  const words = base.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A small coloured dot + text. */
export function statusLine(tone: Tone, text: string, cls = ""): HTMLElement {
  return h("span", { class: `conn-status conn-status--${tone} ${cls}`.trim() }, h("span", { class: "conn-status__dot", "aria-hidden": "true" }), text);
}

/** Trailing bits of a list row: a pill or status, then a chevron. */
export function trail(...parts: Array<HTMLElement | null>): HTMLElement {
  return h("span", { class: "row__trail" }, ...parts, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
}

export const errorText = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

const CALENDAR_PROVIDERS = new Set(["google-calendar", "outlook-calendar", "icloud-calendar"]);

/**
 * A Meetings collection leaves its upcoming events to Calendar while an
 * enabled Calendar reads every one of its calendar accounts (the server's
 * rule: netlify/lib/connectors/calendar-sync.ts, `withoutCoveredSync`).
 */
export function eventsLeftToCalendar(col: Pick<Collection, "recipe" | "connector_ids" | "lookahead_days">, collections: Array<Pick<Collection, "recipe" | "enabled" | "connector_ids">>, connectors: Array<Pick<Connector, "id" | "provider">>): boolean {
  if (col.recipe !== "calendar-meetings" || col.lookahead_days <= 0) return false;
  const covered = new Set(collections.filter((c) => c.recipe === "calendar-sync" && c.enabled).flatMap((c) => c.connector_ids));
  const calendars = col.connector_ids.filter((id) => CALENDAR_PROVIDERS.has(connectors.find((c) => c.id === id)?.provider ?? ""));
  return calendars.length > 0 && calendars.every((id) => covered.has(id));
}
