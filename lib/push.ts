/**
 * Web Push sending, shared by the reminders function and the API's test
 * endpoint.
 *
 * VAPID keys: when VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set on Netlify
 * they win (VAPID_SUBJECT optional). Otherwise Athena makes its own pair the
 * first time it's needed and keeps it in the `settings` row `vapid`: the
 * public key readable (it's sent to every browser anyway), the private key
 * sealed under the data key (docs: security/outside-services, security/encryption). So push works with no
 * owner step. Without either, this logs one clear line and sends nothing.
 */

import { createHash } from "node:crypto";
import webpush from "web-push";
import { keepPushSubscriptionsOf, listPushSubscriptions, qRaw, removePushSubscription } from "./db";
import { listApiKeys } from "./api-keys";
import { currentKeyId, dataKeyConfigured, isSealed, openStrict, sealText, sealedKeyId } from "./data-box";
import { mergePrefs, PREFS_KEY, readPrefs, type NotificationPrefs } from "./nudges";

export interface PushPayload {
  title: string;
  body: string;
  /** In-app deep link, e.g. "/#/notes/<id>". */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag?: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
  from: "env" | "stored";
}

function env(name: string): string | undefined {
  // Netlify.env in functions; process.env elsewhere (scripts, tests).
  const g = globalThis as { Netlify?: { env: { get(k: string): string | undefined } } };
  return g.Netlify?.env.get(name) ?? process.env[name];
}

const VAPID_ROW = "vapid";

/** A push service wants a contact: mailto: or the site's own address. */
function subject(): string {
  const s = env("VAPID_SUBJECT")?.trim();
  if (s && /^(mailto:|https:\/\/)/.test(s)) return s;
  const site = env("URL")?.trim();
  return site && site.startsWith("https://") ? site : "https://athena.example.com";
}

interface StoredVapid {
  public: string;
  /** Sealed: enc:v1:<kid>:… */
  private: string;
  created_at: string;
}

async function readStored(): Promise<StoredVapid | null> {
  const [row] = await qRaw<{ value: StoredVapid }>(`SELECT value FROM settings WHERE key = $1`, [VAPID_ROW]);
  const v = row?.value;
  return v && typeof v.public === "string" && typeof v.private === "string" ? v : null;
}

function freshPair(): StoredVapid {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { public: publicKey, private: sealText(privateKey), created_at: new Date().toISOString() };
}

/**
 * The stored pair, made on first use. Concurrent first runs race on the
 * insert; the loser reads the winner's pair, so every device ends up on one key.
 * A pair whose private half no longer opens (the data key changed and the old
 * one is gone) is replaced: devices re-subscribe the next time the app opens.
 */
