/**
 * Claude through Netlify AI Gateway, shared by Ask's assistant
 * (lib/assistant.ts). `new Anthropic()` with no arguments picks up the
 * gateway's injected ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL, so no key is
 * needed; setting your own ANTHROPIC_API_KEY also works.
 *
 * The gateway caps a team's spend per minute (in credits, across every site)
 * and answers past it with a bare 429. The SDK's own quick retries land in
 * the same minute, so createMessage waits for the window to roll over and
 * tries again, a few times at most and only before the caller's deadline.
 * (netlify/lib/connectors/runner.ts has its own copy for now.)
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import Anthropic from "@anthropic-ai/sdk";

export { Anthropic };

function env(name: string): string | undefined {
  return (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name) ?? process.env[name];
}

/** Is there a way to reach Claude (AI Gateway injection or your own key)? */
export function aiConfigured(): boolean {
  return !!(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN") || env("ANTHROPIC_BASE_URL"));
}

/**
 * Running on the Netlify Server (netlify/server/shared.ts sets ATHENA_RUNTIME)? A request there isn't held
 * to a function's time limit, so Ask's time caps that only existed for it are longer (docs/netlify-server-ask.md).
 */
export function onServer(): boolean {
  return env("ATHENA_RUNTIME") === "server";
}

const RATE_LIMIT_WAITS = 4;
const RATE_LIMIT_WAIT_MS = 65_000;

export class RateLimited extends Error {
  /** Seconds until the gateway takes requests again, when it said (its Retry-After). Unset when it didn't. */
  readonly retryAfter?: number;
  constructor(retryAfter?: number) {
    super("Netlify AI Gateway's per-minute spending limit for your team was reached. Try again in a minute.");
    if (retryAfter && Number.isFinite(retryAfter) && retryAfter > 0) this.retryAfter = Math.ceil(retryAfter);
  }
}

/**
 * How long to wait before asking again after the gateway turns a request away, in ms: five times at most, 60 s in all,
 * and never past the caller's deadline. Refusals come in bursts. The production log shows one on 11 Nov from 21:50:00
 * to before 21:51:00, and one on 12 Nov from 22:04:43 to at least 22:05:00, which outlasted the 15 s waited then.
 */
const DENIED_WAITS_MS = [1_000, 4_000, 10_000, 20_000, 25_000];

/**
 * Told before each wait on a refusal: how long it will be, in ms, and which wait this is (1 for the first).
 * For a caller that shows the owner it's waiting. If it throws, the request ends with that error.
 */
export type DeniedWait = (ms: number, attempt: number) => void;

/**
 * The gateway itself turned the request away before it reached the model: a 403
 * with no body, answered in under 2 ms. Seen in production since 11 Nov 2026, only
 * from the Netlify Server, in bursts of up to a minute (docs/notes/ask-gateway-403.md).
 * The cause isn't known, so it's treated as passing: each refusal is logged with what
 * is known (gatewayRefused), and the request is asked again. (A 403 from Claude or
 * Jev carries a body saying why, and isn't this. A credential the gateway doesn't
 * know gets a bare 401.)
 */
export function gatewayDenied(error: unknown): boolean {
  const e = error as { status?: unknown; error?: unknown; body?: unknown } | null;
  if (!e || e.status !== 403) return false;
  const body = e.error ?? e.body;
  return body === undefined || body === null || body === "";
}

// ---------- what the log says about a refusal ----------

export type GatewayProvider = "claude" | "jev";

const CREDENTIAL_ENV: Record<GatewayProvider, string[]> = { claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], jev: ["TYPESAFE_API_KEY"] };
const BASE_URL_ENV: Record<GatewayProvider, string> = { claude: "ANTHROPIC_BASE_URL", jev: "TYPESAFE_BASE_URL" };

/**
 * The credential the environment holds for a provider right now. The platform rewrites it in place while a process
 * lives (on the server every 5 minutes, or with each request it receives, depending on the runtime's version; in a
 * function with each invocation), so a client built earlier can hold an older one.
 */
export function gatewayCredential(provider: GatewayProvider): string | undefined {
  for (const name of CREDENTIAL_ENV[provider]) {
    const value = env(name);
    if (value) return value;
  }
  return undefined;
}

