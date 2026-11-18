// Functions injected into the page with scripting.executeScript. Each must be
// self-contained: they're serialised, so they can't use imports or closures.

/** The selection exactly as selected, line breaks and all. */
export function readSelection() {
  const active = document.activeElement;
  if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
    const { selectionStart: s, selectionEnd: e, value } = active;
    if (typeof s === "number" && e > s) return value.slice(s, e);
  }
  return String(window.getSelection?.() ?? "");
}

/** Reads an image the page already shows, as a data URL. */
export async function readImage(src, maxBytes) {
  try {
    const res = await fetch(src, { credentials: "include" });
    if (!res.ok) return { error: "fetch" };
    const blob = await res.blob();
    if (blob.size > maxBytes) return { error: "size" };
    if (!/^image\//.test(blob.type)) return { error: "type" };
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const name = (new URL(src, location.href).pathname.split("/").pop() || "").slice(0, 80);
    return { dataUrl, name };
  } catch {
    return { error: "fetch" };
  }
}

/** A small note in the corner of the page saying what happened. */
export function showToast({ title, detail, link, linkText, tone }) {
  const id = "athena-save-toast";
  document.getElementById(id)?.remove();
  const host = document.createElement("div");
  host.id = id;
  host.dataset.title = title; // the shadow root is closed; this lets a test see which note is up
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { color-scheme: light dark; }
    .t { --bg: oklch(0.993 0.002 264); --ink: oklch(0.21 0.012 264); --ink2: oklch(0.43 0.014 264);
      --line: oklch(0.915 0.006 264); --accent: oklch(0.53 0.2 264); --good: oklch(0.5 0.12 158);
      --warn: oklch(0.53 0.12 65); --bad: oklch(0.55 0.19 25);
      font: 400 14px/1.4 Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      display: flex; gap: 10px; align-items: flex-start; box-sizing: border-box;
      max-width: 320px; padding: 12px 14px; border-radius: 18px; border: 1px solid var(--line);
      background: var(--bg); color: var(--ink);
      box-shadow: 0 2px 6px oklch(0.3 0.03 264 / 0.06), 0 18px 44px -14px oklch(0.3 0.04 264 / 0.26);
      animation: in 320ms cubic-bezier(0.16, 1, 0.3, 1); }
    @media (prefers-color-scheme: dark) { .t { --bg: oklch(0.205 0.012 264); --ink: oklch(0.95 0.006 264);
      --ink2: oklch(0.79 0.01 264); --line: oklch(0.29 0.012 264); --accent: oklch(0.7 0.15 264);
      --good: oklch(0.72 0.14 158); --warn: oklch(0.78 0.12 80); --bad: oklch(0.7 0.16 25);
      box-shadow: 0 1px 0 oklch(1 0 0 / 0.05) inset, 0 18px 44px -14px oklch(0 0 0 / 0.6); } }
    @media (prefers-reduced-motion: reduce) { .t { animation: none; } }
    @keyframes in { from { opacity: 0; transform: translateY(8px); } }
    .dot { flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; display: grid; place-items: center; }
    .dot svg { width: 18px; height: 18px; }
    .good .dot { color: var(--good); } .warn .dot { color: var(--warn); } .bad .dot { color: var(--bad); }
    b { font-weight: 600; display: block; }
    p { margin: 2px 0 0; color: var(--ink2); }
    a { color: var(--accent); font-weight: 500; text-decoration: none; }
    a:hover { text-decoration: underline; }
    a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
    button { all: unset; cursor: pointer; color: var(--ink2); margin-left: 4px; padding: 0 2px; border-radius: 6px; font-size: 16px; line-height: 1; }
    button:focus-visible { outline: 2px solid var(--accent); }
  `;
  const icons = {
    good: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="m6.5 10.2 2.3 2.3 4.7-5"/></svg>',
    warn: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="8"/><path d="M10 6v4.5l2.5 1.5"/></svg>',
    bad: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="8"/><path d="M10 6v5M10 14h.01"/></svg>',
  };
  const box = document.createElement("div");
  box.className = `t ${tone || "good"}`;
  box.setAttribute("role", "status");
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.append(new DOMParser().parseFromString(icons[tone] || icons.good, "image/svg+xml").documentElement);
  const text = document.createElement("div");
  const b = document.createElement("b");
  b.textContent = title;
  text.append(b);
  if (detail || link) {
    const p = document.createElement("p");
    if (detail) p.append(detail + (link ? " " : ""));
    if (link) {
      const a = document.createElement("a");
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = linkText || "Open in Athena";
      p.append(a);
    }
    text.append(p);
  }
  const close = document.createElement("button");
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.onclick = () => host.remove();
  box.append(dot, text, close);
  root.append(style, box);
  document.documentElement.append(host);
  let timer = setTimeout(() => host.remove(), tone === "good" ? 4000 : 8000);
  box.onmouseenter = () => clearTimeout(timer);
  box.onmouseleave = () => (timer = setTimeout(() => host.remove(), 2000));
}
