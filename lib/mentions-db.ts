/**
 * The server's side of @ mentions: GET /api/mentions (searchMentions) and the
 * context block the assistant and the answer path get before the model runs
 * (resolveMentions). Titles are sealed at rest; q() opens them here, inside
 * the Function, and they're matched in memory (lib/db.ts searchEntities does
 * the same for the older kinds).
 */

import { getNote, getPerson, getEvent, getRecord, q, searchEntities } from "./db";
import { getCommitment, getReadingItem } from "./memory";
import { getCustomRecord, getKind } from "./custom-kinds";
import { getSaved } from "./saved";
import { isEncryptedPlaceholder } from "./encrypted";
import { linkKindOf, type AthenaLink } from "./links";
import {
  MENTIONS_RESOLVED,
  mentionsIn,
  rankMentions,
  savedTitle,
  shortDate,
  type MentionContext,
  type MentionResult, fieldText } from "./mentions";

/** How many of each kind are read to rank: the newest, which is what "recent" favours anyway. */
const SCAN = 400;

const TODO_KIND: Record<string, string> = { i_owe: "I owe", waiting_on: "Waiting on", decision: "Decision" };
const READING_KIND: Record<string, string> = {
  article: "Article",
  book: "Book",
  podcast: "Podcast",
  video: "Video",
  paper: "Paper",
  other: "Watch & read",
  film: "Film",
  tv: "TV",
  music: "Music",
  game: "Game",
};
const join = (...parts: Array<string | null | undefined>) => parts.filter((p) => p && p.trim()).join(" · ");

async function savedRows(): Promise<MentionResult[]> {
  const rows = await q<{ id: string; kind: string; title: string | null; quote: string | null; note: string | null; url: string | null; site: string | null; has_image: boolean; saved_at: string }>(
    `SELECT id, kind, title, quote, note, url, site, has_image, saved_at FROM saved_items
     WHERE archived_at IS NULL ORDER BY saved_at DESC LIMIT ${SCAN}`,
  );
  const KIND: Record<string, string> = { link: "Link", image: "Image", quote: "Quote", snippet: "Snippet", note: "Note" };
  return rows.map((r) => ({
    kind: "saved",
    id: r.id,
    title: savedTitle(r),
    subtitle: r.site || KIND[r.kind] || "",
    updated_at: new Date(r.saved_at).toISOString(),
    thumb: r.has_image ? `/api/saved/${r.id}/image` : null,
  }));
}

async function todoRows(): Promise<MentionResult[]> {
  const rows = await q<{ id: string; title: string; kind: string; status: string; due_on: string | null; updated_at: string }>(
    `SELECT id, title, kind, status, to_char(due_on, 'YYYY-MM-DD') AS due_on, updated_at FROM commitments
     WHERE archived_at IS NULL AND status <> 'dropped'
     ORDER BY (status = 'open') DESC, updated_at DESC LIMIT ${SCAN}`,
  );
  return rows.map((r) => ({
    kind: "todo",
    id: r.id,
    title: r.title,
    subtitle: join(r.kind === "todo" ? null : TODO_KIND[r.kind], r.status === "done" ? "Done" : r.due_on ? `Due ${shortDate(r.due_on)}` : null),
    // A finished one is as good as a fortnight older.
    updated_at: new Date(new Date(r.updated_at).getTime() - (r.status === "done" ? 14 * 86_400_000 : 0)).toISOString(),
  }));
}

async function watchRows(): Promise<MentionResult[]> {
  const rows = await q<{ id: string; title: string; kind: string; author: string; updated_at: string }>(
    `SELECT id, title, kind, author, updated_at FROM reading_items WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ${SCAN}`,
  );
  return rows.map((r) => ({ kind: "watch", id: r.id, title: r.title, subtitle: join(READING_KIND[r.kind] ?? "Watch & read", r.author), updated_at: new Date(r.updated_at).toISOString() }));
}

/** GET /api/mentions?q=: everything that matches, recent first among equals, capped. */
export async function searchMentions(query: string, opts: { limit?: number; now?: Date; picked?: string[] } = {}): Promise<MentionResult[]> {
  const term = query.trim().slice(0, 100);
  const [entities, saved, todos, watch] = await Promise.all([
    searchEntities(term, { limit: term ? 60 : 30 }),
    savedRows(),
    todoRows(),
    watchRows(),
  ]);
  const rows: MentionResult[] = [
    ...entities.map((e) => ({ kind: linkKindOf(e.kind), id: e.id, title: e.title, subtitle: e.subtitle ?? "", updated_at: new Date(e.updated_at).toISOString(), ...(e.kind_id ? { kind_id: e.kind_id } : {}) })),
    ...saved,
    ...todos,
    ...watch,
  ].filter((r) => !isEncryptedPlaceholder(r.title));
  return rankMentions(rows, term, { now: opts.now, limit: opts.limit, picked: opts.picked });
}

