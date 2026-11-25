/**
 * The first-paint script: inlined into index.html's <head> by vite.config.ts,
 * after the theme-color and color-scheme metas and before any stylesheet, so
 * the first frame is already in the right scheme (a tab, a reload, or the
 * installed app's cold start). It does what applyAppearance() in
 * appearance.ts does, in plain ES5 with no imports; appearance.test.ts runs
 * both and checks they agree.
 */

import { APPEARANCE_KEY, DARK_QUERY } from "./appearance";

export const BOOT_SCRIPT = `(function () {
  var d = document, r = d.documentElement, c = "system", k = null;
  try { k = localStorage.getItem(${JSON.stringify(APPEARANCE_KEY)}); } catch (e) {}
  if (k === "light" || k === "dark") c = k;
  var s = c !== "system" ? c : window.matchMedia && window.matchMedia(${JSON.stringify(DARK_QUERY)}).matches ? "dark" : "light";
  r.setAttribute("data-appearance", c);
  r.setAttribute("data-scheme", s);
  var m = d.querySelector('meta[name="color-scheme"]');
  if (m) m.setAttribute("content", s);
  var t = d.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < t.length; i++) { var v = t[i].getAttribute("data-" + s); if (v) t[i].setAttribute("content", v); }
})();`;

/** Where vite.config.ts puts it. */
export const BOOT_MARKER = "<!-- appearance: first paint -->";
