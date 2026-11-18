export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type ViewTransitionDoc = Document & { startViewTransition?: (update: () => void) => unknown };

/** Runs a DOM update inside a View Transition where supported; otherwise just runs it. */
export function withTransition(update: () => void): void {
  const doc = document as ViewTransitionDoc;
  if (!doc.startViewTransition || prefersReducedMotion()) {
    update();
    return;
  }
  doc.startViewTransition(update);
}

export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
