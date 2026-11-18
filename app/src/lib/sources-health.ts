/**
 * How Athena's sources are doing, in one place, so Sources, the Settings
 * row, the sidebar status card and the phone's status menu never word it
 * differently.
 *
 *  - sourcesHealth(state): the health line and one problem per thing that
 *    needs you. Account problems come from the account sheet's own
 *    accountProblem() (components/connector-detail.ts), so a card and the
 *    sheet it opens say the same words. A collection that failed because
 *    of an account folds into that account's card (D's last_run.blocked_by).
 *  - publishSources(state): the Sources page and main.ts hand over each
 *    state they load; components/status.ts keeps the result for the Settings
 *    row and the status card (kept there so the main bundle stays small).
 *
 * Paused collections and unused accounts are never problems. A collection
 * that's gone quiet is a quiet line on its row, not a card.
 */

import { plural } from "./format";
import { presetFor } from "../../../lib/connector-presets";
import { andList, collectionTitle, failReason, fits, servicesFor, type RunLike } from "./collection-words";
import { accountProblem } from "../components/connector-detail";
import { setSourcesStatus } from "../components/status";
import type { Collection, Connector, ConnectorsState, RecipeId } from "../types";

/** What a problem card's button does. */
export type ProblemFix =
  | { kind: "signin"; connectorId: string }
  | { kind: "account"; connectorId: string }
  | { kind: "collection"; collectionId: string }
  | { kind: "add"; recipe: RecipeId }
  | { kind: "copy"; text: string };

export interface Problem {
  /** Stable, for keyed repaints and the collapse when it's fixed. */
  key: string;
  /** "warn" needs you; "info" is something Athena is waiting out. */
  tone: "warn" | "info";
  /** Who it's about: an account's or a collection's name. */
  subject: string;
  title: string;
  line: string;
  /** The button's words, short ("Sign in", "Fix"); null for an info card. */
  button: string | null;
  /** The button's full name for screen readers ("Sign in to Personal Gmail"). */
  label: string;
  fix: ProblemFix | null;
  connector?: Connector;
  recipe?: RecipeId;
}

export type { HealthTone } from "../components/status";
import type { HealthTone } from "../components/status";

export interface SourcesHealth {
  tone: HealthTone;
  /** "2 things need you", "All working", "Collecting now: Meetings · work". Empty when nothing's set up. */
  line: string;
  /** The quieter half: "Everything else ran today.", "Last saved 12 min ago." */
  sub: string;
  /** Short, for the Settings row: "All working", "2 need you", "Collecting now". */
  short: string;
  /** Problems that need you (info ones aren't counted). */
  count: number;
  problems: Problem[];
  /** Collections running now. */
  running: Collection[];
}

const HOUR = 3_600_000;

/** "just now", "12 min ago", "1 h ago", "yesterday", "3 days ago". Past only. */
export function agoShort(iso: string, now = Date.now()): string {
  const mins = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return `${Math.round(days / 7)} weeks ago`;
}

const isRunning = (c: Collection) => !!c.current_run;
/** On and expected to run: scheduled and switched on, or manual (which has no switch). */
const isActive = (c: Collection) => c.schedule === "manual" || c.enabled;

