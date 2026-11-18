// Options validation: the owner's Athena address and a capture key.
// Pure functions, no browser APIs, so they run under node:test.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CAPTURE_KEY = /^athc_[A-Za-z0-9_-]{16,}$/;

/** Turns what the owner pasted into an origin like https://athena.example.com. */
export function normalizeAddress(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "Add your Athena address." };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "That doesn't look like a web address." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Leave the name and password out of the address." };
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !local) {
    return { ok: false, error: "Use the https:// address. Plain http only works for localhost." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Use the https:// address." };
  }
  if (!url.hostname.includes(".") && !local) {
    return { ok: false, error: "That doesn't look like a web address." };
  }
  return { ok: true, origin: url.origin };
}

/** Checks a pasted key is a capture-only key (athc_…). */
export function validateKey(input) {
  const key = String(input ?? "")
    .trim()
    .replace(/^Bearer\s+/i, "");
  if (!key) return { ok: false, error: "Paste a capture key." };
  if (key.startsWith("athk_")) {
    return {
      ok: false,
      error: "That's a full-access key. Make a capture key in Athena (Settings → API keys) and paste that.",
    };
  }
  if (!CAPTURE_KEY.test(key)) {
    return { ok: false, error: "Capture keys start with athc_. Copy the whole key from Athena." };
  }
  return { ok: true, key };
}

export function validateSettings({ address, key } = {}) {
  const a = normalizeAddress(address);
  const k = validateKey(key);
  const errors = {};
  if (!a.ok) errors.address = a.error;
  if (!k.ok) errors.key = k.error;
  if (!a.ok || !k.ok) return { ok: false, errors };
  return { ok: true, settings: { origin: a.origin, key: k.key } };
}

/** The host permission pattern for an origin. */
export function originPattern(origin) {
  return `${origin}/*`;
}

export function isConfigured(settings) {
  return Boolean(settings && settings.origin && settings.key);
}
