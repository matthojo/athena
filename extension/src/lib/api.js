// Builds requests to the owner's Athena and reads its answers.
// Contract: docs/notes/saved.md (claude/saved); see docs/notes/save-extension.md.

export const SAVE_PATH = "/api/saved";
export const TEST_PATH = "/api/saved/ping";
export const SOURCE = "extension";

const FIELDS = ["url", "text", "selection", "title", "note", "source_url", "image"];

/** The fields Athena gets for a job, minus the image bytes. */
export function saveFields(job) {
  const out = {};
  for (const name of FIELDS) {
    const value = job.payload?.[name];
    if (typeof value === "string" && value !== "") out[name] = value;
  }
  out.kind = job.kind;
  out.source = SOURCE;
  out.client_id = job.id;
  return out;
}

export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Not a data URL");
  const type = match[1] || "application/octet-stream";
  const bytes = match[2]
    ? Uint8Array.from(atob(match[3]), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(match[3]));
  return new Blob([bytes], { type });
}

/** JSON for most saves; multipart when the job carries image bytes. */
export function buildSaveRequest(settings, job) {
  const headers = { Authorization: `Bearer ${settings.key}`, Accept: "application/json" };
  const fields = saveFields(job);
  if (job.image?.dataUrl) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) if (name !== "image") form.append(name, value);
    const blob = dataUrlToBlob(job.image.dataUrl);
    form.append("image", blob, job.image.name || fileName(blob.type));
    return { url: settings.origin + SAVE_PATH, init: { method: "POST", headers, body: form } };
  }
  return {
    url: settings.origin + SAVE_PATH,
    init: {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    },
  };
}

/**
 * A note for a save Athena already has: the same save again, same client_id,
 * with the note. A capture key can't PATCH, so this is the only way in.
 */
export function buildNoteRequest(settings, job) {
  return buildSaveRequest(settings, { ...job, kind: job.payload.kind, image: null });
}

export function buildTestRequest(settings) {
  return {
    url: settings.origin + TEST_PATH,
    init: { method: "GET", headers: { Authorization: `Bearer ${settings.key}`, Accept: "application/json" } },
  };
}

function fileName(type) {
  const ext = (type.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
  return `image.${ext}`;
}

/**
 * What an answer means for the queue:
 *  ok        – done
 *  auth      – the key was refused; wait for new settings
 *  rejected  – Athena won't take this save as it is; wait for the owner
 *  transient – try again later (offline, 5xx, 429)
 */
export function classify(status, body) {
  const said = typeof body?.error === "string" ? body.error.slice(0, 200) : "";
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status === 401 || status === 403) {
    return { kind: "auth", message: "Athena didn't accept the key. Check it in the extension's settings." };
  }
  if (status === 404 || status === 405) {
    return { kind: "rejected", message: "This Athena can't take saves yet. Update it, then retry." };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500 || status === 0) {
    return { kind: "transient", message: status === 429 ? "Athena asked to slow down." : "Athena didn't answer." };
  }
  return { kind: "rejected", message: said || `Athena refused this save (${status}).` };
}

export const OFFLINE = { kind: "transient", message: "Couldn't reach Athena. It'll try again." };

/** The link to the saved item in Athena. */
export function itemLink(origin, body) {
  if (typeof body?.url === "string") {
    try {
      const url = new URL(body.url, origin);
      if (url.origin === origin) return url.href;
    } catch {
      /* fall through */
    }
  }
  if (body?.id != null) return `${origin}/#/saved/${encodeURIComponent(String(body.id))}`;
  return `${origin}/#/saved`;
}

/** Sends a built request; never throws. */
export async function send(fetchImpl, request) {
  let res;
  try {
    res = await fetchImpl(request.url, { ...request.init, credentials: "omit", redirect: "error" });
  } catch {
    return { ...OFFLINE, status: 0 };
  }
  let body = null;
  try {
    if ((res.headers.get("content-type") || "").includes("json")) body = await res.json();
  } catch {
    body = null;
  }
  return { ...classify(res.status, body), status: res.status, body };
}
