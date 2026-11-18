/**
 * Brings existing notes' graph links up to date after content-link sync
 * learns a new kind of link: a Netlify Scheduled Function, hourly (lib/db.ts
 * backfillContentLinks). Bodies are sealed, so a migration can't do it.
 *
 * The first run after a deploy does the work (picking up where it stopped
 * if there's more than one run's worth); after that each run finds the
 * version already done and returns. Logs one line with counts, never a title.
 * Netlify only runs scheduled functions on production deploys.
 */
import type { Config } from "@netlify/functions";
import { backfillContentLinks } from "../../lib/db";

export default async () => {
  try {
    const run = await backfillContentLinks({ budgetMs: 20_000 });
    if (run.synced) console.log(`Athena content links: synced ${run.synced} notes and records${run.done ? ", done" : ", more next run"}`);
  } catch (error) {
    console.error("Athena content links backfill failed:", error instanceof Error ? error.message : "unknown error");
  }
};

export const config: Config = { schedule: "17 * * * *" };
