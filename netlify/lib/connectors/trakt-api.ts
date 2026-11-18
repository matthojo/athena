/**
 * The plumbing under trakt-direct.ts: Trakt's OAuth (the owner's own Trakt
 * app, authorisation code with PKCE, and no client secret: PKCE's one-time
 * verifier is what protects the code), the access token (renewed at
 * api.trakt.tv and saved back sealed; Trakt rotates the refresh token every
 * time), and GETs to api.trakt.tv/sync and /users/settings.
 *
 * Trakt has no read-only scope: a token can do whatever the owner can. So
 * read-only is enforced here: `get` only sends GETs, and only to
 * api.trakt.tv. The token endpoint's POST is the one other request.
 * Tokens, replies and request URLs are never logged.
 */
import { updateConnectorSecrets, type Connector, type ConnectorSecrets } from "../../../lib/connectors";
import type { StoredTokens } from "./google-api";
import { getText, lifeRetryWaits, ServiceError } from "./feeds-shared";

export const TRAKT_API = "https://api.trakt.tv";
export const TRAKT_AUTHORIZE_URL = "https://auth.trakt.tv/oauth/authorize";
export const TRAKT_TOKEN_URL = `${TRAKT_API}/oauth/token`;
const USER_AGENT = "Athena (personal notes)";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Saving renewed tokens: the sealed store in production, a stand-in in tests. */
export const traktTokenStore = {
  save: (id: string, mutate: (s: ConnectorSecrets) => void) => updateConnectorSecrets(id, mutate),
};

// ---------- sign-in ----------

export function traktAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(TRAKT_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Trakt's token endpoint refused (invalid_grant: signed out or revoked; invalid_client: the app's client ID is wrong). */
function tokenRefusal(status: number, body: Record<string, unknown> | null): ServiceError {
  const code = typeof body?.error === "string" ? body.error : "";
  // Trakt's own reason, for the logs: status, error and its description only (never a code or token).
  const said = typeof body?.error_description === "string" ? body.error_description.slice(0, 300) : "";
  console.error(`Athena trakt: token request refused (${status}${code ? ` ${code}` : ""}${said ? `: ${said}` : ""})`);
  if (code === "invalid_client" || code === "unauthorized_client" || status === 401) {
    return new ServiceError("trakt", 401, "Trakt refused Athena's app. Check the client ID under Edit, then sign in again.", true);
  }
  if (code === "invalid_grant" || status === 400) return new ServiceError("trakt", 400, "Trakt didn't accept the sign-in. Sign in again", true);
  if (status === 429) return new ServiceError("trakt", 429, "Trakt is limiting how often Athena can ask right now. Try again in a few minutes.");
  return new ServiceError("trakt", status >= 500 ? status : 502, "Trakt is having trouble right now. Try again in a few minutes.");
}

async function tokenRequest(body: Record<string, string>): Promise<StoredTokens> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(TRAKT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await sleep(lifeRetryWaits.ms[attempt]);
        continue;
      }
      throw new ServiceError("trakt", 503, "Couldn't reach Trakt to renew the sign-in");
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && typeof json?.access_token === "string") {
      return {
        access_token: json.access_token,
        refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
        expires_in: typeof json.expires_in === "number" ? json.expires_in : undefined,
        token_type: typeof json.token_type === "string" ? json.token_type : undefined,
        obtained_at: Date.now(),
      };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < lifeRetryWaits.ms.length) {
      await sleep(lifeRetryWaits.ms[attempt]);
      continue;
    }
    throw tokenRefusal(res.status, json);
  }
}

/** The code is swapped with the verifier that made the sign-in's challenge. No client secret is sent. */
export function exchangeTraktCode(input: { code: string; redirectUri: string; verifier: string; client: { client_id: string } }): Promise<StoredTokens> {
  return tokenRequest({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.client.client_id,
    code_verifier: input.verifier,
  });
}

// ---------- requests ----------

function expired(t: StoredTokens): boolean {
  const at = t.obtained_at ?? 0;
  const life = t.expires_in ?? 0;
  return !!at && !!life && Date.now() > at + (life - 60) * 1000;
}

/**
 * Where the signed-in user's own lists are read. The bare GET /sync/history,
 * /sync/ratings and /sync/watchlist came back as empty lists for a full
 * account (10 Nov 2026); Trakt's current reference (docs.trakt.tv) lists the
 * reads under /users/{id}/…. "me" here stands for the account's own slug:
 * TraktSession.get swaps in the slug from /users/settings before asking.
 */
export const TRAKT_READ = {
  history: "/users/me/history/",
  historyOf: (type: "movies" | "episodes") => `/users/me/history/${type}`,
  ratings: "/users/me/ratings/",
  watchlist: "/users/me/watchlist/movie,show/added",
  /** One row per film or show with its last watch: the fallback when history comes back empty. */
  watched: (type: "movies" | "shows") => `/users/me/watched/${type}`,
} as const;

export interface TraktPage<T> {
  items: T;
  page: number;
  pageCount: number;
  /** Trakt's own count of items across all pages (x-pagination-item-count), when it sends one. */
  itemCount?: number;
  /** Size of the reply, for the logs. */
  bytes: number;
}

