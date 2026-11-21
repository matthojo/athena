// Cut 6 product captures (from cut 5's). Deterministic 30fps: Playwright's fake clock is paused and stepped 1/30s
// per frame; CSS/Web animations are paused and their currentTime driven from the same virtual clock;
// each frame is a 3x JPEG. Sample mode only, /api aborted.
//
//   CAP_DIR=/path/to/cap node capture.cjs [shot ...]
//   shots: home ask saved track music habits work workDone hire flow health graph checkin stills   (none = all)
//   `track`, `work` + `workDone` and `hire` are the Team story (PLAN.md, Team 1-3); `tellme`, `penny`, `pennyWork`
//   and `pennyDone` are written to the manifest as aliases of them.
//   CAP_FILM_POSTER=/path/poster.jpg puts the film's own poster on the Saved film card (film only, never committed).
//   CAP_URL overrides the dev server (default http://localhost:5199/).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = (process.env.CAP_DIR || '/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film5/cap').replace(/\/+$/, '') + '/';
const URL = process.env.CAP_URL || 'http://localhost:5199/';
const STEP = 1000 / 30;
const MORNING = '2026-11-09T07:55:00Z';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MANIFEST = ROOT + 'manifest.json';

// Injected in every shot: no scrollbars. (Playwright hides the text caret in screenshots, so no blink flicker.)
const CSS = `
  *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  * { scrollbar-width: none !important; }
  * { scroll-behavior: auto !important; }
`;

function saveManifest(name, entry) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch {}
  m[name] = entry;
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
}

// Ask and Team are framed very tight in the film (the answer's first line at ~60% of frame height, Penny's face),
// so they are shot at HI (6x, 2340x5064) instead of 3x. The compositor scales any size to the 390x844 card.
const HI = Number(process.env.CAP_HI_SCALE || 6);
async function setup(b, time = MORNING, scale = 3, { seed = null, css = '' } = {}) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: scale, colorScheme: 'light', timezoneId: 'Europe/London', locale: 'en-GB', isMobile: true, hasTouch: true });
  await ctx.addInitScript(([css, seed]) => {
    localStorage.setItem('athena.mode', 'sample');
    // `seed`: a fixed Math.random (mulberry32), so a new assistant's random name and look are the same every run.
    if (seed !== null) { let a = seed >>> 0; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    // "Searched … · sample data" under an Ask answer, "56 things, 46 connections · Sample data" under the
    // graph: drop the suffix wherever it appears, keep the rest of the line.
    const strip = () => {
      if (!document.body) return;
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (/ · sample data/i.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/ · sample data/i, '');
    };
    const addCss = () => { const s = document.createElement('style'); s.id = 'cap-css'; s.textContent = css; (document.head || document.documentElement).appendChild(s); };
    const boot = () => { addCss(); new MutationObserver(strip).observe(document.documentElement, { childList: true, subtree: true, characterData: true }); };
    if (document.head) boot(); else document.addEventListener('DOMContentLoaded', boot);
    // Drive every CSS/Web animation from a virtual time the recorder sets.
    window.__vt = 0; const seen = new WeakMap();
    // While recording (cap = one frame), an animation first seen in this frame began during it: it has run in
    // real time since the click, so clamp its head start to one frame or its opening frames are skipped.
    window.__syncAnims = (vt, cap) => {
      window.__vt = vt;
      for (const a of document.getAnimations()) {
        if (!seen.has(a)) { let ct = a.currentTime || 0; if (cap && ct > cap) ct = cap; seen.set(a, vt - ct); try { a.pause(); } catch {} }
        try { a.currentTime = vt - seen.get(a); } catch {}
        // A route change runs in a View Transition; a paused animation never finishes, so the transition (and its
        // overlay, which takes every tap) would never end. Finish its animations once the virtual clock passes them.
        try {
          if (/^::view-transition/.test(a.effect && a.effect.pseudoElement || '') && a.playState !== 'finished') {
            const end = a.effect.getComputedTiming().endTime;
            if (Number.isFinite(end) && vt - seen.get(a) >= end) a.finish();
          }
        } catch {}
      }
    };
    // After off-camera preparation: everything that was moving is at its end and stays there.
    window.__finishAnims = () => { for (const a of document.getAnimations()) { try { a.finish(); } catch {} seen.set(a, -1e9); } };
  }, [CSS + css, seed]);
  await ctx.route('**/api/**', r => r.abort());
  // CAP_FILM_POSTER=/path/to/poster.jpg: the film's own artwork stands in for the app's illustrated
  // sample poster, for the film only. The studio poster is never committed to the repo.
  if (process.env.CAP_FILM_POSTER) {
    const body = require('fs').readFileSync(process.env.CAP_FILM_POSTER);
    await ctx.route('**/sample/saved/film.webp', r => r.fulfill({ status: 200, contentType: 'image/jpeg', body }));
  }
  // Swallow Vite's HMR socket: an edit to the app while a shot is recording must not reload the page.
  await ctx.routeWebSocket(/.*/, () => {});
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.clock.install({ time: new Date(time) });
  return p;
}

const shoot = (p, file) => p.screenshot({ path: file, type: 'jpeg', quality: 95 });

// actions: [ms, fn, eventName?]. watch: { name: async () => bool } records the ms of the first frame it holds.
// steps: [{ when?, after?, do?, ev? }], in order: each fires `after` ms after its `when` first holds (or after the
// step before it); with `endOnSteps` the shot ends when the last has fired (durMs is then the most it may run).
// each(vt): runs before every frame (scrolls, drags).
// post(vt): runs after the step, just before the screenshot.
async function record(p, name, durMs, { actions = [], watch = {}, each = null, post = null, steps = [], endOnSteps = false } = {}) {
  const dir = ROOT + name + '/'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const max = Math.ceil(durMs / STEP - 1e-6); let vt = 0; const todo = [...actions].sort((a, b) => a[0] - b[0]);
  const events = {}; const pending = { ...watch }; const queue = [...steps]; let n = 0; const seenWords = {};
  for (let i = 0; i < max; i++) {
    while (todo.length && todo[0][0] <= vt + 1e-6) { const [, fn, ev] = todo.shift(); await fn(); if (ev) events[ev] = Math.round(vt); }
    while (queue.length) {
      const s = queue[0];
      if (s.at === undefined) { if (s.when && !(await s.when())) break; s.at = vt + (s.after || 0); }
      if (vt + 1e-6 < s.at) break;
      if (s.do) await s.do(); if (s.ev) events[s.ev] = Math.round(vt); queue.shift();
    }
    if (endOnSteps && !queue.length) break;
    if (each) await each(vt);
    await p.clock.runFor(STEP); vt += STEP;
    await sleep(15); // let real async work (IndexedDB, promises) settle
    await p.evaluate(([v, c]) => window.__syncAnims(v, c), [vt, STEP]);
    if (post) await post(vt);
    // A frame shows the state at the end of its step; an event seen in frame i is on screen from i*STEP.
    for (const k of Object.keys(pending)) if (await pending[k]()) { events[k] = Math.round(i * STEP); delete pending[k]; }
    await shoot(p, `${dir}${String(i).padStart(4, '0')}.jpg`); n = i + 1;
    // Words that must not be on screen, checked on every frame (text in the viewport only): "Muse" never; the real
    // brands are reported so the compositor can keep them out of frame.
    for (const w of await p.evaluate(visibleWords)) (seenWords[w] = seenWords[w] || []).push(i);
  }
  for (const [w, fr] of Object.entries(seenWords)) console.log(`${w === 'Muse' ? 'FAIL' : 'NOTE'} ${name}: "${w}" on screen in ${fr.length} frames (${fr[0]}–${fr[fr.length - 1]})`);
  for (const k of Object.keys(pending)) console.log(`WARN ${name}: "${k}" never seen`);
  for (const s of queue) console.log(`WARN ${name}: step "${s.ev || '?'}" never fired`);
  // The assistant is Penny: the old name must never be on screen.
  if (await p.evaluate(() => /\bMuse\b/.test(document.body.innerText))) console.log(`WARN ${name}: "Muse" is on screen`);
  console.log(name, n, 'frames', JSON.stringify(events));
  return { frames: n, events };
}

// In the page: which of the watched words are in a text node painted inside the viewport.
function visibleWords() {
  const out = new Set(), re = /\b(Muse|Linear|Amazon|Spotify)\b/g;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const m = n.nodeValue.match(re); if (!m) continue;
    const el = n.parentElement; if (!el) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const r = range.getBoundingClientRect(); if (!r.height || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    let hidden = false; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || +cs.opacity < 0.05 || cs.display === 'none') { hidden = true; break; } }
    if (hidden) continue;
    // Painted on top somewhere (not under the sticky head, the dock or a sheet): test each line box's centre.
    const top = [...range.getClientRects()].some(q => { const cx = q.left + q.width / 2, cy = q.top + q.height / 2; if (cx < 0 || cx > innerWidth || cy < 0 || cy > innerHeight) return false; const hit = document.elementFromPoint(cx, cy); return !!hit && (el.contains(hit) || hit.contains(el)); });
    if (top) m.forEach(x => out.add(x));
  }
  return [...out];
}