const iso = (d: string | null | undefined) => (d ? String(d).slice(0, 10) : "");

/** One link → what the model needs to act on it, or null when it's gone. */
async function resolveOne(link: AthenaLink): Promise<MentionContext | null> {
  const base = { kind: link.kind, id: link.id };
  switch (link.kind) {
    case "person": {
      const p = await getPerson(link.id);
      return p && { ...base, title: p.name, ref: `person:${p.id}`, fields: [["relationship", p.relationship], ["email", p.email], ["works at", p.organisation?.name ?? ""], ["birthday", p.birthday ?? ""]] };
    }
    case "note": {
      const n = await getNote(link.id);
      return n && { ...base, title: n.title, ref: `note:${n.id}`, fields: [["type", n.type], ["tags", n.tags.join(", ")], ["updated", iso(n.updated_at)]] };
    }
    case "place":
    case "organisation":
    case "project": {
      const r = (await getRecord(link.kind, link.id)) as { name: string; address?: string; website?: string; status?: string; url?: string } | null;
      return r && { ...base, title: r.name, fields: [["address", r.address ?? ""], ["website", r.website ?? r.url ?? ""], ["status", r.status ?? ""]] };
    }
    case "event": {
      const e = await getEvent(link.id);
      return e && { ...base, title: e.title, fields: [["kind", e.kind], ["date", fieldText(e.starts_at ?? e.date)], ["person_id", e.person_id ?? ""]] };
    }
    case "record": {
      const r = await getCustomRecord(link.id);
      if (!r) return null;
      const k = await getKind(r.kind_id).catch(() => null);
      return { ...base, title: r.title, ref: `record:${r.id}`, fields: [["kind", k?.one ?? ""], ["kind_id", r.kind_id]] };
    }
    case "saved": {
      const s = await getSaved(link.id);
      if (!s || s.archived) return null;
      return {
        ...base,
        title: savedTitle(s),
        ref: `saved:${s.id}`,
        fields: [["saved kind", s.kind], ["url", s.url ?? s.source_url ?? ""], ["site", s.site ?? ""], ["note", s.note ?? ""], ["tags", s.tags.join(", ")], ["image", s.image_url ? "yes" : ""], ["saved", s.saved_on]],
      };
    }
    case "todo": {
      const c = await getCommitment(link.id);
      return c && { ...base, title: c.title, ref: `todo:${c.id}`, fields: [["kind", c.kind], ["status", c.status], ["due", c.due_on ?? ""], ["person", c.person ? `${c.person.name} (person_id ${c.person.id})` : ""]] };
    }
    case "watch": {
      const r = await getReadingItem(link.id);
      return r && { ...base, title: r.title, fields: [["kind", r.kind], ["status", r.status], ["by", r.author], ["url", r.url]] };
    }
  }
}

/** GET /api/mentions/:kind/:id: one thing's row, for a pasted bare athena:// link; null when it's gone. */
export async function mentionById(kind: MentionResult["kind"], id: string): Promise<MentionResult | null> {
  const m = await resolveOne({ kind, id: id.toLowerCase(), label: "" }).catch(() => null);
  if (!m || isEncryptedPlaceholder(m.title)) return null;
  const has = (k: string) => m.fields.find(([f]) => f === k)?.[1] ?? "";
  return {
    kind,
    id: m.id,
    title: m.title,
    subtitle: kind === "saved" ? has("site") : "",
    updated_at: new Date().toISOString(),
    ...(kind === "saved" && has("image") ? { thumb: `/api/saved/${m.id}/image` } : {}),
  };
}

/** Every mention in the owner's message, resolved (up to MENTIONS_RESOLVED); `missing` are the ones that no longer resolve. */
export async function resolveMentions(text: string): Promise<{ found: MentionContext[]; missing: AthenaLink[] }> {
  const links = mentionsIn(text).slice(0, MENTIONS_RESOLVED);
  const found: MentionContext[] = [];
  const missing: AthenaLink[] = [];
  const got = await Promise.all(links.map((l) => resolveOne(l).catch(() => null)));
  got.forEach((m, i) => (m && !isEncryptedPlaceholder(m.title) ? found.push(m) : missing.push(links[i])));
  return { found, missing };
}
