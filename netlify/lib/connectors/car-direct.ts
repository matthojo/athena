/**
 * DVLA and DVSA MOT history accounts (lib/presets/car.ts), registered in
 * direct.ts. No tools: no collection or Claude reads them. The car sync
 * calls them itself (netlify/lib/car-api.ts) for the registrations the owner
 * adds. Opening an account ("Check connection", and when it's added) makes
 * one call with a registration too short to be real, so the service checks
 * the key and nothing about the owner is sent.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { isCarProvider } from "../../../lib/presets/car";
import { CarKeyError, checkCarKey } from "../car-api";
import type { DirectAdapter } from "./direct";

const NOTHING = { text: "This account has nothing to read: Athena asks it itself for your car's dates.", isError: true };

export const carAdapter: DirectAdapter = {
  id: "car",
  handles: (c) => isCarProvider(c.provider) && c.auth_type === "token",
  tools: () => [],
  serverInfo: (c) => ({ website_url: c.provider === "dvla" ? "https://developer-portal.driver-vehicle-licensing.api.gov.uk" : "https://documentation.history.mot.api.gov.uk" }),
  async open(connector: Connector, secrets: ConnectorSecrets) {
    await checkCarKey(connector.provider as "dvla" | "dvsa-mot", secrets);
    return { tools: [], call: async () => NOTHING };
  },
  accountProblem: (error) => error instanceof CarKeyError && error.owner,
  failure: (error) => (error instanceof CarKeyError ? { status: error.owner ? "needs_auth" : "error", detail: error.message } : null),
};
