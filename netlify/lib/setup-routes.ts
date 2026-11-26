/**
 * The guided setup's status and progress (lib/setup-guide.ts), mounted by
 * netlify/functions/api.ts before its bearer gate:
 *
 *   GET  /api/setup   → SetupStatus: which settings the site has (booleans, and the data key's id, never a value),
 *                       where the guide is, and whether it should show. Open to
 *                       the bearer token, a full key, or a browser past the site
 *                       password (lib/site-session.ts), so the first screen can
 *                       greet a new owner before they've pasted their token.
 *   POST /api/setup   { step?, complete?, restart? } → SetupStatus. Token or full key only.
 *
 * Nothing here reads or returns a secret's value.
 */
import { dataKeyConfigured, dataKeyProblem, currentKeyId } from "../../lib/data-box";
import { getEncryptionSetting, q } from "../../lib/db";
import { aiConfigured } from "../../lib/ai";
import { secretBoxConfigured } from "../../lib/secret-box";
import { validSiteSession } from "../../lib/site-session";
import {
  applyGuideChange,
  GUIDE_KEY,
  GuideInputError,
  guideReason,
  inUse,
  parseGuideChange,
  readGuide,
  siteReady,
  type GuideProgress,
  type SetupStatus,
  type SiteChecks,
} from "../../lib/setup-guide";

type Reply = (data: unknown, status?: number) => Response;

function env(name: string): string | undefined {
  const fromNetlify = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name);
  return fromNetlify ?? process.env[name];
}

/** A browser that has typed the site password. */
export function hasSiteSession(req: Request): boolean {
  return validSiteSession(req.headers.get("cookie"), env("SESSION_SECRET"), env("SITE_PASSWORD"));
}

async function loadGuide(): Promise<GuideProgress> {
  const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [GUIDE_KEY]);
  return readGuide(row?.value);
}

async function saveGuide(next: GuideProgress): Promise<void> {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [GUIDE_KEY, JSON.stringify(next)],
  );
}

async function used(): Promise<boolean> {
  const [row] = await q<{ notes: number; connectors: number; started_at: string | null }>(
    `SELECT (SELECT count(*)::int FROM (SELECT 1 FROM notes LIMIT 6) n) AS notes,
            (SELECT count(*)::int FROM connectors) AS connectors,
            (SELECT value->>'started_at' FROM settings WHERE key = 'profile_setup') AS started_at`,
  );
  return inUse({ notes: row?.notes ?? 0, connectors: row?.connectors ?? 0, started_at: row?.started_at ?? null });
}

async function status(): Promise<SetupStatus> {
  let database = true;
  let progress: GuideProgress = { step: null, completed_at: null };
  let inUseAlready = false;
  let encryptedElsewhere = false;
  try {
    progress = await loadGuide();
    if (!progress.completed_at) inUseAlready = await used();
    encryptedElsewhere = (await getEncryptionSetting()).required === true;
  } catch {
    database = false;
  }
  const context = env("CONTEXT");
  const keySet = dataKeyConfigured();
  const checks: SiteChecks = {
    database,
    data_key: keySet ? "set" : dataKeyProblem() ? "invalid" : "missing",
    connector_key: secretBoxConfigured(),
    ai: aiConfigured(),
    // A preview or branch deploy has no data key on purpose; nor does a copy of encrypted data without its key.
    preview: context === "deploy-preview" || context === "branch-deploy" || (!keySet && encryptedElsewhere),
  };
  const out: SetupStatus = {
    checks,
    ready: siteReady(checks),
    guide: { ...progress, reason: guideReason(progress, checks, inUseAlready) },
    site_name: env("SITE_NAME")?.trim() || null,
  };
  // The key's id (four bytes from HKDF, never the key): the site step tells the owner whether the key they added is the one
  // it showed, before this device can connect.
  out.data_key_id = currentKeyId();
  return out;
}

/** /api/setup. `signedIn`: the bearer token or a full key; otherwise only a site session reaches here, for GET. */
export async function handleSetupRoutes(req: Request, signedIn: boolean, reply: Reply): Promise<Response> {
  if (req.method === "GET") return reply(await status());
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (!signedIn) return reply({ error: "Unauthorized" }, 401);
  let change;
  try {
    change = parseGuideChange(await req.json().catch(() => null));
  } catch (error) {
    if (error instanceof GuideInputError) return reply({ error: error.message }, 400);
    throw error;
  }
  try {
    await saveGuide(applyGuideChange(await loadGuide(), change));
  } catch {
    return reply({ error: "Athena couldn't reach its database, so that wasn't saved. Try again in a minute." }, 503);
  }
  return reply(await status());
}
