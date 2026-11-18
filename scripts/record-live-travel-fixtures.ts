/**
 * Record real answers from the two live-travel APIs into lib/fixtures/recorded/,
 * for lib/live-travel.test.ts to check the clients against (its "recorded
 * answers" test skips until these files exist).
 *
 * Run: ATHENA_RDM_KEY=… ATHENA_TFL_KEY=… npx tsx scripts/record-live-travel-fixtures.ts [CRS] [TO_CRS]
 * Defaults to London Paddington, trains to Bristol Temple Meads. Sends the
 * same as the app: station codes, a window and the key. Keys are never written out.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { RDM_BOARD_URL, TFL_STATUS_URL } from "../netlify/lib/live-travel";

const [from = "PAD", to = "BRI"] = process.argv.slice(2).map((s) => s.toUpperCase());
const dir = new URL("../lib/fixtures/recorded/", import.meta.url);
mkdirSync(dir, { recursive: true });

async function record(name: string, url: URL, headers: Record<string, string>) {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url.host} answered ${res.status}`);
  writeFileSync(new URL(name, dir), JSON.stringify(await res.json(), null, 1) + "\n");
  console.log(`recorded ${name}`);
}

const rdmKey = process.env.ATHENA_RDM_KEY;
if (rdmKey) {
  const url = new URL(`${process.env.ATHENA_RDM_URL || RDM_BOARD_URL}/${from}`);
  url.searchParams.set("numRows", "20");
  url.searchParams.set("filterCrs", to);
  url.searchParams.set("filterType", "to");
  url.searchParams.set("timeOffset", "0");
  url.searchParams.set("timeWindow", "120");
  await record("rdm-departures.json", url, { "x-apikey": rdmKey });
} else console.log("ATHENA_RDM_KEY isn't set: no departure board recorded");

const tflKey = process.env.ATHENA_TFL_KEY;
if (tflKey) {
  const url = new URL(TFL_STATUS_URL);
  url.searchParams.set("app_key", tflKey);
  await record("tfl-line-status.json", url, {});
} else console.log("ATHENA_TFL_KEY isn't set: no line status recorded");