// Off-camera preparation: step the clock with the animations following it (so a route change's View Transition
// ends and taps land), then leave everything finished.
async function advance(p, ms) {
  for (let t = 0; t < ms; t += STEP) { await p.clock.runFor(STEP); await sleep(8); await p.evaluate(v => window.__syncAnims(v), 1e6 + (advance.vt += STEP)); }
  await p.evaluate(() => window.__finishAnims());
}
advance.vt = 0;
// A sample saved item's id, by its title (ids follow the sample's order, so they are looked up, not written down).
const savedId = (p, title) => p.evaluate(async (t) => { const m = await import('/src/db/sample-saved.ts'); const it = m.sampleSavedPage({}).items.find(i => (i.title || '').includes(t)); return it ? it.id : null; }, title);

function typeActions(p, at, text, per) {
  return [...text].map((ch, i) => [at + i * per + (i % 3) * 10, () => p.keyboard.type(ch), i === 0 ? 'typeStart' : undefined]);
}
// Load a route in real time, then pause the clock and step it until the view has settled.
async function prepare(p, route, settleMs = 2500) {
  await p.goto(URL + route); await sleep(400);
  // A 6x page can take longer than 50 ms to answer; then pause a little later instead.
  for (const ahead of [50, 400, 1500]) {
    try { await p.clock.pauseAt(new Date(await p.evaluate(() => Date.now()) + ahead)); break; } catch (e) { if (ahead === 1500) throw e; }
  }
  for (let t = 0; t < settleMs; t += STEP) { await p.clock.runFor(STEP); await sleep(5); }
  await p.evaluate(() => window.__syncAnims(0));
}
// Navigate and pause at once, so the recording catches the view arriving.
// The clock is paused before the page loads, so frame 0 is the first paint and the entrance plays on camera.
async function arrive(p, route, realMs = 600, at = MORNING) {
  await p.clock.pauseAt(new Date(Date.parse(at) + 1000));
  await p.goto(URL + route); await sleep(realMs);
}
// After focusing a field: let the keyboard-up transitions (nav sliding away) finish off camera.
async function settle(p, ms = 700) {
  for (let t = 0; t < ms; t += STEP) { await p.clock.runFor(STEP); await sleep(5); }
  await p.evaluate(() => window.__syncAnims(60000));
  await p.evaluate(() => window.__syncAnims(0));
}
async function rectOf(loc) {
  // A part the app no longer draws is a missing rect (null), not a 30 s wait and a failed shot.
  if (!(await loc.count())) { console.log('WARN rect: nothing matches', String(loc)); return null; }
  const r = await loc.boundingBox();
  return r && { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
}
const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
const inOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// A watch: true once the first element matching sel (and, with `text`, containing it) is painted, fully opaque,
// untransformed (its entrance finished) and on screen; with `whole`, entirely inside [0, maxY].
function shownIn(p, sel, { text = null, whole = false, maxY = 844 } = {}) {
  return () => p.evaluate(([sel, text, whole, maxY]) => {
    const el = [...document.querySelectorAll(sel)].find(e => !text || (e.textContent || '').includes(text)); if (!el) return false;
    const r = el.getBoundingClientRect(); if (!r.height || r.bottom < 0 || r.top > innerHeight) return false;
    // Mid route change the screen still shows the View Transition's snapshots, not the DOM.
    if (document.activeViewTransition || document.getAnimations().some(a => /^::view-transition/.test((a.effect && a.effect.pseudoElement) || '') && a.playState !== 'finished')) return false;
    if (whole && (r.top < 0 || r.bottom > maxY)) return false;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (+cs.opacity < 0.99) return false;
      if (cs.transform !== 'none') { const m = new DOMMatrixReadOnly(cs.transform); if (Math.abs(m.a - 1) > 0.002 || Math.abs(m.d - 1) > 0.002 || Math.abs(m.e) > 0.5 || Math.abs(m.f) > 0.5) return false; }
    }
    return true;
  }, [sel, text, whole, maxY]);
}

// The rect of the first sentence (up to the first ". ", "! " or "? ") of the last element matching sel, on screen now.
function firstSentence(p, sel) {
  return p.evaluate((sel) => {
    const els = document.querySelectorAll(sel); const el = els[els.length - 1]; if (!el) return null;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const range = document.createRange(); let started = false;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!started) { const i = n.nodeValue.search(/\S/); if (i < 0) continue; range.setStart(n, i); started = true; }
      const m = n.nodeValue.match(/[.!?](\s|$)/);
      const last = !w.nextNode(); w.previousNode();
      if (m || last) { range.setEnd(n, m ? m.index + 1 : n.nodeValue.length); break; }
    }
    if (!started) return null;
    const r = range.getBoundingClientRect(), k = v => Math.round(v * 10) / 10;
    return { x: k(r.x), y: k(r.y), w: k(r.width), h: k(r.height), text: range.toString() };
  }, sel);
}

// The Team story's clock: early afternoon, as on Home in cut 4's Team beat.
const TEAM_AT = process.env.CAP_TEAM_AT || '2026-11-09T13:10:00Z';
const BALM = process.env.CAP_BALM || 'Cedar hand balm';
// The hand balm's page with its Tracking panel in the BEFORE state, made off camera in the app's own UI.
// Sample mode seeds it finished: saved at £31 (Greenleaf) 1 h 35 min before the page opened, Penny's £27 check at
// Fenn & Hale 42 min before, and "£28 or less" already asked for. So:
//  1. the clock is set to 60 min before the page opened and a price is kept by hand ("All checks" → "Add a price":
//     31, Greenleaf). With two checks the panel draws its step line (one check is a sentence alone), so there is a
//     picture for the dashed target line to land on; it reads "You checked … ago";
//  2. the clock is set to `nowMinus` minutes before the page opened: 50 for Team 1 (before Penny's check), 41 for
//     Team 2 (just after it, so the panel reads "Penny checked 1 minute ago" when it lands);
//  3. Penny's check is removed ("All checks" → its ×). Its toast carries Undo, which workDone uses to bring it back;
//  4. with `clearTarget`, the target is cleared (the pill's ×) and the toasts are left to run out.
async function balmBefore(p, { nowMinus, clearTarget }) {
  await prepare(p, '#/saved', 2500);
  const id = process.env.CAP_BALM_ID || await savedId(p, BALM);
  if (!id) throw new Error('hand balm not in the sample');
  await p.evaluate(h => { location.hash = h; }, '#/saved/' + id);
  await advance(p, 2500);
  const panel = p.locator('section.tk').first();
  await panel.waitFor({ timeout: 5000 });
  const t0 = await p.evaluate(() => Date.now());
  const openList = async () => { await panel.locator('.tk-toggle', { hasText: /All \d+ checks/ }).first().click(); await advance(p, 400); };
  await p.clock.setSystemTime(new Date(t0 - 60 * 60_000));
  await openList();
  await panel.locator('.tk-listfoot .tk-toggle', { hasText: 'Add a price' }).first().click(); await advance(p, 300);
  await panel.locator('form.tk-form .tk-input--num').first().fill('31');
  await panel.getByPlaceholder('Shop').first().fill('Greenleaf');
  await panel.locator('form.tk-form button[type=submit]').first().click(); await advance(p, 3200);
  await p.clock.setSystemTime(new Date(t0 - nowMinus * 60_000));
  await openList();
  await panel.locator('.tk-row', { hasText: 'Fenn & Hale' }).first().locator('.tk-row__remove').click(); await advance(p, 300);
  if (clearTarget) { await panel.locator('.tk-goal__clear').first().click(); await advance(p, 7500); }
  await p.evaluate(() => { document.scrollingElement.scrollTop = 0; if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await advance(p, 100);
  return id;
}
// The saved item's page around the panel: its header (site and title) and the "Gift idea for…" row under the actions.
async function itemRects(p) {
  return p.evaluate(() => {
    const k = v => Math.round(v * 10) / 10, rect = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: k(r.x), y: k(r.y), w: k(r.width), h: k(r.height) }; };
    const title = [...document.querySelectorAll('h1')].find(e => /hand balm/.test(e.textContent || ''));
    const leaf = [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().height > 0);
    const site = leaf.find(e => !e.children.length && (e.textContent || '').trim() === 'Greenleaf' && e.getBoundingClientRect().top < (title ? title.getBoundingClientRect().top : 200));
    const giftText = leaf.find(e => !e.children.length && /^Gift idea for/.test((e.textContent || '').trim()));
    let gift = giftText; while (gift && gift.parentElement && gift.getBoundingClientRect().width < 300) gift = gift.parentElement;
    const out = { title: rect(title), titleText: title ? title.textContent.trim() : null, site: rect(site), giftRow: rect(gift), giftRowText: gift ? gift.innerText.replace(/\s+/g, ' ').trim() : null };
    if (out.title && out.site) { const a = out.site, b = out.title, x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); out.header = { x, y, w: k(Math.max(a.x + a.w, b.x + b.w) - x), h: k(Math.max(a.y + a.h, b.y + b.h) - y) }; }
    return out;
  });
}
// The Tracking panel's parts as they are on screen now.
async function panelRects(p) {
  const panel = p.locator('section.tk').first(), out = {};
  const one = async (key, sel) => { const l = panel.locator(sel).first(); if (await l.count()) out[key] = await rectOf(l); };
  out.panelEnd = await rectOf(panel);
  await one('sentenceEnd', '.tk-sentence'); await one('detail', '.tk-detail'); await one('chart', '.tk-figure'); await one('chartSvg', '.tk-chart svg');
  await one('pill', '.tk-goalwrap'); await one('targetLine', '.tk-chart__goal'); await one('targetLabel', '.tk-chart__goallabel');
  await one('line', '.tk-chart__line'); await one('endDot', '.tk-chart__end'); await one('savedLabel', '.tk-chart__reflabel'); await one('foot', '.tk-foot, .tk-who'); await one('toast', '.toast');
  if (await panel.locator('.tk-sentence').count()) out.sentenceEndText = (await panel.locator('.tk-sentence').first().innerText()).trim();
  if (await panel.locator('.tk-foot, .tk-who').count()) out.footText = (await panel.locator('.tk-foot, .tk-who').first().innerText()).replace(/\s+/g, ' ').trim();
  if (await panel.locator('.tk-goalwrap').count()) out.pillText = (await panel.locator('.tk-goalwrap').first().innerText()).trim();
  return out;
}

