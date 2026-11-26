/**
 * Site-wide login gate for the Athena PWA's browser pages.
 *
 * Netlify Edge Functions run before static asset serving, which is the only
 * mechanism that can require auth on "/", the JS/CSS bundle, and the
 * manifest — a regular Netlify Function (netlify/functions/*.ts) never sees
 * those requests at all.
 *
 * This deliberately replaces Netlify's built-in site-wide password
 * protection rather than layering on top of it: that feature gates every
 * request at the edge, including /api/* and /mcp, with interactive Basic
 * Auth. MCP clients, the browser extension and Shortcuts only ever send
 * `Authorization: Bearer <token>` — they can't complete a Basic Auth
 * challenge — so turning it on would lock them out along with everyone
 * else. /api/* and /mcp are passed straight through here, untouched,
 * and keep using the bearer-token check in netlify/lib/mcp/bearer.ts.
 *
 * Session model: one shared password (env var SITE_PASSWORD) — this is a
 * personal single-user app, so there's no user table. A correct password at
 * POST /login issues a signed, HttpOnly, Secure cookie:
 * "<expiry-epoch-seconds>.<base64url HMAC-SHA256 of the expiry>", verified
 * with a constant-time comparison on every subsequent request. No server-side
 * session store — the cookie itself is the credential, the same tradeoff
 * MCP_BEARER_TOKEN already makes for the API.
 *
 * SESSION_SECRET is a separate secret from MCP_BEARER_TOKEN on purpose: the
 * bearer token is handed to the clients that call /api and /mcp, while the
 * session secret never leaves this function — a
 * leaked connector token can't be used to forge a browser session cookie.
 */

declare const Deno: { env: { get(key: string): string | undefined } };

const COOKIE_NAME = "athena_session";
const SESSION_DAYS = 30;

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(sig));
}

/** Constant-time for equal-length inputs; a length mismatch is an immediate
 * reject, same tradeoff netlify/lib/mcp/bearer.ts already makes. */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function makeSessionCookie(secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400;
  const sig = await hmacSha256(secret, String(exp));
  return `${COOKIE_NAME}=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}`;
}

async function hasValidSession(cookieHeader: string | null, secret: string): Promise<boolean> {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const [expStr, sig] = match[1].split(".");
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacSha256(secret, expStr);
  return timingSafeStringEqual(sig, expected);
}

