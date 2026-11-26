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
 *
 * It also retires the v1 format of connector credentials (lib/secret-format.ts):
 * every v1 value is sealed again as v2 under CONNECTOR_ENCRYPTION_KEY, and once
 * none is left that's recorded and v1 values are refused from then on. That
 * part needs only the connector key, and logs until it's finished:
 *
 *   Athena credentials: sealed 3 v1 credentials again; v1 is now retired
 */
import type { Config } from "@netlify/functions";
import { encryptionStatus, sealExisting } from "../../lib/encryption";
import { retireV1Secrets } from "../../lib/secret-format";

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
  try {
    const pass = await retireV1Secrets();
    if (pass.state === "finished") console.log(`Athena credentials: sealed ${pass.resealed} v1 credentials again; v1 is now retired`);
    if (pass.state === "pending") {
      const unreadable = pass.unreadable ? `, ${pass.unreadable} no key here opens (put the old key in CONNECTOR_ENCRYPTION_KEY_PREVIOUS, or sign those accounts in again)` : "";
      console.log(`Athena credentials: sealed ${pass.resealed} v1 credentials again${unreadable}`);
    }
  } catch (error) {
    console.error("Athena credentials pass failed:", error);
  }
};

export const config: Config = { schedule: "*/5 * * * *" };
