// Turns a gesture (toolbar, menu, shortcut) into an outbox job.

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function isSavablePage(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

/**
 * Whether Athena can fetch an image URL itself. Anything on a private
 * network, a local name, data:/blob:, or with a password in it isn't public,
 * so the extension sends the bytes too.
 */
export function isPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":")) return false; // intranet names, localhost
  if (/\.(local|internal|lan|home|corp|localhost|test)$/.test(host)) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  if (host.includes(":")) {
    if (host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80")) return false;
  }
  return true;
}

export function pageJob(tab, note) {
  return {
    kind: "page",
    title: tab.title || tab.url,
    payload: { url: tab.url, title: tab.title || "", ...(note ? { note } : {}) },
  };
}

/** A quote keeps the selected text exactly as it was selected. */
export function selectionJob(tab, text) {
  return {
    kind: "selection",
    title: tab.title || tab.url,
    payload: { selection: text, url: tab.url, title: tab.title || "" },
  };
}

export function linkJob(tab, linkUrl, linkText) {
  return {
    kind: "link",
    title: linkText || linkUrl,
    payload: { url: linkUrl, title: linkText || "", source_url: tab.url },
  };
}

/** image: { dataUrl, name } when the bytes were read from the page. */
export function imageJob(tab, srcUrl, image, warning) {
  const isData = /^data:/i.test(srcUrl);
  return {
    kind: "image",
    title: tab.title ? `Image from ${tab.title}` : "Image",
    payload: {
      // Without bytes, the URL rides in `image` so Athena saves an image, not a link.
      ...(isData ? {} : image ? { url: srcUrl } : { url: srcUrl, image: srcUrl }),
      source_url: tab.url,
      title: tab.title || "",
    },
    image: image || null,
    warning: warning || null,
  };
}
