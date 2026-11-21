// Cut 4 product captures (from cut 3's). Deterministic 30fps: Playwright's fake clock is paused and stepped 1/30s
// per frame; CSS/Web animations are paused and their currentTime driven from the same virtual clock;
// each frame is a 3x JPEG. Sample mode only, /api aborted.
//
//   CAP_DIR=/path/to/cap node capture.cjs [shot ...]
//   shots: home ask saved team music habits health graph checkin stills   (none = all)
//   CAP_FILM_POSTER=/path/poster.jpg puts the film's own poster on the Saved film card (film only, never committed).
//   CAP_URL overrides the dev server (default http://localhost:5199/).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = (process.env.CAP_DIR || '/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film4/cap').replace(/\/+$/, '') + '/';
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
async function setup(b, time = MORNING, scale = 3) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: scale, colorScheme: 'light', timezoneId: 'Europe/London', locale: 'en-GB', isMobile: true, hasTouch: true });
  await ctx.addInitScript((css) => {
    localStorage.setItem('athena.mode', 'sample');
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
  }, CSS);
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
// each(vt): runs before every frame (scrolls, drags).
// post(vt): runs after the step, just before the screenshot.
async function record(p, name, durMs, { actions = [], watch = {}, each = null, post = null } = {}) {
  const dir = ROOT + name + '/'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const n = Math.ceil(durMs / STEP - 1e-6); let vt = 0; const todo = [...actions].sort((a, b) => a[0] - b[0]);
  const events = {}; const pending = { ...watch };
  for (let i = 0; i < n; i++) {
    while (todo.length && todo[0][0] <= vt + 1e-6) { const [, fn, ev] = todo.shift(); await fn(); if (ev) events[ev] = Math.round(vt); }
    if (each) await each(vt);
    await p.clock.runFor(STEP); vt += STEP;
    await sleep(15); // let real async work (IndexedDB, promises) settle
    await p.evaluate(([v, c]) => window.__syncAnims(v, c), [vt, STEP]);
    if (post) await post(vt);
    // A frame shows the state at the end of its step; an event seen in frame i is on screen from i*STEP.
    for (const k of Object.keys(pending)) if (await pending[k]()) { events[k] = Math.round(i * STEP); delete pending[k]; }
    await shoot(p, `${dir}${String(i).padStart(4, '0')}.jpg`);
  }
  for (const k of Object.keys(pending)) console.log(`WARN ${name}: "${k}" never seen`);
  console.log(name, n, 'frames', JSON.stringify(events));
  return { frames: n, events };
}

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
    const SCROLL_FROM = LINK + 900, SCROLL_MS = 1300, FILM_TOP = Number(process.env.CAP_WATCH_TOP || 290);
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
    const res = await record(p, 'saved', Number(process.env.CAP_SAVED_MS || 10000), {
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
    const covers = [{ at: 'add', from: f(ADD) - 1, to: f(ADD) + 4 }, { at: 'move', from: f(MOVE) - 1, to: f(MOVE) + 3 }, { at: 'link', from: f(LINK) - 1, to: f(LINK) + 1 }];
    saveManifest('saved', { ...res, rects, cover: { from: covers[0].from, to: covers[0].to }, covers, scroll });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  // Team: Penny's "From Penny" card on Home ("The moka pot is down to £34") scrolls into view and holds; the
  // pointer taps its button, Ask opens on Penny (her card above, "Is that a good price?" in the box), the
  // question is sent and Penny's reply streams in. The sample card's button reads "Ask about it": it says
  // "Open it" only for a nudge that already has a conversation, which sample mode's Penny card doesn't.
  async team(b) {
    const p = await setup(b, process.env.CAP_TEAM_AT || '2026-11-09T13:10:00Z', HI);
    await prepare(p, '#/', 3000);
    const card = p.locator('article.nudge-card[data-rule=team]').first();
    const top = await card.evaluate(e => e.getBoundingClientRect().top + scrollY);
    // Opens at the top of Home: the Ask box with the Athena · Penny · Dot · Wren chips under it, then scrolls
    // down to Penny's card.
    const S0 = 0, S1 = Math.round(top - 250);
    await p.evaluate(y => { document.scrollingElement.scrollTop = y; }, S0);
    await p.evaluate(() => window.__syncAnims(0));
    const FROM = 600, TO = 1600, TAP = 2800, SEND = 3800;
    const strip = p.locator('.home-ask__who').first(), chipBtns = strip.locator('.home-ask__chip');
    const rects = {};
    {
      const all = []; for (let i = 0; i < await chipBtns.count(); i++) all.push(await rectOf(chipBtns.nth(i)));
      rects.chips = all.reduce(union); rects.chips.w = Math.round(rects.chips.w * 10) / 10; rects.chips.h = Math.round(rects.chips.h * 10) / 10;
      rects.pennyChip = await rectOf(chipBtns.filter({ hasText: 'Penny' }).first());
      rects.chipNames = await chipBtns.allInnerTexts().then(a => a.map(t => t.trim()));
    }
    const res = await record(p, 'team', Number(process.env.CAP_TEAM_MS || 9600), {
      each: async (vt) => {
        if (vt > TO + STEP) return;
        const k = Math.min(1, Math.max(0, (vt + STEP - FROM) / (TO - FROM)));
        await p.evaluate(y => { document.scrollingElement.scrollTop = y; }, S0 + (S1 - S0) * inOut(k));
      },
      actions: [
        [TAP, async () => {
          const btn = card.locator('.nudge-card__foot button.btn--soft').first();
          Object.assign(rects, { pennyCard: await rectOf(card), avatar: await rectOf(card.locator('.nudge-card__avatar').first()), eyebrow: await rectOf(card.locator('.nudge-card__eyebrow').first()), line: await rectOf(card.locator('.nudge-card__title').first()), openBtn: await rectOf(btn) });
          rects.title = rects.line;
          rects.openLabel = (await btn.innerText()).trim();
          await btn.click();
        }, 'tap'],
        [SEND, async () => {
          const send = p.locator('button.send-btn[type=submit]').first();
          rects.input = await rectOf(p.getByRole('textbox').first()); rects.send = await rectOf(send);
          rects.prompt = await p.getByRole('textbox').first().evaluate(e => e.value ?? e.textContent);
          await send.click();
        }, 'send'],
      ],
      watch: {
        cardVisible: shownIn(p, 'article.nudge-card[data-rule=team]', { whole: true, maxY: 760 }),
        opened: shownIn(p, '.ask-nudge'),
        reply: () => p.evaluate(() => ((document.querySelector('.answer-bubble .answer__text') || {}).innerText || '').trim().length > 0),
        replyDone: () => p.evaluate(() => /Good time to buy\.?\s*$/.test(((document.querySelector('.answer-bubble .answer__text') || {}).innerText || '').trim())),
      },
    });
    res.events = { scrollStart: FROM, scrollEnd: TO, ...res.events };
    const seed = p.locator('.ask-nudge').first();
    if (await seed.count()) {
      rects.seed = await rectOf(seed); rects.seedAvatar = await rectOf(seed.locator('.ask-nudge__who').first());
      if (await seed.locator('.ask-nudge__title').count()) rects.seedTitle = await rectOf(seed.locator('.ask-nudge__title').first());
    }
    const ans = p.locator('.answer-bubble').last();
    if (await ans.count()) { rects.answerBubble = await rectOf(ans); rects.answer = await rectOf(p.locator('.answer-bubble .answer__text').last()); rects.answerFirst = await firstSentence(p, '.answer-bubble .answer__text'); }
    // Dissolves: the tap's route change paints one near-blank frame before Penny's thread fades in, and when her
    // reply starts the steps fold away and the answer fades in (as in `ask`).
    const f = ms => Math.round(ms / STEP);
    const covers = [{ at: 'tap', from: f(TAP) - 1, to: f(TAP) + 3 }];
    if (typeof res.events.reply === 'number') covers.push({ at: 'reply', from: f(res.events.reply), to: f(res.events.reply) + 4 });
    saveManifest('team', { covers, ...Object.fromEntries(Object.entries(res).map(([k, v]) => [k, k === 'events' ? Object.fromEntries(Object.entries(v).sort((x, y) => x[1] - y[1])) : v])), scale: HI, rects, scroll: { from: S0, to: S1 } });
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
    const p = await setup(b, '2026-11-09T21:05:00Z');
    await prepare(p, '#/days', 3500);
    const card = p.locator('section.today').first();
    const picker = card.locator('.mood-picker').first();
    const great = picker.locator('.mood-step', { hasText: 'Great' }).first();
    const question = card.getByText('How was today?').first();
    const rects = { card: await rectOf(card), moodBlock: union(await rectOf(question), await rectOf(picker)), great: await rectOf(great) };
    const res = await record(p, 'checkin', 3500, { actions: [[1200, () => great.click(), 'press']] });
    rects.cardEnd = await rectOf(card);
    saveManifest('checkin', { ...res, rects });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  async stills(b) {
    const dir = ROOT + 'stills/'; fs.mkdirSync(dir, { recursive: true });
    // `watch` is the Watch & read page, route #/reading; `team` is the Team grid (Penny, Dot, Wren). CAP_STILLS=watch,days re-shoots only those.
    const routes = { days: 'days', week: 'week', trips: 'trips', money: 'money', music: 'music', watch: 'reading', health: 'health', team: 'team' };
    const only = (process.env.CAP_STILLS || '').split(',').filter(Boolean);
    for (const name of Object.keys(routes)) {
      if (only.length && !only.includes(name)) continue;
      const p = await setup(b);
      await prepare(p, '#/' + routes[name], 4000);
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
  for (const name of Object.keys(SHOTS)) if (!which.length || which.includes(name)) await SHOTS[name](b);
  await b.close();
})();