/** A credential as the log may show it: the first 8 hex of its SHA-256. Never the credential or a part of it. */
export function fingerprint(credential: string | null | undefined): string | null {
  return credential ? createHash("sha256").update(credential).digest("hex").slice(0, 8) : null;
}

/** When a JWT says it was issued, takes effect and expires (seconds since 1970). Null for a credential that isn't one. */
function jwtTimes(credential: string | undefined): { iat?: number; nbf?: number; exp?: number } | null {
  const parts = credential?.split(".") ?? [];
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const out: { iat?: number; nbf?: number; exp?: number } = {};
    for (const key of ["iat", "nbf", "exp"] as const) if (typeof claims[key] === "number") out[key] = claims[key];
    return out;
  } catch {
    return null;
  }
}

const SECRET_HEADER = /auth|cookie|token|key|secret|credential|signature|session|password/i;
const LOOKS_SECRET = /eyJ[\w-]{8,}\.|[\w+/=-]{40,}/;

/** A response's headers for the log: none whose name or value could carry a credential, and no long values. */
function loggedHeaders(headers: unknown, credential: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof (headers as Headers).forEach !== "function") return out;
  const half = credential ? Math.ceil(credential.length / 2) : 0;
  const parts = credential ? [credential, credential.slice(0, half), credential.slice(half)].filter((p) => p.length >= 4) : [];
  let count = 0;
  (headers as Headers).forEach((value, name) => {
    if (count >= 30 || SECRET_HEADER.test(name)) return;
    count++;
    out[name.toLowerCase()] = LOOKS_SECRET.test(value) || parts.some((p) => value.includes(p)) ? "[removed]" : value.slice(0, 200);
  });
  return out;
}

type Seen = {
  /** The environment's credential when last looked at, when it last changed (ms), and how often it has. */
  env?: string;
  envSince?: number;
  envChanges: number;
  /** The credential of the last accepted call, and when. */
  accepted?: string;
  acceptedAt?: number;
  /** Refusals since the last accepted call: the credential last refused, when the first came, and how many. */
  refused?: { credential: string | undefined; since: number; count: number };
};
const seen: Record<GatewayProvider, Seen> = { claude: { envChanges: 0 }, jev: { envChanges: 0 } };

/** Look at the environment's credential, and count it when it has changed since the last look. */
function watch(provider: GatewayProvider, now: number): string | undefined {
  const s = seen[provider];
  const current = gatewayCredential(provider);
  if (current !== s.env) {
    if (s.envSince !== undefined) s.envChanges++;
    s.env = current;
    s.envSince = now;
  }
  return current;
}

const seconds = (ms: number): number => Math.round(ms / 1000);

/** The addresses the gateway's name resolves to now: a refusal may belong to one of them. Null when it can't be told quickly. */
async function gatewayAddresses(provider: GatewayProvider): Promise<string[] | null> {
  try {
    const base = env(BASE_URL_ENV[provider]);
    if (!base) return null;
    const found = lookup(new URL(base).hostname, { all: true }).then((all) => all.map((a) => a.address).sort());
    return await Promise.race([found, new Promise<null>((resolve) => setTimeout(() => resolve(null), 250).unref?.())]);
  } catch {
    return null;
  }
}