// A flow's page as it is on screen now: its title, the On switch (and its row), and the steps (When, the trigger
// card, Then, each step card; `steps` is the union of those whose top is above the floating "Test" button).
async function flowEditorRects(p) {
  return p.evaluate(() => {
    const k = v => Math.round(v * 10) / 10, rect = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: k(r.x), y: k(r.y), w: k(r.width), h: k(r.height) }; };
    const q = s => document.querySelector('.flows--editor ' + s);
    const eyebrows = [...document.querySelectorAll('.flows--editor .flow-eyebrow')];
    const cards = [...document.querySelectorAll('.flows--editor .flow-card')];
    const foot = q('.flow-foot'); const footTop = foot && !foot.hidden ? foot.getBoundingClientRect().top : innerHeight;
    const parts = [...eyebrows, ...cards].filter(e => e.getBoundingClientRect().top < footTop - 20);
    let steps = null;
    for (const e of parts) { const r = e.getBoundingClientRect(); if (!steps) steps = { l: r.left, t: r.top, r: r.right, b: r.bottom }; else { steps.l = Math.min(steps.l, r.left); steps.t = Math.min(steps.t, r.top); steps.r = Math.max(steps.r, r.right); steps.b = Math.max(steps.b, r.bottom); } }
    const sw = q('label.flow-on input.switch');
    return {
      flowTitle: rect(q('.flow-hero__name')), flowTitleText: q('.flow-hero__name') ? q('.flow-hero__name').textContent.trim() : null,
      onToggle: rect(sw), onRow: rect(q('label.flow-on')), onState: sw ? sw.checked : null,
      steps: steps && { x: k(steps.l), y: k(steps.t), w: k(steps.r - steps.l), h: k(Math.min(steps.b, footTop) - steps.t) },
      whenLabel: rect(eyebrows[0]), thenLabel: rect(eyebrows[1]), whenCard: rect(cards[0]), thenCard: rect(cards[1]),
      stepTitles: cards.map(c => (c.querySelector('.flow-card__title') || c).textContent.trim()),
      // One per card (the trigger first), with its title, whether it is on screen above the Test button.
      stepRows: cards.map(c => ({ ...rect(c), title: (c.querySelector('.flow-card__title') || c).textContent.trim(), clear: c.getBoundingClientRect().bottom < footTop })),
      testBtn: rect(q('.flow-foot__try')),
    };
  });
}

