/**
 * Minimal DOM-builder helper so the rest of the app (components/*, views/*)
 * can write declarative markup without pulling in a framework. Used by every
 * component and view module in this project.
 */

type Children = (Node | string | null | undefined | false)[];
type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Children
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

/** Parse a trusted inline SVG string into an Element (used by icons.ts only). */
export function svg(markup: string): SVGSVGElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = markup.trim();
  return wrap.firstElementChild as SVGSVGElement;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(parent: Element, child: Node): void {
  clear(parent);
  parent.append(child);
}
