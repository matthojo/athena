/**
 * Where what Athena last saw of the home's appliances lives: one `settings`
 * row, key 'appliances', whose value is { sealed: <the whole ApplianceStore,
 * sealed with the data key> }. What an appliance is doing, and when it last
 * ran, shows when someone's home, so none of it is readable in the database
 * (docs: security/encryption). No migration: `settings` already takes any key.
 *
 * Written by netlify/lib/home/appliance-sync.ts every 15 minutes; read by
 * the House page.
 */
import { dataKeyConfigured, DataKeyMissing, openStrict, sealText } from "./data-box";
import { qRaw } from "./db";
import type { ApplianceStore } from "./home-appliances";

export const APPLIANCES_KEY = "appliances";

export async function loadAppliances(): Promise<ApplianceStore> {
  const [row] = await qRaw<{ value: { sealed?: string } }>(`SELECT value FROM settings WHERE key = $1`, [APPLIANCES_KEY]);
  if (!row?.value?.sealed) return { accounts: {} };
  const o = JSON.parse(openStrict(row.value.sealed)) as Partial<ApplianceStore>;
  return { accounts: o.accounts && typeof o.accounts === "object" ? o.accounts : {} };
}

export async function saveAppliances(store: ApplianceStore): Promise<void> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [
    APPLIANCES_KEY,
    JSON.stringify({ sealed: sealText(JSON.stringify(store)) }),
  ]);
}
