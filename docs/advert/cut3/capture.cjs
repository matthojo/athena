// Cut 3 product captures. Deterministic 30fps: Playwright's fake clock is paused and stepped 1/30s
// per frame; CSS/Web animations are paused and their currentTime driven from the same virtual clock;
// each frame is a 3x JPEG. Sample mode only, /api aborted.
//
//   CAP_DIR=/path/to/cap node capture.cjs [shot ...]
//   shots: home ask saved habits health graph stills   (none = all)
//   CAP_URL overrides the dev server (default http://localhost:5199/).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = (process.env.CAP_DIR || '/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film/cap').replace(/\/+$/, '') + '/';
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

async function setup(b, time = MORNING) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'light', timezoneId: 'Europe/London', locale: 'en-GB', isMobile: true, hasTouch: true });
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
  await p.clock.pauseAt(new Date(await p.evaluate(() => Date.now()) + 50));
  for (let t = 0; t < settleMs; t += STEP) { await p.clock.runFor(STEP); await sleep(5); }
  await p.evaluate(() => window.__syncAnims(0));
}
// Navigate and pause at once, so the recording catches the view arriving.
// The clock is paused before the page loads, so frame 0 is the first paint and the entrance plays on camera.
async function arrive(p, route, realMs = 600) {
  await p.clock.pauseAt(new Date(Date.parse(MORNING) + 1000));
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

const SHOTS = {
  async home(b) {
    const p = await setup(b);
    await arrive(p, '#/');
    const res = await record(p, 'home', 9600);
    // Rects from the settled last frame (scroll 0).
    const card = p.locator('section.travel--home').first();
    const late = card.locator('.tchip', { hasText: '12 min late' }).first();
    const plat = card.locator('.tleg__where', { hasText: 'Platform 7' }).first();
    const greeting = p.getByRole('heading', { name: /Good morning, Alex/ }).first();
    const rects = { greeting: await rectOf(greeting), travelCard: await rectOf(card), lateChip: union(await rectOf(late), await rectOf(plat)) };
    saveManifest('home', { ...res, rects });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  async ask(b) {
    const p = await setup(b);
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
    // The finished answer is taller than the screen and the app follows it to the bottom. Keep the bubble's
    // top where it first appeared, so the top of the answer and its sources stay in view.
    const pin = () => p.evaluate(() => {
      const el = document.querySelector('.answer-bubble'); if (!el) return;
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
    saveManifest('ask', { ...res, rects });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  // Saved is for things found in passing. A bare pasted link gets only its hostname as a title in sample mode
  // (no preview is fetched), so the shot keeps a quote instead: typed with its quote marks, it lands as a Quote card.
  async saved(b) {
    const p = await setup(b);
    await prepare(p, '#/saved');
    const field = p.getByPlaceholder('Paste a link, or keep a thought');
    await field.click();
    await settle(p);
    const t = process.env.CAP_SAVED_TEXT || '“Tired is not the same as done.”';
    const actions = typeActions(p, 400, t, 65);
    actions.push([2800, () => p.keyboard.press('Enter'), 'add']);
    const rects = { input: await rectOf(field) };
    const res = await record(p, 'saved', 6500, { actions });
    const card = p.locator('.sv-card', { hasText: t.replace(/^[“"]|[”"]$/g, '') }).first();
    if (await card.count()) rects.newCard = await rectOf(card);
    saveManifest('saved', { ...res, rects });
    console.log(JSON.stringify(rects));
    await p.context().close();
  },

  // "Music for the evening run": scroll to Playlists, open "Morning run" (the one running playlist in the sample).
  async music(b) {
    const p = await setup(b, '2026-11-09T18:20:00Z');
    await prepare(p, '#/music', 4000);
    const section = p.locator('.mu-card--playlists').first();
    const tile = section.getByRole('button', { name: new RegExp('^' + (process.env.CAP_PLAYLIST || 'Morning run')) }).first();
    const tb = await tile.boundingBox();
    const max = await p.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
    const DIST = Math.max(0, Math.min(max, Math.round(tb.y + tb.height / 2 - 400)));
    const FROM = 600, TO = 2200, OPEN = 3000;
    const rects = {};
    const res = await record(p, 'music', 6500, {
      each: async (vt) => {
        if (vt + STEP > TO + STEP) return;
        const k = Math.min(1, Math.max(0, (vt + STEP - FROM) / (TO - FROM)));
        await p.evaluate(y => { document.scrollingElement.scrollTop = y; }, DIST * inOut(k));
      },
      actions: [[OPEN, async () => {
        rects.playlists = await rectOf(section); rects.tile = await rectOf(tile);
        await tile.click();
      }, 'open']],
    });
    res.events = { scrollStart: FROM, scrollEnd: TO, ...res.events };
    const sheet = p.locator('.sheet__panel').last();
    if (await sheet.count()) rects.sheet = await rectOf(sheet);
    saveManifest('music', { ...res, rects, scroll: { from: 0, to: DIST } });
    console.log(JSON.stringify(rects), DIST);
    await p.context().close();
  },

  async habits(b) {
    const p = await setup(b);
    await prepare(p, '#/habits');
    const tick = p.getByRole('button', { name: /^Evening walk, .*Tap to tick/ }).first();
    const rects = { tick: await rectOf(tick) };
    const res = await record(p, 'habits', 4500, { actions: [[1200, () => tick.click(), 'tick']] });
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
    // `watch` is the Watch & read page, route #/reading. CAP_STILLS=watch,days re-shoots only those.
    const routes = { days: 'days', week: 'week', trips: 'trips', money: 'money', music: 'music', watch: 'reading' };
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

(async () => {
  const which = process.argv.slice(2);
  const bad = which.filter(n => !SHOTS[n]);
  if (bad.length) { console.error('unknown shot:', bad.join(', '), '| known:', Object.keys(SHOTS).join(' ')); process.exit(1); }
  const b = await chromium.launch();
  for (const name of Object.keys(SHOTS)) if (!which.length || which.includes(name)) await SHOTS[name](b);
  await b.close();
})();