/** What is known about a refusal, with no secret in it. `next` is what happens now: "retry-now", "wait-4s" or "stop". */
export function refusalFacts(provider: GatewayProvider, error: unknown, credential: string | undefined, next: string, now = Date.now()): Record<string, unknown> {
  const s = seen[provider];
  const current = watch(provider, now);
  const e = error as { headers?: unknown; requestID?: unknown; requestId?: unknown } | null;
  const header = (name: string): string | null => {
    try {
      return (e?.headers as Headers | undefined)?.get?.(name) ?? null;
    } catch {
      return null;
    }
  };
  const id = header("x-nf-request-id") ?? e?.requestID ?? e?.requestId ?? header("request-id");
  const jwt = jwtTimes(credential);
  s.refused = { credential, since: s.refused?.since ?? now, count: (s.refused?.count ?? 0) + 1 };
  return {
    provider,
    runtime: onServer() ? "server" : "function",
    requestId: typeof id === "string" ? id : null,
    credential: fingerprint(credential),
    lastAcceptedCredential: fingerprint(s.accepted),
    envCredential: fingerprint(current),
    sameAsLastAccepted: s.accepted === undefined || !credential ? null : s.accepted === credential,
    sameAsEnv: !current || !credential ? null : current === credential,
    jwt: jwt && {
      ...jwt,
      issuedSecondsAgo: jwt.iat === undefined ? null : seconds(now - jwt.iat * 1000),
      expiresInSeconds: jwt.exp === undefined ? null : seconds(jwt.exp * 1000 - now),
    },
    upSeconds: Math.round(process.uptime()),
    sinceAcceptedSeconds: s.acceptedAt === undefined ? null : seconds(now - s.acceptedAt),
    envChanges: s.envChanges,
    envChangedSecondsAgo: s.envSince === undefined ? null : seconds(now - s.envSince),
    refusals: s.refused.count,
    refusedForSeconds: seconds(now - s.refused.since),
    next,
    headers: loggedHeaders(e?.headers, credential),
  };
}

/** Log a refusal: one line, the same shape for Claude and Jev. Look for "Athena gateway 403" in the server's log. */
export async function gatewayRefused(provider: GatewayProvider, error: unknown, credential: string | undefined, next: string): Promise<void> {
  const facts = refusalFacts(provider, error, credential, next);
  console.warn(`Athena gateway 403 ${JSON.stringify({ ...facts, addresses: await gatewayAddresses(provider) })}`);
}

/** A call was accepted. After refusals, one line says how they ended: "Athena gateway ok after 403". */
export function gatewayAccepted(provider: GatewayProvider, credential: string | undefined, now = Date.now()): void {
  const s = seen[provider];
  watch(provider, now);
  const refused = s.refused;
  s.refused = undefined;
  s.accepted = credential;
  s.acceptedAt = now;
  if (!refused) return;
  const facts = {
    provider,
    runtime: onServer() ? "server" : "function",
    credential: fingerprint(credential),
    sameAsRefused: !credential || !refused.credential ? null : credential === refused.credential,
    refusals: refused.count,
    refusedForSeconds: seconds(now - refused.since),
    upSeconds: Math.round(process.uptime()),
  };
  void gatewayAddresses(provider).then((addresses) => console.warn(`Athena gateway ok after 403 ${JSON.stringify({ ...facts, addresses })}`));
}

/** The credential a client sends, when it has one (a test's stub has none). */
function credentialOf(client: Anthropic): string | undefined {
  const c = client as { apiKey?: unknown; authToken?: unknown };
  return typeof c.apiKey === "string" && c.apiKey ? c.apiKey : typeof c.authToken === "string" && c.authToken ? c.authToken : undefined;
}

/** A client with the credentials as they are now, or the one given when there's nothing to build one from (a test's stub). */
function freshClient(client: Anthropic): Anthropic {
  try {
    // Only a real Claude client is rebuilt: another provider's client (lib/llm) keeps its own credentials, and swapping
    // it would send that provider's model id to Anthropic.
    return aiConfigured() && client instanceof Anthropic ? new Anthropic() : client;
  } catch {
    return client;
  }
}

/** At most this many times in one request is a refusal answered by asking again at once with the environment's newer credential. */
const SWAPS = 3;

/**
 * What to do about refusals within one request. `again(error, client)` logs the refusal and gives the client to ask
 * again with, or null when the refusal stands. When the environment holds a credential the refused client didn't
 * send, that one is tried at once, with no wait and no word to the caller. Otherwise it waits as before.
 */
