/**
 * Disconnecting an account. Its row and sealed secrets are deleted first,
 * whatever happens next; then, where the provider has a revoke endpoint, the
 * sign-in is revoked there too, so the tokens stop working even if a copy
 * survives somewhere (a backup, a log the provider keeps). Best effort: a
 * few seconds at most, never an error for the owner, and nothing about the
 * tokens is ever logged.
 *
 * Providers with a revoke endpoint: Google (Gmail, Calendar, Drive, Docs,
 * YouTube), Trakt, Reddit and Strava. Microsoft, Spotify and most others
 * have none; the owner removes Athena from the provider's own account page.
 *
 * Revoking at Google or Strava ends every sign-in that OAuth client has for
 * that person, not just this account's. So an account whose client another
 * remaining account also uses (two Google accounts sharing one setup) is
 * left signed in at the provider: revoking would sign the other out too.
 */
import { deleteConnector, getConnectorWithSecrets, listConnectors, type Connector, type ConnectorSecrets } from "../../../lib/connectors";
import { directFor } from "./direct";
import { REDDIT_USER_AGENT } from "./reddit-direct";
import { TRAKT_API } from "./trakt-api";

const TIMEOUT_MS = 4000;

type Revoke = (tokens: Record<string, unknown>, client: { client_id: string; client_secret?: string } | undefined, signal: AbortSignal) => Promise<Response> | null;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const form = (fields: Record<string, string>) => new URLSearchParams(fields);

/** By direct adapter id. Each returns null when there's nothing to revoke with. */
export const REVOKERS: Record<string, { family: string; revoke: Revoke }> = {
  google: { family: "google", revoke: googleRevoke },
  "google-docs": { family: "google", revoke: googleRevoke },
  youtube: { family: "google", revoke: googleRevoke },
  trakt: {
    family: "trakt",
    revoke: (t, client, signal) => {
      const token = str(t.access_token);
      if (!token || !client?.client_id) return null;
      return fetch(`${TRAKT_API}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, client_id: client.client_id, client_secret: client.client_secret ?? "" }),
        signal,
      });
    },
  },
  reddit: {
    family: "reddit",
    revoke: (t, client, signal) => {
      const refresh = str(t.refresh_token);
      const token = refresh ?? str(t.access_token);
      if (!token || !client?.client_id) return null;
      return fetch("https://www.reddit.com/api/v1/revoke_token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret ?? ""}`).toString("base64")}`,
          "User-Agent": REDDIT_USER_AGENT,
        },
        body: form({ token, token_type_hint: refresh ? "refresh_token" : "access_token" }),
        signal,
      });
    },
  },
  strava: {
    family: "strava",
    revoke: (t, _client, signal) => {
      const token = str(t.access_token);
      if (!token) return null;
      return fetch("https://www.strava.com/oauth/deauthorize", { method: "POST", body: form({ access_token: token }), signal });
    },
  },
};

function googleRevoke(t: Record<string, unknown>, _client: unknown, signal: AbortSignal): Promise<Response> | null {
  // The refresh token ends the whole grant; an access token alone only itself.
  const token = str(t.refresh_token) ?? str(t.access_token);
  if (!token) return null;
  return fetch("https://oauth2.googleapis.com/revoke", { method: "POST", body: form({ token }), signal });
}

function revokerFor(c: Pick<Connector, "provider" | "auth_type" | "oauth">): { family: string; revoke: Revoke } | undefined {
  if (c.auth_type !== "oauth") return undefined;
  const adapter = directFor(c);
  return adapter ? REVOKERS[adapter.id] : undefined;
}

/** Does another account still use this OAuth client with the same provider? Then revoking would sign it out too. */
async function clientShared(family: string, clientId: string | undefined): Promise<boolean> {
  for (const other of await listConnectors()) {
    if (revokerFor(other)?.family !== family) continue;
    // Without its own client it uses Athena's shared setup, as this one may: count it as shared.
    if (!clientId || !other.has_own_client) return true;
    const theirs = await getConnectorWithSecrets(other.id).catch(() => null);
    if (!theirs || theirs.secrets.ownClient?.client_id === clientId) return true;
  }
  return false;
}

/** Ask the provider to revoke this sign-in. Never throws; says what happened, without any token. */
export async function revokeSignIn(
  connector: Pick<Connector, "provider" | "auth_type" | "oauth">,
  secrets: ConnectorSecrets,
  /** Swappable in tests, which have no database. */
  shared: (family: string, clientId: string | undefined) => Promise<boolean> = clientShared,
): Promise<"revoked" | "refused" | "skipped" | "failed"> {
  try {
    const revoker = revokerFor(connector);
    const tokens = secrets.tokens;
    if (!revoker || !tokens) return "skipped";
    if (await shared(revoker.family, secrets.ownClient?.client_id)) return "skipped";
    const sent = revoker.revoke(tokens, secrets.ownClient, AbortSignal.timeout(TIMEOUT_MS));
    if (!sent) return "skipped";
    const res = await sent;
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return "revoked";
    console.warn(`Athena: ${connector.provider} didn't revoke the removed account's sign-in (HTTP ${res.status})`);
    return "refused";
  } catch (error) {
    console.warn(`Athena: couldn't reach ${connector.provider} to revoke the removed account's sign-in (${error instanceof Error ? error.name : "error"})`);
    return "failed";
  }
}

/** Remove the account and its credentials, then revoke its sign-in where the provider can. False when there was no such account. */
export async function disconnectConnector(id: string): Promise<boolean> {
  const found = await getConnectorWithSecrets(id).catch(() => null);
  const deleted = await deleteConnector(id);
  if (deleted && found) await revokeSignIn(found.connector, found.secrets);
  return deleted;
}
