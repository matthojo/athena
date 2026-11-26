/**
 * Where a "…" menu sits across the screen, as the CSS `right` it's given.
 *
 * A menu hangs from its button's right edge. On a narrow screen the button
 * can wrap to the left of its row (a note's "…" under its chips), and a menu
 * hung from there would run off the left of the screen. So: from the
 * button's right edge when the whole menu fits; otherwise from its left
 * edge; and never nearer than `pad` to either side.
 */
export function menuRight(button: { left: number; right: number }, menuWidth: number, viewport: number, pad = 12): number {
  const most = Math.max(pad, viewport - menuWidth - pad);
  const hung = Math.max(pad, viewport - button.right);
  if (hung <= most) return hung;
  // Doesn't fit to the left of the button's right edge: start at the button's left edge instead.
  return Math.min(most, Math.max(pad, viewport - Math.max(pad, button.left) - menuWidth));
}

/** The same, for an open menu and its button, written straight onto the menu. */
export function placeMenuAcross(menu: HTMLElement, button: Element): void {
  menu.style.right = `${menuRight(button.getBoundingClientRect(), menu.offsetWidth, window.innerWidth)}px`;
}
