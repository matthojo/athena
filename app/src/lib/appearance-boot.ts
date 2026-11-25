/**
 * The first-paint script: inlined into index.html's <head> by vite.config.ts,
 * after the theme-color and color-scheme metas and before any stylesheet, so
 * the first frame is already right (a tab, a reload, or the installed app's
 * cold start). In plain ES5 with no imports, it does three things:
 *
 * - The theme: from this device's worked-out copy (athena.theme.paint,
 *   lib/theme.ts), it writes <style id="athena-theme"> the way paintCss()
 *   does, and gives both theme-color metas the theme's page colours. Every
 *   name and value is checked again here, with the same rules as
 *   theme-paint.ts, so a tampered copy can't put anything else on the page.
 * - A person's own font and text size (athena.personal), as personalCss().
 * - The scheme, as applyAppearance() in appearance.ts.
 *
 * appearance.test.ts and theme.test.ts run it and check it agrees with the
 * app's own code.
 */

import { APPEARANCE_KEY, DARK_QUERY } from "./appearance";
import { BLOCKS, FONT_NAME, PAINT_VERSION, PROPERTY, SIZE_LIMITS, SYSTEM_FONT } from "./theme-paint";

const PAINT_KEY = "athena.theme.paint";
const PERSONAL_KEY = "athena.personal";
const SYSTEM_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const j = JSON.stringify;

export const BOOT_SCRIPT = `(function () {
  var d = document, r = d.documentElement, c = "system", k = null, p = null, u = null;
  try { k = localStorage.getItem(${j(APPEARANCE_KEY)}); p = localStorage.getItem(${j(PAINT_KEY)}); u = localStorage.getItem(${j(PERSONAL_KEY)}); } catch (e) {}
  var N = /${PROPERTY.source}/, F = /${FONT_NAME.source}/, H = /^#[0-9a-f]{6}$/;
  function safe(v) {
    if (typeof v !== "string" || v.length > 400 || !/^[a-z0-9#.%(), \\/-]+$/i.test(v)) return false;
    var m, re = /([a-z-]*)\\(/gi;
    while ((m = re.exec(v))) { var f = m[1].toLowerCase(); if (f !== "oklch" && f !== "color-mix" && f !== "var") return false; }
    re = /var\\(([^()]*)\\)/gi;
    while ((m = re.exec(v))) if (!N.test(m[1].replace(/^\\s+|\\s+$/g, ""))) return false;
    return true;
  }
  function style(id, css) { if (!css) return; var s = d.createElement("style"); s.id = id; s.textContent = css; d.head.appendChild(s); }
  var t = d.querySelectorAll('meta[name="theme-color"]'), i;
  try {
    var P = p && JSON.parse(p), B = ${j(BLOCKS)}, css = "";
    if (P && P.v === ${PAINT_VERSION} && P.blocks) {
      for (var b in B) {
        var o = Object.prototype.hasOwnProperty.call(P.blocks, b) && P.blocks[b], s = "";
        if (o && typeof o === "object") for (var n in o) if (Object.prototype.hasOwnProperty.call(o, n) && N.test(n) && safe(o[n])) s += n + ":" + o[n] + ";";
        if (s) css += B[b] + "{" + s + "}";
      }
      style("athena-theme", css);
      var M = P.meta || {};
      for (i = 0; i < t.length; i++) { if (H.test(M.light)) t[i].setAttribute("data-light", M.light); if (H.test(M.dark)) t[i].setAttribute("data-dark", M.dark); }
    }
  } catch (e) {}
  try {
    var U = u && JSON.parse(u), q = "", f = U && U.font, z = U && U.size, ff = null;
    if (f === ${j(SYSTEM_FONT)}) ff = ${j(SYSTEM_STACK)};
    else if (typeof f === "string" && F.test(f) && f.replace(/^\\s+|\\s+$/g, "") === f) ff = '"' + f + '", ' + ${j(SYSTEM_STACK)};
    if (ff) q += "--user-font-ui:" + ff + ";--user-font-display:" + ff + ";";
    if (typeof z === "number" && isFinite(z)) {
      z = Math.round(Math.min(${SIZE_LIMITS.max}, Math.max(${SIZE_LIMITS.min}, z)) * 10000) / 10000;
      if (z !== 1) q += "--user-text-scale:" + String(z) + ";";
    }
    if (q) style("athena-personal", "html:root{" + q + "}");
  } catch (e) {}
  if (k === "light" || k === "dark") c = k;
  var sc = c !== "system" ? c : window.matchMedia && window.matchMedia(${j(DARK_QUERY)}).matches ? "dark" : "light";
  r.setAttribute("data-appearance", c);
  r.setAttribute("data-scheme", sc);
  var m = d.querySelector('meta[name="color-scheme"]');
  if (m) m.setAttribute("content", sc);
  for (i = 0; i < t.length; i++) { var v = t[i].getAttribute("data-" + sc); if (v) t[i].setAttribute("content", v); }
})();`;

/** Where vite.config.ts puts it. */
export const BOOT_MARKER = "<!-- appearance: first paint -->";