// Self-contained (no app bundle — it isn't served until you're signed in),
// but on the same tokens as app/src/styles/tokens.css: light by default,
// dark when the OS is, Funnel Display + Geist from the ungated /fonts/ path.
function loginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" content="#f4f6f8" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#0c0e13" media="(prefers-color-scheme: dark)" />
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
<title>Sign in · Athena</title>
<style>
  @font-face { font-family: "Funnel Display"; src: url("/fonts/funnel-display-latin.woff2") format("woff2"); font-weight: 500 600; font-display: swap; }
  @font-face { font-family: "Geist"; src: url("/fonts/geist-latin.woff2") format("woff2"); font-weight: 400 600; font-display: swap; }
  :root {
    color-scheme: light;
    --canvas: oklch(0.972 0.004 264); --surface: oklch(0.993 0.002 264); --sunken: oklch(0.955 0.005 264);
    --line: oklch(0.915 0.006 264); --line-strong: oklch(0.87 0.008 264);
    --ink: oklch(0.21 0.012 264); --ink-2: oklch(0.43 0.014 264); --ink-3: oklch(0.52 0.012 264); --on-ink: oklch(0.985 0.003 264);
    --accent: oklch(0.53 0.2 264); --accent-wash: oklch(0.95 0.03 264); --bad: oklch(0.55 0.19 25);
    --aurora-a: oklch(0.86 0.09 240 / 0.6); --aurora-b: oklch(0.91 0.1 165 / 0.55);
    --shadow: 0 2px 6px oklch(0.3 0.03 264 / 0.06), 0 18px 44px -14px oklch(0.3 0.04 264 / 0.26);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --canvas: oklch(0.165 0.01 264); --surface: oklch(0.205 0.012 264); --sunken: oklch(0.245 0.012 264);
      --line: oklch(0.29 0.012 264); --line-strong: oklch(0.34 0.014 264);
      --ink: oklch(0.95 0.006 264); --ink-2: oklch(0.79 0.01 264); --ink-3: oklch(0.68 0.012 264); --on-ink: oklch(0.18 0.012 264);
      --accent: oklch(0.7 0.15 264); --accent-wash: oklch(0.29 0.06 264); --bad: oklch(0.7 0.16 25);
      --aurora-a: oklch(0.42 0.12 250 / 0.26); --aurora-b: oklch(0.45 0.09 168 / 0.16);
      --shadow: 0 1px 0 oklch(1 0 0 / 0.05) inset, 0 18px 44px -14px oklch(0 0 0 / 0.6);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px;
    background: var(--canvas); color: var(--ink); font: 400 16px/1.55 "Geist", ui-sans-serif, system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased; overflow-x: hidden; }
  .aurora { position: fixed; inset: 0 0 auto; height: 420px; z-index: -1; pointer-events: none; overflow: hidden; }
  .aurora span { position: absolute; border-radius: 50%; filter: blur(60px); }
  .aurora span:first-child { width: 340px; height: 260px; top: -140px; left: -60px; background: var(--aurora-a); }
  .aurora span:last-child { width: 300px; height: 240px; top: -120px; left: 42%; background: var(--aurora-b); }
  .card { width: min(400px, 100%); display: flex; flex-direction: column; gap: 24px; padding: 32px 24px;
    background: var(--surface); border: 1px solid var(--line); border-radius: 24px; box-shadow: var(--shadow);
    animation: rise 520ms cubic-bezier(0.25, 1, 0.5, 1) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  .mark { width: 36px; height: 36px; color: var(--ink); }
  h1 { margin: 0; font: 500 28px/1.08 "Funnel Display", "Geist", ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.022em; }
  .lede { margin: 8px 0 0; font-size: 14px; color: var(--ink-2); }
  form { display: flex; flex-direction: column; gap: 12px; }
  label { font-size: 14px; font-weight: 500; margin-bottom: -8px; }
  input { width: 100%; height: 48px; padding: 0 14px; font: inherit; color: var(--ink); background: var(--sunken);
    border: 1px solid var(--line); border-radius: 12px; outline: none; transition: border-color 200ms, box-shadow 200ms, background-color 200ms; }
  input:focus { background: var(--surface); border-color: var(--line-strong); box-shadow: 0 0 0 4px var(--accent-wash); }
  button { height: 44px; margin-top: 4px; font-family: inherit; font-size: 14px; font-weight: 500; color: var(--on-ink); background: var(--ink);
    border: 0; border-radius: 999px; cursor: pointer; transition: transform 120ms cubic-bezier(0.25, 1, 0.5, 1); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .error { margin: 0; font-size: 13px; color: var(--bad); }
</style>
</head>
<body>
  <div class="aurora" aria-hidden="true"><span></span><span></span></div>
  <main class="card">
    <svg class="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 6.2 6.2 16.8M12 6.2l5.8 10.6M6.2 16.8h11.6" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="12" cy="6.2" r="2.7" style="fill: var(--accent)"/>
      <circle cx="6.2" cy="16.8" r="2.7" fill="currentColor"/>
      <circle cx="17.8" cy="16.8" r="2.7" fill="currentColor"/>
    </svg>
    <div>
      <h1>Welcome back</h1>
      <p class="lede">Sign in to your second brain.</p>
    </div>
    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input id="password" type="password" name="password" autofocus autocomplete="current-password" required${error ? ' aria-describedby="login-error" aria-invalid="true"' : ""} />
      ${error ? `<p class="error" id="login-error" role="alert">${error}</p>` : ""}
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

interface EdgeContext {
  next: () => Promise<Response>;
}

export default async (request: Request, context: EdgeContext): Promise<Response> => {
  const url = new URL(request.url);

  // /api/* and /mcp keep using the existing bearer-token check — never gated here.
  // /fonts/ and /icons/ are public static assets the login page itself needs.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/mcp" ||
    url.pathname.startsWith("/fonts/") ||
    url.pathname.startsWith("/icons/")
  ) {
    return context.next();
  }

  const password = Deno.env.get("SITE_PASSWORD");
  const sessionSecret = Deno.env.get("SESSION_SECRET");
  if (!password || !sessionSecret) {
    // Misconfigured — fail closed rather than silently serving the site unauthenticated.
    return new Response("Athena login isn't configured yet (missing SITE_PASSWORD or SESSION_SECRET).", { status: 503 });
  }

  if (url.pathname === "/login" && request.method === "POST") {
    const form = await request.formData();
    const submitted = String(form.get("password") ?? "");
    if (timingSafeStringEqual(submitted, password)) {
      return new Response(null, {
        status: 303,
        headers: { Location: "/", "Set-Cookie": await makeSessionCookie(sessionSecret) },
      });
    }
    return new Response(loginPage("Wrong password."), { status: 401, headers: { "Content-Type": "text/html" } });
  }

  if (url.pathname === "/logout") {
    return new Response(null, {
      status: 303,
      headers: { Location: "/login", "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0` },
    });
  }

  if (await hasValidSession(request.headers.get("cookie"), sessionSecret)) {
    return context.next();
  }

  if (url.pathname === "/login") {
    return new Response(loginPage(), { status: 200, headers: { "Content-Type": "text/html" } });
  }

  return new Response(null, { status: 303, headers: { Location: "/login" } });
};

// Talk's session is a WebSocket (netlify/server/routes/talk.ts). An edge function in front of it hands the server a plain GET,
// without the Upgrade header, and the server answers 426 (seen in production, 11 Nov 2026). This function never gated /api/*
// anyway (it passes them straight on, above), so the socket's path skips it: nothing is less protected, and its own ticket still guards it.
export const config = { path: "/*", excludedPath: ["/api/talk/session"] };
