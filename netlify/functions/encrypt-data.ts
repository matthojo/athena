/**
 * Encrypts existing data at rest: a Netlify Scheduled Function that runs
 * every 5 minutes (docs: security/encryption, lib/encryption.ts).
 *
 * Each run seals, within about 20 seconds, whatever isn't yet sealed under
 * the current ATHENA_DATA_KEY: rows written before the key was set, and
 * after a key rotation, rows still under the old key. It logs one line, so
 * Netlify's function log for encrypt-data shows the progress:
 *
 *   Athena encryption: encrypting — sealed 400 rows this run, 812 left
 *   Athena encryption: on — everything sealed under key 1a2b3c4d
 *
 * Without the key it does nothing. Netlify only runs scheduled functions on
 * production deploys, which is the only context that has the key.
 */
import type { Config } from "@netlify/functions";
import { encryptionStatus, sealExisting } from "../../lib/encryption";

export default async () => {
  try {
    const run = await sealExisting({ budgetMs: 20_000 });
    const status = await encryptionStatus();
    const parts = [
      run ? `sealed ${run.sealed} rows this run` : "",
      status.state === "on" ? `everything sealed under key ${status.key_id}` : `${status.remaining} left`,
      run?.unreadable ? `${run.unreadable} values couldn't be decrypted (an old key may be missing from ATHENA_DATA_KEY_PREVIOUS)` : "",
      run?.skipped ? `${run.skipped} changed while sealing (next run)` : "",
      status.problem ?? "",
    ].filter(Boolean);
    console.log(`Athena encryption: ${status.state} — ${parts.join(", ")}`);
  } catch (error) {
    console.error("Athena encryption run failed:", error);
  }
};

export const config: Config = { schedule: "*/5 * * * *" };
