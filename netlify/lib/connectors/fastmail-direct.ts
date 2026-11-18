/**
 * Fastmail email without MCP or OAuth: a narrow, read-only adapter over
 * Fastmail's JMAP API (api.fastmail.com), registered in direct.ts.
 *
 * The owner makes an API token in Fastmail (Settings → Privacy & Security →
 * Manage API tokens), read-only, with access to Email, and pastes it. It
 * goes in the Authorization header as a Bearer token. Fastmail's tokens are
 * for JMAP only: calendars and contacts (CalDAV, CardDAV) need an app
 * password, and aren't read here.
 *
 * The tools keep Gmail's names, arguments and JSON fields (fastmail-mail.ts),
 * so collections, precheck and Ask treat a Fastmail account as a Gmail one.
 * Read-only by construction: `call` below refuses any method outside
 * READ_METHODS before it's sent. The one exception, for an account with
 * "Let Athena save drafts" on, is a new draft in the Drafts folder
 * (isDraftCreate); nothing can send, move, flag or delete.
 */
import { FASTMAIL_SESSION_URL, fastmailDirect } from "../../../lib/presets/fastmail";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { canDraft } from "../../../lib/connector-presets";
import { ToolInputError } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import { LifeApiError, lifeAccountProblem, lifeFailure, lifeRetryWaits } from "./lifelog-b-http";
import { FASTMAIL_MAIL_TOOLS, NO_DRAFTS, READ_METHODS, isDraftCreate, fastmailPreview, fastmailRuleLabels, mailboxes, type FastmailContext, type JmapCall, type JmapReply } from "./fastmail-mail";
import { mailGuard, skippedCount } from "./mail-guard";

/**
 * Only Fastmail's own hosts are ever sent the token: fastmail.com and names
 * under it. The session is asked of api.fastmail.com; the API address it
 * names can be another Fastmail host, which the first version refused
 * ("Athena only talks to api.fastmail.com", 12 Nov).
 */
export const isFastmailHost = (host: string): boolean => host === "fastmail.com" || host.endsWith(".fastmail.com");
const MAIL = "urn:ietf:params:jmap:mail";
const USING = ["urn:ietf:params:jmap:core", MAIL];
const REQUEST_TIMEOUT_MS = 30_000;

const BAD_TOKEN = "Fastmail didn't accept that API token. Make a new one in Fastmail → Settings → Privacy & Security → Manage API tokens, and paste it under Edit.";
const NO_MAIL = "That Fastmail token can't read email. Make one with access to Email (read-only is enough), and paste it under Edit.";

function refused(status: number): LifeApiError {
  if (status === 401 || status === 403) return new LifeApiError("fastmail", 401, BAD_TOKEN, true);
  if (status === 429) return new LifeApiError("fastmail", 429, "Fastmail is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("fastmail", status, "Fastmail is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("fastmail", status, `Fastmail refused that (${status})`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request to Fastmail, JSON back. 429, 5xx and dropped connections are retried. A redirect is refused: the token goes nowhere else. */
async function request<T>(url: string, token: string, body: unknown | undefined, fetchImpl: typeof fetch): Promise<T> {
  const at = new URL(url);
  if (at.protocol !== "https:" || !isFastmailHost(at.hostname)) throw new LifeApiError("fastmail", 502, "Fastmail pointed Athena at an address that isn't Fastmail's, so nothing was sent there.");
  for (let attempt = 0; ; ) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await sleep(lifeRetryWaits.ms[attempt++]);
        continue;
      }
      throw new LifeApiError("fastmail", 503, "Couldn't reach Fastmail");
    }
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as T | null;
      if (json === null) throw new LifeApiError("fastmail", 502, "Fastmail's answer couldn't be read");
      return json;
    }
    const error = refused(res.status);
    if (error.retryable && attempt < lifeRetryWaits.ms.length) {
      await sleep(lifeRetryWaits.ms[attempt++]);
      continue;
    }
    throw error;
  }
}

interface Session {
  apiUrl?: string;
  username?: string;
  primaryAccounts?: Record<string, string>;
}

/** Open with the token: the session says which account it is, and one cheap read (the mailboxes) proves it can read mail. */
export async function openFastmail(connector: Connector, secrets: ConnectorSecrets, opts: { fetch?: typeof fetch; now?: () => Date } = {}): Promise<DirectAccount> {
  const token = secrets.token?.trim();
  if (!token) throw new LifeApiError("fastmail", 401, "Paste your Fastmail API token.", true);
  const fetchImpl = opts.fetch ?? fetch;
  const session = await request<Session>(FASTMAIL_SESSION_URL, token, undefined, fetchImpl);
  const accountId = session.primaryAccounts?.[MAIL];
  if (!accountId || !session.apiUrl) throw new LifeApiError("fastmail", 401, NO_MAIL, true);
  const apiUrl = session.apiUrl;
  // "Let Athena save drafts": the one write, and only in the shape isDraftCreate allows.
  const drafts = canDraft(connector);
  const ctx: FastmailContext = {
    async call(calls: JmapCall[]) {
      const bad = calls.find((c) => !READ_METHODS.has(c[0]) && !(drafts && isDraftCreate(c)));
      if (bad) throw new Error(`Athena only reads Fastmail: ${bad[0]} isn't sent`);
      const r = await request<{ methodResponses?: JmapReply[] }>(apiUrl, token, { using: USING, methodCalls: calls.map(([name, args, id]) => [name, { accountId, ...args }, id]) }, fetchImpl);
      return r.methodResponses ?? [];
    },
    email: session.username ?? "",
    drafts,
    mail: mailGuard(connector),
    now: opts.now ?? (() => new Date()),
  };
  // Proves the token reads mail; the tools use the same list (cached on ctx).
  await mailboxes(ctx).catch((error) => {
    if (error instanceof ToolInputError) throw new LifeApiError("fastmail", 401, NO_MAIL, true);
    throw error;
  });
  const tools = fastmailTools(connector);
  return {
    tools,
    mail: { labels: () => fastmailRuleLabels(ctx), preview: (rules) => fastmailPreview(ctx, rules), skipped: () => skippedCount(ctx.mail) },
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { text: `${name} isn't one of this account's tools`, isError: true };
      try {
        return { text: JSON.stringify(await tool.run(ctx, args ?? {})), isError: false };
      } catch (error) {
        if (error instanceof ToolInputError) return { text: error.message, isError: true };
        // A read-only token: reading still works, so this is about drafts, not the account.
        if (name === "create_draft" && error instanceof LifeApiError && error.status === 401) return { text: NO_DRAFTS, isError: true };
        if (error instanceof LifeApiError && error.service === "fastmail" && !error.owner && !error.retryable) return { text: error.message, isError: true };
        throw error;
      }
    },
  };
}

/** create_draft only once "Let Athena save drafts" is on for the account. */
export function fastmailTools(connector: Pick<Connector, "provider" | "scope">) {
  return FASTMAIL_MAIL_TOOLS.filter((t) => t.name !== "create_draft" || canDraft(connector));
}

export const fastmailAdapter: DirectAdapter = {
  id: "fastmail",
  handles: fastmailDirect,
  tools: fastmailTools,
  serverInfo: () => ({ website_url: "https://app.fastmail.com/mail/" }),
  open: (connector, secrets) => openFastmail(connector, secrets),
  accountProblem: (e) => lifeAccountProblem("fastmail", e),
  failure: (e) => lifeFailure("fastmail", e),
};
