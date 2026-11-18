/**
 * Which messaging apps the owner uses, for drafts (lib/drafts.ts): Email,
 * Text, WhatsApp, Telegram and Slack, each on or off. Email and Text are on
 * until the owner changes it. Drafts are only offered on apps that are on,
 * and a person's usual channel falls back to the next one when it's off.
 *
 * Kept in the settings table under `draft_channels` (a list, in this order)
 * and served by GET/PUT /api/settings; the app keeps a copy in localStorage.
 */
import { AthenaInputError, q } from "./db";
import type { MessageChannel } from "./writing-style";

export const DRAFT_CHANNEL_ORDER: readonly MessageChannel[] = ["email", "text", "whatsapp", "telegram", "slack"];
export const DEFAULT_DRAFT_CHANNELS: readonly MessageChannel[] = ["email", "text"];
const KEY = "draft_channels";

const isChannel = (v: unknown): v is MessageChannel => typeof v === "string" && (DRAFT_CHANNEL_ORDER as readonly string[]).includes(v);

/** What's stored, checked: known apps, in the usual order, at least one. Anything else is the default. */
export function readDraftChannels(raw: unknown): MessageChannel[] {
  if (!Array.isArray(raw)) return [...DEFAULT_DRAFT_CHANNELS];
  const on = new Set(raw.filter(isChannel));
  const list = DRAFT_CHANNEL_ORDER.filter((c) => on.has(c));
  return list.length ? list : [...DEFAULT_DRAFT_CHANNELS];
}

export async function loadDraftChannels(): Promise<MessageChannel[]> {
  try {
    const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [KEY]);
    return readDraftChannels(row?.value);
  } catch {
    return [...DEFAULT_DRAFT_CHANNELS];
  }
}

export async function saveDraftChannels(raw: unknown): Promise<MessageChannel[]> {
  if (!Array.isArray(raw) || raw.some((c) => !isChannel(c))) throw new AthenaInputError(`draft_channels: a list of ${DRAFT_CHANNEL_ORDER.join(", ")}`);
  if (!raw.length) throw new AthenaInputError("Keep at least one messaging app on");
  const list = readDraftChannels(raw);
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(list)],
  );
  return list;
}
