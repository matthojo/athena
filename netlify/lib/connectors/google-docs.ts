/**
 * Google Docs accounts (lib/presets/documents.ts): where "Send to Google
 * Docs" writes. Registered in direct.ts for sign-in and status only: it has
 * no tools, so no collection, Ask answer or Claude ever reads or writes
 * through it. lib/documents.ts calls the functions below itself.
 *
 * Narrow by construction. The token is drive.file only, so Google shows
 * Athena nothing but the files it made. On top of that, every request goes
 * through docsRequest, which refuses anything googleDocsRequestProblem
 * (lib/documents-rules.ts) doesn't allow: find or make the Athena folder,
 * make a doc in it, fill or rewrite a doc Athena made, rename or trash one.
 * Ids are checked against document_exports, Athena's own list.
 * Tokens, document text and request addresses are never logged.
 */
import { getConnectorWithSecrets, type Connector, type ConnectorSecrets } from "../../../lib/connectors";
import { AthenaInputError } from "../../../lib/db";
import {
  ATHENA_FOLDER,
  DOC_MIME,
  DRIVE_FILES_URL,
  DOCS_API_URL,
  FOLDER_MIME,
  docsLink,
  googleDocsRequestProblem,
  markdownToDocsRequests,
  type GoogleDocsRequest,
} from "../../../lib/documents-rules";
import { GoogleSession, GoogleTokenError, authorizationUrl, exchangeCode } from "./google-api";
import type { DirectAdapter } from "./direct";

const REQUEST_TIMEOUT_MS = 30_000;

/** Google refused a Docs or Drive request. `message` is plain English for the owner. */
export class DocsApiError extends Error {
  constructor(
    readonly status: number,
    readonly reasons: string[],
    detail: string,
  ) {
    super(docsMessage(status, reasons, detail));
    this.name = "DocsApiError";
  }
  get disabled(): boolean {
    return this.status === 403 && this.reasons.some((r) => r === "SERVICE_DISABLED" || r === "accessNotConfigured");
  }
  get missingPermission(): boolean {
    return this.status === 403 && this.reasons.some((r) => r === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || r === "insufficientPermissions");
  }
}

function docsMessage(status: number, reasons: string[], detail: string): string {
  if (status === 401) return "Google didn't accept the sign-in. Sign in again";
  if (status === 403 && reasons.some((r) => r === "SERVICE_DISABLED" || r === "accessNotConfigured")) return "Turn on the Google Docs API and the Google Drive API in your Google Cloud project, then try again.";
  if (status === 403 && reasons.some((r) => /SCOPE_INSUFFICIENT|insufficientPermissions/.test(r))) return "Sign in again and allow Athena to make files in your Drive.";
  if (status === 404) return "Google couldn't find that doc. It may have been deleted.";
  if (status === 429 || status >= 500) return "Google is busy right now. Try again in a few minutes.";
  return `Google refused that (${status}): ${detail}`;
}

/** One request, after the gate. A 401 renews the token once; a GET is retried once on 429 or 5xx. Writes are never retried, so nothing is made twice. */
export async function docsRequest(session: Pick<GoogleSession, "accessToken" | "renew">, req: GoogleDocsRequest, owned: ReadonlySet<string>, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const problem = googleDocsRequestProblem(req, owned);
  if (problem) throw new AthenaInputError(`Athena won't do that in Google Docs: ${problem}`);
  let renewed = false;
  let retried = false;
  for (;;) {
    const token = await session.accessToken();
    let res: Response;
    try {
      res = await fetcher(req.url, {
        method: req.method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new DocsApiError(503, ["unreachable"], "Couldn't reach Google");
    }
    if (res.ok) return res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, unknown>);
    const body = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> } } | null;
    const reasons = [...(body?.error?.errors ?? []).map((e) => e.reason), ...(body?.error?.details ?? []).map((d) => d.reason)].filter((r): r is string => typeof r === "string");
    if (res.status === 401 && !renewed) {
      renewed = true;
      await session.renew();
      continue;
    }
    if (req.method === "GET" && !retried && (res.status === 429 || res.status >= 500)) {
      retried = true;
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    throw new DocsApiError(res.status, reasons, (body?.error?.message ?? `HTTP ${res.status}`).slice(0, 300));
  }
}

export interface DocsAccount {
  request(req: GoogleDocsRequest, owned: ReadonlySet<string>): Promise<Record<string, unknown>>;
}

/** A signed-in Google Docs account, ready for docsRequest. */
export async function openDocsAccount(connectorId: string, fetcher: typeof fetch = fetch): Promise<DocsAccount> {
  const found = await getConnectorWithSecrets(connectorId);
  if (!found || found.connector.provider !== "google-docs") throw new AthenaInputError("That isn't a Google Docs account");
  if (!found.secrets.tokens) throw new AthenaInputError(`Sign in to ${found.connector.name} in Sources first`);
  const session = new GoogleSession(found.connector, found.secrets);
  return { request: (req, owned) => docsRequest(session, req, owned, fetcher) };
}