const SHOTS = {
  // Home: the live update lands on camera. The page opens at 07:39 London, when sample mode's 08:10 train is still
  // "On time" (it runs 12 min late from 07:40). At LATE the clock jumps 150 s (fastForward: due timers fire once),
  // the travel card's 2½-minute live refresh fires and repaints the row: "12 min late · Platform 7", expected 08:22.
  async home(b) {
    const AT = process.env.CAP_HOME_AT || '2026-11-09T07:39:00Z', LATE = Number(process.env.CAP_HOME_LATE || 1800);
    const p = await setup(b, AT);
    await arrive(p, '#/', 600, AT);
    const card = p.locator('section.travel--home').first();
    const late = card.locator('.tchip', { hasText: '12 min late' }).first();
    const plat = card.locator('.tleg__where', { hasText: 'Platform 7' }).first();
    const train = card.locator('li.tleg').first();
    const greeting = p.getByRole('heading', { name: /Good morning, Alex/ }).first();
    const shown = sel => shownIn(p, sel);
    const rects = {};
    const res = await record(p, 'home', 9600, {
      actions: [[LATE, async () => {
        const chip = train.locator('.tchip').first();
        if (await chip.count()) { rects.chipBefore = await rectOf(chip); rects.chipBeforeLabel = (await chip.innerText()).trim(); }
        await p.clock.fastForward(150_000);
      }, 'liveUpdate']],
      watch: {
        greeting: shown('.headline__hello'), travel: shown('section.travel--home'), trainRow: shown('section.travel--home li.tleg'),
        onTimeChip: () => p.evaluate(() => /On time/i.test((document.querySelector('section.travel--home li.tleg .tchip') || {}).textContent || '')),
        lateChip: () => p.evaluate(() => /min late/.test((document.querySelector('section.travel--home li.tleg .tchip') || {}).textContent || '')),
      },
    });
    // Rects from the settled last frame (scroll 0).
    Object.assign(rects, { greeting: await rectOf(greeting), travelCard: await rectOf(card), trainRow: await rectOf(train), lateChip: union(await rectOf(late), await rectOf(plat)) });
    saveManifest('home', { ...res, rects });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  async ask(b) {
    const p = await setup(b, MORNING, HI);
    await prepare(p, '#/ask');
    const input = p.getByRole('textbox', { name: 'Ask your notes' });
    await input.click();
    await settle(p);
    const q = 'What did Elena say about pricing?';
    const rects = { input: await rectOf(input) };
    const actions = typeActions(p, 600, q, 68);
    actions.push([3000, async () => {
      rects.send = await rectOf(p.locator('button.send-btn[type=submit]').first());
      await p.keyboard.press('Enter');
    }, 'send']);
    const bubble = p.locator('.answer-bubble');
    // The app follows the answer to the bottom as it streams. Keep the sent question's bubble where it first
    // appeared (just under the header), so the question, the steps under it and the answer stay in view together.
    const pin = () => p.evaluate(() => {
      const el = document.querySelector('.msg--me'); if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (window.__pin === undefined) { window.__pin = top; return; }
      if (top >= window.__pin - 0.5) return;
      let sc = el.parentElement;
      while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      (sc || document.scrollingElement).scrollTop -= window.__pin - top;
    });
    const res = await record(p, 'ask', Number(process.env.CAP_ASK_MS || 15500), {
      actions, post: pin,
      watch: {
        // First frame with answer text on screen (it then streams in), and the frame the sources arrive.
        answer: () => p.evaluate(() => ((document.querySelector('.answer-bubble .answer__text') || {}).innerText || '').trim().length > 0),
        answerDone: async () => (await p.locator('.answer-bubble .sources').count()) > 0,
      },
    });
    // Measured on the last frame, at the scroll position it shows.
    const text = p.locator('.answer-bubble .answer__text').last(), src = p.locator('.answer-bubble .sources').last();
    if (await src.count()) { rects.sources = await rectOf(src); rects.answer = union(await rectOf(text), rects.sources); rects.answer.h = Math.round(rects.answer.h * 10) / 10; }
    else if (await text.count()) rects.answer = await rectOf(text);
    if (await bubble.count()) rects.answerBubble = await rectOf(bubble.last());
    rects.answerFirst = await firstSentence(p, '.answer-bubble .answer__text');
    const me = p.locator('.msg--me').last();
    if (await me.count()) rects.question = await rectOf((await me.locator('.bubble').count()) ? me.locator('.bubble').first() : me);
    const steps = p.locator('.steps').last();
    if (await steps.count()) rects.steps = await rectOf(steps);
    if (await text.count()) rects.lineH = await text.evaluate(e => { const t = e.querySelector('p') || e; const lh = parseFloat(getComputedStyle(t).lineHeight); return Number.isFinite(lh) ? Math.round(lh * 10) / 10 : Math.round(parseFloat(getComputedStyle(t).fontSize) * 1.4 * 10) / 10; });
    // The steps fold away and the answer bubble fades in: about one frame shows an almost empty bubble. Dissolve
    // across it (frames after the `answer` event).
    const covers = typeof res.events.answer === 'number' ? [{ at: 'answer', from: Math.round(res.events.answer / STEP), to: Math.round(res.events.answer / STEP) + 4 }] : [];
    saveManifest('ask', { ...res, scale: HI, rects, covers });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  // Saved: a film found in passing. The Letterboxd link is pasted (one insert, not typed) and kept; sample mode
  // lands it as a film card. The pointer opens it and taps "Move to Watch & read": the item page then says
  // "Filed in Watch & read" and a "Moved to Watch & read" toast rises (it stays about 6.6 s). The pointer taps the
  // "Watch & read" link in that line; Watch & read opens and scrolls until the Films row under "Up next", with the
  // film first and its poster as the cover, is in view; then it holds about 1.5 s.
  async saved(b) {
    const p = await setup(b);
    await prepare(p, '#/saved');
    const field = p.getByPlaceholder('Paste a link, or keep a thought');
    await field.click();
    await settle(p);
    const url = process.env.CAP_SAVED_URL || 'https://letterboxd.com/film/guardians-of-the-galaxy/';
    const title = 'Guardians of the Galaxy';
    const PASTE = 400, ADD = 1400, OPEN = 3000, MOVE = 4600, LINK = 6200;
    // Watch & read now opens on a month summary (stats, genres), In progress and For Christmas before "Up next", so
    // the Films row is ~1550 px down (cut 5: much less). The scroll takes 2 s, not 1.3, to keep it under ~80 px a
    // frame at its fastest, and the shot runs 0.6 s longer so the hold on the row stays 1.5 s.
    const SCROLL_FROM = LINK + 900, SCROLL_MS = Number(process.env.CAP_SAVED_SCROLL_MS || 2000), FILM_TOP = Number(process.env.CAP_WATCH_TOP || 290);
    let scroll = null; // { from, to }: Watch & read's document scroll, set when the scroll starts
    const rects = { input: await rectOf(field) };
    const poster = () => p.locator('img[src*="film.webp"]').first();
    const actions = [
      [PASTE, () => p.keyboard.insertText(url), 'paste'],
      [ADD, () => p.keyboard.press('Enter'), 'add'],
      [OPEN, async () => {
        const card = p.locator('.sv-card', { hasText: title }).first();
        rects.newCard = await rectOf(card); rects.poster = await rectOf(card.locator('img').first());
        await card.click();
      }, 'open'],
      [MOVE, async () => {
        const btn = p.getByRole('button', { name: /Move to Watch & read/ }).first();
        rects.detailPoster = await rectOf(poster()); rects.moveBtn = await rectOf(btn);
        await btn.click();
      }, 'move'],
      [LINK, async () => {
        const link = p.locator('a.sva-filed__where').first();
        rects.filed = await rectOf(p.locator('.sva-filed').first()); rects.filedLink = await rectOf(link);
        await link.click();
      }, 'linkTap'],
    ];
    const filmCard = () => p.locator('li.watch-card', { hasText: title }).first();
    // Watch & read's Films row: the group holding the film's card.
    const filmRow = () => filmCard().locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " watch-group ")][1]');
    // The "Moved to Watch & read" toast: first frame on screen, and first frame after it has gone.
    const toastOn = () => p.evaluate(() => [...document.querySelectorAll('body *')].some(e => e.children.length < 3 && /^Moved to Watch & read/.test((e.textContent || '').trim()) && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden' && +getComputedStyle(e).opacity > 0.05));
    const res = await record(p, 'saved', Number(process.env.CAP_SAVED_MS || 10600), {
      actions,
      // From SCROLL_FROM, ease the page down so the Films row's top sits at FILM_TOP: low enough that the "Up next"
      // heading above it clears the sticky page head (title and search, ~180 px), the toast stays below the cards.
      each: async (vt) => {
        if (vt + STEP < SCROLL_FROM || !/#\/reading/.test(p.url())) return;
        if (!scroll) {
          const top = await filmRow().evaluate(e => e.getBoundingClientRect().top + scrollY);
          const max = await p.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
          scroll = { from: await p.evaluate(() => document.scrollingElement.scrollTop), to: Math.max(0, Math.min(max, Math.round(top - FILM_TOP))) };
        }
        const k = Math.min(1, Math.max(0, (vt + STEP - SCROLL_FROM) / SCROLL_MS));
        if (k <= 1 && vt <= SCROLL_FROM + SCROLL_MS + STEP) await p.evaluate(y => { document.scrollingElement.scrollTop = y; }, scroll.from + (scroll.to - scroll.from) * inOut(k));
      },
      watch: {
        cardLand: shownIn(p, '.sv-card', { text: title }),
        posterLoaded: () => p.evaluate(() => [...document.querySelectorAll('.sv-card img')].some(i => /film\.webp/.test(i.src) && i.complete && i.naturalWidth > 0)),
        detail: shownIn(p, 'button', { text: 'Move to Watch & read' }),
        filed: shownIn(p, '.sva-filed'),
        toast: toastOn,
        reading: async () => /#\/reading/.test(p.url()) && await shownIn(p, 'h1', { text: 'Watch & read' })(),
        filmRowVisible: async () => /#\/reading/.test(p.url()) && await shownIn(p, 'li.watch-card', { text: title, whole: true, maxY: 690 })(),
        watchPosterLoaded: () => p.evaluate((t) => { const c = [...document.querySelectorAll('li.watch-card')].find(e => (e.textContent || '').includes(t)); const i = c && c.querySelector('.watch-card__cover img'); return !!(i && i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().bottom > 0 && i.getBoundingClientRect().top < innerHeight); }, title),
      },
    });
    res.events.scrollStart = SCROLL_FROM; res.events.scrollEnd = SCROLL_FROM + SCROLL_MS;
    res.events = Object.fromEntries(Object.entries({ typeStart: res.events.paste, ...res.events }).sort((x, y) => x[1] - y[1]));
    // Measured on the last frame, at rest: the film's cover on Watch & read, its card, and the Films row.
    if (await filmCard().count()) {
      rects.watchPoster = await rectOf(filmCard().locator('.watch-card__cover').first());
      rects.watchCard = await rectOf(filmCard());
      rects.filmRow = await rectOf(filmRow());
    }
    // Two re-renders blank part of the picture for a few frames: at add the list empties and fades back in, and at
    // move the item page redraws with its poster's placeholder colour before the image decodes. The link tap cuts
    // straight to Watch & read and the tab rail snaps "Watch & read" into view a frame later. The compositor
    // dissolves from frame `from` to frame `to` across each (cut 3's `saved.cover`; `cover` is the first).
    const f = ms => Math.round(ms / STEP);
    // On the merged app the two route changes (open, link) cross-fade for about three frames in a View Transition:
    // two different layouts blended, so both are covered too.
    const covers = [{ at: 'add', from: f(ADD) - 1, to: f(ADD) + 4 }, { at: 'open', from: f(OPEN), to: f(OPEN) + 4 }, { at: 'move', from: f(MOVE) - 1, to: f(MOVE) + 3 }, { at: 'link', from: f(LINK) - 1, to: f(LINK) + 4 }];
    saveManifest('saved', { ...res, rects, cover: { from: covers[0].from, to: covers[0].to }, covers, scroll });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  // Team 1, "Tell me when": the hand balm's page in Saved, its Tracking panel before anything is asked of it.
  // Sample mode opens with the story already over (Penny's £27 check and the £28 target both there), so the before
  // state is made in the app's own UI, off camera (balmBefore). On camera: "Tell me when", "At or under", 28,
  // "Tell me"; the pill and the dashed "Your £28" line appear and the sentence says what was asked.
  async track(b) {
    const p = await setup(b, TEAM_AT, HI);
    await balmBefore(p, { nowMinus: 50, clearTarget: true });
    const panel = p.locator('section.tk').first();
    const rects = { panel: await rectOf(panel), sentenceBefore: await rectOf(panel.locator('.tk-sentence').first()), chartBefore: await rectOf(panel.locator('.tk-figure').first()) };
    rects.sentenceBeforeText = (await panel.locator('.tk-sentence').first().innerText()).trim();
    // The first frame holds the whole story of the object: its header (site, title; the sample balm has no photo),
    // the panel, and the "Gift idea for…" row under the actions (it is pushed down while the form is open).
    Object.assign(rects, await itemRects(p)); rects.footBefore = await rectOf(panel.locator('.tk-foot, .tk-who').first());
    const WHEN = Number(process.env.CAP_TRACK_WHEN || 1500), UNDER = WHEN + 900, TYPE = WHEN + 1700, TELL = WHEN + 2700;
    const res = await record(p, 'track', Number(process.env.CAP_TRACK_MS || WHEN + 4800), {
      actions: [
        [WHEN, async () => { const btn = panel.locator('.tk-toggle', { hasText: 'Tell me when' }).first(); rects.tellMeWhenBtn = await rectOf(btn); await btn.click(); }, 'tellMeWhen'],
        [UNDER, async () => {
          const form = panel.locator('form.tk-form').first(), seg = form.locator('.seg__item', { hasText: 'At or under' }).first();
          Object.assign(rects, { form: await rectOf(form), atOrUnderBtn: await rectOf(seg), amountField: await rectOf(form.locator('.tk-affixed').first()), tellMeBtn: await rectOf(form.locator('button[type=submit]').first()) });
          rects.sentence = rects.form; rects.formLabel = (await form.locator('.tk-form__label').first().innerText()).trim();
          await seg.click();
        }, 'atOrUnder'],
        [TYPE, () => p.keyboard.type('2'), 'typeStart'],
        [TYPE + 220, () => p.keyboard.type('8'), 'typeEnd'],
        [TELL, () => panel.locator('form.tk-form button[type=submit]').first().click(), 'tellMe'],
      ],
      watch: {
        formOpen: shownIn(p, 'form.tk-form'),
        targetSet: () => p.evaluate(() => !!document.querySelector('section.tk .tk-goal') && !!document.querySelector('section.tk .tk-chart__goal')),
        toast: () => p.evaluate(() => [...document.querySelectorAll('.toast')].some(e => /You'll hear/.test(e.textContent || '') && e.getBoundingClientRect().height > 0)),
      },
    });
    res.events.amount = res.events.typeStart;
    Object.assign(rects, await panelRects(p));
    saveManifest('track', { ...res, scale: HI, rects });
    saveManifest('tellme', { alias: 'track' });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  // Team 2, first half: Home. The pointer picks Penny's chip under the Ask box and her working line shows under the
  // chips ("Penny is searching the web for Cedar hand balm", with the breathing dot). Sample mode's Penny starts
  // that run 25 s before the page opens and is on this step until 5 s in, so the shot opens with the page. At
  // FINISH the clock jumps past the end of her run (70 s in): the line goes back to her job, the dots stop.
  async work(b) {
    const p = await setup(b, TEAM_AT, HI);
    await arrive(p, '#/', 900, TEAM_AT);
    const TAP = Number(process.env.CAP_WORK_TAP || 1200), FINISH = Number(process.env.CAP_WORK_FINISH || 4800);
    const strip = p.locator('.home-ask__who').first(), chipBtns = strip.locator('.home-ask__chip'), about = p.locator('.home-ask__about').first();
    const rects = {};
    const aboutText = () => p.evaluate(() => { const e = document.querySelector('.home-ask__about'); return e && !e.hidden ? e.textContent.trim() : ''; });
    const res = await record(p, 'work', Number(process.env.CAP_WORK_MS || 6000), {
      actions: [
        [TAP, async () => {
          const all = []; for (let i = 0; i < await chipBtns.count(); i++) all.push(await rectOf(chipBtns.nth(i)));
          rects.chips = all.reduce(union); rects.chips.w = Math.round(rects.chips.w * 10) / 10; rects.chips.h = Math.round(rects.chips.h * 10) / 10;
          rects.pennyChip = await rectOf(chipBtns.filter({ hasText: 'Penny' }).first());
          rects.chipNames = await chipBtns.allInnerTexts().then(a => a.map(t => t.trim()));
          rects.askBox = await rectOf(p.locator('.home-ask__box').first());
          await chipBtns.filter({ hasText: 'Penny' }).first().click();
          // The tap also puts the cursor in the Ask box (a phone would raise its keyboard). With the box focused the
          // 6x screenshots drop its placeholder on random frames, so the focus is let go at once.
          await p.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });
        }, 'pennyTap'],
        [FINISH - 100, async () => { rects.workingLine = await rectOf(about); rects.workingText = await aboutText(); rects.workingDot = await rectOf(about.locator('.team-dot').first()); rects.pennyChipOn = await rectOf(chipBtns.filter({ hasText: 'Penny' }).first()); }],
        [FINISH, () => p.clock.fastForward(70_000), 'finish'],
      ],
      watch: {
        chips: shownIn(p, '.home-ask__chip'),
        working: async () => /^Penny is searching the web/.test(await aboutText()),
        done: async () => (await p.evaluate(() => !!document.querySelector('.home-ask__about') && !document.querySelector('.home-ask__about.is-working'))) && /\S/.test(await aboutText()) && !!rects.workingLine,
      },
    });
    rects.doneLine = await rectOf(about); rects.doneText = await aboutText();
    saveManifest('work', { ...res, scale: HI, rects });
    saveManifest('pennyWork', { alias: 'work' }); saveManifest('penny', { alias: 'work', then: 'workDone' });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  // Team 2, second half: the hand balm's page again, with the £28 asked for and Penny's check not yet in
  // (balmBefore). At CHECK her £27 check arrives and the panel redraws as the app does for any new check: the line
  // steps down under the dashed "Your £28", the sentence reads "£27 at Fenn & Hale, under the £28 you asked for."
  // with the reached mark. In sample mode her check is already there at load, so "arrives" is: it was removed off
  // camera ("All checks" → ×) and comes back through that toast's Undo, with the toasts not drawn for this shot.
  // The redraw is one frame (the panel is rebuilt, nothing animates).
  async workDone(b) {
    const p = await setup(b, TEAM_AT, HI, { css: '.toast-stack { opacity: 0 !important; }' });
    await balmBefore(p, { nowMinus: 41, clearTarget: false });
    const panel = p.locator('section.tk').first();
    const before = await panelRects(p);
    const rects = { panelBefore: before.panelEnd, sentenceBefore: before.sentenceEnd, sentenceBeforeText: before.sentenceEndText, chartBefore: before.chart, targetLineBefore: before.targetLine, pillBefore: before.pill, lineBefore: before.line };
    const CHECK = Number(process.env.CAP_DONE_CHECK || 1200);
    const res = await record(p, 'workDone', Number(process.env.CAP_DONE_MS || 4200), {
      actions: [[CHECK, () => p.evaluate(() => { const u = [...document.querySelectorAll('.toast__action')].find(e => /Undo/.test(e.textContent || '')); if (!u) throw new Error('no Undo'); u.click(); }), 'check']],
      watch: { reached: () => p.evaluate(() => !!document.querySelector('section.tk .tk-block.is-reached')) },
    });
    res.events.stepDown = res.events.result = res.events.reached;
    const after = await panelRects(p);
    Object.assign(rects, { panel: after.panelEnd, reachedLine: after.sentenceEnd, reachedText: after.sentenceEndText, chart: after.chart, targetLine: after.targetLine, targetLabel: after.targetLabel, pill: after.pill, line: after.line, endDot: after.endDot, foot: after.foot, footText: after.footText, detail: after.detail });
    if (await panel.locator('.tk-lead').count()) rects.reachedLead = await rectOf(panel.locator('.tk-lead').first());
    Object.assign(rects, await itemRects(p)); // the page's header (site, title) is in every frame, above the panel
    if (await panel.locator('.tk-sentence .tk-hit').count()) rects.hitMark = await rectOf(panel.locator('.tk-sentence .tk-hit').first());
    saveManifest('workDone', { ...res, scale: HI, rects });
    saveManifest('pennyDone', { alias: 'workDone' });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  // Team 3, hire: #/team/new. The job is typed in one sentence and sent with Continue; the assistant arrives with a
  // name and a face, says hello and what it will do; "Skip the questions" (the shortest path), "Add <name> to your
  // team", "<name> is on your team", Done; then the Team page scrolls to the new face under Penny, Dot and Wren.
  // The name and look are random in the app: CAP_HIRE_SEED fixes Math.random for this shot so they repeat.
  async hire(b) {
    const p = await setup(b, TEAM_AT, 3, { seed: Number(process.env.CAP_HIRE_SEED || 1) });
    await prepare(p, '#/team/new', 3000);
    const sheet = p.locator('.sheet__panel').last(), field = sheet.locator('textarea.ts-ask').first();
    await field.click();
    await settle(p);
    const job = "Every Monday at 9, tell me what's due this week";
    const rects = { input: await rectOf(field), sheet: await rectOf(sheet), silhouette: await rectOf(sheet.locator('.ts-disc').first()) };
    // The sheet's starter ideas include "When a Linear issue is assigned to me, add a to-do" (until Continue): its
    // line box, so the film can keep it out of frame.
    rects.linearStarter = await p.evaluate(() => { const e = [...document.querySelectorAll('.sheet__panel button, .sheet__panel li')].find(x => /Linear/.test(x.textContent || '') && x.getBoundingClientRect().height); if (!e) return null; const r = e.getBoundingClientRect(), k = v => Math.round(v * 10) / 10; return { x: k(r.x), y: k(r.y), w: k(r.width), h: k(r.height), text: e.textContent.trim() }; });
    const actions = typeActions(p, 500, job, 50);
    actions.push([500 + job.length * 50 + 20, async () => {}, 'typeEnd']);
    actions.push([3400, async () => { const btn = sheet.locator('.ts-foot .ts-primary').first(); rects.submitBtn = await rectOf(btn); await btn.click(); }, 'submit']);
    const said = (re) => () => p.evaluate((src) => [...document.querySelectorAll('.ts-msg--them .ts-said')].some(e => new RegExp(src).test(e.textContent || '') && e.getBoundingClientRect().height > 0), re.source);
    const has = (sel, text) => shownIn(p, sel, { text });
    let name = null, scroll = null, scrollAt = null;
    // Frames in which "Every Monday at 9:00, I'll tell you what's due this week." is whole, opaque and where
    // rects.saysLine says it is.
    const saysAt = { y: null, from: null, to: null }; let frame = 0;
    const SCROLL_MS = 1100;
    const newCard = (who = name) => p.evaluate((n) => {
      const el = [...document.querySelectorAll('.team-main *')].find(e => !e.children.length && (e.textContent || '').trim() === n); if (!el) return null;
      let c = el; while (c.parentElement && !c.parentElement.classList.contains('team-main') && c.getBoundingClientRect().height < 150) c = c.parentElement;
      const r = c.getBoundingClientRect(), k = v => Math.round(v * 10) / 10; const tile = c.querySelector('.kit-tile') || c.querySelector('svg'); const t = tile && tile.getBoundingClientRect(); const nr = el.getBoundingClientRect();
      return { card: { x: k(r.x), y: k(r.y), w: k(r.width), h: k(r.height) }, face: t && { x: k(t.x), y: k(t.y), w: k(t.width), h: k(t.height) }, name: { x: k(nr.x), y: k(nr.y), w: k(nr.width), h: k(nr.height) }, top: r.top + scrollY };
    }, who);
    const res = await record(p, 'hire', Number(process.env.CAP_HIRE_MS || 30000), {
      actions, endOnSteps: true,
      steps: [
        { when: said(/I'll tell you/), after: Number(process.env.CAP_HIRE_READ || 1500), ev: 'skip', do: async () => {
          name = (await sheet.locator('.ts-plate__name').first().innerText()).trim(); rects.assistant = name;
          const them = sheet.locator('.ts-msg--them .ts-said');
          Object.assign(rects, { character: await rectOf(sheet.locator('.ts-disc').first()), name: await rectOf(sheet.locator('.ts-plate__name').first()), plate: await rectOf(sheet.locator('.ts-plate').first()),
            jobBubble: await rectOf(sheet.locator('.ts-msg--you .ts-said').first()), helloLine: await rectOf(them.nth(0)), helloText: (await them.nth(0).innerText()).trim(), saysLine: await rectOf(them.nth(1)), saysText: (await them.nth(1).innerText()).trim() });
          const skip = sheet.locator('button.ts-skip').first(); rects.skipBtn = await rectOf(skip); await skip.click();
        } },
        // "Add <name> to your team" is there as soon as the questions are skipped; the tap waits for the reply and
        // "Here's how I'll work" (when it starts, what it may do alone) to be on screen.
        { when: async () => (await said(/Here's how I'll work/)()) && (await has('.sheet__panel .ts-foot button', 'to your team')()), after: Number(process.env.CAP_HIRE_PLAN || 1200), ev: 'add', do: async () => {
          const add = sheet.locator('.ts-foot button', { hasText: 'to your team' }).first(); rects.addBtn = await rectOf(add); rects.addLabel = (await add.innerText()).trim(); await add.click();
        } },
        { when: has('.sheet__panel h2.ts-q', 'is on your team'), after: Number(process.env.CAP_HIRE_JOINED || 2400), ev: 'done', do: async () => {
          const done = sheet.locator('.ts-foot .ts-primary', { hasText: 'Done' }).first();
          Object.assign(rects, { characterBig: await rectOf(sheet.locator('.ts-disc').first()), helloBubble: await rectOf(sheet.locator('.ts-bubble').first()), helloBubbleText: (await sheet.locator('.ts-bubble').first().innerText()).trim(),
            joinedLine: await rectOf(sheet.locator('h2.ts-q', { hasText: 'is on your team' }).first()), joinedText: (await sheet.locator('h2.ts-q', { hasText: 'is on your team' }).first().innerText()).trim(), firstDay: await rectOf(sheet.locator('.ts-day').first()), doneBtn: await rectOf(done) });
          await done.click();
        } },
        { when: async () => /#\/team$/.test(p.url()) && !(await p.locator('.sheet__panel').count()) && !!(await newCard()) && await shownIn(p, 'h1.page-title', { text: 'Team' })(), after: 600, ev: 'scrollStart', do: async () => {
          const c = await newCard(); const max = await p.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
          const all = await p.evaluate(() => [...document.querySelectorAll('.team-main .kit-tile')].map(e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; }).filter(r => r.h > 40));
          rects.facesTop = all; rects.teamCount = (await p.locator('.page-count').first().innerText()).trim();
          // The current Team page has Team chat / New assignment and a "Waiting for you" card on top, so Dot, Wren
          // and the new face no longer fit between the sticky head (144 px once scrolled) and the dock (768). The
          // page comes to rest with Wren's card just under the head and the new face whole under it; Dot (whose
          // job line names Linear) is scrolled out. CAP_HIRE_TOP places the new card's top instead, as cut 5 did.
          const wren = await newCard('Wren');
          const target = process.env.CAP_HIRE_TOP ? c.top - Number(process.env.CAP_HIRE_TOP) : (wren ? wren.top - Number(process.env.CAP_HIRE_WREN_TOP || 160) : c.top - 556);
          scroll = { from: await p.evaluate(() => document.scrollingElement.scrollTop), to: Math.max(0, Math.min(max, Math.round(target))) };
        } },
        { after: SCROLL_MS, ev: 'scrollEnd' },
        { after: Number(process.env.CAP_HIRE_HOLD || 2600), ev: 'end' },
      ],
      post: async () => {
        const i = frame++;
        const y = await p.evaluate(() => { const e = [...document.querySelectorAll('.ts-msg--them .ts-said')].find(x => /I'll tell you/.test(x.textContent || '')); if (!e) return null; const r = e.getBoundingClientRect(); return r.height && r.top > 130 && +getComputedStyle(e.parentElement).opacity > 0.99 && +getComputedStyle(e).opacity > 0.99 ? Math.round(r.top * 10) / 10 : null; });
        if (y === null || !(await shownIn(p, '.ts-msg--them .ts-said', { text: "I'll tell you" })())) return;
        if (saysAt.y === null) { saysAt.y = y; saysAt.from = i; }
        if (Math.abs(y - saysAt.y) < 0.5) saysAt.to = i;
      },
      each: async (vt) => {
        if (!scroll) return; if (scrollAt === null) scrollAt = vt;
        const k = Math.min(1, (vt + STEP - scrollAt) / SCROLL_MS);
        if (vt <= scrollAt + SCROLL_MS + STEP) await p.evaluate(y => { document.scrollingElement.scrollTop = y; }, scroll.from + (scroll.to - scroll.from) * inOut(k));
      },
      watch: {
        thinking: () => p.evaluate(() => !!document.querySelector('.ts-stage.is-thinking')),
        arrive: () => p.evaluate(() => { const s = document.querySelector('.ts-stage'); return !!s && !s.classList.contains('is-silhouette'); }),
        hello: said(/\bI'm /), says: said(/I'll tell you/),
        addShown: has('.sheet__panel .ts-foot button', 'to your team'), plan: said(/Here's how I'll work/),
        joined: has('.sheet__panel h2.ts-q', 'is on your team'),
        dayHello: has('.sheet__panel .ts-bubble'),
        faces: async () => /#\/team$/.test(p.url()) && !(await p.locator('.sheet__panel').count()) && await shownIn(p, 'h1.page-title', { text: 'Team' })(),
      },
    });
    delete res.events.end;
    const c = await newCard();
    if (c) Object.assign(rects, { newCard: c.card, newFace: c.face, newName: c.name });
    rects.faces = await p.evaluate(() => [...document.querySelectorAll('.team-main .kit-tile')].map(e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; }).filter(r => r.h > 40 && r.y + r.h > 0 && r.y < innerHeight));
    res.events = Object.fromEntries(Object.entries(res.events).sort((x, y) => x[1] - y[1]));
    if (saysAt.from !== null) rects.saysFrames = { from: saysAt.from, to: saysAt.to };
    // The four cards (Penny, Dot, Wren and the new one) are 930 px of page: a phone's 844 px never holds them all.
    // So the Team page's end state is also kept whole, as a still on a taller screen (390x1400, same width and
    // layout): stills/teamAfter.jpg, with each card's rect in it.
    await p.setViewportSize({ width: 390, height: 1400 });
    await p.evaluate(() => { document.scrollingElement.scrollTop = 0; });
    await advance(p, 600);
    fs.mkdirSync(ROOT + 'stills/', { recursive: true });
    await shoot(p, ROOT + 'stills/teamAfter.jpg');
    rects.teamAfter = { file: 'stills/teamAfter.jpg', w: 390, h: 1400, cards: await p.evaluate(() => {
      const k = v => Math.round(v * 10) / 10, rect = e => { const r = e.getBoundingClientRect(); return { x: k(r.x), y: k(r.y), w: k(r.width), h: k(r.height) }; };
      return [...document.querySelectorAll('.team-main .kit-tile')].filter(t => t.getBoundingClientRect().height > 40).map(t => { let c = t; while (c.parentElement && !c.parentElement.classList.contains('team-main') && c.getBoundingClientRect().height < 150) c = c.parentElement; const lines = c.innerText.split('\n').map(x => x.trim()).filter(Boolean); return { name: lines.find(x => /^[A-Z][a-z]+$/.test(x)) || lines[0], face: rect(t), card: rect(c) }; });
    }) };
    // Page changes: Continue (job → talk), Add (talk → first day) and Done (sheet away, Team page under it).
    const f = ms => Math.round(ms / STEP), ev = res.events;
    // Each is the app's own move, a few frames of two layouts blended: job → talk cross-fades as the character
    // arrives (6 frames), talk → first day cross-fades (6), and at Done the sheet slides down and the Team page
    // fades in under it (11).
    const covers = [['arrive', 6], ['add', 6], ['done', 11]].filter(([k]) => typeof ev[k] === 'number').map(([k, n]) => ({ at: k, from: f(ev[k]), to: f(ev[k]) + n }));
    saveManifest('hire', { ...res, rects, covers, scroll });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  // "Music for the evening run": parked on Playlists from the first frame (no scroll through the stats), the
  // pointer opens "Evening run" and its sheet comes up.
  async music(b) {
    const p = await setup(b, '2026-11-09T18:20:00Z');
    await prepare(p, '#/music', 4000);
    const section = p.locator('.mu-card--playlists').first();
    const tile = section.getByRole('button', { name: new RegExp('^' + (process.env.CAP_PLAYLIST || 'Evening run')) }).first();
    const top = await section.evaluate(e => e.getBoundingClientRect().top + scrollY);
    const max = await p.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
    const Y = Math.max(0, Math.min(max, Math.round(top - Number(process.env.CAP_MUSIC_TOP || 150))));
    await p.evaluate(y => { document.scrollingElement.scrollTop = y; }, Y);
    for (let t = 0; t < 600; t += STEP) { await p.clock.runFor(STEP); await sleep(5); }
    await p.evaluate(() => window.__syncAnims(60000));
    await p.evaluate(() => window.__syncAnims(0));
    const OPEN = Number(process.env.CAP_MUSIC_OPEN || 1200), PRESS = Number(process.env.CAP_MUSIC_PRESS || 2900), HOLD = 200;
    const rects = { playlists: await rectOf(section), tile: await rectOf(tile) };
    // "Open in Spotify" is a link to open.spotify.com in a new tab: the press shows (the button's :active state
    // while the pointer is down), the navigation is blocked (click default prevented, the host aborted, any popup closed).
    await p.context().route(/spotify\.com/, r => r.abort());
    p.context().on('page', pg => pg.close().catch(() => {}));
    const spotify = () => p.locator('.sheet__panel a.mu-sheet__ask', { hasText: 'Open in Spotify' }).last();
    let at = null;
    const res = await record(p, 'music', Number(process.env.CAP_MUSIC_MS || 4800), {
      actions: [
        [OPEN, () => tile.click(), 'open'],
        [PRESS, async () => {
          const btn = spotify(); rects.spotifyBtn = await rectOf(btn);
          await p.evaluate(() => document.addEventListener('click', e => { if (e.target.closest && e.target.closest('a.mu-sheet__ask')) e.preventDefault(); }, true));
          at = { x: rects.spotifyBtn.x + rects.spotifyBtn.w * 0.42, y: rects.spotifyBtn.y + rects.spotifyBtn.h / 2 };
          rects.spotifyPoint = { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 };
          await p.mouse.move(at.x, at.y); await p.mouse.down();
        }, 'spotifyPress'],
        [PRESS + HOLD, () => p.mouse.up(), 'spotifyRelease'],
      ],
      watch: { sheet: shownIn(p, '.sheet__panel') },
    });
    if (!/#\/music/.test(p.url()) || p.context().pages().length > 1) console.log('WARN music: navigated away', p.url());
    const sheet = p.locator('.sheet__panel').last();
    if (await sheet.count()) rects.sheet = await rectOf(sheet);
    if (await sheet.locator('.mu-sheet__art').count()) rects.sheetThumb = await rectOf(sheet.locator('.mu-sheet__art').first());
    // Aliases the motion script reads: `spotify` (rect and event) for the "Open in Spotify" press.
    if (rects.spotifyBtn) rects.spotify = rects.spotifyBtn;
    if (typeof res.events.spotifyPress === 'number') res.events.spotify = res.events.spotifyPress;
    saveManifest('music', { ...res, rects, scroll: { from: Y, to: Y } });
    console.log(JSON.stringify(rects), Y);
    await p.context().close();
  },

  async habits(b) {
    const p = await setup(b);
    await prepare(p, '#/habits');
    const tick = p.getByRole('button', { name: /^Evening run, .*Tap to tick/ }).first();
    // The run's streak: "<strong>20 in a row</strong> now" in its card's count line.
    const streakText = () => p.evaluate(() => { const c = [...document.querySelectorAll('strong')].find(s => /in a row/.test(s.textContent || '')); return c ? c.textContent.trim() : null; });
    const streakRect = async () => rectOf(p.locator('strong', { hasText: /in a row/ }).first());
    const countLine = () => p.locator('strong', { hasText: /in a row/ }).first().locator('xpath=..');
    const rects = { tick: await rectOf(tick), streak: await streakRect(), countLine: await rectOf(countLine()), streakLabel: await streakText() };
    const res = await record(p, 'habits', 4500, {
      actions: [[1200, () => tick.click(), 'tick']],
      watch: { streakUp: async () => { const t = await streakText(); return !!t && t !== rects.streakLabel; } },
    });
    rects.streakEnd = await streakRect(); rects.countLineEnd = await rectOf(countLine()); rects.streakEndLabel = await streakText();
    saveManifest('habits', { ...res, rects });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  async health(b) {
    const p = await setup(b);
    await prepare(p, '#/health', 3500);
    const y0 = await p.evaluate(() => document.scrollingElement.scrollTop);
    const DIST = Number(process.env.CAP_HEALTH_SCROLL || 130), FROM = 900, TO = 3300;
    const res = await record(p, 'health', 4500, {
      each: async (vt) => {
        const t = Math.min(1, Math.max(0, (vt + STEP - FROM) / (TO - FROM)));
        await p.evaluate(y => { document.scrollingElement.scrollTop = y; }, y0 + DIST * inOut(t));
      },
    });
    res.events = { scrollStart: FROM, scrollEnd: TO };
    const rects = {};
    const sleepCard = p.locator('.health__card--sleep').first();
    if (await sleepCard.count()) rects.sleepCard = await rectOf(sleepCard);
    saveManifest('health', { ...res, rects, scroll: { from: y0, to: await p.evaluate(() => document.scrollingElement.scrollTop) } });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  async graph(b) {
    const p = await setup(b);
    await arrive(p, '#/graph', 250);
    // The layout arrives moving and comes to rest after about 2.2s. From 3000ms a node (Priya Shah, the "PS"
    // hub) is dragged up and right and let go, so its neighbours follow and the layout re-settles.
    const FROM = { x: 244, y: 483 }, TO = { x: 306, y: 404 }, T0 = 3000, T1 = 4300, T2 = 4500;
    let down = false, up = false;
    const res = await record(p, 'graph', 6500, {
      each: async (vt) => {
        if (process.env.CAP_GRAPH_NODRAG || vt < T0 || up) return;
        if (!down) { await p.mouse.move(FROM.x, FROM.y); await p.mouse.down(); down = true; return; }
        if (vt >= T2) { await p.mouse.up(); await p.mouse.move(195, 30); up = true; return; }
        const k = inOut(Math.min(1, (vt - T0) / (T1 - T0)));
        await p.mouse.move(FROM.x + (TO.x - FROM.x) * k, FROM.y + (TO.y - FROM.y) * k);
      },
    });
    res.events = { dragStart: T0, dragEnd: T2 };
    const rects = { canvas: await rectOf(p.locator('canvas.graph-canvas').first()) };
    saveManifest('graph', { ...res, rects });
    await p.context().close();
  },

  // The evening check-in on Days ("This evening · How was today?"), top of page so the whole card shows.
  async checkin(b) {
    // The current card puts the "Morning preparation" / "Evening reflection" check-in cards between "How was
    // today?" and the mood row. The film's finale crops the card from its top to the mood row, so for this shot
    // only they are not drawn (capture-only CSS, as with workDone's toasts): head, "How was today?", Rough…Great.
    // CAP_CHECKIN_ROUTINES=1 keeps them.
    const p = await setup(b, '2026-11-09T21:05:00Z', 3, { css: process.env.CAP_CHECKIN_ROUTINES ? '' : 'section.today .checkin-entry { display: none !important; }' });
    await prepare(p, '#/days', 3500);
    const card = p.locator('section.today').first();
    const picker = card.locator('.mood-picker').first();
    const great = picker.locator('.mood-step', { hasText: 'Great' }).first();
    const question = card.getByText('How was today?').first();
    const rects = { card: await rectOf(card), moodBlock: union(await rectOf(question), await rectOf(picker)), great: await rectOf(great) };
    // The round mark inside the Great step (the dot that fills when pressed).
    rects.greatCircle = await p.evaluate(() => { const g = [...document.querySelectorAll('section.today .mood-step')].find(e => /Great/.test(e.textContent || '')); const c = g && (g.querySelector('svg, [class*="dot"], [class*="face"], [class*="icon"]')); if (!c) return null; const r = c.getBoundingClientRect(), k = v => Math.round(v * 10) / 10; return { x: k(r.x), y: k(r.y), w: k(r.width), h: k(r.height) }; });
    const res = await record(p, 'checkin', 3500, { actions: [[1200, () => great.click(), 'press']] });
    rects.cardEnd = await rectOf(card);
    saveManifest('checkin', { ...res, rects });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  // Flows (PLAN.md 60000–64800): #/flows with Athena's two suggestion cards; the second, "You look for a present
  // a week before birthdays / Four times since September. Want Athena to do it for you?", is the one. It is left
  // where the page puts it (second, mid-screen): dismissing the first or scrolling brings the Linear flow up under
  // the dock. The pointer taps its "Make it a flow"; the app makes the flow (kept off) and opens its page, where
  // the steps read down: When "A week before a birthday, at 9:00", Then "Find gift ideas", "Tell me". Then the On
  // switch is turned on ("Birthday heads-up is on" toast).
  async flow(b) {
    const p = await setup(b, TEAM_AT, 3);
    await prepare(p, '#/flows', 3500);
    const card = p.locator('section.flow-sug', { hasText: 'present a week' }).first();
    await card.waitFor({ timeout: 5000 });
    const make = card.getByRole('button', { name: 'Make it a flow' }).first();
    const rects = { card: await rectOf(card), cardTitle: await rectOf(card.locator('.flow-sug__title').first()), cardWhy: await rectOf(card.locator('.flow-sug__why').first()), makeBtn: await rectOf(make), cardShape: await rectOf(card.locator('.flow-sug__shape').first()) };
    rects.cardText = union(rects.cardTitle, rects.cardWhy);
    // The names motion asked for, as aliases: sug = card, sugTitle/sugWhy, sugShape (chain + name), sugName.
    Object.assign(rects, { sug: rects.card, sugTitle: rects.cardTitle, sugWhy: rects.cardWhy, sugShape: rects.cardShape, sugName: await rectOf(card.locator('.flow-sug__name').first()), noBtn: await rectOf(card.getByRole('button', { name: 'No thanks' }).first()), flowsHead: await rectOf(p.locator('h1.page-title', { hasText: 'Flows' }).first()) });
    rects.cardTextValue = (await card.locator('.flow-sug__title').first().innerText()).trim() + ' / ' + (await card.locator('.flow-sug__why').first().innerText()).trim();
    const MAKE = Number(process.env.CAP_FLOW_MAKE || 1800), ON = Number(process.env.CAP_FLOW_ON || 3600);
    const onSwitch = () => p.locator('label.flow-on input.switch').first();
    const ev = {}; const res0 = await record(p, 'flow', Number(process.env.CAP_FLOW_MS || 6000), {
      actions: [
        [MAKE, () => make.click(), 'makeTap'],
        [ON, async () => { rects.switchBefore = rects.onToggleBefore = await rectOf(onSwitch()); await onSwitch().click(); }, 'on'],
      ],
      watch: {
        cardVisible: shownIn(p, 'section.flow-sug', { text: 'present a week', whole: true }),
        opened: async () => /#\/flows\/[^/]+$/.test(p.url()) && await shownIn(p, '.flows--editor .flow-hero__name')(),
        stepsShown: shownIn(p, '.flows--editor .flow-card--trigger'),
        switchedOn: () => p.evaluate(() => { const s = document.querySelector('label.flow-on input.switch'); return !!s && s.checked; }),
        toast: () => p.evaluate(() => [...document.querySelectorAll('.toast')].some(e => / is on/.test(e.textContent || '') && e.getBoundingClientRect().height > 0)),
      },
    });
    const res = res0; Object.assign(ev, res.events);
    Object.assign(rects, await flowEditorRects(p));
    Object.assign(rects, { flowHead: rects.flowTitle, flowName: rects.flowTitle, switch: rects.onToggle, switchRow: rects.onRow });
    // Event names motion reads: make (tap), opened (flow page drawn, View Transition over), steps, switchTap (the
    // toggle pressed), on (drawn on). `makeTap`, `stepsShown` are the same moments under the first names.
    ev.make = ev.makeTap; ev.steps = ev.stepsShown; ev.switchTap = ev.on; if (typeof ev.switchedOn === 'number') ev.on = ev.switchedOn;
    res.events = Object.fromEntries(Object.entries(ev).sort((x, y) => x[1] - y[1]));
    // The tap changes route in a View Transition: the list and the flow page are blended for three frames (55–57
    // with the tap on 54); the flow page is whole from the 4th. `opened`/`steps` come a few frames later, when the
    // last entrance (invisible on the frames) has finished.
    const f = ms => Math.round(ms / STEP);
    const covers = typeof ev.makeTap === 'number' ? [{ at: 'makeTap', from: f(ev.makeTap), to: f(ev.makeTap) + 4 }] : [];
    saveManifest('flow', { ...res, rects, covers });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  async stills(b) {
    const dir = ROOT + 'stills/'; fs.mkdirSync(dir, { recursive: true });
    // `watch` is the Watch & read page, route #/reading; `team` is the Team grid (Penny, Dot, Wren). CAP_STILLS=watch,days re-shoots only those.
    // `tracking` is a Tracking page: the sample's moka pot in Saved (12 checks at 4 made-up shops, a target, its stock).
    // `flows` is the Flows list (Athena's two suggestions on top); `flowEditor` is the Birthday heads-up flow's page,
    // made from its suggestion card ("Make it a flow") and switched on, its toast left to run out.
    const routes = { days: 'days', week: 'week', trips: 'trips', money: 'money', music: 'music', watch: 'reading', health: 'health', team: 'team', tracking: 'saved', flows: 'flows', flowEditor: 'flows' };
    const TEAMLIKE = ['team', 'tracking', 'flows', 'flowEditor'];
    const only = (process.env.CAP_STILLS || '').split(',').filter(Boolean);
    for (const name of Object.keys(routes)) {
      if (only.length && !only.includes(name)) continue;
      const p = await setup(b, TEAMLIKE.includes(name) ? TEAM_AT : MORNING);
      await prepare(p, '#/' + routes[name], 4000);
      if (name === 'tracking') {
        const id = await savedId(p, process.env.CAP_TRACKING_ITEM || 'Stovetop moka pot');
        await p.evaluate(h => { location.hash = h; }, '#/saved/' + id);
        await advance(p, 3000);
      }
      if (name === 'flowEditor') {
        await p.locator('section.flow-sug', { hasText: 'present a week' }).getByRole('button', { name: 'Make it a flow' }).first().click();
        await advance(p, 2000);
        await p.locator('label.flow-on input.switch').first().click();
        await advance(p, 8000);
        saveManifest('flowEditorStill', { file: 'stills/flowEditor.jpg', rects: await flowEditorRects(p) });
      }
      await p.evaluate(() => window.__syncAnims(60000)); // every entrance finished
      await sleep(300);
      await shoot(p, dir + name + '.jpg');
      console.log('still', name);
      await p.context().close();
    }
  },
};

// Runs only as a script (`node capture.cjs ...`), never on require, and only with an explicit CAP_DIR: a capture
// overwrites its shots' folders, so it must never fall back to a folder someone else is reading.
if (require.main === module) (async () => {
  if (!process.env.CAP_DIR) { console.error('Set CAP_DIR: the folder the shots are written to.'); process.exit(1); }
  const which = process.argv.slice(2);
  const bad = which.filter(n => !SHOTS[n]);
  if (bad.length) { console.error('unknown shot:', bad.join(', '), '| known:', Object.keys(SHOTS).join(' ')); process.exit(1); }
  const b = await chromium.launch();
  // One shot failing (the app moved on) must not stop the rest.
  for (const name of Object.keys(SHOTS)) if (!which.length || which.includes(name)) { try { await SHOTS[name](b); } catch (e) { console.log(`FAIL ${name}:`, e.message.split('\n')[0]); process.exitCode = 1; } }
  await b.close();
})();

module.exports = { setup, prepare, advance, arrive, settle, record, rectOf, shownIn, savedId, SHOTS };
