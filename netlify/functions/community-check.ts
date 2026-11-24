/**
 * Community's daily check (netlify/lib/community-routes.ts communityUpdates): while the owner's "Check the
 * Community catalogue" switch is on and something from the catalogue is added here, the index is read (at most once
 * a day) and anything taken down is paused, once. Newer listings are only shown on their item's page; nothing
 * updates by itself. With no catalogue set, the switch off or nothing added, it fetches nothing.
 */
import type { Config } from "@netlify/functions";
import { communityUpdates } from "../lib/community-routes";

export default async () => {
  try {
    const checks = await communityUpdates();
    console.log("Athena community check:", JSON.stringify({ newer: checks.filter((c) => c.newer).length, withdrawn: checks.filter((c) => c.withdrawn).length }));
  } catch (error) {
    console.error("Athena community check failed:", error);
  }
};

// Once a day, early morning UTC.
export const config: Config = { schedule: "43 4 * * *" };
