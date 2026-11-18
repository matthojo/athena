/**
 * Netflix: an import-only account. Netflix has no API for your viewing
 * history and no sign-in Athena could use, but Viewing activity → Download
 * all gives a CSV per profile. So the account holds nothing (no address, no
 * key) and Athena never calls Netflix; its page offers the import
 * (app/src/components/netflix-import.ts → /api/connectors/:id/viewing).
 * Joined into CONNECTOR_PRESETS by lib/connector-presets.ts.
 */
import type { ConnectorPreset } from "../connector-presets";

/** Never fetched: createConnector wants an https address, and this is Netflix's. */
export const NETFLIX_URL = "https://www.netflix.com";

export const NETFLIX_PRESETS: ConnectorPreset[] = [
  {
    id: "netflix",
    label: "Netflix",
    tagline: "What you've watched, from a file",
    icon: "tv",
    category: "entertainment",
    url: NETFLIX_URL,
    auth: "none",
    scope: "",
    readTools: [],
    recipes: ["life-log"],
    help: "No sign-in. Netflix doesn't share your viewing history with apps, so you download it from Netflix and import it here, once for each profile.",
  },
];

/** Netflix accounts are Athena's own (netflix-history.ts's adapter), never an MCP server. */
export function netflixDirect(c: { provider: string; auth_type: string }): boolean {
  return c.provider === "netflix";
}