/** When something was last saved, from D's last_run. */
function lastSavedAt(cols: Collection[]): number | null {
  let best: number | null = null;
  for (const c of cols) {
    const r = c.last_run;
    if (!r || r.status !== "succeeded" || !r.saved || !r.finished_at) continue;
    const t = Date.parse(r.finished_at);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

/** A finished run as the collection words read it. */
function asRun(c: Collection): RunLike | null {
  const r = c.last_run;
  if (!r) return null;
  return {
    id: r.id,
    collection_id: c.id,
    trigger: "schedule",
    status: r.status,
    started_at: null,
    finished_at: r.finished_at,
    summary: "",
    error: r.error,
    stats: { blocked_by: r.blocked_by, saved: r.saved },
    created_at: r.finished_at ?? c.updated_at,
  };
}

/** Sign-ins that leave for the provider straight away. */
const browserSignIn = (c: Connector) => c.auth_type === "oauth" && c.oauth?.grant !== "client_credentials";

export function sourcesHealth(state: ConnectorsState, now = Date.now()): SourcesHealth {
  const { connectors, collections, setup } = state;
  const problems: Problem[] = [];

  // ---- The server ----
  if (!setup.encryption) {
    problems.push({
      key: "setup:encryption",
      tone: "warn",
      subject: "Athena's server",
      title: "Athena's server needs one more setting",
      line: "Add this to Netlify's environment variables, so Athena can keep sign-ins safe.",
      button: "Copy",
      label: "Copy the setting's name, CONNECTOR_ENCRYPTION_KEY",
      fix: { kind: "copy", text: "CONNECTOR_ENCRYPTION_KEY" },
    });
  }
  if (!setup.ai && collections.some(isActive)) {
    problems.push({
      key: "setup:ai",
      tone: "warn",
      subject: "Athena's server",
      title: "Collections can't run yet",
      line: "Turn on AI Gateway in Netlify, or add this to its environment variables.",
      button: "Copy",
      label: "Copy the setting's name, ANTHROPIC_API_KEY",
      fix: { kind: "copy", text: "ANTHROPIC_API_KEY" },
    });
  }

  // ---- Accounts, with the collections waiting on them folded in ----
  const folded = new Set<string>();
  for (const c of connectors) {
    const waiting = collections.filter((col) => isActive(col) && col.connector_ids.includes(c.id));
    const p = accountProblem(c, waiting.map((col) => collectionTitle(col)));
    if (!p) continue;
    waiting.forEach((col) => folded.add(col.id));
    if (p.kind === "down") {
      problems.push({
        key: `account:${c.id}`,
        tone: "info",
        subject: c.name,
        title: p.title,
        line: p.line,
        button: null,
        label: p.title,
        fix: null,
        connector: c,
      });
      continue;
    }
    const signIn = p.button?.startsWith("Sign in") && browserSignIn(c);
    // The sheet has the field right there; the card's button opens it.
    const line = p.kind === "secret" || p.kind === "key" ? p.line.replace(/paste it here\./, "paste it in.") : p.line;
    problems.push({
      key: `account:${c.id}`,
      tone: "warn",
      subject: c.name,
      title: p.title,
      line,
      button: signIn ? "Sign in" : "Fix",
      label: signIn ? `Sign in to ${c.name}` : `Fix ${c.name}`,
      fix: signIn ? { kind: "signin", connectorId: c.id } : { kind: "account", connectorId: c.id },
      connector: c,
    });
  }

  // ---- Collections ----
  for (const col of collections) {
    if (!isActive(col) || folded.has(col.id)) continue;
    const title = collectionTitle(col);
    const accounts = col.connector_ids.map((id) => connectors.find((c) => c.id === id)).filter((c): c is Connector => !!c);
    if (!accounts.length) {
      const fitting = connectors.find((c) => c.status === "connected" && fits(c, col.recipe));
      const names = servicesFor(col.recipe).slice(0, 2);
      problems.push({
        key: `collection:${col.id}`,
        tone: "warn",
        subject: title,
        title: `${title} has nothing to read`,
        line: fitting ? `Choose an account for it, like ${fitting.name}.` : names.length ? `Connect a service it reads, like ${names.join(" or ")}.` : "Connect an account for it to read.",
        button: fitting ? "Choose" : "Set up",
        label: fitting ? `Choose an account for ${title}` : `Set up ${title}`,
        fix: fitting ? { kind: "collection", collectionId: col.id } : { kind: "add", recipe: col.recipe },
        recipe: col.recipe,
      });
      continue;
    }
    if (isRunning(col)) continue;
    const run = asRun(col);
    if (run?.status !== "failed") continue;
    // Stopped by an account that's working again: the next run is fine.
    const blockers = run.stats.blocked_by ?? [];
    if (blockers.length && blockers.every((id) => connectors.find((c) => c.id === id)?.status === "connected")) continue;
    problems.push({
      key: `collection:${col.id}`,
      tone: "warn",
      subject: title,
      title: `${title} didn't run`,
      line: `${failReason(run, connectors)}.`,
      button: "See why",
      label: `See why ${title} didn't run`,
      fix: { kind: "collection", collectionId: col.id },
      recipe: col.recipe,
    });
  }

  const count = problems.filter((p) => p.tone === "warn").length;
  const running = collections.filter(isRunning);
  const saved = lastSavedAt(collections);
  const savedText = saved ? `Last saved ${agoShort(new Date(saved).toISOString(), now)}.` : "";
  const runningText = running.length ? `Collecting now: ${andList(running.map((c) => collectionTitle(c)))}` : "";

  if (!connectors.length && !collections.length) {
    // Nothing set up: the starter cards take the line's place. A missing server setting still shows.
    return { tone: count ? "warn" : "none", line: "", sub: "", short: count ? `${count} ${plural(count, "needs", "need")} you` : "Not set up yet", count, problems, running };
  }

  if (count) {
    // "Everything else ran today", only when it's true.
    const troubled = new Set(problems.flatMap((p) => (p.connector ? collections.filter((col) => col.connector_ids.includes(p.connector!.id)).map((col) => col.id) : p.key.startsWith("collection:") ? [p.key.slice(11)] : [])));
    const rest = collections.filter((c) => isActive(c) && c.schedule !== "manual" && !troubled.has(c.id));
    const allRanToday = rest.length > 0 && rest.every((c) => isRunning(c) || (c.last_run?.status === "succeeded" && !!c.last_run.finished_at && now - Date.parse(c.last_run.finished_at) < 24 * HOUR));
    return {
      tone: "warn",
      line: `${count} ${plural(count, "thing needs", "things need")} you`,
      sub: runningText ? `${runningText}.` : allRanToday ? `Everything else ran today. ${savedText}`.trim() : savedText,
      short: `${count} ${plural(count, "needs", "need")} you`,
      count,
      problems,
      running,
    };
  }

  if (running.length) return { tone: "running", line: runningText, sub: savedText, short: "Collecting now", count, problems, running };

  const info = problems.find((p) => p.tone === "info");
  // The problem's own card says what's down, just below: the line doesn't repeat it.
  if (info) return { tone: "good", line: "Nothing needs you", sub: savedText, short: "All working", count, problems, running };

  if (!collections.some(isActive)) {
    // Accounts, but nothing collecting from them yet.
    // Live-times accounts (lib/presets/flights.ts) are read by Athena itself: never waiting on a collection.
    const waiting = connectors.filter((c) => !presetFor(c.provider).live);
    const ready = !waiting.length ? "Your accounts are connected." : waiting.length === 1 ? `${waiting[0].name} is connected, but nothing collects from it yet.` : "Your accounts are connected, but nothing collects from them yet.";
    return { tone: "good", line: collections.length ? "Everything's paused" : "Ready to collect", sub: collections.length ? "Nothing runs until you turn a collection on." : ready, short: collections.length ? "Paused" : "Ready to collect", count, problems, running };
  }
  return { tone: "good", line: "All working", sub: savedText, short: "All working", count, problems, running };
}

// ---------- Publishing ----------

/** The Sources page and main.ts call this with every state they load; the Settings row and the status card follow. */
export function publishSources(state: ConnectorsState): SourcesHealth {
  const health = sourcesHealth(state);
  setSourcesStatus({
    tone: health.tone,
    line: health.line,
    short: health.short,
    count: health.count,
    names: [...new Set(health.problems.filter((p) => p.tone === "warn").map((p) => p.subject))],
  });
  return health;
}