function refusals(deadline: number, onWait?: DeniedWait): (error: unknown, client: Anthropic) => Promise<Anthropic | null> {
  let denied = 0;
  let swaps = 0;
  const tried = new Set<string>();
  return async (error, client) => {
    const used = credentialOf(client);
    if (used) tried.add(used);
    const current = gatewayCredential("claude");
    if (used && current && !tried.has(current) && swaps < SWAPS) {
      swaps++;
      await gatewayRefused("claude", error, used, "retry-now");
      return freshClient(client);
    }
    if (denied >= DENIED_WAITS_MS.length || Date.now() + DENIED_WAITS_MS[denied] >= deadline) {
      await gatewayRefused("claude", error, used, "stop");
      return null;
    }
    const wait = DENIED_WAITS_MS[denied++];
    await gatewayRefused("claude", error, used, `wait-${wait / 1000}s`);
    onWait?.(wait, denied);
    await new Promise((resolve) => setTimeout(resolve, wait));
    return freshClient(client);
  };
}

/**
 * AI spend (lib/spend.ts registers it): `before` throws when today's budget is used, so the call isn't made;
 * `after` keeps what the call cost. Unset (a test with no spend), calls just run.
 */
export interface SpendHook {
  before(model: string): Promise<void>;
  after(model: string, usage: Anthropic.Usage | undefined): Promise<void>;
}
let spend: SpendHook | null = null;
export function useSpendHook(hook: SpendHook | null): void {
  spend = hook;
}

export async function createMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  deadline: number,
  onWait?: DeniedWait,
): Promise<Anthropic.Message> {
  await spend?.before(params.model);
  const again = refusals(deadline, onWait);
  for (let waits = 0; ; waits++) {
    try {
      const message = await client.messages.create(params);
      gatewayAccepted("claude", credentialOf(client));
      await spend?.after(params.model, message.usage);
      return message;
    } catch (error) {
      if (gatewayDenied(error)) {
        const next = await again(error, client);
        if (!next) throw error;
        client = next;
        waits--;
        continue;
      }
      if (!(error instanceof Anthropic.RateLimitError)) throw error;
      const retryAfter = Number(error.headers?.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_WAIT_MS;
      if (waits >= RATE_LIMIT_WAITS || Date.now() + wait > deadline) throw new RateLimited(retryAfter);
      console.warn(`Athena: AI Gateway rate limit, waiting ${Math.round(wait / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * createMessage, streamed: each raw event goes to onEvent as it arrives (Ask
 * shows the reply's words as they're written, lib/ask-stream.ts), and the
 * whole message comes back at the end, as createMessage's does. A rate limit
 * or a refusal is waited out only before anything has arrived. If onEvent throws (the app
 * stopped listening), the stream is cut off and the error goes to the caller.
 */
export async function streamMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  deadline: number,
  onEvent: (event: Anthropic.MessageStreamEvent) => void,
  onWait?: DeniedWait,
): Promise<Anthropic.Message> {
  await spend?.before(params.model);
  const again = refusals(deadline, onWait);
  for (let waits = 0; ; waits++) {
    let started = false;
    const stream = client.messages.stream(params);
    try {
      for await (const event of stream) {
        started = true;
        onEvent(event);
      }
      const message = await stream.finalMessage();
      gatewayAccepted("claude", credentialOf(client));
      await spend?.after(params.model, message.usage);
      return message;
    } catch (error) {
      stream.abort();
      if (!started && gatewayDenied(error)) {
        const next = await again(error, client);
        if (!next) throw error;
        client = next;
        waits--;
        continue;
      }
      if (started || !(error instanceof Anthropic.RateLimitError)) throw error;
      const retryAfter = Number(error.headers?.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_WAIT_MS;
      if (waits >= RATE_LIMIT_WAITS || Date.now() + wait > deadline) throw new RateLimited(retryAfter);
      console.warn(`Athena: AI Gateway rate limit, waiting ${Math.round(wait / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * Which tool the model's provider refused, when a request failed because one
 * tool's definition isn't valid JSON Schema ("tools.69.custom.input_schema:
 * JSON schema is invalid"): its place in the list sent. Null for any other
 * failure. A connected account's server writes its own tool definitions, so
 * one bad one mustn't take every answer down: the caller drops it and asks
 * again (lib/answer.ts).
 */
export function rejectedTool(error: unknown): number | null {
  const e = error as { status?: unknown; message?: unknown } | null;
  if (!e || e.status !== 400 || typeof e.message !== "string") return null;
  const m = /\btools\.(\d+)\.[\w.]*input_schema\b/.exec(e.message);
  return m ? Number(m[1]) : null;
}
