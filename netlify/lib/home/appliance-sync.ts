/**
 * Athena's look at the home's appliances, every 15 minutes from the
 * collections scheduler (netlify/functions/collect.ts), for the Home Connect
 * accounts an enabled Home collection reads (home-accounts.ts); each Home run
 * looks too (home-run.ts). No model is involved. The look stays at 15
 * minutes, though Home runs hourly: a programme's end is the first look that
 * finds it stopped, and a short one could start and end between hourly looks.
 *
 * For each signed-in Home Connect account: read every appliance and what
 * it's doing (homeconnect-direct.ts), set that against what was seen last
 * time (lib/home-appliances.ts `step`), write a Days entry for each
 * programme that finished in between, and keep the new picture sealed
 * (lib/appliance-store.ts) for the House page.
 *
 * Home Connect allows a limited number of requests a day. A look costs one
 * request, one more per connected appliance and one more per appliance
 * that's running, so five appliances at 96 looks a day is under 700. When
 * Home Connect says to slow down (429), the account is left alone for an
 * hour. A sign-in that stopped working marks the account for signing in
 * again, as a failed collection would.
 *
 * Never throws: an account that can't be read keeps what it had.
 */
import { getConnectorWithSecrets, listConnectors, setConnectorStatus, type Connector, type ConnectorSecrets } from "../../../lib/connectors";
import { dataKeyConfigured } from "../../../lib/data-box";
import { zonedParts } from "../../../lib/dates";
import { getOwnerTimeZone } from "../../../lib/db";
import { writeEntries, type EntryInput } from "../../../lib/days";
import { cycleEntry, step, type ApplianceSnapshot, type ApplianceState } from "../../../lib/home-appliances";
import { loadAppliances, saveAppliances } from "../../../lib/appliance-store";
import { HOME_CONNECT_SOURCE } from "../../../lib/presets/home";
import { LifeApiError } from "../connectors/lifelog-b-http";
import { homeAccounts } from "./home-accounts";

/** After a 429, how long an account is left alone. */
export const SLOW_DOWN_MS = 3600_000;
const DEFAULT_BUDGET_MS = 12_000;

export interface ApplianceSyncDeps {
  now?: Date;
  budgetMs?: number;
  /** Read one account's appliances. Tests pass their own. */
  read?: (connector: Connector, secrets: ConnectorSecrets) => Promise<ApplianceSnapshot[]>;
  /** Only these accounts (a Home run's own). Default: every account an enabled Home reads. */
  ids?: Set<string>;
}

export interface ApplianceSyncResult {
  accounts: number;
  /** Programmes found finished and written to Days. */
  finished: number;
}

async function readLive(connector: Connector, secrets: ConnectorSecrets): Promise<ApplianceSnapshot[]> {
  const { homeConnectGet, readAppliances } = await import("../connectors/homeconnect-direct");
  return readAppliances(homeConnectGet(connector, secrets));
}

export async function syncAppliances(deps: ApplianceSyncDeps = {}): Promise<ApplianceSyncResult> {
  const result: ApplianceSyncResult = { accounts: 0, finished: 0 };
  try {
    // Without the data key nothing could be kept sealed, so nothing is read.
    if (!dataKeyConfigured()) return result;
    const only = deps.ids ?? (await homeAccounts());
    const accounts = (await listConnectors()).filter((c) => c.provider === "home-connect" && c.auth_type === "oauth" && c.status === "connected" && only.has(c.id));
    if (!accounts.length) return result;
    const now = deps.now ?? new Date();
    const deadline = Date.now() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
    const read = deps.read ?? readLive;
    const tz = await getOwnerTimeZone();
    const store = await loadAppliances();
    const entries: Array<{ date: string; entry: EntryInput }> = [];
    let changed = false;

    for (const account of accounts) {
      if (Date.now() >= deadline) break;
      const kept = store.accounts[account.id];
      if (kept?.resume_at && Date.parse(kept.resume_at) > now.getTime()) continue;
      const open = await getConnectorWithSecrets(account.id);
      if (!open?.secrets.tokens) continue;
      let snaps: ApplianceSnapshot[];
      try {
        snaps = await read(open.connector, open.secrets);
      } catch (error) {
        if (error instanceof LifeApiError && error.status === 429) {
          store.accounts[account.id] = { at: kept?.at ?? now.toISOString(), appliances: kept?.appliances ?? [], resume_at: new Date(now.getTime() + SLOW_DOWN_MS).toISOString() };
          changed = true;
        } else if (error instanceof LifeApiError && error.owner) {
          await setConnectorStatus(account.id, "needs_auth", error.message).catch(() => undefined);
        }
        // Anything else: unreachable just now. What was kept stands.
        continue;
      }
      result.accounts++;
      const before = new Map((kept?.appliances ?? []).map((a) => [a.id, a]));
      const next: ApplianceState[] = [];
      for (const snap of snaps) {
        const { next: state, finished } = step(before.get(snap.id), snap, now);
        next.push(state);
        if (!finished) continue;
        const e = cycleEntry(snap, finished);
        entries.push({
          date: zonedParts(new Date(finished.ended), tz).date,
          entry: { kind: "other", source: HOME_CONNECT_SOURCE, external_id: e.external_id, title: e.title, ...(e.subtitle ? { subtitle: e.subtitle } : {}), at: e.at, minutes: e.minutes },
        });
      }
      store.accounts[account.id] = { at: now.toISOString(), appliances: next };
      changed = true;
    }

    // An account that's gone takes what was kept about it along.
    const live = new Set((await listConnectors()).filter((c) => c.provider === "home-connect").map((c) => c.id));
    for (const id of Object.keys(store.accounts)) {
      if (!live.has(id)) {
        delete store.accounts[id];
        changed = true;
      }
    }

    // Days first: if that fails, the run is still remembered as under way and the cycle is found again next time.
    if (entries.length) {
      await writeEntries(entries, { collection: "home-connect" });
      result.finished = entries.length;
    }
    if (changed) await saveAppliances(store);
  } catch (error) {
    console.error("Athena appliances: the look failed", error instanceof Error ? error.name : "unknown error");
  }
  return result;
}
