/**
 * Which accounts an enabled Home collection reads (home-run.ts). The Life log
 * leaves these to Home; the 15-minute appliance look reads only these.
 */
import { listCollections } from "../../../lib/connectors";

/** Connector ids in any enabled Home collection. */
export async function homeAccounts(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const c of await listCollections()) if (c.recipe === "home" && c.enabled) for (const id of c.connector_ids) ids.add(id);
  return ids;
}

/** The services Home reads: the sealed banks and meter, and the appliances. */
export const HOME_PROVIDERS = ["octopus", "monzo", "starling", "home-connect"] as const;
export const isHomeProvider = (provider: string): boolean => (HOME_PROVIDERS as readonly string[]).includes(provider);