/** One Trakt account, signed in. */
export class TraktSession {
  private renewing: Promise<string> | null = null;
  private slug: Promise<string> | null = null;

  constructor(
    readonly connector: Pick<Connector, "id">,
    private readonly secrets: ConnectorSecrets,
  ) {}

  private get tokens(): StoredTokens | undefined {
    return this.secrets.tokens as StoredTokens | undefined;
  }

  private async accessToken(): Promise<string> {
    const t = this.tokens;
    if (t?.access_token && !expired(t)) return t.access_token;
    return this.renew();
  }

  /** Once, however many requests are waiting. Trakt rotates the refresh token, so the new one is saved, unless the owner signed in again meanwhile. */
  private renew(): Promise<string> {
    this.renewing ??= this.doRenew().finally(() => (this.renewing = null));
    return this.renewing;
  }

  private async doRenew(): Promise<string> {
    const refreshToken = this.tokens?.refresh_token;
    if (!refreshToken) throw new ServiceError("trakt", 401, "Trakt didn't accept the sign-in. Sign in again", true);
    const client = this.secrets.ownClient;
    if (!client?.client_id) throw new ServiceError("trakt", 401, "No Trakt app is saved for this account. Add its client ID under Edit.", true);
    const fresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.client_id,
      redirect_uri: this.secrets.redirectUrl ?? "",
    });
    const tokens: StoredTokens = { ...fresh, refresh_token: fresh.refresh_token ?? refreshToken };
    this.secrets.tokens = { ...tokens };
    await traktTokenStore.save(this.connector.id, (s) => {
      if ((s.tokens as StoredTokens | undefined)?.refresh_token !== refreshToken) return;
      s.tokens = { ...tokens };
    });
    return tokens.access_token!;
  }

  /** The signed-in account's slug, from /users/settings, asked once per session. */
  userSlug(): Promise<string> {
    this.slug ??= this.get<{ user?: { username?: string; ids?: { slug?: string } } }>("/users/settings").then(
      (r) => {
        const slug = r.items?.user?.ids?.slug ?? r.items?.user?.username;
        if (!slug) throw new ServiceError("trakt", 502, "Trakt didn't say which account this is. Sign in again.", true);
        return slug;
      },
      (error) => {
        this.slug = null;
        throw error;
      },
    );
    return this.slug;
  }

  /** GET a path on api.trakt.tv. "/users/me/…" is the signed-in account's own (its slug). A 401 renews once and tries again. */
  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<TraktPage<T>> {
    if (path.startsWith("/users/me/")) path = `/users/${encodeURIComponent(await this.userSlug())}/${path.slice("/users/me/".length)}`;
    const url = new URL(`${TRAKT_API}${path}`);
    if (url.origin !== TRAKT_API) throw new Error("Athena only reads from api.trakt.tv");
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const clientId = this.secrets.ownClient?.client_id;
    if (!clientId) throw new ServiceError("trakt", 401, "No Trakt app is saved for this account. Add its client ID under Edit.", true);
    let renewed = false;
    for (;;) {
      const token = await this.accessToken();
      const res = await getText(
        "trakt",
        url.toString(),
        { Accept: "application/json", "Content-Type": "application/json", "trakt-api-version": "2", "trakt-api-key": clientId, Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
        { unreachable: "Trakt is having trouble right now. Try again in a few minutes.", busy: "Trakt is limiting how often Athena can ask right now. Try again in a few minutes." },
      );
      if (res.status === 401 && !renewed && this.tokens?.refresh_token) {
        renewed = true;
        this.secrets.tokens = { ...this.tokens, access_token: undefined };
        continue;
      }
      if (res.status === 401) throw new ServiceError("trakt", 401, "Trakt didn't accept the sign-in. Sign in again", true);
      // 403: the API key (client ID) is wrong or the app isn't approved.
      if (res.status === 403) throw new ServiceError("trakt", 403, "Trakt refused Athena's app. Check the client ID under Edit, then sign in again.", true);
      // 423: Trakt has locked or deactivated the account.
      if (res.status === 423) throw new ServiceError("trakt", 423, "Trakt says this account is locked. Sign in at trakt.tv to sort it out, then try again.", true);
      if (res.status === 404) throw new ServiceError("trakt", 404, "Trakt couldn't find that.");
      if (res.status < 200 || res.status >= 300) throw new ServiceError("trakt", res.status, `Trakt refused that (${res.status}).`);
      // A 200 with no body isn't "nothing there": Trakt sends [] for an empty list. Say so rather than load nothing.
      if (!res.text && res.status !== 204) throw new ServiceError("trakt", 502, "Trakt sent an empty reply. Try again in a few minutes.");
      let items: T;
      try {
        items = (res.text ? JSON.parse(res.text) : []) as T;
      } catch {
        throw new ServiceError("trakt", 502, "Trakt is having trouble right now. Try again in a few minutes.");
      }
      const page = Number(res.headers.get("x-pagination-page")) || 1;
      const pageCount = Number(res.headers.get("x-pagination-page-count")) || page;
      const itemCount = res.headers.get("x-pagination-item-count");
      return { items, page, pageCount, ...(itemCount !== null && itemCount !== "" ? { itemCount: Number(itemCount) } : {}), bytes: res.text.length };
    }
  }
}