const folderQuery = () =>
  `${DRIVE_FILES_URL}?${new URLSearchParams({ q: `mimeType='${FOLDER_MIME}' and name='${ATHENA_FOLDER}' and trashed=false`, fields: "files(id)", pageSize: "1" })}`;

/** The Athena folder: the one on record, else one drive.file can see (Athena made it before), else a new one. */
async function folder(account: DocsAccount, known: string | null, owned: Set<string>): Promise<{ id: string; made: boolean }> {
  if (known && owned.has(known)) return { id: known, made: false };
  const found = (await account.request({ method: "GET", url: folderQuery() }, owned)).files as Array<{ id?: string }> | undefined;
  const id = found?.[0]?.id;
  if (id) {
    owned.add(id);
    return { id, made: true };
  }
  const made = await account.request({ method: "POST", url: `${DRIVE_FILES_URL}?fields=id`, body: { name: ATHENA_FOLDER, mimeType: FOLDER_MIME } }, owned);
  if (typeof made.id !== "string") throw new DocsApiError(502, [], "Google didn't say which folder it made");
  owned.add(made.id);
  return { id: made.id, made: true };
}

/** A new doc in the Athena folder, filled from Markdown. If filling fails, the empty doc is trashed again. */
export async function createDoc(account: DocsAccount, input: { title: string; markdown: string; folderId: string | null; owned: Set<string> }): Promise<{ id: string; url: string; folderId: string; folderMade: boolean }> {
  const f = await folder(account, input.folderId, input.owned);
  const made = await account.request(
    { method: "POST", url: `${DRIVE_FILES_URL}?fields=id,webViewLink`, body: { name: input.title.slice(0, 200), mimeType: DOC_MIME, parents: [f.id] } },
    input.owned,
  );
  if (typeof made.id !== "string") throw new DocsApiError(502, [], "Google didn't say which doc it made");
  input.owned.add(made.id);
  const requests = markdownToDocsRequests(input.markdown);
  if (requests.length) {
    try {
      await account.request({ method: "POST", url: `${DOCS_API_URL}/${made.id}:batchUpdate`, body: { requests } }, input.owned);
    } catch (error) {
      await account.request({ method: "PATCH", url: `${DRIVE_FILES_URL}/${made.id}`, body: { trashed: true } }, input.owned).catch(() => undefined);
      throw error;
    }
  }
  return { id: made.id, url: docsLink(made.webViewLink, made.id), folderId: f.id, folderMade: f.made };
}

/** Rewrite a doc Athena made: clear it, write the note again, and keep the name in step. */
export async function replaceDoc(account: DocsAccount, input: { id: string; title: string; markdown: string; owned: Set<string> }): Promise<void> {
  const doc = await account.request({ method: "GET", url: `${DOCS_API_URL}/${input.id}?fields=body.content(endIndex)` }, input.owned);
  const content = ((doc.body as { content?: Array<{ endIndex?: number }> } | undefined)?.content ?? []).map((c) => c.endIndex ?? 0);
  const end = Math.max(1, ...content);
  const requests = [...(end - 1 > 1 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } }] : []), ...markdownToDocsRequests(input.markdown)];
  if (requests.length) await account.request({ method: "POST", url: `${DOCS_API_URL}/${input.id}:batchUpdate`, body: { requests } }, input.owned);
  await account.request({ method: "PATCH", url: `${DRIVE_FILES_URL}/${input.id}`, body: { name: input.title.slice(0, 200) } }, input.owned);
}

export async function trashDoc(account: DocsAccount, input: { id: string; trashed: boolean; owned: Set<string> }): Promise<void> {
  await account.request({ method: "PATCH", url: `${DRIVE_FILES_URL}/${input.id}`, body: { trashed: input.trashed } }, input.owned);
}

// ---------- direct.ts: sign-in and status ----------

const NOTHING = { text: "Google Docs has nothing to read here: Athena only writes the notes you send.", isError: true };

export const googleDocsAdapter: DirectAdapter = {
  id: "google-docs",
  handles: (c) => c.provider === "google-docs" && c.auth_type === "oauth",
  tools: () => [],
  serverInfo: () => ({ website_url: "https://docs.google.com" }),
  async open(connector: Connector, secrets: ConnectorSecrets) {
    if (!secrets.tokens) throw new GoogleTokenError("not_signed_in", "Not signed in yet");
    // The cheapest proof the sign-in works: drive.file's view of Athena's folder.
    const session = new GoogleSession(connector, secrets);
    await docsRequest(session, { method: "GET", url: folderQuery() }, new Set());
    return { tools: [], call: async () => NOTHING };
  },
  authorizationUrl,
  exchangeCode: ({ code, redirectUri, verifier, client }) => exchangeCode({ code, redirectUri, verifier, client }),
  accountProblem: (error) => (error instanceof GoogleTokenError && error.needsOwner) || (error instanceof DocsApiError && (error.status === 401 || error.disabled || error.missingPermission)),
  failure(error) {
    if (!(error instanceof DocsApiError)) return null;
    if (error.status === 401 || error.missingPermission) return { status: "needs_auth", detail: error.message };
    return { status: "error", detail: error.message };
  },
};