async function storedKeys(): Promise<{ publicKey: string; privateKey: string } | null> {
  if (!dataKeyConfigured()) return null;
  let stored = await readStored();
  if (!stored) {
    await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`, [VAPID_ROW, JSON.stringify(freshPair())]);
    stored = await readStored();
    if (!stored) return null;
  }
  let privateKey: string;
  try {
    if (!isSealed(stored.private)) throw new Error("not sealed");
    privateKey = openStrict(stored.private);
  } catch {
    const replaced = freshPair();
    const [won] = await qRaw<{ key: string }>(
      `UPDATE settings SET value = $2::jsonb, updated_at = now() WHERE key = $1 AND value->>'private' = $3 RETURNING key`,
      [VAPID_ROW, JSON.stringify(replaced), stored.private],
    );
    console.error("Athena push: the stored notification key couldn't be opened with the data key; made a new one");
    if (!won) return storedKeys();
    stored = replaced;
    privateKey = openStrict(stored.private);
  }
  // Sealed under an older data key: seal it again under the current one.
  if (sealedKeyId(stored.private) !== currentKeyId()) {
    const resealed = { ...stored, private: sealText(privateKey) };
    await qRaw(`UPDATE settings SET value = $2::jsonb, updated_at = now() WHERE key = $1 AND value->>'private' = $3`, [VAPID_ROW, JSON.stringify(resealed), stored.private]);
  }
  return { publicKey: stored.public, privateKey };
}

/** The keys to send with: the environment's when set, else Athena's own. Null when neither can be had. */
export async function vapidKeys(): Promise<VapidKeys | null> {
  const publicKey = env("VAPID_PUBLIC_KEY")?.trim();
  const privateKey = env("VAPID_PRIVATE_KEY")?.trim();
  if (publicKey && privateKey) return { publicKey, privateKey, subject: subject(), from: "env" };
  try {
    const own = await storedKeys();
    if (own) return { ...own, subject: subject(), from: "stored" };
  } catch (error) {
    console.error("Athena push: couldn't load or make the notification key —", error instanceof Error ? error.message : error);
    return null;
  }
  console.log("Athena push: no VAPID keys in the environment and no ATHENA_DATA_KEY to keep Athena's own — skipping push notifications.");
  return null;
}

/** The public key browsers subscribe with, or null when push can't work on this deploy. */
export async function vapidPublicKey(): Promise<string | null> {
  return (await vapidKeys())?.publicKey ?? null;
}

/** Configure web-push. Returns false (and logs) when there are no keys. */
export async function pushConfigured(): Promise<boolean> {
  const keys = await vapidKeys();
  if (!keys) return false;
  try {
    webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
    return true;
  } catch (error) {
    console.error("Athena push: invalid VAPID configuration —", error instanceof Error ? error.message : error);
    return false;
  }
}

// ---------- Which endpoints, and whose ----------

/**
 * A subscription endpoint Athena will send to, or null: https on a known
 * browser push service (Chrome and Android's FCM, Firefox's, Safari's,
 * Edge's), the default port, no user or password. Anything else would be a
 * server of the caller's choosing receiving notification text.
 */
export function pushEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2_000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  const h = u.hostname;
  const known = h === "fcm.googleapis.com" || h === "updates.push.services.mozilla.com" || h.endsWith(".push.apple.com") || h.endsWith(".notify.windows.com");
  return known ? raw : null;
}

/** Replaceable in tests, which push to a fake service on localhost. The subscribe route always uses pushEndpoint itself. */
export const pushDeps = { allowed: (endpoint: string): boolean => pushEndpoint(endpoint) !== null };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const fingerprint = (of: string) => sha256(`athena-push-credential\u0000${of}`).slice(0, 32);

/**
 * What a subscription is tied to: the credential that registered it, as netlify/lib/mcp/bearer.ts names it ("master",
 * or "key:<id>"). The master token by a hash of it, so a new token drops its subscriptions; an API key by its id, so
 * removing the key drops them, whatever form lib/api-keys.ts keeps the key in. Never the token itself. Null when it
 * names neither (or the master token isn't set).
 */
export function pushCredential(who: { id: string }): string | null {
  if (who.id === "master") {
    const master = env("MCP_BEARER_TOKEN");
    return master ? fingerprint(sha256(master)) : null;
  }
  const key = /^key:(.+)$/.exec(who.id)?.[1];
  return key ? fingerprint(`key\u0000${key}`) : null;
}

/** The fingerprints of every credential that still works: the master token and each API key that can be used. */
export async function liveCredentials(): Promise<string[]> {
  const out = (await listApiKeys()).map((k) => pushCredential({ id: `key:${k.id}` })!);
  const master = pushCredential({ id: "master" });
  return master ? [master, ...out] : out;
}

/** Ten seconds for one push service to answer; without it web-push sets no timeout and one stalled endpoint holds the whole run. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * Send to every subscribed device. First, subscriptions registered by a
 * credential that no longer exists (a removed key, a changed master token)
 * are dropped, and so is any whose endpoint isn't a known push service.
 * Subscriptions the push service reports as gone (404/410) are pruned.
 * Returns how many deliveries were accepted.
 */
export async function sendToAll(payload: PushPayload): Promise<{ sent: number; pruned: number; failed: number }> {
  let pruned = await keepPushSubscriptionsOf(await liveCredentials());
  const subs = await listPushSubscriptions();
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      if (!pushDeps.allowed(s.endpoint)) {
        await removePushSubscription(s.endpoint);
        pruned++;
        return;
      }
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 6, urgency: "normal", timeout: SEND_TIMEOUT_MS },
        );
        sent++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await removePushSubscription(s.endpoint);
          pruned++;
        } else {
          failed++;
          // Never log the endpoint itself: it's a bearer capability for that device.
          console.error(`Athena push: send failed (status ${status ?? "n/a"})`);
        }
      }
    }),
  );
  return { sent, pruned, failed };
}

// ---------- The owner's choices (Settings → Notifications) ----------

/** What the owner has switched on, with defaults for anything never chosen. */
export async function loadNotificationPrefs(): Promise<NotificationPrefs> {
  try {
    const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [PREFS_KEY]);
    return readPrefs(row?.value);
  } catch {
    return readPrefs(null);
  }
}

/** Apply a change from the app; throws a readable message on a bad one. */
export async function saveNotificationPrefs(patch: unknown): Promise<NotificationPrefs> {
  const next = mergePrefs(await loadNotificationPrefs(), patch);
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PREFS_KEY, JSON.stringify(next)],
  );
  return next;
}
