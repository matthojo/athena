/**
 * Home: a collection with no model, run hourly by the collections scheduler
 * (or Run now), even without AI Gateway. It reads the accounts whose figures
 * Athena keeps sealed and never shows Claude:
 *
 *  - Octopus Energy: the last few days of half hours replaced, a step of
 *    history, and the tariff once a day (money-sync.ts syncMeter).
 *  - Monzo and Starling: the last week of payments replaced and a step of
 *    history, then regular payments worked out again (money-sync.ts).
 *  - Home Connect: a look at each appliance (appliance-sync.ts). The scheduler
 *    also looks every 15 minutes between runs, for the appliances Home reads.
 *
 * Before Home, the banks and the meter were read only inside the evening Life
 * log run, after its check that Claude can be reached, so a run that stopped
 * early left a day unread. A Life log now leaves any account an enabled Home
 * reads to Home (runner.ts); with Home off or deleted, it reads them again.
 *
 * Like any run: a summary with counts of days only (never an amount, a
 * merchant or a kWh figure), stats, and the accounts that need the owner in
 * `blocked_by`.
 */
import { getConnector, markConnectorUsed, type Collection, type RunStatsJson } from "../../../lib/connectors";
import { getOwnerTimeZone } from "../../../lib/db";
import { ConnectorNeedsSignIn, openConnector, type OpenConnector } from "../connectors/mcp-client";
import { syncMoneyHome } from "../connectors/money-sync";
import { syncAppliances } from "./appliance-sync";
import { isHomeProvider } from "./home-accounts";

/** How long the banks and meter get for their history steps in one run. Background functions have 15 minutes. */
const MONEY_HOME_BUDGET_MS = 120_000;

export interface HomeRun {
  status: "succeeded" | "failed";
  summary: string;
  error?: string;
  stats: RunStatsJson;
}

export interface HomeRunDeps {
  now?: Date;
  /** Open one account. Tests may pass their own. */
  open?: (id: string) => Promise<OpenConnector>;
}

export async function runHome(collection: Pick<Collection, "connector_ids">, deps: HomeRunDeps = {}): Promise<HomeRun> {
  const now = deps.now ?? new Date();
  const tz = await getOwnerTimeZone();
  const open = deps.open ?? openConnector;
  const blocked: string[] = [];
  const unreachable: string[] = [];
  const opened: OpenConnector[] = [];
  const appliances = new Set<string>();
  let accounts = 0;

  for (const id of collection.connector_ids) {
    const c = await getConnector(id).catch(() => null);
    if (!c || !isHomeProvider(c.provider)) continue;
    accounts++;
    if (c.status === "needs_auth" || c.status === "pending") {
      blocked.push(id);
      continue;
    }
    if (c.provider === "home-connect") {
      appliances.add(id);
      continue;
    }
    try {
      opened.push(await open(id));
      await markConnectorUsed(id).catch(() => undefined);
    } catch (error) {
      // Signed out, or a key or meter refused: the account's own status says so (mcp-client.ts classifyFailure).
      const after = await getConnector(id).catch(() => null);
      if (error instanceof ConnectorNeedsSignIn || after?.status === "needs_auth") blocked.push(id);
      else unreachable.push(`${c.name} couldn't be reached`);
    }
  }

  let checked = 0;
  let days = 0;
  const failed: string[] = [];
  const line = opened.length
    ? await syncMoneyHome(opened, {
        now,
        tz,
        budgetMs: MONEY_HOME_BUDGET_MS,
        report: (_id, r) => {
          if ("failed" in r) failed.push(_id);
          else (checked++, (days += r.changed));
        },
      }).catch((error) => `Couldn't read the accounts: ${error instanceof Error ? error.message : "unknown problem"}.`)
    : "";
  for (const o of opened) await o.close().catch(() => undefined);
  // An account that failed for the owner to fix (a refused key, a meter not found) is blocked; anything else waits for the next run.
  for (const id of failed) if ((await getConnector(id).catch(() => null))?.status === "needs_auth") blocked.push(id);

  let finished = 0;
  if (appliances.size) {
    const r = await syncAppliances({ now, ids: appliances, budgetMs: 30_000 });
    checked += r.accounts;
    finished = r.finished;
    for (const id of appliances) {
      if ((await getConnector(id).catch(() => null))?.status === "needs_auth") blocked.push(id);
      else await markConnectorUsed(id).catch(() => undefined);
    }
  }

  const stats: RunStatsJson = {
    accounts_checked: checked,
    days_updated: days,
    ...(appliances.size ? { programmes_finished: finished } : {}),
    ...(blocked.length ? { blocked_by: [...new Set(blocked)] } : {}),
  };
  const parts = [line, appliances.size ? `Appliances: ${finished === 0 ? "nothing finished" : `${finished} ${finished === 1 ? "programme" : "programmes"} finished`}.` : "", ...unreachable.map((u) => `${u}.`)].filter(Boolean);
  const summary = parts.join(" ") || "Nothing new.";
  if (!accounts) return { status: "failed", summary: "", error: "None of these accounts is one Home reads. Add Octopus Energy, Monzo, Starling or Home Connect.", stats };
  if (!checked && new Set(blocked).size === accounts) return { status: "failed", summary, error: "Every account needs signing in again.", stats };
  if (!checked) return { status: "failed", summary, error: "None of the accounts could be read this time. Home tries again next hour.", stats };
  return { status: "succeeded", summary, stats };
}
