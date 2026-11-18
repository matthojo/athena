/**
 * The sticky page header (.notes__head) is see-through until something
 * scrolls under it; then its frosted backdrop fades in (components.css).
 * One listener covers every page: whichever scroller moved (the page on a
 * phone, the main pane on desktop, or a list column of its own), each header
 * it holds learns whether there's now something under it.
 */

const SCROLLED_PAST = 4;

/** The element a header scrolls with, or the document when it's the page itself. */
function scrollerOf(head: HTMLElement): Element | Document {
  for (let el = head.parentElement; el && el !== document.body; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll") return el;
  }
  return document;
}

function update(scroller: Element | Document): void {
  const top = scroller instanceof Document ? window.scrollY : scroller.scrollTop;
  for (const head of scroller.querySelectorAll<HTMLElement>(".notes__head")) {
    if (scrollerOf(head) === scroller) head.classList.toggle("is-scrolled", top > SCROLLED_PAST);
  }
}

export function watchStickyHeads(): void {
  // Scroll events don't bubble, but they do pass through the document on the way down.
  document.addEventListener("scroll", (e) => update(e.target as Element | Document), { capture: true, passive: true });
}
