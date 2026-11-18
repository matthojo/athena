/**
 * OpenSky accounts (lib/presets/flights.ts), registered in direct.ts. No sign-in
 * and no tool: no collection or Claude reads it. Athena asks OpenSky itself for
 * live flight times (netlify/lib/live-flights.ts), with or without the account.
 */
import type { DirectAdapter } from "./direct";

const NOTHING = { text: "OpenSky has nothing to read here: Athena asks it itself for live flight times.", isError: true };

export const flightsAdapter: DirectAdapter = {
  id: "flights",
  handles: (c) => c.provider === "opensky" && c.auth_type === "none",
  tools: () => [],
  serverInfo: () => ({ website_url: "https://opensky-network.org" }),
  open: async () => ({ tools: [], call: async () => NOTHING }),
  accountProblem: () => false,
  failure: () => null,
};
