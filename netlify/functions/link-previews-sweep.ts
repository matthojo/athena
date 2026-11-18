/**
 * Deletes link previews nobody has used for 90 days: a Netlify Scheduled
 * Function, once a month (lib/link-previews.ts, sweepLinkPreviews). Their
 * pictures go from the "athena-link-previews" blob store with them. A note
 * that still links to one reads the page again the next time it's opened.
 *
 * Logs one line with the count, never an address or a title. Netlify only
 * runs scheduled functions on production deploys.
 */
import type { Config } from "@netlify/functions";
import { sweepLinkPreviews } from "../../lib/link-previews";

export default async () => {
  try {
    const n = await sweepLinkPreviews();
    console.log(`Athena link previews: deleted ${n} not used for 90 days`);
  } catch (error) {
    console.error("Athena link previews sweep failed:", error instanceof Error ? error.message : "unknown error");
  }
};

export const config: Config = { schedule: "23 4 1 * *" };
