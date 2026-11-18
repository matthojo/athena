/**
 * The home's tariff and its prices (lib/tariff.ts), kept as one sealed row:
 * domain 'home', source 'tariff', label 'tariff', on a fixed day no home
 * window ever reaches (readDays in lib/money.ts also skips the source), the
 * same way the regular payments list is kept. No migration: 0035's check
 * already takes it. Written by the meter sync once a day, read by House.
 */
import { dataKeyConfigured, DataKeyMissing, openStrict, sealText } from "./data-box";
import { qRaw } from "./db";
import type { TariffStore } from "./tariff";

export const TARIFF_SOURCE = "tariff";
const TARIFF_DAY = "2000-01-01";

export async function loadTariffStore(): Promise<TariffStore | null> {
  const [row] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'home' AND source = $1 AND day = $2::date`, [TARIFF_SOURCE, TARIFF_DAY]);
  if (!row) return null;
  const o = JSON.parse(openStrict(row.ciphertext)) as Partial<TariffStore>;
  return { fetched_on: o.fetched_on ?? "", account: o.account ?? "", agreements: o.agreements ?? [] };
}

export async function saveTariffStore(store: TariffStore): Promise<void> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  await qRaw(
    `INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source)
     VALUES ('home', 'tariff', $1, now(), $2::date, $3)
     ON CONFLICT (domain, source, day) WHERE day IS NOT NULL
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, recorded_at = EXCLUDED.recorded_at`,
    [sealText(JSON.stringify(store)), TARIFF_DAY, TARIFF_SOURCE],
  );
}

/** The account number was taken off: its prices go too. */
export async function clearTariffStore(): Promise<void> {
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'home' AND source = $1 AND day = $2::date`, [TARIFF_SOURCE, TARIFF_DAY]);
}
