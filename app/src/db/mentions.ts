/**
 * Where Ask's @ list comes from: GET /api/mentions online (titles are sealed,
 * so the Function matches them), and this device's copies in sample mode or
 * offline, ranked by the same rules (lib/mentions.ts). Picks are remembered
 * here, newest first, so what you mention often comes up first.
 */

import { isSampleMode, request } from "./api";
import { searchEntities } from "./data";
import { loadCommitments, loadReading } from "./memory";
import { savedImageUrl } from "./saved";
import { MENTION_LIMIT, rankMentions, savedTitle, shortDate, type MentionResult } from "../../../lib/mentions";
import type { EntityKind } from "../types";

export type { MentionResult };

const PICKED = "athena.mentions.picked";
const ENTITY_KINDS: EntityKind[] = ["person", "place", "organisation", "event", "note", "project", "record"];

/** "kind:id" of recent picks, newest first. */
export function pickedMentions(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PICKED) ?? "[]");
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function rememberMention(row: Pick<MentionResult, "kind" | "id">): void {
  const key = `${row.kind}:${row.id}`;
  try {
    localStorage.setItem(PICKED, JSON.stringify([key, ...pickedMentions().filter((k) => k !== key)].slice(0, 20)));
  } catch {
    // Private mode: the list just isn't remembered.
  }
}

/** What's on this device: sample data, or the caches when there's no connection. */
async function deviceRows(q: string): Promise<MentionResult[]> {
  const [entities, todos, reading, saved] = await Promise.all([
    searchEntities(q, ENTITY_KINDS).then((r) => r.results).catch(() => []),
    loadCommitments().then((r) => r.items).catch(() => []),
    loadReading().then((r) => r.items).catch(() => []),
    isSampleMode() ? import("./sample-saved").then((m) => m.sampleSavedPage({}).items).catch(() => []) : Promise.resolve([]),
  ]);
  return [
    ...entities.map((e) => ({ kind: e.kind, id: e.id, title: e.title, subtitle: e.subtitle, updated_at: e.updated_at, ...(e.kind_id ? { kind_id: e.kind_id } : {}) })),
    ...todos.filter((c) => !c.archived_at && c.status !== "dropped").map((c) => ({ kind: "todo" as const, id: c.id, title: c.title, subtitle: c.status === "done" ? "Done" : c.due_on ? `Due ${shortDate(c.due_on)}` : "", updated_at: c.updated_at })),
    ...reading.filter((r) => !r.archived_at).map((r) => ({ kind: "watch" as const, id: r.id, title: r.title, subtitle: r.author, updated_at: r.updated_at })),
    ...saved.map((s) => ({ kind: "saved" as const, id: s.id, title: savedTitle(s), subtitle: s.site ?? "", updated_at: s.saved_at, thumb: s.image_url })),
  ];
}

/** The @ list for `q`: online from the server, else from this device. */
export async function findMentions(q: string, signal?: AbortSignal): Promise<MentionResult[]> {
  const picked = pickedMentions();
  if (!isSampleMode() && navigator.onLine) {
    try {
      const qs = new URLSearchParams({ q, limit: String(MENTION_LIMIT) });
      if (picked.length) qs.set("recent", picked.join(","));
      return (await request<{ results: MentionResult[] }>(`/mentions?${qs.toString()}`, { signal })).results;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return rankMentions(await deviceRows(q), q, { picked });
}

/** A row's picture, as something an <img> can show (saved images need the app's token). */
export function mentionThumb(row: MentionResult): Promise<string | null> | null {
  if (!row.thumb) return null;
  return savedImageUrl({ id: row.id, image_url: row.thumb }, "sm");
}

/** One thing by its link, for a pasted bare athena:// link; null when it can't be found. */
export async function mentionById(kind: MentionResult["kind"], id: string): Promise<MentionResult | null> {
  if (!isSampleMode() && navigator.onLine) {
    try {
      return await request<MentionResult>(`/mentions/${kind}/${encodeURIComponent(id)}`);
    } catch {
      // Gone, or the connection dropped: this device may still know it.
    }
  }
  return (await deviceRows("")).find((r) => r.kind === kind && r.id === id) ?? null;
}
