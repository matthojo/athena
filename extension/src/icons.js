// Inline status icons, drawn with currentColor.
export const ICON = {
  good: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8"/><path d="m6.5 10.2 2.3 2.3 4.7-5"/></svg>',
  warn: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8"/><path d="M10 6v4.5l2.5 1.5"/></svg>',
  bad: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8"/><path d="M10 6v5M10 14h.01"/></svg>',
  busy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M10 2a8 8 0 1 1-8 8"/></svg>',
};

/** Fills a .status element with an icon and a line of text (and optional link). */
export function setStatus(el, tone, text, link) {
  el.className = `status ${tone}`;
  el.replaceChildren();
  if (ICON[tone]) el.append(new DOMParser().parseFromString(ICON[tone], "image/svg+xml").documentElement);
  const span = document.createElement("span");
  span.textContent = text;
  if (link) {
    span.append(" ");
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = link.text;
    span.append(a);
  }
  el.append(span);
  el.hidden = false;
}

export function send(type, data = {}) {
  const ext = globalThis.browser ?? globalThis.chrome;
  return ext.runtime.sendMessage({ type, ...data });
}
